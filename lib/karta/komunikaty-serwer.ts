// Serwerowa część komunikatów karty (dokończenie). Błąd z treścią z zapisu (lista
// odrzuconych pozycji, komunikat rdzenia) nie jedzie w adresie: akcja serwera zapisuje go w krótkotrwałym ciasteczku
// httpOnly (2 minuty, tylko ścieżka tej karty) pod losowym id, a w adresie zostaje `?blad=szczegoly&k=<id>`. Strona karty
// czyta ciasteczko po stronie serwera (`szczegolyBledu`) i pokazuje treść tylko przy zgodnym id. Ciasteczka nie ustawi
// spreparowany link (httpOnly, ustawia je wyłącznie odpowiedź akcji), więc obcy adres pokaże najwyżej ogólne
// „Nie udało się wykonać akcji”. Treść bez danych klienta (numery i SKU pozycji, powody odmowy).
// ciasteczka nie kasujemy po odczycie (komponent serwerowy nie może zmieniać ciasteczek), więc przez
// 2 minuty odświeżenie tego samego adresu pokaże tę samą treść drugi raz; potem wygasa samo.
import { randomBytes } from 'node:crypto'
import { cookies } from 'next/headers'
import { adresKarty, kodBledu, type KomunikatAkcji, type SzczegolyBledu } from './komunikaty'

export const CIASTKO_SZCZEGOLOW = 'kz_szczegoly'
const WAZNOSC_S = 120
// najdłuższy komunikat blokady pozycji (ok. 400 znaków z przedrostkiem) mieści się bez ucięcia; 1000 znaków
// z polskimi literami (2 bajty) w base64url to ok. 2,7 kB (wzorzec odczytu do 4000 znaków), poniżej limitu 4 kB ciasteczka
const MAKS_TRESCI = 1000

type Ciastka = { set(nazwa: string, wartosc: string, opcje: Record<string, unknown>): unknown; get(nazwa: string): { value: string } | undefined }

/** Wartość ciasteczka: `<id>.<treść base64url>`; czysta funkcja (testy). */
export function zakodujSzczegoly(k: string, tresc: string): string {
  return `${k}.${Buffer.from(tresc.slice(0, MAKS_TRESCI), 'utf8').toString('base64url')}`
}

export function odkodujSzczegoly(wartosc: string | undefined | null): SzczegolyBledu | null {
  if (!wartosc) return null
  const m = /^([a-f0-9]{12})\.([A-Za-z0-9_-]{1,4000})$/.exec(wartosc)
  if (!m) return null
  try {
    return { k: m[1]!, tresc: Buffer.from(m[2]!, 'base64url').toString('utf8').slice(0, MAKS_TRESCI) }
  } catch {
    return null
  }
}

/**
 * Adres powrotu na kartę po akcji serwera. Błąd stały jedzie kodem, błąd z treścią przez ciasteczko szczegółów.
 * `ciastka` do testów; domyślnie `cookies()` Next (wolno je zmieniać tylko w akcji serwera i w trasie API).
 */
export async function naKarte(id: string, w: KomunikatAkcji, kotwica = '', ciastka?: Ciastka): Promise<string> {
  if (!w.blad || kodBledu(w.blad)) return adresKarty(id, w, kotwica)
  const k = randomBytes(6).toString('hex')
  const jar = ciastka ?? ((await cookies()) as unknown as Ciastka)
  jar.set(CIASTKO_SZCZEGOLOW, zakodujSzczegoly(k, w.blad), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== 'false',
    path: `/zamowienia/${id}`,
    maxAge: WAZNOSC_S,
  })
  return adresKarty(id, { ...w, k }, kotwica)
}

/** Szczegóły błędu dla strony karty (odczyt ciasteczka; brak albo zła wartość = null). */
export async function szczegolyBledu(ciastka?: Pick<Ciastka, 'get'>): Promise<SzczegolyBledu | null> {
  const jar = ciastka ?? ((await cookies()) as unknown as Ciastka)
  return odkodujSzczegoly(jar.get(CIASTKO_SZCZEGOLOW)?.value)
}
