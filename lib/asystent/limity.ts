// Limity pytań asystenta „Zapytaj”. Bez nich każda osoba z dostępem do panelu mogłaby wołać asystenta w pętli
// (z kluczem firmy: koszt u firmy, z kluczem Kompletora: jedna osoba zjada dobowy limit AI całej firmy).
//  - osoba: N pytań na minutę i na dobę, w pamięci procesu jak limity API i MCP (lib/mcp/limity.ts); liczy każde
//    pytanie, także „nie wiem” bez wywołania modelu,
//  - firma: N pytań na minutę w pamięci procesu oraz dobowa liczba wywołań modelu z dziennika zużycia (`AiUsage`,
//    funkcja asystenta), więc dobowy limit firmy przetrwa restart serwera.
// Przy kilku instancjach limity w pamięci liczą się per instancja (jak w API v1).
import type { PrismaClient } from '@prisma/client'
import { RetryLimiter } from '../mcp/limity'

export const PYTANIA_OSOBY_NA_MINUTE = 6
export const PYTANIA_OSOBY_NA_DOBE = 100
export const PYTANIA_FIRMY_NA_MINUTE = 30
/** Dobowy limit wywołań modelu przez asystenta na firmę; zmienna środowiska, 0 = asystent bez modelu. */
export const PYTANIA_FIRMY_NA_DOBE_ENV = 'ASYSTENT_PYTANIA_FIRMY_NA_DOBE'
export const PYTANIA_FIRMY_NA_DOBE_DOMYSLNIE = 500
const DOBA_MS = 24 * 3600_000

export interface KtoPyta {
  /** id osoby (użytkownika panelu) */
  osoba: string
  /** id firmy (organizacji) */
  firma: string
}

class LimityAsystenta {
  readonly osobaMinuta = new RetryLimiter(PYTANIA_OSOBY_NA_MINUTE, 60_000)
  readonly osobaDoba = new RetryLimiter(PYTANIA_OSOBY_NA_DOBE, DOBA_MS)
  readonly firmaMinuta = new RetryLimiter(PYTANIA_FIRMY_NA_MINUTE, 60_000)
}

let limity = new LimityAsystenta()

/** Tylko testy: liczniki od zera. */
export function resetLimitowAsystenta(): void {
  limity = new LimityAsystenta()
}

function zaIle(sek: number): string {
  if (sek < 90) return `${sek} s`
  if (sek < 5400) return `${Math.ceil(sek / 60)} min`
  return `${Math.ceil(sek / 3600)} godz.`
}

/** Null = pytanie przechodzi (i jest policzone); tekst = powód odmowy dla osoby w panelu. */
export function limitPytanOsoby(kto: KtoPyta, now = Date.now()): string | null {
  const osoba = `${kto.firma}:${kto.osoba}`
  const minuta = limity.osobaMinuta.hit(osoba, now)
  if (minuta !== null) return `Za dużo pytań naraz (najwyżej ${PYTANIA_OSOBY_NA_MINUTE} na minutę). Spróbuj za ${zaIle(minuta)}.`
  const doba = limity.osobaDoba.hit(osoba, now)
  if (doba !== null) return `Wykorzystałeś dzienny limit pytań do asystenta (${PYTANIA_OSOBY_NA_DOBE} na dobę). Spróbuj za ${zaIle(doba)} albo zajrzyj do spisu Pomocy.`
  const firma = limity.firmaMinuta.hit(kto.firma, now)
  if (firma !== null) return `W firmie pada teraz bardzo dużo pytań do asystenta. Spróbuj za ${zaIle(firma)}.`
  return null
}

export function pytaniaFirmyNaDobe(env: Record<string, string | undefined>): number {
  const raw = env[PYTANIA_FIRMY_NA_DOBE_ENV]?.trim()
  if (!raw) return PYTANIA_FIRMY_NA_DOBE_DOMYSLNIE
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : PYTANIA_FIRMY_NA_DOBE_DOMYSLNIE
}

/**
 * Dobowy limit wywołań modelu przez asystenta w firmie (`db` z kontekstem firmy: liczy tylko jej zużycie).
 * Null = można wywołać model; tekst = powód odmowy.
 */
export async function limitPytanFirmyNaDobe(db: PrismaClient, feature: string, env: Record<string, string | undefined>, now = new Date()): Promise<string | null> {
  const limit = pytaniaFirmyNaDobe(env)
  const od = new Date(now.getTime() - DOBA_MS)
  const ile = await db.aiUsage.count({ where: { feature, createdAt: { gte: od } } })
  if (ile < limit) return null
  return `Firma wykorzystała dzienny limit pytań do asystenta (${limit} na dobę). Spróbuj jutro albo zajrzyj do spisu Pomocy.`
}
