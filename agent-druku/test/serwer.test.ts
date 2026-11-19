// Atrapa serwera Kompletora na 127.0.0.1 — prawdziwy HTTP, bez prawdziwego serwera.
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { BladSerwera, KlientSerwera, sekundyRetryAfter } from '../src/serwer.js'
import { PDF } from './atrapy.js'

const TOKEN = 'token-testowy-0123456789abcdef'

interface Zadanie {
  metoda: string
  url: string
  autoryzacja?: string
  cialo: string
}

const serwery: Server[] = []
afterEach(async () => {
  await Promise.all(serwery.splice(0).map((s) => new Promise((r) => s.close(r))))
})

interface Odpowiedz {
  status?: number
  json?: unknown
  dane?: Buffer
  opoznienieMs?: number
  naglowki?: Record<string, string>
  /** Treść wysyłana kawałkami bez Content-Length (Transfer-Encoding: chunked). */
  kawalki?: Buffer[]
}

async function atrapa(obsluz: (z: Zadanie) => Odpowiedz) {
  const zadania: Zadanie[] = []
  const serwer = createServer(async (req: IncomingMessage, res) => {
    let cialo = ''
    for await (const c of req) cialo += c
    const z = { metoda: req.method!, url: req.url!, autoryzacja: req.headers.authorization, cialo }
    zadania.push(z)
    const o = obsluz(z)
    if (o.opoznienieMs) await new Promise((r) => setTimeout(r, o.opoznienieMs))
    res.statusCode = o.status ?? 200
    for (const [k, v] of Object.entries(o.naglowki ?? {})) res.setHeader(k, v)
    if (o.kawalki) {
      for (const k of o.kawalki) {
        if (!res.write(k)) await new Promise((r) => res.once('drain', r))
        if (res.destroyed) return
      }
      res.end()
    } else if (o.dane) res.end(o.dane)
    else res.setHeader('content-type', 'application/json').end(JSON.stringify(o.json ?? {}))
  })
  serwery.push(serwer)
  await new Promise<void>((r) => serwer.listen(0, '127.0.0.1', r))
  return { adres: `http://127.0.0.1:${(serwer.address() as AddressInfo).port}`, zadania }
}

const klient = (adres: string, timeoutMs = 2000, dozwoloneHostyPlikow: string[] = []) =>
  new KlientSerwera({ serwer: adres, token: TOKEN, stanowisko: 'magazyn-1', timeoutMs, dozwoloneHostyPlikow })

describe('klient serwera (atrapa HTTP)', () => {
  it('GET zleceń z parametrem stanowiska i tokenem Bearer', async () => {
    const s = await atrapa(() => ({
      json: { zlecenia: [{ id: 'Z-1', typ: 'karta', format: 'pdf', rola: 'A4', plikUrl: '/pliki/Z-1', kopie: 1 }] },
    }))
    const w = await klient(s.adres).pobierzZlecenia()
    expect(w.poprawne.map((z) => z.id)).toEqual(['Z-1'])
    expect(s.zadania[0]).toMatchObject({ metoda: 'GET', url: '/api/druk/zlecenia?stanowisko=magazyn-1', autoryzacja: `Bearer ${TOKEN}` })
  })

  it('serwer pod ścieżką (np. /kompletor) — adresy względne od niej', async () => {
    const s = await atrapa(() => ({ json: { zlecenia: [] } }))
    await klient(`${s.adres}/kompletor`).pobierzZlecenia()
    expect(s.zadania[0]!.url).toBe('/kompletor/api/druk/zlecenia?stanowisko=magazyn-1')
  })

  it('POST wyniku i stanu jako JSON', async () => {
    const s = await atrapa(() => ({ json: { ok: true } }))
    const k = klient(s.adres)
    await k.wyslijWynik('Z-1', { stanowisko: 'magazyn-1', wynik: 'OK', rola: 'A4', ponowienieRaportu: false, czas: '2026-10-25T10:00:00.000Z' })
    await k.wyslijStan({ stanowisko: 'magazyn-1', czas: '2026-10-25T10:00:00.000Z', wersjaAgenta: '0.1.0', drukarki: [] })
    expect(s.zadania.map((z) => [z.metoda, z.url])).toEqual([
      ['POST', '/api/druk/zlecenia/Z-1/wynik'],
      ['POST', '/api/druk/stan'],
    ])
    expect(JSON.parse(s.zadania[0]!.cialo)).toMatchObject({ wynik: 'OK' })
    expect(s.zadania.every((z) => z.autoryzacja === `Bearer ${TOKEN}`)).toBe(true)
  })

  it('401 → czytelny komunikat z podpowiedzią o tokenie, bez tokenu w treści', async () => {
    const s = await atrapa(() => ({ status: 401, json: { blad: 'zły token' } }))
    const e = (await klient(s.adres).pobierzZlecenia().catch((x: unknown) => x)) as Error
    expect(e.message).toMatch(/401.*sprawdź token stanowiska/)
    expect(e.message).not.toContain(TOKEN)
  })

  it('429 → status i sekundy z Retry-After w błędzie', async () => {
    const s = await atrapa(() => ({ status: 429, naglowki: { 'retry-after': '120' }, json: { error: 'Za dużo' } }))
    const e = (await klient(s.adres).pobierzZlecenia().catch((x: unknown) => x)) as BladSerwera
    expect(e).toBeInstanceOf(BladSerwera)
    expect(e.status).toBe(429)
    expect(e.ponowZaSekund).toBe(120)
  })

  it('sekundyRetryAfter: liczba, data HTTP, śmieci', () => {
    const teraz = Date.parse('2026-11-04T08:00:00Z')
    expect(sekundyRetryAfter('600', teraz)).toBe(600)
    expect(sekundyRetryAfter('Wed, 04 Nov 2026 08:01:30 GMT', teraz)).toBe(90)
    expect(sekundyRetryAfter('Wed, 04 Nov 2026 07:00:00 GMT', teraz)).toBe(0)
    expect(sekundyRetryAfter('za chwilę', teraz)).toBeUndefined()
    expect(sekundyRetryAfter(null, teraz)).toBeUndefined()
  })

  it('odpowiedź nie-JSON i brak tablicy zleceń → BladSerwera', async () => {
    const s = await atrapa((z) => (z.url.includes('zlecenia') ? { dane: Buffer.from('<html>') } : {}))
    await expect(klient(s.adres).pobierzZlecenia()).rejects.toThrow(/nie jest JSON-em/)
    const s2 = await atrapa(() => ({ json: { cos: 1 } }))
    await expect(klient(s2.adres).pobierzZlecenia()).rejects.toThrow(/zlecenia/)
  })

  it('brak odpowiedzi w limicie czasu → błąd połączenia', async () => {
    const s = await atrapa(() => ({ json: {}, opoznienieMs: 500 }))
    await expect(klient(s.adres, 100).pobierzZlecenia()).rejects.toThrow(/brak odpowiedzi/)
  })

  it('serwer wyłączony → błąd połączenia, nie wyjątek nieobsłużony', async () => {
    await expect(klient('http://127.0.0.1:9').pobierzZlecenia()).rejects.toThrow(/Brak połączenia z serwerem/)
  })

  it('pobiera plik względny z tokenem; dozwolony obcy host dostaje żądanie BEZ tokenu', async () => {
    const wlasny = await atrapa(() => ({ dane: PDF }))
    const obcy = await atrapa(() => ({ dane: PDF }))
    const k = klient(wlasny.adres, 2000, [new URL(obcy.adres).host])
    expect((await k.pobierzPlik('/api/druk/pliki/Z-1', 1000)).equals(PDF)).toBe(true)
    await k.pobierzPlik(`${obcy.adres}/podpisany/Z-1?sig=abc`, 1000)
    expect(wlasny.zadania[0]!.autoryzacja).toBe(`Bearer ${TOKEN}`)
    expect(obcy.zadania[0]!.autoryzacja).toBeUndefined()
  })

  it('obcy host spoza dozwoloneHostyPlikow → odrzucony bez żadnego żądania (ochrona sieci lokalnej)', async () => {
    const wlasny = await atrapa(() => ({ dane: PDF }))
    const obcy = await atrapa(() => ({ dane: PDF }))
    await expect(klient(wlasny.adres).pobierzPlik(`${obcy.adres}/router?x=1`, 1000)).rejects.toThrow(/Niedozwolony host pliku/)
    // Wpis bez portu dopuszcza tylko port domyślny; wpis z innym portem nie pasuje.
    await expect(klient(wlasny.adres, 2000, ['127.0.0.1']).pobierzPlik(`${obcy.adres}/x`, 1000)).rejects.toThrow(/Niedozwolony host pliku/)
    await expect(klient(wlasny.adres, 2000, ['127.0.0.1:1']).pobierzPlik(`${obcy.adres}/x`, 1000)).rejects.toThrow(/Niedozwolony host pliku/)
    expect(obcy.zadania).toHaveLength(0)
  })

  it('przekierowanie nie jest wykonywane: ani token, ani żądanie nie idą na host z Location', async () => {
    const obcy = await atrapa(() => ({ dane: PDF }))
    const wlasny = await atrapa(() => ({ status: 302, naglowki: { location: `${obcy.adres}/zlap` }, dane: Buffer.from('') }))
    const k = klient(wlasny.adres)
    await expect(k.pobierzZlecenia()).rejects.toThrow(/przekierowaniem 302.*nie podąża/)
    await expect(k.pobierzPlik('/api/druk/pliki/Z-1', 1000)).rejects.toThrow(/przekierowaniem 302/)
    expect(obcy.zadania).toHaveLength(0)
  })

  it('plik bez Content-Length (chunked) ponad limit jest przerywany w trakcie czytania', async () => {
    const kawalek = Buffer.alloc(64 * 1024, 1)
    const s = await atrapa(() => ({ kawalki: Array.from({ length: 200 }, () => kawalek) })) // ~12,5 MB
    await expect(klient(s.adres).pobierzPlik('/duzy-chunked', 100_000)).rejects.toThrow(/za duży \(ponad 100000 B\)/)
    const s2 = await atrapa(() => ({ kawalki: [PDF.subarray(0, 10), PDF.subarray(10)] }))
    expect((await klient(s2.adres).pobierzPlik('/maly-chunked', 100_000)).equals(PDF)).toBe(true)
  })

  it('plik: limit rozmiaru, pusty plik, niedozwolony protokół', async () => {
    const s = await atrapa((z) => ({ dane: z.url.includes('pusty') ? Buffer.alloc(0) : Buffer.alloc(5000, 1) }))
    const k = klient(s.adres)
    await expect(k.pobierzPlik('/duzy', 1000)).rejects.toThrow(/za duży/)
    await expect(k.pobierzPlik('/pusty', 1000)).rejects.toThrow(/pusty/)
    await expect(k.pobierzPlik('file:///C:/Windows/win.ini', 1000)).rejects.toThrow(/Niedozwolony/)
  })
})
