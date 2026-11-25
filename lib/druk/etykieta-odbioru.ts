// Etykieta odbioru osobistego: kartka 100 × 150 mm na drukarkę etykiet, do naklejenia na paczkę, która
// czeka na półce odbiorów. Dla przewoźnika OSOBISTY przesyłka nie powstaje, więc bez tej kartki paczki nie da się
// rozpoznać. Ten sam tor co etykieta kuriera: źródło etykiety (lib/wysylka/etykieta-przewoznika.ts) → zlecenie druku
// typu „etykieta” → drukarka przypisana do etykiet na stanowisku. Bez sieci i bez kosztu.
//
// Na kartce: napis „ODBIÓR OSOBISTY”, sklep (nazwa konta kanału z ustawień firmy), numer zamówienia dużym krojem i jako
// kod kreskowy (kod najnowszej karty zamówienia, czyli skan czytnikiem otwiera zamówienie jak skan karty; bez karty
// numer z przedrostkiem konta), odbiorca i telefon, paczka „1 z 2”, „OPŁACONE” albo „DO ZAPŁATY: kwota”, data
// spakowania. Tylko czerń i biel (termiczna 203 dpi), kod z modułem w pełnych punktach drukarki i strefą ciszy.
// Dane klienta są wyłącznie w pliku etykiety: opis zlecenia, logi i historia zamówienia mają tylko numer.
import type { PaymentState, PrismaClient } from '@prisma/client'
import { organizationIdOf } from '@/lib/db'
import { odbiorcaNaEtykieteOdbioru, type OdbiorcaEtykietyOdbioru } from '@/lib/klienci/wydruk'
import { rozliczenie } from '@/lib/karta/platnosci'
import { wczytajZamowienia } from '@/lib/stanowisko/zamowienia'
import { doBufora, formatDataGodzina, FONT, FONT_B, kreskiKodu128, MM, nowyDokument, rysujKod128, type Dokument } from '@/lib/wydruki/wspolne'
import type { EtykietaDoDruku } from './etykieta'
import { etykietaZpl, PUNKTY_NA_MM, tekstZpl } from './zpl'

export const NAPIS_ODBIORU = 'ODBIÓR OSOBISTY'

export type PlatnoscNaEtykiecie =
  | { stan: 'OPLACONE' }
  | { stan: 'DO_ZAPLATY'; kwotaGr: number }
  /** Zamówienie w kilku paczkach bez pełnej wpłaty: kwotę podaje karta zamówienia (bez zgadywania podziału). */
  | { stan: 'DO_ZAPLATY_BEZ_KWOTY' }

export interface DaneEtykietyOdbioru {
  /** Nazwa konta kanału z ustawień firmy (np. nazwa sklepu). */
  sklep: string
  /** Numer jak na karcie i w panelu („SD 48213”, dosyłka „SD 48213-2”). */
  numer: string
  /** Treść kodu kreskowego (kod karty „SD48213/2” albo numer z przedrostkiem „SD48213”). */
  kod: string
  odbiorca: OdbiorcaEtykietyOdbioru | null
  paczka: { nr: number; z: number }
  platnosc: PlatnoscNaEtykiecie
  /** Zakończenie pakowania; null = jeszcze nie spakowane (wtedy data wydruku). */
  spakowano: Date | null
  wydrukowano: Date
  /** Konto sklepu w podglądzie (cień): dopisek „PRÓBA”. */
  proba: boolean
}

// ─── czyste reguły (testy w etykieta-odbioru.test.ts) ──────────────────────────────────────────────────────────

/**
 * Kod na etykiecie: kod najnowszej karty zamówienia (ten sam, który czyta stanowisko i lista zamówień), a bez karty
 * numer z przedrostkiem konta („SD48213”), który rozpoznanie kodu znajduje po numerze. Null = zamówienie bez numeru
 * liczbowego (Allegro przed porównaniem z BL): etykieta bez kodu, z samym numerem.
 */
export function kodNaEtykiete(kodZamowienia: string | null, ostatniWydruk: number | null): string | null {
  if (!kodZamowienia) return null
  return ostatniWydruk && ostatniWydruk > 0 ? `${kodZamowienia}/${ostatniWydruk}` : kodZamowienia
}

/** Płatność na etykiecie z rozliczenia karty (lib/karta/platnosci.ts): pobranie i niedopłata = do zapłaty przy odbiorze. */
export function platnoscNaEtykiecie(
  o: { totalGross: { toString(): string } | number; paymentState: PaymentState; flags: unknown },
  wpisy: Parameters<typeof rozliczenie>[1],
  wKilkuPaczkach: boolean,
): PlatnoscNaEtykiecie {
  const r = rozliczenie(o, wpisy)
  const doZaplatyGr = r.pobranie ? r.zamowienieGr - r.zaplaconoGr : r.roznicaGr
  if (doZaplatyGr <= 0) return { stan: 'OPLACONE' }
  return wKilkuPaczkach ? { stan: 'DO_ZAPLATY_BEZ_KWOTY' } : { stan: 'DO_ZAPLATY', kwotaGr: doZaplatyGr }
}

/** „600 100 200”, „+48 600 100 200”; inny zapis bez zmian. */
export function telefonNaEtykiete(t: string | null | undefined): string | null {
  const s = (t ?? '').trim()
  if (!s) return null
  const cyfry = s.replace(/[\s()-]/g, '')
  const m = /^(\+48|0048)?(\d{9})$/.exec(cyfry)
  if (!m) return s
  const n = m[2]!
  return `${m[1] ? '+48 ' : ''}${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`
}

export function kwotaTekst(gr: number): string {
  return `${(gr / 100).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} zł`
}

export function platnoscTekst(p: PlatnoscNaEtykiecie): string {
  if (p.stan === 'OPLACONE') return 'OPŁACONE'
  if (p.stan === 'DO_ZAPLATY') return `DO ZAPŁATY: ${kwotaTekst(p.kwotaGr)}`
  return 'DO ZAPŁATY (kwota na karcie)'
}

const stopka = (d: DaneEtykietyOdbioru) => (d.spakowano ? `Spakowano ${formatDataGodzina(d.spakowano)}` : `Wydrukowano ${formatDataGodzina(d.wydrukowano)}`)

// ─── PDF ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Punkt drukarki 203 dpi w pt PDF: kreski kodu w całych punktach są ostre. */
const KROPKA = 72 / 203

function rozmiarDoSzerokosci(doc: Dokument, tekst: string, font: string, max: number, min: number, szer: number): number {
  let r = max
  doc.font(font)
  while (r > min && doc.fontSize(r).widthOfString(tekst) > szer) r -= 1
  return r
}

/** PDF 100 × 150 mm, czerń i biel. */
export async function etykietaOdbioruPdf(d: DaneEtykietyOdbioru): Promise<Buffer> {
  const W = 100 * MM
  const H = 150 * MM
  const m = 4 * MM
  const szer = W - 2 * m
  const doc = nowyDokument({ tytul: `Odbiór osobisty ${d.numer}`, rozmiar: [W, H], utworzono: d.wydrukowano })
  doc.fillColor('#000').strokeColor('#000')
  const srodek = (tekst: string, y: number, font: string, rozmiar: number) =>
    doc.font(font).fontSize(rozmiar).text(tekst, m, y, { width: szer, align: 'center', lineBreak: false })

  // pas z napisem: białe litery na czarnym
  doc.rect(m, m, szer, 16 * MM).fill('#000')
  doc.fillColor('#fff')
  const rPas = rozmiarDoSzerokosci(doc, NAPIS_ODBIORU, FONT_B, 28, 14, szer - 4 * MM)
  srodek(NAPIS_ODBIORU, m + (16 * MM - rPas * 1.2) / 2 + rPas * 0.08, FONT_B, rPas)
  doc.fillColor('#000')

  let y = m + 18.5 * MM
  srodek(d.sklep, y, FONT_B, rozmiarDoSzerokosci(doc, d.sklep, FONT_B, 15, 8, szer))
  y += 7 * MM

  const rNum = rozmiarDoSzerokosci(doc, d.numer, FONT_B, 54, 18, szer)
  srodek(d.numer, y, FONT_B, rNum)
  y += rNum * 1.2 + 1 * MM

  // kod kreskowy: moduł w całych punktach drukarki (najwyżej 4), strefa ciszy 10 modułów po obu stronach
  if (d.kod) {
    const moduly = kreskiKodu128(d.kod).reduce((a, b) => a + b, 0) + 20
    const dostepne = Math.floor(szer / KROPKA)
    const modul = Math.max(1, Math.min(4, Math.floor(dostepne / moduly)))
    const szerKodu = moduly * modul * KROPKA
    const x = Math.round((W - szerKodu) / 2 / KROPKA) * KROPKA
    rysujKod128(doc, d.kod, x, y, szerKodu, 19 * MM)
    y += 19 * MM + 1 * MM
    srodek(d.kod, y, FONT, 9)
    y += 4.5 * MM
  } else {
    y += 24.5 * MM
  }

  doc.moveTo(m, y).lineTo(m + szer, y).lineWidth(1).stroke()
  y += 1.8 * MM
  doc.font(FONT_B).fontSize(9).text('ODBIORCA', m, y, { lineBreak: false })
  y += 4 * MM
  const kto = d.odbiorca?.kto ?? 'brak danych odbiorcy'
  doc.font(FONT_B).fontSize(18).text(kto, m, y, { width: szer, height: 18 * 1.2 * 2, ellipsis: true, lineGap: 0 })
  y += Math.min(doc.heightOfString(kto, { width: szer, lineGap: 0 }), 18 * 1.2 * 2) + 1 * MM
  const tel = telefonNaEtykiete(d.odbiorca?.telefon)
  if (tel) doc.font(FONT_B).fontSize(16).text(`tel. ${tel}`, m, y, { width: szer, lineBreak: false })
  y = Math.max(y + 7 * MM, 110 * MM)

  doc.moveTo(m, y).lineTo(m + szer, y).lineWidth(1).stroke()
  y += 2 * MM
  doc.font(FONT_B).fontSize(24).text(`PACZKA ${d.paczka.nr} z ${d.paczka.z}`, m, y, { width: szer, lineBreak: false })
  y += 11 * MM

  const p = platnoscTekst(d.platnosc)
  const wysRamki = 15 * MM
  if (d.platnosc.stan === 'OPLACONE') {
    doc.rect(m + 1, y + 1, szer - 2, wysRamki - 2).lineWidth(2).stroke()
  } else {
    doc.rect(m, y, szer, wysRamki).fill('#000')
    doc.fillColor('#fff')
  }
  const rPl = rozmiarDoSzerokosci(doc, p, FONT_B, 24, 10, szer - 4 * MM)
  srodek(p, y + (wysRamki - rPl * 1.2) / 2 + rPl * 0.08, FONT_B, rPl)
  doc.fillColor('#000')

  const yStopki = H - m - 4 * MM
  doc.font(FONT).fontSize(9).text(stopka(d), m, yStopki, { width: szer, lineBreak: false })
  if (d.proba) doc.font(FONT_B).fontSize(9).text('PRÓBA: konto sklepu w podglądzie', m, yStopki - 4 * MM, { width: szer, lineBreak: false })
  return doBufora(doc)
}

// ─── ZPL ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Tekst przycięty do liczby znaków, która mieści się w polu krojem ^A0 (średnio ok. 0,6 wysokości na znak). */
function przytnij(tekst: string, wys: number, szer: number, linii = 1): string {
  const max = Math.max(4, Math.floor(szer / (wys * 0.6)) * linii)
  const z = [...tekst]
  return z.length > max ? `${z.slice(0, max - 1).join('').trimEnd()}…` : tekst
}

/** ZPL 100 × 150 mm, ^CI28; kod kreskowy jako kreski ^GB z tych samych szerokości co PDF i karta. */
export function etykietaOdbioruZpl(d: DaneEtykietyOdbioru): Buffer {
  const W = 100 * PUNKTY_NA_MM
  const H = 150 * PUNKTY_NA_MM
  const m = 3 * PUNKTY_NA_MM
  const szer = W - 2 * m
  const t: string[] = []
  t.push(`^FO${m},${m}^GB${szer},128,128^FS`)
  t.push(tekstZpl({ x: m, y: m + 30, tekst: NAPIS_ODBIORU, wys: 72, szer, srodek: true, odwrocony: true }))
  let y = m + 148
  t.push(tekstZpl({ x: m, y, tekst: przytnij(d.sklep, 44, szer), wys: 44, szer, srodek: true }))
  y += 58
  const wysNum = Math.max(60, Math.min(150, Math.floor(szer / ([...d.numer].length * 0.62))))
  t.push(tekstZpl({ x: m, y, tekst: przytnij(d.numer, wysNum, szer), wys: wysNum, szer, srodek: true }))
  y += wysNum + 16
  if (d.kod) {
    const sbs = kreskiKodu128(d.kod)
    const moduly = sbs.reduce((a, b) => a + b, 0) + 20
    const modul = Math.max(1, Math.min(4, Math.floor(szer / moduly)))
    let x = m + Math.floor((szer - moduly * modul) / 2) + 10 * modul
    sbs.forEach((w, i) => {
      if (i % 2 === 0) t.push(`^FO${x},${y}^GB${w * modul},150,${w * modul}^FS`)
      x += w * modul
    })
    y += 158
    t.push(tekstZpl({ x: m, y, tekst: przytnij(d.kod, 28, szer), wys: 28, szer, srodek: true }))
    y += 40
  } else {
    y += 198
  }
  t.push(`^FO${m},${y}^GB${szer},4,4^FS`)
  y += 14
  t.push(tekstZpl({ x: m, y, tekst: 'ODBIORCA', wys: 28 }))
  y += 34
  t.push(tekstZpl({ x: m, y, tekst: przytnij(d.odbiorca?.kto ?? 'brak danych odbiorcy', 56, szer, 2), wys: 56, szer, linii: 2 }))
  y += 120
  const tel = telefonNaEtykiete(d.odbiorca?.telefon)
  if (tel) t.push(tekstZpl({ x: m, y, tekst: przytnij(`tel. ${tel}`, 50, szer), wys: 50, szer }))
  y = Math.max(y + 60, 110 * PUNKTY_NA_MM)
  t.push(`^FO${m},${y}^GB${szer},4,4^FS`)
  y += 16
  t.push(tekstZpl({ x: m, y, tekst: `PACZKA ${d.paczka.nr} z ${d.paczka.z}`, wys: 70, szer }))
  y += 88
  const p = platnoscTekst(d.platnosc)
  const wysP = Math.max(40, Math.min(72, Math.floor((szer - 32) / ([...p].length * 0.6))))
  if (d.platnosc.stan === 'OPLACONE') t.push(`^FO${m},${y}^GB${szer},120,8^FS`)
  else t.push(`^FO${m},${y}^GB${szer},120,120^FS`)
  t.push(tekstZpl({ x: m, y: y + Math.floor((120 - wysP) / 2), tekst: p, wys: wysP, szer, srodek: true, odwrocony: d.platnosc.stan !== 'OPLACONE' }))
  const yStopki = H - m - 36
  t.push(tekstZpl({ x: m, y: yStopki, tekst: stopka(d), wys: 28 }))
  if (d.proba) t.push(tekstZpl({ x: m, y: yStopki - 36, tekst: 'PRÓBA: konto sklepu w podglądzie', wys: 28 }))
  return etykietaZpl(t)
}

// ─── dane z bazy ──────────────────────────────────────────────────────────────────────────────────────────────

/** Czy zamówienie ma odbiór osobisty (przycisk na karcie, gałąź źródła etykiety, krok reguły). */
export async function czyOdbiorOsobisty(db: PrismaClient, orderId: string): Promise<boolean> {
  organizationIdOf(db)
  const o = await db.order.findUnique({ where: { id: orderId }, select: { carrier: true, status: true } })
  return o?.carrier === 'OSOBISTY' && o.status !== 'ANULOWANE'
}

/**
 * Dane etykiety z bazy firmy (RLS); null = zamówienie nie ma odbioru osobistego. `actorId` = osoba zlecająca wydruk
 * (`User.id`) albo reguła automatu (`automat:<id>`): od niej zależy zakres danych odbiorcy (lib/klienci/wydruk.ts);
 * null = etykieta bez danych odbiorcy.
 */
export async function daneEtykietyOdbioru(db: PrismaClient, orderId: string, now: Date, actorId: string | null): Promise<DaneEtykietyOdbioru | null> {
  organizationIdOf(db)
  const o = await db.order.findUnique({
    where: { id: orderId },
    select: { id: true, carrier: true, status: true, parentOrderId: true, packageNo: true, totalGross: true, paymentState: true, flags: true },
  })
  if (!o || o.carrier !== 'OSOBISTY' || o.status === 'ANULOWANE') return null
  const [z] = await wczytajZamowienia(db, [orderId])
  if (!z) return null
  const glowne = o.parentOrderId ?? o.id
  const [dodatkowe, wydruk, pakowanie, wpisy] = await Promise.all([
    db.order.count({ where: { parentOrderId: glowne, status: { not: 'ANULOWANE' } } }),
    db.orderCardPrint.findFirst({ where: { orderId }, orderBy: { printNo: 'desc' }, select: { printNo: true } }),
    db.packDrill.findFirst({ where: { orderId, outcome: 'SPAKOWANE', finishedAt: { not: null } }, orderBy: { finishedAt: 'desc' }, select: { finishedAt: true } }),
    db.orderPayment.findMany({ where: { orderId: glowne }, select: { kind: true, amount: true } }),
  ])
  // płatność rodziny paczek liczy zamówienie główne (wpłaty i pobranie są przy nim)
  const platne = o.parentOrderId ? await db.order.findUnique({ where: { id: glowne }, select: { totalGross: true, paymentState: true, flags: true } }) : o
  const z_ = Math.max(1 + dodatkowe, o.packageNo)
  return {
    sklep: z.kanal,
    numer: z.numer,
    kod: kodNaEtykiete(z.kodZamowienia, wydruk?.printNo ?? null) ?? '',
    odbiorca: actorId ? await odbiorcaNaEtykieteOdbioru(db, orderId, actorId) : null,
    paczka: { nr: o.parentOrderId ? o.packageNo : 1, z: z_ },
    platnosc: platne ? platnoscNaEtykiecie(platne, wpisy, z_ > 1) : { stan: 'DO_ZAPLATY_BEZ_KWOTY' },
    spakowano: pakowanie?.finishedAt ?? null,
    wydrukowano: now,
    proba: z.tryb === 'CIEN',
  }
}

/** Etykieta odbioru do druku (PDF i ZPL) albo null, gdy zamówienie nie ma odbioru osobistego. */
export async function etykietaOdbioru(db: PrismaClient, orderId: string, now: Date, actorId: string | null): Promise<EtykietaDoDruku | null> {
  const d = await daneEtykietyOdbioru(db, orderId, now, actorId)
  if (!d) return null
  return { pdf: await etykietaOdbioruPdf(d), zpl: etykietaOdbioruZpl(d), opis: `Etykieta odbioru osobistego: ${d.numer}` }
}
