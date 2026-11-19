import { describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { NonRetryableError } from '../bledy'
import { ZADANIA_CIENIA } from './harmonogram'
import { handlers } from './zadania'

// CIEN_ODCZYT=0 egzekwuje handler, nie tylko harmonogram — zadanie cienia z kolejki (zaplanowane przed
// wyłączeniem, ręczne enqueue) kończy się bez dotykania bazy. Baza-pułapka: każdy dostęp = wyjątek.
const trap = new Proxy({}, { get: (_t, prop) => { throw new Error(`dostęp do bazy: ${String(prop)}`) } }) as unknown as PrismaClient
const ctx = (env: Record<string, string | undefined>) => ({ organizationId: 'org-test', secrets: { env, envFallback: false } })
const payload = { channel: 'woo', channelAccountId: 'sd' }

describe('handlery cienia przy CIEN_ODCZYT=0', () => {
  it.each(ZADANIA_CIENIA.map((k) => [k]))('%s: bez odczytu, bez bazy', async (kind) => {
    expect(handlers[kind]).toBeDefined()
    await expect(handlers[kind]!(trap, payload, ctx({ CIEN_ODCZYT: '0' }))).resolves.toBeUndefined()
  })
  it.each(ZADANIA_CIENIA.map((k) => [k]))('%s: włączony = sięga do bazy (pułapka)', async (kind) => {
    await expect(handlers[kind]!(trap, payload, ctx({ CIEN_ODCZYT: '1' }))).rejects.toThrow(/dostęp do bazy|klienta firmy/) // sięga do bazy (strażnik klienta firmy albo pułapka)
  })
  it.each(ZADANIA_CIENIA.map((k) => [k]))('%s: zła wartość = NonRetryableError', async (kind) => {
    await expect(handlers[kind]!(trap, payload, ctx({ CIEN_ODCZYT: 'tak' }))).rejects.toBeInstanceOf(NonRetryableError)
  })
})
