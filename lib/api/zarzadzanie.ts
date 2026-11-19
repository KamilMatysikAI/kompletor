// Klucze API firmy w panelu (Ustawienia → Klucze API): utworzenie, lista, odwołanie. Wyłącznie klient
// firmy (RLS): ekran widzi i zmienia tylko klucze własnej firmy. Pełny klucz wraca tylko z `createApiKey` — w bazie
// zostaje SHA-256 i prefiks. AuditLog bez wartości klucza (nazwa, prefiks, zakresy, konta klucza obsługi).
// Klucz obsługi klienta dostaje przy tworzeniu konta sprzedaży: co najmniej jedno istniejące konto firmy albo jawny,
// osobny wybór „wszystkie konta firmy” (lib/api/konta-klucza.ts). Klucz ogólny kont nie ma.
import { randomBytes } from 'node:crypto'
import { Channel, type PrismaClient } from '@prisma/client'
import { organizationIdOf } from '@/lib/db'
import { tokenHash } from '@/lib/auth/sesje'
import { uprawnieniaOsoby } from '@/lib/klienci/odczyt'
import { kontaKluczaDoBazy, kontaKluczaZBazy, kontoZPola, MAX_KONT_KLUCZA, type KontaKlucza } from './konta-klucza'
import { API_KEY_NAME_MAX, API_KEY_PREFIX, API_KEY_SHOWN, isApiScope, KOLEJNOSC_ZAKRESOW, OBSLUGA_SCOPE, type ApiScope } from './zakresy'

export class ApiKeyError extends Error {}

export interface ApiKeyRow {
  id: string
  name: string
  prefix: string
  scopes: ApiScope[]
  createdAt: Date
  lastUsedAt: Date | null
  revokedAt: Date | null
  /** konta klucza obsługi klienta; null = klucz ogólny */
  konta: KontaKlucza | null
}

export interface ApiKeyInput {
  name: unknown
  scopes: unknown[]
  /** wartości `<KANAŁ>:<id konta>` (formularz); tylko klucz obsługi klienta */
  konta?: unknown[]
  /** jawny wybór „wszystkie konta firmy”; tylko klucz obsługi klienta */
  wszystkieKonta?: unknown
}

export function newApiKeyToken(): string {
  return API_KEY_PREFIX + randomBytes(32).toString('base64url')
}

export function parseApiKeyInput(input: { name: unknown; scopes: unknown[] }): { name: string; scopes: ApiScope[] } {
  const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : ''
  if (!name) throw new ApiKeyError('Podaj nazwę klucza (np. „Chatbot sklepu”), żeby dało się go rozpoznać na liście.')
  if (name.length > API_KEY_NAME_MAX) throw new ApiKeyError(`Nazwa klucza może mieć najwyżej ${API_KEY_NAME_MAX} znaków.`)
  const scopes = [...new Set(input.scopes.filter((s): s is string => typeof s === 'string'))]
  if (scopes.some((s) => !isApiScope(s))) throw new ApiKeyError('Nieznany zakres klucza.')
  if (!scopes.length) throw new ApiKeyError('Zaznacz co najmniej jeden zakres.')
  if (scopes.includes(OBSLUGA_SCOPE) && scopes.length > 1)
    throw new ApiKeyError(`Klucz obsługi klienta (${OBSLUGA_SCOPE}) nie może mieć innych zakresów. Dla innych tras załóż osobny klucz.`)
  return { name, scopes: KOLEJNOSC_ZAKRESOW.filter((s) => scopes.includes(s)) }
}

/**
 * Konta klucza z formularza: dla klucza obsługi dokładnie jedno z dwojga (konkretne konta firmy albo „wszystkie”),
 * dla klucza ogólnego żadne. Konto musi istnieć w firmie (konfiguracja kont, klient firmy pod RLS).
 */
export async function kontaZFormularza(db: PrismaClient, scopes: ApiScope[], input: Pick<ApiKeyInput, 'konta' | 'wszystkieKonta'>): Promise<KontaKlucza | null> {
  const wartosci = [...new Set((input.konta ?? []).filter((v): v is string => typeof v === 'string' && v.length > 0))]
  const wszystkie = input.wszystkieKonta === true || input.wszystkieKonta === 'tak'
  if (!scopes.includes(OBSLUGA_SCOPE)) {
    if (wartosci.length || wszystkie) throw new ApiKeyError(`Konta sprzedaży wybiera się tylko dla klucza obsługi klienta (${OBSLUGA_SCOPE}).`)
    return null
  }
  if (wszystkie && wartosci.length) throw new ApiKeyError('Wybierz albo konkretne konta sprzedaży, albo „Wszystkie konta firmy”, nie oba naraz.')
  if (wszystkie) return { wszystkie: true }
  if (!wartosci.length) throw new ApiKeyError('Klucz obsługi klienta: zaznacz konta sprzedaży, których zamówienia ma widzieć (albo świadomie „Wszystkie konta firmy”).')
  if (wartosci.length > MAX_KONT_KLUCZA) throw new ApiKeyError(`Klucz może mieć najwyżej ${MAX_KONT_KLUCZA} kont.`)
  const kanaly: ReadonlySet<string> = new Set(Object.values(Channel))
  const pary = wartosci.map(kontoZPola)
  if (pary.some((x) => !x || !kanaly.has(x.kanal) || x.kanal === 'AI' || x.konto.length > 100)) throw new ApiKeyError('Nieznane konto sprzedaży.')
  const istniejace = await db.channelConfig.findMany({
    where: { channel: { not: 'AI' }, OR: pary.map((x) => ({ channel: x!.kanal as Channel, channelAccountId: x!.konto })) },
    select: { channel: true, channelAccountId: true },
  })
  const znane = new Set(istniejace.map((r) => `${r.channel}:${r.channelAccountId}`))
  if (pary.some((x) => !znane.has(`${x!.kanal}:${x!.konto}`))) throw new ApiKeyError('Nieznane konto sprzedaży.')
  return { wszystkie: false, konta: istniejace.map((r) => ({ kanal: r.channel, konto: r.channelAccountId })) }
}

/** Klucz obsługi klienta sprawdza zamówienia po e-mailu i telefonie, więc zakłada go tylko osoba z „Dane klienta”. */
async function assertMozeZalozyc(db: PrismaClient, scopes: ApiScope[], actorId: string): Promise<void> {
  if (!scopes.includes(OBSLUGA_SCOPE)) return
  const p = await uprawnieniaOsoby(db, actorId)
  if (!p.has('klienci.dane')) throw new ApiKeyError('Klucz obsługi klienta może założyć tylko osoba z uprawnieniem „Dane klienta” (Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia).')
}

/** Nowy klucz. Zwraca pełny klucz — jedyny raz, kiedy istnieje poza nagłówkiem żądania klienta. */
export async function createApiKey(db: PrismaClient, input: ApiKeyInput, actorId: string): Promise<{ id: string; token: string; prefix: string }> {
  organizationIdOf(db) // klient firmy (RLS); klient systemowy = błąd
  const { name, scopes } = parseApiKeyInput(input)
  await assertMozeZalozyc(db, scopes, actorId)
  const konta = await kontaZFormularza(db, scopes, input)
  const token = newApiKeyToken()
  const prefix = token.slice(0, API_KEY_SHOWN)
  return db.$transaction(async (tx) => {
    const k = await tx.apiKey.create({ data: { name, prefix, tokenHash: tokenHash(token), scopes, ...(konta ? { accounts: kontaKluczaDoBazy(konta) } : {}), createdBy: actorId }, select: { id: true } })
    await tx.auditLog.create({ data: { entity: 'ApiKey', entityId: k.id, actorId, after: { utworzony: true, nazwa: name, prefiks: prefix, zakresy: scopes, ...(konta ? { konta: kontaKluczaDoBazy(konta) } : {}) } } })
    return { id: k.id, token, prefix }
  })
}

export async function listApiKeys(db: PrismaClient): Promise<ApiKeyRow[]> {
  organizationIdOf(db) // klient firmy (RLS); klient systemowy = błąd
  const rows = await db.apiKey.findMany({
    select: { id: true, name: true, prefix: true, scopes: true, accounts: true, createdAt: true, lastUsedAt: true, revokedAt: true },
    orderBy: [{ revokedAt: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }],
  })
  return rows.map(({ accounts, ...r }) => ({ ...r, scopes: r.scopes.filter(isApiScope), konta: r.scopes.includes(OBSLUGA_SCOPE) ? kontaKluczaZBazy(accounts) : null }))
}

/** Odwołanie: od tej chwili 401. Powtórne odwołanie niczego nie zmienia. Klucz innej firmy = „nie znaleziono” (RLS). */
export async function revokeApiKey(db: PrismaClient, id: string, actorId: string, now = new Date()): Promise<boolean> {
  organizationIdOf(db) // klient firmy (RLS); klient systemowy = błąd
  return db.$transaction(async (tx) => {
    const k = await tx.apiKey.findUnique({ where: { id }, select: { id: true, name: true, prefix: true, revokedAt: true } })
    if (!k) throw new ApiKeyError('Nie znaleziono klucza.')
    if (k.revokedAt) return false
    await tx.apiKey.update({ where: { id }, data: { revokedAt: now } })
    await tx.auditLog.create({ data: { entity: 'ApiKey', entityId: id, actorId, before: { odwolany: false }, after: { odwolany: true, nazwa: k.name, prefiks: k.prefix } } })
    return true
  })
}

/** Stan formularza „Nowy klucz” (ekran Ustawienia → Klucze API). `token` tylko w odpowiedzi na utworzenie. */
export interface ApiKeyFormState {
  error: string | null
  created: { name: string; token: string; prefix: string } | null
}
