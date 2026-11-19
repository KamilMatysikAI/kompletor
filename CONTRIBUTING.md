# Jak pomóc przy Kompletorze

Dziękujemy, że chcesz pomóc. Ten plik opisuje, jak postawić środowisko, jak uruchomić testy i jakich zasad pilnujemy
w kodzie. Opis architektury jest w [`README.md`](README.md), w części „Dla developerów”.

## Środowisko

Potrzebne: Node.js 22 (co najmniej 20.19), npm i Docker z Compose (baza do developmentu i testów).

```
npm ci
cp .env.example .env          # lokalny adres bazy; klucze integracji tylko, jeśli są potrzebne
npm run db:up                 # Postgres w Dockerze na 127.0.0.1:55433 (bazy: logistyka, _shadow, _test)
npx prisma migrate deploy
npm run rola:aplikacji        # rola LOGIN klienta firmy z hasłem z APP_DATABASE_URL
npm run org:seed -- przyklad  # firma z presetu seed/presety/przyklad.json (dane fikcyjne)
npm run demo:panel -- --tak   # opcjonalnie firma demo z produktami i zamówieniami fikcyjnymi
npm run dev                   # panel: http://localhost:3100, zdrowie: /api/health
npm run worker                # osobny proces
```

`npm run db:up` i `npm run db:down` używają `docker-compose.dev.yml` (sama baza). `compose.yaml` to pełny produkt
(baza, panel, worker), opisany w README.

## Testy

- `npm run typecheck`: sprawdzenie typów.
- `npm run test:unit`: testy jednostkowe, bez bazy.
- `npm run test:integration`: testy na bazie `TEST_DATABASE_URL` (nazwa musi kończyć się na `_test`, schemat jest
  zakładany od zera przy każdym przebiegu).
- `npm run test:all`: wszystko naraz. Przed zgłoszeniem zmian ma przechodzić w całości, razem z `npm run build`.

To samo (bez symulacji grudnia, która ma osobny, ręczny workflow) uruchamia CI na GitHub Actions: kiedy który job
startuje, jak wygląda środowisko bez sekretów i ile kosztuje, opisuje [`docs/ci.md`](docs/ci.md).

Nie zmieniaj limitów czasowych testów, żeby przeszły, i nie wyłączaj testów. Test, który pada, mówi coś o kodzie.

## Gałęzie i zgłoszenia zmian

- Każda zmiana na osobnej gałęzi od aktualnego `main`, jedno zadanie na gałąź.
- Małe, opisane commity. Opis mówi, co i dlaczego, po polsku.
- Migracja bazy to nowy plik w `prisma/migrations/`; istniejących migracji się nie zmienia. Migracje muszą być
  zgodne wstecz (najpierw dodać, usuwać dopiero w kolejnym wydaniu).
- Zgłoszenie zmian (pull request) opisuje, jak sprawdzić zmianę, i wymienia nowe testy.

## Zasady rdzenia

- **Rezerwacja od zamówienia.** Towar jest rezerwowany w chwili przyjęcia zamówienia, nie przy pakowaniu. Stan
  zmienia się tylko przez rdzeń (`lib/rdzen/`), w transakcji, z zapisem ruchu i z niezmiennikami
  (`lib/rdzen/niezmienniki.ts`).
- **Kanały bez danych osobowych w kontrakcie.** Zamówienie z kanału (`ChannelOrder` w `lib/adaptery/kontrakt.ts`) nie
  niesie imion, adresów ani telefonów klientów. Danych osobowych nie ma też w testach, fixturach, seedach, logach ani
  raportach.
- **Izolacja firm robi Postgres (RLS).** Każda tabela danych ma `organizationId` i politykę Row Level Security. Kod
  aplikacji pracuje klientem firmy (`createOrgClient` w `lib/db.ts`); klient systemowy tylko w plikach z listy w
  `tests/organizacje-izolacja.integration.test.ts`.
- **Strażniki w testach.** Testy pilnują między innymi: brak `set_config`, `SET ROLE`, `SET app.org_id`, `RESET`,
  `DISCARD`, `Prisma.raw` i `Prisma.sql` w kodzie; sterownik `pg` tylko w `lib/db.ts`; każdy ekran panelu zaczyna od
  `requireSession()`; w kodzie produkcyjnym nic specyficznego dla jednej firmy (`tests/publiczne-wydanie.test.ts`).
  Strażnika się nie obchodzi: gdy przeszkadza, opisz w zgłoszeniu, dlaczego.
- **Sekrety tylko w sekretach.** Klucze API nie trafiają do repo, presetów, logów ani komunikatów błędów. W repo jest
  tylko `.env.example` z nazwami zmiennych.
- **Konfiguracja firmy w bazie albo w presecie, nie w kodzie.** Konta kanałów, magazyn, reguły przewoźników i
  godziny odbiorów są w bazie; preset firmy to plik JSON w `seed/presety/` (wzór: `przyklad.json`).
- **Tryb cienia.** Bez osobnej decyzji nic nie zapisuje w kanałach sprzedaży, BaseLinkerze ani wFirmie.

## Jak dopisać adapter kanału

1. Kontrakt jest w `lib/adaptery/kontrakt.ts`: manifest (`adapterKey`, np. `sklep.rest.v1`, wersja, zdolności,
   limity tempa, pola konfiguracji i sekretów), test połączenia i opcjonalne zdolności (`orders.feed`, `stock.write`,
   `reference.find`). Błędy dzielą się na przejściowe, trwałe i niejednoznaczne; nieczytelne dane to błąd, nigdy 0.
2. Definicja `{ manifest, create(ctx) }` trafia do rejestru w `lib/adaptery/domyslne.ts`.
3. Test: uprząż z kanałem w pamięci i wspólna suita `runAdapterContract(uprząż)` z
   `lib/adaptery/suita-kontraktowa.ts`. Wzór uprzęży: `lib/adaptery/falszywy.ts` i `lib/adaptery/adaptery.test.ts`.
4. Adapter tylko czyta, dopóki zapis nie jest świadomie włączony dla danego kanału.

## Licencja wkładu

Wkład jest przyjmowany na licencji GNU AGPL 3.0 (wyłącznie w wersji 3, AGPL-3.0-only), tej samej co cały projekt, i na podstawie umowy licencyjnej
wnoszącego wkład (CLA, plik `CLA.md`). Prawa autorskie do wkładu zostają przy autorze; umowa pozwala właścicielowi
projektu udzielać licencji na kod także na innych warunkach niż AGPL 3.0 (na przykład licencji komercyjnej).

Dopóki repozytorium nie ma automatu do podpisu umowy, akceptujesz ją komentarzem w pierwszym pull requeście
(treść komentarza i wariant dla firm: `CLA.md`, „Jak zaakceptować umowę”). Opiekun projektu sprawdza akceptację
przed scaleniem; pull request bez niej czeka.
