'use server'
// Produkty → „Zdjęcia z feedu”: zapis adresów feedu produktowego i zlecenie przebiegu (zadanie workera,
// panel nie pobiera feedu sam: limit czasu żądania). Tylko z uprawnieniem `produkty.dodawanie`.
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requirePermission } from '@/lib/panel/kontekst'
import { enqueue } from '@/lib/worker/kolejka'
import { FEED_JOB, FEED_MAX_ADRESOW, feedyFirmy, sprawdzFeedy, zapiszFeedy } from '@/lib/produkty/zdjecia-feed'
import { kontaSklepow } from './konta'

const BASE = '/produkty/zdjecia-z-feedu'

function wroc(q: Record<string, string>): never {
  revalidatePath(BASE)
  redirect(`${BASE}?${new URLSearchParams(q)}`)
}

export async function zapiszAdresy(form: FormData): Promise<void> {
  const ctx = await requirePermission('produkty.dodawanie')
  // wiersze formularza jako lista {url, konto}, bez sklejania tekstu (średnik w adresie)
  const wiersze = Array.from({ length: FEED_MAX_ADRESOW }, (_, i) => ({ url: String(form.get(`url-${i}`) ?? ''), konto: String(form.get(`konto-${i}`) ?? '') }))
  const konta = new Set((await kontaSklepow(ctx.db)).map((k) => k.kod))
  const r = sprawdzFeedy(wiersze, konta)
  if (!r.ok) wroc({ blad: r.error })
  await zapiszFeedy(ctx.db, r.value, ctx.user.id)
  wroc({ zapisano: r.value.length ? 'adresy' : 'pusto' })
}

export async function pobierzTeraz(): Promise<void> {
  const ctx = await requirePermission('produkty.dodawanie')
  if (!(await feedyFirmy(ctx.db)).length) wroc({ blad: 'Najpierw wpisz i zapisz adres feedu.' })
  const id = await enqueue(ctx.db, FEED_JOB, { wymus: true }, { dedupeKey: `panel:${FEED_JOB}`, maxAttempts: 1 })
  wroc({ zapisano: id ? 'zlecone' : 'czeka' })
}
