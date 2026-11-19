// reszta: ostrzeżenie „bez stawki VAT” przy edycji karty. Dane fikcyjne.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_WAREHOUSE } from '@/lib/rdzen/stan'
import { BEZ_VAT, edytujProdukt, zalozProduktReczny } from '@/lib/produkty/karta'
import { testDb, truncateAll } from './db'

const a = testDb()
const USER = 'uzytkownik-testowy-a123r'

afterAll(async () => {
  await a.$disconnect()
})
beforeEach(async () => {
  await truncateAll()
  await a.warehouse.create({ data: { id: DEFAULT_WAREHOUSE, name: 'Główny (test)' } })
})

describe('edycja karty bez stawki VAT', () => {
  it('wyczyszczenie VAT przy cenie = zapis z ostrzeżeniem; cena bez zmian i VAT jest = bez ostrzeżenia', async () => {
    const r = await zalozProduktReczny(a, { rodzaj: 'zwykly', sku: 'VAT-1', form: { nazwa: 'Przyprawa VAT', cena: '19,90', vat: '5' } }, USER, { hasWfirma: false })
    if (!r.ok) throw new Error(r.error)
    expect(r.warnings).not.toContain(BEZ_VAT)
    const bez = await edytujProdukt(a, r.productId, { vat: '' }, USER)
    expect(bez).toMatchObject({ ok: true, zmiany: ['vatRate'], warnings: [BEZ_VAT] })
    expect((await a.product.findUniqueOrThrow({ where: { id: r.productId } })).vatRate).toBeNull()
    const z = await edytujProdukt(a, r.productId, { vat: '23' }, USER)
    expect(z).toMatchObject({ ok: true, zmiany: ['vatRate'] })
    expect('warnings' in z && z.warnings).toBeFalsy()
    // sam opis przy cenie bez VAT nie dokłada ostrzeżenia co zapis (tylko zmiana ceny albo VAT)
    await edytujProdukt(a, r.productId, { vat: '' }, USER)
    const opis = await edytujProdukt(a, r.productId, { opis: 'Nowy opis' }, USER)
    expect('warnings' in opis && opis.warnings).toBeFalsy()
  })
})

describe('CSV katalogu i warianty', () => {
  const NAGLOWEK = 'SKU;Nazwa;EAN;Cena brutto;VAT;Waga (g);Grupa wariantów;Stan;Opis'
  it('import: nowe produkty ze stanem i grupą, zmiany po SKU, pusta komórka nic nie czyści, błędny wiersz nie blokuje reszty; ponowny import bez zmian', async () => {
    const { importCsv } = await import('@/lib/produkty/csv')
    const ist = await zalozProduktReczny(a, { rodzaj: 'zwykly', sku: 'CSV-JEST', form: { nazwa: 'Stary kubek', cena: '10,00', vat: '23', opis: 'Zostaje' } }, USER, { hasWfirma: false })
    if (!ist.ok) throw new Error(ist.error)
    const plik = [
      NAGLOWEK,
      'KUB-S;Kubek S;;29,90;23;300;KUBEK-26;5;',
      'KUB-M;"Kubek M; duży";;31,90;23%;350;KUBEK-26;;',
      'csv-jest;;;12,50;;;;;', // inna wielkość liter = ten sam produkt; puste pola bez zmian
      ';Bez SKU;;;;;;;',
      'ZLY-EAN;Zły EAN;123;;;;;;',
      'KUB-S;Dubel;;;;;;;',
      'NOWY-BEZ-NAZWY;;;;;;;;',
      "FORM-1;'=SUMA(A1);;;;;;;",
    ].join('\r\n')
    const r = await importCsv(a, plik, USER, { hasWfirma: false })
    if ('blad' in r) throw new Error(r.blad)
    expect(r).toMatchObject({ nowe: 3, zmienione: 1, bezZmian: 0 })
    expect(r.bledy.map((b) => b.linia)).toEqual([5, 6, 7, 8])
    const s = await a.product.findFirstOrThrow({ where: { sku: 'KUB-S' }, include: { stocks: true } })
    expect(s).toMatchObject({ title: 'Kubek S', dataSource: 'CSV', groupId: 'KUBEK-26', weightG: 300, vatRate: '23' })
    expect(s.stocks.reduce((x, y) => x + y.physical, 0)).toBe(5)
    expect((await a.product.findFirstOrThrow({ where: { sku: 'KUB-M' } })).title).toBe('Kubek M; duży')
    expect((await a.product.findFirstOrThrow({ where: { sku: 'FORM-1' } })).title).toBe('=SUMA(A1)')
    const j = await a.product.findUniqueOrThrow({ where: { id: ist.productId } })
    expect(Number(j.priceGross)).toBe(12.5)
    expect(j.description).toBe('Zostaje')

    const r2 = await importCsv(a, plik, USER, { hasWfirma: false })
    if ('blad' in r2) throw new Error(r2.blad)
    expect(r2).toMatchObject({ nowe: 0, zmienione: 0 })
    expect(await a.product.count({ where: { sku: { in: ['KUB-S', 'KUB-M', 'FORM-1'] } } })).toBe(3)
  })

  it('plik bez kolumny SKU, za dużo wierszy, firma z wFirmą: czytelny komunikat; kolumna Stan przy istniejącym = uwaga', async () => {
    const { importCsv, CSV_MAKS_WIERSZY } = await import('@/lib/produkty/csv')
    expect(await importCsv(a, 'Nazwa;Cena\nA;1', USER, { hasWfirma: false })).toEqual({ blad: expect.stringContaining('SKU') })
    expect(await importCsv(a, 'SKU\n' + Array.from({ length: CSV_MAKS_WIERSZY + 1 }, (_, i) => `S${i}`).join('\n'), USER, { hasWfirma: false })).toEqual({ blad: expect.stringContaining('podziel') })
    const w = await importCsv(a, 'SKU;Nazwa\nWF-1;Towar', USER, { hasWfirma: true })
    if ('blad' in w) throw new Error(w.blad)
    expect(w.bledy[0]!.komunikat).toMatch(/wFirmie/)
    await importCsv(a, 'SKU;Nazwa\nST-1;Towar', USER, { hasWfirma: false })
    const u = await importCsv(a, 'SKU;Stan\nST-1;7', USER, { hasWfirma: false })
    if ('blad' in u) throw new Error(u.blad)
    expect(u.uwagi[0]!.komunikat).toMatch(/korekta/)
  })

  it('eksport: wszystkie produkty, BOM i „;”, formuły zneutralizowane, wraca importem bez zmian', async () => {
    const { eksportCsv, importCsv, parsujCsv } = await import('@/lib/produkty/csv')
    await importCsv(a, `${NAGLOWEK}\nE-1;"=1+1 kubek";5901234123457;19,90;5;250;GR-1;3;"Opis; z separatorem"\nE-2;Drugi;;;;;GR-1;;`, USER, { hasWfirma: false })
    const { tekst, wiersze } = await eksportCsv(a)
    expect(wiersze).toBe(2)
    expect(tekst.startsWith('﻿SKU;Nazwa;EAN;Cena brutto;VAT')).toBe(true)
    const rows = parsujCsv(tekst)
    const e1 = rows.find((r) => r[0] === 'E-1')!
    expect(e1[1]).toBe("'=1+1 kubek")
    expect(e1[3]).toBe('19,90')
    const back = await importCsv(a, tekst, USER, { hasWfirma: false })
    if ('blad' in back) throw new Error(back.blad)
    expect(back).toMatchObject({ nowe: 0, zmienione: 0, bezZmian: 2, bledy: [] })
    expect((await a.product.findFirstOrThrow({ where: { sku: 'E-1' } })).title).toBe('=1+1 kubek')
  })

  it('grupa wariantów z karty: zapis z historią, zła wartość = błąd pola, pusta zdejmuje grupę; BL tylko do odczytu', async () => {
    const r = await zalozProduktReczny(a, { rodzaj: 'zwykly', sku: 'WAR-1', form: { nazwa: 'Wariant 1' } }, USER, { hasWfirma: false })
    if (!r.ok) throw new Error(r.error)
    expect(await edytujProdukt(a, r.productId, { grupa: 'ma spację' }, USER)).toMatchObject({ ok: false, field: 'grupa' })
    expect(await edytujProdukt(a, r.productId, { grupa: 'KOSZULKA-26' }, USER)).toMatchObject({ ok: true, zmiany: ['groupId'] })
    expect((await a.product.findUniqueOrThrow({ where: { id: r.productId } })).groupId).toBe('KOSZULKA-26')
    expect(await edytujProdukt(a, r.productId, { grupa: '' }, USER)).toMatchObject({ ok: true, zmiany: ['groupId'] })
    expect((await a.product.findUniqueOrThrow({ where: { id: r.productId } })).groupId).toBeNull()
    await a.product.update({ where: { id: r.productId }, data: { dataSource: 'BL', groupId: 'BL-123' } })
    expect(await edytujProdukt(a, r.productId, { grupa: 'INNA' }, USER)).toMatchObject({ ok: true, zmiany: [] })
    expect((await a.product.findUniqueOrThrow({ where: { id: r.productId } })).groupId).toBe('BL-123')
  })
})

describe('źródło stanu WFIRMA bez magazynu wFirmy', () => {
  it('zalozProduktReczny przy stockSource WFIRMA bez wfirmaWarehouseId: towar ze stanem odmowa z drogą do wFirmy, bez stanu i zestaw działają', async () => {
    const { firmaMaWfirme } = await import('@/lib/kanaly/firma')
    await a.warehouse.updateMany({ where: { id: DEFAULT_WAREHOUSE }, data: { stockSource: 'WFIRMA', wfirmaWarehouseId: null } })
    const hasWfirma = await firmaMaWfirme(a)
    expect(hasWfirma).toBe(true)
    expect(await zalozProduktReczny(a, { rodzaj: 'zwykly', sku: 'WF-ZW', form: { nazwa: 'Towar' } }, USER, { hasWfirma })).toMatchObject({ ok: false, field: 'rodzaj', error: expect.stringContaining('wFirm') })
    expect(await zalozProduktReczny(a, { rodzaj: 'bez-stanu', sku: 'WF-BS', form: { nazwa: 'Usługa' } }, USER, { hasWfirma })).toMatchObject({ ok: true })
    expect(await a.product.count({ where: { sku: 'WF-ZW' } })).toBe(0)
  })
})
