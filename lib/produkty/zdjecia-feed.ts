// zdjęcia produktów z feedu produktowego sklepu (Google Merchant XML). Firma wpisuje jeden albo kilka adresów
// feedu (Produkty → „Zdjęcia z feedu”), opcjonalnie ze sklepem, z którego feed pochodzi. Przebieg (przycisk w panelu
// albo automat raz na dobę nocą, zadanie workera) pobiera każdy feed tylko odczytem (GET, https, bez adresów
// wewnętrznych, limit rozmiaru i czasu, parser bez encji), paruje pozycje z produktami i zleca zdjęcia produktom, które
// nie mają ani jednego (to samo zadanie workera i te same limity co zdjęcia z ofert). Do sklepu nic nie
// zapisujemy. Wynik przebiegu: ImportRun `zdjecia-z-feedu` (liczniki i lista pozycji bez dopasowania do pobrania CSV).
//
// Parowanie pozycji feedu z produktem, reguły:
//   1. SKU = `g:mpn`  2. SKU = `g:id` (tylko pozycja bez `g:mpn`)  3. EAN = `g:gtin` (po normalizacji)
//   4. identyfikator oferty w sklepie feedu = `g:id` albo `<g:item_group_id>/<g:id>` (wariant WooCommerce)
// Wszystkie reguły z dokładnie jednym produktem muszą wskazywać ten sam produkt; sprzeczne wskazania = „niejednoznaczne”.
// Reguła z więcej niż jednym produktem (np. ten sam EAN u dwóch) nie rozstrzyga; gdy żadna nie da jednego produktu,
// pozycja jest „niejednoznaczna”. Produkt, do którego trafiają dwie pozycje z różnym zdjęciem głównym, też jest
// niejednoznaczny (chyba że dokładnie jedna z nich wskazuje go identyfikatorem oferty). Wariant ma własne `g:id`
// i własne SKU, więc dostaje zdjęcie swojego wariantu.
import type { Channel, Prisma, PrismaClient } from '@prisma/client'
import { organizationIdOf } from '../db'
import { normalizeEan } from '../import/normalizacja'
import { toWarsaw } from '../rdzen/kalendarz'
import { poleCsv } from '../zamowienia/eksport-csv'
import { BladFeedu, parsujFeed, type PozycjaFeedu } from './feed'
import { bezpiecznyAdresZdjecia } from './zdjecia-url'
import { adresWewnetrzny, dnsLookup, pobierzPrzypiete, zlecPartieZdjec, type Lookup, type WynikPartiiZdjec } from './zdjecia'

export const FEED_JOB = 'produkty-zdjecia-z-feedu'
export const FEED_RUN_KIND = 'zdjecia-z-feedu'
/** Klucz w `Organization.settings`. */
export const FEED_KLUCZ = 'feedyProduktowe'
export const FEED_MAX_ADRESOW = 5
export const FEED_MAX_BAJTOW = 20 * 1024 * 1024
export const FEED_LIMIT_CZASU_MS = 60_000
/** Automat: raz na dobę, w oknie 2:00–6:00 czasu Warszawy (przed porannym pakowaniem, po nocnej synchronizacji 3:00 też). */
export const FEED_NOC_OD = 2
export const FEED_NOC_DO = 6
/** Najwięcej pozycji „bez dopasowania” zapisanych do CSV jednego przebiegu. */
export const FEED_MAX_LISTY = 5000

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

// ─── Ustawienia firmy ────────────────────────────────────────────────────────

export interface FeedFirmy {
  url: string
  /** sklep, z którego jest feed (`KANAŁ:konto`, np. „WOO:123”); bez niego reguła 4 (identyfikator oferty) nie działa */
  konto?: string
}

const KONTO_RE = /^([A-Z_]{2,20}):([A-Za-z0-9_.-]{1,100})$/

/** Adresy feedów firmy z `settings.feedyProduktowe.adresy`; zły wpis pominięty. */
export function czytajFeedy(settings: Prisma.JsonValue | null | undefined): FeedFirmy[] {
  const f = isObj(settings) ? settings[FEED_KLUCZ] : undefined
  const lista = isObj(f) && Array.isArray(f['adresy']) ? f['adresy'] : []
  const out: FeedFirmy[] = []
  for (const x of lista) {
    if (!isObj(x) || typeof x['url'] !== 'string' || !bezpiecznyAdresZdjecia(x['url'])) continue
    const konto = typeof x['konto'] === 'string' && KONTO_RE.test(x['konto']) ? x['konto'] : undefined
    out.push({ url: x['url'], ...(konto ? { konto } : {}) })
    if (out.length >= FEED_MAX_ADRESOW) break
  }
  return out
}

export async function feedyFirmy(db: PrismaClient): Promise<FeedFirmy[]> {
  const org = await db.organization.findFirst({ select: { settings: true } })
  return czytajFeedy(org?.settings)
}

export type Sprawdzenie<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * Walidacja wpisu z panelu: wiersze formularza `{ url, konto }` (pusty adres = wiersz pominięty), każdy adres https bez
 * adresów wewnętrznych; sklep z listy kont firmy (`dozwoloneKonta`) albo pusty. Adres idzie w całości, bez dzielenia
 * tekstu (średnik w zapytaniu adresu jest dozwolony).
 */
export function sprawdzFeedy(wpisy: readonly { url: string; konto?: string }[], dozwoloneKonta: ReadonlySet<string>): Sprawdzenie<FeedFirmy[]> {
  const out: FeedFirmy[] = []
  const wiersze = wpisy.map((w) => ({ adres: w.url.trim(), konto: (w.konto ?? '').trim() })).filter((w) => w.adres)
  if (wiersze.length > FEED_MAX_ADRESOW) return { ok: false, error: `Najwyżej ${FEED_MAX_ADRESOW} adresów feedu.` }
  for (const [i, { adres, konto }] of wiersze.entries()) {
    const u = bezpiecznyAdresZdjecia(adres)
    if (!u) return { ok: false, error: `Wiersz ${i + 1}: adres feedu musi zaczynać się od https:// i prowadzić do serwera w internecie (bez adresów IP i sieci wewnętrznej).` }
    if (konto && !dozwoloneKonta.has(konto)) return { ok: false, error: `Wiersz ${i + 1}: nie ma podłączonego sklepu „${konto}”. Wybierz sklep z listy albo zostaw puste.` }
    if (out.some((f) => f.url === u.toString())) return { ok: false, error: `Wiersz ${i + 1}: ten adres jest już na liście.` }
    out.push({ url: u.toString(), ...(konto ? { konto } : {}) })
  }
  return { ok: true, value: out }
}

/** Zapis listy feedów (surowy JSON ustawień, blokada wiersza firmy, AuditLog przy zmianie). */
export async function zapiszFeedy(db: PrismaClient, feedy: FeedFirmy[], actorId: string): Promise<FeedFirmy[]> {
  const organizationId = organizationIdOf(db)
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ settings: Prisma.JsonValue }[]>`SELECT settings FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`
    if (!rows[0]) throw new Error('Brak firmy klienta (klient bez firmy?)')
    const settings = isObj(rows[0].settings) ? rows[0].settings : {}
    const before = czytajFeedy(settings)
    if (JSON.stringify(before) === JSON.stringify(feedy) && isObj(settings[FEED_KLUCZ])) return before
    const cur = isObj(settings[FEED_KLUCZ]) ? settings[FEED_KLUCZ] : {}
    await tx.organization.update({ where: { id: organizationId }, data: { settings: { ...settings, [FEED_KLUCZ]: { ...cur, adresy: feedy } } as unknown as Prisma.InputJsonValue } })
    await tx.auditLog.create({
      data: { entity: 'Organization.feedyProduktowe', entityId: organizationId, actorId, before: before as unknown as Prisma.InputJsonValue, after: feedy as unknown as Prisma.InputJsonValue },
    })
    return feedy
  })
}

// ─── Parowanie (funkcja czysta) ──────────────────────────────────────────────

export interface ProduktKatalogu {
  id: string
  sku: string
  ean: string | null
  maZdjecie: boolean
}

export type Regula = 'sku' | 'id-jako-sku' | 'ean' | 'oferta'

export interface BezDopasowania {
  feed: number
  id: string
  mpn: string
  gtin: string
  tytul: string
  powod: 'brak' | 'niejednoznaczne'
}

export interface WynikParowania {
  /** produkt → adresy zdjęć (tylko produkty bez zdjęcia), w kolejności pozycji feedu */
  doPobrania: Map<string, string[]>
  /** pozycje sparowane z jednym produktem */
  sparowane: number
  /** sparowane, ale produkt ma już zdjęcie (nic nie robimy) */
  maZdjecie: number
  /** sparowane z produktem bez zdjęcia, ale pozycja nie ma żadnego adresu zdjęcia https */
  bezZdjeciaWFeedzie: number
  bezDopasowania: number
  niejednoznaczne: number
  wedlugReguly: Record<Regula, number>
  lista: BezDopasowania[]
}

const pusty = (): Record<Regula, number> => ({ sku: 0, 'id-jako-sku': 0, ean: 0, oferta: 0 })

/**
 * Pozycje feedu → produkty. `oferty`: identyfikatory ofert sklepu, z którego jest feed (externalId → produkt); pusta
 * mapa = reguła 4 wyłączona. Produkty już sparowane wcześniejszym feedem (`zajete`) pomijamy bez licznika.
 */
export function dopasuj(
  pozycje: readonly PozycjaFeedu[],
  katalog: readonly ProduktKatalogu[],
  oferty: ReadonlyMap<string, string>,
  opts: { feed?: number; zajete?: ReadonlySet<string> } = {},
): WynikParowania {
  const poSku = new Map<string, ProduktKatalogu>()
  const poEan = new Map<string, ProduktKatalogu[]>()
  const poId = new Map<string, ProduktKatalogu>()
  for (const p of katalog) {
    poSku.set(p.sku.trim(), p)
    poId.set(p.id, p)
    if (p.ean) {
      const e = normalizeEan(p.ean).ean ?? p.ean.trim()
      poEan.set(e, [...(poEan.get(e) ?? []), p])
    }
  }
  const w: WynikParowania = { doPobrania: new Map(), sparowane: 0, maZdjecie: 0, bezZdjeciaWFeedzie: 0, bezDopasowania: 0, niejednoznaczne: 0, wedlugReguly: pusty(), lista: [] }
  const feed = opts.feed ?? 0
  const wpis = (x: PozycjaFeedu, powod: BezDopasowania['powod']) => {
    if (w.lista.length < FEED_MAX_LISTY) w.lista.push({ feed, id: x.id, mpn: x.mpn ?? '', gtin: x.gtin ?? '', tytul: x.tytul ?? '', powod })
  }
  // produkt → pozycje, które na niego wskazały
  const trafienia = new Map<string, { x: PozycjaFeedu; regula: Regula }[]>()
  for (const x of pozycje) {
    const reguly: [Regula, ProduktKatalogu[]][] = [
      ['sku', x.mpn && poSku.has(x.mpn.trim()) ? [poSku.get(x.mpn.trim())!] : []],
      // `g:id` jako SKU tylko dla pozycji bez `g:mpn`: gdy sklep podaje MPN (SKU), a ten nie pasuje, to produkt nowy,
      // a nie „identyfikator równy cudzemu SKU” (numeryczne SKU w sklepach są częste)
      ['id-jako-sku', !x.mpn?.trim() && poSku.has(x.id.trim()) ? [poSku.get(x.id.trim())!] : []],
      ['ean', x.gtin ? (poEan.get(normalizeEan(x.gtin).ean ?? x.gtin.trim()) ?? []) : []],
      [
        'oferta',
        [...new Set([oferty.get(x.id), x.grupa ? oferty.get(`${x.grupa}/${x.id}`) : undefined].filter((v): v is string => !!v))].map((id) => poId.get(id)).filter((p): p is ProduktKatalogu => !!p),
      ],
    ]
    // reguły z dokładnie jednym kandydatem muszą wskazywać ten sam produkt; sprzeczne wskazania (np. MPN → A, oferta
    // sklepu → B) = niejednoznaczne, nie „pierwsza wygrywa”. Reguła z wieloma kandydatami (wspólny EAN) nie weta.
    const jedne = reguly.filter(([, k]) => k.length === 1)
    const wskazane = new Set(jedne.map(([, k]) => k[0]!.id))
    const wiele = wskazane.size > 1 || reguly.some(([, k]) => k.length > 1)
    const wynik: { p: ProduktKatalogu; regula: Regula } | null = wskazane.size === 1 ? { p: jedne[0]![1][0]!, regula: jedne[0]![0] } : null
    if (!wynik) {
      if (wiele) {
        w.niejednoznaczne++
        wpis(x, 'niejednoznaczne')
      } else {
        w.bezDopasowania++
        wpis(x, 'brak')
      }
      continue
    }
    trafienia.set(wynik.p.id, [...(trafienia.get(wynik.p.id) ?? []), { x, regula: wynik.regula }])
  }
  for (const [productId, lista] of trafienia) {
    let wybrane = lista
    if (new Set(lista.map((t) => t.x.zdjecia[0] ?? '')).size > 1) {
      // dwie pozycje z różnymi zdjęciami na jeden produkt: rozstrzyga tylko jedna wskazująca go identyfikatorem oferty
      const poOfercie = lista.filter((t) => t.regula === 'oferta' || oferty.get(t.x.id) === productId || (t.x.grupa && oferty.get(`${t.x.grupa}/${t.x.id}`) === productId))
      if (poOfercie.length !== 1) {
        for (const t of lista) {
          w.niejednoznaczne++
          wpis(t.x, 'niejednoznaczne')
        }
        continue
      }
      wybrane = poOfercie
    }
    const t = wybrane[0]!
    w.sparowane += lista.length
    w.wedlugReguly[t.regula] += lista.length
    if (opts.zajete?.has(productId)) continue
    const p = poId.get(productId)!
    if (p.maZdjecie) {
      w.maZdjecie++
      continue
    }
    const urls = t.x.zdjecia.filter((u) => bezpiecznyAdresZdjecia(u))
    if (!urls.length) {
      w.bezZdjeciaWFeedzie++
      continue
    }
    w.doPobrania.set(productId, urls)
  }
  return w
}

// ─── Pobranie feedu ──────────────────────────────────────────────────────────

/** Pobranie feedu: tylko GET przez połączenie z przypiętym adresem (bez sieci wewnętrznej), bez przekierowań, ≤ 20 MB, ≤ 60 s. */
export async function pobierzFeed(adres: string, resolve: Lookup = dnsLookup): Promise<Buffer> {
  const u = bezpiecznyAdresZdjecia(adres)
  if (!u) throw new BladFeedu('Adres feedu niedozwolony (tylko https, bez adresów IP i sieci wewnętrznej).')
  const ips = await resolve(u.hostname)
  if (!ips.length || ips.some(adresWewnetrzny)) throw new BladFeedu('Adres feedu wskazuje sieć wewnętrzną.')
  return pobierzPrzypiete(u, resolve, FEED_LIMIT_CZASU_MS, { maxBytes: FEED_MAX_BAJTOW, accept: 'application/xml,text/xml,application/rss+xml,application/atom+xml,*/*;q=0.5', co: 'feedu' })
}

// ─── Przebieg ────────────────────────────────────────────────────────────────

export interface WynikJednegoFeedu {
  /** adres skrócony do nazwy serwera i pliku (w panelu i logu) */
  adres: string
  pozycje: number
  sparowane: number
  maZdjecie: number
  bezZdjeciaWFeedzie: number
  bezDopasowania: number
  niejednoznaczne: number
  wedlugReguly?: Record<Regula, number>
  blad?: string
}

export interface WynikPrzebieguFeedu extends WynikPartiiZdjec {
  zrodlo: 'panel' | 'noc'
  feedy: WynikJednegoFeedu[]
  /** produkty bez zdjęcia sparowane z pozycją ze zdjęciem (przed limitem przebiegu) */
  doPobrania: number
  lista: BezDopasowania[]
}

export const skrotAdresu = (adres: string): string => {
  try {
    const u = new URL(adres)
    const plik = u.pathname.split('/').filter(Boolean).pop() ?? ''
    return `${u.hostname}/…/${plik.length > 12 ? `${plik.slice(0, 6)}…${plik.slice(-8)}` : plik}`
  } catch {
    return adres.slice(0, 40)
  }
}

const komunikat = (e: unknown): string => {
  if (e instanceof BladFeedu) return e.message
  const m = e instanceof Error ? e.message : String(e)
  if (m === 'za duży plik') return `Plik feedu jest większy niż ${FEED_MAX_BAJTOW / 1024 / 1024} MB.`
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return 'Nie ma takiego serwera (sprawdź adres feedu).'
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPROTO|ECONNABORTED|HPE_|socket hang up/i.test(m)) return 'Serwer feedu nie odpowiada. Kolejna próba przy następnym przebiegu.'
  if (/certificate|CERT_|SSL/i.test(m)) return 'Serwer feedu ma nieprawidłowy certyfikat https.'
  return m.slice(0, 300)
}

/**
 * Jeden przebieg dla firmy klienta `db`: każdy feed osobno (błąd jednego nie zatrzymuje pozostałych), parowanie, zlecenie
 * zdjęć produktom bez zdjęcia (limit przebiegu), zapis wyniku w ImportRun. Firma bez feedu = null (nic nie zapisujemy).
 * Wszystkie feedy z błędem = ImportRun FAILED z komunikatem (bez wyjątku: worker nie ponawia w kółko).
 */
export async function przebiegFeedow(
  db: PrismaClient,
  opts: { zrodlo: 'panel' | 'noc'; now?: Date; pobierz?: (adres: string) => Promise<Uint8Array> } = { zrodlo: 'noc' },
): Promise<WynikPrzebieguFeedu | null> {
  const now = opts.now ?? new Date()
  const feedy = await feedyFirmy(db)
  if (!feedy.length) return null
  const run = await db.importRun.create({ data: { kind: FEED_RUN_KIND } })
  const w: WynikPrzebieguFeedu = { zrodlo: opts.zrodlo, feedy: [], doPobrania: 0, lista: [], zlecone: 0, wKolejce: 0, bezAdresu: 0, odlozone: 0, pominiete: 0, bledy: 0 }
  try {
    const produkty = await db.product.findMany({ select: { id: true, sku: true, ean: true, _count: { select: { images: true } } } })
    const katalog: ProduktKatalogu[] = produkty.map((p) => ({ id: p.id, sku: p.sku, ean: p.ean, maZdjecie: p._count.images > 0 }))
    const doPobrania = new Map<string, string[]>()
    for (const [i, f] of feedy.entries()) {
      const jeden: WynikJednegoFeedu = { adres: skrotAdresu(f.url), pozycje: 0, sparowane: 0, maZdjecie: 0, bezZdjeciaWFeedzie: 0, bezDopasowania: 0, niejednoznaczne: 0 }
      try {
        const bytes = await (opts.pobierz ?? pobierzFeed)(f.url)
        const feed = parsujFeed(bytes)
        jeden.pozycje = feed.pozycje.length
        const oferty = new Map<string, string>()
        const m = f.konto ? KONTO_RE.exec(f.konto) : null
        if (m) {
          const rows = await db.channelOffer.findMany({ where: { channel: m[1] as Channel, channelAccountId: m[2]!, active: true }, select: { externalId: true, productId: true } })
          for (const r of rows) oferty.set(r.externalId, r.productId)
        }
        const r = dopasuj(feed.pozycje, katalog, oferty, { feed: i + 1, zajete: new Set(doPobrania.keys()) })
        Object.assign(jeden, { sparowane: r.sparowane, maZdjecie: r.maZdjecie, bezZdjeciaWFeedzie: r.bezZdjeciaWFeedzie, bezDopasowania: r.bezDopasowania, niejednoznaczne: r.niejednoznaczne, wedlugReguly: r.wedlugReguly })
        for (const [p, u] of r.doPobrania) if (!doPobrania.has(p)) doPobrania.set(p, u)
        for (const x of r.lista) if (w.lista.length < FEED_MAX_LISTY) w.lista.push(x)
      } catch (e) {
        jeden.blad = komunikat(e)
        console.error(`[${FEED_JOB}] feed ${jeden.adres}: ${jeden.blad}`)
      }
      w.feedy.push(jeden)
    }
    w.doPobrania = doPobrania.size
    Object.assign(w, await zlecPartieZdjec(db, doPobrania, now, FEED_JOB))
    await odchudzStarePrzebiegi(db, now).catch((e: unknown) => console.error(`[${FEED_JOB}] odchudzenie starych przebiegów: ${e instanceof Error ? e.message : e}`))
    const wszystkieZBledem = w.feedy.every((f) => f.blad)
    await db.importRun.update({
      where: { id: run.id },
      data: {
        status: wszystkieZBledem ? 'FAILED' : w.feedy.some((f) => f.blad) || w.bledy ? 'PARTIAL' : 'OK',
        finishedAt: new Date(),
        stats: w as unknown as Prisma.InputJsonValue,
        error: wszystkieZBledem ? w.feedy.map((f) => f.blad).join(' · ').slice(0, 1000) : null,
      },
    })
    return w
  } catch (e) {
    await db.importRun.update({ where: { id: run.id }, data: { status: 'FAILED', finishedAt: new Date(), error: komunikat(e), stats: w as unknown as Prisma.InputJsonValue } })
    throw e
  }
}

/** Lista „bez dopasowania” (do 5000 pozycji) zostaje tylko w przebiegach z ostatnich tylu dni; liczniki zostają zawsze. */
export const FEED_LISTA_DNI = 14

/**
 * Przebiegi starsze niż {@link FEED_LISTA_DNI} dni tracą listę pozycji bez dopasowania (do ~1,5 MB JSON na przebieg),
 * liczniki i status zostają. Wiersza nie kasujemy. Firma klienta `db` (RLS).
 */
export async function odchudzStarePrzebiegi(db: PrismaClient, now: Date = new Date()): Promise<number> {
  const granica = new Date(now.getTime() - FEED_LISTA_DNI * 24 * 3600_000)
  return db.$executeRaw`UPDATE "ImportRun" SET stats = stats - 'lista' WHERE kind = ${FEED_RUN_KIND} AND "startedAt" < ${granica} AND jsonb_typeof(stats) = 'object' AND stats->'lista' IS NOT NULL`
}

/**
 * Automat nocny należny: godzina Warszawy w [{@link FEED_NOC_OD}, {@link FEED_NOC_DO}) i dziś nie było jeszcze przebiegu
 * (żadnego, także z przycisku po północy). Worker planuje zadanie co godzinę.
 */
export async function feedNalezny(db: PrismaClient, now: Date): Promise<boolean> {
  const w = toWarsaw(now)
  const h = Math.floor(w.msOfDay / 3600_000)
  if (h < FEED_NOC_OD || h >= FEED_NOC_DO) return false
  const odPolnocy = new Date(now.getTime() - w.msOfDay)
  return (await db.importRun.count({ where: { kind: FEED_RUN_KIND, startedAt: { gte: odPolnocy } } })) === 0
}

// ─── Odczyt do ekranu ────────────────────────────────────────────────────────

export interface OstatniPrzebieg {
  id: string
  status: 'RUNNING' | 'OK' | 'PARTIAL' | 'FAILED'
  startedAt: Date
  finishedAt: Date | null
  error: string | null
  wynik: WynikPrzebieguFeedu | null
}

export async function ostatniPrzebiegFeedu(db: PrismaClient): Promise<OstatniPrzebieg | null> {
  const r = await db.importRun.findFirst({ where: { kind: FEED_RUN_KIND }, orderBy: { startedAt: 'desc' }, select: { id: true, status: true, startedAt: true, finishedAt: true, error: true, stats: true } })
  if (!r) return null
  return { id: r.id, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, error: r.error, wynik: isObj(r.stats) ? (r.stats as unknown as WynikPrzebieguFeedu) : null }
}

/** CSV pozycji bez dopasowania (separator „;”, BOM dla Excela). */
export function csvBezDopasowania(lista: readonly BezDopasowania[]): string {
  const wiersze = [['Feed', 'ID w feedzie (g:id)', 'MPN (g:mpn)', 'GTIN/EAN (g:gtin)', 'Nazwa', 'Powód'].map(poleCsv).join(';')]
  for (const x of lista) wiersze.push([String(x.feed), x.id, x.mpn, x.gtin, x.tytul, x.powod === 'brak' ? 'brak produktu o tym SKU, EAN ani ofercie' : 'kilka produktów pasuje'].map(poleCsv).join(';'))
  return `﻿${wiersze.join('\r\n')}\r\n`
}
