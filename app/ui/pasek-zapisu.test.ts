// pasek zapisu z `ukryjBezZmian` (karta zamówienia) — ukryty bez zmian, widoczny po zmianie i w trakcie
// zapisu, znika po zapisie i po „Anuluj”; formularze bez flagi (ustawienia, produkt) mają pasek widoczny jak dotąd.
// Render na serwerze (środowisko testów bez DOM); zachowanie w przeglądarce sprawdzało się zrzutami ekranu
// (pomiar widoczności przed zmianą, po zmianie i po „Anuluj”).
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PasekZapisu, pasekWidoczny } from './pasek-zapisu'

describe('PasekZapisu: pokaż dopiero po zmianie', () => {
  it('z flagą: ukryty bez zmian, widoczny po zmianie i w trakcie zapisu, znika po zapisie albo „Anuluj”', () => {
    // wczytanie formularza: nic nie zmienione
    expect(pasekWidoczny({ zmiany: false, trwa: false, ukryjBezZmian: true })).toBe(false)
    // zmiana ilości / „usuń” / decyzja o braku
    expect(pasekWidoczny({ zmiany: true, trwa: false, ukryjBezZmian: true })).toBe(true)
    // zapis w toku: pasek zostaje („Zapisywanie…”)
    expect(pasekWidoczny({ zmiany: true, trwa: true, ukryjBezZmian: true })).toBe(true)
    expect(pasekWidoczny({ zmiany: false, trwa: true, ukryjBezZmian: true })).toBe(true)
    // po zapisie (albo „Anuluj”, reset formularza) zmian już nie ma
    expect(pasekWidoczny({ zmiany: false, trwa: false, ukryjBezZmian: true })).toBe(false)
  })

  it('bez flagi (ustawienia, produkt) i przy formularzu do wypełnienia pasek widoczny zawsze, jak dotąd', () => {
    for (const zmiany of [false, true]) for (const trwa of [false, true]) expect(pasekWidoczny({ zmiany, trwa })).toBe(true)
    expect(pasekWidoczny({ zmiany: false, trwa: false, ukryjBezZmian: true, zawszeAktywny: true })).toBe(true)
  })

  it('render: z flagą pasek startuje ukryty (przyciski z hidden, status zostaje w DOM), bez flagi widoczny', () => {
    const ukryty = renderToStaticMarkup(h('form', null, h(PasekZapisu, { zapisz: 'Zapisz pozycje', ukryjBezZmian: true })))
    expect(ukryty).toMatch(/<div class="ui-pasek-zapisu" data-zmiany="nie" data-ukryty="">/)
    expect(ukryty).toContain('<span class="ui-pasek-zapisu-stan" role="status">Brak zmian do zapisania.</span>')
    expect(ukryty).toMatch(/<div class="ui-pasek-zapisu-akcje" hidden="">/)
    expect(ukryty).toContain('Zapisz pozycje')
    const zwykly = renderToStaticMarkup(h('form', null, h(PasekZapisu, { opis: 'Zmień ustawienia i zapisz.' })))
    expect(zwykly).toContain('<div class="ui-pasek-zapisu" data-zmiany="nie">')
    expect(zwykly).not.toContain('hidden')
    expect(zwykly).toContain('Zmień ustawienia i zapisz.')
  })

  it('„Anuluj” z anulujHref to link do trybu odczytu, aktywny także bez zmian', () => {
    const html = renderToStaticMarkup(h('form', null, h(PasekZapisu, { zapisz: 'Zapisz pozycje', anulujHref: '/zamowienia/o1#pozycje' })))
    expect(html).toMatch(/<a class="btn[^"]*" href="\/zamowienia\/o1#pozycje">Anuluj<\/a>/)
    expect(html).not.toMatch(/<button[^>]*>Anuluj/)
  })
})
