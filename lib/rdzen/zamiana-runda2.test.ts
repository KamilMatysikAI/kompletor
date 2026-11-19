// (zamiennik z inną ceną, usunięty
// zamiennik — dokument staje, bezpiecznik liczy cel bez zamienników), (zamiana części pozycji: suma części =
// wartość pozycji co do grosza), (korekta KSeF zwrotu zamiennika), tor KSeF i regresja zwykłych zamówień.
// Wejście przez `pozycjeZamowienia` (ta sama droga co wFirma i KSeF), dane fikcyjne, bez bazy.
import { describe, expect, it } from 'vitest'
import { KOMUNIKAT_ZAMIENNIKA, type OrderRow, type ProductRow, kluczOferty, pozycjeZamowienia, zlozPozycjeDokumentu } from '../dokumenty/pozycje'
import { linieKsef } from '../ksef/linie'
import { zlozKorekte } from '../wfirma/korekta-zapis'
import { wierszKorektyKsef } from '../zwroty/korekta-ksef'
import { podsumowaniePozycji } from '../karta/uklad'
import { wartoscPozycjiGr } from './ceny'
import { przelicznikiPozycji, wartoscCzesciGr } from './zamiana'

type L = { id: string; ext: string; prod: string; oferta?: string; qty: number; odrz?: number; cena: number; removed?: boolean }

const produkt = (id: string, unit: 'SZT' | 'KG' = 'SZT'): ProductRow =>
  ({ id, sku: id.toUpperCase(), kind: 'STOCKED', nameAccounting: `Towar ${id}`, unit, wfirmaGoodId: '1', vatRate: '23', priceGross: null, bundleComponents: [] }) as unknown as ProductRow

/** Dokument z wierszy „jak z bazy”: przeliczniki, rodziny zamian i błędy liczy `pozycjeZamowienia`. */
function dokument(linie: L[], totalGross: number, oferty: Record<string, number> = {}, unit: 'SZT' | 'KG' = 'SZT') {
  const o = {
    channel: 'WOO',
    channelAccountId: 'k1',
    lines: linie.map((l) => ({ id: l.id, externalLineId: l.ext, productId: l.prod, offerId: l.oferta ?? null, qty: l.qty, qtyRejected: l.odrz ?? 0, removed: l.removed ?? false, unitPriceGross: l.cena, vatRate: '23' })),
  } as unknown as OrderRow
  const products = new Map(linie.map((l) => [l.prod, produkt(l.prod, unit)]))
  const offers = new Map(Object.entries(oferty).map(([k, n]) => [kluczOferty('WOO', 'k1', k), n]))
  const pozycje = pozycjeZamowienia(o, products, offers)
  return { d: zlozPozycjeDokumentu({ totalGross, pozycje, wysylka: { nazwa: 'Wysyłka', stawkaVat: '23' } }), pozycje }
}
const kody = (d: { problemy: { kod: string }[] }) => d.problemy.map((p) => p.kod)

describe('zamiennik z inną ceną albo usunięty — dokument staje, nie wychodzi po cichu', () => {
  it('cena zamiennika 12,50 → 15,00 zł (stan po starej edycji z karty: kwota zamówienia 27,99 zł)', () => {
    const { d } = dokument([{ id: 'a', ext: 'L1', prod: 'a', oferta: 'OA', qty: 1, odrz: 1, cena: 12.5 }, { id: 'b', ext: 'L1#zamiana-1', prod: 'b', qty: 1, cena: 15 }], 27.99, { OA: 1 })
    expect(kody(d)).toContain('zamiennik-cena-inna-niz-pierwotna')
    expect(kody(d)).toContain('suma-rozna-od-zamowienia') // bezpiecznik sam z siebie też łapie (cel bez zamienników)
  })

  it('cena w dół 12,50 → 10,00 zł: błąd zamiany', () => {
    const { d } = dokument([{ id: 'a', ext: 'L1', prod: 'a', qty: 1, odrz: 1, cena: 12.5 }, { id: 'b', ext: 'L1#zamiana-1', prod: 'b', qty: 1, cena: 10 }], 22.99)
    expect(kody(d)).toContain('zamiennik-cena-inna-niz-pierwotna')
  })

  it('na wagę, oferta 50 g za 12,50 zł, cena zamiennika 15,00 zł (kwota 150,49 zł): błąd zamiany', () => {
    const { d } = dokument([{ id: 'a', ext: 'L1', prod: 'a', oferta: 'W50', qty: 50, odrz: 50, cena: 12.5 }, { id: 'b', ext: 'L1#zamiana-1', prod: 'b', qty: 50, cena: 15 }], 150.49, { W50: 50 }, 'KG')
    expect(kody(d)).toContain('zamiennik-cena-inna-niz-pierwotna')
  })

  // zmniejszenie ilości zamiennika (2 → 1) ze starą zmianą kwoty zamówienia daje stan nie do odróżnienia od „1 szt.
  // zamieniona, 1 szt. do zwrotu” w zamówieniu na niższą kwotę — chroni tylko odmowa edycji (test integracyjny)
  it('usunięty zamiennik (5,00 zł + 20,00 zł + 12,99 zł, kwota po usunięciu 32,99 zł): błąd na pozycji pierwotnej', () => {
    const { d } = dokument(
      [
        { id: 'a', ext: 'L1', prod: 'a', qty: 1, odrz: 1, cena: 5 },
        { id: 'c', ext: 'L2', prod: 'c', qty: 1, cena: 20 },
        { id: 'b', ext: 'L1#zamiana-1', prod: 'b', qty: 1, cena: 5, removed: true },
      ],
      32.99,
    )
    expect(kody(d)).toContain('zamiennik-usuniety-zamiennik')
    expect(linieKsef({ totalGross: 32.99, pozycje: dokument([{ id: 'a', ext: 'L1', prod: 'a', qty: 1, odrz: 1, cena: 5 }, { id: 'b', ext: 'L1#zamiana-1', prod: 'b', qty: 1, cena: 5, removed: true }], 32.99).pozycje, wysylka: { nazwa: 'Wysyłka', stawkaVat: '23' } }).problemy.map((p) => p.tekst)).toContain(KOMUNIKAT_ZAMIENNIKA)
  })

  it('komunikat: nie odsyła do „Ponów fakturę” jako naprawy, wskazuje fakturę ręczną i „Dokument wystawiony”', () => {
    expect(KOMUNIKAT_ZAMIENNIKA).toContain('„Ponów fakturę” tego nie zmieni')
    expect(KOMUNIKAT_ZAMIENNIKA).toContain('„Wyślij bez faktury”')
    expect(KOMUNIKAT_ZAMIENNIKA).toContain('„Dokument wystawiony”')
  })
})

describe('zamiana części pozycji — suma części = wartość pozycji co do grosza', () => {
  it('oferta 2 szt. za 10,01 zł, 1 szt. na stanie, zamiana 1 szt., wysyłka 12,99 zł → 23,00 zł (było 23,01)', () => {
    const { d } = dokument([{ id: 'a', ext: 'L1', prod: 'a', oferta: 'K2', qty: 2, odrz: 1, cena: 10.01 }, { id: 'b', ext: 'L1#zamiana-1', prod: 'b', qty: 1, cena: 10.01 }], 23, { K2: 2 })
    expect(d.problemy).toEqual([])
    expect(d.linie.map((l) => l.bruttoGr)).toEqual([501, 500, 1299])
    expect(d.bruttoGr).toBe(2300)
  })

  it('to samo bez wysyłki: 10,01 zł (było 10,02)', () => {
    const { d } = dokument([{ id: 'a', ext: 'L1', prod: 'a', oferta: 'K2', qty: 2, odrz: 1, cena: 10.01 }, { id: 'b', ext: 'L1#zamiana-1', prod: 'b', qty: 1, cena: 10.01 }], 10.01, { K2: 2 })
    expect(d.problemy).toEqual([])
    expect(d.bruttoGr).toBe(1001)
  })

  it('na wagę: 2 × oferta 50 g za 3,75 zł, na stanie 71 g, zamiana 29 g, wysyłka 12,99 zł → 20,49 zł (było 20,50)', () => {
    const { d } = dokument([{ id: 'a', ext: 'L1', prod: 'a', oferta: 'W50', qty: 100, odrz: 29, cena: 3.75 }, { id: 'b', ext: 'L1#zamiana-1', prod: 'b', qty: 29, cena: 3.75 }], 20.49, { W50: 50 }, 'KG')
    expect(d.problemy).toEqual([])
    expect(d.bruttoGr).toBe(2049)
    expect(d.linie.filter((l) => !l.wysylka).reduce((s, l) => s + l.bruttoGr, 0) + (d.linie.find((l) => l.wysylka)!.bruttoGr - 1299)).toBe(750)
  })

  it('karta liczy tę samą wartość części (przesunięcie z przelicznikiPozycji)', () => {
    const linie = [
      { id: 'a', externalLineId: 'L1', productId: 'a', offerId: 'W50', qty: 100, qtyRejected: 29, removed: false, unitPriceGross: 3.75 },
      { id: 'b', externalLineId: 'L1#zamiana-1', productId: 'b', offerId: null, qty: 29, qtyRejected: 0, removed: false, unitPriceGross: 3.75 },
    ]
    const prz = przelicznikiPozycji(linie, () => 50)
    const karta = podsumowaniePozycji(linie.map((l) => ({ unitPriceGross: l.unitPriceGross, qty: l.qty, qtyRejected: l.qtyRejected, naOferte: prz.naOferte.get(l.id) ?? 1, przesuniecie: prz.przesuniecie.get(l.id) ?? 0, stawka: '5' })))
    expect(karta.bruttoGr).toBe(750)
    expect(wartoscCzesciGr(29, 71, 50, 375)).toBe(217)
  })

  it('łańcuch zamian (zamiennik zamiennika) i dwa zamienniki jednej pozycji: suma = wartość pozycji', () => {
    const { d } = dokument(
      [
        { id: 'a', ext: 'L1', prod: 'a', oferta: 'W50', qty: 150, odrz: 79, cena: 3.75 },
        { id: 'b', ext: 'L1#zamiana-1', prod: 'b', qty: 50, odrz: 21, cena: 3.75 },
        { id: 'c', ext: 'L1#zamiana-2', prod: 'c', qty: 29, cena: 3.75 },
        { id: 'e', ext: 'L1#zamiana-1#zamiana-3', prod: 'e', qty: 21, cena: 3.75 },
      ],
      11.25 + 12.99,
      { W50: 50 },
      'KG',
    )
    expect(d.problemy).toEqual([])
    expect(d.bruttoGr).toBe(2424)
  })

  it('zamiana w paczce dodatkowej (`#paczka#zamiana-N`): pozycja pierwotna `L1#paczka` w tej samej paczce, suma = wartość', () => {
    const { d } = dokument([{ id: 'a', ext: 'L1#paczka', prod: 'a', oferta: 'K2', qty: 2, odrz: 1, cena: 10.01 }, { id: 'b', ext: 'L1#paczka#zamiana-1', prod: 'b', qty: 1, cena: 10.01 }], 10.01, { K2: 2 })
    expect(d.problemy).toEqual([])
    expect(d.bruttoGr).toBe(1001)
  })

  it('losowo: 5 000 zamówień z zamianą części pozycji — suma dokumentu = kwota zamówienia, bez problemów', () => {
    let seed = 2362
    const los = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    for (let i = 0; i < 5000; i++) {
      const kg = los(2) === 1
      const n = kg ? [50, 100, 250][los(3)]! : [1, 2, 3, 6][los(4)]!
      const oferty: Record<string, number> = {}
      const linie: L[] = []
      let total = 0
      const ile = 1 + los(3)
      for (let p = 0; p < ile; p++) {
        const sztukOferty = 1 + los(4)
        const qty = sztukOferty * n
        const cena = (1 + los(5000)) / 100
        const odrz = los(qty + 1)
        oferty[`O${p}`] = n
        linie.push({ id: `p${p}`, ext: `L${p}`, prod: `p${p}`, oferta: `O${p}`, qty, odrz, cena })
        total += wartoscPozycjiGr(qty, n, Math.round(cena * 100))
        // zamiana całego braku jedną albo dwiema pozycjami
        if (odrz > 0) {
          const pierwsza = odrz > 1 && los(2) ? 1 + los(odrz - 1) : odrz
          linie.push({ id: `z${p}a`, ext: `L${p}#zamiana-${2 * p + 1}`, prod: `z${p}a`, qty: pierwsza, cena })
          if (pierwsza < odrz) linie.push({ id: `z${p}b`, ext: `L${p}#zamiana-${2 * p + 2}`, prod: `z${p}b`, qty: odrz - pierwsza, cena })
        }
      }
      const wysylka = 1 + los(2000) // ułamkowe kg wchłania wysyłka
      const { d } = dokument(linie, (total + wysylka) / 100, oferty, kg ? 'KG' : 'SZT')
      expect(d.problemy, `zamówienie ${i}`).toEqual([])
      expect(d.bruttoGr, `zamówienie ${i}`).toBe(total + wysylka)
    }
  })
})

describe('regresja: zwykłe zamówienia bez zamiennika — te same kwoty co przed rundą 2', () => {
  it('3 000 losowych zamówień (także z odrzuconymi sztukami): każda pozycja = wartoscPozycjiGr(qty − odrzucone), dokument = kwota − odrzucone', () => {
    let seed = 99
    const los = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    for (let i = 0; i < 3000; i++) {
      const n = [1, 1, 2, 3, 50, 100][los(6)]!
      const kg = n >= 50
      const linie: L[] = []
      const oferty: Record<string, number> = {}
      let pelne = 0
      let aktywne = 0
      for (let p = 0; p < 1 + los(3); p++) {
        const qty = 1 + los(n * 4)
        const odrz = los(3) === 0 ? los(qty) : 0
        const cenaGr = 1 + los(20_000)
        oferty[`O${p}`] = n
        linie.push({ id: `p${p}`, ext: `L${p}`, prod: `p${p}`, oferta: `O${p}`, qty, odrz, cena: cenaGr / 100 })
        pelne += wartoscPozycjiGr(qty, n, cenaGr)
        aktywne += wartoscPozycjiGr(qty - odrz, n, cenaGr)
      }
      const wysylka = 999
      const { d, pozycje } = dokument(linie, (pelne + wysylka) / 100, oferty, kg ? 'KG' : 'SZT')
      expect(pozycje.every((p) => p.przesuniecie === undefined && p.pokryte === undefined && p.zamiennik === undefined)).toBe(true)
      expect(d.problemy.filter((p) => p.kod !== 'reszta-bez-wysylki')).toEqual([])
      expect(d.bruttoGr).toBe(aktywne + wysylka)
      if (!kg) for (const [k, l] of linie.entries()) expect(d.linie.filter((x) => x.pozycja === k).reduce((s, x) => s + x.bruttoGr, 0)).toBe(wartoscPozycjiGr(l.qty - (l.odrz ?? 0), n, Math.round(l.cena * 100)))
    }
  })
})

describe('korekta zwrotu zamiennika', () => {
  it('KSeF: zamiennik 50 g z oferty 50 g za 12,50 zł, zwrot całości → −12,50 zł (było −625,00 zł)', () => {
    const w = wierszKorektyKsef({ nazwa: 'Zamiennik', jednostka: 'KG', qty: 50, qtyChannel: null, unitPriceGross: 12.5, vatRate: '5', zwroconeBazowe: 50, wydaneBazowe: 50, naOferte: 50 })
    expect(w).toMatchObject({ jednostka: 'kg', ilosc: -0.05, bruttoGr: -1250 })
  })

  it('KSeF: zamiennik 2 szt. z oferty 3 szt. za 30 zł, zwrot 2 szt. → −20,00 zł (było −60,00 zł)', () => {
    const w = wierszKorektyKsef({ nazwa: 'Zamiennik', jednostka: 'SZT', qty: 2, qtyChannel: null, unitPriceGross: 30, vatRate: '23', zwroconeBazowe: 2, wydaneBazowe: 2, naOferte: 3 })
    expect(w.bruttoGr).toBe(-2000)
  })

  it('KSeF: pozycja bez zamiany bez pola naOferte liczy jak dotąd (qty × cena)', () => {
    expect(wierszKorektyKsef({ nazwa: 'X', jednostka: 'SZT', qty: 2, qtyChannel: null, unitPriceGross: 30, vatRate: '23', zwroconeBazowe: 2, wydaneBazowe: 2 }).bruttoGr).toBe(-6000)
  })

  it('wFirma: korekta idzie po pozycjach faktury (ilość po zwrocie), bez własnego liczenia ceny — zamiennik 0,05 kg → 0', () => {
    const k = zlozKorekte({
      fakturaId: '123',
      idExternal: 'kor-1',
      pozycje: [
        { id: '1', towarId: '9104', nazwa: 'Zamiennik', ilosc: 0.05 },
        { id: '2', towarId: null, nazwa: 'Wysyłka', ilosc: 1 },
      ] as never,
      zwrot: [{ towarId: '9104', ilosc: 0.05 }],
      opis: 'Zwrot',
    })
    expect(k.ok).toBe(true)
    if (k.ok) expect(Object.fromEntries(k.oczekiwane)).toEqual({ '1': 0, '2': 1 })
  })
})
