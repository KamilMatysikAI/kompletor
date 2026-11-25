// zachowanie konta kanału przy stanie 0 (jak „Stan zerowy” w systemach do zamówień). Kanał, który nie przyjmuje
// ilości 0 na aktywnej ofercie (Allegro: INVALID_OFFER_QUANTITY), przy stanie 0 KOŃCZY ofertę, a przy stanie dodatnim
// wznawia ofertę, którą zakończył Kompletor. Ustawienie konta, nie wyjątek w kodzie: pola konfiguracji są w manifeście
// adaptera, który to potrafi; host zapisu (lib/kanaly/zapis-host.ts) czyta stąd dobowy limit zakończeń (bezpiecznik
// przed masowym zamknięciem ofert po błędnym odczycie stanów).
import type { ConfigField } from './kontrakt'

export const KLUCZ_STAN_ZEROWY = 'stanZerowy'
export const STAN_ZEROWY_ZAKONCZ = 'ZAKONCZ'
export const STAN_ZEROWY_WYSLIJ_ZERO = 'WYSLIJ_ZERO'
export const KLUCZ_LIMIT_ZAKONCZEN = 'limitZakonczenDoba'
export const LIMIT_ZAKONCZEN_DOMYSLNIE = 100
export const LIMIT_ZAKONCZEN_MAX = 10_000

export const POLE_STANU_ZEROWEGO: ConfigField = {
  key: KLUCZ_STAN_ZEROWY,
  type: 'string',
  required: false,
  description: 'co zrobić z ofertą przy stanie 0 (domyślnie: zakończ ofertę; przy stanie dodatnim Kompletor wznawia tylko oferty, które sam zakończył)',
  options: [
    { value: STAN_ZEROWY_ZAKONCZ, label: 'Zakończ ofertę' },
    { value: STAN_ZEROWY_WYSLIJ_ZERO, label: 'Wyślij liczbę 0 (sklep może odrzucić)' },
  ],
}

export const POLE_LIMITU_ZAKONCZEN: ConfigField = {
  key: KLUCZ_LIMIT_ZAKONCZEN,
  type: 'number',
  required: false,
  description: `najwyżej tyle ofert Kompletor zakończy w ciągu 24 h (domyślnie ${LIMIT_ZAKONCZEN_DOMYSLNIE}); po przekroczeniu alert i stop kończenia`,
}

/** Czy konto przy stanie 0 kończy ofertę (brak albo zła wartość = tak, domyślnie). */
export function konczyPrzyZerze(config: Record<string, unknown> | null | undefined): boolean {
  return config?.[KLUCZ_STAN_ZEROWY] !== STAN_ZEROWY_WYSLIJ_ZERO
}

/** Dobowy limit zakończeń ofert konta (0–10 000; brak albo zła wartość = 100). */
export function limitZakonczen(config: Record<string, unknown> | null | undefined): number {
  const v = config?.[KLUCZ_LIMIT_ZAKONCZEN]
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,5}$/.test(v.trim()) ? Number(v.trim()) : NaN
  return Number.isInteger(n) && n >= 0 && n <= LIMIT_ZAKONCZEN_MAX ? n : LIMIT_ZAKONCZEN_DOMYSLNIE
}
