// (pkt 7): powiązanie oferty z produktem po udanym „Wystaw” przez istniejące `powiazZOferta`.
// Atrapa funkcji powiązania, bez bazy i bez kanału.
import type { PrismaClient } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import { PowiazaniaError } from '@/lib/produkty/powiazania'
import { ofertaDoPowiazania } from './publikacja'
import { powiazPoWystawieniu } from './publikacja-serwer'
import type { WynikWystawienia } from './wystawianie'

const db = {} as PrismaClient
const KONTO = { channel: 'ALLEGRO', channelAccountId: 'a1' } as const
const OK: WynikWystawienia = { kind: 'OK', idZewnetrzne: '7700000001', komunikat: 'Oferta wystawiona na Allegro (nr 7700000001).', juzIstnialo: false }

function atrapaPowiazania(blad?: Error) {
  const wolania: { productId: unknown; externalId: unknown; sztuk: unknown; actorId: string; konto: unknown }[] = []
  const powiaz = async (_db: PrismaClient, w: { productId: unknown; konto: unknown; externalId: unknown; sztuk: unknown; actorId: string }) => {
    wolania.push(w)
    if (blad) throw blad
    return { info: 'Powiązano.' }
  }
  return { powiaz, wolania }
}

describe('który wynik wystawienia tworzy powiązanie', () => {
  it('tylko OK z numerem; Empik (numer importu) nigdy; NIEJEDNOZNACZNY i reszta nie', () => {
    expect(ofertaDoPowiazania('allegro', OK)).toBe('7700000001')
    expect(ofertaDoPowiazania('woo', { kind: 'OK', idZewnetrzne: '6001' })).toBe('6001')
    expect(ofertaDoPowiazania('allegro', { kind: 'OK', idZewnetrzne: null })).toBeNull()
    expect(ofertaDoPowiazania('allegro', { kind: 'OK', idZewnetrzne: '  ' })).toBeNull()
    expect(ofertaDoPowiazania('empik', { kind: 'OK', idZewnetrzne: '12345' })).toBeNull()
    for (const kind of ['NIEJEDNOZNACZNY', 'PRZEJSCIOWY', 'TRWALY', 'WYLACZONE', 'NIEGOTOWA']) expect(ofertaDoPowiazania('allegro', { kind, idZewnetrzne: '1' })).toBeNull()
  })
})

describe('powiązanie po wystawieniu (atrapa powiazZOferta)', () => {
  it('OK: woła istniejące powiązanie z numerem oferty, kontem, przelicznikiem 1 i autorem; komunikat mówi o powiązaniu', async () => {
    const a = atrapaPowiazania()
    const w = await powiazPoWystawieniu(db, 'allegro', KONTO, 'prod-1', OK, 'u-1', a.powiaz as never)
    expect(a.wolania).toEqual([{ productId: 'prod-1', konto: KONTO, externalId: '7700000001', sztuk: '1', actorId: 'u-1' }])
    expect(w.kind).toBe('OK')
    expect(w.komunikat).toBe('Oferta wystawiona na Allegro (nr 7700000001). Powiązanie z produktem: Powiązano.')
  })

  it('NIEJEDNOZNACZNY i Empik: bez wołania powiązania, wynik bez zmian', async () => {
    const a = atrapaPowiazania()
    const niej: WynikWystawienia = { kind: 'NIEJEDNOZNACZNY', komunikat: 'Allegro nie odpowiedziało.' }
    expect(await powiazPoWystawieniu(db, 'allegro', KONTO, 'prod-1', niej, 'u-1', a.powiaz as never)).toBe(niej)
    const empik: WynikWystawienia = { kind: 'OK', idZewnetrzne: '555', komunikat: 'Import przyjęty.', juzIstnialo: false }
    expect(await powiazPoWystawieniu(db, 'empik', { channel: 'EMPIK', channelAccountId: 'e1' }, 'prod-1', empik, 'u-1', a.powiaz as never)).toBe(empik)
    expect(a.wolania).toEqual([])
  })

  it('odmowa powiązania (oferta przy innym produkcie): wystawienie zostaje OK, komunikat z powodem i drogą ręczną', async () => {
    const a = atrapaPowiazania(new PowiazaniaError('Oferta 7700000001 jest już powiązana z produktem SKU „X”.'))
    const w = await powiazPoWystawieniu(db, 'allegro', KONTO, 'prod-1', OK, 'u-1', a.powiaz as never)
    expect(w.kind).toBe('OK')
    expect(w.komunikat).toContain('Nie powiązano automatycznie: Oferta 7700000001 jest już powiązana')
    expect(w.komunikat).toContain('karta produktu → Powiązania → „Powiąż z ofertą”')
  })

  it('nieoczekiwany błąd bazy: bez treści wyjątku w komunikacie, wynik dalej OK', async () => {
    const a = atrapaPowiazania(new Error('connection refused postgres://tajne'))
    const w = await powiazPoWystawieniu(db, 'woo', { channel: 'WOO', channelAccountId: 'w1' }, 'prod-1', { ...OK, idZewnetrzne: '6001' }, 'u-1', a.powiaz as never)
    expect(w.kind).toBe('OK')
    expect(w.komunikat).not.toContain('postgres')
    expect(w.komunikat).toContain('Nie udało się powiązać oferty z produktem.')
  })
})
