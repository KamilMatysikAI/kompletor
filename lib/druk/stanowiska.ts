// Zarządzanie stanowiskami druku (Ustawienia → Druk): dodanie, nazwa, wyłączenie, token, routing.
// Klient firmy z sesji (RLS). Token wraca w pełni TYLKO z `nowyToken` (pokazany raz); w bazie i w AuditLog nie ma ani
// tokenu, ani kodu instalacyjnego.
import type { PrismaClient } from '@prisma/client'
import { organizationIdOf } from '@/lib/db'
import {
  jestRola,
  jestTypZlecenia,
  kodZNazwy,
  parsujWartoscPrzypisania,
  przypisaniaStanowiska,
  roleZRaportu,
  ROUTING_DOMYSLNY,
  routingDoZapisu,
  TYPY_ZLECEN,
  WZOR_ID_STANOWISKA,
  WZOR_KODU_STANOWISKA,
  type Przypisanie,
  type TypZlecenia,
} from './role'
import { nowyTokenStanowiska } from './tokeny'
import { BladDruku } from './zlecenia'

type Db = PrismaClient

export { kodZNazwy }

export const PREFIKS_KODU_INSTALACYJNEGO = 'kmi_'

/** Kod instalacyjny do wklejenia w Zainstaluj.cmd: `kmi_` + base64url z { serwer, stanowisko, token }. */
export function kodInstalacyjny(serwer: string, stanowisko: string, token: string): string {
  return PREFIKS_KODU_INSTALACYJNEGO + Buffer.from(JSON.stringify({ serwer, stanowisko, token }), 'utf8').toString('base64url')
}

/**
 * Adres serwera dla agenta. Aplikacja nie ma dziś zmiennej z własnym adresem, więc bierzemy go z nagłówków żądania,
 * którym administrator otworzył panel (za proxy Coolify: X-Forwarded-Proto i X-Forwarded-Host, inaczej Host).
 * Opis i zastrzeżenia: docs/druk.md, „Adres serwera w kodzie instalacyjnym”.
 */
export function adresSerwera(h: { get(name: string): string | null }): string {
  const host = (h.get('x-forwarded-host')?.split(',')[0] ?? h.get('host') ?? '').trim()
  if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host)) throw new BladDruku('Nie udało się ustalić adresu serwera z żądania — otwórz panel pod jego zwykłym adresem', 400)
  const proto = (h.get('x-forwarded-proto')?.split(',')[0] ?? '').trim().toLowerCase()
  const lokalny = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)
  return `${proto === 'http' || (!proto && lokalny) ? 'http' : 'https'}://${host}`
}

const nazwaStanowiska = (v: unknown): string => {
  const n = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : ''
  if (!n || n.length > 80) throw new BladDruku('Nazwa stanowiska: od 1 do 80 znaków', 400)
  return n
}

async function audyt(db: Db, stationId: string, actorId: string, before: object | null, after: object | null) {
  await db.auditLog.create({ data: { entity: 'PrintStation', entityId: stationId, actorId, before: before ?? undefined, after: after ?? undefined } })
}

/**
 * Nowe stanowisko. Kod podany = sprawdzony wzorcem i unikalny (odmowa przy zajętym); kod pusty = z nazwy
 * (`kodZNazwy`), a przy zajętym kolejny wolny z końcówką „-2”, „-3”….
 */
export async function dodajStanowisko(db: Db, d: { code: unknown; name: unknown }, actorId: string): Promise<string> {
  organizationIdOf(db)
  const podany = typeof d.code === 'string' ? d.code.trim() : ''
  if (podany && !WZOR_KODU_STANOWISKA.test(podany)) throw new BladDruku('Kod stanowiska: litery bez polskich znaków, cyfry, - i _ (np. magazyn-1)', 400)
  const name = nazwaStanowiska(d.name)
  const baza = podany || kodZNazwy(name)
  for (let n = 1; n <= 50; n++) {
    const code = n === 1 ? baza : `${baza}-${n}`
    try {
      const s = await db.printStation.create({ data: { code, name, routing: ROUTING_DOMYSLNY } })
      await audyt(db, s.id, actorId, null, { code, name })
      return s.id
    } catch (e) {
      if ((e as { code?: string }).code !== 'P2002') throw e
      if (podany) throw new BladDruku(`Stanowisko o kodzie „${podany}” już jest`, 409)
    }
  }
  throw new BladDruku('Nie udało się dobrać wolnego kodu stanowiska — wpisz kod sam w „Zaawansowane”', 409)
}

async function stanowisko(db: Db, id: unknown) {
  const s = typeof id === 'string' && id ? await db.printStation.findUnique({ where: { id } }) : null
  if (!s) throw new BladDruku('Nie znaleziono stanowiska — odśwież stronę', 404)
  return s
}

export async function zmienNazweStanowiska(db: Db, id: unknown, name: unknown, actorId: string): Promise<void> {
  const s = await stanowisko(db, id)
  const nowa = nazwaStanowiska(name)
  await db.printStation.update({ where: { id: s.id }, data: { name: nowa } })
  await audyt(db, s.id, actorId, { name: s.name }, { name: nowa })
}

/** Wyłączone stanowisko: token daje 401, panel go nie pokazuje. Włączenie przywraca ten sam token. */
export async function ustawWylaczenie(db: Db, id: unknown, wylaczone: boolean, actorId: string, now = new Date()): Promise<void> {
  const s = await stanowisko(db, id)
  await db.printStation.update({ where: { id: s.id }, data: { disabledAt: wylaczone ? (s.disabledAt ?? now) : null } })
  await audyt(db, s.id, actorId, { disabled: !!s.disabledAt }, { disabled: wylaczone })
}

/** Nowy token — poprzedni przestaje działać od razu. Zwraca token i kod instalacyjny (pokazać raz, nigdzie nie zapisywać). */
export async function nowyToken(db: Db, id: unknown, serwer: string, actorId: string, now = new Date()): Promise<{ token: string; kod: string; stanowisko: string }> {
  const s = await stanowisko(db, id)
  if (s.disabledAt) throw new BladDruku('Stanowisko jest wyłączone — najpierw je włącz', 409)
  const { token, hash } = nowyTokenStanowiska()
  await db.printStation.update({ where: { id: s.id }, data: { tokenHash: hash, tokenCreatedAt: now } })
  await audyt(db, s.id, actorId, { token: s.tokenHash ? 'był' : 'brak' }, { token: 'nowy', tokenCreatedAt: now.toISOString() })
  return { token, kod: kodInstalacyjny(serwer, s.code, token), stanowisko: s.name }
}

export async function uniewaznijToken(db: Db, id: unknown, actorId: string): Promise<void> {
  const s = await stanowisko(db, id)
  await db.printStation.update({ where: { id: s.id }, data: { tokenHash: null, tokenCreatedAt: null } })
  await audyt(db, s.id, actorId, { token: s.tokenHash ? 'był' : 'brak' }, { token: 'unieważniony' })
}

const takieSamo = (a: Przypisanie, b: Przypisanie) => a.rola === b.rola && (a.stanowisko ?? null) === (b.stanowisko ?? null)

/**
 * Przypisanie rodzaj wydruku → drukarka. Wpis: rola (drukarka tego komputera, jak dotąd) albo `<id stanowiska>:<rola>`
 * (drukarka innego stanowiska). Własna rola: według wzoru i z ostatniego raportu (albo dowolna ze wzoru, gdy
 * raportu jeszcze nie ma). Inne stanowisko: tylko tej samej firmy (klient z RLS + jawne organizationId), włączone i z
 * tą drukarką w ostatnim raporcie. Wpis bez zmiany przechodzi zawsze (formularz wysyła wszystkie pola naraz).
 */
export async function ustawRouting(db: Db, id: unknown, wpisy: Partial<Record<string, unknown>>, actorId: string): Promise<void> {
  const s = await stanowisko(db, id)
  const z = przypisaniaStanowiska(s.routing, s.id)
  const role = roleZRaportu(s.printers)
  const nowy = { ...z }
  const org = organizationIdOf(db)
  for (const [typ, wartosc] of Object.entries(wpisy)) {
    if (!jestTypZlecenia(typ)) continue
    const p = parsujWartoscPrzypisania(wartosc)
    if (!p || !jestRola(p.rola)) throw new BladDruku(`Nieznana rola drukarki dla „${typ}”`, 400)
    const wpis: Przypisanie = p.stanowisko && p.stanowisko !== s.id ? { rola: p.rola, stanowisko: p.stanowisko } : { rola: p.rola }
    if (!takieSamo(wpis, z[typ])) {
      if (!wpis.stanowisko) {
        if (role.length && !role.includes(wpis.rola)) throw new BladDruku(`Stanowisko nie zgłasza drukarki ${wpis.rola}`, 400)
      } else {
        const c = WZOR_ID_STANOWISKA.test(wpis.stanowisko) ? await db.printStation.findUnique({ where: { id: wpis.stanowisko }, select: { organizationId: true, name: true, disabledAt: true, printers: true } }) : null
        if (!c || c.organizationId !== org) throw new BladDruku('Nie ma takiego stanowiska druku — odśwież stronę', 400)
        if (c.disabledAt) throw new BladDruku(`Stanowisko „${c.name}” jest wyłączone — wybierz drukarkę włączonego komputera`, 400)
        if (!roleZRaportu(c.printers).includes(wpis.rola)) throw new BladDruku(`Stanowisko „${c.name}” nie zgłasza drukarki ${wpis.rola}`, 400)
      }
    }
    nowy[typ] = wpis
  }
  if (TYPY_ZLECEN.every((t) => takieSamo(nowy[t], z[t]))) return
  await db.printStation.update({ where: { id: s.id }, data: { routing: routingDoZapisu(nowy) } })
  await audyt(db, s.id, actorId, { routing: routingDoZapisu(z) }, { routing: routingDoZapisu(nowy) })
}

/**
 * włączone stanowiska firmy, które drukują coś na drukarkach stanowiska `id` (ostrzeżenie przy wyłączaniu).
 * Wynik: nazwa stanowiska i rodzaje wydruków.
 */
export function ktoKorzystaZDrukarek(id: string, stanowiska: { id: string; name: string; routing: unknown; disabledAt: Date | null }[]): { nazwa: string; typy: TypZlecenia[] }[] {
  const out: { nazwa: string; typy: TypZlecenia[] }[] = []
  for (const s of stanowiska) {
    if (s.id === id || s.disabledAt) continue
    const p = przypisaniaStanowiska(s.routing, s.id)
    const typy = TYPY_ZLECEN.filter((t) => p[t].stanowisko === id)
    if (typy.length) out.push({ nazwa: s.name, typy })
  }
  return out
}

/** Lista stanowisk do ekranu ustawień (z wyłączonymi), bez tokenów. */
export async function stanowiskaUstawien(db: Db) {
  const rows = await db.printStation.findMany({
    orderBy: [{ disabledAt: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
    select: { id: true, code: true, name: true, tokenHash: true, tokenCreatedAt: true, routing: true, printers: true, agentVersion: true, lastReportAt: true, disabledAt: true },
  })
  return rows.map(({ tokenHash, ...r }) => ({ ...r, maToken: !!tokenHash, przypisania: przypisaniaStanowiska(r.routing, r.id) }))
}
