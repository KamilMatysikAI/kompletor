// Samopodpisany certyfikat RSA do atrapy KSeF: atrapa podaje go jako „klucz publiczny MF”, więc może
// odszyfrować klucz sesji i treść faktury (sprawdza numer, dubel 440). Wyłącznie testy. Pochodzenie: nasz kod
// z systemu najmu (packages/ksef/src/testing/self-signed-cert.ts), budowa DER bez bibliotek, tylko node:crypto.
import { createSign, generateKeyPairSync, randomBytes, randomInt } from 'node:crypto'

function derLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len])
  const bytes: number[] = []
  let l = len
  while (l > 0) {
    bytes.unshift(l & 0xff)
    l = Math.floor(l / 256)
  }
  return Buffer.concat([Buffer.from([0x80 | bytes.length]), Buffer.from(bytes)])
}
const derTag = (tag: number, content: Buffer) => Buffer.concat([Buffer.from([tag]), derLength(content.length), content])
const derSeq = (...parts: Buffer[]) => derTag(0x30, Buffer.concat(parts))
const derSet = (...parts: Buffer[]) => derTag(0x31, Buffer.concat(parts))
const derNull = () => derTag(0x05, Buffer.alloc(0))

// INTEGER w DER musi być zakodowany minimalnie: bez wiodących bajtów 0x00 (poza jednym, który
// chroni dodatnią liczbę z ustawionym najwyższym bitem). OpenSSL odrzuca nadmiarowe zera
// („illegal padding”), a losowy numer seryjny zaczynał się od 0x00 średnio raz na 256.
function derInt(value: Buffer): Buffer {
  let start = 0
  while (start < value.length - 1 && value[start] === 0) start++
  let buf = value.length === 0 ? Buffer.from([0]) : value.subarray(start)
  if ((buf[0] ?? 0) & 0x80) buf = Buffer.concat([Buffer.from([0]), buf])
  return derTag(0x02, buf)
}

function derOid(oid: string): Buffer {
  const parts = oid.split('.').map(Number)
  const bytes = [(parts[0] ?? 0) * 40 + (parts[1] ?? 0)]
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i] ?? 0
    const chunk = [v & 0x7f]
    v = Math.floor(v / 128)
    while (v > 0) {
      chunk.unshift((v & 0x7f) | 0x80)
      v = Math.floor(v / 128)
    }
    bytes.push(...chunk)
  }
  return derTag(0x06, Buffer.from(bytes))
}

const derUtf8 = (s: string) => derTag(0x0c, Buffer.from(s, 'utf8'))
const derPrintable = (s: string) => derTag(0x13, Buffer.from(s, 'ascii'))

function derUtcTime(d: Date): Buffer {
  const p = (n: number) => String(n).padStart(2, '0')
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  return derTag(0x17, Buffer.from(s, 'ascii'))
}

const nameAttr = (oid: string, value: Buffer) => derSet(derSeq(derOid(oid), value))

/** Certyfikat RSA 2048 (SHA-256) dla podanego NIP: tylko atrapa KSeF w testach. */
export function buildTestSealCertificate(
  nip: string,
  organizationName = 'Atrapa KSeF',
  opts: { serial?: Buffer } = {},
): {
  certPem: string
  keyPem: string
} {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const keyPem = String(privateKey.export({ type: 'pkcs8', format: 'pem' }))

  const subject = derSeq(
    nameAttr('2.5.4.6', derPrintable('PL')),
    nameAttr('2.5.4.10', derUtf8(organizationName)),
    nameAttr('2.5.4.97', derUtf8(`VATPL-${nip}`)),
    nameAttr('2.5.4.3', derUtf8(organizationName)),
  )
  const algId = derSeq(derOid('1.2.840.113549.1.1.11'), derNull()) // sha256WithRSAEncryption
  const tbs = derSeq(
    derTag(0xa0, derInt(Buffer.from([2]))), // wersja v3
    derInt(opts.serial ?? randomBytes(8)),
    algId,
    subject,
    derSeq(derUtcTime(new Date(Date.now() - 60_000)), derUtcTime(new Date(Date.now() + 365 * 24 * 3600 * 1000))),
    subject,
    spki,
  )
  const signature = createSign('RSA-SHA256').update(tbs).sign(privateKey)
  const der = derSeq(tbs, algId, derTag(0x03, Buffer.concat([Buffer.from([0]), signature])))
  const b64 = der.toString('base64').match(/.{1,64}/g)?.join('\n') ?? ''
  return { certPem: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`, keyPem }
}

