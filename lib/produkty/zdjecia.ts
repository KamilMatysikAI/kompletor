// zdjęcia produktu. Wgranie (wiele, kolejność, główne), miniatury do listy, karty zamówienia, pakowania
// i wydruku, pobranie zdjęć z oferty sklepu (zadanie workera).
//
// bajty zdjęć leżą w bazie (tabela ProductImageData, RLS), nie w katalogu na dysku. Panel i worker to na
// produkcji osobne kontenery z osobnymi systemami plików; z bazą oba widzą te same zdjęcia, a kopia bazy obejmuje
// zdjęcia. Każde zdjęcie to trzy warianty: webp do 1600 px (`o`), miniatura webp 160 px, kwadrat (`m`) i JPEG do
// wydruku 96 px (`p`). Plik z przeglądarki przechodzi przez osłonę uploadu (lib/files/upload-guard.ts), a potem jest
// dekodowany i zapisany od nowa przez sharp: bez metadanych (EXIF, GPS), obrócony wg orientacji z aparatu. Oryginał
// z przeglądarki nie jest przechowywany.
//
// Zdjęcia (pliki `<ZDJECIA_DIR>/<firma>/<id>.webp`, `-m.webp`, `-p.jpg`) przenosi do bazy
// {@link przeniesZdjeciaZDysku} (start kontenera web i workera, polecenie `zdjecia-do-bazy`), a odczyt zdjęcia bez bajtów
// w bazie sam próbuje pliku z dysku i dopisuje go do bazy. Pliki na dysku zostają (nigdy nie kasujemy).
//
// Usunięcie zdjęcia nigdy nie kasuje bajtów: wiersz ProductImage znika z produktu, a ProductImageData dostaje
// `archivedAt` (archiwum, jak wcześniej `old/` z datą). Błąd jednego pliku nie przerywa pozostałych (wynik per plik).
import { randomBytes } from 'node:crypto'
import type { LookupAddress } from 'node:dns'
import https from 'node:https'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Prisma, PrismaClient } from '@prisma/client'
import sharp from 'sharp'
import { organizationIdOf } from '../db'
import { guardUploadBytes, IMAGE_POLICY, type GuardedUpload } from '../files/upload-guard'
import { enqueue } from '../worker/kolejka'
import { NonRetryableError } from '../bledy'
import { bezpiecznyAdresZdjecia, MAX_Z_OFERTY } from './zdjecia-url'
import type { Wariant } from './zdjecia-url'
export { bezpiecznyAdresZdjecia, MAX_Z_OFERTY, zdjecieUrl, type Wariant } from './zdjecia-url'

export const MAX_ZDJEC = 16
export const ZDJECIA_Z_OFERTY_JOB = 'produkt-zdjecia-z-oferty'

const ID_RE = /^[a-z0-9]{10,40}$/
const ORG_RE = /^[A-Za-z0-9_-]{1,64}$/

/** Katalog zdjęć (tylko do przeniesienia do bazy): env ZDJECIA_DIR albo `.dane/zdjecia`. */
export function katalogZdjec(env: Record<string, string | undefined> = process.env): string {
  const own = env['ZDJECIA_DIR']?.trim()
  return own ? path.resolve(own) : path.join(/*turbopackIgnore: true*/ process.cwd(), '.dane', 'zdjecia')
}

function katalogFirmy(organizationId: string, env?: Record<string, string | undefined>): string {
  if (!ORG_RE.test(organizationId)) throw new Error('zły identyfikator firmy')
  return path.join(katalogZdjec(env), organizationId)
}

/** Komunikat, gdy zdjęcie jest na liście produktu, a jego bajtów nie ma ani w bazie, ani w katalogu tego kontenera. */
// Administrator: plik leży na dysku drugiego kontenera (web albo worker); `node dist/org.cjs zdjecia-do-bazy` przenosi go do bazy
// (robi to też każdy start kontenera).
export const BRAK_BAJTOW =
  'Plik zdjęcia nie jest jeszcze dostępny. Wgraj zdjęcie od nowa albo poproś administratora instalacji o przeniesienie zdjęć do bazy (dzieje się to też samo przy ponownym uruchomieniu serwera).'

/** Wiersz zdjęcia jest, a bajtów nie ma w bazie ani na dysku tego kontenera (zdjęcie, nieprzeniesione). */
export class BrakPlikuZdjecia extends Error {
  constructor(readonly imageId: string) {
    super(BRAK_BAJTOW)
  }
}

const nazwaPliku = (id: string, w: Wariant) => (w === 'o' ? `${id}.webp` : w === 'm' ? `${id}-m.webp` : `${id}-p.jpg`)
const KOLUMNA = { o: 'full', m: 'mini', p: 'druk' } as const
const MIME = (w: Wariant) => (w === 'p' ? 'image/jpeg' : 'image/webp')

export interface Przetworzone {
  full: Buffer
  mini: Buffer
  druk: Buffer
  width: number
  height: number
}

const miniatura = (src: () => ReturnType<typeof sharp>) => src().resize({ width: 160, height: 160, fit: 'cover' }).webp({ quality: 78 }).toBuffer()
const doWydruku = (src: () => ReturnType<typeof sharp>) => src().resize({ width: 96, height: 96, fit: 'contain', background: '#ffffff' }).flatten({ background: '#ffffff' }).jpeg({ quality: 70 }).toBuffer()

/** Dekodowanie i zapis od nowa (sharp): webp 1600 px, miniatura 160 px, wydruk JPEG 96 px. Bez metadanych. */
export async function przetworz(bytes: Buffer): Promise<Przetworzone> {
  const src = () => sharp(bytes, { limitInputPixels: IMAGE_POLICY.maxPixels, failOn: 'error' }).rotate()
  const full = await src().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer({ resolveWithObject: true })
  return { full: full.data, mini: await miniatura(src), druk: await doWydruku(src), width: full.info.width, height: full.info.height }
}

export interface WynikDodania {
  dodane: string[]
  bledy: { plik: string; komunikat: string }[]
}

/** Kopia bufora jako Uint8Array<ArrayBuffer> (typ pola Bytes w Prisma 7). */
const bajty = (b: Buffer): Uint8Array<ArrayBuffer> => new Uint8Array(b)

interface Wejscie {
  bytes: Buffer
  nazwa: string
  sourceUrl?: string
}

/**
 * Dodaje zdjęcia na koniec listy produktu (najwyżej {@link MAX_ZDJEC} łącznie). Każdy plik osobno: zły plik trafia do
 * `bledy`, reszta się zapisuje. Wiersz zdjęcia i jego bajty w jednej transakcji (nie ma zdjęcia bez bajtów).
 */
export async function dodajZdjecia(db: PrismaClient, productId: string, wejscie: Wejscie[], actorId: string): Promise<WynikDodania> {
  const wynik: WynikDodania = { dodane: [], bledy: [] }
  const product = await db.product.findUnique({ where: { id: productId }, select: { id: true } })
  if (!product) return { dodane: [], bledy: [{ plik: '', komunikat: 'Nie ma takiego produktu.' }] }
  for (const w of wejscie) {
    try {
      const count = await db.productImage.count({ where: { productId } })
      if (count >= MAX_ZDJEC) {
        wynik.bledy.push({ plik: w.nazwa, komunikat: `Produkt ma już ${MAX_ZDJEC} zdjęć (więcej się nie zmieści).` })
        continue
      }
      if (w.sourceUrl && (await db.productImage.findFirst({ where: { productId, sourceUrl: w.sourceUrl }, select: { id: true } }))) continue
      const check = guardUploadBytes(w.bytes, IMAGE_POLICY)
      if (!check.ok) {
        wynik.bledy.push({ plik: w.nazwa, komunikat: check.message })
        continue
      }
      const p = await przetworz(w.bytes)
      const id = randomBytes(12).toString('hex')
      try {
        await db.$transaction(async (tx) => {
          const last = await tx.productImage.findFirst({ where: { productId }, orderBy: { position: 'desc' }, select: { position: true } })
          await tx.productImage.create({
            data: { id, productId, position: (last?.position ?? -1) + 1, width: p.width, height: p.height, bytes: p.full.length, sourceUrl: w.sourceUrl ?? null, actorId },
          })
          await tx.productImageData.create({ data: { imageId: id, productId, full: bajty(p.full), mini: bajty(p.mini), druk: bajty(p.druk) } })
          await tx.auditLog.create({ data: { entity: 'Product', entityId: productId, actorId, after: { zdjecieDodane: id, ...(w.sourceUrl ? { zOferty: w.sourceUrl } : {}) } } })
        })
      } catch (e) {
        if ((e as { code?: string }).code === 'P2002') continue // to samo zdjęcie z oferty dodane równolegle
        throw e
      }
      wynik.dodane.push(id)
    } catch (e) {
      wynik.bledy.push({ plik: w.nazwa, komunikat: e instanceof Error && /unsupported image|Input buffer|corrupt|VipsJpeg|pngload|webpload/i.test(e.message) ? 'Nie da się odczytać obrazu (plik uszkodzony?).' : 'Nie udało się zapisać zdjęcia.' })
    }
  }
  return wynik
}

/** Zdjęcia z formularza (po osłonie uploadu). */
export async function dodajZFormularza(db: PrismaClient, productId: string, files: GuardedUpload[], actorId: string): Promise<WynikDodania> {
  return dodajZdjecia(db, productId, files.map((f) => ({ bytes: f.content, nazwa: f.originalName || f.fileName })), actorId)
}

/** Zdjęcia produktu w kolejności (pierwsze = główne). */
export async function zdjeciaProduktu(db: PrismaClient, productId: string) {
  return db.productImage.findMany({ where: { productId }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }], select: { id: true, position: true, width: true, height: true, sourceUrl: true } })
}

/** Główne zdjęcie (id) dla listy produktów; produkt bez zdjęć nie ma wpisu. */
export async function glowneZdjecia(db: PrismaClient | Prisma.TransactionClient, productIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(productIds)].filter(Boolean)
  if (!ids.length) return new Map()
  const rows = await db.productImage.findMany({ where: { productId: { in: ids } }, orderBy: [{ productId: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }], select: { id: true, productId: true } })
  const out = new Map<string, string>()
  for (const r of rows) if (!out.has(r.productId)) out.set(r.productId, r.id)
  return out
}

/** Ustala kolejność: `ids` w nowej kolejności (muszą być wszystkie zdjęcia produktu). */
async function ustawKolejnosc(tx: Prisma.TransactionClient, productId: string, ids: string[]): Promise<void> {
  for (const [i, id] of ids.entries()) await tx.productImage.update({ where: { id }, data: { position: i } })
  void productId
}

export type ZmianaZdjecia = 'glowne' | 'w-lewo' | 'w-prawo'

/** Zmiana kolejności albo zdjęcie główne. Zwraca id produktu albo null (nie ma takiego zdjęcia). */
export async function zmienZdjecie(db: PrismaClient, imageId: string, zmiana: ZmianaZdjecia, actorId: string): Promise<string | null> {
  if (!ID_RE.test(imageId)) return null
  return db.$transaction(async (tx) => {
    const img = await tx.productImage.findUnique({ where: { id: imageId }, select: { productId: true } })
    if (!img) return null
    const all = (await tx.productImage.findMany({ where: { productId: img.productId }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }], select: { id: true } })).map((r) => r.id)
    const i = all.indexOf(imageId)
    const next = [...all]
    if (zmiana === 'glowne') {
      next.splice(i, 1)
      next.unshift(imageId)
    } else {
      const j = zmiana === 'w-lewo' ? i - 1 : i + 1
      if (j < 0 || j >= next.length) return img.productId
      ;[next[i], next[j]] = [next[j]!, next[i]!]
    }
    await ustawKolejnosc(tx, img.productId, next)
    await tx.auditLog.create({ data: { entity: 'Product', entityId: img.productId, actorId, before: { zdjecia: all }, after: { zdjecia: next } } })
    return img.productId
  })
}

/** Usuwa zdjęcie z produktu (bajty zostają w bazie jako archiwum, `archivedAt`). Zwraca id produktu albo null. */
export async function usunZdjecie(db: PrismaClient, imageId: string, actorId: string): Promise<string | null> {
  if (!ID_RE.test(imageId)) return null
  return db.$transaction(async (tx) => {
    const img = await tx.productImage.findUnique({ where: { id: imageId }, select: { productId: true } })
    if (!img) return null
    await tx.productImage.delete({ where: { id: imageId } })
    await tx.productImageData.updateMany({ where: { imageId, archivedAt: null }, data: { archivedAt: new Date() } })
    const rest = (await tx.productImage.findMany({ where: { productId: img.productId }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }], select: { id: true } })).map((r) => r.id)
    await ustawKolejnosc(tx, img.productId, rest)
    await tx.auditLog.create({ data: { entity: 'Product', entityId: img.productId, actorId, after: { zdjecieUsuniete: imageId } } })
    return img.productId
  })
}

// ─── Zdjęcia: z katalogu na dysku do bazy ─────────────────────────

/**
 * Bajty jednego zdjęcia z plików na dysku tego kontenera. Brak pełnego zdjęcia = null. Brak miniatury albo pliku do
 * wydruku (przerwany zapis) = odtworzone z pełnego zdjęcia przez sharp.
 */
async function zDysku(organizationId: string, imageId: string, env?: Record<string, string | undefined>): Promise<{ full: Buffer; mini: Buffer; druk: Buffer } | null> {
  const dir = katalogFirmy(organizationId, env)
  const czytaj = (w: Wariant) =>
    readFile(path.join(dir, nazwaPliku(imageId, w))).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null
      throw e
    })
  const full = await czytaj('o')
  if (!full) return null
  const src = () => sharp(full, { limitInputPixels: IMAGE_POLICY.maxPixels, failOn: 'error' })
  const mini = (await czytaj('m')) ?? (await miniatura(src))
  const druk = (await czytaj('p')) ?? (await doWydruku(src))
  return { full, mini, druk }
}

/** Zapis bajtów z dysku do bazy; drugi zapis tego samego zdjęcia (równoległy start web i workera) nic nie zmienia. */
async function zapiszZDysku(db: PrismaClient, imageId: string, productId: string, d: { full: Buffer; mini: Buffer; druk: Buffer }): Promise<boolean> {
  const r = await db.productImageData.createMany({ data: [{ imageId, productId, full: bajty(d.full), mini: bajty(d.mini), druk: bajty(d.druk), zrodlo: 'dysk' }], skipDuplicates: true })
  return r.count > 0
}

export interface WynikPrzeniesienia {
  /** zdjęć przeniesionych teraz z dysku do bazy */
  przeniesione: number
  /** zdjęć produktu bez bajtów w bazie i bez pliku na dysku tego kontenera (może je mieć drugi kontener) */
  brakPliku: number
  bledy: { imageId: string; komunikat: string }[]
  /** przebieg zatrzymany po czasie (`doKiedy`): reszta przy następnym starcie albo przy pierwszym odczycie zdjęcia */
  przerwane: boolean
}

/**
 * Przenosi do bazy zdjęcia firmy, które mają wiersz ProductImage, a nie mają bajtów w ProductImageData (zapisane przed
 * w katalogu `ZDJECIA_DIR`). Idempotentne: zdjęcie już w bazie jest pomijane, ponowny przebieg nic nie
 * zmienia. Pliki na dysku zostają nietknięte. Każde zdjęcie osobno: błąd jednego trafia do `bledy`, reszta idzie dalej.
 */
export async function przeniesZdjeciaZDysku(db: PrismaClient, opts: { env?: Record<string, string | undefined>; doKiedy?: number } = {}): Promise<WynikPrzeniesienia> {
  const org = organizationIdOf(db)
  const wynik: WynikPrzeniesienia = { przeniesione: 0, brakPliku: 0, bledy: [], przerwane: false }
  let po = ''
  for (;;) {
    if (opts.doKiedy !== undefined && Date.now() > opts.doKiedy) {
      wynik.przerwane = true
      break
    }
    const partia = await db.productImage.findMany({ where: { id: { gt: po } }, orderBy: { id: 'asc' }, take: 200, select: { id: true, productId: true } })
    if (!partia.length) break
    po = partia[partia.length - 1]!.id
    const sa = new Set((await db.productImageData.findMany({ where: { imageId: { in: partia.map((p) => p.id) } }, select: { imageId: true } })).map((r) => r.imageId))
    for (const img of partia) {
      if (sa.has(img.id)) continue
      try {
        const d = await zDysku(org, img.id, opts.env)
        if (!d) {
          wynik.brakPliku++
          continue
        }
        if (await zapiszZDysku(db, img.id, img.productId, d)) wynik.przeniesione++
      } catch (e) {
        wynik.bledy.push({ imageId: img.id, komunikat: e instanceof Error ? e.message.slice(0, 200) : String(e) })
      }
    }
  }
  return wynik
}

/**
 * Bajty jednego wariantu zdjęcia firmy z sesji (RLS: obca firma nie znajdzie wiersza). Brak wiersza zdjęcia = null
 * (404). Zdjęcie bez bajtów w bazie: próba pliku z dysku tego kontenera, dopisanego od razu do
 * bazy; nie ma go i tam = {@link BrakPlikuZdjecia} (503 z opisem, nie cichy 404).
 */
export async function plikZdjecia(db: PrismaClient, imageId: string, w: Wariant, env?: Record<string, string | undefined>): Promise<{ bytes: Buffer; mime: string } | null> {
  if (!ID_RE.test(imageId)) return null
  const row = await db.productImage.findUnique({ where: { id: imageId }, select: { id: true, productId: true } })
  if (!row) return null
  const kol = KOLUMNA[w]
  // tylko potrzebny wariant (miniatura listy nie ciągnie z bazy pełnego zdjęcia)
  const data = await db.productImageData.findUnique({ where: { imageId }, select: { full: w === 'o', mini: w === 'm', druk: w === 'p' } })
  const z = data?.[kol]
  if (z) return { bytes: Buffer.from(z), mime: MIME(w) }
  const d = await zDysku(organizationIdOf(db), imageId, env)
  if (!d) throw new BrakPlikuZdjecia(imageId)
  await zapiszZDysku(db, imageId, row.productId, d).catch((e: unknown) => console.error(`[zdjecia] ${imageId}: zapis do bazy z dysku nieudany: ${e instanceof Error ? e.message : e}`))
  return { bytes: d[kol], mime: MIME(w) }
}

/** Miniatury do wydruku (JPEG ≤ 100 px) dla produktów: id produktu → bajty. Zdjęcie bez bajtów = brak wpisu. */
export async function miniaturyDoWydruku(db: PrismaClient, productIds: readonly string[], env?: Record<string, string | undefined>): Promise<Map<string, Buffer>> {
  const main = await glowneZdjecia(db, productIds)
  const out = new Map<string, Buffer>()
  if (!main.size) return out
  const rows = await db.productImageData.findMany({ where: { imageId: { in: [...main.values()] } }, select: { imageId: true, druk: true } })
  const druk = new Map(rows.map((r) => [r.imageId, Buffer.from(r.druk)]))
  for (const [productId, imageId] of main) {
    const b = druk.get(imageId) ?? (await plikZdjecia(db, imageId, 'p', env).catch(() => null))?.bytes
    if (b) out.set(productId, b)
  }
  return out
}

// ─── Zdjęcia z oferty sklepu (zadanie workera) ──────────────────────────────────

/** Wynik zlecenia: `zlecone` = nowe zadanie w kolejce, `czeka` = zadanie tego produktu już czeka, `bez_adresu` = żaden adres https. */
export type ZlecenieZdjec = 'zlecone' | 'czeka' | 'bez_adresu'

/**
 * Zleca pobranie zdjęć oferty dla produktu (worker). Bez bezpiecznego adresu = nic. `runAfter`: zadanie najwcześniej o tej
 * porze (rozkłada zdjęcia w czasie, żeby nie stały przed fakturami i etykietami); `tylkoGdyBrak`: worker
 * kończy bez pobierania, gdy produkt ma już jakiekolwiek zdjęcie w chwili wykonania.
 */
export async function zlecZdjeciaZOferty(
  db: PrismaClient | Prisma.TransactionClient,
  productId: string,
  urls: readonly string[],
  opts: { runAfter?: Date; tylkoGdyBrak?: boolean } = {},
): Promise<ZlecenieZdjec> {
  const ok = urls.map((u) => bezpiecznyAdresZdjecia(u)?.toString()).filter((u): u is string => !!u).slice(0, MAX_Z_OFERTY)
  if (!ok.length) return 'bez_adresu'
  const id = await enqueue(db as PrismaClient, ZDJECIA_Z_OFERTY_JOB, { productId, urls: ok, ...(opts.tylkoGdyBrak ? { tylkoGdyBrak: true } : {}) }, {
    dedupeKey: `zdjecia:${productId}`,
    maxAttempts: 3,
    ...(opts.runAfter ? { runAfter: opts.runAfter } : {}),
  })
  return id ? 'zlecone' : 'czeka'
}

// ─── Partia zleceń zdjęć (wspólne z feedem produktowym) ──────────────────────────────────

/** Nieudane pobranie zdjęć produktu nie wraca przy każdym przebiegu: najwcześniej po tylu dniach. */
export const ZDJECIA_PONOW_PO_MS = 7 * 24 * 3600_000

/**
 * najwyżej tyle nowych zleceń zdjęć na jeden przebieg; reszta przy następnym. Kolejka
 * workera jest jedna dla wszystkich firm (FIFO po `runAfter`, bez priorytetów), więc tysiąc zleceń naraz zatrzymałby
 * faktury, WZ, etykiety i maile.
 */
export const ZDJECIA_LIMIT_NA_PRZEBIEG = 200
/**
 * Odstęp między zleceniami zdjęć jednego przebiegu: n-te zlecenie najwcześniej po n × 5 s (200 zleceń ≈ 17 min). Zadanie
 * dodane później z `runAfter = teraz` (faktura, etykieta) staje w kolejce przed zdjęciami, które jeszcze nie dojrzały.
 */
export const ZDJECIA_ODSTEP_MS = 5_000

export interface WynikPartiiZdjec {
  /** nowe zlecenia pobrania w tym przebiegu (zadanie `produkt-zdjecia-z-oferty`, po jednym na produkt) */
  zlecone: number
  /** zlecenie tego produktu już czeka w kolejce (z poprzedniego przebiegu albo z innego źródła) */
  wKolejce: number
  /** żaden adres nie przeszedł osłony (https, bez adresów wewnętrznych) */
  bezAdresu: number
  /** pominięte: pobranie nie udało się w ostatnich 7 dniach */
  odlozone: number
  /** ponad limit przebiegu ({@link ZDJECIA_LIMIT_NA_PRZEBIEG}): zlecenie przy następnym przebiegu */
  pominiete: number
  bledy: number
}

/** Produkty, których pobranie zdjęć nie udało się w ostatnich {@link ZDJECIA_PONOW_PO_MS}. */
async function nieudanePobrania(db: PrismaClient, now: Date): Promise<Set<string>> {
  const joby = await db.job.findMany({ where: { kind: ZDJECIA_Z_OFERTY_JOB, status: 'FAILED', updatedAt: { gte: new Date(now.getTime() - ZDJECIA_PONOW_PO_MS) } }, select: { payload: true } })
  return new Set(
    joby
      .map((j) => (j.payload && typeof j.payload === 'object' && !Array.isArray(j.payload) ? (j.payload as Record<string, unknown>)['productId'] : null))
      .filter((x): x is string => typeof x === 'string'),
  )
}

/**
 * Zlecenie zdjęć produktom bez zdjęcia (`tylkoGdyBrak`): najwyżej {@link ZDJECIA_LIMIT_NA_PRZEBIEG} nowych zleceń, n-te po
 * (n + 1) × {@link ZDJECIA_ODSTEP_MS}, produkty z nieudaną próbą w ostatnich 7 dniach odłożone. Każdy produkt osobno
 * (błąd jednego nie przerywa reszty). Kolejność = kolejność mapy.
 */
export async function zlecPartieZdjec(db: PrismaClient, doPobrania: ReadonlyMap<string, readonly string[]>, now: Date, zrodlo: string): Promise<WynikPartiiZdjec> {
  const w: WynikPartiiZdjec = { zlecone: 0, wKolejce: 0, bezAdresu: 0, odlozone: 0, pominiete: 0, bledy: 0 }
  if (!doPobrania.size) return w
  const nieudane = await nieudanePobrania(db, now)
  for (const [productId, urls] of doPobrania) {
    if (nieudane.has(productId)) {
      w.odlozone++
      continue
    }
    if (w.zlecone >= ZDJECIA_LIMIT_NA_PRZEBIEG) {
      w.pominiete++
      continue
    }
    try {
      // n-te zlecenie po (n + 1) × odstęp: nawet pierwsze nie staje przed zadaniem dodanym zaraz po przebiegu
      const runAfter = new Date(now.getTime() + (w.zlecone + 1) * ZDJECIA_ODSTEP_MS)
      const r = await zlecZdjeciaZOferty(db, productId, urls, { runAfter, tylkoGdyBrak: true })
      if (r === 'zlecone') w.zlecone++
      else if (r === 'czeka') w.wKolejce++
      else w.bezAdresu++
    } catch (e) {
      w.bledy++
      console.error(`[${zrodlo}] zdjęcia produktu ${productId}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return w
}

type Fetch = typeof fetch

const ZA_DUZY = 'za duży plik'
/** Odpowiedź serwera sklepu bez szczegółów (kod 401/403 w historii produktu mówiłby, że host istnieje). */
const bladHttp = (status: number) => `nie udało się pobrać zdjęcia (serwer odpowiedział ${status >= 500 ? 'błędem' : 'odmową'})`

/** Pobranie jednego zdjęcia: limit czasu i rozmiaru (czytane strumieniem, przerwane po przekroczeniu). */
async function pobierz(url: URL, f: Fetch): Promise<Buffer> {
  const res = await f(url, { redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { accept: 'image/jpeg,image/png,image/webp' } })
  if (!res.ok || !res.body) throw new Error(bladHttp(res.status))
  const len = Number(res.headers.get('content-length') ?? 0)
  if (len > IMAGE_POLICY.maxBytes) throw new Error(ZA_DUZY)
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > IMAGE_POLICY.maxBytes) {
      await reader.cancel()
      throw new Error(ZA_DUZY)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/** Adres IP z sieci prywatnej, pętli zwrotnej, link-local albo zarezerwowanej (IPv4 i IPv6). */
export function adresWewnetrzny(ip: string): boolean {
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip.replace(/^::ffff:/i, ''))
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224
  }
  const x = ip.toLowerCase()
  // NAT64 (64:ff9b::/96) i 6to4 (2002::/16) niosą w sobie adres IPv4, także wewnętrzny: odmowa
  if (x.startsWith('64:ff9b:') || x.startsWith('2002:')) return true
  return x === '::' || x === '::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb')
}

const WEWNETRZNY = 'adres zdjęcia wskazuje sieć wewnętrzną'

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void

/**
 * `lookup` dla połączenia, które przypina adres: ta sama nazwa rozwiązywana jest raz, przy
 * łączeniu, i każdy zwrócony adres przechodzi `adresWewnetrzny`. Nie ma drugiego rozwiązania nazwy między
 * sprawdzeniem a połączeniem (TOCTOU, DNS rebinding). Zamiast `undici.Agent({ connect: { lookup } })` z przeglądu —
 * `node:https` z opcją `lookup`: ten sam efekt bez nowej zależności (undici nie jest w package.json).
 */
export function przypietyLookup(resolve: Lookup) {
  return (hostname: string, options: { all?: boolean } | number | undefined, cb: LookupCb) => {
    const all = typeof options === 'object' && options !== null && options.all === true
    resolve(hostname).then(
      (ips) => {
        if (!ips.length || ips.some(adresWewnetrzny)) return cb(Object.assign(new Error(WEWNETRZNY), { code: 'EWEWNETRZNY' }), all ? [] : '', 4)
        const fam = (ip: string) => (ip.includes(':') ? 6 : 4)
        if (all) return cb(null, ips.map((address) => ({ address, family: fam(address) })))
        return cb(null, ips[0]!, fam(ips[0]!))
      },
      (e: NodeJS.ErrnoException) => cb(e, all ? [] : '', 4),
    )
  }
}

/** limity pobrania innego pliku niż zdjęcie (feed produktowy): rozmiar, nagłówek `accept`, nazwa w komunikatach. */
export interface LimityPobrania {
  maxBytes?: number
  accept?: string
  /** dopełniacz do komunikatów, np. „zdjęcia” (domyślnie), „feedu” */
  co?: string
}

/** Pobranie przez `node:https` z przypiętym adresem: bez przekierowań, limit czasu i rozmiaru (strumieniem). */
export function pobierzPrzypiete(url: URL, resolve: Lookup, timeoutMs = 15_000, limity: LimityPobrania = {}): Promise<Buffer> {
  const maxBytes = limity.maxBytes ?? IMAGE_POLICY.maxBytes
  const co = limity.co ?? 'zdjęcia'
  const blad = (status: number) => `nie udało się pobrać ${co} (serwer odpowiedział ${status >= 500 ? 'błędem' : 'odmową'})`
  return new Promise((done, fail) => {
    const req = https.get(url, { lookup: przypietyLookup(resolve) as never, agent: false, headers: { accept: limity.accept ?? 'image/jpeg,image/png,image/webp' } }, (res) => {
      const status = res.statusCode ?? 0
      if (status !== 200) {
        res.resume()
        // przekierowań nie śledzimy (adres przypięty): 3xx z czytelną wskazówką
        if (status >= 300 && status < 400) return fail(new Error(`nie udało się pobrać ${co}: serwer przekierowuje pod inny adres; wpisz adres docelowy pliku`))
        return fail(new Error(blad(status)))
      }
      if (Number(res.headers['content-length'] ?? 0) > maxBytes) {
        res.destroy()
        return fail(new Error(ZA_DUZY))
      }
      const chunks: Buffer[] = []
      let total = 0
      res.on('data', (c: Buffer) => {
        total += c.length
        if (total > maxBytes) {
          res.destroy()
          return fail(new Error(ZA_DUZY))
        }
        chunks.push(c)
      })
      res.on('end', () => done(Buffer.concat(chunks)))
      res.on('error', fail)
    })
    const t = setTimeout(() => req.destroy(new Error(`przekroczony czas pobierania ${co}`)), timeoutMs)
    req.on('close', () => clearTimeout(t))
    req.on('error', (e: NodeJS.ErrnoException) => fail(e.code === 'EWEWNETRZNY' ? new Error(`adres ${co} wskazuje sieć wewnętrzną`) : e))
  })
}

export type Lookup = (host: string) => Promise<string[]>
export const dnsLookup: Lookup = async (host) => (await (await import('node:dns')).promises.lookup(host, { all: true })).map((r) => r.address)

/** Zadanie workera: pobiera zdjęcia z oferty, każde osobno; błąd jednego nie przerywa reszty. */
export async function zadanieZdjecZOferty(
  db: PrismaClient,
  payload: Prisma.JsonValue,
  opts: { fetch?: Fetch; lookup?: Lookup } = {},
): Promise<WynikDodania> {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {}
  const productId = typeof p['productId'] === 'string' ? p['productId'] : ''
  const urls = Array.isArray(p['urls']) ? p['urls'].filter((u): u is string => typeof u === 'string').slice(0, MAX_Z_OFERTY) : []
  if (!ID_RE.test(productId)) throw new NonRetryableError(`${ZDJECIA_Z_OFERTY_JOB}: zły productId`)
  // zlecenie dla istniejącego produktu bez zdjęcia; ktoś wgrał zdjęcie w międzyczasie = nic nie dokładamy
  if (p['tylkoGdyBrak'] === true && (await db.productImage.count({ where: { productId } }))) return { dodane: [], bledy: [] }
  const wejscie: Wejscie[] = []
  const bledy: WynikDodania['bledy'] = []
  for (const raw of urls) {
    const u = bezpiecznyAdresZdjecia(raw)
    if (!u) {
      bledy.push({ plik: raw.slice(0, 200), komunikat: 'adres zdjęcia niedozwolony' })
      continue
    }
    if (await db.productImage.findFirst({ where: { productId, sourceUrl: u.toString() }, select: { id: true } })) continue
    try {
      // nazwa hosta wskazująca adres wewnętrzny (DNS) = odmowa przed pobraniem (ochrona przed SSRF)
      const resolve = opts.lookup ?? dnsLookup
      const ips = await resolve(u.hostname)
      if (!ips.length || ips.some(adresWewnetrzny)) throw new Error(WEWNETRZNY)
      // produkcja: połączenie z przypiętym adresem (lookup sprawdza każdy adres przy łączeniu); `opts.fetch` tylko w testach
      const bytes = opts.fetch ? await pobierz(u, opts.fetch) : await pobierzPrzypiete(u, resolve)
      wejscie.push({ bytes, nazwa: u.pathname.split('/').pop() || 'zdjecie', sourceUrl: u.toString() })
    } catch (e) {
      bledy.push({ plik: u.toString().slice(0, 200), komunikat: e instanceof Error ? e.message : String(e) })
    }
  }
  const r = await dodajZdjecia(db, productId, wejscie, 'system:zdjecia-z-oferty')
  const wynik = { dodane: r.dodane, bledy: [...bledy, ...r.bledy] }
  // błąd musi gdzieś trafić: wpis w historii produktu (karta produktu), a gdy nic się nie udało — błąd zadania
  if (wynik.bledy.length) {
    const exists = await db.product.findUnique({ where: { id: productId }, select: { id: true } })
    if (exists) await db.auditLog.create({ data: { entity: 'Product', entityId: productId, actorId: 'system:zdjecia-z-oferty', after: { zdjeciaZOfertyBledy: wynik.bledy.slice(0, 10) } } })
    if (!wynik.dodane.length && !wejscie.length) throw new NonRetryableError(`${ZDJECIA_Z_OFERTY_JOB}: żadnego zdjęcia nie pobrano (${wynik.bledy[0]!.komunikat})`)
  }
  return wynik
}
