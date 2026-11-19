// Polecenie KSeF: `npm run ksef -- podglad --dzien RRRR-MM-DD [--firma <slug>]`. Składa szkice faktur FA(3)
// zamówień dnia (Europe/Warsaw) dla firmy bez wFirmy i zapisuje je w `KsefInvoiceDraft` w naszej bazie. Nic nie idzie
// do KSeF. Na ekranie liczby per status, numery zamówień i kody problemów, bez danych klientów. Bez zadania workera.
import 'dotenv/config'
import { createOrgClient, createSystemClient } from '../lib/db'
import { type PodgladKsefDnia, prepareKsefDay, STATUS_KSEF_LABEL, STATUSY_SZKICU } from '../lib/ksef/szkice'
import { listActiveOrganizations } from '../lib/organizacje'
import { addDays, toWarsaw } from '../lib/rdzen/kalendarz'

export function renderKsefPodglad(r: PodgladKsefDnia): string {
  const L: string[] = []
  if (!r.dotyczy) return `[ksef] ${r.dzien}: firma wystawia faktury w wFirmie (settings.faktury.program) — KSeF obsługuje wFirma, nic nie złożono.`
  L.push(`[ksef] szkice faktur ${r.dzien} (podgląd, nic nie zostało wysłane do KSeF): zamówień ${r.zamowienia}, nie dotyczy ${r.nieDotyczy}${r.zablokowane ? `, z numerem (bez zmian) ${r.zablokowane}` : ''}`)
  for (const s of STATUSY_SZKICU) L.push(`  ${STATUS_KSEF_LABEL[s]}: ${r.perStatus[s]}${r.numery[s].length ? ` (${r.numery[s].join(', ')})` : ''}`)
  const kody = Object.entries(r.problemy).sort((a, b) => b[1] - a[1])
  if (kody.length) {
    L.push('  problemy (kod: liczba zamówień):')
    for (const [k, n] of kody) L.push(`    ${k}: ${n}`)
    L.push('  zamówienia z problemami:')
    for (const x of r.listaProblemow) L.push(`    ${x.numerZamowienia}: ${x.kody.join(', ')}`)
  }
  for (const b of r.bledy) L.push(`  BŁĄD ${b}`)
  return L.join('\n')
}

const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<number> {
  const cmd = process.argv[2]
  const dzien = arg('--dzien') ?? addDays(toWarsaw(new Date()).day, -1)
  if (cmd !== 'podglad' || !/^\d{4}-\d{2}-\d{2}$/.test(dzien)) {
    console.error('Użycie: npm run ksef -- podglad --dzien RRRR-MM-DD [--firma <slug>]')
    return 2
  }
  // klient systemowy tylko do wyboru firmy; szkice składa klient firmy (RLS)
  const sys = createSystemClient({ poolMax: 1 })
  let org: { id: string } | undefined
  let aktywnych = 0
  try {
    const orgs = await listActiveOrganizations(sys)
    aktywnych = orgs.length
    const slug = arg('--firma') ?? process.env['SELFHOST_ORG_SLUG']
    org = slug ? orgs.find((o) => o.slug === slug) : orgs.length === 1 ? orgs[0] : undefined
    if (!org) {
      console.error(slug ? `Nie ma aktywnej firmy ${slug}` : `Wskaż firmę (--firma), aktywnych: ${aktywnych}`)
      return 2
    }
  } finally {
    await sys.$disconnect()
  }
  const db = createOrgClient(org.id, { poolMax: 2 })
  try {
    console.log(renderKsefPodglad(await prepareKsefDay(db, { dzien })))
    return 0
  } finally {
    await db.$disconnect()
  }
}

if (process.argv[1] && /scripts[\\/]ksef\.ts$/.test(process.argv[1]))
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300))
      process.exit(1)
    },
  )
