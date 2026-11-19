// Pomocnicze funkcje tekstu dla ofert. Port `_normalize`/`_normalize_name` ze skilla allegro-oferty
// (`scripts/category_matcher.py`, `scripts/parameter_mapper.py`): małe litery + polskie znaki bez ogonków.

const BEZ_OGONKOW: Record<string, string> = { ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' }

/** Małe litery, polskie litery bez ogonków (jak `_normalize` w category_matcher.py). */
export function bezOgonkow(s: string): string {
  return s.toLowerCase().replace(/[ąćęłńóśźż]/g, (c) => BEZ_OGONKOW[c] ?? c)
}

/** Jak `bezOgonkow`, dodatkowo bez spacji, myślników i podkreśleń (`_normalize_name` w parameter_mapper.py). */
export function kluczNazwy(s: string): string {
  return bezOgonkow(s ?? '').replace(/[\s\-_]+/g, '')
}

const znak = (n: number) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' ')

/** HTML → zwykły tekst (do walidacji regulaminu i długości). */
export function tekstZHtml(html: string): string {
  return (html ?? '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d{1,7});/g, (_, d: string) => znak(Number(d)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h: string) => znak(parseInt(h, 16)))
    .replace(/\s+/g, ' ')
    .trim()
}

/** Ucieczka znaków HTML w zwykłym tekście. */
export function escapeHtml(s: string): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
