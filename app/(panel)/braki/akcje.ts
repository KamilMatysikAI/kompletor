'use server'
// Akcje obsługi przy braku towaru. Każda zaczyna od requirePermission — klient bazy tylko z firmy sesji (RLS).
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requirePermission } from '@/lib/panel/kontekst'
import { markRefunded } from '@/lib/rdzen/brakuje'
import { PackError, potwierdzPoprawioneWWfirmie, skutekPoprawionego, type SkutekPoprawionego } from '@/lib/rdzen/rozchod'
import { BladStanowiska } from '@/lib/stanowisko/cwiczenie'
import { ETYKIETA_DECYZJI, zdecydujOBraku } from '@/lib/stanowisko/decyzje'
import { DECYZJE_MASOWE, LIMIT_MASOWY, linieProduktow, zdecydujMasowo } from '@/lib/panel/braki'
import type { ShortageAction } from '@prisma/client'

/** Decyzja o pozycji z brakiem z karty zamówienia; odmowa wraca jako komunikat na tej samej karcie. */
export async function zdecyduj(form: FormData): Promise<void> {
  const ctx = await requirePermission('braki.decyzje')
  const orderId = String(form.get('zamowienie') ?? '')
  const karta = /^[a-z0-9]{1,40}$/i.test(orderId) ? `/zamowienia/${orderId}` : '/braki'
  let blad: string | null = null
  try {
    await zdecydujOBraku(ctx.db, {
      orderLineId: String(form.get('pozycja') ?? ''),
      akcja: String(form.get('akcja') ?? '') as ShortageAction,
      sku: String(form.get('sku') ?? ''),
      userId: ctx.user.id,
    })
  } catch (e) {
    if (!(e instanceof BladStanowiska)) throw e
    blad = e.message
  }
  revalidatePath(karta)
  revalidatePath('/braki')
  redirect(blad ? `${karta}?blad=${encodeURIComponent(blad)}` : karta)
}

/** „Zwrócone” na liście „Do zwrotu”: obsługa zrobiła zwrot w kanale albo bramce. */
export async function zwrocone(form: FormData): Promise<void> {
  const ctx = await requirePermission('zwroty.pieniadze')
  const id = String(form.get('brak') ?? '')
  if (/^[a-z0-9]{1,40}$/i.test(id)) await markRefunded(ctx.db, id, { actorId: `user:${ctx.user.id}` })
  revalidatePath('/braki')
  redirect('/braki?lista=zwroty')
}

/**
 * decyzja dla zaznaczonych na liście „Brakuje” — pozycji (widok po zamówieniu) albo całych grup produktów
 * (widok po produkcie, z filtrami listy). Każda pozycja osobno; wynik i odmowy wracają jako komunikat nad listą.
 */
export async function zdecydujZaznaczone(form: FormData): Promise<void> {
  const ctx = await requirePermission('braki.decyzje')
  const akcja = String(form.get('akcja') ?? '') as ShortageAction
  const zaznaczone = form.getAll('zaznaczone').map(String)
  const widok = form.get('widok') === 'zamowienia' ? 'zamowienia' : 'produkty'
  const powrot = String(form.get('powrot') ?? '/braki')
  const bezpieczny = powrot.startsWith('/braki') ? powrot : '/braki'
  let q: string
  if (!DECYZJE_MASOWE.includes(akcja)) q = 'blad=' + encodeURIComponent('Wybierz decyzję')
  else if (!zaznaczone.length) q = 'blad=' + encodeURIComponent('Zaznacz co najmniej jedną pozycję')
  else {
    const linie = widok === 'zamowienia' ? zaznaczone : await linieProduktow(ctx.db, zaznaczone, { q: String(form.get('q') ?? '') || undefined, zamkniete: form.get('zamkniete') === 'tak' })
    const w = await zdecydujMasowo(ctx.db, linie, akcja, ctx.user.id)
    const tekst = `Decyzja „${ETYKIETA_DECYZJI[akcja]}”: zapisana dla ${w.zapisane} poz.${w.bezZmian ? `, bez zmian ${w.bezZmian}` : ''}${w.bledy.length ? `, odmowa ${w.bledy.length} (${[...new Set(w.bledy.map((b) => b.komunikat))].slice(0, 2).join('; ')})` : ''}${w.pominiete ? `, pominięto ${w.pominiete} (najwyżej ${LIMIT_MASOWY} naraz: zaznacz pozostałe w widoku po zamówieniu)` : ''}.`
    q = `${w.bledy.length && !w.zapisane ? 'blad' : 'wynik'}=${encodeURIComponent(tekst)}`
  }
  revalidatePath('/braki')
  redirect(`${bezpieczny}${bezpieczny.includes('?') ? '&' : '?'}${q}`)
}

/** zmiana decyzji w wierszu listy „Brakuje” (bez zamiany produktu — ta tylko na karcie zamówienia). */
export async function zdecydujWWierszu(form: FormData): Promise<void> {
  const ctx = await requirePermission('braki.decyzje')
  const akcja = String(form.get('akcja') ?? '') as ShortageAction
  const powrot = String(form.get('powrot') ?? '/braki')
  const bezpieczny = powrot.startsWith('/braki') ? powrot : '/braki'
  const w = DECYZJE_MASOWE.includes(akcja) ? await zdecydujMasowo(ctx.db, [String(form.get('pozycja') ?? '')], akcja, ctx.user.id) : null
  const q = !w ? `blad=${encodeURIComponent('Wybierz decyzję')}` : w.bledy.length ? `blad=${encodeURIComponent(w.bledy[0]!.komunikat)}` : `wynik=${encodeURIComponent(w.zapisane ? `Zapisano: ${ETYKIETA_DECYZJI[akcja]}.` : 'Bez zmian.')}`
  revalidatePath('/braki')
  redirect(`${bezpieczny}${bezpieczny.includes('?') ? '&' : '?'}${q}`)
}

/**
 * Okno potwierdzenia „Poprawione w wFirmie”: skutek kliknięcia liczony na serwerze z bieżącego stanu (o ile wzrośnie stan
 * dostępny, czy Kompletor wie o braku WZ do faktury, czy pozycję zamknie automat WZ). Tylko odczyt; to samo uprawnienie.
 */
export async function skutekPoprawionegoWWfirmie(movementId: string): Promise<{ blad: string | null; skutek?: SkutekPoprawionego }> {
  const ctx = await requirePermission('zamowienia.faktury')
  const id = String(movementId ?? '')
  if (!/^[a-z0-9]{1,40}$/i.test(id)) return { blad: 'Nie ma takiej pozycji do poprawy.' }
  const skutek = await skutekPoprawionego(ctx.db, id)
  if (!skutek) return { blad: 'Ta pozycja jest już zamknięta albo jej nie ma: odśwież stronę.' }
  return { blad: null, skutek }
}

/**
 * „Poprawione w wFirmie” w wierszu listy „Do poprawy w wFirmie”: biuro poprawiło dokumenty w wFirmie, pozycja przestaje
 * pomniejszać stan (stan w Kompletorze wraca do stanu z wFirmy po najbliższym odczycie). To samo uprawnienie co
 * „Dokument wystawiony” na karcie zamówienia. Nic nie idzie do wFirmy, BaseLinkera ani sklepów; ponowne kliknięcie nic
 * nie zmienia. Wpis w historii zamówienia i w dzienniku zmian z osobą z sesji.
 */
export async function poprawioneWWfirmie(movementId: string): Promise<{ blad: string | null; juzZamkniete?: boolean }> {
  const ctx = await requirePermission('zamowienia.faktury')
  const id = String(movementId ?? '')
  if (!/^[a-z0-9]{1,40}$/i.test(id)) return { blad: 'Nie ma takiej pozycji do poprawy.' }
  let wynik
  try {
    wynik = await potwierdzPoprawioneWWfirmie(ctx.db, id, { actorId: ctx.user.id })
  } catch (e) {
    if (e instanceof PackError) return { blad: e.message }
    throw e
  }
  revalidatePath('/braki')
  return { blad: null, juzZamkniete: wynik === 'JUZ_ZAMKNIETE' }
}
