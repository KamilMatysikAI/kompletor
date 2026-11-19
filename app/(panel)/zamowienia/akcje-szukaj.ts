'use server'
// Lista zamówień → jedno pole „Szukaj” (R6 z przeglądu TwojOMS; wcześniej osobne pole „Klient”).
// Fraza może być numerem zamówienia, numerem przesyłki, SKU, EAN, nazwą produktu, ale też e-mailem,
// telefonem, NIP-em albo nazwiskiem klienta, więc nie trafia do adresu strony jawnie, gdy osoba szuka też po klientach:
//  - osoba z `klienci.dane` (i klucz danych klientów na instalacji): fraza zaszyfrowana z terminem ważności 2 h
//    i powiązana z osobą (`qz`, lib/klienci/fraza-token.ts); strona szuka naraz po zamówieniach i po klientach
//    (skróty HMAC e-maila/telefonu/NIP-u), wynik to suma; nazwisko i firmę fragmentem tylko z zaznaczonym polem
//    „także w danych klientów” (`k`: fragment odszyfrowuje ostatnie rekordy i pisze wpis w dzienniku);
//  - osoba bez `klienci.dane`: fraza jawnie w `q` (numery, produkty) jak dotąd; e-maila i telefonu w zapisie
//    telefonicznym nie przyjmujemy (dane osobowe w adresie strony), dostaje komunikat o uprawnieniu.
// Filtry listy (widok, status firmy, przewoźnik, daty…) zostają: formularz niesie bieżący adres w `powrot`, akcja
// przepisuje z niego tylko znane parametry.
// fraza będąca dokładnie kodem karty, numerem nadania albo numerem jednego zamówienia (skan czytnikiem do
// pola, wklejony numer) otwiera kartę tego zamówienia; kilka trafień albo brak = zwykłe filtrowanie. Goły
// numer dopiero od 5 cyfr, bez skoku przy „także w danych klientów” i po linku „Pokaż wyniki” z karty (`skok=nie`);
// karta dostaje adres listy z tą frazą (`wyniki`, ten sam co bez skoku, więc fraza z danymi klienta zostaje zaszyfrowana).
import { redirect } from 'next/navigation'
import { zapieczetujFraze } from '@/lib/klienci/fraza-token'
import { requireSession } from '@/lib/panel/kontekst'
import { adresPoSzukaniu } from '@/lib/panel/szukaj-adres'
import { adresOtwarcia, bezSkoku } from '@/lib/stanowisko/otwarcie'
import { zamowienieZFrazy } from '@/lib/stanowisko/skan-poza-oknem'

export async function szukaj(form: FormData): Promise<void> {
  const ctx = await requireSession()
  const fraza = String(form.get('q') ?? '')
  const powrot = String(form.get('powrot') ?? '')
  const klienci = form.get('k') === 'tak'
  const zapieczetuj = ctx.permissions.has('klienci.dane') ? (f: string) => zapieczetujFraze(process.env, ctx.organization.organizationId, ctx.user.id, f, new Date(), { klienci }) : null
  const lista = adresPoSzukaniu(fraza, powrot, zapieczetuj)
  const jedno = fraza.length <= 200 && !bezSkoku(powrot) ? await zamowienieZFrazy(ctx.db, fraza, { klienci }) : null
  if (jedno) redirect(adresOtwarcia(jedno.orderId, jedno, lista))
  redirect(lista)
}
