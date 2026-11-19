// Sekrety integracji firmy, szyfrowane kluczem głównym (APP_ENCRYPTION_KEYS albo APP_ENCRYPTION_KEY).
// Wartość nigdy nie jest wypisywana i nie idzie w argumentach wiersza poleceń (historia powłoki): czytana ze zmiennej
// środowiska albo ze stdin.
//   npm run sekret -- --firma moja-firma --ustaw BASELINKER_TOKEN --z-env BASELINKER_TOKEN
//   npm run sekret -- --firma moja-firma --ustaw WFIRMA_APP_KEY --ze-stdin  < plik
//   npm run sekret -- --firma moja-firma --lista
//   npm run sekret -- --firma moja-firma --usun EMPIK_MIRAKL_API_KEY
//   … --konto WOO/sklep1     — sekret konta kanału (np. klucz WC jednego z dwóch sklepów Woo), zamiast całej firmy
//   npm run sekret -- --firma moja-firma --przeszyfruj          — rotacja klucza: starsze wpisy najnowszym kluczem
//   npm run sekret -- --wszystkie-firmy --przeszyfruj     — to samo po kolei dla każdej firmy (jej klientem, pod RLS)
import 'dotenv/config'
import type { Channel } from '@prisma/client'
import { DEFAULT_CHANNEL_ADAPTER } from '../lib/adaptery'
import { createOrgClient, createSystemClient } from '../lib/db'
import { deleteSecret, listSecrets, reencryptSecrets, type SecretScope, setSecret } from '../lib/sekrety'

const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
}

function scopeArg(): SecretScope {
  const k = arg('--konto')
  if (!k) return null
  const [channel, channelAccountId] = k.split('/')
  if (!channel || !channelAccountId) throw new Error('--konto w formacie KANAŁ/konto, np. WOO/sklep1')
  if (!(channel in DEFAULT_CHANNEL_ADAPTER)) throw new Error(`Nieznany kanał „${channel}” (dozwolone: ${Object.keys(DEFAULT_CHANNEL_ADAPTER).join(', ')})`)
  return { channel: channel as Channel, channelAccountId }
}

/** Przeszyfrowanie wybranych firm po kolei, każda swoim klientem; kod 0 tylko gdy nigdzie nie zostały starsze wpisy. */
async function reencrypt(orgs: { id: string; slug: string }[], all: boolean): Promise<number> {
  let left = 0
  let failed = 0
  for (const org of orgs) {
    const db = createOrgClient(org.id, { poolMax: 1 })
    try {
      const r = await reencryptSecrets(db, process.env)
      left += r.remaining
      console.log(`[sekret] ${org.slug}: przeszyfrowane ${r.reencrypted} kluczem v${r.keyVersion}, pominięte (zmienione w trakcie) ${r.skipped}, starszym kluczem zostało ${r.remaining}`)
    } catch (e) {
      failed++
      console.error(`[sekret] ${org.slug}: błąd, nic nie zapisane:`, e instanceof Error ? e.message : e)
    } finally {
      await db.$disconnect()
    }
  }
  if (failed || left) {
    console.error(`[sekret] NIE usuwaj starego klucza z env: firmy z błędem ${failed}, wpisy starszym kluczem ${left} (uruchom ponownie)`)
    return 1
  }
  if (all) console.log(`[sekret] firmy: ${orgs.length}; wszystkie sekrety zapisane najnowszym kluczem — stare wersje można usunąć z env`)
  else console.log('[sekret] sekrety tej firmy zapisane najnowszym kluczem; przed usunięciem starego klucza z env: --wszystkie-firmy --przeszyfruj')
  return 0
}

async function main(): Promise<number> {
  const all = process.argv.includes('--wszystkie-firmy')
  const slug = arg('--firma')
  if (!slug === !all) throw new Error('Podaj --firma <slug> albo --wszystkie-firmy (tylko z --przeszyfruj)')
  if (all && !process.argv.includes('--przeszyfruj')) throw new Error('--wszystkie-firmy działa tylko z --przeszyfruj')
  if (process.argv.includes('--przeszyfruj') && ['--ustaw', '--usun', '--lista'].some((a) => process.argv.includes(a)))
    throw new Error('--przeszyfruj osobno, bez --ustaw / --usun / --lista')
  const sys = createSystemClient({ poolMax: 1 })
  const orgs = await (all ? sys.organization.findMany({ orderBy: { slug: 'asc' } }) : sys.organization.findMany({ where: { slug } })).finally(() => sys.$disconnect())
  if (!all && !orgs.length) throw new Error(`Nie ma firmy ${slug}`)
  if (process.argv.includes('--przeszyfruj')) return reencrypt(orgs, all)
  const org = orgs[0]!
  const db = createOrgClient(org.id, { poolMax: 1 })
  try {
    if (process.argv.includes('--lista')) {
      for (const s of await listSecrets(db))
        console.log(`${s.channel ? `${s.channel}/${s.channelAccountId}` : '(firma)'}\t${s.name}\tklucz v${s.keyVersion}\t${s.updatedAt.toISOString()}`)
      return 0
    }
    const del = arg('--usun')
    if (del) {
      console.log(`[sekret] ${del}: ${(await deleteSecret(db, del, scopeArg())) ? 'usunięty' : 'nie było'}`)
      return 0
    }
    const name = arg('--ustaw')
    if (!name) throw new Error('Podaj --ustaw <NAZWA> (albo --lista / --usun / --przeszyfruj)')
    const fromEnv = arg('--z-env')
    const value = fromEnv ? process.env[fromEnv] : process.argv.includes('--ze-stdin') ? await readStdin() : undefined
    if (!value) throw new Error(fromEnv ? `Zmienna ${fromEnv} jest pusta` : 'Podaj źródło wartości: --z-env <ZMIENNA> albo --ze-stdin')
    await setSecret(db, name, value, process.env, scopeArg())
    console.log(`[sekret] ${slug}/${name}: zapisany (zaszyfrowany)`)
    return 0
  } finally {
    await db.$disconnect()
  }
}

main().then(
  (c) => process.exit(c),
  (e: unknown) => {
    console.error('[sekret] błąd:', e instanceof Error ? e.message : e)
    process.exit(1)
  },
)
