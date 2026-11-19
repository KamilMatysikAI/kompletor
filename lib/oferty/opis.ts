// Opis oferty z sekcjami. Port `scripts/description_builder.py` ze skilla allegro-oferty:
// szablon 9 sekcji (0 zdjęcie główne, 1 h1 + zajawka, 2 opis [zdjęcie | tekst], 3 „Dlaczego warto?” [tekst | zdjęcie],
// 4 jak używać, 5 dla kogo, 6 skład i specyfikacja, 7 najczęstsze pytania, 8 o marce [zdjęcie | tekst]; nadmiarowe
// zdjęcia parami przed sekcją o marce) i wariant tekstowy bez zdjęć (Empik/Mirakl, Etap 2).
// Nagłówki i tekst „O marce” są danymi firmy (`SzablonOpisu`); domyślny szablon jest neutralny, szablon firmy
// (nagłówki i akapit o marce) idzie do presetu firmy. Pola HTML są czyszczone `oczyscHtmlAllegro`.
import { oczyscHtmlAllegro, sprawdzOpisAllegro, type ZasadyRegulaminu, DOMYSLNE_ZASADY_REGULAMINU } from './regulamin-allegro'
import { escapeHtml } from './tekst'
import type { ProblemOferty } from './typy'

/** Treść oferty (odpowiednik `desc.json` skilla, neutralne nazwy pól). */
export interface TrescOferty {
  /** Tytuł oferty; puste = nazwa produktu. */
  tytul?: string
  /** Jedno zdanie pod tytułem (skill: hook). */
  zajawka?: string
  /** Opis produktu, HTML albo tekst (skill: what_is_it). */
  opis?: string
  /** Lista zalet (skill: key_features). */
  cechy?: string[]
  /** Jak używać / przygotować (skill: how_to_use, how_to_brew). */
  uzycie?: string
  /** Dla kogo (skill: who_for, occasions). */
  dlaKogo?: string
  /** Skład i specyfikacja jako pary nazwa → wartość (skill: specs). */
  specyfikacja?: [string, string][]
  /** Pytania i odpowiedzi (skill: faq). */
  pytania?: { pytanie: string; odpowiedz: string }[]
}

export interface SzablonOpisu {
  naglowki: { opis: string; cechy: string; uzycie: string; dlaKogo: string; specyfikacja: string; pytania: string }
  /** Gotowy HTML sekcji „O marce” (z nagłówkiem h2) albo null = bez sekcji. */
  oMarce: string | null
}

export const DOMYSLNY_SZABLON_OPISU: SzablonOpisu = {
  naglowki: {
    opis: 'Opis produktu',
    cechy: 'Dlaczego warto?',
    uzycie: 'Jak używać',
    dlaKogo: 'Dla kogo',
    specyfikacja: 'Skład i specyfikacja',
    pytania: 'Najczęstsze pytania',
  },
  oMarce: null,
}

export type ElementOpisu = { type: 'TEXT'; content: string } | { type: 'IMAGE'; url: string }
export interface OpisAllegro {
  sections: { items: ElementOpisu[] }[]
}

const tekstS = (content: string) => ({ items: [{ type: 'TEXT' as const, content }] })
const zdjS = (url: string) => ({ items: [{ type: 'IMAGE' as const, url }] })

/** Tekst albo HTML w sekcji z nagłówkiem h2 (port `_wrap_section`). */
function sekcja(naglowek: string, tresc: string): string {
  if (!tresc) return ''
  const html = /<(p|h2|ul|ol|li)\b/i.test(tresc) ? oczyscHtmlAllegro(tresc) : `<p>${escapeHtml(tresc.trim())}</p>`
  if (!html) return ''
  return /<h2>/.test(html) ? html : `<h2>${escapeHtml(naglowek)}</h2>${html}`
}

/** Pola tekstowe opisu w kolejności szablonu (bez zdjęć). */
function czesci(t: TrescOferty, szablon: SzablonOpisu, tytul: string) {
  const n = szablon.naglowki
  const h1 = tytul ? `<h1>${escapeHtml(tytul)}</h1>${t.zajawka?.trim() ? `<p><b>${escapeHtml(t.zajawka.trim())}</b></p>` : ''}` : ''
  const cechy = (t.cechy ?? []).map((c) => c.trim()).filter(Boolean)
  const spec = (t.specyfikacja ?? []).filter(([k, v]) => k?.trim() && v?.trim())
  const faq = (t.pytania ?? []).filter((q) => q.pytanie?.trim() && q.odpowiedz?.trim())
  return {
    h1,
    opis: sekcja(n.opis, t.opis ?? ''),
    cechy: cechy.length ? `<h2>${escapeHtml(n.cechy)}</h2><ul>${cechy.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>` : '',
    uzycie: sekcja(n.uzycie, t.uzycie ?? ''),
    dlaKogo: sekcja(n.dlaKogo, t.dlaKogo ?? ''),
    spec: spec.length ? `<h2>${escapeHtml(n.specyfikacja)}</h2><ul>${spec.map(([k, v]) => `<li><b>${escapeHtml(k.trim())}:</b> ${escapeHtml(v.trim())}</li>`).join('')}</ul>` : '',
    faq: faq.length ? `<h2>${escapeHtml(n.pytania)}</h2>${faq.map((q) => `<p><b>${escapeHtml(q.pytanie.trim())}</b></p><p>${escapeHtml(q.odpowiedz.trim())}</p>`).join('')}` : '',
    oMarce: szablon.oMarce ? oczyscHtmlAllegro(szablon.oMarce) : '',
  }
}

/**
 * Opis Allegro w sekcjach (port `build_description`). `miniatura` = zdjęcie główne (sekcja 0), `zdjecia` = pozostałe
 * zdjęcia do sekcji 2, 3 i 8; nadmiar parami przed sekcją o marce.
 */
export function zbudujOpisAllegro(t: TrescOferty, tytul: string, zdj: { miniatura: string | null; zdjecia: string[] }, szablon: SzablonOpisu = DOMYSLNY_SZABLON_OPISU): OpisAllegro {
  const c = czesci(t, szablon, tytul)
  const glowne = zdj.miniatura ?? zdj.zdjecia[0] ?? null
  const pula = [...new Set(zdj.zdjecia.filter((u) => u && u !== glowne))]
  const sections: OpisAllegro['sections'] = []
  if (glowne) sections.push(zdjS(glowne))
  if (c.h1) sections.push(tekstS(c.h1))
  if (c.opis) {
    const u = pula.shift()
    sections.push(u ? { items: [{ type: 'IMAGE', url: u }, { type: 'TEXT', content: c.opis }] } : tekstS(c.opis))
  }
  if (c.cechy) {
    const u = pula.shift()
    sections.push(u ? { items: [{ type: 'TEXT', content: c.cechy }, { type: 'IMAGE', url: u }] } : tekstS(c.cechy))
  }
  for (const s of [c.uzycie, c.dlaKogo, c.spec, c.faq]) if (s) sections.push(tekstS(s))
  let marka: OpisAllegro['sections'][number] | null = null
  if (c.oMarce) {
    const u = pula.shift()
    marka = u ? { items: [{ type: 'IMAGE', url: u }, { type: 'TEXT', content: c.oMarce }] } : tekstS(c.oMarce)
  }
  for (let i = 0; i < pula.length; i += 2) sections.push({ items: pula.slice(i, i + 2).map((url) => ({ type: 'IMAGE' as const, url })) })
  if (marka) sections.push(marka)
  return { sections }
}

/** Wariant tekstowy bez zdjęć, jedno pole HTML (port `build_text_description`; Empik w Etapie 2). */
export function zbudujOpisTekstowy(t: TrescOferty, tytul: string, szablon: SzablonOpisu = DOMYSLNY_SZABLON_OPISU): string {
  const c = czesci(t, szablon, tytul)
  return [c.h1, c.opis, c.cechy, c.uzycie, c.dlaKogo, c.spec, c.faq, c.oMarce].filter(Boolean).join('\n')
}

/**
 * Sprawdzenie treści (port `validate_desc_data` bez części o tytule — ta jest w `sprawdzTytulAllegro`):
 * regulamin w każdym polu + zalecenia szablonu (zajawka, co najmniej 3 cechy, 2 pytania) jako ostrzeżenia.
 */
export function sprawdzTresc(t: TrescOferty, zasady: ZasadyRegulaminu = DOMYSLNE_ZASADY_REGULAMINU): ProblemOferty[] {
  const out: ProblemOferty[] = []
  const pola: [string, string][] = [
    ['zajawka', t.zajawka ?? ''],
    ['opis', t.opis ?? ''],
    ['uzycie', t.uzycie ?? ''],
    ['dlaKogo', t.dlaKogo ?? ''],
    ...(t.cechy ?? []).map((c) => ['cechy', c] as [string, string]),
    ...(t.specyfikacja ?? []).map(([k, v]) => [`specyfikacja`, `${k}: ${v}`] as [string, string]),
    ...(t.pytania ?? []).flatMap((q) => [['pytania', q.pytanie], ['pytania', q.odpowiedz]] as [string, string][]),
  ]
  const widziane = new Set<string>()
  for (const [pole, tekst] of pola) {
    for (const p of sprawdzOpisAllegro(pole, tekst, zasady)) {
      const k = `${p.pole}|${p.kod}`
      if (widziane.has(k)) continue
      widziane.add(k)
      out.push(p)
    }
  }
  if (!t.opis?.trim()) out.push({ kod: 'bez_opisu', waga: 'blad', komunikat: 'Oferta nie ma opisu — uzupełnij opis w karcie produktu.', pole: 'opis' })
  if (!t.zajawka?.trim()) out.push({ kod: 'bez_zajawki', waga: 'ostrzezenie', komunikat: 'Brak jednego zdania zachęty pod tytułem (zalecane).', pole: 'zajawka' })
  if ((t.cechy ?? []).filter((c) => c.trim()).length < 3) out.push({ kod: 'malo_cech', waga: 'ostrzezenie', komunikat: 'Mniej niż 3 zalety w sekcji „Dlaczego warto?” (zalecane co najmniej 3).', pole: 'cechy' })
  if ((t.pytania ?? []).length < 2) out.push({ kod: 'malo_pytan', waga: 'ostrzezenie', komunikat: 'Mniej niż 2 pytania z odpowiedziami (zalecane co najmniej 2).', pole: 'pytania' })
  return out
}
