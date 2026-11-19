// Czy firma ma BaseLinkera i wFirmę: od tego zależy, czy oferta z kanału jest od razu aktywna, czy
// produkt może powstać z danych kanału i czy stan to lustro wFirmy. Bez odszyfrowania sekretów: sama obecność.
import type { PrismaClient } from '@prisma/client'
import { cache } from 'react'
import { appModeOf } from '../db'
import { parseOrgSettings } from '../organizacje'
import { DEFAULT_WAREHOUSE } from '../rdzen/stan'
import { zrodloStanu } from '../rdzen/zrodlo-stanu'
import type { SecretSource } from '../sekrety'

/** BL: token firmy (baza albo env self-hostu) albo inventory BL w ustawieniach firmy. */
export async function firmaMaBl(db: PrismaClient, src: SecretSource): Promise<boolean> {
  const org = await db.organization.findFirst({ select: { settings: true } })
  if (parseOrgSettings(org?.settings).baselinker?.inventoryId) return true
  if ((await db.integrationSecret.count({ where: { name: 'BASELINKER_TOKEN', channel: null } })) > 0) return true
  return src.envFallback && !!src.env['BASELINKER_TOKEN']
}

/**
 * Firma przechodzi z BaseLinkera (bramka trybu pracy): ślad przejścia, nie sam klucz.
 * Liczy się katalog BL w ustawieniach (`baselinker.inventoryId`: cień, porównania, presety, np. pierwsza firma),
 * zapis przeprowadzki (`baselinker.przeprowadzka.pierwszyZapis` albo udany przebieg `PRZEPROWADZKA`) i token BL
 * w env self-hostu (ustawia go administrator serwera). Klucz BL zapisany w panelu (sekret firmy w bazie) sam
 * niczego nie przełącza: otwiera tylko ekran przeprowadzki i menu „Przejście z BaseLinkera” (`firmaMaBl`).
 */
export async function firmaPrzechodziZBl(db: PrismaClient, src: SecretSource): Promise<boolean> {
  const tokenSerwera = src.envFallback && !!src.env['BASELINKER_TOKEN']
  if (tokenSerwera) return true // klucz w konfiguracji serwera: o całej instancji decyduje administrator
  const org = await db.organization.findFirst({ select: { settings: true } })
  // „Przejście z BaseLinkera zakończone” (ekran przeprowadzki) zdejmuje ślad przejścia, ale tylko ten
  // z przeprowadzki: katalog BL bez zapisu przeprowadzki (preset, cień, np. pierwsza firma) zostaje za wyłącznikiem instancji
  // ślad liczy się tylko wtedy, gdy katalog BL ustawiła sama przeprowadzka (katalogPrzedPrzeprowadzka)
  if (przejscieZakonczone(org?.settings) && sladPrzeprowadzki(org?.settings) && !katalogPrzedPrzeprowadzka(org?.settings)) return false
  if (parseOrgSettings(org?.settings).baselinker?.inventoryId) return true
  if (sladPrzeprowadzki(org?.settings)) return true
  // ta sama definicja „przeprowadzka zapisana” co lista startu (OK albo z uwagami)
  return (await db.importRun.count({ where: { kind: RODZAJ_PRZEBIEGU_BL, status: { in: ['OK', 'PARTIAL'] } } })) > 0
}

/** Rodzaj przebiegu zapisu przeprowadzki (`RODZAJ_PRZEBIEGU` w lib/przeprowadzka/zapis.ts; tu bez importu modułu zapisu). */
const RODZAJ_PRZEBIEGU_BL = 'PRZEPROWADZKA'

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)

/** Zapis przeprowadzki zostawił ślad w ustawieniach firmy (`baselinker.przeprowadzka.pierwszyZapis`). */
export function sladPrzeprowadzki(settings: unknown): boolean {
  const p = obj(obj(obj(settings)?.['baselinker'])?.['przeprowadzka'])
  return typeof p?.['pierwszyZapis'] === 'string' && p['pierwszyZapis'] !== ''
}

/**
 * Katalog BL firmy nie pochodzi z przeprowadzki z panelu: był w ustawieniach przed pierwszym
 * zapisem przeprowadzki (`przeprowadzka.katalogPrzed`, preset albo cień, np. pierwsza firma) albo jest inny niż ten,
 * który przeprowadzka zapisała (`przeprowadzka.katalogZapisu`; brak pola przy katalogu = zapis sprzed tej zmiany,
 * liczony ostrożnie jak katalog z presetu). Wtedy znacznik „przejście zakończone” nie zdejmuje bramki trybu pracy:
 * o takiej firmie decyduje administrator serwera (`EKRANY_PRACA`), w każdej kolejności operacji.
 */
export function katalogPrzedPrzeprowadzka(settings: unknown): boolean {
  const bl = obj(obj(settings)?.['baselinker'])
  const p = obj(bl?.['przeprowadzka'])
  if (p?.['katalogPrzed'] === true) return true
  const inv = bl?.['inventoryId']
  if (typeof inv !== 'string' || inv === '') return false
  return p?.['katalogZapisu'] !== inv
}

/** Powód odmowy znacznika dla firmy z katalogiem BL sprzed przeprowadzki (ekran i akcja). */
export const ODMOWA_KATALOG_PRZED =
  'Katalog BaseLinkera był ustawiony dla tej firmy przed przeprowadzką z panelu (przy zakładaniu firmy albo w porównaniu z BaseLinkerem). Tryb pracy dla takiej firmy włącza administrator serwera.'

/** Znacznik „przejście z BaseLinkera zakończone” (`baselinker.przejscieZakonczone`); null = brak. */
export function przejscieZakonczone(settings: unknown): { at: string; przez: string } | null {
  const z = obj(obj(obj(settings)?.['baselinker'])?.['przejscieZakonczone'])
  return z && typeof z['at'] === 'string' && z['at'] !== '' ? { at: z['at'], przez: typeof z['przez'] === 'string' ? z['przez'] : '' } : null
}

/**
 * wFirma prowadzi stan magazynu (źródło stanu WFIRMA): stan fizyczny to lustro wFirmy. Jawne
 * `Warehouse.stockSource` wygrywa; bez niego dawna reguła: magazyn firmy wskazuje magazyn wFirmy.
 */
export async function firmaMaWfirme(db: PrismaClient, warehouseId = DEFAULT_WAREHOUSE): Promise<boolean> {
  return (await zrodloStanu(db, warehouseId)) === 'WFIRMA'
}

/**
 * To samo dla ekranów panelu: env procesu web, fallback na env tylko w self-hoście (jak `envSecretsAllowed` dla jedynej
 * firmy; tu do wyświetlania, więc bez liczenia firm).
 */
export async function firmaMaBlWPanelu(db: PrismaClient, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  return firmaMaBl(db, { env, envFallback: appModeOf(env) === 'self-host' })
}

/**
 * `firmaPrzechodziZBl` dla ekranów i akcji panelu (env procesu web, fallback na env tylko w self-hoście). Raz na
 * żądanie (karta liczyła to dwa razy): React `cache` po kliencie bazy z sesji i env; poza
 * serwerem Next (worker, testy) liczy za każdym razem.
 */
export async function firmaPrzechodziZBlWPanelu(db: PrismaClient, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  return przechodziRazNaZadanie(db, env)
}

const przechodziRazNaZadanie = cache((db: PrismaClient, env: Record<string, string | undefined>) => firmaPrzechodziZBl(db, { env, envFallback: appModeOf(env) === 'self-host' }))
