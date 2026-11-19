// automaty BL jako reguły w kodzie — plan akcji „wysłałbym” (lib/akcje). Każda reguła: wyzwala, nie
// wyzwala, nie dubluje po drugim przebiegu; histereza niskiego stanu; kontrakt `terminAnulowania`;
// tryb SUCHO / PRACA; izolacja dwóch firm (RLS). Dane wyłącznie fikcyjne, zero połączeń zewnętrznych.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { planDnia, podgladPlanu } from '@/lib/akcje/panel'
import { POWOD_PRACA, POWOD_SUCHO, ZADANIE_PLANU } from '@/lib/akcje/reguly'
import { planujAkcje } from '@/lib/akcje/silnik'
import { formatujDate } from '@/lib/maile'
import { toWarsaw } from '@/lib/rdzen/kalendarz'
import { updatePolicy } from '@/lib/rdzen/polityka'
import { packOrder, issueInvoice } from '@/lib/rdzen/rozchod'
import { DEFAULT_WAREHOUSE } from '@/lib/rdzen/stan'
import { ingestOrder, markPaid, runReservationExpiry } from '@/lib/rdzen/zamowienia'
import { HARMONOGRAM_RDZENIA } from '@/lib/worker/harmonogram'
import { handlers } from '@/lib/worker/zadania'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { FakeWfirma, order, product, seedBase, T0 } from './rdzen-fixtures'

const a = testDb()
const b = testDb({ organizationId: ORG_B })
const sys = testSystemDb()
const NOW = new Date('2026-10-20T10:00:00Z') // wtorek

beforeEach(async () => {
  await truncateAll()
  await seedBase(a)
  await seedBase(b)
})
afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})

const plans = (db = a, rule?: string) => db.plannedAction.findMany({ where: rule ? { rule } : {}, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })

/** Opłacone zamówienie spakowane z fakturą (atrapa wFirmy: najpierw błędy z `wyniki`, potem OK). */
async function zFaktura(db = a, wyniki: ('OK' | 'ERROR' | 'LIMIT')[] = ['OK']) {
  const p = await product(db, `F-${Math.random().toString(36).slice(2, 7)}`, 10)
  const r = await ingestOrder(db, order([{ productId: p, qty: 1 }], { createdAtChannel: NOW }))
  await packOrder(db, r.orderId!, { now: NOW })
  const wf = new FakeWfirma()
  wf.next = [...wyniki]
  for (let i = 0; i < wyniki.length; i++) await issueInvoice(db, r.orderId!, wf, { now: NOW })
  return { orderId: r.orderId!, productId: p, wf }
}

describe('mail „Brak płatności” (BL 12): z przypomnienia rdzenia, kontrakt terminAnulowania', () => {
  it('przed terminem przypomnienia nic; po przypomnieniu rdzenia jeden plan z datą anulowania; drugi przebieg nic nie dokłada', async () => {
    const p = await product(a, 'N1', 5)
    const r = await ingestOrder(a, order([{ productId: p, qty: 1 }], { paymentState: 'UNPAID', paymentMethod: 'przelew', totalGross: 123.45 }))
    const o = await a.order.findUniqueOrThrow({ where: { id: r.orderId! } })
    expect(o.remindAt).not.toBeNull()
    expect((await planujAkcje(a, { now: T0 })).nowe['mail.brak-platnosci']).toBe(0)
    const at = new Date(o.remindAt!.getTime() + 60_000)
    expect((await runReservationExpiry(a, { now: at })).reminders).toBe(1)
    expect((await planujAkcje(a, { now: at })).nowe['mail.brak-platnosci']).toBe(1)
    expect((await planujAkcje(a, { now: new Date(at.getTime() + 5 * 60_000) })).nowe['mail.brak-platnosci']).toBe(0)
    const [plan] = await plans(a, 'mail.brak-platnosci')
    expect(plan).toMatchObject({ targetType: 'ZAMOWIENIE', targetId: o.id, occasion: 'PRZYPOMNIENIE', mode: 'SUCHO', state: 'PLANNED', reason: POWOD_SUCHO })
    expect(plan!.dueAt.toISOString()).toBe(at.toISOString())
    // termin zawsze z Order.reservationDeadline (polityka firmy), nie „w ciągu N dni roboczych”
    const vars = plan!.vars as Record<string, unknown>
    expect(vars.terminAnulowania).toBe(o.reservationDeadline!.toISOString())
    expect(vars).toMatchObject({ kwotaGr: 12345 })
    const pg = await podgladPlanu(a, plan!.id)
    expect(pg!.tekst).toContain(`do ${formatujDate(o.reservationDeadline!)}`)
    expect(pg!.tekst).not.toMatch(/w ciągu/)
  })

  it('termin anulowania z polityki sezonu, nie z domyślnych 5 dni', async () => {
    await updatePolicy(a, { seasonMode: true, seasonReminderBusinessDays: 1, seasonReleaseBusinessDays: 3 }, 'test')
    const p = await product(a, 'N2', 5)
    const r = await ingestOrder(a, order([{ productId: p, qty: 1 }], { paymentState: 'UNPAID', paymentMethod: 'przelew' }))
    const o = await a.order.findUniqueOrThrow({ where: { id: r.orderId! } })
    const at = new Date(o.remindAt!.getTime() + 60_000)
    await runReservationExpiry(a, { now: at })
    await planujAkcje(a, { now: at })
    const [plan] = await plans(a, 'mail.brak-platnosci')
    expect((plan!.vars as Record<string, unknown>).terminAnulowania).toBe(o.reservationDeadline!.toISOString())
    expect((plan!.vars as Record<string, unknown>).dniDoAnulowania).toBe(3)
  })

  it('bez terminu anulowania (opłacone zaraz po przypomnieniu) — SKIPPED, nigdy mail bez daty', async () => {
    const p = await product(a, 'N3', 5)
    const r = await ingestOrder(a, order([{ productId: p, qty: 1 }], { paymentState: 'UNPAID', paymentMethod: 'przelew' }))
    const o = await a.order.findUniqueOrThrow({ where: { id: r.orderId! } })
    const at = new Date(o.remindAt!.getTime() + 60_000)
    await runReservationExpiry(a, { now: at })
    await markPaid(a, o.id, 'PAID', { now: at })
    await planujAkcje(a, { now: at })
    const [plan] = await plans(a, 'mail.brak-platnosci')
    expect(plan).toMatchObject({ state: 'SKIPPED' })
    expect(plan!.reason).toMatch(/brak terminu anulowania/)
    expect((plan!.vars as Record<string, unknown>).terminAnulowania).toBeUndefined()
  })
})

describe('mail „Faktura” (BL 10): Wysłane/Odebrane z wystawioną fakturą', () => {
  it('bez faktury nic; z fakturą jeden plan; Odebrane po Wysłane i drugi przebieg nie dublują', async () => {
    const p = await product(a, 'W1', 5)
    const bez = await ingestOrder(a, order([{ productId: p, qty: 1 }]))
    await a.order.update({ where: { id: bez.orderId! }, data: { status: 'WYSLANE' } })
    const { orderId } = await zFaktura()
    expect((await planujAkcje(a, { now: NOW })).nowe['mail.faktura']).toBe(0) // spakowane, jeszcze nie wysłane
    await a.order.update({ where: { id: orderId }, data: { status: 'WYSLANE' } })
    expect((await planujAkcje(a, { now: NOW })).nowe['mail.faktura']).toBe(1)
    await a.order.update({ where: { id: orderId }, data: { status: 'ODEBRANE' } })
    expect((await planujAkcje(a, { now: NOW })).nowe['mail.faktura']).toBe(0)
    const all = await plans(a, 'mail.faktura')
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ targetId: orderId, occasion: 'FV:FV/1', state: 'PLANNED' })
    expect((all[0]!.vars as Record<string, unknown>).numerZamowienia).toMatch(/^[A-ZĄĆĘŁŃÓŚŹŻ]{2,3} T-/)
  })

  it('w cieniu faktura z BL (ruch BL_INVOICE z numerem dokumentu) też wyzwala', async () => {
    const p = await product(a, 'W2', 5)
    const r = await ingestOrder(a, order([{ productId: p, qty: 1 }]))
    await a.order.update({ where: { id: r.orderId! }, data: { status: 'WYSLANE' } })
    await a.pendingMovement.create({
      data: { productId: p, warehouseId: DEFAULT_WAREHOUSE, delta: -1, type: 'BL_INVOICE', state: 'APPLIED', sentAt: NOW, effectiveAt: NOW, wfirmaDocId: 'BL-77', orderId: r.orderId!, idempotencyKey: `bl:BL-77:${p}` },
    })
    await planujAkcje(a, { now: NOW })
    expect((await plans(a, 'mail.faktura')).map((x) => x.occasion)).toEqual(['FV:BL-77'])
  })
})

describe('podgląd akcji z danymi firmy, nie z przykładu', () => {
  async function firmaZPoczta() {
    await a.organization.updateMany({
      data: { settings: { firma: { nazwa: 'Pracownia Testowa sp. z o.o.', nip: '1111111111', adres: { ulica: 'ul. Zielona 5', kodPocztowy: '60-001', miasto: 'Poznań' }, email: 'kontakt@pracownia.example.org', emailBiura: 'biuro@pracownia.example.org' } } },
    })
    await a.mailSettings.create({
      data: { fromEmail: 'poczta@pracownia.example.org', senders: { 'WOO:sd': { nazwaSklepu: 'Pracownia Glina', odpowiedzDo: 'sklep@pracownia.example.org', odbiorAdres: ['Pracownia Glina', 'ul. Zielona 5'], odbiorGodziny: ['pon.-pt. 10:00-18:00'] } } },
    })
  }

  it('„Faktura”: sklep, stopka i numer faktury z programu jak w mailu; bez Żółwika, example.com i dopisku', async () => {
    await firmaZPoczta()
    const { orderId } = await zFaktura()
    // numer z programu do faktur (wFirma `fullnumber`); identyfikator dokumentu (FV/1 w atrapie) nie trafia do treści
    await a.invoiceAttempt.updateMany({ where: { orderId, state: 'ISSUED' }, data: { number: 'FS 24/13/11/26' } })
    await a.order.update({ where: { id: orderId }, data: { status: 'WYSLANE' } })
    await planujAkcje(a, { now: NOW })
    const [plan] = await plans(a, 'mail.faktura')
    const pg = (await podgladPlanu(a, plan!.id, {}))!
    expect(pg.temat).toBe(`Faktura FS 24/13/11/26 do zamówienia ${(plan!.vars as Record<string, string>).numerZamowienia}`)
    expect(pg.tekst).toContain('w sklepie Pracownia Glina')
    expect(pg.tekst).toContain('Pracownia Testowa sp. z o.o.')
    expect(pg.tekst).toContain('ul. Zielona 5, 60-001 Poznań')
    expect(pg.tekst).toContain('NIP 1111111111')
    expect(pg.tekst).toContain('sklep@pracownia.example.org')
    expect(pg.tekst).not.toMatch(/Żółwik|Firma Testowa|example\.com|dokument wFirmy|FV\/1/)
    expect(pg.braki).toEqual([])
    expect(pg.uwaga).toMatch(/ustawień firmy/)
  })

  it('braki: bez profilu firmy i poczty podgląd mówi, czego brakuje i gdzie to uzupełnić; faktura bez numeru i spoza Kompletora', async () => {
    const { orderId } = await zFaktura() // atrapa wFirmy nie oddaje numeru
    await a.order.update({ where: { id: orderId }, data: { status: 'WYSLANE' } })
    await planujAkcje(a, { now: NOW })
    const [plan] = await plans(a, 'mail.faktura')
    const pg = (await podgladPlanu(a, plan!.id, {}))!
    expect(pg.braki).toContain('Stopka maila nie ma adresu firmy. Uzupełnij go w Ustawienia → Dokumenty i faktury → Dane firmy.')
    expect(pg.braki).toContain('Klient nie ma adresu, na który może odpisać. Uzupełnij adres nadawcy w Ustawienia → Komunikacja i poczta → Poczta.')
    // bez numeru z programu: wariant bez numeru jak w wysyłce, informacja (nie brak), identyfikator dokumentu poza treścią
    expect(pg.braki.some((b) => b.startsWith('Program do faktur nie podał numeru tej faktury'))).toBe(false)
    expect(pg.informacje?.some((b) => b.startsWith('Program do faktur nie podał numeru tej faktury'))).toBe(true)
    const docId = (plan!.vars as Record<string, string>).wfirmaDocId!
    expect(pg.temat).toBe(`Faktura do zamówienia ${(plan!.vars as Record<string, string>).numerZamowienia}`)
    expect(pg.temat).not.toContain(docId)
    expect(pg.tekst).not.toContain(docId)
    expect(pg.tekst).not.toContain('Numer faktury')
    expect(pg.tekst).toContain('[brak: adres firmy]')
    expect(pg.tekst).not.toMatch(/Żółwik|example\.com/)
    // kopia faktury z BaseLinkera: w planie numer dokumentu, mail z Kompletora by nie wyszedł (bez PDF)
    await a.plannedAction.update({ where: { id: plan!.id }, data: { vars: { numerZamowienia: 'SD 1', wfirmaDocId: 'FS 24/13/11/26' } } })
    const bl = (await podgladPlanu(a, plan!.id, {}))!
    expect(bl.temat).toBe('Faktura FS 24/13/11/26 do zamówienia SD 1')
    expect(bl.braki.some((b) => b.startsWith('Tej faktury nie wystawił Kompletor'))).toBe(true)
  })
})

describe('mail „Błąd przy wystawianiu faktury” (BL 11)', () => {
  it('nieudana próba → plan do biura; drugi przebieg nic; próba naprawiona przed planem → SKIPPED', async () => {
    const zly = await zFaktura(a, ['ERROR'])
    await planujAkcje(a, { now: NOW })
    expect(await planujAkcje(a, { now: NOW })).toMatchObject({ nowe: { 'mail.blad-faktury': 0 } })
    const naprawiony = await zFaktura(a, ['ERROR', 'OK'])
    await planujAkcje(a, { now: NOW })
    const all = await plans(a, 'mail.blad-faktury')
    expect(all.map((x) => [x.targetId, x.state])).toEqual([
      [zly.orderId, 'PLANNED'],
      [naprawiony.orderId, 'SKIPPED'],
    ])
    expect(all[0]!.vars).toMatchObject({ adresat: 'biuro', idExternal: `${zly.orderId}/1/1` })
    expect(JSON.stringify(all[0]!.vars)).not.toContain('atrapa') // treść błędu wFirmy nie trafia do planu
    const pg = await podgladPlanu(a, all[0]!.id)
    expect(pg!.odbiorca).toBe('biuro')
  })

  it('próba odrzucona limitem wFirmy (LIMIT:) to nie błąd faktury — bez planu', async () => {
    const { orderId } = await zFaktura(a, ['LIMIT'])
    expect(await a.invoiceAttempt.count({ where: { orderId, state: 'FAILED', lastError: { startsWith: 'LIMIT:' } } })).toBe(1)
    expect((await planujAkcje(a, { now: NOW })).nowe['mail.blad-faktury']).toBe(0)
  })

  it('bez nieudanej próby nic', async () => {
    await zFaktura(a, ['OK'])
    expect((await planujAkcje(a, { now: NOW })).nowe['mail.blad-faktury']).toBe(0)
  })
})

describe('mail „Gotowe do odbioru” (BL 14)', () => {
  it('Do odbioru → jeden plan; inne statusy nic; drugi przebieg nic', async () => {
    const p = await product(a, 'O1', 5)
    const r1 = await ingestOrder(a, order([{ productId: p, qty: 1 }], { deliveryMethod: 'Odbiór osobisty' }))
    const r2 = await ingestOrder(a, order([{ productId: p, qty: 1 }], { deliveryMethod: 'Odbiór osobisty' }))
    await a.order.update({ where: { id: r1.orderId! }, data: { status: 'DO_ODBIORU' } })
    await a.order.update({ where: { id: r2.orderId! }, data: { status: 'SPAKOWANE' } })
    expect((await planujAkcje(a, { now: NOW })).nowe['mail.gotowe-do-odbioru']).toBe(1)
    expect((await planujAkcje(a, { now: NOW })).nowe['mail.gotowe-do-odbioru']).toBe(0)
    expect((await plans(a, 'mail.gotowe-do-odbioru')).map((x) => [x.targetId, x.occasion])).toEqual([[r1.orderId, 'DO_ODBIORU']])
  })
})

describe('dueAt = chwila zdarzenia, nie chwila przebiegu', () => {
  it('zaległość sprzed 2 dni (pierwszy przebieg, przestój workera) ląduje w swoim dniu, nie w „dziś”', async () => {
    const dwaDniTemu = new Date(NOW.getTime() - 2 * 86_400_000)
    const p = await product(a, 'D1', 5)
    const odbior = await ingestOrder(a, order([{ productId: p, qty: 1 }], { deliveryMethod: 'Odbiór osobisty' }))
    await a.order.update({ where: { id: odbior.orderId! }, data: { status: 'DO_ODBIORU', updatedAt: dwaDniTemu } })
    const wyslane = await ingestOrder(a, order([{ productId: p, qty: 1 }]))
    await a.order.update({ where: { id: wyslane.orderId! }, data: { status: 'WYSLANE', updatedAt: new Date(dwaDniTemu.getTime() - 3_600_000) } })
    await a.pendingMovement.create({
      data: { productId: p, warehouseId: DEFAULT_WAREHOUSE, delta: -1, type: 'BL_INVOICE', state: 'APPLIED', sentAt: dwaDniTemu, effectiveAt: dwaDniTemu, wfirmaDocId: 'BL-88', orderId: wyslane.orderId!, idempotencyKey: `bl:BL-88:${p}` },
    })
    const r = await planujAkcje(a, { now: NOW })
    expect(r.nowe).toMatchObject({ 'mail.gotowe-do-odbioru': 1, 'mail.faktura': 1 })
    const wtedy = await planDnia(a, toWarsaw(dwaDniTemu).day, NOW)
    expect(wtedy.liczby.find((l) => l.rule === 'mail.gotowe-do-odbioru')).toMatchObject({ SUCHO: 1 })
    expect(wtedy.liczby.find((l) => l.rule === 'mail.faktura')).toMatchObject({ SUCHO: 1 })
    expect((await plans(a, 'mail.faktura'))[0]!.dueAt.getTime()).toBe(dwaDniTemu.getTime()) // później z (faktura, status)
    const dzis = await planDnia(a, toWarsaw(NOW).day, NOW)
    expect(dzis.liczby.find((l) => l.rule === 'mail.gotowe-do-odbioru')).toMatchObject({ SUCHO: 0 })
    expect(dzis.liczby.find((l) => l.rule === 'mail.faktura')).toMatchObject({ SUCHO: 0 })
  })
})

describe('tryb akcji wg konta zamówienia (ChannelConfig.statusMode) i ustawienia firmy', () => {
  it('konto w PRACY: plan PLANNED z powodem „wysyłka = osobne zadanie”, nic nie wychodzi', async () => {
    await a.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })
    const p = await product(a, 'M1', 5)
    const praca = await ingestOrder(a, order([{ productId: p, qty: 1 }]))
    const cien = await ingestOrder(a, order([{ productId: p, qty: 1 }], { channel: 'WOO_LAMPY' }))
    for (const r of [praca, cien]) await a.order.update({ where: { id: r.orderId! }, data: { status: 'DO_ODBIORU' } })
    await planujAkcje(a, { now: NOW })
    const all = await plans(a)
    expect(all.find((x) => x.targetId === praca.orderId)).toMatchObject({ mode: 'PRACA', state: 'PLANNED', reason: POWOD_PRACA })
    expect(all.find((x) => x.targetId === cien.orderId)).toMatchObject({ mode: 'SUCHO', state: 'PLANNED', reason: POWOD_SUCHO })
  })
})

describe('mail o niskim stanie (P2): histereza', () => {
  async function ustawStan(productId: string, physical: number) {
    await a.stock.update({ where: { productId_warehouseId: { productId, warehouseId: DEFAULT_WAREHOUSE } }, data: { physical, wfirmaCount: physical } })
  }

  it('jeden plan na przejście poniżej progu; nowe dopiero po powrocie powyżej progu', async () => {
    const p = await product(a, 'S1', 10)
    await a.product.update({ where: { id: p }, data: { lowStockThreshold: 5 } })
    const bezProgu = await product(a, 'S2', 0) // bez progu: nigdy
    const run = async () => (await planujAkcje(a, { now: NOW })).nowe['mail.niski-stan']
    expect(await run()).toBe(0)
    await ustawStan(p, 3)
    expect(await run()).toBe(1)
    expect(await run()).toBe(0)
    await ustawStan(p, 5) // równe progowi: przejście dalej otwarte, bez nowego planu
    expect(await run()).toBe(0)
    await ustawStan(p, 2)
    expect(await run()).toBe(0)
    await ustawStan(p, 6) // powyżej progu: przejście zamknięte
    expect((await planujAkcje(a, { now: NOW })).powrotyPowyzejProgu).toBe(1)
    await ustawStan(p, 4)
    expect(await run()).toBe(1)
    const all = await plans(a, 'mail.niski-stan')
    expect(all.map((x) => [x.targetId, x.occasion, x.resolvedAt === null])).toEqual([
      [p, 'ponizej:1', false],
      [p, 'ponizej:2', true],
    ])
    expect(all[1]!.vars).toEqual({ sku: 'S1', dostepne: 4, prog: 5, adresat: 'biuro' })
    expect(all.some((x) => x.targetId === bezProgu)).toBe(false)
    expect(all[0]).toMatchObject({ targetType: 'PRODUKT', mode: 'SUCHO' })
    expect((await podgladPlanu(a, all[1]!.id))!.temat).toBe('Niski stan: S1 Towar testowy S1') // nazwa produktu jak w mailu do biura
    // zdjęty próg zamyka otwarte przejście; po ponownym progu i dalej niskim stanie — nowe przejście
    await a.product.update({ where: { id: p }, data: { lowStockThreshold: null } })
    expect((await planujAkcje(a, { now: NOW })).powrotyPowyzejProgu).toBe(1)
    await a.product.update({ where: { id: p }, data: { lowStockThreshold: 5 } })
    expect(await run()).toBe(1)
    expect((await plans(a, 'mail.niski-stan')).map((x) => x.occasion)).toEqual(['ponizej:1', 'ponizej:2', 'ponizej:3'])
  })

  it('rezerwacje liczą się do dostępnego; produkt bez wiersza stanu pomijany; tryb produktów z ustawień firmy', async () => {
    await sys.organization.update({ where: { id: ORG_A }, data: { settings: { akcje: { trybProduktow: 'PRACA' } } } })
    const p = await product(a, 'S3', 6)
    await a.product.update({ where: { id: p }, data: { lowStockThreshold: 5 } })
    const bezStanu = await a.product.create({ data: { sku: 'S4', kind: 'STOCKED', unit: 'SZT', nameAccounting: 'Towar testowy S4', title: 'Towar testowy S4', lowStockThreshold: 5 } })
    expect((await planujAkcje(a, { now: NOW })).nowe['mail.niski-stan']).toBe(0)
    await ingestOrder(a, order([{ productId: p, qty: 2 }])) // dostępne 6 - 2 = 4
    await planujAkcje(a, { now: NOW })
    const all = await plans(a, 'mail.niski-stan')
    expect(all.map((x) => x.targetId)).toEqual([p])
    expect(all[0]).toMatchObject({ mode: 'PRACA', reason: POWOD_PRACA })
    expect(all.some((x) => x.targetId === bezStanu.id)).toBe(false)
  })
})

describe('izolacja firm (RLS) i panel', () => {
  it('plan firmy A nie powstaje z danych B i nie jest widoczny w B; panel liczy tylko swoje; klient systemowy = odmowa', async () => {
    const pa = await product(a, 'WSPOLNY', 5)
    const pb = await product(b, 'WSPOLNY', 5)
    const ra = await ingestOrder(a, order([{ productId: pa, qty: 1 }]))
    const rb = await ingestOrder(b, order([{ productId: pb, qty: 1 }]))
    await a.order.update({ where: { id: ra.orderId! }, data: { status: 'DO_ODBIORU' } })
    await b.order.update({ where: { id: rb.orderId! }, data: { status: 'SPAKOWANE' } })
    await planujAkcje(b, { now: NOW })
    expect(await sys.plannedAction.count()).toBe(0)
    await planujAkcje(a, { now: NOW })
    const [pl] = await plans(a)
    expect(pl!.organizationId).toBe(ORG_A)
    expect(await b.plannedAction.count()).toBe(0)
    expect(await podgladPlanu(b, pl!.id)).toBeNull()
    const day = toWarsaw(NOW).day
    expect((await planDnia(a, day, NOW)).liczby.find((l) => l.rule === 'mail.gotowe-do-odbioru')).toMatchObject({ SUCHO: 1, PRACA: 0 })
    expect((await planDnia(a, day, NOW)).wiersze.map((w) => w.targetId)).toEqual([ra.orderId])
    expect((await planDnia(b, day, NOW)).razem).toBe(0)
    // zapis do cudzej firmy blokuje polityka RLS (WITH CHECK)
    await expect(a.plannedAction.create({ data: { organizationId: ORG_B, rule: 'mail.faktura', targetType: 'ZAMOWIENIE', targetId: 'x', occasion: 'y', mode: 'SUCHO', dueAt: NOW } })).rejects.toThrow()
    await expect(planujAkcje(sys, { now: NOW })).rejects.toThrow(/klienta firmy/)
    await expect(planDnia(sys)).rejects.toThrow(/klienta firmy/)
    await expect(podgladPlanu(sys, pl!.id)).rejects.toThrow(/klienta firmy/)
  })

  it('zmienne planu bez danych osobowych: tylko numery, kwoty, daty, SKU', async () => {
    const p = await product(a, 'D1', 5)
    const r = await ingestOrder(a, order([{ productId: p, qty: 1 }], { deliveryMethod: 'Odbiór osobisty' }))
    await a.order.update({ where: { id: r.orderId! }, data: { status: 'DO_ODBIORU' } })
    await zFaktura(a, ['ERROR'])
    await planujAkcje(a, { now: NOW })
    const keys = new Set((await plans(a)).flatMap((x) => Object.keys(x.vars as object)))
    const ALLOWED = new Set(['numerZamowienia', 'kwotaGr', 'terminAnulowania', 'dniDoAnulowania', 'wfirmaDocId', 'idExternal', 'adresat', 'kiedy', 'sku', 'dostepne', 'prog'])
    expect([...keys].filter((k) => !ALLOWED.has(k))).toEqual([])
  })
})

describe('worker: rejestracja zadania', () => {
  it(`${ZADANIE_PLANU} co 5 min w harmonogramie firmy, handler zapisuje plan klientem firmy`, async () => {
    expect(HARMONOGRAM_RDZENIA).toContainEqual({ kind: ZADANIE_PLANU, everyMs: 5 * 60_000 })
    const p = await product(a, 'H1', 5)
    const r = await ingestOrder(a, order([{ productId: p, qty: 1 }], { deliveryMethod: 'Odbiór osobisty' }))
    await a.order.update({ where: { id: r.orderId! }, data: { status: 'DO_ODBIORU' } })
    await handlers[ZADANIE_PLANU]!(a, null, { organizationId: ORG_A, secrets: { env: {} } as never })
    expect(await a.plannedAction.count()).toBe(1)
  })
})

// ───: cień — status i faktury z kopii BL ─────────────────────────────

let blSeq = 9000
/** Zamówienie sparowane z BL (Order.blOrderId) z kopią nagłówka BL o podanym statusie (albo bez kopii). */
async function zKopiaBl(opts: { statusName?: string; fetchedAt?: Date; status?: 'DO_REALIZACJI' | 'DO_ODBIORU' | 'WYSLANE'; channel?: 'WOO_SD' | 'WOO_LAMPY' } = {}) {
  const p = await product(a, `C-${Math.random().toString(36).slice(2, 7)}`, 5)
  const r = await ingestOrder(a, order([{ productId: p, qty: 1 }], { channel: opts.channel ?? 'WOO_SD', deliveryMethod: 'Odbiór osobisty' }))
  const blOrderId = ++blSeq
  const o = await a.order.update({ where: { id: r.orderId! }, data: { blOrderId, ...(opts.status ? { status: opts.status } : {}) } })
  if (opts.statusName)
    await a.blOrderSnapshot.create({
      data: { blOrderId, orderSource: 'shop', orderSourceId: '1', channel: o.channel, channelAccountId: o.channelAccountId, externalRef: o.externalId, statusId: opts.statusName.length, statusName: opts.statusName, dateAdd: T0, fetchedAt: opts.fetchedAt ?? NOW },
    })
  return { orderId: o.id, blOrderId, productId: p }
}

let fvSeq = 500
/** Kopia faktury BL (`BlInvoiceSnapshot`) rozliczona przez cień z podanym wynikiem. */
async function kopiaFaktury(z: { orderId: string; blOrderId: number }, opts: { outcome: string; dateAdd?: Date; appliedAt?: Date; kind?: string; externalNumber?: string | null }) {
  const n = ++fvSeq
  const externalNumber = opts.externalNumber === undefined ? `FV ${n}/10/2026` : opts.externalNumber
  await a.blInvoiceSnapshot.create({
    data: { blInvoiceId: n, blOrderId: z.blOrderId, number: `BL/${n}`, externalNumber, kind: opts.kind ?? 'normal', dateAdd: opts.dateAdd ?? NOW, fetchedAt: NOW, orderId: z.orderId, appliedAt: opts.appliedAt ?? NOW, outcome: opts.outcome },
  })
  return externalNumber ?? `BL/${n}`
}

const liczba = async (rule: string, at: Date) => (await planDnia(a, toWarsaw(at).day, NOW)).liczby.find((l) => l.rule === rule)

describe('cień: „Gotowe do odbioru” (BL 14) ze statusu BL', () => {
  it('kopia BL w Do odbioru → plan z dniem odczytu kopii; bez kopii nic; status z ekranu przy innym statusie BL nic', async () => {
    const dwaDniTemu = new Date(NOW.getTime() - 2 * 86_400_000)
    const bl = await zKopiaBl({ statusName: 'Do odbioru', fetchedAt: dwaDniTemu })
    await zKopiaBl() // sparowane, bez kopii BL, Order.status Do realizacji
    const ekran = await zKopiaBl({ statusName: 'Do realizacji Osobisty', status: 'DO_ODBIORU' }) // BL rozstrzyga w cieniu
    const stara = await zKopiaBl({ statusName: 'Do odbioru', fetchedAt: new Date(NOW.getTime() - 8 * 86_400_000) }) // poza oknem
    expect((await planujAkcje(a, { now: NOW })).nowe['mail.gotowe-do-odbioru']).toBe(1)
    expect((await planujAkcje(a, { now: new Date(NOW.getTime() + 5 * 60_000) })).nowe['mail.gotowe-do-odbioru']).toBe(0)
    const all = await plans(a, 'mail.gotowe-do-odbioru')
    expect(all.map((x) => [x.targetId, x.occasion, x.mode])).toEqual([[bl.orderId, 'DO_ODBIORU', 'SUCHO']])
    expect(all[0]!.dueAt.getTime()).toBe(dwaDniTemu.getTime())
    expect(await liczba('mail.gotowe-do-odbioru', dwaDniTemu)).toMatchObject({ SUCHO: 1 })
    expect(await liczba('mail.gotowe-do-odbioru', NOW)).toMatchObject({ SUCHO: 0 })
    expect(all.some((x) => [ekran.orderId, stara.orderId].includes(x.targetId))).toBe(false)
  })

  it('bez kopii BL w cieniu — jak dotąd z Order.status (zamówienie przesunięte ekranem)', async () => {
    const z = await zKopiaBl({ status: 'DO_ODBIORU' })
    await planujAkcje(a, { now: NOW })
    expect((await plans(a, 'mail.gotowe-do-odbioru')).map((x) => x.targetId)).toEqual([z.orderId])
  })

  it('konto w PRACY bez zmian: liczy się Order.status, kopia BL nie', async () => {
    await a.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })
    const nasz = await zKopiaBl({ statusName: 'Do realizacji Osobisty', status: 'DO_ODBIORU' })
    const blowy = await zKopiaBl({ statusName: 'Do odbioru' })
    await planujAkcje(a, { now: NOW })
    const all = await plans(a, 'mail.gotowe-do-odbioru')
    expect(all.map((x) => [x.targetId, x.mode])).toEqual([[nasz.orderId, 'PRACA']])
    expect(all.some((x) => x.targetId === blowy.orderId)).toBe(false)
  })
})

describe('cień: „Faktura” (BL 10) z kopii faktur BL', () => {
  it('NIC_DO_ROZLICZENIA i BEZ_STANU liczone; korekta, POZA_CIENIEM i faktura bez statusu Wysłane w BL nie', async () => {
    const nic = await zKopiaBl({ statusName: 'Wysłane' })
    const fvNic = await kopiaFaktury(nic, { outcome: 'NIC_DO_ROZLICZENIA' })
    const ebook = await zKopiaBl({ statusName: 'Odebrane' })
    const fvEbook = await kopiaFaktury(ebook, { outcome: 'BEZ_STANU', externalNumber: null })
    const korekta = await zKopiaBl({ statusName: 'Wysłane' })
    await kopiaFaktury(korekta, { outcome: 'KOREKTA', kind: 'correcting' })
    await kopiaFaktury(korekta, { outcome: 'POZA_CIENIEM' })
    const wDrodze = await zKopiaBl({ statusName: 'Do realizacji DPD' })
    await kopiaFaktury(wDrodze, { outcome: 'ZASTOSOWANA' })
    const bezKopii = await zKopiaBl() // faktura jest, statusu BL nie znamy, Order.status Do realizacji
    await kopiaFaktury(bezKopii, { outcome: 'BEZ_WZ' })
    expect((await planujAkcje(a, { now: NOW })).nowe['mail.faktura']).toBe(2)
    const all = await plans(a, 'mail.faktura')
    expect(all.map((x) => [x.targetId, x.occasion]).sort()).toEqual(
      [
        [nic.orderId, `FV:${fvNic}`],
        [ebook.orderId, `FV:${fvEbook}`],
      ].sort(),
    )
    expect(fvEbook).toMatch(/^BL\//) // bez numeru wFirmy: numer BL, jak w ruchu BL_INVOICE
    expect(all[0]!.vars).toMatchObject({ wfirmaDocId: expect.any(String) })
  })

  it('faktura sprzed 2 dni → plan w tamtym dniu; zamówienie bez zmian > 7 dni nadal dostaje plan (okno po dacie faktury)', async () => {
    const dwaDniTemu = new Date(NOW.getTime() - 2 * 86_400_000)
    const z = await zKopiaBl({ statusName: 'Wysłane' })
    await a.order.update({ where: { id: z.orderId }, data: { updatedAt: new Date(NOW.getTime() - 10 * 86_400_000) } })
    await kopiaFaktury(z, { outcome: 'ZASTOSOWANA', dateAdd: dwaDniTemu })
    const stara = await zKopiaBl({ statusName: 'Wysłane' })
    // faktura i jej rozliczenie przez cień poza oknem (okno po dateAdd albo appliedAt)
    await kopiaFaktury(stara, { outcome: 'ZASTOSOWANA', dateAdd: new Date(NOW.getTime() - 8 * 86_400_000), appliedAt: new Date(NOW.getTime() - 8 * 86_400_000) })
    expect((await planujAkcje(a, { now: NOW })).nowe['mail.faktura']).toBe(1)
    const [plan] = await plans(a, 'mail.faktura')
    expect(plan!.targetId).toBe(z.orderId)
    expect(plan!.dueAt.getTime()).toBe(dwaDniTemu.getTime())
    expect(await liczba('mail.faktura', dwaDniTemu)).toMatchObject({ SUCHO: 1 })
    expect(await liczba('mail.faktura', NOW)).toMatchObject({ SUCHO: 0 })
  })

  it('ruch BL_INVOICE i kopia tej samej faktury → jeden plan z chwilą faktury w BL; drugi przebieg nic', async () => {
    const wczoraj = new Date(NOW.getTime() - 86_400_000)
    const z = await zKopiaBl({ statusName: 'Wysłane' })
    const fv = await kopiaFaktury(z, { outcome: 'ZASTOSOWANA', dateAdd: wczoraj })
    await a.pendingMovement.create({
      data: { productId: z.productId, warehouseId: DEFAULT_WAREHOUSE, delta: -1, type: 'BL_INVOICE', state: 'APPLIED', sentAt: NOW, effectiveAt: NOW, wfirmaDocId: fv, orderId: z.orderId, idempotencyKey: `bl:${fv}:${z.productId}` },
    })
    expect((await planujAkcje(a, { now: NOW })).nowe['mail.faktura']).toBe(1)
    expect((await planujAkcje(a, { now: NOW })).nowe['mail.faktura']).toBe(0)
    const all = await plans(a, 'mail.faktura')
    expect(all.map((x) => x.occasion)).toEqual([`FV:${fv}`])
    expect(all[0]!.dueAt.getTime()).toBe(wczoraj.getTime())
  })

  it('w cieniu status BL rozstrzyga też przy ruchu BL_INVOICE: Wysłane u nas, Do realizacji w BL → nic', async () => {
    const z = await zKopiaBl({ statusName: 'Do realizacji Paczkomaty', status: 'WYSLANE' })
    await a.pendingMovement.create({
      data: { productId: z.productId, warehouseId: DEFAULT_WAREHOUSE, delta: -1, type: 'BL_INVOICE', state: 'APPLIED', sentAt: NOW, effectiveAt: NOW, wfirmaDocId: 'BL-99', orderId: z.orderId, idempotencyKey: `bl:BL-99:${z.productId}` },
    })
    expect((await planujAkcje(a, { now: NOW })).nowe['mail.faktura']).toBe(0)
  })

  it('konto w PRACY bez zmian: kopia faktury BL nie jest źródłem, status z Order.status', async () => {
    await a.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })
    const z = await zKopiaBl({ statusName: 'Wysłane', status: 'WYSLANE' })
    await kopiaFaktury(z, { outcome: 'NIC_DO_ROZLICZENIA' })
    expect((await planujAkcje(a, { now: NOW })).nowe['mail.faktura']).toBe(0)
  })
})

// ───: chwila statusu z dziennika BL, ───────────────────────

describe('cień: chwila zmiany statusu z dziennika BL', () => {
  const chwila = (z: { blOrderId: number }, at: Date, toId?: number) =>
    a.blOrderSnapshot.update({ where: { organizationId_blOrderId: { organizationId: ORG_A, blOrderId: z.blOrderId } }, data: { statusChangedAt: at, statusChangedToId: toId ?? 'Do odbioru'.length } })

  it('„Gotowe do odbioru”: dueAt = chwila z dziennika, gdy dotyczy bieżącego statusu; inaczej odczyt kopii', async () => {
    const wczoraj = new Date(NOW.getTime() - 86_400_000)
    const z = await zKopiaBl({ statusName: 'Do odbioru' })
    await chwila(z, wczoraj)
    const inny = await zKopiaBl({ statusName: 'Do odbioru' })
    await chwila(inny, wczoraj, 999) // zdarzenie innego statusu: getOrders odczytał nowszy, chwili nie znamy
    await planujAkcje(a, { now: NOW })
    const all = await plans(a, 'mail.gotowe-do-odbioru')
    expect(all.find((x) => x.targetId === z.orderId)!.dueAt).toEqual(wczoraj)
    expect(all.find((x) => x.targetId === inny.orderId)!.dueAt).toEqual(NOW)
  })

  it('„Faktura”: dueAt = później z (faktura, chwila Wysłane), nie później niż teraz; chwila przed fakturą — data faktury', async () => {
    const dwaDniTemu = new Date(NOW.getTime() - 2 * 86_400_000)
    const wczoraj = new Date(NOW.getTime() - 86_400_000)
    const po = await zKopiaBl({ statusName: 'Wysłane' })
    await kopiaFaktury(po, { outcome: 'ZASTOSOWANA', dateAdd: dwaDniTemu })
    await chwila(po, wczoraj, 'Wysłane'.length)
    const przed = await zKopiaBl({ statusName: 'Wysłane' })
    await kopiaFaktury(przed, { outcome: 'ZASTOSOWANA', dateAdd: wczoraj })
    await chwila(przed, dwaDniTemu, 'Wysłane'.length)
    const przyszla = await zKopiaBl({ statusName: 'Wysłane' })
    await kopiaFaktury(przyszla, { outcome: 'ZASTOSOWANA', dateAdd: dwaDniTemu })
    await chwila(przyszla, new Date(NOW.getTime() + 3600_000), 'Wysłane'.length) // zegar BL przed naszym
    expect((await planujAkcje(a, { now: NOW })).nowe['mail.faktura']).toBe(3)
    const all = await plans(a, 'mail.faktura')
    expect(all.find((x) => x.targetId === po.orderId)!.dueAt).toEqual(wczoraj)
    expect(all.find((x) => x.targetId === przed.orderId)!.dueAt).toEqual(wczoraj)
    expect(all.find((x) => x.targetId === przyszla.orderId)!.dueAt).toEqual(NOW)
  })

  it('wiersz już zapisany w planie się nie zmienia, gdy później przyjdzie chwila z dziennika', async () => {
    const z = await zKopiaBl({ statusName: 'Do odbioru' })
    await planujAkcje(a, { now: NOW })
    await chwila(z, new Date(NOW.getTime() - 86_400_000))
    expect((await planujAkcje(a, { now: NOW })).nowe['mail.gotowe-do-odbioru']).toBe(0)
    expect((await plans(a, 'mail.gotowe-do-odbioru'))[0]!.dueAt).toEqual(NOW)
  })
})

describe('cień: faktura poza oknem 7 dni po dacie, rozliczona w oknie', () => {
  it('faktura sprzed 9 dni rozliczona przez cień wczoraj, wysyłka dziś → plan; rozliczona też poza oknem → nic', async () => {
    const dziewiecDni = new Date(NOW.getTime() - 9 * 86_400_000)
    const z = await zKopiaBl({ statusName: 'Wysłane' })
    await kopiaFaktury(z, { outcome: 'ZASTOSOWANA', dateAdd: dziewiecDni, appliedAt: new Date(NOW.getTime() - 86_400_000) })
    const poza = await zKopiaBl({ statusName: 'Wysłane' })
    await kopiaFaktury(poza, { outcome: 'ZASTOSOWANA', dateAdd: dziewiecDni, appliedAt: dziewiecDni })
    const korekta = await zKopiaBl({ statusName: 'Wysłane' })
    await kopiaFaktury(korekta, { outcome: 'KOREKTA', kind: 'correcting', dateAdd: dziewiecDni }) // warunki kind/outcome bez zmian
    expect((await planujAkcje(a, { now: NOW })).nowe['mail.faktura']).toBe(1)
    const [plan] = await plans(a, 'mail.faktura')
    expect(plan!.targetId).toBe(z.orderId)
    // dzień planu: data faktury (bez chwili statusu z dziennika) — poza oknem panelu, liczy się w swoim dniu
    expect(plan!.dueAt).toEqual(dziewiecDni)
  })
})

describe('cień: izolacja firm dla kopii BL', () => {
  it('kopia BL firmy B w „Do odbioru” (ten sam numer BL) nie daje planu w firmie A', async () => {
    const z = await zKopiaBl() // firma A: sparowane, bez kopii BL, Order.status Do realizacji
    await b.blOrderSnapshot.create({
      data: { blOrderId: z.blOrderId, orderSource: 'shop', orderSourceId: '1', channel: 'WOO', channelAccountId: 'sd', externalRef: 'x', statusId: 5, statusName: 'Do odbioru', dateAdd: T0, fetchedAt: NOW, statusChangedAt: NOW, statusChangedToId: 5 },
    })
    await b.blInvoiceSnapshot.create({ data: { blInvoiceId: 1, blOrderId: z.blOrderId, number: 'BL/1', kind: 'normal', dateAdd: NOW, fetchedAt: NOW, orderId: z.orderId, appliedAt: NOW, outcome: 'ZASTOSOWANA' } })
    const r = await planujAkcje(a, { now: NOW })
    expect(r.nowe).toMatchObject({ 'mail.gotowe-do-odbioru': 0, 'mail.faktura': 0 })
    expect(await sys.plannedAction.count()).toBe(0)
    await planujAkcje(b, { now: NOW }) // w B brak zamówienia o tym numerze BL: też nic
    expect(await sys.plannedAction.count()).toBe(0)
  })
})
