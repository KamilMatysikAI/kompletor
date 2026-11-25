// Sekcja „Płatność” karty zamówienia: kwota zamówienia, zapłacono, różnica („Do dopłaty” albo „Do zwrotu”)
// i zapis wpłat. Tylko zapis w Kompletorze: bez połączenia z bankiem i bez linków płatności. „Zwrot różnicy” to wpis
// OrderPayment ZWROT bez `exportedAt` — pozycja do eksportu przelewów (port lib/zwroty/eksport-przelewow.ts, plik
// banku to osobne zadanie). Każdy zapis: bramka trybu PRACA, blokada zamówienia, zdarzenie i dziennik (bez danych klienta).
import type { Order, OrderPaymentKind, PaymentState, PrismaClient } from '@prisma/client'
import type { Permission } from '@/lib/auth/uprawnienia'
import { lockOrder } from '@/lib/rdzen/przejscia'
import { cenaZTekstu, grosze } from '@/lib/rdzen/edycja'
import { flagsOf } from '@/lib/rdzen/rezerwacja'
import { runTx } from '@/lib/rdzen/stan'
import { isPaid, markPaid } from '@/lib/rdzen/zamowienia'
import { bramkaKarty } from './bramka'
import { BEZ_UPRAWNIENIA, type WynikKarty } from './pozycje'

type Db = PrismaClient
type Env = Record<string, string | undefined>

/** Wpis dziennika zmian (`AuditLog.entity`) dla płatności zapisanej z karty; `entityId` = id zamówienia. */
export const AUDIT_PLATNOSC = 'ZAMOWIENIE_PLATNOSC'

export const METODY_PLATNOSCI = ['przelew', 'gotówka', 'karta', 'BLIK', 'inna'] as const
export const RODZAJ_LABEL: Record<OrderPaymentKind, string> = { WPLATA: 'wpłata', DOPLATA: 'dopłata', ZWROT: 'zwrot różnicy' }

export interface Rozliczenie {
  zamowienieGr: number
  zaplaconoGr: number
  /** > 0: do dopłaty, < 0: do zwrotu, 0: rozliczone. */
  roznicaGr: number
  /** Różnica ma sens: zamówienie opłacone (poza pobraniem), niedopłata albo są wpisy płatności. */
  pokaz: boolean
  /** Za pobraniem: klient płaci kurierowi przy odbiorze, więc to nie jest wpłata („Do zapłaty przy odbiorze”). */
  pobranie: boolean
}

/**
 * Rozliczenie (czysta funkcja). Podstawa „zapłacono”: kwota sprzed pierwszej edycji z karty (`kwotaZaplacona`), a bez
 * edycji kwota zamówienia, gdy jest opłacone. Pobranie: klient płaci kurierowi kwotę bieżącą, więc różnicy nie ma,
 * a „zapłacono” to tylko zapisane wpisy (pobranie nie jest wpłatą, dopóki kurier nie odda pieniędzy).
 */
export function rozliczenie(o: { totalGross: { toString(): string } | number; paymentState: PaymentState; flags: unknown }, wpisy: { kind: OrderPaymentKind; amount: { toString(): string } | number }[]): Rozliczenie {
  const zamowienieGr = grosze(o.totalGross)
  const ruch = wpisy.reduce((s, w) => s + (w.kind === 'ZWROT' ? -1 : 1) * grosze(w.amount), 0)
  if (o.paymentState === 'COD') return { zamowienieGr, zaplaconoGr: ruch, roznicaGr: 0, pokaz: false, pobranie: true }
  const f = flagsOf({ flags: o.flags as Order['flags'] })
  const podstawa = isPaid(o.paymentState) ? (f.kwotaZaplacona !== undefined ? grosze(f.kwotaZaplacona) : zamowienieGr) : 0
  const zaplaconoGr = podstawa + ruch
  return { zamowienieGr, zaplaconoGr, roznicaGr: zamowienieGr - zaplaconoGr, pokaz: isPaid(o.paymentState) || o.paymentState === 'PARTIAL' || wpisy.length > 0, pobranie: false }
}

/** Data wpłaty z formularza (RRRR-MM-DD), najwyżej rok wstecz i nie z przyszłości; puste = dziś. */
export function dataWplaty(v: unknown, now: Date): Date | null {
  const s = String(v ?? '').trim()
  if (!s) return now
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const d = new Date(`${s}T12:00:00Z`)
  if (Number.isNaN(d.getTime()) || d.getTime() > now.getTime() + 86400_000 || d.getTime() < now.getTime() - 366 * 86400_000) return null
  return d
}

const wczytaj = (db: Db) => (id: string) => db.order.findUnique({ where: { id }, select: { id: true, channel: true, channelAccountId: true } })

export interface ZleceniePlatnosci {
  orderId: unknown
  rodzaj: unknown
  kwota: unknown
  data?: unknown
  metoda?: unknown
  userId: string
  uprawnienia: ReadonlySet<string>
}

const UPRAWNIENIE: Record<'DOPLATA' | 'ZWROT', Permission> = { DOPLATA: 'zamowienia.oznacz_oplacone', ZWROT: 'zwroty.pieniadze' }

/** „Zapisz dopłatę” albo „Zwrot różnicy”: wpis w Kompletorze; zwrot najwyżej do kwoty „Do zwrotu”. */
export async function zapiszPlatnosc(db: Db, z: ZleceniePlatnosci, env: Env = process.env, now = new Date()): Promise<WynikKarty> {
  const rodzaj = z.rodzaj === 'DOPLATA' || z.rodzaj === 'ZWROT' ? z.rodzaj : null
  if (!rodzaj) return { blad: 'Nieznany rodzaj płatności.', zmiana: false }
  if (!z.uprawnienia.has(UPRAWNIENIE[rodzaj])) return { blad: BEZ_UPRAWNIENIA, zmiana: false }
  const b = await bramkaKarty(db, z.orderId, wczytaj(db), env)
  if (!b.ok) return { blad: b.blad, zmiana: false }
  const gr = cenaZTekstu(z.kwota)
  if (gr === null || gr <= 0) return { blad: 'Kwota: liczba większa od zera, najwyżej 2 miejsca po przecinku.', zmiana: false }
  const paidAt = dataWplaty(z.data, now)
  if (!paidAt) return { blad: 'Data: dzień w formacie RRRR-MM-DD, najwyżej rok wstecz i nie z przyszłości.', zmiana: false }
  const metoda = METODY_PLATNOSCI.find((m) => m === z.metoda) ?? null
  if (!metoda) return { blad: 'Wybierz metodę płatności z listy.', zmiana: false }
  const actorId = `user:${z.userId}`
  return runTx(db, async (tx) => {
    const o = await lockOrder(tx, b.o.id)
    const wpisy = await tx.orderPayment.findMany({ where: { orderId: o.id }, select: { kind: true, amount: true } })
    const r = rozliczenie(o, wpisy)
    if (rodzaj === 'ZWROT' && gr > -r.roznicaGr) return { blad: 'Kwota większa niż różnica do zwrotu.', zmiana: false }
    const kwota = (gr / 100).toFixed(2)
    await tx.orderPayment.create({ data: { orderId: o.id, kind: rodzaj, amount: kwota, method: metoda, paidAt, actorId } })
    await tx.orderEvent.create({ data: { orderId: o.id, kind: rodzaj === 'ZWROT' ? 'ZWROT_ROZNICY' : 'DOPLATA_ZAPISANA', actorId, data: { kwota, metoda } } })
    await tx.auditLog.create({ data: { entity: AUDIT_PLATNOSC, entityId: o.id, actorId, after: { rodzaj, kwota, metoda, dzien: paidAt.toISOString().slice(0, 10) } } })
    return { blad: null, zmiana: true }
  })
}

/** „Oznacz jako opłacone” w sekcji „Płatność”: istniejące `markPaid` (rdzeń), uprawnienie `zamowienia.oznacz_oplacone`. */
export async function oznaczOplacone(db: Db, z: { orderId: unknown; userId: string; uprawnienia: ReadonlySet<string> }, env: Env = process.env): Promise<WynikKarty> {
  if (!z.uprawnienia.has('zamowienia.oznacz_oplacone')) return { blad: BEZ_UPRAWNIENIA, zmiana: false }
  const b = await bramkaKarty(db, z.orderId, (id) => db.order.findUnique({ where: { id }, select: { id: true, channel: true, channelAccountId: true, paymentState: true, status: true } }), env)
  if (!b.ok) return { blad: b.blad, zmiana: false }
  if (isPaid(b.o.paymentState)) return { blad: null, zmiana: false } // podwójne kliknięcie
  if (b.o.status === 'ANULOWANE') return { blad: 'Zamówienie anulowane: najpierw je przywróć.', zmiana: false }
  await markPaid(db, b.o.id, 'PAID', { actorId: `user:${z.userId}` })
  return { blad: null, zmiana: true }
}
