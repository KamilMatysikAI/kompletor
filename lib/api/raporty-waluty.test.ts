// rozbicie raportu sprzedaży na waluty (tabela „Waluty” w Raportach i arkusz „Waluty” w XLSX). Dane fikcyjne.
import { describe, expect, it } from 'vitest'
import { arkuszeRaportuSprzedazy } from '@/lib/arkusz/raport-sprzedazy'
import { obceDoApi, sumaWalut, type KursyWalut } from '@/lib/panel/sumy-walut'
import { type Miary, type RaportSprzedazy, rozbicieWalut } from './raporty-sprzedaz'

const KURSY: KursyWalut = { data: '2026-11-21', tabela: '226/A/NBP/2026', kursy: { CZK: 0.1712, EUR: 4.2311 } }

function miara(wiersze: { waluta: string; grosze: number; zamowien: number }[], kursy: KursyWalut | null = KURSY): Miary {
  const s = sumaWalut(wiersze, kursy)
  return {
    zamowien: s.zamowien,
    wartoscBrutto: s.grosze / 100,
    inneWaluty: obceDoApi(s.obce),
    sredniaWartosc: s.zamowienWSumie ? Math.round(s.grosze / s.zamowienWSumie) / 100 : null,
    produktyBrutto: 0,
    produktyNetto: 0,
    sztuk: 0,
    kg: 0,
    zwrotyBrutto: 0,
    koszt: 0,
    marza: null,
    marzaProcent: null,
    bezCenyZakupuNetto: 0,
    nieznanaStawkaPozycji: 0,
    anulowanych: 0,
    anulowaneBrutto: 0,
  }
}

function raport(razem: Miary): RaportSprzedazy {
  return {
    od: '2026-11-01',
    do: '2026-11-23',
    grupuj: 'dzien',
    konto: null,
    stanNa: '2026-11-23T17:00:00.000Z',
    razem,
    poprzedni: { od: '2026-10-09', do: '2026-10-31', tryb: 'poprzedni', dni: 23, razem: miara([]), poczatekDanych: '2025-01-01', kontaBezDanych: [], bezDanych: false },
    okresy: [],
    konta: [],
    produkty: [],
    produktowRazem: 0,
    wiecejProduktow: false,
    pozaKompletorem: { zamowien: 0, brutto: 0, inneWaluty: [] },
    zArchiwum: { zamowien: 0, brutto: 0, inneWaluty: [] },
    zKanalemOdtworzonym: { zamowien: 0, brutto: 0, inneWaluty: [] },
  }
}

describe('rozbicieWalut', () => {
  it('jedna waluta (same PLN): pusto, tabela i arkusz się nie pokazują', () => {
    const m = miara([{ waluta: 'PLN', grosze: 596169, zamowien: 41 }])
    expect(rozbicieWalut(m)).toEqual([])
    expect(arkuszeRaportuSprzedazy(raport(m), 'Wszystkie kanały').map((a) => a.nazwa)).toEqual(['Podsumowanie', 'Okresy', 'Kanały', 'Produkty'])
  })

  it('PLN i CZK: wiersz PLN z kursem „—”, CZK z kursem i datą, wartości w złotych sumują się do wartości raportu, udziały', () => {
    const m = miara([
      { waluta: 'PLN', grosze: 500434, zamowien: 40 },
      { waluta: 'CZK', grosze: 95700, zamowien: 1 },
    ])
    expect(m.wartoscBrutto).toBe(5168.18) // 5004,34 + 957 × 0,1712 (163,84)
    const r = rozbicieWalut(m)
    expect(r).toEqual([
      { waluta: 'PLN', zamowien: 40, brutto: 5004.34, kurs: null, dataKursu: null, bruttoPln: 5004.34, udzial: 96.8 },
      { waluta: 'CZK', zamowien: 1, brutto: 957, kurs: 0.1712, dataKursu: '2026-11-21', bruttoPln: 163.84, udzial: 3.2 },
    ])
    expect(Math.round(r.reduce((a, w) => a + (w.bruttoPln ?? 0), 0) * 100)).toBe(Math.round(m.wartoscBrutto * 100))
    expect(r.reduce((a, w) => a + w.zamowien, 0)).toBe(m.zamowien)
  })

  it('wiele walut i waluta bez kursu: bez kursu ma „poza sumą” (null) i nie zabiera udziału', () => {
    const m = miara([
      { waluta: 'PLN', grosze: 10000, zamowien: 1 },
      { waluta: 'CZK', grosze: 95700, zamowien: 1 },
      { waluta: 'EUR', grosze: 1250, zamowien: 1 },
      { waluta: 'XYZ', grosze: 1200, zamowien: 2 },
    ])
    const r = rozbicieWalut(m)
    expect(r.map((w) => w.waluta)).toEqual(['PLN', 'CZK', 'EUR', 'XYZ'])
    expect(r[3]).toEqual({ waluta: 'XYZ', zamowien: 2, brutto: 12, kurs: null, dataKursu: null, bruttoPln: null, udzial: null })
    expect(r[0]!.bruttoPln).toBe(100)
    expect(m.zamowien).toBe(5)
  })

  it('arkusz „Waluty” w XLSX z tymi samymi wierszami; kolumna rozbicia w Okresach i Kanałach', () => {
    const m = miara([
      { waluta: 'PLN', grosze: 500434, zamowien: 40 },
      { waluta: 'CZK', grosze: 95700, zamowien: 1 },
    ])
    const ark = arkuszeRaportuSprzedazy(raport(m), 'Wszystkie kanały')
    const w = ark.find((a) => a.nazwa === 'Waluty')!
    expect(w.kolumny.map((k) => k.naglowek)).toEqual(['Waluta', 'Zamówienia', 'Wartość brutto w walucie', 'Kurs średni NBP', 'Data kursu', 'Wartość w złotych', 'Udział %'])
    expect(w.wiersze).toEqual([
      ['PLN', 40, 5004.34, null, null, 5004.34, 96.8],
      ['CZK', 1, 957, 0.1712, '2026-11-21', 163.84, 3.2],
    ])
    const pods = ark.find((a) => a.nazwa === 'Podsumowanie')!
    expect(pods.wiersze.some((x) => x[0] === 'Objaśnienie' && String(x[1]).includes('po kursie średnim NBP z 21.11 (CZK 0,1712)'))).toBe(true)
  })
})
