// Stan punktu odbioru InPost (paczkomat, PaczkoPunkt) przez `GET /v1/points/:name`. Dla przyszłego trybu
// PRACA i CLI, nie dla `prepareShipment` (kontrakt: bez sieci). Wynik ma tylko stan punktu: bez danych osobowych
// i bez opisu lokalizacji. Kształt odpowiedzi [NIEPEWNE]: nieczytelne pole to błąd, nigdy cicha wartość domyślna.
import { UnreadableDataError } from '../adaptery/kontrakt'
import { SlidingLimiter } from '../auth/limiter'
import { INPOST_ID_RE, type InpostReadOnly } from '../zrodla/inpost'

export interface StanPunktu {
  nazwa: string
  istnieje: boolean
  /** true = „Operating”; false = znany stan niedziałający; null = stan nieznany (do sprawdzenia przez człowieka). */
  dziala: boolean | null
  status: string | null
  /** Np. parcel_locker, pop (pole `type` bywa tekstem albo listą). */
  typy: string[]
  /** Czy punkt przyjmuje pobranie (`payment_available`); null = API nie podało. */
  pobranie: boolean | null
}

const DZIALA = new Set(['Operating'])
const NIE_DZIALA = new Set(['NonOperating', 'Disabled', 'Created', 'Overloaded', 'Removed'])

export async function sprawdzPunkt(api: Pick<InpostReadOnly, 'get'>, nazwa: string): Promise<StanPunktu> {
  const n = nazwa.trim()
  if (!INPOST_ID_RE.test(n)) throw new Error('Zła nazwa punktu InPost (litery, cyfry, „-” i „_”)')
  const r = await api.get<unknown>(`/v1/points/${n}`, {}, { notFound: 'null' })
  if (r === null) return { nazwa: n, istnieje: false, dziala: false, status: null, typy: [], pobranie: null }
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new UnreadableDataError('nieczytelna odpowiedź punktu InPost')
  const x = r as Record<string, unknown>
  if (typeof x['name'] !== 'string' || x['name'].toUpperCase() !== n.toUpperCase()) throw new UnreadableDataError('odpowiedź punktu InPost bez nazwy albo z inną nazwą')
  const status = x['status']
  if (status !== undefined && typeof status !== 'string') throw new UnreadableDataError('nieczytelny stan punktu InPost')
  const type = x['type']
  const typy = typeof type === 'string' ? [type] : Array.isArray(type) && type.every((t) => typeof t === 'string') ? (type as string[]) : null
  if (typy === null && type !== undefined) throw new UnreadableDataError('nieczytelny rodzaj punktu InPost')
  const pay = x['payment_available']
  if (pay !== undefined && pay !== null && typeof pay !== 'boolean') throw new UnreadableDataError('nieczytelna informacja o pobraniu w punkcie InPost')
  return {
    nazwa: x['name'],
    istnieje: true,
    dziala: typeof status === 'string' ? (DZIALA.has(status) ? true : NIE_DZIALA.has(status) ? false : null) : null,
    status: typeof status === 'string' ? status : null,
    typy: typy ?? [],
    pobranie: typeof pay === 'boolean' ? pay : null,
  }
}

// ───: wyszukiwarka punktów (publiczne API punktów InPost, tylko odczyt) ──────────────────────────────

export interface PunktZWyszukiwarki {
  nazwa: string
  /** „ul. Przykładowa 1, 60-001 Poznań” z pól `address` punktu; null = API nie podało */
  adres: string | null
  /** opis miejsca z API (np. „przy wejściu do sklepu”), skrócony */
  opis: string | null
  dziala: boolean | null
  typy: string[]
  pobranie: boolean | null
}

export type RodzajZapytania = 'nazwa' | 'kod' | 'miasto'

/**
 * Kod paczkomatu (np. POZ08M, WAW93A: 3 litery miasta, cyfry, do 4 liter), kod pocztowy (60-001) albo miasto. Puste
 * i śmieci = null. Trzy litery na początku: „Gdansk2” nie udaje kodu paczkomatu.
 */
export function rodzajZapytania(fraza: string): { rodzaj: RodzajZapytania; wartosc: string } | null {
  const f = fraza.trim().replace(/\s+/g, ' ')
  if (!f || f.length > 60) return null
  if (/^\d{2}-?\d{3}$/.test(f)) return { rodzaj: 'kod', wartosc: `${f.slice(0, 2)}-${f.replace('-', '').slice(2)}` }
  if (/^[A-Za-z]{3}\d{1,5}[A-Za-z]{0,4}$/.test(f) || /^[A-Za-z0-9]+[-_][A-Za-z0-9-_]+$/.test(f)) return { rodzaj: 'nazwa', wartosc: f.toUpperCase() }
  if (/^[\p{L}][\p{L} .'-]{1,59}$/u.test(f)) return { rodzaj: 'miasto', wartosc: f }
  return null
}

const NAJWIECEJ = 20

/** Najwięcej wyszukiwań punktów na firmę w minucie: publiczne API InPost widzi jeden adres serwera dla wszystkich firm. */
export const LIMIT_WYSZUKIWAN_NA_MINUTE = 30
const limiterWyszukiwan = new SlidingLimiter(LIMIT_WYSZUKIWAN_NA_MINUTE, 60_000)

/** Rejestruje wyszukiwanie firmy; false = limit na tę minutę wyczerpany (zapytanie nie idzie do InPost). Licznik w pamięci procesu. */
export function wolnoSzukacPunktow(organizationId: string, now = Date.now()): boolean {
  return limiterWyszukiwan.hit(organizationId, now)
}

/**
 * Punkty pasujące do frazy (kod paczkomatu, kod pocztowy albo miasto), najwyżej 20. `pobierz` = odczyt publicznego API
 * (lib/zrodla/inpost-punkty.ts) albo nagrana odpowiedź w testach. Kształt odpowiedzi [NIEPEWNE: z dokumentacji
 * publicznego API punktów]: nieczytelna lista to błąd, pojedynczy punkt bez nazwy jest pomijany.
 */
export async function szukajPunktow(pobierz: (query: Record<string, string>) => Promise<unknown>, fraza: string): Promise<PunktZWyszukiwarki[]> {
  const z = rodzajZapytania(fraza)
  if (!z) throw new Error('Wpisz kod paczkomatu (np. POZ08M), kod pocztowy (60-001) albo miasto.')
  const query: Record<string, string> = { per_page: String(NAJWIECEJ) }
  if (z.rodzaj === 'nazwa') query['name'] = z.wartosc
  else if (z.rodzaj === 'kod') query['relative_post_code'] = z.wartosc
  else query['city'] = z.wartosc
  const r = await pobierz(query)
  if (!r || typeof r !== 'object' || Array.isArray(r) || !Array.isArray((r as Record<string, unknown>)['items'])) throw new UnreadableDataError('nieczytelna lista punktów InPost')
  const out: PunktZWyszukiwarki[] = []
  for (const it of (r as { items: unknown[] }).items) {
    if (!it || typeof it !== 'object') continue
    const x = it as Record<string, unknown>
    if (typeof x['name'] !== 'string' || !INPOST_ID_RE.test(x['name'])) continue
    const a = x['address'] && typeof x['address'] === 'object' ? (x['address'] as Record<string, unknown>) : {}
    const linie = [a['line1'], a['line2']].filter((v): v is string => typeof v === 'string' && !!v.trim()).map((v) => v.trim())
    const status = typeof x['status'] === 'string' ? x['status'] : null
    const type = x['type']
    const opis = typeof x['location_description'] === 'string' ? x['location_description'].trim().slice(0, 120) : ''
    out.push({
      nazwa: x['name'],
      adres: linie.length ? linie.join(', ') : null,
      opis: opis || null,
      dziala: status ? (DZIALA.has(status) ? true : NIE_DZIALA.has(status) ? false : null) : null,
      typy: typeof type === 'string' ? [type] : Array.isArray(type) ? type.filter((t): t is string => typeof t === 'string') : [],
      pobranie: typeof x['payment_available'] === 'boolean' ? x['payment_available'] : null,
    })
    if (out.length >= NAJWIECEJ) break
  }
  return out
}
