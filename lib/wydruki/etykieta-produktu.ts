// Etykieta produktu (dawna „etykieta tył” z BL): nazwa, skład/opis, masa, partia, data.
// Rozmiar parametrem (domyślnie 100 × 50 mm); tekst zmniejszany, aż zmieści się na etykiecie.
import type { EtykietaProduktuDane, EtykietaProduktuOpcje } from './typy'
import { FONT, FONT_B, MM, doBufora, formatData, nowyDokument, tekstJednaLinia, wysokoscTekstu, type Dokument } from './wspolne'

const MARG = 3 * MM

/** Największy rozmiar z [min, max], przy którym tekst mieści się w polu; poniżej min — min. */
function dopasujRozmiar(
  doc: Dokument,
  tekst: string,
  font: string,
  szerokosc: number,
  wysokosc: number,
  max: number,
  min: number,
): number {
  for (let r = max; r > min; r -= 0.5) {
    if (wysokoscTekstu(doc, tekst, font, r, szerokosc) <= wysokosc) return r
  }
  return min
}

export async function etykietaProduktu(
  dane: EtykietaProduktuDane,
  opcje: EtykietaProduktuOpcje = {},
): Promise<Buffer> {
  const szer = (opcje.szerokoscMm ?? 100) * MM
  const wys = (opcje.wysokoscMm ?? 50) * MM
  if (szer < 20 * MM || wys < 15 * MM) throw new Error('Etykieta musi mieć co najmniej 20 × 15 mm')
  const kopie = Math.max(1, Math.floor(opcje.kopie ?? 1))
  const doc = nowyDokument({ tytul: `Etykieta ${dane.nazwa}`, rozmiar: [szer, wys], utworzono: opcje.utworzono })

  for (let k = 0; k < kopie; k++) {
    if (k > 0) doc.addPage({ size: [szer, wys], margin: 0 })
    rysuj(doc, dane, szer, wys)
  }
  return doBufora(doc)
}

function rysuj(doc: Dokument, d: EtykietaProduktuDane, szer: number, wys: number): void {
  const w = szer - 2 * MARG
  const skala = Math.min(1, wys / (50 * MM))

  // Dół: masa · partia · data (jedna albo dwie linie).
  const dol: string[] = []
  if (d.masa?.trim()) dol.push(`Masa netto: ${d.masa.trim()}`)
  if (d.numerPartii?.trim()) dol.push(`Partia: ${d.numerPartii.trim()}`)
  const data = d.data instanceof Date ? formatData(d.data) : d.data?.trim()
  const linieDolu: string[] = []
  if (dol.length) linieDolu.push(dol.join('   '))
  if (data) linieDolu.push(`${d.etykietaDaty?.trim() || 'Najlepiej spożyć przed'}: ${data}`)
  const rDolu = Math.max(6, 8 * skala)
  const hDolu = linieDolu.length * (rDolu + 3)

  // Nazwa: maks. 40% wysokości, od 14 pt w dół; bez składu całe pole nad stopką (26.10.2026).
  const sklad = d.sklad?.trim()
  const hDostepna = wys - 2 * MARG - hDolu - (hDolu ? 3 : 0)
  const hNazwyMax = sklad ? hDostepna * 0.4 : hDostepna
  const rNazwy = dopasujRozmiar(doc, d.nazwa, FONT_B, w, hNazwyMax, 14 * skala, 7)
  doc.font(FONT_B).fontSize(rNazwy).text(d.nazwa, MARG, MARG, { width: w, height: hNazwyMax, ellipsis: '…' })
  const hNazwy = Math.min(wysokoscTekstu(doc, d.nazwa, FONT_B, rNazwy, w), hNazwyMax)

  if (sklad) {
    const yS = MARG + hNazwy + 3
    const hS = hDostepna - hNazwy - 3
    const rS = dopasujRozmiar(doc, sklad, FONT, w, hS, 9 * skala, 5)
    doc.font(FONT).fontSize(rS).text(sklad, MARG, yS, { width: w, height: hS, ellipsis: '…', lineGap: 0 })
  }

  let y = wys - MARG - hDolu
  if (hDolu) doc.save().moveTo(MARG, y - 2).lineTo(MARG + w, y - 2).lineWidth(0.5).stroke().restore()
  for (const l of linieDolu) {
    tekstJednaLinia(doc, l, MARG, y + 1, w, { font: FONT_B, rozmiar: rDolu })
    y += rDolu + 3
  }
}
