// nieznany błąd zapisu (baza, Prisma, TypeError parsera) nie jest „trwały”. Zadanie
// KLIENT_ZAPIS ma się ponowić (wyjątek bez danych w komunikacie), bez śladu KLIENT_ZAPIS „BLAD”. Trwałe (bramka kanału,
// AdapterError TRWALY, NonRetryableError) dalej kończą się jednym śladem. Bez bazy, atrapy modułów; dane fikcyjne.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import type { OrderRecipient } from '../adaptery/kontrakt'

vi.mock('server-only', () => ({}))
const h = vi.hoisted(() => ({ runTx: vi.fn(), pobierz: vi.fn() }))
vi.mock('../db', () => ({ organizationIdOf: () => 'org-a' }))
vi.mock('./retencja', () => ({ terminDlaZamowienia: async () => new Date('2029-11-04T00:00:00.000Z') }))
vi.mock('../rdzen/stan', () => ({ advisoryLock: vi.fn(), runTx: h.runTx }))
vi.mock('../odbiorca/pobierz', async (orig) => ({ ...(await orig<typeof import('../odbiorca/pobierz')>()), pobierzOdbiorce: h.pobierz }))

import { AdapterError } from '../adaptery/kontrakt'
import { isNonRetryable } from '../bledy'
import { BladOdczytuOdbiorcy } from '../odbiorca/pobierz'
import type { AdapterRegistry } from '../adaptery/rejestr'
import { BladPrzejsciowyZapisu, wykonajZapisKlienta, ZAPIS_AUDIT } from './zapis'

const ODBIORCA: OrderRecipient = {
  dostawa: { imieNazwisko: 'Jan Testowy', firma: null, ulica: 'ul. Fikcyjna 17', numerDomu: '17', numerLokalu: null, kodPocztowy: '60-001', miasto: 'Poznań', kraj: 'PL', telefon: '+48 500 000 000', email: 'jan@example.test' },
  punktOdbioru: null,
  faktura: null,
  problemy: [],
}
const ENV = { DANE_KLIENTA_ZAPIS: '1', CUSTOMER_DATA_KEYS: `1:${'1'.repeat(64)}`, CUSTOMER_LOOKUP_KEY: 'a'.repeat(64) }
const deps = { registry: {} as AdapterRegistry, secrets: { env: ENV, envFallback: false } }

let audit: ReturnType<typeof vi.fn>
let db: PrismaClient
beforeEach(() => {
  h.runTx.mockReset()
  h.pobierz.mockReset()
  h.pobierz.mockResolvedValue({ zrodlo: 'KANAL', kanal: 'WOO', odbiorca: ODBIORCA })
  audit = vi.fn(async () => ({}))
  db = { orderCustomer: { findUnique: async () => null }, auditLog: { create: audit } } as unknown as PrismaClient
})

describe('wykonajZapisKlienta: klasyfikacja błędów', () => {
  it('błąd bazy przy zapisie (P1001): wyjątek do ponowienia, bez śladu BLAD, komunikat bez danych klienta', async () => {
    h.runTx.mockRejectedValue(Object.assign(new Error("Can't reach database server; Jan Testowy, ul. Fikcyjna 17"), { name: 'PrismaClientKnownRequestError', code: 'P1001' }))
    const e = await wykonajZapisKlienta(db, { orderId: 'ord_1' }, deps).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(BladPrzejsciowyZapisu)
    expect(isNonRetryable(e)).toBe(false)
    expect((e as Error).message).toMatch(/PrismaClientKnownRequestError, P1001/)
    expect((e as Error).message).not.toMatch(/Jan|Fikcyjna/)
    expect(audit).not.toHaveBeenCalled()
  })

  it('nieznany błąd zamieniony na INNY (np. TypeError parsera): wyjątek, bez śladu', async () => {
    h.pobierz.mockRejectedValue(new BladOdczytuOdbiorcy('WOO/sd', 'INNY', 'TypeError'))
    await expect(wykonajZapisKlienta(db, { orderId: 'ord_2' }, deps)).rejects.toBeInstanceOf(BladPrzejsciowyZapisu)
    expect(audit).not.toHaveBeenCalled()
  })

  it('przejściowy błąd kanału: wyjątek kanału dalej, bez śladu', async () => {
    h.pobierz.mockRejectedValue(new BladOdczytuOdbiorcy('WOO/sd', 'PRZEJSCIOWY', 'AdapterError'))
    await expect(wykonajZapisKlienta(db, { orderId: 'ord_3' }, deps)).rejects.toBeInstanceOf(BladOdczytuOdbiorcy)
    expect(audit).not.toHaveBeenCalled()
  })

  it('trwały błąd kanału albo adaptera: jeden ślad BLAD i koniec bez wyjątku', async () => {
    h.pobierz.mockRejectedValue(new BladOdczytuOdbiorcy('WOO/sd', 'TRWALY', 'AdapterError'))
    await expect(wykonajZapisKlienta(db, { orderId: 'ord_4' }, deps)).resolves.toBeUndefined()
    h.pobierz.mockRejectedValue(new AdapterError('404', 'TRWALY'))
    await expect(wykonajZapisKlienta(db, { orderId: 'ord_5' }, deps)).resolves.toBeUndefined()
    expect(audit).toHaveBeenCalledTimes(2)
    expect(audit.mock.calls[0]![0]).toMatchObject({ data: { entity: ZAPIS_AUDIT, after: { wynik: 'BLAD', rodzaj: 'TRWALY' } } })
  })

  it('brak klucza (NonRetryableError): ślad BLAD i wyjątek nieponawialny', async () => {
    const e = await wykonajZapisKlienta(db, { orderId: 'ord_6' }, { ...deps, secrets: { env: { DANE_KLIENTA_ZAPIS: '1', CUSTOMER_LOOKUP_KEY: 'a'.repeat(64) }, envFallback: false } }).catch((x: unknown) => x)
    expect(isNonRetryable(e)).toBe(true)
    expect(audit).toHaveBeenCalledTimes(1)
  })
})
