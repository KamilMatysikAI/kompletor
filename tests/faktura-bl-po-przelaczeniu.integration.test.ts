// zamówienie z fakturą z BaseLinkera na koncie w trybie pracy (po przełączeniu). Kończy je BaseLinker:
// pakowanie w Kompletorze wstrzymane, chyba że osoba świadomie zdecyduje „Pakuj mimo faktury z BaseLinkera” (towar
// dodany po fakturze). Faktura BL zobaczona po przełączeniu przy zamówieniu w kolejce = alert, który zamyka
// się sam; konto w podglądzie i firma bez BL bez zmian. Odczyt numerów ze sklepu padający ponad dobę = alert raz na
// dobę. Dane fikcyjne, bez połączeń.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { alertNumerowSklepu, FAKTURY_BL_NUMERY_SKLEPU } from '@/lib/cien/faktury-bl'
import {
  FAKTURA_BL_I_KOMPLETORA,
  FAKTURA_BL_TOWAR_W_PRACY,
  FAKTURA_BL_W_KOLEJCE,
  PAKUJ_MIMO_FAKTURY_BL,
  PakujMimoError,
  pakujMimoFakturyBl,
  samonaprawaPoFakturzeBl,
  zamknijNieaktualneAlertyFakturyBl,
  zamowieniaZFakturaBl,
} from '@/lib/rdzen/faktura-bl'
import { filtryZ, SORT_DOMYSLNY, stronaListy } from '@/lib/panel/zamowienia-lista'
import { applyBlInvoice, packOrder, PackError } from '@/lib/rdzen/rozchod'
import { moveOrder } from '@/lib/rdzen/przejscia'
import { cancelOrder, ingestOrder } from '@/lib/rdzen/zamowienia'
import { handlers } from '@/lib/worker/zadania'
import { buildDailyReport, renderDailyReport } from '@/lib/cien/raport-dzienny'
import { ORG_A, testDb, truncateAll } from './db'
import { expectInvariants, order, product, seedBase } from './rdzen-fixtures'

const db = testDb()
afterAll(() => db.$disconnect())

const D = (iso: string) => new Date(iso)
const doPracy = () => db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
})

async function przyjmij(lines: { productId: string; qty: number }[], blOrderId: number | null, at = D('2026-11-19T07:00:00Z')): Promise<string> {
  const id = (await ingestOrder(db, order(lines, { createdAtChannel: at }), { now: at })).orderId!
  if (blOrderId !== null) await db.order.update({ where: { id }, data: { blOrderId } })
  return id
}

describe('faktura BL po przełączeniu, zamówienie w kolejce pakowania', () => {
  it('rezerwacje zużyte, jeden alert z procedurą, pakowanie wstrzymane; „Pakuj mimo” zdejmuje blokadę i zamyka alert', async () => {
    const x = await product(db, 'T-X', 5, { wfirmaGoodId: 'G-X' })
    const o = await przyjmij([{ productId: x, qty: 2 }], 7001)
    await doPracy()
    await applyBlInvoice(db, o, 'FV 70/11', { [x]: 2 }, { now: D('2026-11-19T09:00:00Z') })
    expect(await db.reservation.count({ where: { orderId: o, state: 'ACTIVE' } })).toBe(0)
    const al = await db.alert.findMany({ where: { kind: FAKTURA_BL_W_KOLEJCE } })
    expect(al).toHaveLength(1)
    expect(al[0]!.ref).toBe(o)
    expect(al[0]!.message).toContain('FV 70/11')
    // (runda 2): treść prawdziwa także dla faktury sprzed przełączenia rozliczonej po nim
    expect(al[0]!.message).toContain('rozliczoną w Kompletorze po przełączeniu')
    expect(al[0]!.message).toContain('„Więcej” → „Zmień status…” → „Do wyjaśnienia”')
    expect(al[0]!.message).toContain('„Pakuj mimo faktury z BaseLinkera”')
    // ta sama faktura drugi raz: bez drugiego alertu
    await applyBlInvoice(db, o, 'FV 70/11', { [x]: 2 }, { now: D('2026-11-19T09:02:00Z') })
    expect(await db.alert.count({ where: { kind: FAKTURA_BL_W_KOLEJCE } })).toBe(1)
    await expect(packOrder(db, o, { now: D('2026-11-19T09:05:00Z') })).rejects.toThrow(/fakturę FV 70\/11 wystawioną w BaseLinkerze/)
    expect(await pakujMimoFakturyBl(db, o, { actorId: 'user:t', now: D('2026-11-19T09:10:00Z') })).toBe(true)
    expect(await pakujMimoFakturyBl(db, o, { actorId: 'user:t' })).toBe(false) // powtórka bez zmian
    expect(await db.orderEvent.count({ where: { orderId: o, kind: PAKUJ_MIMO_FAKTURY_BL } })).toBe(1)
    expect(await db.alert.count({ where: { kind: FAKTURA_BL_W_KOLEJCE, closedAt: null } })).toBe(0)
    // blokada zdjęta: zostaje zwykła odmowa (cały towar wyszedł z fakturą BL)
    await expect(packOrder(db, o, { now: D('2026-11-19T09:11:00Z') })).rejects.toThrow(/Nic do spakowania/)
    await expectInvariants(db)
  })

  it('towar dodany po fakturze: pakowanie dopiero po świadomej decyzji, potem zwykłe spakowanie', async () => {
    const x = await product(db, 'T-X', 5, { wfirmaGoodId: 'G-X' })
    const o = await przyjmij([{ productId: x, qty: 1 }], 7002)
    await doPracy()
    // faktura BL objęła wcześniej inny towar (ślad w historii), rezerwacja na dodany towar aktywna
    await db.orderEvent.create({ data: { orderId: o, kind: 'FAKTURA_BL', actorId: 'system:cien-bl', data: { docId: 'FV 71/11' } } })
    await expect(packOrder(db, o)).rejects.toBeInstanceOf(PackError)
    expect((await db.order.findUniqueOrThrow({ where: { id: o } })).status).toBe('DO_REALIZACJI')
    await pakujMimoFakturyBl(db, o, { actorId: 'user:t' })
    expect(await packOrder(db, o)).toMatchObject({ status: 'SPAKOWANE' })
  })

  it('zamówienie wyszło z kolejki („Do wyjaśnienia”): alert zamyka się sam, klucz zdjęty pod nowy epizod', async () => {
    const x = await product(db, 'T-X', 5, { wfirmaGoodId: 'G-X' })
    const o = await przyjmij([{ productId: x, qty: 1 }], 7003)
    await doPracy()
    await applyBlInvoice(db, o, 'FV 72/11', { [x]: 1 }, { now: D('2026-11-19T09:00:00Z') })
    expect(await zamknijNieaktualneAlertyFakturyBl(db, D('2026-11-19T09:01:00Z'))).toBe(0) // nadal w kolejce
    await db.order.update({ where: { id: o }, data: { status: 'DO_WYJASNIENIA' } })
    expect(await zamknijNieaktualneAlertyFakturyBl(db, D('2026-11-19T09:02:00Z'))).toBe(1)
    expect(await db.alert.findFirstOrThrow({ where: { kind: FAKTURA_BL_W_KOLEJCE } })).toMatchObject({ dedupeKey: null })
    expect(await zamknijNieaktualneAlertyFakturyBl(db, D('2026-11-19T09:03:00Z'))).toBe(0) // powtórka
  })

  it('bez tokenu BaseLinkera: przebieg „rdzen-wygasanie” zamyka alert po anulowaniu zamówienia z kolejki', async () => {
    const x = await product(db, 'T-X2', 5, { wfirmaGoodId: 'G-X2' })
    const o = await przyjmij([{ productId: x, qty: 1 }], 7004)
    await doPracy()
    await applyBlInvoice(db, o, 'FV 73/11', { [x]: 1 }, { now: D('2026-11-19T09:00:00Z') })
    await handlers['rdzen-wygasanie']!(db, null, { organizationId: ORG_A, secrets: { env: {}, envFallback: false } })
    expect(await db.alert.count({ where: { kind: FAKTURA_BL_W_KOLEJCE, closedAt: null } })).toBe(1) // nadal w kolejce
    await cancelOrder(db, o, { now: D('2026-11-19T09:05:00Z') })
    await handlers['rdzen-wygasanie']!(db, null, { organizationId: ORG_A, secrets: { env: {}, envFallback: false } })
    expect(await db.alert.count({ where: { kind: FAKTURA_BL_W_KOLEJCE, closedAt: null } })).toBe(0)
    await expectInvariants(db)
  })

  it('konto w podglądzie: faktura BL bez alertu, pakowanie bez blokady (zachowanie sprzed zmiany)', async () => {
    const x = await product(db, 'T-X', 5, { wfirmaGoodId: 'G-X' })
    const o = await przyjmij([{ productId: x, qty: 1 }], 7004)
    const o2 = await przyjmij([{ productId: x, qty: 1 }], 7005)
    await applyBlInvoice(db, o, 'FV 73/11', { [x]: 1 }, { now: D('2026-11-19T09:00:00Z') })
    expect(await db.alert.count({ where: { kind: FAKTURA_BL_W_KOLEJCE } })).toBe(0)
    await db.orderEvent.create({ data: { orderId: o2, kind: 'FAKTURA_BL', actorId: 'system:cien-bl', data: { docId: 'FV 74/11' } } })
    expect(await packOrder(db, o2)).toMatchObject({ status: 'SPAKOWANE' })
  })

  it('firma bez BaseLinkera w trybie pracy: pakowanie bez zmian, brak zamówień z fakturą BL', async () => {
    const x = await product(db, 'T-X', 5)
    const o = await przyjmij([{ productId: x, qty: 1 }], null)
    await doPracy()
    expect((await zamowieniaZFakturaBl(db, [await db.order.findUniqueOrThrow({ where: { id: o } })])).size).toBe(0)
    expect(await packOrder(db, o)).toMatchObject({ status: 'SPAKOWANE' })
    expect(await db.alert.count()).toBe(0)
  })

  it('zamowieniaZFakturaBl: po kopii faktury i po zamówieniu głównym; korekta się nie liczy; flaga „Pakuj mimo” wyklucza', async () => {
    const x = await product(db, 'T-X', 5)
    const a = await przyjmij([{ productId: x, qty: 1 }], 7101)
    const b = await przyjmij([{ productId: x, qty: 1 }], 7102)
    const c = await przyjmij([{ productId: x, qty: 1 }], null)
    await db.order.update({ where: { id: c }, data: { parentOrderId: a } })
    const t = D('2026-11-18T10:00:00Z')
    await db.blInvoiceSnapshot.create({ data: { blInvoiceId: 1, blOrderId: 7101, number: 'FV 1', externalNumber: 'FV 1/W', kind: 'normal', dateAdd: t, fetchedAt: t } })
    await db.blInvoiceSnapshot.create({ data: { blInvoiceId: 2, blOrderId: 7102, number: 'KOR 1', kind: 'correcting', dateAdd: t, fetchedAt: t } })
    const m = await zamowieniaZFakturaBl(db, await db.order.findMany({ where: { id: { in: [a, b, c] } } }))
    expect(Object.fromEntries(m)).toEqual({ [a]: 'FV 1/W', [c]: 'FV 1/W' })
    await db.order.update({ where: { id: c }, data: { flags: { pakujMimoFakturyBl: true } } })
    expect([...(await zamowieniaZFakturaBl(db, await db.order.findMany({ where: { id: { in: [a, b, c] } } }))).keys()]).toEqual([a])
  })
})

describe('„Pakuj mimo faktury z BaseLinkera” przy nierozliczonej fakturze i paczce dodatkowej', () => {
  it('kopia faktury bez rozliczenia + odłożony towar: odmowa; po rozliczeniu towar z faktury zdjęty raz, bez drugiego wydania', async () => {
    const x = await product(db, 'T-W1', 5, { wfirmaGoodId: 'G-W1' })
    const o = await przyjmij([{ productId: x, qty: 2 }], 7301)
    await doPracy()
    const t = D('2026-11-19T09:00:00Z')
    // faktura wystawiona w BL, kopia jest, WZ do niej jeszcze nie ma (applyBlInvoice nie było): rezerwacja ACTIVE na towar z faktury
    await db.blInvoiceSnapshot.create({ data: { blInvoiceId: 7301, blOrderId: 7301, number: 'FV 90/11', kind: 'normal', dateAdd: t, fetchedAt: t } })
    await expect(packOrder(db, o, { now: t })).rejects.toThrow(/FV 90\/11 wystawioną w BaseLinkerze/)
    await expect(pakujMimoFakturyBl(db, o, { actorId: 'user:t', now: t })).rejects.toBeInstanceOf(PakujMimoError)
    await expect(pakujMimoFakturyBl(db, o, { actorId: 'user:t', now: t })).rejects.toThrow(/czeka jeszcze na dokument WZ/)
    expect(await db.orderEvent.count({ where: { orderId: o, kind: PAKUJ_MIMO_FAKTURY_BL } })).toBe(0)
    await expect(packOrder(db, o, { now: t })).rejects.toBeInstanceOf(PackError) // blokada stoi, „Wyślij bez faktury” niedostępne
    expect(await db.pendingMovement.count({ where: { orderId: o } })).toBe(0)

    // WZ do faktury BL przyszedł: rozliczenie zdejmuje towar z faktury jeden raz
    await applyBlInvoice(db, o, 'FV 90/11', { [x]: 2 }, { now: D('2026-11-19T09:30:00Z') })
    // po rozliczeniu odblokowanie przechodzi, ale towaru z faktury nie ma już czego pakować ani wysyłać drugi raz
    // (towar dodany po fakturze: test „towar dodany po fakturze” wyżej; dodanie pozycji z karty po fakturze jest zablokowane)
    expect(await pakujMimoFakturyBl(db, o, { actorId: 'user:t', now: D('2026-11-19T09:45:00Z') })).toBe(true)
    await expect(packOrder(db, o, { now: D('2026-11-19T09:50:00Z') })).rejects.toThrow(/Nic do spakowania/)
    // towar z faktury zdjęty raz: jeden ruch faktury BL (−2), żadnego „wydane bez dokumentu”, pod który poszedłby WZ z Kompletora
    expect(await db.pendingMovement.findMany({ where: { orderId: o }, select: { productId: true, type: true, delta: true } })).toEqual([{ productId: x, type: 'BL_INVOICE', delta: -2 }])
    await expectInvariants(db)
  })

  it('sama usługa (e-book) z kopią faktury, bez rezerwacji: odblokowanie przechodzi jak dotąd', async () => {
    const ebook = (await db.product.create({ data: { sku: 'EB-W1', kind: 'DIGITAL', unit: 'SZT', nameAccounting: 'E-book W1', title: 'E-book W1', vatRate: '5' } })).id
    const o = await przyjmij([{ productId: ebook, qty: 1 }], 7302)
    await doPracy()
    const t = D('2026-11-19T09:00:00Z')
    await db.blInvoiceSnapshot.create({ data: { blInvoiceId: 7302, blOrderId: 7302, number: 'FV 91/11', kind: 'normal', dateAdd: t, fetchedAt: t } })
    expect(await pakujMimoFakturyBl(db, o, { actorId: 'user:t', now: t })).toBe(true)
  })

  it('paczka dodatkowa zamówienia z fakturą BL: pakowanie z osobnym komunikatem, „Pakuj mimo” odmawia', async () => {
    const x = await product(db, 'T-W1P', 5, { wfirmaGoodId: 'G-W1P' })
    const glowne = await przyjmij([{ productId: x, qty: 1 }], 7303)
    const paczka = await przyjmij([{ productId: x, qty: 1 }], null)
    await db.order.update({ where: { id: paczka }, data: { parentOrderId: glowne } })
    await doPracy()
    await applyBlInvoice(db, glowne, 'FV 92/11', { [x]: 2 }, { now: D('2026-11-19T09:00:00Z') })
    await expect(packOrder(db, paczka)).rejects.toThrow(/To paczka dodatkowa zamówienia z fakturą FV 92\/11/)
    await expect(pakujMimoFakturyBl(db, paczka, { actorId: 'user:t' })).rejects.toThrow(/paczka dodatkowa/)
    expect(await db.orderEvent.count({ where: { orderId: paczka, kind: PAKUJ_MIMO_FAKTURY_BL } })).toBe(0)
    expect((await db.order.findUniqueOrThrow({ where: { id: paczka } })).status).toBe('DO_REALIZACJI')
  })
})

describe('faktura BL po przełączeniu przy zamówieniu już spakowanym albo zafakturowanym w Kompletorze', () => {
  it('spakowane bez faktury z Kompletora: osobny alert (paczka z Kompletora, dokument z BaseLinkera), „Do wysyłki” zamyka go', async () => {
    const x = await product(db, 'T-SP', 5, { wfirmaGoodId: 'G-SP' })
    const o = await przyjmij([{ productId: x, qty: 2 }], 7401)
    await doPracy()
    expect(await packOrder(db, o, { now: D('2026-11-19T08:00:00Z') })).toMatchObject({ status: 'SPAKOWANE' })
    await applyBlInvoice(db, o, 'FV 74/11', { [x]: 2 }, { now: D('2026-11-19T08:01:00Z') })
    expect(await db.reservation.count({ where: { orderId: o, state: 'ACTIVE' } })).toBe(0)
    const al = await db.alert.findMany({ where: { kind: FAKTURA_BL_W_KOLEJCE, ref: o } })
    expect(al).toHaveLength(1)
    expect(al[0]!.message).toContain('FV 74/11')
    expect(al[0]!.message).toContain('Paczka wychodzi z Kompletora, dokumentem sprzedaży jest faktura z BaseLinkera')
    expect(al[0]!.message).toContain('„Do wysyłki”')
    expect(await db.alert.count({ where: { kind: FAKTURA_BL_I_KOMPLETORA } })).toBe(0)
    // powtórka faktury: bez drugiego alertu; przebieg zamykania nie zamyka alertu, dopóki zamówienie jest spakowane
    await applyBlInvoice(db, o, 'FV 74/11', { [x]: 2 }, { now: D('2026-11-19T08:03:00Z') })
    expect(await zamknijNieaktualneAlertyFakturyBl(db, D('2026-11-19T08:04:00Z'))).toBe(0)
    expect(await db.alert.count({ where: { kind: FAKTURA_BL_W_KOLEJCE, ref: o, closedAt: null } })).toBe(1)
    // „Do wysyłki” dostępne (faktura BL zużyła rezerwacje), potem alert się zamyka
    await moveOrder(db, o, 'DO_WYSLANIA', { now: D('2026-11-19T08:05:00Z') })
    expect(await zamknijNieaktualneAlertyFakturyBl(db, D('2026-11-19T08:06:00Z'))).toBe(1)
    expect(await db.pendingMovement.findMany({ where: { orderId: o }, select: { type: true, delta: true } })).toEqual([{ type: 'BL_INVOICE', delta: -2 }])
    await expectInvariants(db)
  })

  it('faktura z Kompletora w toku albo wystawiona: alert o dwóch fakturach (nie zamyka się sam), bez alertu kolejki', async () => {
    const x = await product(db, 'T-DW', 5, { wfirmaGoodId: 'G-DW' })
    const o = await przyjmij([{ productId: x, qty: 1 }], 7402)
    await doPracy()
    await packOrder(db, o, { now: D('2026-11-19T08:00:00Z') })
    await db.invoiceAttempt.create({ data: { orderId: o, packageNo: 1, attemptNo: 1, idExternal: `${o}/1/1`, state: 'ISSUED' } })
    await applyBlInvoice(db, o, 'FV 75/11', { [x]: 1 }, { now: D('2026-11-19T08:10:00Z') })
    const al = await db.alert.findMany({ where: { kind: FAKTURA_BL_I_KOMPLETORA, ref: o } })
    expect(al).toHaveLength(1)
    expect(al[0]!.message).toContain('FV 75/11')
    expect(al[0]!.message).toContain('drugi skoryguj')
    expect(await db.alert.count({ where: { kind: FAKTURA_BL_W_KOLEJCE } })).toBe(0)
    await moveOrder(db, o, 'DO_WYSLANIA', { now: D('2026-11-19T08:15:00Z') }).catch(() => undefined)
    await zamknijNieaktualneAlertyFakturyBl(db, D('2026-11-19T08:16:00Z'))
    expect(await db.alert.count({ where: { kind: FAKTURA_BL_I_KOMPLETORA, closedAt: null } })).toBe(1)
  })

  it('konto w podglądzie: spakowane i faktura BL bez alertów (bez zmian)', async () => {
    const x = await product(db, 'T-PG', 5, { wfirmaGoodId: 'G-PG' })
    const o = await przyjmij([{ productId: x, qty: 1 }], 7403)
    await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'CIEN' } })
    await packOrder(db, o, { now: D('2026-11-19T08:00:00Z') }).catch(() => undefined)
    await applyBlInvoice(db, o, 'FV 76/11', { [x]: 1 }, { now: D('2026-11-19T08:01:00Z') })
    expect(await db.alert.count({ where: { kind: { in: [FAKTURA_BL_W_KOLEJCE, FAKTURA_BL_I_KOMPLETORA] } } })).toBe(0)
  })
})

describe('wyścig: rozliczenie faktury BL równolegle ze spakowaniem', () => {
  it('× 40: zawsze jedno zdjęcie towaru (ruch faktury BL), bez rezerwacji ACTIVE; spakowane albo wstrzymane z alertem, nigdy oba', async () => {
    const x = await product(db, 'T-WY', 40, { wfirmaGoodId: 'G-WY' })
    await doPracy()
    for (let i = 0; i < 40; i++) {
      const t = new Date(D('2026-11-19T08:00:00Z').getTime() + i * 60_000)
      const o = await przyjmij([{ productId: x, qty: 1 }], 7500 + i, t)
      const [fv, pak] = await Promise.allSettled([applyBlInvoice(db, o, `FV ${i}/WY`, { [x]: 1 }, { now: t }), packOrder(db, o, { now: t })])
      expect(fv.status).toBe('fulfilled')
      if (pak.status === 'rejected') expect(pak.reason).toBeInstanceOf(PackError)
      const z = await db.order.findUniqueOrThrow({ where: { id: o } })
      const al = await db.alert.findMany({ where: { kind: FAKTURA_BL_W_KOLEJCE, ref: o } })
      expect(al).toHaveLength(1)
      if (pak.status === 'fulfilled') {
        expect(z.status).toBe('SPAKOWANE') // spakowane przed fakturą: faktura rozlicza rezerwację, alert „już spakowane”
        expect(al[0]!.message).toContain('jest już spakowane w Kompletorze')
      } else {
        expect(z.status).toBe('DO_REALIZACJI') // faktura pierwsza: pakowanie wstrzymane, alert dla biura
        expect(al[0]!.message).toContain('czeka w kolejce pakowania')
      }
      expect(await db.reservation.count({ where: { orderId: o, state: 'ACTIVE' } })).toBe(0)
      expect(await db.pendingMovement.findMany({ where: { orderId: o }, select: { type: true, delta: true } })).toEqual([{ type: 'BL_INVOICE', delta: -1 }])
    }
    await expectInvariants(db)
  }, 120_000)
})

describe('lista zamówień: znaczniki po fakturze BL', () => {
  it('konto w podglądzie bez znaczników; to samo zamówienie po przełączeniu konta: „kończy BaseLinker” i „sprawdź, czy towar dojechał”', async () => {
    const x = await product(db, 'T-L', 0, { wfirmaGoodId: 'G-L' }) // stan 0: zamówienie czeka na dostawę
    const o = await przyjmij([{ productId: x, qty: 1 }], 7401)
    await applyBlInvoice(db, o, 'FV 93/11', { [x]: 1 }, { now: D('2026-11-19T09:00:00Z') }) // brak rozliczony fakturą BL
    expect(await db.shortage.count({ where: { orderId: o, resolvedBy: 'system:faktura-bl' } })).toBe(1)
    const wiersz = async () => (await stronaListy(db, filtryZ({ widok: 'wszystkie' }), { sort: SORT_DOMYSLNY, pomin: 0, ile: 50 })).wiersze.find((w) => w.id === o)!
    const podglad = await wiersz()
    expect(podglad.towarPoFakturzeBl).toBeUndefined()
    expect(podglad.fakturaBl).toBeUndefined()
    await doPracy()
    expect(await wiersz()).toMatchObject({ towarPoFakturzeBl: true, fakturaBl: 'FV 93/11' })
  })

  it('konto bez konfiguracji: znaczniki jak w trybie pracy (ten sam warunek co odmowa pakowania w rdzeniu)', async () => {
    const x = await product(db, 'T-LK', 5, { wfirmaGoodId: 'G-LK' })
    const o = await przyjmij([{ productId: x, qty: 1 }], 7402)
    await db.channelConfig.deleteMany({ where: { channel: 'WOO', channelAccountId: 'sd' } })
    await applyBlInvoice(db, o, 'FV 94/11', { [x]: 1 }, { now: D('2026-11-19T09:00:00Z') })
    const w = (await stronaListy(db, filtryZ({ widok: 'wszystkie' }), { sort: SORT_DOMYSLNY, pomin: 0, ile: 50 })).wiersze.find((r) => r.id === o)!
    expect(w.fakturaBl).toBe('FV 94/11')
    await expect(packOrder(db, o, { now: D('2026-11-19T09:05:00Z') })).rejects.toBeInstanceOf(PackError)
  })
})

describe('alert o towarze po fakturze BL w trybie pracy', () => {
  it('powtórka nie liczy zgłoszeń; alert zamyka się po anulowaniu zamówienia', async () => {
    const x = await product(db, 'T-X', 3, { wfirmaGoodId: 'G-X' })
    const b = await przyjmij([{ productId: x, qty: 1 }], 7201)
    await db.orderEvent.create({ data: { orderId: b, kind: 'FAKTURA_BL', actorId: 'system:cien-bl', data: { docId: 'FV 80/11' } } })
    await doPracy()
    expect(await samonaprawaPoFakturzeBl(db, { now: D('2026-11-20T12:00:00Z') })).toMatchObject({ zgloszonych: 1 })
    expect(await samonaprawaPoFakturzeBl(db, { now: D('2026-11-20T12:05:00Z') })).toMatchObject({ zgloszonych: 0, alertowZamknietych: 0 })
    await cancelOrder(db, b, { now: D('2026-11-20T12:10:00Z') })
    expect(await samonaprawaPoFakturzeBl(db, { now: D('2026-11-20T12:15:00Z') })).toMatchObject({ zgloszonych: 0, alertowZamknietych: 1 })
    expect(await db.alert.count({ where: { kind: FAKTURA_BL_TOWAR_W_PRACY, closedAt: null } })).toBe(0)
  })

  it('(runda 2): po „Pakuj mimo…” alert o towarze zamyka się od razu i samonaprawa nie zgłasza go ponownie', async () => {
    const x = await product(db, 'T-D7', 3, { wfirmaGoodId: 'G-D7' })
    const b = await przyjmij([{ productId: x, qty: 1 }], 7202)
    await db.orderEvent.create({ data: { orderId: b, kind: 'FAKTURA_BL', actorId: 'system:cien-bl', data: { docId: 'FV 81/11' } } })
    await doPracy()
    expect(await samonaprawaPoFakturzeBl(db, { now: D('2026-11-20T12:00:00Z') })).toMatchObject({ zgloszonych: 1 })
    expect(await pakujMimoFakturyBl(db, b, { actorId: 'user:t', now: D('2026-11-20T12:05:00Z') })).toBe(true)
    expect(await db.alert.count({ where: { kind: FAKTURA_BL_TOWAR_W_PRACY, closedAt: null } })).toBe(0)
    expect(await samonaprawaPoFakturzeBl(db, { now: D('2026-11-20T12:10:00Z') })).toMatchObject({ zgloszonych: 0 })
    expect(await zamknijNieaktualneAlertyFakturyBl(db, D('2026-11-20T12:11:00Z'))).toBe(0)
    expect(await db.alert.count({ where: { kind: FAKTURA_BL_TOWAR_W_PRACY, closedAt: null } })).toBe(0)
  })
})

describe('odczyt numerów ze sklepu pada', () => {
  const najstarsza = D('2026-11-18T08:00:00Z')
  it('alert raz na dobę z liczbami, bez alertu dla świeżych faktur, zamyka się po udanym odczycie', async () => {
    const t1 = D('2026-11-19T10:00:00Z')
    expect(await alertNumerowSklepu(db, { now: t1, numbersRead: 1, numbersFailed: 1, czekajace: 4, najstarsza })).toBe('ZGLOSZONY')
    expect(await alertNumerowSklepu(db, { now: D('2026-11-19T10:02:00Z'), numbersRead: 1, numbersFailed: 1, czekajace: 4, najstarsza })).toBe('BEZ_ZMIAN')
    const a = await db.alert.findFirstOrThrow({ where: { kind: FAKTURY_BL_NUMERY_SKLEPU } })
    expect(a.message).toContain('odczyty: 1, nieudane: 1')
    expect(a.message).toContain('Czeka 4 faktur, najstarsza od 26 h')
    // świeża faktura (poniżej doby) przy błędzie: bez nowego alertu, stary zamknięty
    expect(await alertNumerowSklepu(db, { now: t1, numbersRead: 1, numbersFailed: 1, czekajace: 1, najstarsza: D('2026-11-19T08:00:00Z') })).toBe('ZAMKNIETY')
    expect(await db.alert.count({ where: { kind: FAKTURY_BL_NUMERY_SKLEPU, closedAt: null } })).toBe(0)
    // kolejny dzień: nowy alert; udany odczyt zamyka
    expect(await alertNumerowSklepu(db, { now: D('2026-11-20T10:00:00Z'), numbersRead: 1, numbersFailed: 1, czekajace: 4, najstarsza })).toBe('ZGLOSZONY')
    expect(await alertNumerowSklepu(db, { now: D('2026-11-20T10:05:00Z'), numbersRead: 3, numbersFailed: 0, czekajace: 4, najstarsza })).toBe('ZAMKNIETY')
    expect(await db.alert.count({ where: { kind: FAKTURY_BL_NUMERY_SKLEPU, closedAt: null } })).toBe(0)
  })

  it('trwała awaria przez 3 doby: jedno otwarte zgłoszenie (nowe zamyka starsze); po zamknięciu nowe dopiero po dobie od poprzedniego', async () => {
    const stan = { numbersRead: 1, numbersFailed: 1, czekajace: 2, najstarsza: D('2026-11-15T08:00:00Z') }
    expect(await alertNumerowSklepu(db, { now: D('2026-11-17T23:00:00Z'), ...stan })).toBe('ZGLOSZONY')
    // północ w Warszawie: nowy dzień kalendarzowy, ale nie minęła doba od zgłoszenia
    expect(await alertNumerowSklepu(db, { now: D('2026-11-18T00:30:00Z'), ...stan })).toBe('BEZ_ZMIAN')
    expect(await alertNumerowSklepu(db, { now: D('2026-11-18T23:01:00Z'), ...stan })).toBe('ZGLOSZONY')
    expect(await alertNumerowSklepu(db, { now: D('2026-11-19T23:02:00Z'), ...stan })).toBe('ZGLOSZONY')
    expect(await db.alert.count({ where: { kind: FAKTURY_BL_NUMERY_SKLEPU } })).toBe(3)
    expect(await db.alert.count({ where: { kind: FAKTURY_BL_NUMERY_SKLEPU, closedAt: null } })).toBe(1)
    // udany odczyt zamyka; awaria wraca tego samego dnia: bez nowego zgłoszenia przed upływem doby
    expect(await alertNumerowSklepu(db, { now: D('2026-11-20T08:00:00Z'), ...stan, numbersFailed: 0 })).toBe('ZAMKNIETY')
    expect(await alertNumerowSklepu(db, { now: D('2026-11-20T09:00:00Z'), ...stan })).toBe('BEZ_ZMIAN')
    expect(await alertNumerowSklepu(db, { now: D('2026-11-20T23:03:00Z'), ...stan })).toBe('ZGLOSZONY')
    expect(await db.alert.count({ where: { kind: FAKTURY_BL_NUMERY_SKLEPU, closedAt: null } })).toBe(1)
  })

  it('raport dzienny: faktury BL bez zamówienia z wiekiem najstarszej, otwarty alert numerów, samonaprawa dnia', async () => {
    const now = D('2026-11-20T09:00:00Z')
    await db.blInvoiceSnapshot.create({ data: { blInvoiceId: 9101, blOrderId: 99101, number: 'FV 91/11', kind: 'normal', dateAdd: najstarsza, fetchedAt: najstarsza } })
    await db.blInvoiceSnapshot.create({ data: { blInvoiceId: 9102, blOrderId: 99102, number: 'FV 92/11', kind: 'normal', dateAdd: now, fetchedAt: now, lastError: 'odłożona ręcznie' } })
    expect(await alertNumerowSklepu(db, { now, numbersRead: 2, numbersFailed: 2, czekajace: 1, najstarsza })).toBe('ZGLOSZONY')
    const r = await buildDailyReport(db, '2026-11-19', now)
    expect(r.blInvoiceRepair).toEqual({ withoutPair: 1, oldestWithoutPairHours: 49, healedOrders: 0, numbersAlertOpen: true })
    const md = renderDailyReport(r)
    expect(md).toContain('Faktury BL bez zamówienia w Kompletorze: 1 (najstarsza od 49 h)')
    expect(md).toContain('**nie działa**')
  })
})
