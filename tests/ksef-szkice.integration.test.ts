// na bazie: szkice KSeF (statusy, idempotencja, wiersz z numerem nietykalny, „nie dotyczy”, firma z wFirmą),
// izolacja dwóch firm, brak danych nabywcy w bazie, numeracja (20 równoległych, reset okresu, brak dziury po wycofaniu),
// pętla dnia i polecenie. Dane fikcyjne, zero połączeń z KSeF (także TEST i DEMO), BL i wFirmą.
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PII_SENTINELS } from '@/lib/adaptery/suita-kontraktowa'
import { zbudujFa3 } from '@/lib/ksef/fa3/builder'
import { przydzielNumer, type SeriaNumeracji } from '@/lib/ksef/numeracja'
import { idSzkicu, NABYWCA_ZASTEPCZY, NIE_DOTYCZY_WFIRMA, podgladKsef, prepareKsefDay, prepareKsefForOrder } from '@/lib/ksef/szkice'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { ACME_PRESET } from '@/tests/preset-testowy'
import { renderKsefPodglad } from '@/scripts/ksef'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { bundle, order, product, seedBase } from './rdzen-fixtures'

const db = testDb()
const dbB = testDb({ organizationId: ORG_B })
const dbPula = testDb({ poolMax: 20 })
const sys = testSystemDb()
afterAll(async () => {
  await db.$disconnect()
  await dbB.$disconnect()
  await dbPula.$disconnect()
})

const DZIEN = '2026-11-02'
const T = new Date('2026-11-02T09:00:00.000Z')
const KSEF = {
  faktury: { program: 'ksef' },
  ksef: { sprzedawca: { nip: '1111111111', nazwa: 'Sprzedawca Testowy sp. z o.o.', adres: { linia1: 'ul. Fikcyjna 1', linia2: '00-001 Warszawa' } }, seriaKod: 'FV' },
}
let xsdPusty: string
const opts = () => ({ now: T, xsdDir: xsdPusty })

async function zamowienie(c: typeof db, over: Record<string, unknown> = {}, linie?: Parameters<typeof order>[0]): Promise<string> {
  const pid = await product(c, `HERB-${Math.random().toString(36).slice(2, 8)}`, 50)
  const { orderId } = await ingestOrder(c, order(linie ?? [{ productId: pid, qty: 2, unitPriceGross: 10 }], { totalGross: 32, createdAtChannel: T, wantInvoiceNip: true, ...over }), { now: T })
  return orderId!
}

beforeAll(async () => {
  xsdPusty = await mkdtemp(path.join(tmpdir(), 'ksef-bez-xsd-'))
})

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  await seedBase(dbB)
  await sys.organization.update({ where: { id: ORG_A }, data: { settings: KSEF } })
  await sys.organization.update({ where: { id: ORG_B }, data: { settings: KSEF } })
})

describe('prepareKsefForOrder', () => {
  it('firma z wFirmą (ustawienia ACME z tests/preset-testowy.ts): jawne „nie dotyczy”, bez szkicu', async () => {
    await sys.organization.update({ where: { id: ORG_A }, data: { settings: ACME_PRESET.settings as never } })
    const id = await zamowienie(db)
    expect(await prepareKsefForOrder(db, id, opts())).toEqual({ wynik: 'nie_dotyczy', powod: NIE_DOTYCZY_WFIRMA })
    expect(await db.ksefInvoiceDraft.count()).toBe(0)
    expect(await podgladKsef(db, id)).toBeNull()
    expect((await prepareKsefDay(db, { dzien: DZIEN, ...opts() })).dotyczy).toBe(false)
    expect(await db.ksefInvoiceDraft.count()).toBe(0)
  })

  it('B2B: szkic złożony z nabywcą zastępczym, P_2 = SZKIC-<id>, numer pusty, suma = totalGross, bez XSD → ZLOZONA', async () => {
    const id = await zamowienie(db)
    const przed = await db.order.findUniqueOrThrow({ where: { id }, include: { reservations: true, events: true, lines: true } })
    const r = await prepareKsefForOrder(db, id, opts())
    expect(r).toMatchObject({ wynik: 'przygotowana', status: 'ZLOZONA', problemy: [] })
    const w = await db.ksefInvoiceDraft.findFirstOrThrow({ where: { orderId: id } })
    expect(w).toMatchObject({ id: idSzkicu(ORG_A, id, 1), organizationId: ORG_A, packageNo: 1, status: 'ZLOZONA', numer: null, seriaKod: 'FV', wersjaSchemy: 'FA (3) 1-0E', bruttoGr: 3200, nettoGr: 2602 })
    expect(w.xml).toContain(`<P_2>SZKIC-${w.id}</P_2>`)
    expect(w.xml).toContain(`<BrakID>1</BrakID><Nazwa>${NABYWCA_ZASTEPCZY}</Nazwa>`)
    expect(w.xml).toContain('<P_15>32.00</P_15>')
    expect(w.xml).toContain('<P_7>Wysyłka</P_7>')
    expect(w.xmlSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(w.walidacja).toMatchObject({ stan: 'XSD_NIEDOSTEPNY' })
    // bez skutków w zamówieniu
    expect(await db.order.findUniqueOrThrow({ where: { id }, include: { reservations: true, events: true, lines: true } })).toEqual(przed)
    expect(await podgladKsef(db, id)).toMatchObject({ nieDotyczy: null, zapisany: { status: 'ZLOZONA', numer: null, bruttoGr: 3200 } })
  })

  it('zestaw: rozbity na składniki, suma = totalGross', async () => {
    const s1 = await product(db, 'S1', 50, { priceGross: 20, vatRate: '5' })
    const s2 = await product(db, 'S2', 50, { priceGross: 20, vatRate: '23' })
    const z = await bundle(db, 'Z1', [
      { id: s1, qty: 1 },
      { id: s2, qty: 1 },
    ])
    const id = await zamowienie(db, { totalGross: 33 }, [{ productId: z, qty: 1, unitPriceGross: 33 }])
    expect(await prepareKsefForOrder(db, id, opts())).toMatchObject({ status: 'ZLOZONA', problemy: [] })
    const w = await db.ksefInvoiceDraft.findFirstOrThrow({ where: { orderId: id } })
    expect(w.bruttoGr).toBe(3300)
    expect(w.xml).toContain('<P_7>Towar testowy S1</P_7>')
    expect(w.xml).toContain('<P_13_3>15.71</P_13_3>')
  })

  it('osoba prywatna: POZA_KSEF; z konsumenciDoKsef — zwykły szkic', async () => {
    const id = await zamowienie(db, { wantInvoiceNip: false })
    expect(await prepareKsefForOrder(db, id, opts())).toMatchObject({ status: 'POZA_KSEF' })
    await sys.organization.update({ where: { id: ORG_A }, data: { settings: { ...KSEF, ksef: { ...KSEF.ksef, konsumenciDoKsef: true } } } })
    expect(await prepareKsefForOrder(db, id, opts())).toMatchObject({ status: 'ZLOZONA' })
  })

  it('brak danych sprzedawcy i stawka nieznana: BLAD_WALIDACJI, XML pusty, wszystkie problemy naraz', async () => {
    await sys.organization.update({ where: { id: ORG_A }, data: { settings: { faktury: { program: 'ksef' } } } })
    const pid = await product(db, 'DZIWNA', 50, { vatRate: '7' })
    const id = await zamowienie(db, {}, [{ productId: pid, qty: 2, unitPriceGross: 10 }])
    const r = await prepareKsefForOrder(db, id, opts())
    expect(r).toMatchObject({ status: 'BLAD_WALIDACJI' })
    const w = await db.ksefInvoiceDraft.findFirstOrThrow({ where: { orderId: id } })
    expect(w.xml).toBeNull()
    expect(w.xmlSha256).toBeNull()
    expect((w.problems as { kod: string }[]).map((p) => p.kod).sort()).toEqual(['brak-adresu-sprzedawcy', 'brak-nazwy-sprzedawcy', 'brak-nip-sprzedawcy', 'brak-serii', 'stawka-nieznana'])
  })

  it('idempotencja: ponowienie i równoległe wywołania nadpisują jeden wiersz o stałym id', async () => {
    const id = await zamowienie(db)
    await prepareKsefForOrder(db, id, opts())
    const pierwszy = await db.ksefInvoiceDraft.findFirstOrThrow({ where: { orderId: id } })
    await prepareKsefForOrder(db, id, { ...opts(), now: new Date(T.getTime() + 60_000) })
    await Promise.all([prepareKsefForOrder(db, id, opts()), prepareKsefForOrder(db, id, opts()), prepareKsefForOrder(db, id, opts())])
    expect(await db.ksefInvoiceDraft.count({ where: { orderId: id } })).toBe(1)
    expect((await db.ksefInvoiceDraft.findFirstOrThrow({ where: { orderId: id } })).id).toBe(pierwszy.id)
    // równolegle od zera (bez istniejącego wiersza)
    const id2 = await zamowienie(db)
    await Promise.all(Array.from({ length: 4 }, () => prepareKsefForOrder(db, id2, opts())))
    expect(await db.ksefInvoiceDraft.count({ where: { orderId: id2 } })).toBe(1)
  })

  it('wiersz z numerem nie zmienia się nigdy (także przy anulowaniu)', async () => {
    const id = await zamowienie(db)
    await prepareKsefForOrder(db, id, opts())
    await db.ksefInvoiceDraft.updateMany({ where: { orderId: id }, data: { numer: 'FV/1/11/2026' } })
    const przed = await db.ksefInvoiceDraft.findFirstOrThrow({ where: { orderId: id } })
    await sys.organization.update({ where: { id: ORG_A }, data: { settings: { faktury: { program: 'ksef' } } } })
    expect(await prepareKsefForOrder(db, id, opts())).toMatchObject({ wynik: 'zablokowana' })
    await db.order.update({ where: { id }, data: { status: 'ANULOWANE' } })
    expect(await prepareKsefForOrder(db, id, opts())).toMatchObject({ wynik: 'nie_dotyczy' })
    expect(await db.ksefInvoiceDraft.findFirstOrThrow({ where: { orderId: id } })).toEqual(przed)
  })

  it('anulowane i bez pozycji: „nie dotyczy”, a stary szkic bez numeru znika', async () => {
    const id = await zamowienie(db)
    await prepareKsefForOrder(db, id, opts())
    await db.order.update({ where: { id }, data: { status: 'ANULOWANE' } })
    expect(await prepareKsefForOrder(db, id, opts())).toEqual({ wynik: 'nie_dotyczy', powod: 'Zamówienie anulowane.' })
    expect(await db.ksefInvoiceDraft.count({ where: { orderId: id } })).toBe(0)
    const id3 = await zamowienie(db)
    await db.orderLine.updateMany({ where: { orderId: id3 }, data: { removed: true } })
    expect(await prepareKsefForOrder(db, id3, opts())).toEqual({ wynik: 'nie_dotyczy', powod: 'Zamówienie nie ma pozycji.' })
  })

  it('zamówienie bez wysyłki z samym produktem DIGITAL (e-book) dostaje szkic, bez wiersza „Wysyłka”', async () => {
    const pid = await product(db, `EBOOK-${Math.random().toString(36).slice(2, 8)}`, 0)
    await db.product.update({ where: { id: pid }, data: { kind: 'DIGITAL' } })
    const { orderId: oid } = await ingestOrder(db, order([{ productId: pid, qty: 1, unitPriceGross: 49 }], { totalGross: 49, createdAtChannel: T, wantInvoiceNip: true }), { now: T })
    const orderId = oid!
    await db.order.update({ where: { id: orderId }, data: { carrier: 'BEZ_WYSYLKI' } })
    const w = await prepareKsefForOrder(db, orderId, opts())
    expect(w).toMatchObject({ wynik: 'przygotowana', status: 'ZLOZONA', problemy: [] })
    const s = await db.ksefInvoiceDraft.findFirstOrThrow({ where: { orderId } })
    expect(s.bruttoGr).toBe(4900)
    expect(s.xml).not.toContain('Wysyłka')
    expect([...s.xml!.matchAll(/<FaWiersz>/g)]).toHaveLength(1)
  })

  it('izolacja dwóch firm: firma B nie widzi i nie nadpisuje szkicu firmy A', async () => {
    const a = await zamowienie(db)
    const b = await zamowienie(dbB)
    await prepareKsefForOrder(db, a, opts())
    await prepareKsefForOrder(dbB, b, opts())
    expect((await db.ksefInvoiceDraft.findMany()).map((w) => w.orderId)).toEqual([a])
    expect((await dbB.ksefInvoiceDraft.findMany()).map((w) => w.orderId)).toEqual([b])
    await expect(prepareKsefForOrder(dbB, a, opts())).rejects.toThrow(/Nie ma takiego zamówienia/)
    expect(await dbB.ksefInvoiceDraft.updateMany({ data: { status: 'X' } })).toEqual({ count: 1 })
    expect((await db.ksefInvoiceDraft.findFirstOrThrow()).status).toBe('ZLOZONA')
    expect(await sys.ksefInvoiceDraft.count()).toBe(2)
  })

  it('PII_SENTINELS z argumentu nabywcy nie trafiają do bazy ani logu', async () => {
    const log = vi.spyOn(console, 'log')
    const warn = vi.spyOn(console, 'warn')
    const err = vi.spyOn(console, 'error')
    try {
      // prawdziwy nabywca istnieje tylko jako argument buildera (przyszła wysyłka); XML z nim nie jest nigdzie zapisywany
      const zNabywca = zbudujFa3({
        numer: 'SZKIC-x',
        dataWystawienia: DZIEN,
        wytworzono: T,
        waluta: 'PLN',
        rodzaj: 'VAT',
        sprzedawca: { nip: '1111111111', nazwa: 'Sprzedawca', adres: { kodKraju: 'PL', linia1: 'ul. A 1' } },
        nabywca: { nip: '1234563218', nazwa: PII_SENTINELS[0]!, adres: { kodKraju: 'PL', linia1: PII_SENTINELS[3]!, linia2: PII_SENTINELS[1]! } },
        wiersze: [{ nazwa: 'Przyprawa', jednostka: 'szt.', ilosc: 1, cenaBruttoGr: 1000, bruttoGr: 1000, stawka: '23' }],
      })
      expect(zNabywca.xml).toContain(PII_SENTINELS[0])
      expect(zNabywca.xml).toContain('<NIP>1234563218</NIP>')
      const id = await zamowienie(db)
      await prepareKsefForOrder(db, id, opts())
      await prepareKsefDay(db, { dzien: DZIEN, ...opts() })
      const zrzut = JSON.stringify([await sys.ksefInvoiceDraft.findMany(), await sys.invoiceNumberSeries.findMany(), await sys.order.findMany({ include: { lines: true } })])
      for (const s of [...PII_SENTINELS, '1234563218']) expect(zrzut).not.toContain(s)
      const wypisane = JSON.stringify([log.mock.calls, warn.mock.calls, err.mock.calls])
      for (const s of [...PII_SENTINELS, '1234563218']) expect(wypisane).not.toContain(s)
    } finally {
      log.mockRestore()
      warn.mockRestore()
      err.mockRestore()
    }
  })
})

describe('prepareKsefDay i polecenie', () => {
  it('liczby per status, numery zamówień, problemy bez danych klientów; błąd jednego nie zatrzymuje dnia', async () => {
    await zamowienie(db, { externalId: 'K-1' })
    await zamowienie(db, { externalId: 'K-2', wantInvoiceNip: false })
    const pid = await product(db, 'BEZSTAWKI', 50, { vatRate: '7' })
    await zamowienie(db, { externalId: 'K-3' }, [{ productId: pid, qty: 2, unitPriceGross: 10 }])
    await zamowienie(db, { externalId: 'K-4', cancelled: true })
    await zamowienie(db, { externalId: 'K-inny-dzien', createdAtChannel: new Date('2026-11-03T09:00:00Z') })
    const r = await prepareKsefDay(db, { dzien: DZIEN, ...opts() })
    expect(r).toMatchObject({ dotyczy: true, zamowienia: 4, nieDotyczy: 1, perStatus: { ZLOZONA: 1, POZA_KSEF: 1, BLAD_WALIDACJI: 1, ODLOZONA: 0 }, bledy: [] })
    expect(r.numery).toMatchObject({ ZLOZONA: ['K-1'], POZA_KSEF: ['K-2'], BLAD_WALIDACJI: ['K-3'] })
    expect(r.listaProblemow).toEqual([{ numerZamowienia: 'K-3', kody: ['stawka-nieznana'] }])
    const t = renderKsefPodglad(r)
    expect(t).toContain('nic nie zostało wysłane')
    expect(t).toContain('K-3: stawka-nieznana')
    expect(t).toContain('sprawdzona schematem; przy wysyłce składana ponownie z nabywcą, datą i numerem: 0')
    expect(await db.ksefInvoiceDraft.count()).toBe(3)
  })
})

describe('numeracja (przydzielNumer)', () => {
  const SERIA: SeriaNumeracji = { code: 'FV', pattern: 'FV/{NR}/{MM}/{RRRR}', resetPeriod: 'MIESIAC' }

  it('20 równoległych transakcji: numery 1..20 bez dubla i bez dziury', async () => {
    const numery = await Promise.all(Array.from({ length: 20 }, () => dbPula.$transaction((tx) => przydzielNumer(tx, SERIA, DZIEN))))
    expect(numery.map((n) => n.nr).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    expect(new Set(numery.map((n) => n.numer)).size).toBe(20)
    expect(numery.find((n) => n.nr === 7)!.numer).toBe('FV/7/11/2026')
    expect(await db.invoiceNumberSeries.findMany({ select: { organizationId: true, periodKey: true, lastNo: true } })).toEqual([{ organizationId: ORG_A, periodKey: '2026-11', lastNo: 20 }])
  })

  it('reset okresu: nowy miesiąc (i rok) od 1, seria bez resetu ciągnie dalej', async () => {
    expect((await db.$transaction((tx) => przydzielNumer(tx, SERIA, '2026-11-30'))).numer).toBe('FV/1/11/2026')
    expect((await db.$transaction((tx) => przydzielNumer(tx, SERIA, '2026-11-30'))).numer).toBe('FV/2/11/2026')
    expect((await db.$transaction((tx) => przydzielNumer(tx, SERIA, '2026-12-01'))).numer).toBe('FV/1/12/2026')
    const roczna: SeriaNumeracji = { code: 'R', pattern: 'R/{NR}/{RRRR}', resetPeriod: 'ROK' }
    expect((await db.$transaction((tx) => przydzielNumer(tx, roczna, '2026-12-31'))).numer).toBe('R/1/2026')
    expect((await db.$transaction((tx) => przydzielNumer(tx, roczna, '2027-01-01'))).numer).toBe('R/1/2027')
    const ciagla: SeriaNumeracji = { code: 'C', pattern: 'C/{NR}', resetPeriod: 'NIGDY' }
    await db.$transaction((tx) => przydzielNumer(tx, ciagla, '2026-12-31'))
    expect((await db.$transaction((tx) => przydzielNumer(tx, ciagla, '2027-01-01'))).numer).toBe('C/2')
  })

  it('wycofana transakcja nie zostawia dziury; serie firm są osobne', async () => {
    await db.$transaction((tx) => przydzielNumer(tx, SERIA, DZIEN))
    await expect(
      db.$transaction(async (tx) => {
        await przydzielNumer(tx, SERIA, DZIEN)
        throw new Error('zatwierdzenie nieudane')
      }),
    ).rejects.toThrow('zatwierdzenie nieudane')
    expect((await db.$transaction((tx) => przydzielNumer(tx, SERIA, DZIEN))).nr).toBe(2)
    expect((await dbB.$transaction((tx) => przydzielNumer(tx, SERIA, DZIEN))).nr).toBe(1)
  })

  // numer z serii nadaje wyłącznie wysyłka do KSeF (lib/ksef/wysylka.ts), raz na dokument, w transakcji pod blokadą
  it('strażnik: przydzielNumer woła tylko wysyłka do KSeF (żaden inny kod w lib/, worker/, app/, scripts/)', async () => {
    const ROOT = path.resolve(__dirname, '..')
    const pliki: string[] = []
    const walk = async (d: string) => {
      for (const f of await readdir(d)) {
        const p = path.join(d, f)
        if ((await stat(p)).isDirectory()) await walk(p)
        else if (/\.(ts|tsx)$/.test(f) && !/\.test\.ts$/.test(f)) pliki.push(path.relative(ROOT, p).replace(/\\/g, '/'))
      }
    }
    for (const d of ['lib', 'worker', 'app', 'scripts']) await walk(path.join(ROOT, d))
    const uzycia = []
    for (const f of pliki) if (f !== 'lib/ksef/numeracja.ts' && /\bprzydzielNumer\b/.test(await readFile(path.join(ROOT, f), 'utf8'))) uzycia.push(f)
    expect(uzycia).toEqual(['lib/ksef/wysylka.ts'])
  })
})
