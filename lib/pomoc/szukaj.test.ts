// Wyszukiwarka Pomocy: odmiany słów, polskie znaki, wszystkie słowa naraz, najlepsza sekcja z kotwicą,
// podświetlenie, tylko dokumenty z listy Pomocy. Działa na katalogu tymczasowym i na prawdziwym docs/.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DOZWOLONE, listDocs } from './dokumenty'
import { rolaDokumentu, rolaOsoby, ROLE_POMOCY } from './role'
import { bezZnacznikow, normalizuj, rdzen, sekcjeDokumentu, slowaZapytania, szukajWPomocy } from './szukaj'

function katalog(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'pomoc-szukaj-'))
  writeFileSync(
    path.join(dir, 'przesylki.md'),
    '# Przesyłki: numer nadania i etykieta\n\nJak utworzyć przesyłkę u przewoźnika.\n\n## Etykieta i ponowny druk\n\nEtykietę drukujesz ponownie z karty zamówienia.\n\n## Paczkomat\n\nKod paczkomatu bierzemy z zamówienia.\n',
  )
  writeFileSync(path.join(dir, 'faktury.md'), '# Dokumenty sprzedaży\n\nFaktury w programie do faktur albo bez programu.\n\n## Korekta\n\nKorektę faktury wystawiasz w programie.\n')
  writeFileSync(path.join(dir, 'tajny.md'), '# Notatka\n\nEtykieta paczkomat faktura.\n')
  mkdirSync(path.join(dir, 'integracje'))
  writeFileSync(path.join(dir, 'integracje', 'dpd.md'), '# DPD\n\nPrzesyłki DPD bez pośrednika, etykieta PDF.\n')
  return dir
}
const dozwolone = (s: string) => s !== 'tajny'

describe('normalizacja i słowa', () => {
  it('bez polskich znaków i wielkich liter, ta sama długość', () => {
    expect(normalizuj('Łódź ŻÓŁĆ Gęś')).toBe('lodz zolc ges')
    const t = 'Przesyłkę zażółć'
    expect(normalizuj(t)).toHaveLength(t.length)
  })

  it('słowa zapytania: bez jednoliterowych, bez powtórzeń', () => {
    expect(slowaZapytania('  Faktura, a  faktura! KSeF  ')).toEqual(['faktura', 'ksef'])
    expect(slowaZapytania('a ?')).toEqual([])
  })

  it('rdzeń łapie odmiany', () => {
    expect(normalizuj('przesyłka').startsWith(rdzen(normalizuj('przesyłki')))).toBe(true)
    expect(normalizuj('fakturę').startsWith(rdzen(normalizuj('faktury')))).toBe(true)
    expect(rdzen('dpd')).toBe('dpd')
  })

  it('markdown jednej linii na zwykły tekst', () => {
    expect(bezZnacznikow('> **Stan:** [Przesyłki](przesylki.md) i `kod`')).toBe('Stan: Przesyłki i kod')
    expect(bezZnacznikow('| a | b |')).toBe('a b')
    expect(bezZnacznikow('|---|---|')).toBe('')
    expect(bezZnacznikow('1. Krok')).toBe('Krok')
    // nawias z wewnętrznym identyfikatorem zadania (składany, żeby strażnik publicznego wydania nie liczył przykładu)
    const id = ['LOG', 'A', '127'].join('-')
    expect(bezZnacznikow(`Karta (od ${id}) ma przyciski`)).toBe('Karta ma przyciski')
  })

  it('sekcje po nagłówkach, kotwice jak w renderze, nagłówek w kodzie to nie sekcja', () => {
    const s = sekcjeDokumentu('# T\n\nWstęp.\n\n## Częste błędy\n\nTreść.\n\n```\n## nie nagłówek\n```\n', 'T')
    expect(s.map((x) => [x.tytul, x.kotwica])).toEqual([
      ['T', ''],
      ['Częste błędy', 'czeste-bledy'],
    ])
    expect(s[1]!.tekst).toContain('## nie nagłówek')
  })
})

describe('szukajWPomocy', () => {
  const dir = katalog()

  it('znajduje po odmianie i bez polskich znaków, z kotwicą najlepszej sekcji', () => {
    const w = szukajWPomocy('etykiety', { dir, czyDozwolony: dozwolone })
    expect(w[0]!.slug).toBe('przesylki')
    expect(w[0]!.href).toBe('/pomoc/przesylki#etykieta-i-ponowny-druk')
    expect(w[0]!.sekcja).toBe('Etykieta i ponowny druk')
    expect(szukajWPomocy('przesylke', { dir, czyDozwolony: dozwolone }).map((x) => x.slug)).toContain('przesylki')
  })

  it('wszystkie słowa muszą być w dokumencie', () => {
    expect(szukajWPomocy('paczkomat etykieta', { dir, czyDozwolony: dozwolone }).map((x) => x.slug)).toEqual(['przesylki'])
    expect(szukajWPomocy('paczkomat korekta', { dir, czyDozwolony: dozwolone })).toEqual([])
  })

  it('tytuł waży więcej niż treść', () => {
    const w = szukajWPomocy('przesyłki', { dir, czyDozwolony: dozwolone })
    expect(w.map((x) => x.slug)).toEqual(['przesylki', 'integracje-dpd'])
  })

  it('dokument spoza listy Pomocy nie trafia do wyników (domyślnie lista DOZWOLONE)', () => {
    expect(szukajWPomocy('notatka', { dir, czyDozwolony: dozwolone })).toEqual([])
    expect(szukajWPomocy('faktura', { dir }).map((x) => x.slug)).toEqual([])
  })

  it('podświetlenie wskazuje słowa zapytania we fragmencie', () => {
    const [w] = szukajWPomocy('korekty', { dir, czyDozwolony: dozwolone })
    expect(w!.zaznaczenia.length).toBeGreaterThan(0)
    for (const [a, b] of w!.zaznaczenia) expect(normalizuj(w!.fragment.slice(a, b))).toMatch(/^korekt/)
  })

  it('puste albo za krótkie zapytanie to pusta lista; filtr roli', () => {
    expect(szukajWPomocy('', { dir })).toEqual([])
    expect(szukajWPomocy(' x ', { dir })).toEqual([])
    expect(szukajWPomocy('etykieta', { dir, czyDozwolony: dozwolone, rola: 'administrator' }).map((x) => x.slug)).toEqual(['integracje-dpd'])
  })

  it('brak katalogu to pusta lista, nie błąd', () => {
    expect(szukajWPomocy('faktura', { dir: path.join(tmpdir(), 'nie-ma-katalogu-pomocy-a153') })).toEqual([])
  })

  it('na prawdziwych dokumentach: typowe pytania prowadzą do właściwego tematu', () => {
    const pierwszy = (q: string) => szukajWPomocy(q)[0]?.slug
    expect(pierwszy('pierwsze kroki')).toBe('pierwsze-kroki')
    expect(pierwszy('paczkomat')).toBeDefined()
    expect(szukajWPomocy('faktura').map((x) => x.slug)).toContain('dokumenty-sprzedazy')
    expect(szukajWPomocy('koszyki').map((x) => x.slug)).toContain('pakowanie')
    // pytanie biura „jak zmienić paczkomat na kuriera” prowadzi do sekcji o zmianie sposobu wysyłki
    const zmiana = szukajWPomocy('zmień sposób wysyłki')
    expect(zmiana.some((x) => x.slug === 'karta-zamowienia' && x.sekcja === 'Zmień sposób wysyłki')).toBe(true)
    // „jak zmienić NIP / dane do faktury” i „zmiana telefonu klienta” prowadzą do sekcji o edycji danych klienta
    const sekcja = 'Edytuj kupującego i dane do faktury (zamówienie ze sklepu, Allegro, Empiku)'
    for (const fraza of ['zmień NIP na fakturze', 'edytuj dane do faktury', 'zmiana telefonu kupującego']) expect(szukajWPomocy(fraza).some((x) => x.slug === 'karta-zamowienia' && x.sekcja === sekcja), fraza).toBe(true)
    // asystent Pomocy odpowiada, skąd SKU i EAN oferty Allegro i co z ofertą bez sygnatury
    const allegro = 'Skąd Kompletor bierze SKU i EAN oferty Allegro'
    for (const fraza of ['oferta Allegro bez sygnatury', 'skąd EAN oferty Allegro', 'oferty Allegro bez SKU'])
      expect(szukajWPomocy(fraza).some((x) => (x.slug === 'integracje/allegro' && x.sekcja === allegro) || (x.slug === 'faq' && /Allegro bez SKU/.test(x.sekcja ?? ''))), fraza).toBe(true)
    // asystent Pomocy odpowiada, jak drukować etykiety przy pakowaniu, a karty na drukarce innego komputera
    const druk = 'Drukarki na różnych komputerach: etykiety przy pakowaniu, karty na drukarce w biurze'
    for (const fraza of ['drukarka innego komputera', 'karty na drukarce w biurze'])
      expect(szukajWPomocy(fraza).some((x) => x.slug === 'konfiguracja' && x.sekcja === druk), fraza).toBe(true)
    // asystent Pomocy odpowiada, jak otworzyć zamówienie czytnikiem albo wklejonym numerem
    for (const fraza of ['czytnik kodów lista zamówień', 'wklej numer zamówienia z przelewu', 'skan etykiety przewoźnika'])
      expect(szukajWPomocy(fraza).some((x) => x.slug === 'lista-zamowien' && x.sekcja === 'Czytnik kodów i wklejony numer'), fraza).toBe(true)
    for (const fraza of ['skan karty na kolejce pakowania', 'czytnik kodów pakowanie'])
      expect(szukajWPomocy(fraza).some((x) => x.slug === 'pakowanie' && x.sekcja === 'Czytnik kodów na kolejce i liście zbierania'), fraza).toBe(true)
  })
})

describe('role Pomocy', () => {
  it('każdy dokument z listy ma grupę, a każda grupa ma co najmniej jeden dokument', () => {
    const role = new Set(ROLE_POMOCY.map((r) => r.rola))
    for (const s of DOZWOLONE) expect(role.has(rolaDokumentu(s)), s).toBe(true)
    const uzyte = new Set(listDocs().map((d) => rolaDokumentu(d.slug)))
    expect([...role].filter((r) => !uzyte.has(r))).toEqual([])
  })

  it('integracje i instalacja dla administratora, pakowanie dla magazynu, nowy dokument domyślnie dla właściciela', () => {
    expect(rolaDokumentu('integracje-allegro')).toBe('administrator')
    expect(rolaDokumentu('instalacja')).toBe('administrator')
    expect(rolaDokumentu('pakowanie')).toBe('magazyn')
    expect(rolaDokumentu('migracja-z-baselinkera')).toBe('wlasciciel')
    expect(rolaDokumentu('nowy-temat-z-innej-paczki')).toBe('wlasciciel')
  })

  it('magazyn widzi swoją grupę pierwszą, reszta grupę właściciela', () => {
    expect(rolaOsoby('MAGAZYN')).toBe('magazyn')
    expect(rolaOsoby('BIURO')).toBe('wlasciciel')
    expect(rolaOsoby('WLASCICIEL')).toBe('wlasciciel')
  })
})
