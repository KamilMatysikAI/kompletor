// reszta ustawień — Dokumenty sprzedaży jednym zapisem (źródło stanu i program w jednej transakcji),
// kod stanowiska druku z nazwy, drugie konto przewoźnika z panelu (Dodaj konto, kolumna „Konto” w regule), klucze
// z konfiguracji serwera, reguły bez zmian bez zapisu, potwierdzenie usunięcia tylko dla ustawień, których
// panel nie odtworzy, braki: szukanie i licznik w bazie, decyzja grupy bez już zdecydowanych,
// licznik menu = zakładka „Brakuje”. Dane fikcyjne, bez sieci.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { dokumentyZFormularza, programyDoWyboru, UstawieniaDokumentowError, widokDokumentow, zapiszDokumentySprzedazy } from '@/lib/dokumenty/zapis'
import { dodajStanowisko } from '@/lib/druk/stanowiska'
import { liczbaBrakow, linieProduktow, LIMIT_MASOWY, pozycjeBrakow, ukrytePrzyZamknietych, zdecydujMasowo } from '@/lib/panel/braki'
import { navCounts } from '@/lib/panel/dane'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { setSecret } from '@/lib/sekrety'
import { dodajKontoPrzewoznika, kontaPrzewoznikow, KontoPrzewoznikaError, sufiksZNazwy, wykonajTestKonta } from '@/lib/wysylka/konta'
import { regulyPrzewoznikow, RegulyError, zapiszRegulyPrzewoznikow } from '@/lib/wysylka/reguly'
import { ORG_B, testDb, truncateAll } from './db'
import { order, product, seedBase } from './rdzen-fixtures'

vi.mock('server-only', () => ({}))

const a = testDb()
const b = testDb({ organizationId: ORG_B })
const registry = defaultRegistry()
const ENV = { APP_ENCRYPTION_KEY: 'b'.repeat(64), APP_MODE: 'self-host' }
const programy = programyDoWyboru(registry.list())

beforeEach(async () => {
  await truncateAll()
  for (const db of [a, b]) await seedBase(db)
})
afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})

const formularz = (pola: Record<string, string>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries({ program: 'wfirma', wystawiajPrzy: 'SPAKOWANE', rodzaj: 'faktura', seriaKod: '', seriaWzor: '', seriaReset: 'ROK', wysylkaNazwa: 'Wysyłka', wysylkaStawka: '23', podstawaZwolnienia: '', ...pola })) f.set(k, v)
  return dokumentyZFormularza(f)
}

describe('Dokumenty sprzedaży jednym zapisem', () => {
  it('lustro wFirmy → Kompletor z programem „bez programu” w jednym zapisie; z powrotem w jednym; błąd = nic nie zapisane', async () => {
    const przed = await widokDokumentow(a)
    expect(przed.zrodloStanu).toBe('WFIRMA')
    const bez = programy.find((p) => p.program !== 'wfirma')!.program
    // osobno ten zapis by się nie udał (program inny niż wFirma przy lustrze), razem: najpierw źródło, potem program
    expect(await zapiszDokumentySprzedazy(a, { zrodlo: 'KOMPLETOR', dokumenty: formularz({ program: bez }) }, 'u-a', programy)).toEqual({ zrodlo: true, dokumenty: true })
    let v = await widokDokumentow(a)
    expect([v.zrodloStanu, v.ustawienia.program]).toEqual(['KOMPLETOR', bez])
    // z powrotem: najpierw program wFirma, potem lustro
    expect(await zapiszDokumentySprzedazy(a, { zrodlo: 'WFIRMA', dokumenty: formularz({}) }, 'u-a', programy)).toEqual({ zrodlo: true, dokumenty: true })
    v = await widokDokumentow(a)
    expect([v.zrodloStanu, v.ustawienia.program]).toEqual(['WFIRMA', 'wfirma'])
    // to samo jeszcze raz: nic się nie zmienia, bez wpisów w historii
    const logi = await a.auditLog.count()
    expect(await zapiszDokumentySprzedazy(a, { zrodlo: 'WFIRMA', dokumenty: formularz({}) }, 'u-a', programy)).toEqual({ zrodlo: false, dokumenty: false })
    expect(await a.auditLog.count()).toBe(logi)
    // błąd w drugiej części (przy lustrze program inny niż wFirma, bez zmiany źródła): całość odrzucona
    await expect(zapiszDokumentySprzedazy(a, { zrodlo: 'WFIRMA', dokumenty: formularz({ program: bez }) }, 'u-a', programy)).rejects.toBeInstanceOf(UstawieniaDokumentowError)
    // zmiana źródła + zły formularz (dokument przed wysyłką bez programu): źródło zostaje
    await expect(zapiszDokumentySprzedazy(a, { zrodlo: 'KOMPLETOR', dokumenty: formularz({ program: 'brak', przedWysylka: 'tak' }) }, 'u-a', programy)).rejects.toThrow(/wymaga programu/)
    expect((await widokDokumentow(a)).zrodloStanu).toBe('WFIRMA')
    // druga firma bez zmian
    expect((await widokDokumentow(b)).zrodloStanu).toBe('WFIRMA')
  })
})

describe('kod stanowiska druku z nazwy', () => {
  it('pusty kod = z nazwy, zajęty = końcówka -2; kod podany i zajęty = odmowa', async () => {
    const id1 = await dodajStanowisko(a, { code: '', name: 'Pakowanie przy oknie' }, 'u-a')
    const id2 = await dodajStanowisko(a, { code: '', name: 'Pakowanie przy oknie' }, 'u-a')
    const kody = await a.printStation.findMany({ where: { id: { in: [id1, id2] } }, select: { code: true }, orderBy: { code: 'asc' } })
    expect(kody.map((k) => k.code)).toEqual(['pakowanie-przy-oknie', 'pakowanie-przy-oknie-2'])
    await expect(dodajStanowisko(a, { code: 'pakowanie-przy-oknie', name: 'Inne' }, 'u-a')).rejects.toThrow(/już jest/)
    // inna firma może mieć ten sam kod
    await dodajStanowisko(b, { code: '', name: 'Pakowanie przy oknie' }, 'u-b')
    expect((await b.printStation.findFirstOrThrow()).code).toBe('pakowanie-przy-oknie')
  })
})

describe('drugie konto przewoźnika z panelu', () => {
  it('Dodaj konto → karta konta, klucze z sufiksem, wybór konta w regule; konto trwałe = usunięcie reguły bez potwierdzenia', async () => {
    expect(sufiksZNazwy('Salony Empik')).toBe('SALONYEMPIK')
    expect(sufiksZNazwy('2 marka')).toBe('K2MARKA')
    const k = await dodajKontoPrzewoznika(a, registry, { konto: 'dpd', nazwa: 'Salony Empik' }, 'u-a')
    expect(k).toEqual({ konto: 'dpd', sufiks: 'SALONYEMPIK', nazwa: 'Salony Empik' })
    await expect(dodajKontoPrzewoznika(a, registry, { konto: 'dpd', nazwa: 'Salony Empik' }, 'u-a')).rejects.toBeInstanceOf(KontoPrzewoznikaError)
    await expect(dodajKontoPrzewoznika(a, registry, { konto: 'nie-ma', nazwa: 'X' }, 'u-a')).rejects.toThrow(/z listy/)
    const konta = await kontaPrzewoznikow(a, registry)
    const drugie = konta.find((x) => x.id === 'dpd~SALONYEMPIK')!
    expect(drugie.nazwa).toMatch(/\(konto Salony Empik\)$/)
    expect(drugie.glowne).toBe('dpd')
    expect(drugie.moduly.length).toBeGreaterThan(0)
    expect(await a.auditLog.count({ where: { entity: 'Organization.przewoznicy.konta' } })).toBe(1)
    // druga firma go nie widzi
    expect((await kontaPrzewoznikow(b, registry)).some((x) => x.id === 'dpd~SALONYEMPIK')).toBe(false)

    // reguła z modułem DPD wskazuje drugie konto (kolumna „Konto”)
    const modul = drugie.moduly[0]!
    const przed = await regulyPrzewoznikow(a, registry)
    const wej = (r: (typeof przed)[number]) => ({ id: r.id, channel: r.channel ?? '', pattern: r.pattern ?? '', carrier: r.carrier, adapterKey: r.adapterKey ?? '' })
    await zapiszRegulyPrzewoznikow(a, registry, [...przed.map(wej), { id: null, channel: '', pattern: 'salon dpd', carrier: 'DPD_EMPIK', adapterKey: modul, konto: 'SALONYEMPIK' }], 'u-a')
    let po = await regulyPrzewoznikow(a, registry)
    const nowa = po.find((r) => r.pattern === 'salon dpd')!
    expect(nowa.konto).toBe('SALONYEMPIK')
    expect((await kontaPrzewoznikow(a, registry)).find((x) => x.id === 'dpd~SALONYEMPIK')!.reguly.map((r) => r.id)).toEqual([nowa.id])
    // zły sufiks: odmowa przy polu
    const e = (await zapiszRegulyPrzewoznikow(a, registry, po.map((r) => ({ ...wej(r), konto: r.id === nowa.id ? 'zły sufiks' : (r.konto ?? '') })), 'u-a').catch((x: unknown) => x)) as RegulyError
    expect(e.pole).toMatch(/regula-\d+-konto/)
    // konto dodane z panelu zostaje bez reguły → usunięcie reguły bez potwierdzenia
    expect(nowa.potwierdzenie).toBeNull()
    await zapiszRegulyPrzewoznikow(a, registry, po.filter((r) => r.id !== nowa.id).map(wej), 'u-a')
    po = await regulyPrzewoznikow(a, registry)
    expect(po.some((r) => r.id === nowa.id)).toBe(false)
    expect((await kontaPrzewoznikow(a, registry)).some((x) => x.id === 'dpd~SALONYEMPIK')).toBe(true)
    // przeniesienie reguły na konto główne czyści sekretyKonta i pola konta (courierCode modułu reguły)
    const dpd = po.find((r) => r.carrier === 'DPD')!
    await a.carrierRule.update({ where: { id: dpd.id }, data: { config: { sekretyKonta: 'SALONYEMPIK', courierCode: 'dpd' } } })
    await zapiszRegulyPrzewoznikow(a, registry, (await regulyPrzewoznikow(a, registry)).map((r) => ({ ...wej(r), konto: '' })), 'u-a')
    expect((await a.carrierRule.findUniqueOrThrow({ where: { id: dpd.id } })).config).toEqual({})
  })

  it('przeniesienie reguły na inne konto czyści pola konta poprzedniego i wyłącza nadawanie; konto spoza rodziny = odmowa', async () => {
    await dodajKontoPrzewoznika(a, registry, { konto: 'dpd', nazwa: 'Salony Empik' }, 'u-a')
    // moduł z zapisem (ma wyłącznik nadawania)
    const modul = (await kontaPrzewoznikow(a, registry)).find((x) => x.id === 'dpd~SALONYEMPIK')!.moduly.find((m) => registry.get(m)!.manifest.config.some((f) => f.key === 'zapisWlaczony'))!
    const wej = (r: Awaited<ReturnType<typeof regulyPrzewoznikow>>[number]) => ({ id: r.id, channel: r.channel ?? '', pattern: r.pattern ?? '', carrier: r.carrier, adapterKey: r.adapterKey ?? '', konto: r.konto ?? '' })
    await zapiszRegulyPrzewoznikow(a, registry, [...(await regulyPrzewoznikow(a, registry)).map(wej), { id: null, channel: '', pattern: 'kurier dpd', carrier: 'DPD', adapterKey: modul, konto: '' }], 'u-a')
    const r = (await regulyPrzewoznikow(a, registry)).find((x) => x.pattern === 'kurier dpd')!
    // konto główne: FID płatnika, FID konta głównego, format etykiety i włączone nadawanie
    await a.carrierRule.update({ where: { id: r.id }, data: { config: { payerFid: '111', masterFid: '222', labelFormat: 'A4', zapisWlaczony: true } } })

    // konto, którego nie ma u tego przewoźnika, i konto przy regule bez modułu wysyłki: odmowa przy polu, nic nie zapisane
    const lista = await regulyPrzewoznikow(a, registry)
    const nr = lista.findIndex((x) => x.id === r.id)
    const foo = (await zapiszRegulyPrzewoznikow(a, registry, lista.map((x) => (x.id === r.id ? { ...wej(x), konto: 'FOO' } : wej(x))), 'u-a').catch((e: unknown) => e)) as RegulyError
    expect(foo).toBeInstanceOf(RegulyError)
    expect(foo.pole).toBe(`regula-${nr}-konto`)
    const bezModulu = (await zapiszRegulyPrzewoznikow(a, registry, [...lista.map(wej), { id: null, channel: '', pattern: 'bez modułu', carrier: 'DPD', adapterKey: '', konto: 'SALONYEMPIK' }], 'u-a').catch((e: unknown) => e)) as RegulyError
    expect(bezModulu.pole).toBe(`regula-${lista.length}-modul`)
    expect((await a.carrierRule.findUniqueOrThrow({ where: { id: r.id } })).config).toEqual({ payerFid: '111', masterFid: '222', labelFormat: 'A4', zapisWlaczony: true })

    // przeniesienie na „Salony Empik”: zostaje tylko konto, nadawanie wyłączone, wynik mówi, którą regułę przeniesiono
    const wynik = await zapiszRegulyPrzewoznikow(a, registry, lista.map((x) => (x.id === r.id ? { ...wej(x), konto: 'SALONYEMPIK' } : wej(x))), 'u-a')
    expect(wynik.przeniesione).toEqual([{ nr: nr + 1, konto: 'SALONYEMPIK', adapterKey: modul }])
    expect((await a.carrierRule.findUniqueOrThrow({ where: { id: r.id } })).config).toEqual({ sekretyKonta: 'SALONYEMPIK' })
    // karta konta „Salony Empik” nie pokazuje FID konta głównego; nadawanie do włączenia
    const karta = (await kontaPrzewoznikow(a, registry)).find((x) => x.id === 'dpd~SALONYEMPIK')!
    expect(karta.reguly).toEqual([expect.objectContaining({ id: r.id, nadawanie: false })])
    for (const k of ['payerFid', 'masterFid', 'labelFormat']) expect(karta.pola.find((p) => p.key === k)?.wartosc ?? '').toBe('')
    // ponowny zapis tej samej listy: bez zmian, nic nie przeniesione
    expect(await zapiszRegulyPrzewoznikow(a, registry, (await regulyPrzewoznikow(a, registry)).map(wej), 'u-a')).toEqual({ reguly: lista.length, zmienione: false, przeniesione: [] })
    // ustawienie spoza panelu (adres serwera) przy przeniesieniu z powrotem zostaje
    await a.carrierRule.update({ where: { id: r.id }, data: { config: { sekretyKonta: 'SALONYEMPIK', baseUrl: 'https://dpdservicesdemo.dpd.com.pl', payerFid: '333', zapisWlaczony: true } } })
    await zapiszRegulyPrzewoznikow(a, registry, (await regulyPrzewoznikow(a, registry)).map((x) => (x.id === r.id ? { ...wej(x), konto: '' } : wej(x))), 'u-a')
    expect((await a.carrierRule.findUniqueOrThrow({ where: { id: r.id } })).config).toEqual({ baseUrl: 'https://dpdservicesdemo.dpd.com.pl' })
  })

  it('priorytety w bazie inne niż 10, 20, … przy tej samej kolejności = bez zapisu i bez wpisu w historii', async () => {
    const przed = await regulyPrzewoznikow(a, registry)
    expect(przed.length).toBeGreaterThan(1)
    for (const [i, r] of przed.entries()) await a.carrierRule.update({ where: { id: r.id }, data: { priority: 1000 + i * 7 } })
    const wej = przed.map((r) => ({ id: r.id, channel: r.channel ?? '', pattern: r.pattern ?? '', carrier: r.carrier, adapterKey: r.adapterKey ?? '' }))
    expect((await zapiszRegulyPrzewoznikow(a, registry, wej, 'u-a')).zmienione).toBe(false)
    expect(await a.auditLog.count({ where: { entity: 'CarrierRule' } })).toBe(0)
    // inna kolejność = zapis
    expect((await zapiszRegulyPrzewoznikow(a, registry, [...wej].reverse(), 'u-a')).zmienione).toBe(true)
  })

  it('ta sama lista reguł = bez zapisu i bez wpisu w historii; sam wyłącznik nadawania bez potwierdzenia', async () => {
    const przed = await regulyPrzewoznikow(a, registry)
    const wej = przed.map((r) => ({ id: r.id, channel: r.channel ?? '', pattern: r.pattern ?? '', carrier: r.carrier, adapterKey: r.adapterKey ?? '' }))
    expect(await zapiszRegulyPrzewoznikow(a, registry, wej, 'u-a')).toEqual({ reguly: przed.length, zmienione: false, przeniesione: [] })
    expect(await a.auditLog.count({ where: { entity: 'CarrierRule' } })).toBe(0)
    // reguła z samym „Nadawanie z Kompletora” i polem konta z manifestu: usuwa się bez pytania (panel to odtworzy)
    const r = przed.find((x) => x.adapterKey)!
    const pole = registry.get(r.adapterKey!)!.manifest.config.find((f) => !['envPrefix', 'baseUrl', 'nadawca', 'sekretyKonta', 'zapisWlaczony'].includes(f.key))
    await a.carrierRule.update({ where: { id: r.id }, data: { config: { zapisWlaczony: true, ...(pole ? { [pole.key]: 'x' } : {}) } } })
    const z = (await regulyPrzewoznikow(a, registry)).find((x) => x.id === r.id)!
    expect(z.konfiguracja).toMatch(/nadawanie z Kompletora: włączone/)
    expect(z.potwierdzenie).toBeNull()
    await zapiszRegulyPrzewoznikow(a, registry, wej.filter((x) => x.id !== r.id), 'u-a')
    expect(await a.carrierRule.count({ where: { id: r.id } })).toBe(0)
    // ustawienie spoza panelu (adres serwera przewoźnika) dalej wymaga potwierdzenia
    const r2 = (await regulyPrzewoznikow(a, registry)).find((x) => x.adapterKey)!
    await a.carrierRule.update({ where: { id: r2.id }, data: { config: { baseUrl: 'https://sandbox.example.invalid' } } })
    expect((await regulyPrzewoznikow(a, registry)).find((x) => x.id === r2.id)!.potwierdzenie).toMatch(/baseUrl/)
    await expect(zapiszRegulyPrzewoznikow(a, registry, (await regulyPrzewoznikow(a, registry)).filter((x) => x.id !== r2.id).map((x) => ({ id: x.id, channel: x.channel ?? '', pattern: x.pattern ?? '', carrier: x.carrier, adapterKey: x.adapterKey ?? '' })), 'u-a')).rejects.toThrow(/Potwierdź usunięcie/)
  })

  it('klucze z konfiguracji serwera (self-host) to stan „serwer”; klucz z sufiksem w bazie tworzy konto; test pod blokadą', async () => {
    const env = { ...ENV, DPD_LOGIN: 'login-z-env', DPD_PASSWORD: 'haslo-z-env', DPD_MYPUDO_KEY: 'klucz' }
    const dpd = (await kontaPrzewoznikow(a, registry, { env, envFallback: true })).find((x) => x.id === 'dpd')!
    expect(dpd.sekrety.map((s) => s.zrodlo)).toEqual(['serwer', 'serwer', 'serwer'])
    expect(dpd.sekrety.every((s) => s.ustawiony)).toBe(true)
    // hosting (bez fallbacku na env): brak
    expect((await kontaPrzewoznikow(a, registry, { env, envFallback: false })).find((x) => x.id === 'dpd')!.sekrety.every((s) => s.zrodlo === null)).toBe(true)
    // klucz zapisany w panelu wygrywa nazwą źródła
    await setSecret(a, 'DPD_LOGIN', 'login-z-panelu', ENV)
    expect((await kontaPrzewoznikow(a, registry, { env, envFallback: true })).find((x) => x.id === 'dpd')!.sekrety[0]!.zrodlo).toBe('panel')
    // klucz drugiego konta sprzed panelu (DPD_LOGIN_EMPIK) = konto na liście
    await setSecret(a, 'DPD_LOGIN_EMPIK', 'login-empik', ENV)
    expect((await kontaPrzewoznikow(a, registry)).some((x) => x.id === 'dpd~EMPIK')).toBe(true)
    // dwa testy naraz: oba wyniki zostają w ustawieniach firmy
    const fetch = async () => new Response('{}', { status: 401 })
    await Promise.all(['inpost', 'basecourier'].map((konto) => wykonajTestKonta(a, { konto }, { registry, secrets: { env: ENV, envFallback: false }, fetch })))
    const k = await kontaPrzewoznikow(a, registry)
    expect(k.find((x) => x.id === 'inpost')!.test).not.toBeNull()
    expect(k.find((x) => x.id === 'basecourier')!.test).not.toBeNull()
  })
})

describe('braki: szukanie w bazie, ukryte przy zamkniętych, decyzja grupy porcjami', () => {
  it('i licznik menu = zakładka „Brakuje”', async () => {
    const herb = await product(a, 'HERB-1', 0)
    const kawa = await product(a, 'KAWA-1', 0)
    const o1 = (await ingestOrder(a, order([{ productId: herb, qty: 1 }]))).orderId!
    await ingestOrder(a, order([{ productId: kawa, qty: 2 }]))
    const o3 = (await ingestOrder(a, order([{ productId: kawa, qty: 1 }]))).orderId!
    await a.order.update({ where: { id: o3 }, data: { status: 'WYSLANE' } })
    expect((await pozycjeBrakow(a, { q: 'herb' })).map((p) => p.order.id)).toEqual([o1])
    const ext = (await a.order.findUniqueOrThrow({ where: { id: o1 } })).externalId
    expect((await pozycjeBrakow(a, { q: ext })).map((p) => p.order.id)).toEqual([o1])
    expect(await liczbaBrakow(a)).toBe(2)
    expect(await liczbaBrakow(a, { q: 'kawa' })).toBe(1)
    expect(await ukrytePrzyZamknietych(a)).toBe(1)
    expect(await ukrytePrzyZamknietych(a, { q: 'herb' })).toBe(0)
    // menu liczy to samo co zakładka (bez braku przy zamówieniu wysłanym)
    expect((await navCounts(a)).shortages).toBe(2)
    expect(await liczbaBrakow(b)).toBe(0)
  })

  it('druga decyzja dla tej samej grupy pomija już zdecydowane pozycje', async () => {
    const herb = await product(a, 'HERB-1', 0)
    for (let i = 0; i < 3; i++) await ingestOrder(a, order([{ productId: herb, qty: 1 }]))
    const linie = await linieProduktow(a, [herb], {})
    expect(await zdecydujMasowo(a, linie.slice(0, 2), 'DOSLIJ', 'u-a')).toEqual({ zapisane: 2, bezZmian: 0, pominiete: 0, bledy: [] })
    expect(await zdecydujMasowo(a, linie, 'DOSLIJ', 'u-a')).toEqual({ zapisane: 1, bezZmian: 2, pominiete: 0, bledy: [] })
    expect(LIMIT_MASOWY).toBe(500)
  })
})
