'use server'
// Ustawienia → Automatyczne akcje → „Wczytaj szablon”: wczytanie szablonu przepływu po podglądzie. Tylko
// z uprawnieniem `ustawienia`; logika (tryb pełny / dodanie bez nadpisania) w lib/automaty/szablony.ts.
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requirePermission } from '@/lib/panel/kontekst'
import { liczbaRegul, SzablonError, szablonPrzeplywu, wczytajSzablon } from '@/lib/automaty/szablony'

export async function wczytajSzablonAkcja(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  const id = String(form.get('szablon') ?? '').slice(0, 40)
  const sz = szablonPrzeplywu(id)
  let q: Record<string, string>
  try {
    if (!sz) throw new SzablonError('Nie ma takiego szablonu.')
    const w = await wczytajSzablon(ctx.db, id, ctx.user.id)
    q =
      w.tryb === 'PELNY'
        ? { zapisano: `Wczytano szablon „${sz.nazwa}”: statusy i ${liczbaRegul(w.reguly)}, reguły włączone.` }
        : { zapisano: `Dodano ${liczbaRegul(w.reguly)} w grupie „${w.grupa}”, wyłączone. Sprawdź je przyciskiem „Sprawdź na ostatnich 7 dniach” i włącz.${w.pominiete ? ` Pominięte: ${w.pominiete}.` : ''}` }
  } catch (e) {
    if (!(e instanceof SzablonError)) console.error('[automaty] wczytanie szablonu nie przeszło', e instanceof Error ? e.message : e)
    q = { blad: e instanceof SzablonError ? e.message : 'Nie udało się wczytać szablonu — spróbuj ponownie.' }
  }
  revalidatePath('/ustawienia/automaty')
  redirect(`/ustawienia/automaty?${new URLSearchParams(q)}`)
}
