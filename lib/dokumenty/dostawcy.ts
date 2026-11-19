// Wybór dostawcy dokumentów sprzedaży firmy: program z ustawień → implementacja. `brak` = firma nie
// wystawia dokumentów z Kompletora (zamówienia zamykają się bez faktury). Program spoza wbudowanych to klucz adaptera
// `invoicing` z rejestru — host tworzy adapter (konfiguracja i sekrety jak konta kanałów) i podaje go w `adapter`.
import type { ChannelAdapter } from '../adaptery/kontrakt'
import { dostawcaKsef } from '../ksef/dostawca'
import type { FakturyWfirma } from '../rdzen/rozchod'
import type { KorektyWfirma } from '../rdzen/zwroty'
import type { WzWfirma } from '../wfirma/wz'
import { dostawcaWfirmy } from '../wfirma/dostawca'
import type { DostawcaDokumentow } from './kontrakt'
import { ETYKIETA_PROGRAMU, type ProgramDokumentow } from './ustawienia'
import { dostawcaZAdaptera } from './z-adaptera'

export const DOSTAWCA_BRAK: DostawcaDokumentow = { program: 'brak', nazwa: ETYKIETA_PROGRAMU.brak, zdolnosci: [] }

export class BrakDostawcyError extends Error {}

export interface ZaleznosciDostawcy {
  /** wFirma: API zapisu z kolejki (bez = tylko lustro stanu). */
  wfirma?: { faktury?: FakturyWfirma | null; korekty?: KorektyWfirma | null; wz?: WzWfirma | null }
  /** Inny program: utworzony adapter z rejestru (rodzaj `invoicing`) o kluczu równym programowi. */
  adapter?: ChannelAdapter | null
}

export function dostawcaDokumentow(program: ProgramDokumentow, deps: ZaleznosciDostawcy = {}): DostawcaDokumentow {
  if (program === 'brak') return DOSTAWCA_BRAK
  if (program === 'wfirma') return dostawcaWfirmy(deps.wfirma ?? {})
  if (program === 'ksef') return dostawcaKsef()
  const a = deps.adapter
  if (!a || a.manifest.adapterKey !== program) throw new BrakDostawcyError(`Program do faktur „${program}” nie jest podłączony (brak adaptera w rejestrze)`)
  return dostawcaZAdaptera(a)
}
