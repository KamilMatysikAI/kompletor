'use server'
// Ustawienia → Strefy magazynu: zapis stref i reguł jednym zapisem (lib/pakowanie/strefy-dane.ts).
// Tylko z uprawnieniem `ustawienia`. Błąd walidacji wraca z id pola.
import { revalidatePath } from 'next/cache'
import { ustawieniaStref, StrefyError, zapiszStrefy, type RegulaUstawienia, type StrefaUstawienia } from '@/lib/pakowanie/strefy-dane'
import { requirePermission } from '@/lib/panel/kontekst'
import { wzorzecZPola } from '@/lib/panel/slowa'

export interface StanStref {
  ok?: boolean
  komunikat?: string
  pole?: string
  strefy?: StrefaUstawienia[]
  reguly?: RegulaUstawienia[]
}

export async function zapiszStrefyAkcja(_prev: StanStref, form: FormData): Promise<StanStref> {
  const ctx = await requirePermission('ustawienia')
  const all = (k: string) => form.getAll(k).map(String)
  const [klucze, refy, nazwy, kolory] = [all('strefa-klucz'), all('strefa-ref'), all('strefa-nazwa'), all('strefa-kolor')]
  const [rStrefy, rTryby, rSlowa] = [all('regula-strefa'), all('regula-tryb'), all('regula-slowa')]
  try {
    const r = await zapiszStrefy(
      ctx.db,
      {
        strefy: klucze.map((k, i) => ({ key: k || null, ref: refy[i] ?? '', name: nazwy[i] ?? '', color: kolory[i] ?? '' })),
        reguly: rStrefy.map((z, i) => ({ zone: z, pattern: wzorzecZPola(rTryby[i] ?? 'slowa', rSlowa[i] ?? '') })),
      },
      ctx.user.id,
    )
    revalidatePath('/ustawienia/strefy')
    revalidatePath('/pakowanie')
    const u = await ustawieniaStref(ctx.db)
    return { ok: true, komunikat: `Zapisano: ${r.strefy} stref, ${r.reguly} reguł.`, ...u }
  } catch (e) {
    if (e instanceof StrefyError) return { ok: false, komunikat: e.message, pole: e.pole }
    return { ok: false, komunikat: 'Nie udało się zapisać — spróbuj ponownie' }
  }
}
