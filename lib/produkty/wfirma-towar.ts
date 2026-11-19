// odczyt jednego towaru wFirmy po kodzie (SKU) dla „Dodaj produkt”. Zawsze w workerze, nigdy w akcji
// serwera: klient wFirmy ma limit 90 s i ponowienia, a klucz dzieli z fakturami BL — przycisk w panelu tylko
// zleca zadanie i odświeża ekran. Tylko `*/find` przez WfirmaReadOnly (blokada zapisu w kliencie).
//
// Wynik trafia do kopii `WfirmaGood` (jak z importu katalogu, z własnym ImportRun rodzaju `wfirma-towar`), a werdykt
// do `ImportRun.stats` (SKU, wynik, kody towarów — bez danych klientów). Limit albo odmowa wFirmy kończy zadanie bez
// ponawiania (maxAttempts 1): kolejne żądanie w trakcie blokady klucza tylko by ją przedłużyło.
import type { Prisma, PrismaClient } from '@prisma/client'
import { NonRetryableError } from '../bledy'
import { isWfirmaLimit, limitWaitMs } from '../cien/odczyt-stanow-wfirmy'
import { organizationIdOf } from '../db'
import { clientsForOrg } from '../konfiguracja'
import { LIMIT_PAUSE_MS } from '../rdzen/kolejka-wfirmy'
import { vatRatesFromApi, wfGoodFromApi, type WfGood } from '../import/normalizacja'
import type { SecretSource } from '../sekrety'
import { enqueue } from '../worker/kolejka'
import { SourceError } from '../zrodla/http'
import { wfirmaItems, type WfirmaReadOnly } from '../zrodla/wfirma'
import { checkSku } from './walidacja'

export const WFIRMA_GOOD_JOB = 'wfirma-towar-odczyt'
export const WFIRMA_GOOD_RUN = 'wfirma-towar'
export const LIMIT_MESSAGE = 'wFirma chwilowo odmawia, spróbuj za kilka minut.'
export const NOT_FOUND_MESSAGE = 'Nie ma takiego SKU w wFirmie.'

export type LookupResult =
  | { wynik: 'znaleziono'; sku: string; towarId: string; typ: string }
  | { wynik: 'brak'; sku: string; innyMagazyn?: string[] }
  | { wynik: 'kilka'; sku: string; towary: { id: string; nazwa: string; typ: string }[] }
  | { wynik: 'limit'; sku: string; komunikat: string }
  | { wynik: 'blad'; sku: string; komunikat: string }

export const dedupeKeyOf = (sku: string) => `${WFIRMA_GOOD_JOB}:${sku}`

/** Zleca odczyt towaru (jedno zadanie na SKU naraz, bez ponawiania). null = takie zadanie już czeka. */
export async function requestWfirmaGood(db: PrismaClient, sku: string): Promise<string | null> {
  return enqueue(db, WFIRMA_GOOD_JOB, { sku }, { dedupeKey: dedupeKeyOf(sku), maxAttempts: 1 })
}

/**
 * Wspólna pauza klucza wFirmy: ta sama, którą ustawia kolejka wFirmy z lustrem stanów
 * (`WfirmaQueueState.pausedUntil`, lib/rdzen/kolejka-wfirmy.ts). Odczyt towaru jej nie omija i sam ją ustawia po limicie,
 * żeby klik „Sprawdź” nie przedłużał blokady lustra, a lustro nie biło w klucz zablokowany przez odczyt towaru.
 */
export async function wfirmaPausedUntil(db: PrismaClient, now = new Date()): Promise<Date | null> {
  const s = await db.wfirmaQueueState.findFirst({ select: { pausedUntil: true } })
  return s?.pausedUntil && s.pausedUntil > now ? s.pausedUntil : null
}

async function pauseWfirmaKey(db: PrismaClient, message: string, now = new Date()): Promise<void> {
  const until = new Date(now.getTime() + (limitWaitMs(message) ?? LIMIT_PAUSE_MS))
  const organizationId = organizationIdOf(db)
  const pauseReason = `odczyt towaru (Dodaj produkt): ${message}`.slice(0, 500)
  const cur = await db.wfirmaQueueState.findFirst({ select: { pausedUntil: true } })
  if (cur?.pausedUntil && cur.pausedUntil >= until) return // dłuższa pauza już trwa, nie skracamy
  await db.wfirmaQueueState.upsert({ where: { organizationId }, create: { organizationId, pausedUntil: until, pauseReason }, update: { pausedUntil: until, pauseReason } })
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500)
const dec = (n: number | null, digits = 2) => (n === null ? null : n.toFixed(digits))

/**
 * Towar wFirmy o kodzie `sku`: `goods/find` z warunkiem `code eq` (format jak `invoices/find` w lib/cien/faktury-bl.ts),
 * stawki VAT z `vat_codes/find`. Wynik filtrowany jeszcze raz po kodzie (wFirma ignorująca nieznany warunek oddałaby
 * wszystko). Towar z innego magazynu odrzucony jak w imporcie (lib/import/pobieranie.ts); usługa bez magazynu zostaje.
 */
export async function findWfirmaGood(wf: Pick<WfirmaReadOnly, 'call'>, sku: string, warehouseId: string | null): Promise<{ goods: WfGood[]; otherWarehouse: string[] }> {
  const vc = await wf.call<{ vat_codes: unknown }>('vat_codes/find', { api: { vat_codes: { parameters: { page: 1, limit: 100 } } } })
  const vat = vatRatesFromApi(wfirmaItems<Record<string, unknown>>(vc.vat_codes, 'vat_code'))
  const r = await wf.call<{ goods: unknown }>('goods/find', {
    api: { goods: { parameters: { conditions: { condition: { field: 'code', operator: 'eq', value: sku } }, page: 1, limit: 20 } } },
  })
  const goods: WfGood[] = []
  const otherWarehouse: string[] = []
  for (const raw of wfirmaItems<Record<string, unknown>>(r.goods, 'good')) {
    const g = wfGoodFromApi(raw, vat)
    if (g.code !== sku) continue
    const serviceWithoutWarehouse = g.type === 'service' && g.warehouseId === null
    if (warehouseId && g.warehouseId !== warehouseId && !serviceWithoutWarehouse) {
      otherWarehouse.push(g.id)
      continue
    }
    goods.push(g)
  }
  return { goods: [...new Map(goods.map((g) => [g.id, g])).values()], otherWarehouse }
}

/**
 * Odczyt i zapis wyniku: kopia `WfirmaGood` przy jednym trafieniu, werdykt w `ImportRun` zawsze. Limit wFirmy →
 * `NonRetryableError` (zadanie FAILED bez ponawiania), inne błędy też kończą zadanie (maxAttempts 1).
 */
export async function lookupWfirmaGood(
  db: PrismaClient,
  source: { wf: Pick<WfirmaReadOnly, 'call'> | null; warehouseId: string | null } | { unavailable: string },
  sku: string,
): Promise<LookupResult> {
  const run = await db.importRun.create({ data: { kind: WFIRMA_GOOD_RUN } })
  const finish = async (res: LookupResult, status: 'OK' | 'FAILED') => {
    const error = res.wynik === 'limit' || res.wynik === 'blad' ? res.komunikat : null
    await db.importRun.update({ where: { id: run.id }, data: { status, finishedAt: new Date(), error, stats: res as unknown as Prisma.InputJsonValue } })
    return res
  }
  if ('unavailable' in source) return finish({ wynik: 'blad', sku, komunikat: source.unavailable }, 'FAILED')
  const { wf, warehouseId } = source
  if (!wf) return finish({ wynik: 'blad', sku, komunikat: 'Firma nie ma kluczy wFirmy — nie da się sprawdzić SKU.' }, 'FAILED')
  // klucz wstrzymany przez kolejkę wFirmy (lustro, faktury) albo wcześniejszy odczyt: bez wywołania, żeby nie przedłużać blokady
  const paused = await wfirmaPausedUntil(db)
  if (paused) {
    await finish({ wynik: 'limit', sku, komunikat: LIMIT_MESSAGE }, 'FAILED')
    throw new NonRetryableError(`${WFIRMA_GOOD_JOB}: klucz wFirmy wstrzymany do ${paused.toISOString()}`)
  }
  let found: Awaited<ReturnType<typeof findWfirmaGood>>
  try {
    found = await findWfirmaGood(wf, sku, warehouseId)
  } catch (e) {
    if (e instanceof SourceError && !e.retryable) {
      if (isWfirmaLimit(e)) await pauseWfirmaKey(db, e.message)
      await finish({ wynik: 'limit', sku, komunikat: LIMIT_MESSAGE }, 'FAILED')
      throw new NonRetryableError(`${WFIRMA_GOOD_JOB}: ${errText(e)}`)
    }
    await finish({ wynik: 'blad', sku, komunikat: `Nie udało się sprawdzić w wFirmie: ${errText(e)}` }, 'FAILED')
    throw e
  }
  const { goods, otherWarehouse } = found
  if (goods.length === 0) return finish({ wynik: 'brak', sku, ...(otherWarehouse.length ? { innyMagazyn: otherWarehouse } : {}) }, 'OK')
  if (goods.length > 1) return finish({ wynik: 'kilka', sku, towary: goods.map((g) => ({ id: g.id, nazwa: g.name.slice(0, 200), typ: g.type })) }, 'OK')
  const g = goods[0]!
  const data = {
    code: g.code,
    name: g.name,
    type: g.type,
    unit: g.unitRaw,
    vatCodeId: g.vatCodeId,
    vatRate: g.vatRate,
    priceNetRetail: dec(g.priceNetRetail),
    priceGrossRetail: dec(g.priceGrossRetail),
    purchasePriceNet: dec(g.purchasePriceNet, 4),
    count: dec(g.count, 4),
    warehouseId: g.warehouseId,
    ean: g.ean,
    visibility: g.visibility,
    modified: g.modified,
    importRunId: run.id,
    importedAt: new Date(),
  }
  const organizationId = organizationIdOf(db)
  await db.wfirmaGood.upsert({ where: { organizationId_id: { organizationId, id: g.id } }, create: { organizationId, id: g.id, ...data }, update: data })
  return finish({ wynik: 'znaleziono', sku, towarId: g.id, typ: g.type }, 'OK')
}

/** Handler zadania `wfirma-towar-odczyt` (lib/worker/zadania.ts): klucze i magazyn wFirmy z konfiguracji firmy. */
export async function zadanieOdczytuTowaru(db: PrismaClient, payload: Prisma.JsonValue, ctx: { secrets: SecretSource }): Promise<void> {
  const raw = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>)['sku'] : undefined
  const sku = checkSku(raw)
  if (!sku.ok) throw new NonRetryableError(`${WFIRMA_GOOD_JOB}: ${sku.error}`)
  let source: Parameters<typeof lookupWfirmaGood>[1]
  try {
    const c = await clientsForOrg(db, ctx.secrets) // sekrety i konfiguracja z bazy — bez sieci
    source = { wf: c.wfirma, warehouseId: c.config.wfirmaWarehouseId }
  } catch (e) {
    // brak konfiguracji albo kluczy: werdykt dla ekranu i koniec bez ponawiania
    await lookupWfirmaGood(db, { unavailable: `Nie da się sprawdzić w wFirmie: ${errText(e)}` }, sku.value)
    throw new NonRetryableError(`${WFIRMA_GOOD_JOB}: ${errText(e)}`)
  }
  const res = await lookupWfirmaGood(db, source, sku.value)
  if (res.wynik === 'blad') throw new NonRetryableError(`${WFIRMA_GOOD_JOB}: ${res.komunikat}`)
}
