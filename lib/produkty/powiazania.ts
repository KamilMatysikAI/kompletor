// Powiązania produktu: karta produktu → „Powiązania” i Ustawienia → Kanały sprzedaży → konto → „Łączenie
// ofert”. Odpowiednik „Powiąż z produktami ze sklepu” z BaseLinkera, ale od strony produktu i z podglądem skutku:
//   - lista ofert produktu (konto, stan powiązania, przelicznik, ostatnio wysłany stan, źródło: BL / SKU / ręcznie),
//   - „Powiąż z ofertą”: wyszukiwanie w zapisanej liście ofert z ostatniego „Pobierz oferty” (SKU, nazwa, EAN, numer
//     oferty) i powiązanie jednym klikiem (`przypiszOferte`: MANUAL, przeliczenie zamówień czekających),
//   - „Odłącz” (oferta zostaje nieaktywna i trafia na listę „Do przypisania”; zamówienia już przyjęte bez zmian)
//     i „Przepnij na inny produkt” (oferta na nowy produkt + pozycje zamówień przed zbieraniem przeliczone),
//   - masowe łączenie konta po SKU albo EAN z podglądem i zbiorcze zatwierdzanie propozycji (`needsApproval`),
//   - ręczne wskazanie towaru wFirmy (SKU ≠ kod towaru) z kopii towarów wFirmy (`WfirmaGood`).
// Powiązanie to stan Kompletora: żadna funkcja nie woła kanału ani wFirmy (adaptery czyta wyłącznie worker). Każda
// zmiana ma wpis AuditLog (ChannelOffer albo Product) i historię na karcie produktu. Uprawnienie sprawdza akcja serwera.
import type { Channel, ChannelOffer, MappingSource, OrderStatus, PrismaClient } from '@prisma/client'
import { normalizeEan, unitFromWfirma } from '../import/normalizacja'
import { KontoError, type KontoRef } from '../kanaly/konta'
import { przeliczZamowienia, przypiszOferte, REMAP_STATUSES, type OczekiwanaOferta } from '../kanaly/oferty'
import { flagsOf } from '../rdzen/rezerwacja'
import { BEFORE_PICKING } from '../rdzen/statusy'
import { przepnijPozycjeOferty, type PowodPominiecia } from '../rdzen/zamowienia'

export class PowiazaniaError extends Error {}

const ID_RE = /^[a-z0-9]{1,40}$/i
const OFFER_ID_RE = /^[\x21-\x7e]{1,200}$/
/** Statusy zamówień, które jeszcze nie są zakończone (rezerwacja albo praca magazynu przed nimi). */
const OTWARTE: OrderStatus[] = ['NOWE', 'DO_REALIZACJI', 'DO_WYJASNIENIA', 'ZBIERANIE', 'ZEBRANE', 'SPAKOWANE', 'DO_WYSLANIA', 'DO_ODBIORU']

export const ZRODLO_POWIAZANIA: Record<MappingSource, string> = {
  BL_LINK: 'z BaseLinkera',
  BL_ORDERS: 'z BaseLinkera (zamówienia)',
  SKU: 'po SKU',
  OVERRIDE: 'tabela nadpisań',
  MANUAL: 'ręcznie',
  CONFIG: 'reguła firmy',
  NONE: '—',
}

export type StanPowiazania = 'AKTYWNA' | 'PROPOZYCJA' | 'WYLACZONA_IMPORTEM' | 'ODLACZONA'

export const STAN_POWIAZANIA: Record<StanPowiazania, { etykieta: string; ton: 'sukces' | 'uwaga' | 'neutralny' | 'ostrzezenie' }> = {
  AKTYWNA: { etykieta: 'Powiązana', ton: 'sukces' },
  PROPOZYCJA: { etykieta: 'Propozycja do zatwierdzenia', ton: 'uwaga' },
  WYLACZONA_IMPORTEM: { etykieta: 'Wyłączona przez import', ton: 'ostrzezenie' },
  ODLACZONA: { etykieta: 'Odłączona', ton: 'neutralny' },
}

export function stanPowiazania(o: Pick<ChannelOffer, 'active' | 'needsApproval' | 'deactivatedByImportAt'>): StanPowiazania {
  if (o.active) return 'AKTYWNA'
  if (o.needsApproval) return 'PROPOZYCJA'
  return o.deactivatedByImportAt ? 'WYLACZONA_IMPORTEM' : 'ODLACZONA'
}

const klucz = (channel: string, konto: string, ext: string) => `${channel}|${konto}|${ext}`

// ─── Odczyt do karty produktu ─────────────────────────────────────────────────

export interface SkutekZmiany {
  /** Zamówienia przed zbieraniem z pozycją tej oferty przy tym produkcie (przepięcie je przelicza). */
  przedZbieraniem: number
  /** Zamówienia od zbierania do wysyłki: zostają z tym produktem. */
  wToku: number
  /** Zarezerwowane sztuki produktu (jednostka bazowa) na pozycjach tej oferty w otwartych zamówieniach. */
  zarezerwowane: number
}

export interface WierszPowiazania {
  id: string
  channel: Channel
  channelAccountId: string
  externalId: string
  nazwa: string | null
  sku: string | null
  ean: string | null
  qtyBasePerOffer: number
  lastPushedQty: number | null
  lastPushedAt: Date | null
  lastSeenQty: number | null
  stan: StanPowiazania
  zrodlo: string
  skutek: SkutekZmiany
}

export async function powiazaniaProduktu(db: PrismaClient, productId: string): Promise<WierszPowiazania[]> {
  if (!ID_RE.test(productId)) return []
  const oferty = await db.channelOffer.findMany({ where: { productId }, orderBy: [{ active: 'desc' }, { channel: 'asc' }, { channelAccountId: 'asc' }, { externalId: 'asc' }] })
  if (!oferty.length) return []
  const or = oferty.map((o) => ({ channel: o.channel, channelAccountId: o.channelAccountId, externalId: o.externalId }))
  const [reads, lines] = await Promise.all([
    db.channelOfferRead.findMany({ where: { OR: or }, select: { channel: true, channelAccountId: true, externalId: true, name: true, sku: true, ean: true } }),
    db.orderLine.findMany({
      where: { productId, removed: false, offerId: { in: [...new Set(oferty.map((o) => o.externalId))] }, order: { status: { in: OTWARTE } } },
      select: {
        offerId: true,
        orderId: true,
        order: { select: { channel: true, channelAccountId: true, status: true, statusBeforeClarify: true } },
        reservations: { where: { state: 'ACTIVE' }, select: { qtyBase: true } },
      },
      take: 5000,
    }),
  ])
  const readOf = new Map(reads.map((r) => [klucz(r.channel, r.channelAccountId, r.externalId), r]))
  const skutki = new Map<string, { przed: Set<string>; wToku: Set<string>; rez: number }>()
  for (const l of lines) {
    const k = klucz(l.order.channel, l.order.channelAccountId, l.offerId!)
    const s = skutki.get(k) ?? { przed: new Set<string>(), wToku: new Set<string>(), rez: 0 }
    const etap = l.order.status === 'DO_WYJASNIENIA' ? (l.order.statusBeforeClarify ?? 'NOWE') : l.order.status
    if (REMAP_STATUSES.includes(l.order.status) && (etap === 'NOWE' || etap === 'DO_REALIZACJI')) s.przed.add(l.orderId)
    else s.wToku.add(l.orderId)
    s.rez += l.reservations.reduce((a, r) => a + r.qtyBase, 0)
    skutki.set(k, s)
  }
  return oferty.map((o) => {
    const k = klucz(o.channel, o.channelAccountId, o.externalId)
    const r = readOf.get(k)
    const s = skutki.get(k)
    return {
      id: o.id,
      channel: o.channel,
      channelAccountId: o.channelAccountId,
      externalId: o.externalId,
      nazwa: r?.name ?? null,
      sku: r?.sku ?? null,
      ean: r?.ean ?? null,
      qtyBasePerOffer: o.qtyBasePerOffer,
      lastPushedQty: o.lastPushedQty,
      lastPushedAt: o.lastPushedAt,
      lastSeenQty: o.lastSeenQty,
      stan: stanPowiazania(o),
      zrodlo: ZRODLO_POWIAZANIA[o.mappingSource],
      skutek: { przedZbieraniem: s?.przed.size ?? 0, wToku: s?.wToku.size ?? 0, zarezerwowane: s?.rez ?? 0 },
    }
  })
}

// ─── Wyszukiwanie ofert („Powiąż z ofertą”) ──────────────────────────────────

export interface OfertaDoPowiazania {
  channel: Channel
  channelAccountId: string
  externalId: string
  nazwa: string | null
  sku: string | null
  ean: string | null
  qty: number | null
  /** Obecne powiązanie oferty (dowolny produkt), null = bez powiązania. */
  powiazanie: { productId: string; sku: string; title: string; stan: StanPowiazania } | null
}

/**
 * Oferty z zapisanej listy (ostatnie „Pobierz oferty” każdego konta) po SKU, EAN, numerze oferty albo fragmencie nazwy.
 * Bez odczytu kanału: gdy listy nie ma, ekran proponuje „Pobierz oferty” na koncie (worker, tylko odczyt).
 */
export async function szukajOfert(db: PrismaClient, q: string, opts: { konto?: KontoRef | null; limit?: number } = {}): Promise<OfertaDoPowiazania[]> {
  const t = q.trim().slice(0, 100)
  if (t.length < 2) return []
  const ean = normalizeEan(t)
  const where = {
    ...(opts.konto ? { channel: opts.konto.channel, channelAccountId: opts.konto.channelAccountId } : {}),
    OR: [
      { sku: { equals: t, mode: 'insensitive' as const } },
      { externalId: t },
      ...(ean.valid && ean.ean ? [{ ean: ean.ean }] : []),
      { name: { contains: t, mode: 'insensitive' as const } },
      { sku: { startsWith: t, mode: 'insensitive' as const } },
    ],
  }
  const rows = await db.channelOfferRead.findMany({ where, orderBy: [{ channel: 'asc' }, { channelAccountId: 'asc' }, { externalId: 'asc' }], take: Math.min(opts.limit ?? 30, 100) })
  if (!rows.length) return []
  const linked = await db.channelOffer.findMany({
    where: { OR: rows.map((r) => ({ channel: r.channel, channelAccountId: r.channelAccountId, externalId: r.externalId })) },
    select: { channel: true, channelAccountId: true, externalId: true, productId: true, active: true, needsApproval: true, deactivatedByImportAt: true, product: { select: { sku: true, title: true } } },
  })
  const byKey = new Map(linked.map((l) => [klucz(l.channel, l.channelAccountId, l.externalId), l]))
  // dokładne trafienia (SKU, numer, EAN) przed trafieniami po nazwie
  const dokladne = (r: (typeof rows)[number]) => (r.sku?.toLowerCase() === t.toLowerCase() || r.externalId === t || (!!ean.ean && r.ean === ean.ean) ? 0 : 1)
  return rows
    .sort((a, b) => dokladne(a) - dokladne(b))
    .map((r) => {
      const l = byKey.get(klucz(r.channel, r.channelAccountId, r.externalId))
      return {
        channel: r.channel,
        channelAccountId: r.channelAccountId,
        externalId: r.externalId,
        nazwa: r.name,
        sku: r.sku,
        ean: r.ean,
        qty: r.qty,
        powiazanie: l ? { productId: l.productId, sku: l.product.sku, title: l.product.title, stan: stanPowiazania(l) } : null,
      }
    })
}

/** Czy firma ma jakąkolwiek zapisaną listę ofert (bez niej wyszukiwarka nie ma w czym szukać). */
export async function maListeOfert(db: PrismaClient): Promise<boolean> {
  return (await db.channelOfferRead.count({ take: 1 })) > 0
}

// ─── Zmiany z karty produktu ──────────────────────────────────────────────────

async function produktAktywny(db: PrismaClient, id: unknown): Promise<{ id: string; sku: string; unit: 'SZT' | 'KG'; kind: string }> {
  const pid = String(id ?? '')
  if (!ID_RE.test(pid)) throw new PowiazaniaError('Nie ma takiego produktu.')
  const p = await db.product.findFirst({ where: { id: pid }, select: { id: true, sku: true, unit: true, kind: true, active: true } })
  if (!p) throw new PowiazaniaError('Nie ma takiego produktu.')
  if (!p.active) throw new PowiazaniaError('Produkt jest wyłączony: najpierw go włącz.')
  return p
}

export function sztukZTekstu(v: unknown): number {
  const t = String(v ?? '').trim() || '1'
  const n = /^\d{1,6}$/.test(t) ? Number(t) : Number.NaN
  if (!Number.isInteger(n) || n < 1 || n > 100_000) throw new PowiazaniaError('Przelicznik: liczba całkowita od 1 (ile sztuk produktu sprzedaje jedna sztuka oferty).')
  return n
}

async function wpisProduktu(db: PrismaClient, productId: string, actorId: string, after: Record<string, unknown>): Promise<void> {
  await db.auditLog.create({ data: { entity: 'Product', entityId: productId, actorId, after: after as never } })
}

const opisKonta = (ref: KontoRef, ext: string) => `${ref.channel}/${ref.channelAccountId} nr ${ext}`

export interface WynikPowiazania {
  remapped: number
  info: string
}

/**
 * „Powiąż z ofertą” z karty produktu: oferta konta bez powiązania (albo odłączona, wyłączona, propozycja tego samego
 * produktu) dostaje ten produkt. Oferta aktywnie powiązana z innym produktem = odmowa z drogą „Przepnij” z karty tamtego.
 */
export async function powiazZOferta(db: PrismaClient, w: { productId: unknown; konto: KontoRef; externalId: unknown; sztuk: unknown; actorId: string }): Promise<WynikPowiazania> {
  const p = await produktAktywny(db, w.productId)
  const ext = String(w.externalId ?? '').trim()
  if (!OFFER_ID_RE.test(ext)) throw new PowiazaniaError('Zły numer oferty.')
  const sztuk = sztukZTekstu(w.sztuk)
  const cfg = await db.channelConfig.findFirst({ where: { channel: w.konto.channel, channelAccountId: w.konto.channelAccountId }, select: { name: true } })
  if (!cfg) throw new PowiazaniaError('Nie ma takiego konta kanału.')
  const jest = await db.channelOffer.findFirst({ where: { channel: w.konto.channel, channelAccountId: w.konto.channelAccountId, externalId: ext }, include: { product: { select: { sku: true } } } })
  if (jest && jest.productId !== p.id && jest.active)
    throw new PowiazaniaError(`Oferta ${ext.slice(0, 60)} jest już powiązana z produktem SKU „${jest.product.sku.slice(0, 60)}”. Żeby ją przenieść, otwórz kartę tamtego produktu → Powiązania → „Przepnij na inny produkt”.`)
  if (jest && jest.productId === p.id && jest.active && jest.qtyBasePerOffer === sztuk) return { remapped: 0, info: 'Oferta jest już powiązana z tym produktem.' }
  const zmianaPrzelicznika = !!jest && jest.qtyBasePerOffer !== sztuk
  if (jest && zmianaPrzelicznika) await sprawdzZmianePrzelicznika(db, w.konto, ext, jest.qtyBasePerOffer)
  let r: { remapped: number }
  try {
    r = await przypiszOferte(db, w.konto, { externalId: ext, productId: p.id, qtyBasePerOffer: sztuk }, { actorId: w.actorId, expected: jest ? { productId: jest.productId, active: jest.active, qtyBasePerOffer: jest.qtyBasePerOffer } : null })
  } catch (e) {
    if (e instanceof KontoError) throw new PowiazaniaError(e.message)
    throw e
  }
  await wpisProduktu(db, p.id, w.actorId, { powiazanie: 'dodane', oferta: opisKonta(w.konto, ext), przelicznik: sztuk, ...(jest && jest.productId !== p.id ? { zProduktu: jest.product.sku } : {}) })
  const czesci = [r.remapped > 0 ? `Powiązano. Przeliczone zamówienia czekające na tę ofertę: ${r.remapped}.` : 'Powiązano.']
  if (jest && zmianaPrzelicznika && jest.productId === p.id) {
    // ta sama ścieżka co przepięcie: pozycje przed zbieraniem dostają ilość z nowym przelicznikiem
    const z = await przeliczPozycjeOferty(db, w.konto, ext, { fromProductId: p.id, fromQtyBasePerOffer: jest.qtyBasePerOffer, nowy: p.id, actorId: w.actorId })
    czesci.push(`Przelicznik zmieniony z ${jest.qtyBasePerOffer} na ${sztuk}.`, ...z.czesci)
  }
  return { remapped: r.remapped, info: czesci.join(' ') }
}

/**
 * Zmiana przelicznika oferty (także przy przepięciu z innym przelicznikiem) dopiero wtedy, gdy każde otwarte zamówienie
 * z tą ofertą da się przeliczyć: faktura, karta zamówienia i stan liczą sztuki oferty z obecnego przelicznika, więc
 * zamówienie zbierane, spakowane, zmieniane z karty, bez wysyłki albo z dosłanymi sztukami policzyłoby się źle.
 */
async function sprawdzZmianePrzelicznika(db: PrismaClient, ref: KontoRef, externalId: string, obecny: number): Promise<void> {
  const zamowienia = await db.order.findMany({
    where: { channel: ref.channel, channelAccountId: ref.channelAccountId, status: { in: OTWARTE }, lines: { some: { offerId: externalId, productId: { not: null }, removed: false } } },
    select: { status: true, statusBeforeClarify: true, flags: true, carrier: true, lines: { where: { offerId: externalId, productId: { not: null }, removed: false }, select: { qtyRejected: true, qty: true, qtyChannel: true } } },
    take: 5000,
  })
  const nie = zamowienia.filter((o) => {
    const etap = o.status === 'DO_WYJASNIENIA' ? (o.statusBeforeClarify ?? 'NOWE') : o.status
    return !REMAP_STATUSES.includes(o.status) || !BEFORE_PICKING.includes(etap) || !!flagsOf(o).edytowaneLokalnie || o.carrier === 'BEZ_WYSYLKI' || o.lines.some((l) => l.qtyRejected > 0 || (l.qtyChannel === null && obecny >= 1 && l.qty % obecny !== 0))
  }).length
  if (nie > 0)
    throw new PowiazaniaError(
      `Przelicznika tej oferty (${obecny}) teraz nie zmienisz: ${nie} otwartych zamówień z tą ofertą jest już zbieranych, spakowanych, zmienianych z karty, z dosłanymi sztukami albo z ilością, która nie dzieli się przez przelicznik, a ich faktura liczy sztuki z obecnego przelicznika. Zostaw przelicznik ${obecny} albo poczekaj, aż te zamówienia zostaną wysłane.`,
    )
}

interface WynikPrzeliczeniaPozycji {
  przepiete: number
  pominiete: number
  bledy: number
  reszta: string[]
  czesci: string[]
}

/**
 * Pozycje oferty przy `fromProductId` w otwartych zamówieniach konta: `przepnijPozycjeOferty` dla każdego zamówienia
 * osobno (błąd jednego nie zatrzymuje reszty, idzie do alertów), potem drugi przebieg po świeżej liście (zamówienie
 * przyjęte w trakcie, gdy ingest czytał ofertę przed zapisem, dostaje nowy produkt). Co po drugim przebiegu dalej
 * wskazuje stary produkt i nie zostało pominięte z powodu, trafia do alertu `PRZEPIECIE_OFERTY_RESZTA`. Alert
 * `PRZEPIECIE_OFERTY_W_TOKU` stoi od startu do końca: przerwane przeliczenie (restart, timeout) zostawia ślad.
 */
async function przeliczPozycjeOferty(
  db: PrismaClient,
  ref: KontoRef,
  externalId: string,
  w: { fromProductId: string; fromQtyBasePerOffer: number; nowy: string; actorId: string },
): Promise<WynikPrzeliczeniaPozycji> {
  const lista = async () =>
    (
      await db.order.findMany({
        where: { channel: ref.channel, channelAccountId: ref.channelAccountId, status: { in: OTWARTE }, lines: { some: { offerId: externalId, productId: w.fromProductId, removed: false } } },
        select: { id: true },
        orderBy: { createdAtChannel: 'asc' },
        take: 2000,
      })
    ).map((o) => o.id)
  const dedupeKey = `przepiecie:${ref.channel}:${ref.channelAccountId}:${externalId}`.slice(0, 200)
  const opis = `oferty ${externalId}`
  // alert jednego klucza na ofertę: powtórka po przerwanym przeliczeniu otwiera ten sam wpis, nie dubluje
  const wToku = await db.alert.findFirst({ where: { dedupeKey }, select: { id: true } })
  await (wToku
    ? db.alert.update({ where: { id: wToku.id }, data: { closedAt: null } })
    : db.alert.create({ data: { kind: 'PRZEPIECIE_OFERTY_W_TOKU', ref: externalId.slice(0, 200), dedupeKey, message: `Trwa przeliczanie zamówień ${opis}. Jeśli ten alert nie zniknie, przeliczenie zostało przerwane: sprawdź zamówienia przed zbieraniem z tą ofertą.` } })
  ).catch(() => undefined)
  const out: WynikPrzeliczeniaPozycji = { przepiete: 0, pominiete: 0, bledy: 0, reszta: [], czesci: [] }
  const powody = new Set<string>()
  const pominiete = new Set<string>()
  const bledy = new Set<string>()
  const przebieg = async (ids: string[]) => {
    for (const id of ids) {
      try {
        const r = await przepnijPozycjeOferty(db, id, { offerId: externalId, fromProductId: w.fromProductId, fromQtyBasePerOffer: w.fromQtyBasePerOffer, actorId: w.actorId })
        bledy.delete(id)
        if (r.przepiete > 0) out.przepiete++
        if (r.pominiete.length) {
          pominiete.add(id)
          for (const x of r.pominiete) powody.add(POMINIECIE[x])
        }
      } catch (e) {
        bledy.add(id)
        await db.alert.create({ data: { kind: 'PRZEPIECIE_OFERTY_BLAD', ref: id, message: `Przeliczenie ${opis} w zamówieniu nie powiodło się: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}` } }).catch(() => undefined)
      }
    }
  }
  const pierwsza = await lista()
  await przebieg(pierwsza)
  // drugi przebieg: zamówienia przyjęte w trakcie i te, które przy pierwszym padły
  await przebieg((await lista()).filter((id) => !pominiete.has(id)))
  out.pominiete = pominiete.size
  out.bledy = bledy.size
  // zmiana przelicznika (ten sam produkt): pozycje zostają przy produkcie, więc reszty po produkcie nie ma
  out.reszta = w.nowy === w.fromProductId ? [] : (await lista()).filter((id) => !pominiete.has(id) && !bledy.has(id))
  if (out.reszta.length || out.bledy)
    await db.alert
      .create({
        data: {
          kind: 'PRZEPIECIE_OFERTY_RESZTA',
          ref: externalId.slice(0, 200),
          message: `Po przeliczeniu ${opis} zostały zamówienia przy poprzednim produkcie: ${out.reszta.slice(0, 20).join(', ') || 'zobacz alerty błędów przeliczenia'}${out.bledy ? ` (błędy: ${out.bledy})` : ''}.`.slice(0, 1000),
        },
      })
      .catch(() => undefined)
  await db.alert.updateMany({ where: { dedupeKey, closedAt: null }, data: { closedAt: new Date() } }).catch(() => undefined)
  if (out.przepiete) out.czesci.push(`Przeliczone zamówienia: ${out.przepiete}.`)
  if (out.pominiete) out.czesci.push(`Bez zmian zostało ${out.pominiete} (${[...powody].join(', ')}): sprawdź je na liście zamówień.`)
  const nieudane = out.reszta.length + out.bledy
  if (nieudane) out.czesci.push(`Nie udało się przeliczyć ${nieudane}: są w alertach.`)
  return out
}

async function ofertaProduktu(db: PrismaClient, productId: unknown, offerId: unknown): Promise<ChannelOffer> {
  const pid = String(productId ?? '')
  const oid = String(offerId ?? '')
  if (!ID_RE.test(pid) || !ID_RE.test(oid)) throw new PowiazaniaError('Nie ma takiego powiązania.')
  const o = await db.channelOffer.findFirst({ where: { id: oid, productId: pid } })
  if (!o) throw new PowiazaniaError('Nie ma takiego powiązania (mogło się zmienić w międzyczasie: odśwież kartę).')
  return o
}

const snapshot = (o: ChannelOffer) => ({ productId: o.productId, active: o.active, mappingSource: o.mappingSource, qtyBasePerOffer: o.qtyBasePerOffer, needsApproval: o.needsApproval })

/**
 * „Odłącz”: oferta przestaje być powiązana (nieaktywna, `MANUAL`, więc ani import BL, ani „Pobierz oferty” jej nie
 * włączą) i wraca na listę „Do przypisania” konta. Zamówienia już przyjęte zostają z tym produktem i rezerwacją;
 * kolejne zamówienia z tej oferty przyjdą bez produktu („Do wyjaśnienia”). Stan na tę ofertę przestaje wychodzić.
 */
export async function odlaczOferte(db: PrismaClient, w: { productId: unknown; offerId: unknown; actorId: string }): Promise<{ info: string }> {
  const o = await ofertaProduktu(db, w.productId, w.offerId)
  if (!o.active && !o.needsApproval && !o.deactivatedByImportAt && o.mappingSource === 'MANUAL') return { info: 'Oferta jest już odłączona.' }
  await db.$transaction(async (tx) => {
    const after = await tx.channelOffer.update({ where: { id: o.id }, data: { active: false, needsApproval: false, deactivatedByImportAt: null, mappingSource: 'MANUAL' } })
    await tx.channelOfferRead.updateMany({ where: { channel: o.channel, channelAccountId: o.channelAccountId, externalId: o.externalId }, data: { state: 'BEZ_PRODUKTU', note: 'odłączona w panelu' } })
    await tx.auditLog.create({ data: { entity: 'ChannelOffer', entityId: o.id, actorId: w.actorId, before: snapshot(o), after: { ...snapshot(after), odlaczona: true } } })
    await tx.auditLog.create({ data: { entity: 'Product', entityId: o.productId, actorId: w.actorId, after: { powiazanie: 'odlaczone', oferta: opisKonta(o, o.externalId) } } })
  })
  const lp = o.lastPushedQty
  return { info: `Oferta odłączona. Zamówienia już przyjęte zostają bez zmian.${lp !== null ? ` W sklepie zostaje ostatnio wysłany stan (${lp}): jeśli oferta nie ma sprzedawać, wyłącz ją w sklepie.` : ''}` }
}

export interface WynikPrzepiecia {
  przepiete: number
  pominiete: number
  wToku: number
  info: string
}

const POMINIECIE: Record<PowodPominiecia, string> = {
  ETAP: 'zamówienie jest już zbierane albo dalej',
  EDYTOWANE: 'zamówienie zmieniane z karty',
  BEZ_WYSYLKI: 'zamówienie bez wysyłki',
  FAKTURA: 'zamówienie albo pozycja z fakturą',
  DOSLANE: 'pozycja z dosłanymi albo zamienionymi sztukami',
  PRZELICZNIK: 'ilości nie da się przeliczyć na sztuki oferty',
  PRODUKT: 'produktu nie ma w katalogu',
}

/**
 * „Przepnij na inny produkt”: oferta dostaje produkt wybrany z wyszukiwarki (`cel` = id produktu; jak „Przypisz”,
 * `MANUAL`), zamówienia czekające bez produktu przeliczają się jak w `przypiszOferte`, a pozycje tej oferty przy starym
 * produkcie w zamówieniach przed zbieraniem przechodzą na nowy produkt (`przeliczPozycjeOferty`). Zamówienia dalej
 * w obiegu zostają przy starym produkcie. Inny przelicznik przy okazji: tylko gdy wszystkie otwarte da się przeliczyć.
 */
export async function przepnijOferte(db: PrismaClient, w: { productId: unknown; offerId: unknown; cel: unknown; sztuk: unknown; actorId: string }): Promise<WynikPrzepiecia> {
  const o = await ofertaProduktu(db, w.productId, w.offerId)
  if (!o.active) throw new PowiazaniaError('Oferta nie jest teraz powiązana: użyj „Powiąż ponownie”.')
  const celId = String(w.cel ?? '')
  if (!ID_RE.test(celId)) throw new PowiazaniaError('Wybierz z listy produkt, na który przepinasz ofertę.')
  const nowy = await db.product.findFirst({ where: { id: celId, active: true }, select: { id: true, sku: true, title: true } })
  if (!nowy) throw new PowiazaniaError('Nie ma takiego aktywnego produktu: wyszukaj go jeszcze raz.')
  if (nowy.id === o.productId) throw new PowiazaniaError('To ten sam produkt: wybierz inny albo zmień tylko przelicznik przez „Powiąż z ofertą”.')
  const sztuk = sztukZTekstu(w.sztuk)
  const ref: KontoRef = { channel: o.channel, channelAccountId: o.channelAccountId }
  if (sztuk !== o.qtyBasePerOffer) await sprawdzZmianePrzelicznika(db, ref, o.externalId, o.qtyBasePerOffer)
  const stary = await db.product.findUniqueOrThrow({ where: { id: o.productId }, select: { sku: true } })
  try {
    await przypiszOferte(db, ref, { externalId: o.externalId, productId: nowy.id, qtyBasePerOffer: sztuk }, { actorId: w.actorId, expected: { productId: o.productId, active: true, qtyBasePerOffer: o.qtyBasePerOffer } })
  } catch (e) {
    if (e instanceof KontoError) throw new PowiazaniaError(e.message)
    throw e
  }
  const z = await przeliczPozycjeOferty(db, ref, o.externalId, { fromProductId: o.productId, fromQtyBasePerOffer: o.qtyBasePerOffer, nowy: nowy.id, actorId: w.actorId })
  // pozycje bez produktu (np. przyszły w trakcie) też dostają nowy produkt
  await przeliczZamowienia(db, ref, [o.externalId])
  await wpisProduktu(db, o.productId, w.actorId, { powiazanie: 'przepiete', oferta: opisKonta(ref, o.externalId), naProdukt: nowy.sku })
  await wpisProduktu(db, nowy.id, w.actorId, { powiazanie: 'dodane', oferta: opisKonta(ref, o.externalId), przelicznik: sztuk, zProduktu: stary.sku })
  return { przepiete: z.przepiete, pominiete: z.pominiete, wToku: z.pominiete, info: [`Oferta przepięta na „${nowy.title.slice(0, 80)}” (SKU ${nowy.sku}).`, ...z.czesci].join(' ') }
}

export interface ProduktDoPrzepiecia {
  id: string
  sku: string
  title: string
  unit: 'SZT' | 'KG'
  kind: string
  /** Dostępne (fizycznie minus zarezerwowane) we wszystkich magazynach; null = produkt bez stanu albo zestaw. */
  dostepne: number | null
}

/** Wyszukiwarka produktów do „Przepnij”: aktywne, po SKU (dokładne pierwsze), nazwie albo EAN, bez produktu źródłowego. */
export async function szukajProduktowDoPrzepiecia(db: PrismaClient, q: string, bez: string, limit = 15): Promise<ProduktDoPrzepiecia[]> {
  const t = q.trim().slice(0, 100)
  if (t.length < 2) return []
  const rows = await db.product.findMany({
    where: { active: true, id: { not: bez }, OR: [{ sku: { contains: t, mode: 'insensitive' } }, { title: { contains: t, mode: 'insensitive' } }, { ean: t }] },
    select: { id: true, sku: true, title: true, unit: true, kind: true, stocks: { select: { physical: true, reserved: true } } },
    orderBy: { sku: 'asc' },
    take: Math.min(limit, 50),
  })
  const dokladne = (r: { sku: string }) => (r.sku.toLowerCase() === t.toLowerCase() ? 0 : 1)
  return rows
    .sort((a, b) => dokladne(a) - dokladne(b))
    .map((r) => ({ id: r.id, sku: r.sku, title: r.title, unit: r.unit, kind: r.kind, dostepne: r.kind === 'STOCKED' ? r.stocks.reduce((a, x) => a + Math.max(0, x.physical - x.reserved), 0) : null }))
}

// ─── Masowe łączenie na koncie ────────────────────────────────────────────────

export type LaczPo = 'SKU' | 'EAN'

export interface PozycjaPlanu {
  externalId: string
  nazwa: string | null
  sku: string | null
  ean: string | null
  /** Produkt, z którym połączy (przy kolizji: produkt, do którego oferta jest już przypisana). */
  produkt: { id: string; sku: string; title: string } | null
  powod: string | null
  /**
   * „Do decyzji”: produkty, które pasują do oferty (po SKU, EAN albo SKU bez zer na początku), do wyboru
   * na ekranie konta („Powiąż” przy każdym). Najwyżej {@link LIMIT_KANDYDATOW}; ilu jeszcze pasuje: `kandydatowWiecej`.
   */
  kandydaci?: KandydatPlanu[]
  kandydatowWiecej?: number
  /** Stan zapisanej oferty w chwili planu (zapis warunkowy przy wykonaniu); null = oferty jeszcze nie ma. */
  oczekiwane?: OczekiwanaOferta
}

/** produkt do wyboru przy ofercie „Do decyzji” (jednostka do domyślnego przelicznika: 1 albo 1000 g). */
export interface KandydatPlanu {
  id: string
  sku: string
  title: string
  unit: 'SZT' | 'KG'
}

export const LIMIT_KANDYDATOW = 5

/** Kandydaci do pozycji planu: dokładne trafienia pierwsze, bez powtórzeń, najwyżej {@link LIMIT_KANDYDATOW}. */
function kandydaciZ(...grupy: KandydatPlanu[][]): Pick<PozycjaPlanu, 'kandydaci' | 'kandydatowWiecej'> {
  const widziane = new Set<string>()
  const wszystkie: KandydatPlanu[] = []
  for (const g of grupy)
    for (const p of g)
      if (!widziane.has(p.id)) {
        widziane.add(p.id)
        wszystkie.push({ id: p.id, sku: p.sku, title: p.title, unit: p.unit })
      }
  return { kandydaci: wszystkie.slice(0, LIMIT_KANDYDATOW), kandydatowWiecej: Math.max(0, wszystkie.length - LIMIT_KANDYDATOW) }
}

export interface PlanLaczenia {
  po: LaczPo
  /** Oferty z listy, które nie mają aktywnego powiązania. */
  sprawdzone: number
  polaczy: PozycjaPlanu[]
  koliduje: PozycjaPlanu[]
  decyzja: PozycjaPlanu[]
  bezTrafienia: number
  /** oferty bez pasującego produktu z powodem (pierwsze {@link LIMIT_PLANU}; liczba w `bezTrafienia`). */
  bezPary: PozycjaPlanu[]
  /** pasują do produktu, który już czeka na nie w „Propozycjach do zatwierdzenia” (nie powtarzamy ich w „Połączy”). */
  wPropozycjach: number
}

/** Zera na początku SKU („01505” i „1505”); pusty wynik = SKU z samych zer (nie porównujemy). */
const bezZerWiodacych = (s: string) => s.replace(/^0+/, '').toLowerCase()

const LIMIT_PLANU = 2000

/**
 * Podgląd „Połącz po SKU / po EAN” (nic nie zapisuje): oferty konta z ostatniego pobrania bez aktywnego powiązania.
 * Połączy: dokładnie jeden aktywny produkt o tym SKU (wielkość liter ma znaczenie, jak przy pobieraniu ofert) albo
 * EAN, a oferta nie ma zapisanego innego produktu. Koliduje: oferta ma już zapisany inny produkt (odłączona, wyłączona
 * albo propozycja). Do decyzji: kilka produktów pasuje, SKU różni się tylko wielkością liter albo ta sama wartość jest
 * na kilku ofertach konta bez powiązania (który towar to który, rozstrzyga człowiek: „Powiąż” przy kandydacie na ekranie
 * konta albo „Powiąż z ofertą” na karcie). Każda pozycja „Do decyzji” niesie pasujące produkty (`kandydaci`).
 * Do decyzji także SKU różniące się od produktu tylko zerami na początku (z proponowanym produktem); oferta,
 * której pasujący produkt czeka już w „Propozycjach do zatwierdzenia”, nie wraca w „Połączy” (`wPropozycjach`); oferty
 * bez pasującego produktu idą na listę `bezPary` z powodem (brak SKU i EAN, brak produktu o tym SKU albo EAN).
 */
export async function planLaczenia(db: PrismaClient, ref: KontoRef, po: LaczPo): Promise<PlanLaczenia> {
  const [reads, offers] = await Promise.all([
    db.channelOfferRead.findMany({ where: { channel: ref.channel, channelAccountId: ref.channelAccountId }, orderBy: { externalId: 'asc' }, take: 20_000 }),
    db.channelOffer.findMany({ where: { channel: ref.channel, channelAccountId: ref.channelAccountId }, select: { externalId: true, productId: true, active: true, needsApproval: true, qtyBasePerOffer: true, product: { select: { id: true, sku: true, title: true } } } }),
  ])
  const ofOffer = new Map(offers.map((o) => [o.externalId, o]))
  const wolne = reads.filter((r) => !ofOffer.get(r.externalId)?.active)
  const wartosc = (r: (typeof reads)[number]) => (po === 'SKU' ? r.sku?.trim() || null : r.ean ?? null)
  const sku = (r: (typeof reads)[number]) => r.sku?.trim() || null
  // powtórzenie liczymy wśród ofert bez powiązania: druga oferta tego samego towaru, już powiązana, nie przeszkadza
  const ile = new Map<string, number>()
  for (const r of wolne) {
    const v = wartosc(r)
    if (v) ile.set(v, (ile.get(v) ?? 0) + 1)
  }
  const values = [...new Set(wolne.map(wartosc).filter((v): v is string => !!v))]
  // partiami po 1000 wartości: SKU bez wielkości liter (`in` + insensitive), EAN dokładnie
  const produkty: { id: string; sku: string; title: string; ean: string | null; unit: 'SZT' | 'KG' }[] = []
  for (let i = 0; i < values.length; i += 1000) {
    const czesc = values.slice(i, i + 1000)
    produkty.push(
      ...(await db.product.findMany({ where: { active: true, ...(po === 'SKU' ? { sku: { in: czesc, mode: 'insensitive' as const } } : { ean: { in: czesc } }) }, select: { id: true, sku: true, title: true, ean: true, unit: true } })),
    )
  }
  // SKU bez trafienia, które różni się od produktu tylko zerami na początku („1505” i „01505”): do decyzji,
  // automat sam nie łączy. Warianty z 0–4 zerami, partiami jak wyżej.
  const zZerami: { id: string; sku: string; title: string; unit: 'SZT' | 'KG' }[] = []
  if (po === 'SKU') {
    const trafione = new Set(produkty.map((p) => p.sku.toLowerCase()))
    const warianty = [
      ...new Set(
        values
          .filter((v) => !trafione.has(v.toLowerCase()) && bezZerWiodacych(v))
          .flatMap((v) => {
            const s = v.replace(/^0+/, '')
            return [s, `0${s}`, `00${s}`, `000${s}`, `0000${s}`].filter((x) => x.toLowerCase() !== v.toLowerCase())
          }),
      ),
    ]
    for (let i = 0; i < warianty.length; i += 1000)
      zZerami.push(...(await db.product.findMany({ where: { active: true, sku: { in: warianty.slice(i, i + 1000), mode: 'insensitive' as const } }, select: { id: true, sku: true, title: true, unit: true } })))
  }
  const plan: PlanLaczenia = { po, sprawdzone: wolne.length, polaczy: [], koliduje: [], decyzja: [], bezTrafienia: 0, bezPary: [], wPropozycjach: 0 }
  const dodaj = (lista: PozycjaPlanu[], x: PozycjaPlanu) => {
    if (lista.length < LIMIT_PLANU) lista.push(x)
  }
  for (const r of wolne) {
    const v = wartosc(r)
    const base = { externalId: r.externalId, nazwa: r.name, sku: r.sku, ean: r.ean }
    const bezPary = (powod: string) => {
      plan.bezTrafienia++
      dodaj(plan.bezPary, { ...base, produkt: null, powod })
    }
    if (!v) {
      // brak wartości, po której łączy ten podgląd: powód mówi, czego brakuje i czy pomoże drugi podgląd
      if (!sku(r) && !r.ean) bezPary('oferta bez SKU (sygnatury) i bez EAN w kanale: przypisz ją ręcznie')
      else if (po === 'SKU') bezPary(`oferta bez SKU (sygnatury); ma EAN ${r.ean}: sprawdź „Podgląd: po EAN”`)
      else bezPary(`oferta bez EAN; ma SKU „${sku(r)}”: sprawdź „Podgląd: po SKU”`)
      continue
    }
    const hits = po === 'SKU' ? produkty.filter((p) => p.sku.toLowerCase() === v.toLowerCase()) : produkty.filter((p) => p.ean === v)
    const exact = po === 'SKU' ? hits.filter((p) => p.sku === v) : hits
    const zapisany = ofOffer.get(r.externalId)
    if (!hits.length) {
      const zera = po === 'SKU' && bezZerWiodacych(v) ? zZerami.filter((p) => bezZerWiodacych(p.sku) === bezZerWiodacych(v)) : []
      if (zera.length === 1) {
        const z = zera[0]!
        dodaj(plan.decyzja, { ...base, produkt: { id: z.id, sku: z.sku, title: z.title }, powod: `SKU oferty „${v}” różni się od SKU produktu „${z.sku}” tylko zerami na początku: jeśli to ten towar, powiąż go`, ...kandydaciZ(zera) })
        continue
      }
      if (zera.length > 1) {
        dodaj(plan.decyzja, { ...base, produkt: null, powod: `SKU oferty „${v}” różni się tylko zerami na początku od kilku produktów (${zera.slice(0, 3).map((p) => `„${p.sku}”`).join(', ')})`, ...kandydaciZ(zera) })
        continue
      }
      bezPary(po === 'SKU' ? `jest SKU „${v}”, nie ma aktywnego produktu o tym SKU` : `jest EAN ${v}, nie ma aktywnego produktu o tym EAN`)
      continue
    }
    if ((ile.get(v) ?? 0) > 1) {
      dodaj(plan.decyzja, { ...base, produkt: null, powod: `${po === 'SKU' ? 'SKU' : 'EAN'} „${v}” ma kilka ofert tego konta`, ...kandydaciZ(exact, hits) })
      continue
    }
    if (exact.length !== 1) {
      dodaj(plan.decyzja, { ...base, produkt: null, powod: exact.length > 1 ? `kilka produktów ma ${po === 'SKU' ? 'to SKU' : 'ten EAN'}` : 'SKU różni się od produktu tylko wielkością liter', ...kandydaciZ(exact, hits) })
      continue
    }
    const cel = exact[0]!
    if (zapisany && zapisany.productId !== cel.id) {
      dodaj(plan.koliduje, { ...base, produkt: zapisany.product, powod: `oferta ma zapisany inny produkt (SKU „${zapisany.product.sku}”); pasuje SKU „${cel.sku}”` })
      continue
    }
    // ten sam produkt czeka już w „Propozycjach do zatwierdzenia”: nie powtarzamy go w „Połączy”
    if (zapisany && zapisany.needsApproval && !zapisany.active) {
      plan.wPropozycjach++
      continue
    }
    dodaj(plan.polaczy, { ...base, produkt: { id: cel.id, sku: cel.sku, title: cel.title }, powod: null, oczekiwane: zapisany ? { productId: zapisany.productId, active: zapisany.active, qtyBasePerOffer: zapisany.qtyBasePerOffer } : null })
  }
  return plan
}

export interface WynikLaczenia {
  polaczone: number
  pominiete: number
  bledy: number
  remapped: number
}

/**
 * Wykonanie planu: tylko oferty, które w ŚWIEŻYM planie są na liście „połączy” (zmiana między podglądem a kliknięciem
 * = pominięta), i tylko z wybranych w podglądzie. Każda oferta osobno (`przypiszOferte`, przelicznik 1 albo 1000 g dla
 * towaru na wagę), błąd jednej nie zatrzymuje reszty.
 */
export async function polaczMasowo(db: PrismaClient, ref: KontoRef, po: LaczPo, wybrane: string[], actorId: string): Promise<WynikLaczenia> {
  const chce = new Set(wybrane.filter((x) => OFFER_ID_RE.test(x)).slice(0, LIMIT_PLANU))
  const plan = await planLaczenia(db, ref, po)
  const w: WynikLaczenia = { polaczone: 0, pominiete: 0, bledy: 0, remapped: 0 }
  const doZrobienia = plan.polaczy.filter((x) => chce.has(x.externalId))
  w.pominiete = chce.size - doZrobienia.length
  const jednostki = new Map((await db.product.findMany({ where: { id: { in: doZrobienia.map((x) => x.produkt!.id) } }, select: { id: true, unit: true } })).map((p) => [p.id, p.unit]))
  for (const x of doZrobienia) {
    try {
      const r = await przypiszOferte(db, ref, { externalId: x.externalId, productId: x.produkt!.id, qtyBasePerOffer: jednostki.get(x.produkt!.id) === 'KG' ? 1000 : 1 }, { actorId, expected: x.oczekiwane ?? null })
      await wpisProduktu(db, x.produkt!.id, actorId, { powiazanie: 'dodane', oferta: opisKonta(ref, x.externalId), masowo: po })
      w.polaczone++
      w.remapped += r.remapped
    } catch (e) {
      // oferta zmieniła się między planem a zapisem (druga sesja, pobranie ofert): pominięta, nie błąd
      if (e instanceof KontoError) {
        w.pominiete++
        continue
      }
      w.bledy++
      await db.alert.create({ data: { kind: 'LACZENIE_OFERT_BLAD', ref: `${ref.channelAccountId}:${x.externalId}`.slice(0, 200), message: `Masowe łączenie oferty ${x.externalId}: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}` } }).catch(() => undefined)
    }
  }
  return w
}

export interface Propozycja {
  offerId: string
  externalId: string
  nazwa: string | null
  sku: string | null
  ean: string | null
  produkt: { id: string; sku: string; title: string }
  qtyBasePerOffer: number
  zrodlo: string
}

/**
 * Propozycje powiązań konta (`needsApproval`: import albo „Pobierz oferty” w firmie z BL) do zatwierdzenia. Bez
 * propozycji na produkt wyłączony: zatwierdzenie i tak by odmówiło; wracają po włączeniu produktu.
 */
export async function propozycjeKonta(db: PrismaClient, ref: KontoRef, limit = 500): Promise<Propozycja[]> {
  const rows = await db.channelOffer.findMany({
    where: { channel: ref.channel, channelAccountId: ref.channelAccountId, needsApproval: true, active: false, product: { active: true } },
    include: { product: { select: { id: true, sku: true, title: true } } },
    orderBy: { externalId: 'asc' },
    take: limit,
  })
  const reads = rows.length ? await db.channelOfferRead.findMany({ where: { channel: ref.channel, channelAccountId: ref.channelAccountId, externalId: { in: rows.map((r) => r.externalId) } }, select: { externalId: true, name: true, sku: true, ean: true } }) : []
  const read = new Map(reads.map((r) => [r.externalId, r]))
  // SKU i EAN oferty z ostatniego pobrania, żeby było widać, po czym propozycja pasuje
  return rows.map((r) => {
    const x = read.get(r.externalId)
    return { offerId: r.id, externalId: r.externalId, nazwa: x?.name ?? null, sku: x?.sku ?? null, ean: x?.ean ?? null, produkt: r.product, qtyBasePerOffer: r.qtyBasePerOffer, zrodlo: ZRODLO_POWIAZANIA[r.mappingSource] }
  })
}

/** Zbiorcze zatwierdzenie propozycji: każda osobno, z tym samym produktem i przelicznikiem (`MANUAL`). */
export async function zatwierdzPropozycje(db: PrismaClient, ref: KontoRef, offerIds: string[], actorId: string): Promise<WynikLaczenia> {
  const ids = offerIds.filter((x) => ID_RE.test(x)).slice(0, 500)
  const rows = ids.length ? await db.channelOffer.findMany({ where: { id: { in: ids }, channel: ref.channel, channelAccountId: ref.channelAccountId, needsApproval: true, active: false } }) : []
  const w: WynikLaczenia = { polaczone: 0, pominiete: ids.length - rows.length, bledy: 0, remapped: 0 }
  for (const o of rows) {
    try {
      const r = await przypiszOferte(db, ref, { externalId: o.externalId, productId: o.productId, qtyBasePerOffer: o.qtyBasePerOffer }, { actorId, expected: { productId: o.productId, active: false, qtyBasePerOffer: o.qtyBasePerOffer } })
      await wpisProduktu(db, o.productId, actorId, { powiazanie: 'zatwierdzone', oferta: opisKonta(ref, o.externalId) })
      w.polaczone++
      w.remapped += r.remapped
    } catch (e) {
      if (e instanceof KontoError) {
        w.pominiete++
        continue
      }
      w.bledy++
      await db.alert.create({ data: { kind: 'LACZENIE_OFERT_BLAD', ref: `${ref.channelAccountId}:${o.externalId}`.slice(0, 200), message: `Zatwierdzenie propozycji ${o.externalId}: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}` } }).catch(() => undefined)
    }
  }
  return w
}

// ─── Ręczne wskazanie towaru wFirmy ───────────────────────────────────────────

export interface TowarWfirmy {
  id: string
  code: string | null
  name: string
  type: string
  unit: string
  ean: string | null
  /** Produkt Kompletora, który już ma ten towar (null = wolny). */
  produkt: { id: string; sku: string } | null
}

/** Towary z kopii wFirmy (import katalogu, „Sprawdź w wFirmie”) po kodzie, nazwie, EAN albo numerze towaru. */
export async function szukajTowarowWfirmy(db: PrismaClient, q: string, limit = 20): Promise<TowarWfirmy[]> {
  const t = q.trim().slice(0, 100)
  if (t.length < 2) return []
  const rows = await db.wfirmaGood.findMany({
    where: { OR: [{ code: { equals: t, mode: 'insensitive' } }, { code: { startsWith: t, mode: 'insensitive' } }, { name: { contains: t, mode: 'insensitive' } }, { ean: t }, { id: t }] },
    orderBy: [{ code: 'asc' }, { id: 'asc' }],
    take: Math.min(limit, 50),
  })
  if (!rows.length) return []
  const prods = await db.product.findMany({ where: { wfirmaGoodId: { in: rows.map((r) => r.id) } }, select: { id: true, sku: true, wfirmaGoodId: true } })
  const of = new Map(prods.map((p) => [p.wfirmaGoodId!, p]))
  return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, type: r.type, unit: r.unit, ean: r.ean, produkt: of.get(r.id) ? { id: of.get(r.id)!.id, sku: of.get(r.id)!.sku } : null }))
}

const dec = (v: { toString(): string } | null, digits: number) => (v === null ? null : Number(v.toString()).toFixed(digits))

/**
 * Wskazanie towaru wFirmy dla produktu, którego SKU różni się od kodu towaru. Od tej chwili ceny, VAT i nazwa na
 * fakturze są z tego towaru, a stan produktu bierze odczyt stanów wFirmy z tego towaru (najbliższy odczyt). Import
 * katalogu znajduje produkt po numerze towaru, więc SKU w Kompletorze zostaje. Odmowa: towar ma już inny produkt,
 * inna jednostka (sztuki/kg), usługa dla produktu ze stanem albo towar dla produktu bez stanu, zestaw.
 */
export async function wskazTowarWfirmy(db: PrismaClient, w: { productId: unknown; goodId: unknown; actorId: string }): Promise<{ info: string }> {
  const p = await produktAktywny(db, w.productId)
  const gid = String(w.goodId ?? '').trim()
  if (!/^[0-9a-z_-]{1,40}$/i.test(gid)) throw new PowiazaniaError('Wybierz towar wFirmy z listy.')
  const g = await db.wfirmaGood.findFirst({ where: { id: gid } })
  if (!g) throw new PowiazaniaError('Nie ma takiego towaru w kopii wFirmy: wyszukaj go jeszcze raz.')
  if (p.kind === 'BUNDLE') throw new PowiazaniaError('Zestaw nie ma własnego towaru w wFirmie: stan liczy się ze składników.')
  if (p.kind === 'STOCKED' && g.type !== 'good') throw new PowiazaniaError('Produkt ze stanem łączy się tylko z towarem wFirmy (nie z usługą ani kompletem).')
  if (p.kind === 'DIGITAL' && g.type !== 'service') throw new PowiazaniaError('Produkt bez stanu łączy się tylko z usługą w wFirmie.')
  const jednostka = unitFromWfirma(g.unit)
  if (jednostka !== p.unit) throw new PowiazaniaError(`Towar w wFirmie jest w ${jednostka === 'KG' ? 'kilogramach' : 'sztukach'}, a produkt w ${p.unit === 'KG' ? 'kilogramach' : 'sztukach'}: ilości by się nie zgadzały.`)
  const zajety = await db.product.findFirst({ where: { wfirmaGoodId: g.id }, select: { id: true, sku: true } })
  if (zajety && zajety.id !== p.id) throw new PowiazaniaError(`Ten towar wFirmy ma już produkt SKU „${zajety.sku.slice(0, 60)}”.`)
  if (zajety?.id === p.id) return { info: 'Produkt jest już powiązany z tym towarem wFirmy.' }
  const before = await db.product.findUniqueOrThrow({ where: { id: p.id }, select: { wfirmaGoodId: true, dataSource: true, nameAccounting: true } })
  await db.$transaction(async (tx) => {
    await tx.product.update({
      where: { id: p.id },
      data: {
        wfirmaGoodId: g.id,
        wfirmaType: g.type,
        dataSource: 'WFIRMA',
        nameAccounting: g.name,
        priceNet: dec(g.priceNetRetail, 2),
        priceGross: dec(g.priceGrossRetail, 2),
        vatRate: g.vatRate,
        purchasePriceNet: dec(g.purchasePriceNet, 4),
        wfirmaSyncedAt: g.importedAt,
      },
    })
    await tx.auditLog.create({
      data: { entity: 'Product', entityId: p.id, actorId: w.actorId, before: { wfirmaGoodId: before.wfirmaGoodId, dataSource: before.dataSource }, after: { towarWfirmy: g.code ?? g.id, wfirmaGoodId: g.id } },
    })
  })
  return { info: `Produkt powiązany z towarem wFirmy ${g.code ? `„${g.code}”` : g.id}. Ceny i VAT są teraz z wFirmy, a stan odświeży najbliższy odczyt stanów z wFirmy.` }
}

/** Wpis historii produktu o powiązaniu (AuditLog `after.powiazanie`) po ludzku, do „Historii zmian danych”. */
export function opisPowiazania(a: Record<string, unknown>): string {
  const oferta = typeof a['oferta'] === 'string' ? a['oferta'] : 'oferta'
  const przel = typeof a['przelicznik'] === 'number' && a['przelicznik'] !== 1 ? ` (przelicznik ${a['przelicznik']})` : ''
  switch (a['powiazanie']) {
    case 'dodane':
      return `powiązana oferta ${oferta}${przel}${a['zProduktu'] ? `, przepięta z SKU „${String(a['zProduktu'])}”` : ''}${a['masowo'] ? ` (łączenie po ${String(a['masowo'])})` : ''}`
    case 'odlaczone':
      return `odłączona oferta ${oferta}`
    case 'przepiete':
      return `oferta ${oferta} przepięta na SKU „${String(a['naProdukt'] ?? '')}”`
    case 'zatwierdzone':
      return `zatwierdzona propozycja powiązania z ofertą ${oferta}`
    default:
      return `zmiana powiązania oferty ${oferta}`
  }
}
