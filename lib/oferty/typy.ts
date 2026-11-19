// Ofertowanie: wspólne typy dla podglądu ofert na kanały (Allegro teraz, Empik i Woo w Etapie 2).
// Wejście jest neutralne dla każdej firmy: dane produktu Kompletora + ustawienia firmy (mapa kategorii, marka,
// domyślne parametry, szablon opisu) jako DANE, nie stałe jednej firmy w kodzie. Mapa konkretnej firmy idzie do jej presetu.

/** Produkt Kompletora w postaci potrzebnej do oferty (mapowanie z `Product` + `ProductImage` robi ekran/akcja). */
export interface ProduktDoOferty {
  id: string
  nazwa: string
  sku: string
  ean: string | null
  /** Opis z karty produktu (HTML albo tekst); trafia do sekcji „Opis produktu”, gdy nie ma przygotowanej treści. */
  opis: string | null
  wagaG: number | null
  /** Cena brutto w PLN; null = brak ceny. */
  cenaBrutto: number | null
  /** Dostępna ilość do wystawienia. */
  stan: number
  /** Publiczne adresy zdjęć w kolejności (pierwsze = miniatura). */
  zdjecia: string[]
  /** Nazwy albo slugi kategorii w sklepie firmy (podpowiedź do mapy kategorii). */
  kategorieSklepu: string[]
  /** Cechy produktu (np. „Pojemność: 300 ml”) — dopasowywane do parametrów kategorii po nazwie. */
  atrybuty: { nazwa: string; wartosc: string }[]
}

export type WagaProblemu = 'blad' | 'ostrzezenie'

export interface ProblemOferty {
  /** Stały kod do logiki ekranu (np. przycisk „Wystaw” nieaktywny przy `bez_ean`). */
  kod: string
  waga: WagaProblemu
  /** Zdanie dla człowieka, po polsku, bez żargonu. */
  komunikat: string
  /** Pole, którego dotyczy (tytul, opis, parametry, zdjecia, cena, kategoria…). */
  pole?: string
}

export const maBledy = (p: ProblemOferty[]) => p.some((x) => x.waga === 'blad')
