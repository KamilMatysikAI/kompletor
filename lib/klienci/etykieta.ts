// Etykieta przewoźnika przesyłki: plik od przewoźnika ma adres i telefon odbiorcy, więc w bazie leży
// zaszyfrowany tym samym pierścieniem co dane klienta (`CUSTOMER_DATA_KEYS`, lib/klienci/szyfr.ts), z osobnym AAD
// „<firma>:etykieta:<Shipment.id>”: szyfrogramu nie da się przenieść do innej przesyłki, innej firmy ani pomylić z rekordem
// klienta. Brak klucza = odmowa zapisu (BrakKluczaKlientow), przesyłka zostaje bez pliku i panel mówi dlaczego.
// Odszyfrowanie tylko tutaj i tylko do druku (lib/wysylka/etykieta-przewoznika.ts); bajty nie trafiają do logów.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { Env } from '../sekrety'
import { BladSzyfruKlienta, kluczeKlientowZEnv } from './szyfr'

/** Znacznik w `Shipment.labelError` po usunięciu danych klienta (retencja, RODO): etykiety już nie pobieramy ponownie. */
export const ETYKIETA_USUNIETA = 'Etykieta usunięta razem z danymi klienta.'

export interface SzyfrogramEtykiety {
  labelCiphertext: Uint8Array<ArrayBuffer>
  labelIv: Uint8Array<ArrayBuffer>
  labelAuthTag: Uint8Array<ArrayBuffer>
  labelKeyVersion: number
}

const bajty = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b)
const aad = (organizationId: string, shipmentId: string) => Buffer.from(`${organizationId}:etykieta:${shipmentId}`, 'utf8')

export function zaszyfrujEtykiete(env: Env, organizationId: string, shipmentId: string, plik: Buffer): SzyfrogramEtykiety {
  const ring = kluczeKlientowZEnv(env)
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', ring.keys.get(ring.current)!, iv)
  c.setAAD(aad(organizationId, shipmentId))
  const ct = Buffer.concat([c.update(plik), c.final()])
  return { labelCiphertext: bajty(ct), labelIv: bajty(iv), labelAuthTag: bajty(c.getAuthTag()), labelKeyVersion: ring.current }
}

export function odszyfrujEtykiete(
  env: Env,
  organizationId: string,
  shipmentId: string,
  s: { labelCiphertext: Uint8Array; labelIv: Uint8Array; labelAuthTag: Uint8Array; labelKeyVersion: number },
): Buffer {
  const ring = kluczeKlientowZEnv(env)
  const key = ring.keys.get(s.labelKeyVersion)
  if (!key) throw new BladSzyfruKlienta(`Etykietę zaszyfrowano kluczem v${s.labelKeyVersion}, którego nie ma w CUSTOMER_DATA_KEYS`)
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(s.labelIv))
    d.setAAD(aad(organizationId, shipmentId))
    d.setAuthTag(Buffer.from(s.labelAuthTag))
    return Buffer.concat([d.update(Buffer.from(s.labelCiphertext)), d.final()])
  } catch {
    throw new BladSzyfruKlienta(`Nie da się odszyfrować etykiety przesyłki ${shipmentId} (inny klucz, inna firma albo uszkodzony wpis)`)
  }
}
