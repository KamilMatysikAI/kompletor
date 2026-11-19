// Cień zamówień — narzędzia. Wszystko TYLKO DO ODCZYTU ze źródeł; zapis wyłącznie w naszej bazie.
//
//   npm run cien -- konfiguruj [--firma <slug>] [--preset <nazwa> | --plik <ścieżka>]
//                                                             konta firmy z jej presetu (seed/presety/<nazwa>.json,
//                                                             domyślnie nazwa = slug firmy; KOMPLETOR_PRESET_PLIK
//                                                             nadpisuje ścieżkę): adapter zawsze, ustawienia tylko w puste klucze
//   npm run cien -- test [--klucze-z <mapa.json>]             test połączenia kont (bez sekretów); Woo: zapisuje
//                                                             odczytane hold_stock_minutes w ustawieniach konta
//   npm run cien -- worker [--minut 30] [--klucze-z <mapa>]   worker z harmonogramem (cień + rdzeń)
//   npm run cien -- raport --od <ISO> [--do <ISO>] [--porownaj] [--okno-godzin 24] [--plik <md>] [--klucze-z <mapa>]
//                                                             liczby: zamówienia per kanał, opóźnienie p95, rozjazdy z BL
//   npm run cien -- sprzedaz-dnia [--dzien dzis|RRRR-MM-DD]   sprzedaż dnia Kompletor kontra BL per konto (
//                                                             domyślnie dziś, bez ostatnich 20 min); rozjazd = alert
//   npm run cien -- rozjazdy [--dzien RRRR-MM-DD] [--plik <md>]  dzienny raport rozjazdów z bazy (domyślnie wczoraj)
//   npm run cien -- faktury-podglad [--dzien RRRR-MM-DD]      faktury, które wystawiłby system, kontra BL (
//                                                             domyślnie wczoraj); nic nie wystawia, bez odczytów BL i wFirmy
//   npm run cien -- faktura-robocza --zamowienie <id> [--wykonaj [--takze-z-nip]] | --usun <docId> | --sprawdz <docId>
//                                                             faktura robocza VAT w wFirmie (bez numeru, bez KSeF) z treścią
//                                                             złożoną jak prawdziwa faktura; bez --wykonaj na sucho (same pola
//                                                             kontrolne, bez danych nabywcy); bez zmian w zamówieniu i stanach;
//                                                             ślad odczytu danych klienta, bez rekordu klienta możliwy jego zapis
//                                                             (scripts/faktura-robocza.ts, docs/dokumenty-sprzedazy.md)
//   npm run cien -- punkt-ciecia [--kanal EMPIK] [--konto <id>] [--zapisz] [--maks-wiek-minuty N] [--plik <md>]
//                                                             przed włączeniem trybu pracy: zamówienia kont w podglądzie
//                                                             obsłużone już w BaseLinkerze (wg kopii cienia); bez --zapisz
//                                                             tylko lista, z --zapisz zamyka je bez maila, zapisu do kanałów,
//                                                             faktury i ruchu stanu
//   npm run cien -- allegro-autoryzuj [--konto <id>] [--z-przesylkami]  device flow Allegro: link dla
//                                                             właściciela konta, zapis własnej pary tokenów w sekretach
//                                                             konta; --z-przesylkami dokłada odczyt przesyłek
//                                                             --z-ofertami odczyt ofert /sale/offers
//   npm run cien -- allegro-wysylam-test [--konto <id>]       test zakresu przesyłek Wysyłam z Allegro, bez tokenów
//   npm run cien -- rabat-woo [--od RRRR-MM-DD] [--do RRRR-MM-DD] [--konto <id>] [--limit-na-minute N] [--limit-czasu-s N] [--wykonaj]
//                                                             ceny pozycji zamówień Woo z rabatem
//                                                             z ujemnych opłat (sklep tylko czytany); bez --wykonaj na sucho
//   npm run cien -- nieudane-platnosci-woo [--konto <id>] [--takze-w-pracy] [--maks-wiek-minuty N] [--wykonaj]
//                                                             zamówienia Woo z nieudaną płatnością (`failed`) zapisane dawniej
//                                                             jako anulowane: w terminie płatności wracają do „Nowe,
//                                                             nieopłacone” (z rezerwacją albo, gdy krótki termin nieudanej
//                                                             płatności online minął, bez niej), po terminie „Anulowane, nieopłacone”
//                                                             bez ruchu stanów; otwarte zamówienia Woo z kopią `failed`
//                                                             bez znacznika dostają znacznik nieudanej płatności online,
//                                                             krótki termin od złożenia (minął = zwolnienie towaru od razu)
//                                                             i pytanie o płatność; tylko dane z bazy, bez --wykonaj na sucho;
//                                                             konta w trybie pracy pomijane bez --takze-w-pracy
//   npm run cien -- przywroc-rezerwacje [--firma <slug>] [--wykonaj]
//                                                             przed powrotem do starszej wersji: zamówienia ze zwolnionym
//                                                             towarem po nieudanej płatności online dostają rezerwację od
//                                                             nowa (braki na listę braków), terminy zwolnienia schodzą;
//                                                             bez --wykonaj na sucho (docs/rezerwacje.md)
//
// --klucze-z <mapa.json> (albo env KLUCZE_LOKALNE): self-host na własnym komputerze — brakujące klucze z plików .env
// innych projektów wg mapy trzymanej POZA repo (scripts/klucze-lokalne.ts), bez kopiowania i bez wypisywania wartości.
//
// W obrazie Dockera bez tsx: `node dist/cien.cjs konfiguruj --firma <slug>`, `node dist/cien.cjs test`,
// `node dist/cien.cjs raport …` (bundel z scripts/build-cli.mjs). Ustawienia kont uzupełnia też seed przy starcie
// kontenera (KOMPLETOR_SEED=<nazwa presetu>), więc `konfiguruj` to tylko polecenie naprawcze.
//
// CIEN_ODCZYT=0 wyłącza cień w workerze (także `cien -- worker`), ale NIE `test` ani `raport --porownaj`:
// te czytają konta i BL zawsze — to świadome polecenie operatora uruchamiane ręcznie.
import 'dotenv/config'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Channel, type Prisma, type PrismaClient } from '@prisma/client'
import { createOrgClient, createSystemClient } from '../lib/db'
import { defaultRegistry } from '../lib/adaptery/domyslne'
import { createAccountAdapter, loadChannelAccounts } from '../lib/adaptery/konta'
import { type ComparisonRun, runBlComparison } from '../lib/cien/bl-porownanie'
import { accountsForComparison } from '../lib/cien/harmonogram'
import { type AccountMetrics, shadowMetrics } from '../lib/cien/metryki'
import { buildDailyReport, renderDailyReport, saveDailyReport } from '../lib/cien/raport-dzienny'
import { runDaySalesCheck, salesCountBreakdown } from '../lib/cien/sprzedaz-dnia'
import { addDays, toWarsaw } from '../lib/rdzen/kalendarz'
import { channelMapOf, envSecretsAllowed, fillMissingSettings, listActiveOrganizations, loadImportConfig } from '../lib/organizacje'
import { resolveSecrets } from '../lib/sekrety'
import { BaseLinkerReadOnly } from '../lib/zrodla/baselinker'
import { sciezkaPresetu, wczytajPreset } from '../lib/preset-plik'
import { fakturyPodglad } from './faktury-podglad'
import { fakturaRoboczaCli } from './faktura-robocza'
import { rabatWooCli } from './rabat-woo'
import { opisPunktuCiecia, punktCiecia } from '../lib/kanaly/punkt-ciecia'
import { opisNieudanychPlatnosciWoo, przeliczNieudanePlatnosciWoo } from '../lib/kanaly/nieudane-platnosci-woo'
import { przywrocRezerwacjeZwolnionych } from '../lib/rdzen/powrot-rezerwacji'
import { authorizeAllegro } from './allegro-autoryzacja'
import { allegroWysylamTest } from './allegro-wysylam'
import { envWithLocalKeys } from './klucze-lokalne'

type Env = Record<string, string | undefined>

const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes(name)

async function pickOrg(env: Env): Promise<{ id: string; slug: string; envFallback: boolean }> {
  const sys = createSystemClient({ poolMax: 1 })
  try {
    const orgs = await listActiveOrganizations(sys)
    const slug = arg('--firma') ?? env['SELFHOST_ORG_SLUG']
    const org = slug ? orgs.find((o) => o.slug === slug) : orgs.length === 1 ? orgs[0] : undefined
    if (!org) throw new Error(slug ? `Nie ma aktywnej firmy ${slug}` : `Wskaż firmę (--firma), aktywnych: ${orgs.length}`)
    return { id: org.id, slug: org.slug, envFallback: envSecretsAllowed(env, org, orgs.length) }
  } finally {
    await sys.$disconnect()
  }
}

async function konfiguruj(db: PrismaClient, orgSlug: string): Promise<void> {
  // adapter i ustawienia kont z tego samego presetu co seed (plik JSON, nie kod)
  const sciezka = arg('--plik') ?? sciezkaPresetu(arg('--preset') ?? orgSlug)
  const preset = await wczytajPreset(sciezka)
  console.log(`[cien] preset: ${sciezka}`)
  const accounts = await loadChannelAccounts(db, { activeOnly: false })
  for (const c of preset.channels ?? []) {
    if (!c.adapterKey) continue
    const config = c.config && typeof c.config === 'object' && !Array.isArray(c.config) ? (c.config as Record<string, unknown>) : {}
    const acc = accounts.find((a) => a.channel === c.channel && a.channelAccountId === c.channelAccountId)
    if (!acc) {
      console.log(`[cien] ${c.channel}/${c.channelAccountId}: brak konta w firmie — pominięte`)
      continue
    }
    // ustawienia (`config`) tylko w puste klucze, jak seed przy starcie — wartości zmienione ręcznie zostają.
    // Adapter (`adapterKey`) to polecenie naprawcze ustawia zawsze na ten z presetu (zachowanie;
    // seed przy starcie adaptera istniejącego konta nie zmienia)..
    const filled = fillMissingSettings(acc.config, config)
    const r = await db.channelConfig.updateMany({
      where: { channel: c.channel, channelAccountId: c.channelAccountId },
      data: { adapterKey: c.adapterKey, ...(filled ? { config: filled as Prisma.InputJsonValue } : {}) },
    })
    console.log(`[cien] ${acc.name}: adapter ${c.adapterKey}${filled ? ', uzupełnione puste ustawienia' : ', ustawienia bez zmian (już były)'} (${r.count})`)
  }
}

async function test(db: PrismaClient, env: Env, envFallback: boolean): Promise<void> {
  const registry = defaultRegistry()
  for (const acc of await loadChannelAccounts(db)) {
    const label = `${acc.name} (${acc.channel}/${acc.channelAccountId}, ${acc.adapterKey})`
    try {
      const a = await createAccountAdapter(db, registry, acc, { env, envFallback })
      const t = await a.testConnection()
      console.log(`[test] ${label}: ${t.ok ? 'OK' : 'BŁĄD'} — ${t.message}${t.details ? ' ' + JSON.stringify(t.details) : ''}`)
      // spec 3.1: hold_stock_minutes sklepu zapisany w ustawieniach konta (nasza baza; w sklepie nic się nie zmienia)
      const hold = t.ok ? t.details?.['holdStockMinutes'] : undefined
      if (typeof hold === 'number' && a.manifest.config.some((f) => f.key === 'holdStockMinutes') && acc.config['holdStockMinutes'] !== hold) {
        await db.channelConfig.updateMany({
          where: { channel: acc.channel, channelAccountId: acc.channelAccountId },
          data: { config: { ...acc.config, holdStockMinutes: hold } as Prisma.InputJsonValue },
        })
        console.log(`[test] ${label}: zapisane holdStockMinutes = ${hold}`)
      }
    } catch (e) {
      console.log(`[test] ${label}: nie da się utworzyć adaptera — ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

const sec = (ms: number | null) => (ms === null ? '—' : (ms / 1000).toFixed(1).replace('.', ',') + ' s')

function renderReport(from: Date, to: Date, m: AccountMetrics[], names: Map<string, string>, cmp: ComparisonRun | null): string {
  const L: string[] = []
  L.push(`# Cień zamówień: pierwszy przebieg na żywo`)
  L.push('')
  L.push(`Okno pomiaru: ${from.toISOString()} – ${to.toISOString()} (${Math.round((to.getTime() - from.getTime()) / 60_000)} min). Tylko odczyt kanałów i BL; liczby, bez danych klientów i numerów zamówień.`)
  L.push('')
  L.push('## Zamówienia per kanał i opóźnienie')
  L.push('')
  L.push('| Konto | Adapter | Odczyty OK / nieudane | Odstęp odczytów p95 / maks. | Zamówienia w kopii | Do rdzenia | Pominięte | Z błędem | Złożone w oknie | Opóźnienie p50 / p95 / maks. | Zmiana w kanale → u nas p50 / p95 (zmian) |')
  L.push('|---|---|---|---|---|---|---|---|---|---|---|')
  for (const x of m) {
    const skipped = Object.values(x.skipped).reduce((s, n) => s + n, 0)
    L.push(
      `| ${names.get(`${x.channel}|${x.channelAccountId}`) ?? x.channelAccountId} | ${x.adapterKey} | ${x.polls.ok} / ${x.polls.failed} | ${sec(x.polls.gapP95Ms)} / ${sec(x.polls.gapMaxMs)} | ${x.snapshots} | ${x.ingested} | ${skipped} | ${x.withError} | ${x.liveOrders} | ${sec(x.latencyMs.p50)} / ${sec(x.latencyMs.p95)} / ${sec(x.latencyMs.max)} | ${sec(x.changeLatencyMs.p50)} / ${sec(x.changeLatencyMs.p95)} (${x.changeLatencyMs.n}) |`,
    )
  }
  const skippedAll: Record<string, number> = {}
  for (const x of m) for (const [k, v] of Object.entries(x.skipped)) skippedAll[k] = (skippedAll[k] ?? 0) + v
  if (Object.keys(skippedAll).length) L.push('', `Pominięte (bez rezerwacji): ${Object.entries(skippedAll).map(([k, v]) => `${k} ${v}`).join(', ')}.`)
  const errs = m.filter((x) => x.lastError)
  if (errs.length) L.push('', `Ostatni błąd odczytu: ${errs.map((x) => `${names.get(`${x.channel}|${x.channelAccountId}`) ?? x.channelAccountId}: ${x.lastError}`).join('; ')}.`)
  if (cmp) {
    L.push('', '## Porównanie z BL', '')
    L.push(`Okno porównania: zamówienia złożone od ${cmp.windowFrom.toISOString()} do ${new Date(cmp.now.getTime() - 20 * 60_000).toISOString()} (20 min karencji na import do BL). Pobranie BL ${cmp.blComplete ? 'pełne' : 'NIEPEŁNE'}${cmp.blErrors.length ? ` (${cmp.blErrors.length} błędów)` : ''}.`)
    L.push('')
    L.push('| Konto | W kanale | W BL | Pary | Brak w BL | Brak u nas | Zgodne | BL dalej (pakuje BL) | Lepiej niż BL | Przewoźnik | U nas „do wyjaśnienia” | Rozjazd | Status BL nieznany | Rezerwacje na zamówieniach, które BL już pakuje/wysłał (szt.) |')
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    for (const a of cmp.accounts.filter((x) => x.polled)) {
      const v = a.verdicts
      L.push(`| ${a.name} | ${a.inChannel} | ${a.inBl} | ${a.paired} | ${a.missingInBl} | ${a.missingHere} | ${v.ZGODNE} | ${v.BL_DALEJ} | ${v.LEPIEJ_NIZ_BL} | ${v.PRZEWOZNIK} | ${v.U_NAS_DO_WYJASNIENIA} | ${v.ROZJAZD} | ${v.BL_NIEZNANY} | ${a.activeReservationsBlAhead} |`)
    }
    for (const a of cmp.accounts.filter((x) => x.polled)) {
      const parts: string[] = []
      if (Object.keys(a.missingInBlByStatus).length) parts.push(`brak w BL wg statusu kanału: ${Object.entries(a.missingInBlByStatus).map(([k, n]) => `${k} ${n}`).join(', ')}`)
      if (Object.keys(a.missingHereByBlStatus).length) parts.push(`brak u nas wg statusu BL: ${Object.entries(a.missingHereByBlStatus).map(([k, n]) => `${k.trim()} ${n}`).join(', ')}`)
      if (Object.keys(a.divergences).length) parts.push(`różnice (nasz → BL): ${Object.entries(a.divergences).map(([k, n]) => `${k.trim()} ${n}`).join(', ')}`)
      if (parts.length) L.push('', `- **${a.name}**: ${parts.join('; ')}.`)
    }
    if (Object.keys(cmp.unpolled).length) L.push('', `Źródła BL bez naszego adaptera w tym etapie (nie liczone jako rozjazd): ${Object.entries(cmp.unpolled).map(([k, n]) => `${k} ${n}`).join(', ')}.`)
  }
  L.push('')
  return L.join('\n')
}

async function raport(db: PrismaClient, env: Env, envFallback: boolean): Promise<void> {
  const from = arg('--od') ? new Date(arg('--od')!) : new Date(Date.now() - 30 * 60_000)
  const to = arg('--do') ? new Date(arg('--do')!) : new Date()
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new Error('Zła data --od/--do (ISO)')
  const metrics = await shadowMetrics(db, { since: from, until: to })
  const names = new Map((await loadChannelAccounts(db, { activeOnly: false })).map((a) => [`${a.channel}|${a.channelAccountId}`, a.name]))
  let cmp: ComparisonRun | null = null
  if (flag('--porownaj')) {
    const s = await resolveSecrets(db, ['BASELINKER_TOKEN'], { env, envFallback })
    if (!s['BASELINKER_TOKEN']) throw new Error('Brak BASELINKER_TOKEN')
    const windowH = Number(arg('--okno-godzin') ?? 24)
    cmp = await runBlComparison(db, new BaseLinkerReadOnly(s['BASELINKER_TOKEN']), channelMapOf(await loadImportConfig(db)), await accountsForComparison(db), { now: to, windowMs: windowH * 3600_000 })
  }
  const md = renderReport(from, to, metrics, names, cmp)
  const out = arg('--plik')
  if (out) {
    await mkdir(path.dirname(out), { recursive: true })
    await writeFile(out, md, 'utf8')
    console.log(`[cien] raport: ${out}`)
  } else console.log(md)
}

function dayArg(fallback: string): string {
  const d = arg('--dzien') ?? fallback
  const day = d === 'dzis' ? toWarsaw(new Date()).day : d
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Zły --dzien (dzis albo RRRR-MM-DD)')
  return day
}

async function sprzedazDnia(db: PrismaClient, env: Env, envFallback: boolean): Promise<void> {
  const s = await resolveSecrets(db, ['BASELINKER_TOKEN'], { env, envFallback })
  if (!s['BASELINKER_TOKEN']) throw new Error('Brak BASELINKER_TOKEN')
  const day = dayArg('dzis')
  const r = await runDaySalesCheck(db, new BaseLinkerReadOnly(s['BASELINKER_TOKEN']), channelMapOf(await loadImportConfig(db)), await accountsForComparison(db), { day })
  const zl = (c: number) => (c / 100).toFixed(2).replace('.', ',')
  console.log(`[cien] sprzedaż ${day}${r.final ? '' : ` (do ${r.to.toISOString()}, dzień otwarty)`}: ${r.ok ? 'zgodna z BL' : 'ROZJAZD'}${r.blComplete ? '' : ' — pobranie BL niepełne'}`)
  for (const a of r.accounts)
    console.log(`  ${a.name}: Kompletor ${salesCountBreakdown(a, 'ours')} / ${zl(a.ours.cents)} zł, BL ${salesCountBreakdown(a, 'bl')} / ${zl(a.bl.cents)} zł${a.ok ? '' : ` — tylko u nas: ${a.onlyHere.join(', ') || '—'}; tylko w BL: ${a.onlyBl.join(', ') || '—'}; inna kwota: ${a.amountDiffs.map((d) => d.ref).join(', ') || '—'}`}`)
}

async function rozjazdy(db: PrismaClient): Promise<void> {
  const day = dayArg(addDays(toWarsaw(new Date()).day, -1))
  const r = await buildDailyReport(db, day)
  await saveDailyReport(db, r)
  const md = renderDailyReport(r)
  const out = arg('--plik')
  if (out) {
    await mkdir(path.dirname(out), { recursive: true })
    await writeFile(out, md, 'utf8')
    console.log(`[cien] raport rozjazdów: ${out}`)
  } else console.log(md)
}

/**
 * Punkt cięcia przed włączeniem trybu pracy kont (lib/kanaly/punkt-ciecia.ts): bez --zapisz tylko lista i liczby, z --zapisz
 * zamyka zamówienia obsłużone w BaseLinkerze. Bez odczytów BL (dane z kopii cienia) i bez zapisu poza bazą Kompletora.
 * Kod 1 = błędy przy zamykaniu (reszta zamknięta); kod 2 = odmowa, kopia z BL starsza niż --maks-wiek-minuty (domyślnie 15).
 */
/** Jednorazowe przeliczenie zamówień Woo z nieudaną płatnością: zapisane jako anulowane i otwarte bez znacznika (lib/kanaly/nieudane-platnosci-woo.ts). */
async function nieudanePlatnosciWooCli(db: PrismaClient): Promise<number> {
  const konto = arg('--konto')
  if (konto !== undefined && !/^[!-~]{1,100}$/.test(konto)) throw new Error('zły identyfikator konta')
  const wiek = arg('--maks-wiek-minuty')
  const minuty = wiek === undefined ? undefined : Number(wiek)
  if (minuty !== undefined && !(Number.isInteger(minuty) && minuty >= 1 && minuty <= 24 * 60)) throw new Error('--maks-wiek-minuty: liczba całkowita 1–1440')
  const now = new Date()
  const w = await przeliczNieudanePlatnosciWoo(db, { now, naSucho: !flag('--wykonaj'), takzeWPracy: flag('--takze-w-pracy'), ...(konto ? { channelAccountId: konto } : {}), ...(minuty ? { maksWiekMs: minuty * 60_000 } : {}) })
  console.log(opisNieudanychPlatnosciWoo(w, now))
  if (w.odmowa) return 2
  return w.bledy.length ? 1 : 0
}

/** Powrót rezerwacji zwolnionych po nieudanej płatności online (lib/rdzen/powrot-rezerwacji.ts). Kod 1 = błędy (reszta zrobiona). */
async function przywrocRezerwacjeCli(db: PrismaClient, firma: string): Promise<number> {
  const w = await przywrocRezerwacjeZwolnionych(db, { naSucho: !flag('--wykonaj'), actorId: 'cli:przywroc-rezerwacje' })
  const lista = (x: string[]) => (x.length ? x.join(', ') : '—')
  console.log(`[przywroc-rezerwacje] firma ${firma}: ${w.naSucho ? 'NA SUCHO (nic nie zapisano; zapis: --wykonaj)' : 'WYKONANIE'}`)
  console.log(`  zamówień ze zwolnionym towarem albo terminem zwolnienia: ${w.kandydaci}`)
  console.log(`  ${w.naSucho ? 'dostałyby' : 'dostały'} rezerwację od nowa (${w.przywrocone.length}): ${lista(w.przywrocone)}`)
  if (!w.naSucho) console.log(`  zarezerwowane sztuki: ${w.zarezerwowane}, na liście braków: ${w.braki}`)
  console.log(`  już poza Nowymi, tylko znaczniki zwolnienia ${w.naSucho ? 'zeszłyby' : 'zeszły'} (${w.znacznikiZdjete.length}): ${lista(w.znacznikiZdjete)}`)
  console.log(`  towar jeszcze trzymany, termin zwolnienia ${w.naSucho ? 'zszedłby' : 'zszedł'} (${w.terminZdjety.length}): ${lista(w.terminZdjety)}`)
  for (const b of w.bledy) console.log(`  błąd ${b.numer}: ${b.blad}`)
  return w.bledy.length ? 1 : 0
}

async function punktCieciaCli(db: PrismaClient): Promise<number> {
  const kanal = arg('--kanal')?.toUpperCase()
  if (kanal && !(Object.values(Channel) as string[]).includes(kanal)) throw new Error(`nieznany kanał ${kanal}`)
  const konto = arg('--konto')
  if (konto !== undefined && !/^[!-~]{1,100}$/.test(konto)) throw new Error('zły identyfikator konta')
  const wiek = arg('--maks-wiek-minuty')
  const minuty = wiek === undefined ? undefined : Number(wiek)
  if (minuty !== undefined && !(Number.isInteger(minuty) && minuty >= 1 && minuty <= 24 * 60)) throw new Error('--maks-wiek-minuty: liczba całkowita 1–1440')
  const w = await punktCiecia(db, { naSucho: !flag('--zapisz'), ...(kanal ? { channel: kanal as Channel } : {}), ...(konto ? { channelAccountId: konto } : {}), ...(minuty ? { maksWiekMs: minuty * 60_000 } : {}), actorId: 'cli:punkt-ciecia' })
  const md = opisPunktuCiecia(w)
  const out = arg('--plik')
  if (out) {
    await mkdir(path.dirname(out), { recursive: true })
    await writeFile(out, md, 'utf8')
    console.log(`[cien] punkt cięcia: ${out}`)
  } else console.log(md)
  if (w.odmowa) {
    console.error(`[cien] punkt cięcia: ${w.odmowa}`)
    return 2
  }
  return w.bledy.length ? 1 : 0
}

async function main(): Promise<number> {
  const cmd = process.argv[2]
  const env = envWithLocalKeys(process.env as Env, arg('--klucze-z') ?? process.env['KLUCZE_LOKALNE'])
  if (cmd === 'worker') {
    for (const [k, v] of Object.entries(env)) if (v !== undefined && process.env[k] === undefined) process.env[k] = v
    await import('../worker/index')
    // --minut N: łagodne zatrzymanie po N minutach (to samo co Ctrl+C: worker kończy bieżące zadanie i wychodzi;
    // na Windows `timeout -s INT` nie dochodzi do node uruchomionego przez npx)
    const minutes = Number(arg('--minut'))
    if (Number.isFinite(minutes) && minutes > 0) setTimeout(() => process.emit('SIGINT'), minutes * 60_000).unref()
    return -1 // worker sam kończy proces
  }
  const org = await pickOrg(env)
  const db = createOrgClient(org.id, { poolMax: 2 })
  try {
    if (cmd === 'konfiguruj') await konfiguruj(db, org.slug)
    else if (cmd === 'test') await test(db, env, org.envFallback)
    else if (cmd === 'raport') await raport(db, env, org.envFallback)
    else if (cmd === 'sprzedaz-dnia') await sprzedazDnia(db, env, org.envFallback)
    else if (cmd === 'rozjazdy') await rozjazdy(db)
    else if (cmd === 'punkt-ciecia') return await punktCieciaCli(db)
    else if (cmd === 'nieudane-platnosci-woo') return await nieudanePlatnosciWooCli(db)
    else if (cmd === 'przywroc-rezerwacje') return await przywrocRezerwacjeCli(db, org.slug)
    else if (cmd === 'faktury-podglad') await fakturyPodglad(db, dayArg(addDays(toWarsaw(new Date()).day, -1)))
    else if (cmd === 'faktura-robocza') return await fakturaRoboczaCli(db, { zamowienie: arg('--zamowienie'), wykonaj: flag('--wykonaj'), usun: arg('--usun'), sprawdz: arg('--sprawdz'), takzeZNip: flag('--takze-z-nip'), registry: defaultRegistry(), src: { env, envFallback: org.envFallback } })
    else if (cmd === 'rabat-woo') return await rabatWooCli(db, { od: arg('--od'), do: arg('--do'), konto: arg('--konto'), wykonaj: flag('--wykonaj'), limitNaMinute: arg('--limit-na-minute'), limitCzasuS: arg('--limit-czasu-s'), registry: defaultRegistry(), src: { env, envFallback: org.envFallback } })
    else if (cmd === 'allegro-autoryzuj') return await authorizeAllegro(db, { channelAccountId: arg('--konto'), registry: defaultRegistry(), src: { env, envFallback: org.envFallback }, zPrzesylkami: flag('--z-przesylkami'), zOfertami: flag('--z-ofertami') })
    else if (cmd === 'allegro-wysylam-test') return await allegroWysylamTest(db, { channelAccountId: arg('--konto'), registry: defaultRegistry(), src: { env, envFallback: org.envFallback } })
    else {
      console.error('Użycie: tsx scripts/cien.ts konfiguruj [--preset <nazwa> | --plik <ścieżka>] | test | worker [--minut N] | raport --od <ISO> [--do <ISO>] [--porownaj] [--okno-godzin N] [--plik <md>] | sprzedaz-dnia [--dzien dzis|RRRR-MM-DD] | rozjazdy [--dzien RRRR-MM-DD] [--plik <md>] | faktury-podglad [--dzien RRRR-MM-DD] [--firma <slug>] | faktura-robocza --zamowienie <id> [--wykonaj [--takze-z-nip]] | faktura-robocza --usun <docId> | faktura-robocza --sprawdz <docId> | punkt-ciecia [--kanal K] [--konto <id>] [--zapisz] [--maks-wiek-minuty N] [--plik <md>] | nieudane-platnosci-woo [--konto <id>] [--takze-w-pracy] [--maks-wiek-minuty N] [--wykonaj] | przywroc-rezerwacje [--firma <slug>] [--wykonaj] | allegro-autoryzuj [--konto <id>] [--z-przesylkami] [--z-ofertami] | allegro-wysylam-test [--konto <id>] | rabat-woo [--od RRRR-MM-DD] [--do RRRR-MM-DD] [--konto <id>] [--limit-na-minute N] [--limit-czasu-s N] [--wykonaj]  (klucze: --klucze-z <mapa.json>)')
      return 2
    }
    return 0
  } finally {
    await db.$disconnect()
  }
}

main().then(
  (c) => {
    if (c >= 0) process.exit(c)
  },
  (e: unknown) => {
    console.error('[cien] błąd:', e instanceof Error ? e.message : e)
    process.exit(1)
  },
)
