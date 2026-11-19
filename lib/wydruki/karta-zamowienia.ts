// Karta zamówienia (kompletacja): pracownik zbiera towar do koszyka (1 zamówienie = 1 koszyk) idąc
// po lokalizacjach, na stanowisku pakowania skanuje kod z karty. Produkty nie mają własnych kodów.
// Karta NIE idzie do paczki: bez treści marketingowych, z klienta imię, nazwisko i miasto. Pełny adres (blok
// „ODBIORCA”) tylko, gdy osoba zlecająca wydruk ma uprawnienie `klienci.dane` (lib/stanowisko/karty.ts).
import { czyInformacyjna, type KartaInformacyjnaDane, type KartaZamowieniaDane, type KartaZamowieniaOpcje, type PozycjaInformacyjna, type PozycjaKarty, type StronaKart } from './typy'
import {
  A4,
  DOL_TRESCI,
  FONT,
  FONT_B,
  MARGINES,
  doBufora,
  formatData,
  formatDataGodzina,
  formatIlosc,
  kodKarty,
  numerZamowieniaTekst,
  nowyDokument,
  odbiorcaTekst,
  rysujKod128,
  sortujPoLokalizacji,
  stopki,
  tekstJednaLinia,
  wysokoscTekstu,
  type Dokument,
} from './wspolne'
import { obrazDoWydruku } from './obraz'

const SZER = A4.szerokosc - 2 * MARGINES
const DOL = DOL_TRESCI // nad stopką (26.10.2026: stopka wyżej, wspólna granica w wspolne.ts)
const MINIATURA = 28
// (26.10.2026): wolny tekst (uwagi klienta z Allegro/WooCommerce, nazwy) ma limit wysokości z „…”.
// Bez limitu pdfkit sam dokładał strony w środku tekstu i karta rozjeżdżała się na kilka stron bez nagłówka.
const MAX_UWAG = 180 // ok. ¼ strony A4
const MAX_NAZWY_WIERSZA = 100 // ok. 6 linii 11 pt w wierszu tabeli
const MAX_NAZWY_DUZEJ = 220 // wariant 1 pozycja/karta, 18 pt
const MAX_DOPISKU = 60 // wariant / SKU

// Kolumny tabeli pozycji (x względem MARGINES).
const K = {
  znacznik: { x: 0, w: 20 },
  lokalizacja: { x: 22, w: 82 },
  zdjecie: { x: 106, w: 34 },
  produkt: { x: 144, w: SZER - 144 - 90 },
  ilosc: { x: SZER - 86, w: 86 },
}

export async function kartaZamowienia(
  dane: KartaZamowieniaDane,
  opcje: KartaZamowieniaOpcje = {},
): Promise<Buffer> {
  const kod = kodKarty(dane.zamowienie, dane.numerWydruku)
  const doc = nowyDokument({
    tytul: `Karta zamówienia ${numerZamowieniaTekst(dane.zamowienie)} (${kod})`,
    utworzono: dane.wydrukowano,
  })
  rysujKarte(doc, dane, opcje)
  return doBufora(doc)
}

/**
 * Kilka kart w jednym PDF (druk z kolejki pakowania), w kolejności wejścia. Każda karta zaczyna się od
 * nowej strony i ma własną stopkę z numeracją „strona N/M” tej karty — koszyk dostaje swoje kartki.
 * obok kart do zbierania mogą być wydruki informacyjne (`informacyjna: true`) — bez kodu kreskowego.
 */
export async function kartyZamowien(dane: readonly StronaKart[], opcje: KartaZamowieniaOpcje = {}): Promise<Buffer> {
  if (dane.length === 0) throw new Error('Brak kart do wydruku')
  // kody sprawdzane przed rysowaniem: zły numer jednej karty nie zostawia połowy PDF
  for (const d of dane) if (!czyInformacyjna(d)) kodKarty(d.zamowienie, d.numerWydruku)
  const doc = nowyDokument({
    tytul: dane.length === 1 ? tytulJednej(dane[0]!) : `Karty zamówień (${dane.length})`,
    utworzono: dane[0]!.wydrukowano,
  })
  dane.forEach((d, i) => {
    if (i > 0) doc.addPage()
    if (czyInformacyjna(d)) rysujInformacyjna(doc, d)
    else rysujKarte(doc, d, opcje)
  })
  if (opcje.pominiete?.length) stronaPominietych(doc, opcje.pominiete, dane[0]!)
  return doBufora(doc)
}

// ---------- wydruk informacyjny ----------

const tytulJednej = (d: StronaKart) => (czyInformacyjna(d) ? `Zamówienie ${d.numer} (wydruk informacyjny)` : `Karta zamówienia ${numerZamowieniaTekst(d.zamowienie)}`)

const KI = {
  produkt: { x: 0, w: SZER - 230 },
  ilosc: { x: SZER - 222, w: 82 },
  oznaczenie: { x: SZER - 130, w: 130 },
}
const OZNACZENIE: Record<'brak' | 'bez stanu', string> = { brak: 'BRAK NA STANIE', 'bez stanu': 'BEZ STANU (bez wysyłki)' }

/** Pas z powodem i numer zamówienia — na każdej stronie wydruku informacyjnego. Bez kodu kreskowego. */
function naglowekInformacyjny(doc: Dokument, d: KartaInformacyjnaDane): number {
  const y0 = MARGINES
  const logo = obrazDoWydruku(d.logo)
  const LOGO_W = 110
  const szerNumeru = logo ? SZER - LOGO_W - 12 : SZER
  if (logo) {
    try {
      doc.image(logo, MARGINES + SZER - LOGO_W, y0, { fit: [LOGO_W, 36], align: 'right', valign: 'center' })
    } catch {
      // uszkodzony JPEG: wydruk bez logo
    }
  }
  const numer = d.numer
  let rozmiar = 26
  while (rozmiar > 12 && doc.font(FONT_B).fontSize(rozmiar).widthOfString(numer) > szerNumeru) rozmiar -= 1
  doc.font(FONT_B).fontSize(rozmiar).fillColor('black').text(numer, MARGINES, y0 - 2 + (26 - rozmiar) / 2, { lineBreak: false })

  // pas z powodem: szare tło, gruba ramka — widać z daleka, że to nie karta do zbierania
  const yp = y0 + 38
  const hp = 42
  doc.save().lineWidth(2).rect(MARGINES, yp, SZER, hp).fillAndStroke('#e6e6e6', 'black').restore()
  doc.fillColor('black')
  tekstJednaLinia(doc, `Wydruk informacyjny: ${d.powod}`, MARGINES + 10, yp + 6, SZER - 20, { font: FONT_B, rozmiar: 15 })
  tekstJednaLinia(doc, 'To nie jest karta do zbierania: nie ma kodu karty i nie skanuje się jej na stanowisku pakowania.', MARGINES + 10, yp + 26, SZER - 20, { rozmiar: 9 })

  let y = yp + hp + 8
  tekstJednaLinia(doc, [d.kanal, formatData(d.dataZamowienia), d.status ? `status: ${d.status}` : null].filter(Boolean).join(' · '), MARGINES, y, SZER, { rozmiar: 11 })
  y += 15
  tekstJednaLinia(doc, [d.przewoznik, d.metodaDostawy].filter(Boolean).join(' '), MARGINES, y, SZER, { font: FONT_B, rozmiar: 12 })
  y += 17
  tekstJednaLinia(doc, `Odbiorca: ${odbiorcaTekst(d.odbiorca)}`, MARGINES, y, SZER, { rozmiar: 10 })
  y += 16
  doc.save().moveTo(MARGINES, y).lineTo(MARGINES + SZER, y).lineWidth(1.2).stroke().restore()
  return y + 8
}

function poleInformacyjne(doc: Dokument, tytul: string, tekst: string, y: number): number {
  const wTekstu = SZER - 12
  const h = Math.min(wysokoscTekstu(doc, tekst, FONT_B, 11, wTekstu), MAX_UWAG)
  const wys = 16 + h + 8
  doc.save().rect(MARGINES, y, SZER, wys).lineWidth(0.7).stroke().restore()
  tekstJednaLinia(doc, tytul, MARGINES + 6, y + 4, wTekstu, { font: FONT, rozmiar: 8 })
  doc.font(FONT_B).fontSize(11).text(tekst, MARGINES + 6, y + 16, { width: wTekstu, height: h, ellipsis: '…' })
  return y + wys + 6
}

function naglowekTabeliInformacyjnej(doc: Dokument, y: number): number {
  tekstJednaLinia(doc, 'PRODUKT', MARGINES + KI.produkt.x, y, KI.produkt.w, { rozmiar: 8 })
  tekstJednaLinia(doc, 'ILOŚĆ', MARGINES + KI.ilosc.x, y, KI.ilosc.w, { rozmiar: 8, align: 'right' })
  tekstJednaLinia(doc, 'UWAGA', MARGINES + KI.oznaczenie.x, y, KI.oznaczenie.w, { rozmiar: 8, align: 'right' })
  doc.save().moveTo(MARGINES, y + 13).lineTo(MARGINES + SZER, y + 13).lineWidth(0.7).stroke().restore()
  return y + 15
}

function wysokoscPozycjiInformacyjnej(doc: Dokument, p: PozycjaInformacyjna): { nazwa: number; dopisek: number; razem: number } {
  const dopisek = [p.wariant?.trim() ? `Wariant: ${p.wariant.trim()}` : null, p.sku?.trim() ? `SKU: ${p.sku.trim()}` : null].filter(Boolean).join(' · ')
  const nazwa = Math.min(wysokoscTekstu(doc, p.nazwa, FONT_B, 11, KI.produkt.w), MAX_NAZWY_WIERSZA)
  const hd = dopisek ? Math.min(wysokoscTekstu(doc, dopisek, FONT, 8, KI.produkt.w), MAX_DOPISKU) : 0
  return { nazwa, dopisek: hd, razem: Math.max(26, nazwa + hd + 10) }
}

function wierszInformacyjny(doc: Dokument, p: PozycjaInformacyjna, y: number): number {
  const x = MARGINES
  const hs = wysokoscPozycjiInformacyjnej(doc, p)
  const dopisek = [p.wariant?.trim() ? `Wariant: ${p.wariant.trim()}` : null, p.sku?.trim() ? `SKU: ${p.sku.trim()}` : null].filter(Boolean).join(' · ')
  doc.font(FONT_B).fontSize(11).fillColor('black').text(p.nazwa, x + KI.produkt.x, y + 4, { width: KI.produkt.w, height: hs.nazwa, ellipsis: '…' })
  if (dopisek) {
    doc.fillColor('#333').font(FONT).fontSize(8).text(dopisek, x + KI.produkt.x, y + 4 + hs.nazwa, { width: KI.produkt.w, height: hs.dopisek, ellipsis: '…' })
    doc.fillColor('black')
  }
  tekstJednaLinia(doc, formatIlosc(p.ilosc, p.jednostka), x + KI.ilosc.x, y + 4, KI.ilosc.w, { font: FONT_B, rozmiar: 12, align: 'right' })
  if (p.oznaczenie) tekstJednaLinia(doc, OZNACZENIE[p.oznaczenie], x + KI.oznaczenie.x, y + 5, KI.oznaczenie.w, { font: FONT_B, rozmiar: 9, align: 'right' })
  doc.save().moveTo(x, y + hs.razem).lineTo(x + SZER, y + hs.razem).lineWidth(0.4).strokeColor('#999').stroke().restore()
  return hs.razem
}

/** Wydruk informacyjny od bieżącej (pustej) strony: pas z powodem, nagłówek bez kodu, wszystkie pozycje zamówienia. */
function rysujInformacyjna(doc: Dokument, d: KartaInformacyjnaDane): void {
  const pierwsza = doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1
  let y = naglowekInformacyjny(doc, d)
  if (d.adresOdbiorcy?.length) y = poleInformacyjne(doc, 'ODBIORCA', d.adresOdbiorcy.join('\n'), y)
  if (d.uwagiKlienta?.trim()) y = poleInformacyjne(doc, 'UWAGI KLIENTA', d.uwagiKlienta.trim(), y)
  y = naglowekTabeliInformacyjnej(doc, y + 2)
  if (d.pozycje.length === 0) {
    tekstJednaLinia(doc, 'Brak pozycji w zamówieniu.', MARGINES, y + 6, SZER, { rozmiar: 11 })
    y += 24
  }
  for (const p of d.pozycje) {
    if (y + wysokoscPozycjiInformacyjnej(doc, p).razem > DOL) {
      doc.addPage()
      y = naglowekTabeliInformacyjnej(doc, naglowekInformacyjny(doc, d))
    }
    y += wierszInformacyjny(doc, p, y)
  }
  if (y + 20 <= DOL) tekstJednaLinia(doc, `Pozycji: ${d.pozycje.length}`, MARGINES, y + 6, SZER, { font: FONT_B, rozmiar: 10, align: 'right' })
  stopki(doc, `Wydruk informacyjny · ${formatDataGodzina(d.wydrukowano)} · drukował(a): ${d.drukujacy} · bez kodu karty, nie do skanowania`, {
    start: pierwsza,
    count: doc.bufferedPageRange().start + doc.bufferedPageRange().count - pierwsza,
  })
}

/** Ostatnia strona wydruku zbiorczego: zamówienia, dla których karty nie ma (same produkty bez stanu). */
function stronaPominietych(doc: Dokument, numery: readonly string[], d: StronaKart): void {
  doc.addPage()
  const strona = doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1
  tekstJednaLinia(doc, `Pominięto (same produkty bez stanu, np. e-book): ${numery.length}`, MARGINES, MARGINES, SZER, { font: FONT_B, rozmiar: 14 })
  doc.font(FONT).fontSize(11).fillColor('#000').text(`Pominięto: ${numery.join(', ')}`, MARGINES, MARGINES + 26, { width: SZER, height: DOL - MARGINES - 26, ellipsis: '…' })
  stopki(doc, `Wydruk zbiorczy · ${formatDataGodzina(d.wydrukowano)} · drukował(a): ${d.drukujacy} · bez karty: ${numery.length}`, { start: strona, count: 1 })
}

/** Karta od bieżącej (pustej) strony dokumentu do końca, ze stopką na swoich stronach. */
function rysujKarte(doc: Dokument, dane: KartaZamowieniaDane, opcje: KartaZamowieniaOpcje): void {
  const kod = kodKarty(dane.zamowienie, dane.numerWydruku)
  const pierwsza = doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1
  const pozycje = sortujPoLokalizacji(dane.pozycje)

  if (opcje.jednaPozycjaNaKarte && pozycje.length > 0) {
    pozycje.forEach((p, i) => {
      if (i > 0) doc.addPage()
      let y = naglowek(doc, dane, kod)
      y = uwagi(doc, dane, y)
      tekstJednaLinia(doc, `Pozycja ${i + 1} z ${pozycje.length}`, MARGINES, y, SZER, { font: FONT_B, rozmiar: 12 })
      y += 22
      pozycjaDuza(doc, p, y)
    })
  } else {
    let y = naglowek(doc, dane, kod)
    y = uwagi(doc, dane, y)
    y = naglowekTabeli(doc, y)
    if (pozycje.length === 0) {
      tekstJednaLinia(doc, 'Brak pozycji w zamówieniu.', MARGINES, y + 6, SZER, { rozmiar: 11 })
      y += 24
    }
    for (const p of pozycje) {
      const h = wysokoscWiersza(doc, p)
      if (y + h > DOL) {
        doc.addPage()
        y = naglowekTabeli(doc, naglowek(doc, dane, kod))
      }
      wiersz(doc, p, y, h)
      y += h
    }
    podsumowanie(doc, pozycje, y)
  }

  stopki(
    doc,
    `Wydruk ${dane.numerWydruku} · ${formatDataGodzina(dane.wydrukowano)} · drukował(a): ${dane.drukujacy} · ${kod}` +
      (dane.numerWydruku === 2 ? ' · unieważnia wydruk 1' : '') +
      (dane.numerWydruku > 2 ? ` · unieważnia wydruki 1–${dane.numerWydruku - 1}` : ''),
    { start: pierwsza, count: doc.bufferedPageRange().start + doc.bufferedPageRange().count - pierwsza },
  )
}

/** Nagłówek z numerem i kodem — na każdej stronie (koszyk może mieć kartkę 2 bez kartki 1). */
function naglowek(doc: Dokument, d: KartaZamowieniaDane, kod: string): number {
  const y0 = MARGINES
  const szerKodu = 250
  const xKodu = MARGINES + SZER - szerKodu
  const szerLewa = SZER - szerKodu - 12
  // logo firmy (JPEG albo PNG po bramce miniatur) po prawej stronie lewej kolumny, pod numerem zamówienia;
  // linie pod numerem są wtedy węższe. Zły albo za duży plik = karta bez logo.
  const logo = obrazDoWydruku(d.logo)
  const LOGO_W = 110
  const szerPodNumerem = logo ? szerLewa - LOGO_W - 8 : szerLewa
  if (logo) {
    try {
      doc.image(logo, MARGINES + szerLewa - LOGO_W, y0 + 46, { fit: [LOGO_W, 44], align: 'right', valign: 'center' })
    } catch {
      // uszkodzony JPEG: karta idzie bez logo
    }
  }

  const numer = numerZamowieniaTekst(d.zamowienie)
  // (26.10.2026): długi numer z plakietką NA SUCHO wchodził pod kod kreskowy — zmniejszamy rozmiar,
  // aż numer (z plakietką) zmieści się w lewej kolumnie.
  doc.font(FONT_B).fontSize(12)
  const szerPlakietki = d.naSucho ? doc.widthOfString('NA SUCHO') + 14 + 12 : 0
  let rozmiarNumeru = 28
  while (rozmiarNumeru > 12 && doc.font(FONT_B).fontSize(rozmiarNumeru).widthOfString(numer) + szerPlakietki > szerLewa) {
    rozmiarNumeru -= 1
  }
  doc.font(FONT_B).fontSize(rozmiarNumeru)
  doc.text(numer, MARGINES, y0 - 4 + (28 - rozmiarNumeru) / 2, { lineBreak: false })
  const szerNumeru = doc.widthOfString(numer)
  if (d.naSucho) {
    const x = MARGINES + szerNumeru + 12
    doc.font(FONT_B).fontSize(12)
    const w = doc.widthOfString('NA SUCHO') + 14
    doc.save().rect(x, y0 + 4, w, 22).fill('black').restore()
    doc.fillColor('white').text('NA SUCHO', x, y0 + 8, { width: w, align: 'center', lineBreak: false })
    doc.fillColor('black')
  }
  if (d.zamowienie.podzamowienie) {
    tekstJednaLinia(doc, `DOSYŁKA (część ${d.zamowienie.podzamowienie})`, MARGINES, y0 + 30, szerPodNumerem, {
      font: FONT_B,
      rozmiar: 9,
    })
  }
  tekstJednaLinia(doc, `${d.kanal} · ${formatData(d.dataZamowienia)}`, MARGINES, y0 + 44, szerPodNumerem, { rozmiar: 11 })
  tekstJednaLinia(
    doc,
    [d.przewoznik, d.metodaDostawy].filter(Boolean).join(' '),
    MARGINES,
    y0 + 59,
    szerPodNumerem,
    { font: FONT_B, rozmiar: 13 },
  )
  tekstJednaLinia(doc, `Odbiorca: ${odbiorcaTekst(d.odbiorca)}`, MARGINES, y0 + 77, szerPodNumerem, { rozmiar: 10 })

  rysujKod128(doc, kod, xKodu, y0, szerKodu, 62)
  tekstJednaLinia(doc, kod, xKodu, y0 + 66, szerKodu, { font: FONT_B, rozmiar: 13, align: 'center' })

  const y = y0 + 96
  doc.save().moveTo(MARGINES, y).lineTo(MARGINES + SZER, y).lineWidth(1.2).stroke().restore()
  return y + 8
}

function uwagi(doc: Dokument, d: KartaZamowieniaDane, y0: number): number {
  let y = y0
  const pole = (tytul: string, tekst: string | null | undefined, puste: number, gruba: boolean) => {
    const wTekstu = SZER - 12
    const h = tekst ? Math.min(wysokoscTekstu(doc, tekst, FONT_B, 11, wTekstu), MAX_UWAG) : puste
    const wys = 16 + h + 8
    doc.save().rect(MARGINES, y, SZER, wys).lineWidth(gruba ? 1.5 : 0.7).stroke().restore()
    tekstJednaLinia(doc, tytul, MARGINES + 6, y + 4, wTekstu, { font: FONT, rozmiar: 8 })
    if (tekst) {
      doc.font(FONT_B).fontSize(11).text(tekst, MARGINES + 6, y + 16, { width: wTekstu, height: h, ellipsis: '…' })
    }
    y += wys + 6
  }
  // pełny adres tylko z uprawnieniem osoby drukującej (dane przychodzą już przycięte wg uprawnień)
  if (d.adresOdbiorcy?.length) pole('ODBIORCA', d.adresOdbiorcy.join('\n'), 0, false)
  // Pole dla magazynu zawsze (biuro wpisuje uwagi albo magazyn notuje ręcznie); uwagi klienta tylko gdy są.
  pole('UWAGI DLA MAGAZYNU', d.uwagiMagazynu?.trim() || null, 22, Boolean(d.uwagiMagazynu?.trim()))
  if (d.uwagiKlienta?.trim()) pole('UWAGI KLIENTA', d.uwagiKlienta.trim(), 0, false)
  return y + 2
}

function naglowekTabeli(doc: Dokument, y: number): number {
  const opis = (t: string, k: { x: number; w: number }, align: 'left' | 'right' = 'left') =>
    tekstJednaLinia(doc, t, MARGINES + k.x, y, k.w, { rozmiar: 8, align })
  opis('LOKALIZACJA', K.lokalizacja)
  opis('PRODUKT', K.produkt)
  opis('ILOŚĆ', K.ilosc, 'right')
  doc.save().moveTo(MARGINES, y + 13).lineTo(MARGINES + SZER, y + 13).lineWidth(0.7).stroke().restore()
  return y + 15
}

function opisProduktu(p: PozycjaKarty): { nazwa: string; wariant: string | null; sku: string | null } {
  return {
    nazwa: p.nazwa,
    wariant: p.wariant?.trim() ? `Wariant: ${p.wariant.trim()}` : null,
    sku: p.sku?.trim() ? `SKU: ${p.sku.trim()}` : null,
  }
}

/** Wysokości części opisu w wierszu tabeli (z limitami) — te same przy pomiarze i rysowaniu. */
function wysokosciOpisu(doc: Dokument, p: PozycjaKarty): { nazwa: number; wariant: number; sku: number } {
  const o = opisProduktu(p)
  return {
    nazwa: Math.min(wysokoscTekstu(doc, o.nazwa, FONT_B, 11, K.produkt.w), MAX_NAZWY_WIERSZA),
    wariant: o.wariant ? Math.min(wysokoscTekstu(doc, o.wariant, FONT, 10, K.produkt.w), MAX_DOPISKU) : 0,
    sku: o.sku ? Math.min(wysokoscTekstu(doc, o.sku, FONT, 8, K.produkt.w), MAX_DOPISKU) : 0,
  }
}

function wysokoscWiersza(doc: Dokument, p: PozycjaKarty): number {
  const h = wysokosciOpisu(doc, p)
  return Math.max(MINIATURA + 8, h.nazwa + h.wariant + h.sku + 10)
}

function miniatura(doc: Dokument, obraz: Buffer | null | undefined, x: number, y: number, bok: number): void {
  // / (26.10.2026): najpierw synchroniczna bramka (format, rozmiar, pełna walidacja PNG), bo zepsuty
  // PNG z alfą wywracał png-js asynchronicznie, poza tym try/catch. try/catch zostaje na błędy JPEG.
  const bezpieczny = obrazDoWydruku(obraz)
  if (bezpieczny) {
    try {
      doc.image(bezpieczny, x, y, { fit: [bok, bok], align: 'center', valign: 'center' })
      return
    } catch {
      // Uszkodzony JPEG — puste pole zamiast przerwanego wydruku.
    }
  }
  doc.save().rect(x, y, bok, bok).lineWidth(0.4).dash(2, { space: 2 }).strokeColor('#999').stroke().restore()
}

/**
 * Lokalizacja w wierszu pozycji: kod półki („C-4-2”) dużą czcionką, a dłuższa nazwa („Czarny wózek 1”) w całości:
 * czcionka maleje, aż tekst zmieści się w kolumnie, a gdy to za mało, tekst łamie się na dwie linie. Wielokropek
 * dopiero wtedy, gdy nie mieści się nawet w dwóch liniach najmniejszą czcionką (magazyn ma widzieć, dokąd iść).
 */
function lokalizacjaWiersza(doc: Dokument, tekst: string, x: number, y: number, h: number): void {
  const w = K.lokalizacja.w
  doc.font(FONT_B).fillColor('black')
  for (const rozmiar of [16, 14, 12, 11]) {
    doc.fontSize(rozmiar)
    if (doc.widthOfString(tekst) <= w) {
      doc.text(tekst, x, y + 6 + (16 - rozmiar) / 2, { lineBreak: false })
      return
    }
  }
  for (const rozmiar of [11, 10, 9]) {
    doc.fontSize(rozmiar)
    const wys = doc.heightOfString(tekst, { width: w, lineGap: 0 })
    if (wys <= 2 * doc.currentLineHeight() + 0.5 || rozmiar === 9) {
      doc.text(tekst, x, y + 4, { width: w, height: Math.max(2 * doc.currentLineHeight() + 0.5, Math.min(h - 6, 3 * doc.currentLineHeight())), lineGap: 0, ellipsis: '…' })
      return
    }
  }
}

function wiersz(doc: Dokument, p: PozycjaKarty, y: number, h: number): void {
  const x = MARGINES
  doc.save().rect(x + 2, y + 9, 13, 13).lineWidth(1).stroke().restore()
  lokalizacjaWiersza(doc, p.lokalizacja?.trim() || '—', x + K.lokalizacja.x, y, h)
  miniatura(doc, p.miniatura, x + K.zdjecie.x + 3, y + 4, MINIATURA)

  const o = opisProduktu(p)
  const hs = wysokosciOpisu(doc, p)
  const opcjeTekstu = (height: number) => ({ width: K.produkt.w, height, ellipsis: '…' })
  let ty = y + 4
  doc.font(FONT_B).fontSize(11).text(o.nazwa, x + K.produkt.x, ty, opcjeTekstu(hs.nazwa))
  ty += hs.nazwa
  if (o.wariant) {
    doc.font(FONT).fontSize(10).text(o.wariant, x + K.produkt.x, ty, opcjeTekstu(hs.wariant))
    ty += hs.wariant
  }
  if (o.sku) {
    doc.fillColor('#333').font(FONT).fontSize(8).text(o.sku, x + K.produkt.x, ty, opcjeTekstu(hs.sku))
    doc.fillColor('black')
  }

  // Ilość różna od „1 szt.” w ramce — najczęstszy błąd kompletacji to wzięcie jednej sztuki zamiast kilku.
  const ilosc = formatIlosc(p.ilosc, p.jednostka)
  const wyroznij = !(p.jednostka === 'szt' && p.ilosc === 1)
  doc.font(FONT_B).fontSize(16)
  const wIl = Math.min(doc.widthOfString(ilosc) + 10, K.ilosc.w)
  const xIl = x + K.ilosc.x + K.ilosc.w - wIl
  if (wyroznij) doc.save().rect(xIl, y + 4, wIl, 24).lineWidth(1.5).stroke().restore()
  tekstJednaLinia(doc, ilosc, xIl, y + 6, wIl - 5, { font: FONT_B, rozmiar: 16, align: 'right' })

  doc.save().moveTo(x, y + h).lineTo(x + SZER, y + h).lineWidth(0.4).strokeColor('#999').stroke().restore()
}

function podsumowanie(doc: Dokument, pozycje: PozycjaKarty[], y: number): void {
  if (y + 20 > DOL) return // brak miejsca: suma jest pomocnicza, nie dokładamy dla niej strony
  const szt = pozycje.filter((p) => p.jednostka === 'szt').reduce((a, p) => a + p.ilosc, 0)
  const g = pozycje.filter((p) => p.jednostka === 'g').reduce((a, p) => a + p.ilosc, 0)
  const czesci = [`Pozycji: ${pozycje.length}`]
  if (szt) czesci.push(`razem ${formatIlosc(szt, 'szt')}`)
  if (g) czesci.push(`razem ${formatIlosc(g, 'g')}`)
  tekstJednaLinia(doc, czesci.join(' · '), MARGINES, y + 6, SZER, { font: FONT_B, rozmiar: 10, align: 'right' })
}

/** Wariant „jedna pozycja na kartę”: ta sama treść, większa czcionka. */
function pozycjaDuza(doc: Dokument, p: PozycjaKarty, y0: number): void {
  const x = MARGINES
  doc.save().rect(x, y0, SZER, 1).fill('black').restore()
  let y = y0 + 12
  tekstJednaLinia(doc, 'LOKALIZACJA', x, y, 200, { rozmiar: 8 })
  tekstJednaLinia(doc, 'ILOŚĆ', x + SZER - 200, y, 200, { rozmiar: 8, align: 'right' })
  y += 12
  tekstJednaLinia(doc, p.lokalizacja?.trim() || '—', x, y, 260, { font: FONT_B, rozmiar: 36 })
  tekstJednaLinia(doc, formatIlosc(p.ilosc, p.jednostka), x + SZER - 260, y, 260, {
    font: FONT_B,
    rozmiar: 36,
    align: 'right',
  })
  y += 56
  miniatura(doc, p.miniatura, x, y, 56)
  const o = opisProduktu(p)
  const w = SZER - 70
  const hNazwy = Math.min(wysokoscTekstu(doc, o.nazwa, FONT_B, 18, w), MAX_NAZWY_DUZEJ)
  doc.font(FONT_B).fontSize(18).text(o.nazwa, x + 70, y, { width: w, height: hNazwy, ellipsis: '…' })
  y += hNazwy + 4
  if (o.wariant) {
    const hW = Math.min(wysokoscTekstu(doc, o.wariant, FONT, 14, w), MAX_DOPISKU)
    doc.font(FONT).fontSize(14).text(o.wariant, x + 70, y, { width: w, height: hW, ellipsis: '…' })
    y += hW + 2
  }
  if (o.sku) {
    const hS = Math.min(wysokoscTekstu(doc, o.sku, FONT, 11, w), MAX_DOPISKU)
    doc.font(FONT).fontSize(11).text(o.sku, x + 70, y, { width: w, height: hS, ellipsis: '…' })
  }
}
