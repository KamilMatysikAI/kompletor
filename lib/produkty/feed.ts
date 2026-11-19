// odczyt feedu produktowego sklepu w formacie Google Merchant (RSS 2.0 `<item>` albo Atom `<entry>`, pola
// w przestrzeni nazw `http://base.google.com/ns/1.0`, zwykle z przedrostkiem `g:`). Czytamy tylko to, co służy
// zdjęciom produktów: identyfikator, MPN (SKU), GTIN (EAN), grupę wariantów, nazwę i adresy zdjęć.
//
// Parser bez biblioteki XML i bez rozwijania encji: plik z deklaracją DOCTYPE albo ENTITY odrzucamy w całości (żadnych
// encji zewnętrznych, XXE ani „billion laughs”), a w tekście rozpoznajemy tylko pięć encji XML i encje liczbowe. Funkcja
// czysta (bez sieci i bazy): bajty → pozycje. Pobranie z osłonami jest w lib/produkty/zdjecia-feed.ts.
import { MAX_Z_OFERTY } from './zdjecia-url'

export const GOOGLE_NS = 'http://base.google.com/ns/1.0'
/** Najwięcej pozycji czytanych z jednego feedu (reszta pominięta z licznikiem). */
export const FEED_MAX_POZYCJI = 100_000

export interface PozycjaFeedu {
  /** `g:id`: w WooCommerce identyfikator produktu albo wariantu w sklepie */
  id: string
  /** `g:mpn`: kod producenta; we wtyczkach feedu sklepów zwykle SKU */
  mpn?: string
  /** `g:gtin`: EAN/GTIN, bez normalizacji */
  gtin?: string
  /** `g:item_group_id`: produkt nadrzędny wariantu */
  grupa?: string
  tytul?: string
  /** `g:image_link`, potem `g:additional_image_link` (bez powtórzeń, najwyżej {@link MAX_Z_OFERTY}) */
  zdjecia: string[]
}

export interface WynikFeedu {
  format: 'rss' | 'atom'
  pozycje: PozycjaFeedu[]
  /** pozycje bez `g:id` (pominięte) */
  bezId: number
  /** ponad {@link FEED_MAX_POZYCJI} albo dłuższe niż {@link FEED_MAX_POZYCJA_ZNAKOW} znaków (pominięte) */
  ponadLimit: number
}

/** Plik nie jest feedem, który umiemy przeczytać. Komunikat dla człowieka (ekran, wynik przebiegu). */
export class BladFeedu extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BladFeedu'
  }
}

const ENCJE: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
function dekoduj(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m
    }
    return ENCJE[e.toLowerCase()] ?? m
  })
}

/** Tekst elementu: sekcje CDATA dosłownie, reszta z rozpoznanymi encjami; bez znaczników w środku; białe znaki zwinięte. */
function tekst(raw: string): string {
  let out = ''
  let i = 0
  for (;;) {
    const a = raw.indexOf('<![CDATA[', i)
    if (a < 0) {
      out += dekoduj(raw.slice(i).replace(/<[^>]*>/g, ''))
      break
    }
    out += dekoduj(raw.slice(i, a).replace(/<[^>]*>/g, ''))
    const b = raw.indexOf(']]>', a + 9)
    if (b < 0) {
      out += raw.slice(a + 9)
      break
    }
    out += raw.slice(a + 9, b)
    i = b + 3
  }
  return out.replace(/\s+/g, ' ').trim()
}

/** Bajty → tekst: kodowanie z deklaracji XML (np. ISO-8859-2), domyślnie UTF-8; BOM pominięty. */
export function dekodujBajty(bytes: Uint8Array): string {
  // UTF-16 z BOM (eksporty z Windows): BOM wygrywa z deklaracją
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes).replace(/^\uFEFF/, '')
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes).replace(/^\uFEFF/, '')
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 200))
  const enc = /<\?xml[^>]*encoding\s*=\s*["']([A-Za-z0-9._-]+)["']/i.exec(head)?.[1]
  let dec: TextDecoder
  try {
    dec = new TextDecoder(enc && !/^utf-?8$/i.test(enc) ? enc : 'utf-8')
  } catch {
    dec = new TextDecoder('utf-8')
  }
  return dec.decode(bytes).replace(/^\uFEFF/, '')
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Pozycja dłuższa niż tyle znaków jest pomijana (feed sklepu ma pozycje po kilka KB). */
export const FEED_MAX_POZYCJA_ZNAKOW = 1_000_000

/** Indeks początku `<nazwa` z białym znakiem, `>` albo `/` po nazwie (nie `<nazwa_inna`); -1 = brak. */
function otwarcie(xml: string, nazwa: string, od: number): number {
  const szukane = `<${nazwa}`
  for (let i = xml.indexOf(szukane, od); i >= 0; i = xml.indexOf(szukane, i + 1)) {
    const c = xml.charCodeAt(i + szukane.length)
    if (c === 62 /* > */ || c === 47 /* / */ || c === 32 || c === 9 || c === 10 || c === 13) return i
  }
  return -1
}

/** Indeks `</nazwa>` (także `</nazwa >`), nie `</nazwa_inna>`; -1 = brak. */
function zamkniecie(xml: string, nazwa: string, od: number): number {
  const szukane = `</${nazwa}`
  for (let i = xml.indexOf(szukane, od); i >= 0; i = xml.indexOf(szukane, i + 1)) {
    const c = xml.charCodeAt(i + szukane.length)
    if (c === 62 || c === 32 || c === 9 || c === 10 || c === 13) return i
  }
  return -1
}

/**
 * Treści kolejnych elementów `<nazwa …>…</nazwa>` (pusty `<nazwa/>` = ''), szukane `indexOf` od miejsca poprzedniego
 * dopasowania: czas liniowy także dla złośliwego pliku bez zamknięć (wyrażenie z leniwym `[\s\S]*?` byłoby kwadratowe).
 * Element bez zamknięcia kończy odczyt. Bez zagnieżdżeń tej samej nazwy (feed Google ich nie ma).
 */
export function* bloki(xml: string, nazwa: string): Generator<string> {
  let od = 0
  for (;;) {
    const a = otwarcie(xml, nazwa, od)
    if (a < 0) return
    const b = xml.indexOf('>', a)
    if (b < 0) return
    if (xml.charCodeAt(b - 1) === 47 /* / */) {
      yield ''
      od = b + 1
      continue
    }
    const c = zamkniecie(xml, nazwa, b + 1)
    if (c < 0) return
    yield xml.slice(b + 1, c)
    od = c + nazwa.length + 2
  }
}

const NIE_FEED = 'To nie jest feed produktowy Google Merchant (oczekiwany plik XML RSS 2.0 z <item> albo Atom z <entry>). Sprawdź adres: może prowadzi do strony sklepu, a nie do pliku feedu.'

/** Feed Google Merchant → pozycje. Zły albo niebezpieczny plik = {@link BladFeedu}. */
export function parsujFeed(wejscie: Uint8Array | string): WynikFeedu {
  const xml = typeof wejscie === 'string' ? wejscie.replace(/^\uFEFF/, '') : dekodujBajty(wejscie)
  // strona HTML (adres strony sklepu albo 404 zamiast pliku): najczęstszy błąd użytkownika, komunikat o adresie, a nie
  // o ochronie serwera. Tylko na początku pliku; reszta DOCTYPE dalej odrzucona niżej.
  // Początek bez deklaracji XML i komentarzy liczony liniowo (bez powtarzanej grupy z leniwym `*?` —:
  // takie wyrażenie cofało się wykładniczo przy kilkudziesięciu komentarzach na początku pliku).
  const start = xml.slice(0, 4000).replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->/g, '').trimStart()
  if (/^(<!doctype\s+html|<html[\s>])/i.test(start)) throw new BladFeedu(NIE_FEED)
  // przed czymkolwiek innym: deklaracje DTD (encje zewnętrzne, rozwijanie encji) = odmowa, nawet w komentarzu na początku
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new BladFeedu('Plik feedu zawiera deklarację DOCTYPE albo ENTITY. Takiego pliku nie czytamy (ochrona serwera); feed Google Merchant jej nie potrzebuje.')
  const root = /^<\s*(?:[\w.-]+:)?([\w.-]+)/.exec(start)?.[1]?.toLowerCase()
  const format: 'rss' | 'atom' | null = root === 'rss' ? 'rss' : root === 'feed' ? 'atom' : null
  if (!format) throw new BladFeedu(NIE_FEED)
  // przedrostek przestrzeni nazw Google z deklaracji (zwykle „g”); pola bez przedrostka w RSS tylko dla tytułu
  const pref = new RegExp(`xmlns:([\\w.-]+)\\s*=\\s*["']${escRe(GOOGLE_NS)}/?["']`).exec(xml.slice(0, 20_000))?.[1] ?? 'g'
  const element = format === 'rss' ? 'item' : 'entry'
  // pola: tylko z przedrostkiem Google; tytuł też bez przedrostka (RSS/Atom `<title>`)
  const pola = (blok: string, nazwa: string, bezPrzedrostka = false): string[] => {
    const out: string[] = []
    for (const n of bezPrzedrostka ? [`${pref}:${nazwa}`, nazwa] : [`${pref}:${nazwa}`])
      for (const t of bloki(blok, n)) {
        const v = tekst(t)
        if (v) out.push(v)
      }
    return out
  }
  const pozycje: PozycjaFeedu[] = []
  let bezId = 0
  let ponadLimit = 0
  for (const blok of bloki(xml, element)) {
    if (blok.length > FEED_MAX_POZYCJA_ZNAKOW) {
      ponadLimit++
      continue
    }
    const id = pola(blok, 'id')[0]
    if (!id) {
      bezId++
      continue
    }
    if (pozycje.length >= FEED_MAX_POZYCJI) {
      ponadLimit++
      continue
    }
    const zdjecia: string[] = []
    for (const u of [...pola(blok, 'image_link'), ...pola(blok, 'additional_image_link')]) {
      // „additional_image_link” bywa listą po przecinku (specyfikacja Google dopuszcza powtórzenie pola albo listę)
      for (const x of u.split(/,(?=\s*https?:)/)) {
        const v = x.trim()
        if (v && v.length <= 1000 && !zdjecia.includes(v) && zdjecia.length < MAX_Z_OFERTY) zdjecia.push(v)
      }
    }
    const mpn = pola(blok, 'mpn')[0]
    const gtin = pola(blok, 'gtin')[0]
    const grupa = pola(blok, 'item_group_id')[0]
    const tytul = pola(blok, 'title', true)[0]
    pozycje.push({
      id: id.slice(0, 200),
      ...(mpn ? { mpn: mpn.slice(0, 200) } : {}),
      ...(gtin ? { gtin: gtin.slice(0, 50) } : {}),
      ...(grupa ? { grupa: grupa.slice(0, 200) } : {}),
      ...(tytul ? { tytul: tytul.slice(0, 200) } : {}),
      zdjecia,
    })
  }
  return { format, pozycje, bezId, ponadLimit }
}
