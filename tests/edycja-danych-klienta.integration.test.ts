// Edycja danych kupującego i danych do faktury na karcie zamówienia z kanału: zapis RECZNE odporny na kolejny odczyt
// z kanału, tryb „Tylko podgląd”, blokada po dokumencie sprzedaży (wFirma, KSeF, BaseLinker), przełącznik faktury na
// firmę, wersja formularza, ślad bez danych osobowych, inna firma. Dane fikcyjne, NIP fikcyjny z poprawną sumą.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { daneKlienta } from '@/lib/klienci/odczyt'
import { DANE_ZMIENIONE, FAKTURA_BL, FAKTURA_KSEF, FAKTURA_WFIRMA, FAKTURA_WFIRMA_NIEWIADOMA, KSEF_PO_ZAPISIE_PONOW, NABYWCA_ZAGRANICZNY, NAJPIERW_ODSWIEZ, PACZKA_DODATKOWA, RECZNE_FORMULARZ, SZKIC_KSEF_PO_ZMIANIE, USUN_FAKTURE_POTWIERDZ, zapiszRecznie, zmienDaneFaktury, zmienKupujacego, ZDARZENIE_DANYCH } from '@/lib/klienci/edycja-danych'
import { ODMOWA_CIEN } from '@/lib/karta/bramka'
import { rekordZOdbiorcy, type RekordKlienta } from '@/lib/klienci/rekord'
import { zapiszRekordKlienta } from '@/lib/klienci/zapis'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { order, product, seedBase, T0 } from './rdzen-fixtures'
import { createUserWithHash, grantMembership } from '@/lib/auth/sesje'
import { ORG_A } from './db'
import { ODBIORCA_AUDIT_ENTITY } from '@/lib/odbiorca/pobierz'
import { lockOrder } from '@/lib/rdzen/przejscia'
import { runTx } from '@/lib/rdzen/stan'

const db = testDb()
const dbB = testDb({ organizationId: ORG_B })
const sys = testSystemDb()
afterAll(async () => {
  await db.$disconnect()
  await dbB.$disconnect()
})

const ENV = { EKRANY_PRACA: '1', CUSTOMER_DATA_KEYS: `1:${'4'.repeat(64)}`, CUSTOMER_LOOKUP_KEY: 'd'.repeat(64) }
const NIP = '1234563218'
const FAKTURA = { nazwa: 'Atrapa sp. z o.o.', nip: NIP, ulica: 'ul. Fikcyjna 1', kodPocztowy: '60-001', miasto: 'Poznań', kraj: 'PL' }
let userId = ''

async function zamowienie(o: { tryb?: 'PRACA' | 'CIEN'; kanal?: 'WOO_SD' | 'RECZNE'; bezRekordu?: boolean; faktura?: RekordKlienta['faktura'] } = {}): Promise<string> {
  await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: o.tryb ?? 'PRACA' } })
  const pid = await product(db, `HERB-ED-${Math.random().toString(36).slice(2, 8)}`, 50)
  const id = (await ingestOrder(db, order([{ productId: pid, qty: 1, unitPriceGross: 30 }], { channel: o.kanal ?? 'WOO_SD', deliveryMethod: 'Kurier DPD', paymentState: 'PAID', paymentMethod: 'Przelew' }), { now: T0 })).orderId!
  if (o.bezRekordu) return id
  await zapiszRekordKlienta(
    db,
    id,
    rekordZOdbiorcy({
      dostawa: { imieNazwisko: 'Ewa Fikcyjna', firma: null, ulica: 'ul. Atrapowa', numerDomu: '7', numerLokalu: null, kodPocztowy: '60-003', miasto: 'Poznań', kraj: 'PL', telefon: '+48 511 222 444', email: 'ewa@example.test' },
      punktOdbioru: null,
      faktura: o.faktura ?? null,
      problemy: [],
    }),
    { source: 'KANAL', fetchedAt: T0, env: ENV },
  )
  return id
}

async function rekord(id: string): Promise<{ r: RekordKlienta; rewizja: number; zrodlo: string }> {
  const d = await daneKlienta(db, id, { actorId: userId, zakres: 'PELNY', cel: 'PODGLAD', env: ENV })
  if (d.stan !== 'PELNY') throw new Error(`stan ${d.stan}`)
  return { r: d.rekord, rewizja: d.rewizja, zrodlo: d.zrodlo }
}

const KOLEJNOSC = ['faktura_nazwa', 'faktura_nip', 'faktura_ulica', 'faktura_kod_pocztowy', 'faktura_miasto', 'faktura_rodzaj']
const KUPUJACY = { imieNazwisko: 'Adam Kupujący', firma: null, telefon: '+48 600 100 200', email: 'adam@example.test' }

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  const u = await createUserWithHash(sys, { email: 'biuro@example.test', name: 'biuro', passwordHash: 'x' })
  await grantMembership(sys, { email: 'biuro@example.test', organizationId: ORG_A, role: 'WLASCICIEL' })
  userId = u.id
})

describe('zmienKupujacego', () => {
  it('zamówienie ze sklepu: kupujący i kontakt zmienione, adres dostawy bez zmian, rekord RECZNE', async () => {
    const id = await zamowienie()
    const przed = await rekord(id)
    const w = await zmienKupujacego(db, id, KUPUJACY, { actorId: userId, wersja: przed.rewizja, env: ENV })
    expect(w).toEqual({ wynik: 'ZAPISANO', pola: ['nabywca_imie_nazwisko', 'telefon', 'email'], info: null })
    const po = await rekord(id)
    expect(po.zrodlo).toBe('RECZNE')
    expect(po.r.nabywca?.imieNazwisko).toBe('Adam Kupujący')
    expect(po.r.telefon).toBe('+48 600 100 200')
    expect(po.r.email).toBe('adam@example.test')
    expect(po.r.dostawa).toEqual(przed.r.dostawa)
  })

  it('kolejny odczyt z kanału nie nadpisuje poprawki', async () => {
    const id = await zamowienie()
    await zmienKupujacego(db, id, KUPUJACY, { actorId: userId, wersja: (await rekord(id)).rewizja, env: ENV })
    const kanal = rekordZOdbiorcy({ dostawa: { imieNazwisko: 'Ewa Fikcyjna', firma: null, ulica: 'ul. Inna', numerDomu: '1', numerLokalu: null, kodPocztowy: '60-004', miasto: 'Poznań', kraj: 'PL', telefon: '+48 511 222 444', email: 'ewa@example.test' }, punktOdbioru: null, faktura: null, problemy: [] })
    expect(await zapiszRekordKlienta(db, id, kanal, { source: 'KANAL', fetchedAt: new Date(T0.getTime() + 3_600_000), env: ENV })).toBe('BEZ_ZMIAN_RECZNE')
    expect((await rekord(id)).r.email).toBe('adam@example.test')
  })

  it('ślad: dziennik podglądów i historia z nazwami pól, bez wartości', async () => {
    const id = await zamowienie()
    await zmienKupujacego(db, id, KUPUJACY, { actorId: userId, wersja: (await rekord(id)).rewizja, env: ENV })
    const ev = await db.orderEvent.findMany({ where: { orderId: id, kind: ZDARZENIE_DANYCH } })
    expect(ev).toHaveLength(1)
    expect(ev[0]!.data).toEqual({ czesc: 'KUPUJACY', pola: ['nabywca_imie_nazwisko', 'telefon', 'email'] })
    expect(ev[0]!.actorId).toBe(`user:${userId}`)
    const audyt = JSON.stringify(await db.auditLog.findMany({ where: { entityId: id } }))
    expect(audyt).toContain('nabywca_imie_nazwisko')
    for (const wartosc of ['Adam', '600 100 200', 'adam@example.test']) {
      expect(JSON.stringify(ev)).not.toContain(wartosc)
      expect(audyt).not.toContain(wartosc)
    }
  })

  it('konto w trybie „Tylko podgląd”: odmowa, rekord bez zmian', async () => {
    const id = await zamowienie({ tryb: 'CIEN' })
    const przed = await rekord(id)
    expect(await zmienKupujacego(db, id, KUPUJACY, { actorId: userId, wersja: przed.rewizja, env: ENV })).toEqual({ wynik: 'ODMOWA', powod: ODMOWA_CIEN })
    expect((await rekord(id)).r).toEqual(przed.r)
  })

  it('formularz ze starej wersji rekordu (zmiana obok): odmowa zamiast nadpisania', async () => {
    const id = await zamowienie()
    const stara = (await rekord(id)).rewizja
    await zmienKupujacego(db, id, { ...KUPUJACY, email: 'pierwsza@example.test' }, { actorId: userId, wersja: stara, env: ENV })
    expect(await zmienKupujacego(db, id, KUPUJACY, { actorId: userId, wersja: stara, env: ENV })).toEqual({ wynik: 'ODMOWA', powod: DANE_ZMIENIONE })
    expect((await rekord(id)).r.email).toBe('pierwsza@example.test')
  })

  it('po fakturze kontakt dalej wolno zmienić', async () => {
    const id = await zamowienie()
    await db.invoiceAttempt.create({ data: { orderId: id, packageNo: 1, attemptNo: 1, idExternal: `${id}/1/1`, state: 'ISSUED' } })
    expect((await zmienKupujacego(db, id, KUPUJACY, { actorId: userId, wersja: (await rekord(id)).rewizja, env: ENV })).wynik).toBe('ZAPISANO')
  })

  it('bez zmian: BEZ_ZMIAN, bez śladu w historii', async () => {
    const id = await zamowienie()
    const w = await zmienKupujacego(db, id, { imieNazwisko: 'Ewa Fikcyjna', firma: null, telefon: '+48 511 222 444', email: 'ewa@example.test' }, { actorId: userId, wersja: (await rekord(id)).rewizja, env: ENV })
    expect(w).toEqual({ wynik: 'BEZ_ZMIAN' })
    expect(await db.orderEvent.count({ where: { orderId: id, kind: ZDARZENIE_DANYCH } })).toBe(0)
  })

  it('zamówienie innej firmy (RLS): odmowa, dane firmy A bez zmian', async () => {
    const id = await zamowienie()
    const przed = await rekord(id)
    const w = await zmienKupujacego(dbB, id, KUPUJACY, { actorId: userId, wersja: przed.rewizja, env: ENV })
    expect(w.wynik).toBe('ODMOWA')
    expect((await rekord(id)).r).toEqual(przed.r)
  })

  it('dane usunięte (RODO): odmowa', async () => {
    const id = await zamowienie()
    await db.orderCustomer.updateMany({ where: { orderId: id }, data: { purgedAt: new Date() } })
    expect(await zmienKupujacego(db, id, KUPUJACY, { actorId: userId, wersja: 1, env: ENV })).toEqual({ wynik: 'ODMOWA', powod: 'Dane klienta tego zamówienia zostały usunięte.' })
  })
})

describe('zmienDaneFaktury', () => {
  it('faktura na firmę: dane do faktury w rekordzie i znacznik w zamówieniu; historia z przełącznikiem', async () => {
    const id = await zamowienie()
    const w = await zmienDaneFaktury(db, id, { rodzaj: 'FIRMA', faktura: FAKTURA }, { actorId: userId, wersja: (await rekord(id)).rewizja, env: ENV })
    expect(w.wynik).toBe('ZAPISANO')
    expect((await rekord(id)).r.faktura).toEqual(FAKTURA)
    expect((await db.order.findUniqueOrThrow({ where: { id } })).wantInvoiceNip).toBe(true)
    const ev = await db.orderEvent.findFirstOrThrow({ where: { orderId: id, kind: ZDARZENIE_DANYCH } })
    expect(ev.data).toEqual({ czesc: 'FAKTURA', pola: ['faktura_nazwa', 'faktura_nip', 'faktura_ulica', 'faktura_kod_pocztowy', 'faktura_miasto', 'faktura_rodzaj'], rodzaj: 'FIRMA' })
    expect(JSON.stringify(ev.data)).not.toContain(NIP)
  })

  it('osoba prywatna: dane do faktury zdjęte, znacznik wyłączony', async () => {
    const id = await zamowienie()
    await zmienDaneFaktury(db, id, { rodzaj: 'FIRMA', faktura: FAKTURA }, { actorId: userId, wersja: (await rekord(id)).rewizja, env: ENV })
    const w = await zmienDaneFaktury(db, id, { rodzaj: 'BRAK', faktura: null, usunPotwierdzone: true }, { actorId: userId, wersja: (await rekord(id)).rewizja, env: ENV })
    expect(w.wynik).toBe('ZAPISANO')
    expect((await rekord(id)).r.faktura).toBeNull()
    expect((await db.order.findUniqueOrThrow({ where: { id } })).wantInvoiceNip).toBe(false)
  })

  it('faktura wFirmy wystawiona albo w toku: odmowa; próba z błędem nie blokuje', async () => {
    const id = await zamowienie()
    const wersja = (await rekord(id)).rewizja
    await db.invoiceAttempt.create({ data: { orderId: id, packageNo: 1, attemptNo: 1, idExternal: `${id}/1/1`, state: 'FAILED' } })
    const a2 = await db.invoiceAttempt.create({ data: { orderId: id, packageNo: 1, attemptNo: 2, idExternal: `${id}/1/2`, state: 'SENDING' } })
    expect(await zmienDaneFaktury(db, id, { rodzaj: 'FIRMA', faktura: FAKTURA }, { actorId: userId, wersja, env: ENV })).toEqual({ wynik: 'ODMOWA', powod: FAKTURA_WFIRMA })
    expect((await db.order.findUniqueOrThrow({ where: { id } })).wantInvoiceNip).toBe(false)
    await db.invoiceAttempt.update({ where: { id: a2.id }, data: { state: 'FAILED' } })
    expect((await zmienDaneFaktury(db, id, { rodzaj: 'FIRMA', faktura: FAKTURA }, { actorId: userId, wersja, env: ENV })).wynik).toBe('ZAPISANO')
  })

  it('faktura paczki wydzielonej blokuje dane zamówienia głównego', async () => {
    const id = await zamowienie()
    const pid = await product(db, `HERB-ED2-${Math.random().toString(36).slice(2, 8)}`, 50)
    const dziecko = { id: (await ingestOrder(db, order([{ productId: pid, qty: 1, unitPriceGross: 10 }], { deliveryMethod: 'Kurier DPD' }), { now: T0 })).orderId! }
    await db.order.update({ where: { id: dziecko.id }, data: { parentOrderId: id, packageNo: 2 } })
    await db.invoiceAttempt.create({ data: { orderId: dziecko.id, packageNo: 2, attemptNo: 1, idExternal: `${id}/2/1`, state: 'ISSUED' } })
    expect((await zmienDaneFaktury(db, id, { rodzaj: 'FIRMA', faktura: FAKTURA }, { actorId: userId, wersja: (await rekord(id)).rewizja, env: ENV })).wynik).toBe('ODMOWA')
  })

  it('KSeF: szkic przed wysyłką nie blokuje (z prośbą o ponowne złożenie); wysłana, przyjęta i w toku blokują', async () => {
    const id = await zamowienie()
    const szkic = await db.ksefInvoiceDraft.create({ data: { id: `ksef-${id}`, orderId: id, packageNo: 1, status: 'BLAD_WALIDACJI', wersjaSchemy: 'FA(3)', bruttoGr: 3000, nettoGr: 2439 } })
    const w = await zmienDaneFaktury(db, id, { rodzaj: 'FIRMA', faktura: FAKTURA }, { actorId: userId, wersja: (await rekord(id)).rewizja, env: ENV })
    expect(w).toEqual({ wynik: 'ZAPISANO', pola: expect.any(Array), info: SZKIC_KSEF_PO_ZMIANIE })
    for (const status of ['WYSYLANA', 'WYSLANA', 'PRZYJETA']) {
      await db.ksefInvoiceDraft.update({ where: { id: szkic.id }, data: { status } })
      expect(await zmienDaneFaktury(db, id, { rodzaj: 'BRAK', faktura: null, usunPotwierdzone: true }, { actorId: userId, wersja: (await rekord(id)).rewizja, env: ENV })).toEqual({ wynik: 'ODMOWA', powod: FAKTURA_KSEF })
    }
  })

  it('KSeF: odrzucona albo błąd wysyłki bez śladu wysyłki = wolno poprawić („Ponów”); ze śladem (hash, sesja) = blokada', async () => {
    const id = await zamowienie({ faktura: FAKTURA })
    const szkic = await db.ksefInvoiceDraft.create({ data: { id: `ksef-${id}`, orderId: id, packageNo: 1, status: 'ODRZUCONA', numer: 'FV/1/11/2026', wersjaSchemy: 'FA(3)', bruttoGr: 3000, nettoGr: 2439 } })
    for (const status of ['ODRZUCONA', 'BLAD_WYSYLKI']) {
      await db.ksefInvoiceDraft.update({ where: { id: szkic.id }, data: { status, hasheWyslane: { set: [] }, sesjaRef: null } })
      const w = await zmienDaneFaktury(db, id, { rodzaj: 'FIRMA', faktura: { ...FAKTURA, miasto: `Poznań ${status}` } }, { actorId: userId, wersja: (await rekord(id)).rewizja, env: ENV })
      // przegląd E2 R2-1: rodzaj bez zmiany (NIP w rekordzie = na firmę), znacznik „chce faktury” zostaje
      expect(w).toEqual({ wynik: 'ZAPISANO', pola: ['faktura_miasto'], info: KSEF_PO_ZAPISIE_PONOW })
      await db.ksefInvoiceDraft.update({ where: { id: szkic.id }, data: { hasheWyslane: { set: ['hash-fikcyjny'] } } })
      expect(await zmienDaneFaktury(db, id, { rodzaj: 'FIRMA', faktura: FAKTURA }, { actorId: userId, wersja: (await rekord(id)).rewizja, env: ENV })).toEqual({ wynik: 'ODMOWA', powod: FAKTURA_KSEF })
      await db.ksefInvoiceDraft.update({ where: { id: szkic.id }, data: { hasheWyslane: { set: [] }, sesjaRef: 'sesja-fikcyjna' } })
      expect(await zmienDaneFaktury(db, id, { rodzaj: 'FIRMA', faktura: FAKTURA }, { actorId: userId, wersja: (await rekord(id)).rewizja, env: ENV })).toEqual({ wynik: 'ODMOWA', powod: FAKTURA_KSEF })
    }
  })

  it('wFirma: najnowsza próba FAILED po timeoucie blokuje (dokument mógł powstać); FAILED z błędem jednoznacznym nie', async () => {
    const id = await zamowienie()
    const wersja = (await rekord(id)).rewizja
    const a1 = await db.invoiceAttempt.create({ data: { orderId: id, packageNo: 1, attemptNo: 1, idExternal: `${id}/1/1`, state: 'FAILED', lastError: 'timeout: faktury nie znaleziono po 3 próbach' } })
    expect(await zmienDaneFaktury(db, id, { rodzaj: 'FIRMA', faktura: FAKTURA }, { actorId: userId, wersja, env: ENV })).toEqual({ wynik: 'ODMOWA', powod: FAKTURA_WFIRMA_NIEWIADOMA })
    // kolejna próba rozstrzygnęła (find nic nie znalazł, wFirma odrzuciła dane): blokada znika
    const a2 = await db.invoiceAttempt.create({ data: { orderId: id, packageNo: 1, attemptNo: 2, idExternal: `${id}/1/2`, state: 'FAILED', lastError: 'wFirma: błąd walidacji kontrahenta' } })
    expect((await zmienDaneFaktury(db, id, { rodzaj: 'FIRMA', faktura: FAKTURA }, { actorId: userId, wersja, env: ENV })).wynik).toBe('ZAPISANO')
    // sama jednoznaczna porażka nigdy nie blokowała
    await db.invoiceAttempt.delete({ where: { id: a2.id } })
    await db.invoiceAttempt.update({ where: { id: a1.id }, data: { lastError: 'wFirma: błąd walidacji kontrahenta' } })
    expect(await zmienDaneFaktury(db, id, { rodzaj: 'FIRMA', faktura: { ...FAKTURA, miasto: 'Gniezno' } }, { actorId: userId, wersja: (await rekord(id)).rewizja, env: ENV })).toMatchObject({ wynik: 'ZAPISANO' })
  })

  it('faktura imienna (bez NIP-u) z kanału: poprawka ulicy przechodzi, dane i znacznik zostają', async () => {
    const IMIENNA = { nazwa: 'Ewa Fikcyjna', nip: null, ulica: 'ul. Atrapowa 7', kodPocztowy: '60-003', miasto: 'Poznań', kraj: 'PL' }
    const id = await zamowienie({ faktura: IMIENNA })
    await db.order.update({ where: { id }, data: { wantInvoiceNip: true } })
    const w = await zmienDaneFaktury(db, id, { rodzaj: 'IMIENNA', faktura: { ...IMIENNA, ulica: 'ul. Atrapowa 9' } }, { actorId: userId, wersja: (await rekord(id)).rewizja, env: ENV })
    expect(w).toEqual({ wynik: 'ZAPISANO', pola: ['faktura_ulica'], info: null })
    expect((await rekord(id)).r.faktura).toEqual({ ...IMIENNA, ulica: 'ul. Atrapowa 9' })
    expect((await db.order.findUniqueOrThrow({ where: { id } })).wantInvoiceNip).toBe(true)
  })

  it('R2-1: dane do faktury bez NIP-u i bez prośby klienta (Empik: firma w adresie rozliczeniowym): poprawka ulicy nie zmienia znacznika', async () => {
    const IMIENNA = { nazwa: 'Firma Atrapa', nip: null, ulica: 'ul. Atrapowa 7', kodPocztowy: '60-003', miasto: 'Poznań', kraj: 'PL' }
    const id = await zamowienie({ faktura: IMIENNA })
    expect((await db.order.findUniqueOrThrow({ where: { id } })).wantInvoiceNip).toBe(false)
    const w = await zmienDaneFaktury(db, id, { rodzaj: 'IMIENNA', faktura: { ...IMIENNA, ulica: 'ul. Atrapowa 9' } }, { actorId: userId, wersja: (await rekord(id)).rewizja, env: ENV })
    expect(w).toEqual({ wynik: 'ZAPISANO', pola: ['faktura_ulica'], info: null })
    expect((await db.order.findUniqueOrThrow({ where: { id } })).wantInvoiceNip).toBe(false)
    // zmiana rodzaju (bez danych → imienna) dalej ustawia znacznik
    const id2 = await zamowienie()
    expect((await zmienDaneFaktury(db, id2, { rodzaj: 'IMIENNA', faktura: IMIENNA }, { actorId: userId, wersja: (await rekord(id2)).rewizja, env: ENV })).wynik).toBe('ZAPISANO')
    expect((await db.order.findUniqueOrThrow({ where: { id: id2 } })).wantInvoiceNip).toBe(true)
  })

  it('usunięcie istniejących danych do faktury bez potwierdzenia: odmowa, dane i znacznik bez zmian', async () => {
    const id = await zamowienie({ faktura: FAKTURA })
    await db.order.update({ where: { id }, data: { wantInvoiceNip: true } })
    expect(await zmienDaneFaktury(db, id, { rodzaj: 'BRAK', faktura: null, usunPotwierdzone: false }, { actorId: userId, wersja: (await rekord(id)).rewizja, env: ENV })).toEqual({ wynik: 'ODMOWA', powod: USUN_FAKTURE_POTWIERDZ })
    expect((await rekord(id)).r.faktura).toEqual(FAKTURA)
    expect((await db.order.findUniqueOrThrow({ where: { id } })).wantInvoiceNip).toBe(true)
  })

  it('nabywca zagraniczny z kanału: odmowa z odesłaniem do programu do faktur; kraj nabywcy zostaje z rekordu', async () => {
    const id = await zamowienie({ faktura: { ...FAKTURA, nip: 'DE123456789', kraj: 'DE' } })
    expect(await zmienDaneFaktury(db, id, { rodzaj: 'FIRMA', faktura: FAKTURA }, { actorId: userId, wersja: (await rekord(id)).rewizja, env: ENV })).toEqual({ wynik: 'ODMOWA', powod: NABYWCA_ZAGRANICZNY })
    const id2 = await zamowienie({ faktura: { ...FAKTURA, kraj: null } })
    await zmienDaneFaktury(db, id2, { rodzaj: 'FIRMA', faktura: { ...FAKTURA, miasto: 'Gniezno' } }, { actorId: userId, wersja: (await rekord(id2)).rewizja, env: ENV })
    expect((await rekord(id2)).r.faktura).toEqual({ ...FAKTURA, miasto: 'Gniezno', kraj: null })
  })

  it('faktura w BaseLinkerze: odmowa', async () => {
    const id = await zamowienie()
    await db.blInvoiceSnapshot.create({ data: { blInvoiceId: 1, blOrderId: 1, number: 'BL/1', kind: 'normal', dateAdd: T0, fetchedAt: T0, orderId: id } })
    expect(await zmienDaneFaktury(db, id, { rodzaj: 'FIRMA', faktura: FAKTURA }, { actorId: userId, wersja: (await rekord(id)).rewizja, env: ENV })).toEqual({ wynik: 'ODMOWA', powod: FAKTURA_BL })
  })

  it('faktura w BaseLinkerze jeszcze nierozliczona (kopia po numerze zamówienia BL, bez orderId): odmowa; sama korekta BL nie blokuje', async () => {
    const id = await zamowienie()
    await db.order.update({ where: { id }, data: { blOrderId: 7202 } })
    await db.blInvoiceSnapshot.create({ data: { blInvoiceId: 4, blOrderId: 7202, number: 'BL/KOR/1', kind: 'correcting', dateAdd: T0, fetchedAt: T0, orderId: id } })
    expect(await zmienDaneFaktury(db, id, { rodzaj: 'FIRMA', faktura: FAKTURA }, { actorId: userId, wersja: (await rekord(id)).rewizja, env: ENV })).not.toMatchObject({ wynik: 'ODMOWA' })
    await db.blInvoiceSnapshot.create({ data: { blInvoiceId: 5, blOrderId: 7202, number: 'BL/2', kind: 'normal', dateAdd: T0, fetchedAt: T0, orderId: null } })
    expect(await zmienDaneFaktury(db, id, { rodzaj: 'FIRMA', faktura: { ...FAKTURA, miasto: 'Gniezno' } }, { actorId: userId, wersja: (await rekord(id)).rewizja, env: ENV })).toEqual({ wynik: 'ODMOWA', powod: FAKTURA_BL })
  })

  it('wyścig z wystawieniem: próba faktury zapisana równolegle z edycją; wynik spójny (albo odmowa, albo nowe dane przed próbą)', async () => {
    const id = await zamowienie()
    const wersja = (await rekord(id)).rewizja
    const [w] = await Promise.all([
      zmienDaneFaktury(db, id, { rodzaj: 'FIRMA', faktura: FAKTURA }, { actorId: userId, wersja, env: ENV }),
      runTx(db, async (tx) => {
        await lockOrder(tx, id)
        await tx.invoiceAttempt.create({ data: { orderId: id, packageNo: 1, attemptNo: 1, idExternal: `${id}/1/1`, state: 'SENDING' } })
      }),
    ])
    const zapisano = (await rekord(id)).r.faktura !== null
    expect(w.wynik === 'ZAPISANO').toBe(zapisano)
  })

  it('konto w trybie „Tylko podgląd”: odmowa', async () => {
    const id = await zamowienie({ tryb: 'CIEN' })
    expect(await zmienDaneFaktury(db, id, { rodzaj: 'FIRMA', faktura: FAKTURA }, { actorId: userId, wersja: (await rekord(id)).rewizja, env: ENV })).toEqual({ wynik: 'ODMOWA', powod: ODMOWA_CIEN })
  })
})

describe('brak rekordu, paczka dodatkowa i zamówienie ręczne', () => {
  it('kanał z danymi, rekordu jeszcze nie ma: odmowa „Najpierw Odśwież z kanału”, nic nie zapisane', async () => {
    const id = await zamowienie({ bezRekordu: true })
    expect(await zmienKupujacego(db, id, KUPUJACY, { actorId: userId, wersja: 0, env: ENV })).toEqual({ wynik: 'ODMOWA', powod: NAJPIERW_ODSWIEZ })
    expect(await zmienDaneFaktury(db, id, { rodzaj: 'FIRMA', faktura: FAKTURA }, { actorId: userId, wersja: 0, env: ENV })).toEqual({ wynik: 'ODMOWA', powod: NAJPIERW_ODSWIEZ })
    expect(await db.orderCustomer.count({ where: { orderId: id } })).toBe(0)
    expect((await db.order.findUniqueOrThrow({ where: { id } })).wantInvoiceNip).toBe(false)
  })

  it('kanał bez źródła danych (odczyt odbiorcy: BRAK): zapis od zera dozwolony', async () => {
    const id = await zamowienie({ bezRekordu: true })
    await db.auditLog.create({ data: { entity: ODBIORCA_AUDIT_ENTITY, entityId: id, actorId: 'system', after: { wynik: 'BRAK' } } })
    expect((await zmienKupujacego(db, id, KUPUJACY, { actorId: userId, wersja: 0, env: ENV })).wynik).toBe('ZAPISANO')
  })

  it('paczka dodatkowa (podział, dosłanie): odmowa z odesłaniem do zamówienia głównego, rekord paczki bez zmian', async () => {
    const glowne = await zamowienie()
    const paczka = await zamowienie()
    await db.order.update({ where: { id: paczka }, data: { parentOrderId: glowne, packageNo: 2 } })
    const przed = await rekord(paczka)
    expect(await zmienKupujacego(db, paczka, KUPUJACY, { actorId: userId, wersja: przed.rewizja, env: ENV })).toEqual({ wynik: 'ODMOWA', powod: PACZKA_DODATKOWA })
    expect(await zmienDaneFaktury(db, paczka, { rodzaj: 'FIRMA', faktura: FAKTURA }, { actorId: userId, wersja: przed.rewizja, env: ENV })).toEqual({ wynik: 'ODMOWA', powod: PACZKA_DODATKOWA })
    expect((await rekord(paczka)).r).toEqual(przed.r)
  })

  it('zamówienie ręczne: akcje kanałowe odmawiają (dane wpisuje formularz „Dane klienta”)', async () => {
    const id = await zamowienie({ kanal: 'RECZNE' })
    const przed = await rekord(id)
    expect(await zmienKupujacego(db, id, KUPUJACY, { actorId: userId, wersja: przed.rewizja, env: ENV })).toEqual({ wynik: 'ODMOWA', powod: RECZNE_FORMULARZ })
    expect(await zmienDaneFaktury(db, id, { rodzaj: 'FIRMA', faktura: FAKTURA }, { actorId: userId, wersja: przed.rewizja, env: ENV })).toEqual({ wynik: 'ODMOWA', powod: RECZNE_FORMULARZ })
  })
})

describe('zapiszRecznie (zamówienie ręczne)', () => {
  it('po fakturze: zmiana danych do faktury odrzucona, zmiana kontaktu przechodzi', async () => {
    const id = await zamowienie({ kanal: 'RECZNE' })
    const przed = await rekord(id)
    await db.invoiceAttempt.create({ data: { orderId: id, packageNo: 1, attemptNo: 1, idExternal: `${id}/1/1`, state: 'ISSUED' } })
    expect(await zapiszRecznie(db, id, { ...przed.r, faktura: FAKTURA }, { actorId: userId, env: ENV })).toEqual({ wynik: 'ODMOWA', powod: FAKTURA_WFIRMA })
    expect((await zapiszRecznie(db, id, { ...przed.r, email: 'nowy@example.test' }, { actorId: userId, env: ENV })).wynik).toBe('ZAPISANO')
    expect((await rekord(id)).r.email).toBe('nowy@example.test')
    expect((await rekord(id)).r.faktura).toBeNull()
  })

  it('bez faktury: zapis całości jak dotąd', async () => {
    const id = await zamowienie({ kanal: 'RECZNE' })
    const przed = await rekord(id)
    expect((await zapiszRecznie(db, id, { ...przed.r, faktura: FAKTURA }, { actorId: userId, env: ENV })).wynik).toBe('ZAPISANO')
    expect((await rekord(id)).r.faktura).toEqual(FAKTURA)
  })
})
