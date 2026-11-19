// Maile do klienta o zwrotach i reklamacjach z planu akcji: „Zwrot dotarł”, „Reklamacja dotarła”, „Pieniądze
// zwrócone”. Wyłącznik firmy domyślnie wyłączony (plan bez zmian), maile tylko o zwrotach odebranych od włączenia (także
// po wyłączeniu i ponownym włączeniu), jeden plan na zwrot i zdarzenie, zwrot odrzucony bez maila „dotarł”, konto
// w podglądzie bez wysyłki, nazwy produktów z zamówienia (zestaw jako jedna pozycja). Wysyłka tylko do lokalnej atrapy
// SMTP (127.0.0.1), dane fikcyjne.
import type { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { OrderRecipient } from '@/lib/adaptery/kontrakt'
import { planDnia, podgladPlanu } from '@/lib/akcje/panel'
import { REGULY_ZWROTOW, planujAkcje } from '@/lib/akcje/silnik'
import { ustawMaileZwrotow } from '@/lib/automaty/dane'
import { rekordZOdbiorcy } from '@/lib/klienci/rekord'
import { zapiszRekordKlienta } from '@/lib/klienci/zapis'
import { zapiszUstawieniaPoczty, type WejscieUstawien } from '@/lib/poczta/ustawienia'
import { wyslijZaplanowane } from '@/lib/poczta/wysylka'
import { markShipped, readyForDispatch } from '@/lib/rdzen/przejscia'
import { packOrder } from '@/lib/rdzen/rozchod'
import { createReturn, markReturnRefunded, receiveReturn, rejectReturn } from '@/lib/rdzen/zwroty'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { ORG_A, ORG_B, testDb, truncateAll } from './db'
import { bundle, order, product, seedBase } from './rdzen-fixtures'
import { rozloz, uruchomAtrape, type Atrapa } from './smtp-atrapa'

const a = testDb()
const b = testDb({ organizationId: ORG_B })

const ENV = {
  POCZTA_WYSYLKA: '1',
  APP_ENCRYPTION_KEY: 'c'.repeat(64),
  CUSTOMER_DATA_KEYS: `1:${'1'.repeat(64)}`,
  CUSTOMER_LOOKUP_KEY: 'a'.repeat(64),
  PANEL_URL: 'https://panel.example.com',
}
const EMAIL = 'anna.testowa@example.test'
const ODBIORCA: OrderRecipient = {
  dostawa: { imieNazwisko: 'Anna Testowa', firma: null, ulica: 'ul. Fikcyjna', numerDomu: '3', numerLokalu: null, kodPocztowy: '00-001', miasto: 'Testowo', kraj: 'PL', telefon: '+48 500 000 001', email: EMAIL },
  punktOdbioru: null,
  faktura: null,
  problemy: [],
}

let atrapa: Atrapa

beforeAll(async () => {
  atrapa = await uruchomAtrape({ login: 'kompletor', haslo: 'haslo-atrapy' })
})
afterAll(async () => {
  await atrapa.zamknij()
  await a.$disconnect()
  await b.$disconnect()
})
beforeEach(async () => {
  await truncateAll()
  await seedBase(a)
  await seedBase(b)
  atrapa.maile.length = 0
  // stan Kompletora: zwrot bez programu do faktur
  for (const [db, org] of [[a, ORG_A], [b, ORG_B]] as const) {
    await db.warehouse.updateMany({ data: { stockSource: 'KOMPLETOR', wfirmaWarehouseId: null } })
    await db.channelConfig.update({ where: { organizationId_channel_channelAccountId: { organizationId: org, channel: 'WOO', channelAccountId: 'sd' } }, data: { statusMode: 'PRACA' } })
  }
})

function wejscie(): WejscieUstawien {
  return {
    enabled: true,
    host: '127.0.0.1',
    port: String(atrapa.port),
    bezpieczenstwo: 'BRAK',
    login: 'kompletor',
    haslo: 'haslo-atrapy',
    usunHaslo: false,
    fromEmail: 'poczta@example.com',
    fromName: 'Firma Testowa',
    officeEmail: 'biuro@example.com',
    nadawcy: { 'WOO:sd': { nazwaSklepu: 'Sklep Żółwik', email: 'sklep@example.com', odpowiedzDo: 'kontakt@example.com', kolor: '#2f6b3a', odbiorAdres: '', odbiorGodziny: '' } },
  }
}
const skonfiguruj = () => zapiszUstawieniaPoczty(a, wejscie(), 'osoba-testowa', ENV, new Date(Date.now() - 60_000))
const wyslij = () => wyslijZaplanowane(a, ENV, {})
const plany = (rule?: string) => a.plannedAction.findMany({ where: rule ? { rule } : { rule: { in: [...REGULY_ZWROTOW] } }, orderBy: { createdAt: 'asc' } })
/** Włączenie maili o zwrotach; `zaMs` przesuwa chwilę włączenia (np. +1 s = „po wszystkim, co już się stało”). */
const wlacz = (zaMs = 0, db: PrismaClient = a) => ustawMaileZwrotow(db, true, 'osoba-testowa', new Date(Date.now() + zaMs))
const wylacz = () => ustawMaileZwrotow(a, false, 'osoba-testowa')

/** Zamówienie wysłane z danymi klienta (jedna pozycja: produkt × 2). */
async function wyslane(db: PrismaClient = a) {
  const p = await product(db, `Z-${Math.random().toString(36).slice(2, 7)}`, 10)
  const { orderId } = await ingestOrder(db, order([{ productId: p, qty: 2 }]))
  const id = orderId!
  await zapiszRekordKlienta(db, id, rekordZOdbiorcy(ODBIORCA), { source: 'KANAL', fetchedAt: new Date(), env: ENV })
  await packOrder(db, id)
  await readyForDispatch(db, id)
  await markShipped(db, id)
  const [line] = await db.orderLine.findMany({ where: { orderId: id } })
  return { orderId: id, lineId: line!.id, productId: p }
}

/** Zamówienie wysłane z danymi klienta i zgłoszony zwrot (albo reklamacja) jednej sztuki. */
async function zgloszony(kind: 'ZWROT' | 'REKLAMACJA' = 'ZWROT', db: PrismaClient = a) {
  const o = await wyslane(db)
  const returnId = await createReturn(db, o.orderId, [{ orderLineId: o.lineId, productId: o.productId, qty: 1 }], { kind, ...(kind === 'REKLAMACJA' ? { reason: 'uszkodzony' } : {}) })
  return { orderId: o.orderId, returnId, productId: o.productId }
}
async function odebrany(kind: 'ZWROT' | 'REKLAMACJA' = 'ZWROT', db: PrismaClient = a) {
  const z = await zgloszony(kind, db)
  await receiveReturn(db, z.returnId, 'NA_STAN')
  return z
}

describe('wyłącznik firmy (domyślnie wyłączony)', () => {
  it('bez włączenia: odebrany zwrot i zwrot pieniędzy nie dają planu ani kluczy w wyniku; drugi przebieg tak samo', async () => {
    const z = await odebrany()
    await markReturnRefunded(a, z.returnId)
    const w = await planujAkcje(a)
    for (const r of REGULY_ZWROTOW) expect(Object.keys(w.nowe)).not.toContain(r)
    expect(await plany()).toHaveLength(0)
    // ekran planu akcji bez nowych wierszy liczników
    expect((await planDnia(a)).liczby.map((l) => l.rule)).not.toContain('mail.zwrot-przyjety')
    expect((await a.organization.findFirstOrThrow({ select: { settings: true } })).settings).not.toMatchObject({ akcje: { maileZwrotow: true } })
  })

  it('włączenie zapisuje ślad w dzienniku zmian i chwilę włączenia, ponowne włączenie bez zapisu; druga firma bez zmian', async () => {
    await wlacz()
    const od = ((await a.organization.findFirstOrThrow({ select: { settings: true } })).settings as { akcje: { maileZwrotowOd: string } }).akcje.maileZwrotowOd
    await wlacz(5_000)
    expect(await a.auditLog.count({ where: { entity: 'Organization.akcje.maileZwrotow' } })).toBe(1)
    // ponowne włączenie przy włączonym nie przesuwa chwili włączenia
    expect((await a.organization.findFirstOrThrow({ select: { settings: true } })).settings).toMatchObject({ akcje: { maileZwrotow: true, maileZwrotowOd: od } })
    const z = await odebrany()
    expect((await planujAkcje(a)).nowe['mail.zwrot-przyjety']).toBe(1)
    expect(Object.keys((await planujAkcje(b)).nowe)).not.toContain('mail.zwrot-przyjety')
    expect((await plany())[0]).toMatchObject({ targetId: z.orderId, occasion: `zwrot:${z.returnId}` })
    expect((await planDnia(a)).liczby.map((l) => l.rule)).toContain('mail.zwrot-pieniedzy')
  })
})

describe('włączenie nie wysyła zaległości', () => {
  it('zwrot odebrany przed włączeniem: bez planu; odebrany po włączeniu: jeden plan', async () => {
    const stary = await odebrany()
    await markReturnRefunded(a, stary.returnId)
    await wlacz(1_000)
    expect((await planujAkcje(a)).nowe).toMatchObject({ 'mail.zwrot-przyjety': 0, 'mail.reklamacja-przyjeta': 0, 'mail.zwrot-pieniedzy': 0 })
    expect(await plany()).toHaveLength(0)
    const nowy = await zgloszony()
    await receiveReturn(a, nowy.returnId, 'NA_STAN', { now: new Date(Date.now() + 2_000) })
    expect((await planujAkcje(a, { now: new Date(Date.now() + 3_000) })).nowe['mail.zwrot-przyjety']).toBe(1)
    expect((await plany()).map((p) => p.occasion)).toEqual([`zwrot:${nowy.returnId}`])
  })

  it('wyłącz, odbiór paczki, włącz: zwrot odebrany w czasie wyłączenia bez planu', async () => {
    await wlacz()
    await wylacz()
    const akcje = ((await a.organization.findFirstOrThrow({ select: { settings: true } })).settings as { akcje: Record<string, unknown> }).akcje
    expect(akcje).toMatchObject({ maileZwrotow: false })
    expect(akcje).not.toHaveProperty('maileZwrotowOd')
    await odebrany()
    await wlacz(1_000)
    expect((await planujAkcje(a, { now: new Date(Date.now() + 2_000) })).nowe['mail.zwrot-przyjety']).toBe(0)
    expect(await plany()).toHaveLength(0)
    expect(await a.auditLog.count({ where: { entity: 'Organization.akcje.maileZwrotow' } })).toBe(3)
  })

  it('plan zapisany przed wyłączeniem i ponownym włączeniem nie wychodzi', async () => {
    await wlacz()
    await skonfiguruj()
    await odebrany()
    expect((await planujAkcje(a)).nowe['mail.zwrot-przyjety']).toBe(1)
    await wylacz()
    await wlacz(1_000)
    expect((await wyslij()).sent).toBe(0)
    expect(atrapa.maile).toHaveLength(0)
    expect((await plany())[0]).toMatchObject({ state: 'SKIPPED', reason: expect.stringContaining('sprzed włączenia') })
  })
})

describe('plan: jeden mail na zwrot i zdarzenie', () => {
  it('zgłoszony zwrot (paczka w drodze) bez planu; po odbiorze jeden plan „Zwrot dotarł” w trybie pracy, drugi przebieg nic', async () => {
    await wlacz()
    const z = await zgloszony()
    expect((await planujAkcje(a)).nowe['mail.zwrot-przyjety']).toBe(0)
    await receiveReturn(a, z.returnId, 'NA_STAN')
    expect((await planujAkcje(a)).nowe['mail.zwrot-przyjety']).toBe(1)
    expect((await planujAkcje(a)).nowe['mail.zwrot-przyjety']).toBe(0)
    const [p] = await plany()
    expect(p).toMatchObject({ rule: 'mail.zwrot-przyjety', targetType: 'ZAMOWIENIE', mode: 'PRACA', state: 'PLANNED' })
    expect(Object.keys(p!.vars as object).sort()).toEqual(['numerZamowienia', 'returnId'])
  })

  it('reklamacja daje „Reklamacja dotarła”, nie „Zwrot dotarł”', async () => {
    await wlacz()
    await odebrany('REKLAMACJA')
    const w = await planujAkcje(a)
    expect(w.nowe).toMatchObject({ 'mail.reklamacja-przyjeta': 1, 'mail.zwrot-przyjety': 0, 'mail.zwrot-pieniedzy': 0 })
  })

  it('zwrot odrzucony przed odbiorem: bez planu; zwrot pieniędzy: osobny plan „Pieniądze zwrócone”, raz', async () => {
    await wlacz()
    const z = await zgloszony()
    await rejectReturn(a, z.returnId)
    expect((await planujAkcje(a)).nowe['mail.zwrot-przyjety']).toBe(0)
    const y = await odebrany()
    expect((await planujAkcje(a)).nowe).toMatchObject({ 'mail.zwrot-przyjety': 1, 'mail.zwrot-pieniedzy': 0 })
    await markReturnRefunded(a, y.returnId)
    expect((await planujAkcje(a)).nowe).toMatchObject({ 'mail.zwrot-przyjety': 0, 'mail.zwrot-pieniedzy': 1 })
    expect((await planujAkcje(a)).nowe).toMatchObject({ 'mail.zwrot-przyjety': 0, 'mail.zwrot-pieniedzy': 0 })
    expect((await plany('mail.zwrot-pieniedzy'))[0]).toMatchObject({ occasion: `pieniadze:${y.returnId}` })
  })

  it('pieniądze zwrócone przed planem: tylko „Pieniądze zwrócone”, bez „Zwrot dotarł”', async () => {
    await wlacz()
    const z = await odebrany()
    await markReturnRefunded(a, z.returnId)
    expect((await planujAkcje(a)).nowe).toMatchObject({ 'mail.zwrot-przyjety': 0, 'mail.zwrot-pieniedzy': 1 })
  })

  it('dwa zwroty jednego zamówienia: dwa plany i dwa maile', async () => {
    await wlacz()
    await skonfiguruj()
    const o = await wyslane()
    const r1 = await createReturn(a, o.orderId, [{ orderLineId: o.lineId, productId: o.productId, qty: 1 }])
    await receiveReturn(a, r1, 'NA_STAN')
    const r2 = await createReturn(a, o.orderId, [{ orderLineId: o.lineId, productId: o.productId, qty: 1 }])
    await receiveReturn(a, r2, 'NA_STAN')
    expect((await planujAkcje(a)).nowe['mail.zwrot-przyjety']).toBe(2)
    expect((await plany()).map((p) => p.occasion).sort()).toEqual([`zwrot:${r1}`, `zwrot:${r2}`].sort())
    expect((await wyslij()).sent).toBe(2)
    expect(atrapa.maile).toHaveLength(2)
  })

  it('druga firma z własnym odebranym zwrotem i wyłączonym wyłącznikiem: bez planu; pierwsza planuje tylko swój', async () => {
    await wlacz()
    const za = await odebrany()
    await odebrany('ZWROT', b)
    const wb = await planujAkcje(b)
    for (const r of REGULY_ZWROTOW) expect(Object.keys(wb.nowe)).not.toContain(r)
    expect(await b.plannedAction.count({ where: { rule: { in: [...REGULY_ZWROTOW] } } })).toBe(0)
    expect((await planujAkcje(a)).nowe['mail.zwrot-przyjety']).toBe(1)
    expect((await plany()).map((p) => p.targetId)).toEqual([za.orderId])
    // późniejsze włączenie w drugiej firmie: jej wcześniejszy zwrot bez planu, pierwsza firma bez zmian
    await wlacz(1_000, b)
    expect((await planujAkcje(b, { now: new Date(Date.now() + 2_000) })).nowe['mail.zwrot-przyjety']).toBe(0)
    expect((await planujAkcje(a)).nowe['mail.zwrot-przyjety']).toBe(0)
  })

  it('konto w podglądzie: plan „wysłałbym” (SUCHO), wysyłka nic nie wysyła', async () => {
    await wlacz()
    await skonfiguruj()
    await a.channelConfig.update({ where: { organizationId_channel_channelAccountId: { organizationId: ORG_A, channel: 'WOO', channelAccountId: 'sd' } }, data: { statusMode: 'CIEN' } })
    await odebrany()
    await planujAkcje(a)
    expect((await plany())[0]).toMatchObject({ mode: 'SUCHO' })
    expect((await wyslij()).sent).toBe(0)
    expect(atrapa.maile).toHaveLength(0)
  })
})

describe('wysyłka pocztą firmy (lokalna atrapa)', () => {
  it('„Zwrot dotarł”: mail do klienta z polskimi znakami i zwróconym produktem, bez kwot; drugi przebieg nic', async () => {
    await wlacz()
    await skonfiguruj()
    const z = await odebrany()
    await planujAkcje(a)
    expect(await wyslij()).toMatchObject({ sent: 1, failed: 0, errors: [] })
    expect(atrapa.maile).toHaveLength(1)
    const m = atrapa.maile[0]!
    expect(m.do).toEqual([EMAIL])
    const x = rozloz(m.surowy)
    expect(x.temat).toMatch(/^Zwrot do zamówienia .+ dotarł do nas$/)
    expect(x.tekst).toContain('Dzień dobry Anna,')
    expect(x.tekst).toContain('Zwrócone produkty')
    expect(x.tekst).toContain(`1 × Towar testowy ${(await a.product.findUniqueOrThrow({ where: { id: z.productId } })).sku}`)
    expect(x.tekst).toContain('Teraz sprawdzimy zwrócone produkty i damy znać, co dalej.')
    expect(x.tekst).not.toMatch(/zł|PLN/)
    expect((await plany())[0]).toMatchObject({ state: 'DONE' })
    expect((await wyslij()).sent).toBe(0)
    expect(atrapa.maile).toHaveLength(1)
  })

  it('odrzucenie po odbiorze, a przed wysyłką: mail nie wychodzi', async () => {
    await wlacz()
    await skonfiguruj()
    const z = await odebrany()
    await planujAkcje(a)
    // przy stanie Kompletora odbiór od razu kończy zwrot; odrzucenie po odbiorze (stan „Odebrane” przy programie do
    // faktur) ustawiamy wprost
    await a.return.update({ where: { id: z.returnId }, data: { status: 'ODRZUCONY' } })
    const r = await wyslij()
    expect(r.sent).toBe(0)
    expect(atrapa.maile).toHaveLength(0)
    expect((await plany())[0]).not.toMatchObject({ state: 'DONE' })
  })

  it('wyłączenie po zaplanowaniu: zaplanowany mail nie wychodzi', async () => {
    await wlacz()
    await skonfiguruj()
    await odebrany('REKLAMACJA')
    await planujAkcje(a)
    await wylacz()
    expect((await wyslij()).sent).toBe(0)
    expect(atrapa.maile).toHaveLength(0)
  })

  it('„Pieniądze zwrócone” wychodzi po zapisaniu zwrotu pieniędzy, osobno po „Zwrot dotarł”', async () => {
    await wlacz()
    await skonfiguruj()
    const z = await odebrany()
    await planujAkcje(a)
    expect((await wyslij()).sent).toBe(1)
    await markReturnRefunded(a, z.returnId)
    await planujAkcje(a)
    expect((await wyslij()).sent).toBe(1)
    const tematy = atrapa.maile.map((m) => rozloz(m.surowy).temat)
    expect(tematy[0]).toMatch(/^Zwrot do zamówienia .+ dotarł do nas$/)
    expect(tematy[1]).toMatch(/^Zwrot pieniędzy za zamówienie /)
    expect(rozloz(atrapa.maile[1]!.surowy).tekst).toContain('zwróciliśmy pieniądze za zwrócone produkty z zamówienia')
  })

  it('pieniądze zwrócone między planem a wysyłką: „Zwrot dotarł” nie wychodzi, „Pieniądze zwrócone” tak', async () => {
    await wlacz()
    await skonfiguruj()
    const z = await odebrany()
    await planujAkcje(a)
    await markReturnRefunded(a, z.returnId)
    await planujAkcje(a)
    expect((await wyslij()).sent).toBe(1)
    expect(rozloz(atrapa.maile[0]!.surowy).temat).toMatch(/^Zwrot pieniędzy za zamówienie /)
    expect((await plany('mail.zwrot-przyjety'))[0]).toMatchObject({ state: 'SKIPPED', reason: expect.stringContaining('pieniądze już zwrócone') })
  })

  it('plan wskazujący zwrot innego zamówienia: mail nie wychodzi', async () => {
    await wlacz()
    await skonfiguruj()
    const x = await odebrany()
    const y = await odebrany()
    await planujAkcje(a)
    const planX = (await plany()).find((p) => p.targetId === x.orderId)!
    await a.plannedAction.update({ where: { id: planX.id }, data: { vars: { ...(planX.vars as Record<string, string>), returnId: y.returnId } } })
    expect((await wyslij()).sent).toBe(1)
    expect(await a.plannedAction.findUniqueOrThrow({ where: { id: planX.id } })).toMatchObject({ state: 'SKIPPED', reason: expect.stringContaining('innego zamówienia') })
  })

  it('zestaw: w mailu nazwa zestawu ze sklepu i liczba zestawów, bez składników i nazw księgowych', async () => {
    await wlacz()
    await skonfiguruj()
    const s1 = await product(a, 'SKL-1', 10)
    const s2 = await product(a, 'SKL-2', 10)
    const zestaw = await bundle(a, 'ZEST-1', [
      { id: s1, qty: 1 },
      { id: s2, qty: 2 },
    ])
    const { orderId } = await ingestOrder(a, order([{ productId: zestaw, qty: 2, name: 'Zestaw prezentowy Żółwik' }]))
    const id = orderId!
    await zapiszRekordKlienta(a, id, rekordZOdbiorcy(ODBIORCA), { source: 'KANAL', fetchedAt: new Date(), env: ENV })
    await packOrder(a, id)
    await readyForDispatch(a, id)
    await markShipped(a, id)
    const [line] = await a.orderLine.findMany({ where: { orderId: id } })
    const returnId = await createReturn(a, id, [{ orderLineId: line!.id, qty: 1 }])
    await receiveReturn(a, returnId, 'NA_STAN')
    await planujAkcje(a)
    expect((await wyslij()).sent).toBe(1)
    const x = rozloz(atrapa.maile[0]!.surowy).tekst
    expect(x).toContain('1 × Zestaw prezentowy Żółwik')
    expect(x).not.toContain('Towar testowy SKL-')
    expect(x).not.toContain('Zestaw ZEST-1')
  })
})

describe('podgląd maili o zwrotach z planu na danych firmy', () => {
  it('„Zwrot dotarł”: sklep i nadawca z Poczty, zwrócony produkt jak w mailu, bez imienia i adresu klienta', async () => {
    await wlacz()
    await skonfiguruj()
    const z = await odebrany()
    await planujAkcje(a)
    const [plan] = await plany('mail.zwrot-przyjety')
    const pg = (await podgladPlanu(a, plan!.id, ENV))!
    expect(pg.temat).toMatch(/^Zwrot do zamówienia .+ dotarł do nas$/)
    expect(pg.tekst).toContain(`1 × Towar testowy ${(await a.product.findUniqueOrThrow({ where: { id: z.productId } })).sku}`)
    expect(pg.tekst).toContain('kontakt@example.com') // adres do odpowiedzi sklepu z ustawień, nie z przykładu
    expect(pg.tekst).not.toMatch(/Anna|anna\.testowa|Fikcyjna|Kubek/)
    expect(pg.uwaga).toMatch(/ustawień firmy/)
    expect(pg.braki.some((b) => b.startsWith('Maile o zwrotach i reklamacjach są wyłączone'))).toBe(false)
  })

  it('wyłącznik wyłączony po zaplanowaniu i zwrot innego zamówienia: podgląd mówi, że mail nie wyjdzie', async () => {
    await wlacz()
    await skonfiguruj()
    const x = await odebrany()
    const y = await odebrany()
    await planujAkcje(a)
    const planX = (await plany()).find((p) => p.targetId === x.orderId)!
    await a.plannedAction.update({ where: { id: planX.id }, data: { vars: { ...(planX.vars as Record<string, string>), returnId: y.returnId } } })
    await wylacz()
    const pg = (await podgladPlanu(a, planX.id, ENV))!
    expect(pg.braki).toContain('Maile o zwrotach i reklamacjach są wyłączone: Kompletor nie wyśle tego maila. Włączysz je w Ustawienia → Sprzedaż i kanały → Automatyczne akcje.')
    expect(pg.braki).toContain('Tego zwrotu nie ma już przy zamówieniu (usunięty albo z innego zamówienia): Kompletor nie wyśle tego maila.')
    expect(pg.tekst).not.toContain('Zwrócone produkty')
  })
})
