// przyciski „Co dalej” (czysta funkcja) i wyłącznik ekranów trybu PRACA. Bez bazy.
import { describe, expect, it } from 'vitest'
import type { OrderStatus } from '@prisma/client'
import { canTransition } from '@/lib/rdzen/statusy'
import { celAkcji, dostepnePrzejscia, type FaktyEkranu, numerNadania, type ZamowienieEkranu } from './przejscia-ekran'
import { ekranyPracaZEnv, pracaDostepna } from './wlacznik'

const BIURO = new Set(['panel.podglad', 'zamowienia.przejscia'])
const WSZYSTKO = new Set(['panel.podglad', 'zamowienia.przejscia', 'zamowienia.oznacz_oplacone', 'zamowienia.anuluj_po_fakturze'])

const zam = (status: OrderStatus, over: Partial<ZamowienieEkranu> = {}): ZamowienieEkranu => ({ status, carrier: 'PACZKOMATY', pendingAction: null, paymentState: 'PAID', kartaNieaktualna: false, ...over })
const TOWAR: FaktyEkranu = { aktywne: 1, wFakturze: 0, wydane: 0, uslugi: 0, otwarteBraki: 0, fakturaWystawiona: false, fakturaWToku: false, poFakturze: false }
const PO_FAKTURZE: FaktyEkranu = { ...TOWAR, aktywne: 0, wydane: 1, fakturaWystawiona: true, poFakturze: true }
const EBOOK: FaktyEkranu = { ...TOWAR, aktywne: 0, uslugi: 1 }

const akcje = (o: ZamowienieEkranu, f: FaktyEkranu, u: ReadonlySet<string> = WSZYSTKO) => dostepnePrzejscia(o, f, u).map((p) => `${p.akcja}${p.powod ? '!' : ''}`)

describe('dostepnePrzejscia: mapa statusów', () => {
  it.each<[string, ZamowienieEkranu, FaktyEkranu, string[]]>([
    ['nowe', zam('NOWE', { paymentState: 'UNPAID' }), TOWAR, ['oplacone', 'anuluj']],
    ['do realizacji, paczka', zam('DO_REALIZACJI'), TOWAR, ['zbieranie', 'spakuj', 'anuluj']],
    ['do realizacji, sam e-book', zam('DO_REALIZACJI', { carrier: 'BEZ_WYSYLKI' }), EBOOK, ['spakuj', 'anuluj']],
    ['W-3: mieszane, cały towar odrzucony, przewoźnik paczki', zam('DO_REALIZACJI'), EBOOK, ['spakuj', 'anuluj']],
    ['do realizacji, towar czeka na dostawę', zam('DO_REALIZACJI'), { ...TOWAR, aktywne: 0, otwarteBraki: 1 }, ['zbieranie!', 'spakuj!', 'anuluj']],
    ['zbieranie', zam('ZBIERANIE'), TOWAR, ['zebrane', 'spakuj', 'przerwij']],
    ['zebrane', zam('ZEBRANE'), TOWAR, ['spakuj']],
    ['spakowane przed fakturą', zam('SPAKOWANE'), TOWAR, ['wydanie!', 'bez_faktury', 'anuluj']],
    ['spakowane po fakturze', zam('SPAKOWANE'), PO_FAKTURZE, ['wydanie', 'anuluj']],
    ['spakowane bez towaru przed fakturą', zam('SPAKOWANE', { carrier: 'BEZ_WYSYLKI' }), EBOOK, ['odebrane_bez_wysylki!', 'anuluj']],
    ['spakowane bez towaru po fakturze', zam('SPAKOWANE', { carrier: 'BEZ_WYSYLKI' }), { ...EBOOK, fakturaWystawiona: true, poFakturze: true }, ['odebrane_bez_wysylki', 'anuluj']],
    ['do wysyłki', zam('DO_WYSLANIA'), PO_FAKTURZE, ['wyslane', 'anuluj']],
    ['do odbioru', zam('DO_ODBIORU', { carrier: 'OSOBISTY' }), PO_FAKTURZE, ['odebrane']],
    ['wysłane', zam('WYSLANE'), PO_FAKTURZE, ['odebrane']],
    ['do wyjaśnienia', zam('DO_WYJASNIENIA'), TOWAR, ['wyjasnione']],
    ['odebrane', zam('ODEBRANE'), PO_FAKTURZE, []],
    ['anulowane', zam('ANULOWANE'), TOWAR, []],
  ])('%s', (_n, o, f, want) => {
    expect(akcje(o, f)).toEqual(want)
  })

  it('anulowanie spakowanego i „do wysyłki” po fakturze tylko z osobnym uprawnieniem', () => {
    expect(akcje(zam('DO_WYSLANIA'), PO_FAKTURZE, BIURO)).toEqual(['wyslane', 'anuluj!'])
    expect(akcje(zam('SPAKOWANE'), PO_FAKTURZE, BIURO)).toEqual(['wydanie', 'anuluj!'])
    expect(akcje(zam('SPAKOWANE'), TOWAR, BIURO)).toEqual(['wydanie!', 'bez_faktury', 'anuluj'])
  })

  it('każdy przycisk przejścia ekranowego jest w tabeli rdzenia (canTransition)', () => {
    const statusy: OrderStatus[] = ['NOWE', 'DO_REALIZACJI', 'ZBIERANIE', 'ZEBRANE', 'SPAKOWANE', 'DO_WYSLANIA', 'DO_ODBIORU', 'WYSLANE', 'ODEBRANE', 'ANULOWANE', 'DO_WYJASNIENIA', 'REKLAMACJA']
    for (const s of statusy)
      for (const f of [TOWAR, PO_FAKTURZE, EBOOK])
        for (const p of dostepnePrzejscia(zam(s), f, WSZYSTKO)) {
          const cel = celAkcji(p.akcja, zam(s))
          if (cel) expect(canTransition(s, cel), `${s} → ${cel}`).toBe(true)
        }
  })

  it('odbiór osobisty: „Do odbioru”, bez „Wyślij bez faktury”', () => {
    const p = dostepnePrzejscia(zam('SPAKOWANE', { carrier: 'OSOBISTY' }), TOWAR, WSZYSTKO)
    expect(p.find((x) => x.akcja === 'wydanie')?.etykieta).toBe('Do odbioru')
    expect(p.find((x) => x.akcja === 'bez_faktury')?.powod).toMatch(/Odbiór osobisty/)
  })

  it('powody z rdzenia: „Najpierw faktura”, mieszane bez zbierania, karta nieaktualna, anulowanie w toku', () => {
    expect(dostepnePrzejscia(zam('SPAKOWANE'), TOWAR, WSZYSTKO).find((x) => x.akcja === 'wydanie')?.powod).toMatch(/^Najpierw faktura/)
    expect(dostepnePrzejscia(zam('DO_REALIZACJI', { kartaNieaktualna: true }), TOWAR, WSZYSTKO).find((x) => x.akcja === 'spakuj')?.powod).toMatch(/Karta nieaktualna/)
    expect(dostepnePrzejscia(zam('ZBIERANIE', { pendingAction: 'CANCEL:CANCELLED' }), TOWAR, WSZYSTKO).find((x) => x.akcja === 'zebrane')?.powod).toMatch(/Anulowanie w toku/)
    expect(dostepnePrzejscia(zam('DO_REALIZACJI', { pendingAction: 'CANCEL:CANCELLED' }), TOWAR, WSZYSTKO).find((x) => x.akcja === 'anuluj')?.powod).toMatch(/czeka/)
  })

  it('anulowanie i „Wyślij bez faktury” mają potwierdzenie; „Wysłane” pole numeru; wybór przewoźnika', () => {
    expect(dostepnePrzejscia(zam('NOWE'), TOWAR, WSZYSTKO).find((x) => x.akcja === 'anuluj')?.potwierdz).toMatch(/Anulować/)
    expect(dostepnePrzejscia(zam('SPAKOWANE'), TOWAR, WSZYSTKO).find((x) => x.akcja === 'bez_faktury')?.potwierdz).toMatch(/bez faktury/)
    expect(dostepnePrzejscia(zam('DO_WYSLANIA'), PO_FAKTURZE, WSZYSTKO)[0]).toMatchObject({ numerNadania: true })
    expect(dostepnePrzejscia(zam('DO_WYJASNIENIA', { carrier: 'BEZ_WYSYLKI' }), TOWAR, WSZYSTKO)[0]).toMatchObject({ wyborPrzewoznika: true })
    expect(dostepnePrzejscia(zam('DO_WYJASNIENIA', { carrier: 'BEZ_WYSYLKI' }), EBOOK, WSZYSTKO)[0]!.wyborPrzewoznika).toBeUndefined()
    // nieznana metoda dostawy (BRAK) z towarem też wymaga wyboru; bez towaru nie
    expect(dostepnePrzejscia(zam('DO_WYJASNIENIA', { carrier: 'BRAK' }), TOWAR, WSZYSTKO)[0]).toMatchObject({ wyborPrzewoznika: true })
    expect(dostepnePrzejscia(zam('DO_WYJASNIENIA', { carrier: 'BRAK' }), EBOOK, WSZYSTKO)[0]!.wyborPrzewoznika).toBeUndefined()
  })
})

describe('dostepnePrzejscia: uprawnienia', () => {
  it('bez zamowienia.przejscia każdy przycisk nieaktywny z powodem', () => {
    const p = dostepnePrzejscia(zam('DO_REALIZACJI'), TOWAR, new Set(['panel.podglad']))
    expect(p.length).toBeGreaterThan(0)
    expect(p.every((x) => /uprawnienia/.test(x.powod ?? ''))).toBe(true)
  })

  it('opłacenie wymaga zamowienia.oznacz_oplacone; anulowanie po fakturze zamowienia.anuluj_po_fakturze', () => {
    expect(akcje(zam('NOWE', { paymentState: 'UNPAID' }), TOWAR, BIURO)).toEqual(['oplacone!', 'anuluj'])
    expect(akcje(zam('DO_REALIZACJI'), PO_FAKTURZE, BIURO)).toContain('anuluj!')
    expect(akcje(zam('DO_REALIZACJI'), PO_FAKTURZE, WSZYSTKO)).toContain('anuluj')
    expect(dostepnePrzejscia(zam('DO_REALIZACJI'), PO_FAKTURZE, WSZYSTKO).find((x) => x.akcja === 'anuluj')?.potwierdz).toMatch(/korekty/)
  })
})

describe('numer nadania i wyłącznik', () => {
  it('numerNadania: puste = null, spacje usuwane, złe znaki i długość = false', () => {
    expect(numerNadania('')).toBeNull()
    expect(numerNadania(null)).toBeNull()
    expect(numerNadania(' 6200 1234 5678 ')).toBe('620012345678')
    expect(numerNadania('ABC-123')).toBe('ABC-123')
    expect(numerNadania('<script>')).toBe(false)
    expect(numerNadania('ab')).toBe(false)
    expect(numerNadania('x'.repeat(41))).toBe(false)
  })

  it('EKRANY_PRACA: 1 włącza, puste i 0 wyłączają, zła wartość = błąd; pracaDostepna wymaga obu warunków', () => {
    expect(ekranyPracaZEnv({ EKRANY_PRACA: '1' })).toBe(true)
    expect(ekranyPracaZEnv({ EKRANY_PRACA: ' 1 ' })).toBe(true)
    expect(ekranyPracaZEnv({})).toBe(false)
    expect(ekranyPracaZEnv({ EKRANY_PRACA: '0' })).toBe(false)
    expect(() => ekranyPracaZEnv({ EKRANY_PRACA: 'tak' })).toThrow(/EKRANY_PRACA/)
    expect(pracaDostepna({ statusMode: 'PRACA' }, { EKRANY_PRACA: '1' })).toBe(true)
    expect(pracaDostepna({ statusMode: 'CIEN' }, { EKRANY_PRACA: '1' })).toBe(false)
    expect(pracaDostepna(null, { EKRANY_PRACA: '1' })).toBe(false)
    expect(pracaDostepna({ statusMode: 'PRACA' }, {})).toBe(false) // brak informacji o BL = ostrożnie, jak firma z BL
    // firma bez BaseLinkera nie potrzebuje wyłącznika instancji; zła wartość nadal błędem
    expect(pracaDostepna({ statusMode: 'PRACA', firmaZBl: false }, {})).toBe(true)
    expect(pracaDostepna({ statusMode: 'CIEN', firmaZBl: false }, {})).toBe(false)
    expect(pracaDostepna({ statusMode: 'PRACA', firmaZBl: true }, { EKRANY_PRACA: '0' })).toBe(false)
    expect(() => pracaDostepna({ statusMode: 'PRACA', firmaZBl: false }, { EKRANY_PRACA: 'tak' })).toThrow(/EKRANY_PRACA/)
  })
})

describe('zamówienie z fakturą z BaseLinkera (konto w pracy)', () => {
  const ZBL: FaktyEkranu = { ...TOWAR, fakturaBl: 'FV 7/11' }
  const DECYZJA = new Set([...WSZYSTKO, 'zamowienia.status_dowolny'])
  it('„Spakuj” wstrzymane z powodem, obok „Pakuj mimo faktury z BaseLinkera” z potwierdzeniem; bez prawa decyzji nieaktywny', () => {
    expect(akcje(zam('ZEBRANE'), ZBL, DECYZJA)).toEqual(['spakuj!', 'pakuj_mimo_faktury_bl'])
    expect(akcje(zam('DO_REALIZACJI'), ZBL, DECYZJA)).toEqual(['zbieranie', 'spakuj!', 'pakuj_mimo_faktury_bl', 'anuluj'])
    const p = dostepnePrzejscia(zam('ZEBRANE'), ZBL, DECYZJA)
    expect(p[0]!.powod).toContain('fakturę FV 7/11 z BaseLinkera')
    expect(p[1]).toMatchObject({ etykieta: 'Pakuj mimo faktury z BaseLinkera', powod: null })
    expect(p[1]!.potwierdz).toContain('„Wyślij bez faktury”')
    expect(akcje(zam('ZEBRANE'), ZBL, WSZYSTKO)).toEqual(['spakuj!', 'pakuj_mimo_faktury_bl!'])
    expect(celAkcji('pakuj_mimo_faktury_bl', { carrier: null })).toBeNull()
  })
  it('bez faktury BL (podgląd, firma bez BL, po decyzji): przyciski bez zmian', () => {
    expect(akcje(zam('ZEBRANE'), { ...TOWAR, fakturaBl: null }, new Set([...WSZYSTKO, 'zamowienia.status_dowolny']))).toEqual(['spakuj'])
  })
})
