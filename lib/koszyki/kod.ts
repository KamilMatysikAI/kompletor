// Koszyki do zbierania: nazwa koszyka i kod do skanera. Czyste funkcje — testy w kod.test.ts.
// Kod = „KOSZ-<nazwa>”: inny wzór niż kod karty zamówienia (karta ma zawsze „/<numer wydruku>”), więc czytnik
// na stanowisku rozróżnia oba bez ustawień. Nazwa: litery A–Z i cyfry, 1–8 znaków (A, B, … albo „W12”).

export const PRZEDROSTEK_KODU = 'KOSZ-'
export const MAX_NAZWY = 8
/** Najwięcej koszyków firmy (BL ma domyślnie 10; regał wózków rzadko przekracza kilkadziesiąt). */
export const MAX_KOSZYKOW = 200

/** Nazwa wpisana przez firmę → postać zapisu albo null (pusta, za długa, znaki spoza A–Z i cyfr). */
export function nazwaKoszyka(tekst: unknown): string | null {
  if (typeof tekst !== 'string') return null
  const n = tekst
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/gi, 'L')
    .toUpperCase()
    .replace(/\s+/g, '')
  return /^[A-Z0-9]{1,8}$/.test(n) ? n : null
}

export function kodKoszyka(nazwa: string): string {
  return `${PRZEDROSTEK_KODU}${nazwa}`
}

/**
 * Odczyt skanu jako kodu koszyka (z tolerancją na to, co dokleja czytnik: identyfikator AIM „]C1”, znaki sterujące,
 * spacje, małe litery). Nie koszyk = null, wtedy stanowisko próbuje kodu karty.
 */
export function odczytajKodKoszyka(tekst: string): string | null {
  if (typeof tekst !== 'string' || tekst.length > 64) return null
  const czysty = tekst
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200d\u2060\ufeff]/g, '')
    .trim()
    .replace(/^\]C\d/i, '')
    .replace(/\s+/g, '')
    .toUpperCase()
  if (!czysty.startsWith(PRZEDROSTEK_KODU)) return null
  return nazwaKoszyka(czysty.slice(PRZEDROSTEK_KODU.length))
}

/** Kolejne wolne nazwy literowe: A…Z, potem AA, AB… (pomija zajęte). */
export function kolejneNazwy(zajete: Iterable<string>, ile: number): string[] {
  const juz = new Set(zajete)
  const out: string[] = []
  const litery = (n: number): string => {
    let s = ''
    let x = n + 1
    while (x > 0) {
      const r = (x - 1) % 26
      s = String.fromCharCode(65 + r) + s
      x = Math.floor((x - 1) / 26)
    }
    return s
  }
  for (let i = 0; out.length < Math.max(0, ile) && i < 26 * 27; i++) {
    const n = litery(i)
    if (!juz.has(n)) out.push(n)
  }
  return out
}

/** Porządek koszyków na ekranie: A, B, … Z, AA (długość, potem alfabet), nazwy z cyframi naturalnie (W2 przed W10). */
export function porownajNazwy(a: string, b: string): number {
  const literowe = (s: string) => /^[A-Z]+$/.test(s)
  if (literowe(a) && literowe(b)) return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)
  return a.localeCompare(b, 'pl', { numeric: true })
}
