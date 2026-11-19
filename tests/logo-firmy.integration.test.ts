// logo firmy (Ustawienia → Dane firmy) — wgranie przez osłonę uploadu (podmieniony typ, SVG, za duży plik,
// nazwa ze ścieżką), zapis od nowa przez sharp, wersja do wydruku ≤ 64 KB, bajty w bazie (przeglądu: worker z innym
// wolumenem widzi logo), zmiana i usunięcie do old/ (nigdy kasowanie), przeniesienie logo z dysku do bazy, AuditLog,
// izolacja firm, logo na karcie zamówienia i liście wysyłkowej, logo osadzone w mailu (cid). Dane fikcyjne.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { LogoError, logoZUstawien, plikLogo, usunLogo, wgrajLogo } from '@/lib/firma/logo'
import { daneFirmy } from '@/lib/poczta/marka'
import { renderujMail } from '@/lib/maile'
import { DANE_PRZYKLADOWE, KONTEKST_PRZYKLADOWY } from '@/lib/maile/przyklady'
import { LOGO_FIRMY_SRC } from '@/lib/maile/typy'
import { kartaZamowienia } from '@/lib/wydruki/karta-zamowienia'
import { listaWysylkowa } from '@/lib/wydruki/lista-wysylkowa'
import { KARTA, LISTA } from '@/lib/wydruki/przyklady/dane'
import { ORG_B, testDb, testSystemDb, truncateAll } from './db'

const a = testDb()
const b = testDb({ organizationId: ORG_B })
const DIR = mkdtempSync(path.join(tmpdir(), 'kompletor-logo-'))
const ENV = { ZDJECIA_DIR: DIR }
const prevDir = process.env['ZDJECIA_DIR']
beforeAll(() => {
  process.env['ZDJECIA_DIR'] = DIR
})
afterAll(async () => {
  if (prevDir === undefined) delete process.env['ZDJECIA_DIR']
  else process.env['ZDJECIA_DIR'] = prevDir
  await a.$disconnect()
  await b.$disconnect()
})
beforeEach(async () => {
  await truncateAll(a)
})

const png = (w = 900, h = 300) => sharp({ create: { width: w, height: h, channels: 4, background: { r: 20, g: 120, b: 60, alpha: 0.5 } } }).png().toBuffer()
const plik = (bytes: Buffer | string, nazwa: string, typ = 'image/png') => new File([typeof bytes === 'string' ? bytes : new Uint8Array(bytes)], nazwa, { type: typ })
const katalog = (org: string) => path.join(DIR, org, 'firma')

describe('logo firmy: osłona uploadu', () => {
  it('PNG: zapis od nowa w dwóch wersjach (ekran ≤ 600 px, wydruk JPEG ≤ 64 KB), wpis w ustawieniach i AuditLog', async () => {
    const l = await wgrajLogo(a, plik(await png(), '../../../etc/passwd.png'), 'u1', { env: ENV })
    expect(l.szerokosc).toBeLessThanOrEqual(600)
    expect(l.plik).toMatch(/^logo-[a-z0-9]+$/)
    const org = await a.organization.findFirstOrThrow({ select: { id: true, settings: true } })
    expect(logoZUstawien(org.settings)).toEqual(l)
    // bajty w bazie, nie na dysku (nazwa z przeglądarki nie trafia nigdzie)
    expect(existsSync(katalog(org.id))).toBe(false)
    expect(await a.organizationLogo.findFirstOrThrow({ select: { plik: true, zrodlo: true } })).toEqual({ plik: l.plik, zrodlo: 'panel' })
    const druk = await plikLogo(a, 'druk', ENV)
    expect(druk!.mime).toBe('image/jpeg')
    expect(druk!.bytes.length).toBeLessThanOrEqual(64 * 1024)
    expect((await plikLogo(a, 'ekran', ENV))!.bytes.subarray(1, 4).toString()).toBe('PNG')
    expect(await a.auditLog.count({ where: { entity: 'Organization.logoFirmy' } })).toBe(1)
  })

  it('podmieniony typ (SVG z nazwą .png i typem image/png), HTML, PDF i GIF: odmowa, nic nie zapisane', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    for (const f of [plik(svg, 'logo.png'), plik('<html><body>x</body></html>', 'logo.jpg', 'image/jpeg'), plik('%PDF-1.4 x', 'logo.png'), plik('GIF89a....', 'logo.png')])
      await expect(wgrajLogo(a, f, 'u1', { env: ENV })).rejects.toThrow('Logo musi być plikiem PNG albo JPG')
    expect(logoZUstawien((await a.organization.findFirstOrThrow({ select: { settings: true } })).settings)).toBeNull()
    expect(await a.auditLog.count({ where: { entity: 'Organization.logoFirmy' } })).toBe(0)
  })

  it('za duży plik: odmowa z rozmiaru, zanim bajty trafią do pamięci', async () => {
    const duzy = plik(Buffer.alloc(3 * 1024 * 1024, 1), 'logo.png')
    Object.defineProperty(duzy, 'arrayBuffer', { value: () => Promise.reject(new Error('nie wolno czytać bajtów za dużego pliku')) })
    await expect(wgrajLogo(a, duzy, 'u1', { env: ENV })).rejects.toBeInstanceOf(LogoError)
    await expect(wgrajLogo(a, null, 'u1', { env: ENV })).rejects.toThrow('Wybierz plik')
  })

  it('zmiana logo przenosi poprzednie do old/, usunięcie też (pliki zostają), druga firma nie widzi logo pierwszej', async () => {
    const l1 = await wgrajLogo(a, plik(await png(), 'a.png'), 'u1', { env: ENV })
    const l2 = await wgrajLogo(a, plik(await sharp({ create: { width: 200, height: 200, channels: 3, background: '#ffffff' } }).jpeg().toBuffer(), 'b.jpg', 'image/jpeg'), 'u1', { env: ENV })
    const org = (await a.organization.findFirstOrThrow({ select: { id: true } })).id
    const dzien = readdirSync(path.join(katalog(org), 'old'))
    expect(dzien).toHaveLength(1)
    const stare = readdirSync(path.join(katalog(org), 'old', dzien[0]!))
    expect(stare.filter((f) => f.endsWith(`_${l1.plik}.png`) || f.endsWith(`_${l1.plik}-p.jpg`))).toHaveLength(2)
    expect((await plikLogo(a, 'ekran', ENV))!.logo.plik).toBe(l2.plik)
    expect(await plikLogo(b, 'ekran', ENV)).toBeNull()
    expect(await b.organizationLogo.count()).toBe(0) // RLS: druga firma nie widzi wiersza

    expect(await usunLogo(a, 'u1', { env: ENV })).toBe(true)
    expect(await plikLogo(a, 'ekran', ENV)).toBeNull()
    expect(await a.organizationLogo.count()).toBe(0)
    expect(readdirSync(path.join(katalog(org), 'old', dzien[0]!)).some((f) => f.endsWith(`_${l2.plik}.png`))).toBe(true)
    expect(await usunLogo(a, 'u1', { env: ENV })).toBe(false)
  })

  it('zapis profilu firmy nie kasuje logo (osobny klucz ustawień)', async () => {
    await wgrajLogo(a, plik(await png(), 'a.png'), 'u1', { env: ENV })
    const { zapiszProfilFirmy } = await import('@/lib/firma/zapis')
    await zapiszProfilFirmy(a, { nazwa: 'Firma Fikcyjna Sp. z o.o.', nip: '', ulica: 'ul. Testowa 1', kodPocztowy: '00-001', miasto: 'Testowo', kodKraju: 'PL', email: '', emailBiura: '', telefon: '', rachunek: '' }, 'u1')
    expect(await plikLogo(a, 'ekran', ENV)).not.toBeNull()
    // stopka maili z profilu (Dane firmy): nazwa i adres
    const f = await daneFirmy(a, { officeEmail: null, fromEmail: 'sklep@example.com' })
    expect(f).toMatchObject({ nazwa: 'Firma Fikcyjna Sp. z o.o.', adres: ['ul. Testowa 1', '00-001 Testowo'], email: 'sklep@example.com' })
  })
})

describe('logo w bazie: osobne wolumeny panelu i workera, logo sprzed zmiany na dysku', () => {
  it('worker z innym katalogiem zdjęć (osobny wolumen) czyta to samo logo z bazy', async () => {
    const l = await wgrajLogo(a, plik(await png(), 'a.png'), 'u1', { env: ENV })
    const worker = { ZDJECIA_DIR: mkdtempSync(path.join(tmpdir(), 'kompletor-logo-worker-')) }
    const panel = await plikLogo(a, 'ekran', ENV)
    const zWorkera = await plikLogo(a, 'ekran', worker)
    expect(zWorkera!.logo.plik).toBe(l.plik)
    expect(Buffer.compare(zWorkera!.bytes, panel!.bytes)).toBe(0)
    expect((await plikLogo(a, 'druk', worker))!.mime).toBe('image/jpeg')
    expect(readdirSync(worker.ZDJECIA_DIR)).toEqual([])
  })

  it('logo sprzed zmiany (pliki na dysku, bez wiersza): pierwszy odczyt w kontenerze z plikami przenosi je do bazy, pliki do old/', async () => {
    const org = (await a.organization.findFirstOrThrow({ select: { id: true } })).id
    const plikStary = 'logo-0123456789abcdef'
    mkdirSync(katalog(org), { recursive: true })
    const ekran = await png(300, 100)
    const druk = await sharp(ekran).flatten({ background: '#ffffff' }).jpeg().toBuffer()
    writeFileSync(path.join(katalog(org), `${plikStary}.png`), ekran)
    writeFileSync(path.join(katalog(org), `${plikStary}-p.jpg`), druk)
    await testSystemDb().organization.update({ where: { id: org }, data: { settings: { logoFirmy: { plik: plikStary, szerokosc: 300, wysokosc: 100, od: '2026-11-08T10:00:00.000Z' } } as never } })

    const worker = { ZDJECIA_DIR: mkdtempSync(path.join(tmpdir(), 'kompletor-logo-worker-')) }
    const blad = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // worker przed panelem: pliku nie ma, logo brak, jeden wpis w logu mimo kilku odczytów
      expect(await plikLogo(a, 'ekran', worker)).toBeNull()
      expect(await plikLogo(a, 'ekran', worker)).toBeNull()
      expect(blad.mock.calls.filter((c) => String(c[0]).includes(plikStary))).toHaveLength(1)
    } finally {
      blad.mockRestore()
    }

    const zPanelu = await plikLogo(a, 'druk', ENV)
    expect(Buffer.compare(zPanelu!.bytes, druk)).toBe(0)
    expect(await a.organizationLogo.findFirstOrThrow({ select: { plik: true, zrodlo: true } })).toEqual({ plik: plikStary, zrodlo: 'dysk' })
    expect(existsSync(path.join(katalog(org), `${plikStary}.png`))).toBe(false)
    const dzien = readdirSync(path.join(katalog(org), 'old'))
    expect(readdirSync(path.join(katalog(org), 'old', dzien[0]!)).filter((f) => f.includes(plikStary))).toHaveLength(2)
    // teraz worker widzi logo z bazy
    expect(Buffer.compare((await plikLogo(a, 'ekran', worker))!.bytes, ekran)).toBe(0)
  })
})

describe('logo na wydrukach i w mailach', () => {
  it('karta zamówienia i lista wysyłkowa z logo: PDF z obrazem; zepsute logo = wydruk bez logo', async () => {
    await wgrajLogo(a, plik(await png(), 'a.png'), 'u1', { env: ENV })
    const logo = (await plikLogo(a, 'druk', ENV))!.bytes
    const obrazy = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Subtype \/Image/g) ?? []).length
    const bez = await kartaZamowienia({ ...KARTA, pozycje: KARTA.pozycje.map((p) => ({ ...p, miniatura: null })) })
    const z = await kartaZamowienia({ ...KARTA, pozycje: KARTA.pozycje.map((p) => ({ ...p, miniatura: null })), logo })
    expect(obrazy(z)).toBe(obrazy(bez) + 1)
    expect(obrazy(await listaWysylkowa({ ...LISTA, logo }))).toBeGreaterThan(obrazy(await listaWysylkowa(LISTA)))
    expect(obrazy(await kartaZamowienia({ ...KARTA, pozycje: [], logo: Buffer.from('to nie obraz') }))).toBe(0)
  })

  it('mail: logo firmy osadzone przez cid przechodzi walidację marki', () => {
    const m = renderujMail('faktura', { ...KONTEKST_PRZYKLADOWY, sklep: { ...KONTEKST_PRZYKLADOWY.sklep, logoUrl: LOGO_FIRMY_SRC } }, DANE_PRZYKLADOWE.faktura)
    expect(m.html).toContain(`src="${LOGO_FIRMY_SRC}"`)
    expect(() => renderujMail('faktura', { ...KONTEKST_PRZYKLADOWY, sklep: { ...KONTEKST_PRZYKLADOWY.sklep, logoUrl: 'cid:cos-innego' } }, DANE_PRZYKLADOWE.faktura)).toThrow()
  })

  it('wersja ustawień bez logo (stare dane) = brak logo bez błędu', async () => {
    await testSystemDb().organization.update({ where: { id: 'test_a' }, data: { settings: { logoFirmy: { plik: '../zly', szerokosc: 1, wysokosc: 1 } } as never } })
    expect(await plikLogo(a, 'ekran', ENV)).toBeNull()
  })
})
