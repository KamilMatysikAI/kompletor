// Paczka dla komputera w magazynie: wydanie/Kompletor-Druk-<wersja>-win-x64.zip z gotowym Node
// (runtime\node.exe), SumatraPDF (sumatra\SumatraPDF.exe, wersja portable), licencjami i jednym plikiem
// Zainstaluj.cmd w korzeniu. Nikt w magazynie nie instaluje ręcznie Node ani SumatraPDF.
//
//   npm run paczka                       # pobiera node.exe i SumatraPDF z oficjalnych adresów, sprawdza SHA-256
//   npm run paczka -- --runtime <katalog> # bierze node.exe, SumatraPDF.exe (i licencje, jeśli są) z katalogu
//
// Wersje i sumy: skrypty/wersje-paczki.json. Niezgodna suma = błąd, paczka nie powstaje. Suma oznaczona [NIEPEWNE]:
// w trybie pobierania błąd (z policzoną sumą do sprawdzenia), w trybie --runtime ostrzeżenie. Binariów nie ma w repo.
// Bez zależności: ZIP składa i czyta ten skrypt (zlib z Node).
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'

const katalog = join(dirname(fileURLToPath(import.meta.url)), '..')
const NIEPEWNE = '[NIEPEWNE]'

function blad(tekst) {
  console.error(`BŁĄD: ${tekst}`)
  process.exit(1)
}

const sha256 = (b) => createHash('sha256').update(b).digest('hex')

/** Suma znana → musi się zgadzać. [NIEPEWNE] → w trybie pobierania błąd, w --runtime ostrzeżenie. */
function sprawdzSume(nazwa, dane, oczekiwana, zLokalnego) {
  const jest = sha256(dane)
  if (!oczekiwana || oczekiwana.includes(NIEPEWNE)) {
    const tekst = `${nazwa}: suma SHA-256 w wersje-paczki.json oznaczona ${NIEPEWNE}; policzona: ${jest}. Sprawdź ją z oficjalnym źródłem i wpisz do wersje-paczki.json.`
    if (zLokalnego) console.warn(`UWAGA: ${tekst}`)
    else blad(`${tekst} Do tego czasu buduj z --runtime <katalog>.`)
    return
  }
  if (jest !== oczekiwana.toLowerCase()) blad(`${nazwa}: suma SHA-256 się nie zgadza (jest ${jest}, oczekiwana ${oczekiwana}) — plik podmieniony albo uszkodzony`)
}

async function pobierz(url) {
  console.log(`Pobieram ${url}`)
  let odp
  try {
    odp = await fetch(url, { redirect: 'follow' })
  } catch (e) {
    blad(`nie udało się pobrać ${url}: ${e.message}. Bez sieci buduj z --runtime <katalog>.`)
  }
  if (!odp.ok) blad(`${url}: odpowiedź ${odp.status}`)
  return Buffer.from(await odp.arrayBuffer())
}

// ─── ZIP (PKWARE APPNOTE): zapis z deflate i odczyt jednego pliku ───────────────────────────────────────────

/** Czas DOS stały (2026-01-01 00:00): te same pliki dają te same bajty paczki. */
const DOS_CZAS = 0
const DOS_DATA = ((2026 - 1980) << 9) | (1 << 5) | 1

export function zapiszZip(wpisy) {
  const lokalne = []
  const centralne = []
  let przesuniecie = 0
  for (const { nazwa, dane } of wpisy) {
    const imie = Buffer.from(nazwa.replace(/\\/g, '/'), 'utf8')
    const spakowane = deflateRawSync(dane, { level: 9 })
    const metoda = spakowane.length < dane.length ? 8 : 0
    const tresc = metoda === 8 ? spakowane : dane
    const crc = crc32(dane) >>> 0
    if (dane.length >= 0xffffffff || przesuniecie >= 0xffffffff) throw new Error('plik za duży dla ZIP bez ZIP64')
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(0x0800, 6) // nazwy w UTF-8
    lh.writeUInt16LE(metoda, 8)
    lh.writeUInt16LE(DOS_CZAS, 10)
    lh.writeUInt16LE(DOS_DATA, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(tresc.length, 18)
    lh.writeUInt32LE(dane.length, 22)
    lh.writeUInt16LE(imie.length, 26)
    lh.writeUInt16LE(0, 28)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0x0800, 8)
    ch.writeUInt16LE(metoda, 10)
    ch.writeUInt16LE(DOS_CZAS, 12)
    ch.writeUInt16LE(DOS_DATA, 14)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(tresc.length, 20)
    ch.writeUInt32LE(dane.length, 24)
    ch.writeUInt16LE(imie.length, 28)
    ch.writeUInt32LE(przesuniecie, 42)
    lokalne.push(lh, imie, tresc)
    centralne.push(ch, imie)
    przesuniecie += lh.length + imie.length + tresc.length
  }
  const cd = Buffer.concat(centralne)
  const koniec = Buffer.alloc(22)
  koniec.writeUInt32LE(0x06054b50, 0)
  koniec.writeUInt16LE(wpisy.length, 8)
  koniec.writeUInt16LE(wpisy.length, 10)
  koniec.writeUInt32LE(cd.length, 12)
  koniec.writeUInt32LE(przesuniecie, 16)
  return Buffer.concat([...lokalne, cd, koniec])
}

/** Jeden plik z ZIP-a (np. SumatraPDF-…-64.exe z wersji portable). */
export function czytajZZip(zip, szukany) {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocd < 0) throw new Error('to nie jest plik ZIP')
  const ile = zip.readUInt16LE(eocd + 10)
  let p = zip.readUInt32LE(eocd + 16)
  const nazwy = []
  for (let i = 0; i < ile; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('uszkodzony katalog ZIP')
    const metoda = zip.readUInt16LE(p + 10)
    const rozmiar = zip.readUInt32LE(p + 20)
    const dl = zip.readUInt16LE(p + 28)
    const extra = zip.readUInt16LE(p + 30)
    const kom = zip.readUInt16LE(p + 32)
    const lokalny = zip.readUInt32LE(p + 42)
    const nazwa = zip.subarray(p + 46, p + 46 + dl).toString('utf8')
    nazwy.push(nazwa)
    if (nazwa.toLowerCase() === szukany.toLowerCase()) {
      const start = lokalny + 30 + zip.readUInt16LE(lokalny + 26) + zip.readUInt16LE(lokalny + 28)
      const dane = zip.subarray(start, start + rozmiar)
      if (metoda === 0) return Buffer.from(dane)
      if (metoda === 8) return inflateRawSync(dane)
      throw new Error(`nieobsługiwana metoda kompresji ${metoda}`)
    }
    p += 46 + dl + extra + kom
  }
  throw new Error(`w ZIP nie ma pliku ${szukany} (są: ${nazwy.join(', ')})`)
}

// ─── Składanie paczki ───────────────────────────────────────────────────────────────────────────────────

const BOM = Buffer.from([0xef, 0xbb, 0xbf])

/**
 * plik .cmd/.ps1 do paczki zawsze z końcami linii CRLF (cmd.exe źle czyta skrypty z samym LF), a .ps1
 * z BOM UTF-8 (PowerShell 5.1 czyta plik bez BOM jako ANSI i psuje polskie znaki). Niezależnie od tego, jak
 * git wypakował pliki (core.autocrlf, checkout na Linuksie w CI).
 */
export function skryptDoPaczki(nazwa, dane) {
  const n = nazwa.toLowerCase()
  if (!n.endsWith('.cmd') && !n.endsWith('.ps1')) return dane
  const maBom = dane.subarray(0, 3).equals(BOM)
  const tekst = (maBom ? dane.subarray(3) : dane).toString('utf8').replace(/\r?\n/g, '\r\n')
  if (n.endsWith('.ps1')) return Buffer.concat([BOM, Buffer.from(tekst, 'utf8')])
  return Buffer.concat([maBom ? BOM : Buffer.alloc(0), Buffer.from(tekst, 'utf8')])
}

function pliki(kat, prefiks, filtr = () => true) {
  const out = []
  for (const f of readdirSync(kat).sort()) {
    const p = join(kat, f)
    if (statSync(p).isDirectory()) out.push(...pliki(p, `${prefiks}${f}/`, filtr))
    else if (filtr(p)) out.push({ nazwa: `${prefiks}${f}`, dane: readFileSync(p) })
  }
  return out
}

async function main() {
  const argi = process.argv.slice(2)
  const i = argi.indexOf('--runtime')
  const runtime = i >= 0 ? argi[i + 1] : undefined
  if (i >= 0 && !runtime) blad('--runtime wymaga katalogu (z plikami node.exe i SumatraPDF.exe)')
  if (!existsSync(join(katalog, 'dist', 'main.js'))) blad('brak dist/main.js — najpierw npm run build')
  const wersje = JSON.parse(readFileSync(join(katalog, 'skrypty', 'wersje-paczki.json'), 'utf8'))
  const { version } = JSON.parse(readFileSync(join(katalog, 'package.json'), 'utf8'))

  let node
  let sumatra
  if (runtime) {
    for (const f of ['node.exe', 'SumatraPDF.exe']) if (!existsSync(join(runtime, f))) blad(`w ${runtime} nie ma pliku ${f}`)
    node = readFileSync(join(runtime, 'node.exe'))
    sumatra = readFileSync(join(runtime, 'SumatraPDF.exe'))
    sprawdzSume(`node.exe ${wersje.node.wersja}`, node, wersje.node.sha256, true)
    // suma Sumatry w wersje-paczki.json dotyczy pliku ZIP (wersja portable) — przy --runtime liczymy samą .exe (sha256Exe)
    sprawdzSume(`SumatraPDF.exe ${wersje.sumatra.wersja}`, sumatra, wersje.sumatra.sha256Exe, true)
  } else {
    node = await pobierz(wersje.node.url)
    sprawdzSume(`node.exe ${wersje.node.wersja}`, node, wersje.node.sha256, false)
    const zip = await pobierz(wersje.sumatra.url)
    sprawdzSume(`SumatraPDF ${wersje.sumatra.wersja}`, zip, wersje.sumatra.sha256, false)
    sumatra = wersje.sumatra.url.toLowerCase().endsWith('.zip') ? czytajZZip(zip, wersje.sumatra.plikWZip) : zip
    if (wersje.sumatra.sha256Exe) sprawdzSume(`SumatraPDF.exe ${wersje.sumatra.wersja}`, sumatra, wersje.sumatra.sha256Exe, false)
  }
  if (node.subarray(0, 2).toString('latin1') !== 'MZ' || sumatra.subarray(0, 2).toString('latin1') !== 'MZ')
    blad('node.exe albo SumatraPDF.exe nie jest programem Windows (brak nagłówka MZ)')

  // licencje: z katalogu --runtime, jeśli są, inaczej z przypiętych adresów (z kontrolą sumy)
  const licencja = async (plikLokalny, opis) => {
    if (runtime && existsSync(join(runtime, plikLokalny))) return readFileSync(join(runtime, plikLokalny))
    const dane = await pobierz(opis.url)
    sprawdzSume(plikLokalny, dane, opis.sha256, false)
    return dane
  }
  const licencjaNode = await licencja('LICENSE-node.txt', wersje.node.licencja)
  const licencjaSumatry = await licencja('COPYING-sumatra.txt', wersje.sumatra.licencja)

  const tekst = (s) => Buffer.from(s.replace(/\r?\n/g, '\r\n'), 'utf8')
  const wpisy = [
    { nazwa: 'Zainstaluj.cmd', dane: readFileSync(join(katalog, 'Zainstaluj.cmd')) },
    { nazwa: 'odinstaluj.cmd', dane: readFileSync(join(katalog, 'odinstaluj.cmd')) },
    { nazwa: 'uruchom.cmd', dane: readFileSync(join(katalog, 'uruchom.cmd')) },
    { nazwa: 'README.md', dane: readFileSync(join(katalog, 'README.md')) },
    { nazwa: 'agent-druku.przyklad.json', dane: readFileSync(join(katalog, 'agent-druku.przyklad.json')) },
    { nazwa: 'package.json', dane: readFileSync(join(katalog, 'package.json')) },
    ...pliki(join(katalog, 'dist'), 'dist/', (p) => !p.endsWith('.map')),
    ...['druk-raw.ps1', 'stan-drukarek.ps1', 'start.ps1', 'instaluj.ps1', 'odinstaluj.ps1', 'ustawienia.ps1'].map((f) => ({ nazwa: `skrypty/${f}`, dane: readFileSync(join(katalog, 'skrypty', f)) })),
    { nazwa: 'runtime/node.exe', dane: node },
    { nazwa: 'runtime/LICENSE.txt', dane: licencjaNode },
    { nazwa: 'sumatra/SumatraPDF.exe', dane: sumatra },
    { nazwa: 'sumatra/COPYING.txt', dane: licencjaSumatry },
    {
      nazwa: 'sumatra/ZRODLA.txt',
      dane: tekst(
        `SumatraPDF ${wersje.sumatra.wersja} (64-bit, wersja portable) — program na licencji GNU GPL v3 (plik COPYING.txt obok).\n` +
          `Kod źródłowy tej wersji: ${wersje.sumatra.zrodla}\n` +
          `Plik pobrany z: ${wersje.sumatra.url}\n` +
          'Kompletor Druk wywołuje SumatraPDF jako osobny program (druk PDF z linii poleceń); nie łączy go ze swoim kodem.\n',
      ),
    },
    {
      nazwa: 'LICENCJE.txt',
      dane: tekst(
        `Kompletor Druk ${version}\n\n` +
          '- Program agenta druku (dist/, skrypty/): GNU AGPL v3, wyłącznie w wersji 3 (AGPL-3.0-only, repozytorium Kompletora).\n' +
          `- runtime/node.exe: Node.js ${wersje.node.wersja}, licencja w runtime/LICENSE.txt (MIT i licencje składników).\n` +
          `- sumatra/SumatraPDF.exe: SumatraPDF ${wersje.sumatra.wersja}, GNU GPL v3 — sumatra/COPYING.txt, źródła: sumatra/ZRODLA.txt.\n`,
      ),
    },
  ]
  const cel = join(katalog, 'wydanie', `Kompletor-Druk-${version}-win-x64.zip`)
  mkdirSync(dirname(cel), { recursive: true })
  const zip = zapiszZip(wpisy.map((w) => ({ nazwa: w.nazwa, dane: skryptDoPaczki(w.nazwa, w.dane) })))
  writeFileSync(cel, zip)
  // suma obok paczki (format sha256sum), do wpisania w AGENT_DRUKU_SHA256 na serwerze
  writeFileSync(`${cel}.sha256`, `${sha256(zip)}  ${basename(cel)}\n`)
  console.log(`Paczka gotowa: ${relative(process.cwd(), cel) || cel} (${(zip.length / 1048576).toFixed(1)} MB, ${wpisy.length} plików, SHA-256 ${sha256(zip)})`)
}

// Import z testów (test/paczka.test.ts) nie buduje paczki.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main()
