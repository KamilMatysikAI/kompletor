// Reguły przypisania przewoźnika z panelu: „sposób dostawy z kanału → przewoźnik → moduł
// wysyłki”, pierwsza pasująca (od góry) wygrywa. Zapis całej listy naraz (kolejność wierszy = priorytet), walidacja
// `validateCarrierRule`, id istniejących reguł i ich konfiguracja (ustawienia konta przewoźnika, wyłącznik nadawania)
// zostają. Zmiana reguł nie przelicza zamówień już przyjętych: przewoźnika takiego zamówienia zmienia się na karcie.
import type { Carrier, Channel, Prisma, PrismaClient, ShippingModule } from '@prisma/client'
import { $Enums } from '@prisma/client'
import type { AdapterRegistry } from '../adaptery/rejestr'
import { organizationIdOf } from '../db'
import { CARRIER_LABEL } from '../panel/format'
import { dopasowanaRegula, validateCarrierRule, type CarrierRuleT } from '../rdzen/przewoznicy'
import { kluczReguly, SEKRETY_KONTA_RE } from './adapter-przewoznika'
import { kontaPrzewoznikow, POLA_UKRYTE, sufiksyKontTrwalych } from './konta'
import { idKontaPrzewoznika, maKontoPrzewoznika, nalozUstawieniaKonta, POLA_SERWERA_PRZEWOZNIKA, polaKonta as polaKontaManifestu, rodzinaAdaptera, sufiksKonta, ustawieniaKont, zmienUstawieniaKont, type UstawieniaKonta } from './ustawienia-konta'

/**
 * czy reguła zmienia przewoźnika modułu (inna rodzina adaptera, np. Base Courier → DPD). W obrębie rodziny
 * (wersja odczytu ↔ wersja z zapisem) ustawienia reguły zostają.
 */
const innyPrzewoznik = (stary: string | null, nowy: string | null): boolean => (stary ? rodzinaAdaptera(stary) : null) !== (nowy ? rodzinaAdaptera(nowy) : null)

export class RegulyError extends Error {
  constructor(
    message: string,
    readonly pole?: string,
  ) {
    super(message)
  }
}

/** Moduł wysyłki z klucza adaptera (rodzina adaptera przed kropką). */
export function modulAdaptera(adapterKey: string | null): ShippingModule {
  if (!adapterKey) return 'BRAK'
  if (adapterKey.startsWith('allegro.wysylam')) return 'WYSYLAM_Z_ALLEGRO'
  if (adapterKey.startsWith('basecourier.')) return 'BASE_COURIER'
  if (adapterKey.startsWith('inpost.shipx')) return 'INPOST_SHIPX'
  if (adapterKey.startsWith('dpd.services')) return 'DPD_BEZPOSREDNIO'
  if (adapterKey.startsWith('orlenpaczka.')) return 'ORLEN_PACZKA'
  if (adapterKey.startsWith('gls.ade')) return 'GLS_ADE'
  if (adapterKey.startsWith('pocztapolska.')) return 'POCZTA_POLSKA'
  throw new RegulyError(`Nieznany moduł wysyłki: ${adapterKey}`)
}

/** Moduły do wyboru w regule: adaptery przewoźników z rejestru. */
export function modulyWysylki(registry: AdapterRegistry): { wartosc: string; etykieta: string }[] {
  return registry
    .list()
    .filter((m) => m.kind === 'carrier')
    .map((m) => ({ wartosc: m.adapterKey, etykieta: m.displayName }))
    .sort((a, b) => a.etykieta.localeCompare(b.etykieta, 'pl'))
}

export const PRZEWOZNICY_W_REGULE: Carrier[] = (Object.values($Enums.Carrier) as Carrier[]).filter((c) => c !== 'BRAK' && c !== 'BEZ_WYSYLKI')
export const KANALY_W_REGULE: Channel[] = (Object.values($Enums.Channel) as Channel[]).filter((c) => c !== 'AI')

export interface RegulaPanelu extends CarrierRuleT {
  id: string
  adapterKey: string | null
  /** opis ustawień reguły (`config`), których formularz nie pokazuje i nie odtworzy po usunięciu; null = brak */
  konfiguracja: string | null
  /** drugie konto przewoźnika (`config.sekretyKonta`), null = konto główne */
  konto: string | null
  /**
   * ta część `konfiguracja`, której panel nie odtworzy (bez wyłącznika nadawania, pól z ekranu Konta
   * przewoźników i konta, które zostaje na liście kont); null = usunięcie bez potwierdzenia. Bez rejestru = `konfiguracja`.
   */
  potwierdzenie: string | null
}

/** Co panel odtworzy po usunięciu reguły: pola kont przewoźników (z manifestu) i konta trwałe. */
interface Odtwarzalne {
  pola: (adapterKey: string | null) => Set<string>
  konta: Set<string>
}

async function odtwarzalne(db: PrismaClient, registry: AdapterRegistry): Promise<Odtwarzalne> {
  const konta = await sufiksyKontTrwalych(db, registry)
  return {
    konta,
    pola: (adapterKey) => new Set((adapterKey ? (registry.get(adapterKey)?.manifest.config ?? []) : []).map((f) => f.key).filter((k) => !POLA_UKRYTE.has(k))),
  }
}

/** Opis tylko tej części `config`, której panel nie odtworzy; null = nic takiego. */
export function opisNieodtwarzalnych(config: unknown, adapterKey: string | null, o: Odtwarzalne): string | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null
  const c = { ...(config as Record<string, unknown>) }
  delete c['zapisWlaczony'] // przełącznik „Nadawanie z Kompletora” na ekranie Konta przewoźników
  if (typeof c['sekretyKonta'] === 'string' && o.konta.has(c['sekretyKonta'])) delete c['sekretyKonta'] // kolumna „Konto”
  for (const k of o.pola(adapterKey)) delete c[k] // ustawienia konta na ekranie Konta przewoźników
  return opisKonfiguracji(c)
}

/**
 * Opis `config` reguły dla osoby w panelu: drugie konto przewoźnika (`sekretyKonta`), ustawienia
 * konta i wyłącznik nadawania żyją w regule. Usunięcie reguły je kasuje, a dodanie jej na nowo z panelu ich nie odtworzy
 * (np. „DPD do salonu Empik” nadawałaby z głównego konta DPD). null = reguła bez ustawień.
 */
export function opisKonfiguracji(config: unknown): string | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null
  const c = config as Record<string, unknown>
  const klucze = Object.keys(c).filter((k) => c[k] !== null && c[k] !== undefined && c[k] !== '')
  if (!klucze.length) return null
  const czesci: string[] = []
  if (typeof c['sekretyKonta'] === 'string' && c['sekretyKonta']) czesci.push(`drugie konto przewoźnika (${c['sekretyKonta']})`)
  if ('zapisWlaczony' in c) czesci.push(`nadawanie z Kompletora: ${c['zapisWlaczony'] === true || c['zapisWlaczony'] === 'tak' ? 'włączone' : 'wyłączone'}`)
  const reszta = klucze.filter((k) => k !== 'sekretyKonta' && k !== 'zapisWlaczony')
  if (reszta.length) czesci.push(`ustawienia konta: ${reszta.join(', ')}`)
  return czesci.join('; ')
}

const kontoZ = (config: unknown): string | null => {
  const k = config && typeof config === 'object' && !Array.isArray(config) ? (config as Record<string, unknown>)['sekretyKonta'] : null
  return typeof k === 'string' && k ? k : null
}

export async function regulyPrzewoznikow(db: PrismaClient, registry?: AdapterRegistry): Promise<RegulaPanelu[]> {
  organizationIdOf(db)
  const rows = await db.carrierRule.findMany({ orderBy: { priority: 'asc' }, select: { id: true, priority: true, channel: true, pattern: true, carrier: true, shippingModule: true, adapterKey: true, config: true } })
  const o = registry ? await odtwarzalne(db, registry) : null
  return rows.map(({ config, ...r }) => ({
    ...r,
    konfiguracja: opisKonfiguracji(config),
    konto: kontoZ(config),
    potwierdzenie: o ? opisNieodtwarzalnych(config, r.adapterKey, o) : opisKonfiguracji(config),
  }))
}

export interface RegulaWejscie {
  id: string | null
  channel: string
  pattern: string
  carrier: string
  adapterKey: string
  /** sufiks drugiego konta przewoźnika, '' = konto główne; brak pola = bez zmiany */
  konto?: string
}

export interface WynikZapisuRegul {
  reguly: number
  zmienione: boolean
  /** istniejące reguły przeniesione na inne konto; numer wiersza od 1, sufiks konta (null = główne) */
  przeniesione: RegulaPrzeniesiona[]
}

/**
 * reguła przeniesiona na inne konto (albo moduł innego przewoźnika) i co się przy tym stało z jej
 * ustawieniami, do komunikatu po zapisie: nadawanie zawsze jest wyłączane, pola konta bez wartości w nowym koncie
 * przechodzą z poprzedniego (wymiary, waga), a pola z umowy konta (`zKontaPrzewoznika`: FID-y, środowisko) nie.
 */
export interface RegulaPrzeniesiona {
  nr: number
  konto: string | null
  adapterKey: string | null
  /** reguła nadawała przed zmianą, a po niej ma nadawanie wyłączone */
  nadawanieWylaczone: boolean
  /** opisy pól przeniesionych do nowego konta (nowe konto ich nie miało) */
  przeniesionePola: string[]
  /** opisy pól, które poprzednie konto miało, a nowe konto nie ma i ich nie dostało (do wpisania w karcie konta) */
  doUzupelnienia: string[]
}

/**
 * komunikat po zapisie reguł dla reguły przeniesionej na inne konto: że nadawanie jest wyłączone i trzeba je
 * włączyć, co przeszło z poprzedniego konta i czego nowe konto nie ma (nic nie znika bez słowa).
 */
export function opisPrzeniesienia(p: RegulaPrzeniesiona, nazwaKonta: string): string {
  const czesci = [`Reguła ${p.nr} przeniesiona na: ${nazwaKonta}.`]
  czesci.push(
    p.nadawanieWylaczone
      ? 'Nadawanie tej reguły jest teraz wyłączone: sprawdź ustawienia konta i włącz je ponownie na ekranie Konta przewoźników.'
      : 'Nadawanie tej reguły jest wyłączone: włączysz je na ekranie Konta przewoźników.',
  )
  if (p.przeniesionePola.length) czesci.push(`Z poprzedniego konta przeszły: ${p.przeniesionePola.join(', ')}.`)
  if (p.doUzupelnienia.length) czesci.push(`Poprzednie konto miało, a to konto nie ma (nie przenosimy, bo zależą od umowy konta): ${p.doUzupelnienia.join(', ')}. Wpisz je w karcie konta, jeśli dotyczą tego konta.`)
  return czesci.join(' ')
}

/** Krótki opis pola z manifestu do komunikatu: opis do pierwszego nawiasu, średnika albo dwukropka. */
const krotkiOpis = (opis: string): string => opis.split(/\s*[(;:]/)[0]!.trim() || opis

/**
 * Zapis listy reguł: usuwa reguły, których nie ma na liście, aktualizuje istniejące (po id, `config` zostaje), dopisuje
 * nowe. Priorytety 10, 20, … w kolejności z formularza. Najpierw pełna walidacja, potem zapis w jednej transakcji z
 * AuditLog. Reguła z ustawieniami (`config`) znika tylko, gdy jej id jest w `usunZKonfiguracja` (potwierdzenie w panelu),
 * a jej `config` trafia do AuditLog `before`, żeby osoba techniczna mogła go odtworzyć.
 */
export async function zapiszRegulyPrzewoznikow(
  db: PrismaClient,
  registry: AdapterRegistry,
  wiersze: RegulaWejscie[],
  actorId: string,
  opcje: { usunZKonfiguracja?: readonly string[] } = {},
): Promise<WynikZapisuRegul> {
  const organizationId = organizationIdOf(db)
  if (wiersze.length > 100) throw new RegulyError('Najwyżej 100 reguł')
  const [przed, org] = await Promise.all([
    db.carrierRule.findMany({ select: { id: true, priority: true, channel: true, pattern: true, carrier: true, shippingModule: true, adapterKey: true, config: true } }),
    db.organization.findFirst({ select: { settings: true } }),
  ])
  const ustawienia = ustawieniaKont(org?.settings)
  const ids = new Set(przed.map((r) => r.id))
  // konto musi istnieć w rodzinie modułu reguły (lista kont jak na ekranie Kont)
  let kontaFirmy: Awaited<ReturnType<typeof kontaPrzewoznikow>> | null = null
  const nowe: (CarrierRuleT & { id: string | null; konto: string | undefined })[] = []
  for (const [i, w] of wiersze.entries()) {
    if (w.id && !ids.has(w.id)) throw new RegulyError('Ta reguła została w międzyczasie usunięta — odśwież stronę', `regula-${i}-przewoznik`)
    if (w.channel && !(KANALY_W_REGULE as string[]).includes(w.channel)) throw new RegulyError('Wybierz kanał z listy', `regula-${i}-kanal`)
    if (!(PRZEWOZNICY_W_REGULE as string[]).includes(w.carrier)) throw new RegulyError('Wybierz przewoźnika', `regula-${i}-przewoznik`)
    const adapterKey = w.adapterKey.trim() || null
    if (adapterKey) {
      const def = registry.get(adapterKey)
      if (!def || def.manifest.kind !== 'carrier') throw new RegulyError('Wybierz moduł wysyłki z listy', `regula-${i}-modul`)
    }
    let shippingModule: ShippingModule
    try {
      shippingModule = modulAdaptera(adapterKey)
    } catch (e) {
      throw new RegulyError(e instanceof Error ? e.message : 'Zły moduł', `regula-${i}-modul`)
    }
    const konto = w.konto === undefined ? undefined : w.konto.trim()
    if (konto && !SEKRETY_KONTA_RE.test(konto)) throw new RegulyError('Wybierz konto przewoźnika z listy', `regula-${i}-konto`)
    const poprzednia = przed.find((x) => x.id === w.id)
    // konto przy zmianie przewoźnika modułu też musi istnieć u nowego przewoźnika
    if (konto && (konto !== kontoZ(poprzednia?.config) || (poprzednia && innyPrzewoznik(kluczReguly(poprzednia), kluczReguly({ adapterKey, shippingModule }))))) {
      const klucz = kluczReguly({ adapterKey, shippingModule })
      if (!klucz) throw new RegulyError('Drugie konto przewoźnika działa tylko z modułem wysyłki: wybierz moduł', `regula-${i}-modul`)
      kontaFirmy ??= await kontaPrzewoznikow(db, registry)
      if (!kontaFirmy.some((k) => k.sufiks === konto && k.moduly.includes(klucz))) throw new RegulyError('Tego konta nie ma u tego przewoźnika: wybierz konto z listy albo dodaj je na ekranie Konta przewoźników', `regula-${i}-konto`)
    }
    const rule: CarrierRuleT = { priority: (i + 1) * 10, channel: (w.channel || null) as Channel | null, pattern: w.pattern.trim() || null, carrier: w.carrier as Carrier, shippingModule, adapterKey }
    if (shippingModule === 'WYSYLAM_Z_ALLEGRO' && rule.channel !== 'ALLEGRO') throw new RegulyError('Wysyłam z Allegro działa tylko dla zamówień z Allegro: ustaw kanał „Allegro”', `regula-${i}-kanal`)
    try {
      validateCarrierRule(rule)
    } catch (e) {
      const m = e instanceof Error ? e.message : ''
      throw new RegulyError(/wzorzec/i.test(m) ? 'Wzorzec ma błąd składni (słowa rozdzielaj znakiem |)' : m || 'Zła reguła', `regula-${i}-slowa`)
    }
    nowe.push({ id: w.id, ...rule, konto })
  }
  const zostaja = new Set(nowe.map((r) => r.id).filter(Boolean))
  const potwierdzone = new Set(opcje.usunZKonfiguracja ?? [])
  const usuwane = przed.filter((r) => !zostaja.has(r.id))
  const odtw = usuwane.length ? await odtwarzalne(db, registry) : null
  for (const r of usuwane) {
    const opis = opisNieodtwarzalnych(r.config, r.adapterKey, odtw!)
    if (opis && !potwierdzone.has(r.id)) {
      throw new RegulyError(`Usuwana reguła (${r.pattern ?? 'każdy sposób dostawy'} → ${CARRIER_LABEL[r.carrier]}) ma ustawienia, których panel nie odtworzy: ${opis}. Potwierdź usunięcie przyciskiem „Usuń” przy regule.`)
    }
  }
  // konfiguracja po zapisie: konto z kolumny „Konto” (gdy podane). Przy zmianie konta z configu
  // znikają pola konta poprzedniego (z manifestu, spoza POLA_UKRYTE: np. FID płatnika DPD) i wyłącznik nadawania, żeby
  // reguła nie nadawała kluczami nowego konta z płatnikiem starego. Tak samo przy zmianie przewoźnika modułu
  // (inna rodzina adaptera, np. Base Courier → DPD), a do tego znikają ustawienia serwera starego przewoźnika (adres
  // API, przedrostek env) i konto reguły, gdy kolumna „Konto” go nie podała. Zmiana w obrębie rodziny (wersja odczytu ↔
  // wersja z zapisem) i reszta ustawień spoza panelu (nadawca) zostają. Wartości pól konta nie giną: zapis przenosi je
  // do ustawień konta (`doKont` niżej).
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {})
  const polaKonta = (adapterKey: string | null) => (adapterKey ? (registry.get(adapterKey)?.manifest.config ?? []) : []).map((f) => f.key).filter((k) => !POLA_UKRYTE.has(k))
  const configPo = (r: (typeof nowe)[number]): Record<string, unknown> | null => {
    const stara = przed.find((x) => x.id === r.id)
    const cur = obj(stara?.config)
    const nowyKlucz = kluczReguly({ adapterKey: r.adapterKey ?? null, shippingModule: r.shippingModule })
    const inny = !!stara && innyPrzewoznik(kluczReguly(stara), nowyKlucz)
    if (!inny && (r.konto === undefined || (r.konto || null) === kontoZ(cur))) return null // bez zmiany
    for (const k of [...(stara ? polaKonta(kluczReguly(stara)) : []), ...polaKonta(nowyKlucz)]) delete cur[k]
    delete cur['zapisWlaczony']
    if (inny) for (const k of POLA_SERWERA_PRZEWOZNIKA) delete cur[k]
    const konto = r.konto !== undefined ? r.konto || null : inny ? null : kontoZ(cur)
    if (konto) cur['sekretyKonta'] = konto
    else delete cur['sekretyKonta']
    return cur
  }
  // konto przewoźnika, z którego korzysta reguła po zapisie (id jak na ekranie kont); null = bez konta
  const kontoReguly = (key: string | null, config: Record<string, unknown>): string | null => {
    const def = key ? registry.get(key) : undefined
    return key && def && maKontoPrzewoznika(def.manifest) ? idKontaPrzewoznika(key, sufiksKonta(config)) : null
  }
  const kontoPo = (r: (typeof nowe)[number]): string | null => {
    const stara = przed.find((x) => x.id === r.id)
    const cfg = stara ? (configPo(r) ?? obj(stara.config)) : r.konto ? { sekretyKonta: r.konto } : {}
    return kontoReguly(kluczReguly({ adapterKey: r.adapterKey ?? null, shippingModule: r.shippingModule }), cfg)
  }
  const kontoPrzed = (stara: (typeof przed)[number]): string | null => kontoReguly(kluczReguly(stara), obj(stara.config))
  const poZapisie = new Map(nowe.flatMap((r) => (r.id ? [[r.id, kontoPo(r)] as const] : [])))
  const kontaPo = new Set(nowe.map(kontoPo))
  // pola konta zapisane w configu reguły (wartości niepuste, tylko pola z manifestu jej adaptera)
  const polaZReguly = (stara: (typeof przed)[number]): UstawieniaKonta => {
    const key = kluczReguly(stara)
    const cfg = obj(stara.config)
    const pola: UstawieniaKonta = {}
    for (const k of key ? polaKontaManifestu(registry.get(key)!.manifest) : []) {
      const v = cfg[k]
      if ((typeof v === 'string' && v !== '') || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) pola[k] = v
    }
    return pola
  }
  const wgPriorytetu = [...przed].sort((x, y) => x.priority - y.priority)
  // Pola konta z configów reguł trafiają do ustawień konta (tylko pola, których konto jeszcze nie ma), żeby nie zginęły
  // i żeby wszystkie reguły konta działały na tych samych ustawieniach:
  // 1. reguła zostawia swoje konto bez żadnej reguły (usunięta, przeniesiona, inny przewoźnik);
  // 2. Reguła dołącza do konta, którego ustawienia są tylko w configu innej reguły (np. kurier DPD
  //    przełączony z Base Couriera na konto, które ma już regułę salonu Empik): wartości z pierwszej (wg priorytetu)
  //    reguły, która była i zostaje na tym koncie.
  const doKont: { id: string; pola: UstawieniaKonta }[] = []
  const dodajDoKonta = (id: string, pola: UstawieniaKonta) => {
    if (Object.keys(pola).length) doKont.push({ id, pola })
  }
  for (const stara of wgPriorytetu) {
    const id = kontoPrzed(stara)
    if (id && !kontaPo.has(id)) dodajDoKonta(id, polaZReguly(stara))
  }
  // 3. („dołączenie do konta przenosi ustawienia z reguły”): reguła przeniesiona na inne konto zabiera
  //    swoje ustawienia, z którymi działała (config reguły z nałożonymi ustawieniami starego konta), do pól, których
  //    nowe konto nie ma, po regule z pkt 2. Bez pól z umowy konta (`zKontaPrzewoznika`: FID płatnika, środowisko
  //    kluczy): paczka nie może pójść kluczami nowego konta z płatnikiem starego; te trafiają do komunikatu.
  const definicja = (key: string | null, pole: string) => (key ? registry.get(key)?.manifest.config.find((f) => f.key === pole) : undefined)
  const zabraneZReguly = new Map<string, { przeniesione: string[]; doUzupelnienia: string[] }>()
  for (const r of nowe) {
    const id = kontoPo(r)
    const stara = przed.find((x) => x.id === r.id)
    if (!id || (stara && kontoPrzed(stara) === id)) continue
    const zrodlo = wgPriorytetu.find((x) => x.id !== r.id && kontoPrzed(x) === id && poZapisie.get(x.id) === id)
    if (zrodlo) dodajDoKonta(id, polaZReguly(zrodlo))
    if (!stara) continue
    const nowyKlucz = kluczReguly({ adapterKey: r.adapterKey ?? null, shippingModule: r.shippingModule })
    const staryKlucz = kluczReguly(stara)
    const stareId = kontoPrzed(stara)
    const dzialala = nalozUstawieniaKonta(polaZReguly(stara), stareId ? ustawienia[stareId] : undefined)
    const maNowe = new Set([...Object.keys(ustawienia[id] ?? {}), ...doKont.filter((d) => d.id === id).flatMap((d) => Object.keys(d.pola))])
    const pola: UstawieniaKonta = {}
    const wynik = { przeniesione: [] as string[], doUzupelnienia: [] as string[] }
    for (const k of nowyKlucz ? polaKontaManifestu(registry.get(nowyKlucz)!.manifest) : []) {
      const v = dzialala[k] as UstawieniaKonta[string] | undefined
      const f = definicja(nowyKlucz, k)!
      if (v === undefined || v === null || v === '' || maNowe.has(k)) continue
      // wartość musi pasować do pola nowego modułu (inny przewoźnik może mieć pole o tej samej nazwie
      // z innym typem, wzorcem albo listą wartości); niepasująca nie przechodzi i trafia do komunikatu
      const pasuje = typeof v === f.type && (!f.pattern || f.pattern.test(String(v))) && (!f.options || f.options.some((o) => o.value === v))
      if (!pasuje) {
        wynik.doUzupelnienia.push(krotkiOpis(f.description))
        continue
      }
      if (f.zKontaPrzewoznika || definicja(staryKlucz, k)?.zKontaPrzewoznika) wynik.doUzupelnienia.push(krotkiOpis(f.description))
      else {
        pola[k] = v
        wynik.przeniesione.push(krotkiOpis(f.description))
      }
    }
    dodajDoKonta(id, pola)
    zabraneZReguly.set(r.id!, wynik)
  }
  // reguły istniejące przeniesione na inne konto (do komunikatu: co przeszło, co uzupełnić, nadawanie do włączenia)
  const przeniesione: RegulaPrzeniesiona[] = nowe.flatMap((r, i) => {
    if (!r.id || configPo(r) === null) return []
    const stara = przed.find((x) => x.id === r.id)
    const z = zabraneZReguly.get(r.id)
    return [{ nr: i + 1, konto: r.konto || null, adapterKey: r.adapterKey ?? null, nadawanieWylaczone: obj(stara?.config)['zapisWlaczony'] === true, przeniesionePola: z?.przeniesione ?? [], doUzupelnienia: z?.doUzupelnienia ?? [] }]
  })
  // serwer sam porównuje wiersze z bazą; ta sama lista = nic do zapisu i bez wpisu w historii.
  // porównanie kolejności (id po kolei), nie wartości priorytetu: priorytety z bazy nie muszą być
  // wielokrotnościami 10 (reguła wstawiona ręcznie, stary seed), a ta sama kolejność to ta sama lista.
  const posortowane = [...przed].sort((x, y) => x.priority - y.priority)
  const bezZmian =
    usuwane.length === 0 &&
    nowe.length === posortowane.length &&
    nowe.every((r, i) => {
      const b = posortowane[i]!
      return r.id === b.id && r.channel === b.channel && r.pattern === b.pattern && r.carrier === b.carrier && r.shippingModule === b.shippingModule && (r.adapterKey ?? null) === (b.adapterKey ?? null) && configPo(r) === null
    })
  if (bezZmian) return { reguly: nowe.length, zmienione: false, przeniesione: [] }
  await db.$transaction(async (tx) => {
    const przeniesioneUstawienia = await zmienUstawieniaKont(tx, organizationId, doKont, { tylkoBrakujace: true })
    if (przeniesioneUstawienia.length)
      await tx.auditLog.create({
        data: {
          entity: 'CarrierRule.config',
          entityId: organizationId,
          actorId,
          before: { konta: przeniesioneUstawienia.map((u) => ({ id: u.id, ustawienia: u.przed })) } as Prisma.InputJsonValue,
          after: { konta: przeniesioneUstawienia.map((u) => ({ id: u.id, ustawienia: u.po })), zRegul: true } as Prisma.InputJsonValue,
        },
      })
    const usun = usuwane.map((r) => r.id)
    if (usun.length) await tx.carrierRule.deleteMany({ where: { id: { in: usun } } })
    // unikalny (firma, priorytet): najpierw priorytety tymczasowe, potem docelowe
    let tmp = 1_000_000
    for (const r of nowe) if (r.id) await tx.carrierRule.update({ where: { id: r.id }, data: { priority: tmp++ } })
    for (const r of nowe) {
      const data = { priority: r.priority, channel: r.channel, pattern: r.pattern, carrier: r.carrier, shippingModule: r.shippingModule, adapterKey: r.adapterKey ?? null }
      const cfg = configPo(r)
      if (r.id) await tx.carrierRule.update({ where: { id: r.id }, data: { ...data, ...(cfg ? { config: cfg as Prisma.InputJsonValue } : {}) } })
      else await tx.carrierRule.create({ data: { organizationId, ...data, ...(r.konto ? { config: { sekretyKonta: r.konto } } : {}) } })
    }
    await tx.auditLog.create({
      data: {
        entity: 'CarrierRule',
        entityId: organizationId,
        actorId,
        // config tylko przy usuwanych regułach (z niego da się odtworzyć np. drugie konto przewoźnika); przy reszcie
        // zostaje w bazie bez zmian
        before: przed
          .sort((a, b) => a.priority - b.priority)
          .map(({ config, ...r }) => (!zostaja.has(r.id) && opisKonfiguracji(config) ? { ...r, config } : r)) as Prisma.InputJsonValue,
        after: nowe.map(({ konto, ...r }) => ({ ...r, adapterKey: r.adapterKey ?? null, ...(konto !== undefined ? { konto: konto || null } : {}) })) as Prisma.InputJsonValue,
      },
    })
  })
  return { reguly: nowe.length, zmienione: true, przeniesione }
}

/** Podgląd „ten sposób dostawy → ta reguła” na sposobach dostawy z ostatnich zamówień firmy. */
export async function testRegul(db: PrismaClient, limit = 300): Promise<{ channel: Channel; metoda: string; zamowien: number; regula: number | null; carrier: Carrier | null }[]> {
  organizationIdOf(db)
  const [orders, rules] = await Promise.all([
    db.order.findMany({ orderBy: { createdAtChannel: 'desc' }, take: limit, select: { channel: true, deliveryMethod: true } }),
    db.carrierRule.findMany({ orderBy: { priority: 'asc' }, select: { priority: true, channel: true, pattern: true, carrier: true } }),
  ])
  const grupy = new Map<string, { channel: Channel; metoda: string; zamowien: number }>()
  for (const o of orders) {
    const metoda = o.deliveryMethod ?? ''
    const k = `${o.channel}\u0000${metoda}`
    const g = grupy.get(k) ?? { channel: o.channel, metoda, zamowien: 0 }
    g.zamowien++
    grupy.set(k, g)
  }
  return [...grupy.values()]
    .sort((a, b) => b.zamowien - a.zamowien)
    .slice(0, 30)
    .map((g) => {
      const r = dopasowanaRegula(rules, g.channel, g.metoda)
      const nr = r ? rules.indexOf(r) + 1 : null
      return { ...g, regula: nr, carrier: r?.carrier ?? null }
    })
}
