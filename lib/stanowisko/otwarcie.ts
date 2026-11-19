// Karta zamówienia otwarta skanem, wklejeniem albo z pola „Szukaj” listy. Czysty
// moduł (testy w otwarcie.test.ts): adres karty z informacją, po czym ją otwarto, i odczyt tej informacji na karcie.
//  - `po=<rodzaj>.<wartość>`: rodzaj n (numer zamówienia), p (numer nadania), k (kod karty), b (koszyk); wartość to
//    trafienie z bazy (rozpoznaj-kod.ts), nie surowy tekst ze schowka. Karta pokazuje baner „Otwarte po numerze 45210”.
//  - `wyniki=<adres listy>`: tylko po otwarciu z pola „Szukaj”; baner ma wtedy link „Pokaż wyniki dla »…«” do listy
//    z tą samą frazą i parametrem `skok=nie`.
//  - `skok=nie` na liście: jedyna rola to wyłączenie skoku do karty przy następnym „Szukaj” (akcje-szukaj.ts); nowe
//    wyszukiwanie go nie przenosi (lib/panel/szukaj-adres.ts), więc kolejne wyszukanie znów otwiera kartę.
import type { PrzezCo } from './rozpoznaj-kod'

const RODZAJ: Record<PrzezCo, string> = { numer: 'n', przesylka: 'p', karta: 'k', koszyk: 'b' }
const Z_RODZAJU: Record<string, PrzezCo> = { n: 'numer', p: 'przesylka', k: 'karta', b: 'koszyk' }

/** Trafienie do pokazania: numer, numer nadania, kod karty albo nazwa koszyka (litery, cyfry, „-”, „/”, „_”). */
const TRAFIENIE = /^[\p{L}\d][\p{L}\d_/-]{0,63}$/u

/** Adres listy zamówień, do którego wolno prowadzić z karty (bez innych ścieżek i hostów). */
const ADRES_LISTY = /^\/zamowienia(?:\?[^\s\\#]{0,1500})?$/

export const BEZ_SKOKU = 'skok'

export function adresOtwarcia(orderId: string, r: { przez: PrzezCo; trafienie: string }, wyniki?: string | null): string {
  const p = new URLSearchParams()
  if (TRAFIENIE.test(r.trafienie)) p.set('po', `${RODZAJ[r.przez]}.${r.trafienie}`)
  if (wyniki && ADRES_LISTY.test(wyniki)) p.set('wyniki', wyniki)
  const q = p.toString()
  return `/zamowienia/${encodeURIComponent(orderId)}${q ? `?${q}` : ''}`
}

export interface InformacjaOOtwarciu {
  tekst: string
  trafienie: string
  /** Link do listy z frazą z „Szukaj”, bez skoku do karty; null, gdy otwarto skanem albo wklejeniem. */
  wyniki: string | null
}

const TEKST: Record<PrzezCo, string> = {
  numer: 'Otwarte po numerze',
  przesylka: 'Otwarte po numerze przesyłki',
  karta: 'Otwarte po kodzie karty',
  koszyk: 'Otwarte po koszyku',
}

export function informacjaOOtwarciu(get: (k: string) => string | null): InformacjaOOtwarciu | null {
  const po = get('po')
  const m = po ? /^([npkb])\.(.+)$/u.exec(po) : null
  const przez = m ? Z_RODZAJU[m[1]!] : undefined
  if (!m || !przez || !TRAFIENIE.test(m[2]!)) return null
  const w = get('wyniki')
  const wyniki = w && ADRES_LISTY.test(w) ? `${w}${w.includes('?') ? '&' : '?'}${BEZ_SKOKU}=nie` : null
  return { tekst: `${TEKST[przez]} ${m[2]}.`, trafienie: m[2]!, wyniki }
}

/** Formularz „Szukaj” wysłany z listy otwartej linkiem „Pokaż wyniki”: bez skoku do karty. */
export function bezSkoku(powrot: string): boolean {
  return new URLSearchParams(powrot.replace(/^\?/, '').slice(0, 2000)).get(BEZ_SKOKU) === 'nie'
}
