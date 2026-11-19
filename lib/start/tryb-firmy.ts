// Tryb pracy całej firmy z panelu: stan kont sklepów na pulpicie i „Włącz tryb pracy” dla wszystkich kont
// w podglądzie naraz. Bez własnej logiki trybu: każde konto przechodzi przez `zmienTrybKonta` z lib/kanaly/tryb.ts
// (te same warunki, AuditLog i goBy/goAt co na ekranie konta). Jedno konto z niespełnionym warunkiem nie
// zatrzymuje pozostałych (błąd per konto, powód wraca do ekranu). Twarda blokada instancji: `blokadaInstancji`.
import type { PrismaClient } from '@prisma/client'
import type { AdapterRegistry } from '../adaptery/rejestr'
import { organizationIdOf } from '../db'
import { KontoError } from '../kanaly/konta'
import { blokadaInstancji, prowadziZamowienia, trybKonta, zmienTrybKonta } from '../kanaly/tryb'

type Env = Record<string, string | undefined>

export interface KontoTrybu {
  nazwa: string
  tryb: ReturnType<typeof trybKonta>
}

export interface TrybFirmy {
  konta: KontoTrybu[]
  /** Konta sklepów w podglądzie albo w trybie mieszanym (do przełączenia). */
  wPodgladzie: number
  /** Powód twardej blokady instancji (zmienna serwera), null = przełączanie z panelu dozwolone. */
  blokada: string | null
}

const SKLEPY = { active: true, channel: { notIn: ['RECZNE' as const, 'AI' as const] } }

export async function trybFirmy(db: PrismaClient, firmaZBl: boolean, env: Env): Promise<TrybFirmy> {
  organizationIdOf(db)
  const rows = await db.channelConfig.findMany({ where: SKLEPY, select: { name: true, stockMode: true, statusMode: true, trackingMode: true }, orderBy: { name: 'asc' } })
  const konta = rows.map((r) => ({ nazwa: r.name, tryb: trybKonta(r) }))
  return { konta, wPodgladzie: konta.filter((k) => !prowadziZamowienia(k.tryb)).length, blokada: blokadaInstancji(env, firmaZBl) }
}

export interface WynikTrybuFirmy {
  wlaczone: string[]
  pominiete: { nazwa: string; powod: string }[]
}

/** „Włącz tryb pracy” dla wszystkich kont sklepów w podglądzie. Idempotentne (konto już aktywne = bez zmian). */
export async function wlaczPraceFirmy(db: PrismaClient, opts: { actorId: string; env: Env; registry: AdapterRegistry; firmaZBl: boolean; now?: Date }): Promise<WynikTrybuFirmy> {
  organizationIdOf(db)
  const blokada = blokadaInstancji(opts.env, opts.firmaZBl)
  const rows = await db.channelConfig.findMany({ where: SKLEPY, select: { channel: true, channelAccountId: true, name: true, stockMode: true, statusMode: true, trackingMode: true }, orderBy: { name: 'asc' } })
  const out: WynikTrybuFirmy = { wlaczone: [], pominiete: [] }
  for (const r of rows) {
    // konto pracujące bez stanów zostaje, jak jest (zbiorcze włączenie nie dołącza stanów ofert)
    if (prowadziZamowienia(trybKonta(r))) continue
    if (blokada) {
      out.pominiete.push({ nazwa: r.name, powod: blokada })
      continue
    }
    try {
      const w = await zmienTrybKonta(db, { channel: r.channel, channelAccountId: r.channelAccountId }, 'PRACA', opts)
      if (w === 'ZMIENIONO') out.wlaczone.push(r.name)
    } catch (e) {
      // KontoError niesie nasz tekst warunku; inny błąd bez szczegółów (mógłby nieść dane wejściowe)
      out.pominiete.push({ nazwa: r.name, powod: e instanceof KontoError ? e.message : 'Nie udało się przełączyć, spróbuj ponownie.' })
      if (!(e instanceof KontoError)) console.error(`[start] tryb pracy konta ${r.channel}/${r.channelAccountId}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return out
}

const konta = (n: number) => (n === 1 ? '1 konto' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? `${n} konta` : `${n} kont`)

/** Toast po „Włącz tryb pracy” (krótko, bez ucinania listy kont). */
export function komunikatWlaczenia(wlaczone: string[]): string {
  return wlaczone.length <= 2 ? `Tryb pracy włączony: ${wlaczone.join(', ')}.` : `Tryb pracy włączony: ${konta(wlaczone.length)}.`
}

/** Powód pominięcia jednego konta pokazujemy w całości; kilku: liczba i odesłanie do ekranów kont. */
export function komunikatPominiec(pominiete: WynikTrybuFirmy['pominiete']): string {
  if (pominiete.length === 1) return `${pominiete[0]!.nazwa}: ${pominiete[0]!.powod}`.slice(0, 500)
  const wspolny = pominiete.every((p) => p.powod === pominiete[0]!.powod) ? ` ${pominiete[0]!.powod}` : ' Powody pokazują ekrany kont (Ustawienia → Sprzedaż i kanały → Kanały sprzedaży → konto → Stan konta).'
  return `Zostaje w podglądzie: ${konta(pominiete.length)}.${wspolny}`.slice(0, 500)
}
