// Powrót rezerwacji zamówień ze zwolnionym towarem po nieudanej płatności online, przed cofnięciem Kompletora do
// wersji, która zwalnia towar tylko razem z anulowaniem zamówienia. Starsza wersja nie zna znaczników zwolnienia:
// zamówienie „Nowe” bez rezerwacji poszłoby po wpłacie do realizacji bez towaru, a zmiana ilości w sklepie kończyłaby
// się błędem. Tu każde takie zamówienie dostaje rezerwację od nowa (czego nie ma, idzie na listę braków), a wszystkie
// terminy zwolnienia schodzą. Jedna firma (klient firmy, RLS), na zamówienie osobno (pod blokadą), błąd jednego nie
// zatrzymuje reszty. Domyślnie na sucho. Powtórka nic nie zmienia. Wynik bez danych osobowych: liczby i numery zamówień.
import type { PrismaClient } from '@prisma/client'
import { organizationIdOf } from '../db'
import { przywrocRezerwacjeZwolnionego } from './zamowienia'

export interface WynikPowrotuRezerwacjiFirmy {
  naSucho: boolean
  /** zamówień ze znacznikiem albo terminem zwolnienia */
  kandydaci: number
  /** numery zamówień, które dostały (dostałyby) rezerwację od nowa */
  przywrocone: string[]
  /** zamówienia już poza Nowymi (np. zamknięte punktem cięcia): same znaczniki zdjęte, bez rezerwacji */
  znacznikiZdjete: string[]
  /** towar jeszcze trzymany: zdjęty sam termin zwolnienia */
  terminZdjety: string[]
  /** sztuk zarezerwowanych od nowa i sztuk wpisanych na listę braków (wykonanie) */
  zarezerwowane: number
  braki: number
  bledy: { numer: string; blad: string }[]
}

export async function przywrocRezerwacjeZwolnionych(db: PrismaClient, opts: { naSucho?: boolean; now?: Date; actorId?: string } = {}): Promise<WynikPowrotuRezerwacjiFirmy> {
  // tylko klient firmy (RLS); klient systemowy przeszedłby po zamówieniach wszystkich firm
  organizationIdOf(db)
  const naSucho = opts.naSucho !== false
  const now = opts.now ?? new Date()
  const actorId = opts.actorId ?? 'system:powrot-rezerwacji'
  const orders = await db.order.findMany({
    where: { OR: [{ stockReleasedAt: { not: null } }, { stockReleaseAt: { not: null } }] },
    orderBy: [{ createdAtChannel: 'asc' }, { id: 'asc' }],
    select: { id: true, externalId: true, channelNumber: true },
  })
  const wynik: WynikPowrotuRezerwacjiFirmy = { naSucho, kandydaci: orders.length, przywrocone: [], znacznikiZdjete: [], terminZdjety: [], zarezerwowane: 0, braki: 0, bledy: [] }
  for (const o of orders) {
    const nr = o.channelNumber ?? o.externalId
    try {
      const r = await przywrocRezerwacjeZwolnionego(db, o.id, { now, naSucho, actorId })
      if (r.wynik === 'przywrocone') wynik.przywrocone.push(nr)
      else if (r.wynik === 'znaczniki-zdjete') wynik.znacznikiZdjete.push(nr)
      else if (r.wynik === 'termin-zdjety') wynik.terminZdjety.push(nr)
      wynik.zarezerwowane += r.reserved
      wynik.braki += r.short
    } catch (e) {
      wynik.bledy.push({ numer: nr, blad: (e instanceof Error ? e.message : String(e)).slice(0, 300) })
    }
  }
  return wynik
}
