// Spis produktów (np. do inwentaryzacji strefy): lokalizacja, stany i pusta kolumna na policzoną ilość.
import type { PozycjaSpisu, SpisProduktowDane } from './typy'
import { MARGINES, doBufora, formatDataGodzina, formatIlosc, nowyDokument, sortujPoLokalizacji, stopki, tekstJednaLinia, FONT_B } from './wspolne'
import { SZER_TABELI, miesciSie, naglowekListy, rysujTabele, type Kolumna } from './tabela'

const KOLUMNY: Kolumna[] = [
  { tytul: 'LOKALIZACJA', szerokosc: 66, pogrubiona: true },
  { tytul: 'NAZWA', szerokosc: SZER_TABELI - 66 - 82 - 62 - 62 - 62 - 56, zawijaj: true },
  { tytul: 'SKU', szerokosc: 82 },
  { tytul: 'FIZYCZNY', szerokosc: 62, align: 'right' },
  { tytul: 'ZAREZERW.', szerokosc: 62, align: 'right' },
  { tytul: 'DOSTĘPNY', szerokosc: 62, align: 'right', pogrubiona: true },
  { tytul: 'POLICZONO', szerokosc: 56 },
]

/** Pozycje spisu po filtrze strefy i sortowaniu po lokalizacji — osobno, żeby dało się to testować bez PDF. */
export function pozycjeSpisu(dane: Pick<SpisProduktowDane, 'strefa' | 'pozycje'>): PozycjaSpisu[] {
  const strefa = dane.strefa?.trim().toLocaleLowerCase('pl')
  const wybrane = strefa
    ? dane.pozycje.filter((p) => p.strefa?.trim().toLocaleLowerCase('pl') === strefa)
    : dane.pozycje
  return sortujPoLokalizacji(wybrane)
}

export async function spisProduktow(dane: SpisProduktowDane): Promise<Buffer> {
  const strefa = dane.strefa?.trim()
  const pozycje = pozycjeSpisu(dane)
  const tytul = strefa ? `Spis produktów — strefa: ${strefa}` : 'Spis produktów'
  const doc = nowyDokument({ tytul, utworzono: dane.wydrukowano })
  const podtytul = `Stan na ${formatDataGodzina(dane.wydrukowano)} · pozycji: ${pozycje.length}`
  const naglowek = () => naglowekListy(doc, tytul, podtytul)

  const y = rysujTabele(
    doc,
    KOLUMNY,
    pozycje.map((p) => {
      const dostepny = p.dostepny ?? p.fizyczny - p.zarezerwowany
      return [
        p.lokalizacja?.trim() || '—',
        p.nazwa,
        p.sku ?? '',
        formatIlosc(p.fizyczny, p.jednostka),
        formatIlosc(p.zarezerwowany, p.jednostka),
        { tekst: formatIlosc(dostepny, p.jednostka), pogrubiona: true },
        '',
      ]
    }),
    naglowek(),
    naglowek,
  )
  if (pozycje.length === 0) {
    tekstJednaLinia(doc, 'Brak produktów w tej strefie.', MARGINES, y + 8, SZER_TABELI, { rozmiar: 10 })
  } else if (miesciSie(y, 60)) {
    tekstJednaLinia(doc, 'Spisał(a): ………………………………   Data: ………………', MARGINES, y + 36, SZER_TABELI, {
      font: FONT_B,
      rozmiar: 9,
    })
  }

  stopki(doc, `${tytul} · wydruk ${formatDataGodzina(dane.wydrukowano)} · drukował(a): ${dane.drukujacy}`)
  return doBufora(doc)
}
