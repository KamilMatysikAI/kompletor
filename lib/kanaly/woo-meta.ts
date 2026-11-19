// Podpowiedź pól zamówienia WooCommerce: NIP, punkt odbioru i „chcę fakturę” zapisują wtyczki sklepu
// w `meta_data` zamówienia pod własnymi nazwami. Test połączenia (worker) czyta nazwy kluczy z kilku ostatnich
// zamówień (bez wartości, bez danych klientów) i zapisuje je w ChannelAccountStatus.testMetaKeys; ekran konta proponuje
// z nich `nipMetaKey` / `pickupPointMetaKey` / `invoiceMetaKey`, a zapis jest dopiero po kliknięciu „Użyj”. Czysta
// logika (bez bazy), żeby reguły dało się sprawdzić testem.
import { META_KEY_RE, MAX_KLUCZY_META as MAX_KLUCZY } from '../adaptery/woo'

export { MAX_KLUCZY }

export type PoleMeta = 'nipMetaKey' | 'pickupPointMetaKey' | 'invoiceMetaKey'
export const POLA_META: readonly PoleMeta[] = ['nipMetaKey', 'pickupPointMetaKey', 'invoiceMetaKey']
export const czyPoleMeta = (v: unknown): v is PoleMeta => typeof v === 'string' && (POLA_META as readonly string[]).includes(v)

export interface KluczMeta {
  key: string
  /** W ilu z przejrzanych zamówień klucz wystąpił. */
  orders: number
}

export interface WykryteKlucze {
  /** Ile ostatnich zamówień przejrzano. */
  sample: number
  keys: KluczMeta[]
  at: string
}

/** Odczyt z kolumny (JSON) z kontrolą kształtu; śmieci = null. */
export function wykryteZBazy(v: unknown): WykryteKlucze | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (!Number.isInteger(o['sample']) || !Array.isArray(o['keys']) || typeof o['at'] !== 'string') return null
  const keys = (o['keys'] as unknown[])
    .filter((k): k is KluczMeta => !!k && typeof k === 'object' && typeof (k as KluczMeta).key === 'string' && META_KEY_RE.test((k as KluczMeta).key) && Number.isInteger((k as KluczMeta).orders))
    .slice(0, MAX_KLUCZY)
  return { sample: o['sample'] as number, keys, at: o['at'] }
}

interface Regula {
  /** Nazwy znanych wtyczek (pierwszeństwo, w tej kolejności). */
  znane: readonly string[]
  pasuje: RegExp
  /** Wyklucza klucze, które pasują, ale znaczą co innego (np. numer wystawionej faktury, numer przesyłki). */
  nie: RegExp
}

const REGULY: Record<PoleMeta, Regula> = {
  nipMetaKey: {
    znane: ['_billing_nip', 'billing_nip', '_billing__billing_nip', '_nip', 'nip', '_billing_vat_number', '_vat_number', 'vat_number', '_billing_tax_id'],
    pasuje: /(^|_)nip($|_)|vat_?(number|id|no)$|tax_?id$/i,
    nie: /faktur|invoice|wfirma|fakturownia|infakt|ifirma|valid|status|check/i,
  },
  pickupPointMetaKey: {
    znane: ['_paczkomat_id', 'paczkomat_id', '_paczkomat', 'paczkomat', '_parcel_machine_id', 'parcel_machine_id', '_inpost_point', 'inpost_point', '_easypack_parcel_machine_id', '_pickup_point', 'pickup_point', '_pickup_point_id', 'pickup_point_id'],
    pasuje: /paczkomat|parcel_?(machine|locker)|pickup_?point|(^|_)punkt(_|$)|(^|_)point(_id|_code)?$|inpost|easypack|locker|_machine(_id)?$/i,
    nie: /tracking|track|numer|number|label|etykiet|shipment|przesyl|status|cost|koszt|price|cena|date|data/i,
  },
  invoiceMetaKey: {
    znane: ['_billing_faktura', 'billing_faktura', '_faktura', 'faktura', '_billing_invoice', 'billing_invoice', '_want_invoice', '_billing_want_invoice', '_invoice_request', '_billing_invoice_ask'],
    pasuje: /faktur|invoice|(^|_)fv($|_)|rachunek/i,
    nie: /nip|number|numer|nr($|_)|_id$|url|link|pdf|date|data|wfirma|fakturownia|infakt|ifirma|status|sent|wyslan|token|hash|type|typ/i,
  },
}

export interface Propozycja {
  pole: PoleMeta
  key: string
  orders: number
  /** Inne pasujące klucze (do wyboru w „Zaawansowane”). */
  inne: string[]
}

/**
 * Propozycje z wykrytych kluczy: znana nazwa wtyczki wygrywa, potem częstość w zamówieniach. Jeden klucz trafia
 * najwyżej do jednego pola (kolejność: NIP, punkt odbioru, faktura). Brak pasującego = brak propozycji.
 */
export function proponujPolaMeta(keys: readonly KluczMeta[]): Partial<Record<PoleMeta, Propozycja>> {
  const out: Partial<Record<PoleMeta, Propozycja>> = {}
  const zajete = new Set<string>()
  for (const pole of POLA_META) {
    const r = REGULY[pole]
    const kandydaci = keys
      .filter((k) => !zajete.has(k.key) && (r.znane.includes(k.key) || (r.pasuje.test(k.key) && !r.nie.test(k.key))))
      .sort((a, b) => {
        const za = r.znane.indexOf(a.key)
        const zb = r.znane.indexOf(b.key)
        if (za !== zb) return (za < 0 ? Infinity : za) - (zb < 0 ? Infinity : zb)
        return b.orders - a.orders || a.key.length - b.key.length || a.key.localeCompare(b.key)
      })
    const best = kandydaci[0]
    if (!best) continue
    zajete.add(best.key)
    out[pole] = { pole, key: best.key, orders: best.orders, inne: kandydaci.slice(1, 6).map((k) => k.key) }
  }
  return out
}
