// wydruk informacyjny w PDF kart — bez kodu kreskowego, z pasem powodu i wszystkimi pozycjami, przemieszany
// z kartami do zbierania w kolejności wejścia. Dane fikcyjne.
import { describe, expect, it, vi } from 'vitest'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { kartyZamowien, type KartaInformacyjnaDane } from './index'
import { KARTA } from './przyklady/dane'

const kody = vi.hoisted(() => [] as string[])
vi.mock('./wspolne', async (orig) => {
  const m = await orig<typeof import('./wspolne')>()
  return { ...m, rysujKod128: (...a: Parameters<typeof m.rysujKod128>) => (kody.push(a[1]), m.rysujKod128(...a)) }
})

async function tekstStron(pdf: Buffer): Promise<string[]> {
  const zadanie = getDocument({ data: new Uint8Array(pdf), useSystemFonts: false })
  const dokument = await zadanie.promise
  const strony: string[] = []
  for (let i = 1; i <= dokument.numPages; i++) {
    const tresc = await (await dokument.getPage(i)).getTextContent()
    strony.push(tresc.items.map((x) => ('str' in x ? x.str : '')).join(' ').replace(/\s+/g, ' '))
  }
  await zadanie.destroy()
  return strony
}

const INFORMACYJNA: KartaInformacyjnaDane = {
  informacyjna: true,
  powod: 'zamówienie wysłane',
  numer: 'ALG 2f961f8-4…',
  kanal: 'Allegro',
  status: 'Wysłane',
  dataZamowienia: new Date('2026-10-24T18:05:00Z'),
  przewoznik: 'InPost',
  metodaDostawy: 'Paczkomat',
  wydrukowano: new Date('2026-11-10T20:00:00Z'),
  drukujacy: 'Osoba Testowa',
  odbiorca: { imie: 'Jan', nazwisko: 'Testowy', miasto: 'Testowo' },
  pozycje: [
    { nazwa: 'Towar zebrany', sku: 'TST-1', ilosc: 2, jednostka: 'szt' },
    { nazwa: 'Towar brakujący', sku: 'TST-2', ilosc: 1, jednostka: 'szt', oznaczenie: 'brak' },
    { nazwa: 'Poradnik elektroniczny', sku: 'TST-E', ilosc: 1, jednostka: 'szt', oznaczenie: 'bez stanu' },
  ],
}

describe('wydruk informacyjny', () => {
  it('bez kodu kreskowego i numeru wydruku; pas z powodem i wszystkie pozycje z oznaczeniami', async () => {
    kody.length = 0
    const strony = await tekstStron(await kartyZamowien([INFORMACYJNA]))
    expect(kody).toEqual([])
    expect(strony).toHaveLength(1)
    expect(strony[0]).toContain('Wydruk informacyjny: zamówienie wysłane')
    expect(strony[0]).toContain('ALG 2f961f8-4…')
    expect(strony[0]).toContain('status: Wysłane')
    expect(strony[0]).toContain('Towar zebrany')
    expect(strony[0]).toContain('BRAK NA STANIE')
    expect(strony[0]).toContain('BEZ STANU (bez wysyłki)')
    expect(strony[0]).toContain('Odbiorca: Jan Testowy')
    expect(strony[0]).toContain('bez kodu karty, nie do skanowania')
    expect(strony[0]).not.toMatch(/Wydruk \d/)
  })

  it('przemieszane z kartami do zbierania w kolejności wejścia; kod rysują tylko karty do zbierania', async () => {
    kody.length = 0
    const druga = { ...KARTA, zamowienie: { przedrostek: 'EMP', numer: '77' } }
    const strony = await tekstStron(await kartyZamowien([KARTA, INFORMACYJNA, druga, { ...INFORMACYJNA, powod: 'zamówienie anulowane', numer: 'SD 9' }]))
    expect(strony).toHaveLength(4)
    expect(kody).toEqual(['SD48213/1', 'EMP77/1'])
    expect(strony[0]).toContain('SD48213/1')
    expect(strony[1]).toContain('Wydruk informacyjny: zamówienie wysłane')
    expect(strony[2]).toContain('EMP77/1')
    expect(strony[3]).toContain('Wydruk informacyjny: zamówienie anulowane')
    expect(strony[3]).toContain('strona 1/1')
  })

  it('długie zamówienie przechodzi na kolejną stronę z powtórzonym pasem; numer nieliczbowy nie jest błędem', async () => {
    const pozycje = Array.from({ length: 45 }, (_, i) => ({ nazwa: `Pozycja testowa ${i + 1}`, sku: `T-${i}`, ilosc: 1, jednostka: 'szt' as const }))
    const strony = await tekstStron(await kartyZamowien([{ ...INFORMACYJNA, pozycje, numer: 'ALG uuid-bez-cyfr' }]))
    expect(strony.length).toBeGreaterThan(1)
    strony.forEach((s, i) => {
      expect(s).toContain('Wydruk informacyjny: zamówienie wysłane')
      expect(s).toContain(`strona ${i + 1}/${strony.length}`)
    })
  })
})
