// Fikcyjne dane do testów i przykładowych PDF (żadnych prawdziwych klientów).
import zlib from 'node:zlib'
import type {
  EtykietaProduktuDane,
  KartaZamowieniaDane,
  ListaWysylkowaDane,
  PozycjaKarty,
  SpisProduktowDane,
} from '../typy'

const CRC = (() => {
  const t: number[] = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t.push(c >>> 0)
  }
  return t
})()

function crc32(b: Buffer): number {
  let c = 0xffffffff
  for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(typ: string, dane: Buffer): Buffer {
  const dl = Buffer.alloc(4)
  dl.writeUInt32BE(dane.length)
  const td = Buffer.concat([Buffer.from(typ, 'ascii'), dane])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([dl, td, crc])
}

/** PNG z dowolnym nagłówkiem i surowym IDAT (do testów bramki miniatur, 26.10.2026). */
export function pngTestowy(o: {
  szerokosc: number
  wysokosc: number
  typKoloru: number
  glebia?: number
  przeplot?: number
  idat: Buffer
}): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(o.szerokosc, 0)
  ihdr.writeUInt32BE(o.wysokosc, 4)
  ihdr[8] = o.glebia ?? 8
  ihdr[9] = o.typKoloru
  ihdr[12] = o.przeplot ?? 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', o.idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Miniatura PNG 28×28 w jednym kolorze z ramką — zastępuje zdjęcie produktu w przykładach. */
export function miniaturaPng(r: number, g: number, b: number, bok = 28): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(bok, 0)
  ihdr.writeUInt32BE(bok, 4)
  ihdr[8] = 8 // głębia
  ihdr[9] = 2 // RGB
  const wiersze: Buffer[] = []
  for (let y = 0; y < bok; y++) {
    const w = Buffer.alloc(1 + bok * 3)
    for (let x = 0; x < bok; x++) {
      const ramka = x < 2 || y < 2 || x >= bok - 2 || y >= bok - 2
      w[1 + x * 3] = ramka ? 40 : r
      w[2 + x * 3] = ramka ? 40 : g
      w[3 + x * 3] = ramka ? 40 : b
    }
    wiersze.push(w)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(wiersze))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

export const WYDRUKOWANO = new Date('2026-10-25T12:32:00Z') // 13:32 w Warszawie (od 25.10.2026 już czas zimowy, UTC+1)

export const POZYCJE_KARTY: PozycjaKarty[] = [
  { lokalizacja: 'B-3-10', nazwa: 'Kurkuma mielona Ogrodowa', wariant: '250 g', sku: 'SD-SEN-250', ilosc: 250, jednostka: 'g', miniatura: miniaturaPng(90, 160, 90) },
  { lokalizacja: 'A-1-2', nazwa: 'Świeca zapachowa Różana z płatkami', sku: 'SW-ROZ', ilosc: 3, jednostka: 'szt', miniatura: miniaturaPng(220, 120, 150) },
  { lokalizacja: null, nazwa: 'Kubek ceramiczny „Żółć słoneczna” — edycja jesienna, pojemność 350 ml, z ręcznie malowanym wzorem liści dębu i klonu, pakowany w ozdobne pudełko', wariant: 'żółty', sku: 'AKC-KUB-ZOL', ilosc: 1, jednostka: 'szt' },
  { lokalizacja: 'B-3-9', nazwa: 'Pieprz czarny Złocisty', wariant: '100 g', sku: 'SD-ASS-100', ilosc: 2, jednostka: 'szt', miniatura: miniaturaPng(140, 80, 40) },
  { lokalizacja: 'C-12-1', nazwa: 'Papryka wędzona Kolorowa', wariant: '30 g', sku: 'PW-30', ilosc: 1, jednostka: 'szt', miniatura: Buffer.from('to nie jest obraz') },
  { lokalizacja: 'A-1-10', nazwa: 'Zaparzacz stalowy kulka', sku: 'AKC-ZAP-K', ilosc: 1, jednostka: 'szt' },
]

export const KARTA: KartaZamowieniaDane = {
  zamowienie: { przedrostek: 'SD', numer: '48213' },
  kanal: 'Sklep Demo',
  dataZamowienia: new Date('2026-10-24T18:05:00Z'),
  przewoznik: 'InPost',
  metodaDostawy: 'Paczkomat',
  numerWydruku: 1,
  wydrukowano: WYDRUKOWANO,
  drukujacy: 'Zofia Próbna',
  odbiorca: { imie: 'Jan', nazwisko: 'Testowy', miasto: 'Testowo' },
  uwagiMagazynu: 'Dołożyć próbkę gratis (ustalone z klientem). Zapakować ostrożnie — szkło!',
  uwagiKlienta: 'Proszę o zapakowanie na prezent, dziękuję. Zażółć gęślą jaźń.',
  pozycje: POZYCJE_KARTY,
}

/** 40 pozycji — przechodzi na drugą stronę. */
/** karta drukowana przez osobę z uprawnieniem `klienci.dane` — blok ODBIORCA z pełnym adresem (fikcyjnym). */
export const KARTA_Z_ADRESEM: KartaZamowieniaDane = {
  ...KARTA,
  odbiorca: { imie: 'Jan', nazwisko: 'Testowy', miasto: 'Testowo' },
  adresOdbiorcy: ['Jan Testowy', 'ul. Fikcyjna 1/2', '00-000 Testowo', 'tel. +48 500 000 000'],
}

export function kartaDuza(): KartaZamowieniaDane {
  const pozycje: PozycjaKarty[] = Array.from({ length: 40 }, (_, i) => ({
    lokalizacja: `${'ABCD'[i % 4]}-${(i % 7) + 1}-${(i % 12) + 1}`,
    nazwa: `Przyprawa testowa nr ${i + 1} — mieszanka ziół łąkowych`,
    wariant: i % 3 === 0 ? '50 g' : null,
    sku: `TST-${String(i + 1).padStart(3, '0')}`,
    ilosc: (i % 4) + 1,
    jednostka: 'szt',
  }))
  return {
    ...KARTA,
    zamowienie: { przedrostek: 'ALG', numer: '1023', podzamowienie: 2 },
    kanal: 'Allegro',
    przewoznik: 'DPD',
    metodaDostawy: 'Kurier',
    naSucho: true,
    numerWydruku: 2,
    uwagiMagazynu: null,
    uwagiKlienta: null,
    pozycje,
  }
}

export const LISTA: ListaWysylkowaDane = {
  dataOdbioru: new Date('2026-10-25T13:00:00Z'),
  opisOdbioru: 'odbiór popołudniowy',
  wydrukowano: WYDRUKOWANO,
  drukujacy: 'Zofia Próbna',
  zamowienia: [
    { zamowienie: { przedrostek: 'SD', numer: '48213' }, przewoznik: 'InPost', liczbaPaczek: 1, numeryNadania: ['620000000000000000000001'], odbiorca: { imie: 'Jan', nazwisko: 'Testowy', miasto: 'Testowo' } },
    { zamowienie: { przedrostek: 'ALG', numer: '1023', podzamowienie: 2 }, przewoznik: 'DPD', liczbaPaczek: 2, numeryNadania: ['0000000000001U', '0000000000002U'], odbiorca: { imie: 'Anna', nazwisko: 'Przykładowa', miasto: 'Łódź Testowa' } },
    { zamowienie: { przedrostek: 'EMP', numer: '77' }, przewoznik: 'InPost', liczbaPaczek: 1, numeryNadania: ['620000000000000000000002'], odbiorca: { imie: 'Michał', nazwisko: 'Żółtowski-Testowy', miasto: 'Gdańsk Próbny' } },
    { zamowienie: { przedrostek: 'BH', numer: '5120' }, przewoznik: 'DPD', liczbaPaczek: 1, numeryNadania: [], odbiorca: { imie: 'Ewa', nazwisko: 'Śliwińska-Fikcyjna', miasto: 'Testowo' } },
  ],
}

export const SPIS: SpisProduktowDane = {
  strefa: 'przyprawy i kawy',
  wydrukowano: WYDRUKOWANO,
  drukujacy: 'Zofia Próbna',
  pozycje: [
    { lokalizacja: 'B-3-10', nazwa: 'Kurkuma mielona Ogrodowa', sku: 'SD-SEN', jednostka: 'g', fizyczny: 4250, zarezerwowany: 500, strefa: 'przyprawy i kawy' },
    { lokalizacja: 'B-3-9', nazwa: 'Pieprz czarny Złocisty', sku: 'SD-ASS-100', jednostka: 'szt', fizyczny: 12, zarezerwowany: 2, strefa: 'przyprawy i kawy' },
    { lokalizacja: 'A-1-2', nazwa: 'Świeca zapachowa Różana', sku: 'SW-ROZ', jednostka: 'szt', fizyczny: 40, zarezerwowany: 3, strefa: 'świece i akcesoria' },
    { lokalizacja: null, nazwa: 'Kawa ziarnista Brazylia Santos — nowa dostawa, jeszcze bez miejsca na regale', sku: 'KW-BRA', jednostka: 'g', fizyczny: 1000, zarezerwowany: 0, strefa: 'Przyprawy i kawy' },
    { lokalizacja: 'B-10-1', nazwa: 'Pieprz biały ziarnisty', sku: 'SD-PMT', jednostka: 'szt', fizyczny: 1, zarezerwowany: 2, strefa: 'przyprawy i kawy' },
  ],
}

export const ETYKIETA: EtykietaProduktuDane = {
  nazwa: 'Kurkuma mielona Ogrodowa z płatkami róży',
  sklad:
    'Skład: kurkuma mielona (85%), płatki róży (10%), aromat naturalny. Sposób przygotowania: 1 łyżeczkę ' +
    'zalać 200 ml wody o temperaturze 75–80°C, parzyć 2–3 minuty. Przechowywać w suchym, chłodnym miejscu, ' +
    'z dala od światła. Producent: Firma Testowa sp. z o.o., ul. Przykładowa 1, 00-000 Testowo.',
  masa: '50 g',
  numerPartii: 'P2026-10-A',
  data: new Date('2028-10-31T12:00:00Z'),
}
