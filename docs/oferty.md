# Oferty: podgląd i wystawianie na Allegro, w Empiku i w sklepie

Produkt zakładasz raz w Kompletorze, a z jego karty widzisz gotową ofertę na każdy kanał: sklep internetowy (WooCommerce), Allegro i Empik. Kompletor składa tytuł, kategorię, parametry, opis, zdjęcia, cenę i stan z danych produktu i pokazuje, czego brakuje. Nic nie wystawia się samo: ofertę wysyła wyłącznie przycisk „Wystaw”, a ten działa dopiero na koncie, na którym włączysz wystawianie ofert.

## Gdzie to jest

| Ekran | Droga z menu | Adres | Kto widzi |
| --- | --- | --- | --- |
| Podgląd ofert jednego produktu | **Produkty** → kliknięcie produktu → zakładka **„Publikacja”** (pasek zakładek karty produktu) | `/produkty/<id>/publikacja` | każdy zalogowany; przycisk „Wystaw”: uprawnienie `produkty.dodawanie` |
| Sprawdzenie wielu produktów naraz | **Produkty** → pola wyboru przy produktach → przycisk **„Przygotuj oferty (N)”** na pasku nad listą | `/produkty` | `produkty.dodawanie` (bez niego lista nie ma pól wyboru) |
| Raporty sprawdzeń | **Produkty** → przycisk **„Przygotowane oferty”** (prawy górny róg, obok „Zdjęcia z feedu”) | `/produkty/przygotowanie-ofert` | `produkty.dodawanie` |
| Włączenie wystawiania na koncie | **Ustawienia → Sprzedaż i kanały → Kanały sprzedaży** → konto → sekcja **„Zapis do sklepu”** → przycisk **„Włącz wystawianie ofert”** | `/ustawienia/kanaly/<konto>` | `ustawienia` i zmiana trybu kont |
| Warunki konta Allegro (cennik dostaw, zwroty, reklamacje) | **Ustawienia → Sprzedaż i kanały → Kanały sprzedaży** → konto Allegro → **„Ustawienia i klucze”** | `/ustawienia/kanaly/<konto>` | `ustawienia` |

W menu nie ma osobnej pozycji „Oferty”: wszystko zaczyna się od listy albo karty produktu.

## Oferta z karty produktu

1. Otwórz **Produkty**, kliknij produkt i wybierz zakładkę **„Publikacja”**.
2. Na ekranie jest kafel na każde konto sklepu, Allegro i Empiku w firmie. W kaflu widzisz:
   - co powstanie po „Wystaw” (np. „Oferta do produktu z katalogu Allegro” albo „Nowy produkt w sklepie, jako szkic”),
   - tytuł, kategorię, cenę i stan,
   - parametry; brakujące wymagane są na czerwono z napisem „brak, uzupełnij”,
   - zdjęcia (zdjęcie bez adresu w sieci ma dopisek „bez adresu w sieci”) i opis (rozwiń „Opis oferty”),
   - listę „Do poprawy”: „Błąd” blokuje wystawienie, „Uwaga” tylko ostrzega.
3. Popraw dane na karcie produktu (sekcja „Dane produktu” albo zakładka „Zdjęcia”), wróć do „Publikacji” i kliknij **„Odśwież podgląd”**.
4. Gdy kafel pokazuje „Oferta gotowa”, a konto ma włączone wystawianie, kliknij **„Wystaw”** i potwierdź. Oferta powstaje w kanale od razu. Na Allegro powstaje jako nieaktywna: sprawdzasz ją i włączasz sprzedaż w Allegro. W sklepie powstaje jako szkic.

Po udanym wystawieniu na Allegro albo w sklepie nowa oferta sama wiąże się z produktem (to samo co „Powiąż z ofertą” na karcie produktu, zakładka „Powiązania”). Gdy to się nie uda, komunikat mówi dlaczego, a ofertę wiążesz ręcznie: karta produktu → **Powiązania** → **„Powiąż z ofertą”**. Empik oddaje najpierw numer pliku z ofertami, a nie numer oferty, więc ofertę Empiku Kompletor połączy z produktem po SKU dopiero przy pobieraniu ofert.

### Zmiana kategorii i uzupełnienie parametrów (Allegro)

Kategorię Allegro Kompletor dobiera sam: najpierw z mapy kategorii firmy (słowa w nazwie albo kategorii sklepu), a gdy jej nie ma, z propozycji Allegro dla nazwy produktu. W kaflu Allegro możesz to zmienić:

- **„Zmień kategorię”**: lista kategorii zaproponowanych przez Allegro. Po wyborze podgląd liczy parametry nowej kategorii. Pozycja „Dobierz automatycznie” wraca do kategorii dobranej przez Kompletor.
- **„Uzupełnij parametry”**: pola dla wymaganych parametrów bez wartości, z podpowiedziami ze słownika Allegro. Wpisz wartości i kliknij **„Zastosuj w podglądzie”**. **„Wyczyść ręczny wybór”** usuwa wpisane wartości i wybraną kategorię.

Ręczny wybór działa tylko na otwartym ekranie: „Wystaw” wysyła ofertę z tym, co widzisz w podglądzie, ale po zamknięciu strony wybór znika i nie zapisuje się przy produkcie. Na stałe uzupełniasz dane na karcie produktu (np. cecha „Kraj pochodzenia” albo marka) i w mapie kategorii firmy. Empik i sklep biorą kategorię z katalogu kanału i z karty produktu, więc tam tej listy nie ma.

## Wiele produktów naraz: „Przygotuj oferty”

1. Na liście **Produkty** zaznacz produkty polem wyboru przy nazwie (pole w nagłówku tabeli zaznacza wszystkie na tej stronie; na telefonie zaznaczasz pojedynczo).
2. Kliknij **„Przygotuj oferty (N)”** na pasku nad listą. Naraz sprawdzisz od 1 do 500 produktów.
3. Kompletor sprawdza je w tle i otwiera raport. Strona raportu odświeża się sama, dopóki sprawdzanie trwa.

Raport **„Przygotowane oferty”** pokazuje dla każdego kanału, ile produktów jest gotowych do wystawienia, ile ma problemy, a ile nie udało się sprawdzić, oraz 10 najczęstszych problemów. Niżej jest tabela „Produkty do poprawy” z nazwą konta, listą problemów i linkiem do „Publikacji” produktu. Liczby dotyczą par produkt i konto: produkt sprawdzony na trzech kontach liczy się trzy razy.

Raport niczego nie wystawia i niczego nie zmienia w produktach. Oferty wystawiasz pojedynczo, z „Publikacji” każdego produktu. Lista ostatnich 20 sprawdzeń: **Produkty** → **„Przygotowane oferty”**.

## Czego wymaga Allegro

- **Kod EAN** produktu. Z nim Kompletor szuka produktu w katalogu Allegro: gdy go znajdzie, oferta podpina się pod produkt katalogowy (Allegro bierze z katalogu kategorię i parametry produktu). Gdy go nie ma, Kompletor przygotowuje nowy produkt z kategorią i parametrami.
- **Kategoria końcowa** (bez podkategorii) i **wymagane parametry tej kategorii**, m.in. EAN, marka, stan. Część wartości Kompletor bierze sam: EAN i wagę z karty, markę z ustawień firmy albo cechy „Marka”, stałe wartości firmy, cechy produktu o tej samej nazwie co parametr.
- **Tytuł** od 12 do 75 znaków, bez wykrzyknika i znaków „@”, „[”, „]”, bez słów pisanych samymi wielkimi literami, bez zachęt w rodzaju „kup teraz” i bez słów zakazanych przez regulamin Allegro.
- **Opis** bez linków, adresów e-mail i numerów telefonów, bez emoji i bez zachęt do kontaktu poza Allegro. Kompletor usuwa z opisu znaczniki, których Allegro nie przyjmuje, a resztę pokazuje na liście „Do poprawy”.
- **Zdjęcia** z adresem w sieci (zaczynającym się od https), bo Allegro pobiera je samo.
- **Cena** i **stan** większy od zera.
- Na koncie: **zgoda na zakładanie ofert** („Połącz ponownie z Allegro” z zaznaczonym „Stany ofert”) i **cennik dostaw** w „Ustawieniach i kluczach” konta. Warunki zwrotów i reklamacji podajesz tam, gdy masz ich kilka; przy jednym Allegro bierze domyślne.

## Czego wymaga Empik

- **Kod EAN.** Gdy produkt jest już w katalogu Empiku, Kompletor przygotowuje samą ofertę (cena, stan, SKU, stan „nowy”).
- Gdy produktu w katalogu nie ma, Kompletor przygotowuje **wniosek o nowy produkt**: tytuł, opis, zdjęcia z adresem w sieci i kategorię Empiku. Wniosek sprawdza ręcznie Empik i dopiero po jego akcepcie oferta może się pojawić. Kategorię Empiku Kompletor dobiera z mapy firmy; traktuj ją jako propozycję i sprawdź w kaflu.
- Na koncie: wersja z zapisem i włączone wystawianie ofert.

## Sklep internetowy (WooCommerce)

Kompletor pokazuje produkt w sklepie: nazwę, opis, zdjęcia, cenę, kategorie sklepu, SKU i EAN. Nowy produkt trafia do sklepu domyślnie jako szkic, który publikujesz w panelu sklepu. Gdy sklep ma już produkt z tym SKU, „Wystaw” jest nieaktywny: powiąż istniejący produkt sklepu na karcie produktu, zakładka „Powiązania”, zamiast zakładać drugi. Kategorie z karty, których sklep nie ma, są na liście „Do poprawy”.

## Dlaczego „Wystaw” jest nieaktywny

Pod przyciskiem jest lista powodów. Każdy usuwasz w innym miejscu:

| Powód na ekranie | Gdzie to poprawić |
| --- | --- |
| Firma nie ma konta danego kanału | **Ustawienia → Sprzedaż i kanały → Kanały sprzedaży** → „Dodaj konto”. Bez konta kafel pokazuje podgląd z samych danych produktu, bez sprawdzania katalogu i kategorii kanału. |
| Konto jest wyłączone | **Ustawienia → Sprzedaż i kanały → Kanały sprzedaży** → konto → włącz konto. |
| Konto tylko czyta z kanału | Ten sam ekran konta → sekcja **„Zapis do sklepu”** → przełączenie konta na wersję z zapisem. |
| Wystawianie ofert jest wyłączone na koncie | Ten sam ekran konta → **„Zapis do sklepu”** → **„Włącz wystawianie ofert”**. |
| Konto Allegro nie ma zgody na zakładanie ofert | Ekran konta Allegro → **„Połącz ponownie z Allegro”** z zaznaczonym „Stany ofert”. |
| Konto Allegro nie ma wybranego cennika dostaw | Ekran konta Allegro → **„Ustawienia i klucze”** → „Cennik dostaw (Allegro)”. |
| Produkt nie ma poprawnego kodu EAN | Karta produktu → sekcja **„Dane produktu”**, pole EAN. |
| Zdjęcia nie mają publicznego adresu (https) | Karta produktu → **„Zdjęcia”**: zdjęcie z adresem w sieci. Zdjęcia wgrane z dysku Kompletor jeszcze nie wysyła do kanałów. |
| Sklep ma już produkt z tym SKU | Karta produktu → **„Powiązania”** → „Powiąż z ofertą”. |
| Oferta ma błędy do poprawienia | Lista „Do poprawy” w kaflu: brakujące parametry uzupełnisz w „Uzupełnij parametry” albo na karcie produktu, tytuł i opis na karcie produktu. |
| Nie masz uprawnienia do wystawiania ofert | Właściciel nadaje `produkty.dodawanie` w **Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia**. |

## Włączenie wystawiania na koncie

Wystawianie ofert ma osobny przełącznik na każdym koncie, niezależny od wysyłania stanów i statusów:

1. **Ustawienia → Sprzedaż i kanały → Kanały sprzedaży** → kliknij konto.
2. Konto musi być w wersji z zapisem (sekcja **„Zapis do sklepu”**). Na koncie, które tylko czyta, przełącznika nie ma.
3. Kliknij **„Włącz wystawianie ofert”** i potwierdź. Zmiana trafia do historii zmian.

Wyłączenie („Wyłącz wystawianie”) zostawia na karcie produktu tylko podgląd; oferty już wystawione zostają bez zmian. Zmiana rodzaju konta wyłącza wystawianie razem z zapisem.

## Czego te ekrany nie robią

- Nie wystawiają niczego same: ani przy dodaniu produktu, ani po „Przygotuj oferty”. Oferta powstaje tylko po „Wystaw” i potwierdzeniu.
- Nie wystawiają wielu ofert jednym kliknięciem: masowo tylko sprawdzasz gotowość.
- Nie zmieniają ofert już wystawionych (cena, opis, zdjęcia) i ich nie kończą. Stan wystawionej oferty wysyła dalej zwykła wysyłka stanów.
- Nie wysyłają do kanałów zdjęć wgranych z dysku, tylko zdjęcia z adresem w sieci.
- Nie zapamiętują ręcznie wybranej kategorii i parametrów przy produkcie.
- Nie pokazują statusu wniosku o nowy produkt w Empiku: sprawdzasz go w panelu Empiku.

Co z tego jeszcze nie jest sprawdzone na prawdziwych kontach: [Co jeszcze nie działa](co-jeszcze-nie-dziala.md).
