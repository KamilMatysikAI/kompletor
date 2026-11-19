import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ALL_PERMISSIONS, permissionsOf } from '@/lib/auth/uprawnienia'
import { adresyWDrzewie, aktywnaPozycja, DZIALY_USTAWIEN, dzialDla, dzialyUstawien, NAWIGACJA, okruszki, okruszkiPaska, pierwszyAdresUstawien, wezelDla, zbudujMenu } from './nawigacja'
import { maZakazaneSlowo } from './slownik'

const PANEL = join(process.cwd(), 'app', '(panel)')

/** Trasy ekranów panelu z plików `page.tsx` (`[id]` zostaje jako segment dynamiczny). */
function trasyEkranow(dir = PANEL): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...trasyEkranow(p))
    else if (name === 'page.tsx') {
      const rel = relative(PANEL, dir).split(sep).filter((s) => s && !s.startsWith('('))
      out.push(`/${rel.join('/')}`)
    }
  }
  return out
}

const WSZYSTKO = new Set<string>(ALL_PERMISSIONS)
const liczniki = { zamowienia: 3, braki: 2 }

describe('drzewo nawigacji', () => {
  it('każdy statyczny ekran panelu ma własny węzeł w drzewie, dynamiczny leży pod węzłem rodzica', () => {
    const adresy = new Set(adresyWDrzewie())
    const bezWezla: string[] = []
    for (const t of trasyEkranow()) {
      if (t === '/') continue
      if (t.includes('[')) {
        if (!wezelDla(t.replace(/\[[^\]]+\]/g, 'x'))) bezWezla.push(t)
      } else if (!adresy.has(t)) bezWezla.push(t)
    }
    expect(bezWezla).toEqual([])
  })

  it('okruszki z drzewa: Przewoźnicy prowadzą do Ustawień, karta zamówienia do Zamówień, ekrany główne bez okruszków', () => {
    expect(okruszki('/ustawienia/przewoznicy')).toEqual([{ href: '/ustawienia', etykieta: 'Ustawienia' }])
    expect(okruszki('/ustawienia/kanaly/allegro')).toEqual([
      { href: '/ustawienia', etykieta: 'Ustawienia' },
      { href: '/ustawienia/kanaly', etykieta: 'Kanały sprzedaży' },
    ])
    expect(okruszki('/zamowienia/abc')).toEqual([{ href: '/zamowienia', etykieta: 'Zamówienia' }])
    expect(okruszki('/produkty/bez-stanu')).toEqual([{ href: '/produkty', etykieta: 'Produkty' }])
    expect(okruszki('/pomoc/instalacja')).toEqual([{ href: '/pomoc', etykieta: 'Pomoc' }])
    expect(okruszki('/pulpit')).toEqual([])
    expect(okruszki('/zamowienia')).toEqual([])
    expect(okruszki('/nie-ma-takiego')).toEqual([])
  })

  it('sekcja „Przejście z BaseLinkera” tylko dla firmy z BL', () => {
    const bez = zbudujMenu({ uprawnienia: WSZYSTKO, maBl: false, liczniki })
    const z = zbudujMenu({ uprawnienia: WSZYSTKO, maBl: true, liczniki })
    expect(bez.map((s) => s.sekcja)).toEqual(['start', 'zamowienia', 'magazyn', 'finanse', 'ustawienia'])
    const bl = z.find((s) => s.sekcja === 'bl')!
    expect(bl.tytul).toBe('Przejście z BaseLinkera')
    expect(bl.pozycje.map((p) => p.href)).toEqual(['/ustawienia/przeprowadzka', '/rozjazdy', '/akcje'])
  })

  it('pozycje wg uprawnień: magazyn bez ustawień firmy ma „Ustawienia” bez podpozycji (działy w drugiej kolumnie)', () => {
    const menu = zbudujMenu({ uprawnienia: new Set(['panel.podglad']), maBl: true, liczniki })
    const ust = menu.find((s) => s.sekcja === 'ustawienia')!.pozycje[0]!
    expect(ust.dzieci).toEqual([])
    expect(dzialyUstawien({ uprawnienia: new Set(['panel.podglad']), maBl: true }).map((d) => [d.klucz, d.zakladki.map((z) => z.href)])).toEqual([['zespol', ['/ustawienia/haslo']]])
    // bez `rozjazdy.podglad` i `ustawienia` z sekcji BL zostają tylko maile do klientów
    expect(menu.find((s) => s.sekcja === 'bl')!.pozycje.map((p) => p.href)).toEqual(['/akcje'])
    // „Dodaj produkt” to ekran pomocniczy: okruszki tak, pozycja w menu nie
    const prod = menu.find((s) => s.sekcja === 'magazyn')!.pozycje.find((p) => p.href === '/produkty')!
    expect(prod.dzieci).toEqual([])
    // Raporty (przychód, marża) tylko z `raporty.sprzedaz`; w sekcji „Finanse”
    const praca = (u: Set<string>) => zbudujMenu({ uprawnienia: u, maBl: false, liczniki }).flatMap((s) => (s.sekcja === 'finanse' ? s.pozycje.map((p) => p.href) : []))
    expect(praca(new Set(['panel.podglad']))).not.toContain('/raporty')
    expect(praca(new Set(['panel.podglad', 'raporty.sprzedaz']))).toContain('/raporty')
  })

  it('liczniki szare (czerwień tylko dla rzeczy po terminie), zero bez licznika', () => {
    const menu = zbudujMenu({ uprawnienia: WSZYSTKO, maBl: false, liczniki: { zamowienia: 0, braki: 5 } })
    const pozycje = menu.flatMap((s) => s.pozycje)
    expect(pozycje.find((p) => p.href === '/zamowienia')!.licznik).toBeUndefined()
    expect(pozycje.find((p) => p.href === '/braki')).toMatchObject({ licznik: 5, licznikTon: 'neutralny' })
  })

  it('grupy menu w kolejności, z nagłówkami ze słownika i ikonami przy pozycjach głównych', () => {
    const menu = zbudujMenu({ uprawnienia: WSZYSTKO, maBl: true, liczniki })
    expect(menu.map((s) => [s.sekcja, s.tytul ?? null, s.pozycje.map((p) => p.href)])).toEqual([
      ['start', null, ['/pulpit']],
      ['zamowienia', 'Realizacja', ['/zamowienia', '/pakowanie', '/przesylki', '/zwroty']],
      ['magazyn', 'Towar', ['/produkty', '/braki']],
      ['finanse', 'Finanse', ['/faktury', '/raporty']],
      ['bl', 'Przejście z BaseLinkera', ['/ustawienia/przeprowadzka', '/rozjazdy', '/akcje']],
      ['ustawienia', null, ['/ustawienia', '/pomoc']],
    ])
    expect(menu.flatMap((s) => s.pozycje).filter((p) => !p.ikona)).toEqual([])
  })

  it('statusy zamówień jako podpozycje „Zamówienia” (zamiast „Dodaj zamówienie”, które zostaje tylko w okruszkach)', () => {
    const statusy = [{ href: '/zamowienia?widok=nowe', etykieta: 'Nowe', licznik: 4, widok: { widok: 'nowe' }, kropka: 'info' as const, dzieci: [] }]
    const menu = zbudujMenu({ uprawnienia: WSZYSTKO, maBl: false, liczniki, statusyZamowien: statusy })
    expect(menu.flatMap((s) => s.pozycje).find((p) => p.href === '/zamowienia')!.dzieci).toEqual(statusy)
    expect(okruszki('/zamowienia/nowe')).toEqual([{ href: '/zamowienia', etykieta: 'Zamówienia' }])
  })

  // Lista pozycji widocznych dla roli przepisana z menu (origin/main 28710c4, porównanie skryptem
  // starego i nowego `zbudujMenu` dla wszystkich ról): rama zmienia wygląd, nie to, kto co widzi. Po rebase na
  // doszła pozycja `/ustawienia/statusy` (Ustawienia → Statusy zamówień), nie z ramy. Po scaleniu
  // doszła pozycja `/raporty` dla ról z `raporty.sprzedaz` (domyślnie Właściciel i Biuro), a
  // `/przesylki` (lista przesyłek, bez osobnego uprawnienia, jak „Pakowanie”); `/ustawienia/automaty`.
  // doszła `/pomoc` (Pomoc na dole menu dla każdej roli; ekran i tak był dostępny z menu konta).
  // ekrany ustawień zeszły z menu bocznego do drugiej kolumny ustawień (kto co widzi: test działów niżej).
  it.each([
    ['WLASCICIEL', false, ['/braki', '/faktury', '/pakowanie', '/pomoc', '/produkty', '/produkty/bez-stanu', '/przesylki', '/pulpit', '/raporty', '/ustawienia', '/zamowienia', '/zwroty']],
    ['BIURO', true, ['/akcje', '/braki', '/faktury', '/pakowanie', '/pomoc', '/produkty', '/przesylki', '/pulpit', '/raporty', '/rozjazdy', '/ustawienia', '/zamowienia', '/zwroty']],
    ['MAGAZYN', true, ['/akcje', '/braki', '/pakowanie', '/pomoc', '/produkty', '/przesylki', '/pulpit', '/ustawienia', '/zamowienia', '/zwroty']],
    ['MAGAZYN', false, ['/braki', '/pakowanie', '/pomoc', '/produkty', '/przesylki', '/pulpit', '/ustawienia', '/zamowienia', '/zwroty']],
  ] as const)('rola %s (BL: %s) widzi te same pozycje co przed przebudową ramy', (rola, maBl, oczekiwane) => {
    const menu = zbudujMenu({ uprawnienia: permissionsOf({ role: rola, permissions: [], deniedPermissions: [] }), maBl, liczniki })
    const hrefy: string[] = []
    const v = (p: { href: string; widok?: unknown; dzieci: { href: string; dzieci: unknown[] }[] }) => {
      if (!p.widok) hrefy.push(p.href)
      p.dzieci.forEach((d) => v(d as never))
    }
    menu.forEach((s) => s.pozycje.forEach(v))
    expect(hrefy.sort()).toEqual([...oczekiwane])
  })

  it('okruszki paska: bieżący ekran na końcu, na karcie rekordu ostatni okruszek jest linkiem powrotu', () => {
    expect(okruszkiPaska('/pulpit')).toEqual({ lancuch: [], biezacy: 'Pulpit' })
    expect(okruszkiPaska('/ustawienia/przewoznicy')).toEqual({ lancuch: [{ href: '/ustawienia', etykieta: 'Ustawienia' }], biezacy: 'Przewoźnicy' })
    expect(okruszkiPaska('/zamowienia/abc')).toEqual({ lancuch: [{ href: '/zamowienia', etykieta: 'Zamówienia' }], biezacy: null })
    expect(okruszkiPaska('/nie-ma')).toEqual({ lancuch: [], biezacy: null })
  })

  it('aktywna pozycja statusu po parametrach adresu; brak widoku = „Wszystkie”, stary widok zaznacza „Zamówienia”', () => {
    const statusy = [
      { href: '/zamowienia?widok=wszystkie', etykieta: 'Wszystkie', widok: { widok: 'wszystkie' }, dzieci: [] },
      { href: '/zamowienia?widok=wymaga', etykieta: 'Wymaga działania', widok: { widok: 'wymaga' }, dzieci: [] },
      {
        href: '/zamowienia?widok=do_realizacji',
        etykieta: 'Do realizacji',
        widok: { widok: 'do_realizacji' },
        dzieci: [{ href: '/zamowienia?widok=do_realizacji&przewoznik=DPD', etykieta: 'DPD', widok: { widok: 'do_realizacji', przewoznik: 'DPD' }, dzieci: [] }],
      },
    ]
    const menu = zbudujMenu({ uprawnienia: WSZYSTKO, maBl: false, liczniki, statusyZamowien: statusy })
    const q = (s: string) => new URLSearchParams(s)
    expect(aktywnaPozycja(menu, '/zamowienia', q(''))).toBe('/zamowienia?widok=wszystkie')
    expect(aktywnaPozycja(menu, '/zamowienia', q('widok=wymaga'))).toBe('/zamowienia?widok=wymaga')
    expect(aktywnaPozycja(menu, '/zamowienia', q('widok=do_realizacji&q=abc'))).toBe('/zamowienia?widok=do_realizacji')
    expect(aktywnaPozycja(menu, '/zamowienia', q('widok=do_realizacji&przewoznik=DPD'))).toBe('/zamowienia?widok=do_realizacji&przewoznik=DPD')
    expect(aktywnaPozycja(menu, '/zamowienia', q('widok=nieoplacone'))).toBe('/zamowienia')
    expect(aktywnaPozycja(menu, '/zamowienia/abc', q('widok=nowe'))).toBe('/zamowienia')
  })

  it('aktywna pozycja: najdłuższe dopasowanie (ekran bez stanu zaznacza siebie, nie Produkty)', () => {
    const menu = zbudujMenu({ uprawnienia: WSZYSTKO, maBl: true, liczniki })
    expect(aktywnaPozycja(menu, '/produkty/bez-stanu')).toBe('/produkty/bez-stanu')
    expect(aktywnaPozycja(menu, '/produkty/abc')).toBe('/produkty')
    expect(aktywnaPozycja(menu, '/ustawienia/przeprowadzka')).toBe('/ustawienia/przeprowadzka')
    // ekran ustawień zaznacza w menu „Ustawienia” (dział i zakładkę zaznacza druga kolumna)
    expect(aktywnaPozycja(menu, '/ustawienia/kanaly/allegro')).toBe('/ustawienia')
  })

  it('nazwy w menu bez żargonu wdrożenia (słownik UI)', () => {
    const nazwy: string[] = []
    const visit = (w: { etykieta: string; dzieci?: { etykieta: string }[] }) => {
      nazwy.push(w.etykieta)
      w.dzieci?.forEach(visit)
    }
    NAWIGACJA.forEach((s) => {
      if (s.tytul) nazwy.push(s.tytul)
      s.wezly.forEach(visit)
    })
    expect(nazwy.filter((n) => maZakazaneSlowo(n))).toEqual([])
  })

describe('działy ustawień', () => {
  // Adresy ekranów ustawień z menu (origin/main 2d33bf4: 17 pozycji menu + ekrany pomocnicze).
  // Każdy ma zostać osiągalny: plik ekranu jest, a adres leży w zakładce jakiegoś działu (konto kanału, „Dodaj sklep”
  // i konta przewoźników przez zakładkę rodzica).
  const STARE = [
    '/ustawienia/kanaly', '/ustawienia/kanaly/nowy', '/ustawienia/przewoznicy', '/ustawienia/przewoznicy/konta', '/ustawienia/rezerwacje',
    '/ustawienia/statusy', '/ustawienia/automaty', '/ustawienia/strefy', '/ustawienia/druk', '/ustawienia/firma', '/ustawienia/dokumenty',
    '/ustawienia/uzytkownicy', '/ustawienia/dane-klientow', '/ustawienia/powiadomienia', '/ustawienia/poczta', '/ustawienia/poczta/szablony',
    '/ustawienia/klucze-api', '/ustawienia/agenci-ai', '/ustawienia/haslo', '/ustawienia/przeprowadzka',
  ]
  const wlasciciel = dzialyUstawien({ uprawnienia: WSZYSTKO, maBl: true })

  it('każdy dawny adres ustawień ma ekran i leży w zakładce działu właściciela firmy z BL', () => {
    const ekrany = new Set(trasyEkranow())
    const zle = STARE.filter((a) => !ekrany.has(a) || !dzialDla(wlasciciel, a))
    expect(zle).toEqual([])
    // konto kanału (adres dynamiczny) zaznacza „Kanały sprzedaży”
    expect(dzialDla(wlasciciel, '/ustawienia/kanaly/woo-1')).toEqual({ dzial: 'sprzedaz', zakladka: '/ustawienia/kanaly' })
    expect(dzialDla(wlasciciel, '/ustawienia/poczta/szablony')).toEqual({ dzial: 'komunikacja', zakladka: '/ustawienia/poczta/szablony' })
  })

  it('każdy ekran pod /ustawienia (także nowy) należy do działu; nowa podstrona bez `dzial` w drzewie nie przejdzie', () => {
    const bez = trasyEkranow()
      .filter((t) => t.startsWith('/ustawienia/') && !t.startsWith('/ustawienia/dzial/'))
      .filter((t) => !dzialDla(wlasciciel, t.replace(/\[[^\]]+\]/g, 'x')))
    expect(bez).toEqual([])
  })

  it('kolejność i nazwy działów, zakładki w kolejności drzewa, Integracje na początku swojego działu', () => {
    expect(wlasciciel.map((d) => d.nazwa)).toEqual(['Sprzedaż i kanały', 'Magazyn i strefy', 'Wysyłka i druk', 'Dokumenty i faktury', 'Komunikacja i poczta', 'Zespół i dostęp', 'Integracje i agenci AI', 'Przejście z BaseLinkera'])
    expect(Object.fromEntries(wlasciciel.map((d) => [d.klucz, d.zakladki.map((z) => z.href)]))).toEqual({
      sprzedaz: ['/ustawienia/kanaly', '/ustawienia/statusy', '/ustawienia/automaty'],
      magazyn: ['/ustawienia/strefy', '/ustawienia/rezerwacje'],
      wysylka: ['/ustawienia/przewoznicy', '/ustawienia/druk'],
      dokumenty: ['/ustawienia/firma', '/ustawienia/dokumenty'],
      komunikacja: ['/ustawienia/poczta', '/ustawienia/poczta/szablony', '/ustawienia/powiadomienia'],
      zespol: ['/ustawienia/uzytkownicy', '/ustawienia/dane-klientow', '/ustawienia/haslo'],
      integracje: ['/ustawienia/integracje', '/ustawienia/klucze-api', '/ustawienia/agenci-ai'],
      bl: ['/ustawienia/przeprowadzka'],
    })
    expect(wlasciciel.every((d) => d.href === d.zakladki[0]!.href)).toBe(true)
    expect(DZIALY_USTAWIEN.map((d) => d.nazwa).filter((n) => maZakazaneSlowo(n))).toEqual([])
  })

  it('działy wg uprawnień i BL; /ustawienia prowadzi do pierwszego widocznego działu', () => {
    expect(dzialyUstawien({ uprawnienia: WSZYSTKO, maBl: false }).map((d) => d.klucz)).not.toContain('bl')
    const kadry = new Set(['panel.podglad', 'uzytkownicy'])
    expect(dzialyUstawien({ uprawnienia: kadry, maBl: true }).map((d) => [d.klucz, d.zakladki.map((z) => z.href)])).toEqual([['zespol', ['/ustawienia/uzytkownicy', '/ustawienia/haslo']]])
    expect(pierwszyAdresUstawien({ uprawnienia: WSZYSTKO, maBl: false })).toBe('/ustawienia/kanaly')
    expect(pierwszyAdresUstawien({ uprawnienia: kadry, maBl: false })).toBe('/ustawienia/uzytkownicy')
    expect(pierwszyAdresUstawien({ uprawnienia: new Set(['panel.podglad']), maBl: false })).toBe('/ustawienia/haslo')
    for (const r of ['BIURO', 'MAGAZYN'] as const) expect(pierwszyAdresUstawien({ uprawnienia: permissionsOf({ role: r, permissions: [], deniedPermissions: [] }), maBl: true })).toBe('/ustawienia/haslo')
  })

  it('adres spoza działów (np. nieznany ekran) nie ma działu', () => {
    expect(dzialDla(wlasciciel, '/ustawienia/nie-ma')).toBeNull()
    expect(dzialDla(wlasciciel, '/zamowienia')).toBeNull()
  })
})
})
