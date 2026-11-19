// Role i uprawnienia w obrębie firmy. Czyste funkcje — testy w uprawnienia.test.ts.
//
// Rola daje zestaw domyślny; `Membership.permissions` dokłada pojedyncze uprawnienia konkretnej osobie, a
// `Membership.deniedPermissions` odbiera jej pojedyncze uprawnienia z zestawu roli (rola jest punktem startu)
// (makiety, odpowiedź właściciela 5: „ma to wynikać z uprawnień nadawanych w ustawieniach”, np. anulowanie
// po fakturze tylko dla wybranych osób). Uprawnienia zapisu są zdefiniowane już teraz, choć panel tylko czyta —
// ekrany z akcjami sprawdzają je tą samą funkcją `can`.
import type { MemberRole } from '@prisma/client'

export const PERMISSIONS = {
  'panel.podglad': 'Podgląd panelu (pulpit, zamówienia, produkty, braki)',
  'pakowanie.kurier': 'Kolejka pakowania: „Przyjechał kurier” (zamyka odbiór przewoźnika i przenosi spakowane z numerem nadania do „Wysłane”: mail do klienta, status w sklepie)',
  'rozjazdy.podglad': 'Porównanie z BaseLinkerem',
  // przychód firmy, marża i koszt zakupu w przekroju kanałów i produktów to dane
  // właściciela, nie magazynu (rola Magazyn domyślnie bez); eksport listy zamówień zostaje przy podglądzie panelu
  'raporty.sprzedaz': 'Raporty sprzedaży i marża (ekran Raporty i eksport raportu do Excela)',
  'zamowienia.anuluj_po_fakturze': 'Anulowanie zamówienia po wystawieniu faktury',
  'zamowienia.oznacz_oplacone': 'Ręczne „Oznacz jako opłacone”',
  'zwroty.pieniadze': 'Zwroty pieniędzy',
  // zwroty i reklamacje w Kompletorze (przyjęcie paczki magazyn, korekta faktury biuro)
  'zwroty.przyjecie': 'Zwroty i reklamacje: zgłoszenie, odbiór paczki (na stan albo uszkodzone), odrzucenie',
  'zwroty.korekty': 'Zwroty: zlecenie korekty faktury i zakończenie zwrotu z korektą wystawioną poza Kompletorem',
  'produkty.zatwierdzanie': 'Zatwierdzanie zdjęć i opisów produktów',
  'produkty.dodawanie': 'Dodawanie i edycja produktów (dane, zdjęcia, zestawy) i lista produktów bez stanu',
  'kanaly.tryb': 'Zmiana trybu kanału (tylko podgląd albo aktywny) i wyłącznika zapisu do sklepu',
  'pakowanie.stanowisko': 'Stanowisko pakowania: druk kart i pakowanie (także pakowanie próbne)',
  'pakowanie.do_poprawy': 'Zamykanie pozycji „Do poprawy” po pakowaniu próbnym',
  'braki.decyzje': 'Brak towaru: decyzja obsługi (wyślij resztę, dośle, poczekaj, zamień produkt)',
  ustawienia: 'Ustawienia firmy',
  uzytkownicy: 'Użytkownicy i uprawnienia',
  // dane klienta w zamówieniu (lib/klienci/odczyt.ts sprawdza je po stronie serwera przy każdym odczycie)
  'klienci.dane': 'Dane klienta: pełny podgląd, kopiowanie, wydruk z adresem, wyszukiwanie po kliencie, odświeżenie z kanału',
  'klienci.skrot': 'Dane klienta: imię, pierwsza litera nazwiska i miasto',
  'zamowienia.przejscia': 'Karta zamówienia: zmiana statusu (zbieranie, spakowanie, wysłane, odebrane) przy aktywnym kanale',
  // karta zamówienia docelowa (akcje tylko na koncie w trybie PRACA, poza notatkami)
  'zamowienia.edycja_pozycji': 'Karta zamówienia: dodawanie, usuwanie i zmiana ilości pozycji (tylko w Kompletorze, kanał bez zmian)',
  // cena i VAT pozycji zmieniają kwotę zamówienia i dokument sprzedaży, więc osobno od ilości (rola Biuro
  // domyślnie bez: właściciel nadaje wybranym osobom w Ustawienia → Użytkownicy)
  'zamowienia.ceny_pozycji': 'Karta zamówienia: zmiana ceny i stawki VAT pozycji (tylko w Kompletorze, kanał bez zmian)',
  'zamowienia.podzial': 'Karta zamówienia: podział zamówienia na paczki',
  'zamowienia.notatki': 'Karta zamówienia: notatki wewnętrzne',
  // zamówienia ręczne i zmiana statusu z listy (ratowanie pomyłek, z powodem w historii)
  'zamowienia.dodawanie': 'Dodawanie zamówień ręcznych (Zamówienia → Dodaj zamówienie)',
  'zamowienia.status_dowolny': 'Zmiana statusu na dowolny dozwolony (z powodem w historii), także cofnięcie pomyłki',
  // przesyłka „do sprawdzenia u przewoźnika” rozstrzygana przez człowieka
  // faktura z programu do faktur na karcie zamówienia
  'zamowienia.faktury': 'Faktura na karcie zamówienia: pobranie PDF i „Ponów fakturę” po błędzie',
  'przesylki.rozstrzyganie': 'Przesyłka niejasna u przewoźnika: ręczne rozstrzygnięcie (istnieje z numerem albo nie powstała)',
} as const

export type Permission = keyof typeof PERMISSIONS

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[]

/**
 * uprawnienia w grupach na ekranie Ustawienia → Użytkownicy (kolejność ekranu). Każde uprawnienie jest
 * w dokładnie jednej grupie (test w uprawnienia.test.ts); nowe uprawnienie trzeba tu dopisać.
 */
export const GRUPY_UPRAWNIEN: readonly { tytul: string; uprawnienia: readonly Permission[] }[] = [
  { tytul: 'Podgląd', uprawnienia: ['panel.podglad', 'rozjazdy.podglad', 'raporty.sprzedaz'] },
  {
    tytul: 'Zamówienia',
    uprawnienia: [
      'zamowienia.przejscia',
      'zamowienia.notatki',
      'zamowienia.edycja_pozycji',
      'zamowienia.ceny_pozycji',
      'zamowienia.podzial',
      'zamowienia.dodawanie',
      'zamowienia.status_dowolny',
      'zamowienia.oznacz_oplacone',
      'zamowienia.anuluj_po_fakturze',
      'zamowienia.faktury',
    ],
  },
  { tytul: 'Dane klientów', uprawnienia: ['klienci.skrot', 'klienci.dane'] },
  { tytul: 'Magazyn i pakowanie', uprawnienia: ['pakowanie.stanowisko', 'pakowanie.kurier', 'pakowanie.do_poprawy', 'braki.decyzje', 'przesylki.rozstrzyganie'] },
  { tytul: 'Produkty', uprawnienia: ['produkty.dodawanie', 'produkty.zatwierdzanie'] },
  { tytul: 'Zwroty', uprawnienia: ['zwroty.przyjecie', 'zwroty.korekty', 'zwroty.pieniadze'] },
  { tytul: 'Administracja', uprawnienia: ['ustawienia', 'uzytkownicy', 'kanaly.tryb'] },
]

export const ROLE_LABEL: Record<MemberRole, string> = {
  WLASCICIEL: 'Właściciel',
  BIURO: 'Biuro',
  MAGAZYN: 'Magazyn',
}

const ROLE_DEFAULTS: Record<MemberRole, readonly Permission[]> = {
  WLASCICIEL: ALL_PERMISSIONS,
  BIURO: [
    'panel.podglad',
    'rozjazdy.podglad',
    'raporty.sprzedaz',
    'pakowanie.kurier',
    'pakowanie.do_poprawy',
    'braki.decyzje',
    'klienci.dane',
    'klienci.skrot',
    'zamowienia.przejscia',
    'zamowienia.edycja_pozycji',
    'zamowienia.podzial',
    'zamowienia.notatki',
    'zamowienia.dodawanie',
    'zamowienia.faktury',
    'zwroty.przyjecie',
    'zwroty.korekty',
  ],
  MAGAZYN: ['panel.podglad', 'pakowanie.kurier', 'pakowanie.stanowisko', 'klienci.skrot', 'zamowienia.przejscia', 'zamowienia.notatki', 'zwroty.przyjecie'],
}

export function isPermission(v: string): v is Permission {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, v)
}

/** Zestaw domyślny roli (punkt startu na ekranie Użytkownicy). */
export function uprawnieniaRoli(role: MemberRole): Set<Permission> {
  return new Set<Permission>(ROLE_DEFAULTS[role] ?? [])
}

/**
 * Członkostwo osoby w firmie tak, jak leży w bazie: rola, dołożone (`permissions`) i odebrane z zestawu roli
 * (`deniedPermissions`). Każdy odczyt członkostwa z bazy musi przynieść oba pola (strażnik: uprawnienia-odebrane.test.ts).
 */
export interface UprawnieniaOsoby {
  role: MemberRole
  permissions: readonly string[]
  deniedPermissions: readonly string[] | null
}

/**
 * Uprawnienia osoby w firmie: (zestaw roli ∪ dołożone) − odebrane. Jedyne miejsce, które to liczy: sesja panelu,
 * API, odczyt danych klienta i bezpieczniki zmian osób biorą wynik stąd. Nieznane nazwy z bazy są pomijane (nie dają
 * i nie odbierają niczego). Rola Właściciel ma zawsze komplet: odebranych się jej nie zapisuje (lib/panel/uzytkownicy.ts),
 * a gdyby jakieś leżały w bazie (np. zapis ręczny), też nic nie odbierają, więc firma zawsze ma kogoś z pełnym dostępem.
 */
export function permissionsOf(m: UprawnieniaOsoby): Set<Permission> {
  const out = uprawnieniaRoli(m.role)
  for (const p of m.permissions) if (isPermission(p)) out.add(p)
  if (m.role !== 'WLASCICIEL') for (const p of m.deniedPermissions ?? []) if (isPermission(p)) out.delete(p)
  return out
}

export function can(m: UprawnieniaOsoby, p: Permission): boolean {
  return permissionsOf(m).has(p)
}

/**
 * Zależności między uprawnieniami: zestaw, w którym czegoś brakuje, nic osobie nie daje, więc zapis jest odrzucany
 * z komunikatem. Podgląd panelu jest potrzebny zawsze: bez niego osoba widzi tylko „Brak dostępu do panelu”
 * (app/(panel)/layout.tsx) i nie zmieni nawet hasła; odcięcie osoby to „Wyłącz dostęp do firmy”, nie odznaczanie.
 * Pełne dane klienta bez skrótu działają (pełny podgląd obejmuje skrót, lib/klienci/odczyt.ts), więc tu ich nie ma.
 */
export function brakujaceZaleznosci(zestaw: ReadonlySet<Permission>): { uprawnienie: Permission | null; wymaga: Permission }[] {
  if (zestaw.has('panel.podglad')) return []
  const reszta = ALL_PERMISSIONS.filter((p) => p !== 'panel.podglad' && zestaw.has(p))
  return reszta.length ? reszta.map((p) => ({ uprawnienie: p, wymaga: 'panel.podglad' as const })) : [{ uprawnienie: null, wymaga: 'panel.podglad' }]
}
