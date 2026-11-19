// Bundel workera i CLI do obrazu Dockera: CJS, jeden plik na wejście, zewnętrzne @prisma/client i @node-rs/argon2.
//   npm run build:cli   →   dist/worker.cjs, dist/org.cjs, dist/sekret.cjs, dist/import-katalogu.cjs, dist/uzytkownik.cjs,
//                           dist/cien.cjs, dist/instalacja.cjs, dist/kompletor-mcp.cjs
// `import.meta` nie istnieje w CJS. Jedyny dozwolony użytkownik to lib/import/nadpisania.ts (katalog
// dane/nadpisania-ofert względem pliku źródłowego): dostaje adres, jaki miałby w repo (<katalog nad dist>/lib/import/
// nadpisania.ts), więc ścieżka wychodzi ta sama w repo i w obrazie (/app/dane/…). Każde inne `import.meta` = błąd
// budowania, żeby nowy kod nie dostał po cichu pustego obiektu.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'

const ROOT = path.resolve(import.meta.dirname, '..')
const IMPORT_META_ALLOWED = new Set(['lib/import/nadpisania.ts'])

const guard = {
  name: 'import-meta-guard',
  setup(b) {
    b.onLoad({ filter: /\.(ts|tsx|mts)$/ }, async (args) => {
      const rel = path.relative(ROOT, args.path).split(path.sep).join('/')
      const src = await readFile(args.path, 'utf8')
      if (/\bimport\.meta\b/.test(src) && !IMPORT_META_ALLOWED.has(rel) && !rel.startsWith('node_modules/'))
        return { errors: [{ text: `${rel}: import.meta w kodzie bundla CJS (dozwolone tylko w ${[...IMPORT_META_ALLOWED].join(', ')})` }] }
      return undefined
    })
  },
}

const result = await build({
  entryPoints: {
    worker: 'worker/index.ts',
    org: 'scripts/org.ts',
    sekret: 'scripts/sekret.ts',
    'import-katalogu': 'scripts/import-katalogu.ts',
    // konta panelu w obrazie (bez tsx): node dist/uzytkownik.cjs dodaj …
    uzytkownik: 'scripts/uzytkownik.ts',
    // narzędzia cienia w obrazie: node dist/cien.cjs konfiguruj | test | raport …
    cien: 'scripts/cien.ts',
    // podgląd szkiców KSeF w obrazie: node dist/ksef.cjs podglad …
    ksef: 'scripts/ksef.ts',
    // sekrety pierwszego uruchomienia (usługa `sekrety` w compose.yaml): node dist/instalacja.cjs
    instalacja: 'scripts/instalacja-sekrety.ts',
    // pomost stdio → /api/mcp dla agentów AI (self-host): KOMPLETOR_URL i KOMPLETOR_API_KEY tylko z env
    'kompletor-mcp': 'scripts/kompletor-mcp.ts',
    // przeliczenie zaległych zamówień „bez powiązania z produktem”: node dist/przelicz-zamowienia.cjs [--zapisz]
    'przelicz-zamowienia': 'scripts/przelicz-zamowienia.ts',
    // rotacja kluczy danych klienta w obrazie (klon stagingu → produkcja, docs/dane-klienta.md
    // „Klucze i ich zmiana”): node dist/klienci.cjs stan | przeszyfruj [--wszystkie-firmy] [--skroty]
    klienci: 'scripts/klienci.ts',
  },
  absWorkingDir: ROOT,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outdir: 'dist',
  outExtension: { '.js': '.cjs' },
  external: ['@prisma/client', 'pg-native', '@node-rs/argon2', 'xmllint-wasm', 'sharp'], // argon2 = moduł natywny; xmllint-wasm ma własny worker i .wasm: oba w obrazie z .next/standalone; sharp = moduł natywny z .next/standalone (Next śledzi go dla trasy zdjęć)
  define: { 'import.meta.url': '__kompletorNadpisaniaUrl' },
  banner: {
    js: "const __kompletorNadpisaniaUrl = require('node:url').pathToFileURL(require('node:path').join(__dirname, '..', 'lib', 'import', 'nadpisania.ts')).href;",
  },
  plugins: [guard],
  logLevel: 'warning',
  metafile: true,
})

// `define` i banner muszą się zgadzać z kodem. W każdym bundlu nazwa z bannera pada raz w samym
// bannerze, a w bundlach z lib/import/nadpisania.ts dokładnie raz więcej (jedyne `import.meta.url`). Inna liczba
// (np. esbuild zmienił nazwę przy kolizji albo `import.meta.url` pojawił się w drugim miejscu) = build zatrzymany.
const META_NAME = '__kompletorNadpisaniaUrl'
const bad = []
for (const [out, meta] of Object.entries(result.metafile.outputs)) {
  if (!out.endsWith('.cjs')) continue
  const expected = Object.keys(meta.inputs).some((i) => [...IMPORT_META_ALLOWED].includes(i)) ? 2 : 1
  const count = (await readFile(path.join(ROOT, out), 'utf8')).split(META_NAME).length - 1
  if (count !== expected) bad.push(`${out}: ${META_NAME} ${count}× (oczekiwane ${expected}: banner${expected === 2 ? ' + jedno użycie' : ''})`)
}
if (bad.length) {
  console.error(`[build-cli] BŁĄD: niezgodny banner import.meta.url:\n  ${bad.join('\n  ')}`)
  process.exit(1)
}
