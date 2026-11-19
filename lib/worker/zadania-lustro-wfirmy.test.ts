import { describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { NonRetryableError } from '../bledy'
import { LUSTRO_WFIRMY_JOB } from './harmonogram'
import { handlers } from './zadania'

// wyłącznik lustra stanów wFirmy egzekwuje handler, nie tylko harmonogram. Baza-pułapka: każdy dostęp =
// wyjątek, więc „bez bazy” znaczy też „bez kluczy i bez wywołań wFirmy”.
const trap = new Proxy({}, { get: (_t, prop) => { throw new Error(`dostęp do bazy: ${String(prop)}`) } }) as unknown as PrismaClient
const ctx = (env: Record<string, string | undefined>) => ({ organizationId: 'org-test', secrets: { env, envFallback: false } })

describe(`handler ${LUSTRO_WFIRMY_JOB} — wyłącznik CIEN_LUSTRO_WFIRMY`, () => {
  it('0 = koniec bez bazy i bez wFirmy (także przy CIEN_ODCZYT=1)', async () => {
    await expect(handlers[LUSTRO_WFIRMY_JOB]!(trap, null, ctx({ CIEN_LUSTRO_WFIRMY: '0' }))).resolves.toBeUndefined()
    await expect(handlers[LUSTRO_WFIRMY_JOB]!(trap, null, ctx({ CIEN_LUSTRO_WFIRMY: '0', CIEN_ODCZYT: '1' }))).resolves.toBeUndefined()
  })
  it('puste + CIEN_ODCZYT=0 = koniec bez bazy', async () => {
    await expect(handlers[LUSTRO_WFIRMY_JOB]!(trap, null, ctx({ CIEN_ODCZYT: '0' }))).resolves.toBeUndefined()
    await expect(handlers[LUSTRO_WFIRMY_JOB]!(trap, null, ctx({ CIEN_ODCZYT: '0', CIEN_LUSTRO_WFIRMY: '' }))).resolves.toBeUndefined()
  })
  it('włączone (1, albo puste przy włączonym cieniu) = sięga do bazy po klucze', async () => {
    for (const env of [{ CIEN_LUSTRO_WFIRMY: '1', CIEN_ODCZYT: '0' }, {}])
      await expect(handlers[LUSTRO_WFIRMY_JOB]!(trap, null, ctx(env))).rejects.toThrow(/dostęp do bazy|klienta firmy/)
  })
  it('zła wartość = NonRetryableError', async () => {
    await expect(handlers[LUSTRO_WFIRMY_JOB]!(trap, null, ctx({ CIEN_LUSTRO_WFIRMY: 'tak' }))).rejects.toBeInstanceOf(NonRetryableError)
    await expect(handlers[LUSTRO_WFIRMY_JOB]!(trap, null, ctx({ CIEN_ODCZYT: 'nie' }))).rejects.toBeInstanceOf(NonRetryableError)
  })
})
