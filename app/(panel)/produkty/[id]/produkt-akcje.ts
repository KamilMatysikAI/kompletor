'use server'
// Karta produktu: edycja danych, zdjęcia (wgranie, kolejność, główne, usunięcie do archiwum w bazie), skład zestawu,
// podpowiedź opisu AI. Uprawnienie `produkty.dodawanie` (dodawanie i edycja produktów). Pola z wFirmy przy produkcie
// z wFirmy odrzuca lib/produkty/karta.ts (nie tylko ekran).
import { revalidatePath } from 'next/cache'
import { IMAGE_POLICY, readUploads } from '@/lib/files/upload-guard'
import { requirePermission } from '@/lib/panel/kontekst'
import { podpowiedzOpis, type DaneDoOpisu } from '@/lib/produkty/ai-opis'
import { edytujProdukt, edytujSklad } from '@/lib/produkty/karta'
import { dodajZFormularza, MAX_ZDJEC, usunZdjecie, zmienZdjecie, type ZmianaZdjecia } from '@/lib/produkty/zdjecia'
import { zlecPackshot } from '@/lib/produkty/packshot'

export interface StanKarty {
  ok: boolean
  error: string | null
  field: string | null
  zmiany?: number
  /** „SKU zajęte”: id produktu z tym SKU (link w komunikacie). */
  istniejacyId?: string | null
  /** Zapisane, ale z ostrzeżeniem (np. cena bez stawki VAT). */
  uwagi?: string[]
}

const ID = /^[a-z0-9]{1,40}$/i
const POLA = ['sku', 'nazwa', 'ean', 'opis', 'waga', 'dlugosc', 'szerokosc', 'wysokosc', 'prog', 'lokalizacja', 'cena', 'vat', 'cenaZakupu', 'grupa']

export async function zapiszKarte(_prev: StanKarty, form: FormData): Promise<StanKarty> {
  const ctx = await requirePermission('produkty.dodawanie')
  const id = String(form.get('produkt') ?? '')
  if (!ID.test(id)) return { ok: false, error: 'Nie ma takiego produktu.', field: null }
  const pola: Record<string, unknown> = {}
  for (const k of POLA) if (form.has(k)) pola[k] = form.get(k)
  const r = await edytujProdukt(ctx.db, id, pola, ctx.user.id)
  if (!r.ok) return { ok: false, error: r.error, field: r.field ?? null, istniejacyId: r.istniejacyId ?? null }
  revalidatePath(`/produkty/${id}`)
  revalidatePath('/produkty')
  return { ok: true, error: null, field: null, zmiany: r.zmiany.length, ...(r.warnings?.length ? { uwagi: r.warnings } : {}) }
}

export async function zapiszSklad(_prev: StanKarty, form: FormData): Promise<StanKarty> {
  const ctx = await requirePermission('produkty.dodawanie')
  const id = String(form.get('produkt') ?? '')
  if (!ID.test(id)) return { ok: false, error: 'Nie ma takiego produktu.', field: null }
  const r = await edytujSklad(ctx.db, id, { ids: form.getAll('skladnik'), ilosci: form.getAll('ilosc'), udzialy: form.getAll('udzial') }, ctx.user.id)
  if (!r.ok) return { ok: false, error: r.error, field: r.field ?? null }
  revalidatePath(`/produkty/${id}`)
  return { ok: true, error: null, field: null, zmiany: 1 }
}

/** Stan zakładki „Zdjęcia”: komunikat po akcji bez parametrów w adresie. */
export interface StanZdjec {
  ok: boolean
  komunikat: string | null
}

async function wgraj(ctx: Awaited<ReturnType<typeof requirePermission>>, form: FormData): Promise<StanZdjec> {
  const id = String(form.get('produkt') ?? '')
  if (!ID.test(id)) return { ok: false, komunikat: 'Nie ma takiego produktu.' }
  const files = await readUploads(form.getAll('zdjecia'), IMAGE_POLICY, { maxFiles: MAX_ZDJEC })
  if (!files.ok) return { ok: false, komunikat: files.message.slice(0, 300) }
  if (!files.files.length) return { ok: false, komunikat: 'Wybierz co najmniej jedno zdjęcie.' }
  const r = await dodajZFormularza(ctx.db, id, files.files, ctx.user.id)
  revalidatePath(`/produkty/${id}`)
  revalidatePath('/produkty')
  const dodane = r.dodane.length ? `Dodane zdjęcia: ${r.dodane.length}.` : ''
  if (r.bledy.length) return { ok: false, komunikat: `${dodane} ${r.bledy.map((b) => (b.plik ? `${b.plik}: ${b.komunikat}` : b.komunikat)).join(' ')}`.trim().slice(0, 400) }
  return { ok: true, komunikat: r.dodane.length === 1 ? 'Zdjęcie dodane.' : `Zdjęcia dodane (${r.dodane.length}).` }
}

/** Zakładka „Zdjęcia”: `co` = wgraj | glowne | w-lewo | w-prawo | usun | packshot. */
export async function akcjaZdjec(_prev: StanZdjec, form: FormData): Promise<StanZdjec> {
  const ctx = await requirePermission('produkty.dodawanie')
  const co = String(form.get('co') ?? '')
  if (co === 'wgraj') return wgraj(ctx, form)
  const img = String(form.get('zdjecie') ?? '')
  if (co === 'packshot') {
    const r = await zlecPackshot(ctx.db, img, ctx.user.id)
    if (!r.ok) return { ok: false, komunikat: r.error }
    return { ok: true, komunikat: r.juzJest ? 'Packshot z tego zdjęcia już jest w produkcie.' : 'Packshot zlecony: nowe zdjęcie na białym tle pojawi się tu za kilka minut (odśwież stronę).' }
  }
  const productId =
    co === 'usun' ? await usunZdjecie(ctx.db, img, ctx.user.id) : co === 'glowne' || co === 'w-lewo' || co === 'w-prawo' ? await zmienZdjecie(ctx.db, img, co as ZmianaZdjecia, ctx.user.id) : null
  if (!productId) return { ok: false, komunikat: 'Tego zdjęcia już nie ma w produkcie (odśwież stronę).' }
  revalidatePath(`/produkty/${productId}`)
  revalidatePath('/produkty')
  return { ok: true, komunikat: co === 'usun' ? 'Zdjęcie usunięte z produktu (kopia zostaje w archiwum).' : co === 'glowne' ? 'Ustawione jako główne.' : 'Kolejność zapisana.' }
}

export async function podpowiedzOpisKarty(d: DaneDoOpisu): Promise<{ opis?: string; error?: string }> {
  const ctx = await requirePermission('produkty.dodawanie')
  const r = await podpowiedzOpis(ctx.db, {
    title: String(d?.title ?? '').slice(0, 200),
    sku: d?.sku ? String(d.sku).slice(0, 64) : null,
    ean: d?.ean ? String(d.ean).slice(0, 20) : null,
    rodzaj: d?.rodzaj ? String(d.rodzaj).slice(0, 40) : null,
    opis: d?.opis ? String(d.opis).slice(0, 4000) : null,
  })
  return r.ok ? { opis: r.opis } : { error: r.error }
}
