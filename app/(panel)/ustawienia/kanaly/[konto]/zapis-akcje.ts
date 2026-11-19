'use server'
// Ustawienia → Kanały sprzedaży → konto → „Zapis do sklepu”: mapa statusów, „Wypchnij teraz”, przełączenie
// na wersję z zapisem. Tylko z uprawnieniem `ustawienia`. Akcje zapisują wyłącznie w bazie Kompletora; do sklepu pisze
// worker i tylko przy trybie „praca” i włączonym zapisie konta. Komunikaty błędów: tylko nasze teksty.
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { kodKonta, type KontoRef, parseKodKonta } from '@/lib/kanaly/konta'
import { wypchnijTeraz, wyslijStanyPonownie, zapiszMapeStatusow, zapiszPelnyZapisStanow, zmienRodzajKonta } from '@/lib/kanaly/zapis-host'
import { requirePermission } from '@/lib/panel/kontekst'

const registry = defaultRegistry()
const BASE = '/ustawienia/kanaly'

function refOf(form: FormData): KontoRef {
  const ref = parseKodKonta(String(form.get('konto') ?? ''))
  if (!ref) redirect(BASE)
  return ref
}

function back(ref: KontoRef, q: Record<string, string>): never {
  const path = `${BASE}/${encodeURIComponent(kodKonta(ref))}`
  revalidatePath(path)
  redirect(`${path}?${new URLSearchParams(q)}#zapis`)
}

const msgOf = (e: unknown) => (e instanceof Error && /^(Zły|Nie ma|Ten rodzaj|Wersja)/.test(e.message) ? e.message.slice(0, 300) : 'Nie udało się zapisać, spróbuj ponownie')

export async function zapiszMapeStatusowKonta(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  const ref = refOf(form)
  const fields: Record<string, string> = {}
  for (const [k, v] of form.entries()) if (typeof v === 'string' && (k.startsWith('status_') || k.startsWith('statusfirmy_'))) fields[k] = v // nadpisania statusów firmy
  try {
    await zapiszMapeStatusow(ctx.db, ref, fields, { registry, actorId: ctx.user.id })
  } catch (e) {
    back(ref, { blad: msgOf(e) })
  }
  back(ref, { zapisano: 'statusy' })
}

export async function wypchnijTerazKonto(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  const ref = refOf(form)
  try {
    await wypchnijTeraz(ctx.db, ref, { actorId: ctx.user.id })
  } catch (e) {
    back(ref, { blad: msgOf(e) })
  }
  back(ref, { zapisano: 'wypchnij' })
}

export async function przelaczNaZapis(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  const ref = refOf(form)
  try {
    await zmienRodzajKonta(ctx.db, ref, 'zapis', { registry, actorId: ctx.user.id })
  } catch (e) {
    back(ref, { blad: msgOf(e) })
  }
  back(ref, { zapisano: 'wersja-zapisu' })
}

/** konto z zapisem → wersja tylko do odczytu (ten sam klucz API i ustawienia, zapis wyłączony). */
export async function przelaczNaOdczyt(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  const ref = refOf(form)
  try {
    await zmienRodzajKonta(ctx.db, ref, 'odczyt', { registry, actorId: ctx.user.id })
  } catch (e) {
    back(ref, { blad: msgOf(e) })
  }
  back(ref, { zapisano: 'wersja-odczytu' })
}

/** „Wyślij stany ponownie” — zapomina, co już jest w sklepie, i wysyła stany wszystkich ofert konta od nowa. */
export async function wyslijStanyPonownieKonto(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  const ref = refOf(form)
  try {
    await wyslijStanyPonownie(ctx.db, ref, { actorId: ctx.user.id })
  } catch (e) {
    back(ref, { blad: msgOf(e) })
  }
  back(ref, { zapisano: 'stany-ponownie' })
}

/** co ile godzin stany idą do sklepu mimo braku zmian (siatka bezpieczeństwa). */
export async function zapiszPelnyZapisKonta(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  const ref = refOf(form)
  const raw = String(form.get('godziny') ?? '').trim()
  try {
    await zapiszPelnyZapisStanow(ctx.db, ref, /^\d{1,3}$/.test(raw) ? Number(raw) : NaN, { actorId: ctx.user.id })
  } catch (e) {
    back(ref, { blad: msgOf(e) })
  }
  back(ref, { zapisano: 'pelny-zapis' })
}
