// Firma demonstracyjna do oglądania panelu (dane i zasady w lib/instalacja/demo.ts):
// zmyślone produkty i zamówienia, bez danych klientów. Firma „demo” powstaje tylko, gdy jej jeszcze nie ma, i nie
// dotyka innych firm w bazie; nigdy w trybie hosting.
//   npm run demo:panel -- --tak             — zakłada firmę „Sklep Demo” + konto demo@kompletor.test
// Hasło konta demo jest generowane i wypisywane tylko na terminal. W kontenerze to samo robi KOMPLETOR_SEED=demo.
import 'dotenv/config'
import { createOrgClient, createSystemClient } from '../lib/db'
import { zalozDemo } from '../lib/instalacja/demo'

async function main(): Promise<number> {
  if (!process.argv.includes('--tak')) throw new Error('Demo zakłada firmę i konto właściciela — uruchom z flagą --tak (npm run demo:panel -- --tak)')
  const sys = createSystemClient({ poolMax: 1 })
  try {
    const r = await zalozDemo(sys, (id) => createOrgClient(id, { poolMax: 2 }))
    if (!r.utworzona) console.log('[demo] firma „demo” już jest — bez zmian')
    else process.stdout.write(`\n[demo] firma „Sklep Demo” gotowa. Konto: ${r.email}  Hasło: ${r.haslo}\n\n`)
    return 0
  } finally {
    await sys.$disconnect()
  }
}

main().then(
  (c) => process.exit(c),
  (e: unknown) => {
    console.error('[demo] błąd:', e instanceof Error ? e.message : e)
    process.exit(1)
  },
)
