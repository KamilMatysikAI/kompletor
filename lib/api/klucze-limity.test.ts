// blokada adresu IP po nieudanych próbach dotyczy tylko żądań bez ważnego klucza (bez bazy: fałszywy
// klient systemowy). Systemy klientów dzielą adresy (biuro, VPS), więc skrypt ze starym kluczem nie może odciąć
// pozostałych; kubełek „nieznany” (brak nagłówków proxy) nie jest blokowany wcale.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
vi.mock('server-only', () => ({}))
const { requireApiKey, resetApiLimiters, FAILED_PER_IP, FAILED_WINDOW_MS } = await import('./klucze')
import { tokenHash } from '@/lib/auth/sesje'
import { newApiKeyToken } from './zarzadzanie'

const good = newApiKeyToken()
const bad = newApiKeyToken() // poprawny format, ale nie ma go w „bazie”
const findUnique = vi.fn(async ({ where }: { where: { tokenHash: string } }) =>
  where.tokenHash === tokenHash(good)
    ? { id: 'k1', organizationId: 'org-1', scopes: ['stany:odczyt'], lastUsedAt: new Date(), revokedAt: null, organization: { active: true } }
    : null,
)
const sys = (() => ({ apiKey: { findUnique } })) as unknown as () => PrismaClient
const orgDb = (() => ({ apiKey: { updateMany: async () => ({ count: 1 }) } })) as unknown as (id: string) => PrismaClient

function call(token: string, ip: string | null, now: number) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  if (ip) headers['x-forwarded-for'] = ip
  return requireApiKey(new Request('http://x/api/v1/stany', { headers }), 'stany:odczyt', { sys, orgDb, now: () => now })
}
const status = async (p: ReturnType<typeof call>) => {
  const r = await p
  return r instanceof Response ? r.status : 200
}

beforeEach(() => resetApiLimiters())

describe('API v1: blokada IP po nieudanych próbach', () => {
  it(`po ${FAILED_PER_IP} złych próbach zły klucz = 429, dobry klucz z tego samego adresu dalej 200`, async () => {
    const now = Date.UTC(2026, 10, 3, 9)
    for (let i = 0; i < FAILED_PER_IP; i++) expect(await status(call(bad, '198.51.100.7', now))).toBe(401)
    const blocked = await call(bad, '198.51.100.7', now)
    expect((blocked as Response).status).toBe(429)
    expect(Number((blocked as Response).headers.get('retry-after'))).toBeGreaterThan(0)
    expect(await status(call(bad, '198.51.100.7', now + 1000))).toBe(429)
    expect(await status(call(good, '198.51.100.7', now + 1000))).toBe(200)
    // inny adres bez zmian, a po oknie zablokowany adres znów dostaje 401 (nie 429)
    expect(await status(call(bad, '203.0.113.9', now))).toBe(401)
    expect(await status(call(bad, '198.51.100.7', now + FAILED_WINDOW_MS + 1))).toBe(401)
  })

  it('kubełek „nieznany” (bez X-Forwarded-For) nie jest blokowany: zawsze 401, dobry klucz 200', async () => {
    const now = Date.UTC(2026, 10, 3, 9)
    for (let i = 0; i < FAILED_PER_IP * 3; i++) expect(await status(call(bad, null, now))).toBe(401)
    expect(await status(call(good, null, now))).toBe(200)
  })
})
