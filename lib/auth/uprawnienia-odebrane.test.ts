// Uprawnienia odebrane osobie z zestawu roli: jedno miejsce liczenia (`permissionsOf`) i strażnik, że każdy odczyt
// członkostwa z bazy przynosi kolumnę odebranych (inaczej odebrane uprawnienie wracałoby osobie po cichu).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ALL_PERMISSIONS, brakujaceZaleznosci, can, permissionsOf, uprawnieniaRoli, type UprawnieniaOsoby } from './uprawnienia'
import { roznicaWzgledemRoli, zestawStartowy } from '@/app/(panel)/ustawienia/uzytkownicy/rola'

describe('permissionsOf: (rola ∪ dołożone) − odebrane', () => {
  it('odebrane z zestawu roli znika, dołożone dochodzi', () => {
    const m = { role: 'BIURO' as const, permissions: ['zwroty.pieniadze'], deniedPermissions: ['klienci.dane', 'raporty.sprzedaz'] }
    expect(can(m, 'klienci.dane')).toBe(false)
    expect(can(m, 'raporty.sprzedaz')).toBe(false)
    expect(can(m, 'zwroty.pieniadze')).toBe(true)
    expect(can(m, 'panel.podglad')).toBe(true)
    expect(permissionsOf(m).size).toBe(uprawnieniaRoli('BIURO').size + 1 - 2)
  })
  it('bez kolumny odebranych (stary zapis) = dawne zachowanie', () => {
    // typ wymaga pola; tu wiersz z bazy sprzed migracji, w którym kolumny nie ma wcale
    expect(permissionsOf({ role: 'MAGAZYN', permissions: [] } as unknown as UprawnieniaOsoby)).toEqual(uprawnieniaRoli('MAGAZYN'))
    expect(permissionsOf({ role: 'MAGAZYN', permissions: [], deniedPermissions: null })).toEqual(uprawnieniaRoli('MAGAZYN'))
  })
  it('rola Właściciel ma zawsze komplet, nawet gdy w bazie leżą odebrane', () => {
    expect([...permissionsOf({ role: 'WLASCICIEL', permissions: [], deniedPermissions: ['uzytkownicy', 'ustawienia'] })].sort()).toEqual([...ALL_PERMISSIONS].sort())
  })
  it('nieznane nazwy nic nie dają i nic nie odbierają', () => {
    const m = { role: 'MAGAZYN' as const, permissions: ['nie.ma.takiego'], deniedPermissions: ['też.nie', '__proto__'] }
    expect(permissionsOf(m)).toEqual(uprawnieniaRoli('MAGAZYN'))
  })
  it('odebrane i jednocześnie dołożone: wygrywa odebranie', () => {
    expect(can({ role: 'BIURO', permissions: ['klienci.dane'], deniedPermissions: ['klienci.dane'] }, 'klienci.dane')).toBe(false)
  })
})

describe('zależności', () => {
  it('podgląd panelu potrzebny zawsze (także pusty zestaw); sam podgląd w porządku', () => {
    expect(brakujaceZaleznosci(new Set())).toEqual([{ uprawnienie: null, wymaga: 'panel.podglad' }])
    expect(brakujaceZaleznosci(new Set(['panel.podglad']))).toEqual([])
    expect(brakujaceZaleznosci(new Set(['panel.podglad', 'klienci.dane']))).toEqual([])
    expect(brakujaceZaleznosci(new Set(['klienci.dane']))).toEqual([{ uprawnienie: 'klienci.dane', wymaga: 'panel.podglad' }])
  })
})

describe('ekran: zestaw startowy i różnica względem roli', () => {
  it('po wyborze roli: zestaw roli, a uprawnienia, których zmieniający nie ma, zostają jak u osoby', () => {
    const obecne = new Set(['panel.podglad', 'pakowanie.stanowisko'] as const)
    const allowed = [...uprawnieniaRoli('BIURO')] // biuro nie ma stanowiska pakowania
    const z = zestawStartowy('BIURO', obecne, allowed)
    expect(z.has('pakowanie.stanowisko')).toBe(true)
    expect(z.has('klienci.dane')).toBe(true)
    expect(zestawStartowy('MAGAZYN', new Set(), allowed).has('pakowanie.stanowisko')).toBe(false)
  })
  it('różnica: dołożone i odebrane', () => {
    const z = new Set(uprawnieniaRoli('MAGAZYN'))
    z.delete('klienci.skrot')
    z.add('raporty.sprzedaz')
    expect(roznicaWzgledemRoli('MAGAZYN', z)).toEqual({ dolozone: ['raporty.sprzedaz'], odebrane: ['klienci.skrot'] })
  })
})

/** Pliki źródłowe aplikacji (bez testów i zależności). */
function zrodla(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n.startsWith('.')) continue
    const p = join(dir, n)
    if (statSync(p).isDirectory()) zrodla(p, out)
    else if (/\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n)) out.push(p)
  }
  return out
}

/**
 * Odczyty Prisma: w pliku tyle samo `permissions: true` co `deniedPermissions: true`. Liczymy wystąpienia w całym pliku,
 * więc zagnieżdżone `select` (klamry w środku) niczego nie ukrywają. Zwraca różnicę (0 = w porządku).
 */
function roznicaSelectow(zrodlo: string): number {
  const ile = (re: RegExp) => [...zrodlo.matchAll(re)].length
  return ile(/(?<![A-Za-z0-9_$])permissions\s*:\s*true\b/g) - ile(/\bdeniedPermissions\s*:\s*true\b/g)
}

/**
 * Surowy SQL: każdy szablon (tekst między backtickami) z tabelą "Membership" i kolumną permissions (z dowolnym aliasem,
 * w cudzysłowie albo bez) musi czytać też "deniedPermissions". Zwraca liczbę szablonów bez tej kolumny.
 */
function sqlBezOdebranych(zrodlo: string): number {
  let bledy = 0
  for (const m of zrodlo.matchAll(/"Membership"/g)) {
    const i = m.index ?? 0
    const start = zrodlo.lastIndexOf('`', i)
    const koniec = zrodlo.indexOf('`', i)
    if (start < 0 || koniec < 0) continue
    const sql = zrodlo.slice(start, koniec)
    if (/(?<![A-Za-z0-9_$])"?permissions\b/.test(sql) && !sql.includes('"deniedPermissions"')) bledy++
  }
  return bledy
}

describe('strażnik: każdy odczyt członkostwa przynosi odebrane', () => {
  const root = join(__dirname, '..', '..')
  const pliki = ['app', 'lib', 'worker', 'scripts'].flatMap((d) => zrodla(join(root, d)))
  it('w każdym pliku tyle samo `permissions: true` co `deniedPermissions: true`', () => {
    const bledy = pliki.filter((p) => roznicaSelectow(readFileSync(p, 'utf8')) !== 0).map((p) => relative(root, p))
    expect(bledy).toEqual([])
  })
  it('surowy SQL z "Membership" i permissions czyta też "deniedPermissions" (każdy alias)', () => {
    const bledy = pliki.filter((p) => sqlBezOdebranych(readFileSync(p, 'utf8')) > 0).map((p) => relative(root, p))
    expect(bledy).toEqual([])
  })
  it('łapie zagnieżdżony select bez odebranych (dawne wyrażenie kończyło się na pierwszej klamrze)', () => {
    const zly = "db.membership.findMany({ select: { user: { select: { email: true } }, role: true, permissions: true } })"
    const dobry = "db.membership.findMany({ select: { user: { select: { email: true } }, role: true, permissions: true, deniedPermissions: true } })"
    expect(roznicaSelectow(zly)).toBe(1)
    expect(roznicaSelectow(dobry)).toBe(0)
  })
  it('łapie surowy SQL z innym aliasem albo bez aliasu', () => {
    const innyAlias = 'db.$queryRaw`SELECT c.role, c.permissions FROM "Membership" c WHERE c."organizationId" = ${id}`'
    const bezAliasu = 'db.$queryRaw`SELECT role, "permissions" FROM "Membership" WHERE "organizationId" = ${id}`'
    const dobry = 'db.$queryRaw`SELECT c.role, c.permissions, c."deniedPermissions" FROM "Membership" c`'
    expect(sqlBezOdebranych(innyAlias)).toBe(1)
    expect(sqlBezOdebranych(bezAliasu)).toBe(1)
    expect(sqlBezOdebranych(dobry)).toBe(0)
  })
  it('uprawnienia z roli i dołożonych liczy tylko permissionsOf (bez własnych kopii ROLE_DEFAULTS)', () => {
    const bledy = pliki.filter((p) => !p.endsWith(join('auth', 'uprawnienia.ts')) && /ROLE_DEFAULTS/.test(readFileSync(p, 'utf8'))).map((p) => relative(root, p))
    expect(bledy).toEqual([])
  })
})
