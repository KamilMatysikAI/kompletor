// schemat automatycznych akcji (walidacja, warunki, konflikty, mapa zdarzeń dziennika) i test tabelaryczny:
// każda z 33 automatycznych akcji BaseLinkera ACME (docs/akcje-bl.md) da się zapisać w nowym schemacie (bez wykonania).
import { describe, expect, it } from 'vitest'
import { ACME_STATUSES } from '@/tests/preset-testowy'
import { kontekstZ } from './dane'
import { krokiNigdyDozwolone, parsujRegule, przejscieMozliwe, type RegulaT } from './schemat'
import { lancuchZAktora, aktorAutomatu } from './wykonanie'
import { mogaSieNakladac, ostrzezenia, spelnia, spelniaWszystkie, type FaktyWarunkow } from './warunki'
import { dniOd, zdaniePodgladu, zdarzeniaZDziennika } from './silnik'

const acme = kontekstZ(ACME_STATUSES.map((s) => ({ ...s, customerName: null, groupKey: s.groupKey ?? null, carriers: [...(s.carriers ?? [])], active: s.active ?? true })))

const ustaw = (status: string) => ({ typ: 'ustawStatus', status })
const mail = (szablon: string) => ({ typ: 'wyslijEmail', szablon })
const przesylka = (gabaryt?: string) => ({ typ: 'utworzPrzesylke', ...(gabaryt ? { gabaryt } : {}) })
const pobranie = (v: boolean) => ({ typ: 'pobranie', wartosc: v })
const zrodlo = (wartosci: string[], nie = false) => ({ typ: 'zrodlo', wartosci, nie })
const fraza = (frazy: string[]) => ({ typ: 'przesylka', frazy })
const status = (wartosci: string[], nie = false) => ({ typ: 'status', wartosci, nie })

/** 33 akcje BL ACME w nowym schemacie (numeracja z docs/akcje-bl.md). Przeniesienie do presetu. */
const BL_33: [number, Record<string, unknown>][] = [
  [1, { name: 'Opłacone Allegro', event: 'OPLACONO', conditions: [pobranie(false), zrodlo(['ALLEGRO'])], actions: [ustaw('DO_REALIZACJI_ALLEGRO')] }],
  [2, { name: 'Pobranie Allegro', event: 'POBRANO', conditions: [pobranie(true), zrodlo(['ALLEGRO'])], actions: [ustaw('DO_REALIZACJI_ALLEGRO')] }],
  [3, { name: 'Opłacone Paczkomaty', event: 'OPLACONO', conditions: [pobranie(false), zrodlo(['ALLEGRO'], true), fraza(['Paczkomaty'])], actions: [ustaw('DO_REALIZACJI_PACZKOMATY')] }],
  [4, { name: 'Opłacone DPD', event: 'OPLACONO', conditions: [pobranie(false), zrodlo(['ALLEGRO'], true), fraza(['DPD', 'KURIER', 'Empik'])], actions: [ustaw('DO_REALIZACJI_DPD')] }],
  [5, { name: 'Pobranie DPD', event: 'POBRANO', conditions: [pobranie(true), zrodlo(['ALLEGRO'], true), fraza(['DPD', 'Kurier', 'Empik'])], actions: [ustaw('DO_REALIZACJI_DPD')] }],
  [6, { name: 'Opłacone Osobisty', event: 'OPLACONO', conditions: [pobranie(false), zrodlo(['WOO:sklepdemo']), fraza(['Osobisty'])], actions: [ustaw('DO_REALIZACJI_OSOBISTY')] }],
  [7, { name: 'Faktura przy Do realizacji', event: 'USTAWIONO_STATUS', conditions: [status(['DO_REALIZACJI_PACZKOMATY'])], actions: [{ typ: 'wystawFakture' }] }],
  [8, { name: 'Przekazano kurierowi', event: 'STATUS_PRZESYLKI', conditions: [{ typ: 'statusPrzesylki', frazy: ['Przekazano kurierowi'] }], actions: [ustaw('WYSLANE')] }],
  [9, { name: 'Anulowano', event: 'ANULOWANO', conditions: [], actions: [ustaw('ANULOWANE')] }],
  [10, { name: 'Mail Faktura', event: 'USTAWIONO_STATUS', conditions: [status(['WYSLANE', 'ODEBRANE'])], actions: [mail('faktura')] }],
  [11, { name: 'Błąd FV', event: 'BLAD_FAKTURY', conditions: [], actions: [mail('blad-faktury'), { typ: 'oznacz', znacznik: 'gwiazdka', wartosc: true }, { typ: 'anulujFakture' }] }],
  [12, { name: 'Brak płatności', event: 'W_STATUSIE_DNI', conditions: [{ typ: 'dniWStatusie', dni: 2, robocze: true }, status(['NOWE_ZAMOWIENIA'])], actions: [mail('brak-platnosci')] }],
  [13, { name: 'Anuluj nieopłacone', event: 'W_STATUSIE_DNI', conditions: [{ typ: 'dniWStatusie', dni: 5, robocze: true }, status(['NOWE_ZAMOWIENIA'])], actions: [ustaw('ANULOWANE')] }],
  [14, { name: 'Gotowe do odbioru', event: 'USTAWIONO_STATUS', conditions: [status(['DO_ODBIORU'])], actions: [mail('gotowe-do-odbioru')] }],
  [15, { name: 'Rozpoczęto zbieranie', event: 'ROZPOCZETO_ZBIERANIE', conditions: [], actions: [ustaw('ROZPOCZETO_ZBIERANIE')] }],
  [16, { name: 'Zebrane Allegro', event: 'ZEBRANO', conditions: [fraza(['Allegro'])], actions: [ustaw('ZEBRANE_ALLEGRO')] }],
  [17, { name: 'Zebrane DPD', event: 'ZEBRANO', conditions: [fraza(['Kurier', 'DPD', 'Empik']), zrodlo(['ALLEGRO'], true)], actions: [ustaw('ZEBRANE_DPD')] }],
  [18, { name: 'Zebrane Paczkomaty', event: 'ZEBRANO', conditions: [fraza(['Paczkomaty']), zrodlo(['ALLEGRO'], true)], actions: [ustaw('ZEBRANE_PACZKOMATY')] }],
  [19, { name: 'Zebrane Osobisty', event: 'ZEBRANO', conditions: [fraza(['Osobisty'])], actions: [ustaw('ZEBRANE_OSOBISTY')] }],
  [20, { name: 'Spakowane Allegro', event: 'SPAKOWANO', conditions: [fraza(['Allegro']), status(['DO_WYSLANIA'], true)], actions: [ustaw('SPAKOWANE_ALLEGRO')] }],
  [21, { name: 'Spakowane DPD', event: 'SPAKOWANO', conditions: [fraza(['Kurier', 'DPD', 'Empik']), zrodlo(['ALLEGRO'], true), status(['DO_WYSLANIA'], true)], actions: [ustaw('SPAKOWANE_DPD')] }],
  [22, { name: 'Spakowane Paczkomaty', event: 'SPAKOWANO', conditions: [fraza(['Paczkomaty']), zrodlo(['ALLEGRO'], true), status(['DO_WYSLANIA'], true)], actions: [ustaw('SPAKOWANE_PACZKOMATY')] }],
  [23, { name: 'Spakowane Osobisty', event: 'SPAKOWANO', conditions: [fraza(['Osobisty'])], actions: [ustaw('SPAKOWANE_OSOBISTY')] }],
  [24, { name: 'Utworzono przesyłkę', event: 'UTWORZONO_PRZESYLKE', conditions: [], actions: [ustaw('DO_WYSLANIA'), { typ: 'drukujEtykiete' }] }],
  [25, { name: 'Kurier DPD', event: 'PRZYCISK', buttonPlaces: ['karta', 'pakowanie'], conditions: [fraza(['Kurier', 'DPD'])], actions: [{ typ: 'utworzPrzesylke', modul: 'basecourier.zapis.v1' }] }],
  [26, { name: 'Kurier DPD Empik', event: 'PRZYCISK', buttonPlaces: ['karta'], conditions: [fraza(['Empik'])], actions: [{ typ: 'utworzPrzesylke', modul: 'basecourier.zapis.v1' }] }],
  [27, { name: 'Allegro Gabaryt A / S', event: 'PRZYCISK', buttonPlaces: ['pakowanie'], conditions: [], actions: [przesylka('A')] }],
  [28, { name: 'Allegro Gabaryt B / M', event: 'PRZYCISK', buttonPlaces: ['pakowanie'], conditions: [], actions: [przesylka('B')] }],
  [29, { name: 'Allegro Gabaryt C / L', event: 'PRZYCISK', buttonPlaces: ['pakowanie'], conditions: [], actions: [przesylka('C')] }],
  [30, { name: 'InPost Gabaryt A', event: 'PRZYCISK', buttonPlaces: ['pakowanie'], conditions: [], actions: [przesylka('A')] }],
  [31, { name: 'InPost Gabaryt B', event: 'PRZYCISK', buttonPlaces: ['pakowanie'], conditions: [], actions: [przesylka('B')] }],
  [32, { name: 'InPost Gabaryt C', event: 'PRZYCISK', buttonPlaces: ['pakowanie'], conditions: [], actions: [przesylka('C')] }],
  [33, { name: 'Do wyjaśnienia', event: 'PRZYCISK', buttonPlaces: ['karta'], conditions: [], actions: [ustaw('DO_WYJASNIENIA')] }],
]

describe('33 akcje BL ACME w schemacie automatycznych akcji', () => {
  it('tabela ma 33 różne akcje', () => {
    expect(BL_33.map(([n]) => n)).toEqual(Array.from({ length: 33 }, (_, i) => i + 1))
  })
  it.each(BL_33)('akcja %i zapisuje się bez błędów', (_n, raw) => {
    const p = parsujRegule(raw, acme)
    if (!p.ok) throw new Error(JSON.stringify(p.bledy))
    expect(p.regula.actions.length).toBeGreaterThan(0)
  })
})

describe('walidacja reguły', () => {
  it('odrzuca dowolny kod, nieznane typy i puste kroki', () => {
    const p = parsujRegule({ name: 'x', event: 'OPLACONO', conditions: [{ typ: 'js', kod: 'process.exit()' }], actions: [] }, acme)
    expect(p.ok).toBe(false)
    if (!p.ok) expect(p.bledy.map((b) => b.pole)).toEqual(expect.arrayContaining(['warunek-0', 'kroki']))
  })
  it('obcina nieznane pola', () => {
    const p = parsujRegule({ name: ' Reguła ', event: 'ANULOWANO', conditions: [], actions: [{ typ: 'anulujFakture', zly: 1 }], zle: true }, acme)
    expect(p.ok && p.regula).toEqual({ name: 'Reguła', event: 'ANULOWANO', conditions: [], actions: [{ typ: 'anulujFakture' }], buttonLabel: null, buttonPlaces: [], description: null })
  })
  it('zdarzenie czasowe wymaga dni i statusu; dni tylko przy zdarzeniu czasowym', () => {
    expect(parsujRegule({ name: 'x', event: 'W_STATUSIE_DNI', conditions: [status(['NOWE_ZAMOWIENIA'])], actions: [mail('brak-platnosci')] }, acme).ok).toBe(false)
    expect(parsujRegule({ name: 'x', event: 'OPLACONO', conditions: [{ typ: 'dniWStatusie', dni: 2 }], actions: [mail('faktura')] }, acme).ok).toBe(false)
  })
  it('przycisk wymaga miejsca', () => {
    const p = parsujRegule({ name: 'Paczka mała', event: 'PRZYCISK', conditions: [], actions: [przesylka('A')] }, acme)
    expect(p.ok).toBe(false)
  })
  it('nie zapisze kroku statusu, którego z etapu warunku nigdy nie da się ustawić', () => {
    // Wysłane → Do realizacji: brak drogi w rdzeniu
    const p = parsujRegule({ name: 'x', event: 'USTAWIONO_STATUS', conditions: [status(['WYSLANE'])], actions: [ustaw('DO_REALIZACJI_DPD')] }, acme)
    expect(p.ok).toBe(false)
    if (!p.ok) expect(p.bledy[0]!.pole).toBe('krok-0')
    // spakowanie tylko przyciskiem „Spakuj”
    expect(parsujRegule({ name: 'x', event: 'ZEBRANO', conditions: [], actions: [ustaw('SPAKOWANE_DPD')] }, acme).ok).toBe(false)
    // zmiana samej nazwy w tym samym etapie zawsze wolno
    expect(parsujRegule({ name: 'x', event: 'ZEBRANO', conditions: [], actions: [ustaw('ZEBRANE_DPD')] }, acme).ok).toBe(true)
  })
  it('przejścia automatu: tylko drogi rdzenia', () => {
    expect(przejscieMozliwe('SPAKOWANE', 'DO_WYSLANIA')).toBe(true)
    expect(przejscieMozliwe('DO_WYSLANIA', 'SPAKOWANE')).toBe(true) // cofnięcie pomyłki
    expect(przejscieMozliwe('NOWE', 'DO_REALIZACJI')).toBe(false) // płatność robi rdzeń
    expect(przejscieMozliwe('ZEBRANE', 'SPAKOWANE')).toBe(false) // „Spakuj”
    expect(przejscieMozliwe('WYSLANE', 'ANULOWANE')).toBe(false)
    expect(krokiNigdyDozwolone({ name: 'x', event: 'OPLACONO', conditions: [], actions: [{ typ: 'ustawStatus', status: 'WYSLANE' }] }, acme)).toEqual([])
  })
})

const fakty = (x: Partial<FaktyWarunkow> = {}): FaktyWarunkow => ({ channel: 'WOO', channelAccountId: 'sklep', paymentState: 'PAID', deliveryMethod: 'Paczkomaty InPost', carrier: 'PACZKOMATY', statusFirmy: 'NOWE_ZAMOWIENIA', totalGross: 120, ...x })

describe('warunki z bieżącego stanu', () => {
  it('źródło: kanał, konto, negacja', () => {
    expect(spelnia({ typ: 'zrodlo', wartosci: ['WOO'] }, fakty())).toBe(true)
    expect(spelnia({ typ: 'zrodlo', wartosci: ['WOO:inny'] }, fakty())).toBe(false)
    expect(spelnia({ typ: 'zrodlo', wartosci: ['ALLEGRO'], nie: true }, fakty())).toBe(true)
  })
  it('pobranie, opłacone, kwota, fraza bez wielkości liter i polskich znaków', () => {
    expect(spelnia({ typ: 'pobranie', wartosc: true }, fakty({ paymentState: 'COD' }))).toBe(true)
    expect(spelnia({ typ: 'oplacone', wartosc: true }, fakty({ paymentState: 'COD' }))).toBe(true)
    expect(spelnia({ typ: 'oplacone', wartosc: true }, fakty({ paymentState: 'UNPAID' }))).toBe(false)
    expect(spelnia({ typ: 'kwota', od: 100, do: 150 }, fakty())).toBe(true)
    expect(spelnia({ typ: 'kwota', od: 121 }, fakty())).toBe(false)
    expect(spelnia({ typ: 'przesylka', frazy: ['paczkomaty'] }, fakty())).toBe(true)
    expect(spelnia({ typ: 'przesylka', frazy: ['Odbiór'] }, fakty({ deliveryMethod: 'odbior w sklepie' }))).toBe(true)
    expect(spelnia({ typ: 'przewoznik', wartosci: ['DPD'], nie: true }, fakty())).toBe(true)
  })
  it('dni w statusie: robocze albo kalendarzowe', () => {
    const f = fakty({ dniWStatusie: { kalendarzowe: 3, robocze: 1 } })
    expect(spelniaWszystkie([{ typ: 'dniWStatusie', dni: 2, robocze: true }], f)).toBe(false)
    expect(spelniaWszystkie([{ typ: 'dniWStatusie', dni: 2, robocze: false }], f)).toBe(true)
    // piątek 6.11.2026 10:00 → wtorek 10.11 10:00: 4 dni kalendarzowe, 2 robocze
    expect(dniOd(new Date('2026-11-06T09:00:00Z'), new Date('2026-11-10T09:00:00Z'))).toEqual({ kalendarzowe: 4, robocze: 2 })
  })
})

describe('konflikty reguł', () => {
  const r = (id: string, x: Partial<RegulaT>, pozycja: number) => ({ id, enabled: true, pozycja, name: id, event: 'OPLACONO' as const, conditions: [], actions: [{ typ: 'ustawStatus' as const, status: 'DO_REALIZACJI_DPD' }], ...x })
  it('dwie reguły o nakładających się warunkach ustawiają różne statusy: ostrzeżenie z kolejnością', () => {
    const a = r('A', { conditions: [{ typ: 'zrodlo', wartosci: ['WOO'] }] }, 0)
    const b = r('B', { conditions: [{ typ: 'pobranie', wartosc: false }], actions: [{ typ: 'ustawStatus', status: 'DO_REALIZACJI_PACZKOMATY' }] }, 1)
    const o = ostrzezenia([a, b], (id) => id)
    expect(o.filter((x) => x.rodzaj === 'KONFLIKT').map((x) => x.regulaId)).toEqual(['A', 'B'])
    expect(o[0]!.komunikat).toContain('zostanie status z „B”')
  })
  it('warunki rozłączne (Allegro / nie Allegro, różne frazy) = bez konfliktu', () => {
    const a = r('A', { conditions: [{ typ: 'zrodlo', wartosci: ['ALLEGRO'] }] }, 0)
    const b = r('B', { conditions: [{ typ: 'zrodlo', wartosci: ['ALLEGRO'], nie: true }], actions: [{ typ: 'ustawStatus', status: 'DO_REALIZACJI_PACZKOMATY' }] }, 1)
    expect(mogaSieNakladac(a, b)).toBe(false)
    const c = r('C', { conditions: [{ typ: 'przesylka', frazy: ['Paczkomaty'] }] }, 0)
    const d = r('D', { conditions: [{ typ: 'przesylka', frazy: ['DPD', 'Kurier'] }], actions: [{ typ: 'ustawStatus', status: 'DO_REALIZACJI_PACZKOMATY' }] }, 1)
    expect(ostrzezenia([c, d], (id) => id).filter((x) => x.rodzaj === 'KONFLIKT')).toEqual([])
  })
  it('reguła bez warunków na zdarzeniu masowym: ostrzeżenie; wyłączona reguła: nic', () => {
    expect(ostrzezenia([r('A', {}, 0)], (id) => id).map((x) => x.rodzaj)).toEqual(['BEZ_WARUNKOW'])
    expect(ostrzezenia([{ ...r('A', {}, 0), enabled: false }], (id) => id)).toEqual([])
  })
})

describe('zdarzenia z dziennika zamówienia', () => {
  it('rdzeń i ekrany → zdarzenia reguł', () => {
    expect(zdarzeniaZDziennika({ kind: 'ZEBRANE', actorId: 'panel', data: {} })).toEqual(['ZEBRANO', 'USTAWIONO_STATUS'])
    expect(zdarzeniaZDziennika({ kind: 'PRZYJETE', actorId: 'system:woo', data: {} }, { oplaconePrzyPrzyjeciu: true })).toEqual(['POBRANO', 'OPLACONO', 'USTAWIONO_STATUS'])
    expect(zdarzeniaZDziennika({ kind: 'FAKTURA_BLAD', actorId: 'system:faktury', data: {} })).toEqual(['BLAD_FAKTURY'])
    expect(zdarzeniaZDziennika({ kind: 'EDYCJA', actorId: 'panel', data: {} })).toEqual([])
  })
  it('zmiany reguł: tylko „Ustawiono status” z wpisu reguły, z głębokością łańcucha w autorze', () => {
    const a = aktorAutomatu(3, 'r1')
    expect(lancuchZAktora(a)).toBe(3)
    expect(zdarzeniaZDziennika({ kind: 'ZBIERANIE', actorId: a, data: {} })).toEqual([])
    expect(zdarzeniaZDziennika({ kind: 'AUTOMAT', actorId: a, data: { krok: 'ustawStatus', statusFirmy: 'X' } })).toEqual(['USTAWIONO_STATUS'])
    expect(zdarzeniaZDziennika({ kind: 'AUTOMAT', actorId: a, data: { krok: 'wyslijEmail' } })).toEqual([])
  })
})

describe('zdanie podglądu', () => {
  it('liczby po polsku i zapewnienie, że nic nie poszło', () => {
    const z = zdaniePodgladu({ dni: 7, zamowien: 12, kroki: { ustawStatus: 12, wyslijEmail: 3 }, pominiete: 0 }, { event: 'OPLACONO', actions: [] })
    expect(z).toBe('Przez ostatnie 7 dni reguła zadziałałaby na 12 zamówieniach: zmieniłaby status 12 zamówień, wysłałaby 3 maile. Nic nie zostało zapisane ani wysłane.')
    expect(zdaniePodgladu({ dni: 7, zamowien: 0, kroki: {}, pominiete: 0 }, { event: 'OPLACONO', actions: [] })).toContain('ani razu')
  })
})
