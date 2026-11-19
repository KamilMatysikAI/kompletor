// (wzorzec system-najmu): bramka stała. Każdy plik z formularza w kodzie serwera idzie przez osłonę uploadu
// (`readUpload` / `readUploads` z `lib/files/upload-guard.ts`).
//
// Reguła plikowa (po przeglądzie PR #244, bo reguła po nazwie odbiorcy dawała się ominąć rzutowaniem,
// `new Response(file)`, `file.slice()` albo zmienną nazwaną `response`): plik w `app/` albo `lib/`, który czyta pola
// `FormData` (`.get(` / `.getAll(` przy `FormData` / `formData()`) ORAZ wywołuje `.arrayBuffer()`, `.text()`,
// `.stream()` albo `.bytes()` na czymkolwiek, musi importować `@/lib/files/upload-guard`. Inaczej błąd.
// Wyjątek tylko wpisem w ALLOWED z powodem.
//
// Granice (jak w system-najmu): komponenty klienta (`'use client'`) czytają plik w przeglądarce osoby, która
// go wybrała, i są pominięte; plik importujący osłonę, który mimo to czyta bajty sam, przechodzi (to wyłapuje przegląd).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..')

/** Wyjątki: plik → powód. Nowy wpis = świadoma decyzja z powodem w przeglądzie. */
const ALLOWED: Record<string, string> = {
  'lib/files/upload-guard.ts': 'sama osłona: tu jest jedyne `entry.arrayBuffer()` po sprawdzeniu rozmiaru',
  'lib/zrodla/mirakl.ts': 'klient Mirakl sam buduje FormData z CSV stanów (STO01) i wysyła je do Empiku; nie czyta pliku od użytkownika',
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p)
  }
  return out
}

const USES_FORM = /\bFormData\b|\.formData\s*\(/
const FORM_GET = /\.\s*(get|getAll)\s*\(/
const READS_BYTES = /\.\s*(arrayBuffer|text|stream|bytes)\s*\(/
const IMPORTS_GUARD = /from\s+['"]@\/lib\/files\/upload-guard['"]/

/** Czy źródło łamie regułę (czyta pola formularza i bajty, bez osłony). */
export function violatesUploadRule(src: string): boolean {
  if (/^\s*['"]use client['"]/.test(src)) return false
  if (!USES_FORM.test(src) || !FORM_GET.test(src)) return false
  if (!READS_BYTES.test(src)) return false
  return !IMPORTS_GUARD.test(src)
}

function offenders(): string[] {
  const out: string[] = []
  for (const dir of ['app', 'lib']) {
    for (const file of walk(join(ROOT, dir))) {
      const rel = relative(ROOT, file).split(sep).join('/')
      if (ALLOWED[rel]) continue
      if (violatesUploadRule(readFileSync(file, 'utf8'))) out.push(rel)
    }
  }
  return out
}

const head = "'use server'\nexport async function a(fd: FormData) {\n"

describe('osłona uploadu na każdym punkcie wejścia', () => {
  it('żaden plik w app/ ani lib/ nie czyta pliku z formularza z pominięciem readUpload/readUploads', () => {
    expect(offenders(), 'Czytaj plik przez readUpload/readUploads z lib/files/upload-guard.ts (zasada 17 roli soft, punkt 8 checklisty audytu)').toEqual([])
  })

  it('wyłapuje obejścia z przeglądu', () => {
    const bypasses = [
      `${head}  const b = Buffer.from(await (fd.get('file') as File).arrayBuffer())\n}`,
      `${head}  const response = fd.get('file') as File\n  return response.arrayBuffer()\n}`,
      `${head}  return new Response(fd.get('file') as File).arrayBuffer()\n}`,
      `${head}  const f = fd.get('file') as File\n  return f.slice(0, 10).arrayBuffer()\n}`,
      `export async function POST(req: Request) {\n  const form = await req.formData()\n  return (form.getAll('x')[0] as File).text()\n}`,
    ]
    for (const src of bypasses) expect(violatesUploadRule(src), src).toBe(true)
  })

  it('przepuszcza osłonę, ciało żądania bez formularza i komponent klienta', () => {
    expect(violatesUploadRule(`import { readUpload } from '@/lib/files/upload-guard'\n${head}  return readUpload(fd.get('file'), P)\n}`)).toBe(false)
    expect(violatesUploadRule('export async function POST(req: Request) {\n  return JSON.parse(await req.text())\n}')).toBe(false)
    expect(violatesUploadRule(`'use client'\nexport async function a(fd: FormData) {\n  return (fd.get('f') as File).arrayBuffer()\n}`)).toBe(false)
  })

  it('pliki z wyjątków istnieją (wyjątek nie przeżywa usunięcia pliku)', () => {
    for (const rel of Object.keys(ALLOWED)) expect(statSync(join(ROOT, rel)).isFile()).toBe(true)
  })
})
