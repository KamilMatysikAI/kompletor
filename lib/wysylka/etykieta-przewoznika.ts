// Źródło etykiety do druku: prawdziwa etykieta przewoźnika, gdy zamówienie ma utworzoną przesyłkę; atrapa
// „PRÓBA — NIE NADAWAĆ” (lib/druk/etykieta.ts) tylko wtedy, gdy przesyłki jeszcze nie ma (podgląd, ćwiczenie). Ponowny
// druk bierze zapisany plik (zaszyfrowany, lib/klienci/etykieta.ts) bez pytania przewoźnika, więc nie tworzy drugiej
// przesyłki. Przesyłka w toku albo niejednoznaczna = odmowa druku z powodem (atrapa w tej chwili mogłaby zmylić).
import type { PrismaClient, Shipment } from '@prisma/client'
import { organizationIdOf } from '@/lib/db'
import { atrapaEtykiety, type EtykietaDoDruku, type ZrodloEtykiety } from '@/lib/druk/etykieta'
import { BladDruku } from '@/lib/druk/zlecenia'
import { odszyfrujEtykiete } from '@/lib/klienci/etykieta'
import { BladSzyfruKlienta, KOMUNIKAT_BRAK_KLUCZA } from '@/lib/klienci/szyfr'
import { CARRIER_LABEL } from '@/lib/panel/format'
import type { Env } from '@/lib/sekrety'

/** Etykieta utworzonej przesyłki zamówienia; null = zamówienie nie ma żadnej przesyłki aktywnej (wtedy atrapa). */
export async function etykietaPrzesylki(db: PrismaClient, orderId: string, env: Env = process.env): Promise<EtykietaDoDruku | null> {
  // etykieta zamówienia = główna przesyłka; etykietę dodatkowej drukuje się z jej wiersza (blok „Przesyłki”, lista)
  const s = await db.shipment.findFirst({ where: { orderId, extraNo: 0, state: { in: ['TWORZENIE', 'UTWORZONA', 'NIEJEDNOZNACZNA'] } }, orderBy: { createdAt: 'desc' } })
  if (!s) return null
  return etykietaZWiersza(db, s, env)
}

/**
 * etykieta jednej przesyłki (lista przesyłek: druk i pobranie wielu naraz) z zapisanego pliku, bez pytania
 * przewoźnika. Odmowa (przesyłka w toku, niejednoznaczna, anulowana, bez etykiety) = BladDruku z powodem.
 */
export async function etykietaPrzesylkiPoId(db: PrismaClient, shipmentId: string, env: Env = process.env): Promise<EtykietaDoDruku> {
  const s = await db.shipment.findUnique({ where: { id: shipmentId } })
  if (!s) throw new BladDruku('Nie ma takiej przesyłki.', 404)
  if (s.state === 'ANULOWANA') throw new BladDruku('Przesyłka anulowana: etykieta nie nadaje się do nadania.', 409)
  if (s.state === 'BLAD') throw new BladDruku('Przesyłka nie powstała u przewoźnika: nie ma etykiety.', 409)
  return etykietaZWiersza(db, s, env)
}

async function etykietaZWiersza(db: PrismaClient, s: Shipment, env: Env): Promise<EtykietaDoDruku> {
  if (s.state === 'TWORZENIE') throw new BladDruku('Przesyłka właśnie powstaje u przewoźnika: odśwież kartę za chwilę.', 409)
  if (s.state === 'NIEJEDNOZNACZNA') throw new BladDruku('Nie wiadomo, czy przesyłka powstała: najpierw „Sprawdź u przewoźnika” na karcie zamówienia.', 409)
  if (!s.labelCiphertext || !s.labelIv || !s.labelAuthTag || s.labelKeyVersion === null || !s.labelFormat)
    throw new BladDruku('Etykieta nie została jeszcze pobrana od przewoźnika: kliknij „Pobierz etykietę” na karcie zamówienia.', 409)
  let plik: Buffer
  try {
    plik = odszyfrujEtykiete(env, organizationIdOf(db), s.id, { labelCiphertext: s.labelCiphertext, labelIv: s.labelIv, labelAuthTag: s.labelAuthTag, labelKeyVersion: s.labelKeyVersion })
  } catch (e) {
    if (e instanceof BladSzyfruKlienta) throw new BladDruku(KOMUNIKAT_BRAK_KLUCZA, 409)
    throw e
  }
  const opis = `Etykieta ${CARRIER_LABEL[s.carrier]}${s.trackingNumber ? ` ${s.trackingNumber}` : ''}`
  return s.labelFormat === 'ZPL' ? { zpl: plik, opis } : { pdf: plik, opis }
}

/** Domyślne źródło etykiety panelu: przewoźnik, gdy jest przesyłka; inaczej atrapa próbna. */
export const etykietaZamowienia: ZrodloEtykiety = {
  nazwa: 'przewoznik-albo-atrapa',
  async etykieta(db, orderId, now) {
    return (await etykietaPrzesylki(db, orderId)) ?? atrapaEtykiety.etykieta(db, orderId, now)
  },
}
