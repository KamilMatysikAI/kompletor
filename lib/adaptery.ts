// Klucze adapterów (wniosek z porównania z OpenLinkerem 25.10.2026): adapter konta kanału albo modułu
// wysyłki to tekst w konfiguracji firmy (ChannelConfig.adapterKey, CarrierRule.adapterKey), nie wartość enuma —
// nowy adapter nie wymaga migracji rdzenia. Kontrakt adaptera (port, zdolności, wyniki zapisu, manifest) to osobne
// zadanie; tu tylko format klucza i domyślne klucze rodzin kanałów.
import type { Channel, ShippingModule } from '@prisma/client'

/** „<dostawca>[.<api>].v<wersja>”, małe litery, np. woo.rest.v1, allegro.v1, mirakl.empik.v1, basecourier.v1. */
export const ADAPTER_KEY_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*\.v[0-9]+$/

export function assertAdapterKey(key: string): void {
  if (!ADAPTER_KEY_RE.test(key) || key.length > 64) throw new Error(`Zły klucz adaptera „${key}” (np. woo.rest.v1)`)
}

/** Domyślny adapter rodziny kanału (gdy firma nie wskaże innego). */
export const DEFAULT_CHANNEL_ADAPTER: Record<Channel, string> = {
  WOO: 'woo.rest.v1',
  ALLEGRO: 'allegro.v1',
  EMPIK: 'mirakl.empik.v1',
  EASYTOOLS: 'easytools.v1',
  BL_INNE: 'baselinker.orders.v1',
  RECZNE: 'manual.v1',
  AI: 'ai.anthropic.v1',
  SHOPER: 'shoper.rest.v1',
  PRESTASHOP: 'prestashop.ws.v1',
  IDOSELL: 'idosell.admin.v1',
}

/** Klucz adaptera Wysyłam z Allegro; tu, a nie w adapterze, żeby podgląd przesyłki nie wciągał OAuth. */
export const ALLEGRO_WYSYLAM_KEY = 'allegro.wysylam.v1'

/** Domyślny adapter modułu wysyłki; BRAK = bez modułu. */
export const DEFAULT_SHIPPING_ADAPTER: Record<ShippingModule, string | null> = {
  BASE_COURIER: 'basecourier.v1',
  WYSYLAM_Z_ALLEGRO: ALLEGRO_WYSYLAM_KEY,
  INPOST_SHIPX: 'inpost.shipx.v1',
  DPD_BEZPOSREDNIO: 'dpd.services.v1',
  // Orlen Paczka bezpośrednio (SOAP), domyślnie tylko liczenie przesyłki
  ORLEN_PACZKA: 'orlenpaczka.v1',
  // GLS przez ADE (SOAP), domyślnie tylko liczenie przesyłki
  GLS_ADE: 'gls.ade.v1',
  // Poczta Polska przez eNadawcę, domyślnie tylko liczenie przesyłki i śledzenie
  POCZTA_POLSKA: 'pocztapolska.enadawca.v1',
  BRAK: null,
}
