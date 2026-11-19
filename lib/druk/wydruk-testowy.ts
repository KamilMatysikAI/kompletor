// „Wydruk testowy” z Ustawienia → Druk: PDF A4 albo ZPL z nazwą stanowiska, rolą, datą i polskimi znakami,
// bez danych zamówień. Na zewnątrz typ z istniejącego kontraktu (`lista` na zwykłej drukarce, `etykieta` na termicznej),
// żeby przyjął go także agent 0.1.0.
import { A4, MARGINES, doBufora, formatDataGodzina, nowyDokument, FONT, FONT_B } from '@/lib/wydruki/wspolne'
import { jestTermiczna, opisRoli, type TypZlecenia } from './role'
import { etykietaZpl, PUNKTY_NA_MM, tekstZpl } from './zpl'

export const ZDANIE_TESTOWE = 'zażółć gęślą jaźń · ZAŻÓŁĆ GĘŚLĄ JAŹŃ'

export interface DaneTestu {
  stanowisko: string
  kod: string
  rola: string
  drukarka?: string
  data: Date
}

export const typWydrukuTestowego = (rola: string): TypZlecenia => (jestTermiczna(rola) ? 'etykieta' : 'lista')

const linie = (d: DaneTestu) => [
  `Stanowisko: ${d.stanowisko} (${d.kod})`,
  `Drukarka: ${opisRoli(d.rola)} — ${d.rola}${d.drukarka ? ` — ${d.drukarka}` : ''}`,
  `Zlecono: ${formatDataGodzina(d.data)}`,
  ZDANIE_TESTOWE,
]

export async function testowyPdf(d: DaneTestu): Promise<Buffer> {
  const doc = nowyDokument({ tytul: 'Wydruk testowy Kompletora', utworzono: d.data })
  doc.lineWidth(1).rect(MARGINES, MARGINES, A4.szerokosc - 2 * MARGINES, A4.wysokosc - 2 * MARGINES).stroke()
  doc.font(FONT_B).fontSize(26).text('Wydruk testowy Kompletora', MARGINES + 20, MARGINES + 30, { width: A4.szerokosc - 2 * MARGINES - 40 })
  doc.moveDown(1)
  doc.font(FONT).fontSize(14)
  for (const l of linie(d)) doc.text(l, { width: A4.szerokosc - 2 * MARGINES - 40 }).moveDown(0.4)
  doc.moveDown(1).fontSize(10).fillColor('#444').text('Ramka biegnie wzdłuż marginesów strony: jeśli widać ją z czterech stron, drukarka nie ucina wydruku. Kartkę można wyrzucić.', {
    width: A4.szerokosc - 2 * MARGINES - 40,
  })
  return doBufora(doc)
}

export function testowyZpl(d: DaneTestu): Buffer {
  const W = 100 * PUNKTY_NA_MM
  const m = 3 * PUNKTY_NA_MM
  const t = [`^FO${m},${m}^GB${W - 2 * m},${150 * PUNKTY_NA_MM - 2 * m},4^FS`, tekstZpl({ x: m + 16, y: m + 30, tekst: 'Wydruk testowy', wys: 56, szer: W - 2 * m - 32, srodek: true })]
  let y = m + 140
  for (const l of linie(d)) {
    t.push(tekstZpl({ x: m + 16, y, tekst: l, wys: 32, szer: W - 2 * m - 32, linii: 3 }))
    y += 140
  }
  return etykietaZpl(t)
}

export async function plikTestowy(d: DaneTestu): Promise<{ pdf: Buffer; zpl?: Buffer }> {
  return jestTermiczna(d.rola) ? { pdf: await testowyPdf(d), zpl: testowyZpl(d) } : { pdf: await testowyPdf(d) }
}
