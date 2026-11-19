// szablony przepływów — pliki poprawne, bez nazw firm, plan wczytania (tryb pełny i dodanie bez nadpisania),
// dopasowanie statusów szablonu do statusów firmy. Czyste funkcje (bez bazy).
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { NAZWY_FIRM_W_TRESCI } from '@/tests/straznik-nazw'
import { DOMYSLNE_GRUPY_STATUSOW, DOMYSLNE_STATUSY, type StatusFirmyT } from '@/lib/panel/statusy'
import { BladRegulPresetu, parsujRegulyPresetu } from './szablon'
import { liczbaRegul, planWczytania, przepiszRegule, statusFirmyDla, statusyNietkniete, SZABLONY, szablonPrzeplywu, zbudujSzablon } from './szablony'

const KATALOG = path.join(process.cwd(), 'lib', 'automaty', 'szablony-przeplywow')
const pusta = { statusy: DOMYSLNE_STATUSY.map((s) => ({ ...s, carriers: [...s.carriers] })), grupy: [...DOMYSLNE_GRUPY_STATUSOW], regul: 0, zamowien: 0, nazwyGrupAutomatow: [] as string[] }

describe('pliki szablonów', () => {
  it('cztery szablony, każdy z opisem „dla kogo” i regułami, w kolejności', () => {
    expect(SZABLONY.map((s) => s.id)).toEqual(['kurier-i-paczkomaty', 'odbior-osobisty', 'allegro-wysylam-z-allegro', 'bez-wysylki'])
    for (const s of SZABLONY) {
      expect(s.dlaKogo.length).toBeGreaterThan(10)
      expect(s.automationRules.length).toBeGreaterThan(0)
      // każda reguła z szablonu startuje wyłączona w pliku (włącza tryb wczytania)
      expect(s.automationRules.every((r) => !r.enabled)).toBe(true)
    }
    // każdy plik z katalogu jest na liście (nowy plik bez wpisu w szablony.ts = czerwony test)
    expect(readdirSync(KATALOG).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort()).toEqual(SZABLONY.map((s) => s.id).sort())
  })

  it('bez nazw konkretnych firm i ich nawyków', () => {
    for (const f of readdirSync(KATALOG)) expect(readFileSync(path.join(KATALOG, f), 'utf8')).not.toMatch(NAZWY_FIRM_W_TRESCI)
  })

  it('polskie znaki w tekstach szablonów (bez zamienników bez ogonków)', () => {
    const teksty = SZABLONY.flatMap((s) => [s.nazwa, s.dlaKogo, ...s.opis, ...s.statuses.map((x) => x.name), ...s.automationRules.map((r) => r.name)]).join(' ')
    expect(teksty).toMatch(/[ąćęłńóśźż]/)
    expect(teksty).not.toMatch(/\b(Wyslane|wyslania|platnosci|Oplacone|odbior)\b/)
  })

  it('zły plik nie przechodzi: nieznany status w regule, zła grupa, brak etapu', () => {
    const kurier = JSON.parse(readFileSync(path.join(KATALOG, 'kurier-i-paczkomaty.json'), 'utf8'))
    expect(() => zbudujSzablon({ ...kurier, automationRules: [{ ...kurier.automationRules[0], actions: [{ typ: 'ustawStatus', status: 'NIE_MA' }] }] })).toThrow(BladRegulPresetu)
    expect(() => zbudujSzablon({ ...kurier, automationRules: [{ ...kurier.automationRules[0], groupKey: 'nie-ma' }] })).toThrow(/nieznana grupa/)
    expect(() => zbudujSzablon({ ...kurier, statuses: kurier.statuses.filter((s: StatusFirmyT) => s.key !== 'WYSLANE') })).toThrow(/Brakuje statusu/)
    expect(() => parsujRegulyPresetu([], [{ key: 'Zły klucz', name: 'x', event: 'OPLACONO', actions: [{ typ: 'oznacz', znacznik: 'gwiazdka' }] }], DOMYSLNE_STATUSY)).toThrow(/zły klucz/)
  })

  it('krok, którego rdzeń nigdy nie wykona (z „Wysłane” z powrotem do „Nowe”), wywraca plik przy starcie', () => {
    const kurier = JSON.parse(readFileSync(path.join(KATALOG, 'kurier-i-paczkomaty.json'), 'utf8'))
    const wstecz = { key: 'wstecz', groupKey: kurier.automationRules[0].groupKey, name: 'Wysłane → Nowe', event: 'USTAWIONO_STATUS', conditions: [{ typ: 'status', wartosci: ['WYSLANE'] }], actions: [{ typ: 'ustawStatus', status: 'NOWE' }] }
    expect(() => zbudujSzablon({ ...kurier, automationRules: [...kurier.automationRules, wstecz] })).toThrow(/nigdy nie ustawi/)
  })
})

describe('liczba reguł po polsku', () => {
  it('odmiana', () => {
    expect([1, 3, 5, 12, 22, 25].map(liczbaRegul)).toEqual(['1 reguła', '3 reguły', '5 reguł', '12 reguł', '22 reguły', '25 reguł'])
  })
})

describe('plan wczytania', () => {
  it('pusta firma z domyślnymi statusami: tryb pełny, reguły włączone, zmiany nazw wypisane', () => {
    const p = planWczytania(szablonPrzeplywu('bez-wysylki')!, pusta)
    expect(p.tryb).toBe('PELNY')
    expect(p.wlaczone).toBe(true)
    expect(p.zmianyStatusow).toContainEqual({ klucz: 'DO_REALIZACJI', bylo: 'Do realizacji', bedzie: 'Opłacone', ukryty: false })
    expect(p.zmianyStatusow.find((z) => z.klucz === 'ZBIERANIE')?.ukryty).toBe(true)
    expect(p.reguly.every((r) => r.pominieta === null)).toBe(true)
  })

  it('firma z regułą albo zamówieniem: dodanie do nowej wyłączonej grupy, statusy bez zmian', () => {
    const sz = szablonPrzeplywu('kurier-i-paczkomaty')!
    for (const f of [{ ...pusta, regul: 1 }, { ...pusta, zamowien: 3 }]) {
      const p = planWczytania(sz, f)
      expect(p.tryb).toBe('DODANIE')
      expect(p.wlaczone).toBe(false)
      expect(p.zmianyStatusow).toEqual([])
      expect(p.grupa).toBe('Szablon: Kurier i paczkomaty')
    }
    // drugi raz ten sam szablon: kolejna grupa, z ostrzeżeniem
    const p2 = planWczytania(sz, { ...pusta, regul: 6, nazwyGrupAutomatow: ['Szablon: Kurier i paczkomaty'] })
    expect(p2.grupa).toBe('Szablon: Kurier i paczkomaty (2)')
    expect(p2.ostrzezenia.join(' ')).toMatch(/był już wczytany/)
  })

  it('statusy firmy zmienione (własne nazwy): dodanie, reguły wskazują statusy firmy tego samego etapu', () => {
    const wlasne: StatusFirmyT[] = [
      ...DOMYSLNE_STATUSY.filter((s) => s.baseStatus !== 'DO_WYSLANIA').map((s) => ({ ...s, carriers: [...s.carriers] })),
      { key: 'CZEKA_NA_KURIERA', name: 'Czeka na kuriera', customerName: null, color: 'turkusowy', groupKey: null, sortOrder: 55, baseStatus: 'DO_WYSLANIA', carriers: [], active: true },
    ]
    expect(statusyNietkniete(wlasne)).toBe(false)
    const p = planWczytania(szablonPrzeplywu('kurier-i-paczkomaty')!, { ...pusta, statusy: wlasne })
    expect(p.tryb).toBe('DODANIE')
    expect(p.dopasowania.find((d) => d.szablon === 'DO_WYSLANIA')).toMatchObject({ klucz: 'CZEKA_NA_KURIERA', nazwa: 'Czeka na kuriera', takiSam: false })
    expect(p.dopasowania.find((d) => d.szablon === 'NOWE')).toMatchObject({ klucz: 'NOWE', takiSam: true })
    expect(p.reguly.every((r) => r.pominieta === null)).toBe(true)
  })

  it('statusFirmyDla: ten sam klucz, inaczej pierwszy aktywny ogólny status etapu, inaczej sam etap', () => {
    const f: StatusFirmyT[] = [
      { key: 'A_DPD', name: 'Do wysłania DPD', customerName: null, color: 'szary', groupKey: null, sortOrder: 1, baseStatus: 'DO_WYSLANIA', carriers: ['DPD'], active: true },
      { key: 'B', name: 'Do wysłania', customerName: null, color: 'szary', groupKey: null, sortOrder: 2, baseStatus: 'DO_WYSLANIA', carriers: [], active: true },
      { key: 'WYSLANE', name: 'Wysłane', customerName: null, color: 'szary', groupKey: null, sortOrder: 3, baseStatus: 'WYSLANE', carriers: [], active: false },
    ]
    expect(statusFirmyDla({ key: 'DO_WYSLANIA', baseStatus: 'DO_WYSLANIA' }, f)).toBe('B')
    expect(statusFirmyDla({ key: 'WYSLANE', baseStatus: 'WYSLANE' }, f)).toBe('RDZEN:WYSLANE') // ukryty status firmy nie bierze reguł
    expect(statusFirmyDla({ key: 'NOWE', baseStatus: 'NOWE' }, [])).toBe('RDZEN:NOWE')
  })

  it('przepiszRegule zmienia tylko statusy w warunku „Status” i w kroku „Ustaw status”', () => {
    const r = przepiszRegule({ conditions: [{ typ: 'status', wartosci: ['DO_WYSLANIA', 'NOWE'] }, { typ: 'pobranie', wartosc: true }], actions: [{ typ: 'ustawStatus', status: 'WYSLANE' }, { typ: 'drukujEtykiete', stanowisko: null }] }, new Map([['DO_WYSLANIA', 'B'], ['WYSLANE', 'RDZEN:WYSLANE']]))
    expect(r).toEqual({ conditions: [{ typ: 'status', wartosci: ['B', 'NOWE'] }, { typ: 'pobranie', wartosc: true }], actions: [{ typ: 'ustawStatus', status: 'RDZEN:WYSLANE' }, { typ: 'drukujEtykiete', stanowisko: null }] })
  })
})
