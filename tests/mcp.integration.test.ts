// serwer MCP Kompletora (/api/mcp) na bazie testowej, bez sieci. Dane wyłącznie fikcyjne (SKU TEST-*,
// numery TEST-0001…); „dane osobowe” w teście to wymyślone wartości wstawione do pól, które serwer ma omijać.
//  1. uwierzytelnienie: brak, zły, odwołany klucz i firma nieaktywna = 401 z WWW-Authenticate; klucz bez zakresu MCP =
//     odmowa narzędzia (ODMOWA w dzienniku); lastUsedAt jak w API v1;
//  2. izolacja firm: klucz firmy B nie widzi zamówień ani produktów firmy A, także po numerze i SKU z firmy A;
//  3. brak danych osobowych: każde narzędzie, wynik bez wstawionych imion, adresów, telefonów, e-maili i treści;
//     wynik zgodny ze schematem wyjścia narzędzia;
//  4. protokół: 2026-07-28 (discover, list, call, nagłówki), 2025-11-25 bez sesji (initialize, ping), zła wersja,
//     brak nagłówka, nieznane narzędzie i metoda, za duże żądanie, zły Origin, GET/DELETE, powiadomienie, paczka;
//  5. limity: 60 wywołań narzędzi na minutę na klucz, potem błąd narzędzia z czasem ponowienia i LIMIT w dzienniku;
//  6. dziennik: wpis na każde wywołanie, nazwy parametrów bez wartości; czyszczenie po 90 dniach (zadanie workera);
//  7. kontekst z sesji panelu (pod asystenta): uprawnienie panel.podglad = zakres mcp:odczyt.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { createApiKey, revokeApiKey } from '@/lib/api/zarzadzanie'
import type { ApiScope } from '@/lib/api/zakresy'
import { isPersonalField } from '@/lib/api/zapis'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { zapiszRekordKlienta } from '@/lib/klienci/zapis'
import { rekordZOdbiorcy } from '@/lib/klienci/rekord'
import { MCP_LOG_JOB } from '@/lib/mcp/dziennik'
import { contextFromPanel } from '@/lib/mcp/kontekst'
import { resetMcpLimiters, TOOL_CALLS_PER_MINUTE } from '@/lib/mcp/limity'
import { TOOLS } from '@/lib/mcp/narzedzia'
import { INPOST_SHIPX_ZAPIS_KEY } from '@/lib/adaptery/inpost-zapis'
import { MCP_PROTOCOL_LATEST } from '@/lib/mcp/protokol'
import { validate } from '@/lib/mcp/schemat'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { testAppDbUrl, testDbUrl } from './global-setup'
import { bundle, order, product, seedBase } from './rdzen-fixtures'

vi.mock('server-only', () => ({}))
process.env.DATABASE_URL = testDbUrl()
process.env.APP_DATABASE_URL = testAppDbUrl()

const { resetApiLimiters } = await import('@/lib/api/klucze')
const route = await import('@/app/api/mcp/route')
const { handleMcpHttp } = await import('@/lib/mcp/http')
const { callTool } = await import('@/lib/mcp/serwer')
const { handlers } = await import('@/lib/worker/zadania')

const sys = testSystemDb()
const a = testDb()
const b = testDb({ organizationId: ORG_B })

beforeEach(async () => {
  await truncateAll()
  for (const db of [a, b]) await seedBase(db)
  resetApiLimiters()
  resetMcpLimiters()
})
afterEach(() => {
  vi.unstubAllEnvs()
})
afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})

const IP = '198.51.100.21' // pula dokumentacyjna
const key = async (db: PrismaClient, scopes: ApiScope[] = ['mcp:odczyt'], name = 'Agent testowy') => (await createApiKey(db, { name, scopes }, 'uzytkownik-testowy')).token

type Body = Record<string, unknown>
let rid = 0
const meta = (v = MCP_PROTOCOL_LATEST) => ({ 'io.modelcontextprotocol/protocolVersion': v, 'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} })

function httpReq(body: unknown, token: string | null, headers: Record<string, string> = {}, method = 'POST'): Request {
  return new Request('http://localhost:3100/api/mcp', {
    method,
    headers: { 'x-forwarded-for': IP, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  })
}

/** Żądanie 2026-07-28 z kompletem nagłówków. */
async function modern(token: string | null, method: string, params: Body = {}, extra: Record<string, string> = {}) {
  const body = { jsonrpc: '2.0', id: ++rid, method, params: { ...params, _meta: meta() } }
  const h: Record<string, string> = { 'mcp-protocol-version': MCP_PROTOCOL_LATEST, 'mcp-method': method, ...(method === 'tools/call' ? { 'mcp-name': String(params.name) } : {}), ...extra }
  const res = await route.POST(httpReq(body, token, h))
  return { res, json: (await res.json()) as Body }
}

async function call(token: string, name: string, args: Body = {}) {
  const { res, json } = await modern(token, 'tools/call', { name, arguments: args })
  expect(res.status, name).toBe(200)
  return json.result as { content: { type: string; text: string }[]; structuredContent?: Body; isError?: boolean; resultType?: string }
}

// ─── Dane: firma A z zamówieniem i „danymi osobowymi” w polach, których serwer nie może zwrócić ───────────────

const PII = {
  imie: 'Testimir',
  nazwisko: 'Fikcyjnowski',
  ulica: 'ul. Zmyślona 13/7',
  kod: '00-999',
  miasto: 'Testowo Wielkie',
  telefon: '+48 500 600 700',
  email: 'testimir.fikcyjnowski@example.invalid',
  wiadomosc: 'Proszę zostawić paczkę u sąsiada spod siódemki',
  nip: '1234563218',
}
const PII_VALUES = Object.values(PII)
// dane klienta zapisane w bazie (szyfrogram) z kluczami w env procesu: narzędzia MCP i tak ich nie podają
const KLIENT_ENV = { CUSTOMER_DATA_KEYS: `1:${'1'.repeat(64)}`, CUSTOMER_LOOKUP_KEY: 'a'.repeat(64) }

async function seedA() {
  const przyprawa = await product(a, 'TEST-PRZYPRAWA', 10)
  const kubek = await product(a, 'TEST-KUBEK', 1)
  await bundle(a, 'TEST-ZESTAW', [
    { id: przyprawa, qty: 2 },
    { id: kubek, qty: 1 },
  ])
  await a.channelOffer.create({ data: { channel: 'WOO', channelAccountId: 'sd', externalId: '501', productId: przyprawa } })
  const now = new Date()
  const r = await ingestOrder(a, order([{ productId: przyprawa, qty: 2 }, { productId: kubek, qty: 3 }], { externalId: 'TEST-0001', createdAtChannel: new Date(now.getTime() - 3600_000), paymentState: 'UNPAID' }))
  const r2 = await ingestOrder(a, order([{ productId: przyprawa, qty: 1 }], { externalId: 'TEST-0002', createdAtChannel: new Date(now.getTime() - 1800_000) }))
  // pola, które mogą nieść dane z kanału — serwer nie może ich zwrócić w żadnej postaci
  await a.order.update({ where: { id: r.orderId! }, data: { flags: { odbiorca: `${PII.imie} ${PII.nazwisko}`, adres: `${PII.ulica}, ${PII.kod} ${PII.miasto}`, telefon: PII.telefon, email: PII.email, uwagi: PII.wiadomosc, nip: PII.nip }, cancelReason: PII.wiadomosc, pendingAction: PII.email } })
  await a.orderEvent.create({ data: { orderId: r.orderId!, kind: 'WYSLANE', actorId: 'test', data: { nadanie: 'TEST-NADANIE-1', odbiorca: `${PII.imie} ${PII.nazwisko}`, telefon: PII.telefon, wiadomosc: PII.wiadomosc } } })
  await a.alert.create({ data: { kind: 'TEST', ref: 'test', message: `Klient ${PII.imie} ${PII.nazwisko} pisze: ${PII.wiadomosc}` } })
  // przesyłka ze stanem drogi; opis zdarzenia u przewoźnika z nazwiskiem odbierającego nie może wyjść z narzędzi
  const sh = await a.shipment.create({ data: { orderId: r.orderId!, packageNo: 1, reference: 'mcp-p-1', state: 'UTWORZONA', adapterKey: INPOST_SHIPX_ZAPIS_KEY, carrier: 'PACZKOMATY', trackingNumber: '600000000000000000000001', trackState: 'DORECZONA', trackStateSince: now, trackedAt: now, carrierStatus: `Odebrał ${PII.imie} ${PII.nazwisko}` } })
  await a.shipmentTrackEvent.create({ data: { shipmentId: sh.id, state: 'DORECZONA', occurredAt: now, carrierCode: 'delivered', carrierStatus: `Odebrał ${PII.imie} ${PII.nazwisko}` } })
  // dane klienta zamówienia w OrderCustomer: zaszyfrowane, z kluczem dostępnym w procesie
  const dostawa = { imieNazwisko: `${PII.imie} ${PII.nazwisko}`, firma: null, ulica: PII.ulica, numerDomu: '13', numerLokalu: '7', kodPocztowy: PII.kod, miasto: PII.miasto, kraj: 'PL', telefon: PII.telefon, email: PII.email }
  const faktura = { nazwa: `${PII.imie} ${PII.nazwisko}`, nip: PII.nip, ulica: PII.ulica, kodPocztowy: PII.kod, miasto: PII.miasto, kraj: 'PL' }
  for (const id of [r.orderId!, r2.orderId!])
    await zapiszRekordKlienta(a, id, rekordZOdbiorcy({ dostawa, punktOdbioru: null, faktura, problemy: [] }, PII.wiadomosc), { source: 'KANAL', fetchedAt: now, env: KLIENT_ENV })
  return { przyprawa, kubek, orderId: r.orderId!, order2: r2.orderId! }
}

/** Wszystkie klucze obiektów w wyniku (do sprawdzenia, że żaden nie wygląda na pole danych osobowych). */
function keysOf(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (out.add(k), keysOf(x, out))
  return out
}

describe('MCP: uwierzytelnienie i zakresy', () => {
  it('brak, zły format, nieznany, odwołany klucz i firma nieaktywna: 401 z WWW-Authenticate Bearer, ta sama treść', async () => {
    const revoked = await createApiKey(a, { name: 'stary', scopes: ['mcp:odczyt'] }, 'u')
    await revokeApiKey(a, revoked.id, 'u')
    const inactive = await key(b)
    await sys.organization.update({ where: { id: ORG_B }, data: { active: false } })
    const bodies = new Set<string>()
    for (const t of [null, 'kmp_krotki', `kmp_${'A'.repeat(43)}`, revoked.token, inactive]) {
      const { res, json } = await modern(t, 'tools/list')
      expect(res.status, String(t)).toBe(401)
      expect(res.headers.get('www-authenticate')).toBe('Bearer realm="Kompletor MCP"')
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(json).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32001 } })
      bodies.add(JSON.stringify(json))
    }
    expect(bodies.size).toBe(1)
  })

  it('klucz bez zakresu MCP: lista działa, wywołanie = błąd narzędzia „brak dostępu” i ODMOWA w dzienniku', async () => {
    const t = await key(a, ['stany:odczyt', 'zamowienia:odczyt'], 'Integracja')
    const list = await modern(t, 'tools/list')
    expect(list.res.status).toBe(200)
    const r = await call(t, 'stany', { sku: ['TEST-PRZYPRAWA'] })
    expect(r.isError).toBe(true)
    expect(r.content[0]!.text).toMatch(/zakresu mcp:odczyt/)
    expect(r.structuredContent).toBeUndefined()
    const log = await a.mcpCall.findMany()
    expect(log).toMatchObject([{ tool: 'stany', result: 'ODMOWA', source: 'KLUCZ', params: ['sku'] }])
  })

  it('lastUsedAt klucza podbity przy pierwszym wywołaniu (jak API v1)', async () => {
    const k = await createApiKey(a, { name: 'agent', scopes: ['mcp:odczyt'] }, 'u')
    expect((await a.apiKey.findUniqueOrThrow({ where: { id: k.id } })).lastUsedAt).toBeNull()
    await call(k.token, 'statusy')
    expect((await a.apiKey.findUniqueOrThrow({ where: { id: k.id } })).lastUsedAt).not.toBeNull()
  })
})

describe('MCP: izolacja firm', () => {
  it('klucz firmy B nie widzi zamówień ani produktów firmy A, także po numerze i SKU z firmy A', async () => {
    await seedA()
    const tb = await key(b)
    const ta = await key(a)
    const own = await call(ta, 'zamowienie_szczegoly', { numer: 'TEST-0001' })
    expect((own.structuredContent!.zamowienia as unknown[]).length).toBe(1)
    const r = await call(tb, 'zamowienie_szczegoly', { numer: 'TEST-0001' })
    expect(r.structuredContent).toEqual({ zamowienia: [] })
    expect((await call(tb, 'zamowienia_lista')).structuredContent).toEqual({ zamowienia: [], nastepny: null })
    expect((await call(tb, 'produkt_szczegoly', { sku: 'TEST-PRZYPRAWA' })).structuredContent).toEqual({ produkt: null })
    expect((await call(tb, 'produkty_szukaj', { fraza: 'TEST' })).structuredContent).toEqual({ produkty: [], nastepny: null })
    expect((await call(tb, 'stany', { sku: ['TEST-PRZYPRAWA'] })).structuredContent).toMatchObject({ pozycje: [], nieznaneSku: ['TEST-PRZYPRAWA'] })
    expect((await call(tb, 'braki')).structuredContent).toEqual({ pozycje: [], wiecej: false })
    expect((await call(tb, 'rezerwacje')).structuredContent).toEqual({ pozycje: [], wiecej: false })
    // argument z „firmą” nie istnieje w schemacie — nieznane pole = błąd argumentów, nie podmiana firmy
    const forged = await call(tb, 'zamowienia_lista', { organizationId: ORG_A } as Body)
    expect(forged.isError).toBe(true)
    expect(forged.content[0]!.text).toMatch(/nieznane pole/)
    // dziennik każdej firmy tylko z jej wywołaniami
    expect(await a.mcpCall.count()).toBe(1)
    expect(await b.mcpCall.count()).toBe(8)
  })
})

describe('MCP: brak danych osobowych w wynikach', () => {
  it('każde narzędzie: bez wstawionych imion, adresów, telefonów, e-maili, NIP-u i treści; wynik zgodny ze schematem', async () => {
    for (const [k, v] of Object.entries(KLIENT_ENV)) vi.stubEnv(k, v)
    await seedA()
    expect(await a.orderCustomer.count()).toBe(2) // dane klienta są w bazie (obietnica kompletor.pl: MCP ich nie podaje)
    const t = await key(a)
    const yesterday = new Date(Date.now() - 2 * 24 * 3600_000).toISOString()
    const calls: [string, Body][] = [
      ['zamowienia_lista', {}],
      ['zamowienia_lista', { platnosc: ['UNPAID'], zlozone_od: yesterday }],
      ['zamowienie_szczegoly', { numer: 'TEST-0001' }],
      ['stany', { sku: ['TEST-PRZYPRAWA', 'TEST-KUBEK', 'TEST-ZESTAW'] }],
      ['stany', { kanal: 'WOO', konto: 'sd' }],
      ['produkty_szukaj', { fraza: 'TEST' }],
      ['produkt_szczegoly', { sku: 'TEST-ZESTAW' }],
      ['produkt_szczegoly', { sku: 'TEST-PRZYPRAWA' }],
      ['statusy', {}],
      ['raport_dnia', {}],
      ['braki', {}],
      ['rezerwacje', {}],
      ['raport_sprzedazy', {}],
      ['automaty', {}],
    ]
    expect(new Set(calls.map(([n]) => n))).toEqual(new Set(TOOLS.map((x) => x.name))) // każde narzędzie w teście
    for (const [name, args] of calls) {
      const r = await call(t, name, args)
      expect(r.isError, `${name}: ${r.content[0]?.text}`).toBeFalsy()
      expect(r.resultType).toBe('complete')
      const text = JSON.stringify(r)
      for (const v of PII_VALUES) expect(text, `${name} zawiera ${v}`).not.toContain(v)
      for (const k of keysOf(r.structuredContent)) expect(isPersonalField(k), `${name}: pole ${k}`).toBe(false)
      const tool = TOOLS.find((x) => x.name === name)!
      expect(validate(tool.outputSchema, r.structuredContent), name).toEqual([])
      // treść tekstowa = ten sam JSON (zgodność wstecz, spec tools: structured content)
      expect(JSON.parse(r.content[0]!.text)).toEqual(r.structuredContent)
    }
    // sanity: dane z rdzenia są w wynikach (inaczej test niczego by nie dowodził)
    const one = await call(t, 'zamowienie_szczegoly', { numer: 'TEST-0001' })
    expect(one.structuredContent).toMatchObject({ zamowienia: [{ numer: 'TEST-0001', platnosc: 'UNPAID', numerNadania: 'TEST-NADANIE-1', pozycje: [{ sku: 'TEST-PRZYPRAWA', ilosc: 2 }, { sku: 'TEST-KUBEK', ilosc: 3 }], przesylki: [{ numerNadania: '600000000000000000000001', stan: 'DORECZONA', rodzaj: 'GLOWNA' }] }] })
    const braki = await call(t, 'braki')
    expect(braki.structuredContent).toMatchObject({ pozycje: [{ sku: 'TEST-KUBEK', brakuje: 2, zamowien: 1, zamowienia: [{ numer: 'TEST-0001' }] }] })
    const rez = await call(t, 'rezerwacje', { sku: ['TEST-PRZYPRAWA'] })
    expect(rez.structuredContent).toMatchObject({ pozycje: [{ sku: 'TEST-PRZYPRAWA', zarezerwowane: 3, zamowien: 2 }] })
    const dzien = await call(t, 'raport_dnia')
    expect(dzien.structuredContent).toMatchObject({ wyslaneDzis: 1, praca: { zamowienZBrakami: 1 } })
    const lista = await call(t, 'zamowienia_lista', { platnosc: ['UNPAID'] })
    expect((lista.structuredContent!.zamowienia as { numer: string }[]).map((o) => o.numer)).toEqual(['TEST-0001'])
    const zestaw = await call(t, 'produkt_szczegoly', { sku: 'TEST-ZESTAW' })
    expect(zestaw.structuredContent).toMatchObject({ produkt: { rodzaj: 'BUNDLE', skladniki: [{ sku: 'TEST-KUBEK', ilosc: 1 }, { sku: 'TEST-PRZYPRAWA', ilosc: 2 }] } })
  })
})

describe('MCP: protokół', () => {
  it('2026-07-28: server/discover, tools/list (deterministyczna lista, resultType, ttlMs, serverInfo), tools/call', async () => {
    const t = await key(a)
    const d = await modern(t, 'server/discover')
    expect(d.res.status).toBe(200)
    expect(d.res.headers.get('mcp-session-id')).toBeNull()
    expect(d.json.result).toMatchObject({ resultType: 'complete', supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'], capabilities: { tools: {} }, cacheScope: 'public' })
    const l1 = await modern(t, 'tools/list')
    const l2 = await modern(t, 'tools/list')
    const tools = (l1.json.result as { tools: { name: string; annotations: Body; inputSchema: Body }[] }).tools
    expect(tools.map((x) => x.name)).toEqual(['zamowienia_lista', 'zamowienie_szczegoly', 'stany', 'produkty_szukaj', 'produkt_szczegoly', 'statusy', 'raport_dnia', 'braki', 'rezerwacje', 'raport_sprzedazy', 'automaty'])
    expect(JSON.stringify(l1.json.result)).toBe(JSON.stringify(l2.json.result))
    expect(l1.json.result).toMatchObject({ resultType: 'complete', ttlMs: 300000, cacheScope: 'public', _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'kompletor' } } })
    for (const x of tools) expect(x.annotations, x.name).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false })
    const c = await call(t, 'statusy')
    expect(c.structuredContent).toMatchObject({ statusy: expect.arrayContaining([{ symbol: 'DO_WYJASNIENIA', nazwa: 'Do wyjaśnienia', opis: expect.any(String) }]) })
  })

  it('2025-11-25 bez sesji: initialize (bez nagłówka wersji), notifications/initialized = 202, ping, tools/list i call z nagłówkiem', async () => {
    const t = await key(a)
    const init = await route.POST(httpReq({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'stary', version: '1' } } }, t))
    expect(init.status).toBe(200)
    expect(init.headers.get('mcp-session-id')).toBeNull()
    expect((await init.json()).result).toMatchObject({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'kompletor' }, instructions: expect.stringContaining('Dane klientów') })
    const older = await route.POST(httpReq({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }, t))
    expect((await older.json()).result.protocolVersion).toBe('2025-11-25')
    const juneInit = await route.POST(httpReq({ jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }, t))
    expect((await juneInit.json()).result.protocolVersion).toBe('2025-06-18')
    const note = await route.POST(httpReq({ jsonrpc: '2.0', method: 'notifications/initialized' }, t, { 'mcp-protocol-version': '2025-11-25' }))
    expect(note.status).toBe(202)
    expect(await note.text()).toBe('')
    const h = { 'mcp-protocol-version': '2025-11-25' }
    const ping = await route.POST(httpReq({ jsonrpc: '2.0', id: 4, method: 'ping' }, t, h))
    expect(await ping.json()).toEqual({ jsonrpc: '2.0', id: 4, result: {} })
    const list = await (await route.POST(httpReq({ jsonrpc: '2.0', id: 5, method: 'tools/list' }, t, h))).json()
    expect(list.result.tools).toHaveLength(TOOLS.length)
    expect(list.result.resultType).toBeUndefined()
    const c = await (await route.POST(httpReq({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'statusy', arguments: {} } }, t, h))).json()
    expect(c.result.isError).toBeUndefined()
    expect(c.result.structuredContent.statusy.length).toBe(12)
    // nieznana metoda w 2025-11-25: 200 z -32601 (404 znaczyłoby tam „sesja wygasła”)
    const unk = await route.POST(httpReq({ jsonrpc: '2.0', id: 7, method: 'resources/list' }, t, h))
    expect(unk.status).toBe(200)
    expect((await unk.json()).error.code).toBe(-32601)
  })

  it('wersje: nieobsługiwana = 400 -32022 z listą; brak nagłówka = 2025-11-25; niezgodne nagłówki = 400 -32020', async () => {
    const t = await key(a)
    const bad = await route.POST(httpReq({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta('2099-01-01') } }, t, { 'mcp-protocol-version': '2099-01-01', 'mcp-method': 'tools/list' }))
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ id: 1, error: { code: -32022, data: { supported: ['2026-07-28', '2025-11-25', '2025-06-18'], requested: '2099-01-01' } } })
    const legacyBad = await route.POST(httpReq({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, t, { 'mcp-protocol-version': '2025-03-26' }))
    expect(legacyBad.status).toBe(400)
    expect((await legacyBad.json()).error).toMatchObject({ code: -32022, data: { requested: '2025-03-26' } })
    const noHeader = await route.POST(httpReq({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, t))
    expect(noHeader.status).toBe(200)
    expect((await noHeader.json()).result.tools.length).toBeGreaterThan(0)
    // _meta modern bez nagłówka wersji / z innym nagłówkiem / zły Mcp-Method / zły Mcp-Name
    const body = { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'statusy', arguments: {}, _meta: meta() } }
    const cases: Record<string, string>[] = [
      { 'mcp-method': 'tools/call', 'mcp-name': 'statusy' },
      { 'mcp-protocol-version': '2025-11-25', 'mcp-method': 'tools/call', 'mcp-name': 'statusy' },
      { 'mcp-protocol-version': MCP_PROTOCOL_LATEST, 'mcp-method': 'tools/list', 'mcp-name': 'statusy' },
      { 'mcp-protocol-version': MCP_PROTOCOL_LATEST, 'mcp-method': 'tools/call', 'mcp-name': 'stany' },
      { 'mcp-protocol-version': MCP_PROTOCOL_LATEST, 'mcp-method': 'tools/call' },
    ]
    for (const h of cases) {
      const r = await route.POST(httpReq(body, t, h))
      expect(r.status, JSON.stringify(h)).toBe(400)
      expect((await r.json()).error.code, JSON.stringify(h)).toBe(-32020)
    }
    // Mcp-Name w zapisie base64 (wartość spoza ASCII albo dowolna) jest dekodowany przed porównaniem
    const enc = await route.POST(httpReq(body, t, { 'mcp-protocol-version': MCP_PROTOCOL_LATEST, 'mcp-method': 'tools/call', 'mcp-name': `=?base64?${Buffer.from('statusy').toString('base64')}?=` }))
    expect(enc.status).toBe(200)
  })

  it('nieznane narzędzie = -32602; nieznana metoda 2026-07-28 = 404 -32601; bez wpisu w dzienniku', async () => {
    const t = await key(a)
    const u = await modern(t, 'tools/call', { name: 'usun_wszystko', arguments: {} })
    expect(u.res.status).toBe(200)
    expect(u.json.error).toMatchObject({ code: -32602, message: 'Unknown tool: usun_wszystko' })
    const m = await modern(t, 'resources/list')
    expect(m.res.status).toBe(404)
    expect((m.json.error as Body).code).toBe(-32601)
    const init = await modern(t, 'initialize') // w 2026-07-28 nie ma initialize
    expect(init.res.status).toBe(404)
    expect(await a.mcpCall.count()).toBe(0)
  })

  it('transport: GET/DELETE 405, zły Origin 403, dozwolony Origin z PANEL_URL, za duża treść 413, paczka i zły JSON 400, powiadomienie 202', async () => {
    const t = await key(a)
    for (const fn of [route.GET, route.DELETE]) {
      const r = await fn()
      expect(r.status).toBe(405)
      expect(r.headers.get('allow')).toBe('POST')
    }
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta() } }
    const h = { 'mcp-protocol-version': MCP_PROTOCOL_LATEST, 'mcp-method': 'tools/list' }
    const env = { PANEL_URL: 'https://kompletor.example.invalid', MCP_DOZWOLONE_ORIGINY: 'https://agent.example.invalid, zle' }
    const evil = await handleMcpHttp(httpReq(body, t, { ...h, origin: 'https://zly.example.invalid' }), { env })
    expect(evil.status).toBe(403)
    expect((await handleMcpHttp(httpReq(body, t, { ...h, origin: 'null' }), { env })).status).toBe(403)
    expect((await handleMcpHttp(httpReq(body, t, { ...h, origin: 'https://kompletor.example.invalid' }), { env })).status).toBe(200)
    expect((await handleMcpHttp(httpReq(body, t, { ...h, origin: 'https://agent.example.invalid' }), { env })).status).toBe(200)
    expect((await handleMcpHttp(httpReq(body, t, h), { env })).status).toBe(200) // bez Origin (CLI, serwer)
    // Origin sprawdzany przed kluczem: obca strona nie dostaje nawet 401
    expect((await handleMcpHttp(httpReq(body, null, { ...h, origin: 'https://zly.example.invalid' }), { env })).status).toBe(403)
    const big = await route.POST(httpReq({ ...body, params: { ...body.params, x: 'a'.repeat(70 * 1024) } }, t, h))
    expect(big.status).toBe(413)
    const batch = await route.POST(httpReq([body], t, h))
    expect(batch.status).toBe(400)
    expect((await batch.json()).error.code).toBe(-32600)
    const junk = await route.POST(httpReq('{nie json', t, h))
    expect(junk.status).toBe(400)
    expect((await junk.json()).error.code).toBe(-32700)
    expect((await route.POST(httpReq(body, t, { ...h, 'content-type': 'text/plain' }))).status).toBe(415)
    expect((await route.POST(httpReq(body, t, { ...h, accept: 'text/html' }))).status).toBe(406)
    const note = await route.POST(httpReq({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }, t, h))
    expect(note.status).toBe(202)
  })

  it('złe argumenty narzędzia = błąd narzędzia (model może poprawić), BLAD w dzienniku', async () => {
    const t = await key(a)
    const r = await call(t, 'zamowienia_lista', { status: ['NIEZNANY'], limit: 500 })
    expect(r.isError).toBe(true)
    expect(r.content[0]!.text).toMatch(/Złe argumenty/)
    const old = await call(t, 'zamowienia_lista', { zmienione_od: '2020-01-01' })
    expect(old.content[0]!.text).toMatch(/14 dni/)
    expect((await a.mcpCall.findMany({ orderBy: { createdAt: 'asc' } })).map((x) => x.result)).toEqual(['BLAD', 'BLAD'])
  })
})

describe('MCP: limity i dziennik', () => {
  it(`po ${TOOL_CALLS_PER_MINUTE} wywołaniach na minutę: błąd narzędzia z czasem ponowienia, LIMIT w dzienniku; inny klucz bez zmian`, async () => {
    const t = await key(a)
    for (let i = 0; i < TOOL_CALLS_PER_MINUTE; i++) expect((await call(t, 'statusy')).isError).toBeFalsy()
    const over = await call(t, 'statusy')
    expect(over.isError).toBe(true)
    expect(over.content[0]!.text).toMatch(/Spróbuj ponownie za \d+ s/)
    expect(await a.mcpCall.count({ where: { result: 'LIMIT' } })).toBe(1)
    expect((await call(await key(a, ['mcp:odczyt'], 'drugi'), 'statusy')).isError).toBeFalsy()
  })

  it('wpis na każde wywołanie: narzędzie, wynik, czas, liczba pozycji, NAZWY parametrów — bez wartości', async () => {
    await seedA()
    const t = await key(a)
    await call(t, 'zamowienie_szczegoly', { numer: 'TEST-0001' })
    await call(t, 'produkty_szukaj', { fraza: 'PRZYPRAWA', limit: 5 })
    const rows = await sys.mcpCall.findMany({ orderBy: { createdAt: 'asc' } })
    expect(rows).toMatchObject([
      { organizationId: ORG_A, tool: 'zamowienie_szczegoly', result: 'OK', items: 1, params: ['numer'], source: 'KLUCZ' },
      { organizationId: ORG_A, tool: 'produkty_szukaj', result: 'OK', items: 1, params: ['fraza', 'limit'] },
    ])
    const raw = JSON.stringify(rows)
    for (const v of ['TEST-0001', 'PRZYPRAWA']) expect(raw).not.toContain(v)
    expect(rows.every((r) => r.durationMs >= 0)).toBe(true)
  })

  it('czyszczenie po 90 dniach: zadanie workera usuwa stare wpisy firmy, zostawia nowsze', async () => {
    const t = await key(a)
    await call(t, 'statusy')
    await call(t, 'statusy')
    const [old] = await a.mcpCall.findMany({ take: 1 })
    await sys.mcpCall.update({ where: { id: old!.id }, data: { createdAt: new Date(Date.now() - 91 * 24 * 3600_000) } })
    expect(handlers[MCP_LOG_JOB]).toBeTypeOf('function')
    await handlers[MCP_LOG_JOB]!(a, null, { secrets: { env: {} } } as never)
    expect(await a.mcpCall.count()).toBe(1)
  })
})

describe('MCP: kontekst z sesji panelu (pod asystenta)', () => {
  it('panel.podglad = mcp:odczyt; bez uprawnienia odmowa; wpis dziennika ze źródłem PANEL i osobą', async () => {
    await seedA()
    const ok = contextFromPanel({ db: a, organizationId: ORG_A, userId: 'osoba-testowa', permissions: new Set(['panel.podglad']) })
    const r = await callTool(ok, 'stany', { sku: ['TEST-PRZYPRAWA'] })
    expect(r.status).toBe('OK')
    expect(r.result.structuredContent).toMatchObject({ pozycje: [{ sku: 'TEST-PRZYPRAWA' }] })
    const no = contextFromPanel({ db: a, organizationId: ORG_A, userId: 'osoba-testowa', permissions: new Set(['ustawienia']) })
    expect((await callTool(no, 'stany', { sku: ['TEST-PRZYPRAWA'] })).status).toBe('ODMOWA')
    expect(await a.mcpCall.findMany({ orderBy: { createdAt: 'asc' }, select: { source: true, userId: true, apiKeyId: true, result: true } })).toEqual([
      { source: 'PANEL', userId: 'osoba-testowa', apiKeyId: null, result: 'OK' },
      { source: 'PANEL', userId: 'osoba-testowa', apiKeyId: null, result: 'ODMOWA' },
    ])
  })
})
