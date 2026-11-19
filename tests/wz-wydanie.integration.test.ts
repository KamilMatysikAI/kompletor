// WZ w programie przy wysyłce bez faktury (wyłącznik firmy `faktury.wzBezFaktury`, zdolność `wz` dostawcy
// dokumentów). Program to atrapa w pamięci — zero zapisów do prawdziwej wFirmy.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { PackError, packOrder, potwierdzDokumentWystawiony, shipWithoutInvoice } from '@/lib/rdzen/rozchod'
import { PROBA_PRZETERMINOWANA_MS, referencjaWz, wystawWzDlaWydanych } from '@/lib/rdzen/wz-wydanie'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { dostawcaDokumentow } from '@/lib/dokumenty/dostawcy'
import { dokumentyZFormularza, programyDoWyboru, widokDokumentow, zapiszUstawieniaDokumentow } from '@/lib/dokumenty/zapis'
import type { WzIssueResult, WzWfirma } from '@/lib/wfirma/wz'
import type { PrismaClient } from '@prisma/client'
import { testDb, truncateAll } from './db'
import { expectInvariants, order, product, seedBase, T0 } from './rdzen-fixtures'

const db = testDb()
afterAll(() => db.$disconnect())

type Next = WzIssueResult['kind'] | 'TIMEOUT_AFTER_CREATE' | 'THROW'

class FakeWzWfirma implements WzWfirma {
  docs: { docId: string; idExternal: string; number: string; lines: { wfirmaGoodId: string; count: number }[]; warehouseId: string }[] = []
  next: Next[] = []
  calls: string[] = []
  /** Program ignorujący filtr po referencji (jak wFirma z pustym `id_external`): oddaje wszystkie WZ. */
  ignoreFilter = false
  /** program bez numeru dokumentu w odpowiedzi. */
  noNumber = false
  async issueWz(r: { idExternal: string; warehouseId: string; lines: { wfirmaGoodId: string; count: number }[] }): Promise<WzIssueResult> {
    this.calls.push(`issue ${r.idExternal}`)
    const k = this.next.shift() ?? 'OK'
    if (k === 'THROW') throw new Error('przerwane połączenie')
    if (k === 'ERROR') return { kind: 'ERROR', message: 'towar nie istnieje w magazynie' }
    if (k === 'LIMIT') return { kind: 'LIMIT', message: 'TOTAL REQUESTS LIMIT EXCEEDED' }
    if (k === 'TIMEOUT') return { kind: 'TIMEOUT' }
    const doc = { docId: String(500 + this.docs.length), idExternal: r.idExternal, number: `WZ ${this.docs.length + 1}/6/11/26`, lines: r.lines, warehouseId: r.warehouseId }
    this.docs.push(doc)
    return k === 'TIMEOUT_AFTER_CREATE' ? { kind: 'TIMEOUT' } : { kind: 'OK', docId: doc.docId, number: this.noNumber ? null : doc.number }
  }
  async findWzByExternal(idExternal: string) {
    this.calls.push(`find ${idExternal}`)
    return this.docs.filter((d) => this.ignoreFilter || d.idExternal === idExternal).map((d) => ({ docId: d.docId, idExternal: d.idExternal, number: d.number }))
  }
}

let wz: FakeWzWfirma
beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  wz = new FakeWzWfirma()
})

async function shippedWithoutInvoice(sku = 'A', goodId: string | null = '700'): Promise<{ orderId: string; p: string }> {
  const p = await product(db, sku, 10, { wfirmaGoodId: goodId ?? undefined })
  const r = await ingestOrder(db, order([{ productId: p, qty: 2 }]), { now: T0 })
  await packOrder(db, r.orderId!, { now: T0 })
  await shipWithoutInvoice(db, r.orderId!, { now: T0 })
  return { orderId: r.orderId!, p }
}
// (wariant a): WZ wymaga też „Wystawiaj faktury z Kompletora”
// chwila włączenia WZ (`wzBezFakturyOd`); domyślnie T0, wysyłki w testach też w T0
const wlacz = (on: boolean, faktury = true, wzOd: Date | null = T0) =>
  db.organization.updateMany({ data: { settings: { faktury: { program: 'wfirma', wzBezFaktury: on, fakturyWlaczone: faktury, fakturyWlaczoneOd: T0.toISOString(), ...(wzOd ? { wzBezFakturyOd: wzOd.toISOString() } : {}) } } } })
const zWz = () => dostawcaDokumentow('wfirma', { wfirma: { wz } })

describe('WZ przy wysyłce bez faktury', () => {
  it('ustawienie z ekranu „Dokumenty sprzedaży”: włączone tylko z wFirmą, zapis i odczyt widoku, wyłączenie zapisuje false', async () => {
    const form = (over: Record<string, string>) => {
      const f = new FormData()
      for (const [k, x] of Object.entries({ program: 'wfirma', wystawiajPrzy: 'SPAKOWANE', rodzaj: 'faktura', wysylkaStawka: '23', ...over })) f.set(k, x)
      return dokumentyZFormularza(f)
    }
    const lista = programyDoWyboru([])
    expect((await widokDokumentow(db)).wzBezFaktury).toBe(false)
    await zapiszUstawieniaDokumentow(db, form({}), 'u1', lista)
    expect(JSON.stringify((await db.organization.findFirstOrThrow()).settings)).not.toContain('wzBezFaktury')
    // przełącznik aktywny (adapter zapisu WZ podłączony), ale tylko razem z „Wystawiaj faktury z Kompletora”
    expect((await widokDokumentow(db)).wzBezFakturyNiedostepne).toBeNull()
    await expect(zapiszUstawieniaDokumentow(db, form({ wzBezFaktury: 'tak' }), 'u1', lista)).rejects.toThrow(/wymaga włączonego „Wystawiaj faktury z Kompletora”/)
    await zapiszUstawieniaDokumentow(db, form({ wzBezFaktury: 'tak', fakturyWlaczonePole: 'tak', fakturyWlaczone: 'tak' }), 'u1', lista)
    expect((await widokDokumentow(db)).wzBezFaktury).toBe(true)
    // chwila włączenia WZ zapisana przy włączeniu, bez zmiany przy kolejnym zapisie z włączonym WZ, znika przy wyłączeniu
    const fakturyUst = async () => ((await db.organization.findFirstOrThrow()).settings as { faktury: { wzBezFakturyOd?: string } }).faktury
    const od1 = (await fakturyUst()).wzBezFakturyOd
    expect(od1).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    const historia = await db.auditLog.count({ where: { entity: 'Organization.faktury' } })
    await zapiszUstawieniaDokumentow(db, form({ wzBezFaktury: 'tak', fakturyWlaczonePole: 'tak', fakturyWlaczone: 'tak' }), 'u1', lista)
    expect((await fakturyUst()).wzBezFakturyOd).toBe(od1)
    expect(await db.auditLog.count({ where: { entity: 'Organization.faktury' } })).toBe(historia)
    await zapiszUstawieniaDokumentow(db, form({ fakturyWlaczonePole: 'tak' }), 'u1', lista)
    expect((await widokDokumentow(db)).wzBezFaktury).toBe(false)
    expect((await fakturyUst()).wzBezFakturyOd).toBeUndefined()
    // ustawienie zapisane wcześniej (np. ręcznie) zostaje odczytane, a zapis formularza bez pola je wyłącza
    await wlacz(true)
    expect((await widokDokumentow(db)).wzBezFaktury).toBe(true)
    await zapiszUstawieniaDokumentow(db, form({}), 'u1', lista)
    expect((await widokDokumentow(db)).wzBezFaktury).toBe(false)
    await expect(zapiszUstawieniaDokumentow(db, form({ program: 'brak', wzBezFaktury: 'tak' }), 'u1', lista)).rejects.toThrow(/tylko z programem wFirma/)
  })

  it('wyłącznik firmy wyłączony (domyślnie): nic nie idzie do programu, ruch zostaje do ręcznego zamknięcia', async () => {
    await shippedWithoutInvoice()
    const s = await wystawWzDlaWydanych(db, zWz(), { now: T0 })
    expect(s.skipped).toMatch(/wyłączone/)
    expect(wz.calls).toEqual([])
    expect(await db.pendingMovement.findFirstOrThrow()).toMatchObject({ state: 'MANUAL' })
  })

  it('„Wystawiaj faktury z Kompletora” wyłączone: nic nie idzie do programu mimo włączonego WZ', async () => {
    await shippedWithoutInvoice()
    await wlacz(true, false)
    const s = await wystawWzDlaWydanych(db, zWz(), { now: T0 })
    expect(s.skipped).toMatch(/faktur z Kompletora wyłączone/)
    expect(wz.calls).toEqual([])
  })

  it('program bez zdolności WZ (wFirma bez adaptera zapisu): pominięte z powodem', async () => {
    await shippedWithoutInvoice()
    await wlacz(true)
    const s = await wystawWzDlaWydanych(db, dostawcaDokumentow('wfirma'), { now: T0 })
    expect(s.skipped).toMatch(/nie umie WZ/)
  })

  it('włączone: WZ z towarem i ilością, ruch APPLIED z numerem, alert zamknięty, odczyt stanu zlecony; powtórka bez drugiego WZ', async () => {
    const { orderId, p } = await shippedWithoutInvoice()
    await wlacz(true)
    expect(await db.alert.count({ where: { kind: 'WYDANE_BEZ_DOKUMENTU', closedAt: null } })).toBe(1)
    const s = await wystawWzDlaWydanych(db, zWz(), { now: T0 })
    expect(s).toMatchObject({ issued: 1, errors: 0 })
    expect(wz.docs).toEqual([expect.objectContaining({ idExternal: referencjaWz(orderId, 1), lines: [{ wfirmaGoodId: '700', count: 2 }], warehouseId: '999001' })])
    expect(await db.pendingMovement.findFirstOrThrow({ where: { orderId } })).toMatchObject({ state: 'APPLIED', wzQty: 2, wfirmaDocId: 'WZ 1/6/11/26' })
    expect(await db.alert.count({ where: { kind: 'WYDANE_BEZ_DOKUMENTU', closedAt: null } })).toBe(0)
    expect(await db.outboxEvent.count({ where: { kind: 'WFIRMA_READ', productId: p } })).toBeGreaterThan(0)
    expect(await db.orderEvent.count({ where: { orderId, kind: 'WZ_WYSTAWIONE' } })).toBe(1)
    await expectInvariants(db)
    const s2 = await wystawWzDlaWydanych(db, zWz(), { now: T0 })
    expect(s2.issued + s2.found).toBe(0)
    expect(wz.docs).toHaveLength(1)
  })

  it('program oddaje obce WZ mimo filtra po referencji — obcy dokument nie zamyka ruchu, WZ wystawione dla tej wysyłki; dwa z tą samą referencją = błąd', async () => {
    const first = await shippedWithoutInvoice('A', '700')
    await wlacz(true)
    expect(await wystawWzDlaWydanych(db, zWz(), { now: T0 })).toMatchObject({ issued: 1 })
    const second = await shippedWithoutInvoice('B', '701')
    wz.ignoreFilter = true
    const s = await wystawWzDlaWydanych(db, zWz(), { now: T0 })
    expect(s).toMatchObject({ issued: 1, found: 0, errors: 0 })
    expect(wz.docs.map((d) => d.idExternal)).toEqual([referencjaWz(first.orderId, 1), referencjaWz(second.orderId, 1)])
    expect(await db.pendingMovement.findFirstOrThrow({ where: { orderId: second.orderId } })).toMatchObject({ state: 'APPLIED', wfirmaDocId: 'WZ 2/6/11/26' })
    // dwa dokumenty z tą samą referencją: bez zamykania i bez wystawiania trzeciego
    const third = await shippedWithoutInvoice('C', '702')
    const ref = referencjaWz(third.orderId, 1)
    wz.docs.push({ docId: '900', idExternal: ref, number: 'WZ 90/6/11/26', lines: [], warehouseId: '999001' }, { docId: '901', idExternal: ref, number: 'WZ 91/6/11/26', lines: [], warehouseId: '999001' })
    expect(await wystawWzDlaWydanych(db, zWz(), { now: T0 })).toMatchObject({ errors: 1, issued: 0, found: 0 })
    expect(await db.pendingMovement.findFirstOrThrow({ where: { orderId: third.orderId } })).toMatchObject({ state: 'MANUAL' })
    expect(await db.alert.count({ where: { kind: 'WZ_BLAD', ref: third.orderId } })).toBe(1)
  })

  it('niejasny wynik (timeout po założeniu, przerwane połączenie): kolejny przebieg odszukuje WZ zamiast zakładać drugi', async () => {
    const { orderId } = await shippedWithoutInvoice()
    await wlacz(true)
    wz.next = ['TIMEOUT_AFTER_CREATE']
    expect(await wystawWzDlaWydanych(db, zWz(), { now: T0 })).toMatchObject({ waiting: 1, issued: 0 })
    expect(await db.pendingMovement.findFirstOrThrow({ where: { orderId } })).toMatchObject({ state: 'MANUAL' })
    expect(await wystawWzDlaWydanych(db, zWz(), { now: T0 })).toMatchObject({ found: 1 })
    expect(wz.docs).toHaveLength(1)
    expect(await db.pendingMovement.findFirstOrThrow({ where: { orderId } })).toMatchObject({ state: 'APPLIED', wfirmaDocId: 'WZ 1/6/11/26' })
    wz.next = ['THROW']
    await shippedWithoutInvoice('B', '701')
    expect(await wystawWzDlaWydanych(db, zWz(), { now: T0 })).toMatchObject({ waiting: 1 })
  })

  it('niewiadoma bez dokumentu w programie — alert WZ_NIEWIADOMA, kolejne przebiegi tylko szukają, bez drugiego wystawienia; dokument odnaleziony później zamyka alert', async () => {
    const { orderId } = await shippedWithoutInvoice()
    await wlacz(true)
    wz.next = ['TIMEOUT']
    expect(await wystawWzDlaWydanych(db, zWz(), { now: T0 })).toMatchObject({ waiting: 1 })
    expect(await db.alert.count({ where: { kind: 'WZ_NIEWIADOMA', ref: orderId, closedAt: null } })).toBe(1)
    for (let i = 0; i < 2; i++) expect(await wystawWzDlaWydanych(db, zWz(), { now: T0 })).toMatchObject({ waiting: 1, issued: 0 })
    expect(wz.calls.filter((c) => c.startsWith('issue'))).toHaveLength(1)
    expect(wz.calls.filter((c) => c.startsWith('find'))).toHaveLength(3)
    // dokument jednak powstał (program pokazał go z opóźnieniem): przebieg go znajduje i zamyka ruch oraz alert
    const ref = referencjaWz(orderId, 1)
    wz.docs.push({ docId: '777', idExternal: ref, number: 'WZ 7/8/11/26', lines: [], warehouseId: '999001' })
    expect(await wystawWzDlaWydanych(db, zWz(), { now: T0 })).toMatchObject({ found: 1 })
    expect(await db.alert.count({ where: { kind: 'WZ_NIEWIADOMA', closedAt: null } })).toBe(0)
    expect(await db.pendingMovement.findFirstOrThrow({ where: { orderId } })).toMatchObject({ state: 'APPLIED', wfirmaDocId: 'WZ 7/8/11/26' })
  })

  it('program bez numeru dokumentu — ruch dostaje `wz:<id>`, nie samo id (nie pomyli się z id faktury)', async () => {
    const { orderId } = await shippedWithoutInvoice()
    await wlacz(true)
    wz.noNumber = true
    expect(await wystawWzDlaWydanych(db, zWz(), { now: T0 })).toMatchObject({ issued: 1 })
    expect(await db.pendingMovement.findFirstOrThrow({ where: { orderId } })).toMatchObject({ state: 'APPLIED', wfirmaDocId: 'wz:500' })
  })

  it('limit wysyłek na przebieg (maxOrders)', async () => {
    await shippedWithoutInvoice('A', '700')
    await shippedWithoutInvoice('B', '701')
    await shippedWithoutInvoice('C', '702')
    await wlacz(true)
    expect(await wystawWzDlaWydanych(db, zWz(), { now: T0, maxOrders: 2 })).toMatchObject({ issued: 2 })
    expect(await wystawWzDlaWydanych(db, zWz(), { now: T0, maxOrders: 2 })).toMatchObject({ issued: 1 })
    expect(wz.docs).toHaveLength(3)
  })

  it('odmowa programu albo towar bez powiązania: ruch zostaje MANUAL, alert WZ_BLAD; limit kończy przebieg', async () => {
    await shippedWithoutInvoice('A', '700')
    await shippedWithoutInvoice('B', null)
    await wlacz(true)
    wz.next = ['ERROR']
    const s = await wystawWzDlaWydanych(db, zWz(), { now: T0 })
    expect(s).toMatchObject({ errors: 2, issued: 0 })
    expect(await db.alert.count({ where: { kind: 'WZ_BLAD', closedAt: null } })).toBe(2)
    expect(await db.pendingMovement.count({ where: { state: 'MANUAL' } })).toBe(2)
    // odrzucony dokument nie idzie ponownie (otwarty WZ_BLAD = biuro wystawia ręcznie); limit na nowej wysyłce
    await shippedWithoutInvoice('C', '702')
    wz.next = ['LIMIT']
    const s2 = await wystawWzDlaWydanych(db, zWz(), { now: T0 })
    expect(s2).toMatchObject({ waiting: 1, errors: 2 })
    expect(wz.calls.filter((c) => c.startsWith('issue'))).toEqual([expect.stringContaining('issue wz/'), expect.stringContaining('issue wz/')])
    expect(wz.calls.filter((c) => c.startsWith('find'))).toHaveLength(3)
  })

  it('wFirma oddała OK, a zamknięcie ruchów padło (awaria bazy) — kolejny przebieg kończy zapis bez drugiego wystawienia', async () => {
    const { orderId } = await shippedWithoutInvoice()
    await wlacz(true)
    // baza „pada” na pierwszej transakcji po odpowiedzi programu (zamknięcie ruchów)
    let padnij = false
    const awaria = new Proxy(db, {
      get(t, k) {
        if (k === '$transaction' && padnij) {
          padnij = false
          return () => Promise.reject(new Error('połączenie z bazą zerwane'))
        }
        const v = Reflect.get(t, k)
        return typeof v === 'function' ? v.bind(t) : v
      },
    }) as PrismaClient
    const issue = wz.issueWz.bind(wz)
    wz.issueWz = async (r) => {
      const out = await issue(r)
      padnij = true
      return out
    }
    expect(await wystawWzDlaWydanych(awaria, zWz(), { now: T0 })).toMatchObject({ issued: 0, waiting: 1 })
    expect(await db.pendingMovement.findFirstOrThrow({ where: { orderId } })).toMatchObject({ state: 'MANUAL' })
    expect(await db.wzAttempt.findFirstOrThrow()).toMatchObject({ state: 'OK', docId: '500', number: 'WZ 1/6/11/26' })
    // program nie oddaje dokumentu w wyszukiwaniu (jak wFirma bez `id_external`): bez znacznika próby poszedłby drugi WZ
    wz.findWzByExternal = async (idExternal: string) => {
      wz.calls.push(`find ${idExternal}`)
      return []
    }
    for (let i = 0; i < 2; i++) await wystawWzDlaWydanych(db, zWz(), { now: T0 })
    expect(wz.calls.filter((c) => c.startsWith('issue'))).toHaveLength(1)
    expect(wz.docs).toHaveLength(1)
    expect(await db.pendingMovement.findFirstOrThrow({ where: { orderId } })).toMatchObject({ state: 'APPLIED', wfirmaDocId: 'WZ 1/6/11/26' })
    expect(await db.alert.count({ where: { ref: orderId, closedAt: null } })).toBe(0)
    await expectInvariants(db)
  })

  it('próba wysłana, a przebieg padł przed zapisem odpowiedzi (SENDING) — bez drugiego wystawienia; po czasie alert niewiadomej', async () => {
    const { orderId } = await shippedWithoutInvoice()
    await wlacz(true)
    const ref = referencjaWz(orderId, 1)
    await db.wzAttempt.create({ data: { ref, orderId, state: 'SENDING' } })
    const proba = await db.wzAttempt.findFirstOrThrow()
    const zaraz = new Date(proba.updatedAt.getTime() + 60_000)
    expect(await wystawWzDlaWydanych(db, zWz(), { now: zaraz })).toMatchObject({ waiting: 1, issued: 0 })
    expect(await db.alert.count({ where: { kind: 'WZ_NIEWIADOMA', closedAt: null } })).toBe(0)
    const pozniej = new Date(proba.updatedAt.getTime() + PROBA_PRZETERMINOWANA_MS)
    expect(await wystawWzDlaWydanych(db, zWz(), { now: pozniej })).toMatchObject({ waiting: 1, issued: 0 })
    expect(await db.alert.findFirstOrThrow({ where: { kind: 'WZ_NIEWIADOMA', closedAt: null } })).toMatchObject({
      ref: orderId,
      message: expect.stringContaining('Zamówienia → numer zamówienia → sekcja „Dokument sprzedaży” → przycisk „Dokument wystawiony”'),
    })
    expect(await db.wzAttempt.findFirstOrThrow()).toMatchObject({ state: 'UNKNOWN' })
    expect(wz.calls.filter((c) => c.startsWith('issue'))).toEqual([])
    // dokument jednak jest w programie: znaleziony, próba OK, ruch zamknięty
    wz.docs.push({ docId: '808', idExternal: ref, number: 'WZ 8/8/11/26', lines: [], warehouseId: '999001' })
    expect(await wystawWzDlaWydanych(db, zWz(), { now: pozniej })).toMatchObject({ found: 1 })
    expect(await db.wzAttempt.findFirstOrThrow()).toMatchObject({ state: 'OK', docId: '808' })
    expect(await db.alert.count({ where: { ref: orderId, closedAt: null } })).toBe(0)
  })

  it('limit wFirmy — dokument nie powstał, kolejny przebieg wystawia (próba LIMIT nie blokuje)', async () => {
    const { orderId } = await shippedWithoutInvoice()
    await wlacz(true)
    wz.next = ['LIMIT']
    expect(await wystawWzDlaWydanych(db, zWz(), { now: T0 })).toMatchObject({ waiting: 1 })
    expect(await db.wzAttempt.findFirstOrThrow()).toMatchObject({ state: 'LIMIT' })
    expect(await wystawWzDlaWydanych(db, zWz(), { now: T0 })).toMatchObject({ issued: 1 })
    expect(await db.wzAttempt.findFirstOrThrow()).toMatchObject({ state: 'OK', attempts: 2 })
    expect(await db.pendingMovement.findFirstOrThrow({ where: { orderId } })).toMatchObject({ state: 'APPLIED' })
  })

  it('wysyłki sprzed włączenia WZ zostają biuru, nowsze dostają WZ; bez chwili włączenia nic nie idzie', async () => {
    const stara = await shippedWithoutInvoice('A', '700')
    await wlacz(true, true, null)
    expect((await wystawWzDlaWydanych(db, zWz(), { now: T0 })).skipped).toMatch(/brak chwili włączenia/)
    const wlaczoneOd = new Date(T0.getTime() + 60 * 60_000)
    await wlacz(true, true, wlaczoneOd)
    expect(await wystawWzDlaWydanych(db, zWz(), { now: wlaczoneOd })).toMatchObject({ issued: 0, found: 0, errors: 0, waiting: 0 })
    expect(wz.calls).toEqual([])
    const p = await product(db, 'B', 10, { wfirmaGoodId: '701' })
    const r = await ingestOrder(db, order([{ productId: p, qty: 1 }]), { now: wlaczoneOd })
    await packOrder(db, r.orderId!, { now: wlaczoneOd })
    await shipWithoutInvoice(db, r.orderId!, { now: new Date(wlaczoneOd.getTime() + 60_000) })
    expect(await wystawWzDlaWydanych(db, zWz(), { now: new Date(wlaczoneOd.getTime() + 120_000) })).toMatchObject({ issued: 1 })
    expect(wz.docs.map((d) => d.idExternal)).toEqual([referencjaWz(r.orderId!, 1)])
    expect(await db.pendingMovement.findFirstOrThrow({ where: { orderId: stara.orderId } })).toMatchObject({ state: 'MANUAL' })
    // alert starszej wysyłki (sprzed włączenia) prowadzi do ręcznego zamknięcia; nowszej mówił, że WZ wystawi Kompletor
    expect((await db.alert.findFirstOrThrow({ where: { kind: 'WYDANE_BEZ_DOKUMENTU', ref: stara.orderId } })).message).toMatch(/Wystaw dokument w wFirmie i kliknij „Dokument wystawiony”/)
    expect((await db.alert.findFirstOrThrow({ where: { kind: 'WYDANE_BEZ_DOKUMENTU', ref: r.orderId! } })).message).toMatch(/Kompletor wystawi dokument WZ w wFirmie/)
  })

  it('„Dokument wystawiony” po niewiadomej — ruchy APPLIED, alerty zamknięte bez klucza, wpis w historii i dzienniku; drugi raz = błąd', async () => {
    const { orderId, p } = await shippedWithoutInvoice()
    await wlacz(true)
    wz.next = ['TIMEOUT']
    await wystawWzDlaWydanych(db, zWz(), { now: T0 })
    expect(await db.alert.count({ where: { ref: orderId, closedAt: null } })).toBe(2) // WYDANE_BEZ_DOKUMENTU + WZ_NIEWIADOMA
    const later = new Date(T0.getTime() + 5 * 60_000)
    expect(await potwierdzDokumentWystawiony(db, orderId, { actorId: 'u-biuro', now: later })).toBe(1)
    expect(await db.pendingMovement.findFirstOrThrow({ where: { orderId } })).toMatchObject({ state: 'APPLIED', wzQty: 2 })
    expect(await db.alert.count({ where: { ref: orderId, closedAt: null } })).toBe(0)
    expect(await db.alert.count({ where: { ref: orderId, dedupeKey: { not: null } } })).toBe(0)
    expect(await db.orderEvent.findFirstOrThrow({ where: { orderId, kind: 'DOKUMENT_WYSTAWIONY_RECZNIE' } })).toMatchObject({ actorId: 'u-biuro' })
    expect(await db.auditLog.count({ where: { entity: 'PendingMovement', actorId: 'u-biuro' } })).toBe(1)
    expect(await db.outboxEvent.count({ where: { kind: 'WFIRMA_READ', productId: p } })).toBeGreaterThan(0)
    await expect(potwierdzDokumentWystawiony(db, orderId, { actorId: 'u-biuro', now: later })).rejects.toBeInstanceOf(PackError)
    // kolejny przebieg WZ niczego nie szuka ani nie wystawia
    const calls = wz.calls.length
    await wystawWzDlaWydanych(db, zWz(), { now: later })
    expect(wz.calls).toHaveLength(calls)
    await expectInvariants(db)
  })

  it('„Dokument wystawiony” po odmowie programu zamyka WZ_BLAD; zamówienie bez pozycji do potwierdzenia = błąd', async () => {
    const { orderId } = await shippedWithoutInvoice()
    await wlacz(true)
    wz.next = ['ERROR']
    await wystawWzDlaWydanych(db, zWz(), { now: T0 })
    expect((await db.alert.findFirstOrThrow({ where: { kind: 'WZ_BLAD', ref: orderId } })).message).toMatch(
      /wFirma odpowiedziała: towar nie istnieje w magazynie\. Wystaw dokument ręcznie w wFirmie i kliknij „Dokument wystawiony” \(Zamówienia → numer zamówienia/,
    )
    await potwierdzDokumentWystawiony(db, orderId, { actorId: 'u-biuro', now: T0 })
    expect(await db.alert.count({ where: { ref: orderId, closedAt: null } })).toBe(0)
    await expect(potwierdzDokumentWystawiony(db, 'nieistniejace', { now: T0 })).rejects.toBeInstanceOf(PackError)
  })
})
