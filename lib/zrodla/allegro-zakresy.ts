// Zakresy OAuth Allegro dobrane do funkcji Kompletora (uzgodnione przez logi zadań).
// JEDNO źródło: autoryzacja z panelu (lib/kanaly/allegro-autoryzacja.ts), komenda CLI (scripts/allegro-autoryzacja.ts)
// i adapter zapisu (stany ofert, status realizacji, numer nadania, Wysyłam z Allegro) biorą zakresy stąd.
// Nowy zakres = nowa funkcja w FUNKCJE_ALLEGRO, nigdy stała w innym pliku.
//
// Nowa autoryzacja ZASTĘPUJE poprzednią parę tokenów (Allegro nie dokłada zakresów do istniejącej pary), więc żądanie
// zawsze niesie komplet zakresów wybranych funkcji, nie tylko nową.
import { ALLEGRO_OFFERS_READ_SCOPE, ALLEGRO_ORDERS_READ_SCOPE } from './allegro'
import { ALLEGRO_SHIPMENTS_READ_SCOPE, ALLEGRO_SHIPMENTS_WRITE_SCOPE } from './allegro-wysylam'

/** Zmiana statusu realizacji (`PUT /order/checkout-forms/{id}/fulfillment`) i numeru nadania (`.../shipments`). */
export const ALLEGRO_ORDERS_WRITE_SCOPE = 'allegro:api:orders:write'
/** Zmiana stanów ofert (`/sale/offer-quantity-change-commands`). */
export const ALLEGRO_OFFERS_WRITE_SCOPE = 'allegro:api:sale:offers:write'

export type FunkcjaAllegro = 'zamowienia' | 'oferty' | 'przesylki' | 'zapisZamowien' | 'zapisStanow' | 'wysylamZAllegro'

export interface OpisFunkcjiAllegro {
  funkcja: FunkcjaAllegro
  /** Etykieta dla właściciela konta (bez nazw technicznych). */
  etykieta: string
  /** Jedno zdanie: do czego Kompletor tego używa. */
  opis: string
  zakresy: readonly string[]
  /** Zawsze w żądaniu (bez tego konto nie działa). */
  wymagana?: boolean
  /** Funkcja zapisuje w Allegro (działa dopiero po włączeniu zapisu na koncie). */
  zapis?: boolean
}

/** Kolejność = kolejność pól wyboru w panelu. */
export const FUNKCJE_ALLEGRO: readonly OpisFunkcjiAllegro[] = [
  { funkcja: 'zamowienia', etykieta: 'Odczyt zamówień', opis: 'Pobieranie zamówień i wpłat z konta.', zakresy: [ALLEGRO_ORDERS_READ_SCOPE], wymagana: true },
  { funkcja: 'przesylki', etykieta: 'Odczyt przesyłek', opis: 'Podgląd przesyłek Wysyłam z Allegro.', zakresy: [ALLEGRO_SHIPMENTS_READ_SCOPE] },
  { funkcja: 'oferty', etykieta: 'Odczyt ofert', opis: 'Lista ofert do przypisania produktów po SKU.', zakresy: [ALLEGRO_OFFERS_READ_SCOPE] },
  {
    funkcja: 'zapisZamowien',
    etykieta: 'Status i numer nadania',
    opis: 'Ustawianie statusu realizacji i numeru przesyłki w zamówieniu.',
    zakresy: [ALLEGRO_ORDERS_WRITE_SCOPE],
    zapis: true,
  },
  { funkcja: 'zapisStanow', etykieta: 'Stany ofert', opis: 'Wysyłanie stanów magazynowych do ofert.', zakresy: [ALLEGRO_OFFERS_READ_SCOPE, ALLEGRO_OFFERS_WRITE_SCOPE], zapis: true },
  {
    funkcja: 'wysylamZAllegro',
    etykieta: 'Nadawanie Wysyłam z Allegro',
    opis: 'Tworzenie i anulowanie przesyłek oraz etykiety.',
    zakresy: [ALLEGRO_SHIPMENTS_READ_SCOPE, ALLEGRO_SHIPMENTS_WRITE_SCOPE],
    zapis: true,
  },
]

const FUNKCJA = new Map(FUNKCJE_ALLEGRO.map((f) => [f.funkcja, f]))

export function czyFunkcjaAllegro(v: unknown): v is FunkcjaAllegro {
  return typeof v === 'string' && FUNKCJA.has(v as FunkcjaAllegro)
}

/**
 * Domyślny wybór w panelu: wszystkie odczyty. Funkcje zapisu właściciel zaznacza sam (osobna decyzja: zapis w Allegro
 * rusza i tak dopiero po włączeniu zapisu i trybu pracy na koncie, docs/integracje/allegro.md).
 */
export const DOMYSLNE_FUNKCJE_ALLEGRO: readonly FunkcjaAllegro[] = FUNKCJE_ALLEGRO.filter((f) => !f.zapis).map((f) => f.funkcja)

/**
 * Zakres OAuth (spacjami, bez powtórzeń, w stałej kolejności) dla wybranych funkcji. Odczyt zamówień jest zawsze:
 * bez niego konto Allegro nie ma sensu, a refresh tokenu bez zakresu zamówień psułby odczyt.
 */
export function allegroZakresy(funkcje: Iterable<FunkcjaAllegro>): string {
  const wybrane = new Set<FunkcjaAllegro>(['zamowienia', ...funkcje])
  const out: string[] = []
  for (const f of FUNKCJE_ALLEGRO) {
    if (!wybrane.has(f.funkcja)) continue
    for (const z of f.zakresy) if (!out.includes(z)) out.push(z)
  }
  return out.join(' ')
}

/** Funkcje w pełni pokryte zakresem tokenu (np. `scope` z odpowiedzi Allegro albo zapis po autoryzacji). */
export function funkcjeZZakresu(scope: string | null | undefined): FunkcjaAllegro[] {
  const s = new Set((scope ?? '').split(/\s+/).filter(Boolean))
  return FUNKCJE_ALLEGRO.filter((f) => f.zakresy.every((z) => s.has(z))).map((f) => f.funkcja)
}

/** Czy zakres tokenu pozwala na funkcję (adapter zapisu: komunikat „dodaj zakres” zamiast HTTP 403). */
export function zakresPozwala(scope: string | null | undefined, funkcja: FunkcjaAllegro): boolean {
  return funkcjeZZakresu(scope).includes(funkcja)
}

/** Etykieta jednej funkcji (komunikaty adapterów zapisu: „połącz ponownie z funkcją …”). */
export function etykietaFunkcji(funkcja: FunkcjaAllegro): string {
  return FUNKCJA.get(funkcja)!.etykieta
}

/** Etykiety funkcji dla ekranu konta („Odczyt zamówień, Odczyt ofert”). */
export function etykietyFunkcji(funkcje: Iterable<FunkcjaAllegro>): string[] {
  const s = new Set(funkcje)
  return FUNKCJE_ALLEGRO.filter((f) => s.has(f.funkcja)).map((f) => f.etykieta)
}
