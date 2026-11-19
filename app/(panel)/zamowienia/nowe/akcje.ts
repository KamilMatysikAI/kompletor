'use server'
// Akcje ekranu „Zamówienia → Dodaj zamówienie”. Każda zaczyna od requirePermission (sesja + uprawnienie,
// klient bazy firmy z sesji, RLS). Zapis idzie tą samą funkcją co API (`przyjmijZamowienie`): rezerwacja, przewoźnik
// i dalsza ścieżka jak zamówienie z kanału. Komunikaty bez danych klienta.
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { ApiInputError } from '@/lib/api/odpowiedzi'
import { szukajProduktuDoZamowienia } from '@/lib/karta/szukaj-produktu'
import { szukajKlientaFragmentem } from '@/lib/klienci/szukaj-fragment'
import { KOMUNIKAT_BRAK_KLUCZA } from '@/lib/klienci/szyfr'
import { requirePermission } from '@/lib/panel/kontekst'
import { przewoznicyFirmy } from '@/lib/praca/dane'
import { ValidationError } from '@/lib/rdzen/zamowienia'
import { BladNowegoZamowienia, wpisanoKlienta, zamowienieZFormularza } from '@/lib/zamowienia/formularz'
import { przyjmijZamowienie } from '@/lib/zamowienia/ogolne'
import { klientDoFormularza, type KlientWyniku, type ProduktWyniku, type StanNowego } from './stan'

/** Produkty do formularza: fraza w SKU, nazwie albo EAN; stan dostępny (fizycznie − zarezerwowane), cena z katalogu. */
export async function szukajProduktowNowe(fraza: string): Promise<{ produkty: ProduktWyniku[]; blad: string | null }> {
  const ctx = await requirePermission('zamowienia.dodawanie')
  return szukajProduktuDoZamowienia(ctx.db, fraza)
}

/** Klienci z wcześniejszych zamówień fragmentem nazwy, firmy, e-maila, telefonu albo NIP-u (wymaga `klienci.dane`). */
export async function szukajKlientowNowe(fraza: string): Promise<{ klienci: KlientWyniku[]; blad: string | null }> {
  const ctx = await requirePermission('zamowienia.dodawanie')
  const r = await szukajKlientaFragmentem(ctx.db, String(fraza ?? ''), { actorId: ctx.user.id })
  if (r.stan === 'BEZ_UPRAWNIEN') return { klienci: [], blad: 'Wyszukiwanie klientów wymaga uprawnienia do danych klienta (Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia).' }
  if (r.stan === 'ZA_KROTKA') return { klienci: [], blad: 'Wpisz co najmniej 3 znaki: część nazwy, firmy, e-maila, telefonu albo NIP-u.' }
  if (r.stan === 'BRAK_KLUCZA') return { klienci: [], blad: KOMUNIKAT_BRAK_KLUCZA }
  return { klienci: r.klienci.map((k) => klientDoFormularza(k.rekord)), blad: null }
}

/** „Dodaj zamówienie”: walidacja, przyjęcie przez rdzeń, zapis klienta; po sukcesie karta nowego zamówienia. */
export async function dodajZamowienie(_prev: StanNowego, form: FormData): Promise<StanNowego> {
  const ctx = await requirePermission('zamowienia.dodawanie')
  let id: string
  try {
    if (wpisanoKlienta(form) && !ctx.permissions.has('klienci.dane'))
      return { blad: 'Wpisanie danych klienta wymaga uprawnienia do danych klienta (Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia). Zostaw pola klienta puste albo poproś o uprawnienie.' }
    const przewoznicy = (await przewoznicyFirmy(ctx.db, 'RECZNE')).map((p) => p.carrier)
    const z = zamowienieZFormularza(form, przewoznicy)
    const r = await przyjmijZamowienie(ctx.db, z, { source: 'panel', actorId: `user:${ctx.user.id}`, env: process.env, pierwszeKonto: true })
    id = r.body.id
  } catch (e) {
    if (e instanceof BladNowegoZamowienia) return { blad: e.message }
    if (e instanceof ValidationError) return { blad: `Zamówienie odrzucone: ${e.message}` }
    if (e instanceof ApiInputError) {
      if (e.status === 409) return { blad: 'Zamówienie z tego formularza już zostało zapisane z inną treścią: otwórz „Dodaj zamówienie” jeszcze raz.' }
      return { blad: e.message }
    }
    throw e
  }
  revalidatePath('/zamowienia')
  redirect(`/zamowienia/${id}`)
}
