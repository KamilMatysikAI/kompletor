// Ustawienia dokumentów sprzedaży firmy: `Organization.settings.faktury`.
// Program do faktur (dostawca dokumentów sprzedaży) to jedno ustawienie: `brak` | `wfirma` | `ksef` | klucz adaptera
// rejestru rodzaju `invoicing` (np. `fakturownia.v1`). Nowa firma z kreatora dostaje jawnie `brak` (presetNowejFirmy).
// Firma bez pola (dane): `wfirma`, gdy wFirma prowadzi jej stan, inaczej `brak` (firmy z wFirmą bez zmian).
// Czysty moduł bez bazy i bez importu z lib/wfirma: czyta go rdzeń (warunki przejść), ekrany i szkice KSeF.
import type { Prisma } from '@prisma/client'
import { ADAPTER_KEY_RE } from '../adaptery'
import { sufitRabatuProc } from '../rdzen/ceny'

/** Wbudowane programy; inny program = klucz adaptera `invoicing` z rejestru (format jak ChannelConfig.adapterKey). */
export const PROGRAMY_WBUDOWANE = ['brak', 'wfirma', 'ksef'] as const
export type ProgramWbudowany = (typeof PROGRAMY_WBUDOWANE)[number]
export type ProgramDokumentow = ProgramWbudowany | (string & { readonly __adapterKey?: never })

/** Klucz adaptera KSeF w rejestrze (lib/adaptery/ksef.ts) — jako program to samo co `ksef`. */
const KSEF_ADAPTER = 'ksef.fa3.v1'

/** Kiedy system ma wystawić dokument sprzedaży (o ile program umie wystawiać). */
export const MOMENTY_WYSTAWIENIA = ['SPAKOWANE', 'DO_WYSLANIA', 'WYSLANE'] as const
export type MomentWystawienia = (typeof MOMENTY_WYSTAWIENIA)[number]

export const RODZAJE_DOKUMENTU = ['faktura', 'paragon'] as const
export type RodzajDokumentu = (typeof RODZAJE_DOKUMENTU)[number]

export interface UstawieniaDokumentow {
  program: ProgramDokumentow
  /**
   * true = towar nie wyjdzie z magazynu prowadzonego przez Kompletor bez wystawionego dokumentu (blokada „Do wysyłki”).
   * Domyślnie false: wydanie i dokument to osobne tory. Przy źródle stanu wFirmy rozchód i tak idzie fakturą z WZ.
   */
  przedWysylka: boolean
  /** Przy jakim statusie zamówienia wystawić dokument (domyślnie po spakowaniu, jak kolejka wFirmy). */
  wystawiajPrzy: MomentWystawienia
  /** true = dokument tylko, gdy klient poprosił o fakturę (np. podał NIP); inaczej dla każdego zamówienia. */
  tylkoNaZadanie: boolean
  /** Domyślny rodzaj dokumentu. Paragon wymaga programu ze zdolnością paragonu (dziś żaden). */
  rodzaj: RodzajDokumentu
  /**
   * wyłącznik firmy „Wystawiaj faktury z Kompletora”. false (domyślnie) = Kompletor niczego nie wystawia
   * w programie do faktur, nawet z kluczami zapisu; pierwsza prawdziwa faktura firmy to osobna decyzja właściciela.
   */
  fakturyWlaczone: boolean
  /** Chwila włączenia (ISO). Dokument bez rozchodu dostaje tylko zamówienie, które doszło do momentu po tej chwili. */
  fakturyWlaczoneOd: string | null
}

/** Zapis w `Organization.settings.faktury` (obok ustawień wFirmy z lib/wfirma/konfiguracja.ts), wszystko opcjonalne. */
export interface UstawieniaDokumentowJson {
  program?: string
  przedWysylka?: boolean
  wystawiajPrzy?: MomentWystawienia
  tylkoNaZadanie?: boolean
  rodzaj?: RodzajDokumentu
  fakturyWlaczone?: boolean
  fakturyWlaczoneOd?: string
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** Poprawna wartość programu w ustawieniach: wbudowany albo klucz adaptera; inaczej null. */
export function programZWartosci(v: unknown): ProgramDokumentow | null {
  if (typeof v !== 'string') return null
  if ((PROGRAMY_WBUDOWANE as readonly string[]).includes(v)) return v as ProgramWbudowany
  if (v === KSEF_ADAPTER) return 'ksef'
  return ADAPTER_KEY_RE.test(v) && v.length <= 64 ? v : null
}

/**
 * Program do faktur firmy. Jawna, poprawna wartość wygrywa. Bez niej: `opts.maWfirme === false` → `brak`, w każdym
 * innym wypadku `wfirma` (dawne zachowanie, także wołania bez wiedzy o magazynie — szkice KSeF, testy).
 */
export function programFaktur(settings: Prisma.JsonValue | null | undefined, opts: { maWfirme?: boolean } = {}): ProgramDokumentow {
  const jawny = programZWartosci(obj(obj(settings)['faktury'])['program'])
  if (jawny) return jawny
  return opts.maWfirme === false ? 'brak' : 'wfirma'
}

export function parseUstawieniaDokumentow(settings: Prisma.JsonValue | null | undefined, opts: { maWfirme?: boolean } = {}): UstawieniaDokumentow {
  const f = obj(obj(settings)['faktury'])
  const moment = (MOMENTY_WYSTAWIENIA as readonly string[]).includes(f['wystawiajPrzy'] as string) ? (f['wystawiajPrzy'] as MomentWystawienia) : 'SPAKOWANE'
  const rodzaj = (RODZAJE_DOKUMENTU as readonly string[]).includes(f['rodzaj'] as string) ? (f['rodzaj'] as RodzajDokumentu) : 'faktura'
  const od = typeof f['fakturyWlaczoneOd'] === 'string' && !Number.isNaN(Date.parse(f['fakturyWlaczoneOd'])) ? f['fakturyWlaczoneOd'] : null
  return {
    program: programFaktur(settings, opts),
    przedWysylka: f['przedWysylka'] === true,
    wystawiajPrzy: moment,
    tylkoNaZadanie: f['tylkoNaZadanie'] === true,
    rodzaj,
    fakturyWlaczone: f['fakturyWlaczone'] === true,
    fakturyWlaczoneOd: f['fakturyWlaczone'] === true ? od : null,
  }
}

/**
 * Statusy, w których zamówienie „doszło do momentu” wystawienia: moment i każdy dalszy na drodze do
 * klienta. Zamówienie, które minęło moment wcześniej (np. „Wysłane” przy „po spakowaniu”), też go dostaje.
 */
export function statusyMomentu(m: MomentWystawienia): ('SPAKOWANE' | 'DO_WYSLANIA' | 'DO_ODBIORU' | 'WYSLANE' | 'ODEBRANE')[] {
  if (m === 'SPAKOWANE') return ['SPAKOWANE', 'DO_WYSLANIA', 'DO_ODBIORU', 'WYSLANE', 'ODEBRANE']
  if (m === 'DO_WYSLANIA') return ['DO_WYSLANIA', 'DO_ODBIORU', 'WYSLANE', 'ODEBRANE']
  return ['WYSLANE', 'ODEBRANE']
}

/**
 * Przy źródle stanu wFirmy faktura zdejmuje towar (WZ), więc idzie zawsze po spakowaniu i dla każdego zamówienia —
 * „wystawiaj przy” i „tylko na żądanie” dotyczą magazynu prowadzonego przez Kompletor (dokument bez rozchodu).
 */
export function momentDlaZrodla(zrodlo: 'KOMPLETOR' | 'WFIRMA', u: Pick<UstawieniaDokumentow, 'wystawiajPrzy' | 'tylkoNaZadanie'>): { wystawiajPrzy: MomentWystawienia; tylkoNaZadanie: boolean } {
  return zrodlo === 'WFIRMA' ? { wystawiajPrzy: 'SPAKOWANE', tylkoNaZadanie: false } : { wystawiajPrzy: u.wystawiajPrzy, tylkoNaZadanie: u.tylkoNaZadanie }
}

/**
 * wyłącznik firmy „WZ przy wysyłce bez faktury” (`settings.faktury.wzBezFaktury`). Przy stanie prowadzonym
 * w programie (lustro wFirmy) zamówienie wysłane bez faktury dostaje WZ w programie zamiast ruchu do ręcznego
 * zamknięcia. Domyślnie wyłączone: to zapis w programie księgowym, włącza go firma świadomie (jak faktury).
 */
/**
 * Czy zapis WZ w programie jest podłączony (adapter zapisu WZ do wFirmy, lib/wfirma/wz-zapis.ts, wpięty
 * w kolejkę wFirmy obok faktur). Przy false przełącznik „WZ przy wysyłce bez faktury” byłby widoczny, ale nieaktywny
 * z powodem, a zapis ustawień by go odrzucał (ustawienie, które się zapisuje i nic nie robi, to obietnica bez dostawy).
 */
export const ZAPIS_WZ_DOSTEPNY: boolean = true
export const POWOD_WZ_NIEDOSTEPNE = 'Zapis WZ do wFirmy będzie dostępny w kolejnej wersji.'

export function wzBezFaktury(settings: Prisma.JsonValue | null | undefined): boolean {
  return obj(obj(settings)['faktury'])['wzBezFaktury'] === true
}

/**
 * sufit rabatu na całe zamówienie w procentach wartości pozycji
 * (`settings.faktury.rabatMaksProcent`, 0–100, domyślnie 50). Różnica „pozycje + wysyłka − kwota zamówienia” większa niż
 * sufit nie jest rabatem (bon, zła kwota, netto zamiast brutto): dokument staje z `pozycje-drozsze-niz-zamowienie`.
 */
export function rabatMaksProcent(settings: Prisma.JsonValue | null | undefined): number {
  return sufitRabatuProc(obj(obj(settings)['faktury'])['rabatMaksProcent'])
}

/**
 * wyłącznik firmy „Korekty faktur przy zwrotach z Kompletora” (`settings.faktury.korektyWlaczone`). Osobny od
 * „Wystawiaj faktury z Kompletora” (i go wymaga): pierwsza prawdziwa korekta firmy to osobna decyzja właściciela, tak jak
 * pierwsza faktura. Wyłączony = „Zleć korektę” nieaktywne z powodem, a kolejka wFirmy nie dostaje adaptera korekt.
 */
export function korektyWlaczone(settings: Prisma.JsonValue | null | undefined): boolean {
  const f = obj(obj(settings)['faktury'])
  return f['korektyWlaczone'] === true && f['fakturyWlaczone'] === true
}

/**
 * chwila włączenia „WZ przy wysyłce bez faktury” (`settings.faktury.wzBezFakturyOd`,
 * ISO, zapisywana przy włączeniu na ekranie Ustawienia → Dokumenty sprzedaży). WZ dostają tylko wysyłki od tej chwili:
 * zaległe biuro dokumentowało ręcznie. Brak chwili albo wyłączony przełącznik = null (żadna wysyłka nie dostaje WZ).
 */
export function wzBezFakturyOd(settings: Prisma.JsonValue | null | undefined): Date | null {
  const f = obj(obj(settings)['faktury'])
  if (f['wzBezFaktury'] !== true || typeof f['wzBezFakturyOd'] !== 'string') return null
  const t = Date.parse(f['wzBezFakturyOd'])
  return Number.isNaN(t) ? null : new Date(t)
}

/**
 * Od kiedy Kompletor sam wystawia WZ przy wysyłce bez faktury: późniejsza z chwil włączenia „WZ przy wysyłce bez
 * faktury” i „Wystawiaj faktury z Kompletora” (program wFirma). null = nie wystawia (wysyłki zamyka biuro ręcznie).
 */
export function chwilaAutomatuWz(settings: Prisma.JsonValue | null | undefined): Date | null {
  const wz = wzBezFakturyOd(settings)
  const u = parseUstawieniaDokumentow(settings)
  if (!wz || u.program !== 'wfirma' || !u.fakturyWlaczone || !u.fakturyWlaczoneOd) return null
  return new Date(Math.max(wz.getTime(), Date.parse(u.fakturyWlaczoneOd)))
}

/**
 * Czy zamówienie potrzebuje dokumentu sprzedaży, zanim towar wyjdzie (albo zanim e-book się zakończy). Źródło stanu
 * wFirmy: zawsze (rozchód idzie fakturą z WZ, dawna ścieżka 1:1). Źródło Kompletor: tylko gdy firma ma program
 * i włączyła „Dokument przed wysyłką”.
 */
export function dokumentPrzedWydaniem(zrodlo: 'KOMPLETOR' | 'WFIRMA', u: Pick<UstawieniaDokumentow, 'program' | 'przedWysylka'>): boolean {
  if (zrodlo === 'WFIRMA') return true
  return u.program !== 'brak' && u.przedWysylka
}

export const ETYKIETA_PROGRAMU: Record<ProgramWbudowany, string> = {
  brak: 'Bez programu do faktur',
  wfirma: 'wFirma',
  ksef: 'KSeF bezpośrednio',
}

export const ETYKIETA_MOMENTU: Record<MomentWystawienia, string> = {
  SPAKOWANE: 'po spakowaniu',
  DO_WYSLANIA: 'przy „Do wysyłki / Do odbioru”',
  WYSLANE: 'po nadaniu („Wysłane”)',
}
