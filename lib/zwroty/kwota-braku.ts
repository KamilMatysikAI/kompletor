// kwota do zwrotu za brak (lista Braki → „Do zwrotu”) liczona tą samą
// regułą co dokument sprzedaży. Wcześniej lista mnożyła cenę za SZTUKĘ OFERTY przez ilość BAZOWĄ braku: brak 50 g
// z oferty 50 g za 12,50 zł pokazywał 625,00 zł do zwrotu zamiast 12,50 zł.
//
// Kwota = zapłacone za pozycję − to, co zostaje na dokumencie po braku. Brak to ostatnie jednostki części pozycji
// (rodzina zamian: przesunięcie z `przelicznikiPozycji`), więc kwota = `wartoscCzesciGr(brak, przesunięcie + qty − brak)`;
// dokument (`wartoscCzesciGr(qty − brak, przesunięcie)`) + zwrot = wartość części co do grosza (29 g z 50 g za 3,75 zł
// na dokumencie 2,18 zł, zwrot 21 g = 1,57 zł, razem 3,75 zł). Składnik zestawu: kwoty nie da się przypisać bez
// rozbicia ceny zestawu, zostaje „policz ręcznie” (null).
// Runda 2: przelicznik z proporcji zamówienia (`przelicznikiZZamowienia`), nie z aktualnej oferty,
// bo brak z paczki wysłanej może wisieć na liście po zmianie przelicznika oferty.
import type { PrismaClient } from '@prisma/client'
import { wartoscCzesciGr } from '../rdzen/zamiana'
import { type LiniaZamowienia, przelicznikiZZamowienia } from './przelicznik-zamowienia'

export interface BrakDoZwrotu {
  id: string
  orderId: string
  orderLineId: string
  productId: string
  qtyBase: number
}

/** Kwota zwrotu w groszach (czysta funkcja). `naOferte` i `przesuniecie` z `przelicznikiPozycji` dla pozycji braku. */
export function kwotaZwrotuBrakuGr(w: { qtyBase: number; qtyPozycji: number; cenaOfertyGr: number; naOferte: number; przesuniecie: number }): number {
  const brak = Math.max(0, Math.min(w.qtyBase, w.qtyPozycji))
  return wartoscCzesciGr(brak, w.przesuniecie + w.qtyPozycji - brak, w.naOferte, w.cenaOfertyGr)
}

type Linia = LiniaZamowienia & { orderId: string; unitPriceGross: { toString(): string } }

/**
 * Kwoty do zwrotu dla braków (id braku → grosze; null = składnik zestawu albo pozycja nieznana: kwotę liczy biuro).
 * Jeden odczyt pozycji zamówień i ofert dla całej listy; przelicznik i rodzina zamian jak w dokumencie.
 */
export async function kwotyZwrotuBrakow(db: PrismaClient, braki: readonly BrakDoZwrotu[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>()
  if (!braki.length) return out
  const orderIds = [...new Set(braki.map((b) => b.orderId))]
  const [zamowienia, linie] = await Promise.all([
    db.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, channel: true, channelAccountId: true } }),
    db.orderLine.findMany({ where: { orderId: { in: orderIds } }, select: { id: true, orderId: true, externalLineId: true, productId: true, offerId: true, qty: true, qtyChannel: true, qtyRejected: true, removed: true, unitPriceGross: true } }),
  ])
  const poZam = new Map<string, Linia[]>()
  for (const l of linie) poZam.set(l.orderId, [...(poZam.get(l.orderId) ?? []), l])
  // przeliczniki ofert per konto kanału (oferta jest kluczowana kontem, jak w `pozycjeZamowienia`)
  const kluczKonta = (o: { channel: string; channelAccountId: string }) => `${o.channel}:${o.channelAccountId}`
  const ofertyKonta = new Map<string, { channel: (typeof zamowienia)[number]['channel']; channelAccountId: string; ids: Set<string> }>()
  for (const o of zamowienia) {
    const k = kluczKonta(o)
    const e = ofertyKonta.get(k) ?? { channel: o.channel, channelAccountId: o.channelAccountId, ids: new Set<string>() }
    for (const l of poZam.get(o.id) ?? []) if (l.productId && l.offerId) e.ids.add(l.offerId)
    ofertyKonta.set(k, e)
  }
  const przelicznik = new Map<string, number>()
  for (const [k, e] of ofertyKonta) {
    if (!e.ids.size) continue
    const oferty = await db.channelOffer.findMany({ where: { channel: e.channel, channelAccountId: e.channelAccountId, externalId: { in: [...e.ids] } }, select: { externalId: true, qtyBasePerOffer: true } })
    for (const x of oferty) przelicznik.set(`${k}|${x.externalId}`, x.qtyBasePerOffer)
  }
  const prz = new Map(zamowienia.map((o) => [o.id, przelicznikiZZamowienia(poZam.get(o.id) ?? [],(offerId) => przelicznik.get(`${kluczKonta(o)}|${offerId}`))]))
  for (const b of braki) {
    const l = poZam.get(b.orderId)?.find((x) => x.id === b.orderLineId)
    const p = prz.get(b.orderId)
    // składnik zestawu (brak dotyczy innego produktu niż pozycja) albo pozycja nieznana: bez kwoty
    if (!l || !p || l.productId !== b.productId) {
      out.set(b.id, null)
      continue
    }
    out.set(b.id, kwotaZwrotuBrakuGr({ qtyBase: b.qtyBase, qtyPozycji: l.qty, cenaOfertyGr: Math.round(Number(l.unitPriceGross.toString()) * 100), naOferte: p.naOferte.get(l.id) ?? 1, przesuniecie: p.przesuniecie.get(l.id) ?? 0 }))
  }
  return out
}
