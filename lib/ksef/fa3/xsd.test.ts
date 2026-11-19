// walidacja XSD FA(3). Schematy MF leżą w lib/ksef/xsd/ (kopia z DewFlow); bez nich walidator zwraca
// XSD_NIEDOSTEPNY. Test zgodności z prawdziwym schematem jest wymagany: brak plików w repo = czerwony test.
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { zbudujFa3 } from './builder'
import { FA3_NAMESPACE, type WejscieFa3 } from './typy'
import { katalogXsd, walidujFa3, wczytajSchematy } from './xsd'

const wejscie: WejscieFa3 = {
  numer: 'SZKIC-xsd',
  dataWystawienia: '2026-11-02',
  wytworzono: new Date('2026-11-02T10:00:00Z'),
  waluta: 'PLN',
  rodzaj: 'VAT',
  sprzedawca: { nip: '1111111111', nazwa: 'Sprzedawca Testowy', adres: { kodKraju: 'PL', linia1: 'ul. Fikcyjna 1', linia2: '00-001 Warszawa' } },
  nabywca: { nip: null, nazwa: 'Nabywca (uzupełniany przy wysyłce)' },
  podstawaZwolnienia: 'art. 43 ust. 1 pkt 1 ustawy o VAT',
  wiersze: (['23', '8', '5', '0', 'zw'] as const).map((stawka) => ({ nazwa: `Pozycja ${stawka}`, jednostka: 'szt.', ilosc: 1, cenaBruttoGr: 1000, bruttoGr: 1000, stawka })),
}

const dir = katalogXsd()

describe('walidujFa3', () => {
  it('bez schematów: XSD_NIEDOSTEPNY, nigdy „poprawny”', async () => {
    const pusty = await mkdtemp(path.join(tmpdir(), 'ksef-xsd-'))
    expect(await walidujFa3('<Faktura/>', { dir: pusty })).toMatchObject({ stan: 'XSD_NIEDOSTEPNY' })
    expect(await walidujFa3('<Faktura/>', { dir: path.join(pusty, 'nie-ma') })).toMatchObject({ stan: 'XSD_NIEDOSTEPNY' })
  })

  it('schemat z brakującym importem: XSD_NIEDOSTEPNY z nazwą pliku', async () => {
    const d = await mkdtemp(path.join(tmpdir(), 'ksef-xsd-'))
    await writeFile(path.join(d, 'fa3.xsd'), `<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" targetNamespace="${FA3_NAMESPACE}"><xsd:import namespace="x" schemaLocation="http://crd.gov.pl/xml/StrukturyDanych_v10-0E.xsd"/></xsd:schema>`)
    const w = await walidujFa3('<Faktura/>', { dir: d })
    expect(w.stan).toBe('XSD_NIEDOSTEPNY')
    expect(w.komunikat).toContain('StrukturyDanych_v10-0E.xsd')
  })

  it('xmllint-wasm działa na schemacie zastępczym (import lokalny po nazwie pliku)', async () => {
    const d = await mkdtemp(path.join(tmpdir(), 'ksef-xsd-'))
    await writeFile(path.join(d, 'typy.xsd'), `<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:typy"><xsd:simpleType name="Kod"><xsd:restriction base="xsd:string"><xsd:enumeration value="FA"/></xsd:restriction></xsd:simpleType></xsd:schema>`)
    await writeFile(
      path.join(d, 'fa3.xsd'),
      `<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:t="urn:typy" targetNamespace="${FA3_NAMESPACE}" elementFormDefault="qualified"><xsd:import namespace="urn:typy" schemaLocation="http://example.invalid/sciezka/typy.xsd"/><xsd:element name="Faktura" type="t:Kod"/></xsd:schema>`,
    )
    expect(await walidujFa3(`<Faktura xmlns="${FA3_NAMESPACE}">FA</Faktura>`, { dir: d })).toMatchObject({ stan: 'POPRAWNY', bledy: [] })
    const zle = await walidujFa3(`<Faktura xmlns="${FA3_NAMESPACE}">XX</Faktura>`, { dir: d })
    expect(zle.stan).toBe('BLEDY')
    expect(zle.bledy.length).toBeGreaterThan(0)
  })

  it('cztery schematy FA(3) z DewFlow są w repo i wczytują się (główny po targetNamespace)', async () => {
    expect(existsSync(dir)).toBe(true)
    const { schematy, powod } = await wczytajSchematy(dir)
    expect(powod).toBe('')
    expect(schematy!.glowny.fileName).toBe('schemat_FA(3)_v1-0E.xsd')
    expect(schematy!.pozostale.map((p) => p.fileName).sort()).toEqual(['ElementarneTypyDanych_v10-0E.xsd', 'KodyKrajow_v10-0E.xsd', 'StrukturyDanych_v10-0E.xsd'])
  })

  it('faktura z buildera (stawki 23, 8, 5, 0, zw; nabywca zastępczy i z NIP) jest zgodna ze schematem FA(3)', async () => {
    for (const w0 of [wejscie, { ...wejscie, nabywca: { nip: '1234563218', nazwa: 'Firma Testowa', adres: { kodKraju: 'PL', linia1: 'ul. Testowa 2', linia2: '00-002 Testowo' } } }]) {
      const f = zbudujFa3(w0)
      expect(f.problemy).toEqual([])
      const w = await walidujFa3(f.xml!)
      expect(w.bledy).toEqual([])
      expect(w.stan).toBe('POPRAWNY')
    }
  })

  it('korekta KOR przy zwrocie (ilość i wartość ujemne, faktura korygowana poza KSeF albo z numerem KSeF) jest zgodna ze schematem FA(3)', async () => {
    const kor: WejscieFa3 = {
      ...wejscie,
      numer: 'SZKIC-KOR-xsd',
      rodzaj: 'KOR',
      korekta: { przyczyna: 'Zwrot towaru', numer: 'FV 1/11/2026', dataWystawienia: '2026-11-01', nrKsef: null },
      wiersze: [
        { nazwa: 'Przyprawa zwrócona', jednostka: 'szt.', ilosc: -1, cenaBruttoGr: 1230, bruttoGr: -1230, stawka: '23' },
        { nazwa: 'Susz na wagę', jednostka: 'kg', ilosc: -0.25, cenaBruttoGr: 8000, bruttoGr: -2000, stawka: '5' },
      ],
    }
    for (const w0 of [kor, { ...kor, korekta: { ...kor.korekta!, nrKsef: '1111111111-20261101-0123456789AB-CD' } }]) {
      const f = zbudujFa3(w0)
      expect(f.problemy).toEqual([])
      expect(f.sumy.bruttoGr).toBe(-3230)
      expect(f.xml).toContain('<RodzajFaktury>KOR</RodzajFaktury><PrzyczynaKorekty>Zwrot towaru</PrzyczynaKorekty><TypKorekty>2</TypKorekty>')
      const w = await walidujFa3(f.xml!)
      expect(w.bledy).toEqual([])
      expect(w.stan).toBe('POPRAWNY')
    }
    // korekta bez danych faktury korygowanej i dane korekty przy zwykłej fakturze = problem
    expect(zbudujFa3({ ...kor, korekta: null }).problemy.map((p) => p.kod)).toContain('korekta-bez-faktury')
    expect(zbudujFa3({ ...wejscie, korekta: kor.korekta }).problemy.map((p) => p.kod)).toContain('korekta-w-vat')
    expect(zbudujFa3({ ...wejscie, wiersze: [{ ...kor.wiersze[0]! }] }).problemy.map((p) => p.kod)).toContain('kwota-ujemna')
  })

  it('NIP „0000000000” i za długi P_8A łapie builder, zanim dojdzie do schematu (schemat też by odrzucił)', async () => {
    const zlyNip = zbudujFa3({ ...wejscie, sprzedawca: { ...wejscie.sprzedawca, nip: '0000000000' } })
    expect(zlyNip.problemy.map((p) => p.kod)).toEqual(['nip-zly'])
    const xml = zbudujFa3(wejscie).xml!.replace('<NIP>1111111111</NIP>', '<NIP>0000000000</NIP>')
    expect((await walidujFa3(xml)).stan).toBe('BLEDY')
  })

  it('schematy w pamięci po pierwszym udanym wczytaniu (ten sam obiekt przy kolejnym wywołaniu)', async () => {
    const a = await wczytajSchematy(dir)
    const b = await wczytajSchematy(dir)
    expect(b.schematy).toBe(a.schematy)
  })

  it('błąd samego walidatora (np. brak workera xmllint-wasm w obrazie) = XSD_NIEDOSTEPNY, bez wyjątku', async () => {
    vi.resetModules()
    vi.doMock('xmllint-wasm', () => ({ validateXML: () => Promise.reject(new Error('Cannot find module xmllint.wasm')) }))
    try {
      const { walidujFa3: walidujZZepsutym } = await import('./xsd')
      const w = await walidujZZepsutym(zbudujFa3(wejscie).xml!, { dir })
      expect(w).toMatchObject({ stan: 'XSD_NIEDOSTEPNY', bledy: [] })
      expect(w.komunikat).toContain('walidator: Cannot find module xmllint.wasm')
    } finally {
      vi.doUnmock('xmllint-wasm')
      vi.resetModules()
    }
  })
})
