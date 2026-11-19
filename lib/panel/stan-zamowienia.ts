// (R8 z przeglądu TwojOMS 08.11): kolumna „Stan” listy zamówień, cztery ikony w stałej kolejności:
// płatność, przesyłka, dokument sprzedaży, zwrot. Ton: zielona = zrobione, szara = brak / nie dotyczy, czerwona =
// problem; bursztyn = czeka na człowieka, niebieska = w drodze (system pracuje). Opis idzie do podpowiedzi i czytnika.
// Czysty moduł (bez bazy), test w stan-zamowienia.test.ts. Dokument sprzedaży wg programu do faktur firmy
// firma bez programu (`brak`) widzi „dokumenty poza Kompletorem”, nie zakładamy wFirmy.
import type { Carrier, InvoiceState, OrderStatus, PaymentState, ReturnStatus, ShipmentState } from '@prisma/client'
import type { ProgramDokumentow } from '../dokumenty/ustawienia'

export type TonStanu = 'sukces' | 'neutralny' | 'blad' | 'ostrzezenie' | 'info'
export type RodzajStanu = 'platnosc' | 'przesylka' | 'dokument' | 'zwrot'

export interface IkonaStanu {
  rodzaj: RodzajStanu
  ton: TonStanu
  opis: string
}

export interface WejscieStanu {
  status: OrderStatus
  paymentState: PaymentState
  carrier: Carrier | null
  wantInvoice: boolean
  invoice: InvoiceState | null
  shipment: { state: ShipmentState; label: boolean } | null
  zwrot: { status: ReturnStatus; korekta: InvoiceState | null } | null
}

const WYSLANE: readonly OrderStatus[] = ['WYSLANE', 'ODEBRANE']

function platnosc(o: WejscieStanu): IkonaStanu {
  const r = 'platnosc' as const
  if (o.paymentState === 'PAID') return { rodzaj: r, ton: 'sukces', opis: 'Płatność: opłacone' }
  if (o.paymentState === 'COD') return { rodzaj: r, ton: 'info', opis: 'Płatność: za pobraniem, przy odbiorze' }
  if (o.paymentState === 'PARTIAL') return { rodzaj: r, ton: 'blad', opis: 'Płatność: niedopłata' }
  if (o.status === 'ANULOWANE') return { rodzaj: r, ton: 'neutralny', opis: 'Płatność: brak (zamówienie anulowane)' }
  if (WYSLANE.includes(o.status)) return { rodzaj: r, ton: 'blad', opis: 'Płatność: wysłane bez wpłaty' }
  return { rodzaj: r, ton: 'neutralny', opis: 'Płatność: nieopłacone' }
}

function przesylka(o: WejscieStanu): IkonaStanu {
  const r = 'przesylka' as const
  const s = o.shipment
  if (s?.state === 'BLAD') return { rodzaj: r, ton: 'blad', opis: 'Przesyłka: nie utworzyła się' }
  if (s?.state === 'NIEJEDNOZNACZNA') return { rodzaj: r, ton: 'blad', opis: 'Przesyłka: do sprawdzenia u przewoźnika' }
  if (o.status === 'ODEBRANE') return { rodzaj: r, ton: 'sukces', opis: 'Przesyłka: doręczona' }
  if (o.status === 'WYSLANE') return { rodzaj: r, ton: 'sukces', opis: s ? 'Przesyłka: wysłana' : 'Przesyłka: wysłana (bez przesyłki w Kompletorze)' }
  if (s?.state === 'UTWORZONA') return s.label ? { rodzaj: r, ton: 'sukces', opis: 'Przesyłka: utworzona, etykieta gotowa' } : { rodzaj: r, ton: 'info', opis: 'Przesyłka: utworzona, etykieta w drodze' }
  if (s?.state === 'TWORZENIE') return { rodzaj: r, ton: 'info', opis: 'Przesyłka: powstaje' }
  if (o.carrier === 'BEZ_WYSYLKI') return { rodzaj: r, ton: 'neutralny', opis: 'Przesyłka: bez wysyłki' }
  if (o.carrier === 'OSOBISTY') return { rodzaj: r, ton: 'neutralny', opis: 'Przesyłka: odbiór osobisty' }
  return { rodzaj: r, ton: 'neutralny', opis: s?.state === 'ANULOWANA' ? 'Przesyłka: anulowana' : 'Przesyłka: jeszcze nie utworzona' }
}

function dokument(o: WejscieStanu, program: ProgramDokumentow): IkonaStanu {
  const r = 'dokument' as const
  if (o.invoice === 'ISSUED') return { rodzaj: r, ton: 'sukces', opis: 'Dokument sprzedaży: wystawiony' }
  if (o.invoice === 'FAILED') return { rodzaj: r, ton: 'blad', opis: 'Dokument sprzedaży: nie wystawił się' }
  if (o.invoice === 'SENDING' || o.invoice === 'UNKNOWN') return { rodzaj: r, ton: 'info', opis: 'Dokument sprzedaży: w drodze' }
  if (program === 'brak') return { rodzaj: r, ton: 'neutralny', opis: o.wantInvoice ? 'Dokument sprzedaży: klient chce fakturę, wystawiasz ją poza Kompletorem' : 'Dokument sprzedaży: wystawiany poza Kompletorem' }
  if (o.status === 'ANULOWANE') return { rodzaj: r, ton: 'neutralny', opis: 'Dokument sprzedaży: nie dotyczy (anulowane)' }
  if (o.wantInvoice) return WYSLANE.includes(o.status) ? { rodzaj: r, ton: 'blad', opis: 'Dokument sprzedaży: klient chce fakturę, paczka wysłana bez niej' } : { rodzaj: r, ton: 'ostrzezenie', opis: 'Dokument sprzedaży: klient chce fakturę, jeszcze nie wystawiona' }
  return { rodzaj: r, ton: 'neutralny', opis: 'Dokument sprzedaży: jeszcze nie wystawiony' }
}

function zwrot(o: WejscieStanu): IkonaStanu {
  const r = 'zwrot' as const
  const z = o.zwrot
  if (!z) return o.status === 'REKLAMACJA' ? { rodzaj: r, ton: 'ostrzezenie', opis: 'Zwrot: reklamacja w toku' } : { rodzaj: r, ton: 'neutralny', opis: 'Zwrot: brak' }
  if (z.status === 'ZAKONCZONY') return { rodzaj: r, ton: 'sukces', opis: 'Zwrot: rozliczony' }
  if (z.status === 'ODRZUCONY') return { rodzaj: r, ton: 'neutralny', opis: 'Zwrot: odrzucony albo wycofany' }
  if (z.status === 'KOREKTA') return z.korekta === 'FAILED' ? { rodzaj: r, ton: 'blad', opis: 'Zwrot: korekta nie wystawiła się' } : { rodzaj: r, ton: 'info', opis: 'Zwrot: korekta w drodze' }
  return { rodzaj: r, ton: 'ostrzezenie', opis: z.status === 'PRZYJETY' ? 'Zwrot: przyjęty w magazynie, czeka na rozliczenie' : 'Zwrot: zgłoszony, paczka w drodze' }
}

/** Cztery ikony w stałej kolejności: płatność, przesyłka, dokument sprzedaży, zwrot. */
export function stanZamowienia(o: WejscieStanu, program: ProgramDokumentow): [IkonaStanu, IkonaStanu, IkonaStanu, IkonaStanu] {
  return [platnosc(o), przesylka(o), dokument(o, program), zwrot(o)]
}
