// import archiwum zamówień (zamówienia sprzed odczytu kanału przez Kompletora) do `ArchivedOrder`, jeden
// szkielet dla wszystkich źródeł (`ZrodloArchiwum`): Woo (etap 1), Allegro z API i ze zrzutu, Empik (OR11), EasyTools
// z pliku (etap 2, lib/archiwum/zrodla.ts). Uruchamiany poleceniem CLI na żądanie (scripts/archiwum.ts), nigdy przez worker.
//
// Zasady:
//  - kanał tylko czytany (GET listy zamówień; Woo z `_fields` bez danych klienta, Allegro i Empik przycinane do listy
//    dozwolonych pól zaraz po odczycie, lib/archiwum/woo.ts i lib/archiwum/kanaly.ts);
//  - idempotentnie: upsert po (firma, kanał, konto, id zamówienia w kanale); zamówienie z tą samą rewizją sklepu
//    zostaje bez zmian; pozycje zamówienia zastępowane w całości w tej samej transakcji;
//  - wznawialnie: kursor (ostatnia zapisana strona) w `ImportRun.stats`; ponowne uruchomienie z tym samym kontem
//    i zakresem dat bierze przerwany przebieg i zaczyna od ostatniej strony (jedna strona zakładki, upsert dubli nie robi);
//  - partiami po stronie listy (domyślnie 100 zamówień), każde zamówienie w osobnym `try`: zły rekord trafia do
//    `ImportIssue` z powodem, reszta idzie dalej;
//  - rozłączność z `Order` (warunek testowany w tests/archiwum-import.integration.test.ts):
//      (1) górna granica zakresu = `ChannelCursor.coverageFrom` konta (od kiedy Kompletor sam czyta kanał);
//          `--do` późniejsze niż ta chwila jest przycinane, a konto bez `coverageFrom` wymaga jawnego `--do`;
//      (2) zamówienie, które ma już wiersz `Order` z tym samym kluczem kanału (np. otwarte przeniesione przeprowadzką),
//          nie trafia do archiwum (powód „jest w Kompletorze”); reguła wiązania w lib/archiwum/rozlacznosc.ts;
//      (3) raport i tak dołącza archiwum warunkiem NOT EXISTS `Order` (lib/api/raporty-sprzedaz.ts), więc zamówienie
//          przyjęte później przez odczyt kanału nie liczy się podwójnie;
//  - `--na-sucho`: zero zapisów w bazie (także bez `ImportRun`), wynik tylko na ekranie;
//  - bez danych klientów (etap 4), bez pola płatności; w raporcie i błędach tylko liczby, id zamówień w kanale i powody.
import type { PrismaClient } from '@prisma/client'
import { Prisma } from '@prisma/client'
import type { Channel } from '@prisma/client'
import { organizationIdOf } from '../db'
import { jestWKompletorze, kandydaciOrder } from './rozlacznosc'
import { archiwumZWoo, bezDanychOsobowych, type WynikMapowaniaWoo, type ZamowienieArchiwum } from './woo'

export const ARCHIWUM_WOO_RUN_KIND = 'archiwum-woo'
export const ZRODLO_WOO = 'WOO_API'
export const NA_STRONE_DOMYSLNIE = 100

export interface StronaZamowien {
  zamowienia: Record<string, unknown>[]
  /** liczba zamówień w zakresie wg źródła (Woo: X-WP-Total, Allegro: totalCount, OR11: total_count, plik: cały plik) */
  razem: number | null
  /** liczba stron wg źródła (Woo: X-WP-TotalPages), null = nieznana */
  stron: number | null
}
export type StronaZamowienWoo = StronaZamowien

/** Odczyt jednej strony listy zamówień złożonych w [od, do) (UTC), od najstarszych. */
export type CzytajStrone = (q: { od: Date; do: Date; strona: number; naStrone: number }) => Promise<StronaZamowien>
export type CzytajStroneWoo = CzytajStrone

/** Źródło archiwum: kanał, oznaczenie źródła w wierszu, rodzaj przebiegu, czytnik stron i mapowanie zamówienia. */
export interface ZrodloArchiwum {
  channel: Channel
  /** `ArchivedOrder.source`: WOO_API | ALLEGRO_API | ALLEGRO_ZRZUT | MIRAKL_API | EASYTOOLS_API */
  source: string
  /** `ImportRun.kind` (wznowienie szuka przerwanego przebiegu tego rodzaju) */
  runKind: string
  /** nazwa w raporcie przebiegu */
  etykieta: string
  czytaj: CzytajStrone
  /** przycięcie odpowiedzi do pól dozwolonych, zanim cokolwiek ją przeczyta */
  oczysc: (raw: Record<string, unknown>) => Record<string, unknown>
  mapuj: (raw: Record<string, unknown>) => WynikMapowaniaWoo
  /** id zamówienia w surowym rekordzie (do błędów mapowania) */
  idSurowe: (raw: Record<string, unknown>) => string | null
  /** największa strona źródła (domyślnie 100) */
  maksNaStrone?: number
  /**
   * rewizja = chwila zmiany w kanale (ISO, UTC): wiersz nadpisujemy tylko nowszą rewizją, więc starszy zrzut nie cofa
   * danych pobranych wcześniej z API; bez tej flagi każda inna rewizja nadpisuje (Woo)
   */
  rewizjaCzasem?: boolean
  /** kanał odtworzony, nie podany przez źródło (`ArchivedOrder.channelInferred`; faktury BL) */
  kanalOdtworzony?: boolean
  /** pozycje bez id oferty: produkt z katalogu po SKU, potem po EAN (jednoznacznym) — faktury BL */
  produktPoKodach?: boolean
  /**
   * wiersze tego źródła zapisane wcześniej, które przy tym przebiegu przestały należeć do archiwum (faktura BL, która
   * dostała parę w innym kanale albo wypadła za koniec zakresu): wołane raz na przebieg, przed czytaniem stron, na cały
   * zakres (niezależnie od kursora wznowienia); usuwa je (na sucho tylko liczy) i zwraca ich liczbę
   */
  wycofaj?: (db: PrismaClient, z: { konto: string; do: Date; naSucho: boolean }) => Promise<number>
  /**
   * skrót opcji zmieniających mapowanie (faktury BL: plik źródeł i mapa): zapisany w stanie przebiegu; przerwany przebieg
   * z innym skrótem nie jest wznawiany (błąd przed zapisem), bo strony przed kursorem zostałyby w starym trybie
   */
  skrotOpcji?: string
}

export const idPola =
  (pole: string) =>
  (raw: Record<string, unknown>): string | null => {
    const v = raw[pole]
    return typeof v === 'number' || (typeof v === 'string' && v.trim()) ? String(v).trim() : null
  }

/** Źródło Woo (etap 1). */
export function zrodloWoo(czytaj: CzytajStrone, opts: { rabatMaksProcent?: number } = {}): ZrodloArchiwum {
  return {
    channel: 'WOO',
    source: ZRODLO_WOO,
    runKind: ARCHIWUM_WOO_RUN_KIND,
    etykieta: 'Woo',
    czytaj,
    oczysc: bezDanychOsobowych,
    mapuj: (raw) => archiwumZWoo(raw, { rabatMaksProcent: opts.rabatMaksProcent }),
    idSurowe: idPola('id'),
  }
}

export interface OpcjeImportu {
  konto: string
  od: Date
  /** koniec zakresu (wyłącznie); domyślnie `coverageFrom` konta */
  do?: Date
  naSucho: boolean
  naStrone?: number
  /** bezpiecznik: najwyżej tyle stron w jednym przebiegu (reszta przy następnym uruchomieniu, od kursora) */
  maksStron?: number
  now?: Date
}
export interface OpcjeImportuWoo extends OpcjeImportu {
  rabatMaksProcent?: number
}

export type PowodPominiecia = 'szkic' | 'jest w Kompletorze' | 'poza zakresem dat' | 'bez zmian' | 'para w innym kanale' | 'inny kanał wg źródeł BL'

export interface WynikImportu {
  naSucho: boolean
  /** kanał i nazwa źródła (raport) */
  channel: Channel
  etykieta: string
  konto: string
  od: Date
  do: Date
  /** skąd górna granica: konto (`coverageFrom`), `--do`, albo `--do` przycięte do konta */
  granica: 'konto' | 'parametr' | 'parametr przycięty do konta'
  /** opis źródła granicy podany przez wywołującego (faktury BL: koniec liczony przed importerem), zamiast `granica` w raporcie */
  opisGranicy?: string
  runId: string | null
  wznowiony: boolean
  odStrony: number
  stronPobranych: number
  ostatniaStrona: number
  koniec: boolean
  /** X-WP-Total pierwszej pobranej strony */
  razemWSklepie: number | null
  pobrane: number
  zapisane: number
  pominiete: Record<PowodPominiecia, number>
  bledy: { ref: string; powod: string }[]
  /** zamówienia do archiwum (zapisane albo, na sucho, do zapisania) wg statusu Woo: liczba i suma brutto (grosze) */
  wgStatusu: Record<string, { n: number; bruttoGr: number }>
  /** sprzedaż (bez ANULOWANE) i anulowane, jak w raporcie */
  sprzedaz: { n: number; bruttoGr: number }
  anulowane: { n: number; bruttoGr: number }
  zwrotyGr: number
  pozycji: number
  pozycjiBezProduktu: number
  ostrzezen: number
  /** strony przeczytane ponownie, bo miały otwarte problemy z wcześniejszej części przebiegu */
  stronPonowionych: number
  /** zamówienia z problemem nierozwiązanym w całym przebiegu (także z części przed wznowieniem); > 0 = kod wyjścia 1 */
  bledyOtwarte: number
  /** liczniki wcześniejszych części wznowionego przebiegu */
  poprzednio: { pobrane: number; zapisane: number }
  /** wiersze źródła zapisane wcześniej i usunięte w tym przebiegu (`ZrodloArchiwum.wycofaj`; na sucho: do usunięcia) */
  wycofane: number
}
export type WynikImportuWoo = WynikImportu

interface StanKursora {
  konto: string
  od: string
  do: string
  ostatniaStrona: number
  pobrane: number
  zapisane: number
  koniec: boolean
  /** zamówienia z otwartym problemem (id w kanale → strona): wznowienie czyta te strony ponownie */
  otwarte?: Record<string, number>
  /** `ZrodloArchiwum.skrotOpcji` przebiegu (brak = przebieg bez takich opcji) */
  skrotOpcji?: string
}

const BLAD_MAKS = 500

function bladTekst(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  // bez treści odpowiedzi sklepu i adresów: pierwsza linia, przycięta
  return m.split('\n')[0]!.slice(0, 300)
}

/** Górna granica importu i jej źródło (warunek rozłączności (1)). */
export async function granicaImportu(db: PrismaClient, konto: string, doParam?: Date, channel: Channel = 'WOO'): Promise<{ do: Date; granica: WynikImportu['granica'] }> {
  const kursor = await db.channelCursor.findFirst({ where: { channel, channelAccountId: konto }, select: { coverageFrom: true } })
  const pokrycie = kursor?.coverageFrom ?? null
  if (!pokrycie) {
    if (!doParam) throw new Error(`konto ${channel}:${konto} nie ma początku odczytu kanału (coverageFrom): podaj --do RRRR-MM-DD`)
    return { do: doParam, granica: 'parametr' }
  }
  if (!doParam) return { do: pokrycie, granica: 'konto' }
  return doParam.getTime() > pokrycie.getTime() ? { do: pokrycie, granica: 'parametr przycięty do konta' } : { do: doParam, granica: 'parametr' }
}

function pustyWynik(zr: ZrodloArchiwum, o: OpcjeImportu, doDnia: Date, granica: WynikImportu['granica']): WynikImportu {
  return {
    naSucho: o.naSucho,
    channel: zr.channel,
    etykieta: zr.etykieta,
    konto: o.konto,
    od: o.od,
    do: doDnia,
    granica,
    runId: null,
    wznowiony: false,
    odStrony: 1,
    stronPobranych: 0,
    ostatniaStrona: 0,
    koniec: false,
    razemWSklepie: null,
    pobrane: 0,
    zapisane: 0,
    pominiete: { szkic: 0, 'jest w Kompletorze': 0, 'poza zakresem dat': 0, 'bez zmian': 0, 'para w innym kanale': 0, 'inny kanał wg źródeł BL': 0 },
    bledy: [],
    wgStatusu: {},
    sprzedaz: { n: 0, bruttoGr: 0 },
    anulowane: { n: 0, bruttoGr: 0 },
    zwrotyGr: 0,
    pozycji: 0,
    pozycjiBezProduktu: 0,
    ostrzezen: 0,
    stronPonowionych: 0,
    bledyOtwarte: 0,
    poprzednio: { pobrane: 0, zapisane: 0 },
    wycofane: 0,
  }
}

/** Przerwany przebieg z tym samym kontem i zakresem (do wznowienia) albo null. */
async function przerwanyPrzebieg(db: PrismaClient, runKind: string, konto: string, od: Date, doDnia: Date, skrotOpcji: string | undefined): Promise<{ id: string; stan: StanKursora } | null> {
  const runs = await db.importRun.findMany({ where: { kind: runKind, status: { in: ['RUNNING', 'PARTIAL', 'FAILED'] } }, orderBy: { startedAt: 'desc' }, take: 20, select: { id: true, stats: true } })
  for (const r of runs) {
    const s = r.stats as Partial<StanKursora> | null
    if (s && s.konto === konto && s.od === od.toISOString() && s.do === doDnia.toISOString() && !s.koniec && typeof s.ostatniaStrona === 'number') {
      if ((s.skrotOpcji ?? null) !== (skrotOpcji ?? null)) throw new Error(`przerwany przebieg ${r.id} tego konta i zakresu ma inne opcje mapowania (plik źródeł BL albo mapa: ${s.skrotOpcji ?? 'bez'} ≠ ${skrotOpcji ?? 'bez'}); wznowienie odmówione, nic nie zapisano: dokończ go tymi samymi opcjami, potem nowy przebieg z nowymi opcjami przeczyta wszystko od początku${s.skrotOpcji ? '' : ' (przebieg bez skrótu, np. ze starszej wersji: dokończ go bez --zrodla-bl)'}`)
      return { id: r.id, stan: s as StanKursora }
    }
  }
  return null
}

type Oferta = { productId: string; qtyBasePerOffer: number; active: boolean }

/** Oferty konta po id oferty kanału: aktywna przed nieaktywną (historia sprzed wyłączenia oferty też ma produkt). */
async function oferty(db: PrismaClient, channel: Channel, konto: string, ids: string[]): Promise<Map<string, Oferta>> {
  if (!ids.length) return new Map()
  const rows = await db.channelOffer.findMany({ where: { channel, channelAccountId: konto, externalId: { in: ids } }, select: { externalId: true, productId: true, qtyBasePerOffer: true, active: true } })
  const out = new Map<string, Oferta>()
  for (const r of rows) {
    const byl = out.get(r.externalId)
    if (!byl || (!byl.active && r.active)) out.set(r.externalId, { productId: r.productId, qtyBasePerOffer: r.qtyBasePerOffer > 0 ? r.qtyBasePerOffer : 1, active: r.active })
  }
  return out
}

const dec2 = (g: number) => new Prisma.Decimal(g).div(100)

/** Produkty katalogu po SKU i po EAN (tylko EAN jednoznaczny w firmie) dla pozycji bez id oferty. */
export interface KodyProduktow {
  poSku: Map<string, string>
  poEan: Map<string, string>
}
const BEZ_KODOW: KodyProduktow = { poSku: new Map(), poEan: new Map() }
const kodSku = (s: string) => s.trim().toUpperCase()

export function produktPoKodzie(k: KodyProduktow, l: { sku: string | null; ean: string | null }): string | null {
  return (l.sku ? k.poSku.get(kodSku(l.sku)) : undefined) ?? (l.ean ? k.poEan.get(l.ean.trim()) : undefined) ?? null
}

async function kodyProduktow(db: PrismaClient, zamowienia: readonly ZamowienieArchiwum[]): Promise<KodyProduktow> {
  const skus = [...new Set(zamowienia.flatMap((z) => z.lines.filter((l) => !l.offerId && l.sku).map((l) => l.sku!.trim())))]
  const eans = [...new Set(zamowienia.flatMap((z) => z.lines.filter((l) => !l.offerId && l.ean).map((l) => l.ean!.trim())))]
  const out: KodyProduktow = { poSku: new Map(), poEan: new Map() }
  if (skus.length) {
    const rows = await db.product.findMany({ where: { sku: { in: skus, mode: 'insensitive' } }, select: { id: true, sku: true } })
    const ile = new Map<string, number>()
    for (const r of rows) ile.set(kodSku(r.sku), (ile.get(kodSku(r.sku)) ?? 0) + 1)
    for (const r of rows) if (ile.get(kodSku(r.sku)) === 1) out.poSku.set(kodSku(r.sku), r.id)
  }
  if (eans.length) {
    const rows = await db.product.findMany({ where: { ean: { in: eans } }, select: { id: true, ean: true } })
    const ile = new Map<string, number>()
    for (const r of rows) if (r.ean) ile.set(r.ean, (ile.get(r.ean) ?? 0) + 1)
    for (const r of rows) if (r.ean && ile.get(r.ean) === 1) out.poEan.set(r.ean, r.id)
  }
  return out
}

async function zapiszZamowienie(db: PrismaClient, zr: ZrodloArchiwum, organizationId: string, konto: string, runId: string, z: ZamowienieArchiwum, off: Map<string, Oferta>, kody: KodyProduktow): Promise<'zapisane' | 'bez zmian'> {
  return db.$transaction(async (tx) => {
    const klucz = { organizationId_channel_channelAccountId_externalId: { organizationId, channel: zr.channel, channelAccountId: konto, externalId: z.externalId } }
    const byl = await tx.archivedOrder.findUnique({ where: klucz, select: { id: true, sourceRevision: true } })
    if (byl && byl.sourceRevision === z.sourceRevision) return 'bez zmian'
    if (byl && zr.rewizjaCzasem && byl.sourceRevision && z.sourceRevision < byl.sourceRevision) return 'bez zmian'
    const dane = {
      source: zr.source,
      channelNumber: z.channelNumber,
      status: z.status,
      channelStatus: z.channelStatus,
      createdAtChannel: z.createdAtChannel,
      closedAt: z.closedAt,
      paymentState: z.paymentState,
      paymentMethod: null,
      totalGross: dec2(z.totalGrossGr),
      shippingGross: z.shippingGrossGr === null ? null : dec2(z.shippingGrossGr),
      refundGross: dec2(z.refundGrossGr),
      currency: z.currency,
      deliveryMethod: z.deliveryMethod,
      sourceRevision: z.sourceRevision,
      importRunId: runId,
      channelInferred: z.kanalOdtworzony ?? !!zr.kanalOdtworzony,
      ...(z.blOrderId !== undefined ? { blOrderId: z.blOrderId } : {}),
      ...(z.invoiceNumbers !== undefined ? { invoiceNumbers: z.invoiceNumbers } : {}),
    }
    const zam = byl
      ? await tx.archivedOrder.update({ where: { id: byl.id }, data: { ...dane, importedAt: new Date() }, select: { id: true } })
      : await tx.archivedOrder.create({ data: { ...dane, channel: zr.channel, channelAccountId: konto, externalId: z.externalId }, select: { id: true } })
    if (byl) await tx.archivedOrderLine.deleteMany({ where: { orderId: zam.id } })
    if (z.lines.length)
      await tx.archivedOrderLine.createMany({
        data: z.lines.map((l) => {
          const o = l.offerId ? off.get(l.offerId) : undefined
          const poKodzie = !l.offerId ? produktPoKodzie(kody, l) : null
          const qty = new Prisma.Decimal(l.qtyOffer * (o?.qtyBasePerOffer ?? 1))
          const refundQty = l.lineGrossGr > 0 ? qty.mul(l.refundGr).div(l.lineGrossGr).toDecimalPlaces(3) : new Prisma.Decimal(0)
          return {
            orderId: zam.id,
            externalLineId: l.externalLineId,
            offerId: l.offerId,
            productId: o?.productId ?? poKodzie ?? null,
            name: l.name,
            sku: l.sku,
            ean: l.ean,
            qty,
            lineGross: dec2(l.lineGrossGr),
            vatRate: l.vatRate,
            refundQty,
            refundGross: dec2(l.refundGr),
          }
        }),
      })
    return 'zapisane'
  })
}

function policz(w: WynikImportu, z: ZamowienieArchiwum, off: Map<string, Oferta>, kody: KodyProduktow): void {
  const s = (w.wgStatusu[z.channelStatus] ??= { n: 0, bruttoGr: 0 })
  s.n++
  s.bruttoGr += z.totalGrossGr
  const cel = z.status === 'ANULOWANE' ? w.anulowane : w.sprzedaz
  cel.n++
  cel.bruttoGr += z.totalGrossGr
  if (z.status !== 'ANULOWANE') w.zwrotyGr += z.lines.reduce((a, l) => a + l.refundGr, 0)
  w.pozycji += z.lines.length
  w.pozycjiBezProduktu += z.lines.filter((l) => !(l.offerId ? off.has(l.offerId) : produktPoKodzie(kody, l))).length
  w.ostrzezen += z.warnings.length
}

// reguła rozłączności z `Order` (warunek (2) i (3)): jedna definicja dla importera i raportu
export { jestWKompletorze, OKNO_NUMERU_MS } from './rozlacznosc'

/** Import archiwum Woo jednego konta (etap 1; ten sam szkielet co pozostałe kanały). */
export async function importujArchiwumWoo(db: PrismaClient, czytaj: CzytajStroneWoo, o: OpcjeImportuWoo): Promise<WynikImportuWoo> {
  return importujArchiwum(db, zrodloWoo(czytaj, { rabatMaksProcent: o.rabatMaksProcent }), o)
}

/** Import archiwum jednego konta kanału z podanego źródła (opis zasad w nagłówku pliku). */
export async function importujArchiwum(db: PrismaClient, zr: ZrodloArchiwum, o: OpcjeImportu): Promise<WynikImportu> {
  const naStrone = o.naStrone ?? NA_STRONE_DOMYSLNIE
  const maks = zr.maksNaStrone ?? 100
  if (!Number.isInteger(naStrone) || naStrone < 1 || naStrone > maks) throw new Error(`naStrone: 1–${maks}`)
  const { do: doDnia, granica } = await granicaImportu(db, o.konto, o.do, zr.channel)
  if (doDnia.getTime() <= o.od.getTime()) throw new Error(`pusty zakres: koniec ${doDnia.toISOString()} nie jest po początku ${o.od.toISOString()}`)
  const w = pustyWynik(zr, o, doDnia, granica)
  // klient firmy (RLS) wymagany do zapisu; na sucho importer tylko czyta, więc id firmy nie jest potrzebne
  const organizationId = o.naSucho ? '' : organizationIdOf(db)

  let runId: string | null = null
  let strona = 1
  // otwarte problemy przebiegu (także z wcześniejszych części) i strony do ponowienia przy wznowieniu
  const otwarte: Record<string, number> = {}
  const ponow: number[] = []
  if (!o.naSucho) {
    const przerwany = await przerwanyPrzebieg(db, zr.runKind, o.konto, o.od, doDnia, zr.skrotOpcji)
    if (przerwany) {
      runId = przerwany.id
      w.wznowiony = true
      strona = Math.max(1, przerwany.stan.ostatniaStrona) // jedna strona zakładki: upsert nie robi dubli
      Object.assign(otwarte, przerwany.stan.otwarte ?? {})
      w.ostatniaStrona = przerwany.stan.ostatniaStrona
      w.poprzednio = { pobrane: przerwany.stan.pobrane ?? 0, zapisane: przerwany.stan.zapisane ?? 0 }
      ponow.push(...[...new Set(Object.values(otwarte))].filter((n) => Number.isInteger(n) && n >= 1 && n < strona).sort((x, y) => x - y))
      await db.importRun.update({ where: { id: runId }, data: { status: 'RUNNING', finishedAt: null, error: null } })
    } else {
      const stan: StanKursora = { konto: o.konto, od: o.od.toISOString(), do: doDnia.toISOString(), ostatniaStrona: 0, pobrane: 0, zapisane: 0, koniec: false, ...(zr.skrotOpcji ? { skrotOpcji: zr.skrotOpcji } : {}) }
      runId = (await db.importRun.create({ data: { kind: zr.runKind, stats: stan as unknown as Prisma.InputJsonValue } })).id
    }
  }
  w.runId = runId
  w.odStrony = strona

  let nrStrony = strona
  const issue = async (ref: string, powod: string) => {
    otwarte[ref] = nrStrony
    if (w.bledy.length < BLAD_MAKS) w.bledy.push({ ref, powod })
    if (runId) await db.importIssue.create({ data: { runId, kind: zr.runKind, ref: ref.slice(0, 200), message: powod.slice(0, 1000) } }).catch(() => {})
  }

  let bladPrzebiegu: string | null = null
  try {
    // wycofanie na całym zakresie przy każdym przebiegu (także wznowionym): para albo koniec zakresu mogły się zmienić;
    // błąd = błąd przebiegu (PARTIAL/FAILED jak przy stronie)
    if (zr.wycofaj) w.wycofane = await zr.wycofaj(db, { konto: o.konto, do: doDnia, naSucho: o.naSucho })
    for (let n = 0; o.maksStron === undefined || n < o.maksStron; n++) {
      // najpierw strony z otwartymi problemami z wcześniejszej części przebiegu, potem dalej od kursora
      const ponowienie = ponow.length > 0
      nrStrony = ponowienie ? ponow.shift()! : strona
      const s = await zr.czytaj({ od: o.od, do: doDnia, strona: nrStrony, naStrone })
      w.stronPobranych++
      if (ponowienie) w.stronPonowionych++
      if (w.razemWSklepie === null && !ponowienie) w.razemWSklepie = s.razem
      const surowe = s.zamowienia.map(zr.oczysc)
      w.pobrane += surowe.length

      // partia strony: najpierw mapowanie, potem zamówienia już w Kompletorze (warunek (2)) i oferty jednym zapytaniem
      const wZakresie: ZamowienieArchiwum[] = []
      for (const raw of surowe) {
        const ref = zr.idSurowe(raw) ?? '(bez id)'
        try {
          const m = zr.mapuj(raw)
          delete otwarte[ref]
          if (m.rodzaj === 'pominiete') {
            const poza = m.czas !== undefined && (m.czas.getTime() < o.od.getTime() || m.czas.getTime() >= doDnia.getTime())
            w.pominiete[poza ? 'poza zakresem dat' : m.powod]++
            continue
          }
          const z = m.zamowienie
          if (z.createdAtChannel.getTime() < o.od.getTime() || z.createdAtChannel.getTime() >= doDnia.getTime()) {
            w.pominiete['poza zakresem dat']++
            continue
          }
          wZakresie.push(z)
        } catch (e) {
          await issue(ref, `mapowanie: ${bladTekst(e)}`)
        }
      }
      // kandydaci po id zamówienia w kanale i po numerze (w `externalId` albo `channelNumber`, lib/archiwum/rozlacznosc.ts)
      const istniejace = wZakresie.length ? await db.order.findMany({ where: { channel: zr.channel, channelAccountId: o.konto, ...kandydaciOrder(zr.channel, wZakresie) }, select: { externalId: true, channelNumber: true, createdAtChannel: true } }) : []
      const mapowane = wZakresie.filter((z) => !jestWKompletorze(zr.channel, z, istniejace))
      w.pominiete['jest w Kompletorze'] += wZakresie.length - mapowane.length
      const off = await oferty(db, zr.channel, o.konto, [...new Set(mapowane.flatMap((z) => z.lines.map((l) => l.offerId).filter((x): x is string => !!x)))])
      const kody = zr.produktPoKodach ? await kodyProduktow(db, mapowane) : BEZ_KODOW
      for (const z of mapowane) {
        try {
          if (!o.naSucho && runId) {
            const r = await zapiszZamowienie(db, zr, organizationId, o.konto, runId, z, off, kody)
            delete otwarte[z.externalId]
            if (r === 'bez zmian') {
              w.pominiete['bez zmian']++
              policz(w, z, off, kody)
              continue
            }
          }
          w.zapisane++
          policz(w, z, off, kody)
        } catch (e) {
          await issue(z.externalId, `zapis: ${bladTekst(e)}`)
        }
      }
      if (!ponowienie) {
        w.ostatniaStrona = strona
        w.koniec = s.zamowienia.length < naStrone || (s.stron !== null && strona >= s.stron)
      }
      if (runId) {
        const stan: StanKursora = { konto: o.konto, od: o.od.toISOString(), do: doDnia.toISOString(), ostatniaStrona: w.ostatniaStrona, pobrane: w.poprzednio.pobrane + w.pobrane, zapisane: w.poprzednio.zapisane + w.zapisane, koniec: w.koniec, otwarte, ...(zr.skrotOpcji ? { skrotOpcji: zr.skrotOpcji } : {}) }
        await db.importRun.update({ where: { id: runId }, data: { stats: stan as unknown as Prisma.InputJsonValue } })
      }
      if (ponowienie) continue
      if (w.koniec) break
      strona++
    }
  } catch (e) {
    bladPrzebiegu = bladTekst(e)
  }
  w.bledyOtwarte = Object.keys(otwarte).length

  if (runId) {
    // problem nierozwiązany z wcześniejszej części przebiegu też zostaje widoczny: PARTIAL, nie OK
    const problemow = w.bledyOtwarte
    const status = bladPrzebiegu ? 'FAILED' : problemow || !w.koniec ? 'PARTIAL' : 'OK'
    await db.importRun.update({ where: { id: runId }, data: { status, finishedAt: o.now ?? new Date(), error: bladPrzebiegu, reportMarkdown: raportImportu(w, bladPrzebiegu) } })
  }
  if (bladPrzebiegu) throw Object.assign(new Error(`import przerwany na stronie ${strona}: ${bladPrzebiegu} (ponowne uruchomienie wznowi od kursora)`), { wynik: w })
  return w
}

const zl = (g: number) => (g / 100).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const dzien = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ')

/** Raport przebiegu (Markdown): liczby, statusy, powody; bez danych klientów. */
export function raportImportu(w: WynikImportu, blad: string | null = null): string {
  const L: string[] = []
  L.push(`# Archiwum zamówień ${w.etykieta}: konto ${w.channel}:${w.konto}${w.naSucho ? ' (NA SUCHO, nic nie zapisano)' : ''}`)
  L.push('')
  L.push(`- Zakres (UTC): od ${dzien(w.od)} do ${dzien(w.do)} (wyłącznie); koniec zakresu: ${w.opisGranicy ?? w.granica}.`)
  L.push(`- Strony: od ${w.odStrony}${w.wznowiony ? ' (wznowienie przerwanego przebiegu)' : ''}, pobrane ${w.stronPobranych}, ostatnia ${w.ostatniaStrona}; ${w.koniec ? 'zakres przeczytany do końca' : 'NIE do końca: ponowne uruchomienie wznowi od kursora'}.`)
  if (blad) L.push(`- **Przerwane:** ${blad}`)
  L.push(`- W źródle (liczba podana przez źródło dla zakresu; plik: cały plik): ${w.razemWSklepie ?? 'nieznane'}; pobrane: ${w.pobrane}.`)
  L.push(`- ${w.naSucho ? 'Do zapisania' : 'Zapisane'}: ${w.zapisane}; bez zmian (ta sama rewizja sklepu): ${w.pominiete['bez zmian']}.`)
  L.push(`- Pominięte: szkice ${w.pominiete.szkic}, już w Kompletorze ${w.pominiete['jest w Kompletorze']}, poza zakresem dat ${w.pominiete['poza zakresem dat']}${w.pominiete['para w innym kanale'] ? `, para w innym kanale albo źródle ${w.pominiete['para w innym kanale']}` : ''}${w.pominiete['inny kanał wg źródeł BL'] ? `, inny kanał wg pliku źródeł BL ${w.pominiete['inny kanał wg źródeł BL']}` : ''}; błędy w tej części: ${w.bledy.length}; **nierozwiązane w całym przebiegu: ${w.bledyOtwarte}**.`)
  if (w.wycofane) L.push(`- ${w.naSucho ? 'Do usunięcia z archiwum' : 'Usunięte z archiwum'} (zapisane wcześniej, teraz para w innym kanale${w.pominiete['inny kanał wg źródeł BL'] ? ', inny kanał wg pliku źródeł BL' : ''} albo poza końcem zakresu): ${w.wycofane}.`)
  if (w.wznowiony) L.push(`- Wcześniejsze części przebiegu: pobrane ${w.poprzednio.pobrane}, zapisane ${w.poprzednio.zapisane}; razem zapisane ${w.poprzednio.zapisane + w.zapisane}; strony z problemami przeczytane ponownie: ${w.stronPonowionych}.`)
  L.push(`- Sprzedaż (bez anulowanych): ${w.sprzedaz.n} zamówień, ${zl(w.sprzedaz.bruttoGr)} zł brutto; anulowane: ${w.anulowane.n}, ${zl(w.anulowane.bruttoGr)} zł; zwroty częściowe na pozycjach: ${zl(w.zwrotyGr)} zł.`)
  L.push(`- Pozycje: ${w.pozycji}, bez produktu w katalogu: ${w.pozycjiBezProduktu}; ostrzeżenia mapowania: ${w.ostrzezen}.`)
  L.push('')
  L.push(`| Status ${w.etykieta} | Zamówień | Brutto (zł) |`)
  L.push('|---|---:|---:|')
  for (const [k, v] of Object.entries(w.wgStatusu).sort((a, b) => b[1].n - a[1].n)) L.push(`| ${k} | ${v.n} | ${zl(v.bruttoGr)} |`)
  if (w.bledy.length) {
    L.push('')
    L.push('## Błędy (id zamówienia w kanale: powód)')
    for (const b of w.bledy.slice(0, 100)) L.push(`- ${b.ref}: ${b.powod}`)
    if (w.bledy.length > 100) L.push(`- … i ${w.bledy.length - 100} więcej (pełna lista w ImportIssue przebiegu)`)
  }
  return L.join('\n')
}

/** Nazwa z etapu 1 (Woo). */
export const raportImportuWoo = raportImportu
