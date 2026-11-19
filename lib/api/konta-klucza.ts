// Konta sprzedaży klucza obsługi klienta (kolumna `ApiKey.accounts`, JSON). Czyste funkcje, bez bazy.
//
// Klucz obsługi widzi wyłącznie zamówienia kont, które wybrano przy jego zakładaniu: albo jawnie „wszystkie konta
// firmy” (`{ "wszystkie": true }`), albo lista `{ "konta": [{ "kanal": "WOO", "konto": "<id konta>" }] }`. Granica
// leży po stronie serwera: parametr `konta` z żądania może ten zbiór tylko zawęzić. Wartość pusta, nieznana albo
// uszkodzona = brak kont (klucz nie widzi niczego), nigdy „wszystkie”.
import type { Channel } from '@prisma/client'
import type { KontoObslugi } from '@/lib/klienci/obsluga'

export type KontaKlucza = { wszystkie: true } | { wszystkie: false; konta: { kanal: Channel; konto: string }[] }

export const BRAK_KONT: KontaKlucza = { wszystkie: false, konta: [] }
/** Najwięcej kont przypisanych do jednego klucza. */
export const MAX_KONT_KLUCZA = 50

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Odczyt kolumny z bazy. Wszystko poza poprawnym kształtem = brak kont. */
export function kontaKluczaZBazy(v: unknown): KontaKlucza {
  if (!isObj(v)) return BRAK_KONT
  if (v.wszystkie === true) return { wszystkie: true }
  if (!Array.isArray(v.konta)) return BRAK_KONT
  const konta: { kanal: Channel; konto: string }[] = []
  for (const k of v.konta.slice(0, MAX_KONT_KLUCZA)) {
    if (!isObj(k) || typeof k.kanal !== 'string' || !k.kanal || typeof k.konto !== 'string' || !k.konto) continue
    konta.push({ kanal: k.kanal as Channel, konto: k.konto })
  }
  return { wszystkie: false, konta }
}

/** Zapis do kolumny (kształt jak w odczycie). */
export function kontaKluczaDoBazy(k: KontaKlucza): { wszystkie: true } | { konta: { kanal: Channel; konto: string }[] } {
  return k.wszystkie ? { wszystkie: true } : { konta: k.konta.map((x) => ({ kanal: x.kanal, konto: x.konto })) }
}

/**
 * Konta, w których szuka trasa obsługi: konta klucza zawężone do kont z żądania (dowolne z listy; `kanal` w żądaniu
 * opcjonalny). Klucz „wszystkie” = konta z żądania albo `undefined` (cała firma). Wynik `[]` = nic nie pasuje: zapytanie
 * idzie z warunkiem, który nie trafia w żaden wiersz, więc odpowiedź jest taka sama jak przy braku danych.
 */
export function kontaDoSzukania(klucz: KontaKlucza, zZadania: readonly KontoObslugi[] | undefined): KontoObslugi[] | undefined {
  const prosba = zZadania?.length ? zZadania : undefined
  if (klucz.wszystkie) return prosba ? [...prosba] : undefined
  if (!prosba) return klucz.konta.map((k) => ({ kanal: k.kanal, konto: k.konto }))
  return klucz.konta.filter((k) => prosba.some((p) => p.konto === k.konto && (!p.kanal || p.kanal === k.kanal))).map((k) => ({ kanal: k.kanal, konto: k.konto }))
}

/** Wartość pola formularza konta: `<KANAŁ>:<id konta>` (kanał bez dwukropka, id konta może go zawierać). */
export function kontoZPola(v: string): { kanal: string; konto: string } | null {
  const i = v.indexOf(':')
  if (i <= 0 || i === v.length - 1) return null
  return { kanal: v.slice(0, i), konto: v.slice(i + 1) }
}

export const poleKonta = (kanal: Channel, konto: string) => `${kanal}:${konto}`
