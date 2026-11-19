// Pomoc: lista dokumentów z docs/, slug tylko z listy, bez surowego HTML, linki wewnętrzne do istniejących
// plików, bez danych pierwszej firmy i bez długich myślników w docs/.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Marked, type Token } from 'marked'
import { describe, expect, it } from 'vitest'
import nextConfig from '../../next.config'
import { slady } from '../../tests/straznik-nazw'
import { anchorOf, DOCS_DIR, docFiles, DOZWOLONE, getDoc, headOf, listDocs, renderMarkdown, resolveHref, slugOf } from './dokumenty'

/** Wszystkie pliki w docs/ (rekurencyjnie), ścieżki z ukośnikami względem docs/. */
function allFiles(dir = DOCS_DIR, prefix = ''): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...allFiles(path.join(dir, e.name), rel))
    else out.push(rel)
  }
  return out
}

const read = (rel: string) => readFileSync(path.join(DOCS_DIR, ...rel.split('/')), 'utf8')

function linksOf(markdown: string): string[] {
  const hrefs: string[] = []
  const m = new Marked({ gfm: true })
  m.walkTokens(m.lexer(markdown) as Token[], (t) => {
    if (t.type === 'link') hrefs.push(t.href)
  })
  return hrefs
}

describe('slugOf', () => {
  it('mapuje pliki na slugi', () => {
    expect(slugOf('instalacja.md')).toBe('instalacja')
    expect(slugOf('integracje/README.md')).toBe('integracje')
    expect(slugOf('integracje/shoper.md')).toBe('integracje-shoper')
    expect(slugOf('README.md')).toBeNull()
    expect(slugOf('../package.json')).toBeNull()
    expect(slugOf('a/b/c.md')).toBeNull()
    expect(slugOf('Instalacja.MD')).toBeNull()
    expect(slugOf('.ukryty.md')).toBeNull()
  })
})

describe('lista dokumentów', () => {
  it('każdy dokument ma tytuł `# …` i jedno zdanie opisu, „Pierwsze kroki” pierwsze, „Co jeszcze nie działa” drugie', () => {
    const docs = listDocs()
    expect(docs.length).toBeGreaterThanOrEqual(8)
    expect(docs[0]!.slug).toBe('pierwsze-kroki')
    expect(docs[1]!.slug).toBe('co-jeszcze-nie-dziala')
    for (const d of docs) {
      expect(read(d.file).startsWith('# '), d.file).toBe(true)
      expect(d.title, d.file).not.toBe(d.slug)
      expect(d.description.length, d.file).toBeGreaterThan(10)
    }
    expect(new Set(docs.map((d) => d.slug)).size).toBe(docs.length)
  })

  it('pliki spoza .md, ukryte i głębiej niż jeden poziom nie trafiają na listę', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pomoc-'))
    writeFileSync(path.join(dir, 'temat.md'), '# Temat\n\nOpis tematu.\n')
    writeFileSync(path.join(dir, 'README.md'), '# Spis\n\nSpis.\n')
    writeFileSync(path.join(dir, 'notatka.txt'), 'x')
    writeFileSync(path.join(dir, '.ukryty.md'), '# X\n')
    mkdirSync(path.join(dir, 'integracje', 'glebiej'), { recursive: true })
    writeFileSync(path.join(dir, 'integracje', 'README.md'), '# Integracje\n\nOpis.\n')
    writeFileSync(path.join(dir, 'integracje', 'shoper.md'), '# Shoper\n\nOpis.\n')
    writeFileSync(path.join(dir, 'integracje', 'glebiej', 'x.md'), '# X\n')
    expect(docFiles(dir).sort()).toEqual(['integracje/README.md', 'integracje/shoper.md', 'temat.md'])
    expect(listDocs(dir, () => true).map((d) => d.slug)).toEqual(['integracje', 'integracje-shoper', 'temat'])
    expect(getDoc('integracje-shoper', dir)?.title).toBe('Shoper')
  })

  it('tylko jawna lista: plik spoza listy (np. dokument deweloperski) niewidoczny i bez strony', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pomoc-'))
    writeFileSync(path.join(dir, 'faq.md'), '# FAQ\n\nPytania.\n')
    writeFileSync(path.join(dir, 'wewnetrzny.md'), '# Notatka deweloperska\n\nKonto pierwszej firmy.\n')
    writeFileSync(path.join(dir, 'api.md'), '# API\n\nOpis.\n')
    mkdirSync(path.join(dir, 'wewnetrzne'))
    writeFileSync(path.join(dir, 'wewnetrzne', 'x.md'), '# X\n')
    expect(listDocs(dir).map((d) => d.slug)).toEqual(['faq'])
    expect(getDoc('wewnetrzny', dir)).toBeNull()
    expect(getDoc('api', dir)).toBeNull()
    expect(getDoc('wewnetrzne-x', dir)).toBeNull()
    expect(getDoc('faq', dir)?.title).toBe('FAQ')
  })

  it('brak katalogu docs/ to pusta lista, nie błąd', () => {
    expect(listDocs(path.join(tmpdir(), 'nie-ma-takiego-katalogu-pomocy'))).toEqual([])
  })

  it('opisy na liście Pomocy bez identyfikatorów zadań, nazw plików i tabel, resztek markdownu', () => {
    const zle: string[] = []
    for (const d of listDocs()) {
      const tekst = `${d.title} ${d.description}`
      if (/LOG-A-\d|`|\*\*|^>|\s>\s|\b[\w/-]+\.(ts|tsx|md|json)\b|lib\/|\b(CarrierRule|ChannelConfig|Organization|Alert)\b|\bcie[nń]/i.test(tekst) || /\bPRACA\b/.test(tekst)) zle.push(`${d.slug}: ${tekst}`)
    }
    expect(zle).toEqual([])
  })

  it('ramka „> Stan …” na początku nie jest opisem: opis to pierwszy zwykły akapit po niej', () => {
    expect(headOf('# Allegro\n\n> **Stan:** sprawdzone na symulacji.\n> Druga linia.\n\nJak podłączyć konto Allegro.\n', 'x').description).toBe('Jak podłączyć konto Allegro.')
    expect(headOf('# Allegro\n\n> Sama ramka.\n> Druga linia.\n\n## Dalej\n', 'x').description).toBe('Sama ramka. Druga linia.')
  })

  it('tytuł i opis z pierwszych linii', () => {
    expect(headOf('# Tytuł\n\nPierwsze zdanie z [linkiem](x.md).\nCiąg dalszy.\n\n## Dalej', 'x')).toEqual({
      title: 'Tytuł',
      description: 'Pierwsze zdanie z linkiem. Ciąg dalszy.',
    })
    expect(headOf('bez tytułu', 'zapas').title).toBe('zapas')
  })
})

describe('slug tylko z listy (404 poza nią)', () => {
  it.each(['nie-ma', '../package', '..%2Fpackage', '../../etc/passwd', 'integracje/README', 'README', 'readme', 'instalacja.md', '', '.', '..', 'docs/faq'])(
    '„%s” → brak dokumentu',
    (slug) => {
      expect(getDoc(slug)).toBeNull()
    },
  )

  it('istniejący slug daje dokument bez powtórzonego tytułu w treści', () => {
    const d = getDoc('rezerwacje')
    expect(d?.title).toBe('Rezerwacje')
    expect(d!.html).not.toMatch(/<h1/)
    expect(d!.html).toContain('<div class="pomoc-tabela"><table>')
  })
})

describe('renderowanie', () => {
  const docs = [
    { slug: 'faq', file: 'faq.md' },
    { slug: 'integracje', file: 'integracje/README.md' },
    { slug: 'integracje-shoper', file: 'integracje/shoper.md' },
  ]

  it('surowy HTML nie przechodzi', () => {
    const html = renderMarkdown('A <script>alert(1)</script> <img src=x onerror=alert(1)>\n\n<div onclick="x()">blok</div>\n\n<iframe src="https://example.com"></iframe>\n', 'faq.md', docs)
    expect(html).not.toMatch(/<script|<img|<div onclick|<iframe/)
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;div onclick=')
  })

  it('niebezpieczne adresy linków dają sam tekst', () => {
    const html = renderMarkdown('[a](javascript:alert(1)) [b](data:text/html,x) [c](/etc/passwd) [d](../../package.json) [e](vbscript:x)', 'faq.md', docs)
    expect(html).not.toMatch(/<a /)
    expect(html).not.toMatch(/javascript:|data:text|vbscript:/)
  })

  it('obrazki nie ładują zewnętrznych adresów', () => {
    expect(renderMarkdown('![opis](https://example.com/x.png)', 'faq.md', docs)).not.toMatch(/<img/)
  })

  it('linki między dokumentami → /pomoc/<slug>, zewnętrzne z rel=noopener', () => {
    const html = renderMarkdown('[i](integracje/README.md) [s](README.md) [f](faq.md#licencja) [z](https://example.com)', 'faq.md', docs)
    expect(html).toContain('<a href="/pomoc/integracje">i</a>')
    expect(html).toContain('<a href="/pomoc">s</a>')
    expect(html).toContain('<a href="/pomoc/faq#licencja">f</a>')
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">z</a>')
  })

  it('linki z podkatalogu liczą się względem jego katalogu', () => {
    expect(resolveHref('../faq.md', 'integracje/README.md', docs)?.href).toBe('/pomoc/faq')
    expect(resolveHref('shoper.md', 'integracje/README.md', docs)?.href).toBe('/pomoc/integracje-shoper')
    expect(resolveHref('../../faq.md', 'integracje/README.md', docs)).toBeNull()
    expect(resolveHref('nie-ma.md', 'faq.md', docs)).toBeNull()
  })

  it('kotwice nagłówków bez polskich znaków', () => {
    expect(anchorOf('Zapomniane hasło właściciela')).toBe('zapomniane-haslo-wlasciciela')
    expect(renderMarkdown('## Częste błędy', 'faq.md', docs)).toContain('<h2 id="czeste-bledy">')
  })
})

describe('treść docs/', () => {
  // testy treści na dokumentach pokazywanych w Pomocy (lista jawna) i spisie, nie na całym docs/
  const shown = listDocs().map((d) => d.file)
  const files = [...shown, 'README.md']
  const md = files

  it('każdy slug z listy dozwolonych ma plik', () => {
    expect(listDocs().map((d) => d.slug).filter((s) => !s.startsWith('integracje-')).sort()).toEqual([...DOZWOLONE].sort())
  })

  it('wszystkie linki wewnętrzne prowadzą do istniejących plików', () => {
    const existing = new Set(allFiles())
    const docs = listDocs()
    const broken: string[] = []
    for (const f of md) {
      for (const href of linksOf(read(f))) {
        if (/^(https?:|mailto:|#)/i.test(href)) continue
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), href.split('#')[0]!))
        if (!existing.has(target) || !resolveHref(href, f, docs)) broken.push(`${f} → ${href}`)
      }
    }
    expect(broken).toEqual([])
  })

  it('bez nazw pierwszej firmy, ścieżek lokalnych i adresów serwerów', () => {
    // te same wzorce co strażnik publicznego wydania (tests/straznik-nazw.ts)
    expect(files.flatMap((f) => slady(f, read(f)))).toEqual([])
  })

  it('bez długiego myślnika', () => {
    expect(files.filter((f) => read(f).includes('\u2014'))).toEqual([])
  })

  it('spis docs/README.md linkuje każdy temat z listy', () => {
    const linked = new Set(linksOf(read('README.md')).map((h) => h.split('#')[0]))
    expect(listDocs().filter((d) => !linked.has(d.file)).map((d) => d.file)).toEqual([])
  })
})

describe('obraz standalone', () => {
  it('next.config dołącza docs/ do śledzenia plików', () => {
    expect(nextConfig.outputFileTracingIncludes?.['/**']).toContain('./docs/**')
  })
})
