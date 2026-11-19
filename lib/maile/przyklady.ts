// Fikcyjne dane do testów i podglądów (bez danych prawdziwych osób i firm; domeny example.com z RFC 2606).
import type { DaneMaili } from './mail'
import type { KontekstMarki, RodzajMaila } from './typy'

export const KONTEKST_PRZYKLADOWY: KontekstMarki = {
  firma: {
    nazwa: 'Firma Testowa sp. z o.o.',
    adres: ['ul. Przykładowa 1', '00-000 Testowo'],
    nip: '000-000-00-00',
    email: 'kontakt@example.com',
    telefon: '+48 000 000 000',
    www: 'https://example.com',
    emailBiura: 'biuro@example.com',
  },
  sklep: {
    nazwa: 'Żółwik',
    logoUrl: 'https://example.com/logo.png',
    logoSzerokosc: 160,
    kolorGlowny: '#2f6b3a',
    odpowiedzDo: 'sklep@example.com',
    www: 'https://sklep.example.com',
    odbiorOsobisty: {
      adres: ['Sklep Żółwik', 'ul. Przykładowa 1', '00-000 Testowo'],
      godziny: ['poniedziałek-piątek 9:00-17:00', 'sobota 10:00-14:00'],
      uwagi: 'Wejście od podwórza, dzwonek „Sklep”.',
    },
  },
}

// Minimalny poprawny nagłówek PDF wystarcza do testów i podglądu (treść nie jest renderowana).
export const PDF_PRZYKLADOWY = new TextEncoder().encode('%PDF-1.4\n% fikcyjna faktura do testów\n%%EOF\n')

export const DANE_PRZYKLADOWE: { [R in RodzajMaila]: DaneMaili[R] } = {
  'brak-platnosci': {
    imie: 'Jan',
    numerZamowienia: 'ZAM-2026-00123',
    kwotaGr: 1_234_50,
    linkPlatnosci: 'https://platnosci.example.com/zaplac?zamowienie=ZAM-2026-00123&kwota=1234.50',
    dniDoAnulowania: 5,
    terminAnulowania: new Date('2026-10-30T12:00:00Z'),
    pozycje: [
      { nazwa: 'Kubek ceramiczny 300 ml', ilosc: 2 },
      { nazwa: 'Zestaw <Prezent> „Jesień” & dzbanek', ilosc: 1 },
    ],
  },
  'nieudana-platnosc': {
    imie: 'Jan',
    numerZamowienia: 'ZAM-2026-00123',
    kwotaGr: 1_234_50,
    rachunek: '12345678901234567890123456',
    terminAnulowania: new Date('2026-10-30T12:00:00Z'),
    towarZwolniony: true,
    pozycje: [
      { nazwa: 'Kubek ceramiczny 300 ml', ilosc: 2 },
      { nazwa: 'Zestaw <Prezent> „Jesień” & dzbanek', ilosc: 1 },
    ],
  },
  faktura: {
    imie: 'Jan',
    numerFaktury: 'FV 123/10/2026',
    numerZamowienia: 'ZAM-2026-00123',
    pdf: { tresc: PDF_PRZYKLADOWY },
  },
  'gotowe-do-odbioru': {
    imie: 'Jan',
    numerZamowienia: 'ZAM-2026-00123',
    odbiorDo: new Date('2026-11-06T12:00:00Z'),
    pozycje: [{ nazwa: 'Kubek ceramiczny 300 ml', ilosc: 2 }],
  },
  'blad-faktury': {
    numerZamowienia: 'ZAM-2026-00123',
    trescBledu: 'wFirma: invoices/add zwróciło ERROR\nKontrahent: brak pola <zip> (kod pocztowy)',
    linkDoZamowienia: 'https://panel.example.com/zamowienia/ZAM-2026-00123',
    kiedy: new Date('2026-10-25T13:05:00Z'),
  },
  'niski-stan': {
    sku: 'KUB-300',
    nazwa: 'Kubek ceramiczny 300 ml',
    dostepne: 3,
    prog: 10,
    linkDoProduktu: 'https://panel.example.com/produkty/KUB-300',
  },
  'reset-hasla': {
    email: 'osoba@example.com',
    link: 'https://panel.example.com/nowe-haslo?t=przyklad-tokenu-do-podgladu',
    waznyDo: new Date('2026-10-25T14:05:00Z'),
  },
  zaproszenie: {
    email: 'osoba@example.com',
    link: 'https://panel.example.com/zaproszenie?t=przyklad-tokenu-do-podgladu',
    rola: 'Magazyn',
    waznyDo: new Date('2026-11-01T13:05:00Z'),
  },
  'zwrot-przyjety': { imie: 'Jan', numerZamowienia: 'ZAM-2026-00123', pozycje: [{ nazwa: 'Kubek ceramiczny 300 ml', ilosc: 1 }] },
  'reklamacja-przyjeta': { imie: 'Jan', numerZamowienia: 'ZAM-2026-00123', pozycje: [{ nazwa: 'Kubek ceramiczny 300 ml', ilosc: 1 }] },
  'zwrot-pieniedzy': { imie: 'Jan', numerZamowienia: 'ZAM-2026-00123', pozycje: [{ nazwa: 'Kubek ceramiczny 300 ml', ilosc: 1 }] },
}
