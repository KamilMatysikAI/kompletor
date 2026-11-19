import { describe, expect, it } from 'vitest'
import { cienOdczytZEnv, HARMONOGRAM_RDZENIA, harmonogramZEnv, LUSTRO_WFIRMY_JOB, lustroWfirmyZEnv } from './harmonogram'

describe('harmonogram workera z env', () => {
  it('bez zmiennych: sam rdzeń, bez importu katalogu', () => {
    expect(harmonogramZEnv({})).toEqual(HARMONOGRAM_RDZENIA)
    expect(harmonogramZEnv({ KATALOG_IMPORT_CO_GODZIN: '0' })).toEqual(HARMONOGRAM_RDZENIA)
  })

  it('import co N godzin, domyślnie bez sprzedaży (salesDays 0 = bez zamówień BL)', () => {
    const imp = harmonogramZEnv({ KATALOG_IMPORT_CO_GODZIN: '24' }).find((h) => h.kind === 'import-katalogu')
    expect(imp).toEqual({ kind: 'import-katalogu', everyMs: 24 * 3600_000, payload: { salesDays: 0 } })
    const z90 = harmonogramZEnv({ KATALOG_IMPORT_CO_GODZIN: '6', KATALOG_IMPORT_DNI_SPRZEDAZY: '90' }).at(-1)
    expect(z90?.payload).toEqual({ salesDays: 90 })
  })

  it('zła wartość = błąd na starcie', () => {
    expect(() => harmonogramZEnv({ KATALOG_IMPORT_CO_GODZIN: 'raz' })).toThrow(/KATALOG_IMPORT_CO_GODZIN/)
    expect(() => harmonogramZEnv({ KATALOG_IMPORT_CO_GODZIN: '0.5' })).toThrow(/KATALOG_IMPORT_CO_GODZIN/)
    expect(() => harmonogramZEnv({ KATALOG_IMPORT_CO_GODZIN: '24', KATALOG_IMPORT_DNI_SPRZEDAZY: '-1' })).toThrow(/DNI_SPRZEDAZY/)
    expect(() => harmonogramZEnv({ KATALOG_IMPORT_CO_GODZIN: '24', KATALOG_IMPORT_DNI_SPRZEDAZY: '1.5' })).toThrow(/DNI_SPRZEDAZY/)
  })

  // CIEN_ODCZYT=0 wyłącza odczyt zamówień z kanałów i porównanie z BL (dane osobowe) na serwerze
  it('CIEN_ODCZYT: puste/1 = cień w harmonogramie, 0 = bez cien-*, reszta rdzenia zostaje', () => {
    const kinds = (env: Record<string, string | undefined>) => harmonogramZEnv(env).map((h) => h.kind)
    for (const on of [{}, { CIEN_ODCZYT: '' }, { CIEN_ODCZYT: '1' }, { CIEN_ODCZYT: ' 1 ' }]) {
      expect(kinds(on)).toContain('cien-zamowienia-planuj')
      expect(kinds(on)).toContain('cien-bl-porownanie')
    }
    const off = kinds({ CIEN_ODCZYT: '0' })
    expect(off.filter((k) => k.startsWith('cien-'))).toEqual([])
    expect(off).toContain('rdzen-propagacja-cien') // propagacja stanów to rdzeń, nie odczyt zamówień
    // lustro wFirmy przy pustym CIEN_LUSTRO_WFIRMY idzie za cieniem
    expect(off).toEqual(HARMONOGRAM_RDZENIA.map((h) => h.kind).filter((k) => !k.startsWith('cien-') && k !== LUSTRO_WFIRMY_JOB))
    expect(kinds({ CIEN_ODCZYT: '0', KATALOG_IMPORT_CO_GODZIN: '24' })).toContain('import-katalogu')
  })

  it('CIEN_ODCZYT: zła wartość = błąd na starcie', () => {
    expect(() => harmonogramZEnv({ CIEN_ODCZYT: 'nie' })).toThrow(/CIEN_ODCZYT/)
    expect(() => cienOdczytZEnv({ CIEN_ODCZYT: 'false' })).toThrow(/CIEN_ODCZYT/)
    expect(cienOdczytZEnv({ CIEN_ODCZYT: '0' })).toBe(false)
    expect(cienOdczytZEnv({})).toBe(true)
  })

  // wyłącznik lustra stanów wFirmy
  it('CIEN_LUSTRO_WFIRMY: 1/0 rozstrzyga, puste = jak CIEN_ODCZYT; co 2 min', () => {
    const has = (env: Record<string, string | undefined>) => harmonogramZEnv(env).some((h) => h.kind === LUSTRO_WFIRMY_JOB)
    expect(HARMONOGRAM_RDZENIA.find((h) => h.kind === LUSTRO_WFIRMY_JOB)?.everyMs).toBe(2 * 60_000)
    expect(has({})).toBe(true)
    expect(has({ CIEN_ODCZYT: '0' })).toBe(false)
    expect(has({ CIEN_ODCZYT: '0', CIEN_LUSTRO_WFIRMY: '1' })).toBe(true)
    expect(has({ CIEN_ODCZYT: '1', CIEN_LUSTRO_WFIRMY: '0' })).toBe(false)
    expect(has({ CIEN_LUSTRO_WFIRMY: ' 1 ' })).toBe(true)
    expect(lustroWfirmyZEnv({ CIEN_LUSTRO_WFIRMY: '' })).toBe(true)
    expect(() => harmonogramZEnv({ CIEN_LUSTRO_WFIRMY: 'tak' })).toThrow(/CIEN_LUSTRO_WFIRMY/)
  })
})
