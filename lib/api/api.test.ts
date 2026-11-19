// czyste części API dla systemów zewnętrznych (bez bazy): nagłówek, parametry, kursor, schemat POST.
import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
const { bearerToken } = await import('./klucze')
import { ApiInputError } from './odpowiedzi'
import { parseStockQuery } from './stany'
import { decodeCursor, encodeCursor, parseOrderListQuery, parseOrderNumberQuery } from './zamowienia'
import { eventKeyOf, isPersonalField, parseEasyToolsOrder } from './zapis'
import { newApiKeyToken } from './zarzadzanie'
import { API_KEY_RE } from './zakresy'

const order = (over: Record<string, unknown> = {}) => ({
  numer: 'ET-TEST-1',
  zlozono: '2026-11-02T09:00:00Z',
  platnosc: 'PAID',
  platnoscMetoda: 'Przelewy24',
  sumaBrutto: 10,
  sposobDostawy: 'Paczkomat',
  pozycje: [{ sku: 'TEST-A', ilosc: 1, cenaBrutto: 10 }],
  ...over,
})

describe('API v1: części czyste', () => {
  it('klucz: kmp_ + 43 znaki base64url; nagłówek tylko Bearer', () => {
    const t = newApiKeyToken()
    expect(t).toMatch(API_KEY_RE)
    expect(newApiKeyToken()).not.toBe(t)
    expect(bearerToken(`Bearer ${t}`)).toBe(t)
    expect(bearerToken(`bearer  ${t} `)).toBe(t)
    expect(bearerToken(`Basic ${t}`)).toBeNull()
    expect(bearerToken(`Bearer ${t} x`)).toBeNull()
    expect(bearerToken(null)).toBeNull()
  })

  it('stany: sku albo kanal+konto, nieznany parametr = błąd', () => {
    expect(parseStockQuery(new URLSearchParams('sku=A,B,A'))).toEqual({ skus: ['A', 'B'], page: 1 })
    expect(parseStockQuery(new URLSearchParams('kanal=WOO&konto=7100002&strona=3'))).toEqual({ channel: 'WOO', channelAccountId: '7100002', page: 3 })
    for (const q of ['', 'sku=', 'kanal=WOO', 'konto=1', 'kanal=AI&konto=1', 'sku=A&strona=2', 'kanal=WOO&konto=1&strona=0', 'sku=A&x=1'])
      expect(() => parseStockQuery(new URLSearchParams(q)), q).toThrow(ApiInputError)
  })

  it('kanały sklepów Shoper i PrestaShop: stany i zamówienia po numerze je przyjmują, AI nie', () => {
    for (const k of ['SHOPER', 'PRESTASHOP', 'EASYTOOLS'] as const) {
      expect(parseStockQuery(new URLSearchParams(`kanal=${k}&konto=demo`))).toEqual({ channel: k, channelAccountId: 'demo', page: 1 })
      expect(parseOrderNumberQuery('101', new URLSearchParams(`kanal=${k}&konto=demo`))).toMatchObject({ channel: k })
    }
    expect(() => parseOrderNumberQuery('101', new URLSearchParams('kanal=AI'))).toThrow(ApiInputError)
  })

  it('kursor: tam i z powrotem; śmieci = null', () => {
    const c = { updatedAt: new Date('2026-11-02T10:00:00.123Z'), id: 'cmh0test0001' }
    expect(decodeCursor(encodeCursor(c))).toEqual(c)
    expect(decodeCursor('abc')).toBeNull()
    expect(decodeCursor(Buffer.from('2026-11-02|x').toString('base64url'))).toBeNull()
    expect(decodeCursor('zly kursor')).toBeNull()
  })

  it('lista: okno najwyżej 14 dni, limit 1–200', () => {
    const now = new Date('2026-11-02T12:00:00Z')
    expect(parseOrderListQuery(new URLSearchParams(''), now)).toMatchObject({ changedFrom: new Date('2026-10-19T12:00:00Z'), limit: 100, after: null })
    expect(parseOrderListQuery(new URLSearchParams('zmienione_od=2026-11-01T00:00:00Z&limit=200'), now).limit).toBe(200)
    for (const q of ['zmienione_od=2026-10-01T00:00:00Z', 'limit=201', 'limit=1.5', 'po=xx', 'od=1'])
      expect(() => parseOrderListQuery(new URLSearchParams(q), now), q).toThrow(ApiInputError)
  })

  it('POST: schemat ścisły, pola osobowe osobnym komunikatem, klucz zdarzenia zależny od treści', () => {
    const o = parseEasyToolsOrder(order())
    expect(o).toMatchObject({ numer: 'ET-TEST-1', platnosc: 'PAID', chceFakture: false, pozycje: [{ sku: 'TEST-A', ilosc: 1, cenaBrutto: 10 }] })
    expect(eventKeyOf(o)).toBe(eventKeyOf(parseEasyToolsOrder(order())))
    expect(eventKeyOf(o)).not.toBe(eventKeyOf(parseEasyToolsOrder(order({ platnosc: 'UNPAID' }))))
    for (const k of ['email', 'telefon', 'phone', 'imie', 'nazwisko', 'adres', 'delivery_fullname', 'invoice_nip', 'buyerEmail', 'Adres_dostawy']) expect(isPersonalField(k), k).toBe(true)
    for (const k of ['numer', 'sku', 'ilosc', 'vat', 'platnosc']) expect(isPersonalField(k), k).toBe(false)
    expect(() => parseEasyToolsOrder(order({ email: 'x@example.invalid' }))).toThrow(/nie przyjmuje adresów/)
    expect(() => parseEasyToolsOrder(order({ rabat: 1 }))).toThrow(/Nieznane pole rabat/)
    expect(() => parseEasyToolsOrder(order({ sumaBrutto: 10.001 }))).toThrow(/2 miejsca/)
    expect(parseEasyToolsOrder(order({ pozycje: [{ produktId: 'cmh0abc', ilosc: 2, cenaBrutto: 5, vat: 23 }] })).pozycje).toEqual([{ produktId: 'cmh0abc', ilosc: 2, cenaBrutto: 5, vat: '23' }])
  })
})

describe('docs/api.md', () => {
  it('przykładowe klucze w dokumentacji NIE mają formatu prawdziwego klucza (skanery sekretów)', async () => {
    const { readFileSync } = await import('node:fs')
    const doc = readFileSync(new URL('../../docs/api.md', import.meta.url), 'utf8')
    const found = doc.match(/kmp_[A-Za-z0-9_-]+/g) ?? []
    expect(found.length).toBeGreaterThan(0)
    expect(found.filter((t) => API_KEY_RE.test(t))).toEqual([])
  })
})
