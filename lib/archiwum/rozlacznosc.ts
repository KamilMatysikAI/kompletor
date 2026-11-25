// jedna definicja rozłączności archiwum z `Order` (warunek (2) i (3) z lib/archiwum/import.ts) w trzech
// postaciach: predykat w TS (importer), klucze kandydatów do jednego zapytania (importer) i fragment SQL (oba
// NOT EXISTS raportu sprzedaży, lib/api/raporty-sprzedaz.ts). Zmiana reguły = zmiana tylko tutaj.
//
// Zamówienie archiwum ma już wiersz `Order` w tym samym koncie kanału, gdy:
//  (a) ten sam `externalId` (id zamówienia w kanale), albo
//  (b) ten sam numer zamówienia widoczny w kanale przy dacie złożenia w oknie `OKNO_NUMERU_MS`. Numer `Order` to
//      `channelNumber`, a gdy go brak, `externalId` (przeprowadzka zapisuje w `externalId` numer sklepu, a odczyt
//      kanału może potem dopisać ten sam numer w `channelNumber`). Okno daty jest potrzebne, bo numeracje id i numeru
//      się zachodzą (id jednego zamówienia bywa numerem innego, złożonego miesiące wcześniej albo później).
//  Reguła (b) nie obejmuje kanałów z `KANALY_NUMER_NIEUNIKALNY`: Empik (Mirakl) trzyma w archiwum jako numer
//  `commercial_id` koszyka, który może obejmować kilka zamówień (`order_id`) tego samego konta, więc wiązanie po nim
//  skleiłoby różne zamówienia i wycięło je z raportu. Zamówienia Empik wiążą się tylko po `order_id` (reguła (a));
//  przeprowadzka zapisuje dla Empik w `externalId` właśnie `order_id` (lib/przeprowadzka/zamowienia.ts, externalIdOf).
import { Prisma, type Channel } from '@prisma/client'

/** Okno daty przy wiązaniu po numerze (data złożenia w poprzednim systemie bywa przesunięta o godziny). */
export const OKNO_NUMERU_MS = 36 * 3600_000

/** Kanały, w których numer zamówienia archiwum nie wskazuje jednego zamówienia (opis w nagłówku). */
export const KANALY_NUMER_NIEUNIKALNY: readonly Channel[] = ['EMPIK']

export const numerWiaze = (channel: Channel): boolean => !KANALY_NUMER_NIEUNIKALNY.includes(channel)

export interface OrderDoRozlacznosci {
  externalId: string
  channelNumber: string | null
  createdAtChannel: Date | null
}

export interface ArchiwumDoRozlacznosci {
  externalId: string
  channelNumber: string | null
  createdAtChannel: Date
}

/** Czy zamówienie archiwum (kanał `channel`) ma już wiersz wśród `orders` tego samego konta. */
export function jestWKompletorze(channel: Channel, z: ArchiwumDoRozlacznosci, orders: readonly OrderDoRozlacznosci[]): boolean {
  return orders.some(
    (x) =>
      x.externalId === z.externalId ||
      (numerWiaze(channel) &&
        !!z.channelNumber &&
        (x.channelNumber ?? x.externalId) === z.channelNumber &&
        !!x.createdAtChannel &&
        Math.abs(x.createdAtChannel.getTime() - z.createdAtChannel.getTime()) <= OKNO_NUMERU_MS),
  )
}

/** Warunek `where` na `Order` (w obrębie konta) wybierający wszystkich kandydatów do `jestWKompletorze` dla partii. */
export function kandydaciOrder(channel: Channel, partia: readonly ArchiwumDoRozlacznosci[]): Prisma.OrderWhereInput {
  const numery = numerWiaze(channel) ? [...new Set(partia.flatMap((z) => (z.channelNumber ? [z.channelNumber] : [])))] : []
  const ids = [...new Set([...partia.map((z) => z.externalId), ...numery])]
  return numery.length ? { OR: [{ externalId: { in: ids } }, { channelNumber: { in: numery } }] } : { externalId: { in: ids } }
}

const ALIAS = /^[a-z][a-z0-9_]*$/
const SEKUNDY_OKNA = OKNO_NUMERU_MS / 1000
const LISTA_NIEUNIKALNYCH = KANALY_NUMER_NIEUNIKALNY.map((c) => `'${c}'`).join(', ')

/**
 * Fragment SQL (warunek na wiersz `ArchivedOrder` aliasu `a`): archiwum NIE ma wiersza `Order` w tej samej firmie i
 * koncie kanału, czyli SQL-owa postać `!jestWKompletorze`. Przegląd końcowy: trzy osobne `NOT EXISTS`, każdy
 * z równością na kolumnach indeksu konta (bez `coalesce` i `OR` w warunku na `Order`), żeby planer szukał w indeksie zamiast
 * przeglądać wszystkie `Order` konta dla każdego wiersza archiwum:
 *  1. reguła (a): `externalId` = `externalId` (unikalny indeks konta);
 *  2. reguła (b), numer w `channelNumber`: `channelNumber` = numer archiwum w oknie (indeks konta po `channelNumber`);
 *  3. reguła (b), numer w `externalId` przy pustym `channelNumber`: `externalId` = numer archiwum w oknie.
 * Gałęzie 2 i 3 razem = `(x.channelNumber ?? x.externalId) === z.channelNumber` z predykatu TS. Same stałe z tego
 * pliku, bez parametrów; alias sprawdzany.
 */
export function sqlBrakWKompletorze(a: string): Prisma.Sql {
  if (!ALIAS.test(a)) throw new Error(`zły alias SQL: ${a}`)
  const konto = (x: string) => `${x}."organizationId" = ${a}."organizationId" AND ${x}."channel" = ${a}."channel" AND ${x}."channelAccountId" = ${a}."channelAccountId"`
  const bezNumeru = `${a}."channelNumber" IS NULL OR ${a}."channel"::text IN (${LISTA_NIEUNIKALNYCH})`
  const okno = (x: string) => `abs(extract(epoch FROM (${x}."createdAtChannel" - ${a}."createdAtChannel"))) <= ${SEKUNDY_OKNA}`
  const [x1, x2, x3] = [`${a}_o1`, `${a}_o2`, `${a}_o3`]
  // gałęzie numeru pod OR po stronie archiwum: planer nie zamienia ich na złączenie (przy błędnym oszacowaniu wybierał
  // pętlę bez indeksu, ok. 14 mln porównań przy 7 tys. × 2 tys. wierszy), tylko wykonuje na wiersz archiwum wyszukanie
  // w indeksie (firma, konto, numer / id); gałąź (a) zostaje złączeniem anty. `channel` jest w warunku tylko filtrem:
  // przy RLS porównanie enum nie jest leakproof i nie może być warunkiem indeksu (stąd indeksy bez `channel`)
  return Prisma.raw(`NOT EXISTS (SELECT 1 FROM "Order" ${x1} WHERE ${konto(x1)} AND ${x1}."externalId" = ${a}."externalId")
          AND (${bezNumeru}
            OR (NOT EXISTS (SELECT 1 FROM "Order" ${x2} WHERE ${konto(x2)} AND ${x2}."channelNumber" = ${a}."channelNumber" AND ${okno(x2)})
              AND NOT EXISTS (SELECT 1 FROM "Order" ${x3} WHERE ${konto(x3)} AND ${x3}."channelNumber" IS NULL AND ${x3}."externalId" = ${a}."channelNumber" AND ${okno(x3)})))`)
}
