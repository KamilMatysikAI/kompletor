// Nazwa ciasteczka sesji — osobny plik bez zależności, żeby proxy (Next) nie ciągnął kodu bazy.
// W produkcji prefiks __Host- (przeglądarka przyjmie je tylko z Secure, path=/ i bez Domain — utwardzenie z
// przeglądu, drobne 11). Lokalnie i w testach po http (COOKIE_SECURE=false) zwykła nazwa.
export const SESSION_COOKIE =
  process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== 'false' ? '__Host-kompletor_sesja' : 'kompletor_sesja'

// ścieżka żądania, którą proxy wpisuje do nagłówka żądania (nadpisując to, co przysłał klient), żeby
// requireSession (lib/panel/kontekst.ts) wiedział, że jest na ekranie zmiany hasła — layout panelu woła go na każdej
// stronie, więc bez tego przekierowanie na /ustawienia/haslo wróciłoby do siebie samego.
/** Atrybuty ciasteczka sesji: jedno źródło dla logowania, zaproszenia i kreatora /start. */
export function sessionCookieOpts(expires: Date) {
  return { httpOnly: true, sameSite: 'lax' as const, secure: SESSION_COOKIE.startsWith('__Host-'), path: '/', expires }
}

export const PATH_HEADER = 'x-kompletor-sciezka'
export const PASSWORD_PATH = '/ustawienia/haslo'
