// ×: statusy własne firmy w menu „Zamówienia” (dawny lewy panel listy). Czysta część:
// z liczników `licznikiPanelu().firmy` menu buduje grupy, statusy z kolorem, „Bez statusu firmy”, „Ustaw statusy”
// i przewoźników pod statusem; zaznaczenie po `sf`/`sg` w adresie; tytuł listy. Liczniki na bazie: test integracyjny
// `tests/menu-statusy-firmy.integration.test.ts`.
import { describe, expect, it } from 'vitest'
import { adresStatusuFirmy, bezNazwyGrupy, nazwaBiezacego, pozycjeStatusow } from './menu-statusy'
import { aktywnaPozycja, zbudujMenu, type PozycjaMenu } from './nawigacja'
import { DOMYSLNE_GRUPY_STATUSOW, DOMYSLNE_STATUSY, KOLORY_STATUSOW, type GrupaStatusowT, type StatusFirmyT } from './statusy'
import { zlozLicznikiStatusow, zlozPrzewoznikowStatusow } from './statusy-firmy-dane'
import { zlozLiczniki, type LicznikiPanelu } from './zamowienia-lista'

const grupy: GrupaStatusowT[] = [
  { key: 'DO_REALIZACJI', name: 'Do realizacji', sortOrder: 10, collapsed: false },
  { key: 'ZAKONCZONE', name: 'Zakończone', sortOrder: 20, collapsed: true },
  { key: 'PUSTA', name: 'Pusta', sortOrder: 30, collapsed: false },
]
const st = (key: string, name: string, color: string, groupKey: string | null, sortOrder: number, baseStatus: StatusFirmyT['baseStatus'], carriers: StatusFirmyT['carriers'] = [], active = true): StatusFirmyT => ({
  key,
  name,
  color,
  groupKey,
  sortOrder,
  baseStatus,
  carriers,
  active,
})
const statusy: StatusFirmyT[] = [
  st('NOWE_Z', 'Nowe zamówienia', 'niebieski', null, 10, 'NOWE'),
  st('DR_PACZ', 'Do realizacji Paczkomaty', 'pomaranczowy', 'DO_REALIZACJI', 20, 'DO_REALIZACJI', ['PACZKOMATY']),
  st('DR_INNE', 'Do realizacji', 'zolty', 'DO_REALIZACJI', 30, 'DO_REALIZACJI'),
  st('WYSL', 'Wysłane', 'zielony', 'ZAKONCZONE', 40, 'WYSLANE'),
  st('UKRYTY', 'Ukryty pusty', 'rozowy', 'ZAKONCZONE', 50, 'ODEBRANE', [], false),
  st('ANUL', 'Anulowane', 'nieznany-kolor', 'ZAKONCZONE', 60, 'ANULOWANE'),
]
const wiersze = [
  { status: 'NOWE' as const, carrier: null, companyStatus: null, n: 4 },
  { status: 'DO_REALIZACJI' as const, carrier: 'PACZKOMATY' as const, companyStatus: null, n: 3 },
  { status: 'DO_REALIZACJI' as const, carrier: 'DPD' as const, companyStatus: null, n: 2 },
  { status: 'DO_REALIZACJI' as const, carrier: null, companyStatus: null, n: 1 },
  { status: 'WYSLANE' as const, carrier: 'DPD' as const, companyStatus: null, n: 7 },
  { status: 'ZEBRANE' as const, carrier: 'DPD' as const, companyStatus: null, n: 2 }, // bez statusu firmy
]

function liczniki(s: StatusFirmyT[], g: GrupaStatusowT[]): LicznikiPanelu {
  const l = zlozLiczniki(wiersze, 6)
  return { ...l, firmy: { statusy: s, grupy: g, ile: Object.fromEntries(zlozLicznikiStatusow(s, wiersze)), przewoznicy: Object.fromEntries(zlozPrzewoznikowStatusow(s, wiersze)) } }
}

const l = liczniki(statusy, grupy)
const p = pozycjeStatusow(l, { ustawienia: true })
const znajdz = (lista: PozycjaMenu[], etykieta: string): PozycjaMenu | undefined => {
  for (const x of lista) {
    if ((x.pelnaNazwa ?? x.etykieta) === etykieta) return x
    const d = znajdz(x.dzieci, etykieta)
    if (d) return d
  }
  return undefined
}

describe('statusy firmy w menu „Zamówienia”', () => {
  it('kolejność: „Wszystkie”, „Wymaga działania”, statusy bez grupy, grupy z sumą, „Bez statusu firmy”, „Ustaw statusy”', () => {
    expect(p.map((x) => x.etykieta)).toEqual(['Wszystkie', 'Wymaga działania', 'Nowe zamówienia', 'Do realizacji', 'Zakończone', 'Bez statusu firmy', 'Ustaw statusy'])
    // „Wszystkie” bez licznika; „Wymaga działania” i statusy z licznikiem
    expect(p[0]).toMatchObject({ etykieta: 'Wszystkie', widok: { widok: 'wszystkie' } })
    expect(p[0]!.licznik).toBeUndefined()
    expect(p[1]).toMatchObject({ licznik: 6, licznikTon: 'ostrzezenie', widok: { widok: 'wymaga' } })
    // grupa bez widocznych statusów nie ma pozycji (jak w panelu)
    expect(znajdz(p, 'Pusta')).toBeUndefined()
  })

  it('liczniki = liczniki dawnego panelu (`firmy.ile`), grupa = suma jej statusów', () => {
    expect(znajdz(p, 'Nowe zamówienia')).toMatchObject({ licznik: 4, href: '/zamowienia?widok=wszystkie&sf=NOWE_Z', widok: { widok: 'wszystkie', sf: 'NOWE_Z' } })
    expect(znajdz(p, 'Do realizacji Paczkomaty')!.licznik).toBe(3)
    // „Do realizacji” (bez przewoźnika w ustawieniach) bierze DPD i brak przewoźnika
    const dr = p.find((x) => x.etykieta === 'Do realizacji')!
    expect(dr).toMatchObject({ licznik: 6, href: '/zamowienia?widok=wszystkie&sg=DO_REALIZACJI', widok: { widok: 'wszystkie', sg: 'DO_REALIZACJI' }, grupaStatusow: { klucz: 'DO_REALIZACJI', zwinietaNaStart: false } })
    // w menu pod grupą bez powtórzonej nazwy grupy, pełna nazwa w `pelnaNazwa` (title, czytnik ekranu)
    expect(dr.dzieci.map((d) => [d.etykieta, d.pelnaNazwa, d.licznik])).toEqual([
      ['Paczkomaty', 'Do realizacji Paczkomaty', 3],
      ['Do realizacji', undefined, 3],
    ])
    const plaskie = (x: PozycjaMenu): PozycjaMenu[] => [x, ...x.dzieci.flatMap(plaskie)]
    const wszystkie = p.flatMap(plaskie)
    for (const [k, n] of Object.entries(l.firmy!.ile)) expect(wszystkie.find((x) => x.widok?.sf === k && !x.widok.przewoznik)!.licznik, k).toBe(n)
  })

  it('kropka w kolorze statusu z ustawień (`PozycjaMenu.kolor`), nieznany kolor = szary; grupy bez kropki', () => {
    expect(znajdz(p, 'Nowe zamówienia')).toMatchObject({ kropka: 'neutralny', kolor: KOLORY_STATUSOW.niebieski.tekst })
    expect(znajdz(p, 'Anulowane')!.kolor).toBe(KOLORY_STATUSOW.szary.tekst)
    expect(p.find((x) => x.etykieta === 'Do realizacji')!.kropka).toBeUndefined()
  })

  it('grupa zwinięta w ustawieniach: `zwinietaNaStart` (menu nie pamięta jej rozwinięcia); ukryty status bez zamówień znika', () => {
    const z = p.find((x) => x.etykieta === 'Zakończone')!
    expect(z.grupaStatusow).toEqual({ klucz: 'ZAKONCZONE', zwinietaNaStart: true })
    expect(z.dzieci.map((d) => d.etykieta)).toEqual(['Wysłane', 'Anulowane'])
    expect(znajdz(p, 'Ukryty pusty')).toBeUndefined()
    const zZamowieniem = pozycjeStatusow({ ...l, firmy: { ...l.firmy!, ile: { ...l.firmy!.ile, UKRYTY: 2 } } })
    expect(znajdz(zZamowieniem, 'Ukryty pusty')!.licznik).toBe(2)
  })

  it('„Bez statusu firmy”: nagłówek bez linku, pod nim etap rdzenia z kluczem RDZEN:', () => {
    const b = p.find((x) => x.etykieta === 'Bez statusu firmy')!
    expect(b.naglowek).toBe(true)
    expect(b.dzieci.map((d) => [d.etykieta, d.licznik, d.widok?.sf])).toEqual([['Zebrane', 2, 'RDZEN:ZEBRANE']])
  })

  it('przewoźnicy pod statusem z kolejką magazynu, który nie jest jednego przewoźnika; nie pod „Wysłane”', () => {
    const inne = p.find((x) => x.etykieta === 'Do realizacji')!.dzieci[1]!
    expect(inne.dzieci.map((d) => [d.etykieta, d.licznik, d.href])).toEqual([
      ['DPD', 2, '/zamowienia?widok=wszystkie&sf=DR_INNE&przewoznik=DPD'],
      ['bez przewoźnika', 1, '/zamowienia?widok=wszystkie&sf=DR_INNE&przewoznik=BRAK'],
    ])
    // suma przewoźników = licznik statusu
    expect(inne.dzieci.reduce((n, d) => n + (d.licznik ?? 0), 0)).toBe(inne.licznik)
    expect(znajdz(p, 'Do realizacji Paczkomaty')!.dzieci).toEqual([])
    expect(znajdz(p, 'Wysłane')!.dzieci).toEqual([])
    // jedyny przewoźnik z licznikiem równym statusowi (Zebrane 2 = DPD 2) nie dubluje pozycji
    expect(znajdz(p, 'Zebrane')!.dzieci).toEqual([])
    const dwa = pozycjeStatusow({ ...l, firmy: { ...l.firmy!, przewoznicy: { ...l.firmy!.przewoznicy, 'RDZEN:ZEBRANE': { DPD: 1, PACZKOMATY: 1 } } } })
    expect(znajdz(dwa, 'Zebrane')!.dzieci.map((d) => d.etykieta)).toEqual(['Paczkomaty', 'DPD'])
  })

  it('„Ustaw statusy” tylko dla osoby z ustawieniami, jako pozycja pomocnicza', () => {
    expect(p.at(-1)).toMatchObject({ href: '/ustawienia/statusy', pomocniczy: true })
    expect(pozycjeStatusow(l).some((x) => x.pomocniczy)).toBe(false)
    // firma bez statusów własnych (stare grupy rdzenia) też dostaje link
    expect(pozycjeStatusow(zlozLiczniki(wiersze, 0), { ustawienia: true }).at(-1)!.href).toBe('/ustawienia/statusy')
  })

  it('neutralny zestaw nowej firmy (DOMYSLNE_STATUSY): każdy etap ma pozycję, grupa „Zakończone” zwinięta', () => {
    const n = pozycjeStatusow(liczniki([...DOMYSLNE_STATUSY], [...DOMYSLNE_GRUPY_STATUSOW]))
    expect(n.map((x) => x.etykieta)).toEqual(['Wszystkie', 'Wymaga działania', 'Nowe', 'W realizacji', 'Gotowe do wysyłki', 'Zakończone', 'Problemowe'])
    expect(n.find((x) => x.etykieta === 'Zakończone')!.grupaStatusow!.zwinietaNaStart).toBe(true)
    expect(n.find((x) => x.etykieta === 'W realizacji')!.grupaStatusow!.zwinietaNaStart).toBe(false)
    // jeden status na etap, więc pod „Do realizacji” cała kolejka magazynu per przewoźnik (jak panel)
    expect(znajdz(n, 'Do realizacji')!.dzieci.map((d) => [d.etykieta, d.licznik])).toEqual([
      ['Paczkomaty', 3],
      ['DPD', 2],
      ['bez przewoźnika', 1],
    ])
    // każdy etap ma status firmy: nic „bez statusu firmy”
    expect(n.some((x) => x.naglowek)).toBe(false)
  })

  it('zaznaczenie po `sf` / `sg` / przewoźniku w adresie, „Ustaw statusy” się nie zaznacza', () => {
    const menu = zbudujMenu({ uprawnienia: new Set(['panel.podglad', 'ustawienia']), maBl: false, liczniki: { zamowienia: 6, braki: 0 }, statusyZamowien: p })
    const q = (s: string) => new URLSearchParams(s)
    expect(aktywnaPozycja(menu, '/zamowienia', q('widok=wszystkie&sf=DR_INNE&q=x'))).toBe('/zamowienia?widok=wszystkie&sf=DR_INNE')
    expect(aktywnaPozycja(menu, '/zamowienia', q('widok=wszystkie&sf=DR_INNE&przewoznik=DPD'))).toBe('/zamowienia?widok=wszystkie&sf=DR_INNE&przewoznik=DPD')
    expect(aktywnaPozycja(menu, '/zamowienia', q('widok=wszystkie&sg=DO_REALIZACJI'))).toBe('/zamowienia?widok=wszystkie&sg=DO_REALIZACJI')
    // jak filtryZ: sg ignorowane, gdy jest sf
    expect(aktywnaPozycja(menu, '/zamowienia', q('widok=wszystkie&sf=NOWE_Z&sg=DO_REALIZACJI'))).toBe('/zamowienia?widok=wszystkie&sf=NOWE_Z')
    expect(aktywnaPozycja(menu, '/zamowienia', q('widok=wszystkie'))).toBe('/zamowienia?widok=wszystkie')
    expect(aktywnaPozycja(menu, '/zamowienia', q('widok=wszystkie&sf=RDZEN:ZEBRANE'))).toBe('/zamowienia?widok=wszystkie&sf=RDZEN%3AZEBRANE')
    // ekran ustawień zaznacza w menu „Ustawienia” (zakładkę „Statusy zamówień” zaznacza kolumna działów); link „Ustaw statusy” dalej się nie zaznacza
    expect(aktywnaPozycja(menu, '/ustawienia/statusy')).toBe('/ustawienia')
  })

  it('przewoźnik w adresie bez dziecka w menu zaznacza status albo grupę, nie „Zamówienia”', () => {
    const menu = zbudujMenu({ uprawnienia: new Set(['panel.podglad', 'ustawienia']), maBl: false, liczniki: { zamowienia: 6, braki: 0 }, statusyZamowien: p })
    const q = (s: string) => new URLSearchParams(s)
    // status jednego przewoźnika (jak ACME „Do realizacji DPD”) + filtr „Przewoźnik” na liście
    expect(aktywnaPozycja(menu, '/zamowienia', q('widok=wszystkie&sf=DR_PACZ&przewoznik=PACZKOMATY'))).toBe('/zamowienia?widok=wszystkie&sf=DR_PACZ')
    expect(aktywnaPozycja(menu, '/zamowienia', q('widok=wszystkie&sf=DR_PACZ&przewoznik=DPD'))).toBe('/zamowienia?widok=wszystkie&sf=DR_PACZ')
    // grupa + przewoźnik
    expect(aktywnaPozycja(menu, '/zamowienia', q('widok=wszystkie&sg=ZAKONCZONE&przewoznik=DPD'))).toBe('/zamowienia?widok=wszystkie&sg=ZAKONCZONE')
    // przewoźnik schowany przez (Zebrane 2 = DPD 2) dalej zaznacza status
    expect(aktywnaPozycja(menu, '/zamowienia', q('widok=wszystkie&sf=RDZEN:ZEBRANE&przewoznik=DPD'))).toBe('/zamowienia?widok=wszystkie&sf=RDZEN%3AZEBRANE')
    // dziecko-przewoźnik wygrywa z rodzicem, gdy jest w menu
    expect(aktywnaPozycja(menu, '/zamowienia', q('widok=wszystkie&sf=DR_INNE&przewoznik=BRAK'))).toBe('/zamowienia?widok=wszystkie&sf=DR_INNE&przewoznik=BRAK')
  })

  it('grupa rdzenia z przewoźnikiem bez licznika zaznacza grupę', () => {
    const rdzen = pozycjeStatusow(zlozLiczniki(wiersze, 6))
    const menu = zbudujMenu({ uprawnienia: new Set(['panel.podglad']), maBl: false, liczniki: { zamowienia: 6, braki: 0 }, statusyZamowien: rdzen })
    const q = (s: string) => new URLSearchParams(s)
    expect(aktywnaPozycja(menu, '/zamowienia', q('widok=do_realizacji&przewoznik=INPOST_KURIER'))).toBe('/zamowienia?widok=do_realizacji')
    expect(aktywnaPozycja(menu, '/zamowienia', q('widok=do_realizacji&przewoznik=DPD'))).toBe('/zamowienia?widok=do_realizacji&przewoznik=DPD')
    // inna ścieżka niż lista: pozycje-widoki się nie zaznaczają
    expect(aktywnaPozycja(menu, '/zamowienia/abc', q('widok=do_realizacji'))).toBe('/zamowienia')
  })

  it('nazwa statusu pod grupą bez prefiksu nazwy grupy', () => {
    expect(bezNazwyGrupy('Do realizacji Paczkomaty', 'Do realizacji')).toBe('Paczkomaty')
    expect(bezNazwyGrupy('do realizacji – DPD', 'Do realizacji')).toBe('DPD')
    expect(bezNazwyGrupy('Do realizacji: osobisty', 'Do realizacji')).toBe('Osobisty')
    expect(bezNazwyGrupy('Do realizacji', 'Do realizacji')).toBe('Do realizacji')
    expect(bezNazwyGrupy('Do realizacjii', 'Do realizacji')).toBe('Do realizacjii')
    expect(bezNazwyGrupy('Wysłane', 'Zakończone')).toBe('Wysłane')
  })

  it('tytuł listy: status albo grupa firmy z przewoźnikiem, inaczej widok', () => {
    expect(nazwaBiezacego(l, 'wszystkie', { sf: 'DR_INNE', przewoznik: 'DPD' })).toBe('Do realizacji · DPD')
    expect(nazwaBiezacego(l, 'wszystkie', { sg: 'ZAKONCZONE' })).toBe('Zakończone')
    expect(nazwaBiezacego(l, 'wszystkie', { sf: 'RDZEN:ZEBRANE' })).toBe('Zebrane')
    expect(nazwaBiezacego(l, 'do_realizacji', { przewoznik: 'DPD' })).toBe('Do realizacji · DPD')
    expect(nazwaBiezacego(zlozLiczniki(wiersze, 0), 'wymaga', {})).toBe('Wymaga działania')
    expect(adresStatusuFirmy({ sg: 'A' })).toBe('/zamowienia?widok=wszystkie&sg=A')
  })
})
