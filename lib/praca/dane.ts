// Dane sekcji „Co dalej”: fakty zamówienia do `dostepnePrzejscia` i lista przewoźników z reguł firmy.
// Tylko odczyt, klient bazy firmy z sesji (RLS). Danych klienta tu nie ma: przejścia statusów ich nie potrzebują.
import type { Carrier, Channel, PrismaClient } from '@prisma/client'
import { organizationIdOf } from '@/lib/db'
import { CARRIER_LABEL } from '@/lib/panel/format'
import { flagsOf } from '@/lib/rdzen/rezerwacja'
import { bezPaczki, faktyPrzejscia } from '@/lib/rdzen/przejscia'
import { pozostaloDoZwrotu } from '@/lib/rdzen/zwroty'
import { blokadaPakowaniaFakturaBl, PRZED_SPAKOWANIEM } from '@/lib/rdzen/faktura-bl'
import { dostepnePrzejscia, type FaktyEkranu, type Przycisk, type ZamowienieEkranu } from './przejscia-ekran'
import { kontoZamowienia, pracaDostepna } from './wlacznik'

type Db = PrismaClient

const SELECT = { id: true, status: true, carrier: true, pendingAction: true, paymentState: true, packageNo: true, flags: true, channel: true, channelAccountId: true } as const

export async function wczytajZamowienieEkranu(db: Db, orderId: string) {
  organizationIdOf(db)
  if (!/^[a-z0-9]{1,40}$/i.test(orderId)) return null
  return db.order.findUnique({ where: { id: orderId }, select: SELECT })
}

type Wiersz = NonNullable<Awaited<ReturnType<typeof wczytajZamowienieEkranu>>>

export const zamowienieEkranu = (o: Wiersz): ZamowienieEkranu => ({
  status: o.status,
  carrier: o.carrier,
  pendingAction: o.pendingAction,
  paymentState: o.paymentState,
  kartaNieaktualna: !!flagsOf(o).kartaNieaktualna,
})

export async function faktyEkranu(db: Db, o: Pick<Wiersz, 'id' | 'packageNo'> & { status?: Wiersz['status'] }): Promise<FaktyEkranu> {
  const f = await faktyPrzejscia(db, o)
  const wToku = await db.invoiceAttempt.count({ where: { orderId: o.id, state: { in: ['SENDING', 'UNKNOWN'] } } })
  const wystawione = await db.invoiceAttempt.count({ where: { orderId: o.id, state: 'ISSUED' } })
  // anulowane po wydaniu ze stanu Kompletora — ile jeszcze nie wróciło (przycisk „Przyjmij zwrot na stan”)
  const doZwrotu = o.status === 'ANULOWANE' && f.wydanieWlasne && f.wydane > 0 ? (await pozostaloDoZwrotu(db, o.id)).reduce((s, x) => s + x.qty, 0) : 0
  // blokada pakowania zamówienia z fakturą BL (konto w trybie pracy); tylko przed spakowaniem
  let fakturaBl: string | null = null
  if (!o.status || (PRZED_SPAKOWANIEM as readonly string[]).includes(o.status)) {
    const z = await db.order.findUnique({ where: { id: o.id }, select: { id: true, blOrderId: true, parentOrderId: true, channel: true, channelAccountId: true, flags: true } })
    if (z) fakturaBl = await blokadaPakowaniaFakturaBl(db, z)
  }
  return { ...f, fakturaWToku: f.wFakturze > 0 || wToku > 0, poFakturze: f.wydane > 0 || wystawione > 0, ...(doZwrotu ? { doZwrotu } : {}), ...(fakturaBl ? { fakturaBl } : {}) }
}

/** Przewoźnicy z reguł firmy dla kanału zamówienia (do „Wyjaśnione” z dołożonym towarem); bez BRAK i BEZ_WYSYLKI. */
export async function przewoznicyFirmy(db: Db, channel: Channel): Promise<{ carrier: Carrier; nazwa: string }[]> {
  const rules = await db.carrierRule.findMany({ where: { OR: [{ channel: null }, { channel }] }, orderBy: { priority: 'asc' }, select: { carrier: true } })
  const out = new Map<Carrier, string>()
  for (const r of rules) if (r.carrier !== 'BRAK' && r.carrier !== 'BEZ_WYSYLKI' && !out.has(r.carrier)) out.set(r.carrier, CARRIER_LABEL[r.carrier])
  return [...out].map(([carrier, nazwa]) => ({ carrier, nazwa }))
}

export interface StanCoDalej {
  przyciski: Przycisk[]
  /** Zamówienie bez paczki (sama usługa albo cały towar odrzucony): karta nie sugeruje paczki. */
  bezPaczki: boolean
  przewoznicy: { carrier: Carrier; nazwa: string }[]
  /** Link do stanowiska pakowania, gdy zamówienie jest przed spakowaniem i ma towar. */
  stanowisko: boolean
}

/** null = sekcji nie ma: brak zamówienia, konto w cieniu, wyłącznik instancji wyłączony albo z błędną wartością. */
export async function stanCoDalej(db: Db, orderId: string, uprawnienia: ReadonlySet<string>, env: Record<string, string | undefined> = process.env): Promise<StanCoDalej | null> {
  const o = await wczytajZamowienieEkranu(db, orderId)
  if (!o) return null
  let dostepna: boolean
  try {
    dostepna = pracaDostepna(await kontoZamowienia(db, o, env), env)
  } catch (e) {
    // zła wartość EKRANY_PRACA nie psuje karty zamówienia: sekcji nie ma, a akcja i tak odmawia (wykonaj.ts)
    console.error(`[praca] ${(e as Error).message}`)
    return null
  }
  if (!dostepna) return null
  const f = await faktyEkranu(db, o)
  const przyciski = dostepnePrzejscia(zamowienieEkranu(o), f, uprawnienia)
  return {
    przyciski,
    bezPaczki: bezPaczki(f),
    przewoznicy: przyciski.some((p) => p.wyborPrzewoznika) ? await przewoznicyFirmy(db, o.channel) : [],
    stanowisko: ['DO_REALIZACJI', 'ZBIERANIE', 'ZEBRANE'].includes(o.status) && f.aktywne > 0,
  }
}

/**
 * przyciski „Co dalej” dla konta poza trybem PRACA (podgląd albo wyłącznik instancji). Ta sama lista co
 * w pracy (`dostepnePrzejscia`), każdy przycisk nieaktywny z powodem `powod`; bez uprawnienia do przejść zostaje powód
 * o uprawnieniu. Tylko do pokazania na karcie (zasada fal: funkcja widoczna, nie ukryta): akcja serwera i tak odmawia
 * (wykonaj.ts, bramka trybu). Pakowania z tej listy nie ma (`stanowisko: false`), bo to inny ekran z własną bramką.
 */
export async function stanCoDalejPodglad(db: Db, orderId: string, uprawnienia: ReadonlySet<string>, powod: string): Promise<StanCoDalej | null> {
  const o = await wczytajZamowienieEkranu(db, orderId)
  if (!o) return null
  try {
    const f = await faktyEkranu(db, o)
    const moze = uprawnienia.has('zamowienia.przejscia')
    const przyciski = dostepnePrzejscia(zamowienieEkranu(o), f, uprawnienia).map((p) => ({ ...p, powod: moze ? powod : p.powod }))
    return { przyciski, bezPaczki: bezPaczki(f), przewoznicy: [], stanowisko: false }
  } catch (e) {
    // podgląd przycisków nie może zepsuć karty w trybie „Tylko podgląd”: bez przycisków, karta działa dalej
    console.error(`[praca] podgląd przycisków: ${(e as Error).message}`)
    return null
  }
}
