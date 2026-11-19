// Szyfrowanie danych klienta. Mechanika jak sekrety integracji (lib/sekrety.ts: AES-256-GCM, pierścień
// kluczy z wersjami), ale OSOBNY pierścień `CUSTOMER_DATA_KEYS` („<wersja>:<klucz>,…”, najnowsza pierwsza): wyciek
// klucza sekretów integracji nie odsłania klientów i odwrotnie. AAD = „<firma>:klient:<Order.id>”, więc szyfrogramu nie
// da się przenieść do innego zamówienia ani innej firmy. Brak klucza = zapis odmawia (BrakKluczaKlientow, bez danych),
// panel pokazuje „Dane klienta niedostępne: brak klucza szyfrowania”, reszta systemu działa.
// Rotacja: `reencryptCustomers` przepisuje wpisy starszą wersją najnowszym kluczem i przelicza skróty (rotacja
// CUSTOMER_LOOKUP_KEY); CLI `npm run klienci -- przeszyfruj --firma <slug>` (scripts/klienci.ts).
// Odszyfrowanie `OrderCustomer` tylko w lib/klienci/* (strażnik tests/klienci-straznik.test.ts).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { NonRetryableError } from '../bledy'
import { organizationIdOf } from '../db'
import { keyRingFromEnv, type Env, type KeyRing } from '../sekrety'
import { parseRekord, type RekordKlienta } from './rekord'
import { kluczSkrotowZEnv, krajDostawy, skrotyRekordu, BrakKluczaSkrotow } from './skroty'

/** Błąd szyfru danych klienta: komunikat bez danych i bez materiału klucza; ponowienie nic nie zmieni. */
export class BladSzyfruKlienta extends NonRetryableError {
  constructor(message: string) {
    super(message)
    this.name = 'BladSzyfruKlienta'
  }
}

export class BrakKluczaKlientow extends BladSzyfruKlienta {
  constructor() {
    super('Brak CUSTOMER_DATA_KEYS (np. 1:<64 znaki hex>): dane klientów są niedostępne, zapis odmówiony')
    this.name = 'BrakKluczaKlientow'
  }
}

export const KOMUNIKAT_BRAK_KLUCZA = 'Dane klienta niedostępne: brak klucza szyfrowania'

/** Pierścień kluczy danych klientów; brak zmiennej = BrakKluczaKlientow, zły format = BladSzyfruKlienta. */
export function kluczeKlientowZEnv(env: Env): KeyRing {
  if (!env['CUSTOMER_DATA_KEYS']?.trim()) throw new BrakKluczaKlientow()
  return keyRingFromEnv(env, { listVar: 'CUSTOMER_DATA_KEYS', brak: 'Brak CUSTOMER_DATA_KEYS', Blad: BladSzyfruKlienta })
}

/** Stan kluczy dla panelu i startu: komunikat bez materiału klucza. */
export function stanKluczyKlientow(env: Env): { dane: 'ok' | 'brak' | 'blad'; skroty: 'ok' | 'brak' | 'blad'; komunikat?: string } {
  let dane: 'ok' | 'brak' | 'blad' = 'ok'
  let skroty: 'ok' | 'brak' | 'blad' = 'ok'
  let komunikat: string | undefined
  try {
    kluczeKlientowZEnv(env)
  } catch (e) {
    dane = e instanceof BrakKluczaKlientow ? 'brak' : 'blad'
    if (dane === 'blad') komunikat = e instanceof Error ? e.message : String(e)
  }
  try {
    if (!kluczSkrotowZEnv(env)) skroty = 'brak'
  } catch (e) {
    skroty = 'blad'
    komunikat ??= e instanceof Error ? e.message : String(e)
  }
  return { dane, skroty, ...(komunikat ? { komunikat } : {}) }
}

export interface SzyfrogramKlienta {
  ciphertext: Uint8Array<ArrayBuffer>
  iv: Uint8Array<ArrayBuffer>
  authTag: Uint8Array<ArrayBuffer>
  keyVersion: number
}

/** Kopia do `Uint8Array<ArrayBuffer>` (typ kolumn Bytes Prismy 7). */
const bajty = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b)

const aad = (organizationId: string, orderId: string) => Buffer.from(`${organizationId}:klient:${orderId}`, 'utf8')

/** Szyfruje cały rekord najnowszym kluczem pierścienia. */
export function zaszyfrujKlienta(ring: KeyRing, organizationId: string, orderId: string, rekord: RekordKlienta): SzyfrogramKlienta {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', ring.keys.get(ring.current)!, iv)
  c.setAAD(aad(organizationId, orderId))
  const ciphertext = Buffer.concat([c.update(JSON.stringify(rekord), 'utf8'), c.final()])
  return { ciphertext: bajty(ciphertext), iv: bajty(iv), authTag: bajty(c.getAuthTag()), keyVersion: ring.current }
}

/** Odszyfrowuje kluczem wersji wpisu. Zły klucz, inna firma albo inne zamówienie (AAD) = BladSzyfruKlienta bez danych. */
export function odszyfrujKlienta(ring: KeyRing, organizationId: string, orderId: string, s: { ciphertext: Uint8Array; iv: Uint8Array; authTag: Uint8Array; keyVersion: number }): RekordKlienta {
  const key = ring.keys.get(s.keyVersion)
  if (!key)
    throw new BladSzyfruKlienta(`Dane klienta zaszyfrowano kluczem v${s.keyVersion}, którego nie ma w CUSTOMER_DATA_KEYS (są: ${[...ring.keys.keys()].map((v) => `v${v}`).join(', ')})`)
  let json: string
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(s.iv))
    d.setAAD(aad(organizationId, orderId))
    d.setAuthTag(Buffer.from(s.authTag))
    json = Buffer.concat([d.update(Buffer.from(s.ciphertext)), d.final()]).toString('utf8')
  } catch {
    // bez treści wyjątku kryptografii: tylko co się nie udało
    throw new BladSzyfruKlienta(`Nie da się odszyfrować danych klienta zamówienia ${orderId} (inny klucz v${s.keyVersion}, inna firma albo uszkodzony wpis)`)
  }
  try {
    return parseRekord(JSON.parse(json))
  } catch {
    throw new BladSzyfruKlienta(`Dane klienta zamówienia ${orderId} mają nieznany kształt`)
  }
}

export interface WynikPrzeszyfrowania {
  keyVersion: number
  przeszyfrowane: number
  /** Wpisy, którym przeliczono skróty (wszystkie przy `skroty: true`). */
  przeliczoneSkroty: number
  /** Wpisy zmienione w międzyczasie (nowszy zapis) — pominięte, są już najnowszym kluczem. */
  pominiete: number
  /** Wpisy wciąż zaszyfrowane inną wersją niż najnowsza (po udanym przebiegu 0). */
  pozostale: number
  /** Wpisy, których nie udało się odszyfrować ani zapisać: przebieg idzie dalej, numer zamówienia w logu. */
  bledy: number
}

/**
 * Przeszyfrowanie danych klientów firmy `organizationId` (klient `db` tej firmy, RLS) najnowszym kluczem, w partiach
 * po `partia` wpisów. `skroty: true` = także przeliczenie skrótów wszystkich wpisów (po zmianie CUSTOMER_LOOKUP_KEY).
 * Zapis warunkowy (ta sama wersja i data zmiany), więc równoległy zapis nowszego odczytu nie zostanie cofnięty.
 * Wartości nie wychodzą poza funkcję; wynik to same liczby.
 */
export async function reencryptCustomers(
  db: PrismaClient,
  organizationId: string,
  env: Env,
  opts: { skroty?: boolean; partia?: number } = {},
): Promise<WynikPrzeszyfrowania> {
  if (organizationIdOf(db) !== organizationId) throw new BladSzyfruKlienta('reencryptCustomers: klient bazy innej firmy')
  const ring = kluczeKlientowZEnv(env)
  const key = kluczSkrotowZEnv(env)
  if (opts.skroty && !key) throw new BrakKluczaSkrotow()
  const partia = Math.max(1, Math.min(opts.partia ?? 200, 1000))
  const where = opts.skroty ? {} : { keyVersion: { not: ring.current } }
  let po: string | undefined
  let przeszyfrowane = 0
  let przeliczoneSkroty = 0
  let pominiete = 0
  let bledy = 0
  for (;;) {
    const rows = await db.orderCustomer.findMany({ where: { ...where, ...(po ? { id: { gt: po } } : {}) }, orderBy: { id: 'asc' }, take: partia })
    if (!rows.length) break
    po = rows.at(-1)!.id
    for (const r of rows) {
      // błąd per wpis (uszkodzony szyfrogram, klucz usunięty z env): licznik i log bez danych, dalej następny wpis
      try {
        const rekord = odszyfrujKlienta(ring, organizationId, r.orderId, r)
        const nowy = r.keyVersion === ring.current ? null : zaszyfrujKlienta(ring, organizationId, r.orderId, rekord)
        const sk = opts.skroty && key ? (r.purgedAt ? { emailHash: null, phoneHash: null, nipHash: null, country: null } : { ...skrotyRekordu(key, organizationId, rekord), country: krajDostawy(rekord) }) : null
        if (!nowy && !sk) continue
        const u = await db.orderCustomer.updateMany({ where: { id: r.id, keyVersion: r.keyVersion, updatedAt: r.updatedAt }, data: { ...(nowy ?? {}), ...(sk ?? {}) } })
        if (!u.count) {
          pominiete++
          continue
        }
        if (nowy) przeszyfrowane++
        if (sk) przeliczoneSkroty++
      } catch (e) {
        bledy++
        console.warn(`[klienci] przeszyfrowanie nie powiodło się: zamówienie ${r.orderId}, ${e instanceof Error ? e.name : 'nieznany'}`)
      }
    }
  }
  const pozostale = await db.orderCustomer.count({ where: { keyVersion: { not: ring.current } } })
  return { keyVersion: ring.current, przeszyfrowane, przeliczoneSkroty, pominiete, pozostale, bledy }
}

/** Liczba wpisów firmy per wersja klucza (CLI `klienci stan`): same liczby. */
export async function wersjeKluczyKlientow(db: PrismaClient): Promise<{ keyVersion: number; wpisy: number }[]> {
  const g = await db.orderCustomer.groupBy({ by: ['keyVersion'], _count: { _all: true }, orderBy: { keyVersion: 'desc' } })
  return g.map((x) => ({ keyVersion: x.keyVersion, wpisy: x._count._all }))
}
