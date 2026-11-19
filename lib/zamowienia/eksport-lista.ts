// Eksport listy zamówień (CSV, XLSX): jedna logika kolumn dla obu formatów. Zamówienia z filtrów
// listy (albo zaznaczone), najwyżej EKSPORT_MAKS; bez danych osobowych klientów: numer, kanał, daty, status, przewoźnik,
// płatność, kwota, faktura, numer nadania, kraj i pozycje. Klient firmy z sesji (RLS).
import type { PrismaClient } from '@prisma/client'
import type { KolumnaArkusza, KomorkaProsta } from '@/lib/arkusz/xlsx'
import { accountName } from '@/lib/panel/dane'
import { CARRIER_LABEL, INVOICE_LABEL, PAYMENT_LABEL, STATUS_LABEL } from '@/lib/panel/format'
import { orderListLines } from '@/lib/panel/lista-zamowien'
import type { ListLine } from '@/lib/panel/lista-zamowien-linie'
import { type FiltryListy, SORT_DOMYSLNY, stronaListy } from '@/lib/panel/zamowienia-lista'
import { EKSPORT_MAKS } from './eksport-csv'

export const KOLUMNY_EKSPORTU: KolumnaArkusza[] = [
  { naglowek: 'Numer', typ: 'tekst', szerokosc: 16 },
  { naglowek: 'Numer w Kompletorze', typ: 'tekst', szerokosc: 28 },
  { naglowek: 'Kanał', typ: 'tekst', szerokosc: 20 },
  { naglowek: 'Źródło', typ: 'tekst', szerokosc: 12 },
  { naglowek: 'Data złożenia', typ: 'data', szerokosc: 17 },
  { naglowek: 'Status', typ: 'tekst', szerokosc: 16 },
  { naglowek: 'Przewoźnik', typ: 'tekst', szerokosc: 16 },
  { naglowek: 'Sposób dostawy', typ: 'tekst', szerokosc: 24 },
  { naglowek: 'Płatność', typ: 'tekst', szerokosc: 14 },
  { naglowek: 'Metoda płatności', typ: 'tekst', szerokosc: 16 },
  { naglowek: 'Kwota brutto', typ: 'kwota', szerokosc: 13 },
  { naglowek: 'Chce fakturę', typ: 'tekst', szerokosc: 12 },
  { naglowek: 'Faktura', typ: 'tekst', szerokosc: 14 },
  { naglowek: 'Numer nadania', typ: 'tekst', szerokosc: 22 },
  { naglowek: 'Kraj', typ: 'tekst', szerokosc: 6 },
  { naglowek: 'Pozycje', typ: 'tekst', szerokosc: 60 },
]

/** Wiersze eksportu w kolejności listy (data złożenia malejąco): wartości typowane (kwota jako liczba, data jako Date). */
export async function wierszeEksportu(db: PrismaClient, f: FiltryListy): Promise<KomorkaProsta[][]> {
  const { wiersze, konta } = await stronaListy(db, f, { sort: SORT_DOMYSLNY, pomin: 0, ile: EKSPORT_MAKS })
  const linie = new Map<string, ListLine[]>()
  for (let i = 0; i < wiersze.length; i += 500) {
    const m = await orderListLines(
      db,
      wiersze.slice(i, i + 500).map((w) => w.id),
    )
    for (const [k, v] of m) linie.set(k, v)
  }
  return wiersze.map((w) => [
    w.channelNumber ?? w.externalId,
    w.id,
    accountName(konta, w.channel, w.channelAccountId),
    w.sourceLabel,
    w.createdAtChannel,
    STATUS_LABEL[w.status],
    w.carrier ? CARRIER_LABEL[w.carrier] : '',
    w.deliveryMethod,
    PAYMENT_LABEL[w.paymentState],
    w.paymentMethod,
    Number(w.totalGross.toFixed(2)),
    w.wantInvoice ? 'tak' : 'nie',
    w.invoice ? INVOICE_LABEL[w.invoice] : '',
    w.shipment?.trackingNumber,
    w.country,
    (linie.get(w.id) ?? []).map((l) => `${l.qty} × ${l.title}`).join(' | '),
  ])
}
