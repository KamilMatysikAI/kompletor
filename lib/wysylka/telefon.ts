// jeden odczyt numeru telefonu dla przewoźników. Wysyłam z Allegro od 01.10.2026 odrzuca przesyłkę bez
// prefiksu kraju w telefonie nadawcy i odbiorcy (`shipments/create-commands`) oraz w adresie podjazdu kuriera
// (`pickups/create-commands`): https://developer.allegro.pl/news/wysylam-z-allegro-od-1-pazdziernika-2026-prefiks-w-numerze-telefonu-bedzie-obowiazkowy-b2PbY8b3luR
// Ogłoszenie nie podaje formatu; wysyłamy postać międzynarodową bez spacji („+48600100200”, jak E.164). InPost ShipX
// chce 9 cyfr bez prefiksu (lib/wysylka/zlecenie-inpost.ts `telefonShipx`) i bierze je z tego samego odczytu.
//
// Zasady (bez zgadywania): separatory (spacje, myślniki, nawiasy, kropki, ukośniki) znikają; „+” albo „00” na początku
// = numer z prefiksem kraju (8–15 cyfr, pierwsza nie 0); 9 cyfr = numer polski (+48); „48” + 9 cyfr = numer polski
// z prefiksem bez plusa. Domyślne +48 tylko, gdy kraj osoby to PL albo kraju brak (numery CZ, SK,
// HU też mają 9 cyfr; z innym krajem numer bez „+”/„00” = null, nie cichy polski prefiks). Każda inna postać (litery, „0” na początku numeru krajowego, numer zagraniczny bez „+”/„00”,
// za krótki, za długi) = null, a wywołujący zwraca błąd do poprawy w karcie zamówienia zamiast wysyłki do przewoźnika.
// Komunikaty błędów nigdy nie zawierają wartości numeru (dane osobowe).

export type Telefon = {
  /** Prefiks kraju bez plusa, np. „48”; dla numerów zagranicznych cały numer jest w `miedzynarodowy`. */
  prefiks: string | null
  /** Numer polski bez prefiksu (9 cyfr) albo null dla numeru zagranicznego. */
  krajowyPL: string | null
  /** Postać międzynarodowa bez spacji: „+48600100200”. */
  miedzynarodowy: string
}

const SEPARATORY = /[\s\-()./]/g

/** Odczyt telefonu; null = nieczytelny albo bez rozpoznawalnego prefiksu kraju. */
export function odczytajTelefon(v: string | null | undefined, o: { krajDomyslny?: string | null } = {}): Telefon | null {
  if (typeof v !== 'string') return null
  const pl = !o.krajDomyslny?.trim() || o.krajDomyslny.trim().toUpperCase() === 'PL'
  const s = v.replace(SEPARATORY, '')
  if (!s) return null
  let cyfry: string
  if (/^\+\d+$/.test(s)) cyfry = s.slice(1)
  else if (/^00\d+$/.test(s)) cyfry = s.slice(2)
  else if (pl && /^\d{9}$/.test(s)) cyfry = `48${s}`
  else if (pl && /^48\d{9}$/.test(s)) cyfry = s
  else return null
  if (!/^[1-9]\d{7,14}$/.test(cyfry)) return null
  if (cyfry.startsWith('48')) {
    // numer polski: dokładnie 9 cyfr po prefiksie, bez „0” na początku numeru krajowego
    if (!/^48[1-9]\d{8}$/.test(cyfry)) return null
    return { prefiks: '48', krajowyPL: cyfry.slice(2), miedzynarodowy: `+${cyfry}` }
  }
  return { prefiks: null, krajowyPL: null, miedzynarodowy: `+${cyfry}` }
}

/** Telefon z prefiksem kraju („+48600100200”) albo null; `krajDomyslny` = kraj osoby (+48 tylko dla PL albo braku kraju). */
export function telefonZPrefiksem(v: string | null | undefined, o: { krajDomyslny?: string | null } = {}): string | null {
  return odczytajTelefon(v, o)?.miedzynarodowy ?? null
}

/** Komunikat dla człowieka (bez wartości numeru), gdy `telefonZPrefiksem` zwraca null. */
export const telefonBezPrefiksu = (kto: string) =>
  `telefon ${kto} nieczytelny albo bez prefiksu kraju: popraw go (np. +48 600 100 200; numer zagraniczny z „+” i prefiksem kraju)`
