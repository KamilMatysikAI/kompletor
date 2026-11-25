// etykieta odbioru osobistego na bazie. Źródło etykiety panelu (to samo, którego używa zlecenie druku typu
// „etykieta”) daje przy odbiorze osobistym etykietę odbioru (PDF i ZPL), a przy kurierze bez przesyłki dalej atrapę;
// numer i kod z karty zamówienia, płatność z zamówienia, paczki rodziny. Krok reguły „Wydrukuj etykietę” obejmuje
// odbiór osobisty bez przesyłki, ale tylko dla konta sklepu w trybie pracy. Dane wyłącznie fikcyjne.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { BladDruku } from '@/lib/druk/zlecenia'
import { daneEtykietyOdbioru, czyOdbiorOsobisty } from '@/lib/druk/etykieta-odbioru'
import { etykietaZamowienia } from '@/lib/wysylka/etykieta-przewoznika'
import { wykonajKroki, type KontekstWykonania } from '@/lib/automaty/wykonanie'
import { DOMYSLNE_STATUSY } from '@/lib/panel/statusy'
import { testDb, truncateAll } from './db'
import { order, product, seedBase } from './rdzen-fixtures'

vi.mock('server-only', () => ({}))

const a = testDb()
const teraz = new Date('2026-11-21T13:00:00Z')
const ENV = { EKRANY_PRACA: '1' }

beforeEach(async () => {
  await truncateAll()
  await seedBase(a)
})
afterAll(async () => {
  await a.$disconnect()
})

async function zamowienie(externalId: string, over: Parameters<typeof order>[1] = {}) {
  const p = await product(a, `SKU-${externalId}`, 10)
  const id = (await ingestOrder(a, order([{ productId: p, qty: 1 }], { externalId, createdAtChannel: teraz, ...over }))).orderId!
  return id
}

const osobisty = (id: string) => a.order.update({ where: { id }, data: { carrier: 'OSOBISTY', deliveryMethod: 'Odbiór osobisty' } })

function kontekst(druk: (orderId: string, st: string | null, klucz: string) => Promise<string | null>): KontekstWykonania {
  return { regulaId: 'regula-testowa', regulaNazwa: 'Etykieta po spakowaniu', lancuch: 0, okazja: 'SPAKOWANO:test', statusy: DOMYSLNE_STATUSY, env: ENV, now: teraz, deps: { druk } }
}

describe('etykieta odbioru osobistego', () => {
  it('odbiór osobisty: źródło etykiety daje PDF i ZPL z napisem, numerem i kodem; opis zlecenia bez danych klienta', async () => {
    const id = await zamowienie('48213', { paymentState: 'COD', totalGross: 189.9 })
    await osobisty(id)
    expect(await czyOdbiorOsobisty(a, id)).toBe(true)
    const e = await etykietaZamowienia.etykieta(a, id, teraz)
    expect(e.pdf?.subarray(0, 5).toString()).toBe('%PDF-')
    const zpl = e.zpl!.toString('utf8')
    expect(zpl).toContain('ODBIÓR OSOBISTY')
    expect(zpl).toMatch(/DO ZAPŁATY: 189,90\szł/)
    expect(zpl).toContain('brak danych odbiorcy')
    expect(e.opis).toMatch(/^Etykieta odbioru osobistego: \S+ 48213$/)
  })

  it('dane: kod najnowszej karty, paczka 1 z 2 przy paczce dodatkowej, opłacone, data spakowania', async () => {
    const id = await zamowienie('48214')
    await osobisty(id)
    const d0 = await daneEtykietyOdbioru(a, id, teraz, null)
    expect(d0).toMatchObject({ paczka: { nr: 1, z: 1 }, platnosc: { stan: 'OPLACONE' }, spakowano: null, odbiorca: null })
    expect(d0!.kod).toMatch(/^[A-Z]+48214$/)
    const kod = d0!.kod
    await a.orderCardPrint.create({ data: { orderId: id, orderCode: kod, printNo: 1, printedBy: 'u', dryRun: false, lines: [] } })
    await a.orderCardPrint.create({ data: { orderId: id, orderCode: kod, printNo: 2, printedBy: 'u', dryRun: false, lines: [] } })
    const spakowano = new Date('2026-11-21T12:30:00Z')
    await a.packDrill.create({ data: { orderId: id, actorId: 'u', startedAt: new Date('2026-11-21T12:20:00Z'), finishedAt: spakowano, outcome: 'SPAKOWANE', parcelSize: 'OSOBISTY' } })
    const dos = await zamowienie('48214-2')
    await a.order.update({ where: { id: dos }, data: { parentOrderId: id, packageNo: 2, carrier: 'OSOBISTY' } })
    const d = await daneEtykietyOdbioru(a, id, teraz, null)
    expect(d).toMatchObject({ kod: `${kod}/2`, paczka: { nr: 1, z: 2 }, spakowano })
    expect((await daneEtykietyOdbioru(a, dos, teraz, null))!.paczka).toEqual({ nr: 2, z: 2 })
  })

  it('kurier bez przesyłki: dalej atrapa (odmowa z powodem), nie etykieta odbioru; anulowane = nie dotyczy', async () => {
    const id = await zamowienie('48215')
    expect(await czyOdbiorOsobisty(a, id)).toBe(false)
    expect(await daneEtykietyOdbioru(a, id, teraz, null)).toBeNull()
    const blad = await etykietaZamowienia.etykieta(a, id, teraz).catch((e: unknown) => e)
    expect(blad).toBeInstanceOf(BladDruku)
    await osobisty(id)
    await a.order.update({ where: { id }, data: { status: 'ANULOWANE' } })
    expect(await daneEtykietyOdbioru(a, id, teraz, null)).toBeNull()
  })

  it('krok reguły „Wydrukuj etykietę”: odbiór osobisty bez przesyłki drukuje w trybie pracy, w podglądzie pominięty', async () => {
    const id = await zamowienie('48216')
    await osobisty(id)
    const wywolania: string[] = []
    const druk = async (orderId: string) => {
      wywolania.push(orderId)
      return null
    }
    // konto w podglądzie (cień): krok pominięty, nic nie idzie do druku
    const [cien] = await wykonajKroki(a, id, [{ typ: 'drukujEtykiete' }], kontekst(druk))
    expect(cien).toMatchObject({ wynik: 'POMINIETY' })
    expect(wywolania).toEqual([])
    await a.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })
    await a.printStation.create({ data: { code: 'magazyn-1', name: 'Magazyn' } })
    const [praca] = await wykonajKroki(a, id, [{ typ: 'drukujEtykiete' }], kontekst(druk))
    expect(praca).toMatchObject({ wynik: 'WYKONANY' })
    expect(wywolania).toEqual([id])
    // kurier bez przesyłki: bez zmian, pominięty
    const k = await zamowienie('48217')
    const [kurier] = await wykonajKroki(a, k, [{ typ: 'drukujEtykiete' }], kontekst(druk))
    expect(kurier).toMatchObject({ wynik: 'POMINIETY', opis: 'zamówienie nie ma utworzonej przesyłki' })
  })
})
