// Wystawianie ofert ZA WYŁĄCZNIKIEM KONTA (Etap 2): Allegro (oferta), Empik (oferta albo wniosek o nowy
// produkt), sklep Woo (nowy produkt). Wzorzec adapterów zapisu (lib/adaptery/*-zapis.ts): bez `wystawianieOfertWlaczone: true`
// funkcja zwraca WYLACZONE i nie wysyła ŻADNEGO żądania (także odczytu). Każda funkcja zna tylko swoją jedną ścieżkę
// zapisu; inna ścieżka = błąd przed wysłaniem. Przed zapisem świeży odczyt, żeby powtórka nie założyła dubla:
// Allegro — oferta z tą sygnaturą (`external.id` = SKU), Empik — produkt już w katalogu (wniosek byłby dublem),
// Woo — produkt z tym SKU. Brak odpowiedzi po wysłaniu = NIEJEDNOZNACZNY (nie ponawiać bez sprawdzenia).
// Transport (`wyslij`) podaje wołający: klient zapisu konta z tokenem/kluczem (Etap 3: AllegroWriter, MiraklWriter,
// WooWriter po dopisaniu ścieżek ofert do ich list). W testach wyłącznie atrapy.
import { allegroOfertyPoSygnaturze, type AllegroGet } from '@/lib/zrodla/allegro'
import { kodyBledowAllegro } from '@/lib/zrodla/allegro-zapis'
import { ReadOnlyViolation } from '@/lib/zrodla/http'
import { IntegracjaWylaczonaError, jestOdlozone } from '@/lib/integracje/oslona'
import type { PodgladOfertyAllegro } from './allegro-podglad'
import { csvEmpik, KOLUMNY_OFERTY_EMPIK, KOLUMNY_PRODUKTU_EMPIK, wybierzZPim, type PodgladOfertyEmpik, type ZrodloEmpikOfert } from './empik-podglad'
import type { PodgladProduktuWoo, ZrodloWooOfert } from './woo-podglad'

export type WynikWystawienia =
  | { kind: 'OK'; idZewnetrzne: string | null; komunikat: string; juzIstnialo: boolean }
  | { kind: 'WYLACZONE' | 'NIEGOTOWA' | 'TRWALY' | 'PRZEJSCIOWY' | 'NIEJEDNOZNACZNY'; komunikat: string }

export interface OdpowiedzZapisu {
  status: number
  body: Record<string, unknown> | null
}

/** Jedno żądanie zapisu (bez ponowień); wyjątek = brak odpowiedzi (sieć, timeout) po wysłaniu. */
export type WyslijZapis = (metoda: 'POST', sciezka: string, cialo: unknown, query?: Record<string, string>) => Promise<OdpowiedzZapisu>

export interface KontoZapisuOfert {
  /** Osobny wyłącznik konta na wystawianie ofert (`wystawianieOfertWlaczone` w konfiguracji konta, nie `zapisWlaczony` od stanów). */
  wystawianieOfertWlaczone: boolean
  wyslij: WyslijZapis
}

export const KOMUNIKAT_WYLACZONE = 'Wystawianie ofert jest wyłączone na tym koncie. Włączysz je w Ustawienia → Sprzedaż i kanały → Kanały sprzedaży → konto → „Zapis do sklepu”.'

export const KOMUNIKAT_OSLONA_WYLACZONA = 'Nic nie wysłano: konto jest wyłączone po kolejnych błędach połączenia — włącz je ponownie w szczegółach konta.'
export const KOMUNIKAT_OSLONA_LIMIT = 'Nic nie wysłano: konto chwilowo wstrzymuje zapytania (limit tempa) — spróbuj za chwilę.'

/** Jedyne ścieżki zapisu ofert (strażnik przed wysłaniem). */
export const SCIEZKI_ZAPISU_OFERT = {
  allegro: '/sale/product-offers',
  empikOferta: '/offers/imports',
  empikProdukt: '/products/imports',
  woo: '/products/batch',
} as const

const DOZWOLONE = new Set<string>(Object.values(SCIEZKI_ZAPISU_OFERT))

/** Odmowa przed wysłaniem (osłona konta albo wyłącznik adaptera): nic nie wyszło, więc to nie jest NIEJEDNOZNACZNY. */
type NieWyslano = { niewyslano: WynikWystawienia }

async function wyslijBezpiecznie(k: KontoZapisuOfert, sciezka: string, cialo: unknown, query?: Record<string, string>): Promise<OdpowiedzZapisu | NieWyslano | 'brak_odpowiedzi'> {
  if (!DOZWOLONE.has(sciezka)) throw new Error(`zapis oferty poza dozwolonymi ścieżkami (${sciezka.slice(0, 60)})`)
  try {
    return await k.wyslij('POST', sciezka, cialo, query)
  } catch (e) {
    // (3b-1): osłona konta (limit tempa, konto wyłączone po błędach) odmawia PRZED żądaniem
    // komunikat stały, bez treści wyjątku (powód wyłączenia konta może nieść tekst wcześniejszego błędu kanału);
    // do logu serwera idzie tylko nazwa klasy błędu
    if (jestOdlozone(e)) {
      console.warn(`[oferty] osłona konta odmówiła zapisu oferty przed wysłaniem (${e instanceof Error ? e.name : 'nieznany'})`)
      return { niewyslano: { kind: 'PRZEJSCIOWY', komunikat: e instanceof IntegracjaWylaczonaError ? KOMUNIKAT_OSLONA_WYLACZONA : KOMUNIKAT_OSLONA_LIMIT } }
    }
    if (e instanceof ReadOnlyViolation) return { niewyslano: { kind: 'WYLACZONE', komunikat: KOMUNIKAT_WYLACZONE } }
    return 'brak_odpowiedzi'
  }
}

/** kilka trafień przy odczycie przeciw dublom — bez numeru, bez powiązania, bez zapisu. */
export function komunikatWieluWKanale(gdzie: string, n: number, co: 'ofert' | 'produktów', sku: string): string {
  const kilka = n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)
  const slowo = kilka ? (co === 'ofert' ? 'oferty' : 'produkty') : co
  return `${gdzie} ${kilka ? 'są' : 'jest'} ${n} ${slowo} z oznaczeniem (SKU) „${sku.trim().slice(0, 60)}” — nie wystawiam i nie wiążę automatycznie; powiąż ręcznie właściwą pozycję.`
}

const wylaczone = (): WynikWystawienia => ({ kind: 'WYLACZONE', komunikat: KOMUNIKAT_WYLACZONE })
const niegotowa = (komunikat = 'Oferta ma błędy do poprawienia — popraw je na podglądzie.'): WynikWystawienia => ({ kind: 'NIEGOTOWA', komunikat })

function zHttp(r: OdpowiedzZapisu, co: string, kody: string[] = []): WynikWystawienia {
  const k = kody.length ? ` (${kody.join(', ')})` : ''
  if (r.status === 429) return { kind: 'PRZEJSCIOWY', komunikat: `${co}: limit zapytań, spróbuj za chwilę.` }
  // 5xx po wysłaniu: kanał mógł przyjąć zapis — przed powtórką trzeba sprawdzić
  if (r.status >= 500) return { kind: 'NIEJEDNOZNACZNY', komunikat: `${co}: błąd po stronie kanału (HTTP ${r.status}) — sprawdź, czy oferta powstała, zanim spróbujesz ponownie.` }
  if (r.status === 401 || r.status === 403) return { kind: 'TRWALY', komunikat: `${co}: konto nie ma zgody na wystawianie (HTTP ${r.status}) — połącz konto ponownie z prawem do ofert.` }
  return { kind: 'TRWALY', komunikat: `${co}: kanał odrzucił dane (HTTP ${r.status})${k}.` }
}

// ─── Allegro ────────────────────────────────────────────────────────────────

export interface UstawieniaWystawieniaAllegro {
  /** Cennik dostaw konta (`delivery.shippingRates.id`), wymagany przez Allegro. */
  cennikDostawId: string | null
  zwrotyId?: string | null
  reklamacjeId?: string | null
  gwarancjaId?: string | null
  /** INACTIVE (domyślnie: oferta czeka na włączenie w Allegro) albo ACTIVE. */
  publikacja?: 'INACTIVE' | 'ACTIVE'
}

export interface KontoAllegroOfert extends KontoZapisuOfert {
  odczyt: AllegroGet
}

/** Treść `POST /sale/product-offers` = szkic z podglądu + sygnatura (SKU) + ustawienia konta. */
export function trescOfertyAllegro(podglad: PodgladOfertyAllegro, sku: string, u: UstawieniaWystawieniaAllegro): Record<string, unknown> {
  const posprzedazowe: Record<string, unknown> = {}
  if (u.zwrotyId) posprzedazowe['returnPolicy'] = { id: u.zwrotyId }
  if (u.reklamacjeId) posprzedazowe['impliedWarranty'] = { id: u.reklamacjeId }
  if (u.gwarancjaId) posprzedazowe['warranty'] = { id: u.gwarancjaId }
  return {
    ...podglad.szkicOferty,
    external: { id: sku },
    delivery: { shippingRates: { id: u.cennikDostawId } },
    ...(Object.keys(posprzedazowe).length ? { afterSalesServices: posprzedazowe } : {}),
    publication: { status: u.publikacja ?? 'INACTIVE' },
  }
}

export async function wystawOferteAllegro(podglad: PodgladOfertyAllegro, sku: string, konto: KontoAllegroOfert, u: UstawieniaWystawieniaAllegro): Promise<WynikWystawienia> {
  if (konto.wystawianieOfertWlaczone !== true) return wylaczone()
  // podgląd z nieudanym odczytem kategorii/parametrów ma `gotowa: false` i powód — nic nie wysyłamy
  if (!podglad.gotowa || podglad.powodNiegotowej) return niegotowa(podglad.powodNiegotowej ?? undefined)
  if (!sku.trim()) return niegotowa('Produkt nie ma SKU — oferta potrzebuje sygnatury.')
  if (podglad.zdjecia.some((z) => !/^https:\/\//i.test(z))) return niegotowa('Część zdjęć nie ma publicznego adresu — najpierw trzeba je wgrać do Allegro.')
  if (!u.cennikDostawId?.trim()) return { kind: 'TRWALY', komunikat: 'Konto Allegro nie ma wybranego cennika dostaw — wybierz go w ustawieniach konta.' }
  try {
    const sa = await allegroOfertyPoSygnaturze(konto.odczyt, sku)
    // powiązanie tylko przy dokładnie jednym trafieniu; kilka ofert z tą sygnaturą = człowiek wybiera, my nic nie zapisujemy
    if (sa.length > 1) return { kind: 'TRWALY', komunikat: komunikatWieluWKanale('Na Allegro', sa.length, 'ofert', sku) }
    if (sa.length === 1) return { kind: 'OK', idZewnetrzne: sa[0]!.id, komunikat: `Oferta z tym SKU już jest na Allegro (nr ${sa[0]!.id}) — nie zakładam drugiej.`, juzIstnialo: true }
  } catch {
    return { kind: 'PRZEJSCIOWY', komunikat: 'Nie udało się sprawdzić ofert na Allegro — spróbuj ponownie za chwilę.' }
  }
  const r = await wyslijBezpiecznie(konto, SCIEZKI_ZAPISU_OFERT.allegro, trescOfertyAllegro(podglad, sku.trim(), u))
  if (r !== 'brak_odpowiedzi' && 'niewyslano' in r) return r.niewyslano
  if (r === 'brak_odpowiedzi') return { kind: 'NIEJEDNOZNACZNY', komunikat: 'Allegro nie odpowiedziało — przy następnej próbie sprawdzimy najpierw, czy oferta powstała.' }
  if (r.status >= 200 && r.status < 300) {
    const id = typeof r.body?.['id'] === 'string' || typeof r.body?.['id'] === 'number' ? String(r.body['id']) : null
    return { kind: 'OK', idZewnetrzne: id, komunikat: id ? `Oferta wystawiona na Allegro (nr ${id}).` : 'Allegro przyjęło ofertę do przetworzenia.', juzIstnialo: false }
  }
  return zHttp(r, 'Allegro', kodyBledowAllegro(r.body))
}

// ─── Empik (Mirakl) ─────────────────────────────────────────────────────────

export interface KontoEmpikOfert extends KontoZapisuOfert {
  odczyt: ZrodloEmpikOfert
}

/** Plik CSV importu (multipart, pole `file`) jak w skillu: oferty `offers.csv`, produkty `products.csv`. */
export function plikImportuEmpik(podglad: PodgladOfertyEmpik): { sciezka: string; nazwaPliku: string; csv: string } {
  if (podglad.tryb === 'oferta') return { sciezka: SCIEZKI_ZAPISU_OFERT.empikOferta, nazwaPliku: 'offers.csv', csv: csvEmpik(KOLUMNY_OFERTY_EMPIK, [podglad.wierszOferty]) }
  return { sciezka: SCIEZKI_ZAPISU_OFERT.empikProdukt, nazwaPliku: 'products.csv', csv: csvEmpik(KOLUMNY_PRODUKTU_EMPIK, [podglad.wierszProduktu ?? {}]) }
}

export async function wystawOferteEmpik(podglad: PodgladOfertyEmpik, konto: KontoEmpikOfert): Promise<WynikWystawienia> {
  if (konto.wystawianieOfertWlaczone !== true) return wylaczone()
  if (!podglad.gotowa) return niegotowa()
  const ean = podglad.wierszOferty['product-id'] ?? ''
  // świeży odczyt: wniosek dla produktu, który już jest w katalogu, to dubel; oferta dla produktu spoza katalogu — błąd Empiku
  let wKatalogu: boolean
  try {
    wKatalogu = wybierzZPim(ean, await konto.odczyt.produktyPoEan(ean)) !== null
  } catch {
    return { kind: 'PRZEJSCIOWY', komunikat: 'Nie udało się sprawdzić katalogu Empiku — spróbuj ponownie za chwilę.' }
  }
  if (podglad.tryb === 'wniosek_o_produkt' && wKatalogu) return niegotowa('Produkt jest już w katalogu Empiku — odśwież podgląd i wystaw ofertę zamiast wniosku.')
  if (podglad.tryb === 'oferta' && !wKatalogu) return niegotowa('Produktu nie ma już w katalogu Empiku — odśwież podgląd.')
  const plik = plikImportuEmpik(podglad)
  const form = new FormData()
  form.append('file', new Blob([plik.csv], { type: 'text/csv' }), plik.nazwaPliku)
  const co = podglad.tryb === 'oferta' ? 'Empik (oferta)' : 'Empik (wniosek o produkt)'
  const r = await wyslijBezpiecznie(konto, plik.sciezka, form, { import_mode: 'NORMAL' })
  if (r !== 'brak_odpowiedzi' && 'niewyslano' in r) return r.niewyslano
  if (r === 'brak_odpowiedzi') return { kind: 'NIEJEDNOZNACZNY', komunikat: `${co}: Empik nie odpowiedział — sprawdź import w panelu Empiku, zanim spróbujesz ponownie.` }
  if (r.status >= 200 && r.status < 300) {
    const id = r.body?.['import_id']
    const nr = typeof id === 'string' || typeof id === 'number' ? String(id) : null
    const opis = podglad.tryb === 'oferta' ? 'Oferta wysłana do Empiku' : 'Wniosek o produkt wysłany do Empiku (Empik sprawdza go ręcznie, zwykle kilka dni)'
    return { kind: 'OK', idZewnetrzne: nr, komunikat: `${opis}${nr ? `, import nr ${nr}` : ''}.`, juzIstnialo: false }
  }
  return zHttp(r, co)
}

// ─── Sklep WooCommerce ──────────────────────────────────────────────────────

export interface KontoWooOfert extends KontoZapisuOfert {
  odczyt: Pick<ZrodloWooOfert, 'produktPoSku'>
}

export async function wystawProduktWoo(podglad: PodgladProduktuWoo, konto: KontoWooOfert): Promise<WynikWystawienia> {
  if (konto.wystawianieOfertWlaczone !== true) return wylaczone()
  if (!podglad.gotowa || podglad.tryb !== 'nowy') return niegotowa()
  try {
    const jest = await konto.odczyt.produktPoSku(podglad.sku)
    // kilka produktów sklepu z tym SKU = nie wiążemy z pierwszym, powiązanie ręczne
    if (jest && (jest.liczba ?? 1) > 1) return { kind: 'TRWALY', komunikat: komunikatWieluWKanale('W sklepie', jest.liczba!, 'produktów', podglad.sku) }
    if (jest) return { kind: 'OK', idZewnetrzne: String(jest.id), komunikat: `Sklep ma już produkt z tym SKU (nr ${jest.id}) — nie zakładam drugiego.`, juzIstnialo: true }
  } catch {
    return { kind: 'PRZEJSCIOWY', komunikat: 'Nie udało się sprawdzić sklepu — spróbuj ponownie za chwilę.' }
  }
  const r = await wyslijBezpiecznie(konto, SCIEZKI_ZAPISU_OFERT.woo, { create: [podglad.szkicProduktu] })
  if (r !== 'brak_odpowiedzi' && 'niewyslano' in r) return r.niewyslano
  if (r === 'brak_odpowiedzi') return { kind: 'NIEJEDNOZNACZNY', komunikat: 'Sklep nie odpowiedział — przy następnej próbie sprawdzimy najpierw, czy produkt powstał.' }
  if (r.status >= 200 && r.status < 300) {
    const el = Array.isArray(r.body?.['create']) ? ((r.body['create'] as unknown[])[0] as Record<string, unknown> | undefined) : undefined
    const blad = el?.['error'] && typeof el['error'] === 'object' ? (el['error'] as Record<string, unknown>) : null
    if (blad) {
      const kod = typeof blad['code'] === 'string' && /^[a-z0-9_]{1,60}$/i.test(blad['code']) ? ` (${blad['code']})` : ''
      return { kind: 'TRWALY', komunikat: `Sklep odrzucił produkt${kod}.` }
    }
    const id = typeof el?.['id'] === 'number' ? String(el['id']) : null
    return { kind: 'OK', idZewnetrzne: id, komunikat: id ? `Produkt założony w sklepie (nr ${id}).` : 'Sklep przyjął produkt.', juzIstnialo: false }
  }
  return zHttp(r, 'Sklep')
}
