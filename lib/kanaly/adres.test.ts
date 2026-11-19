// adres sklepu z formularza (SSRF). Lista złych adresów, także IPv6 i postacie liczbowe IPv4.
import { describe, expect, it, vi } from 'vitest'
import { AdresError, assertShopUrl, checkShopUrlShape, guardedFetch, isBlockedIp } from './adres'

const HOSTED = { APP_MODE: 'hosted' }
const SELF = { APP_MODE: 'self-host' }

describe('adres sklepu: zawsze', () => {
  it.each([
    'http://sklep.pl',
    'ftp://sklep.pl',
    'file:///etc/passwd',
    'https://user:haslo@sklep.pl',
    'https://user@sklep.pl',
    'https://sklep.pl:8443',
    'https://sklep.pl:80',
    'https://sklep.pl/#x',
    'javascript:alert(1)',
    'sklep.pl',
    '',
  ])('%s odrzucony', (u) => {
    expect(() => checkShopUrlShape(u, SELF)).toThrow(AdresError)
  })

  it('dobry adres: znormalizowany, port 443 dozwolony', () => {
    expect(checkShopUrlShape(' https://Sklep.pl/ ', SELF)).toBe('https://sklep.pl')
    expect(checkShopUrlShape('https://sklep.pl:443/wp-json/', SELF)).toBe('https://sklep.pl/wp-json')
  })

  it('self-host: sklep w sieci lokalnej dozwolony', () => {
    expect(checkShopUrlShape('https://192.168.1.10', SELF)).toBe('https://192.168.1.10')
  })
})

describe('adres sklepu: hosting', () => {
  it.each([
    'https://127.0.0.1',
    'https://0x7f.0.0.1',
    'https://0177.0.0.1',
    'https://2130706433',
    'https://127.1',
    'https://0.0.0.0',
    'https://10.1.2.3',
    'https://172.16.0.1',
    'https://172.31.255.255',
    'https://192.168.0.1',
    'https://100.64.0.1',
    'https://169.254.169.254',
    'https://[::1]',
    'https://[::]',
    'https://[::ffff:127.0.0.1]',
    'https://[::ffff:7f00:1]',
    'https://[::ffff:169.254.169.254]',
    'https://[64:ff9b::a00:1]',
    'https://[fe80::1]',
    'https://[fc00::1]',
    'https://[fd00:ec2::254]',
    'https://[ff02::1]',
    'https://localhost',
    'https://sklep.localhost',
    'https://metadata.google.internal',
    'https://sklep.local',
    'https://intranet',
  ])('%s odrzucony', (u) => {
    expect(() => checkShopUrlShape(u, HOSTED)).toThrow(AdresError)
  })

  it('adres publiczny przechodzi', () => {
    expect(checkShopUrlShape('https://sklep.example.com', HOSTED)).toBe('https://sklep.example.com')
    expect(checkShopUrlShape('https://8.8.8.8', HOSTED)).toBe('https://8.8.8.8')
    expect(checkShopUrlShape('https://[2a00:1450:4001::1]', HOSTED)).toBe('https://[2a00:1450:4001::1]')
  })

  it('DNS: domena wskazująca adres prywatny odrzucona przed żądaniem', async () => {
    await expect(assertShopUrl('https://zly.example.com', HOSTED, async () => ['93.184.216.34', '10.0.0.5'])).rejects.toThrow(/prywatną/)
    await expect(assertShopUrl('https://zly6.example.com', HOSTED, async () => ['::1'])).rejects.toThrow(/prywatną/)
    await expect(assertShopUrl('https://brak.example.com', HOSTED, async () => {
      throw new Error('ENOTFOUND')
    })).rejects.toThrow(/DNS/)
    await expect(assertShopUrl('https://dobry.example.com', HOSTED, async () => ['93.184.216.34'])).resolves.toBe('https://dobry.example.com')
  })

  it('guardedFetch: każde żądanie sprawdzone, bez przekierowań w hostingu', async () => {
    const seen: (RequestInit | undefined)[] = []
    const inner = async (_u: string, init?: RequestInit) => {
      seen.push(init)
      return new Response('{}')
    }
    const f = guardedFetch(HOSTED, inner, async (h) => (h === 'wewn.example.com' ? ['192.168.1.1'] : ['93.184.216.34']))
    await expect(f('https://wewn.example.com/wp-json/wc/v3/orders')).rejects.toBeInstanceOf(AdresError)
    await f('https://sklep.example.com/wp-json/wc/v3/orders', { method: 'GET' })
    expect(seen).toEqual([{ method: 'GET', redirect: 'manual' }])
  })

  it('isBlockedIp: nieczytelny adres = zablokowany', () => {
    expect(isBlockedIp('nie-ip')).toBe(true)
    expect(isBlockedIp('1.2.3.4')).toBe(false)
  })
})

describe('domyślny fetch adaptera konta', () => {
  it('hosting: adres z DNS w sieci prywatnej = odmowa bez żądania; publiczny = żądanie bez przekierowań; self-host bez zmian', async () => {
    const { defaultAccountFetch } = await import('../adaptery/konta')
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('[]', { status: 200 }))
    try {
      await expect(defaultAccountFetch(HOSTED, async () => ['10.0.0.5'])('https://sklep.example/wp-json/wc/v3/orders', {})).rejects.toBeInstanceOf(AdresError)
      await expect(defaultAccountFetch(HOSTED, async () => ['169.254.169.254'])('https://sklep.example/x', {})).rejects.toBeInstanceOf(AdresError)
      expect(spy).not.toHaveBeenCalled()
      await defaultAccountFetch(HOSTED, async () => ['93.184.216.34'])('https://sklep.example/x', { method: 'GET' })
      expect(spy).toHaveBeenCalledTimes(1)
      expect((spy.mock.calls[0]![1] as RequestInit).redirect).toBe('manual')
      await defaultAccountFetch(SELF, async () => ['10.0.0.5'])('https://sklep.lan.example/x', {})
      expect(spy).toHaveBeenCalledTimes(2)
      expect((spy.mock.calls[1]![1] as RequestInit).redirect).toBeUndefined()
    } finally {
      spy.mockRestore()
    }
  })
})

describe('komunikaty adresu', () => {
  it('każdy komunikat AdresError z adres.ts jest na liście; tekst kanału z „https://” albo „DNS” nie przechodzi', async () => {
    const { readFileSync } = await import('node:fs')
    const path = await import('node:path')
    const { ADRES_KOMUNIKATY } = await import('./adres')
    const { komunikatTekstu } = await import('./zadania')
    const src = readFileSync(path.join(__dirname, 'adres.ts'), 'utf8')
    const literal = [...src.matchAll(/new AdresError\('([^']*)'\)/g)].map((m) => m[1]!)
    expect(literal.length).toBeGreaterThan(5)
    for (const m of literal) expect(ADRES_KOMUNIKATY).toContain(m)
    expect(komunikatTekstu('Woo /orders: Adres sklepu wskazuje sieć prywatną albo adres zastrzeżony')).toBe('Adres sklepu wskazuje sieć prywatną albo adres zastrzeżony')
    const obcy = komunikatTekstu('odpowiedź kanału: zobacz https://phish.example/DNS?token=jan.kowalski@example.com')
    expect(obcy).not.toContain('phish')
    expect(obcy).not.toContain('kowalski')
  })
})
