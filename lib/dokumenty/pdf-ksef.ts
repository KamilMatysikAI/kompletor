// PDF faktury i korekty z naszego generatora dla firm bez programu do faktur z PDF (program „KSeF
// bezpośrednio”). Treść z tych samych danych co XML wysłany do KSeF (`WejscieFa3`: numer z serii, data, sprzedawca,
// nabywca z bazy, wiersze), plus numer KSeF po przyjęciu. Plik powstaje na żądanie i nie jest zapisywany (dane klienta);
// każde pobranie zostawia wpis w dzienniku podglądów danych klienta, jak PDF z wFirmy (lib/dokumenty/pdf.ts).
// To wizualizacja dla klienta, nie faktura urzędowa: fakturą jest dokument w KSeF (numer KSeF na wydruku).
// XML składa się ponownie z bazy z zamrożoną datą wytworzenia i jego hash porównuje się z hashem
// dokumentu przyjętego w KSeF (`invoiceHash`); rozjazd (ktoś zmienił dane zamówienia albo nabywcy po wysyłce) = wyraźne
// ostrzeżenie na wydruku, że wiążąca jest faktura w KSeF.
import type { PrismaClient } from '@prisma/client'
import { PDFDocument } from 'pdf-lib'
import { PODGLAD_AUDIT } from '../klienci/odczyt'
import { sumaStawki } from '../ksef/fa3/builder'
import type { WejscieFa3 } from '../ksef/fa3/typy'
import { zlozFaktureDoWysylki } from '../ksef/szkice'
import { hashFaktury } from '../ksef/wysylka'
import { A4, doBufora, FONT, FONT_B, MARGINES, nowyDokument, stopki } from '../wydruki/wspolne'
import { szkicKorektyKsef } from '../zwroty/korekta-ksef'
import { BladPdfFaktury, CEL_PDF_FAKTURY, type PdfFaktury } from './pdf'

const zl = (gr: number) => `${(gr / 100).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} zł`
const il = (v: number) => v.toLocaleString('pl-PL', { maximumFractionDigits: 3 })

/** Wizualizacja dokumentu (czysta funkcja: dane → bajty PDF). */
/** tekst ostrzeżenia na wydruku, gdy dane w bazie różnią się od dokumentu przyjętego w KSeF. */
export const OSTRZEZENIE_ROZJAZDU = 'Uwaga: dane w Kompletorze zmieniły się po wysłaniu dokumentu do KSeF. Ten wydruk może różnić się od faktury w KSeF; wiążąca jest faktura w KSeF o podanym numerze KSeF.'
export const OSTRZEZENIE_BEZ_HASHU = 'Uwaga: nie da się potwierdzić, że ten wydruk zgadza się z dokumentem w KSeF; wiążąca jest faktura w KSeF o podanym numerze KSeF.'

export async function rysujFakture(w: WejscieFa3, o: { ksefNumer: string | null; utworzono?: Date; ostrzezenie?: string | null }): Promise<Buffer> {
  const kor = w.rodzaj === 'KOR'
  const doc = nowyDokument({ tytul: `${kor ? 'Korekta' : 'Faktura'} ${w.numer}`, utworzono: o.utworzono })
  const szer = A4.szerokosc - 2 * MARGINES
  let y = MARGINES
  doc.font(FONT_B).fontSize(16).text(`${kor ? 'Faktura korygująca' : 'Faktura VAT'} nr ${w.numer}`, MARGINES, y, { width: szer })
  y = doc.y + 4
  doc.font(FONT).fontSize(9).text(`Data wystawienia: ${w.dataWystawienia}${w.dataDostawy ? `   Data dostawy: ${w.dataDostawy}` : ''}`, MARGINES, y)
  y = doc.y + 2
  doc.text(o.ksefNumer ? `Numer KSeF: ${o.ksefNumer}` : 'Numer KSeF: jeszcze nie nadany (dokument niewysłany albo w przetwarzaniu)', MARGINES, y)
  if (o.ostrzezenie) {
    y = doc.y + 4
    doc.font(FONT_B).fontSize(9).fillColor('#a40000').text(o.ostrzezenie, MARGINES, y, { width: szer })
    doc.fillColor('#000000').font(FONT)
  }
  if (kor && w.korekta) {
    y = doc.y + 2
    doc.text(`Koryguje fakturę ${w.korekta.numer} z ${w.korekta.dataWystawienia}${w.korekta.nrKsef ? ` (KSeF ${w.korekta.nrKsef})` : ''}. Przyczyna: ${w.korekta.przyczyna}`, MARGINES, y, { width: szer })
  }
  y = doc.y + 12
  const kol = szer / 2 - 6
  const adres = (a?: { linia1: string; linia2?: string | null } | null) => [a?.linia1, a?.linia2].filter(Boolean).join('\n')
  doc.font(FONT_B).fontSize(10).text('Sprzedawca', MARGINES, y)
  doc.font(FONT_B).text('Nabywca', MARGINES + kol + 12, y)
  const yStart = doc.y + 2
  doc.font(FONT).fontSize(9).text(`${w.sprzedawca.nazwa}\nNIP ${w.sprzedawca.nip}\n${adres(w.sprzedawca.adres)}`, MARGINES, yStart, { width: kol })
  const yLewa = doc.y
  doc.text(`${w.nabywca.nazwa}${w.nabywca.nip ? `\nNIP ${w.nabywca.nip}` : ''}${w.nabywca.adres ? `\n${adres(w.nabywca.adres)}` : ''}`, MARGINES + kol + 12, yStart, { width: kol })
  y = Math.max(yLewa, doc.y) + 14

  // tabela pozycji
  const k = [
    { t: 'Lp.', w: 24, a: 'left' as const },
    { t: 'Nazwa', w: szer - 24 - 50 - 30 - 70 - 40 - 80, a: 'left' as const },
    { t: 'Ilość', w: 50, a: 'right' as const },
    { t: 'J.m.', w: 30, a: 'left' as const },
    { t: 'Cena brutto', w: 70, a: 'right' as const },
    { t: 'VAT', w: 40, a: 'right' as const },
    { t: 'Wartość brutto', w: 80, a: 'right' as const },
  ]
  const wiersz = (wartosci: string[], font: string) => {
    let x = MARGINES
    let h = 0
    doc.font(font).fontSize(8.5)
    for (let i = 0; i < k.length; i++) h = Math.max(h, doc.heightOfString(wartosci[i] ?? '', { width: k[i]!.w - 4 }))
    if (y + h > A4.wysokosc - MARGINES - 60) {
      doc.addPage()
      y = MARGINES
    }
    for (let i = 0; i < k.length; i++) {
      doc.text(wartosci[i] ?? '', x + 2, y, { width: k[i]!.w - 4, align: k[i]!.a })
      x += k[i]!.w
    }
    y += h + 4
    doc.moveTo(MARGINES, y - 2).lineTo(MARGINES + szer, y - 2).lineWidth(0.3).strokeColor('#999999').stroke()
  }
  wiersz(k.map((c) => c.t), FONT_B)
  w.wiersze.forEach((r, i) => wiersz([String(i + 1), r.nazwa, il(r.ilosc), r.jednostka, zl(r.cenaBruttoGr), r.stawka === 'zw' || r.stawka === 'np' ? r.stawka : `${r.stawka}%`, zl(r.bruttoGr)], FONT))

  // sumy per stawka
  const perStawka = new Map<string, number>()
  for (const r of w.wiersze) perStawka.set(r.stawka, (perStawka.get(r.stawka) ?? 0) + r.bruttoGr)
  y += 8
  let netto = 0
  let vat = 0
  let brutto = 0
  for (const [st, gr] of perStawka) {
    const s = sumaStawki(st, gr)
    netto += s.nettoGr
    vat += s.vatGr
    brutto += gr
    doc.font(FONT).fontSize(9).text(`Stawka ${st === 'zw' || st === 'np' ? st : `${st}%`}: netto ${zl(s.nettoGr)}, VAT ${zl(s.vatGr)}, brutto ${zl(gr)}`, MARGINES, y, { width: szer, align: 'right' })
    y = doc.y + 2
  }
  doc.font(FONT_B).fontSize(11).text(`${kor ? 'Różnica do zapłaty / zwrotu' : 'Razem do zapłaty'}: ${zl(brutto)} (netto ${zl(netto)}, VAT ${zl(vat)})`, MARGINES, y + 4, { width: szer, align: 'right' })
  if (w.podstawaZwolnienia && perStawka.has('zw')) doc.font(FONT).fontSize(8).text(`Podstawa zwolnienia: ${w.podstawaZwolnienia}`, MARGINES, doc.y + 6, { width: szer })
  stopki(doc, 'Wizualizacja dokumentu z Kompletora. Dokumentem jest faktura w KSeF o podanym numerze KSeF.')
  return doBufora(doc)
}

/**
 * PDF dokumentu KSeF z listy faktur albo karty (`draftId` = wiersz faktury lub korekty). Wymaga numeru z serii
 * (dokument zatwierdzony do wysyłki); szkic bez numeru nie ma PDF-u. `actorId` = kto pobiera (wpis w dzienniku).
 */
export async function pdfDokumentuKsef(db: PrismaClient, draftId: string, o: { actorId: string; now?: Date }): Promise<PdfFaktury> {
  if (!o.actorId.trim()) throw new Error('pdfDokumentuKsef: brak actorId')
  const d = await db.ksefInvoiceDraft.findUnique({ where: { id: draftId } })
  if (!d) throw new BladPdfFaktury('Nie ma takiej faktury', 404)
  if (!d.numer || !d.dataWystawienia || d.status !== 'PRZYJETA') throw new BladPdfFaktury('Dokument nie jest jeszcze przyjęty w KSeF: PDF będzie po przyjęciu', 409)
  const now = o.now ?? d.updatedAt
  // ta sama data wytworzenia co przy wysyłce, więc przy niezmienionych danych XML (i hash) jest ten sam
  const wytworzono = d.wytworzonaAt ?? now
  let wejscie: WejscieFa3
  let xml: string
  if (d.rodzaj === 'KOR') {
    const k = await szkicKorektyKsef(db, d.returnId, { now: wytworzono, wysylka: { numer: d.numer, dataWystawienia: d.dataWystawienia } })
    if (!k.ok) throw new BladPdfFaktury(`Nie udało się złożyć korekty: ${k.powod}`, 409)
    wejscie = k.wejscie
    xml = k.xml
  } else {
    const f = await zlozFaktureDoWysylki(db, d.orderId, d.packageNo, { numer: d.numer, dataWystawienia: d.dataWystawienia, now: wytworzono })
    if (!f.ok) throw new BladPdfFaktury(`Nie udało się złożyć faktury: ${f.problemy.map((p) => p.tekst).join(' ')}`, 409)
    wejscie = f.wejscie
    xml = f.xml
  }
  const zgodnaZKsef = d.invoiceHash ? hashFaktury(xml) === d.invoiceHash : null
  const ostrzezenie = zgodnaZKsef === false ? OSTRZEZENIE_ROZJAZDU : zgodnaZKsef === null ? OSTRZEZENIE_BEZ_HASHU : null
  const bytes = await rysujFakture(wejscie, { ksefNumer: d.ksefNumer, utworzono: now, ostrzezenie })
  await db.auditLog.create({ data: { entity: PODGLAD_AUDIT, entityId: d.orderId, actorId: o.actorId, after: { cel: CEL_PDF_FAKTURY, zakres: 'PELNY', ksef: d.id } } })
  const nazwa = `${d.rodzaj === 'KOR' ? 'korekta' : 'faktura'}-${d.numer.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60)}.pdf`
  return { nazwaPliku: nazwa, contentType: 'application/pdf', bytes: new Uint8Array(bytes), numer: d.numer, zgodnaZKsef }
}

/** Kilka PDF-ów w jednym pliku (pobranie wielu faktur z listy naraz). Pliki, które się nie złożyły, idą do `pominiete`. */
export async function polaczPdf(pliki: Uint8Array[]): Promise<Uint8Array> {
  const wynik = await PDFDocument.create()
  for (const p of pliki) {
    const src = await PDFDocument.load(p)
    for (const s of await wynik.copyPages(src, src.getPageIndices())) wynik.addPage(s)
  }
  return wynik.save()
}
