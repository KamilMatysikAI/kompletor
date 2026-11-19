'use server'
// Karta produktu → „Publikacja”: podgląd oferty na koncie kanału i „Wystaw”. Podgląd czyta kanał tylko
// przez publiczny odczyt adaptera (GET z listy ścieżek); „Wystaw” wysyła tylko przy włączonym przełączniku konta
// „Wystawianie ofert” (Ustawienia → Sprzedaż i kanały → Kanały sprzedaży → konto → „Zapis do sklepu”).
// Komunikaty błędów: tylko nasze teksty (treść wyjątku mogłaby nieść dane z kanału). Ręczny wybór kategorii i parametrów
// (3b-2b) przychodzi z przeglądarki i przechodzi przez `wyborRecznyZWejscia`; „Wystaw” liczy podgląd z tym samym wyborem.
import { revalidatePath } from 'next/cache'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { kafelPublikacji, wystawNaKoncie, type ZaleznosciPublikacji } from '@/lib/oferty/publikacja-serwer'
import { type KafelPublikacji, wyborRecznyZWejscia } from '@/lib/oferty/publikacja'
import { appModeOf } from '@/lib/organizacje'
import { requirePermission, requireSession } from '@/lib/panel/kontekst'

const registry = defaultRegistry()
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const KLUCZ_RE = /^[A-Za-z0-9_:./-]{1,140}$/

const zaleznosci = (): ZaleznosciPublikacji => ({ registry, src: { env: process.env, envFallback: appModeOf(process.env) === 'self-host' } })

export type WynikPodgladu = { ok: true; kafel: KafelPublikacji } | { ok: false; blad: string }

export async function przygotujPodgladPublikacji(productId: string, klucz: string, reczne?: unknown): Promise<WynikPodgladu> {
  const ctx = await requireSession()
  if (!ID_RE.test(productId) || !KLUCZ_RE.test(klucz)) return { ok: false, blad: 'Zły adres produktu albo konta.' }
  try {
    const kafel = await kafelPublikacji(ctx.db, productId, klucz, zaleznosci(), undefined, wyborRecznyZWejscia(reczne))
    return kafel ? { ok: true, kafel } : { ok: false, blad: 'Nie ma takiego produktu albo konta.' }
  } catch (e) {
    console.error(`[publikacja] podgląd ${klucz}: ${e instanceof Error ? e.name : 'błąd'}`)
    return { ok: false, blad: 'Nie udało się przygotować podglądu, spróbuj ponownie za chwilę.' }
  }
}

export type WynikWystawieniaEkranu = { ok: boolean; komunikat: string }

export async function wystawOferte(productId: string, klucz: string, reczne?: unknown): Promise<WynikWystawieniaEkranu> {
  const ctx = await requirePermission('produkty.dodawanie')
  if (!ID_RE.test(productId) || !KLUCZ_RE.test(klucz)) return { ok: false, komunikat: 'Zły adres produktu albo konta.' }
  try {
    const w = await wystawNaKoncie(ctx.db, productId, klucz, zaleznosci(), ctx.user.id, wyborRecznyZWejscia(reczne))
    revalidatePath(`/produkty/${productId}/publikacja`)
    return { ok: w.kind === 'OK', komunikat: w.komunikat }
  } catch (e) {
    console.error(`[publikacja] wystawienie ${klucz}: ${e instanceof Error ? e.name : 'błąd'}`)
    return { ok: false, komunikat: 'Nie udało się wystawić: sprawdź w kanale, czy oferta nie powstała, zanim spróbujesz ponownie.' }
  }
}
