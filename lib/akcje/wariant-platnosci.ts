// Który mail idzie jako przypomnienie o płatności (plan `mail.brak-platnosci`): zwykły „Brak płatności” albo, po
// nieudanej płatności online, „Nieudana płatność online” z pytaniem o problem i danymi do przelewu. Wariant wynika
// z bieżącego stanu zamówienia, a nie z chwili planowania: wysyłka i podgląd liczą go drugi raz, więc zamówienie
// przełączone w międzyczasie na przelew tradycyjny dostaje zwykłe przypomnienie. Czyste funkcje bez bazy.
import type { PaymentState, Prisma } from '@prisma/client'
import { parseProfilFirmy } from '../firma/profil'

export type WariantPrzypomnienia = 'brak-platnosci' | 'nieudana-platnosc'

/**
 * Nieudana płatność online: znacznik z kanału (`Order.flags.nieudanaPlatnoscOnline`, schodzi przy przelewie
 * tradycyjnym i przy wpłacie) i brak jakiejkolwiek wpłaty. Częściowo opłacone, opłacone i pobranie = zwykły mail.
 */
export function wariantPrzypomnienia(o: { flags: Prisma.JsonValue | null; paymentState: PaymentState }): WariantPrzypomnienia {
  const f = o.flags && typeof o.flags === 'object' && !Array.isArray(o.flags) ? (o.flags as Record<string, unknown>) : {}
  return f['nieudanaPlatnoscOnline'] === true && o.paymentState === 'UNPAID' ? 'nieudana-platnosc' : 'brak-platnosci'
}

/** Dane do przelewu w mailu „Nieudana płatność online”: rachunek i odbiorca (pełna nazwa firmy) z Danych firmy. */
export interface DanePrzelewu {
  rachunek: string
  odbiorca: string
}

/**
 * Dane do przelewu z profilu firmy (`Organization.settings.firma`: `rachunek` i `nazwa`). Brak któregokolwiek = null:
 * bez nazwy w Danych firmy odbiorcą byłaby robocza nazwa firmy z systemu, więc takiego maila nie wysyłamy.
 */
export function danePrzelewu(settings: Prisma.JsonValue | null | undefined): DanePrzelewu | null {
  const p = parseProfilFirmy(settings)
  return p.rachunek && p.nazwa ? { rachunek: p.rachunek, odbiorca: p.nazwa } : null
}

/** Czego brakuje w Danych firmy do maila z danymi do przelewu (po polsku); pusta lista = komplet. */
export function brakiDanychPrzelewu(settings: Prisma.JsonValue | null | undefined): string[] {
  const p = parseProfilFirmy(settings)
  return [...(p.rachunek ? [] : ['numeru rachunku']), ...(p.nazwa ? [] : ['pełnej nazwy firmy'])]
}

/** Droga do ekranu, na którym biuro uzupełnia dane do przelewu. */
export const DROGA_DANYCH_FIRMY = 'Ustawienia → Dokumenty i faktury → Dane firmy'

/**
 * Informacja dla biura (plan, podgląd akcji, ustawienia): wariant z danymi do przelewu nie działa, klient dostaje
 * zwykły „Brak płatności”. `braki` z `brakiDanychPrzelewu`; pusta lista = ogólnie „danych do przelewu”.
 */
export function informacjaBezDanychPrzelewu(braki: string[]): string {
  const czego = braki.length ? braki.join(' i ') : 'danych do przelewu'
  return `Po nieudanej płatności online klient dostaje zwykły mail „Brak płatności”, a nie pytanie o płatność z danymi do przelewu, bo w Danych firmy brakuje ${czego} (uzupełnij w ${DROGA_DANYCH_FIRMY})`
}
