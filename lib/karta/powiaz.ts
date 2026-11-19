// „Powiąż z produktem” na karcie zamówienia: pozycja bez produktu (oferta kanału bez powiązania) dostaje
// produkt z katalogu. Ta sama droga co Ustawienia → Kanały sprzedaży → „Do przypisania” (`przypiszOferte`): powstaje
// powiązanie oferty `ChannelOffer` z `mappingSource: MANUAL`, więc kolejne zamówienia z tej oferty przyjdą już
// z produktem, a `remapOrder` dopina produkt i rezerwację we wszystkich czekających zamówieniach konta (także w tym).
// „Do wyjaśnienia” znika, gdy „niezmapowana oferta” była jedynym powodem. Nic nie idzie do kanału, więc akcja działa też
// na koncie w cieniu. Uprawnienie jak przy mapowaniu ofert w panelu: `ustawienia`.
//
// karta jednego zamówienia NIE przepina oferty już powiązanej z innym produktem (zmieniłoby to
// globalne mapowanie dla wszystkich kolejnych zamówień). Oferta aktywna i powiązana z tym samym produktem (pozycja
// została bez produktu, bo zamówienie przyszło przed powiązaniem albo przeliczenie się nie udało) → tylko `remapOrder`
// tego zamówienia, bez ponownego zapisu oferty i audytu, i tylko w statusach, w których przelicza `przeliczZamowienia`.
import type { PrismaClient } from '@prisma/client'
import { KontoError, type KontoRef } from '../kanaly/konta'
import { przypiszOferte, REMAP_STATUSES } from '../kanaly/oferty'
import { remapOrder } from '../rdzen/zamowienia'
import type { WynikKarty } from './pozycje'

const ID_RE = /^[a-z0-9]{1,40}$/i

export interface PowiazWejscie {
  orderId: unknown
  lineId: unknown
  sku: unknown
  sztuk: unknown
  actorId: string
}

/** Istniejące powiązanie oferty pozycji (karta pokazuje je zamiast formularza, `powiazPozycje` odmawia przepięcia). */
export interface PowiazanieOferty {
  productId: string
  sku: string
  active: boolean
  qtyBasePerOffer: number
}

export async function powiazaniaOfert(db: PrismaClient, ref: KontoRef, offerIds: string[]): Promise<Map<string, PowiazanieOferty>> {
  const out = new Map<string, PowiazanieOferty>()
  if (!offerIds.length) return out
  const oferty = await db.channelOffer.findMany({
    where: { channel: ref.channel, channelAccountId: ref.channelAccountId, externalId: { in: offerIds } },
    select: { externalId: true, productId: true, active: true, qtyBasePerOffer: true },
  })
  const produkty = oferty.length ? await db.product.findMany({ where: { id: { in: oferty.map((o) => o.productId) } }, select: { id: true, sku: true } }) : []
  const sku = new Map(produkty.map((p) => [p.id, p.sku]))
  for (const o of oferty) out.set(o.externalId, { productId: o.productId, sku: sku.get(o.productId) ?? o.productId, active: o.active, qtyBasePerOffer: o.qtyBasePerOffer })
  return out
}

export function odmowaInnegoProduktu(offerId: string, sku: string): string {
  return `Oferta ${offerId.slice(0, 60)} jest już powiązana z produktem SKU „${sku.slice(0, 60)}”. Z karty jednego zamówienia nie przepinamy oferty, bo zmieniłoby to wszystkie kolejne zamówienia z niej. Jeśli w tym zamówieniu jest inny towar, usuń pozycję i dodaj produkt z katalogu.`
}

export const ODMOWA_PO_ZBIERANIU =
  'Oferta jest już powiązana z tym produktem, ale zamówienie jest już dalej niż „Do realizacji” (np. po zbieraniu), więc produktu ani rezerwacji nie dopinamy.'

export async function powiazPozycje(db: PrismaClient, w: PowiazWejscie): Promise<WynikKarty> {
  const orderId = String(w.orderId ?? '')
  const lineId = String(w.lineId ?? '')
  if (!ID_RE.test(orderId) || !ID_RE.test(lineId)) return { zmiana: false, blad: 'Nie ma takiej pozycji.' }
  const sku = String(w.sku ?? '').trim()
  if (!sku || sku.length > 100) return { zmiana: false, blad: 'Podaj SKU produktu z katalogu.' }
  const sztukTxt = String(w.sztuk ?? '').trim() || '1'
  const sztuk = /^\d{1,6}$/.test(sztukTxt) ? Number(sztukTxt) : Number.NaN
  if (!Number.isInteger(sztuk) || sztuk < 1) return { zmiana: false, blad: 'Liczba sztuk produktu na jedną ofertę musi być liczbą całkowitą od 1.' }
  const line = await db.orderLine.findFirst({
    where: { id: lineId, orderId },
    select: { productId: true, offerId: true, removed: true, order: { select: { channel: true, channelAccountId: true, status: true } } },
  })
  if (!line) return { zmiana: false, blad: 'Nie ma takiej pozycji.' }
  if (line.productId) return { zmiana: false, blad: 'Pozycja jest już powiązana z produktem.' }
  if (line.removed) return { zmiana: false, blad: 'Pozycja jest usunięta.' }
  if (!line.offerId) return { zmiana: false, blad: 'Kanał nie podał numeru oferty tej pozycji, więc nie ma czego powiązać. Usuń pozycję i dodaj produkt z katalogu.' }
  // SKU jak przy „Utwórz produkt” (bez wielkości liter); kilka trafień różniących się wielkością liter → tylko dokładne
  const trafienia = await db.product.findMany({ where: { sku: { equals: sku, mode: 'insensitive' }, active: true }, select: { id: true, sku: true }, take: 5 })
  const product = trafienia.length === 1 ? trafienia[0] : trafienia.find((p) => p.sku === sku)
  if (!product) {
    if (trafienia.length > 1) return { zmiana: false, blad: `Kilka produktów ma SKU „${sku.slice(0, 60)}” różniące się wielkością liter: wpisz SKU dokładnie.` }
    return { zmiana: false, blad: `Nie ma aktywnego produktu o SKU „${sku.slice(0, 60)}”.` }
  }
  const ref: KontoRef = { channel: line.order.channel, channelAccountId: line.order.channelAccountId }
  const jest = (await powiazaniaOfert(db, ref, [line.offerId])).get(line.offerId)
  if (jest && jest.productId !== product.id) return { zmiana: false, blad: odmowaInnegoProduktu(line.offerId, jest.sku) }
  if (jest?.active) {
    // ta sama oferta już powiązana z tym produktem: przeliczamy tylko to zamówienie, oferta zostaje bez zmian
    if (jest.qtyBasePerOffer !== sztuk)
      return { zmiana: false, blad: `Oferta jest już powiązana z tym produktem po ${jest.qtyBasePerOffer} szt. produktu na sztukę oferty. Z karty nie zmieniamy przelicznika oferty: wpisz ${jest.qtyBasePerOffer}.` }
    if (!REMAP_STATUSES.includes(line.order.status)) return { zmiana: false, blad: ODMOWA_PO_ZBIERANIU }
    const r = await remapOrder(db, orderId)
    return r.mapped > 0
      ? { zmiana: true, blad: null, info: 'powiaz.dopieto' }
      : { zmiana: false, blad: 'Nie udało się dopiąć produktu do tego zamówienia: spróbuj ponownie albo usuń pozycję i dodaj produkt z katalogu.' }
  }
  try {
    const r = await przypiszOferte(db, ref, { externalId: line.offerId, productId: product.id, qtyBasePerOffer: sztuk }, { actorId: w.actorId })
    const po = await db.orderLine.findUnique({ where: { id: lineId }, select: { productId: true } })
    if (!po?.productId) return { zmiana: true, blad: null, info: 'powiaz.bez-przeliczenia' }
    return { zmiana: true, blad: null, ...(r.remapped > 1 ? { info: 'powiaz.przeliczone' as const, n: r.remapped } : { info: 'powiaz.ok' as const }) }
  } catch (e) {
    if (e instanceof KontoError) return { zmiana: false, blad: e.message }
    throw e
  }
}
