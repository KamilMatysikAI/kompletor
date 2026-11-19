// Zapis danych klienta zamówienia. Źródła: zadanie KLIENT_ZAPIS po przyjęciu zamówienia albo nowej rewizji
// (lib/klienci/kolejka.ts, wpis w transakcji `ingestOrder`), „Odśwież z kanału” na karcie, wpis człowieka dla zamówień
// ręcznych, fallback przesyłki i faktury (lib/klienci/wejscia.ts). Kanał czytamy wyłącznie przez `pobierzOdbiorce` z
// powodem `ZAPIS` (bramka DANE_KLIENTA_ZAPIS + konto w PRACY albo „zapis w cieniu” firmy, ślad ODBIORCA_ODCZYT), nigdy
// `getOrderRecipient` wprost (strażnik tests/odbiorca-straznik.test.ts).
//
// Upsert idempotentny pod blokadą zamówienia: powtórka nadpisuje tym samym albo nowszym odczytem (`revision + 1`),
// starszy odczyt (fetchedAt) przegrywa. Rekord `RECZNE` poprawiony przez człowieka nie jest nadpisywany automatem;
// wpis usunięty (retencja, RODO art. 17) nie wraca z kanału. Błędy bez danych: AuditLog `KLIENT_ZAPIS` z klasą błędu.
import type { CustomerDataSource, Prisma, PrismaClient } from '@prisma/client'
import { AdapterError } from '../adaptery/kontrakt'
import type { AdapterRegistry } from '../adaptery/rejestr'
import { NonRetryableError } from '../bledy'
import { organizationIdOf } from '../db'
import { BladOdczytuOdbiorcy, BrakZamowieniaOdbiorcy, OdmowaOdczytuOdbiorcy, pobierzOdbiorce, type WynikOdbiorcy } from '../odbiorca/pobierz'
import type { TempoOdbiorcy } from '../odbiorca/tempo'
import { advisoryLock, runTx } from '../rdzen/stan'
import type { SecretSource } from '../sekrety'
import type { FetchLike } from '../zrodla/http'
import { enqueue } from '../worker/kolejka'
import { dedupeZapisu, KLIENT_ZAPIS_JOB, KLIENT_ZAPIS_PROB } from './kolejka'
import { rekordZOdbiorcy, type RekordKlienta } from './rekord'
import { terminDlaZamowienia } from './retencja'
import { BrakKluczaSkrotow, kluczSkrotowZEnv, skrotyRekordu, krajDostawy } from './skroty'
import { kluczeKlientowZEnv, zaszyfrujKlienta } from './szyfr'

export const ZAPIS_AUDIT = 'KLIENT_ZAPIS'
export const SYSTEM_ZAPISU = 'system:klienci'

export type WynikZapisu = 'ZAPISANO' | 'BEZ_ZMIAN_RECZNE' | 'BEZ_ZMIAN_STARSZY' | 'BEZ_ZMIAN_USUNIETE'

export interface OpcjeZapisu {
  source: CustomerDataSource
  /** Chwila odczytu z kanału albo wpisu; starszy odczyt nie nadpisuje nowszego. */
  fetchedAt: Date
  env: Record<string, string | undefined>
  /** Człowiek poprawia rekord ręczny (formularz) — wolno nadpisać RECZNE. */
  nadpiszReczne?: boolean
  /**
   * Warunek w transakcji zapisu, po blokadzie rekordu i przed zapisem (poprawka adresu pod blokadą
   * przesyłki sprawdza, że przesyłka nie powstała). Wyjątek = nic nie zapisane.
   */
  wTransakcji?: (tx: Prisma.TransactionClient) => Promise<void>
}

/**
 * Zaszyfrowany zapis rekordu klienta zamówienia `orderId` (klient firmy, RLS). Brak klucza szyfru albo skrótów =
 * odmowa (NonRetryableError bez danych), nic nie zapisane.
 */
export async function zapiszRekordKlienta(db: PrismaClient, orderId: string, rekord: RekordKlienta, o: OpcjeZapisu): Promise<WynikZapisu> {
  const ring = kluczeKlientowZEnv(o.env)
  const key = kluczSkrotowZEnv(o.env)
  if (!key) throw new BrakKluczaSkrotow()
  const organizationId = organizationIdOf(db)
  const sealed = zaszyfrujKlienta(ring, organizationId, orderId, rekord)
  const skroty = skrotyRekordu(key, organizationId, rekord)
  const retainUntil = await terminDlaZamowienia(db, orderId)
  return runTx(db, async (tx) => {
    await advisoryLock(tx, `klient:${orderId}`)
    if (o.wTransakcji) await o.wTransakcji(tx)
    const cur = await tx.orderCustomer.findUnique({ where: { orderId }, select: { id: true, source: true, fetchedAt: true, purgedAt: true } })
    if (cur?.purgedAt) return 'BEZ_ZMIAN_USUNIETE'
    if (cur && cur.source === 'RECZNE' && !(o.source === 'RECZNE' && o.nadpiszReczne)) return 'BEZ_ZMIAN_RECZNE'
    if (cur && cur.fetchedAt > o.fetchedAt && o.source === 'KANAL') return 'BEZ_ZMIAN_STARSZY'
    const data = { ...sealed, ...skroty, country: krajDostawy(rekord), source: o.source, fetchedAt: o.fetchedAt, retainUntil }
    if (cur) await tx.orderCustomer.update({ where: { id: cur.id }, data: { ...data, revision: { increment: 1 } } })
    else await tx.orderCustomer.create({ data: { orderId, ...data } })
    return 'ZAPISANO'
  })
}

/**
 * Wersja rekordu klienta zamówienia bez odszyfrowania (`revision:updatedAt`, „brak” gdy rekordu nie ma).
 * host przesyłek porównuje ją między odczytem odbiorcy a rezerwacją przesyłki, żeby nie nadać na stary adres.
 */
export async function wersjaRekorduKlienta(db: PrismaClient | Prisma.TransactionClient, orderId: string): Promise<string> {
  const k = await db.orderCustomer.findUnique({ where: { orderId }, select: { revision: true, updatedAt: true } })
  return k ? `${k.revision}:${k.updatedAt.getTime()}` : 'brak'
}

export interface ZapisZKanaluDeps {
  registry: AdapterRegistry
  secrets: SecretSource
  /** Kto zleca (User.id z panelu albo `system:klienci`); do śladu ODBIORCA_ODCZYT i KLIENT_ZAPIS. */
  actorId: string
  fetch?: FetchLike
  now?: () => Date
  tempo?: TempoOdbiorcy
  /** 0 = nie czekaj na okno konta (worker); domyślnie jeden odstęp (panel). */
  maksCzekanieMs?: number
}

export type WynikZapisuZKanalu =
  | { wynik: WynikZapisu; kanal: string }
  | { wynik: 'BRAK_ZRODLA'; kanal: string; przyczyna: Extract<WynikOdbiorcy, { zrodlo: 'BRAK' }>['przyczyna'] }

/** Odczyt pełnego rekordu z kanału (`pobierzOdbiorce`, powód ZAPIS) i zapis. Wyjątki `pobierzOdbiorce` przechodzą dalej. */
export async function zapiszZKanalu(db: PrismaClient, orderId: string, deps: ZapisZKanaluDeps): Promise<WynikZapisuZKanalu> {
  const now = deps.now ?? (() => new Date())
  const r = await pobierzOdbiorce(db, orderId, {
    registry: deps.registry,
    secrets: deps.secrets,
    actorId: deps.actorId,
    powod: 'ZAPIS',
    fetch: deps.fetch,
    now: deps.now,
    tempo: deps.tempo,
    maksCzekanieMs: deps.maksCzekanieMs,
  })
  if (r.zrodlo === 'BRAK') return { wynik: 'BRAK_ZRODLA', kanal: r.kanal, przyczyna: r.przyczyna }
  const wynik = await zapiszRekordKlienta(db, orderId, rekordZOdbiorcy(r.odbiorca), { source: 'KANAL', fetchedAt: now(), env: deps.secrets.env })
  return { wynik, kanal: r.kanal }
}

/** Ślad wyniku zapisu bez danych: kody, klasa błędu. */
export async function sladZapisu(db: PrismaClient, orderId: string, actorId: string, after: Record<string, string | number>): Promise<void> {
  await db.auditLog.create({ data: { entity: ZAPIS_AUDIT, entityId: orderId, actorId, after } })
}

const ORDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** Nieznany błąd zapisu: do ponowienia, komunikat tylko z klasą i kodem (bez treści, która mogłaby nieść dane). */
export class BladPrzejsciowyZapisu extends Error {
  constructor(readonly przyczyna: unknown) {
    const klasa = przyczyna instanceof Error ? przyczyna.name : 'nieznany'
    const kod = (przyczyna as { code?: unknown } | null)?.code
    super(`${KLIENT_ZAPIS_JOB}: zapis danych klienta nie powiódł się (${klasa}${typeof kod === 'string' && /^[A-Z0-9_]{1,16}$/.test(kod) ? `, ${kod}` : ''}), ponowienie`)
    this.name = 'BladPrzejsciowyZapisu'
  }
}

/**
 * Handler zadania KLIENT_ZAPIS (lib/worker/zadania.ts). Kończy bez błędu, gdy nie ma czego zapisać (zamówienie
 * usunięte, kanał bez źródła, odmowa bramki, rekord ręczny). Błąd przejściowy kanału i każdy nieznany błąd (baza,
 * Prisma) = wyjątek (ponowienie wg zasad `Job`), trwały = jeden wiersz AuditLog KLIENT_ZAPIS z klasą błędu i koniec. Limit tempa konta (Empik 60 s): zadanie
 * wraca do kolejki na wolne okno, pętla workera nie czeka.
 */
export async function wykonajZapisKlienta(db: PrismaClient, payload: Prisma.JsonValue, deps: Omit<ZapisZKanaluDeps, 'actorId' | 'maksCzekanieMs'>): Promise<void> {
  const orderId = (payload as { orderId?: unknown } | null)?.orderId
  const odlozone = (payload as { odlozone?: unknown } | null)?.odlozone === true
  if (typeof orderId !== 'string' || !ORDER_ID_RE.test(orderId)) throw new NonRetryableError(`${KLIENT_ZAPIS_JOB}: zły payload (orderId)`)
  const cur = await db.orderCustomer.findUnique({ where: { orderId }, select: { source: true, purgedAt: true } })
  if (cur?.purgedAt || cur?.source === 'RECZNE') return // bez pytania kanału: i tak nie nadpiszemy
  try {
    await zapiszZKanalu(db, orderId, { ...deps, actorId: SYSTEM_ZAPISU, maksCzekanieMs: 0 })
  } catch (e) {
    if (e instanceof OdmowaOdczytuOdbiorcy) return // bramka (wyłączone, cień bez zgody firmy, konto nieaktywne) — ślad już jest
    if (e instanceof BrakZamowieniaOdbiorcy) return
    if (e instanceof BladOdczytuOdbiorcy && e.czekanieMs !== undefined) {
      // okno konta zajęte: nowe zadanie na wolne okno; klucz naprzemienny, bo bieżące zadanie trzyma swój do końca
      const runAfter = new Date((deps.now?.() ?? new Date()).getTime() + e.czekanieMs + 1000)
      await enqueue(db, KLIENT_ZAPIS_JOB, { orderId, ...(odlozone ? {} : { odlozone: true }) }, { dedupeKey: odlozone ? dedupeZapisu(orderId) : `${dedupeZapisu(orderId)}:tempo`, runAfter, maxAttempts: KLIENT_ZAPIS_PROB })
      return
    }
    if (e instanceof BladOdczytuOdbiorcy && e.rodzaj === 'PRZEJSCIOWY') throw e // komunikat bez danych (pobierz.ts)
    // Trwałe są tylko: trwały błąd kanału, trwały błąd adaptera i NonRetryableError (brak klucza, zły payload). Każdy
    // inny wyjątek (zerwane połączenie z bazą przy zapisie, błąd Prismy, TypeError parsera) to nie powód, żeby zamówienie
    // zostało bez danych klienta na stałe: ponowienie wg zasad `Job`, po maxAttempts FAILED z `lastError`. Komunikat
    // zastępczy niesie tylko klasę i kod błędu, bo `Job.lastError` nie może przenieść danych klienta.
    const trwaly =
      // `INNY` = nieznany wyjątek zamieniony przez pobierzOdbiorce (błąd Prismy, TypeError parsera): ponowienie (przeglądu 2)
      (e instanceof BladOdczytuOdbiorcy && e.rodzaj !== 'PRZEJSCIOWY' && e.rodzaj !== 'INNY') ||
      (e instanceof AdapterError && e.kind !== 'PRZEJSCIOWY') ||
      e instanceof NonRetryableError
    if (!trwaly) throw new BladPrzejsciowyZapisu(e)
    const klasa = e instanceof BladOdczytuOdbiorcy ? e.klasa : e instanceof Error ? e.name : 'nieznany'
    const rodzaj = e instanceof BladOdczytuOdbiorcy ? e.rodzaj : e instanceof AdapterError ? e.kind : e instanceof NonRetryableError ? 'TRWALY' : 'INNY'
    await sladZapisu(db, orderId, SYSTEM_ZAPISU, { wynik: 'BLAD', klasa, rodzaj })
    // brak klucza szyfru/skrótów: zadanie FAILED z komunikatem bez danych (widać w kolejce); trwały błąd kanału: koniec
    if (e instanceof NonRetryableError) throw e
  }
}

/** czy instalacja ma oba klucze do zapisu danych klienta (szyfr i skróty); bez wyjątku, bez wartości. */
export function kluczeZapisuDostepne(env: Record<string, string | undefined>): boolean {
  try {
    kluczeKlientowZEnv(env)
    return !!kluczSkrotowZEnv(env)
  } catch {
    return false
  }
}

/**
 * dane klienta zamówienia wpisanego w panelu albo przez API ogólne (źródło RECZNE). Rekord już jest (powtórka
 * żądania) = BYLY, bez nadpisania; brak (nowe zamówienie albo powtórka po błędzie zapisu) = zapis i ślad.
 */
export async function zapiszKlientaNowegoZamowienia(
  db: PrismaClient,
  orderId: string,
  rekord: RekordKlienta,
  o: { actorId: string; zrodlo: 'API' | 'NOWE_ZAMOWIENIE'; env: Record<string, string | undefined>; now?: Date },
): Promise<'ZAPISANO' | 'BYLY'> {
  if (await db.orderCustomer.findUnique({ where: { orderId }, select: { id: true } })) return 'BYLY'
  const w = await zapiszRekordKlienta(db, orderId, rekord, { source: 'RECZNE', fetchedAt: o.now ?? new Date(), env: o.env })
  await sladZapisu(db, orderId, o.actorId, { wynik: w, zrodlo: o.zrodlo })
  return w === 'ZAPISANO' ? 'ZAPISANO' : 'BYLY'
}
