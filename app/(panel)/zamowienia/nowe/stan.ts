// Typy i mapowanie ekranu „Dodaj zamówienie”: wynik wyszukiwania produktu i klienta, stan formularza.
// Plik bez 'use server' (zwykłe funkcje i typy dla akcji i komponentu klienta).
import type { RekordKlienta } from '@/lib/klienci/rekord'
import type { DaneKlientaWe } from '@/lib/klienci/walidacja'

export interface StanNowego {
  blad: string | null
}

/** Jedno źródło z wyszukiwarką „Dodaj pozycję” na karcie zamówienia. */
export type { ProduktKatalogu as ProduktWyniku } from '@/lib/karta/szukaj-produktu'

export interface KlientWyniku {
  /** Jedna linia do listy wyników: nazwa albo firma, miasto, końcówka telefonu. */
  opis: string
  pola: DaneKlientaWe
}

/** Rekord klienta → pola formularza (te same nazwy co „Wpisz dane klienta” na karcie). */
export function klientDoFormularza(k: RekordKlienta): KlientWyniku {
  const d = k.dostawa
  const f = k.faktura
  const pola: DaneKlientaWe = {
    imie: k.nabywca?.imieNazwisko ?? d?.imieNazwisko ?? '',
    firma: k.nabywca?.firma ?? d?.firma ?? '',
    email: k.email ?? '',
    telefon: k.telefon ?? '',
    ulica: d?.ulica ?? '',
    dom: d?.numerDomu ?? '',
    lokal: d?.numerLokalu ?? '',
    kod: d?.kodPocztowy ?? '',
    miasto: d?.miasto ?? '',
    kraj: d?.kraj ?? 'PL',
    punkt: k.punktOdbioru?.kod ?? '',
    punkt_nazwa: k.punktOdbioru?.nazwa ?? '',
    f_nazwa: f?.nazwa ?? '',
    f_nip: f?.nip ?? '',
    f_ulica: f?.ulica ?? '',
    f_kod: f?.kodPocztowy ?? '',
    f_miasto: f?.miasto ?? '',
  }
  const kto = [pola.imie, pola.firma].filter(Boolean).join(', ') || pola.f_nazwa || 'klient'
  const tel = (k.telefon ?? '').replace(/\D/g, '')
  const opis = [kto, pola.miasto, f?.nip ? `NIP ${f.nip}` : null, tel ? `tel. …${tel.slice(-3)}` : null].filter(Boolean).join(' · ')
  return { opis, pola }
}
