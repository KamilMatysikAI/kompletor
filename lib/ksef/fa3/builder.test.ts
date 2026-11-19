// builder FA(3). Stawki, sumy od brutto, kolejność elementów, NIP, znaki zakazane, ucieczka XML, zakres
// (PLN, VAT). Dane fikcyjne: NIP 1111111111 i 9876543210 mają poprawną sumę kontrolną i nie należą do nikogo.
import { describe, expect, it } from 'vitest'
import { escapeXml, ilosc, kwota, poprawnyNip, sumaStawki, ZAKAZANE_ZNAKI, zbudujFa3 } from './builder'
import { FA3_NAMESPACE, type WejscieFa3, type WierszFa3 } from './typy'

const SPRZEDAWCA = { nip: '1111111111', nazwa: 'Sprzedawca Testowy sp. z o.o.', adres: { kodKraju: 'PL', linia1: 'ul. Fikcyjna 1', linia2: '00-001 Warszawa' } }
const wiersz = (o: Partial<WierszFa3> = {}): WierszFa3 => ({ nazwa: 'Przyprawa testowa', jednostka: 'szt.', ilosc: 2, cenaBruttoGr: 1230, bruttoGr: 2460, stawka: '23', ...o })
const wej = (o: Partial<WejscieFa3> = {}): WejscieFa3 => ({
  numer: 'SZKIC-abc',
  dataWystawienia: '2026-11-02',
  wytworzono: new Date('2026-11-02T10:00:00.123Z'),
  waluta: 'PLN',
  rodzaj: 'VAT',
  sprzedawca: SPRZEDAWCA,
  nabywca: { nip: null, nazwa: 'Nabywca (uzupełniany przy wysyłce)' },
  wiersze: [wiersz()],
  ...o,
})
const kody = (w: WejscieFa3) => zbudujFa3(w).problemy.map((p) => p.kod)
/** Nazwy elementów w kolejności wystąpienia. */
const elementy = (xml: string) => [...xml.matchAll(/<([A-Za-z_0-9]+)[\s>]/g)].map((m) => m[1]!)

describe('pomocnicze', () => {
  it('NIP: suma kontrolna, spacje i myślniki, długość', () => {
    expect(poprawnyNip('1111111111')).toBe(true)
    expect(poprawnyNip('987-654-32-10')).toBe(true)
    expect(poprawnyNip('1234563218')).toBe(true)
    expect(poprawnyNip('1234563219')).toBe(false)
    expect(poprawnyNip('123456321')).toBe(false)
    // prefiks PL zdjęty jak w DewFlow; wzorzec XSD TNrNIP odrzuca NIP z sumą kontrolną, ale zerem na początku
    expect(poprawnyNip('PL1111111111')).toBe(true)
    expect(poprawnyNip('pl 111-111-11-11')).toBe(true)
    expect(poprawnyNip('0000000000')).toBe(false)
    expect(poprawnyNip('1000000000')).toBe(false)
  })

  it('kwoty z groszy bez liczb zmiennoprzecinkowych, ilości bez zer końcowych', () => {
    expect(kwota(0)).toBe('0.00')
    expect(kwota(5)).toBe('0.05')
    expect(kwota(123456789)).toBe('1234567.89')
    expect(kwota(-1999)).toBe('-19.99')
    expect(() => kwota(1.5)).toThrow()
    expect(ilosc(3)).toBe('3')
    expect(ilosc(0.25)).toBe('0.25')
    expect(ilosc(1.125)).toBe('1.125')
  })

  it('ucieczka XML', () => {
    expect(escapeXml(`A & B <c> "d" 'e'`)).toBe('A &amp; B &lt;c&gt; &quot;d&quot; &apos;e&apos;')
  })

  it('netto z brutto per stawka jak nettoGr faktury wFirmy', () => {
    expect(sumaStawki('23', 2460)).toEqual({ stawka: '23', nettoGr: 2000, vatGr: 460, bruttoGr: 2460 })
    expect(sumaStawki('8', 1000)).toEqual({ stawka: '8', nettoGr: 926, vatGr: 74, bruttoGr: 1000 })
    expect(sumaStawki('5', 1000)).toEqual({ stawka: '5', nettoGr: 952, vatGr: 48, bruttoGr: 1000 })
    expect(sumaStawki('0', 1000)).toEqual({ stawka: '0', nettoGr: 1000, vatGr: 0, bruttoGr: 1000 })
    expect(sumaStawki('zw', 1000)).toEqual({ stawka: 'zw', nettoGr: 1000, vatGr: 0, bruttoGr: 1000 })
  })
})

describe('zbudujFa3', () => {
  it('poprawna faktura: nagłówek, przestrzeń nazw, sumy, P_15, wiersz od brutto, nabywca BrakID', () => {
    const f = zbudujFa3(wej())
    expect(f.problemy).toEqual([])
    const x = f.xml!
    expect(x.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true)
    expect(x).toContain(`<Faktura xmlns="${FA3_NAMESPACE}">`)
    expect(x).toContain('<KodFormularza kodSystemowy="FA (3)" wersjaSchemy="1-0E">FA</KodFormularza><WariantFormularza>3</WariantFormularza>')
    expect(x).toContain('<DataWytworzeniaFa>2026-11-02T10:00:00Z</DataWytworzeniaFa>')
    expect(x).toContain('<DaneIdentyfikacyjne><BrakID>1</BrakID><Nazwa>Nabywca (uzupełniany przy wysyłce)</Nazwa></DaneIdentyfikacyjne><JST>2</JST><GV>2</GV>')
    expect(x).toContain('<P_13_1>20.00</P_13_1><P_14_1>4.60</P_14_1><P_15>24.60</P_15>')
    expect(x).toContain('<FaWiersz><NrWierszaFa>1</NrWierszaFa><P_7>Przyprawa testowa</P_7><P_8A>szt.</P_8A><P_8B>2</P_8B><P_9B>12.30</P_9B><P_11A>24.60</P_11A><P_12>23</P_12></FaWiersz>')
    expect(x).not.toContain('<?xml-stylesheet')
    expect(f.sumy).toMatchObject({ nettoGr: 2000, vatGr: 460, bruttoGr: 2460 })
    expect(f.wersjaSchemy).toBe('FA (3) 1-0E')
  })

  it('kolejność elementów jak w działającym builderze (zweryfikowana XSD i na TEST)', () => {
    const x = zbudujFa3(wej({ wiersze: [wiersz(), wiersz({ stawka: '8', bruttoGr: 1000, cenaBruttoGr: 500 })], dataDostawy: '2026-11-01', dodatkowyOpis: [{ klucz: 'Zamówienie', wartosc: 'SD 1001' }], systemInfo: 'Kompletor', nabywca: { nip: '9876543210', nazwa: 'Firma Fikcyjna', adres: { kodKraju: 'PL', linia1: 'ul. Zmyślona 2' } } })).xml!
    const e = elementy(x)
    const kolejnosc = (lista: string[]) => lista.map((n) => e.indexOf(n))
    const rosnaco = (a: number[]) => a.every((v, i) => v >= 0 && (i === 0 || v > a[i - 1]!))
    expect(rosnaco(kolejnosc(['Faktura', 'Naglowek', 'KodFormularza', 'WariantFormularza', 'DataWytworzeniaFa', 'SystemInfo', 'Podmiot1', 'Podmiot2', 'Fa']))).toBe(true)
    expect(rosnaco(kolejnosc(['Podmiot2', 'NIP', 'Nazwa', 'Adres', 'JST', 'GV']).map((v, i) => (i === 1 ? e.lastIndexOf('NIP') : i === 2 ? e.lastIndexOf('Nazwa') : i === 3 ? e.lastIndexOf('Adres') : v)))).toBe(true)
    expect(rosnaco(kolejnosc(['KodWaluty', 'P_1', 'P_2', 'P_6', 'P_13_1', 'P_14_1', 'P_13_2', 'P_14_2', 'P_15', 'Adnotacje', 'RodzajFaktury', 'DodatkowyOpis', 'FaWiersz']))).toBe(true)
    expect(rosnaco(kolejnosc(['Adnotacje', 'P_16', 'P_17', 'P_18', 'P_18A', 'Zwolnienie', 'P_19N', 'NoweSrodkiTransportu', 'P_22N', 'P_23', 'PMarzy', 'P_PMarzyN']))).toBe(true)
    expect(rosnaco(kolejnosc(['NrWierszaFa', 'P_7', 'P_8A', 'P_8B', 'P_9B', 'P_11A', 'P_12']))).toBe(true)
  })

  it('stawki 23, 8, 5, 0, zw: sumy w kolejności pól, kody P_12, P_15 = suma brutto', () => {
    const f = zbudujFa3(
      wej({
        podstawaZwolnienia: 'art. 43 ust. 1 pkt 1 ustawy o VAT',
        wiersze: [
          wiersz({ stawka: 'zw', bruttoGr: 500, cenaBruttoGr: 500, ilosc: 1 }),
          wiersz({ stawka: '0', bruttoGr: 400, cenaBruttoGr: 400, ilosc: 1 }),
          wiersz({ stawka: '5', bruttoGr: 1050, cenaBruttoGr: 1050, ilosc: 1 }),
          wiersz({ stawka: '8', bruttoGr: 1080, cenaBruttoGr: 1080, ilosc: 1 }),
          wiersz({ stawka: '23', bruttoGr: 1230, cenaBruttoGr: 1230, ilosc: 1 }),
        ],
      }),
    )
    expect(f.problemy).toEqual([])
    const x = f.xml!
    expect(x).toContain('<P_13_1>10.00</P_13_1><P_14_1>2.30</P_14_1><P_13_2>10.00</P_13_2><P_14_2>0.80</P_14_2><P_13_3>10.00</P_13_3><P_14_3>0.50</P_14_3><P_13_6_1>4.00</P_13_6_1><P_13_7>5.00</P_13_7><P_15>42.60</P_15>')
    expect([...x.matchAll(/<P_12>([^<]+)<\/P_12>/g)].map((m) => m[1])).toEqual(['zw', '0 KR', '5', '8', '23'])
    expect(x).toContain('<Zwolnienie><P_19>1</P_19><P_19A>art. 43 ust. 1 pkt 1 ustawy o VAT</P_19A></Zwolnienie>')
    expect(f.sumy).toEqual({
      nettoGr: 3900,
      vatGr: 360,
      bruttoGr: 4260,
      perStawka: [
        { stawka: '23', nettoGr: 1000, vatGr: 230, bruttoGr: 1230 },
        { stawka: '8', nettoGr: 1000, vatGr: 80, bruttoGr: 1080 },
        { stawka: '5', nettoGr: 1000, vatGr: 50, bruttoGr: 1050 },
        { stawka: '0', nettoGr: 400, vatGr: 0, bruttoGr: 400 },
        { stawka: 'zw', nettoGr: 500, vatGr: 0, bruttoGr: 500 },
      ],
    })
  })

  it('zw bez podstawy zwolnienia = problem; np = P_13_8', () => {
    expect(kody(wej({ wiersze: [wiersz({ stawka: 'zw' })] }))).toEqual(['brak-podstawy-zwolnienia'])
    expect(zbudujFa3(wej({ wiersze: [wiersz({ stawka: 'np' })] })).xml).toContain('<P_13_8>24.60</P_13_8><P_15>24.60</P_15>')
  })

  it('wszystkie problemy naraz, bez XML: NIP zły, stawka nieznana, waluta, rodzaj, data, pusta nazwa', () => {
    const f = zbudujFa3(wej({ waluta: 'EUR', rodzaj: 'ZAL', dataWystawienia: '2026-13-01', sprzedawca: { ...SPRZEDAWCA, nip: '1111111112' }, nabywca: { nip: '1234563219', nazwa: 'X' }, wiersze: [wiersz({ stawka: '7' }), wiersz({ nazwa: ' ' })] }))
    expect(f.xml).toBeNull()
    expect(f.problemy.map((p) => `${p.kod}@${p.pole}`).sort()).toEqual(
      ['waluta-poza-zakresem@Fa.KodWaluty', 'rodzaj-poza-zakresem@Fa.RodzajFaktury', 'data-zla@Fa.P_1', 'nip-zly@Podmiot1.NIP', 'nip-zly@Podmiot2.NIP', 'stawka-nieznana@Fa.FaWiersz[1].P_12', 'pole-puste@Fa.FaWiersz[2].P_7'].sort(),
    )
  })

  it('problemy nie zawierają wartości z danych (NIP, nazwa nabywcy)', () => {
    const f = zbudujFa3(wej({ nabywca: { nip: '1234563219', nazwa: 'Jan Testowy\u0007' } }))
    const txt = JSON.stringify(f.problemy)
    expect(txt).not.toContain('1234563219')
    expect(txt).not.toContain('Jan Testowy')
    expect(f.problemy.map((p) => p.kod).sort()).toEqual(['nip-zly', 'znak-zakazany'])
  })

  it('znaki zakazane to problem, nie cicha zamiana', () => {
    for (const z of ['\u0000', '\u0008', '\u001F', '\u007F', '\u0085', '\u200B', '\u202E', '\uFEFF', '\uFFFE', '\uD800']) {
      const f = zbudujFa3(wej({ wiersze: [wiersz({ nazwa: `Przyprawa${z}zielona` })] }))
      expect(f.xml).toBeNull()
      expect(f.problemy).toEqual([expect.objectContaining({ kod: 'znak-zakazany', pole: 'Fa.FaWiersz[1].P_7' })])
    }
    // tab, nowa linia i emoji (para surogatów) są dozwolone
    expect(zbudujFa3(wej({ wiersze: [wiersz({ nazwa: 'Przyprawa\tzielona 🍵' })] })).problemy).toEqual([])
  })

  it('każdy zakres znaków zakazanych łapany (po jednym znaku z zakresu, zapis \\uXXXX)', () => {
    const zZakresow = ['\u0001', '\u000B', '\u000E', '\u0090', '\u200B', '\u200F', '\u202A', '\u202E', '\u2066', '\u2069', '\uFDD0', '\uFDEF', '\uFEFF', '\uFFFE', '\uFFFF', '\uDC00']
    for (const z of zZakresow) expect(ZAKAZANE_ZNAKI.test(`a${z}b`), z.codePointAt(0)!.toString(16)).toBe(true)
    for (const z of ['\u200A', '\u2010', '\u2065', '\u206A', '\uFDCF', '\uFDF0', '\uFFFD', 'ą', 'ż']) expect(ZAKAZANE_ZNAKI.test(`a${z}b`), z.codePointAt(0)!.toString(16)).toBe(false)
  })

  it('limity długości z XSD: 240 dla P_2, P_8A, P_19A, SystemInfo; 512 dla nazw, adresu i P_7', () => {
    const d = (n: number) => 'x'.repeat(n)
    expect(kody(wej({ numer: d(240) }))).toEqual([])
    expect(zbudujFa3(wej({ numer: d(241) })).problemy).toEqual([expect.objectContaining({ kod: 'tekst-za-dlugi', pole: 'Fa.P_2' })])
    expect(zbudujFa3(wej({ wiersze: [wiersz({ jednostka: d(241) })] })).problemy).toEqual([expect.objectContaining({ kod: 'tekst-za-dlugi', pole: 'Fa.FaWiersz[1].P_8A' })])
    expect(zbudujFa3(wej({ systemInfo: d(241) })).problemy).toEqual([expect.objectContaining({ kod: 'tekst-za-dlugi', pole: 'Naglowek.SystemInfo' })])
    expect(kody(wej({ wiersze: [wiersz({ nazwa: d(512) })], sprzedawca: { ...SPRZEDAWCA, nazwa: d(512), adres: { kodKraju: 'PL', linia1: d(512), linia2: d(512) } } }))).toEqual([])
    expect(zbudujFa3(wej({ wiersze: [wiersz({ nazwa: d(513) })] })).problemy).toEqual([expect.objectContaining({ kod: 'tekst-za-dlugi', pole: 'Fa.FaWiersz[1].P_7' })])
  })

  it('ucieczka znaków XML w nazwach i numerze', () => {
    const x = zbudujFa3(wej({ numer: 'SZKIC-<1>', wiersze: [wiersz({ nazwa: 'Przyprawa "Earl" & <Grey>' })] })).xml!
    expect(x).toContain('<P_7>Przyprawa &quot;Earl&quot; &amp; &lt;Grey&gt;</P_7>')
    expect(x).toContain('<P_2>SZKIC-&lt;1&gt;</P_2>')
  })

  it('suma różna od oczekiwanej (kwoty zamówienia) = problem', () => {
    expect(kody(wej({ oczekiwaneBruttoGr: 2461 }))).toEqual(['suma-rozna-od-zamowienia'])
    expect(kody(wej({ oczekiwaneBruttoGr: 2460 }))).toEqual([])
  })

  it('faktura bez pozycji, ujemna kwota, ilość zero', () => {
    expect(kody(wej({ wiersze: [] }))).toEqual(['brak-wierszy'])
    expect(kody(wej({ wiersze: [wiersz({ bruttoGr: -100 })] }))).toEqual(['kwota-ujemna'])
    expect(kody(wej({ wiersze: [wiersz({ ilosc: 0 })] }))).toEqual(['ilosc-zla'])
  })
})
