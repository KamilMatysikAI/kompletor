// statusy BL → statusy firmy (kolor, nazwa dla klienta, grupa, etap, „do potwierdzenia”), idempotentne
// klucze, ukrycie nietkniętych domyślnych, najbliższy szablon i jego reguły na statusach po imporcie. Bez bazy.
import { describe, expect, it } from 'vitest'
import { DOMYSLNE_GRUPY_STATUSOW, DOMYSLNE_STATUSY, type StatusFirmyT } from '@/lib/panel/statusy'
import { mapaStatusow, parseMapa, type BlStatus } from './statusy'
import { bladZestawu, dobierzSzablon, kolorZHex, planAutomatow, planStatusowFirmy, statusyPoPlanie, uzupelnienieEtapow, znacznikAutomatowBl } from './statusy-firmy'

// kształt z dokumentacji getOrderStatusList / getOrderStatusGroups (po parserze rozpoznania)
const BL: BlStatus[] = [
  { id: '1051', name: 'Nowe zamówienia', group: null, groupId: null, color: '#0000FF', customerName: 'Zamówienie przyjęte' },
  { id: '1052', name: 'Do wysłania', group: 'W realizacji', groupId: '2', color: '#1C8752', customerName: 'Paczka czeka na kuriera' },
  { id: '1053', name: 'Wysłane', group: 'Zakończone', groupId: '3', color: '#808080', customerName: 'Paczka wysłana' },
  { id: '1054', name: 'Anulowane', group: 'Zakończone', groupId: '3', color: '#FF0000', customerName: null },
  { id: '1055', name: 'Status Xyz', group: 'W realizacji', groupId: '2', color: '#ff9900', customerName: null },
]
const domyslne = () => ({ statusy: DOMYSLNE_STATUSY.map((s) => ({ ...s, carriers: [...s.carriers] })), grupy: [...DOMYSLNE_GRUPY_STATUSOW] })

describe('kolor z BL', () => {
  it('odcień hex → paleta firmy', () => {
    expect(kolorZHex('#0000FF')).toBe('niebieski')
    expect(kolorZHex('#1C8752')).toBe('zielony')
    expect(kolorZHex('#808080')).toBe('szary')
    expect(kolorZHex('#FF0000')).toBe('czerwony')
    expect(kolorZHex('#ff9900')).toBe('pomaranczowy')
    expect(kolorZHex('#7a4a1e')).toBe('brazowy')
    expect(kolorZHex('#8e44ad')).toBe('fioletowy')
    expect(kolorZHex('#e91e8c')).toBe('rozowy')
    expect(kolorZHex('#17a2b8')).toBe('turkusowy')
    expect(kolorZHex('#f1c40f')).toBe('zolty')
    expect(kolorZHex('zły')).toBe('szary')
    expect(kolorZHex(null)).toBe('szary')
  })
})

describe('plan statusów firmy z BL', () => {
  it('nazwa, kolor, nazwa dla klienta, grupa, etap; niepewne = do potwierdzenia; domyślne etapów z BL ukryte', () => {
    const p = planStatusowFirmy(mapaStatusow(BL), domyslne())
    expect(p.statusy.map((s) => [s.klucz, s.nazwa, s.kolor, s.etap, s.doPotwierdzenia])).toEqual([
      ['BL_1051', 'Nowe zamówienia', 'niebieski', 'NOWE', false],
      ['BL_1052', 'Do wysłania', 'zielony', 'DO_WYSLANIA', false],
      ['BL_1053', 'Wysłane', 'szary', 'WYSLANE', false],
      ['BL_1054', 'Anulowane', 'czerwony', 'ANULOWANE', false],
      ['BL_1055', 'Status Xyz', 'pomaranczowy', 'ZBIERANIE', true], // podpowiedź z grupy BL: do potwierdzenia
    ])
    expect(p.statusy[1]!.nazwaDlaKlienta).toBe('Paczka czeka na kuriera')
    expect(p.grupy.map((g) => [g.key, g.name])).toEqual([
      ['BL_G2', 'W realizacji'],
      ['BL_G3', 'Zakończone'],
    ])
    expect(p.statusy[0]!.grupa).toBeNull()
    expect(p.ukryteDomyslne.sort()).toEqual(['ANULOWANE', 'DO_WYSLANIA', 'NOWE', 'WYSLANE', 'ZBIERANIE'])
    expect(p.mapa).toEqual({ '1051': 'BL_1051', '1052': 'BL_1052', '1053': 'BL_1053', '1054': 'BL_1054', '1055': 'BL_1055' })
    const po = statusyPoPlanie(p, domyslne())
    expect(bladZestawu(po.statusy, po.grupy)).toBeNull()
    // decyzja człowieka zdejmuje „do potwierdzenia”
    const p2 = planStatusowFirmy(mapaStatusow(BL, parseMapa({ statusy: { '1055': 'DO_REALIZACJI' } })), domyslne())
    expect(p2.statusy[4]).toMatchObject({ etap: 'DO_REALIZACJI', doPotwierdzenia: false })
  })

  it('drugi przebieg: statusy już są, nic nowego; firma z własnymi statusami nic nie traci', () => {
    const ist = statusyPoPlanie(planStatusowFirmy(mapaStatusow(BL), domyslne()), domyslne())
    const p = planStatusowFirmy(mapaStatusow(BL), ist)
    expect(p.statusy.every((s) => s.juzJest)).toBe(true)
    expect(p.grupy).toEqual([])
    expect(p.ukryteDomyslne).toEqual([]) // statusy już nie są nietknięte
    const wlasne: StatusFirmyT[] = [...DOMYSLNE_STATUSY.map((s) => ({ ...s, carriers: [...s.carriers], name: s.key === 'NOWE' ? 'Czeka' : s.name }))]
    const p3 = planStatusowFirmy(mapaStatusow(BL), { statusy: wlasne, grupy: [...DOMYSLNE_GRUPY_STATUSOW] })
    expect(p3.ukryteDomyslne).toEqual([])
    expect(Math.min(...p3.statusy.map((s) => s.sortOrder))).toBeGreaterThan(Math.max(...wlasne.map((s) => s.sortOrder)))
  })

  it('firma bez żadnych statusów: etapy bez statusu z BL dostają domyślne (zestaw przechodzi walidację)', () => {
    const p = planStatusowFirmy(mapaStatusow(BL), { statusy: [], grupy: [] })
    const uz = uzupelnienieEtapow(p, [])
    const po = statusyPoPlanie(p, { statusy: [], grupy: [] })
    expect(bladZestawu([...po.statusy, ...uz], po.grupy)).toBeNull()
    expect(uz.map((s) => s.key)).toContain('ZEBRANE')
  })
})

describe('automaty z BL: najbliższy szablon', () => {
  it('dobór szablonu po etapach i źródłach', () => {
    expect(dobierzSzablon(new Set(['NOWE', 'DO_WYSLANIA', 'WYSLANE']), [{ typ: 'shop' }]).szablon.id).toBe('kurier-i-paczkomaty')
    expect(dobierzSzablon(new Set(['NOWE', 'DO_WYSLANIA']), [{ typ: 'allegro' }, { typ: 'personal' }]).szablon.id).toBe('allegro-wysylam-z-allegro')
    expect(dobierzSzablon(new Set(['NOWE', 'DO_ODBIORU', 'ODEBRANE']), [{ typ: 'shop' }]).szablon.id).toBe('odbior-osobisty')
    expect(dobierzSzablon(new Set(['NOWE', 'DO_REALIZACJI', 'ODEBRANE']), [{ typ: 'shop' }]).szablon.id).toBe('bez-wysylki')
  })

  it('reguły szablonu na statusach po imporcie, wyłączone; znacznik poprzedniego zapisu = nic nie dokłada', () => {
    const p = planStatusowFirmy(mapaStatusow(BL), domyslne())
    const po = statusyPoPlanie(p, domyslne())
    const a = planAutomatow(po.statusy, new Set(p.statusy.map((s) => s.etap)), [{ typ: 'shop' }], false)
    expect(a.szablon?.id).toBe('kurier-i-paczkomaty')
    expect(a.reguly.length).toBe(a.przeniesione.length)
    expect(a.reguly.every((r) => !r.enabled)).toBe(true)
    // „Do wysłania” z BL zamiast domyślnego (ukrytego) w kroku reguły
    const doWyslania = a.reguly.find((r) => r.key === 'przesylka-do-wyslania')!
    expect(doWyslania.actions[0]).toEqual({ typ: 'ustawStatus', status: 'BL_1052' })
    expect(planAutomatow(po.statusy, new Set(['DO_WYSLANIA']), [], true).juzJest).toBe(true)
  })

  it('znacznik automatów z ustawień firmy: kształt sprawdzany, nazwa grupy bez znaczenia', () => {
    const z = { szablon: 'kurier-i-paczkomaty', grupaId: 'g1', reguly: 5, kiedy: '2026-11-09T10:00:00.000Z' }
    expect(znacznikAutomatowBl({ baselinker: { przeprowadzka: { automaty: z } } })).toEqual(z)
    expect(znacznikAutomatowBl({ baselinker: { przeprowadzka: { automaty: { szablon: 'x', kiedy: 'k' } } } })).toEqual({ szablon: 'x', grupaId: null, reguly: 0, kiedy: 'k' })
    expect(znacznikAutomatowBl({ baselinker: { przeprowadzka: { pierwszyZapis: 'k' } } })).toBeNull()
    expect(znacznikAutomatowBl({ baselinker: { przeprowadzka: { automaty: 'tak' } } })).toBeNull()
    expect(znacznikAutomatowBl(null)).toBeNull()
  })
})
