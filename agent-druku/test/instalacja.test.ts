// logika instalatora bez Windows — kod instalacyjny, przydział ról, scalanie agent-druku.json.
import { describe, expect, it } from 'vitest'
import {
  BladInstalacji,
  dekodujKodInstalacyjny,
  opisPrzydzialu,
  przydzielRole,
  rodzajZOdpowiedzi,
  czyWydrukProbny,
  zakodujKodInstalacyjny,
  zbudujKonfiguracje,
} from '../src/instalacja.js'
import { sprawdzKonfiguracje } from '../src/konfiguracja.js'
import { sprawdzKodNaSerwerze } from '../src/instalator.js'

const TOKEN = 'kmd_' + 'A'.repeat(20) + '-_' + 'b'.repeat(21)
const KOD = { serwer: 'https://kompletor.example.invalid', stanowisko: 'magazyn-1', token: TOKEN }

describe('kod instalacyjny kmi_', () => {
  it('koduje i dekoduje; wybacza spacje, złamane linie i cudzysłowy', () => {
    const kod = zakodujKodInstalacyjny(KOD)
    expect(kod).toMatch(/^kmi_[A-Za-z0-9_-]+$/)
    expect(dekodujKodInstalacyjny(kod)).toEqual(KOD)
    expect(dekodujKodInstalacyjny(`  "${kod.slice(0, 20)}\r\n${kod.slice(20)}"  `)).toEqual(KOD)
  })

  it('odrzuca z podpowiedzią po polsku: pusty, sam token, zły przedrostek, uszkodzony, złe pola', () => {
    const zly = (k: string, tekst: RegExp) => {
      expect(() => dekodujKodInstalacyjny(k)).toThrow(BladInstalacji)
      expect(() => dekodujKodInstalacyjny(k)).toThrow(tekst)
    }
    zly('', /Nie wklejono/)
    zly(TOKEN, /sam token/)
    zly('abc', /zaczyna się od kmi_/)
    zly('kmi_ąę', /niedozwolone znaki/)
    zly('kmi_' + Buffer.from('nie json').toString('base64url'), /niepełny albo uszkodzony/)
    zly(zakodujKodInstalacyjny({ ...KOD, serwer: 'ftp://x' }), /https/)
    zly(zakodujKodInstalacyjny({ ...KOD, stanowisko: 'łódź 1' }), /nazwy stanowiska/)
    zly(zakodujKodInstalacyjny({ ...KOD, token: 'kmd_krotki' }), /tokenu/)
  })

  it('http:// tylko dla komputera lokalnego; w sieci wymagany https', () => {
    for (const serwer of ['http://192.168.1.10:3000', 'http://kompletor.example.invalid', 'HTTP://Kompletor.example.invalid'])
      expect(() => dekodujKodInstalacyjny(zakodujKodInstalacyjny({ ...KOD, serwer }))).toThrow(/bez https.*otwartym tekstem/)
    for (const serwer of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000'])
      expect(dekodujKodInstalacyjny(zakodujKodInstalacyjny({ ...KOD, serwer })).serwer).toBe(serwer)
  })

  it('adres serwera: bez loginu i hasła, zapisywany sam origin', () => {
    for (const serwer of ['https://a:b@kompletor.example.invalid', 'https://a@kompletor.example.invalid'])
      expect(() => dekodujKodInstalacyjny(zakodujKodInstalacyjny({ ...KOD, serwer }))).toThrow(/loginu ani hasła/)
    expect(dekodujKodInstalacyjny(zakodujKodInstalacyjny({ ...KOD, serwer: 'https://Kompletor.example.invalid/sciezka/x?y=1#z' })).serwer).toBe(
      'https://kompletor.example.invalid',
    )
  })

  it('sprawdzenie na serwerze: treść odpowiedzi i adres przekierowania nie wracają w komunikacie', async () => {
    const tresc = (async () => new Response('<html>TRESC-OBCEGO-SERWERA</html>', { status: 500 })) as unknown as typeof fetch
    const blad = await sprawdzKodNaSerwerze(KOD, tresc)
    expect(blad).toMatch(/odpowiedział kodem 500/)
    expect(blad).not.toContain('TRESC-OBCEGO-SERWERA')
    const przekierowanie = (async () =>
      new Response('', { status: 302, headers: { location: 'https://obcy.example.invalid/x' } })) as unknown as typeof fetch
    const blad2 = await sprawdzKodNaSerwerze(KOD, przekierowanie)
    expect(blad2).toMatch(/odpowiedział kodem 302/)
    expect(blad2).not.toContain('obcy.example.invalid')
  })

  it('sprawdzenie na serwerze: 200 = OK, 401 = token nieważny, 403 = inne stanowisko, brak sieci = komunikat', async () => {
    const odp = (status: number) => (async () => new Response(JSON.stringify({ zlecenia: [] }), { status })) as unknown as typeof fetch
    let adres = ''
    let autoryzacja = ''
    const podglad = (async (url: URL, init: RequestInit) => {
      adres = String(url)
      autoryzacja = (init.headers as Record<string, string>).Authorization ?? ''
      return new Response('{"zlecenia":[]}')
    }) as unknown as typeof fetch
    expect(await sprawdzKodNaSerwerze(KOD, podglad)).toBeNull()
    expect(adres).toBe('https://kompletor.example.invalid/api/druk/zlecenia?stanowisko=magazyn-1')
    expect(autoryzacja).toBe(`Bearer ${TOKEN}`)
    expect(await sprawdzKodNaSerwerze(KOD, odp(401))).toMatch(/token jest nieważny/)
    expect(await sprawdzKodNaSerwerze(KOD, odp(403))).toMatch(/innego stanowiska/)
    const brak = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    expect(await sprawdzKodNaSerwerze(KOD, brak)).toMatch(/Nie udało się połączyć/)
  })
})

describe('przydział ról drukarek', () => {
  it('odpowiedzi A / T / Enter', () => {
    // „p” to kartka próbna, nie „pomiń”
    expect(['a', 'A4', ' t ', '', 'pomiń', 'p', 'x'].map(rodzajZOdpowiedzi)).toEqual(['A4', 'A4', 'TERMICZNA', 'POMIN', 'POMIN', null, null])
    expect(['p', ' P ', 'próba', 'a', '', 'pomiń'].map(czyWydrukProbny)).toEqual([true, true, true, false, false, false])
  })

  it('kolejne zwykłe → A4, A4_2…; termiczne → TERMICZNA_1, 2, 3…; bez limitu trzech drukarek', () => {
    const mapa = przydzielRole([
      { nazwa: 'Microsoft Print to PDF', rodzaj: 'POMIN' },
      { nazwa: 'Zebra 1', rodzaj: 'TERMICZNA' },
      { nazwa: 'Brother', rodzaj: 'A4' },
      { nazwa: 'Zebra 2', rodzaj: 'TERMICZNA' },
      { nazwa: 'HP biuro', rodzaj: 'A4' },
      { nazwa: 'Zebra 3', rodzaj: 'TERMICZNA' },
      { nazwa: 'Zebra 4', rodzaj: 'TERMICZNA' },
      { nazwa: 'zebra 4', rodzaj: 'TERMICZNA' }, // ta sama drukarka drugi raz
    ])
    expect(mapa).toEqual({ TERMICZNA_1: 'Zebra 1', A4: 'Brother', TERMICZNA_2: 'Zebra 2', A4_2: 'HP biuro', TERMICZNA_3: 'Zebra 3', TERMICZNA_4: 'Zebra 4' })
    expect(opisPrzydzialu(mapa)[0]).toMatch(/^A4 .*zwykła.* = Brother$/)
    expect(opisPrzydzialu(mapa).at(-1)).toMatch(/^TERMICZNA_4 .*termiczna.* = Zebra 4$/)
    // konfiguracja z takim przydziałem przechodzi walidację agenta
    const k = sprawdzKonfiguracje(zbudujKonfiguracje(undefined, KOD, mapa), '/opt/agent')
    expect(Object.keys(k.drukarki)).toEqual(['A4', 'A4_2', 'TERMICZNA_1', 'TERMICZNA_2', 'TERMICZNA_3', 'TERMICZNA_4'])
  })

  it('najwyżej 99 jednego rodzaju (wzór roli)', () => {
    const duzo = Array.from({ length: 100 }, (_, i) => ({ nazwa: `Zebra ${i}`, rodzaj: 'TERMICZNA' as const }))
    expect(() => przydzielRole(duzo)).toThrow(/Najwyżej 99/)
    expect(Object.keys(przydzielRole(duzo.slice(0, 99)))).toContain('TERMICZNA_99')
  })
})

describe('agent-druku.json z instalatora', () => {
  it('nowe dane z kodu i drukarek; ustawienia zaawansowane zostają; stara Sumatra z Program Files znika', () => {
    const stara = {
      serwer: 'https://stary.example.invalid',
      token: 'stary-token-0123456789',
      stanowisko: 'stare',
      drukarki: { A4: 'x', TERMICZNA_2: 'y' },
      sumatraPdf: 'C:\\Program Files\\SumatraPDF\\SumatraPDF.exe',
      odpytywanieSekundy: 7,
      dozwoloneHostyPlikow: ['pliki.example.invalid'],
    }
    const nowa = zbudujKonfiguracje(stara, KOD, { TERMICZNA_1: 'Zebra', A4: 'Brother' })
    expect(nowa).toEqual({
      serwer: KOD.serwer,
      token: TOKEN,
      stanowisko: 'magazyn-1',
      drukarki: { A4: 'Brother', TERMICZNA_1: 'Zebra' },
      odpytywanieSekundy: 7,
      dozwoloneHostyPlikow: ['pliki.example.invalid'],
    })
    expect(zbudujKonfiguracje({ sumatraPdf: 'D:\\Sumatra\\SumatraPDF.exe' }, KOD, { A4: 'a' }).sumatraPdf).toBe('D:\\Sumatra\\SumatraPDF.exe')
    expect(() => zbudujKonfiguracje(undefined, KOD, {})).toThrow(/co najmniej jedną/)
  })
})
