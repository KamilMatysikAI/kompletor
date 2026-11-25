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
import { SourceError } from '../zrodla/http'
import { FakturyPodglad } from './adapter-podglad'
import { type ZlozonaFaktura, zlozFakture } from './faktura'
import { parseKonfiguracjaFaktur } from './konfiguracja'
import { dzienWystawienia, zaplaconoDoFaktury } from './platnosci'
import { pozycjeZamowienia } from './podglad'
import { komunikatDokumentu, kosztWysylkiZamowienia, kwotaPaczkiDodatkowej, rabatLiczonyNaDokumencie } from '../dokumenty/pozycje'
// funkcja przeniesiona do lib/dokumenty/pozycje.ts (woła ją też szkic KSeF); eksport zostaje dla zgodności
export { kwotaPaczkiDodatkowej } from '../dokumenty/pozycje'
import { PROBA_NIEWIADOMA } from './proba-niewiadoma'
import { fakturyWWalucie, obcaWaluta, powodFakturyRecznej, walutaZamowienia, walutaZamowieniaPoId } from '../rdzen/waluta'
import type { FoundInvoice } from '../rdzen/rozchod'

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

export type WynikZlozenia = { kind: 'OK'; z: ZlozonaFaktura & { tresc: NonNullable<ZlozonaFaktura['tresc']> }; skuProduktu: Map<string, string>; waluta: string } | { kind: 'ERROR'; message: string }

/** kod waluty, który wysyłamy do wFirmy (ISO 4217: trzy wielkie litery). */
const KOD_WALUTY = /^[A-Z]{3}$/

/** Alert dla biura (grupa „Faktury”): faktura w obcej walucie powstała, ale odczyt z wFirmy nie zgadza się z wysłaną. */
export const ALERT_FAKTURA_WALUTA_SPRAWDZ = 'FAKTURA_WALUTA_SPRAWDZ'
/** Ślad w historii zamówienia: waluta, kwota i kurs faktury z odczytu wFirmy (karta zamówienia pokazuje je przy numerze). */
export const FAKTURA_WALUTA = 'FAKTURA_WALUTA'

export interface OdczytFakturyWaluty {
  waluta: string | null
  bruttoGr: number | null
  kurs: number | null
  dataKursu: string | null
  tabela: string | null
}

const liczba = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string' || !v.trim()) return null
  const n = Number(v.trim().replace(',', '.'))
  return Number.isFinite(n) ? n : null
}
const napis = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const rek = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** Waluta, kwota brutto (`total`) i kurs księgowy z odpowiedzi `invoices/get/<id>`; null = odpowiedź bez dokumentu. */
export function odczytFakturyWaluty(json: unknown): OdczytFakturyWaluty | null {
  for (const [k, v] of Object.entries(rek(rek(json)['invoices']))) {
    if (k === 'parameters') continue
    const inv = rek(rek(v)['invoice'])
    if (inv['id'] === undefined || inv['id'] === null) continue
    const total = liczba(inv['total'])
    return { waluta: napis(inv['currency'])?.toUpperCase() ?? null, bruttoGr: total === null ? null : Math.round(total * 100), kurs: liczba(inv['currency_exchange']), dataKursu: napis(inv['currency_date']), tabela: napis(inv['currency_label']) }
  }
  return null
}

/**
 * rozjazdy faktury w obcej walucie po odczycie z wFirmy (puste = zgodna). Waluta musi być ta, którą wysłaliśmy,
 * kurs księgowy dodatni (wFirma przeliczyła na PLN), kwota brutto zgodna z naszą (gdy ją znamy) z tolerancją 1 grosza
 * waluty na każdą stawkę VAT na dokumencie (przeglądu: wFirma zaokrągla VAT per stawka), najmniej 1 grosz. Rozjazd
 * kwoty podaje obie kwoty i walutę odczytaną z wFirmy (pierwszy odczyt z produkcji pokaże, czy `total` jest w walucie
 * dokumentu).
 */
export function rozjazdyFakturyWaluty(r: OdczytFakturyWaluty | null, oczekiwane: { waluta: string; bruttoGr?: number; stawekVat?: number }): string[] {
  if (!r) return ['wFirma nie oddała faktury do sprawdzenia']
  const out: string[] = []
  if (r.waluta !== oczekiwane.waluta) out.push(`waluta faktury ${r.waluta ?? 'brak'}, a zamówienia ${oczekiwane.waluta}`)
  if (r.kurs === null || r.kurs <= 0) out.push('brak kursu NBP na fakturze')
  const tolerancja = Math.max(1, oczekiwane.stawekVat ?? 1)
  if (oczekiwane.bruttoGr !== undefined && (r.bruttoGr === null || Math.abs(r.bruttoGr - oczekiwane.bruttoGr) > tolerancja))
    out.push(`kwota brutto w wFirmie ${r.bruttoGr === null ? 'brak' : (r.bruttoGr / 100).toFixed(2)} ${r.waluta ?? 'bez waluty'}, a wysłana ${(oczekiwane.bruttoGr / 100).toFixed(2)} ${oczekiwane.waluta}`)
  return out
}

/** Liczba różnych stawek VAT (kodów `vat_code`) w treści faktury do wFirmy; tolerancja kwoty w `rozjazdyFakturyWaluty`. */
export function stawekVatWTresci(tresc: { invoices: { invoice: Record<string, unknown> } }): number {
  const kody = new Set<string>()
  for (const v of Object.values(rek(tresc.invoices.invoice['invoicecontents']))) kody.add(JSON.stringify(rek(rek(rek(v)['invoicecontent'])['vat_code'])['id'] ?? null))
  return Math.max(1, kody.size)
}

/** odczyt kontrolny jedną próbą, limit 15 s (zapis z odczytem mieści się w oknie sprzątacza prób). */
const ODCZYT_KONTROLNY = { attempts: 1, timeoutMs: 15_000 } as const

/** Limit wFirmy w odpowiedzi klienta odczytu (HTTP 429, „… LIMIT …”): bez połykania, jak w pozostałych wywołaniach. */
const czyLimit = (e: unknown): boolean => e instanceof SourceError && !e.retryable && /limit/i.test(e.message)

/**
 * Treść faktury zamówienia do wFirmy z danych w bazie: zamówienie (z paczką główną przy podziale), oferty, produkty
 * z zestawami, nabywca, konfiguracja firmy. Jedna droga dla wystawienia (`FakturyWfirmaZapis.issue`) i faktury roboczej
 * (lib/wfirma/faktura-robocza.ts), więc robocza ma dokładnie tę treść, którą dostałaby prawdziwa faktura. Tylko odczyt
 * bazy; dane nabywcy żyją w pamięci wyniku.
 */
export async function zlozFaktureZamowienia(
  db: PrismaClient,
  orderId: string,
  opcje: { idExternal: string; odbiorca: ZaleznosciZapisu['odbiorca']; produktyDodatkowe?: string[]; towarBezPowiazania?: boolean; now?: Date },
): Promise<WynikZlozenia> {
  const o = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { lines: true, payments: { select: { kind: true, amount: true } } } })
  // waluta z kopii kanału (paczka dodatkowa dziedziczy walutę zamówienia głównego). Obca tylko przy włączonym
  // „Faktury w walucie zamówienia” (druga warstwa za bezpiecznikiem rdzenia: faktura robocza próby idzie tą samą drogą)
  const waluta = await walutaZamowienia(db, o)
  if (obcaWaluta(waluta)) {
    if (!(await fakturyWWalucie(db))) return { kind: 'ERROR', message: powodFakturyRecznej(waluta) }
    if (!KOD_WALUTY.test(waluta)) return { kind: 'ERROR', message: `Nieczytelny kod waluty zamówienia („${waluta.slice(0, 12)}”): faktura nie została wysłana do wFirmy. Wystaw ją ręcznie.` }
  }
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
  const z = zlozFakture({ idExternal: opcje.idExternal, totalGross: o.parentOrderId ? kwotaPaczkiDodatkowej(pozycje) : Number(o.totalGross), paymentMethod: o.paymentMethod, paymentState: o.paymentState, pozycje, konfiguracja: cfg, kosztWysylki: kosztWysylkiZamowienia(o), ...(paczkiDodatkowe ? { paczkiDodatkowe: true } : {}), ...(rabatMatki ? { rabatMatkiNaDokumencie: true } : {}), kontrahent: k.wartosc, ...(opcje.towarBezPowiazania ? { towarBezPowiazania: true } : {}), zaplacono: zaplaconoDoFaktury(o, o.payments), dataWystawienia: dzienWystawienia(opcje.now ?? new Date()), ...(obcaWaluta(waluta) ? { waluta } : {}) })
  if (!z.tresc) return { kind: 'ERROR', message: komunikatDokumentu(z.problemy) ?? `Faktura nie dała się złożyć: ${[...new Set(z.problemy.map((p) => (p.sku ? `${p.kod} (${p.sku})` : p.kod)))].join(', ')}`.slice(0, 900) }
  return { kind: 'OK', z: { ...z, tresc: z.tresc }, skuProduktu: new Map([...products.values()].map((p) => [p.id, p.sku])), waluta }
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
      // sprawdzenie waluty znalezionej faktury robi już `findByPrefix` tej klasy
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
    // faktura w obcej walucie — odczyt z wFirmy i porównanie waluty, kursu i kwoty (zamówienia w PLN bez
    // dodatkowego wywołania, jak przed zmianą)
    // jedna próba z limitem 15 s; porażka = faktura zostaje (ISSUED), alert „sprawdź dokument ręcznie”, nigdy druga
    // faktura; limit wFirmy = rdzeń wstrzymuje kolejkę (`limitPoZapisie`), a WZ już nie czytamy (rdzeń ponowi odczyt WZ)
    const kontrola = obcaWaluta(zl.waluta) ? await this.sprawdzWalute(attempt.orderId, r.id, { waluta: zl.waluta, bruttoGr: z.bruttoGr, stawekVat: stawekVatWTresci(z.tresc) }) : 'OK'
    if (kontrola === 'LIMIT') {
      const wzBez: Record<string, number | null> = attempt.documentOnly ? {} : Object.fromEntries(req.lines.filter((l) => !l.service).map((l) => [l.productId, null]))
      return { kind: 'OK', docId: r.id, wz: wzBez, number: r.numer, limitPoZapisie: {} }
    }
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

  /**
   * faktury znalezione po prefiksie (rozstrzyganie timeoutu w rdzeniu, `resolveUnknownInvoices`, i ponowna
   * próba po niewiadomej) dla zamówienia w obcej walucie przechodzą to samo sprawdzenie waluty i kursu co faktura
   * z odpowiedzi zapisu. Prefiks `<orderId>/<n>/` niesie id zamówienia głównego, więc ślad i alert idą na zamówienie
   * próby (paczka dodatkowa ma własne id), ustalone po `id_external` znalezionej faktury w `InvoiceAttempt`, potem po
   * prefiksie paczki; dopiero bez próby w bazie na zamówienie z prefiksu. Limit wFirmy przy odczycie = `WfirmaLimitError`
   * jak przy samym find (próba czeka na następny przebieg). Zamówienie w PLN i prefiks spoza zamówień (test filtra
   * find): bez dodatkowych wywołań.
   */
  override async findByPrefix(prefix: string): Promise<FoundInvoice[]> {
    const found = await super.findByPrefix(prefix)
    const zPrefiksu = prefix.split('/')[0] ?? ''
    if (!found.length || !zPrefiksu) return found
    for (const f of found) {
      const proba =
        (await this.baza.invoiceAttempt.findFirst({ where: { idExternal: f.idExternal }, select: { orderId: true } })) ??
        (await this.baza.invoiceAttempt.findFirst({ where: { idExternal: { startsWith: prefix } }, orderBy: { createdAt: 'desc' }, select: { orderId: true } }))
      const orderId = proba?.orderId ?? zPrefiksu
      if (!obcaWaluta(await walutaZamowieniaPoId(this.baza, orderId))) continue
      if ((await this.sprawdzWalute(orderId, f.docId)) === 'LIMIT') throw new WfirmaLimitError('limit wFirmy przy sprawdzeniu waluty faktury')
    }
    return found
  }

  /**
   * Odczyt `invoices/get/<id>` faktury zamówienia w obcej walucie: ślad z walutą, kwotą i kursem w historii zamówienia
   * (raz na dokument) albo alert dla biura, gdy waluta, kurs lub kwota się nie zgadzają albo odczyt się nie udał. Faktura
   * już istnieje, więc niezgodność nigdy nie wywołuje drugiej próby: poprawia ją biuro w wFirmie. Odczyt jedną próbą
   * z limitem 15 s; nieudany = alert „sprawdź dokument ręcznie”, limit wFirmy = wynik `LIMIT` dla wołającego.
   */
  private async sprawdzWalute(orderId: string, docId: string, oczekiwane?: { waluta: string; bruttoGr?: number; stawekVat?: number }): Promise<'OK' | 'LIMIT'> {
    const db = this.baza
    const waluta = oczekiwane?.waluta ?? (await walutaZamowieniaPoId(db, orderId))
    let odczyt: OdczytFakturyWaluty | null = null
    let bladOdczytu: string | null = null
    let limit = false
    try {
      odczyt = odczytFakturyWaluty(await this.wf.call(`invoices/get/${docId}`, {}, ODCZYT_KONTROLNY))
    } catch (e) {
      limit = czyLimit(e)
      bladOdczytu = e instanceof Error ? e.message.slice(0, 160) : 'błąd odczytu'
    }
    if (bladOdczytu) {
      await alert(db, ALERT_FAKTURA_WALUTA_SPRAWDZ, orderId, `Faktura w ${waluta} (dokument wFirmy ${docId}) powstała, ale nie udało się sprawdzić waluty i kwoty faktury w wFirmie (${bladOdczytu}): sprawdź dokument ręcznie. Kompletor nie wystawi drugiej faktury.`.slice(0, 900), `faktura-waluta:${docId}`)
      return limit ? 'LIMIT' : 'OK'
    }
    const rozjazdy = rozjazdyFakturyWaluty(odczyt, { waluta, ...(oczekiwane?.bruttoGr !== undefined ? { bruttoGr: oczekiwane.bruttoGr } : {}), ...(oczekiwane?.stawekVat !== undefined ? { stawekVat: oczekiwane.stawekVat } : {}) })
    if (rozjazdy.length || !odczyt) {
      await alert(db, ALERT_FAKTURA_WALUTA_SPRAWDZ, orderId, `Faktura w ${waluta} (dokument wFirmy ${docId}) powstała, ale do sprawdzenia w wFirmie: ${rozjazdy.join('; ')}. Kompletor nie wystawi drugiej faktury; popraw ją w wFirmie albo wystaw korektę.`.slice(0, 900), `faktura-waluta:${docId}`)
      return 'OK'
    }
    if (await db.orderEvent.findFirst({ where: { orderId, kind: FAKTURA_WALUTA, data: { path: ['docId'], equals: docId } }, select: { id: true } })) return 'OK'
    await db.orderEvent.create({ data: { orderId, kind: FAKTURA_WALUTA, actorId: 'system:faktury', data: { docId, waluta: odczyt.waluta, bruttoGr: odczyt.bruttoGr, kurs: odczyt.kurs, dataKursu: odczyt.dataKursu, tabela: odczyt.tabela } } })
    return 'OK'
  }
}
