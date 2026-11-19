# Makieta: karta zamówienia docelowa

Karta zamówienia `/zamowienia/<id>` to jeden ekran, na którym biuro prowadzi zamówienie od przyjęcia do odbioru, bez
zaglądania do BaseLinkera. Układ wzorowany na karcie zamówienia w BL (nagłówek z akcjami, pozycje po lewej, klient i
wysyłka po prawej, historia na dole), ale ze stanami Kompletora. Nazwy po polsku, czasownikiem, bez nazw statusów z kodu.

Zasada: **przyciski zmieniające zamówienie są tylko na koncie w trybie PRACA** (wyłącznik `EKRANY_PRACA=1` instancji
i tryb konta kanału). Konto w cieniu widzi status, pozycje, klienta, podglądy i historię, a zamiast przycisków jedną
linię „Konto w trybie testowym: zamówienie prowadzi BaseLinker”.

## Układ

Pomysł układu z TwojOMS (licencja MIT; kod i style własne). Sekcje w odczycie, w pasku nagłówka sekcji (małe wersaliki
na szarym tle) jej przyciski i link „Edytuj” (edycja przez adres `?edytuj=pozycje|klient`, zapis i „Anuluj” wracają
do odczytu). Decyzja o braku jedyną kontrolką widoczną bez edycji.

```
1440 px
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│ SH 48213 [Do realizacji]  Jan Kowalski     ← →  1 863,50 zł  [Zacznij zbieranie] [Wydruki▾] [Więcej▾] │
├─────────────────────────────────────────────────────────────────────────────────────────────────┤
│ (Brakuje towaru: …) (Do wyjaśnienia: …) (Nie zapisano: … po błędzie zapisu)                       │
├───────────────────────────────┬───────────────────────────────┬─────────────────────────────────┤
│ WYSYŁKA                Edytuj │ DANE DO FAKTURY        Edytuj │ SZCZEGÓŁY ZAMÓWIENIA            │
│ Odbiorca, adres, punkt        │ Nazwa, NIP, adres             │ Kanał, numer w sklepie / BL,    │
│ Telefon, e-mail, uwagi        │                               │ paczki, złożone, ostatnia zmiana│
│ ─ Sposób, przewoźnik, koszt   │                               │ ─ Płatność, sposób, pobranie    │
│ [Kopiuj adres][Odśwież]       │                               │                                 │
├───────────────────────────────┴───────────────────────────────┴─────────────────────────────────┤
│ POZYCJE                                       3 poz. [Pobierz nazwy z kanału]           Edytuj  │
│ Produkt            Ilość     Cena brutto  VAT  Stan pozycji        Decyzja o braku              │
│ Majeranek 100 g    2 szt.    24,90 zł     23%  [zarezerwowane]     —                            │
│ Dzbanek 1 l        1 szt.    89,00 zł     23%  [brakuje: 1 szt.]   [Wyślij resztę (domyślnie) ▾]│
│                                         Razem netto 113,25 zł   VAT 26,05 zł   Razem brutto 139,30 zł │
│ [Dodaj pozycję] [Podziel zamówienie]                                                            │
├────────────────────────────────────────────────┬────────────────────────────────────────────────┤
│ PRZESYŁKA                [Pakuj na stanowisku] │ PŁATNOŚĆ                           [Opłacone]  │
├────────────────────────────────────────────────┼────────────────────────────────────────────────┤
│ DOKUMENT SPRZEDAŻY                             │ ZWROTY I REKLAMACJE (gdy są)                   │
│                                                │ NOTATKI WEWNĘTRZNE                             │
├────────────────────────────────────────────────┴────────────────────────────────────────────────┤
│ ▸ HISTORIA ZMIAN  5 zdarzeń                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

sekcja „Pozycje” stoi zaraz pod nagłówkiem i banerami, przed kartami Wysyłka, Dane do faktury i Szczegóły
zamówienia; wiersz pozycji: miniatura 40 px, nazwa, pod nią szara linia „SKU 03201 · EAN 5907131620075 · półka A-5-2 ·
oferta 10740/10742”, liczby w wąskich kolumnach do prawej.

390 px: ta sama kolejność w jednej kolumnie (Pozycje jako karty, Wysyłka, Dane do faktury, Szczegóły, Przesyłka,
Płatność, Dokument sprzedaży, Zwroty, Notatki, Historia), bez przewijania w poziomie, linki „Edytuj” po 44 px.

W trybie edycji pozycji: ilość z „usuń”, cena i VAT jako pola, pasek „Anuluj / Zapisz pozycje” po pierwszej zmianie,
w pasku nagłówka „Zakończ edycję”. W zamówieniu ręcznym „Edytuj” danych klienta zamienia karty „Wysyłka” i „Dane do
faktury” na formularz (Kupujący, Adres dostawy, Dane do faktury) z „Zapisz dane klienta” na dwie kolumny, „Szczegóły zamówienia” w trzeciej.

Niżej makieta pierwotna (historyczna, układ dwukolumnowy).

## Desktop (≥ 1000 px), makieta pierwotna

```
┌───────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ ← Zamówienia                                                                                          │
│ SH 48213  [Do realizacji]  Paczkomaty                       1 863,50 zł  [Zacznij zbieranie] [Spakuj] │
│ Sklep Przyprawki · złożone dziś 09:12 · numer w kanale 48213 · paczka 1 z 2       [Więcej ▾]          │
├───────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ (komunikat po akcji: czerwony błąd albo zielone „Zapisano”)                                          │
│ (Do wyjaśnienia: powód) (Brakuje towaru: …) (Zmiana tylko w Kompletorze, w kanale bez zmian)          │
├──────────────────────────────────────────────────────────────┬────────────────────────────────────────┤
│ POZYCJE                                          3 poz.       │ CO DALEJ (osadzone)        │
│ ┌──┐ Majeranek suszony 100 g        2 szt.   24,90 zł [zarez.]│  przyciski poboczne z powodem          │
│ └──┘ EG-100 · miejsce A-3                       [Zmień ilość] │  (główne są w nagłówku)                │
│ ┌──┐ Dzbanek szklany 1 l            1 szt.   89,00 zł [brakuje]├────────────────────────────────────────┤
│ └──┘ DZ-1L                           [Dośle później] [Usuń]   │ KLIENT I DOSTAWA           │
│ [+ Dodaj pozycję: SKU, ilość, cena]                           │  nabywca, adres, punkt, telefon, e-mail │
│ Suma pozycji              138,80 zł                           │  [Kopiuj adres] [Odśwież z kanału]      │
├──────────────────────────────────────────────────────────────┤├────────────────────────────────────────┤
│ PŁATNOŚĆ                                                      │ PRZESYŁKA                              │
│ Metoda: przelew · Stan: opłacone                              │  przewoźnik, gabaryt, waga, pobranie   │
│ Kwota zamówienia 138,80 zł · Zapłacono 113,90 zł              │  braki do uzupełnienia + formularz     │
│ Do dopłaty 24,90 zł                                           │  [Przygotuj przesyłkę] [Nadaj przesyłkę]│
│ [Oznacz jako opłacone] [Zapisz dopłatę] [Zwrot różnicy]       │  [Drukuj etykietę] / [Pobierz PDF]      │
│ Wpłaty: 05.11 przelew 113,90 zł (Anna) …                      ├────────────────────────────────────────┤
├──────────────────────────────────────────────────────────────┤│ FAKTURA                                │
│ BRAK TOWARU: CO DALEJ (bez zmian)                  │  stan słowem, numer                    │
│                                                               │  [Przygotuj fakturę] [Wystaw fakturę]   │
│                                                               ├────────────────────────────────────────┤
│                                                               │ ZWROTY I REKLAMACJE                    │
│                                                               │  lista zwrotów zamówienia              │
│                                                               │  [Zgłoś zwrot] [Zgłoś reklamację]       │
│                                                               ├────────────────────────────────────────┤
│                                                               │ NOTATKI WEWNĘTRZNE                     │
│                                                               │  Anna, dziś 10:02: klient prosi o …    │
│                                                               │  [Dodaj notatkę]                        │
├──────────────────────────────────────────────────────────────┴────────────────────────────────────────┤
│ HISTORIA ZMIAN                                           [Wszystko] [Tylko ludzie]                   │
│ dziś 10:05  Anna       Zmiana ilości: Majeranek suszony 1 → 2 szt.                                    │
│ dziś 09:12  system     Zamówienie przyjęte                                                            │
└───────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Mobile (390 px)

Jedna kolumna, bez przewijania w poziomie, każdy przycisk i pole co najmniej 44 px wysokości.

```
┌──────────────────────────────────┐
│ ← Zamówienia                     │
│ SH 48213                         │
│ [Do realizacji] Paczkomaty       │
│ Sklep Przyprawki · dziś 09:12    │
│ 1 863,50 zł                      │
│ [   Zacznij zbieranie   ]        │  przyciski główne na całą szerokość
│ [        Spakuj         ]        │
│ [       Więcej ▾        ]        │  menu rozwijane w dół, pozycje 44 px
├──────────────────────────────────┤
│ komunikaty                       │
├──────────────────────────────────┤
│ POZYCJE                          │  pozycja = karta: miniatura, nazwa,
│ ┌──┐ Majeranek suszony 100 g     │  pod spodem SKU, ilość × cena,
│ └──┘ EG-100 · 2 szt. × 24,90 zł  │  rezerwacja słowem, akcje pozycji
│      [zarezerwowane]             │  w rozwijanym „Zmień”
│      [Zmień ▾]                   │
│ Suma pozycji 138,80 zł           │
├──────────────────────────────────┤
│ PŁATNOŚĆ                         │
├──────────────────────────────────┤
│ CO DALEJ (poboczne)              │
│ KLIENT I DOSTAWA                 │
│ PRZESYŁKA                        │
│ FAKTURA                          │
│ ZWROTY I REKLAMACJE              │
│ NOTATKI WEWNĘTRZNE               │
├──────────────────────────────────┤
│ HISTORIA ZMIAN                   │
└──────────────────────────────────┘
```

Kolejność sekcji na telefonie: nagłówek, komunikaty, pozycje, płatność, brak towaru, Co dalej, klient, przesyłka,
faktura, zwroty, notatki, historia.

## Nagłówek

- numer zamówienia z przedrostkiem kanału (jak lista zamówień), kanał i nazwa konta, data złożenia, numer w kanale;
- status słowem w kolorze (`STATUS_LABEL` i `statusTone`), przewoźnik obok;
- kwota zamówienia brutto;
- „Paczka 2 z 2” z linkiem do drugiej paczki (dosłanie albo podział);
- przyciski główne: przyciski z „Co dalej” oznaczone jako główne (`glowny`) i dostępne, najwyżej 3; reszta w „Więcej”;
- menu „Więcej” (`<details>`, bez JavaScriptu): pozostałe przyciski „Co dalej”, „Kopiuj dane”, „Otwórz w kanale”,
  „Drukuj kartę”, „Podziel zamówienie”, „Zgłoś zwrot”, „Zgłoś reklamację”.

## Kolumna lewa

Pozycje: miniatura, nazwa (link do produktu), SKU, miejsce w magazynie, ilość w jednostce produktu, cena brutto,
rezerwacja słowem („zarezerwowane”, „brakuje”, „dośle później”, „wydane (faktura)”). Pozycja usunięta w kanale
przekreślona. Pod pozycjami suma pozycji. Edycja pozycji (dodaj, zmień ilość, usuń, „Dośle później”, podmiana przez
blok braku) tylko w trybie PRACA przed zbieraniem.

Płatność: metoda, stan, kwota zamówienia, kwota zapłacona (suma wpłat i dopłat minus zwroty), różnica: „Do dopłaty
X zł” albo „Do zwrotu X zł”. Lista wpłat z datą, metodą i autorem.

## Kolumna prawa

- **Co dalej**: komponent (`<CoDalej>`), tu przyciski poboczne i ich powody.
- **Klient i dostawa**: komponent (`<KlientZamowienia>`), bez zmian.
- **Przesyłka**: podgląd (przewoźnik, gabaryt, wymiary, waga, pobranie, problemy), lista braków do
  uzupełnienia z formularzem poprawki adresu, przyciski przesyłki.
- **Faktura**: stan faktury słowem („W kolejce”, „Wystawiona”, „Błąd: …”), numer, podgląd KSeF dla firm
  bez wFirmy, przyciski faktury.
- **Zwroty i reklamacje**: zwroty zamówienia (status słowem, data), linki do ekranu `/zwroty`.
- **Notatki wewnętrzne**: notatki biura i magazynu, autor i czas, edycja autora przez 15 minut.

## Dół

Historia zmian: zdarzenia zamówienia (`OrderEvent`) i dziennik zmian (`AuditLog` zamówienia i jego pozycji) na jednej
osi czasu, nowsze wyżej. Opis po ludzku (`eventLabel`), autor imieniem albo „system”. Filtr „Tylko ludzie” (adres
`?historia=ludzie`, bez JavaScriptu). Bez danych klienta i bez wpisów dziennika podglądów danych klienta (te są w
Ustawienia → Zespół i dostęp → Dane klientów).

## Przyciski

„PRACA” w kolumnie „Kiedy widoczny” = konto kanału w trybie PRACA i instancja z `EKRANY_PRACA=1`. Każda akcja serwera
sprawdza to samo jeszcze raz (ręczne wywołanie z pominięciem ekranu kończy się odmową).

| Nazwa na ekranie | Gdzie stoi | Uprawnienie | Kiedy widoczny | Kiedy niedostępny i powód | Potwierdzenie |
| --- | --- | --- | --- | --- | --- |
| Przyciski statusu („Oznacz jako opłacone”, „Zacznij zbieranie”, „Zebrane”, „Spakuj”, „Do wysyłki”, „Do odbioru”, „Wysłane”, „Odebrane”, „Wyjaśnione”) | nagłówek (główne), „Co dalej” (poboczne) | `zamowienia.przejscia` (+ `zamowienia.oznacz_oplacone` dla opłacenia) | PRACA, wg statusu (`dostepnePrzejscia`) | powód z `dostepnePrzejscia`, np. „Najpierw faktura…” | nie |
| Anuluj zamówienie, Przerwij zbieranie, Wyślij bez faktury | „Więcej” i „Co dalej” | `zamowienia.przejscia` (+ `zamowienia.anuluj_po_fakturze` po fakturze) | PRACA, wg statusu | powód z `dostepnePrzejscia` | anulowanie i „Wyślij bez faktury”: tak |
| Dodaj pozycję | pod pozycjami | `zamowienia.edycja_pozycji` | PRACA, status Nowe, Do realizacji, Do wyjaśnienia; kanał wg ustawienia `edycjaZamowienKanalow` | po wydruku: „Zamówienie jest już zbierane, najpierw przerwij zbieranie”; brak produktu: „Nie ma produktu o tym SKU” | nie |
| Zmień ilość | przy pozycji | `zamowienia.edycja_pozycji` | jak wyżej, pozycja z produktem | jak wyżej; ilość poniżej dosłanej: „Najpierw cofnij dosłanie albo zamianę” | nie |
| Usuń pozycję | przy pozycji | `zamowienia.edycja_pozycji` | jak wyżej | jak wyżej; ostatnia pozycja: „Zamówienie musi mieć pozycję: anuluj je zamiast usuwać” | tak |
| Zamień produkt | blok „Brak towaru” | `braki.decyzje` | pozycja z brakiem | bez zmian | nie |
| Dośle później | przy pozycji z brakiem i blok „Brak towaru” | `braki.decyzje` | PRACA, otwarty brak, zamówienie opłacone albo za pobraniem | „„Dośle później” tylko dla zamówień opłaconych albo za pobraniem” | nie |
| Podziel zamówienie | „Więcej” | `zamowienia.podzial` | PRACA, status Nowe, Do realizacji, Do wyjaśnienia, co najmniej 2 pozycje | jak przy edycji pozycji | tak |
| Oznacz jako opłacone | „Płatność” | `zamowienia.oznacz_oplacone` | PRACA, zamówienie nieopłacone | brak | nie |
| Zapisz dopłatę | „Płatność” | `zamowienia.oznacz_oplacone` | PRACA, zamówienie nie za pobraniem | zła kwota: „Kwota: liczba większa od zera, najwyżej 2 miejsca po przecinku” | nie |
| Zwrot różnicy | „Płatność” | `zwroty.pieniadze` | PRACA, „Do zwrotu” > 0 | kwota większa niż różnica: „Kwota większa niż różnica do zwrotu” | tak |
| Przygotuj przesyłkę | „Przesyłka” | `pakowanie.stanowisko` | gdy przesyłka dotyczy zamówienia (także w cieniu: tylko podgląd) | „Nie dotyczy …” z `prepareForOrder` | nie |
| Popraw adres do przesyłki | „Przesyłka”, pod brakami | `klienci.dane` | gdy przygotowanie zgłosiło brak adresu | błąd walidacji jednym zdaniem | nie |
| Nadaj przesyłkę (etap 4, jeszcze nie zrobione) | „Przesyłka” | `przesylki.nadaj` | PRACA, konto z `nadawanieWlaczone`, status Spakowane albo Do wysłania, przygotowanie bez błędów | błąd kuriera jednym zdaniem bez danych klienta | tak |
| Drukuj etykietę / Pobierz PDF (etap 4, jeszcze nie zrobione) | „Przesyłka” | `przesylki.nadaj` | PRACA, po nadaniu | brak stanowiska druku: tylko „Pobierz PDF” | nie |
| Drukuj kartę | „Więcej” | `pakowanie.stanowisko` | zawsze (karta zbierania) | brak stanowiska druku: tylko „Pobierz PDF” | nie |
| Przygotuj fakturę | „Faktura” | `zamowienia.anuluj_po_fakturze` (KSeF) | firma bez wFirmy (KSeF); dla wFirmy podgląd z raportu dnia | „Nie dotyczy …” | nie |
| Wystaw fakturę (etap 5, jeszcze nie zrobione) | „Faktura” | `faktury.wystaw` | PRACA, konto z `fakturyWlaczone`, zamówienie spakowane, bez faktury w kolejce | „Faktura już jest w kolejce albo wystawiona” | tak |
| Zgłoś zwrot / Zgłoś reklamację | „Zwroty i reklamacje” i „Więcej” | `panel.podglad` (ekran zwrotów) | zawsze |: (link do `/zwroty?zamowienie=<id>`) | nie |
| Dodaj notatkę | „Notatki wewnętrzne” | `zamowienia.notatki` | zawsze (także w cieniu: notatka nie zmienia zamówienia) | pusta albo za długa: „Notatka: od 1 do 2000 znaków” | nie |
| Popraw notatkę | przy własnej notatce | `zamowienia.notatki` | autor, przez 15 minut od dodania | po 15 minutach: „Notatkę można poprawić tylko przez 15 minut” | nie |
| Kopiuj adres dostawy / e-mail / telefon | „Więcej” → „Kopiuj dane” | `klienci.dane` | gdy są dane klienta | „Brak … do skopiowania” | nie |
| Kopiuj numer zamówienia | „Więcej” → „Kopiuj dane” | `panel.podglad` | zawsze | brak | nie |
| Otwórz w kanale | „Więcej” | `panel.podglad` | kanał ze znanym adresem panelu (Woo, Shoper, PrestaShop z adresem sklepu, Allegro, Empik) | brak przycisku, gdy adresu nie znamy | nie |

## Ustawienia, od których zależy karta

| Ustawienie | Gdzie | Domyślnie | Kto zmienia |
| --- | --- | --- | --- |
| `edycjaZamowienKanalow` | firma (`Organization.settings.karta`) | `true`: edycja pozycji także dla zamówień z kanałów; `false`: tylko ręczne | `ustawienia` |
| `nadawanieWlaczone` (etap 4) | konto kanału (`ChannelConfig`) | `false` | `kanaly.tryb` albo `ustawienia` |
| `fakturyWlaczone` (etap 5) | konto kanału (`ChannelConfig`) | `false` | `kanaly.tryb` albo `ustawienia` |
