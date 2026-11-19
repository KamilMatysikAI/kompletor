// Firmy w bazie (kod systemowy).
//   npm run org:seed -- <nazwa>                         — preset firmy z seed/presety/<nazwa>.json albo z prywatnej nakładki
//                                                         prywatne/presety/<nazwa>.json, idempotentnie
//   npm run org:seed -- --plik <ścieżka>                — preset z dowolnego pliku JSON (prywatna konfiguracja poza repo)
//   KOMPLETOR_PRESET_PLIK=<ścieżka> nadpisuje ścieżkę presetu `seed <nazwa>` (plik zamontowany do kontenera)
//   npm run org:seed -- demo                            — wbudowana firma demo z danymi fikcyjnymi (lib/instalacja/demo.ts)
//   tsx scripts/org.ts adres-startu                     — entrypoint (web): adres kreatora /start, gdy nie ma kont
//   npm run org:create -- --slug moja-firma --name "Moja firma" [--inventory 12345] [--wfirma-magazyn 678]
//   npm run org:list
//   npm run org:automaty -- <nazwa> [--sucho] [--plik <ścieżka>]  — tylko automatyczne akcje z presetu do istniejącej firmy
//                                                         brakujące klucze reguł, raport; --sucho = bez zapisu
//   npm run rola:aplikacji [-- --sprawdz [--czekaj 90]]  — rola LOGIN klienta firmy z hasłem z APP_DATABASE_URL;
//                                                         --sprawdz: tylko logowanie, bez zmiany hasła (worker)
//   tsx scripts/org.ts zdjecia-do-bazy [--firma <slug>] [--limit-s 60]  — zdjęcia produktów z katalogu ZDJECIA_DIR do bazy
//                                                         (entrypoint web i worker przy starcie), idempotentnie,
//                                                         pliki zostają na dysku; --limit-s: przerwij po tylu sekundach
//   tsx scripts/org.ts zdjecia-z-ofert [--firma <slug>]  — zdjęcia produktom bez zdjęcia z adresów ostatniego „Pobierz oferty”
//                                                         (pobiera worker, tylko odczyt kanału)
import 'dotenv/config'
import { appModeOf, createOrgClient, createSystemClient, ensureAppRoleLogin } from '../lib/db'
import { zalozDemo } from '../lib/instalacja/demo'
import { czytajKodInstalacji } from '../lib/instalacja/sekrety'
import { applyOrgPreset, presetNowejFirmy } from '../lib/organizacje'
import { opisRaportu, zastosujAutomatyPresetu } from '../lib/automaty/preset'
import { uzupelnijZdjeciaZOfert } from '../lib/kanaly/oferty'
import { przeniesZdjeciaZDysku } from '../lib/produkty/zdjecia'
import { PresetError, sciezkaPresetu, wczytajPreset } from '../lib/preset-plik'

const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<number> {
  const cmd = process.argv[2]
  const sys = createSystemClient({ poolMax: 1 })
  try {
    if (cmd === 'rola-aplikacji') {
      // idempotentnie: hasło z APP_DATABASE_URL, ustawia właściciel z DATABASE_URL; wartość nie trafia do logu.
      // `--sprawdz` (kontener workera): bez ALTER, tylko logowanie. Czeka do `--czekaj` s
      // (domyślnie 90) na web, który przy pierwszym wdrożeniu albo rotacji ustawia hasło; potem błąd = worker nie startuje.
      if (process.argv.includes('--sprawdz')) {
        const wait = Number(arg('--czekaj') ?? 90)
        if (!Number.isFinite(wait) || wait < 0) throw new Error('--czekaj: liczba sekund ≥ 0')
        const deadline = Date.now() + wait * 1000
        for (;;) {
          const r = await ensureAppRoleLogin({ tylkoSprawdz: true })
          if (r !== 'haslo-nie-pasuje') {
            console.log('[org] rola aplikacji: logowanie sprawdzone (bez zmian, hasło ustawia web)')
            return 0
          }
          if (Date.now() >= deadline)
            throw new Error('logowanie rolą logistyka_app z APP_DATABASE_URL tego kontenera odrzucone: hasło nie pasuje (ustaw tę samą wartość APP_DATABASE_URL co w aplikacji web; hasło ustawia web, worker tylko sprawdza) albo rola bez LOGIN / pg_hba.conf odrzuca — sprawdź log kontenera web')
          await new Promise((res) => setTimeout(res, 3000))
        }
      }
      const r = await ensureAppRoleLogin()
      console.log(`[org] rola aplikacji: ${r === 'ustawiono' ? 'LOGIN i hasło ustawione' : 'logowanie działa, bez zmian'}`)
      return 0
    }
    if (cmd === 'seed') {
      // Preset z pliku: `seed <nazwa>` → seed/presety/<nazwa>.json, prywatne/presety/<nazwa>.json albo KOMPLETOR_PRESET_PLIK,
      // `seed --plik <ścieżka>` → wskazany plik. Brak pliku albo zły preset = komunikat, kod 1, bez stack trace.
      const plik = arg('--plik')
      const nazwa = process.argv[3]
      if (nazwa === 'demo' && !plik) {
        // wbudowane demo: tylko gdy firmy demo jeszcze nie ma; hasło konta demo raz, do logu startu kontenera
        const r = await zalozDemo(sys, (id) => createOrgClient(id, { poolMax: 2 }))
        if (!r.utworzona) console.log('[org] demo: firma „demo” już jest, bez zmian')
        else console.log(`[org] demo: firma „Sklep Demo” gotowa (${r.zamowienia} zamówień fikcyjnych). Konto: ${r.email}  Hasło: ${r.haslo}`)
        return 0
      }
      if (!plik && (!nazwa || nazwa.startsWith('--'))) throw new PresetError('Podaj nazwę presetu (seed <nazwa>) albo --plik <ścieżka>')
      const sciezka = plik ?? sciezkaPresetu(nazwa)
      const preset = await wczytajPreset(sciezka)
      console.log(`[org] ${preset.slug} (${sciezka}):`, JSON.stringify(await applyOrgPreset(sys, preset)))
      return 0
    }
    if (cmd === 'automaty') {
      // reguły automatycznych akcji z presetu do istniejącej firmy (np. firma z BL na stagingu po wdrożeniu).
      // Idempotentnie: zakłada tylko brakujące klucze, nie zmienia reguł z panelu ani statusów zamówień.
      const plik = arg('--plik')
      const nazwa = process.argv[3]
      if (!plik && (!nazwa || nazwa.startsWith('--'))) throw new PresetError('Podaj nazwę presetu (automaty <nazwa>) albo --plik <ścieżka>')
      const sciezka = plik ?? sciezkaPresetu(nazwa)
      const preset = await wczytajPreset(sciezka)
      const firma = await sys.organization.findUnique({ where: { id: preset.id }, select: { id: true } })
      if (!firma) throw new PresetError(`Firmy ${preset.id} nie ma w bazie: najpierw npm run org:seed -- ${nazwa ?? '--plik ' + sciezka}`)
      const r = await sys.$transaction((tx) => zastosujAutomatyPresetu(tx, preset.id, preset, { sucho: process.argv.includes('--sucho') }))
      console.log(`[org] ${preset.slug} automatyczne akcje (${sciezka}): ${opisRaportu(r)}`)
      if (r.regulyNowe.length) console.log(`[org] nowe reguły: ${r.regulyNowe.join(', ')}`)
      return r.bledy.length ? 1 : 0
    }
    if (cmd === 'create') {
      const slug = arg('--slug')
      const name = arg('--name')
      if (!slug || !name) throw new Error('Podaj --slug i --name')
      const preset = presetNowejFirmy({ slug, name, inventoryId: arg('--inventory'), wfirmaWarehouseId: arg('--wfirma-magazyn') ?? null })
      console.log(`[org] ${slug}:`, JSON.stringify(await applyOrgPreset(sys, preset)))
      console.log('[org] kanały i klucze: panel (F2) albo seed firmy; klucze API: npm run sekret -- --firma', slug)
      return 0
    }
    if (cmd === 'adres-startu') {
      // po migracjach w roli web. Świeża instalacja self-host (zero kont) = wyraźny blok z adresem kreatora
      // i kodem instalacji; przy kolejnych startach (konto już jest) nic nie wypisuje. Tylko kod idzie do logu.
      if (appModeOf(process.env) !== 'self-host' || (await sys.user.count()) > 0) return 0
      const kod = await czytajKodInstalacji()
      const linia = '='.repeat(72)
      if (!kod) {
        console.log(`\n${linia}\n Kompletor działa, ale nie ma jeszcze żadnego konta ani kodu instalacji.\n Pierwsze konto: node dist/uzytkownik.cjs dodaj --email … --imie … --firma <slug> --rola WLASCICIEL\n${linia}\n`)
        return 0
      }
      const port = process.env['KOMPLETOR_PORT']?.trim() || '3000'
      console.log(`\n${linia}\n Kompletor gotowy. Otwórz: http://localhost:${port}/start?kod=${kod}\n${linia}\n`)
      return 0
    }
    if (cmd === 'zdjecia-do-bazy') {
      // każda firma osobno, każde zdjęcie osobno; błąd jednej firmy nie zatrzymuje pozostałych ani startu.
      const limit = Number(arg('--limit-s') ?? 0)
      if (!Number.isFinite(limit) || limit < 0) throw new Error('--limit-s: liczba sekund ≥ 0 (0 = bez limitu)')
      const doKiedy = limit ? Date.now() + limit * 1000 : undefined
      const slug = arg('--firma')
      const firmy = await sys.organization.findMany({ where: slug ? { slug } : {}, orderBy: { id: 'asc' }, select: { id: true, slug: true } })
      if (slug && !firmy.length) throw new Error(`nie ma firmy ${slug}`)
      let kod = 0
      for (const f of firmy) {
        const db = createOrgClient(f.id, { poolMax: 2 })
        try {
          const r = await przeniesZdjeciaZDysku(db, { doKiedy })
          if (r.przeniesione || r.brakPliku || r.bledy.length || r.przerwane)
            console.log(`[org] zdjęcia do bazy, ${f.slug}: przeniesione ${r.przeniesione}, bez pliku w tym kontenerze ${r.brakPliku}, błędy ${r.bledy.length}${r.przerwane ? ', przerwane po czasie (reszta przy następnym starcie)' : ''}`)
          for (const b of r.bledy.slice(0, 5)) console.error(`[org] zdjęcie ${b.imageId}: ${b.komunikat}`)
          if (r.bledy.length) kod = 1
        } catch (e) {
          console.error(`[org] zdjęcia do bazy, ${f.slug}: ${e instanceof Error ? e.message : e}`)
          kod = 1
        } finally {
          await db.$disconnect()
        }
      }
      return kod
    }
    if (cmd === 'zdjecia-z-ofert') {
      // zlecenie pobrania zdjęć produktom bez zdjęcia, z adresów ostatniego „Pobierz oferty” (tylko odczyt
      // kanału, pobiera worker). Każda firma osobno; idempotentnie (czekające zlecenie produktu się nie dubluje).
      const slug = arg('--firma')
      // tylko firmy aktywne (worker nie bierze zadań firmy wyłączonej, zlecenia by zalegały)
      const firmy = await sys.organization.findMany({ where: { active: true, ...(slug ? { slug } : {}) }, orderBy: { id: 'asc' }, select: { id: true, slug: true } })
      if (slug && !firmy.length) throw new Error(`nie ma aktywnej firmy ${slug}`)
      let kod = 0
      for (const f of firmy) {
        const db = createOrgClient(f.id, { poolMax: 2 })
        try {
          const r = await uzupelnijZdjeciaZOfert(db)
          console.log(`[org] zdjęcia z ofert, ${f.slug}: produkty bez zdjęcia ${r.bezZdjecia}, zlecone ${r.zlecone}, już w kolejce ${r.wKolejce}, ponad limit przebiegu (przy następnym) ${r.pominiete}, bez adresu w odczycie ofert ${r.bezAdresu}, odłożone po nieudanej próbie ${r.odlozone}, błędy ${r.bledy}`)
          if (r.bledy) kod = 1
        } catch (e) {
          console.error(`[org] zdjęcia z ofert, ${f.slug}: ${e instanceof Error ? e.message : e}`)
          kod = 1
        } finally {
          await db.$disconnect()
        }
      }
      return kod
    }
    if (cmd === 'list') {
      for (const o of await sys.organization.findMany({ orderBy: { id: 'asc' } })) console.log(`${o.id}\t${o.slug}\t${o.active ? 'aktywna' : 'wyłączona'}\t${o.name}`)
      return 0
    }
    console.error('Użycie: tsx scripts/org.ts seed <nazwa> | seed --plik <ścieżka> | automaty <nazwa> [--sucho] | create --slug <slug> --name <nazwa> | list | adres-startu | zdjecia-do-bazy [--firma <slug>] [--limit-s <s>] | zdjecia-z-ofert [--firma <slug>] | rola-aplikacji [--sprawdz [--czekaj <s>]]')
    return 2
  } finally {
    await sys.$disconnect()
  }
}

main().then(
  (c) => process.exit(c),
  (e: unknown) => {
    console.error('[org] błąd:', e instanceof Error ? e.message : e)
    process.exit(1)
  },
)
