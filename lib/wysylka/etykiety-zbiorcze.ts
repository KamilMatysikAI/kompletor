// Etykiety wielu przesyłek w jednym pliku PDF („Pobierz etykiety” z listy przesyłek). Etykiety biorą
// się z zapisanych plików (zaszyfrowanych, lib/klienci/etykieta.ts), więc nic nie idzie do przewoźnika i pobranie nie
// tworzy przesyłek. Kolejność jak na liście. Pominięte (bez etykiety, anulowane, etykieta w ZPL, konto z wyłączonym
// nadawaniem, uszkodzony plik) trafiają na ostatnią stronę A4 „Pominięte” z powodem (bez danych klienta: numer
// nadania albo numer zamówienia). Strony etykiet kopiujemy 1:1 (pdf-lib), bez przeskalowania.
import type { PrismaClient } from '@prisma/client'
import { PDFDocument } from 'pdf-lib'
import { BladDruku } from '../druk/zlecenia'
import { FONT, FONT_B, MARGINES, doBufora, formatDataGodzina, nowyDokument, tekstJednaLinia } from '../wydruki/wspolne'
import { etykietaPrzesylkiPoId } from './etykieta-przewoznika'
import { kluczKonta, kontaPrzewoznikow } from './lista'
import { powodKontaWylaczonego } from './masowo'
import type { Pominieta } from './protokol'

type Db = PrismaClient

export interface EtykietyJednymPlikiem {
  /** null = żadnej etykiety PDF do złożenia (wtedy tylko raport) */
  pdf: Buffer | null
  dolaczone: number
  pominiete: Pominieta[]
}

async function stronaPominietych(pominiete: Pominieta[], now: Date): Promise<Buffer> {
  const doc = nowyDokument({ tytul: 'Etykiety: pominięte przesyłki', utworzono: now })
  let y = MARGINES
  tekstJednaLinia(doc, `Pominięte przesyłki: ${pominiete.length}`, MARGINES, y, 500, { font: FONT_B, rozmiar: 13 })
  y += 22
  tekstJednaLinia(doc, `Wydruk ${formatDataGodzina(now)}. Te przesyłki nie mają etykiety w tym pliku.`, MARGINES, y, 520, { rozmiar: 9 })
  y += 20
  for (const p of pominiete) {
    if (y > 800) {
      doc.addPage()
      y = MARGINES
    }
    tekstJednaLinia(doc, `${p.nr}: ${p.powod}`, MARGINES, y, 540, { font: FONT, rozmiar: 9 })
    y += 14
  }
  return doBufora(doc)
}

/**
 * Bramka konta dla pojedynczej etykiety pobieranej poza plikiem zbiorczym (ZPL z przycisku „Etykieta” w wierszu)
 * ta sama reguła co w pliku, konto z wyłączonym nadawaniem = powód zamiast etykiety. null = wolno
 * albo nie ma takiej przesyłki (wtedy odpowiada `etykietaPrzesylkiPoId`).
 */
export async function powodBlokadyEtykiety(db: Db, id: string): Promise<string | null> {
  const s = await db.shipment.findUnique({ where: { id }, select: { adapterKey: true, accountSuffix: true } })
  if (!s) return null
  return powodKontaWylaczonego((await kontaPrzewoznikow(db, undefined, { zPrzesylek: false })).get(kluczKonta(s.adapterKey, s.accountSuffix)))
}

export async function etykietyJednymPlikiem(db: Db, ids: string[], o: { now?: Date } = {}): Promise<EtykietyJednymPlikiem> {
  const now = o.now ?? new Date()
  const konta = await kontaPrzewoznikow(db, undefined, { zPrzesylek: false })
  const rows = await db.shipment.findMany({ where: { id: { in: ids } }, select: { id: true, adapterKey: true, accountSuffix: true, trackingNumber: true, order: { select: { channelNumber: true, externalId: true } } } })
  const poId = new Map(rows.map((r) => [r.id, r]))
  const wynik = await PDFDocument.create()
  const pominiete: Pominieta[] = []
  let dolaczone = 0
  for (const id of ids) {
    const s = poId.get(id)
    if (!s) {
      pominiete.push({ id, nr: id, powod: 'nie ma takiej przesyłki' })
      continue
    }
    const nr = s.trackingNumber ?? s.order.channelNumber ?? s.order.externalId
    // każda przesyłka osobno: jedna zła etykieta nie psuje pliku z pozostałymi
    try {
      const wylaczone = powodKontaWylaczonego(konta.get(kluczKonta(s.adapterKey, s.accountSuffix)))
      if (wylaczone) {
        pominiete.push({ id, nr, powod: wylaczone })
        continue
      }
      const e = await etykietaPrzesylkiPoId(db, s.id)
      if (!e.pdf) {
        pominiete.push({ id, nr, powod: 'etykieta w formacie ZPL (drukarka termiczna): użyj „Drukuj etykiety”' })
        continue
      }
      const zrodlo = await PDFDocument.load(e.pdf)
      const strony = await wynik.copyPages(zrodlo, zrodlo.getPageIndices())
      for (const st of strony) wynik.addPage(st)
      dolaczone++
    } catch (err) {
      pominiete.push({ id, nr, powod: err instanceof BladDruku ? err.message : 'uszkodzony plik etykiety: pobierz etykietę ponownie na karcie zamówienia' })
    }
  }
  if (pominiete.length) {
    const raport = await PDFDocument.load(await stronaPominietych(pominiete, now))
    for (const st of await wynik.copyPages(raport, raport.getPageIndices())) wynik.addPage(st)
  }
  if (!dolaczone && !pominiete.length) return { pdf: null, dolaczone, pominiete }
  return { pdf: Buffer.from(await wynik.save()), dolaczone, pominiete }
}
