// Reguły akcji: automaty BaseLinkera przeniesione do kodu, bez edytora reguł i makr. Tu tylko opis
// reguł (klucz, akcje BL, rodzaj maila); warunki i zapis planu w silnik.ts. Pełne mapowanie 33 + 2 akcji BL:
// docs/akcje-bl.md. Czyste dane — testy w akcje.test.ts.
import type { RodzajMaila } from '../maile'

export const REGULY = {
  'mail.brak-platnosci': {
    nazwa: 'Mail „Brak płatności”',
    bl: [12],
    cel: 'ZAMOWIENIE',
    mail: 'brak-platnosci',
    opis: 'Rdzeń ustawił przypomnienie (Order.reminderSentAt); termin anulowania z Order.reservationDeadline. Po nieudanej płatności online treść „Nieudana płatność online” z danymi do przelewu.',
  },
  'mail.faktura': {
    nazwa: 'Mail „Faktura”',
    bl: [10],
    cel: 'ZAMOWIENIE',
    mail: 'faktura',
    opis: 'Status Wysłane albo Odebrane i wystawiona faktura (z Kompletora albo, przy koncie „Tylko podgląd”, z BaseLinkera); jeden mail na fakturę.',
  },
  'mail.blad-faktury': {
    nazwa: 'Mail „Błąd przy wystawianiu faktury”',
    bl: [11],
    cel: 'ZAMOWIENIE',
    mail: 'blad-faktury',
    opis: 'Nieudana próba wystawienia faktury; mail do biura firmy, jeden na każdą próbę.',
  },
  'mail.gotowe-do-odbioru': {
    nazwa: 'Mail „Gotowe do odbioru”',
    bl: [14],
    cel: 'ZAMOWIENIE',
    mail: 'gotowe-do-odbioru',
    opis: 'Status Do odbioru (odbiór osobisty).',
  },
  'mail.niski-stan': {
    nazwa: 'Mail „Niski stan”',
    bl: ['P2'],
    cel: 'PRODUKT',
    mail: 'niski-stan', // szablon w lib/maile
    opis: 'Dostępne poniżej progu produktu; jeden mail na przejście poniżej progu, do biura firmy.',
  },
  // Zwroty i reklamacje: bez odpowiednika w automatach BL; działają tylko z włączonym wyłącznikiem firmy
  // `settings.akcje.maileZwrotow` (domyślnie wyłączony, także w presecie firmy).
  'mail.zwrot-przyjety': {
    nazwa: 'Mail „Zwrot dotarł”',
    bl: [],
    cel: 'ZAMOWIENIE',
    mail: 'zwrot-przyjety',
    opis: 'Paczka ze zwrotem odebrana w magazynie (zwrot nieodrzucony); jeden mail na zwrot, do klienta.',
  },
  'mail.reklamacja-przyjeta': {
    nazwa: 'Mail „Reklamacja dotarła”',
    bl: [],
    cel: 'ZAMOWIENIE',
    mail: 'reklamacja-przyjeta',
    opis: 'Paczka z reklamacją odebrana w magazynie (reklamacja nieodrzucona); jeden mail na reklamację, do klienta.',
  },
  'mail.zwrot-pieniedzy': {
    nazwa: 'Mail „Pieniądze zwrócone”',
    bl: [],
    cel: 'ZAMOWIENIE',
    mail: 'zwrot-pieniedzy',
    opis: 'Zwrot pieniędzy oznaczony przy zwrocie albo reklamacji; jeden mail na zwrot, do klienta.',
  },
} as const satisfies Record<string, { nazwa: string; bl: readonly (number | string)[]; cel: 'ZAMOWIENIE' | 'PRODUKT'; mail: RodzajMaila; opis: string }>

export type KluczReguly = keyof typeof REGULY

export const KLUCZE_REGUL = Object.keys(REGULY) as KluczReguly[]

export function isKluczReguly(v: string): v is KluczReguly {
  return Object.prototype.hasOwnProperty.call(REGULY, v)
}

/** Powód planu w trybie SUCHO (cień konta): BL robi to sam, my tylko zapisujemy „wysłałbym”. */
export const POWOD_SUCHO = 'tylko podgląd: Kompletor zapisuje, jaki mail by wysłał, a wysyła BaseLinker'
/** Powód planu w trybie PRACA: mail czeka na wysyłkę pocztą firmy (Ustawienia → Poczta). */
export const POWOD_PRACA = 'czeka na wysyłkę pocztą firmy (Ustawienia → Komunikacja i poczta → Poczta)'

/** Okno reguł poziomowych zamówień: starsze zmiany nie dostają planu (pierwszy przebieg nie zaplanuje całej historii). */
export const OKNO_MS = 7 * 24 * 3600_000

/**
 * Wyniki rozliczenia faktury BL (`BlInvoiceSnapshot.outcome`), przy których w cieniu faktura jest źródłem maila „Faktura”.
 * `NIC_DO_ROZLICZENIA` nie tworzy ruchu `BL_INVOICE`, a BL mail i tak wysyła; `BEZ_STANU` (sam e-book)
 * dokłada — bez takich wierszy nic się nie zmienia. KOREKTA i POZA_CIENIEM nie dają maila.
 */
export const WYNIKI_FAKTURY_BL = ['ZASTOSOWANA', 'BEZ_WZ', 'NIC_DO_ROZLICZENIA', 'BEZ_STANU'] as const

/** Rodzaj zadania workera (lib/worker/harmonogram.ts, zadania.ts). */
export const ZADANIE_PLANU = 'akcje-plan'
