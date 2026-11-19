// przypisanie rodzaju wydruku do drukarki innego komputera tej samej firmy. Zlecenie trafia do kolejki
// komputera z drukarką (pobiera je tylko jego program druku), zapas zostaje w jego obrębie, stanowisko może nie mieć
// własnego programu, stary kształt `routing` działa bez zmian, granica firm sprawdzana przy zapisie i przy zleceniu.
// Dane wyłącznie fikcyjne.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { stanowiskaDlaPanelu, statusZlecenia, zlecZPanelu } from '@/lib/druk/panel'
import { dodajStanowisko, ktoKorzystaZDrukarek, nowyToken, stanowiskaUstawien, uniewaznijToken, ustawRouting, ustawWylaczenie } from '@/lib/druk/stanowiska'
import { resetLimitowDruku } from '@/lib/druk/tokeny'
import { BladDruku, utworzZlecenie } from '@/lib/druk/zlecenia'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { drukarka, fetchDruku, raportStanu, SERWER, stanowiskoZTokenem, zadanie, zaleznosci } from './druk-pomocnicze'
import { order, product, seedBase } from './rdzen-fixtures'

vi.mock('server-only', () => ({}))

const sys = testSystemDb()
const a = testDb()
const b = testDb({ organizationId: ORG_B })
const deps = zaleznosci(sys, { [ORG_A]: a, [ORG_B]: b })
let teraz = new Date('2026-11-04T08:00:00Z')
const f = fetchDruku(deps, () => teraz)
const KTO = { userId: 'uzytkownik-testowy', nazwa: 'Magazyn Testowy' }
let klik = 0
const klucz = () => `klik-a304-${String(++klik).padStart(10, '0')}`

beforeEach(async () => {
  await truncateAll()
  await seedBase(a)
  await seedBase(b)
  resetLimitowDruku()
  teraz = new Date('2026-11-04T08:00:00Z')
})
afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})

async function gotowe(db: PrismaClient, code: string, nazwa: string, drukarki: object[]) {
  const s = await stanowiskoZTokenem(db, code, nazwa)
  await raportStanu(f, s.token, s.code, drukarki)
  return s
}

const lista = async (token: string, code: string) => {
  const r = await zadanie(f, token, 'GET', `/api/druk/zlecenia?stanowisko=${code}`)
  expect(r.status).toBe(200)
  return ((await r.json()) as { zlecenia: { id: string; typ: string; format: string; rola: string }[] }).zlecenia
}

const rysuj = async () => ({ pliki: { pdf: Buffer.from('%PDF-1.7 test'), zpl: Buffer.from('^XA^CI28^FDzażółć^FS^XZ') } })
const zlec = (db: PrismaClient, stationId: string, typ: 'karta' | 'lista' | 'etykieta', k = klucz()) =>
  utworzZlecenie(db, { stationId, typ, zrodlo: 'PANEL', klucz: k, now: teraz, rysuj })
const blad = async (p: Promise<unknown>) => {
  const e = await p.catch((x: unknown) => x)
  expect(e).toBeInstanceOf(BladDruku)
  return e as BladDruku
}

/** Magazyn: „Pakowanie” z termiczną, „Biuro” z A4 i drugą A4. */
async function magazyn() {
  const pak = await gotowe(a, 'pakowanie', 'Pakowanie', [drukarka('TERMICZNA_1'), drukarka('TERMICZNA_2')])
  const biuro = await gotowe(a, 'biuro', 'Komputer w biurze', [drukarka('A4'), drukarka('A4_2')])
  return { pak, biuro }
}

describe('drukarki innych komputerów', () => {
  it('karta ze stanowiska pakowania trafia do kolejki komputera w biurze; etykieta zostaje na pakowaniu', async () => {
    const { pak, biuro } = await magazyn()
    await ustawRouting(a, pak.id, { karta: `${biuro.id}:A4`, lista: `${biuro.id}:A4_2`, etykieta: 'TERMICZNA_1' }, 'u')
    expect((await a.printStation.findUniqueOrThrow({ where: { id: pak.id } })).routing).toEqual({
      karta: { stanowisko: biuro.id, rola: 'A4' },
      lista: { stanowisko: biuro.id, rola: 'A4_2' },
      spis: 'A4',
      etykieta: 'TERMICZNA_1',
    })
    const karta = (await zlec(a, pak.id, 'karta')).zlecenie
    const ety = (await zlec(a, pak.id, 'etykieta')).zlecenie
    expect(karta).toMatchObject({ stationId: biuro.id, role: 'A4', format: 'pdf', status: 'OCZEKUJE' })
    expect(ety).toMatchObject({ stationId: pak.id, role: 'TERMICZNA_1', format: 'zpl' })
    // każdy program druku widzi i pobiera wyłącznie swoją kolejkę
    expect((await lista(biuro.token, 'biuro')).map((x) => [x.id, x.rola])).toEqual([[karta.id, 'A4']])
    expect((await lista(pak.token, 'pakowanie')).map((x) => [x.id, x.rola])).toEqual([[ety.id, 'TERMICZNA_1']])
    expect((await zadanie(f, pak.token, 'GET', `/api/druk/pliki/${karta.id}`)).status).toBe(404)
    expect((await zadanie(f, biuro.token, 'GET', `/api/druk/pliki/${karta.id}`)).status).toBe(200)
    // wynik od niewłaściwego komputera = 404, od właściwego = zapis
    const wynik = (token: string, code: string, id: string, w: object) => zadanie(f, token, 'POST', `/api/druk/zlecenia/${id}/wynik`, { stanowisko: code, czas: '2026-11-04T08:00:01Z', ponowienieRaportu: false, ...w })
    expect((await wynik(pak.token, 'pakowanie', karta.id, { wynik: 'OK' })).status).toBe(404)
    expect((await wynik(biuro.token, 'biuro', karta.id, { wynik: 'OK', drukarka: 'Drukarka A4' })).status).toBe(200)
    // komunikat dla panelu: gdzie wyszło
    expect(await statusZlecenia(a, karta.id)).toMatchObject({ stanowisko: 'Komputer w biurze', cel: 'Komputer w biurze, A4', status: 'OK' })
    expect((await statusZlecenia(a, ety.id)).cel).toBe('Pakowanie, Termiczna 1')
  })

  it('przez panel (lista wysyłkowa): odpowiedź z komputerem i drukarką docelową', async () => {
    const { pak, biuro } = await magazyn()
    await ustawRouting(a, pak.id, { lista: `${biuro.id}:A4_2` }, 'u')
    const p = await product(a, 'SKU-A304-1', 10)
    const o1 = (await ingestOrder(a, order([{ productId: p, qty: 1 }], { externalId: 'a304-1', createdAtChannel: new Date() }))).orderId!
    const w = await zlecZPanelu(a, KTO, { typ: 'lista', ids: [o1], stationId: pak.id, klucz: klucz() }, { now: teraz })
    expect(w.zlecenie).toMatchObject({ stanowisko: 'Komputer w biurze', cel: 'Komputer w biurze, A4 nr 2', rola: 'A4_2', status: 'OCZEKUJE' })
    expect(await lista(pak.token, 'pakowanie')).toEqual([])
  })

  it('podwójny klik (ten sam klucz) = jedno zlecenie na komputerze docelowym; inne stanowisko z tym kluczem = 409', async () => {
    const { pak, biuro } = await magazyn()
    await ustawRouting(a, pak.id, { karta: `${biuro.id}:A4` }, 'u')
    const k = klucz()
    const pierwsze = await zlec(a, pak.id, 'karta', k)
    const drugie = await zlec(a, pak.id, 'karta', k)
    expect(drugie.istnialo).toBe(true)
    expect(drugie.zlecenie.id).toBe(pierwsze.zlecenie.id)
    expect(await a.printJob.count()).toBe(1)
    // ten sam klucz wysłany z komputera w biurze (karty tam = własna A4) to wciąż to samo zlecenie i ta sama kolejka
    expect((await zlec(a, biuro.id, 'karta', k)).istnialo).toBe(true)
    const trzecie = await gotowe(a, 'pakowanie-2', 'Pakowanie 2', [drukarka('A4')])
    expect((await blad(zlec(a, trzecie.id, 'karta', k))).status).toBe(409)
    expect(await a.printJob.count()).toBe(1)
  })

  it('zapas po awarii termicznej zostaje na komputerze, przy którym stoi drukarka (bez drugiej etykiety)', async () => {
    const { pak, biuro } = await magazyn()
    // etykiety stanowiska „Biuro” idą na termiczną przy pakowaniu
    await ustawRouting(a, biuro.id, { etykieta: `${pak.id}:TERMICZNA_1` }, 'u')
    const ety = (await zlec(a, biuro.id, 'etykieta')).zlecenie
    expect(ety.stationId).toBe(pak.id)
    // rola zapasowa z drugiego komputera (A4 biura) nie istnieje w raporcie pakowania = bez zapasu
    const wynik = (id: string, w: object) => zadanie(f, pak.token, 'POST', `/api/druk/zlecenia/${id}/wynik`, { stanowisko: 'pakowanie', czas: '2026-11-04T08:00:01Z', ponowienieRaportu: false, ...w })
    expect((await wynik(ety.id, { wynik: 'BLAD', komunikat: 'Brak etykiet', rolaZapasowa: 'A4' })).status).toBe(200)
    expect(await a.printJob.count()).toBe(1)
    expect((await a.printJob.findUniqueOrThrow({ where: { id: ety.id } })).resultMessage).toMatch(/bez zlecenia zapasowego \(drukarki A4 nie ma w ostatnim raporcie stanowiska\)/)
    // zapas na drugą termiczną tego samego komputera: w jego kolejce, raz
    const ety2 = (await zlec(a, biuro.id, 'etykieta')).zlecenie
    expect((await wynik(ety2.id, { wynik: 'BLAD', komunikat: 'Brak etykiet', rolaZapasowa: 'TERMICZNA_2' })).status).toBe(200)
    expect((await wynik(ety2.id, { wynik: 'BLAD', komunikat: 'Brak etykiet', rolaZapasowa: 'TERMICZNA_2' })).status).toBe(200)
    const zapasy = await a.printJob.findMany({ where: { source: 'ZAPAS' } })
    expect(zapasy.map((z) => [z.stationId, z.role, z.fallbackOfId])).toEqual([[pak.id, 'TERMICZNA_2', ety2.id]])
    expect((await lista(pak.token, 'pakowanie')).map((x) => x.id)).toEqual([zapasy[0]!.id])
    expect(await lista(biuro.token, 'biuro')).toEqual([])
  })

  it('stanowisko bez własnego programu drukuje na drukarkach innych komputerów; rodzaj bez drukarki = czytelny komunikat', async () => {
    const { pak, biuro } = await magazyn()
    const stol = await dodajStanowisko(a, { code: 'stol-2', name: 'Drugi stół' }, 'u')
    await ustawRouting(a, stol, { karta: `${biuro.id}:A4`, lista: `${biuro.id}:A4`, etykieta: `${pak.id}:TERMICZNA_2` }, 'u')
    expect((await zlec(a, stol, 'karta')).zlecenie).toMatchObject({ stationId: biuro.id, role: 'A4' })
    expect((await zlec(a, stol, 'etykieta')).zlecenie).toMatchObject({ stationId: pak.id, role: 'TERMICZNA_2', format: 'zpl' })
    // spis został na „własnej” A4, a stół nie ma programu druku
    const spis = await blad(utworzZlecenie(a, { stationId: stol, typ: 'spis', zrodlo: 'PANEL', klucz: klucz(), now: teraz, rysuj }))
    expect(spis.message).toMatch(/„Drugi stół” jeszcze nie zgłosiło drukarek/)
    const panel = (await stanowiskaDlaPanelu(a, teraz)).find((s) => s.id === stol)!
    expect(panel.maProgram).toBe(false)
    expect(panel.uzywane.map((u) => [u.typy, u.stanowisko, u.rola, u.wlasna, u.blad === null])).toEqual([
      [['karta', 'lista'], 'Komputer w biurze', 'A4', false, true],
      [['spis'], 'Drugi stół', 'A4', true, false],
      [['etykieta'], 'Pakowanie', 'TERMICZNA_2', false, true],
    ])
    expect(panel.uzywane[0]!.drukarka).toMatchObject({ rola: 'A4', nazwa: 'Drukarka A4', stan: 'DOSTEPNA' })
  })

  it('komputer docelowy wyłączony, bez tokenu albo milczący: zlecenie nie powstaje, komunikat nazywa komputer i drukarkę', async () => {
    const { pak, biuro } = await magazyn()
    await ustawRouting(a, pak.id, { karta: `${biuro.id}:A4` }, 'u')
    // milczący (brak raportu od 4 min); własna termiczna pakowania nadal działa jak dotąd
    teraz = new Date(teraz.getTime() + 4 * 60_000)
    expect((await blad(zlec(a, pak.id, 'karta'))).message).toMatch(/Karty zamówień ze stanowiska „Pakowanie” idą na drukarkę A4 komputera „Komputer w biurze”, a ten komputer nie odpowiada od 4 min/)
    expect((await zlec(a, pak.id, 'etykieta')).zlecenie.stationId).toBe(pak.id)
    await raportStanu(f, biuro.token, 'biuro', [drukarka('A4')])
    expect((await zlec(a, pak.id, 'karta')).zlecenie.stationId).toBe(biuro.id)
    // bez tokenu
    await uniewaznijToken(a, biuro.id, 'u')
    expect((await blad(zlec(a, pak.id, 'karta'))).message).toMatch(/„Komputer w biurze”, a program druku na tym komputerze nie ma tokenu/)
    // wyłączony (token przywrócony)
    await nowyToken(a, biuro.id, SERWER, 'u')
    await ustawWylaczenie(a, biuro.id, true, 'u')
    const e = await blad(zlec(a, pak.id, 'karta'))
    expect(e.status).toBe(409)
    expect(e.message).toMatch(/A4 komputera „Komputer w biurze”, a to stanowisko jest wyłączone/)
    expect(await a.printJob.count()).toBe(2)
    // drukarka zniknęła z raportu
    await ustawWylaczenie(a, biuro.id, false, 'u')
    await a.printStation.update({ where: { id: biuro.id }, data: { lastReportAt: teraz, printers: [drukarka('A4_2')] } })
    expect((await blad(zlec(a, pak.id, 'karta'))).message).toMatch(/nie zgłasza takiej drukarki \(A4\)/)
    // nagłówek pokazuje powód przy wybranym stanowisku
    const u = (await stanowiskaDlaPanelu(a, teraz)).find((s) => s.id === pak.id)!.uzywane.find((x) => x.typy.includes('karta'))!
    expect(u).toMatchObject({ stanowisko: 'Komputer w biurze', rola: 'A4', wlasna: false })
    expect(u.blad).toMatch(/nie zgłasza takiej drukarki/)
  })

  it('zapis przypisania: tylko włączone stanowisko z tą drukarką; ostrzeżenie przy wyłączaniu wymienia, kogo to dotknie', async () => {
    const { pak, biuro } = await magazyn()
    await expect(ustawRouting(a, pak.id, { karta: `${biuro.id}:TERMICZNA_1` }, 'u')).rejects.toThrow(/„Komputer w biurze” nie zgłasza drukarki TERMICZNA_1/)
    await expect(ustawRouting(a, pak.id, { karta: 'nieistnieje:A4' }, 'u')).rejects.toThrow(/Nie ma takiego stanowiska/)
    await expect(ustawRouting(a, pak.id, { karta: `${biuro.id}:` }, 'u')).rejects.toThrow(/Nieznana rola/)
    // wskazanie samego siebie = własna drukarka, zapis w starym kształcie
    await ustawRouting(a, pak.id, { etykieta: `${pak.id}:TERMICZNA_2` }, 'u')
    expect(((await a.printStation.findUniqueOrThrow({ where: { id: pak.id } })).routing as Record<string, unknown>).etykieta).toBe('TERMICZNA_2')
    await ustawRouting(a, pak.id, { karta: `${biuro.id}:A4`, spis: `${biuro.id}:A4` }, 'u')
    // ponowny zapis tego samego przypisania przechodzi, nawet gdy cel jest już wyłączony (formularz wysyła wszystkie pola)
    await ustawWylaczenie(a, biuro.id, true, 'u')
    await ustawRouting(a, pak.id, { karta: `${biuro.id}:A4`, etykieta: 'TERMICZNA_1' }, 'u')
    await expect(ustawRouting(a, pak.id, { lista: `${biuro.id}:A4` }, 'u')).rejects.toThrow(/„Komputer w biurze” jest wyłączone/)
    await ustawWylaczenie(a, biuro.id, false, 'u')
    const wszystkie = await stanowiskaUstawien(a)
    expect(ktoKorzystaZDrukarek(biuro.id, wszystkie)).toEqual([{ nazwa: 'Pakowanie', typy: ['karta', 'spis'] }])
    expect(ktoKorzystaZDrukarek(pak.id, wszystkie)).toEqual([])
    expect(wszystkie.find((s) => s.id === pak.id)!.przypisania.karta).toEqual({ rola: 'A4', stanowisko: biuro.id })
    // audyt zapisu bez tokenów, z kształtem przypisania
    const log = await a.auditLog.findFirstOrThrow({ where: { entity: 'PrintStation', entityId: pak.id }, orderBy: { createdAt: 'desc' } })
    expect(JSON.stringify(log.after)).toContain(biuro.id)
  })

  it('zgodność wstecz: istniejące `routing` (same role) i stanowiska bez przypisań drukują jak dotąd', async () => {
    const s = await gotowe(a, 'magazyn-1', 'Magazyn', [drukarka('A4'), drukarka('A4_2'), drukarka('TERMICZNA_1')])
    await a.printStation.update({ where: { id: s.id }, data: { routing: { karta: 'A4_2', lista: 'A4', etykieta: 'TERMICZNA_1' } } })
    expect((await zlec(a, s.id, 'karta')).zlecenie).toMatchObject({ stationId: s.id, role: 'A4_2' })
    expect((await zlec(a, s.id, 'etykieta')).zlecenie).toMatchObject({ stationId: s.id, role: 'TERMICZNA_1', format: 'zpl' })
    await a.printStation.update({ where: { id: s.id }, data: { routing: {} } })
    expect((await zlec(a, s.id, 'lista')).zlecenie).toMatchObject({ stationId: s.id, role: 'A4' })
    expect((await stanowiskaDlaPanelu(a, teraz))[0]!.uzywane.every((u) => u.wlasna)).toBe(true)
  })
})

describe('granica firm', () => {
  it('przypisanie nie może wskazać stanowiska innej firmy: odmowa przy zapisie i przy zleceniu, nic nie trafia do kolejki firmy B', async () => {
    const sa = await gotowe(a, 'pakowanie', 'Pakowanie', [drukarka('TERMICZNA_1')])
    const sb = await gotowe(b, 'biuro', 'Biuro firmy B', [drukarka('A4')])
    await expect(ustawRouting(a, sa.id, { karta: `${sb.id}:A4` }, 'u')).rejects.toThrow(/Nie ma takiego stanowiska/)
    // wpis z pominięciem formularza (np. import, ręczna zmiana w bazie): zlecenie i tak nie powstaje
    await a.printStation.update({ where: { id: sa.id }, data: { routing: { karta: { stanowisko: sb.id, rola: 'A4' } } } })
    const e = await blad(zlec(a, sa.id, 'karta'))
    expect(e.status).toBe(409)
    expect(e.message).toMatch(/na komputerze, którego nie ma w tej firmie/)
    expect(e.message).not.toContain('Biuro firmy B')
    expect(await sys.printJob.count()).toBe(0)
    expect(await lista(sb.token, 'biuro')).toEqual([])
    // nagłówek firmy A nie zdradza nazwy stanowiska firmy B
    const u = (await stanowiskaDlaPanelu(a, teraz))[0]!.uzywane.find((x) => x.typy.includes('karta'))!
    expect(u).toMatchObject({ stanowisko: 'nieznany komputer', drukarka: null })
    expect(JSON.stringify(await stanowiskaDlaPanelu(a, teraz))).not.toContain('Biuro firmy B')
    // firma B nie korzysta z przypisań firmy A: jej własne zlecenia idą jak dotąd
    expect((await zlec(b, sb.id, 'karta')).zlecenie.stationId).toBe(sb.id)
    expect(await a.printJob.count()).toBe(0)
  })

  it('ten sam kod stanowiska w dwóch firmach: przypisanie po id, nie po kodzie, więc nie myli firm', async () => {
    const pa = await gotowe(a, 'pakowanie', 'Pakowanie A', [drukarka('TERMICZNA_1')])
    const ba = await gotowe(a, 'biuro', 'Biuro A', [drukarka('A4')])
    const bb = await gotowe(b, 'biuro', 'Biuro B', [drukarka('A4')])
    await ustawRouting(a, pa.id, { karta: `${ba.id}:A4` }, 'u')
    const k = (await zlec(a, pa.id, 'karta')).zlecenie
    expect(k.stationId).toBe(ba.id)
    expect((await lista(bb.token, 'biuro')).map((x) => x.id)).toEqual([])
    expect((await lista(ba.token, 'biuro')).map((x) => x.id)).toEqual([k.id])
  })
})
