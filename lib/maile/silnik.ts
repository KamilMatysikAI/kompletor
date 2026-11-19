// Silnik szablonów maili: parsowanie {{…}}, sprawdzenie definicji (także nadpisań z bazy, czyli danych
// nieznanego kształtu), scalanie nadpisań i renderowanie treści do bloków gotowych do układu HTML/tekstu.
// Zasada: brak zmiennej użytej jako {{x}} to błąd (BladSzablonu), nigdy pusty tekst. Zmienne opcjonalne
// wolno używać tylko w sekcji {{#x}}…{{/x}} albo w bloku z `jesli: 'x'`.
import { BladSzablonu, sprawdzUrl } from './formaty'
import type { Blok, DefinicjaSzablonu, NadpisanieSzablonu, OpisZmiennej, WierszSzczegolow } from './typy'

export type WartoscZmiennej = string | readonly string[] | null | undefined
export type Zmienne = Readonly<Record<string, WartoscZmiennej>>

/** Zmienne dostępne w każdym szablonie (z kontekstu marki). */
export const ZMIENNE_WSPOLNE: Record<string, OpisZmiennej> = {
  'sklep.nazwa': { opis: 'nazwa sklepu', wymagana: true },
  'sklep.email': { opis: 'adres do odpowiedzi', wymagana: true },
  'sklep.www': { opis: 'adres strony sklepu', wymagana: false },
  'firma.nazwa': { opis: 'nazwa firmy', wymagana: true },
  'firma.email': { opis: 'e-mail kontaktowy firmy', wymagana: false },
  'firma.telefon': { opis: 'telefon firmy', wymagana: false },
}

// ─── Parser ──────────────────────────────────────────────────────────────────

type Wezel =
  | { t: 'tekst'; s: string }
  | { t: 'zmienna'; n: string }
  | { t: 'sekcja'; n: string; odwrotna: boolean; dzieci: Wezel[] }

const ZNACZNIK = /\{\{\s*([#^/]?)\s*([A-Za-z][\w.]*)\s*\}\}/g

function parsuj(zrodlo: string, gdzie: string): Wezel[] {
  const korzen: Wezel[] = []
  const stos: { n: string; dzieci: Wezel[] }[] = [{ n: '', dzieci: korzen }]
  const dodajTekst = (s: string) => {
    if (!s) return
    if (s.includes('{{') || s.includes('}}')) throw new BladSzablonu([`${gdzie}: niepoprawny znacznik w „${s}”`])
    stos.at(-1)!.dzieci.push({ t: 'tekst', s })
  }
  let poz = 0
  for (const m of zrodlo.matchAll(ZNACZNIK)) {
    dodajTekst(zrodlo.slice(poz, m.index))
    poz = m.index + m[0].length
    const [, rodzaj, nazwa] = m as unknown as [string, string, string]
    if (rodzaj === '#' || rodzaj === '^') {
      const sekcja: Wezel = { t: 'sekcja', n: nazwa, odwrotna: rodzaj === '^', dzieci: [] }
      stos.at(-1)!.dzieci.push(sekcja)
      stos.push({ n: nazwa, dzieci: sekcja.dzieci })
    } else if (rodzaj === '/') {
      if (stos.length === 1 || stos.at(-1)!.n !== nazwa)
        throw new BladSzablonu([`${gdzie}: zamknięcie {{/${nazwa}}} bez otwarcia`])
      stos.pop()
    } else {
      stos.at(-1)!.dzieci.push({ t: 'zmienna', n: nazwa })
    }
  }
  dodajTekst(zrodlo.slice(poz))
  if (stos.length > 1) throw new BladSzablonu([`${gdzie}: niezamknięta sekcja {{#${stos.at(-1)!.n}}}`])
  return korzen
}

function obecna(v: WartoscZmiennej): boolean {
  if (v == null) return false
  return typeof v === 'string' ? v.trim() !== '' : v.length > 0
}

function renderujWezly(wezly: Wezel[], zm: Zmienne, gdzie: string): string {
  let wynik = ''
  for (const w of wezly) {
    if (w.t === 'tekst') wynik += w.s
    else if (w.t === 'zmienna') {
      const v = zm[w.n]
      if (!obecna(v)) throw new BladSzablonu([`${gdzie}: brak zmiennej „${w.n}”`])
      if (typeof v !== 'string') throw new BladSzablonu([`${gdzie}: zmienna „${w.n}” jest listą, użyj bloku lista`])
      wynik += v
    } else if (obecna(zm[w.n]) !== w.odwrotna) wynik += renderujWezly(w.dzieci, zm, gdzie)
  }
  return wynik
}

/** Renderuje jeden tekst szablonu (bez ucieczki; ucieczkę robi układ HTML). */
export function renderujTekst(zrodlo: string, zm: Zmienne, gdzie = 'szablon'): string {
  return renderujWezly(parsuj(zrodlo, gdzie), zm, gdzie)
}

// ─── Sprawdzanie definicji ───────────────────────────────────────────────────

const TYPY_BLOKOW = ['akapit', 'szczegoly', 'lista', 'przycisk', 'uwaga', 'kod'] as const

function zmienneWWezlach(wezly: Wezel[], wynik: Set<string> = new Set(), wTekscie: Set<string> = new Set()) {
  for (const w of wezly) {
    if (w.t === 'zmienna') wTekscie.add(w.n)
    if (w.t !== 'tekst') wynik.add(w.n)
    if (w.t === 'sekcja') zmienneWWezlach(w.dzieci, wynik, wTekscie)
  }
  return { wszystkie: wynik, wTekscie }
}

function czyTekst(v: unknown): v is string {
  return typeof v === 'string'
}

/**
 * Sprawdza definicję (domyślną albo po scaleniu z nadpisaniem z bazy): kształt bloków, składnię znaczników,
 * czy każda użyta zmienna jest zadeklarowana i czy listy nie są wstawiane jako tekst. Zwraca listę błędów.
 */
export function sprawdzDefinicje(def: DefinicjaSzablonu): string[] {
  const bledy: string[] = []
  const deklarowane: Record<string, OpisZmiennej> = { ...ZMIENNE_WSPOLNE, ...def.zmienne }
  const sprawdzTekst = (zrodlo: unknown, gdzie: string) => {
    if (!czyTekst(zrodlo)) {
      bledy.push(`${gdzie}: oczekiwano tekstu`)
      return
    }
    try {
      const { wszystkie, wTekscie } = zmienneWWezlach(parsuj(zrodlo, gdzie))
      for (const n of wszystkie) if (!deklarowane[n]) bledy.push(`${gdzie}: nieznana zmienna „${n}”`)
      for (const n of wTekscie) if (deklarowane[n]?.lista) bledy.push(`${gdzie}: zmienna „${n}” jest listą, użyj bloku lista`)
    } catch (e) {
      bledy.push(...(e instanceof BladSzablonu ? e.bledy : [String(e)]))
    }
  }
  const sprawdzJesli = (jesli: unknown, gdzie: string) => {
    if (jesli === undefined) return
    if (!czyTekst(jesli) || !deklarowane[jesli]) bledy.push(`${gdzie}: nieznana zmienna w „jesli”: ${String(jesli)}`)
  }
  sprawdzTekst(def.temat, 'temat')
  sprawdzTekst(def.podglad, 'podgląd')
  sprawdzTekst(def.naglowek, 'nagłówek')
  if (!Array.isArray(def.bloki) || def.bloki.length === 0) {
    bledy.push('bloki: oczekiwano niepustej listy')
    return bledy
  }
  def.bloki.forEach((b: unknown, i) => {
    const gdzie = `blok ${i + 1}`
    if (typeof b !== 'object' || b === null) return void bledy.push(`${gdzie}: oczekiwano obiektu`)
    const blok = b as Record<string, unknown>
    if (!TYPY_BLOKOW.includes(blok.typ as (typeof TYPY_BLOKOW)[number]))
      return void bledy.push(`${gdzie}: nieznany typ bloku ${String(blok.typ)}`)
    sprawdzJesli(blok.jesli, gdzie)
    switch (blok.typ) {
      case 'akapit':
      case 'uwaga':
      case 'kod':
        sprawdzTekst(blok.tekst, `${gdzie} (${blok.typ})`)
        break
      case 'przycisk':
        sprawdzTekst(blok.etykieta, `${gdzie} (przycisk, etykieta)`)
        sprawdzTekst(blok.url, `${gdzie} (przycisk, adres)`)
        break
      case 'lista': {
        const z = blok.zmienna
        if (!czyTekst(z) || !deklarowane[z]?.lista) bledy.push(`${gdzie} (lista): „${String(z)}” nie jest zmienną-listą`)
        if (blok.naglowek !== undefined) sprawdzTekst(blok.naglowek, `${gdzie} (lista, nagłówek)`)
        break
      }
      case 'szczegoly':
        if (!Array.isArray(blok.wiersze) || blok.wiersze.length === 0) {
          bledy.push(`${gdzie} (szczegóły): oczekiwano niepustej listy wierszy`)
          break
        }
        blok.wiersze.forEach((w: unknown, j) => {
          const g = `${gdzie} (szczegóły, wiersz ${j + 1})`
          if (typeof w !== 'object' || w === null) return void bledy.push(`${g}: oczekiwano obiektu`)
          const wiersz = w as Record<string, unknown>
          sprawdzTekst(wiersz.etykieta, g)
          sprawdzTekst(wiersz.wartosc, g)
          sprawdzJesli(wiersz.jesli, g)
        })
        break
    }
  })
  return bledy
}

/** Scala nadpisanie z definicją: pole po polu, puste/brak = zostaje poprzednia treść. */
export function scalNadpisanie(def: DefinicjaSzablonu, n: NadpisanieSzablonu | null | undefined): DefinicjaSzablonu {
  if (!n) return def
  const tekstLub = (v: unknown, poprzedni: string) => (typeof v === 'string' && v.trim() !== '' ? v : poprzedni)
  return {
    ...def,
    temat: tekstLub(n.temat, def.temat),
    podglad: tekstLub(n.podglad, def.podglad),
    naglowek: tekstLub(n.naglowek, def.naglowek),
    bloki: Array.isArray(n.bloki) && n.bloki.length > 0 ? n.bloki : def.bloki,
  }
}

// ─── Renderowanie ────────────────────────────────────────────────────────────

export type BlokGotowy =
  | { typ: 'akapit' | 'uwaga' | 'kod'; tekst: string }
  | { typ: 'szczegoly'; wiersze: { etykieta: string; wartosc: string }[] }
  | { typ: 'lista'; naglowek: string | null; elementy: string[] }
  | { typ: 'przycisk'; etykieta: string; url: string }

export interface TrescGotowa {
  temat: string
  podglad: string
  naglowek: string
  bloki: BlokGotowy[]
}

/**
 * Jedna linia: temat idzie do nagłówka maila, więc znaki nowej linii (wstrzyknięcie nagłówków) i pozostałe znaki
 * sterujące (C0, DEL, C1, np. NUL i BEL, które potrafią wywrócić bibliotekę wysyłki) zamieniamy na spację.
 */
function jednaLinia(s: string): string {
  return s
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function renderujTresc(def: DefinicjaSzablonu, zm: Zmienne): TrescGotowa {
  const bledy = sprawdzDefinicje(def)
  if (bledy.length) throw new BladSzablonu(bledy)
  const brakujace = Object.entries({ ...ZMIENNE_WSPOLNE, ...def.zmienne })
    .filter(([n, o]) => o.wymagana && !obecna(zm[n]))
    .map(([n]) => `brak wymaganej zmiennej „${n}”`)
  if (brakujace.length) throw new BladSzablonu(brakujace)

  const t = (zrodlo: string, gdzie: string) => renderujTekst(zrodlo, zm, gdzie)
  const bloki: BlokGotowy[] = []
  def.bloki.forEach((b: Blok, i) => {
    if (b.jesli !== undefined && !obecna(zm[b.jesli])) return
    const gdzie = `blok ${i + 1}`
    switch (b.typ) {
      case 'akapit':
      case 'uwaga':
      case 'kod': {
        const tekst = t(b.tekst, gdzie).trim()
        if (tekst) bloki.push({ typ: b.typ, tekst })
        break
      }
      case 'szczegoly': {
        const wiersze = b.wiersze
          .filter((w: WierszSzczegolow) => w.jesli === undefined || obecna(zm[w.jesli]))
          .map((w) => ({ etykieta: t(w.etykieta, gdzie).trim(), wartosc: t(w.wartosc, gdzie).trim() }))
          .filter((w) => w.wartosc !== '')
        if (wiersze.length) bloki.push({ typ: 'szczegoly', wiersze })
        break
      }
      case 'lista': {
        const v = zm[b.zmienna]
        if (!obecna(v)) throw new BladSzablonu([`${gdzie}: brak zmiennej „${b.zmienna}”`])
        const elementy = (typeof v === 'string' ? [v] : [...(v as readonly string[])]).map((e) => e.trim()).filter(Boolean)
        const naglowek = b.naglowek !== undefined ? t(b.naglowek, gdzie).trim() || null : null
        if (elementy.length) bloki.push({ typ: 'lista', naglowek, elementy })
        break
      }
      case 'przycisk': {
        const url = t(b.url, gdzie).trim()
        if (!url) break
        bloki.push({ typ: 'przycisk', etykieta: jednaLinia(t(b.etykieta, gdzie)), url: sprawdzUrl(url, gdzie) })
        break
      }
    }
  })
  return {
    temat: jednaLinia(t(def.temat, 'temat')),
    podglad: jednaLinia(t(def.podglad, 'podgląd')),
    naglowek: jednaLinia(t(def.naglowek, 'nagłówek')),
    bloki,
  }
}
