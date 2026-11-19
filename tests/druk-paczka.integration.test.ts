// Paczka programu druku: trasa GET /api/wydruki/program (sesja i uprawnienie `ustawienia`, plik z katalogu
// AGENT_DRUKU_KATALOG, strumień z nagłówkami pobrania) i ekran Ustawienia → Wysyłka i druk → Druk z przyciskiem
// „Pobierz program (Windows)” i bez niego. Dane wyłącznie testowe (domeny .test, pliki w katalogu tymczasowym).
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createUser, grantMembership, login } from '@/lib/auth/sesje'
import { testDb, testSystemDb, truncateAll, ORG_A } from './db'
import { testAppDbUrl, testDbUrl } from './global-setup'
import { drukarka } from './druk-pomocnicze'

let ciasteczko: string | undefined
vi.mock('server-only', () => ({}))
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (_n: string) => (ciasteczko ? { value: ciasteczko } : undefined) }),
  headers: async () => new Headers(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
process.env.DATABASE_URL = testDbUrl()
process.env.APP_DATABASE_URL = testAppDbUrl()

const { GET } = await import('@/app/api/wydruki/program/route')
const { default: Druk } = await import('@/app/(panel)/ustawienia/druk/page')
const { dodajStanowisko } = await import('@/lib/druk/stanowiska')

const sys = testSystemDb()
const a = testDb()
const HASLO = ['haslo', 'testowe', 'paczki', '1'].join('-')
const ADRES = 'https://kompletor.example.invalid/api/wydruki/program'
const ekran = async () => renderToStaticMarkup(await Druk())

async function jako(email: string) {
  const r = await login(sys, email, HASLO)
  if (!r.ok) throw new Error(`logowanie ${email}: ${r.reason}`)
  ciasteczko = r.token
}

async function katalogZPlikami(pliki: Record<string, number>): Promise<string> {
  const kat = await mkdtemp(path.join(tmpdir(), 'paczka-druku-int-'))
  for (const [nazwa, bajty] of Object.entries(pliki)) await writeFile(path.join(kat, nazwa), Buffer.alloc(bajty, 7))
  return kat
}

beforeEach(async () => {
  await truncateAll()
  await createUser(sys, { email: 'wlasciciel@firma-a.test', name: 'Właściciel Testowy A', password: HASLO })
  await grantMembership(sys, { email: 'wlasciciel@firma-a.test', organizationId: ORG_A, role: 'WLASCICIEL' })
  await createUser(sys, { email: 'magazyn@firma-a.test', name: 'Magazyn Testowy A', password: HASLO })
  await grantMembership(sys, { email: 'magazyn@firma-a.test', organizationId: ORG_A, role: 'MAGAZYN' })
  ciasteczko = undefined
  vi.stubEnv('AGENT_DRUKU_URL', '')
  vi.stubEnv('AGENT_DRUKU_KATALOG', '')
})
afterAll(async () => {
  vi.unstubAllEnvs()
  await a.$disconnect()
})

describe('GET /api/wydruki/program', () => {
  it('bez sesji = 401 (JSON dla fetch, strona HTML dla przeglądarki)', async () => {
    vi.stubEnv('AGENT_DRUKU_KATALOG', await katalogZPlikami({ 'Kompletor-Druk-0.2.0-win-x64.zip': 100 }))
    const r = await GET(new Request(ADRES))
    expect(r.status).toBe(401)
    expect(await r.json()).toHaveProperty('error')
    const h = await GET(new Request(ADRES, { headers: { accept: 'text/html' } }))
    expect(h.status).toBe(401)
    expect(h.headers.get('content-type')).toContain('text/html')
    expect(await h.text()).toContain('Zaloguj się')
  })

  it('bez uprawnienia `ustawienia` = 404 bez pliku', async () => {
    vi.stubEnv('AGENT_DRUKU_KATALOG', await katalogZPlikami({ 'Kompletor-Druk-0.2.0-win-x64.zip': 100 }))
    await jako('magazyn@firma-a.test')
    const r = await GET(new Request(ADRES))
    expect(r.status).toBe(404)
    expect(r.headers.get('content-type')).not.toContain('zip')
  })

  it('brak zmiennej, brak katalogu, brak pliku według wzoru = 404 z komunikatem', async () => {
    await jako('wlasciciel@firma-a.test')
    let r = await GET(new Request(ADRES))
    expect(r.status).toBe(404)
    expect((await r.json()).error).toContain('Paczki programu druku nie ma jeszcze na serwerze')
    vi.stubEnv('AGENT_DRUKU_KATALOG', path.join(tmpdir(), 'brak-katalogu-paczki-int'))
    expect((await GET(new Request(ADRES))).status).toBe(404)
    vi.stubEnv('AGENT_DRUKU_KATALOG', await katalogZPlikami({ 'inny-plik.zip': 10, 'Kompletor-Druk-0.2.0-win-x64.zip.part': 10 }))
    r = await GET(new Request(ADRES, { headers: { accept: 'text/html' } }))
    expect(r.status).toBe(404)
    expect(await r.text()).toContain('Wróć do ustawień druku')
  })

  it('poprawne pobranie: najwyższa wersja, pełna treść, nagłówki pobrania, plik spoza wzoru pomijany', async () => {
    vi.stubEnv(
      'AGENT_DRUKU_KATALOG',
      await katalogZPlikami({
        'Kompletor-Druk-0.2.0-win-x64.zip': 300,
        'Kompletor-Druk-0.10.1-win-x64.zip': 2048,
        'Kompletor-Druk-0.9.9-win-x64.zip': 100,
        'Kompletor-Druk-9.9.9-win-x64.zip.bak': 50,
      }),
    )
    await jako('wlasciciel@firma-a.test')
    const r = await GET(new Request(ADRES))
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('application/zip')
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="Kompletor-Druk-0.10.1-win-x64.zip"')
    expect(r.headers.get('content-length')).toBe('2048')
    expect(r.headers.get('cache-control')).toBe('no-store')
    const tresc = new Uint8Array(await r.arrayBuffer())
    expect(tresc.length).toBe(2048)
    expect(tresc.every((b) => b === 7)).toBe(true)
  })
})

describe('Ustawienia → Wysyłka i druk → Druk: przycisk pobrania', () => {
  it('bez pliku i adresu: wyszarzony przycisk z instrukcją, bez linku do trasy', async () => {
    await jako('wlasciciel@firma-a.test')
    await dodajStanowisko(a, { code: 'magazyn-1', name: 'Stanowisko testowe' }, 'uzytkownik-testowy')
    const h = await ekran()
    expect(h).not.toContain('href="/api/wydruki/program"')
    expect(h).toContain('aria-disabled="true"')
    expect(h).toContain('Pobierz program (Windows)')
    expect(h).not.toContain('Rozpakuj paczkę i uruchom')
  })

  it('z plikiem: przycisk z wersją i rozmiarem u góry i w karcie stanowiska; przed zgłoszeniem programu zdanie zamiast list', async () => {
    vi.stubEnv('AGENT_DRUKU_KATALOG', await katalogZPlikami({ 'Kompletor-Druk-0.2.0-win-x64.zip': 44_564_480 }))
    await jako('wlasciciel@firma-a.test')
    await dodajStanowisko(a, { code: 'magazyn-1', name: 'Stanowisko testowe' }, 'uzytkownik-testowy')
    const h = await ekran()
    expect(h.match(/href="\/api\/wydruki\/program"/g)).toHaveLength(2)
    expect(h).toContain('wersja 0.2.0, 42,5 MB')
    expect(h).toContain('Rozpakuj paczkę i uruchom')
    expect(h).toContain('Drukarki przypiszesz po instalacji programu druku na tym albo innym komputerze firmy: wtedy pojawią się tutaj.')
    expect(h).not.toContain('brak w raporcie')
    expect(h).not.toContain('<select')
    expect(h).not.toMatch(/>agent |agent działa|agent jeszcze/)
  })

  it('po zgłoszeniu programu: zdanie nad listami i listy z drukarkami tego komputera', async () => {
    vi.stubEnv('AGENT_DRUKU_KATALOG', await katalogZPlikami({ 'Kompletor-Druk-0.2.0-win-x64.zip': 100 }))
    await jako('wlasciciel@firma-a.test')
    const id = await dodajStanowisko(a, { code: 'magazyn-1', name: 'Stanowisko testowe' }, 'uzytkownik-testowy')
    await a.printStation.update({ where: { id }, data: { printers: [drukarka('A4'), drukarka('TERMICZNA_1')], lastReportAt: new Date(), agentVersion: '0.2.0' } })
    const h = await ekran()
    expect(h).toContain('Wybierz drukarkę dla każdego rodzaju wydruku: tego komputera albo innego stanowiska firmy')
    expect(h).toContain('<select')
    expect(h).toContain('program druku 0.2.0')
    expect(h).not.toContain('Drukarki przypiszesz po instalacji')
  })

  it('adres zewnętrzny AGENT_DRUKU_URL ma pierwszeństwo przed plikiem', async () => {
    vi.stubEnv('AGENT_DRUKU_KATALOG', await katalogZPlikami({ 'Kompletor-Druk-0.2.0-win-x64.zip': 100 }))
    vi.stubEnv('AGENT_DRUKU_URL', 'https://pliki.example.invalid/kompletor-druk.zip')
    await jako('wlasciciel@firma-a.test')
    await dodajStanowisko(a, { code: 'magazyn-1', name: 'Stanowisko testowe' }, 'uzytkownik-testowy')
    const h = await ekran()
    expect(h).toContain('href="https://pliki.example.invalid/kompletor-druk.zip"')
    expect(h).not.toContain('href="/api/wydruki/program"')
    expect(h).not.toContain('wersja 0.2.0')
  })
})
