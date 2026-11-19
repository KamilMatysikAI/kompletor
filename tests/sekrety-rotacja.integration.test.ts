// rotacja klucza głównego sekretów. Wpis v1 czyta się kluczem v1, nowy zapis dostaje v2, przeszyfrowanie
// (funkcją i CLI dla wszystkich firm albo jednej) nie zostawia wpisów v1, a potem env bez v1 wystarcza. Wartości fikcyjne.
import { spawnSync } from 'node:child_process'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { encryptionKeysFromEnv, keyCoverage, listSecrets, reencryptSecrets, resolveSecrets, secretKeyVersionsInDb, setSecret } from '@/lib/sekrety'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { testAppDbUrl, testDbUrl } from './global-setup'
import { ACC, seedBase } from './rdzen-fixtures'

const a = testDb()
const b = testDb({ organizationId: ORG_B })
const sys = testSystemDb()
beforeEach(async () => {
  await truncateAll()
  await seedBase(a)
  await seedBase(b)
})
afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})

const V1 = '1'.repeat(64)
const V2 = '2'.repeat(64)
const ENV_V1 = { APP_ENCRYPTION_KEY: V1 }
const ENV_ROT = { APP_ENCRYPTION_KEYS: `2:${V2},1:${V1}`, APP_ENCRYPTION_KEY: V1 }
const ENV_V2 = { APP_ENCRYPTION_KEYS: `2:${V2}` }
const src = (env: Record<string, string>) => ({ env, envFallback: false })
const versions = async () =>
  (await sys.integrationSecret.findMany({ select: { organizationId: true, name: true, channelAccountId: true, keyVersion: true }, orderBy: [{ organizationId: 'asc' }, { name: 'asc' }, { channelAccountId: 'asc' }] })).map(
    (r) => `${r.organizationId}/${r.channelAccountId ?? '-'}/${r.name}:v${r.keyVersion}`,
  )
// CLI w osobnym procesie: node + loader tsx zamiast `npx` (na Windows `npx` to .cmd i bez powłoki = ENOENT).
// Zwraca kod wyjścia oraz stdout i stderr osobno — asercje „bez wartości” sprawdzają oba strumienie.
const cli = (...args: string[]) => {
  const { APP_ENCRYPTION_KEY: _, APP_ENCRYPTION_KEYS: __, ...rest } = process.env
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/sekret.ts', ...args], {
    // klient firmy bierze APP_DATABASE_URL — bez tego dziecko dziedziczy z .env bazę dev zamiast testowej.
    env: { ...rest, ...ENV_ROT, DATABASE_URL: testDbUrl(), APP_DATABASE_URL: testAppDbUrl() },
    encoding: 'utf8',
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

describe('rotacja klucza głównego sekretów', () => {
  it('wpis v1 czyta się kluczem v1 przy dwóch kluczach; nowy zapis dostaje v2; bez v1 w env wpis v1 = błąd', async () => {
    await setSecret(a, 'BASELINKER_TOKEN', 'fikcyjny-token-v1', ENV_V1)
    expect((await listSecrets(a)).map((s) => s.keyVersion)).toEqual([1])
    expect(await resolveSecrets(a, ['BASELINKER_TOKEN'], src(ENV_ROT))).toEqual({ BASELINKER_TOKEN: 'fikcyjny-token-v1' })
    await setSecret(a, 'WFIRMA_APP_KEY', 'fikcyjny-klucz-v2', ENV_ROT)
    expect(await versions()).toEqual([`${ORG_A}/-/BASELINKER_TOKEN:v1`, `${ORG_A}/-/WFIRMA_APP_KEY:v2`])
    expect(await resolveSecrets(a, ['WFIRMA_APP_KEY'], src(ENV_V2))).toEqual({ WFIRMA_APP_KEY: 'fikcyjny-klucz-v2' })
    await expect(resolveSecrets(a, ['BASELINKER_TOKEN'], src(ENV_V2))).rejects.toThrow(/kluczem v1, którego nie ma/)
  })

  it('przeszyfrowanie firmy: wszystkie wpisy (firmowe i kont) na v2, wartości te same; druga firma nietknięta; ponownie = 0', async () => {
    await setSecret(a, 'BASELINKER_TOKEN', 'fikcyjny-token-a', ENV_V1)
    await setSecret(a, 'WOO_CONSUMER_KEY', 'fikcyjny-klucz-sd', ENV_V1, ACC.WOO_SD)
    await setSecret(b, 'BASELINKER_TOKEN', 'fikcyjny-token-b', ENV_V1)
    const before = await sys.integrationSecret.findFirstOrThrow({ where: { organizationId: ORG_A, channelAccountId: null } })
    expect(await reencryptSecrets(a, ENV_ROT)).toEqual({ keyVersion: 2, reencrypted: 2, skipped: 0, remaining: 0 })
    expect(await versions()).toEqual([`${ORG_A}/-/BASELINKER_TOKEN:v2`, `${ORG_A}/sd/WOO_CONSUMER_KEY:v2`, `${ORG_B}/-/BASELINKER_TOKEN:v1`])
    const after = await sys.integrationSecret.findFirstOrThrow({ where: { id: before.id } })
    expect(Buffer.from(after.ciphertext).equals(Buffer.from(before.ciphertext))).toBe(false)
    expect(await resolveSecrets(a, ['BASELINKER_TOKEN'], src(ENV_V2))).toEqual({ BASELINKER_TOKEN: 'fikcyjny-token-a' })
    expect(await resolveSecrets(a, ['WOO_CONSUMER_KEY'], src(ENV_V2), ACC.WOO_SD)).toEqual({ WOO_CONSUMER_KEY: 'fikcyjny-klucz-sd' })
    expect(await reencryptSecrets(a, ENV_ROT)).toEqual({ keyVersion: 2, reencrypted: 0, skipped: 0, remaining: 0 })
  })

  it('jeden nieczytelny wpis = błąd i nic nie zapisane (bez wartości w błędzie)', async () => {
    await setSecret(a, 'BASELINKER_TOKEN', 'fikcyjny-token-a', ENV_V1)
    await setSecret(a, 'WFIRMA_APP_KEY', 'fikcyjny-klucz-a', { APP_ENCRYPTION_KEY: '3'.repeat(64) }) // inny klucz udający v1
    const err = await reencryptSecrets(a, ENV_ROT).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/Nie da się odszyfrować sekretu WFIRMA_APP_KEY/)
    expect((err as Error).message).not.toContain('fikcyjny')
    expect(await versions()).toEqual([`${ORG_A}/-/BASELINKER_TOKEN:v1`, `${ORG_A}/-/WFIRMA_APP_KEY:v1`])
  })

  it('CLI --wszystkie-firmy --przeszyfruj: każda firma po kolei, potem żadnego wpisu v1 i odczyt bez klucza v1', async () => {
    await setSecret(a, 'BASELINKER_TOKEN', 'fikcyjny-token-a', ENV_V1)
    await setSecret(b, 'BASELINKER_TOKEN', 'fikcyjny-token-b', ENV_V1)
    await setSecret(b, 'WOO_CONSUMER_KEY', 'fikcyjny-klucz-lampy', ENV_ROT, ACC.WOO_LAMPY) // już v2
    const r = cli('--wszystkie-firmy', '--przeszyfruj')
    expect(r.code).toBe(0)
    expect(r.out).toContain('test-a: przeszyfrowane 1 kluczem v2')
    expect(r.out).toContain('test-b: przeszyfrowane 1 kluczem v2')
    expect(r.out).toContain('stare wersje można usunąć z env')
    expect(r.out + r.err).not.toContain('fikcyjny')
    expect(await sys.integrationSecret.count({ where: { keyVersion: 1 } })).toBe(0)
    // klient systemowy widzi wersje wpisów wszystkich firm; sam stary klucz v1 w env ich nie pokrywa
    expect(await secretKeyVersionsInDb(sys)).toEqual([2])
    expect(keyCoverage(encryptionKeysFromEnv(ENV_V1), await secretKeyVersionsInDb(sys)).status).toBe('error')
    expect(keyCoverage(encryptionKeysFromEnv(ENV_V2), await secretKeyVersionsInDb(sys)).status).toBe('ok')
    expect(await resolveSecrets(a, ['BASELINKER_TOKEN'], src(ENV_V2))).toEqual({ BASELINKER_TOKEN: 'fikcyjny-token-a' })
    expect(await resolveSecrets(b, ['BASELINKER_TOKEN'], src(ENV_V2))).toEqual({ BASELINKER_TOKEN: 'fikcyjny-token-b' })
    expect(await resolveSecrets(b, ['WOO_CONSUMER_KEY'], src(ENV_V2), ACC.WOO_LAMPY)).toEqual({ WOO_CONSUMER_KEY: 'fikcyjny-klucz-lampy' })
  })

  it('CLI --firma test-a --przeszyfruj: tylko ta firma, druga zostaje na v1, bez „można usunąć z env”', async () => {
    await setSecret(a, 'BASELINKER_TOKEN', 'fikcyjny-token-a', ENV_V1)
    await setSecret(b, 'BASELINKER_TOKEN', 'fikcyjny-token-b', ENV_V1)
    const r = cli('--firma', 'test-a', '--przeszyfruj')
    expect(r.code).toBe(0)
    expect(r.out).toContain('test-a: przeszyfrowane 1 kluczem v2')
    expect(r.out).toContain('przed usunięciem starego klucza z env')
    expect(r.out).not.toContain('stare wersje można usunąć z env')
    expect(r.out + r.err).not.toContain('fikcyjny')
    expect(await versions()).toEqual([`${ORG_A}/-/BASELINKER_TOKEN:v2`, `${ORG_B}/-/BASELINKER_TOKEN:v1`])
  })

  it('CLI: firma z nieczytelnym wpisem = kod 1 i „NIE usuwaj”, bez wartości na stdout i stderr; --przeszyfruj z --lista = odmowa', async () => {
    await setSecret(a, 'BASELINKER_TOKEN', 'fikcyjny-token-a', { APP_ENCRYPTION_KEY: '3'.repeat(64) }) // inny klucz udający v1
    await setSecret(b, 'BASELINKER_TOKEN', 'fikcyjny-token-b', ENV_V1)
    const r = cli('--wszystkie-firmy', '--przeszyfruj')
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/test-a: błąd, nic nie zapisane/)
    expect(r.err).toMatch(/NIE usuwaj starego klucza/)
    expect(r.out).toContain('test-b: przeszyfrowane 1 kluczem v2')
    expect(r.out + r.err).not.toContain('fikcyjny')
    expect(r.out + r.err).not.toContain('1'.repeat(16))
    const mixed = cli('--firma', 'test-a', '--przeszyfruj', '--lista')
    expect(mixed.code).toBe(1)
    expect(mixed.err).toMatch(/--przeszyfruj osobno/)
  })

  it('wyścig: setSecret między odczytem a zapisem przeszyfrowania wygrywa (pominięty, remaining > 0), drugi przebieg kończy', async () => {
    await setSecret(a, 'BASELINKER_TOKEN', 'fikcyjny-token-a', ENV_V1)
    await setSecret(a, 'WFIRMA_APP_KEY', 'fikcyjny-klucz-a', ENV_V1)
    const first = await reencryptSecrets(a, ENV_ROT, {
      // proces jeszcze bez nowego env zapisuje nową wartość starym kluczem (v1) w trakcie przeszyfrowania
      // (5 ms przerwy: updatedAt ma precyzję ms, ten sam ms dałby fałszywe dopasowanie zapisu warunkowego)
      beforeWrite: async () => {
        await new Promise((r) => setTimeout(r, 5))
        await setSecret(a, 'WFIRMA_APP_KEY', 'fikcyjny-klucz-nowszy', ENV_V1)
      },
    })
    expect(first).toEqual({ keyVersion: 2, reencrypted: 1, skipped: 1, remaining: 1 })
    expect(await resolveSecrets(a, ['WFIRMA_APP_KEY'], src(ENV_ROT))).toEqual({ WFIRMA_APP_KEY: 'fikcyjny-klucz-nowszy' })
    expect(await reencryptSecrets(a, ENV_ROT)).toEqual({ keyVersion: 2, reencrypted: 1, skipped: 0, remaining: 0 })
    expect(await resolveSecrets(a, ['BASELINKER_TOKEN', 'WFIRMA_APP_KEY'], src(ENV_V2))).toEqual({
      BASELINKER_TOKEN: 'fikcyjny-token-a',
      WFIRMA_APP_KEY: 'fikcyjny-klucz-nowszy',
    })
  })

  it('wiersz skasowany przez drugiego klienta między odczytem a zapisem = jeden wiersz z nową wartością', async () => {
    await setSecret(a, 'WOO_CONSUMER_KEY', 'fikcyjny-klucz-stary', ENV_V1, ACC.WOO_SD)
    const drugi = testDb()
    try {
      await setSecret(a, 'WOO_CONSUMER_KEY', 'fikcyjny-klucz-nowy', ENV_V1, ACC.WOO_SD, {
        // findFirst widział wiersz; drugi klient (osobne połączenie) kasuje go przed updateMany
        poOdczycie: async () => {
          expect((await drugi.integrationSecret.deleteMany({ where: { name: 'WOO_CONSUMER_KEY', channelAccountId: ACC.WOO_SD.channelAccountId } })).count).toBe(1)
        },
      })
    } finally {
      await drugi.$disconnect()
    }
    const rows = await sys.integrationSecret.findMany({ where: { organizationId: ORG_A, name: 'WOO_CONSUMER_KEY' } })
    expect(rows).toHaveLength(1)
    expect(await resolveSecrets(a, ['WOO_CONSUMER_KEY'], src(ENV_V1), ACC.WOO_SD)).toEqual({ WOO_CONSUMER_KEY: 'fikcyjny-klucz-nowy' })
  })
})
