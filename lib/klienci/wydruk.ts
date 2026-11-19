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

export async function daneKlientaDoWydruku(db: PrismaClient, orderIds: readonly string[], userId: string): Promise<Map<string, KlientNaWydruku>> {
  const out = new Map<string, KlientNaWydruku>()
  for (const id of orderIds) {
    const d = await daneKlienta(db, id, { actorId: userId, zakres: 'PELNY', cel: 'WYDRUK' })
    if (d.stan === 'PELNY') out.set(id, { skrot: imieNazwiskoMiasto(d.rekord), adres: adresDoKopii(d.rekord)?.split('\n') ?? null })
    else if (d.stan === 'SKROT') out.set(id, { skrot: naSkrot(d.skrot), adres: null })
  }
  return out
}
