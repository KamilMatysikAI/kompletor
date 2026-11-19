// Rejestr synchronizacji stanów. Wzorzec z Open Integration Platform (Pinquark.com, Apache-2.0),
// platform/core/sync_state.py (commit ae43d1e): decyzja SYNC / UPDATE / SKIP / RETRY ze skrótu treści ostatniego
// udanego zapisu per encja i kanał. Własna implementacja w TS pod nasz kontrakt (atrybucja: THIRD_PARTY_NOTICES.md).
//
// Po co: host zapisu (lib/kanaly/zapis-host.ts) wysyłał stan każdej oferty z joba, także gdy kanał już ma dokładnie tę
// wartość. To zjada limity Allegro i Mirakl (STO01) i wydłuża kolejkę w grudniu. Rejestr jest drugim bezpiecznikiem obok
// referencji zapisu: oferta, której treść zapisu jest identyczna z ostatnim POTWIERDZONYM zapisem, nie idzie do kanału.
//
// Zasady (rejestr nie może ukryć rozjazdu):
//   - skrót liczony z kanonicznej treści zapisu: adapter konta, oferta, ilość, a do tego produkt i przelicznik oferty
//     (zmiana powiązania oferty albo wersji adaptera = inny skrót = zapis);
//   - przed wysłaniem skrót oferty jest kasowany (zawsze przed akcją), po wyniku OK wpisany na nowo; każdy inny wynik
//     (PRZEJSCIOWY, NIEJEDNOZNACZNY, TRWALY, wyjątek) zostawia go pustym, więc następny przebieg wysyła; TRWALY podbija
//     licznik porażek oferty;
//   - job wymuszony (kanał sam zmienił stan, „Wypchnij teraz”, noc, powrót kanału) zawsze idzie, bez patrzenia na skrót;
//   - skrót starszy niż `pelnyZapisStanowCoGodz` z konfiguracji konta (domyślnie 24 h) nie pomija: siatka bezpieczeństwa;
//   - wpis sprzed ostatniej zmiany konta (ChannelConfig.updatedAt: tryb, wyłącznik zapisu, adapter, ustawienia,
//     włączenie konta, każdą drogą: panel, CLI, preset) nie pomija;
//   - unieważnienie (skasowanie wpisów) przy korekcie stanu, nowych kluczach i połączeniu Allegro, „Wypchnij teraz”,
//     „Wyślij stany ponownie”, rozjeździe ilości z odczytu ofert kanału i odrzuconym wierszu importu stanów;
//   - błąd samego rejestru nigdy nie blokuje zapisu: w razie wątpliwości oferta idzie do kanału jak dawniej.
// Bez danych klientów: w rejestrze są tylko identyfikatory ofert, ilości i skróty.
import { createHash } from 'node:crypto'
import type { Prisma, PrismaClient } from '@prisma/client'
import { organizationIdOf } from '../db'
import type { AdapterStanow, ChannelAccount, PushItem, PushResult } from '../rdzen/propagacja'

type Db = PrismaClient | Prisma.TransactionClient

/** Decyzja rejestru dla jednej oferty (nazwy jak w sync_state.py). */
export type Decyzja = 'SYNC' | 'UPDATE' | 'SKIP' | 'RETRY'

export interface WpisRejestru {
  contentHash: string | null
  syncedAt: Date | null
  failures: number
  lastError: string | null
}

/** Treść zapisu stanu jednej oferty, z której liczymy skrót. */
export interface TrescZapisu {
  adapterKey: string
  offerExternalId: string
  qty: number
  productId: string
  qtyBasePerOffer: number
}

/** Klucz konfiguracji konta: co ile godzin oferta idzie do kanału mimo identycznego skrótu (siatka). */
export const KLUCZ_PELNY_ZAPIS = 'pelnyZapisStanowCoGodz'
export const PELNY_ZAPIS_DOMYSLNIE_GODZ = 24
export const PELNY_ZAPIS_MIN_GODZ = 1
export const PELNY_ZAPIS_MAX_GODZ = 168

/** Odstęp siatki z konfiguracji konta (godziny 1–168, zła albo brak wartości = 24 h). */
export function pelnyZapisCoGodz(config: Record<string, unknown> | null | undefined): number {
  const v = config?.[KLUCZ_PELNY_ZAPIS]
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,3}$/.test(v.trim()) ? Number(v.trim()) : NaN
  return Number.isInteger(n) && n >= PELNY_ZAPIS_MIN_GODZ && n <= PELNY_ZAPIS_MAX_GODZ ? n : PELNY_ZAPIS_DOMYSLNIE_GODZ
}

/** Kanoniczna postać treści (stała kolejność pól, wersja formatu): ten sam stan = ten sam tekst. */
export function trescKanoniczna(t: TrescZapisu): string {
  return JSON.stringify(['v1', t.adapterKey, t.offerExternalId, t.qty, t.productId, t.qtyBasePerOffer])
}

export function skrotTresci(t: TrescZapisu): string {
  return createHash('sha256').update(trescKanoniczna(t)).digest('hex')
}

/**
 * Czysta decyzja dla jednej oferty:
 *   - SYNC: brak wpisu, zapis wymuszony, skrót starszy niż siatka albo sprzed ostatniej zmiany konta;
 *   - RETRY: ostatni zapis tej oferty się nie udał (skrót pusty, jest błąd albo licznik porażek);
 *   - UPDATE: treść inna niż ostatni udany zapis (także skrót pusty bez śladu błędu, np. po przerwanym przebiegu);
 *   - SKIP: treść identyczna z ostatnim udanym zapisem, w terminie siatki.
 * Tylko SKIP nie wysyła.
 */
export function decyzja(wpis: WpisRejestru | null, skrot: string, o: { wymuszony?: boolean; now: Date; maksWiekMs: number; kontoZmienioneAt?: Date | null }): Decyzja {
  if (!wpis) return 'SYNC'
  if (o.wymuszony) return 'SYNC'
  // zmiana konta po zapisie (tryb, wyłącznik zapisu, adapter, ustawienia, włączenie): skrót mógł przestać być prawdą
  if (o.kontoZmienioneAt && wpis.syncedAt && wpis.syncedAt.getTime() < o.kontoZmienioneAt.getTime()) return 'SYNC'
  if (wpis.contentHash === null) return wpis.failures > 0 || wpis.lastError ? 'RETRY' : 'UPDATE'
  if (wpis.contentHash !== skrot) return 'UPDATE'
  if (!wpis.syncedAt || o.now.getTime() - wpis.syncedAt.getTime() >= o.maksWiekMs) return 'SYNC'
  return 'SKIP'
}

export interface PlanRejestru {
  doWyslania: PushItem[]
  pominiete: PushItem[]
  /** offerId → treść i skrót do zapisania po wyniku (tylko oferty do wysłania). */
  tresci: Map<string, { skrot: string; qty: number; externalId: string }>
  decyzje: Map<string, Decyzja>
}

const where = (acc: ChannelAccount) => ({ channel: acc.channel, channelAccountId: acc.channelAccountId })
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300)

/**
 * Plan paczki: które oferty pominąć (SKIP), które wysłać. Oferty do wysłania mają skrót skasowany jeszcze przed
 * wywołaniem kanału (przebieg przerwany w trakcie nie zostawi starego skrótu). Błąd odczytu rejestru = wszystko idzie.
 */
export async function planujZapis(
  db: Db,
  acc: ChannelAccount,
  items: PushItem[],
  o: { adapterKey: string; now: Date; pelnyZapisCoGodz?: number },
): Promise<PlanRejestru> {
  const plan: PlanRejestru = { doWyslania: [], pominiete: [], tresci: new Map(), decyzje: new Map() }
  if (!items.length) return plan
  const maksWiekMs = (o.pelnyZapisCoGodz ?? PELNY_ZAPIS_DOMYSLNIE_GODZ) * 3600_000
  let offers = new Map<string, { productId: string; qtyBasePerOffer: number }>()
  let wpisy = new Map<string, WpisRejestru>()
  let kontoZmienioneAt: Date | null = null
  try {
    kontoZmienioneAt = (await db.channelConfig.findFirst({ where: where(acc), select: { updatedAt: true } }))?.updatedAt ?? null
    offers = new Map((await db.channelOffer.findMany({ where: { id: { in: items.map((i) => i.offerId) } }, select: { id: true, productId: true, qtyBasePerOffer: true } })).map((r) => [r.id, r]))
    wpisy = new Map(
      (
        await db.channelSyncState.findMany({
          where: { ...where(acc), offerExternalId: { in: items.map((i) => i.externalId) } },
          select: { offerExternalId: true, contentHash: true, syncedAt: true, failures: true, lastError: true },
        })
      ).map((w) => [w.offerExternalId, w]),
    )
  } catch (e) {
    console.warn(`[rejestr-synchronizacji] ${acc.channel}/${acc.channelAccountId}: odczyt rejestru nieudany, wysyłam wszystko (${msg(e)})`)
    offers = new Map()
    wpisy = new Map()
  }
  for (const i of items) {
    const of = offers.get(i.offerId)
    if (!of) {
      // bez danych oferty nie liczymy skrótu: zapis jak dawniej, bez śladu w rejestrze
      plan.doWyslania.push(i)
      plan.decyzje.set(i.offerId, 'SYNC')
      continue
    }
    const skrot = skrotTresci({ adapterKey: o.adapterKey, offerExternalId: i.externalId, qty: i.targetQty, productId: of.productId, qtyBasePerOffer: of.qtyBasePerOffer })
    const d = decyzja(wpisy.get(i.externalId) ?? null, skrot, { wymuszony: i.force, now: o.now, maksWiekMs, kontoZmienioneAt })
    plan.decyzje.set(i.offerId, d)
    if (d === 'SKIP') plan.pominiete.push(i)
    else {
      plan.doWyslania.push(i)
      plan.tresci.set(i.offerId, { skrot, qty: i.targetQty, externalId: i.externalId })
    }
  }
  const zSkrotem = plan.doWyslania.filter((i) => wpisy.get(i.externalId)?.contentHash)
  if (zSkrotem.length) {
    try {
      await db.channelSyncState.updateMany({ where: { ...where(acc), offerExternalId: { in: zSkrotem.map((i) => i.externalId) } }, data: { contentHash: null } })
    } catch (e) {
      // nie udało się skasować przed wysłaniem: zapiszWyniki i tak nadpisze wynik; przy jego awarii kasujemy wpis
      console.warn(`[rejestr-synchronizacji] ${acc.channel}/${acc.channelAccountId}: kasowanie skrótów przed zapisem nieudane (${msg(e)})`)
    }
  }
  return plan
}

/**
 * Wyniki zapisu → rejestr, oferta po ofercie (błąd jednej nie zatrzymuje reszty). OK = nowy skrót; inny wynik = skrót
 * pusty z błędem, TRWALY podbija licznik porażek. Nie wpisany wynik OK = wpis skasowany (następny przebieg wyśle).
 */
export async function zapiszWyniki(db: Db, acc: ChannelAccount, plan: PlanRejestru, results: PushResult[], o: { now: Date; reference?: string | null }): Promise<void> {
  const byId = new Map(results.map((r) => [r.offerId, r]))
  const organizationId = organizationIdOf(db)
  for (const [offerId, t] of plan.tresci) {
    const r = byId.get(offerId)
    const key = { organizationId_channel_channelAccountId_offerExternalId: { organizationId, ...where(acc), offerExternalId: t.externalId } }
    try {
      if (r?.ok) {
        const data = { contentHash: t.skrot, qty: t.qty, syncedAt: o.now, reference: o.reference ?? null, failures: 0, lastError: null }
        await db.channelSyncState.upsert({ where: key, create: { ...where(acc), offerExternalId: t.externalId, ...data }, update: data })
      } else {
        const trwaly = r?.kind === 'TRWALY'
        const lastError = `${r?.kind ?? 'BLAD'}: ${r?.error ?? 'brak wyniku'}`.slice(0, 500)
        await db.channelSyncState.upsert({
          where: key,
          create: { ...where(acc), offerExternalId: t.externalId, contentHash: null, failures: trwaly ? 1 : 0, lastError },
          update: { contentHash: null, lastError, ...(trwaly ? { failures: { increment: 1 } } : {}) },
        })
      }
    } catch (e) {
      console.warn(`[rejestr-synchronizacji] ${acc.channel}/${acc.channelAccountId} oferta ${t.externalId}: zapis wyniku do rejestru nieudany (${msg(e)})`)
      await db.channelSyncState.deleteMany({ where: { ...where(acc), offerExternalId: t.externalId } }).catch(() => {})
    }
  }
}

// ─── Unieważnianie ───────────────────────────────────────────────────────────

/** Wszystkie skróty konta (zmiana konta, kluczy, trybu, wyłącznika zapisu, „Wyślij stany ponownie”). */
export async function uniewaznijKonto(db: Db, acc: ChannelAccount): Promise<number> {
  return (await db.channelSyncState.deleteMany({ where: where(acc) })).count
}

/** Skróty wskazanych ofert konta (rozjazd, odrzucony wiersz importu). */
export async function uniewaznijOferty(db: Db, acc: ChannelAccount, offerExternalIds: string[]): Promise<number> {
  if (!offerExternalIds.length) return 0
  return (await db.channelSyncState.deleteMany({ where: { ...where(acc), offerExternalId: { in: [...new Set(offerExternalIds)] } } })).count
}

/** Skróty wszystkich ofert produktów (na każdym koncie) i zestawów, w których te produkty są składnikami. */
export async function uniewaznijProdukty(db: Db, productIds: string[]): Promise<number> {
  if (!productIds.length) return 0
  const bundles = await db.bundleComponent.findMany({ where: { componentId: { in: productIds } }, select: { bundleId: true } })
  const offers = await db.channelOffer.findMany({
    where: { productId: { in: [...new Set([...productIds, ...bundles.map((b) => b.bundleId)])] } },
    select: { channel: true, channelAccountId: true, externalId: true },
  })
  let n = 0
  const byAcc = new Map<string, { acc: ChannelAccount; ids: string[] }>()
  for (const o of offers) {
    const k = `${o.channel}/${o.channelAccountId}`
    const e = byAcc.get(k) ?? { acc: { channel: o.channel, channelAccountId: o.channelAccountId }, ids: [] }
    e.ids.push(o.externalId)
    byAcc.set(k, e)
  }
  for (const { acc, ids } of byAcc.values()) n += await uniewaznijOferty(db, acc, ids)
  return n
}

/**
 * Rozjazd z odczytu ofert kanału: ilość w kanale inna niż w ostatnim udanym zapisie = kanał zmienił stan sam (sprzedaż,
 * ręczna zmiana w panelu sklepu) albo zapis się nie utrzymał. Skrót takiej oferty jest kasowany.
 */
export async function uniewaznijRozjazdy(db: Db, acc: ChannelAccount, odczyt: { externalId: string; qty: number | null }[]): Promise<number> {
  const znane = odczyt.filter((r) => r.qty !== null)
  if (!znane.length) return 0
  const qty = new Map(znane.map((r) => [r.externalId, r.qty]))
  const ids = [...qty.keys()]
  let rozjazd: string[] = []
  for (let i = 0; i < ids.length; i += 1000) {
    const wpisy = await db.channelSyncState.findMany({ where: { ...where(acc), offerExternalId: { in: ids.slice(i, i + 1000) } }, select: { offerExternalId: true, qty: true } })
    rozjazd = rozjazd.concat(wpisy.filter((w) => w.qty !== qty.get(w.offerExternalId)).map((w) => w.offerExternalId))
  }
  return uniewaznijOferty(db, acc, rozjazd)
}

// ─── Opakowanie adaptera stanów ──────────────────────────────────────────────

/**
 * Adapter stanów z rejestrem (dla dowolnego `AdapterStanow`, np. atrapy w symulacji grudnia). Host zapisu woła
 * `planujZapis` i `zapiszWyniki` sam, bo zna referencję zapisu. Pominięte oferty wracają jako `{ ok: true, skipped: true }`.
 */
export function zRejestrem(db: Db, acc: ChannelAccount, inner: AdapterStanow, o: { adapterKey: string; now: () => Date; pelnyZapisCoGodz?: number }): AdapterStanow {
  return {
    async push(items: PushItem[]): Promise<PushResult[]> {
      const now = o.now()
      const plan = await planujZapis(db, acc, items, { adapterKey: o.adapterKey, now, ...(o.pelnyZapisCoGodz ? { pelnyZapisCoGodz: o.pelnyZapisCoGodz } : {}) })
      const skipped: PushResult[] = plan.pominiete.map((i) => ({ offerId: i.offerId, ok: true, skipped: true }))
      if (!plan.doWyslania.length) return skipped
      let results: PushResult[]
      try {
        results = await inner.push(plan.doWyslania)
      } catch (e) {
        results = plan.doWyslania.map((i) => ({ offerId: i.offerId, ok: false, error: msg(e) }))
        await zapiszWyniki(db, acc, plan, results, { now })
        throw e
      }
      await zapiszWyniki(db, acc, plan, results, { now })
      return [...skipped, ...results]
    },
  }
}

/**
 * Skróty ofert z jednego zapisu (referencja paczki): kanał przyjął plik, a potem odrzucił jego wiersze albo wynik jest
 * nieznany (import stanów Mirakl). Stany z tego pliku pójdą jeszcze raz.
 */
export async function uniewaznijReferencje(db: Db, acc: ChannelAccount, reference: string): Promise<number> {
  return (await db.channelSyncState.deleteMany({ where: { ...where(acc), reference } })).count
}
