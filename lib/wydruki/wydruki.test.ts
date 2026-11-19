import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  etykietaProduktu,
  kartaZamowienia,
  kodKarty,
  listaWysylkowa,
  odczytajKodKarty,
  porownajLokalizacje,
  pozycjeSpisu,
  sortujPoLokalizacji,
  spisProduktow,
  formatIlosc,
} from './index'
import { ETYKIETA, KARTA, LISTA, SPIS, WYDRUKOWANO, kartaDuza, pngTestowy } from './przyklady/dane'
import { MAKS_ROZMIAR_MINIATURY, obrazDoWydruku } from './obraz'
import { bezBrakujacychGlifow } from './wspolne'

async function otworz(pdf: Buffer) {
  const zadanie = getDocument({ data: new Uint8Array(pdf), useSystemFonts: false })
  return { dokument: await zadanie.promise, zamknij: () => zadanie.destroy() }
}

/** Tekst każdej strony PDF (pdf.js czyta ToUnicode osadzonego fontu — sprawdza też polskie znaki). */
async function tekstStron(pdf: Buffer): Promise<string[]> {
  const { dokument, zamknij } = await otworz(pdf)
  const strony: string[] = []
  for (let i = 1; i <= dokument.numPages; i++) {
    const tresc = await (await dokument.getPage(i)).getTextContent()
    strony.push(tresc.items.map((x) => ('str' in x ? x.str : '')).join(' ').replace(/\s+/g, ' '))
  }
  await zamknij()
  return strony
}

function toPdf(pdf: Buffer): void {
  expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  expect(pdf.subarray(-8).toString('latin1')).toContain('%%EOF')
}

describe('sortowanie lokalizacji', () => {
  it('naturalnie po członach regał-półka-miejsce, bez lokalizacji na końcu', () => {
    const wej = ['B-3-10', null, 'A-1-2', 'B-3-9', '', 'B-10-1', 'A-1-10', 'B-9-1', 'a-1-3', 'C-1']
    const wynik = sortujPoLokalizacji(wej.map((lokalizacja, i) => ({ lokalizacja, i }))).map((p) => p.lokalizacja)
    expect(wynik).toEqual(['A-1-2', 'a-1-3', 'A-1-10', 'B-3-9', 'B-3-10', 'B-9-1', 'B-10-1', 'C-1', null, ''])
  })

  it('jest stabilne dla tej samej lokalizacji i krótszej ścieżki', () => {
    expect(porownajLokalizacje('B-3', 'B-3-1')).toBeLessThan(0)
    expect(porownajLokalizacje(null, undefined)).toBe(0)
    const p = sortujPoLokalizacji([
      { lokalizacja: 'A-1-1', n: 1 },
      { lokalizacja: 'A-1-1', n: 2 },
    ])
    expect(p.map((x) => x.n)).toEqual([1, 2])
  })
})

describe('kod kreskowy karty', () => {
  it('numerZamówienia/numerWydruku bez spacji, dosyłka z -N', () => {
    expect(kodKarty({ przedrostek: 'SD', numer: '48213' }, 1)).toBe('SD48213/1')
    expect(kodKarty({ przedrostek: 'SD', numer: '48213' }, 2)).toBe('SD48213/2')
    expect(kodKarty({ przedrostek: 'SD', numer: '48213', podzamowienie: 2 }, 1)).toBe('SD48213-2/1')
    expect(kodKarty({ przedrostek: 'alg', numer: '1023' }, 3)).toBe('ALG1023/3')
  })

  it('odrzuca zły numer wydruku i numer spoza wzoru', () => {
    expect(() => kodKarty({ przedrostek: 'SD', numer: '48213' }, 0)).toThrow()
    expect(() => kodKarty({ przedrostek: 'SD', numer: '48 213' }, 1)).toThrow()
  })

  it('przedrostek i numer sprawdzane osobno — E1 + 5 nie daje dwuznacznego E15/1', () => {
    expect(() => kodKarty({ przedrostek: 'E1', numer: '5' }, 1)).toThrow(/Przedrostek/)
    expect(() => kodKarty({ przedrostek: '', numer: '5' }, 1)).toThrow(/Przedrostek/)
    expect(() => kodKarty({ przedrostek: 'ALG', numer: '3f2c1a9e-7b4d-4e1a-9c0b-1d2e3f4a5b6c' }, 1)).toThrow(/cyfry/)
    expect(() => kodKarty({ przedrostek: 'SD', numer: '48213', podzamowienie: 0.5 }, 1)).toThrow(/podzamówienia/)
  })

  it('odczyt kodu z identyfikatorem AIM ze skanera', () => {
    expect(odczytajKodKarty(']C1SD48213/1')).toEqual({
      zamowienie: { przedrostek: 'SD', numer: '48213', podzamowienie: null },
      numerWydruku: 1,
    })
    expect(odczytajKodKarty(']C0SD48213-2/3\r\n')?.numerWydruku).toBe(3)
  })

  it('odczyt zeskanowanego kodu', () => {
    expect(odczytajKodKarty('SD48213-2/1')).toEqual({
      zamowienie: { przedrostek: 'SD', numer: '48213', podzamowienie: 2 },
      numerWydruku: 1,
    })
    expect(odczytajKodKarty(' emp77/4 ')?.numerWydruku).toBe(4)
    expect(odczytajKodKarty('5901234123457')).toBeNull()
  })
})

describe('karta zamówienia', () => {
  it('daje poprawny PDF z nagłówkiem, kodem, polskimi znakami i danymi klienta tylko w skrócie', async () => {
    const pdf = await kartaZamowienia(KARTA)
    toPdf(pdf)
    const [s1, ...reszta] = await tekstStron(pdf)
    expect(reszta).toHaveLength(0)
    expect(s1).toContain('SD 48213')
    expect(s1).toContain('SD48213/1')
    expect(s1).toContain('Sklep Demo · 24.10.2026')
    expect(s1).toContain('InPost Paczkomat')
    expect(s1).toContain('Jan Testowy, Testowo')
    expect(s1).not.toContain('NA SUCHO')
    expect(s1).toContain('UWAGI DLA MAGAZYNU')
    expect(s1).toContain('Zażółć gęślą jaźń')
    for (const z of 'ąćęłńóśźż') expect(s1).toContain(z)
    expect(s1).toContain('„Żółć słoneczna”')
    expect(s1).toContain('3 szt.')
    expect(s1).toContain('250 g')
    expect(s1).toContain('SKU: SD-ASS-100')
    expect(s1).toContain('Wariant: 100 g')
    expect(s1).toContain('Wydruk 1 · 25.10.2026 13:32 · drukował(a): Zofia Próbna')
  })

  it('pozycje idą po lokalizacji, bez lokalizacji na końcu', async () => {
    const [s1] = await tekstStron(await kartaZamowienia(KARTA))
    const kolejnosc = ['A-1-2', 'A-1-10', 'B-3-9', 'B-3-10', 'C-12-1', 'Kubek ceramiczny'].map((t) => s1!.indexOf(t))
    expect(kolejnosc.every((x) => x >= 0)).toBe(true)
    expect([...kolejnosc].sort((a, b) => a - b)).toEqual(kolejnosc)
  })

  it('zawija długą nazwę zamiast ją ucinać', async () => {
    const [s1] = await tekstStron(await kartaZamowienia(KARTA))
    expect(s1).toContain('pakowany w ozdobne pudełko')
    expect(s1).not.toContain('…')
  })

  it('40 pozycji przechodzi na kolejne strony z powtórzonym nagłówkiem i kodem', async () => {
    const pdf = await kartaZamowienia(kartaDuza())
    toPdf(pdf)
    const strony = await tekstStron(pdf)
    expect(strony.length).toBeGreaterThanOrEqual(2)
    for (const [i, s] of strony.entries()) {
      expect(s).toContain('ALG 1023-2')
      expect(s).toContain('ALG1023-2/2')
      expect(s).toContain('NA SUCHO')
      expect(s).toContain('DPD Kurier')
      expect(s).toContain('LOKALIZACJA')
      expect(s).toContain(`strona ${i + 1}/${strony.length}`)
      expect(s).toContain('unieważnia wydruk 1')
    }
    const wszystko = strony.join(' ')
    for (let n = 1; n <= 40; n++) expect(wszystko).toContain(`TST-${String(n).padStart(3, '0')}`)
  })

  it('wariant jedna pozycja na kartę: tyle stron, ile pozycji, kod na każdej', async () => {
    const strony = await tekstStron(await kartaZamowienia(KARTA, { jednaPozycjaNaKarte: true }))
    expect(strony).toHaveLength(KARTA.pozycje.length)
    strony.forEach((s, i) => {
      expect(s).toContain('SD48213/1')
      expect(s).toContain(`Pozycja ${i + 1} z ${KARTA.pozycje.length}`)
    })
    expect(strony[0]).toContain('A-1-2')
    expect(strony.at(-1)).toContain('Kubek ceramiczny')
  })

  it('pusta lista pozycji nie przerywa wydruku', async () => {
    const pdf = await kartaZamowienia({ ...KARTA, pozycje: [] })
    const [s1] = await tekstStron(pdf)
    expect(s1).toContain('Brak pozycji')
  })

  it('zepsuty PNG z alfą: promise się rozstrzyga, pozycja jest na karcie, proces nie pada', async () => {
    // RGBA 8 bit, IDAT to nie deflate — przed poprawką png-js rzucał „incorrect header check” z callbacka
    // zlib (uncaughtException; vitest zgłosiłby nieobsłużony błąd). Teraz bramka daje puste pole.
    const zepsuty = pngTestowy({ szerokosc: 28, wysokosc: 28, typKoloru: 6, idat: Buffer.from('to nie jest deflate') })
    expect(obrazDoWydruku(zepsuty)).toBeNull()
    const pozycje = KARTA.pozycje.map((p) => (p.lokalizacja === 'C-12-1' ? { ...p, miniatura: zepsuty } : p))
    for (const opcje of [{}, { jednaPozycjaNaKarte: true }]) {
      const strony = await tekstStron(await kartaZamowienia({ ...KARTA, pozycje }, opcje))
      expect(strony.join(' ')).toContain('C-12-1')
      expect(strony.join(' ')).toContain('Papryka wędzona Kolorowa')
    }
    // Chwila dla pętli zdarzeń: asynchroniczny inflate z png-js (gdyby ruszył) zdążyłby rzucić.
    await new Promise((r) => setTimeout(r, 50))
  })

  it('bramka miniatur: poprawne PNG i JPEG przechodzą, reszta = brak zdjęcia', async () => {
    const rgba = (w: number, h: number, filtr = 0) =>
      zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => Buffer.from([filtr, ...new Array<number>(w * 4).fill(200)]))))
    const dobryAlfa = pngTestowy({ szerokosc: 4, wysokosc: 3, typKoloru: 6, idat: rgba(4, 3) })
    expect(obrazDoWydruku(dobryAlfa)).toBe(dobryAlfa)
    // Przeplot = brak zdjęcia (K1-r: png-js psuje się na pustych przejściach Adam7 przy wąskich obrazach).
    expect(obrazDoWydruku(pngTestowy({ szerokosc: 1, wysokosc: 1, typKoloru: 6, przeplot: 1, idat: rgba(1, 1) }))).toBeNull()
    // Cyrylica bez glifów nie znika bez śladu (W-D2): ciąg brakujących znaków → jeden „?”.
    expect(bezBrakujacychGlifow({ hasGlyphForCodePoint: (k) => k < 0x400 }, 'Олена, 15:00')).toBe('?, 15:00')
    // Zły bajt filtra (png-js: „Invalid filter algorithm” z callbacka), za mało danych, za duży bok.
    expect(obrazDoWydruku(pngTestowy({ szerokosc: 4, wysokosc: 3, typKoloru: 6, idat: rgba(4, 3, 7) }))).toBeNull()
    expect(obrazDoWydruku(pngTestowy({ szerokosc: 4, wysokosc: 4, typKoloru: 6, idat: rgba(4, 3) }))).toBeNull()
    expect(obrazDoWydruku(pngTestowy({ szerokosc: 5000, wysokosc: 1, typKoloru: 6, idat: rgba(1, 1) }))).toBeNull()
    // Głębia < 8 z przeplotem (ułamkowe bajty na piksel w png-js).
    const szary4bit = zlib.deflateSync(Buffer.from([0, 0]))
    expect(obrazDoWydruku(pngTestowy({ szerokosc: 1, wysokosc: 1, typKoloru: 0, glebia: 4, przeplot: 1, idat: szary4bit }))).toBeNull()
    expect(obrazDoWydruku(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).not.toBeNull()
    expect(obrazDoWydruku(Buffer.from('RIFF....WEBPVP8 '))).toBeNull()
    const duzy = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(MAKS_ROZMIAR_MINIATURY)])
    expect(obrazDoWydruku(duzy)).toBeNull()
    // Poprawny PNG z alfą faktycznie trafia do PDF (pdfkit wydziela alfę do SMask).
    const pdf = await kartaZamowienia({ ...KARTA, pozycje: [{ ...KARTA.pozycje[0]!, miniatura: dobryAlfa }] })
    expect(pdf.toString('latin1')).toContain('/SMask')
  })

  it('uwagi klienta 8000 znaków: jedna strona, tabela na niej', async () => {
    const uwagi = 'Proszę zapakować ostrożnie, to prezent dla babci. '.repeat(160).slice(0, 8000)
    const strony = await tekstStron(await kartaZamowienia({ ...KARTA, uwagiKlienta: uwagi }))
    expect(strony).toHaveLength(1)
    expect(strony[0]).toContain('LOKALIZACJA')
    expect(strony[0]).toContain('A-1-2')
    expect(strony[0]).toContain('Kubek ceramiczny')
    expect(strony[0]).toContain('strona 1/1')
  })

  it('nazwa 4000 znaków w wariancie 1 pozycja/karta: strona na pozycję, kod na każdej', async () => {
    const pozycje = KARTA.pozycje.map((p, i) => (i === 0 ? { ...p, nazwa: 'Przyprawa bardzo długa '.repeat(200) } : p))
    const strony = await tekstStron(await kartaZamowienia({ ...KARTA, pozycje }, { jednaPozycjaNaKarte: true }))
    expect(strony).toHaveLength(pozycje.length)
    for (const s of strony) expect(s).toContain('SD48213/1')
  })

  it('stopka nad strefą niedrukowalną: linia bazowa ok. 6,9 mm od dołu', async () => {
    const { dokument, zamknij } = await otworz(await kartaZamowienia(KARTA))
    const tresc = await (await dokument.getPage(1)).getTextContent()
    const stopka = tresc.items.find((x) => 'str' in x && x.str.includes('strona 1/1'))
    expect(stopka).toBeDefined()
    const yMm = ((stopka as { transform: number[] }).transform[5]! * 25.4) / 72
    expect(yMm).toBeGreaterThan(6.5)
    expect(yMm).toBeLessThan(7.5)
    await zamknij()
  })

  it('znaki spoza fontu: bez U+0000 w tekście, zamienniki zamiast „tofu”', async () => {
    const uwagi = 'Curry™ → szybko, ≥ 2 szt., Ștefan 🙂 dzięki'
    const [s1] = await tekstStron(await kartaZamowienia({ ...KARTA, uwagiKlienta: uwagi }))
    expect(s1).not.toContain('\u0000')
    expect(s1).toContain('Curry(TM) -> szybko, >= 2 szt., Stefan')
    expect(s1).toContain('dzięki')
  })

  it('te same dane = te same bajty PDF', async () => {
    expect((await kartaZamowienia(KARTA)).equals(await kartaZamowienia(KARTA))).toBe(true)
    const e1 = await etykietaProduktu(ETYKIETA, { utworzono: WYDRUKOWANO })
    expect(e1.equals(await etykietaProduktu(ETYKIETA, { utworzono: WYDRUKOWANO }))).toBe(true)
  })
})

describe('lista wysyłkowa', () => {
  it('tabela, suma paczek per przewoźnik, miejsce na podpis', async () => {
    const pdf = await listaWysylkowa(LISTA)
    toPdf(pdf)
    const strony = await tekstStron(pdf)
    expect(strony).toHaveLength(1)
    const s = strony[0]!
    expect(s).toContain('Lista wysyłkowa')
    expect(s).toContain('ALG 1023-2')
    expect(s).toContain('0000000000001U')
    expect(s).toContain('Michał Żółtowski-Testowy')
    expect(s).toMatch(/DPD 2 3/)
    expect(s).toMatch(/InPost 2 2/)
    expect(s).toMatch(/Razem 4 5/)
    expect(s).toContain('Podpis kuriera')
  })

  it('długa lista przechodzi na kolejną stronę', async () => {
    const zamowienia = Array.from({ length: 70 }, (_, i) => ({ ...LISTA.zamowienia[i % 4]!, zamowienie: { przedrostek: 'SD', numer: String(50000 + i) } }))
    const strony = await tekstStron(await listaWysylkowa({ ...LISTA, zamowienia }))
    expect(strony.length).toBeGreaterThanOrEqual(2)
    for (const s of strony) expect(s).toContain('NUMER NADANIA')
    expect(strony.at(-1)).toContain('Podpis kuriera')
  })
})

describe('spis produktów', () => {
  it('filtr po strefie (bez wielkości liter) i sortowanie po lokalizacji', () => {
    expect(pozycjeSpisu(SPIS).map((p) => p.sku)).toEqual(['SD-ASS-100', 'SD-SEN', 'SD-PMT', 'KW-BRA'])
    expect(pozycjeSpisu({ ...SPIS, strefa: 'ŚWIECE I AKCESORIA' }).map((p) => p.sku)).toEqual(['SW-ROZ'])
    expect(pozycjeSpisu({ ...SPIS, strefa: null })).toHaveLength(5)
  })

  it('PDF ze stanami, dostępny liczony, gdy go nie podano', async () => {
    const pdf = await spisProduktow(SPIS)
    toPdf(pdf)
    const [s] = await tekstStron(pdf)
    expect(s).toContain('Spis produktów — strefa: przyprawy i kawy')
    expect(s).toContain('4250 g 500 g 3750 g')
    expect(s).toContain('1 szt. 2 szt. -1 szt.')
    expect(s).not.toContain('Lampa przyprawowa')
    expect(s!.indexOf('B-3-9')).toBeLessThan(s!.indexOf('B-3-10'))
    expect(s!.indexOf('B-3-10')).toBeLessThan(s!.indexOf('B-10-1'))
  })
})

describe('etykieta produktu', () => {
  it('domyślnie 100 × 50 mm, pola opcjonalne', async () => {
    const pdf = await etykietaProduktu(ETYKIETA)
    toPdf(pdf)
    const [s] = await tekstStron(pdf)
    expect(s).toContain('Kurkuma mielona')
    expect(s).toContain('Masa netto: 50 g')
    expect(s).toContain('Partia: P2026-10-A')
    expect(s).toContain('Najlepiej spożyć przed: 31.10.2028')
    const { dokument: dok, zamknij } = await otworz(pdf)
    const [, , w, h] = (await dok.getPage(1)).view
    expect(Math.round((w! * 25.4) / 72)).toBe(100)
    expect(Math.round((h! * 25.4) / 72)).toBe(50)
    await zamknij()

    const minimalna = await tekstStron(await etykietaProduktu({ nazwa: 'Świeca zapachowa Różana' }))
    expect(minimalna[0]).toContain('Świeca zapachowa Różana')
    expect(minimalna[0]).not.toContain('Partia')
  })

  it('rozmiar i kopie z parametrów', async () => {
    const pdf = await etykietaProduktu(ETYKIETA, { szerokoscMm: 60, wysokoscMm: 40, kopie: 3 })
    const { dokument: dok, zamknij } = await otworz(pdf)
    expect(dok.numPages).toBe(3)
    const [, , w, h] = (await dok.getPage(3)).view
    expect(Math.round((w! * 25.4) / 72)).toBe(60)
    expect(Math.round((h! * 25.4) / 72)).toBe(40)
    await zamknij()
    await expect(etykietaProduktu(ETYKIETA, { szerokoscMm: 10, wysokoscMm: 10 })).rejects.toThrow()
  })
})

describe('formatowanie', () => {
  it('ilości w sztukach i gramach', () => {
    expect(formatIlosc(2, 'szt')).toBe('2 szt.')
    expect(formatIlosc(250, 'g')).toBe('250 g')
    expect(formatIlosc(12.5, 'g')).toBe('12,5 g')
  })
})
