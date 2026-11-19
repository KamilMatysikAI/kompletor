// Przeprowadzka z BaseLinkera: sprzedawca podaje token BL i jednym poleceniem dostaje w Kompletorze
// produkty, oferty, powiązania, stany, konta kanałów, reguły przewoźników, mapę statusów i otwarte zamówienia.
//
//   npm run przeprowadzka -- --firma <slug> [--katalog <id>] [--mapa <plik.json>] [--raport <katalog poza repo>]
//                            [--zrzut <plik>] [--z-zrzutu <plik>] [--zapisz]
//
// Bez --zapisz: TRYB PRÓBNY — nic nie trafia do bazy, tylko raport na dysku (co przejdzie, co wymaga decyzji).
// --zapisz: zapis wyłącznie w bazie Kompletora (klient firmy, RLS). W BL nic się nie zmienia: klient BL przeprowadzki
// odmawia każdej metody spoza listy (lib/przeprowadzka/metody.ts), a pod spodem i tak tylko odczyt (get*).
// --mapa: decyzje człowieka (statusy, przewoźnicy, pominięte źródła) — JSON bez danych klientów.
// --raport: katalog na raport (Markdown + JSON); domyślnie lokalny katalog użytkownika. Ścieżka w repo = błąd.
// --zrzut / --z-zrzutu: zebrane dane (konfiguracja BL, katalog, zamówienia PO odrzuceniu danych osobowych) — poza repo.
// Token: sekret firmy BASELINKER_TOKEN (`npm run sekret -- --firma <slug> --ustaw BASELINKER_TOKEN --ze-stdin`);
// klucze wFirmy opcjonalne (z nimi stan startowy z wFirmy, bez nich z magazynu BL).
// Kody wyjścia: 0 — gotowe (tryb próbny także przy sprawach do decyzji), 1 — błąd albo odmowa zapisu.
import 'dotenv/config'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { defaultRegistry } from '../lib/adaptery/domyslne'
import { createOrgClient, createSystemClient } from '../lib/db'
import { WFIRMA_KEYS, type Env } from '../lib/konfiguracja'
import { envSecretsAllowed, listActiveOrganizations } from '../lib/organizacje'
import { BlPrzeprowadzka } from '../lib/przeprowadzka/metody'
import { wczytajZrzut, zbierz, type ZebraneDane } from '../lib/przeprowadzka/przebieg'
import { parseMapa, PUSTA_MAPA } from '../lib/przeprowadzka/statusy'
import { uruchomPrzeprowadzke } from '../lib/przeprowadzka/uruchomienie'
import { OdmowaZapisu } from '../lib/przeprowadzka/zapis'
import { resolveSecrets } from '../lib/sekrety'
import { DEFAULT_WAREHOUSE } from '../lib/rdzen/stan'
import { WfirmaReadOnly } from '../lib/zrodla/wfirma'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes(name)

const KNOWN = new Set(['--firma', '--katalog', '--mapa', '--raport', '--zrzut', '--z-zrzutu', '--zapisz'])

/** Plik poza repo: sama nazwa → katalog lokalny użytkownika (`podkatalog`); ścieżka w repo → błąd. */
function poZaRepo(requested: string, podkatalog: string, repoRoot = process.cwd()): string {
  const base = process.env['LOCALAPPDATA'] ? path.join(process.env['LOCALAPPDATA'], 'logistyka', podkatalog) : path.join(os.homedir(), '.logistyka', podkatalog)
  const abs = path.basename(requested) === requested ? path.join(base, requested) : path.resolve(requested)
  const rel = path.relative(path.resolve(repoRoot), abs)
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error(`${abs} wewnątrz repo — podaj ścieżkę poza repo albo samą nazwę (${base})`)
  return abs
}

async function pickOrganization(env: Env): Promise<{ id: string; slug: string; envFallback: boolean }> {
  const sys = createSystemClient({ poolMax: 1 })
  try {
    const orgs = await listActiveOrganizations(sys)
    const slug = arg('--firma')
    if (!slug) throw new Error('Wskaż firmę: --firma <slug> (lista: npm run org:list)')
    const org = orgs.find((o) => o.slug === slug)
    if (!org) throw new Error(`Nie ma aktywnej firmy ${slug}`)
    return { id: org.id, slug: org.slug, envFallback: envSecretsAllowed(env, org, orgs.length) }
  } finally {
    await sys.$disconnect()
  }
}

async function main(): Promise<number> {
  for (const a of process.argv.slice(2)) if (a.startsWith('--') && !KNOWN.has(a)) throw new Error(`nieznana opcja ${a}`)
  const env = process.env as Env
  const zapisz = flag('--zapisz')
  const mapaPlik = arg('--mapa')
  const mapa = mapaPlik ? parseMapa(JSON.parse(await readFile(mapaPlik, 'utf8'))) : PUSTA_MAPA
  const org = await pickOrganization(env)
  const db = createOrgClient(org.id, { poolMax: 2 })
  try {
    const registry = defaultRegistry()
    let dane: ZebraneDane
    const zZrzutu = arg('--z-zrzutu')
    if (zZrzutu) {
      dane = wczytajZrzut(await readFile(zZrzutu, 'utf8'))
      if (arg('--katalog') && arg('--katalog') !== dane.katalogArg) throw new Error(`zrzut zebrany dla katalogu ${dane.katalogArg ?? '(domyślny)'} — --katalog zbierz od nowa`)
      console.log(`[przeprowadzka] dane ze zrzutu ${zZrzutu} (pobrane ${dane.pobrano})`)
    } else {
      const secrets = await resolveSecrets(db, ['BASELINKER_TOKEN', ...WFIRMA_KEYS], { env, envFallback: org.envFallback })
      if (!secrets['BASELINKER_TOKEN']) {
        console.error(`[przeprowadzka] brak tokenu BL: npm run sekret -- --firma ${org.slug} --ustaw BASELINKER_TOKEN --ze-stdin`)
        return 1
      }
      const bl = new BlPrzeprowadzka(secrets['BASELINKER_TOKEN'])
      const wfirma = WFIRMA_KEYS.every((k) => secrets[k])
        ? new WfirmaReadOnly({ accessKey: secrets['WFIRMA_ACCESS_KEY']!, secretKey: secrets['WFIRMA_SECRET_KEY']!, appKey: secrets['WFIRMA_APP_KEY']!, companyId: secrets['WFIRMA_COMPANY_ID']! })
        : null
      const wh = await db.warehouse.findFirst({ where: { id: DEFAULT_WAREHOUSE }, select: { wfirmaWarehouseId: true } })
      if (wfirma && !wh?.wfirmaWarehouseId) console.warn('[przeprowadzka] klucze wFirmy są, ale magazyn firmy nie ma wfirmaWarehouseId — stan startowy z magazynu BL')
      console.log(`[przeprowadzka] firma ${org.slug}: czytam BL (tylko metody z listy)${wfirma && wh?.wfirmaWarehouseId ? ' i wFirmę' : ''}…`)
      dane = await zbierz({ bl, wfirma, wfirmaWarehouseId: wh?.wfirmaWarehouseId ?? null }, { katalog: arg('--katalog'), mapa, registry })
    }
    const zrzut = arg('--zrzut')
    if (zrzut) {
      const p = poZaRepo(zrzut, 'zrzuty')
      await mkdir(path.dirname(p), { recursive: true })
      await writeFile(p, JSON.stringify(dane), 'utf8')
      console.log(`[przeprowadzka] zrzut: ${p}`)
    }
    let wynik
    try {
      wynik = await uruchomPrzeprowadzke(db, { firma: org.slug, dane, mapa, registry, zapisz })
    } catch (e) {
      if (e instanceof OdmowaZapisu) {
        console.error('[przeprowadzka] zapis odrzucony:')
        for (const p of e.powody) console.error(`  - ${p}`)
        console.error('  (tryb próbny bez --zapisz pokaże pełny raport)')
        return 1
      }
      throw e
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dir = poZaRepo(arg('--raport') ?? `${org.slug}-${stamp}`, 'przeprowadzka')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'raport-przeprowadzki.md'), wynik.markdown, 'utf8')
    await writeFile(path.join(dir, 'raport-przeprowadzki.json'), JSON.stringify(wynik.raport, null, 2), 'utf8')
    const c = wynik.raport.coPrzejdzie
    console.log(
      `[przeprowadzka] ${zapisz ? 'ZAPIS' : 'TRYB PRÓBNY (nic nie zapisano)'}: konta ${c['konta']}, produkty ${c['produkty']}, zestawy ${c['zestawy']}, ` +
        `oferty ${c['ofertyAktywne']}, reguły ${c['regulyPrzewoznikow']}, otwarte zamówienia ${c['zamowieniaOtwarte']} (do wyjaśnienia ${c['zamowieniaDoWyjasnienia']})`,
    )
    const dd = wynik.raport.doDecyzji
    console.log(`[przeprowadzka] do decyzji: statusy ${dd.statusy.length}, przewoźnicy ${dd.przewoznicy.length}, oferty ${dd.ofertyBezPowiazania.length}, produkty bez SKU ${dd.produktyBezSku.length}`)
    if (!zapisz && wynik.powodyOdmowy.length) console.log(`[przeprowadzka] --zapisz zostałby teraz odrzucony (${wynik.powodyOdmowy.length} powodów — patrz raport)`)
    if (wynik.zapis) console.log(`[przeprowadzka] zapisano, przebieg ${wynik.zapis.runId}`)
    console.log(`[przeprowadzka] raport: ${path.join(dir, 'raport-przeprowadzki.md')}`)
    return 0
  } finally {
    await db.$disconnect()
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error('[przeprowadzka] błąd:', e instanceof Error ? e.message : e)
    process.exit(1)
  },
)
