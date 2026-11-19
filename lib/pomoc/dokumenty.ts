// Pomoc w panelu: dokumenty użytkownika z katalogu docs/ renderowane po stronie serwera. Jedno źródło:
// ekran czyta te same pliki co repozytorium, bez drugiej kopii. Na ekranie są wyłącznie slugi z jawnej listy
// `DOZWOLONE` (plus `integracje-*`); pozostałe pliki docs/ (dokumenty deweloperskie: API, druk, seria F3…) są
// niewidoczne i `/pomoc/<slug>` daje 404. Lista plików powstaje z odczytu katalogu (tylko
// *.md, bez dowiązań i ukrytych plików), a slug z adresu jest wyłącznie kluczem tej listy: żadna ścieżka z parametru
// nie trafia do fs. Surowy HTML w markdownie jest wyłączony (wychodzi jako tekst), linki filtrowane.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Marked, Renderer, type Tokens } from 'marked'

/**
 * Katalog dokumentów: `docs/` obok aplikacji. turbopackIgnore jak w lib/wydruki/wspolne.ts: docs/ dołącza do obrazu
 * standalone outputFileTracingIncludes (next.config.ts); bez tego build śledziłby całe repo.
 */
export const DOCS_DIR = path.join(/*turbopackIgnore: true*/ process.cwd(), 'docs')

/** Dokument „Pierwsze kroki”: ekran listy pokazuje go jako pierwszy, nad wszystkimi grupami. */
export const SLUG_START = 'pierwsze-kroki'

/** Dokument „Co jeszcze nie działa”: ekran listy pokazuje go osobno, u góry. */
export const SLUG_BRAKI = 'co-jeszcze-nie-dziala'

/**
 * Dokumenty dla sprzedawcy, w kolejności ekranu: jednocześnie lista dozwolonych. Nowy dokument
 * użytkownika trafia do Pomocy dopiero po dopisaniu tutaj i do spisu docs/README.md (testy treści pilnują obu).
 */
export const DOZWOLONE = [
  SLUG_START, // pierwsze kroki bez BaseLinkera i wFirmy, pierwszy na ekranie
  SLUG_BRAKI,
  'instalacja',
  'konfiguracja',
  'integracje', // limity zapytań i automatyczne wyłączanie zepsutej integracji („Włącz ponownie”)
  'produkty', // także „Zdjęcia z feedu” (feed produktowy Google Merchant, przycisk na liście produktów)
  'oferty', // zakładka „Publikacja” (podgląd ofert, „Wystaw”), „Przygotuj oferty” z raportem, włączenie wystawiania
  'dokumenty-sprzedazy', // źródło stanu, program do faktur, dane firmy; lista faktur i korekt, KSeF, serie
  'rezerwacje',
  'tryb-praca',
  'synchronizacja-stanow', // kiedy stan nie idzie do sklepu drugi raz i jak wymusić
  'lista-zamowien', // statusy (w menu „Zamówienia”), filtry, akcje masowe, eksport CSV i XLSX; jedno pole szukania, termin wysyłki i „Po terminie”, kolumna „Stan”, alerty
  'raporty', // raporty sprzedaży (okres, kanał, produkt, marża), eksport XLSX
  'statusy', // statusy własne firmy (nazwa, kolor, grupa, etap, status w sklepie)
  'automatyczne-akcje', // reguły „kiedy → jeśli → zrób”, grupy, przyciski, bezpieczniki; szablony przepływów, automaty przy przeprowadzce
  'karta-zamowienia', // co biuro robi z karty zamówienia; układ (Wysyłka, Dane do faktury, Szczegóły), odczyt i „Edytuj”
  'zwroty-i-reklamacje', // przyjęcie, statusy, na stan albo uszkodzone, korekta, zwroty Allegro
  'pakowanie', // kolejka, lista zbierania, koszyki, stanowisko; „Przyjechał kurier” = „Wysłane”
  'przesylki', // utworzenie przesyłki, numer nadania, etykieta, poprawka adresu; lista przesyłek, protokół odbioru, druk wielu etykiet, wyszukiwarka punktów; GLS przez ADE (opis w integracje/gls.md)
  'poczta', // maile do klientów i biura, szablony, reset hasła; zaproszenia, odbicia, dane firmy; czytnik odbić (IMAP)
  'powiadomienia',
  'dane-klienta',
  'agenci-ai', // „Podłącz agenta” w Pomocy
  'migracja-z-baselinkera',
  'akcje-bl',
  'faq',
] as const
const KOLEJNOSC: readonly string[] = DOZWOLONE

/** Slug widoczny w Pomocy: z listy `DOZWOLONE` albo opis jednej integracji (`integracje/<nazwa>.md`). */
export function dozwolony(slug: string): boolean {
  return KOLEJNOSC.includes(slug) || /^integracje-[a-z0-9-]+$/.test(slug)
}

export interface DocEntry {
  slug: string
  /** Ścieżka względem docs/, z ukośnikami (np. `integracje/README.md`). */
  file: string
  title: string
  description: string
}

const NAZWA_PLIKU = /^[a-z0-9][a-z0-9-]*\.md$/
const NAZWA_KATALOGU = /^[a-z0-9][a-z0-9-]*$/

/** Slug pliku: `instalacja.md` → `instalacja`, `integracje/README.md` → `integracje`, `integracje/shoper.md` → `integracje-shoper`. */
export function slugOf(file: string): string | null {
  const parts = file.split('/')
  if (parts.length === 1) return parts[0] === 'README.md' ? null : NAZWA_PLIKU.test(parts[0]!) ? parts[0]!.slice(0, -3) : null
  if (parts.length !== 2 || !NAZWA_KATALOGU.test(parts[0]!)) return null
  if (parts[1] === 'README.md') return parts[0]!
  return NAZWA_PLIKU.test(parts[1]!) ? `${parts[0]}-${parts[1]!.slice(0, -3)}` : null
}

/** Pliki dokumentów w katalogu (korzeń i jeden poziom podkatalogów). `README.md` w korzeniu to spis, nie temat. */
export function docFiles(dir: string = DOCS_DIR): string[] {
  const out: string[] = []
  let root
  try {
    root = readdirSync(/*turbopackIgnore: true*/ dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of root) {
    if (e.isFile() && NAZWA_PLIKU.test(e.name)) out.push(e.name)
    if (e.isDirectory() && NAZWA_KATALOGU.test(e.name)) {
      for (const f of readdirSync(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ dir, e.name), { withFileTypes: true })) {
        if (f.isFile() && (f.name === 'README.md' || NAZWA_PLIKU.test(f.name))) out.push(`${e.name}/${f.name}`)
      }
    }
  }
  return out
}

/** Tytuł (pierwsza linia `# …`) i opis (pierwszy akapit po tytule) z treści markdownu. */
export function headOf(markdown: string, fallback: string): { title: string; description: string } {
  const lines = markdown.replace(/^﻿/, '').split(/\r?\n/)
  let i = 0
  while (i < lines.length && !lines[i]!.trim()) i++
  const m = /^#\s+(.+?)\s*#*\s*$/.exec(lines[i] ?? '')
  const title = m ? m[1]! : fallback
  if (m) i++
  while (i < lines.length && !lines[i]!.trim()) i++
  // ramka „> Stan na …” na początku dokumentu to uwaga, nie opis; opisem jest pierwszy zwykły akapit po niej
  const poRamce = pominRamki(lines, i)
  if (poRamce !== null) i = poRamce
  const desc: string[] = []
  while (i < lines.length && lines[i]!.trim() && !/^(#|\||```|[-*] |\d+\. )/.test(lines[i]!.trim())) desc.push(lines[i++]!.trim().replace(/^>\s?/, ''))
  return { title: plain(title), description: plain(desc.join(' ')) }

  /** Indeks pierwszego zwykłego akapitu po ramkach `>` albo null (bez ramek albo bez akapitu po nich). */
  function pominRamki(ls: string[], od: number): number | null {
    let j = od
    if (!/^\s{0,3}>/.test(ls[j] ?? '')) return null
    while (j < ls.length && (/^\s{0,3}>/.test(ls[j]!) || !ls[j]!.trim())) j++
    return j < ls.length && !/^(#|\||```|[-*] |\d+\. )/.test(ls[j]!.trim()) ? j : null
  }

  function plain(s: string): string {
    return s
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^>\s?/, '')
      .replace(/[*_`]/g, '')
      .trim()
  }
}

function rank(slug: string): number {
  const i = KOLEJNOSC.indexOf(slug)
  return i === -1 ? KOLEJNOSC.length : i
}

/** Dokumenty widoczne w Pomocy, w kolejności ekranu (`czyDozwolony` tylko dla testów na katalogu tymczasowym). */
export function listDocs(dir: string = DOCS_DIR, czyDozwolony: (slug: string) => boolean = dozwolony): DocEntry[] {
  const out: DocEntry[] = []
  for (const file of docFiles(dir)) {
    const slug = slugOf(file)
    if (!slug || !czyDozwolony(slug)) continue
    let text: string
    try {
      text = readFileSync(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ dir, ...file.split('/')), 'utf8')
    } catch {
      continue
    }
    out.push({ slug, file, ...headOf(text, slug) })
  }
  return out.sort((a, b) => rank(a.slug) - rank(b.slug) || a.slug.localeCompare(b.slug))
}

export interface RenderedDoc extends DocEntry {
  html: string
}

/** Dokument po slugu albo null (slug spoza listy, w tym każda próba ścieżki). */
export function getDoc(slug: string, dir: string = DOCS_DIR): RenderedDoc | null {
  const docs = listDocs(dir)
  const entry = docs.find((d) => d.slug === slug)
  if (!entry) return null
  const text = readFileSync(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ dir, ...entry.file.split('/')), 'utf8')
  return { ...entry, html: renderMarkdown(text, entry.file, docs, { skipTitle: true }) }
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/** Kotwica nagłówka: małe litery bez polskich znaków, reszta jako „-”. */
export function anchorOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Adres linku z dokumentu `from` (ścieżka względem docs/): link do innego dokumentu → `/pomoc/<slug>`, spis
 * (`README.md` w korzeniu) → `/pomoc`, zewnętrzny http(s) i mailto bez zmian, kotwica w dokumencie bez zmian.
 * Wszystko inne (inne schematy, pliki spoza listy, wyjście poza docs/) → null, czyli sam tekst bez linku.
 */
export function resolveHref(href: string, from: string, docs: readonly Pick<DocEntry, 'slug' | 'file'>[]): { href: string; external: boolean } | null {
  const h = href.trim()
  if (/^https?:\/\//i.test(h) || /^mailto:/i.test(h)) return { href: h, external: true }
  if (/^#[\w-]+$/.test(h)) return { href: h, external: false }
  if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('/') || h.startsWith('\\')) return null
  const [pathPart, hash] = h.split('#', 2) as [string, string | undefined]
  if (!pathPart.endsWith('.md')) return null
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(from), pathPart))
  if (target.startsWith('..') || path.posix.isAbsolute(target)) return null
  const suffix = hash && /^[\w-]+$/.test(hash) ? `#${hash}` : ''
  if (target === 'README.md') return { href: `/pomoc${suffix}`, external: false }
  const doc = docs.find((d) => d.file === target)
  return doc ? { href: `/pomoc/${doc.slug}${suffix}`, external: false } : null
}

/** Markdown → HTML: GFM (tabele), bez surowego HTML, linki przez `resolveHref`, tabele w przewijanym kontenerze. */
export function renderMarkdown(
  markdown: string,
  from: string,
  docs: readonly Pick<DocEntry, 'slug' | 'file'>[],
  opts: { skipTitle?: boolean } = {},
): string {
  const base = new Renderer()
  let skip = opts.skipTitle === true // tytuł `# …` pokazuje nagłówek ekranu, więc w treści go pomijamy
  const marked = new Marked({
    gfm: true,
    async: false,
    renderer: {
      html({ text }: Tokens.HTML | Tokens.Tag) {
        return escapeHtml(text)
      },
      link({ href, title, tokens }: Tokens.Link) {
        const inner = this.parser.parseInline(tokens)
        const r = resolveHref(href, from, docs)
        if (!r) return `<span class="pomoc-link-brak">${inner}</span>`
        const t = title ? ` title="${escapeHtml(title)}"` : ''
        const ext = r.external ? ' target="_blank" rel="noopener noreferrer"' : ''
        return `<a href="${escapeHtml(r.href)}"${t}${ext}>${inner}</a>`
      },
      image({ text }: Tokens.Image) {
        return escapeHtml(text)
      },
      heading({ tokens, depth, text }: Tokens.Heading) {
        if (skip && depth === 1) {
          skip = false
          return ''
        }
        const id = anchorOf(text)
        return `<h${depth}${id ? ` id="${id}"` : ''}>${this.parser.parseInline(tokens)}</h${depth}>\n`
      },
      table(token: Tokens.Table) {
        base.parser = this.parser
        return `<div class="pomoc-tabela">${base.table(token)}</div>\n`
      },
    },
  })
  return marked.parse(markdown.replace(/^﻿/, '')) as string
}
