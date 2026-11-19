// Przeprowadzka z BaseLinkera z panelu: klucz API BL, tryb próbny z raportem, decyzje (statusy,
// metody dostawy) w formularzu i import — bez terminala. Ta sama logika co polecenie `npm run przeprowadzka`
// (`zbierz` + `uruchomPrzeprowadzke`), więc tryb próbny z panelu daje ten sam raport co CLI. Panel tylko zleca zadanie
// workera (BL woła worker, nie akcja serwera); przebieg panelu to ImportRun `PRZEPROWADZKA_PANEL` ze streszczeniem
// raportu w `stats` (bez danych klientów: raport ich nie ma). Zapis do bazy robi `zapiszPrzeprowadzke` (własny przebieg
// `PRZEPROWADZKA`, ekran „Ostatni zapis”). W BaseLinkerze nic się nie zmienia (klient BL przeprowadzki: tylko get*).
import type { Prisma, PrismaClient } from '@prisma/client'
import { Carrier, OrderStatus } from '@prisma/client'
import type { AdapterRegistry } from '../adaptery/rejestr'
import { NonRetryableError } from '../bledy'
import { organizationIdOf } from '../db'
import { przejscieZakonczone } from '../kanaly/firma'
import { parseOrgSettings } from '../organizacje'
import { WFIRMA_KEYS } from '../konfiguracja'
import { DEFAULT_WAREHOUSE } from '../rdzen/stan'
import { deleteSecret, resolveSecrets, type SecretSource, setSecret } from '../sekrety'
import { enqueue } from '../worker/kolejka'
import { WfirmaReadOnly } from '../zrodla/wfirma'
import { BlPrzeprowadzka } from './metody'
import { powodDlaEkranu } from './powody-ekran'
import { KATALOG_WYBRANY_BRAK, zbierz } from './przebieg'
import type { RaportJson } from './raport'
import { type MapaCzlowieka, parseMapa, PUSTA_MAPA, ZlaMapa } from './statusy'
import { uruchomPrzeprowadzke } from './uruchomienie'
import { KONTO_POZA_PODGLADEM, OdmowaZapisu, PRZEPROWADZKA_ZAPISANA, RODZAJ_PRZEBIEGU } from './zapis'

export const PRZEPROWADZKA_JOB = 'przeprowadzka-panel'
export const RODZAJ_PANELU = 'PRZEPROWADZKA_PANEL'
export const TOKEN_BL = 'BASELINKER_TOKEN'
/** Ile pozycji list do decyzji trzymamy w streszczeniu (pełna lista: polecenie z raportem na dysku). */
export const LIMIT_POZYCJI = 200
/** Odmowa importu po znaczniku „przejście zakończone”. */
export const ODMOWA_PO_ZAKONCZENIU = 'Przejście z BaseLinkera jest oznaczone jako zakończone, więc import nic nie zapisze. Żeby importować jeszcze raz, cofnij to oznaczenie (sekcja „5. Koniec przejścia”).'

type Json = Record<string, Prisma.JsonValue>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

export class PrzeprowadzkaError extends Error {}

/** Streszczenie raportu w ImportRun.stats (to czyta ekran). */
export interface Streszczenie {
  tryb: 'PROBNY' | 'ZAPIS'
  katalog: RaportJson['katalog']
  coPrzejdzie: Record<string, number>
  powodyOdmowy: string[]
  statusy: RaportJson['doDecyzji']['statusy']
  przewoznicy: RaportJson['doDecyzji']['przewoznicy']
  liczbyDoDecyzji: Record<string, number>
  problemyPobierania: number
  zapisRunId: string | null
  /** katalogi produktów BL (wybór katalogu w „Decyzjach”). Brak w streszczeniach sprzed zmiany. */
  katalogi?: RaportJson['katalogiBl']
  /** źródła zamówień BL z kontem Kompletora (decyzja „pomiń źródło”). */
  zrodla?: { zrodlo: string; nazwa: string; kanal: string; pominiete: boolean }[]
  /** zapisany wybór katalogu, którego nie ma w BL (przebieg wziął domyślny). */
  uwagaKatalogu?: string | null
  /** listy spraw (pierwsze `LIMIT_POZYCJI`; całość w raporcie do pobrania). */
  listy?: Pick<RaportJson['doDecyzji'], 'ofertyBezPowiazania' | 'produktyBezSku' | 'zestawy' | 'zamowieniaDoWyjasnienia' | 'zrodlaBezAdaptera'>
  /** statusy BL jako statusy firmy i automaty z najbliższego szablonu (pierwsze `LIMIT_POZYCJI` statusów). */
  importStatusow?: RaportJson['importStatusow']
}

export function parseStreszczenie(v: Prisma.JsonValue | null | undefined): Streszczenie | null {
  if (!isObj(v) || (v['tryb'] !== 'PROBNY' && v['tryb'] !== 'ZAPIS') || !isObj(v['coPrzejdzie'])) return null
  return v as unknown as Streszczenie
}

export function streszczenie(r: RaportJson, zapisRunId: string | null): Streszczenie {
  const d = r.doDecyzji
  return {
    tryb: r.tryb,
    katalog: r.katalog,
    coPrzejdzie: r.coPrzejdzie,
    // tekst powodów jest wspólny z poleceniem; na ekranie decyzje wpisuje się w formularzu, nie w pliku mapy
    powodyOdmowy: r.powodyOdmowy.slice(0, LIMIT_POZYCJI).map((p) => p.replace(/ — wpisz decyzję w pliku mapy \(--mapa\)/g, ": wybierz status w sekcji „Decyzje”")),
    statusy: d.statusy.slice(0, LIMIT_POZYCJI),
    przewoznicy: d.przewoznicy.slice(0, LIMIT_POZYCJI),
    liczbyDoDecyzji: {
      zrodlaBezAdaptera: d.zrodlaBezAdaptera.length,
      ofertyBezPowiazania: d.ofertyBezPowiazania.length,
      produktyBezSku: d.produktyBezSku.length,
      produktyBezEan: d.produktyBezEan,
      zestawy: d.zestawy.length,
      zamowieniaDoWyjasnienia: d.zamowieniaDoWyjasnienia.length,
      rozniceStanow: d.rozniceStanow.length,
    },
    problemyPobierania: r.problemyPobierania.length,
    zapisRunId,
    katalogi: (r.katalogiBl ?? []).slice(0, LIMIT_POZYCJI),
    uwagaKatalogu: r.problemyPobierania.find((p) => p.kind === KATALOG_WYBRANY_BRAK)?.message ?? null,
    zrodla: r.konta.slice(0, LIMIT_POZYCJI).map((k) => ({ zrodlo: k.zrodlo, nazwa: k.nazwa, kanal: k.kanal, pominiete: k.pominiete })),
    listy: {
      ofertyBezPowiazania: d.ofertyBezPowiazania.slice(0, LIMIT_POZYCJI),
      produktyBezSku: d.produktyBezSku.slice(0, LIMIT_POZYCJI),
      zestawy: d.zestawy.slice(0, LIMIT_POZYCJI),
      zamowieniaDoWyjasnienia: d.zamowieniaDoWyjasnienia.slice(0, LIMIT_POZYCJI),
      zrodlaBezAdaptera: d.zrodlaBezAdaptera.slice(0, LIMIT_POZYCJI),
    },
    ...(r.importStatusow ? { importStatusow: { ...r.importStatusow, statusy: r.importStatusow.statusy.slice(0, LIMIT_POZYCJI) } } : {}),
  }
}

/** Najdłuższy raport Markdown, jaki trzymamy w bazie (znaki); dłuższy jest ucinany z dopiskiem. */
export const MAX_RAPORTU = 2_000_000

export function raportDoBazy(md: string): string {
  return md.length <= MAX_RAPORTU ? md : `${md.slice(0, MAX_RAPORTU)}\n\n> Raport ucięty (ponad ${MAX_RAPORTU} znaków). Pełny raport zapisuje polecenie przeprowadzki administratora serwera.\n`
}

// ─── Mapa decyzji w ustawieniach firmy (settings.przeprowadzka.mapa) ─────────

export async function mapaFirmy(db: PrismaClient): Promise<MapaCzlowieka> {
  organizationIdOf(db)
  const org = await db.organization.findFirst({ select: { settings: true } })
  const p = isObj(org?.settings) && isObj(org.settings['przeprowadzka']) ? org.settings['przeprowadzka'] : null
  if (!p || p['mapa'] === undefined) return PUSTA_MAPA
  try {
    return parseMapa(p['mapa'])
  } catch {
    return PUSTA_MAPA // zła mapa w bazie (ręczna edycja) = jak bez decyzji; ekran zapisze poprawną
  }
}

/** Id katalogu BL wybrany na ekranie (`settings.przeprowadzka.katalog`); null = bez wyboru (jeden katalog). */
export async function katalogFirmy(db: PrismaClient): Promise<string | null> {
  organizationIdOf(db)
  const org = await db.organization.findFirst({ select: { settings: true } })
  const p = isObj(org?.settings) && isObj(org.settings['przeprowadzka']) ? org.settings['przeprowadzka'] : null
  const k = p?.['katalog']
  return typeof k === 'string' && KATALOG_RE.test(k) ? k : null
}

const KATALOG_RE = /^\d{1,12}$/
/** Klucz źródła BL w mapie (`<typ>:<id>`, jak `kontoDlaZrodla`): litery, cyfry, `_`, `-`, `.`. */
const ZRODLO_RE = /^[\w.-]{1,40}:[\w.:-]{1,80}$/

/**
 * Wybór katalogu z formularza (pole `katalog`). Brak pola = bez zmiany (`undefined`), puste = bez wyboru (`null`).
 */
export function katalogZFormularza(form: FormData): string | null | undefined {
  if (!form.has('katalog')) return undefined
  const v = String(form.get('katalog') ?? '').trim()
  if (!v) return null
  if (!KATALOG_RE.test(v)) throw new PrzeprowadzkaError('Nieznany katalog BaseLinkera.')
  return v
}

/**
 * Decyzje z formularza: `status:<id BL>` → status Kompletora, `przewoznik:<metoda>` → przewoźnik, `zrodlo:<typ:id>`
 * (pole ukryte, lista źródeł z ekranu) + `pomin:<typ:id>` (pole wyboru) → źródło pominięte. Puste = bez
 * decyzji. Źródła spoza formularza zostają, jak były.
 */
export function mapaZFormularza(form: FormData, poprzednia: MapaCzlowieka): MapaCzlowieka {
  const statusy: Record<string, OrderStatus> = { ...poprzednia.statusy }
  const przewoznicy: Record<string, Carrier> = { ...poprzednia.przewoznicy }
  const ST = new Set<string>(Object.values(OrderStatus))
  const CA = new Set<string>(Object.values(Carrier))
  for (const [k, raw] of form.entries()) {
    if (typeof raw !== 'string') continue
    const v = raw.trim()
    if (k.startsWith('status:')) {
      const id = k.slice(7)
      if (!/^\d{1,12}$/.test(id)) continue
      if (!v) delete statusy[id]
      else if (ST.has(v)) statusy[id] = v as OrderStatus
      else throw new PrzeprowadzkaError(`Nieznany status „${v.slice(0, 40)}”.`)
    } else if (k.startsWith('przewoznik:')) {
      const metoda = k.slice(11).slice(0, 200)
      if (!metoda) continue
      if (!v) delete przewoznicy[metoda]
      else if (CA.has(v)) przewoznicy[metoda] = v as Carrier
      else throw new PrzeprowadzkaError(`Nieznany przewoźnik „${v.slice(0, 40)}”.`)
    }
  }
  const zrodla: Record<string, 'POMIN'> = { ...poprzednia.zrodla }
  const naEkranie = form.getAll('zrodlo').filter((v): v is string => typeof v === 'string')
  if (naEkranie.length > 1000) throw new PrzeprowadzkaError('Za dużo źródeł w formularzu.')
  const pomin = new Set(form.getAll('pomin').filter((v): v is string => typeof v === 'string'))
  for (const z of naEkranie) {
    if (!ZRODLO_RE.test(z)) throw new PrzeprowadzkaError('Nieznane źródło zamówień w formularzu.')
    if (pomin.has(z)) zrodla[z] = 'POMIN'
    else delete zrodla[z]
  }
  for (const z of pomin) if (!naEkranie.includes(z)) throw new PrzeprowadzkaError('Nieznane źródło zamówień w formularzu.')
  const mapa = { statusy, przewoznicy, zrodla }
  try {
    return parseMapa(mapa) // ten sam walidator co plik mapy polecenia
  } catch (e) {
    throw new PrzeprowadzkaError(e instanceof ZlaMapa ? e.message : 'Zła decyzja w formularzu.')
  }
}

/** JSON z kluczami obiektów posortowanymi (porównanie wartości z bazy jsonb z wartością z formularza). */
export function stabilnie(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stabilnie).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stabilnie((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v ?? null)
}

/**
 * Zapis decyzji (mapa) i wyboru katalogu (`katalog`: undefined = bez zmiany, null = bez wyboru). Jeden wpis
 * `Organization.przeprowadzka` w AuditLog na zmianę: po nim import wymaga nowego trybu próbnego (`zlecPrzeprowadzke`).
 */
export async function zapiszMapeFirmy(db: PrismaClient, mapa: MapaCzlowieka, actorId: string, katalog?: string | null): Promise<void> {
  const organizationId = organizationIdOf(db)
  await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ settings: Prisma.JsonValue }[]>`SELECT settings FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`
    if (!rows[0]) throw new Error('Brak firmy klienta')
    const settings: Json = isObj(rows[0].settings) ? rows[0].settings : {}
    const p: Json = isObj(settings['przeprowadzka']) ? settings['przeprowadzka'] : {}
    const przed = p['mapa'] ?? null
    const katalogPrzed = typeof p['katalog'] === 'string' ? p['katalog'] : null
    const katalogPo = katalog === undefined ? katalogPrzed : katalog
    // jsonb zmienia kolejność kluczy: porównanie po kluczach posortowanych (inaczej każdy zapis byłby „zmianą”)
    if (stabilnie(przed) === stabilnie(mapa) && katalogPrzed === katalogPo) return
    const { katalog: _k, ...reszta } = p
    const nowe: Json = { ...reszta, mapa: mapa as unknown as Prisma.JsonValue, ...(katalogPo ? { katalog: katalogPo } : {}) }
    await tx.organization.update({ where: { id: organizationId }, data: { settings: { ...settings, przeprowadzka: nowe } as unknown as Prisma.InputJsonValue } })
    const before = przed === null && katalogPrzed === null ? undefined : katalogPrzed === null ? przed : { ...(isObj(przed) ? przed : {}), katalog: katalogPrzed }
    const after = katalogPo === null ? mapa : { ...mapa, katalog: katalogPo }
    await tx.auditLog.create({ data: { entity: 'Organization.przeprowadzka', entityId: organizationId, actorId, before: (before ?? undefined) as Prisma.InputJsonValue | undefined, after: after as unknown as Prisma.InputJsonValue } })
  })
}

// ─── Klucz API BL ─────────────────────────────────────────────────────────────

/** Najdłuższy klucz API BL, jaki przyjmujemy (pole formularza ma ten sam limit). */
export const MAX_TOKEN_BL = 200

/**
 * Nazwy włączonych kont sklepów firmy poza podglądem (choć jedna część trybu inna niż CIEN). Definicja trybu wspólna
 * z zapisem przeprowadzki (`KONTO_POZA_PODGLADEM`); wyłączone konto nie blokuje klucza.
 */
export async function kontaWPracy(db: PrismaClient): Promise<string[]> {
  organizationIdOf(db)
  const rows = await db.channelConfig.findMany({
    where: { ...KONTO_POZA_PODGLADEM, active: true, channel: { notIn: ['RECZNE', 'AI'] } },
    select: { name: true },
    orderBy: { name: 'asc' },
  })
  return rows.map((r) => r.name)
}

/** Tekst odmowy zapisu klucza dla firmy z kontami w trybie pracy (ekran pokazuje go też przed zapisem). */
export const odmowaKluczaWPracy = (konta: string[]) =>
  `Firma prowadzi już zamówienia w Kompletorze (tryb pracy: ${konta.join(', ')}). Przeprowadzka z BaseLinkera jest dla firm, które dopiero przechodzą, i zapisuje tylko do kont w podglądzie. Jeśli chcesz przenieść dane z BaseLinkera, najpierw przełącz te konta na „Tylko podgląd” (Ustawienia → Sprzedaż i kanały → Kanały sprzedaży → konto → Stan konta).`

/**
 * Zapis klucza API BL firmy (szyfrowany sekret firmy). Klucz otwiera ekran przeprowadzki i menu „Przejście z BL”, ale
 * nie zmienia bramki trybu pracy (ta liczy ślad przejścia, `firmaPrzechodziZBl`). Firma z kontami
 * w trybie pracy dostaje odmowę: przeprowadzka i tak by ich nie przyjęła.
 */
export async function zapiszTokenBl(db: PrismaClient, token: string, actorId: string, env: Record<string, string | undefined>): Promise<void> {
  const t = token.trim()
  if (t.length < 10 || t.length > MAX_TOKEN_BL || /\s/.test(t)) throw new PrzeprowadzkaError('To nie wygląda na klucz API BaseLinkera (Moje konto → API w BaseLinkerze).')
  const praca = await kontaWPracy(db)
  if (praca.length) throw new PrzeprowadzkaError(odmowaKluczaWPracy(praca))
  await setSecret(db, TOKEN_BL, t, env)
  await db.auditLog.create({ data: { entity: 'IntegrationSecret', entityId: TOKEN_BL, actorId, after: { zapisany: true, zrodlo: 'panel' } } })
}

/** „Usuń klucz BaseLinkera”: kasuje sekret firmy (idempotentnie) z wpisem w historii zmian, bez wartości klucza. */
export async function usunTokenBl(db: PrismaClient, actorId: string): Promise<boolean> {
  const organizationId = organizationIdOf(db)
  const byl = await deleteSecret(db, TOKEN_BL)
  // wybór katalogu dotyczył konta BL tego klucza; następny klucz może być z innego konta
  await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ settings: Prisma.JsonValue }[]>`SELECT settings FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`
    const settings: Json = isObj(rows[0]?.settings) ? rows[0].settings : {}
    const p: Json = isObj(settings['przeprowadzka']) ? settings['przeprowadzka'] : {}
    if (p['katalog'] === undefined) return
    const { katalog: kat, ...reszta } = p
    await tx.organization.update({ where: { id: organizationId }, data: { settings: { ...settings, przeprowadzka: reszta } as unknown as Prisma.InputJsonValue } })
    await tx.auditLog.create({ data: { entity: 'Organization.przeprowadzka', entityId: organizationId, actorId, before: { katalog: kat ?? null }, after: { katalog: null, powod: 'usunięty klucz BaseLinkera' } } })
  })
  if (byl) await db.auditLog.create({ data: { entity: 'IntegrationSecret', entityId: TOKEN_BL, actorId, before: { zapisany: true }, after: { usuniety: true, zrodlo: 'panel' } } })
  return byl
}

export async function maTokenBl(db: PrismaClient): Promise<{ zapisany: boolean; zapisanyAt: Date | null }> {
  organizationIdOf(db)
  const s = await db.integrationSecret.findFirst({ where: { name: TOKEN_BL, channel: null }, select: { updatedAt: true } })
  return { zapisany: !!s, zapisanyAt: s?.updatedAt ?? null }
}

// ─── Zlecenie i wykonanie ─────────────────────────────────────────────────────

export interface StanPanelu {
  /** Przebieg zlecony albo w toku (drugie kliknięcie nic nie zleca). */
  wToku: { id: string; zapisz: boolean; start: Date } | null
  /** Ostatni zakończony tryb próbny (do niego odnosi się „Importuj”). */
  proba: WierszPanelu | null
  /** Ostatni zakończony import z panelu. */
  import: WierszPanelu | null
}

export interface WierszPanelu {
  id: string
  status: string
  start: Date
  koniec: Date | null
  blad: string | null
  s: Streszczenie | null
  /** Przebieg ma raport Markdown do pobrania. */
  raport: boolean
}

const wiersz = (r: { id: string; status: string; startedAt: Date; finishedAt: Date | null; error: string | null; stats: Prisma.JsonValue | null }, zRaportem: ReadonlySet<string>): WierszPanelu => ({
  id: r.id,
  status: r.status,
  start: r.startedAt,
  koniec: r.finishedAt,
  blad: r.error,
  s: parseStreszczenie(r.stats),
  raport: zRaportem.has(r.id),
})

export async function stanPanelu(db: PrismaClient): Promise<StanPanelu> {
  organizationIdOf(db)
  // bez treści raportu (może mieć megabajty): ta jest tylko do pobrania (`raportPrzebiegu`)
  const rows = await db.importRun.findMany({ where: { kind: RODZAJ_PANELU }, orderBy: { startedAt: 'desc' }, take: 20, omit: { reportMarkdown: true } })
  const zapiszOf = (r: (typeof rows)[number]) => isObj(r.stats) && r.stats['zapisz'] === true
  const run = rows.find((r) => r.status === 'RUNNING')
  const proba = rows.find((r) => r.status !== 'RUNNING' && !zapiszOf(r) && parseStreszczenie(r.stats)?.tryb !== 'ZAPIS')
  const imp = rows.find((r) => r.status !== 'RUNNING' && (zapiszOf(r) || parseStreszczenie(r.stats)?.tryb === 'ZAPIS'))
  const ids = [proba?.id, imp?.id].filter((x): x is string => !!x)
  const zRaportem = new Set(ids.length ? (await db.importRun.findMany({ where: { id: { in: ids }, reportMarkdown: { not: null } }, select: { id: true } })).map((r) => r.id) : [])
  return { wToku: run ? { id: run.id, zapisz: zapiszOf(run), start: run.startedAt } : null, proba: proba ? wiersz(proba, zRaportem) : null, import: imp ? wiersz(imp, zRaportem) : null }
}

/** Raport Markdown przebiegu z panelu do pobrania (klient firmy, RLS); null = nie ma (inny rodzaj, cudzy, bez raportu). */
export async function raportPrzebiegu(db: PrismaClient, runId: string): Promise<{ markdown: string; start: Date; tryb: 'PROBNY' | 'ZAPIS' } | null> {
  organizationIdOf(db)
  if (!/^[a-z0-9]{1,40}$/i.test(runId)) return null
  const r = await db.importRun.findFirst({ where: { id: runId, kind: RODZAJ_PANELU }, select: { reportMarkdown: true, startedAt: true, stats: true } })
  if (!r?.reportMarkdown) return null
  return { markdown: r.reportMarkdown, start: r.startedAt, tryb: parseStreszczenie(r.stats)?.tryb ?? 'PROBNY' }
}

/** Ile ostatnich raportów Markdown z panelu trzymamy w bazie (każdy do `MAX_RAPORTU` znaków). */
export const RAPORTY_W_BAZIE = 5

/**
 * Retencja raportów: treść zostaje w `RAPORTY_W_BAZIE` ostatnich przebiegach oraz w ostatniej próbie i ostatnim
 * imporcie (do nich prowadzą linki ekranu); starszym przebiegom zostaje streszczenie w `stats`. Błąd przycinania nie
 * psuje przebiegu (trafia do logu workera, następny przebieg spróbuje znowu).
 */
export async function przytnijRaporty(db: PrismaClient): Promise<number> {
  try {
    const rows = await db.importRun.findMany({ where: { kind: RODZAJ_PANELU, reportMarkdown: { not: null } }, orderBy: { startedAt: 'desc' }, select: { id: true, stats: true } })
    const zapiszOf = (r: (typeof rows)[number]) => isObj(r.stats) && (r.stats['zapisz'] === true || r.stats['tryb'] === 'ZAPIS')
    const zostaja = new Set(rows.slice(0, RAPORTY_W_BAZIE).map((r) => r.id))
    const proba = rows.find((r) => !zapiszOf(r))
    const imp = rows.find(zapiszOf)
    if (proba) zostaja.add(proba.id)
    if (imp) zostaja.add(imp.id)
    const doPrzyciecia = rows.filter((r) => !zostaja.has(r.id)).map((r) => r.id)
    if (!doPrzyciecia.length) return 0
    return (await db.importRun.updateMany({ where: { id: { in: doPrzyciecia } }, data: { reportMarkdown: null } })).count
  } catch (e) {
    console.error(`[przeprowadzka-panel] przycinanie raportów: ${e instanceof Error ? e.message : String(e)}`)
    return 0
  }
}

/** Przebieg w toku dłużej niż to = przerwany (worker padł); można zlecić od nowa. */
export const PRZERWANY_MS = 60 * 60_000

/**
 * Zlecenie trybu próbnego albo importu. Import tylko po trybie próbnym bez powodów odmowy, zrobionym po ostatniej
 * zmianie decyzji (żeby nie importować czegoś innego, niż pokazał raport). Jeden przebieg naraz na firmę.
 */
export async function zlecPrzeprowadzke(db: PrismaClient, o: { zapisz: boolean; actorId: string; now?: Date }): Promise<string> {
  organizationIdOf(db)
  const now = o.now ?? new Date()
  if (!(await maTokenBl(db)).zapisany) throw new PrzeprowadzkaError('Najpierw zapisz klucz API BaseLinkera.')
  return db.$transaction(async (tx) => {
    const orgId = organizationIdOf(db)
    const zablokowana = await tx.$queryRaw<{ settings: Prisma.JsonValue }[]>`SELECT settings FROM "Organization" WHERE id = ${orgId} FOR UPDATE`
    // po „Przejście z BaseLinkera zakończone” import nie zapisuje (tryb próbny działa dalej)
    if (o.zapisz && przejscieZakonczone(zablokowana[0]?.settings)) throw new PrzeprowadzkaError(ODMOWA_PO_ZAKONCZENIU)
    const run = await tx.importRun.findFirst({ where: { kind: RODZAJ_PANELU, status: 'RUNNING' }, orderBy: { startedAt: 'desc' } })
    if (run && now.getTime() - run.startedAt.getTime() < PRZERWANY_MS) throw new PrzeprowadzkaError('Przeprowadzka już trwa. Odśwież stronę za chwilę.')
    if (run) await tx.importRun.update({ where: { id: run.id }, data: { status: 'FAILED', finishedAt: now, error: 'Przebieg przerwany (brak odpowiedzi od ponad godziny).' } })
    if (o.zapisz) {
      const proba = await tx.importRun.findFirst({ where: { kind: RODZAJ_PANELU, status: { not: 'RUNNING' }, NOT: { stats: { path: ['zapisz'], equals: true } } }, orderBy: { startedAt: 'desc' }, omit: { reportMarkdown: true } })
      const s = parseStreszczenie(proba?.stats)
      if (!proba || proba.status !== 'OK' || !s || s.tryb !== 'PROBNY') throw new PrzeprowadzkaError('Najpierw uruchom tryb próbny i sprawdź raport.')
      if (s.powodyOdmowy.length) throw new PrzeprowadzkaError('Raport próbny ma sprawy, które blokują import. Podejmij decyzje i uruchom tryb próbny jeszcze raz.')
      const zmianaMapy = await tx.auditLog.findFirst({ where: { entity: 'Organization.przeprowadzka', createdAt: { gt: proba.startedAt } }, select: { id: true } })
      if (zmianaMapy) throw new PrzeprowadzkaError('Decyzje zmieniły się po trybie próbnym. Uruchom tryb próbny jeszcze raz.')
      // inny klucz = może inne konto BL, czyli inne dane niż w raporcie
      const zmianaKlucza = await tx.auditLog.findFirst({ where: { entity: 'IntegrationSecret', entityId: TOKEN_BL, createdAt: { gt: proba.startedAt } }, select: { id: true } })
      if (zmianaKlucza) throw new PrzeprowadzkaError('Klucz API BaseLinkera zmienił się po trybie próbnym. Uruchom tryb próbny jeszcze raz.')
    }
    const r = await tx.importRun.create({ data: { kind: RODZAJ_PANELU, stats: { zapisz: o.zapisz, zlecil: o.actorId } } })
    await tx.auditLog.create({ data: { entity: 'ImportRun', entityId: r.id, actorId: o.actorId, after: { przeprowadzka: o.zapisz ? 'import' : 'tryb próbny' } } })
    await enqueue(tx as unknown as PrismaClient, PRZEPROWADZKA_JOB, { runId: r.id }, { dedupeKey: `${PRZEPROWADZKA_JOB}:${r.id}`, maxAttempts: 1 })
    return r.id
  })
}

export interface DepsPrzeprowadzki {
  registry: AdapterRegistry
  secrets: SecretSource
  /** Testy: atrapa BL zamiast prawdziwego API. */
  bl?: (token: string) => BlPrzeprowadzka
  now?: Date
}

/** Handler zadania workera. Każdy błąd ląduje w przebiegu (ekran go pokazuje), a nie tylko w logu workera. */
export async function wykonajPrzeprowadzkeZPanelu(db: PrismaClient, payload: Prisma.JsonValue, deps: DepsPrzeprowadzki): Promise<void> {
  organizationIdOf(db)
  const runId = isObj(payload) && typeof payload['runId'] === 'string' ? payload['runId'] : null
  if (!runId) throw new NonRetryableError(`${PRZEPROWADZKA_JOB}: brak runId`)
  const run = await db.importRun.findFirst({ where: { id: runId, kind: RODZAJ_PANELU } })
  if (!run || run.status !== 'RUNNING') return // przerwany, zrobiony albo cudzy — nic do roboty (idempotencja)
  const zapisz = isObj(run.stats) && run.stats['zapisz'] === true
  const koniec = async (status: 'OK' | 'FAILED', stats: Record<string, unknown>, error: string | null, markdown: string | null = null) => {
    await db.importRun.update({ where: { id: runId }, data: { status, finishedAt: new Date(), stats: { zapisz, ...stats } as Prisma.InputJsonValue, error, reportMarkdown: markdown === null ? null : raportDoBazy(markdown) } })
    if (markdown !== null) await przytnijRaporty(db)
  }
  try {
    const sekrety = await resolveSecrets(db, [TOKEN_BL, ...WFIRMA_KEYS], deps.secrets)
    const token = sekrety[TOKEN_BL]
    if (!token) return void (await koniec('FAILED', {}, 'Brak klucza API BaseLinkera. Zapisz go na tym ekranie.'))
    const bl = deps.bl ? deps.bl(token) : new BlPrzeprowadzka(token)
    const wh = await db.warehouse.findFirst({ where: { id: DEFAULT_WAREHOUSE }, select: { wfirmaWarehouseId: true } })
    const wfirma =
      WFIRMA_KEYS.every((k) => sekrety[k]) && wh?.wfirmaWarehouseId
        ? new WfirmaReadOnly({ accessKey: sekrety['WFIRMA_ACCESS_KEY']!, secretKey: sekrety['WFIRMA_SECRET_KEY']!, appKey: sekrety['WFIRMA_APP_KEY']!, companyId: sekrety['WFIRMA_COMPANY_ID']! })
        : null
    const org = await db.organization.findFirst({ select: { slug: true, settings: true } })
    if (zapisz && przejscieZakonczone(org?.settings)) return void (await koniec('FAILED', {}, ODMOWA_PO_ZAKONCZENIU))
    const [mapa, katalog] = await Promise.all([mapaFirmy(db), katalogFirmy(db)])
    // zapisany wybór spoza katalogów BL wraca do katalogu firmy albo domyślnego (z uwagą w raporcie)
    const dane = await zbierz(
      { bl, wfirma, wfirmaWarehouseId: wfirma ? (wh?.wfirmaWarehouseId ?? null) : null },
      { katalog: parseOrgSettings(org?.settings).baselinker?.inventoryId ?? undefined, katalogWybrany: katalog ?? undefined, mapa, registry: deps.registry, now: deps.now },
    )
    const w = await uruchomPrzeprowadzke(db, { firma: org?.slug ?? '', dane, mapa, registry: deps.registry, zapisz, now: deps.now })
    await koniec('OK', streszczenie(w.raport, w.zapis?.runId ?? null) as unknown as Record<string, unknown>, null, w.markdown)
  } catch (e) {
    const msg =
      e instanceof OdmowaZapisu
        ? `Import odrzucony: ${e.powody.map((p) => powodDlaEkranu(p).tekst).join(' ').slice(0, 800)}`
        : `Przeprowadzka nie przeszła: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`
    console.error(`[przeprowadzka-panel] ${runId}: ${msg}`)
    await koniec('FAILED', {}, msg)
  }
}
