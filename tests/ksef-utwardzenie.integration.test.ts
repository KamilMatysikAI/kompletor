// Na bazie: utwardzenie wysyłki KSeF przed pierwszą produkcyjną fakturą. Atrapa KSeF TEST (tests/ksef-atrapa.ts),
// dane fikcyjne, zero połączeń z siecią.
// Każdy nowy automat ma test dubla: w atrapie (która jak KSeF odrzuca dubel numeru kodem 440) zostaje jedna faktura,
// a numer z serii nie zjada kolejnego.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { listaFaktur } from '@/lib/dokumenty/lista'
import { OSTRZEZENIE_ROZJAZDU, pdfDokumentuKsef } from '@/lib/dokumenty/pdf-ksef'
import { zapiszRekordKlienta } from '@/lib/klienci/zapis'
import { rekordZOdbiorcy } from '@/lib/klienci/rekord'
import { PONOWIENIA_AUTO_MAX } from '@/lib/ksef/przyczyny'
import { KOMUNIKAT_UZUPELNIANIA, PROBA_PORZUCONA_MS, przebiegKsef, UZUPELNIANIE_PROB_MAX, wyslijDoKsef, wyslijFaktureKsef, zLimitemProbyRecznej, type StatystykiKsef, type ZaleznosciWysylki } from '@/lib/ksef/wysylka'
import { packOrder } from '@/lib/rdzen/rozchod'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import type { OrderRecipient } from '@/lib/adaptery/kontrakt'
import type { FetchLike } from '@/lib/zrodla/http'
import { atrapaKsef } from './ksef-atrapa'
import { ORG_A, testDb, testSystemDb, truncateAll } from './db'
import { order, product, seedBase } from './rdzen-fixtures'

vi.mock('server-only', () => ({}))

const db = testDb()
const sys = testSystemDb()
afterAll(async () => {
  await db.$disconnect()
})

const T = new Date('2026-11-09T09:00:00.000Z')
const MIN = 60_000
const NIP_NABYWCY = '5260001246'
const ENV = { DANE_KLIENTA_ZAPIS: '1', CUSTOMER_DATA_KEYS: `1:${'1'.repeat(64)}`, CUSTOMER_LOOKUP_KEY: 'a'.repeat(64) }
const nabywca = (nazwa = 'Nabywca Testowy sp. z o.o.'): OrderRecipient => ({
  dostawa: { imieNazwisko: 'Jan Testowy', firma: null, ulica: 'ul. Fikcyjna 9', numerDomu: '1', numerLokalu: null, kodPocztowy: '60-001', miasto: 'Poznań', kraj: 'PL', telefon: '+48500000001', email: 'jan@example.test' },
  punktOdbioru: null,
  faktura: { nazwa, nip: NIP_NABYWCY, ulica: 'ul. Fikcyjna 9', kodPocztowy: '60-001', miasto: 'Poznań', kraj: 'PL' },
  problemy: [],
})
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
let zegarMs = 0

beforeAll(() => {
  vi.stubEnv('CUSTOMER_DATA_KEYS', ENV.CUSTOMER_DATA_KEYS)
  vi.stubEnv('CUSTOMER_LOOKUP_KEY', ENV.CUSTOMER_LOOKUP_KEY)
})

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  await db.warehouse.updateMany({ data: { stockSource: 'KOMPLETOR', wfirmaWarehouseId: null } })
  await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })
  await sys.organization.update({ where: { id: ORG_A }, data: { settings: USTAWIENIA } })
  zegarMs = T.getTime()
})

type Atrapa = ReturnType<typeof atrapaKsef>
const deps = (a: Atrapa | { fetch: FetchLike }, over: Partial<ZaleznosciWysylki> = {}): ZaleznosciWysylki => ({
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
const po = (ms: number) => new Date(T.getTime() + ms)
const wysylki = (a: Atrapa) => a.wywolania.filter((x) => /POST \/sessions\/online\/[^/]+\/invoices$/.test(x)).length
const logowania = (a: Atrapa) => a.wywolania.filter((x) => x === 'POST /auth/ksef-token').length
const wiersz = (orderId: string) => db.ksefInvoiceDraft.findFirstOrThrow({ where: { orderId, returnId: '' } })

async function zamowienie(c: typeof db = db): Promise<string> {
  const pid = await product(c, `A191-${Math.random().toString(36).slice(2, 8)}`, 50)
  const { orderId } = await ingestOrder(c, order([{ productId: pid, qty: 2, unitPriceGross: 10 }], { totalGross: 32, createdAtChannel: T, wantInvoiceNip: true }), { now: T })
  await zapiszRekordKlienta(c, orderId!, rekordZOdbiorcy(nabywca()), { source: 'RECZNE', fetchedAt: T, env: ENV })
  return orderId!
}

async function tekstPdf(pdf: Uint8Array): Promise<string> {
  const d = await getDocument({ data: new Uint8Array(pdf), useSystemFonts: false }).promise
  let t = ''
  for (let i = 1; i <= d.numPages; i++) t += (await (await d.getPage(i)).getTextContent()).items.map((x) => ('str' in x ? x.str : '')).join(' ')
  return t.replace(/\s+/g, ' ')
}

describe('hash faktury', () => {
  it('przyjęta: hash wysłanego XML zapisany; PDF zgodny; po zmianie danych nabywcy PDF ostrzega o rozjeździe', async () => {
    const a = atrapaKsef()
    const id = await zamowienie()
    expect(await wyslijFaktureKsef(db, id, deps(a))).toMatchObject({ wynik: 'przyjeta' })
    const d = await wiersz(id)
    expect(d.invoiceHash).toBe(a.faktury[0]!.hash)
    expect(d.hasheWyslane).toEqual([a.faktury[0]!.hash])
    expect(d.wytworzonaAt?.toISOString()).toBe(T.toISOString())
    const ok = await pdfDokumentuKsef(db, d.id, { actorId: 'test', now: po(3 * 86_400_000) })
    expect(ok.zgodnaZKsef).toBe(true)
    expect(await tekstPdf(ok.bytes)).not.toContain('Uwaga:')
    // ktoś poprawia nazwę nabywcy po wysyłce: PDF z bazy już nie jest fakturą z KSeF
    await zapiszRekordKlienta(db, id, rekordZOdbiorcy(nabywca('Inna Nazwa sp. z o.o.')), { source: 'RECZNE', nadpiszReczne: true, fetchedAt: po(MIN), env: ENV })
    const zly = await pdfDokumentuKsef(db, d.id, { actorId: 'test' })
    expect(zly.zgodnaZKsef).toBe(false)
    expect(await tekstPdf(zly.bytes)).toContain(OSTRZEZENIE_ROZJAZDU.slice(0, 60))
  })

  it('ponowienie po zgubionej odpowiedzi składa XML bajt w bajt ten sam (zamrożona data wytworzenia); dubel 440 = hash oryginału', async () => {
    const a = atrapaKsef({ zgubOdpowiedzWysylki: 1 })
    const id = await zamowienie()
    expect(await wyslijFaktureKsef(db, id, deps(a))).toMatchObject({ wynik: 'blad' })
    const d1 = await wiersz(id)
    expect(d1.hasheWyslane).toEqual([a.faktury[0]!.hash]) // hash zapisany PRZED wysłaniem: zgubiona odpowiedź go nie gubi
    // ponowienie dzień później, ręcznie: ten sam XML (ta sama data wytworzenia i wystawienia), KSeF odrzuca dubel
    expect(await wyslijDoKsef(db, d1.id, deps(a, { now: po(86_400_000) }))).toMatchObject({ wynik: 'przyjeta', ksefNumer: a.faktury[0]!.ksefNumer })
    const d2 = await wiersz(id)
    expect(d2).toMatchObject({ status: 'PRZYJETA', dataWystawienia: '2026-11-09', invoiceHash: a.faktury[0]!.hash, hasheWyslane: [a.faktury[0]!.hash] })
    expect(a.faktury).toHaveLength(1)
    expect(wysylki(a)).toBe(2)
  })
})

describe('zapis stanu tylko z WYSYLANA', () => {
  it('wiersz przejęty w trakcie (sprzątacz) przed wysłaniem: próba nic nie wysyła i nie nadpisuje stanu', async () => {
    const a = atrapaKsef()
    let draftId = ''
    // „sprzątacz” przejmuje wiersz dokładnie w chwili otwierania sesji (próba wisiała ponad 5 min)
    const fetch: FetchLike = async (url, init) => {
      if ((init?.method ?? 'GET') === 'POST' && url.endsWith('/sessions/online')) await db.ksefInvoiceDraft.update({ where: { id: draftId }, data: { status: 'BLAD_WYSYLKI', przyczyna: 'PORZUCONA', lastError: 'porzucona' } })
      return a.fetch(url, init)
    }
    const id = await zamowienie()
    const { prepareKsefForOrder } = await import('@/lib/ksef/szkice')
    await prepareKsefForOrder(db, id, { now: T })
    draftId = (await wiersz(id)).id
    const w = await wyslijDoKsef(db, draftId, deps({ fetch }))
    expect(w).toMatchObject({ wynik: 'w_toku', powod: expect.stringMatching(/inna próba/) })
    expect(wysylki(a)).toBe(0)
    expect(await wiersz(id)).toMatchObject({ status: 'BLAD_WYSYLKI', lastError: 'porzucona', sesjaRef: null })
  })

  it('wiersz przejęty po wysłaniu: wynik spóźnionej próby nie nadpisuje nowszego stanu', async () => {
    const a = atrapaKsef()
    let draftId = ''
    const fetch: FetchLike = async (url, init) => {
      const r = await a.fetch(url, init)
      if ((init?.method ?? 'GET') === 'POST' && /\/sessions\/online\/[^/]+\/invoices$/.test(url)) await db.ksefInvoiceDraft.update({ where: { id: draftId }, data: { status: 'BLAD_WYSYLKI', przyczyna: 'PORZUCONA', lastError: 'porzucona' } })
      return r
    }
    const id = await zamowienie()
    const { prepareKsefForOrder } = await import('@/lib/ksef/szkice')
    await prepareKsefForOrder(db, id, { now: T })
    draftId = (await wiersz(id)).id
    expect(await wyslijDoKsef(db, draftId, deps({ fetch }))).toMatchObject({ wynik: 'w_toku' })
    expect(await wiersz(id)).toMatchObject({ status: 'BLAD_WYSYLKI', lastError: 'porzucona', fakturaRef: null })
    // automat ponawia: ten sam numer, KSeF ma ją już (440), jedna faktura w KSeF
    expect(await przebiegKsef(db, deps(a, { now: po(3 * MIN) }))).toMatchObject({ ponowione: 1, przyjete: 1 })
    expect(await wiersz(id)).toMatchObject({ status: 'PRZYJETA', ksefNumer: a.faktury[0]!.ksefNumer, numer: '1/11/2026' })
    expect(a.faktury).toHaveLength(1)
  })
})

describe('jedno połączenie na przebieg i budżet czasu', () => {
  it('przebieg z trzema fakturami loguje się do KSeF raz', async () => {
    const a = atrapaKsef()
    for (let i = 0; i < 3; i++) await packOrder(db, await zamowienie(), { now: T })
    expect(await przebiegKsef(db, deps(a))).toMatchObject({ przyjete: 3 })
    expect(a.faktury).toHaveLength(3)
    expect(logowania(a)).toBe(1)
  })

  it('nieudane logowanie: jedna próba logowania, przebieg nie zaczyna kolejnych dokumentów i nie zużywa ich numerów', async () => {
    const a = atrapaKsef({ zlyToken: true })
    for (let i = 0; i < 3; i++) await packOrder(db, await zamowienie(), { now: T })
    const s = await przebiegKsef(db, deps(a))
    expect(s).toMatchObject({ logowanieNieudane: true, bledy: 1 })
    expect(logowania(a)).toBe(1)
    const z = await db.ksefInvoiceDraft.findMany({ where: { numer: { not: null } } })
    expect(z).toHaveLength(1)
    expect(z[0]).toMatchObject({ status: 'BLAD_WYSYLKI', przyczyna: 'LOGOWANIE', nastepnaProbaOd: po(2 * MIN) })
  })

  it('token dostępowy wygasa w trakcie przebiegu: jedno odświeżenie, bez drugiego logowania', async () => {
    const a = atrapaKsef({ odswiezanie: true, bladStatusu: { kod: 401, ile: 1 } })
    for (let i = 0; i < 2; i++) await packOrder(db, await zamowienie(), { now: T })
    expect(await przebiegKsef(db, deps(a))).toMatchObject({ przyjete: 2 })
    expect(logowania(a)).toBe(1)
    expect(a.wywolania.filter((x) => x === 'POST /auth/token/refresh')).toHaveLength(1)
  })

  it('do końca budżetu mniej niż zapas: przebieg nie zaczyna dokumentu i nie zużywa numeru', async () => {
    const a = atrapaKsef()
    await packOrder(db, await zamowienie(), { now: T })
    const s = await przebiegKsef(db, deps(a, { koniecMs: zegarMs + 60_000 }))
    expect(s).toMatchObject({ przerwany: true, wyslane: 0 })
    expect(a.wywolania).toEqual([])
    expect(await db.invoiceNumberSeries.count()).toBe(0)
  })

  it('w przebiegu czekanie na wynik najwyżej ok. 20 s (stan dociąga następny przebieg)', async () => {
    const a = atrapaKsef({ przetwarzanie: 1000 })
    await packOrder(db, await zamowienie(), { now: T })
    const start = zegarMs
    await przebiegKsef(db, deps(a))
    expect(zegarMs - start).toBeLessThanOrEqual(25_000)
    expect(await db.ksefInvoiceDraft.findFirstOrThrow({ where: { numer: { not: null } } })).toMatchObject({ status: 'WYSLANA' })
  })
})

describe('dopasowanie faktury w sesji oryginału po hashu', () => {
  it('dubel bez numeru oryginału, a w sesji faktura o tym numerze z inną treścią: numeru KSeF nie przypisujemy, komunikat dla człowieka', async () => {
    const a = atrapaKsef({ zgubOdpowiedzWysylki: 1, dubelBezNumeru: true, obcyHashWLiscie: true })
    const id = await zamowienie()
    await wyslijFaktureKsef(db, id, deps(a))
    const d = await wiersz(id)
    expect(await wyslijDoKsef(db, d.id, deps(a))).toMatchObject({ wynik: 'przyjeta', ksefNumer: null })
    expect(await przebiegKsef(db, deps(a))).toMatchObject({ uzupelnione: 0, doRecznego: 1 })
    const d2 = await wiersz(id)
    expect(d2).toMatchObject({ ksefNumer: null, probyUzupelnienia: UZUPELNIANIE_PROB_MAX })
    expect(d2.lastError).toContain(KOMUNIKAT_UZUPELNIANIA)
    expect((await listaFaktur(db, { zakladka: 'faktury' })).wiersze[0]).toMatchObject({ blad: expect.stringContaining('Aplikacji Podatnika') })
    const n = a.wywolania.length
    await przebiegKsef(db, deps(a))
    expect(a.wywolania.length).toBe(n)
  })
})

describe('automatyczne ponowienie błędów z przyczyny „naszej”', () => {
  it('5xx przy wysyłce: przyczyna SERWER, ponowienie dopiero po odstępie, potem przyjęta; jedna faktura w KSeF', async () => {
    const a = atrapaKsef({ bladWysylki: { kod: 503, ile: 1 } })
    const id = await zamowienie()
    expect(await wyslijFaktureKsef(db, id, deps(a))).toMatchObject({ wynik: 'blad', powod: expect.stringMatching(/System ponowi wysyłkę sam ok\. \d\d:\d\d \(ponowienie 1 z 6\)/) })
    expect(await wiersz(id)).toMatchObject({ status: 'BLAD_WYSYLKI', przyczyna: 'SERWER', nastepnaProbaOd: po(2 * MIN), numer: '1/11/2026' })
    expect(await przebiegKsef(db, deps(a, { now: po(MIN) }))).toMatchObject({ ponowione: 0 })
    expect(await przebiegKsef(db, deps(a, { now: po(3 * MIN) }))).toMatchObject({ ponowione: 1, przyjete: 1 })
    expect(await wiersz(id)).toMatchObject({ status: 'PRZYJETA', numer: '1/11/2026', ponowieniaAuto: 1, przyczyna: null })
    expect(a.faktury).toHaveLength(1)
  })

  it('dubel: zgubiona odpowiedź (sieć) → automat wysyła ten sam numer, KSeF odrzuca dubel 440, w KSeF jedna faktura, numer serii nie przeskakuje', async () => {
    const a = atrapaKsef({ zgubOdpowiedzWysylki: 1 })
    const id = await zamowienie()
    expect(await wyslijFaktureKsef(db, id, deps(a))).toMatchObject({ wynik: 'blad' })
    expect(await wiersz(id)).toMatchObject({ przyczyna: 'SIEC' })
    expect(await przebiegKsef(db, deps(a, { now: po(3 * MIN) }))).toMatchObject({ ponowione: 1, przyjete: 1 })
    expect(await wiersz(id)).toMatchObject({ status: 'PRZYJETA', ksefNumer: a.faktury[0]!.ksefNumer, lastError: expect.stringMatching(/dubel 440/) })
    expect(a.faktury).toHaveLength(1)
    expect(wysylki(a)).toBe(2)
    expect(await wyslijFaktureKsef(db, await zamowienie(), deps(a, { now: po(4 * MIN) }))).toMatchObject({ numer: '2/11/2026' })
  })

  it('429 przy wysyłce: „KSeF ograniczył liczbę żądań”, referencje i hash tej wersji zdjęte, automat ponawia', async () => {
    const a = atrapaKsef({ bladWysylki: { kod: 429, ile: 1 } })
    const id = await zamowienie()
    const w = await wyslijFaktureKsef(db, id, deps(a))
    expect(w).toMatchObject({ wynik: 'blad', powod: expect.stringMatching(/^KSeF ograniczył liczbę żądań/) })
    expect(JSON.stringify(w)).not.toMatch(/nie przyjął/)
    expect(await wiersz(id)).toMatchObject({ przyczyna: 'LIMIT_ZADAN', sesjaRef: null, fakturaRef: null, hasheWyslane: [] })
    expect(await przebiegKsef(db, deps(a, { now: po(3 * MIN) }))).toMatchObject({ przyjete: 1 })
    expect(a.faktury).toHaveLength(1)
  })

  it('4xx z KSeF przy wysyłce i odrzucenie treści (450): bez automatycznego ponowienia, tylko „Ponów”', async () => {
    const a = atrapaKsef({ bladWysylki: { kod: 400, ile: 1 } })
    const id = await zamowienie()
    expect(await wyslijFaktureKsef(db, id, deps(a))).toMatchObject({ wynik: 'blad', powod: expect.stringMatching(/KSeF nie przyjął faktury/) })
    expect(await wiersz(id)).toMatchObject({ przyczyna: 'KSEF_ODMOWA', nastepnaProbaOd: null })
    expect(await przebiegKsef(db, deps(a, { now: po(60 * MIN) }))).toMatchObject({ ponowione: 0 })
    const b = atrapaKsef({ kodStatusu: 450 })
    const id2 = await zamowienie()
    expect(await wyslijFaktureKsef(db, id2, deps(b))).toMatchObject({ wynik: 'odrzucona' })
    expect(await przebiegKsef(db, deps(b, { now: po(60 * MIN) }))).toMatchObject({ ponowione: 0 })
    expect(wysylki(b)).toBe(1)
  })

  it(`limit ${PONOWIENIA_AUTO_MAX} automatycznych ponowień, potem tylko „Ponów” (które daje automatowi nowy zapas)`, async () => {
    const a = atrapaKsef({ bladWysylki: { kod: 503, ile: 100 } })
    const id = await zamowienie()
    await wyslijFaktureKsef(db, id, deps(a))
    let t = 0
    for (let i = 0; i < PONOWIENIA_AUTO_MAX + 2; i++) {
      t += 3 * 60 * MIN
      await przebiegKsef(db, deps(a, { now: po(t) }))
    }
    const d = await wiersz(id)
    expect(d).toMatchObject({ status: 'BLAD_WYSYLKI', ponowieniaAuto: PONOWIENIA_AUTO_MAX, nastepnaProbaOd: null, lastError: expect.stringMatching(/ponawiał już 6 razy/) })
    expect(a.faktury).toHaveLength(0) // 503 przed przyjęciem: KSeF żadnej nie ma
    expect(a.wywolania.filter((x) => /\/invoices$/.test(x))).toHaveLength(PONOWIENIA_AUTO_MAX + 1)
    // „Ponów” człowieka: licznik od zera
    await wyslijDoKsef(db, d.id, deps(a, { now: po(t + MIN) }))
    expect(await wiersz(id)).toMatchObject({ ponowieniaAuto: 0, przyczyna: 'SERWER', nastepnaProbaOd: expect.any(Date) })
  })

  it('porzucona próba (serwer padł w trakcie): sprzątacz oznacza ją PORZUCONA i ten sam przebieg ją ponawia', async () => {
    const a = atrapaKsef()
    const id = await zamowienie()
    const { prepareKsefForOrder } = await import('@/lib/ksef/szkice')
    await prepareKsefForOrder(db, id, { now: T })
    const d = await wiersz(id)
    await db.ksefInvoiceDraft.update({ where: { id: d.id }, data: { status: 'WYSYLANA', numer: '1/11/2026', dataWystawienia: '2026-11-09', wytworzonaAt: T, wysylkaOd: T } })
    expect(await przebiegKsef(db, deps(a, { now: po(PROBA_PORZUCONA_MS + MIN) }))).toMatchObject({ porzucone: 1, ponowione: 1, przyjete: 1 })
    expect(a.faktury).toHaveLength(1)
  })
})

describe('osobny licznik odczytów stanu', () => {
  it('wiele wcześniejszych prób wysyłki nie skraca limitu odczytów stanu po wysłaniu', async () => {
    // 1 + 3 ponowienia GET przy 500: pierwszy odczyt stanu się nie udaje, następny już tak
    const a = atrapaKsef({ bladStatusu: { kod: 500, ile: 4 } })
    const id = await zamowienie()
    const { prepareKsefForOrder } = await import('@/lib/ksef/szkice')
    await prepareKsefForOrder(db, id, { now: T })
    await db.ksefInvoiceDraft.update({ where: { id: (await wiersz(id)).id }, data: { proby: 40 } })
    expect(await wyslijFaktureKsef(db, id, deps(a))).toMatchObject({ wynik: 'w_toku' })
    expect(await wiersz(id)).toMatchObject({ status: 'WYSLANA', proby: 41, probyOdczytu: 1 })
    await przebiegKsef(db, deps(a))
    expect(await wiersz(id)).toMatchObject({ status: 'PRZYJETA', probyOdczytu: 0 })
    expect(wysylki(a)).toBe(1)
  })
})

describe('koniec dociągania numeru KSeF/UPO po limicie prób', () => {
  it(`po ${UZUPELNIANIE_PROB_MAX} nieudanych pobraniach UPO komunikat na liście i koniec zapytań`, async () => {
    const a = atrapaKsef({ bladUpo: 10_000 })
    const id = await zamowienie()
    expect(await wyslijFaktureKsef(db, id, deps(a))).toMatchObject({ wynik: 'przyjeta' })
    // kolejne próby z odstępem: przebieg tuż po nieudanej próbie nie pyta KSeF
    await przebiegKsef(db, deps(a))
    expect(await wiersz(id)).toMatchObject({ probyUzupelnienia: 1, nastepnaProbaOd: po(2 * MIN) })
    const n1 = a.wywolania.length
    await przebiegKsef(db, deps(a, { now: po(MIN) }))
    expect(a.wywolania.length).toBe(n1)
    for (let i = 1; i < UZUPELNIANIE_PROB_MAX; i++) await przebiegKsef(db, deps(a, { now: po(i * 3 * 60 * MIN) }))
    const d = await wiersz(id)
    expect(d).toMatchObject({ upo: null, probyUzupelnienia: UZUPELNIANIE_PROB_MAX })
    expect(d.lastError).toContain(KOMUNIKAT_UZUPELNIANIA)
    expect((await listaFaktur(db, { zakladka: 'faktury' })).wiersze[0]).toMatchObject({ stan: 'WYSTAWIONA', blad: expect.stringContaining('Aplikacji Podatnika') })
    const n = a.wywolania.length
    await przebiegKsef(db, deps(a, { now: po(40 * 60 * MIN) }))
    expect(a.wywolania.length).toBe(n)
  })

  it('nieudane logowanie przebiegu nie liczy się jako próba dociągnięcia', async () => {
    const a = atrapaKsef({ bladUpo: 4 })
    const id = await zamowienie()
    expect(await wyslijFaktureKsef(db, id, deps(a))).toMatchObject({ wynik: 'przyjeta' })
    expect(await wiersz(id)).toMatchObject({ upo: null })
    expect(await przebiegKsef(db, deps(atrapaKsef({ zlyToken: true })))).toMatchObject({ logowanieNieudane: true })
    expect(await wiersz(id)).toMatchObject({ probyUzupelnienia: 0 })
  })
})

describe('data wystawienia przy ponowieniu (ustawienie, domyślnie bez zmian)', () => {
  const zUstawieniem = (v: string) => sys.organization.update({ where: { id: ORG_A }, data: { settings: { ...USTAWIENIA, ksef: { ...USTAWIENIA.ksef, dataPrzyPonowieniu: v } } } })

  it('domyślnie: po odrzuceniu (450) ponowienie następnego dnia wysyła datę pierwszej próby', async () => {
    const zla = atrapaKsef({ kodStatusu: 450 })
    const id = await zamowienie()
    expect(await wyslijFaktureKsef(db, id, deps(zla))).toMatchObject({ wynik: 'odrzucona' })
    const dobra = atrapaKsef()
    expect(await wyslijDoKsef(db, (await wiersz(id)).id, deps(dobra, { now: po(86_400_000) }))).toMatchObject({ wynik: 'przyjeta', numer: '1/11/2026' })
    expect(dobra.faktury[0]!.xml).toContain('<P_1>2026-11-09</P_1>')
    expect(await wiersz(id)).toMatchObject({ dataWystawienia: '2026-11-09' })
  })

  it('DZIEN_WYSYLKI: po odrzuceniu ponowienie następnego dnia wysyła datę przesłania, numer zostaje', async () => {
    await zUstawieniem('DZIEN_WYSYLKI')
    const zla = atrapaKsef({ kodStatusu: 450 })
    const id = await zamowienie()
    await wyslijFaktureKsef(db, id, deps(zla))
    expect(await wiersz(id)).toMatchObject({ status: 'ODRZUCONA', hasheWyslane: [] })
    const dobra = atrapaKsef()
    expect(await wyslijDoKsef(db, (await wiersz(id)).id, deps(dobra, { now: po(86_400_000) }))).toMatchObject({ wynik: 'przyjeta', numer: '1/11/2026' })
    expect(dobra.faktury[0]!.xml).toContain('<P_1>2026-11-10</P_1>')
    expect(await wiersz(id)).toMatchObject({ dataWystawienia: '2026-11-10' })
  })

  it('DZIEN_WYSYLKI, ale wcześniejsza wersja mogła dojść (zgubiona odpowiedź): data zostaje, dubel bez drugiej faktury', async () => {
    await zUstawieniem('DZIEN_WYSYLKI')
    const a = atrapaKsef({ zgubOdpowiedzWysylki: 1 })
    const id = await zamowienie()
    await wyslijFaktureKsef(db, id, deps(a))
    expect(await wyslijDoKsef(db, (await wiersz(id)).id, deps(a, { now: po(86_400_000) }))).toMatchObject({ wynik: 'przyjeta' })
    expect(await wiersz(id)).toMatchObject({ dataWystawienia: '2026-11-09' })
    expect(a.faktury).toHaveLength(1)
  })

  it('DZIEN_WYSYLKI, wiersz z samą referencją sesji (bez hashy): data zostaje', async () => {
    await zUstawieniem('DZIEN_WYSYLKI')
    const a = atrapaKsef()
    const id = await zamowienie()
    const { prepareKsefForOrder } = await import('@/lib/ksef/szkice')
    await prepareKsefForOrder(db, id, { now: T })
    const d = await wiersz(id)
    // stan sprzed zmiany: sesja otwarta, odpowiedź na wysyłkę zginęła, hashy jeszcze nie zapisywaliśmy
    await db.ksefInvoiceDraft.update({ where: { id: d.id }, data: { status: 'BLAD_WYSYLKI', numer: '1/11/2026', dataWystawienia: '2026-11-09', sesjaRef: '20261109-SO-0000000000-STARA-00', przyczyna: 'SIEC' } })
    expect(await wyslijDoKsef(db, d.id, deps(a, { now: po(86_400_000) }))).toMatchObject({ wynik: 'przyjeta', numer: '1/11/2026' })
    expect(a.faktury[0]!.xml).toContain('<P_1>2026-11-09</P_1>')
    expect(await wiersz(id)).toMatchObject({ dataWystawienia: '2026-11-09' })
  })

  it('odmowa KSeF przy otwarciu sesji nie zdejmuje referencji wcześniejszej próby (data dalej zablokowana)', async () => {
    await zUstawieniem('DZIEN_WYSYLKI')
    const a = atrapaKsef()
    const id = await zamowienie()
    const { prepareKsefForOrder } = await import('@/lib/ksef/szkice')
    await prepareKsefForOrder(db, id, { now: T })
    const d = await wiersz(id)
    await db.ksefInvoiceDraft.update({ where: { id: d.id }, data: { status: 'BLAD_WYSYLKI', numer: '1/11/2026', dataWystawienia: '2026-11-09', sesjaRef: '20261109-SO-0000000000-STARA-00', przyczyna: 'SIEC' } })
    let odmow = 1
    const fetch: FetchLike = async (url, init) => {
      if ((init?.method ?? 'GET') === 'POST' && url.endsWith('/sessions/online') && odmow-- > 0) return new Response(JSON.stringify({ exception: { exceptionDetailList: [{ exceptionCode: 21405, exceptionDescription: 'Atrapa: sesja odrzucona' }] } }), { status: 400, headers: { 'Content-Type': 'application/json' } })
      return a.fetch(url, init)
    }
    // odmowa przy otwarciu sesji ma własny komunikat (faktura nie wyszła)
    expect(await wyslijDoKsef(db, d.id, deps({ fetch }, { now: po(86_400_000) }))).toMatchObject({ wynik: 'blad', powod: expect.stringMatching(/^KSeF odrzucił otwarcie sesji/) })
    expect(await wiersz(id)).toMatchObject({ przyczyna: 'KSEF_ODMOWA', sesjaRef: '20261109-SO-0000000000-STARA-00', dataWystawienia: '2026-11-09' })
    expect(await wyslijDoKsef(db, d.id, deps({ fetch }, { now: po(2 * 86_400_000) }))).toMatchObject({ wynik: 'przyjeta' })
    expect(a.faktury[0]!.xml).toContain('<P_1>2026-11-09</P_1>')
    expect(await wiersz(id)).toMatchObject({ dataWystawienia: '2026-11-09' })
  })
})

describe('zapis tylko przez próbę, która ma wiersz (znacznik próby, nie sam status)', () => {
  it('próba ręczna wisi > 5 min, sprzątacz → PORZUCONA, automat zaczyna nową; spóźniona stara dostaje 4xx: wiersz nie traci referencji ani hashy nowej, data bez zmian', async () => {
    await sys.organization.update({ where: { id: ORG_A }, data: { settings: { ...USTAWIENIA, ksef: { ...USTAWIENIA.ksef, dataPrzyPonowieniu: 'DZIEN_WYSYLKI' } } } })
    const a = atrapaKsef()
    const id = await zamowienie()
    let nowaPo202!: () => void
    const nowaCzeka = new Promise<void>((r) => (nowaPo202 = r))
    let staraSkonczyla!: () => void
    const staraKoniec = new Promise<void>((r) => (staraSkonczyla = r))
    const h: { przebieg?: Promise<StatystykiKsef> } = {}
    let pierwszyOdczyt = true
    // nowa próba (automat): po 202, przy pierwszym odczycie stanu, czeka, aż stara skończy (okno między 202 a wynikiem)
    const fNowa: FetchLike = async (url, init) => {
      if ((init?.method ?? 'GET') === 'GET' && /\/sessions\/[^/]+\/invoices\/[^/?]+$/.test(url) && pierwszyOdczyt) {
        pierwszyOdczyt = false
        nowaPo202()
        await staraKoniec
      }
      return a.fetch(url, init)
    }
    // stara próba (ręczna): wysyłka wisi ponad 5 min; w tym czasie przebieg workera sprząta ją i zaczyna nową, a stara
    // na koniec dostaje 400 (żądanie odrzucone)
    const fStara: FetchLike = async (url, init) => {
      if ((init?.method ?? 'GET') === 'POST' && /\/sessions\/online\/[^/]+\/invoices$/.test(url)) {
        h.przebieg = przebiegKsef(db, deps({ fetch: fNowa }, { now: po(PROBA_PORZUCONA_MS + MIN) }))
        await nowaCzeka
        return new Response(JSON.stringify({ exception: { exceptionDetailList: [{ exceptionCode: 21405, exceptionDescription: 'Atrapa: spóźniona próba odrzucona' }] } }), { status: 400, headers: { 'Content-Type': 'application/json' } })
      }
      return a.fetch(url, init)
    }
    expect(await wyslijFaktureKsef(db, id, deps({ fetch: fStara }))).toMatchObject({ wynik: 'w_toku', powod: expect.stringMatching(/inna próba/) })
    // stara nic nie zapisała: wiersz dalej w próbie automatu, z jej referencjami i hashem
    expect(await wiersz(id)).toMatchObject({ status: 'WYSYLANA', przyczyna: null, sesjaRef: expect.any(String), fakturaRef: a.faktury[0]!.ref, hasheWyslane: [a.faktury[0]!.hash] })
    staraSkonczyla()
    expect(await h.przebieg).toMatchObject({ porzucone: 1, ponowione: 1, przyjete: 1 })
    expect(await wiersz(id)).toMatchObject({ status: 'PRZYJETA', numer: '1/11/2026', ksefNumer: a.faktury[0]!.ksefNumer, invoiceHash: a.faktury[0]!.hash, dataWystawienia: '2026-11-09' })
    // „Ponów” następnego dnia (DZIEN_WYSYLKI) niczego nie zmienia: faktura jest przyjęta
    expect(await wyslijDoKsef(db, (await wiersz(id)).id, deps(a, { now: po(86_400_000) }))).toMatchObject({ wynik: 'przyjeta' })
    expect(await wiersz(id)).toMatchObject({ dataWystawienia: '2026-11-09' })
    expect(a.faktury).toHaveLength(1)
    expect(wysylki(a)).toBe(1) // 400 starej próby dał pośrednik testu, do atrapy KSeF poszła tylko wysyłka nowej
  })
})

describe('próba ręczna z limitem czasu', () => {
  it('KSeF „w toku” przy logowaniu bez końca: próba z panelu kończy się po limicie jako PRZERWANA, automat dokańcza tym samym numerem', async () => {
    const a = atrapaKsef({ uwierzytelnienieWToku: Infinity })
    const id = await zamowienie()
    const start = Date.now()
    // prawdziwy czas: 30 s limitu uwierzytelnienia nie minie, przerywa dopiero limit próby ręcznej (tu 200 ms)
    const w = await zLimitemProbyRecznej(deps(a, { sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))), zegar: undefined }), (d) => wyslijFaktureKsef(db, id, d), 200)
    expect(Date.now() - start).toBeLessThan(10_000)
    expect(w).toMatchObject({ wynik: 'blad', numer: '1/11/2026' })
    expect(await wiersz(id)).toMatchObject({ status: 'BLAD_WYSYLKI', przyczyna: 'PRZERWANA', numer: '1/11/2026', nastepnaProbaOd: po(2 * MIN), wysylkaOd: null })
    const b = atrapaKsef()
    expect(await przebiegKsef(db, deps(b, { now: po(3 * MIN) }))).toMatchObject({ ponowione: 1, przyjete: 1 })
    expect(await wiersz(id)).toMatchObject({ status: 'PRZYJETA', numer: '1/11/2026' })
    expect(b.faktury).toHaveLength(1)
  })
})

describe('401/403 przy wysyłce to problem logowania', () => {
  it('403 na wysyłce: przyczyna LOGOWANIE (automat), referencje i hash tej wersji zdjęte; automat dokańcza, jedna faktura', async () => {
    const a = atrapaKsef({ bladWysylki: { kod: 403, ile: 1 } })
    const id = await zamowienie()
    const w = await wyslijFaktureKsef(db, id, deps(a))
    expect(w).toMatchObject({ wynik: 'blad', powod: expect.stringMatching(/^KSeF odrzucił logowanie/) })
    expect(JSON.stringify(w)).not.toMatch(/nie przyjął faktury/)
    expect(await wiersz(id)).toMatchObject({ status: 'BLAD_WYSYLKI', przyczyna: 'LOGOWANIE', sesjaRef: null, fakturaRef: null, hasheWyslane: [], nastepnaProbaOd: po(2 * MIN) })
    expect(await przebiegKsef(db, deps(a, { now: po(3 * MIN) }))).toMatchObject({ ponowione: 1, przyjete: 1 })
    expect(a.faktury).toHaveLength(1)
  })
})

describe('numer KSeF z sesji oryginału zapisany przed UPO', () => {
  it('dubel bez numeru oryginału i stały błąd UPO: numer KSeF z listy sesji trafia do wiersza mimo błędu UPO', async () => {
    const a = atrapaKsef({ zgubOdpowiedzWysylki: 1, dubelBezNumeru: true, bladUpo: 10_000 })
    const id = await zamowienie()
    await wyslijFaktureKsef(db, id, deps(a))
    expect(await wyslijDoKsef(db, (await wiersz(id)).id, deps(a))).toMatchObject({ wynik: 'przyjeta', ksefNumer: null })
    await przebiegKsef(db, deps(a))
    expect(await wiersz(id)).toMatchObject({ status: 'PRZYJETA', ksefNumer: a.faktury[0]!.ksefNumer, upo: null, probyUzupelnienia: 1 })
    expect(a.faktury).toHaveLength(1)
  })
})

describe('sprzątacz a wyczerpane ponowienia', () => {
  it(`porzucona próba po ${PONOWIENIA_AUTO_MAX} ponowieniach: komunikat „kliknij Ponów”, automat jej nie bierze`, async () => {
    const a = atrapaKsef()
    const id = await zamowienie()
    const { prepareKsefForOrder } = await import('@/lib/ksef/szkice')
    await prepareKsefForOrder(db, id, { now: T })
    const d = await wiersz(id)
    await db.ksefInvoiceDraft.update({ where: { id: d.id }, data: { status: 'WYSYLANA', numer: '1/11/2026', dataWystawienia: '2026-11-09', wytworzonaAt: T, wysylkaOd: T, ponowieniaAuto: PONOWIENIA_AUTO_MAX } })
    expect(await przebiegKsef(db, deps(a, { now: po(PROBA_PORZUCONA_MS + MIN) }))).toMatchObject({ porzucone: 1, ponowione: 0 })
    const d2 = await wiersz(id)
    expect(d2).toMatchObject({ status: 'BLAD_WYSYLKI', przyczyna: 'PORZUCONA', nastepnaProbaOd: null, lastError: expect.stringMatching(/ponawiał już 6 razy: kliknij „Ponów”/) })
    expect(d2.lastError).not.toMatch(/ponowi ją sam/)
    expect(a.wywolania).toEqual([])
  })
})

describe('logowanie przed nadaniem numeru nowemu dokumentowi', () => {
  it('zły token, a błąd logowania już widać na liście: kolejny przebieg nie nadaje numeru nowemu zamówieniu', async () => {
    const a = atrapaKsef({ zlyToken: true })
    await packOrder(db, await zamowienie(), { now: T })
    // pierwszy raz: jeden dokument dostaje numer i widoczny błąd logowania (jak dotąd)
    expect(await przebiegKsef(db, deps(a))).toMatchObject({ logowanieNieudane: true, bledy: 1 })
    await packOrder(db, await zamowienie(), { now: T })
    // minutę później (ponowienie pierwszej jeszcze nienależne): logowanie przed numerem, nowe zamówienie bez numeru
    expect(await przebiegKsef(db, deps(a, { now: po(MIN) }))).toMatchObject({ logowanieNieudane: true, wyslane: 0, bledy: 0 })
    expect(await db.ksefInvoiceDraft.count({ where: { numer: { not: null } } })).toBe(1)
    expect(logowania(a)).toBe(2)
    expect(await db.invoiceNumberSeries.findMany({ select: { lastNo: true } })).toEqual([{ lastNo: 1 }])
  })
})
