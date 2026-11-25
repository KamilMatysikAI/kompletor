import { describe, expect, it } from 'vitest'
import { channelPrefix, eventLabel, jednostkaWaluty, money, outsideCoreNote, qty, shortExternalId, when } from './format'

const N = ' '

describe('formatowanie panelu', () => {
  it('kwoty po polsku z grupowaniem tysięcy (także 4 cyfry, jak w makietach)', () => {
    expect(money(1863.5)).toBe(`1${N}863,50${N}zł`)
    expect(money(29865.05)).toBe(`29${N}865,05${N}zł`)
    expect(money('47')).toBe(`47,00${N}zł`)
    expect(money(null)).toBe('—')
  })

  it('kwota w walucie zamówienia: PLN i brak = zł, inna = kod waluty', () => {
    expect(money(957, 'CZK')).toBe(`957,00${N}CZK`)
    expect(money(1863.5, 'czk ')).toBe(`1${N}863,50${N}CZK`)
    expect(money(47, 'PLN')).toBe(`47,00${N}zł`)
    expect(money(47, null)).toBe(`47,00${N}zł`)
    expect(money(47, '')).toBe(`47,00${N}zł`)
    expect(money(null, 'CZK')).toBe('—')
    expect(jednostkaWaluty('eur')).toBe('EUR')
    expect(jednostkaWaluty(undefined)).toBe('zł')
  })

  it('ilości w jednostce bazowej: sztuki, gramy, kilogramy', () => {
    expect(qty(2, 'SZT')).toBe(`2${N}szt.`)
    expect(qty(250, 'KG')).toBe(`250${N}g`)
    expect(qty(1250, 'KG')).toBe(`1,25${N}kg`)
  })

  it('daty względem dziś w strefie Warszawy (także przy zmianie czasu)', () => {
    const now = new Date('2026-10-25T14:00:00Z') // 15:00 w Warszawie, dzień zmiany czasu
    expect(when(new Date('2026-10-25T07:12:00Z'), now)).toBe('dziś 08:12')
    expect(when(new Date('2026-10-24T18:02:00Z'), now)).toBe('wczoraj 20:02')
    expect(when(new Date('2026-10-16T08:05:00Z'), now)).toBe('16.10 10:05')
  })

  it('przedrostek numeru: Allegro i Empik stałe, sklep z inicjałów nazwy konta', () => {
    expect(channelPrefix('ALLEGRO', 'Allegro sklepdemo_pl')).toBe('ALG')
    expect(channelPrefix('EMPIK', 'x')).toBe('EMP')
    expect(channelPrefix('WOO', 'HurtDemo')).toBe('HD')
    expect(channelPrefix('WOO', 'KolorowyKubek')).toBe('KK')
    expect(channelPrefix('WOO', '')).toBe('SKL')
    expect(shortExternalId('48213')).toBe('48213')
    expect(shortExternalId('9b21-44e0-aaaa-bbbb-cccc')).toBe('9b21-44e0…')
  })

  it('zdarzenia: znane po polsku, nieznane czytelnie', () => {
    expect(eventLabel('FAKTURA_BLAD')).toBe('Faktura się nie wystawiła')
    expect(eventLabel('NOWY_RODZAJ')).toBe('nowy rodzaj')
  })
})

describe('nazwa konta kanału', () => {
  it('nazwa z konfiguracji; id z BaseLinkera i brak nazwy zastępuje rodzaj kanału albo domena sklepu', async () => {
    const { accountDisplayName, SHOP_WITHOUT_NAME } = await import('./format')
    expect(accountDisplayName('WOO', '7100001', 'SklepDemo')).toBe('SklepDemo')
    expect(accountDisplayName('ALLEGRO', '71045', '71045')).toBe('Allegro')
    expect(accountDisplayName('EMPIK', '30193', null)).toBe('Empik')
    expect(accountDisplayName('EMPIK', '30193', '30193')).toBe('Empik')
    expect(accountDisplayName('WOO', '7100002', 'shop_7100002')).toBe(SHOP_WITHOUT_NAME)
    expect(accountDisplayName('WOO', 'sd', ' sd ')).toBe('Sklep bez nazwy')
    // dwa sklepy bez nazwy rozróżnia domena z adresu w konfiguracji konta
    expect(accountDisplayName('WOO', '7100003', null, { baseUrl: 'https://www.kolorowykubek.pl/' })).toBe('kolorowykubek.pl')
    expect(accountDisplayName('WOO', '7100003', null, { baseUrl: 'nie adres' })).toBe('Sklep bez nazwy')
    // nazwa z literami i cyframi wpisana przez człowieka zostaje
    expect(accountDisplayName('WOO', '7100003', 'SD 2')).toBe('SD 2')
    expect(accountDisplayName('WOO', '7100003', 'Sklep 7100003')).toBe('Sklep 7100003')
  })

  it('przedrostek numeru dla nazwy zastępczej i domeny — bez nawiasów i cyfr', async () => {
    const { accountDisplayName, channelPrefix } = await import('./format')
    expect(channelPrefix('WOO', accountDisplayName('WOO', '7100001', null))).toBe('SKL')
    expect(channelPrefix('WOO', 'kolorowykubek.pl')).toBe('KO')
    expect(channelPrefix('WOO', 'SklepDemo')).toBe('SD')
    expect(channelPrefix('WOO', 'Sklep (stary)')).toBe('SS')
    expect(channelPrefix('WOO', 'SD 2')).toBe('SD')
  })
})

describe('outsideCoreNote', () => {
  const o = (x: Partial<{ beforeStart: number; notIngested: number; skipped: number; cancelled: number }>) => ({ beforeStart: 0, notIngested: 0, skipped: 0, cancelled: 0, ...x })
  it('brak adnotacji, gdy wszystko jest w realizacji i nic nie anulowano', () => {
    expect(outsideCoreNote(o({}))).toBeNull()
  })
  it('odmiana i rodzaje; jedno brzmienie „zanim system zaczął czytać konto”', () => {
    expect(outsideCoreNote(o({ beforeStart: 5 }))).toBe('w tym 5 zrealizowanych, zanim system zaczął czytać konto (nie ma ich w realizacji systemu)')
    expect(outsideCoreNote(o({ beforeStart: 1 }))).toBe('w tym 1 zrealizowane, zanim system zaczął czytać konto (nie ma ich w realizacji systemu)')
    expect(outsideCoreNote(o({ beforeStart: 22, notIngested: 12 }))).toBe('w tym 12 jeszcze nieprzyjętych do realizacji i 22 zrealizowane, zanim system zaczął czytać konto (nie ma ich w realizacji systemu)')
    expect(outsideCoreNote(o({ notIngested: 3 }))).toBe('w tym 3 jeszcze nieprzyjęte do realizacji (nie ma ich w realizacji systemu)')
  })
  it('pominięte z innego powodu — osobna kategoria', () => {
    expect(outsideCoreNote(o({ skipped: 1 }))).toBe('w tym 1 pominięte przy przyjmowaniu (nie ma ich w realizacji systemu)')
    expect(outsideCoreNote(o({ beforeStart: 2, notIngested: 1, skipped: 5 }))).toBe(
      'w tym 1 jeszcze nieprzyjęte do realizacji, 5 pominiętych przy przyjmowaniu i 2 zrealizowane, zanim system zaczął czytać konto (nie ma ich w realizacji systemu)',
    )
  })
  it('anulowane osobno: „poza tym”, gdy nie liczą się do sprzedaży, „w tym”, gdy się liczą', () => {
    expect(outsideCoreNote(o({ cancelled: 1 }), false)).toBe('poza tym 1 anulowane')
    expect(outsideCoreNote(o({ cancelled: 5, beforeStart: 5 }), false)).toBe('w tym 5 zrealizowanych, zanim system zaczął czytać konto (nie ma ich w realizacji systemu) · poza tym 5 anulowanych')
    expect(outsideCoreNote(o({ cancelled: 3 }), true)).toBe('w tym 3 anulowane')
  })
})
