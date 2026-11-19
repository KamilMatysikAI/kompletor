// Opis zamówienia z kanału dla istniejących zamówień: nazwa, SKU i EAN pozycji, numer zamówienia
// w kanale i koszt wysyłki. Nowe zamówienia dostają je przy przyjęciu (lib/rdzen/zamowienia.ts, `opisPozycji`); starsze
// uzupełnia „Odśwież z kanału” na karcie. Tylko odczyt kanału (zdolność dziennika zamówień, `getOrder`) — bez danych
// klienta, więc działa też na koncie w cieniu. Zapis idempotentny przez `zapiszOpisZKanalu`: zmienia pola opisowe
// i wartość zamówienia przy otwartych kwotach, nigdy status, rezerwacje ani rewizję zamówienia.
import type { PrismaClient } from '@prisma/client'
import { createAccountAdapter, loadChannelAccounts } from '../adaptery/konta'
import { AdapterError, hasOrderFeed } from '../adaptery/kontrakt'
import type { AdapterRegistry } from '../adaptery/rejestr'
import type { SecretSource } from '../sekrety'
import type { FetchLike } from '../zrodla/http'
import { runTx } from '../rdzen/stan'
import { zapiszOpisZKanalu } from '../rdzen/zamowienia'

export interface OdswiezOpisDeps {
  registry: AdapterRegistry
  secrets: SecretSource
  fetch?: FetchLike
  now?: () => Date
  /** Kto odświeża (historia zamówienia przy zmianie kwoty), np. `user:<id>`; domyślnie system. */
  actorId?: string
}

export type WynikOpisu =
  | { wynik: 'OK'; zmian: number }
  | { wynik: 'BRAK_ZRODLA'; powod: string }
  | { wynik: 'BRAK_W_KANALE' }
  | { wynik: 'BLAD'; powod: string }

/** Kanały bez API zamówień w Kompletorze (podzamówienia z „#” też kanał nie zna). */
const BEZ_ZRODLA = new Set(['RECZNE', 'EASYTOOLS', 'BL_INNE'])

/**
 * Czyta zamówienie `orderId` z kanału i dopisuje opis. Błąd kanału wraca jako wynik (bez treści odpowiedzi), nie wyjątek:
 * karta pokazuje go słowami, a jeden zły rekord przy przebiegu zbiorczym nie zatrzymuje reszty.
 */
export async function odswiezOpisZKanalu(db: PrismaClient, orderId: string, deps: OdswiezOpisDeps): Promise<WynikOpisu> {
  const o = await db.order.findUnique({ where: { id: orderId }, select: { id: true, channel: true, channelAccountId: true, externalId: true } })
  if (!o) return { wynik: 'BLAD', powod: 'Nie ma takiego zamówienia.' }
  if (BEZ_ZRODLA.has(o.channel) || o.externalId.includes('#')) return { wynik: 'BRAK_ZRODLA', powod: 'Ten kanał nie ma odczytu zamówień przez API.' }
  const acc = (await loadChannelAccounts(db, { activeOnly: true })).find((a) => a.channel === o.channel && a.channelAccountId === o.channelAccountId)
  if (!acc) return { wynik: 'BRAK_ZRODLA', powod: 'Konto kanału jest nieaktywne albo nieskonfigurowane.' }
  let zamowienie
  try {
    const adapter = await createAccountAdapter(db, deps.registry, acc, deps.secrets, { fetch: deps.fetch, now: deps.now })
    if (!hasOrderFeed(adapter)) return { wynik: 'BRAK_ZRODLA', powod: 'Adapter konta nie czyta zamówień.' }
    zamowienie = await adapter.getOrder(o.externalId)
  } catch (e) {
    const rodzaj = e instanceof AdapterError ? e.kind : 'INNY'
    // bez komunikatu wyjątku: cudzy wyjątek (sieć, parser) mógłby nieść fragment odpowiedzi
    console.warn(`[opis-z-kanalu] odczyt nie powiódł się: ${o.channel}/${o.channelAccountId}, zamówienie ${o.id}, ${rodzaj}`)
    return { wynik: 'BLAD', powod: `Odczyt z kanału nie powiódł się (${rodzaj}).` }
  }
  if (!zamowienie) return { wynik: 'BRAK_W_KANALE' }
  // także wartość zamówienia, dopóki kwoty są otwarte (bez faktury, wpłaty w Kompletorze, edycji, pakowania)
  const zmian = await runTx(db, (tx) =>
    zapiszOpisZKanalu(tx, o.id, { channelNumber: zamowienie.number ?? null, shippingCostGross: zamowienie.shippingCostGross ?? null, totalGross: zamowienie.totalGross, lines: zamowienie.lines }, { actorId: deps.actorId ?? 'system:opis-z-kanalu' }),
  )
  return { wynik: 'OK', zmian }
}
