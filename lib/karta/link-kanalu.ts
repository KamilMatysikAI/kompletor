// „Otwórz w kanale” na karcie zamówienia: adres panelu sprzedawcy dla zamówienia, zbudowany wyłącznie
// z konfiguracji konta kanału (bez wywołań API i bez sekretów). Kanał bez znanego adresu = null, a karta nie pokazuje
// przycisku. Adresy paneli sprawdzone tylko na wzór (WooCommerce, Shoper, PrestaShop, Allegro, Empik/Mirakl): pierwsze
// użycie na prawdziwym koncie potwierdza biuro (raport).
import type { Channel } from '@prisma/client'

export interface KontoLinku {
  channel: Channel
  config: unknown
}

function cfg(konto: KontoLinku): Record<string, unknown> {
  return konto.config && typeof konto.config === 'object' && !Array.isArray(konto.config) ? (konto.config as Record<string, unknown>) : {}
}

/** Adres http(s) z konfiguracji, bez danych logowania w adresie; inaczej null. */
function adres(v: unknown): URL | null {
  if (typeof v !== 'string' || !v.trim()) return null
  try {
    const u = new URL(v.trim())
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return null
    return u
  } catch {
    return null
  }
}

const enc = encodeURIComponent
/** Ścieżka adresu bez ukośnika na końcu (pusta dla adresu głównego). */
const sciezka = (u: URL) => u.pathname.replace(/\/+$/, '')

/** Link do zamówienia w panelu kanału albo null. `externalId` = numer zamówienia w kanale (Order.externalId). */
export function linkDoKanalu(konto: KontoLinku | null, externalId: string): string | null {
  if (!konto || !externalId.trim() || externalId.includes('#')) return null // podzamówienia (#dosle, #paczka) kanał nie zna
  const c = cfg(konto)
  switch (konto.channel) {
    case 'WOO': {
      const u = adres(c['baseUrl'])
      return u && /^\d+$/.test(externalId) ? `${u.origin}${sciezka(u)}/wp-admin/post.php?post=${enc(externalId)}&action=edit` : null
    }
    case 'SHOPER': {
      const u = adres(c['baseUrl'])
      return u && /^\d+$/.test(externalId) ? `${u.origin}/admin/orders/view/id/${enc(externalId)}` : null
    }
    case 'PRESTASHOP': {
      // katalog panelu PrestaShop ma losową nazwę: bez `adminUrl` w konfiguracji konta przycisku nie ma
      const u = adres(c['adminUrl'])
      return u && /^\d+$/.test(externalId) ? `${u.origin}${sciezka(u)}/index.php?controller=AdminOrders&id_order=${enc(externalId)}&vieworder` : null
    }
    case 'IDOSELL': {
      // karta zamówienia w panelu IdoSell po numerze zamówienia (orderSerialNumber); [NIEPEWNE] adres
      // panelu do potwierdzenia na koncie testowym (docs/integracje/idosell.md)
      const u = adres(c['baseUrl'])
      return u && /^\d+$/.test(externalId) ? `${u.origin}/panel/orderd.php?idt=${enc(externalId)}` : null
    }
    case 'ALLEGRO': {
      const api = adres(c['apiUrl'])
      const host = api && /allegrosandbox\.pl$/i.test(api.hostname) ? 'https://allegro.pl.allegrosandbox.pl' : 'https://allegro.pl'
      return /^[0-9a-f-]{8,64}$/i.test(externalId) ? `${host}/moje-allegro/sprzedaz/zamowienia/${enc(externalId)}` : null
    }
    case 'EMPIK': {
      const u = adres(c['baseUrl'])
      return u ? `${u.origin}/mmp/shop/order/${enc(externalId)}` : null
    }
    default:
      return null
  }
}

/**
 * link do oferty pozycji w kanale (strona publiczna, bez logowania) albo null. `offerId` w formacie
 * `ChannelOffer.externalId` (Woo i PrestaShop „<produkt>[/<wariant>]”, Allegro numer oferty). Kanały bez znanego wzoru
 * adresu (Empik, Shoper) = null: karta pokazuje sam numer oferty.
 */
export function linkDoOferty(konto: KontoLinku | null, offerId: string | null): string | null {
  if (!konto || !offerId || offerId.startsWith('bl-pozycja:')) return null
  const c = cfg(konto)
  switch (konto.channel) {
    case 'ALLEGRO': {
      const api = adres(c['apiUrl'])
      const host = api && /allegrosandbox\.pl$/i.test(api.hostname) ? 'https://allegro.pl.allegrosandbox.pl' : 'https://allegro.pl'
      return /^\d{5,20}$/.test(offerId) ? `${host}/oferta/${enc(offerId)}` : null
    }
    case 'WOO': {
      const u = adres(c['baseUrl'])
      const m = /^(\d+)(?:\/\d+)?$/.exec(offerId)
      return u && m ? `${u.origin}${sciezka(u)}/?p=${enc(m[1]!)}` : null
    }
    case 'PRESTASHOP': {
      const u = adres(c['baseUrl'])
      const m = /^(\d+)(?:\/\d+)?$/.exec(offerId)
      return u && m ? `${u.origin}${sciezka(u)}/index.php?controller=product&id_product=${enc(m[1]!)}` : null
    }
    default:
      return null
  }
}
