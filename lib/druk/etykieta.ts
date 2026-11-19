// Etykieta kurierska dla stanowiska druku — interfejs źródła etykiety i jedyna dziś implementacja: ATRAPA.
//
// PreparedShipment nie ma pliku etykiety ani danych odbiorcy i to zostaje. Atrapa rysuje z niego kartkę
// z numerem zamówienia, numerem paczki, przewoźnikiem, gabarytem, wagą i pobraniem — z dużym napisem
// „PRÓBA — NIE NADAWAĆ” i BEZ kodu kreskowego, żeby nikt nie nakleił jej na paczkę. Bez sieci, bez Base Courier
// (lib/zrodla/basecourier.ts) i bez zmian w zamówieniu, rezerwacjach, stanach i PreparedShipment — tylko odczyt.
// Prawdziwa etykieta przewoźnika w trybie PRACA to późniejsza implementacja tego samego interfejsu.
import type { PrismaClient } from '@prisma/client'
import { organizationIdOf } from '@/lib/db'
import { CARRIER_LABEL } from '@/lib/panel/format'
import { wczytajZamowienia } from '@/lib/stanowisko/zamowienia'
import { MM, doBufora, formatDataGodzina, nowyDokument, FONT, FONT_B } from '@/lib/wydruki/wspolne'
import { BladDruku } from './zlecenia'
import { etykietaZpl, PUNKTY_NA_MM, tekstZpl } from './zpl'

export const NAPIS_PROBY = 'PRÓBA — NIE NADAWAĆ'

export interface EtykietaDoDruku {
  /** etykieta przewoźnika ma jeden plik (PDF albo ZPL); atrapa oba. */
  pdf?: Buffer
  zpl?: Buffer
  /** Opis dla listy zleceń, bez danych klientów. */
  opis: string
}

/** Źródło etykiety zamówienia: atrapa (podgląd) albo etykieta przewoźnika (lib/wysylka/etykieta-przewoznika.ts). */
export interface ZrodloEtykiety {
  readonly nazwa: string
  etykieta(db: PrismaClient, orderId: string, now: Date): Promise<EtykietaDoDruku>
}

export interface DaneAtrapy {
  zamowienie: string
  paczka: number
  przewoznik: string
  usluga: string | null
  gabaryt: string | null
  wagaKg: number | null
  pobranie: string | null
  data: Date
}

function linieAtrapy(d: DaneAtrapy): [string, string][] {
  return [
    ['Zamówienie', d.zamowienie],
    ['Paczka nr', String(d.paczka)],
    ['Przewoźnik', d.usluga ? `${d.przewoznik} (${d.usluga})` : d.przewoznik],
    ['Gabaryt', d.gabaryt ?? '—'],
    ['Waga', d.wagaKg === null ? '—' : `${d.wagaKg.toLocaleString('pl-PL')} kg`],
    ['Pobranie', d.pobranie ?? 'bez pobrania'],
  ]
}

/** ZPL 100 × 150 mm, ^CI28; tylko teksty i ramki (żadnego ^B… — kodu kreskowego). */
export function atrapaZpl(d: DaneAtrapy): Buffer {
  const W = 100 * PUNKTY_NA_MM
  const m = 3 * PUNKTY_NA_MM
  const t: string[] = []
  // pasy z napisem próby: na górze i na dole, białe litery na czarnym tle
  for (const y of [m, 150 * PUNKTY_NA_MM - m - 150]) {
    t.push(`^FO${m},${y}^GB${W - 2 * m},150,150^FS`)
    t.push(tekstZpl({ x: m, y: y + 20, tekst: 'PRÓBA', wys: 60, szer: W - 2 * m, srodek: true, odwrocony: true }))
    t.push(tekstZpl({ x: m, y: y + 85, tekst: 'NIE NADAWAĆ', wys: 50, szer: W - 2 * m, srodek: true, odwrocony: true }))
  }
  let y = m + 190
  for (const [k, v] of linieAtrapy(d)) {
    t.push(tekstZpl({ x: m + 10, y, tekst: k, wys: 28 }))
    t.push(tekstZpl({ x: m + 10, y: y + 32, tekst: v, wys: 44, szer: W - 2 * m - 20, linii: 2 }))
    y += 110
  }
  t.push(tekstZpl({ x: m + 10, y: y + 10, tekst: `Etykieta próbna Kompletora, ${formatDataGodzina(d.data)}. To nie jest etykieta przewoźnika.`, wys: 24, szer: W - 2 * m - 20, linii: 3 }))
  return etykietaZpl(t)
}

/** PDF 100 × 150 mm z tymi samymi danymi (zapas na A4 albo termiczna bez ZPL). */
export async function atrapaPdf(d: DaneAtrapy): Promise<Buffer> {
  const szer = 100 * MM
  const wys = 150 * MM
  const doc = nowyDokument({ tytul: `Etykieta próbna ${d.zamowienie}`, rozmiar: [szer, wys], utworzono: d.data })
  const m = 4 * MM
  const pas = (y: number) => {
    doc.rect(m, y, szer - 2 * m, 18 * MM).fill('#000')
    doc.fillColor('#fff').font(FONT_B).fontSize(17).text(NAPIS_PROBY, m, y + 6 * MM, { width: szer - 2 * m, align: 'center', lineBreak: false })
    doc.fillColor('#000')
  }
  pas(m)
  pas(wys - m - 18 * MM)
  let y = m + 24 * MM
  for (const [k, v] of linieAtrapy(d)) {
    doc.font(FONT).fontSize(8).fillColor('#444').text(k, m + 2 * MM, y, { lineBreak: false })
    doc.font(FONT_B).fontSize(13).fillColor('#000').text(v, m + 2 * MM, y + 3.5 * MM, { width: szer - 2 * m - 4 * MM, height: 10 * MM, ellipsis: true })
    y += 13 * MM
  }
  doc
    .font(FONT)
    .fontSize(7)
    .text(`Etykieta próbna Kompletora, ${formatDataGodzina(d.data)}. To nie jest etykieta przewoźnika.`, m + 2 * MM, y + 2 * MM, { width: szer - 2 * m - 4 * MM })
  return doBufora(doc)
}

/** Atrapa z PreparedShipment: tylko odczyt zamówienia i przygotowanej przesyłki. */
export const atrapaEtykiety: ZrodloEtykiety = {
  nazwa: 'atrapa',
  async etykieta(db, orderId, now) {
    organizationIdOf(db)
    const s = await db.preparedShipment.findFirst({ where: { orderId }, orderBy: { packageNo: 'asc' } })
    if (!s) throw new BladDruku('Najpierw przygotuj przesyłkę (przycisk w bloku „Przesyłka”), potem drukuj etykietę próbną', 409)
    const [z] = await wczytajZamowienia(db, [orderId])
    if (!z) throw new BladDruku('Nie znaleziono zamówienia', 404)
    const d: DaneAtrapy = {
      zamowienie: z.numer,
      paczka: s.packageNo,
      przewoznik: CARRIER_LABEL[s.carrier],
      usluga: s.courierCode,
      gabaryt: s.parcelSize ?? (s.sideXCm && s.sideYCm && s.sideZCm ? `${s.sideXCm} × ${s.sideYCm} × ${s.sideZCm} cm` : null),
      wagaKg: s.weightKg === null ? null : Number(s.weightKg),
      pobranie: s.codAmount === null ? null : `${Number(s.codAmount).toLocaleString('pl-PL', { minimumFractionDigits: 2 })} zł`,
      data: now,
    }
    return { pdf: await atrapaPdf(d), zpl: atrapaZpl(d), opis: `Etykieta PRÓBNA: ${z.numer}, paczka ${s.packageNo}` }
  },
}
