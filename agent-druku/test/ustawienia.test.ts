// Strona ustawień: prawdziwy serwer HTTP na 127.0.0.1 (port wolny), atrapy drukarek i sprawdzania kodu.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { zakodujKodInstalacyjny } from '../src/instalacja.js'
import { BladKonfiguracji, bezDrukarek } from '../src/konfiguracja.js'
import { LogPlikowy } from '../src/log.js'
import { powtarzaj, sciezkiZPliku } from '../src/main.js'
import type { StanProgramu } from '../src/ustawienia.js'
import {
  OKNO_ZACHOWANIA_KLUCZA_MS,
  PLIK_ADRESU,
  czyWindowsZarzadzaDomyslna,
  kluczUstawien,
  listaDrukarek,
  poLudzku,
  sprawdzPochodzenie,
  uruchomSerwerUstawien,
  wyczyscAdres,
  zachowajKluczPrzyRestarcie,
  zapiszAdres,
} from '../src/ustawienia.js'
import { podsumujLog, ukryjSekrety, zdarzenieZLinii } from '../src/zdarzenia.js'
import { AtrapaDrukarek } from './atrapy.js'

const TOKEN_STANOWISKA = 'kmd_' + 'Q'.repeat(20) + 'w'.repeat(23)
const KOD = zakodujKodInstalacyjny({ serwer: 'https://kompletor.example.pl', stanowisko: 'magazyn-1', token: TOKEN_STANOWISKA })

interface Odp {
  status: number
  naglowki: Record<string, string | string[] | undefined>
  tekst: string
}

function zadanie(port: number, sciezka: string, o: { metoda?: string; naglowki?: Record<string, string>; cialo?: string } = {}): Promise<Odp> {
  return new Promise((ok, nie) => {
    const r = request({ host: '127.0.0.1', port, path: sciezka, method: o.metoda ?? 'GET', headers: { Host: `127.0.0.1:${port}`, ...o.naglowki } }, (res) => {
      const k: Buffer[] = []
      res.on('data', (d: Buffer) => k.push(d))
      res.on('end', () => ok({ status: res.statusCode ?? 0, naglowki: res.headers, tekst: Buffer.concat(k).toString('utf8') }))
    })
    r.on('error', nie)
    if (o.cialo) r.write(o.cialo)
    r.end()
  })
}

const zamykane: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(zamykane.splice(0).map((z) => z()))
})

async function uruchom(o: { konfig?: Record<string, unknown>; bladKodu?: string; stan?: StanProgramu } = {}) {
  const katalog = mkdtempSync(join(tmpdir(), 'ustawienia-'))
  const plikKonfiguracji = join(katalog, 'agent-druku.json')
  if (o.konfig) writeFileSync(plikKonfiguracji, JSON.stringify(o.konfig))
  const plikLogu = join(katalog, 'logi', 'agent-druku.log')
  const log = new LogPlikowy({ plik: plikLogu, maksBajtow: 1 << 20, plikow: 1 })
  const drukarki = new AtrapaDrukarek()
  const zdarzenia = { przeladowania: 0, restarty: 0, sprawdzoneKody: 0 }
  const klucz = kluczUstawien(join(katalog, 'dane'))
  const s = await uruchomSerwerUstawien(
    {
      plikKonfiguracji,
      katalogProgramu: katalog,
      plikLogu: () => plikLogu,
      drukarki: () => drukarki,
      stan: () => o.stan ?? {},
      sprawdzKod: async () => {
        zdarzenia.sprawdzoneKody++
        return o.bladKodu ?? null
      },
      przeladuj: () => zdarzenia.przeladowania++,
      uruchomPonownie: () => zdarzenia.restarty++,
      zarzadzanieDomyslna: async () => true,
      log,
    },
    { porty: [0], klucz },
  )
  zamykane.push(s.zamknij)
  const api = (metoda: string, sciezka: string, dane?: unknown, dodatkowe: Record<string, string> = {}) =>
    zadanie(s.port, `/api/${sciezka}`, {
      metoda,
      naglowki: {
        'X-Kompletor-Klucz': klucz,
        ...(dane !== undefined ? { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${s.port}` } : {}),
        ...dodatkowe,
      },
      ...(dane !== undefined ? { cialo: JSON.stringify(dane) } : {}),
    })
  return { ...s, klucz, katalog, plikKonfiguracji, plikLogu, drukarki, zdarzenia, api }
}

describe('ochrona strony ustawień', () => {
  it('nasłuch tylko na 127.0.0.1, adres z kluczem', async () => {
    const s = await uruchom()
    expect(s.adres).toBe(`http://127.0.0.1:${s.port}/u/${s.klucz}/`)
    expect(s.klucz).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('strona tylko z prawidłowym kluczem w adresie, z nagłówkami bezpieczeństwa', async () => {
    const s = await uruchom()
    expect((await zadanie(s.port, '/')).status).toBe(404)
    expect((await zadanie(s.port, `/u/${'x'.repeat(43)}/`)).status).toBe(404)
    expect((await zadanie(s.port, `/u/${s.klucz}/inne`)).status).toBe(404)
    const ok = await zadanie(s.port, `/u/${s.klucz}/`)
    expect(ok.status).toBe(200)
    expect(ok.tekst).toContain('Kompletor Druk (ustawienia)')
    expect(String(ok.naglowki['content-security-policy'])).toMatch(/default-src 'none'; script-src 'nonce-[^']+'/)
    expect(ok.naglowki['referrer-policy']).toBe('no-referrer')
    expect(ok.naglowki['x-frame-options']).toBe('DENY')
    expect(ok.tekst).not.toContain(s.klucz) // klucz bierze skrypt z adresu, nie z treści strony
  })

  it('API bez klucza albo z cudzym Host / Origin = 403', async () => {
    const s = await uruchom()
    expect((await zadanie(s.port, '/api/stan')).status).toBe(403)
    expect((await zadanie(s.port, '/api/stan', { naglowki: { 'X-Kompletor-Klucz': 'zly' } })).status).toBe(403)
    // podmiana DNS: przeglądarka wysyła Host obcej domeny
    expect((await zadanie(s.port, '/api/stan', { naglowki: { 'X-Kompletor-Klucz': s.klucz, Host: 'zly.example.com' } })).status).toBe(403)
    expect((await zadanie(s.port, `/u/${s.klucz}/`, { naglowki: { Host: `zly.example.com:${s.port}` } })).status).toBe(403)
    expect((await s.api('GET', 'stan', undefined, { Origin: 'https://zly.example.com' })).status).toBe(403)
    expect((await s.api('GET', 'stan', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403)
    expect((await s.api('GET', 'stan')).status).toBe(200)
    // tylko 127.0.0.1: nazwa localhost też odrzucona (nasłuch wyłącznie na IPv4, adres strony zawsze z 127.0.0.1)
    expect((await zadanie(s.port, '/api/stan', { naglowki: { 'X-Kompletor-Klucz': s.klucz, Host: `localhost:${s.port}` } })).status).toBe(403)
    expect((await s.api('GET', 'stan', undefined, { Origin: `http://localhost:${s.port}` })).status).toBe(403)
  })

  it('zmiany tylko JSON-em z naszego Origin', async () => {
    const s = await uruchom()
    const cialo = JSON.stringify({ kod: KOD })
    const bezOrigin = await zadanie(s.port, '/api/polacz', { metoda: 'POST', naglowki: { 'X-Kompletor-Klucz': s.klucz, 'Content-Type': 'application/json' }, cialo })
    expect(bezOrigin.status).toBe(403)
    const tekstem = await zadanie(s.port, '/api/polacz', {
      metoda: 'POST',
      naglowki: { 'X-Kompletor-Klucz': s.klucz, 'Content-Type': 'text/plain', Origin: `http://127.0.0.1:${s.port}` },
      cialo,
    })
    expect(tekstem.status).toBe(403)
    expect(s.zdarzenia.sprawdzoneKody).toBe(0)
  })

  it('sprawdzPochodzenie: reguły bez serwera', () => {
    const h = (headers: Record<string, string>, method = 'GET') => sprawdzPochodzenie({ headers, method }, 5000)
    expect(h({ host: '127.0.0.1:5000' })).toBeNull()
    expect(h({ host: '127.0.0.1:5001' })).not.toBeNull()
    expect(h({ host: '127.0.0.1:5000', origin: 'null' })).not.toBeNull()
    expect(h({ host: '127.0.0.1:5000', 'sec-fetch-site': 'same-site' })).not.toBeNull()
    expect(h({ host: '127.0.0.1:5000', origin: 'http://127.0.0.1:5000', 'content-type': 'application/json; charset=utf-8' }, 'POST')).toBeNull()
    expect(h({ host: 'localhost:5000', origin: 'http://localhost:5000', 'content-type': 'application/json; charset=utf-8' }, 'POST')).not.toBeNull()
  })

  it('klucz: nowy przy każdym starcie; ten sam tylko raz, do 2 minut po „Uruchom ponownie”', () => {
    const k = mkdtempSync(join(tmpdir(), 'klucz-'))
    const t0 = 1_000_000_000_000
    const a = kluczUstawien(k, t0)
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(readFileSync(join(k, 'ustawienia-klucz.txt'), 'utf8')).toBe(a)
    const b = kluczUstawien(k, t0 + 1000)
    expect(b).not.toBe(a) // zwykły start = nowy klucz, stary adres z historii przeglądarki przestaje działać
    zachowajKluczPrzyRestarcie(k, t0 + 2000)
    expect(kluczUstawien(k, t0 + 3000)).toBe(b) // szybki restart ze strony: otwarta karta działa dalej
    expect(kluczUstawien(k, t0 + 4000)).not.toBe(b) // znacznik działa raz
    const c = kluczUstawien(k, t0 + 5000)
    zachowajKluczPrzyRestarcie(k, t0 + 6000)
    expect(kluczUstawien(k, t0 + 6000 + OKNO_ZACHOWANIA_KLUCZA_MS)).not.toBe(c) // za późno = nowy
    const d = kluczUstawien(k, t0 + 7_000_000)
    zachowajKluczPrzyRestarcie(k, t0 + 7_000_000)
    writeFileSync(join(k, 'ustawienia-klucz.txt'), 'krotki') // uszkodzony plik nawet po restarcie = nowy klucz
    const e = kluczUstawien(k, t0 + 7_000_500)
    expect(e).not.toBe(d)
    expect(e).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('zwykłe zakończenie czyści adres strony (skrót nie wyśle klucza procesowi, który zajmie port)', () => {
    const k = mkdtempSync(join(tmpdir(), 'adres-'))
    zapiszAdres(k, 'http://127.0.0.1:47631/u/' + 'k'.repeat(43) + '/')
    wyczyscAdres(k)
    expect(readFileSync(join(k, PLIK_ADRESU), 'utf8')).toBe('')
  })
})

describe('podłączenie kodem', () => {
  it('zapisuje adres, stanowisko i token, zostawia drukarki; kod ani token nie wracają i nie trafiają do logu', async () => {
    const s = await uruchom({ konfig: { drukarki: { A4: 'Brother A4' }, odpytywanieSekundy: 7 } })
    const odp = await s.api('POST', 'polacz', { kod: `  ${KOD}\n` })
    expect(odp.status).toBe(200)
    expect(JSON.parse(odp.tekst)).toEqual({ ok: true, stanowisko: 'magazyn-1', serwer: 'https://kompletor.example.pl' })
    expect(odp.tekst).not.toContain(TOKEN_STANOWISKA)
    expect(odp.tekst).not.toContain('kmi_')
    const zapisana = JSON.parse(readFileSync(s.plikKonfiguracji, 'utf8'))
    expect(zapisana).toEqual({ drukarki: { A4: 'Brother A4' }, odpytywanieSekundy: 7, serwer: 'https://kompletor.example.pl', token: TOKEN_STANOWISKA, stanowisko: 'magazyn-1' })
    expect(s.zdarzenia.przeladowania).toBe(1)
    const log = readFileSync(s.plikLogu, 'utf8')
    expect(log).toContain('Podłączono do Kompletora')
    expect(log).not.toContain(TOKEN_STANOWISKA)
    expect(log).not.toContain(KOD)
    const stan = await s.api('GET', 'stan')
    expect(stan.tekst).not.toContain(TOKEN_STANOWISKA)
  })

  it('odrzucony kod: czytelny komunikat bez słowa „token”, plik nietknięty', async () => {
    const s = await uruchom({ bladKodu: 'Serwer nie przyjął kodu: token jest nieważny (unieważniony). Utwórz nowy token w panelu.' })
    const odp = await s.api('POST', 'polacz', { kod: KOD })
    expect(odp.status).toBe(400)
    const { blad } = JSON.parse(odp.tekst)
    expect(blad).toContain('kod jest nieważny')
    expect(blad).not.toMatch(/token/i)
    expect(odp.tekst).not.toContain(TOKEN_STANOWISKA)
    expect(() => readFileSync(s.plikKonfiguracji)).toThrow()
    expect(s.zdarzenia.przeladowania).toBe(0)
  })

  it('śmieci zamiast kodu: 400 bez pytania serwera', async () => {
    const s = await uruchom()
    const odp = await s.api('POST', 'polacz', { kod: 'abc' })
    expect(odp.status).toBe(400)
    expect(JSON.parse(odp.tekst).blad).toContain('kmi_')
    expect(s.zdarzenia.sprawdzoneKody).toBe(0)
    expect(poLudzku('To jest sam token stanowiska, a potrzebny jest kod instalacyjny')).not.toMatch(/token/i)
  })
})

describe('drukarki na stronie', () => {
  const konfig = { serwer: 'https://kompletor.example.pl', token: TOKEN_STANOWISKA, stanowisko: 'magazyn-1', drukarki: { A4: 'Brother A4', TERMICZNA_1: 'Termiczna 2', TERMICZNA_2: 'Zniknęła' } }

  it('lista z Windows z przydziałem, kolejnością i brakującymi', async () => {
    const s = await uruchom({ konfig })
    s.drukarki.stany.push({ nazwa: 'Biuro', status: 'PaperOut', offline: false, zleceniaWKolejce: 0 })
    const j = JSON.parse((await s.api('GET', 'drukarki')).tekst)
    expect(j.drukarki).toEqual([
      { numer: 1, nazwa: 'Biuro', stan: 'blad', opis: 'brak papieru lub etykiet', rodzaj: 'POMIN' },
      { numer: 2, nazwa: 'Brother A4', stan: 'gotowa', rodzaj: 'A4', kolejnosc: 1 },
      { numer: 3, nazwa: 'Termiczna 1', stan: 'gotowa', rodzaj: 'POMIN' },
      { numer: 4, nazwa: 'Termiczna 2', stan: 'gotowa', rodzaj: 'TERMICZNA', kolejnosc: 1 },
    ])
    expect(j.brakujace).toEqual([{ nazwa: 'Zniknęła', rodzaj: 'TERMICZNA' }])
  })

  it('zapis: kolejność z listy = główna i zapasowa, reszta pliku bez zmian, przeładowanie', async () => {
    const s = await uruchom({ konfig: { ...konfig, odpytywanieSekundy: 9 } })
    const odp = await s.api('POST', 'zapisz', {
      drukarki: [
        { nazwa: 'Termiczna 2', rodzaj: 'TERMICZNA' },
        { nazwa: 'Termiczna 1', rodzaj: 'TERMICZNA' },
        { nazwa: 'Brother A4', rodzaj: 'A4' },
        { nazwa: 'Biuro', rodzaj: 'POMIN' },
      ],
    })
    expect(odp.status).toBe(200)
    const z = JSON.parse(readFileSync(s.plikKonfiguracji, 'utf8'))
    expect(z.drukarki).toEqual({ TERMICZNA_1: 'Termiczna 2', TERMICZNA_2: 'Termiczna 1', A4: 'Brother A4' })
    expect(z.token).toBe(TOKEN_STANOWISKA)
    expect(z.odpytywanieSekundy).toBe(9)
    expect(s.zdarzenia.przeladowania).toBe(1)
    expect(readFileSync(s.plikLogu, 'utf8')).not.toContain(TOKEN_STANOWISKA)
  })

  it('zapis bez podłączenia albo bez żadnej drukarki = 400, plik nietknięty', async () => {
    const bez = await uruchom({ konfig: { drukarki: {} } })
    expect((await bez.api('POST', 'zapisz', { drukarki: [{ nazwa: 'Brother A4', rodzaj: 'A4' }] })).status).toBe(400)
    const s = await uruchom({ konfig })
    const przed = readFileSync(s.plikKonfiguracji, 'utf8')
    const odp = await s.api('POST', 'zapisz', { drukarki: [{ nazwa: 'Brother A4', rodzaj: 'POMIN' }] })
    expect(odp.status).toBe(400)
    expect(JSON.parse(odp.tekst).blad).toContain('co najmniej jedną')
    expect((await s.api('POST', 'zapisz', { drukarki: [{ nazwa: 'X', rodzaj: 'ZLY' }] })).status).toBe(400)
    expect(readFileSync(s.plikKonfiguracji, 'utf8')).toBe(przed)
    expect(s.zdarzenia.przeladowania).toBe(0)
  })

  it('zapis: tylko drukarki z listy Windows, w pisowni z Windows; obca nazwa albo z nową linią = 400, plik nietknięty', async () => {
    const s = await uruchom({ konfig })
    const przed = readFileSync(s.plikKonfiguracji, 'utf8')
    for (const nazwa of ['Nie ma takiej', 'Brother A4\n2026-11-10 12:00:00 INFO Wydrukowano', '\\\\serwer\\obca'])
      expect((await s.api('POST', 'zapisz', { drukarki: [{ nazwa, rodzaj: 'A4' }] })).status).toBe(400)
    expect(readFileSync(s.plikKonfiguracji, 'utf8')).toBe(przed)
    expect(s.zdarzenia.przeladowania).toBe(0)
    const ok = await s.api('POST', 'zapisz', { drukarki: [{ nazwa: '  brother a4 ', rodzaj: 'A4' }, { nazwa: 'Spoza listy', rodzaj: 'POMIN' }] })
    expect(ok.status).toBe(200)
    expect(JSON.parse(readFileSync(s.plikKonfiguracji, 'utf8')).drukarki).toEqual({ A4: 'Brother A4' })
  })

  it('zapis: Windows nie podał listy drukarek = 503, plik nietknięty', async () => {
    const s = await uruchom({ konfig })
    const przed = readFileSync(s.plikKonfiguracji, 'utf8')
    s.drukarki.bladStanu = new Error('usługa wydruku nie odpowiada')
    expect((await s.api('POST', 'zapisz', { drukarki: [{ nazwa: 'Brother A4', rodzaj: 'A4' }] })).status).toBe(503)
    expect(readFileSync(s.plikKonfiguracji, 'utf8')).toBe(przed)
  })

  it('wydruk próbny: jeden naraz, drugi w trakcie = 409, potem znowu można', async () => {
    const s = await uruchom({ konfig })
    let pusc!: () => void
    const czekaj = new Promise<void>((r) => (pusc = r))
    let weszlo = false
    const oryginal = s.drukarki.stan.bind(s.drukarki)
    s.drukarki.stan = async () => {
      weszlo = true
      await czekaj
      return oryginal()
    }
    const pierwsza = s.api('POST', 'proba', { nazwa: 'Termiczna 1' })
    for (let i = 0; i < 200 && !weszlo; i++) await new Promise((r) => setTimeout(r, 10))
    expect(weszlo).toBe(true)
    const druga = await s.api('POST', 'proba', { nazwa: 'Brother A4' })
    expect(druga.status).toBe(409)
    pusc()
    expect((await pierwsza).status).toBe(200)
    expect((await s.api('POST', 'proba', { nazwa: 'Brother A4' })).status).toBe(200)
    expect(s.drukarki.wydruki.map((w) => w.drukarka)).toEqual(['Termiczna 1', 'Brother A4'])
  })

  it('wydruk próbny tylko na drukarce z Windows, z numerem z listy', async () => {
    const s = await uruchom({ konfig })
    const ok = await s.api('POST', 'proba', { nazwa: 'Termiczna 1' })
    expect(JSON.parse(ok.tekst)).toEqual({ ok: true, numer: 2 })
    expect(s.drukarki.wydruki).toHaveLength(1)
    expect(s.drukarki.wydruki[0]).toMatchObject({ rodzaj: 'pdf', drukarka: 'Termiczna 1', skalowanie: 'fit' })
    expect((await s.api('POST', 'proba', { nazwa: 'C:\\zly' })).status).toBe(400)
    expect(s.drukarki.wydruki).toHaveLength(1)
  })

  it('listaDrukarek: duplikat nazwy w konfiguracji liczony raz', () => {
    const { drukarki } = listaDrukarek([{ nazwa: 'A', status: 'Normal', offline: true, zleceniaWKolejce: 0 }], { A4: 'A', A4_2: 'a' })
    expect(drukarki).toEqual([{ numer: 1, nazwa: 'A', stan: 'offline', opis: 'drukarka offline (wyłączona lub odłączona)', rodzaj: 'A4', kolejnosc: 1 }])
  })
})

describe('stan i zdarzenia', () => {
  it('niepodłączony program: zdanie dla człowieka i ostrzeżenie o drukarce domyślnej', async () => {
    const s = await uruchom({ stan: { bladKonfiguracji: 'brak pliku' } })
    const j = JSON.parse((await s.api('GET', 'stan')).tekst)
    expect(j.polaczenie.stan).toBe('niepodlaczony')
    expect(j.windowsZarzadzaDomyslna).toBe(true)
  })

  it('brak połączenia od godziny z podpowiedzią; ostatni wydruk i błąd z logu', async () => {
    const s = await uruchom({ stan: { stanowisko: 'm1', serwer: 'https://k.pl', polaczenie: { bladOd: new Date(), blad: 'Brak połączenia z serwerem (k.pl): fetch failed' } } })
    writeFileSync(
      s.plikLogu,
      [
        '2026-11-10 10:00:00 INFO  Start agenta druku 0.2.0 {"x":1}',
        '2026-11-10 10:01:00 INFO  Wydrukowano etykieta Z-1 (zpl, 1 szt.) na „Zebra”',
        '2026-11-10 10:02:00 BLAD  Zlecenie Z-2: Drukarka „Zebra” (TERMICZNA_1): brak papieru lub etykiet {"rolaZapasowa":"A4"}',
        '2026-11-10 10:03:00 INFO  Cykl zleceń {"pobrane":1}',
      ].join('\n') + '\n',
    )
    const j = JSON.parse((await s.api('GET', 'stan')).tekst)
    expect(j.polaczenie.stan).toBe('brak')
    expect(j.polaczenie.opis).toMatch(/^Brak połączenia z Kompletorem od \d\d:\d\d\.$/)
    expect(j.polaczenie.podpowiedz).toContain('internet')
    expect(j.ostatniWydruk.tekst).toBe('Wydrukowano etykietę na drukarce „Zebra”.')
    expect(j.ostatniBlad.podpowiedz).toContain('Włóż papier')
    expect(j.zdarzenia).toHaveLength(3)
    expect(j.zdarzenia[0].tekst).toContain('Wydruk nie wyszedł')
    expect(JSON.stringify(j)).not.toContain('rolaZapasowa')
  })

  it('tłumaczenie linii i ukrywanie kodów', () => {
    expect(zdarzenieZLinii('śmieci')).toBeNull()
    expect(zdarzenieZLinii('2026-11-10 10:00:00 INFO  Start agenta druku 0.2.0')!.tekst).toBe('Program uruchomiony (wersja 0.2.0).')
    const z = zdarzenieZLinii(`2026-11-10 10:00:00 UWAGA Nie udało się pobrać zleceń: Bearer ${TOKEN_STANOWISKA} ${KOD}`)!
    expect(z.tekst).not.toContain(TOKEN_STANOWISKA)
    expect(z.tekst).not.toContain('kmi_')
    expect(ukryjSekrety(`token=${TOKEN_STANOWISKA}`)).toBe('token=•••')
    expect(podsumujLog(Array.from({ length: 30 }, (_, i) => `2026-11-10 10:00:${String(i).padStart(2, '0')} INFO  Połączenie z serwerem wróciło`)).zdarzenia).toHaveLength(20)
  })

  it('stary błąd znika ze stanu po udanym wydruku; „agenta druku” po ludzku', () => {
    const blad = '2026-11-10 10:00:00 BLAD  Błędna konfiguracja agenta druku: sekcja „drukarki” nie ma żadnej drukarki'
    expect(zdarzenieZLinii(blad)!.tekst).toBe('Błędna konfiguracja programu: sekcja „drukarki” nie ma żadnej drukarki')
    const poWydruku = podsumujLog([blad, '2026-11-10 10:01:00 INFO  Wydrukowano karta Z-1 (pdf, 1 szt.) na „A4”'])
    expect(poWydruku.ostatniBlad).toBeUndefined()
    expect(poWydruku.zdarzenia).toHaveLength(2)
    const poWczytaniu = podsumujLog([blad, '2026-11-10 10:01:00 INFO  Konfiguracja wczytana'])
    expect(poWczytaniu.ostatniBlad).toBeUndefined()
    const swiezy = podsumujLog(['2026-11-10 10:01:00 INFO  Konfiguracja wczytana', blad])
    expect(swiezy.ostatniBlad?.czas).toBe('2026-11-10 10:00:00')
  })

  it('podłączony bez drukarek to nie błąd, inne braki tak', () => {
    expect(bezDrukarek(new BladKonfiguracji(['sekcja „drukarki” nie ma żadnej drukarki']).message)).toBe(true)
    expect(bezDrukarek(new BladKonfiguracji(['sekcja „drukarki” nie ma żadnej drukarki', 'brak „token”']).message)).toBe(false)
    expect(bezDrukarek(new BladKonfiguracji(['brak „token”']).message)).toBe(false)
  })

  it('ponowne uruchomienie: odpowiedź, potem wywołanie', async () => {
    const s = await uruchom()
    expect((await s.api('POST', 'uruchom-ponownie', {})).status).toBe(200)
    await new Promise((r) => setTimeout(r, 400))
    expect(s.zdarzenia.restarty).toBe(1)
  })
})

describe('pomocnicze', () => {
  it('ustawienie Windows „zarządzaj drukarką domyślną” z rejestru', async () => {
    const wynik = (stdout: string) => async () => ({ stdout, stderr: '' })
    expect(await czyWindowsZarzadzaDomyslna(wynik('    LegacyDefaultPrinterMode    REG_DWORD    0x0\r\n'))).toBe(true)
    expect(await czyWindowsZarzadzaDomyslna(wynik('    LegacyDefaultPrinterMode    REG_DWORD    0x1\r\n'))).toBe(false)
    expect(await czyWindowsZarzadzaDomyslna(async () => { throw new Error('kod wyjścia 1: BŁĄD: System nie może odnaleźć określonego klucza') })).toBe(true)
    expect(await czyWindowsZarzadzaDomyslna(async () => { throw new Error('przekroczony czas 5 s') })).toBeNull()
  })

  it('ścieżki i port z uszkodzonego pliku = domyślne', () => {
    const k = mkdtempSync(join(tmpdir(), 'sciezki-'))
    writeFileSync(join(k, 'a.json'), '{zly')
    expect(sciezkiZPliku(join(k, 'a.json'), k)).toEqual({ katalogDanych: join(k, 'dane'), katalogLogow: join(k, 'logi'), port: 47631 })
    writeFileSync(join(k, 'b.json'), JSON.stringify({ portUstawien: 50000, katalogDanych: 'inne' }))
    expect(sciezkiZPliku(join(k, 'b.json'), k)).toMatchObject({ katalogDanych: join(k, 'inne'), port: 50000 })
  })

  it('powtarzaj po przerwaniu czeka na dokończenie kroku w toku', async () => {
    const stop = new AbortController()
    let skonczony = false
    const petla = powtarzaj(async () => {
      await new Promise((r) => setTimeout(r, 50))
      skonczony = true
    }, 10, stop.signal)
    await new Promise((r) => setTimeout(r, 10))
    stop.abort()
    await petla
    expect(skonczony).toBe(true)
  })
})
