// Zadanie workera `powiadomienia-zulip`: przebieg wysyłki firmy z wynikiem jako liczniki w logu.
// Zła wartość env = błąd bez ponawiania (worker i tak nie startuje z nią — harmonogramZEnv).
import type { PrismaClient } from '@prisma/client'
import { NonRetryableError } from '../bledy'
import type { SecretSource } from '../sekrety'
import { powiadomieniaZEnv } from './adres'
import { runZulipDeliveries, type RunDeps, type RunResult } from './wysylka'

export function opisWyniku(r: RunResult): string {
  return `wysłane ${r.sent}, ponowienie ${r.retry}, błąd ${r.failed}, niepewne ${r.uncertain}, bez trasy ${r.noRoute}, przerwane ${r.stale}, czeka ${r.deferred}${r.disabled ? ', WYŁĄCZONO (401/403)' : ''}`
}

export function zadaniePowiadomienZulip(deps: RunDeps = { fetch: (u, i) => globalThis.fetch(u, i) }, log: (s: string) => void = (s) => console.log(s)) {
  return async (db: PrismaClient, _payload: unknown, ctx: { organizationId: string; secrets: SecretSource }): Promise<void> => {
    try {
      powiadomieniaZEnv(ctx.secrets.env)
    } catch (e) {
      throw new NonRetryableError('powiadomienia-zulip: ' + (e instanceof Error ? e.message : String(e)))
    }
    const r = await runZulipDeliveries(db, ctx.secrets.env, deps)
    // bramki zamknięte albo błąd konfiguracji (ten jest w ustawieniach, na ekranie): bez logu co minutę
    const busy = r.sent + r.retry + r.failed + r.uncertain + r.noRoute + r.stale + r.deferred > 0
    if (busy) log(`[powiadomienia] ${ctx.organizationId}: ${r.skipped ? `pominięto (${r.skipped}); ` : ''}${opisWyniku(r)}`)
    if (r.errors.length) throw new Error(`powiadomienia-zulip: ${r.errors.length} błędów: ${r.errors.join('; ')}`.slice(0, 2000))
  }
}
