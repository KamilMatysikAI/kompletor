// Zdjęcie zwrotu albo reklamacji (opcjonalne). Tylko przez osłonę uploadu (`readUpload`,
// lib/files/upload-guard.ts): limit rozmiaru przed wczytaniem bajtów, typ po zawartości (JPEG, PNG, webp; SVG, HTML,
// ZIP i reszta = odmowa), wymiary z nagłówka. Potem sharp dekoduje i zapisuje od nowa jako JPEG do 1600 px boku
// (bez metadanych, także bez położenia z aparatu). Bajty w tabeli `ReturnPhoto` (RLS), jedno zdjęcie na zwrot.
import type { PrismaClient } from '@prisma/client'
import sharp from 'sharp'
import { organizationIdOf } from '../db'
import { readUpload, type UploadPolicy } from '../files/upload-guard'

export const ZDJECIE_ZWROTU_POLICY: UploadPolicy = { kinds: ['jpg', 'png', 'webp'], maxBytes: 10 * 1024 * 1024, maxPixels: 40_000_000, maxSide: 12_000 }
const MAKS_BOK = 1600

export class ZdjecieZwrotuError extends Error {}

/** Bajty zdjęcia z pola formularza po osłonie i ponownym zapisie; null = pole puste (zdjęcie jest opcjonalne). */
export async function przygotujZdjecieZwrotu(entry: unknown): Promise<{ content: Buffer; mime: 'image/jpeg' } | null> {
  const r = await readUpload(entry, ZDJECIE_ZWROTU_POLICY, { fallbackName: 'zwrot' })
  if (!r) return null
  if (!r.ok) throw new ZdjecieZwrotuError(r.message)
  try {
    const content = await sharp(r.file.content, { limitInputPixels: ZDJECIE_ZWROTU_POLICY.maxPixels }).rotate().resize({ width: MAKS_BOK, height: MAKS_BOK, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer()
    return { content, mime: 'image/jpeg' }
  } catch {
    throw new ZdjecieZwrotuError('Nie udało się odczytać zdjęcia: wgraj plik JPEG, PNG albo webp.')
  }
}

export async function zapiszZdjecieZwrotu(db: PrismaClient, returnId: string, z: { content: Buffer; mime: string }): Promise<void> {
  organizationIdOf(db)
  const content = new Uint8Array(z.content)
  await db.returnPhoto.upsert({ where: { returnId }, create: { returnId, content, mime: z.mime }, update: { content, mime: z.mime } })
}

export async function zdjecieZwrotu(db: PrismaClient, returnId: string): Promise<{ content: Buffer; mime: string } | null> {
  organizationIdOf(db)
  const z = await db.returnPhoto.findUnique({ where: { returnId }, select: { content: true, mime: true } })
  return z ? { content: Buffer.from(z.content), mime: z.mime } : null
}
