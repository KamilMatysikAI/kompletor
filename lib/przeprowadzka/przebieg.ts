// Przeprowadzka z BL: zebranie danych (tylko odczyt BL i — gdy firma ma klucze — wFirmy) i przeliczenie
// planu. Bez zapisu w bazie. Wynik zbierania (`ZebraneDane`) to też zrzut na dysk (`--zrzut`): zawiera wyłącznie
// konfigurację BL, katalog produktów i zamówienia PO parserze (bez danych osobowych).
import type { AdapterRegistry } from '../adaptery/rejestr'
import type { CatalogRules } from '../import/bez-stanu'
import { analyze, collectSources, MISSING_KEYS, type Analysis, type RawSources } from '../import/katalog'
import type { SaleLine } from '../import/normalizacja'
import type { FetchIssue } from '../import/pobieranie'
import type { BaseLinkerReadOnly } from '../zrodla/baselinker'
import type { WfirmaReadOnly } from '../zrodla/wfirma'
import { type BlKonfiguracja, channelMapZPlanu, kontoZamowienia, planuj, pobierzKonfiguracje, pobierzKontaKurierow, type PlanKonfiguracji } from './rozpoznanie'
import { type MapaCzlowieka, mapaStatusow, PUSTA_MAPA, statusyOtwarte } from './statusy'
import { type BlZamowienie, liniaSprzedazy, pobierzZamowienia } from './zamowienia'

export const WERSJA_ZRZUTU = 1

export interface ZebraneDane {
  wersja: typeof WERSJA_ZRZUTU
  pobrano: string
  katalogArg: string | null
  konfiguracja: BlKonfiguracja
  /** Statusy BL, które przy zbieraniu uznano za otwarte (wg mapy z tamtej chwili). */
  statusyPobrane: string[]
  zamowienia: { otwarte: BlZamowienie[]; ostatnie: BlZamowienie[]; complete: boolean; ostatnieObciete?: boolean; statusyObciete?: string[] }
  /** Katalog produktów i ofert (RawSources importu); null, gdy katalogu nie dało się wybrać. */
  katalog: RawSources | null
  issues: FetchIssue[]
  /** Liczba wywołań metod BL (do raportu: dowód, że poszły tylko metody z listy). */
  wywolania: Record<string, number>
}

export interface ZrodlaPrzeprowadzki {
  bl: BaseLinkerReadOnly & { wywolania?: Map<string, number> }
  wfirma: WfirmaReadOnly | null
  wfirmaWarehouseId: string | null
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500)

/**
 * [NIEPEWNE] getInventoryProductsStock: `{ products: { <id>: { product_id, stock: { "bl_<magazyn>": ilość },
 * variants: { <id wariantu>: { "bl_<magazyn>": ilość } } } } }`, strony po 1000. Wynik: id produktu/wariantu BL → ilość
 * w magazynie `magazyn` (brak magazynu w odpowiedzi = 0).
 */
export async function pobierzStanBl(bl: BaseLinkerReadOnly, inventoryId: string, magazyn: string | null, issues: FetchIssue[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  const qty = (stock: unknown): number => {
    if (!stock || typeof stock !== 'object') return 0
    const o = stock as Record<string, unknown>
    const v = magazyn ? o[magazyn] : Object.entries(o).find(([k]) => k.startsWith('bl_'))?.[1]
    const n = typeof v === 'number' ? v : Number(v)
    return Number.isFinite(n) ? n : 0
  }
  for (let page = 1; page < 200; page++) {
    let list: [string, unknown][]
    try {
      const r = await bl.call<{ products: unknown }>('getInventoryProductsStock', { inventory_id: Number(inventoryId), page })
      list = r.products && typeof r.products === 'object' ? Object.entries(r.products as Record<string, unknown>) : []
    } catch (e) {
      issues.push({ kind: 'bl-stany', ref: `strona ${page}`, message: errMsg(e) })
      break
    }
    for (const [id, raw] of list) {
      const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
      out[id] = qty(p['stock'])
      const variants = p['variants'] && typeof p['variants'] === 'object' ? (p['variants'] as Record<string, unknown>) : {}
      for (const [vid, vs] of Object.entries(variants)) out[vid] = qty(vs)
    }
    if (list.length < 1000) break
  }
  return out
}

/** Linie sprzedaży z zamówień po parserze — źródło powiązań ofert Allegro i innych kanałów bez listy ofert. */
export function liniePowiazan(plan: Pick<PlanKonfiguracji, 'konta'>, zamowienia: BlZamowienie[]): SaleLine[] {
  const out: SaleLine[] = []
  for (const o of zamowienia) {
    const k = kontoZamowienia(plan, o)
    if (!k || k.pominiete) continue
    for (const p of o.products) out.push(liniaSprzedazy(o, p, k))
  }
  return out
}

/**
 * Zebranie wszystkiego z BL: konfiguracja → statusy → zamówienia (przez parser) → konta kurierów → katalog. Mapa
 * człowieka jest potrzebna już tu: wyznacza, zamówienia których statusów są otwarte. Zero zapisów.
 */
/** Rodzaj problemu pobierania: zapisany wybór katalogu z ekranu, którego nie ma w BL. */
export const KATALOG_WYBRANY_BRAK = 'katalog-wybrany-brak'

/**
 * `katalogWybrany` (panel): katalog wybrany na ekranie. Gdy BL go nie zna (inne konto po zmianie klucza, katalog
 * skasowany w BL), przebieg wraca do `katalog` albo jedynego katalogu i zostawia problem `KATALOG_WYBRANY_BRAK`.
 */
export async function zbierz(z: ZrodlaPrzeprowadzki, opts: { katalog?: string; katalogWybrany?: string; mapa?: MapaCzlowieka; registry: Pick<AdapterRegistry, 'get'>; now?: Date }): Promise<ZebraneDane> {
  const now = opts.now ?? new Date()
  const issues: FetchIssue[] = []
  const mapa = opts.mapa ?? PUSTA_MAPA
  let katalogArg: string | undefined = opts.katalog
  const wybor = opts.katalogWybrany
  const konfiguracja = await pobierzKonfiguracje(
    z.bl,
    issues,
    wybor
      ? (katalogi) => {
          // pusta lista = BL nie odpowiedział (problem `bl-katalogi`): zostaje wybór, raport pokaże błąd pobierania
          if (!katalogi.length || katalogi.some((k) => k.id === wybor)) return (katalogArg = wybor)
          issues.push({
            kind: KATALOG_WYBRANY_BRAK,
            ref: wybor,
            message: `Wybranego wcześniej katalogu nr ${wybor} nie ma w BaseLinkerze (inne konto albo katalog usunięty). Przyjęto ${katalogArg ? `katalog nr ${katalogArg}` : katalogi.length === 1 ? `jedyny katalog nr ${katalogi[0]!.id}` : 'brak wyboru'}; wybierz katalog w sekcji „Decyzje”.`,
          })
          return katalogArg
        }
      : opts.katalog,
  )
  const decyzje = mapaStatusow(konfiguracja.statusy, mapa)
  const doDecyzji = new Set(decyzje.filter((d) => d.pewnosc === 'DO_DECYZJI').map((d) => d.blStatusId))
  const zam = await pobierzZamowienia(z.bl, statusyOtwarte(decyzje), issues, { now, statusyDoDecyzji: doDecyzji })
  // status czytany częściowo nie jest „pobrany”: po decyzji w mapie zapis ze zrzutu wymusi zebranie od nowa
  const statusyPobrane = statusyOtwarte(decyzje).filter((id) => !(zam.statusyObciete ?? []).includes(id))
  const wszystkie = [...zam.otwarte, ...zam.ostatnie]
  const metody = [...new Set(wszystkie.map((o) => o.delivery_method).filter((m): m is string => !!m))]
  konfiguracja.kontaKurierow = await pobierzKontaKurierow(z.bl, konfiguracja.kurierzy, metody, issues)
  const plan = planuj({ konfiguracja, katalog: katalogArg, mapa, zamowienia: wszystkie, registry: opts.registry })
  let katalog: RawSources | null = null
  if (plan.katalog) {
    const channels = channelMapZPlanu(plan)
    const shopStorages = plan.konta.filter((k) => k.channel === 'WOO' && !k.pominiete && k.blStorageId).map((k) => k.blStorageId!)
    const useWfirma = !!z.wfirma && !!z.wfirmaWarehouseId
    katalog = await collectSources({
      bl: z.bl,
      wfirma: useWfirma ? z.wfirma : null,
      empik: null,
      inventoryId: plan.katalog.id,
      salesDays: 0, // zamówień nie czytamy drugi raz: linie sprzedaży z zamówień po parserze niżej
      wfirmaWarehouseId: useWfirma ? z.wfirmaWarehouseId : null,
      shopStorages,
      channels,
      now,
    })
    const lines = liniePowiazan(plan, wszystkie)
    // complete: false — okno zamówień nie jest pełną historią: import nie wyłączy żadnej oferty na jego podstawie
    katalog.sales = {
      lines,
      orders: new Set(lines.map((l) => l.orderId)).size,
      oldestUnix: lines.length ? Math.min(...lines.map((l) => Math.floor(l.soldAt.getTime() / 1000))) : null,
      sinceUnix: Math.floor(now.getTime() / 1000) - 30 * 86_400,
      complete: false,
    }
    if (!useWfirma) {
      katalog.stockSource = 'bl'
      katalog.blStock = await pobierzStanBl(z.bl, plan.katalog.id, plan.katalog.magazynStanu, katalog.issues)
      // brak wFirmy to tu tryb pracy, nie brak kluczy
      katalog.issues = katalog.issues.filter((i) => !(i.kind === MISSING_KEYS && i.ref === 'wfirma'))
    }
  }
  return {
    wersja: WERSJA_ZRZUTU,
    pobrano: now.toISOString(),
    katalogArg: katalogArg ?? null,
    konfiguracja,
    statusyPobrane,
    zamowienia: zam,
    katalog,
    issues,
    wywolania: Object.fromEntries(z.bl.wywolania ?? []),
  }
}

/** Zrzut z dysku: daty linii sprzedaży wracają do Date. */
export function wczytajZrzut(json: string): ZebraneDane {
  const d = JSON.parse(json) as ZebraneDane
  if (d.wersja !== WERSJA_ZRZUTU) throw new Error(`zrzut w wersji ${String(d.wersja)}, oczekiwana ${WERSJA_ZRZUTU}`)
  if (d.katalog) for (const l of d.katalog.sales.lines) l.soldAt = new Date(l.soldAt as unknown as string)
  return d
}

export interface Przeliczenie {
  plan: PlanKonfiguracji
  analiza: Analysis | null
  /** Otwarte zamówienia na status BL (do blokady `--zapisz` przy statusach DO_DECYZJI). */
  otwartePoStatusie: Map<string, number>
  /** Statusy, które wg bieżącej mapy są otwarte, a nie były pobrane (mapa zmieniona po zrzucie): zbierz od nowa. */
  statusyNiepobrane: string[]
}

/** Plan z zebranych danych i bieżącej mapy (czysto; ten sam wynik z sieci i ze zrzutu). */
export function przelicz(d: ZebraneDane, opts: { mapa?: MapaCzlowieka; registry: Pick<AdapterRegistry, 'get'>; rules?: CatalogRules }): Przeliczenie {
  const mapa = opts.mapa ?? PUSTA_MAPA
  const plan = planuj({
    konfiguracja: d.konfiguracja,
    katalog: d.katalogArg ?? undefined,
    mapa,
    zamowienia: [...d.zamowienia.otwarte, ...d.zamowienia.ostatnie],
    registry: opts.registry,
  })
  const analiza = d.katalog ? analyze(d.katalog, [], opts.rules) : null
  const otwartePoStatusie = new Map<string, number>()
  for (const o of d.zamowienia.otwarte) otwartePoStatusie.set(o.order_status_id, (otwartePoStatusie.get(o.order_status_id) ?? 0) + 1)
  const pobrane = new Set(d.statusyPobrane)
  const statusyNiepobrane = statusyOtwarte(plan.statusy).filter((id) => !pobrane.has(id))
  return { plan, analiza, otwartePoStatusie, statusyNiepobrane }
}

/** Zamówienia do przeniesienia: otwarte wg bieżącej mapy, ze źródła, które nie jest pominięte. */
export function zamowieniaDoPrzeniesienia(d: ZebraneDane, plan: PlanKonfiguracji): { o: BlZamowienie; konto: NonNullable<ReturnType<typeof kontoZamowienia>> }[] {
  const open = new Set(statusyOtwarte(plan.statusy))
  const out: { o: BlZamowienie; konto: NonNullable<ReturnType<typeof kontoZamowienia>> }[] = []
  for (const o of [...d.zamowienia.otwarte].sort((a, b) => Number(a.order_id) - Number(b.order_id))) {
    if (!open.has(o.order_status_id)) continue
    const konto = kontoZamowienia(plan, o)
    if (konto && !konto.pominiete) out.push({ o, konto })
  }
  return out
}
