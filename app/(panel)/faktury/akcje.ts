'use server'
// Akcje listy faktur: „Ponów” po błędzie i „Wyślij do KSeF”. Zaczynają od requirePermission (sesja +
// uprawnienie, klient bazy firmy z sesji, RLS). wFirma: zdjęcie błędu, a wystawia kolejka wFirmy w najbliższym
// przebiegu (ta sama ścieżka co „Ponów fakturę” na karcie, bez drugiej faktury). KSeF: wysyłka od razu, z tym samym
// numerem przy ponowieniu i z limitem czasu próby (KSeF bez odpowiedzi nie trzyma ekranu minutami).
// Korekta wFirmy po błędzie: ponowienie korekty zwrotu (lib/rdzen/zwroty.ts).
import { revalidatePath } from 'next/cache'
import { appModeOf } from '@/lib/organizacje'
import { wyslijDoKsef, wyslijKorekteKsef, zLimitemProbyRecznej, type WynikWysylki } from '@/lib/ksef/wysylka'
import { requirePermission } from '@/lib/panel/kontekst'
import { PackError, ponowFaktureRecznie } from '@/lib/rdzen/rozchod'
import { retryCorrection, ReturnError } from '@/lib/rdzen/zwroty'

type WynikAkcji = { blad: string | null; komunikat?: string }

const ID = /^[a-z0-9]{1,40}$/i

function opis(w: WynikWysylki): WynikAkcji {
  if (w.wynik === 'przyjeta') return { blad: null, komunikat: `Faktura ${w.numer} przyjęta w KSeF${w.ksefNumer ? `: ${w.ksefNumer}` : ''}` }
  if (w.wynik === 'w_toku') return { blad: null, komunikat: w.powod }
  return { blad: w.powod }
}

const zaleznosci = (actorId: string) => ({ secrets: { env: process.env, envFallback: appModeOf(process.env) === 'self-host' }, actorId })

export async function ponowDokument(klucz: string, potwierdzone = false): Promise<WynikAkcji> {
  const ctx = await requirePermission('zamowienia.faktury')
  const [rodzaj, id] = String(klucz ?? '').split(':')
  if (!id || !ID.test(id)) return { blad: 'Nie ma takiego dokumentu.' }
  if (rodzaj === 'z') {
    if (!ctx.permissions.has('zwroty.korekty')) return { blad: 'Brak uprawnienia „Zwroty: zlecenie korekty faktury”.' }
    try {
      await retryCorrection(ctx.db, id, { actorId: ctx.user.id, potwierdzone })
    } catch (e) {
      if (e instanceof ReturnError) return { blad: e.message }
      throw e
    }
    revalidatePath('/faktury')
    return { blad: null, komunikat: 'Korekta wróciła do kolejki: system spróbuje ją wystawić w ciągu kilku minut' }
  }
  if (rodzaj === 'w') {
    const a = await ctx.db.invoiceAttempt.findUnique({ where: { id }, select: { orderId: true } })
    if (!a) return { blad: 'Nie ma takiej faktury.' }
    try {
      await ponowFaktureRecznie(ctx.db, a.orderId, { actorId: ctx.user.id })
    } catch (e) {
      if (e instanceof PackError) return { blad: e.message }
      throw e
    }
    revalidatePath('/faktury')
    return { blad: null, komunikat: 'Faktura wróciła do kolejki: system spróbuje ją wystawić w ciągu kilku minut' }
  }
  if (rodzaj === 'k') {
    const w = await zLimitemProbyRecznej(zaleznosci(ctx.user.id), (d) => wyslijDoKsef(ctx.db, id, d))
    revalidatePath('/faktury')
    return opis(w)
  }
  return { blad: 'Nie ma takiego dokumentu.' }
}

/** Korekta KSeF przy zwrocie (lista faktur i karta zwrotu): uprawnienie korekt zwrotów. */
export async function wyslijKorekte(returnId: string): Promise<WynikAkcji> {
  const ctx = await requirePermission('zwroty.korekty')
  const id = String(returnId ?? '')
  if (!ID.test(id)) return { blad: 'Nie ma takiego zwrotu.' }
  const w = await zLimitemProbyRecznej(zaleznosci(ctx.user.id), (d) => wyslijKorekteKsef(ctx.db, id, d))
  revalidatePath('/faktury')
  revalidatePath(`/zwroty/${id}`)
  return opis(w)
}
