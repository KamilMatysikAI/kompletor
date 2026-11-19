// Pomost stdio dla serwera MCP Kompletora: `node dist/kompletor-mcp.cjs` (obraz / self-host) albo
// `npx tsx scripts/kompletor-mcp.ts`. Konfiguracja WYŁĄCZNIE z env: KOMPLETOR_URL (adres instalacji) i KOMPLETOR_API_KEY
// (klucz agenta z Ustawienia → Agenci AI). Argumenty linii komend są odrzucane, żeby klucz nie trafił do listy procesów
// ani historii powłoki. stdout = tylko wiadomości JSON-RPC; komunikaty dla człowieka na stderr, bez klucza.
import { createInterface } from 'node:readline'
import { createBridge, type FetchFn } from '../lib/mcp/pomost'

function fail(msg: string): never {
  process.stderr.write(`[kompletor-mcp] ${msg}\n`)
  process.exit(2)
}

if (process.argv.length > 2) fail('ta komenda nie przyjmuje argumentów; ustaw KOMPLETOR_URL i KOMPLETOR_API_KEY w env (patrz docs/mcp.md)')
const url = process.env.KOMPLETOR_URL ?? ''
const apiKey = process.env.KOMPLETOR_API_KEY ?? ''
if (!url) fail('brak KOMPLETOR_URL (np. https://kompletor.example.invalid)')
if (!/^kmp_[A-Za-z0-9_-]{43}$/.test(apiKey)) fail('brak albo zły KOMPLETOR_API_KEY (klucz agenta kmp_…)')

let bridge: ReturnType<typeof createBridge>
try {
  bridge = createBridge({
    url,
    apiKey,
    fetch: fetch as unknown as FetchFn,
    write: (line) => process.stdout.write(`${line}\n`),
    log: (line) => process.stderr.write(`${line}\n`),
  })
} catch (e) {
  fail((e as Error).message)
}
process.stderr.write(`[kompletor-mcp] serwer: ${bridge.endpoint}\n`)

const pending = new Set<Promise<void>>()
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  const p = bridge.handleLine(line).finally(() => pending.delete(p))
  pending.add(p)
})
rl.on('close', () => {
  void Promise.allSettled([...pending]).then(() => process.exit(0))
})
