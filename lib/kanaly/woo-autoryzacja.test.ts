// „Połącz z WooCommerce” bez bazy — adres panelu, podpisany `user_id`, link do strony zatwierdzenia.
import { describe, expect, it } from 'vitest'
import { adresPaneluWoo, CALLBACK_PATH, linkAutoryzacji, podpiszZnacznik, przyjmijKluczeWoo, sprawdzZnacznik } from './woo-autoryzacja'

const ENV = { APP_ENCRYPTION_KEY: 'a'.repeat(64) }
const ENV2 = { APP_ENCRYPTION_KEYS: `2:${'b'.repeat(64)},1:${'a'.repeat(64)}` }
const T = new Date('2026-11-08T12:00:00.000Z')
const Z = { o: 'test_a', a: 'sklep-1', n: 'N'.repeat(32), e: Math.floor(T.getTime() / 1000) + 900 }

describe('adres panelu dla sklepu', () => {
  it('https z APP_PUBLIC_URL albo PANEL_URL, bez końcowego „/”', () => {
    expect(adresPaneluWoo({ PANEL_URL: 'https://panel.example.pl/' })).toEqual({ ok: true, url: 'https://panel.example.pl' })
    expect(adresPaneluWoo({ APP_PUBLIC_URL: 'https://a.example.pl/kompletor/', PANEL_URL: 'https://b.example.pl' })).toEqual({ ok: true, url: 'https://a.example.pl/kompletor' })
  })
  it('brak, http, adres lokalny, zapytanie w adresie = powód po polsku', () => {
    for (const env of [{}, { PANEL_URL: 'http://panel.example.pl' }, { PANEL_URL: 'https://localhost:3100' }, { PANEL_URL: 'https://192.168.1.5' }, { PANEL_URL: 'https://panel.example.pl/?x=1' }, { PANEL_URL: 'nie-adres' }]) {
      const r = adresPaneluWoo(env)
      expect(r.ok, JSON.stringify(env)).toBe(false)
      if (!r.ok) expect(r.powod).toMatch(/[ąęółśżźćń]/)
    }
  })
})

describe('podpisany user_id', () => {
  it('podpis przechodzi, termin liczony; zmiana jednego znaku albo inny klucz główny = odmowa', () => {
    const t = podpiszZnacznik(ENV, Z)
    expect(t).toMatch(/^w1\.1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/)
    expect(t.length).toBeLessThan(250)
    expect(sprawdzZnacznik(ENV, t, T)).toEqual({ z: Z, wygasl: false })
    expect(sprawdzZnacznik(ENV, t, new Date(Z.e * 1000))).toMatchObject({ wygasl: true })
    const [w, v, dane, sig] = t.split('.')
    const inneDane = Buffer.from(JSON.stringify({ ...Z, o: 'test_b' })).toString('base64url')
    expect(sprawdzZnacznik(ENV, [w, v, inneDane, sig].join('.'), T)).toBeNull()
    expect(sprawdzZnacznik(ENV, [w, v, dane, sig!.slice(0, -1) + (sig!.endsWith('A') ? 'B' : 'A')].join('.'), T)).toBeNull()
    expect(sprawdzZnacznik({ APP_ENCRYPTION_KEY: 'c'.repeat(64) }, t, T)).toBeNull()
    expect(sprawdzZnacznik({}, t, T)).toBeNull()
    expect(sprawdzZnacznik(ENV, 'cokolwiek', T)).toBeNull()
  })
  it('po rotacji klucza głównego stary link (wersja 1) dalej działa, nowy podpisuje wersja 2', () => {
    const stary = podpiszZnacznik(ENV, Z)
    expect(sprawdzZnacznik(ENV2, stary, T)).toMatchObject({ wygasl: false })
    expect(podpiszZnacznik(ENV2, Z)).toMatch(/^w1\.2\./)
  })
})

describe('link do sklepu', () => {
  it('wc-auth z zakresem, powrotem na ekran konta i adresem przyjęcia kluczy', () => {
    const u = new URL(linkAutoryzacji('https://sklep.example/sklep', 'https://panel.example.pl', { channel: 'WOO', channelAccountId: 'sklep-1' }, 'read', 'w1.1.x.y'))
    expect(u.origin + u.pathname).toBe('https://sklep.example/sklep/wc-auth/v1/authorize')
    expect(Object.fromEntries(u.searchParams)).toEqual({
      app_name: 'Kompletor',
      scope: 'read',
      user_id: 'w1.1.x.y',
      return_url: 'https://panel.example.pl/ustawienia/kanaly/WOO.sklep-1?woo=powrot',
      callback_url: `https://panel.example.pl${CALLBACK_PATH}`,
    })
  })
})

describe('przyjęcie kluczy: odmowy przed bazą', () => {
  const nieWolno = () => {
    throw new Error('baza nie powinna być ruszana')
  }
  const ok = { key_id: 1, consumer_key: `ck_${'1'.repeat(40)}`, consumer_secret: `cs_${'2'.repeat(40)}`, key_permissions: 'read' }
  it('zły kształt, zły podpis i termin nie dotykają bazy', async () => {
    expect(await przyjmijKluczeWoo(null, { env: ENV, now: T, db: nieWolno })).toEqual({ status: 400, kod: 'zly-ksztalt' })
    // klucz o złym kształcie po poprawnym podpisie idzie pod blokadę (zużywa znacznik,
    // wpis w historii), więc dotyka bazy: test w tests/woo-polacz.integration.test.ts („D-3: Połączono…”)
    expect(await przyjmijKluczeWoo({ ...ok, user_id: 'w1.1.abcdefghijk.' + 'A'.repeat(43) }, { env: ENV, now: T, db: nieWolno })).toEqual({ status: 403, kod: 'zly-podpis' })
    // bez podpisu kształt kluczy nie ma znaczenia — zawsze 403, nie 400
    expect(await przyjmijKluczeWoo({ ...ok, user_id: 'w1.1.abcdefghijk.' + 'A'.repeat(43), consumer_key: 'nie-klucz' }, { env: ENV, now: T, db: nieWolno })).toEqual({ status: 403, kod: 'zly-podpis' })
    expect(await przyjmijKluczeWoo({ ...ok, user_id: podpiszZnacznik(ENV, Z) }, { env: ENV, now: new Date(Z.e * 1000 + 1), db: nieWolno })).toEqual({ status: 410, kod: 'wygasl' })
  })
})
