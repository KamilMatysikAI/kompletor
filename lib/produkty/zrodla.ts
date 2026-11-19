// dostawcy danych produktu dla „Dodaj produkt” (przyciski „Pobierz z…”). Każdy dostawca tylko czyta bazę
// (kopie z ostatniego odczytu kanału albo importu BL) — żadnych wywołań API z akcji panelu. wFirma ma osobny przepływ
// (lib/produkty/dodawanie.ts: odczyt jednego towaru w workerze), bo kopii towaru może jeszcze nie być.
//
// Które przyciski widać, zależy od firmy: „Pobierz z wFirmy” tylko z wFirmą, „Pobierz z oferty sklepu” tylko z kontem
// kanału, które ma odczytane oferty, „Pobierz z BaseLinkera” tylko z kopią produktów BL. Błąd dostawcy (np. brak tabeli
// po częściowej migracji) nie blokuje formularza: dostawca jest wtedy niewidoczny, a formularz działa ręcznie.
import type { PrismaClient } from '@prisma/client'
import { firmaMaWfirme } from '../kanaly/firma'
import { normalizeEan } from '../import/normalizacja'
import type { StawkaVat } from './karta'
import { VAT_STAWKI } from './karta'

export interface Zrodla {
  wfirma: boolean
  oferta: boolean
  bl: boolean
}

export async function dostepneZrodla(db: PrismaClient): Promise<Zrodla> {
  const safe = async <T,>(f: () => Promise<T>, d: T) => {
    try {
      return await f()
    } catch {
      return d
    }
  }
  const [wfirma, oferta, bl] = await Promise.all([
    safe(() => firmaMaWfirme(db), false),
    safe(async () => (await db.channelOfferRead.count({ take: 1 })) > 0, false),
    safe(async () => (await db.blProduct.count({ take: 1 })) > 0, false),
  ])
  return { wfirma, oferta, bl }
}

export interface Propozycja {
  typ: 'KANAL' | 'BL'
  /** Identyfikator źródła: id odczytu oferty (ChannelOfferRead) albo id produktu BL. */
  ref: string
  opis: string
  sku: string | null
  title: string | null
  ean: string | null
  priceGross: number | null
  vatRate: StawkaVat | null
  stan: number | null
  imageUrls: string[]
  /** Oferta albo rekord BL jest już powiązany z produktem. */
  productId: string | null
}

const num = (v: { toString(): string } | null | undefined) => (v === null || v === undefined ? null : Number(v.toString()))
const vatOf = (v: string | number | null | undefined): StawkaVat | null => {
  if (v === null || v === undefined) return null
  const s = String(v).replace(/\.0+$/, '').toLowerCase()
  return (VAT_STAWKI as readonly string[]).includes(s) ? (s as StawkaVat) : null
}

/** Szukane: SKU (dokładnie) albo EAN (poprawny). */
function warunek(q: string): { sku?: string; ean?: string } {
  const e = normalizeEan(q)
  return e.valid && e.ean ? { ean: e.ean, sku: q } : { sku: q }
}

/** Oferty sklepów o tym SKU albo EAN (z ostatniego odczytu ofert). */
export async function zOferty(db: PrismaClient, q: string, limit = 10): Promise<Propozycja[]> {
  const w = warunek(q.trim())
  if (!w.sku) return []
  const rows = await db.channelOfferRead.findMany({
    where: { OR: [{ sku: w.sku }, ...(w.ean ? [{ ean: w.ean }] : [])] },
    orderBy: [{ seenAt: 'desc' }],
    take: limit,
  })
  const linked = await db.channelOffer.findMany({
    where: { OR: rows.map((r) => ({ channel: r.channel, channelAccountId: r.channelAccountId, externalId: r.externalId })) },
    select: { channel: true, channelAccountId: true, externalId: true, productId: true },
  })
  const key = (r: { channel: string; channelAccountId: string; externalId: string }) => `${r.channel}/${r.channelAccountId}/${r.externalId}`
  const byKey = new Map(linked.map((l) => [key(l), l.productId]))
  return rows.map((r) => ({
    typ: 'KANAL' as const,
    ref: r.id,
    opis: `oferta ${r.channelAccountId} nr ${r.externalId}`,
    sku: r.sku,
    title: r.name,
    ean: r.ean,
    priceGross: num(r.priceGross),
    vatRate: vatOf(r.vatRate),
    stan: r.qty,
    imageUrls: r.imageUrls ?? [],
    productId: byKey.get(key(r)) ?? null,
  }))
}

/** Jedna oferta z odczytu (po wyborze z listy). */
export async function ofertaPoId(db: PrismaClient, id: string): Promise<Propozycja | null> {
  if (!/^[a-z0-9]{1,40}$/i.test(id)) return null
  const r = await db.channelOfferRead.findUnique({ where: { id } })
  if (!r) return null
  return (await zOferty(db, r.sku ?? r.ean ?? '', 50)).find((p) => p.ref === id) ?? {
    typ: 'KANAL',
    ref: r.id,
    opis: `oferta ${r.channelAccountId} nr ${r.externalId}`,
    sku: r.sku,
    title: r.name,
    ean: r.ean,
    priceGross: num(r.priceGross),
    vatRate: vatOf(r.vatRate),
    stan: r.qty,
    imageUrls: r.imageUrls ?? [],
    productId: null,
  }
}

/** Kopia produktów BaseLinkera (import, przeprowadzka) o tym SKU albo EAN. */
export async function zBl(db: PrismaClient, q: string, limit = 10): Promise<Propozycja[]> {
  const w = warunek(q.trim())
  if (!w.sku) return []
  const rows = await db.blProduct.findMany({ where: { OR: [{ sku: w.sku }, ...(w.ean ? [{ ean: w.ean }] : [])] }, orderBy: { id: 'asc' }, take: limit })
  return rows.map((r) => ({
    typ: 'BL' as const,
    ref: r.id,
    opis: `BaseLinker, produkt ${r.id}${r.isBundle ? ' (zestaw)' : ''}`,
    sku: r.sku,
    title: r.name,
    ean: normalizeEan(r.ean).ean,
    priceGross: num(r.priceGross),
    vatRate: vatOf(num(r.taxRate)),
    stan: num(r.stockBl) === null ? null : Math.max(0, Math.trunc(num(r.stockBl)!)),
    imageUrls: [],
    productId: r.productId,
  }))
}

export async function blPoId(db: PrismaClient, id: string): Promise<Propozycja | null> {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return null
  const r = await db.blProduct.findFirst({ where: { id } })
  if (!r) return null
  return (await zBl(db, r.sku ?? r.ean ?? r.id, 50)).find((p) => p.ref === id) ?? null
}
