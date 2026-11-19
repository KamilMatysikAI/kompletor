'use server'
// Akcje zwrotów i reklamacji. Każda zaczyna od requirePermission (sesja + uprawnienie, klient bazy firmy
// z sesji, RLS) i woła rdzeń (lib/rdzen/zwroty.ts), który pilnuje przejść statusów, limitów i historii. Nic nie idzie
// do sklepu ani do kanału; korekta faktury trafia do kolejki programu do faktur tylko wtedy, gdy pozwala na to
// `mozliwoscKorekty` (wFirma, „Wystawiaj faktury z Kompletora”, konto w trybie Aktywny).
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import type { ReturnDisposition, ReturnKind } from '@prisma/client'
import { readUpload } from '@/lib/files/upload-guard'
import { requirePermission } from '@/lib/panel/kontekst'
import { createReturn, rejectReturn, requestCorrection, retryCorrection, ReturnError, receiveReturn, zakonczKorektePozaKompletorem, type ReturnItem } from '@/lib/rdzen/zwroty'
import { kartaZwrotu } from '@/lib/zwroty/karta'
import { POWODY_REKLAMACJI, POWODY_ZWROTU } from '@/lib/zwroty/statusy'
import { przygotujZdjecieZwrotu, zapiszZdjecieZwrotu, ZdjecieZwrotuError, ZDJECIE_ZWROTU_POLICY } from '@/lib/zwroty/zdjecie'

export interface WynikAkcjiZwrotu {
  blad: string | null
}

const ID = /^[a-z0-9]{1,40}$/i
const str = (v: FormDataEntryValue | null, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

function bladZwrotu(e: unknown): string {
  if (e instanceof ReturnError || e instanceof ZdjecieZwrotuError) return e.message
  throw e
}

/** Formularz „Stwórz zwrot”: pozycje z ilościami (`ilosc:<orderLineId>:<productId>`), rodzaj, powód, zdjęcie. */
export async function stworzZwrot(_prev: WynikAkcjiZwrotu, form: FormData): Promise<WynikAkcjiZwrotu> {
  const ctx = await requirePermission('zwroty.przyjecie')
  const orderId = str(form.get('zamowienie'), 40)
  if (!ID.test(orderId)) return { blad: 'Nie ma takiego zamówienia.' }
  const kind: ReturnKind = form.get('typ') === 'reklamacja' ? 'REKLAMACJA' : 'ZWROT'
  const powod = str(form.get('powod'), 40)
  const slownik: Record<string, string> = kind === 'REKLAMACJA' ? POWODY_REKLAMACJI : POWODY_ZWROTU
  if (!(powod in slownik)) return { blad: 'Wybierz powód.' }
  const items: ReturnItem[] = []
  for (const [k, v] of form.entries()) {
    const m = /^ilosc:([a-z0-9]{1,40}):([a-z0-9]{1,40})$/i.exec(k)
    if (!m || typeof v !== 'string' || v.trim() === '') continue
    const qty = Number(v.replace(',', '.'))
    if (!Number.isInteger(qty) || qty < 0) return { blad: 'Ilość musi być liczbą całkowitą, zero albo więcej.' }
    if (qty > 0) items.push({ orderLineId: m[1]!, productId: m[2]!, qty })
  }
  if (!items.length) return { blad: 'Wpisz ilość przy co najmniej jednej pozycji.' }
  // zdjęcie przed zapisem zwrotu: zły plik = odmowa bez zwrotu bez zdjęcia
  let zdjecie: Awaited<ReturnType<typeof przygotujZdjecieZwrotu>> = null
  try {
    zdjecie = await przygotujZdjecieZwrotu(form.get('zdjecie'))
  } catch (e) {
    return { blad: bladZwrotu(e) }
  }
  let id: string
  try {
    id = await createReturn(ctx.db, orderId, items, { kind, reason: powod, note: str(form.get('notatka')) || undefined, actorId: `user:${ctx.user.id}` })
  } catch (e) {
    return { blad: bladZwrotu(e) }
  }
  if (zdjecie) await zapiszZdjecieZwrotu(ctx.db, id, zdjecie)
  revalidatePath('/zwroty')
  revalidatePath(`/zamowienia/${orderId}`)
  redirect(`/zwroty/${id}?zapisano=${kind === 'REKLAMACJA' ? 'reklamacja' : 'zwrot'}`)
}

/** Odbiór paczki: każda pozycja „na stan” albo „uszkodzone” (`d:<returnLineId>`). */
export async function odbierzZwrot(_prev: WynikAkcjiZwrotu, form: FormData): Promise<WynikAkcjiZwrotu> {
  const ctx = await requirePermission('zwroty.przyjecie')
  const id = str(form.get('zwrot'), 40)
  if (!ID.test(id)) return { blad: 'Nie ma takiego zwrotu.' }
  const disp: Record<string, ReturnDisposition> = {}
  for (const [k, v] of form.entries()) {
    const m = /^d:([a-z0-9]{1,40})$/i.exec(k)
    if (!m) continue
    if (v !== 'NA_STAN' && v !== 'USZKODZONE') return { blad: 'Każda pozycja: „na stan” albo „uszkodzone”.' }
    disp[m[1]!] = v
  }
  try {
    await receiveReturn(ctx.db, id, disp, { actorId: `user:${ctx.user.id}` })
  } catch (e) {
    return { blad: bladZwrotu(e) }
  }
  revalidatePath('/zwroty')
  revalidatePath(`/zwroty/${id}`)
  return { blad: null }
}

export async function zlecKorekte(returnId: string): Promise<WynikAkcjiZwrotu> {
  const ctx = await requirePermission('zwroty.korekty')
  const id = String(returnId ?? '')
  if (!ID.test(id)) return { blad: 'Nie ma takiego zwrotu.' }
  const k = await kartaZwrotu(ctx.db, id)
  if (!k) return { blad: 'Nie ma takiego zwrotu.' }
  // ten sam warunek co nieaktywny przycisk: wyłączone wystawianie albo konto w trybie podglądu = bez kolejki
  if (!k.korekta.zlecenie) return { blad: k.korekta.powod ?? 'Korekty nie da się teraz zlecić.' }
  try {
    await requestCorrection(ctx.db, id, { actorId: `user:${ctx.user.id}` })
  } catch (e) {
    return { blad: bladZwrotu(e) }
  }
  revalidatePath(`/zwroty/${id}`)
  revalidatePath('/zwroty')
  return { blad: null }
}

export async function zakonczPozaKompletorem(returnId: string, numer: string): Promise<WynikAkcjiZwrotu> {
  const ctx = await requirePermission('zwroty.korekty')
  const id = String(returnId ?? '')
  if (!ID.test(id)) return { blad: 'Nie ma takiego zwrotu.' }
  try {
    await zakonczKorektePozaKompletorem(ctx.db, id, { numer: String(numer ?? '').slice(0, 60), actorId: `user:${ctx.user.id}` })
  } catch (e) {
    return { blad: bladZwrotu(e) }
  }
  revalidatePath(`/zwroty/${id}`)
  revalidatePath('/zwroty')
  return { blad: null }
}

export async function ponowKorekte(returnId: string, potwierdzone = false): Promise<WynikAkcjiZwrotu> {
  const ctx = await requirePermission('zwroty.korekty')
  const id = String(returnId ?? '')
  if (!ID.test(id)) return { blad: 'Nie ma takiego zwrotu.' }
  // faktura ma już korektę z innego zwrotu = ponowienie znowu by odmówiło (ten sam warunek co nieaktywny przycisk)
  const k = await kartaZwrotu(ctx.db, id)
  if (!k) return { blad: 'Nie ma takiego zwrotu.' }
  if (k.korekta.ponowienie === false) return { blad: k.korekta.powod ?? 'Korekty nie da się teraz ponowić.' }
  try {
    await retryCorrection(ctx.db, id, { actorId: `user:${ctx.user.id}`, potwierdzone: potwierdzone === true })
  } catch (e) {
    return { blad: bladZwrotu(e) }
  }
  revalidatePath(`/zwroty/${id}`)
  return { blad: null }
}

export async function odrzucZwrot(returnId: string, powod: string): Promise<WynikAkcjiZwrotu> {
  const ctx = await requirePermission('zwroty.przyjecie')
  const id = String(returnId ?? '')
  if (!ID.test(id)) return { blad: 'Nie ma takiego zwrotu.' }
  const p = String(powod ?? '').trim().slice(0, 500)
  if (!p) return { blad: 'Wpisz, dlaczego zwrot jest odrzucony.' }
  try {
    await rejectReturn(ctx.db, id, { note: p, actorId: `user:${ctx.user.id}` })
  } catch (e) {
    return { blad: bladZwrotu(e) }
  }
  revalidatePath(`/zwroty/${id}`)
  revalidatePath('/zwroty')
  return { blad: null }
}

/** Zdjęcie dodane później (karta zwrotu). */
export async function dodajZdjecie(_prev: WynikAkcjiZwrotu, form: FormData): Promise<WynikAkcjiZwrotu> {
  const ctx = await requirePermission('zwroty.przyjecie')
  const id = str(form.get('zwrot'), 40)
  if (!ID.test(id)) return { blad: 'Nie ma takiego zwrotu.' }
  if (!(await ctx.db.return.findUnique({ where: { id }, select: { id: true } }))) return { blad: 'Nie ma takiego zwrotu.' }
  // pusty wybór = czytelny komunikat (osłona zwraca null dla pustego pola)
  if (!(await readUpload(form.get('zdjecie'), ZDJECIE_ZWROTU_POLICY))) return { blad: 'Wybierz zdjęcie.' }
  try {
    const z = await przygotujZdjecieZwrotu(form.get('zdjecie'))
    if (z) await zapiszZdjecieZwrotu(ctx.db, id, z)
  } catch (e) {
    return { blad: bladZwrotu(e) }
  }
  revalidatePath(`/zwroty/${id}`)
  return { blad: null }
}
