// Smoke test workera: dokłada zadanie „ping” i nieznany rodzaj w firmie, czeka na ich obsłużenie przez działający worker.
//   npm run worker   (w drugim oknie)   +   npx tsx scripts/smoke-worker.ts [--firma <slug>]
import 'dotenv/config'
import { createOrgClient, createSystemClient } from '../lib/db'
import { enqueue } from '../lib/worker/kolejka'

async function main(): Promise<number> {
  const i = process.argv.indexOf('--firma')
  const slug = i >= 0 ? process.argv[i + 1] : undefined
  const sys = createSystemClient({ poolMax: 1 })
  const org = await sys.organization.findFirst({ where: slug ? { slug } : { active: true }, orderBy: { id: 'asc' } })
  await sys.$disconnect()
  if (!org) {
    console.error('[smoke] brak firmy — załóż: npm run org:create')
    return 1
  }
  const db = createOrgClient(org.id, { poolMax: 1 })
  try {
    const ok = await enqueue(db, 'ping', null, { maxAttempts: 1 })
    const bad = await enqueue(db, 'nie-ma-takiego', null, { maxAttempts: 1 })
    for (let t = 0; t < 30; t++) {
      await new Promise((r) => setTimeout(r, 1000))
      const jobs = await db.job.findMany({ where: { id: { in: [ok!, bad!] } } })
      const done = jobs.find((j) => j.id === ok)
      const failed = jobs.find((j) => j.id === bad)
      if (done?.status === 'DONE' && failed?.status === 'FAILED') {
        console.log(`[smoke] firma ${org.slug}: ping DONE, nieznany rodzaj FAILED („${failed.lastError}”)`)
        return 0
      }
    }
    console.error('[smoke] worker nie obsłużył zadań w 30 s')
    return 1
  } finally {
    await db.$disconnect()
  }
}

main().then((c) => process.exit(c))
