// Czytelny komunikat błędu z odpowiedzi KSeF. Pochodzenie: nasz klient KSeF z DewFlow
// (lib/ksef/client.ts, `readKsefError`). KSeF zwraca ExceptionResponse albo Problem Details, zależnie od nagłówka
// X-Error-Format. Komunikat trafia do `KsefInvoiceDraft.lastError`, więc jest przycinany i nie zawiera treści żądania.
export async function readKsefError(res: Response): Promise<string> {
  const raw = await res.text().catch(() => '')
  try {
    const body = JSON.parse(raw)
    const detail = body?.exception?.exceptionDetailList?.[0]
    if (detail) {
      const details = Array.isArray(detail.details) && detail.details.length > 0 ? ` (${detail.details.join('; ')})` : ''
      return `[${detail.exceptionCode}] ${detail.exceptionDescription}${details}`.slice(0, 500)
    }
    if (body?.errors?.[0]) {
      const err = body.errors[0]
      const details = Array.isArray(err.details) && err.details.length > 0 ? ` (${err.details.join('; ')})` : ''
      return `[${err.code}] ${err.description}${details}`.slice(0, 500)
    }
    if (typeof body?.detail === 'string') return body.detail.slice(0, 500)
  } catch {
    // treść nie jest JSON-em: surowy tekst niżej
  }
  return raw.slice(0, 300) || res.statusText
}
