// Ustawienia → Kanały sprzedaży → konto → „Łączenie ofert z produktami” → „Do decyzji”: każda pozycja niesie
// pasujące produkty (kandydatów po EAN, SKU, SKU innej wielkości liter, SKU z zerami na początku), ekran pokazuje je
// z „Powiąż” tylko osobie z `produkty.dodawanie`, a akcja „Powiąż” (ta sama co na karcie produktu) sprawdza uprawnienie
// i odświeża ekran konta, więc powiązana oferta znika z listy. Automat dalej tych ofert sam nie łączy.
// Dane fikcyjne, zero połączeń zewnętrznych.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement } from 'react'
import { kodKonta } from '@/lib/kanaly/konta'
import { LIMIT_KANDYDATOW, planLaczenia, polaczMasowo } from '@/lib/produkty/powiazania'
import { testDb, truncateAll } from './db'
import { ACC, product, seedBase, T0 } from './rdzen-fixtures'

vi.mock('server-only', () => ({}))
// render tabeli poza aplikacją: router i adres jako atrapy (klikalne wiersze, zaznaczanie)
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => '/ustawienia/kanaly/WOO.sd',
  useSearchParams: () => new URLSearchParams(),
  redirect: (url: string) => {
    throw new Error(`PRZEKIEROWANIE ${url}`)
  },
}))
vi.mock('next/headers',() => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }), headers: async () => new Headers() }))
const odswiezone = vi.hoisted(() => ({ sciezki: [] as string[] }))
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => void odswiezone.sciezki.push(p) }))
const sesja = vi.hoisted(() => ({ db: null as unknown, uprawnienia: new Set<string>() }))
vi.mock('@/lib/panel/kontekst', () => ({
  requirePermission: async (u: string) => {
    if (!sesja.uprawnienia.has(u)) throw new Error(`brak uprawnienia ${u}`)
    return { db: sesja.db, user: { id: 'user:u1' }, permissions: sesja.uprawnienia }
  },
}))

const { powiazAkcja } = await import('@/app/(panel)/produkty/[id]/powiazania-akcje')
const { LaczenieOfert } = await import('@/app/(panel)/ustawienia/kanaly/[konto]/laczenie')

const db = testDb()
sesja.db = db
afterAll(async () => {
  await db.$disconnect()
})
beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  odswiezone.sciezki = []
  sesja.uprawnienia = new Set()
})

const SD = ACC.WOO_SD
const EAN_KUBEK = '5901234123457'
const EAN_WSPOLNY = '4006381333931'

async function oferty(rows: { externalId: string; sku?: string | null; ean?: string | null; name?: string }[]) {
  await db.channelOfferRead.createMany({
    data: rows.map((r) => ({ ...SD, externalId: r.externalId, sku: r.sku ?? null, ean: r.ean ?? null, name: r.name ?? `Oferta ${r.externalId}`, qty: 1, state: 'BEZ_PRODUKTU' as const, runId: 'run-a302', seenAt: T0 })),
  })
}

async function zEan(sku: string, ean: string, opts: { unit?: 'SZT' | 'KG' } = {}): Promise<string> {
  const id = await product(db, sku, 3, opts)
  await db.product.update({ where: { id }, data: { ean } })
  return id
}

describe('kandydaci w „Do decyzji”', () => {
  it('po EAN: kilka ofert tego samego towaru i kilka produktów z tym EAN niosą pasujące produkty', async () => {
    const kubek = await zEan('KUBEK-Z', EAN_KUBEK)
    const a = await zEan('WSP-A', EAN_WSPOLNY)
    const b = await zEan('WSP-B', EAN_WSPOLNY, { unit: 'KG' })
    await oferty([
      { externalId: '1001', ean: EAN_KUBEK, name: 'Kubek ceramiczny żółty' },
      { externalId: '1002', ean: EAN_KUBEK, name: 'Kubek ceramiczny żółty' },
      { externalId: '1003', ean: EAN_WSPOLNY },
    ])
    const plan = await planLaczenia(db, SD, 'EAN')
    expect(plan.polaczy).toEqual([])
    const d = new Map(plan.decyzja.map((x) => [x.externalId, x]))
    expect(d.get('1001')!.powod).toContain('ma kilka ofert tego konta')
    expect(d.get('1001')!.kandydaci).toEqual([{ id: kubek, sku: 'KUBEK-Z', title: expect.any(String), unit: 'SZT' }])
    expect(d.get('1002')!.kandydaci!.map((p) => p.id)).toEqual([kubek])
    expect(d.get('1003')!.powod).toContain('kilka produktów ma ten EAN')
    expect(new Set(d.get('1003')!.kandydaci!.map((p) => p.id))).toEqual(new Set([a, b]))
    expect(d.get('1003')!.kandydaci!.find((p) => p.id === b)!.unit).toBe('KG')
    expect(d.get('1003')!.kandydatowWiecej).toBe(0)
  })

  it('po SKU: inna wielkość liter i zera na początku (jeden i kilka produktów) też z kandydatami', async () => {
    const wielkosc = await product(db, 'Herb-ABC', 2)
    const zero = await product(db, '01505', 2)
    const z1 = await product(db, '0777', 2)
    const z2 = await product(db, '00777', 2)
    await oferty([
      { externalId: '2001', sku: 'HERB-abc' },
      { externalId: '2002', sku: '1505' },
      { externalId: '2003', sku: '777' },
    ])
    const plan = await planLaczenia(db, SD, 'SKU')
    const d = new Map(plan.decyzja.map((x) => [x.externalId, x]))
    expect(d.get('2001')!.powod).toContain('wielkością liter')
    expect(d.get('2001')!.kandydaci!.map((p) => p.id)).toEqual([wielkosc])
    expect(d.get('2002')!.produkt?.id).toBe(zero)
    expect(d.get('2002')!.kandydaci!.map((p) => p.id)).toEqual([zero])
    expect(d.get('2003')!.powod).toContain('od kilku produktów')
    expect(new Set(d.get('2003')!.kandydaci!.map((p) => p.id))).toEqual(new Set([z1, z2]))
    // automat sam nie łączy żadnej z nich
    expect(await polaczMasowo(db, SD, 'SKU', ['2001', '2002', '2003'], 'user:u1')).toMatchObject({ polaczone: 0, pominiete: 3 })
  })

  it(`najwyżej ${LIMIT_KANDYDATOW} kandydatów, reszta jako liczba`, async () => {
    for (let i = 0; i < LIMIT_KANDYDATOW + 2; i++) await zEan(`MANY-${i}`, EAN_WSPOLNY)
    await oferty([{ externalId: '3001', ean: EAN_WSPOLNY }])
    const [x] = (await planLaczenia(db, SD, 'EAN')).decyzja
    expect(x!.kandydaci).toHaveLength(LIMIT_KANDYDATOW)
    expect(x!.kandydatowWiecej).toBe(2)
  })
})

describe('„Powiąż” z listy „Do decyzji”', () => {
  it('akcja wymaga produkty.dodawanie, odświeża ekran konta; oferta znika z „Do decyzji”, druga aukcja tego towaru przechodzi do „Połączy”', async () => {
    const kubek = await zEan('KUBEK-Z', EAN_KUBEK)
    await oferty([
      { externalId: '1001', ean: EAN_KUBEK },
      { externalId: '1002', ean: EAN_KUBEK },
    ])
    const form = () => {
      const f = new FormData()
      f.set('produkt', kubek)
      f.set('konto', kodKonta(SD))
      f.set('oferta', '1001')
      f.set('sztuk', '1')
      return f
    }
    // sam dostęp do ustawień nie wystarczy
    sesja.uprawnienia = new Set(['ustawienia'])
    await expect(powiazAkcja({ ok: false, komunikat: null }, form())).rejects.toThrow('brak uprawnienia produkty.dodawanie')
    expect(await db.channelOffer.findFirst({ where: { ...SD, externalId: '1001' } })).toBeNull()

    sesja.uprawnienia = new Set(['ustawienia', 'produkty.dodawanie'])
    const s = await powiazAkcja({ ok: false, komunikat: null }, form())
    expect(s).toMatchObject({ ok: true })
    expect(s.komunikat).toContain('Powiązano')
    expect(odswiezone.sciezki).toContain(`/ustawienia/kanaly/${encodeURIComponent(kodKonta(SD))}`)
    expect(odswiezone.sciezki).toContain(`/produkty/${kubek}`)
    expect(await db.channelOffer.findFirstOrThrow({ where: { ...SD, externalId: '1001' } })).toMatchObject({ productId: kubek, active: true, mappingSource: 'MANUAL' })

    const plan = await planLaczenia(db, SD, 'EAN')
    expect(plan.decyzja.map((x) => x.externalId)).toEqual([])
    expect(plan.polaczy.map((x) => [x.externalId, x.produkt?.id])).toEqual([['1002', kubek]])
  })
})

describe('ekran „Do decyzji”', () => {
  const ekran = async (moze: boolean) => {
    const el = (await LaczenieOfert({ db, refKonta: SD, kod: kodKonta(SD), po: 'EAN', maListe: true, mozePowiazac: moze })) as ReactElement
    return renderToStaticMarkup(el)
  }

  it('kandydaci z nazwą, SKU i odnośnikiem; „Powiąż” tylko z produkty.dodawanie; przelicznik 1000 dla towaru na wagę', async () => {
    const a = await zEan('WSP-A', EAN_WSPOLNY)
    const b = await zEan('WSP-B', EAN_WSPOLNY, { unit: 'KG' })
    await oferty([{ externalId: '1003', ean: EAN_WSPOLNY }])

    const z = await ekran(true)
    expect(z).toContain('Pasujące produkty')
    expect(z).toContain(`href="/produkty/${a}#powiazania"`)
    expect(z).toContain(`href="/produkty/${b}#powiazania"`)
    expect(z).toContain('SKU WSP-A')
    expect(z).toContain('na wagę')
    expect(z).toContain('Kilka produktów ma ten sam EAN albo SKU')
    expect(z.match(/aria-label="Powiąż ofertę 1003 z produktem SKU /g)).toHaveLength(2)
    expect(z).toMatch(/name="sztuk"[^>]*value="1000"|value="1000"[^>]*name="sztuk"/)
    expect(z).not.toContain('Ty widzisz tylko pasujące produkty')

    const bez = await ekran(false)
    expect(bez).toContain(`href="/produkty/${a}#powiazania"`)
    expect(bez).not.toContain('Powiąż ofertę 1003')
    expect(bez).toContain('Ty widzisz tylko pasujące produkty')
  })
})
