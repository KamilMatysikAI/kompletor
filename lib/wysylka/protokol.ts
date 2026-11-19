// Protokół odbioru przesyłek: dokument, który podpisuje kurier przy odbiorze paczek. Dla wszystkich
// przewoźników to własna lista przekazanych paczek (lib/wydruki/lista-wysylkowa.ts, PDF A4 z polskimi znakami, pola na
// podpis), składana z bazy, bez żadnego żądania do przewoźnika. Protokół z systemu przewoźnika (DPD `generateProtocol`,
// Wysyłam z Allegro) zdjęty z tej wersji: wróci jako akcja POST z potwierdzeniem i zapisem
// wyniku w bazie. Do listy idą tylko przesyłki utworzone u przewoźnika (UTWORZONA, z numerem); pozostałe są pominięte
// z powodem. Pobranie listy nie tworzy przesyłek i nie zamawia kuriera.
import type { PrismaClient, Shipment } from '@prisma/client'
import { shippingListData } from '../pakowanie/dane'
import { listaWysylkowa } from '../wydruki/lista-wysylkowa'

type Db = PrismaClient

export class BladProtokolu extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BladProtokolu'
  }
}

export interface Pominieta {
  id: string
  nr: string
  powod: string
}

export interface Protokol {
  pdf: Buffer
  zrodlo: 'LISTA'
  /** np. „Lista przekazanych paczek, liczba przesyłek: 30” */
  opis: string
  pominiete: Pominieta[]
}

export async function protokolPrzesylek(db: Db, ids: string[], kto: { nazwa: string }, deps: { now?: () => Date } = {}): Promise<Protokol> {
  const now = deps.now?.() ?? new Date()
  const rows = await db.shipment.findMany({ where: { id: { in: ids } }, include: { order: { select: { channelNumber: true, externalId: true } } } })
  const kolejnosc = new Map(ids.map((id, i) => [id, i]))
  rows.sort((a, b) => (kolejnosc.get(a.id) ?? 0) - (kolejnosc.get(b.id) ?? 0))
  const pominiete: Pominieta[] = []
  const doProtokolu: (Shipment & { order: { channelNumber: string | null; externalId: string } })[] = []
  for (const s of rows) {
    const nr = s.trackingNumber ?? s.order.channelNumber ?? s.order.externalId
    if (s.state !== 'UTWORZONA' || !s.externalRef) pominiete.push({ id: s.id, nr, powod: s.state === 'ANULOWANA' ? 'przesyłka anulowana' : 'przesyłka nie jest utworzona u przewoźnika' })
    else doProtokolu.push(s)
  }
  if (!doProtokolu.length) throw new BladProtokolu('Żadna z zaznaczonych przesyłek nie jest utworzona u przewoźnika: protokół obejmuje tylko przesyłki z numerem nadania.')

  // własna lista przekazanych paczek: numery zamówień jak na karcie, numery nadania z wybranych przesyłek
  const orderIds = [...new Set(doProtokolu.map((s) => s.orderId))]
  const dane = await shippingListData(db, orderIds, { now, drukujacy: kto.nazwa })
  if (!dane) throw new BladProtokolu('Nie udało się wczytać zamówień przesyłek.')
  const poZamowieniu = new Map<string, string[]>()
  for (const s of doProtokolu) poZamowieniu.set(s.orderId, [...(poZamowieniu.get(s.orderId) ?? []), s.trackingNumber ?? s.externalRef!])
  // ta sama kolejność co w shippingListData (data w kanale, id), żeby numery nadania trafiły do swoich zamówień
  const zamowieniaPoId = await db.order.findMany({ where: { id: { in: orderIds } }, select: { id: true }, orderBy: [{ createdAtChannel: 'asc' }, { id: 'asc' }] })
  if (zamowieniaPoId.length !== dane.zamowienia.length) throw new BladProtokolu('Za dużo zamówień na jednej liście: zaznacz mniej przesyłek.')
  dane.zamowienia = dane.zamowienia.map((z, i) => {
    const numery = poZamowieniu.get(zamowieniaPoId[i]?.id ?? '') ?? []
    return { ...z, liczbaPaczek: Math.max(1, numery.length), numeryNadania: numery }
  })
  dane.opisOdbioru = dane.opisOdbioru ? `${dane.opisOdbioru} · lista przekazanych paczek` : 'lista przekazanych paczek'
  return { pdf: await listaWysylkowa(dane), zrodlo: 'LISTA', opis: `Lista przekazanych paczek, liczba przesyłek: ${doProtokolu.length}`, pominiete }
}
