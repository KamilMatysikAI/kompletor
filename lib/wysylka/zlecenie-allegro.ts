// Treść `POST /shipment-management/shipments/create-commands` Wysyłam z Allegro. Używają jej tylko testy
// z danymi fikcyjnymi i przyszły tryb PRACA: nic tego wyniku nie zapisuje ani nie wysyła, a strażnik klienta
// (lib/zrodla/allegro-wysylam.ts) odmawia `create-commands`. Wartość robocza (wymiary, waga, pobranie) nie jest
// potwierdzona: każde ostrzeżenie musi być świadomie przyjęte w argumencie.
// `suggestedInput` z `delivery-proposals` przychodzi w argumencie i żyje tylko w pamięci (nadawca i odbiorca to dane
// osobowe; system nie przechowuje adresów klientów). Nadpisujemy w nim wyłącznie `packages` i `cashOnDelivery`.
// Bez `deliveryMethodId` i `credentialsId` (przestarzałe: Allegro bierze metodę z zamówienia). Błędy bez wartości pól.
import type { PreparedParcel } from '../adaptery/kontrakt'

export interface OpcjeKomendyAllegro {
  /** UUID komendy (klucz idempotencji, np. deriveReference z lib/adaptery/rejestr.ts). */
  commandId: string
  referenceNumber?: string | null
  labelFormat: 'PDF' | 'ZPL'
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

// NIEPEWNE: czy `value` ma być liczbą czy tekstem (przykłady w specyfikacji są niespójne). Wysyłamy liczbę.
const cm = (value: number) => ({ value, unit: 'CENTIMETER' as const })

export function buildCreateCommandPayload(draft: PreparedParcel, suggestedInput: unknown, opcje: OpcjeKomendyAllegro, potwierdzoneOstrzezenia: readonly string[] = []): Record<string, unknown> {
  const bledy = draft.problems.filter((p) => p.poziom === 'BLAD' || !potwierdzoneOstrzezenia.includes(p.kod))
  if (bledy.length) throw new Error(`Przesyłka nie jest gotowa: ${bledy.map((p) => p.kod).join(', ')}`)
  if (!UUID_RE.test(opcje.commandId)) throw new Error('commandId musi być UUID')
  if (opcje.labelFormat !== 'PDF' && opcje.labelFormat !== 'ZPL') throw new Error('labelFormat: PDF albo ZPL')
  if (!isRecord(suggestedInput) || !isRecord(suggestedInput['sender']) || !isRecord(suggestedInput['receiver'])) throw new Error('suggestedInput bez nadawcy albo odbiorcy (sender, receiver)')
  if (draft.sideXCm === null || draft.sideYCm === null || draft.sideZCm === null || draft.weightKg === null || !(draft.weightKg > 0)) throw new Error('Przesyłka bez wymiarów albo wagi')
  const { deliveryMethodId: _metoda, credentialsId: _konto, packages: _paczki, cashOnDelivery: staryCod, ...reszta } = suggestedInput
  const input: Record<string, unknown> = {
    ...reszta,
    packages: [
      {
        type: 'PACKAGE',
        // kolejność jak w gabarycie: wysokość (A/B/C), szerokość, długość
        length: cm(draft.sideZCm),
        width: cm(draft.sideYCm),
        height: cm(draft.sideXCm),
        weight: { value: draft.weightKg, unit: 'KILOGRAMS' },
      },
    ],
    labelFormat: opcje.labelFormat,
    ...(opcje.referenceNumber ? { referenceNumber: opcje.referenceNumber } : {}),
  }
  if (draft.codAmount !== null) {
    // właściciel i numer konta wypłaty pobrania (sprzedawca, nie kupujący) z propozycji Allegro, gdy je podała
    const cod = isRecord(staryCod) ? staryCod : {}
    input['cashOnDelivery'] = {
      amount: draft.codAmount.toFixed(2),
      currency: 'PLN',
      ...(typeof cod['ownerName'] === 'string' ? { ownerName: cod['ownerName'] } : {}),
      ...(typeof cod['iban'] === 'string' ? { iban: cod['iban'] } : {}),
    }
  }
  return { commandId: opcje.commandId, input }
}
