// Regulamin Allegro dla tytułu i opisu oferty. Port ze skilla allegro-oferty:
// - `SKILL.md` „Regulamin Allegro 2026 — co wykluczyć” (linki, e-mail, telefon, CTA, CAPS, emoji, `!` i `@ [ ]` w tytule,
//   słowa marketingowe „darmo”, „taniej”, „hit”);
// - `scripts/description_builder.py`: `sanitize_allegro_html` (biała lista tagów p, b, h1, h2, ul, ol, li bez atrybutów,
//   <strong> → <b>, <br> → spacja) i `validate_desc_data` (tytuł 12–75 znaków, CAPS > 80% liter w słowie dłuższym niż
//   3 litery, wzorce bez polskich znaków, regexy URL/e-mail/telefon/emoji, lista CTA);
// - `references/offer-template.md`: słowa „TANIO”, „OKAZJA”, „PROMOCJA”, „SUPER” w tytule.
// Różnice wobec skilla: naruszenia regulaminu są błędami (skill tylko ostrzegał), tytuł za długi nie jest po cichu
// ucinany do 75 znaków, emoji „✅” z offer-template.md (marzec 2026) wypada — późniejszy regulamin 2026 w SKILL.md
// zakazuje emoji. Listy słów są danymi (firma może je rozszerzyć), nie stałymi jednej firmy.
import { bezOgonkow, escapeHtml, tekstZHtml } from './tekst'
import type { ProblemOferty } from './typy'

export const TYTUL_ALLEGRO_MAX = 75
export const TYTUL_ALLEGRO_MIN = 12

export interface ZasadyRegulaminu {
  /** Wezwania do wyjścia poza Allegro — błąd (Allegro usuwa takie oferty). */
  frazyZakazane: string[]
  /** Słowa marketingowe (keyword stuffing) — ostrzeżenie. `*` na końcu = także dłuższe słowa (np. „darmo*”). */
  slowaMarketingowe: string[]
  /** Fragmenty słów zapisanych bez polskich znaków (np. „lisciasta”) — ostrzeżenie. */
  bezPolskichZnakow: string[]
}

export const DOMYSLNE_ZASADY_REGULAMINU: ZasadyRegulaminu = {
  frazyZakazane: [
    'zapraszamy',
    'sprawdź inne',
    'odwiedź nasz',
    'zobacz inne oferty',
    'sprawdź nasz sklep',
    'polub nas',
    'śledź nas',
    'wejdź na naszą stronę',
    'więcej na naszej',
  ],
  slowaMarketingowe: ['darmo*', 'taniej', 'tanio', 'hit', 'okazja', 'promocja', 'super'],
  // skill miał też „zdrow” — wypada, bo „zdrowie”/„zdrowy” piszą się bez ogonków (fałszywy alarm)
  bezPolskichZnakow: ['lisciasta', 'wyjatkow', 'zywnosc', 'ziola'],
}

const URL_RE = /(https?:\/\/|www\.)\S+/i
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/
const TELEFON_RE = /(\+?48[\s-]?)?\b\d{3}[\s-]?\d{3}[\s-]?\d{3}\b/
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/u
const ESC = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function slowoRe(slowo: string): RegExp {
  const prefiks = slowo.endsWith('*')
  const rdzen = ESC(bezOgonkow(prefiks ? slowo.slice(0, -1) : slowo))
  return new RegExp(`(?<![\\p{L}\\d])${rdzen}${prefiks ? '' : '(?![\\p{L}\\d])'}`, 'u')
}

/** Tytuł w postaci, jaką wysyłał skill: długie myślniki → „-”, pojedyncze spacje. Nie ucina. */
export function poprawTytulAllegro(t: string): string {
  return (t ?? '').replace(/[—–]/g, '-').replace(/\s+/g, ' ').trim()
}

/** Słowo pisane wersalikami jako podkreślenie: > 80% wielkich liter i więcej niż 3 litery (jak skill). */
function slowoCaps(tekst: string): string | null {
  for (const w of tekst.split(/\s+/)) {
    const litery = [...w].filter((c) => /\p{L}/u.test(c))
    if (litery.length > 3 && litery.filter((c) => c === c.toUpperCase() && c !== c.toLowerCase()).length / litery.length > 0.8) return w
  }
  return null
}

/** Reguły wspólne dla tytułu i treści: link, e-mail, telefon, emoji, CTA, słowa marketingowe, brak ogonków. */
export function sprawdzTekstAllegro(pole: string, tekst: string, zasady: ZasadyRegulaminu = DOMYSLNE_ZASADY_REGULAMINU): ProblemOferty[] {
  const out: ProblemOferty[] = []
  if (!tekst) return out
  const blad = (kod: string, komunikat: string) => out.push({ kod, waga: 'blad', komunikat, pole })
  const ostrz = (kod: string, komunikat: string) => out.push({ kod, waga: 'ostrzezenie', komunikat, pole })
  if (URL_RE.test(tekst)) blad('link', 'Zawiera link albo adres strony — Allegro usuwa oferty z linkami.')
  if (EMAIL_RE.test(tekst)) blad('email', 'Zawiera adres e-mail — Allegro tego zabrania.')
  if (TELEFON_RE.test(tekst)) blad('telefon', 'Zawiera numer telefonu — Allegro tego zabrania.')
  if (EMOJI_RE.test(tekst)) blad('emoji', 'Zawiera emoji — Allegro tego zabrania.')
  const norm = bezOgonkow(tekst)
  const fraza = zasady.frazyZakazane.find((f) => norm.includes(bezOgonkow(f)))
  if (fraza) blad('wezwanie_poza_allegro', `Zawiera zachętę „${fraza}” — Allegro zabrania odsyłania do sklepu i innych ofert.`)
  const slowo = zasady.slowaMarketingowe.find((s) => slowoRe(s).test(norm))
  if (slowo) ostrz('slowo_marketingowe', `Zawiera słowo „${slowo.replace(/\*$/, '')}” — Allegro traktuje takie słowa jak upychanie fraz.`)
  const bezOg = zasady.bezPolskichZnakow.find((p) => tekst.toLowerCase().includes(p))
  if (bezOg) ostrz('bez_polskich_znakow', `Możliwy brak polskich znaków: „${bezOg}”.`)
  return out
}

/** Tytuł: długość 12–75, bez `!`, `@ [ ]`, bez CAPS, plus reguły treści. */
export function sprawdzTytulAllegro(tytul: string, zasady: ZasadyRegulaminu = DOMYSLNE_ZASADY_REGULAMINU): ProblemOferty[] {
  const t = tytul ?? ''
  const out: ProblemOferty[] = []
  const pole = 'tytul'
  const dl = [...t].length
  if (dl === 0) out.push({ kod: 'tytul_pusty', waga: 'blad', komunikat: 'Oferta nie ma tytułu.', pole })
  else if (dl < TYTUL_ALLEGRO_MIN) out.push({ kod: 'tytul_krotki', waga: 'ostrzezenie', komunikat: `Tytuł jest krótki (${dl} znaków, zalecane co najmniej ${TYTUL_ALLEGRO_MIN}).`, pole })
  if (dl > TYTUL_ALLEGRO_MAX) out.push({ kod: 'tytul_dlugi', waga: 'blad', komunikat: `Tytuł ma ${dl} znaków, Allegro przyjmuje najwyżej ${TYTUL_ALLEGRO_MAX}.`, pole })
  if (t.includes('!')) out.push({ kod: 'tytul_wykrzyknik', waga: 'blad', komunikat: 'Tytuł zawiera wykrzyknik — Allegro tego zabrania.', pole })
  if (/[@[\]]/.test(t)) out.push({ kod: 'tytul_znaki', waga: 'blad', komunikat: 'Tytuł zawiera znaki @ [ ] — Allegro tego zabrania.', pole })
  const caps = slowoCaps(t)
  if (caps) out.push({ kod: 'tytul_caps', waga: 'blad', komunikat: `Słowo „${caps}” jest pisane wielkimi literami — Allegro tego zabrania.`, pole })
  return [...out, ...sprawdzTekstAllegro(pole, t, zasady)]
}

/** Opis (HTML albo tekst): reguły treści na tekście bez tagów, plus link ukryty w `<a href>`. */
export function sprawdzOpisAllegro(pole: string, html: string, zasady: ZasadyRegulaminu = DOMYSLNE_ZASADY_REGULAMINU): ProblemOferty[] {
  const out = sprawdzTekstAllegro(pole, tekstZHtml(html), zasady)
  // link schowany w <a href> też się liczy (oczyszczanie go wytnie, ale autor treści musi o nim wiedzieć)
  if (/<a\b[^>]*\bhref\s*=/i.test(html ?? '') && !out.some((p) => p.kod === 'link'))
    out.unshift({ kod: 'link', waga: 'blad', komunikat: 'Zawiera link — Allegro usuwa oferty z linkami.', pole })
  return out
}

// ─── Oczyszczanie HTML (port sanitize_allegro_html) ─────────────────────────────

export const TAGI_ALLEGRO = new Set(['p', 'b', 'h1', 'h2', 'ul', 'ol', 'li'])

/**
 * HTML opisu w postaci, którą przyjmuje Allegro: tylko p, b, h1, h2, ul, ol, li bez atrybutów; <strong> → <b>,
 * <br> → spacja, inne tagi znikają z zachowaniem tekstu, <script>/<style> i komentarze znikają z treścią.
 * Tekst między tagami jest escapowany, więc wynik nie zawiera obcych tagów (bezpieczny do podglądu w panelu).
 * Niezamknięte tagi z białej listy domyka na końcu, zbędne zamknięcia pomija.
 */
export function oczyscHtmlAllegro(raw: string): string {
  if (!raw) return ''
  const src = raw.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
  const tagRe = /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g
  const stos: string[] = []
  let out = ''
  let ostatni = 0
  const tekst = (s: string) => escapeHtml(dekoduj(s))
  for (let m = tagRe.exec(src); m; m = tagRe.exec(src)) {
    out += tekst(src.slice(ostatni, m.index))
    ostatni = m.index + m[0].length
    const zamkniecie = m[1] === '/'
    let nazwa = m[2]!.toLowerCase()
    if (nazwa === 'br') {
      out += ' '
      continue
    }
    if (nazwa === 'strong') nazwa = 'b'
    if (!TAGI_ALLEGRO.has(nazwa)) continue
    if (!zamkniecie) {
      // <li> i <p> bez zamknięcia (dozwolone w HTML) domykają poprzedni taki sam element
      if ((nazwa === 'li' || nazwa === 'p') && stos[stos.length - 1] === nazwa) out += `</${stos.pop()}>`
      out += `<${nazwa}>`
      stos.push(nazwa)
    } else {
      const i = stos.lastIndexOf(nazwa)
      if (i < 0) continue
      while (stos.length > i) out += `</${stos.pop()}>`
    }
  }
  out += tekst(src.slice(ostatni))
  while (stos.length) out += `</${stos.pop()}>`
  return out
    .replace(/<p>\s*<\/p>/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/>\s+</g, '>\n<')
    .trim()
}

/** Dekoduje encje i zostawia białe znaki (do escapowania z powrotem). */
function dekoduj(s: string): string {
  const srodek = tekstZHtml(s.replace(/[<>]/g, ' '))
  if (!srodek) return /\s/.test(s) ? ' ' : ''
  return (/^\s/.test(s) ? ' ' : '') + srodek + (/\s$/.test(s) ? ' ' : '')
}
