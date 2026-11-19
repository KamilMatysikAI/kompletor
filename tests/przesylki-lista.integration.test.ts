// lista przesyłek, druk masowy etykiet, protokół odbioru, etykiety w jednym PDF, anulowanie z listy
// i historia zmiany punktu odbioru. Klient firmy (RLS), dane wyłącznie fikcyjne, zero połączeń z przewoźnikami: DPD na
// atrapie (tests/dpd-atrapa.ts), pozostali bez `fetch` (każde wywołanie sieci = błąd testu).
//  1. 2 000 przesyłek: strona, filtry (numer nadania, przewoźnik, konto, stan, daty, numer zamówienia), sortowanie;
//  2. druk 50 etykiet w tle: jedno zlecenie druku na etykietę, raport z pominiętymi, ponowienie bez dubli;
//  3. protokół DPD na atrapie (za wyłącznikiem); przewoźnik bez protokołu = własna lista przekazanych paczek;
//  4. etykiety w jednym PDF (strony 1:1, ZPL i anulowane na stronie „Pominięte”);
//  5. firma bez BL i bez wFirmy: przesyłka zamówienia ręcznego na liście; izolacja firm;
//  6. anulowanie z listy na koncie z wyłączonym nadawaniem = powód, 0 żądań; zmiana punktu = wpis w historii bez kodów.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import type { Carrier, MemberRole, PrismaClient, ShipmentState } from '@prisma/client'
import type { OrderRecipient } from '@/lib/adaptery/kontrakt'
import { createUserWithHash, grantMembership } from '@/lib/auth/sesje'
import { INPOST_SHIPX_ZAPIS_KEY } from '@/lib/adaptery/inpost-zapis'
import { zapiszStan } from '@/lib/druk/zlecenia'
import { zaszyfrujEtykiete } from '@/lib/klienci/etykieta'
import { poprawDostawe } from '@/lib/klienci/poprawka'
import { rekordZOdbiorcy } from '@/lib/klienci/rekord'
import { zapiszRekordKlienta } from '@/lib/klienci/zapis'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { etykietyJednymPlikiem, powodBlokadyEtykiety } from '@/lib/wysylka/etykiety-zbiorcze'
import { filtryPrzesylekZ, idPrzesylek, kontaPrzewoznikow, SORT_PRZESYLEK_DOMYSLNY, stronaPrzesylek } from '@/lib/wysylka/lista'
import { ostatnieAkcjePrzesylek, wykonajPrzesylkiOdRazu, wykonajPrzesylkiWTle, zlecPrzesylkiWTle } from '@/lib/wysylka/masowo'
import { protokolPrzesylek } from '@/lib/wysylka/protokol'
import { ostatnieAkcje } from '@/lib/zamowienia/masowo'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { drukarka, stanowiskoZTokenem } from './druk-pomocnicze'
import { DPD_DEMO, DPD_FID, DPD_LOGIN, DPD_PASSWORD, dpdAtrapa, NADAWCA_TESTOWY } from './dpd-atrapa'
import { order, product, seedBase, T0 } from './rdzen-fixtures'

vi.mock('server-only', () => ({}))

const a = testDb()
const b = testDb({ organizationId: ORG_B })
const sys = testSystemDb()
afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})

const KLUCZE = `1:${'3'.repeat(64)}`
const ENV = { EKRANY_PRACA: '1', CUSTOMER_DATA_KEYS: KLUCZE, CUSTOMER_LOOKUP_KEY: 'c'.repeat(64), DPD_LOGIN, DPD_PASSWORD }
const DPD_KONFIG = { baseUrl: DPD_DEMO, payerFid: DPD_FID, zapisWlaczony: true }
const DPD_ZAPIS = 'dpd.services.zapis.v1'

beforeEach(async () => {
  process.env.EKRANY_PRACA = '1'
  vi.stubEnv('CUSTOMER_DATA_KEYS', KLUCZE)
  await truncateAll()
  await seedBase(a)
  await seedBase(b)
  await sys.organization.update({ where: { id: ORG_A }, data: { settings: { nadawca: NADAWCA_TESTOWY } } })
})
afterEach(() => {
  vi.unstubAllEnvs()
})

async function osoba(email: string, role: MemberRole = 'WLASCICIEL', org = ORG_A): Promise<string> {
  const u = await createUserWithHash(sys, { email, name: email, passwordHash: 'x' })
  await grantMembership(sys, { email, organizationId: org, role })
  return u.id
}

/** DPD bezpośrednio z zapisem; `nadawanie` = wyłącznik konta. Konta WOO w PRACA (anulowanie jak nadanie). */
async function dpd(db: PrismaClient = a, nadawanie = true): Promise<void> {
  await db.carrierRule.updateMany({ where: { carrier: 'DPD' }, data: { shippingModule: 'DPD_BEZPOSREDNIO', adapterKey: DPD_ZAPIS, config: { ...DPD_KONFIG, zapisWlaczony: nadawanie } } })
  await db.channelConfig.updateMany({ data: { statusMode: 'PRACA' } })
}

let seq = 0
async function zamowienie(db: PrismaClient = a, o: { deliveryMethod?: string; channel?: 'WOO_SD' | 'RECZNE' } = {}): Promise<string> {
  const pid = await product(db, `HERB-${++seq}-${Math.random().toString(36).slice(2, 6)}`, 50)
  const r = await ingestOrder(db, order([{ productId: pid, qty: 1, unitPriceGross: 30 }], { deliveryMethod: o.deliveryMethod ?? 'Kurier DPD', channel: o.channel ?? 'WOO_SD', paymentState: 'PAID', paymentMethod: 'Przelew' }), { now: T0 })
  return r.orderId!
}

async function pdfEtykiety(tekst: string): Promise<Buffer> {
  const d = await PDFDocument.create()
  d.setTitle(tekst)
  d.addPage([283, 425])
  return Buffer.from(await d.save())
}

/** Przesyłka wprost w bazie (test listy, nie hosta nadania); etykieta zaszyfrowana jak przy nadaniu. */
async function przesylka(
  orderId: string,
  o: { org?: string; carrier?: Carrier; adapterKey?: string; state?: ShipmentState; numer?: string | null; etykieta?: 'PDF' | 'ZPL' | null; createdAt?: Date; packageNo?: number; sufiks?: string } = {},
): Promise<string> {
  const org = o.org ?? ORG_A
  const numer = o.numer === undefined ? `0000${String(++seq).padStart(10, '0')}U` : o.numer
  const s = await sys.shipment.create({
    data: {
      organizationId: org,
      orderId,
      packageNo: o.packageNo ?? 1,
      reference: `ref-a149-${seq}-${Math.random().toString(36).slice(2, 8)}`,
      adapterKey: o.adapterKey ?? DPD_ZAPIS,
      carrier: o.carrier ?? 'DPD',
      state: o.state ?? 'UTWORZONA',
      trackingNumber: numer,
      externalRef: numer,
      accountSuffix: o.sufiks ?? null,
      createdAt: o.createdAt ?? T0,
    },
  })
  const format = o.etykieta === undefined ? 'PDF' : o.etykieta
  if (format) {
    const plik = format === 'PDF' ? await pdfEtykiety(`etykieta ${numer}`) : Buffer.from('^XA^FDfikcyjna^FS^XZ')
    await sys.shipment.update({ where: { id: s.id }, data: { ...zaszyfrujEtykiete(ENV, org, s.id, plik), labelFormat: format, labelFetchedAt: T0 } })
  }
  return s.id
}

async function stanowisko(): Promise<string> {
  const s = await stanowiskoZTokenem(a)
  await zapiszStan(a, s.id, { drukarki: [drukarka('TERMICZNA_1'), drukarka('A4')], wersjaAgenta: '0.2.0' }, new Date())
  return s.id
}

describe('lista przesyłek', () => {
  it('2 000 przesyłek: strona 50, filtr po numerze nadania znajduje przesyłkę, filtry i sortowanie w bazie', async () => {
    await dpd()
    const oid = await zamowienie()
    const przew: Carrier[] = ['DPD', 'PACZKOMATY', 'DPD_EMPIK', 'ALLEGRO']
    const stany: ShipmentState[] = ['UTWORZONA', 'UTWORZONA', 'ANULOWANA', 'BLAD']
    await sys.shipment.createMany({
      data: Array.from({ length: 2000 }, (_, i) => ({
        organizationId: ORG_A,
        orderId: oid,
        packageNo: i + 1, // jedna aktywna przesyłka na paczkę (indeks częściowy)
        reference: `perf-${i}`,
        adapterKey: i % 4 === 2 ? DPD_ZAPIS : i % 4 === 1 ? INPOST_SHIPX_ZAPIS_KEY : DPD_ZAPIS,
        accountSuffix: i % 4 === 2 ? 'EMPIK' : null,
        carrier: przew[i % 4]!,
        state: stany[i % 4]!,
        trackingNumber: `PERF${String(i).padStart(8, '0')}`,
        createdAt: new Date(T0.getTime() - i * 3_600_000),
      })),
    })
    await sys.$executeRawUnsafe('ANALYZE "Shipment"')
    const t0 = Date.now()
    const konta = await kontaPrzewoznikow(a)
    const s1 = await stronaPrzesylek(a, filtryPrzesylekZ({}), { sort: SORT_PRZESYLEK_DOMYSLNY, pomin: 50, ile: 50, konta })
    const s2 = await stronaPrzesylek(a, filtryPrzesylekZ({ numer: 'PERF00001234' }), { sort: SORT_PRZESYLEK_DOMYSLNY, pomin: 0, ile: 50, konta })
    const ms = Date.now() - t0
    expect(s1.razem).toBe(2000)
    expect(s1.wiersze).toHaveLength(50)
    // najnowsze pierwsze: strona 2 zaczyna się od 51. przesyłki
    expect(s1.wiersze[0]!.numer).toBe('PERF00000050')
    expect(s2.razem).toBe(1)
    expect(s2.wiersze[0]).toMatchObject({ numer: 'PERF00001234', orderId: oid, carrier: 'DPD_EMPIK', stan: 'ANULOWANA', konto: { klucz: `${DPD_ZAPIS}~EMPIK` } })
    expect(ms).toBeLessThan(3000) // lokalnie ok. 100–300 ms; zapas na obciążoną maszynę
    // fragment numeru, przewoźnik, konto drugie (EMPIK), stan, zakres dat (strefa Warszawy)
    expect((await stronaPrzesylek(a, filtryPrzesylekZ({ numer: 'perf0000123' }), { sort: SORT_PRZESYLEK_DOMYSLNY, pomin: 0, ile: 50, konta })).razem).toBe(10)
    expect((await stronaPrzesylek(a, filtryPrzesylekZ({ przewoznik: 'PACZKOMATY' }), { sort: SORT_PRZESYLEK_DOMYSLNY, pomin: 0, ile: 25, konta })).razem).toBe(500)
    const empik = await stronaPrzesylek(a, filtryPrzesylekZ({ konto: `${DPD_ZAPIS}~EMPIK` }), { sort: SORT_PRZESYLEK_DOMYSLNY, pomin: 0, ile: 25, konta })
    expect(empik.razem).toBe(500)
    expect(empik.wiersze[0]!.konto.nazwa).toMatch(/konto EMPIK/)
    expect((await stronaPrzesylek(a, filtryPrzesylekZ({ stan: 'ANULOWANA' }), { sort: SORT_PRZESYLEK_DOMYSLNY, pomin: 0, ile: 25, konta })).razem).toBe(500)
    // T0 = 15.10 10:00 w Warszawie; godziny wstecz: 15.10 od 00:00 do 10:00 to 11 przesyłek (i = 0…10)
    expect((await stronaPrzesylek(a, filtryPrzesylekZ({ od: '2026-10-15', do: '2026-10-15' }), { sort: SORT_PRZESYLEK_DOMYSLNY, pomin: 0, ile: 25, konta })).razem).toBe(11)
    const rosnaco = await stronaPrzesylek(a, filtryPrzesylekZ({}), { sort: { klucz: 'numer', kierunek: 'rosnaco' }, pomin: 0, ile: 3, konta })
    expect(rosnaco.wiersze.map((w) => w.numer)).toEqual(['PERF00000000', 'PERF00000001', 'PERF00000002'])
    // „na wszystkich stronach” w kolejności listy, z limitem
    const ids = await idPrzesylek(a, filtryPrzesylekZ({ przewoznik: 'DPD' }), SORT_PRZESYLEK_DOMYSLNY, 10)
    expect(ids).toMatchObject({ razem: 500 })
    expect(ids.ids).toHaveLength(10)
    // śmieci w filtrach odrzucone, nie trafiają do zapytania
    expect(filtryPrzesylekZ({ przewoznik: 'OSOBISTY', stan: 'X', konto: '../x', od: '2026-1-1' })).toEqual({ przewoznik: undefined, konto: undefined, stan: undefined, od: undefined, do: undefined, numer: undefined, zamowienie: undefined })
  })

  it('numer zamówienia, konto i wyłącznik nadawania w wierszu; firma B nie widzi przesyłek firmy A', async () => {
    await dpd(a, false)
    const oid = await zamowienie()
    const o = await a.order.findUniqueOrThrow({ where: { id: oid }, select: { externalId: true } })
    await przesylka(oid)
    const w = await stronaPrzesylek(a, filtryPrzesylekZ({ zamowienie: o.externalId.slice(0, 8) }), { sort: SORT_PRZESYLEK_DOMYSLNY, pomin: 0, ile: 25 })
    expect(w.razem).toBe(1)
    expect(w.wiersze[0]).toMatchObject({ zamowienie: o.externalId, etykieta: true, formatEtykiety: 'PDF', konto: { klucz: DPD_ZAPIS, nadawanie: false } })
    expect((await stronaPrzesylek(b, filtryPrzesylekZ({}), { sort: SORT_PRZESYLEK_DOMYSLNY, pomin: 0, ile: 25 })).razem).toBe(0)
  })

  it('firma bez BaseLinkera i bez wFirmy: przesyłka zamówienia ręcznego jest na liście', async () => {
    await dpd()
    const oid = await zamowienie(a, { channel: 'RECZNE' })
    await przesylka(oid, { carrier: 'DPD' })
    const w = await stronaPrzesylek(a, filtryPrzesylekZ({}), { sort: SORT_PRZESYLEK_DOMYSLNY, pomin: 0, ile: 25 })
    expect(w.wiersze.map((x) => x.orderId)).toEqual([oid])
    expect(await a.integrationSecret.count()).toBe(0)
  })
})

describe('druk masowy etykiet', () => {
  it('50 przesyłek w tle: jedno zlecenie na etykietę w kolejności listy, raport z pominiętymi, ponowienie bez dubli', async () => {
    await dpd()
    const uid = await osoba('magazyn-a149@example.invalid')
    const st = await stanowisko()
    const oid = await zamowienie()
    const ids: string[] = []
    for (let i = 0; i < 45; i++) ids.push(await przesylka(oid, { packageNo: i + 1 }))
    const bez = await przesylka(oid, { etykieta: null, packageNo: 46 })
    const anul = await przesylka(oid, { state: 'ANULOWANA', packageNo: 47 })
    const tworzy = await przesylka(oid, { state: 'TWORZENIE', etykieta: null, packageNo: 48 })
    const wyl1 = await przesylka(oid, { adapterKey: INPOST_SHIPX_ZAPIS_KEY, carrier: 'PACZKOMATY', packageNo: 49 }) // brak reguły z włączonym nadawaniem
    const wyl2 = await przesylka(oid, { sufiks: 'EMPIK', packageNo: 50 })
    const wszystkie = [...ids.slice(0, 20), bez, anul, ...ids.slice(20), tworzy, wyl1, wyl2]
    expect(wszystkie).toHaveLength(50)
    const akcja = await zlecPrzesylkiWTle(a, 'PRZESYLKI_DRUK', { stanowisko: st, nazwa: 'Jan Magazynier' } as never, wszystkie, uid)
    expect(await a.job.count({ where: { kind: 'przesylki-masowo' } })).toBe(1)
    // w parametrach akcji tylko stanowisko, bez nazwiska osoby (kto zlecił = createdBy)
    expect((await a.orderBulkAction.findUniqueOrThrow({ where: { id: akcja } })).params).toEqual({ stanowisko: st })
    // lista zamówień nie pokazuje akcji listy przesyłek, lista przesyłek tak
    expect(await ostatnieAkcje(a, uid)).toEqual([])
    expect((await ostatnieAkcjePrzesylek(a, uid)).map((x) => x.id)).toEqual([akcja])
    await wykonajPrzesylkiWTle(a, { akcja })
    const r = await a.orderBulkAction.findUniqueOrThrow({ where: { id: akcja } })
    expect(r).toMatchObject({ state: 'GOTOWE', done: 50, ok: 45, failed: 5 })
    const zlecenia = await a.printJob.findMany({ orderBy: { createdAt: 'asc' } })
    expect(zlecenia).toHaveLength(45)
    expect(zlecenia.every((z) => z.type === 'etykieta' && z.status === 'OCZEKUJE' && z.stationId === st)).toBe(true)
    const bledy = (r.results as { id: string; ok: boolean; komunikat: string }[]).filter((x) => !x.ok)
    expect(Object.fromEntries(bledy.map((x) => [x.id, x.komunikat]))).toEqual({
      [bez]: expect.stringMatching(/nie została jeszcze pobrana/),
      [anul]: expect.stringMatching(/anulowana/),
      [tworzy]: expect.stringMatching(/właśnie powstaje/),
      [wyl1]: expect.stringMatching(/Nadawanie z Kompletora jest wyłączone/),
      [wyl2]: expect.stringMatching(/Nadawanie z Kompletora jest wyłączone/),
    })
    // ponowienie zadania (drugi worker, wznowienie): bez nowych zleceń i bez dubli wyników
    await sys.orderBulkAction.update({ where: { id: akcja }, data: { state: 'TRWA' } })
    await wykonajPrzesylkiWTle(a, { akcja })
    expect(await a.printJob.count()).toBe(45)
    expect((await a.orderBulkAction.findUniqueOrThrow({ where: { id: akcja } })).done).toBe(50)
    // wznowienie po przerwie bez wyników: ten sam klucz zlecenia = bez drugiego wydruku
    await sys.orderBulkAction.update({ where: { id: akcja }, data: { state: 'TRWA', results: [], done: 0, ok: 0, failed: 0 } })
    await wykonajPrzesylkiWTle(a, { akcja })
    expect(await a.printJob.count()).toBe(45)
    expect(await a.orderBulkAction.findUniqueOrThrow({ where: { id: akcja } })).toMatchObject({ done: 50, ok: 45 })
  })

  it('od razu (poniżej progu): ten sam klucz kliknięcia nie dubluje zlecenia; osoba bez uprawnienia dostaje powód', async () => {
    await dpd()
    const uid = await osoba('magazyn2-a149@example.invalid')
    const st = await stanowisko()
    const oid = await zamowienie()
    const s1 = await przesylka(oid)
    const osobaOk = { id: uid, uprawnienia: new Set(['pakowanie.stanowisko']) }
    const w1 = await wykonajPrzesylkiOdRazu(a, 'PRZESYLKI_DRUK', { stanowisko: st, klucz: 'klik-1234567890' }, [s1], osobaOk)
    const w2 = await wykonajPrzesylkiOdRazu(a, 'PRZESYLKI_DRUK', { stanowisko: st, klucz: 'klik-1234567890' }, [s1], osobaOk)
    expect(w1).toMatchObject({ ok: 1, bledy: 0 })
    expect(w2.pozycje[0]!.komunikat).toMatch(/już było/)
    expect(await a.printJob.count()).toBe(1)
    // nowe kliknięcie = świadomy ponowny wydruk
    await wykonajPrzesylkiOdRazu(a, 'PRZESYLKI_DRUK', { stanowisko: st, klucz: 'klik-0987654321' }, [s1], osobaOk)
    expect(await a.printJob.count()).toBe(2)
    const bez = await wykonajPrzesylkiOdRazu(a, 'PRZESYLKI_DRUK', { stanowisko: st }, [s1], { id: uid, uprawnienia: new Set() })
    expect(bez.pozycje[0]).toMatchObject({ ok: false, komunikat: expect.stringMatching(/Brak uprawnienia/) })
    // druk od razu bez klucza kliknięcia nie dostaje stałego klucza „reczny” (bez zlecenia)
    const bezKlucza = await wykonajPrzesylkiOdRazu(a, 'PRZESYLKI_DRUK', { stanowisko: st }, [s1], osobaOk)
    expect(bezKlucza.pozycje[0]).toMatchObject({ ok: false, komunikat: expect.stringMatching(/Odśwież stronę/) })
    expect(await a.printJob.count()).toBe(2)
  })
})

describe('protokół odbioru', () => {
  it('DPD z włączonym nadawaniem i z wyłączonym: zawsze własna lista przekazanych paczek, zero żądań do przewoźnika (protokół od przewoźnika osobno)', async () => {
    await dpd()
    const oid = await zamowienie()
    const s1 = await przesylka(oid, { numer: '0000111111111U' })
    const s2 = await przesylka(oid, { numer: '0000222222222U', packageNo: 2 })
    const anul = await przesylka(oid, { numer: '0000333333333U', state: 'ANULOWANA', packageNo: 3 })
    const siec = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('test: żądanie sieciowe zabronione')
    })
    try {
      const p = await protokolPrzesylek(a, [s1, s2, anul], { nazwa: 'Magazyn' })
      expect(p).toMatchObject({ zrodlo: 'LISTA', opis: 'Lista przekazanych paczek, liczba przesyłek: 2', pominiete: [{ id: anul, powod: 'przesyłka anulowana' }] })
      expect(p.pdf.subarray(0, 5).toString()).toBe('%PDF-')
      await dpd(a, false)
      expect((await protokolPrzesylek(a, [s1], { nazwa: 'Magazyn' })).zrodlo).toBe('LISTA')
      expect(siec).not.toHaveBeenCalled()
    } finally {
      siec.mockRestore()
    }
  })

  it('przewoźnik bez protokołu (InPost) i kilku przewoźników naraz: własna lista przekazanych paczek, bez sieci', async () => {
    await dpd()
    const oid1 = await zamowienie(a, { deliveryMethod: 'Paczkomaty InPost' })
    const oid2 = await zamowienie()
    const i1 = await przesylka(oid1, { carrier: 'PACZKOMATY', adapterKey: INPOST_SHIPX_ZAPIS_KEY, numer: '620000000000000000000001' })
    const d1 = await przesylka(oid2, { numer: '0000444444444U' })
    const p = await protokolPrzesylek(a, [i1, d1], { nazwa: 'Magazyn' })
    expect(p.zrodlo).toBe('LISTA')
    expect(p.pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(p.opis).toMatch(/liczba przesyłek: 2$/)
    const tylkoInpost = await protokolPrzesylek(a, [i1], { nazwa: 'Magazyn' })
    expect(tylkoInpost.zrodlo).toBe('LISTA')
    // nic do protokołu = czytelna odmowa
    const anul = await przesylka(oid1, { state: 'ANULOWANA', carrier: 'PACZKOMATY', adapterKey: INPOST_SHIPX_ZAPIS_KEY, packageNo: 2 })
    await expect(protokolPrzesylek(a, [anul], { nazwa: 'Magazyn' })).rejects.toThrow(/Żadna z zaznaczonych/)
  })
})

describe('etykiety w jednym PDF', () => {
  it('strony etykiet 1:1 w kolejności listy, ZPL, anulowane i konto z wyłączonym nadawaniem na stronie „Pominięte”', async () => {
    await dpd()
    const oid = await zamowienie()
    const e1 = await przesylka(oid)
    const e2 = await przesylka(oid, { packageNo: 2 })
    const zpl = await przesylka(oid, { etykieta: 'ZPL', packageNo: 3 })
    const anul = await przesylka(oid, { state: 'ANULOWANA', packageNo: 4 })
    const wyl = await przesylka(oid, { sufiks: 'EMPIK', packageNo: 5 })
    const w = await etykietyJednymPlikiem(a, [e2, zpl, e1, anul, wyl])
    expect(w.dolaczone).toBe(2)
    expect(w.pominiete.map((p) => p.id)).toEqual([zpl, anul, wyl])
    expect(w.pominiete[0]!.powod).toMatch(/ZPL/)
    const doc = await PDFDocument.load(w.pdf!)
    // 2 etykiety + 1 strona raportu
    expect(doc.getPageCount()).toBe(3)
    expect(doc.getPage(0).getSize()).toEqual({ width: 283, height: 425 })
    // pojedyncza etykieta (ścieżka ZPL z przycisku w wierszu) ma tę samą bramkę konta co plik
    expect(await powodBlokadyEtykiety(a, wyl)).toMatch(/Nadawanie z Kompletora jest wyłączone/)
    expect(await powodBlokadyEtykiety(a, zpl)).toBeNull()
    expect(await powodBlokadyEtykiety(a, 'nieistnieje1')).toBeNull()
  })
})

describe('anulowanie z listy i historia punktu', () => {
  it('konto z wyłączonym nadawaniem: anulowanie pominięte z powodem, przesyłka bez zmian, zero żądań', async () => {
    await dpd(a, false)
    const uid = await osoba('biuro-a149@example.invalid')
    const oid = await zamowienie()
    const s1 = await przesylka(oid)
    const atrapa = dpdAtrapa()
    const w = await wykonajPrzesylkiOdRazu(a, 'PRZESYLKI_ANULUJ', {}, [s1], { id: uid, uprawnienia: new Set(['pakowanie.stanowisko']) }, { fetch: atrapa.fetchImpl, env: ENV })
    expect(w.pozycje[0]).toMatchObject({ ok: false, komunikat: expect.stringMatching(/wyłączone/) })
    expect((await a.shipment.findUniqueOrThrow({ where: { id: s1 } })).state).toBe('UTWORZONA')
    expect(atrapa.calls).toEqual([])
  })

  it('DPD z włączonym nadawaniem: przewoźnik nie anuluje z Kompletora, powód z hosta przesyłek, zero żądań', async () => {
    await dpd()
    const uid = await osoba('biuro2-a149@example.invalid')
    const oid = await zamowienie()
    const s1 = await przesylka(oid)
    const atrapa = dpdAtrapa()
    const w = await wykonajPrzesylkiOdRazu(a, 'PRZESYLKI_ANULUJ', {}, [s1], { id: uid, uprawnienia: new Set(['pakowanie.stanowisko']) }, { fetch: atrapa.fetchImpl, env: ENV, secrets: { env: ENV, envFallback: true } })
    expect(w.pozycje[0]).toMatchObject({ ok: false, komunikat: expect.stringMatching(/nie anuluje przesyłek z Kompletora/) })
    expect(atrapa.calls).toEqual([])
  })

  it('zmiana punktu odbioru z wyszukiwarki: wpis w historii zamówienia bez kodów punktu', async () => {
    const uid = await osoba('biuro3-a149@example.invalid')
    const oid = await zamowienie(a, { deliveryMethod: 'Paczkomaty InPost' })
    const odbiorca: OrderRecipient = {
      dostawa: { imieNazwisko: 'Anna Fikcyjna', firma: null, ulica: 'ul. Atrapowa', numerDomu: '9', numerLokalu: null, kodPocztowy: '60-002', miasto: 'Poznań', kraj: 'PL', telefon: '+48 511 222 333', email: 'anna@example.test' },
      punktOdbioru: { kod: 'POZ01X', nazwa: null },
      faktura: null,
      problemy: [],
    }
    await zapiszRekordKlienta(a, oid, rekordZOdbiorcy(odbiorca), { source: 'RECZNE', fetchedAt: T0, env: ENV })
    const w = await poprawDostawe(
      a,
      oid,
      { imieNazwisko: 'Anna Fikcyjna', firma: null, ulica: 'ul. Atrapowa', numerDomu: '9', numerLokalu: null, kodPocztowy: '60-002', miasto: 'Poznań', telefon: '+48 511 222 333', punkt: 'POZ99X' },
      { actorId: uid, env: ENV, zrodloPunktu: 'WYSZUKIWARKA' },
    )
    expect(w).toMatchObject({ wynik: 'ZAPISANO', pola: ['punkt'] })
    const ev = await a.orderEvent.findMany({ where: { orderId: oid, kind: 'PUNKT_ODBIORU_ZMIENIONY' } })
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ actorId: `user:${uid}`, data: { zrodlo: 'WYSZUKIWARKA', usuniety: false } })
    expect(JSON.stringify(ev[0]!.data)).not.toMatch(/POZ0|POZ9/)
  })
})
