// Komunikaty po akcjach karty zamówienia w adresie (dokończenie). Akcje serwera kończą
// się przekierowaniem na kartę; w adresie jedzie wyłącznie KOD, nigdy dowolny tekst, więc spreparowany link nie pokaże
// fałszywego komunikatu:
//   - sukces i informacja: klucz słownika `KOMUNIKATY_KARTY` (`?ok=pozycje.wiele&n=3`); akcje w lib/karta zwracają klucz
//     od razu, bez dopasowywania tekstu;
//   - błąd stały: kod słownika `BLEDY_KARTY` (`?blad=tryb-podgladu`);
//   - błąd z treścią z zapisu (lista odrzuconych pozycji, komunikat rdzenia): `?blad=szczegoly&k=<losowy id>`, a treść
//     leży w krótkotrwałym ciasteczku httpOnly ustawionym przez akcję serwera (lib/karta/komunikaty-serwer.ts). Strona
//     karty czyta je po stronie serwera i pokazuje tylko przy zgodnym id; obcy link pokaże najwyżej ogólne „nie udało się”.
// Moduł bez zależności serwera, czyta go też komponent klienta (toast-z-adresu.tsx).

function zmian(n: number): string {
  if (n === 1) return 'zmianę'
  const d = n % 10
  const s = n % 100
  return d >= 2 && d <= 4 && (s < 12 || s > 14) ? 'zmiany' : 'zmian'
}

/** Słownik: klucz → tekst (bez liczby) albo funkcja liczby `n`. */
export const KOMUNIKATY_KARTY = {
  zapisano: 'Zapisano.',
  'pozycje.jedna': 'Zapisano zmianę pozycji.',
  'pozycje.wiele': (n: number) => `Zapisano ${n} ${zmian(n)} pozycji.`,
  'pozycje.brak': 'Brak zmian do zapisania.',
  'pozycje.paczka': (n: number) => `Utworzono paczkę ${n}.`,
  'powiaz.dopieto': 'Oferta była już powiązana z tym produktem: dopięto produkt i rezerwację w tym zamówieniu.',
  'powiaz.bez-przeliczenia': 'Powiązanie oferty zapisane. To zamówienie nie przeliczyło się samo (np. jest już po zbieraniu): sprawdź je w historii.',
  'powiaz.przeliczone': (n: number) => `Powiązano. Przeliczone zamówienia z tą ofertą: ${n}.`,
  'powiaz.ok': 'Powiązano z produktem.',
  'opis.odswiezono': 'Odświeżono opis z kanału.',
  'opis.bez-zmian': 'Opis z kanału bez zmian.',
  notatka: 'Zapisano notatkę.',
  'klient.zapisano': 'Zapisano dane klienta.',
  'klient.usunieto': 'Usunięto dane klienta.',
  // edycja danych zamówienia z kanału (lib/klienci/edycja-danych.ts)
  'klient.kupujacy': 'Zapisano dane kupującego. Kolejny odczyt z kanału ich nie nadpisze.',
  'klient.faktura': 'Zapisano dane do faktury. Kolejny odczyt z kanału ich nie nadpisze.',
  'klient.faktura-ponow': 'Zapisano dane do faktury. Faktura KSeF czeka na ponowienie: kliknij „Ponów” w bloku „Faktura KSeF”, wyjdzie z poprawionymi danymi i tym samym numerem.',
  'klient.faktura-szkic': 'Zapisano dane do faktury. Szkic faktury KSeF złożono przed zmianą: kliknij „Przygotuj szkic ponownie” w bloku „Faktura KSeF”.',
  'klient.bez-zmian': 'Bez zmian: dane są takie same jak w formularzu.',
  'status.zmieniony': 'Zmieniono status.',
  'automat.wykonany': 'Wykonano automatyczną akcję (szczegóły w historii zamówienia).',
  // „Jednak jest na półce” z karty
  'brak.cofniety': 'Brak cofnięty: towar wrócił do paczki.',
  'brak.cofniety-bez-paczki': 'Brak cofnięty i stan poprawiony, ale towar nie wrócił do tej paczki (brak był już przeniesiony, np. „Dośle później”, albo stanu nie starczyło): sztuki dostaje najpierw przydział zamówień czekających na towar, a to, czego tu brakuje, zostaje brakiem do decyzji.',
  // „Wyszedł komplet” z karty i z listy Braki towaru → „Do zwrotu”
  'brak.komplet': 'Zapisane: paczka wyszła w komplecie, zwrotu nie robisz. Gdy faktura stoi z błędem, kliknij „Ponów fakturę”: wyjdzie na całość.',
  'brak.komplet-juz': 'Nic do zmiany: ten brak jest już zamknięty.',
} as const satisfies Record<string, string | ((n: number) => string)>

export type KluczKomunikatu = keyof typeof KOMUNIKATY_KARTY

/** Błędy stałe karty: kod w adresie → tekst. Teksty tu są jedynym źródłem (bramka.ts i pozycje.ts je importują). */
export const BLEDY_KARTY = {
  'brak-zamowienia': 'Nie ma takiego zamówienia.',
  'tryb-podgladu': 'Zmiany z karty działają tylko dla kont w trybie PRACA na instancji z włączonymi ekranami trybu PRACA.',
  'bez-uprawnienia': 'Nie masz uprawnienia do tej akcji (Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia).',
  'tylko-reczne': 'Firma zmienia pozycje tylko w zamówieniach ręcznych: zamówienia z kanałów zostają bez zmian.',
  'kanal-nie-zna': 'Kanał nie zna już tego zamówienia.',
  /** Komunikat, gdy w adresie jest kod spoza słownika albo treść szczegółów już wygasła. */
  // ten sam tekst po odmowie przejścia statusu, gdzie nic nie miało się zapisać
  nieznany: 'Nie udało się wykonać akcji. Odśwież kartę i sprawdź pozycje oraz historię zamówienia.',
} as const

export type KodBledu = keyof typeof BLEDY_KARTY

/** Kod błędu z treścią w ciasteczku (lib/karta/komunikaty-serwer.ts). */
export const KOD_SZCZEGOLY = 'szczegoly'
const ID_SZCZEGOLOW = /^[a-f0-9]{12}$/

/** Kod stałego błędu dla tekstu (dokładnie ten sam tekst) albo `null`, gdy tekst niesie treść z zapisu. */
export function kodBledu(tekst: string): KodBledu | null {
  for (const [kod, t] of Object.entries(BLEDY_KARTY) as [KodBledu, string][]) if (t === tekst) return kod
  return null
}

/** Tekst dla klucza z adresu; `null` dla nieznanego klucza albo brakującej/niepoprawnej liczby. */
export function tekstKomunikatu(klucz: string | null | undefined, n?: string | null): string | null {
  if (!klucz || !Object.hasOwn(KOMUNIKATY_KARTY, klucz)) return null
  const k = KOMUNIKATY_KARTY[klucz as KluczKomunikatu]
  if (typeof k === 'string') return k
  if (!n || !/^\d{1,6}$/.test(n)) return null
  return k(Number(n))
}

export interface KomunikatAkcji {
  /** Tekst błędu dla osoby (w adresie zamieniony na kod). */
  blad?: string | null
  /** Id szczegółów błędu w ciasteczku (gdy tekst nie jest błędem stałym); nadaje komunikaty-serwer.ts. */
  k?: string
  ok?: KluczKomunikatu | null
  info?: KluczKomunikatu | null
  n?: number
}

/** Adres karty z komunikatem: zawsze kod, nigdy tekst. Błąd ma pierwszeństwo przed sukcesem i informacją. */
export function adresKarty(id: string, w: KomunikatAkcji, kotwica = ''): string {
  const q = new URLSearchParams()
  if (w.blad) {
    const kod = kodBledu(w.blad)
    if (kod) q.set('blad', kod)
    else {
      q.set('blad', KOD_SZCZEGOLY)
      if (w.k && ID_SZCZEGOLOW.test(w.k)) q.set('k', w.k)
    }
  } else if (w.ok || w.info) {
    q.set(w.ok ? 'ok' : 'info', (w.ok ?? w.info)!)
    if (w.n !== undefined && typeof KOMUNIKATY_KARTY[(w.ok ?? w.info)!] === 'function') q.set('n', String(w.n))
  }
  const s = q.toString()
  return `/zamowienia/${id}${s ? `?${s}` : ''}${kotwica}`
}

/** Szczegóły błędu z ciasteczka (czyta strona karty po stronie serwera). */
export interface SzczegolyBledu {
  k: string
  tresc: string
}

/**
 * Komunikat z parametrów adresu karty (toast i baner bez JavaScriptu). `szczegoly` = treść z ciasteczka; pokazuje się
 * tylko przy zgodnym id z adresu.
 */
export function komunikatZAdresu(p: { get(k: string): string | null }, szczegoly?: SzczegolyBledu | null): { rodzaj: 'blad' | 'sukces' | 'info'; tresc: string } | null {
  const blad = p.get('blad')
  if (blad) {
    if (blad === KOD_SZCZEGOLY) {
      const k = p.get('k')
      if (k && szczegoly && szczegoly.k === k) return { rodzaj: 'blad', tresc: szczegoly.tresc.slice(0, 400) }
      return { rodzaj: 'blad', tresc: BLEDY_KARTY.nieznany }
    }
    return { rodzaj: 'blad', tresc: Object.hasOwn(BLEDY_KARTY, blad) ? BLEDY_KARTY[blad as KodBledu] : BLEDY_KARTY.nieznany }
  }
  const ok = tekstKomunikatu(p.get('ok'), p.get('n'))
  if (ok) return { rodzaj: 'sukces', tresc: ok }
  const info = tekstKomunikatu(p.get('info'), p.get('n'))
  if (info) return { rodzaj: 'info', tresc: info }
  return null
}

/** Parametry komunikatu, które karta zdejmuje z adresu po pokazaniu. */
export const PARAMETRY_KOMUNIKATU = ['ok', 'blad', 'info', 'n', 'k'] as const

/** Adres bez parametrów komunikatu (reszta zapytania i kotwica zostają), do `history.replaceState`. */
export function adresBezKomunikatu(sciezka: string, zapytanie: string, kotwica: string): string {
  const q = new URLSearchParams(zapytanie)
  for (const k of PARAMETRY_KOMUNIKATU) q.delete(k)
  const s = q.toString()
  return `${sciezka}${s ? `?${s}` : ''}${kotwica}`
}
