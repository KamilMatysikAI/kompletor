// śledzenie paczek DPD prosto z DPD (DPDInfoServices `getEventsForWaybillV1`), sam odczyt. Base Courier podaje
// status paczek DPD z wielogodzinnym opóźnieniem (20.11.2026: paczka odebrana przez kuriera o 14:32, w Base Courier
// o 19:2x nadal tylko 030103 „przesyłka jeszcze nie nadana”), więc paczka „wisiała” w „Do wysłania”.
//
// Zasada: przesyłka przewoźnika DPD albo DPD_EMPIK z numerem listu (także utworzona modułem `basecourier.zapis.v1`) jest
// pytana w DPD, gdy firma ma konto DPD z kompletem danych: login i hasło API (sekrety konta jak przy nadawaniu), FID
// (masterFid, a bez niego payerFid; idzie jako kanał `authDataV1.channel`) i środowisko produkcyjne (usługa śledzenia nie
// ma wersji demo, dane demo by tam nie działały). Decyzja po `Shipment.carrier` i obecności konta, bez heurystyk po
// nazwach. Brak konta, pusta lista zdarzeń albo błąd DPD = dotychczasowa droga (moduł przesyłki, np. Base Courier).
//
// Które konto: najpierw konto reguły przewoźnika przesyłki (gdy jej moduł to DPD bezpośrednio), potem konto główne DPD,
// potem pozostałe konta DPD (reguły, „Dodaj konto”). `getEventsForWaybill` zwraca zdarzenia także paczek innego płatnika
// (odczyt 20.11.2026), więc każde kompletne konto DPD firmy wystarcza.
//
// Odporność w przebiegu: błąd konta (odrzucone logowanie) albo 3 błędy w przebiegu wyłączają DPD do końca przebiegu
// (nie męczymy usługi złym hasłem, przebieg nie wydłuża się o kolejne limity czasu); reszta przesyłek idzie drogą modułu.
// Błędy DPD trafiają do logu serwera i jedną linią do wyniku przebiegu (Job.lastError), bez loginu i hasła.
import type { Carrier, PrismaClient, Shipment } from '@prisma/client'
import { adresDpd, DPD_PRODUKCJA, DPD_ZAPIS_MANIFEST, stanZdarzenDpd } from '../adaptery/dpd'
import { withEnvInputs } from '../adaptery/konta'
import type { StanPrzesylki } from '../adaptery/kontrakt'
import { organizationIdOf } from '../db'
import { resolveSecrets, type SecretSource } from '../sekrety'
import { DPD_INFO_URL, DpdInfoError, DpdSledzenie, type DpdInfoLogowanie } from '../zrodla/dpd-sledzenie'
import type { FetchLike } from '../zrodla/http'
import { kluczReguly } from './adapter-przewoznika'
import { konfiguracjaZKontem, SEKRETY_KONTA_RE, sufiksKonta } from './ustawienia-konta'

/** Przewoźnicy, których paczki pytamy w DPD. */
export const PRZEWOZNICY_DPD: readonly Carrier[] = ['DPD', 'DPD_EMPIK']
/** Numer listu DPD (jak w kliencie DPDInfoServices): litery i cyfry, 6–40 znaków. */
export const NUMER_LISTU_DPD_RE = /^[A-Za-z0-9]{6,40}$/
/** Po tylu błędach DPD w jednym przebiegu reszta przesyłek idzie drogą modułu. */
export const DPD_BLEDY_DO_WYLACZENIA = 3
/** Limit czasu jednego żądania do DPD w przebiegu śledzenia (przebieg pyta do 100 przesyłek). */
export const DPD_SLEDZENIE_TIMEOUT_MS = 15_000

const FID_RE = /^\d{1,10}$/
const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const krotko = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 200)

export interface OdczytDpd {
  stan: StanPrzesylki
  status: string | null
  opis: string | null
  /** Czas ostatniego zdarzenia u DPD (bez strefy, czas polski z odpowiedzi DPD). */
  czas: string | null
}

/** Konto DPD gotowe do śledzenia: id konta (jak na ekranie kont) i dane logowania (tylko w pamięci). */
export interface KontoSledzeniaDpd {
  id: string
  logowanie: DpdInfoLogowanie
}

/**
 * Dane logowania konta DPD (sufiks null = konto główne) albo null, gdy konto niekompletne: brak loginu, hasła albo FID,
 * albo środowisko inne niż produkcyjne. `regulaConfig` = config reguły tego konta (zgodność wstecz: pola sprzed
 * w regule), nadpisany ustawieniami konta (`konfiguracjaZKontem`).
 */
async function logowanieKonta(db: PrismaClient, settings: unknown, sufiks: string | null, regulaConfig: Record<string, unknown>, src: SecretSource): Promise<DpdInfoLogowanie | null> {
  const config = konfiguracjaZKontem(settings, DPD_ZAPIS_MANIFEST.adapterKey, { ...regulaConfig, ...(sufiks ? { sekretyKonta: sufiks } : {}) })
  const nazwy = DPD_ZAPIS_MANIFEST.secrets.map((s) => s.name)
  const zBazy = await resolveSecrets(db, sufiks ? nazwy.map((n) => `${n}_${sufiks}`) : nazwy, src)
  const sekrety: Record<string, string> = {}
  for (const n of nazwy) {
    const v = zBazy[sufiks ? `${n}_${sufiks}` : n]
    if (v) sekrety[n] = v
  }
  const { rawConfig, rawSecrets } = withEnvInputs(DPD_ZAPIS_MANIFEST, config, sekrety, src)
  if (adresDpd(rawConfig).replace(/\/$/, '') !== DPD_PRODUKCJA) return null
  const login = rawSecrets['DPD_LOGIN']?.trim()
  const haslo = rawSecrets['DPD_PASSWORD']
  const fid = String(rawConfig['masterFid'] ?? rawConfig['payerFid'] ?? '').trim()
  if (!login || !haslo || !FID_RE.test(fid)) return null
  return { login, haslo, kanal: fid }
}

/**
 * Konto DPD do śledzenia dla każdego przewoźnika DPD (null = brak kompletnego konta: droga modułu przesyłki). Kolejność
 * kont: reguły tego przewoźnika z modułem DPD, konto główne, pozostałe reguły DPD, konta dodane w panelu.
 */
export async function kontaSledzeniaDpd(db: PrismaClient, src: SecretSource): Promise<Map<Carrier, KontoSledzeniaDpd | null>> {
  organizationIdOf(db)
  const [org, rules] = await Promise.all([
    db.organization.findFirst({ select: { settings: true } }),
    db.carrierRule.findMany({ orderBy: { priority: 'asc' }, select: { carrier: true, shippingModule: true, adapterKey: true, config: true } }),
  ])
  const dpdRules = rules
    .filter((r) => (kluczReguly(r) ?? '').startsWith('dpd.'))
    .map((r) => {
      const config = asObject(r.config)
      return { carrier: r.carrier, config, sufiks: sufiksKonta(config) }
    })
  const dodane = (() => {
    const lista = asObject(asObject(org?.settings)['przewoznicy'])['konta']
    return Array.isArray(lista)
      ? lista.flatMap((x) => {
          const o = asObject(x)
          return o['konto'] === 'dpd' && typeof o['sufiks'] === 'string' && SEKRETY_KONTA_RE.test(o['sufiks']) ? [o['sufiks']] : []
        })
      : []
  })()
  const cache = new Map<string, Promise<DpdInfoLogowanie | null>>()
  const konto = (sufiks: string | null): Promise<DpdInfoLogowanie | null> => {
    const id = sufiks ? `dpd~${sufiks}` : 'dpd'
    let p = cache.get(id)
    if (!p) {
      const regula = dpdRules.find((r) => r.sufiks === sufiks)
      p = logowanieKonta(db, org?.settings, sufiks, regula?.config ?? {}, src)
      cache.set(id, p)
    }
    return p
  }
  const wynik = new Map<Carrier, KontoSledzeniaDpd | null>()
  for (const carrier of PRZEWOZNICY_DPD) {
    const kolejnosc: (string | null)[] = []
    for (const s of [...dpdRules.filter((r) => r.carrier === carrier).map((r) => r.sufiks), null, ...dpdRules.map((r) => r.sufiks), ...dodane]) if (!kolejnosc.includes(s)) kolejnosc.push(s)
    let znalezione: KontoSledzeniaDpd | null = null
    for (const s of kolejnosc) {
      const l = await konto(s)
      if (l) {
        znalezione = { id: s ? `dpd~${s}` : 'dpd', logowanie: l }
        break
      }
    }
    wynik.set(carrier, znalezione)
  }
  return wynik
}

/**
 * Śledzenie DPD na jeden przebieg: konta czytane raz, klient DPD per konto, licznik błędów. `odczyt` zwraca null, gdy
 * przesyłki nie pytamy w DPD albo DPD nie dał wyniku (wtedy host idzie drogą modułu przesyłki).
 */
export class SledzenieDpdPrzebiegu {
  private konta: Map<Carrier, KontoSledzeniaDpd | null> | null = null
  private readonly klienci = new Map<string, DpdSledzenie>()
  private wylaczone = false
  private bledy = 0
  private pierwszyBlad: string | null = null
  /** Liczba odczytów z DPD zakończonych wynikiem. */
  odczyty = 0

  constructor(
    private readonly db: PrismaClient,
    private readonly src: SecretSource,
    private readonly opts: { fetch?: FetchLike; url?: string; timeoutMs?: number; retry?: { attempts: number; baseDelayMs: number } } = {},
  ) {}

  /** Przewoźnicy DPD, dla których firma ma kompletne konto (do zapytania o przesyłki). Błąd odczytu kont = żadni. */
  async przewoznicy(): Promise<Carrier[]> {
    if (!this.konta) {
      try {
        this.konta = await kontaSledzeniaDpd(this.db, this.src)
      } catch (e) {
        console.error(`[sledzenie-dpd] odczyt kont DPD nieudany: ${e instanceof Error ? krotko(e.message) : 'błąd'}`)
        this.konta = new Map()
      }
    }
    return [...this.konta].filter(([, k]) => !!k).map(([c]) => c)
  }

  /** Czy przesyłkę pytamy w DPD (przewoźnik DPD z kontem, numer listu DPD, DPD nie wyłączony w tym przebiegu). */
  async dotyczy(s: Pick<Shipment, 'carrier' | 'trackingNumber'>): Promise<boolean> {
    if (this.wylaczone || !PRZEWOZNICY_DPD.includes(s.carrier) || !s.trackingNumber || !NUMER_LISTU_DPD_RE.test(s.trackingNumber)) return false
    return (await this.przewoznicy()).includes(s.carrier)
  }

  async odczyt(s: Pick<Shipment, 'carrier' | 'trackingNumber' | 'reference'>): Promise<OdczytDpd | null> {
    if (!(await this.dotyczy(s))) return null
    const konto = this.konta!.get(s.carrier)!
    let klient = this.klienci.get(konto.id)
    if (!klient) {
      klient = new DpdSledzenie(this.opts.url ?? DPD_INFO_URL, konto.logowanie, this.opts.fetch ?? fetch, this.opts.timeoutMs ?? DPD_SLEDZENIE_TIMEOUT_MS, this.opts.retry ?? { attempts: 2, baseDelayMs: 1_000 })
      this.klienci.set(konto.id, klient)
    }
    try {
      const zdarzenia = await klient.zdarzenia(s.trackingNumber!)
      // pusta lista: DPD jeszcze nie zna paczki (albo numer nie jego); nie błąd, ale też nie stan: droga modułu
      if (!zdarzenia.length) return null
      this.odczyty++
      return stanZdarzenDpd(zdarzenia)
    } catch (e) {
      const m = e instanceof Error ? krotko(e.message) : 'błąd'
      this.bledy++
      this.pierwszyBlad ??= m
      console.error(`[sledzenie-dpd] ${s.reference}: ${m}`)
      if ((e instanceof DpdInfoError && e.zakres === 'KONTO') || this.bledy >= DPD_BLEDY_DO_WYLACZENIA) this.wylaczone = true
      return null
    }
  }

  /** Jedna linia do wyniku przebiegu, gdy DPD zawiódł (null = bez błędów). */
  podsumowanieBledow(): string | null {
    if (!this.bledy) return null
    const n = this.bledy
    const slowo = n === 1 ? 'odczyt nieudany' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'odczyty nieudane' : 'odczytów nieudanych'
    return `DPD InfoServices: ${n} ${slowo}${this.wylaczone ? ', DPD pominięty do końca przebiegu' : ''}; użyto drogi modułu przesyłki (pierwszy błąd: ${this.pierwszyBlad})`
  }
}
