// serwer druku. Trasy agenta /api/druk (token stanowiska), kolejka zleceń, zapas, wygasanie, druk z panelu
// (karty przez kolejkę z zachowaniem OrderCardPrint), etykieta próbna, sprzątanie, izolacja dwóch firm (RLS).
// Trasy wołane przez `fetchDruku` (tests/druk-pomocnicze.ts) = to samo, co pliki app/api/druk/**/route.ts.
// Dane wyłącznie fikcyjne (domena example.invalid).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { tokenHash } from '@/lib/auth/sesje'
import { NAPIS_PROBY } from '@/lib/druk/etykieta'
import { parsujZlecenieZPanelu, stanowiskaDlaPanelu, statusZleceniaLubNull, wydrukTestowy, zlecZPanelu } from '@/lib/druk/panel'
import { adresSerwera, kodInstalacyjny, nowyToken, ustawRouting, ustawWylaczenie, uniewaznijToken } from '@/lib/druk/stanowiska'
import { resetLimitowDruku, requireStationToken, WZOR_TOKENU } from '@/lib/druk/tokeny'
import { BladDruku, KOMUNIKAT_BLEDU_PLIKU, KOMUNIKAT_WYGASLO, komunikatBleduZapisu, sprzatajDruk, utworzZlecenie, WAZNOSC_MS, zapiszWynik } from '@/lib/druk/zlecenia'
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
const PELNY = [drukarka('A4'), drukarka('TERMICZNA_1'), drukarka('TERMICZNA_2')]
let klik = 0
const klucz = () => `klik-testowy-${String(++klik).padStart(8, '0')}`

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

async function zamowienie(db: PrismaClient, externalId: string) {
  const p = await product(db, `SKU-${externalId}`, 10)
  return (await ingestOrder(db, order([{ productId: p, qty: 1 }], { externalId, createdAtChannel: new Date() }))).orderId!
}

/** Stanowisko z tokenem i raportem stanu (agent 0.2.0 z A4 i dwiema termicznymi). */
async function gotowe(db: PrismaClient = a, code = 'magazyn-1', drukarki: object[] = PELNY) {
  const s = await stanowiskoZTokenem(db, code)
  await raportStanu(f, s.token, s.code, drukarki)
  return s
}

const lista = async (token: string, code: string) => {
  const r = await zadanie(f, token, 'GET', `/api/druk/zlecenia?stanowisko=${code}`)
  expect(r.status).toBe(200)
  return ((await r.json()) as { zlecenia: { id: string; typ: string; format: string; rola: string; plikUrl: string; kopie: number }[] }).zlecenia
}

/** Zlecenie testowe przez prawdziwą kolejkę (bez danych zamówień): etykieta ZPL+PDF albo PDF. */
async function zlecenie(db: PrismaClient, stationId: string, typ: 'etykieta' | 'lista' = 'etykieta') {
  const w = await utworzZlecenie(db, {
    stationId,
    typ,
    zrodlo: 'PANEL',
    klucz: klucz(),
    now: teraz,
    rysuj: async () => ({ pliki: { pdf: Buffer.from('%PDF-1.7 test'), zpl: Buffer.from('^XA^CI28^FDzażółć^FS^XZ') } }),
  })
  return w.zlecenie
}

const wynik = (token: string, id: string, tresc: object) => zadanie(f, token, 'POST', `/api/druk/zlecenia/${id}/wynik`, { czas: '2026-11-04T08:00:01Z', ponowienieRaportu: false, ...tresc })

describe('token stanowiska', () => {
  it('format kmd_ + 43 znaki; w bazie tylko SHA-256; kod instalacyjny kmi_ z adresem, stanowiskiem i tokenem', async () => {
    const s = await stanowiskoZTokenem(a)
    expect(s.token).toMatch(WZOR_TOKENU)
    const w = await a.printStation.findUniqueOrThrow({ where: { id: s.id } })
    expect(w.tokenHash).toBe(tokenHash(s.token))
    expect(JSON.stringify(w)).not.toContain(s.token)
    expect(s.kod.startsWith('kmi_')).toBe(true)
    expect(JSON.parse(Buffer.from(s.kod.slice(4), 'base64url').toString('utf8'))).toEqual({ serwer: SERWER, stanowisko: 'magazyn-1', token: s.token })
    expect(kodInstalacyjny(SERWER, 'x', s.token)).toMatch(/^kmi_[A-Za-z0-9_-]+$/)
    // AuditLog bez tokenu
    expect(JSON.stringify(await a.auditLog.findMany())).not.toContain(s.token)
  })

  it('401 tak samo dla: braku, złego formatu, nieznanego, unieważnionego, zastąpionego, wyłączonego stanowiska i nieaktywnej firmy', async () => {
    const s = await gotowe()
    const pytaj = (token: string) => zadanie(f, token, 'GET', '/api/druk/zlecenia?stanowisko=magazyn-1')
    expect((await pytaj(s.token)).status).toBe(200)
    const tresc401 = async (token: string) => {
      const r = await pytaj(token)
      expect(r.status, token.slice(0, 8)).toBe(401)
      return r.json()
    }
    const wzor = await tresc401('kmd_' + 'x'.repeat(43))
    expect(await tresc401('zly')).toEqual(wzor)
    expect((await f(`${SERWER}/api/druk/zlecenia?stanowisko=magazyn-1`)).status).toBe(401)
    // nowy token unieważnia poprzedni od razu
    const { token: nowy } = await nowyToken(a, s.id, SERWER, 'u')
    expect(await tresc401(s.token)).toEqual(wzor)
    expect((await pytaj(nowy)).status).toBe(200)
    await ustawWylaczenie(a, s.id, true, 'u')
    expect(await tresc401(nowy)).toEqual(wzor)
    await ustawWylaczenie(a, s.id, false, 'u')
    expect((await pytaj(nowy)).status).toBe(200)
    await sys.organization.update({ where: { id: ORG_A }, data: { active: false } })
    try {
      expect(await tresc401(nowy)).toEqual(wzor)
    } finally {
      await sys.organization.update({ where: { id: ORG_A }, data: { active: true } })
    }
    await uniewaznijToken(a, s.id, 'u')
    expect(await tresc401(nowy)).toEqual(wzor)
  })

  it('stanowisko z zapytania albo treści inne niż kod tokenu = 403 (lista, wynik, stan)', async () => {
    const s = await gotowe()
    await gotowe(a, 'magazyn-2')
    const z = await zlecenie(a, s.id)
    expect((await zadanie(f, s.token, 'GET', '/api/druk/zlecenia?stanowisko=magazyn-2')).status).toBe(403)
    expect((await zadanie(f, s.token, 'GET', '/api/druk/zlecenia')).status).toBe(403)
    expect((await wynik(s.token, z.id, { stanowisko: 'magazyn-2', wynik: 'OK', rola: 'TERMICZNA_1' })).status).toBe(403)
    expect((await zadanie(f, s.token, 'POST', '/api/druk/stan', { stanowisko: 'magazyn-2', wersjaAgenta: '0.2.0', drukarki: [] })).status).toBe(403)
    expect((await a.printJob.findUniqueOrThrow({ where: { id: z.id } })).status).toBe('OCZEKUJE')
  })

  it('limit nieudanych prób z IP: po 30 → 429 dla nieznanych tokenów, ważny token z tego adresu przechodzi; limit 240 żądań na minutę na stanowisko', async () => {
    const s = await gotowe()
    const req = (token: string, ip: string) => new Request(`${SERWER}/api/druk/zlecenia?stanowisko=magazyn-1`, { headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': ip } })
    for (let i = 0; i < 30; i++) expect(((await requireStationToken(req('zly', '198.51.100.7'), deps)) as Response).status).toBe(401)
    expect(((await requireStationToken(req('zly', '198.51.100.7'), deps)) as Response).status).toBe(429)
    expect(((await requireStationToken(req('kmd_' + 'x'.repeat(43), '198.51.100.7'), deps)) as Response).status).toBe(429)
    // stanowisko z ważnym tokenem za tym samym NAT-em drukuje dalej mimo blokady adresu
    const zaNatem = await requireStationToken(req(s.token, '198.51.100.7'), deps)
    expect(zaNatem).not.toBeInstanceOf(Response)
    expect((await zadanie(f, s.token, 'GET', '/api/druk/zlecenia?stanowisko=magazyn-1')).status).toBe(200)
    resetLimitowDruku()
    let ostatni: unknown
    for (let i = 0; i < 241; i++) ostatni = await requireStationToken(req(s.token, '198.51.100.8'), { ...deps, now: () => 1_000_000 })
    expect((ostatni as Response).status).toBe(429)
  })
})

describe('trasy agenta', () => {
  it('lista: tylko OCZEKUJE tego stanowiska, w kolejności, wyłącznie pola kontraktu; plik no-store; cudze id = 404', async () => {
    const s1 = await gotowe()
    const s2 = await gotowe(a, 'magazyn-2')
    const z1 = await zlecenie(a, s1.id)
    teraz = new Date(teraz.getTime() + 1000)
    const z2 = await zlecenie(a, s1.id, 'lista')
    const inne = await zlecenie(a, s2.id)
    const l = await lista(s1.token, s1.code)
    expect(l).toEqual([
      { id: z1.id, typ: 'etykieta', format: 'zpl', rola: 'TERMICZNA_1', plikUrl: `/api/druk/pliki/${z1.id}`, kopie: 1, utworzono: z1.createdAt.toISOString() },
      { id: z2.id, typ: 'lista', format: 'pdf', rola: 'A4', plikUrl: `/api/druk/pliki/${z2.id}`, kopie: 1, utworzono: z2.createdAt.toISOString() },
    ])
    const p = await zadanie(f, s1.token, 'GET', `/api/druk/pliki/${z1.id}`)
    expect(p.status).toBe(200)
    expect(p.headers.get('cache-control')).toBe('no-store')
    expect(Buffer.from(await p.arrayBuffer()).toString('utf8')).toContain('^XA^CI28')
    expect((await zadanie(f, s1.token, 'GET', `/api/druk/pliki/${inne.id}`)).status).toBe(404)
    expect((await zadanie(f, s1.token, 'GET', `/api/druk/pliki/nie-ma-takiego`)).status).toBe(404)
    // po wyniku znika z listy, a pliku już nie ma
    expect((await wynik(s1.token, z1.id, { stanowisko: s1.code, wynik: 'OK', rola: 'TERMICZNA_1', drukarka: 'Zebra' })).status).toBe(200)
    expect((await lista(s1.token, s1.code)).map((x) => x.id)).toEqual([z2.id])
    expect((await zadanie(f, s1.token, 'GET', `/api/druk/pliki/${z1.id}`)).status).toBe(404)
  })

  it('wynik: pierwszy wygrywa, powtórzenie = 200 bez zmian; cudze zlecenie = 404; złe pola = 400; ponad 16 KB = 413', async () => {
    const s = await gotowe()
    const z = await zlecenie(a, s.id)
    const r1 = await wynik(s.token, z.id, { stanowisko: s.code, wynik: 'OK', rola: 'TERMICZNA_1', drukarka: 'Zebra 1' })
    expect(await r1.json()).toEqual({ ok: true, zmiana: true })
    const r2 = await wynik(s.token, z.id, { stanowisko: s.code, wynik: 'BLAD', komunikat: 'Druk przerwany', rola: 'TERMICZNA_1', ponowienieRaportu: true })
    expect(r2.status).toBe(200)
    expect(await r2.json()).toEqual({ ok: true, zmiana: false })
    expect(await a.printJob.findUniqueOrThrow({ where: { id: z.id } })).toMatchObject({ status: 'OK', resultPrinter: 'Zebra 1', resultMessage: null })
    const inna = await gotowe(a, 'magazyn-2')
    expect((await wynik(inna.token, z.id, { stanowisko: inna.code, wynik: 'BLAD', rola: 'A4' })).status).toBe(404)
    expect((await wynik(s.token, z.id, { stanowisko: s.code, wynik: 'MOZE', rola: 'A4' })).status).toBe(400)
    expect((await wynik(s.token, z.id, { stanowisko: s.code, wynik: 'BLAD', rolaZapasowa: 'DRUKARKA_X' })).status).toBe(400)
    expect((await zadanie(f, s.token, 'POST', `/api/druk/zlecenia/${z.id}/wynik`, 'nie json')).status).toBe(400)
    const duzy = await wynik(s.token, z.id, { stanowisko: s.code, wynik: 'OK', komunikat: 'x'.repeat(17_000) })
    expect(duzy.status).toBe(413)
  })

  it('komunikat przycięty; rola z raportu nie jest źródłem prawdy (wartość zastępcza A4 przy nieznanej roli)', async () => {
    const s = await gotowe()
    const z = await zlecenie(a, s.id)
    await wynik(s.token, z.id, { stanowisko: s.code, wynik: 'BLAD', rola: 'A4', komunikat: `Odrzucone zlecenie: ${'ą'.repeat(800)}` })
    const w = await a.printJob.findUniqueOrThrow({ where: { id: z.id } })
    expect(w).toMatchObject({ status: 'BLAD', role: 'TERMICZNA_1' })
    expect(w.resultMessage!.length).toBeLessThanOrEqual(500)
    expect(await a.printJob.count()).toBe(1) // bez rolaZapasowa: bez zapasu
  })

  it('stan: drukarki, wersja i czas SERWERA; niepoprawny raport = 400 bez zapisu', async () => {
    const s = await stanowiskoZTokenem(a)
    teraz = new Date('2026-11-04T09:15:00Z')
    await raportStanu(f, s.token, s.code, [drukarka('TERMICZNA_1', 'OFFLINE'), drukarka('A4')], '0.1.0')
    const w = await a.printStation.findUniqueOrThrow({ where: { id: s.id } })
    expect(w.lastReportAt).toEqual(teraz)
    expect(w.agentVersion).toBe('0.1.0')
    expect((w.printers as { rola: string }[]).map((d) => d.rola)).toEqual(['TERMICZNA_1', 'A4'])
    for (const zly of [{ drukarki: 'x' }, { drukarki: [{ rola: 'DRUKARKA', nazwa: 'x', stan: 'DOSTEPNA', zleceniaWKolejce: 0 }] }, { drukarki: [{ rola: 'A4', nazwa: 'x', stan: 'ŚWIETNA', zleceniaWKolejce: 0 }] }]) {
      const r = await zadanie(f, s.token, 'POST', '/api/druk/stan', { stanowisko: s.code, wersjaAgenta: '0.2.0', ...zly })
      expect(r.status).toBe(400)
    }
    expect((await a.printStation.findUniqueOrThrow({ where: { id: s.id } })).agentVersion).toBe('0.1.0')
  })
})

describe('zapas po awarii termicznej', () => {
  it('BLAD z rolaZapasowa = nowe zlecenie ZAPAS (nowe id, te same bajty, fallbackOfId); podwójny raport nie daje drugiego zapasu', async () => {
    const s = await gotowe()
    const z = await zlecenie(a, s.id)
    const raport = { stanowisko: s.code, wynik: 'BLAD', rola: 'TERMICZNA_1', komunikat: 'Drukarka offline', rolaZapasowa: 'TERMICZNA_2' }
    // dwa raporty naraz (restart agenta) i trzeci później
    const [r1, r2] = await Promise.all([wynik(s.token, z.id, raport), wynik(s.token, z.id, raport)])
    expect([r1.status, r2.status]).toEqual([200, 200])
    await wynik(s.token, z.id, { ...raport, ponowienieRaportu: true })
    const zapasy = await a.printJob.findMany({ where: { fallbackOfId: z.id } })
    expect(zapasy).toHaveLength(1)
    expect(zapasy[0]).toMatchObject({ source: 'ZAPAS', role: 'TERMICZNA_2', format: 'zpl', status: 'OCZEKUJE', type: 'etykieta', expiresAt: z.expiresAt })
    expect(zapasy[0]!.id).not.toBe(z.id)
    const l = await lista(s.token, s.code)
    expect(l.map((x) => [x.id, x.rola, x.format])).toEqual([[zapasy[0]!.id, 'TERMICZNA_2', 'zpl']])
    const p = await zadanie(f, s.token, 'GET', l[0]!.plikUrl)
    expect(Buffer.from(await p.arrayBuffer()).toString('utf8')).toBe('^XA^CI28^FDzażółć^FS^XZ')
    expect((await statusZleceniaLubNull(a, z.id))?.zapas).toMatchObject({ id: zapasy[0]!.id, rola: 'TERMICZNA_2', status: 'OCZEKUJE' })
  })

  it('ZPL na A4 idzie jako PDF; zapas z zapasu tylko na drukarkę nietermiczną', async () => {
    const s = await gotowe()
    const z = await zlecenie(a, s.id)
    await wynik(s.token, z.id, { stanowisko: s.code, wynik: 'BLAD', rola: 'TERMICZNA_1', komunikat: 'brak etykiet', rolaZapasowa: 'TERMICZNA_2' })
    const zapas1 = await a.printJob.findUniqueOrThrow({ where: { fallbackOfId: z.id } })
    // druga termiczna też pada; agent proponuje pierwszą (krążenie) — odmowa; potem A4 — PDF
    await wynik(s.token, zapas1.id, { stanowisko: s.code, wynik: 'BLAD', rola: 'TERMICZNA_2', komunikat: 'offline', rolaZapasowa: 'TERMICZNA_1' })
    expect(await a.printJob.count({ where: { fallbackOfId: zapas1.id } })).toBe(0)
    expect((await a.printJob.findUniqueOrThrow({ where: { id: zapas1.id } })).resultMessage).toMatch(/bez zlecenia zapasowego \(to już było zlecenie zapasowe\)/)

    const z2 = await zlecenie(a, s.id)
    await wynik(s.token, z2.id, { stanowisko: s.code, wynik: 'BLAD', rola: 'TERMICZNA_1', komunikat: 'offline', rolaZapasowa: 'A4' })
    const naA4 = await a.printJob.findUniqueOrThrow({ where: { fallbackOfId: z2.id } })
    expect(naA4).toMatchObject({ role: 'A4', format: 'pdf', source: 'ZAPAS' })
    const l = await lista(s.token, s.code)
    expect(l.find((x) => x.id === naA4.id)).toMatchObject({ rola: 'A4', format: 'pdf' })
    const p = await zadanie(f, s.token, 'GET', `/api/druk/pliki/${naA4.id}`)
    expect(p.headers.get('content-type')).toBe('application/pdf')
    expect(Buffer.from(await p.arrayBuffer()).subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })

  it('BLAD bez rolaZapasowa (przekroczony czas, „Druk przerwany…”) nie daje zapasu; komunikat trafia do panelu', async () => {
    const s = await gotowe()
    const z = await zlecenie(a, s.id)
    const tekst = 'Nie wiadomo, czy wydruk wyszedł: drukarka „Zebra” nie odpowiedziała (przekroczony czas 60 s).'
    await wynik(s.token, z.id, { stanowisko: s.code, wynik: 'BLAD', rola: 'TERMICZNA_1', komunikat: tekst })
    expect(await a.printJob.count()).toBe(1)
    expect(await statusZleceniaLubNull(a, z.id)).toMatchObject({ status: 'BLAD', komunikat: tekst, zapas: null })
  })

  it('rola zapasowa spoza ostatniego raportu stanowiska = bez zapasu (stary agent nie dostanie nieznanej roli)', async () => {
    const s = await gotowe(a, 'magazyn-1', [drukarka('A4'), drukarka('TERMICZNA_1')])
    const z = await zlecenie(a, s.id)
    await wynik(s.token, z.id, { stanowisko: s.code, wynik: 'BLAD', rola: 'TERMICZNA_1', komunikat: 'offline', rolaZapasowa: 'TERMICZNA_2' })
    expect(await a.printJob.count()).toBe(1)
    expect((await a.printJob.findUniqueOrThrow({ where: { id: z.id } })).resultMessage).toMatch(/drukarki TERMICZNA_2 nie ma w ostatnim raporcie/)
  })
})

describe('zgodność wersji i routing', () => {
  it('zlecenie tylko na rolę z ostatniego raportu: brak raportu albo roli = czytelny błąd i zlecenie nie powstaje', async () => {
    const bezRaportu = await stanowiskoZTokenem(a, 'nowe')
    await expect(zlecenie(a, bezRaportu.id)).rejects.toThrow(/jeszcze nie zgłosiło drukarek/)
    // agent 0.1.0 z A4 i TERMICZNA_1; etykiety skierowane na TERMICZNA_3 (np. po zmianie na innym komputerze)
    const stary = await gotowe(a, 'stary', [drukarka('A4'), drukarka('TERMICZNA_1')])
    await ustawRouting(a, stary.id, { etykieta: 'TERMICZNA_1' }, 'u')
    await expect(ustawRouting(a, stary.id, { etykieta: 'TERMICZNA_3' }, 'u')).rejects.toThrow(/nie zgłasza drukarki TERMICZNA_3/)
    await a.printStation.update({ where: { id: stary.id }, data: { routing: { etykieta: 'TERMICZNA_3' } } })
    const blad = await zlecenie(a, stary.id).catch((e: unknown) => e)
    expect(blad).toBeInstanceOf(BladDruku)
    expect((blad as BladDruku).message).toMatch(/nie ma drukarki Termiczna 3 \(TERMICZNA_3\) w ostatnim raporcie/)
    expect(await a.printJob.count()).toBe(0)
    expect(await lista(stary.token, stary.code)).toEqual([])
    // wydruk testowy też tylko na rolę z raportu
    await expect(wydrukTestowy(a, stary.id, 'TERMICZNA_2', 'u', teraz)).rejects.toThrow(/nie zgłasza drukarki TERMICZNA_2/)
  })

  it('etykieta tylko w PDF (źródło bez ZPL) na termicznej: zlecenie PDF zamiast błędu', async () => {
    const s = await gotowe()
    const w = await utworzZlecenie(a, { stationId: s.id, typ: 'etykieta', zrodlo: 'PANEL', klucz: klucz(), now: teraz, rysuj: async () => ({ pliki: { pdf: Buffer.from('%PDF-1.7 etykieta') } }) })
    expect(w.zlecenie).toMatchObject({ status: 'OCZEKUJE', role: 'TERMICZNA_1', format: 'pdf' })
    expect((await lista(s.token, s.code))[0]).toMatchObject({ rola: 'TERMICZNA_1', format: 'pdf' })
  })

  it('wiele drukarek: routing na A4_2 i TERMICZNA_4 z raportu agenta 0.2.0', async () => {
    const s = await gotowe(a, 'duze', [drukarka('A4'), drukarka('A4_2'), drukarka('TERMICZNA_1'), drukarka('TERMICZNA_4')])
    await ustawRouting(a, s.id, { lista: 'A4_2', etykieta: 'TERMICZNA_4' }, 'u')
    await zlecenie(a, s.id, 'lista')
    await zlecenie(a, s.id)
    expect((await lista(s.token, s.code)).map((x) => [x.rola, x.format])).toEqual([
      ['A4_2', 'pdf'],
      ['TERMICZNA_4', 'zpl'],
    ])
  })

  it('wydruk testowy: lista PDF na A4, etykieta ZPL ^CI28 na termicznej; nazwa stanowiska, rola i polskie znaki', async () => {
    const s = await gotowe()
    const t1 = await wydrukTestowy(a, s.id, 'A4', 'u', teraz)
    const t2 = await wydrukTestowy(a, s.id, 'TERMICZNA_2', 'u', teraz)
    expect([t1.typ, t1.zrodlo, t2.typ, t2.rola]).toEqual(['lista', 'TEST', 'etykieta', 'TERMICZNA_2'])
    const zpl = Buffer.from(await (await zadanie(f, s.token, 'GET', `/api/druk/pliki/${t2.id}`)).arrayBuffer()).toString('utf8')
    expect(zpl).toMatch(/^\^XA\n\^CI28\n/)
    expect(zpl).toContain('^FH_^FD') // pola przez ^FH: „_” w treści zakodowane jako _5F (drukarka pokaże „_”)
    const tekst = zpl.replace(/_([0-9A-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    for (const t of ['Stanowisko magazyn-1', 'TERMICZNA_2', 'zażółć gęślą jaźń']) expect(tekst).toContain(t)
    const pdf = Buffer.from(await (await zadanie(f, s.token, 'GET', `/api/druk/pliki/${t1.id}`)).arrayBuffer())
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })
})

describe('wygasanie i sprzątanie', () => {
  it('po 8 godzinach: WYGASLO, agent go nie dostaje; wynik i tak przyjęty (stan fizyczny ma pierwszeństwo), bez zapasu', async () => {
    const s = await gotowe()
    const z = await zlecenie(a, s.id)
    expect(z.expiresAt.getTime() - z.createdAt.getTime()).toBe(WAZNOSC_MS)
    teraz = new Date(z.createdAt.getTime() + WAZNOSC_MS + 1000)
    expect(await lista(s.token, s.code)).toEqual([])
    expect(await a.printJob.findUniqueOrThrow({ where: { id: z.id } })).toMatchObject({ status: 'WYGASLO', resultMessage: KOMUNIKAT_WYGASLO })
    expect((await zadanie(f, s.token, 'GET', `/api/druk/pliki/${z.id}`)).status).toBe(404)
    const r = await wynik(s.token, z.id, { stanowisko: s.code, wynik: 'BLAD', rola: 'TERMICZNA_1', komunikat: 'offline', rolaZapasowa: 'TERMICZNA_2' })
    expect(await r.json()).toEqual({ ok: true, zmiana: true })
    expect(await a.printJob.count()).toBe(1)
    expect((await a.printJob.findUniqueOrThrow({ where: { id: z.id } })).status).toBe('BLAD')
  })

  it('worker: wygasza bez agenta i usuwa bajty zakończonych zleceń po 7 dniach; wiersz zostaje', async () => {
    const s = await gotowe()
    // etykiety (adres odbiorcy) tracą bajty od razu jak karty, więc 7 dni sprawdzamy na liście wysyłkowej
    const stare = await zlecenie(a, s.id, 'lista')
    await zapiszWynik(a, s.id, stare.id, { wynik: 'OK' }, teraz)
    const czeka = await zlecenie(a, s.id, 'lista')
    const r1 = await sprzatajDruk(a, new Date(teraz.getTime() + 6 * 24 * 3600_000))
    expect(r1).toEqual({ wygasle: 1, usunietePliki: 0 })
    expect((await a.printJob.findUniqueOrThrow({ where: { id: czeka.id } })).status).toBe('WYGASLO')
    const r2 = await sprzatajDruk(a, new Date(teraz.getTime() + 7 * 24 * 3600_000 + 1000))
    expect(r2.usunietePliki).toBe(4) // po dwa pliki (ZPL + PDF) dwóch zleceń
    expect(await a.printJobFile.count()).toBe(0)
    expect(await a.printJob.count()).toBe(2)
  })

  it('etykieta (może mieć adres odbiorcy) traci bajty zaraz po wyniku agenta i po wygaśnięciu, wiersz zostaje', async () => {
    const s = await gotowe()
    const ok = await zlecenie(a, s.id)
    await zapiszWynik(a, s.id, ok.id, { wynik: 'OK' }, teraz)
    expect(await a.printJobFile.count({ where: { jobId: ok.id } })).toBe(0)
    const czeka = await zlecenie(a, s.id)
    const r = await sprzatajDruk(a, new Date(teraz.getTime() + 9 * 3600_000))
    expect(r).toEqual({ wygasle: 1, usunietePliki: 2 })
    expect(await a.printJobFile.count({ where: { jobId: czeka.id } })).toBe(0)
    expect(await a.printJob.count()).toBe(2)
  })
})

describe('druk z panelu przez kolejkę', () => {
  it('karty: podwójny klik (ten sam klucz) = jedno zlecenie i JEDEN OrderCardPrint; nowy klik = nowy numer wydruku', async () => {
    const s = await gotowe()
    const o1 = await zamowienie(a, '48213')
    const z = { typ: 'karta' as const, ids: [o1], stationId: s.id, klucz: klucz() }
    const [w1, w2] = await Promise.all([zlecZPanelu(a, KTO, z, { now: teraz }), zlecZPanelu(a, KTO, z, { now: teraz })])
    const w3 = await zlecZPanelu(a, KTO, z, { now: teraz })
    expect(new Set([w1.zlecenie.id, w2.zlecenie.id, w3.zlecenie.id]).size).toBe(1)
    expect([w1.istnialo, w2.istnialo].sort()).toEqual([false, true])
    expect(w3.istnialo).toBe(true)
    expect(await a.orderCardPrint.count()).toBe(1)
    expect(await a.printJob.count()).toBe(1)
    const job = await a.printJob.findUniqueOrThrow({ where: { id: w1.zlecenie.id } })
    expect(job).toMatchObject({ status: 'OCZEKUJE', type: 'karta', role: 'A4', format: 'pdf', requestedBy: KTO.userId, orderIds: [o1] })
    expect(job.summary).toMatch(/^Karty: [A-Z]+48213\/1$/)
    // ponowny druk to zwykły nowy wydruk z nowym numerem
    await zlecZPanelu(a, KTO, { ...z, klucz: klucz() }, { now: teraz })
    expect((await a.orderCardPrint.findMany({ orderBy: { printNo: 'asc' } })).map((p) => p.printNo)).toEqual([1, 2])
    const pdf = await zadanie(f, s.token, 'GET', `/api/druk/pliki/${job.id}`)
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })

  it('karty: pominięte zamówienia (bez stanu, wysłane) w odpowiedzi; same pominięte = błąd, zlecenie BLAD, agent nic nie dostaje', async () => {
    const s = await gotowe()
    const o1 = await zamowienie(a, '48300')
    const o2 = await zamowienie(a, '48301')
    await a.order.update({ where: { id: o2 }, data: { status: 'WYSLANE' } })
    const w = await zlecZPanelu(a, KTO, { typ: 'karta', ids: [o1, o2], stationId: s.id, klucz: klucz() }, { now: teraz })
    expect(w.pominiete).toHaveLength(1)
    expect(w.pominiete[0]).toContain('48301')
    const blad = await zlecZPanelu(a, KTO, { typ: 'karta', ids: [o2], stationId: s.id, klucz: klucz() }, { now: teraz }).catch((e: unknown) => e)
    expect(blad).toBeInstanceOf(BladDruku)
    expect((blad as BladDruku).status).toBe(422)
    expect(await a.printJob.count({ where: { status: 'BLAD' } })).toBe(1)
    expect((await lista(s.token, s.code)).length).toBe(1)
  })

  it('błąd rysowania PDF nie wypuszcza zlecenia: BLAD z komunikatem, bez plików, agent nic nie dostaje', async () => {
    const s = await gotowe()
    const o1 = await zamowienie(a, '48400')
    const padniete = { nazwa: 'padniete', etykieta: async () => Promise.reject(new Error('pdfkit: brak fontu')) }
    const e = await zlecZPanelu(a, KTO, { typ: 'etykieta', ids: [o1], stationId: s.id, klucz: klucz() }, { now: teraz, etykiety: padniete }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(BladDruku)
    const job = await a.printJob.findFirstOrThrow()
    // surowy komunikat wyjątku (pdfkit, Prisma) nie trafia do panelu ani do bazy
    expect(job).toMatchObject({ status: 'BLAD', resultMessage: KOMUNIKAT_BLEDU_PLIKU })
    expect((e as BladDruku).message).toBe(KOMUNIKAT_BLEDU_PLIKU)
    expect(JSON.stringify(job)).not.toContain('pdfkit')
    expect(await a.printJobFile.count()).toBe(0)
    expect(await lista(s.token, s.code)).toEqual([])
  })

  it('BladDruku z rysowania przechodzi do panelu z komunikatem i kodem; BladKart z kart zachowuje komunikat', async () => {
    const s = await gotowe()
    const o1 = await zamowienie(a, '48410')
    const brak = { nazwa: 'brak', etykieta: async () => Promise.reject(new BladDruku('Najpierw przygotuj przesyłkę', 409)) }
    const e = (await zlecZPanelu(a, KTO, { typ: 'etykieta', ids: [o1], stationId: s.id, klucz: klucz() }, { now: teraz, etykiety: brak }).catch((x: unknown) => x)) as BladDruku
    expect(e.status).toBe(409)
    expect((await a.printJob.findFirstOrThrow()).resultMessage).toBe('Najpierw przygotuj przesyłkę')
    await a.order.update({ where: { id: o1 }, data: { status: 'WYSLANE' } })
    const k = (await zlecZPanelu(a, KTO, { typ: 'karta', ids: [o1], stationId: s.id, klucz: klucz() }, { now: teraz }).catch((x: unknown) => x)) as BladDruku
    expect(k).toBeInstanceOf(BladDruku)
    expect(k.message).not.toBe(KOMUNIKAT_BLEDU_PLIKU)
  })

  it('błąd zapisu pliku po udanym rysowaniu: BLAD z komunikatem i BladDruku 422, nie PRZYGOTOWANIE i nie 500', async () => {
    const s = await gotowe()
    // rysowanie bez bazy (atrapa karty), żeby jedynym $transaction w tym wywołaniu był zapis pliku
    const rysuj = async () => ({ pliki: { pdf: Buffer.from('%PDF-1.7 karta') }, opis: 'Karty: K-1' })
    // PrismaClient to Proxy: podaje sztuczny opis $transaction (value undefined), więc spy.mockRestore() wpisuje na obiekt
    // undefined i psuje kolejne testy pliku („db.$transaction is not a function”); po restore kasujemy własną właściwość
    const spy = vi.spyOn(a, '$transaction').mockRejectedValueOnce(new Error('Connection terminated unexpectedly'))
    try {
      const e = await utworzZlecenie(a, { stationId: s.id, typ: 'karta', zrodlo: 'PANEL', klucz: klucz(), now: teraz, rysuj }).catch((x: unknown) => x)
      expect(e).toBeInstanceOf(BladDruku)
      expect((e as BladDruku).status).toBe(422)
      expect((e as BladDruku).message).toBe(komunikatBleduZapisu('karta'))
    } finally {
      spy.mockRestore()
      delete (a as unknown as Record<string, unknown>).$transaction
    }
    expect(typeof a.$transaction).toBe('function')
    const job = await a.printJob.findFirstOrThrow()
    expect(job).toMatchObject({ status: 'BLAD', resultMessage: komunikatBleduZapisu('karta') })
    expect(JSON.stringify(job)).not.toContain('Connection terminated')
    expect(await a.printJobFile.count()).toBe(0)
    expect(await lista(s.token, s.code)).toEqual([])
  })

  it('ten sam klucz idempotencji z innym typem, stanowiskiem albo zamówieniami = 409, bez rysowania', async () => {
    const s = await gotowe()
    const s2 = await gotowe(a, 'magazyn-2')
    const k = klucz()
    let rysowan = 0
    const rysuj = async () => {
      rysowan++
      return { pliki: { pdf: Buffer.from('%PDF-1.7 x') } }
    }
    const baza = { stationId: s.id, typ: 'lista' as const, zrodlo: 'PANEL' as const, klucz: k, now: teraz, orderIds: ['z1'], rysuj }
    const pierwsze = await utworzZlecenie(a, baza)
    expect((await utworzZlecenie(a, baza)).istnialo).toBe(true)
    for (const inne of [{ typ: 'karta' as const }, { stationId: s2.id }, { orderIds: ['z1', 'z2'] }, { orderIds: ['z2'] }]) {
      const e = await utworzZlecenie(a, { ...baza, ...inne }).catch((x: unknown) => x)
      expect(e).toBeInstanceOf(BladDruku)
      expect((e as BladDruku).status).toBe(409)
    }
    expect(rysowan).toBe(1)
    expect(await a.printJob.count()).toBe(1)
    expect((await a.printJob.findFirstOrThrow()).id).toBe(pierwsze.zlecenie.id)
  })

  it('lista wysyłkowa przez kolejkę na A4; walidacja treści z przeglądarki', async () => {
    const s = await gotowe()
    const o1 = await zamowienie(a, '48500')
    const w = await zlecZPanelu(a, KTO, { typ: 'lista', ids: [o1], stationId: s.id, klucz: klucz() }, { now: teraz })
    expect(w.zlecenie).toMatchObject({ status: 'OCZEKUJE', typ: 'lista', rola: 'A4', stanowisko: 'Stanowisko magazyn-1' })
    expect(parsujZlecenieZPanelu({ typ: 'spis', z: [o1], stanowisko: s.id, klucz: klucz() })).toEqual({ blad: expect.stringMatching(/Typ wydruku/) })
    expect(parsujZlecenieZPanelu({ typ: 'karta', z: [o1], stanowisko: s.id, klucz: 'krotki' })).toEqual({ blad: expect.stringMatching(/klucza/) })
    expect(parsujZlecenieZPanelu({ typ: 'etykieta', z: [o1, o1 + 'x'], stanowisko: s.id, klucz: klucz() })).toEqual({ blad: expect.stringMatching(/Najwyżej 1/) })
    expect(parsujZlecenieZPanelu({ typ: 'karta', z: `${o1}, ${o1}`, stanowisko: s.id, klucz: 'k'.repeat(20) })).toEqual({ typ: 'karta', ids: [o1], stationId: s.id, klucz: 'k'.repeat(20) })
  })

  it('etykieta próbna z PreparedShipment: ZPL ^CI28 i PDF z napisem PRÓBA, bez kodu kreskowego; zamówienie i przesyłka bez zmian', async () => {
    const s = await gotowe()
    const o1 = await zamowienie(a, '48600')
    await expect(zlecZPanelu(a, KTO, { typ: 'etykieta', ids: [o1], stationId: s.id, klucz: klucz() }, { now: teraz })).rejects.toThrow(/Najpierw przygotuj przesyłkę/)
    await a.preparedShipment.create({ data: { orderId: o1, packageNo: 1, adapterKey: 'basecourier.v1', carrier: 'DPD', courierCode: 'dpd', parcelSize: 'A', weightKg: 1.25, codAmount: 49.9 } })
    const przed = JSON.stringify([await a.order.findMany({ orderBy: { id: 'asc' } }), await a.preparedShipment.findMany(), await a.reservation.findMany({ orderBy: { id: 'asc' } }), await a.stock.findMany({ orderBy: { productId: 'asc' } })])
    const w = await zlecZPanelu(a, KTO, { typ: 'etykieta', ids: [o1], stationId: s.id, klucz: klucz() }, { now: teraz })
    expect(w.zlecenie).toMatchObject({ typ: 'etykieta', rola: 'TERMICZNA_1', status: 'OCZEKUJE' })
    expect(JSON.stringify([await a.order.findMany({ orderBy: { id: 'asc' } }), await a.preparedShipment.findMany(), await a.reservation.findMany({ orderBy: { id: 'asc' } }), await a.stock.findMany({ orderBy: { productId: 'asc' } })])).toBe(przed)
    const pliki = await a.printJobFile.findMany({ where: { jobId: w.zlecenie.id } })
    const zpl = Buffer.from(pliki.find((p) => p.format === 'zpl')!.data).toString('utf8')
    expect(zpl).toContain('^CI28')
    for (const t of ['PRÓBA', 'NIE NADAWAĆ', '48600', 'DPD (dpd)', '1,25 kg', '49,90 zł']) expect(zpl).toContain(t)
    expect(zpl).not.toMatch(/\^B[0-9A-Z]/) // żadnego polecenia kodu kreskowego ZPL (^BC, ^B3, ^BQ…)
    expect(NAPIS_PROBY).toBe('PRÓBA — NIE NADAWAĆ')
    const pdf = Buffer.from(pliki.find((p) => p.format === 'pdf')!.data)
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })

  it('stan dla nagłówka: stanowiska bez wyłączonych, „brak stanu” po 3 minutach', async () => {
    const s = await gotowe()
    const w = await gotowe(a, 'wylaczone')
    await ustawWylaczenie(a, w.id, true, 'u')
    const st = await stanowiskaDlaPanelu(a, new Date(teraz.getTime() + 60_000))
    expect(st.map((x) => [x.code, x.agentDziala, x.minutOdRaportu, x.role])).toEqual([['magazyn-1', true, 1, ['A4', 'TERMICZNA_1', 'TERMICZNA_2']]])
    expect((await stanowiskaDlaPanelu(a, new Date(teraz.getTime() + 4 * 60_000)))[0]).toMatchObject({ agentDziala: false, minutOdRaportu: 4 })
    expect(s.code).toBe('magazyn-1')
  })

  it('adres serwera do kodu instalacyjnego z nagłówków proxy', () => {
    const h = (o: Record<string, string>) => new Headers(o)
    expect(adresSerwera(h({ host: 'kompletor.example.invalid', 'x-forwarded-proto': 'https' }))).toBe('https://kompletor.example.invalid')
    expect(adresSerwera(h({ host: 'wewn:3100', 'x-forwarded-host': 'panel.example.invalid', 'x-forwarded-proto': 'https' }))).toBe('https://panel.example.invalid')
    expect(adresSerwera(h({ host: 'localhost:3100' }))).toBe('http://localhost:3100')
    expect(adresSerwera(h({ host: 'kompletor.example.invalid' }))).toBe('https://kompletor.example.invalid')
    expect(() => adresSerwera({ get: (n: string) => (n === 'host' ? 'evil.example.invalid/x' : null) })).toThrow(BladDruku)
  })
})

describe('izolacja dwóch firm', () => {
  it('token firmy B nie widzi zleceń, plików ani stanowisk firmy A; ten sam kod stanowiska w dwóch firmach', async () => {
    const sa = await gotowe(a, 'magazyn-1')
    const sb = await gotowe(b, 'magazyn-1')
    const za = await zlecenie(a, sa.id)
    expect((await lista(sb.token, 'magazyn-1')).map((x) => x.id)).toEqual([])
    expect((await zadanie(f, sb.token, 'GET', `/api/druk/pliki/${za.id}`)).status).toBe(404)
    expect((await wynik(sb.token, za.id, { stanowisko: 'magazyn-1', wynik: 'OK', rola: 'A4' })).status).toBe(404)
    expect((await a.printJob.findUniqueOrThrow({ where: { id: za.id } })).status).toBe('OCZEKUJE')
    // raport stanu firmy B nie zmienia stanowiska A
    await raportStanu(f, sb.token, 'magazyn-1', [drukarka('A4', 'OFFLINE')])
    expect(((await a.printStation.findUniqueOrThrow({ where: { id: sa.id } })).printers as { stan: string }[]).every((d) => d.stan === 'DOSTEPNA')).toBe(true)
    expect((await lista(sa.token, 'magazyn-1')).map((x) => x.id)).toEqual([za.id])
  })

  it('RLS na PrintStation, PrintJob, PrintJobFile: klient firmy B nie czyta, nie zmienia i nie zapisuje do firmy A', async () => {
    const sa = await gotowe(a)
    const za = await zlecenie(a, sa.id)
    expect(await b.printStation.count()).toBe(0)
    expect(await b.printJob.count()).toBe(0)
    expect(await b.printJobFile.count()).toBe(0)
    expect(await b.printJob.updateMany({ where: { id: za.id }, data: { status: 'OK' } })).toEqual({ count: 0 })
    expect(await b.printJobFile.deleteMany({ where: { jobId: za.id } })).toEqual({ count: 0 })
    expect(await b.printStation.updateMany({ where: { id: sa.id }, data: { tokenHash: null } })).toEqual({ count: 0 })
    await expect(b.printJob.create({ data: { organizationId: ORG_A, stationId: sa.id, type: 'karta', source: 'PANEL', role: 'A4', format: 'pdf', expiresAt: teraz } })).rejects.toThrow()
    await expect(b.printStation.create({ data: { organizationId: ORG_A, code: 'obce', name: 'x' } })).rejects.toThrow()
    // panel firmy B: stan i status cudzego zlecenia niewidoczne; utworzenie na cudzym stanowisku = 404
    expect(await stanowiskaDlaPanelu(b)).toEqual([])
    expect(await statusZleceniaLubNull(b, za.id)).toBeNull()
    await expect(zlecZPanelu(b, KTO, { typ: 'lista', ids: ['x1'], stationId: sa.id, klucz: klucz() })).rejects.toThrow(/Nie ma takiego stanowiska/)
    // sprzątanie firmy B nie dotyka plików A
    await sprzatajDruk(b, new Date(teraz.getTime() + 30 * 24 * 3600_000))
    expect(await a.printJobFile.count()).toBe(2)
    expect(await sys.printJob.count()).toBe(1)
  })
})
