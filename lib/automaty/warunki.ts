// Warunki reguł automatycznych akcji: sprawdzenie na bieżącym stanie zamówienia (nie na pamięci
// o zdarzeniu), konflikty reguł i ostrzeżenia dla ekranu. Czyste funkcje — testy w schemat.test.ts.
import type { Carrier, Channel, PaymentState } from '@prisma/client'
import { type Krok, type RegulaT, type Warunek, ZDARZENIA, KROKI } from './schemat'

/** Fakty zamówienia potrzebne warunkom (silnik ładuje je z bazy tuż przed sprawdzeniem). */
export interface FaktyWarunkow {
  channel: Channel
  channelAccountId: string
  paymentState: PaymentState
  deliveryMethod: string | null
  carrier: Carrier | null
  /** Klucz statusu firmy (albo `RDZEN:<status>`, gdy firma nie ma pasującego statusu). */
  statusFirmy: string
  totalGross: number
  /** Dni w obecnym statusie (tylko zdarzenie „w statusie określoną liczbę dni”). */
  dniWStatusie?: { kalendarzowe: number; robocze: number }
  /** Ostatni status przesyłki u przewoźnika (zdarzenie „Zmieniono status przesyłki”). */
  statusPrzesylki?: string | null
}

/** Porównanie fraz bez wielkości liter i bez polskich znaków („Paczkomaty” = „paczkomaty”, „osobisty” ≈ „Osobisty”). */
export const normalizuj = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .trim()

const zawieraFraze = (tekst: string | null | undefined, frazy: readonly string[]): boolean => {
  if (!tekst) return false
  const t = normalizuj(tekst)
  return frazy.some((f) => f && t.includes(normalizuj(f)))
}

export function spelnia(w: Warunek, f: FaktyWarunkow): boolean {
  const neg = (b: boolean, nie?: boolean) => (nie ? !b : b)
  switch (w.typ) {
    case 'zrodlo':
      return neg(
        w.wartosci.some((v) => {
          const [ch, acc] = v.split(':')
          return ch === f.channel && (!acc || acc === f.channelAccountId)
        }),
        w.nie,
      )
    case 'pobranie':
      return (f.paymentState === 'COD') === w.wartosc
    case 'oplacone':
      return (f.paymentState === 'PAID' || f.paymentState === 'COD') === w.wartosc
    case 'przesylka':
      return neg(zawieraFraze(f.deliveryMethod, w.frazy), w.nie)
    case 'przewoznik':
      return neg(w.wartosci.includes(f.carrier ?? 'BRAK'), w.nie)
    case 'status':
      return neg(w.wartosci.includes(f.statusFirmy), w.nie)
    case 'kwota':
      return (w.od === null || w.od === undefined || f.totalGross >= w.od) && (w.do === null || w.do === undefined || f.totalGross <= w.do)
    case 'dniWStatusie': {
      const d = f.dniWStatusie
      if (!d) return false
      return (w.robocze ? d.robocze : d.kalendarzowe) >= w.dni
    }
    case 'statusPrzesylki':
      return neg(zawieraFraze(f.statusPrzesylki, w.frazy), w.nie)
  }
}

export const spelniaWszystkie = (ws: readonly Warunek[], f: FaktyWarunkow): boolean => ws.every((w) => spelnia(w, f))

// ─── Opisy (pigułki na liście) ───────────────────────────────────────────────

export interface Nazwy {
  status(klucz: string): string
  zrodlo(v: string): string
  przewoznik(c: Carrier): string
}

/** Pigułka warunku: [etykieta, wartość] jak w BL („Przesyłka | Zawiera frazę | DPD, Kurier”). */
export function pigulkaWarunku(w: Warunek, n: Nazwy): { etykieta: string; wartosc: string; nie: boolean } {
  const nie = 'nie' in w && !!w.nie
  switch (w.typ) {
    case 'zrodlo':
      return { etykieta: 'Źródło', wartosc: w.wartosci.map(n.zrodlo).join(', '), nie }
    case 'pobranie':
      return { etykieta: 'Pobranie', wartosc: w.wartosc ? 'Tak' : 'Nie', nie: false }
    case 'oplacone':
      return { etykieta: 'Opłacone', wartosc: w.wartosc ? 'Tak' : 'Nie', nie: false }
    case 'przesylka':
      return { etykieta: 'Przesyłka zawiera frazę', wartosc: w.frazy.join(', '), nie }
    case 'przewoznik':
      return { etykieta: 'Przewoźnik', wartosc: w.wartosci.map((c) => n.przewoznik(c)).join(', '), nie }
    case 'status':
      return { etykieta: 'Status', wartosc: w.wartosci.map(n.status).join(', '), nie }
    case 'kwota':
      return { etykieta: 'Kwota', wartosc: `${w.od ?? 0}–${w.do ?? '∞'} zł`, nie: false }
    case 'dniWStatusie':
      return { etykieta: 'Zamówienie w statusie', wartosc: `${w.dni} ${w.robocze ? 'dni roboczych' : 'dni'}`, nie: false }
    case 'statusPrzesylki':
      return { etykieta: 'Status przesyłki', wartosc: w.frazy.join(', '), nie }
  }
}

/** Krok jako „Ustaw | Status | Do realizacji DPD”. */
export function opisKroku(a: Krok, n: Nazwy & { szablon(s: string): string }): { czasownik: string; co: string; wartosc: string } {
  const c = KROKI[a.typ].czasownik
  switch (a.typ) {
    case 'ustawStatus':
      return { czasownik: c, co: 'Status', wartosc: n.status(a.status) }
    case 'wyslijEmail':
      return { czasownik: c, co: 'E-mail', wartosc: n.szablon(a.szablon) }
    case 'wystawFakture':
      return { czasownik: c, co: 'Fakturę', wartosc: 'domyślna' }
    case 'anulujFakture':
      return { czasownik: c, co: 'Fakturę', wartosc: 'nieudaną' }
    case 'utworzPrzesylke':
      return { czasownik: c, co: 'Przesyłkę', wartosc: [a.modul ?? 'przewoźnik zamówienia', a.gabaryt ? `gabaryt ${a.gabaryt}` : null].filter(Boolean).join(', ') }
    case 'drukujEtykiete':
      return { czasownik: c, co: 'Wydruk', wartosc: 'Najnowsza etykieta' }
    case 'oznacz':
      return { czasownik: c, co: 'Gwiazdka', wartosc: a.wartosc ? 'tak' : 'nie' }
    case 'anulujZamowienie':
      return { czasownik: c, co: 'Zamówienie', wartosc: '' }
  }
}

// ─── Konflikty i ostrzeżenia ─────────────────────────────────────────────────

export interface RegulaListy extends RegulaT {
  id: string
  enabled: boolean
  /** pozycja na liście (grupa, potem kolejność w grupie): późniejsza wykonuje się później */
  pozycja: number
}

export interface Ostrzezenie {
  regulaId: string
  rodzaj: 'KONFLIKT' | 'BEZ_WARUNKOW'
  komunikat: string
  /** druga reguła konfliktu */
  zRegula?: string
}

/** Czy dwa warunki tego samego typu na pewno się wykluczają (przybliżenie: frazy bez wspólnej frazy = rozłączne). */
function rozlaczne(a: Warunek, b: Warunek): boolean {
  if (a.typ !== b.typ) return false
  switch (a.typ) {
    case 'pobranie':
    case 'oplacone':
      return a.wartosc !== (b as typeof a).wartosc
    case 'kwota': {
      const x = b as typeof a
      const aOd = a.od ?? 0
      const aDo = a.do ?? Infinity
      const bOd = x.od ?? 0
      const bDo = x.do ?? Infinity
      return aDo < bOd || bDo < aOd
    }
    case 'zrodlo':
    case 'przewoznik':
    case 'status': {
      const x = b as typeof a
      const A = new Set<string>(a.wartosci)
      const B = new Set<string>(x.wartosci)
      if (!a.nie && !x.nie) return ![...A].some((v) => B.has(v))
      if (!a.nie && x.nie) return [...A].every((v) => B.has(v))
      if (a.nie && !x.nie) return [...B].every((v) => A.has(v))
      return false
    }
    case 'przesylka':
    case 'statusPrzesylki': {
      const x = b as typeof a
      const A = new Set(a.frazy.map(normalizuj))
      const B = new Set(x.frazy.map(normalizuj))
      if (!a.nie && !x.nie) return ![...A].some((v) => B.has(v))
      if (!a.nie && x.nie) return [...A].every((v) => B.has(v))
      if (a.nie && !x.nie) return [...B].every((v) => A.has(v))
      return false
    }
    case 'dniWStatusie':
      return false
  }
}

/** Czy dwie reguły mogą zadziałać na tym samym zamówieniu (żadna para warunków nie wyklucza się na pewno). */
export function mogaSieNakladac(a: RegulaT, b: RegulaT): boolean {
  if (a.event !== b.event) return false
  for (const x of a.conditions) for (const y of b.conditions) if (rozlaczne(x, y)) return false
  return true
}

const statusyKrokow = (r: RegulaT): string[] => r.actions.filter((a): a is Extract<Krok, { typ: 'ustawStatus' }> => a.typ === 'ustawStatus').map((a) => a.status)

/**
 * Ostrzeżenia listy i zapisu: (1) dwie włączone reguły tego samego zdarzenia o nakładających się warunkach ustawiają
 * różne statusy — wykonują się obie po kolei, zostaje status reguły niżej na liście; (2) reguła bez warunków na zdarzeniu
 * masowym (działa dla każdego zamówienia). Przyciski pomijane (klika człowiek).
 */
export function ostrzezenia(reguly: readonly RegulaListy[], nazwa: (id: string) => string): Ostrzezenie[] {
  const out: Ostrzezenie[] = []
  const wl = [...reguly].filter((r) => r.enabled && r.event !== 'PRZYCISK').sort((a, b) => a.pozycja - b.pozycja)
  for (let i = 0; i < wl.length; i++) {
    const a = wl[i]!
    if (!a.conditions.length && ZDARZENIA[a.event].masowe && a.actions.some((k) => k.typ === 'ustawStatus' || k.typ === 'wyslijEmail' || k.typ === 'anulujZamowienie'))
      out.push({ regulaId: a.id, rodzaj: 'BEZ_WARUNKOW', komunikat: `Reguła bez warunków zadziała dla każdego zamówienia przy zdarzeniu „${ZDARZENIA[a.event].nazwa}”.` })
    const sa = statusyKrokow(a)
    if (!sa.length) continue
    for (let j = i + 1; j < wl.length; j++) {
      const b = wl[j]!
      const sb = statusyKrokow(b)
      if (!sb.length || !mogaSieNakladac(a, b)) continue
      if (sa.at(-1) === sb.at(-1)) continue
      const tekst = `Reguły „${nazwa(a.id)}” i „${nazwa(b.id)}” mogą zadziałać na tym samym zamówieniu i ustawiają różne statusy. Wykonają się obie, zostanie status z „${nazwa(b.id)}” (niżej na liście).`
      out.push({ regulaId: a.id, rodzaj: 'KONFLIKT', komunikat: tekst, zRegula: b.id })
      out.push({ regulaId: b.id, rodzaj: 'KONFLIKT', komunikat: tekst, zRegula: a.id })
    }
  }
  return out
}
