// jednorazowe przeliczenie cen pozycji zamówień Woo zapisanych, które mają rabat na całe
// zamówienie spoza pozycji (ujemne `fee_lines`, np. program lojalnościowy sklepu). Adapter zapisywał cenę
// pozycji sprzed rabatu, a ponowny odczyt kanału jej nie poprawi (`updateOrder` nie zmienia ceny istniejących pozycji).
// Faktura liczy rabat sama na dokumencie, ale paczka dodatkowa, korekta zwrotu, zwrot za brak i raport sprzedaży biorą
// cenę pozycji, więc przed klonem stagingu na produkcję ceny muszą być po rabacie.
//
// Skąd dane: baza nie trzyma surowego zamówienia (kopia kanału `ChannelOrderSnapshot` ma tylko kwotę, liczbę pozycji
// i ostrzeżenia), więc każde zamówienie doczytujemy ze sklepu, TYLKO odczytem (`getOrderZRabatem`, GET /orders/{id}).
// Ceny przed i po rabacie liczy ta sama funkcja co adapter przy przyjęciu (`wooOrderZRabatem` → `rozlozRabatWoo`
// → `cenaPoRabacieGr`): zakres = zamówienia z ujemną opłatą w sklepie (nie `rabatLiczonyNaDokumencie`, który nie widzi
// rabatu przy pobraniu ≥ rabat ani poniżej progu 1%), rabat = suma ujemnych opłat (pobranie i inne opłaty dodatnie nie
// wchodzą do rachunku). Reszty groszy nie zapisujemy: dokument kładzie ją sam na pierwszą płatną pozycję, jak BL.
//
// Co zmienia: `OrderLine.unitPriceGross` pozycji z kanału, ich zamienników („Zamień produkt”, ta sama cena co pozycja
// pierwotna) i pozycji paczek dodatkowych (ta sama cena co pozycja matki), `Order.shippingCostGross` tam, gdzie go
// brak, i wpis w historii zamówienia. Nic poza tym: bez rezerwacji, stanu, statusu, rewizji, kwoty zamówienia i bez
// dokumentów już wystawionych.
//
// Bezpieczniki: zamówienie zmienione w Kompletorze (edycja pozycji), kwota albo pozycje inne niż w sklepie, cena pozycji
// ani sprzed, ani po rabacie = pominięte z powodem (do ręcznego sprawdzenia), bez zgadywania. Koszt wysyłki ze sklepu
// wpisujemy tylko zamówieniu zgodnemu ze sklepem (te same sprawdzenia, kwota porównana PRZED powrotem
// „bez rabatu”), z wpisem w historii także wtedy, gdy ceny się nie zmieniają. Zamówienie do zmiany z dokumentem
// wystawionym przez Kompletor (wFirma albo KSeF, także szkic) idzie na listę ręczną, a `--wykonaj` z takim zamówieniem
// w zakresie nie zapisuje niczego (korekta liczyłaby z nowej ceny, a dokument ma starą). Idempotentne: cena już po
// rabacie = bez zmiany, drugi przebieg nic nie zapisuje. Każde zamówienie osobno: błąd albo limit czasu odczytu jednego
// trafia do podsumowania, reszta leci. Zapis pod blokadą zamówienia i jego paczek dodatkowych (zawsze matka, potem
// paczki rosnąco po id), plan liczony drugi raz po blokadzie.
import type { PrismaClient } from '@prisma/client'
import { AdapterError, UnreadableDataError } from '../adaptery/kontrakt'
import type { ZamowienieWooZRabatem } from '../adaptery/woo'
import { flagsOf } from '../rdzen/rezerwacja'
import { advisoryLock, orderLockKey, runTx } from '../rdzen/stan'
import { czyZamiennik, pozycjaPierwotnaZamiany } from '../rdzen/zamiana'

export const ZDARZENIE_RABATU = 'RABAT_ROZLOZONY'
/** Runda 2: samo uzupełnienie kosztu wysyłki ze sklepu, bez zmiany cen. */
export const ZDARZENIE_KOSZTU = 'KOSZT_WYSYLKI_ZE_SKLEPU'
const AKTOR = 'system:przeliczenie-rabatu'

export type PowodPominiecia =
  | 'bez-rabatu'
  | 'rabat-nierozlozony'
  /** rabat w granicach reszty zaokrągleń; dokument dokłada go sam, nic do zrobienia (nie idzie na listę ręczną) */
  | 'rabat-w-zaokragleniach'
  | 'edytowane-w-kompletorze'
  | 'kwota-inna-niz-w-sklepie'
  | 'pozycje-inne-niz-w-sklepie'
  | 'cena-inna-niz-w-sklepie'
  | 'zamiennik-z-inna-cena'
  | 'paczka-z-inna-cena'
  | 'paczki-zagniezdzone'
  /** zamówienie do zmiany ma dokument wystawiony przez Kompletor (wFirma albo KSeF, także szkic) */
  | 'z-dokumentem-kompletora'

/** Powody, przy których zamówienie jest zgodne ze sklepem (tylko wtedy wolno wpisać koszt wysyłki ze sklepu). */
const ZGODNE_ZE_SKLEPEM: ReadonlySet<PowodPominiecia> = new Set(['bez-rabatu', 'rabat-nierozlozony', 'rabat-w-zaokragleniach'])
/** Powody, które nie wymagają ręcznego sprawdzenia (nie trafiają na listę „pominięte”). */
const BEZ_RECZNEGO: ReadonlySet<PowodPominiecia> = new Set(['bez-rabatu', 'rabat-w-zaokragleniach'])

export interface LiniaStanu {
  id: string
  externalLineId: string
  qty: number
  qtyChannel: number | null
  /** grosze */
  cenaGr: number
  removed: boolean
}

export interface StanZamowienia {
  id: string
  totalGr: number
  /** grosze; null = brak kosztu wysyłki w zamówieniu */
  kosztWysylkiGr: number | null
  edytowaneLokalnie: boolean
  linie: LiniaStanu[]
  paczki: { id: string; linie: LiniaStanu[]; maWlasnePaczki: boolean }[]
}

export interface ZmianaCeny {
  orderId: string
  lineId: string
  rodzaj: 'kanal' | 'zamiennik' | 'paczka'
  zGr: number
  naGr: number
  /** sztuki oferty pozycji z kanału (do sumy różnic); 0 dla zamienników i paczek (już w pozycji z kanału) */
  sztukOferty: number
}

export interface PlanPrzeliczenia {
  /** koszt wysyłki do wpisania (grosze): zamówienie go nie ma, sklep podaje, a zamówienie jest zgodne ze sklepem; inaczej null */
  kosztWysylkiGr: number | null
  /** sklep podaje koszt, zamówienie go nie ma, ale jest niezgodne ze sklepem (powód); koszt NIE jest wpisywany */
  kosztWysylkiNieuzupelniony: PowodPominiecia | null
  /** koszt w zamówieniu inny niż w sklepie (bez zmiany, tylko do podsumowania) */
  kosztWysylkiInny: boolean
  rabatGr: number
  zmiany: ZmianaCeny[]
  juzPrzeliczone: boolean
  powod: PowodPominiecia | null
  /** ostrzeżenie adaptera przy rabacie, którego reguła nie rozkłada (ponad limit, w granicach zaokrągleń, 0 zł) */
  ostrzezenie: string | null
  /** Σ cena × sztuki oferty pozycji z kanału przed i po planie (grosze) */
  towaryPrzedGr: number
  towaryPoGr: number
}

const gr = (zl: number) => Math.round(zl * 100)

/**
 * Plan dla jednego zamówienia (czysta funkcja). `dane` = odczyt sklepu przez adapter (ceny przed i po rabacie tą samą
 * regułą co przy przyjęciu). Zmiana cen tylko, gdy KAŻDA pozycja z kanału ma dziś cenę sprzed rabatu (albo cena przed
 * = po), zamienniki mają cenę pozycji pierwotnej, a pozycje paczek dodatkowych cenę pozycji matki.
 */
export function planPrzeliczenia(stan: StanZamowienia, dane: ZamowienieWooZRabatem): PlanPrzeliczenia {
  const sklepKosztGr = dane.order.shippingCostGross === null || dane.order.shippingCostGross === undefined ? null : gr(dane.order.shippingCostGross)
  const kandydatKosztu = stan.kosztWysylkiGr === null && sklepKosztGr !== null ? sklepKosztGr : null
  const sklep = new Map(dane.order.lines.map((l) => [l.externalLineId, { qty: l.qty, poGr: gr(l.unitPriceGross), przedGr: gr(dane.cenyPrzedRabatem[l.externalLineId] ?? Number.NaN) }]))
  const aktywne = stan.linie.filter((l) => !l.removed)
  const zKanalu = aktywne.filter((l) => !l.externalLineId.includes('#'))
  const zamienniki = aktywne.filter((l) => czyZamiennik(l.externalLineId))
  const towary = (cena: (l: LiniaStanu) => number) => zKanalu.reduce((s, l) => s + cena(l) * (l.qtyChannel ?? l.qty), 0)

  const wynik = (powod: PowodPominiecia | null, zmiany: ZmianaCeny[] = []): PlanPrzeliczenia => {
    // koszt ze sklepu tylko dla zamówienia zgodnego ze sklepem (nieedytowane, ta sama kwota, pozycje i ceny)
    const zgodne = powod === null || ZGODNE_ZE_SKLEPEM.has(powod)
    const na = new Map(zmiany.filter((z) => z.rodzaj === 'kanal').map((z) => [z.lineId, z.naGr]))
    return {
      kosztWysylkiGr: zgodne ? kandydatKosztu : null,
      kosztWysylkiNieuzupelniony: !zgodne && kandydatKosztu !== null ? powod : null,
      kosztWysylkiInny: stan.kosztWysylkiGr !== null && sklepKosztGr !== null && stan.kosztWysylkiGr !== sklepKosztGr,
      rabatGr: dane.rabatGr,
      zmiany,
      juzPrzeliczone: powod === null && zmiany.length === 0,
      powod,
      ostrzezenie: null,
      towaryPrzedGr: towary((l) => l.cenaGr),
      towaryPoGr: towary((l) => na.get(l.id) ?? l.cenaGr),
    }
  }

  // zgodność ze sklepem: liczona PRZED rozróżnieniem „bez rabatu”, bo od niej zależy też wpis kosztu wysyłki
  const niezgodnosc = ((): PowodPominiecia | null => {
    if (stan.edytowaneLokalnie) return 'edytowane-w-kompletorze'
    if (stan.totalGr !== gr(dane.order.totalGross)) return 'kwota-inna-niz-w-sklepie'
    if (aktywne.length !== zKanalu.length + zamienniki.length) return 'pozycje-inne-niz-w-sklepie'
    if (zKanalu.length !== sklep.size || zKanalu.some((l) => !sklep.has(l.externalLineId) || (l.qtyChannel ?? l.qty) !== sklep.get(l.externalLineId)!.qty)) return 'pozycje-inne-niz-w-sklepie'
    if ([...sklep.values()].some((s) => !Number.isFinite(s.przedGr))) return 'pozycje-inne-niz-w-sklepie'
    // każda pozycja z kanału: cena sprzed rabatu, już po rabacie, oba naraz (przed = po); stan mieszany = stop
    let przed = 0
    let po = 0
    for (const l of zKanalu) {
      const s = sklep.get(l.externalLineId)!
      if (s.przedGr === s.poGr && l.cenaGr === s.poGr) continue
      if (l.cenaGr === s.przedGr) przed++
      else if (l.cenaGr === s.poGr) po++
      else return 'cena-inna-niz-w-sklepie'
    }
    return przed && po ? 'cena-inna-niz-w-sklepie' : null
  })()

  if (dane.rabatGr <= 0) {
    // bez rabatu: ceny bez zmian; koszt wysyłki tylko zgodnemu (inaczej powód w `kosztWysylkiNieuzupelniony`)
    const p = wynik(niezgodnosc ?? 'bez-rabatu')
    return { ...p, powod: 'bez-rabatu' }
  }
  if (niezgodnosc) return wynik(niezgodnosc)
  if ([...sklep.values()].every((s) => s.przedGr === s.poGr)) {
    const ostrzezenie = dane.order.warnings.find((w) => w.includes('opłata ujemna')) ?? null
    return { ...wynik(dane.rozklad === 'zaokraglenia' ? 'rabat-w-zaokragleniach' : 'rabat-nierozlozony'), ostrzezenie }
  }

  const nowa = new Map<string, number>() // externalLineId → cena po rabacie (grosze)
  const stara = new Map<string, number>() // externalLineId → cena dziś (grosze)
  const zmiany: ZmianaCeny[] = []
  for (const l of zKanalu) {
    const s = sklep.get(l.externalLineId)!
    nowa.set(l.externalLineId, s.poGr)
    stara.set(l.externalLineId, l.cenaGr)
    if (l.cenaGr !== s.poGr) zmiany.push({ orderId: stan.id, lineId: l.id, rodzaj: 'kanal', zGr: l.cenaGr, naGr: s.poGr, sztukOferty: s.qty })
  }
  // zamiennik ma cenę pozycji pierwotnej: ta sama cena po rabacie, inaczej faktura stanie na zamianie
  for (const l of zamienniki) {
    const baza = pozycjaPierwotnaZamiany(l.externalLineId)
    if (baza === null || !nowa.has(baza)) return wynik('zamiennik-z-inna-cena')
    if (l.cenaGr === nowa.get(baza)!) continue
    if (l.cenaGr !== stara.get(baza)!) return wynik('zamiennik-z-inna-cena')
    zmiany.push({ orderId: stan.id, lineId: l.id, rodzaj: 'zamiennik', zGr: l.cenaGr, naGr: nowa.get(baza)!, sztukOferty: 0 })
  }
  // pozycje paczek dodatkowych mają cenę pozycji matki (podział, „dośle później”): ten sam mnożnik
  for (const p of stan.paczki) {
    if (p.maWlasnePaczki) return wynik('paczki-zagniezdzone')
    for (const l of p.linie) {
      if (l.removed) continue
      const baza = l.externalLineId.split('#')[0]!
      if (!nowa.has(baza)) return wynik('paczka-z-inna-cena')
      if (l.cenaGr === nowa.get(baza)!) continue
      if (l.cenaGr !== stara.get(baza)!) return wynik('paczka-z-inna-cena')
      zmiany.push({ orderId: p.id, lineId: l.id, rodzaj: 'paczka', zGr: l.cenaGr, naGr: nowa.get(baza)!, sztukOferty: 0 })
    }
  }
  return wynik(null, zmiany)
}

// ─── Baza ─────────────────────────────────────────────────────────────────────

/** Odczyt zamówienia ze sklepu (adapter konta, tylko GET); null = zamówienia nie ma w sklepie. */
export type CzytajZamowienieWoo = (channelAccountId: string, externalId: string) => Promise<ZamowienieWooZRabatem | null>

/** Domyślne tempo odczytu sklepu (sklep bywa wolny; osłona konta i tak pilnuje własnego limitu). */
export const DOMYSLNY_LIMIT_NA_MINUTE = 60
/** Domyślny limit czasu odczytu jednego zamówienia; po nim zamówienie jest pomijane z powodem, przebieg leci dalej. */
export const DOMYSLNY_LIMIT_CZASU_MS = 60_000

export interface OpcjePrzeliczenia {
  naSucho: boolean
  /** zamówienia z datą w kanale od (włącznie); brak = wszystkie zamówienia Woo firmy */
  od?: Date
  /** do (bez) */
  do?: Date
  channelAccountId?: string
  /** najwyżej tyle odczytów sklepu na minutę (domyślnie DOMYSLNY_LIMIT_NA_MINUTE) */
  limitNaMinute?: number
  /** limit czasu odczytu jednego zamówienia, ms (domyślnie DOMYSLNY_LIMIT_CZASU_MS) */
  limitCzasuMs?: number
  /** testy: zegar odstępów między odczytami */
  czekaj?: (ms: number) => Promise<void>
  /** testy: wołane po odczycie wszystkich zamówień, przed zapisem (np. zmiana zamówienia „w międzyczasie”) */
  przedZapisem?: () => Promise<void>
}

export interface ZamowienieDoZmiany {
  orderId: string
  /** Σ cena × sztuki oferty pozycji z kanału przed i po (grosze) */
  towaryPrzedGr: number
  towaryPoGr: number
  /** koszt wysyłki do uzupełnienia (grosze) albo null */
  kosztWysylkiGr: number | null
  pozycji: number
}

export interface WynikPrzeliczenia {
  naSucho: boolean
  zamowien: number
  odczytanych: number
  brakWSklepie: number
  zRabatem: number
  /** zamówienia, w których przebieg zmieniłby ceny (z odczytu, przed zapisem) */
  doPrzeliczenia: number
  /** zamówienia, w których zapis zmienił ceny */
  przeliczone: number
  juzPrzeliczone: number
  /** rabat w granicach reszty zaokrągleń, bez zmian (dokument dokłada sam) */
  bezZmianGrosze: string[]
  pozycjiKanalu: number
  pozycjiZamiennikow: number
  pozycjiPaczek: number
  /** Σ (cena dziś − cena po rabacie) × sztuki oferty pozycji z kanału, grosze */
  sumaRoznicGr: number
  /** Σ rabatu z opłat ujemnych zamówień do przeliczenia, grosze (kontrola: ≈ sumaRoznicGr, różnica = reszta groszy) */
  sumaRabatuGr: number
  pobranie: number
  /** zamówienia do zmiany z dokumentem Kompletora (wFirma albo KSeF, także szkic): lista ręczna, blokuje --wykonaj */
  zFakturaKompletora: string[]
  zFakturaBl: number
  /** zamówienia do zapisu (ceny albo sam koszt wysyłki) z kwotami towarów przed i po */
  doZmiany: ZamowienieDoZmiany[]
  /** zamówienia, którym sklep podaje koszt wysyłki do uzupełnienia (z odczytu) */
  kosztWysylkiDoUzupelnienia: number
  /** zamówienia, którym zapis uzupełnił koszt wysyłki */
  kosztWysylkiUzupelniony: number
  kosztWysylkiInny: number
  /** koszt w sklepie jest, w zamówieniu brak, ale zamówienie niezgodne ze sklepem: koszt NIE wpisany */
  kosztWysylkiNieuzupelniony: Partial<Record<PowodPominiecia, string[]>>
  pominiete: Partial<Record<PowodPominiecia, string[]>>
  /** odczyt sklepu przekroczył limit czasu: zamówienie pominięte (następny przebieg je weźmie) */
  limitCzasu: string[]
  /** plan zmienił się między odczytem a blokadą: zapisane według planu spod blokady (powód, gdy nic) */
  zmienioneWTrakcie: { orderId: string; powod: string }[]
  /** --wykonaj odmówione (nic nie zapisane): powód */
  odmowa: string | null
  bledy: { orderId: string; powod: string }[]
}

const LINIA = { id: true, externalLineId: true, qty: true, qtyChannel: true, unitPriceGross: true, removed: true } as const
type LiniaDb = { id: string; externalLineId: string; qty: number; qtyChannel: number | null; unitPriceGross: { toString(): string }; removed: boolean }
const linia = (l: LiniaDb): LiniaStanu => ({ id: l.id, externalLineId: l.externalLineId, qty: l.qty, qtyChannel: l.qtyChannel, cenaGr: gr(Number(l.unitPriceGross.toString())), removed: l.removed })

type Db = Pick<PrismaClient, 'order' | 'orderLine' | 'orderEvent' | 'invoiceAttempt' | 'ksefInvoiceDraft'>

async function wczytajStan(db: Db, orderId: string): Promise<StanZamowienia | null> {
  const o = await db.order.findUnique({ where: { id: orderId }, select: { id: true, totalGross: true, shippingCostGross: true, flags: true, lines: { select: LINIA } } })
  if (!o) return null
  const dzieci = await db.order.findMany({ where: { parentOrderId: o.id }, select: { id: true, lines: { select: LINIA } }, orderBy: { id: 'asc' } })
  const wnuki = dzieci.length ? await db.order.findMany({ where: { parentOrderId: { in: dzieci.map((d) => d.id) } }, select: { parentOrderId: true } }) : []
  return {
    id: o.id,
    totalGr: gr(Number(o.totalGross)),
    kosztWysylkiGr: o.shippingCostGross === null ? null : gr(Number(o.shippingCostGross)),
    edytowaneLokalnie: flagsOf(o).edytowaneLokalnie === true,
    linie: o.lines.map(linia),
    paczki: dzieci.map((d) => ({ id: d.id, linie: d.lines.map(linia), maWlasnePaczki: wnuki.some((w) => w.parentOrderId === d.id) })),
  }
}

/** dokumenty wystawione przez Kompletor (wFirma: wystawiony albo w drodze; KSeF: faktura w każdym stanie, także szkic). */
async function dokumentyKompletora(db: Db, orderIds: string[]): Promise<number> {
  const wf = await db.invoiceAttempt.count({ where: { orderId: { in: orderIds }, state: { in: ['ISSUED', 'SENDING', 'UNKNOWN'] } } })
  const ksef = await db.ksefInvoiceDraft.count({ where: { orderId: { in: orderIds }, returnId: '' } })
  return wf + ksef
}

const zl = (g: number) => (g / 100).toFixed(2)
const doZapisu = (p: PlanPrzeliczenia) => p.zmiany.length > 0 || p.kosztWysylkiGr !== null
const zamowieniaPlanu = (orderId: string, p: PlanPrzeliczenia) => [...new Set([orderId, ...p.zmiany.map((z) => z.orderId)])]

class LimitCzasu extends Error {}

async function zLimitemCzasu<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined
  p.catch(() => undefined) // spóźniony błąd po limicie nie może wywalić procesu
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => (t = setTimeout(() => rej(new LimitCzasu()), ms)))])
  } finally {
    if (t) clearTimeout(t)
  }
}

/** Rodzaj błędu bez treści: komunikaty adaptera niosą numery zamówień sklepu, odpowiedzi sklepu nie cytujemy wcale. */
function rodzajBledu(e: unknown): string {
  if (e instanceof UnreadableDataError) return 'nieczytelne dane sklepu'
  if (e instanceof AdapterError) return `odczyt sklepu nie powiódł się (${e.kind})`
  if (e instanceof Error) return `${e.name}: ${e.message}`.slice(0, 200)
  return 'nieznany błąd'
}

/**
 * Przebieg po zamówieniach Woo konta (albo wszystkich kont Woo firmy), opcjonalnie od/do daty: najpierw odczyt sklepu
 * i plan dla wszystkich (tempo `limitNaMinute`, limit czasu na zamówienie), potem zapis (poza trybem na sucho). Zapis
 * nie rusza, gdy któreś zamówienie do zmiany ma dokument Kompletora. Klient bazy firmy (RLS), więc tylko jej zamówienia;
 * paczki dodatkowe idą razem z zamówieniem głównym.
 */
export async function przeliczRabatyWoo(db: PrismaClient, czytaj: CzytajZamowienieWoo, opts: OpcjePrzeliczenia): Promise<WynikPrzeliczenia> {
  const w: WynikPrzeliczenia = {
    naSucho: opts.naSucho,
    zamowien: 0,
    odczytanych: 0,
    brakWSklepie: 0,
    zRabatem: 0,
    doPrzeliczenia: 0,
    przeliczone: 0,
    juzPrzeliczone: 0,
    bezZmianGrosze: [],
    pozycjiKanalu: 0,
    pozycjiZamiennikow: 0,
    pozycjiPaczek: 0,
    sumaRoznicGr: 0,
    sumaRabatuGr: 0,
    pobranie: 0,
    zFakturaKompletora: [],
    zFakturaBl: 0,
    doZmiany: [],
    kosztWysylkiDoUzupelnienia: 0,
    kosztWysylkiUzupelniony: 0,
    kosztWysylkiInny: 0,
    kosztWysylkiNieuzupelniony: {},
    pominiete: {},
    limitCzasu: [],
    zmienioneWTrakcie: [],
    odmowa: null,
    bledy: [],
  }
  const limitNaMinute = opts.limitNaMinute ?? DOMYSLNY_LIMIT_NA_MINUTE
  if (!Number.isFinite(limitNaMinute) || limitNaMinute <= 0) throw new Error('limit odczytów na minutę: liczba dodatnia')
  const odstepMs = Math.ceil(60_000 / limitNaMinute)
  const limitCzasuMs = opts.limitCzasuMs ?? DOMYSLNY_LIMIT_CZASU_MS
  const czekaj = opts.czekaj ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  const data = opts.od || opts.do ? { createdAtChannel: { ...(opts.od ? { gte: opts.od } : {}), ...(opts.do ? { lt: opts.do } : {}) } } : {}
  const lista = await db.order.findMany({
    where: {
      channel: 'WOO',
      parentOrderId: null,
      NOT: { externalId: { contains: '#' } },
      ...data,
      ...(opts.channelAccountId ? { channelAccountId: opts.channelAccountId } : {}),
    },
    select: { id: true, organizationId: true, channel: true, channelAccountId: true, externalId: true, paymentState: true },
    orderBy: { createdAtChannel: 'asc' },
  })
  w.zamowien = lista.length

  // ── 1. Odczyt sklepu i plan (bez zapisu) ──
  const kolejka: { o: (typeof lista)[number]; dane: ZamowienieWooZRabatem }[] = []
  let ostatniOdczyt: number | null = null
  for (const o of lista) {
    try {
      if (ostatniOdczyt !== null) {
        const zostalo = odstepMs - (Date.now() - ostatniOdczyt)
        if (zostalo > 0) await czekaj(zostalo)
      }
      ostatniOdczyt = Date.now()
      let dane: ZamowienieWooZRabatem | null
      try {
        dane = await zLimitemCzasu(czytaj(o.channelAccountId, o.externalId), limitCzasuMs)
      } catch (e) {
        if (e instanceof LimitCzasu) {
          w.limitCzasu.push(o.id)
          continue
        }
        throw e
      }
      if (!dane) {
        w.brakWSklepie++
        continue
      }
      w.odczytanych++
      const stan = await wczytajStan(db, o.id)
      if (!stan) throw new Error('zamówienie zniknęło z bazy w trakcie przebiegu')
      const plan = planPrzeliczenia(stan, dane)
      if (plan.rabatGr > 0) w.zRabatem++
      if (plan.kosztWysylkiInny) w.kosztWysylkiInny++
      if (plan.kosztWysylkiNieuzupelniony) (w.kosztWysylkiNieuzupelniony[plan.kosztWysylkiNieuzupelniony] ??= []).push(o.id)
      if (plan.powod === 'rabat-w-zaokragleniach') w.bezZmianGrosze.push(o.id)
      if (plan.powod && !BEZ_RECZNEGO.has(plan.powod)) (w.pominiete[plan.powod] ??= []).push(o.id)
      if (plan.juzPrzeliczone && plan.kosztWysylkiGr === null) w.juzPrzeliczone++
      if (!doZapisu(plan)) continue
      // twardy bezpiecznik: dokument Kompletora = lista ręczna (korekta z nowej ceny nie zgodzi się z dokumentem)
      if (await dokumentyKompletora(db, zamowieniaPlanu(o.id, plan))) {
        // sam koszt wysyłki przy wystawionym dokumencie: nie wpisujemy (nic do korekty), ale bez blokady przebiegu
        if (!plan.zmiany.length) {
          ;(w.kosztWysylkiNieuzupelniony['z-dokumentem-kompletora'] ??= []).push(o.id)
          continue
        }
        w.zFakturaKompletora.push(o.id)
        ;(w.pominiete['z-dokumentem-kompletora'] ??= []).push(o.id)
        continue
      }
      w.doZmiany.push({ orderId: o.id, towaryPrzedGr: plan.towaryPrzedGr, towaryPoGr: plan.towaryPoGr, kosztWysylkiGr: plan.kosztWysylkiGr, pozycji: plan.zmiany.length })
      if (plan.kosztWysylkiGr !== null) w.kosztWysylkiDoUzupelnienia++
      if (plan.zmiany.length) {
        w.doPrzeliczenia++
        w.sumaRabatuGr += plan.rabatGr
        for (const z of plan.zmiany) {
          if (z.rodzaj === 'kanal') w.pozycjiKanalu++
          else if (z.rodzaj === 'zamiennik') w.pozycjiZamiennikow++
          else w.pozycjiPaczek++
          w.sumaRoznicGr += (z.zGr - z.naGr) * z.sztukOferty
        }
        if (o.paymentState === 'COD') w.pobranie++
        if (await db.orderEvent.count({ where: { orderId: o.id, kind: 'FAKTURA_BL' } })) w.zFakturaBl++
      }
      kolejka.push({ o, dane })
    } catch (e) {
      w.bledy.push({ orderId: o.id, powod: rodzajBledu(e) })
    }
  }
  if (opts.naSucho) return w
  if (w.zFakturaKompletora.length) {
    w.odmowa = `w zakresie są zamówienia do zmiany z dokumentem wystawionym przez Kompletor (${w.zFakturaKompletora.length}): nic nie zapisano, najpierw ręczne sprawdzenie albo węższy zakres`
    return w
  }
  await opts.przedZapisem?.()

  // ── 2. Zapis: każde zamówienie osobno, pod blokadą matki i paczek, plan liczony drugi raz ──
  for (const { o, dane } of kolejka) {
    try {
      const wynik = await runTx(db, async (tx) => {
        await advisoryLock(tx, orderLockKey(o))
        // paczki dodatkowe też pod blokadą, zawsze po matce i rosnąco po id (stała kolejność = bez zakleszczeń)
        const paczki = await tx.order.findMany({ where: { parentOrderId: o.id }, select: { id: true, organizationId: true, channel: true, channelAccountId: true, externalId: true }, orderBy: { id: 'asc' } })
        for (const p of paczki) await advisoryLock(tx, orderLockKey(p))
        const swiezy = await wczytajStan(tx, o.id)
        if (!swiezy) throw new Error('zamówienie zniknęło z bazy w trakcie przebiegu')
        const p = planPrzeliczenia(swiezy, dane)
        if (!doZapisu(p)) return { p, zapisane: false, powod: p.powod ?? 'bez zmian' }
        if (await dokumentyKompletora(tx, zamowieniaPlanu(o.id, p))) return { p, zapisane: false, powod: 'z-dokumentem-kompletora' }
        for (const z of p.zmiany) await tx.orderLine.update({ where: { id: z.lineId }, data: { unitPriceGross: zl(z.naGr) } })
        if (p.kosztWysylkiGr !== null) await tx.order.update({ where: { id: o.id }, data: { shippingCostGross: zl(p.kosztWysylkiGr) } })
        const zmienione = new Set(p.zmiany.map((z) => z.orderId))
        for (const orderId of zmienione) {
          const pozycje = p.zmiany.filter((z) => z.orderId === orderId).map((z) => ({ lineId: z.lineId, z: zl(z.zGr), na: zl(z.naGr) }))
          await tx.orderEvent.create({ data: { orderId, kind: ZDARZENIE_RABATU, actorId: AKTOR, data: { rabat: zl(p.rabatGr), pozycje, ...(orderId === o.id && p.kosztWysylkiGr !== null ? { kosztWysylki: zl(p.kosztWysylkiGr) } : {}) } } })
        }
        // samo uzupełnienie kosztu (bez zmiany cen zamówienia głównego) też zostawia ślad w historii
        if (p.kosztWysylkiGr !== null && !zmienione.has(o.id)) await tx.orderEvent.create({ data: { orderId: o.id, kind: ZDARZENIE_KOSZTU, actorId: AKTOR, data: { kosztWysylki: zl(p.kosztWysylkiGr) } } })
        return { p, zapisane: true, powod: null }
      })
      if (!wynik.zapisane) {
        w.zmienioneWTrakcie.push({ orderId: o.id, powod: wynik.powod! })
        continue
      }
      if (wynik.p.zmiany.length) w.przeliczone++
      if (wynik.p.kosztWysylkiGr !== null) w.kosztWysylkiUzupelniony++
    } catch (e) {
      w.bledy.push({ orderId: o.id, powod: rodzajBledu(e) })
    }
  }
  return w
}
