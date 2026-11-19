// gdzie ekran panelu łapie czytnik i wklejenie, a gdzie zostawia znaki polu.
import { describe, expect, it } from 'vitest'
import { krokCzytnika, PUSTY_BUFOR, type BuforCzytnika } from './czytnik'
import { decyzjaWklejenia, przechwytujKlawisze, wklejenieDoSzukania } from './czytnik-panelu'

const BODY = { tagName: 'BODY' }
const WIERSZ = { tagName: 'TR' }

describe('przechwytujKlawisze', () => {
  it('fokus poza polami: tak; pole tekstowe, data, notatka, lista wyboru, contenteditable: nie', () => {
    expect(przechwytujKlawisze(null, false)).toBe(true)
    expect(przechwytujKlawisze(BODY, false)).toBe(true)
    expect(przechwytujKlawisze(WIERSZ, false)).toBe(true)
    expect(przechwytujKlawisze({ tagName: 'INPUT', type: 'checkbox' }, false)).toBe(true)
    expect(przechwytujKlawisze({ tagName: 'INPUT', type: 'search' }, false)).toBe(false)
    expect(przechwytujKlawisze({ tagName: 'INPUT', type: 'date' }, false)).toBe(false)
    expect(przechwytujKlawisze({ tagName: 'TEXTAREA' }, false)).toBe(false)
    expect(przechwytujKlawisze({ tagName: 'SELECT' }, false)).toBe(false)
    expect(przechwytujKlawisze({ tagName: 'DIV', edytowalny: true }, false)).toBe(false)
  })
  it('otwarte okno dialogowe albo fokus w nim: nie', () => {
    expect(przechwytujKlawisze(BODY, true)).toBe(false)
    expect(przechwytujKlawisze({ tagName: 'BUTTON', wDialogu: true }, false)).toBe(false)
  })
})

describe('decyzjaWklejenia', () => {
  it('pole „Szukaj” listy, poza polami, inne pola i okno dialogowe', () => {
    expect(decyzjaWklejenia({ tagName: 'INPUT', type: 'search', poleSzukania: true }, false)).toBe('pole_szukania')
    expect(decyzjaWklejenia(BODY, false)).toBe('poza')
    expect(decyzjaWklejenia(WIERSZ, false)).toBe('poza')
    expect(decyzjaWklejenia({ tagName: 'INPUT', type: 'date' }, false)).toBe('pomin')
    expect(decyzjaWklejenia({ tagName: 'TEXTAREA' }, false)).toBe('pomin')
    expect(decyzjaWklejenia(BODY, true)).toBe('pomin')
    expect(decyzjaWklejenia({ tagName: 'INPUT', type: 'search', poleSzukania: true, wDialogu: true }, false)).toBe('pomin')
  })
})

/** Ciąg klawiszy z odstępem `ms` między znakami, na końcu Enter; `wPolu` = fokus w polu tekstowym. */
function wpisz(tekst: string, ms: number, o: { ctrl?: boolean; wPolu?: boolean } = {}): string | null {
  let b: BuforCzytnika = PUSTY_BUFOR
  let t = 1000
  for (const key of tekst) {
    b = krokCzytnika(b, { key, ctrlKey: o.ctrl, teraz: (t += ms), wPoluTekstowym: !!o.wPolu }).bufor
  }
  return krokCzytnika(b, { key: 'Enter', teraz: (t += ms), wPoluTekstowym: !!o.wPolu }).skan
}

describe('skan na ekranie listy: czytnik tak, człowiek nie', () => {
  it('czytnik (10 ms na znak) daje skan', () => {
    expect(wpisz('SD48213/1', 10)).toBe('SD48213/1')
    expect(wpisz('602000000000000000000017', 5)).toBe('602000000000000000000017')
  })
  it('zwykłe pisanie (150 ms na znak), skróty z Ctrl i krótkie ciągi nie dają skanu', () => {
    expect(wpisz('48213', 150)).toBeNull()
    expect(wpisz('abcd', 10, { ctrl: true })).toBeNull()
    expect(wpisz('ab', 5)).toBeNull()
  })
  it('w polu tekstowym bufor nie rusza (Enter należy do formularza)', () => {
    expect(wpisz('SD48213/1', 10, { wPolu: true })).toBeNull()
  })
})

describe('stary bufor nie połyka późniejszego Entera', () => {
  it('Enter po przerwie dłuższej niż próg od ostatniego znaku nie jest skanem i czyści bufor', () => {
    let b: BuforCzytnika = PUSTY_BUFOR
    for (const [i, key] of [...'SD48213/1'].entries()) b = krokCzytnika(b, { key, teraz: 1000 + i * 5, wPoluTekstowym: false }).bufor
    const pozno = krokCzytnika(b, { key: 'Enter', teraz: 1040 + 5000, wPoluTekstowym: false })
    expect(pozno.skan).toBeNull()
    expect(pozno.bufor).toEqual(PUSTY_BUFOR)
    expect(krokCzytnika(b, { key: 'Enter', teraz: 1040 + 150, wPoluTekstowym: false }).skan).toBeNull()
  })
  it('Enter tuż po ostatnim znaku dalej kończy skan', () => {
    let b: BuforCzytnika = PUSTY_BUFOR
    for (const [i, key] of [...'SD48213/1'].entries()) b = krokCzytnika(b, { key, teraz: 1000 + i * 5, wPoluTekstowym: false }).bufor
    expect(krokCzytnika(b, { key: 'Enter', teraz: 1040 + 20, wPoluTekstowym: false }).skan).toBe('SD48213/1')
  })
})

describe('co z wklejenia bez trafienia idzie do „Szukaj”', () => {
  it('krótki tekst w jednej linii filtruje', () => {
    expect(wklejenieDoSzukania('  Produkt  testowy ')).toBe('Produkt testowy')
    expect(wklejenieDoSzukania('x'.repeat(40))).toBe('x'.repeat(40))
  })
  it('dłuższy niż 40 znaków albo kilka linii: nic nie idzie do wyszukiwarki', () => {
    expect(wklejenieDoSzukania('x'.repeat(41))).toBeNull()
    expect(wklejenieDoSzukania('Dzień dobry,\nproszę o fakturę')).toBeNull()
    expect(wklejenieDoSzukania('a\r\nb')).toBeNull()
    expect(wklejenieDoSzukania('   ')).toBeNull()
  })
})
