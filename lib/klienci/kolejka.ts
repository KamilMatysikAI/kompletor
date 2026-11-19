// Zadanie zapisu danych klienta: rdzeń przyjmowania zamówień (`ingestOrder`) dodaje w swojej transakcji
// wiersz `Job` typu KLIENT_ZAPIS z samym Order.id — bez danych i bez czytania kanału w transakcji. Plik bez zależności
// od adapterów, żeby rdzeń nie ciągnął za sobą kanałów. Wykonanie: lib/klienci/zapis.ts (`wykonajZapisKlienta`).
import type { Prisma } from '@prisma/client'

export const KLIENT_ZAPIS_JOB = 'KLIENT_ZAPIS'
/** Ponowienia przy błędzie przejściowym kanału (backoff kolejki: 30 s, 1 min, 2 min … do 1 h). */
export const KLIENT_ZAPIS_PROB = 8

export const dedupeZapisu = (orderId: string) => `${KLIENT_ZAPIS_JOB}:${orderId}`

/**
 * `DANE_KLIENTA_ZAPIS`: `1` = instancja zapisuje dane klienta w bazie (zadanie po przyjęciu zamówienia,
 * „Odśwież z kanału”); puste albo `0` = nie (domyślnie). Zła wartość = błąd, nie po cichu (wzorem DANE_ODBIORCY_Z_KANALU).
 */
export function zapisKlientaZEnv(env: Record<string, string | undefined>): boolean {
  const v = (env.DANE_KLIENTA_ZAPIS ?? '').trim()
  if (v === '1') return true
  if (v === '' || v === '0') return false
  throw new Error('DANE_KLIENTA_ZAPIS: 1 (włączony), 0 albo puste (wyłączony)')
}

/** Jak `zapisKlientaZEnv`, ale zła wartość = wyłączone: przyjmowanie zamówień nie może stanąć przez literówkę w env. */
export function zapisKlientaWlaczony(env: Record<string, string | undefined>): boolean {
  try {
    return zapisKlientaZEnv(env)
  } catch {
    return false
  }
}

/**
 * W transakcji rdzenia: zadanie KLIENT_ZAPIS zamówienia, deduplikowane per zamówienie (unikalny `dedupeKey` w firmie).
 * `ON CONFLICT DO NOTHING` zamiast `enqueue` z łapaniem P2002: błąd unikalności przerwałby transakcję Postgresa.
 * Czekające zadanie i tak przeczyta kanał w chwili wykonania, więc druga rewizja przed jego startem nic nie dokłada.
 */
export async function zaplanujZapisKlienta(tx: Prisma.TransactionClient, orderId: string, now: Date): Promise<void> {
  const id = 'kz_' + globalThis.crypto.randomUUID().replace(/-/g, '')
  const payload = JSON.stringify({ orderId })
  await tx.$executeRaw`
    INSERT INTO "Job" (id, kind, payload, "dedupeKey", "runAfter", "maxAttempts", "updatedAt")
    VALUES (${id}, ${KLIENT_ZAPIS_JOB}, ${payload}::jsonb, ${dedupeZapisu(orderId)}, ${now}, ${KLIENT_ZAPIS_PROB}, ${now})
    ON CONFLICT ("organizationId", "dedupeKey") DO NOTHING`
}
