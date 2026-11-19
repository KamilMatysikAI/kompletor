// Strona „Kompletor Druk (ustawienia)”: mały serwer HTTP w programie druku, wyłącznie na 127.0.0.1. Osoba w magazynie
// otwiera ją skrótem z pulpitu, widzi stan zwykłymi zdaniami, wybiera drukarki, wkleja kod połączenia i zapisuje —
// bez edycji plików i bez okna konsoli.
//
// Bezpieczeństwo (strona zmienia konfigurację z tokenem stanowiska):
//   - nasłuch tylko na pętli zwrotnej 127.0.0.1, nigdy na interfejsach sieciowych;
//   - losowy klucz (32 bajty) w adresie strony i w nagłówku każdego żądania API, porównywany w stałym czasie;
//     klucz leży lokalnie w dane\, skrót czyta go stamtąd;
//   - nagłówek Host musi wskazywać 127.0.0.1 na naszym porcie (obrona przed podmianą DNS na 127.0.0.1);
//   - żądania zmieniające stan: Origin (jeśli jest) tylko nasz, Sec-Fetch-Site tylko same-origin/none,
//     treść wyłącznie application/json (formularz z obcej strony tego nie wyśle bez zapytania wstępnego CORS,
//     na które serwer nie odpowiada zgodą);
//   - token stanowiska i kod połączenia nigdy nie wracają w odpowiedzi ani nie trafiają do logu.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { Drukarki, Uruchom } from './drukarki.js'
import { uruchomProces } from './drukarki.js'
import type { KodInstalacyjny } from './instalacja.js'
import { BladInstalacji, dekodujKodInstalacyjny, przydzielRole } from './instalacja.js'
import { jestTermiczna, WERSJA_AGENTA } from './kontrakt.js'
import { BladKonfiguracji, PORT_USTAWIEN, sprawdzKonfiguracje } from './konfiguracja.js'
import type { Log } from './log.js'
import { czasLokalny } from './log.js'
import type { MapaRol } from './mapowanie.js'
import { mapujStanWindows, roleZKonfiguracji } from './mapowanie.js'
import { wydrukujKartkeProbna } from './proba.js'
import { stronaUstawien } from './strona-ustawien.js'
import { koncowkaPliku, podpowiedzDo, podsumujLog } from './zdarzenia.js'

/** Porty strony: z konfiguracji (domyślnie PORT_USTAWIEN) i zapasowy o jeden wyżej, gdy pierwszy zajęty. */
export const portyUstawien = (port: number = PORT_USTAWIEN) => [port, port + 1]
export const NAGLOWEK_KLUCZA = 'x-kompletor-klucz'
export const PLIK_KLUCZA = 'ustawienia-klucz.txt'
/** Pełny adres strony (z kluczem) — czyta go skrót „Kompletor Druk (ustawienia)” i instalator. */
export const PLIK_ADRESU = 'adres-ustawien.txt'
const WZOR_KLUCZA = /^[A-Za-z0-9_-]{43}$/
const MAKS_TRESCI = 16 * 1024

/** Znacznik „szybkie ponowne uruchomienie”: czas (ms) zapisany tuż przed kodem wyjścia 4. */
export const PLIK_ZNACZNIKA_RESTARTU = 'ustawienia-restart.txt'
/** Jak długo po „Uruchom ponownie” nowy proces zachowuje stary klucz (otwarta karta przeglądarki działa dalej). */
export const OKNO_ZACHOWANIA_KLUCZA_MS = 2 * 60_000

/**
 * Klucz strony: przy każdym starcie nowy losowy (zapisany w dane\ustawienia-klucz.txt), więc stary adres z historii
 * przeglądarki przestaje działać. Wyjątek: start do 2 minut po „Uruchom ponownie program” ze strony (znacznik
 * z `zachowajKluczPrzyRestarcie`) zostawia poprzedni klucz. Znacznik działa raz.
 */
export function kluczUstawien(katalogDanych: string, teraz: number = Date.now()): string {
  const plik = join(katalogDanych, PLIK_KLUCZA)
  const znacznik = join(katalogDanych, PLIK_ZNACZNIKA_RESTARTU)
  let zachowaj = false
  try {
    const t = Number(readFileSync(znacznik, 'utf8').trim())
    zachowaj = Number.isFinite(t) && t > 0 && teraz - t >= 0 && teraz - t < OKNO_ZACHOWANIA_KLUCZA_MS
    if (t) writeFileSync(znacznik, '', 'utf8')
  } catch {
    // brak znacznika = zwykły start
  }
  if (zachowaj) {
    try {
      const k = readFileSync(plik, 'utf8').trim()
      if (WZOR_KLUCZA.test(k)) return k
    } catch {
      // brak pliku — nowy klucz niżej
    }
  }
  const nowy = randomBytes(32).toString('base64url')
  mkdirSync(katalogDanych, { recursive: true })
  writeFileSync(plik, nowy, 'utf8')
  return nowy
}

/** Wołane tuż przed kodem wyjścia 4: następny start (do 2 minut) zachowa obecny klucz strony. */
export function zachowajKluczPrzyRestarcie(katalogDanych: string, teraz: number = Date.now()) {
  try {
    writeFileSync(join(katalogDanych, PLIK_ZNACZNIKA_RESTARTU), String(teraz), 'utf8')
  } catch {
    // bez znacznika strona dostanie nowy klucz — trzeba ją otworzyć skrótem jeszcze raz
  }
}

export function rownyKlucz(podany: string | undefined, klucz: string): boolean {
  if (typeof podany !== 'string') return false
  const a = Buffer.from(podany)
  const b = Buffer.from(klucz)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Czy żądanie może dotknąć strony: Host = nasz adres pętli zwrotnej, a dla zmian stanu dodatkowo Origin,
 * Sec-Fetch-Site i typ treści. null = w porządku, tekst = powód odmowy (do odpowiedzi 403, bez szczegółów klucza).
 */
export function sprawdzPochodzenie(req: Pick<IncomingMessage, 'headers' | 'method'>, port: number): string | null {
  // Tylko 127.0.0.1: nasłuch jest wyłącznie na IPv4, a adres strony zawsze ma 127.0.0.1 (nazwa localhost niepotrzebna).
  const hosty = [`127.0.0.1:${port}`]
  const host = String(req.headers.host ?? '').toLowerCase()
  if (!hosty.includes(host)) return 'niedozwolony adres'
  const zmiana = req.method !== 'GET' && req.method !== 'HEAD'
  const origin = req.headers.origin
  if (origin !== undefined && !hosty.some((h) => origin.toLowerCase() === `http://${h}`)) return 'żądanie z innej strony'
  const site = req.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return 'żądanie z innej strony'
  if (zmiana) {
    if (origin === undefined && site === undefined) return 'brak nagłówka Origin'
    const typ = String(req.headers['content-type'] ?? '').toLowerCase().split(';')[0]!.trim()
    if (typ !== 'application/json') return 'zły typ treści'
  }
  return null
}

/** Czy Windows sam przestawia drukarkę domyślną (Ustawienia → Wysyłka i druk → Drukarki i skanery). null = nie wiadomo. */
export async function czyWindowsZarzadzaDomyslna(uruchom: Uruchom = uruchomProces): Promise<boolean | null> {
  try {
    const { stdout } = await uruchom(
      'reg.exe',
      ['query', 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Windows', '/v', 'LegacyDefaultPrinterMode'],
      { timeoutMs: 5000 },
    )
    const m = /LegacyDefaultPrinterMode\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(stdout)
    if (!m) return null
    return parseInt(m[1]!, 16) === 0
  } catch (e) {
    // Brak wartości w rejestrze = ustawienie fabryczne Windows 10/11, czyli „zarządzaj” włączone.
    return /nie można odnaleźć|unable to find|kod wyjścia 1\b/i.test((e as Error).message) ? true : null
  }
}

/** Stan programu podawany przez main.ts (bez tokenu). */
export interface StanProgramu {
  stanowisko?: string
  /** Sam origin serwera, np. https://kompletor.pl. */
  serwer?: string
  /** Program czeka na ustawienia (brak pliku albo błąd w nim). */
  bladKonfiguracji?: string
  polaczenie?: { ostatniKontakt?: Date; bladOd?: Date; blad?: string; wstrzymaneDo?: Date }
}

export interface ZaleznosciUstawien {
  plikKonfiguracji: string
  katalogProgramu: string
  plikLogu: () => string
  drukarki: () => Pick<Drukarki, 'stan' | 'drukujPdf'>
  stan: () => StanProgramu
  sprawdzKod: (k: KodInstalacyjny) => Promise<string | null>
  /** Ponowne wczytanie konfiguracji przez program (po zapisie). */
  przeladuj: () => void
  uruchomPonownie: () => void
  zarzadzanieDomyslna?: () => Promise<boolean | null>
  log: Log
}

class BladZadania extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** Plik konfiguracji jako obiekt (pusty, gdy brak albo uszkodzony) — do scalania przy zapisie. */
export function surowaKonfiguracja(plik: string): Record<string, unknown> {
  try {
    const j = JSON.parse(readFileSync(plik, 'utf8').replace(/^﻿/, '')) as unknown
    return typeof j === 'object' && j !== null && !Array.isArray(j) ? (j as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function zapiszKonfiguracje(plik: string, json: Record<string, unknown>) {
  // Plik tymczasowy + zamiana: przerwanie w połowie nie zostawi uciętego JSON-a.
  const tymczasowy = `${plik}.tmp`
  writeFileSync(tymczasowy, `${JSON.stringify(json, null, 2)}\n`, 'utf8')
  renameSync(tymczasowy, plik)
}

/** Komunikaty instalatora w słowach strony: „kod połączenia”, bez „tokenu”. */
export function poLudzku(t: string): string {
  if (t.startsWith('To jest sam token')) return 'To nie ten kod. Skopiuj z Kompletora kod połączenia, który zaczyna się od kmi_.'
  return t
    .replace(/kod(u)? instalacyjn(y|ego)/gi, (_, u) => (u ? 'kodu połączenia' : 'kod połączenia'))
    .replace(/Ustawienia → Wysyłka i druk → Druk → stanowisko → Nowy token/g, 'Ustawienia → Wysyłka i druk → Druk')
    .replace(/utwórz nowy token/gi, 'weź nowy kod')
    .replace(/tokenu/gi, 'kodu')
    .replace(/token(em)?/gi, 'kod')
}

async function czytajJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const kawalki: Buffer[] = []
  let razem = 0
  for await (const k of req) {
    razem += (k as Buffer).length
    if (razem > MAKS_TRESCI) throw new BladZadania(413, 'Za dużo danych.')
    kawalki.push(k as Buffer)
  }
  try {
    const j = JSON.parse(Buffer.concat(kawalki).toString('utf8')) as unknown
    if (typeof j === 'object' && j !== null && !Array.isArray(j)) return j as Record<string, unknown>
  } catch {
    // niżej
  }
  throw new BladZadania(400, 'Nieczytelne dane.')
}

type RodzajNaStronie = 'A4' | 'TERMICZNA' | 'POMIN'

/** Drukarka na liście strony: nazwa z Windows, stan prostym słowem, obecny przydział z konfiguracji. */
export interface DrukarkaNaStronie {
  numer: number
  nazwa: string
  stan: 'gotowa' | 'offline' | 'blad'
  opis?: string
  rodzaj: RodzajNaStronie
  /** 1 = główna, 2 = zapasowa, 3… = kolejna zapasowa (w obrębie rodzaju). */
  kolejnosc?: number
}

export function listaDrukarek(
  wWindows: { nazwa: string; status: string; offline: boolean; zleceniaWKolejce: number }[],
  mapa: MapaRol,
): { drukarki: DrukarkaNaStronie[]; brakujace: { nazwa: string; rodzaj: RodzajNaStronie }[] } {
  const przydzial = new Map<string, { rodzaj: RodzajNaStronie; kolejnosc: number }>()
  const liczniki = { A4: 0, TERMICZNA: 0 }
  for (const rola of roleZKonfiguracji(mapa)) {
    const rodzaj = jestTermiczna(rola) ? 'TERMICZNA' : 'A4'
    const n = mapa[rola]!.trim().toLowerCase()
    if (!przydzial.has(n)) przydzial.set(n, { rodzaj, kolejnosc: ++liczniki[rodzaj] })
  }
  const nazwy = [...new Map(wWindows.map((s) => [s.nazwa, s])).values()].sort((a, b) => a.nazwa.localeCompare(b.nazwa, 'pl'))
  const widziane = new Set<string>()
  const drukarki = nazwy.map((s, i): DrukarkaNaStronie => {
    widziane.add(s.nazwa.toLowerCase())
    const { stan, komunikat } = mapujStanWindows(s)
    const p = przydzial.get(s.nazwa.toLowerCase())
    return {
      numer: i + 1,
      nazwa: s.nazwa,
      stan: stan === 'DOSTEPNA' ? 'gotowa' : stan === 'OFFLINE' ? 'offline' : 'blad',
      ...(komunikat && !komunikat.startsWith('nieznany stan') ? { opis: komunikat } : {}),
      rodzaj: p?.rodzaj ?? 'POMIN',
      ...(p ? { kolejnosc: p.kolejnosc } : {}),
    }
  })
  const brakujace = [...przydzial.entries()]
    .filter(([n]) => !widziane.has(n))
    .map(([n, p]) => ({ nazwa: Object.values(mapa).find((v) => v?.trim().toLowerCase() === n)!.trim(), rodzaj: p.rodzaj }))
  return { drukarki, brakujace }
}

/** Serwer strony ustawień. `porty`: kolejne próby (0 = dowolny wolny, do testów). */
export async function uruchomSerwerUstawien(
  z: ZaleznosciUstawien,
  o: { porty: number[]; klucz: string },
): Promise<{ port: number; adres: string; zamknij: () => Promise<void> }> {
  let port = 0
  const serwer: Server = createServer((req, res) => {
    obsluz(req, res).catch((e: unknown) => {
      const status = e instanceof BladZadania ? e.status : 500
      if (status === 500) z.log.blad(`Strona ustawień: ${(e as Error).message}`)
      wyslij(res, status, { blad: e instanceof BladZadania ? e.message : 'Coś poszło nie tak. Spróbuj jeszcze raz.' })
    })
  })
  serwer.headersTimeout = 10_000
  serwer.requestTimeout = 60_000
  serwer.maxConnections = 16
  // Jeden wydruk próbny naraz: seria kliknięć nie uruchamia równolegle wielu PowerShelli i SumatraPDF.
  let probaWToku = false

  const wyslij = (res: ServerResponse, status: number, dane: unknown) => {
    if (res.headersSent) return
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(JSON.stringify(dane))
  }

  async function obsluz(req: IncomingMessage, res: ServerResponse) {
    const odmowa = sprawdzPochodzenie(req, port)
    if (odmowa) throw new BladZadania(403, 'Odmowa dostępu.')
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)

    // Strona: /u/<klucz>/ — klucz w ścieżce, potem skrypt strony bierze go z adresu i wysyła w nagłówku.
    if (req.method === 'GET' && url.pathname.startsWith('/u/')) {
      const [, , kluczZAdresu, ...reszta] = url.pathname.split('/')
      if (!rownyKlucz(kluczZAdresu, o.klucz) || reszta.join('/') !== '') throw new BladZadania(404, 'Nie ma takiej strony.')
      const nonce = randomBytes(16).toString('base64')
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
      })
      res.end(stronaUstawien(nonce))
      return
    }
    if (!url.pathname.startsWith('/api/')) throw new BladZadania(404, 'Nie ma takiej strony.')
    if (!rownyKlucz(req.headers[NAGLOWEK_KLUCZA] as string | undefined, o.klucz)) throw new BladZadania(403, 'Odmowa dostępu.')

    const trasa = `${req.method} ${url.pathname}`
    if (trasa === 'GET /api/stan') return wyslij(res, 200, await stanStrony())
    if (trasa === 'GET /api/drukarki') return wyslij(res, 200, await drukarkiStrony())
    if (trasa === 'POST /api/proba') return wyslij(res, 200, await proba(await czytajJson(req)))
    if (trasa === 'POST /api/zapisz') return wyslij(res, 200, await zapiszDrukarki(await czytajJson(req)))
    if (trasa === 'POST /api/polacz') return wyslij(res, 200, await polacz(await czytajJson(req)))
    if (trasa === 'POST /api/uruchom-ponownie') {
      await czytajJson(req)
      z.log.info('Ponowne uruchomienie programu ze strony ustawień')
      wyslij(res, 200, { ok: true })
      setTimeout(() => z.uruchomPonownie(), 300)
      return
    }
    throw new BladZadania(404, 'Nie ma takiej strony.')
  }

  async function stanStrony() {
    const s = z.stan()
    const log = podsumujLog(koncowkaPliku(z.plikLogu()))
    const teraz = Date.now()
    let polaczenie: Record<string, unknown>
    const p = s.polaczenie
    if (s.bladKonfiguracji) {
      const surowa = surowaKonfiguracja(z.plikKonfiguracji)
      const podlaczony = typeof surowa.token === 'string' && surowa.token.length > 0
      polaczenie = podlaczony
        ? { stan: 'ustawienia', opis: 'Program czeka na wybór drukarek.', podpowiedz: 'Wybierz niżej, do czego służy każda drukarka, i kliknij „Zapisz”.' }
        : { stan: 'niepodlaczony', opis: 'Program nie jest jeszcze podłączony do Kompletora.', podpowiedz: 'Wklej kod połączenia w „Podłącz do Kompletora”.' }
    } else if (p?.bladOd) {
      polaczenie = {
        stan: 'brak',
        bladOd: czasLokalny(p.bladOd),
        opis: `Brak połączenia z Kompletorem od ${czasLokalny(p.bladOd).slice(11, 16)}${dzien(p.bladOd, teraz)}.`,
        ...(podpowiedzDo(p.blad ?? 'brak połączenia') ? { podpowiedz: podpowiedzDo(p.blad ?? 'brak połączenia') } : {}),
      }
    } else if (p?.ostatniKontakt) {
      polaczenie = { stan: 'ok', ostatniKontakt: czasLokalny(p.ostatniKontakt), opis: 'Połączono z Kompletorem.' }
    } else polaczenie = { stan: 'czeka', opis: 'Łączę się z Kompletorem…' }
    return {
      wersja: WERSJA_AGENTA,
      ...(s.stanowisko ? { stanowisko: s.stanowisko } : {}),
      ...(s.serwer ? { serwer: s.serwer } : {}),
      polaczenie,
      ...(log.ostatniWydruk ? { ostatniWydruk: log.ostatniWydruk } : {}),
      ...(log.ostatniBlad ? { ostatniBlad: log.ostatniBlad } : {}),
      zdarzenia: log.zdarzenia,
      windowsZarzadzaDomyslna: z.zarzadzanieDomyslna ? await z.zarzadzanieDomyslna().catch(() => null) : null,
    }
  }

  async function drukarkiStrony() {
    const mapa = mapaZPliku()
    try {
      return listaDrukarek(await z.drukarki().stan(), mapa)
    } catch (e) {
      throw new BladZadania(503, `Nie udało się odczytać drukarek z Windows: ${(e as Error).message}`)
    }
  }

  function mapaZPliku(): MapaRol {
    const d = surowaKonfiguracja(z.plikKonfiguracji).drukarki
    if (typeof d !== 'object' || d === null || Array.isArray(d)) return {}
    return Object.fromEntries(Object.entries(d as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as MapaRol
  }

  async function proba(j: Record<string, unknown>) {
    if (probaWToku) throw new BladZadania(409, 'Poprzedni wydruk próbny jeszcze trwa. Poczekaj chwilę.')
    probaWToku = true
    try {
      const nazwa = typeof j.nazwa === 'string' ? j.nazwa : ''
      const drukarki = z.drukarki()
      const lista = listaDrukarek(await drukarki.stan(), {}).drukarki
      const d = lista.find((x) => x.nazwa === nazwa)
      if (!d) throw new BladZadania(400, 'Nie ma takiej drukarki w Windows. Odśwież stronę.')
      try {
        await wydrukujKartkeProbna(drukarki, d.nazwa, d.numer, 'strona')
      } catch (e) {
        throw new BladZadania(502, `Nie udało się wydrukować: ${(e as Error).message}`)
      }
      z.log.info(`Wydruk próbny ze strony ustawień na „${d.nazwa}”`)
      return { ok: true, numer: d.numer }
    } finally {
      probaWToku = false
    }
  }

  async function zapiszDrukarki(j: Record<string, unknown>) {
    const wybory = Array.isArray(j.drukarki) ? j.drukarki : null
    if (!wybory || wybory.length > 500) throw new BladZadania(400, 'Nieczytelna lista drukarek.')
    // Do pliku trafiają tylko nazwy z listy Windows (w jej pisowni): tekst z żądania nie idzie dalej do SumatraPDF,
    // zmiennych środowiska ani linii logu.
    let zWindows: Map<string, string>
    try {
      zWindows = new Map((await z.drukarki().stan()).map((d) => [d.nazwa.trim().toLowerCase(), d.nazwa]))
    } catch (e) {
      throw new BladZadania(503, `Nie udało się odczytać drukarek z Windows: ${(e as Error).message}`)
    }
    const lista: { nazwa: string; rodzaj: RodzajNaStronie }[] = []
    for (const w of wybory) {
      const o = (typeof w === 'object' && w !== null ? w : {}) as Record<string, unknown>
      if (typeof o.nazwa !== 'string' || o.nazwa.length > 300 || !['A4', 'TERMICZNA', 'POMIN'].includes(o.rodzaj as string))
        throw new BladZadania(400, 'Nieczytelna lista drukarek.')
      if (o.rodzaj === 'POMIN') continue
      const nazwa = zWindows.get(o.nazwa.trim().toLowerCase())
      if (!nazwa) throw new BladZadania(400, 'Jednej z wybranych drukarek nie ma w Windows. Odśwież stronę i wybierz jeszcze raz.')
      lista.push({ nazwa, rodzaj: o.rodzaj as RodzajNaStronie })
    }
    const surowa = surowaKonfiguracja(z.plikKonfiguracji)
    if (typeof surowa.token !== 'string' || !surowa.token) throw new BladZadania(400, 'Najpierw podłącz program do Kompletora (kod połączenia niżej).')
    let mapa: MapaRol
    try {
      mapa = przydzielRole(lista)
    } catch (e) {
      throw new BladZadania(400, (e as Error).message)
    }
    if (Object.keys(mapa).length === 0) throw new BladZadania(400, 'Wybierz co najmniej jedną drukarkę: kartki A4 albo etykiety.')
    const nowa = { ...surowa, drukarki: mapa }
    try {
      sprawdzKonfiguracje(nowa, z.katalogProgramu)
    } catch (e) {
      throw new BladZadania(400, e instanceof BladKonfiguracji ? `Ustawień nie zapisano: ${e.bledy.join('; ')}` : 'Ustawień nie zapisano.')
    }
    zapiszKonfiguracje(z.plikKonfiguracji, nowa)
    z.log.info('Zapisano wybór drukarek ze strony ustawień', { drukarki: mapa })
    z.przeladuj()
    return { ok: true }
  }

  async function polacz(j: Record<string, unknown>) {
    let kod: KodInstalacyjny
    try {
      kod = dekodujKodInstalacyjny(typeof j.kod === 'string' ? j.kod.slice(0, 4000) : '')
    } catch (e) {
      throw new BladZadania(400, poLudzku(e instanceof BladInstalacji ? e.message : 'Kod połączenia jest uszkodzony.'))
    }
    const blad = await z.sprawdzKod(kod)
    if (blad) throw new BladZadania(400, poLudzku(blad))
    const surowa = surowaKonfiguracja(z.plikKonfiguracji)
    const nowa: Record<string, unknown> = { ...surowa, serwer: kod.serwer, token: kod.token, stanowisko: kod.stanowisko }
    if (typeof nowa.drukarki !== 'object' || nowa.drukarki === null) nowa.drukarki = {}
    zapiszKonfiguracje(z.plikKonfiguracji, nowa)
    const origin = new URL(kod.serwer).origin
    z.log.info(`Podłączono do Kompletora ze strony ustawień: stanowisko „${kod.stanowisko}” na ${origin}`)
    z.przeladuj()
    return { ok: true, stanowisko: kod.stanowisko, serwer: origin }
  }

  for (const p of o.porty) {
    try {
      await new Promise<void>((ok, nie) => {
        serwer.once('error', nie)
        serwer.listen(p, '127.0.0.1', () => {
          serwer.off('error', nie)
          ok()
        })
      })
      port = (serwer.address() as AddressInfo).port
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e
    }
  }
  if (!port) throw new Error(`porty strony ustawień zajęte: ${o.porty.join(', ')}`)
  return {
    port,
    adres: `http://127.0.0.1:${port}/u/${o.klucz}/`,
    zamknij: () =>
      new Promise((r) => {
        serwer.close(() => r())
        serwer.closeAllConnections()
      }),
  }
}

function dzien(d: Date, teraz: number): string {
  const dzis = new Date(teraz)
  return d.toDateString() === dzis.toDateString() ? '' : ` (${czasLokalny(d).slice(8, 10)}.${czasLokalny(d).slice(5, 7)})`
}

/** Zapis adresu strony do dane\ — dla skrótu i instalatora. */
export function zapiszAdres(katalogDanych: string, adres: string) {
  mkdirSync(katalogDanych, { recursive: true })
  writeFileSync(join(katalogDanych, PLIK_ADRESU), adres, 'utf8')
}

/** Przy zwykłym zakończeniu programu: skrót nie wyśle starego adresu z kluczem do procesu, który zajmie port. */
export function wyczyscAdres(katalogDanych: string) {
  try {
    writeFileSync(join(katalogDanych, PLIK_ADRESU), '', 'utf8')
  } catch {
    // skrót i tak sprawdza, czy strona odpowiada
  }
}
