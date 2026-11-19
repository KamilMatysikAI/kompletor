// Akcje masowe listy przesyłek: druk etykiet na stanowisku i anulowanie przesyłek u przewoźnika.
// Wzór i tabela postępu jak akcje listy zamówień (lib/zamowienia/masowo.ts): każda przesyłka osobno
// w try/catch, wynik per przesyłka w raporcie (numer, ok/błąd, powód bez danych klienta), od PROG_TLA przesyłek w tle
// (wiersz OrderBulkAction z identyfikatorami PRZESYŁEK w `orderIds` + zadanie kolejki `przesylki-masowo`).
//
// Druk: kolejność jak na liście, jedno zlecenie druku na etykietę z kluczem od przesyłki i akcji, więc ponowienie
// (drugi worker, wznowienie po awarii) nie dubluje zleceń, a nowe kliknięcie „Drukuj” drukuje ponownie. Etykieta
// z zapisanego pliku (bez pytania przewoźnika). Anulowanie: host przesyłek (`anulujPrzesylke`) z jego bramkami (PRACA,
// zdolność `shipment.cancel`, jedna komenda przy powtórzeniu). Obie akcje tylko na kontach z włączonym nadawaniem.
import type { Prisma, PrismaClient } from '@prisma/client'
import type { Permission } from '@/lib/auth/uprawnienia'
import { organizationIdOf } from '@/lib/db'
import { BladDruku, utworzZlecenie } from '@/lib/druk/zlecenia'
import { uprawnieniaOsoby } from '@/lib/klienci/odczyt'
import { enqueue } from '@/lib/worker/kolejka'
import { dopiszWynik, komunikatPrzerwania, maWynik, stanZWiersza, type ProbaZadania, type StanAkcji, type WynikPozycji } from '@/lib/zamowienia/masowo'
import { etykietaPrzesylkiPoId } from './etykieta-przewoznika'
import { kluczKonta, kontaPrzewoznikow, type KontoListy } from './lista'
import { anulujPrzesylke, type DepsNadania } from './nadanie'

type Db = PrismaClient

import { RODZAJE_PRZESYLEK, type RodzajPrzesylek } from './masowo-progi'

export { MAKS_PLIKU, MAKS_PRZESYLEK, NAZWA_AKCJI_PRZESYLEK, PROG_TLA_PRZESYLEK, RODZAJE_PRZESYLEK, type RodzajPrzesylek } from './masowo-progi'
export const ZADANIE_PRZESYLEK = 'przesylki-masowo'
export const UPRAWNIENIE_PRZESYLEK: Permission = 'pakowanie.stanowisko'

export interface ParametryPrzesylek {
  stanowisko?: string | null
  /** klucz kliknięcia z przeglądarki (druk od razu): powtórzone wysłanie tego samego formularza nie dubluje zleceń */
  klucz?: string | null
}

const ID_RE = /^[a-z0-9]{1,40}$/i
const KLUCZ_RE = /^[A-Za-z0-9_-]{8,32}$/

/**
 * `odRazu`: druk poniżej progu tła wymaga klucza kliknięcia: bez niego zlecenie dostałoby stały
 * klucz i drugi druk tej przesyłki odpowiadałby „Zlecenie druku już było” przez całą ważność zlecenia. W tle kluczem
 * jest id akcji.
 */
export function bladParametrowPrzesylek(rodzaj: RodzajPrzesylek, p: ParametryPrzesylek, o: { odRazu?: boolean } = {}): string | null {
  if (rodzaj === 'PRZESYLKI_DRUK' && (!p.stanowisko || !ID_RE.test(p.stanowisko))) return 'Wybierz stanowisko druku.'
  if (p.klucz && !KLUCZ_RE.test(p.klucz)) return 'Odśwież stronę i spróbuj jeszcze raz.'
  if (rodzaj === 'PRZESYLKI_DRUK' && o.odRazu && !p.klucz) return 'Odśwież stronę i spróbuj jeszcze raz.'
  return null
}

/** Powód, dla którego konto przewoźnika nie pozwala na druk i anulowanie (etykiety też: plik i wiersz); null = wolno. */
export function powodKontaWylaczonego(k: Pick<KontoListy, 'nadawanie' | 'nazwa'> | undefined): string | null {
  if (k?.nadawanie) return null
  return `Nadawanie z Kompletora jest wyłączone na koncie „${k?.nazwa ?? 'przewoźnika'}” (Ustawienia → Wysyłka i druk → Przewoźnicy → Konta przewoźników).`
}

interface Osoba {
  id: string
  uprawnienia: ReadonlySet<string>
}

/** Jedna przesyłka. Wyjątek zamienia się w wynik z błędem (bez treści wyjątku, która mogłaby nieść dane). */
export async function wykonajPrzesylke(
  db: Db,
  rodzaj: RodzajPrzesylek,
  p: ParametryPrzesylek,
  id: string,
  osoba: Osoba,
  o: { konta: Map<string, KontoListy>; akcja: string | null; deps?: DepsNadania; now?: Date },
): Promise<WynikPozycji> {
  const s = await db.shipment.findUnique({ where: { id }, select: { id: true, orderId: true, adapterKey: true, accountSuffix: true, trackingNumber: true, order: { select: { channelNumber: true, externalId: true } } } }).catch(() => null)
  const nr = s ? (s.trackingNumber ?? s.order.channelNumber ?? s.order.externalId) : id
  const wynik = (ok: boolean, komunikat: string): WynikPozycji => ({ id, nr, ok, komunikat })
  try {
    if (!s) return wynik(false, 'Nie ma takiej przesyłki.')
    if (!osoba.uprawnienia.has(UPRAWNIENIE_PRZESYLEK)) return wynik(false, 'Brak uprawnienia do tej akcji.')
    const wylaczone = powodKontaWylaczonego(o.konta.get(kluczKonta(s.adapterKey, s.accountSuffix)))
    if (wylaczone) return wynik(false, wylaczone)
    if (rodzaj === 'PRZESYLKI_DRUK') {
      // etykieta sprawdzona PRZED zleceniem: pominięta przesyłka (bez etykiety, anulowana) nie zostawia zlecenia z błędem
      const zrodloKlucza = o.akcja ?? p.klucz
      if (!zrodloKlucza) return wynik(false, 'Odśwież stronę i spróbuj jeszcze raz.')
      const e = await etykietaPrzesylkiPoId(db, s.id)
      const klucz = `ety-${s.id}-${zrodloKlucza}`
      const w = await utworzZlecenie(db, {
        stationId: String(p.stanowisko),
        typ: 'etykieta',
        zrodlo: 'PANEL',
        klucz,
        kto: osoba.id,
        orderIds: [s.orderId],
        now: o.now,
        rysuj: async () => ({ pliki: { pdf: e.pdf, zpl: e.zpl }, opis: e.opis }),
      })
      if (w.istnialo && (w.zlecenie.status === 'BLAD' || w.zlecenie.status === 'WYGASLO')) return wynik(false, `Pominięta: ${w.zlecenie.resultMessage ?? 'poprzednie zlecenie druku nie powiodło się'}`)
      return wynik(true, w.istnialo ? 'Zlecenie druku już było (bez drugiego wydruku).' : 'Etykieta wysłana do druku.')
    }
    const r = await anulujPrzesylke(db, s.id, { userId: osoba.id, deps: o.deps })
    return wynik(r.wynik === 'ANULOWANA', r.komunikat)
  } catch (e) {
    if (e instanceof BladDruku) return wynik(false, `Pominięta: ${e.message}`)
    console.error(`[przesylki-masowo] ${rodzaj} ${id}:`, e instanceof Error ? e.message : e)
    return wynik(false, 'Nieoczekiwany błąd: spróbuj na karcie zamówienia.')
  }
}

export interface WynikAkcjiPrzesylek {
  rodzaj: RodzajPrzesylek
  razem: number
  ok: number
  bledy: number
  pozycje: WynikPozycji[]
}

/** Akcja od razu (poniżej progu), po kolei w kolejności listy. */
export async function wykonajPrzesylkiOdRazu(db: Db, rodzaj: RodzajPrzesylek, p: ParametryPrzesylek, ids: string[], osoba: Osoba, deps?: DepsNadania): Promise<WynikAkcjiPrzesylek> {
  organizationIdOf(db)
  const konta = await kontaPrzewoznikow(db, deps?.registry, { zPrzesylek: false })
  const pozycje: WynikPozycji[] = []
  for (const id of ids) pozycje.push(await wykonajPrzesylke(db, rodzaj, p, id, osoba, { konta, akcja: null, deps }))
  const ok = pozycje.filter((x) => x.ok).length
  return { rodzaj, razem: pozycje.length, ok, bledy: pozycje.length - ok, pozycje }
}

/** Akcja w tle: wiersz z postępem i zadanie kolejki. Zwraca id akcji. */
export async function zlecPrzesylkiWTle(db: Db, rodzaj: RodzajPrzesylek, p: ParametryPrzesylek, ids: string[], userId: string): Promise<string> {
  organizationIdOf(db)
  // w parametrach tylko stanowisko (bez nazwiska osoby; kto zlecił = createdBy)
  const params: ParametryPrzesylek = { stanowisko: p.stanowisko ?? null }
  const a = await db.orderBulkAction.create({ data: { kind: rodzaj, params: params as Prisma.InputJsonValue, orderIds: ids, createdBy: userId }, select: { id: true } })
  await enqueue(db, ZADANIE_PRZESYLEK, { akcja: a.id }, { dedupeKey: `${ZADANIE_PRZESYLEK}:${a.id}`, maxAttempts: 3 })
  return a.id
}

/** Handler zadania kolejki: jak `wykonajWTle` listy zamówień (wznawia od pierwszej przesyłki bez wyniku). */
export async function wykonajPrzesylkiWTle(db: Db, payload: Prisma.JsonValue, proba?: ProbaZadania, deps?: DepsNadania): Promise<void> {
  const id = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>)['akcja'] : undefined
  if (typeof id !== 'string' || !ID_RE.test(id)) return
  const a = await db.orderBulkAction.findUnique({ where: { id } })
  if (!a || a.state === 'GOTOWE' || a.state === 'BLAD') return
  const rodzaj = a.kind as RodzajPrzesylek
  if (!RODZAJE_PRZESYLEK.includes(rodzaj)) return
  try {
    const p = (a.params ?? {}) as ParametryPrzesylek
    const uprawnienia = await uprawnieniaOsoby(db, a.createdBy)
    const konta = await kontaPrzewoznikow(db, deps?.registry, { zPrzesylek: false })
    await db.orderBulkAction.updateMany({ where: { id, state: { in: ['CZEKA', 'TRWA'] } }, data: { state: 'TRWA' } })
    for (const sid of a.orderIds) {
      if (await maWynik(db, id, sid)) continue
      const w = await wykonajPrzesylke(db, rodzaj, p, sid, { id: a.createdBy, uprawnienia }, { konta, akcja: id, deps })
      await dopiszWynik(db, id, w)
    }
    await db.orderBulkAction.updateMany({ where: { id, state: { in: ['CZEKA', 'TRWA'] } }, data: { state: 'GOTOWE', finishedAt: new Date() } })
  } catch (e) {
    if (proba && proba.attempts >= proba.maxAttempts) {
      const teraz = await db.orderBulkAction.findUnique({ where: { id }, select: { done: true } }).catch(() => null)
      await db.orderBulkAction
        .updateMany({ where: { id, state: { in: ['CZEKA', 'TRWA'] } }, data: { state: 'BLAD', lastError: komunikatPrzerwania(teraz?.done ?? 0, a.orderIds.length, 'przesyłek'), finishedAt: new Date() } })
        .catch(() => undefined)
    }
    throw e
  }
}

/** Akcje listy przesyłek tej osoby w toku albo zakończone w ostatnich 15 minutach (pasek postępu nad listą). */
export async function ostatnieAkcjePrzesylek(db: Db, userId: string, now = new Date()): Promise<StanAkcji[]> {
  const rows = await db.orderBulkAction.findMany({
    where: { createdBy: userId, kind: { in: [...RODZAJE_PRZESYLEK] }, OR: [{ state: { in: ['CZEKA', 'TRWA'] }, updatedAt: { gte: new Date(now.getTime() - 60 * 60_000) } }, { finishedAt: { gte: new Date(now.getTime() - 15 * 60_000) } }] },
    orderBy: { createdAt: 'desc' },
    take: 3,
  })
  return rows.map(stanZWiersza)
}
