// Rotacja sekretów konta pod blokadą: OAuth z jednorazowym refresh tokenem (Allegro). Dwa procesy
// (worker i CLI) z tym samym wygasłym tokenem nie mogą odświeżyć go oba — drugi zużyłby już nieważny refresh token
// albo unieważnił parę pierwszego. Blokada = blokada wiersza sekretu w transakcji: `SELECT … FOR UPDATE` wiersza blokady
// (pierwsza nazwa z rotacji) trzyma go do końca transakcji, drugi proces czeka na tym samym zapytaniu, a po
// zwolnieniu czyta świeże wartości i widzi, że `stale` już nie jest aktualne — nie odświeża. Bez zmiany roli i sesji
// bazy (strażnik z tests/organizacje-izolacja). Zapis nowej pary w tej samej transakcji, więc nowy access token wraca
// do adaptera dopiero po zapisie w bazie. Wartości sekretów nie trafiają do błędów, alertów ani logów.
import type { PrismaClient } from '@prisma/client'
import { organizationIdOf } from '../db'
import { alert } from '../rdzen/stan'
import { encryptionKeysFromEnv, type Env, openSecret, secretRef, type SecretScope, zapiszSekretTx, zaszyfrujSekret } from '../sekrety'
import { sleep } from '../zrodla/http'
import { AdapterError, type SecretRotation } from './kontrakt'

/** Alert: odświeżone sekrety nie zapisane (stary refresh token działa jeszcze ok. 60 s, potem potrzebna nowa autoryzacja). */
export const SECRETS_NOT_SAVED_ALERT = 'SEKRETY_KONTA_NIEZAPISANE'

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]
type Scope = NonNullable<SecretScope>

const scopeWhere = (scope: Scope) => ({ channel: scope.channel, channelAccountId: scope.channelAccountId })

async function readSecrets(tx: Tx, organizationId: string, scope: Scope, names: readonly string[], env: Env): Promise<Record<string, string>> {
  const rows = await tx.integrationSecret.findMany({ where: { name: { in: [...names] }, ...scopeWhere(scope) } })
  if (!rows.length) return {}
  const ring = encryptionKeysFromEnv(env)
  return Object.fromEntries(rows.map((r) => [r.name, openSecret(ring, organizationId, secretRef(r.name, scope), r)]))
}

/** Zapis kilku sekretów konta w transakcji `tx` (szyfrowanie jak setSecret: najnowszy klucz, AAD firmy i konta). */
async function writeSecretsTx(tx: Tx, organizationId: string, scope: Scope, values: Record<string, string>, env: Env): Promise<void> {
  for (const [name, value] of Object.entries(values)) {
    if (!value) throw new AdapterError(`pusta wartość sekretu ${secretRef(name, scope)}`, 'TRWALY')
    // ta sama funkcja co setSecret — wiersz skasowany w trakcie (panel kasuje inny
    // sekret konta, blokada obejmuje tylko wiersz blokady) = zapis jako nowy, nie P2025 i 500 przy kluczach Woo
    await zapiszSekretTx(tx, organizationId, name, scope, zaszyfrujSekret(env, organizationId, name, scope, value))
  }
}

/** Blokuje wiersz sekretu do końca transakcji; false = wiersza nie ma. */
async function lockRow(tx: Tx, organizationId: string, scope: Scope, name: string): Promise<boolean> {
  // bez zapisu: `updatedAt` sekretu zmienia się tylko przy realnej zmianie wartości
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "IntegrationSecret"
    WHERE "organizationId" = ${organizationId} AND name = ${name} AND channel = ${scope.channel}::"Channel" AND "channelAccountId" = ${scope.channelAccountId}
    FOR UPDATE`
  return rows.length > 0
}

const TX = { maxWait: 60_000, timeout: 90_000 }

/**
 * Zapis kilku sekretów konta naraz (jedna transakcja) — device flow (scripts/allegro-autoryzacja.ts) zapisuje tak
 * nową parę, tym samym szyfrowaniem i w tym samym zakresie co rotacja. `remove` = nazwy do skasowania w tej samej
 * transakcji (np. znacznik odrzuconego refresh tokena).
 */
export async function writeAccountSecrets(db: PrismaClient, scope: Scope, values: Record<string, string>, env: Env, remove: readonly string[] = []): Promise<void> {
  const organizationId = organizationIdOf(db)
  if (!(await db.channelConfig.findFirst({ where: scopeWhere(scope), select: { channel: true } })))
    throw new AdapterError(`Nie ma konta kanału ${scope.channel}/${scope.channelAccountId} w konfiguracji firmy`, 'TRWALY')
  await db.$transaction(async (tx) => {
    await writeSecretsTx(tx, organizationId, scope, values, env)
    if (remove.length) await tx.integrationSecret.deleteMany({ where: { name: { in: [...remove] }, ...scopeWhere(scope) } })
  }, TX)
}

export interface RotationOpts {
  allowed: ReadonlySet<string>
  /** Odstęp przed ponowną próbą zapisu (w oknie 60 s starego refresh tokena); domyślnie 2 s. */
  retryDelayMs?: number
  /** @internal tylko testy: awaria zapisu (próba 1 = w transakcji z blokadą, 2 = ponowienie). */
  hooks?: { beforeWrite?: (attempt: 1 | 2) => Promise<void> }
}

/**
 * Rotacja sekretów konta (implementacja `AdapterContext.rotateSecrets` dla kont z bazy). Kolejność: blokada wiersza,
 * świeży odczyt, porównanie z `stale`, `refresh` (wywołanie HTTP pod blokadą), zapis, zatwierdzenie. Nieudany zapis po
 * udanym `refresh`: jedna ponowna próba (jeśli w międzyczasie nikt nie zapisał innej pary), potem alert konta i błąd.
 */
export async function rotateAccountSecrets(db: PrismaClient, scope: Scope, env: Env, rotation: SecretRotation, opts: RotationOpts): Promise<Record<string, string>> {
  const bad = [...rotation.names, rotation.stale.name].filter((n) => !opts.allowed.has(n))
  if (bad.length || !rotation.names.length) throw new AdapterError(`rotacja sekretów spoza manifestu: ${bad.join(', ') || '(brak nazw)'}`, 'TRWALY')
  const organizationId = organizationIdOf(db)
  const lockName = rotation.names[0]!
  const ref = `${scope.channel}/${scope.channelAccountId}`
  const got: { before: Record<string, string> | null; fresh: Record<string, string> | null } = { before: null, fresh: null }
  try {
    return await db.$transaction(async (tx) => {
      if (!(await lockRow(tx, organizationId, scope, lockName))) throw new AdapterError(`brak sekretu ${lockName} konta ${ref}`, 'TRWALY')
      const current = await readSecrets(tx, organizationId, scope, rotation.names, env)
      if (current[rotation.stale.name] !== rotation.stale.value) return current // inny proces już odświeżył
      got.before = current
      const fresh = await rotation.refresh(current)
      const outside = Object.keys(fresh).filter((n) => !opts.allowed.has(n))
      if (outside.length) throw new AdapterError(`rotacja chce zapisać sekret spoza manifestu: ${outside.join(', ')}`, 'TRWALY')
      got.fresh = fresh
      await opts.hooks?.beforeWrite?.(1)
      await writeSecretsTx(tx, organizationId, scope, fresh, env)
      return { ...current, ...fresh }
    }, TX)
  } catch (e) {
    const fresh = got.fresh
    if (!fresh || !got.before) throw e // odświeżenie się nie udało (albo nie było potrzebne) — nic do zapisania
    const before = got.before
    await sleep(opts.retryDelayMs ?? 2_000)
    try {
      return await db.$transaction(async (tx) => {
        await lockRow(tx, organizationId, scope, lockName)
        const now = await readSecrets(tx, organizationId, scope, rotation.names, env)
        // ktoś zapisał inną parę po naszej nieudanej transakcji — jego wygrywa (nie nadpisujemy nowszej)
        if (now[lockName] !== before[lockName]) return now
        await opts.hooks?.beforeWrite?.(2)
        await writeSecretsTx(tx, organizationId, scope, fresh, env)
        return { ...now, ...fresh }
      }, TX)
    } catch {
      try {
        await alert(
          db,
          SECRETS_NOT_SAVED_ALERT,
          ref,
          `Konto ${ref}: odświeżonych tokenów nie udało się zapisać w bazie (dwie próby). Stary refresh token przestaje działać po ok. 60 s — jeśli kolejny odczyt zgłosi brak autoryzacji, uruchom ponowną autoryzację konta.`,
          `sekrety-niezapisane:${ref}:${new Date().toISOString().slice(0, 13)}`,
        )
      } catch {
        // alert nie może przykryć właściwego błędu
      }
      throw new AdapterError(`konto ${ref}: nowa para tokenów nie zapisana w bazie (dwie próby) — nie używamy jej`, 'PRZEJSCIOWY')
    }
  }
}

/**
 * krótka praca na sekretach konta pod blokadą wiersza `lockName` (ta sama blokada co rotacja): świeży odczyt
 * `names`, `fn` (może wołać HTTP, jak `refresh` w rotacji) i zapis/kasowanie w tej samej transakcji. Autoryzacja Allegro
 * z panelu odpytuje tak kod urządzenia: dwa równoległe odpytania (dwie karty przeglądarki) nie zużyją kodu dwa razy.
 * Zwraca null, gdy wiersza blokady nie ma (nic do zrobienia).
 */
export async function podBlokadaSekretow<T>(
  db: PrismaClient,
  scope: Scope,
  lockName: string,
  names: readonly string[],
  env: Env,
  fn: (current: Record<string, string>, zapisz: (values: Record<string, string>, remove?: readonly string[]) => Promise<void>) => Promise<T>,
): Promise<T | null> {
  const organizationId = organizationIdOf(db)
  return db.$transaction(async (tx) => {
    if (!(await lockRow(tx, organizationId, scope, lockName))) return null
    const current = await readSecrets(tx, organizationId, scope, [...new Set([lockName, ...names])], env)
    return fn(current, async (values, remove = []) => {
      if (Object.keys(values).length) await writeSecretsTx(tx, organizationId, scope, values, env)
      if (remove.length) await tx.integrationSecret.deleteMany({ where: { name: { in: [...remove] }, ...scopeWhere(scope) } })
    })
  }, TX)
}
