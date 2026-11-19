// linia nad „Utwórz przesyłkę” o poprzedniej przesyłce paczki, którą
// anulowano albo oznaczono ręcznie jako niepowstałą (kto, kiedy). Dla karty zamówienia i stanowiska pakowania; bez danych
// klienta. Nazwa osoby z członków firmy (obce id = brak nazwy).
import type { PrismaClient } from '@prisma/client'
import { nazwyOsobFirmy } from '@/lib/panel/ustawienia-rezerwacji'
import { sladAnulowanej } from './nadanie'

export interface PoprzedniaPrzesylka {
  /** ISO, do pokazania w strefie przeglądarki. */
  kiedy: string
  recznie: boolean
  kto: string | null
}

export async function poprzedniaPrzesylka(db: PrismaClient, orderId: string, opts: { sys?: () => PrismaClient } = {}): Promise<PoprzedniaPrzesylka | null> {
  const s = await sladAnulowanej(db, orderId)
  if (!s) return null
  const uid = s.actorId?.startsWith('user:') ? s.actorId.slice(5) : null
  const kto = uid ? ((await nazwyOsobFirmy(db, [uid], opts)).get(uid) ?? null) : null
  return { kiedy: s.kiedy.toISOString(), recznie: s.recznie, kto }
}
