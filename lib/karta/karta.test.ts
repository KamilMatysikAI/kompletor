// czyste funkcje karty zamówienia — rozliczenie płatności, data wpłaty, historia, autor, blokada edycji.
import { describe, expect, it } from 'vitest'
import { cenaZTekstu, KOMUNIKAT_ZBIERANE, powodBlokadyEdycji } from '@/lib/rdzen/edycja'
import { autor, opisZdarzenia, zlozHistorie } from './historia'
import { dataWplaty, rozliczenie } from './platnosci'
import { parseUstawieniaKarty } from './bramka'
import { numerKarty, numeryKarty, sposobPlatnosci } from './opis'

const T = new Date('2026-11-05T10:00:00Z')

describe('rozliczenie płatności', () => {
  it('opłacone bez edycji: rozliczone; po edycji podstawa to kwota sprzed edycji', () => {
    expect(rozliczenie({ totalGross: '100.00', paymentState: 'PAID', flags: {} }, [])).toMatchObject({ zaplaconoGr: 10000, roznicaGr: 0, pokaz: true })
    expect(rozliczenie({ totalGross: '130.50', paymentState: 'PAID', flags: { kwotaZaplacona: '100.00' } }, [])).toMatchObject({ zaplaconoGr: 10000, roznicaGr: 3050 })
    expect(rozliczenie({ totalGross: '130.50', paymentState: 'PAID', flags: { kwotaZaplacona: '100.00' } }, [{ kind: 'DOPLATA', amount: '30.50' }])).toMatchObject({ roznicaGr: 0 })
    expect(rozliczenie({ totalGross: '80.00', paymentState: 'PAID', flags: { kwotaZaplacona: '100.00' } }, [])).toMatchObject({ roznicaGr: -2000 })
    expect(rozliczenie({ totalGross: '80.00', paymentState: 'PAID', flags: { kwotaZaplacona: '100.00' } }, [{ kind: 'ZWROT', amount: '20' }])).toMatchObject({ roznicaGr: 0, zaplaconoGr: 8000 })
  })

  it('pobranie: bez różnicy; nieopłacone bez wpisów: różnicy nie pokazujemy', () => {
    expect(rozliczenie({ totalGross: '50.00', paymentState: 'COD', flags: { kwotaZaplacona: '10.00' } }, [])).toMatchObject({ roznicaGr: 0, pokaz: false })
    expect(rozliczenie({ totalGross: '50.00', paymentState: 'UNPAID', flags: {} }, [])).toMatchObject({ zaplaconoGr: 0, pokaz: false })
    expect(rozliczenie({ totalGross: '50.00', paymentState: 'PARTIAL', flags: {} }, [{ kind: 'WPLATA', amount: '20.00' }])).toMatchObject({ zaplaconoGr: 2000, roznicaGr: 3000, pokaz: true })
  })

  it('data wpłaty: dziś domyślnie, nie z przyszłości, najwyżej rok wstecz; cena z przecinkiem', () => {
    expect(dataWplaty('', T)).toBe(T)
    expect(dataWplaty('2026-11-04', T)?.toISOString()).toBe('2026-11-04T12:00:00.000Z')
    expect(dataWplaty('2026-11-09', T)).toBeNull()
    expect(dataWplaty('2025-10-01', T)).toBeNull()
    expect(dataWplaty('4.11.2026', T)).toBeNull()
    expect(cenaZTekstu('12,5')).toBe(1250)
    expect(cenaZTekstu('1 234,99')).toBe(123499)
    expect(cenaZTekstu('1,234')).toBeNull()
    expect(cenaZTekstu('-1')).toBeNull()
  })
})

describe('historia zmian', () => {
  const nazwy = new Map([['u1', 'Anna']])
  it('autor: osoba imieniem, stare tory panelu i stanowiska, reszta system (bez technicznych id)', () => {
    expect(autor('user:u1', nazwy)).toEqual({ kto: 'Anna', czlowiek: true })
    expect(autor('user:obcy', nazwy)).toEqual({ kto: 'użytkownik', czlowiek: true })
    expect(autor('panel', nazwy)).toEqual({ kto: 'biuro', czlowiek: true })
    expect(autor('system:woo-poll', nazwy)).toEqual({ kto: 'system', czlowiek: false })
    expect(autor('cos-dziwnego', nazwy)).toEqual({ kto: 'system', czlowiek: false })
  })

  it('jedna oś czasu, nowsze wyżej; dziennik tylko z listy karty; filtr „tylko ludzie”', () => {
    const h = zlozHistorie(
      [
        { id: '1', kind: 'PRZYJETE', actorId: 'system:test', createdAt: new Date(1000), data: {} },
        { id: '2', kind: 'ZMIANA_ILOSCI', actorId: 'user:u1', createdAt: new Date(3000), data: { z: 1, na: 2 } },
      ],
      [
        { id: 'a', entity: 'ZAMOWIENIE_PLATNOSC', actorId: 'user:u1', createdAt: new Date(2000) },
        { id: 'b', entity: 'KLIENT_PODGLAD', actorId: 'user:u1', createdAt: new Date(2500) },
      ],
      nazwy,
    )
    expect(h.map((w) => w.opis)).toEqual(['Zmiana ilości w Kompletorze: 1 → 2', 'Zapis płatności', 'Zamówienie przyjęte'])
    expect(zlozHistorie([{ id: '1', kind: 'PRZYJETE', actorId: 'system:test', createdAt: new Date(1), data: null }], [], nazwy, { tylkoLudzie: true })).toEqual([])
    expect(opisZdarzenia('PODZIAL', { packageNo: 2 })).toBe('Podział zamówienia: paczka 2')
    // wartość zamówienia poprawiona odczytem ze sklepu
    expect(opisZdarzenia('KWOTA_Z_KANALU', { z: '0.00', na: '105.10' })).toBe('Wartość zamówienia poprawiona ze sklepu: 0,00 zł → 105,10 zł')
    expect(opisZdarzenia('KWOTA_Z_KANALU', { z: '0.00', na: '117.60', kosztZ: '0.00', kosztNa: '12.50' })).toBe(
      'Wartość zamówienia poprawiona ze sklepu: 0,00 zł → 117,60 zł, wysyłka 0,00 zł → 12,50 zł',
    )
  })
  it('zmiana sposobu wysyłki: przewoźnik i moduł przed i po słowami, bez danych dostawy', () => {
    expect(opisZdarzenia('SPOSOB_WYSYLKI_ZMIENIONY', { z: 'PACZKOMATY', zModulu: 'INPOST_SHIPX', na: 'DPD', naModul: 'DPD_BEZPOSREDNIO', pobranie: false })).toBe(
      'Sposób wysyłki zmieniony na karcie: Paczkomaty (InPost) → DPD',
    )
    expect(opisZdarzenia('SPOSOB_WYSYLKI_ZMIENIONY', { z: null, zModulu: null, na: 'OSOBISTY', naModul: 'BRAK' })).toBe('Sposób wysyłki zmieniony na karcie: bez przewoźnika → Odbiór osobisty')
  })
  it('zmiana danych klienta na karcie: część i same nazwy pól, bez wartości', () => {
    expect(opisZdarzenia('DANE_KLIENTA_ZMIENIONE', { czesc: 'KUPUJACY', pola: ['nabywca_imie_nazwisko', 'telefon', 'email'] })).toBe('Dane klienta zmienione na karcie, kupujący: imię i nazwisko, telefon, e-mail')
    expect(opisZdarzenia('DANE_KLIENTA_ZMIENIONE', { czesc: 'FAKTURA', pola: ['faktura_nazwa', 'faktura_nip', 'faktura_na_firme'], naFirme: true })).toBe(
      'Dane klienta zmienione na karcie, dane do faktury: nazwa, NIP, faktura na firmę: tak',
    )
    expect(opisZdarzenia('DANE_KLIENTA_ZMIENIONE', { czesc: 'FAKTURA', pola: ['faktura_na_firme', 'faktura_nip'], naFirme: false })).toBe('Dane klienta zmienione na karcie, dane do faktury: faktura na firmę: nie, NIP')
    // rodzaj danych do faktury (bez danych / imienna / na firmę); nieznany rodzaj = sama nazwa pola
    expect(opisZdarzenia('DANE_KLIENTA_ZMIENIONE', { czesc: 'FAKTURA', pola: ['faktura_nazwa', 'faktura_rodzaj'], rodzaj: 'IMIENNA' })).toBe('Dane klienta zmienione na karcie, dane do faktury: nazwa, rodzaj: faktura imienna (bez NIP-u)')
    expect(opisZdarzenia('DANE_KLIENTA_ZMIENIONE', { czesc: 'FAKTURA', pola: ['faktura_rodzaj'], rodzaj: 'BRAK' })).toBe('Dane klienta zmienione na karcie, dane do faktury: rodzaj: bez danych do faktury')
    expect(opisZdarzenia('DANE_KLIENTA_ZMIENIONE', { czesc: 'FAKTURA', pola: ['faktura_rodzaj'], rodzaj: 'FIRMA' })).toBe('Dane klienta zmienione na karcie, dane do faktury: rodzaj: faktura na firmę (NIP)')
    expect(opisZdarzenia('DANE_KLIENTA_ZMIENIONE', { czesc: 'FAKTURA', pola: ['faktura_rodzaj'], rodzaj: 'Jan Kowalski' })).toBe('Dane klienta zmienione na karcie, dane do faktury: rodzaj danych do faktury')
    // nieznane nazwy pól i wartości przemycone w danych zdarzenia nie trafiają na ekran
    expect(opisZdarzenia('DANE_KLIENTA_ZMIENIONE', { czesc: 'KUPUJACY', pola: ['jan@example.com', 'telefon'], email: 'jan@example.com' })).toBe('Dane klienta zmienione na karcie, kupujący: telefon')
    expect(opisZdarzenia('DANE_KLIENTA_ZMIENIONE', {})).toBe('Dane klienta zmienione na karcie')
  })
})

describe('blokada edycji i ustawienia karty', () => {
  const o = { status: 'DO_REALIZACJI' as const, statusBeforeClarify: null, pendingAction: null, parentOrderId: null }
  it('przed zbieraniem można; po wydruku i zbieraniu jasny komunikat; do wyjaśnienia wg etapu', () => {
    expect(powodBlokadyEdycji(o, { poFakturze: 0 })).toBeNull()
    expect(powodBlokadyEdycji({ ...o, status: 'NOWE' }, { poFakturze: 0 })).toBeNull()
    expect(powodBlokadyEdycji({ ...o, status: 'ZBIERANIE' }, { poFakturze: 0 })).toBe(KOMUNIKAT_ZBIERANE)
    expect(powodBlokadyEdycji({ ...o, status: 'DO_WYJASNIENIA', statusBeforeClarify: 'ZEBRANE' }, { poFakturze: 0 })).toBe(KOMUNIKAT_ZBIERANE)
    expect(powodBlokadyEdycji({ ...o, status: 'DO_WYJASNIENIA', statusBeforeClarify: 'DO_REALIZACJI' }, { poFakturze: 0 })).toBeNull()
    expect(powodBlokadyEdycji({ ...o, status: 'SPAKOWANE' }, { poFakturze: 0 })).toMatch(/spakowane/)
    expect(powodBlokadyEdycji({ ...o, status: 'ANULOWANE' }, { poFakturze: 0 })).toMatch(/anulowane/)
    expect(powodBlokadyEdycji({ ...o, pendingAction: 'CANCEL:CANCELLED' }, { poFakturze: 0 })).toMatch(/Anulowanie w toku/)
    expect(powodBlokadyEdycji(o, { poFakturze: 1 })).toMatch(/Faktura/)
    expect(powodBlokadyEdycji({ ...o, parentOrderId: 'x' }, { poFakturze: 0 })).toMatch(/pierwszej paczce/)
  })

  it('edycjaZamowienKanalow: domyślnie true, tylko wartość logiczna', () => {
    expect(parseUstawieniaKarty({})).toEqual({ edycjaZamowienKanalow: true })
    expect(parseUstawieniaKarty({ karta: { edycjaZamowienKanalow: false } })).toEqual({ edycjaZamowienKanalow: false })
    expect(parseUstawieniaKarty({ karta: { edycjaZamowienKanalow: 'nie' } })).toEqual({ edycjaZamowienKanalow: true })
    expect(parseUstawieniaKarty(null)).toEqual({ edycjaZamowienKanalow: true })
  })
})

describe('akcje serwera karty: właściwe uprawnienie w pierwszej linii', () => {
  it('każda akcja z akcje-*.ts zaczyna od requirePermission swojego uprawnienia', async () => {
    const { readFileSync } = await import('node:fs')
    const path = await import('node:path')
    const dir = path.resolve(__dirname, '../../app/(panel)/zamowienia/[id]')
    const OCZEKIWANE: Record<string, string> = {
      dodajPozycjeKarta: 'zamowienia.edycja_pozycji',
      jednakJestKarta: 'braki.decyzje',
      podzielKarta: 'zamowienia.podzial',
      oznaczOplaconeKarta: 'zamowienia.oznacz_oplacone',
      zapiszDoplateKarta: 'zamowienia.oznacz_oplacone',
      zwrotRoznicyKarta: 'zwroty.pieniadze',
      dodajNotatkeKarta: 'zamowienia.notatki',
      poprawNotatkeKarta: 'zamowienia.notatki',
      kopiujDaneKlienta: 'klienci.dane',
      // akcje też pod strażnikiem
      odswiezKlienta: 'klienci.dane',
      kopiujAdresKlienta: 'klienci.dane',
      wpiszKlienta: 'klienci.dane',
      zapiszKupujacegoAkcja: 'klienci.dane',
      zapiszFaktureAkcja: 'klienci.dane',
      usunKlienta: 'klienci.dane',
      powiazKarta: 'ustawienia',
      odswiezOpisKarta: 'zamowienia.edycja_pozycji',
      // zmiana statusu z listy
      zmienStatusKarta: 'zamowienia.status_dowolny',
      // przesyłka na karcie (i stanowisku)
      stanNadania: 'pakowanie.stanowisko',
      szukajPunktowAkcja: 'klienci.dane', // wyszukiwarka punktów przy poprawce punktu odbioru
      utworzPrzesylkeAkcja: 'pakowanie.stanowisko',
      sprawdzPrzesylkeAkcja: 'pakowanie.stanowisko',
      rozstrzygnijPrzesylkeAkcja: 'przesylki.rozstrzyganie',
      pobierzEtykieteAkcja: 'pakowanie.stanowisko',
      daneDoPoprawkiAkcja: 'klienci.dane',
      poprawAdresAkcja: 'klienci.dane',
      zmienSposobAkcja: 'klienci.dane', // drugie uprawnienie (pakowanie.stanowisko) sprawdza akcja zaraz po pierwszym
      // anulowanie przesyłki u przewoźnika (Wysyłam z Allegro)
      anulujPrzesylkeAkcja: 'pakowanie.stanowisko',
      stanDodatkowejAkcja: 'pakowanie.stanowisko',
      dodajPrzesylkeAkcja: 'pakowanie.stanowisko',
      // jeden zapis sekcji „Pozycje”
      zapiszPozycjeKarta: 'zamowienia.edycja_pozycji',
      zapiszDecyzjeKarta: 'braki.decyzje',
      // „Wyszedł komplet” po spakowaniu z brakiem
      wyszedlKompletKarta: 'braki.decyzje',
      // „Ponów fakturę” po błędzie wFirmy
      ponowFakture: 'zamowienia.faktury',
      // „Dokument wystawiony” po wysyłce bez faktury
      potwierdzDokument: 'zamowienia.faktury',
      // wyszukiwarka okna „Zamień produkt” (tylko odczyt)
      szukajZamiennikaKarta: 'braki.decyzje',
      szukajProduktuKarta: 'zamowienia.edycja_pozycji', // wyszukiwarka „Dodaj pozycję”
    }
    const znalezione: Record<string, string> = {}
    let eksportow = 0
    for (const f of ['akcje-pozycje.ts', 'akcje-platnosc.ts', 'akcje-notatki.ts', 'akcje-kopiuj.ts', 'akcje-klient.ts', 'akcje-opis.ts', 'akcje-status.ts', 'akcje-przesylka.ts', 'akcje-faktura.ts', 'akcje-szukaj.ts']) {
      const src = readFileSync(path.join(dir, f), 'utf8')
      expect(src.startsWith("'use server'"), f).toBe(true)
      eksportow += [...src.matchAll(/^export async function /gm)].length
      // typ zwracany może mieć `{` (Promise<{ … }>), więc ciało funkcji = ostatnia klamra w linii nagłówka
      for (const m of src.matchAll(/export async function (\w+)\([^)]*\)[^\n]*\{\s*\n\s*const ctx = await requirePermission\('([^']+)'\)/g)) znalezione[m[1]!] = m[2]!
    }
    expect(znalezione).toEqual(OCZEKIWANE)
    expect(eksportow, 'każda eksportowana akcja zaczyna od requirePermission').toBe(Object.keys(OCZEKIWANE).length)
  })
})

describe('opis karty', () => {
  it('sposób płatności słowami: Allegro rozkładane na typ i dostawcę, inne kanały bez zmian, nieznany kod zostaje', () => {
    expect(sposobPlatnosci('ALLEGRO', 'ONLINE (AF)')).toBe('Płatność online Allegro (Allegro Finance)')
    expect(sposobPlatnosci('ALLEGRO', 'ONLINE (PAYU)')).toBe('Płatność online Allegro (PayU)')
    expect(sposobPlatnosci('ALLEGRO', 'CASH_ON_DELIVERY')).toBe('Za pobraniem')
    expect(sposobPlatnosci('ALLEGRO', 'ONLINE (NOWY)')).toBe('Płatność online Allegro (NOWY)')
    expect(sposobPlatnosci('ALLEGRO', 'DZIWNE')).toBe('DZIWNE')
    expect(sposobPlatnosci('WOO', 'Blik')).toBe('Blik')
    expect(sposobPlatnosci('WOO', '(brak)', 'COD')).toBe('Za pobraniem')
    expect(sposobPlatnosci('WOO', '')).toBe('—')
  })

  it('numer karty: numer w kanale, potem numer BL, potem numer z kanału (długi ucięty)', () => {
    expect(numerKarty({ externalId: '118438', channelNumber: '158546', blOrderId: 162868493 })).toEqual({ numer: '158546', zrodlo: 'KANAL' })
    expect(numerKarty({ externalId: '22961540-d83a-11f1-a706-217671faee31', channelNumber: null, blOrderId: 162868493 })).toEqual({ numer: '162868493', zrodlo: 'BL' })
    expect(numerKarty({ externalId: '22961540-d83a-11f1-a706-217671faee31', channelNumber: null, blOrderId: null })).toEqual({ numer: '22961540-…', zrodlo: 'ID' })
    expect(numerKarty({ externalId: '48213', channelNumber: null, blOrderId: null })).toEqual({ numer: '48213', zrodlo: 'ID' })
  })

  it('każdy numer raz (numer w sklepie tylko, gdy inny niż w tytule; link w tytule przy tym samym numerze)', () => {
    // krótki numer z kanału bez channelNumber: tytuł „BD 48073”, bez drugiej linii; link kanału przechodzi na tytuł
    expect(numeryKarty({ externalId: '48073', channelNumber: null, blOrderId: null }, null)).toMatchObject({ numer: '48073', wSklepie: null, bl: null, linkWTytule: false })
    expect(numeryKarty({ externalId: '48073', channelNumber: null, blOrderId: null }, 'https://sklep.example/zam/48073')).toMatchObject({ wSklepie: null, linkWTytule: true })
    // długi identyfikator ucięty w tytule: pełny numer pod tytułem (z linkiem tam, nie w tytule)
    expect(numeryKarty({ externalId: '22961540-d83a-11f1-a706-217671faee31', channelNumber: null, blOrderId: null }, 'https://x.example')).toMatchObject({ numer: '22961540-…', wSklepie: '22961540-d83a-11f1-a706-217671faee31', linkWTytule: false })
    // tytuł z BL: numer w sklepie pod tytułem, numer BL już nie (jest w tytule)
    expect(numeryKarty({ externalId: '118438', channelNumber: null, blOrderId: 162868493 }, null)).toMatchObject({ numer: '162868493', wSklepie: '118438', bl: null })
    // tytuł z kanału: numer BL pod tytułem, numer w sklepie nie
    expect(numeryKarty({ externalId: '118438', channelNumber: '158546', blOrderId: 162868493 }, null)).toMatchObject({ numer: '158546', wSklepie: null, bl: 162868493 })
  })
})
