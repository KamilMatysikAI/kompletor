// zdjęcia produktów w bazie zamiast w katalogu na dysku. Panel i worker w osobnych kontenerach (osobne
// katalogi ZDJECIA_DIR) widzą te same zdjęcia; zdjęcia sprzed zmiany przenosi do bazy `przeniesZdjeciaZDysku`
// (idempotentnie, pliki zostają) albo pierwszy odczyt. Izolacja firm (RLS) na nowej tabeli. Dane wyłącznie fikcyjne.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_WAREHOUSE } from '@/lib/rdzen/stan'
import { zalozProduktReczny } from '@/lib/produkty/karta'
import { BrakPlikuZdjecia, dodajZdjecia, miniaturyDoWydruku, plikZdjecia, przeniesZdjeciaZDysku, przetworz, usunZdjecie } from '@/lib/produkty/zdjecia'
import { ORG_B, testDb, truncateAll } from './db'

const a = testDb()
const b = testDb({ organizationId: ORG_B })
const USER = 'uzytkownik-testowy-a123'

afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})
beforeEach(async () => {
  await truncateAll()
  await a.warehouse.create({ data: { id: DEFAULT_WAREHOUSE, name: 'Główny (test)' } })
})

const png = (color: string) => sharp({ create: { width: 320, height: 240, channels: 3, background: color } }).png().toBuffer()
const pustyKatalog = () => ({ ZDJECIA_DIR: mkdtempSync(path.join(tmpdir(), 'kompletor-a123-')) })

async function produkt(sku = 'A123-1') {
  const r = await zalozProduktReczny(a, { rodzaj: 'zwykly', sku, form: { nazwa: `Produkt ${sku}` } }, USER, { hasWfirma: false })
  if (!r.ok) throw new Error(r.error)
  return r.productId
}

/** Zdjęcie sprzed przeniesienia do bazy: wiersz ProductImage bez bajtów w bazie i pliki w katalogu firmy na dysku. */
async function zdjecieNaDysku(productId: string, env: { ZDJECIA_DIR: string }, id: string, opts: { bezMiniatury?: boolean; bezPliku?: boolean } = {}) {
  const p = await przetworz(await png('#963'))
  await a.productImage.create({ data: { id, productId, position: await a.productImage.count({ where: { productId } }), width: p.width, height: p.height, bytes: p.full.length, actorId: USER } })
  if (opts.bezPliku) return p
  const dir = path.join(env.ZDJECIA_DIR, 'test_a')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `${id}.webp`), p.full)
  if (!opts.bezMiniatury) writeFileSync(path.join(dir, `${id}-m.webp`), p.mini)
  writeFileSync(path.join(dir, `${id}-p.jpg`), p.druk)
  return p
}

describe('zdjęcia w bazie', () => {
  it('zdjęcie zapisane w jednym kontenerze widać w drugim (inny, pusty katalog), bez plików na dysku', async () => {
    const id = await produkt()
    const worker = pustyKatalog()
    const panel = pustyKatalog()
    const prev = process.env['ZDJECIA_DIR']
    process.env['ZDJECIA_DIR'] = worker.ZDJECIA_DIR
    try {
      const r = await dodajZdjecia(a, id, [{ bytes: await png('#2a6'), nazwa: 'z.png', sourceUrl: 'https://sklep.example/z.png' }], 'system:zdjecia-z-oferty')
      expect(r.dodane).toHaveLength(1)
      expect(readdirSync(worker.ZDJECIA_DIR)).toEqual([])
      for (const w of ['o', 'm', 'p'] as const) {
        const f = await plikZdjecia(a, r.dodane[0]!, w, panel)
        expect(f?.mime).toBe(w === 'p' ? 'image/jpeg' : 'image/webp')
        expect((await sharp(f!.bytes).metadata()).format).toBe(w === 'p' ? 'jpeg' : 'webp')
      }
      expect(await a.productImageData.findUniqueOrThrow({ where: { imageId: r.dodane[0]! }, select: { zrodlo: true, productId: true } })).toEqual({ zrodlo: 'panel', productId: id })
    } finally {
      if (prev === undefined) delete process.env['ZDJECIA_DIR']
      else process.env['ZDJECIA_DIR'] = prev
    }
  })

  it('usunięcie: zdjęcie znika z produktu, bajty zostają w archiwum; obca firma nie widzi bajtów (RLS)', async () => {
    const id = await produkt()
    const r = await dodajZdjecia(a, id, [{ bytes: await png('#36c'), nazwa: 'a.png' }], USER)
    const img = r.dodane[0]!
    expect(await b.productImageData.count()).toBe(0)
    expect(await b.productImageData.findUnique({ where: { imageId: img } })).toBeNull()
    await expect(b.productImageData.updateMany({ where: { imageId: img }, data: { archivedAt: new Date() } })).resolves.toEqual({ count: 0 })
    expect(await usunZdjecie(a, img, USER)).toBe(id)
    expect(await plikZdjecia(a, img, 'm', pustyKatalog())).toBeNull()
    const arch = await a.productImageData.findUniqueOrThrow({ where: { imageId: img } })
    expect(arch.archivedAt).toBeInstanceOf(Date)
    expect(arch.full.length).toBeGreaterThan(0)
  })

  it('przeniesienie z dysku: idempotentne, pliki zostają, brakująca miniatura odtworzona, brak pliku policzony', async () => {
    const id = await produkt()
    const env = pustyKatalog()
    const p1 = await zdjecieNaDysku(id, env, 'stare000000000000001')
    await zdjecieNaDysku(id, env, 'stare000000000000002', { bezMiniatury: true })
    await zdjecieNaDysku(id, env, 'stare000000000000003', { bezPliku: true })
    const nowe = await dodajZdjecia(a, id, [{ bytes: await png('#c33'), nazwa: 'n.png' }], USER)

    expect(await przeniesZdjeciaZDysku(a, { env })).toEqual({ przeniesione: 2, brakPliku: 1, bledy: [], przerwane: false })
    expect(await przeniesZdjeciaZDysku(a, { env })).toEqual({ przeniesione: 0, brakPliku: 1, bledy: [], przerwane: false })
    expect(existsSync(path.join(env.ZDJECIA_DIR, 'test_a', 'stare000000000000001.webp'))).toBe(true)
    const d1 = await a.productImageData.findUniqueOrThrow({ where: { imageId: 'stare000000000000001' } })
    expect(Buffer.from(d1.full).equals(p1.full)).toBe(true)
    expect(d1.zrodlo).toBe('dysk')
    const d2 = await a.productImageData.findUniqueOrThrow({ where: { imageId: 'stare000000000000002' } })
    expect(await sharp(Buffer.from(d2.mini)).metadata()).toMatchObject({ format: 'webp', width: 160, height: 160 })
    expect(await a.productImageData.count({ where: { imageId: nowe.dodane[0]! } })).toBe(1)

    // po przeniesieniu panel z innym katalogiem widzi zdjęcia; brak pliku = 503 z opisem (BrakPlikuZdjecia)
    expect(await plikZdjecia(a, 'stare000000000000001', 'm', pustyKatalog())).not.toBeNull()
    await expect(plikZdjecia(a, 'stare000000000000003', 'm', pustyKatalog())).rejects.toBeInstanceOf(BrakPlikuZdjecia)
    // druga firma: swoje przeniesienie nie dotyka zdjęć firmy A
    expect(await przeniesZdjeciaZDysku(b, { env })).toEqual({ przeniesione: 0, brakPliku: 0, bledy: [], przerwane: false })
  })

  it('pierwszy odczyt zdjęcia sprzed zmiany: plik z dysku tego kontenera, od razu dopisany do bazy', async () => {
    const id = await produkt()
    const env = pustyKatalog()
    await zdjecieNaDysku(id, env, 'stare000000000000009')
    expect(await a.productImageData.count()).toBe(0)
    const f = await plikZdjecia(a, 'stare000000000000009', 'p', env)
    expect(f?.mime).toBe('image/jpeg')
    expect(await a.productImageData.count({ where: { imageId: 'stare000000000000009', zrodlo: 'dysk' } })).toBe(1)
    expect(await plikZdjecia(a, 'stare000000000000009', 'o', pustyKatalog())).not.toBeNull()
  })

  it('limit czasu: przebieg z minionym terminem nic nie robi i mówi, że przerwany', async () => {
    const id = await produkt()
    const env = pustyKatalog()
    await zdjecieNaDysku(id, env, 'stare000000000000005')
    expect(await przeniesZdjeciaZDysku(a, { env, doKiedy: Date.now() - 1 })).toMatchObject({ przeniesione: 0, przerwane: true })
    expect(await a.productImageData.count()).toBe(0)
  })

  it('miniatury do wydruku jednym zapytaniem dla wielu produktów, także po przeniesieniu z dysku', async () => {
    const p1 = await produkt('A123-W1')
    const p2 = await produkt('A123-W2')
    const p3 = await produkt('A123-W3')
    await dodajZdjecia(a, p1, [{ bytes: await png('#111'), nazwa: '1.png' }], USER)
    const env = pustyKatalog()
    await zdjecieNaDysku(p2, env, 'stare000000000000007')
    const m = await miniaturyDoWydruku(a, [p1, p2, p3], env)
    expect([...m.keys()].sort()).toEqual([p1, p2].sort())
    for (const buf of m.values()) expect(await sharp(buf).metadata()).toMatchObject({ format: 'jpeg', width: 96, height: 96 })
  })
})
