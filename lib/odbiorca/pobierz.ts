// Odbiorca zamówienia na żądanie. Jedyna droga z hosta do danych osobowych odbiorcy: przesyłka i faktura
// w trybie PRACA czytają je z kanału w chwili użycia (zdolność `orders.recipient`), a wynik żyje tylko w pamięci
// wywołującego. Nic tu nie zapisuje danych odbiorcy: bez pamięci podręcznej, zmiennych globalnych z danymi (limiter
// `tempo.ts` trzyma tylko znaczniki czasu kont), kolejki, alertów i logów z treścią. Wynik przycięty do `powod`. Jedyny zapis to wiersz AuditLog (kto, po co, które konto, jaki wynik) bez wartości pól.
// Bramka: instancja z `DANE_ODBIORCY_Z_KANALU=1` i konto kanału w PRACY (`ChannelConfig.statusMode`). Konto w cieniu
// nie czyta danych osobowych nawet wtedy, gdy wywołanie przyjdzie. Kanał bez źródła odbiorcy (EasyTools, ręczne,
// inne przez BL) albo adapter bez zdolności daje jawne „BRAK”, nigdy pusty adres. Opis: docs/dane-odbiorcy.md.
// (zmiana zasady 03.11): powód `ZAPIS` = pełny rekord do zaszyfrowanego zapisu w bazie (lib/klienci/zapis.ts),
// bez przycinania. Bramka zapisu osobna: `DANE_KLIENTA_ZAPIS=1` (nie DANE_ODBIORCY_Z_KANALU) i konto w PRACY albo
// ustawienie firmy „zapis w cieniu” (`CustomerDataSettings.zapisWCieniu`). PRZESYLKA i FAKTURA bez zmian.
import type { Channel, PrismaClient } from '@prisma/client'
import { createAccountAdapter, loadChannelAccounts } from '../adaptery/konta'
import { AdapterError, hasRecipientReader, type OrderRecipient } from '../adaptery/kontrakt'
import type { AdapterRegistry } from '../adaptery/rejestr'
import type { SecretSource } from '../sekrety'
import type { FetchLike } from '../zrodla/http'
import { zapisKlientaZEnv } from '../klienci/kolejka'
import { ustawieniaKlientow } from '../klienci/ustawienia'
import { tempoOdbiorcy, TempoPrzekroczone, type TempoOdbiorcy } from './tempo'

export const ODBIORCA_AUDIT_ENTITY = 'ODBIORCA_ODCZYT'

/** Po co czytamy odbiorcę — obowiązkowe, trafia do śladu. `ZAPIS` = pełny rekord do bazy. */
export const POWODY_ODCZYTU = ['PRZESYLKA', 'FAKTURA', 'ZAPIS'] as const
export type PowodOdczytu = (typeof POWODY_ODCZYTU)[number]

/** Kanały, z których system nie ma skąd wziąć odbiorcy (brak API kanału w Kompletorze). */
const KANALY_BEZ_ZRODLA: ReadonlySet<Channel> = new Set<Channel>(['EASYTOOLS', 'RECZNE', 'BL_INNE'])

export interface PobierzOdbiorceDeps {
  registry: AdapterRegistry
  /** Sekrety kont; `secrets.env` niesie też wyłącznik `DANE_ODBIORCY_Z_KANALU`. */
  secrets: SecretSource
  /** Kto czyta (User.id albo nazwa procesu); trafia do AuditLog. */
  actorId: string
  powod: PowodOdczytu
  fetch?: FetchLike
  now?: () => Date
  /** Limiter odstępu odczytów konta (testy wstrzykują własny); domyślnie wspólny dla procesu. */
  tempo?: TempoOdbiorcy
  /**
   * Najdłuższe czekanie na wolne okno konta (domyślnie jeden odstęp). Worker zapisu podaje 0: zajęte okno = błąd
   * `PRZEJSCIOWY` z `czekanieMs`, zadanie wraca do kolejki zamiast blokować pętlę workera.
   */
  maksCzekanieMs?: number
}

export type WynikOdbiorcy =
  | { zrodlo: 'KANAL'; kanal: string; odbiorca: OrderRecipient }
  | { zrodlo: 'BRAK'; kanal: string; przyczyna: 'KANAL_BEZ_ZRODLA' | 'ADAPTER_BEZ_ZDOLNOSCI' }

/** Odmowa odczytu (wyłącznik instancji, konto w cieniu, nieaktywne albo nieznane). Bez danych odbiorcy. */
export class OdmowaOdczytuOdbiorcy extends Error {
  constructor(
    message: string,
    readonly przyczyna: 'WYLACZONE' | 'CIEN' | 'KONTO_NIEAKTYWNE' | 'KONTO_NIEZNANE',
  ) {
    super(message)
    this.name = 'OdmowaOdczytuOdbiorcy'
  }
}

/**
 * Błąd odczytu z kanału. Komunikat ma tylko konto, rodzaj błędu i klasę — bez treści odpowiedzi kanału i bez
 * oryginalnego wyjątku (`cause` celowo pusty), żeby żaden wyższy log nie wypisał danych.
 */
export class BladOdczytuOdbiorcy extends Error {
  constructor(
    readonly kanal: string,
    readonly rodzaj: string,
    readonly klasa: string,
    /** Tylko przy limicie tempa: za ile zwolni się okno konta (ms). */
    readonly czekanieMs?: number,
  ) {
    super(`Odczyt odbiorcy z kanału ${kanal} nie powiódł się (${klasa}, ${rodzaj}).`)
    this.name = 'BladOdczytuOdbiorcy'
  }
}

export class BrakZamowieniaOdbiorcy extends Error {
  constructor() {
    super('Nie ma takiego zamówienia w tej firmie.')
    this.name = 'BrakZamowieniaOdbiorcy'
  }
}

/**
 * `DANE_ODBIORCY_Z_KANALU`: `1` = instancja może czytać odbiorcę z kanałów kont w PRACY; puste albo `0` =
 * nie (domyślnie). Zła wartość = błąd, nie po cichu (wzorem `cienOdczytZEnv`).
 */
export function daneOdbiorcyZEnv(env: Record<string, string | undefined>): boolean {
  const v = (env.DANE_ODBIORCY_Z_KANALU ?? '').trim()
  if (v === '1') return true
  if (v === '' || v === '0') return false
  throw new Error('DANE_ODBIORCY_Z_KANALU: 1 (włączony), 0 albo puste (wyłączony)')
}

type WynikSladu = 'OK' | 'BRAK' | 'ODMOWA' | 'BLAD'

async function slad(db: PrismaClient, orderId: string, deps: PobierzOdbiorceDeps, kanal: string, wynik: WynikSladu, extra: Record<string, string | number> = {}): Promise<void> {
  // tylko kody i liczby: żadnej wartości z odpowiedzi kanału
  await db.auditLog.create({ data: { entity: ODBIORCA_AUDIT_ENTITY, entityId: orderId, actorId: deps.actorId, after: { powod: deps.powod, kanal, wynik, ...extra } } })
}

/**
 * Odbiorca zamówienia `orderId` (Order.id firmy klienta `db`, RLS) prosto z kanału. Każde rozstrzygnięcie po
 * znalezieniu zamówienia zostawia jeden wiersz AuditLog bez danych. Wynik tylko dla wywołującego: nie zapisuj go.
 */
export async function pobierzOdbiorce(db: PrismaClient, orderId: string, deps: PobierzOdbiorceDeps): Promise<WynikOdbiorcy> {
  if (!POWODY_ODCZYTU.includes(deps.powod)) throw new Error('pobierzOdbiorce: powód PRZESYLKA, FAKTURA albo ZAPIS jest obowiązkowy')
  if (typeof deps.actorId !== 'string' || !deps.actorId.trim()) throw new Error('pobierzOdbiorce: brak actorId')
  const zapis = deps.powod === 'ZAPIS'
  if (zapis) {
    if (!zapisKlientaZEnv(deps.secrets.env)) throw new OdmowaOdczytuOdbiorcy('Zapis danych klienta jest wyłączony na tej instalacji. Włącza go administrator serwera.', 'WYLACZONE')
  } else if (!daneOdbiorcyZEnv(deps.secrets.env)) throw new OdmowaOdczytuOdbiorcy('Odczyt danych odbiorcy ze sklepu jest wyłączony na tej instalacji. Włącza go administrator serwera.', 'WYLACZONE')

  const order = await db.order.findUnique({ where: { id: orderId }, select: { id: true, organizationId: true, channel: true, channelAccountId: true, externalId: true } })
  if (!order) throw new BrakZamowieniaOdbiorcy()
  const kanal = `${order.channel}/${order.channelAccountId}`

  if (KANALY_BEZ_ZRODLA.has(order.channel)) {
    await slad(db, order.id, deps, kanal, 'BRAK', { przyczyna: 'KANAL_BEZ_ZRODLA' })
    return { zrodlo: 'BRAK', kanal, przyczyna: 'KANAL_BEZ_ZRODLA' }
  }

  const cfg = await db.channelConfig.findFirst({ where: { channel: order.channel, channelAccountId: order.channelAccountId }, select: { statusMode: true, active: true } })
  const odmowa = async (message: string, przyczyna: OdmowaOdczytuOdbiorcy['przyczyna']): Promise<never> => {
    await slad(db, order.id, deps, kanal, 'ODMOWA', { przyczyna })
    throw new OdmowaOdczytuOdbiorcy(message, przyczyna)
  }
  if (!cfg) return odmowa(`Konto ${kanal} nie jest skonfigurowane w firmie.`, 'KONTO_NIEZNANE')
  if (!cfg.active) return odmowa(`Konto ${kanal} jest nieaktywne.`, 'KONTO_NIEAKTYWNE')
  // konto w cieniu nie czyta danych osobowych: adapter nawet nie powstaje. Wyjątek: zapis w bazie, gdy firma
  // świadomie włączyła „zapis w cieniu” (tryb cienia do testów narzędzia docelowego)
  if (cfg.statusMode !== 'PRACA' && !(zapis && (await ustawieniaKlientow(db)).zapisWCieniu))
    return odmowa(`Konto ${kanal} jest w trybie „Tylko podgląd”: dane odbiorcy czytamy tylko z kont aktywnych.`, 'CIEN')

  const acc = (await loadChannelAccounts(db, { activeOnly: true })).find((a) => a.channel === order.channel && a.channelAccountId === order.channelAccountId)
  if (!acc) return odmowa(`Konto ${kanal} jest nieaktywne.`, 'KONTO_NIEAKTYWNE')

  // manifest wystarcza do rozstrzygnięcia „brak zdolności”: bez tworzenia adaptera i bez sekretów
  const def = deps.registry.get(acc.adapterKey)
  if (def && !def.manifest.capabilities.includes('orders.recipient')) {
    await slad(db, order.id, deps, kanal, 'BRAK', { przyczyna: 'ADAPTER_BEZ_ZDOLNOSCI' })
    return { zrodlo: 'BRAK', kanal, przyczyna: 'ADAPTER_BEZ_ZDOLNOSCI' }
  }

  let odbiorca: OrderRecipient
  try {
    // odstęp konta (Mirakl OR11: 60 s) przed utworzeniem adaptera; klucz z firmą, bo konta różnych firm mają różne klucze API
    const tempo = deps.tempo ?? tempoOdbiorcy
    const odstep = def?.manifest.rateLimit.recipientMinIntervalMs ?? 0
    if (deps.maksCzekanieMs === undefined) await tempo.czekaj(`${order.organizationId}:${kanal}`, odstep)
    else await tempo.czekaj(`${order.organizationId}:${kanal}`, odstep, deps.maksCzekanieMs)
    const adapter = await createAccountAdapter(db, deps.registry, acc, deps.secrets, { fetch: deps.fetch, now: deps.now })
    if (!hasRecipientReader(adapter)) throw new AdapterError('adapter deklaruje orders.recipient bez metody', 'TRWALY')
    odbiorca = await adapter.getOrderRecipient(order.externalId)
  } catch (e) {
    const klasa = e instanceof Error ? e.name : 'nieznany'
    const rodzaj = e instanceof AdapterError ? e.kind : e instanceof TempoPrzekroczone ? 'PRZEJSCIOWY' : 'INNY'
    // zapis z kolejki odłożony limitem tempa: kanał nie dostał zapytania, zadanie wróci — bez śladu i bez logu co minutę
    if (zapis && e instanceof TempoPrzekroczone) throw new BladOdczytuOdbiorcy(kanal, rodzaj, klasa, e.czekanieMs)
    // log bez komunikatu wyjątku: komunikat adaptera nie ma wartości pól, ale cudzy wyjątek (sieć, parser) mógłby mieć
    console.warn(`[odbiorca] odczyt nie powiódł się: ${kanal}, zamówienie ${order.id}, ${klasa}, ${rodzaj}`)
    await slad(db, order.id, deps, kanal, 'BLAD', { klasa, rodzaj })
    throw new BladOdczytuOdbiorcy(kanal, rodzaj, klasa)
  }
  // ślad przed zwrotem: bez zapisanego śladu dane nie wychodzą
  await slad(db, order.id, deps, kanal, 'OK', { problemy: odbiorca.problemy.length })
  return { zrodlo: 'KANAL', kanal, odbiorca: deps.powod === 'ZAPIS' ? odbiorca : przytnijDoPowodu(odbiorca, deps.powod) }
}

const PROBLEMY_FAKTURY: ReadonlySet<string> = new Set(['nip_klucz_nieustawiony', 'brak_nip', 'nip_niedostepny_w_kanale', 'faktura_klucz_nieustawiony'])

/**
 * Minimalizacja danych (RODO art. 5 ust. 1 lit. c): wywołujący dostaje tylko pola potrzebne do
 * celu z `powod`. PRZESYLKA: bez danych faktury (i ich problemów). FAKTURA: bez punktu odbioru, telefonu i e-maila;
 * adres dostawy zostaje, bo przy braku danych faktury proces może wystawić ją na adres dostawy.
 */
export function przytnijDoPowodu(rIn: OrderRecipient, powod: Exclude<PowodOdczytu, 'ZAPIS'>): OrderRecipient {
  // login i uwagi klienta są tylko do zapisu rekordu (karta), przesyłce ani fakturze niepotrzebne
  const { login: _login, uwagi: _uwagi, ...r } = rIn
  void _login
  void _uwagi
  if (powod === 'PRZESYLKA') return { ...r, faktura: null, problemy: r.problemy.filter((p) => !PROBLEMY_FAKTURY.has(p)) }
  return {
    ...r,
    dostawa: r.dostawa ? { ...r.dostawa, telefon: null, email: null } : null,
    punktOdbioru: null,
    problemy: r.problemy.filter((p) => p !== 'punkt_nieznany' && p !== 'brak_telefon' && p !== 'brak_email'),
  }
}
