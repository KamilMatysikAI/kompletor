// kwota pobrania paczek zamówienia podzielonego. Dane fikcyjne.
import { describe, expect, it } from 'vitest'
import type { PozycjaZamowienia } from '@/lib/dokumenty/pozycje'
import { kwotyPobraniaPaczek, powodEtykietyPoPodziale, type RodzinaPaczek } from './pobranie-paczek'

const poz = (qty: number, cenaBruttoGr: number, o: Partial<PozycjaZamowienia> = {}): PozycjaZamowienia => ({
  sku: 'TOWAR-1',
  rodzaj: 'STOCKED',
  nazwa: 'Towar',
  jednostka: 'SZT',
  wfirmaGoodId: null,
  qty,
  qtyOdrzucone: 0,
  naOferte: 1,
  cenaBruttoGr,
  stawkaVat: '23',
  ...o,
})

const kwoty = (r: RodzinaPaczek) => {
  const w = kwotyPobraniaPaczek(r)
  if (w.powod !== null) throw new Error(w.powod)
  return w.kwotyGr
}

describe('kwotyPobraniaPaczek', () => {
  it('„dośle później” 1 z 3 sztuk: paczka 2 = 19,90 zł, paczka 1 = reszta z wysyłką 12,99 zł', () => {
    const k = kwoty({
      glowne: { id: 'g', totalGross: 83.39, kosztWysylki: 12.99, pozycje: [poz(3, 1990, { qtyOdrzucone: 1 }), poz(1, 1070)] },
      dodatkowe: [{ id: 'd', pozycje: [poz(1, 1990)] }],
    })
    expect(k.get('d')).toBe(1990)
    expect(k.get('g')).toBe(6349)
    expect(k.get('g')! + k.get('d')!).toBe(8339)
  })

  it('opłata za pobranie (kwota ponad pozycje i wysyłkę) zostaje w paczce 1', () => {
    const k = kwotyPobraniaPaczek({
      glowne: { id: 'g', totalGross: 92.39, kosztWysylki: 12.99, pozycje: [poz(3, 1990, { qtyOdrzucone: 2 }), poz(1, 1070)] },
      dodatkowe: [
        { id: 'd1', pozycje: [poz(1, 1990)] },
        { id: 'd2', pozycje: [poz(1, 1990)] },
      ],
    })
    expect(k.kwotyGr && Object.fromEntries(k.kwotyGr)).toEqual({ d1: 1990, d2: 1990, g: 5259 })
  })

  it('towar na wagę z przelicznikiem oferty: 150 g po 12,99 zł za 50 g, 50 g w paczce 2', () => {
    const k = kwoty({
      glowne: { id: 'g', totalGross: 48.96, kosztWysylki: 9.99, pozycje: [poz(150, 1299, { naOferte: 50, jednostka: 'KG', qtyOdrzucone: 50 })] },
      dodatkowe: [{ id: 'd', pozycje: [poz(50, 1299, { naOferte: 50, jednostka: 'KG' })] }],
    })
    expect([k.get('g'), k.get('d')]).toEqual([3597, 1299])
  })

  it('reszta zaokrągleń rabatu z kanału (grosze ponad pozycje) zostaje w paczce 1', () => {
    // ceny po rabacie z adaptera: 3 × 18,91 = 56,73, kwota towarów 56,74 (grosz reszty)
    const k = kwoty({ glowne: { id: 'g', totalGross: 69.73, kosztWysylki: 12.99, pozycje: [poz(3, 1891, { qtyOdrzucone: 1 })] }, dodatkowe: [{ id: 'd', pozycje: [poz(1, 1891)] }] })
    expect([k.get('g'), k.get('d')]).toEqual([5082, 1891])
  })

  it('bez kosztu wysyłki z kanału: nieznana kwota z powodem', () => {
    const w = kwotyPobraniaPaczek({ glowne: { id: 'g', totalGross: 83.39, kosztWysylki: null, pozycje: [poz(3, 1990, { qtyOdrzucone: 1 }), poz(1, 1070)] }, dodatkowe: [{ id: 'd', pozycje: [poz(1, 1990)] }] })
    expect(w).toEqual({ kwotyGr: null, powod: expect.stringMatching(/kosztu wysyłki/) })
  })

  it('rabat liczony dopiero na dokumencie (kwota o 10% niższa od pozycji): nieznana kwota', () => {
    const w = kwotyPobraniaPaczek({ glowne: { id: 'g', totalGross: 66.72, kosztWysylki: 12.99, pozycje: [poz(3, 1990, { qtyOdrzucone: 1 })] }, dodatkowe: [{ id: 'd', pozycje: [poz(1, 1990)] }] })
    expect(w.powod).toMatch(/rabat/)
  })

  it('zamiennik w rodzinie: nieznana kwota', () => {
    const w = kwotyPobraniaPaczek({
      glowne: { id: 'g', totalGross: 72.69, kosztWysylki: 12.99, pozycje: [poz(3, 1990, { qtyOdrzucone: 1, pokryte: 2 }), poz(0, 2490, { zamiennik: null, przesuniecie: 2 })] },
      dodatkowe: [{ id: 'd', pozycje: [poz(1, 1990)] }],
    })
    expect(w.powod).toMatch(/zamieniony produkt/)
  })

  it('sztuka odrzucona przy akceptacji obok przeniesionej: nieznana kwota', () => {
    const w = kwotyPobraniaPaczek({ glowne: { id: 'g', totalGross: 72.69, kosztWysylki: 12.99, pozycje: [poz(3, 1990, { qtyOdrzucone: 2 })] }, dodatkowe: [{ id: 'd', pozycje: [poz(1, 1990)] }] })
    expect(w.powod).toMatch(/nie pokrywają się/)
  })

  it('paczka dodatkowa z inną ceną niż pozycja zamówienia: nieznana kwota', () => {
    const w = kwotyPobraniaPaczek({ glowne: { id: 'g', totalGross: 72.69, kosztWysylki: 12.99, pozycje: [poz(3, 1990, { qtyOdrzucone: 1 })] }, dodatkowe: [{ id: 'd', pozycje: [poz(1, 1890)] }] })
    expect(w.powod).toMatch(/nie pokrywają się/)
  })

  it('test losowy: suma pobrań paczek = kwota zamówienia co do grosza', () => {
    let ziarno = 93
    const los = (n: number) => {
      ziarno = (ziarno * 1103515245 + 12345) % 2147483648
      return ziarno % n
    }
    for (let proba = 0; proba < 500; proba++) {
      const linie = Array.from({ length: 1 + los(4) }, () => ({ qty: 1 + los(5), naOferte: [1, 1, 50, 100][los(4)]!, cena: 1 + los(30000) }))
      for (const l of linie) l.qty *= l.naOferte
      const koszt = 1 + los(3000)
      const oplata = los(2) ? los(900) : 0
      const pelne = linie.reduce((s, l) => s + Math.round((l.qty * l.cena) / l.naOferte), 0)
      // każda linia: część sztuk (pełne oferty) do jednej z 1–3 paczek dodatkowych
      const paczek = 1 + los(3)
      const dodatkowe = Array.from({ length: paczek }, (_, i) => ({ id: `d${i}`, pozycje: [] as PozycjaZamowienia[] }))
      const glowne = linie.map((l) => {
        const zdjete = los(l.qty / l.naOferte) * l.naOferte
        if (zdjete > 0) dodatkowe[los(paczek)]!.pozycje.push(poz(zdjete, l.cena, { naOferte: l.naOferte }))
        return poz(l.qty, l.cena, { naOferte: l.naOferte, qtyOdrzucone: zdjete })
      })
      const totalGr = pelne + koszt + oplata
      const w = kwotyPobraniaPaczek({ glowne: { id: 'g', totalGross: totalGr / 100, kosztWysylki: koszt / 100, pozycje: glowne }, dodatkowe })
      expect(w.powod).toBeNull()
      expect([...w.kwotyGr!.values()].reduce((s, x) => s + x, 0)).toBe(totalGr)
      expect([...w.kwotyGr!.values()].every((x) => x >= 0)).toBe(true)
    }
  })
})

// „anuluj tę przesyłkę” tylko u przewoźnika, który anuluje z Kompletora
describe('powodEtykietyPoPodziale', () => {
  it('przewoźnik anuluje z Kompletora: podpowiedź „anuluj tę przesyłkę i utwórz ją ponownie”', () => {
    expect(powodEtykietyPoPodziale({ paczka: 1, naEtykiecieGr: 9259, powinnoGr: 5279, anulowalna: true })).toBe(
      'paczka 1 ma już przesyłkę z pobraniem 92,59 zł, a po podziale powinna mieć 52,79 zł: anuluj tę przesyłkę i utwórz ją ponownie',
    )
  })

  it('przewoźnik bez anulowania: wprost, że w Kompletorze się nie da, i co zrobić ręcznie, bez „anuluj tę przesyłkę”', () => {
    const p = powodEtykietyPoPodziale({ paczka: 2, naEtykiecieGr: 0, powinnoGr: 3980, anulowalna: false })
    expect(p).toBe(
      'paczka 2 ma już przesyłkę bez pobrania, a po podziale powinna mieć 39,80 zł. Tej przesyłki nie da się anulować w Kompletorze (ten przewoźnik nie anuluje przesyłek z Kompletora), ' +
        'więc kwot pobrania dla paczek tego zamówienia Kompletor nie poda: zmień kwotę pobrania tej przesyłki w panelu przewoźnika, ' +
        'a pozostałe paczki nadaj ręcznie w panelu przewoźnika',
    )
    expect(p).not.toMatch(/anuluj tę przesyłkę/)
  })
})
