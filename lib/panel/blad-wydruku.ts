// błąd wydruku po ludzku. Formularz „Drukuj karty zamówień” i link „Drukuj listę wysyłkową” otwierają
// nową kartę przeglądarki, więc odpowiedź błędu (400, 401, 403, 404, 409, 422) dostaje osoba z magazynu albo biura.
// Przeglądarka (nagłówek Accept z text/html) dostaje stronę w wyglądzie panelu: tytuł, zdanie, co zrobić dalej,
// „Wróć do zamówień” i „Zamknij kartę”. Wywołanie z kodu (`fetch`, Accept bez text/html) dostaje JSON `{ error }` jak
// dotąd — kontrakt dla kodu bez zmian. Treść komunikatu zawsze escapowana (numery zamówień pochodzą z kanałów).

/** Przeglądarka otwierająca adres w karcie (Accept z text/html), a nie `fetch` z kodu. */
export function chceStronyHtml(req: Request): boolean {
  return (req.headers.get('accept') ?? '').toLowerCase().includes('text/html')
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]!)

export interface BladWydruku {
  status: number
  /** Zdanie dla osoby nietechnicznej; trafia też do JSON `{ error }`. */
  komunikat: string
  /** Tytuł strony HTML, np. „Nie udało się wydrukować kart”. */
  tytul: string
  /** Dokąd prowadzi „Wróć do …”. */
  powrot?: { href: string; etykieta: string }
}

/** Strona HTML błędu wydruku (samodzielna: karta z formularza nie ma układu panelu). */
export function stronaBleduWydruku(b: BladWydruku): string {
  const powrot = b.powrot ?? { href: '/zamowienia', etykieta: 'Wróć do zamówień' }
  return `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(b.tytul)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #f3f4f6; color: #1a1e2b; font: 400 15px/1.5 'Public Sans', 'Segoe UI', system-ui, sans-serif; }
  main { max-width: 640px; margin: 48px auto; padding: 0 16px; }
  .karta { background: #fff; border: 1px solid #e1e3e8; border-left: 4px solid #a8251b; border-radius: 10px; padding: 24px; }
  h1 { font-size: 22px; line-height: 1.25; margin: 0 0 12px; letter-spacing: -0.01em; }
  p { margin: 0 0 12px; overflow-wrap: anywhere; }
  .dalej { color: #4a5060; font-size: 14px; }
  .przyciski { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 20px; }
  .btn { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 8px 16px; border-radius: 8px; border: 1px solid #c9ccd4; background: #fff; color: #1a1e2b; font-weight: 600; font-size: 14px; font-family: inherit; text-decoration: none; cursor: pointer; }
  .btn:hover { background: #f8f8fa; }
  /* kolory jak w panelu (app/ui/tokeny.css): przycisk główny w złocie z atramentowym tekstem */
  .btn.primary { background: #f5b700; border-color: #d99e00; color: #1a1e2b; }
  .btn.primary:hover { background: #e3a700; }
  :focus-visible { outline: 3px solid #2456c8; outline-offset: 2px; }
  @media (max-width: 480px) { main { margin: 24px auto; } .karta { padding: 18px; } .btn { flex: 1 1 100%; } }
</style>
</head>
<body>
<main>
  <div class="karta" role="alert">
    <h1>${esc(b.tytul)}</h1>
    <p>${esc(b.komunikat)}</p>
    <p class="dalej">Nic nie zostało wydrukowane ani zmienione w zamówieniach.</p>
    <div class="przyciski">
      <a class="btn primary" href="${esc(powrot.href)}">${esc(powrot.etykieta)}</a>
      <button class="btn" type="button" onclick="window.close()">Zamknij kartę</button>
    </div>
  </div>
</main>
</body>
</html>
`
}

/** Odpowiedź błędu wydruku: strona HTML dla przeglądarki, JSON `{ error }` dla kodu; status ten sam. */
export function odpowiedzBleduWydruku(req: Request, b: BladWydruku): Response {
  if (!chceStronyHtml(req)) return Response.json({ error: b.komunikat }, { status: b.status })
  return new Response(stronaBleduWydruku(b), {
    status: b.status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Komunikaty dostępu po ludzku (odpowiedzi requirePermissionApi mają krótki JSON dla kodu). */
export function komunikatDostepu(status: number, czynnosc: string): string {
  if (status === 401) return `Sesja wygasła albo nie jesteś zalogowany. Zaloguj się w panelu i ${czynnosc} jeszcze raz.`
  if (status === 403) return `Najpierw zmień hasło startowe (Ustawienia → Zespół i dostęp → Zmiana hasła), potem ${czynnosc} jeszcze raz.`
  return `Twoje konto nie ma dostępu do tego wydruku. Poproś osobę zarządzającą firmą w panelu o rolę z dostępem do pakowania.`
}

/**
 * Odpowiedź odmowy z requirePermissionApi (401/403/404 jako JSON): dla przeglądarki zamienia ją na stronę HTML z tym
 * samym statusem, dla kodu zwraca bez zmian.
 */
export function odmowaDostepu(req: Request, odp: Response, tytul: string, czynnosc: string): Response {
  if (!chceStronyHtml(req)) return odp
  const powrot = odp.status === 401 ? { href: '/logowanie', etykieta: 'Zaloguj się' } : undefined
  return odpowiedzBleduWydruku(req, { status: odp.status, tytul, komunikat: komunikatDostepu(odp.status, czynnosc), powrot })
}
