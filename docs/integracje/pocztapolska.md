# Poczta Polska (eNadawca)

Dla sprzedawcy, który ma umowę z Pocztą Polską i konto w eNadawcy, a chce nadawać paczki Pocztex Kurier pod adres klienta prosto z Kompletora.

Stan: moduł napisany i sprawdzony na atrapie usług Poczty Polskiej. Na koncie testowym eNadawcy jeszcze nie: lista rzeczy do sprawdzenia jest na końcu.

## Jak działa eNadawca: bufor i partia

eNadawca nie nadaje każdej paczki osobno. Przesyłki trafiają najpierw do **bufora** (lista paczek przygotowanych do nadania). Dopiero **wysłanie bufora** do urzędu nadania („wyślij partię”) zamyka listę: od tej chwili Poczta czeka na te paczki w urzędzie albo u kuriera i nic w nich nie da się już zmienić przez Kompletor.

Kompletor zakłada w eNadawcy własny bufor na każdy dzień nadania, z opisem „Kompletor xxxxxx RRRR-MM-DD”, gdzie „xxxxxx” to 6-znakowy znacznik firmy w Kompletorze. Dzięki znacznikowi dwie firmy albo kopia testowa i produkcyjna Kompletora na jednym koncie eNadawcy mają osobne bufory i nie wysyłają sobie nawzajem paczek. Bufory założone ręcznie w eNadawcy i paczki dodane tam ręcznie zostają nietknięte: Kompletor nigdy nie czyści całego bufora konta, a przesyłkę usuwa wyłącznie po jej własnym identyfikatorze.

## Co system robi

- **Liczy przesyłkę** na karcie zamówienia (Zamówienia → numer zamówienia → sekcja „Przesyłka”): format Pocztex S, M, L, XL albo 2XL z wymiarów paczki ustawionych w regule przewoźnika i wagę. Bez ustawionych wymiarów pokazuje wartości robocze z ostrzeżeniem.
- **Sprawdza połączenie** z kontem (Ustawienia → Wysyłka i druk → Przewoźnicy → przycisk „Konta przewoźników” → konto „Poczta Polska (eNadawca)” → „Sprawdź połączenie”): pokazuje urzędy nadania z umowy konta i ostrzega, gdy wpisany urząd nadania nie jest na tej liście.
- **Dodaje przesyłkę do partii dnia** (moduł „Poczta Polska (eNadawca, nadawanie za wyłącznikiem)”): przycisk „Utwórz przesyłkę” na karcie zamówienia. Kompletor zapisuje numer nadania i pobiera etykietę adresową w PDF.
- **Usuwa przesyłkę z partii** przyciskiem „Anuluj przesyłkę”, dopóki partia nie jest wysłana. Po wysłaniu partii anulowanie jest możliwe tylko w eNadawcy albo w placówce. „Już usunięta” Kompletor uznaje tylko wtedy, gdy eNadawca wprost odpowie „nie znaleziono”; gdy odczyt się nie uda albo odpowiedź jest niejasna, anulowanie kończy się błędem z prośbą: sprawdź i usuń przesyłkę w eNadawcy. Kompletor przeszukuje najwyżej 30 najnowszych niewysłanych partii; gdy jest ich więcej, a przesyłki w nich nie ma, anulowanie kończy się błędem „wyślij albo usuń stare partie”. Gdy przesyłkę usunięto ręcznie w eNadawcy, a anulowanie w Kompletorze dalej kończy się błędem (eNadawca odpowiada na brak przesyłki tekstem, którego Kompletor jeszcze nie zna), przesyłka zostaje w Kompletorze jako utworzona: zgłoś to opiekunowi Kompletora z numerem przesyłki, a do czasu poprawki nie twórz jej drugi raz w eNadawcy.
- **Wysyła partię** do urzędu nadania (funkcja „Wyślij partię” w module): wszystkie bufory Kompletora tej firmy z danego dnia i urzędu nadania. Dopiero po udanym wysłaniu, gdy w ustawieniach jest „Zamów kuriera”, zamawia jeden odbiór na godzinę z ustawień. Gdy Poczta nie odpowie na zamówienie kuriera, wynik brzmi „nie wiadomo, czy kurier jest zamówiony”: sprawdź w eNadawcy i nie zamawiaj drugi raz. Ponowne „Wyślij partię” po wysłaniu nie ma już czego wysyłać, więc kuriera drugi raz nie zamawia. Gdy wysyłka padnie w połowie (część partii wyszła), ponów „Wyślij partię”: wyśle resztę i dopiero wtedy zamówi kuriera, więc nie zamawiaj go ręcznie. Ręcznie zamawiasz odbiór tylko wtedy, gdy wynik brzmi „nie wiadomo, czy partia jest wysłana”, a w eNadawcy widzisz ją jako wysłaną.
- **Zgłasza zaległe partie.** Przesyłka dodana tuż przed północą trafia do bufora tamtego dnia, a „Wyślij partię” po północy domyślnie bierze bieżący dzień. Wynik pokazuje wtedy listę dni z niewysłanymi buforami Kompletora; wyślij je osobno z ich datą, inaczej te paczki nie trafią do urzędu. Tak samo zgłasza partie Kompletora założone na inny urząd nadania (po zmianie urzędu w ustawieniach w ciągu dnia): Kompletor ich nie wysyła, w wyniku są jako „RRRR-MM-DD (urząd N)”; wyślij je w eNadawcy albo przywróć tamten urząd i wyślij partię.
- **Śledzi przesyłkę** (usługa Śledzenie Poczty Polskiej), gdy w ustawieniach konta są osobny login i hasło do usługi Śledzenie: „przed nadaniem”, dopóki Poczta nie ma paczki, potem „przekazana”. Bez nich śledzenie jest wyłączone (login eNadawcy nie jest wysyłany do innej usługi). Odmowa usługi Śledzenie (zły login albo hasło) zatrzymuje tylko śledzenie i nie liczy się do automatycznego wyłączenia konta eNadawcy, więc nadawanie działa dalej.
- **Nie robi drugiej przesyłki**, gdy eNadawca nie odpowie. Identyfikator przesyłki w eNadawcy (GUID) wynika z referencji przesyłki w Kompletorze, więc ponowienie wysyła ten sam identyfikator. Pierwsze „Utwórz przesyłkę” od razu dodaje przesyłkę do partii. Przy ponowieniu (ta sama przesyłka po błędzie) Kompletor najpierw sam sprawdza, czy przesyłka o tym identyfikatorze już jest w eNadawcy (bufory Kompletora z ostatnich 5 dni i wysłane partie); jeśli jest, potwierdza ją zamiast dodawać drugą. Gdy eNadawca odpowie na dodanie błędem, którego Kompletor nie rozpoznaje, albo zgłosi powtórzony identyfikator, Kompletor sprawdza partię, do której dodawał, i przesyłkę po identyfikatorze; gdy tego nie da się rozstrzygnąć, przesyłka czeka na „Sprawdź u przewoźnika”. „Sprawdź u przewoźnika” szuka w tych samych miejscach.
- **Pilnuje poprawek zamówienia.** Gdy przesyłka już jest w eNadawcy, a w zamówieniu zmienił się kod pocztowy, ulica z numerem, waga albo format, Kompletor usuwa z niewysłanej partii tylko tę jedną przesyłkę i dodaje ją z nowymi danymi (trzeba wydrukować nową etykietę). To samo robi, gdy nie odczyta z eNadawcy którejś z tych danych (nie da się potwierdzić, że są aktualne). Gdy dane dalej się różnią także po ponownym dodaniu, usuwa przesyłkę jeszcze raz i kończy się błędem „w eNadawcy nic nie zostało, utwórz ponownie”. Gdy partia jest już wysłana, kończy się błędem: popraw przesyłkę w eNadawcy albo w placówce; gdy w wysłanej partii nie da się odczytać danych, wynik brzmi „sprawdź w eNadawcy adres, masę i format” i przesyłka czeka na rozstrzygnięcie ręczne. W eNadawcy przesyłkę znajdziesz też po „numerze klienta” (początek referencji).

## Ryzyko, które zostaje

- **„Sprawdź u przewoźnika” nie porównuje adresu.** Odszukanie po referencji nie zna danych zamówienia, więc potwierdza przesyłkę o identyfikatorze tej przesyłki bez porównania adresu, masy i formatu (przesyłki z danymi, których Kompletor nie odczytał, nie potwierdza). Stara wersja z nieaktualnym adresem może zostać potwierdzona tylko wtedy, gdy przy poprawce zamówienia dwa razy z rzędu nie uda się jej usunąć z partii; Kompletor zgłasza to wtedy jako „nie wiadomo” z prośbą: usuń ją w eNadawcy, zanim klikniesz „Sprawdź u przewoźnika”.
- **Kopia testowa odtworzona ze zrzutu produkcji** ma ten sam identyfikator firmy, więc ten sam znacznik w nazwie bufora. Taka kopia nie może mieć konta eNadawcy produkcyjnej firmy, inaczej „Wyślij partię” w kopii wyśle paczki z produkcji. Kopia testowa łączy się wyłącznie z kontem testowym eNadawcy (środowisko „testowe”).

## Ustawienia konta

- Login i hasło eNadawcy (konto API). Środowisko: testowe (domyślnie) albo produkcyjne.
- **Urząd nadania** z umowy: bez niego Kompletor nie doda przesyłki.
- Wymiary i domyślna waga paczki (z nich liczy się format).
- „Zamów kuriera przy wysłaniu partii” i godzina odbioru (GG:MM). Bez tego paczki zawozisz do urzędu nadania.
- Osobny login i hasło do usługi Śledzenie; bez nich śledzenie jest wyłączone.

## Czego system nie robi

- Nie wysyła paczek za pobraniem ani z ubezpieczeniem: zamówienie za pobraniem pokazuje błąd „pobranie”.
- Nie nadaje za granicę, do punktów odbioru ani przesyłek listowych: tylko Pocztex Kurier pod adres w Polsce.
- Etykieta tylko w PDF.
- Przycisku „Wyślij partię” na liście przesyłek jeszcze nie ma: funkcja jest w module, ekran dojdzie razem z protokołami odbioru od przewoźników. Do tego czasu partię wysyłasz w eNadawcy (bufor „Kompletor xxxxxx RRRR-MM-DD”).
- Bez włączonego nadawania (`zapisWlaczony`) i trybu „praca” konta sprzedaży niczego nie wysyła do Poczty Polskiej.

## Do sprawdzenia na koncie testowym eNadawcy

Konto testowe wydaje Poczta Polska na prośbę klienta z umową. Przed pierwszą prawdziwą przesyłką trzeba sprawdzić:

1. Kształt żądań z WSDL eNadawcy: które pola przesyłki i bufora są atrybutami XML, a które elementami.
2. Czy eNadawca odrzuca drugą przesyłkę z tym samym GUID i jakim opisem błędu (od tego zależy rozpoznanie „już istnieje”).
3. Opisy błędów eNadawcy (tabela w `lib/adaptery/pocztapolska-kody.ts`).
4. Czy `getAddresLabelByGuidCompact` zwraca numer nadania przesyłki z wysłanej partii.
5. Progi formatów S…2XL i limity wagi z aktualnego cennika Pocztex.
6. Dane logowania usługi Śledzenie.
7. Jakim opisem błędu `getAddresLabelByGuidCompact` odpowiada na nieznany GUID (Kompletor uznaje brak przesyłki tylko przy „nie znaleziono”, „nie istnieje”, „brak przesyłki”), czy zna też przesyłki z niewysłanego bufora i czy podaje adres, masę i format.
8. Pola `zamowKuriera` po wysłaniu bufora (Kompletor podaje identyfikator ostatniego wysłanego bufora dnia i łączną liczbę paczek) i czy jedno zamówienie odbioru obejmuje kilka buforów.
9. Czy `getEnvelopeBuforList` pokazuje bufory już wysłane. Kompletor zakłada, że wysłany bufor znika z listy; od tego zależy, że ponowne „Wyślij partię” nie wyśle partii drugi raz. Potwierdzić.
10. Czy `zamowKuriera` przyjmuje identyfikator bufora już wysłanego (inaczej zamówienie odbioru zawsze kończy się błędem). Potwierdzić.
11. Numer błędu „nie znaleziono” z `getAddresLabelByGuidCompact`: dopisać go do `NIE_ZNALEZIONO_PP_NUMERY` w `lib/adaptery/pocztapolska-kody.ts` (dopasowanie po numerze nie zależy od brzmienia opisu).
12. Kształt odpowiedzi `getEnvelopeBufor` i `getAddresLabelByGuidCompact`: czy zawierają kod pocztowy, ulicę, numer domu i lokalu, masę i format przesyłki. Bez nich każde ponowienie usuwa i dodaje przesyłkę od nowa, a w wysłanej partii kończy się prośbą o sprawdzenie w eNadawcy.
