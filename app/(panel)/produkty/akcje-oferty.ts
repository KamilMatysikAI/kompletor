'use server'
// Produkty → zaznaczenie na liście → „Przygotuj oferty” (3b-2): zlecenie zadania w tle, które liczy podgląd
// oferty każdego zaznaczonego produktu na każdym koncie Allegro, Empiku i sklepu (bez wystawiania), i przejście do
// raportu przebiegu. Uprawnienie jak „Wystaw” na ekranie Publikacja (`produkty.dodawanie`).
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { OFERTY_RAPORTY, PrzygotowanieError, zlecPrzygotowanieOfert } from '@/lib/oferty/masowo'
import { requirePermission } from '@/lib/panel/kontekst'

export async function przygotujOfertyZaznaczonych(form: FormData): Promise<void> {
  const ctx = await requirePermission('produkty.dodawanie')
  let id: string
  try {
    id = await zlecPrzygotowanieOfert(ctx.db, form.getAll('zaznaczone'), ctx.user.id)
  } catch (e) {
    const blad = e instanceof PrzygotowanieError ? e.message : 'Nie udało się zlecić przygotowania ofert, spróbuj ponownie za chwilę.'
    if (!(e instanceof PrzygotowanieError)) console.error(`[oferty-masowo] zlecenie: ${e instanceof Error ? e.name : 'błąd'}`)
    redirect(`/produkty?${new URLSearchParams({ blad })}`)
  }
  revalidatePath(OFERTY_RAPORTY)
  redirect(`${OFERTY_RAPORTY}/${id}`)
}
