// raport sprzedaży jako arkusz XLSX (Podsumowanie, Okresy, Kanały, Produkty). Same agregaty z
// `raportSprzedazy`, bez danych klientów. Kwoty jako liczby z formatem, produkt bez ceny zakupu z opisem zamiast marży.
import type { Miary, RaportSprzedazy } from '@/lib/api/raporty-sprzedaz'
import { zmianaProcent } from '@/lib/api/raporty-sprzedaz'
import type { Arkusz, KolumnaArkusza, Komorka, TypKolumny } from '@/lib/arkusz/xlsx'

export const BRAK_CENY_ZAKUPU = 'brak ceny zakupu'

const MIARY_KOLUMNY: KolumnaArkusza[] = [
  { naglowek: 'Zamówienia', typ: 'calkowita' },
  { naglowek: 'Wartość zamówień brutto', typ: 'kwota' },
  { naglowek: 'Średnia wartość zamówienia', typ: 'kwota' },
  { naglowek: 'Sprzedaż produktów netto', typ: 'kwota' },
  { naglowek: 'Sprzedaż produktów brutto', typ: 'kwota' },
  // sztuki całkowite (ułamek tylko przy częściowym zwrocie zestawu, zaokrąglony w wyświetlaniu),
  // kilogramy z dokładnością do grama; bez formatu „#,##0.###”, który w Excelu zostawiał „53,”
  { naglowek: 'Sztuki', typ: 'calkowita' },
  { naglowek: 'Kilogramy', typ: 'kg' },
  { naglowek: 'Zwroty brutto', typ: 'kwota' },
  { naglowek: 'Koszt zakupu netto', typ: 'kwota' },
  { naglowek: 'Marża netto', typ: 'kwota' },
  { naglowek: 'Marża %', typ: 'procent' },
  { naglowek: 'Sprzedaż netto bez ceny zakupu', typ: 'kwota' },
  { naglowek: 'Anulowane', typ: 'calkowita' },
  { naglowek: 'Anulowane brutto', typ: 'kwota' },
]

function miary(m: Miary): Komorka[] {
  return [m.zamowien, m.wartoscBrutto, m.sredniaWartosc, m.produktyNetto, m.produktyBrutto, m.sztuk, m.kg, m.zwrotyBrutto, m.marza === null ? null : m.koszt, m.marza, m.marzaProcent, m.bezCenyZakupuNetto, m.anulowanych, m.anulowaneBrutto]
}

const OPIS_GRUPOWANIA = { dzien: 'Dzień', tydzien: 'Tydzień od', miesiac: 'Miesiąc od' } as const

export function arkuszeRaportuSprzedazy(r: RaportSprzedazy, opisKonta: string): Arkusz[] {
  // Podsumowanie ma w jednej kolumnie liczby zamówień, kwoty i procenty: typ (format w Excelu) idzie przy każdym
  // wierszu, nie przy kolumnie („119,” i „729,9” zamiast „119” i „729,90”).
  const PODSUMOWANIE: [string, TypKolumny, (m: Miary) => number | null][] = [
    ['Zamówienia', 'calkowita', (m) => m.zamowien],
    ['Wartość zamówień brutto (z dostawą)', 'kwota', (m) => m.wartoscBrutto],
    ['Średnia wartość zamówienia', 'kwota', (m) => m.sredniaWartosc],
    ['Sprzedaż produktów netto (po zwrotach)', 'kwota', (m) => m.produktyNetto],
    ['Sprzedaż produktów brutto (po zwrotach)', 'kwota', (m) => m.produktyBrutto],
    ['Zwroty brutto', 'kwota', (m) => m.zwrotyBrutto],
    ['Koszt zakupu netto (produkty z ceną zakupu)', 'kwota', (m) => (m.marza === null ? null : m.koszt)],
    ['Marża netto', 'kwota', (m) => m.marza],
    ['Marża %', 'procent', (m) => m.marzaProcent],
    ['Sprzedaż netto bez ceny zakupu (bez marży)', 'kwota', (m) => m.bezCenyZakupuNetto],
    ['Pozycje z nierozpoznaną stawką VAT (netto ze stawki produktu albo 23%)', 'calkowita', (m) => m.nieznanaStawkaPozycji],
    ['Anulowane zamówienia (poza sprzedażą)', 'calkowita', (m) => m.anulowanych],
    ['Anulowane brutto', 'kwota', (m) => m.anulowaneBrutto],
  ]
  const podsumowanie: Arkusz = {
    nazwa: 'Podsumowanie',
    kolumny: [
      { naglowek: 'Miara', typ: 'tekst', szerokosc: 46 },
      { naglowek: `${r.od} – ${r.do}`, typ: 'liczba', szerokosc: 24 },
      { naglowek: `Poprzednio ${r.poprzedni.od} – ${r.poprzedni.do}`, typ: 'liczba', szerokosc: 32 },
      { naglowek: 'Zmiana %', typ: 'procent', szerokosc: 12 },
    ],
    wiersze: [
      ...PODSUMOWANIE.map(([n, typ, f]): Komorka[] => {
        const a = f(r.razem)
        const b = f(r.poprzedni.razem)
        return [n, { v: a, typ }, { v: b, typ }, a === null || b === null || typ === 'procent' ? null : zmianaProcent(a, b)]
      }),
      ['Kanał', opisKonta, null, null],
      ['Zamówienia z kanału spoza Kompletora (nie w raporcie)', { v: r.pozaKompletorem.zamowien, typ: 'calkowita' }, null, null],
      ['Ich wartość brutto', { v: r.pozaKompletorem.brutto, typ: 'kwota' }, null, null],
      // data w czasie polskim jak reszta raportu (komórka daty, nie tekst „… UTC”)
      ['Stan na', new Date(r.stanNa), null, null],
    ],
  }
  const okresy: Arkusz = {
    nazwa: 'Okresy',
    kolumny: [{ naglowek: OPIS_GRUPOWANIA[r.grupuj], typ: 'tekst', szerokosc: 14 }, { naglowek: 'Do', typ: 'tekst', szerokosc: 12 }, ...MIARY_KOLUMNY],
    wiersze: r.okresy.map((o) => [o.okres, o.okresDo, ...miary(o)]),
  }
  const konta: Arkusz = { nazwa: 'Kanały', kolumny: [{ naglowek: 'Konto kanału', typ: 'tekst', szerokosc: 30 }, ...MIARY_KOLUMNY], wiersze: r.konta.map((k) => [k.nazwa, ...miary(k)]) }
  const produkty: Arkusz = {
    nazwa: 'Produkty',
    kolumny: [
      { naglowek: 'SKU', typ: 'tekst', szerokosc: 18 },
      { naglowek: 'Produkt', typ: 'tekst', szerokosc: 44 },
      { naglowek: 'Jednostka', typ: 'tekst', szerokosc: 10 },
      { naglowek: 'Ilość', typ: 'liczba' },
      { naglowek: 'Zamówienia', typ: 'calkowita' },
      { naglowek: 'Sprzedaż netto', typ: 'kwota' },
      { naglowek: 'Sprzedaż brutto', typ: 'kwota' },
      { naglowek: 'Zwroty brutto', typ: 'kwota' },
      { naglowek: 'Koszt zakupu netto', typ: 'kwota' },
      { naglowek: 'Marża netto', typ: 'kwota' },
      { naglowek: 'Marża %', typ: 'procent' },
      { naglowek: 'Uwagi', typ: 'tekst', szerokosc: 20 },
    ],
    wiersze: r.produkty.map((p) => [
      p.sku,
      p.nazwa,
      p.jednostka === 'KG' ? 'kg' : 'szt.',
      p.jednostka === 'KG' ? { v: p.ilosc / 1000, typ: 'kg' } : { v: p.ilosc, typ: 'calkowita' },
      p.zamowien,
      p.netto,
      p.brutto,
      p.zwrotyBrutto,
      p.koszt,
      p.marza,
      p.marzaProcent,
      p.brakCenyZakupu ? BRAK_CENY_ZAKUPU : null,
    ]),
  }
  return [podsumowanie, okresy, konta, produkty]
}
