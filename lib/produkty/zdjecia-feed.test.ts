// parowanie pozycji feedu z produktami, walidacja adresów, osłony pobrania, CSV. Dane zmyślone.
import { describe, expect, it } from 'vitest'
import type { PozycjaFeedu } from './feed'
import { csvBezDopasowania, czytajFeedy, dopasuj, FEED_MAX_ADRESOW, pobierzFeed, type ProduktKatalogu, skrotAdresu, sprawdzFeedy } from './zdjecia-feed'

const poz = (id: string, o: Partial<PozycjaFeedu> = {}): PozycjaFeedu => ({ id, zdjecia: [`https://s.example.test/${id}.jpg`], ...o })
const prod = (id: string, sku: string, o: Partial<ProduktKatalogu> = {}): ProduktKatalogu => ({ id, sku, ean: null, maZdjecie: false, ...o })

describe('dopasuj', () => {
  it('kolejność reguł: SKU = mpn, SKU = id, EAN, oferta sklepu (id i grupa/id wariantu)', () => {
    const katalog = [prod('p1', 'T-0001'), prod('p2', '502'), prod('p3', 'E-1', { ean: '5901234123457' }), prod('p4', 'WAR-1'), prod('p5', 'PROSTY')]
    const oferty = new Map([
      ['610/611', 'p4'],
      ['900', 'p5'],
    ])
    const w = dopasuj([poz('501', { mpn: 'T-0001' }), poz('502'), poz('503', { gtin: '590 1234 123457' }), poz('611', { grupa: '610', mpn: 'INNY' }), poz('900')], katalog, oferty)
    expect(w.sparowane).toBe(5)
    expect(w.wedlugReguly).toEqual({ sku: 1, 'id-jako-sku': 1, ean: 1, oferta: 2 })
    expect([...w.doPobrania.keys()]).toEqual(['p1', 'p2', 'p3', 'p4', 'p5'])
    expect(w.doPobrania.get('p4')).toEqual(['https://s.example.test/611.jpg'])
  })

  it('tylko produkty bez zdjęcia; pozycja bez adresu https liczona osobno', () => {
    const w = dopasuj([poz('1', { mpn: 'A' }), poz('2', { mpn: 'B', zdjecia: ['http://s.example.test/2.jpg'] }), poz('3', { mpn: 'C' })], [prod('a', 'A', { maZdjecie: true }), prod('b', 'B'), prod('c', 'C')], new Map())
    expect(w).toMatchObject({ sparowane: 3, maZdjecie: 1, bezZdjeciaWFeedzie: 1 })
    expect([...w.doPobrania.keys()]).toEqual(['c'])
  })

  it('ten sam EAN u dwóch produktów = niejednoznaczne, chyba że rozstrzyga oferta; brak = bez dopasowania z listą do CSV', () => {
    const katalog = [prod('a', 'A', { ean: '5901234123457' }), prod('b', 'B', { ean: '5901234123457' })]
    const w1 = dopasuj([poz('1', { gtin: '5901234123457', tytul: 'Dwa EAN' }), poz('2', { mpn: 'ZZZ', tytul: 'Nic' })], katalog, new Map())
    expect(w1).toMatchObject({ sparowane: 0, niejednoznaczne: 1, bezDopasowania: 1 })
    expect(w1.lista).toEqual([
      { feed: 0, id: '1', mpn: '', gtin: '5901234123457', tytul: 'Dwa EAN', powod: 'niejednoznaczne' },
      { feed: 0, id: '2', mpn: 'ZZZ', gtin: '', tytul: 'Nic', powod: 'brak' },
    ])
    const w2 = dopasuj([poz('1', { gtin: '5901234123457' })], katalog, new Map([['1', 'b']]))
    expect(w2.niejednoznaczne).toBe(0)
    expect([...w2.doPobrania.keys()]).toEqual(['b'])
  })

  it('dwie pozycje na jeden produkt: to samo zdjęcie główne = jedno zlecenie; różne = niejednoznaczne, chyba że jedna wskazuje ofertę', () => {
    const katalog = [prod('a', 'DUBEL')]
    const takieSame = dopasuj([poz('1', { mpn: 'DUBEL', zdjecia: ['https://s.example.test/x.jpg'] }), poz('2', { mpn: 'DUBEL', zdjecia: ['https://s.example.test/x.jpg'] })], katalog, new Map())
    expect(takieSame).toMatchObject({ sparowane: 2, niejednoznaczne: 0 })
    expect(takieSame.doPobrania.size).toBe(1)
    const rozne = dopasuj([poz('1', { mpn: 'DUBEL' }), poz('2', { mpn: 'DUBEL' })], katalog, new Map())
    expect(rozne).toMatchObject({ sparowane: 0, niejednoznaczne: 2 })
    expect(rozne.doPobrania.size).toBe(0)
    const zOferta = dopasuj([poz('1', { mpn: 'DUBEL' }), poz('2', { mpn: 'DUBEL' })], katalog, new Map([['2', 'a']]))
    expect(zOferta.doPobrania.get('a')).toEqual(['https://s.example.test/2.jpg'])
  })

  it('sprzeczne wskazania reguł = niejednoznaczne, nie „pierwsza wygrywa”', () => {
    const katalog = [prod('a', '4521'), prod('b', 'NOWY-B')]
    const oferty = new Map([['4521', 'b']])
    // g:id równe cudzemu SKU, a g:mpn to nowe SKU spoza katalogu: reguła 2 nie działa (pozycja ma g:mpn), rozstrzyga oferta
    const nowe = dopasuj([poz('4521', { mpn: 'B-SKU-W-SKLEPIE' })], katalog, oferty)
    expect(nowe).toMatchObject({ sparowane: 1, niejednoznaczne: 0, wedlugReguly: { sku: 0, 'id-jako-sku': 0, ean: 0, oferta: 1 } })
    expect([...nowe.doPobrania.keys()]).toEqual(['b'])
    // g:mpn → a, oferta sklepu → b: konflikt, żadne zdjęcie
    const konflikt = dopasuj([poz('9', { mpn: '4521', tytul: 'Konflikt' })], katalog, new Map([['9', 'b']]))
    expect(konflikt).toMatchObject({ sparowane: 0, niejednoznaczne: 1, bezDopasowania: 0 })
    expect(konflikt.doPobrania.size).toBe(0)
    expect(konflikt.lista).toEqual([{ feed: 0, id: '9', mpn: '4521', gtin: '', tytul: 'Konflikt', powod: 'niejednoznaczne' }])
    // pozycja bez g:mpn: g:id jako SKU → a, oferta → b: też konflikt
    expect(dopasuj([poz('4521')], katalog, oferty)).toMatchObject({ sparowane: 0, niejednoznaczne: 1 })
    // zgodne wskazania (mpn i oferta → ten sam produkt) dalej sparowane, z regułą pierwszą w kolejności
    expect(dopasuj([poz('9', { mpn: '4521' })], katalog, new Map([['9', 'a']])).wedlugReguly).toEqual({ sku: 1, 'id-jako-sku': 0, ean: 0, oferta: 0 })
    // reguła z wieloma kandydatami (wspólny EAN) nie weta jednoznacznej reguły
    const ean = [prod('a', 'A', { ean: '5901234123457' }), prod('b', 'B', { ean: '5901234123457' })]
    expect([...dopasuj([poz('1', { mpn: 'A', gtin: '5901234123457' })], ean, new Map()).doPobrania.keys()]).toEqual(['a'])
  })

  it('produkt zajęty przez wcześniejszy feed nie dostaje drugiego zlecenia', () => {
    const w = dopasuj([poz('1', { mpn: 'A' })], [prod('a', 'A')], new Map(), { zajete: new Set(['a']) })
    expect(w.sparowane).toBe(1)
    expect(w.doPobrania.size).toBe(0)
  })
})

describe('adresy feedu', () => {
  const konta = new Set(['WOO:sklep1'])
  it('https, sklep z listy, bez powtórzeń, limit adresów', () => {
    expect(sprawdzFeedy([{ url: ' https://s.example.test/feed.xml ', konto: 'WOO:sklep1' }, { url: '', konto: 'WOO:sklep1' }, { url: 'https://inny.example.test/f.xml', konto: '' }], konta)).toEqual({
      ok: true,
      value: [{ url: 'https://s.example.test/feed.xml', konto: 'WOO:sklep1' }, { url: 'https://inny.example.test/f.xml' }],
    })
    expect(sprawdzFeedy([], konta)).toEqual({ ok: true, value: [] })
    expect(sprawdzFeedy([{ url: '  ' }], konta)).toEqual({ ok: true, value: [] })
    for (const zly of ['http://s.example.test/f.xml', 'https://127.0.0.1/f.xml', 'https://localhost/f.xml', 'https://serwer.internal/f.xml', 'https://u:h@s.example.test/f.xml', 'ftp://s.example.test/f.xml', 'feed.xml'])
      expect(sprawdzFeedy([{ url: zly }], konta).ok).toBe(false)
    expect(sprawdzFeedy([{ url: 'https://s.example.test/f.xml', konto: 'WOO:obcy' }], konta)).toMatchObject({ ok: false, error: expect.stringContaining('nie ma podłączonego sklepu') })
    expect(sprawdzFeedy([{ url: 'https://s.example.test/f.xml' }, { url: 'https://s.example.test/f.xml' }], konta)).toMatchObject({ ok: false, error: expect.stringContaining('już na liście') })
    const duzo = Array.from({ length: FEED_MAX_ADRESOW + 1 }, (_, i) => ({ url: `https://s.example.test/${i}.xml` }))
    expect(sprawdzFeedy(duzo, konta).ok).toBe(false)
  })

  it('średnik w zapytaniu adresu nie rozbija wiersza', () => {
    expect(sprawdzFeedy([{ url: 'https://s.example.test/feed.xml?a=1;b=2', konto: 'WOO:sklep1' }], new Set(['WOO:sklep1']))).toEqual({
      ok: true,
      value: [{ url: 'https://s.example.test/feed.xml?a=1;b=2', konto: 'WOO:sklep1' }],
    })
    expect(sprawdzFeedy([{ url: 'https://s.example.test/feed.xml?a=1;b=2' }], new Set())).toEqual({ ok: true, value: [{ url: 'https://s.example.test/feed.xml?a=1;b=2' }] })
  })

  it('czytajFeedy: złe wpisy z ustawień pominięte', () => {
    expect(czytajFeedy({ feedyProduktowe: { adresy: [{ url: 'https://s.example.test/f.xml', konto: 'WOO:a' }, { url: 'http://zly.example.test/f.xml' }, { url: 'https://s.example.test/g.xml', konto: 'zle konto' }, 5] } })).toEqual([
      { url: 'https://s.example.test/f.xml', konto: 'WOO:a' },
      { url: 'https://s.example.test/g.xml' },
    ])
    expect(czytajFeedy({})).toEqual([])
    expect(czytajFeedy(null)).toEqual([])
  })

  it('pobierzFeed: adres wewnętrzny (DNS) i http odrzucone przed połączeniem', async () => {
    await expect(pobierzFeed('https://feed.example.test/f.xml', async () => ['10.0.0.5'])).rejects.toThrow(/sieć wewnętrzną/)
    await expect(pobierzFeed('https://feed.example.test/f.xml', async () => ['::1'])).rejects.toThrow(/sieć wewnętrzną/)
    await expect(pobierzFeed('https://feed.example.test/f.xml', async () => [])).rejects.toThrow(/sieć wewnętrzną/)
    await expect(pobierzFeed('http://feed.example.test/f.xml', async () => ['93.184.216.34'])).rejects.toThrow(/niedozwolony/)
  })

  it('skrót adresu i CSV z BOM, średnikiem i osłoną formuł', () => {
    expect(skrotAdresu('https://s.example.test/a/b/AbCdEfGhIjKlMnOp.xml')).toBe('s.example.test/…/AbCdEf…MnOp.xml')
    const csv = csvBezDopasowania([{ feed: 1, id: '7', mpn: '=SUMA(A1)', gtin: '', tytul: 'Kubek; duży', powod: 'brak' }])
    expect(csv.startsWith('﻿Feed;')).toBe(true)
    expect(csv).toContain(`1;7;'=SUMA(A1);;"Kubek; duży";brak produktu`)
  })
})
