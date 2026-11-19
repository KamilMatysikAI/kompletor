// kilka kart zamówień w jednym PDF (druk z kolejki pakowania) i karta bez danych odbiorcy (cień).
import { describe, expect, it } from 'vitest'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { kartyZamowien } from './index'
import { KARTA, kartaDuza } from './przyklady/dane'

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

describe('karty zamówień w jednym PDF', () => {
  it('kolejność wejścia, każda karta od nowej strony z własną numeracją stron i kodem', async () => {
    const druga = { ...KARTA, zamowienie: { przedrostek: 'EMP', numer: '77' }, numerWydruku: 2, naSucho: true, odbiorca: null }
    const dluga = kartaDuza()
    const pdf = await kartyZamowien([KARTA, druga, dluga])
    const strony = await tekstStron(pdf)
    expect(strony[0]).toContain('SD48213/1')
    expect(strony[0]).toContain('strona 1/1')
    expect(strony[1]).toContain('EMP77/2')
    expect(strony[1]).toContain('NA SUCHO')
    expect(strony[1]).toContain('Odbiorca: brak danych odbiorcy w zamówieniu')
    expect(strony[1]).toContain('unieważnia wydruk 1')
    expect(strony[1]).toContain('strona 1/1')
    const reszta = strony.slice(2)
    expect(reszta.length).toBeGreaterThan(1)
    reszta.forEach((s, i) => expect(s).toContain(`strona ${i + 1}/${reszta.length}`))
  })

  it('pominięte zamówienia jako ostatnia strona „Pominięto: …”, karty bez zmian', async () => {
    const strony = await tekstStron(await kartyZamowien([KARTA], { pominiete: ['SD 48302', 'SD 48303'] }))
    expect(strony).toHaveLength(2)
    expect(strony[0]).toContain('SD48213/1')
    expect(strony[1]).toContain('Pominięto: SD 48302, SD 48303')
    expect(strony[1]).toContain('bez karty: 2')
    expect(await tekstStron(await kartyZamowien([KARTA], { pominiete: [] }))).toHaveLength(1)
  })

  it('pusta lista i zły numer jednej karty = błąd przed rysowaniem', async () => {
    await expect(kartyZamowien([])).rejects.toThrow(/Brak kart/)
    await expect(kartyZamowien([KARTA, { ...KARTA, zamowienie: { przedrostek: 'ALG', numer: 'uuid-x' } }])).rejects.toThrow(/cyfry/)
  })
})
