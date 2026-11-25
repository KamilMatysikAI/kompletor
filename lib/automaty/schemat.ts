// Automatyczne akcje firmy: schemat reguły „zdarzenie → warunki → kroki”, jak „Automatyczne akcje”
// w BaseLinkerze. Jedno miejsce opisu i walidacji zdarzeń, warunków i kroków: ekran, API, preset i silnik czytają
// tylko stąd. Reguła to dane (JSON w AutomationRule), żadnego dowolnego kodu: każdy warunek i każdy krok ma typ z listy
// i pola sprawdzane tu. Czyste funkcje — testy w schemat.test.ts.
//
// Dlaczego osobny moduł, a nie lib/akcje: lib/akcje to plan maili (reguły poziomowe w kodzie), a tu jest
// edytowalna konfiguracja firmy. Krok „wyślij e-mail” korzysta z planu maili (te same tryby SUCHO/PRACA i poczta firmy).
import type { Carrier, Channel, OrderStatus } from '@prisma/client'
import { canTransition } from '@/lib/rdzen/statusy'

// ─── Zdarzenia ───────────────────────────────────────────────────────────────

export const ZDARZENIA = {
  OPLACONO: { nazwa: 'Zamówienie zostało opłacone', opis: 'Płatność za zamówienie przyszła (także opłacone od razu przy przyjęciu).', masowe: true },
  POBRANO: { nazwa: 'Pobrano zamówienie', opis: 'Nowe zamówienie przyszło ze sklepu, z panelu albo przez API.', masowe: true },
  USTAWIONO_STATUS: { nazwa: 'Ustawiono status', opis: 'Status zamówienia się zmienił (ręcznie, na stanowisku albo przez inną regułę).', masowe: true },
  ROZPOCZETO_ZBIERANIE: { nazwa: 'Rozpoczęto zbieranie produktów zamówienia', opis: 'Wydrukowano kartę zbierania albo zaczęto zbieranie na stanowisku.', masowe: true },
  ZEBRANO: { nazwa: 'Zebrano produkty zamówienia', opis: 'Wszystkie produkty zebrane, zamówienie czeka na pakowanie.', masowe: true },
  SPAKOWANO: { nazwa: 'Spakowano zamówienie', opis: 'Zamówienie spakowane na stanowisku pakowania.', masowe: true },
  UTWORZONO_PRZESYLKE: { nazwa: 'Utworzono przesyłkę', opis: 'Przesyłka u przewoźnika powstała i ma numer.', masowe: true },
  STATUS_PRZESYLKI: { nazwa: 'Zmieniono status przesyłki u kuriera', opis: 'Przewoźnik podał nowy status przesyłki (śledzenie przesyłek).', masowe: true },
  W_STATUSIE_DNI: { nazwa: 'Zamówienie w statusie określoną liczbę dni', opis: 'Zamówienie stoi w statusie dłużej niż podana liczba dni (sprawdzane co kwadrans).', masowe: true },
  BLAD_FAKTURY: { nazwa: 'Błąd przy wystawianiu faktury', opis: 'Program do faktur odrzucił fakturę zamówienia.', masowe: false },
  ANULOWANO: { nazwa: 'Anulowano zamówienie', opis: 'Zamówienie anulowane (w sklepie, w panelu albo po terminie płatności).', masowe: false },
  PRZYCISK: { nazwa: 'Kliknięto przycisk', opis: 'Osoba kliknęła przycisk reguły na karcie zamówienia albo na stanowisku pakowania.', masowe: false },
} as const satisfies Record<string, { nazwa: string; opis: string; masowe: boolean }>

export type Zdarzenie = keyof typeof ZDARZENIA
export const LISTA_ZDARZEN = Object.keys(ZDARZENIA) as Zdarzenie[]
export const isZdarzenie = (v: unknown): v is Zdarzenie => typeof v === 'string' && Object.hasOwn(ZDARZENIA, v)

/** Status rdzenia, w którym zamówienie jest zaraz po zdarzeniu (do sprawdzenia, czy krok „ustaw status” ma sens). */
export const ETAP_PO_ZDARZENIU: Partial<Record<Zdarzenie, OrderStatus>> = {
  ROZPOCZETO_ZBIERANIE: 'ZBIERANIE',
  ZEBRANO: 'ZEBRANE',
  SPAKOWANO: 'SPAKOWANE',
  ANULOWANO: 'ANULOWANE',
}

// ─── Warunki ─────────────────────────────────────────────────────────────────

/** Kanały sprzedaży jako źródło (bez kont): `ALLEGRO` = dowolne konto Allegro, `ALLEGRO:<konto>` = jedno konto. */
export const KANALY_ZRODLA: readonly Channel[] = ['WOO', 'ALLEGRO', 'EMPIK', 'SHOPER', 'PRESTASHOP', 'EASYTOOLS', 'BL_INNE', 'RECZNE']
export const PRZEWOZNICY_WARUNKU: readonly Carrier[] = ['PACZKOMATY', 'INPOST_KURIER', 'DPD', 'DPD_EMPIK', 'ORLEN_PACZKA', 'GLS', 'POCZTA_POLSKA', 'ALLEGRO', 'OSOBISTY', 'BEZ_WYSYLKI', 'BRAK']

export type Warunek =
  | { typ: 'zrodlo'; nie?: boolean; wartosci: string[] }
  | { typ: 'pobranie'; wartosc: boolean }
  | { typ: 'oplacone'; wartosc: boolean }
  | { typ: 'przesylka'; nie?: boolean; frazy: string[] }
  | { typ: 'przewoznik'; nie?: boolean; wartosci: Carrier[] }
  | { typ: 'status'; nie?: boolean; wartosci: string[] }
  | { typ: 'kwota'; od?: number | null; do?: number | null }
  | { typ: 'dniWStatusie'; dni: number; robocze: boolean }
  | { typ: 'statusPrzesylki'; nie?: boolean; frazy: string[] }

export type TypWarunku = Warunek['typ']

export const WARUNKI: Record<TypWarunku, { nazwa: string; negacja: boolean; opis: string }> = {
  zrodlo: { nazwa: 'Źródło', negacja: true, opis: 'Kanał sprzedaży albo jedno konto (sklep) zamówienia.' },
  pobranie: { nazwa: 'Pobranie', negacja: false, opis: 'Płatność przy odbiorze: tak albo nie.' },
  oplacone: { nazwa: 'Opłacone', negacja: false, opis: 'Zamówienie opłacone (pobranie liczy się jak opłacone).' },
  przesylka: { nazwa: 'Przesyłka zawiera frazę', negacja: true, opis: 'Nazwa metody dostawy ze sklepu zawiera jedną z fraz (wielkość liter bez znaczenia).' },
  przewoznik: { nazwa: 'Przewoźnik', negacja: true, opis: 'Przewoźnik wyznaczony dla zamówienia (Ustawienia → Wysyłka i druk → Przewoźnicy).' },
  status: { nazwa: 'Status', negacja: true, opis: 'Bieżący status zamówienia (statusy firmy).' },
  kwota: { nazwa: 'Kwota zamówienia', negacja: false, opis: 'Kwota brutto od–do (zł).' },
  dniWStatusie: { nazwa: 'Zamówienie w statusie', negacja: false, opis: 'Ile dni (roboczych albo kalendarzowych) zamówienie stoi w obecnym statusie.' },
  statusPrzesylki: { nazwa: 'Status przesyłki u kuriera', negacja: true, opis: 'Ostatni status przesyłki od przewoźnika zawiera jedną z fraz.' },
}

// ─── Kroki ───────────────────────────────────────────────────────────────────

/** Szablony maili do zamówienia (lib/maile), które krok „wyślij e-mail” może zaplanować. */
export const SZABLONY_MAILI = {
  'brak-platnosci': { nazwa: 'Brak płatności', regula: 'mail.brak-platnosci' },
  faktura: { nazwa: 'Faktura', regula: 'mail.faktura' },
  'gotowe-do-odbioru': { nazwa: 'Gotowe do odbioru', regula: 'mail.gotowe-do-odbioru' },
  'blad-faktury': { nazwa: 'Błąd przy wystawianiu faktury (do biura)', regula: 'mail.blad-faktury' },
} as const
export type SzablonMaila = keyof typeof SZABLONY_MAILI
export const isSzablonMaila = (v: unknown): v is SzablonMaila => typeof v === 'string' && Object.hasOwn(SZABLONY_MAILI, v)

export const ZNACZNIKI = { gwiazdka: 'Gwiazdka' } as const
export type Znacznik = keyof typeof ZNACZNIKI

export type Krok =
  | { typ: 'ustawStatus'; status: string }
  | { typ: 'wyslijEmail'; szablon: SzablonMaila }
  | { typ: 'wystawFakture' }
  | { typ: 'anulujFakture' }
  | { typ: 'utworzPrzesylke'; modul?: string | null; gabaryt?: string | null }
  | { typ: 'drukujEtykiete'; stanowisko?: string | null }
  | { typ: 'oznacz'; znacznik: Znacznik; wartosc: boolean }
  | { typ: 'anulujZamowienie' }

export type TypKroku = Krok['typ']

export const KROKI: Record<TypKroku, { nazwa: string; czasownik: string; opis: string }> = {
  ustawStatus: { nazwa: 'Ustaw status', czasownik: 'Ustaw', opis: 'Status firmy; zmiana etapu tylko tam, gdzie wolno przejść z obecnego.' },
  wyslijEmail: { nazwa: 'Wyślij e-mail', czasownik: 'Wyślij', opis: 'Mail z szablonu przez pocztę firmy (konto sklepu w podglądzie: tylko zapis „wysłałbym”). Tej samej faktury automat nie wysyła drugi raz; ponowna wysyłka „Faktury” idzie z przycisku reguły.' },
  wystawFakture: { nazwa: 'Wystaw fakturę', czasownik: 'Stwórz', opis: 'Faktura przez kolejkę faktur (gdy wystawianie faktur jest włączone).' },
  anulujFakture: { nazwa: 'Anuluj fakturę', czasownik: 'Anuluj', opis: 'Nieudana faktura wraca do poprawienia; wystawionej faktury reguła nie cofa.' },
  utworzPrzesylke: { nazwa: 'Utwórz przesyłkę', czasownik: 'Stwórz', opis: 'Przesyłka u przewoźnika zamówienia (gdy nadawanie jest włączone w ustawieniach przewoźnika).' },
  drukujEtykiete: { nazwa: 'Wydrukuj etykietę', czasownik: 'Wydrukuj', opis: 'Najnowsza etykieta przesyłki na stanowisku druku; przy odbiorze osobistym etykieta odbioru do naklejenia na paczkę.' },
  oznacz: { nazwa: 'Oznacz zamówienie', czasownik: 'Ustaw', opis: 'Gwiazdka na liście zamówień.' },
  anulujZamowienie: { nazwa: 'Anuluj zamówienie', czasownik: 'Anuluj', opis: 'Anulowanie przez system (bez anulowania po fakturze).' },
}

export const MIEJSCA_PRZYCISKU = { karta: 'Karta zamówienia', pakowanie: 'Stanowisko pakowania' } as const
export type MiejscePrzycisku = keyof typeof MIEJSCA_PRZYCISKU

// ─── Reguła ──────────────────────────────────────────────────────────────────

export interface RegulaT {
  name: string
  event: Zdarzenie
  conditions: Warunek[]
  actions: Krok[]
  buttonLabel?: string | null
  buttonPlaces?: MiejscePrzycisku[]
  /** opis dla zespołu (np. powód wyłączenia), bez wpływu na wykonanie */
  description?: string | null
}

export const LIMITY = { nazwa: 80, opis: 300, warunkow: 12, krokow: 8, wartosci: 30, fraza: 60, przycisk: 40, dni: 365, regul: 300, grup: 30 } as const

/** Najdłuższy łańcuch „ustawiono status → ustaw status” (bezpiecznik pętli). */
export const LIMIT_LANCUCHA = 5

export interface BladReguly {
  pole: string
  komunikat: string
}

/** Kontekst walidacji: statusy firmy (klucz → status rdzenia). */
export interface KontekstWalidacji {
  statusy: ReadonlyMap<string, OrderStatus>
}

const ZRODLO_RE = /^[A-Z]+(:[A-Za-z0-9_.@-]{1,60})?$/
const KLUCZ_RE = /^[A-Za-z0-9_.:-]{1,60}$/

const tekst = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null)
const lista = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : null)

/**
 * Normalizacja + walidacja reguły z dowolnych danych (formularz, API, preset). Zwraca regułę albo listę błędów;
 * nieznane pola są odrzucane (do bazy idzie tylko to, co zna schemat).
 */
export function parsujRegule(raw: unknown, k: KontekstWalidacji): { ok: true; regula: RegulaT } | { ok: false; bledy: BladReguly[] } {
  const bledy: BladReguly[] = []
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const name = tekst(r.name, LIMITY.nazwa)
  if (!name) bledy.push({ pole: 'nazwa', komunikat: `Podaj nazwę reguły (najwyżej ${LIMITY.nazwa} znaków).` })
  const event = isZdarzenie(r.event) ? r.event : null
  if (!event) bledy.push({ pole: 'zdarzenie', komunikat: 'Wybierz zdarzenie.' })
  const conditions: Warunek[] = []
  const surWar = lista(r.conditions) ?? []
  if (surWar.length > LIMITY.warunkow) bledy.push({ pole: 'warunki', komunikat: `Najwyżej ${LIMITY.warunkow} warunków.` })
  surWar.slice(0, LIMITY.warunkow).forEach((w, i) => {
    const x = parsujWarunek(w, k)
    if (typeof x === 'string') bledy.push({ pole: `warunek-${i}`, komunikat: x })
    else conditions.push(x)
  })
  const actions: Krok[] = []
  const surKr = lista(r.actions) ?? []
  if (!surKr.length) bledy.push({ pole: 'kroki', komunikat: 'Dodaj co najmniej jeden krok.' })
  if (surKr.length > LIMITY.krokow) bledy.push({ pole: 'kroki', komunikat: `Najwyżej ${LIMITY.krokow} kroków.` })
  surKr.slice(0, LIMITY.krokow).forEach((a, i) => {
    const x = parsujKrok(a, k)
    if (typeof x === 'string') bledy.push({ pole: `krok-${i}`, komunikat: x })
    else actions.push(x)
  })
  let buttonLabel: string | null = null
  let buttonPlaces: MiejscePrzycisku[] = []
  if (event === 'PRZYCISK') {
    buttonLabel = tekst(r.buttonLabel, LIMITY.przycisk) ?? name
    if (!buttonLabel) bledy.push({ pole: 'przycisk', komunikat: 'Podaj napis na przycisku.' })
    buttonPlaces = (lista(r.buttonPlaces) ?? []).filter((m): m is MiejscePrzycisku => typeof m === 'string' && Object.hasOwn(MIEJSCA_PRZYCISKU, m))
    buttonPlaces = [...new Set(buttonPlaces)]
    if (!buttonPlaces.length) bledy.push({ pole: 'przycisk', komunikat: 'Wybierz, gdzie widać przycisk (karta zamówienia, stanowisko pakowania).' })
  }
  if (event) {
    const dni = conditions.filter((c) => c.typ === 'dniWStatusie')
    if (event === 'W_STATUSIE_DNI') {
      if (dni.length !== 1) bledy.push({ pole: 'warunki', komunikat: 'Zdarzenie „w statusie określoną liczbę dni” potrzebuje jednego warunku „Zamówienie w statusie” (liczba dni).' })
      if (!conditions.some((c) => c.typ === 'status' && !c.nie)) bledy.push({ pole: 'warunki', komunikat: 'Wskaż status, w którym zamówienie ma stać (warunek „Status”).' })
    } else if (dni.length) bledy.push({ pole: 'warunki', komunikat: 'Warunek „Zamówienie w statusie” działa tylko ze zdarzeniem „w statusie określoną liczbę dni”.' })
    if (event !== 'STATUS_PRZESYLKI' && conditions.some((c) => c.typ === 'statusPrzesylki'))
      bledy.push({ pole: 'warunki', komunikat: 'Warunek „Status przesyłki u kuriera” działa tylko ze zdarzeniem „Zmieniono status przesyłki u kuriera”.' })
  }
  const opisSur = typeof r.description === 'string' ? r.description.trim() : ''
  if (opisSur.length > LIMITY.opis) bledy.push({ pole: 'opis', komunikat: `Opis może mieć najwyżej ${LIMITY.opis} znaków.` })
  const description = opisSur && opisSur.length <= LIMITY.opis ? opisSur : null
  if (bledy.length || !name || !event) return { ok: false, bledy }
  const regula: RegulaT = { name, event, conditions, actions, buttonLabel, buttonPlaces, description }
  const nigdy = krokiNigdyDozwolone(regula, k)
  for (const n of nigdy) bledy.push({ pole: `krok-${n.krok}`, komunikat: n.komunikat })
  return bledy.length ? { ok: false, bledy } : { ok: true, regula }
}

function parsujWarunek(raw: unknown, k: KontekstWalidacji): Warunek | string {
  const w = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const nie = w.nie === true
  const wartosci = (lista(w.wartosci) ?? []).filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean)
  const frazy = (lista(w.frazy) ?? []).filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean)
  switch (w.typ) {
    case 'zrodlo':
      if (!wartosci.length) return 'Wybierz co najmniej jedno źródło.'
      if (wartosci.length > LIMITY.wartosci) return `Najwyżej ${LIMITY.wartosci} źródeł.`
      for (const v of wartosci) if (!ZRODLO_RE.test(v) || !KANALY_ZRODLA.includes(v.split(':')[0] as Channel)) return `Nieznane źródło: ${v}`
      return { typ: 'zrodlo', nie, wartosci: [...new Set(wartosci)] }
    case 'pobranie':
    case 'oplacone':
      if (typeof w.wartosc !== 'boolean') return 'Wybierz „tak” albo „nie”.'
      return { typ: w.typ, wartosc: w.wartosc }
    case 'przesylka':
    case 'statusPrzesylki':
      if (!frazy.length) return 'Wpisz co najmniej jedną frazę.'
      if (frazy.length > LIMITY.wartosci) return `Najwyżej ${LIMITY.wartosci} fraz.`
      if (frazy.some((f) => f.length > LIMITY.fraza)) return `Fraza może mieć najwyżej ${LIMITY.fraza} znaków.`
      return { typ: w.typ, nie, frazy: [...new Set(frazy)] }
    case 'przewoznik':
      if (!wartosci.length) return 'Wybierz co najmniej jednego przewoźnika.'
      for (const v of wartosci) if (!PRZEWOZNICY_WARUNKU.includes(v as Carrier)) return `Nieznany przewoźnik: ${v}`
      return { typ: 'przewoznik', nie, wartosci: [...new Set(wartosci)] as Carrier[] }
    case 'status':
      if (!wartosci.length) return 'Wybierz co najmniej jeden status.'
      for (const v of wartosci) if (!k.statusy.has(v)) return `Nieznany status: ${v}`
      return { typ: 'status', nie, wartosci: [...new Set(wartosci)] }
    case 'kwota': {
      const liczba = (v: unknown) => (v === null || v === undefined || v === '' ? null : typeof v === 'number' ? v : Number(String(v).replace(',', '.')))
      const od = liczba(w.od)
      const do_ = liczba(w.do)
      if ((od !== null && (!Number.isFinite(od) || od < 0)) || (do_ !== null && (!Number.isFinite(do_) || do_ < 0))) return 'Kwota musi być liczbą nie mniejszą niż 0.'
      if (od === null && do_ === null) return 'Podaj kwotę od albo do.'
      if (od !== null && do_ !== null && od > do_) return 'Kwota „od” jest większa niż „do”.'
      return { typ: 'kwota', od, do: do_ }
    }
    case 'dniWStatusie': {
      const dni = typeof w.dni === 'number' ? w.dni : Number(w.dni)
      if (!Number.isInteger(dni) || dni < 1 || dni > LIMITY.dni) return `Liczba dni: od 1 do ${LIMITY.dni}.`
      return { typ: 'dniWStatusie', dni, robocze: w.robocze !== false }
    }
    default:
      return 'Nieznany rodzaj warunku.'
  }
}

function parsujKrok(raw: unknown, k: KontekstWalidacji): Krok | string {
  const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  switch (a.typ) {
    case 'ustawStatus':
      if (typeof a.status !== 'string' || !k.statusy.has(a.status)) return 'Wybierz status do ustawienia.'
      return { typ: 'ustawStatus', status: a.status }
    case 'wyslijEmail':
      if (!isSzablonMaila(a.szablon)) return 'Wybierz szablon maila.'
      return { typ: 'wyslijEmail', szablon: a.szablon }
    case 'wystawFakture':
    case 'anulujFakture':
    case 'anulujZamowienie':
      return { typ: a.typ }
    case 'utworzPrzesylke': {
      const modul = typeof a.modul === 'string' && a.modul.trim() ? a.modul.trim() : null
      const gabaryt = typeof a.gabaryt === 'string' && a.gabaryt.trim() ? a.gabaryt.trim() : null
      if ((modul && !KLUCZ_RE.test(modul)) || (gabaryt && !KLUCZ_RE.test(gabaryt))) return 'Zły moduł albo gabaryt przesyłki.'
      return { typ: 'utworzPrzesylke', modul, gabaryt }
    }
    case 'drukujEtykiete': {
      const st = typeof a.stanowisko === 'string' && a.stanowisko.trim() ? a.stanowisko.trim() : null
      if (st && !/^[a-z0-9]{1,40}$/i.test(st)) return 'Złe stanowisko druku.'
      return { typ: 'drukujEtykiete', stanowisko: st }
    }
    case 'oznacz':
      if (typeof a.znacznik !== 'string' || !Object.hasOwn(ZNACZNIKI, a.znacznik)) return 'Wybierz znacznik.'
      return { typ: 'oznacz', znacznik: a.znacznik as Znacznik, wartosc: a.wartosc !== false }
    default:
      return 'Nieznany rodzaj kroku.'
  }
}

// ─── Dozwolone przejścia (bezpiecznik „ustaw status”) ────────────────────────

/** Cofnięcia pomyłek, które rdzeń dopuszcza bez ruszania rezerwacji (lib/praca/status-dowolny.ts `COFNIECIA`). */
const COFNIECIA: Partial<Record<OrderStatus, OrderStatus[]>> = {
  WYSLANE: ['DO_WYSLANIA'],
  ODEBRANE: ['WYSLANE', 'DO_ODBIORU'],
  DO_WYSLANIA: ['SPAKOWANE'],
  DO_ODBIORU: ['SPAKOWANE'],
  ZEBRANE: ['DO_REALIZACJI'],
  REKLAMACJA: ['WYSLANE', 'ODEBRANE'],
}

/**
 * Czy reguła w ogóle może przestawić etap rdzenia `z` → `na` (bez faktów zamówienia; fakty sprawdza wykonanie).
 * Ten sam etap = sama zmiana nazwy statusu (zawsze wolno). Inaczej tylko drogi, które rdzeń daje ekranom: przejście
 * z tabeli (`canTransition`) bez spakowania (zamyka braki), bez opłacenia (NOWE → Do realizacji robi płatność) i bez
 * wyjścia z „Do wyjaśnienia” innego niż anulowanie, albo cofnięcie pomyłki.
 */
export function przejscieMozliwe(z: OrderStatus, na: OrderStatus): boolean {
  if (z === na) return true
  if ((COFNIECIA[z] ?? []).includes(na)) return true
  if (!canTransition(z, na)) return false
  if (na === 'SPAKOWANE') return false
  if (na === 'DO_REALIZACJI') return z === 'ZBIERANIE'
  return true
}

export { COFNIECIA as COFNIECIA_AUTOMATU }

/**
 * Kroki „ustaw status”, które przy warunkach reguły nigdy nie przejdą: etap(y) zamówienia znane z warunku „Status”
 * (bez „nie”) albo ze zdarzenia (np. „Zebrano” = Zebrane), a z żadnego z nich nie ma drogi do etapu statusu kroku.
 * Etap nieznany (brak warunku statusu i zdarzenie bez etapu) = nie blokujemy (sprawdzi wykonanie).
 */
export function krokiNigdyDozwolone(r: RegulaT, k: KontekstWalidacji): { krok: number; komunikat: string }[] {
  const zWarunku = r.conditions.find((c): c is Extract<Warunek, { typ: 'status' }> => c.typ === 'status' && !c.nie)
  let etapy: OrderStatus[] | null = zWarunku ? [...new Set(zWarunku.wartosci.map((s) => k.statusy.get(s)!).filter(Boolean))] : null
  if (!etapy && ETAP_PO_ZDARZENIU[r.event]) etapy = [ETAP_PO_ZDARZENIU[r.event]!]
  const out: { krok: number; komunikat: string }[] = []
  r.actions.forEach((a, i) => {
    if (a.typ !== 'ustawStatus' || !etapy?.length) return
    const na = k.statusy.get(a.status)
    if (!na) return
    if (!etapy.some((z) => przejscieMozliwe(z, na)))
      out.push({ krok: i, komunikat: `Tego statusu reguła nigdy nie ustawi: z etapu zamówienia z warunku nie ma przejścia do tego etapu (Kompletor pilnuje kolejności etapów).` })
  })
  return out
}
