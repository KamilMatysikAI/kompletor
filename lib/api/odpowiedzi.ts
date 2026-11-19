// Odpowiedzi JSON API dla systemów zewnętrznych: zawsze `no-store` (stany i statusy się zmieniają, a
// odpowiedź nie może zostać w pamięci pośrednika), błąd jako `{ error, ...szczegóły }` z tekstem po polsku.

const BASE_HEADERS = { 'Cache-Control': 'no-store' }

export function apiJson(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...BASE_HEADERS, ...headers } })
}

export function apiError(status: number, error: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response {
  return apiJson({ error, ...extra }, status, headers)
}

/** Błąd wejścia z miejscem, które go dało (np. `pozycje[1].ilosc`). Trasy zamieniają go na 400. */
export class ApiInputError extends Error {
  constructor(
    message: string,
    readonly field?: string,
    readonly status = 400,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

export function inputErrorResponse(e: ApiInputError): Response {
  return apiError(e.status, e.message, { ...(e.field ? { pole: e.field } : {}), ...e.extra })
}
