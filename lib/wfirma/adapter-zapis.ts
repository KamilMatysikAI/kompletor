// `FakturyWfirma` z ZAPISEM w wFirmie. Wystawienie składa treść tą samą funkcją co podgląd
// i porównanie z BL (`zlozFakture`), więc to, co porównaliśmy z fakturami BL, jest tym, co idzie do wFirmy.
// `find` i odczyt WZ dziedziczy z podglądu (tylko odczyt przez `WfirmaReadOnly`). Sam zapis idzie wyłącznie przez
// klienta `WfirmaZapis` (lib/zrodla/wfirma-zapis.ts) — w tym module nie ma żadnej ścieżki API.
//
// Bezpiecznik zgodności: rdzeń podaje pozycje z rezerwacji (to, co spakowane), treść faktury bierze się z zamówienia.
// Gdy ilości towarów się różnią (brak przy pakowaniu, pozycja odrzucona po złożeniu), faktura NIE wychodzi: błąd
// jednoznaczny z kodem różnicy, alert i ręczne wystawienie albo „Ponów fakturę” po poprawce. Druga faktura albo faktura
// na inny towar niż w paczce byłyby gorsze niż ręczna robota.
//
// Dane kontrahenta żyją tylko w pamięci tego wywołania (`odbiorca`): nie trafiają do logu, alertu ani komunikatu błędu.
import type { PrismaClient } from '@prisma/client'
import type { OrderRecipient } from '../adaptery/kontrakt'
import { kontrahentDoWystawienia } from '../odbiorca/przejscia'
import { type FakturyWfirma, type InvoiceLine, type IssueResult, validateFound, WfirmaLimitError } from '../rdzen/rozchod'
import { alert } from '../rdzen/stan'
import type { WfirmaReadOnly } from '../zrodla/wfirma'
import type { WynikWystawienia } from '../zrodla/wfirma-zapis'
import { FakturyPodglad } from './adapter-podglad'
import { type ZlozonaFaktura, zlozFakture } from './faktura'
import { parseKonfiguracjaFaktur } from './konfiguracja'
import { pozycjeZamowienia } from './podglad'
import { komunikatDokumentu, kosztWysylkiZamowienia, kwotaPaczkiDodatkowej, rabatLiczonyNaDokumencie } from '../dokumenty/pozycje'
// funkcja przeniesiona do lib/dokumenty/pozycje.ts (woła ją też szkic KSeF); eksport zostaje dla zgodności
export { kwotaPaczkiDodatkowej } from '../dokumenty/pozycje'
import { PROBA_NIEWIADOMA } from './proba-niewiadoma'

export interface ZaleznosciZapisu {
  /** Klient zapisu (prawdziwy `WfirmaZapis` albo atrapa w testach). */
  zapis: { wystawFakture(tresc: { invoices: { invoice: Record<string, unknown> } }): Promise<WynikWystawienia> }
  /** Odbiorca zamówienia przycięty do faktury (lib/klienci/wejscia.ts `odbiorcaDoCelu`, cel FAKTURA); null = brak danych. */
  odbiorca(orderId: string): Promise<OrderRecipient | null>
}

const klucz = (channel: string, konto: string, oferta: string) => `${channel}|${konto}|${oferta}`

/** Różnice ilości towaru (jednostka bazowa) między treścią faktury a pozycjami rdzenia; puste = zgodne. Same SKU i liczby. */
export function rozniceIlosci(faktura: { sku: string | null; ilosc: number; jednostka: 'szt.' | 'kg'; wysylka?: true }[], rdzen: InvoiceLine[], skuProduktu: Map<string, string>): string[] {
  const nasze = new Map<string, number>()
  for (const l of faktura) {
    if (l.wysylka || l.sku === null) continue
    nasze.set(l.sku, (nasze.get(l.sku) ?? 0) + (l.jednostka === 'kg' ? Math.round(l.ilosc * 1000) : l.ilosc))
  }
  const paczka = new Map<string, number>()
  for (const l of rdzen) {
    const sku = skuProduktu.get(l.productId) ?? `?${l.productId}`
    paczka.set(sku, (paczka.get(sku) ?? 0) + l.qty)
  }
  const out: string[] = []
  for (const sku of new Set([...nasze.keys(), ...paczka.keys()])) {
    const a = nasze.get(sku) ?? 0
    const b = paczka.get(sku) ?? 0
    if (a !== b) out.push(`${sku}: faktura ${a}, paczka ${b}`)
  }
  return out.sort()
}

export type WynikZlozenia = { kind: 'OK'; z: ZlozonaFaktura & { tresc: NonNullable<ZlozonaFaktura['tresc']> }; skuProduktu: Map<string, string> } | { kind: 'ERROR'; message: string }

/**
 * Treść faktury zamówienia do wFirmy z danych w bazie: zamówienie (z paczką główną przy podziale), oferty, produkty
 * z zestawami, nabywca, konfiguracja firmy. Jedna droga dla wystawienia (`FakturyWfirmaZapis.issue`) i faktury roboczej
 * (lib/wfirma/faktura-robocza.ts), więc robocza ma dokładnie tę treść, którą dostałaby prawdziwa faktura. Tylko odczyt
 * bazy; dane nabywcy żyją w pamięci wyniku.
 */
export async function zlozFaktureZamowienia(
  db: PrismaClient,
  orderId: string,
  opcje: { idExternal: string; odbiorca: ZaleznosciZapisu['odbiorca']; produktyDodatkowe?: string[]; towarBezPowiazania?: boolean },
): Promise<WynikZlozenia> {
  const o = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { lines: true } })
  const org = await db.organization.findFirst({ select: { settings: true } })
  const cfg = parseKonfiguracjaFaktur(org?.settings)
  // druga paczka (podział, „dośle później”) pyta, czy zamówienie główne ma rabat liczony dopiero
  // na dokumencie (cena pozycji sprzed rabatu); zamówienie główne pyta, czy ma paczki dodatkowe
  const glowne = o.parentOrderId ? await db.order.findUnique({ where: { id: o.parentOrderId }, include: { lines: true } }) : null
  const paczkiDodatkowe = o.parentOrderId ? 0 : await db.order.count({ where: { parentOrderId: o.id } })
  const wszystkieLinie = [...o.lines, ...(glowne?.lines ?? [])]
  const offerIds = wszystkieLinie.flatMap((l) => (l.offerId ? [l.offerId] : []))
  const offers = new Map(
    (await db.channelOffer.findMany({ where: { externalId: { in: offerIds }, channel: o.channel, channelAccountId: o.channelAccountId }, select: { channel: true, channelAccountId: true, externalId: true, qtyBasePerOffer: true } })).map((x) => [klucz(x.channel, x.channelAccountId, x.externalId), x.qtyBasePerOffer]),
  )
  const direct = await db.product.findMany({ where: { id: { in: [...wszystkieLinie.flatMap((l) => (l.productId ? [l.productId] : [])), ...(opcje.produktyDodatkowe ?? [])] } }, include: { bundleComponents: true } })
  const parts = await db.product.findMany({ where: { id: { in: direct.flatMap((p) => p.bundleComponents.map((c) => c.componentId)) } }, include: { bundleComponents: true } })
  const products = new Map([...parts, ...direct].map((p) => [p.id, p]))

  // druga paczka (podział, „dośle później”) nie ma własnego rekordu klienta ani prośby
  // o fakturę — nabywca i prośba z zamówienia głównego
  const odbiorca = await opcje.odbiorca(glowne?.id ?? o.id)
  if (!odbiorca) return { kind: 'ERROR', message: 'Brak danych nabywcy (dane klienta niedostępne): faktura nie została wysłana do wFirmy' }
  const k = kontrahentDoWystawienia(odbiorca, o.wantInvoiceNip || !!glowne?.wantInvoiceNip)
  if (!k.ok) return { kind: 'ERROR', message: `Brak danych nabywcy do faktury: ${k.braki.join(', ')}` }

  const pozycje = pozycjeZamowienia(o, products, offers)
  const rabatMatki = !!glowne && rabatLiczonyNaDokumencie({ totalGross: Number(glowne.totalGross), kosztWysylki: kosztWysylkiZamowienia(glowne), pozycje: pozycjeZamowienia(glowne, products, offers), rabatMaksProcent: cfg.rabatMaksProcent })
  const z = zlozFakture({ idExternal: opcje.idExternal, totalGross: o.parentOrderId ? kwotaPaczkiDodatkowej(pozycje) : Number(o.totalGross), paymentMethod: o.paymentMethod, paymentState: o.paymentState, pozycje, konfiguracja: cfg, kosztWysylki: kosztWysylkiZamowienia(o), ...(paczkiDodatkowe ? { paczkiDodatkowe: true } : {}), ...(rabatMatki ? { rabatMatkiNaDokumencie: true } : {}), kontrahent: k.wartosc, ...(opcje.towarBezPowiazania ? { towarBezPowiazania: true } : {}) })
  if (!z.tresc) return { kind: 'ERROR', message: komunikatDokumentu(z.problemy) ?? `Faktura nie dała się złożyć: ${[...new Set(z.problemy.map((p) => (p.sku ? `${p.kod} (${p.sku})` : p.kod)))].join(', ')}`.slice(0, 900) }
  return { kind: 'OK', z: { ...z, tresc: z.tresc }, skuProduktu: new Map([...products.values()].map((p) => [p.id, p.sku])) }
}

export class FakturyWfirmaZapis extends FakturyPodglad implements FakturyWfirma {
  constructor(
    wf: Pick<WfirmaReadOnly, 'call'>,
    private readonly baza: PrismaClient,
    private readonly deps: ZaleznosciZapisu,
  ) {
    super(wf, baza)
  }

  override async issue(req: { idExternal: string; lines: InvoiceLine[]; paymentMethod: string }): Promise<IssueResult> {
    const db = this.baza
    const attempt = await db.invoiceAttempt.findFirst({ where: { idExternal: req.idExternal }, select: { id: true, orderId: true, packageNo: true, documentOnly: true } })
    if (!attempt) return { kind: 'ERROR', message: 'próba faktury nie istnieje w bazie' }
    // wcześniejsza próba tej paczki skończyła się niewiadomą (timeout, „nie znaleziono po
    // 3 próbach”) — faktura mogła pojawić się w wFirmie później (opóźniony indeks find). Zanim cokolwiek złożymy i wyślemy zapis faktury,
    // jeszcze jedno `find` po prefiksie paczki: znaleziona = ta faktura (rdzeń rozliczy ją bieżącą próbą), nie druga.
    const niewiadoma = await db.invoiceAttempt.count({ where: { orderId: attempt.orderId, packageNo: attempt.packageNo, id: { not: attempt.id }, ...PROBA_NIEWIADOMA } })
    if (niewiadoma) {
      const prefix = req.idExternal.slice(0, req.idExternal.lastIndexOf('/') + 1)
      let found
      try {
        found = validateFound(prefix, await this.findByPrefix(prefix))
      } catch (e) {
        if (e instanceof WfirmaLimitError) return { kind: 'LIMIT', message: e.message, ...(e.retryAfterMs ? { retryAfterMs: e.retryAfterMs } : {}) }
        throw e // błąd filtra albo transportu: rdzeń traktuje jak niewiadomą, bez zapisu faktury
      }
      if (found.length > 1) await alert(db, 'DUBLET_FAKTURY', attempt.orderId, `Więcej niż jedna faktura dla ${prefix}: ${found.map((f) => f.docId).join(', ')} — korekta przez biuro`, `dublet:${prefix}`)
      const f = found[0]
      if (f) return { kind: 'OK', docId: f.docId, wz: attempt.documentOnly ? {} : f.wz, number: f.number ?? null }
    }

    const zl = await zlozFaktureZamowienia(db, attempt.orderId, { idExternal: req.idExternal, odbiorca: this.deps.odbiorca, produktyDodatkowe: req.lines.map((l) => l.productId), ...(attempt.documentOnly ? { towarBezPowiazania: true } : {}) })
    if (zl.kind === 'ERROR') return zl
    const { z, skuProduktu } = zl
    const roznice = rozniceIlosci(z.linie, req.lines, skuProduktu)
    if (roznice.length) return { kind: 'ERROR', message: `Treść faktury różni się od spakowanego towaru (${roznice.slice(0, 5).join('; ')}) — wystaw ręcznie albo popraw zamówienie i kliknij „Ponów fakturę”`.slice(0, 900) }

    const r = await this.deps.zapis.wystawFakture(z.tresc)
    if (r.kind === 'ERROR') return { kind: 'ERROR', message: r.message }
    if (r.kind === 'LIMIT') return { kind: 'LIMIT', message: r.message, ...(r.retryAfterMs ? { retryAfterMs: r.retryAfterMs } : {}) }
    if (r.kind === 'TIMEOUT') return { kind: 'TIMEOUT' }
    // WZ czytamy osobno; błąd odczytu = null dla każdej pozycji towarowej (rdzeń ponowi odczyt WZ po 30 s / 2 min / 5 min)
    // dokument bez rozchodu: stan prowadzi Kompletor, WZ wFirmy nas nie dotyczy (bez odczytu)
    if (attempt.documentOnly) return { kind: 'OK', docId: r.id, wz: {}, number: r.numer }
    let wz: Record<string, number | null>
    try {
      wz = await this.readWz(r.id)
    } catch {
      wz = Object.fromEntries(req.lines.filter((l) => !l.service).map((l) => [l.productId, null]))
    }
    return { kind: 'OK', docId: r.id, wz, number: r.numer }
  }
}
