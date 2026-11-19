// części bez bazy — grupy alertów, walidacja adresu Zulipa (SSRF), strumień/temat, env, treść bez danych
// klientów, transport z atrapą fetch. Dane wyłącznie zmyślone (domeny .test, numery fikcyjne).
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { allowedHostsZEnv, parseName, parseZulipSite, powiadomieniaZEnv, publicUrlZEnv, routesOf, wysylkaZEnv } from './adres'
import { DEFAULT_ROUTES, groupOf, kindLabel } from './grupy'
import { alertMessage, safeRef } from './tresc'
import { sendZulipMessage } from './zulip'

/** Rodzaje alertów wołane w kodzie (`alert(db, 'RODZAJ'`), bez testów. */
function alertKindsInCode(): string[] {
  const root = path.resolve(__dirname, '..')
  const out = new Set<string>()
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) {
        const src = readFileSync(p, 'utf8')
        for (const m of src.matchAll(/\balert\(\s*\w+,\s*'([A-Z_]+)'/g)) out.add(m[1]!)
        // alerty zapisywane wprost (`db.alert.create({ data: { kind: 'RODZAJ'`), także z `.create` w nowej linii
        for (const m of src.matchAll(/\balert\s*\.\s*(?:create|upsert)\(\s*\{[^}]*?\bkind:\s*'([A-Z_]+)'/g)) out.add(m[1]!)
      }
    }
  }
  walk(root)
  return [...out].sort()
}

describe('grupy alertów', () => {
  it('każdy rodzaj alertu z kodu ma polską etykietę', () => {
    const kinds = alertKindsInCode()
    expect(kinds.length).toBeGreaterThan(20)
    expect(kinds.filter((k) => kindLabel(k) === k)).toEqual([])
    // rodzaje ze stałych (oś statusów przesyłki), poza wyszukiwaniem literałów w kodzie
    expect(kindLabel('PRZESYLKA_ZWROT')).not.toBe('PRZESYLKA_ZWROT')
    expect(kindLabel('PRZESYLKA_PROBLEM')).not.toBe('PRZESYLKA_PROBLEM')
    expect(groupOf('BRAK_PRZY_PAKOWANIU')).toBe('MAGAZYN')
    expect(groupOf('DOSLANIE_ZAMIAST_ZWROTU')).toBe('MAGAZYN')
    expect(groupOf('NOC_SYNC_BLAD')).toBe('KANAL_STANY')
    expect(groupOf('WFIRMA_ODCZYT_BLAD')).toBe('FAKTURY')
    for (const k of ['PRZEPIECIE_OFERTY_W_TOKU', 'PRZEPIECIE_OFERTY_RESZTA', 'PRZEPIECIE_OFERTY_BLAD', 'LACZENIE_OFERT_BLAD']) {
      expect(kinds).toContain(k)
      expect(groupOf(k)).toBe('KANAL_ZAMOWIENIA')
    }
  })
  it('stała mapa rodzajów, nieznany rodzaj = „Inne”', () => {
    expect(groupOf('KANAL_NIEDOSTEPNY')).toBe('KANAL_STANY')
    expect(groupOf('KANAL_ZAMOWIENIA_NIEDOSTEPNY')).toBe('KANAL_ZAMOWIENIA')
    for (const k of ['FAKTURA_BLAD', 'FAKTURA_BEZ_WZ', 'DUBLET_FAKTURY', 'WFIRMA_LIMIT', 'KOREKTA_BLAD', 'DUBLET_KOREKTY']) expect(groupOf(k)).toBe('FAKTURY')
    expect(groupOf('BRAK_NA_POLCE')).toBe('MAGAZYN')
    expect(groupOf('NADMIAR_REZERWACJI')).toBe('MAGAZYN')
    expect(groupOf('NIEZMIENNIK')).toBe('INNE')
    expect(groupOf('ZUPELNIE_NOWY_RODZAJ')).toBe('INNE')
    expect(groupOf('__proto__')).toBe('INNE')
    expect(groupOf('toString')).toBe('INNE')
    expect(kindLabel('ZUPELNIE_NOWY_RODZAJ')).toBe('ZUPELNIE_NOWY_RODZAJ')
  })

  it('trasy domyślne: Biuro, magazyn do „Magazyn”; zapisany pusty = bez trasy', () => {
    expect(DEFAULT_ROUTES.MAGAZYN?.stream).toBe('Magazyn')
    expect(DEFAULT_ROUTES.FAKTURY?.stream).toBe('Biuro')
    expect(routesOf({})).toEqual(DEFAULT_ROUTES)
    const r = routesOf({ FAKTURY: null, INNE: { stream: 'Ogólny', topic: 'Alerty' }, MAGAZYN: { stream: 'x\u0007', topic: 't' } })
    expect(r.FAKTURY).toBeNull()
    expect(r.INNE).toEqual({ stream: 'Ogólny', topic: 'Alerty' })
    expect(r.MAGAZYN).toBeNull() // niepoprawna z bazy = bez trasy, nie wysyłka w ciemno
    expect(r.KANAL_STANY).toEqual(DEFAULT_ROUTES.KANAL_STANY)
  })
})

describe('adres Zulipa (SSRF)', () => {
  const env = {}
  it('przyjmuje https://*.zulipchat.com i normalizuje', () => {
    expect(parseZulipSite('https://Firma.zulipchat.com/', env)).toBe('https://firma.zulipchat.com')
    expect(parseZulipSite(' https://a-b.zulipchat.com ', env)).toBe('https://a-b.zulipchat.com')
  })

  it.each([
    ['http://firma.zulipchat.com', /https/],
    ['https://zulipchat.com', /spoza listy/],
    ['https://firma.zulipchat.com.zly.test', /spoza listy/],
    ['https://zlyzulipchat.com', /spoza listy/],
    ['https://firma.zulipchat.com:8443', /portu/],
    ['https://firma.zulipchat.com/api', /ścieżki/],
    ['https://firma.zulipchat.com?x=1', /ścieżki/],
    ['https://u:p@firma.zulipchat.com', /użytkownika/],
    ['https://127.0.0.1', /IP|hosta/],
    ['https://[::1]', /IP|hosta/],
    ['https://localhost', /IP|hosta|localhost/],
    ['https://169.254.169.254', /IP|hosta/],
    ['https://0x7f000001', /spoza listy|hosta/],
    ['ftp://firma.zulipchat.com', /https/],
    ['firma.zulipchat.com', /format|https/],
    ['', /Podaj/],
  ])('odrzuca %s', (raw, re) => {
    expect(() => parseZulipSite(raw, env)).toThrow(re)
  })

  it('ZULIP_DOZWOLONE_HOSTY zastępuje listę (self-host); zły wpis = błąd', () => {
    const own = { ZULIP_DOZWOLONE_HOSTY: 'zulip.firma.test, *.czat.test' }
    expect(parseZulipSite('https://zulip.firma.test', own)).toBe('https://zulip.firma.test')
    expect(parseZulipSite('https://a.czat.test', own)).toBe('https://a.czat.test')
    expect(() => parseZulipSite('https://czat.test', own)).toThrow(/spoza listy/)
    expect(() => parseZulipSite('https://firma.zulipchat.com', own)).toThrow(/spoza listy/)
    for (const bad of ['10.0.0.1', 'localhost', 'zulip.firma.test:443', 'https://x.test', 'a.test/x']) expect(() => allowedHostsZEnv({ ZULIP_DOZWOLONE_HOSTY: bad })).toThrow(/ZULIP_DOZWOLONE_HOSTY/)
  })

  it('strumień i temat: 60 znaków, bez znaków sterujących', () => {
    expect(parseName('  Biuro ', 'Strumień')).toBe('Biuro')
    expect(parseName('ż'.repeat(60), 'Temat')).toHaveLength(60)
    expect(() => parseName('a'.repeat(61), 'Temat')).toThrow(/60/)
    expect(() => parseName('', 'Strumień')).toThrow(/puste/)
    expect(() => parseName('a\nb', 'Temat')).toThrow(/sterujące/)
    expect(() => parseName('a‮b', 'Temat')).toThrow(/sterujące/)
  })
})

describe('env instancji', () => {
  it('POWIADOMIENIA_WYSYLKA domyślnie wyłączona; zła wartość = błąd', () => {
    expect(wysylkaZEnv({})).toBe(false)
    expect(wysylkaZEnv({ POWIADOMIENIA_WYSYLKA: '' })).toBe(false)
    expect(wysylkaZEnv({ POWIADOMIENIA_WYSYLKA: '0' })).toBe(false)
    expect(wysylkaZEnv({ POWIADOMIENIA_WYSYLKA: ' 1 ' })).toBe(true)
    for (const bad of ['tak', 'true', '2']) expect(() => wysylkaZEnv({ POWIADOMIENIA_WYSYLKA: bad })).toThrow(/POWIADOMIENIA_WYSYLKA/)
  })

  it('APP_PUBLIC_URL opcjonalny, zły = błąd; całość sprawdzana na starcie', () => {
    expect(publicUrlZEnv({})).toBeNull()
    expect(publicUrlZEnv({ APP_PUBLIC_URL: 'https://panel.firma.test/' })).toBe('https://panel.firma.test')
    expect(() => publicUrlZEnv({ APP_PUBLIC_URL: 'panel' })).toThrow(/APP_PUBLIC_URL/)
    expect(() => publicUrlZEnv({ APP_PUBLIC_URL: 'javascript:alert(1)' })).toThrow(/APP_PUBLIC_URL/)
    expect(() => powiadomieniaZEnv({ ZULIP_DOZWOLONE_HOSTY: '127.0.0.1' })).toThrow(/ZULIP_DOZWOLONE_HOSTY/)
  })
})

describe('treść wiadomości bez danych klientów', () => {
  it('nie używa Alert.message; ref z mailem ukryty', () => {
    const at = new Date('2026-11-02T13:05:00Z')
    const m = alertMessage({ kind: 'FAKTURA_BLAD', ref: 'SD-100234', createdAt: at }, 'Firma Testowa', 'https://panel.firma.test')
    expect(m).toContain('Błąd wystawienia faktury')
    expect(m).toContain('Firma Testowa')
    expect(m).toContain('`SD-100234`')
    expect(m).toContain('14:05')
    expect(m).toContain('https://panel.firma.test/pulpit')
    expect(alertMessage({ kind: 'X', ref: 'a', createdAt: at }, 'F', null)).not.toContain('http')
    expect(safeRef('jan.kowalski@przyklad.test')).toBe('(ukryty)')
    expect(safeRef('ALLEGRO_SD/71045')).toBe('ALLEGRO_SD/71045')
    expect(safeRef('a`b\nc')).toBe('a b c')
  })
})

describe('transport Zulip (atrapa fetch)', () => {
  const target = { site: 'https://firma.zulipchat.com', botEmail: 'bot@firma.zulipchat.com', apiKey: 'klucz-testowy-0001' }
  const msg = { stream: 'Biuro', topic: 'Faktury', content: 'treść' }
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => async () => new Response(JSON.stringify(body), { status, headers })

  it('kształt żądania: POST /api/v1/messages, Basic Auth, formularz type/to/topic/content, bez przekierowań', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const r = await sendZulipMessage(target, msg, async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ result: 'success', msg: '', id: 42 }), { status: 200 })
    })
    expect(r).toEqual({ kind: 'SENT', messageId: 42 })
    expect(calls[0]!.url).toBe('https://firma.zulipchat.com/api/v1/messages')
    expect(calls[0]!.init?.method).toBe('POST')
    expect(calls[0]!.init?.redirect).toBe('error')
    const h = calls[0]!.init?.headers as Record<string, string>
    expect(Buffer.from(h.Authorization!.replace('Basic ', ''), 'base64').toString()).toBe('bot@firma.zulipchat.com:klucz-testowy-0001')
    const body = new URLSearchParams(String(calls[0]!.init?.body))
    expect(Object.fromEntries(body)).toEqual({ type: 'stream', to: 'Biuro', topic: 'Faktury', content: 'treść' })
  })

  it('klasyfikacja odpowiedzi; błąd bez klucza', async () => {
    expect((await sendZulipMessage(target, msg, reply(429, { result: 'error', code: 'RATE_LIMIT_HIT' }, { 'retry-after': '3' })))).toEqual({ kind: 'RETRY', error: 'HTTP 429 RATE_LIMIT_HIT', retryAfterMs: 3000 })
    expect((await sendZulipMessage(target, msg, reply(503, {}))).kind).toBe('RETRY')
    expect((await sendZulipMessage(target, msg, reply(504, {}))).kind).toBe('UNCERTAIN')
    expect((await sendZulipMessage(target, msg, reply(401, { result: 'error', code: 'UNAUTHORIZED' }))).kind).toBe('AUTH')
    expect((await sendZulipMessage(target, msg, reply(403, {}))).kind).toBe('AUTH')
    expect(await sendZulipMessage(target, msg, reply(400, { result: 'error', code: 'STREAM_DOES_NOT_EXIST', msg: 'Stream Biuro does not exist' }))).toEqual({ kind: 'REJECTED', error: 'HTTP 400 STREAM_DOES_NOT_EXIST' })
    const refused = await sendZulipMessage(target, msg, async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    })
    expect(refused.kind).toBe('RETRY')
    const reset = await sendZulipMessage(target, msg, async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })
    })
    expect(reset.kind).toBe('UNCERTAIN')
    for (const r of [refused, reset]) expect(JSON.stringify(r)).not.toContain('klucz-testowy')
  })

  it('timeout po wysłaniu = UNCERTAIN', async () => {
    const r = await sendZulipMessage(
      target,
      msg,
      (_u, init) =>
        new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
      30,
    )
    expect(r.kind).toBe('UNCERTAIN')
  })
})
