// Konta przewoźników z panelu: klucze przewoźnika (sekrety firmy z manifestu adaptera,
// szyfrowane jak klucze kanałów), ustawienia konta (pola `config` z manifestu, zapisywane do wszystkich reguł
// przewoźnika, które używają tego konta), wyłącznik nadawania i test połączenia zlecany do kolejki zadań.
//
// Konto = jeden zestaw kluczy: adaptery o tych samych nazwach sekretów (np. DPD odczyt i DPD z tworzeniem przesyłek)
// dzielą konto, a reguła z `config.sekretyKonta` (np. EMPIK) wskazuje drugie konto tego samego przewoźnika.
// Wysyłam z Allegro nie ma tu konta: korzysta z konta Allegro w Kanałach sprzedaży.
// Wartości kluczy nigdy nie wracają do panelu ani do logów: panel widzi tylko „ustawiony / brak”.
// drugie konto tego samego przewoźnika dodaje się z panelu („Dodaj konto”: nazwa → sufiks kluczy, zapis
// w `settings.przewoznicy.konta`), a reguła wskazuje je kolumną „Konto” na ekranie Przewoźnicy (`config.sekretyKonta`).
// Konto istnieje, gdy jest na tej liście, ma zapisany klucz z sufiksem albo wskazuje je reguła. Klucz ustawiony w
// konfiguracji serwera (self-host, env) to trzeci stan „z konfiguracji serwera”, test połączenia działa też z nim.
import type { Prisma, PrismaClient } from '@prisma/client'
import type { AdapterManifest, ConfigField } from '../adaptery/kontrakt'
import type { AdapterRegistry } from '../adaptery/rejestr'
import { appModeOf, organizationIdOf } from '../db'
import { komunikatBledu, komunikatTekstu } from '../kanaly/zadania'
import { listSecrets, setSecret, type Env, type SecretSource } from '../sekrety'
import { enqueue } from '../worker/kolejka'
import { guardedFetch } from '../kanaly/adres'
import type { FetchLike } from '../zrodla/http'
import { adapterPrzewoznika, kluczReguly, SEKRETY_KONTA_RE } from './adapter-przewoznika'
import { kluczPrzewoznika, wynikWlaczenia, zlecWlaczenie } from '../integracje/zdrowie'

export const PRZEWOZNIK_TEST_JOB = 'przewoznik-test'
const LIMIT_TESTU_MS = 30_000

/** Pola konfiguracji, których panel nie pokazuje: ustawia je host albo self-host (env), nie osoba w panelu. */
export const POLA_UKRYTE = new Set(['envPrefix', 'baseUrl', 'nadawca', 'sekretyKonta', 'zapisWlaczony'])

export class KontoPrzewoznikaError extends Error {}

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

export interface KontoPrzewoznika {
  /** `<rodzina>` albo `<rodzina>~<SUFIKS>` (drugie konto) */
  id: string
  nazwa: string
  sufiks: string | null
  /** klucz adaptera odczytu (do testu połączenia bez reguły) */
  adapterKey: string
  /** `zrodlo`: zapisany w panelu (szyfrowany w bazie), z konfiguracji serwera (env, tylko self-host) albo brak */
  sekrety: { name: string; nazwa: string; opis: string; wymagany: boolean; ustawiony: boolean; zrodlo: 'panel' | 'serwer' | null }[]
  pola: { key: string; opis: string; typ: ConfigField['type']; wymagane: boolean; opcje?: readonly { value: string; label: string }[]; wartosc: string }[]
  reguly: { id: string; priority: number; carrier: string; adapterKey: string | null; nadawanie: boolean | null }[]
  test: { ok: boolean; message: string; at: string } | null
  /** id konta głównego tej rodziny (np. `dpd`); dla konta głównego = `id` */
  glowne: string
  /** klucze adapterów (moduły wysyłki), które korzystają z tego konta */
  moduly: string[]
}

/** Drugie konto dodane z panelu (`settings.przewoznicy.konta`). */
interface KontoDodane {
  konto: string
  sufiks: string
  nazwa: string
}

function kontaDodane(settings: unknown): KontoDodane[] {
  const lista = asObject(asObject(settings)['przewoznicy'])['konta']
  if (!Array.isArray(lista)) return []
  return lista.flatMap((x) => {
    const o = asObject(x)
    return typeof o['konto'] === 'string' && typeof o['sufiks'] === 'string' && SEKRETY_KONTA_RE.test(o['sufiks']) && typeof o['nazwa'] === 'string' ? [{ konto: o['konto'], sufiks: o['sufiks'], nazwa: o['nazwa'] }] : []
  })
}

/** Sufiks kluczy z nazwy konta: wielkie litery bez polskich znaków i cyfry, najwyżej 16, pierwszy znak to litera. */
export function sufiksZNazwy(nazwa: string): string {
  const s = nazwa
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
  const z = /^[A-Z]/.test(s) ? s : `K${s}`
  return z.slice(0, 16) || 'K'
}

/** Rodzina konta: nazwy sekretów adaptera (posortowane). Adaptery bez sekretów i Wysyłam z Allegro — bez konta. */
function rodzina(m: AdapterManifest): string | null {
  if (m.kind !== 'carrier' || !m.secrets.length || m.adapterKey.startsWith('allegro.')) return null
  return m.secrets.map((s) => s.name).sort().join(',')
}

const nazwaSekretu = (s: { name: string; description: string }) => s.description.charAt(0).toUpperCase() + s.description.slice(1)

/** Manifest wzorcowy rodziny: wersja odczytu (bez tworzenia przesyłek), inaczej pierwszy. */
function wzorce(registry: AdapterRegistry): Map<string, AdapterManifest> {
  const out = new Map<string, AdapterManifest>()
  for (const m of registry.list()) {
    const r = rodzina(m)
    if (!r) continue
    const cur = out.get(r)
    if (!cur || (!cur.readOnly && m.readOnly)) out.set(r, m)
  }
  return out
}

const idKonta = (r: string, sufiks: string | null, nazwy: Map<string, string>) => `${nazwy.get(r)}${sufiks ? `~${sufiks}` : ''}`
const krotka = (m: AdapterManifest) => m.adapterKey.split('.')[0]!

/**
 * Konta przewoźników firmy. `serwer`: env procesu i czy firma może z niego brać klucze (self-host jednej firmy,
 * jak `envSecretsAllowed`); bez tego klucze z env nie są widoczne (stan „brak”).
 */
/** Źródło kluczy dla ekranów panelu: env procesu web, fallback na env tylko w self-hoście (jak firmaMaBlWPanelu). */
export function zrodloKluczyPanelu(env: Env = process.env): SecretSource {
  return { env, envFallback: appModeOf(env) === 'self-host' }
}

export async function kontaPrzewoznikow(db: PrismaClient, registry: AdapterRegistry, serwer?: SecretSource): Promise<KontoPrzewoznika[]> {
  organizationIdOf(db)
  const wz = wzorce(registry)
  const nazwyRodzin = new Map([...wz].map(([r, m]) => [r, krotka(m)]))
  const rodzinaKonta = new Map([...nazwyRodzin].map(([r, id]) => [id, r]))
  // moduły wysyłki każdej rodziny (do kolumny „Konto” w regułach)
  const modulyRodzin = new Map<string, string[]>()
  for (const m of registry.list()) {
    const r = rodzina(m)
    if (r) modulyRodzin.set(r, [...(modulyRodzin.get(r) ?? []), m.adapterKey])
  }
  const [rules, sekrety, org] = await Promise.all([
    db.carrierRule.findMany({ orderBy: { priority: 'asc' }, select: { id: true, priority: true, carrier: true, shippingModule: true, adapterKey: true, config: true } }),
    listSecrets(db),
    db.organization.findFirst({ select: { settings: true } }),
  ])
  const ustawione = new Set(sekrety.filter((s) => !s.channel).map((s) => s.name))
  const zEnv = (name: string) => !!serwer?.envFallback && !!serwer.env[name]?.trim()
  const testy = asObject(asObject(asObject(org?.settings)['przewoznicy'])['testy'])
  const dodane = kontaDodane(org?.settings)
  const konta = new Map<string, KontoPrzewoznika>()
  const dodaj = (r: string, sufiks: string | null, nazwaKonta?: string): KontoPrzewoznika => {
    const id = idKonta(r, sufiks, nazwyRodzin)
    let k = konta.get(id)
    if (!k) {
      const m = wz.get(r)!
      const t = asObject(testy[id])
      const opisKonta = nazwaKonta ?? dodane.find((d) => d.konto === nazwyRodzin.get(r) && d.sufiks === sufiks)?.nazwa ?? sufiks
      k = {
        id,
        nazwa: `${m.displayName.replace(/\s*\(.*\)\s*$/, '')}${sufiks ? ` (konto ${opisKonta})` : ''}`,
        sufiks,
        adapterKey: m.adapterKey,
        sekrety: m.secrets.map((s) => {
          const name = sufiks ? `${s.name}_${sufiks}` : s.name
          const zrodlo = ustawione.has(name) ? ('panel' as const) : zEnv(name) ? ('serwer' as const) : null
          return { name: s.name, nazwa: nazwaSekretu(s), opis: s.description, wymagany: s.required, ustawiony: zrodlo !== null, zrodlo }
        }),
        pola: [],
        reguly: [],
        test: typeof t['message'] === 'string' && typeof t['at'] === 'string' ? { ok: t['ok'] === true, message: t['message'], at: t['at'] } : null,
        glowne: nazwyRodzin.get(r)!,
        moduly: modulyRodzin.get(r) ?? [],
      }
      konta.set(id, k)
    }
    return k
  }
  for (const r of wz.keys()) dodaj(r, null)
  // konta dodane z panelu i konta, które mają zapisany klucz z sufiksem (np. sprzed panelu: DPD_LOGIN_EMPIK)
  for (const d of dodane) {
    const r = rodzinaKonta.get(d.konto)
    if (r) dodaj(r, d.sufiks, d.nazwa)
  }
  const bazowe = new Set(registry.list().flatMap((m) => m.secrets.map((x) => x.name)))
  for (const [r, m] of wz) {
    for (const name of ustawione) {
      if (bazowe.has(name)) continue
      for (const sec of m.secrets) {
        const suf = name.startsWith(`${sec.name}_`) ? name.slice(sec.name.length + 1) : null
        if (suf && SEKRETY_KONTA_RE.test(suf)) dodaj(r, suf)
      }
    }
  }
  for (const rule of rules) {
    const key = kluczReguly(rule)
    const def = key ? registry.get(key) : undefined
    const r = def ? rodzina(def.manifest) : null
    if (!def || !r) continue
    const cfg = asObject(rule.config)
    const sufiks = typeof cfg['sekretyKonta'] === 'string' && SEKRETY_KONTA_RE.test(cfg['sekretyKonta']) ? cfg['sekretyKonta'] : null
    const k = dodaj(r, sufiks)
    const maWylacznik = def.manifest.config.some((f) => f.key === 'zapisWlaczony')
    k.reguly.push({ id: rule.id, priority: rule.priority, carrier: rule.carrier, adapterKey: key, nadawanie: maWylacznik ? cfg['zapisWlaczony'] === true : null })
    // pola konta: suma pól adapterów reguł (wersja z zapisem ma ich więcej), wartości z pierwszej reguły
    for (const f of def.manifest.config) {
      if (POLA_UKRYTE.has(f.key) || k.pola.some((p) => p.key === f.key)) continue
      const v = cfg[f.key]
      k.pola.push({ key: f.key, opis: f.description, typ: f.type, wymagane: f.required, ...(f.options ? { opcje: f.options } : {}), wartosc: v === undefined || v === null ? '' : String(v) })
    }
  }
  // konto bez reguł: pola z manifestu wzorcowego (puste)
  for (const k of konta.values()) {
    if (k.reguly.length) continue
    const m = registry.get(k.adapterKey)!.manifest
    k.pola = m.config.filter((f) => !POLA_UKRYTE.has(f.key)).map((f) => ({ key: f.key, opis: f.description, typ: f.type, wymagane: f.required, ...(f.options ? { opcje: f.options } : {}), wartosc: '' }))
  }
  return [...konta.values()].sort((a, b) => Number(b.reguly.length > 0) - Number(a.reguly.length > 0) || a.nazwa.localeCompare(b.nazwa, 'pl'))
}

export interface ZapisKonta {
  id: string
  /** nowe wartości kluczy (puste = bez zmiany) */
  sekrety: Record<string, string>
  /** pola konfiguracji konta (puste = usunięcie z konfiguracji) */
  pola: Record<string, string>
  /** wyłącznik nadawania per reguła (tylko reguły z adapterem, który go ma) */
  nadawanie: Record<string, boolean>
}

/**
 * Zapis ekranu kont: klucze (tylko wpisane), pola konfiguracji do każdej reguły konta (walidacja typu i wzorca
 * z manifestu), wyłączniki nadawania. Najpierw cała walidacja, potem zapis; zmiana konfiguracji w AuditLog
 * (bez wartości kluczy). Zwraca liczbę zapisanych kluczy i zmienionych reguł.
 */
export async function zapiszKontaPrzewoznikow(db: PrismaClient, registry: AdapterRegistry, zmiany: ZapisKonta[], o: { actorId: string; env: Env }): Promise<{ klucze: number; reguly: number }> {
  const konta = await kontaPrzewoznikow(db, registry)
  const plan: { ruleId: string; config: Record<string, unknown>; before: Record<string, unknown> }[] = []
  const sekrety: { name: string; value: string }[] = []
  const rules = new Map((await db.carrierRule.findMany({ select: { id: true, config: true } })).map((r) => [r.id, asObject(r.config)]))
  for (const z of zmiany) {
    const k = konta.find((x) => x.id === z.id)
    if (!k) throw new KontoPrzewoznikaError('Nie ma takiego konta przewoźnika — odśwież stronę')
    for (const [name, value] of Object.entries(z.sekrety)) {
      const v = value.trim()
      if (!v) continue
      if (!k.sekrety.some((s) => s.name === name)) throw new KontoPrzewoznikaError(`${k.nazwa}: nieznany klucz`)
      if (v.length > 8192) throw new KontoPrzewoznikaError(`${k.nazwa}: klucz za długi`)
      sekrety.push({ name: k.sufiks ? `${name}_${k.sufiks}` : name, value: v })
    }
    for (const r of k.reguly) {
      const cur = rules.get(r.id) ?? {}
      const next: Record<string, unknown> = { ...cur }
      const def = r.adapterKey ? registry.get(r.adapterKey) : undefined
      for (const p of k.pola) {
        if (!(p.key in z.pola)) continue
        const f = def?.manifest.config.find((x) => x.key === p.key)
        if (!f) continue // tej regule pole nie służy (np. FID płatnika Empik w wersji odczytu)
        const raw = z.pola[p.key]!.trim()
        if (!raw) {
          delete next[p.key]
          continue
        }
        if (f.type === 'number') {
          const n = Number(raw.replace(',', '.'))
          if (!Number.isFinite(n)) throw new KontoPrzewoznikaError(`${k.nazwa}: „${f.description}” musi być liczbą`)
          next[p.key] = n
        } else if (f.type === 'boolean') next[p.key] = raw === 'tak' || raw === 'true'
        else {
          if (f.pattern && !f.pattern.test(raw)) throw new KontoPrzewoznikaError(`${k.nazwa}: „${f.description}” ma zły format`)
          if (f.options && !f.options.some((x) => x.value === raw)) throw new KontoPrzewoznikaError(`${k.nazwa}: „${f.description}” spoza listy`)
          next[p.key] = raw
        }
      }
      if (r.nadawanie !== null && r.id in z.nadawanie) {
        if (z.nadawanie[r.id]) next['zapisWlaczony'] = true
        else delete next['zapisWlaczony']
      }
      if (JSON.stringify(next) !== JSON.stringify(cur)) plan.push({ ruleId: r.id, config: next, before: cur })
    }
  }
  // klucze przez setSecret (szyfrowanie, RLS); konfiguracja w jednej transakcji z AuditLog
  for (const s of sekrety) await setSecret(db, s.name, s.value, o.env)
  if (plan.length || sekrety.length) {
    await db.$transaction(async (tx) => {
      for (const p of plan) await tx.carrierRule.update({ where: { id: p.ruleId }, data: { config: p.config as Prisma.InputJsonValue } })
      await tx.auditLog.create({
        data: {
          entity: 'CarrierRule.config',
          entityId: organizationIdOf(db),
          actorId: o.actorId,
          before: { reguly: plan.map((p) => ({ id: p.ruleId, config: p.before })) } as Prisma.InputJsonValue,
          after: { reguly: plan.map((p) => ({ id: p.ruleId, config: p.config })), klucze: sekrety.map((s) => s.name) } as Prisma.InputJsonValue,
        },
      })
    })
  }
  return { klucze: sekrety.length, reguly: plan.length }
}

/**
 * „Dodaj konto”: drugie konto przewoźnika z nazwą od osoby (np. „Salony Empik”). Sufiks kluczy z nazwy
 * (`sufiksZNazwy`), przy zajętym kolejny z cyfrą. Zapis w `settings.przewoznicy.konta` pod blokadą wiersza firmy,
 * ślad w AuditLog. Klucze wpisuje się potem w karcie konta, a reguła wybiera konto w kolumnie „Konto”.
 */
export async function dodajKontoPrzewoznika(db: PrismaClient, registry: AdapterRegistry, d: { konto: string; nazwa: string }, actorId: string): Promise<KontoDodane> {
  const organizationId = organizationIdOf(db)
  const nazwa = d.nazwa.trim().replace(/\s+/g, ' ')
  if (!nazwa || nazwa.length > 40) throw new KontoPrzewoznikaError('Nazwa konta: od 1 do 40 znaków, np. „Salony Empik”')
  const konta = await kontaPrzewoznikow(db, registry)
  const glowne = konta.find((k) => k.id === d.konto && !k.sufiks)
  if (!glowne) throw new KontoPrzewoznikaError('Wybierz przewoźnika z listy')
  const zajete = new Set(konta.filter((k) => k.glowne === glowne.id).map((k) => k.sufiks ?? ''))
  if (konta.some((k) => k.glowne === glowne.id && k.sufiks && k.nazwa.toLowerCase().endsWith(`(konto ${nazwa.toLowerCase()})`))) throw new KontoPrzewoznikaError(`Konto „${nazwa}” tego przewoźnika już jest`)
  const baza = sufiksZNazwy(nazwa)
  let sufiks = baza
  for (let n = 2; zajete.has(sufiks); n++) sufiks = `${baza.slice(0, 16 - String(n).length)}${n}`
  const nowe: KontoDodane = { konto: glowne.id, sufiks, nazwa }
  await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ settings: Prisma.JsonValue }[]>`SELECT settings FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`
    if (!rows[0]) throw new Error('Brak firmy klienta')
    const s = asObject(rows[0].settings)
    const p = asObject(s['przewoznicy'])
    const lista = kontaDodane(s)
    if (lista.some((x) => x.konto === nowe.konto && x.sufiks === nowe.sufiks)) throw new KontoPrzewoznikaError('To konto zostało przed chwilą dodane — odśwież stronę')
    const po = [...lista, nowe]
    await tx.organization.update({ where: { id: organizationId }, data: { settings: { ...s, przewoznicy: { ...p, konta: po } } as unknown as Prisma.InputJsonValue } })
    await tx.auditLog.create({ data: { entity: 'Organization.przewoznicy.konta', entityId: organizationId, actorId, before: lista as unknown as Prisma.InputJsonValue, after: po as unknown as Prisma.InputJsonValue } })
  })
  return nowe
}

/**
 * Sufiksy kont, które zostają bez reguł (dodane z panelu albo z zapisanym kluczem): reguła wskazująca takie konto da
 * się odtworzyć z panelu (kolumna „Konto”), więc jej usunięcie nie wymaga potwierdzenia.
 */
export async function sufiksyKontTrwalych(db: PrismaClient, registry: AdapterRegistry): Promise<Set<string>> {
  const [org, sekrety] = await Promise.all([db.organization.findFirst({ select: { settings: true } }), listSecrets(db)])
  const out = new Set(kontaDodane(org?.settings).map((d) => d.sufiks))
  const nazwy = new Set(registry.list().flatMap((m) => (rodzina(m) ? m.secrets.map((s) => s.name) : [])))
  const bazowe = new Set(registry.list().flatMap((m) => m.secrets.map((x) => x.name)))
  for (const s of sekrety) {
    if (s.channel || bazowe.has(s.name)) continue
    for (const n of nazwy) if (s.name.startsWith(`${n}_`) && SEKRETY_KONTA_RE.test(s.name.slice(n.length + 1))) out.add(s.name.slice(n.length + 1))
  }
  return out
}

/** „Sprawdź połączenie”: zadanie w kolejce (worker woła przewoźnika). Drugie kliknięcie w ciągu 30 s = ZA_CZESTO. */
export async function zlecTestKonta(db: PrismaClient, registry: AdapterRegistry, id: string, now = new Date()): Promise<'ZLECONO' | 'ZA_CZESTO'> {
  const k = (await kontaPrzewoznikow(db, registry)).find((x) => x.id === id)
  if (!k) throw new KontoPrzewoznikaError('Nie ma takiego konta przewoźnika — odśwież stronę')
  // ostatni wynik sprzed < 30 s albo test jeszcze w kolejce (dedupeKey) = nic nowego
  if (k.test && now.getTime() - Date.parse(k.test.at) < LIMIT_TESTU_MS) return 'ZA_CZESTO'
  if (await db.job.count({ where: { kind: PRZEWOZNIK_TEST_JOB, dedupeKey: `${PRZEWOZNIK_TEST_JOB}:${id}` } })) return 'ZA_CZESTO'
  await enqueue(db, PRZEWOZNIK_TEST_JOB, { konto: id }, { dedupeKey: `${PRZEWOZNIK_TEST_JOB}:${id}`, maxAttempts: 1 })
  return 'ZLECONO'
}

/**
 * „Włącz ponownie” konta przewoźnika wyłączonego po błędach: test połączenia w kolejce z `wlacz: true`.
 * false = konto nie jest wyłączone (nic nie zlecone).
 */
export async function zlecWlaczenieKontaPrzewoznika(db: PrismaClient, registry: AdapterRegistry, id: string, now = new Date()): Promise<boolean> {
  const k = (await kontaPrzewoznikow(db, registry)).find((x) => x.id === id)
  if (!k) throw new KontoPrzewoznikaError('Nie ma takiego konta przewoźnika — odśwież stronę')
  if (!(await zlecWlaczenie(db, kluczPrzewoznika(id), now))) return false
  await enqueue(db, PRZEWOZNIK_TEST_JOB, { konto: id, wlacz: true }, { dedupeKey: `${PRZEWOZNIK_TEST_JOB}:${id}:wlacz`, maxAttempts: 1 })
  return true
}

/** Handler zadania: test połączenia adaptera konta; wynik w ustawieniach firmy (`settings.przewoznicy.testy`). */
export async function wykonajTestKonta(db: PrismaClient, payload: unknown, deps: { registry: AdapterRegistry; secrets: SecretSource; fetch?: FetchLike; now?: () => Date }): Promise<{ ok: boolean; message: string } | null> {
  const id = asObject(payload)['konto']
  if (typeof id !== 'string') return null
  const k = (await kontaPrzewoznikow(db, deps.registry, deps.secrets)).find((x) => x.id === id)
  if (!k) return null
  const now = (deps.now ?? (() => new Date()))()
  const rule = k.reguly[0] ? await db.carrierRule.findUnique({ where: { id: k.reguly[0].id }, select: { id: true, carrier: true, shippingModule: true, config: true } }) : null
  // „Włącz ponownie” — test przechodzi przez wyłączone konto, wynik decyduje o włączeniu
  const wlacz = asObject(payload)['wlacz'] === true
  let ok = false
  let message: string
  let krok = 'Konfiguracja przewoźnika'
  try {
    const adapter = await adapterPrzewoznika(
      db,
      { id: rule?.id ?? 'test', carrier: rule?.carrier ?? 'BRAK', shippingModule: rule?.shippingModule ?? 'BRAK', adapterKey: k.adapterKey, config: { ...asObject(rule?.config), ...(k.sufiks ? { sekretyKonta: k.sufiks } : {}) } },
      deps.registry,
      deps.secrets,
      { fetch: deps.fetch ?? guardedFetch(deps.secrets.env), now: deps.now, ...(wlacz ? { oslona: { pomijajWylaczenie: true } } : {}) },
    )
    krok = 'Test połączenia'
    const r = await adapter.testConnection()
    ok = r.ok
    message = r.ok ? 'Połączenie działa.' : komunikatTekstu(r.message)
  } catch (e) {
    message = komunikatBledu(e)
  }
  // odczyt i zapis ustawień pod blokadą wiersza firmy, żeby równoległy zapis (inny test, panel)
  // nie nadpisał zmian read-modify-write
  const organizationId = organizationIdOf(db)
  try {
    await db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; settings: Prisma.JsonValue }[]>`SELECT id, settings FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`
      const org = rows[0]
      if (!org) return
      const s = asObject(org.settings)
      const p = asObject(s['przewoznicy'])
      const testy = { ...asObject(p['testy']), [id]: { ok, message, at: now.toISOString() } }
      await tx.organization.update({ where: { id: org.id }, data: { settings: { ...s, przewoznicy: { ...p, testy } } as Prisma.InputJsonValue } })
    })
  } finally {
    // wynik „Włącz ponownie” zapisany także wtedy, gdy zapis wyniku testu padł (flaga zawsze zdjęta)
    if (wlacz) await wynikWlaczenia(db, kluczPrzewoznika(id), ok ? { ok: true } : { ok: false, krok, komunikat: message }, now)
  }
  return { ok, message }
}
