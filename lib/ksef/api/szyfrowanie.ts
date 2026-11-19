// Szyfrowanie faktur do sesji interaktywnej KSeF API 2.x. Pochodzenie: nasz kod z systemu najmu
// (packages/ksef/src/online/encryption.ts) w wersji z DewFlow (lib/ksef/online/encryption.ts), działający produkcyjnie;
// przeniesiony bez zmian logiki, z nazwami w konwencji Kompletora. Tylko node:crypto.
//
// Wymagania MF (github.com/CIRFMF/ksef-api: sesja-interaktywna.md, faktury/weryfikacja-faktury.md):
// - klucz symetryczny 256 bit i IV 128 bit, nowy dla każdej sesji,
// - faktura szyfrowana AES-256-CBC z dopełnieniem PKCS#7,
// - klucz symetryczny szyfrowany RSAES-OAEP (SHA-256, MGF1-SHA-256) kluczem publicznym MF
//   z certyfikatu o `usage = SymmetricKeyEncryption` (GET /security/public-key-certificates),
// - faktura w UTF-8 BEZ BOM; skrót SHA-256 i rozmiar liczone z oryginału i szyfrogramu.
import {
  X509Certificate,
  constants as cryptoConstants,
  createCipheriv,
  createHash,
  publicEncrypt,
  randomBytes,
  type KeyObject,
} from 'node:crypto'

export type KsefPublicKeyUsage = 'KsefTokenEncryption' | 'SymmetricKeyEncryption'

/** Element odpowiedzi GET /security/public-key-certificates. */
export type KsefPublicKeyCertificate = {
  certificate: string
  publicKeyId: string
  validFrom: string
  validTo: string
  usage: string[]
}

/** Klucz publiczny MF: certyfikat DER z API albo gotowy klucz (testy). */
export type SessionPublicKey = {
  certificateDer?: Buffer
  publicKey?: KeyObject
  publicKeyId?: string
}

/** Pole `encryption` żądania POST /sessions/online. */
export type KsefEncryptionInfo = {
  encryptedSymmetricKey: string
  initializationVector: string
  publicKeyId?: string
}

export type SessionEncryption = {
  key: Buffer
  iv: Buffer
  info: KsefEncryptionInfo
}

/** Treść żądania POST /sessions/online/{ref}/invoices (bez pól opcjonalnych). */
export type EncryptedInvoicePayload = {
  invoiceHash: string
  invoiceSize: number
  encryptedInvoiceHash: string
  encryptedInvoiceSize: number
  encryptedInvoiceContent: string
}

/** Wybiera certyfikat MF o danym przeznaczeniu, ważny w chwili `now`; przy rotacji kluczy
 *  bierze najpóźniejszy `validFrom` (zalecenie MF). */
export function pickPublicKeyCertificate(
  certs: KsefPublicKeyCertificate[],
  usage: KsefPublicKeyUsage,
  now: Date = new Date(),
): { certificateDer: Buffer; publicKeyId: string } {
  const t = now.getTime()
  const candidates = certs
    .filter((c) => c.usage.includes(usage) && Date.parse(c.validFrom) <= t && Date.parse(c.validTo) >= t)
    .sort((a, b) => Date.parse(b.validFrom) - Date.parse(a.validFrom))
  const chosen = candidates[0]
  if (!chosen) throw new Error(`KSeF: brak ważnego certyfikatu klucza publicznego dla usage=${usage}`)
  return { certificateDer: Buffer.from(chosen.certificate, 'base64'), publicKeyId: chosen.publicKeyId }
}

/** Nowy klucz sesji + jego postać zaszyfrowana kluczem MF (do POST /sessions/online). */
export function createSessionEncryption(mf: SessionPublicKey): SessionEncryption {
  const publicKey = mf.publicKey ?? (mf.certificateDer ? new X509Certificate(mf.certificateDer).publicKey : null)
  if (!publicKey) throw new Error('KSeF: brak klucza publicznego MF do zaszyfrowania klucza sesji')
  const key = randomBytes(32)
  const iv = randomBytes(16)
  const encryptedKey = publicEncrypt(
    { key: publicKey, oaepHash: 'sha256', padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING },
    key,
  )
  const info: KsefEncryptionInfo = {
    encryptedSymmetricKey: encryptedKey.toString('base64'),
    initializationVector: iv.toString('base64'),
  }
  if (mf.publicKeyId) info.publicKeyId = mf.publicKeyId
  return { key, iv, info }
}

const sha256b64 = (buf: Buffer) => createHash('sha256').update(buf).digest('base64')

/** Szyfruje XML faktury kluczem sesji i liczy metadane wymagane przez KSeF. */
export function encryptInvoice(xml: string | Uint8Array, enc: Pick<SessionEncryption, 'key' | 'iv'>): EncryptedInvoicePayload {
  const bytes = typeof xml === 'string' ? Buffer.from(xml, 'utf8') : Buffer.from(xml)
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error('KSeF: faktura musi być w UTF-8 bez BOM')
  }
  const cipher = createCipheriv('aes-256-cbc', enc.key, enc.iv) // PKCS#7 domyślnie
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()])
  return {
    invoiceHash: sha256b64(bytes),
    invoiceSize: bytes.length,
    encryptedInvoiceHash: sha256b64(encrypted),
    encryptedInvoiceSize: encrypted.length,
    encryptedInvoiceContent: encrypted.toString('base64'),
  }
}
