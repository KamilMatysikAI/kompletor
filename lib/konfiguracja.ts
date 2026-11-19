// Klienci źródeł (BL, wFirma, Empik) dla jednej firmy: klucze z sekretów firmy (lib/sekrety.ts,
// fallback env tylko w self-hoście jednofirmowym), parametry (inventory BL, magazyn wFirmy, sklepy, konto Empik)
// z konfiguracji firmy w bazie. Wartości sekretów nigdy nie są logowane — tylko informacja „jest/brak”.
import type { PrismaClient } from '@prisma/client'
import { NonRetryableError } from './bledy'
import { type ImportConfig, loadImportConfig } from './organizacje'
import { resolveSecrets, type SecretSource } from './sekrety'
import { BaseLinkerReadOnly } from './zrodla/baselinker'
import { MiraklReadOnly } from './zrodla/mirakl'
import { WfirmaReadOnly } from './zrodla/wfirma'

export type Env = Record<string, string | undefined>

export interface SourceClients {
  bl: BaseLinkerReadOnly
  wfirma: WfirmaReadOnly | null
  empik: MiraklReadOnly | null
  config: ImportConfig
  /** Brakujące klucze, bez których import do bazy jest odrzucany (wFirma: bez towarów nie powstaje żaden produkt). */
  missing: string[]
  /**
   * Brakujące klucze źródeł opcjonalnych (Empik): import idzie dalej, źródło pominięte = `FetchIssue` brak-kluczy,
   * kanał niepełny, nic w nim nie jest wyłączane (r3, drobna 7).
   */
  missingOptional: string[]
}

export const WFIRMA_KEYS = ['WFIRMA_ACCESS_KEY', 'WFIRMA_SECRET_KEY', 'WFIRMA_APP_KEY', 'WFIRMA_COMPANY_ID'] as const
const EMPIK_KEYS = ['EMPIK_MIRAKL_BASE_URL', 'EMPIK_MIRAKL_API_KEY'] as const
export const SOURCE_SECRET_NAMES = ['BASELINKER_TOKEN', ...WFIRMA_KEYS, ...EMPIK_KEYS] as const

/** Czysta część: z gotowych wartości kluczy i konfiguracji. */
export function clientsFrom(secrets: Record<string, string | undefined>, config: ImportConfig): SourceClients {
  const missing: string[] = []
  const missingOptional: string[] = []
  if (!secrets['BASELINKER_TOKEN']) throw new NonRetryableError('Brak BASELINKER_TOKEN — import katalogu wymaga BL')
  const bl = new BaseLinkerReadOnly(secrets['BASELINKER_TOKEN'])
  let wfirma: WfirmaReadOnly | null = null
  if (WFIRMA_KEYS.every((k) => secrets[k])) {
    wfirma = new WfirmaReadOnly({
      accessKey: secrets['WFIRMA_ACCESS_KEY']!,
      secretKey: secrets['WFIRMA_SECRET_KEY']!,
      appKey: secrets['WFIRMA_APP_KEY']!,
      companyId: secrets['WFIRMA_COMPANY_ID']!,
    })
  } else missing.push(...WFIRMA_KEYS.filter((k) => !secrets[k]))
  let empik: MiraklReadOnly | null = null
  if (secrets['EMPIK_MIRAKL_BASE_URL'] && secrets['EMPIK_MIRAKL_API_KEY'])
    empik = new MiraklReadOnly(secrets['EMPIK_MIRAKL_BASE_URL'], secrets['EMPIK_MIRAKL_API_KEY'])
  // Brak kluczy Empiku zgłaszamy tylko, gdy firma ma konto Empik w konfiguracji.
  else if (config.empikAccountId) missingOptional.push(...EMPIK_KEYS.filter((k) => !secrets[k]))
  if (wfirma && !config.wfirmaWarehouseId) throw new NonRetryableError('Magazyn firmy nie ma wfirmaWarehouseId — nie wiadomo, z którego magazynu wFirmy czytać stan')
  return { bl, wfirma, empik, config, missing, missingOptional }
}

/** Klienci źródeł firmy klienta `db`. */
export async function clientsForOrg(db: PrismaClient, src: SecretSource): Promise<SourceClients> {
  const [secrets, config] = await Promise.all([resolveSecrets(db, SOURCE_SECRET_NAMES, src), loadImportConfig(db)])
  return clientsFrom(secrets, config)
}
