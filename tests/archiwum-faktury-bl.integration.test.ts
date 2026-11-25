// etap 3: archiwum Allegro z faktur BL (kanał odtworzony), na bazie testowej (dane fikcyjne, plik w katalogu
// tymczasowym, bez sieci). Sprawdza ścieżkę CLI `archiwum --kanal ALLEGRO --z-faktur-bl`:
//  - na sucho domyślnie (zero wierszy), `--wykonaj` zapisuje;
//  - faktura z parą w archiwum innego kanału albo w `Order` pominięta; faktura z parą w archiwum Allegro z API też;
//  - koniec zakresu = pierwsze zamówienie Allegro z API (faktura po nim się nie importuje), bez archiwum API wymaga --do;
//  - wiersz: `channelInferred`, `blOrderId`, numer faktury, produkt po SKU, zwrot z korekty; drugi przebieg bez zmian;
//  - raport sprzedaży liczy wiersz normalnie i pokazuje go w `zKanalemOdtworzonym`; dane nabywcy nie trafiają do bazy.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { raportSprzedazy, zapytanieSprzedazy } from '@/lib/api/raporty-sprzedaz'
import { KAWALEK_WYCOFANIA, zrodloFakturyBl, type KandydatPary } from '@/lib/archiwum/faktury-bl'
import { archiwumCli, type ArgumentyArchiwum } from '@/scripts/archiwum'
import { testDb, truncateAll } from './db'
import { ACC, product, seedBase } from './rdzen-fixtures'

const a = testDb()
beforeEach(async () => {
  await truncateAll()
  await seedBase(a)
})
afterAll(async () => {
  await a.$disconnect()
})

const sek = (iso: string) => Math.floor(new Date(iso).getTime() / 1000)
const faktura = (id: number, kiedy: string, brutto: number, o: Record<string, unknown> = {}) => ({
  invoice_id: id,
  order_id: 7000 + id,
  series_id: 1,
  type: 'normal',
  number: `${id}/6/2025`,
  date_add: sek(kiedy),
  date_sell: sek(kiedy),
  currency: 'PLN',
  total_price_brutto: brutto,
  correcting_to_invoice_id: 0,
  payment: 'kupujacy@example.test',
  invoice_fullname: 'Jan Testowy',
  invoice_nip: '1234567890',
  items: [{ name: 'Towar testowy A', sku: 'TEST-FV1', ean: '', price_brutto: brutto, tax_rate: 23, quantity: 1, is_shipment: 0, order_product_id: id * 10 }],
  ...o,
})

async function plik(faktury: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'faktury-bl-'))
  const p = join(dir, 'faktury.jsonl')
  await writeFile(p, faktury.map((f) => JSON.stringify(f)).join('\n'), 'utf8')
  return p
}
const cli = (zFakturBl: string, o: Partial<ArgumentyArchiwum> = {}) =>
  archiwumCli(a, { kanal: 'ALLEGRO', konto: ACC.ALLEGRO.channelAccountId, od: '2025-01-01', zFakturBl, naSucho: false, wykonaj: false, registry: {} as never, src: {} as never, ...o })

async function archiwumInnych(): Promise<void> {
  const wiersz = (channel: 'WOO' | 'ALLEGRO', konto: string, externalId: string, source: string, kiedy: string, brutto: string) =>
    a.archivedOrder.create({ data: { source, channel, channelAccountId: konto, externalId, channelStatus: 'x', status: 'WYSLANE', createdAtChannel: new Date(kiedy), paymentState: 'PAID', totalGross: brutto, currency: 'PLN', trackingNumbers: [], invoiceNumbers: [] } })
  await wiersz('WOO', ACC.WOO_SD.channelAccountId, 'w-1', 'WOO_API', '2025-06-10T08:00:00Z', '52.50')
  await wiersz('ALLEGRO', ACC.ALLEGRO.channelAccountId, 'al-api-1', 'ALLEGRO_API', '2025-11-22T10:00:00Z', '61.00')
  await a.order.create({ data: { ...ACC.EMPIK, externalId: 'e-1', status: 'WYSLANE', paymentState: 'PAID', paymentMethod: 'ONLINE', totalGross: '33.00', createdAtChannel: new Date('2025-07-01T08:00:00Z') } })
}

describe('archiwum z faktur BL', () => {
  it('pary pominięte, reszta = Allegro z kanałem odtworzonym; granica na pierwszym zamówieniu z API; idempotencja; raport', async () => {
    await archiwumInnych()
    const pid = await product(a, 'TEST-FV1', 0)
    const f = await plik([
      faktura(1, '2025-06-11T09:00:00Z', 52.5), // para z archiwum Woo
      faktura(2, '2025-06-12T09:00:00Z', 40), // Allegro
      faktura(3, '2025-07-02T09:00:00Z', 33), // para z Order Empiku
      faktura(4, '2025-11-23T09:00:00Z', 61), // po pierwszym zamówieniu z API: poza zakresem
      faktura(5, '2025-06-20T09:00:00Z', -10, { type: 'correcting', correcting_to_invoice_id: 2, items: [] }),
    ])
    const raport = join(tmpdir(), `faktury-bl-raport-${process.pid}.md`)

    expect(await cli(f, { plik: raport })).toBe(0)
    expect(await a.archivedOrder.count({ where: { source: 'BL_FAKTURA' } })).toBe(0) // na sucho domyślnie
    const md = await readFile(raport, 'utf8')
    expect(md).toMatch(/NA SUCHO/)
    expect(md).toMatch(/bez pary \(= Allegro, kanał odtworzony\): 1/)

    expect(await cli(f, { wykonaj: true })).toBe(0)
    const rows = await a.archivedOrder.findMany({ where: { source: 'BL_FAKTURA' }, include: { lines: true } })
    expect(rows).toHaveLength(1)
    const z = rows[0]!
    expect(z).toMatchObject({ channel: 'ALLEGRO', channelAccountId: ACC.ALLEGRO.channelAccountId, externalId: '2', blOrderId: 7002, channelInferred: true, invoiceNumbers: ['2/6/2025'], channelNumber: null })
    expect(Number(z.totalGross)).toBe(40)
    expect(Number(z.refundGross)).toBe(10)
    expect(z.lines[0]).toMatchObject({ productId: pid, sku: 'TEST-FV1' })
    expect(JSON.stringify(rows)).not.toMatch(/@|Testowy|1234567890/)
    // archiwum z wcześniejszych etapów bez zmian (kanał podany przez źródło)
    expect(await a.archivedOrder.count({ where: { channelInferred: false } })).toBe(2)

    const raport2 = join(tmpdir(), `faktury-bl-raport2-${process.pid}.md`)
    expect(await cli(f, { wykonaj: true, plik: raport2 })).toBe(0)
    expect(await readFile(raport2, 'utf8')).toMatch(/bez zmian \(ta sama rewizja sklepu\): 1/)
    expect(await a.archivedOrder.count({ where: { source: 'BL_FAKTURA' } })).toBe(1)

    const r = await raportSprzedazy(a, zapytanieSprzedazy({ od: '2025-06-01', do: '2025-06-30', grupuj: 'miesiac' }, new Date('2026-11-22T12:00:00Z')))
    expect(r.razem).toMatchObject({ zamowien: 2 })
    expect(r.zArchiwum).toEqual({ zamowien: 2, brutto: 92.5, inneWaluty: [] })
    expect(r.zKanalemOdtworzonym).toEqual({ zamowien: 1, brutto: 40, inneWaluty: [] })
  })

  it('konto bez archiwum Allegro z API wymaga --do; --do przed pierwszym zamówieniem z API skraca zakres', async () => {
    const f = await plik([faktura(2, '2025-06-12T09:00:00Z', 40), faktura(6, '2025-08-12T09:00:00Z', 44)])
    await expect(cli(f)).rejects.toThrow(/podaj --do/)
    await archiwumInnych()
    expect(await cli(f, { wykonaj: true, do: '2025-07-01' })).toBe(0)
    expect((await a.archivedOrder.findMany({ where: { source: 'BL_FAKTURA' }, select: { externalId: true } })).map((x) => x.externalId)).toEqual(['2'])
  })

  it('przegląd etapu 3: faktura, która przy kolejnym przebiegu ma parę albo wypada za koniec zakresu, schodzi z archiwum i z sum', async () => {
    await archiwumInnych()
    const f = await plik([faktura(2, '2025-06-12T09:00:00Z', 40), faktura(6, '2025-08-12T09:00:00Z', 44)])
    expect(await cli(f, { wykonaj: true })).toBe(0)
    const bl = async () => (await a.archivedOrder.findMany({ where: { source: 'BL_FAKTURA' }, select: { externalId: true }, orderBy: { externalId: 'asc' } })).map((x) => x.externalId)
    expect(await bl()).toEqual(['2', '6'])
    // doimportowane później zamówienie sklepu z tą samą kwotą i datą: para dla faktury 2
    await a.archivedOrder.create({ data: { source: 'WOO_API', channel: 'WOO', channelAccountId: ACC.WOO_SD.channelAccountId, externalId: 'w-pozniej', channelStatus: 'x', status: 'WYSLANE', createdAtChannel: new Date('2025-06-11T20:00:00Z'), paymentState: 'PAID', totalGross: '40.00', currency: 'PLN', trackingNumbers: [], invoiceNumbers: [] } })
    const sucho = join(tmpdir(), `faktury-bl-wycofaj-sucho-${process.pid}.md`)
    expect(await cli(f, { plik: sucho })).toBe(0)
    expect(await readFile(sucho, 'utf8')).toMatch(/Do usunięcia z archiwum .*: 1\./)
    expect(await bl()).toEqual(['2', '6']) // na sucho nic nie usunięte
    const raport = join(tmpdir(), `faktury-bl-wycofaj-${process.pid}.md`)
    expect(await cli(f, { wykonaj: true, plik: raport })).toBe(0)
    expect(await readFile(raport, 'utf8')).toMatch(/Usunięte z archiwum .*: 1\./)
    expect(await bl()).toEqual(['6'])
    expect(await a.archivedOrderLine.count({ where: { order: { source: 'BL_FAKTURA' } } })).toBe(1) // pozycje usunięte razem z wierszem
    const r = await raportSprzedazy(a, zapytanieSprzedazy({ od: '2025-06-01', do: '2025-06-30', grupuj: 'miesiac' }, new Date('2026-11-22T12:00:00Z')))
    expect(r.zKanalemOdtworzonym).toEqual({ zamowien: 0, brutto: 0, inneWaluty: [] })
    expect(r.razem.zamowien).toBe(2) // w-1 i w-pozniej, faktura 2 już nie obok
    // przegląd końcowy: krótsze --do tylko zawęża zapis, faktura 6 (sierpień, przed końcem konta) zostaje
    expect(await cli(f, { wykonaj: true, do: '2025-07-01' })).toBe(0)
    expect(await bl()).toEqual(['6'])
  })

  const blWszystkie = async () => (await a.archivedOrder.findMany({ where: { source: 'BL_FAKTURA' }, select: { externalId: true }, orderBy: { externalId: 'asc' } })).map((x) => x.externalId)

  it('przegląd końcowy: import kawałkami (późniejszy kawałek pierwszy) daje komplet wierszy', async () => {
    await archiwumInnych()
    const f = await plik([faktura(2, '2025-06-12T09:00:00Z', 40), faktura(6, '2025-08-12T09:00:00Z', 44)])
    expect(await cli(f, { wykonaj: true, od: '2025-08-01' })).toBe(0)
    expect(await blWszystkie()).toEqual(['6'])
    const raport = join(tmpdir(), `faktury-bl-kawalki-${process.pid}.md`)
    expect(await cli(f, { wykonaj: true, od: '2025-01-01', do: '2025-08-01', plik: raport })).toBe(0)
    expect(await readFile(raport, 'utf8')).not.toMatch(/Usunięte z archiwum/)
    expect(await blWszystkie()).toEqual(['2', '6'])
  })

  it('przegląd końcowy: import kawałkami (wcześniejszy kawałek pierwszy) daje komplet wierszy', async () => {
    await archiwumInnych()
    const f = await plik([faktura(2, '2025-06-12T09:00:00Z', 40), faktura(6, '2025-08-12T09:00:00Z', 44)])
    expect(await cli(f, { wykonaj: true, od: '2025-01-01', do: '2025-08-01' })).toBe(0)
    expect(await blWszystkie()).toEqual(['2'])
    expect(await cli(f, { wykonaj: true, od: '2025-08-01' })).toBe(0)
    expect(await blWszystkie()).toEqual(['2', '6'])
  })

  it('przegląd końcowy: naturalny koniec konta przesunięty wcześniej (pierwsze z API, coverageFrom) zdejmuje wiersze za nim', async () => {
    await archiwumInnych()
    const f = await plik([faktura(2, '2025-06-12T09:00:00Z', 40), faktura(6, '2025-08-12T09:00:00Z', 44)])
    expect(await cli(f, { wykonaj: true })).toBe(0)
    expect(await blWszystkie()).toEqual(['2', '6'])
    // wcześniejsze zamówienie Allegro z API (01.08): faktura 6 jest teraz za końcem konta, także przy krótszym --do
    await a.archivedOrder.create({ data: { source: 'ALLEGRO_API', channel: 'ALLEGRO', channelAccountId: ACC.ALLEGRO.channelAccountId, externalId: 'al-api-0', channelStatus: 'x', status: 'WYSLANE', createdAtChannel: new Date('2025-08-01T10:00:00Z'), paymentState: 'PAID', totalGross: '99.00', currency: 'PLN', trackingNumbers: [], invoiceNumbers: [] } })
    const raport = join(tmpdir(), `faktury-bl-koniec-${process.pid}.md`)
    expect(await cli(f, { wykonaj: true, do: '2025-07-01', plik: raport })).toBe(0)
    expect(await blWszystkie()).toEqual(['2'])
    // raport przebiegu i sekcja faktur podają to samo źródło końca zakresu
    const md = await readFile(raport, 'utf8')
    expect(md).toMatch(/koniec zakresu: parametr --do\./)
    expect(md).toMatch(/Koniec zakresu: .*\(parametr --do\)/)
    // coverageFrom konta wcześniejszy niż faktura 2: schodzi także ona
    await a.channelCursor.create({ data: { channel: 'ALLEGRO', channelAccountId: ACC.ALLEGRO.channelAccountId, adapterKey: 'allegro.rest.v1', coverageFrom: new Date('2025-06-01T00:00:00Z') } })
    expect(await cli(f, { wykonaj: true, od: '2025-01-01', do: '2025-05-01' })).toBe(0)
    expect(await blWszystkie()).toEqual([])
  })

  it('przegląd etapu 3: parowanie na granicy zapisu (coverageFrom konta), faktura z obciętego ogona nie zabiera pary', async () => {
    await archiwumInnych()
    // zamówienie sklepu 30.07 za 70 zł z SKU pasującym do faktury z ogona (05.08, po coverageFrom Allegro 01.08)
    const w = await a.archivedOrder.create({ data: { source: 'WOO_API', channel: 'WOO', channelAccountId: ACC.WOO_SD.channelAccountId, externalId: 'w-70', channelStatus: 'x', status: 'WYSLANE', createdAtChannel: new Date('2025-07-30T08:00:00Z'), paymentState: 'PAID', totalGross: '70.00', currency: 'PLN', trackingNumbers: [], invoiceNumbers: [] } })
    await a.archivedOrderLine.create({ data: { orderId: w.id, externalLineId: 'w-70-1', name: 'x', sku: 'TEST-OGON', qty: 1, lineGross: 70 } })
    await a.channelCursor.create({ data: { channel: 'ALLEGRO', channelAccountId: ACC.ALLEGRO.channelAccountId, adapterKey: 'allegro.rest.v1', coverageFrom: new Date('2025-08-01T00:00:00Z') } })
    const f = await plik([
      faktura(11, '2025-07-31T09:00:00Z', 70), // w zakresie, SKU inny
      faktura(12, '2025-08-05T09:00:00Z', 70, { items: [{ name: 'Towar', sku: 'TEST-OGON', ean: '', price_brutto: 70, tax_rate: 23, quantity: 1, is_shipment: 0, order_product_id: 120 }] }), // ogon za coverageFrom
    ])
    const raport = join(tmpdir(), `faktury-bl-ogon-${process.pid}.md`)
    expect(await cli(f, { wykonaj: true, plik: raport })).toBe(0)
    const md = await readFile(raport, 'utf8')
    expect(md).toMatch(/Koniec zakresu: 2025-08-01T00:00:00\.000Z \(początek odczytu kanału/)
    expect(md).toMatch(/Faktury normalne w zakresie: 1; z parą w innym kanale albo źródle: 1; bez pary \(= Allegro, kanał odtworzony\): 0/)
    expect(await a.archivedOrder.count({ where: { source: 'BL_FAKTURA' } })).toBe(0)
  })

  async function plikZrodel(tresc: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'zrodla-bl-'))
    const p = join(dir, 'zrodla.csv')
    await writeFile(p, tresc, 'utf8')
    return p
  }
  const MAPA_TEST = 'konto_aukcji=ALLEGRO;Sklep testowy=WOO;Rynek testowy=EMPIK;Osobiście/tel.=POMIN'
  const NAGLOWEK = 'order_id;pochodzenie;status;data;waluta'

  it('plik źródeł BL: Allegro z pliku bez flagi, inny kanał pominięty i wycofany, POMIN z sumą, bez odpowiednika = kod 1; idempotencja', async () => {
    await archiwumInnych()
    const f = await plik([
      faktura(1, '2025-06-11T09:00:00Z', 52.5), // bez wpisu w pliku: para z archiwum Woo jak dotąd
      faktura(2, '2025-06-12T09:00:00Z', 40), // order 7002 = konto_aukcji -> Allegro, kanał podany
      faktura(6, '2025-08-12T09:00:00Z', 44), // order 7006 = Sklep testowy, bez zamówienia Woo w bazie -> bez odpowiednika
      faktura(8, '2025-06-15T09:00:00Z', 61), // order 7008 = sprzedaż ręczna -> POMIN
      faktura(9, '2025-06-16T09:00:00Z', 70), // bez wpisu, bez pary -> Allegro odtworzone
    ])
    // najpierw bez pliku: 2, 6, 8, 9 jako Allegro z kanałem odtworzonym
    expect(await cli(f, { wykonaj: true })).toBe(0)
    expect(await blWszystkie()).toEqual(['2', '6', '8', '9'])
    // nazwy po normalizacji: wielkość liter, spacje na brzegach i w środku
    const zr = await plikZrodel([NAGLOWEK, '7002; Konto_Aukcji ;Wysłane;2025-06-12T11:00:00;PLN', '7006;Sklep  testowy;Wysłane;2025-08-12T11:00:00;PLN', '7008;Osobiście/tel.;Wysłane;2025-06-15T11:00:00;EUR', ''].join('\n'))
    const sucho = join(tmpdir(), `faktury-bl-zrodla-sucho-${process.pid}.md`)
    expect(await cli(f, { zrodlaBl: zr, mapaZrodel: MAPA_TEST, plik: sucho })).toBe(1) // faktura 6 bez odpowiednika, próg 0
    expect(await blWszystkie()).toEqual(['2', '6', '8', '9']) // na sucho bez zmian
    const md = await readFile(sucho, 'utf8')
    expect(md).toMatch(/Plik źródeł BL: 3 zamówień; faktury w zakresie z wpisem w pliku: 3 \(Allegro, kanał podany: 1; inny kanał z archiwum: 1, z zamówieniem swojego kanału w bazie: 0\)/)
    expect(md).toMatch(/wg pliku źródeł: WOO: 1/)
    expect(md).toMatch(/Pominięte świadomie \(POMIN w mapie\): 1 za 61,00 zł\./)
    expect(md).toMatch(/Inny kanał wg pliku, bez odpowiednika w bazie: 1 za 44,00 zł \(WOO 1 za 44,00 zł\)\./)
    expect(md).toMatch(/Numery faktur bez odpowiednika \(data sprzedaży\): 6\/6\/2025 \(2025-08-12\)\./)
    expect(md).toMatch(/\*\*Ostrzeżenie:\*\*.*kod wyjścia 1/)
    expect(md).toMatch(/Waluta w pliku źródeł inna niż na fakturze: 1/)
    expect(md).toMatch(/Faktury bez wpisu w pliku źródeł: 2; z parą w innym kanale albo źródle: 1; bez pary \(= Allegro, kanał odtworzony\): 1/)
    expect(md).toMatch(/inny kanał wg pliku źródeł BL 2/)
    expect(md).toMatch(/Do usunięcia z archiwum .*: 2\./)
    // próg w zł: równy sumie = OK, mniejszy = kod 1
    expect(await cli(f, { zrodlaBl: zr, mapaZrodel: MAPA_TEST, progBezOdpowiednika: '44' })).toBe(0)
    expect(await cli(f, { zrodlaBl: zr, mapaZrodel: MAPA_TEST, progBezOdpowiednika: '43,99' })).toBe(1)

    expect(await cli(f, { zrodlaBl: zr, mapaZrodel: MAPA_TEST, wykonaj: true, pozwolBezOdpowiednika: true })).toBe(0)
    const rows = await a.archivedOrder.findMany({ where: { source: 'BL_FAKTURA' }, select: { externalId: true, channelInferred: true }, orderBy: { externalId: 'asc' } })
    expect(rows).toEqual([{ externalId: '2', channelInferred: false }, { externalId: '9', channelInferred: true }])
    const r = await raportSprzedazy(a, zapytanieSprzedazy({ od: '2025-06-01', do: '2025-06-30', grupuj: 'miesiac' }, new Date('2026-11-22T12:00:00Z')))
    expect(r.zKanalemOdtworzonym).toEqual({ zamowien: 1, brutto: 70, inneWaluty: [] })

    const drugi = join(tmpdir(), `faktury-bl-zrodla-2-${process.pid}.md`)
    expect(await cli(f, { zrodlaBl: zr, mapaZrodel: MAPA_TEST, wykonaj: true, pozwolBezOdpowiednika: true, plik: drugi })).toBe(0)
    expect(await readFile(drugi, 'utf8')).toMatch(/bez zmian \(ta sama rewizja sklepu\): 2/)
    expect(await a.archivedOrder.findMany({ where: { source: 'BL_FAKTURA' }, select: { externalId: true, channelInferred: true }, orderBy: { externalId: 'asc' } })).toEqual(rows)
  })

  it('mapa bez konta aukcji, literówka w nazwie, kanał bez archiwum albo zły plik = błąd przed zapisem i przed wycofaniem', async () => {
    await archiwumInnych()
    const f = await plik([faktura(2, '2025-06-12T09:00:00Z', 40), faktura(6, '2025-06-20T09:00:00Z', 44)])
    expect(await cli(f, { wykonaj: true })).toBe(0)
    const przed = await a.archivedOrder.findMany({ where: { source: 'BL_FAKTURA' }, select: { externalId: true, updatedAt: true }, orderBy: { externalId: 'asc' } })
    expect(przed.map((x) => x.externalId)).toEqual(['2', '6'])
    const przebiegi = await a.importRun.count()
    const zr = await plikZrodel([NAGLOWEK, '7002;konto_aukcji;;;', '7006;Sklep testowy;;;', ''].join('\n'))
    await expect(cli(f, { zrodlaBl: zr, mapaZrodel: 'Sklep testowy=WOO;Osobiście/tel.=POMIN', wykonaj: true })).rejects.toThrow(/brak wpisu z kanałem importowanego konta \(ALLEGRO\)/)
    await expect(cli(f, { zrodlaBl: zr, mapaZrodel: 'konto_aukcj=ALLEGRO;Sklep testowy=WOO', wykonaj: true })).rejects.toThrow(/źródła spoza --mapa-zrodel: „konto_aukcji” \(zamówień 1, faktur 1\).*nic nie zapisano/)
    await expect(cli(f, { zrodlaBl: zr, mapaZrodel: 'konto_aukcji=ALLEGRO;Sklep testowy=RECZNE', wykonaj: true })).rejects.toThrow(/RECZNE” nie ma importu archiwum.*POMIN/)
    const win1250 = join(await mkdtemp(join(tmpdir(), 'zrodla-bl-')), 'zrodla.csv')
    await writeFile(win1250, Buffer.concat([Buffer.from(`${NAGLOWEK}\n7002;konto_aukcji;;;\n7006;Osobi`, 'latin1'), Buffer.from([0x9c]), Buffer.from('cie/tel.;;;\n', 'latin1')]))
    await expect(cli(f, { zrodlaBl: win1250, mapaZrodel: MAPA_TEST, wykonaj: true })).rejects.toThrow(/nie jest w UTF-8/)
    expect(await a.archivedOrder.findMany({ where: { source: 'BL_FAKTURA' }, select: { externalId: true, updatedAt: true }, orderBy: { externalId: 'asc' } })).toEqual(przed)
    expect(await a.importRun.count()).toBe(przebiegi)
  })

  it('faktura z wpisem sklepu zajmuje swoją parę, faktura bez wpisu jej nie zabiera', async () => {
    await archiwumInnych() // w-1: Woo 10.06 08:00, 52,50 zł
    const f = await plik([
      faktura(21, '2025-06-10T09:00:00Z', 52.5), // order 7021 = Sklep testowy: właściwa para w-1
      faktura(22, '2025-06-11T09:00:00Z', 52.5), // bez wpisu (Allegro spoza pliku), ta sama kwota w oknie w-1
    ])
    const zr = await plikZrodel([NAGLOWEK, '7021;Sklep testowy;;;', '7002;konto_aukcji;;;', ''].join('\n'))
    const raport = join(tmpdir(), `faktury-bl-w1-${process.pid}.md`)
    expect(await cli(f, { zrodlaBl: zr, mapaZrodel: MAPA_TEST, wykonaj: true, plik: raport })).toBe(0)
    expect(await a.archivedOrder.findMany({ where: { source: 'BL_FAKTURA' }, select: { externalId: true, channelInferred: true } })).toEqual([{ externalId: '22', channelInferred: true }])
    const md = await readFile(raport, 'utf8')
    expect(md).toMatch(/inny kanał z archiwum: 1, z zamówieniem swojego kanału w bazie: 1\)/)
    expect(md).toMatch(/bez odpowiednika w bazie: 0 za 0,00 zł\./)
    expect(md).toMatch(/Faktury bez wpisu w pliku źródeł: 1; z parą w innym kanale albo źródle: 0/)
  })

  it('przegląd r2 K-A i W-A: wycofanie z pliku źródeł tylko w zakresie dat; bez odpowiednika z --wykonaj = stop przed zapisem', async () => {
    await archiwumInnych() // w-1: Woo 10.06, 52,50 zł
    const f = await plik([
      faktura(31, '2025-03-15T09:00:00Z', 30), // order 7031 = Sklep testowy; archiwum sklepu za marzec na razie brak
      faktura(21, '2025-06-10T09:00:00Z', 52.5), // order 7021 = Sklep testowy: para w-1
    ])
    const zr = await plikZrodel([NAGLOWEK, '7031;Sklep testowy;;;', '7021;Sklep testowy;;;', ''].join('\n'))
    // 1. marzec bez pliku źródeł: faktura 31 zapisana jako Allegro z kanałem odtworzonym
    expect(await cli(f, { wykonaj: true, od: '2025-03-01', do: '2025-04-01' })).toBe(0)
    expect(await blWszystkie()).toEqual(['31'])
    // 2. czerwiec z plikiem obejmującym też marzec: faktura 31 spoza zakresu zostaje (wcześniej znikała przy kodzie 0)
    const czerwiec = join(tmpdir(), `faktury-bl-ka-czerwiec-${process.pid}.md`)
    expect(await cli(f, { zrodlaBl: zr, mapaZrodel: MAPA_TEST, wykonaj: true, od: '2025-06-01', do: '2025-07-01', plik: czerwiec })).toBe(0)
    expect(await blWszystkie()).toEqual(['31'])
    const mdCz = await readFile(czerwiec, 'utf8')
    expect(mdCz).not.toMatch(/Usunięte z archiwum/)
    expect(mdCz).toMatch(/dotyczy tylko zakresu dat przebiegu/)
    // 3. marzec z plikiem, archiwum sklepu za marzec nadal brak: z --wykonaj stop przed zapisem i wycofaniem (W-A)
    const przebiegi = await a.importRun.count()
    const przed = await a.archivedOrder.findMany({ where: { source: 'BL_FAKTURA' }, select: { externalId: true, updatedAt: true } })
    const blad = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stop = join(tmpdir(), `faktury-bl-wa-stop-${process.pid}.md`)
    expect(await cli(f, { zrodlaBl: zr, mapaZrodel: MAPA_TEST, wykonaj: true, od: '2025-03-01', do: '2025-04-01', plik: stop })).toBe(1)
    const komunikat = blad.mock.calls.flat().join(' ')
    blad.mockRestore()
    expect(komunikat).toMatch(/bez zamówienia w bazie: 1 za 30,00 zł \(WOO 1 za 30,00 zł\); numery: 31\/6\/2025 \(2025-03-15\).*nic nie zapisano ani nie usunięto/)
    expect(komunikat).not.toMatch(/example|Testowy|1234567890/)
    expect(await readFile(stop, 'utf8')).toMatch(/Numery faktur bez odpowiednika \(data sprzedaży\): 31\/6\/2025 \(2025-03-15\)\./)
    expect(await a.archivedOrder.findMany({ where: { source: 'BL_FAKTURA' }, select: { externalId: true, updatedAt: true } })).toEqual(przed)
    expect(await a.importRun.count()).toBe(przebiegi)
    // na sucho: pełny raport i kod 1 jak dotąd
    const sucho = join(tmpdir(), `faktury-bl-wa-sucho-${process.pid}.md`)
    expect(await cli(f, { zrodlaBl: zr, mapaZrodel: MAPA_TEST, od: '2025-03-01', do: '2025-04-01', plik: sucho })).toBe(1)
    expect(await readFile(sucho, 'utf8')).toMatch(/Do usunięcia z archiwum .*: 1\./)
    // 4. archiwum sklepu za marzec wgrane: przebieg za marzec z plikiem zdejmuje fakturę 31 i ją liczy
    await a.archivedOrder.create({ data: { source: 'WOO_API', channel: 'WOO', channelAccountId: ACC.WOO_SD.channelAccountId, externalId: 'w-marzec', channelStatus: 'x', status: 'WYSLANE', createdAtChannel: new Date('2025-03-15T08:00:00Z'), paymentState: 'PAID', totalGross: '30.00', currency: 'PLN', trackingNumbers: [], invoiceNumbers: [] } })
    const marzec = join(tmpdir(), `faktury-bl-ka-marzec-${process.pid}.md`)
    expect(await cli(f, { zrodlaBl: zr, mapaZrodel: MAPA_TEST, wykonaj: true, od: '2025-03-01', do: '2025-04-01', plik: marzec })).toBe(0)
    const md = await readFile(marzec, 'utf8')
    expect(md).toMatch(/inny kanał z archiwum: 1, z zamówieniem swojego kanału w bazie: 1\)/)
    expect(md).toMatch(/Usunięte z archiwum .*: 1\./)
    expect(await blWszystkie()).toEqual([])
  })

  it('wycofanie usuwa kawałkami (lista ponad limit parametrów zapytania)', async () => {
    const n = 2 * KAWALEK_WYCOFANIA + 1
    const konto = ACC.ALLEGRO.channelAccountId
    await a.archivedOrder.createMany({ data: Array.from({ length: n }, (_, i) => ({ source: 'BL_FAKTURA', channel: 'ALLEGRO' as const, channelAccountId: konto, externalId: String(i + 1), channelStatus: 'faktura BL', status: 'WYSLANE' as const, createdAtChannel: new Date('2025-06-01T10:00:00Z'), paymentState: 'PAID' as const, totalGross: '1.00', currency: 'PLN', trackingNumbers: [], invoiceNumbers: [], channelInferred: true })) })
    const k: KandydatPary = { kanal: 'archiwum:WOO:x', id: 'w', czas: new Date(), bruttoGr: 100, waluta: 'PLN', skus: [] }
    const zr = zrodloFakturyBl([], new Map(Array.from({ length: n }, (_, i) => [i + 1, k] as const)))
    expect(await zr.wycofaj!(a, { konto, do: new Date('2025-12-01'), naSucho: true })).toBe(n)
    expect(await a.archivedOrder.count({ where: { source: 'BL_FAKTURA' } })).toBe(n)
    expect(await zr.wycofaj!(a, { konto, do: new Date('2025-12-01'), naSucho: false })).toBe(n)
    expect(await a.archivedOrder.count({ where: { source: 'BL_FAKTURA' } })).toBe(0)
  })

  it('przerwany przebieg nie wznawia się z innym plikiem źródeł albo mapą', async () => {
    await archiwumInnych()
    const f = await plik([faktura(2, '2025-06-12T09:00:00Z', 40)])
    expect(await cli(f, { wykonaj: true })).toBe(0)
    const run = await a.importRun.findFirstOrThrow({ where: { kind: 'archiwum-faktury-bl' } })
    await a.importRun.update({ where: { id: run.id }, data: { status: 'PARTIAL', stats: { ...(run.stats as object), koniec: false } } })
    const zr = await plikZrodel([NAGLOWEK, '7002;konto_aukcji;;;', ''].join('\n'))
    const blad = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await cli(f, { zrodlaBl: zr, mapaZrodel: MAPA_TEST, wykonaj: true })).toBe(1)
    expect(blad.mock.calls.flat().join(' ')).toMatch(/inne opcje mapowania.*wznowienie odmówione.*przebieg bez skrótu.*dokończ go bez --zrodla-bl/)
    blad.mockRestore()
    expect(await a.archivedOrder.findMany({ where: { source: 'BL_FAKTURA' }, select: { externalId: true, channelInferred: true } })).toEqual([{ externalId: '2', channelInferred: true }])
    expect(await cli(f, { wykonaj: true })).toBe(0) // te same opcje: wznowienie
  })

  it('plik źródeł BL: kolumny z danymi klientów albo brak mapy = błąd przed zapisem', async () => {
    await archiwumInnych()
    const f = await plik([faktura(2, '2025-06-12T09:00:00Z', 40)])
    const surowy = await plikZrodel('order_id;pochodzenie;email\n7002;konto_aukcji;ktos@example.test\n')
    await expect(cli(f, { zrodlaBl: surowy, mapaZrodel: MAPA_TEST, wykonaj: true })).rejects.toThrow(/kolumny spoza listy \(email\)/)
    await expect(cli(f, { zrodlaBl: surowy, wykonaj: true })).rejects.toThrow(/podaje się razem/)
    await expect(cli(f, { mapaZrodel: MAPA_TEST, wykonaj: true })).rejects.toThrow(/podaje się razem/)
    await expect(cli(f, { pozwolBezOdpowiednika: true, wykonaj: true })).rejects.toThrow(/tylko z --zrodla-bl/)
    const zr = await plikZrodel([NAGLOWEK, '7002;konto_aukcji;;;', ''].join('\n'))
    await expect(cli(f, { zrodlaBl: zr, mapaZrodel: MAPA_TEST, progBezOdpowiednika: '1e3' })).rejects.toThrow(/kwota w zł/)
    expect(await a.archivedOrder.count({ where: { source: 'BL_FAKTURA' } })).toBe(0)
  })

  it('tylko kanał ALLEGRO; nie razem z --z-pliku', async () => {
    const f = await plik([])
    await expect(cli(f, { kanal: 'EMPIK' })).rejects.toThrow(/tylko z --kanal ALLEGRO/)
    await expect(cli(f, { zPliku: f })).rejects.toThrow(/naraz/)
  })
})
