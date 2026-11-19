// Zwroty klientów zgłoszone w kanale: Allegro `customer-returns` → zwrot w statusie „Nowe”
// powiązany z zamówieniem. Tylko odczyt z kanału, bez zapisu do Allegro. Bez danych kupującego (adapter ich nie oddaje).
//
// Każdy zwrot osobno (try/catch per element): zły zwrot nie zatrzymuje reszty. Idempotentnie: numer zwrotu kanału jest
// unikalny w firmie (`Return.source` + `externalId`), a `createReturn` przy tym samym numerze oddaje istniejący zwrot.
// Bez kursora w bazie: każdy przebieg czyta zwroty z ostatnich `OKNO_DNI` dni (zwroty Allegro mieszczą się w tym oknie,
// powtórki odsiewa numer). Zwrot, którego nie da się założyć (zamówienia nie ma u nas, towar jeszcze nie wydany, oferta
// bez pozycji), dostaje alert z kluczem `zwrot-kanalu:<konto>:<numer>` (jeden na zwrot) na koncie w trybie Aktywny;
// na koncie w podglądzie tylko licznik w logu (zwroty prowadzi tam dotychczasowy system).
import type { PrismaClient } from '@prisma/client'
import { createAccountAdapter, loadChannelAccounts, type ChannelAccountSettings } from '../adaptery/konta'
import { type ChannelReturn, hasReturnReader, type ReturnReader } from '../adaptery/kontrakt'
import type { AdapterRegistry } from '../adaptery/rejestr'
import type { SecretSource } from '../sekrety'
import { createReturn, ReturnError, type ReturnItem } from '../rdzen/zwroty'
import { alert } from '../rdzen/stan'
import { AKTOR_ZWROTOW_KANALU, powodZAllegro } from './statusy'

export const OKNO_DNI = 30
const MAKS_STRON = 20

export interface StatystykiZwrotowKanalu {
  przeczytane: number
  nowe: number
  juzByly: number
  pominiete: number
  nieczytelne: number
}

type Db = PrismaClient

/** Zwrot kanału → pozycje zwrotu u nas (sztuki oferty → jednostka bazowa pozycji zamówienia) albo powód odmowy. */
async function pozycjeZwrotu(db: Db, orderId: string, z: ChannelReturn): Promise<{ items: ReturnItem[] } | { blad: string }> {
  const lines = await db.orderLine.findMany({ where: { orderId, removed: false }, select: { id: true, offerId: true, qty: true, qtyChannel: true } })
  const items: ReturnItem[] = []
  for (const l of z.lines) {
    const ol = lines.find((x) => x.offerId === l.offerId)
    if (!ol) return { blad: `oferta ${l.offerId} nie ma pozycji w zamówieniu` }
    // ilość bazowa na sztukę oferty z pozycji zamówienia (paczka 3 szt. = 3; zestaw = liczba zestawów na sztukę)
    const naSztuke = ol.qtyChannel ? ol.qty / ol.qtyChannel : 1
    const qty = l.qty * naSztuke
    if (!Number.isInteger(qty) || qty <= 0) return { blad: `oferta ${l.offerId}: ilości ${l.qty} nie da się przeliczyć na pozycję zamówienia` }
    items.push({ orderLineId: ol.id, qty })
  }
  return { items }
}

/** Zwroty z jednej strony kanału: każdy osobno, bez przerywania reszty. */
export async function przyjmijZwrotyKanalu(db: Db, acc: Pick<ChannelAccountSettings, 'channel' | 'channelAccountId'>, zwroty: readonly ChannelReturn[], opts: { praca: boolean; now?: Date }): Promise<StatystykiZwrotowKanalu> {
  const s: StatystykiZwrotowKanalu = { przeczytane: zwroty.length, nowe: 0, juzByly: 0, pominiete: 0, nieczytelne: 0 }
  for (const z of zwroty) {
    const klucz = `zwrot-kanalu:${acc.channelAccountId}:${z.externalId}`
    try {
      if (await db.return.findFirst({ where: { source: 'ALLEGRO', externalId: z.externalId }, select: { id: true } })) {
        s.juzByly++
        continue
      }
      const o = await db.order.findFirst({ where: { channel: acc.channel, channelAccountId: acc.channelAccountId, externalId: z.orderExternalId, parentOrderId: null }, select: { id: true } })
      if (!o) {
        s.pominiete++
        if (opts.praca) await alert(db, 'ZWROT_KANALU', z.orderExternalId, `Zwrot ${z.externalId} z kanału dotyczy zamówienia ${z.orderExternalId}, którego nie ma w Kompletorze: przyjmij go ręcznie`, klucz)
        continue
      }
      const p = await pozycjeZwrotu(db, o.id, z)
      if ('blad' in p) {
        s.pominiete++
        if (opts.praca) await alert(db, 'ZWROT_KANALU', o.id, `Zwrot ${z.externalId} z kanału: ${p.blad}. Załóż zwrot ręcznie (Zwroty → Stwórz zwrot)`, klucz)
        continue
      }
      await createReturn(db, o.id, p.items, { reason: powodZAllegro(z.lines[0]?.reasonType), zrodlo: { source: 'ALLEGRO', externalId: z.externalId }, actorId: AKTOR_ZWROTOW_KANALU, ...(opts.now ? { now: opts.now } : {}) })
      s.nowe++
    } catch (e) {
      s.pominiete++
      if (!(e instanceof ReturnError)) console.error(`[zwroty-kanalu] konto ${acc.channelAccountId}, zwrot ${z.externalId}: ${e instanceof Error ? e.message : String(e)}`)
      if (opts.praca) await alert(db, 'ZWROT_KANALU', z.orderExternalId, `Zwrot ${z.externalId} z kanału nie został założony: ${e instanceof ReturnError ? e.message : 'błąd zapisu'}`.slice(0, 900), klucz).catch(() => {})
    }
  }
  return s
}

/** Wszystkie strony zwrotów jednego czytnika od `od`. */
export async function wczytajZwroty(db: Db, acc: Pick<ChannelAccountSettings, 'channel' | 'channelAccountId'>, reader: ReturnReader, opts: { praca: boolean; od: Date; now?: Date }): Promise<StatystykiZwrotowKanalu> {
  const suma: StatystykiZwrotowKanalu = { przeczytane: 0, nowe: 0, juzByly: 0, pominiete: 0, nieczytelne: 0 }
  let kursor: string | null = null
  for (let i = 0; i < MAKS_STRON; i++) {
    const strona = await reader.listCustomerReturns(opts.od, kursor)
    const s = await przyjmijZwrotyKanalu(db, acc, strona.items, opts)
    for (const k of Object.keys(suma) as (keyof StatystykiZwrotowKanalu)[]) suma[k] += s[k]
    suma.nieczytelne += strona.unreadable.length
    kursor = strona.nextCursor
    if (!kursor) break
  }
  return suma
}

/** Zadanie workera: każde aktywne konto z adapterem `returns.read`; błąd konta = log, następne konto idzie dalej. */
export async function odczytZwrotowKanalow(db: Db, deps: { registry: AdapterRegistry; secrets: SecretSource; now?: () => Date }): Promise<Record<string, StatystykiZwrotowKanalu | { blad: string }>> {
  const now = deps.now ? deps.now() : new Date()
  const od = new Date(now.getTime() - OKNO_DNI * 24 * 3600_000)
  const out: Record<string, StatystykiZwrotowKanalu | { blad: string }> = {}
  const tryby = new Map((await db.channelConfig.findMany({ select: { channel: true, channelAccountId: true, statusMode: true } })).map((c) => [`${c.channel}:${c.channelAccountId}`, c.statusMode]))
  for (const acc of await loadChannelAccounts(db)) {
    // dziś tylko Allegro (źródło zwrotu ALLEGRO); kolejny kanał = nowe źródło w Return.source i w CHECK migracji
    if (acc.channel !== 'ALLEGRO' || !deps.registry.get(acc.adapterKey)?.manifest.capabilities.includes('returns.read')) continue
    const klucz = `${acc.channel}:${acc.channelAccountId}`
    try {
      const a = await createAccountAdapter(db, deps.registry, acc, deps.secrets, deps.now ? { now: deps.now } : {})
      if (!hasReturnReader(a)) continue
      out[klucz] = await wczytajZwroty(db, acc, a, { praca: tryby.get(klucz) === 'PRACA', od, now })
    } catch (e) {
      out[klucz] = { blad: e instanceof Error ? e.message.slice(0, 300) : String(e) }
    }
  }
  return out
}
