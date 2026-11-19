// reszta groszy z rabatu nigdy na pozycję za 0 zł, jedno źródło limitu
// rabatu dla adaptera Woo i dokumentu z tą samą granicą co do grosza, stop `rabat-niepewny-podzial` dopiero
// powyżej 1% wartości pozycji. Dane fikcyjne.
import { describe, expect, it } from 'vitest'
import { ustawieniaFirmyAdaptera } from '../adaptery/konta'
import { rozlozRabatWoo, WOO_MANIFEST, wooOrderFromApi } from '../adaptery/woo'
import { resztaZaokraglenGr } from '../rdzen/ceny'
import { zlozFakture } from '../wfirma/faktura'
import { parseKonfiguracjaFaktur } from '../wfirma/konfiguracja'
import { linieKsef } from '../ksef/linie'
import { KOD_RABATU_BEZ_PLATNEJ, KOD_RABATU_NIEPEWNEGO, type PozycjaZamowienia, PROG_PEWNOSCI_RABATU_PROC, rabatLiczonyNaDokumencie, type WejsciePozycji, zlozPozycjeDokumentu } from './pozycje'
import { rabatMaksProcent } from './ustawienia'

const W = { nazwa: 'Wysyłka', stawkaVat: '23' }

/**
 * Próby losowe (20 000 zamówień, stałe ziarno) sprawdzają poprawność podziału rabatu, nie szybkość. Osobno trwają
 * 0,5–2 s, ale w pełnym przebiegu jednostkowym obok testów integracyjnych potrafią przekroczyć domyślne 5 s vitest.
 * Jawny limit chroni przed zawieszeniem, a nie mierzy wydajności; liczebności próby nie zmniejszamy, bo progi
 * w asercjach (np. `zKorekta > 1000`, `odrzucone` 2 000–18 000) są policzone dla 20 000 zamówień.
 */
const LIMIT_PROBY_LOSOWEJ_MS = 60_000

function kwota(bruttoGr: number): { total: string; total_tax: string } {
  const netto = Math.round(bruttoGr / 1.23)
  return { total: (netto / 100).toFixed(2), total_tax: ((bruttoGr - netto) / 100).toFixed(2) }
}

/** Zamówienie WC REST v3: pozycje (sztuki, wartość brutto w groszach), wysyłka, opłaty (ujemna = rabat). */
function woo(linie: { qty: number; wartoscGr: number }[], o: { wysylkaGr?: number; oplatyGr?: number[]; pobranie?: boolean } = {}): Record<string, unknown> {
  const wys = o.wysylkaGr ?? 0
  const oplaty = o.oplatyGr ?? []
  const totalGr = linie.reduce((s, l) => s + l.wartoscGr, 0) + wys + oplaty.reduce((s, x) => s + x, 0)
  return {
    id: 9003,
    status: 'processing',
    currency: 'PLN',
    date_created_gmt: '2026-11-10T09:00:00',
    date_modified_gmt: '2026-11-10T09:05:00',
    ...(o.pobranie ? { payment_method: 'cod', payment_method_title: 'Za pobraniem' } : { date_paid_gmt: '2026-11-10T09:01:00', payment_method: 'blik', payment_method_title: 'Blik' }),
    total: (totalGr / 100).toFixed(2),
    shipping_total: kwota(wys).total,
    shipping_tax: kwota(wys).total_tax,
    line_items: linie.map((l, i) => ({ id: 100 + i, product_id: 10 + i, variation_id: 0, quantity: l.qty, ...kwota(l.wartoscGr), sku: `T${i}`, name: `Towar ${i}`, meta_data: [] })),
    fee_lines: oplaty.map((g, i) => ({ id: 500 + i, name: g < 0 ? 'Rabat' : 'Opłata', ...kwota(g) })),
    shipping_lines: [{ method_title: 'Kurier', ...kwota(wys) }],
  }
}

const poz = (sku: string, qty: number, cenaGr: number, extra: Partial<PozycjaZamowienia> = {}): PozycjaZamowienia => ({ sku, rodzaj: 'STOCKED', nazwa: `Towar ${sku}`, jednostka: 'SZT', wfirmaGoodId: '1', qty, qtyOdrzucone: 0, naOferte: 1, cenaBruttoGr: cenaGr, stawkaVat: '23', ...extra })

/** Ścieżka nowa: Woo → adapter (limit z ustawień firmy, jak host) → pozycje → dokument (limit z tych samych ustawień). */
function nowe(raw: Record<string, unknown>, settings: unknown = null, extra: Partial<WejsciePozycji> = {}) {
  const o = wooOrderFromApi(raw, ustawieniaFirmyAdaptera(settings as never))
  const pozycje = o.lines.map((l, i) => poz(`T${i}`, l.qty, Math.round(l.unitPriceGross * 100)))
  const d = zlozPozycjeDokumentu({ totalGross: o.totalGross, pozycje, wysylka: W, kosztWysylki: o.shippingCostGross ?? null, rabatMaksProcent: rabatMaksProcent(settings as never), ...extra })
  return { o, pozycje, d }
}

const wartosci = (d: ReturnType<typeof zlozPozycjeDokumentu>) => {
  const m = new Map<number, number>()
  for (const l of d.linie) if (!l.wysylka) m.set(l.pozycja, (m.get(l.pozycja) ?? 0) + l.bruttoGr)
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)
}
const wysylka = (d: ReturnType<typeof zlozPozycjeDokumentu>) => d.linie.filter((l) => l.wysylka).reduce((s, l) => s + l.bruttoGr, 0)
const kody = (d: { problemy: readonly { kod: string }[] }) => d.problemy.map((p) => p.kod)

/** Generator liczb (mulberry32): pełne 32 bity, bez słabych niskich bitów `ziarno % n`. */
function generator(ziarno: number) {
  let a = ziarno >>> 0
  return (n: number) => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n)
  }
}

describe('reszta groszy z rabatu nigdy na pozycję za 0 zł', () => {
  // kontrprzykład przeglądu: gratis 1 × 0,00, potem 42,05, 69,67, 3 × 44,80, 24,69; rabat 21,66 zł
  const LINIE = [
    { qty: 1, cenaGr: 0 },
    { qty: 1, cenaGr: 4205 },
    { qty: 1, cenaGr: 6967 },
    { qty: 3, cenaGr: 4480 },
    { qty: 1, cenaGr: 2469 },
  ]
  const przed = LINIE.reduce((s, l) => s + l.qty * l.cenaGr, 0)
  const RABAT = 2166

  it('kontrprzykład, ścieżka adapter → dokument → zlozFakture: gratis 0,00 (runda 2: −0,02), reszta na pierwszej płatnej, suma = kwota', () => {
    const { o, pozycje, d } = nowe(woo(LINIE.map((l) => ({ qty: l.qty, wartoscGr: l.qty * l.cenaGr })), { oplatyGr: [-RABAT] }))
    expect(o.lines[0]!.unitPriceGross).toBe(0)
    expect(d.problemy).toEqual([])
    expect(wartosci(d)[0]).toBe(0)
    expect(d.linie.every((l) => l.pozycja === 0 || l.bruttoGr > 0)).toBe(true)
    expect(d.bruttoGr).toBe(przed - RABAT)
    const f = zlozFakture({ idExternal: 'z/3/0', totalGross: o.totalGross, paymentMethod: 'Blik', paymentState: 'PAID', pozycje, konfiguracja: parseKonfiguracjaFaktur({ faktury: { kodyVat: { '23': 1 } } }), kosztWysylki: o.shippingCostGross })
    expect(f.problemy).toEqual([])
    expect(f.tresc).not.toBeNull()
  })

  it('kontrprzykład, ścieżka stare zamówienie (rabat liczony na dokumencie): gratis 0,00, żadna linia ujemna, suma = kwota', () => {
    const d = zlozPozycjeDokumentu({ totalGross: (przed - RABAT) / 100, pozycje: LINIE.map((l, i) => poz(`T${i}`, l.qty, l.cenaGr)), wysylka: W, kosztWysylki: 0 })
    expect(d.problemy).toEqual([])
    expect(wartosci(d)[0]).toBe(0)
    expect(d.linie.every((l) => l.bruttoGr >= 0 && (l.pozycja === 0 || l.bruttoGr > 0))).toBe(true)
    expect(d.bruttoGr).toBe(przed - RABAT)
  })

  it('losowo 20 000 zamówień z gratisem na pierwszej pozycji, rabat 6–10%, obie ścieżki: gratis = 0, żadna linia ujemna, suma = kwota', () => {
    const los = generator(23903)
    let zKorekta = 0
    for (let k = 0; k < 20000; k++) {
      const linie = [{ qty: 1 + los(3), cenaGr: 0 }, ...Array.from({ length: 1 + los(6) }, () => ({ qty: 1 + los(6), cenaGr: 100 + los(15000) }))]
      const p = linie.reduce((s, l) => s + l.qty * l.cenaGr, 0)
      const rabat = Math.floor((p * (6 + los(5))) / 100)
      const wys = los(3) ? 0 : 999 + los(2000)
      const n = nowe(woo(linie.map((l) => ({ qty: l.qty, wartoscGr: l.qty * l.cenaGr })), { oplatyGr: [-rabat], wysylkaGr: wys })).d
      const s = zlozPozycjeDokumentu({ totalGross: (p - rabat + wys) / 100, pozycje: linie.map((l, i) => poz(`T${i}`, l.qty, l.cenaGr)), wysylka: W, kosztWysylki: wys / 100 })
      for (const [nazwa, d] of [['nowe', n], ['stare', s]] as const) {
        expect(d.problemy, `${nazwa} ${k}`).toEqual([])
        expect(wartosci(d)[0], `${nazwa} ${k}`).toBe(0)
        expect(d.linie.every((l) => l.bruttoGr >= 0 && (l.pozycja === 0 || l.cenaBruttoGr > 0)), `${nazwa} ${k}`).toBe(true)
        expect(d.bruttoGr, `${nazwa} ${k}`).toBe(p - rabat + wys)
        expect(wysylka(d), `${nazwa} ${k}`).toBe(wys)
      }
      if (wartosci(s)[1] !== linie[1]!.qty * Math.round((linie[1]!.cenaGr * (p - rabat)) / p)) zKorekta++
    }
    expect(zKorekta).toBeGreaterThan(1000) // reszta groszy rzeczywiście trafiała na pierwszą płatną pozycję
  }, LIMIT_PROBY_LOSOWEJ_MS)

  it('gratis przed płatną pozycją za 0,01 zł: reszta −3 gr idzie na pozycję płatną i robi z niej −0,02 → problem, gratis bez zmian', () => {
    const d = zlozPozycjeDokumentu({ totalGross: 200.0 - 0.03 + 0.01, pozycje: [poz('G', 1, 0), poz('A', 1, 1), poz('B', 10, 2000)], wysylka: W, kosztWysylki: 0 })
    expect(kody(d)).toContain('cena-zero-po-rabacie')
  })

  it('zamówienie z samych gratisów i z rabatem = problem (dokument i KSeF), nie faktura z obniżoną wysyłką; adapter zostawia ceny', () => {
    const raw = woo([{ qty: 2, wartoscGr: 0 }], { oplatyGr: [-500], wysylkaGr: 1299 })
    const { o, d } = nowe(raw)
    expect(o.warnings.join(' ')).toContain('bez płatnej pozycji')
    expect(kody(d)).toContain(KOD_RABATU_BEZ_PLATNEJ)
    expect(linieKsef({ totalGross: o.totalGross, pozycje: [poz('G', 2, 0)], wysylka: W, kosztWysylki: o.shippingCostGross }).problemy.map((p) => p.tekst).join(' ')).toContain('nie ma płatnej pozycji')
    // same gratisy bez rabatu: faktura z wysyłką jak dotąd
    expect(nowe(woo([{ qty: 2, wartoscGr: 0 }], { wysylkaGr: 1299 })).d.problemy).toEqual([])
  })
})

describe('jeden limit rabatu (ustawienie firmy) dla adaptera i dokumentu', () => {
  const ust = (L: number) => ({ faktury: { rabatMaksProcent: L } })

  it('pole konta Woo `rabatMaksProcent` usunięte; adapter dostaje limit z ustawień firmy tą samą funkcją co dokument', () => {
    expect(WOO_MANIFEST.config.map((f) => f.key)).not.toContain('rabatMaksProcent')
    for (const s of [null, ust(30), ust(0), { faktury: { rabatMaksProcent: '35' } }, { faktury: { rabatMaksProcent: 140 } }]) expect(ustawieniaFirmyAdaptera(s as never).rabatMaksProcent).toBe(rabatMaksProcent(s as never))
  })

  it('rabat 40% (100,00 − 40,00 + wysyłka 12,99): limit 30 = adapter zostawia ceny i dokument staje; limit 50 = 60,00 + 12,99', () => {
    const raw = woo([{ qty: 1, wartoscGr: 10000 }], { oplatyGr: [-4000], wysylkaGr: 1299 })
    const r30 = nowe(raw, ust(30))
    expect(r30.o.lines[0]!.unitPriceGross).toBe(100)
    expect(r30.o.warnings.join(' ')).toContain('większy niż 30%')
    expect(kody(r30.d)).toEqual(['pozycje-drozsze-niz-zamowienie'])
    const f = zlozFakture({ idExternal: 'z/3/0', totalGross: r30.o.totalGross, paymentMethod: 'Blik', paymentState: 'PAID', pozycje: r30.pozycje, konfiguracja: parseKonfiguracjaFaktur(ust(30)), kosztWysylki: r30.o.shippingCostGross })
    expect(f.tresc).toBeNull()
    const r50 = nowe(raw, ust(50))
    expect(r50.o.lines[0]!.unitPriceGross).toBe(60)
    expect(r50.d.problemy).toEqual([])
    expect([wartosci(r50.d), wysylka(r50.d)]).toEqual([[6000], 1299])
  })

  it('granica co do grosza po obu stronach: rabat = limit przechodzi, o grosz więcej staje (limit 30 i 50)', () => {
    for (const L of [30, 50]) {
      const rowno = nowe(woo([{ qty: 1, wartoscGr: 10000 }], { oplatyGr: [-L * 100], wysylkaGr: 1299 }), ust(L))
      expect(rowno.o.lines[0]!.unitPriceGross, `L=${L}`).toBe((100 * (100 - L)) / 100)
      expect(rowno.d.problemy, `L=${L}`).toEqual([])
      const grosz = nowe(woo([{ qty: 1, wartoscGr: 10000 }], { oplatyGr: [-L * 100 - 1], wysylkaGr: 1299 }), ust(L))
      expect(grosz.o.lines[0]!.unitPriceGross, `L=${L}`).toBe(100)
      expect(kody(grosz.d), `L=${L}`).toEqual(['pozycje-drozsze-niz-zamowienie'])
    }
  })

  it('kontrprzykład przeglądu: 3 szt. za 24,01 (cena 8,00), rabat 12,01, limit 50: adapter rozkłada i dokument wystawia 12,00 (runda 2: adapter odmawiał)', () => {
    const r = rozlozRabatWoo([{ qty: 3, unitPriceGross: 8 }], 2401, 1201, 50, 1200)
    expect(r.ceny).toEqual([400])
    const { o, d } = nowe(woo([{ qty: 3, wartoscGr: 2401 }], { oplatyGr: [-1201] }), ust(50))
    expect(o.lines[0]!.unitPriceGross).toBe(4)
    expect(d.problemy).toEqual([])
    expect(d.bruttoGr).toBe(1200)
  })

  it('opłata dodatnia obok rabatu (pobranie): adapter liczy limit od tej samej różnicy co dokument (rabat − opłata)', () => {
    // rabat 45,00, pobranie +5,00: dokument widzi 40,00 → limit 40 przechodzi (55,00 + 17,99), limit 39 staje po obu stronach
    const raw = woo([{ qty: 1, wartoscGr: 10000 }], { oplatyGr: [-4500, 500], wysylkaGr: 1299 })
    const ok = nowe(raw, ust(40))
    expect(ok.o.lines[0]!.unitPriceGross).toBe(55)
    expect([wartosci(ok.d), wysylka(ok.d), ok.d.problemy]).toEqual([[5500], 1799, []])
    const stop = nowe(raw, ust(39))
    expect(stop.o.lines[0]!.unitPriceGross).toBe(100)
    expect(kody(stop.d)).toEqual(['pozycje-drozsze-niz-zamowienie'])
  })

  it('losowo 20 000 zamówień, limit 0–100, rabat 0–80%, opłaty dodatnie: adapter odrzuca rabat ⇔ dokument staje na limicie', () => {
    const los = generator(2392)
    let odrzucone = 0
    for (let k = 0; k < 20000; k++) {
      const L = los(101)
      const linie = Array.from({ length: 1 + los(6) }, () => ({ qty: 1 + los(8), wartoscGr: 100 + los(30000) }))
      const p = linie.reduce((s, l) => s + l.wartoscGr, 0)
      const rabat = 1 + Math.floor((p * los(81)) / 100)
      const oplata = los(3) ? 0 : 1 + los(1500)
      const wys = los(4) ? 0 : 999 + los(2000)
      const { o, d } = nowe(woo(linie, { oplatyGr: oplata ? [-rabat, oplata] : [-rabat], wysylkaGr: wys }), ust(L))
      const adapterOdrzucil = o.warnings.join(' ').includes('większy niż')
      const dokumentStaje = kody(d).includes('pozycje-drozsze-niz-zamowienie')
      expect(dokumentStaje, `${k}: L=${L} ${JSON.stringify(linie)} rabat ${rabat} opłata ${oplata} wysyłka ${wys}`).toBe(adapterOdrzucil)
      if (!dokumentStaje && !kody(d).includes('cena-zero-po-rabacie')) expect(d.bruttoGr, `${k}`).toBe(p - rabat + oplata + wys)
      if (adapterOdrzucil) odrzucone++
    }
    expect(odrzucone).toBeGreaterThan(2000)
    expect(odrzucone).toBeLessThan(18000)
  }, LIMIT_PROBY_LOSOWEJ_MS)
})

describe('stop rabat-niepewny-podzial dopiero ponad resztę zaokrągleń i 1% wartości pozycji', () => {
  it('pobranie bez rabatu, kwota niższa o grosze (1 szt. −2 gr, 2 szt. −2 gr, 3 szt. −3 gr): bez stopu, suma = kwota (runda 2: stop)', () => {
    for (const [qty, roznica] of [[1, 2], [2, 2], [3, 3]] as const) {
      const przed = qty * 5000
      const totalGr = przed - roznica + 1299
      const d = zlozPozycjeDokumentu({ totalGross: totalGr / 100, pozycje: [poz('A', qty, 5000)], wysylka: W, kosztWysylki: 12.99, pobranie: true })
      expect(resztaZaokraglenGr(przed, przed - roznica, qty), `${qty} szt.`).toBe(false) // runda 2 skalowała i stawała
      expect(d.problemy, `${qty} szt.`).toEqual([])
      expect(d.bruttoGr, `${qty} szt.`).toBe(totalGr)
      expect(wysylka(d)).toBe(1299)
    }
  })

  it('nowe zamówienie po rabacie za pobraniem, z którego obsługa usunęła pozycję (kwota − cena × sztuki): bez stopu, suma = kwota', () => {
    const los = generator(2393)
    let staloByWRundzie2 = 0
    let stop = 0
    for (let k = 0; k < 20000; k++) {
      const linie = Array.from({ length: 2 + los(6) }, () => ({ qty: 1 + los(6), wartoscGr: 100 + los(15000) }))
      const p = linie.reduce((s, l) => s + l.wartoscGr, 0)
      const rabat = Math.floor((p * (6 + los(5))) / 100)
      const wys = 999 + los(2000)
      const o = wooOrderFromApi(woo(linie, { oplatyGr: [-rabat], wysylkaGr: wys, pobranie: true }))
      const usun = los(o.lines.length)
      const pozycje = o.lines.map((l, i) => poz(`T${i}`, l.qty, Math.round(l.unitPriceGross * 100))).filter((_, i) => i !== usun)
      const totalGr = Math.round(o.totalGross * 100) - o.lines[usun]!.qty * Math.round(o.lines[usun]!.unitPriceGross * 100)
      const przed = pozycje.reduce((s, x) => s + x.qty * x.cenaBruttoGr, 0)
      const sztuk = pozycje.reduce((s, x) => s + x.qty, 0)
      if (przed - (totalGr - wys) > Math.ceil(sztuk / 2)) staloByWRundzie2++
      const d = zlozPozycjeDokumentu({ totalGross: totalGr / 100, pozycje, wysylka: W, kosztWysylki: wys / 100, pobranie: true })
      if (kody(d).includes(KOD_RABATU_NIEPEWNEGO)) {
        // zostaje stop tylko, gdy grosze reszty przekraczają 1% tego, co zostało w zamówieniu (towar za kilka złotych):
        // z samych liczb nie da się odróżnić takiej reszty od rabatu liczonego na dokumencie
        stop++
        expect(przed - (totalGr - wys), `${k}`).toBeLessThanOrEqual(Math.ceil(o.lines.reduce((s, l) => s + l.qty, 0) / 2))
        expect(przed, `${k}`).toBeLessThan(1000)
      } else {
        expect(d.problemy, `${k}`).toEqual([])
        expect(d.bruttoGr, `${k}`).toBe(totalGr)
      }
    }
    expect(staloByWRundzie2).toBeGreaterThan(100) // test łapie przypadki, które w rundzie 2 stawały
    expect(stop).toBeLessThanOrEqual(5) // runda 2: 274 z 20 000 w tym teście (przegląd: 2 460 z 20 000 w szerszej symulacji)
  }, LIMIT_PROBY_LOSOWEJ_MS)

  it('prawdziwy rabat liczony na dokumencie przy pobraniu albo paczkach nadal staje; granica 1% co do grosza', () => {
    // 6% z 50,00 przy pobraniu (z opłatą ≥ rabat tego się nie wykryje; zamyka to przeliczenie zapisanych zamówień)
    expect(kody(zlozPozycjeDokumentu({ totalGross: 47 + 12.99, pozycje: [poz('A', 1, 5000)], wysylka: W, kosztWysylki: 12.99, pobranie: true }))).toEqual([KOD_RABATU_NIEPEWNEGO])
    expect(PROG_PEWNOSCI_RABATU_PROC).toBe(1)
    // 100,00: rabat 1,00 (= 1%) bez stopu, 1,01 stop; to samo dla paczki dodatkowej i dla pytania paczki o matkę
    const przy = (rabatGr: number, extra: Partial<WejsciePozycji>) => zlozPozycjeDokumentu({ totalGross: (10000 - rabatGr) / 100, pozycje: [poz('A', 4, 2500)], wysylka: W, kosztWysylki: 0, ...extra })
    for (const extra of [{ pobranie: true }, { paczkiDodatkowe: true }]) {
      expect(przy(100, extra).problemy).toEqual([])
      expect(przy(100, extra).bruttoGr).toBe(9900)
      expect(kody(przy(101, extra))).toEqual([KOD_RABATU_NIEPEWNEGO])
    }
    expect(rabatLiczonyNaDokumencie({ totalGross: 99, pozycje: [poz('A', 4, 2500)], kosztWysylki: 0 })).toBe(false)
    expect(rabatLiczonyNaDokumencie({ totalGross: 98.99, pozycje: [poz('A', 4, 2500)], kosztWysylki: 0 })).toBe(true)
  })
})
