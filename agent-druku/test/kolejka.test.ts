import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Agent, KOMUNIKAT_ODMOWY_TOKENU, MAKS_PRZERWA_MS, PRZERWA_PO_ODMOWIE_TOKENU_MS } from '../src/kolejka.js'
import { BladSerwera } from '../src/serwer.js'
import type { ZlecenieDruku } from '../src/kontrakt.js'
import { LogPamieci } from '../src/log.js'
import type { MapaRol } from '../src/mapowanie.js'
import { RejestrWydrukow } from '../src/rejestr.js'
import { AtrapaDrukarek, AtrapaSerwera, PDF, ZPL, zlecenie } from './atrapy.js'

const MAPA: MapaRol = { A4: 'Brother A4', TERMICZNA_1: 'Termiczna 1', TERMICZNA_2: 'Termiczna 2' }

let katalog: string
let serwer: AtrapaSerwera
let drukarki: AtrapaDrukarek
let log: LogPamieci

beforeEach(() => {
  katalog = mkdtempSync(join(tmpdir(), 'agent-druku-'))
  serwer = new AtrapaSerwera()
  drukarki = new AtrapaDrukarek()
  log = new LogPamieci()
})

async function nowyAgent(mapa: MapaRol = MAPA, teraz: () => Date = () => new Date('2026-10-25T10:00:00Z')) {
  // Każde wywołanie = „start programu”: rejestr czytany z tego samego pliku na dysku.
  const { rejestr } = await RejestrWydrukow.wczytaj(join(katalog, 'wydrukowane.json'))
  return new Agent({
    serwer,
    drukarki,
    rejestr,
    log,
    ustawienia: {
      stanowisko: 'magazyn-1',
      drukarki: mapa,
      katalogTymczasowy: join(katalog, 'tymczasowe'),
      maksBajtowPliku: 1024 * 1024,
      maksKolejkaTermicznej: 5,
    },
    teraz,
  })
}

function dodaj(...z: ZlecenieDruku[]) {
  for (const x of z) serwer.pliki.set(x.plikUrl, x.format === 'zpl' ? ZPL : PDF)
  serwer.zlecenia(...z)
}

describe('kolejka zleceń', () => {
  it('drukuje PDF na A4 (dopasowanie) i ZPL surowo na termicznej, w kolejności z serwera, z kopiami', async () => {
    const karta = zlecenie({ typ: 'karta', rola: 'A4', kopie: 2 })
    const etykieta = zlecenie({ typ: 'etykieta', format: 'zpl', rola: 'TERMICZNA_1' })
    const etykietaPdf = zlecenie({ typ: 'etykieta', format: 'pdf', rola: 'TERMICZNA_2' })
    dodaj(karta, etykieta, etykietaPdf)
    const agent = await nowyAgent()

    const p = await agent.cyklZlecen()

    expect(p).toMatchObject({ pobrane: 3, wydrukowane: 3, bledy: 0, niewyslaneRaporty: 0 })
    expect(drukarki.wydruki.map((w) => [w.rodzaj, w.drukarka, w.kopie, w.skalowanie])).toEqual([
      ['pdf', 'Brother A4', 2, 'fit'],
      ['raw', 'Termiczna 1', 1, undefined],
      ['pdf', 'Termiczna 2', 1, 'noscale'],
    ])
    expect(drukarki.wydruki[1]!.tresc).toContain('Jan Testowy')
    expect(serwer.wyniki.map((w) => [w.id, w.raport.wynik, w.raport.drukarka])).toEqual([
      [karta.id, 'OK', 'Brother A4'],
      [etykieta.id, 'OK', 'Termiczna 1'],
      [etykietaPdf.id, 'OK', 'Termiczna 2'],
    ])
    expect(serwer.wyniki[0]!.raport).toMatchObject({ stanowisko: 'magazyn-1', ponowienieRaportu: false, czas: '2026-10-25T10:00:00.000Z' })
    // pliki tymczasowe sprzątnięte
    expect(readdirSync(join(katalog, 'tymczasowe'))).toEqual([])
  })

  it('to samo zlecenie podane drugi raz w kolejnym cyklu nie drukuje się ponownie (tylko raport OK)', async () => {
    const z = zlecenie()
    dodaj(z)
    const agent = await nowyAgent()
    await agent.cyklZlecen()
    const p = await agent.cyklZlecen()
    expect(drukarki.wydruki).toHaveLength(1)
    expect(p).toMatchObject({ wydrukowane: 0, powtorzone: 1 })
    expect(serwer.wyniki.map((w) => w.raport.ponowienieRaportu)).toEqual([false, true])
  })

  it('idempotencja po restarcie: raport OK nie doszedł do serwera, nowy proces nie drukuje drugi raz', async () => {
    const z = zlecenie({ typ: 'etykieta', format: 'zpl', rola: 'TERMICZNA_1' })
    dodaj(z)
    serwer.bledyWyniku = 1
    const p1 = await (await nowyAgent()).cyklZlecen()
    expect(p1).toMatchObject({ wydrukowane: 1, niewyslaneRaporty: 1 })
    expect(serwer.wyniki).toHaveLength(0)

    // restart programu
    const p2 = await (await nowyAgent()).cyklZlecen()
    expect(p2).toMatchObject({ wydrukowane: 0, powtorzone: 1 })
    expect(drukarki.wydruki).toHaveLength(1)
    expect(serwer.wyniki).toEqual([
      { id: z.id, raport: expect.objectContaining({ wynik: 'OK', ponowienieRaportu: true, drukarka: 'Termiczna 1' }) },
    ])
  })

  it('program zamknięty w trakcie druku: po restarcie BLAD „sprawdź, czy wyszło”, bez ponownego druku', async () => {
    const z = zlecenie({ typ: 'etykieta', format: 'zpl', rola: 'TERMICZNA_1' })
    dodaj(z)
    // Pierwszy proces „umiera” w trakcie druku: drukarka nigdy nie kończy, cyklu nie doczekujemy.
    drukarki.zawies = true
    void (await nowyAgent()).cyklZlecen()
    await vi.waitFor(() => expect(drukarki.zawieszone).toBe(1))
    drukarki.zawies = false

    const p = await (await nowyAgent()).cyklZlecen()
    expect(drukarki.wydruki).toHaveLength(0)
    expect(p.powtorzone).toBe(1)
    expect(serwer.wyniki[0]!.raport).toMatchObject({ wynik: 'BLAD', ponowienieRaportu: true })
    expect(serwer.wyniki[0]!.raport.komunikat).toMatch(/Sprawdź, czy wydruk wyszedł/)
  })

  it('błąd jednego zlecenia nie zatrzymuje kolejnych (brak pliku, zły plik, zły kontrakt)', async () => {
    const dobre1 = zlecenie()
    const bezPliku = zlecenie()
    const niePdf = zlecenie()
    const dobre2 = zlecenie({ rola: 'TERMICZNA_2', format: 'zpl', typ: 'etykieta' })
    dodaj(dobre1, niePdf, dobre2)
    serwer.pliki.set(niePdf.plikUrl, Buffer.from('<html>błąd</html>'))
    serwer.odpowiedz = {
      zlecenia: [dobre1, bezPliku, niePdf, { ...zlecenie(), id: 'zpl-na-a4', format: 'zpl', rola: 'A4' }, { id: '../zly id' }, dobre2],
    }
    const agent = await nowyAgent()

    const p = await agent.cyklZlecen()

    expect(drukarki.wydruki.map((w) => w.drukarka)).toEqual(['Brother A4', 'Termiczna 2'])
    expect(p).toMatchObject({ wydrukowane: 2, bledy: 3 })
    const wg = new Map(serwer.wyniki.map((w) => [w.id, w.raport]))
    expect(wg.get(bezPliku.id)).toMatchObject({ wynik: 'BLAD', komunikat: expect.stringMatching(/Nie udało się pobrać pliku.*404/) })
    expect(wg.get(niePdf.id)).toMatchObject({ wynik: 'BLAD', komunikat: 'Pobrany plik nie jest PDF-em' })
    expect(wg.get('zpl-na-a4')).toMatchObject({ wynik: 'BLAD', komunikat: expect.stringMatching(/ZPL nie może iść na drukarkę A4/) })
    // problemy z plikiem to nie awaria drukarki — bez roli zapasowej
    expect(wg.get(bezPliku.id)!.rolaZapasowa).toBeUndefined()
    // zlecenie bez poprawnego id: tylko log, nie da się odesłać wyniku
    expect(log.wpisy.some((w) => w.tekst.includes('Niepoprawne id zlecenia'))).toBe(true)
  })

  it('nieoczekiwany wyjątek przy druku na jednej roli nie zatrzymuje zleceń na inne role', async () => {
    const z1 = zlecenie()
    const z2 = zlecenie({ typ: 'etykieta', format: 'zpl', rola: 'TERMICZNA_1' })
    dodaj(z1, z2)
    let pierwszy = true
    drukarki.wTrakcieDruku = () => {
      if (pierwszy) {
        pierwszy = false
        throw new TypeError('coś poszło bardzo źle')
      }
    }
    await (await nowyAgent()).cyklZlecen()
    expect(serwer.wyniki.map((w) => w.raport.wynik)).toEqual(['BLAD', 'OK'])
  })
})

describe('awaria drukarki termicznej', () => {
  it('termiczna offline w Windows: BLAD z rolą zapasową TERMICZNA_2, bez próby druku', async () => {
    drukarki.ustawStan('Termiczna 1', { status: 'Offline' })
    const z = zlecenie({ typ: 'etykieta', format: 'zpl', rola: 'TERMICZNA_1' })
    dodaj(z)
    await (await nowyAgent()).cyklZlecen()
    expect(drukarki.wydruki).toHaveLength(0)
    expect(serwer.wyniki[0]!.raport).toMatchObject({
      wynik: 'BLAD',
      rola: 'TERMICZNA_1',
      drukarka: 'Termiczna 1',
      rolaZapasowa: 'TERMICZNA_2',
      komunikat: expect.stringMatching(/offline/),
    })
  })

  it('obie termiczne leżą: rola zapasowa A4 (serwer decyduje i da PDF)', async () => {
    drukarki.ustawStan('Termiczna 1', { status: 'PaperOut' })
    drukarki.ustawStan('Termiczna 2', { offline: true })
    const z = zlecenie({ typ: 'etykieta', format: 'zpl', rola: 'TERMICZNA_2' })
    dodaj(z)
    await (await nowyAgent()).cyklZlecen()
    expect(serwer.wyniki[0]!.raport).toMatchObject({ wynik: 'BLAD', rolaZapasowa: 'A4' })
  })

  it('drukarka odrzuca zadanie: BLAD z rolą zapasową, kolejne zlecenia na nią od razu BLAD, inne role drukują', async () => {
    drukarki.psute.add('Termiczna 1')
    const e1 = zlecenie({ typ: 'etykieta', format: 'zpl', rola: 'TERMICZNA_1' })
    const e2 = zlecenie({ typ: 'etykieta', format: 'zpl', rola: 'TERMICZNA_1' })
    const karta = zlecenie()
    dodaj(e1, e2, karta)
    const agent = await nowyAgent()
    await agent.cyklZlecen()
    const [r1, r2, r3] = serwer.wyniki.map((w) => w.raport)
    expect(r1).toMatchObject({ wynik: 'BLAD', rolaZapasowa: 'TERMICZNA_2', komunikat: expect.stringMatching(/odrzuciła wydruk/) })
    expect(r2).toMatchObject({ wynik: 'BLAD', rolaZapasowa: 'TERMICZNA_2', komunikat: expect.stringMatching(/zawiodła wcześniej/) })
    expect(r3).toMatchObject({ wynik: 'OK' })

    // Odrzucone zlecenie nie zostaje w rejestrze — po naprawie drukarki to samo id może się wydrukować.
    drukarki.psute.clear()
    serwer.zlecenia(e1)
    await agent.cyklZlecen()
    expect(serwer.wyniki.at(-1)!.raport).toMatchObject({ wynik: 'OK', ponowienieRaportu: false })
  })

  it('przekroczony czas druku = nie wiadomo, czy wyszło: bez roli zapasowej, W_TOKU zostaje, kolejne zlecenia na tę rolę idą na zapas', async () => {
    drukarki.niepewne.add('Termiczna 1')
    const e1 = zlecenie({ typ: 'etykieta', format: 'zpl', rola: 'TERMICZNA_1' })
    const e2 = zlecenie({ typ: 'etykieta', format: 'zpl', rola: 'TERMICZNA_1' })
    dodaj(e1, e2)
    const agent = await nowyAgent()
    const p = await agent.cyklZlecen()

    const [r1, r2] = serwer.wyniki.map((w) => w.raport)
    expect(r1).toMatchObject({ wynik: 'BLAD', rola: 'TERMICZNA_1', drukarka: 'Termiczna 1', ponowienieRaportu: false })
    expect(r1!.komunikat).toMatch(/Nie wiadomo, czy wydruk wyszedł.*przekroczony czas/)
    expect(r1!.rolaZapasowa).toBeUndefined()
    // Drugie zlecenie na tę rolę nie czeka kolejnego limitu czasu: nie dotarło do drukarki, więc idzie na zapas.
    expect(r2!.komunikat).toMatch(/zawiodła wcześniej w tym cyklu/)
    expect(r2!.rolaZapasowa).toBe('TERMICZNA_2')
    expect(p).toMatchObject({ bledy: 2 })

    // Wpis W_TOKU zostaje na dysku: serwer poda to samo id (np. raport nie doszedł) → „Druk przerwany”, bez druku.
    drukarki.niepewne.clear()
    serwer.zlecenia(e1)
    await (await nowyAgent()).cyklZlecen()
    expect(drukarki.wydruki).toHaveLength(0)
    expect(serwer.wyniki.at(-1)!.raport).toMatchObject({ wynik: 'BLAD', ponowienieRaportu: true, komunikat: expect.stringMatching(/Druk przerwany/) })
    expect(serwer.wyniki.at(-1)!.raport.rolaZapasowa).toBeUndefined()
  })

  it('wydruk wyszedł, ale zapis rejestru się nie udał: raport OK, błąd w logu', async () => {
    const z = zlecenie({ typ: 'etykieta', format: 'zpl', rola: 'TERMICZNA_1' })
    dodaj(z)
    const agent = await nowyAgent()
    const zapis = vi.spyOn(RejestrWydrukow.prototype, 'oznaczWydrukowane').mockRejectedValueOnce(
      Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }),
    )
    try {
      const p = await agent.cyklZlecen()
      expect(p).toMatchObject({ wydrukowane: 1, bledy: 0 })
      expect(drukarki.wydruki).toHaveLength(1)
      expect(serwer.wyniki[0]!.raport).toMatchObject({ wynik: 'OK', drukarka: 'Termiczna 1' })
      expect(log.wpisy.some((w) => w.poziom === 'BLAD' && w.tekst.includes('nie udało się zapisać rejestru') && w.tekst.includes('ENOSPC'))).toBe(true)
    } finally {
      zapis.mockRestore()
    }
  })

  it('zapchana kolejka Windows termicznej traktowana jak awaria', async () => {
    drukarki.ustawStan('Termiczna 2', { zleceniaWKolejce: 7 })
    const z = zlecenie({ typ: 'etykieta', format: 'pdf', rola: 'TERMICZNA_2' })
    dodaj(z)
    await (await nowyAgent()).cyklZlecen()
    expect(serwer.wyniki[0]!.raport).toMatchObject({ wynik: 'BLAD', rolaZapasowa: 'TERMICZNA_1', komunikat: expect.stringMatching(/7 niewydrukowanych/) })
  })

  it('A4 offline: BLAD bez roli zapasowej', async () => {
    drukarki.ustawStan('Brother A4', { status: '8' }) // liczbowy PrinterStatus = Offline
    dodaj(zlecenie())
    await (await nowyAgent()).cyklZlecen()
    expect(serwer.wyniki[0]!.raport).toMatchObject({ wynik: 'BLAD', rola: 'A4' })
    expect(serwer.wyniki[0]!.raport.rolaZapasowa).toBeUndefined()
  })

  it('rola bez drukarki w konfiguracji: BLAD z zapasem', async () => {
    dodaj(zlecenie({ typ: 'etykieta', format: 'zpl', rola: 'TERMICZNA_2' }))
    await (await nowyAgent({ A4: 'Brother A4', TERMICZNA_1: 'Termiczna 1' })).cyklZlecen()
    expect(serwer.wyniki[0]!.raport).toMatchObject({
      wynik: 'BLAD',
      rolaZapasowa: 'TERMICZNA_1',
      komunikat: 'Brak drukarki dla roli TERMICZNA_2 w konfiguracji stanowiska',
    })
  })

  it('nieczytelny stan z Windows nie blokuje druku', async () => {
    drukarki.bladStanu = new Error('powershell.exe: kod wyjścia 1')
    dodaj(zlecenie())
    await (await nowyAgent()).cyklZlecen()
    expect(drukarki.wydruki).toHaveLength(1)
    expect(log.wpisy.some((w) => w.poziom === 'UWAGA' && w.tekst.includes('stanu drukarek'))).toBe(true)
  })
})

describe('serwer niedostępny', () => {
  it('cykl nie rzuca, błąd logowany raz do czasu powrotu połączenia', async () => {
    const agent = await nowyAgent()
    serwer.niedostepny = true
    for (let i = 0; i < 5; i++) expect((await agent.cyklZlecen()).bladSerwera).toMatch(/ECONNREFUSED/)
    expect(log.wpisy.filter((w) => w.tekst.startsWith('Nie udało się pobrać zleceń'))).toHaveLength(1)
    serwer.niedostepny = false
    await agent.cyklZlecen()
    expect(log.wpisy.at(-1)!.tekst).toBe('Połączenie z serwerem wróciło')
  })

  it('nie odpytuje stanu drukarek, gdy nie ma zleceń', async () => {
    const agent = await nowyAgent()
    await agent.cyklZlecen()
    expect(drukarki.wywolaniaStanu).toBe(0)
  })

  it('serwer usuwający zlecenie po raporcie: kolejny cykl nic nie robi', async () => {
    serwer.usuwajPoRaporcie = true
    dodaj(zlecenie(), zlecenie())
    const agent = await nowyAgent()
    expect((await agent.cyklZlecen()).wydrukowane).toBe(2)
    expect((await agent.cyklZlecen()).pobrane).toBe(0)
  })
})

describe('odmowa serwera: token odrzucony i limit', () => {
  let zegar: number
  const teraz = () => new Date(zegar)
  beforeEach(() => {
    zegar = Date.parse('2026-10-25T10:00:00Z')
  })

  it('401: jeden wpis w logu, potem cisza do 5 min (bez zleceń i stanu), po przerwie znowu pyta', async () => {
    const agent = await nowyAgent(MAPA, teraz)
    serwer.odmowa = new BladSerwera('Serwer odpowiedział 401 dla /api/druk/zlecenia — sprawdź token', 401)
    expect((await agent.cyklZlecen()).bladSerwera).toMatch(/401/)
    expect(serwer.zadania).toBe(1)
    for (let i = 0; i < 50; i++) {
      zegar += 5_000
      if (zegar - Date.parse('2026-10-25T10:00:00Z') >= PRZERWA_PO_ODMOWIE_TOKENU_MS) break
      await agent.cyklZlecen()
      expect(await agent.raportujStan()).toBe(false)
    }
    expect(serwer.zadania).toBe(1)
    expect(log.wpisy.filter((w) => w.tekst.startsWith(KOMUNIKAT_ODMOWY_TOKENU))).toHaveLength(1)
    zegar = Date.parse('2026-10-25T10:00:00Z') + PRZERWA_PO_ODMOWIE_TOKENU_MS
    await agent.cyklZlecen()
    expect(serwer.zadania).toBe(2)
    // ten sam powód = bez nowego wpisu
    expect(log.wpisy.filter((w) => w.tekst.startsWith(KOMUNIKAT_ODMOWY_TOKENU))).toHaveLength(1)
    // nowy token: wraca normalna praca
    serwer.odmowa = undefined
    zegar += PRZERWA_PO_ODMOWIE_TOKENU_MS
    dodaj(zlecenie())
    expect((await agent.cyklZlecen()).wydrukowane).toBe(1)
  })

  it('403 z raportu stanu też wstrzymuje cykl zleceń', async () => {
    const agent = await nowyAgent(MAPA, teraz)
    serwer.odmowa = new BladSerwera('Serwer odpowiedział 403 dla /api/druk/stan', 403)
    expect(await agent.raportujStan()).toBe(false)
    serwer.odmowa = undefined
    await agent.cyklZlecen()
    expect(serwer.zadania).toBe(1)
  })

  it('429: przerwa według Retry-After (z górną granicą), bez Retry-After 60 s', async () => {
    const agent = await nowyAgent(MAPA, teraz)
    serwer.odmowa = new BladSerwera('Serwer odpowiedział 429 dla /api/druk/zlecenia', 429, 120)
    await agent.cyklZlecen()
    serwer.odmowa = undefined
    zegar += 119_000
    await agent.cyklZlecen()
    expect(serwer.zadania).toBe(1)
    zegar += 1_000
    await agent.cyklZlecen()
    expect(serwer.zadania).toBe(2)

    serwer.odmowa = new BladSerwera('429', 429)
    await agent.cyklZlecen()
    serwer.odmowa = undefined
    zegar += 59_000
    await agent.cyklZlecen()
    expect(serwer.zadania).toBe(3)
    zegar += 1_000
    await agent.cyklZlecen()
    expect(serwer.zadania).toBe(4)

    serwer.odmowa = new BladSerwera('429', 429, 999_999)
    await agent.cyklZlecen()
    serwer.odmowa = undefined
    zegar += MAKS_PRZERWA_MS
    await agent.cyklZlecen()
    expect(serwer.zadania).toBe(6)
  })

  it('503 i brak połączenia nie wydłużają odpytywania', async () => {
    const agent = await nowyAgent(MAPA, teraz)
    serwer.odmowa = new BladSerwera('Serwer odpowiedział 503', 503)
    await agent.cyklZlecen()
    await agent.cyklZlecen()
    expect(serwer.zadania).toBe(2)
  })

  it('token odrzucony przy pobieraniu pliku: reszta zleceń w tym cyklu czeka, nic nie drukuje', async () => {
    const agent = await nowyAgent(MAPA, teraz)
    const z1 = zlecenie()
    const z2 = zlecenie()
    dodaj(z1, z2)
    const oryginal = serwer.pobierzPlik.bind(serwer)
    serwer.pobierzPlik = async () => {
      throw new BladSerwera('Serwer odpowiedział 401', 401)
    }
    const p = await agent.cyklZlecen()
    expect(p.wydrukowane).toBe(0)
    expect(drukarki.wydruki).toHaveLength(0)
    expect(serwer.wyniki).toHaveLength(0) // raport BLAD nie poszedł w przerwie; zlecenie wróci z serwera
    serwer.pobierzPlik = oryginal
  })
})

describe('raport stanu drukarek', () => {
  it('wysyła stan wszystkich ról z kolejką Windows', async () => {
    drukarki.ustawStan('Termiczna 1', { status: 'PaperOut', zleceniaWKolejce: 2 })
    drukarki.ustawStan('Termiczna 2', { offline: true })
    const agent = await nowyAgent()
    expect(await agent.raportujStan()).toBe(true)
    expect(serwer.stany[0]).toEqual({
      stanowisko: 'magazyn-1',
      czas: '2026-10-25T10:00:00.000Z',
      wersjaAgenta: expect.any(String),
      drukarki: [
        { rola: 'A4', nazwa: 'Brother A4', stan: 'DOSTEPNA', zleceniaWKolejce: 0 },
        { rola: 'TERMICZNA_1', nazwa: 'Termiczna 1', stan: 'BLAD', komunikat: 'brak papieru lub etykiet', zleceniaWKolejce: 2 },
        { rola: 'TERMICZNA_2', nazwa: 'Termiczna 2', stan: 'OFFLINE', komunikat: expect.any(String), zleceniaWKolejce: 0 },
      ],
    })
  })

  it('gdy Windows nie odpowiada, każda rola ma BLAD z powodem', async () => {
    drukarki.bladStanu = new Error('przekroczony czas 60 s')
    const agent = await nowyAgent()
    await agent.raportujStan()
    expect(serwer.stany[0]!.drukarki).toHaveLength(3)
    expect(serwer.stany[0]!.drukarki.every((d) => d.stan === 'BLAD' && d.zleceniaWKolejce === null)).toBe(true)
  })

  it('serwer niedostępny: raport stanu zwraca false, nie rzuca', async () => {
    serwer.niedostepny = true
    expect(await (await nowyAgent()).raportujStan()).toBe(false)
  })
})

describe('pliki tymczasowe', () => {
  it('po błędzie druku plik tymczasowy jest usuwany', async () => {
    drukarki.psute.add('Brother A4')
    const z = zlecenie()
    dodaj(z)
    await (await nowyAgent()).cyklZlecen()
    expect(existsSync(join(katalog, 'tymczasowe', `${z.id}.pdf`))).toBe(false)
  })
})
