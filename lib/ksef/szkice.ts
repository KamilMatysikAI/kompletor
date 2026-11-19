// Składanie i odkładanie faktur KSeF dla firm bez wFirmy (`settings.faktury.program = ksef`). Szkic FA(3)
// zamówienia i paczki trafia do `KsefInvoiceDraft` w naszej bazie; do KSeF nie idzie nic. Klient bazy firmy (RLS).
//
// Nabywca: gdy zamówienie ma dane klienta w bazie (`OrderCustomer`, dane do faktury), szkic sprawdza
// prawdziwego nabywcę (NIP, nazwa, adres) — problemy nabywcy trafiają do szkicu jako kody i stałe teksty. Zapisany XML
// i walidacja XSD nadal mają stałą zastępczą `NABYWCA_ZASTEPCZY` (`BrakID` = 1): dane klienta nie wychodzą poza
// zaszyfrowaną tabelę. Bez danych w bazie zostaje sama stała zastępcza; prawdziwy XML składa wysyłka. Numer z serii też
// dopiero przy zatwierdzeniu do wysyłki: szkic ma P_2 = SZKIC-<id> i `numer` = null, więc podgląd nie zjada numerów.
// Ponowne przygotowanie nadpisuje wiersz, dopóki `numer` jest pusty; wiersz z numerem nie zmienia się nigdy.
import { createHash } from 'node:crypto'
import { Prisma, type Carrier, type OrderStatus, type PrismaClient, type Product } from '@prisma/client'
import { organizationIdOf } from '../db'
import { addDays, fromWarsaw, toWarsaw } from '../rdzen/kalendarz'
import { STATUSY_KSEF_WYSYLKA } from '../rdzen/dokument-sprzedazy'
import { zrodloStanu } from '../rdzen/zrodlo-stanu'
import { parseKonfiguracjaFaktur } from '../wfirma/konfiguracja'
import { opisBledu, pozycjeZamowienia } from '../wfirma/podglad'
import { kosztWysylkiZamowienia, kwotaPaczkiDodatkowej, type PozycjaZamowienia, rabatLiczonyNaDokumencie, type WejsciePozycji } from '../dokumenty/pozycje'
import { rabatMaksProcent } from '../dokumenty/ustawienia'
import { zbudujFa3 } from './fa3/builder'
import type { ProblemFa3 } from './fa3/typy'
import { walidujFa3, type WynikWalidacji } from './fa3/xsd'
import { parseKonfiguracjaKsef, programFaktur } from './konfiguracja'
import { linieKsef } from './linie'
import { nabywcaKsef } from '../klienci/wejscia'
import type { NabywcaFa3, WejscieFa3 } from './fa3/typy'

type Db = PrismaClient

/** Statusy szkicu. ZLOZONA = złożona bez problemów, ale bez potwierdzenia XSD (brak schematów). */
export const STATUSY_SZKICU = ['ZLOZONA', 'BLAD_WALIDACJI', 'POZA_KSEF', 'ODLOZONA'] as const
/**
 * statusy wysyłki (lib/ksef/wysylka.ts). WYSYLANA = próba w toku (numer już przydzielony), WYSLANA = KSeF
 * przyjął do przetwarzania, czekamy na wynik, PRZYJETA = numer KSeF i UPO, ODRZUCONA = KSeF odrzucił treść,
 * BLAD_WYSYLKI = nie doszła albo nie wiadomo, czy doszła (ponowienie wysyła ten sam numer; dubel KSeF odrzuca kodem 440).
 */
export { STATUSY_KSEF_WYSYLKA }
export const STATUSY_KSEF = [...STATUSY_SZKICU, ...STATUSY_KSEF_WYSYLKA] as const
export type StatusSzkicu = (typeof STATUSY_SZKICU)[number]
export type StatusKsef = (typeof STATUSY_KSEF)[number]

export const STATUS_KSEF_LABEL: Record<StatusKsef, string> = {
  ZLOZONA: 'złożona (bez sprawdzenia schematem)',
  BLAD_WALIDACJI: 'błąd walidacji',
  POZA_KSEF: 'poza KSeF (osoba prywatna)',
  // XML szkicu ma nabywcę zastępczego i datę przygotowania; przy wysyłce składany jest od nowa
  ODLOZONA: 'sprawdzona schematem; przy wysyłce składana ponownie z nabywcą, datą i numerem',
  WYSYLANA: 'wysyłana do KSeF',
  WYSLANA: 'wysłana, KSeF ją przetwarza',
  PRZYJETA: 'przyjęta w KSeF',
  ODRZUCONA: 'odrzucona przez KSeF',
  BLAD_WYSYLKI: 'nie wysłała się',
}

/** Nabywca w szkicu: stała zastępcza, prawdziwy dochodzi dopiero przy wysyłce. */
export const NABYWCA_ZASTEPCZY = 'Nabywca (uzupełniany przy wysyłce)'

/** firma z jawnym programem „brak”. */
export const NIE_DOTYCZY_BRAK = 'Firma nie ma programu do faktur: Kompletor nie składa faktur (Ustawienia → Dokumenty i faktury → Dokumenty sprzedaży).'

export const NIE_DOTYCZY_WFIRMA = 'Firma wystawia faktury w wFirmie: do KSeF wysyła je wFirma, Kompletor nie składa szkicu KSeF.'

export class BladKsef extends Error {}

export type WynikKsef =
  | { wynik: 'przygotowana'; id: string; orderId: string; packageNo: number; status: StatusSzkicu; problemy: ProblemFa3[]; nabywca: 'BAZA' | 'ZASTEPCZY' }
  | { wynik: 'nie_dotyczy'; powod: string }
  | { wynik: 'zablokowana'; powod: string }

/** Id szkicu z firmy, zamówienia i paczki: stałe, więc P_2 „SZKIC-<id>” nie zmienia się przy ponowieniu ani wyścigu. */
export function idSzkicu(organizationId: string, orderId: string, packageNo: number): string {
  return createHash('sha256').update(`ksef|${organizationId}|${orderId}|${packageNo}`).digest('hex').slice(0, 24)
}

/**
 * Dlaczego zamówienie nie dostaje szkicu KSeF; null = dotyczy. Zamówienie bez wysyłki (`BEZ_WYSYLKI`, np. sam
 * e-book) fakturę dostaje: to sprzedaż usługi, tylko bez wiersza „Wysyłka”.
 */
export function powodNieDotyczy(z: { status: OrderStatus; carrier: Carrier | null; liczbaPozycji: number }): string | null {
  if (z.status === 'ANULOWANE') return 'Zamówienie anulowane.'
  if (z.liczbaPozycji === 0) return 'Zamówienie nie ma pozycji.'
  return null
}

type ProductRow = Product & { bundleComponents: { componentId: string; qtyBase: number }[] }
type OrderRow = Prisma.OrderGetPayload<{ include: { lines: true } }>

/** Ten sam klucz oferty co `pozycjeZamowienia` (lib/wfirma/podglad.ts). */
const kluczOferty = (channel: string, konto: string, oferta: string) => `${channel}|${konto}|${oferta}`

export async function slowniki(db: Db, orders: OrderRow[]): Promise<{ products: Map<string, ProductRow>; offers: Map<string, number> }> {
  const lines = orders.flatMap((o) => o.lines)
  const offers = new Map(
    (await db.channelOffer.findMany({ where: { externalId: { in: lines.flatMap((l) => (l.offerId ? [l.offerId] : [])) } }, select: { channel: true, channelAccountId: true, externalId: true, qtyBasePerOffer: true } })).map((x) => [
      kluczOferty(x.channel, x.channelAccountId, x.externalId),
      x.qtyBasePerOffer,
    ]),
  )
  const direct = await db.product.findMany({ where: { id: { in: lines.flatMap((l) => (l.productId ? [l.productId] : [])) } }, include: { bundleComponents: true } })
  const parts = await db.product.findMany({ where: { id: { in: direct.flatMap((p) => p.bundleComponents.map((c) => c.componentId)) } }, include: { bundleComponents: true } })
  return { products: new Map<string, ProductRow>([...parts, ...direct].map((p) => [p.id, p])), offers }
}

const unikalne = (p: ProblemFa3[]) => [...new Map(p.map((x) => [`${x.kod}|${x.pole ?? ''}`, x])).values()]

export interface OpcjeKsef {
  now?: Date
  /** Katalog XSD (testy); domyślnie `KSEF_XSD_DIR` albo lib/ksef/xsd/. */
  xsdDir?: string
}

/**
 * pola reguły rabatu na całe zamówienie, te same co faktura wFirmy (`zlozFakture`): sufit
 * rabatu firmy, pobranie i paczki dodatkowe zamówienia głównego.
 * (punkt 8): paczka dodatkowa (podzamówienie z `totalGross` 0) ma kwotę = sumę swoich pozycji
 * (`kwotaPaczkiDodatkowej`), a rabat liczony na dokumencie matki zatrzymuje też ją (`rabatMatkiNaDokumencie`); jak
 * `lib/wfirma/adapter-zapis.ts`. Wcześniej szkic paczki 2 brał `totalGross` 0 i stawał na „pozycje droższe niż zamówienie”.
 */
async function wejscieDokumentu(db: Db, settings: Prisma.JsonValue, o: OrderRow, pozycje: PozycjaZamowienia[]): Promise<Pick<WejsciePozycji, 'totalGross' | 'rabatMaksProcent' | 'pobranie' | 'paczkiDodatkowe' | 'rabatMatkiNaDokumencie'>> {
  const sufit = rabatMaksProcent(settings)
  const wspolne = { rabatMaksProcent: sufit, pobranie: o.paymentState === 'COD' }
  if (!o.parentOrderId) {
    const paczki = await db.order.count({ where: { parentOrderId: o.id } })
    return { totalGross: Number(o.totalGross), ...wspolne, ...(paczki ? { paczkiDodatkowe: true } : {}) }
  }
  const glowne = await db.order.findUnique({ where: { id: o.parentOrderId }, include: { lines: true } })
  const slG = glowne ? await slowniki(db, [glowne]) : null
  const rabatMatki = !!glowne && !!slG && rabatLiczonyNaDokumencie({ totalGross: Number(glowne.totalGross), kosztWysylki: kosztWysylkiZamowienia(glowne), pozycje: pozycjeZamowienia(glowne, slG.products, slG.offers), rabatMaksProcent: sufit })
  return { totalGross: kwotaPaczkiDodatkowej(pozycje), ...wspolne, ...(rabatMatki ? { rabatMatkiNaDokumencie: true } : {}) }
}

async function przygotuj(db: Db, settings: Prisma.JsonValue, o: OrderRow, sl: Awaited<ReturnType<typeof slowniki>>, opts: OpcjeKsef): Promise<WynikKsef> {
  const organizationId = organizationIdOf(db)
  const now = opts.now ?? new Date()
  const gdzie = { orderId: o.id, packageNo: o.packageNo, returnId: '' }
  const powod = powodNieDotyczy({ status: o.status, carrier: o.carrier, liczbaPozycji: o.lines.filter((l) => !l.removed).length })
  if (powod) {
    // stary szkic by kłamał (zamówienie mogło zostać anulowane); szkic z numerem zostaje
    await db.ksefInvoiceDraft.deleteMany({ where: { ...gdzie, numer: null } })
    return { wynik: 'nie_dotyczy', powod }
  }

  const cfgK = parseKonfiguracjaKsef(settings)
  const pozycje = pozycjeZamowienia(o, sl.products, sl.offers)
  const linie = linieKsef({ pozycje, wysylka: parseKonfiguracjaFaktur(settings).wysylka, kosztWysylki: kosztWysylkiZamowienia(o), ...(await wejscieDokumentu(db, settings, o, pozycje)) })
  const id = idSzkicu(organizationId, o.id, o.packageNo)
  const sklad = (nabywca: NabywcaFa3) =>
    zbudujFa3({
      numer: `SZKIC-${id}`,
      dataWystawienia: toWarsaw(now).day,
      wytworzono: now,
      waluta: 'PLN',
      rodzaj: 'VAT',
      sprzedawca: cfgK.sprzedawca ?? { nip: '', nazwa: '', adres: { kodKraju: 'PL', linia1: '' } },
      nabywca,
      wiersze: linie.wiersze,
      podstawaZwolnienia: cfgK.podstawaZwolnienia,
      systemInfo: 'Kompletor',
    })
  const fa = sklad({ nip: null, nazwa: NABYWCA_ZASTEPCZY })
  // nabywca z bazy sprawdzany osobnym złożeniem; z niego bierzemy tylko problemy nabywcy (kody, bez wartości)
  const nabywca = await nabywcaKsef(db, o.id)
  const problemyNabywcy = nabywca ? sklad(nabywca).problemy.filter((p) => p.pole?.startsWith('Podmiot2')) : []
  // braki sprzedawcy opisuje już konfiguracja; builder powtórzyłby je dla pustych pól
  const zBuildera = cfgK.sprzedawca ? fa.problemy : fa.problemy.filter((p) => !p.pole?.startsWith('Podmiot1'))
  const problemy = unikalne([...cfgK.problemy, ...linie.problemy, ...zBuildera, ...problemyNabywcy])
  const xml = problemy.length ? null : fa.xml
  const walidacja: WynikWalidacji | { stan: null; bledy: string[]; komunikat: string } = xml
    ? await walidujFa3(xml, opts.xsdDir ? { dir: opts.xsdDir } : {})
    : { stan: null, bledy: [], komunikat: 'Nie sprawdzono schematem: szkic ma problemy danych.' }
  const pozaKsef = !o.wantInvoiceNip && !cfgK.konsumenciDoKsef
  const status: StatusSzkicu = pozaKsef ? 'POZA_KSEF' : problemy.length || walidacja.stan === 'BLEDY' ? 'BLAD_WALIDACJI' : walidacja.stan === 'POPRAWNY' ? 'ODLOZONA' : 'ZLOZONA'

  const dane = {
    status,
    seriaKod: cfgK.seriaKod,
    wersjaSchemy: fa.wersjaSchemy,
    xml,
    xmlSha256: xml ? createHash('sha256').update(xml, 'utf8').digest('hex') : null,
    bruttoGr: linie.bruttoGr,
    nettoGr: linie.nettoGr,
    problems: problemy as unknown as Prisma.InputJsonValue,
    walidacja: walidacja as unknown as Prisma.InputJsonValue,
  }
  const wynik: WynikKsef = { wynik: 'przygotowana', id, orderId: o.id, packageNo: o.packageNo, status, problemy, nabywca: nabywca ? 'BAZA' : 'ZASTEPCZY' }
  // tylko wiersz bez numeru; z numerem = faktura zatwierdzona do wysyłki, której nic już nie zmienia
  if ((await db.ksefInvoiceDraft.updateMany({ where: { ...gdzie, numer: null }, data: dane })).count) return wynik
  if (await db.ksefInvoiceDraft.findFirst({ where: gdzie, select: { id: true } })) return { wynik: 'zablokowana', powod: 'Faktura ma już numer: szkic się nie zmienia.' }
  try {
    await db.ksefInvoiceDraft.create({ data: { id, organizationId, ...gdzie, ...dane } })
  } catch (e) {
    // równoległe przygotowanie tego samego zamówienia: drugi zapis nadpisuje pierwszy
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e
    if (!(await db.ksefInvoiceDraft.updateMany({ where: { ...gdzie, numer: null }, data: dane })).count) return { wynik: 'zablokowana', powod: 'Faktura ma już numer: szkic się nie zmienia.' }
  }
  return wynik
}

/** Szkic KSeF zamówienia (idempotentne). Firma z wFirmą: jawne „nie dotyczy”, bez zapisu. */
export async function prepareKsefForOrder(db: Db, orderId: string, opts: OpcjeKsef = {}): Promise<WynikKsef> {
  organizationIdOf(db)
  const org = await db.organization.findFirst({ select: { settings: true } })
  const program = programFaktur(org?.settings, { maWfirme: (await zrodloStanu(db)) === 'WFIRMA' })
  if (program !== 'ksef') return { wynik: 'nie_dotyczy', powod: program === 'brak' ? NIE_DOTYCZY_BRAK : NIE_DOTYCZY_WFIRMA }
  const o = await db.order.findUnique({ where: { id: orderId }, include: { lines: true } })
  if (!o) throw new BladKsef('Nie ma takiego zamówienia.')
  return przygotuj(db, org!.settings, o, await slowniki(db, [o]), opts)
}

// ─── Pętla dnia ──────────────────────────────────────────────────────────────

export interface PodgladKsefDnia {
  dzien: string
  /** false = firma z wFirmą: nic nie składano. */
  dotyczy: boolean
  zamowienia: number
  perStatus: Record<StatusSzkicu, number>
  /** Numery zamówień w kanale per status. */
  numery: Record<StatusSzkicu, string[]>
  nieDotyczy: number
  zablokowane: number
  /** Kod problemu → liczba zamówień. */
  problemy: Record<string, number>
  /** Numer zamówienia → kody problemów (bez danych klientów). */
  listaProblemow: { numerZamowienia: string; kody: string[] }[]
  bledy: string[]
}

/** Szkice KSeF zamówień złożonych w dniu (Europe/Warsaw); błąd jednego zamówienia nie zatrzymuje dnia. */
export async function prepareKsefDay(db: Db, opts: { dzien: string } & OpcjeKsef): Promise<PodgladKsefDnia> {
  organizationIdOf(db)
  const pusty = () => ({ ZLOZONA: 0, BLAD_WALIDACJI: 0, POZA_KSEF: 0, ODLOZONA: 0 })
  const r: PodgladKsefDnia = {
    dzien: opts.dzien,
    dotyczy: false,
    zamowienia: 0,
    perStatus: pusty(),
    numery: { ZLOZONA: [], BLAD_WALIDACJI: [], POZA_KSEF: [], ODLOZONA: [] },
    nieDotyczy: 0,
    zablokowane: 0,
    problemy: {},
    listaProblemow: [],
    bledy: [],
  }
  const org = await db.organization.findFirst({ select: { settings: true } })
  if (programFaktur(org?.settings) !== 'ksef') return r
  r.dotyczy = true
  const orders = await db.order.findMany({
    where: { createdAtChannel: { gte: fromWarsaw(opts.dzien, 0), lt: fromWarsaw(addDays(opts.dzien, 1), 0) } },
    include: { lines: true },
    orderBy: [{ createdAtChannel: 'asc' }, { id: 'asc' }],
  })
  r.zamowienia = orders.length
  if (!orders.length) return r
  const sl = await slowniki(db, orders)
  for (const o of orders) {
    try {
      const w = await przygotuj(db, org!.settings, o, sl, opts)
      if (w.wynik === 'nie_dotyczy') r.nieDotyczy++
      else if (w.wynik === 'zablokowana') r.zablokowane++
      else {
        r.perStatus[w.status]++
        r.numery[w.status].push(o.externalId)
        const kody = [...new Set(w.problemy.map((p) => p.kod))]
        for (const k of kody) r.problemy[k] = (r.problemy[k] ?? 0) + 1
        if (kody.length) r.listaProblemow.push({ numerZamowienia: o.externalId, kody })
      }
    } catch (e) {
      r.bledy.push(`zamówienie ${o.externalId}: ${opisBledu(e)}`)
    }
  }
  return r
}

// ─── Panel ───────────────────────────────────────────────────────────────────

export interface PodgladKsef {
  nieDotyczy: string | null
  zapisany: {
    status: StatusKsef
    numer: string | null
    bruttoGr: number
    nettoGr: number
    problemy: ProblemFa3[]
    walidacja: string | null
    przygotowano: Date
    /** wysyłka do KSeF. */
    id: string
    ksefNumer: string | null
    srodowisko: string | null
    lastError: string | null
    proby: number
    upo: boolean
  } | null
}

/** Blok w ekranie zamówienia; null = firma z wFirmą albo nie ma zamówienia (blok się nie pokazuje). */
export async function podgladKsef(db: Db, orderId: string): Promise<PodgladKsef | null> {
  organizationIdOf(db)
  const org = await db.organization.findFirst({ select: { settings: true } })
  if (programFaktur(org?.settings) !== 'ksef') return null
  const o = await db.order.findUnique({ where: { id: orderId }, select: { id: true, status: true, carrier: true, packageNo: true, lines: { where: { removed: false }, select: { id: true } } } })
  if (!o) return null
  const r = await db.ksefInvoiceDraft.findFirst({ where: { orderId, packageNo: o.packageNo, returnId: '' } })
  const problemy = r && Array.isArray(r.problems) ? (r.problems as unknown as ProblemFa3[]).filter((p) => p && typeof p.tekst === 'string') : []
  const wal = r?.walidacja && typeof r.walidacja === 'object' && !Array.isArray(r.walidacja) ? (r.walidacja as Record<string, unknown>) : {}
  return {
    nieDotyczy: powodNieDotyczy({ status: o.status, carrier: o.carrier, liczbaPozycji: o.lines.length }),
    zapisany: r
      ? {
          status: (STATUSY_KSEF as readonly string[]).includes(r.status) ? (r.status as StatusKsef) : 'BLAD_WALIDACJI',
          numer: r.numer,
          bruttoGr: r.bruttoGr,
          nettoGr: r.nettoGr,
          problemy,
          walidacja: typeof wal['komunikat'] === 'string' ? wal['komunikat'] : null,
          przygotowano: r.updatedAt,
          id: r.id,
          ksefNumer: r.ksefNumer,
          srodowisko: r.srodowisko,
          lastError: r.lastError,
          proby: r.proby,
          upo: !!r.upo,
        }
      : null,
  }
}

// ───: faktura do wysyłki ───────────────────────────────────────────

export type FakturaDoWysylki = { ok: true; xml: string; bruttoGr: number; nettoGr: number; wejscie: WejscieFa3 } | { ok: false; problemy: ProblemFa3[] }

/**
 * Prawdziwa faktura FA(3) do wysyłki: numer z serii, data wystawienia przydzielona przy pierwszej wysyłce, nabywca
 * z bazy (dane do faktury). XML trzymany tylko w pamięci, nigdy w bazie (dane klienta). Nabywca bez danych w bazie przy
 * fakturze na firmę = problem (bez NIP-u nabywcy faktura B2B nie ma sensu); osoba prywatna = `BrakID`.
 */
export async function zlozFaktureDoWysylki(db: Db, orderId: string, packageNo: number, n: { numer: string; dataWystawienia: string; now: Date }): Promise<FakturaDoWysylki> {
  const org = await db.organization.findFirst({ select: { settings: true } })
  const settings = org?.settings ?? null
  const o = await db.order.findUnique({ where: { id: orderId }, include: { lines: true } })
  if (!o) return { ok: false, problemy: [{ kod: 'brak-zamowienia', tekst: 'Nie ma takiego zamówienia.' }] }
  const sl = await slowniki(db, [o])
  const cfgK = parseKonfiguracjaKsef(settings)
  const pozycje = pozycjeZamowienia({ ...o, packageNo }, sl.products, sl.offers)
  const linie = linieKsef({ pozycje, wysylka: parseKonfiguracjaFaktur(settings).wysylka, kosztWysylki: kosztWysylkiZamowienia(o), ...(await wejscieDokumentu(db, settings, o, pozycje)) })
  const nabywca = await nabywcaKsef(db, o.id)
  const problemy: ProblemFa3[] = [...cfgK.problemy.filter((p) => p.kod !== 'brak-serii'), ...linie.problemy]
  if (!nabywca && o.wantInvoiceNip) problemy.push({ kod: 'brak-nabywcy', pole: 'Podmiot2', tekst: 'Brak danych nabywcy do faktury (NIP, nazwa, adres): uzupełnij je na karcie zamówienia.' })
  const wejscie: WejscieFa3 = {
    numer: n.numer,
    dataWystawienia: n.dataWystawienia,
    wytworzono: n.now,
    waluta: 'PLN',
    rodzaj: 'VAT',
    sprzedawca: cfgK.sprzedawca ?? { nip: '', nazwa: '', adres: { kodKraju: 'PL', linia1: '' } },
    nabywca: nabywca ?? { nip: null, nazwa: 'Osoba prywatna' },
    wiersze: linie.wiersze,
    podstawaZwolnienia: cfgK.podstawaZwolnienia,
    systemInfo: 'Kompletor',
  }
  const fa = zbudujFa3(wejscie)
  const wszystkie = unikalne([...problemy, ...(cfgK.sprzedawca ? fa.problemy : fa.problemy.filter((p) => !p.pole?.startsWith('Podmiot1')))])
  if (wszystkie.length || !fa.xml) return { ok: false, problemy: wszystkie }
  return { ok: true, xml: fa.xml, bruttoGr: linie.bruttoGr, nettoGr: linie.nettoGr, wejscie }
}
