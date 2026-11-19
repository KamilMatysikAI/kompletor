// Adres serwera w kodzie instalacyjnym. Bez zależności serwerowych, żeby dało się go
// sprawdzić testem jednostkowym i użyć w akcji panelu.

const HOSTY_LOKALNE = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Ostrzeżenie dla panelu, gdy kod instalacyjny wskazuje serwer bez https poza komputerem lokalnym: token stanowiska
 * szedłby siecią otwartym tekstem, a instalator agenta (0.2.0+) taki kod odrzuci. null = adres w porządku.
 */
export function ostrzezenieAdresuSerwera(serwer: string): string | null {
  let u: URL
  try {
    u = new URL(serwer)
  } catch {
    return 'Nie udało się ustalić adresu serwera. Otwórz panel pod jego zwykłym adresem (https://…) i utwórz token ponownie.'
  }
  if (u.protocol === 'https:' || HOSTY_LOKALNE.has(u.hostname)) return null
  return (
    `Panel jest otwarty bez https (${u.origin}), więc kod wskazuje adres http:// i instalator go odrzuci, bo token ` +
    'szedłby siecią otwartym tekstem. Otwórz panel pod adresem https://… i kliknij „Nowy token” jeszcze raz.'
  )
}
