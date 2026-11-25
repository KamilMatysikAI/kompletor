import { describe, expect, it } from 'vitest'
import { jestWKompletorze, kandydaciOrder, OKNO_NUMERU_MS, sqlBrakWKompletorze } from './rozlacznosc'

const t = new Date('2025-11-04T10:00:00Z')
const za = (ms: number) => new Date(t.getTime() + ms)
const arch = { externalId: '61', channelNumber: '100061', createdAtChannel: t }

describe('rozłączność archiwum z Order', () => {
  it('ten sam externalId wiąże zawsze, także w Empik i bez daty', () => {
    expect(jestWKompletorze('WOO', arch, [{ externalId: '61', channelNumber: null, createdAtChannel: null }])).toBe(true)
    expect(jestWKompletorze('EMPIK', { ...arch, externalId: '7001-A' }, [{ externalId: '7001-A', channelNumber: null, createdAtChannel: null }])).toBe(true)
  })

  it('numer w externalId (bez channelNumber) albo w channelNumber wiąże w oknie daty', () => {
    expect(jestWKompletorze('WOO', arch, [{ externalId: '100061', channelNumber: null, createdAtChannel: za(2 * 3600_000) }])).toBe(true)
    expect(jestWKompletorze('WOO', arch, [{ externalId: '100061', channelNumber: '100061', createdAtChannel: za(-3 * 3600_000) }])).toBe(true)
    expect(jestWKompletorze('WOO', arch, [{ externalId: '999', channelNumber: '100061', createdAtChannel: za(OKNO_NUMERU_MS) }])).toBe(true)
  })

  it('numer poza oknem daty, bez daty albo channelNumber inny niż externalId: bez wiązania', () => {
    expect(jestWKompletorze('WOO', arch, [{ externalId: '100061', channelNumber: '100061', createdAtChannel: za(OKNO_NUMERU_MS + 1) }])).toBe(false)
    expect(jestWKompletorze('WOO', arch, [{ externalId: '100061', channelNumber: null, createdAtChannel: null }])).toBe(false)
    // Order z API: externalId = id innego zamówienia równy numerowi archiwum, a własny numer inny
    expect(jestWKompletorze('WOO', arch, [{ externalId: '100061', channelNumber: '200500', createdAtChannel: t }])).toBe(false)
    expect(jestWKompletorze('WOO', { ...arch, channelNumber: null }, [{ externalId: '100061', channelNumber: null, createdAtChannel: t }])).toBe(false)
  })

  it('Empik: wspólny commercial_id koszyka nie wiąże różnych zamówień', () => {
    const e = { externalId: '7001-B', channelNumber: '7001', createdAtChannel: t }
    expect(jestWKompletorze('EMPIK', e, [{ externalId: '7001-A', channelNumber: '7001', createdAtChannel: t }])).toBe(false)
    expect(jestWKompletorze('EMPIK', e, [{ externalId: '7001', channelNumber: null, createdAtChannel: t }])).toBe(false)
    expect(kandydaciOrder('EMPIK', [e])).toEqual({ externalId: { in: ['7001-B'] } })
  })

  it('kandydaci: id i numery partii; bez numerów samo externalId', () => {
    expect(kandydaciOrder('WOO', [arch, { externalId: '62', channelNumber: null, createdAtChannel: t }])).toEqual({
      OR: [{ externalId: { in: ['61', '62', '100061'] } }, { channelNumber: { in: ['100061'] } }],
    })
    expect(kandydaciOrder('WOO', [{ ...arch, channelNumber: null }])).toEqual({ externalId: { in: ['61'] } })
  })

  it('fragment SQL: okno w sekundach, Empik wyłączony z numeru, aliasy sprawdzane', () => {
    const s = sqlBrakWKompletorze('a').sql
    expect(s).toContain('<= 129600')
    expect(s).toContain(`a."channel"::text IN ('EMPIK')`)
    // przegląd końcowy: trzy osobne NOT EXISTS, równości na kolumnach z indeksem, bez coalesce i OR po stronie Order
    expect(s.match(/NOT EXISTS/g)).toHaveLength(3)
    expect(s).toContain('a_o1."externalId" = a."externalId"')
    expect(s).toContain('a_o2."channelNumber" = a."channelNumber"')
    expect(s).toContain('a_o3."channelNumber" IS NULL AND a_o3."externalId" = a."channelNumber"')
    expect(s).not.toMatch(/coalesce/i)
    for (const pod of s.match(/SELECT 1 FROM "Order"[^)]*\)/g) ?? []) expect(pod).not.toMatch(/OR/) // OR tylko po stronie archiwum
    expect(() => sqlBrakWKompletorze('a;drop')).toThrow()
    // plik jest wyjątkiem strażnika sesji (tests/organizacje-izolacja): fragment bez poleceń zmiany roli i firmy
    expect(s).not.toMatch(/set_config|SET\s|RESET|DISCARD|ROLE|app\.org_id|;/i)
  })
})
