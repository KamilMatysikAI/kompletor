// Sekrety integracji per firma: klucze API szyfrowane AES-256-GCM w tabeli IntegrationSecret.
// Klucz główny: env APP_ENCRYPTION_KEY (32 bajty, base64 albo hex) — nigdy w bazie ani w repo. AAD = „<firma>:<odnośnik>”
// (odnośnik = nazwa albo „<kanał>/<konto>/<nazwa>”), więc szyfrogramu nie da się przenieść do innej firmy, innego konta
// ani pod inną nazwę. Sekret jest firmy (BL, wFirma) albo konta kanału (dwa sklepy Woo / dwa konta Allegro z osobnymi
// kluczami — porównanie z OpenLinkerem 25.10). Self-host jednofirmowy może zostać przy
// kluczach w env (fallback, lib/organizacje.ts envSecretsAllowed). Wartości nie trafiają do logów, błędów ani
// odpowiedzi API: na zewnątrz wychodzą tylko nazwy i daty (`listSecrets`).
// Rotacja: APP_ENCRYPTION_KEYS=„2:<klucz>,1:<klucz>” (najnowsza pierwsza). Zapis zawsze najnowszą wersją
// (IntegrationSecret.keyVersion), odczyt kluczem wersji wpisu; `reencryptSecrets` przepisuje starsze wpisy firmy
// najnowszym kluczem, po czym starą wersję usuwa się z env. Sam APP_ENCRYPTION_KEY = wersja 1 (zgodność wstecz).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { Channel, PrismaClient } from '@prisma/client'
import { NonRetryableError } from './bledy'
import { organizationIdOf } from './db'
import { appModeOf } from './organizacje'

export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/
/** Wersja klucza samego APP_ENCRYPTION_KEY (sprzed rotacji; tak zapisane są wszystkie dawne wpisy). */
export const LEGACY_KEY_VERSION = 1

export type Env = Record<string, string | undefined>

/** Błąd sekretu (brak klucza głównego, zły wpis): ponowienie nic nie zmieni. */
export class SecretError extends NonRetryableError {}

/** Klucze główne po wersjach; `current` = najnowsza, nią szyfrujemy. */
export interface KeyRing {
  current: number
  keys: ReadonlyMap<number, Buffer>
}

function parseKey(raw: string, what: string): Buffer {
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  if (key.length !== 32) throw new SecretError(`${what} musi mieć dokładnie 32 bajty (AES-256)`)
  return key
}

/**
 * Pierścień kluczy z listy „<wersja>:<klucz>,…” (najnowsza pierwsza) w zmiennej `listVar` (wspólny parser
 * dla sekretów integracji i osobnego pierścienia danych klientów). `legacyVar` = zmienna z pojedynczym kluczem v1
 * (tylko APP_ENCRYPTION_KEY); `brak` = komunikat, gdy nie ma żadnej. Komunikaty bez materiału klucza.
 */
export function keyRingFromEnv(env: Env, o: { listVar: string; legacyVar?: string; brak: string; Blad?: new (m: string) => Error }): KeyRing {
  const Blad = o.Blad ?? SecretError
  const fail = (m: string): never => {
    throw new Blad(m)
  }
  const key = (raw: string, what: string): Buffer => {
    try {
      return parseKey(raw, what)
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e))
    }
  }
  const single = o.legacyVar ? env[o.legacyVar]?.trim() : undefined
  const list = env[o.listVar]?.trim()
  if (!single && !list) fail(o.brak)
  if (!list) return { current: LEGACY_KEY_VERSION, keys: new Map([[LEGACY_KEY_VERSION, key(single!, o.legacyVar!)]]) }
  const keys = new Map<number, Buffer>()
  let prev = Infinity
  for (const part of list.split(',')) {
    const m = /^\s*([1-9][0-9]{0,8})\s*:\s*(\S+)\s*$/.exec(part)
    if (!m) fail(`${o.listVar} w formacie „<wersja>:<klucz>,…”, np. 2:<hex>,1:<hex> (wersje od 1)`)
    const v = Number(m![1])
    if (v >= prev) fail(`${o.listVar}: wersje malejąco, bez powtórzeń (najnowsza pierwsza)`)
    prev = v
    keys.set(v, key(m![2]!, `${o.listVar}: klucz v${v}`))
  }
  if (single) {
    const legacy = keys.get(LEGACY_KEY_VERSION)
    if (!legacy) fail(`${o.legacyVar} to klucz v1, a v1 nie ma już w ${o.listVar} — usuń ${o.legacyVar} z env`)
    if (!legacy!.equals(key(single, o.legacyVar!))) fail(`${o.legacyVar} różni się od klucza v1 w ${o.listVar}`)
  }
  return { current: keys.keys().next().value!, keys }
}

/**
 * Klucze główne z env: APP_ENCRYPTION_KEYS („<wersja>:<klucz>”, po przecinku, najnowsza pierwsza) i/lub
 * APP_ENCRYPTION_KEY (= wersja 1). Oba naraz tylko zgodne: ten sam klucz v1. Po przeszyfrowaniu i usunięciu v1
 * z APP_ENCRYPTION_KEYS stary APP_ENCRYPTION_KEY też musi zniknąć — inaczej błąd, żeby nie został w env przez pomyłkę.
 */
export function encryptionKeysFromEnv(env: Env): KeyRing {
  return keyRingFromEnv(env, {
    listVar: 'APP_ENCRYPTION_KEYS',
    legacyVar: 'APP_ENCRYPTION_KEY',
    brak: 'Brak APP_ENCRYPTION_KEY albo APP_ENCRYPTION_KEYS (32 bajty base64 albo 64 znaki hex) — sekrety firm są niedostępne',
  })
}

export type EncryptionKeysStatus = 'ok' | 'none' | 'error'

/**
 * Stan kluczy głównych dla startu workera i `/api/health`: zły zestaw po redeployu ma być
 * widoczny od razu, nie dopiero w `Job.lastError` każdej firmy. `none` = żadnej zmiennej (dozwolone w self-hoście
 * z kluczami źródeł w env); w hostingu brak klucza = `error`, bo sekrety firm są tam tylko w bazie. `message` bez
 * materiału klucza (komunikaty `encryptionKeysFromEnv`) — do logu startu, nie do odpowiedzi HTTP. Zły `APP_MODE`
 * też = `error` (nie wyjątek), żeby health odpowiedział JSON-em. Pokrycie wersji wpisów z bazy: `keyCoverage`.
 */
export function encryptionKeysStatus(env: Env): { status: EncryptionKeysStatus; message?: string; ring?: KeyRing } {
  try {
    const none = !env['APP_ENCRYPTION_KEY']?.trim() && !env['APP_ENCRYPTION_KEYS']?.trim()
    if (none && appModeOf(env) !== 'hosted') return { status: 'none' }
    return { status: 'ok', ring: encryptionKeysFromEnv(env) }
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Czy klucze z env otworzą wpisy z bazy: `ring` = null, gdy w env nie ma żadnego
 * klucza (`none`). Typowa pomyłka kroku 3 README — skasowany APP_ENCRYPTION_KEYS zamiast APP_ENCRYPTION_KEY — daje
 * składniowo poprawny pierścień {v1} przy wpisach v2; bez tego sprawdzenia health pokazałby fałszywe `ok`.
 * Komunikaty tylko z numerami wersji.
 */
export function keyCoverage(ring: KeyRing | null, versionsInDb: readonly number[]): { status: 'ok' | 'error'; message?: string } {
  const vs = [...new Set(versionsInDb)].sort((x, y) => y - x)
  const list = (xs: readonly number[]) => xs.map((v) => `v${v}`).join(', ')
  if (!ring) return vs.length ? { status: 'error', message: `W bazie są sekrety zaszyfrowane kluczem ${list(vs)}, a w env nie ma żadnego klucza głównego` } : { status: 'ok' }
  const missing = vs.filter((v) => !ring.keys.has(v))
  if (!missing.length) return { status: 'ok' }
  return {
    status: 'error',
    message: `W bazie są sekrety zaszyfrowane kluczem ${list(missing)}, a w env są tylko: ${list([...ring.keys.keys()])} — przywróć APP_ENCRYPTION_KEYS z ${list(missing)}`,
  }
}

/** Wersje kluczy użyte przez wpisy wszystkich firm — klientem systemowym (bez RLS), jedno małe zapytanie. */
export async function secretKeyVersionsInDb(sys: PrismaClient): Promise<number[]> {
  return (await sys.integrationSecret.findMany({ distinct: ['keyVersion'], select: { keyVersion: true } })).map((r) => r.keyVersion)
}

export interface SealedSecret {
  ciphertext: Uint8Array
  iv: Uint8Array
  authTag: Uint8Array
  keyVersion: number
}

function aad(organizationId: string, ref: string): Buffer {
  return Buffer.from(`${organizationId}:${ref}`, 'utf8')
}

/** Szyfruje najnowszym kluczem i zwraca jego wersję do zapisu przy wpisie. */
export function sealSecret(ring: KeyRing, organizationId: string, ref: string, plaintext: string): SealedSecret {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', ring.keys.get(ring.current)!, iv)
  c.setAAD(aad(organizationId, ref))
  const ciphertext = Buffer.concat([c.update(plaintext, 'utf8'), c.final()])
  return { ciphertext, iv, authTag: c.getAuthTag(), keyVersion: ring.current }
}

/** Odszyfrowuje kluczem wersji, którą zapisano przy wpisie (`keyVersion`). */
export function openSecret(ring: KeyRing, organizationId: string, ref: string, s: SealedSecret): string {
  const key = ring.keys.get(s.keyVersion)
  if (!key)
    throw new SecretError(`Sekret ${ref} zaszyfrowano kluczem v${s.keyVersion}, którego nie ma w kluczach z env (są: ${[...ring.keys.keys()].map((v) => `v${v}`).join(', ')}) — web i worker muszą mieć ten sam APP_ENCRYPTION_KEYS`)
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(s.iv))
    d.setAAD(aad(organizationId, ref))
    d.setAuthTag(Buffer.from(s.authTag))
    return Buffer.concat([d.update(Buffer.from(s.ciphertext)), d.final()]).toString('utf8')
  } catch {
    // bez treści wyjątku kryptografii i bez wartości: tylko co się nie udało
    throw new SecretError(`Nie da się odszyfrować sekretu ${ref} (inny klucz główny v${s.keyVersion} albo uszkodzony wpis)`)
  }
}

function assertName(name: string): void {
  if (!SECRET_NAME_RE.test(name)) throw new SecretError(`Zła nazwa sekretu (wielkie litery, cyfry, _; 2–64 znaki)`)
}

/** Konto kanału, do którego należy sekret; null = sekret całej firmy. */
export type SecretScope = { channel: Channel; channelAccountId: string } | null

/** Odnośnik sekretu w AAD i komunikatach (bez wartości). */
export function secretRef(name: string, scope: SecretScope = null): string {
  return scope ? `${scope.channel}/${scope.channelAccountId}/${name}` : name
}

const sealedData = (s: SealedSecret) => ({
  ciphertext: new Uint8Array(s.ciphertext),
  iv: new Uint8Array(s.iv),
  authTag: new Uint8Array(s.authTag),
  keyVersion: s.keyVersion,
})

const scopeWhere = (scope: SecretScope) =>
  scope ? { channel: scope.channel, channelAccountId: scope.channelAccountId } : { channel: null, channelAccountId: null }

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]

/** @internal tylko testy: punkt między odczytem wiersza a zapisem (np. równoległe kasowanie z drugiego klienta). */
export interface ZapisSekretuHooks {
  poOdczycie?: () => Promise<void>
}

/**
 * Zapis jednego zaszyfrowanego sekretu w transakcji `tx` — wspólny dla `setSecret` i rotacji sekretów kont
 * (lib/adaptery/rotacja-sekretow.ts). Bez upserta Prismy: klucz z pustym kontem (NULL)
 * nie jest jej kluczem unikalnym. Wyścig dwóch zapisów łapie indeks unikalny (firmowy: częściowy na (firma, nazwa)),
 * więc przegrany zapis kończy się błędem, nie dublem.
 * - Wiersz skasowany przez równoległą transakcję między odczytem a zapisem (panel kasuje inny sekret, trasa kluczy Woo
 *   zużywa znacznik) = zapis jako nowy (`updateMany` zwraca 0, potem `create`), nie błąd P2025 „record not found”.
 * - Wiersz skasowany i od razu odtworzony przez kogoś innego (nowe id) = `create` trafia w indeks unikalny: P2002,
 *   cała transakcja się wycofuje i wołający dostaje błąd (nie nadpisujemy po cichu cudzego, świeższego zapisu).
 */
export async function zapiszSekretTx(
  tx: Tx,
  organizationId: string,
  name: string,
  scope: SecretScope,
  data: ReturnType<typeof sealedData>,
  hooks?: ZapisSekretuHooks,
): Promise<void> {
  const cur = await tx.integrationSecret.findFirst({ where: { name, ...scopeWhere(scope) }, select: { id: true } })
  await hooks?.poOdczycie?.()
  const zmienione = cur ? (await tx.integrationSecret.updateMany({ where: { id: cur.id }, data })).count : 0
  if (!zmienione) await tx.integrationSecret.create({ data: { organizationId, name, ...scopeWhere(scope), ...data } })
}

/** Szyfrowanie wartości sekretu (najnowszy klucz, AAD firmy i konta) do zapisu przez `zapiszSekretTx`. */
export function zaszyfrujSekret(env: Env, organizationId: string, name: string, scope: SecretScope, value: string): ReturnType<typeof sealedData> {
  return sealedData(sealSecret(encryptionKeysFromEnv(env), organizationId, secretRef(name, scope), value))
}

/** Zapis sekretu firmy klienta `db` (RLS: tylko własnej); `scope` = konto kanału z konfiguracji firmy. */
export async function setSecret(db: PrismaClient, name: string, value: string, env: Env, scope: SecretScope = null, hooks?: ZapisSekretuHooks): Promise<void> {
  assertName(name)
  const ref = secretRef(name, scope)
  if (!value) throw new SecretError(`Pusta wartość sekretu ${ref}`)
  if (value.length > 8192) throw new SecretError(`Sekret ${ref} dłuższy niż 8192 znaki`)
  const organizationId = organizationIdOf(db)
  if (scope && !(await db.channelConfig.findFirst({ where: { channel: scope.channel, channelAccountId: scope.channelAccountId }, select: { channel: true } })))
    throw new SecretError(`Nie ma konta kanału ${scope.channel}/${scope.channelAccountId} w konfiguracji firmy`)
  const data = zaszyfrujSekret(env, organizationId, name, scope, value)
  await db.$transaction((tx) => zapiszSekretTx(tx, organizationId, name, scope, data, hooks))
}

export async function deleteSecret(db: PrismaClient, name: string, scope: SecretScope = null): Promise<boolean> {
  assertName(name)
  const r = await db.integrationSecret.deleteMany({ where: { name, ...scopeWhere(scope) } })
  return r.count > 0
}

/** Lista do panelu/API: wyłącznie nazwy, konta i daty, nigdy wartości ani szyfrogramy. */
export async function listSecrets(
  db: PrismaClient,
): Promise<{ name: string; channel: Channel | null; channelAccountId: string | null; updatedAt: Date; keyVersion: number }[]> {
  return db.integrationSecret.findMany({
    select: { name: true, channel: true, channelAccountId: true, updatedAt: true, keyVersion: true },
    orderBy: [{ channel: 'asc' }, { channelAccountId: 'asc' }, { name: 'asc' }],
  })
}

export interface SecretSource {
  env: Env
  /** Fallback na env (self-host jednofirmowy) — wynik `envSecretsAllowed`. Tylko dla sekretów firmy, nie kont. */
  envFallback: boolean
}

/**
 * Sekrety firmy (albo konta kanału, `scope`) po nazwach: najpierw zaszyfrowane w bazie, potem — tylko dla sekretów
 * firmy i gdy dozwolone — env (w env nie da się rozróżnić dwóch sklepów). Brak = brak klucza w wyniku. Klucz główny
 * potrzebny tylko, gdy w bazie jest jakiś pasujący sekret.
 */
export async function resolveSecrets(db: PrismaClient, names: readonly string[], src: SecretSource, scope: SecretScope = null): Promise<Record<string, string>> {
  names.forEach(assertName)
  const organizationId = organizationIdOf(db)
  const rows = await db.integrationSecret.findMany({ where: { name: { in: [...names] }, ...scopeWhere(scope) } })
  const out: Record<string, string> = {}
  if (rows.length) {
    const ring = encryptionKeysFromEnv(src.env)
    for (const r of rows) out[r.name] = openSecret(ring, organizationId, secretRef(r.name, scope), r)
  }
  if (src.envFallback && !scope) for (const n of names) if (!(n in out) && src.env[n]) out[n] = src.env[n]!
  return out
}

export interface ReencryptResult {
  /** Wersja klucza, którą teraz zapisano (najnowsza). */
  keyVersion: number
  /** Wpisy przepisane najnowszym kluczem. */
  reencrypted: number
  /** Wpisy, które w międzyczasie ktoś zmienił (`setSecret` zapisał je już najnowszym kluczem) — pominięte. */
  skipped: number
  /** Wpisy firmy wciąż zaszyfrowane inną wersją niż najnowsza (po udanym przebiegu 0). */
  remaining: number
}

/**
 * Przeszyfrowanie sekretów firmy klienta `db` najnowszym kluczem: odczyt kluczem wersji wpisu, zapis
 * najnowszym. Najpierw odszyfrowanie wszystkich starszych wpisów — jeden nieczytelny = błąd i nic nie zapisane.
 * Zapis warunkowy (ta sama wersja i data zmiany co przy odczycie), więc równoległy `setSecret` nie zostanie
 * nadpisany starą wartością. Wartości nie wychodzą poza funkcję.
 * @internal `hooks` — tylko testy (wyścig z setSecret), nie punkt rozszerzeń.
 */
export async function reencryptSecrets(db: PrismaClient, env: Env, hooks?: { beforeWrite?: () => Promise<void> }): Promise<ReencryptResult> {
  const ring = encryptionKeysFromEnv(env)
  const organizationId = organizationIdOf(db)
  const rows = await db.integrationSecret.findMany({ where: { keyVersion: { not: ring.current } }, orderBy: { id: 'asc' } })
  const resealed = rows.map((r) => {
    const ref = secretRef(r.name, r.channel && r.channelAccountId ? { channel: r.channel, channelAccountId: r.channelAccountId } : null)
    return { r, data: sealedData(sealSecret(ring, organizationId, ref, openSecret(ring, organizationId, ref, r))) }
  })
  await hooks?.beforeWrite?.() // tylko testy: równoległy zapis między odczytem a transakcją (wyścig z setSecret)
  let reencrypted = 0
  await db.$transaction(
    async (tx) => {
      for (const { r, data } of resealed) {
        const u = await tx.integrationSecret.updateMany({ where: { id: r.id, keyVersion: r.keyVersion, updatedAt: r.updatedAt }, data })
        reencrypted += u.count
      }
    },
    { maxWait: 30_000, timeout: 60_000 }, // jawne limity jak lib/rdzen/stan.ts (domyślne 5 s nie wystarczy przy zdalnej bazie i wielu wpisach)
  )
  const remaining = await db.integrationSecret.count({ where: { keyVersion: { not: ring.current } } })
  return { keyVersion: ring.current, reencrypted, skipped: rows.length - reencrypted, remaining }
}
