'use server'
// Ustawienia → Automatyczne akcje: zapis reguły (jeden zapis na okno), włączanie, duplikowanie, usuwanie,
// kolejność, grupy i podgląd na sucho. Tylko z uprawnieniem `ustawienia`; logika i walidacja w lib/automaty.
import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/panel/kontekst'
import { AutomatyError, ustawPlanWbudowany, ustawMaileZwrotow, duplikujRegule, ekranAutomatow, kolejnoscGrup, przelaczRegule, usunGrupe, usunRegule, ustawKolejnosc, zapiszGrupe, zapiszRegule, type EkranAutomatow } from '@/lib/automaty/dane'
import { parsujRegule, type BladReguly } from '@/lib/automaty/schemat'
import { kontekstZ } from '@/lib/automaty/dane'
import { podgladNaSucho } from '@/lib/automaty/silnik'
import { statusyFirmy } from '@/lib/panel/statusy-firmy-dane'
import type { Ostrzezenie } from '@/lib/automaty/warunki'

export interface WynikAkcji {
  ok: boolean
  komunikat: string
  bledy?: BladReguly[]
  ostrzezenia?: Ostrzezenie[]
  ekran?: EkranAutomatow
}

const SCIEZKA = '/ustawienia/automaty'

type Ctx = Awaited<ReturnType<typeof requirePermission>>

/** Wspólna obsługa wyniku; sesję i uprawnienie sprawdza każda akcja na początku (strażnik w testach dostępu). */
async function wykonaj(ctx: Ctx, fn: (db: Ctx['db'], userId: string) => Promise<string | { komunikat: string; ostrzezenia?: Ostrzezenie[] }>): Promise<WynikAkcji> {
  try {
    const r = await fn(ctx.db, ctx.user.id)
    revalidatePath(SCIEZKA)
    const x = typeof r === 'string' ? { komunikat: r } : r
    return { ok: true, ...x, ekran: await ekranAutomatow(ctx.db) }
  } catch (e) {
    if (e instanceof AutomatyError) return { ok: false, komunikat: e.message, bledy: e.bledy }
    console.error('[automaty] zapis nie przeszedł', e instanceof Error ? e.message : e)
    return { ok: false, komunikat: 'Nie udało się zapisać — spróbuj ponownie.' }
  }
}

export async function zapiszReguleAkcja(w: { id?: string | null; groupId?: string | null; enabled?: boolean; regula: unknown }): Promise<WynikAkcji> {
  const ctx = await requirePermission('ustawienia')
  return wykonaj(ctx, async (db, u) => {
    const r = await zapiszRegule(db, w, u)
    return { komunikat: w.id ? 'Zapisano regułę.' : w.enabled ? 'Dodano i włączono regułę.' : 'Dodano regułę (wyłączona: włącz ją po sprawdzeniu).', ostrzezenia: r.ostrzezenia }
  })
}

export async function przelaczAkcja(id: string, enabled: boolean): Promise<WynikAkcji> {
  const ctx = await requirePermission('ustawienia')
  return wykonaj(ctx, async (db, u) => {
    await przelaczRegule(db, id, enabled, u)
    return enabled ? 'Reguła włączona.' : 'Reguła wyłączona.'
  })
}

export async function duplikujAkcja(id: string): Promise<WynikAkcji> {
  const ctx = await requirePermission('ustawienia')
  return wykonaj(ctx, async (db, u) => {
    await duplikujRegule(db, id, u)
    return 'Dodano kopię reguły (wyłączona).'
  })
}

export async function usunAkcja(id: string): Promise<WynikAkcji> {
  const ctx = await requirePermission('ustawienia')
  return wykonaj(ctx, async (db, u) => ((await usunRegule(db, id, u)) === 'ukryta' ? 'Reguła wyłączona i ukryta: jej wpisy zostają w historii zamówień.' : 'Reguła usunięta.'))
}

export async function kolejnoscAkcja(uklad: { groupId: string | null; ids: string[] }[]): Promise<WynikAkcji> {
  const ctx = await requirePermission('ustawienia')
  return wykonaj(ctx, async (db, u) => {
    await ustawKolejnosc(db, uklad, u)
    return 'Zapisano kolejność.'
  })
}

export async function grupaAkcja(g: { id?: string | null; name?: string; collapsed?: boolean }): Promise<WynikAkcji> {
  const ctx = await requirePermission('ustawienia')
  return wykonaj(ctx, async (db, u) => {
    await zapiszGrupe(db, { id: g.id, name: g.name, collapsed: g.collapsed }, u)
    return g.id ? 'Zapisano grupę.' : 'Dodano grupę.'
  })
}

export async function usunGrupeAkcja(id: string): Promise<WynikAkcji> {
  const ctx = await requirePermission('ustawienia')
  return wykonaj(ctx, async (db, u) => {
    await usunGrupe(db, id, u)
    return 'Grupa usunięta, jej reguły są teraz w „Bez grupy”.'
  })
}

export async function kolejnoscGrupAkcja(ids: string[]): Promise<WynikAkcji> {
  const ctx = await requirePermission('ustawienia')
  return wykonaj(ctx, async (db, u) => {
    await kolejnoscGrup(db, ids, u)
    return 'Zapisano kolejność grup.'
  })
}

/** Podgląd na sucho: tylko odczyt (bez zapisu i bez wywołań sklepów, przewoźników, programu do faktur). */
export async function podgladAkcja(regula: unknown): Promise<{ ok: boolean; zdanie: string; przyklady?: string[]; bledy?: BladReguly[] }> {
  const ctx = await requirePermission('ustawienia')
  const p = parsujRegule(regula, kontekstZ((await statusyFirmy(ctx.db)).statusy))
  if (!p.ok) return { ok: false, zdanie: p.bledy[0]?.komunikat ?? 'Popraw regułę', bledy: p.bledy }
  const w = await podgladNaSucho(ctx.db, p.regula)
  return { ok: true, zdanie: w.zdanie, przyklady: w.przyklady }
}

/** włączenie albo wyłączenie wbudowanego planu maili do zamówień (ślad w AuditLog). */
export async function planWbudowanyAkcja(wlaczony: boolean): Promise<WynikAkcji> {
  const ctx = await requirePermission('ustawienia')
  return wykonaj(ctx, async (db, u) => {
    await ustawPlanWbudowany(db, wlaczony === true, u)
    return wlaczony ? 'Kompletor znów planuje maile do zamówień.' : 'Maile do zamówień planują teraz tylko reguły.'
  })
}

/** Włączenie albo wyłączenie maili do klienta o zwrotach i reklamacjach (ślad w AuditLog). */
export async function maileZwrotowAkcja(wlaczony: boolean): Promise<WynikAkcji> {
  const ctx = await requirePermission('ustawienia')
  return wykonaj(ctx, async (db, u) => {
    await ustawMaileZwrotow(db, wlaczony === true, u)
    return wlaczony ? 'Klienci dostaną maile o zwrotach i reklamacjach odebranych od teraz.' : 'Maile o zwrotach i reklamacjach wyłączone.'
  })
}
