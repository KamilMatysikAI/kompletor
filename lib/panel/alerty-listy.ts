// (R9 z przeglądu TwojOMS 08.11): najwyżej trzy alerty nad listą zamówień, każdy z akcją i „Ignoruj”.
// Najpilniejsze sygnały z pulpitu trafiają na ekran, na którym się pracuje: zamówienia po terminie wysyłki, przesyłki bez
// ruchu, braki czekające na decyzję i towar sprzedany ponad stan. „Ignoruj” chowa alert osobie (nie firmie) do czasu, aż
// zmieni się jego liczba: podpis = liczba, więc nowy przypadek wraca. Zapis w `User.ukryteAlerty`
// ({ "<id firmy>": { "<rodzaj>": "<podpis>" } }), tylko przez akcję `ignorujAlert` (app/akcje.ts).
// Część czysta (wybór, zapis JSON) bez bazy: test w alerty-listy.test.ts; `daneAlertow` to cztery liczniki z indeksów.
import type { Prisma, PrismaClient } from '@prisma/client'
import { organizationIdOf } from '../db'
import { BRAK_DO_DECYZJI_OTWARTY } from './dane'
import { warunekPoTerminie } from './termin-wysylki'
import { daneTerminowNaZadanie } from './termin-wysylki-dane'
import { DNI_BEZ_RUCHU, warunekBezRuchu } from './zamowienia-lista'

export const RODZAJE_ALERTOW = ['po_terminie', 'bez_ruchu', 'braki', 'ponad_stan'] as const
export type RodzajAlertu = (typeof RODZAJE_ALERTOW)[number]
export const MAKS_ALERTOW = 3

export interface DaneAlertow {
  /** brak = firma bez harmonogramu odbiorów (alertu nie ma) */
  poTerminie?: number
  bezRuchu: number
  braki: number
  ponadStan: number
}

export interface AlertListy {
  rodzaj: RodzajAlertu
  /** podpis do „Ignoruj” (liczba); zmiana podpisu = alert wraca */
  podpis: string
  ton: 'blad' | 'ostrzezenie'
  tekst: string
  akcja: { href: string; etykieta: string }
}

const odmien = (n: number, jeden: string, kilka: string, wiele: string) => {
  const d = n % 10
  const s = n % 100
  return n === 1 ? jeden : d >= 2 && d <= 4 && (s < 12 || s > 14) ? kilka : wiele
}

/** Alerty w kolejności pilności, bez schowanych przez osobę, najwyżej `MAKS_ALERTOW`. */
/** `pomin`: rodzaj alertu, którego widok jest już na ekranie (np. lista „Po terminie”), nie zajmuje miejsca. */
export function wybierzAlerty(d: DaneAlertow, ukryte: Readonly<Record<string, string>>, pomin?: string): AlertListy[] {
  const all: AlertListy[] = []
  if (d.poTerminie) all.push({ rodzaj: 'po_terminie', podpis: String(d.poTerminie), ton: 'blad', tekst: `${d.poTerminie} ${odmien(d.poTerminie, 'zamówienie czeka', 'zamówienia czekają', 'zamówień czeka')} na wysyłkę po terminie.`, akcja: { href: '/zamowienia?widok=po_terminie', etykieta: 'Pokaż' } })
  if (d.bezRuchu) all.push({ rodzaj: 'bez_ruchu', podpis: String(d.bezRuchu), ton: 'ostrzezenie', tekst: `${d.bezRuchu} ${odmien(d.bezRuchu, 'przesyłka jest', 'przesyłki są', 'przesyłek jest')} w drodze dłużej niż ${DNI_BEZ_RUCHU} dni i nie ma odbioru.`, akcja: { href: '/zamowienia?widok=bez_ruchu', etykieta: 'Pokaż' } })
  if (d.braki) all.push({ rodzaj: 'braki', podpis: String(d.braki), ton: 'ostrzezenie', tekst: `${d.braki} ${odmien(d.braki, 'brak towaru czeka', 'braki towaru czekają', 'braków towaru czeka')} na decyzję.`, akcja: { href: '/braki', etykieta: 'Braki towaru' } })
  if (d.ponadStan) all.push({ rodzaj: 'ponad_stan', podpis: String(d.ponadStan), ton: 'ostrzezenie', tekst: `${d.ponadStan} ${odmien(d.ponadStan, 'produkt sprzedany', 'produkty sprzedane', 'produktów sprzedanych')} ponad stan magazynu.`, akcja: { href: '/braki?lista=stany', etykieta: 'Sprawdź stany' } }) // adres bez nazwy programu do faktur
  return all.filter((a) => ukryte[a.rodzaj] !== a.podpis && a.rodzaj !== pomin).slice(0, MAKS_ALERTOW)
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const PODPIS_RE = /^\d{1,9}$/

/** Schowane alerty osoby w firmie z `User.ukryteAlerty` (śmieci odrzucone). */
export function ukryteAlertyZ(json: unknown, organizationId: string): Record<string, string> {
  const f = obj(obj(json)[organizationId])
  const out: Record<string, string> = {}
  for (const r of RODZAJE_ALERTOW) if (typeof f[r] === 'string' && PODPIS_RE.test(f[r] as string)) out[r] = f[r] as string
  return out
}

/** Nowa wartość `User.ukryteAlerty` po „Ignoruj”; null = złe dane (nic nie zapisujemy). Inne firmy zostają bez zmian. */
export function zIgnorowanym(json: unknown, organizationId: string, rodzaj: string, podpis: string): Prisma.InputJsonObject | null {
  if (!(RODZAJE_ALERTOW as readonly string[]).includes(rodzaj) || !PODPIS_RE.test(podpis) || !/^[\w-]{1,64}$/.test(organizationId)) return null
  const all = obj(json)
  const out: Record<string, Record<string, string>> = {}
  for (const [org, v] of Object.entries(all)) if (/^[\w-]{1,64}$/.test(org)) out[org] = ukryteAlertyZ(all, org)
  out[organizationId] = { ...ukryteAlertyZ(all, organizationId), [rodzaj]: podpis }
  return out
}

/** Cztery liczniki alertów (klient firmy z sesji, RLS). `poTerminie` z licznika menu, gdy już policzony. */
export async function daneAlertow(db: PrismaClient, o: { poTerminie?: number; now?: Date } = {}): Promise<DaneAlertow> {
  organizationIdOf(db)
  const now = o.now ?? new Date()
  const [terminy, bezRuchu, braki, ponadStan] = await Promise.all([
    'poTerminie' in o ? null : daneTerminowNaZadanie(db),
    db.order.count({ where: warunekBezRuchu(now) }),
    db.shortage.count({ where: BRAK_DO_DECYZJI_OTWARTY }),
    db.stock.count({ where: { overcommitListedAt: { not: null } } }),
  ])
  const poTerminie = terminy ? (terminy.harmonogramy.length ? await db.order.count({ where: warunekPoTerminie(terminy.harmonogramy, terminy.przyjazdy, terminy.now, terminy.cien) }) : undefined) : o.poTerminie
  return { poTerminie, bezRuchu, braki, ponadStan }
}
