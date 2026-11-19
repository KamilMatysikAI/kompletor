// plan przeliczenia cen pozycji zamówień Woo zapisanych (ceny sprzed rabatu z ujemnych opłat).
// Po przeliczeniu faktura = kwota zapłacona, podział jak BaseLinker (cena × stosunek do grosza, reszta na pierwszej
// płatnej pozycji), bez `rabat-niepewny-podzial`; ten sam wynik co zamówienie przyjęte już. Dane fikcyjne.
import { describe, expect, it } from 'vitest'
import { defaultRegistry } from '../adaptery/domyslne'
import { WOO_MANIFEST, wooOrderFromApi, wooOrderZRabatem } from '../adaptery/woo'
import { WOO_ZAPIS_KEY } from '../adaptery/woo-zapis'
import { KOD_RABATU_NIEPEWNEGO, type PozycjaZamowienia } from '../dokumenty/pozycje'
import { cenaPoRabacieGr } from '../rdzen/ceny'
import { zlozFakture } from '../wfirma/faktura'
import { parseKonfiguracjaFaktur } from '../wfirma/konfiguracja'
import { type LiniaStanu, planPrzeliczenia, type StanZamowienia } from './rabat-woo'

const KONF = parseKonfiguracjaFaktur({ faktury: { kodyVat: { '23': 1 } } })

function kwota(bruttoGr: number): { total: string; total_tax: string } {
  const netto = Math.round(bruttoGr / 1.23)
  return { total: (netto / 100).toFixed(2), total_tax: ((bruttoGr - netto) / 100).toFixed(2) }
}

/** Zamówienie WC REST v3: pozycje (sztuki, wartość brutto w groszach), wysyłka, opłaty (ujemna = rabat, dodatnia = pobranie). */
function woo(linie: { qty: number; wartoscGr: number }[], o: { wysylkaGr?: number; oplatyGr?: number[]; pobranie?: boolean } = {}): Record<string, unknown> {
  const wys = o.wysylkaGr ?? 0
  const oplaty = o.oplatyGr ?? []
  const totalGr = linie.reduce((s, l) => s + l.wartoscGr, 0) + wys + oplaty.reduce((s, x) => s + x, 0)
  return {
    id: 7001,
    status: 'processing',
    currency: 'PLN',
    date_created_gmt: '2026-11-05T09:00:00',
    date_modified_gmt: '2026-11-05T09:05:00',
    ...(o.pobranie ? { payment_method: 'cod', payment_method_title: 'Za pobraniem' } : { date_paid_gmt: '2026-11-05T09:01:00', payment_method: 'blik', payment_method_title: 'Blik' }),
    total: (totalGr / 100).toFixed(2),
    shipping_total: kwota(wys).total,
    shipping_tax: kwota(wys).total_tax,
    line_items: linie.map((l, i) => ({ id: 100 + i, product_id: 10 + i, variation_id: 0, quantity: l.qty, ...kwota(l.wartoscGr), sku: `T${i}`, name: `Towar ${i}`, meta_data: [] })),
    fee_lines: oplaty.map((g, i) => ({ id: 500 + i, name: g < 0 ? 'Rabat' : 'Opłata', ...kwota(g) })),
    shipping_lines: [{ method_title: 'Kurier', ...kwota(wys) }],
  }
}

/** Stan zamówienia sprzed rozkładu rabatu: ceny pozycji sprzed rabatu (tak zapisywał adapter bez rozkładu), kwota ze sklepu. */
function stanSprzed(raw: Record<string, unknown>, o: { kosztWysylkiGr?: number | null; dodatkowe?: LiniaStanu[]; paczki?: StanZamowienia['paczki']; edytowane?: boolean; odrzucone?: Record<string, number> } = {}): StanZamowienia {
  const bez = wooOrderFromApi({ ...raw, fee_lines: [] }) // ceny bez rozkładu rabatu = zapis
  const z = wooOrderFromApi(raw)
  return {
    id: 'o1',
    totalGr: Math.round(z.totalGross * 100),
    kosztWysylkiGr: o.kosztWysylkiGr === undefined ? Math.round((z.shippingCostGross ?? 0) * 100) : o.kosztWysylkiGr,
    edytowaneLokalnie: o.edytowane ?? false,
    linie: [...bez.lines.map((l) => ({ id: `l${l.externalLineId}`, externalLineId: l.externalLineId, qty: l.qty, qtyChannel: l.qty, cenaGr: Math.round(l.unitPriceGross * 100), removed: false })), ...(o.dodatkowe ?? [])],
    paczki: o.paczki ?? [],
  }
}

/** Stan po zastosowaniu planu (to samo, co robi zapis w bazie). */
function zastosuj(stan: StanZamowienia, plan: ReturnType<typeof planPrzeliczenia>): StanZamowienia {
  const na = new Map(plan.zmiany.map((z) => [z.lineId, z.naGr]))
  const linie = (ls: LiniaStanu[]) => ls.map((l) => (na.has(l.id) ? { ...l, cenaGr: na.get(l.id)! } : l))
  return { ...stan, kosztWysylkiGr: plan.kosztWysylkiGr ?? stan.kosztWysylkiGr, linie: linie(stan.linie), paczki: stan.paczki.map((p) => ({ ...p, linie: linie(p.linie) })) }
}

const poz = (l: LiniaStanu, extra: Partial<PozycjaZamowienia> = {}): PozycjaZamowienia => ({
  sku: `S-${l.externalLineId}`,
  rodzaj: 'STOCKED',
  nazwa: 'Towar',
  jednostka: 'SZT',
  wfirmaGoodId: '1',
  qty: l.qty,
  qtyOdrzucone: 0,
  naOferte: 1,
  cenaBruttoGr: l.cenaGr,
  stawkaVat: '23',
  ...extra,
})

function faktura(stan: StanZamowienia, o: { cod?: boolean; pozycje?: PozycjaZamowienia[]; paczkiDodatkowe?: boolean; totalGross?: number; kosztWysylki?: number | null } = {}) {
  return zlozFakture({
    idExternal: 'z/1/0',
    totalGross: o.totalGross ?? stan.totalGr / 100,
    paymentMethod: o.cod ? 'Za pobraniem' : 'Blik',
    paymentState: o.cod ? 'COD' : 'PAID',
    pozycje: o.pozycje ?? stan.linie.map((l) => poz(l)),
    konfiguracja: KONF,
    kosztWysylki: o.kosztWysylki === undefined ? (stan.kosztWysylkiGr === null ? null : stan.kosztWysylkiGr / 100) : o.kosztWysylki,
    ...(o.paczkiDodatkowe ? { paczkiDodatkowe: true } : {}),
  })
}

/** Reguła BL wprost: wartość pozycji = sztuki × cena × po / przed do grosza, reszta na pierwszej pozycji. */
function regulaBl(linie: { qty: number; cenaGr: number }[], poGr: number): number[] {
  const przed = linie.reduce((s, l) => s + l.qty * l.cenaGr, 0)
  const w = linie.map((l) => l.qty * cenaPoRabacieGr(l.cenaGr, przed, poGr))
  w[0]! += poGr - w.reduce((s, x) => s + x, 0)
  return w
}
const wartosciTowarow = (f: ReturnType<typeof faktura>) => {
  const m = new Map<number, number>()
  for (const l of f.linie) if (!l.wysylka) m.set(l.pozycja, (m.get(l.pozycja) ?? 0) + l.bruttoGr)
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)
}
const wysylka = (f: ReturnType<typeof faktura>) => f.linie.filter((l) => l.wysylka).reduce((s, l) => s + l.bruttoGr, 0)

describe('przeliczenie cen pozycji Woo', () => {
  it('rabat 10%: ceny po rabacie z reguły adaptera, faktura = kwota zapłacona i podział jak BL, drugi przebieg bez zmian', () => {
    const raw = woo([{ qty: 1, wartoscGr: 3999 }, { qty: 2, wartoscGr: 5998 }, { qty: 1, wartoscGr: 1250 }], { wysylkaGr: 1299, oplatyGr: [-1125] })
    const stan = stanSprzed(raw)
    const plan = planPrzeliczenia(stan, wooOrderZRabatem(raw))
    expect(plan.powod).toBeNull()
    expect(plan.zmiany.map((z) => z.rodzaj)).toEqual(['kanal', 'kanal', 'kanal'])
    expect(plan.zmiany.map((z) => z.naGr)).toEqual(wooOrderFromApi(raw).lines.map((l) => Math.round(l.unitPriceGross * 100)))
    const po = zastosuj(stan, plan)
    const f = faktura(po)
    expect(f.problemy).toEqual([])
    expect(f.bruttoGr).toBe(stan.totalGr)
    expect(wartosciTowarow(f)).toEqual(regulaBl([{ qty: 1, cenaGr: 3999 }, { qty: 2, cenaGr: 2999 }, { qty: 1, cenaGr: 1250 }], 3999 + 5998 + 1250 - 1125))
    expect(wysylka(f)).toBe(1299)
    // ten sam dokument co dla zamówienia przyjętego już
    expect(f.linie).toEqual(faktura({ ...po, linie: po.linie }).linie)
    // przed przeliczeniem dokument też liczył dobrze (reguła dokumentu), więc wynik dla BL się nie zmienia
    expect(faktura(stan).linie).toEqual(f.linie)
    // suma różnic cen ≈ rabat (różnica = reszta groszy dokumentu)
    expect(Math.abs(plan.zmiany.reduce((s, z) => s + (z.zGr - z.naGr) * z.sztukOferty, 0) - 1125)).toBeLessThanOrEqual(2)
    const drugi = planPrzeliczenia(po, wooOrderZRabatem(raw))
    expect(drugi).toMatchObject({ zmiany: [], juzPrzeliczone: true, powod: null, kosztWysylkiGr: null })
  })

  it('rabat częściowy o nierównej kwocie: reszta groszy na pierwszej pozycji dokumentu, nie w cenie', () => {
    const raw = woo([{ qty: 3, wartoscGr: 3 * 1333 }, { qty: 1, wartoscGr: 2777 }, { qty: 2, wartoscGr: 2 * 499 }], { wysylkaGr: 1599, oplatyGr: [-487] })
    const stan = stanSprzed(raw)
    const plan = planPrzeliczenia(stan, wooOrderZRabatem(raw))
    const f = faktura(zastosuj(stan, plan))
    expect(f.problemy).toEqual([])
    expect(f.bruttoGr).toBe(stan.totalGr)
    expect(wartosciTowarow(f)).toEqual(regulaBl([{ qty: 3, cenaGr: 1333 }, { qty: 1, cenaGr: 2777 }, { qty: 2, cenaGr: 499 }], 3 * 1333 + 2777 + 2 * 499 - 487))
  })

  it('pobranie z opłatą większą niż rabat: dokument sprzed przeliczenia nie widział rabatu, po przeliczeniu 47,00 + 17,99', () => {
    const raw = woo([{ qty: 1, wartoscGr: 5000 }], { wysylkaGr: 1299, oplatyGr: [-300, 500], pobranie: true })
    const stan = stanSprzed(raw)
    expect(stan.totalGr).toBe(6499)
    // przed: faktura 50,00 + 14,99 bez żadnego problemu (rabat niewidoczny) — dlatego zakres nie może iść z dokumentu
    const przed = faktura(stan, { cod: true })
    expect(przed.problemy).toEqual([])
    expect(wartosciTowarow(przed)).toEqual([5000])
    const plan = planPrzeliczenia(stan, wooOrderZRabatem(raw))
    expect(plan.zmiany).toHaveLength(1)
    const f = faktura(zastosuj(stan, plan), { cod: true })
    expect(f.problemy).toEqual([])
    expect(wartosciTowarow(f)).toEqual([4700])
    expect(wysylka(f)).toBe(1799)
    expect(f.bruttoGr).toBe(6499)
  })

  it('pobranie z opłatą mniejszą niż rabat: przed przeliczeniem stop rabat-niepewny-podzial, po przeliczeniu faktura bez problemu', () => {
    const raw = woo([{ qty: 2, wartoscGr: 2 * 2500 }, { qty: 1, wartoscGr: 3000 }], { wysylkaGr: 1299, oplatyGr: [-600, 200], pobranie: true })
    const stan = stanSprzed(raw)
    expect(faktura(stan, { cod: true }).problemy.map((p) => p.kod)).toContain(KOD_RABATU_NIEPEWNEGO)
    const plan = planPrzeliczenia(stan, wooOrderZRabatem(raw))
    const f = faktura(zastosuj(stan, plan), { cod: true })
    expect(f.problemy).toEqual([])
    expect(f.bruttoGr).toBe(stan.totalGr)
    // Znane ograniczenie reguły dokumentu (to samo dla zamówienia przyjętego już): przy pobraniu dokument
    // nie zna opłaty za pobranie, więc reszty groszy z zaokrąglenia ceny za sztukę (tu −1 gr: 2 × 23,13 + 27,75 = 74,01
    // przy towarze po rabacie 74,00) nie kładzie na pierwszą pozycję, tylko zostawia w wysyłce. Suma faktury się zgadza,
    // podział różni się od BL o resztę groszy (najwyżej pół grosza na sztukę oferty).
    const bl = regulaBl([{ qty: 2, cenaGr: 2500 }, { qty: 1, cenaGr: 3000 }], 8000 - 600)
    expect(bl).toEqual([4625, 2775])
    expect(wartosciTowarow(f)).toEqual([4626, 2775])
    expect(wysylka(f)).toBe(1299 + 200 - 1)
    // dokładnie to samo co zamówienie przyjęte przez adapter
    const nowe = wooOrderFromApi(raw)
    expect(zastosuj(stan, plan).linie.map((l) => l.cenaGr)).toEqual(nowe.lines.map((l) => Math.round(l.unitPriceGross * 100)))
  })

  it('paczka dodatkowa: pozycja paczki tym samym mnożnikiem co matka; faktury matki i paczki = kwota zapłacona, bez stopu', () => {
    const raw = woo([{ qty: 2, wartoscGr: 2 * 3000 }, { qty: 1, wartoscGr: 2000 }], { wysylkaGr: 1299, oplatyGr: [-800] })
    const bez = stanSprzed(raw)
    const linia0 = bez.linie[0]!
    // 1 sztuka pozycji 0 przeniesiona do paczki 2 (podział): matka ma 1 odrzuconą, paczka pozycję `<id>#paczka` po cenie matki
    const paczka: LiniaStanu = { id: 'c1', externalLineId: `${linia0.externalLineId}#paczka`, qty: 1, qtyChannel: 1, cenaGr: linia0.cenaGr, removed: false }
    const stan: StanZamowienia = { ...bez, paczki: [{ id: 'o2', linie: [paczka], maWlasnePaczki: false }] }
    const pozMatki = (s: StanZamowienia) => s.linie.map((l, i) => poz(l, i === 0 ? { qtyOdrzucone: 1 } : {}))
    expect(faktura(stan, { pozycje: pozMatki(stan), paczkiDodatkowe: true }).problemy.map((p) => p.kod)).toContain(KOD_RABATU_NIEPEWNEGO)
    const plan = planPrzeliczenia(stan, wooOrderZRabatem(raw))
    expect(plan.zmiany.map((z) => [z.orderId, z.rodzaj])).toEqual([['o1', 'kanal'], ['o1', 'kanal'], ['o2', 'paczka']])
    const po = zastosuj(stan, plan)
    expect(po.paczki[0]!.linie[0]!.cenaGr).toBe(po.linie[0]!.cenaGr)
    const fm = faktura(po, { pozycje: pozMatki(po), paczkiDodatkowe: true })
    expect(fm.problemy).toEqual([])
    const pp = po.paczki[0]!.linie[0]!
    const fp = faktura(po, { pozycje: [poz(pp)], totalGross: pp.cenaGr / 100, kosztWysylki: null })
    expect(fp.problemy).toEqual([])
    expect(fm.bruttoGr + fp.bruttoGr).toBe(stan.totalGr)
  })

  it('brak kosztu wysyłki w zamówieniu: plan go uzupełnia ze sklepu i przelicza ceny; faktura bez pozycje-drozsze-niz-zamowienie', () => {
    const raw = woo([{ qty: 1, wartoscGr: 8000 }, { qty: 1, wartoscGr: 2000 }], { wysylkaGr: 1499, oplatyGr: [-2000] })
    const stan = stanSprzed(raw, { kosztWysylkiGr: null })
    expect(faktura(stan).problemy.map((p) => p.kod)).toContain('pozycje-drozsze-niz-zamowienie')
    // rabat mniejszy niż wysyłka bez kosztu wysyłki: dokument nie staje, tylko po cichu obniża wysyłkę (dlatego koszt
    // trzeba uzupełnić także tam, gdzie podgląd faktur nie pokazuje różnicy)
    const cichy = woo([{ qty: 1, wartoscGr: 8000 }, { qty: 1, wartoscGr: 2000 }], { wysylkaGr: 1499, oplatyGr: [-1000] })
    const sc = stanSprzed(cichy, { kosztWysylkiGr: null })
    expect(faktura(sc).problemy).toEqual([])
    expect(wysylka(faktura(sc))).toBe(499)
    expect(wysylka(faktura(zastosuj(sc, planPrzeliczenia(sc, wooOrderZRabatem(cichy)))))).toBe(1499)
    const plan = planPrzeliczenia(stan, wooOrderZRabatem(raw))
    expect(plan.kosztWysylkiGr).toBe(1499)
    const f = faktura(zastosuj(stan, plan))
    expect(f.problemy).toEqual([])
    expect(f.bruttoGr).toBe(stan.totalGr)
    expect(wysylka(f)).toBe(1499)
  })

  it('zamówienie bez rabatu: ceny bez zmian; brakujący koszt wysyłki i tak uzupełniony', () => {
    const raw = woo([{ qty: 1, wartoscGr: 4500 }], { wysylkaGr: 999 })
    const stan = stanSprzed(raw, { kosztWysylkiGr: null })
    const plan = planPrzeliczenia(stan, wooOrderZRabatem(raw))
    expect(plan).toMatchObject({ zmiany: [], powod: 'bez-rabatu', kosztWysylkiGr: 999, rabatGr: 0 })
    expect(planPrzeliczenia(stanSprzed(raw), wooOrderZRabatem(raw))).toMatchObject({ zmiany: [], powod: 'bez-rabatu', kosztWysylkiGr: null })
  })

  it('zamiennik („Zamień produkt”): dostaje cenę po rabacie pozycji pierwotnej, faktura bez błędu zamiany', () => {
    const raw = woo([{ qty: 2, wartoscGr: 2 * 2000 }, { qty: 1, wartoscGr: 3000 }], { wysylkaGr: 1299, oplatyGr: [-700] })
    const bez = stanSprzed(raw)
    const p0 = bez.linie[0]!
    const zam: LiniaStanu = { id: 'z1', externalLineId: `${p0.externalLineId}#zamiana-1`, qty: 1, qtyChannel: null, cenaGr: p0.cenaGr, removed: false }
    const stan = { ...bez, linie: [...bez.linie, zam] }
    const plan = planPrzeliczenia(stan, wooOrderZRabatem(raw))
    expect(plan.zmiany.map((z) => z.rodzaj)).toEqual(['kanal', 'kanal', 'zamiennik'])
    const po = zastosuj(stan, plan)
    expect(po.linie[2]!.cenaGr).toBe(po.linie[0]!.cenaGr)
    const pozycje = po.linie.map((l, i) => poz(l, i === 0 ? { qtyOdrzucone: 1, pokryte: 2 } : i === 2 ? { zamiennik: null, sku: 'ZAM', przesuniecie: 1 } : {}))
    const f = faktura(po, { pozycje })
    expect(f.problemy).toEqual([])
    expect(f.bruttoGr).toBe(stan.totalGr)
    // zamiennik z inną ceną niż pozycja pierwotna: bez zgadywania
    const inna = { ...bez, linie: [...bez.linie, { ...zam, cenaGr: p0.cenaGr + 1 }] }
    expect(planPrzeliczenia(inna, wooOrderZRabatem(raw))).toMatchObject({ zmiany: [], powod: 'zamiennik-z-inna-cena' })
  })

  it('bezpieczniki: edycja w Kompletorze, inna kwota, inne pozycje, cena ani przed, ani po, rabat ponad limit', () => {
    const raw = woo([{ qty: 1, wartoscGr: 5000 }, { qty: 1, wartoscGr: 3000 }], { wysylkaGr: 1299, oplatyGr: [-500] })
    const d = wooOrderZRabatem(raw)
    expect(planPrzeliczenia(stanSprzed(raw, { edytowane: true }), d).powod).toBe('edytowane-w-kompletorze')
    expect(planPrzeliczenia({ ...stanSprzed(raw), totalGr: 1 }, d).powod).toBe('kwota-inna-niz-w-sklepie')
    const s = stanSprzed(raw)
    expect(planPrzeliczenia({ ...s, linie: s.linie.slice(1) }, d).powod).toBe('pozycje-inne-niz-w-sklepie')
    expect(planPrzeliczenia({ ...s, linie: [{ ...s.linie[0]!, qtyChannel: 3 }, s.linie[1]!] }, d).powod).toBe('pozycje-inne-niz-w-sklepie')
    expect(planPrzeliczenia({ ...s, linie: [{ ...s.linie[0]!, cenaGr: 4321 }, s.linie[1]!] }, d)).toMatchObject({ zmiany: [], powod: 'cena-inna-niz-w-sklepie' })
    const duzy = woo([{ qty: 1, wartoscGr: 5000 }], { wysylkaGr: 1299, oplatyGr: [-3000] })
    const p = planPrzeliczenia(stanSprzed(duzy), wooOrderZRabatem(duzy))
    expect(p).toMatchObject({ zmiany: [], powod: 'rabat-nierozlozony' })
    expect(p.ostrzezenie).toMatch(/opłata ujemna/)
    // paczka dodatkowa paczki: poza zakresem reguły
    expect(planPrzeliczenia({ ...s, paczki: [{ id: 'o2', linie: [], maWlasnePaczki: true }] }, d).powod).toBe('paczki-zagniezdzone')
  })

  it('adapter: odczyt z rabatem to jeden GET /orders/{id} (także adapter z zapisem), 404 = null, zły numer = błąd bez żądania', async () => {
    const raw = woo([{ qty: 1, wartoscGr: 5000 }], { wysylkaGr: 1299, oplatyGr: [-500] })
    for (const key of [WOO_MANIFEST.adapterKey, WOO_ZAPIS_KEY]) {
      const log: string[] = []
      const fetch = async (url: string, init?: { method?: string }) => {
        log.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`)
        const found = new URL(url).pathname.endsWith('/orders/7001')
        return new Response(JSON.stringify(found ? raw : { code: 'woocommerce_rest_shop_order_invalid_id' }), { status: found ? 200 : 404, headers: { 'content-type': 'application/json' } })
      }
      const a = defaultRegistry().create(key, {
        integration: { organizationId: 'test_a', kind: 'channel', id: 'WOO/test', channel: 'WOO', channelAccountId: 'test', name: 'Sklep testowy' },
        rawConfig: { baseUrl: 'https://sklep.example' },
        rawSecrets: { WOO_CONSUMER_KEY: 'ck_test', WOO_CONSUMER_SECRET: 'cs_test', WOO_WRITE_KEY: 'ck_zapis', WOO_WRITE_SECRET: 'cs_zapis' },
        fetch: fetch as never,
        now: () => new Date('2026-11-11T10:00:00Z'),
        http: { retry: { attempts: 1, baseDelayMs: 0 }, minIntervalMs: 0 },
      }) as unknown as { getOrderZRabatem(id: string): Promise<ReturnType<typeof wooOrderZRabatem> | null> }
      const d = await a.getOrderZRabatem('7001')
      expect(d).toEqual(wooOrderZRabatem(raw))
      expect(d!.rabatGr).toBe(500)
      expect(await a.getOrderZRabatem('7002')).toBeNull()
      await expect(a.getOrderZRabatem('7001/../x')).rejects.toThrow(/zły numer/)
      expect(log.every((l) => l.startsWith('GET '))).toBe(true)
      expect(log).toHaveLength(2)
    }
  })

  it('20 000 losowych zamówień: po przeliczeniu faktura = kwota, podział = zamówienie przyjęte, zero stopów rabatu', () => {
    let seed = 240
    const los = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    let przeliczone = 0
    for (let k = 0; k < 20_000; k++) {
      const n = 1 + los(5)
      const linie = Array.from({ length: n }, () => {
        const qty = 1 + los(4)
        return { qty, wartoscGr: qty * (100 + los(9900)) }
      })
      const wartosc = linie.reduce((s, l) => s + l.wartoscGr, 0)
      const rabat = Math.round((wartosc * (1 + los(15))) / 100)
      const cod = los(3) === 0
      const raw = woo(linie, { wysylkaGr: los(2) ? 1299 : 0, oplatyGr: cod ? [-rabat, 100 + los(900)] : [-rabat], pobranie: cod })
      const stan = stanSprzed(raw, { kosztWysylkiGr: los(4) === 0 ? null : undefined })
      const plan = planPrzeliczenia(stan, wooOrderZRabatem(raw))
      if (plan.powod) continue
      przeliczone++
      const po = zastosuj(stan, plan)
      const f = faktura(po, { cod })
      expect(f.problemy).toEqual([])
      expect(f.bruttoGr).toBe(stan.totalGr)
      // zamówienie przyjęte już: te same ceny w zamówieniu, ten sam dokument
      const nowe = wooOrderFromApi(raw)
      expect(po.linie.map((l) => l.cenaGr)).toEqual(nowe.lines.map((l) => Math.round(l.unitPriceGross * 100)))
      expect(planPrzeliczenia(po, wooOrderZRabatem(raw)).zmiany).toEqual([])
    }
    expect(przeliczone).toBeGreaterThan(15_000)
  })
})

describe('runda 2 przeglądu: koszt wysyłki tylko dla zgodnych, przelicznik oferty, #dosle, stan mieszany', () => {
  it('zamówienie bez rabatu, bez kosztu, kwota w bazie inna niż w sklepie (zmieniona dostawa): koszt NIE wpisany, powód podany', () => {
    // baza: pozycja 50,00 + wysyłka 12,99 = 62,99; sklep po przyjęciu: dostawa 19,99, kwota 69,99 (rewizja nieprzyjęta)
    const wBazie = woo([{ qty: 1, wartoscGr: 5000 }], { wysylkaGr: 1299 })
    const wSklepie = woo([{ qty: 1, wartoscGr: 5000 }], { wysylkaGr: 1999 })
    const stan = stanSprzed(wBazie, { kosztWysylkiGr: null })
    const plan = planPrzeliczenia(stan, wooOrderZRabatem(wSklepie))
    expect(plan).toMatchObject({ powod: 'bez-rabatu', kosztWysylkiGr: null, kosztWysylkiNieuzupelniony: 'kwota-inna-niz-w-sklepie', zmiany: [] })
    // faktura zostaje taka, jak przed przebiegiem: 50,00 + 12,99 (bez ukrytego „rabatu” 43,00 + 19,99)
    const f = faktura(zastosuj(stan, plan))
    expect(wartosciTowarow(f)).toEqual([5000])
    expect(wysylka(f)).toBe(1299)
    // ten sam przypadek z ujemną opłatą w sklepie: też bez kosztu
    const zRabatem = woo([{ qty: 1, wartoscGr: 5000 }], { wysylkaGr: 1999, oplatyGr: [-300] })
    expect(planPrzeliczenia(stan, wooOrderZRabatem(zRabatem))).toMatchObject({ powod: 'kwota-inna-niz-w-sklepie', kosztWysylkiGr: null, kosztWysylkiNieuzupelniony: 'kwota-inna-niz-w-sklepie' })
  })

  it('zamówienie edytowane w Kompletorze bez kosztu wysyłki: koszt NIE wpisany (z rabatem i bez)', () => {
    const bez = woo([{ qty: 1, wartoscGr: 4500 }], { wysylkaGr: 999 })
    expect(planPrzeliczenia(stanSprzed(bez, { kosztWysylkiGr: null, edytowane: true }), wooOrderZRabatem(bez))).toMatchObject({ powod: 'bez-rabatu', kosztWysylkiGr: null, kosztWysylkiNieuzupelniony: 'edytowane-w-kompletorze' })
    const z = woo([{ qty: 1, wartoscGr: 4500 }], { wysylkaGr: 999, oplatyGr: [-450] })
    expect(planPrzeliczenia(stanSprzed(z, { kosztWysylkiGr: null, edytowane: true }), wooOrderZRabatem(z))).toMatchObject({ powod: 'edytowane-w-kompletorze', kosztWysylkiGr: null, kosztWysylkiNieuzupelniony: 'edytowane-w-kompletorze' })
    // bez rabatu, cena pozycji inna niż w sklepie: też bez kosztu
    const s = stanSprzed(bez, { kosztWysylkiGr: null })
    expect(planPrzeliczenia({ ...s, linie: [{ ...s.linie[0]!, cenaGr: 4400 }], totalGr: s.totalGr }, wooOrderZRabatem(bez))).toMatchObject({ powod: 'bez-rabatu', kosztWysylkiGr: null, kosztWysylkiNieuzupelniony: 'cena-inna-niz-w-sklepie' })
  })

  it('rabat w granicach reszty zaokrągleń: osobny powód (bez listy ręcznej), ceny bez zmian, brakujący koszt uzupełniony', () => {
    const raw = woo([{ qty: 3, wartoscGr: 3 * 1000 }], { wysylkaGr: 1299, oplatyGr: [-1] })
    expect(wooOrderZRabatem(raw).rozklad).toBe('zaokraglenia')
    const plan = planPrzeliczenia(stanSprzed(raw, { kosztWysylkiGr: null }), wooOrderZRabatem(raw))
    expect(plan).toMatchObject({ powod: 'rabat-w-zaokragleniach', zmiany: [], kosztWysylkiGr: 1299 })
    expect(plan.ostrzezenie).toMatch(/zaokrągleń/)
    // ponad limit: dalej rabat-nierozlozony (lista ręczna)
    const duzy = woo([{ qty: 1, wartoscGr: 5000 }], { wysylkaGr: 1299, oplatyGr: [-3000] })
    expect(wooOrderZRabatem(duzy).rozklad).toBe('odmowa')
    expect(planPrzeliczenia(stanSprzed(duzy), wooOrderZRabatem(duzy)).powod).toBe('rabat-nierozlozony')
  })

  it('przelicznik oferty > 1: porównanie i suma po sztukach oferty (qtyChannel), nie po jednostkach bazowych', () => {
    const raw = woo([{ qty: 2, wartoscGr: 2 * 3000 }, { qty: 1, wartoscGr: 2000 }], { wysylkaGr: 1299, oplatyGr: [-800] })
    const s = stanSprzed(raw)
    // pozycja 0 to oferta „6 sztuk”: w bazie 12 jednostek bazowych, 2 sztuki oferty
    const stan: StanZamowienia = { ...s, linie: [{ ...s.linie[0]!, qty: 12, qtyChannel: 2 }, s.linie[1]!] }
    const plan = planPrzeliczenia(stan, wooOrderZRabatem(raw))
    const zwykly = planPrzeliczenia(s, wooOrderZRabatem(raw))
    expect(plan.powod).toBeNull()
    expect(plan.zmiany).toEqual(zwykly.zmiany)
    expect(plan.zmiany[0]!.sztukOferty).toBe(2)
    expect(plan.towaryPrzedGr).toBe(2 * 3000 + 2000)
    expect(plan.towaryPrzedGr - plan.towaryPoGr).toBe(plan.zmiany.reduce((x, z) => x + (z.zGr - z.naGr) * z.sztukOferty, 0))
    // bez qtyChannel ilość bazowa ≠ sztuki oferty = niezgodność, bez zgadywania
    expect(planPrzeliczenia({ ...s, linie: [{ ...s.linie[0]!, qty: 12, qtyChannel: null }, s.linie[1]!] }, wooOrderZRabatem(raw)).powod).toBe('pozycje-inne-niz-w-sklepie')
  })

  it('paczka dodatkowa „dośle później” (#dosle): pozycja po cenie matki dostaje ten sam mnożnik; inna cena = stop', () => {
    const raw = woo([{ qty: 2, wartoscGr: 2 * 2500 }], { wysylkaGr: 1299, oplatyGr: [-500] })
    const s = stanSprzed(raw)
    const l0 = s.linie[0]!
    const dosle: LiniaStanu = { id: 'd1', externalLineId: `${l0.externalLineId}#dosle`, qty: 1, qtyChannel: 1, cenaGr: l0.cenaGr, removed: false }
    const stan: StanZamowienia = { ...s, paczki: [{ id: 'o3', linie: [dosle], maWlasnePaczki: false }] }
    const plan = planPrzeliczenia(stan, wooOrderZRabatem(raw))
    expect(plan.zmiany.map((z) => [z.orderId, z.rodzaj, z.naGr])).toEqual([['o1', 'kanal', 2250], ['o3', 'paczka', 2250]])
    expect(planPrzeliczenia(zastosuj(stan, plan), wooOrderZRabatem(raw))).toMatchObject({ zmiany: [], juzPrzeliczone: true })
    const inna = { ...stan, paczki: [{ id: 'o3', linie: [{ ...dosle, cenaGr: 1999 }], maWlasnePaczki: false }] }
    expect(planPrzeliczenia(inna, wooOrderZRabatem(raw))).toMatchObject({ zmiany: [], powod: 'paczka-z-inna-cena', kosztWysylkiGr: null })
  })

  it('stan mieszany: część pozycji sprzed, część już po rabacie = pominięcie z powodem, bez zapisu kosztu', () => {
    const raw = woo([{ qty: 1, wartoscGr: 4000 }, { qty: 1, wartoscGr: 6000 }], { wysylkaGr: 1299, oplatyGr: [-1000] })
    const s = stanSprzed(raw, { kosztWysylkiGr: null })
    const po = wooOrderFromApi(raw).lines.map((l) => Math.round(l.unitPriceGross * 100))
    const mieszany = { ...s, linie: [{ ...s.linie[0]!, cenaGr: po[0]! }, s.linie[1]!] }
    expect(planPrzeliczenia(mieszany, wooOrderZRabatem(raw))).toMatchObject({ zmiany: [], powod: 'cena-inna-niz-w-sklepie', kosztWysylkiGr: null, kosztWysylkiNieuzupelniony: 'cena-inna-niz-w-sklepie' })
  })
})
