'use server'
// Produkty → Import i eksport CSV: import pliku. Uprawnienie `produkty.dodawanie`. Plik tylko przez osłonę
// uploadu (CSV_POLICY: tekst UTF-8 do 5 MB, typ po zawartości), logika i walidacja w lib/produkty/csv.ts.
import { revalidatePath } from 'next/cache'
import { CSV_POLICY, readUpload } from '@/lib/files/upload-guard'
import { firmaMaWfirme } from '@/lib/kanaly/firma'
import { requirePermission } from '@/lib/panel/kontekst'
import { importCsv, type WynikImportuCsv } from '@/lib/produkty/csv'

export type StanImportu = { blad: string | null; wynik: WynikImportuCsv | null }

export async function importujCsv(_prev: StanImportu, form: FormData): Promise<StanImportu> {
  const ctx = await requirePermission('produkty.dodawanie')
  const plik = await readUpload(form.get('plik'), CSV_POLICY, { fallbackName: 'produkty' })
  if (!plik) return { blad: 'Wybierz plik CSV.', wynik: null }
  if (!plik.ok) return { blad: plik.message, wynik: null }
  const hasWfirma = await firmaMaWfirme(ctx.db).catch(() => false)
  const r = await importCsv(ctx.db, plik.file.content.toString('utf8'), ctx.user.id, { hasWfirma })
  if ('blad' in r) return { blad: r.blad, wynik: null }
  revalidatePath('/produkty')
  return { blad: null, wynik: r }
}
