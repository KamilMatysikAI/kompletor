'use server'
// Produkty i stany → Dodaj produkt. Formularz produktu działa bez wFirmy i bez BaseLinkera;
// „Pobierz z…” tylko wypełnia pola. „Pobierz z wFirmy” zleca odczyt towaru w workerze (akcja nigdy nie woła wFirmy),
// „Dodaj” z wFirmy zakłada produkt z kopii towaru (lib/produkty/dodawanie.ts, bez zmian). Uprawnienie `produkty.dodawanie`.
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { IMAGE_POLICY, readUploads } from '@/lib/files/upload-guard'
import { firmaMaWfirme } from '@/lib/kanaly/firma'
import { requirePermission } from '@/lib/panel/kontekst'
import { podpowiedzOpis, type DaneDoOpisu } from '@/lib/produkty/ai-opis'
import { addProduct, requestCheck } from '@/lib/produkty/dodawanie'
import { edytujProdukt, zalozProduktReczny, type Rodzaj } from '@/lib/produkty/karta'
import { checkSku } from '@/lib/produkty/walidacja'
import { dodajZFormularza, MAX_ZDJEC } from '@/lib/produkty/zdjecia'
import { blPoId, ofertaPoId } from '@/lib/produkty/zrodla'
import type { StanDodania } from './stan'

export async function sprawdzSku(form: FormData): Promise<void> {
  const ctx = await requirePermission('produkty.dodawanie')
  const sku = checkSku(form.get('sku'))
  if (!sku.ok) redirect(`/produkty/nowy?z=wfirma&blad=sku&sku=${encodeURIComponent(String(form.get('sku') ?? '').slice(0, 80))}`)
  const r = await requestCheck(ctx.db, sku.value)
  redirect(`/produkty/nowy?z=wfirma&sku=${encodeURIComponent(sku.value)}${r === 'pauza' ? '&pauza=1' : ''}`)
}

/** „Pobierz z…”: wFirma zleca odczyt, oferta sklepu i BaseLinker szukają w kopiach (bez API). */
export async function pobierzDane(form: FormData): Promise<void> {
  const ctx = await requirePermission('produkty.dodawanie')
  void ctx
  const z = String(form.get('z') ?? '')
  const q = String(form.get('q') ?? '').trim().slice(0, 64)
  if (z === 'wfirma') {
    const f = new FormData()
    f.set('sku', q)
    return sprawdzSku(f)
  }
  if (z !== 'oferta' && z !== 'bl') redirect('/produkty/nowy')
  redirect(`/produkty/nowy?z=${z}&q=${encodeURIComponent(q)}`)
}

const all = (form: FormData, k: string) => form.getAll(k)

/** Pola własne produktu z formularza (te same nazwy co w karcie produktu). */
function polaFormularza(form: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of ['nazwa', 'ean', 'opis', 'waga', 'dlugosc', 'szerokosc', 'wysokosc', 'prog', 'lokalizacja', 'cena', 'vat', 'cenaZakupu']) if (form.has(k)) out[k] = form.get(k)
  return out
}

async function zdjeciaZFormularza(form: FormData) {
  return readUploads(all(form, 'zdjecia'), IMAGE_POLICY, { maxFiles: MAX_ZDJEC })
}

export async function zapiszNowyProdukt(_prev: StanDodania, form: FormData): Promise<StanDodania> {
  const ctx = await requirePermission('produkty.dodawanie')
  // zdjęcia sprawdzone przed zapisem produktu: zły plik = nic nie powstaje (walidacja wejścia)
  const zdjecia = await zdjeciaZFormularza(form)
  if (!zdjecia.ok) return { error: zdjecia.message, field: 'zdjecia' }
  const zTyp = form.get('zrodloTyp')
  const zRef = String(form.get('zrodloRef') ?? '')
  const zrodlo = zTyp === 'KANAL' ? await ofertaPoId(ctx.db, zRef) : zTyp === 'BL' ? await blPoId(ctx.db, zRef) : null
  const r = await zalozProduktReczny(
    ctx.db,
    {
      rodzaj: String(form.get('rodzaj') ?? '') as Rodzaj,
      sku: form.get('sku'),
      unit: form.get('jednostka') ?? undefined,
      stanPoczatkowy: form.get('stan'),
      form: polaFormularza(form),
      sklad: { ids: all(form, 'skladnik'), ilosci: all(form, 'ilosc'), udzialy: all(form, 'udzial') },
      zrodlo: zrodlo ? { typ: zrodlo.typ, ref: zrodlo.ref } : null,
      zdjeciaZOferty: zrodlo?.typ === 'KANAL' ? zrodlo.imageUrls : [],
    },
    ctx.user.id,
    { hasWfirma: await firmaMaWfirme(ctx.db) },
  )
  if (!r.ok) return { error: r.error, field: (r.field as StanDodania['field']) ?? null, istniejacyId: r.istniejacyId ?? null }
  const bledy: string[] = []
  if (zdjecia.files.length) {
    const w = await dodajZFormularza(ctx.db, r.productId, zdjecia.files, ctx.user.id)
    bledy.push(...w.bledy.map((b) => `${b.plik}: ${b.komunikat}`))
  }
  revalidatePath('/produkty')
  const uwagi = [...r.warnings, ...bledy].join(' ').slice(0, 600)
  redirect(`/produkty/${r.productId}?dodano=1${uwagi ? `&uwagi=${encodeURIComponent(uwagi)}` : ''}`)
}

/** Ścieżka wFirmy: produkt z kopii towaru wFirmy (jak dotąd) i po nim pola własne (waga, wymiary, opis, zdjęcia). */
export async function dodajProdukt(_prev: StanDodania, form: FormData): Promise<StanDodania> {
  const ctx = await requirePermission('produkty.dodawanie')
  const zdjecia = await zdjeciaZFormularza(form)
  if (!zdjecia.ok) return { error: zdjecia.message, field: 'zdjecia' }
  const r = await addProduct(ctx.db, { sku: form.get('sku'), rodzaj: form.get('rodzaj'), title: form.get('nazwa'), ean: form.get('ean') }, ctx.user.id)
  if (!r.ok) return { error: r.error, field: r.field ?? null }
  const uwagi: string[] = [...r.warnings]
  if (r.created) {
    const wlasne = polaFormularza(form)
    delete wlasne['nazwa']
    delete wlasne['ean']
    if (Object.values(wlasne).some((v) => typeof v === 'string' && v.trim())) {
      const e = await edytujProdukt(ctx.db, r.productId, wlasne, ctx.user.id)
      if (!e.ok) uwagi.push(`Produkt dodany, ale ${e.error.charAt(0).toLowerCase()}${e.error.slice(1)} Popraw w karcie produktu.`)
    }
    if (zdjecia.files.length) {
      const w = await dodajZFormularza(ctx.db, r.productId, zdjecia.files, ctx.user.id)
      uwagi.push(...w.bledy.map((b) => `${b.plik}: ${b.komunikat}`))
    }
  }
  revalidatePath('/produkty')
  const u = uwagi.join(' ').slice(0, 600)
  redirect(`/produkty/${r.productId}${r.created ? '?dodano=1' : ''}${u ? `${r.created ? '&' : '?'}uwagi=${encodeURIComponent(u)}` : ''}`)
}

/** „Podpowiedz opis (AI)”: propozycja do pola opisu; zapis robi człowiek. */
export async function podpowiedzOpisu(d: DaneDoOpisu): Promise<{ opis?: string; error?: string }> {
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
