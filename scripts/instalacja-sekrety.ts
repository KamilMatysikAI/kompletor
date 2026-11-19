// Sekrety pierwszego uruchomienia: jednorazowa usługa `sekrety` z compose.yaml, w obrazie
// `node dist/instalacja.cjs` (bundel z scripts/build-cli.mjs). Katalog: KOMPLETOR_SEKRETY_DIR (domyślnie /sekrety).
// Idempotentnie: istniejące pliki zostają bez zmian. Do logu idą tylko nazwy plików, nigdy wartości.
//   npx tsx scripts/instalacja-sekrety.ts            — lokalnie, katalog z KOMPLETOR_SEKRETY_DIR
import { readFileSync } from 'node:fs'
import { POSTGRES_UID, przygotujSekrety, uzytkownikZPasswd } from '../lib/instalacja/sekrety'

async function main(): Promise<number> {
  const dir = process.env['KOMPLETOR_SEKRETY_DIR']?.trim() || '/sekrety'
  // Jako root (kontener `sekrety`): właściciele plików dla postgresa (uid 70) i użytkownika `app` z tego obrazu.
  let wlasciciele: Parameters<typeof przygotujSekrety>[1]
  if (process.getuid?.() === 0) {
    const app = uzytkownikZPasswd(readFileSync('/etc/passwd', 'utf8'), 'app')
    if (!app) throw new Error('brak użytkownika app w /etc/passwd (uruchom w obrazie Kompletora)')
    wlasciciele = { app, postgresUid: POSTGRES_UID }
  }
  const r = await przygotujSekrety(dir, wlasciciele)
  if (r.utworzone.length) console.log(`[sekrety] utworzone w ${dir}: ${r.utworzone.join(', ')}`)
  if (r.istniejace.length) console.log(`[sekrety] bez zmian (już są): ${r.istniejace.join(', ')}`)
  return 0
}

main().then(
  (c) => process.exit(c),
  (e: unknown) => {
    console.error('[sekrety] błąd:', e instanceof Error ? e.message : e)
    process.exit(1)
  },
)
