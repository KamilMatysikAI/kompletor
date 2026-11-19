// Dodatkowa przesyłka do tego samego zamówienia: dosyłka (reklamacja, brakujący towar), paczka zastępcza (zgubiona
// albo uszkodzona) i druga paczka (towar nie zmieścił się w jednej). Tu: słownik rodzajów, walidacja wejścia
// i liczenie paczki (czyste funkcje). Utworzenie u przewoźnika robi host przesyłek (`utworzDodatkowa`,
// lib/wysylka/nadanie.ts), jedyne miejsce wołające przewoźnika.
//
// Zasady (docs/przesylki.md, „Dodatkowa przesyłka”):
//   - status zamówienia, rezerwacje, rozchód, faktura i korekta bez zmian; zamówienie nie wraca do pakowania;
//   - do sklepu i kanału nic nie idzie (numer głównej przesyłki zostaje), bez maili i automatów;
//   - reguły drogi paczki (np. „Doręczona paczka = Odebrane”) liczą się od głównej przesyłki;
//   - bez pobrania (dosyłka nie pobiera pieniędzy drugi raz);
//   - każda wymaga rodzaju, powodu i potwierdzenia, a numer z okna chroni przed drugą etykietą przy ponownym kliknięciu.
import type { OrderStatus } from '@prisma/client'
import type { PreparedParcel } from '@/lib/adaptery/kontrakt'
import { GABARYTY, gabarytyDla, isGabaryt, type Gabaryt } from '@/lib/stanowisko/gabaryty'
import type { ZamowienieStanowiska } from '@/lib/stanowisko/zamowienia'
import { LICZENIE_PRZESYLKI, maLiczeniePrzesylki } from './moduly'
import { wagaZeSkladu } from './przesylka'

export const RODZAJE_DODATKOWEJ = {
  DOSYLKA: 'Dosyłka (reklamacja, brakujący towar)',
  ZASTEPCZA: 'Paczka zastępcza (zgubiona albo uszkodzona)',
  DODATKOWA: 'Druga paczka (towar nie zmieścił się w jednej)',
} as const
export type RodzajDodatkowej = keyof typeof RODZAJE_DODATKOWEJ
export const jestRodzajDodatkowej = (v: unknown): v is RodzajDodatkowej => typeof v === 'string' && Object.hasOwn(RODZAJE_DODATKOWEJ, v)

/** Krótka nazwa rodzaju do bloku „Przesyłki”, listy i raportu. */
export const NAZWA_RODZAJU: Record<RodzajDodatkowej, string> = { DOSYLKA: 'Dosyłka', ZASTEPCZA: 'Paczka zastępcza', DODATKOWA: 'Druga paczka' }

/** Statusy zamówienia, w których wolno dodać przesyłkę (główna musi już być utworzona). */
export const STATUSY_DODATKOWEJ: readonly OrderStatus[] = ['SPAKOWANE', 'DO_WYSLANIA', 'WYSLANE', 'ODEBRANE', 'REKLAMACJA']

export const POWOD_MIN = 5
export const POWOD_MAX = 300
/** Górna granica kosztu wpisywanego ręcznie (literówka typu 1500 zamiast 15,00). */
export const KOSZT_MAX = 2000

export interface WejscieDodatkowej {
  rodzaj: RodzajDodatkowej
  powod: string
  gabaryt: Gabaryt
  /** Koszt etykiety netto w zł; null = nie wpisano. */
  kosztNetto: number | null
}

/** Walidacja pól okna „Dodaj przesyłkę” (przed jakimkolwiek odczytem odbiorcy i przewoźnika). */
export function walidujDodatkowa(
  carrier: Parameters<typeof gabarytyDla>[0],
  pola: { rodzaj: unknown; powod: unknown; gabaryt: unknown; koszt: unknown; potwierdzam: unknown },
): { ok: true; wejscie: WejscieDodatkowej } | { ok: false; powod: string } {
  if (pola.potwierdzam !== true) return { ok: false, powod: 'Zaznacz, że ta przesyłka ma powstać: każda nowa etykieta jest płatna u przewoźnika.' }
  if (!jestRodzajDodatkowej(pola.rodzaj)) return { ok: false, powod: 'Wybierz rodzaj przesyłki: dosyłka, paczka zastępcza albo druga paczka.' }
  const powod = typeof pola.powod === 'string' ? pola.powod.replace(/\s+/g, ' ').trim() : ''
  if (powod.length < POWOD_MIN) return { ok: false, powod: `Wpisz powód (co najmniej ${POWOD_MIN} znaków), np. „reklamacja: brak jednego produktu”.` }
  if (powod.length > POWOD_MAX) return { ok: false, powod: `Powód może mieć najwyżej ${POWOD_MAX} znaków.` }
  const g = typeof pola.gabaryt === 'string' ? pola.gabaryt : ''
  if (!isGabaryt(g) || !gabarytyDla(carrier).includes(g)) return { ok: false, powod: 'Wybierz gabaryt paczki.' }
  let kosztNetto: number | null = null
  const k = typeof pola.koszt === 'string' ? pola.koszt.replace(/\s+/g, '').replace(',', '.') : typeof pola.koszt === 'number' ? String(pola.koszt) : ''
  if (k !== '') {
    if (!/^\d{1,4}(\.\d{1,2})?$/.test(k) || Number(k) > KOSZT_MAX) return { ok: false, powod: `Koszt etykiety wpisz w złotych netto, np. 14,50 (najwyżej ${KOSZT_MAX} zł), albo zostaw puste.` }
    kosztNetto = Number(k)
  }
  return { ok: true, wejscie: { rodzaj: pola.rodzaj, powod, gabaryt: g, kosztNetto } }
}

/**
 * Paczka dodatkowej przesyłki liczona modułem wybranej reguły: gabaryt z okna, waga ze składu zamówienia, zawsze bez
 * pobrania (stan płatności „opłacone”), punkt odbioru z danych klienta. Bez zapisu podglądu głównej przesyłki.
 * Moduł bez liczenia przesyłki = null.
 */
export function paczkaDodatkowej(
  z: Pick<ZamowienieStanowiska, 'carrier' | 'pozycje'>,
  adapterKey: string,
  config: Record<string, unknown>,
  gabaryt: Gabaryt,
  punktOdbioru: string | null,
): PreparedParcel | null {
  if (!maLiczeniePrzesylki(adapterKey) || !z.carrier) return null
  const waga = wagaZeSkladu(z.pozycje)
  const parcel = LICZENIE_PRZESYLKI[adapterKey](
    {
      carrier: z.carrier,
      courierCode: config['courierCode'],
      gabaryt,
      weightG: waga.gramy > 0 ? waga.gramy : null,
      weightComplete: waga.pelna,
      paymentState: 'PAID',
      paymentMethod: '',
      totalGross: null,
      codAmountUncertain: null,
      // u przewoźnika dodatkowa przesyłka jest osobną przesyłką jednopaczkową (własna referencja i etykieta), więc
      // DPD Pickup i salon Empik ją przyjmują jak każdą pojedynczą paczkę do tego samego punktu
      wielePaczek: false,
      pickupPoint: punktOdbioru,
    },
    config,
  )
  return { ...parcel, codAmount: null, problems: parcel.problems.filter((p) => !p.kod.startsWith('pobranie')) }
}

export const nazwaGabarytu = (g: string | null): string | null => (g && g in GABARYTY ? GABARYTY[g as Gabaryt] : g)
