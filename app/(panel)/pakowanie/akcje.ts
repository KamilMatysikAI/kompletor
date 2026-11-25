'use server'
// Akcje kolejki pakowania. Każda zaczyna od requirePermission — klient bazy tylko z firmy sesji (RLS).
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requirePermission } from '@/lib/panel/kontekst'
import { isPickupCarrier, markCarrierArrived } from '@/lib/pakowanie/dane'
import { CARRIER_SHORT } from '@/lib/pakowanie/harmonogram'
import { toWarsaw } from '@/lib/rdzen/kalendarz'
import type { DostepnoscOkna } from '@/lib/wysylka/kurier-widok'
import { opisZlecenia, przedzialyKuriera, rozstrzygnijKuriera, zamowKuriera, type WynikOdbioruGrupy } from '@/lib/wysylka/zamowienie-kuriera'
import { podsumowanieOdbiorow } from '@/lib/wysylka/kurier-podsumowanie'

/** Powrót na ten sam widok kolejki (zakładka, strefa, strona) — tylko ścieżki /pakowanie. */
function back(v: FormDataEntryValue | null): string {
  const s = typeof v === 'string' ? v : ''
  return /^\/pakowanie(\?[\w=&%.-]*)?$/.test(s) ? s : '/pakowanie'
}

/** „Przyjechał <przewoźnik>”: zamyka dzisiejszy odbiór (drugie kliknięcie tego dnia nic nie zmienia). */
export async function przyjechal(form: FormData): Promise<void> {
  const ctx = await requirePermission('pakowanie.kurier')
  const carrier = String(form.get('przewoznik') ?? '')
  if (isPickupCarrier(carrier)) {
    await markCarrierArrived(ctx.db, { carrier, actorId: ctx.user.id, actorName: ctx.user.name })
    revalidatePath('/pakowanie')
  }
  redirect(back(form.get('wroc')))
}

export interface StanKuriera {
  ok?: boolean
  komunikat: string | null
  /** `info` = wynik częściowy (okno się zamyka, toast nie jest zielony ani czerwony) */
  ton?: 'info'
}

const godzina = (v: FormDataEntryValue | null): number => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(typeof v === 'string' ? v.trim() : '')
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : Number.NaN
}

/**
 * „Zamów kuriera” przy pasku przewoźnika: data, okno godzin, liczba paczek i waga z okna. Bramki, jedno zlecenie na
 * dzień i zapis wyniku w lib/wysylka/zamowienie-kuriera.ts; `drugi=tak` tylko po osobnym potwierdzeniu na ekranie.
 */
export async function zamowKurieraAkcja(_prev: StanKuriera, form: FormData): Promise<StanKuriera> {
  const ctx = await requirePermission('pakowanie.kurier')
  const carrier = String(form.get('przewoznik') ?? '')
  if (!isPickupCarrier(carrier)) return { ok: false, komunikat: 'Nieznany przewoźnik.' }
  const w = await zamowKuriera(ctx.db, {
    carrier,
    data: String(form.get('data') ?? '').trim(),
    odMin: godzina(form.get('od')),
    doMin: godzina(form.get('do')),
    liczba: Number(form.get('liczba')),
    wagaKg: Number(String(form.get('waga') ?? '').replace(',', '.')),
    drugi: form.get('drugi') === 'tak',
    userId: ctx.user.id,
    userName: ctx.user.name,
  })
  revalidatePath('/pakowanie')
  const etykieta = CARRIER_SHORT[carrier]
  const dzis = toWarsaw(new Date()).day
  if (w.wynik !== 'ODBIORY') return komunikatKuriera(w, etykieta, dzis)
  // przewoźnik wymaga osobnych odbiorów: jedno podsumowanie per przewoźnik; okno zamyka się, gdy przyjęto
  // choć jeden odbiór (nieudana część zostaje linią pod paskiem z „Ponów nieudany odbiór”)
  const p = podsumowanieOdbiorow(w.odbiory, etykieta, dzis)
  return { ok: p.ok, komunikat: p.komunikat, ...(p.ton === 'info' ? { ton: 'info' as const } : {}) }
}

function komunikatKuriera(w: WynikOdbioruGrupy, etykieta: string, dzis: string): StanKuriera {
  if (w.wynik === 'ODMOWA') return { ok: false, komunikat: w.powod }
  if (w.wynik === 'BLAD') return { ok: false, komunikat: opisZlecenia(w.zlecenie, etykieta, dzis) }
  if (w.wynik === 'POTWIERDZ_DRUGI') return { ok: false, komunikat: `${opisZlecenia(w.zlecenie, etykieta, dzis)}. ${w.powod}` }
  if (w.wynik === 'NIEJEDNOZNACZNY') return { ok: false, komunikat: opisZlecenia(w.zlecenie, etykieta, dzis) }
  if (w.istnialo) return { ok: true, komunikat: `${opisZlecenia(w.zlecenie, etykieta, dzis)} (zamówiony wcześniej, nie zamówiono drugi raz).` }
  return { ok: true, komunikat: `${opisZlecenia(w.zlecenie, etykieta, dzis)}.` }
}

/**
 * wolne przedziały podjazdu z dostępności przewoźnika dla okna „Zamów kuriera” (odczyt, nic nie zamawia;
 * limit czasu i powrót do pól godzin w lib/wysylka/zamowienie-kuriera.ts).
 */
export async function przedzialyKurieraAkcja(carrier: string): Promise<DostepnoscOkna> {
  const ctx = await requirePermission('pakowanie.kurier')
  if (!isPickupCarrier(carrier)) return { tryb: 'POLA', uwaga: null }
  return przedzialyKuriera(ctx.db, carrier)
}

/**
 * „DPD przyjął zlecenie” / „DPD nie przyjął” przy zamówieniu kuriera, o którym nie wiadomo, czy dotarło
 * (uprawnienie jak do zamawiania kuriera). Zapis, ślad i alert w lib/wysylka/zamowienie-kuriera.ts.
 */
export async function rozstrzygnijKurieraAkcja(_prev: StanKuriera, form: FormData): Promise<StanKuriera> {
  const ctx = await requirePermission('pakowanie.kurier')
  const wariant = String(form.get('wariant') ?? '')
  if (wariant !== 'PRZYJAL' && wariant !== 'NIE_PRZYJAL') return { ok: false, komunikat: 'Nieznany wybór.' }
  const w = await rozstrzygnijKuriera(ctx.db, { id: String(form.get('zlecenie') ?? ''), wariant, numer: String(form.get('numer') ?? ''), userId: ctx.user.id, userName: ctx.user.name })
  revalidatePath('/pakowanie')
  if (w.wynik === 'ODMOWA') return { ok: false, komunikat: w.komunikat }
  const co = wariant === 'PRZYJAL' ? 'przewoźnik przyjął zlecenie' : 'przewoźnik nie przyjął zlecenia, możesz zamówić kuriera jeszcze raz'
  return { ok: true, komunikat: w.wynik === 'JUZ_ROZSTRZYGNIETE' ? 'To zamówienie było już tak rozstrzygnięte: nic nie zmieniono.' : `Zapisane: ${co}.` }
}
