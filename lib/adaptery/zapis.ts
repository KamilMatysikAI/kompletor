// Wykonanie zapisu przez adapter z czterema wynikami (kontrakt pkt 3). Zasada: wynik niejednoznaczny
// (timeout albo 5xx po wysłaniu) nigdy nie jest ponawiany w ciemno — najpierw odszukanie po referencji. Bez
// odszukania zostaje NIEJEDNOZNACZNY i trafia do człowieka (alert), bo ponowienie mogłoby wykonać zapis dwa razy
// (druga etykieta, podwójne pobranie, podwójna zmiana stanu).
import { AdapterError, type ChannelAdapter, hasReferenceFinder, type WriteOutcome } from './kontrakt'

// 1000 znaków, bo odszukanie Orlen Paczki podaje wykaz sprawdzonych paczek z godzinami
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 1000)

/**
 * Uruchamia zapis `op` pod referencją `reference`. Wyjątki adaptera są zamieniane na wynik: AdapterError wg rodzaju,
 * każdy inny wyjątek = NIEJEDNOZNACZNY (nie wiadomo, czy żądanie doszło). Przy NIEJEDNOZNACZNYM i zdolności
 * `reference.find`: znaleziono → OK, nie znaleziono → PRZEJSCIOWY (bezpiecznie ponowić tą samą referencją),
 * błąd odszukania → zostaje NIEJEDNOZNACZNY.
 */
export async function executeWrite(adapter: ChannelAdapter, reference: string, op: () => Promise<WriteOutcome>): Promise<WriteOutcome> {
  let out: WriteOutcome
  try {
    out = await op()
    if (out.reference !== reference) out = { kind: 'NIEJEDNOZNACZNY', reference, message: 'adapter zwrócił wynik z inną referencją' }
  } catch (e) {
    out =
      e instanceof AdapterError
        ? {
            kind: e.kind,
            reference,
            message: msg(e),
            ...(e.retryAfterMs ? { retryAfterMs: e.retryAfterMs } : {}),
            ...(e.errorClass ? { errorClass: e.errorClass } : {}),
            // zapis odłożony przez host (limit tempa, konto wyłączone po błędach) — nic nie wyszło, to nie próba
            ...((e as { odlozone?: unknown }).odlozone === true ? { odlozone: true } : {}),
          }
        : { kind: 'NIEJEDNOZNACZNY', reference, message: `nieznany błąd zapisu: ${msg(e)}` }
  }
  if (out.kind !== 'NIEJEDNOZNACZNY' || !hasReferenceFinder(adapter)) return out
  try {
    const found = await adapter.findByReference(reference)
    if (found.found) return { kind: 'OK', reference, ...(found.externalRef ? { externalRef: found.externalRef } : {}) }
    return { kind: 'PRZEJSCIOWY', reference, message: `zapis nie wykonał się w kanale (odszukanie po referencji): ${out.message}` }
  } catch (e) {
    return { kind: 'NIEJEDNOZNACZNY', reference, message: `${out.message}; odszukanie po referencji nieudane: ${msg(e)}` }
  }
}

/** Czy host może ponowić automatycznie (tylko PRZEJSCIOWY; OK nie trzeba, TRWALY i NIEJEDNOZNACZNY — człowiek). */
export function mayRetry(o: WriteOutcome): boolean {
  return o.kind === 'PRZEJSCIOWY'
}
