// render komponentów app/ui na serwerze (bez przeglądarki): API i dostępność, na których opierają się
// kolejne paczki. Zachowanie w przeglądarce (toast, modal, pasek zapisu) sprawdzają zrzuty i przegląd na stosie demo.
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }), usePathname: () => '/ustawienia/przewoznicy' }))

const ui = await import('./index')

const html = (el: ReturnType<typeof h>) => renderToStaticMarkup(el)

describe('komponenty app/ui', () => {
  it('Przycisk: warianty na klasach .btn, wyłączony z powodem zostaje w kolejności Tab i mówi czemu', () => {
    expect(html(h(ui.Przycisk, { wariant: 'glowny', children: 'Zapisz' }))).toBe('<button type="button" class="btn primary">Zapisz</button>')
    const zPowodem = html(h(ui.Przycisk, { wariant: 'glowny', type: 'submit', powodWylaczenia: 'Konto kurierskie wyłączone', children: 'Nadaj paczki' }))
    expect(zPowodem).toContain('aria-disabled="true"')
    expect(zPowodem).toContain('type="button"') // nie wyśle formularza
    expect(zPowodem).toContain('title="Konto kurierskie wyłączone"')
    expect(zPowodem).not.toContain(' disabled=""')
    expect(html(h(ui.Przycisk, { ladowanie: true, children: 'Zapisz' }))).toContain('aria-busy="true"')
  })

  it('StatusZamowienia: jeden wygląd (odznaka z kropką i tonem), przewoźnik obok, „bez przewoźnika” pominięty', () => {
    const s = html(h(ui.StatusZamowienia, { status: 'DO_REALIZACJI', przewoznik: 'DPD' }))
    expect(s).toContain('class="ui-odznaka ui-kropka" data-ton="ostrzezenie"')
    expect(s).toContain('Do realizacji')
    expect(s).toContain('<span class="ui-status-c">DPD</span>')
    expect(html(h(ui.StatusZamowienia, { status: 'NOWE', przewoznik: 'BRAK' }))).not.toContain('ui-status-c')
  })

  it('TrybKanalu bez żargonu', () => {
    expect(html(h(ui.TrybKanalu, { tryb: 'CIEN' }))).toContain('Tylko podgląd')
    expect(html(h(ui.TrybKanalu, { tryb: 'PRACA' }))).toContain('Aktywny')
  })

  it('Pole: etykieta połączona z polem, opis i błąd przez aria-describedby, aria-invalid przy błędzie', () => {
    const p = html(h(ui.PoleTekstowe, { id: 'nazwa', name: 'nazwa', etykieta: 'Nazwa', pomoc: 'Widać ją na liście', blad: 'Wpisz nazwę', opcjonalne: true }))
    expect(p).toContain('<label for="nazwa">Nazwa<span class="ui-opcjonalne"> (opcjonalne)</span></label>')
    expect(p).toContain('aria-describedby="nazwa-pomoc nazwa-blad"')
    expect(p).toContain('aria-invalid="true"')
    expect(p).toContain('id="nazwa-blad" role="alert"')
    expect(html(h(ui.PoleLiczbowe, { id: 'dni', etykieta: 'Okres', jednostka: 'dni' }))).toContain('<span aria-hidden="true">dni</span>')
  })

  it('Karta zwijana to <details>, NaglowekStrony ma h1 i akcje', () => {
    expect(html(h(ui.Karta, { tytul: 'Zaawansowane', zwijana: true }, 'x'))).toMatch(/^<details class="card ui-karta ui-karta-zwijana">/)
    const n = html(h(ui.NaglowekStrony, { tytul: 'Przewoźnicy', podtytul: 'Godziny odbioru', akcje: h('a', { href: '/x' }, 'Dodaj') }))
    expect(n).toContain('<h1>Przewoźnicy</h1>')
    expect(n).toContain('<div class="actions"><a href="/x">Dodaj</a></div>')
  })

  it('Zakladki: bieżąca z aria-current, licznik', () => {
    const z = html(h(ui.Zakladki, { etykieta: 'Statusy', zakladki: [{ href: '/a', etykieta: 'Nowe', licznik: 3, aktywna: true }, { href: '/b', etykieta: 'Wysłane' }] }))
    expect(z).toContain('aria-current="page"')
    expect(z).toContain('<span class="cnt">3</span>')
    // lista <ul><li>, link zostaje linkiem (bez role="listitem" na <a>)
    expect(z).toContain('<ul class="tabs" role="list"><li><a aria-current="page" href="/a">')
    expect(z).not.toContain('role="listitem"')
  })

  it('Tabela: nagłówek sortowania jako link w adresie z aria-sort, etykiety kolumn na telefonie, pusty stan', () => {
    const t = html(
      h(ui.Tabela, {
        id: 'test',
        etykieta: 'Zamówienia',
        kolumny: [
          { klucz: 'nr', etykieta: 'Numer', sortowalna: true },
          { klucz: 'kwota', etykieta: 'Kwota', wyrownanie: 'prawo', ukrywalna: true },
        ],
        wiersze: [{ id: '1', komorki: { nr: 'SH 1', kwota: '10 zł' }, href: '/zamowienia/1' }],
        adres: { sciezka: '/zamowienia', parametry: { q: 'abc' } },
        sort: { klucz: 'nr', kierunek: 'rosnaco' },
        zaznaczanie: true,
        paginacja: { strona: 1, ile: 25, razem: 1 },
      }),
    )
    expect(t).toContain('aria-sort="ascending"')
    expect(t).toContain('href="/zamowienia?kier=malejaco&amp;q=abc&amp;sort=nr"')
    expect(t).toContain('data-label="Kwota"')
    expect(t).toContain('data-href="/zamowienia/1"')
    expect(t).toContain('Zaznacz wszystkie na tej stronie')
    expect(t).toContain('1–1 z 1')
    const pusta = html(h(ui.Tabela, { id: 'p', etykieta: 'x', kolumny: [], wiersze: [], pustyStan: h(ui.PustyStan, { tytul: 'Brak zamówień' }) }))
    expect(pusta).toContain('<h2>Brak zamówień</h2>')
  })

  it('NaglowekSortu i SortNaTelefonie (tabela pisana ręcznie): aria-sort tylko na aktywnej kolumnie, strzałka kierunku, link GET', () => {
    const aktywna = html(h('table', null, h('thead', null, h('tr', null, h(ui.NaglowekSortu, { etykieta: 'Dostępne', href: '/produkty?kier=malejaco&sort=dostepne', kierunek: 'rosnaco', className: 'right' })))))
    expect(aktywna).toContain('<th scope="col" class="right" aria-sort="ascending">')
    expect(aktywna).toContain('href="/produkty?kier=malejaco&amp;sort=dostepne"')
    expect(aktywna).toContain('▲')
    const malejaco = html(h('table', null, h('thead', null, h('tr', null, h(ui.NaglowekSortu, { etykieta: 'Dostępne', href: '/produkty', kierunek: 'malejaco' })))))
    expect(malejaco).toContain('aria-sort="descending"')
    expect(malejaco).toContain('▼')
    const nieaktywna = html(h('table', null, h('thead', null, h('tr', null, h(ui.NaglowekSortu, { etykieta: 'Oferty', href: '/produkty?sort=oferty' })))))
    expect(nieaktywna).not.toContain('aria-sort')
    expect(nieaktywna).toContain('↕')
    expect(ui.ariaSortu({ klucz: 'a', kierunek: 'malejaco' }, 'a')).toBe('descending')
    expect(ui.ariaSortu({ klucz: 'a', kierunek: 'malejaco' }, 'b')).toBeUndefined()
    const tel = html(
      h(ui.SortNaTelefonie, {
        opcje: [
          { klucz: 'produkt', etykieta: 'Produkt', href: '/produkty?sort=produkt&kier=malejaco' },
          { klucz: 'dostepne', etykieta: 'Dostępne', href: '/produkty?kier=malejaco&sort=dostepne', kierunek: 'rosnaco' },
        ],
      }),
    )
    expect(tel).toContain('class="ui-sort-tel"')
    expect(tel).toContain('aria-current="true"')
    expect(tel).toContain(', rosnąco')
    expect((tel.match(/class="btn"/g) ?? []).length).toBe(2)
  })

  it('Potwierdzenie: fokus po otwarciu na „Tak”, przy wariancie niebezpiecznym na „Anuluj”', async () => {
    const zwykle = html(h(ui.Potwierdzenie, { otwarte: false, tytul: 'Wysłać?', tak: 'Tak, wyślij', onTak: () => {}, onNie: () => {} }))
    expect(zwykle).toContain('<button data-fokus="" type="button" class="btn primary">Tak, wyślij</button>')
    expect(zwykle).toContain('<button type="button" class="btn">Anuluj</button>')
    expect(zwykle).not.toContain('autofocus')
    const grozne = html(h(ui.Potwierdzenie, { otwarte: false, tytul: 'Usunąć?', tak: 'Usuń', wariant: 'niebezpieczny', onTak: () => {}, onNie: () => {} }))
    expect(grozne).toContain('<button data-fokus="" type="button" class="btn">Anuluj</button>')
    expect(grozne).toContain('<button type="button" class="btn danger">Usuń</button>')
    const { fokusPoOtwarciu } = await import('./modal')
    const focus = vi.fn()
    const zapytania: string[] = []
    fokusPoOtwarciu({ querySelector: (sel: string) => (zapytania.push(sel), { focus }) } as unknown as ParentNode)
    expect(zapytania).toEqual(['[data-fokus]'])
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('PasekFiltrow: każdy pasek ma własne id pól, aria-controls wskazuje na nie', () => {
    const dwa = html(h('div', null, h(ui.PasekFiltrow, { akcja: '/a' }, h('select', { name: 'x' })), h(ui.PasekFiltrow, { akcja: '/b' }, h('select', { name: 'y' }))))
    const id = [...dwa.matchAll(/class="ui-filtry-pola" id="([^"]+)"/g)].map((m) => m[1])
    expect(id).toHaveLength(2)
    expect(id[0]).not.toBe(id[1])
    for (const i of id) expect(dwa).toContain(`aria-controls="${i}"`)
    expect(dwa).not.toContain('id="ui-filtry-pola"')
  })

  it('PasekZapisu: przyciski z komponentu Przycisk, przy zapisie kręciołek i aria-busy z `ladowanie`', () => {
    const spoczynek = html(h(ui.PasekZapisu, {}))
    expect(spoczynek).toContain('<button type="button" class="btn" disabled="">Anuluj</button>')
    expect(spoczynek).toContain('<button type="submit" class="btn primary" disabled="">Zapisz zmiany</button>')
    const trwa = html(h(ui.PasekZapisu, { oczekuje: true }))
    expect(trwa).toContain('aria-busy="true"')
    expect(trwa).toContain('<span class="ui-kreciol" aria-hidden="true"></span>Zapisz zmiany')
    expect(trwa).toContain('Zapisywanie…')
  })
})
