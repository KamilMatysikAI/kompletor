'use server'
// Ustawienia → Statusy zamówień: zapis grup i statusów firmy jednym zapisem (lib/panel/statusy-firmy-dane.ts).
// Tylko z uprawnieniem `ustawienia`. Błąd walidacji wraca z id pola.
import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/panel/kontekst'
import { StatusyError, ustawieniaStatusow, zapiszStatusyFirmy, type StatusUstawienia } from '@/lib/panel/statusy-firmy-dane'
import type { GrupaStatusowT } from '@/lib/panel/statusy'

export interface StanStatusow {
  ok?: boolean
  komunikat?: string
  pole?: string
  statusy?: StatusUstawienia[]
  grupy?: GrupaStatusowT[]
}

export async function zapiszStatusyAkcja(_prev: StanStatusow, form: FormData): Promise<StanStatusow> {
  const ctx = await requirePermission('ustawienia')
  const all = (k: string) => form.getAll(k).map(String)
  const [gKlucze, gRefy, gNazwy, gZwiniete] = [all('grupa-klucz'), all('grupa-ref'), all('grupa-nazwa'), all('grupa-zwinieta')]
  const [sKlucze, sNazwy, sKlient, sKolory, sGrupy, sBazowe, sPrzew, sAktywne] = [all('status-klucz'), all('status-nazwa'), all('status-klient'), all('status-kolor'), all('status-grupa'), all('status-bazowy'), all('status-przewoznicy'), all('status-aktywny')]
  try {
    const r = await zapiszStatusyFirmy(
      ctx.db,
      {
        grupy: gKlucze.map((k, i) => ({ key: k || null, ref: gRefy[i] ?? '', name: gNazwy[i] ?? '', collapsed: gZwiniete[i] === 'tak' })),
        statusy: sKlucze.map((k, i) => ({
          key: k || null,
          name: sNazwy[i] ?? '',
          customerName: sKlient[i] ?? '',
          color: sKolory[i] ?? '',
          group: sGrupy[i] ?? '',
          baseStatus: sBazowe[i] ?? '',
          carriers: (sPrzew[i] ?? '').split(',').filter(Boolean),
          active: sAktywne[i] !== 'nie',
        })),
      },
      ctx.user.id,
    )
    revalidatePath('/ustawienia/statusy')
    revalidatePath('/zamowienia')
    const u = await ustawieniaStatusow(ctx.db)
    return { ok: true, komunikat: `Zapisano: ${r.statusy} statusów, ${r.grupy} grup.`, ...u }
  } catch (e) {
    if (e instanceof StatusyError) return { ok: false, komunikat: e.message, pole: e.pole }
    return { ok: false, komunikat: 'Nie udało się zapisać — spróbuj ponownie' }
  }
}
