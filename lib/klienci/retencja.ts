// Retencja danych klienta. Termin `OrderCustomer.retainUntil`:
//  - zamówienie z fakturą: koniec roku wystawienia faktury + `retencjaZFakturaLat` (domyślnie 5);
//  - bez faktury: dostarczenie albo anulowanie + `retencjaBezFakturyMiesiecy` (domyślnie 36; rękojmia, reklamacje);
//  - zamówienie otwarte, otwarty zwrot albo reklamacja: brak terminu (null) — dane zostają, dopóki sprawa trwa.
// Obie wartości domyślne do potwierdzenia przez księgową. Termin liczy zapis rekordu, a przebieg dobowy
// (zadanie workera `klienci-retencja`) przelicza go dla wszystkich wpisów: faktura, zwrot i anulowanie zmieniają termin
// najpóźniej w ciągu doby, bez wpinania się w kod faktur i zwrotów (inne zadania).
// Tryb `RAPORT` (domyślny) tylko liczy wpisy po terminie dla ekranu Ustawienia → Dane klientów. `USUWAJ` (włącza osoba
// z uprawnieniem `ustawienia`) nadpisuje szyfrogram pustym rekordem, zeruje skróty i ustawia `purgedAt`, w partiach,
// z błędem per rekord; jeden wiersz AuditLog `KLIENT_USUNIECIE` na przebieg (same liczby).
import { ETYKIETA_USUNIETA } from './etykieta'
import type { OrderStatus, PrismaClient } from '@prisma/client'
import { organizationIdOf } from '../db'
import type { Env } from '../sekrety'
import { PUSTY_REKORD } from './rekord'
import { kluczeKlientowZEnv, zaszyfrujKlienta } from './szyfr'
import { ustawieniaKlientow, type UstawieniaKlientow } from './ustawienia'

export const RETENCJA_JOB = 'klienci-retencja'
export const USUNIECIE_AUDIT = 'KLIENT_USUNIECIE'

const KONCOWE: ReadonlySet<OrderStatus> = new Set<OrderStatus>(['ODEBRANE', 'ANULOWANE'])
const ZWROT_OTWARTY = ['ZGLOSZONY', 'PRZYJETY', 'KOREKTA'] as const

export interface FaktyRetencji {
  /** Data wystawienia pierwszej faktury zamówienia (wFirma przez Kompletor, BL w cieniu, KSeF z numerem); null = brak. */
  fakturaAt: Date | null
  status: OrderStatus
  /** Chwila dostarczenia albo anulowania (ostatnia zmiana zamówienia w stanie końcowym). */
  koniecAt: Date | null
  otwartySpor: boolean
}

/** Termin retencji z faktów; null = bez terminu (sprawa otwarta). Czysta funkcja. */
export function terminRetencji(f: FaktyRetencji, u: Pick<UstawieniaKlientow, 'retencjaZFakturaLat' | 'retencjaBezFakturyMiesiecy'>): Date | null {
  if (f.otwartySpor) return null
  if (f.fakturaAt) return new Date(Date.UTC(f.fakturaAt.getUTCFullYear() + u.retencjaZFakturaLat + 1, 0, 1)) // od końca roku faktury
  if (!KONCOWE.has(f.status) || !f.koniecAt) return null
  const d = new Date(f.koniecAt)
  d.setUTCMonth(d.getUTCMonth() + u.retencjaBezFakturyMiesiecy)
  return d
}

/** Fakty retencji zamówień (jedno zapytanie na rodzaj, bez danych klientów). */
export async function faktyRetencji(db: PrismaClient, orderIds: readonly string[]): Promise<Map<string, FaktyRetencji>> {
  const ids = [...new Set(orderIds)]
  if (!ids.length) return new Map()
  const [orders, inv, ksef, ret] = await Promise.all([
    db.order.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, updatedAt: true, blOrderId: true } }),
    db.invoiceAttempt.findMany({ where: { orderId: { in: ids }, state: 'ISSUED' }, select: { orderId: true, updatedAt: true } }),
    db.ksefInvoiceDraft.findMany({ where: { orderId: { in: ids }, numer: { not: null } }, select: { orderId: true, updatedAt: true } }),
    db.return.findMany({ where: { orderId: { in: ids }, status: { in: [...ZWROT_OTWARTY] } }, select: { orderId: true } }),
  ])
  const bl = orders.flatMap((o) => (o.blOrderId ? [o.blOrderId] : []))
  const blInv = bl.length ? await db.blInvoiceSnapshot.findMany({ where: { blOrderId: { in: bl } }, select: { blOrderId: true, dateAdd: true } }) : []
  const pierwsza = new Map<string, Date>()
  const dodaj = (id: string, d: Date) => {
    const x = pierwsza.get(id)
    if (!x || d < x) pierwsza.set(id, d)
  }
  for (const i of inv) dodaj(i.orderId, i.updatedAt)
  for (const k of ksef) dodaj(k.orderId, k.updatedAt)
  const poBl = new Map(orders.filter((o) => o.blOrderId).map((o) => [o.blOrderId!, o.id]))
  for (const b of blInv) if (poBl.has(b.blOrderId)) dodaj(poBl.get(b.blOrderId)!, b.dateAdd)
  const spor = new Set(ret.map((r) => r.orderId))
  return new Map(
    orders.map((o) => [
      o.id,
      { fakturaAt: pierwsza.get(o.id) ?? null, status: o.status, koniecAt: KONCOWE.has(o.status) ? o.updatedAt : null, otwartySpor: spor.has(o.id) || o.status === 'REKLAMACJA' },
    ]),
  )
}

/** Termin dla jednego zamówienia (zapis rekordu). */
export async function terminDlaZamowienia(db: PrismaClient, orderId: string, u?: UstawieniaKlientow): Promise<Date | null> {
  const f = (await faktyRetencji(db, [orderId])).get(orderId)
  if (!f) return null
  return terminRetencji(f, u ?? (await ustawieniaKlientow(db)))
}

/** Czy zamówienie ma fakturę, której okres przechowywania trwa (blokada ręcznego usunięcia na żądanie z RODO art. 17). */
export async function fakturaWOkresie(db: PrismaClient, orderId: string, now = new Date()): Promise<{ blokada: boolean; do: Date | null }> {
  const u = await ustawieniaKlientow(db)
  const f = (await faktyRetencji(db, [orderId])).get(orderId)
  if (!f?.fakturaAt) return { blokada: false, do: null }
  const t = terminRetencji({ ...f, otwartySpor: false }, u)!
  return { blokada: t > now, do: t }
}

export interface WynikRetencji {
  tryb: 'RAPORT' | 'USUWAJ'
  przeliczone: number
  poTerminie: number
  usuniete: number
  bledy: number
}

/**
 * Przebieg dobowy dla firmy klienta `db`: przelicza terminy wszystkich nieusuniętych wpisów (partiami), liczy wpisy
 * po terminie i — tylko w trybie USUWAJ — usuwa ich dane. Błąd jednego rekordu nie zatrzymuje przebiegu.
 */
export async function przebiegRetencji(db: PrismaClient, env: Env, opts: { now?: Date; partia?: number; actorId?: string } = {}): Promise<WynikRetencji> {
  const now = opts.now ?? new Date()
  const partia = Math.max(1, Math.min(opts.partia ?? 200, 1000))
  const u = await ustawieniaKlientow(db)
  let przeliczone = 0
  let po: string | undefined
  for (;;) {
    const rows = await db.orderCustomer.findMany({ where: { purgedAt: null, ...(po ? { id: { gt: po } } : {}) }, orderBy: { id: 'asc' }, take: partia, select: { id: true, orderId: true, retainUntil: true } })
    if (!rows.length) break
    po = rows.at(-1)!.id
    const f = await faktyRetencji(db, rows.map((r) => r.orderId))
    for (const r of rows) {
      const fr = f.get(r.orderId)
      const t = fr ? terminRetencji(fr, u) : null
      if ((t?.getTime() ?? null) !== (r.retainUntil?.getTime() ?? null)) {
        await db.orderCustomer.update({ where: { id: r.id }, data: { retainUntil: t } })
        przeliczone++
      }
    }
  }
  const poTerminie = await db.orderCustomer.count({ where: { purgedAt: null, retainUntil: { lt: now } } })
  let usuniete = 0
  let bledy = 0
  if (u.trybRetencji === 'USUWAJ' && poTerminie > 0) {
    const r = await usunDaneKlientow(db, env, { where: { purgedAt: null, retainUntil: { lt: now } }, now, partia })
    usuniete = r.usuniete
    bledy = r.bledy
    if (usuniete || bledy)
      await db.auditLog.create({ data: { entity: USUNIECIE_AUDIT, entityId: 'retencja', actorId: opts.actorId ?? 'system:klienci-retencja', after: { powod: 'RETENCJA', liczba: usuniete, bledy } } })
  }
  const zostalo = poTerminie - usuniete
  const cur = await db.customerDataSettings.findFirst({ select: { organizationId: true } })
  const stat = { ostatniPrzebiegAt: now, ostatniPoTerminie: zostalo, ostatnioUsunieto: usuniete }
  if (cur) await db.customerDataSettings.update({ where: { organizationId: cur.organizationId }, data: stat })
  else await db.customerDataSettings.create({ data: stat })
  return { tryb: u.trybRetencji, przeliczone, poTerminie, usuniete, bledy }
}

/**
 * Usunięcie danych wpisów pasujących do `where`: szyfrogram pustego rekordu (najnowszym kluczem), skróty null,
 * `purgedAt`. Wiersz zostaje (wiemy, że dane były i kiedy je usunięto). Partiami; błąd jednego wpisu = licznik błędów.
 */
export async function usunDaneKlientow(
  db: PrismaClient,
  env: Env,
  o: { where: { purgedAt: null; retainUntil?: { lt: Date }; orderId?: string }; now: Date; partia?: number },
): Promise<{ usuniete: number; bledy: number }> {
  const ring = kluczeKlientowZEnv(env)
  const organizationId = organizationIdOf(db)
  let usuniete = 0
  let bledy = 0
  const pominiete: string[] = []
  for (;;) {
    const rows = await db.orderCustomer.findMany({ where: { ...o.where, ...(pominiete.length ? { id: { notIn: pominiete } } : {}) }, orderBy: { id: 'asc' }, take: o.partia ?? 200, select: { id: true, orderId: true } })
    if (!rows.length) break
    for (const r of rows) {
      try {
        const s = zaszyfrujKlienta(ring, organizationId, r.orderId, PUSTY_REKORD)
        await db.orderCustomer.update({ where: { id: r.id }, data: { ...s, emailHash: null, phoneHash: null, nipHash: null, country: null, purgedAt: o.now } })
        // etykieta przewoźnika ma adres odbiorcy: znika razem z danymi klienta (numer nadania zostaje)
        await db.shipment.updateMany({ where: { orderId: r.orderId, labelCiphertext: { not: null } }, data: { labelCiphertext: null, labelIv: null, labelAuthTag: null, labelKeyVersion: null, labelError: ETYKIETA_USUNIETA } })
        usuniete++
      } catch (e) {
        bledy++
        pominiete.push(r.id)
        console.warn(`[klienci] usunięcie danych nie powiodło się: zamówienie ${r.orderId}, ${e instanceof Error ? e.name : 'nieznany'}`)
      }
    }
  }
  return { usuniete, bledy }
}
