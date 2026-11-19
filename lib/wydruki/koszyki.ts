// Kody koszyków do naklejenia (jak „Drukuj podsumowanie” koszyków A–J w BL): A4, 2 × 5 etykiet na stronę,
// na każdej duża nazwa koszyka, kod kreskowy Code 128 i treść kodu (do wpisania ręcznie, gdy czytnik nie złapie).
import { A4, FONT, FONT_B, MM, doBufora, nowyDokument, rysujKod128 } from './wspolne'

const KOLUMNY = 2
const WIERSZE = 5
const MARG = 10 * MM

export async function kodyKoszykow(koszyki: { nazwa: string; kod: string }[], opcje: { firma?: string; utworzono?: Date } = {}): Promise<Buffer> {
  if (!koszyki.length) throw new Error('Brak koszyków do wydruku')
  const doc = nowyDokument({ tytul: 'Kody koszyków', utworzono: opcje.utworzono })
  const szer = (A4.szerokosc - 2 * MARG) / KOLUMNY
  const wys = (A4.wysokosc - 2 * MARG) / WIERSZE
  koszyki.forEach((k, i) => {
    const naStronie = i % (KOLUMNY * WIERSZE)
    if (i > 0 && naStronie === 0) doc.addPage({ size: [A4.szerokosc, A4.wysokosc], margin: 0 })
    const x = MARG + (naStronie % KOLUMNY) * szer
    const y = MARG + Math.floor(naStronie / KOLUMNY) * wys
    // linia cięcia
    doc.save().lineWidth(0.5).dash(3, { space: 3 }).strokeColor('#999999').rect(x, y, szer, wys).stroke().undash().restore()
    const w = szer - 12 * MM
    doc.font(FONT_B).fontSize(54).fillColor('black').text(k.nazwa, x + 6 * MM, y + 6 * MM, { width: w, align: 'center', lineBreak: false })
    rysujKod128(doc, k.kod, x + 6 * MM, y + 30 * MM, w, 16 * MM)
    doc.font(FONT).fontSize(11).text(k.kod, x + 6 * MM, y + 48 * MM, { width: w, align: 'center', lineBreak: false })
    if (opcje.firma) doc.fontSize(8).fillColor('#555555').text(`Koszyk · ${opcje.firma}`, x + 6 * MM, y + wys - 8 * MM, { width: w, align: 'center', lineBreak: false })
  })
  return doBufora(doc)
}
