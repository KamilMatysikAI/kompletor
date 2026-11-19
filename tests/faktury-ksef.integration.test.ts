// na bazie: faktury v2 dla firmy bez BL i bez wFirmy (program „KSeF bezpośrednio”, stan prowadzi Kompletor).
// Kryteria: wysyłka FA(3) na nagranych odpowiedziach KSeF TEST (atrapa, tests/ksef-atrapa.ts), numer KSeF i UPO
// zapisane; błąd KSeF widoczny na liście z „Ponów”; ponowienie po zgubionej odpowiedzi nie tworzy drugiej faktury;
// 20 równoległych wystawień w jednej serii = numery 1–20 bez dziur i dubli; korekta dostaje numer z serii korekt;
// PDF z naszego generatora; lista faktur i korekt; bramka (wyłącznik, tryb konta, produkcja zamknięta w testach).
// Dane fikcyjne, NIP-y testowe, zero połączeń z siecią (atrapa odrzuca każdy adres spoza KSeF TEST).
// Każdy scenariusz waliduje XML prawdziwymi schematami FA(3) z repo (lib/ksef/xsd); brak schematów
// = odmowa wysyłki (osobny test niżej), więc ich brak w repo kończy się czerwonymi testami, nie cichym pominięciem.
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { listaFaktur } from '@/lib/dokumenty/lista'
import { pdfDokumentuKsef, polaczPdf } from '@/lib/dokumenty/pdf-ksef'
import { zapiszRekordKlienta } from '@/lib/klienci/zapis'
import { rekordZOdbiorcy } from '@/lib/klienci/rekord'
import { PROBY_ODCZYTU_STANU, przebiegKsef, przebiegKsefZLimitem, wyslijDoKsef, wyslijFaktureKsef, wyslijKorekteKsef, type ZaleznosciWysylki } from '@/lib/ksef/wysylka'
import { markShipped, readyForDispatch } from '@/lib/rdzen/przejscia'
import { packOrder } from '@/lib/rdzen/rozchod'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { createReturn, receiveReturn } from '@/lib/rdzen/zwroty'
import type { OrderRecipient } from '@/lib/adaptery/kontrakt'
import { kartaZwrotu } from '@/lib/zwroty/karta'
import { atrapaKsef } from './ksef-atrapa'
import { ORG_A, testDb, testSystemDb, truncateAll } from './db'
import { order, product, seedBase } from './rdzen-fixtures'

vi.mock('server-only', () => ({}))

const db = testDb()
const dbPula = testDb({ poolMax: 20 })
const sys = testSystemDb()
afterAll(async () => {
  await db.$disconnect()
  await dbPula.$disconnect()
})

const T = new Date('2026-11-09T09:00:00.000Z')
const NIP_NABYWCY = '5260001246' // fikcyjny NIP z poprawną sumą kontrolną (jak w tests/dane-klienta)
const ENV = { DANE_KLIENTA_ZAPIS: '1', CUSTOMER_DATA_KEYS: `1:${'1'.repeat(64)}`, CUSTOMER_LOOKUP_KEY: 'a'.repeat(64) }
const NABYWCA: OrderRecipient = {
  dostawa: { imieNazwisko: 'Jan Testowy', firma: null, ulica: 'ul. Fikcyjna 9', numerDomu: '1', numerLokalu: null, kodPocztowy: '60-001', miasto: 'Poznań', kraj: 'PL', telefon: '+48500000001', email: 'jan@example.test' },
  punktOdbioru: null,
  faktura: { nazwa: 'Nabywca Testowy sp. z o.o.', nip: NIP_NABYWCY, ulica: 'ul. Fikcyjna 9', kodPocztowy: '60-001', miasto: 'Poznań', kraj: 'PL' },
  problemy: [],
}
const USTAWIENIA = {
  faktury: { program: 'ksef', fakturyWlaczone: true, fakturyWlaczoneOd: '2026-11-01T00:00:00.000Z', wystawiajPrzy: 'SPAKOWANE' },
  ksef: {
    sprzedawca: { nip: '1111111111', nazwa: 'Sprzedawca Testowy sp. z o.o.', adres: { linia1: 'ul. Testowa 1', linia2: '00-001 Warszawa' } },
    seriaKod: 'FV',
    seriaWzor: '%N/%M/%Y',
    seriaReset: 'MIESIAC',
    seriaKorektKod: 'KOR',
    seriaKorektWzor: '%N/%M/%Y/K',
    seriaKorektReset: 'MIESIAC',
    srodowisko: 'TEST',
  },
}
let xsdPusty: string
/** Sztuczny zegar limitów: przesuwa go `sleep` atrapy, testy nie czekają naprawdę. */
let zegarMs = 0

beforeAll(async () => {
  xsdPusty = await mkdtemp(path.join(tmpdir(), 'ksef-a150-bez-xsd-'))
  vi.stubEnv('CUSTOMER_DATA_KEYS', ENV.CUSTOMER_DATA_KEYS)
  vi.stubEnv('CUSTOMER_LOOKUP_KEY', ENV.CUSTOMER_LOOKUP_KEY)
})

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  // firma bez wFirmy i bez BL: stan prowadzi Kompletor, sklep w trybie Aktywny
  await db.warehouse.updateMany({ data: { stockSource: 'KOMPLETOR', wfirmaWarehouseId: null } })
  await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })
  await sys.organization.update({ where: { id: ORG_A }, data: { settings: USTAWIENIA } })
  zegarMs = T.getTime()
})

const deps = (a: ReturnType<typeof atrapaKsef>, over: Partial<ZaleznosciWysylki> = {}): ZaleznosciWysylki => ({
  secrets: { env: { KSEF_TOKEN: 'token-testowy-atrapy' }, envFallback: true },
  env: {},
  fetch: a.fetch,
  sleep: async (ms: number) => {
    zegarMs += ms
  },
  zegar: () => zegarMs,
  now: T,
  ...over,
})

async function zamowienie(c: typeof db = db, nabywca = true): Promise<string> {
  const pid = await product(c, `A150-${Math.random().toString(36).slice(2, 8)}`, 50)
  const { orderId } = await ingestOrder(c, order([{ productId: pid, qty: 2, unitPriceGross: 10 }], { totalGross: 32, createdAtChannel: T, wantInvoiceNip: nabywca }), { now: T })
  if (nabywca) await zapiszRekordKlienta(c, orderId!, rekordZOdbiorcy(NABYWCA), { source: 'RECZNE', fetchedAt: T, env: ENV })
  return orderId!
}

async function tekstPdf(pdf: Uint8Array): Promise<string> {
  const d = await getDocument({ data: new Uint8Array(pdf), useSystemFonts: false }).promise
  let t = ''
  for (let i = 1; i <= d.numPages; i++) t += (await (await d.getPage(i)).getTextContent()).items.map((x) => ('str' in x ? x.str : '')).join(' ')
  return t
}

describe('wysyłka faktury do KSeF (atrapa KSeF TEST)', () => {
  it('firma bez BL i bez wFirmy: numer z serii, numer KSeF i UPO zapisane, faktura na liście, PDF z generatora; XML z nabywcą nie w bazie', async () => {
    const a = atrapaKsef()
    const id = await zamowienie()
    // schematy FA(3) z repo (lib/ksef/xsd): wysłana faktura z prawdziwym nabywcą przechodzi XSD
    const w = await wyslijFaktureKsef(db, id, deps(a))
    expect(w).toMatchObject({ wynik: 'przyjeta', numer: '1/11/2026', ksefNumer: expect.stringMatching(/^5260250274-20261109-/) })
    const d = await db.ksefInvoiceDraft.findFirstOrThrow({ where: { orderId: id, returnId: '' } })
    expect(d).toMatchObject({ status: 'PRZYJETA', numer: '1/11/2026', dataWystawienia: '2026-11-09', srodowisko: 'TEST', proby: 1, lastError: null })
    expect(d.upo).toContain('UPO')
    expect(d.sesjaRef).toBeTruthy()
    // do KSeF poszedł prawdziwy nabywca, w bazie go nie ma
    expect(a.faktury).toHaveLength(1)
    expect(a.faktury[0]!.xml).toContain(`<NIP>${NIP_NABYWCY}</NIP>`)
    expect(a.faktury[0]!.xml).toContain('<P_2>1/11/2026</P_2>')
    expect(JSON.stringify(d)).not.toContain('Nabywca Testowy')
    expect(JSON.stringify(d)).not.toContain(NIP_NABYWCY)
    // drugi raz: bez sieci, ta sama faktura
    const n = a.wywolania.length
    expect(await wyslijFaktureKsef(db, id, deps(a))).toMatchObject({ wynik: 'przyjeta', numer: '1/11/2026' })
    expect(a.wywolania.length).toBe(n)

    const lista = await listaFaktur(db, { zakladka: 'faktury', rok: 2026, miesiac: 11 })
    expect(lista.wiersze).toHaveLength(1)
    expect(lista.wiersze[0]).toMatchObject({ program: 'ksef', numer: '1/11/2026', stan: 'WYSTAWIONA', ksefNumer: d.ksefNumer, nabywca: 'firma', bruttoGr: 3200, pdf: { draftId: d.id }, ponow: null })
    expect(lista.wiersze[0]!.stanTekst).toBe('Wysłana do KSeF')
    expect((await listaFaktur(db, { zakladka: 'faktury', rok: 2026, miesiac: 10 })).wiersze).toHaveLength(0)
    expect((await listaFaktur(db, { zakladka: 'faktury', seria: '1/' })).wiersze).toHaveLength(1)
    expect((await listaFaktur(db, { zakladka: 'faktury', seria: 'FV' })).wiersze).toHaveLength(0)

    const pdf = await pdfDokumentuKsef(db, d.id, { actorId: 'test' })
    expect(pdf.nazwaPliku).toBe('faktura-1-11-2026.pdf')
    const tekst = await tekstPdf(pdf.bytes)
    expect(tekst).toContain('1/11/2026')
    expect(tekst).toContain(d.ksefNumer!)
    expect(tekst).toContain('Nabywca Testowy')
    expect(tekst).toContain('Razem do zapłaty')
    expect(await db.auditLog.count({ where: { entityId: id, actorId: 'test' } })).toBe(1)
    const dwa = await polaczPdf([pdf.bytes, pdf.bytes])
    expect((await getDocument({ data: dwa }).promise).numPages).toBeGreaterThanOrEqual(2)
  })

  it('zgubiona odpowiedź przy wysyłce: błąd z tym samym numerem, ponowienie → KSeF odrzuca dubel (440) i podaje numer oryginału; w KSeF jedna faktura', async () => {
    const a = atrapaKsef({ zgubOdpowiedzWysylki: 1 })
    const id = await zamowienie()
    const w1 = await wyslijFaktureKsef(db, id, deps(a))
    expect(w1).toMatchObject({ wynik: 'blad', numer: '1/11/2026', powod: expect.stringMatching(/Brak odpowiedzi KSeF/) })
    const d1 = await db.ksefInvoiceDraft.findFirstOrThrow({ where: { orderId: id } })
    expect(d1).toMatchObject({ status: 'BLAD_WYSYLKI', numer: '1/11/2026', fakturaRef: null })
    expect(a.faktury).toHaveLength(1) // KSeF ją przyjął, tylko odpowiedź zginęła
    const lista = await listaFaktur(db, { zakladka: 'faktury' })
    expect(lista.wiersze[0]).toMatchObject({ stan: 'BLAD', ponow: 'ksef', blad: expect.stringMatching(/Ponów/) })

    const w2 = await wyslijDoKsef(db, d1.id, deps(a))
    expect(w2).toMatchObject({ wynik: 'przyjeta', numer: '1/11/2026', ksefNumer: a.faktury[0]!.ksefNumer })
    const d2 = await db.ksefInvoiceDraft.findUniqueOrThrow({ where: { id: d1.id } })
    expect(d2).toMatchObject({ status: 'PRZYJETA', ksefNumer: a.faktury[0]!.ksefNumer, proby: 2, lastError: expect.stringMatching(/dubel 440/) })
    expect(a.faktury).toHaveLength(1)
    // numer nie zjadł kolejnego z serii
    expect(await wyslijFaktureKsef(db, await zamowienie(), deps(a))).toMatchObject({ numer: '2/11/2026' })
  })

  it('KSeF odrzuca treść (450): ODRZUCONA na liście z „Ponów”; po ponowieniu ten sam numer', async () => {
    const zla = atrapaKsef({ kodStatusu: 450 })
    const id = await zamowienie()
    expect(await wyslijFaktureKsef(db, id, deps(zla))).toMatchObject({ wynik: 'odrzucona', numer: '1/11/2026', powod: expect.stringMatching(/\[450\]/) })
    const lista = await listaFaktur(db, { zakladka: 'faktury', tylkoBledy: true })
    expect(lista.wiersze).toHaveLength(1)
    expect(lista.wiersze[0]).toMatchObject({ stan: 'BLAD', ponow: 'ksef', stanTekst: 'odrzucona przez KSeF' })
    const dobra = atrapaKsef()
    const d = await db.ksefInvoiceDraft.findFirstOrThrow({ where: { orderId: id } })
    expect(await wyslijDoKsef(db, d.id, deps(dobra))).toMatchObject({ wynik: 'przyjeta', numer: '1/11/2026' })
  })

  it('przetwarzanie dłuższe niż czekanie: WYSLANA, a przebieg workera dociąga numer KSeF bez drugiej wysyłki', async () => {
    const a = atrapaKsef({ przetwarzanie: 3 })
    const id = await zamowienie()
    expect(await wyslijFaktureKsef(db, id, deps(a, { czekajNaWynikMs: 0 }))).toMatchObject({ wynik: 'w_toku' })
    expect(await db.ksefInvoiceDraft.findFirstOrThrow({ where: { orderId: id } })).toMatchObject({ status: 'WYSLANA' })
    for (let i = 0; i < 3; i++) await przebiegKsef(db, deps(a, { czekajNaWynikMs: 0 }))
    expect(await db.ksefInvoiceDraft.findFirstOrThrow({ where: { orderId: id } })).toMatchObject({ status: 'PRZYJETA', ksefNumer: a.faktury[0]!.ksefNumer })
    expect(a.faktury).toHaveLength(1)
    expect(a.wywolania.filter((x) => /POST \/sessions\/online\/[^/]+\/invoices$/.test(x))).toHaveLength(1)
  })

  it('20 równoległych wystawień w jednej serii: numery 1–20 bez dziur i dubli', async () => {
    const a = atrapaKsef()
    const ids: string[] = []
    for (let i = 0; i < 20; i++) ids.push(await zamowienie())
    const wyniki = await Promise.all(ids.map((id) => wyslijFaktureKsef(dbPula, id, deps(a))))
    expect(wyniki.every((w) => w.wynik === 'przyjeta')).toBe(true)
    const numery = (await db.ksefInvoiceDraft.findMany({ select: { numer: true } })).map((d) => Number(d.numer!.split('/')[0])).sort((x, y) => x - y)
    expect(numery).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    expect(new Set(a.faktury.map((f) => f.numer)).size).toBe(20)
  })

  it('korekta przy zwrocie: numer z serii korekt, NrKSeF faktury korygowanej, lista korekt z powiązaniem do faktury i zwrotu', async () => {
    const a = atrapaKsef()
    const id = await zamowienie()
    expect(await wyslijFaktureKsef(db, id, deps(a))).toMatchObject({ wynik: 'przyjeta' })
    await packOrder(db, id, { now: T })
    expect(await readyForDispatch(db, id, { now: T })).toBe('DO_WYSLANIA')
    await markShipped(db, id, { now: T })
    const ol = await db.orderLine.findFirstOrThrow({ where: { orderId: id } })
    const rid = await createReturn(db, id, [{ orderLineId: ol.id, qty: 1 }], { now: T })
    await receiveReturn(db, rid, 'NA_STAN', { now: T, actorId: 'test' })
    // karta zwrotu widzi fakturę KSeF jako dokument sprzedaży: korekta do KSeF, nie „niepotrzebna”
    expect((await kartaZwrotu(db, rid))!.korekta).toMatchObject({ szkicKsef: true, powod: expect.stringMatching(/Wyślij korektę do KSeF/) })
    const k = await wyslijKorekteKsef(db, rid, deps(a))
    expect(k).toMatchObject({ wynik: 'przyjeta', numer: '1/11/2026/K' })
    const kor = await db.ksefInvoiceDraft.findFirstOrThrow({ where: { returnId: rid } })
    const fa = await db.ksefInvoiceDraft.findFirstOrThrow({ where: { orderId: id, returnId: '' } })
    expect(kor).toMatchObject({ rodzaj: 'KOR', korygowanaId: fa.id, status: 'PRZYJETA', seriaKod: 'KOR' })
    expect(kor.bruttoGr).toBeLessThan(0)
    const xmlKor = a.faktury.find((f) => f.rodzaj === 'KOR')!.xml
    expect(xmlKor).toContain(`<NrKSeFFaKorygowanej>${fa.ksefNumer}</NrKSeFFaKorygowanej>`)
    expect(xmlKor).toContain('<NrFaKorygowanej>1/11/2026</NrFaKorygowanej>')
    // ponowienie korekty: ten sam wiersz, bez drugiej korekty
    expect(await wyslijKorekteKsef(db, rid, deps(a))).toMatchObject({ wynik: 'przyjeta', numer: '1/11/2026/K' })
    expect(a.faktury.filter((f) => f.rodzaj === 'KOR')).toHaveLength(1)
    const korekty = await listaFaktur(db, { zakladka: 'korekty' })
    expect(korekty.wiersze).toHaveLength(1)
    expect(korekty.wiersze[0]).toMatchObject({ rodzaj: 'korekta', numer: '1/11/2026/K', korygowana: '1/11/2026', returnId: rid, stan: 'WYSTAWIONA' })
    expect((await listaFaktur(db, { zakladka: 'faktury' })).wiersze).toHaveLength(1)
  })

  it('bramka: wyłączone wystawianie, konto „Tylko podgląd”, produkcja w testach = odmowa bez żadnego żądania do KSeF', async () => {
    const a = atrapaKsef()
    const id = await zamowienie()
    await sys.organization.update({ where: { id: ORG_A }, data: { settings: { ...USTAWIENIA, faktury: { ...USTAWIENIA.faktury, fakturyWlaczone: false } } } })
    expect(await wyslijFaktureKsef(db, id, deps(a))).toMatchObject({ wynik: 'odmowa', powod: expect.stringMatching(/wyłączone/) })
    await sys.organization.update({ where: { id: ORG_A }, data: { settings: USTAWIENIA } })
    await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'CIEN' } })
    expect(await wyslijFaktureKsef(db, id, deps(a))).toMatchObject({ wynik: 'odmowa', powod: expect.stringMatching(/Tylko podgląd/) })
    await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })
    await sys.organization.update({ where: { id: ORG_A }, data: { settings: { ...USTAWIENIA, ksef: { ...USTAWIENIA.ksef, srodowisko: 'PROD' } } } })
    expect(await wyslijFaktureKsef(db, id, deps(a, { env: { KSEF_PROD_ENABLED: '1', KSEF_PROD_NIPS: '1111111111', VITEST: 'true' } }))).toMatchObject({ wynik: 'odmowa', powod: expect.stringMatching(/testach/) })
    expect(a.wywolania).toEqual([])
    // żaden numer nie został zużyty
    expect(await db.invoiceNumberSeries.count()).toBe(0)
  })

  it('automat workera: zamówienie spakowane po włączeniu dostaje fakturę w KSeF; osoba prywatna bez „konsumenci do KSeF” zostaje poza KSeF', async () => {
    const a = atrapaKsef()
    const b2b = await zamowienie()
    const b2c = await zamowienie(db, false)
    for (const id of [b2b, b2c]) await packOrder(db, id, { now: T })
    const s = await przebiegKsef(db, deps(a))
    expect(s).toMatchObject({ przyjete: 1 })
    expect(await db.ksefInvoiceDraft.findFirstOrThrow({ where: { orderId: b2b } })).toMatchObject({ status: 'PRZYJETA', numer: '1/11/2026' })
    expect(await db.ksefInvoiceDraft.findFirstOrThrow({ where: { orderId: b2c } })).toMatchObject({ status: 'POZA_KSEF', numer: null })
    // drugi przebieg nic nie wysyła
    const n = a.faktury.length
    await przebiegKsef(db, deps(a))
    expect(a.faktury.length).toBe(n)
  })
  it('brak schematów FA(3) na serwerze = odmowa bez żądania do KSeF i bez zużytego numeru', async () => {
    const a = atrapaKsef()
    const id = await zamowienie()
    expect(await wyslijFaktureKsef(db, id, deps(a, { xsdDir: xsdPusty }))).toMatchObject({ wynik: 'odmowa', powod: expect.stringMatching(/Brak schematów FA\(3\)/) })
    expect(a.wywolania).toEqual([])
    expect(await db.ksefInvoiceDraft.count({ where: { numer: { not: null } } })).toBe(0)
    expect(await db.invoiceNumberSeries.count()).toBe(0)
    // automat workera też nic nie wysyła
    await packOrder(db, id, { now: T })
    expect(await przebiegKsef(db, deps(a, { xsdDir: xsdPusty }))).toMatchObject({ wyslane: 0, przyjete: 0 })
    expect(a.wywolania).toEqual([])
  })
})

describe('poprawki po przeglądzie', () => {
  const wysylkiFaktur = (a: ReturnType<typeof atrapaKsef>) => a.wywolania.filter((x) => /POST \/sessions\/online\/[^/]+\/invoices$/.test(x)).length

  it('KSeF „w toku” przy uwierzytelnieniu bez końca → błąd po limicie z zegara, bez zawieszenia', async () => {
    const a = atrapaKsef({ uwierzytelnienieWToku: Infinity })
    const id = await zamowienie()
    const w = await wyslijFaktureKsef(db, id, deps(a))
    expect(w).toMatchObject({ wynik: 'blad', numer: '1/11/2026', powod: expect.stringMatching(/ponad 30 s/) })
    expect(a.faktury).toHaveLength(0)
    expect(await db.ksefInvoiceDraft.findFirstOrThrow({ where: { orderId: id } })).toMatchObject({ status: 'BLAD_WYSYLKI', numer: '1/11/2026' })
  })

  it('twardy limit zadania ksef-wysylka przerywa wiszącą próbę (prawdziwy czas, limit 200 ms)', async () => {
    const a = atrapaKsef({ uwierzytelnienieWToku: Infinity })
    const id = await zamowienie()
    await packOrder(db, id, { now: T })
    const start = Date.now()
    // bez sztucznego zegara: prawdziwe 30 s limitu uwierzytelnienia nie minie, przerywa dopiero limit zadania
    const s = await przebiegKsefZLimitem(db, deps(a, { sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))), zegar: undefined }), 200)
    expect(Date.now() - start).toBeLessThan(10_000)
    // Logowanie do KSeF jest przed nadaniem numeru, a logowanie przerwane limitem kończy przebieg
    // bez nadania numeru (przerwanie próby z numerem: tests/ksef-przed-produkcja.integration.test.ts)
    expect(s).toMatchObject({ przerwany: true, logowanieNieudane: true, wyslane: 0, bledy: 0 })
    expect(await db.ksefInvoiceDraft.count({ where: { orderId: id, numer: { not: null } } })).toBe(0)
    expect(a.faktury).toHaveLength(0)
  })

  it('429 przy odczycie stanu po wysłaniu → „do sprawdzenia” (WYSLANA, referencje zostają), worker pyta o stan bez drugiej wysyłki', async () => {
    // 1 + 3 ponowienia GET = 4 odpowiedzi 429: odczyt stanu się nie udaje
    const a = atrapaKsef({ bladStatusu: { kod: 429, ile: 4, retryAfter: '5' } })
    const id = await zamowienie()
    const w = await wyslijFaktureKsef(db, id, deps(a))
    expect(w).toMatchObject({ wynik: 'w_toku', numer: '1/11/2026', powod: expect.stringMatching(/stan do sprawdzenia/) })
    expect(JSON.stringify(w)).not.toMatch(/nie przyjął/)
    const d1 = await db.ksefInvoiceDraft.findFirstOrThrow({ where: { orderId: id } })
    expect(d1).toMatchObject({ status: 'WYSLANA', sesjaRef: expect.any(String), fakturaRef: expect.any(String) })
    const lista = await listaFaktur(db, { zakladka: 'faktury' })
    expect(lista.wiersze[0]).toMatchObject({ stan: 'W_KOLEJCE', blad: expect.stringMatching(/stan do sprawdzenia/) })
    await przebiegKsef(db, deps(a))
    expect(await db.ksefInvoiceDraft.findUniqueOrThrow({ where: { id: d1.id } })).toMatchObject({ status: 'PRZYJETA', ksefNumer: a.faktury[0]!.ksefNumer, lastError: null })
    expect(wysylkiFaktur(a)).toBe(1)
  })

  it('401 przy odczycie stanu nie czyści referencji; po limicie prób BLAD_WYSYLKI z referencjami, „Ponów” pyta o stan', async () => {
    const a = atrapaKsef({ bladStatusu: { kod: 401, ile: 2 } })
    const id = await zamowienie()
    expect(await wyslijFaktureKsef(db, id, deps(a))).toMatchObject({ wynik: 'w_toku' })
    const d = await db.ksefInvoiceDraft.findFirstOrThrow({ where: { orderId: id } })
    expect(d).toMatchObject({ status: 'WYSLANA', fakturaRef: expect.any(String) })
    // limit prób odczytu stanu: kolejna nieudana próba przechodzi w błąd, referencje zostają
    await db.ksefInvoiceDraft.update({ where: { id: d.id }, data: { probyOdczytu: PROBY_ODCZYTU_STANU - 1 } })
    expect(await wyslijDoKsef(db, d.id, deps(a))).toMatchObject({ wynik: 'blad', powod: expect.stringMatching(/„Ponów” najpierw zapyta KSeF o stan/) })
    expect(await db.ksefInvoiceDraft.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ status: 'BLAD_WYSYLKI', sesjaRef: d.sesjaRef, fakturaRef: d.fakturaRef })
    // „Ponów”: KSeF odpowiada, faktura przyjęta bez drugiej wysyłki
    expect(await wyslijDoKsef(db, d.id, deps(a))).toMatchObject({ wynik: 'przyjeta', ksefNumer: a.faktury[0]!.ksefNumer })
    expect(wysylkiFaktur(a)).toBe(1)
  })

  it('dubel 440 bez numeru oryginału → przyjęta bez numeru KSeF; worker dociąga numer i UPO z sesji oryginału', async () => {
    const a = atrapaKsef({ zgubOdpowiedzWysylki: 1, dubelBezNumeru: true })
    const id = await zamowienie()
    expect(await wyslijFaktureKsef(db, id, deps(a))).toMatchObject({ wynik: 'blad' })
    const d = await db.ksefInvoiceDraft.findFirstOrThrow({ where: { orderId: id } })
    expect(await wyslijDoKsef(db, d.id, deps(a))).toMatchObject({ wynik: 'przyjeta', ksefNumer: null })
    const d1 = await db.ksefInvoiceDraft.findUniqueOrThrow({ where: { id: d.id } })
    expect(d1).toMatchObject({ status: 'PRZYJETA', ksefNumer: null, sesjaRef: a.faktury[0]!.sesja, lastError: expect.stringMatching(/nie podał/) })
    const s = await przebiegKsef(db, deps(a))
    expect(s.uzupelnione).toBe(1)
    const d2 = await db.ksefInvoiceDraft.findUniqueOrThrow({ where: { id: d.id } })
    expect(d2).toMatchObject({ ksefNumer: a.faktury[0]!.ksefNumer, fakturaRef: a.faktury[0]!.ref, lastError: null })
    expect(d2.upo).toContain('UPO')
    expect(a.faktury).toHaveLength(1)
    // komplet: kolejny przebieg nic nie pyta
    const n = a.wywolania.length
    await przebiegKsef(db, deps(a))
    expect(a.wywolania.length).toBe(n)
  })

  it('dubel bez numeru i bez sesji oryginału → zostaje z komunikatem, worker nie pyta KSeF w kółko', async () => {
    const a = atrapaKsef({ zgubOdpowiedzWysylki: 1, dubelBezNumeru: true, bezSesjiOryginalu: true })
    const id = await zamowienie()
    await wyslijFaktureKsef(db, id, deps(a))
    const d = await db.ksefInvoiceDraft.findFirstOrThrow({ where: { orderId: id } })
    await wyslijDoKsef(db, d.id, deps(a))
    expect(await db.ksefInvoiceDraft.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ status: 'PRZYJETA', ksefNumer: null, sesjaRef: null })
    const n = a.wywolania.length
    expect(await przebiegKsef(db, deps(a))).toMatchObject({ uzupelnione: 0 })
    expect(a.wywolania.length).toBe(n)
  })

  it('nieudane pobranie UPO → przyjęta bez UPO, worker dociąga UPO', async () => {
    // 1 + 3 ponowienia GET przy 500
    const a = atrapaKsef({ bladUpo: 4 })
    const id = await zamowienie()
    expect(await wyslijFaktureKsef(db, id, deps(a))).toMatchObject({ wynik: 'przyjeta' })
    const d = await db.ksefInvoiceDraft.findFirstOrThrow({ where: { orderId: id } })
    expect(d).toMatchObject({ status: 'PRZYJETA', upo: null, ksefNumer: a.faktury[0]!.ksefNumer })
    expect(await przebiegKsef(db, deps(a))).toMatchObject({ uzupelnione: 1 })
    expect((await db.ksefInvoiceDraft.findUniqueOrThrow({ where: { id: d.id } })).upo).toContain('UPO')
  })
})
