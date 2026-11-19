// Jedno rozpoznanie kodu dla stanowiska, Pakowania i listy zamówień: kod karty zamówienia, kod koszyka,
// numer zamówienia i numer nadania → zamówienie firmy. Klient bazy firmy z sesji (RLS): karta, koszyk, zamówienie
// i przesyłka innej firmy są niewidoczne, więc wychodzi „nieznany”, bez zdradzania, że istnieją. Uprawnienia sprawdza
// akcja ekranu (stanowisko i Pakowanie: `pakowanie.stanowisko`, lista zamówień: sesja panelu, jak karta zamówienia).
import type { PrismaClient } from '@prisma/client'
import { organizationIdOf } from '@/lib/db'
import { zawartoscKoszyka } from '@/lib/koszyki/koszyki'
import { accountDisplayName } from '@/lib/panel/format'
import { przedrostekKodu } from './kod'
import { kandydaciKodu, type KandydaciKodu } from './kod-tekst'

type Db = PrismaClient

export type PrzezCo = 'karta' | 'koszyk' | 'numer' | 'przesylka'

export type RozpoznanyKod =
  /**
   * `trafienie` = wartość z bazy, po której otwarto (numer zamówienia, numer nadania, kod karty, nazwa koszyka): do
   * komunikatu „Otwarte po numerze …”, nigdy surowy tekst ze schowka.
   */
  | { typ: 'zamowienie'; orderId: string; przez: PrzezCo; trafienie: string; karta: { printId: string; printNo: number } | null; koszyk: string | null }
  /** Koszyk firmy bez zamówienia albo koszyka o tej nazwie nie ma. */
  | { typ: 'koszyk'; nazwa: string; stan: 'pusty' | 'brak' }
  /** Kilka zamówień pasuje (np. ten sam numer w dwóch sklepach bez przedrostka): bez otwierania. */
  | { typ: 'wiele'; ile: number }
  | { typ: 'nieznany' }

/**
 * Wydruk karty zamówienia z kodu karty (to samo, co skan na stanowisku). Null = to nie kod karty albo wydruku nie ma
 * w tej firmie.
 */
export async function kartaZKodu(db: Db, k: Pick<KandydaciKodu, 'karta'>): Promise<{ id: string; orderId: string; printNo: number } | null> {
  organizationIdOf(db)
  if (!k.karta) return null
  return db.orderCardPrint.findFirst({ where: { orderCode: k.karta.kodZamowienia, printNo: k.karta.numerWydruku }, select: { id: true, orderId: true, printNo: true } })
}

/** Zamówienia o podanych numerach (id z kanału, numer w kanale, numer w BaseLinkerze), z przedrostkiem konta. */
async function poNumerach(db: Db, k: KandydaciKodu): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!k.numery.length) return out
  const numery = [...new Set(k.numery.map((n) => n.numer))]
  const bl = numery.filter((n) => /^\d{1,9}$/.test(n) && Number(n) > 0 && Number(n) <= 2_147_483_647).map(Number)
  const [zam, konta] = await Promise.all([
    db.order.findMany({
      where: { OR: [{ externalId: { in: numery } }, { channelNumber: { in: numery } }, ...(bl.length ? [{ blOrderId: { in: bl } }] : [])] },
      select: { id: true, channel: true, channelAccountId: true, externalId: true, channelNumber: true, blOrderId: true },
      take: 50,
    }),
    k.numery.some((n) => n.przedrostek) ? db.channelConfig.findMany({ select: { channel: true, channelAccountId: true, name: true, config: true } }) : Promise.resolve([]),
  ])
  for (const o of zam) {
    const przedrostek = () => {
      const c = konta.find((x) => x.channel === o.channel && x.channelAccountId === o.channelAccountId)
      return przedrostekKodu(o.channel, accountDisplayName(o.channel, o.channelAccountId, c?.name, c?.config))
    }
    const pasuje = k.numery.find(
      (n) => (o.externalId === n.numer || o.channelNumber === n.numer || (o.blOrderId != null && String(o.blOrderId) === n.numer)) && (!n.przedrostek || n.przedrostek === przedrostek()),
    )
    if (pasuje) out.set(o.id, pasuje.numer)
  }
  return out
}

/** Zamówienia o podanym numerze nadania: dokładne trafienie, a bez niego najdłuższy fragment kodu z etykiety. */
async function poPrzesylkach(db: Db, k: KandydaciKodu): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const wszystkie = [...new Set([...k.przesylki, ...k.fragmentyPrzesylki])]
  if (!wszystkie.length) return out
  const p = await db.shipment.findMany({ where: { trackingNumber: { in: wszystkie, mode: 'insensitive' } }, select: { orderId: true, trackingNumber: true }, take: 100 })
  const dokladne = p.filter((s) => s.trackingNumber && k.przesylki.includes(s.trackingNumber.toUpperCase()))
  const zbior = dokladne.length ? dokladne : p
  const najdluzszy = Math.max(0, ...zbior.map((s) => s.trackingNumber?.length ?? 0))
  for (const s of zbior) if (s.trackingNumber && (s.trackingNumber.length === najdluzszy || dokladne.length)) out.set(s.orderId, s.trackingNumber)
  return out
}

export interface OpcjeRozpoznania {
  /** `kod` = skan albo jedno słowo; `tekst` = dłuższy wklejony tekst (wynik tylko przy jednym zamówieniu). */
  tryb: 'kod' | 'tekst'
  /** Numer zamówienia i numer nadania (lista zamówień, Pakowanie); bez nich tylko karta i koszyk. */
  numery: boolean
  koszyk: boolean
  /** Fragmenty dłuższego kodu z etykiety: tylko dla czytnika (wpisany EAN nie może trafić w cudzy krótszy numer). */
  fragmenty: boolean
}

export async function rozpoznajKod(db: Db, tekst: string, o: OpcjeRozpoznania): Promise<RozpoznanyKod> {
  organizationIdOf(db)
  const k = kandydaciKodu(tekst, o.tryb)
  if (!o.fragmenty) k.fragmentyPrzesylki = []
  const wydruk = await kartaZKodu(db, k)
  if (wydruk && k.karta)
    return { typ: 'zamowienie', orderId: wydruk.orderId, przez: 'karta', trafienie: `${k.karta.kodZamowienia}/${wydruk.printNo}`, karta: { printId: wydruk.id, printNo: wydruk.printNo }, koszyk: null }
  if (k.karta && o.tryb === 'kod') return { typ: 'nieznany' }
  if (k.koszyk && o.koszyk) {
    const kosz = await zawartoscKoszyka(db, k.koszyk)
    if (!kosz) return { typ: 'koszyk', nazwa: k.koszyk, stan: 'brak' }
    if (!kosz.orderId) return { typ: 'koszyk', nazwa: kosz.nazwa, stan: 'pusty' }
    return { typ: 'zamowienie', orderId: kosz.orderId, przez: 'koszyk', trafienie: kosz.nazwa, karta: null, koszyk: kosz.nazwa }
  }
  if (!o.numery) return { typ: 'nieznany' }
  const [numery, przesylki] = await Promise.all([poNumerach(db, k), poPrzesylkach(db, k)])
  const razem = new Set([...numery.keys(), ...przesylki.keys()])
  if (razem.size === 1) {
    const [orderId] = razem as unknown as [string]
    const p = przesylki.get(orderId)
    return p !== undefined
      ? { typ: 'zamowienie', orderId, przez: 'przesylka', trafienie: p, karta: null, koszyk: null }
      : { typ: 'zamowienie', orderId, przez: 'numer', trafienie: numery.get(orderId)!, karta: null, koszyk: null }
  }
  return razem.size > 1 ? { typ: 'wiele', ile: razem.size } : { typ: 'nieznany' }
}
