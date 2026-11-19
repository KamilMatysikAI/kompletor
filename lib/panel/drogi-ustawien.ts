// (część B): drogi „Ustawienia → Dział → Ekran” w dokumentacji, Pomocy i tekstach
// panelu. Ekrany ustawień leżą w działach (druga kolumna ustawień), więc „Ustawienia → Poczta” nie
// prowadzi już nikogo do celu. Jedno źródło: drzewo `NAWIGACJA` (działy i zakładki), nie lista w głowie.
// `bledneDrogiUstawien` sprawdza tekst (test `drogi-ustawien.test.ts` przechodzi po docs/ i kodzie), a
// `uzupelnijDzialyUstawien` dopisuje brakujący dział do starych dróg (użyte jednorazowo, zostaje dla
// kolejnych paczek). Plik bez importów serwerowych.
import { DZIALY_USTAWIEN, dzialyUstawien, type DzialUstawien } from './nawigacja'

interface Dzial {
  klucz: DzialUstawien
  nazwa: string
  zakladki: string[]
}

let drzewo: Dzial[] | null = null

/**
 * Wszystkie działy z zakładkami, jak widzi je właściciel firmy z BaseLinkerem (pełne drzewo). Liczone raz na moduł
 * drzewo jest stałe, a test dróg woła funkcje dla każdego wiersza app/ i lib/.
 */
function dzialyPelne(): Dzial[] {
  if (drzewo) return drzewo
  drzewo = liczDzialy()
  return drzewo
}

function liczDzialy(): Dzial[] {
  const wszystkieUprawnienia = new Set(['ustawienia', 'uzytkownicy'])
  const widok = dzialyUstawien({ uprawnienia: wszystkieUprawnienia, maBl: true })
  return DZIALY_USTAWIEN.map((d) => ({
    klucz: d.klucz,
    nazwa: d.nazwa,
    zakladki: widok.find((w) => w.klucz === d.klucz)?.zakladki.map((z) => z.etykieta) ?? [],
  }))
}

/**
 * Stare nazwy ekranów (albo skróty z dokumentacji) → etykieta zakładki z drzewa. Kolejność bez
 * znaczenia: dopasowanie bierze najdłuższą pasującą nazwę.
 */
const ALIASY: Record<string, string> = {
  'Użytkownicy': 'Użytkownicy i uprawnienia',
  'Kanały': 'Kanały sprzedaży',
  'Rezerwacje': 'Zasady rezerwacji',
  'Hasło': 'Zmiana hasła',
  'Przeprowadzka z BaseLinkera': 'Przeprowadzka',
  'Poczta → Szablony maili': 'Szablony maili',
  'Poczta → Szablony': 'Szablony maili',
  'Poczta → przycisk „Szablony maili”': 'Szablony maili',
}

/**
 * Ustawienia innych programów (Claude Desktop, WooCommerce, BaseLinker, wFirma, Allegro), które też mają
 * „Ustawienia → …”. Nowy obcy program z taką drogą w tekstach dopisuje się do `OBCE_PROGRAMY`.
 */
const OBCE_EKRANY = ['Zaawansowane', 'Łączniki', 'Programista']
const OBCE_PROGRAMY = /(WooCommerce|WordPress|Claude Desktop|claude\.ai|BaseLinker|wFirma|wFirmie|Allegro)\W{0,3}$/

/** Początek drogi: „Ustawienia → ” albo „Ustawieniach → ”. */
const START = /Ustawieni(?:a|ach) → /g

/** Czy w tym miejscu tekstu zaczyna się nazwa `nazwa` (cała, nie początek dłuższego słowa). */
function zaczynaSie(tekst: string, od: number, nazwa: string): boolean {
  if (!tekst.startsWith(nazwa, od)) return false
  const nast = tekst.charAt(od + nazwa.length)
  return !/[\p{L}\p{N}]/u.test(nast)
}

function najdluzsza(tekst: string, od: number, nazwy: Iterable<string>): string | null {
  let best: string | null = null
  for (const n of nazwy) if (zaczynaSie(tekst, od, n) && (!best || n.length > best.length)) best = n
  return best
}

function obcyProgram(tekst: string, start: number, od: number): boolean {
  const przed = tekst.slice(Math.max(0, start - 30), start)
  return OBCE_PROGRAMY.test(przed) || OBCE_EKRANY.some((e) => zaczynaSie(tekst, od, e))
}

export interface BlednaDroga {
  /** indeks w tekście, od którego zaczyna się „Ustawienia → ” */
  indeks: number
  fragment: string
  powod: string
}

/**
 * Drogi „Ustawienia → …” w tekście, które nie prowadzą do ekranu: brak działu po „Ustawienia”, nieznany dział albo
 * zakładka, której w tym dziale nie ma. Drogi do ustawień innych programów (WooCommerce, Claude Desktop) pomija.
 */
export function bledneDrogiUstawien(tekst: string): BlednaDroga[] {
  if (!tekst.includes('Ustawieni')) return [] // szybkie wyjście: w tekście nie ma żadnej drogi
  const dzialy = dzialyPelne()
  const nazwyDzialow = dzialy.map((d) => d.nazwa)
  const bledy: BlednaDroga[] = []
  for (const m of tekst.matchAll(START)) {
    const start = m.index ?? 0
    const od = start + m[0].length
    const fragment = tekst.slice(start, Math.min(tekst.length, od + 60)).split('\n')[0]!
    if (obcyProgram(tekst, start, od)) continue
    const nazwa = najdluzsza(tekst, od, nazwyDzialow)
    if (!nazwa) {
      bledy.push({ indeks: start, fragment, powod: 'po „Ustawienia →” brakuje nazwy działu' })
      continue
    }
    const dzial = dzialy.find((d) => d.nazwa === nazwa)!
    const po = od + nazwa.length
    if (!tekst.startsWith(' → ', po)) continue
    if (!najdluzsza(tekst, po + 3, dzial.zakladki)) {
      bledy.push({ indeks: start, fragment, powod: `w dziale „${nazwa}” nie ma takiej zakładki (są: ${dzial.zakladki.join(', ')})` })
    }
  }
  return bledy
}

/**
 * Dopisuje dział do dróg „Ustawienia → Ekran” (np. „Ustawienia → Poczta” → „Ustawienia → Komunikacja i poczta →
 * Poczta”) i zamienia stare nazwy ekranów na etykiety z drzewa. Drogi z działem i drogi innych programów zostawia.
 * Idempotentne: drugi przebieg nic nie zmienia.
 */
export function uzupelnijDzialyUstawien(tekst: string): string {
  if (!tekst.includes('Ustawieni')) return tekst
  const dzialy = dzialyPelne()
  const nazwyDzialow = dzialy.map((d) => d.nazwa)
  const dzialZakladki = new Map<string, Dzial>()
  for (const d of dzialy) for (const z of d.zakladki) dzialZakladki.set(z, d)
  const nazwy = [...dzialZakladki.keys(), ...Object.keys(ALIASY)]
  let wynik = ''
  let ostatni = 0
  for (const m of tekst.matchAll(START)) {
    const start = m.index ?? 0
    const od = start + m[0].length
    if (od < ostatni) continue
    if (obcyProgram(tekst, start, od) || najdluzsza(tekst, od, nazwyDzialow)) continue
    const stara = najdluzsza(tekst, od, nazwy)
    if (!stara) continue
    const zakladka = ALIASY[stara] ?? stara
    const dzial = dzialZakladki.get(zakladka)
    if (!dzial) continue
    wynik += tekst.slice(ostatni, od) + `${dzial.nazwa} → ${zakladka}`
    ostatni = od + stara.length
  }
  return wynik + tekst.slice(ostatni)
}
