'use server'
// Akcje pozycji karty zamówienia: dodaj, zmień ilość, usuń, podziel. Każda zaczyna od requirePermission
// (sesja + uprawnienie, klient bazy firmy z sesji, RLS); bramkę trybu PRACA, ustawienie firmy i rdzeń sprawdza
// lib/karta/pozycje.ts, także przy ręcznym wywołaniu. Komunikat wraca parametrem adresu na tę samą kartę.
// Nic nie idzie do kanału: zmiana jest tylko w Kompletorze.
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { ID_RE } from '@/lib/karta/bramka'
import { dodajPozycje, podzielZamowienie, type WynikKarty } from '@/lib/karta/pozycje'
import { requirePermission } from '@/lib/panel/kontekst'
import { naKarte } from '@/lib/karta/komunikaty-serwer'
import { zapiszPozycje, zmianyZFormularza } from '@/lib/karta/zapis-pozycji'
import { BladStanowiska } from '@/lib/stanowisko/cwiczenie'
import { jednakJestZBiura, wyszedlKomplet } from '@/lib/stanowisko/decyzje'

async function wroc(id: string, w: WynikKarty): Promise<never> {
  if (!ID_RE.test(id)) redirect('/zamowienia')
  revalidatePath(`/zamowienia/${id}`)
  revalidatePath('/zamowienia')
  // sukces i informacja kluczem słownika, błąd kodem (treść w ciasteczku szczegółów)
  redirect(await naKarte(id, w.blad ? { blad: w.blad } : w.zmiana ? { ok: w.info ?? 'zapisano', n: w.n } : { info: w.info, n: w.n }))
}

export async function dodajPozycjeKarta(form: FormData): Promise<void> {
  const ctx = await requirePermission('zamowienia.edycja_pozycji')
  const id = String(form.get('zamowienie') ?? '')
  await wroc(id, await dodajPozycje(ctx.db, { orderId: id, userId: ctx.user.id, uprawnienia: ctx.permissions, sku: form.get('sku'), ilosc: form.get('ilosc'), cena: form.get('cena') }))
}

// pojedyncze „Zmień ilość” i „Usuń pozycję” zastąpił jeden zapis sekcji (zapiszPozycjeKarta);
// funkcje lib/karta/pozycje.ts (zmienIlosc, usunPozycje) zostają i z nich korzysta zapis sekcji.

export async function podzielKarta(form: FormData): Promise<void> {
  const ctx = await requirePermission('zamowienia.podzial')
  const id = String(form.get('zamowienie') ?? '')
  const wybor: Record<string, unknown> = {}
  for (const [k, v] of form.entries()) if (k.startsWith('ile_')) wybor[k.slice(4)] = v
  const w = await podzielZamowienie(ctx.db, { orderId: id, userId: ctx.user.id, uprawnienia: ctx.permissions, wybor })
  await wroc(id, w)
}

// jeden zapis sekcji „Pozycje” (ilości, usunięcie, decyzje o brakach). Osoba z edycją pozycji zapisuje
// wszystko (decyzje tylko z uprawnieniem do braków, sprawdza lib/karta/zapis-pozycji.ts); osoba z samym
// uprawnieniem do braków zapisuje tylko decyzje.
export async function zapiszPozycjeKarta(form: FormData): Promise<void> {
  const ctx = await requirePermission('zamowienia.edycja_pozycji')
  const id = String(form.get('zamowienie') ?? '')
  await wroc(id, await zapiszPozycje(ctx.db, { orderId: id, userId: ctx.user.id, uprawnienia: ctx.permissions, zmiany: zmianyZFormularza(form) }))
}

export async function zapiszDecyzjeKarta(form: FormData): Promise<void> {
  const ctx = await requirePermission('braki.decyzje')
  const id = String(form.get('zamowienie') ?? '')
  await wroc(id, await zapiszPozycje(ctx.db, { orderId: id, userId: ctx.user.id, uprawnienia: ctx.permissions, zmiany: zmianyZFormularza(form), tylkoDecyzje: true }))
}

/**
 * „Jednak jest na półce” — biuro cofa brak zgłoszony na stanowisku albo „nie ma na półce”, póki paczka nie
 * wyszła i stan w wFirmie nie jest poprawiony (lib/stanowisko/decyzje.ts `jednakJestZBiura`, rdzeń
 * `cofnijBrakNaPolceInTx`). Uprawnienie jak decyzje o brakach.
 */
export async function jednakJestKarta(form: FormData): Promise<void> {
  const ctx = await requirePermission('braki.decyzje')
  const id = String(form.get('zamowienie') ?? '')
  let w: WynikKarty
  try {
    const r = await jednakJestZBiura(ctx.db, { orderLineId: String(form.get('pozycja') ?? ''), productId: String(form.get('produkt') ?? ''), userId: ctx.user.id })
    w = { zmiana: true, blad: null, info: r.units > 0 ? 'brak.cofniety' : 'brak.cofniety-bez-paczki' }
  } catch (e) {
    if (!(e instanceof BladStanowiska)) throw e
    w = { zmiana: false, blad: e.message }
  }
  await wroc(id, w)
}

/**
 * „Wyszedł komplet” — magazyn spakował całość mimo ramki „Brakuje, nie pakuj” (towar był na półce, jeszcze
 * nieprzyjęty na stan). Brak bez zwrotu, paczka na pełną ilość, gdy stan pozwala (lib/stanowisko/decyzje.ts
 * `wyszedlKomplet`, rdzeń `brakJednakWPaczceInTx`). Uprawnienie jak decyzje o brakach.
 */
export async function wyszedlKompletKarta(form: FormData): Promise<void> {
  const ctx = await requirePermission('braki.decyzje')
  const id = String(form.get('zamowienie') ?? '')
  let w: WynikKarty
  try {
    const r = await wyszedlKomplet(ctx.db, { orderLineId: String(form.get('pozycja') ?? ''), userId: ctx.user.id })
    w = r.units > 0 ? { zmiana: true, blad: null, info: 'brak.komplet' } : { zmiana: false, blad: null, info: 'brak.komplet-juz' }
  } catch (e) {
    if (!(e instanceof BladStanowiska)) throw e
    w = { zmiana: false, blad: e.message }
  }
  await wroc(id, w)
}
