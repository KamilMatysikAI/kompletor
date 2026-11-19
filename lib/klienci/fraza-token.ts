// fraza wyszukiwania klienta fragmentem (nazwisko, firma) w adresie listy zamówień — zaszyfrowana. Adres
// strony trafia do historii przeglądarki i logów serwera, więc nie może nieść nazwiska; token to AES-256-GCM kluczem
// danych klientów (CUSTOMER_DATA_KEYS), AAD wiąże go z firmą i osobą, a termin ważności (2 h) z chwilą wyszukania.
// Inna osoba, inna firma albo przeterminowany token = brak frazy (lista bez filtra klienta).
// w ładunku opcjonalna flaga `k` = osoba zaznaczyła „także w danych klientów (nazwisko,
// firma)”; tylko wtedy lista szuka fragmentem (odszyfrowanie ostatnich rekordów). Token bez flagi = bez fragmentu.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { Env } from '../sekrety'
import { kluczeKlientowZEnv } from './szyfr'

export const WAZNOSC_MS = 2 * 60 * 60_000

const b64 = (b: Buffer) => b.toString('base64url')
const aad = (organizationId: string, userId: string) => Buffer.from(`${organizationId}:fraza:${userId}`, 'utf8')

export function zapieczetujFraze(env: Env, organizationId: string, userId: string, fraza: string, now = new Date(), opcje: { klienci?: boolean } = {}): string {
  const ring = kluczeKlientowZEnv(env)
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', ring.keys.get(ring.current)!, iv)
  c.setAAD(aad(organizationId, userId))
  const ct = Buffer.concat([c.update(JSON.stringify({ f: fraza.slice(0, 120), e: now.getTime() + WAZNOSC_MS, ...(opcje.klienci ? { k: 1 } : {}) }), 'utf8'), c.final()])
  return `${ring.current}.${b64(iv)}.${b64(c.getAuthTag())}.${b64(ct)}`
}

/** Fraza z tokenu albo null (zły, cudzy, przeterminowany, brak klucza). */
export function otworzFraze(env: Env, organizationId: string, userId: string, token: string, now = new Date()): string | null {
  return otworzTokenFrazy(env, organizationId, userId, token, now)?.fraza ?? null
}

/** Fraza i flaga „także w danych klientów” z tokenu albo null (zły, cudzy, przeterminowany, brak klucza). */
export function otworzTokenFrazy(env: Env, organizationId: string, userId: string, token: string, now = new Date()): { fraza: string; klienci: boolean } | null {
  try {
    const m = /^(\d{1,4})\.([\w-]{16})\.([\w-]{22})\.([\w-]{1,700})$/.exec(token)
    if (!m) return null
    const key = kluczeKlientowZEnv(env).keys.get(Number(m[1]))
    if (!key) return null
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(m[2]!, 'base64url'))
    d.setAAD(aad(organizationId, userId))
    d.setAuthTag(Buffer.from(m[3]!, 'base64url'))
    const v = JSON.parse(Buffer.concat([d.update(Buffer.from(m[4]!, 'base64url')), d.final()]).toString('utf8')) as { f?: unknown; e?: unknown; k?: unknown }
    if (typeof v.f !== 'string' || typeof v.e !== 'number' || v.e < now.getTime()) return null
    return { fraza: v.f, klienci: v.k === 1 }
  } catch {
    return null
  }
}
