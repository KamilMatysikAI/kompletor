// raport sprzedaży jako arkusz XLSX (Podsumowanie, Okresy, Kanały, Produkty). Same agregaty z
// `raportSprzedazy`, bez danych klientów. Kwoty jako liczby z formatem, produkt bez ceny zakupu z opisem zamiast marży.
import type { Miary, RaportSprzedazy } from '@/lib/api/raporty-sprzedaz'
import { rozbicieWalut, zmianaProcent } from '@/lib/api/raporty-sprzedaz'
import { OPIS_TRYBU, porownanieNiepelne, uwagaPorownania } from '@/lib/api/raporty-porownanie'
import type { Arkusz, KolumnaArkusza, Komorka, TypKolumny } from '@/lib/arkusz/xlsx'
import { notkaWalut, obceZApi, opisWalut } from '@/lib/panel/sumy-walut'

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
  // kwoty powyżej są w złotych, z obcymi walutami przeliczonymi po kursie średnim NBP (informacyjnie);
  // tu rozbicie: kwota w walucie, kurs, data kursu i kwota w złotych (waluta bez kursu: poza sumą)
  { naglowek: 'W tym inne waluty (kurs średni NBP)', typ: 'tekst', szerokosc: 40 },
]

function miary(m: Miary): Komorka[] {
  return [m.zamowien, m.wartoscBrutto, m.sredniaWartosc, m.produktyNetto, m.produktyBrutto, m.sztuk, m.kg, m.zwrotyBrutto, m.marza === null ? null : m.koszt, m.marza, m.marzaProcent, m.bezCenyZakupuNetto, m.anulowanych, m.anulowaneBrutto, opisWalut(obceZApi(m.inneWaluty)) || null]
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
  // porównanie wg wyboru (null = bez porównania: bez kolumn porównania); przy niepełnym bez zmiany %
  const P = r.poprzedni
  const niepelne = P ? porownanieNiepelne(P) : false
  const uwaga = P ? uwagaPorownania(P) : null
  // pusta komórka zamiast liczby porównania, gdy cały okres porównania jest przed początkiem danych
  const pv = (v: number | null): number | null => (P?.bezDanych ? null : v)
  const zm = (a: number | null, b: number | null): number | null => (niepelne || a === null || b === null ? null : zmianaProcent(a, b))
  const kolP = (...k: Komorka[]): Komorka[] => (P ? k : [])
  const walutyP = P && !P.bezDanych ? P.razem.inneWaluty : []
  const podsumowanie: Arkusz = {
    nazwa: 'Podsumowanie',
    kolumny: [
      { naglowek: 'Miara', typ: 'tekst', szerokosc: 46 },
      { naglowek: `${r.od} – ${r.do}`, typ: 'liczba', szerokosc: 24 },
      ...(P
        ? [
            { naglowek: `Porównanie ${P.od} – ${P.do} (${OPIS_TRYBU[P.tryb]})`, typ: 'liczba', szerokosc: 40 } as KolumnaArkusza,
            { naglowek: 'Zmiana %', typ: 'procent', szerokosc: 12 } as KolumnaArkusza,
          ]
        : []),
    ],
    wiersze: [
      ...PODSUMOWANIE.map(([n, typ, f]): Komorka[] => {
        const a = f(r.razem)
        const b = P ? pv(f(P.razem)) : null
        return [n, { v: a, typ }, ...kolP({ v: b, typ }, typ === 'procent' ? null : zm(a, b))]
      }),
      // przy porównaniu bez danych (liczby porównania puste) waluty porównania też puste (przegląd r1)
      ...(r.razem.inneWaluty.length || walutyP.length
        ? [
            ['W tym inne waluty (kurs średni NBP, informacyjnie)', opisWalut(obceZApi(r.razem.inneWaluty)) || null, ...kolP(opisWalut(obceZApi(walutyP)) || null, null)] as Komorka[],
            ['Objaśnienie', notkaWalut(obceZApi(r.razem.inneWaluty.length ? r.razem.inneWaluty : walutyP)), ...kolP(null, null)] as Komorka[],
          ]
        : []),
      ...(uwaga ? [['Uwaga do porównania', uwaga, ...kolP(null, null)] as Komorka[]] : []),
      ['Kanał', opisKonta, ...kolP(null, null)],
      ['Zamówienia z kanału spoza Kompletora (nie w raporcie)', { v: r.pozaKompletorem.zamowien, typ: 'calkowita' }, ...kolP(null, null)],
      ['Ich wartość brutto', { v: r.pozaKompletorem.brutto, typ: 'kwota' }, ...kolP(null, null)],
      ...(r.pozaKompletorem.inneWaluty.length ? [['W tym inne waluty', opisWalut(obceZApi(r.pozaKompletorem.inneWaluty)), ...kolP(null, null)] as Komorka[]] : []),
      // data w czasie polskim jak reszta raportu (komórka daty, nie tekst „… UTC”)
      ['Stan na', new Date(r.stanNa), ...kolP(null, null)],
    ],
  }
  // kolumny porównania w Okresach i Kanałach (tylko z porównaniem)
  const KOL_POR: KolumnaArkusza[] = P
    ? [
        { naglowek: 'Porównanie: zamówienia', typ: 'calkowita' },
        { naglowek: 'Porównanie: wartość zamówień brutto', typ: 'kwota', szerokosc: 22 },
        { naglowek: 'Porównanie: sprzedaż produktów netto', typ: 'kwota', szerokosc: 22 },
        { naglowek: 'Porównanie: marża netto', typ: 'kwota' },
        { naglowek: 'Zmiana wartości brutto %', typ: 'procent' },
        { naglowek: 'Porównanie: uwagi', typ: 'tekst', szerokosc: 28 },
      ]
    : []
  const miaryPor = (a: Miary, b: Miary | null, niepelnyWiersz: boolean, uw: string | null): Komorka[] =>
    !P
      ? []
      : !b || P.bezDanych
        ? [null, null, null, null, null, uw ?? (P.bezDanych ? 'brak danych' : 'bez pary')]
        : [b.zamowien, b.wartoscBrutto, b.produktyNetto, b.marza, niepelnyWiersz ? null : zmianaProcent(a.wartoscBrutto, b.wartoscBrutto), uw]
  const okresy: Arkusz = {
    nazwa: 'Okresy',
    kolumny: [
      { naglowek: OPIS_GRUPOWANIA[r.grupuj], typ: 'tekst', szerokosc: 14 },
      { naglowek: 'Do', typ: 'tekst', szerokosc: 12 },
      ...MIARY_KOLUMNY,
      ...(P ? [{ naglowek: 'Porównanie od', typ: 'tekst', szerokosc: 13 } as KolumnaArkusza, { naglowek: 'Porównanie do', typ: 'tekst', szerokosc: 13 } as KolumnaArkusza] : []),
      ...KOL_POR,
    ],
    wiersze: r.okresy.map((o) => [
      o.okres,
      o.okresDo,
      ...miary(o),
      ...(P ? [o.porownanie?.od ?? null, o.porownanie?.do ?? null] : []),
      ...miaryPor(o, o.porownanie, o.porownanie?.daneNiepelne ?? true, o.porownanie?.daneNiepelne ? 'dane niepełne' : null),
    ]),
  }
  const konta: Arkusz = {
    nazwa: 'Kanały',
    kolumny: [{ naglowek: 'Konto kanału', typ: 'tekst', szerokosc: 30 }, ...MIARY_KOLUMNY, ...KOL_POR.map((k, i) => (i === 1 && P ? { ...k, naglowek: `Porównanie ${P.od} – ${P.do}: wartość zamówień brutto`, szerokosc: 34 } : k))],
    wiersze: r.konta.map((k) => [
      k.nazwa,
      ...miary(k),
      ...miaryPor(k, k.porownanie, k.porownanie?.daneNiepelne ?? true, k.porownanie?.daneNiepelne ? (k.porownanie.daneOd ? `dane od ${k.porownanie.daneOd}` : 'brak danych') : null),
    ]),
  }
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
      ...(P
        ? [
            { naglowek: `Porównanie ${P.od} – ${P.do}: ilość`, typ: 'liczba', szerokosc: 26 } as KolumnaArkusza,
            { naglowek: 'Porównanie: sprzedaż netto', typ: 'kwota', szerokosc: 20 } as KolumnaArkusza,
            { naglowek: 'Zmiana sprzedaży netto %', typ: 'procent' } as KolumnaArkusza,
          ]
        : []),
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
      ...(P && p.porownanie && !P.bezDanych
        ? [p.jednostka === 'KG' ? ({ v: p.porownanie.ilosc / 1000, typ: 'kg' } as Komorka) : ({ v: p.porownanie.ilosc, typ: 'calkowita' } as Komorka), p.porownanie.netto, zm(p.netto, p.porownanie.netto)]
        : P
          ? [null, null, null]
          : []),
    ]),
  }
  // arkusz „Waluty” (jak tabela na ekranie Raporty) tylko, gdy w zakresie jest więcej niż jedna waluta
  const rw = rozbicieWalut(r.razem)
  const waluty: Arkusz | null = rw.length
    ? {
        nazwa: 'Waluty',
        kolumny: [
          { naglowek: 'Waluta', typ: 'tekst', szerokosc: 10 },
          { naglowek: 'Zamówienia', typ: 'calkowita' },
          { naglowek: 'Wartość brutto w walucie', typ: 'kwota', szerokosc: 22 },
          { naglowek: 'Kurs średni NBP', typ: 'liczba', szerokosc: 16 },
          { naglowek: 'Data kursu', typ: 'tekst', szerokosc: 12 },
          { naglowek: 'Wartość w złotych', typ: 'kwota', szerokosc: 18 },
          { naglowek: 'Udział %', typ: 'procent' },
        ],
        wiersze: rw.map((w) => [w.waluta, w.zamowien, w.brutto, w.kurs, w.dataKursu ?? (w.waluta === 'PLN' ? null : 'brak kursu'), w.bruttoPln, w.udzial]),
      }
    : null
  return waluty ? [podsumowanie, okresy, konta, produkty, waluty] : [podsumowanie, okresy, konta, produkty]
}
