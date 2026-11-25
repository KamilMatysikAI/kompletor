'use server'
// Ustawienia → Przewoźnicy → Konta przewoźników: zapis kluczy, ustawień kont i wyłączników nadawania
// jednym zapisem oraz „Sprawdź połączenie” (zadanie w kolejce). Tylko z uprawnieniem `ustawienia`. Komunikaty: tylko
// nasze teksty, nigdy wartości kluczy.
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { requirePermission } from '@/lib/panel/kontekst'
import { kluczPrzewoznika, wylaczoneKonta } from '@/lib/integracje/zdrowie'
import { SecretError } from '@/lib/sekrety'
import { dodajKontoPrzewoznika, kontaPrzewoznikow, KontoPrzewoznikaError, zapiszKontaPrzewoznikow, zlecTestKonta, zlecWlaczenieKontaPrzewoznika, type ZapisKonta } from '@/lib/wysylka/konta'

const registry = defaultRegistry()
const PATH = '/ustawienia/przewoznicy/konta'

export interface StanKont {
  ok?: boolean
  komunikat?: string
}

export async function zapiszKonta(_prev: StanKont, form: FormData): Promise<StanKont> {
  const ctx = await requirePermission('ustawienia')
  const konta = await kontaPrzewoznikow(ctx.db, registry, undefined, { zWysylamZAllegro: true })
  const zmiany: ZapisKonta[] = konta.map((k) => ({
    id: k.id,
    sekrety: Object.fromEntries(k.sekrety.map((s) => [s.name, String(form.get(`k-${k.id}-s-${s.name}`) ?? '')])),
    pola: Object.fromEntries(k.pola.filter((p) => form.has(`k-${k.id}-p-${p.key}`)).map((p) => [p.key, String(form.get(`k-${k.id}-p-${p.key}`) ?? '')])),
    nadawanie: Object.fromEntries(k.reguly.filter((r) => r.nadawanie !== null && form.has(`n-${r.id}-jest`)).map((r) => [r.id, form.get(`n-${r.id}`) === 'tak'])),
  }))
  try {
    const r = await zapiszKontaPrzewoznikow(ctx.db, registry, zmiany, { actorId: ctx.user.id, env: process.env })
    // konto wyłączone po błędach, któremu właśnie wpisano klucze albo zmieniono
    // ustawienia, od razu dostaje „Włącz ponownie” (test połączenia w kolejce); błąd zlecenia nie psuje zapisu
    if (r.klucze || r.reguly || r.konta) {
      try {
        const wyl = await wylaczoneKonta(ctx.db)
        for (const z of zmiany) {
          if (!wyl.has(kluczPrzewoznika(z.id))) continue
          if (Object.values(z.sekrety).some((v) => v.trim()) || Object.keys(z.pola).length) await zlecWlaczenieKontaPrzewoznika(ctx.db, registry, z.id)
        }
      } catch (e) {
        console.warn(`[integracje] przewoźnicy: nie zlecono „Włącz ponownie” po zapisie (${e instanceof Error ? e.name : 'błąd'})`)
      }
    }
    revalidatePath(PATH)
    // ustawienia konta zapisują się przy koncie, także gdy żadna reguła go jeszcze nie używa
    const co = [r.klucze ? `klucze (${r.klucze})` : null, r.konta ? `ustawienia kont (${r.konta})` : null, r.reguly ? `nadawanie (${r.reguly} reguł)` : null].filter(Boolean)
    if (!co.length) return { ok: true, komunikat: 'Nic się nie zmieniło.' }
    return { ok: true, komunikat: `Zapisano: ${co.join(', ')}.` }
  } catch (e) {
    if (e instanceof KontoPrzewoznikaError) return { ok: false, komunikat: e.message }
    if (e instanceof SecretError) return { ok: false, komunikat: 'Nie udało się zaszyfrować klucza: serwer nie ma klucza szyfrowania (administrator).' }
    return { ok: false, komunikat: 'Nie udało się zapisać — spróbuj ponownie' }
  }
}

/** „Dodaj konto” — drugie konto tego samego przewoźnika (np. osobne DPD dla salonów Empik). */
export async function dodajKonto(_prev: StanKont, form: FormData): Promise<StanKont> {
  const ctx = await requirePermission('ustawienia')
  try {
    const k = await dodajKontoPrzewoznika(ctx.db, registry, { konto: String(form.get('konto') ?? ''), nazwa: String(form.get('nazwa') ?? '').slice(0, 80) }, ctx.user.id)
    revalidatePath(PATH)
    revalidatePath('/ustawienia/przewoznicy')
    return { ok: true, komunikat: `Dodano konto „${k.nazwa}”. Wpisz jego klucze w karcie konta i zapisz, a potem wybierz je w regule na ekranie Przewoźnicy.` }
  } catch (e) {
    if (e instanceof KontoPrzewoznikaError) return { ok: false, komunikat: e.message }
    return { ok: false, komunikat: 'Nie udało się dodać konta — spróbuj ponownie' }
  }
}

/** „Włącz ponownie” konta przewoźnika wyłączonego po błędach (test połączenia w kolejce, potem włączenie). */
export async function wlaczPonownieKonto(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  const id = String(form.get('konto') ?? '')
  let q: Record<string, string>
  try {
    q = (await zlecWlaczenieKontaPrzewoznika(ctx.db, registry, id)) ? { test: 'wlaczanie' } : { blad: 'To konto nie jest wyłączone po błędach.' }
  } catch (e) {
    q = { blad: e instanceof KontoPrzewoznikaError ? e.message : 'Nie udało się zlecić — spróbuj ponownie' }
  }
  revalidatePath(PATH)
  redirect(`${PATH}?${new URLSearchParams(q)}`)
}

export async function sprawdzKonto(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  const id = String(form.get('konto') ?? '')
  let q: Record<string, string>
  try {
    q = (await zlecTestKonta(ctx.db, registry, id)) === 'ZLECONO' ? { test: 'zlecono' } : { test: 'za-czesto' }
  } catch (e) {
    q = { blad: e instanceof KontoPrzewoznikaError ? e.message : 'Nie udało się zlecić testu — spróbuj ponownie' }
  }
  revalidatePath(PATH)
  redirect(`${PATH}?${new URLSearchParams(q)}`)
}
