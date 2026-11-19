// jedna mapa „stan → etykieta + ton” dla całego panelu. Komponenty `StatusZamowienia`, `TrybKanalu`
// i `StanPlatnosci` (app/ui/statusy.tsx) czytają tylko stąd, więc status zamówienia wygląda tak samo na liście,
// w pakowaniu i na karcie. Ton to nazwa semantyczna (tokeny `--kolor-<ton>` w app/ui/tokeny.css), nie kolor.
import type { Carrier, ChannelMode, OrderStatus, PaymentState, Prisma } from '@prisma/client'

export type Ton = 'neutralny' | 'info' | 'sukces' | 'ostrzezenie' | 'blad' | 'uwaga' | 'akcent'

/** Etap zamówienia z punktu widzenia magazynu; decyduje o tonie odznaki. */
export type EtapZamowienia = 'nowe' | 'w_realizacji' | 'gotowe' | 'zakonczone' | 'problem' | 'anulowane'

export const STATUS_ZAMOWIENIA: Record<OrderStatus, { etykieta: string; etap: EtapZamowienia }> = {
  NOWE: { etykieta: 'Nowe', etap: 'nowe' },
  DO_REALIZACJI: { etykieta: 'Do realizacji', etap: 'w_realizacji' },
  ZBIERANIE: { etykieta: 'Zbieranie', etap: 'w_realizacji' },
  ZEBRANE: { etykieta: 'Zebrane', etap: 'w_realizacji' },
  SPAKOWANE: { etykieta: 'Spakowane', etap: 'gotowe' },
  DO_WYSLANIA: { etykieta: 'Do wysłania', etap: 'gotowe' },
  DO_ODBIORU: { etykieta: 'Do odbioru', etap: 'gotowe' },
  WYSLANE: { etykieta: 'Wysłane', etap: 'zakonczone' },
  ODEBRANE: { etykieta: 'Odebrane', etap: 'zakonczone' },
  ANULOWANE: { etykieta: 'Anulowane', etap: 'anulowane' },
  DO_WYJASNIENIA: { etykieta: 'Do wyjaśnienia', etap: 'problem' },
  REKLAMACJA: { etykieta: 'Reklamacja', etap: 'problem' },
}

const TON_ETAPU: Record<EtapZamowienia, Ton> = {
  nowe: 'info',
  w_realizacji: 'ostrzezenie',
  gotowe: 'sukces',
  zakonczone: 'akcent',
  problem: 'uwaga',
  anulowane: 'neutralny',
}

export function statusZamowienia(s: OrderStatus): { etykieta: string; ton: Ton; etap: EtapZamowienia } {
  const z = STATUS_ZAMOWIENIA[s]
  return { ...z, ton: TON_ETAPU[z.etap] }
}

/**
 * Stan konta kanału dla użytkownika (słownik UI: „cień” → „Tylko podgląd”, „praca” → „Aktywny”). `tryb` dotyczy
 * jednej rzeczy (stany albo statusy); `aktywne: false` = konto wyłączone niezależnie od trybu.
 */
export function trybKanalu(tryb: ChannelMode | 'BEZ_STANOW' | 'MIESZANY', aktywne = true): { etykieta: string; ton: Ton; opis: string } {
  if (!aktywne) return { etykieta: 'Wyłączony', ton: 'neutralny', opis: 'Konto nie jest odczytywane.' }
  if (tryb === 'PRACA') return { etykieta: 'Aktywny', ton: 'sukces', opis: 'Kompletor zapisuje zmiany w sklepie.' }
  // zamówienia prowadzi Kompletor, stany ofert dalej dotychczasowy system
  if (tryb === 'BEZ_STANOW') return { etykieta: 'Aktywny bez stanów', ton: 'sukces', opis: 'Kompletor prowadzi zamówienia i wysyła statusy, stanów ofert nie wysyła.' }
  if (tryb === 'MIESZANY') return { etykieta: 'Mieszany', ton: 'ostrzezenie', opis: 'Część rzeczy w trybie pracy, część w podglądzie.' }
  return { etykieta: 'Tylko podgląd', ton: 'info', opis: 'Kompletor czyta sklep, niczego w nim nie zmienia.' }
}

export const STAN_PLATNOSCI: Record<PaymentState, { etykieta: string; ton: Ton }> = {
  PAID: { etykieta: 'Opłacone', ton: 'sukces' },
  UNPAID: { etykieta: 'Nieopłacone', ton: 'ostrzezenie' },
  COD: { etykieta: 'Za pobraniem', ton: 'info' },
  PARTIAL: { etykieta: 'Niedopłata', ton: 'blad' },
}

// ─── Statusy firmy ──────────────────────────────────────────
// Warstwa nazw nad enumem rdzenia: firma nazywa statusy po swojemu („Do realizacji DPD”), rdzeń dalej liczy
// i przechodzi po `OrderStatus`. Jedno miejsce tłumaczenia „enum + przewoźnik (+ przypisanie wprost) → status firmy”:
// `wybierzStatusFirmy`. Firma bez statusów (albo zamówienie, do którego żaden nie pasuje) widzi nazwę rdzenia.

/** Paleta kolorów statusów firmy: tekst i tło z kontrastem ≥ 4,5:1 (kropki w menu, pigułki, panel listy). */
export const KOLORY_STATUSOW = {
  niebieski: { nazwa: 'niebieski', tekst: '#1f5a8a', tlo: '#e2eef8' },
  fioletowy: { nazwa: 'fioletowy', tekst: '#553a9e', tlo: '#ece7f8' },
  pomaranczowy: { nazwa: 'pomarańczowy', tekst: '#8a4b06', tlo: '#fdf0d5' },
  zolty: { nazwa: 'żółty', tekst: '#665500', tlo: '#fbf3c4' },
  zielony: { nazwa: 'zielony', tekst: '#245540', tlo: '#e3efe7' },
  turkusowy: { nazwa: 'turkusowy', tekst: '#0f5c60', tlo: '#dcf1f1' },
  czerwony: { nazwa: 'czerwony', tekst: '#a8251b', tlo: '#fce6e3' },
  rozowy: { nazwa: 'różowy', tekst: '#8f2560', tlo: '#f9e3ef' },
  brazowy: { nazwa: 'brązowy', tekst: '#5b4321', tlo: '#e9e1d3' },
  szary: { nazwa: 'szary', tekst: '#4b5750', tlo: '#eceee9' },
} as const
export type KolorStatusu = keyof typeof KOLORY_STATUSOW
export const isKolorStatusu = (v: string | null | undefined): v is KolorStatusu => !!v && Object.hasOwn(KOLORY_STATUSOW, v)

/** Kolor statusu rdzenia, gdy firma nie ma własnego (z etapu, jak ton odznaki). */
const KOLOR_ETAPU: Record<EtapZamowienia, KolorStatusu> = {
  nowe: 'niebieski',
  w_realizacji: 'pomaranczowy',
  gotowe: 'turkusowy',
  zakonczone: 'zielony',
  problem: 'fioletowy',
  anulowane: 'szary',
}

export const KLUCZ_STATUSU_RE = /^[A-Z0-9][A-Z0-9_]{0,39}$/
export const MAX_STATUSOW = 60
export const MAX_GRUP = 20
const STATUS_KANALU_RE = /^[A-Za-z0-9_-]{1,40}$/

/** Definicja statusu firmy (tabela OrderStatusDef bez organizacji i dat). */
export interface StatusFirmyT {
  key: string
  name: string
  customerName?: string | null
  color: string
  groupKey?: string | null
  sortOrder: number
  baseStatus: OrderStatus
  /** przewoźnicy, dla których status pasuje; pusta lista = każdy */
  carriers: readonly Carrier[]
  active: boolean
}

export interface GrupaStatusowT {
  key: string
  name: string
  sortOrder: number
  collapsed: boolean
}

export const STATUSY_RDZENIA = Object.keys(STATUS_ZAMOWIENIA) as OrderStatus[]
export const PRZEWOZNICY_WSZYSCY: readonly Carrier[] = ['PACZKOMATY', 'INPOST_KURIER', 'DPD', 'DPD_EMPIK', 'ALLEGRO', 'OSOBISTY', 'BEZ_WYSYLKI', 'BRAK']

export function validateStatusFirmy(d: StatusFirmyT, grupy?: readonly string[]): void {
  if (!KLUCZ_STATUSU_RE.test(d.key)) throw new Error(`Zły klucz statusu: ${d.key}`)
  const n = d.name.trim()
  if (!n) throw new Error('Status musi mieć nazwę')
  if (n.length > 40) throw new Error('Nazwa statusu może mieć najwyżej 40 znaków')
  if ((d.customerName ?? '').length > 60) throw new Error('Nazwa dla klienta może mieć najwyżej 60 znaków')
  if (!isKolorStatusu(d.color)) throw new Error(`Nieznany kolor statusu: ${d.color}`)
  if (!STATUSY_RDZENIA.includes(d.baseStatus)) throw new Error(`Nieznany status bazowy: ${d.baseStatus}`)
  for (const c of d.carriers) if (!PRZEWOZNICY_WSZYSCY.includes(c)) throw new Error(`Nieznany przewoźnik: ${c}`)
  if (d.groupKey && grupy && !grupy.includes(d.groupKey)) throw new Error(`Nieznana grupa statusu: ${d.groupKey}`)
  if (!Number.isInteger(d.sortOrder) || d.sortOrder < 0 || d.sortOrder > 100_000) throw new Error(`Zła kolejność statusu: ${d.sortOrder}`)
}

export function validateGrupaStatusow(g: GrupaStatusowT): void {
  if (!KLUCZ_STATUSU_RE.test(g.key)) throw new Error(`Zły klucz grupy: ${g.key}`)
  const n = g.name.trim()
  if (!n) throw new Error('Grupa musi mieć nazwę')
  if (n.length > 40) throw new Error('Nazwa grupy może mieć najwyżej 40 znaków')
  if (!Number.isInteger(g.sortOrder) || g.sortOrder < 0 || g.sortOrder > 100_000) throw new Error(`Zła kolejność grupy: ${g.sortOrder}`)
}

/** Zestaw statusów (preset albo zapis ekranu): poprawne pola, unikalne klucze, każdy status rdzenia ma swój status firmy. */
export function validateZestawStatusow(statusy: readonly StatusFirmyT[], grupy: readonly GrupaStatusowT[]): void {
  if (statusy.length > MAX_STATUSOW) throw new Error(`Najwyżej ${MAX_STATUSOW} statusów`)
  if (grupy.length > MAX_GRUP) throw new Error(`Najwyżej ${MAX_GRUP} grup`)
  for (const g of grupy) validateGrupaStatusow(g)
  if (new Set(grupy.map((g) => g.key)).size !== grupy.length) throw new Error('Powtórzony klucz grupy statusów')
  const gk = grupy.map((g) => g.key)
  for (const s of statusy) validateStatusFirmy(s, gk)
  if (new Set(statusy.map((s) => s.key)).size !== statusy.length) throw new Error('Powtórzony klucz statusu')
  if (statusy.length) {
    const brak = brakujaceBazowe(statusy)
    if (brak.length) throw new Error(`Brakuje statusu dla: ${brak.map((b) => STATUS_ZAMOWIENIA[b].etykieta).join(', ')}`)
  }
}

/** Statusy rdzenia bez żadnego statusu firmy (każdy status bazowy musi mieć co najmniej jeden). */
export function brakujaceBazowe(statusy: readonly Pick<StatusFirmyT, 'baseStatus'>[]): OrderStatus[] {
  return STATUSY_RDZENIA.filter((b) => !statusy.some((s) => s.baseStatus === b))
}

const poKolejnosci = <T extends { sortOrder: number; key: string }>(a: T, b: T) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key)
export const sortujStatusy = <T extends { sortOrder: number; key: string }>(l: readonly T[]): T[] => [...l].sort(poKolejnosci)

export interface ZamowienieDoStatusu {
  status: OrderStatus
  carrier: Carrier | null
  companyStatus?: string | null
}

/**
 * Status firmy zamówienia: przypisany wprost (gdy jego status bazowy = status rdzenia), inaczej pierwszy aktywny
 * status z tym statusem bazowym i tym przewoźnikiem, inaczej pierwszy aktywny bez przewoźników. null = żaden
 * nie pasuje (pokazujemy nazwę rdzenia). Brak przewoźnika liczy się jak „bez przewoźnika” (BRAK).
 */
export function wybierzStatusFirmy<T extends StatusFirmyT>(defs: readonly T[], o: ZamowienieDoStatusu): T | null {
  if (o.companyStatus) {
    const d = defs.find((x) => x.key === o.companyStatus)
    if (d && d.baseStatus === o.status) return d
  }
  const c: Carrier = o.carrier ?? 'BRAK'
  let ogolny: T | null = null
  for (const d of sortujStatusy(defs)) {
    if (!d.active || d.baseStatus !== o.status) continue
    if (d.carriers.includes(c)) return d
    if (!d.carriers.length && !ogolny) ogolny = d
  }
  return ogolny
}

export interface EtykietaStatusuFirmy {
  /** klucz statusu firmy; null = nazwa rdzenia (firma nie ma pasującego statusu) */
  klucz: string | null
  nazwa: string
  kolor: KolorStatusu
  /** nazwa rdzenia (podpowiedź przy nazwie firmy) */
  bazowy: string
  grupa: string | null
  /** status firmy dotyczy konkretnych przewoźników (nazwa zwykle już go niesie: „Do realizacji DPD”) */
  zPrzewoznikiem: boolean
}

export function etykietaStatusuFirmy(defs: readonly StatusFirmyT[], o: ZamowienieDoStatusu): EtykietaStatusuFirmy {
  const d = wybierzStatusFirmy(defs, o)
  const rdzen = STATUS_ZAMOWIENIA[o.status]
  if (!d) return { klucz: null, nazwa: rdzen.etykieta, kolor: KOLOR_ETAPU[rdzen.etap], bazowy: rdzen.etykieta, grupa: null, zPrzewoznikiem: false }
  return { klucz: d.key, nazwa: d.name, kolor: isKolorStatusu(d.color) ? d.color : 'szary', bazowy: rdzen.etykieta, grupa: d.groupKey ?? null, zPrzewoznikiem: d.carriers.length > 0 }
}

/** Klucz pozycji „bez statusu firmy” (zamówienia, do których nie pasuje żaden status firmy) w panelu listy. */
export const kluczRdzenia = (s: OrderStatus) => `RDZEN:${s}`

/**
 * Warunek zapytania „zamówienia ze statusem firmy `klucz`” (albo `RDZEN:<status>` = bez pasującego statusu firmy),
 * zgodny z `wybierzStatusFirmy`: przypisane wprost albo wyliczone z enumu i przewoźnika. Klucz nieznany = nic.
 */
export function warunekStatusuFirmy(defs: readonly StatusFirmyT[], klucz: string): Prisma.OrderWhereInput {
  const rdzen = klucz.startsWith('RDZEN:') ? (klucz.slice(6) as OrderStatus) : null
  const d = rdzen ? null : defs.find((x) => x.key === klucz)
  const base = rdzen ? (STATUSY_RDZENIA.includes(rdzen) ? rdzen : undefined) : d?.baseStatus
  if (!base) return { id: '__brak__' }
  // przewoźnicy, dla których wyliczenie (bez przypisania wprost) daje ten status
  const chce = d ? d.key : null
  const przew = PRZEWOZNICY_WSZYSCY.filter((c) => (wybierzStatusFirmy(defs, { status: base, carrier: c })?.key ?? null) === chce)
  // przypisanie wprost ważne dla tego statusu bazowego wygrywa z wyliczeniem
  const wazneWprost = defs.filter((x) => x.baseStatus === base).map((x) => x.key)
  const lub: Prisma.OrderWhereInput[] = []
  if (d) lub.push({ status: base, companyStatus: d.key })
  if (przew.length) {
    const nosnik: Prisma.OrderWhereInput = przew.includes('BRAK') ? { OR: [{ carrier: { in: [...przew] } }, { carrier: null }] } : { carrier: { in: [...przew] } }
    const bezWprost: Prisma.OrderWhereInput = wazneWprost.length ? { OR: [{ companyStatus: null }, { companyStatus: { notIn: wazneWprost } }] } : {}
    lub.push({ AND: [{ status: base }, nosnik, bezWprost] })
  }
  return lub.length ? { OR: lub } : { id: '__brak__' }
}

/** Mapa „status firmy → status w kanale” z konfiguracji konta (`config.statusyFirmy`); złe wpisy pominięte. */
export function parseMapaStatusowFirmy(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw)) if (KLUCZ_STATUSU_RE.test(k) && typeof v === 'string' && STATUS_KANALU_RE.test(v.trim())) out[k] = v.trim().toLowerCase()
  return out
}

/**
 * Neutralne statusy nowej firmy (bez nazw konkretnej firmy i bez integracji): po jednym na status rdzenia, „Nowe”
 * bez grupy i cztery grupy. Firma zmienia je w Ustawienia → Statusy zamówień.
 */
export const DOMYSLNE_GRUPY_STATUSOW: readonly GrupaStatusowT[] = [
  { key: 'W_REALIZACJI', name: 'W realizacji', sortOrder: 10, collapsed: false },
  { key: 'GOTOWE', name: 'Gotowe do wysyłki', sortOrder: 20, collapsed: false },
  { key: 'ZAKONCZONE', name: 'Zakończone', sortOrder: 30, collapsed: true },
  { key: 'PROBLEMOWE', name: 'Problemowe', sortOrder: 40, collapsed: false },
]

const GRUPA_DOMYSLNA: Partial<Record<OrderStatus, string>> = {
  DO_REALIZACJI: 'W_REALIZACJI',
  ZBIERANIE: 'W_REALIZACJI',
  ZEBRANE: 'W_REALIZACJI',
  SPAKOWANE: 'GOTOWE',
  DO_WYSLANIA: 'GOTOWE',
  DO_ODBIORU: 'GOTOWE',
  WYSLANE: 'ZAKONCZONE',
  ODEBRANE: 'ZAKONCZONE',
  ANULOWANE: 'ZAKONCZONE',
  DO_WYJASNIENIA: 'PROBLEMOWE',
  REKLAMACJA: 'PROBLEMOWE',
}

const KOLEJNOSC_DOMYSLNA: readonly OrderStatus[] = ['NOWE', 'DO_REALIZACJI', 'ZBIERANIE', 'ZEBRANE', 'SPAKOWANE', 'DO_WYSLANIA', 'DO_ODBIORU', 'WYSLANE', 'ODEBRANE', 'ANULOWANE', 'DO_WYJASNIENIA', 'REKLAMACJA']

export const DOMYSLNE_STATUSY: readonly StatusFirmyT[] = KOLEJNOSC_DOMYSLNA.map((s, i) => ({
  key: s,
  name: STATUS_ZAMOWIENIA[s].etykieta,
  customerName: null,
  color: s === 'ANULOWANE' ? 'czerwony' : KOLOR_ETAPU[STATUS_ZAMOWIENIA[s].etap],
  groupKey: GRUPA_DOMYSLNA[s] ?? null,
  sortOrder: (i + 1) * 10,
  baseStatus: s,
  carriers: [],
  active: true,
}))
