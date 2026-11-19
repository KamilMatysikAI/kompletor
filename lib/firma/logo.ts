// Logo firmy: Ustawienia → Dane firmy → „Logo”. Pokazuje się na karcie
// zamówienia (kompletacja), liście wysyłkowej i w mailach do klientów (gdy konto sklepu nie ma własnego logo w Poczcie).
//
// Wgranie: tylko przez osłonę uploadu (`readUpload`, lib/files/upload-guard.ts): limit rozmiaru przed wczytaniem bajtów,
// typ po zawartości (PNG albo JPEG; SVG, HTML, ZIP i reszta = odmowa), wymiary z nagłówka, nazwa bez ścieżki. Potem
// sharp dekoduje i zapisuje od nowa (bez metadanych) dwie wersje: PNG do 600×240 px z przezroczystością (panel i maile)
// i JPEG do 360×120 px na białym tle, ≤ 60 KB (wydruki pdfkit). Oryginał nie jest przechowywany.
//
// Przechowywanie: bajty obu wersji w bazie, tabela `OrganizationLogo` (RLS), zapis w tej samej
// transakcji co opis w `Organization.settings.logoFirmy` (osobny klucz: zapis profilu firmy podmienia cały
// `settings.firma`). Panel, wydruki i worker maili czytają z bazy, więc osobne wolumeny web/worker (Coolify) nie mają
// znaczenia. Dysk (`ZDJECIA_DIR/<firma>/firma`) służy już tylko za archiwum: zmiana i usunięcie zapisują poprzednie
// logo do `firma/old/RRRR-MM-DD/GGMMSS_<plik>` (nigdy kasowanie). Logo wgrane przed tą zmianą (pliki na dysku panelu)
// przenosi się do bazy przy pierwszym odczycie w kontenerze, który ma pliki; pliki idą wtedy do old/.
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Prisma, PrismaClient } from '@prisma/client'
import sharp from 'sharp'
import { organizationIdOf } from '../db'
import { readUpload, type UploadPolicy } from '../files/upload-guard'
import { katalogZdjec } from '../produkty/zdjecia'

/** Logo: PNG albo JPEG do 2 MB, do 25 Mpx i 6000 px boku. */
export const LOGO_POLICY: UploadPolicy = { kinds: ['png', 'jpg'], maxBytes: 2 * 1024 * 1024, maxPixels: 25_000_000, maxSide: 6000 }
/** Wersja do wydruków: pdfkit osadza plik 1:1, bramka miniatur (lib/wydruki/obraz.ts) przyjmuje do 64 KB. */
const MAKS_DRUK = 60 * 1024

const ORG_RE = /^[A-Za-z0-9_-]{1,64}$/
const PLIK_RE = /^logo-[a-z0-9]{8,32}$/

export interface LogoFirmy {
  /** Identyfikator wersji logo (`logo-<id>`): wiąże opis w ustawieniach z wierszem `OrganizationLogo` i nazwy w old/. */
  plik: string
  szerokosc: number
  wysokosc: number
  /** Chwila wgrania (ISO): zmienia adres obrazka w panelu, więc przeglądarka nie pokaże starego. */
  od: string
}

export class LogoError extends Error {}

type Wariant = 'ekran' | 'druk'
const MIME: Record<Wariant, string> = { ekran: 'image/png', druk: 'image/jpeg' }
const nazwaPliku = (plik: string, w: Wariant) => (w === 'ekran' ? `${plik}.png` : `${plik}-p.jpg`)

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** Opis logo z `settings.logoFirmy` albo null (brak albo zepsuty wpis). */
export function logoZUstawien(settings: Prisma.JsonValue | null | undefined): LogoFirmy | null {
  const l = obj(obj(settings)['logoFirmy'])
  const plik = l['plik']
  const sz = l['szerokosc']
  const wy = l['wysokosc']
  if (typeof plik !== 'string' || !PLIK_RE.test(plik) || typeof sz !== 'number' || typeof wy !== 'number') return null
  return { plik, szerokosc: sz, wysokosc: wy, od: typeof l['od'] === 'string' ? (l['od'] as string) : '' }
}

function katalogLogo(organizationId: string, env?: Record<string, string | undefined>): string {
  if (!ORG_RE.test(organizationId)) throw new Error('zły identyfikator firmy')
  return path.join(katalogZdjec(env), organizationId, 'firma')
}

/** Brak logo w bazie i na dysku tego kontenera: jeden wpis w logu na proces i logo (nie przy każdym mailu i wydruku). */
const zgloszoneBraki = new Set<string>()
function brakLogo(organizationId: string, plik: string): void {
  const k = `${organizationId}:${plik}`
  if (zgloszoneBraki.has(k)) return
  zgloszoneBraki.add(k)
  console.error(`[logo] firma ${organizationId}: logo ${plik} jest w ustawieniach, ale nie ma go w bazie ani w katalogu zdjęć tego kontenera; wgraj je ponownie w Ustawienia → Dokumenty i faktury → Dane firmy`)
}

async function czytajLubBrak(f: string): Promise<Buffer | null> {
  try {
    return await readFile(f)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/** Pliki logo do old/ (przeniesienie, nigdy kasowanie); brak pliku = nic. */
async function doOld(dir: string, plik: string, now: Date): Promise<void> {
  const d = now.toISOString()
  const old = path.join(dir, 'old', d.slice(0, 10))
  await mkdir(old, { recursive: true })
  const hms = d.slice(11, 19).replace(/:/g, '')
  for (const f of [nazwaPliku(plik, 'ekran'), nazwaPliku(plik, 'druk')])
    await rename(path.join(dir, f), path.join(old, `${hms}_${f}`)).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e
    })
}

/** Archiwum poprzedniego logo z bazy: `firma/old/RRRR-MM-DD/GGMMSS_<plik>` (ten sam układ co pliki). */
async function archiwizuj(dir: string, l: { plik: string; ekran: Uint8Array; druk: Uint8Array }, now: Date): Promise<void> {
  const d = now.toISOString()
  const old = path.join(dir, 'old', d.slice(0, 10))
  await mkdir(old, { recursive: true })
  const hms = d.slice(11, 19).replace(/:/g, '')
  for (const w of ['ekran', 'druk'] as const)
    await writeFile(path.join(old, `${hms}_${nazwaPliku(l.plik, w)}`), l[w], { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'EEXIST') throw e // ta sama wersja w tej samej sekundzie = ta sama treść
    })
}

/**
 * Logo (pliki na dysku panelu, bez wiersza w bazie): przeniesienie do bazy, gdy oba pliki są w tym
 * kontenerze. Pod blokadą wiersza firmy i tylko wtedy, gdy ustawienia dalej wskazują tę samą wersję (równoległa zmiana
 * logo wygrywa). Po zapisie pliki idą do old/. Zwraca bajty (także samego jednego wariantu, gdy drugiego pliku nie ma).
 */
async function zDysku(db: PrismaClient, logo: LogoFirmy, env?: Record<string, string | undefined>): Promise<Partial<Record<Wariant, Buffer>> | null> {
  const organizationId = organizationIdOf(db)
  const dir = katalogLogo(organizationId, env)
  const ekran = await czytajLubBrak(path.join(dir, nazwaPliku(logo.plik, 'ekran')))
  const druk = await czytajLubBrak(path.join(dir, nazwaPliku(logo.plik, 'druk')))
  if (!ekran && !druk) return null
  if (!ekran || !druk) return { ...(ekran ? { ekran } : {}), ...(druk ? { druk } : {}) }
  const przeniesione = await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ settings: Prisma.JsonValue }[]>`SELECT settings FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`
    if (logoZUstawien(rows[0]?.settings ?? null)?.plik !== logo.plik) return false
    const jest = await tx.organizationLogo.findFirst({ select: { plik: true } })
    if (jest?.plik === logo.plik) return true
    const dane = { plik: logo.plik, ekran: new Uint8Array(ekran), druk: new Uint8Array(druk), zrodlo: 'dysk' }
    await tx.organizationLogo.upsert({ where: { organizationId }, create: dane, update: dane })
    return true
  })
  if (przeniesione) await doOld(dir, logo.plik, new Date()).catch((e) => console.error(`[logo] pliki przeniesione do bazy, do old/: ${(e as Error).message}`))
  return { ekran, druk }
}

/** Logo do odczytu: `ekran` = PNG (panel, maile), `druk` = JPEG do wydruków. null = brak logo. Źródło: baza. */
export async function plikLogo(db: PrismaClient, wariant: Wariant, env?: Record<string, string | undefined>): Promise<{ bytes: Buffer; mime: string; logo: LogoFirmy } | null> {
  const org = await db.organization.findFirst({ select: { settings: true } })
  const logo = logoZUstawien(org?.settings ?? null)
  if (!logo) return null
  const row =
    wariant === 'ekran'
      ? (await db.organizationLogo.findFirst({ where: { plik: logo.plik }, select: { ekran: true } }))?.ekran
      : (await db.organizationLogo.findFirst({ where: { plik: logo.plik }, select: { druk: true } }))?.druk
  if (row) return { bytes: Buffer.from(row), mime: MIME[wariant], logo }
  const d = (await zDysku(db, logo, env))?.[wariant]
  if (d) return { bytes: d, mime: MIME[wariant], logo }
  brakLogo(organizationIdOf(db), logo.plik)
  return null
}

/** Dwie wersje logo: PNG do ekranu i maili, JPEG ≤ 60 KB do wydruków (coraz mniejszy, aż się zmieści). */
export async function przetworzLogo(bytes: Buffer): Promise<{ ekran: Buffer; druk: Buffer; szerokosc: number; wysokosc: number }> {
  const src = () => sharp(bytes, { limitInputPixels: LOGO_POLICY.maxPixels, failOn: 'error' }).rotate()
  const ekran = await src().resize({ width: 600, height: 240, fit: 'inside', withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true })
  let druk: Buffer | null = null
  for (const [w, q] of [[360, 82], [300, 72], [240, 62], [180, 55]] as const) {
    druk = await src().resize({ width: w, height: Math.round(w / 3), fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: q }).toBuffer()
    if (druk.length <= MAKS_DRUK) break
  }
  if (!druk || druk.length > MAKS_DRUK) throw new LogoError('Logo jest zbyt szczegółowe do wydruku: zapisz je w mniejszej rozdzielczości i wgraj ponownie.')
  return { ekran: ekran.data, druk, szerokosc: ekran.info.width, wysokosc: ekran.info.height }
}

/**
 * Zapis opisu i bajtów w jednej transakcji, pod blokadą wiersza firmy. Poprzednie logo z bazy trafia do archiwum na dysku
 * przed podmianą (nieudany zapis archiwum cofa całą zmianę). Zwraca poprzedni opis i to, czy jego bajty były w bazie.
 */
async function zapiszWpis(db: PrismaClient, nowy: { opis: LogoFirmy; ekran: Buffer; druk: Buffer } | null, actorId: string, dir: string, now: Date): Promise<{ przed: LogoFirmy | null; wBazie: boolean }> {
  const organizationId = organizationIdOf(db)
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ settings: Prisma.JsonValue }[]>`SELECT settings FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`
    if (!rows[0]) throw new Error('Brak firmy klienta')
    const settings = obj(rows[0].settings) as Record<string, Prisma.JsonValue>
    const przed = logoZUstawien(rows[0].settings)
    const poprzednie = await tx.organizationLogo.findFirst({ select: { plik: true, ekran: true, druk: true } })
    if (poprzednie) await archiwizuj(dir, poprzednie, now)
    const { logoFirmy: _stare, ...reszta } = settings
    void _stare
    await tx.organization.update({ where: { id: organizationId }, data: { settings: (nowy ? { ...reszta, logoFirmy: { ...nowy.opis } } : reszta) as Prisma.InputJsonValue } })
    if (nowy) {
      const dane = { plik: nowy.opis.plik, ekran: new Uint8Array(nowy.ekran), druk: new Uint8Array(nowy.druk), zrodlo: 'panel' }
      await tx.organizationLogo.upsert({ where: { organizationId }, create: dane, update: { ...dane, createdAt: now } })
    } else if (poprzednie) await tx.organizationLogo.deleteMany({}) // bajty są już w archiwum old/ (RLS: tylko wiersz tej firmy)
    await tx.auditLog.create({ data: { entity: 'Organization.logoFirmy', entityId: organizationId, actorId, before: (przed ?? undefined) as Prisma.InputJsonValue | undefined, after: (nowy?.opis ?? undefined) as Prisma.InputJsonValue | undefined } })
    return { przed, wBazie: !!przed && poprzednie?.plik === przed.plik }
  })
}

/** Pliki logo (na dysku, bez wiersza w bazie) po zmianie albo usunięciu: do old/, gdy są w tym kontenerze. */
async function staryPlikDoOld(dir: string, r: { przed: LogoFirmy | null; wBazie: boolean }, now: Date): Promise<void> {
  if (r.przed && !r.wBazie) await doOld(dir, r.przed.plik, now).catch((e) => console.error(`[logo] poprzednie logo do old/: ${(e as Error).message}`))
}

/** Wgranie logo z formularza (pole `logo`). Zły plik = LogoError z komunikatem dla ekranu. Bajty i opis jedną transakcją. */
export async function wgrajLogo(db: PrismaClient, entry: unknown, actorId: string, opts: { now?: Date; env?: Record<string, string | undefined> } = {}): Promise<LogoFirmy> {
  const now = opts.now ?? new Date()
  const u = await readUpload(entry, LOGO_POLICY, { fallbackName: 'logo' })
  if (!u) throw new LogoError('Wybierz plik z logo (PNG albo JPG).')
  if (!u.ok) throw new LogoError(u.code === 'wrong_type' || u.code === 'markup' || u.code === 'zip' ? 'Logo musi być plikiem PNG albo JPG (SVG, PDF i inne formaty nie są przyjmowane).' : u.message)
  let p: Awaited<ReturnType<typeof przetworzLogo>>
  try {
    p = await przetworzLogo(u.file.content)
  } catch (e) {
    if (e instanceof LogoError) throw e
    throw new LogoError('Nie da się odczytać obrazu: plik jest uszkodzony albo to nie jest PNG/JPG.')
  }
  const dir = katalogLogo(organizationIdOf(db), opts.env)
  const opis: LogoFirmy = { plik: `logo-${randomBytes(8).toString('hex')}`, szerokosc: p.szerokosc, wysokosc: p.wysokosc, od: now.toISOString() }
  const r = await zapiszWpis(db, { opis, ekran: p.ekran, druk: p.druk }, actorId, dir, now)
  await staryPlikDoOld(dir, r, now)
  return opis
}

/** Usunięcie logo: wpis i bajty znikają z bazy, poprzednie logo zostaje w archiwum old/ (nigdy kasowanie). Bez logo = nic. */
export async function usunLogo(db: PrismaClient, actorId: string, opts: { now?: Date; env?: Record<string, string | undefined> } = {}): Promise<boolean> {
  const org = await db.organization.findFirst({ select: { settings: true } })
  if (!logoZUstawien(org?.settings ?? null)) return false
  const now = opts.now ?? new Date()
  const dir = katalogLogo(organizationIdOf(db), opts.env)
  const r = await zapiszWpis(db, null, actorId, dir, now)
  await staryPlikDoOld(dir, r, now)
  return !!r.przed
}

/** Adres logo w panelu (sesja); `od` w zapytaniu, żeby po zmianie przeglądarka nie pokazała starego obrazka. */
export const logoUrlPanelu = (l: LogoFirmy) => `/api/firma/logo?v=${encodeURIComponent(l.od || l.plik)}`
