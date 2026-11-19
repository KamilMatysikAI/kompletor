# Sklep IdoSell w Kompletorze

> **Stan na 09.11.2026: przygotowane, sprawdzone wyłącznie na symulowanym sklepie.** Nie łączyliśmy się jeszcze
> z prawdziwym sklepem IdoSell. Zanim podłączymy pierwszego sprzedawcę, zespół Kompletora przejdzie
> [„Listę do sprawdzenia na koncie testowym”](#lista-do-sprawdzenia-na-koncie-testowym).

Ten opis jest dla sprzedawcy, który ma sklep w IdoSell i chce, żeby Kompletor widział jego zamówienia i pilnował
stanów. Nie trzeba znać się na programowaniu: przygotowujesz klucz w panelu IdoSell i wklejasz go w Kompletorze.

## Gdzie to jest

**Ustawienia → Sprzedaż i kanały → Kanały sprzedaży → „Dodaj sklep” → kafel „IdoSell”** (adres `/ustawienia/kanaly/nowy?platforma=idosell`).
Kafel widzi osoba z uprawnieniem do ustawień firmy (właściciel albo administrator). Po zapisie konto ma własny ekran:
Ustawienia → Sprzedaż i kanały → Kanały sprzedaży → nazwa sklepu. Tam są wynik testu połączenia, tryb (podgląd albo praca), wyłącznik
zapisu i tabela „Statusy w sklepie”.

## Co Kompletor robi ze sklepem IdoSell

- **Czyta zamówienia** nowe i zmienione, mniej więcej co minutę: numer zamówienia z panelu, status, kwoty, sposób
  płatności i dostawy, kupione produkty z rozmiarami i ilościami.
- **Rezerwuje towar** od chwili złożenia zamówienia (także nieopłaconego), a zwalnia rezerwację, gdy zamówienie
  zostanie anulowane w sklepie.
- **Czyta produkty**: każdy rozmiar to osobna oferta (kod zewnętrzny, EAN z kodu producenta, stan w wybranym
  magazynie), żeby powiązać je z produktami w Kompletorze.
- **Zapisuje stany i statusy** dopiero po włączeniu zapisu (niżej). Wtedy ustawia w sklepie stan wyliczony przez
  Kompletor (zawsze wartość, nigdy „dodaj” albo „odejmij”) i zmienia status zamówienia według tabeli statusów.

## Czego Kompletor nie robi

- **Nie czyta danych klientów**: imion, adresów, e-maili, telefonów ani uwag. Z adresu do faktury sprawdza tylko,
  czy klient podał NIP (tak/nie).
- **Nie dopisuje numeru przesyłki do zamówienia w IdoSell.** IdoSell wymaga do tego numeru kuriera ze swojego
  słownika; ta część przyjdzie osobno, po próbie na koncie testowym.
- **Nie tworzy przesyłek po stronie IdoSell.** Przesyłki tworzysz w Kompletorze (Pakowanie → Przesyłki).
- **Nie zmienia cen, opisów ani produktów.**
- **Nie anuluje z Kompletora nieopłaconych zamówień w IdoSell.** To zostaje w panelu sklepu.

## Krok 1. Klucz API w panelu IdoSell

1. Zaloguj się do panelu IdoSell.
2. Utwórz klucz Admin API **[do potwierdzenia na koncie testowym: dokładna ścieżka menu, np. moduł API albo
   „Administracja → Aplikacje indywidualne”]**.
3. Daj kluczowi dostęp do **zamówień** i **produktów (stany magazynowe)**. Do samego odczytu wystarczy odczyt;
   zapis stanów i statusów wymaga prawa edycji tych dwóch obszarów.
4. Skopiuj klucz. Traktuj go jak hasło.

## Krok 2. Podłączenie w Kompletorze

1. Ustawienia → Sprzedaż i kanały → Kanały sprzedaży → „Dodaj sklep” → **IdoSell**.
2. Wpisz **adres panelu** zaczynający się od `https://` (np. `https://client12345.idosell.com` albo domena sklepu)
   i wklej **klucz API**.
3. Zapisz. Kompletor od razu sprawdza połączenie: pokazuje liczbę zamówień i produktów albo mówi, czego brakuje
   (np. „klucz API odrzucony przez IdoSell”, „klucz API bez uprawnienia do odczytu: produkty”).

W „Zaawansowane” są: **wersja API** (domyślnie v8), **numer magazynu w sklepie** (domyślnie 1, czyli M1: z niego
Kompletor czyta stan i do niego go zapisuje), strefa czasowa dat panelu, odstęp odczytu i rozmiar strony.

## Zapis stanów i statusów (wyłącznik)

Nowe konto zawsze startuje **bez zapisu**: Kompletor tylko czyta. Zapis rusza, gdy jednocześnie:

1. na ekranie konta włączysz **„Zapis do sklepu”**,
2. konto jest w **trybie pracy** (nie w podglądzie) dla stanów albo statusów.

Bez tego Kompletor nie wysyła do IdoSell żadnego żądania zapisu. W podglądzie zapisuje tylko, co *wysłałby*.

**Statusy w sklepie.** Tabela „Statusy w sklepie” na ekranie konta startuje **pusta** i dopóki jej nie uzupełnisz,
Kompletor nie zmienia statusów zamówień w IdoSell, nawet z włączonym zapisem i w trybie pracy (tak samo jak przy
Shoperze i PrestaShopie). Powód: zmiana statusu w IdoSell może wysłać klientowi e-mail ze sklepu, zależnie od ustawień
powiadomień w panelu IdoSell, a znaczenie części statusów nie jest jeszcze sprawdzone na prawdziwym sklepie (np. czy
„wysłane” to `handled` czy `finished`, punkt 11 listy niżej). Uzupełnij tabelę świadomie, po sprawdzeniu powiadomień w
swoim sklepie, np. „Wysłane” w Kompletorze → status, którego używasz dla wysłanych paczek. Kompletor nie cofa statusu
(np. z „Spakowane” na „W realizacji”) i nie rusza zamówień anulowanych albo połączonych w sklepie. Statusów, które
ustawia sam sklep albo kurier (połączone, nieodebrane, zagubione, fałszywe), w tabeli nie ma.

**Limity.** Gdy IdoSell odpowie „za dużo zapytań” (HTTP 429), Kompletor wstrzymuje resztę paczki i ponawia po czasie,
który poda sklep. Stan ustawiany jest bezwzględnie, więc ponowienie po zerwanym połączeniu nie zdubluje zmiany.

## Jak Kompletor rozumie statusy IdoSell

| Status w IdoSell | W Kompletorze |
|---|---|
| nowe, oczekuje na płatność, oczekuje na dostawę, w realizacji, wstrzymane, pakowane, spakowane, gotowe, oczekuje na wysyłkę | otwarte (rezerwuje) |
| wysłane, obsłużone w programie zewnętrznym, nieodebrane, zagubione, zwrot, reklamacja | zrealizowane (towar już wyszedł) |
| anulowane, fałszywe, połączone | anulowane (zwolnienie rezerwacji) |
| inny | otwarte, z ostrzeżeniem na karcie zamówienia |

## Ograniczenia

- Zamówienie z ilością ułamkową (np. 1,5 kg) Kompletor odrzuca jako nieczytelne i pokazuje w alertach, zamiast
  zaokrąglać.
- Rozmiar bez wpisu w wybranym magazynie jest nieczytelny (nie zero): sprawdź numer magazynu konta.
- Produkt bez danych magazynowych w IdoSell pokazuje się bez stanu.
- Zestawy IdoSell (bundle) dostają ostrzeżenie na pozycji, bo mogą zdejmować stan podwójnie.

## Lista do sprawdzenia na koncie testowym

Wszystko poniżej jest zebrane w kodzie w blokach `[NIEPEWNE]` (`lib/adaptery/idosell.ts`, `lib/zrodla/idosell.ts`).
Każdy punkt sprawdzamy na koncie testowym IdoSell, zanim ogłosimy integrację:

1. Ścieżka menu do klucza Admin API i nazwy uprawnień (zamówienia, produkty, stany).
2. Pusty wynik wyszukiwania: HTTP 404 z `faultCode` 2 czy 200 z pustą listą (obsługujemy oba).
3. Klucz listy wyników zamówień: `Results` czy `results` (obsługujemy oba).
4. Filtr `ordersDateType: modified` łapie też nowe zamówienie (data zmiany ustawiona przy złożeniu) i zmianę płatności.
5. Sortowanie `ordersBy: id ASC` jest stabilne między stronami.
6. Kwoty `orderCurrency` są brutto, a `orderProductsCost` + koszty dostawy i płatności dają kwotę zamówienia.
7. Wpłata zaksięgowana to `prepaids[].paymentStatus = "y"`; zwrot to `paymentType: repayment`.
8. `PUT products/stocks`: rozmiar wskazany `identType: "id"` (np. `uniw`), operacja `set`, `stock_id` magazynu.
   Czy IdoSell pozwala zapisać stan w M1, czy tylko w magazynach własnych innych niż M0. Czy odpowiedź zawiera wpis
   każdego wysłanego rozmiaru, czy tylko rozmiarów z błędami (przy `isSizesErrors: true` rozmiar bez wpisu liczymy jako
   niepewny i ponawiamy).
9. Czy sklep sam zdejmuje stan przy zamówieniu (model „sklep zdejmuje sam”), i od którego statusu. Od którego statusu
   IdoSell oddaje stan do magazynu: Kompletor liczy „nieodebrane” i „zagubione” jako zrealizowane (towar wraca tylko
   przez zwrot), więc jeśli sklep sam zwiększa stan przy `missing` albo `lost`, zobaczymy rozjazd stanów.
10. EAN rozmiaru: `productSizeCodeProducer` czy osobne pole.
11. Nazwy statusów po polsku i lista statusów, które API pozwala ustawić; czy zmiana statusu przez API wysyła e-mail.
    Który status oznacza „wysłane”, a który „dostarczone/zrealizowane”: `handled` czy `finished` (konektor Open
    Integration Platform czyta `handled` jako wysłane, a `finished` jako dostarczone). Od tego zależy podpowiedź w
    tabeli „Statusy w sklepie”.
12. Limit zapytań i nagłówek `Retry-After` przy 429.
13. Adres karty zamówienia w panelu (`/panel/orderd.php?idt=<numer>`) dla przycisku „Otwórz w sklepie”.
14. Pole waluty zamówienia (`currencyId` albo `billingCurrency`): nieczytelna waluta daje dziś PLN z ostrzeżeniem na
    karcie zamówienia (jak przy Shoperze); jeśli w IdoSell zdarza się brak waluty, zmienić to na błąd odczytu.
15. Liczba stron w odpowiedzi wyszukiwania (`resultsNumberPage`): gdy jej nie ma, Kompletor czyta dalej, dopóki strona
    jest pełna (zamówienia z dalszych stron nie giną).

Przy próbie: osobny sklep testowy, zapis włączony tylko na nim, żadnych prawdziwych zamówień.

## Źródła wiedzy o API

Oficjalna dokumentacja IdoSell Admin API (idosell.readme.io, v8) oraz konektor IdoSell z Open Integration Platform
(Apache-2.0, szczegóły w `THIRD_PARTY_NOTICES.md`). Kod Kompletora jest napisany od nowa w naszym kontrakcie adapterów.
