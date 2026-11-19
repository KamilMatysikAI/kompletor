// `npm run konto` na fałszywym rejestrze i atrapie bazy: walidacja kanału, adaptera i ustawień,
// odmowa dla istniejącego konta, test połączenia bez sekretów w wyniku. Shoper na atrapie HTTP. Zapis do prawdziwej
// bazy z RLS: tests/kanal-shoper.integration.test.ts.
import type { PrismaClient } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import { FakeChannelState, fakeDefinition } from '@/lib/adaptery/falszywy'
import { channelIntegration, type ChannelAccountSettings } from '@/lib/adaptery/konta'
import { AdapterRegistry } from '@/lib/adaptery/rejestr'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { ShoperAtrapa } from '@/tests/shoper-atrapa'
import { dodajKonto, type KontaDb, parseAccountRef, parseArgs, testKonta } from './konto-kanalu'

function fakeDb(existing: { channel: string; channelAccountId: string; name: string }[] = []) {
  const created: Record<string, unknown>[] = []
  const db = {
    channelConfig: {
      findFirst: async ({ where }: { where: { channel: string; channelAccountId: string } }) => existing.find((e) => e.channel === where.channel && e.channelAccountId === where.channelAccountId) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data)
        return data
      },
    },
  } as unknown as KontaDb
  return { db, created }
}

const registry = () => new AdapterRegistry([fakeDefinition(new FakeChannelState(), 'SHOPER', 'fake.shoper.v1'), fakeDefinition(new FakeChannelState(), 'WOO', 'fake.woo.v1')])
const base = { kanal: 'SHOPER', konto: 'sklep1', nazwa: 'Sklep na Shoperze', adapter: 'fake.shoper.v1', config: {} }

describe('npm run konto — argumenty', () => {
  it('polecenie, opcje, powtarzalne --config klucz=wartość (wartość może mieć „=”)', () => {
    expect(parseArgs(['dodaj', '--firma', 'demo', '--config', 'baseUrl=https://a.example.invalid/?x=1', '--config', 'pageSize=20'])).toEqual({
      cmd: 'dodaj',
      opts: { firma: 'demo' },
      config: { baseUrl: 'https://a.example.invalid/?x=1', pageSize: '20' },
    })
    expect(() => parseArgs(['dodaj', '--firma'])).toThrow(/Brak wartości/)
    expect(() => parseArgs(['dodaj', '--config', 'bez-rownasie'])).toThrow(/klucz=wartość/)
    expect(parseAccountRef('SHOPER/sklep1')).toEqual({ channel: 'SHOPER', channelAccountId: 'sklep1' })
    expect(parseAccountRef('PRESTASHOP/p1').channel).toBe('PRESTASHOP')
    expect(() => parseAccountRef('NIEMA/x')).toThrow(/Nieznany kanał/)
    expect(() => parseAccountRef('SHOPER')).toThrow(/KANAŁ\/konto/)
  })
})

describe('npm run konto -- dodaj', () => {
  it('dodaje aktywne konto z adapterem z rejestru i wypisuje polecenia sekretów', async () => {
    const { db, created } = fakeDb()
    const r = defaultRegistry()
    const lines = await dodajKonto(db, r, { ...base, adapter: 'shoper.rest.v1', config: { baseUrl: 'https://sklep.example.invalid', pageSize: '20' } }, 'demo')
    expect(created).toEqual([{ channel: 'SHOPER', channelAccountId: 'sklep1', name: 'Sklep na Shoperze', adapterKey: 'shoper.rest.v1', config: { baseUrl: 'https://sklep.example.invalid', pageSize: 20 }, active: true }])
    expect(lines.join('\n')).toContain('npm run sekret -- --firma demo --ustaw SHOPER_ACCESS_TOKEN --z-env SHOPER_ACCESS_TOKEN --konto SHOPER/sklep1')
    expect(lines.at(-1)).toBe('[konto] potem: npm run konto -- test --firma demo --konto SHOPER/sklep1')
  })

  it('odmowy: istniejące konto, nieznany kanał i adapter, adapter innego kanału, złe ustawienia, zły identyfikator', async () => {
    const { db, created } = fakeDb([{ channel: 'SHOPER', channelAccountId: 'sklep1', name: 'Stary' }])
    const r = registry()
    await expect(dodajKonto(db, r, base, 'demo')).rejects.toThrow(/już istnieje/)
    await expect(dodajKonto(db, r, { ...base, kanal: 'XYZ' }, 'demo')).rejects.toThrow(/Nieznany kanał/)
    await expect(dodajKonto(db, r, { ...base, konto: 'nowe', adapter: 'nie.ma.v1' }, 'demo')).rejects.toThrow(/Nieznany adapter/)
    await expect(dodajKonto(db, r, { ...base, konto: 'nowe', adapter: 'fake.woo.v1' }, 'demo')).rejects.toThrow(/nie jest adapterem kanału SHOPER/)
    await expect(dodajKonto(db, r, { ...base, konto: 'nowe', config: { cos: '1' } }, 'demo')).rejects.toThrow(/nie zna ustawień: cos/)
    await expect(dodajKonto(db, r, { ...base, konto: 'a/b' }, 'demo')).rejects.toThrow(/--konto/)
    await expect(dodajKonto(db, r, { ...base, konto: 'nowe', nazwa: '  ' }, 'demo')).rejects.toThrow(/--nazwa/)
    const d = defaultRegistry()
    await expect(dodajKonto(db, d, { ...base, konto: 'nowe', adapter: 'shoper.rest.v1', config: { baseUrl: 'http://sklep.example.invalid' } }, 'demo')).rejects.toThrow(/baseUrl ma zły format/)
    await expect(dodajKonto(db, d, { ...base, konto: 'nowe', adapter: 'shoper.rest.v1', config: {} }, 'demo')).rejects.toThrow(/brak ustawienia baseUrl/)
    await expect(dodajKonto(db, d, { ...base, konto: 'nowe', adapter: 'shoper.rest.v1', config: { baseUrl: 'https://s.example.invalid', pageSize: 'dużo' } }, 'demo')).rejects.toThrow(/pageSize nie jest liczbą/)
    expect(created).toEqual([])
  })
})

describe('npm run konto -- test', () => {
  const acc = (over: Partial<ChannelAccountSettings> = {}): ChannelAccountSettings => ({
    organizationId: 'test_a',
    channel: 'SHOPER',
    channelAccountId: 'sklep1',
    name: 'Sklep na Shoperze',
    adapterKey: 'shoper.rest.v1',
    config: { baseUrl: 'https://sklep-shoper.example.invalid' },
    active: true,
    ...over,
  })
  const db = {} as PrismaClient
  const src = { env: {}, envFallback: false }

  it('Shoper na atrapie: OK z liczbami, bez tokena w wyniku', async () => {
    const at = new ShoperAtrapa({ token: 'tok-tajny-123' })
    const r = defaultRegistry()
    const out = await testKonta(db, r, src, 'SHOPER/sklep1', {
      loadAccounts: async () => [acc()],
      createAdapter: async (a) => r.create(a.adapterKey, { integration: channelIntegration(a), rawConfig: a.config, rawSecrets: { SHOPER_ACCESS_TOKEN: 'tok-tajny-123' }, fetch: at.fetch, http: { minIntervalMs: 0, retry: { attempts: 1, baseDelayMs: 0 } } }),
    })
    expect(out.code).toBe(0)
    expect(out.lines[0]).toBe('[konto] Sklep na Shoperze (SHOPER/sklep1, shoper.rest.v1): OK — odczyt zamówień i statusów działa {"orders":0,"statuses":5}')
    expect(out.lines.join(' ')).not.toContain('tok-tajny')
  })

  it('brak konta, brak sekretu (bez wartości), błąd połączenia, konto nieaktywne', async () => {
    const r = defaultRegistry()
    expect((await testKonta(db, r, src, 'SHOPER/inne', { loadAccounts: async () => [acc()] })).lines[0]).toContain('nie ma konta SHOPER/inne')
    const brak = await testKonta(db, r, src, 'SHOPER/sklep1', {
      loadAccounts: async () => [acc()],
      createAdapter: async (a) => r.create(a.adapterKey, { integration: channelIntegration(a), rawConfig: a.config, rawSecrets: {}, fetch }),
    })
    expect(brak.code).toBe(1)
    expect(brak.lines[0]).toContain('nie da się utworzyć adaptera — Konto SHOPER/sklep1: brak sekretu SHOPER_ACCESS_TOKEN')
    const at = new ShoperAtrapa({ token: 'inny' })
    const zle = await testKonta(db, r, src, 'SHOPER/sklep1', {
      loadAccounts: async () => [acc({ active: false })],
      createAdapter: async (a) => r.create(a.adapterKey, { integration: channelIntegration(a), rawConfig: a.config, rawSecrets: { SHOPER_ACCESS_TOKEN: 'zly-token' }, fetch: at.fetch, http: { minIntervalMs: 0, retry: { attempts: 1, baseDelayMs: 0 } } }),
    })
    expect(zle.code).toBe(1)
    expect(zle.lines).toEqual(['[konto] Sklep na Shoperze (SHOPER/sklep1, shoper.rest.v1): BŁĄD — token albo login i hasło odrzucone przez sklep', '[konto] uwaga: konto nieaktywne — odczyt zamówień go pomija'])
    expect(zle.lines.join(' ')).not.toContain('zly-token')
  })
})
