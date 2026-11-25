// sumy sprzedaży z zamówień w różnych walutach, przeliczenie kursem NBP (pulpit, raporty, API). Dane fikcyjne.
import { describe, expect, it } from 'vitest'
import { money } from './format'
import {
  dzienKursu,
  formatKursu,
  jestPrzeliczenie,
  kodWaluty,
  kursWaluty,
  kwotaZObcymi,
  naGrosze,
  notkaWalut,
  obceDoApi,
  obceZApi,
  opisBezKursu,
  opisWalut,
  przeliczGrosze,
  sumaWalut,
  type KursyWalut,
} from './sumy-walut'

const NBSP = ' '
const t = (s: string) => s.replace(/ (?=zł|CZK|EUR|XYZ)/g, NBSP)
const KURSY: KursyWalut = { data: '2026-11-21', tabela: '226/A/NBP/2026', kursy: { CZK: 0.1712, EUR: 4.2311, HUF: 0.010956 } }

describe('sumaWalut', () => {
  it('same PLN: wynik jak zwykła suma (liczba, grosze), bez obcych walut; z kursami i bez tak samo', () => {
    const w = [
      { waluta: 'PLN', grosze: 9995, zamowien: 1 },
      { waluta: null, grosze: 7540, zamowien: 2 },
      { grosze: 0, zamowien: 0 },
    ]
    expect(sumaWalut(w)).toEqual({ zamowien: 3, zamowienWSumie: 3, grosze: 17535, obce: [] })
    expect(sumaWalut(w, KURSY)).toEqual(sumaWalut(w))
  })

  it('mieszane waluty z kursem: przeliczone do sumy, rozbicie z kursem i datą', () => {
    const s = sumaWalut(
      [
        { waluta: 'PLN', grosze: 17535, zamowien: 2 },
        { waluta: 'czk', grosze: 95700, zamowien: 1 },
        { waluta: ' EUR ', grosze: 1250, zamowien: 1 },
        { waluta: 'CZK', grosze: 10000, zamowien: 2 },
      ],
      KURSY,
    )
    // CZK 1057,00 × 0,1712 = 180,9584 → 180,96 zł; EUR 12,50 × 4,2311 = 52,88875 → 52,89 zł
    expect(s.obce).toEqual([
      { waluta: 'CZK', grosze: 105700, zamowien: 3, kurs: 0.1712, dataKursu: '2026-11-21', groszePln: 18096 },
      { waluta: 'EUR', grosze: 1250, zamowien: 1, kurs: 4.2311, dataKursu: '2026-11-21', groszePln: 5289 },
    ])
    expect(s.zamowien).toBe(6)
    expect(s.zamowienWSumie).toBe(6)
    expect(s.grosze).toBe(17535 + 18096 + 5289)
  })

  it('brak kursu (brak tabeli albo waluty w tabeli): waluta poza sumą, nigdy 1:1', () => {
    const w = [
      { waluta: 'PLN', grosze: 17535, zamowien: 2 },
      { waluta: 'CZK', grosze: 95700, zamowien: 1 },
      { waluta: 'XYZ', grosze: 1200, zamowien: 1 },
    ]
    const bez = sumaWalut(w)
    expect(bez.grosze).toBe(17535)
    expect(bez.zamowien).toBe(4)
    expect(bez.zamowienWSumie).toBe(2)
    expect(bez.obce.every((o) => o.kurs === null && o.groszePln === null && o.dataKursu === null)).toBe(true)
    const czesc = sumaWalut(w, KURSY)
    expect(czesc.grosze).toBe(17535 + 16384) // 957 × 0,1712 = 163,8384 → 163,84
    expect(czesc.zamowienWSumie).toBe(3)
    expect(czesc.obce.find((o) => o.waluta === 'XYZ')).toEqual({ waluta: 'XYZ', grosze: 1200, zamowien: 1, kurs: null, dataKursu: null, groszePln: null })
  })

  it('zły kurs w tabeli (0, ujemny, NaN) = brak kursu', () => {
    const k: KursyWalut = { data: '2026-11-21', tabela: 'x', kursy: { CZK: 0, EUR: -1, HUF: Number.NaN } }
    expect(kursWaluty(k, 'CZK')).toBeNull()
    expect(kursWaluty(k, 'eur')).toBeNull()
    expect(kursWaluty(k, 'HUF')).toBeNull()
    expect(kursWaluty(KURSY, 'czk')).toBe(0.1712)
    expect(kursWaluty(null, 'CZK')).toBeNull()
  })

  it('zaokrąglenie do grosza, połówka w górę, bez śmieci zmiennoprzecinkowych', () => {
    expect(przeliczGrosze(95700, 0.1712)).toBe(16384)
    expect(przeliczGrosze(1250, 4.2311)).toBe(5289)
    expect(przeliczGrosze(1, 0.5)).toBe(1) // 0,005 zł → 0,01
    expect(przeliczGrosze(100000, 0.010956)).toBe(1096) // 1000 HUF = 10,956 → 10,96 zł
    expect(przeliczGrosze(0, 4.2)).toBe(0)
    expect(przeliczGrosze(-95700, 0.1712)).toBe(-16384)
  })

  it('pusty i pusty kod waluty = PLN', () => {
    expect(sumaWalut([])).toEqual({ zamowien: 0, zamowienWSumie: 0, grosze: 0, obce: [] })
    expect(kodWaluty('  ')).toBe('PLN')
    expect(kodWaluty(undefined)).toBe('PLN')
    expect(kodWaluty('huf')).toBe('HUF')
  })

  it('grosze z tekstu Decimal bez błędów zaokrągleń', () => {
    expect(naGrosze('99.95')).toBe(9995)
    expect(naGrosze('0.1')).toBe(10)
    expect(naGrosze(null)).toBe(0)
    expect(naGrosze(957)).toBe(95700)
  })
})

describe('formatowanie', () => {
  it('bez obcych walut dokładnie jak money (ekran bez zmian), bez objaśnienia', () => {
    expect(kwotaZObcymi(1132.35, [])).toBe(money(1132.35))
    expect(kwotaZObcymi(1132.35, undefined)).toBe(money(1132.35))
    expect(kwotaZObcymi(null, [])).toBe(money(null))
    expect(notkaWalut([])).toBe('')
    expect(notkaWalut(undefined)).toBe('')
    expect(jestPrzeliczenie([])).toBe(false)
  })

  it('dane z polecenia (Allegro 175,35 zł + 957,00 CZK): jedna kwota w złotych ze znacznikiem', () => {
    const s = sumaWalut(
      [
        { waluta: 'PLN', grosze: 17535, zamowien: 2 },
        { waluta: 'CZK', grosze: 95700, zamowien: 1 },
      ],
      KURSY,
    )
    expect(kwotaZObcymi(s.grosze / 100, s.obce)).toBe(t('≈ 339,19 zł'))
    expect(notkaWalut(s.obce)).toBe('W sumie są zamówienia w innych walutach przeliczone na złote po kursie średnim NBP z 21.11 (CZK 0,1712); to wartość informacyjna.')
  })

  it('wiele walut: jedna kwota, jedno zdanie z kursami', () => {
    const s = sumaWalut(
      [
        { waluta: 'CZK', grosze: 95700, zamowien: 1 },
        { waluta: 'EUR', grosze: 1250, zamowien: 1 },
        { waluta: 'HUF', grosze: 100000, zamowien: 1 },
      ],
      KURSY,
    )
    expect(kwotaZObcymi(s.grosze / 100, s.obce)).toBe(t('≈ 227,69 zł'))
    expect(notkaWalut(s.obce)).toContain('z 21.11 (CZK 0,1712, EUR 4,2311, HUF 0,010956)')
  })

  it('waluta bez kursu: osobno „+ X WAL” i zdanie o braku kursu; przy mieszanych oba', () => {
    const s = sumaWalut(
      [
        { waluta: 'PLN', grosze: 17535, zamowien: 2 },
        { waluta: 'CZK', grosze: 95700, zamowien: 1 },
        { waluta: 'XYZ', grosze: 1200, zamowien: 1 },
      ],
      KURSY,
    )
    expect(kwotaZObcymi(s.grosze / 100, s.obce)).toBe(t('≈ 339,19 zł + 12,00 XYZ'))
    expect(opisBezKursu(s.obce)).toBe(t('12,00 XYZ'))
    const n = notkaWalut(s.obce)
    expect(n).toContain('CZK 0,1712')
    expect(n).toContain('Brak kursu NBP dla XYZ: te kwoty są podane osobno i nie wchodzą do sumy w złotych.')
    const bez = sumaWalut([{ waluta: 'PLN', grosze: 17535, zamowien: 2 }, { waluta: 'CZK', grosze: 95700, zamowien: 1 }])
    expect(kwotaZObcymi(bez.grosze / 100, bez.obce)).toBe(t('175,35 zł + 957,00 CZK'))
    expect(notkaWalut(bez.obce)).toBe('Brak kursu NBP dla CZK: te kwoty są podane osobno i nie wchodzą do sumy w złotych.')
  })

  it('kurs i data do tekstu', () => {
    expect(formatKursu(0.1712)).toBe('0,1712')
    expect(formatKursu(4.2)).toBe('4,2000')
    expect(formatKursu(0.010956)).toBe('0,010956')
    expect(dzienKursu('2026-11-21')).toBe('21.11')
  })

  it('eksport: kwota w walucie × kurs (data) = złote; bez kursu poza sumą', () => {
    const s = sumaWalut(
      [
        { waluta: 'CZK', grosze: 95700, zamowien: 1 },
        { waluta: 'XYZ', grosze: 1200, zamowien: 1 },
      ],
      KURSY,
    )
    expect(opisWalut(s.obce)).toBe(t('957,00 CZK × 0,1712 (21.11) = 163,84 zł; 12,00 XYZ (brak kursu, poza sumą)'))
    expect(opisWalut([])).toBe('')
  })

  it('API: kwoty w jednostkach waluty, kurs, data, złote; i z powrotem', () => {
    const s = sumaWalut([{ waluta: 'CZK', grosze: 95700, zamowien: 1 }, { waluta: 'XYZ', grosze: 1200, zamowien: 1 }], KURSY)
    const api = obceDoApi(s.obce)
    expect(api).toEqual([
      { waluta: 'CZK', zamowien: 1, brutto: 957, kurs: 0.1712, dataKursu: '2026-11-21', bruttoPln: 163.84 },
      { waluta: 'XYZ', zamowien: 1, brutto: 12, kurs: null, dataKursu: null, bruttoPln: null },
    ])
    expect(obceZApi(api)).toEqual(s.obce)
    expect(obceZApi(undefined)).toEqual([])
  })
})
