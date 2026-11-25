// host zapisu stanów a zakończenie oferty przy stanie 0 (kanały z ustawieniem „stanZerowy”, np. Allegro).
//   - przed wysłaniem: znacznik „zakończona przez Kompletor” z powiązania oferty (ChannelOffer.endedByZeroStockAt) idzie
//     do adaptera (wznawia tylko takie oferty); dobowy bezpiecznik: po N zakończeniach w 24 h (ustawienie konta,
//     domyślnie 100) kolejne oferty ze stanem 0 dostają `bezKonczenia` (adapter ich nie kończy), host wysyła alert;
//   - po wyniku: znacznik ustawiony przy zakończeniu, skasowany przy wznowieniu albo gdy oferta jest znowu aktywna; każde
//     zakończenie i wznowienie to wpis w dzienniku zmian (AuditLog, encja `OfertaStanZero`), z którego liczy się limit
//     i który pokazuje ekran konta.
// Błąd zapisu znacznika albo wpisu nie zmienia wyniku wysyłki (kanał już zmienił ofertę): trafia do logu workera.
// Bez danych klientów: numery ofert, ilości i akcje.
import type { Prisma, PrismaClient } from '@prisma/client'
import type { RodzajZmianyPublikacji, StockWriteItem, WriteOutcome } from '../adaptery/kontrakt'
import { KLUCZ_STAN_ZEROWY, konczyPrzyZerze, limitZakonczen } from '../adaptery/stan-zerowy'
import type { ChannelAccount, PushItem } from '../rdzen/propagacja'
import { alert } from '../rdzen/stan'

type Db = PrismaClient | Prisma.TransactionClient

export const ENCJA_DZIENNIKA = 'OfertaStanZero'
const DOBA_MS = 24 * 3600_000
const label = (a: ChannelAccount) => `${a.channel}/${a.channelAccountId}`
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300)

/** Akcja w dzienniku (`after.akcja`) dla zmiany publikacji; null = bez wpisu. */
const AKCJA: Partial<Record<RodzajZmianyPublikacji, string>> = {
  ZAKONCZONA: 'zakonczona',
  WZNOWIONA: 'wznowiona',
  ZAKONCZONA_POZA: 'zakonczona-poza',
}

export const OPIS_AKCJI: Record<string, string> = {
  zakonczona: 'oferta zakończona: stan 0',
  wznowiona: 'oferta wznowiona',
  'zakonczona-poza': 'oferta zakończona poza Kompletorem: nie wznawiam',
}

/** Czy konto ma ustawienie zachowania przy stanie 0 (manifest adaptera) i je włączone. */
export function kontoKonczyPrzyZerze(config: Record<string, unknown>, polaManifestu: readonly { key: string }[] | null | undefined): boolean {
  return !!polaManifestu?.some((f) => f.key === KLUCZ_STAN_ZEROWY) && konczyPrzyZerze(config)
}

/** Ile ofert konta Kompletor zakończył w ostatnich 24 h (wpisy dziennika). */
export async function zakonczeniaDoby(db: Db, acc: ChannelAccount, now: Date): Promise<number> {
  return db.auditLog.count({ where: { entity: ENCJA_DZIENNIKA, entityId: label(acc), createdAt: { gte: new Date(now.getTime() - DOBA_MS) }, after: { path: ['akcja'], equals: 'zakonczona' } } })
}

export interface PozycjeStanuZerowego {
  wi: StockWriteItem[]
  /** Pozycje ze stanem 0, którym bezpiecznik zabronił zakończenia (dla alertu). */
  zablokowane: string[]
  limit: number
}

/**
 * Pozycje dla adaptera: znacznik zakończenia z powiązania oferty i bezpiecznik dobowy. Konto bez ustawienia = pozycje
 * jak dawniej. Błąd odczytu znaczników albo dziennika = bezpiecznie: bez wznowień i bez zakończeń w tym przebiegu.
 */
export async function pozycjeDlaAdaptera(db: Db, acc: ChannelAccount, items: PushItem[], o: { konczy: boolean; config: Record<string, unknown>; now: Date }): Promise<PozycjeStanuZerowego> {
  const limit = limitZakonczen(o.config)
  const proste = items.map((i) => ({ offerExternalId: i.externalId, qty: i.targetQty }))
  if (!o.konczy) return { wi: proste, zablokowane: [], limit }
  let znaczniki = new Map<string, Date>()
  let zostalo = 0
  try {
    znaczniki = new Map(
      (await db.channelOffer.findMany({ where: { id: { in: items.map((i) => i.offerId) }, endedByZeroStockAt: { not: null } }, select: { id: true, endedByZeroStockAt: true } })).map((r) => [r.id, r.endedByZeroStockAt!]),
    )
    zostalo = Math.max(0, limit - (await zakonczeniaDoby(db, acc, o.now)))
  } catch (e) {
    console.warn(`[stan-zerowy] ${label(acc)}: odczyt znaczników albo dziennika nieudany, bez zakończeń w tym przebiegu (${msg(e)})`)
    znaczniki = new Map()
    zostalo = 0
  }
  const zablokowane: string[] = []
  const wi = items.map((i): StockWriteItem => {
    const z = znaczniki.get(i.offerId)
    const it: StockWriteItem = { offerExternalId: i.externalId, qty: i.targetQty, ...(z ? { zakonczonaPrzezNasAt: z.toISOString() } : {}) }
    // oferta już zakończona przez nas nie zużywa limitu (adapter jej drugi raz nie kończy)
    if (i.targetQty === 0 && !z) {
      if (zostalo > 0) zostalo--
      else {
        it.bezKonczenia = true
        zablokowane.push(i.externalId)
      }
    }
    return it
  })
  return { wi, zablokowane, limit }
}

/**
 * Wynik → znaczniki na powiązaniach ofert, wpisy w dzienniku i alert bezpiecznika. Oferta po ofercie (błąd jednej nie
 * zatrzymuje reszty).
 */
export async function zapiszPublikacje(db: Db, acc: ChannelAccount, items: PushItem[], out: WriteOutcome, p: PozycjeStanuZerowego, now: Date): Promise<void> {
  const byExt = new Map(items.map((i) => [i.externalId, i]))
  for (const z of out.publikacja ?? []) {
    const i = byExt.get(z.offerExternalId)
    if (!i) continue
    try {
      if (z.zmiana === 'ZAKONCZONA') await db.channelOffer.update({ where: { id: i.offerId }, data: { endedByZeroStockAt: now } })
      else if (z.zmiana === 'WZNOWIONA' || z.zmiana === 'AKTYWNA') await db.channelOffer.updateMany({ where: { id: i.offerId, endedByZeroStockAt: { not: null } }, data: { endedByZeroStockAt: null } })
      const akcja = AKCJA[z.zmiana]
      if (akcja) await db.auditLog.create({ data: { entity: ENCJA_DZIENNIKA, entityId: label(acc), actorId: 'system', after: { akcja, oferta: z.offerExternalId, offerId: i.offerId, ilosc: i.targetQty } } })
    } catch (e) {
      console.error(`[stan-zerowy] ${label(acc)} oferta ${z.offerExternalId}: zapis zmiany publikacji (${z.zmiana}) nieudany: ${msg(e)}`)
    }
  }
  if (p.zablokowane.length && out.kind !== 'OK') {
    const zatrzymane = new Set((out.failedItems ?? []).filter((f) => f.odstaw).map((f) => f.offerExternalId))
    const n = p.zablokowane.filter((id) => zatrzymane.has(id)).length
    if (n > 0) {
      const day = now.toISOString().slice(0, 10)
      try {
        await alert(
          db,
          'KANAL_LIMIT_ZAKONCZEN',
          label(acc),
          `Kanał ${label(acc)}: dobowy limit zakończeń ofert (${p.limit}) wyczerpany. ${n} ofert ze stanem 0 zostaje aktywnych ze starą liczbą sztuk i Kompletor ich nie ponawia. Sprawdź stany (czy odczyt magazynu był poprawny); jeśli tak, podnieś limit w ustawieniach konta i kliknij „Wyślij stany ponownie”.`,
          `limit-zakonczen:${label(acc)}:${day}`,
        )
      } catch (e) {
        console.error(`[stan-zerowy] ${label(acc)}: alert bezpiecznika nieudany: ${msg(e)}`)
      }
    }
  }
}

export interface WpisDziennika {
  kiedy: Date
  oferta: string
  opis: string
}

/** Ostatnie zakończenia i wznowienia ofert konta (ekran konta) i liczba zakończeń w 24 h. */
export async function dziennikStanuZerowego(db: Db, acc: ChannelAccount, now: Date, take = 10): Promise<{ wpisy: WpisDziennika[]; zakonczone24h: number; zakonczoneTeraz: number }> {
  const [rows, zakonczone24h, zakonczoneTeraz] = await Promise.all([
    db.auditLog.findMany({ where: { entity: ENCJA_DZIENNIKA, entityId: label(acc) }, orderBy: { createdAt: 'desc' }, take, select: { createdAt: true, after: true } }),
    zakonczeniaDoby(db, acc, now),
    db.channelOffer.count({ where: { channel: acc.channel, channelAccountId: acc.channelAccountId, endedByZeroStockAt: { not: null } } }),
  ])
  const wpisy = rows.map((r) => {
    const a = (r.after && typeof r.after === 'object' && !Array.isArray(r.after) ? r.after : {}) as Record<string, unknown>
    const akcja = typeof a['akcja'] === 'string' ? a['akcja'] : ''
    return { kiedy: r.createdAt, oferta: typeof a['oferta'] === 'string' ? a['oferta'] : '', opis: OPIS_AKCJI[akcja] ?? akcja }
  })
  return { wpisy, zakonczone24h, zakonczoneTeraz }
}
