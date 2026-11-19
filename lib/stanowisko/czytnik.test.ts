// czytnik w oknie pakowania — które pola blokują bufor, szybki ciąg z Enterem, decyzja Esc.
import { describe, expect, it } from 'vitest'
import { krokCzytnika, poEsc, poleTekstowe, PUSTY_BUFOR, type BuforCzytnika } from './czytnik'

/** Czytnik: znaki co `odstep` ms i Enter; zwraca zeskanowany tekst albo null. */
function wpisz(tekst: string, odstep: number, cel: { tagName: string; type?: string } | null = null, start = 1000): string | null {
  let b: BuforCzytnika = PUSTY_BUFOR
  let t = start
  for (const key of tekst) {
    b = krokCzytnika(b, { key, teraz: t, wPoluTekstowym: poleTekstowe(cel) }).bufor
    t += odstep
  }
  return krokCzytnika(b, { key: 'Enter', teraz: t, wPoluTekstowym: poleTekstowe(cel) }).skan
}

describe('poleTekstowe', () => {
  it('checkbox, radio i przyciski nie są polem tekstowym; text, number, search i textarea są', () => {
    expect(poleTekstowe({ tagName: 'INPUT', type: 'checkbox' })).toBe(false)
    expect(poleTekstowe({ tagName: 'INPUT', type: 'radio' })).toBe(false)
    expect(poleTekstowe({ tagName: 'INPUT', type: 'button' })).toBe(false)
    expect(poleTekstowe({ tagName: 'INPUT', type: 'submit' })).toBe(false)
    expect(poleTekstowe({ tagName: 'BUTTON' })).toBe(false)
    expect(poleTekstowe({ tagName: 'BODY' })).toBe(false)
    expect(poleTekstowe(null)).toBe(false)
    expect(poleTekstowe({ tagName: 'INPUT', type: 'text' })).toBe(true)
    expect(poleTekstowe({ tagName: 'INPUT', type: 'number' })).toBe(true)
    expect(poleTekstowe({ tagName: 'INPUT', type: 'search' })).toBe(true)
    expect(poleTekstowe({ tagName: 'INPUT' })).toBe(true)
    expect(poleTekstowe({ tagName: 'TEXTAREA' })).toBe(true)
  })
})

describe('krokCzytnika', () => {
  it('skan z fokusem na checkboksie „Przeczytane i zrobione” trafia do bufora', () => {
    expect(wpisz('SD48213/1', 8, { tagName: 'INPUT', type: 'checkbox' })).toBe('SD48213/1')
    expect(wpisz('SD48213/1', 8, { tagName: 'BUTTON' })).toBe('SD48213/1')
    expect(wpisz('SD48213/1', 8)).toBe('SD48213/1')
  })

  it('fokus w polu tekstowym: znaki należą do pola, Enter nie skanuje', () => {
    expect(wpisz('SD48213/1', 8, { tagName: 'INPUT', type: 'text' })).toBeNull()
    expect(wpisz('SD48213/1', 8, { tagName: 'TEXTAREA' })).toBeNull()
  })

  it('człowiek pisze wolno albo za krótko: bez skanu; Ctrl/Alt i klawisze specjalne pomijane', () => {
    expect(wpisz('SD48213/1', 150)).toBeNull()
    expect(wpisz('SD4', 8)).toBeNull()
    let b = krokCzytnika(PUSTY_BUFOR, { key: 'K', teraz: 0, wPoluTekstowym: false }).bufor
    b = krokCzytnika(b, { key: 'c', ctrlKey: true, teraz: 5, wPoluTekstowym: false }).bufor
    b = krokCzytnika(b, { key: 'Shift', teraz: 10, wPoluTekstowym: false }).bufor
    expect(b.t).toBe('K')
  })

  it('Enter czyści bufor', () => {
    let b = PUSTY_BUFOR
    for (const [i, key] of [...'ABCDE'].entries()) b = krokCzytnika(b, { key, teraz: i * 5, wPoluTekstowym: false }).bufor
    const k = krokCzytnika(b, { key: 'Enter', teraz: 30, wPoluTekstowym: false })
    expect(k.skan).toBe('ABCDE')
    expect(k.bufor).toEqual(PUSTY_BUFOR)
  })
})

describe('poEsc', () => {
  it('najpierw okienko, potem gabaryt, na końcu zamknięcie okna', () => {
    expect(poEsc({ dialog: { etap: 'wyczysc' }, krok: 'gabaryt' })).toBe('dialog')
    expect(poEsc({ dialog: null, krok: 'gabaryt' })).toBe('gabaryt')
    expect(poEsc({ dialog: null, krok: 'pozycje' })).toBe('zamknij')
    expect(poEsc({ dialog: null, krok: 'zapisane' })).toBe('zamknij')
    expect(poEsc(null)).toBe('zamknij')
    // po przejściu do następnego zamówienia Esc najpierw cofa przejście, otwarte okienko ma pierwszeństwo
    expect(poEsc({ dialog: null, krok: 'pozycje' }, true)).toBe('zostan')
    expect(poEsc({ dialog: { etap: 'wyczysc' }, krok: 'pozycje' }, true)).toBe('dialog')
  })
  it('nakładka: spóźniony Esc zamyka samo zamówienie, nakładkę dopiero drugi Esc z listy albo z podsumowania', () => {
    expect(poEsc({ dialog: null, krok: 'pozycje' }, false, true)).toBe('lista')
    expect(poEsc({ dialog: null, krok: 'zapisane' }, false, true)).toBe('lista')
    expect(poEsc({ dialog: null, krok: 'podsumowanie' }, false, true)).toBe('zamknij')
    expect(poEsc(null, false, true)).toBe('zamknij')
    expect(poEsc({ dialog: null, krok: 'pozycje' }, true, true)).toBe('zostan')
    expect(poEsc({ dialog: null, krok: 'gabaryt' }, false, true)).toBe('gabaryt')
  })
})
