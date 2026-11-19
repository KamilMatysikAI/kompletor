'use server'
// Ustawienia → Druk: stanowiska druku, tokeny, routing, wydruk testowy. Tylko z uprawnieniem ustawień
// firmy; zapis wyłącznie przez lib/druk (klient firmy z sesji, AuditLog bez tokenu). Pełny token i kod instalacyjny
// wracają tylko w stanie formularza po utworzeniu — nie trafiają do bazy, logu ani adresu strony.
import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { requirePermission } from '@/lib/panel/kontekst'
import { wydrukTestowy } from '@/lib/druk/panel'
import { TYPY_ZLECEN } from '@/lib/druk/role'
import { ostrzezenieAdresuSerwera } from '@/lib/druk/adres'
import { adresSerwera, dodajStanowisko, nowyToken, uniewaznijToken, ustawRouting, ustawWylaczenie, zmienNazweStanowiska } from '@/lib/druk/stanowiska'
import { BladDruku } from '@/lib/druk/zlecenia'
import type { StanAkcji, StanTokenu } from './stan-formularzy'

const SCIEZKA = '/ustawienia/druk'
const tekstBledu = (e: unknown): string => {
  if (e instanceof BladDruku) return e.message
  throw e
}

export async function dodaj(_prev: StanAkcji, form: FormData): Promise<StanAkcji> {
  const ctx = await requirePermission('ustawienia')
  try {
    await dodajStanowisko(ctx.db, { code: form.get('kod'), name: form.get('nazwa') }, ctx.user.id)
    revalidatePath(SCIEZKA)
    return { error: null, ok: 'Dodano stanowisko. Teraz utwórz dla niego token i kod instalacyjny.' }
  } catch (e) {
    return { error: tekstBledu(e), ok: null }
  }
}

export async function zmienNazwe(_prev: StanAkcji, form: FormData): Promise<StanAkcji> {
  const ctx = await requirePermission('ustawienia')
  try {
    await zmienNazweStanowiska(ctx.db, form.get('id'), form.get('nazwa'), ctx.user.id)
    revalidatePath(SCIEZKA)
    return { error: null, ok: 'Zapisano nazwę.' }
  } catch (e) {
    return { error: tekstBledu(e), ok: null }
  }
}

export async function wylacz(_prev: StanAkcji, form: FormData): Promise<StanAkcji> {
  const ctx = await requirePermission('ustawienia')
  try {
    const wylaczone = form.get('wylacz') === 'tak'
    await ustawWylaczenie(ctx.db, form.get('id'), wylaczone, ctx.user.id)
    revalidatePath(SCIEZKA)
    return { error: null, ok: wylaczone ? 'Stanowisko wyłączone — agent dostaje odmowę.' : 'Stanowisko włączone.' }
  } catch (e) {
    return { error: tekstBledu(e), ok: null }
  }
}

export async function utworzToken(_prev: StanTokenu, form: FormData): Promise<StanTokenu> {
  const ctx = await requirePermission('ustawienia')
  try {
    const id = form.get('id')
    const serwer = adresSerwera(await headers())
    const t = await nowyToken(ctx.db, id, serwer, ctx.user.id)
    revalidatePath(SCIEZKA)
    return {
      error: null,
      utworzony: { stationId: String(id), stanowisko: t.stanowisko, token: t.token, kod: t.kod, ostrzezenie: ostrzezenieAdresuSerwera(serwer) },
    }
  } catch (e) {
    return { error: tekstBledu(e), utworzony: null }
  }
}

export async function uniewaznij(_prev: StanAkcji, form: FormData): Promise<StanAkcji> {
  const ctx = await requirePermission('ustawienia')
  try {
    await uniewaznijToken(ctx.db, form.get('id'), ctx.user.id)
    revalidatePath(SCIEZKA)
    return { error: null, ok: 'Token unieważniony — agent na tym komputerze dostaje odmowę.' }
  } catch (e) {
    return { error: tekstBledu(e), ok: null }
  }
}

export async function zapiszRouting(_prev: StanAkcji, form: FormData): Promise<StanAkcji> {
  const ctx = await requirePermission('ustawienia')
  try {
    const wpisy = Object.fromEntries(TYPY_ZLECEN.map((t) => [t, form.get(`r-${t}`)]).filter(([, v]) => typeof v === 'string' && v))
    await ustawRouting(ctx.db, form.get('id'), wpisy, ctx.user.id)
    revalidatePath(SCIEZKA)
    return { error: null, ok: 'Zapisano przypisanie drukarek.' }
  } catch (e) {
    return { error: tekstBledu(e), ok: null }
  }
}

export async function testuj(_prev: StanAkcji, form: FormData): Promise<StanAkcji> {
  const ctx = await requirePermission('ustawienia')
  try {
    const s = await wydrukTestowy(ctx.db, String(form.get('id') ?? ''), String(form.get('rola') ?? ''), ctx.user.id)
    revalidatePath(SCIEZKA)
    return { error: null, ok: `Wysłano wydruk testowy na ${s.rola} (${s.stanowisko}). Wynik pojawi się w „Ostatnie zlecenia” po odświeżeniu.` }
  } catch (e) {
    return { error: tekstBledu(e), ok: null }
  }
}
