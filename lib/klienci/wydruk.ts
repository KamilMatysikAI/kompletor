// Dane klienta na wydruk karty zamówienia: wg uprawnień osoby zlecającej wydruk — z `klienci.dane` pełny
// blok odbiorcy, z `klienci.skrot` imię, pierwsza litera nazwiska i miasto, bez uprawnień nic.
// Każde zamówienie = jeden wpis w dzienniku podglądów (`cel: WYDRUK`). Plik PDF z danymi nie zostaje w bazie dłużej
// niż do wyniku druku (lib/druk).
import type { PrismaClient } from '@prisma/client'
import type { OdbiorcaSkrot } from '../wydruki/typy'
import { daneKlienta } from './odczyt'
import { imieNazwiskoMiasto, type SkrotKlienta } from './rekord'
import { adresDoKopii } from './walidacja'

export interface KlientNaWydruku {
  skrot: OdbiorcaSkrot | null
  adres: string[] | null
}

const naSkrot = (s: SkrotKlienta | null): OdbiorcaSkrot | null => (s ? { imie: s.imie, nazwisko: s.nazwiskoSkrot, miasto: s.miasto } : null)

/** odbiorca na etykiecie odbioru osobistego (tylko w pamięci rysowania etykiety). */
export interface OdbiorcaEtykietyOdbioru {
  /** Imię i nazwisko (z `klienci.dane` i dla automatu) albo imię z pierwszą literą nazwiska (sam skrót). */
  kto: string | null
  /** Tylko przy pełnym odczycie; skrót nie ma telefonu. */
  telefon: string | null
}

/**
 * dane do etykiety odbioru osobistego, jeden wpis w dzienniku podglądów. Osoba z panelu i stanowiska: cel
 * WYDRUK z jej uprawnieniami (pełne dane z `klienci.dane`, inaczej skrót bez telefonu, bez uprawnień nic). Reguła
 * automatu (`automat:<id reguły>`, krok „Wydrukuj etykietę”): odczyt automatu wysyłki, cel PRZESYLKA, tak jak etykieta
 * przewoźnika z imieniem, nazwiskiem i telefonem odbiorcy. Paczka dodatkowa („dośle później”) bierze dane zamówienia
 * głównego. Wynik nie trafia do bazy, logu ani historii zamówienia, tylko do pliku etykiety.
 */
export async function odbiorcaNaEtykieteOdbioru(db: PrismaClient, orderId: string, actorId: string): Promise<OdbiorcaEtykietyOdbioru | null> {
  const o = await db.order.findUnique({ where: { id: orderId }, select: { parentOrderId: true } })
  const id = o?.parentOrderId ?? orderId
  const d = actorId.startsWith('automat:')
    ? await daneKlienta(db, id, { actorId: 'system:etykieta-odbioru', zakres: 'PELNY', cel: 'PRZESYLKA' })
    : await daneKlienta(db, id, { actorId, zakres: 'PELNY', cel: 'WYDRUK' })
  if (d.stan === 'PELNY') {
    const p = imieNazwiskoMiasto(d.rekord)
    return { kto: (p ? [p.imie, p.nazwisko].filter(Boolean).join(' ') : '') || null, telefon: d.rekord.telefon?.trim() || null }
  }
  if (d.stan === 'SKROT' && d.skrot) return { kto: [d.skrot.imie, d.skrot.nazwiskoSkrot].filter(Boolean).join(' ') || null, telefon: null }
  return null
}

export async function daneKlientaDoWydruku(db: PrismaClient, orderIds: readonly string[], userId: string): Promise<Map<string, KlientNaWydruku>> {
  const out = new Map<string, KlientNaWydruku>()
  for (const id of orderIds) {
    const d = await daneKlienta(db, id, { actorId: userId, zakres: 'PELNY', cel: 'WYDRUK' })
    if (d.stan === 'PELNY') out.set(id, { skrot: imieNazwiskoMiasto(d.rekord), adres: adresDoKopii(d.rekord)?.split('\n') ?? null })
    else if (d.stan === 'SKROT') out.set(id, { skrot: naSkrot(d.skrot), adres: null })
  }
  return out
}
