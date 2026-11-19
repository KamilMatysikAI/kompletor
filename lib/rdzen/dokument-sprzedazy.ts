// Czy zamówienie ma już dokument sprzedaży (wFirma, KSeF, BaseLinker), który zmiana na karcie by rozjechała.
// Jedno źródło dla dwóch blokad: danych do faktury (lib/klienci/edycja-danych.ts, E2) i pozycji zamówienia
// (lib/rdzen/edycja.ts, E3). Sam odczyt, bez zapisu; `podBlokada` (w transakcji, po `lockOrder`) blokuje szkice KSeF
// FOR UPDATE, żeby wysyłka do KSeF nie wystartowała w trakcie zmiany.
import { Prisma, type PrismaClient } from '@prisma/client'
import { fakturaZBl } from './faktura-bl'
import { probaNiewiadoma } from './proba-niewiadoma'

type Db = PrismaClient | Prisma.TransactionClient

/** Statusy szkicu KSeF po rozpoczęciu wysyłki (lib/ksef/szkice.ts re-eksportuje tę listę). */
export const STATUSY_KSEF_WYSYLKA = ['WYSYLANA', 'WYSLANA', 'PRZYJETA', 'ODRZUCONA', 'BLAD_WYSYLKI'] as const

export interface SzkicKsef {
  status: string
  rodzaj: string
  hasheWyslane: string[]
  sesjaRef: string | null
}

/** Odrzucona albo z błędem wysyłki, ale żadna wersja nie mogła dojść do KSeF (to samo kryterium co zmiana daty w `wysylka.ts`). */
export const ksefDoPonowienia = (s: SzkicKsef): boolean => (s.status === 'ODRZUCONA' || s.status === 'BLAD_WYSYLKI') && s.hasheWyslane.length === 0 && !s.sesjaRef

/** Szkic KSeF po rozpoczęciu wysyłki, który blokuje zmianę: WYSYLANA, WYSLANA, PRZYJETA i ODRZUCONA/BLAD_WYSYLKI ze śladem wysyłki. */
export const ksefBlokuje = (s: SzkicKsef): boolean => (STATUSY_KSEF_WYSYLKA as readonly string[]).includes(s.status) && !ksefDoPonowienia(s)

/** Najnowsza próba wFirmy każdej paczki skończyła się niewiadomą (FAILED po timeoucie): dokument mógł powstać. */
export function niewiadomaWfirmy(proby: { orderId: string; packageNo: number; attemptNo: number; state: string; lastError: string | null }[]): boolean {
  const najnowsze = new Map<string, (typeof proby)[number]>()
  for (const p of proby) {
    const k = `${p.orderId}/${p.packageNo}`
    const b = najnowsze.get(k)
    if (!b || p.attemptNo > b.attemptNo) najnowsze.set(k, p)
  }
  return [...najnowsze.values()].some(probaNiewiadoma)
}

/**
 * Faktura BaseLinkera (bez korekt) któregokolwiek z zamówień: kryterium rdzenia `fakturaZBl` (zdarzenie albo kopia po
 * numerze zamówienia BL, także jeszcze nierozliczona, z dziedziczeniem przez paczkę dodatkową) oraz kopia już
 * przypisana do zamówienia (`orderId`), gdy numer BL zamówienia jej nie wskazuje.
 */
async function fakturaBl(db: Db, ids: string[]): Promise<boolean> {
  const przypisana = await db.blInvoiceSnapshot.count({ where: { orderId: { in: ids }, OR: [{ kind: null }, { kind: 'normal' }] } })
  if (przypisana > 0) return true
  const zamowienia = await db.order.findMany({ where: { id: { in: ids } }, select: { id: true, blOrderId: true, parentOrderId: true } })
  for (const z of zamowienia) if ((await fakturaZBl(db, z)) !== null) return true
  return false
}

export type RodzajDokumentu = 'WFIRMA' | 'WFIRMA_NIEWIADOMA' | 'KSEF' | 'BL'

/**
 * Pierwszy dokument sprzedaży zamówień `orderIds`, który blokuje zmianę; null = brak. Próba wFirmy z jednoznacznym
 * błędem (FAILED) nie blokuje: ponowienie weźmie dane z bazy. Najnowsza próba FAILED po timeoucie blokuje (dokument mógł
 * powstać). KSeF odrzucona albo z błędem wysyłki bez śladu wysyłki nie blokuje: „Ponów” składa XML od nowa z bazy.
 */
export async function dokumentSprzedazy(db: Db, orderIds: readonly string[], o: { podBlokada?: boolean } = {}): Promise<RodzajDokumentu | null> {
  const ids = [...new Set(orderIds)]
  if (!ids.length) return null
  if ((await db.invoiceAttempt.count({ where: { orderId: { in: ids }, state: { not: 'FAILED' } } })) > 0) return 'WFIRMA'
  const nieudane = await db.invoiceAttempt.findMany({ where: { orderId: { in: ids }, state: 'FAILED' }, select: { orderId: true, packageNo: true, attemptNo: true, state: true, lastError: true } })
  if (niewiadomaWfirmy(nieudane)) return 'WFIRMA_NIEWIADOMA'
  const szkice: SzkicKsef[] = o.podBlokada
    ? await db.$queryRaw<SzkicKsef[]>`SELECT status, rodzaj, "hasheWyslane", "sesjaRef" FROM "KsefInvoiceDraft" WHERE "orderId" IN (${Prisma.join(ids)}) FOR UPDATE`
    : await db.ksefInvoiceDraft.findMany({ where: { orderId: { in: ids } }, select: { status: true, rodzaj: true, hasheWyslane: true, sesjaRef: true } })
  if (szkice.some(ksefBlokuje)) return 'KSEF'
  if (await fakturaBl(db, ids)) return 'BL'
  return null
}
