// reguła przełączona z panelu na inne konto tego samego przewoźnika (np. kurier DPD do salonów przeniesiony
// na drugie konto DPD). Dotąd nowe konto nie dostawało ustawień, z którymi reguła działała (wymiary, waga paczki), a
// nadawanie wyłączało się bez komunikatu na ekranie. Teraz: pola konta bez wartości w nowym koncie przechodzą z
// poprzedniego, pola z umowy konta (FID-y, środowisko kluczy) nie przechodzą i trafiają do komunikatu, nadawanie jest
// wyłączone i komunikat to mówi. Dane fikcyjne, zero połączeń z przewoźnikiem.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Prisma } from '@prisma/client'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { dodajKontoPrzewoznika, kontaPrzewoznikow, zapiszKontaPrzewoznikow } from '@/lib/wysylka/konta'
import { opisPrzeniesienia, regulyPrzewoznikow, zapiszRegulyPrzewoznikow } from '@/lib/wysylka/reguly'
import { ustawieniaKont } from '@/lib/wysylka/ustawienia-konta'
import { ORG_A, testDb, testSystemDb, truncateAll } from './db'
import { seedBase } from './rdzen-fixtures'

const a = testDb()
const sys = testSystemDb()
const registry = defaultRegistry()
afterAll(async () => {
  await a.$disconnect()
})

const KLUCZ = { APP_ENCRYPTION_KEY: 'b'.repeat(64), APP_MODE: 'self-host' }
const WYMIARY = { defaultSideXCm: 50, defaultSideYCm: 38, defaultSideZCm: 19, defaultWeightKg: 5 }
const wej = (r: Awaited<ReturnType<typeof regulyPrzewoznikow>>[number]) => ({ id: r.id, channel: r.channel ?? '', pattern: r.pattern ?? '', carrier: r.carrier, adapterKey: r.adapterKey ?? '', konto: r.konto ?? '' })
const config = async (id: string) => (await a.carrierRule.findUniqueOrThrow({ where: { id } })).config as Record<string, unknown>
const ustawienia = async () => ustawieniaKont((await sys.organization.findUniqueOrThrow({ where: { id: ORG_A } })).settings)
const pole = async (konto: string, key: string) => (await kontaPrzewoznikow(a, registry)).find((k) => k.id === konto)?.pola.find((p) => p.key === key)?.wartosc

/** Reguła DPD_EMPIK na module DPD z zapisem, ustawienia w configu reguły (stan sprzed panelu kont). */
async function regulaSalonow(cfg: Record<string, unknown>): Promise<string> {
  const r = await a.carrierRule.findFirstOrThrow({ where: { carrier: 'DPD_EMPIK' } })
  await a.carrierRule.update({ where: { id: r.id }, data: { shippingModule: 'DPD_BEZPOSREDNIO', adapterKey: 'dpd.services.zapis.v1', config: cfg as Prisma.InputJsonValue } })
  return r.id
}

async function przelaczNaKonto(id: string, konto: string) {
  const lista = await regulyPrzewoznikow(a, registry)
  const nr = lista.findIndex((x) => x.id === id) + 1
  const w = await zapiszRegulyPrzewoznikow(a, registry, lista.map((x) => (x.id === id ? { ...wej(x), konto } : wej(x))), 'u-a')
  return { w, nr }
}

beforeEach(async () => {
  await truncateAll()
  await seedBase(a)
})

describe('reguła przeniesiona na drugie konto przewoźnika', () => {
  it('stan z produkcji: wymiary i waga przechodzą do nowego konta, FID-y i środowisko nie, nadawanie wyłączone z komunikatem', async () => {
    const id = await regulaSalonow({ payerFid: '79440', masterFid: '79440', empikPayerFid: '416038', srodowisko: 'produkcja', platnosc: 'pay_later', zapisWlaczony: true, ...WYMIARY })
    const nowe = await dodajKontoPrzewoznika(a, registry, { konto: 'dpd', nazwa: 'DPD Salony Empik' }, 'u-a')
    // osoba wpisała w karcie nowego konta jego FID płatnika i środowisko (jak 20.11)
    await zapiszKontaPrzewoznikow(a, registry, [{ id: `dpd~${nowe.sufiks}`, sekrety: {}, pola: { payerFid: '416038', srodowisko: 'produkcja' }, nadawanie: {} }], { actorId: 'u-a', env: KLUCZ })

    const { w, nr } = await przelaczNaKonto(id, nowe.sufiks)

    const u = await ustawienia()
    // nowe konto: swoje FID i środowisko zostają, wymiary i waga przyszły z reguły; FID-y starego konta nie
    expect(u[`dpd~${nowe.sufiks}`]).toEqual({ payerFid: '416038', srodowisko: 'produkcja', ...WYMIARY })
    // stare konto (bez reguł) dostało wszystko, z czym reguła działała (bez zmian)
    expect(u['dpd']).toMatchObject({ payerFid: '79440', masterFid: '79440', empikPayerFid: '416038', srodowisko: 'produkcja', ...WYMIARY })
    // reguła: konto ustawione, nadawanie zdjęte, pola konta poza regułą
    expect(await config(id)).toEqual({ platnosc: 'pay_later', sekretyKonta: nowe.sufiks })
    expect(w.przeniesione).toHaveLength(1)
    const p = w.przeniesione[0]!
    expect(p).toMatchObject({ nr, konto: nowe.sufiks, nadawanieWylaczone: true })
    expect(p.przeniesionePola).toEqual(['domyślna długość paczki DPD w cm', 'domyślna szerokość paczki DPD w cm', 'domyślna wysokość paczki DPD w cm', 'waga paczki w kg, gdy produkty nie mają wagi'])
    expect(p.doUzupelnienia).toEqual(['FID konta głównego do nagłówka x-dpd-fid', 'FID płatnika dla dostaw do salonu Empik, gdy inny'])
    const t = opisPrzeniesienia(p, 'DPD (konto DPD Salony Empik)')
    expect(t).toMatch(/^Reguła \d+ przeniesiona na: DPD \(konto DPD Salony Empik\)\./)
    expect(t).toContain('Nadawanie tej reguły jest teraz wyłączone')
    expect(t).toContain('włącz je ponownie na ekranie Konta przewoźników')
    expect(t).toContain('Z poprzedniego konta przeszły: domyślna długość paczki DPD w cm')
    expect(t).toContain('FID płatnika dla dostaw do salonu Empik, gdy inny')
    // karta nowego konta pokazuje przeniesione wartości od razu
    expect(await pole(`dpd~${nowe.sufiks}`, 'defaultWeightKg')).toBe('5')
    expect(await pole(`dpd~${nowe.sufiks}`, 'masterFid')).toBe('')
  })

  it('nowe konto ma już swoje wymiary: nie są nadpisywane wartościami z reguły', async () => {
    const id = await regulaSalonow({ payerFid: '79440', zapisWlaczony: true, ...WYMIARY })
    const nowe = await dodajKontoPrzewoznika(a, registry, { konto: 'dpd', nazwa: 'Salony' }, 'u-a')
    await zapiszKontaPrzewoznikow(a, registry, [{ id: `dpd~${nowe.sufiks}`, sekrety: {}, pola: { payerFid: '416038', defaultWeightKg: '2' }, nadawanie: {} }], { actorId: 'u-a', env: KLUCZ })
    const { w } = await przelaczNaKonto(id, nowe.sufiks)
    expect((await ustawienia())[`dpd~${nowe.sufiks}`]).toEqual({ payerFid: '416038', defaultWeightKg: 2, defaultSideXCm: 50, defaultSideYCm: 38, defaultSideZCm: 19 })
    expect(w.przeniesione[0]!.przeniesionePola).not.toContain('waga paczki w kg, gdy produkty nie mają wagi')
    expect(w.przeniesione[0]!.doUzupelnienia).toEqual([])
  })

  it('ustawienia z karty starego konta (nie z reguły) też przechodzą; pole wyczyszczone w starym koncie nie', async () => {
    const id = await regulaSalonow({ zapisWlaczony: true, defaultSideXCm: 99 })
    await zapiszKontaPrzewoznikow(a, registry, [{ id: 'dpd', sekrety: {}, pola: { payerFid: '79440', defaultWeightKg: '3', defaultSideXCm: '' }, nadawanie: {} }], { actorId: 'u-a', env: KLUCZ })
    const nowe = await dodajKontoPrzewoznika(a, registry, { konto: 'dpd', nazwa: 'Salony' }, 'u-a')
    const { w } = await przelaczNaKonto(id, nowe.sufiks)
    expect((await ustawienia())[`dpd~${nowe.sufiks}`]).toEqual({ defaultWeightKg: 3 })
    expect(w.przeniesione[0]!.doUzupelnienia).toEqual(['FID płatnika przesyłek'])
  })

  it('reguła, która nie nadawała: komunikat bez „ponownie”', async () => {
    const id = await regulaSalonow({ payerFid: '79440' })
    const nowe = await dodajKontoPrzewoznika(a, registry, { konto: 'dpd', nazwa: 'Salony' }, 'u-a')
    const { w } = await przelaczNaKonto(id, nowe.sufiks)
    const p = w.przeniesione[0]!
    expect(p.nadawanieWylaczone).toBe(false)
    expect(opisPrzeniesienia(p, 'X')).not.toContain('ponownie')
  })

  it('zapis listy bez zmiany konta: nic nie przenosi i nie zmienia ustawień kont', async () => {
    await regulaSalonow({ payerFid: '79440', zapisWlaczony: true, ...WYMIARY })
    const lista = await regulyPrzewoznikow(a, registry)
    const w = await zapiszRegulyPrzewoznikow(a, registry, lista.map(wej), 'u-a')
    expect(w).toMatchObject({ zmienione: false, przeniesione: [] })
    expect(await ustawienia()).toEqual({})
  })
})
