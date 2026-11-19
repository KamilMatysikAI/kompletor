// limity uploadu w jednym łańcuchu. Plik ≤ IMAGE_POLICY.maxBytes, żądanie
// ≤ UPLOAD_REQUEST_MAX_BYTES (osłona), ciało akcji serwera i proxy w next.config.ts trochę więcej — inaczej zdjęcie
// z telefonu kończy się błędem Next „Body exceeded 1mb limit” zamiast komunikatu osłony.
import { describe, expect, it } from 'vitest'
import nextConfig from '../../next.config'
import { IMAGE_POLICY, readUploads, SERVER_BODY_LIMIT_BYTES, UPLOAD_REQUEST_MAX_BYTES } from './upload-guard'

function bajty(v: unknown): number {
  if (typeof v === 'number') return v
  const m = /^(\d+)(kb|mb|gb)$/i.exec(String(v))
  if (!m) throw new Error(`nieznany limit ${String(v)}`)
  return Number(m[1]) * 1024 ** { kb: 1, mb: 2, gb: 3 }[m[2]!.toLowerCase() as 'kb' | 'mb' | 'gb']
}

describe('limity uploadu: osłona ↔ next.config.ts', () => {
  it('akcja serwera i proxy przyjmują żądanie większe niż łączny limit osłony', () => {
    const ex = nextConfig.experimental ?? {}
    expect(bajty(ex.serverActions?.bodySizeLimit)).toBe(SERVER_BODY_LIMIT_BYTES)
    expect(bajty(ex.proxyClientMaxBodySize)).toBe(SERVER_BODY_LIMIT_BYTES)
    expect(UPLOAD_REQUEST_MAX_BYTES).toBeLessThan(SERVER_BODY_LIMIT_BYTES)
    expect(IMAGE_POLICY.maxBytes).toBeLessThanOrEqual(UPLOAD_REQUEST_MAX_BYTES)
  })

  it('readUploads: suma rozmiarów ponad limit = odmowa przed czytaniem bajtów', async () => {
    let czytane = 0
    const plik = (size: number) => {
      const f = new File([new Uint8Array(1)], 'x.jpg')
      Object.defineProperty(f, 'size', { value: size })
      Object.defineProperty(f, 'arrayBuffer', { value: async () => ((czytane += 1), new ArrayBuffer(0)) })
      return f
    }
    const r = await readUploads([plik(10 * 1024 * 1024), plik(10 * 1024 * 1024), plik(10 * 1024 * 1024)], IMAGE_POLICY, { maxTotalBytes: 25 * 1024 * 1024 })
    expect(r).toMatchObject({ ok: false, code: 'too_big' })
    if (!r.ok) expect(r.message).toContain('w kilku turach')
    expect(czytane).toBe(0)
  })
})
