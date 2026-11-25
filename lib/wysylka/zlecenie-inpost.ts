// Treść `POST /v1/organizations/:id/shipments` InPost ShipX, tryb uproszczony. Używają jej tylko testy
// z danymi fikcyjnymi i adapter zapisu za wyłącznikiem (lib/adaptery/inpost-zapis.ts), którego dziś nikt nie woła: nic
// tego wyniku nie zapisuje ani nie loguje. Wartość robocza (wymiary, waga, ubezpieczenie pobrania) nie jest
// potwierdzona: każde ostrzeżenie musi być świadomie przyjęte w argumencie, jak w `buildCreateOrderPayload`. Odbiorca
// przychodzi w argumencie, bo system nie przechowuje adresów klientów. Pola oznaczone [NIEPEWNE] do potwierdzenia na
// sandboxie (docs/integracje/inpost.md). Bez `reference`: to dokłada klient HTTP zapisu.
import type { PreparedParcel } from '../adaptery/kontrakt'
import { SZABLON_INPOST, USLUGI_SHIPX, type UslugaShipx } from './inpost'
import { isGabaryt } from '../stanowisko/gabaryty'
import type { OdbiorcaPrzesylki } from './zlecenie'
import { odczytajTelefon } from './telefon'

export interface UstawieniaZleceniaInpost {
  /** `custom_attributes.sending_method`, np. dispatch_order [NIEPEWNE: pełna lista wartości]. */
  sendingMethod: string
}

const isUsluga = (v: unknown): v is UslugaShipx => typeof v === 'string' && (USLUGI_SHIPX as readonly string[]).includes(v)

/** „Jan Testowy” → imię i nazwisko osobno; jedno słowo = samo nazwisko [NIEPEWNE: czy ShipX przyjmuje puste imię]. */
function imieINazwisko(pelne: string): { first_name: string; last_name: string } {
  const s = pelne.trim().replace(/\s+/g, ' ')
  const i = s.indexOf(' ')
  return i < 0 ? { first_name: '', last_name: s } : { first_name: s.slice(0, i), last_name: s.slice(i + 1) }
}

/**
 * Telefon odbiorcy dla ShipX: 9 cyfr bez prefiksu kraju (format z dokumentacji ShipX, do potwierdzenia
 * na sandboxie). Odczyt wspólny z innymi przewoźnikami (lib/wysylka/telefon.ts): separatory i prefiks
 * +48 / 0048 / 48 znikają; numer zagraniczny albo nieczytelny = błąd „telefon” bez wartości numeru.
 */
export function telefonShipx(telefon: string): string {
  const pl = odczytajTelefon(telefon)?.krajowyPL
  if (!pl) throw new Error('Przesyłka nie jest gotowa: telefon')
  return pl
}

export function buildShipmentPayload(parcel: PreparedParcel, recipient: OdbiorcaPrzesylki & { kraj?: string | null }, ustawienia: UstawieniaZleceniaInpost, potwierdzoneOstrzezenia: readonly string[] = []): Record<string, unknown> {
  const bledy = parcel.problems.filter((p) => p.poziom === 'BLAD' || !potwierdzoneOstrzezenia.includes(p.kod))
  if (bledy.length) throw new Error(`Przesyłka nie jest gotowa: ${bledy.map((p) => p.kod).join(', ')}`)
  if (recipient.kraj && recipient.kraj.trim().toUpperCase() !== 'PL') throw new Error('Przesyłka nie jest gotowa: kraj')
  const phone = telefonShipx(recipient.telefon)
  if (!isUsluga(parcel.courierCode)) throw new Error('Przesyłka nie jest gotowa: nieznana usługa ShipX')
  const paczkomat = parcel.courierCode === 'inpost_locker_standard'
  if (paczkomat && !parcel.pickupPoint) throw new Error('Przesyłka nie jest gotowa: punkt')
  const szablon = isGabaryt(parcel.gabaryt) ? SZABLON_INPOST[parcel.gabaryt] : undefined
  if (paczkomat && !szablon) throw new Error('Przesyłka nie jest gotowa: gabaryt')
  if (!paczkomat && (parcel.sideXCm === null || parcel.sideYCm === null || parcel.sideZCm === null || parcel.weightKg === null)) throw new Error('Przesyłka nie jest gotowa: wymiary')
  // pełny adres idzie zawsze, gdy jest; przy paczkomacie niepełny adres domowy pomijamy (FAQ integracji InPost:
  // adres niepotrzebny przy paczkomacie), zamiast wysyłać ulicę bez numeru albo zgadywać numer. Kurier: adres wymagany.
  const adresPelny = !!(recipient.ulica && recipient.numerDomu && recipient.kodPocztowy && recipient.miasto)
  if (!paczkomat && !adresPelny) throw new Error('Przesyłka nie jest gotowa: adres odbiorcy')
  const pln = (amount: number) => ({ amount, currency: 'PLN' })
  return {
    service: parcel.courierCode,
    receiver: {
      ...imieINazwisko(recipient.imieNazwisko),
      ...(recipient.firma ? { company_name: recipient.firma } : {}),
      email: recipient.email,
      phone, // 9 cyfr bez +48 [NIEPEWNE: do potwierdzenia na sandboxie]
      ...(adresPelny
        ? {
            address: {
              street: recipient.ulica,
              building_number: recipient.numerLokalu ? `${recipient.numerDomu}/${recipient.numerLokalu}` : recipient.numerDomu,
              city: recipient.miasto,
              post_code: recipient.kodPocztowy,
              country_code: 'PL',
            },
          }
        : {}),
    },
    // [NIEPEWNE: dokładny kształt parcels; paczkomat szablonem, kurier wymiarami w mm i wagą w kg]
    parcels: paczkomat
      ? [{ template: szablon }]
      : [{ dimensions: { length: parcel.sideXCm! * 10, width: parcel.sideYCm! * 10, height: parcel.sideZCm! * 10, unit: 'mm' }, weight: { amount: parcel.weightKg, unit: 'kg' } }],
    custom_attributes: { sending_method: ustawienia.sendingMethod, ...(paczkomat ? { target_point: parcel.pickupPoint } : {}) },
    // [NIEPEWNE: czy pobranie wymaga ubezpieczenia co najmniej na tę kwotę] — przygotowane z ostrzeżeniem `pobranie_ubezpieczenie`
    ...(parcel.codAmount !== null ? { cod: pln(parcel.codAmount), insurance: pln(parcel.codAmount) } : {}),
  }
}
