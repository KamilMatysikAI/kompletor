'use server'
// Ustawienia → Dokumenty sprzedaży: zapis programu do faktur i zasad wystawiania oraz źródła stanu
// magazynu. Tylko z uprawnieniem `ustawienia`; zapis przez lib/dokumenty/zapis.ts (walidacja + AuditLog).
// jeden formularz i jeden zapis (źródło stanu i dokumenty w jednej transakcji); wynik jako toast z adresu.
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { dokumentyZFormularza, programyDoWyboru, UstawieniaDokumentowError, zapiszDokumentySprzedazy } from '@/lib/dokumenty/zapis'
import { KSEF_TOKEN, poZapisieTokenuKsef } from '@/lib/ksef/wysylka'
import { requirePermission } from '@/lib/panel/kontekst'
import { setSecret } from '@/lib/sekrety'

const PATH = '/ustawienia/dokumenty'

export async function zapiszDokumenty(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  let q: Record<string, string>
  try {
    const zrodlo = form.get('zrodlo')
    // token KSeF zapisany zaszyfrowany (IntegrationSecret), wartość nie trafia do historii zmian ani logów
    const token = String(form.get('ksefToken') ?? '').trim()
    if (token && (token.length > 2000 || /\s/.test(token))) throw new UstawieniaDokumentowError('Token KSeF: wklej sam token, bez spacji i znaków nowej linii')
    const r = await zapiszDokumentySprzedazy(ctx.db, { zrodlo: typeof zrodlo === 'string' && zrodlo ? zrodlo : null, dokumenty: dokumentyZFormularza(form) }, ctx.user.id, programyDoWyboru(defaultRegistry().list()))
    if (token) {
      await setSecret(ctx.db, KSEF_TOKEN, token, process.env)
      await ctx.db.auditLog.create({ data: { entity: 'IntegrationSecret', entityId: KSEF_TOKEN, actorId: ctx.user.id, after: { zmiana: 'token KSeF zapisany' } } })
      // faktury z błędem logowania albo bez tokenu wracają do automatu z pełną pulą ponowień. Token
      // jest już zapisany, więc błąd tego kroku nie cofa zapisu: trafia do logu serwera, a faktury czekają na „Ponów”
      await poZapisieTokenuKsef(ctx.db).catch((e) => console.error('[ksef] po zapisie tokenu: nie udało się wrócić faktur do automatu', e instanceof Error ? e.message : e))
    }
    q = { zapisano: r.zrodlo || r.dokumenty || token ? (r.zrodlo ? 'zrodlo' : '1') : 'bez-zmian' }
  } catch (e) {
    q = { blad: e instanceof UstawieniaDokumentowError ? e.message : 'Nie udało się zapisać — spróbuj ponownie' }
  }
  revalidatePath(PATH)
  redirect(`${PATH}?${new URLSearchParams(q)}`)
}
