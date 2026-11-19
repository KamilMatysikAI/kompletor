// jedna reguła rozkładu rabatu na całe zamówienie dla zamówienia nowego (ceny po
// rabacie z adaptera Woo) i starego (ceny sprzed rabatu, rabat liczony na dokumencie), zgodna z fakturą BaseLinkera co do
// grosza; stop przy paczkach dodatkowych i pobraniu, gdy rabat liczy się dopiero na dokumencie; sufit rabatu
// i pozycja za 0 zł; płatność po dokładnym typie; brakujące przypadki. Dane fikcyjne; liczby z rozbicia
// różnic podglądu faktur (same kwoty, bez danych klientów).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { rozlozRabatWoo, wooOrderFromApi } from '../adaptery/woo'
import { cenaPoRabacieGr, DOMYSLNY_SUFIT_RABATU_PROC, sufitRabatuProc } from '../rdzen/ceny'
import { zlozFakture } from '../wfirma/faktura'
import { parseKonfiguracjaFaktur } from '../wfirma/konfiguracja'
import { formaPlatnosci } from '../wfirma/platnosci'
import { KOD_RABATU_BEZ_PLATNEJ, KOD_RABATU_NIEPEWNEGO, KOMUNIKAT_RABATU, KOMUNIKAT_RABATU_BEZ_PLATNEJ, komunikatDokumentu, type PozycjaZamowienia, rabatLiczonyNaDokumencie, zlozPozycjeDokumentu } from './pozycje'
import { rabatMaksProcent } from './ustawienia'

const W = { nazwa: 'Wysyłka', stawkaVat: '23' }

/** Kwota brutto (grosze) jako para netto + VAT 23% w tekstach Woo. */
function kwota(bruttoGr: number): { total: string; total_tax: string } {
  const netto = Math.round(bruttoGr / 1.23)
  return { total: (netto / 100).toFixed(2), total_tax: ((bruttoGr - netto) / 100).toFixed(2) }
}

/** Zamówienie WC REST v3: pozycje (sztuki, wartość brutto pozycji w groszach), wysyłka, opłaty (ujemna = rabat). */
function woo(linie: { qty: number; wartoscGr: number }[], o: { wysylkaGr?: number; oplatyGr?: number[]; pobranie?: boolean } = {}): Record<string, unknown> {
  const wys = o.wysylkaGr ?? 0
  const oplaty = o.oplatyGr ?? []
  const totalGr = linie.reduce((s, l) => s + l.wartoscGr, 0) + wys + oplaty.reduce((s, x) => s + x, 0)
  const sw = kwota(wys)
  return {
    id: 9002,
    status: 'processing',
    currency: 'PLN',
    date_created_gmt: '2026-11-10T09:00:00',
    date_modified_gmt: '2026-11-10T09:05:00',
    ...(o.pobranie ? { payment_method: 'cod', payment_method_title: 'Za pobraniem' } : { date_paid_gmt: '2026-11-10T09:01:00', payment_method: 'blik', payment_method_title: 'Blik' }),
    total: (totalGr / 100).toFixed(2),
    shipping_total: sw.total,
    shipping_tax: sw.total_tax,
    line_items: linie.map((l, i) => ({ id: 100 + i, product_id: 10 + i, variation_id: 0, quantity: l.qty, ...kwota(l.wartoscGr), sku: `T${i}`, name: `Towar ${i}`, meta_data: [] })),
    fee_lines: oplaty.map((g, i) => ({ id: 500 + i, name: g < 0 ? 'Rabat' : 'Opłata', ...kwota(g) })),
    shipping_lines: [{ method_title: 'Kurier', ...kwota(wys) }],
  }
}

const poz = (sku: string, qty: number, cenaGr: number, extra: Partial<PozycjaZamowienia> = {}): PozycjaZamowienia => ({ sku, rodzaj: 'STOCKED', nazwa: `Towar ${sku}`, jednostka: 'SZT', wfirmaGoodId: '1', qty, qtyOdrzucone: 0, naOferte: 1, cenaBruttoGr: cenaGr, stawkaVat: '23', ...extra })

const wartosci = (d: ReturnType<typeof zlozPozycjeDokumentu>) => {
  const m = new Map<number, number>()
  for (const l of d.linie) if (!l.wysylka) m.set(l.pozycja, (m.get(l.pozycja) ?? 0) + l.bruttoGr)
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)
}
const wysylka = (d: ReturnType<typeof zlozPozycjeDokumentu>) => d.linie.filter((l) => l.wysylka).reduce((s, l) => s + l.bruttoGr, 0)

/** Ścieżka „stare zamówienie”: cena za sztukę sprzed rabatu w zamówieniu, rabat liczony na dokumencie. */
function stare(linie: { qty: number; cenaGr: number }[], kwotaGr: number, kosztGr = 0, extra: Partial<Parameters<typeof zlozPozycjeDokumentu>[0]> = {}) {
  return zlozPozycjeDokumentu({ totalGross: kwotaGr / 100, pozycje: linie.map((l, i) => poz(`T${i}`, l.qty, l.cenaGr)), wysylka: W, kosztWysylki: kosztGr / 100, ...extra })
}

/** Ścieżka „nowe zamówienie przez adapter”: odpowiedź Woo → `wooOrderFromApi` → pozycje jak `pozycjeZamowienia` → dokument. */
function nowe(raw: Record<string, unknown>, extra: Partial<Parameters<typeof zlozPozycjeDokumentu>[0]> = {}) {
  const o = wooOrderFromApi(raw)
  const pozycje = o.lines.map((l, i) => poz(`T${i}`, l.qty, Math.round(l.unitPriceGross * 100)))
  return { o, d: zlozPozycjeDokumentu({ totalGross: o.totalGross, pozycje, wysylka: W, kosztWysylki: o.shippingCostGross ?? null, ...extra }) }
}

/** Reguła BL wprost (wzorzec testu): cena × po / przed do grosza, reszta na pierwszej pozycji. */
function regulaBl(linie: { qty: number; cenaGr: number }[], poGr: number): number[] {
  const przed = linie.reduce((s, l) => s + l.qty * l.cenaGr, 0)
  const w = linie.map((l) => l.qty * cenaPoRabacieGr(l.cenaGr, przed, poGr))
  w[0]! += poGr - w.reduce((s, x) => s + x, 0)
  return w
}

// Wiersze z rozbicia różnic podglądu faktur 11.11 (nasze ceny pozycji, kwota BL, pozycje BL). Ilości wiersza 21 z danych;
// wiersza 18 odtworzone z liczb BL (jedyny podział, który daje 44,75 / 53,52 / 24,27); w pozostałych 1 sztuka na pozycję.
const WIERSZE: { nr: number; linie: { qty: number; cenaGr: number }[]; kwotaGr: number; bl: number[] }[] = [
  { nr: 1, linie: [1599, 2477, 1149, 1897, 2638, 470].map((c) => ({ qty: 1, cenaGr: c })), kwotaGr: 9207, bl: [1440, 2229, 1034, 1707, 2374, 423] },
  { nr: 2, linie: [3740, 3540, 3540].map((c) => ({ qty: 1, cenaGr: c })), kwotaGr: 9738, bl: [3366, 3186, 3186] },
  { nr: 3, linie: [3651, 1499, 4997].map((c) => ({ qty: 1, cenaGr: c })), kwotaGr: 9132, bl: [3286, 1349, 4497] },
  { nr: 7, linie: [2070, 2070, 1897, 5370].map((c) => ({ qty: 1, cenaGr: c })), kwotaGr: 10266, bl: [1863, 1863, 1707, 4833] },
  { nr: 8, linie: [1248, 1240, 1237, 1449, 2898, 1500, 1549].map((c) => ({ qty: 1, cenaGr: c })), kwotaGr: 10009, bl: [1124, 1116, 1113, 1304, 2608, 1350, 1394] },
  { nr: 10, linie: [5688, 1490, 1998, 4797].map((c) => ({ qty: 1, cenaGr: c })), kwotaGr: 12576, bl: [5120, 1341, 1798, 4317] },
  { nr: 11, linie: [5673, 2440, 2597, 2164, 2296, 1670].map((c) => ({ qty: 1, cenaGr: c })), kwotaGr: 15156, bl: [5106, 2196, 2337, 1948, 2066, 1503] },
  { nr: 17, linie: [2000, 2000, 2001, 2001, 1629, 1130, 469].map((c) => ({ qty: 1, cenaGr: c })), kwotaGr: 10556, bl: [1880, 1880, 1881, 1881, 1531, 1062, 441] },
  { nr: 18, linie: [{ qty: 5, cenaGr: 994 }, { qty: 4, cenaGr: 1487 }, { qty: 3, cenaGr: 899 }], kwotaGr: 12254, bl: [4475, 5352, 2427] },
  { nr: 19, linie: [{ qty: 1, cenaGr: 13500 }], kwotaGr: 12150, bl: [12150] },
  { nr: 21, linie: [{ qty: 3, cenaGr: 2397 }, { qty: 5, cenaGr: 2697 }, { qty: 3, cenaGr: 2397 }, { qty: 2, cenaGr: 4797 }], kwotaGr: 33715, bl: [6475, 12135, 6471, 8634] },
]

describe('zamówienie nowe i stare dają ten sam podział groszy co BL', () => {
  for (const w of WIERSZE) {
    it(`wiersz ${w.nr}: stare (rabat na dokumencie) = nowe (ceny z adaptera) = BL`, () => {
      const s = stare(w.linie, w.kwotaGr)
      expect(s.problemy).toEqual([])
      expect(wartosci(s)).toEqual(w.bl)
      const przed = w.linie.reduce((a, l) => a + l.qty * l.cenaGr, 0)
      const { d } = nowe(woo(w.linie.map((l) => ({ qty: l.qty, wartoscGr: l.qty * l.cenaGr })), { oplatyGr: [w.kwotaGr - przed] }))
      expect(d.problemy).toEqual([])
      expect(wartosci(d)).toEqual(w.bl)
      expect(d.bruttoGr).toBe(w.kwotaGr)
    })
  }

  it('wiersz 21 krok po kroku: adapter zapisuje 21,57 / 24,27 / 21,57 / 43,17, dokument dokłada tylko 4 gr na pierwszą pozycję (bez drugiego skalowania)', () => {
    const { o, d } = nowe(woo([{ qty: 3, wartoscGr: 7191 }, { qty: 5, wartoscGr: 13485 }, { qty: 3, wartoscGr: 7191 }, { qty: 2, wartoscGr: 9594 }], { oplatyGr: [-3746] }))
    expect(o.lines.map((l) => l.unitPriceGross)).toEqual([21.57, 24.27, 21.57, 43.17])
    expect(wartosci(d)).toEqual([6475, 12135, 6471, 8634])
    // przed poprawką (runda 1) ta ścieżka dawała 64,73 / 121,35 / 64,71 / 86,36
    expect(d.linie.filter((l) => l.pozycja === 3).map((l) => l.cenaBruttoGr)).toEqual([4317])
  })

  it('losowo 4000 zamówień (różne sztuki, rabat 1–45%, wysyłka, ceny z resztą groszy): obie ścieżki = reguła BL co do grosza', () => {
    let ziarno = 2390
    const los = (n: number) => {
      ziarno = (ziarno * 1103515245 + 12345) % 2147483648
      return ziarno % n
    }
    let rozne = 0
    for (let k = 0; k < 4000; k++) {
      const linie = Array.from({ length: 1 + los(7) }, () => ({ qty: 1 + los(6), cenaGr: 100 + los(15000) }))
      const przed = linie.reduce((s, l) => s + l.qty * l.cenaGr, 0)
      const rabat = Math.max(1, Math.floor((przed * (1 + los(45))) / 100))
      const wys = los(3) ? 0 : 999 + los(2000)
      const po = przed - rabat
      const bl = regulaBl(linie, po)
      const s = stare(linie, po + wys, wys)
      const { d } = nowe(woo(linie.map((l) => ({ qty: l.qty, wartoscGr: l.qty * l.cenaGr })), { oplatyGr: [-rabat], wysylkaGr: wys }))
      expect(s.problemy, `stare ${k}`).toEqual([])
      expect(d.problemy, `nowe ${k}`).toEqual([])
      expect(wartosci(s), `stare ${k}`).toEqual(bl)
      expect(wartosci(d), `nowe ${k}`).toEqual(bl)
      expect(wysylka(d), `nowe ${k}`).toBe(wys)
      if (wartosci(d).join() !== wartosci(s).join()) rozne++
    }
    expect(rozne).toBe(0)
  })

  it('wartość pozycji Woo niepodzielna przez sztuki (cena za sztukę z resztą): obie ścieżki zgodne, suma = kwota', () => {
    // 3 szt. za 23,99 zł → cena 8,00 (zapis do grosza), przed = 15,99 + 24,00; rabat 4,00 zł
    const raw = woo([{ qty: 1, wartoscGr: 1599 }, { qty: 3, wartoscGr: 2399 }], { oplatyGr: [-400] })
    const { d } = nowe(raw)
    const s = stare([{ qty: 1, cenaGr: 1599 }, { qty: 3, cenaGr: 800 }], 3598)
    expect(wartosci(d)).toEqual(wartosci(s))
    expect(d.bruttoGr).toBe(3598)
  })
})

describe('rabat liczony na dokumencie przy paczce dodatkowej albo pobraniu = stop z komunikatem', () => {
  // kontrprzykład 1 przeglądu: A 2 × 50,00 (1 szt. przeniesiona do paczki 2), B 1 × 100,00, rabat 10%, wysyłka 0, zapłacone 180,00
  const matka = [poz('A', 2, 5000, { qtyOdrzucone: 1 }), poz('B', 1, 10000)]

  it('kontrprzykład 1: zamówienie główne z paczką dodatkową staje (runda 1: 135,00 + paczka 50,00 = 185,00 przy 180,00)', () => {
    const bez = zlozPozycjeDokumentu({ totalGross: 180, pozycje: matka, wysylka: W, kosztWysylki: 0 })
    expect(bez.bruttoGr).toBe(13500) // tak liczyła runda 1: faktura matki 135,00, a paczka 2 dostawała 50,00
    const z = zlozPozycjeDokumentu({ totalGross: 180, pozycje: matka, wysylka: W, kosztWysylki: 0, paczkiDodatkowe: true })
    expect(z.problemy.map((p) => p.kod)).toEqual([KOD_RABATU_NIEPEWNEGO])
    expect(komunikatDokumentu(z.problemy)).toBe(KOMUNIKAT_RABATU)
    expect(rabatLiczonyNaDokumencie({ totalGross: 180, pozycje: matka, kosztWysylki: 0 })).toBe(true)
  })

  it('kontrprzykład 1: paczka dodatkowa zamówienia głównego z rabatem na dokumencie też staje; zamówienie główne z cenami po rabacie nie', () => {
    const dziecko = zlozPozycjeDokumentu({ totalGross: 50, pozycje: [poz('A', 1, 5000)], wysylka: W, rabatMatkiNaDokumencie: true })
    expect(dziecko.problemy.map((p) => p.kod)).toEqual([KOD_RABATU_NIEPEWNEGO])
    // nowe zamówienie: ceny po rabacie z adaptera (45,00 i 90,00) — paczki wychodzą po cenie po rabacie, wszystko się zgadza
    const poRabacie = [poz('A', 2, 4500, { qtyOdrzucone: 1 }), poz('B', 1, 9000)]
    expect(rabatLiczonyNaDokumencie({ totalGross: 180, pozycje: poRabacie, kosztWysylki: 0 })).toBe(false)
    const m = zlozPozycjeDokumentu({ totalGross: 180, pozycje: poRabacie, wysylka: W, kosztWysylki: 0, paczkiDodatkowe: true })
    expect(m.problemy).toEqual([])
    expect(m.bruttoGr + 4500).toBe(18000)
  })

  it('kontrprzykład 2: stare zamówienie z rabatem i pobraniem staje (runda 1: towar 95,00 + wysyłka 12,99 zamiast 90,00 + 17,99)', () => {
    const pozycje = [poz('A', 1, 10000, { stawkaVat: '8' })]
    const bez = zlozPozycjeDokumentu({ totalGross: 107.99, pozycje, wysylka: W, kosztWysylki: 12.99 })
    expect([wartosci(bez), wysylka(bez)]).toEqual([[9500], 1299])
    const f = zlozFakture({ idExternal: 'z/1/0', totalGross: 107.99, paymentMethod: 'Za pobraniem', paymentState: 'COD', pozycje, konfiguracja: parseKonfiguracjaFaktur({ faktury: { kodyVat: { '23': 1, '8': 2 } } }), kosztWysylki: 12.99 })
    expect(f.tresc).toBeNull()
    expect(f.problemy.map((p) => p.kod)).toEqual([KOD_RABATU_NIEPEWNEGO])
  })

  it('kontrprzykład 2 jako nowe zamówienie (ceny po rabacie z adaptera): 90,00 + 17,99 bez problemu, także za pobraniem', () => {
    const { o, d } = nowe(woo([{ qty: 1, wartoscGr: 10000 }], { oplatyGr: [-1000, 500], wysylkaGr: 1299, pobranie: true }), { pobranie: true })
    expect(o.paymentState).toBe('COD')
    expect(d.problemy).toEqual([])
    expect([wartosci(d), wysylka(d)]).toEqual([[9000], 1799])
  })

  it('pobranie bez rabatu i pobranie z resztą zaokrągleń: bez stopu (rabatu nie liczymy na dokumencie)', () => {
    expect(zlozPozycjeDokumentu({ totalGross: 47.99, pozycje: [poz('A', 1, 3000)], wysylka: W, kosztWysylki: 12.99, pobranie: true }).problemy).toEqual([])
    const r = zlozPozycjeDokumentu({ totalGross: 24.01, pozycje: [poz('A', 3, 800)], wysylka: W, kosztWysylki: 0, pobranie: true, paczkiDodatkowe: true })
    expect(r.problemy).toEqual([])
    expect(r.bruttoGr).toBe(2401)
  })
})

describe('sufit rabatu i pozycja za 0 zł', () => {
  it('kontrprzykłady przeglądu: pozycje 200,00 + wysyłka 15,00 przy kwocie 15,01 albo 65,00 → pozycje-drozsze-niz-zamowienie', () => {
    for (const k of [15.01, 65]) {
      const d = zlozPozycjeDokumentu({ totalGross: k, pozycje: [poz('A', 1, 20000)], wysylka: W, kosztWysylki: 15 })
      expect(d.problemy.map((p) => p.kod), `kwota ${k}`).toEqual(['pozycje-drozsze-niz-zamowienie'])
      expect(d.problemy[0]).toMatchObject({ nasze: 21500, bl: Math.round(k * 100) })
    }
  })

  it('rabat równy sufitowi przechodzi, o grosz większy nie; sufit firmy z ustawień', () => {
    expect(zlozPozycjeDokumentu({ totalGross: 115, pozycje: [poz('A', 1, 20000)], wysylka: W, kosztWysylki: 15 }).problemy).toEqual([])
    expect(zlozPozycjeDokumentu({ totalGross: 114.99, pozycje: [poz('A', 1, 20000)], wysylka: W, kosztWysylki: 15 }).problemy.map((p) => p.kod)).toEqual(['pozycje-drozsze-niz-zamowienie'])
    const cfg = parseKonfiguracjaFaktur({ faktury: { kodyVat: { '23': 1 }, rabatMaksProcent: 30 } })
    expect(cfg.rabatMaksProcent).toBe(30)
    const f = zlozFakture({ idExternal: 'z/1/0', totalGross: 135, paymentMethod: 'Blik', paymentState: 'PAID', pozycje: [poz('A', 1, 20000)], konfiguracja: cfg, kosztWysylki: 15 })
    expect(f.problemy.map((p) => p.kod)).toEqual(['pozycje-drozsze-niz-zamowienie'])
    expect(zlozFakture({ idExternal: 'z/1/0', totalGross: 155, paymentMethod: 'Blik', paymentState: 'PAID', pozycje: [poz('A', 1, 20000)], konfiguracja: cfg, kosztWysylki: 15 }).problemy).toEqual([])
  })

  it('ustawienie: domyślnie 50, poza zakresem albo nie liczba = 50', () => {
    expect(DOMYSLNY_SUFIT_RABATU_PROC).toBe(50)
    expect(rabatMaksProcent(null)).toBe(50)
    expect(rabatMaksProcent({ faktury: { rabatMaksProcent: 20 } })).toBe(20)
    expect(rabatMaksProcent({ faktury: { rabatMaksProcent: '35' } })).toBe(35)
    for (const v of [-1, 101, 'x', null, true]) expect(sufitRabatuProc(v)).toBe(50)
  })

  it('pozycja za 0 zł po rabacie (sufit firmy 100%) = problem cena-zero-po-rabacie', () => {
    const d = zlozPozycjeDokumentu({ totalGross: 5, pozycje: [poz('A', 1, 1000), poz('B', 1, 1)], wysylka: W, kosztWysylki: 0, rabatMaksProcent: 100 })
    expect(d.problemy.map((p) => p.kod)).toContain('cena-zero-po-rabacie')
  })

  it('adapter Woo: rabat z opłat ponad sufit konta albo dający pozycję za 0 zł = ceny bez rabatu i ostrzeżenie', () => {
    const linie = [{ qty: 1, unitPriceGross: 100 }]
    expect(rozlozRabatWoo(linie, 10000, 5000)).toMatchObject({ ceny: [5000] })
    expect(rozlozRabatWoo(linie, 10000, 5001).ceny).toBeNull()
    expect(rozlozRabatWoo(linie, 10000, 5001).ostrzezenie).toContain('większy niż 50% wartości pozycji')
    expect(rozlozRabatWoo(linie, 10000, 3001, 30).ceny).toBeNull()
    expect(rozlozRabatWoo([{ qty: 1, unitPriceGross: 10 }, { qty: 1, unitPriceGross: 0.01 }], 1001, 1000, 100).ostrzezenie).toContain('za 0 zł')
    // dokument z sufitem firmy zatrzymuje takie zamówienie (ceny bez rabatu, kwota po rabacie)
    const { d } = nowe(woo([{ qty: 1, wartoscGr: 20000 }], { oplatyGr: [-15000], wysylkaGr: 1500 }))
    expect(d.problemy.map((p) => p.kod)).toEqual(['pozycje-drozsze-niz-zamowienie'])
  })

  it('adapter Woo: rabat w granicach reszty zaokrągleń (1 gr przy 3 sztukach) = ceny bez zmian, resztę dokłada dokument', () => {
    const { o, d } = nowe(woo([{ qty: 3, wartoscGr: 3000 }], { oplatyGr: [-1] }))
    expect(o.lines[0]!.unitPriceGross).toBe(10)
    expect(o.warnings.join(' ')).toContain('w granicach zaokrągleń')
    expect(d.problemy).toEqual([])
    expect(d.bruttoGr).toBe(2999)
  })
})

describe('płatność po dokładnym typie płatności', () => {
  it('typy Allegro: ONLINE i WIRE_TRANSFER = przelew, SPLIT_PAYMENT i EXTENDED_TERM = nieznana; „online” jako fragment nie łapie', () => {
    expect(formaPlatnosci('ONLINE (AF)', 'PAID')).toBe('transfer')
    expect(formaPlatnosci('ONLINE', 'PAID')).toBe('transfer')
    expect(formaPlatnosci('WIRE_TRANSFER (PAYU)', 'PAID')).toBe('transfer')
    expect(formaPlatnosci('SPLIT_PAYMENT (AF)', 'PAID')).toBeNull()
    expect(formaPlatnosci('EXTENDED_TERM (AF)', 'PAID')).toBeNull()
    expect(formaPlatnosci('Karta płatnicza online', 'PAID')).toBeNull()
    expect(formaPlatnosci('Online COD', 'UNPAID')).toBeNull()
    expect(formaPlatnosci('Płatność online z PayU', 'PAID')).toBe('transfer') // reguła „payu”, nie „online”
  })

  it('reguła firmy z `dokladnie` w ustawieniach', () => {
    const cfg = parseKonfiguracjaFaktur({ faktury: { platnosci: [{ zawiera: 'EXTENDED_TERM', forma: 'transfer', dokladnie: true }] } })
    expect(formaPlatnosci('EXTENDED_TERM (AF)', 'PAID', cfg.platnosci)).toBe('transfer')
    expect(formaPlatnosci('NOT_EXTENDED_TERM', 'PAID', cfg.platnosci)).toBeNull()
  })
})

describe('przypadki brzegowe rabatu na dokumencie', () => {
  it('kilka stawek VAT: rabat proporcjonalnie brutto, netto z sum per stawka', () => {
    const pozycje = [poz('A', 1, 10000), poz('B', 1, 10000, { stawkaVat: '5' }), poz('C', 1, 4320, { stawkaVat: '8' })]
    const d = zlozPozycjeDokumentu({ totalGross: 218.88, pozycje, wysylka: W, kosztWysylki: 0 })
    expect(d.problemy).toEqual([])
    expect(wartosci(d)).toEqual([9000, 9000, 3888])
    expect(d.nettoGr).toBe(Math.round(900000 / 123) + Math.round(900000 / 105) + Math.round(388800 / 108))
  })

  it('zestaw jako pierwsza pozycja: reszta groszy na pierwszej zwykłej pozycji, suma = kwota', () => {
    const zestaw = poz('Z', 1, 5200, { rodzaj: 'BUNDLE', skladniki: [{ sku: 'S1', nazwa: 'S1', jednostka: 'SZT', wfirmaGoodId: '7', qty: 1, cenaDetalicznaBrutto: 30, stawkaVat: '23' }, { sku: 'S2', nazwa: 'S2', jednostka: 'SZT', wfirmaGoodId: '8', qty: 1, cenaDetalicznaBrutto: 30, stawkaVat: '23' }] })
    const d = zlozPozycjeDokumentu({ totalGross: 78.39, pozycje: [zestaw, poz('A', 3, 1001)], wysylka: W, kosztWysylki: 0 })
    expect(d.problemy).toEqual([])
    expect(d.bruttoGr).toBe(7839)
  })

  it('pozycja na wagę (kg) jako pierwsza: suma = kwota', () => {
    const kg = poz('K', 250, 1999, { jednostka: 'KG', naOferte: 250 })
    const d = zlozPozycjeDokumentu({ totalGross: 26.99, pozycje: [kg, poz('A', 1, 1000)], wysylka: W, kosztWysylki: 0 })
    expect(d.problemy).toEqual([])
    expect(d.bruttoGr).toBe(2699)
  })

  it('pierwsza pozycja odrzucona w całości: reszta na następnej, faktura = kwota bez odrzuconej (po rabacie)', () => {
    const d = zlozPozycjeDokumentu({ totalGross: 46.83, pozycje: [poz('A', 1, 2000, { qtyOdrzucone: 1 }), poz('B', 3, 1001)], wysylka: W, kosztWysylki: 0 })
    expect(d.problemy).toEqual([])
    expect(d.linie.every((l) => l.sku === 'B')).toBe(true)
    // A: 20,00 × 4683/5003 = 18,72 (zwrot), B: reszta do kwoty
    expect(d.bruttoGr).toBe(4683 - 1872)
  })
})

describe('wołający przekazują koszt wysyłki i pola reguły rabatu (strażnik źródła)', () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
  it('faktura wFirmy (zapis i podgląd) i szkic KSeF podają koszt wysyłki, paczki dodatkowe i (KSeF) sufit z pobraniem', () => {
    const zapis = src('../wfirma/adapter-zapis.ts')
    expect(zapis).toContain('kosztWysylki: kosztWysylkiZamowienia(o)')
    expect(zapis).toContain('paczkiDodatkowe: true')
    expect(zapis).toContain('rabatMatkiNaDokumencie: true')
    expect(src('../wfirma/podglad.ts')).toMatch(/kosztWysylki: kosztWysylkiZamowienia\(o\),\s*\.\.\.\(zPaczkami\.has\(o\.id\)/)
    const szkice = src('../ksef/szkice.ts')
    expect(szkice.match(/kosztWysylki: kosztWysylkiZamowienia\(o\), \.\.\.\(await wejscieDokumentu\(db, settings, o, pozycje\)\)/g)).toHaveLength(2)
    // paczka dodatkowa KSeF na sumę jej pozycji i z rabatem matki, jak faktura wFirmy
    expect(szkice).toContain('totalGross: kwotaPaczkiDodatkowej(pozycje)')
    expect(szkice).toContain('rabatMatkiNaDokumencie: true')
    expect(src('../wfirma/faktura.ts')).toContain("pobranie: w.paymentState === 'COD'")
  })
})

describe('tekst dla biura przy rabacie bez płatnej pozycji', () => {
  it('komunikatDokumentu zwraca zdanie z drogą ręczną zamiast samego kodu (ścieżka wFirmy); KSeF ma ten sam tekst', () => {
    expect(komunikatDokumentu([{ kategoria: 'INNE', kod: KOD_RABATU_BEZ_PLATNEJ, sku: null }])).toBe(KOMUNIKAT_RABATU_BEZ_PLATNEJ)
    expect(KOMUNIKAT_RABATU_BEZ_PLATNEJ).toMatch(/^Rabat na całe zamówienie, a w zamówieniu nie ma płatnej pozycji/)
    expect(KOMUNIKAT_RABATU_BEZ_PLATNEJ).toContain('„Wyślij bez faktury”')
    expect(KOMUNIKAT_RABATU_BEZ_PLATNEJ).not.toContain(KOD_RABATU_BEZ_PLATNEJ)
  })
})
