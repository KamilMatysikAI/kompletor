// Zamówienie podjazdu kuriera z kolejki pakowania (zdolność shipment.pickup). JEDYNE miejsce poza adapterami, które woła
// `zamowOdbior` (strażnik w lib/adaptery/dpd-kurier.test.ts).
//
// Bramki (każda z powodem dla ekranu):
//   1. reguła przewoźnika z modułem, który ma `shipment.pickup`, i z „Zamawianie kuriera z Kompletora” = tak w koncie;
//      bez tego przycisku nie ma wcale (system zachowuje się jak przed tą funkcją);
//   2. zapis włączony w koncie przewoźnika (`zapisWlaczony`);
//   3. tryb PRACA: przynajmniej jedno aktywne konto sprzedaży w trybie pracy na instancji, która pracę dopuszcza.
//
// Idempotencja: wiersz CourierPickupOrder (TWORZENIE) powstaje PRZED żądaniem, pod blokadą przewoźnika, modułu, konta i
// dnia. Jeden aktywny (TWORZENIE, ZAMOWIONY, NIEJEDNOZNACZNY) wiersz na dzień: drugie kliknięcie (także równoległe)
// dostaje istniejący i nie woła przewoźnika. Drugie zamówienie tego dnia tylko świadomie (`drugi: true`, osobne
// potwierdzenie na ekranie). Odmowa (BLAD) nic nie zamówiła: kolejne kliknięcie używa tego samego wiersza.
// NIEJEDNOZNACZNY = nie wiadomo, czy przewoźnik przyjął zlecenie: alert i bez ponawiania; człowiek sprawdza w panelu albo
// telefonicznie i w razie potrzeby zamawia drugi raz świadomie. Wiersz TWORZENIE bez zmiany dłużej niż 5 minut (żądanie
// trwa najwyżej 60 s, więc proces padł między rezerwacją a zapisem wyniku, np. restart przy wdrożeniu) też przechodzi w
// NIEJEDNOZNACZNY z alertem: przy odczycie stanu dla ekranu i na początku zamówienia.
// Moduły po przesyłkach (Wysyłam z Allegro) mają inną regułę: blokada konta bez dnia, wiersz na każdą grupę odbioru
// (kilka aktywnych wierszy jednego dnia) i ochrona przed dublem po przesyłkach, opisana przy `zamowPoPrzesylkach`.
//
// Włącznik „Zamawianie kuriera z Kompletora” i pozostałe pola konta: konfiguracja reguły z nałożonymi ustawieniami konta
// przewoźnika (karta konta, ./ustawienia-konta; wpis konta wygrywa, także fałsz i wyczyszczone pole). `zapisWlaczony`
// jest polem ukrytym i zostaje z reguły.
import type { Carrier, CourierPickupOrder, PrismaClient } from '@prisma/client'
import { appModeOf } from '@/lib/organizacje'
import { defaultRegistry } from '../adaptery/domyslne'
import { AdapterError, hasPickupAvailability, hasPickupGrouping, hasPickupOrderer, type ChannelAdapter, type DostepnoscOdbioru, type GrupaOdbioru, type OdbiorPrzyjety, type PaczkaOdbioru, type PrzedzialDostepnosci, type WynikOdbioru } from '../adaptery/kontrakt'
import { AdapterConfigError, deriveReference, type AdapterRegistry } from '../adaptery/rejestr'
import { organizationIdOf } from '../db'
import { firmaPrzechodziZBlWPanelu } from '../kanaly/firma'
import { trybPracyInstancji } from '../praca/wlacznik'
import { addDays, fromWarsaw, isBusinessDay, toWarsaw } from '../rdzen/kalendarz'
import { advisoryLock, alert, runTx, type Tx } from '../rdzen/stan'
import type { Env, SecretSource } from '../sekrety'
import type { FetchLike } from '../zrodla/http'
import { adapterPrzewoznika, kluczReguly, kontoReguly, nadawcaFirmy, type RegulaNadania } from './adapter-przewoznika'
import { KOD_OSOBNE_ODBIORY } from '../adaptery/allegro-wysylam-zapis'
import { createWysylamAdapter, WYSYLAM_KEY_RE } from './allegro-konto'
import { STATUSY_NADANIA } from './nadanie'
import { podjazdFirmy, propozycjaPodjazduFirmy } from './podjazd'
import { konfiguracjaZKontem } from './ustawienia-konta'
import { dzienPoLudzku, hm, nazwaGrupyOdbioru, powodPoLudzku, przesylekSlowo, ROZSTRZYGNIETE_RECZNIE, UWAGA_BEZ_LISTY, type DostepnoscOkna, type PrzedzialOdbioru, type ZlecenieKuriera } from './kurier-widok'
import { AUTOMAT_ID, AUTOMAT_NAZWA, czyOdmowaGodzin, ocenAutomatu, paczkiCzekajace, regulaPrzedzialu, type DecyzjaAutomatu, type OdbiorWczesniejszy, type PaczkaAutomatu, type PaczkiCzekajace, type ProbaDnia, type RegulaPrzedzialu } from './kurier-regula'

export { opisZlecenia, type ZlecenieKuriera } from './kurier-widok'

type Db = PrismaClient

export interface DepsKuriera {
  registry?: AdapterRegistry
  secrets?: SecretSource
  fetch?: FetchLike
  now?: () => Date
  env?: Env
  /** Odpytywanie komend przewoźnika (Wysyłam z Allegro; testy: bez czekania). */
  http?: { pollDelayMs?: number; minIntervalMs?: number }
}

export const ALERT_KURIERA = 'KURIER_NIEJEDNOZNACZNY'
const AKTYWNE = ['TWORZENIE', 'ZAMOWIONY', 'NIEJEDNOZNACZNY'] as const
/** Po tylu minutach bez zmiany wiersz TWORZENIE uznajemy za przerwany (żądanie do przewoźnika trwa najwyżej 60 s). */
export const TWORZENIE_PRZERWANE_MIN = 5
const envDeps = (d: DepsKuriera): Env => d.env ?? d.secrets?.env ?? process.env
const zrodloSekretow = (d: DepsKuriera): SecretSource => d.secrets ?? { env: envDeps(d), envFallback: appModeOf(envDeps(d)) === 'self-host' }
const teraz = (d: DepsKuriera) => (d.now ?? (() => new Date()))()
const krotko = (m: string) => m.replace(/\s+/g, ' ').slice(0, 1000)
/**
 * Klucz blokady zamówienia kuriera: ten sam w przycisku, automacie i rozstrzygnięciu; z firmą, żeby firmy nie czekały na
 * siebie. Moduły po przesyłkach (`pickupPerShipment`) blokują bez dnia (`*`): zamówienie dotyczy przesyłek, nie dnia, więc
 * dwa dni naraz to te same przesyłki.
 */
export const kluczBlokadyKuriera = (organizationId: string, carrier: Carrier, adapterKey: string, konto: string, dzien: string, poPrzesylkach: boolean) =>
  `kurier:${organizationId}:${carrier}:${adapterKey}:${konto}:${poPrzesylkach ? '*' : dzien}`

/**
 * Moduły po przesyłkach: przewoźnik może wymagać osobnych odbiorów (grupy z `grupyOdbioru`), więc każda grupa ma własne
 * zlecenie z `accountKey` = konto sprzedaży + `#odbior:` + klucz grupy (unikalność dnia i próby osobno na grupę, bez
 * zmiany schematu). Wiersz z samym kontem = zlecenie bez podziału (sprzed podziału albo moduł bez `grupyOdbioru`).
 */
const ZNAK_GRUPY = '#odbior:'
export const kluczKontaOdbioru = (konto: string, grupa: string) => (grupa ? `${konto}${ZNAK_GRUPY}${grupa}` : konto)
export const kontoZKlucza = (accountKey: string) => accountKey.split(ZNAK_GRUPY)[0] ?? accountKey
const wierszeKonta = (konto: string) => [{ accountKey: konto }, { accountKey: { startsWith: `${konto}${ZNAK_GRUPY}` } }]

/** `failureKind` wiersza rozstrzygniętego ręcznie („DPD przyjął” / „DPD nie przyjął”), bez nowej kolumny. */
export const RECZNIE = 'RECZNE'
export const ROZSTRZYGNIECIE_KURIERA_AUDIT = 'KURIER_ROZSTRZYGNIECIE'

export interface StanKuriera {
  carrier: Carrier
  modul: string
  /** null = wolno zamówić; inaczej powód dla ekranu (przycisk zostaje widoczny, wyłączony). */
  powod: string | null
  /** Propozycja z harmonogramu odbiorów firmy (Ustawienia → Wysyłka i druk → Przewoźnicy); null = brak harmonogramu. */
  propozycja: { data: string; odMin: number; doMin: number } | null
  /** Dziś jeszcze może przyjechać kurier (dzień odbioru, bez „Przyjechał” na dziś); false = okno nie podpowiada dziś. */
  dzisOdbior: boolean
  /** Paczki z numerem nadania tego modułu i konta, które czekają na kuriera. */
  paczki: { liczba: number; wagaKg: number }
  /** Zlecenia od dziś (dzień rosnąco, w dniu najnowsza próba pierwsza); linie paska składa lib/wysylka/kurier-widok.ts. */
  zlecenia: ZlecenieKuriera[]
  /** Reguła przedziałów przewoźnika (domyślne godziny w oknie, te same co w automacie). */
  regula: RegulaPrzedzialu
  /** „Zamawiaj kuriera automatycznie”: null = wyłączone; `opis` = co automat zrobi albo dlaczego nie (bez sieci). */
  automat: { opis: string | null } | null
  /**
   * Moduł zamawia odbiór konkretnych przesyłek (manifest `pickupPerShipment`, Wysyłam z Allegro): okno bez liczby i wagi,
   * `paczki.liczba` = przesyłki z numerem nadania, które nie są jeszcze w zamówionym odbiorze.
   */
  poPrzesylkach: boolean
}

/** Pole konta przewoźnika „Zamawiaj kuriera automatycznie” (tylko moduły ze zdolnością `shipment.pickup`). */
export const POLE_AUTOMATU = 'zamawianieKurieraAutomat'
const dzienKrotko = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`

const naEkran = (z: CourierPickupOrder): ZlecenieKuriera => ({
  id: z.id,
  stan: z.state,
  dzien: z.pickupDay,
  odMin: z.fromMinute,
  doMin: z.toMinute,
  numer: z.externalRef,
  powod: z.lastError,
  proba: z.attempt,
  paczki: z.parcels,
  wagaKg: Number(z.weightKg),
  kto: z.requestedName,
  recznie: z.failureKind === RECZNIE,
  automat: z.requestedBy === AUTOMAT_ID,
  ...(z.accountKey.includes(ZNAK_GRUPY) ? { grupa: z.accountKey.slice(z.accountKey.indexOf(ZNAK_GRUPY) + ZNAK_GRUPY.length), klik: z.createdAt.getTime() } : {}),
})

interface RegulaKuriera {
  regula: RegulaNadania & { adapterKey: string }
  konto: string
  modul: string
  /** Manifest `pickupPerShipment`: odbiór konkretnych przesyłek na koncie sprzedaży zamówień (Wysyłam z Allegro). */
  poPrzesylkach: boolean
}

/**
 * Reguły z włączonym zamawianiem kuriera, po przewoźniku (pierwsza wg priorytetu). Tylko odczyt, bez sieci. Reguła modułu
 * po przesyłkach (Wysyłam z Allegro: włącznik na koncie Allegro obejmuje wszystkie jego reguły) ustępuje regule
 * zwykłego modułu tego przewoźnika, żeby włącznik Allegro nie przejął kuriera zamawianego bezpośrednio u przewoźnika.
 */
async function regulyKuriera(db: Db, registry: AdapterRegistry, carrier?: Carrier): Promise<Map<Carrier, RegulaKuriera>> {
  const [rules, org] = await Promise.all([
    db.carrierRule.findMany({ where: carrier ? { carrier } : {}, orderBy: { priority: 'asc' }, select: { id: true, carrier: true, shippingModule: true, adapterKey: true, config: true } }),
    db.organization.findUnique({ where: { id: organizationIdOf(db) }, select: { settings: true } }),
  ])
  const out = new Map<Carrier, RegulaKuriera>()
  for (const r of rules) {
    const wczesniejsza = out.get(r.carrier)
    if (wczesniejsza && !wczesniejsza.poPrzesylkach) continue
    const key = kluczReguly({ adapterKey: r.adapterKey, shippingModule: r.shippingModule })
    const config = konfiguracjaZKontem(org?.settings, key, r.config && typeof r.config === 'object' && !Array.isArray(r.config) ? (r.config as Record<string, unknown>) : {})
    if (config['zamawianieKuriera'] !== true) continue
    const def = key ? registry.get(key) : undefined
    if (!key || !def || !def.manifest.capabilities.includes('shipment.pickup') || def.manifest.readOnly) continue
    if (wczesniejsza && def.manifest.pickupPerShipment === true) continue
    if (def.manifest.pickupCarriers && !def.manifest.pickupCarriers.includes(r.carrier)) continue
    const regula = { id: r.id, carrier: r.carrier, shippingModule: r.shippingModule, adapterKey: key, config }
    out.set(r.carrier, { regula, konto: kontoReguly(regula) ?? '', modul: def.manifest.displayName, poPrzesylkach: def.manifest.pickupPerShipment === true })
  }
  return out
}

/**
 * Wiersze TWORZENIE bez zmiany dłużej niż `TWORZENIE_PRZERWANE_MIN` → NIEJEDNOZNACZNY z alertem (raz: zmiana warunkowa
 * na stanie i czasie, alert w tej samej transakcji tylko przy udanej zmianie). Świeże zostają „w toku”.
 */
async function oznaczPrzerwane(db: Db, now: Date, carrier?: Carrier): Promise<void> {
  const granica = new Date(now.getTime() - TWORZENIE_PRZERWANE_MIN * 60_000)
  const gdzie = { state: 'TWORZENIE', updatedAt: { lt: granica }, ...(carrier ? { carrier } : {}) }
  const stare = await db.courierPickupOrder.findMany({ where: gdzie, select: { id: true, carrier: true, pickupDay: true, reference: true } })
  for (const w of stare) {
    await runTx(db, async (tx) => {
      const u = await tx.courierPickupOrder.updateMany({
        where: { id: w.id, state: 'TWORZENIE', updatedAt: { lt: granica } },
        data: { state: 'NIEJEDNOZNACZNY', lastError: `zamawianie przerwane w trakcie (ponad ${TWORZENIE_PRZERWANE_MIN} minut bez wyniku); nie wiadomo, czy kurier jest zamówiony`, failureKind: 'NIEJEDNOZNACZNY' },
      })
      if (u.count)
        await alert(
          tx,
          ALERT_KURIERA,
          w.id,
          `Zamawianie kuriera ${w.carrier} na ${w.pickupDay} (referencja ${w.reference}) przerwało się w trakcie: nie wiadomo, czy przewoźnik przyjął zlecenie. Sprawdź w panelu przewoźnika albo telefonicznie; drugie zamówienie tylko świadomie.`,
          `kurier:${w.id}`,
        )
    })
  }
}

/** Tryb pracy: aktywne konto sprzedaży w PRACA na instancji, która ją dopuszcza. null = wolno. */
async function bramkaPracy(db: Db, deps: DepsKuriera): Promise<string | null> {
  const konto = await db.channelConfig.findFirst({ where: { statusMode: 'PRACA', active: true }, select: { channel: true } })
  if (!konto) return 'Żadne konto sprzedaży nie jest w trybie pracy: przesyłki i kuriera zamawia dziś BaseLinker.'
  try {
    if (!trybPracyInstancji(envDeps(deps), await firmaPrzechodziZBlWPanelu(db, envDeps(deps)))) return 'Na tym serwerze Kompletora praca nie jest jeszcze włączona: zamawianie kuriera ruszy, gdy administrator ją włączy.'
  } catch {
    return 'Zła wartość EKRANY_PRACA na tej instancji: zamawianie kuriera wyłączone.'
  }
  return null
}

/** Paczki z numerem nadania (przesyłka utworzona tym modułem i kontem), których zamówienie jeszcze nie wyjechało. */
async function paczkiDoOdbioru(db: Db, r: RegulaKuriera): Promise<PaczkaOdbioru[]> {
  const s = await db.shipment.findMany({
    where: { state: 'UTWORZONA', carrier: r.regula.carrier, adapterKey: r.regula.adapterKey, accountSuffix: r.konto || null, order: { status: { in: [...STATUSY_NADANIA] } } },
    select: { weightKg: true },
    take: 2000,
  })
  return s.map((x) => ({ wagaKg: x.weightKg ? Number(x.weightKg) : 0 }))
}

interface PrzesylkiOdbioru {
  /** Numery przesyłek (`Shipment.externalRef`) i ich łączna waga. */
  przesylki: string[]
  wagaKg: number
  /** Konto sprzedaży (channelAccountId) przesyłek; null = brak przesyłek. */
  konto: string | null
  /** Przesyłki czekają na kilku kontach sprzedaży (tokeny per konto): opis kont do odmowy. */
  kilkaKont: string | null
  /** Odbiory u przewoźnika (`checkSum` i liczba przesyłek zleceń ZAMOWIONY od dziś) tego konta: ich przesyłki są już w odbiorze. */
  wOdbiorze: OdbiorPrzyjety[]
  /** Waga przesyłki po numerze (kg; 0 = nieznana). */
  wagi: Map<string, number>
  /** Chwila utworzenia przesyłki po numerze (ms, zegar bazy). */
  utworzone: Map<string, number>
}

/**
 * Moduły z `pickupPerShipment`: przesyłki z numerem nadania czekające na kuriera. Które są już w odbiorze zamówionym od
 * dziś: dokładnie przewoźnik (`wOdbiorze`, przesyłki odbioru czyta adapter); zlecenie ZAMOWIONY bez identyfikatoru
 * odbioru (rozstrzygnięte ręcznie) obejmuje przesyłki utworzone przed nim (granica czasu, jak przed podziałem). Na ekran
 * (`naEkran`, bez sieci) granica czasu także z kliknięcia, w którym wszystkie odbiory przyjęto (zlecenia jednego
 * kliknięcia mają ten sam createdAt = chwila odczytu listy); kliknięcie z odmową części grup nie zmniejsza liczby.
 * Jedno zamówienie = jedno konto sprzedaży.
 */
async function przesylkiDoOdbioru(db: Db, r: RegulaKuriera, dzis: string, odczyt?: Date, naEkranie = false): Promise<PrzesylkiOdbioru> {
  const [s, zamowione] = await Promise.all([
    db.shipment.findMany({
      // `odczyt`: chwila listy zapisywana jako createdAt zlecenia (granica „już w odbiorze” także po ponownym użyciu wiersza)
      where: { state: 'UTWORZONA', carrier: r.regula.carrier, adapterKey: r.regula.adapterKey, accountSuffix: r.konto || null, externalRef: { not: null }, order: { status: { in: [...STATUSY_NADANIA] } }, ...(odczyt ? { createdAt: { lte: odczyt } } : {}) },
      select: { externalRef: true, weightKg: true, createdAt: true, order: { select: { channelAccountId: true } } },
      orderBy: { createdAt: 'asc' },
      take: 2000,
    }),
    db.courierPickupOrder.findMany({ where: { carrier: r.regula.carrier, adapterKey: r.regula.adapterKey, pickupDay: { gte: dzis } }, select: { accountKey: true, createdAt: true, checkSum: true, state: true, parcels: true } }),
  ])
  const granica = new Map<string, number>()
  const wOdbiorze = new Map<string, Map<string, number>>()
  for (const z of zamowione) {
    if (z.state !== 'ZAMOWIONY') continue
    const k = kontoZKlucza(z.accountKey)
    if (z.checkSum) {
      const m = wOdbiorze.get(k) ?? new Map<string, number>()
      wOdbiorze.set(k, m.set(z.checkSum, Math.max(m.get(z.checkSum) ?? 0, z.parcels)))
    }
    const calyKlik = !zamowione.some((x) => x.state !== 'ZAMOWIONY' && kontoZKlucza(x.accountKey) === k && x.createdAt.getTime() === z.createdAt.getTime())
    if (!z.checkSum || (naEkranie && calyKlik)) granica.set(k, Math.max(granica.get(k) ?? 0, z.createdAt.getTime()))
  }
  const wagi = new Map<string, number>()
  const utworzone = new Map<string, number>()
  const poKoncie = new Map<string, { przesylki: string[]; wagaKg: number }>()
  const wszystkieKonta = new Set<string>()
  for (const x of s) {
    const konto = x.order.channelAccountId
    wszystkieKonta.add(konto)
    if (!x.externalRef || x.createdAt.getTime() <= (granica.get(konto) ?? 0)) continue
    const g = poKoncie.get(konto) ?? { przesylki: [], wagaKg: 0 }
    if (g.przesylki.includes(x.externalRef)) continue
    g.przesylki.push(x.externalRef)
    g.wagaKg += x.weightKg ? Number(x.weightKg) : 0
    wagi.set(x.externalRef, x.weightKg ? Number(x.weightKg) : 0)
    utworzone.set(x.externalRef, x.createdAt.getTime())
    poKoncie.set(konto, g)
  }
  const odbioryKonta = (k: string | null): OdbiorPrzyjety[] => (k ? [...(wOdbiorze.get(k) ?? new Map<string, number>())].map(([id, przesylek]) => ({ id, przesylek })) : [])
  if (poKoncie.size > 1) return { przesylki: [], wagaKg: 0, konto: null, kilkaKont: [...poKoncie.entries()].map(([k, g]) => `${k}: ${g.przesylki.length}`).join(', '), wOdbiorze: [], wagi, utworzone }
  const [wpis] = [...poKoncie.entries()]
  // wszystko już w odbiorze: konto zostaje (kliknięcie po zamówieniu dostaje istniejące zlecenie tego konta)
  if (!wpis) {
    const konto = wszystkieKonta.size === 1 ? [...wszystkieKonta][0]! : null
    return { przesylki: [], wagaKg: 0, konto, kilkaKont: null, wOdbiorze: odbioryKonta(konto), wagi, utworzone }
  }
  return { przesylki: wpis[1].przesylki, wagaKg: Math.round(wpis[1].wagaKg * 1000) / 1000, konto: wpis[0], kilkaKont: null, wOdbiorze: odbioryKonta(wpis[0]), wagi, utworzone }
}

export const POWOD_BEZ_PRZESYLEK = 'Brak przesyłek z numerem nadania czekających na kuriera (albo wszystkie są już w zamówionym odbiorze).'
const powodKilkuKont = (opis: string) =>
  `Przesyłki czekają na kuriera na kilku kontach Allegro (${opis}): Kompletor zamawia odbiór dla jednego konta naraz, a tu konta nie wybierzesz. Zamów odbiór w Allegro.`

/** Adapter do zamówienia odbioru: Wysyłam z Allegro na koncie sprzedaży przesyłek (tokeny konta), reszta z reguły. */
async function adapterOdbioru(db: Db, r: RegulaKuriera, konto: string | null, registry: AdapterRegistry, deps: DepsKuriera): Promise<ChannelAdapter> {
  if (!WYSYLAM_KEY_RE.test(r.regula.adapterKey)) return adapterPrzewoznika(db, r.regula, registry, zrodloSekretow(deps), { fetch: deps.fetch, now: deps.now })
  if (!konto) throw new AdapterConfigError('brak konta Allegro przesyłek')
  const org = await db.organization.findUnique({ where: { id: organizationIdOf(db) }, select: { settings: true } })
  const c = r.regula.config
  const config: Record<string, unknown> = { zapisWlaczony: c['zapisWlaczony'] === true, zamawianieKuriera: c['zamawianieKuriera'] === true }
  const przewoznik = c['przewoznikOdbioru']
  if (typeof przewoznik === 'string' && przewoznik.trim()) config['przewoznikOdbioru'] = przewoznik.trim()
  const nadawca = nadawcaFirmy(org?.settings)
  if (nadawca) config['nadawca'] = JSON.stringify(nadawca)
  return createWysylamAdapter(db, registry, konto, zrodloSekretow(deps), { fetch: deps.fetch, now: deps.now, adapterKey: r.regula.adapterKey, config, ...(deps.http ? { http: deps.http } : {}) })
}

/**
 * Stan zamawiania kuriera dla kolejki pakowania: tylko przewoźnicy z włączonym „Zamawianie kuriera z Kompletora”
 * (pusta mapa = ekran bez zmian). Tylko odczyt, bez sieci.
 */
export async function stanZamawianiaKuriera(db: Db, deps: DepsKuriera = {}): Promise<Map<Carrier, StanKuriera>> {
  organizationIdOf(db)
  const registry = deps.registry ?? defaultRegistry()
  const reguly = await regulyKuriera(db, registry)
  const out = new Map<Carrier, StanKuriera>()
  if (!reguly.size) return out
  const now = teraz(deps)
  const dzis = toWarsaw(now).day
  await oznaczPrzerwane(db, now)
  const praca = await bramkaPracy(db, deps)
  for (const [carrier, r] of reguly) {
    const [{ propozycja: prop, dzisOdbior }, paczkiZRegul, zlecenia, wp] = await Promise.all([
      podjazdFirmy(db, carrier, now),
      r.poPrzesylkach ? Promise.resolve([]) : paczkiDoOdbioru(db, r),
      // po przesyłkach konto sprzedaży jest w accountKey: pasek pokazuje zlecenia wszystkich kont
      db.courierPickupOrder.findMany({ where: { carrier, adapterKey: r.regula.adapterKey, accountKey: r.poPrzesylkach ? undefined : r.konto, pickupDay: { gte: dzis } }, orderBy: [{ pickupDay: 'asc' }, { attempt: 'desc' }], take: 40 }),
      r.poPrzesylkach ? przesylkiDoOdbioru(db, r, dzis, undefined, true) : Promise.resolve(null),
    ])
    const paczki: PaczkaOdbioru[] = wp ? wp.przesylki.map(() => ({ wagaKg: 0 })) : paczkiZRegul
    const powod = r.regula.config['zapisWlaczony'] !== true ? `Nadawanie przez „${r.modul}” jest wyłączone w ustawieniach przewoźnika: bez niego Kompletor nie zamawia kuriera.` : (praca ?? (wp?.kilkaKont ? powodKilkuKont(wp.kilkaKont) : null))
    let automat: StanKuriera['automat'] = null
    // automat tylko dla modułów zamawiających podjazd na dzień; po przesyłkach (pickupPerShipment) zawsze przycisk
    if (!r.poPrzesylkach && r.regula.config[POLE_AUTOMATU] === true) {
      try {
        automat = { opis: powod ? `Automat nie zamawia: ${powod.charAt(0).toLowerCase()}${powod.slice(1)}` : opisDecyzji(await ocenRegule(db, carrier, r, now, null)) }
      } catch {
        automat = { opis: null }
      }
    }
    out.set(carrier, {
      regula: regulaPrzedzialu(r.regula.adapterKey),
      automat,
      carrier,
      modul: r.modul,
      powod,
      propozycja: prop && prop.dni[0] ? { data: prop.dni[0], odMin: prop.odMin, doMin: prop.doMin } : null,
      dzisOdbior,
      paczki: { liczba: paczki.length, wagaKg: Math.round((wp ? wp.wagaKg : paczki.reduce((s, p) => s + p.wagaKg, 0)) * 100) / 100 },
      zlecenia: zlecenia.map(naEkran),
      poPrzesylkach: r.poPrzesylkach,
    })
  }
  return out
}

export interface ZamowienieKuriera {
  carrier: Carrier
  /** RRRR-MM-DD (Warszawa). */
  data: string
  odMin: number
  doMin: number
  /** Liczba paczek i łączna waga z okna (domyślnie z paczek czekających na kuriera); moduły po przesyłkach ich nie biorą. */
  liczba: number
  wagaKg: number
  /** Świadome drugie zamówienie tego dnia (osobne potwierdzenie na ekranie). */
  drugi?: boolean
  userId: string
  userName: string
}

export type WynikKuriera =
  | { wynik: 'ZAMOWIONY'; zlecenie: ZlecenieKuriera; istnialo: boolean }
  | { wynik: 'W_TOKU' | 'NIEJEDNOZNACZNY'; zlecenie: ZlecenieKuriera; istnialo: boolean }
  | { wynik: 'BLAD'; zlecenie: ZlecenieKuriera; powod: string }
  /** tego dnia jest zlecenie rozstrzygnięte ręcznie jako „nie przyjął”: bez `drugi` nic nie wysyłamy. */
  | { wynik: 'POTWIERDZ_DRUGI'; zlecenie: ZlecenieKuriera; powod: string }
  | { wynik: 'ODMOWA'; powod: string }
  /** Moduł po przesyłkach, przewoźnik wymaga osobnych odbiorów: wynik każdego odbioru osobno (najmniej dwa). */
  | { wynik: 'ODBIORY'; odbiory: OdbiorKlikniecia[] }

/** Wynik jednego odbioru z kilku (bez zagnieżdżenia). */
export type WynikOdbioruGrupy = Exclude<WynikKuriera, { wynik: 'ODBIORY' }>
/** Wynik jednego odbioru z kliknięcia z osobnymi odbiorami; `grupa` = klucz grupy u przewoźnika (nazwa: `nazwaGrupyOdbioru`). */
export interface OdbiorKlikniecia {
  opis: string
  grupa: string
  przesylek: number
  wynik: WynikOdbioruGrupy
}

/** Braki w danych z okna (bez sieci). Pusta lista = można wysłać. */
export function sprawdzOkno(z: Pick<ZamowienieKuriera, 'data' | 'odMin' | 'doMin' | 'liczba' | 'wagaKg'>, dzis: string, bezPaczek = false): string[] {
  const b: string[] = []
  if (!/^\d{4}-\d{2}-\d{2}$/.test(z.data) || Number.isNaN(Date.parse(`${z.data}T00:00:00Z`))) b.push('data odbioru (RRRR-MM-DD)')
  else if (z.data < dzis) b.push('data odbioru nie może być w przeszłości')
  if (!(Number.isInteger(z.odMin) && Number.isInteger(z.doMin) && z.odMin >= 0 && z.doMin <= 1439 && z.odMin < z.doMin)) b.push('godziny odbioru (od wcześniej niż do)')
  if (bezPaczek) return b
  if (!(Number.isInteger(z.liczba) && z.liczba >= 1 && z.liczba <= 500)) b.push('liczba paczek (1–500)')
  if (!(Number.isFinite(z.wagaKg) && z.wagaKg > 0 && z.wagaKg <= 15_000)) b.push('waga łączna w kg (większa od zera)')
  return b
}

/** Paczki do żądania: liczba i łączna waga z okna, równo na paczkę (przewoźnik dostaje sumę i największą wagę). */
function paczkiZOkna(liczba: number, wagaKg: number): PaczkaOdbioru[] {
  const jedna = Math.max(0.01, Math.round((wagaKg / liczba) * 100) / 100)
  return Array.from({ length: liczba }, () => ({ wagaKg: jedna }))
}

/**
 * „Zamów kuriera”: bramki → rezerwacja wiersza pod blokadą (istniejący aktywny = zwrot bez żądania) → jedno żądanie do
 * przewoźnika → zapis wyniku z warunkiem na stan TWORZENIE.
 */
export async function zamowKuriera(db: Db, z: ZamowienieKuriera, deps: DepsKuriera = {}): Promise<WynikKuriera> {
  const organizationId = organizationIdOf(db)
  const registry = deps.registry ?? defaultRegistry()
  const r = (await regulyKuriera(db, registry, z.carrier)).get(z.carrier)
  if (!r) return { wynik: 'ODMOWA', powod: 'Zamawianie kuriera z Kompletora jest wyłączone dla tego przewoźnika (Ustawienia → Wysyłka i druk → Przewoźnicy, konto przewoźnika, „Zaawansowane”).' }
  const now = teraz(deps)
  await oznaczPrzerwane(db, now, z.carrier)
  if (r.regula.config['zapisWlaczony'] !== true) return { wynik: 'ODMOWA', powod: `Nadawanie przez „${r.modul}” jest wyłączone w ustawieniach przewoźnika: bez niego Kompletor nie zamawia kuriera.` }
  const praca = await bramkaPracy(db, deps)
  if (praca) return { wynik: 'ODMOWA', powod: praca }
  const braki = sprawdzOkno(z, toWarsaw(now).day, r.poPrzesylkach)
  if (braki.length) return { wynik: 'ODMOWA', powod: `Popraw w oknie: ${braki.join(', ')}.` }
  if (r.poPrzesylkach) return zamowPoPrzesylkach(db, z, r, registry, deps, organizationId, now)
  const liczba = z.liczba
  const wagaKg = z.wagaKg

  const klucz = { carrier: z.carrier, adapterKey: r.regula.adapterKey, accountKey: r.konto ?? '', pickupDay: z.data }
  const rez = await runTx(db, async (tx) => {
    await advisoryLock(tx, kluczBlokadyKuriera(organizationId, z.carrier, r.regula.adapterKey, klucz.accountKey, z.data, false))
    const wszystkie = await tx.courierPickupOrder.findMany({ where: klucz, orderBy: { attempt: 'desc' } })
    const aktywny = wszystkie.find((w) => (AKTYWNE as readonly string[]).includes(w.state))
    if (aktywny && !z.drugi) return { istnial: aktywny }
    // „nie przyjął” zaznaczone ręcznie to nie pewność: żądanie nie niesie referencji, więc gdyby przewoźnik jednak przyjął
    // pierwsze zlecenie, kolejne byłoby drugim (płatnym) podjazdem. Jak przy aktywnym: tylko z jawnym `drugi`.
    const reczny = wszystkie.find((w) => w.state === 'BLAD' && w.failureKind === RECZNIE)
    if (reczny && !z.drugi) return { potwierdz: reczny }
    const dane = { state: 'TWORZENIE', fromMinute: z.odMin, toMinute: z.doMin, parcels: liczba, weightKg: wagaKg, requestedBy: z.userId, requestedName: z.userName, lastError: null, failureKind: null, externalRef: null, checkSum: null }
    // odmowa przewoźnika (BLAD) niczego nie zamówiła: ten sam wiersz i ta sama referencja; wiersz rozstrzygnięty ręcznie
    // zostaje (ślad niepewności na ten dzień), a następna próba dostaje nowy wiersz jak drugie zamówienie; odmowa
    // automatu też zostaje (licznik prób automatu na dzień liczy jego wiersze)
    const ostatni = wszystkie[0]
    if (ostatni && ostatni.state === 'BLAD' && ostatni.failureKind !== RECZNIE && ostatni.requestedBy !== AUTOMAT_ID) return { nowy: await tx.courierPickupOrder.update({ where: { id: ostatni.id }, data: dane }) }
    const attempt = (ostatni?.attempt ?? 0) + 1
    const reference = deriveReference([organizationId, 'kurier', z.carrier, r.regula.adapterKey, klucz.accountKey, z.data, attempt])
    return { nowy: await tx.courierPickupOrder.create({ data: { ...klucz, attempt, reference, ...dane } }) }
  })
  if ('istnial' in rez && rez.istnial) return wynikIstniejacego(rez.istnial)
  if ('potwierdz' in rez && rez.potwierdz) return { wynik: 'POTWIERDZ_DRUGI', zlecenie: naEkran(rez.potwierdz), powod: POWOD_DRUGI }
  return wyslijZamowienie(db, r, (rez as { nowy: CourierPickupOrder }).nowy, z, registry, deps, null)
}

const POWOD_DRUGI = 'Jeśli przewoźnik jednak przyjął to zlecenie, kolejne zamówienie na ten dzień oznacza drugi, płatny podjazd: potwierdź przyciskiem „Zamów drugi raz”.'
/** Limit czasu podziału przesyłek na odbiory (odczyt odbiorów, przesyłek po 5 i terminów). */
export const LIMIT_PODZIALU_MS = 50_000
/** Limit ścienny wysyłania komend kolejnych odbiorów jednego kliknięcia (od rezerwacji): dalsze grupy = pewna odmowa. */
export const LIMIT_ODBIOROW_MS = 3 * 60_000
/** Co ile odświeżać `updatedAt` wierszy grup czekających na swoją komendę (poniżej progu przerwanego zamawiania). */
const ODSWIEZANIE_ODBIOROW_MS = 60_000
/** Odmowa, gdy na liście do zamówienia jest więcej przesyłek z przyjętego odbioru, niż dostało odmowę (odczyt odbioru niepewny). */
export const POWOD_STARE_PRZESYLKI = 'na liście do zamówienia są przesyłki, które mogą już być w przyjętym odbiorze, a Kompletor nie potrafi tego potwierdzić: nic nie zamówiono. Sprawdź odbiory w Allegro i zgłoś to administratorowi.'
export const POWOD_NIE_WYSLANO = 'Kompletor nie wysłał tego zamówienia odbioru, bo poprzednie odbiory długo czekały na przewoźnika: nic nie zamówiono, zamów ponownie.'

type DecyzjaGrupy = { g: GrupaOdbioru; nowy: CourierPickupOrder }

/** Pewna odmowa (BLAD), którą wolno ponowić tym samym wierszem: nie ręczna i nie z automatu (automat liczy swoje próby). */
const ponawialna = (w: CourierPickupOrder) => w.state === 'BLAD' && w.failureKind !== RECZNIE && w.requestedBy !== AUTOMAT_ID
/** Przewoźnicy transportu z klucza wiersza (`konto#odbior:ORLEN.p2` → `ORLEN`); '' = wiersz bez grupy. */
const transportWiersza = (accountKey: string) => (accountKey.includes(ZNAK_GRUPY) ? (accountKey.slice(accountKey.indexOf(ZNAK_GRUPY) + ZNAK_GRUPY.length).split('.')[0] ?? '') : '')

/**
 * (drobne 4): odmowy dnia, które może przejąć grupa bez własnych wierszy (podział zależy od listy, więc ta sama
 * przesyłka dostaje przy ponowieniu inny klucz, np. `ORLEN.p3` → `ORLEN`). Tylko najnowszy wiersz swojego klucza, z grupą,
 * od `od` (chwila przyjętego kliknięcia) i o kluczu, którego nie bierze żadna grupa tego kliknięcia. Przejęcie zamiast
 * nowego wiersza: ta sama przesyłka nie ma dwóch odmów na pasku i nie liczy się podwójnie w „Ponów” ani w kontroli hosta.
 */
function odmowyDoPrzejecia(dnia: readonly CourierPickupOrder[], klucze: ReadonlySet<string>, od: number): Map<string, CourierPickupOrder> {
  const wolne = new Map<string, CourierPickupOrder>()
  const najnowszy = new Map<string, CourierPickupOrder>()
  for (const w of dnia) if ((najnowszy.get(w.accountKey)?.attempt ?? -1) < w.attempt) najnowszy.set(w.accountKey, w)
  for (const w of najnowszy.values()) if (ponawialna(w) && transportWiersza(w.accountKey) && !klucze.has(w.accountKey) && w.createdAt.getTime() >= od) wolne.set(w.id, w)
  return wolne
}

/**
 * Rezerwacja wiersza TWORZENIE dla grupy (pod blokadą konta). Pewna odmowa tej samej grupy = ten sam wiersz i referencja
 * (kolejny commandId u przewoźnika); grupa, której najnowszy wiersz nie jest taką odmową, przejmuje odmowę o tym samym
 * transporcie z `wolne` (wiersz zostaje pod swoim kluczem, klucz grupy bywa inny przy każdym kliknięciu); inaczej nowy
 * wiersz z kolejnym numerem próby. `chwila` = createdAt wiersza (granica listy przesyłek kliknięcia).
 */
async function rezerwujGrupe(
  tx: Tx,
  o: { g: GrupaOdbioru; konto: string; dnia: readonly CourierPickupOrder[]; wolne: Map<string, CourierPickupOrder>; zajete: Set<string>; chwila: Date; z: ZamowienieKuriera; wp: PrzesylkiOdbioru; gdzie: { carrier: Carrier; adapterKey: string }; organizationId: string; adapterKey: string },
): Promise<CourierPickupOrder> {
  const w = await rezerwujWiersz(tx, o)
  o.zajete.add(w.id)
  return w
}

/**
 * r2 W-A: `dnia` to odczyt sprzed rezerwacji tej transakcji, więc wiersz zarezerwowany już dla wcześniejszej
 * grupy (`zajete`, np. odmowa pod kluczem `T.p2` przejęta przez część 1) nie jest ponawiany drugi raz pod swoim kluczem:
 * grupa dostaje nowy wiersz (numer próby z pełnej listy swoich wierszy).
 */
async function rezerwujWiersz(
  tx: Tx,
  o: { g: GrupaOdbioru; konto: string; dnia: readonly CourierPickupOrder[]; wolne: Map<string, CourierPickupOrder>; zajete: ReadonlySet<string>; chwila: Date; z: ZamowienieKuriera; wp: PrzesylkiOdbioru; gdzie: { carrier: Carrier; adapterKey: string }; organizationId: string; adapterKey: string },
): Promise<CourierPickupOrder> {
  const { g, z } = o
  const ak = kluczKontaOdbioru(o.konto, g.klucz)
  const swoje = o.dnia.filter((w) => w.accountKey === ak).sort((a, b) => b.attempt - a.attempt)
  const wagaKg = Math.round(g.przesylki.reduce((s, id) => s + (o.wp.wagi.get(id) ?? 0), 0) * 1000) / 1000
  const dane = { state: 'TWORZENIE', fromMinute: z.odMin, toMinute: z.doMin, parcels: g.przesylki.length, weightKg: wagaKg, requestedBy: z.userId, requestedName: z.userName, lastError: null, failureKind: null, externalRef: null, checkSum: null, createdAt: o.chwila }
  const ostatni = swoje[0]
  if (ostatni && ponawialna(ostatni) && !o.zajete.has(ostatni.id)) {
    o.wolne.delete(ostatni.id)
    return tx.courierPickupOrder.update({ where: { id: ostatni.id }, data: dane })
  }
  const attempt = Math.max(0, ...swoje.map((w) => w.attempt)) + 1
  const t = transportWiersza(ak)
  const przejmij = [...o.wolne.values()].find((w) => transportWiersza(w.accountKey) === t && !o.zajete.has(w.id))
  if (przejmij) {
    o.wolne.delete(przejmij.id)
    // wiersz zostaje pod swoim kluczem (ten sam przewoźnik transportu, ta sama nazwa na pasku): bez kolizji numeru próby
    // i bez dopisania odmowy pod klucz z przyjętym odbiorem, gdzie linia paska pokazałaby przyjęty odbiór
    return tx.courierPickupOrder.update({ where: { id: przejmij.id }, data: dane })
  }
  const reference = deriveReference([o.organizationId, 'kurier', z.carrier, o.adapterKey, ak, z.data, attempt])
  return tx.courierPickupOrder.create({ data: { ...o.gdzie, accountKey: ak, pickupDay: z.data, attempt, reference, ...dane } })
}

/**
 * „Zamów kuriera” modułu po przesyłkach (Wysyłam z Allegro). Kolejno: lista przesyłek konta z bazy (chwila odczytu =
 * createdAt nowych zleceń) → podział na odbiory u przewoźnika (sam odczyt; bez `grupyOdbioru` jedna grupa; przesyłki
 * odbiorów już przyjętych wypadają z listy po odczycie odbioru u przewoźnika) → pod blokadą konta bez dnia rezerwacja
 * zlecenia na każdą grupę → osobne żądanie i zapis wyniku dla każdego zlecenia (wyjątek jednej grupy nie zatrzymuje
 * innych). Klucz grupy bywa inny przy kolejnym kliknięciu (podział zależy od listy), więc ochrona przed dublem działa na
 * całym koncie, nie na grupie:
 *   - odbiór przyjęty, którego nasz podział nie znał (createdAt po naszym odczycie listy, identyfikator odbioru spoza
 *     `wOdbiorze` albo bez identyfikatoru i zmieniony po odczycie) = lista nieaktualna, zwrot istniejącego;
 *   - zlecenie w toku albo niewiadoma na koncie na dowolny dzień od dziś = zwrot istniejącego, także przy `drugi` (nie
 *     wiadomo, które przesyłki są w odbiorze);
 *   - ręczne „nie przyjął” na ten dzień = potwierdzenie jak drugie zamówienie;
 *   - odbiór przyjęty na ten dzień: bez `drugi` tylko przesyłki, które były na liście tamtego kliknięcia (ich grupa
 *     dostała pewną odmowę: ponowienie bez potwierdzenia), nowsze czekają na świadome „Zamów drugi raz”;
 *   - pewna odmowa (BLAD) tej samej grupy na ten dzień = ten sam wiersz i referencja (kolejny commandId u przewoźnika).
 */
async function zamowPoPrzesylkach(db: Db, z: ZamowienieKuriera, r: RegulaKuriera, registry: AdapterRegistry, deps: DepsKuriera, organizationId: string, now: Date): Promise<WynikKuriera> {
  // zegar bazy (createdAt przesyłek), nie zegar z zależności: granica listy przesyłek tego zamówienia
  const odczyt = new Date()
  const dzis = toWarsaw(now).day
  const wp = await przesylkiDoOdbioru(db, r, dzis, odczyt)
  if (wp.kilkaKont) return { wynik: 'ODMOWA', powod: powodKilkuKont(wp.kilkaKont) }
  const konto = wp.konto ?? ''
  const gdzie = { carrier: z.carrier, adapterKey: r.regula.adapterKey }
  // nic do zamówienia: kliknięcie po zamówieniu dostaje istniejące zlecenie dnia, „drugi” bez nowych przesyłek = odmowa
  const nicDoZamowienia = async (powod = POWOD_BEZ_PRZESYLEK): Promise<WynikKuriera> => {
    const w = konto && !z.drugi ? await db.courierPickupOrder.findFirst({ where: { ...gdzie, OR: wierszeKonta(konto), pickupDay: z.data, state: { in: [...AKTYWNE] } }, orderBy: { updatedAt: 'desc' } }) : null
    return w ? wynikIstniejacego(w) : { wynik: 'ODMOWA', powod }
  }
  if (!wp.przesylki.length) return nicDoZamowienia()
  // zlecenie w toku albo niewiadoma: zwrot bez sieci (pod blokadą sprawdzane jeszcze raz)
  const otwarte0 = await db.courierPickupOrder.findFirst({ where: { ...gdzie, OR: wierszeKonta(konto), pickupDay: { gte: dzis }, state: { in: ['TWORZENIE', 'NIEJEDNOZNACZNY'] } }, orderBy: { updatedAt: 'desc' } })
  if (otwarte0) return wynikIstniejacego(otwarte0)

  let grupy: GrupaOdbioru[]
  try {
    const adapter = await adapterOdbioru(db, r, konto, registry, deps)
    if (hasPickupGrouping(adapter)) {
      const g = await zLimitem(adapter.grupyOdbioru({ przesylki: wp.przesylki, wOdbiorze: wp.wOdbiorze, timeoutMs: LIMIT_DOSTEPNOSCI_MS }), LIMIT_PODZIALU_MS)
      if (g.powod) return nicDoZamowienia(`${r.modul}: ${g.powod}; nic nie zamówiono.`)
      grupy = g.grupy
    } else grupy = [{ klucz: '', opis: 'odbiór', przesylki: wp.przesylki, dni: [] }]
  } catch (e) {
    const m = e instanceof AdapterError || e instanceof AdapterConfigError ? e.message : 'nie udało się sprawdzić przesyłek u przewoźnika (albo przewoźnik długo odpowiada)'
    return { wynik: 'ODMOWA', powod: `${r.modul}: ${m}${m.includes('nic nie zamówiono') ? '.' : '; nic nie zamówiono.'}` }
  }
  if (!grupy.length) return nicDoZamowienia()

  const rez = await runTx(db, async (tx): Promise<{ istnial: CourierPickupOrder } | { potwierdz: CourierPickupOrder } | { brak: true } | { stare: true } | { decyzje: DecyzjaGrupy[] }> => {
    // blokada konta bez dnia: zamówienie dotyczy przesyłek, nie dnia; wszystkie grupy konta pod tą samą blokadą
    await advisoryLock(tx, kluczBlokadyKuriera(organizationId, z.carrier, r.regula.adapterKey, konto, z.data, true))
    const wiersze = await tx.courierPickupOrder.findMany({ where: { ...gdzie, OR: wierszeKonta(konto), pickupDay: { gte: dzis } }, orderBy: [{ attempt: 'desc' }, { updatedAt: 'desc' }] })
    // lista nieaktualna: odbiór przyjęty, którego nasz podział nie znał (zamówiony przez równoległe kliknięcie, które
    // odczytało listę przed nami albo tuż po nas; createdAt to chwila jego odczytu listy, nie chwila przyjęcia)
    const znane = new Set(wp.wOdbiorze.map((o) => o.id))
    const nowsze = wiersze.find((w) => w.state === 'ZAMOWIONY' && (w.createdAt > odczyt || (w.checkSum ? !znane.has(w.checkSum) : w.updatedAt > odczyt)))
    if (nowsze) return { istnial: nowsze }
    const otwarte = wiersze.find((w) => w.state === 'TWORZENIE' || w.state === 'NIEJEDNOZNACZNY')
    if (otwarte) return { istnial: otwarte }
    const dnia = wiersze.filter((w) => w.pickupDay === z.data)
    const reczny = dnia.find((w) => w.state === 'BLAD' && w.failureKind === RECZNIE)
    if (reczny && !z.drugi) return { potwierdz: reczny }
    const przyjete = dnia.filter((w) => w.state === 'ZAMOWIONY')
    let doZamowienia = grupy
    const granica = przyjete.length ? Math.max(...przyjete.map((w) => w.createdAt.getTime())) : 0
    const tylko = (warunek: (t: number) => boolean) => grupy.map((g) => ({ ...g, przesylki: g.przesylki.filter((id) => warunek(wp.utworzone.get(id) ?? Infinity)) })).filter((g) => g.przesylki.length)
    if (przyjete.length && !z.drugi) {
      // bez „drugi”: tylko przesyłki z listy ostatniego kliknięcia z przyjętym odbiorem (ich grupa dostała odmowę)
      doZamowienia = tylko((t) => t <= granica)
      if (!doZamowienia.length) return { istnial: [...przyjete].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0]! }
    } else if (przyjete.length && !dnia.some((w) => w.state === 'BLAD' && w.failureKind !== RECZNIE && w.createdAt.getTime() >= granica)) {
      // „drugi” bez odmowy grupy w ostatnim kliknięciu: tylko przesyłki utworzone po nim (przesyłki z jego listy są w
      // przyjętych odbiorach), niezależnie od tego, co przewoźnik zwrócił o odbiorach
      doZamowienia = tylko((t) => t > granica)
    }
    if (!doZamowienia.length) return { brak: true as const }
    if (przyjete.length) {
      // przesyłki z listy przyjętego kliknięcia wolno zamówić tylko w liczbie, która dostała od tamtej pory pewną odmowę:
      // nadwyżka znaczy, że odczyt odbioru u przewoźnika nie zdjął z listy przyjętych przesyłek (inne identyfikatory)
      const stare = doZamowienia.reduce((s, g) => s + g.przesylki.filter((id) => (wp.utworzone.get(id) ?? Infinity) <= granica).length, 0)
      const odrzucone = dnia.filter((w) => w.state === 'BLAD' && w.failureKind !== RECZNIE && w.createdAt.getTime() >= granica).reduce((s, w) => s + w.parcels, 0)
      if (stare > odrzucone) return { stare: true as const }
    }
    // ponowienie (bez „drugi”, przy przyjętym odbiorze dnia) obejmuje listę kliknięcia z granicy, więc jego
    // wiersze dostają chwilę tamtego kliknięcia: udane ponowienie nie przesuwa granicy dnia, a przesyłki nadane między
    // odmową a ponowieniem dalej czekają na „Zamów drugi raz” (licznik na pasku i host liczą je jako nowe)
    const chwila = przyjete.length && !z.drugi ? new Date(granica) : odczyt
    const klucze = new Set(doZamowienia.map((g) => kluczKontaOdbioru(konto, g.klucz)))
    const wolne = odmowyDoPrzejecia(dnia, klucze, przyjete.length ? granica : 0)
    const decyzje: DecyzjaGrupy[] = []
    const zajete = new Set<string>()
    for (const g of doZamowienia) decyzje.push({ g, nowy: await rezerwujGrupe(tx, { g, konto, dnia, wolne, zajete, chwila, z, wp, gdzie, organizationId, adapterKey: r.regula.adapterKey }) })
    return { decyzje }
  })
  if ('istnial' in rez) return wynikIstniejacego(rez.istnial)
  if ('potwierdz' in rez) return { wynik: 'POTWIERDZ_DRUGI', zlecenie: naEkran(rez.potwierdz), powod: POWOD_DRUGI }
  if ('brak' in rez) return { wynik: 'ODMOWA', powod: POWOD_BEZ_PRZESYLEK }
  if ('stare' in rez) return { wynik: 'ODMOWA', powod: `${r.modul}: ${POWOD_STARE_PRZESYLKI}` }

  const odbiory: OdbiorKlikniecia[] = []
  const start = teraz(deps).getTime()
  // wiersze grup czekających na swoją kolej: świeże `updatedAt`, żeby oznaczPrzerwane nie uznało ich za przerwane,
  // zanim wyjdzie ich komenda (jedna grupa potrafi trwać dłużej niż próg)
  const czekajace = new Set(rez.decyzje.map((d) => d.nowy.id))
  // wszystkie wiersze tego kliknięcia (także części po podziale): kontrola równoległego zamówienia przed podziałem je pomija
  const klikniecie = new Set(czekajace)
  const odswiez = setInterval(() => {
    if (czekajace.size) db.courierPickupOrder.updateMany({ where: { id: { in: [...czekajace] }, state: 'TWORZENIE' }, data: { updatedAt: new Date() } }).catch((e: unknown) => console.error(`[kurier-odbiory] odświeżenie: ${e instanceof Error ? krotko(e.message).slice(0, 200) : 'błąd'}`))
  }, ODSWIEZANIE_ODBIOROW_MS)
  odswiez.unref?.()
  const wyslij = async (d: DecyzjaGrupy): Promise<WynikOdbioruGrupy> => {
    try {
      if (teraz(deps).getTime() - start > LIMIT_ODBIOROW_MS) {
        // limit całego kliknięcia: komenda tej grupy nie wyszła, więc odmowa jest pewna (ten sam wiersz przy ponowieniu)
        czekajace.delete(d.nowy.id)
        return await zapiszWynik(db, d.nowy, { kind: 'TRWALY', reference: d.nowy.reference, message: POWOD_NIE_WYSLANO })
      }
      // komenda tylko dla wiersza, który dalej czeka w TWORZENIE (nikt go nie rozstrzygnął ani nie uznał za przerwany)
      // wiersz zostaje w odświeżaniu do końca komendy: długa komenda nie może zostać uznana za przerwaną
      const u = await db.courierPickupOrder.updateMany({ where: { id: d.nowy.id, state: 'TWORZENIE' }, data: { updatedAt: new Date() } })
      try {
        return u.count ? await wyslijZamowienie(db, r, d.nowy, z, registry, deps, { ...wp, przesylki: d.g.przesylki }) : wynikIstniejacego(await db.courierPickupOrder.findUniqueOrThrow({ where: { id: d.nowy.id } }))
      } finally {
        czekajace.delete(d.nowy.id)
      }
    } catch (e) {
      // błąd zapisu po żądaniu: wiersz zostaje „w toku” i po kilku minutach przechodzi w niewiadomą z alertem
      console.error(`[kurier-odbiory] ${z.carrier}: ${e instanceof Error ? krotko(e.message).slice(0, 300) : 'błąd'}`)
      return { wynik: 'W_TOKU', zlecenie: naEkran(d.nowy), istnialo: false }
    }
  }
  try {
    for (const d of rez.decyzje) {
      const wynik = await wyslij(d)
      // przewoźnik odrzucił połączony odbiór kodem „osobne odbiory” = drugi krok w tym samym kliknięciu:
      // podział tej grupy najdrobniej (Allegro: po elementach propozycji, jak) i osobne zamówienia;
      // inna odmowa niczego nie dzieli
      const podzial = wynik.wynik === 'BLAD' && d.g.przesylki.length > 1 && (wynik.zlecenie.powod ?? '').includes(KOD_OSOBNE_ODBIORY) ? await podzielOdrzucona(db, r, d, konto, z, wp, registry, deps, organizationId, klikniecie) : []
      if (!podzial.length) {
        odbiory.push({ opis: d.g.opis, grupa: d.g.klucz, przesylek: d.g.przesylki.length, wynik })
        continue
      }
      for (const p of podzial) {
        czekajace.add(p.nowy.id)
        klikniecie.add(p.nowy.id)
      }
      for (const p of podzial) odbiory.push({ opis: p.g.opis, grupa: p.g.klucz, przesylek: p.g.przesylki.length, wynik: await wyslij(p) })
    }
  } finally {
    clearInterval(odswiez)
  }
  return odbiory.length === 1 ? odbiory[0]!.wynik : { wynik: 'ODBIORY', odbiory }
}

/**
 * grupa odrzucona kodem „osobne odbiory” (REQUIRES_SEPARATE_PICKUPS) dzielona najdrobniej (`drobniej`) i
 * rezerwowana pod tą samą blokadą konta: pierwsza część przejmuje wiersz odmowy, reszta dostaje nowe wiersze z chwilą
 * tego samego kliknięcia. Pusta lista = bez podziału (przewoźnik nie umie drobniej, odczyt nie wyszedł, wiersz zmieniony
 * w międzyczasie); odmowa zostaje wtedy jak była. Sam odczyt u przewoźnika, nic nie zamawia.
 */
async function podzielOdrzucona(db: Db, r: RegulaKuriera, d: DecyzjaGrupy, konto: string, z: ZamowienieKuriera, wp: PrzesylkiOdbioru, registry: AdapterRegistry, deps: DepsKuriera, organizationId: string, klikniecie: ReadonlySet<string>): Promise<DecyzjaGrupy[]> {
  let czesci: GrupaOdbioru[]
  try {
    const adapter = await adapterOdbioru(db, r, konto, registry, deps)
    if (!hasPickupGrouping(adapter)) return []
    const g = await zLimitem(adapter.grupyOdbioru({ przesylki: d.g.przesylki, wOdbiorze: [], timeoutMs: LIMIT_DOSTEPNOSCI_MS, drobniej: true }), LIMIT_PODZIALU_MS)
    czesci = g.grupy
  } catch (e) {
    console.error(`[kurier-odbiory] podział po odmowie: ${e instanceof Error ? krotko(e.message).slice(0, 200) : 'błąd'}`)
    return []
  }
  // podział musi obejmować dokładnie przesyłki odrzuconej grupy, w więcej niż jednej części
  const wszystkie = czesci.flatMap((c) => c.przesylki)
  if (czesci.length < 2 || wszystkie.length !== d.g.przesylki.length || wszystkie.some((id) => !d.g.przesylki.includes(id))) return []
  const gdzie = { carrier: z.carrier, adapterKey: r.regula.adapterKey }
  try {
    return await runTx(db, async (tx) => {
      await advisoryLock(tx, kluczBlokadyKuriera(organizationId, z.carrier, r.regula.adapterKey, konto, z.data, true))
      const odmowa = await tx.courierPickupOrder.findUnique({ where: { id: d.nowy.id } })
      if (!odmowa || !ponawialna(odmowa)) return []
      // r2 drobne 1: ta sama kontrola co przy zamówieniu, poza wierszami tego kliknięcia: odbiór przyjęty po naszej odmowie
      // albo zlecenie w toku/niewiadoma na koncie = ktoś zamawia równolegle, bez podziału (inaczej podwójny podjazd)
      const konta = await tx.courierPickupOrder.findMany({ where: { ...gdzie, OR: wierszeKonta(konto), pickupDay: { gte: toWarsaw(teraz(deps)).day } } })
      const obce = konta.filter((w) => !klikniecie.has(w.id))
      if (obce.some((w) => (w.state === 'ZAMOWIONY' && w.updatedAt > odmowa.updatedAt) || w.state === 'TWORZENIE' || w.state === 'NIEJEDNOZNACZNY')) return []
      const dnia = konta.filter((w) => w.pickupDay === z.data)
      const wolne = new Map([[odmowa.id, odmowa]])
      const zajete = new Set<string>()
      const out: DecyzjaGrupy[] = []
      for (const [i, c] of czesci.entries()) {
        const g = { ...c, opis: `${d.g.opis}, część ${i + 1} z ${czesci.length}` }
        out.push({ g, nowy: await rezerwujGrupe(tx, { g, konto, dnia, wolne, zajete, chwila: odmowa.createdAt, z, wp, gdzie, organizationId, adapterKey: r.regula.adapterKey }) })
      }
      return out
    })
  } catch (e) {
    // r2 drobne 2: błąd transakcji = nic nie zarezerwowano ani nie wysłano; odmowa zostaje, pozostałe grupy idą dalej
    console.error(`[kurier-odbiory] podział po odmowie (zapis): ${e instanceof Error ? krotko(e.message).slice(0, 200) : 'błąd'}`)
    return []
  }
}

/** Jedno żądanie do przewoźnika dla zarezerwowanego wiersza TWORZENIE i zapis wyniku (ręcznie i z automatu). */
async function wyslijZamowienie(db: Db, r: RegulaKuriera, w: CourierPickupOrder, z: Pick<ZamowienieKuriera, 'data' | 'odMin' | 'doMin' | 'liczba' | 'wagaKg'>, registry: AdapterRegistry, deps: DepsKuriera, wp: PrzesylkiOdbioru | null): Promise<WynikOdbioruGrupy> {
  // po przesyłkach: konto sprzedaży przesyłek i ich numery (lista z chwili rezerwacji), inaczej konto reguły
  const konto = wp ? wp.konto : r.konto
  let adapter: ChannelAdapter
  try {
    adapter = await adapterOdbioru(db, r, konto, registry, deps)
  } catch (e) {
    const m = e instanceof AdapterConfigError ? e.message : 'nie udało się przygotować połączenia z przewoźnikiem'
    return zapiszWynik(db, w, { kind: 'TRWALY', reference: w.reference, message: `Konfiguracja przewoźnika: ${m}` })
  }
  if (!hasPickupOrderer(adapter)) return zapiszWynik(db, w, { kind: 'TRWALY', reference: w.reference, message: 'Moduł przewoźnika nie zamawia kuriera.' })
  let out: WynikOdbioru
  try {
    // liczba i waga bez zmian w oknie = rzeczywiste wagi paczek (największa paczka dla przewoźnika); inaczej równo z okna
    const czekajace = wp ? [] : await paczkiDoOdbioru(db, r)
    const sumaCzekajacych = czekajace.reduce((s, p) => s + p.wagaKg, 0)
    const paczki = wp ? wp.przesylki.map(() => ({ wagaKg: 0 })) : czekajace.length === z.liczba && czekajace.every((p) => p.wagaKg > 0) && Math.abs(sumaCzekajacych - z.wagaKg) < 0.01 ? czekajace : paczkiZOkna(z.liczba, z.wagaKg)
    out = await adapter.zamowOdbior({ data: z.data, odMin: z.odMin, doMin: z.doMin, paczki, ...(wp ? { przesylki: wp.przesylki } : {}) }, w.reference)
  } catch (e) {
    // wyjątek modułu: odmowa trwała przed żądaniem albo stan nieznany (nie wiadomo, czy żądanie wyszło)
    out = e instanceof AdapterError && e.kind === 'TRWALY' ? { kind: 'TRWALY', reference: w.reference, message: e.message } : { kind: 'NIEJEDNOZNACZNY', reference: w.reference, message: 'błąd modułu przewoźnika w trakcie zamawiania; nie wiadomo, czy kurier jest zamówiony' }
  }
  return zapiszWynik(db, w, out)
}

// ─── Rozstrzygnięcie ręczne niewiadomej ──────────────────────────

export interface RozstrzygniecieKuriera {
  id: string
  /** PRZYJAL = przewoźnik ma zlecenie (ZAMOWIONY, opcjonalny numer); NIE_PRZYJAL = nic nie zamówiono (BLAD). */
  wariant: 'PRZYJAL' | 'NIE_PRZYJAL'
  numer?: string | null
  userId: string
  userName: string
}

export type WynikRozstrzygnieciaKuriera = { wynik: 'ZAPISANE' | 'JUZ_ROZSTRZYGNIETE'; zlecenie: ZlecenieKuriera } | { wynik: 'ODMOWA'; komunikat: string }

const kiedy = (now: Date) => {
  const w = toWarsaw(now)
  return `${w.day} ${hm(Math.floor(w.msOfDay / 60_000))}`
}

/**
 * „DPD przyjął zlecenie” / „DPD nie przyjął” przy zleceniu NIEJEDNOZNACZNYM (osoba z uprawnieniem do zamawiania
 * kuriera, po sprawdzeniu w panelu przewoźnika albo telefonicznie). Wzór: „Rozstrzygnij ręcznie” przesyłek
 * (lib/wysylka/nadanie.ts). Pod blokadą dnia (jak zamówienie), zmiana warunkowa na stanie NIEJEDNOZNACZNY, w jednej
 * transakcji: stan, `failureKind = RECZNE`, ślad „Rozstrzygnięte ręcznie” (kto, kiedy, wcześniejszy powód) w
 * `lastError`, wpis AuditLog i zamknięcie alertu. Powtórzenie tym samym wariantem = „już rozstrzygnięte” bez zmian.
 * NIE_PRZYJAL: następne „Zamów kuriera” tego dnia wymaga potwierdzenia jak drugie zamówienie (`drugi`) i dostaje nowy
 * wiersz (ręczne „nie przyjął” to nie pewność, a żądanie do przewoźnika nie niesie referencji).
 */
export async function rozstrzygnijKuriera(db: Db, r: RozstrzygniecieKuriera, deps: DepsKuriera = {}): Promise<WynikRozstrzygnieciaKuriera> {
  const organizationId = organizationIdOf(db)
  if (r.wariant !== 'PRZYJAL' && r.wariant !== 'NIE_PRZYJAL') return { wynik: 'ODMOWA', komunikat: 'Nieznany wybór.' }
  const numer = r.wariant === 'PRZYJAL' ? String(r.numer ?? '').replace(/\s+/g, '') : ''
  if (numer && !/^[0-9A-Za-z/-]{1,40}$/.test(numer)) return { wynik: 'ODMOWA', komunikat: 'Numer zlecenia może mieć tylko litery, cyfry, „-” i „/” (do 40 znaków). Możesz go też zostawić pusty.' }
  const now = teraz(deps)
  const w0 = await db.courierPickupOrder.findUnique({ where: { id: r.id } })
  if (!w0) return { wynik: 'ODMOWA', komunikat: 'Nie ma takiego zamówienia kuriera: odśwież stronę.' }
  await oznaczPrzerwane(db, now, w0.carrier)
  const poPrzesylkach = (deps.registry ?? defaultRegistry()).get(w0.adapterKey)?.manifest.pickupPerShipment === true
  const cel = r.wariant === 'PRZYJAL' ? 'ZAMOWIONY' : 'BLAD'
  const wynik = await runTx(db, async (tx) => {
    await advisoryLock(tx, kluczBlokadyKuriera(organizationId, w0.carrier, w0.adapterKey, poPrzesylkach ? kontoZKlucza(w0.accountKey) : w0.accountKey, w0.pickupDay, poPrzesylkach))
    const w = await tx.courierPickupOrder.findUniqueOrThrow({ where: { id: r.id } })
    if (w.state === cel && w.failureKind === RECZNIE) return { juz: w }
    if (w.state !== 'NIEJEDNOZNACZNY') return { zmienione: w }
    const kto = `${r.userName || 'osoba bez nazwy'}, ${kiedy(now)}`
    const slad =
      r.wariant === 'PRZYJAL'
        ? `${ROZSTRZYGNIETE_RECZNIE}: przewoźnik przyjął zlecenie (zaznaczył: ${kto}).`
        : `${ROZSTRZYGNIETE_RECZNIE}: przewoźnik nie przyjął zlecenia (zaznaczył: ${kto}).${w.lastError ? ` Wcześniej: ${w.lastError}` : ''}`
    const u = await tx.courierPickupOrder.updateMany({
      where: { id: w.id, state: 'NIEJEDNOZNACZNY' },
      data: { state: cel, failureKind: RECZNIE, lastError: krotko(slad), ...(r.wariant === 'PRZYJAL' ? { externalRef: numer || w.externalRef || null } : {}) },
    })
    if (!u.count) return { zmienione: w }
    await tx.auditLog.create({
      data: {
        entity: ROZSTRZYGNIECIE_KURIERA_AUDIT,
        entityId: w.id,
        actorId: `user:${r.userId}`,
        before: { stan: w.state, numer: w.externalRef },
        after: { wariant: r.wariant, stan: cel, numer: numer || null, przewoznik: w.carrier, dzien: w.pickupDay, proba: w.attempt },
      },
    })
    await tx.alert.updateMany({ where: { dedupeKey: `kurier:${w.id}`, closedAt: null }, data: { closedAt: now } })
    return { zapisane: await tx.courierPickupOrder.findUniqueOrThrow({ where: { id: w.id } }) }
  })
  if ('juz' in wynik && wynik.juz) return { wynik: 'JUZ_ROZSTRZYGNIETE', zlecenie: naEkran(wynik.juz) }
  if ('zapisane' in wynik && wynik.zapisane) return { wynik: 'ZAPISANE', zlecenie: naEkran(wynik.zapisane) }
  return { wynik: 'ODMOWA', komunikat: 'Stan tego zamówienia zmienił się w międzyczasie (ktoś je już rozstrzygnął albo zamówił ponownie): odśwież stronę.' }
}

// ─── Wolne przedziały podjazdu ───────────────────────────────────

/** Limit czasu odczytu dostępności dla okna „Zamów kuriera”: po nim okno wraca do dwóch pól godzin. */
export const LIMIT_DOSTEPNOSCI_MS = 8_000

const zLimitem = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((ok, blad) => {
    const t = setTimeout(() => blad(new Error('limit czasu odczytu dostępności')), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        ok(v)
      },
      (e: unknown) => {
        clearTimeout(t)
        blad(e)
      },
    )
  })

/**
 * Wolne przedziały podjazdu dla okna „Zamów kuriera”: odczyt u przewoźnika (zdolność `dostepnoscOdbioru`, nic nie
 * zamawia) z limitem `LIMIT_DOSTEPNOSCI_MS`. Moduł bez tej zdolności = dwa pola godzin bez dopisku; błąd, limit czasu
 * albo nieznany format = dwa pola z dopiskiem `UWAGA_BEZ_LISTY` (błąd w logu serwera). Przedziały bez dni: obowiązują w każdy dzień odbioru.
 */
export async function przedzialyKuriera(db: Db, carrier: Carrier, deps: DepsKuriera = {}): Promise<DostepnoscOkna> {
  organizationIdOf(db)
  const registry = deps.registry ?? defaultRegistry()
  const r = (await regulyKuriera(db, registry, carrier)).get(carrier)
  if (!r) return { tryb: 'POLA', uwaga: null }
  const dzis = toWarsaw(teraz(deps)).day
  try {
    const wp = r.poPrzesylkach ? await przesylkiDoOdbioru(db, r, dzis) : null
    if (wp && (!wp.konto || !wp.przesylki.length)) return { tryb: 'POLA', uwaga: null }
    if (wp) {
      const adapter = await adapterOdbioru(db, r, wp.konto, registry, deps)
      if (hasPickupGrouping(adapter)) {
        const g = await zLimitem(adapter.grupyOdbioru({ przesylki: wp.przesylki, wOdbiorze: wp.wOdbiorze, timeoutMs: LIMIT_DOSTEPNOSCI_MS }), 2 * LIMIT_DOSTEPNOSCI_MS)
        if (g.powod) return { tryb: 'POLA', uwaga: `${r.modul}: ${g.powod}.` }
        if (g.grupy.length <= 1) return { tryb: 'LISTA', ...dostepnoscNaDaty({ stan: 'OK', dni: g.grupy[0]?.dni ?? [] }, dzis) }
        return { tryb: 'POLA', uwaga: opisOdbiorow(g.grupy, wp.przesylki.length) }
      }
    }
    const w = await odczytDostepnosci(db, r, registry, deps, wp)
    if (!w) return { tryb: 'POLA', uwaga: null }
    return { tryb: 'LISTA', ...dostepnoscNaDaty(w, dzis) }
  } catch (e) {
    console.error(`[kurier-dostepnosc] ${carrier}: ${e instanceof Error ? krotko(e.message).slice(0, 300) : 'błąd'}`)
    return { tryb: 'POLA', uwaga: UWAGA_BEZ_LISTY }
  }
}


/**
 * Dopisek okna, gdy przewoźnik wymaga kilku odbiorów (jedno zdanie zamiast terminów każdego odbioru):
 * ile odbiorów, przewoźnik i liczba przesyłek każdego, ile przesyłek z listy zostaje poza zamówieniem.
 */
const pozaZamowieniem = (n: number) =>
  n === 1
    ? 'Jedna przesyłka z listy ma innego przewoźnika albo jest już w zamówionym odbiorze.'
    : przesylekSlowo(n) === 'przesyłki'
      ? `Pozostałe ${n} przesyłki z listy mają innego przewoźnika albo są już w zamówionym odbiorze.`
      : `Pozostałych ${n} przesyłek z listy ma innego przewoźnika albo jest już w zamówionym odbiorze.`

export function opisOdbiorow(grupy: readonly GrupaOdbioru[], naLiscie: number): string {
  const czesci = grupy.map((g) => `${nazwaGrupyOdbioru(g.klucz) ?? 'przewoźnik bez nazwy'} (${g.przesylki.length})`)
  const objete = grupy.reduce((s, g) => s + g.przesylki.length, 0)
  const poza = naLiscie - objete
  return `Przewoźnicy odbiorą te przesyłki w ${grupy.length} osobnych odbiorach: ${czesci.join(', ')}. Każdy dostanie najbliższy termin przewoźnika, który pokrywa się z Twoimi godzinami.${poza > 0 ? ` ${pozaZamowieniem(poza)}` : ''}`
}

function wynikIstniejacego(w: CourierPickupOrder): WynikOdbioruGrupy {
  const zlecenie = naEkran(w)
  if (w.state === 'ZAMOWIONY') return { wynik: 'ZAMOWIONY', zlecenie, istnialo: true }
  if (w.state === 'NIEJEDNOZNACZNY') return { wynik: 'NIEJEDNOZNACZNY', zlecenie, istnialo: true }
  if (w.state === 'TWORZENIE') return { wynik: 'W_TOKU', zlecenie, istnialo: true }
  return { wynik: 'BLAD', zlecenie, powod: w.lastError ?? 'Przewoźnik nie przyjął zamówienia.' }
}

async function zapiszWynik(db: Db, w: CourierPickupOrder, out: WynikOdbioru): Promise<WynikOdbioruGrupy> {
  if (out.kind === 'OK') {
    // przewoźnik po przesyłkach: faktyczne okno odbioru i liczba przesyłek, które objęło zamówienie
    const faktyczne = { ...(out.okno ? { fromMinute: out.okno.odMin, toMinute: out.okno.doMin } : {}), ...(out.przesylek ? { parcels: out.przesylek } : {}) }
    await db.courierPickupOrder.updateMany({ where: { id: w.id, state: 'TWORZENIE' }, data: { state: 'ZAMOWIONY', externalRef: out.externalRef ?? null, checkSum: out.sumaKontrolna ?? null, lastError: null, failureKind: null, ...faktyczne } })
    const z = await db.courierPickupOrder.findUniqueOrThrow({ where: { id: w.id } })
    return z.state === 'ZAMOWIONY' ? { wynik: 'ZAMOWIONY', zlecenie: naEkran(z), istnialo: false } : wynikIstniejacego(z)
  }
  const powod = krotko(out.message)
  if (out.kind === 'NIEJEDNOZNACZNY') {
    await runTx(db, async (tx) => {
      const u = await tx.courierPickupOrder.updateMany({ where: { id: w.id, state: 'TWORZENIE' }, data: { state: 'NIEJEDNOZNACZNY', lastError: powod, failureKind: out.kind } })
      if (u.count)
        await alert(
          tx,
          ALERT_KURIERA,
          w.id,
          `Nie wiadomo, czy przewoźnik przyjął zamówienie kuriera ${w.carrier} na ${w.pickupDay} (referencja ${w.reference}). Sprawdź w panelu przewoźnika albo telefonicznie; drugie zamówienie tylko świadomie.`,
          `kurier:${w.id}`,
        )
    })
    const z = await db.courierPickupOrder.findUniqueOrThrow({ where: { id: w.id } })
    return z.state === 'NIEJEDNOZNACZNY' ? { wynik: 'NIEJEDNOZNACZNY', zlecenie: naEkran(z), istnialo: false } : wynikIstniejacego(z)
  }
  // odmowa terminu przewoźnika: zapis terminu, który faktycznie poszedł (inaczej ekran pokazuje okno z formularza)
  const wyslane = out.okno ? { fromMinute: out.okno.odMin, toMinute: out.okno.doMin } : {}
  await db.courierPickupOrder.updateMany({ where: { id: w.id, state: 'TWORZENIE' }, data: { state: 'BLAD', lastError: powod, failureKind: out.kind, ...wyslane } })
  const z = await db.courierPickupOrder.findUniqueOrThrow({ where: { id: w.id } })
  return z.state === 'BLAD' ? { wynik: 'BLAD', zlecenie: naEkran(z), powod } : wynikIstniejacego(z)
}

/**
 * Odczyt dostępności u przewoźnika z limitem czasu; null = moduł bez tej zdolności. Wyjątek = błąd odczytu. Po
 * przesyłkach (`wp`) adapter konta sprzedaży przesyłek i ich numery w zapytaniu.
 */
async function odczytDostepnosci(db: Db, r: RegulaKuriera, registry: AdapterRegistry, deps: DepsKuriera, wp: PrzesylkiOdbioru | null): Promise<DostepnoscOdbioru | null> {
  const adapter = await adapterOdbioru(db, r, wp ? wp.konto : null, registry, deps)
  if (!hasPickupAvailability(adapter)) return null
  return zLimitem(adapter.dostepnoscOdbioru({ timeoutMs: LIMIT_DOSTEPNOSCI_MS, ...(wp ? { przesylki: wp.przesylki } : {}) }), LIMIT_DOSTEPNOSCI_MS + 500)
}

/**
 * Dostępność modułu na przedziały okna: `przedzialy` bez dat (każdy dzień odbioru) i `dni` z datami RRRR-MM-DD z
 * przesunięć `dzienOd` od dziś (Warszawa). BRAK = puste listy (przewoźnik nie podał przedziałów).
 */
export function dostepnoscNaDaty(w: DostepnoscOdbioru, dzis: string): { przedzialy: PrzedzialDostepnosci[]; dni: Record<string, PrzedzialDostepnosci[]> } {
  if (w.stan === 'BRAK') return { przedzialy: [], dni: {} }
  const dni: Record<string, PrzedzialDostepnosci[]> = {}
  for (const d of w.dni ?? []) dni[addDays(dzis, d.dzienOd)] = d.przedzialy
  return { przedzialy: w.przedzialy ?? [], dni }
}

// ─── Automat „Zamawiaj kuriera automatycznie” ─────────────────────────────────
//
// Zadanie workera (KURIER_AUTOMAT_JOB, co 2 minuty), nigdy żądanie magazyniera. Dla każdego przewoźnika z włączonym
// „Zamawianie kuriera z Kompletora” i „Zamawiaj kuriera automatycznie” w koncie: dzień odbioru = najbliższy dzień
// z harmonogramu firmy (lib/wysylka/podjazd.ts), decyzja = `ocenAutomatu` (lib/wysylka/kurier-regula.ts).
//
// Ochrona przed drugim zleceniem na ten sam dzień i konto, po kolei:
//   1. decyzja bez sieci: jakikolwiek wiersz na ten dzień poza pewną odmową (TWORZENIE, ZAMOWIONY, NIEJEDNOZNACZNY,
//      ręczne „nie przyjął”) zatrzymuje automat; najwyżej MAX_PROB_AUTOMATU wierszy automatu na dzień;
//   2. rezerwacja pod tą samą blokadą dnia co przycisk (`kluczBlokadyKuriera`), z decyzją powtórzoną na świeżym odczycie
//      w tej samej transakcji: drugi worker albo kliknięcie w tej samej chwili czeka na blokadę i widzi wiersz
//      TWORZENIE, więc nie woła przewoźnika;
//   3. nowy wiersz zawsze z kolejnym numerem próby: unikalność (firma, przewoźnik, moduł, konto, dzień, próba) w bazie
//      odrzuca drugi zapis tej samej próby;
//   4. automat nigdy nie wysyła `drugi`; wiersz automatu po odmowie zostaje (przycisk go nie nadpisuje), więc licznik
//      prób automatu nie maleje;
//   5. przerwany proces zostawia TWORZENIE: po TWORZENIE_PRZERWANE_MIN minutach wiersz przechodzi w NIEJEDNOZNACZNY
//      z alertem, co zatrzymuje automat na ten dzień (punkt 1); harmonogram workera nie piętrzy zadań (dedupeKey).

export { KURIER_AUTOMAT_JOB } from './kurier-regula'
export const ALERT_KURIERA_AUTOMAT = 'KURIER_AUTOMAT'

export type WynikAutomatuKuriera = { carrier: Carrier; decyzja: DecyzjaAutomatu['decyzja'] | 'POMINIETY'; powod: string | null; wynik?: WynikKuriera['wynik'] }

/**
 * Paczki czekające na kuriera dnia `dzien` (`paczkiCzekajace`): przesyłki z numerem nadania (bez anulowanych) ze
 * statusem ze śledzenia, kliknięcia „Przyjechał” i zlecenia podjazdu na wcześniejsze dni z ostatnich 7 dni. Błąd
 * odczytu = null (automat nie zamawia, alert).
 */
async function paczkiAutomatu(db: DbLubTx, carrier: Carrier, r: RegulaKuriera, now: Date, dzien: string): Promise<PaczkiCzekajace | null> {
  try {
    const od = new Date(now.getTime() - 7 * 86_400_000)
    const [s, przyjazdy, zlecenia] = await Promise.all([
      db.shipment.findMany({
        where: { state: 'UTWORZONA', carrier: r.regula.carrier, adapterKey: r.regula.adapterKey, accountSuffix: r.konto || null, order: { status: { in: [...STATUSY_NADANIA] } } },
        select: { weightKg: true, createdAt: true, carrierStatus: true, trackedAt: true },
        take: 2000,
      }),
      db.carrierPickupEvent.findMany({ where: { carrier, arrivedAt: { gte: od } }, select: { pickupDay: true, arrivedAt: true } }),
      db.courierPickupOrder.findMany({
        where: { carrier, adapterKey: r.regula.adapterKey, accountKey: r.konto, pickupDay: { lt: dzien, gte: toWarsaw(od).day }, state: { in: [...AKTYWNE] } },
        select: { pickupDay: true, toMinute: true },
      }),
    ])
    const przyjazd = new Map(przyjazdy.map((p) => [p.pickupDay, p.arrivedAt.getTime()]))
    const odbiory = new Map<string, OdbiorWczesniejszy>()
    for (const z of zlecenia) {
      const koniec = fromWarsaw(z.pickupDay, z.toMinute * 60_000).getTime()
      const b = odbiory.get(z.pickupDay)
      odbiory.set(z.pickupDay, { dzien: z.pickupDay, koniecMs: Math.max(b?.koniecMs ?? koniec, koniec), przyjazdMs: przyjazd.get(z.pickupDay) ?? null })
    }
    for (const [d, m] of przyjazd) if (!odbiory.has(d)) odbiory.set(d, { dzien: d, koniecMs: null, przyjazdMs: m })
    const paczki: PaczkaAutomatu[] = s.map((x) => ({ wagaKg: x.weightKg ? Number(x.weightKg) : 0, utworzonaMs: x.createdAt.getTime(), status: x.carrierStatus, sprawdzonaMs: x.trackedAt ? x.trackedAt.getTime() : null }))
    // bez śladu odbioru paczki sprzed dzisiejszej północy (czas polski) są niepewne: ktoś mógł je już odebrać
    return paczkiCzekajace(paczki, [...odbiory.values()], now.getTime(), fromWarsaw(toWarsaw(now).day, 0).getTime())
  } catch (e) {
    console.error(`[kurier-automat] ${carrier}: paczki: ${e instanceof Error ? krotko(e.message).slice(0, 300) : 'błąd'}`)
    return null
  }
}

type DbLubTx = Pick<Db, 'carrierPickup' | 'carrierPickupEvent' | 'shipment' | 'courierPickupOrder'>

const probyDnia = (w: readonly CourierPickupOrder[]): ProbaDnia[] => w.map((x) => ({ stan: x.state, odMin: x.fromMinute, doMin: x.toMinute, recznie: x.failureKind === RECZNIE, automat: x.requestedBy === AUTOMAT_ID, odmowaGodzin: czyOdmowaGodzin(x.lastError) }))

interface OcenaReguly {
  decyzja: DecyzjaAutomatu
  dzien: string | null
  paczki: PaczkiCzekajace | null
}


/** Decyzja automatu dla reguły na świeżych danych z bazy; `kandydaci` = przedziały z dostępności (null = z reguły). */
async function ocenRegule(db: DbLubTx, carrier: Carrier, r: RegulaKuriera, now: Date, kandydaci: readonly PrzedzialOdbioru[] | null): Promise<OcenaReguly> {
  const w = toWarsaw(now)
  const prop = await propozycjaPodjazduFirmy(db as Db, carrier, now)
  const dzien = prop?.dni[0] ?? null
  const paczki = dzien ? await paczkiAutomatu(db, carrier, r, now, dzien) : null
  const wiersze = dzien ? await db.courierPickupOrder.findMany({ where: { carrier, adapterKey: r.regula.adapterKey, accountKey: r.konto, pickupDay: dzien } }) : []
  const decyzja = ocenAutomatu({
    dzien,
    dzis: w.day,
    terazMin: Math.floor(w.msOfDay / 60_000),
    dzienRoboczy: dzien ? isBusinessDay(dzien) : false,
    godzinaOdbioruMin: prop ? prop.odMin : null,
    paczki,
    proby: probyDnia(wiersze),
    kandydaci,
    regula: regulaPrzedzialu(r.regula.adapterKey),
  })
  return { decyzja, dzien, paczki }
}

/** Zdanie dla ekranu Pakowanie pod paskiem kuriera; null = linia zamówienia mówi już wszystko. */
function opisDecyzji(o: OcenaReguly): string | null {
  const d = o.decyzja
  if (d.decyzja === 'ZAMOW') return `Automat zamówi podjazd na ${dzienKrotko(o.dzien!)} ${hm(d.przedzial.odMin)}–${hm(d.przedzial.doMin)} w ciągu kilku minut (godziny mogą się zmienić po odczycie wolnych przedziałów u przewoźnika).`
  if (d.decyzja === 'STOP' && d.powod === 'podjazd na ten dzień jest już zamówiony') return null
  return `Automat${o.dzien ? ` (${dzienKrotko(o.dzien)})` : ''}: ${d.powod}.`
}

/**
 * Jeden przebieg automatu dla wszystkich przewoźników firmy z włączonym automatem. Każdy przewoźnik osobno (błąd
 * jednego nie zatrzymuje reszty); najwyżej jedno żądanie zamówienia na przewoźnika i przebieg.
 */
export async function zamowKurieraAutomatycznie(db: Db, deps: DepsKuriera = {}): Promise<WynikAutomatuKuriera[]> {
  const organizationId = organizationIdOf(db)
  const registry = deps.registry ?? defaultRegistry()
  const reguly = await regulyKuriera(db, registry)
  const out: WynikAutomatuKuriera[] = []
  for (const [carrier, r] of reguly) {
    // automat zamawia podjazd na dzień: moduły po przesyłkach (`pickupPerShipment`) tylko przyciskiem
    if (r.poPrzesylkach || r.regula.config[POLE_AUTOMATU] !== true) continue
    try {
      out.push(await automatDlaReguly(db, organizationId, carrier, r, registry, deps))
    } catch (e) {
      console.error(`[kurier-automat] ${carrier}: ${e instanceof Error ? krotko(e.message).slice(0, 300) : 'błąd'}`)
      out.push({ carrier, decyzja: 'POMINIETY', powod: 'błąd przebiegu automatu' })
    }
  }
  return out
}

async function automatDlaReguly(db: Db, organizationId: string, carrier: Carrier, r: RegulaKuriera, registry: AdapterRegistry, deps: DepsKuriera): Promise<WynikAutomatuKuriera> {
  const now = teraz(deps)
  await oznaczPrzerwane(db, now, carrier)
  if (r.regula.config['zapisWlaczony'] !== true) return { carrier, decyzja: 'POMINIETY', powod: 'nadawanie wyłączone' }
  const praca = await bramkaPracy(db, deps)
  if (praca) return { carrier, decyzja: 'POMINIETY', powod: praca }

  // 1. decyzja bez sieci: większość przebiegów kończy się tutaj (zamówione, brak paczek, opóźnienie)
  const wstepna = await ocenRegule(db, carrier, r, now, null)
  if (wstepna.decyzja.decyzja !== 'ZAMOW' || !wstepna.dzien) return zakonczBezZamowienia(db, carrier, r, wstepna)
  const dzien = wstepna.dzien

  // 2. wolne przedziały u przewoźnika (poza transakcją; błąd = przedziały z reguły)
  let kandydaci: PrzedzialOdbioru[] | null = null
  try {
    const d = await odczytDostepnosci(db, r, registry, deps, null)
    if (d && d.stan === 'OK') {
      const n = dostepnoscNaDaty(d, toWarsaw(now).day)
      kandydaci = (n.dni[dzien] ?? n.przedzialy).map((p) => ({ odMin: p.odMin, doMin: p.doMin }))
    }
  } catch (e) {
    console.error(`[kurier-automat] ${carrier}: dostępność: ${e instanceof Error ? krotko(e.message).slice(0, 300) : 'błąd'}`)
  }

  // 3. rezerwacja pod blokadą dnia z decyzją powtórzoną na świeżych danych w tej samej transakcji
  const klucz = { carrier, adapterKey: r.regula.adapterKey, accountKey: r.konto, pickupDay: dzien }
  const rez = await runTx(db, async (tx) => {
    await advisoryLock(tx, kluczBlokadyKuriera(organizationId, carrier, r.regula.adapterKey, r.konto, dzien, r.poPrzesylkach))
    const ocena = await ocenRegule(tx, carrier, r, now, kandydaci)
    if (ocena.decyzja.decyzja !== 'ZAMOW' || ocena.dzien !== dzien || !ocena.paczki) return { ocena, w: null }
    const ostatni = await tx.courierPickupOrder.findFirst({ where: klucz, orderBy: { attempt: 'desc' }, select: { attempt: true } })
    const attempt = (ostatni?.attempt ?? 0) + 1
    const reference = deriveReference([organizationId, 'kurier', carrier, r.regula.adapterKey, r.konto, dzien, attempt])
    const p = ocena.decyzja.przedzial
    const w = await tx.courierPickupOrder.create({
      data: { ...klucz, attempt, reference, state: 'TWORZENIE', fromMinute: p.odMin, toMinute: p.doMin, parcels: ocena.paczki.liczba, weightKg: ocena.paczki.wagaKg, requestedBy: AUTOMAT_ID, requestedName: AUTOMAT_NAZWA },
    })
    return { ocena, w }
  })
  if (!rez.w) return zakonczBezZamowienia(db, carrier, r, rez.ocena)

  // 4. jedno żądanie do przewoźnika (to samo co przycisk); pewna odmowa = alert z polskim powodem
  const w = rez.w
  const wynik = await wyslijZamowienie(db, r, w, { data: dzien, odMin: w.fromMinute, doMin: w.toMinute, liczba: w.parcels, wagaKg: Number(w.weightKg) }, registry, deps, null)
  if (wynik.wynik === 'BLAD') {
    const po = await ocenRegule(db, carrier, r, now, kandydaci)
    const ponowi = po.decyzja.decyzja === 'ZAMOW'
    const okno = `${dzienKrotko(dzien)} ${hm(w.fromMinute)}–${hm(w.toMinute)}`
    const powod = powodPoLudzku(wynik.powod)?.tekst ?? wynik.powod
    await alert(
      db,
      ALERT_KURIERA_AUTOMAT,
      w.id,
      `Automat nie zamówił kuriera ${carrier} na ${okno}: ${powod.slice(0, 400)} ${ponowi ? 'Automat spróbuje jeszcze raz, w innym przedziale.' : 'Automat już nie ponawia: zamów kuriera ręcznie (Pakowanie, przycisk przy pasku kuriera) albo zadzwoń do przewoźnika.'}`,
      `kurier-auto:${w.id}`,
    )
  }
  return { carrier, decyzja: 'ZAMOW', powod: null, wynik: wynik.wynik }
}

/** Bez zamówienia: decyzja z alertem (raz na dzień, przewoźnika i konto, dedupe) albo cisza. */
async function zakonczBezZamowienia(db: Db, carrier: Carrier, r: RegulaKuriera, o: OcenaReguly): Promise<WynikAutomatuKuriera> {
  const d = o.decyzja
  if (d.decyzja === 'STOP' && d.alert && o.dzien)
    await alert(db, ALERT_KURIERA_AUTOMAT, `${carrier}:${o.dzien}`, `Automat nie zamówi kuriera ${carrier} na ${dzienKrotko(o.dzien)}: ${d.powod}.`, `kurier-auto:${carrier}:${r.regula.adapterKey}:${r.konto}:${o.dzien}:stop`)
  return { carrier, decyzja: d.decyzja, powod: d.decyzja === 'ZAMOW' ? null : d.powod }
}
