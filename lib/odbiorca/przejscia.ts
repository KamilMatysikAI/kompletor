// Przejścia z odbiorcy kanału (`OrderRecipient`) na wejścia przesyłki i faktury: `OdbiorcaPrzesylki`
// (Base Courier) i `WejscieFaktury.kontrahent` (wFirma). Czyste funkcje bez zapisu: wynik żyje
// tylko w pamięci wywołującego. Brak pola = lista braków (kody, bez wartości), nigdy pusty string w zastępstwie.
// wejście bierze się z bazy (`OrderCustomer` przez `daneKlienta`, cel PRZESYLKA / FAKTURA), a z kanału tylko,
// gdy wiersza nie ma — lib/klienci/wejscia.ts (`odbiorcaPrzesylki`, `kontrahentFaktury`). Te funkcje zostają czyste.
import type { OrderRecipient } from '../adaptery/kontrakt'
import type { WejscieFaktury } from '../wfirma/faktura'
import type { OdbiorcaPrzesylki } from '../wysylka/zlecenie'

export type Przejscie<T> = { ok: true; wartosc: T } | { ok: false; braki: string[] }

/**
 * Odbiorca przesyłki z adresu dostawy. Numer domu musi przyjść z kanału osobno: przy `adres_bez_podzialu` (Woo,
 * Allegro, Empik dziś) wynik to brak `numer_domu` — podział linii adresu to decyzja człowieka, nie zgadywanie.
 */
export function naOdbiorcePrzesylki(r: OrderRecipient): Przejscie<OdbiorcaPrzesylki> {
  const d = r.dostawa
  if (!d) return { ok: false, braki: ['dostawa'] }
  const braki: string[] = []
  const imie = d.imieNazwisko ?? d.firma
  if (!imie) braki.push('imie_nazwisko')
  if (!d.ulica) braki.push('ulica')
  if (!d.numerDomu) braki.push('numer_domu')
  if (!d.kodPocztowy) braki.push('kod_pocztowy')
  if (!d.miasto) braki.push('miasto')
  if (!d.telefon) braki.push('telefon')
  if (!d.email) braki.push('email')
  // `OdbiorcaPrzesylki` i zlecenie Base Courier nie niosą kraju: adres spoza PL poszedłby jako krajowy.
  // Do czasu obsługi kraju w przesyłce zagranica = brak; null zostaje (kanał zwykle podaje kraj).
  if (d.kraj && d.kraj.toUpperCase() !== 'PL') braki.push('kraj_zagraniczny')
  if (braki.length || !imie || !d.ulica || !d.numerDomu || !d.kodPocztowy || !d.miasto || !d.telefon || !d.email) return { ok: false, braki }
  return {
    ok: true,
    wartosc: {
      imieNazwisko: imie,
      firma: d.firma,
      ulica: d.ulica,
      numerDomu: d.numerDomu,
      numerLokalu: d.numerLokalu,
      kodPocztowy: d.kodPocztowy,
      miasto: d.miasto,
      telefon: d.telefon,
      email: d.email,
    },
  }
}

/**
 * Kontrahent faktury wFirma z danych faktury kanału (`contractor` w `invoices/add`; nazwy pól do potwierdzenia na
 * sandboxie wFirmy razem). Bez e-maila i telefonu: faktura nie może sama wysłać maila klientowi.
 * Brak danych faktury (kanał ich nie podał albo klient nie chciał faktury) = brak `faktura`: czy wtedy wystawiać na
 * dane z dostawy, decyduje właściciel procesu, nie ta funkcja.
 */
/**
 * Kontrahent faktury wystawianej z Kompletora: dane do faktury, a gdy kanał ich nie podał i klient nie prosił
 * o fakturę na firmę — imię, nazwisko i adres z dostawy, bez NIP (tak robi BL przy fakturze dla konsumenta). Klient z
 * prośbą o fakturę (`chceFakture`) bez kompletnych danych do faktury = braki: faktura bez NIP-u byłaby błędem.
 */
export function kontrahentDoWystawienia(r: OrderRecipient, chceFakture: boolean): Przejscie<NonNullable<WejscieFaktury['kontrahent']>> {
  const z = naKontrahenta(r)
  if (z.ok || chceFakture || r.faktura) return z
  const d = r.dostawa
  if (!d) return { ok: false, braki: ['faktura', 'dostawa'] }
  // w dostawie sama nazwa firmy bez NIP-u = faktura na firmę bez NIP-u; decyzja dla biura
  if (!d.imieNazwisko && d.firma) return { ok: false, braki: ['nip'] }
  const nazwa = d.imieNazwisko
  const ulica = d.ulica ? [d.ulica, d.numerDomu ? `${d.numerDomu}${d.numerLokalu ? `/${d.numerLokalu}` : ''}` : null].filter(Boolean).join(' ') : null
  const braki: string[] = []
  if (!nazwa) braki.push('nazwa')
  if (!ulica) braki.push('ulica')
  if (!d.kodPocztowy) braki.push('kod_pocztowy')
  if (!d.miasto) braki.push('miasto')
  if (braki.length || !nazwa || !ulica || !d.kodPocztowy || !d.miasto) return { ok: false, braki }
  return { ok: true, wartosc: { name: nazwa, tax_id_type: 'none', street: ulica, zip: d.kodPocztowy, city: d.miasto, ...(d.kraj ? { country: d.kraj } : {}) } }
}

export function naKontrahenta(r: OrderRecipient): Przejscie<NonNullable<WejscieFaktury['kontrahent']>> {
  const f = r.faktura
  if (!f) return { ok: false, braki: ['faktura'] }
  const braki: string[] = []
  if (!f.nazwa) braki.push('nazwa')
  if (!f.ulica) braki.push('ulica')
  if (!f.kodPocztowy) braki.push('kod_pocztowy')
  if (!f.miasto) braki.push('miasto')
  if (braki.length) return { ok: false, braki }
  return {
    ok: true,
    wartosc: {
      name: f.nazwa,
      ...(f.nip ? { nip: f.nip, tax_id_type: 'nip' } : { tax_id_type: 'none' }),
      street: f.ulica,
      zip: f.kodPocztowy,
      city: f.miasto,
      ...(f.kraj ? { country: f.kraj } : {}),
    },
  }
}
