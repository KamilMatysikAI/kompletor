'use server'
// Akcje serwera stanowiska pakowania. Każda zaczyna od requirePermission('pakowanie.stanowisko')
// (sesja + uprawnienie, klient bazy firmy z sesji — RLS); strażnik: tests/panel-dostep.integration.test.ts.
// Konto w cieniu: zapis wyłącznie ćwiczenia; konto w PRACY: brak i spakowanie idą do rdzenia (lib/stanowisko/cwiczenie.ts).
import { requirePermission } from '@/lib/panel/kontekst'
import {
  BladStanowiska,
  cofnijBrak,
  dolozBrakDoPaczki,
  naPolceNieBylo,
  otworzZSesji,
  rozpoznajSkan,
  sprawdzSkan,
  zakonczCwiczenie,
  type Blokada,
  type OtwarteCwiczenie,
  type WynikSkanu,
} from '@/lib/stanowisko/cwiczenie'
import { wczytajZamowienia, type ZamowienieStanowiska } from '@/lib/stanowisko/zamowienia'
import { odczytajKodKoszyka } from '@/lib/koszyki/kod'
import { skanKoszyka } from '@/lib/stanowisko/koszyk'

/** Zamówienie dla ekranu: bez migawki rejestru (ekran jej nie potrzebuje). */
export type ZamowienieEkranu = Omit<ZamowienieStanowiska, 'migawka'>

export type WynikAkcji =
  | { typ: 'blokada'; blokada: Blokada; zamowienie: { id: string; numer: string; tryb: 'CIEN' | 'PRACA' } | null }
  | { typ: 'ok'; zamowienie: ZamowienieEkranu; cwiczenie: OtwarteCwiczenie }
  | { typ: 'do_sesji'; zamowienie: ZamowienieEkranu; printId: string }
  /** skan koszyka — komunikat; `koszyk` = koszyk bieżącego zamówienia po skanie. */
  | { typ: 'koszyk'; ton: 'ok' | 'info' | 'blad'; tekst: string; orderId: string | null; koszyk: string | null }

function ekran(z: ZamowienieStanowiska): ZamowienieEkranu {
  const { migawka: _m, ...reszta } = z
  return reszta
}

function wynik(w: WynikSkanu): WynikAkcji {
  return w.typ === 'ok' ? { typ: 'ok', zamowienie: ekran(w.zamowienie), cwiczenie: w.cwiczenie } : w
}

/** Błąd dla pakującego zamiast wyjątku (komunikat na pasku okna). */
async function bezpiecznie<T>(fn: () => Promise<T>): Promise<{ ok: true; wynik: T } | { ok: false; komunikat: string }> {
  try {
    return { ok: true, wynik: await fn() }
  } catch (e) {
    if (e instanceof BladStanowiska) return { ok: false, komunikat: e.message }
    throw e
  }
}

/**
 * Skan w polu skanu: otwiera zamówienie w oknie. `wTrakcie` = okno otwarte, skan karty tylko dokłada do sesji.
 * Kod koszyka: przy otwartym oknie `biezace` trafia do koszyka, bez okna koszyk otwiera swoje zamówienie.
 */
export async function skanujKarte(tekst: string, wTrakcie: boolean, biezace: string | null = null): Promise<WynikAkcji> {
  const ctx = await requirePermission('pakowanie.stanowisko')
  const t = String(tekst ?? '').slice(0, 300)
  const koszyk = odczytajKodKoszyka(t)
  if (koszyk) {
    const id = wTrakcie && typeof biezace === 'string' && /^[a-z0-9]{1,40}$/i.test(biezace) ? biezace : null
    if (wTrakcie && !id) return { typ: 'koszyk', ton: 'blad', tekst: 'Najpierw otwórz zamówienie, potem zeskanuj koszyk.', orderId: null, koszyk: null }
    const s = await bezpiecznie(() => skanKoszyka(ctx.db, koszyk, id, { userId: ctx.user.id }))
    if (!s.ok) return { typ: 'koszyk', ton: 'blad', tekst: s.komunikat, orderId: null, koszyk: null }
    return s.wynik.typ === 'koszyk' ? s.wynik : wynik(s.wynik.wynik)
  }
  if (wTrakcie) {
    const s = await sprawdzSkan(ctx.db, t)
    return s.typ === 'do_sesji' ? { typ: 'do_sesji', zamowienie: ekran(s.zamowienie), printId: s.karta.printId } : s
  }
  return wynik(await rozpoznajSkan(ctx.db, t, { userId: ctx.user.id }))
}

export async function otworzZListy(orderId: string, printId: string | null): Promise<WynikAkcji> {
  const ctx = await requirePermission('pakowanie.stanowisko')
  return wynik(await otworzZSesji(ctx.db, String(orderId ?? ''), printId ? String(printId) : null, { userId: ctx.user.id }))
}

/** 19.11.2026: podgląd spakowanego zamówienia w oknie pakowania (tylko odczyt: pozycje, przesyłka, etykieta). */
export async function podgladSpakowanego(orderId: string): Promise<ZamowienieEkranu | null> {
  const ctx = await requirePermission('pakowanie.stanowisko')
  const id = String(orderId ?? '')
  if (!id) return null
  const [z] = await wczytajZamowienia(ctx.db, [id])
  return z ? ekran(z) : null
}

export async function zapiszBrak(drillId: string, klucz: string, ilosc: number) {
  const ctx = await requirePermission('pakowanie.stanowisko')
  return bezpiecznie(() => naPolceNieBylo(ctx.db, { drillId: String(drillId), klucz: String(klucz), ilosc: Number(ilosc), userId: ctx.user.id }))
}

export async function usunBrak(drillId: string, fixId: string) {
  const ctx = await requirePermission('pakowanie.stanowisko')
  return bezpiecznie(() => cofnijBrak(ctx.db, { drillId: String(drillId), fixId: String(fixId), userId: ctx.user.id }))
}

export async function zapiszWynik(a: { drillId: string; wynik: 'SPAKOWANE' | 'NIE_SPAKOWANO'; gabaryt: string | null; zebrane: Record<string, number>; uwagiOdhaczone: boolean }) {
  const ctx = await requirePermission('pakowanie.stanowisko')
  const zebrane: Record<string, number> = {}
  for (const [k, v] of Object.entries(a?.zebrane ?? {}).slice(0, 500)) zebrane[String(k)] = Number(v)
  return bezpiecznie(() =>
    zakonczCwiczenie(ctx.db, {
      drillId: String(a?.drillId ?? ''),
      wynik: a?.wynik,
      gabaryt: a?.gabaryt ?? null,
      zebrane,
      uwagiOdhaczone: a?.uwagiOdhaczone === true,
      userId: ctx.user.id,
    }),
  )
}

/** „Jednak jest w paczce” przy ramce „Brakuje, nie pakuj” (towar w ręku, system go nie przydzielił). */
export async function dolozDoPaczki(drillId: string, orderLineId: string) {
  const ctx = await requirePermission('pakowanie.stanowisko')
  return bezpiecznie(() => dolozBrakDoPaczki(ctx.db, { drillId: String(drillId), orderLineId: String(orderLineId), userId: ctx.user.id }))
}
