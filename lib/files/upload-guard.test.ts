// osłona uploadu — bomba ZIP, podmieniony typ, za duży plik, path traversal, SVG/HTML, wymiary obrazu.
import { describe, expect, it } from 'vitest'
import { guardUploadBytes, IMAGE_POLICY, imageSize, readUpload, readUploads, sanitizeUploadName, sniffFileKind } from './upload-guard'

/** Minimalny nagłówek PNG z IHDR o zadanych wymiarach (reszta pliku nieistotna dla osłony). */
function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(40)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], 0)
  b.set([...'IHDR'].map((c) => c.charCodeAt(0)), 12)
  const dv = new DataView(b.buffer)
  dv.setUint32(16, w)
  dv.setUint32(20, h)
  return b
}

/** JPEG: SOI, APP0 (16 B), SOF0 z wymiarami. */
function jpg(w: number, h: number): Uint8Array {
  const b = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...new Array(14).fill(0), 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, ...new Array(12).fill(0)])
  return b
}

const file = (bytes: Uint8Array, name: string, type = 'image/png') => new File([bytes as Uint8Array<ArrayBuffer>], name, { type })

describe('rozpoznanie typu po bajtach', () => {
  it('obrazy, PDF, ZIP, SVG, HTML', () => {
    expect(sniffFileKind(png(10, 10))).toBe('png')
    expect(sniffFileKind(jpg(10, 10))).toBe('jpg')
    expect(sniffFileKind(new TextEncoder().encode('%PDF-1.7'))).toBe('pdf')
    expect(sniffFileKind(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]))).toBe('zip')
    expect(sniffFileKind(new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="x"><script>1</script></svg>'))).toBe('svg')
    expect(sniffFileKind(new TextEncoder().encode('<!DOCTYPE html><html><body>x'))).toBe('html')
    expect(sniffFileKind(new Uint8Array())).toBe('empty')
  })

  it('wymiary z nagłówka PNG i JPEG', () => {
    expect(imageSize(png(800, 600), 'png')).toEqual({ width: 800, height: 600 })
    expect(imageSize(jpg(1024, 768), 'jpg')).toEqual({ width: 1024, height: 768 })
  })
})

describe('polityka zdjęć produktu', () => {
  it('przyjmuje PNG i JPEG z wymiarami', () => {
    expect(guardUploadBytes(png(800, 600), IMAGE_POLICY)).toMatchObject({ ok: true, kind: 'png', width: 800, height: 600 })
    expect(guardUploadBytes(jpg(100, 50), IMAGE_POLICY)).toMatchObject({ ok: true, kind: 'jpg', mime: 'image/jpeg' })
  })

  it('bomba ZIP i dokument Office: odmowa bez rozpakowania', () => {
    const zip = new Uint8Array(1000)
    zip.set([0x50, 0x4b, 0x03, 0x04])
    expect(guardUploadBytes(zip, IMAGE_POLICY)).toMatchObject({ ok: false, code: 'zip' })
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])
    expect(guardUploadBytes(ole, IMAGE_POLICY)).toMatchObject({ ok: false, code: 'zip' })
  })

  it('podmieniony typ: SVG z nazwą .png i typem image/png to odmowa', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>')
    const r = await readUpload(file(svg, 'zdjecie.png', 'image/png'), IMAGE_POLICY)
    expect(r).toMatchObject({ ok: false, code: 'markup' })
    const html = new TextEncoder().encode('<html><script>alert(1)</script></html>')
    expect(await readUpload(file(html, 'a.jpg', 'image/jpeg'), IMAGE_POLICY)).toMatchObject({ ok: false, code: 'markup' })
    expect(await readUpload(file(new TextEncoder().encode('%PDF-1.4 x'), 'a.png'), IMAGE_POLICY)).toMatchObject({ ok: false, code: 'wrong_type' })
  })

  it('za duży plik: odmowa z rozmiaru, zanim bajty zostaną przeczytane', async () => {
    const big = { size: IMAGE_POLICY.maxBytes + 1, name: 'duze.jpg', arrayBuffer: () => Promise.reject(new Error('nie wolno czytać')) }
    Object.setPrototypeOf(big, Blob.prototype)
    expect(await readUpload(big, IMAGE_POLICY)).toMatchObject({ ok: false, code: 'too_big' })
  })

  it('za duże wymiary (bomba pikseli) i nieczytelny nagłówek', () => {
    expect(guardUploadBytes(png(20_000, 100), IMAGE_POLICY)).toMatchObject({ ok: false, code: 'dimensions' })
    expect(guardUploadBytes(png(8000, 8000), IMAGE_POLICY)).toMatchObject({ ok: false, code: 'dimensions' })
    expect(guardUploadBytes(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), IMAGE_POLICY)).toMatchObject({ ok: false, code: 'dimensions' })
  })

  it('path traversal i znaki sterujące w nazwie', async () => {
    expect(sanitizeUploadName('../../etc/passwd.png', 'png')).toBe('passwd.png')
    expect(sanitizeUploadName(['..', '..', 'windows', 'a"b.jpg'].join(String.fromCharCode(92)), 'jpg')).toBe('ab.jpg')
    expect(sanitizeUploadName('...', 'webp', 'zdjecie')).toBe('zdjecie.webp')
    const r = await readUpload(file(png(10, 10), '../../x.exe'), IMAGE_POLICY)
    expect(r).toMatchObject({ ok: true, file: { fileName: 'x.png', kind: 'png' } })
  })

  it('kilka plików: limit liczby i jeden zły plik odrzuca całość', async () => {
    const ok = file(png(10, 10), 'a.png')
    expect(await readUploads([ok, ok, ok], IMAGE_POLICY, { maxFiles: 2 })).toMatchObject({ ok: false, code: 'too_many' })
    const bad = file(new TextEncoder().encode('<svg></svg>'), 'b.png')
    expect(await readUploads([ok, bad], IMAGE_POLICY)).toMatchObject({ ok: false, code: 'markup', originalName: 'b.png' })
    const r = await readUploads([ok, '', null], IMAGE_POLICY)
    expect(r.ok && r.files.length).toBe(1)
  })
})
