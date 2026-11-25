// Host zapisu na kanały sprzedaży. Jedno miejsce, które decyduje, CZY i CO wychodzi do kanału:
//   - stany: adapter zapisu stanów dla `runStockPush` (rdzeń liczy targety i kolejkę, tu tylko wysyłka przez
//     `executeWrite` z deterministyczną referencją; wynik per oferta);
//   - statusy i numery nadania: wiersze `ChannelWrite` planowane ze stanu zamówień i zdarzeń, wykonywane przez worker.
// Warunki wyjścia czegokolwiek do kanału (wszystkie naraz): konto aktywne, tryb PRACA danego rodzaju (stockMode,
// statusMode, trackingMode), adapter z daną zdolnością zapisu i `zapisWlaczony: true` w konfiguracji konta. Brak
// któregokolwiek = zero żądań do kanału; w cieniu tylko ślad „wysłałbym” (ChannelPushLog / ChannelWrite CIEN).
// Wyniki zapisu: OK; PRZEJSCIOWY = ponowienie z odstępem; TRWALY = alert, bez ponowienia; NIEJEDNOZNACZNY (po
// odszukaniu po referencji dalej nie wiadomo) = alert, bez ponowienia — ponawia człowiek przyciskiem „Wypchnij teraz”.
// Zachowanie kanału (mapa statusów, słownik statusów, model stanu) bierzemy z manifestu adaptera, nie z rdzenia.
// Bez danych klientów: w wierszach, alertach i logach są tylko numery zamówień, statusy i numery nadania.
// status firmy może nadpisać status w kanale (`config.statusyFirmy`: klucz statusu firmy → status kanału).
// Bez wpisu idzie wartość z mapy enumu jak dotąd. Wiersz z nadpisaniem ma klucz `F:<klucz statusu firmy>`; anulowanie
// nieopłaconego po terminie (osłona płatności) nadpisania nie bierze.
import type { Carrier, Channel, ChannelMode, OrderStatus, Prisma, PrismaClient } from '@prisma/client'
import { parseMapaStatusowFirmy, wybierzStatusFirmy, type StatusFirmyT } from '@/lib/panel/statusy'
import { statusyFirmy } from '@/lib/panel/statusy-firmy-dane'
import { organizationIdOf } from '../db'
import { BEZ_STANU_Z_PUNKTU_CIECIA } from './zamkniete-przy-przejsciu'
import { createAccountAdapter, loadChannelAccounts, type ChannelAccountSettings } from '../adaptery/konta'
import {
  type AdapterContext,
  type AdapterManifest,
  type Capability,
  type ChannelAdapter,
  type FailureKind,
  hasOrderStatusWriter,
  hasStockImportStatus,
  hasStockWriter,
  hasTrackingWriter,
  etapDoSklepu,
  POWOD_ETAPU_POZA_SKLEPEM,
  STATUS_MAP_KEYS,
  type StatusMap,
  type StatusMapKey,
  type WriteOutcome,
  WYSTAWIANIE_OFERT_KLUCZ,
  wystawianieOfertWlaczone,
} from '../adaptery/kontrakt'
import { type AdapterRegistry, deriveReference, rodzinaAdaptera } from '../adaptery/rejestr'
import { executeWrite } from '../adaptery/zapis'
import { ODLOZENIE_WYLACZONEGO_MS } from '../integracje/oslona'
import type { SecretSource } from '../sekrety'
import type { FetchLike } from '../zrodla/http'
import { type AdapterStanow, type ChannelAccount, fullSyncChannel, type PushItem, type PushStats, runStockPush } from '../rdzen/propagacja'
import { alert } from '../rdzen/stan'
import { ostatnieImporty, type WierszImportu, zamknijOtwarteImporty, zapiszPrzyjetyImport } from './importy-stanow'
import { automatyWysylki } from '../wysylka/automaty'
import { dziennikStanuZerowego, kontoKonczyPrzyZerze, pozycjeDlaAdaptera, type WpisDziennika, zapiszPublikacje } from './stan-zerowy-host'
import { limitZakonczen } from '../adaptery/stan-zerowy'
import { linkSledzenia } from '../wysylka/link-sledzenia'
import { KLUCZ_PELNY_ZAPIS, PELNY_ZAPIS_MAX_GODZ, PELNY_ZAPIS_MIN_GODZ, pelnyZapisCoGodz, planujZapis, uniewaznijKonto, zapiszWyniki } from './rejestr-synchronizacji'

/**
 * Zdarzenie „numer nadania gotowy” (uzgodnione, log zadań 06.11): wiersz AuditLog z `entity` = ta nazwa,
 * `entityId` = id przesyłki, `after = { shipmentId, orderId, packageNo, carrier, trackingNumber, adapterKey }`. Emituje
 * host przesyłek (`zglosNumerNadania` w lib/wysylka/zdarzenia.ts); tu tylko odczyt.
 */
export const ZDARZENIE_NUMER_NADANIA = 'NUMER_NADANIA_GOTOWY'
/** Zadanie workera: zaplanowanie i wykonanie zapisów statusów i numerów nadania. */
export const ZAPIS_KANALOW_JOB = 'kanaly-zapis'
/** alert dla biura — anulowanie nieopłaconego trzeba zrobić ręcznie w sklepie. */
export const ALERT_ANULOWANIE_RECZNE = 'KANAL_ANULUJ_RECZNIE'

/** Okno planowania: zamówienia zmienione i zdarzenia nadania z ostatnich 2 dób (starsze nie wracają do kanału same). */
export const OKNO_PLANOWANIA_MS = 2 * 24 * 3600_000
const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000]
const MAX_PROB = 8
/** Wiersz w WYSYLANIE dłużej niż tyle = przebieg padł w trakcie zapisu: nie wiadomo, czy kanał zapisał. */
const PORZUCONY_MS = 10 * 60_000
/** Wierszy na jedno zajęcie (mała paczka, żeby zajęcie nie starzało się w kolejce). */
const PACZKA = 10
/** Najdłuższy przebieg wykonania (kolejne paczki), potem następny przebieg workera. */
const PRZEBIEG_MS = 4 * 60_000
const NUMER_NADANIA_RE = /^[A-Za-z0-9-]{4,64}$/

export const ETYKIETY_KLUCZY: Record<StatusMapKey, string> = {
  DO_REALIZACJI: 'Do realizacji',
  ZBIERANIE: 'Zbieranie',
  SPAKOWANE: 'Spakowane',
  DO_WYSLANIA: 'Do wysłania',
  DO_ODBIORU: 'Do odbioru',
  WYSLANE: 'Wysłane',
  ODEBRANE: 'Odebrane',
  ANULOWANE: 'Anulowane',
  ANULOWANE_NIEOPLACONE: 'Anulowane: brak płatności w terminie',
}

// ─── Konto i adapter ─────────────────────────────────────────────────────────

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const CHANNEL_STATUS_RE = /^[A-Za-z0-9_-]{1,40}$/

/** Mapa statusów z konfiguracji konta (`config.statusy`) po walidacji; złe wpisy pominięte. */
export function parseMapaStatusow(raw: unknown): StatusMap {
  const out: StatusMap = {}
  for (const [k, v] of Object.entries(asObject(raw))) {
    if ((STATUS_MAP_KEYS as readonly string[]).includes(k) && typeof v === 'string' && CHANNEL_STATUS_RE.test(v.trim())) out[k as StatusMapKey] = v.trim()
  }
  return out
}

/**
 * wartość statusu kanału w pisowni słownika kanału (`channelStatuses`), porównanie bez wielkości liter:
 * „shipped” → „SHIPPED” (Empik), „sent” → „SENT” (Allegro). Spoza słownika (np. własny status wtyczki Woo) bez zmian.
 * Jedno miejsce dla zapisu mapy z panelu, odczytu mapy konta i wykonania zaplanowanego zapisu (stare wiersze kolejki).
 */
export function kanonicznyStatusKanalu(v: string, manifest: AdapterManifest | null | undefined): string {
  const t = v.trim()
  const lista = manifest?.channelBehavior?.channelStatuses
  if (!lista) return t
  const lower = t.toLowerCase()
  return lista.find((s) => s.id.toLowerCase() === lower)?.id ?? t
}

/** wszystkie wartości mapy (enum albo statusy firmy) w pisowni słownika kanału. */
export function kanonicznaMapa<T extends Record<string, string | undefined>>(mapa: T, manifest: AdapterManifest | null | undefined): T {
  return Object.fromEntries(Object.entries(mapa).map(([k, v]) => [k, typeof v === 'string' ? kanonicznyStatusKanalu(v, manifest) : v])) as T
}

/** Mapa konta: własna (`config.statusy`, także pusta = nic nie wysyłamy) albo domyślna z manifestu (preset). */
export function mapaStatusow(config: Record<string, unknown>, manifest: AdapterManifest | null | undefined): { mapa: StatusMap; wlasna: boolean } {
  // mapa zapisana z panelu przed poprawką ma wartości małymi literami („shipped”): pisownia ze słownika kanału
  if (config['statusy'] !== undefined) return { mapa: kanonicznaMapa(parseMapaStatusow(config['statusy']), manifest), wlasna: true }
  return { mapa: { ...(manifest?.channelBehavior?.defaultStatusMap ?? {}) }, wlasna: false }
}

/** Czy konto ma włączony zapis (wyłącznik w konfiguracji). */
export const zapisWlaczony = (config: Record<string, unknown>) => config['zapisWlaczony'] === true

/** Klucz wersji adaptera z zapisem („woo.rest.v1” → „woo.rest.zapis.v1”), gdy taka jest w rejestrze. */
export function kluczZZapisem(registry: AdapterRegistry, adapterKey: string): string | null {
  if (/\.zapis\.v\d+$/.test(adapterKey)) return adapterKey
  const k = adapterKey.replace(/\.v(\d+)$/, '.zapis.v$1')
  return k !== adapterKey && registry.get(k) ? k : null
}

/** klucz wersji tylko do odczytu („woo.rest.zapis.v1” → „woo.rest.v1”), gdy taka jest w rejestrze. */
export function kluczTylkoOdczyt(registry: AdapterRegistry, adapterKey: string): string | null {
  const k = rodzinaAdaptera(adapterKey)
  return k !== adapterKey && registry.get(k) ? k : null
}

export interface HostCtx {
  registry: AdapterRegistry
  secrets: SecretSource
  now?: Date
  fetch?: FetchLike
  /** Odstęp i ponowienia klienta HTTP adapterów (testy na atrapach: `{ minIntervalMs: 0 }`). */
  http?: AdapterContext['http']
}

/** początek powodu blokady konta wyłączonego po błędach (wiersze zapisu czekają, nie przechodzą w błąd). */
export const POWOD_WYLACZONE_PO_BLEDACH = 'integracja wyłączona po błędach: popraw połączenie i kliknij „Włącz ponownie” w szczegółach konta'

/** Powód, dla którego konto nie zapisze danego rodzaju (null = zapisze). Teksty dla człowieka, bez żargonu. */
export function powodBlokady(
  acc: Pick<ChannelAccountSettings, 'active' | 'config' | 'wylaczonePoBledach'>,
  mode: ChannelMode,
  manifest: AdapterManifest | null | undefined,
  zdolnosc: Capability,
): string | null {
  if (!acc.active) return 'konto wyłączone'
  if (acc.wylaczonePoBledach) return `${POWOD_WYLACZONE_PO_BLEDACH} (${acc.wylaczonePoBledach})`
  if (!manifest) return 'ten rodzaj konta nie ma jeszcze adaptera'
  if (!manifest.capabilities.includes(zdolnosc) || manifest.readOnly) return 'ten rodzaj konta tylko czyta ze sklepu (wybierz wersję z zapisem)'
  if (mode !== 'PRACA') return 'konto w trybie podglądu: liczymy, co byśmy wysłali, ale nic nie wychodzi'
  if (!zapisWlaczony(acc.config)) return 'zapis do sklepu wyłączony w ustawieniach konta'
  return null
}

/** powód braku zapisu stanów na koncie pracującym bez stanów (statusy w pracy, stany w podglądzie). */
export const POWOD_PRACA_BEZ_STANOW = 'konto pracuje bez stanów: stany ofert wysyła dotychczasowy system, Kompletor tylko liczy, co by wysłał'

/** Powód braku zapisu stanów dla ekranu konta: przy pracy bez stanów zamiast ogólnego „konto w trybie podglądu”. */
export function powodStanow(
  acc: Pick<ChannelAccountSettings, 'active' | 'config' | 'wylaczonePoBledach'>,
  tryby: { stockMode: ChannelMode; statusMode: ChannelMode; trackingMode: ChannelMode },
  manifest: AdapterManifest | null | undefined,
): string | null {
  const p = powodBlokady(acc, tryby.stockMode, manifest, 'stock.write')
  // układ jak `trybKonta` = BEZ_STANOW (lib/kanaly/tryb.ts); inny układ mieszany zostaje przy ogólnym powodzie.
  // Podmieniamy tylko powód z trybu: gdy w PRACA powód byłby inny, to tryb zatrzymał zapis (wcześniejsze bramki wygrywają)
  const bezStanow = tryby.stockMode === 'CIEN' && tryby.statusMode === 'PRACA' && tryby.trackingMode === 'PRACA'
  if (p && bezStanow && powodBlokady(acc, 'PRACA', manifest, 'stock.write') !== p) return POWOD_PRACA_BEZ_STANOW
  return p
}

const accLabel = (a: { channel: Channel; channelAccountId: string }) => `${a.channel}/${a.channelAccountId}`
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500)
/** Opcje adaptera z kontekstu hosta (fetch i klient HTTP wstrzyknięte w testach). */
// zegar hosta (testy) także dla limitów tempa i licznika błędów osłony; w produkcji bieżący czas
const adapterOpts = (ctx: HostCtx) => ({ ...(ctx.fetch ? { fetch: ctx.fetch } : {}), ...(ctx.http ? { http: ctx.http } : {}), ...(ctx.now ? { oslona: { now: () => ctx.now! } } : {}) })

/** Konto w PRACA, które z powodu konfiguracji nie może zapisać stanów (to nie jest awaria kanału). */
export interface StanyZablokowane {
  zablokowane: string
}

/**
 * Adapter zapisu stanów konta dla `runStockPush` (pkt 1). Konto w cieniu = null (rdzeń zapisuje „wysłałbym”).
 * Konto w PRACA bez możliwości zapisu = `{ zablokowane: powód }`: host nie woła wtedy `runStockPush` (przegląd
 * bez alertu „kanał niedostępny” i bez ponowień), tylko wpisuje powód do jobów (`wyslijStanyKonta`).
 * Adapter kanału (odszyfrowanie sekretów) powstaje dopiero przy pierwszej paczce.
 */
export async function adapterStanowKonta(db: PrismaClient, acc: ChannelAccount, ctx: HostCtx): Promise<AdapterStanow | StanyZablokowane | null> {
  const cfg = await db.channelConfig.findFirst({ where: { channel: acc.channel, channelAccountId: acc.channelAccountId } })
  if (!cfg || cfg.stockMode !== 'PRACA') return null
  const settings = (await loadChannelAccounts(db, { activeOnly: false })).find((a) => a.channel === acc.channel && a.channelAccountId === acc.channelAccountId)
  if (!settings) return { zablokowane: 'brak konta' }
  const why = powodBlokady(settings, cfg.stockMode, ctx.registry.get(settings.adapterKey)?.manifest, 'stock.write')
  if (why) return { zablokowane: why }
  const organizationId = organizationIdOf(db)
  let adapter: ChannelAdapter | null = null
  return {
    async push(all: PushItem[]) {
      // rejestr synchronizacji — oferty z treścią jak w ostatnim udanym zapisie nie idą do kanału
      const now = ctx.now ?? new Date()
      const plan = await planujZapis(db, acc, all, { adapterKey: settings.adapterKey, now, pelnyZapisCoGodz: pelnyZapisCoGodz(settings.config) })
      const skipped = plan.pominiete.map((i) => ({ offerId: i.offerId, ok: true, skipped: true }))
      const items = plan.doWyslania
      if (!items.length) return skipped
      if (!adapter) {
        try {
          adapter = await createAccountAdapter(db, ctx.registry, settings, ctx.secrets, adapterOpts(ctx))
        } catch (e) {
          const results = items.map((i) => ({ offerId: i.offerId, ok: false, kind: 'TRWALY' as const, error: `nic nie wysłano: zła konfiguracja konta: ${msg(e)}` }))
          await zapiszWyniki(db, acc, plan, results, { now })
          return [...skipped, ...results]
        }
      }
      const a = adapter
      if (!hasStockWriter(a)) {
        const results = items.map((i) => ({ offerId: i.offerId, ok: false, kind: 'TRWALY' as const, error: 'nic nie wysłano: adapter nie zapisuje stanów' }))
        await zapiszWyniki(db, acc, plan, results, { now })
        return [...skipped, ...results]
      }
      // referencja z treści paczki: ta sama paczka (ponowienie) = ta sama referencja, więc kanał nie zapisze jej dwa razy
      const parts = [...items].map((i) => `${i.externalId}=${i.targetQty}`).sort()
      const reference = deriveReference([organizationId, acc.channel, acc.channelAccountId, 'stany', ...parts])
      // znacznik „zakończona przez Kompletor” i dobowy bezpiecznik zakończeń (kanały z ustawieniem stanu 0)
      const konczy = kontoKonczyPrzyZerze(settings.config, ctx.registry.get(settings.adapterKey)?.manifest.config)
      const poz = await pozycjeDlaAdaptera(db, acc, items, { konczy, config: settings.config, now })
      const wi = poz.wi
      let out: WriteOutcome
      try {
        out = await executeWrite(a, reference, () => a.pushStock(wi, reference))
      } catch (e) {
        // skróty skasowane jeszcze przed wysłaniem (planujZapis); wpis błędu, wyjątek dalej do rdzenia jak dawniej
        await zapiszWyniki(db, acc, plan, items.map((i) => ({ offerId: i.offerId, ok: false, error: msg(e) })), { now, reference })
        throw e
      }
      // kanał przyjął plik, a wynik poda później (Mirakl STO01): zapis do odczytu wyniku. Błąd zapisu tego
      // wiersza nie zmienia wyniku wysyłki (stany wyszły), trafia do logu workera. Odrzucone wiersze kasują skróty
      // rejestru po referencji (lib/kanaly/importy-stanow.ts).
      if (out.externalRef && hasStockImportStatus(a)) {
        try {
          await zapiszPrzyjetyImport(db, acc, { externalRef: out.externalRef, reference, wierszy: items.length - (out.kind === 'OK' ? 0 : (out.failedItems?.length ?? items.length)) }, now)
        } catch (e) {
          console.error(`[kanaly-zapis] ${accLabel(acc)}: nie zapisano importu stanów do sprawdzenia: ${msg(e)}`)
        }
      }
      if (konczy) await zapiszPublikacje(db, acc, items, out, poz, now)
      const results = wynikiPerOferta(items, out)
      await zapiszWyniki(db, acc, plan, results, { now, reference })
      return [...skipped, ...results]
    },
  }
}

/**
 * Jeden przebieg wysyłki stanów konta (zadanie workera). Konto zablokowane konfiguracją: tylko powód w jobach konta
 * (bez prób, bez zdrowia kanału, bez alertu), żeby ekran konta mówił, dlaczego stany nie wychodzą.
 */
export async function wyslijStanyKonta(db: PrismaClient, acc: ChannelAccount, ctx: HostCtx): Promise<PushStats | StanyZablokowane> {
  const ad = await adapterStanowKonta(db, acc, ctx)
  if (ad && 'zablokowane' in ad) {
    await db.stockSyncJob.updateMany({ where: { channel: acc.channel, channelAccountId: acc.channelAccountId }, data: { lastError: `nic nie wysłano: ${ad.zablokowane}` } })
    return ad
  }
  return runStockPush(db, acc, ad, ctx.now ? { now: ctx.now } : {})
}

/** Wynik paczki → wynik per oferta: pozycje spoza `failedItems` przeszły; bez `failedItems` cała paczka ma wynik paczki. */
export function wynikiPerOferta(items: PushItem[], out: WriteOutcome): { offerId: string; ok: boolean; error?: string; kind?: FailureKind; retryAfterMs?: number; odlozone?: boolean; odstaw?: boolean }[] {
  if (out.kind === 'OK') return items.map((i) => ({ offerId: i.offerId, ok: true }))
  const failed = out.failedItems ? new Map(out.failedItems.map((f) => [f.offerExternalId, f])) : null
  // czas ponowienia i „odłożone” idą do hosta stanów (job czeka, próba się nie liczy)
  const extra = { ...(out.retryAfterMs ? { retryAfterMs: out.retryAfterMs } : {}), ...(out.odlozone ? { odlozone: true } : {}) }
  return items.map((i) => {
    if (!failed) return { offerId: i.offerId, ok: false, kind: out.kind, error: out.message, ...extra }
    const f = failed.get(i.externalId)
    return f ? { offerId: i.offerId, ok: false, kind: f.kind, error: f.message, ...(f.odstaw ? { odstaw: true } : {}) } : { offerId: i.offerId, ok: true }
  })
}

// ─── Planowanie zapisów statusów i numerów nadania ───────────────────────────

interface KontoPlan {
  settings: ChannelAccountSettings
  manifest: AdapterManifest | null
  mapa: StatusMap
  /** status firmy → status w kanale (nadpisanie wartości z mapy enumu) */
  mapaFirmy: Record<string, string>
  statusMode: ChannelMode
  trackingMode: ChannelMode
}

async function kontaDoPlanu(db: PrismaClient, registry: AdapterRegistry): Promise<Map<string, KontoPlan>> {
  const rows = await db.channelConfig.findMany({ where: { active: true }, select: { channel: true, channelAccountId: true, statusMode: true, trackingMode: true } })
  const modes = new Map(rows.map((r) => [accLabel(r), r]))
  const out = new Map<string, KontoPlan>()
  for (const s of await loadChannelAccounts(db)) {
    const m = modes.get(accLabel(s))
    if (!m) continue
    const manifest = registry.get(s.adapterKey)?.manifest ?? null
    out.set(accLabel(s), { settings: s, manifest, mapa: mapaStatusow(s.config, manifest).mapa, mapaFirmy: kanonicznaMapa(parseMapaStatusowFirmy(s.config['statusyFirmy']), manifest), statusMode: m.statusMode, trackingMode: m.trackingMode })
  }
  return out
}

/** Klucz mapy dla zamówienia: status, a anulowanie nieopłaconego po terminie osobno (gdy adapter umie sprawdzić płatność). */
export function kluczZamowienia(o: { status: OrderStatus; cancelReason: string | null }, manifest: AdapterManifest | null): StatusMapKey | null {
  if (o.status === 'ANULOWANE' && o.cancelReason === 'EXPIRED_UNPAID') return manifest?.channelBehavior?.unpaidGuard ? 'ANULOWANE_NIEOPLACONE' : null
  return (STATUS_MAP_KEYS as readonly string[]).includes(o.status) ? (o.status as StatusMapKey) : null
}

/** Prefiks klucza wiersza ze statusem firmy. */
export const KLUCZ_FIRMY = 'F:'

/**
 * klucz i status kanału zapisu statusu: nadpisanie statusu firmy (`F:<klucz>`) albo wartość z mapy enumu.
 * null = nic nie wysyłamy. Anulowanie nieopłaconego po terminie zawsze z mapy enumu (osłona płatności w kanale).
 */
export function zapisStatusu(
  o: { status: OrderStatus; cancelReason: string | null; carrier: Carrier | null; companyStatus: string | null },
  k: { mapa: StatusMap; mapaFirmy: Record<string, string>; manifest: AdapterManifest | null },
  defs: readonly StatusFirmyT[],
): { key: string; channelStatus: string } | null {
  const key = kluczZamowienia(o, k.manifest)
  const zMapy = key && k.mapa[key] ? { key, channelStatus: k.mapa[key]! } : null
  if (o.status === 'ANULOWANE' && o.cancelReason === 'EXPIRED_UNPAID') return zMapy
  const d = defs.length ? wybierzStatusFirmy(defs, o) : null
  // status firmy z etapu spoza ETAPY_DO_SKLEPU (np. nieopłacone „Nowe”) nie idzie do sklepu
  // nawet z nadpisaniem w mapie konta
  const nad = d && etapDoSklepu(d.baseStatus) ? k.mapaFirmy[d.key] : undefined
  if (d && nad) return { key: `${KLUCZ_FIRMY}${d.key}`, channelStatus: nad }
  return zMapy
}

const refZapisu = (organizationId: string, kind: 'STATUS' | 'NADANIE', orderId: string, key: string) => deriveReference([organizationId, 'kanal-zapis', kind, orderId, key])

export interface PlanStats {
  statusy: number
  nadania: number
  /** alerty „anuluj ręcznie w sklepie” (sklep, który nie przyjmie anulowania nieopłaconego z Kompletora). */
  anulowaniaReczne?: number
  /** Błędy planowania per konto (bez danych klientów); jedno konto nie zatrzymuje reszty. */
  bledyPlanu: string[]
}

/**
 * pkt 2: wiersze `ChannelWrite` dla zamówień, których status jest w mapie konta, i dla numerów nadania (zdarzenie
 * NUMER_NADANIA_GOTOWY albo numer wpisany przy „Wysłane”). Idempotentne: unikalność (zamówienie, rodzaj, klucz) +
 * `skipDuplicates`. Tylko konta, których adapter ma zdolność zapisu danego rodzaju; konto w cieniu = wiersz CIEN.
 */
export async function zaplanujZapisy(db: PrismaClient, registry: AdapterRegistry, ctx: { now?: Date } = {}): Promise<PlanStats> {
  const now = ctx.now ?? new Date()
  const since = new Date(now.getTime() - OKNO_PLANOWANIA_MS)
  const organizationId = organizationIdOf(db)
  const konta = await kontaDoPlanu(db, registry)
  // „Anuluj nieopłacone także w sklepie” (Ustawienia → Przewoźnicy); wyłączone = anulowanie tylko u nas
  const automaty = await automatyWysylki(db)
  const anulowanieWKanale = automaty.anulowanieWKanale
  const stats: PlanStats = { statusy: 0, nadania: 0, anulowaniaReczne: 0, bledyPlanu: [] }
  // statusy firmy tylko, gdy któreś konto ma nadpisanie (inaczej bez zapytania)
  const defs = [...konta.values()].some((k) => Object.keys(k.mapaFirmy).length) ? (await statusyFirmy(db)).statusy : []
  const row: RowFn = (k, orderId, kind, key, extra) => {
    const mode = kind === 'STATUS' ? k.statusMode : k.trackingMode
    return {
      orderId,
      channel: k.settings.channel,
      channelAccountId: k.settings.channelAccountId,
      kind,
      key,
      mode,
      state: mode === 'PRACA' ? 'OCZEKUJE' : 'CIEN',
      reference: refZapisu(organizationId, kind, orderId, key),
      nextAttemptAt: now,
      createdAt: now,
      ...(mode === 'PRACA' ? {} : { doneAt: now }),
      ...extra,
    }
  }
  // statusy
  for (const k of konta.values()) {
    if (!k.manifest?.capabilities.includes('order.status.write') || k.manifest.readOnly) continue
    // konto w PRACA, które i tak nie zapisze (np. zapis wyłączony) — bez wierszy; po włączeniu
    // zapisu okno 2 dób samo ogranicza, co pójdzie do sklepu. Konto w cieniu dalej dostaje „wysłałbym”.
    if (k.statusMode === 'PRACA' && powodBlokady(k.settings, 'PRACA', k.manifest, 'order.status.write')) continue
    const keys = Object.keys(k.mapa) as StatusMapKey[]
    const bazyFirmy = defs.filter((d) => k.mapaFirmy[d.key] && etapDoSklepu(d.baseStatus)).map((d) => d.baseStatus)
    if (!keys.length && !bazyFirmy.length) continue
    try {
    const statuses = [...new Set([...keys.map((x) => (x === 'ANULOWANE_NIEOPLACONE' ? 'ANULOWANE' : x)), ...bazyFirmy])] as OrderStatus[]
    const orders = await db.order.findMany({
      // zamknięte przy przejściu z BaseLinkera w stanie z chwili cięcia: ten status w sklepie ustawił BaseLinker (zamknięcie
      // tylko podbiło updatedAt); późniejsze przejście w Kompletorze idzie do sklepu normalnie
      where: { channel: k.settings.channel, channelAccountId: k.settings.channelAccountId, updatedAt: { gte: since }, status: { in: statuses }, ...BEZ_STANU_Z_PUNKTU_CIECIA },
      select: { id: true, status: true, cancelReason: true, carrier: true, companyStatus: true },
      take: 5000,
    })
    const data: Prisma.ChannelWriteCreateManyInput[] = []
    for (const o of orders) {
      const z = zapisStatusu(o, k, defs)
      if (!z) continue
      // „Anuluj nieopłacone także w sklepie” wyłączone = anulowanie po terminie tylko u nas
      if (z.key === 'ANULOWANE_NIEOPLACONE' && !anulowanieWKanale) continue
      data.push(row(k, o.id, 'STATUS', z.key, { channelStatus: z.channelStatus }))
    }
    if (data.length) stats.statusy += (await db.channelWrite.createMany({ data, skipDuplicates: true })).count
    } catch (e) {
      stats.bledyPlanu.push(`statusy ${accLabel(k.settings)}: ${msg(e)}`)
    }
  }
  // numery nadania: zdarzenie NUMER_NADANIA_GOTOWY (przesyłka utworzona) albo numer wpisany przy „Wysłane”
  try {
    stats.nadania += await zaplanujNadania(db, konta, since, row, automaty.linkSledzeniaDoSklepu)
  } catch (e) {
    stats.bledyPlanu.push(`numery nadania: ${msg(e)}`)
  }
  // anulowane nieopłacone na kontach, które zapisują statusy, a sklep nie przyjmie anulowania → alert dla biura
  if (anulowanieWKanale) {
    for (const k of konta.values()) {
      try {
        stats.anulowaniaReczne! += await alertyAnulowaniaRecznego(db, k, since)
      } catch (e) {
        stats.bledyPlanu.push(`anulowanie w sklepie ${accLabel(k.settings)}: ${msg(e)}`)
      }
    }
  }
  return stats
}

/** Kanały bez sklepu po drugiej stronie (zamówienia ręczne, API, dostawca AI): nie ma czego anulować. */
const BEZ_SKLEPU: readonly Channel[] = ['RECZNE', 'AI']

/**
 * Dlaczego anulowanie nieopłaconego po terminie nie pójdzie do sklepu tego konta, choć konto zapisuje statusy (null =
 * pójdzie przez host albo konto i tak nic nie zapisuje). Teksty dla biura, bez żargonu.
 * (wariant A): przeszkodą musi być sam kanał (brak sprawdzenia płatności przed anulowaniem albo brak
 * statusu w mapie konta). Konto zablokowane konfiguracją (wyłączone, zapis wyłączony, moduł tylko do odczytu, brak
 * adaptera, podgląd) = null, tak jak bez wierszy zapisu: w okresie przejścia takim sklepem rządzi BaseLinker i to on
 * anuluje zamówienie, więc polecenie „anuluj ręcznie” byłoby fałszywe, a alert na każde zamówienie zalałby biuro.
 */
export function powodAnulowaniaRecznego(k: Pick<KontoPlan, 'settings' | 'manifest' | 'mapa' | 'statusMode'>): string | null {
  if (powodBlokady(k.settings, k.statusMode, k.manifest, 'order.status.write')) return null
  if (!k.manifest?.channelBehavior?.unpaidGuard) return 'ten sklep nie pozwala bezpiecznie anulować nieopłaconego zamówienia z Kompletora'
  if (!k.mapa.ANULOWANE_NIEOPLACONE) return 'w ustawieniach konta nie ma statusu sklepu dla „Anulowane: brak płatności w terminie”'
  return null
}

/**
 * Konto w trybie aktywnym z włączonym zapisem (statusy prowadzi Kompletor), którego sklep nie przyjmie anulowania
 * nieopłaconego: jeden alert na zamówienie (klucz zamówienia), żeby biuro anulowało ręcznie, zanim klient zapłaci za
 * zwolniony towar. Konto w podglądzie albo z wyłączonym zapisem: nic (sklepem i statusami rządzi BaseLinker).
 */
async function alertyAnulowaniaRecznego(db: PrismaClient, k: KontoPlan, since: Date): Promise<number> {
  if (k.statusMode !== 'PRACA' || BEZ_SKLEPU.includes(k.settings.channel)) return 0
  const powod = powodAnulowaniaRecznego(k)
  if (!powod) return 0
  const orders = await db.order.findMany({
    where: { channel: k.settings.channel, channelAccountId: k.settings.channelAccountId, status: 'ANULOWANE', cancelReason: 'EXPIRED_UNPAID', updatedAt: { gte: since } },
    select: { id: true, externalId: true, channelNumber: true },
    take: 500,
  })
  for (const o of orders) {
    await alert(
      db,
      ALERT_ANULOWANIE_RECZNE,
      accLabel(k.settings),
      `Sklep ${accLabel(k.settings)}, zamówienie ${o.channelNumber ?? o.externalId}: anulowane w Kompletorze (brak płatności w terminie), w sklepie dalej czeka na płatność. Anuluj je ręcznie w sklepie, żeby klient nie zapłacił za zwolniony towar. Powód: ${powod}.`,
      `anulowanie-recznie:${o.id}`,
    )
  }
  return orders.length
}

type RowFn = (k: KontoPlan, orderId: string, kind: 'STATUS' | 'NADANIE', key: string, extra: Partial<Prisma.ChannelWriteCreateManyInput>) => Prisma.ChannelWriteCreateManyInput

/**
 * Adresy stron śledzenia dla numerów nadania (`orderId|numer` → link), z przesyłki utworzonej w Kompletorze; link tylko
 * z modułu samego przewoźnika (lib/wysylka/link-sledzenia.ts). Plan woła to wyłącznie przy włączonym „Wysyłaj do sklepu
 * link do śledzenia paczki”: link trafia do sklepu razem z numerem (np. notatka zamówienia Woo, adres przewoźnika w Empiku).
 */
async function linkiSledzenia(db: PrismaClient, pary: { orderId: string; nr: string }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!pary.length) return out
  const rows = await db.shipment.findMany({
    where: { orderId: { in: [...new Set(pary.map((x) => x.orderId))] }, trackingNumber: { in: [...new Set(pary.map((x) => x.nr))] }, state: 'UTWORZONA', extraNo: 0 },
    select: { orderId: true, trackingNumber: true, carrier: true, adapterKey: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  for (const s of rows) {
    const link = linkSledzenia(s.carrier, s.trackingNumber, s.adapterKey)
    if (link && s.trackingNumber) out.set(`${s.orderId}|${s.trackingNumber}`, link)
  }
  return out
}

async function zaplanujNadania(db: PrismaClient, konta: Map<string, KontoPlan>, since: Date, row: RowFn, linkDoSklepu = false): Promise<number> {
  // żadne konto nie zapisuje numerów nadania (sklepy tylko do odczytu): bez zapytania co 30 s
  if (![...konta.values()].some((k) => k.manifest?.capabilities.includes('order.tracking.write') && !k.manifest.readOnly)) return 0
  const events = await db.$queryRaw<{ orderId: string; channel: Channel; channelAccountId: string; nadanie: string | null; przewoznik: string | null; url: string | null; carrier: string | null }[]>`
    SELECT o.id AS "orderId", o.channel, o."channelAccountId", x.nadanie, x.przewoznik, x.url, o.carrier::text AS carrier
    FROM (
      SELECT a.after->>'orderId' AS "orderId", a.after->>'trackingNumber' AS nadanie, a.after->>'carrier' AS przewoznik, a.after->>'url' AS url, a."createdAt"
      FROM "AuditLog" a WHERE a.entity = ${ZDARZENIE_NUMER_NADANIA} AND a."createdAt" >= ${since}
        -- numer anulowanej przesyłki nie idzie do kanału
        AND NOT EXISTS (SELECT 1 FROM "Shipment" s WHERE s.id = a."entityId" AND s.state = 'ANULOWANA')
      UNION ALL
      SELECT e."orderId", e.data->>'nadanie', e.data->>'przewoznik', e.data->>'url', e."createdAt"
      FROM "OrderEvent" e WHERE e.kind = 'WYSLANE' AND e."createdAt" >= ${since} AND jsonb_typeof(e.data) = 'object' AND e.data ? 'nadanie'
    ) x JOIN "Order" o ON o.id = x."orderId"
    ORDER BY x."createdAt" LIMIT 5000`
  const data: Prisma.ChannelWriteCreateManyInput[] = []
  // wyłączone (domyślnie) = bez zapytania o przesyłki: do sklepu idzie sam numer, jak przed dodaniem linków
  const linki = linkDoSklepu ? await linkiSledzenia(db, events.filter((e) => !e.url && e.nadanie?.trim()).map((e) => ({ orderId: e.orderId, nr: e.nadanie!.trim() }))) : new Map<string, string>()
  for (const e of events) {
    const k = konta.get(accLabel(e))
    const nr = e.nadanie?.trim() ?? ''
    if (!k || !NUMER_NADANIA_RE.test(nr)) continue
    if (!k.manifest?.capabilities.includes('order.tracking.write') || k.manifest.readOnly) continue
    if (k.trackingMode === 'PRACA' && powodBlokady(k.settings, 'PRACA', k.manifest, 'order.tracking.write')) continue
    const url = e.url && /^https:\/\/\S{1,300}$/i.test(e.url) ? e.url : (linki.get(`${e.orderId}|${nr}`) ?? null)
    data.push(row(k, e.orderId, 'NADANIE', nr, { carrier: (e.przewoznik || e.carrier || 'BRAK').slice(0, 40), trackingUrl: url }))
  }
  return data.length ? (await db.channelWrite.createMany({ data, skipDuplicates: true })).count : 0
}

// ─── Wykonanie zapisów ───────────────────────────────────────────────────────

export interface RunStats {
  /** zamówienie poszło dalej niż status wiersza — bez wywołania kanału (nie cofamy sklepu). */
  pominiete: number
  wyslane: number
  ponowienia: number
  bledy: number
  niejednoznaczne: number
  porzucone: number
}

type Claimed = { id: string; orderId: string; channel: Channel; channelAccountId: string; kind: 'STATUS' | 'NADANIE'; key: string; channelStatus: string | null; carrier: string | null; trackingUrl: string | null; reference: string; attempts: number }

async function claim(db: PrismaClient, now: Date): Promise<Claimed[]> {
  // zajęcie atomowe (UPDATE … FOR UPDATE SKIP LOCKED): dwa przebiegi workera nie dostaną tego samego wiersza
  return db.$queryRaw<Claimed[]>`
    UPDATE "ChannelWrite" w SET state = 'WYSYLANIE', "lockedAt" = ${now}, attempts = w.attempts + 1
    WHERE w.id IN (
      SELECT id FROM "ChannelWrite" WHERE state = 'OCZEKUJE' AND "nextAttemptAt" <= ${now}
      ORDER BY "createdAt", id LIMIT ${PACZKA} FOR UPDATE SKIP LOCKED)
    RETURNING w.id, w."orderId", w.channel, w."channelAccountId", w.kind::text AS kind, w.key, w."channelStatus", w.carrier, w."trackingUrl", w.reference, w.attempts`
}

/** czytelna nazwa klucza wiersza statusu: etap z mapy enumu albo nazwa statusu firmy (`F:<klucz>`). */
export function nazwaKluczaZapisu(key: string, defs: readonly Pick<StatusFirmyT, 'key' | 'name'>[]): string {
  const etap = ETYKIETY_KLUCZY[key as StatusMapKey]
  if (etap) return etap
  if (!key.startsWith(KLUCZ_FIRMY)) return key
  const k = key.slice(KLUCZ_FIRMY.length)
  return defs.find((d) => d.key === k)?.name ?? k
}

/** Statusy firmy czytane raz na przebieg: dopiero przy pierwszym wierszu `F:`. */
type DefsFirmy = () => Promise<StatusFirmyT[]>
const defsLeniwie = (db: PrismaClient): DefsFirmy => {
  let p: Promise<StatusFirmyT[]> | null = null
  return () => (p ??= statusyFirmy(db).then((x) => x.statusy))
}

async function alertZapisu(db: PrismaClient, kind: string, w: Pick<Claimed, 'id' | 'orderId' | 'channel' | 'channelAccountId' | 'kind' | 'key' | 'attempts'>, tekst: string, now: Date, defs: DefsFirmy): Promise<void> {
  const o = await db.order.findUnique({ where: { id: w.orderId }, select: { externalId: true, channelNumber: true } })
  const nr = o?.channelNumber ?? o?.externalId ?? w.orderId
  const co = w.kind === 'STATUS' ? `status „${nazwaKluczaZapisu(w.key, w.key.startsWith(KLUCZ_FIRMY) ? await defs().catch(() => []) : [])}”` : `numer nadania ${w.key}`
  await alert(db, kind, accLabel(w), `Sklep ${accLabel(w)}, zamówienie ${nr}: ${co} — ${tekst}`.slice(0, 2000), `zapis:${w.id}:${kind}:${w.attempts}:${now.toISOString()}`)
}

/**
 * pkt 2–5: wykonuje oczekujące zapisy statusów i numerów nadania. Każdy wiersz osobno (błąd jednego nie zatrzymuje
 * reszty); stan WYSYLANIE ustawiany PRZED wywołaniem kanału, więc podwójny przebieg nie zapisze drugi raz.
 */
export async function wykonajZapisy(db: PrismaClient, ctx: HostCtx): Promise<RunStats> {
  const now = ctx.now ?? new Date()
  const stats: RunStats = { pominiete: 0, wyslane: 0, ponowienia: 0, bledy: 0, niejednoznaczne: 0, porzucone: 0 }
  const clock = () => ctx.now ?? new Date()
  const defs = defsLeniwie(db)
  // porzucone w trakcie zapisu (przebieg padł): nie wiadomo, czy kanał zapisał → człowiek
  const stale = await db.channelWrite.findMany({ where: { state: 'WYSYLANIE', lockedAt: { lt: new Date(now.getTime() - PORZUCONY_MS) } } })
  for (const w of stale) {
    const r = await db.channelWrite.updateMany({ where: { id: w.id, state: 'WYSYLANIE', lockedAt: w.lockedAt }, data: { state: 'NIEJEDNOZNACZNY', lastError: 'przebieg przerwany w trakcie zapisu: sprawdź w sklepie i kliknij „Wypchnij teraz”', lockedAt: null } })
    if (r.count) {
      stats.porzucone++
      await alertZapisu(db, 'KANAL_ZAPIS_NIEJEDNOZNACZNY', { ...w, kind: w.kind }, 'przebieg przerwany w trakcie zapisu, nie wiadomo, czy sklep go wykonał', now, defs)
    }
  }
  const started = Date.now()
  let rows = await claim(db, now)
  if (!rows.length) return stats
  const accounts = new Map((await loadChannelAccounts(db, { activeOnly: false })).map((a) => [accLabel(a), a]))
  const modes = new Map((await db.channelConfig.findMany({ select: { channel: true, channelAccountId: true, statusMode: true, trackingMode: true } })).map((c) => [accLabel(c), c]))
  const adapters = new Map<string, ChannelAdapter | string>()
  const finish = async (id: string, data: Prisma.ChannelWriteUpdateManyMutationInput) => {
    const r = await db.channelWrite.updateMany({ where: { id, state: 'WYSYLANIE' }, data: { lockedAt: null, ...data } })
    if (!r.count) console.warn(`[${ZAPIS_KANALOW_JOB}] wiersz ${id} zabrany w trakcie zapisu (wynik ${String(data.state)} nie zapisany)`)
    return r
  }
  for (;;) {
  for (const w of rows) {
    try {
      // zajęcie odświeżone tuż przed wywołaniem kanału — próg porzucenia liczy się od tej chwili
      const fresh = await db.channelWrite.updateMany({ where: { id: w.id, state: 'WYSYLANIE' }, data: { lockedAt: clock() } })
      if (!fresh.count) continue
      const label = accLabel(w)
      const acc = accounts.get(label)
      const m = modes.get(label)
      const cap: Capability = w.kind === 'STATUS' ? 'order.status.write' : 'order.tracking.write'
      const why = !acc || !m ? 'brak konta' : powodBlokady(acc, w.kind === 'STATUS' ? m.statusMode : m.trackingMode, ctx.registry.get(acc.adapterKey)?.manifest, cap)
      if (why && acc?.wylaczonePoBledach) {
        // konto wyłączone po błędach — wiersz czeka (bez próby), po „Włącz ponownie” pójdzie sam
        await finish(w.id, { state: 'OCZEKUJE', attempts: w.attempts - 1, nextAttemptAt: new Date(now.getTime() + ODLOZENIE_WYLACZONEGO_MS), lastError: `nic nie wysłano: ${why}`.slice(0, 1000) })
        stats.ponowienia++
        continue
      }
      if (why) {
        // warunek zapisu przestał być spełniony po zaplanowaniu: nic nie wysyłamy, wiersz czeka na „Wypchnij teraz”
        await finish(w.id, { state: 'BLAD', lastError: `nic nie wysłano: ${why}` })
        stats.bledy++
        continue
      }
      let a = adapters.get(label)
      if (a === undefined) {
        try {
          a = await createAccountAdapter(db, ctx.registry, acc!, ctx.secrets, adapterOpts(ctx))
        } catch (e) {
          a = `zła konfiguracja konta: ${msg(e)}`
        }
        adapters.set(label, a)
      }
      if (typeof a === 'string') {
        await finish(w.id, { state: 'BLAD', lastError: `nic nie wysłano: ${a}` })
        await alertZapisu(db, 'KANAL_ZAPIS_BLAD', w, a, now, defs)
        stats.bledy++
        continue
      }
      const out = await wykonajJeden(db, a, w, defs)
      if (out === 'POMINIETE') {
        await finish(w.id, { state: 'WYSLANE', doneAt: now, lastError: null, result: 'pominięte: zamówienie poszło dalej' })
        stats.pominiete++
      } else if (out.kind === 'OK') {
        await finish(w.id, { state: 'WYSLANE', doneAt: now, lastError: null, result: out.externalRef?.slice(0, 200) ?? null })
        stats.wyslane++
      } else if (out.kind === 'PRZEJSCIOWY' && out.odlozone) {
        // host odłożył zapis (limit tempa, wyłączenie) — nic nie wyszło, więc próba się nie liczy
        await finish(w.id, { state: 'OCZEKUJE', attempts: w.attempts - 1, nextAttemptAt: new Date(now.getTime() + Math.max(1_000, out.retryAfterMs ?? 60_000)), lastError: out.message.slice(0, 1000) })
        stats.ponowienia++
      } else if (out.kind === 'PRZEJSCIOWY' && w.attempts < MAX_PROB) {
        const delay = Math.max(out.retryAfterMs ?? 0, BACKOFF_MS[Math.min(w.attempts - 1, BACKOFF_MS.length - 1)]!)
        await finish(w.id, { state: 'OCZEKUJE', nextAttemptAt: new Date(now.getTime() + delay), lastError: out.message.slice(0, 1000) })
        stats.ponowienia++
      } else if (out.kind === 'NIEJEDNOZNACZNY') {
        await finish(w.id, { state: 'NIEJEDNOZNACZNY', lastError: out.message.slice(0, 1000) })
        await alertZapisu(db, 'KANAL_ZAPIS_NIEJEDNOZNACZNY', w, `nie wiadomo, czy sklep zapisał (${out.message.slice(0, 300)}); sprawdź w sklepie i kliknij „Wypchnij teraz”`, now, defs)
        stats.niejednoznaczne++
      } else {
        const tekst = out.kind === 'PRZEJSCIOWY' ? `nie udało się po ${w.attempts} próbach: ${out.message}` : out.message
        await finish(w.id, { state: 'BLAD', lastError: tekst.slice(0, 1000) })
        await alertZapisu(db, 'KANAL_ZAPIS_BLAD', w, tekst.slice(0, 500), now, defs)
        stats.bledy++
      }
    } catch (e) {
      // nieoczekiwany wyjątek (baza): nie wiadomo, czy kanał zapisał — wiersz do człowieka, reszta paczki leci dalej
      await finish(w.id, { state: 'NIEJEDNOZNACZNY', lastError: `błąd w trakcie zapisu: ${msg(e)}` }).catch(() => {})
      stats.niejednoznaczne++
    }
  }
  if (rows.length < PACZKA || Date.now() - started > PRZEBIEG_MS) break
  rows = await claim(db, now)
  if (!rows.length) break
  }
  return stats
}

/** odstęp ponownej próby statusu, który czeka na numer nadania tego zamówienia (bez liczenia próby). */
export const STATUS_PO_NUMERZE_MS = 60_000

async function wykonajJeden(db: PrismaClient, a: ChannelAdapter, w: Claimed, defs: DefsFirmy): Promise<WriteOutcome | 'POMINIETE'> {
  const o = await db.order.findUnique({ where: { id: w.orderId }, select: { externalId: true, status: true, cancelReason: true, carrier: true, companyStatus: true } })
  if (!o) return { kind: 'TRWALY', reference: w.reference, message: 'zamówienia nie ma w bazie' }
  if (w.kind === 'STATUS') {
    // ponowienie starego wiersza po tym, jak zamówienie poszło dalej, cofnęłoby status w sklepie.
    // wiersz statusu firmy — zamówienie musi mieć dalej ten sam status firmy
    if (w.key.startsWith(KLUCZ_FIRMY)) {
      const d = wybierzStatusFirmy(await defs(), o)
      // wiersz zaplanowany przed odcięciem etapów spoza ETAPY_DO_SKLEPU też nie wychodzi
      if (!d || `${KLUCZ_FIRMY}${d.key}` !== w.key || !etapDoSklepu(d.baseStatus)) return 'POMINIETE'
    } else if (kluczZamowienia(o, a.manifest) !== w.key) return 'POMINIETE'
    if (!hasOrderStatusWriter(a) || !w.channelStatus) return { kind: 'TRWALY', reference: w.reference, message: 'adapter nie zapisuje statusów' }
    // kanał chce numer nadania przed statusem (Empik: OR23 przed OR24) — status czeka, póki numer jest w drodze
    if (a.manifest.channelBehavior?.trackingBeforeStatus) {
      const numer = await db.channelWrite.findFirst({
        where: { orderId: w.orderId, channel: w.channel, channelAccountId: w.channelAccountId, kind: 'NADANIE', state: { in: ['OCZEKUJE', 'WYSYLANIE'] } },
        select: { id: true },
      })
      if (numer) return { kind: 'PRZEJSCIOWY', reference: w.reference, message: 'czeka na wysłanie numeru nadania (kanał przyjmuje status po numerze)', retryAfterMs: STATUS_PO_NUMERZE_MS, odlozone: true }
    }
    const guard = w.key === 'ANULOWANE_NIEOPLACONE' ? { onlyIfUnpaid: true } : {}
    // wiersz zaplanowany przed poprawką może mieć „shipped” zamiast „SHIPPED”
    const channelStatus = kanonicznyStatusKanalu(w.channelStatus, a.manifest)
    return executeWrite(a, w.reference, () => a.setOrderStatus(o.externalId, channelStatus, w.reference, guard))
  }
  if (!hasTrackingWriter(a)) return { kind: 'TRWALY', reference: w.reference, message: 'adapter nie zapisuje numerów nadania' }
  return executeWrite(a, w.reference, () => a.setTracking(o.externalId, { number: w.key, carrier: w.carrier ?? 'BRAK', url: w.trackingUrl }, w.reference))
}

/** Zadanie workera: najpierw plan, potem wykonanie (jedno wywołanie = jeden przebieg firmy). */
export async function przebiegZapisuKanalow(db: PrismaClient, ctx: HostCtx): Promise<PlanStats & RunStats> {
  const plan = await zaplanujZapisy(db, ctx.registry, ctx.now ? { now: ctx.now } : {})
  const run = await wykonajZapisy(db, ctx)
  // błąd planu jednego konta nie zatrzymał reszty ani wykonania; ślad w Job.lastError
  if (plan.bledyPlanu.length) throw new Error(`planowanie zapisów: ${plan.bledyPlanu.join('; ')}`.slice(0, 4000))
  return { ...plan, ...run }
}

// ─── „Wypchnij teraz” i ekran konta ──────────────────────────────────────────

/**
 * pkt 6: „Wypchnij teraz” na koncie kanału. Pełna synchronizacja stanów konta (joby wymuszone, od razu), zapisy
 * statusów i numerów nadania z błędem albo niejednoznaczne wracają do kolejki. Samo zlecenie (baza); kanał woła worker.
 */
export async function wypchnijTeraz(db: PrismaClient, acc: ChannelAccount, ctx: { now?: Date; actorId: string }): Promise<{ stany: number; zapisy: number }> {
  const now = ctx.now ?? new Date()
  const skroty = await uniewaznijKonto(db, acc) // wymuszone wysłanie nie patrzy na rejestr synchronizacji
  const stany = await fullSyncChannel(db, acc, { now })
  await db.stockSyncJob.updateMany({ where: { channel: acc.channel, channelAccountId: acc.channelAccountId }, data: { nextAttemptAt: now, attempts: 0 } }) // bez zerowania odstawiony job dostałby jedną próbę
  // tylko zapisy z okna planowania (2 doby) — starsze zostają do podglądu, nie idą lawiną do sklepu
  const z = await db.channelWrite.updateMany({
    where: { channel: acc.channel, channelAccountId: acc.channelAccountId, state: { in: ['BLAD', 'NIEJEDNOZNACZNY'] }, createdAt: { gte: new Date(now.getTime() - OKNO_PLANOWANIA_MS) } },
    data: { state: 'OCZEKUJE', nextAttemptAt: now, attempts: 0, lockedAt: null },
  })
  await db.auditLog.create({ data: { entity: 'ChannelConfig', entityId: accLabel(acc), actorId: ctx.actorId, after: { akcja: 'wypchnij-teraz', stany, zapisy: z.count, skroty } } })
  return { stany, zapisy: z.count }
}

/**
 * „Wyślij stany ponownie” na ekranie konta: kasuje skróty rejestru synchronizacji konta i zleca pełną
 * wysyłkę stanów (joby wymuszone, od razu). Statusów i numerów nadania nie rusza. Samo zlecenie; kanał woła worker.
 */
export async function wyslijStanyPonownie(db: PrismaClient, acc: ChannelAccount, ctx: { now?: Date; actorId: string }): Promise<{ stany: number; skroty: number }> {
  const now = ctx.now ?? new Date()
  const skroty = await uniewaznijKonto(db, acc)
  const stany = await fullSyncChannel(db, acc, { now })
  await db.stockSyncJob.updateMany({ where: { channel: acc.channel, channelAccountId: acc.channelAccountId }, data: { nextAttemptAt: now, attempts: 0 } })
  await db.auditLog.create({ data: { entity: 'ChannelConfig', entityId: accLabel(acc), actorId: ctx.actorId, after: { akcja: 'wyslij-stany-ponownie', stany, skroty } } })
  return { stany, skroty }
}

/** co ile godzin stan oferty idzie do kanału mimo braku zmiany (siatka rejestru synchronizacji). */
export async function zapiszPelnyZapisStanow(db: PrismaClient, acc: ChannelAccount, godziny: number, ctx: { actorId: string }): Promise<number> {
  if (!Number.isInteger(godziny) || godziny < PELNY_ZAPIS_MIN_GODZ || godziny > PELNY_ZAPIS_MAX_GODZ) throw new Error(`Zły odstęp: podaj liczbę godzin od ${PELNY_ZAPIS_MIN_GODZ} do ${PELNY_ZAPIS_MAX_GODZ}`)
  const row = await db.channelConfig.findFirst({ where: { channel: acc.channel, channelAccountId: acc.channelAccountId } })
  if (!row) throw new Error('Nie ma takiego konta')
  const before = asObject(row.config)
  const config = { ...before, [KLUCZ_PELNY_ZAPIS]: godziny }
  await db.channelConfig.update({ where: { organizationId_channel_channelAccountId: { organizationId: organizationIdOf(db), channel: acc.channel, channelAccountId: acc.channelAccountId } }, data: { config: config as Prisma.InputJsonValue } })
  await db.auditLog.create({ data: { entity: 'ChannelConfig', entityId: accLabel(acc), actorId: ctx.actorId, before: { [KLUCZ_PELNY_ZAPIS]: (before[KLUCZ_PELNY_ZAPIS] ?? null) as Prisma.InputJsonValue }, after: { [KLUCZ_PELNY_ZAPIS]: godziny } } })
  return godziny
}

/** Zapis mapy statusów konta (`config.statusy`); pusty status = przejście nie idzie do kanału. Status spoza słownika (wtyczka statusów sklepu) wolno wpisać ręcznie. */
export async function zapiszMapeStatusow(db: PrismaClient, acc: ChannelAccount, form: Record<string, string>, ctx: { registry: AdapterRegistry; actorId: string }): Promise<StatusMap> {
  const row = await db.channelConfig.findFirst({ where: { channel: acc.channel, channelAccountId: acc.channelAccountId } })
  if (!row) throw new Error('Nie ma takiego konta')
  // wartość ze słownika kanału zostaje w jego pisowni (Empik „SHIPPED”, Allegro „SENT”); reszta małymi
  // literami jak dotąd (identyfikatory statusów sklepów, np. wtyczka statusów Woo)
  const manifest = ctx.registry.get(row.adapterKey)?.manifest ?? null
  const status = (raw: string | undefined) => kanonicznyStatusKanalu((raw ?? '').trim().toLowerCase(), manifest)
  const mapa: StatusMap = {}
  for (const k of STATUS_MAP_KEYS) {
    const v = status(form[`status_${k}`])
    if (!v) continue
    if (!CHANNEL_STATUS_RE.test(v)) throw new Error(`Zły status kanału dla „${ETYKIETY_KLUCZY[k]}”`)
    mapa[k] = v
  }
  // nadpisania statusów firmy (`statusfirmy_<klucz>`), tylko istniejące statusy firmy; puste = z mapy enumu.
  // status firmy z etapu spoza ETAPY_DO_SKLEPU (Nowe, Do wyjaśnienia, Reklamacja) = odmowa zapisu.
  const defs = new Map((await statusyFirmy(db)).statusy.map((d) => [d.key, d]))
  const mapaFirmy: Record<string, string> = {}
  for (const [pole, raw] of Object.entries(form)) {
    if (!pole.startsWith('statusfirmy_')) continue
    const k = pole.slice('statusfirmy_'.length)
    const v = status(raw)
    const d = defs.get(k)
    if (!v || !d) continue
    if (!etapDoSklepu(d.baseStatus)) throw new Error(`Status firmy „${d.name}” ${POWOD_ETAPU_POZA_SKLEPEM}. Zostaw pole puste.`)
    if (!CHANNEL_STATUS_RE.test(v)) throw new Error(`Zły status kanału dla statusu firmy „${d.name}”`)
    mapaFirmy[k] = v
  }
  const before = asObject(row.config)
  const config = { ...before, statusy: mapa, statusyFirmy: mapaFirmy }
  await db.channelConfig.update({ where: { organizationId_channel_channelAccountId: { organizationId: organizationIdOf(db), channel: acc.channel, channelAccountId: acc.channelAccountId } }, data: { config: config as Prisma.InputJsonValue } })
  await db.auditLog.create({ data: { entity: 'ChannelConfig', entityId: accLabel(acc), actorId: ctx.actorId, before: { statusy: (before['statusy'] ?? null) as Prisma.InputJsonValue, statusyFirmy: (before['statusyFirmy'] ?? null) as Prisma.InputJsonValue }, after: { statusy: mapa, statusyFirmy: mapaFirmy } } })
  return mapa
}

export type RodzajKonta = 'zapis' | 'odczyt'

/**
 * zmiana rodzaju konta w obrębie rodziny adaptera: „tylko odczyt” ↔ „z zapisem za wyłącznikiem” (ten sam
 * kanał). Sekrety konta są przypisane do konta, nie do adaptera, a ustawienia zostają w całości (także te, które zna
 * tylko wersja z zapisem: wracają przy kolejnym przełączeniu). Kursor dziennika zamówień zostaje (`rodzinaAdaptera`).
 * Zapis do sklepu po każdej zmianie jest wyłączony: włącza go człowiek osobnym przyciskiem.
 * Wpis w dzienniku zmian (AuditLog) z kluczem przed i po. Ten sam rodzaj = bez zmian i bez wpisu.
 */
export async function zmienRodzajKonta(db: PrismaClient, acc: ChannelAccount, rodzaj: RodzajKonta, ctx: { registry: AdapterRegistry; actorId: string }): Promise<string> {
  const row = await db.channelConfig.findFirst({ where: { channel: acc.channel, channelAccountId: acc.channelAccountId } })
  if (!row) throw new Error('Nie ma takiego konta')
  const key =
    rodzaj === 'zapis' ? kluczZZapisem(ctx.registry, row.adapterKey) : rodzinaAdaptera(row.adapterKey) === row.adapterKey ? row.adapterKey : kluczTylkoOdczyt(ctx.registry, row.adapterKey)
  if (!key) throw new Error(rodzaj === 'zapis' ? 'Ten rodzaj konta nie ma wersji z zapisem' : 'Ten rodzaj konta nie ma wersji tylko do odczytu')
  if (key === row.adapterKey) return key
  if (ctx.registry.get(key)!.manifest.channel !== acc.channel) throw new Error(`Wersja ${rodzaj === 'zapis' ? 'z zapisem' : 'tylko do odczytu'} jest dla innego kanału`)
  // przełączenie zawsze zostawia zapis wyłączony (także gdy w konfiguracji było już `zapisWlaczony: true`)
  const before = asObject(row.config)
  // wystawianie ofert też wraca do wyłączonego (osobny przełącznik, ten sam powód)
  const config = { ...before, zapisWlaczony: false, [WYSTAWIANIE_OFERT_KLUCZ]: false }
  await db.channelConfig.update({
    where: { organizationId_channel_channelAccountId: { organizationId: organizationIdOf(db), channel: acc.channel, channelAccountId: acc.channelAccountId } },
    data: { adapterKey: key, config: config as Prisma.InputJsonValue },
  })
  // inna wersja adaptera = pełny zapis. Zmiana już zapisana, więc błąd rejestru tylko do logu;
  // bez skasowanych skrótów i tak nie pominie: adapter jest w skrócie, a `ChannelConfig.updatedAt` właśnie się zmienił
  await uniewaznijKonto(db, acc).catch((e) => console.warn(`[rejestr-synchronizacji] ${accLabel(acc)}: kasowanie skrótów po zmianie rodzaju konta nieudane (${e instanceof Error ? e.message : String(e)})`))
  await db.auditLog.create({
    data: {
      entity: 'ChannelConfig',
      entityId: accLabel(acc),
      actorId: ctx.actorId,
      before: { adapterKey: row.adapterKey, zapisWlaczony: (before['zapisWlaczony'] ?? null) as Prisma.InputJsonValue },
      after: { akcja: 'rodzaj-konta', rodzaj, adapterKey: key, zapisWlaczony: false },
    },
  })
  // wersja tylko do odczytu nie czyta wyniku importów, więc otwarte zamykamy od razu (bez alertu)
  if (rodzaj === 'odczyt') await zamknijOtwarteImporty(db, acc, new Date())
  return key
}

/** Przełączenie konta na wersję adaptera z zapisem (ten sam kanał). Zapis zostaje wyłączony, dopóki ktoś go nie włączy. */
export function przelaczNaWersjeZZapisem(db: PrismaClient, acc: ChannelAccount, ctx: { registry: AdapterRegistry; actorId: string }): Promise<string> {
  return zmienRodzajKonta(db, acc, 'zapis', ctx)
}

export interface WierszZapisu {
  id: string
  zamowienie: string
  orderId: string
  rodzaj: 'STATUS' | 'NADANIE'
  co: string
  stan: string
  blad: string | null
  wynik: string | null
  kiedy: Date
}

export interface EkranZapisu {
  manifest: AdapterManifest | null
  kluczZZapisem: string | null
  /** wersja tylko do odczytu tego konta (konto z zapisem), do przycisku „Przełącz na tylko odczyt”. */
  kluczTylkoOdczyt: string | null
  zapisWlaczony: boolean
  /** osobny przełącznik wystawiania ofert; null = ten rodzaj konta nie wystawia ofert. */
  wystawianieOfert: boolean | null
  tryby: { stany: ChannelMode; statusy: ChannelMode; nadania: ChannelMode }
  powody: { stany: string | null; statusy: string | null; nadania: string | null }
  mapa: StatusMap
  mapaWlasna: boolean
  /** statusy firmy (do nadpisania statusu w kanale) i bieżące nadpisania */
  /** `doSklepu` = false: status z etapu spoza ETAPY_DO_SKLEPU, formularz pokazuje go bez pola, z powodem */
  statusyFirmy: { key: string; name: string; baseStatus: OrderStatus; doSklepu: boolean }[]
  mapaFirmy: Record<string, string>
  statusyKanalu: readonly { id: string; label: string }[] | null
  stany: { ostatniZapis: Date | null; wyslane24h: number; wCieniu24h: number; czekajace: number; bledy: { oferta: string; blad: string; proby: number }[] }
  /** wynik importów stanów w kanale (tylko adaptery ze zdolnością `stock.import.status`); null = kanał tego nie ma. */
  importy: WierszImportu[] | null
  /** rejestr synchronizacji — ostatni przebieg wysyłki stanów i siatka pełnego zapisu. */
  bezZmian: { przebiegAt: Date | null; wyslane: number; pominiete: number; zapamietane: number; pelnyZapisCoGodz: number }
  /** zakończenie oferty przy stanie 0 (null = adapter konta tego nie ma albo konto wysyła liczbę 0). */
  stanZerowy: { limit: number; zakonczone24h: number; zakonczoneTeraz: number; wpisy: WpisDziennika[] } | null
  zapisy: { ostatnie: WierszZapisu[]; bledy: number; niejednoznaczne: number; oczekujace: number }
}

const STAN_ZAPISU: Record<string, string> = { OCZEKUJE: 'czeka', WYSYLANIE: 'w toku', WYSLANE: 'wysłane', CIEN: 'wysłałbym (podgląd)', NIEJEDNOZNACZNY: 'niepewne', BLAD: 'błąd' }

/** Dane sekcji „Zapis do sklepu” na ekranie konta kanału. Bez danych klientów. */
export async function ekranZapisu(db: PrismaClient, registry: AdapterRegistry, acc: ChannelAccount, now: Date): Promise<EkranZapisu | null> {
  const row = await db.channelConfig.findFirst({ where: { channel: acc.channel, channelAccountId: acc.channelAccountId } })
  if (!row) return null
  const settings = (await loadChannelAccounts(db, { activeOnly: false })).find((a) => a.channel === acc.channel && a.channelAccountId === acc.channelAccountId)!
  const manifest = registry.get(settings.adapterKey)?.manifest ?? null
  const { mapa, wlasna } = mapaStatusow(settings.config, manifest)
  const wszystkieSf = (await statusyFirmy(db)).statusy
  const sf = wszystkieSf.filter((d) => d.active)
  const day = new Date(now.getTime() - 24 * 3600_000)
  const where = { channel: acc.channel, channelAccountId: acc.channelAccountId }
  const [last, sent, shadow, waiting, failing, writes, bledy, niejednoznaczne, oczekujace, health, zapamietane] = await Promise.all([
    db.channelPushLog.findFirst({ where: { ...where, mode: 'PRACA' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    db.channelPushLog.count({ where: { ...where, mode: 'PRACA', createdAt: { gte: day } } }),
    db.channelPushLog.count({ where: { ...where, mode: 'CIEN', createdAt: { gte: day } } }),
    db.stockSyncJob.count({ where }),
    db.stockSyncJob.findMany({ where: { ...where, lastError: { not: null } }, orderBy: { updatedAt: 'desc' }, take: 10, select: { offerId: true, lastError: true, attempts: true } }),
    db.channelWrite.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 20, include: { order: { select: { externalId: true, channelNumber: true } } } }),
    db.channelWrite.count({ where: { ...where, state: 'BLAD' } }),
    db.channelWrite.count({ where: { ...where, state: 'NIEJEDNOZNACZNY' } }),
    db.channelWrite.count({ where: { ...where, state: { in: ['OCZEKUJE', 'WYSYLANIE'] } } }),
    db.channelHealth.findFirst({ where, select: { lastPassAt: true, lastPassSent: true, lastPassSkipped: true } }),
    db.channelSyncState.count({ where: { ...where, contentHash: { not: null } } }),
  ])
  const offers = new Map((await db.channelOffer.findMany({ where: { id: { in: failing.map((f) => f.offerId) } }, select: { id: true, externalId: true } })).map((o) => [o.id, o.externalId]))
  const label = (s: string | null) => manifest?.channelBehavior?.channelStatuses?.find((x) => x.id === s)?.label ?? s ?? ''
  return {
    manifest,
    kluczZZapisem: kluczZZapisem(registry, settings.adapterKey),
    kluczTylkoOdczyt: kluczTylkoOdczyt(registry, settings.adapterKey),
    zapisWlaczony: zapisWlaczony(settings.config),
    wystawianieOfert: manifest?.config.some((f) => f.key === WYSTAWIANIE_OFERT_KLUCZ) ? wystawianieOfertWlaczone(settings.config) : null,
    tryby: { stany: row.stockMode, statusy: row.statusMode, nadania: row.trackingMode },
    powody: {
      stany: powodStanow(settings, row, manifest),
      statusy: powodBlokady(settings, row.statusMode, manifest, 'order.status.write'),
      nadania: powodBlokady(settings, row.trackingMode, manifest, 'order.tracking.write'),
    },
    mapa,
    mapaWlasna: wlasna,
    statusyFirmy: sf.map((d) => ({ key: d.key, name: d.name, baseStatus: d.baseStatus, doSklepu: etapDoSklepu(d.baseStatus) })),
    mapaFirmy: kanonicznaMapa(parseMapaStatusowFirmy(settings.config['statusyFirmy']), manifest),
    statusyKanalu: manifest?.channelBehavior?.channelStatuses ?? null,
    stany: {
      ostatniZapis: last?.createdAt ?? null,
      wyslane24h: sent,
      wCieniu24h: shadow,
      czekajace: waiting,
      bledy: failing.map((f) => ({ oferta: offers.get(f.offerId) ?? f.offerId, blad: (f.lastError ?? '').slice(0, 300), proby: f.attempts })),
    },
    importy: manifest?.capabilities.includes('stock.import.status') ? await ostatnieImporty(db, acc) : null,
    bezZmian: {
      przebiegAt: health?.lastPassAt ?? null,
      wyslane: health?.lastPassSent ?? 0,
      pominiete: health?.lastPassSkipped ?? 0,
      zapamietane,
      pelnyZapisCoGodz: pelnyZapisCoGodz(settings.config),
    },
    stanZerowy: kontoKonczyPrzyZerze(settings.config, manifest?.config) ? { limit: limitZakonczen(settings.config), ...(await dziennikStanuZerowego(db, acc, now)) } : null,
    zapisy: {
      ostatnie: writes.map((w) => ({
        id: w.id,
        zamowienie: w.order.channelNumber ?? w.order.externalId,
        orderId: w.orderId,
        rodzaj: w.kind,
        co: w.kind === 'STATUS' ? `${nazwaKluczaZapisu(w.key, wszystkieSf)} → ${label(w.channelStatus)}` : `numer nadania ${w.key}`,
        stan: STAN_ZAPISU[w.state] ?? w.state,
        blad: w.lastError,
        wynik: w.result,
        kiedy: w.doneAt ?? w.createdAt,
      })),
      bledy,
      niejednoznaczne,
      oczekujace,
    },
  }
}
