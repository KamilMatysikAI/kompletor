// Granice ustawień zasad rezerwacji bez zależności serwerowych: czyta je i rdzeń (walidacja zapisu), i formularz
// w przeglądarce (pola, przykłady).

/** Najdłużej trzymany towar zamówienia z nieudaną płatnością online (godziny zegarowe). */
export const MAX_FAILED_ONLINE_HOLD_HOURS = 72

/** Pytanie o płatność z danymi do przelewu po nieudanej płatności online: od 1 (następny dzień) do 7 dni kalendarzowych. */
export const MIN_FAILED_ONLINE_REMINDER_DAYS = 1
export const MAX_FAILED_ONLINE_REMINDER_DAYS = 7

/** Godzina (czas polski), o której idzie pytanie o płatność po nieudanej płatności online. */
export const FAILED_ONLINE_REMINDER_HOUR = 9
