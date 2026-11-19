// Role drukarek i routing stanowiska. Bez Prismy i bez `server-only` — z tych samych funkcji korzystają
// trasy, ekran Ustawienia → Druk i komponenty klienckie.
//
// Rola to tekst według wzoru agenta (agent-druku/src/kontrakt.ts, WZOR_ROLI): `A4`, `A4_2`…, `TERMICZNA_1`,
// `TERMICZNA_2`, `TERMICZNA_3`… Pakiety agenta i serwera są osobne, więc wzór jest powtórzony tutaj; zgodność
// sprawdza test obiegu (tests/druk-obieg.integration.test.ts, prawdziwy kod agenta).
// Zasada zgodności wersji: zlecenie idzie wyłącznie na rolę z OSTATNIEGO raportu stanu stanowiska — agent 0.1.0
// (trzy stałe role) nigdy nie dostanie roli, której nie zna.

export const WZOR_ROLI = /^A4(_[0-9]{1,2})?$|^TERMICZNA_[0-9]{1,2}$/
export const WZOR_KODU_STANOWISKA = /^[A-Za-z0-9_-]{1,50}$/

/**
 * kod stanowiska z nazwy (litery bez polskich znaków, cyfry, „-”), np. „Pakowanie przy oknie” →
 * „pakowanie-przy-oknie”. Pusta albo bez liter i cyfr = „stanowisko”. Najwyżej 46 znaków (zapas na „-NN”).
 */
export function kodZNazwy(nazwa: string): string {
  const k = nazwa
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 46)
    .replace(/-+$/, '')
  return k || 'stanowisko'
}

export const TYPY_ZLECEN = ['karta', 'lista', 'spis', 'etykieta'] as const
export type TypZlecenia = (typeof TYPY_ZLECEN)[number]

export const TYP_LABEL: Record<TypZlecenia, string> = { karta: 'Karty zamówień', lista: 'Lista wysyłkowa', spis: 'Spis produktów', etykieta: 'Etykieta' }

/** Domyślny routing nowego stanowiska: papiery na A4, etykiety na pierwszą termiczną. */
export const ROUTING_DOMYSLNY: Record<TypZlecenia, string> = { karta: 'A4', lista: 'A4', spis: 'A4', etykieta: 'TERMICZNA_1' }

/** Po tylu minutach bez raportu stanu agent „nie działa” (README agenta, sekcja 4: ~3 minuty). */
export const AGENT_MARTWY_PO_MS = 3 * 60_000

export const jestRola = (v: unknown): v is string => typeof v === 'string' && WZOR_ROLI.test(v)
export const jestTermiczna = (rola: string) => rola.startsWith('TERMICZNA_')
export const jestTypZlecenia = (v: unknown): v is TypZlecenia => typeof v === 'string' && (TYPY_ZLECEN as readonly string[]).includes(v)

/** Kolejność ról jak u agenta: A4, A4_2…, potem termiczne po numerze. */
export function porownajRole(a: string, b: string): number {
  const klucz = (r: string) => [jestTermiczna(r) ? 1 : 0, Number(/_(\d+)$/.exec(r)?.[1] ?? (jestTermiczna(r) ? 0 : 1))] as const
  const [ta, na] = klucz(a)
  const [tb, nb] = klucz(b)
  return ta - tb || na - nb || (a < b ? -1 : a > b ? 1 : 0)
}

export function opisRoli(rola: string): string {
  if (rola === 'A4') return 'A4'
  if (jestTermiczna(rola)) return `Termiczna ${rola.slice('TERMICZNA_'.length)}`
  return `A4 nr ${rola.slice(3)}`
}

export type StanDrukarki = 'DOSTEPNA' | 'OFFLINE' | 'BLAD'

/** Drukarka z ostatniego raportu stanu (RaportStanu.drukarki), po walidacji. */
export interface DrukarkaZRaportu {
  rola: string
  nazwa: string
  stan: StanDrukarki
  komunikat?: string
  zleceniaWKolejce: number | null
}

/** Odczyt `PrintStation.printers` (Json z bazy) — tylko poprawne wpisy, w kolejności ról. */
export function drukarkiZBazy(v: unknown): DrukarkaZRaportu[] {
  if (!Array.isArray(v)) return []
  const out: DrukarkaZRaportu[] = []
  for (const d of v) {
    if (typeof d !== 'object' || d === null) continue
    const o = d as Record<string, unknown>
    if (!jestRola(o.rola) || typeof o.nazwa !== 'string' || !['DOSTEPNA', 'OFFLINE', 'BLAD'].includes(o.stan as string)) continue
    out.push({
      rola: o.rola,
      nazwa: o.nazwa,
      stan: o.stan as StanDrukarki,
      ...(typeof o.komunikat === 'string' && o.komunikat ? { komunikat: o.komunikat } : {}),
      zleceniaWKolejce: typeof o.zleceniaWKolejce === 'number' ? o.zleceniaWKolejce : null,
    })
  }
  return out.sort((a, b) => porownajRole(a.rola, b.rola))
}

/** Role z ostatniego raportu stanowiska — tylko na nie wolno zlecać. */
export function roleZRaportu(printers: unknown): string[] {
  return drukarkiZBazy(printers).map((d) => d.rola)
}

/** Id stanowiska (cuid) w przypisaniu i w treści żądań panelu. */
export const WZOR_ID_STANOWISKA = /^[a-z0-9]{1,40}$/i

/**
 * przypisanie rodzaju wydruku do drukarki. `stanowisko` brak = drukarka tego samego komputera (stary kształt
 * `routing`: sama rola), podane = drukarka innego stanowiska tej samej firmy (zlecenie trafia do jego kolejki).
 */
export interface Przypisanie {
  rola: string
  stanowisko?: string
}

/**
 * `PrintStation.routing` (Json) → przypisanie na każdy rodzaj wydruku. Wartość: rola (`"A4"`, stary kształt) albo
 * `{ "stanowisko": "<id>", "rola": "A4" }`. Brakujące i niepoprawne wpisy = domyślna rola na własnym komputerze;
 * wskazanie samego siebie = własna drukarka (bez `stanowisko`).
 */
export function przypisaniaStanowiska(v: unknown, wlasneId?: string): Record<TypZlecenia, Przypisanie> {
  const o = typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  const out = {} as Record<TypZlecenia, Przypisanie>
  for (const t of TYPY_ZLECEN) {
    const w = o[t]
    if (jestRola(w)) out[t] = { rola: w }
    else if (typeof w === 'object' && w !== null && !Array.isArray(w) && jestRola((w as Record<string, unknown>).rola)) {
      const x = w as { rola: string; stanowisko?: unknown }
      const inne = typeof x.stanowisko === 'string' && WZOR_ID_STANOWISKA.test(x.stanowisko) && x.stanowisko !== wlasneId ? x.stanowisko : undefined
      out[t] = inne ? { rola: x.rola, stanowisko: inne } : { rola: x.rola }
    } else out[t] = { rola: ROUTING_DOMYSLNY[t] }
  }
  return out
}

/** Przypisania → wartość do zapisu w `routing`: własne jako sama rola (stary kształt), inne jako obiekt. */
export function routingDoZapisu(p: Record<TypZlecenia, Przypisanie>): Record<TypZlecenia, string | { stanowisko: string; rola: string }> {
  const out = {} as Record<TypZlecenia, string | { stanowisko: string; rola: string }>
  for (const t of TYPY_ZLECEN) out[t] = p[t].stanowisko ? { stanowisko: p[t].stanowisko!, rola: p[t].rola } : p[t].rola
  return out
}

/** `PrintStation.routing` (Json) → sama rola na każdy rodzaj (bez wskazania komputera); szczegóły: `przypisaniaStanowiska`. */
export function routingStanowiska(v: unknown): Record<TypZlecenia, string> {
  const p = przypisaniaStanowiska(v)
  return Object.fromEntries(TYPY_ZLECEN.map((t) => [t, p[t].rola])) as Record<TypZlecenia, string>
}

/** Wartość pola formularza „Co na jakiej drukarce”: `rola` (ten komputer) albo `<id stanowiska>:<rola>`. */
export function wartoscPrzypisania(p: Przypisanie): string {
  return p.stanowisko ? `${p.stanowisko}:${p.rola}` : p.rola
}

export function parsujWartoscPrzypisania(v: unknown): Przypisanie | null {
  if (typeof v !== 'string') return null
  if (jestRola(v)) return { rola: v }
  const m = /^([a-z0-9]{1,40}):(.+)$/i.exec(v)
  return m && jestRola(m[2]) ? { stanowisko: m[1]!, rola: m[2]! } : null
}

/**
 * Rola dla typu zlecenia według routingu i ostatniego raportu. Rola spoza raportu = czytelny komunikat (agent jej
 * nie zna albo drukarki nie przypisano), zlecenie nie powstaje.
 */
export function rolaDlaTypu(
  stanowisko: { name: string; routing: unknown; printers: unknown; lastReportAt: Date | null },
  typ: TypZlecenia,
): { rola: string } | { blad: string } {
  const rola = routingStanowiska(stanowisko.routing)[typ]
  if (!stanowisko.lastReportAt) return { blad: `Stanowisko „${stanowisko.name}” jeszcze nie zgłosiło drukarek: program druku nie był uruchomiony na tym komputerze albo nie łączy się z serwerem. Wybierz drukarkę innego komputera w Ustawienia → Wysyłka i druk → Druk albo zainstaluj program na tym komputerze.` }
  const role = roleZRaportu(stanowisko.printers)
  if (!role.includes(rola))
    return {
      blad: `Stanowisko „${stanowisko.name}” nie ma drukarki ${opisRoli(rola)} (${rola}) w ostatnim raporcie programu druku. Zmień przypisanie w Ustawienia → Wysyłka i druk → Druk albo przypisz drukarkę na komputerze (Zainstaluj.cmd).`,
    }
  return { rola }
}

/** stanowisko, na którego drukarkę wskazuje przypisanie innego stanowiska (pola z bazy). */
export interface StanowiskoCelu {
  id: string
  name: string
  disabledAt: Date | null
  maToken: boolean
  printers: unknown
  lastReportAt: Date | null
}

/** „Komputer główny, A4” — gdzie wyjdzie wydruk (komunikaty po kliknięciu i błędy). */
export const opisCelu = (stanowisko: string, rola: string) => `${stanowisko}, ${opisRoli(rola)}`

/**
 * Czy wolno zlecić na drukarkę innego komputera. Inaczej niż na własnym (zlecenie czeka w kolejce do 8 godzin):
 * pakujący nie widzi tamtego komputera, więc wyłączony, bez tokenu albo milczący komputer = zlecenie nie powstaje,
 * a komunikat nazywa komputer i drukarkę. Zwraca komunikat albo null.
 */
export function bladCelu(zrodlo: string, typ: TypZlecenia, cel: StanowiskoCelu | null, rola: string, now: Date): string | null {
  const co = `${TYP_LABEL[typ]} ze stanowiska „${zrodlo}” idą na drukarkę ${opisRoli(rola)}`
  const zmien = 'Zmień przypisanie w Ustawienia → Wysyłka i druk → Druk.'
  if (!cel) return `${co} na komputerze, którego nie ma w tej firmie. ${zmien}`
  const gdzie = `${co} komputera „${cel.name}”`
  if (cel.disabledAt) return `${gdzie}, a to stanowisko jest wyłączone. Włącz je albo zmień przypisanie w Ustawienia → Wysyłka i druk → Druk.`
  if (!cel.maToken) return `${gdzie}, a program druku na tym komputerze nie ma tokenu. Utwórz token w Ustawienia → Wysyłka i druk → Druk.`
  if (!cel.lastReportAt) return `${gdzie}, a program druku na tym komputerze jeszcze się nie zgłosił.`
  if (!agentDziala(cel.lastReportAt, now))
    return `${gdzie}, a ten komputer nie odpowiada od ${Math.max(0, Math.floor((now.getTime() - cel.lastReportAt.getTime()) / 60_000))} min (wyłączony, bez internetu albo program druku nie działa).`
  if (!roleZRaportu(cel.printers).includes(rola)) return `${gdzie}, a ten komputer nie zgłasza takiej drukarki (${rola}). ${zmien}`
  return null
}

/** Czy agent stanowiska działa: raport stanu w ostatnich 3 minutach. */
export function agentDziala(lastReportAt: Date | null, now: Date): boolean {
  return !!lastReportAt && now.getTime() - lastReportAt.getTime() < AGENT_MARTWY_PO_MS
}
