// Podział Pomocy na odbiorców: kto czyta dany dokument. Osobny plik, żeby kolejne paczki dopisywały
// swoje dokumenty do `DOZWOLONE` (lib/pomoc/dokumenty.ts) bez konfliktu z tą mapą: dokument bez wpisu tutaj trafia
// do grupy właściciela i biura, czyli tam, gdzie szuka większość osób.

export type RolaPomocy = 'wlasciciel' | 'magazyn' | 'administrator'

export const ROLE_POMOCY: readonly { rola: RolaPomocy; tytul: string; opis: string }[] = [
  { rola: 'wlasciciel', tytul: 'Dla właściciela i biura', opis: 'Ustawienia firmy, produkty, zamówienia, dokumenty sprzedaży i poczta.' },
  { rola: 'magazyn', tytul: 'Dla magazynu', opis: 'Zbieranie, pakowanie, przesyłki i etykiety.' },
  {
    rola: 'administrator',
    tytul: 'Dokumentacja dla administratora',
    opis: 'Instalacja, integracje i klucze, ochrona danych klientów, agenci AI. Dla osoby, która stawia i utrzymuje system.',
  },
]

/** Dokumenty spoza grupy właściciela i biura. Integracje (`integracje-*`) idą do administratora. */
const ROLA: Readonly<Record<string, RolaPomocy>> = {
  pakowanie: 'magazyn',
  przesylki: 'magazyn',
  instalacja: 'administrator',
  integracje: 'administrator',
  'dane-klienta': 'administrator',
  'agenci-ai': 'administrator',
  'akcje-bl': 'administrator',
  // włączenie alertów na Zulipie to konfiguracja serwera (zmienne, tabele, przebieg wysyłki)
  powiadomienia: 'administrator',
}

export function rolaDokumentu(slug: string): RolaPomocy {
  if (slug.startsWith('integracje-')) return 'administrator'
  return ROLA[slug] ?? 'wlasciciel'
}

/** Grupa, którą osoba widzi pierwszą: magazyn swoją, reszta grupę właściciela i biura. */
export function rolaOsoby(rola: string | null | undefined): RolaPomocy {
  return rola === 'MAGAZYN' ? 'magazyn' : 'wlasciciel'
}
