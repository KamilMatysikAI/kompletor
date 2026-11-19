// Osłona uploadu (zasada 17 roli soft, punkt 8 checklisty audytu): JEDNA droga dla pliku wgranego
// z przeglądarki do akcji serwerowej albo trasy. Wzorzec: system-najmu `lib/files/upload-guard.ts` (kopia w repo).
//
//  1. limit rozmiaru z `File.size` PRZED wczytaniem bajtów, potem drugi raz po bajtach,
//  2. typ po zawartości (`sniffFileKind`), nigdy po nazwie ani `Content-Type` z przeglądarki,
//  3. archiwa ZIP (w tym DOCX/XLSX) i stare pliki Office (OLE, makra) = odmowa: żadna polityka w Kompletorze ich dziś
//     nie przyjmuje, więc nic nie jest rozpakowywane (bomba ZIP nie ma szansy). Polityka przyjmująca DOCX/XLSX wymaga
//     najpierw strażnika ZIP (liczba wpisów, rozmiar po rozpakowaniu) — jak w system-najmu,
//  4. SVG i HTML zawsze odmowa (skrypt w obrazku albo stronie),
//  5. nazwa pliku bez ścieżki (`../`), znaków sterujących i cudzysłowów, z rozszerzeniem z rozpoznanego typu,
//  6. obrazy: wymiary z nagłówka (PNG, JPEG, WEBP) i limit pikseli, zanim cokolwiek je zdekoduje,
//  7. CSV: czysty tekst w UTF-8 (bez bajtów zerowych, bez znaczników HTML/SVG, poprawne UTF-8), nic
//     więcej nie jest interpretowane przy sprawdzeniu.
//
// Zasada dla nowego kodu: każdy upload tylko przez `readUpload` / `readUploads`. Test `upload-entry-points.test.ts`
// pada, gdy plik w `app/` albo `lib/` czyta pole formularza i bajty z pominięciem osłony.

export type FileKind = 'jpg' | 'png' | 'webp' | 'pdf' | 'csv'
export type SniffedKind = FileKind | 'zip' | 'ole' | 'svg' | 'html' | 'gif' | 'text' | 'binary' | 'empty'
export type UploadErrorCode = 'too_big' | 'wrong_type' | 'zip' | 'markup' | 'empty' | 'dimensions' | 'too_many'

export const FILE_KIND_MIME: Record<FileKind, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf', csv: 'text/csv' }
const KIND_LABEL: Record<FileKind, string> = { jpg: 'JPG', png: 'PNG', webp: 'WEBP', pdf: 'PDF', csv: 'CSV' }

export interface UploadPolicy {
  /** Przyjmowane rodzaje (po bajtach). */
  kinds: readonly FileKind[]
  maxBytes: number
  /** Obrazy: najwięcej pikseli (szerokość × wysokość) i najdłuższy bok, sprawdzane z nagłówka pliku. */
  maxPixels?: number
  maxSide?: number
}

/** Zdjęcia produktu: JPG, PNG, WEBP do 15 MB (zdjęcie z telefonu), do 40 Mpx i 12 000 px boku. */
export const IMAGE_POLICY: UploadPolicy = { kinds: ['jpg', 'png', 'webp'], maxBytes: 15 * 1024 * 1024, maxPixels: 40_000_000, maxSide: 12_000 }

/** Katalog produktów z pliku CSV: tekst UTF-8 do 5 MB (ok. 20 000 wierszy). */
export const CSV_POLICY: UploadPolicy = { kinds: ['csv'], maxBytes: 5 * 1024 * 1024 }

/**
 * Łącznie na jedno żądanie (wszystkie pliki z formularza), sprawdzane z `File.size` przed czytaniem bajtów: do pamięci
 * nie trafia więcej niż tyle, zanim sprawdzimy produkt i firmę. Limit ciała akcji serwera
 * i proxy w `next.config.ts` (64 MB) jest nieco wyższy, żeby za duże żądanie dostało ten komunikat, a nie błąd Next.
 */
export const UPLOAD_REQUEST_MAX_BYTES = 60 * 1024 * 1024
/** Limit ciała akcji serwera i proxy w `next.config.ts` (bajty); test spójności: `upload-limity.test.ts`. */
export const SERVER_BODY_LIMIT_BYTES = 64 * 1024 * 1024

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, Math.min(to, b.length)))
const OLE_SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

/** Rodzaj pliku po pierwszych bajtach. Bez rozpakowywania i bez dekodowania. */
export function sniffFileKind(bytes: Uint8Array): SniffedKind {
  if (bytes.length === 0) return 'empty'
  if (ascii(bytes, 0, 5) === '%PDF-') return 'pdf'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  if (bytes[0] === 0x89 && ascii(bytes, 1, 4) === 'PNG') return 'png'
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'webp'
  if (ascii(bytes, 0, 4) === 'GIF8') return 'gif'
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)) return 'zip'
  if (bytes.length >= 8 && OLE_SIG.every((v, i) => bytes[i] === v)) return 'ole'
  const probe = bytes.subarray(0, 8192)
  if (probe.includes(0)) return 'binary'
  const head = ascii(probe, 0, 4096).toLowerCase()
  if (/<svg[\s>]/.test(head)) return 'svg'
  if (/<!doctype html|<html[\s>]|<script[\s>]|<body[\s>]|<iframe[\s>]/.test(head)) return 'html'
  return 'text'
}

/** Wymiary obrazu z nagłówka (PNG IHDR, JPEG SOFn, WEBP VP8/VP8L/VP8X); null = nie da się odczytać. */
export function imageSize(bytes: Uint8Array, kind: FileKind): { width: number; height: number } | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  try {
    if (kind === 'png') {
      if (bytes.length < 24 || ascii(bytes, 12, 16) !== 'IHDR') return null
      return { width: dv.getUint32(16), height: dv.getUint32(20) }
    }
    if (kind === 'jpg') {
      let i = 2
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) return null
        const marker = bytes[i + 1]!
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          i += 2
          continue
        }
        const len = dv.getUint16(i + 2)
        // SOF0..SOF15 bez DHT (C4), JPG (C8) i DAC (CC)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: dv.getUint16(i + 7), height: dv.getUint16(i + 5) }
        if (marker === 0xda || len < 2) return null
        i += 2 + len
      }
      return null
    }
    if (kind === 'webp') {
      const chunk = ascii(bytes, 12, 16)
      if (chunk === 'VP8X' && bytes.length >= 30) return { width: 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)), height: 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) }
      if (chunk === 'VP8 ' && bytes.length >= 30) return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff }
      if (chunk === 'VP8L' && bytes.length >= 25) {
        const b = dv.getUint32(21, true)
        return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) }
      }
      return null
    }
  } catch {
    return null
  }
  return null
}

export type UploadCheck = { ok: true; kind: FileKind; mime: string; ext: string; width?: number; height?: number } | { ok: false; code: UploadErrorCode; message: string }

export const tooBigMessage = (p: UploadPolicy) => `Plik jest za duży (najwyżej ${Math.round(p.maxBytes / 1024 / 1024)} MB).`
const allowedLabel = (p: UploadPolicy) => p.kinds.map((k) => KIND_LABEL[k]).join(', ')

/** Pełne sprawdzenie bajtów wg polityki (też dla plików spoza formularza, np. zdjęcia pobranego z oferty sklepu). */
export function guardUploadBytes(bytes: Uint8Array, policy: UploadPolicy): UploadCheck {
  if (bytes.length > policy.maxBytes) return { ok: false, code: 'too_big', message: tooBigMessage(policy) }
  const kind = sniffFileKind(bytes)
  if (kind === 'empty') return { ok: false, code: 'empty', message: 'Plik jest pusty.' }
  if (kind === 'zip' || kind === 'ole') return { ok: false, code: 'zip', message: `Archiwa i dokumenty Office nie są przyjmowane. Dozwolone: ${allowedLabel(policy)}.` }
  if (kind === 'svg' || kind === 'html') return { ok: false, code: 'markup', message: `Pliki SVG i HTML nie są przyjmowane. Dozwolone: ${allowedLabel(policy)}.` }
  if (kind === 'text' && policy.kinds.includes('csv')) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return { ok: false, code: 'wrong_type', message: 'Plik CSV musi być zapisany w UTF-8 (w Excelu: „CSV UTF-8 (rozdzielany przecinkami)”).' }
    }
    return { ok: true, kind: 'csv', mime: FILE_KIND_MIME.csv, ext: 'csv' }
  }
  // Excel „Tekst Unicode” zapisuje UTF-16 (BOM FF FE albo FE FF, bajty zerowe → „binary”): podpowiedź o UTF-8 zamiast
  // „nieobsługiwany rodzaj pliku”. Plik i tak jest odrzucony.
  if (kind === 'binary' && policy.kinds.includes('csv') && bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)))
    return { ok: false, code: 'wrong_type', message: 'Plik CSV musi być zapisany w UTF-8 (w Excelu: „CSV UTF-8 (rozdzielany przecinkami)”), a nie jako „Tekst Unicode”.' }
  if (!(policy.kinds as readonly string[]).includes(kind)) return { ok: false, code: 'wrong_type', message: `Nieobsługiwany rodzaj pliku. Dozwolone: ${allowedLabel(policy)}.` }
  const k = kind as FileKind
  const base = { ok: true as const, kind: k, mime: FILE_KIND_MIME[k], ext: k }
  if (k === 'pdf') return base
  const size = imageSize(bytes, k)
  if (!size || size.width < 1 || size.height < 1) return { ok: false, code: 'dimensions', message: 'Nie da się odczytać wymiarów obrazu (plik uszkodzony?).' }
  if ((policy.maxSide && Math.max(size.width, size.height) > policy.maxSide) || (policy.maxPixels && size.width * size.height > policy.maxPixels))
    return { ok: false, code: 'dimensions', message: `Obraz ma za duże wymiary (${size.width}×${size.height} px).` }
  return { ...base, ...size }
}

/** Nazwa pliku do zapisu i nagłówków: bez katalogów, znaków sterujących i cudzysłowów, rozszerzenie z typu. */
export function sanitizeUploadName(name: string, kind: FileKind, fallback = 'plik'): string {
  const last = name.split(/[\\/]/).pop() ?? ''
  const stem = last
    .replace(/\.[^.]*$/, '')
    .replace(/[\u0000-\u001f\u007f"'`<>|:*?]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 80)
  return `${stem || fallback}.${kind}`
}

export type GuardedUpload = { content: Buffer; fileName: string; originalName: string; kind: FileKind; mime: string; size: number; width?: number; height?: number }
export type UploadResult = { ok: true; file: GuardedUpload } | { ok: false; code: UploadErrorCode; message: string; originalName: string }

const isBlob = (v: unknown): v is Blob => typeof Blob !== 'undefined' && v instanceof Blob
const nameOf = (v: Blob) => {
  const n = (v as { name?: unknown }).name
  return typeof n === 'string' ? n : ''
}

/** Plik z pola formularza. `null` = brak pliku. Limit z `size` sprawdzamy, ZANIM przeczytamy bajty. */
export async function readUpload(entry: unknown, policy: UploadPolicy, opts: { fallbackName?: string } = {}): Promise<UploadResult | null> {
  if (!isBlob(entry) || entry.size === 0) return null
  const originalName = nameOf(entry)
  if (entry.size > policy.maxBytes) return { ok: false, code: 'too_big', message: tooBigMessage(policy), originalName }
  const content = Buffer.from(await entry.arrayBuffer())
  const check = guardUploadBytes(content, policy)
  if (!check.ok) return { ...check, originalName }
  return {
    ok: true,
    file: { content, fileName: sanitizeUploadName(originalName, check.kind, opts.fallbackName), originalName, kind: check.kind, mime: check.mime, size: content.length, width: check.width, height: check.height },
  }
}

export type UploadsResult = { ok: true; files: GuardedUpload[] } | { ok: false; code: UploadErrorCode; message: string; originalName: string | null }

/** Kilka plików z jednego pola. Najpierw liczba i rozmiary (bez czytania bajtów), potem każdy plik; zły = odmowa całości. */
export async function readUploads(entries: readonly unknown[], policy: UploadPolicy, opts: { maxFiles?: number; maxTotalBytes?: number } = {}): Promise<UploadsResult> {
  const blobs = entries.filter((e): e is Blob => isBlob(e) && e.size > 0)
  if (opts.maxFiles !== undefined && blobs.length > opts.maxFiles) return { ok: false, code: 'too_many', message: `Na raz najwyżej ${opts.maxFiles} plików.`, originalName: null }
  const big = blobs.find((b) => b.size > policy.maxBytes)
  if (big) return { ok: false, code: 'too_big', message: `Plik ${nameOf(big)}: ${tooBigMessage(policy)}`, originalName: nameOf(big) }
  const total = blobs.reduce((s, b) => s + b.size, 0)
  const maxTotal = opts.maxTotalBytes ?? UPLOAD_REQUEST_MAX_BYTES
  if (total > maxTotal)
    return {
      ok: false,
      code: 'too_big',
      message: `Pliki razem mają ${Math.ceil(total / 1024 / 1024)} MB, a na raz można wgrać najwyżej ${Math.round(maxTotal / 1024 / 1024)} MB: wgraj je w kilku turach.`,
      originalName: null,
    }
  const files: GuardedUpload[] = []
  for (const b of blobs) {
    const r = await readUpload(b, policy)
    if (!r) continue
    if (!r.ok) return { ok: false, code: r.code, message: r.originalName ? `Plik ${r.originalName}: ${r.message}` : r.message, originalName: r.originalName }
    files.push(r.file)
  }
  return { ok: true, files }
}
