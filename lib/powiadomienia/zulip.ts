// Transport Zulip: jedna wiadomość do strumienia. `POST <site>/api/v1/messages`, Basic Auth
// `email-bota:klucz`, formularz `type=stream`, `to`, `topic`, `content`. Odpowiedź: JSON `{ result: "success", id }`
// albo `{ result: "error", msg, code }`; 429 = limit (nagłówek Retry-After). Kształt z dokumentacji Zulipa
// (zulip.com/api/send-message) według stanu wiedzy — do potwierdzenia na żywo (raport).
// Klucz nie trafia do wyniku, błędów ani logów: wynik zawiera tylko kod HTTP i kod błędu Zulipa.
// Bez ponawiania tutaj: o ponowieniu decyduje wysyłka (lib/powiadomienia/wysylka.ts), bo Zulip nie ma klucza
// idempotencji, a niepewny wynik (timeout po wysłaniu) nie może dać drugiej wiadomości.
import type { FetchLike } from '../zrodla/http'

export const ZULIP_TIMEOUT_MS = 15_000

export interface ZulipTarget {
  /** `https://host` po `parseZulipSite`. */
  site: string
  botEmail: string
  apiKey: string
}

export interface ZulipMessage {
  stream: string
  topic: string
  content: string
}

export type ZulipResult =
  | { kind: 'SENT'; messageId: number | null }
  /** Na pewno nieprzyjęte (429, 5xx przed przyjęciem, brak połączenia) — wolno ponowić. */
  | { kind: 'RETRY'; error: string; retryAfterMs: number | null }
  /** Żądanie mogło dojść (timeout, zerwane połączenie, 504) — bez ponowienia. */
  | { kind: 'UNCERTAIN'; error: string }
  /** 401/403: klucz albo bot do poprawy — wysyłka firmy wyłączana do naprawy konfiguracji. */
  | { kind: 'AUTH'; error: string }
  /** Inna odmowa (np. 400: strumień nie istnieje, bot bez dostępu) — bez ponowienia. */
  | { kind: 'REJECTED'; error: string }

/** Kody błędów sieci, przy których połączenie nie powstało, więc żądanie na pewno nie doszło. */
const NOT_CONNECTED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_DNS_RESOLVE_FAILED'])

function errorCode(e: unknown): string | null {
  for (let cur: unknown = e, i = 0; cur && typeof cur === 'object' && i < 4; cur = (cur as { cause?: unknown }).cause, i++) {
    const code = (cur as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return null
}

function zulipCode(body: unknown): string {
  const c = body && typeof body === 'object' ? (body as { code?: unknown }).code : undefined
  return typeof c === 'string' && /^[A-Z_]{1,60}$/.test(c) ? ` ${c}` : ''
}

function retryAfterMs(h: string | null): number | null {
  if (!h) return null
  const s = Number(h)
  return Number.isFinite(s) && s >= 0 ? Math.min(Math.ceil(s * 1000), 3600_000) : null
}

export async function sendZulipMessage(t: ZulipTarget, m: ZulipMessage, fetchImpl: FetchLike, timeoutMs = ZULIP_TIMEOUT_MS): Promise<ZulipResult> {
  const body = new URLSearchParams({ type: 'stream', to: m.stream, topic: m.topic, content: m.content })
  const auth = Buffer.from(`${t.botEmail}:${t.apiKey}`, 'utf8').toString('base64')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetchImpl(`${t.site}/api/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Kompletor-powiadomienia' },
      body: body.toString(),
      // przekierowanie mogłoby wyprowadzić żądanie (z kluczem) poza listę hostów
      redirect: 'error',
      signal: ctrl.signal,
    })
  } catch (e) {
    clearTimeout(timer)
    const code = errorCode(e)
    if (code && NOT_CONNECTED.has(code)) return { kind: 'RETRY', error: `brak połączenia (${code})`, retryAfterMs: null }
    if (ctrl.signal.aborted) return { kind: 'UNCERTAIN', error: `brak odpowiedzi w ${Math.round(timeoutMs / 1000)} s — wiadomość mogła dojść` }
    return { kind: 'UNCERTAIN', error: `błąd połączenia${code ? ` (${code})` : ''} — wiadomość mogła dojść` }
  }
  let json: unknown = null
  try {
    json = await res.json()
  } catch {
    // treść nie-JSON (np. strona błędu pośrednika) albo timeout przy czytaniu treści — liczy się kod HTTP
  } finally {
    clearTimeout(timer)
  }
  const s = res.status
  if (s === 200) {
    const ok = json && typeof json === 'object' && (json as { result?: unknown }).result === 'success'
    if (!ok) return { kind: 'UNCERTAIN', error: 'HTTP 200 bez potwierdzenia przyjęcia' }
    const id = (json as { id?: unknown }).id
    return { kind: 'SENT', messageId: typeof id === 'number' ? id : null }
  }
  const err = `HTTP ${s}${zulipCode(json)}`
  if (s === 401 || s === 403) return { kind: 'AUTH', error: err }
  if (s === 429) return { kind: 'RETRY', error: err, retryAfterMs: retryAfterMs(res.headers.get('retry-after')) }
  // 504 = pośrednik nie doczekał się odpowiedzi serwera, który mógł wiadomość przyjąć
  if (s === 504) return { kind: 'UNCERTAIN', error: err }
  if (s >= 500) return { kind: 'RETRY', error: err, retryAfterMs: retryAfterMs(res.headers.get('retry-after')) }
  return { kind: 'REJECTED', error: err }
}
