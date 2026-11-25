// kursy średnie NBP (tabela A) do informacyjnego przeliczenia sum sprzedaży w obcych walutach na złote
// (pulpit, Raporty, API, XLSX). Pobiera je wyłącznie worker (zadanie `kursy-walut`: przy starcie i raz na dobę), nigdy
// ścieżka renderu strony. Zapis bez nowej tabeli: każda tabela w bazie należy do firmy (RLS), więc kursy leżą w
// `Organization.settings.kursyWalut` każdej firmy (`{ zrodlo, tabela, data, pobrano, kursy: { CZK: 0.1712 } }`).
// Brak tabeli w dniu (weekend, święto) obsługuje samo NBP: `tables/a/` zwraca ostatnią opublikowaną. Nowszy zapis nigdy
// nie jest nadpisywany starszą tabelą; błąd pobrania zostawia poprzednie kursy i zapisuje `ostatniBlad`. Bez kursu
// domyślnego w kodzie: waluta bez kursu nie wchodzi do sumy (lib/panel/sumy-walut.ts).
import type { Prisma, PrismaClient } from '@prisma/client'
import { organizationIdOf } from '@/lib/db'
import type { KursyWalut } from '@/lib/panel/sumy-walut'

/** Bieżąca (ostatnia opublikowana) tabela A kursów średnich NBP. */
export const NBP_TABELA_A_URL = 'https://api.nbp.pl/api/exchangerates/tables/a/?format=json'
export const KURSY_WALUT_JOB = 'kursy-walut'
/** Klucz w `Organization.settings`. */
export const KLUCZ_USTAWIEN = 'kursyWalut'
export const NBP_TIMEOUT_MS = 10_000
/** Tabela A ma ok. 35 walut (ok. 3 kB); więcej = nie ta odpowiedź. */
const MAKS_BAJTOW = 256 * 1024

const KOD_RE = /^[A-Z]{3}$/
const DZIEN_RE = /^\d{4}-\d{2}-\d{2}$/

export interface ZapisKursow extends KursyWalut {
  zrodlo: 'NBP-A'
  /** chwila udanego pobrania (ISO) */
  pobrano: string
  /** ostatnia nieudana próba (kursy zostają z poprzedniego pobrania) */
  ostatniBlad?: { at: string; komunikat: string }
}

export class KursyNbpError extends Error {}

type Fetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

/** Odpowiedź `tables/a/` → tabela, dzień notowania i kursy (PLN za 1 jednostkę waluty). Zła odpowiedź = błąd. */
export function parsujTabeleNbp(tekst: string): KursyWalut {
  let j: unknown
  try {
    j = JSON.parse(tekst)
  } catch {
    throw new KursyNbpError('NBP: odpowiedź nie jest JSON-em')
  }
  const t = Array.isArray(j) ? j[0] : j
  if (!t || typeof t !== 'object') throw new KursyNbpError('NBP: brak tabeli w odpowiedzi')
  const o = t as Record<string, unknown>
  const data = typeof o['effectiveDate'] === 'string' ? o['effectiveDate'] : ''
  if (!DZIEN_RE.test(data)) throw new KursyNbpError('NBP: brak daty notowania')
  const tabela = typeof o['no'] === 'string' && o['no'].length <= 40 ? o['no'] : ''
  if (!tabela) throw new KursyNbpError('NBP: brak numeru tabeli')
  const rates = Array.isArray(o['rates']) ? (o['rates'] as unknown[]) : []
  const kursy: Record<string, number> = {}
  for (const r of rates) {
    if (!r || typeof r !== 'object') continue
    const x = r as Record<string, unknown>
    const kod = typeof x['code'] === 'string' ? x['code'].trim().toUpperCase() : ''
    const mid = typeof x['mid'] === 'number' ? x['mid'] : NaN
    if (KOD_RE.test(kod) && kod !== 'PLN' && Number.isFinite(mid) && mid > 0) kursy[kod] = mid
  }
  if (!Object.keys(kursy).length) throw new KursyNbpError('NBP: tabela bez kursów')
  return { tabela, data, kursy }
}

/** Pobiera bieżącą tabelę A (limit czasu, limit rozmiaru). Adres i `fetch` do podmiany w testach. */
export async function pobierzTabeleNbp(opts: { url?: string; fetch?: Fetch; timeoutMs?: number } = {}): Promise<KursyWalut> {
  const f: Fetch = opts.fetch ?? (globalThis.fetch as unknown as Fetch)
  let res: Awaited<ReturnType<Fetch>>
  try {
    res = await f(opts.url ?? NBP_TABELA_A_URL, { signal: AbortSignal.timeout(opts.timeoutMs ?? NBP_TIMEOUT_MS), headers: { accept: 'application/json' } })
  } catch (e) {
    const name = e instanceof Error ? e.name : ''
    throw new KursyNbpError(name === 'TimeoutError' || name === 'AbortError' ? 'NBP: brak odpowiedzi w limicie czasu' : `NBP: błąd połączenia (${e instanceof Error ? e.message : String(e)})`)
  }
  if (!res.ok) throw new KursyNbpError(`NBP: HTTP ${res.status}`)
  const tekst = await res.text()
  if (tekst.length > MAKS_BAJTOW) throw new KursyNbpError('NBP: odpowiedź za duża')
  return parsujTabeleNbp(tekst)
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Zapis z ustawień firmy (obronnie: zły wpis = brak kursów, nigdy wyjątek na ekranie). */
export function parsujZapisKursow(v: unknown): ZapisKursow | null {
  if (!isObj(v)) return null
  const data = typeof v['data'] === 'string' && DZIEN_RE.test(v['data']) ? v['data'] : null
  const k = isObj(v['kursy']) ? v['kursy'] : null
  if (!data || !k) return null
  const kursy: Record<string, number> = {}
  for (const [kod, mid] of Object.entries(k)) if (KOD_RE.test(kod) && typeof mid === 'number' && Number.isFinite(mid) && mid > 0) kursy[kod] = mid
  if (!Object.keys(kursy).length) return null
  const blad = isObj(v['ostatniBlad']) && typeof v['ostatniBlad']['at'] === 'string' && typeof v['ostatniBlad']['komunikat'] === 'string' ? { at: v['ostatniBlad']['at'], komunikat: v['ostatniBlad']['komunikat'] } : undefined
  return { zrodlo: 'NBP-A', tabela: typeof v['tabela'] === 'string' ? v['tabela'] : '', data, pobrano: typeof v['pobrano'] === 'string' ? v['pobrano'] : '', kursy, ...(blad ? { ostatniBlad: blad } : {}) }
}

/** Kursy firmy do przeliczenia sum (jeden mały odczyt z bazy; brak = null, sumy liczą wtedy tylko PLN). */
export async function czytajKursy(db: PrismaClient): Promise<KursyWalut | null> {
  const org = await db.organization.findFirst({ select: { settings: true } })
  const s = isObj(org?.settings) ? org.settings : {}
  const z = parsujZapisKursow(s[KLUCZ_USTAWIEN])
  return z ? { tabela: z.tabela, data: z.data, kursy: z.kursy } : null
}

async function zapisz(db: PrismaClient, zmien: (przed: ZapisKursow | null) => ZapisKursow | null): Promise<ZapisKursow | null> {
  const organizationId = organizationIdOf(db)
  return db.$transaction(async (tx) => {
    // ten sam wzorzec co zapis profilu firmy: wiersz firmy pod blokadą, reszta ustawień bez zmian
    const rows = await tx.$queryRaw<{ settings: Prisma.JsonValue }[]>`SELECT settings FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`
    if (!rows[0]) throw new Error('Brak firmy klienta')
    const settings = isObj(rows[0].settings) ? rows[0].settings : {}
    const przed = parsujZapisKursow(settings[KLUCZ_USTAWIEN])
    const nowy = zmien(przed)
    if (!nowy) return przed
    await tx.organization.update({ where: { id: organizationId }, data: { settings: { ...settings, [KLUCZ_USTAWIEN]: nowy } as unknown as Prisma.InputJsonValue } })
    return nowy
  })
}

/**
 * Przebieg zadania `kursy-walut`: pobranie tabeli i zapis. Starsza tabela niż zapisana (np. odpowiedź z pamięci
 * podręcznej) nie nadpisuje nowszej. Błąd pobrania: kursy zostają, `ostatniBlad` w zapisie (gdy był wcześniejszy zapis)
 * i wyjątek do `Job.lastError`.
 */
export async function odswiezKursy(db: PrismaClient, opts: { url?: string; fetch?: Fetch; timeoutMs?: number; now?: Date } = {}): Promise<ZapisKursow | null> {
  const now = opts.now ?? new Date()
  let t: KursyWalut
  try {
    t = await pobierzTabeleNbp(opts)
  } catch (e) {
    const komunikat = (e instanceof Error ? e.message : String(e)).slice(0, 300)
    await zapisz(db, (przed) => (przed ? { ...przed, ostatniBlad: { at: now.toISOString(), komunikat } } : null)).catch(() => null)
    throw e
  }
  return zapisz(db, (przed) => {
    if (przed && przed.data > t.data) return { ...przed, ostatniBlad: undefined }
    return { zrodlo: 'NBP-A', tabela: t.tabela, data: t.data, pobrano: now.toISOString(), kursy: t.kursy }
  })
}
