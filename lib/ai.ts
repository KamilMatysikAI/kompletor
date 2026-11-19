// Dostawca AI jako zwykła integracja (decyzja właściciela 25.10.2026, PROJEKT.md „AI ready na każdym kroku”):
// konto rodziny `AI` w ChannelConfig (adapterKey np. „ai.anthropic.v1”, config: model, limity), klucz jako sekret
// konta (lib/sekrety.ts). Tylko wybór klucza — żadnych funkcji AI ani wywołań API; zużycie zapisuje się
// w tabeli AiUsage (naliczanie i saldo: osobne zadanie).
//
// Skąd klucz:
//   1. sekret firmy na koncie AI (self-host: klucz klienta; hosting: klient może podać własny) → nie z salda,
//   2. hosting bez klucza firmy: nasz klucz z env PLATFORM_AI_API_KEY → rozliczane z salda firmy,
//   3. self-host jednofirmowy: env AI_API_KEY (jak inne klucze z env) → nie z salda.
import type { PrismaClient } from '@prisma/client'
import { appModeOf } from './organizacje'
import { deleteSecret, resolveSecrets, setSecret, type SecretSource } from './sekrety'

export const AI_SECRET_NAME = 'AI_API_KEY'
export const PLATFORM_AI_ENV = 'PLATFORM_AI_API_KEY'

export interface AiCredential {
  apiKey: string
  source: 'firma' | 'platforma' | 'env'
  /** true = klucz platformy: koszt zużycia (AiUsage) pokrywa saldo firmy. */
  billedToBalance: boolean
}

export async function resolveAiCredential(db: PrismaClient, channelAccountId: string, src: SecretSource): Promise<AiCredential | null> {
  const own = await resolveSecrets(db, [AI_SECRET_NAME], { ...src, envFallback: false }, { channel: 'AI', channelAccountId })
  if (own[AI_SECRET_NAME]) return { apiKey: own[AI_SECRET_NAME], source: 'firma', billedToBalance: false }
  if (appModeOf(src.env) === 'hosted') {
    const platform = src.env[PLATFORM_AI_ENV]
    return platform ? { apiKey: platform, source: 'platforma', billedToBalance: true } : null
  }
  const env = src.envFallback ? src.env[AI_SECRET_NAME] : undefined
  return env ? { apiKey: env, source: 'env', billedToBalance: false } : null
}

// ─── Cennik i dostawca firmy ─────────────────────────────────────────────────
// Jedno miejsce dla każdej funkcji AI (opis produktu, packshot, kolejne). Koszt do salda liczymy tylko przy kluczu
// platformy (`billedToBalance`): cennik dostawcy w USD × kurs × (1 + narzut). Klient widzi kwoty w PLN, nie mechanikę.

/** Kurs przeliczenia USD → PLN do salda (stały szacunek; zmiana = nowa wersja). */
export const USD_PLN = 4.0
/** Narzut na koszt API przy rozliczeniu z salda (jak w innych naszych usługach rozliczanych wg zużycia: +20%). */
export const NARZUT_AI = 0.2
/** Cennik modeli tekstowych: USD za milion tokenów (wejście, wyjście). Model spoza listy = błąd, nie cicha cena. */
export const CENNIK_AI_USD_ZA_MTOK: Readonly<Record<string, { in: number; out: number }>> = {
  'claude-opus-5-5': { in: 4, out: 20 },
  'claude-sonnet-5-5': { in: 2, out: 10 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5 },
}
export const DOMYSLNY_MODEL_AI = 'claude-opus-5-5'
/** Modele do wyboru w Ustawieniach (etykiety dla człowieka). */
export const MODELE_AI: readonly { id: string; etykieta: string }[] = [
  { id: 'claude-opus-5-5', etykieta: 'Claude Opus 5.5 (najlepsze teksty)' },
  { id: 'claude-sonnet-5-5', etykieta: 'Claude Sonnet 5.5 (tańszy)' },
  { id: 'claude-haiku-5-5', etykieta: 'Claude Haiku 5.5 (najtańszy, krótkie teksty)' },
]

export class NieznanyModelAi extends Error {
  constructor(readonly model: string) {
    super(`Model AI „${model}” nie ma cennika w Kompletorze. Wybierz model z listy w Ustawieniach → Integracje i agenci AI → Agenci AI → Dostawca AI.`)
  }
}

/** Koszt wywołania w groszach (z narzutem), zaokrąglony w górę. Nieznany model = {@link NieznanyModelAi}. */
export function kosztAiGrosze(model: string, inputTokens: number, outputTokens: number): number {
  const c = CENNIK_AI_USD_ZA_MTOK[model]
  if (!c) throw new NieznanyModelAi(model)
  return Math.ceil(((inputTokens * c.in + outputTokens * c.out) / 1_000_000) * USD_PLN * (1 + NARZUT_AI) * 100)
}

/**
 * Czy firma ma klucz AI (bez odszyfrowania sekretu: wystarczy, że wpis istnieje). Ta sama kolejność co
 * {@link resolveAiCredential}: klucz firmy na koncie AI, w hostingu klucz platformy, w self-host env AI_API_KEY.
 */
export async function zrodloKluczaAi(db: PrismaClient, channelAccountId: string, src: SecretSource): Promise<AiCredential['source'] | null> {
  const own = await db.integrationSecret.count({ where: { name: AI_SECRET_NAME, channel: 'AI', channelAccountId } })
  if (own) return 'firma'
  if (appModeOf(src.env) === 'hosted') return src.env[PLATFORM_AI_ENV] ? 'platforma' : null
  return src.envFallback && src.env[AI_SECRET_NAME] ? 'env' : null
}

/** Konto AI firmy: pierwsze aktywne konto rodziny AI (id konta, model, packshot), albo domyślne „ai” dla klucza z env. */
export interface DostawcaAi {
  accountId: string
  /** model z konfiguracji konta; zły format = model domyślny, nieznany cennikowi = błąd przy użyciu */
  model: string
  /** wyłącznik packshotu AI (domyślnie wyłączony: generowanie obrazów kosztuje) */
  packshot: boolean
  /** wyłącznik asystenta „Zapytaj” w panelu (domyślnie wyłączony; odpowiada tylko z Pomocy) */
  asystent: boolean
  /** czy konto AI istnieje w konfiguracji firmy */
  maKonto: boolean
}

export const KONTO_AI_DOMYSLNE = 'ai'

export async function dostawcaAiFirmy(db: PrismaClient): Promise<DostawcaAi> {
  const acc = await db.channelConfig.findFirst({ where: { channel: 'AI', active: true }, orderBy: { channelAccountId: 'asc' }, select: { channelAccountId: true, config: true } })
  const cfg = acc?.config && typeof acc.config === 'object' && !Array.isArray(acc.config) ? (acc.config as Record<string, unknown>) : {}
  const model = typeof cfg['model'] === 'string' && /^claude-[a-z0-9-]{3,60}$/.test(cfg['model']) ? cfg['model'] : DOMYSLNY_MODEL_AI
  return { accountId: acc?.channelAccountId ?? KONTO_AI_DOMYSLNE, model, packshot: cfg['packshot'] === true, asystent: cfg['asystent'] === true, maKonto: !!acc }
}

export type WynikDostawcyAi = { ok: true; zmiany: string[] } | { ok: false; error: string; field?: 'model' | 'klucz' | 'kluczObrazow' }

// ─── Dostawca obrazów (packshot): Kie.ai, ten sam wzorzec klucza co tekst ──────────────────────────────────────────
export const AI_OBRAZY_SECRET_NAME = 'KIE_API_KEY'
export const PLATFORM_AI_OBRAZY_ENV = 'PLATFORM_KIE_API_KEY'
/** Klucz Kie.ai: litery i cyfry (zwykle 32 znaki hex), bez spacji. */
export const KLUCZ_OBRAZOW_RE = /^[A-Za-z0-9_-]{16,200}$/
/** Szacunkowy koszt jednego packshotu (Kie.ai, Nano Banana 2.1, 1K: 4 kredyty ≈ 0,02 USD), do salda z narzutem. */
export const PACKSHOT_USD = 0.02
export const kosztPackshotuGrosze = () => Math.ceil(PACKSHOT_USD * USD_PLN * (1 + NARZUT_AI) * 100)

/** Klucz dostawcy obrazów firmy: sekret konta AI, w hostingu klucz platformy, w self-host env KIE_API_KEY. */
export async function resolveAiObrazyCredential(db: PrismaClient, channelAccountId: string, src: SecretSource): Promise<AiCredential | null> {
  const own = await resolveSecrets(db, [AI_OBRAZY_SECRET_NAME], { ...src, envFallback: false }, { channel: 'AI', channelAccountId })
  if (own[AI_OBRAZY_SECRET_NAME]) return { apiKey: own[AI_OBRAZY_SECRET_NAME], source: 'firma', billedToBalance: false }
  if (appModeOf(src.env) === 'hosted') {
    const platform = src.env[PLATFORM_AI_OBRAZY_ENV]
    return platform ? { apiKey: platform, source: 'platforma', billedToBalance: true } : null
  }
  const env = src.envFallback ? src.env[AI_OBRAZY_SECRET_NAME] : undefined
  return env ? { apiKey: env, source: 'env', billedToBalance: false } : null
}

/** Czy jest klucz dostawcy obrazów (bez odszyfrowania). */
export async function zrodloKluczaObrazow(db: PrismaClient, channelAccountId: string, src: SecretSource): Promise<AiCredential['source'] | null> {
  const own = await db.integrationSecret.count({ where: { name: AI_OBRAZY_SECRET_NAME, channel: 'AI', channelAccountId } })
  if (own) return 'firma'
  if (appModeOf(src.env) === 'hosted') return src.env[PLATFORM_AI_OBRAZY_ENV] ? 'platforma' : null
  return src.envFallback && src.env[AI_OBRAZY_SECRET_NAME] ? 'env' : null
}

/** Klucz API Anthropic: `sk-ant-…`, bez spacji. Sprawdzenie formatu przed zapisem (śmieci nie trafiają do sekretów). */
export const KLUCZ_AI_RE = /^sk-ant-[A-Za-z0-9_-]{20,300}$/

/**
 * Ustawienia → Agenci AI → Dostawca AI: model, wyłącznik packshotu i (opcjonalnie) nowy klucz API firmy. Konto AI
 * powstaje przy pierwszym zapisie. Klucz idzie wyłącznie do sekretów firmy (zaszyfrowany), w historii tylko „klucz
 * zmieniony”, nigdy wartość. Puste pole klucza = klucz bez zmian.
 */
export async function zapiszDostawceAi(
  db: PrismaClient,
  dane: { model: unknown; packshot: unknown; klucz: unknown; kluczObrazow?: unknown; asystent?: unknown },
  env: Record<string, string | undefined>,
  actorId: string,
): Promise<WynikDostawcyAi> {
  const model = typeof dane.model === 'string' ? dane.model : ''
  if (!CENNIK_AI_USD_ZA_MTOK[model]) return { ok: false, error: 'Wybierz model z listy.', field: 'model' }
  const packshot = dane.packshot === true || dane.packshot === 'on' || dane.packshot === '1'
  const cur = await dostawcaAiFirmy(db)
  // pole nieprzesłane (inny wywołujący) = wyłącznik asystenta bez zmian
  const asystent = dane.asystent === undefined ? cur.asystent : dane.asystent === true || dane.asystent === 'on' || dane.asystent === '1'
  const klucz = typeof dane.klucz === 'string' ? dane.klucz.trim() : ''
  if (klucz && !KLUCZ_AI_RE.test(klucz)) return { ok: false, error: 'To nie wygląda na klucz API Anthropic (zaczyna się od „sk-ant-”, bez spacji). Skopiuj go jeszcze raz z console.anthropic.com.', field: 'klucz' }
  const kluczObrazow = typeof dane.kluczObrazow === 'string' ? dane.kluczObrazow.trim() : ''
  if (kluczObrazow && !KLUCZ_OBRAZOW_RE.test(kluczObrazow)) return { ok: false, error: 'Klucz Kie.ai to ciąg liter i cyfr bez spacji. Skopiuj go jeszcze raz z kie.ai (API Key).', field: 'kluczObrazow' }
  const zmiany: string[] = []
  if (!cur.maKonto) {
    await db.channelConfig.create({ data: { channel: 'AI', channelAccountId: cur.accountId, name: 'Dostawca AI', adapterKey: 'ai.anthropic.v1', config: { model, packshot, asystent } } })
    zmiany.push('konto')
  } else if (cur.model !== model || cur.packshot !== packshot || cur.asystent !== asystent) {
    const row = await db.channelConfig.findFirstOrThrow({ where: { channel: 'AI', channelAccountId: cur.accountId }, select: { config: true } })
    const cfg = row.config && typeof row.config === 'object' && !Array.isArray(row.config) ? (row.config as Record<string, unknown>) : {}
    await db.channelConfig.updateMany({ where: { channel: 'AI', channelAccountId: cur.accountId }, data: { config: { ...cfg, model, packshot, asystent } } })
  }
  if (cur.model !== model) zmiany.push('model')
  if (cur.packshot !== packshot) zmiany.push('packshot')
  if (cur.asystent !== asystent) zmiany.push('asystent')
  if (klucz) {
    await setSecret(db, AI_SECRET_NAME, klucz, env, { channel: 'AI', channelAccountId: cur.accountId })
    zmiany.push('klucz')
  }
  if (kluczObrazow) {
    await setSecret(db, AI_OBRAZY_SECRET_NAME, kluczObrazow, env, { channel: 'AI', channelAccountId: cur.accountId })
    zmiany.push('kluczObrazow')
  }
  if (zmiany.length)
    await db.auditLog.create({ data: { entity: 'ChannelConfig', entityId: `AI/${cur.accountId}`, actorId, before: { model: cur.model, packshot: cur.packshot, asystent: cur.asystent }, after: { model, packshot, asystent, ...(klucz ? { klucz: 'zmieniony' } : {}), ...(kluczObrazow ? { kluczObrazow: 'zmieniony' } : {}) } } })
  return { ok: true, zmiany }
}

/** Usunięcie klucza firmy z konta AI (np. po wycieku): tekst (`AI_API_KEY`) albo obrazy (`KIE_API_KEY`). Konto i model zostają. */
export async function usunKluczAi(db: PrismaClient, ktory: 'tekst' | 'obrazy', actorId: string): Promise<boolean> {
  const cur = await dostawcaAiFirmy(db)
  const ok = await deleteSecret(db, ktory === 'tekst' ? AI_SECRET_NAME : AI_OBRAZY_SECRET_NAME, { channel: 'AI', channelAccountId: cur.accountId })
  if (ok) await db.auditLog.create({ data: { entity: 'ChannelConfig', entityId: `AI/${cur.accountId}`, actorId, after: { [ktory === 'tekst' ? 'klucz' : 'kluczObrazow']: 'usunięty' } } })
  return ok
}

// ─── Zużycie z klucza platformy: limit dobowy i zapis kosztu ───────────────────────
// Salda firm jeszcze nie ma (naliczanie: osobne zadanie), więc do tego czasu klucz platformy ma bezpiecznik: suma
// kosztów AI firmy z ostatnich 24 h (AiUsage, tylko pozycje z salda, costGrosze > 0) nie może przekroczyć limitu.
// Limit w groszach z env PLATFORM_AI_LIMIT_DZIENNY_GROSZE (domyślnie 20 zł); 0 = AI z klucza platformy wyłączone.
// Dotyczy tylko klucza platformy: własny klucz firmy albo klucz z env w self-host płaci firma u dostawcy.
export const PLATFORM_AI_LIMIT_ENV = 'PLATFORM_AI_LIMIT_DZIENNY_GROSZE'
export const PLATFORM_AI_LIMIT_DOMYSLNY_GROSZE = 2000

export function limitPlatformyAiGrosze(env: Record<string, string | undefined>): number {
  const raw = env[PLATFORM_AI_LIMIT_ENV]?.trim()
  if (!raw) return PLATFORM_AI_LIMIT_DOMYSLNY_GROSZE
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : PLATFORM_AI_LIMIT_DOMYSLNY_GROSZE
}

const zl = (gr: number) => `${(gr / 100).toFixed(2).replace('.', ',')} zł`

/**
 * Null = można wydać `kosztGrosze` z klucza platformy; tekst = powód odmowy dla użytkownika.
 * Wołać tylko klientem firmy (`createOrgClient`): suma zużycia nie filtruje firmy, robi to RLS. Klient systemowy
 * policzyłby wszystkie firmy razem (bezpiecznie, bo limit szybciej się wyczerpie, ale myląco).
 * Limit jest bezpiecznikiem, nie rozliczeniem: równoległe zlecenia mogą go przekroczyć o jedno wywołanie na proces
 * (sprawdzenie i zapis zużycia nie są w jednej transakcji). Przy saldzie firm bramka przejdzie do transakcji z rezerwacją kwoty.
 */
export async function limitPlatformyAi(db: PrismaClient, kosztGrosze: number, env: Record<string, string | undefined>, now = new Date()): Promise<string | null> {
  const limit = limitPlatformyAiGrosze(env)
  const od = new Date(now.getTime() - 24 * 60 * 60_000)
  const agg = await db.aiUsage.aggregate({ where: { createdAt: { gte: od }, costGrosze: { gt: 0 } }, _sum: { costGrosze: true } })
  const wydane = agg._sum.costGrosze ?? 0
  if (wydane + kosztGrosze <= limit) return null
  return limit === 0
    ? 'Funkcje AI z konta Kompletora są w tej instalacji wyłączone. Dodaj własny klucz: Ustawienia → Integracje i agenci AI → Agenci AI → Dostawca AI.'
    : `Wyczerpany dobowy limit AI z konta Kompletora (${zl(limit)} na 24 godziny, wykorzystano ${zl(wydane)}). Spróbuj później albo dodaj własny klucz: Ustawienia → Integracje i agenci AI → Agenci AI → Dostawca AI.`
}

export interface ZuzycieAi {
  feature: string
  model: string
  inputTokens: number
  outputTokens: number
  costGrosze: number
}

/**
 * Zapis zużycia AI: błąd zapisu nie znika po cichu. Trafia do logu procesu i do historii (`AuditLog`, encja
 * `AiUsage`, z kwotą), żeby koszt z salda dało się odtworzyć. Zwraca false, gdy pozycja kosztu nie powstała.
 */
export async function zapiszZuzycieAi(db: PrismaClient, z: ZuzycieAi, kontekst: { entity?: string; entityId?: string } = {}): Promise<boolean> {
  try {
    await db.aiUsage.create({ data: z })
    return true
  } catch (e) {
    await zglosNiezapisaneZuzycie(db, z, e, kontekst)
    return false
  }
}

export async function zglosNiezapisaneZuzycie(db: PrismaClient, z: ZuzycieAi, e: unknown, kontekst: { entity?: string; entityId?: string } = {}): Promise<void> {
  const blad = (e instanceof Error ? e.message : String(e)).slice(0, 300)
  console.error(`[ai] koszt nie zapisany (${z.feature}, ${z.model}, ${z.costGrosze} gr): ${blad}`)
  await db.auditLog
    .create({ data: { entity: kontekst.entity ?? 'AiUsage', entityId: kontekst.entityId ?? z.feature, actorId: 'system:ai', after: { kosztNieZapisany: { ...z }, blad } } })
    .catch((e2: unknown) => console.error(`[ai] wpis o niezapisanym koszcie też nieudany: ${e2 instanceof Error ? e2.message : String(e2)}`))
}
