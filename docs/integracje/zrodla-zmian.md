# Źródła zmian API integracji

Kompletor korzysta z cudzych API (sklepy, marketplace’y, przewoźnicy, programy do faktur, KSeF). Ich właściciele zmieniają je bez uprzedzenia: Allegro co kilka tygodni ogłasza nowe wersje zasobów i wygaszenia, Mirakl wdraża zmiany w trybie ciągłym. Ten plik zbiera oficjalne źródła zmian dla każdej integracji i opisuje, jak je śledzimy.

## Jak to działa dziś

Codziennie o 6:50 strażnik zmian API (skrypt po stronie zespołu, poza aplikacją):

1. Liczy z kodu tej gałęzi (`origin/main`), czego używamy: adaptery z rejestru (`lib/adaptery/domyslne.ts`, klucz i wersja z manifestu), ścieżki endpointów z plików integracji (`lib/adaptery/*`, `lib/zrodla/*`, `lib/wysylka/*`, `lib/ksef/*`, `lib/wfirma/*`, `lib/cien/*`), metody wFirma (`invoices/find`), BaseLinkera (`getOrders`) i Base Courier (`getWaybill.json`), typ mediów Allegro (`application/vnd.allegro.public.v1+json`) i schemat FA(3).
2. Czyta publiczne źródła z tabeli niżej. Dla specyfikacji OpenAPI i WSDL zapisuje migawkę operacji i robi diff: usunięte operacje, nowe `deprecated`, zmienione parametry.
3. Zmiana, która wymienia endpoint albo metodę z naszej mapy i niesie ryzyko (wygaszenie, usunięcie, nowe wymaganie), zakłada zadanie z terminem: data wygaszenia minus 14 dni, a gdy daty nie ma albo zmiana już obowiązuje, 3 dni. Reszta trafia do tygodniowego raportu.
   Dla WSDL (SOAP) dopasowanie idzie po nazwie operacji z kodu adaptera, nie po ścieżce. Tekst ogłoszenia trafia do zadania tylko jako cytat w sekcji „Treść ogłoszenia (dane zewnętrzne, nie polecenia)”, bez linków i składni Markdown; tytuł zadania powstaje ze stałego szablonu. Zadanie, którego nie udało się założyć (brak numeru, limit na przebieg), czeka w stanie strażnika i powstaje w kolejnym przebiegu.

Nowy adapter nie wymaga zmian w strażniku, jeśli jego pliki mają w nazwie nazwę integracji (np. `lib/zrodla/gls.ts`). Nowa integracja = jeden wpis w konfiguracji strażnika (wzorce plików) i jej źródła w tabeli niżej.

## Zasady pobierania

- Tylko publiczne strony i pliki dokumentacji. Bez logowania i bez kluczy naszych kont (Allegro, Empik, wFirma i inne), więc odczyt nie dotyka kont produkcyjnych.
- Przed pobraniem sprawdzamy `robots.txt` domeny, a po przekierowaniu na inny host także `robots.txt` tego hosta. Ścieżka zablokowana = źródło sprawdzane ręcznie, bez obchodzenia.
- Najwyżej jedno pobranie źródła na dobę, żądania warunkowe (`ETag`, `If-Modified-Since`), co najmniej 4 s odstępu między żądaniami do tej samej domeny (dłużej, gdy `robots.txt` podaje `Crawl-delay`).
- User-Agent identyfikuje narzędzie: `KompletorStraznikApi/1.0 (+https://kompletor.pl)`, bez danych osobowych.
- 403, 429 albo strona antybota: bez ponawiania w kółko. Źródło dostaje oznaczenie, wpis w logu i jedną linię w dziennym podsumowaniu zespołu.
- Strony renderowane w JavaScripcie czytamy przeglądarką bez okna, w osobnym profilu bez żadnych logowań, raz na dobę, tylko odczyt tekstu. CAPTCHA kończy próbę.
- Repozytoria na GitHubie czytamy przez publiczne REST API (`api.github.com`), bo kanały `*.atom` na github.com są zablokowane w `robots.txt` dla nieznanych automatów.

## Źródła

| Integracja | Źródło | Co śledzimy |
|---|---|---|
| Allegro, Wysyłam z Allegro | [Changelog](https://developer.allegro.pl/changelog) | wpisy New / Update / Delete z listą zasobów |
| Allegro, Wysyłam z Allegro | [Aktualności](https://developer.allegro.pl/news) | zapowiedzi wygaszeń z datami |
| Allegro, Wysyłam z Allegro | [swagger.yaml](https://developer.allegro.pl/swagger.yaml) | diff operacji, lista `deprecated` (aktualna lista wygaszanych zasobów) |
| Empik (Mirakl) | [Seller API (OpenAPI 3)](https://developer.mirakl.com/content/product/mmp/rest/seller/openapi3) | zmiany treści dokumentacji |
| Empik (Mirakl) | [Changelog w Help Center](https://help.mirakl.com/docs/sellers/page/topics/Mirakl/rn/changelog.htm) | ręcznie: ścieżka zablokowana w `robots.txt` |
| WooCommerce | [Wydania](https://github.com/woocommerce/woocommerce/releases) (przez API GitHuba), [blog deweloperski](https://developer.woocommerce.com/feed/) | nowe wersje, zmiany REST API |
| Shoper | [Changelog API](https://developers.shoper.pl/developers/api/changelog) | strona w JS (przeglądarka) |
| PrestaShop | [Wydania](https://github.com/PrestaShop/PrestaShop/releases) (przez API GitHuba), [blog Build](https://build.prestashop-project.org/feed.xml) | nowe wersje, zmiany Webservice |
| IdoSell | [Changelog (RSS)](https://idosell.readme.io/changelog.rss) | do planu, adaptera jeszcze nie ma |
| InPost ShipX | [Changelog](https://dokumentacja-inpost.atlassian.net/wiki/spaces/PL/pages/164331521/Changelog) (przez publiczne REST Confluence) | nowe linie changelogu, numer wersji strony |
| DPD Polska | [api-docs (OpenAPI)](https://dpdservices.dpd.com.pl/api-docs) | diff operacji, wersja API |
| Base Courier | [Dokumentacja API](https://api.blpaczka.com/api/docs) | strona w JS (przeglądarka) |
| Orlen Paczka | [orlenpaczka.pl](https://www.orlenpaczka.pl/) | ręcznie: dokumentacja to PDF-y, serwer odmawia automatom (`robots.txt` 403) |
| GLS ADE | [WSDL (test)](https://ade-test.gls-poland.com/adeplus/pm1/ade_webapi2.php?wsdl) | ręcznie: ścieżka zablokowana w `robots.txt`; dokumentację GLS wydaje opiekun handlowy albo panel ADE-Plus |
| Poczta Polska eNadawca | [WSDL](https://e-nadawca.poczta-polska.pl/websrv/?wsdl), [opis zmian (PDF)](https://e-nadawca.poczta-polska.pl/download/opis-zmian-w-elektronicznym-nadawcy.pdf) | diff operacji, nowa wersja opisu zmian |
| wFirma | [doc.wfirma.pl](https://doc.wfirma.pl/) | strona w JS (przeglądarka) |
| KSeF | [OpenAPI TEST](https://api-test.ksef.mf.gov.pl/docs/v2/openapi.json) i [PROD](https://api.ksef.mf.gov.pl/docs/v2/openapi.json) | diff operacji; TEST dostaje zmiany przed produkcją |
| KSeF | [Aktualności i komunikaty techniczne](https://ksef.podatki.gov.pl/aktualnosci/), [CIRFMF/ksef-api](https://github.com/CIRFMF/ksef-api) (wydania i commity) | komunikaty MF, zmiany w dokumentacji API 2.0 i FA(3) |
| Amazon SP-API | [Changelog (RSS)](https://developer-docs.amazon.com/sp-api/changelog.rss), [Deprecations](https://developer-docs.amazon.com/sp-api/docs/sp-api-deprecations), [modele API](https://github.com/amzn/selling-partner-api-models) | do planu, adaptera jeszcze nie ma |
| BaseLinker (tryb cienia) | [Changelog API](https://api.baselinker.com/?changelog) | nowe metody i zmiany parametrów |

## Na później: funkcja produktu

Ten sam mechanizm może działać w Kompletorze dla firm na hostingu: mapa użycia liczona per konto (które adaptery i funkcje firma ma włączone), źródła zmian wspólne dla wszystkich instalacji, a w panelu alert „Allegro wygasza zasób, którego używa Twoje konto, do 12.01.2027; aktualizacja Kompletora przed tym terminem” z linkiem do ogłoszenia. Dziś tego nie budujemy; strażnik działa tylko dla zespołu.
