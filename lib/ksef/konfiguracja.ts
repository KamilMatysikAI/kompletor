// Ustawienia KSeF firmy: `Organization.settings.ksef`, czytane z surowego JSON jak `parseKonfiguracjaFaktur`.
// Wybór programu do faktur: `Organization.settings.faktury.program` — w lib/dokumenty/ustawienia.ts
// (`brak` | `wfirma` | `ksef` | klucz adaptera); tu reeksport dla dawnych wywołań.
// Bez sekretów: token KSeF to sekret integracji (`KSEF_TOKEN`), nie ustawienie.
// pełna seria faktur (kod, wzór, reset) i osobna seria korekt, środowisko KSeF firmy (domyślnie TEST;
// produkcja wymaga jeszcze bramki instancji, lib/ksef/bramka.ts).
import type { Prisma } from '@prisma/client'
import { OKRESY_RESETU, type OkresResetu, type SeriaNumeracji } from './numeracja'
import type { ProblemFa3, SprzedawcaFa3 } from './fa3/typy'
import { poprawnyNip } from './fa3/builder'
import { parseProfilFirmy } from '../firma/profil'

export { programFaktur } from '../dokumenty/ustawienia'
export type { ProgramDokumentow as ProgramFaktur } from '../dokumenty/ustawienia'

export interface KonfiguracjaKsef {
  /** null = brak danych sprzedawcy (problem w `problemy`). */
  sprzedawca: SprzedawcaFa3 | null
  /** Kod serii numeracji (`InvoiceNumberSeries.code`); null = nieustawiona (problem). */
  seriaKod: string | null
  /** Faktury dla osób prywatnych bez NIP do KSeF; domyślnie nie (zasada właściciela 28.09.2026). */
  konsumenciDoKsef: boolean
  /** Podstawa prawna zwolnienia (P_19A) dla pozycji „zw”. */
  podstawaZwolnienia: string | null
  problemy: ProblemFa3[]
  /** seria faktur z wzorem i resetem; null = nieustawiona. */
  seria: SeriaNumeracji | null
  /** seria korekt (osobny licznik); null = nieustawiona (korekty do KSeF wtedy się nie wysyłają). */
  seriaKorekt: SeriaNumeracji | null
  /** środowisko KSeF firmy; domyślnie TEST. */
  srodowisko: SrodowiskoFirmy
  /**
   * (do rozstrzygnięcia przez księgową): data wystawienia (P_1) przy ponowieniu wysyłki.
   * `PIERWSZA_PROBA` (domyślnie, zachowanie) = data zamrożona przy pierwszej próbie razem z numerem;
   * `DZIEN_WYSYLKI` = przy ponowieniu dzień faktycznego przesłania do KSeF (art. 106na), ale tylko gdy żadna wcześniejsza
   * wersja nie może już być w KSeF (`hasheWyslane` puste: nic nie wysłano albo KSeF odrzucił); numer z serii zostaje.
   */
  dataPrzyPonowieniu: DataPrzyPonowieniu
}

export const DATY_PRZY_PONOWIENIU = ['PIERWSZA_PROBA', 'DZIEN_WYSYLKI'] as const
export type DataPrzyPonowieniu = (typeof DATY_PRZY_PONOWIENIU)[number]

export const SRODOWISKA_FIRMY = ['TEST', 'DEMO', 'PROD'] as const
export type SrodowiskoFirmy = (typeof SRODOWISKA_FIRMY)[number]
export const ETYKIETA_SRODOWISKA: Record<SrodowiskoFirmy, string> = { TEST: 'testowe (KSeF TEST)', DEMO: 'przedprodukcyjne (KSeF DEMO)', PROD: 'produkcyjne (prawdziwe faktury)' }
export const WZOR_FAKTUR = 'FV/{NR}/{MM}/{RRRR}'
export const WZOR_KOREKT = '%N/%M/%Y/K'

/** Ustawienia w `Organization.settings.ksef` (wszystko opcjonalne). */
export interface UstawieniaKsef {
  sprzedawca?: { nip?: string; nazwa?: string; adres?: { linia1?: string; linia2?: string; kodKraju?: string } }
  seriaKod?: string
  seriaWzor?: string
  seriaReset?: OkresResetu
  seriaKorektKod?: string
  seriaKorektWzor?: string
  seriaKorektReset?: OkresResetu
  srodowisko?: SrodowiskoFirmy
  konsumenciDoKsef?: boolean
  podstawaZwolnienia?: string
  /** ustawienie operatora (bez ekranu), patrz `KonfiguracjaKsef.dataPrzyPonowieniu`. */
  dataPrzyPonowieniu?: DataPrzyPonowieniu
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const tekst = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

export function parseKonfiguracjaKsef(settings: Prisma.JsonValue | null | undefined): KonfiguracjaKsef {
  const k = obj(obj(settings)['ksef'])
  const s = obj(k['sprzedawca'])
  const a = obj(s['adres'])
  const problemy: ProblemFa3[] = []
  // sprzedawca z profilu firmy (Ustawienia → Dane firmy); `ksef.sprzedawca` zostaje nadpisaniem (presety firm)
  const p = parseProfilFirmy(settings)
  const zKsef = !!tekst(a['linia1'])
  const nip = tekst(s['nip']) ?? p.nip
  const nazwa = tekst(s['nazwa']) ?? p.nazwa
  const linia1 = zKsef ? tekst(a['linia1']) : (p.adres?.ulica ?? null)
  const linia2 = zKsef ? tekst(a['linia2']) : p.adres ? `${p.adres.kodPocztowy} ${p.adres.miasto}` : null
  const kodKraju = (zKsef ? tekst(a['kodKraju']) : p.adres?.kodKraju) ?? 'PL'
  if (!nip) problemy.push({ kod: 'brak-nip-sprzedawcy', pole: 'settings.ksef.sprzedawca.nip', tekst: 'Brak NIP sprzedawcy: uzupełnij Ustawienia → Dokumenty i faktury → Dane firmy.' })
  else if (!poprawnyNip(nip)) problemy.push({ kod: 'nip-zly', pole: 'settings.ksef.sprzedawca.nip', tekst: 'NIP sprzedawcy w ustawieniach jest niepoprawny.' })
  if (!nazwa) problemy.push({ kod: 'brak-nazwy-sprzedawcy', pole: 'settings.ksef.sprzedawca.nazwa', tekst: 'Brak nazwy sprzedawcy: uzupełnij Ustawienia → Dokumenty i faktury → Dane firmy.' })
  if (!linia1) problemy.push({ kod: 'brak-adresu-sprzedawcy', pole: 'settings.ksef.sprzedawca.adres', tekst: 'Brak adresu sprzedawcy: uzupełnij Ustawienia → Dokumenty i faktury → Dane firmy.' })
  const seriaKod = tekst(k['seriaKod'])
  if (!seriaKod) problemy.push({ kod: 'brak-serii', pole: 'settings.ksef.seriaKod', tekst: 'Brak serii numeracji faktur: wybierz ją w Ustawienia → Dokumenty i faktury → Dokumenty sprzedaży.' })
  const reset = (v: unknown): OkresResetu => ((OKRESY_RESETU as readonly string[]).includes(v as string) ? (v as OkresResetu) : 'ROK')
  const korKod = tekst(k['seriaKorektKod'])
  const srodowisko = (SRODOWISKA_FIRMY as readonly string[]).includes(k['srodowisko'] as string) ? (k['srodowisko'] as SrodowiskoFirmy) : 'TEST'
  return {
    seria: seriaKod ? { code: seriaKod, pattern: tekst(k['seriaWzor']) ?? WZOR_FAKTUR, resetPeriod: reset(k['seriaReset']) } : null,
    seriaKorekt: korKod ? { code: korKod, pattern: tekst(k['seriaKorektWzor']) ?? WZOR_KOREKT, resetPeriod: reset(k['seriaKorektReset']) } : null,
    srodowisko,
    dataPrzyPonowieniu: k['dataPrzyPonowieniu'] === 'DZIEN_WYSYLKI' ? 'DZIEN_WYSYLKI' : 'PIERWSZA_PROBA',
    sprzedawca: nip && nazwa && linia1 ? { nip, nazwa, adres: { kodKraju, linia1, linia2 } } : null,
    seriaKod,
    konsumenciDoKsef: k['konsumenciDoKsef'] === true,
    podstawaZwolnienia: tekst(k['podstawaZwolnienia']),
    problemy,
  }
}
