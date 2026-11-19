// adres działu ustawień (np. /ustawienia/dzial/wysylka, linki z Pomocy) przekierowuje na pierwszą zakładkę
// działu, którą osoba widzi. Nieznany dział albo dział bez widocznej zakładki = 404 (jak ekran bez uprawnienia).
import { notFound, redirect } from 'next/navigation'
import { firmaMaBlWPanelu } from '@/lib/kanaly/firma'
import { requireSession } from '@/lib/panel/kontekst'
import { dzialyUstawien } from '@/lib/panel/nawigacja'

export const metadata = { title: 'Ustawienia' }

export default async function DzialUstawien({ params }: { params: Promise<{ dzial: string }> }) {
  const { dzial } = await params
  const ctx = await requireSession()
  const d = dzialyUstawien({ uprawnienia: ctx.permissions, maBl: await firmaMaBlWPanelu(ctx.db) }).find((x) => x.klucz === dzial)
  if (!d) notFound()
  redirect(d.href)
}
