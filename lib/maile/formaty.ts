// Formatowanie wartości do maili (kwoty, daty, odmiana) i ucieczka HTML. Czyste funkcje, bez Intl dla kwot:
// 2026-10-25 własny format kwot zamiast Intl.NumberFormat, bo spacje w wyniku Intl zależą od wersji ICU
// (U+00A0 albo U+202F), a podglądy i testy mają wyglądać tak samo na każdej maszynie.

export class BladSzablonu extends Error {
  readonly bledy: string[]
  constructor(bledy: string[]) {
    super(bledy.length === 1 ? bledy[0]! : `błędy szablonu:\n- ${bledy.join('\n- ')}`)
    this.name = 'BladSzablonu'
    this.bledy = bledy
  }
}

const ZNAKI_HTML: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** Ucieczka do treści i atrybutów HTML. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (z) => ZNAKI_HTML[z]!)
}

const NBSP = ' '

/** Kwota w groszach → „1 234,50 zł” (spacje niełamliwe, żeby kwota nie rozjechała się na dwie linie). */
export function formatujKwote(kwotaGr: number, waluta = 'PLN'): string {
  if (!Number.isSafeInteger(kwotaGr)) throw new BladSzablonu([`kwota musi być liczbą całkowitą groszy, jest ${kwotaGr}`])
  if (!/^[A-Z]{3}$/.test(waluta)) throw new BladSzablonu([`niepoprawny kod waluty „${waluta}”`])
  const znak = kwotaGr < 0 ? '-' : ''
  const abs = Math.abs(kwotaGr)
  const zl = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP)
  const gr = String(abs % 100).padStart(2, '0')
  return `${znak}${zl},${gr}${NBSP}${waluta === 'PLN' ? 'zł' : waluta}`
}

const MIESIACE = [
  'stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca',
  'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia',
]

function czesciWarszawa(t: Date): { rok: number; miesiac: number; dzien: number; godzina: string; minuta: string } {
  if (Number.isNaN(t.getTime())) throw new BladSzablonu(['niepoprawna data'])
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(t)
  const p = (typ: string) => parts.find((x) => x.type === typ)!.value
  return { rok: Number(p('year')), miesiac: Number(p('month')), dzien: Number(p('day')), godzina: p('hour'), minuta: p('minute') }
}

/** „30 października 2026” w strefie Europe/Warsaw. */
export function formatujDate(t: Date): string {
  const c = czesciWarszawa(t)
  return `${c.dzien} ${MIESIACE[c.miesiac - 1]} ${c.rok}`
}

/** „30 października 2026, 14:05” w strefie Europe/Warsaw. */
export function formatujDateCzas(t: Date): string {
  const c = czesciWarszawa(t)
  return `${formatujDate(t)}, ${c.godzina}:${c.minuta}`
}

/**
 * Rachunek do przelewu w czytelnych grupach: NRB (26 cyfr) → „12 3456 7890 1234 5678 9012 3456”, IBAN → „PL12 3456 …”.
 * Spacje i małe litery wolno; inny kształt = błąd (sumę kontrolną sprawdza zapis ustawień firmy).
 */
export function formatujRachunek(rachunek: string): string {
  const s = String(rachunek ?? '').replace(/\s/g, '').toUpperCase()
  if (/^\d{26}$/.test(s)) return `${s.slice(0, 2)} ${s.slice(2).replace(/(\d{4})(?=\d)/g, '$1 ')}`
  if (/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return s.replace(/(.{4})(?=.)/g, '$1 ')
  throw new BladSzablonu(['niepoprawny numer rachunku do przelewu'])
}

/** Dopełniacz do „w ciągu …”: 1 → „1 dnia roboczego”, pozostałe → „N dni roboczych”. */
export function wCiaguDniRoboczych(n: number): string {
  if (!Number.isInteger(n) || n < 1) throw new BladSzablonu([`liczba dni roboczych musi być całkowita i dodatnia, jest ${n}`])
  return n === 1 ? '1 dnia roboczego' : `${n} dni roboczych`
}

/** Adres http(s); inne schematy (javascript:, data:) to błąd, bo adres trafia do href/src. */
export function sprawdzUrl(url: string, gdzie: string): string {
  const u = url.trim()
  let ok = false
  try {
    const p = new URL(u)
    ok = p.protocol === 'https:' || p.protocol === 'http:'
  } catch {
    ok = false
  }
  if (!ok) throw new BladSzablonu([`${gdzie}: niepoprawny adres „${u}” (dozwolone http i https)`])
  return u
}

export function poprawnyEmail(email: string): boolean {
  return /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/.test(email)
}

/** Kolor tekstu (czarny albo biały) czytelny na tle `hex` (#rrggbb), wg luminancji WCAG. */
export function kolorTekstuNa(hex: string): '#ffffff' | '#000000' {
  return luminancja(hex) > 0.179 ? '#000000' : '#ffffff'
}

/** Kontrast WCAG koloru z białym tłem. */
export function kontrastZBialym(hex: string): number {
  return 1.05 / (luminancja(hex) + 0.05)
}

function luminancja(hex: string): number {
  const kanal = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * kanal(1) + 0.7152 * kanal(3) + 0.0722 * kanal(5)
}
