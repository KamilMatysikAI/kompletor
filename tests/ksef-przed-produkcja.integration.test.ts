// resztki przed GO na pierwszą produkcyjną fakturę KSeF.
// Atrapa KSeF TEST (tests/ksef-atrapa.ts), dane fikcyjne, zero połączeń z siecią.
// Każdy zmieniony automat ma test dubla: w atrapie (która jak KSeF odrzuca dubel numeru kodem 440) zostaje jedna
// faktura na numer, a numer z serii nie zjada kolejnego.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { zapiszRekordKlienta } from '@/lib/klienci/zapis'
import { rekordZOdbiorcy } from '@/lib/klienci/rekord'
import { PONOWIENIA_AUTO_MAX } from '@/lib/ksef/przyczyny'
import { prepareKsefForOrder } from '@/lib/ksef/szkice'
import { PROBA_PORZUCONA_MS, poZapisieTokenuKsef, przebiegKsef, przebiegKsefZLimitem, wyslijDoKsef, wyslijFaktureKsef, type StatystykiKsef, type ZaleznosciWysylki } from '@/lib/ksef/wysylka'
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
const DZIEN = 86_400_000
const ENV = { DANE_KLIENTA_ZAPIS: '1', CUSTOMER_DATA_KEYS: `1:${'1'.repeat(64)}`, CUSTOMER_LOOKUP_KEY: 'a'.repeat(64) }
const nabywca = (): OrderRecipient => ({
  dostawa: { imieNazwisko: 'Jan Testowy', firma: null, ulica: 'ul. Fikcyjna 9', numerDomu: '1', numerLokalu: null, kodPocztowy: '60-001', miasto: 'Poznań', kraj: 'PL', telefon: '+48500000001', email: 'jan@example.test' },
  punktOdbioru: null,
  faktura: { nazwa: 'Nabywca Testowy sp. z o.o.', nip: '5260001246', ulica: 'ul. Fikcyjna 9', kodPocztowy: '60-001', miasto: 'Poznań', kraj: 'PL' },
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
const zUstawieniem = (v: string) => sys.organization.update({ where: { id: ORG_A }, data: { settings: { ...USTAWIENIA, ksef: { ...USTAWIENIA.ksef, dataPrzyPonowieniu: v } } } })
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
const TOKEN = { env: { KSEF_TOKEN: 'token-testowy-atrapy' }, envFallback: true }
const deps = (a: Atrapa | { fetch: FetchLike }, over: Partial<ZaleznosciWysylki> = {}): ZaleznosciWysylki => ({
  secrets: TOKEN,
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
const wiersz = (orderId: string) => db.ksefInvoiceDraft.findFirstOrThrow({ where: { orderId, returnId: '' } })
const odpowiedz = (status: number, opis: string) => new Response(JSON.stringify({ exception: { exceptionDetailList: [{ exceptionCode: 21405, exceptionDescription: opis }] } }), { status, headers: { 'Content-Type': 'application/json' } })
const ostatnieNumery = async () => (await db.invoiceNumberSeries.findMany({ select: { lastNo: true } })).map((x) => x.lastNo)

async function zamowienie(): Promise<string> {
  const pid = await product(db, `A198-${Math.random().toString(36).slice(2, 8)}`, 50)
  const { orderId } = await ingestOrder(db, order([{ productId: pid, qty: 2, unitPriceGross: 10 }], { totalGross: 32, createdAtChannel: T, wantInvoiceNip: true }), { now: T })
  await zapiszRekordKlienta(db, orderId!, rekordZOdbiorcy(nabywca()), { source: 'RECZNE', fetchedAt: T, env: ENV })
  return orderId!
}

/** Wiersz: numer i referencja sesji, bez hashy (odpowiedź na wysyłkę mogła zginąć). */
async function wierszSprzedA191(orderId: string): Promise<string> {
  await prepareKsefForOrder(db, orderId, { now: T })
  const d = await wiersz(orderId)
  await db.ksefInvoiceDraft.update({ where: { id: d.id }, data: { status: 'BLAD_WYSYLKI', numer: '1/11/2026', dataWystawienia: '2026-11-09', sesjaRef: '20261109-SO-0000000000-STARA-00', przyczyna: 'SIEC' } })
  return d.id
}

describe('odmowa wysyłki nie zdejmuje referencji sesji wcześniejszej próby', () => {
  it('wiersz z samą referencją sesji, 429 na wysyłce: referencja zostaje, DZIEN_WYSYLKI nie zmienia P_1; jedna faktura', async () => {
    await zUstawieniem('DZIEN_WYSYLKI')
    const a = atrapaKsef({ bladWysylki: { kod: 429, ile: 1 } })
    const id = await zamowienie()
    const draftId = await wierszSprzedA191(id)
    expect(await wyslijDoKsef(db, draftId, deps(a, { now: po(DZIEN) }))).toMatchObject({ wynik: 'blad', powod: expect.stringMatching(/^KSeF ograniczył liczbę żądań/) })
    // referencja sesji próby sprzed gałęzi wraca (nie jest zerowana), hashe bez wersji tej próby
    expect(await wiersz(id)).toMatchObject({ status: 'BLAD_WYSYLKI', przyczyna: 'LIMIT_ZADAN', sesjaRef: '20261109-SO-0000000000-STARA-00', fakturaRef: null, hasheWyslane: [], dataWystawienia: '2026-11-09' })
    // następna próba dzień później: data dalej z pierwszej próby (wersja z sesji STARA mogła dojść do KSeF)
    expect(await wyslijDoKsef(db, draftId, deps(a, { now: po(2 * DZIEN) }))).toMatchObject({ wynik: 'przyjeta', numer: '1/11/2026' })
    expect(a.faktury).toHaveLength(1)
    expect(a.faktury[0]!.xml).toContain('<P_1>2026-11-09</P_1>')
    expect(await wiersz(id)).toMatchObject({ status: 'PRZYJETA', dataWystawienia: '2026-11-09' })
  })

  it('wiersz bez wcześniejszej próby, 429 na wysyłce: referencja tej próby zdjęta jak dotąd (DZIEN_WYSYLKI może zmienić datę)', async () => {
    await zUstawieniem('DZIEN_WYSYLKI')
    const a = atrapaKsef({ bladWysylki: { kod: 429, ile: 1 } })
    const id = await zamowienie()
    expect(await wyslijFaktureKsef(db, id, deps(a))).toMatchObject({ wynik: 'blad' })
    expect(await wiersz(id)).toMatchObject({ sesjaRef: null, fakturaRef: null, hasheWyslane: [] })
    expect(await wyslijDoKsef(db, (await wiersz(id)).id, deps(a, { now: po(DZIEN) }))).toMatchObject({ wynik: 'przyjeta', numer: '1/11/2026' })
    expect(a.faktury).toHaveLength(1)
    expect(a.faktury[0]!.xml).toContain('<P_1>2026-11-10</P_1>')
    expect(await ostatnieNumery()).toEqual([1])
  })
})

describe('dokument „mimo błędu logowania” nie startuje po limicie czasu', () => {
  it('logowanie przerwane limitem zadania (bez wiersza LOGOWANIE na liście): przebieg nie nadaje numeru i kończy się jako przerwany', async () => {
    const a = atrapaKsef({ uwierzytelnienieWToku: Infinity })
    await packOrder(db, await zamowienie(), { now: T })
    // prawdziwy czas: limit uwierzytelnienia (30 s) nie minie, przerywa dopiero limit zadania (tu 1,5 s)
    const s = await przebiegKsefZLimitem(db, deps(a, { sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))), zegar: undefined }), 1500)
    expect(s).toMatchObject({ przerwany: true, logowanieNieudane: true, wyslane: 0 })
    expect(await db.ksefInvoiceDraft.count({ where: { numer: { not: null } } })).toBe(0)
    expect(await db.invoiceNumberSeries.count()).toBe(0)
    expect(wysylki(a)).toBe(0)
    // następny przebieg z działającym KSeF: faktura z pierwszym numerem serii
    const b = atrapaKsef()
    expect(await przebiegKsef(db, deps(b, { now: po(2 * MIN) }))).toMatchObject({ przyjete: 1 })
    expect(b.faktury).toHaveLength(1)
    expect(await ostatnieNumery()).toEqual([1])
  })
})

describe('twardy limit przerywa wiszącą próbę faktury z numerem', () => {
  it('ponowienie automatu, logowanie wisi: próba kończy się po limicie jako PRZERWANA z tym samym numerem, potem przyjęta', async () => {
    const a = atrapaKsef()
    const id = await zamowienie()
    // pierwsza próba: zerwane połączenie przy otwarciu sesji (numer nadany, przyczyna SIEC)
    let zerwij = 1
    const fetch: FetchLike = async (url, init) => {
      if ((init?.method ?? 'GET') === 'POST' && url.endsWith('/sessions/online') && zerwij-- > 0) throw new Error('atrapa: zerwane połączenie')
      return a.fetch(url, init)
    }
    expect(await wyslijFaktureKsef(db, id, deps({ fetch }))).toMatchObject({ wynik: 'blad', numer: '1/11/2026' })
    expect(await wiersz(id)).toMatchObject({ status: 'BLAD_WYSYLKI', przyczyna: 'SIEC' })
    // przebieg automatu po odstępie: logowanie wisi, limit zadania 1,5 s (prawdziwy czas)
    const w = atrapaKsef({ uwierzytelnienieWToku: Infinity })
    const start = Date.now()
    const s = await przebiegKsefZLimitem(db, deps(w, { now: po(3 * MIN), sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))), zegar: undefined }), 1500)
    expect(Date.now() - start).toBeLessThan(10_000)
    expect(s).toMatchObject({ ponowione: 1, bledy: 1 })
    expect(await wiersz(id)).toMatchObject({ status: 'BLAD_WYSYLKI', przyczyna: 'PRZERWANA', numer: '1/11/2026', wysylkaOd: null, lastError: expect.stringMatching(/przerwano/) })
    expect(await przebiegKsef(db, deps(a, { now: po(10 * MIN) }))).toMatchObject({ ponowione: 1, przyjete: 1 })
    expect(a.faktury).toHaveLength(1)
    expect(await ostatnieNumery()).toEqual([1])
  })
})

describe('(wariant a): dwie żywe próby, wysyłka starej dociera do KSeF', () => {
  it('stara wisi po wysyłce > 5 min, automat przejmuje i wysyła ten sam numer: KSeF odrzuca dubel 440, wiersz PRZYJETA z referencjami oryginału', async () => {
    const a = atrapaKsef()
    const id = await zamowienie()
    const h: { przebieg?: Promise<StatystykiKsef> } = {}
    // stara próba (ręczna): KSeF przyjmuje jej wysyłkę, ale odpowiedź 202 dochodzi dopiero po > 5 min; w tym czasie
    // przebieg workera sprząta ją (PORZUCONA) i automat wysyła ten sam numer jeszcze raz
    const fStara: FetchLike = async (url, init) => {
      const r = await a.fetch(url, init)
      if ((init?.method ?? 'GET') === 'POST' && /\/sessions\/online\/[^/]+\/invoices$/.test(url)) {
        h.przebieg = przebiegKsef(db, deps(a, { now: po(PROBA_PORZUCONA_MS + MIN) }))
        await h.przebieg
      }
      return r
    }
    expect(await wyslijFaktureKsef(db, id, deps({ fetch: fStara }))).toMatchObject({ wynik: 'w_toku', powod: expect.stringMatching(/inna próba/) })
    expect(await h.przebieg).toMatchObject({ porzucone: 1, ponowione: 1, przyjete: 1 })
    expect(wysylki(a)).toBe(2) // obie wysyłki doszły do KSeF
    expect(a.faktury).toHaveLength(1) // druga to dubel 440
    const oryginal = a.faktury[0]!
    expect(await wiersz(id)).toMatchObject({
      status: 'PRZYJETA',
      numer: '1/11/2026',
      ksefNumer: oryginal.ksefNumer,
      sesjaRef: oryginal.sesja,
      fakturaRef: null,
      invoiceHash: oryginal.hash,
      hasheWyslane: [oryginal.hash],
      upo: expect.stringContaining(oryginal.ksefNumer),
      lastError: expect.stringMatching(/dubel 440/),
    })
    expect(await ostatnieNumery()).toEqual([1])
  })
})

describe('odmowa otwarcia sesji ma własny komunikat', () => {
  it('400 przy otwarciu sesji: „KSeF odrzucił otwarcie sesji”, nie „nie przyjął faktury”', async () => {
    const a = atrapaKsef()
    const id = await zamowienie()
    const fetch: FetchLike = async (url, init) => ((init?.method ?? 'GET') === 'POST' && url.endsWith('/sessions/online') ? odpowiedz(400, 'Atrapa: sesja odrzucona') : a.fetch(url, init))
    const w = await wyslijFaktureKsef(db, id, deps({ fetch }))
    expect(w).toMatchObject({ wynik: 'blad', powod: expect.stringMatching(/^KSeF odrzucił otwarcie sesji: .*400/) })
    expect(JSON.stringify(w)).not.toMatch(/nie przyjął faktury/)
    expect(await wiersz(id)).toMatchObject({ status: 'BLAD_WYSYLKI', przyczyna: 'KSEF_ODMOWA' })
    expect(wysylki(a)).toBe(0)
  })
})

describe('zapis nowego tokenu KSeF wraca faktury z błędem logowania do automatu', () => {
  it('faktury z wyczerpanymi ponowieniami (zły token) i bez tokenu: po zapisie tokenu automat wysyła każdą raz, numery bez przeskoku', async () => {
    // A: brak tokenu (KONFIGURACJA), B: zły token, automat wyczerpał ponowienia
    await packOrder(db, await zamowienie(), { now: T })
    expect(await przebiegKsef(db, deps(atrapaKsef(), { secrets: { env: {}, envFallback: true } }))).toMatchObject({ bledy: 1 })
    const idB = await zamowienie()
    expect(await wyslijFaktureKsef(db, idB, deps(atrapaKsef({ zlyToken: true })))).toMatchObject({ wynik: 'blad' })
    await db.ksefInvoiceDraft.updateMany({ where: { orderId: idB }, data: { ponowieniaAuto: PONOWIENIA_AUTO_MAX, nastepnaProbaOd: null } })
    expect((await db.ksefInvoiceDraft.findMany({ select: { przyczyna: true }, orderBy: { numer: 'asc' } })).map((x) => x.przyczyna)).toEqual(['KONFIGURACJA', 'LOGOWANIE'])
    // bez zapisu tokenu automat żadnej nie bierze
    const a = atrapaKsef()
    expect(await przebiegKsef(db, deps(a, { now: po(3 * 3_600_000) }))).toMatchObject({ ponowione: 0, wyslane: 0 })
    expect(wysylki(a)).toBe(0)
    // zapis tokenu (Ustawienia → Dokumenty sprzedaży): obie wracają do automatu z pełną pulą ponowień
    expect(await poZapisieTokenuKsef(db, po(3 * 3_600_000))).toBe(2)
    expect(await db.ksefInvoiceDraft.findMany({ select: { przyczyna: true, ponowieniaAuto: true, nastepnaProbaOd: true, lastError: true } })).toEqual([
      expect.objectContaining({ przyczyna: 'LOGOWANIE', ponowieniaAuto: 0, nastepnaProbaOd: po(3 * 3_600_000), lastError: expect.stringMatching(/Token KSeF zmieniony/) }),
      expect.objectContaining({ przyczyna: 'LOGOWANIE', ponowieniaAuto: 0, nastepnaProbaOd: po(3 * 3_600_000), lastError: expect.stringMatching(/Token KSeF zmieniony/) }),
    ])
    // drugi zapis tokenu: idempotentny (nic się nie zmienia poza tymi samymi polami)
    expect(await poZapisieTokenuKsef(db, po(3 * 3_600_000))).toBe(2)
    expect(await przebiegKsef(db, deps(a, { now: po(3 * 3_600_000 + MIN) }))).toMatchObject({ ponowione: 2, przyjete: 2 })
    expect(a.faktury.map((f) => f.numer).sort()).toEqual(['1/11/2026', '2/11/2026'])
    expect(wysylki(a)).toBe(2)
    expect(await ostatnieNumery()).toEqual([2])
    // trzeci przebieg: nic do zrobienia, bez drugiej faktury
    expect(await przebiegKsef(db, deps(a, { now: po(4 * 3_600_000) }))).toMatchObject({ ponowione: 0, wyslane: 0 })
    expect(a.faktury).toHaveLength(2)
    // przyjętych faktur zapis tokenu nie rusza
    expect(await poZapisieTokenuKsef(db, po(5 * 3_600_000))).toBe(0)
  })
})
