// Podgląd faktur dnia: dla każdej faktury BL z dnia składa fakturę, którą wystawiłby system, porównuje ją z BL
// i zapisuje wynik w `InvoiceDryRun` (tylko nasza baza, tylko liczby, kody i SKU). Bez żadnego wywołania BL ani wFirmy:
// dane BL pochodzą z kopii `BlInvoiceSnapshot`, którą robi przebieg faktur cienia. Ponowienie nadpisuje ten sam wiersz.
import type { Prisma, PrismaClient } from '@prisma/client'
import { addDays, fromWarsaw } from '../rdzen/kalendarz'
import { kluczOferty as klucz, kosztWysylkiZamowienia, type OrderRow, pozycjeZamowienia, type ProductRow } from '../dokumenty/pozycje'
import { type KategoriaRoznicy, zlozFakture } from './faktura'
import { type KonfiguracjaFaktur, parseKonfiguracjaFaktur } from './konfiguracja'
import { type FakturaBl, porownajFakture, type PozycjaBl, procentZgodnych, type WynikPorownania } from './porownanie'
import { formaPlatnosci } from './platnosci'

export interface WierszRoznicy {
  numerZamowienia: string
  blInvoiceId: number
  kategorie: KategoriaRoznicy[]
  kody: string[]
}

export interface PodgladDnia {
  dzien: string
  faktury: number
  zgodne: number
  roznice: number
  /** Zgodne, ale z samych sum: kopia BL nie ma pozycji. Wliczone w `zgodne`, poza `procent`. */
  tylkoSumy: number
  bezDanych: number
  korekty: number
  pozaCieniem: number
  bledy: string[]
  procent: number | null
  perKategoria: Record<KategoriaRoznicy, number>
  lista: WierszRoznicy[]
  /** Numery zamówień bez porównania (BL bez sum), żeby nie zniknęły z oczu. */
  numeryBezDanych: string[]
  konfiguracja: { seria: boolean; kodyVat: number }
}

const gr = (v: Prisma.Decimal | number) => Math.round(Number(v) * 100)

/** Pozycje JSON kopii BL (`blInvoiceContent`, faktury-bl.ts) w kształcie porównania. */
export function pozycjeBl(json: Prisma.JsonValue | null): PozycjaBl[] | null {
  if (!Array.isArray(json)) return null
  return (json as { sku?: string | null; qty?: number; priceGross?: number; taxRate?: number | null; shipment?: boolean }[]).map((l) => ({
    sku: l.sku ?? null,
    qty: l.qty ?? 0,
    bruttoGr: Math.round((l.priceGross ?? 0) * (l.qty ?? 0) * 100),
    stawkaVat: l.taxRate === null || l.taxRate === undefined ? null : String(l.taxRate),
    wysylka: !!l.shipment,
  }))
}

/** Treść błędu na konsolę: krótka, a błąd Prismy tylko z nazwy i kodu, bo jego komunikat potrafi cytować argumenty zapytania. */
export function opisBledu(e: unknown): string {
  if (!(e instanceof Error)) return String(e).slice(0, 300)
  if (e.name.startsWith('PrismaClient')) {
    const kod = (e as { code?: unknown }).code
    return typeof kod === 'string' ? `${e.name} ${kod}` : e.name
  }
  return e.message.slice(0, 300)
}

// pozycje zamówienia z bazy w module wspólnym dla programów (lib/dokumenty/pozycje.ts); reeksport dla dawnych importów.
export { pozycjeZamowienia }

/** Dla zamówień nowszych pozycji z kopii; dla starszych kopii suma brutto zamówienia BL (`BlOrderSnapshot`). */
function fakturaBl(inv: { totalGross: Prisma.Decimal | null; totalNet: Prisma.Decimal | null; paymentName: string | null; lines: Prisma.JsonValue | null }, sumaZamowienia: Prisma.Decimal | null | undefined, cfg: KonfiguracjaFaktur): FakturaBl {
  const brutto = inv.totalGross ?? sumaZamowienia ?? null
  return {
    pozycje: pozycjeBl(inv.lines),
    bruttoGr: brutto === null ? null : gr(brutto),
    nettoGr: inv.totalNet === null ? null : gr(inv.totalNet),
    forma: inv.paymentName ? formaPlatnosci(inv.paymentName, null, cfg.platnosci) : null,
  }
}

export async function runFakturyPodglad(db: PrismaClient, opts: { dzien: string; now?: Date }): Promise<PodgladDnia> {
  const now = opts.now ?? new Date()
  const { dzien } = opts
  const org = await db.organization.findFirst({ select: { settings: true } })
  const cfg = parseKonfiguracjaFaktur(org?.settings)
  const r: PodgladDnia = {
    dzien,
    faktury: 0,
    zgodne: 0,
    roznice: 0,
    tylkoSumy: 0,
    bezDanych: 0,
    korekty: 0,
    pozaCieniem: 0,
    bledy: [],
    procent: null,
    perKategoria: { BRAK_POWIAZANIA: 0, ZAOKRAGLENIE: 0, WYSYLKA: 0, VAT: 0, INNE: 0 },
    lista: [],
    numeryBezDanych: [],
    konfiguracja: { seria: !!cfg.seriaId, kodyVat: Object.keys(cfg.kodyVat).length },
  }
  const all = await db.blInvoiceSnapshot.findMany({ where: { dateAdd: { gte: fromWarsaw(dzien, 0), lt: fromWarsaw(addDays(dzien, 1), 0) } }, orderBy: { blInvoiceId: 'asc' } })
  const faktury = all.filter((i) => !i.kind || i.kind === 'normal')
  r.korekty = all.length - faktury.length
  r.faktury = faktury.length
  if (!faktury.length) return r

  const blIds = [...new Set(faktury.map((i) => i.blOrderId))]
  const orders = await db.order.findMany({ where: { blOrderId: { in: blIds }, parentOrderId: null }, include: { lines: true } })
  const orderOf = new Map(orders.map((o) => [o.blOrderId!, o]))
  // zamówienia z paczkami dodatkowymi (rabat liczony na dokumencie przy paczkach = stop)
  const zPaczkami = new Set((await db.order.findMany({ where: { parentOrderId: { in: orders.map((o) => o.id) } }, select: { parentOrderId: true } })).map((c) => c.parentOrderId))
  const sumyBl = new Map((await db.blOrderSnapshot.findMany({ where: { blOrderId: { in: blIds } }, select: { blOrderId: true, totalGross: true } })).map((s) => [s.blOrderId, s.totalGross]))
  const lines = orders.flatMap((o) => o.lines)
  const offers = new Map((await db.channelOffer.findMany({ where: { externalId: { in: lines.flatMap((l) => (l.offerId ? [l.offerId] : [])) } }, select: { channel: true, channelAccountId: true, externalId: true, qtyBasePerOffer: true } })).map((x) => [klucz(x.channel, x.channelAccountId, x.externalId), x.qtyBasePerOffer]))
  const direct = await db.product.findMany({ where: { id: { in: lines.flatMap((l) => (l.productId ? [l.productId] : [])) } }, include: { bundleComponents: true } })
  const parts = await db.product.findMany({ where: { id: { in: direct.flatMap((p) => p.bundleComponents.map((c) => c.componentId)) } }, include: { bundleComponents: true } })
  const products = new Map<string, ProductRow>([...parts, ...direct].map((p) => [p.id, p]))

  for (const inv of faktury) {
    const o = orderOf.get(inv.blOrderId)
    if (!o) {
      r.pozaCieniem++
      continue
    }
    // fail-safe per faktura: zły rekord nie zatrzymuje dnia, a stary wiersz wyniku zostaje do następnego przebiegu
    try {
      const nasza = zlozFakture({
        idExternal: `${o.parentOrderId ?? o.id}/${o.packageNo}/0`,
        totalGross: Number(o.totalGross),
        paymentMethod: o.paymentMethod,
        paymentState: o.paymentState,
        pozycje: pozycjeZamowienia(o, products, offers),
        konfiguracja: cfg,
        kosztWysylki: kosztWysylkiZamowienia(o),
        ...(zPaczkami.has(o.id) ? { paczkiDodatkowe: true } : {}),
      })
      const p = porownajFakture(nasza, fakturaBl(inv, sumyBl.get(inv.blOrderId), cfg))
      const dane = {
        day: dzien,
        orderId: o.id,
        orderNumber: o.externalId,
        result: p.wynik,
        scope: p.zakres,
        categories: p.kategorie,
        diffs: p.roznice as unknown as Prisma.InputJsonValue,
        oursGrossGr: nasza.bruttoGr,
        oursNetGr: nasza.nettoGr,
        checkedAt: now,
      }
      await db.invoiceDryRun.upsert({ where: { organizationId_blInvoiceId: { organizationId: inv.organizationId, blInvoiceId: inv.blInvoiceId } }, create: { blInvoiceId: inv.blInvoiceId, ...dane }, update: dane })
      zlicz(r, p.wynik, p.zakres === 'SUMY')
      if (p.wynik === 'BEZ_DANYCH') r.numeryBezDanych.push(o.externalId)
      if (p.wynik === 'ROZNICA') {
        for (const k of p.kategorie) r.perKategoria[k]++
        r.lista.push({ numerZamowienia: o.externalId, blInvoiceId: inv.blInvoiceId, kategorie: p.kategorie, kody: [...new Set(p.roznice.map((x) => x.kod))] })
      }
    } catch (e) {
      r.bledy.push(`faktura BL ${inv.blInvoiceId}: ${opisBledu(e)}`)
    }
  }
  // Zgodność z samych sum nic nie mówi o pozycjach: poza progiem, ale ROZNICA/SUMY zostaje w mianowniku.
  r.procent = procentZgodnych(r.zgodne - r.tylkoSumy, r.roznice)
  return r
}

function zlicz(r: PodgladDnia, w: WynikPorownania, tylkoSumy: boolean): void {
  if (w === 'ZGODNA') {
    r.zgodne++
    if (tylkoSumy) r.tylkoSumy++
  } else if (w === 'ROZNICA') r.roznice++
  else r.bezDanych++
}
