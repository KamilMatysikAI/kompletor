// Lista wysyłkowa (kompakt) dla odbioru przewoźnika: kurier podpisuje odbiór paczek.
// Z danych odbiorcy tylko imię, nazwisko i miasto.
import type { ListaWysylkowaDane } from './typy'
import { FONT, FONT_B, MARGINES, doBufora, formatData, formatDataGodzina, numerZamowieniaTekst, nowyDokument, odbiorcaTekst, stopki, tekstJednaLinia } from './wspolne'
import { SZER_TABELI, miesciSie, naglowekListy, rysujTabele, type Kolumna } from './tabela'

const KOLUMNY: Kolumna[] = [
  { tytul: 'LP', szerokosc: 26, align: 'right' },
  { tytul: 'ZAMÓWIENIE', szerokosc: 82, pogrubiona: true },
  { tytul: 'PRZEWOŹNIK', szerokosc: 70 },
  { tytul: 'PACZKI', szerokosc: 44, align: 'right', pogrubiona: true },
  { tytul: 'NUMER NADANIA', szerokosc: 160, zawijaj: true },
  { tytul: 'ODBIORCA', szerokosc: SZER_TABELI - 26 - 82 - 70 - 44 - 160, zawijaj: true },
]

export async function listaWysylkowa(dane: ListaWysylkowaDane): Promise<Buffer> {
  const doc = nowyDokument({ tytul: `Lista wysyłkowa ${formatData(dane.dataOdbioru)}`, utworzono: dane.wydrukowano })
  const tytul = 'Lista wysyłkowa'
  const podtytul = [`Odbiór: ${formatDataGodzina(dane.dataOdbioru)}`, dane.opisOdbioru, `zamówień: ${dane.zamowienia.length}`]
    .filter(Boolean)
    .join(' · ')
  const naglowek = () => naglowekListy(doc, tytul, podtytul, dane.logo)

  const zamowienia = [...dane.zamowienia].sort(
    (a, b) => a.przewoznik.localeCompare(b.przewoznik, 'pl') || numerZamowieniaTekst(a.zamowienie).localeCompare(numerZamowieniaTekst(b.zamowienie), 'pl', { numeric: true }),
  )
  let y = rysujTabele(
    doc,
    KOLUMNY,
    zamowienia.map((z, i) => [
      String(i + 1),
      numerZamowieniaTekst(z.zamowienie),
      z.przewoznik,
      String(z.liczbaPaczek),
      z.numeryNadania.join(', ') || '—',
      odbiorcaTekst(z.odbiorca),
    ]),
    naglowek(),
    naglowek,
  )

  // Suma paczek per przewoźnik + miejsce na podpis kuriera — razem, żeby nie rozjechały się na strony.
  const sumy = new Map<string, { zamowien: number; paczek: number }>()
  for (const z of zamowienia) {
    const s = sumy.get(z.przewoznik) ?? { zamowien: 0, paczek: 0 }
    s.zamowien += 1
    s.paczek += z.liczbaPaczek
    sumy.set(z.przewoznik, s)
  }
  const hBloku = 30 + 16 * (sumy.size + 1) + 90
  if (!miesciSie(y, hBloku + 12)) {
    doc.addPage()
    y = naglowek()
  }
  y += 14
  tekstJednaLinia(doc, 'Podsumowanie', MARGINES, y, 200, { font: FONT_B, rozmiar: 11 })
  y += 18
  const wiersz = (a: string, b: string, c: string, pogrubiony = false) => {
    const font = pogrubiony ? FONT_B : FONT
    tekstJednaLinia(doc, a, MARGINES, y, 160, { font, rozmiar: 10 })
    tekstJednaLinia(doc, b, MARGINES + 160, y, 90, { font, rozmiar: 10, align: 'right' })
    tekstJednaLinia(doc, c, MARGINES + 250, y, 90, { font, rozmiar: 10, align: 'right' })
    y += 16
  }
  wiersz('Przewoźnik', 'Zamówień', 'Paczek', true)
  let razemPaczek = 0
  for (const [przewoznik, s] of sumy) {
    wiersz(przewoznik, String(s.zamowien), String(s.paczek))
    razemPaczek += s.paczek
  }
  wiersz('Razem', String(zamowienia.length), String(razemPaczek), true)

  y += 30
  const pole = (x: number, w: number, opis: string) => {
    doc.save().moveTo(x, y + 30).lineTo(x + w, y + 30).lineWidth(0.7).stroke().restore()
    tekstJednaLinia(doc, opis, x, y + 34, w, { rozmiar: 8, align: 'center' })
  }
  const w = (SZER_TABELI - 40) / 3
  pole(MARGINES, w, 'Data i godzina odbioru')
  pole(MARGINES + w + 20, w, 'Wydał (magazyn)')
  pole(MARGINES + 2 * (w + 20), w, 'Podpis kuriera')

  stopki(doc, `Lista wysyłkowa · wydruk ${formatDataGodzina(dane.wydrukowano)} · drukował(a): ${dane.drukujacy}`)
  return doBufora(doc)
}
