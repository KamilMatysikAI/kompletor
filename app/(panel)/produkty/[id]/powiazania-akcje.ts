'use server'
// Karta produktu → Powiązania: „Powiąż z ofertą”, „Odłącz”, „Przepnij na inny produkt”, „Powiąż z towarem
// wFirmy”. Uprawnienie jak przy edycji karty produktu: `produkty.dodawanie` (biuro). Nic nie idzie do
// kanału ani do wFirmy: powiązanie to stan Kompletora (lib/produkty/powiazania.ts). Komunikaty tylko nasze teksty.
import { revalidatePath } from 'next/cache'
import { kodKonta, parseKodKonta } from '@/lib/kanaly/konta'
import { requirePermission } from '@/lib/panel/kontekst'
import { odlaczOferte, PowiazaniaError, powiazZOferta, przepnijOferte, wskazTowarWfirmy } from '@/lib/produkty/powiazania'

export interface StanPowiazan {
  ok: boolean
  komunikat: string | null
}

const ID = /^[a-z0-9]{1,40}$/i

type Ctx = Awaited<ReturnType<typeof requirePermission>>

// Każda akcja sama zaczyna od requirePermission (strażnik tests/panel-dostep), helper dostaje gotowy kontekst.
async function wykonaj(ctx: Ctx, form: FormData, fn: (produkt: string) => Promise<string>): Promise<StanPowiazan> {
  const produkt = String(form.get('produkt') ?? '')
  if (!ID.test(produkt)) return { ok: false, komunikat: 'Nie ma takiego produktu.' }
  try {
    const info = await fn(produkt)
    revalidatePath(`/produkty/${produkt}`)
    revalidatePath('/zamowienia')
    return { ok: true, komunikat: info }
  } catch (e) {
    if (e instanceof PowiazaniaError) return { ok: false, komunikat: e.message.slice(0, 400) }
    // błędy bazy i inne: bez szczegółów
    return { ok: false, komunikat: 'Nie udało się zapisać, spróbuj ponownie.' }
  }
}

export async function powiazAkcja(_prev: StanPowiazan, form: FormData): Promise<StanPowiazan> {
  const ctx = await requirePermission('produkty.dodawanie')
  return wykonaj(ctx, form, async (productId) => {
    const konto = parseKodKonta(String(form.get('konto') ?? ''))
    if (!konto) throw new PowiazaniaError('Nie ma takiego konta kanału.')
    const w = await powiazZOferta(ctx.db, { productId, konto, externalId: form.get('oferta'), sztuk: form.get('sztuk'), actorId: ctx.user.id })
    // „Powiąż” jest też w „Do decyzji” na ekranie konta: po powiązaniu oferta znika z tamtej listy
    revalidatePath(`/ustawienia/kanaly/${encodeURIComponent(kodKonta(konto))}`)
    return w.info
  })
}

export async function odlaczAkcja(_prev: StanPowiazan, form: FormData): Promise<StanPowiazan> {
  const ctx = await requirePermission('produkty.dodawanie')
  return wykonaj(ctx, form, async (productId) => (await odlaczOferte(ctx.db, { productId, offerId: form.get('powiazanie'), actorId: ctx.user.id })).info)
}

export async function przepnijAkcja(_prev: StanPowiazan, form: FormData): Promise<StanPowiazan> {
  const ctx = await requirePermission('produkty.dodawanie')
  return wykonaj(ctx, form, async (productId) => (await przepnijOferte(ctx.db, { productId, offerId: form.get('powiazanie'), cel: form.get('cel'), sztuk: form.get('sztuk'), actorId: ctx.user.id })).info)
}

export async function wskazTowarAkcja(_prev: StanPowiazan, form: FormData): Promise<StanPowiazan> {
  const ctx = await requirePermission('produkty.dodawanie')
  return wykonaj(ctx, form, async (productId) => (await wskazTowarWfirmy(ctx.db, { productId, goodId: form.get('towar'), actorId: ctx.user.id })).info)
}
