// waluta zamówienia z kopii kanału i bezpiecznik faktury. Atrapa klienta bazy (bez bazy), dane fikcyjne.
import { describe, expect, it } from 'vitest'
import { blokadaFakturyWaluta, FAKTURA_OBCA_WALUTA, normalizujWalute, obcaWaluta, powodFakturyRecznej, walutaZamowieniaPoId, walutyZamowien, type ZamowienieDoWaluty } from './waluta'
import type { Db } from './stan'

type Kopia = { channel: string; channelAccountId: string; externalId: string; orderId: string | null; currency: string }

function atrapa(kopie: Kopia[], zamowienia: ZamowienieDoWaluty[] = []) {
  const zapytania: unknown[] = []
  const zdarzenia: { orderId: string; kind: string; data: unknown }[] = []
  const alerty: unknown[][] = []
  const pasuje = (k: Kopia, w: Record<string, unknown>) => {
    if ('orderId' in w) throw new Error('szukanie kopii po orderId (kolumna bez indeksu): tylko po kluczu unikalnym')
    return k.channel === w['channel'] && k.channelAccountId === w['channelAccountId'] && k.externalId === w['externalId']
  }
  const c = {
    channelOrderSnapshot: {
      findMany: async ({ where }: { where: { OR: Record<string, unknown>[] } }) => {
        zapytania.push(where)
        return kopie.filter((k) => where.OR.some((w) => pasuje(k, w)))
      },
    },
    order: { findUnique: async ({ where }: { where: { id: string } }) => zamowienia.find((o) => o.id === where.id) ?? null },
    orderEvent: {
      findFirst: async ({ where }: { where: { orderId: string; kind: string } }) => zdarzenia.find((e) => e.orderId === where.orderId && e.kind === where.kind) ?? null,
      create: async ({ data }: { data: { orderId: string; kind: string; data: unknown } }) => void zdarzenia.push(data),
      // najnowszy ślad blokady/ponowienia; kolejność w tablicy = kolejność w czasie
      findMany: async ({ where }: { where: { orderId: string; kind: { in: string[] } } }) =>
        zdarzenia.flatMap((e, i) => (e.orderId === where.orderId && where.kind.in.includes(e.kind) ? [{ kind: e.kind, createdAt: new Date(1_000 + i) }] : [])),
    },
    $executeRaw: async (...args: unknown[]) => {
      alerty.push(args)
      return alerty.length === 1 ? 1 : 0
    },
  }
  return { db: c as unknown as Db, zapytania, zdarzenia, alerty }
}

const POWOD_CZK = 'Zamówienie w CZK: wystaw fakturę ręcznie w programie do faktur. Jeśli Kompletor wystawił WZ przy wysyłce, wystaw fakturę do tego WZ, bez drugiego wydania towaru.'

const zam = (id: string, over: Partial<ZamowienieDoWaluty> = {}): ZamowienieDoWaluty => ({ id, channel: 'ALLEGRO', channelAccountId: 'cz', externalId: `ext-${id}`, parentOrderId: null, ...over })
const kopia = (externalId: string, currency: string, orderId: string | null = null): Kopia => ({ channel: 'ALLEGRO', channelAccountId: 'cz', externalId, orderId, currency })

describe('normalizacja waluty', () => {
  it('brak i puste = PLN, kod wielkimi literami, nieczytelny kod zostaje (≠ PLN)', () => {
    expect(normalizujWalute(null)).toBe('PLN')
    expect(normalizujWalute('  ')).toBe('PLN')
    expect(normalizujWalute(' czk ')).toBe('CZK')
    expect(obcaWaluta('pln')).toBe(false)
    expect(obcaWaluta('EUR')).toBe(true)
    expect(obcaWaluta('?')).toBe(true)
    expect(powodFakturyRecznej('czk')).toBe(POWOD_CZK)
  })
})

describe('walutyZamowien', () => {
  it('jedno zapytanie po kluczu kopii; bez kopii (zamówienie ręczne) = PLN; pusta lista bez zapytania', async () => {
    const a = atrapa([kopia('ext-1', 'CZK'), kopia('ext-2', 'PLN')])
    const m = await walutyZamowien(a.db, [zam('1'), zam('2'), zam('3', { channel: 'RECZNE' as never })])
    expect(Object.fromEntries(m)).toEqual({ '1': 'CZK', '2': 'PLN', '3': 'PLN' })
    expect(a.zapytania).toHaveLength(1)
    expect(await walutyZamowien(a.db, [])).toEqual(new Map())
    expect(a.zapytania).toHaveLength(1)
  })

  it('paczka dodatkowa (`#dosle-n`, `#paczka-n`) dziedziczy walutę zamówienia głównego po kluczu kopii, także gdy kopia nie ma orderId', async () => {
    const a = atrapa([kopia('ext-g', 'EUR', null)])
    const m = await walutyZamowien(a.db, [zam('d', { externalId: 'ext-g#dosle-1', parentOrderId: 'g' }), zam('p', { externalId: 'ext-g#paczka-2', parentOrderId: 'g' })])
    expect(Object.fromEntries(m)).toEqual({ d: 'EUR', p: 'EUR' })
    expect(a.zapytania).toHaveLength(1)
  })

  it('numer z `#` w kanale: najpierw pełny numer, dopiero potem część przed `#`', async () => {
    const a = atrapa([kopia('A#1', 'PLN'), kopia('A', 'CZK'), kopia('B', 'CZK')])
    const m = await walutyZamowien(a.db, [zam('1', { externalId: 'A#1' }), zam('2', { externalId: 'B#dosle-1', parentOrderId: 'b' })])
    expect(Object.fromEntries(m)).toEqual({ '1': 'PLN', '2': 'CZK' })
  })

  it('paczka innego konta albo kanału nie bierze waluty cudzej kopii', async () => {
    const a = atrapa([kopia('ext-g', 'CZK')])
    expect((await walutyZamowien(a.db, [zam('d', { externalId: 'ext-g#dosle-1', parentOrderId: 'g', channelAccountId: 'pl' })])).get('d')).toBe('PLN')
  })

  it('kilka kopii jednego zamówienia: wygrywa waluta inna niż PLN (bezpieczniej)', async () => {
    const a = atrapa([kopia('ext-1', 'czk', '1'), { ...kopia('ext-1', 'PLN'), channelAccountId: 'cz' }])
    expect((await walutyZamowien(a.db, [zam('1')])).get('1')).toBe('CZK')
  })

  it('walutaZamowieniaPoId: brak zamówienia = PLN', async () => {
    const a = atrapa([kopia('ext-1', 'CZK')], [zam('1')])
    expect(await walutaZamowieniaPoId(a.db, '1')).toBe('CZK')
    expect(await walutaZamowieniaPoId(a.db, 'nie-ma')).toBe('PLN')
  })
})

describe('blokadaFakturyWaluta (bezpiecznik dla każdej drogi dokumentu)', () => {
  it('PLN: null, bez śladu i alertu', async () => {
    const a = atrapa([kopia('ext-1', 'PLN')])
    expect(await blokadaFakturyWaluta(a.db, zam('1'), { oznacz: { actorId: 'system:faktury' } })).toBeNull()
    expect(a.zdarzenia).toHaveLength(0)
    expect(a.alerty).toHaveLength(0)
  })

  it('CZK: powód dla człowieka; bez `oznacz` nic nie zapisuje', async () => {
    const a = atrapa([kopia('ext-1', 'CZK')])
    expect(await blokadaFakturyWaluta(a.db, zam('1'))).toEqual({ waluta: 'CZK', powod: POWOD_CZK })
    expect(a.zdarzenia).toHaveLength(0)
    expect(a.alerty).toHaveLength(0)
  })

  it('CZK z `oznacz`: ślad w historii raz (powtórka nie dubluje), alert z kluczem deduplikacji tej paczki', async () => {
    const a = atrapa([kopia('ext-g', 'CZK', 'g')])
    const d = zam('d', { externalId: 'ext-g#paczka-2', parentOrderId: 'g' })
    await blokadaFakturyWaluta(a.db, d, { oznacz: { actorId: 'system:faktury' } })
    await blokadaFakturyWaluta(a.db, d, { oznacz: { actorId: 'system:faktury' } })
    expect(a.zdarzenia).toEqual([{ orderId: 'd', kind: FAKTURA_OBCA_WALUTA, actorId: 'system:faktury', data: { waluta: 'CZK', powod: powodFakturyRecznej('CZK') } }])
    expect(a.alerty).toHaveLength(2) // INSERT … ON CONFLICT DO NOTHING: drugi raz baza nic nie dopisuje
    expect(a.alerty[0]).toContain('faktura-obca-waluta:d')
  })

  it('druga paczka tego samego zamówienia dostaje własny alert (klucz per paczka)', async () => {
    const a = atrapa([kopia('ext-g', 'CZK')])
    await blokadaFakturyWaluta(a.db, zam('g', { externalId: 'ext-g' }), { oznacz: { actorId: 'system:faktury' } })
    await blokadaFakturyWaluta(a.db, zam('d', { externalId: 'ext-g#dosle-2', parentOrderId: 'g' }), { oznacz: { actorId: 'system:faktury' } })
    expect(a.alerty.map((x) => x.find((v) => typeof v === 'string' && v.startsWith('faktura-obca-waluta:')))).toEqual(['faktura-obca-waluta:g', 'faktura-obca-waluta:d'])
  })
})
