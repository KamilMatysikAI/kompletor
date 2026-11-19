// statusy firmy nad enumem rdzenia — wybór statusu firmy dla zamówienia, warunek zapytania zgodny
// z wyborem, liczniki, walidacja zestawu, presety (ACME 22 statusy BL w 7 sekcjach, neutralny bez nazw ACME) i zapis
// statusu do kanału z nadpisaniem statusu firmy. Czyste funkcje, bez bazy.
import { describe, expect, it } from 'vitest'
import type { Carrier, OrderStatus, Prisma } from '@prisma/client'
import { presetStatusy, validatePreset } from '@/lib/organizacje'
import { nazwaKluczaZapisu, zapisStatusu } from '@/lib/kanaly/zapis-host'
import { ETAPY_DO_SKLEPU, STATUS_MAP_KEYS } from '@/lib/adaptery/kontrakt'
import { ACME_PRESET } from '@/tests/preset-testowy'
import {
  DOMYSLNE_STATUSY,
  etykietaStatusuFirmy,
  KOLORY_STATUSOW,
  kluczRdzenia,
  parseMapaStatusowFirmy,
  PRZEWOZNICY_WSZYSCY,
  STATUSY_RDZENIA,
  validateZestawStatusow,
  warunekStatusuFirmy,
  wybierzStatusFirmy,
  type StatusFirmyT,
} from './statusy'
import { zlozLicznikiStatusow } from './statusy-firmy-dane'

const acme = presetStatusy(ACME_PRESET)

/** Minimalna ewaluacja warunku Prisma na jednym zamówieniu (tylko konstrukcje, których używa warunekStatusuFirmy). */
function pasuje(w: Prisma.OrderWhereInput, o: { id?: string; status: OrderStatus; carrier: Carrier | null; companyStatus: string | null }): boolean {
  for (const [k, v] of Object.entries(w)) {
    if (k === 'OR') {
      if (!(v as Prisma.OrderWhereInput[]).some((x) => pasuje(x, o))) return false
    } else if (k === 'AND') {
      if (!(v as Prisma.OrderWhereInput[]).every((x) => pasuje(x, o))) return false
    } else if (k === 'id') {
      if (v !== (o.id ?? 'x')) return false
    } else {
      const val = (o as Record<string, unknown>)[k]
      if (v === null) {
        if (val !== null) return false
      } else if (typeof v === 'object') {
        const f = v as { in?: unknown[]; notIn?: unknown[] }
        if (f.in && !f.in.includes(val)) return false
        if (f.notIn && (val === null || f.notIn.includes(val))) return false
      } else if (val !== v) return false
    }
  }
  return true
}

const kombinacje = () => {
  const out: { status: OrderStatus; carrier: Carrier | null; companyStatus: string | null }[] = []
  for (const status of STATUSY_RDZENIA) for (const carrier of [...PRZEWOZNICY_WSZYSCY, null]) for (const companyStatus of [null, 'DO_REALIZACJI_DPD', 'ZEBRANE_ALLEGRO', 'NIEMA']) out.push({ status, carrier, companyStatus })
  return out
}

describe('statusy firmy: wybór dla zamówienia', () => {
  it('ACME: przewoźnik wybiera status etapu jak w BL; e-book osobno; brak przewoźnika = jak „bez przewoźnika”', () => {
    const k = (status: OrderStatus, carrier: Carrier | null) => wybierzStatusFirmy(acme.statusy, { status, carrier })?.name ?? null
    expect(k('DO_REALIZACJI', 'DPD')).toBe('Do realizacji DPD')
    expect(k('DO_REALIZACJI', 'DPD_EMPIK')).toBe('Do realizacji DPD')
    expect(k('DO_REALIZACJI', 'PACZKOMATY')).toBe('Do realizacji Paczkomaty')
    expect(k('DO_REALIZACJI', 'BEZ_WYSYLKI')).toBe('E-book')
    expect(k('ZEBRANE', 'ALLEGRO')).toBe('Zebrane Allegro')
    expect(k('SPAKOWANE', 'OSOBISTY')).toBe('Spakowane Osobisty')
    expect(k('ZBIERANIE', 'DPD')).toBe('Rozpoczęto zbieranie')
    expect(k('NOWE', null)).toBe('Nowe zamówienia')
    expect(k('WYSLANE', 'DPD')).toBe('Wysłane')
    // etap tylko ze statusami przewoźników i przewoźnik spoza nich: nazwa rdzenia
    expect(k('ZEBRANE', null)).toBeNull()
    expect(etykietaStatusuFirmy(acme.statusy, { status: 'ZEBRANE', carrier: 'BEZ_WYSYLKI' })).toMatchObject({ klucz: null, nazwa: 'Zebrane', bazowy: 'Zebrane' })
  })

  it('przypisanie wprost wygrywa tylko przy tym samym statusie bazowym; ukryty status nie przypisuje się sam', () => {
    expect(wybierzStatusFirmy(acme.statusy, { status: 'DO_REALIZACJI', carrier: 'DPD', companyStatus: 'DO_REALIZACJI_ALLEGRO' })?.key).toBe('DO_REALIZACJI_ALLEGRO')
    // rdzeń przeniósł zamówienie dalej: przypisanie nieaktualne, status liczy się z enumu
    expect(wybierzStatusFirmy(acme.statusy, { status: 'ZEBRANE', carrier: 'DPD', companyStatus: 'DO_REALIZACJI_ALLEGRO' })?.key).toBe('ZEBRANE_DPD')
    const ukryte = acme.statusy.map((s) => (s.key === 'ZEBRANE_DPD' ? { ...s, active: false } : s))
    expect(wybierzStatusFirmy(ukryte, { status: 'ZEBRANE', carrier: 'DPD' })).toBeNull()
    expect(wybierzStatusFirmy(ukryte, { status: 'ZEBRANE', carrier: 'DPD', companyStatus: 'ZEBRANE_DPD' })?.key).toBe('ZEBRANE_DPD')
  })

  it('kolejność: pierwszy status z przewoźnikiem przed ogólnym, niezależnie od sortOrder ogólnego', () => {
    const defs: StatusFirmyT[] = [
      { key: 'OGOLNE', name: 'Do realizacji', color: 'szary', sortOrder: 10, baseStatus: 'DO_REALIZACJI', carriers: [], active: true },
      { key: 'DPD', name: 'Do realizacji DPD', color: 'szary', sortOrder: 20, baseStatus: 'DO_REALIZACJI', carriers: ['DPD'], active: true },
    ]
    expect(wybierzStatusFirmy(defs, { status: 'DO_REALIZACJI', carrier: 'DPD' })?.key).toBe('DPD')
    expect(wybierzStatusFirmy(defs, { status: 'DO_REALIZACJI', carrier: 'ALLEGRO' })?.key).toBe('OGOLNE')
  })

  it('warunek zapytania daje dokładnie te zamówienia, które wybór przypisuje do statusu (wszystkie kombinacje)', () => {
    const ukryte = acme.statusy.map((s) => (s.key === 'ZEBRANE_ALLEGRO' ? { ...s, active: false } : s))
    for (const defs of [acme.statusy, ukryte, [...DOMYSLNE_STATUSY]]) {
      const klucze = [...defs.map((d) => d.key), ...STATUSY_RDZENIA.map(kluczRdzenia)]
      for (const o of kombinacje()) {
        const wybrany = wybierzStatusFirmy(defs, o)?.key ?? kluczRdzenia(o.status)
        const trafienia = klucze.filter((k) => pasuje(warunekStatusuFirmy(defs, k), o))
        expect(trafienia, JSON.stringify(o)).toEqual([wybrany])
      }
    }
    expect(warunekStatusuFirmy(acme.statusy, 'NIE_MA')).toEqual({ id: '__brak__' })
    expect(warunekStatusuFirmy(acme.statusy, 'RDZEN:XYZ')).toEqual({ id: '__brak__' })
  })

  it('liczniki: suma po statusach firmy = liczba zamówień, każdy wiersz w jednym statusie', () => {
    const w = [
      { status: 'DO_REALIZACJI' as const, carrier: 'DPD' as const, companyStatus: null, n: 3 },
      { status: 'DO_REALIZACJI' as const, carrier: 'PACZKOMATY' as const, companyStatus: null, n: 5 },
      { status: 'DO_REALIZACJI' as const, carrier: 'DPD' as const, companyStatus: 'DO_REALIZACJI_ALLEGRO', n: 1 },
      { status: 'ZEBRANE' as const, carrier: null, companyStatus: null, n: 2 },
      { status: 'WYSLANE' as const, carrier: 'DPD' as const, companyStatus: null, n: 1193 },
    ]
    const m = zlozLicznikiStatusow(acme.statusy, w)
    expect(Object.fromEntries(m)).toEqual({ DO_REALIZACJI_DPD: 3, DO_REALIZACJI_PACZKOMATY: 5, DO_REALIZACJI_ALLEGRO: 1, 'RDZEN:ZEBRANE': 2, WYSLANE: 1193 })
    expect([...m.values()].reduce((a, b) => a + b, 0)).toBe(w.reduce((a, b) => a + b.n, 0))
  })
})

describe('statusy firmy: presety i walidacja', () => {
  it('ACME: 22 statusy BL, 6 grup + statusy bez grupy (7 sekcji panelu), kolory z palety; preset przechodzi walidację', () => {
    expect(() => validatePreset(ACME_PRESET)).not.toThrow()
    expect(acme.statusy).toHaveLength(22)
    const sekcje = new Set(acme.statusy.map((s) => s.groupKey ?? '(bez grupy)'))
    expect(sekcje.size).toBe(7)
    expect(acme.grupy.map((g) => g.name)).toEqual(['Do realizacji', 'Realizowane', 'Spakowane', 'Do wysłania', 'Zakończone', 'Problemowe'])
    const wGrupie = (k: string) => acme.statusy.filter((s) => s.groupKey === k).map((s) => s.name)
    expect(wGrupie('DO_REALIZACJI')).toEqual(['Do realizacji Paczkomaty', 'Do realizacji DPD', 'Do realizacji Osobisty', 'Do realizacji Allegro'])
    expect(wGrupie('REALIZOWANE')).toEqual(['Rozpoczęto zbieranie', 'Zebrane Paczkomaty', 'Zebrane DPD', 'Zebrane Osobisty', 'Zebrane Allegro'])
    expect(wGrupie('ZAKONCZONE')).toEqual(['Anulowane', 'Wysłane', 'Odebrane'])
    expect(acme.statusy.filter((s) => !s.groupKey).map((s) => s.name)).toEqual(['Nowe zamówienia', 'E-book'])
    // kolory jak opis panelu BL: pomarańczowy do realizacji, szary realizowane, zielony wysłane, czerwony anulowane, niebieski nowe, fioletowy e-book
    const kolor = (n: string) => acme.statusy.find((s) => s.name === n)!.color
    expect([kolor('Do realizacji DPD'), kolor('Zebrane DPD'), kolor('Wysłane'), kolor('Anulowane'), kolor('Nowe zamówienia'), kolor('E-book')]).toEqual(['pomaranczowy', 'szary', 'zielony', 'czerwony', 'niebieski', 'fioletowy'])
    for (const s of acme.statusy) expect(Object.keys(KOLORY_STATUSOW)).toContain(s.color)
  })

  it('nowa firma (preset bez statusów): 12 neutralnych statusów, bez nazw ACME, bez „BaseLinker”', () => {
    const n = presetStatusy({})
    expect(n.statusy).toHaveLength(12)
    expect(() => validateZestawStatusow(n.statusy, n.grupy)).not.toThrow()
    const tekst = JSON.stringify(n)
    for (const zakazane of ['BaseLinker', 'Paczkomaty', 'DPD', 'Allegro', 'E-book', 'Osobisty', 'ACME']) expect(tekst).not.toContain(zakazane)
    expect(n.statusy.every((s) => s.carriers.length === 0)).toBe(true)
  })

  it('walidacja: każdy etap musi mieć status, klucze i grupy poprawne', () => {
    const bezWyslanych = acme.statusy.filter((s) => s.baseStatus !== 'WYSLANE')
    expect(() => validateZestawStatusow(bezWyslanych, acme.grupy)).toThrow(/Brakuje statusu dla: Wysłane/)
    expect(() => validateZestawStatusow([...acme.statusy, { ...acme.statusy[0]! }], acme.grupy)).toThrow(/Powtórzony klucz/)
    expect(() => validateZestawStatusow(acme.statusy.map((s, i) => (i ? s : { ...s, groupKey: 'NIE_MA' })), acme.grupy)).toThrow(/Nieznana grupa/)
    expect(() => validateZestawStatusow(acme.statusy.map((s, i) => (i ? s : { ...s, color: 'tęcza' })), acme.grupy)).toThrow(/Nieznany kolor/)
    expect(() => validatePreset({ ...ACME_PRESET, statuses: ACME_PRESET.statuses!.slice(1) })).toThrow(/Preset: Brakuje statusu dla: Nowe/)
  })
})

describe('statusy firmy: status w kanale', () => {
  const k = { mapa: { DO_REALIZACJI: 'processing', SPAKOWANE: 'packed', WYSLANE: 'completed', ANULOWANE: 'cancelled', ANULOWANE_NIEOPLACONE: 'cancelled' }, mapaFirmy: parseMapaStatusowFirmy({ SPAKOWANE_ALLEGRO: 'Spakowane-Allegro', zly: 'x', ZEBRANE_DPD: 'zebrane' }), manifest: null }
  const o = (status: OrderStatus, carrier: Carrier | null, extra: { cancelReason?: string; companyStatus?: string } = {}) => ({ status, carrier, cancelReason: extra.cancelReason ?? null, companyStatus: extra.companyStatus ?? null })

  it('bez nadpisania: wartość z mapy enumu jak dotąd; z nadpisaniem: status firmy i klucz F:<klucz>', () => {
    expect(k.mapaFirmy).toEqual({ SPAKOWANE_ALLEGRO: 'spakowane-allegro', ZEBRANE_DPD: 'zebrane' })
    expect(zapisStatusu(o('SPAKOWANE', 'DPD'), k, acme.statusy)).toEqual({ key: 'SPAKOWANE', channelStatus: 'packed' })
    expect(zapisStatusu(o('SPAKOWANE', 'ALLEGRO'), k, acme.statusy)).toEqual({ key: 'F:SPAKOWANE_ALLEGRO', channelStatus: 'spakowane-allegro' })
    // etap spoza mapy enumu (Zebrane) wysyła się tylko z nadpisania statusu firmy
    expect(zapisStatusu(o('ZEBRANE', 'DPD'), k, acme.statusy)).toEqual({ key: 'F:ZEBRANE_DPD', channelStatus: 'zebrane' })
    expect(zapisStatusu(o('ZEBRANE', 'ALLEGRO'), k, acme.statusy)).toBeNull()
    // bez statusów firmy: zachowanie sprzed zmiany
    expect(zapisStatusu(o('SPAKOWANE', 'ALLEGRO'), k, [])).toEqual({ key: 'SPAKOWANE', channelStatus: 'packed' })
  })

  it('anulowanie nieopłaconego po terminie: zawsze z mapy enumu (osłona płatności), nadpisanie pominięte', () => {
    const kA = { ...k, mapaFirmy: { ANULOWANE: 'odrzucone' } }
    expect(zapisStatusu(o('ANULOWANE', 'DPD', { cancelReason: 'EXPIRED_UNPAID' }), kA, acme.statusy)).toBeNull() // adapter bez osłony płatności: nic
    expect(zapisStatusu(o('ANULOWANE', 'DPD'), kA, acme.statusy)).toEqual({ key: 'F:ANULOWANE', channelStatus: 'odrzucone' })
  })

  it('status firmy z etapu Nowe, Do wyjaśnienia albo Reklamacja nie trafia do sklepu nawet z nadpisaniem', () => {
    const kN = { ...k, mapaFirmy: { NOWE_ZAMOWIENIA: 'processing', DO_WYJASNIENIA: 'on-hold', REKLAMACJA: 'completed' } }
    expect(zapisStatusu(o('NOWE', 'DPD'), kN, acme.statusy)).toBeNull()
    expect(zapisStatusu(o('NOWE', null, { companyStatus: 'NOWE_ZAMOWIENIA' }), kN, acme.statusy)).toBeNull()
    expect(zapisStatusu(o('DO_WYJASNIENIA', 'DPD'), kN, acme.statusy)).toBeNull()
    expect(zapisStatusu(o('REKLAMACJA', 'DPD'), kN, acme.statusy)).toBeNull()
    expect(ETAPY_DO_SKLEPU).not.toContain('NOWE')
    expect(ETAPY_DO_SKLEPU).toContain('ZEBRANE')
    // każdy klucz mapy enumu (poza zdarzeniem anulowania nieopłaconego) jest etapem do sklepu
    for (const key of STATUS_MAP_KEYS) if (key !== 'ANULOWANE_NIEOPLACONE') expect(ETAPY_DO_SKLEPU).toContain(key)
  })

  it('czytelna nazwa klucza wiersza zapisu (etap albo nazwa statusu firmy)', () => {
    expect(nazwaKluczaZapisu('SPAKOWANE', acme.statusy)).toBe('Spakowane')
    expect(nazwaKluczaZapisu('F:SPAKOWANE_ALLEGRO', acme.statusy)).toBe('Spakowane Allegro')
    expect(nazwaKluczaZapisu('F:USUNIETY', acme.statusy)).toBe('USUNIETY')
  })
})

describe('statusy firmy: ręczna zmiana statusu', () => {
  it('opcje rdzenia rozkładają się na statusy firmy przewoźnika zamówienia; ten sam etap = zmiana nazwy; bez statusów jak dotąd', async () => {
    const { opcjeZeStatusamiFirmy } = await import('@/lib/praca/status-dowolny')
    const rdzen = [
      { status: 'ZEBRANE' as const, etykieta: 'Zebrane', droga: 'COFNIECIE' as const, powod: null },
      { status: 'ANULOWANE' as const, etykieta: 'Anulowane', droga: 'ANULUJ' as const, powod: 'Anulowanie już czeka na wynik faktury.' },
    ]
    const o = { status: 'DO_REALIZACJI' as const, carrier: 'DPD' as const, companyStatus: null }
    const w = opcjeZeStatusamiFirmy(rdzen, acme.statusy, o)
    // ten sam etap: „Do realizacji Allegro” nie przy zamówieniu DPD, „Do realizacji DPD” to obecny
    expect(w).toEqual([
      { wartosc: 'F:ZEBRANE_DPD', etykieta: 'Zebrane DPD', droga: 'COFNIECIE', powod: null },
      { wartosc: 'F:ANULOWANE', etykieta: 'Anulowane', droga: 'ANULUJ', powod: 'Anulowanie już czeka na wynik faktury.' },
    ])
    // przypisanie wprost do statusu innego przewoźnika: obecny wybrany, statusu DPD dalej można wrócić
    expect(opcjeZeStatusamiFirmy([], acme.statusy, { ...o, companyStatus: 'DO_REALIZACJI_ALLEGRO' }).map((x) => x.wartosc)).toEqual(['F:DO_REALIZACJI_DPD'])
    expect(opcjeZeStatusamiFirmy(rdzen, [], o).map((x) => x.wartosc)).toEqual(['ZEBRANE', 'ANULOWANE'])
    // etap bez statusu dla przewoźnika: nazwa rdzenia
    expect(opcjeZeStatusamiFirmy(rdzen, acme.statusy, { ...o, carrier: 'BEZ_WYSYLKI' }).map((x) => x.wartosc)).toEqual(['ZEBRANE', 'F:ANULOWANE'])
  })
})
