# Dane odbiorcy na żądanie

> **Zmiana zasady 03.11.2026.** Właściciel produktu zmienił kierunek: dane klienta w zamówieniu
> przechowujemy w bazie, zaszyfrowane osobnym kluczem, z wglądem wg uprawnień, dziennikiem podglądów i retencją
> ([Dane klienta w zamówieniu](dane-klienta.md)). Odczyt na żądanie opisany niżej został jako **„Odśwież z kanału”**
> (karta zamówienia, powód `ZAPIS`: pełny rekord prosto do zaszyfrowanego zapisu) i jako zapas przesyłki i faktury, gdy
> zamówienie nie ma jeszcze danych w bazie albo zapis jest wyłączony (`lib/klienci/wejscia.ts`). Zdania o tym, że nic nie
> zostaje w bazie, dotyczą odczytu na żądanie (`PRZESYLKA`, `FAKTURA`); zapis `ZAPIS` trafia wyłącznie do tabeli danych
> klienta (szyfrogram) i nigdzie indziej.

Zasada sprzed 03.11: **Kompletor nie przechowuje adresów klientów.** Dziennik zamówień (`ChannelOrder`) nie ma imienia,
adresu, telefonu ani e-maila. Przesyłka i faktura w trybie PRACA potrzebują jednak odbiorcy: dostają go osobną
zdolnością adaptera, czytaną z kanału w chwili użycia i trzymaną tylko w pamięci wywołującego.

## Co czytamy

Zdolność `orders.recipient` (`RecipientReader.getOrderRecipient(externalId)`, `lib/adaptery/kontrakt.ts`) zwraca
`OrderRecipient`:

| Część | Pola | Uwagi |
|---|---|---|
| `dostawa` | `imieNazwisko`, `firma`, `ulica`, `numerDomu`, `numerLokalu`, `kodPocztowy`, `miasto`, `kraj`, `telefon`, `email` | `null` = kanał nie podał adresu (np. Mirakl przed przyjęciem) |
| `punktOdbioru` | `kod`, `nazwa` | `null` = brak albo nieznany |
| `faktura` | `nazwa`, `nip`, `ulica`, `kodPocztowy`, `miasto`, `kraj` | **klient chce faktury** (we wszystkich kanałach to samo znaczenie); `null` = nie chce albo kanał tego nie mówi |
| `problemy` | kody (`adres_bez_podzialu`, `brak_telefon`, `punkt_nieznany`, …) | bez wartości pól |

Brak pola = `null`, nigdy pusty string. Pole złego typu = `UnreadableDataError` z nazwą pola, bez wartości. Numer domu
tylko wtedy, gdy kanał daje go osobno; dziś żaden z trzech nie daje, więc cała linia jest w `ulica` z problemem
`adres_bez_podzialu` (bez zgadywania podziału).

| Kanał | Skąd | Szczegóły |
|---|---|---|
| Woo (`woo.rest.v1`) | `GET orders/<id>` (klucz tylko do odczytu) | adres z `shipping`, a gdy pusty: cały blok z `billing`; e-mail i telefon z `billing`; NIP z `meta_data` po kluczu konta `nipMetaKey` (np. `_billing__billing_nip`; bez ustawienia `nip = null` i `nip_klucz_nieustawiony`); punkt odbioru z `meta_data` po kluczu `pickupPointMetaKey` (bez ustawienia `null` i `punkt_nieznany`: klucza wtyczki nie zgadujemy); `faktura` z `billing` tylko przy firmie, NIP-ie albo zaznaczeniu „chcę fakturę” z `meta_data` po kluczu `invoiceMetaKey` (true/1/yes/tak/on); bez klucza osoby prywatnej chcącej faktury nie widać → `faktura = null` i `faktura_klucz_nieustawiony` |
| Allegro (`allegro.v1`) | `GET /order/checkout-forms/{id}`, ten sam klient i token, zakres `allegro:api:orders:read` | `delivery.address`, `buyer.email` (maskowany przez Allegro: przekazujemy jak jest), `delivery.pickupPoint`, faktura tylko przy `invoice.required` (firma: `company.name`, `taxId`; osoba: `naturalPerson`) |
| Empik (`mirakl.empik.v1`) | OR11 `GET /orders?order_ids=<id>` przez klienta adaptera (jego limiter i ponowienia) | `customer.shipping_address`, `customer.billing_address`, `customer.firstname/lastname`, e-mail z `customer_notification_email` (gdy jest); kraj `POL` → `PL`; NIP-u OR11 nie podaje; brak adresu = `adres_niedostepny_w_kanale`, nie błąd; `faktura` tylko przy firmie w `billing_address` (OR11 nie ma flagi faktury; osoba prywatna = `null`, do potwierdzenia na żywo); odstęp 60 s między odczytami konta (`recipientMinIntervalMs`) |

## Kiedy

Jedyna droga z hosta: `pobierzOdbiorce(db, orderId, { registry, secrets, actorId, powod })` (`lib/odbiorca/pobierz.ts`),
z `powod` = `PRZESYLKA`, `FAKTURA` albo `ZAPIS` (pełny rekord, bez przycinania z punktu 7; bramka zamiast
punktu 1 to `DANE_KLIENTA_ZAPIS=1`, a w punkcie 4 konto w cieniu przechodzi, gdy firma włączyła „zapis w cieniu”;
zajęte okno konta przy `maksCzekanieMs: 0` = zadanie wraca do kolejki bez śladu). Kolejność:

1. instancja bez `DANE_ODBIORCY_Z_KANALU=1` → odmowa (`OdmowaOdczytuOdbiorcy`, `WYLACZONE`); zła wartość = błąd;
2. zamówienie firmy z sesji (RLS); cudze albo nieistniejące → `BrakZamowieniaOdbiorcy`;
3. kanał `EASYTOOLS`, `RECZNE`, `BL_INNE` → `{ zrodlo: 'BRAK', przyczyna: 'KANAL_BEZ_ZRODLA' }`, bez wyjątku;
4. konto nieznane, nieaktywne albo **w cieniu** (`ChannelConfig.statusMode !== 'PRACA'`) → odmowa; adapter nawet nie
   powstaje, kanał nie dostaje zapytania;
5. adapter bez zdolności → `{ zrodlo: 'BRAK', przyczyna: 'ADAPTER_BEZ_ZDOLNOSCI' }`;
6. odstęp konta (`rateLimit.recipientMinIntervalMs`, dziś tylko Empik: 60 s) w `lib/odbiorca/tempo.ts`: limiter w
   procesie, klucz firma + konto, trzyma tylko znacznik czasu. Czeka najwyżej jeden odstęp; dłuższa kolejka →
   `BladOdczytuOdbiorcy` rodzaju `PRZEJSCIOWY` (klasa `TempoPrzekroczone`), bez wywołania kanału: do ponowienia.
   Nie koordynuje się z workerem czytającym dziennik (inny proces);
7. odczyt z kanału → `{ zrodlo: 'KANAL', kanal, odbiorca }`, **przycięty do `powod`** (minimalizacja, RODO art. 5
   ust. 1 lit. c): `PRZESYLKA` bez `faktura`; `FAKTURA` bez `punktOdbioru`, telefonu i e-maila (adres dostawy zostaje
   jako zapas, gdy klient nie chciał faktury, a proces ją wystawia).

Rola (kto może czytać odbiorcę) jest obowiązkiem wywołującego: trasa albo akcja sprawdza ją przed wywołaniem i
przekazuje `User.id` jako `actorId`. Wywołanie `getOrderRecipient(` albo parsera odbiorcy poza listą plików pilnuje
strażnik kodu `tests/odbiorca-straznik.test.ts` (nowe miejsce = świadomy wpis na listę).

Przejścia na wejścia innych modułów (`lib/odbiorca/przejscia.ts`): `naOdbiorcePrzesylki` (Base Courier,
`OdbiorcaPrzesylki`) i `naKontrahenta` (wFirma, `WejscieFaktury.kontrahent`). Brak pola = lista braków, nie pusty
string; przy `adres_bez_podzialu` przesyłka ma brak `numer_domu`, dopóki człowiek nie rozdzieli adresu. Adres spoza PL
to brak `kraj_zagraniczny`: `OdbiorcaPrzesylki` i zlecenie Base Courier nie niosą kraju (do czasu ich rozszerzenia).

## Gdzie nie zostaje

- Baza: nic poza jednym wierszem `AuditLog` na rozstrzygnięcie (`entity: 'ODBIORCA_ODCZYT'`, `entityId` = Order.id,
  `actorId`, `after: { powod, kanal, wynik, przyczyna? | problemy (liczba) | klasa i rodzaj błędu }`). Żadnych nowych
  kolumn, bez migracji.
- Bez pamięci podręcznej i zmiennych globalnych: każde wywołanie pyta kanał od nowa.
- Alerty, kolejka (`Job`), zdarzenia zamówienia, kopia kanału (`ChannelOrderSnapshot`), `Order.flags`: nic.
- Logi: błąd odczytu to jedna linia `[odbiorca]` z kontem, Order.id, klasą i rodzajem błędu: bez komunikatu wyjątku
  i bez treści odpowiedzi kanału. Wyjątek dla wywołującego (`BladOdczytuOdbiorcy`) też bez nich (bez `cause`).
- AI: dane odbiorcy nie idą do AI (zakaz bez osobnej decyzji).

Dowód: `tests/odbiorca-na-zadanie.integration.test.ts` skanuje po odczycie każdą tabelę bazy testów i wszystkie
wywołania `console` (sukces i błąd, także adapter, który wkłada dane do komunikatu błędu).

## Jak włączyć

1. Instancja: `DANE_ODBIORCY_Z_KANALU=1` (web i worker, jeśli worker będzie wołał). Domyślnie wyłączone.
2. Konto: `ChannelConfig.statusMode = PRACA` (GO kanału).
3. Woo: w `ChannelConfig.config` konta `nipMetaKey` (np. `_billing__billing_nip`) i `pickupPointMetaKey` (klucz
   wtyczki paczkomatów sklepu: do odczytania z prawdziwego zamówienia).

## Czego brakuje

- **EasyTools, ręczne, inne przez BL**: brak źródła w Kompletorze: wynik `BRAK`. Odbiorca musi przyjść inną drogą
  (osobna decyzja).
- Żaden kanał nie dzieli ulicy i numeru: Base Courier wymaga `numerDomu`, więc przed nadaniem człowiek musi rozdzielić
  adres (ekran poza zakresem).
- Empik: punkt odbioru (salony, paczkomaty) nie jest czytany; NIP niedostępny.
- Odstęp OR11: dziennik pilnuje `minPollIntervalMs` w workerze, odczyt odbiorcy `recipientMinIntervalMs` w procesie
  wywołującym; oba razem mogą dać dwa zapytania OR11 w minucie. Przy ekranie listy pakowania rozważyć jedno OR11 na
  partię (`order_ids` przyjmuje listę).
- Przesyłka za granicę: brak kraju w `OdbiorcaPrzesylki`, dziś `kraj_zagraniczny`.
- Faktura bez danych faktury z kanału (Allegro bez `invoice.required`): czy wystawiać na dane dostawy: decyzja procesu.

Do sprawdzenia na żywo: czy Mirakl OR11 daje adres przed przyjęciem zamówienia i czy jest
`customer_notification_email`; klucz meta punktu odbioru, NIP-u i zaznaczenia „chcę fakturę” (`invoiceMetaKey`) w sklepach pierwszej firmy; czy Empik daje
osobie prywatnej fakturę (i jak to widać w OR11); maskowanie e-maila Allegro; nazwy
pól `contractor` wFirmy.
