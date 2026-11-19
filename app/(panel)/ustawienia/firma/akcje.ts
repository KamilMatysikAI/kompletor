'use server'
// Ustawienia → Dane firmy: zapis profilu firmy. Tylko z uprawnieniem `ustawienia`; zapis wyłącznie przez
// zapiszProfilFirmy (walidacja + AuditLog) z id zalogowanej osoby.
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { LogoError, usunLogo, wgrajLogo } from '@/lib/firma/logo'
import { ProfilFirmyError } from '@/lib/firma/profil'
import { profilZFormularza, zapiszProfilFirmy } from '@/lib/firma/zapis'
import { requirePermission } from '@/lib/panel/kontekst'

const PATH = '/ustawienia/firma'

export async function zapiszDaneFirmy(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  let blad: string | null = null
  try {
    await zapiszProfilFirmy(ctx.db, profilZFormularza(form), ctx.user.id)
  } catch (e) {
    blad = e instanceof ProfilFirmyError ? e.message : 'Nie udało się zapisać — spróbuj ponownie'
  }
  revalidatePath(PATH)
  redirect(`${PATH}?${new URLSearchParams(blad ? { blad } : { zapisano: '1' })}`)
}

/** wgranie logo (osłona uploadu w `wgrajLogo`). Zły plik = komunikat na ekranie, poprzednie logo zostaje. */
export async function wgrajLogoFirmy(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  let blad: string | null = null
  try {
    await wgrajLogo(ctx.db, form.get('logo'), ctx.user.id)
  } catch (e) {
    blad = e instanceof LogoError ? e.message : 'Nie udało się zapisać logo. Spróbuj ponownie.'
    if (!(e instanceof LogoError)) console.error(`[logo] ${(e as Error).message}`)
  }
  revalidatePath(PATH)
  redirect(`${PATH}?${new URLSearchParams(blad ? { blad } : { zapisano: 'logo' })}`)
}

/** usunięcie logo (pliki do old/, nigdy kasowanie). */
export async function usunLogoFirmy(): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  await usunLogo(ctx.db, ctx.user.id)
  revalidatePath(PATH)
  redirect(`${PATH}?zapisano=logo-usuniete`)
}
