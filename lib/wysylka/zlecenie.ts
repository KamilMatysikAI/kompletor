// Treść `createOrderV2` Base Courier (kształt V2). Woła ją tylko adapter zapisu
// `basecourier.zapis.v1` za wyłącznikiem (host lib/wysylka/nadanie.ts) i testy z danymi fikcyjnymi; nic tego wyniku nie
// zapisuje. Wartość robocza (wymiary, waga) nie przechodzi bez świadomego potwierdzenia w argumencie.
//
// Kształt z oficjalnej dokumentacji API (OpenAPI 3.0, https://api.basecourier.com/api/docs, schematy CourierSearchDto,
// OrderDto, CartOrderDto; opis w docs/integracje/basecourier.md), zgodny z formularzem wtyczki BLPaczka:
//   CourierSearch  — courier_code, type, side_x/y/z (cm), weight (kg), uptake (pobranie, zł), cover (ubezpieczenie),
//                    no_pickup (bez podjazdu kuriera), country_code, origin (identyfikator źródła zamówienia, WYMAGANY);
//   Cart[0].Order  — nadawca (name, street, house_no, locum_no, postal, city, phone, email, account = konto na zwrot
//                    pobrań), odbiorca (taker_*), punkt odbioru taker_point, package_content (niesie referencję);
//   CartOrder      — payment: `bank` (skarbonka, przedpłata) albo `pay_later` (płatność odroczona).
// Podjazd kuriera: API nie ma osobnego zlecenia odbioru; podjazd jest częścią każdej przesyłki (`no_pickup: false` i pola
// `pickup_*` w `Cart[0].Order`, wszystkie opcjonalne w dokumentacji). Adres podjazdu = adres nadawcy (`custom_pickup` nie
// wysyłamy).
// Dokumentacja oznacza `account` i `taker_point` jako wymagane: `taker_point` idzie zawsze (pusty tekst bez punktu, jak
// formularz wtyczki), `account` zawsze, gdy firma ma poprawny rachunek zwrotu pobrań. [NIEPEWNE] czy API przyjmie
// przesyłkę bez pobrania i bez `account` (dokumentacja tego nie rozstrzyga; konto ma rachunek w profilu): do sandboxa.
// `cover` (ubezpieczenie) tylko, gdy firma je włączy (`ubezpieczenie` w regule; wtyczka liczy je osobno i może podnosić
// cenę). `foreign: '0'` jak formularz wtyczki (wycena przyjmuje `'0'` i `'local'`; dokumentacja ma enum `local`/`foreign`).
// Wycena: pobranie 5 001 zł przechodzi bez `cover`, DPD do drzwi przy 10 001 zł chce `cover` ≥ pobrania. Bez `auth`:
// to dokłada klient HTTP.
import type { PreparedParcel } from '../adaptery/kontrakt'

/**
 * Odbiorca przesyłki. Ulica, numer domu, kod i miasto mogą być null tylko przy dostawie do punktu odbioru
 * (paczkomat, punkt DPD), bo tam adres domowy nie wpływa na doręczenie; każdy builder treści sam pilnuje, czego wymaga
 * jego API przy kurierze do drzwi (wtedy brak = odmowa, jak dotąd).
 */
export interface OdbiorcaPrzesylki {
  imieNazwisko: string
  firma?: string | null
  ulica: string | null
  numerDomu: string | null
  numerLokalu?: string | null
  kodPocztowy: string | null
  miasto: string | null
  telefon: string
  email: string
}

/** Nadawca Base Courier: firma (Organization.settings.nadawca / profil firmy) z ulicą i numerem osobno. */
export interface NadawcaBaseCourier {
  nazwa: string
  ulica: string
  numerDomu: string
  numerLokalu: string | null
  kodPocztowy: string
  miasto: string
  telefon: string
  email: string | null
}

export type PlatnoscBaseCourier = 'bank' | 'pay_later'

/** `CourierSearch.origin`: identyfikator źródła zamówienia, wymagany przez API (dowolny tekst; wtyczka wysyła `woocommerce`). */
export const BASE_COURIER_ORIGIN = 'kompletor'

export interface OpcjeZleceniaBaseCourier {
  nadawca: NadawcaBaseCourier
  /** Treść pola „Zawartość przesyłki”: z referencją hosta (`zawartoscPrzesylki`). */
  zawartosc: string
  /** Rachunek nadawcy na zwrot pobrań (26 cyfr); wymagany, gdy przesyłka ma pobranie, a wysyłany zawsze, gdy poprawny. */
  kontoPobran: string | null
  platnosc: PlatnoscBaseCourier
  /** true = bez zamawiania podjazdu kuriera (paczkomat, stały odbiór). */
  bezPodjazdu: boolean
  /**
   * Dzień i okno podjazdu (lib/wysylka/podjazd.ts) przy `bezPodjazdu: false`: pola `pickup_date` (RRRR-MM-DD),
   * `pickup_ready_time` / `pickup_ready_time_minute` (od) i `pickup_close_time` / `pickup_close_time_minute` (do), godziny
   * i minuty jako dwucyfrowy tekst jak klucze `hours` / `minutes` z `getPickupDateOptions`. null = podjazd bez daty.
   */
  podjazd?: { data: string; odMin: number; doMin: number } | null
  /** Ubezpieczenie (`cover`): null = bez (domyślnie), 'pobranie' = kwota pobrania (tylko przy pobraniu), liczba = kwota zł. */
  ubezpieczenie?: UbezpieczenieBaseCourier
}

export type UbezpieczenieBaseCourier = number | 'pobranie' | null

/** Ustawienie reguły `ubezpieczenie`: puste = bez, „pobranie” = jak pobranie, liczba = kwota zł; inne = null. */
export function parseUbezpieczenie(v: unknown): UbezpieczenieBaseCourier {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null
  if (typeof v !== 'string' || !v.trim()) return null
  const t = v.trim().toLowerCase()
  if (t === 'pobranie') return 'pobranie'
  const n = Number(t.replace(',', '.'))
  return /^\d+([.,]\d{1,2})?$/.test(t) && n > 0 ? n : null
}

/** Rachunek PL do zwrotu pobrań: 26 cyfr (spacje i „PL” wolno). */
export function kontoPobranPoprawne(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null
  const s = v.replace(/\s+/g, '').replace(/^PL/i, '')
  return /^\d{26}$/.test(s) ? s : null
}

/**
 * „Zawartość przesyłki” z referencją Kompletora: po niej człowiek znajdzie przesyłkę w panelu Base Courier, gdy
 * odpowiedź API zginęła (API nie ma wyszukiwania po referencji). Referencja NA POCZĄTKU: limit
 * długości pola nie jest znany, a obcięty koniec nie może zabrać referencji. Numer zamówienia z kanału po niej, gdy krótki.
 */
export function zawartoscPrzesylki(reference: string, orderExternalId?: string | null): string {
  const nr = orderExternalId && /^[0-9A-Za-z_/-]{1,30}$/.test(orderExternalId) ? `; zam. ${orderExternalId}` : ''
  return `ref. ${reference}${nr}`
}

/**
 * Czy „Zawartość przesyłki” z Base Courier niesie tę referencję: pełną albo (pole obcięte przez API) jej pierwsze dwa
 * segmenty UUID (`8-4` hex, 13 znaków), które w jednym koncie wystarczają do rozróżnienia. Referencja nie-UUID: pełna.
 */
export function zawartoscMaReferencje(zawartosc: string, reference: string): boolean {
  if (zawartosc.includes(reference)) return true
  // prefiks tylko przy obciętym polu; pełny, inny UUID w treści = inna przesyłka
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(zawartosc)) return false
  const prefiks = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(reference) ? reference.slice(0, 13) : null
  return !!prefiks && zawartosc.toLowerCase().includes(prefiks.toLowerCase())
}

/**
 * Ulica, numer domu i opcjonalny lokal. Separator domu i lokalu: „/”, przecinek albo odstęp, opcjonalnie ze słowem
 * lokalu (dłuższe słowa najpierw); numer lokalu zawsze zaczyna się od cyfry, więc „m” z „maja” nie jest separatorem.
 */
const ADRES = /^(.*?\S)[\s,]+(\d+[A-Za-z]?)(?:(?:\s*[/,]\s*|\s+)(?:(?:mieszkanie|mieszk|lokal|lok|apt|m)\.?\s*)?(\d+[A-Za-z]?))?$/i
/** Ulica nie może kończyć się numerem (wtedy numerem domu zostałaby ostatnia liczba) ani słowem lokalu/klatki/„nr”. */
const ULICA_PODEJRZANA = /(?:\d[A-Za-z]?|(?:^|[\s,.])(?:mieszkanie|mieszk|lokal|lok|apt|kl|klatka|m|nr)\.?)$/i

/**
 * Ulica z numerem w jednym polu (profil firmy, linia adresu z kanału) → ulica, numer domu, lokal; null = nie da się
 * rozdzielić jednoznacznie. Wzorzec z leniwą ulicą brał ostatnią liczbę linii jako numer domu
 * („Lipowa 7 3” → dom 3). Teraz rozdział tylko wtedy, gdy ulica ma nazwę z liter i nie kończy się liczbą ani słowem
 * lokalu; w każdym innym przypadku null, a nadanie kończy się brakiem `numerDomu` (człowiek poprawia na karcie).
 */
export function rozdzielAdres(adres: string): { ulica: string; numerDomu: string; numerLokalu: string | null } | null {
  // przecinek jako separator („Ulica, 8, 24”) dopisany 19.11.2026: tak wpisują adres klienci sklepu
  const m = ADRES.exec(adres.trim())
  if (!m) return null
  const ulica = m[1]!.replace(/,$/, '').trim()
  if (!/\p{L}/u.test(ulica) || ULICA_PODEJRZANA.test(ulica)) return null
  return { ulica, numerDomu: m[2]!, numerLokalu: m[3] ?? null }
}

/**
 * Poprawka z 19.11.2026: kanał dał ulicę z numerem w jednej linii (`numerDomu` pusty,
 * `adres_bez_podzialu`), a przewoźnik wymaga numeru osobno. Rozdzielamy tylko jednoznaczny zapis
 * („ulica numer[/lokal]”); gdy się nie da, pola zostają bez zmian i nadanie kończy się brakiem `numerDomu` jak dotąd.
 */
export function zRozdzielonymAdresem<T extends { ulica: string | null; numerDomu: string | null; numerLokalu: string | null }>(r: Readonly<T>): T {
  if ((r.numerDomu ?? '').trim() || !(r.ulica ?? '').trim()) return { ...r }
  const a = rozdzielAdres(r.ulica!)
  if (!a) return { ...r }
  return { ...r, ulica: a.ulica, numerDomu: a.numerDomu, numerLokalu: (r.numerLokalu ?? '').trim() ? r.numerLokalu : a.numerLokalu }
}

const dwie = (n: number) => String(n).padStart(2, '0')

/** Pola podjazdu w `Cart[0].Order`. */
export function polaPodjazdu(p: { data: string; odMin: number; doMin: number }): Record<string, string> {
  return {
    pickup_date: p.data,
    pickup_ready_time: dwie(Math.floor(p.odMin / 60)),
    pickup_ready_time_minute: dwie(p.odMin % 60),
    pickup_close_time: dwie(Math.floor(p.doMin / 60)),
    pickup_close_time_minute: dwie(p.doMin % 60),
  }
}

export function buildCreateOrderPayload(draft: PreparedParcel, recipient: OdbiorcaPrzesylki, potwierdzoneOstrzezenia: readonly string[], opcje: OpcjeZleceniaBaseCourier): Record<string, unknown> {
  const bledy = draft.problems.filter((p) => p.poziom === 'BLAD' || !potwierdzoneOstrzezenia.includes(p.kod))
  if (bledy.length) throw new Error(`Przesyłka nie jest gotowa: ${bledy.map((p) => p.kod).join(', ')}`)
  if (!draft.courierCode || draft.sideXCm === null || draft.sideYCm === null || draft.sideZCm === null || draft.weightKg === null) throw new Error('Przesyłka nie jest gotowa: brak kodu kuriera, wymiarów albo wagi')
  const konto = kontoPobranPoprawne(opcje.kontoPobran)
  if (draft.codAmount !== null && !konto) throw new Error('Pobranie wymaga numeru rachunku do zwrotu pobrań (ustawienie „kontoPobran” przewoźnika)')
  // przy punkcie odbioru (`taker_point`) adres domowy nie wpływa na doręczenie. OpenAPI Base Courier
  // (OrderDto.required) wymaga jednak `taker_street`, `taker_house_no`, `taker_postal` i `taker_city` zawsze, więc pola
  // idą, ale bez wymyślonego numeru: linia adresu tak, jak przyszła z kanału, numer pusty. [NIEPEWNE] czy API przyjmie
  // pusty `taker_house_no` przy punkcie: odmowa walidacji = TRWALY z nazwą pola (bez przesyłki), poprawka na karcie jak dotąd.
  const punkt = !!draft.pickupPoint
  const brakAdresu = [!recipient.ulica && 'ulica', !recipient.numerDomu && 'numer domu', !recipient.kodPocztowy && 'kod pocztowy', !recipient.miasto && 'miasto'].filter((x): x is string => !!x)
  const brakPunkt = brakAdresu.filter((x) => x === 'kod pocztowy' || x === 'miasto')
  if (punkt ? brakPunkt.length : brakAdresu.length) throw new Error(`Przesyłka nie jest gotowa: ${(punkt ? brakPunkt : brakAdresu).join(', ')}`)
  const n = opcje.nadawca
  const u = opcje.ubezpieczenie ?? null
  const cover = u === 'pobranie' ? draft.codAmount : u
  return {
    CourierSearch: {
      courier_code: draft.courierCode,
      type: 'package',
      side_x: draft.sideXCm,
      side_y: draft.sideYCm,
      side_z: draft.sideZCm,
      weight: draft.weightKg,
      country_code: 'PL',
      foreign: '0',
      no_pickup: opcje.bezPodjazdu,
      origin: BASE_COURIER_ORIGIN,
      ...(draft.codAmount !== null ? { uptake: draft.codAmount } : {}),
      ...(cover !== null ? { cover } : {}),
    },
    Cart: [
      {
        Order: {
          name: n.nazwa,
          street: n.ulica,
          house_no: n.numerDomu,
          locum_no: n.numerLokalu ?? '',
          postal: n.kodPocztowy,
          city: n.miasto,
          phone: n.telefon,
          email: n.email ?? '',
          ...(konto ? { account: konto } : {}),
          taker_name: recipient.imieNazwisko,
          taker_vat_company: recipient.firma ?? '',
          taker_street: recipient.ulica ?? '',
          taker_house_no: recipient.numerDomu ?? '',
          taker_locum_no: recipient.numerLokalu ?? '',
          taker_postal: recipient.kodPocztowy ?? '',
          taker_city: recipient.miasto ?? '',
          taker_phone: recipient.telefon,
          taker_email: recipient.email,
          taker_point: draft.pickupPoint ?? '',
          package_content: opcje.zawartosc,
          ...(!opcje.bezPodjazdu && opcje.podjazd ? polaPodjazdu(opcje.podjazd) : {}),
        },
      },
    ],
    CartOrder: { payment: opcje.platnosc },
  }
}
