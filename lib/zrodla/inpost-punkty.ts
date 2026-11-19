// Publiczne API punktów InPost: paczkomaty i PaczkoPunkty do wyszukiwarki na karcie zamówienia. TYLKO
// ODCZYT i tylko jedna ścieżka (`GET /v1/points` na stałym adresie api-pl-points.easypack24.net), bez tokenu firmy:
// lista punktów jest publiczna (ta sama, z której korzysta mapa „Znajdź paczkomat”). Nic nie tworzy i nie kosztuje.
// Każda inna metoda albo ścieżka = ReadOnlyViolation przed wysyłką. Przekierowania odrzucone (`redirect: 'error'`).
import { fetchWithTimeout, ReadOnlyViolation, SourceError, type FetchLike } from './http'

export const INPOST_PUNKTY_URL = 'https://api-pl-points.easypack24.net'
const SCIEZKA = '/v1/points'
/** Parametry zapytania, które wysyłamy (reszta odrzucona, żeby nikt nie dokleił niczego do adresu). */
const PARAMETRY = new Set(['name', 'city', 'post_code', 'relative_post_code', 'type', 'status', 'per_page', 'page', 'fields'])

export class InpostPunktyError extends SourceError {
  constructor(message: string, retryable: boolean) {
    super(message, retryable)
    this.name = 'InpostPunktyError'
  }
}

export function assertPunktyReadOnly(method: string, path: string, query: Record<string, string>): void {
  if (method.toUpperCase() !== 'GET' || path !== SCIEZKA) throw new ReadOnlyViolation(`InPost punkty: ${method.toUpperCase()} „${path}” nie jest odczytem listy punktów`)
  for (const k of Object.keys(query)) if (!PARAMETRY.has(k)) throw new ReadOnlyViolation(`InPost punkty: nieznany parametr „${k}”`)
}

/** Jedno zapytanie GET o listę punktów (bez ponawiania: wyszukiwarka pokaże błąd, osoba kliknie jeszcze raz). */
export async function pobierzPunkty(query: Record<string, string>, fetchImpl: FetchLike = fetch, timeoutMs = 10_000): Promise<unknown> {
  assertPunktyReadOnly('GET', SCIEZKA, query)
  const url = `${INPOST_PUNKTY_URL}${SCIEZKA}?${new URLSearchParams(query).toString()}`
  let res: Response
  try {
    res = await fetchWithTimeout(fetchImpl, url, { method: 'GET', redirect: 'error', headers: { Accept: 'application/json' } }, timeoutMs)
  } catch (e) {
    throw new InpostPunktyError(`InPost punkty: ${e instanceof SourceError ? e.message : 'brak połączenia'}`, true)
  }
  if (res.status === 429 || res.status >= 500) throw new InpostPunktyError(`InPost punkty: HTTP ${res.status}`, true)
  if (!res.ok) throw new InpostPunktyError(`InPost punkty: HTTP ${res.status}`, false)
  const text = await res.text()
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new InpostPunktyError('InPost punkty: nieczytelna odpowiedź', false)
  }
}
