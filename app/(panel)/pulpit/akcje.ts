'use server'
// Pulpit: lista startu („Pomiń”, „Przywróć”, „Ukryj listę”) i „Włącz tryb pracy” dla kont sklepów firmy.
// Lista: uprawnienie `ustawienia`; „Włącz tryb pracy”: `kanaly.tryb` i `ustawienia`, jak przełącznik jednego konta
// (Pulpit nie może omijać uprawnienia „Zmiana trybu kanału”). Logika w lib/start (zapis z blokadą wiersza firmy, AuditLog, warunki trybu z
// lib/kanaly/tryb.ts). Wynik wraca parametrem adresu i pokazuje go toast.
import { revalidatePath } from 'next/cache'
import { notFound, redirect } from 'next/navigation'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { firmaPrzechodziZBlWPanelu } from '@/lib/kanaly/firma'
import { requirePermission } from '@/lib/panel/kontekst'
import { isKrokStartu, zmienStart } from '@/lib/start/lista'
import { komunikatPominiec, komunikatWlaczenia, wlaczPraceFirmy } from '@/lib/start/tryb-firmy'

const PATH = '/pulpit'

export async function zmienKrokStartu(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  const krok = form.get('krok')
  const co = String(form.get('co') ?? '')
  if (co === 'ukryj' || co === 'pokaz') await zmienStart(ctx.db, { ukryj: co === 'ukryj' }, ctx.user.id)
  else if (isKrokStartu(krok) && (co === 'pomin' || co === 'przywroc')) await zmienStart(ctx.db, { krok, pomin: co === 'pomin' }, ctx.user.id)
  revalidatePath(PATH)
  redirect(PATH)
}

export async function wlaczTrybPracy(): Promise<void> {
  const ctx = await requirePermission('kanaly.tryb')
  if (!ctx.permissions.has('ustawienia')) notFound() // karta „Stan kanałów” z przyciskiem jest dla `ustawienia`
  const w = await wlaczPraceFirmy(ctx.db, { actorId: ctx.user.id, env: process.env, registry: defaultRegistry(), firmaZBl: await firmaPrzechodziZBlWPanelu(ctx.db) })
  const q = new URLSearchParams()
  if (w.wlaczone.length) q.set('tryb', komunikatWlaczenia(w.wlaczone))
  if (w.pominiete.length) q.set('trybBlad', komunikatPominiec(w.pominiete))
  if (!w.wlaczone.length && !w.pominiete.length) q.set('tryb', 'Wszystkie konta są już w trybie pracy.')
  revalidatePath('/', 'layout')
  redirect(`${PATH}?${q}`)
}
