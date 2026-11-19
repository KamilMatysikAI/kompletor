// lista na ekranie Integracje (czysta część: z danych do grup, stanów i przycisków).
import { describe, expect, it } from 'vitest'
import { pozycjeIntegracji, type DaneIntegracji } from './integracje'

const NOW = new Date('2026-11-09T17:30:00Z')
const PLATFORMY: DaneIntegracji['platformy'] = [
  { klucz: 'woo', channel: 'WOO', nazwa: 'WooCommerce' },
  { klucz: 'shoper', channel: 'SHOPER', nazwa: 'Shoper' },
  { klucz: 'allegro', channel: 'ALLEGRO', nazwa: 'Allegro' },
]
const pusta: DaneIntegracji = {
  kanaly: [],
  platformy: PLATFORMY,
  maBl: false,
  przewoznicy: [{ id: 'dpd', nazwa: 'DPD Polska', adapterKey: 'dpd.v1', sekrety: [{ name: 'DPD_LOGIN', nazwa: 'Login', opis: '', wymagany: true, ustawiony: false, zrodlo: null }], reguly: [], test: null }],
  dokumenty: { program: 'brak', nazwaProgramu: null, maWfirme: false, fakturyWlaczone: false, ksefToken: false, srodowiskoKsef: 'testowe (KSeF TEST)' },
  poczta: { wlaczona: false, host: '', nadawca: '', ostatniBlad: null },
  ai: { model: 'claude-x', zrodloKlucza: null, packshot: false },
  klucze: { agentow: 0, innych: 0, ostatnieUzycieAgenta: null },
}

const tekst = (g: ReturnType<typeof pozycjeIntegracji>) => JSON.stringify(g)

describe('ekran Integracje', () => {
  it('firma bez żadnego konta: każda pozycja „Niepodłączony” z „Podłącz”, bez BaseLinkera i wFirmy', () => {
    const g = pozycjeIntegracji(pusta, NOW)
    expect(g.map((x) => x.tytul)).toEqual(['Sprzedaż', 'Wysyłka', 'Dokumenty sprzedaży', 'Poczta', 'Agenci AI'])
    const pozycje = g.flatMap((x) => x.pozycje)
    // „Bez programu do faktur” to stan wyboru programu, nie połączenie: jedyna pozycja z „Zarządzaj”
    expect(pozycje.filter((p) => p.akcja.etykieta !== 'Podłącz').map((p) => p.klucz)).toEqual(['program:brak'])
    expect(pozycje.filter((p) => p.klucz !== 'program:brak').every((p) => p.stany.some((s) => s.tekst === 'Niepodłączony'))).toBe(true)
    expect(tekst(g)).not.toMatch(/BaseLinker|wFirma/)
    expect(g[0]!.pozycje.find((p) => p.klucz === 'platforma:shoper')!.akcja.href).toBe('/ustawienia/kanaly/nowy?platforma=shoper')
  })

  it('kanał z kontem: ostatni udany odczyt i zapis wyłączony; platforma z kontem nie dubluje się jako „Podłącz”', () => {
    const g = pozycjeIntegracji(
      {
        ...pusta,
        kanaly: [{ kod: 'woo-1', channel: 'WOO', channelAccountId: '1', name: 'Sklep', rodzaj: 'WooCommerce', active: true, stockMode: 'CIEN', statusMode: 'CIEN', trackingMode: 'CIEN', testOk: true, lastReadAt: new Date('2026-11-09T17:09:00Z'), readError: null }],
      },
      NOW,
    )
    const s = g[0]!.pozycje
    expect(s.map((p) => p.klucz)).toEqual(['kanal:woo-1', 'platforma:shoper', 'platforma:allegro'])
    expect(s[0]).toMatchObject({ logo: 'woocommerce', szczegol: 'WooCommerce, konto 1', akcja: { etykieta: 'Zarządzaj', href: '/ustawienia/kanaly/woo-1' } })
    expect(s[0]!.stany).toEqual([
      { ton: 'sukces', tekst: 'Ostatni udany odczyt: dziś 18:09' },
      { ton: 'neutralny', tekst: 'Zapis wyłączony' },
    ])
  })

  it('kanał bez nazwy platformy (rodzaj = klucz adaptera) nie pokazuje klucza adaptera', () => {
    const k = { kod: 'e-1', channel: 'EASYTOOLS' as const, channelAccountId: 'acme', name: 'EasyTools', rodzaj: 'easytools.v1', active: true, stockMode: 'CIEN' as const, statusMode: 'CIEN' as const, trackingMode: 'CIEN' as const, testOk: null, lastReadAt: null, readError: null }
    expect(pozycjeIntegracji({ ...pusta, kanaly: [k] }, NOW)[0]!.pozycje[0]!.szczegol).toBe('Konto acme')
  })

  it('kanał z błędem odczytu i w pracy; wyłączone konto', () => {
    const k = { kod: 'a-1', channel: 'ALLEGRO' as const, channelAccountId: '1', name: 'Allegro', rodzaj: 'Allegro', active: true, stockMode: 'PRACA' as const, statusMode: 'PRACA' as const, trackingMode: 'PRACA' as const, testOk: true, lastReadAt: null, readError: 'odczyt zamówień ma błędy' }
    const s = pozycjeIntegracji({ ...pusta, kanaly: [k, { ...k, kod: 'a-2', active: false }] }, NOW)[0]!.pozycje
    expect(s[0]!.stany.map((x) => x.tekst)).toEqual(['Odczyt zamówień z błędami', 'Zapisuje stany i statusy'])
    expect(s[1]!.stany.map((x) => x.tekst)).toEqual(['Konto wyłączone'])
  })

  it('firma ACME: BaseLinker i wFirma widoczne, faktury wyłączone = „Zapis wyłączony”; przewoźnik z kluczami', () => {
    const g = pozycjeIntegracji(
      {
        ...pusta,
        maBl: true,
        dokumenty: { ...pusta.dokumenty, program: 'wfirma', maWfirme: true },
        przewoznicy: [{ ...pusta.przewoznicy[0]!, sekrety: [{ ...pusta.przewoznicy[0]!.sekrety[0]!, ustawiony: true, zrodlo: 'panel' }], reguly: [{ id: 'r', priority: 1, carrier: 'DPD', adapterKey: 'dpd.zapis.v1', nadawanie: false }, { id: 'r2', priority: 2, carrier: 'DPD', adapterKey: 'dpd.zapis.v1', nadawanie: false }], test: { ok: true, message: 'ok', at: '2026-11-09T09:00:00Z' } }],
      },
      NOW,
    )
    expect(g[0]!.pozycje.at(-1)).toMatchObject({ nazwa: 'BaseLinker', akcja: { href: '/ustawienia/przeprowadzka' } })
    expect(g[1]!.pozycje[0]).toMatchObject({ logo: 'dpd', szczegol: '2 reguły wysyłki', akcja: { etykieta: 'Zarządzaj' } })
    expect(g[1]!.pozycje[0]!.stany.map((s) => s.tekst)).toEqual(['Połączenie działa (test dziś 10:00)', 'Zapis wyłączony'])
    expect(g[2]!.pozycje.map((p) => [p.nazwa, p.stany.map((s) => s.tekst)])).toEqual([
      ['wFirma', ['Podłączony', 'Zapis wyłączony']],
      ['KSeF', ['Niepodłączony']],
    ])
  })

  it('KSeF bez tokenu ostrzega; poczta z błędem; AI i klucze agentów', () => {
    const g = pozycjeIntegracji(
      {
        ...pusta,
        dokumenty: { ...pusta.dokumenty, program: 'ksef' },
        poczta: { wlaczona: true, host: 'smtp.firma.pl', nadawca: 'sklep@firma.pl', ostatniBlad: new Date('2026-11-08T10:00:00Z') },
        ai: { model: 'claude-x', zrodloKlucza: 'firma', packshot: true },
        klucze: { agentow: 2, innych: 0, ostatnieUzycieAgenta: null },
      },
      NOW,
    )
    expect(g[2]!.pozycje.find((p) => p.nazwa === 'KSeF')!.stany).toEqual([{ ton: 'ostrzezenie', tekst: 'Brak tokenu KSeF' }])
    expect(g[3]!.pozycje[0]).toMatchObject({ szczegol: 'smtp.firma.pl, nadawca sklep@firma.pl', stany: [{ ton: 'blad', tekst: 'Ostatni błąd wysyłki: wczoraj 11:00' }] })
    expect(g[4]!.pozycje.map((p) => p.akcja.etykieta)).toEqual(['Zarządzaj', 'Zarządzaj', 'Podłącz'])
  })
})
