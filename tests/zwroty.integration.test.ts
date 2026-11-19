// zwroty i reklamacje w Kompletorze. Kryteria akceptacji zadania:
//   - zwrot 2 pozycji, jedna na stan, jedna uszkodzona → `physical` +1, raport niedoborów bez zmian, historia ruchów obu,
//   - korekta na atrapie wFirmy wywołana raz przy ponowieniu (idempotencja), dostawca „brak programu” bez korekty i błędu,
//   - firma bez BL i bez wFirmy przyjmuje zwrot na stan od początku do końca (karta zwrotu z historią),
//   - zwroty Allegro z API (nagrana odpowiedź bez danych kupującego) zakładają zwrot „Nowe” raz, bez dubla.
// Dane fikcyjne. Zero sieci: wFirma i Allegro to atrapy.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { allegroReturnsFromApi } from '@/lib/adaptery/allegro'
import type { ChannelReturn, ReturnReader } from '@/lib/adaptery/kontrakt'
import { markShipped, readyForDispatch } from '@/lib/rdzen/przejscia'
import { issueInvoice, packOrder } from '@/lib/rdzen/rozchod'
import { applyStockRead } from '@/lib/rdzen/lustro'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { runWfirmaQueue } from '@/lib/rdzen/kolejka-wfirmy'
import { SourceError } from '@/lib/zrodla/http'
import { createReturn, issueCorrection, receiveReturn, rejectReturn, requestCorrection, resolveUnknownCorrections, ReturnError, zakonczKorektePozaKompletorem } from '@/lib/rdzen/zwroty'
import { KorektyWfirmaZapis } from '@/lib/wfirma/korekta-zapis'
import type { WynikWystawienia } from '@/lib/zrodla/wfirma-zapis'
import { kartaZwrotu, zamowienieDoZwrotu } from '@/lib/zwroty/karta'
import { przyjmijZwrotyKanalu, wczytajZwroty } from '@/lib/zwroty/z-kanalu'
import { przygotujZdjecieZwrotu, zapiszZdjecieZwrotu, zdjecieZwrotu, ZdjecieZwrotuError } from '@/lib/zwroty/zdjecie'
import sharp from 'sharp'
import { ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { expectInvariants, FakeWfirma, offer, order, product, seedBase, stockOf, T0 } from './rdzen-fixtures'

const db = testDb()
beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
})
afterAll(() => db.$disconnect())

const S = 1000
const M = 60_000
const at = (ms: number) => new Date(T0.getTime() + ms)

async function stanKompletora() {
  await db.warehouse.updateMany({ data: { stockSource: 'KOMPLETOR', wfirmaWarehouseId: null } })
}

/** Zamówienie wydane przy stanie Kompletora (spakowane, do wysyłki, wysłane). */
async function wydaneKompletor(lines: { productId?: string; qty: number; offerExternalId?: string }[], over: Parameters<typeof order>[1] = {}) {
  const { orderId } = await ingestOrder(db, order(lines, over), { now: T0 })
  const id = orderId!
  await packOrder(db, id, { now: T0 })
  expect(await readyForDispatch(db, id, { now: T0 })).toBe('DO_WYSLANIA')
  await markShipped(db, id, { now: T0 })
  const ol = await db.orderLine.findMany({ where: { orderId: id }, orderBy: { externalLineId: 'asc' } })
  return { id, lines: ol }
}

/** Zamówienie wysłane z fakturą wFirmy (atrapa) i potwierdzone odczytem — jak tests/rdzen-zwroty.integration.test.ts. */
async function wydaneWfirma(lines: { productId: string; qty: number }[]) {
  const wf = new FakeWfirma()
  const { orderId } = await ingestOrder(db, order(lines), { now: T0 })
  const id = orderId!
  await packOrder(db, id, { now: T0 })
  expect(await issueInvoice(db, id, wf, { now: at(S) })).toBe('WYSTAWIONA')
  await readyForDispatch(db, id, { now: at(2 * S) })
  await markShipped(db, id, { now: at(3 * S) })
  for (const m of await db.pendingMovement.findMany({ where: { orderId: id, state: 'APPLIED' } })) {
    const s = await stockOf(db, m.productId)
    await applyStockRead(db, { productId: m.productId, countBase: s.wfirmaCount + m.delta, requestSentAt: at(10 * S) }, { now: at(10 * S) })
  }
  const ol = await db.orderLine.findMany({ where: { orderId: id }, orderBy: { externalLineId: 'asc' } })
  return { id, lines: ol }
}

const ustawFaktury = (faktury: Record<string, unknown>) => testSystemDb().organization.update({ where: { id: 'test_a' }, data: { settings: { faktury } as never } })

describe('kryterium: zwrot 2 pozycji, jedna na stan, jedna uszkodzona (stan Kompletora)', () => {
  it('physical rośnie o jedną, raport niedoborów bez zmian, historia ruchów z obiema pozycjami, karta zwrotu z historią', async () => {
    await stanKompletora()
    const a = await product(db, 'A148-A', 5)
    const b = await product(db, 'A148-B', 5)
    const { id, lines } = await wydaneKompletor([{ productId: a, qty: 1 }, { productId: b, qty: 1 }])
    const przed = { a: await stockOf(db, a), b: await stockOf(db, b), braki: await db.shortage.count(), brakiOtwarte: await db.shortage.count({ where: { resolvedAt: null } }) }

    const z = await zamowienieDoZwrotu(db, id)
    expect(z).toMatchObject({ stanKompletora: true })
    expect(z!.pozycje.map((p) => p.maks)).toEqual([1, 1])
    const rid = await createReturn(db, id, [{ orderLineId: lines[0]!.id, qty: 1 }, { orderLineId: lines[1]!.id, qty: 1 }], { reason: 'odstapienie', actorId: 'user:u1', now: at(M) })
    const rl = await db.returnLine.findMany({ where: { returnId: rid } })
    await receiveReturn(db, rid, Object.fromEntries(rl.map((l) => [l.id, l.productId === a ? ('NA_STAN' as const) : ('USZKODZONE' as const)])), { actorId: 'user:u1', now: at(2 * M) })

    // drugie kliknięcie po odświeżeniu = czytelny komunikat
    await expect(receiveReturn(db, rid, 'NA_STAN', { actorId: 'user:u1' })).rejects.toThrow('Paczka jest już odebrana')
    const pa = await stockOf(db, a)
    const pb = await stockOf(db, b)
    expect(pa.physical + pb.physical).toBe(przed.a.physical + przed.b.physical + 1)
    expect(pa.physical).toBe(przed.a.physical + 1)
    expect(pb.physical).toBe(przed.b.physical)
    expect(await db.shortage.count()).toBe(przed.braki)
    expect(await db.shortage.count({ where: { resolvedAt: null } })).toBe(przed.brakiOtwarte)
    const ruchy = await db.stockMovement.findMany({ where: { orderId: id, source: 'OWN_RETURN' }, select: { productId: true, deltaPhysical: true, reason: true } })
    expect(ruchy.map((r) => [r.productId, r.deltaPhysical]).sort()).toEqual([[a, 1], [b, 0]].sort())
    expect(ruchy.find((r) => r.productId === b)!.reason).toMatch(/uszkodzone/)

    const k = await kartaZwrotu(db, rid)
    expect(k).toMatchObject({ status: 'ZAKONCZONY', reason: 'odstapienie', source: 'PANEL', stanKompletora: true })
    expect(k!.korekta).toMatchObject({ zlecenie: false, recznie: false, szkicKsef: false })
    expect(k!.historia.map((h) => h.co)).toEqual(['Zwrot zgłoszony', 'Paczka odebrana w magazynie', 'Towar przyjęty na stan (uszkodzone poza sprzedażą)'])
    expect(k!.pozycje.map((p) => p.disposition).sort()).toEqual(['NA_STAN', 'USZKODZONE'])
    await expectInvariants(db)
  })
})

describe('reklamacja i odrzucenie', () => {
  it('reklamacja: ten sam przepływ co zwrot, inny rodzaj i zdarzenie; odrzucenie zwalnia limit', async () => {
    await stanKompletora()
    const a = await product(db, 'A148-R', 3)
    const { id, lines } = await wydaneKompletor([{ productId: a, qty: 2 }])
    const rid = await createReturn(db, id, [{ orderLineId: lines[0]!.id, qty: 2 }], { kind: 'REKLAMACJA', reason: 'uszkodzony', now: at(M) })
    expect(await db.return.findUniqueOrThrow({ where: { id: rid } })).toMatchObject({ kind: 'REKLAMACJA', status: 'ZGLOSZONY' })
    expect(await db.orderEvent.count({ where: { orderId: id, kind: 'REKLAMACJA_ZGLOSZONA' } })).toBe(1)
    await expect(createReturn(db, id, [{ orderLineId: lines[0]!.id, qty: 1 }])).rejects.toThrow(ReturnError)
    await rejectReturn(db, rid, { note: 'paczka nie przyszła', actorId: 'user:u1' })
    expect((await zamowienieDoZwrotu(db, id))!.pozycje[0]!.maks).toBe(2)
    await expect(createReturn(db, id, [{ orderLineId: lines[0]!.id, qty: 1 }], { reason: 'x'.repeat(501) })).rejects.toThrow(/500 znaków/)
  })
})

/**
 * Atrapa wFirmy dla prawdziwego adaptera korekt: `invoices/get` (pozycje faktury albo utworzonej korekty) i
 * `invoices/find` po id_external. `kontrola`: jak atrapa oddaje utworzoną korektę przy odczycie kontrolnym:
 * `ZGODNA` = ilości z treści zapisu, `ROZNICA` = wFirma przeczytała ilość jako różnicę (ilość z faktury minus „po”),
 * `BLAD` = odczyt kontrolny pada. `fakturaBlad`: odczyt faktury pierwotnej kończy się błędem bez ponawiania.
 */
class AtrapaWfirmyKorekt {
  zapisy: { invoices: { invoice: Record<string, unknown> } }[] = []
  utworzone: { id: string; idExternal: string; tresc: { invoices: { invoice: Record<string, unknown> } } }[] = []
  tryb: ('OK' | 'TIMEOUT_PO_UTWORZENIU' | 'ERROR')[] = []
  kontrola: 'ZGODNA' | 'ROZNICA' | 'BLAD' = 'ZGODNA'
  fakturaBlad: SourceError | null = null
  odczyty: string[] = []
  constructor(private readonly pozycje: { id: string; goodId: string; count: number }[]) {}
  async call<T>(path: string, body: unknown): Promise<T> {
    if (path.startsWith('invoices/get/')) {
      const docId = path.slice('invoices/get/'.length)
      this.odczyty.push(docId)
      const kor = this.utworzone.find((u) => u.id === docId)
      if (kor) {
        if (this.kontrola === 'BLAD') throw new SourceError('wFirma invoices/get: HTTP 503', true)
        const tresci = kor.tresc.invoices.invoice['invoicecontents'] as { invoicecontent: { parent: { id: string }; count: number } }[]
        const contents = Object.fromEntries(
          tresci.map((t, i) => {
            const p = this.pozycje.find((x) => x.id === t.invoicecontent.parent.id)!
            const count = this.kontrola === 'ROZNICA' ? p.count - t.invoicecontent.count : t.invoicecontent.count
            return [String(i), { invoicecontent: { id: String(900 + i), good: { id: p.goodId }, count, name: `Towar ${p.goodId}`, parent: { id: p.id } } }]
          }),
        )
        return { invoices: { '0': { invoice: { id: docId, type: 'correction', invoicecontents: contents } } } } as T
      }
      if (this.fakturaBlad) throw this.fakturaBlad
      const contents = Object.fromEntries(this.pozycje.map((p, i) => [String(i), { invoicecontent: { id: p.id, good: { id: p.goodId }, count: p.count, name: `Towar ${p.goodId}` } }]))
      return { invoices: { '0': { invoice: { id: path.slice('invoices/get/'.length), invoicecontents: contents } } } } as T
    }
    if (path === 'invoices/find') {
      const v = String((body as { invoices: { parameters: { conditions: { condition: { value: string } } } } }).invoices.parameters.conditions.condition.value).replace(/%$/, '')
      const f = this.utworzone.filter((u) => u.idExternal.startsWith(v))
      return { invoices: Object.fromEntries(f.map((u, i) => [String(i), { invoice: { id: u.id, id_external: u.idExternal } }])) } as T
    }
    throw new Error(`atrapa: nieznana ścieżka ${path}`)
  }
  zapis = {
    wystawKorekte: async (tresc: { invoices: { invoice: Record<string, unknown> } }): Promise<WynikWystawienia> => {
      this.zapisy.push(tresc)
      const t = this.tryb.shift() ?? 'OK'
      if (t === 'ERROR') return { kind: 'ERROR', message: 'atrapa: odrzucone' }
      const id = String(8000 + this.utworzone.length + 1)
      this.utworzone.push({ id, idExternal: String(tresc.invoices.invoice['id_external']), tresc })
      return t === 'TIMEOUT_PO_UTWORZENIU' ? { kind: 'TIMEOUT', message: 'atrapa: timeout' } : { kind: 'OK', id, numer: `KOR ${id}` }
    },
  }
}

describe('korekta faktury przez dostawcę dokumentów (wFirma, atrapa)', () => {
  async function zwrotDoKorekty() {
    const a = await product(db, 'A148-W', 10, { wfirmaGoodId: '501' })
    const { id, lines } = await wydaneWfirma([{ productId: a, qty: 3 }])
    const rid = await createReturn(db, id, [{ orderLineId: lines[0]!.id, qty: 2 }], { reason: 'odstapienie', now: at(M) })
    // numer faktury jak w wFirmie (cyfry); atrapa rdzenia nadaje „FV/1”
    await db.return.update({ where: { id: rid }, data: { invoiceDocId: '7001' } })
    const rl = await db.returnLine.findMany({ where: { returnId: rid } })
    await receiveReturn(db, rid, Object.fromEntries(rl.map((l) => [l.id, 'NA_STAN' as const])), { now: at(2 * M) })
    return { a, id, rid }
  }

  it('wyłączone wystawianie albo konto w podglądzie: przycisk nieaktywny z powodem, zakończenie poza Kompletorem; włączone + Aktywny: korekta raz mimo timeoutu i ponowienia', async () => {
    const { rid } = await zwrotDoKorekty()
    await ustawFaktury({ program: 'wfirma', fakturyWlaczone: false })
    let k = await kartaZwrotu(db, rid)
    expect(k!.korekta).toMatchObject({ zlecenie: false, recznie: true })
    expect(k!.korekta.powod).toMatch(/Wystawianie faktur z Kompletora jest wyłączone/)
    await ustawFaktury({ program: 'wfirma', fakturyWlaczone: true, fakturyWlaczoneOd: T0.toISOString() })
    k = await kartaZwrotu(db, rid)
    expect(k!.korekta.powod).toMatch(/Korekty faktur z Kompletora są wyłączone/)
    await ustawFaktury({ program: 'wfirma', fakturyWlaczone: true, fakturyWlaczoneOd: T0.toISOString(), korektyWlaczone: true })
    k = await kartaZwrotu(db, rid)
    expect(k!.korekta.powod).toMatch(/Tylko podgląd/)
    await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })
    k = await kartaZwrotu(db, rid)
    expect(k!.korekta).toMatchObject({ zlecenie: true, powod: null })

    const wf = new AtrapaWfirmyKorekt([{ id: '91', goodId: '501', count: 3 }])
    const korekty = new KorektyWfirmaZapis(wf, db, { zapis: wf.zapis })
    await requestCorrection(db, rid, { now: at(3 * M) })
    // pierwsza próba: wFirma utworzyła korektę, ale odpowiedź nie doszła (timeout) → niewiadoma, bez drugiej korekty
    wf.tryb = ['TIMEOUT_PO_UTWORZENIU']
    expect(await issueCorrection(db, rid, korekty, { now: at(4 * M) })).toBe('TIMEOUT')
    expect(await issueCorrection(db, rid, korekty, { now: at(4 * M) })).toBe('W_TOKU')
    expect((await resolveUnknownCorrections(db, korekty, { now: at(4 * M + 31 * S) })).found).toBe(1)
    // ponowienie po rozstrzygnięciu: korekta już jest, wFirma nie dostaje drugiego zapisu
    expect(await issueCorrection(db, rid, korekty, { now: at(5 * M) })).toBe('NIC')
    expect(wf.zapisy).toHaveLength(1)
    expect(wf.zapisy[0]!.invoices.invoice).toMatchObject({ type: 'correction', parent: { id: '7001' }, id_external: `zwrot/${rid}/1`, invoicecontents: [{ invoicecontent: { parent: { id: '91' }, count: 1 } }] })
    const r = await db.return.findUniqueOrThrow({ where: { id: rid } })
    expect(r).toMatchObject({ status: 'ZAKONCZONY', correctionState: 'ISSUED', correctionDocId: '8001' })
    // brak PZ z korekty: pozycja „na stan” na liście „korekta bez PZ” (biuro potwierdza)
    expect(await db.alert.count({ where: { kind: 'KOREKTA_BEZ_PZ' } })).toBe(1)
    await expectInvariants(db)
  })

  it('adapter odmawia bez wywołania zapisu, gdy konto zamówienia jest w podglądzie albo zwrot nie czeka na korektę', async () => {
    const { rid } = await zwrotDoKorekty()
    await requestCorrection(db, rid, { now: at(3 * M) })
    const wf = new AtrapaWfirmyKorekt([{ id: '91', goodId: '501', count: 3 }])
    const korekty = new KorektyWfirmaZapis(wf, db, { zapis: wf.zapis })
    expect(await korekty.issueCorrection({ idExternal: `zwrot/${rid}/1`, invoiceDocId: '7001', lines: [] })).toMatchObject({ kind: 'ERROR', message: expect.stringMatching(/Tylko podgląd/) })
    expect(await korekty.issueCorrection({ idExternal: `zwrot/${rid}/1`, invoiceDocId: '9999', lines: [] })).toMatchObject({ kind: 'ERROR' })
    expect(await korekty.issueCorrection({ idExternal: 'zwrot/../1', invoiceDocId: '7001', lines: [] })).toMatchObject({ kind: 'ERROR' })
    expect(wf.zapisy).toHaveLength(0)
  })

  it('korekta wystawiona poza Kompletorem: zwrot zakończony, „na stan” na liście bez PZ, bez sondy find (correctionState puste)', async () => {
    const { rid } = await zwrotDoKorekty()
    await zakonczKorektePozaKompletorem(db, rid, { numer: 'KOR 1/11/2026', actorId: 'user:u1', now: at(3 * M) })
    const r = await db.return.findUniqueOrThrow({ where: { id: rid } })
    expect(r).toMatchObject({ status: 'ZAKONCZONY', correctionState: null, correctionDocId: null })
    expect(await db.alert.count({ where: { kind: 'KOREKTA_BEZ_PZ' } })).toBe(1)
    const k = await kartaZwrotu(db, rid)
    expect(k!.historia.map((h) => h.co)).toContain('Korekta wystawiona poza Kompletorem (numer KOR 1/11/2026)')
    // drugi raz: bez skutku
    await zakonczKorektePozaKompletorem(db, rid, { actorId: 'user:u1' })
    expect(await db.orderEvent.count({ where: { kind: 'KOREKTA_POZA_KOMPLETOREM' } })).toBe(1)
  })

  it('„W trakcie” bez adaptera korekt (wyłączone): zakończenie poza Kompletorem; korekta w wysyłce (SENDING) = odmowa', async () => {
    const { rid } = await zwrotDoKorekty()
    await requestCorrection(db, rid, { now: at(3 * M) })
    await db.return.update({ where: { id: rid }, data: { correctionState: 'SENDING' } })
    await expect(zakonczKorektePozaKompletorem(db, rid, { actorId: 'user:u1' })).rejects.toThrow(/właśnie wysyłana/)
    await db.return.update({ where: { id: rid }, data: { correctionState: null } })
    await zakonczKorektePozaKompletorem(db, rid, { actorId: 'user:u1', now: at(4 * M) })
    expect(await db.return.findUniqueOrThrow({ where: { id: rid } })).toMatchObject({ status: 'ZAKONCZONY', correctionState: null })
  })

  it('dostawca „brak programu”: zwrot przy stanie Kompletora kończy się bez korekty i bez błędu', async () => {
    await stanKompletora()
    await ustawFaktury({ program: 'brak' })
    const a = await product(db, 'A148-BR', 4)
    const { id, lines } = await wydaneKompletor([{ productId: a, qty: 1 }])
    const rid = await createReturn(db, id, [{ orderLineId: lines[0]!.id, qty: 1 }], { reason: 'nie_pasuje' })
    await receiveReturn(db, rid, 'NA_STAN', { now: at(M) })
    const k = await kartaZwrotu(db, rid)
    expect(k).toMatchObject({ status: 'ZAKONCZONY' })
    expect(k!.korekta).toMatchObject({ zlecenie: false, recznie: false, szkicKsef: false })
    expect(k!.korekta.powod).toMatch(/Korekta nie jest potrzebna/)
    expect(await db.alert.count({ where: { kind: { in: ['KOREKTA_BLAD', 'FAKTURA_DO_KOREKTY'] } } })).toBe(0)
  })
})

describe('poprawki po przeglądzie', () => {
  /** Faktura na 3 szt. towaru 501 (pozycja 91), zwrot `ile` sztuk przyjęty na stan, faktura 7001, konto Aktywne. */
  async function przygotuj() {
    const a = await product(db, 'A148-P', 10, { wfirmaGoodId: '501' })
    const { id, lines } = await wydaneWfirma([{ productId: a, qty: 3 }])
    await ustawFaktury({ program: 'wfirma', fakturyWlaczone: true, fakturyWlaczoneOd: T0.toISOString(), korektyWlaczone: true })
    await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })
    const zwrot = async (ile: number, m: number) => {
      const rid = await createReturn(db, id, [{ orderLineId: lines[0]!.id, qty: ile }], { reason: 'odstapienie', now: at(m * M) })
      await db.return.update({ where: { id: rid }, data: { invoiceDocId: '7001' } })
      const rl = await db.returnLine.findMany({ where: { returnId: rid } })
      await receiveReturn(db, rid, Object.fromEntries(rl.map((l) => [l.id, 'NA_STAN' as const])), { now: at(m * M + S) })
      return rid
    }
    const wf = new AtrapaWfirmyKorekt([{ id: '91', goodId: '501', count: 3 }])
    return { id, zwrot, wf, korekty: new KorektyWfirmaZapis(wf, db, { zapis: wf.zapis }) }
  }

  it('drugi zwrot do tej samej faktury nie dostaje drugiej korekty z Kompletora (przycisk z powodem, adapter odmawia), zapis do wFirmy jeden', async () => {
    const { zwrot, wf, korekty } = await przygotuj()
    const r1 = await zwrot(2, 1)
    expect((await kartaZwrotu(db, r1))!.korekta).toMatchObject({ zlecenie: true, powod: null })
    await requestCorrection(db, r1, { now: at(3 * M) })
    expect(await issueCorrection(db, r1, korekty, { now: at(4 * M) })).toBe('WYSTAWIONA')
    expect(await db.return.findUniqueOrThrow({ where: { id: r1 } })).toMatchObject({ status: 'ZAKONCZONY', correctionDocId: '8001' })

    const r2 = await zwrot(1, 5)
    const k2 = await kartaZwrotu(db, r2)
    expect(k2!.korekta).toMatchObject({ zlecenie: false, recznie: true, powod: expect.stringMatching(/ma już korektę z innego zwrotu/) })
    // z pominięciem przycisku (np. zlecone przed pierwszą korektą): adapter odmawia, zwrot czeka na „poza Kompletorem”
    await requestCorrection(db, r2, { now: at(6 * M) })
    expect(await issueCorrection(db, r2, korekty, { now: at(7 * M) })).toBe('BLAD')
    expect(wf.zapisy).toHaveLength(1)
    expect(await db.return.findUniqueOrThrow({ where: { id: r2 } })).toMatchObject({ status: 'KOREKTA', correctionState: 'FAILED', lastError: expect.stringMatching(/ma już korektę/) })
    expect(await db.alert.count({ where: { kind: 'KOREKTA_BLAD' } })).toBe(1)
    expect((await kartaZwrotu(db, r2))!.korekta).toMatchObject({ ponowienie: false, recznie: true })
    await zakonczKorektePozaKompletorem(db, r2, { numer: 'KOR 2/11/2026', actorId: 'user:u1', now: at(8 * M) })
    expect(await db.return.findUniqueOrThrow({ where: { id: r2 } })).toMatchObject({ status: 'ZAKONCZONY' })
  })

  it('korekta pierwszego zwrotu w drodze (niewiadoma) też blokuje drugi; dwa zwroty w kolejce nie blokują się nawzajem przed wysłaniem', async () => {
    const { zwrot, wf, korekty } = await przygotuj()
    const r1 = await zwrot(1, 1)
    const r2 = await zwrot(1, 2)
    await requestCorrection(db, r1, { now: at(3 * M) })
    await requestCorrection(db, r2, { now: at(3 * M) })
    // oba w kolejce, nic nie wysłane: pierwszy idzie (timeout po utworzeniu), drugi widzi korektę w drodze
    wf.tryb = ['TIMEOUT_PO_UTWORZENIU']
    expect(await issueCorrection(db, r1, korekty, { now: at(4 * M) })).toBe('TIMEOUT')
    expect((await kartaZwrotu(db, r2))!.korekta).toMatchObject({ zlecenie: false, ostrzezenie: expect.stringMatching(/właśnie wysyłana/) })
    expect(await issueCorrection(db, r2, korekty, { now: at(4 * M) })).toBe('BLAD')
    expect(wf.zapisy).toHaveLength(1)
  })

  it('korekta z inną ilością w wFirmie: zwrot zakończony (dokument istnieje), alert „Korekta z innymi ilościami” z pozycją i lastError', async () => {
    const { zwrot, wf, korekty } = await przygotuj()
    const r1 = await zwrot(2, 1)
    await requestCorrection(db, r1, { now: at(3 * M) })
    wf.kontrola = 'ROZNICA'
    expect(await issueCorrection(db, r1, korekty, { now: at(4 * M) })).toBe('WYSTAWIONA')
    expect(wf.odczyty).toEqual(['7001', '8001'])
    const r = await db.return.findUniqueOrThrow({ where: { id: r1 } })
    expect(r).toMatchObject({ status: 'ZAKONCZONY', correctionState: 'ISSUED', correctionDocId: '8001' })
    expect(r.lastError).toMatch(/Korekta 8001 faktury 7001 ma w wFirmie inne ilości niż wynika ze zwrotu: Towar 501: jest 2, powinno być 1/)
    const al = await db.alert.findMany({ where: { kind: 'KOREKTA_NIEZGODNA' } })
    expect(al).toHaveLength(1)
    expect(al[0]!.message).toMatch(/Popraw korektę w wFirmie/)
    expect(wf.zapisy).toHaveLength(1)
    await expectInvariants(db)
  })

  it('na torze po timeoucie: korekta znaleziona przez find też jest sprawdzana (inna ilość = alert, zwrot zakończony)', async () => {
    const { zwrot, wf, korekty } = await przygotuj()
    const r1 = await zwrot(2, 1)
    await requestCorrection(db, r1, { now: at(3 * M) })
    wf.tryb = ['TIMEOUT_PO_UTWORZENIU']
    wf.kontrola = 'ROZNICA'
    expect(await issueCorrection(db, r1, korekty, { now: at(4 * M) })).toBe('TIMEOUT')
    expect(await db.alert.count({ where: { kind: 'KOREKTA_NIEZGODNA' } })).toBe(0)
    expect((await resolveUnknownCorrections(db, korekty, { now: at(4 * M + 31 * S) })).found).toBe(1)
    expect(await db.return.findUniqueOrThrow({ where: { id: r1 } })).toMatchObject({ status: 'ZAKONCZONY', correctionDocId: '8001', lastError: expect.stringMatching(/jest 2, powinno być 1/) })
    expect(await db.alert.count({ where: { kind: 'KOREKTA_NIEZGODNA' } })).toBe(1)
    expect(wf.zapisy).toHaveLength(1)
  })

  it('zgodna korekta bez alertu; odczyt kontrolny nieudany = zwrot zakończony i alert ostrzegawczy', async () => {
    const { zwrot, wf, korekty } = await przygotuj()
    const r1 = await zwrot(1, 1)
    await requestCorrection(db, r1, { now: at(3 * M) })
    expect(await issueCorrection(db, r1, korekty, { now: at(4 * M) })).toBe('WYSTAWIONA')
    expect(await db.alert.count({ where: { kind: { in: ['KOREKTA_NIEZGODNA', 'KOREKTA_NIESPRAWDZONA'] } } })).toBe(0)
    expect((await db.return.findUniqueOrThrow({ where: { id: r1 } })).lastError).toBeNull()

    // osobna faktura dla drugiego przypadku (zablokowałby drugą korektę tej samej)
    const a = await product(db, 'A148-P2', 10, { wfirmaGoodId: '502' })
    const { id: o2, lines } = await wydaneWfirma([{ productId: a, qty: 2 }])
    const r2 = await createReturn(db, o2, [{ orderLineId: lines[0]!.id, qty: 1 }], { reason: 'odstapienie', now: at(5 * M) })
    await db.return.update({ where: { id: r2 }, data: { invoiceDocId: '7002' } })
    const rl = await db.returnLine.findMany({ where: { returnId: r2 } })
    await receiveReturn(db, r2, Object.fromEntries(rl.map((l) => [l.id, 'NA_STAN' as const])), { now: at(5 * M + S) })
    const wf2 = new AtrapaWfirmyKorekt([{ id: '95', goodId: '502', count: 2 }])
    wf2.kontrola = 'BLAD'
    await requestCorrection(db, r2, { now: at(6 * M) })
    expect(await issueCorrection(db, r2, new KorektyWfirmaZapis(wf2, db, { zapis: wf2.zapis }), { now: at(7 * M) })).toBe('WYSTAWIONA')
    expect(await db.return.findUniqueOrThrow({ where: { id: r2 } })).toMatchObject({ status: 'ZAKONCZONY', correctionDocId: '8001', lastError: expect.stringMatching(/nie udało się jej odczytać/) })
    expect(await db.alert.count({ where: { kind: 'KOREKTA_NIESPRAWDZONA' } })).toBe(1)
    expect(wf.zapisy.length + wf2.zapisy.length).toBe(2)
  })

  it('faktury nie ma w wFirmie (błąd bez ponawiania) = błąd korekty z alertem, bez pętli niewiadomej i bez zapisu', async () => {
    const { zwrot, wf, korekty } = await przygotuj()
    const r1 = await zwrot(1, 1)
    await requestCorrection(db, r1, { now: at(3 * M) })
    wf.fakturaBlad = new SourceError('wFirma invoices/get/7001: NOT FOUND', false)
    expect(await issueCorrection(db, r1, korekty, { now: at(4 * M) })).toBe('BLAD')
    expect(await db.return.findUniqueOrThrow({ where: { id: r1 } })).toMatchObject({ correctionState: 'FAILED', lastError: expect.stringMatching(/sprawdź, czy faktura istnieje/) })
    expect(await db.alert.count({ where: { kind: 'KOREKTA_BLAD' } })).toBe(1)
    // błąd przejściowy (5xx po ponowieniach) dalej jak niewiadoma: find po prefiksie, bez zapisu
    await db.return.update({ where: { id: r1 }, data: { correctionState: null } })
    wf.fakturaBlad = new SourceError('wFirma invoices/get/7001: HTTP 503', true)
    expect(await issueCorrection(db, r1, korekty, { now: at(5 * M) })).toBe('TIMEOUT')
    expect(wf.zapisy).toHaveLength(0)
  })

  it('po niewiadomej bez znalezionej korekty karta ostrzega przed dublem przy „poza Kompletorem”', async () => {
    const { zwrot } = await przygotuj()
    const r1 = await zwrot(1, 1)
    await requestCorrection(db, r1, { now: at(3 * M) })
    await db.return.update({ where: { id: r1 }, data: { correctionTry: 1, lastError: 'timeout: korekty nie znaleziono po 3 próbach' } })
    expect((await kartaZwrotu(db, r1))!.korekta).toMatchObject({ recznie: true, ostrzezenie: expect.stringMatching(/czy ta korekta już nie istnieje/) })
  })

  it('kolejka przy prawdziwym zapisie (tylkoPraca) nie woła korekty dla zamówienia konta w podglądzie; po przełączeniu konta woła raz', async () => {
    const { zwrot } = await przygotuj()
    const r1 = await zwrot(1, 1)
    await requestCorrection(db, r1, { now: at(3 * M) })
    await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'CIEN' } })
    const wywolania: string[] = []
    const atrapa = {
      issueCorrection: async (req: { idExternal: string }) => {
        wywolania.push(req.idExternal)
        return { kind: 'ERROR' as const, message: 'atrapa' }
      },
      findCorrectionsByPrefix: async () => [],
    }
    await runWfirmaQueue(db, { korekty: atrapa }, { now: at(4 * M), tylkoPraca: true })
    expect(wywolania).toEqual([])
    await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })
    await runWfirmaQueue(db, { korekty: atrapa }, { now: at(5 * M), tylkoPraca: true })
    expect(wywolania).toEqual([`zwrot/${r1}/1`])
  })
})

describe('wyłącznik „Korekty faktur przy zwrotach z Kompletora” (osobne GO na pierwszą korektę)', () => {
  it('wymaga wystawiania faktur i wFirmy; wyłączenie faktur wyłącza korekty; formularz bez pola nie zmienia ustawienia', async () => {
    const { dokumentyZFormularza, programyDoWyboru, UstawieniaDokumentowError, widokDokumentow, zapiszDokumentySprzedazy } = await import('@/lib/dokumenty/zapis')
    const { defaultRegistry } = await import('@/lib/adaptery/domyslne')
    const programy = programyDoWyboru(defaultRegistry().list())
    const form = (pola: Record<string, string>) => {
      const f = new FormData()
      for (const [k, v] of Object.entries({ program: 'wfirma', wystawiajPrzy: 'SPAKOWANE', rodzaj: 'faktura', seriaKod: '', seriaWzor: '', seriaReset: 'ROK', wysylkaNazwa: 'Wysyłka', wysylkaStawka: '23', podstawaZwolnienia: '', ...pola })) f.set(k, v)
      return dokumentyZFormularza(f)
    }
    await expect(zapiszDokumentySprzedazy(db, { zrodlo: null, dokumenty: form({ korektyWlaczonePole: 'tak', korektyWlaczone: 'tak' }) }, 'u', programy)).rejects.toThrow(UstawieniaDokumentowError)
    await zapiszDokumentySprzedazy(db, { zrodlo: null, dokumenty: form({ fakturyWlaczonePole: 'tak', fakturyWlaczone: 'tak', korektyWlaczonePole: 'tak', korektyWlaczone: 'tak' }) }, 'u', programy)
    expect((await widokDokumentow(db)).korektyWlaczone).toBe(true)
    await zapiszDokumentySprzedazy(db, { zrodlo: null, dokumenty: form({}) }, 'u', programy)
    expect((await widokDokumentow(db)).korektyWlaczone).toBe(true)
    await zapiszDokumentySprzedazy(db, { zrodlo: null, dokumenty: form({ fakturyWlaczonePole: 'tak' }) }, 'u', programy)
    expect((await widokDokumentow(db)).korektyWlaczone).toBe(false)
  })
})

describe('firma bez BaseLinkera i bez wFirmy (demo): zwrot na stan od początku do końca', () => {
  it('konto ręczne, stan Kompletora, program „brak”: zgłoszenie, odbiór, stan wraca, karta i lista z licznikami', async () => {
    await stanKompletora()
    await ustawFaktury({ program: 'brak' })
    const a = await product(db, 'DEMO-1', 2)
    const { id, lines } = await wydaneKompletor([{ productId: a, qty: 2 }], { channel: 'RECZNE' })
    expect((await stockOf(db, a)).physical).toBe(0)
    const rid = await createReturn(db, id, [{ orderLineId: lines[0]!.id, qty: 2 }], { reason: 'pomylka', actorId: 'user:demo' })
    const { zwrotyPanel } = await import('@/lib/panel/zwroty')
    expect((await zwrotyPanel(db, 'wlasne')).ownByStatus).toMatchObject({ ZGLOSZONY: 1, ZAKONCZONY: 0 })
    await receiveReturn(db, rid, 'NA_STAN', { actorId: 'user:demo' })
    expect(await stockOf(db, a)).toMatchObject({ physical: 2, available: 2 })
    const d = await zwrotyPanel(db, 'wlasne', { status: 'ZAKONCZONY' })
    expect(d.own.map((r) => r.id)).toEqual([rid])
    expect(d.ownByStatus).toMatchObject({ ZGLOSZONY: 0, ZAKONCZONY: 1 })
    expect((await kartaZwrotu(db, rid))!.status).toBe('ZAKONCZONY')
    await expectInvariants(db)
  })
})

// Nagrana odpowiedź GET /order/customer-returns (struktura z dokumentacji Allegro), dane kupującego zastąpione
// fikcyjnymi: parser ich nie przepuszcza, test pilnuje, żeby nie trafiły do wyniku.
const NAGRANE_ZWROTY = {
  customerReturns: [
    {
      id: 'a1b2c3d4-0000-4000-8000-000000000001',
      createdAt: '2026-10-16T09:00:00.000Z',
      buyer: { email: 'kupujacy@example.invalid', login: 'kupujacy_testowy' },
      items: [{ offerId: 'OF-148-1', quantity: 1, name: 'Przyprawa testowa', type: 'QUANTITY', reason: { type: 'DAMAGED', userComment: 'pudełko zgniecione, tel. 600100200' } }],
      referenceNumber: 'ZWR-TEST-1',
      orderId: 'ORDER-PLACEHOLDER',
      parcels: [{ waybill: 'TEST000000001', carrierId: 'ALLEGRO' }],
      status: 'DELIVERED',
    },
    { id: '', orderId: 'X', items: [] },
    { id: 'a1b2c3d4-0000-4000-8000-000000000002', orderId: 'ORDER-NIE-MA', items: [{ offerId: 'OF-X', quantity: 1, reason: { type: 'DONT_LIKE_IT' } }], status: 'CREATED' },
  ],
  count: 3,
}

describe('zwroty klientów z Allegro (customer-returns, tylko odczyt)', () => {
  it('parser: bez danych kupującego; zły zwrot do nieczytelnych, reszta strony idzie', () => {
    const { items, unreadable } = allegroReturnsFromApi(NAGRANE_ZWROTY.customerReturns)
    expect(items).toHaveLength(2)
    expect(unreadable).toEqual(['zwrot Allegro bez poprawnego id'])
    const json = JSON.stringify(items)
    for (const zakazane of ['kupujacy', '600100200', 'TEST000000001', 'zgniecione', 'ZWR-TEST']) expect(json).not.toContain(zakazane)
    expect(items[0]).toMatchObject({ externalId: 'a1b2c3d4-0000-4000-8000-000000000001', status: 'DELIVERED', lines: [{ offerId: 'OF-148-1', qty: 1, reasonType: 'DAMAGED' }] })
  })

  it('zwrot zakłada się raz w statusie „Nowe” z zamówieniem i powodem; drugi odczyt bez dubla; zamówienie spoza Kompletora = alert na koncie Aktywnym', async () => {
    await stanKompletora()
    await db.channelConfig.updateMany({ where: { channel: 'ALLEGRO', channelAccountId: 'allegro' }, data: { statusMode: 'PRACA' } })
    const a = await product(db, 'A148-AL', 5)
    await offer(db, 'ALLEGRO', 'OF-148-1', a)
    const { id } = await wydaneKompletor([{ offerExternalId: 'OF-148-1', qty: 2 }], { channel: 'ALLEGRO' })
    const o = await db.order.findUniqueOrThrow({ where: { id } })
    const strona = JSON.parse(JSON.stringify(NAGRANE_ZWROTY).replace('ORDER-PLACEHOLDER', o.externalId)) as typeof NAGRANE_ZWROTY
    const { items } = allegroReturnsFromApi(strona.customerReturns)
    const reader: ReturnReader = { listCustomerReturns: async (_od: Date, kursor: string | null) => ({ items: kursor ? [] : items, unreadable: [], nextCursor: kursor ? null : null }) }
    const acc = { channel: 'ALLEGRO' as const, channelAccountId: 'allegro' }
    const s1 = await wczytajZwroty(db, acc, reader, { praca: true, od: T0, now: at(M) })
    expect(s1).toMatchObject({ przeczytane: 2, nowe: 1, pominiete: 1 })
    const r = await db.return.findFirstOrThrow({ where: { source: 'ALLEGRO' }, include: { lines: true } })
    expect(r).toMatchObject({ orderId: id, status: 'ZGLOSZONY', kind: 'ZWROT', reason: 'uszkodzony', externalId: 'a1b2c3d4-0000-4000-8000-000000000001' })
    expect(r.lines.map((l) => l.qty)).toEqual([1])
    expect(await db.alert.count({ where: { kind: 'ZWROT_KANALU' } })).toBe(1)
    const s2 = await wczytajZwroty(db, acc, reader, { praca: true, od: T0, now: at(2 * M) })
    expect(s2).toMatchObject({ nowe: 0, juzByly: 1 })
    expect(await db.return.count({ where: { source: 'ALLEGRO' } })).toBe(1)
    expect(await db.alert.count({ where: { kind: 'ZWROT_KANALU' } })).toBe(1) // ten sam klucz: jeden alert
    // ten sam numer naraz z rdzenia (dwa przebiegi): istniejący zwrot, bez dubla
    const ol = await db.orderLine.findFirstOrThrow({ where: { orderId: id } })
    expect(await createReturn(db, id, [{ orderLineId: ol.id, qty: 1 }], { zrodlo: { source: 'ALLEGRO', externalId: r.externalId! } })).toBe(r.id)
  })

  it('konto w podglądzie: zwrot z zamówieniem też się zakłada, ale bez alertów o pominiętych', async () => {
    await stanKompletora()
    const zwroty: ChannelReturn[] = [{ externalId: 'zw-nie-ma', orderExternalId: 'NIE-MA', createdAt: null, status: null, lines: [{ offerId: 'X', qty: 1, reasonType: null }] }]
    expect(await przyjmijZwrotyKanalu(db, { channel: 'ALLEGRO', channelAccountId: 'allegro' }, zwroty, { praca: false })).toMatchObject({ pominiete: 1 })
    expect(await db.alert.count()).toBe(0)
  })
})

describe('zdjęcie zwrotu (osłona uploadu)', () => {
  it('zapis po ponownym kodowaniu, odczyt tylko w swojej firmie; SVG odrzucone', async () => {
    await stanKompletora()
    const a = await product(db, 'A148-Z', 2)
    const { id, lines } = await wydaneKompletor([{ productId: a, qty: 1 }])
    const rid = await createReturn(db, id, [{ orderLineId: lines[0]!.id, qty: 1 }], { reason: 'nie_pasuje' })
    const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 200, g: 10, b: 10 } } }).png().toBuffer()
    const z = await przygotujZdjecieZwrotu(new File([new Uint8Array(png)], 'zdj.png', { type: 'image/png' }))
    expect(z!.mime).toBe('image/jpeg')
    await zapiszZdjecieZwrotu(db, rid, z!)
    expect((await zdjecieZwrotu(db, rid))!.content.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    const b = testDb({ organizationId: ORG_B })
    expect(await zdjecieZwrotu(b, rid)).toBeNull()
    await b.$disconnect()
    await expect(przygotujZdjecieZwrotu(new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'a.png', { type: 'image/png' }))).rejects.toThrow(ZdjecieZwrotuError)
    expect(await przygotujZdjecieZwrotu(null)).toBeNull()
  })
})
