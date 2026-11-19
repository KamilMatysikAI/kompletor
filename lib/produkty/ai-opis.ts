// „Podpowiedz opis (AI)” na karcie produktu i w „Dodaj produkt”. Dostawca AI firmy (lib/ai.ts: konto rodziny
// AI w ChannelConfig z kluczem jako sekret konta; hosting: klucz platformy rozliczany z salda; self-host: env
// AI_API_KEY). Bez dostawcy przycisk mówi, gdzie go ustawić — nic nie jest wysyłane.
//
// Do modelu idą tylko dane produktu (nazwa, SKU, EAN, rodzaj, dotychczasowy opis) — nigdy dane klientów. Wynik jest
// propozycją: wpada do pola opisu w formularzu, zapis robi człowiek. Zużycie trafia do AiUsage (funkcja „opis-produktu”).
import Anthropic from '@anthropic-ai/sdk'
import type { PrismaClient } from '@prisma/client'
import { dostawcaAiFirmy, DOMYSLNY_MODEL_AI, kosztAiGrosze, limitPlatformyAi, NieznanyModelAi, resolveAiCredential, zapiszZuzycieAi, zrodloKluczaAi } from '../ai'
import { appModeOf } from '../organizacje'

export const AI_FEATURE = 'opis-produktu'
export const DOMYSLNY_MODEL = DOMYSLNY_MODEL_AI
export const AI_BRAK = 'Podpowiedź opisu wymaga dostawcy AI. Ustawia go właściciel firmy: Ustawienia → Integracje i agenci AI → Agenci AI → Dostawca AI (klucz API), a przy instalacji na własnym serwerze wystarczy też zmienna AI_API_KEY. Opis: Pomoc → Produkty.'

/**
 * Czy firma ma dostawcę AI (klucz firmy, platformy albo env) — do pokazania przycisku. Bez odszyfrowania sekretu przy
 * każdym renderze: wystarczy, że wpis istnieje; zły klucz pokaże komunikat dopiero przy użyciu.
 */
export async function maDostawceAi(db: PrismaClient, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  try {
    const k = await dostawcaAiFirmy(db)
    return !!(await zrodloKluczaAi(db, k.accountId, { env, envFallback: appModeOf(env) === 'self-host' }))
  } catch {
    return false
  }
}

export interface DaneDoOpisu {
  title: string
  sku?: string | null
  ean?: string | null
  rodzaj?: string | null
  opis?: string | null
}

export type WynikOpisu = { ok: true; opis: string } | { ok: false; error: string }

/** Propozycja opisu produktu po polsku. Błąd dostawcy = czytelny komunikat, formularz działa dalej. */
export async function podpowiedzOpis(db: PrismaClient, d: DaneDoOpisu, env: Record<string, string | undefined> = process.env, client?: Pick<Anthropic, 'messages'>): Promise<WynikOpisu> {
  const title = d.title.trim().slice(0, 200)
  if (!title) return { ok: false, error: 'Najpierw wpisz nazwę produktu.' }
  const k = await dostawcaAiFirmy(db)
  // nieznany model = błąd przed wywołaniem (nie liczymy po cichu ceną innego modelu)
  try {
    kosztAiGrosze(k.model, 0, 0)
  } catch (e) {
    if (e instanceof NieznanyModelAi) return { ok: false, error: e.message }
    throw e
  }
  const cred = await resolveAiCredential(db, k.accountId, { env, envFallback: appModeOf(env) === 'self-host' })
  if (!cred) return { ok: false, error: AI_BRAK }
  // klucz platformy (koszt z salda): po wyczerpaniu dobowego limitu firmy nic nie wysyłamy
  if (cred.billedToBalance) {
    const limit = await limitPlatformyAi(db, 1, env)
    if (limit) return { ok: false, error: limit }
  }
  const api = client ?? new Anthropic({ apiKey: cred.apiKey, maxRetries: 1, timeout: 60_000 })
  const dane = [`Nazwa: ${title}`, d.sku ? `SKU: ${d.sku}` : '', d.ean ? `EAN: ${d.ean}` : '', d.rodzaj ? `Rodzaj: ${d.rodzaj}` : '', d.opis ? `Obecny opis (do poprawy):\n${d.opis.slice(0, 4000)}` : '']
    .filter(Boolean)
    .join('\n')
  try {
    const r = await api.messages.create({
      model: k.model,
      max_tokens: 2000,
      output_config: { effort: 'low' },
      system:
        'Piszesz opisy produktów do sklepu internetowego po polsku, z polskimi znakami. Tylko fakty wynikające z podanych danych; nie wymyślaj składu, wymiarów, certyfikatów ani parametrów, których nie podano. 2–4 krótkie akapity, bez nagłówków, bez list punktowanych, bez długich myślników, bez cen. Zwróć sam tekst opisu.',
      messages: [{ role: 'user', content: `Dane produktu:\n${dane}\n\nNapisz opis produktu.` }],
    })
    if (r.stop_reason === 'refusal') return { ok: false, error: 'Dostawca AI odmówił napisania opisu dla tego produktu. Wpisz opis ręcznie.' }
    const opis = r.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
      .trim()
    const kosztGr = kosztAiGrosze(k.model, r.usage.input_tokens, r.usage.output_tokens)
    // błąd zapisu kosztu trafia do logu i historii, opis i tak wraca (koszt u dostawcy już poniesiony)
    await zapiszZuzycieAi(db, { feature: AI_FEATURE, model: k.model, inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens, costGrosze: cred.billedToBalance ? kosztGr : 0 })
    if (!opis) return { ok: false, error: 'Dostawca AI nie zwrócił opisu. Spróbuj jeszcze raz.' }
    return { ok: true, opis: opis.slice(0, 20_000) }
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return { ok: false, error: 'Klucz dostawcy AI jest nieprawidłowy. Sprawdź go u administratora instalacji.' }
    if (e instanceof Anthropic.RateLimitError) return { ok: false, error: 'Dostawca AI chwilowo ogranicza zapytania. Spróbuj za minutę.' }
    if (e instanceof Anthropic.APIError) return { ok: false, error: `Dostawca AI odpowiedział błędem (${e.status ?? 'brak połączenia'}). Spróbuj później.` }
    throw e
  }
}
