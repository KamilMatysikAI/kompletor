'use server'
// Produkty → Kategorie: dodanie, zmiana nazwy, przeniesienie, kolejność i usunięcie kategorii (z przeniesieniem
// produktów). Uprawnienie `produkty.dodawanie`. Logika, walidacja i historia zmian w lib/produkty/kategorie.ts; wynik jako
// toast z adresu (`?zapisano=` / `?blad=`), jak inne ekrany ustawień.
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requirePermission } from '@/lib/panel/kontekst'
import { dodajKategorie, przeniesKategorie, przesunKategorie, usunKategorie, zmienNazweKategorii, type CelUsuniecia, type Wynik } from '@/lib/produkty/kategorie'

const EKRAN = '/produkty/kategorie'
const str = (form: FormData, k: string) => String(form.get(k) ?? '')

function wynik(r: Wynik<unknown>, klucz: string, kotwica?: string): never {
  revalidatePath(EKRAN)
  revalidatePath('/produkty')
  redirect(`${EKRAN}?${new URLSearchParams(r.ok ? { zapisano: klucz } : { blad: r.error })}${kotwica ? `#${kotwica}` : ''}`)
}

export async function dodajKategorieAkcja(form: FormData): Promise<void> {
  const ctx = await requirePermission('produkty.dodawanie')
  const r = await dodajKategorie(ctx.db, { nazwa: form.get('nazwa'), parentId: str(form, 'rodzic') || null }, ctx.user.id)
  wynik(r, 'dodana', r.ok ? `k-${r.value.id}` : undefined)
}

export async function zmienNazweAkcja(form: FormData): Promise<void> {
  const ctx = await requirePermission('produkty.dodawanie')
  const id = str(form, 'id')
  wynik(await zmienNazweKategorii(ctx.db, id, form.get('nazwa'), ctx.user.id), 'nazwa', `k-${id}`)
}

export async function przeniesAkcja(form: FormData): Promise<void> {
  const ctx = await requirePermission('produkty.dodawanie')
  const id = str(form, 'id')
  wynik(await przeniesKategorie(ctx.db, id, str(form, 'rodzic') || null, ctx.user.id), 'przeniesiona', `k-${id}`)
}

export async function przesunAkcja(form: FormData): Promise<void> {
  const ctx = await requirePermission('produkty.dodawanie')
  const id = str(form, 'id')
  wynik(await przesunKategorie(ctx.db, id, str(form, 'kierunek') === 'gora' ? 'gora' : 'dol'), 'kolejnosc', `k-${id}`)
}

export async function usunAkcja(form: FormData): Promise<void> {
  const ctx = await requirePermission('produkty.dodawanie')
  const v = str(form, 'cel')
  const cel: CelUsuniecia = v === 'rodzic' || v === '' ? { typ: 'rodzic' } : v === 'brak' ? { typ: 'brak' } : { typ: 'kategoria', id: v }
  wynik(await usunKategorie(ctx.db, str(form, 'id'), cel, ctx.user.id), 'usunieta')
}
