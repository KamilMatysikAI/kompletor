// Log z rotacją, blokada jednej kopii programu, pętla bez nakładania się obrotów.
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parsujTasklist, sprawdzProces, zalozBlokade } from '../src/blokada.js'
import { LogPlikowy, czasLokalny } from '../src/log.js'
import { KOD_BLAD_KONFIGURACJI, powtarzaj, sprawdzPlikKonfiguracji } from '../src/main.js'

describe('log do pliku z rotacją', () => {
  it('rotuje po przekroczeniu rozmiaru i trzyma zadaną liczbę starych plików', () => {
    const plik = join(mkdtempSync(join(tmpdir(), 'log-')), 'logi', 'agent-druku.log')
    const log = new LogPlikowy({ plik, maksBajtow: 200, plikow: 2, teraz: () => new Date(2026, 9, 25, 11, 5, 3) })
    for (let i = 0; i < 20; i++) log.info(`wpis ${i} ${'x'.repeat(40)}`)
    expect(existsSync(plik)).toBe(true)
    expect(existsSync(`${plik}.1`)).toBe(true)
    expect(existsSync(`${plik}.2`)).toBe(true)
    expect(existsSync(`${plik}.3`)).toBe(false)
    const tresc = readFileSync(plik, 'utf8')
    expect(tresc).toContain('wpis 19')
    expect(tresc.startsWith('2026-10-25 11:05:03 INFO  wpis')).toBe(true)
    expect(readFileSync(plik, 'utf8').length).toBeLessThanOrEqual(200)
  })

  it('dane dopisywane jako JSON, poziomy UWAGA i BLAD', () => {
    const plik = join(mkdtempSync(join(tmpdir(), 'log-')), 'a.log')
    const log = new LogPlikowy({ plik, maksBajtow: 10_000, plikow: 1 })
    log.uwaga('Drukarka „Termiczna 1” offline', { id: 'Z-1' })
    log.blad('Zlecenie Z-2: błąd')
    const linie = readFileSync(plik, 'utf8').trim().split('\n')
    expect(linie[0]).toMatch(/ UWAGA Drukarka „Termiczna 1” offline \{"id":"Z-1"\}$/)
    expect(linie[1]).toMatch(/ BLAD  Zlecenie Z-2: błąd$/)
  })

  it('czas lokalny w formacie dla człowieka', () => {
    expect(czasLokalny(new Date(2026, 0, 2, 3, 4, 5))).toBe('2026-01-02 03:04:05')
  })
})

describe('blokada jednej kopii agenta', () => {
  const nowyPlik = () => join(mkdtempSync(join(tmpdir(), 'blokada-')), 'agent.lock')

  it('druga kopia nie startuje, póki pierwsza żyje; martwa blokada jest przejmowana', () => {
    const plik = nowyPlik()
    expect(zalozBlokade(plik, 1001, () => 'node').zwolnij).not.toBeNull()
    expect(zalozBlokade(plik, 1002, () => 'node')).toEqual({ zwolnij: null, zajetaPrzez: 1001 })
    expect(zalozBlokade(plik, 1002, () => 'brak').zwolnij).not.toBeNull() // 1001 nie żyje (np. zanik prądu)
    expect(JSON.parse(readFileSync(plik, 'utf8'))).toMatchObject({ pid: 1002, start: expect.any(String) })
  })

  it('PID z blokady należy teraz do żywego procesu, który nie jest Node (po restarcie) → blokada przejęta', () => {
    const plik = nowyPlik()
    zalozBlokade(plik, 1001, () => 'node')
    const sprawdzane: number[] = []
    const w = zalozBlokade(plik, 1002, (pid) => (sprawdzane.push(pid), 'inny'))
    expect(w.zwolnij).not.toBeNull()
    expect(sprawdzane).toEqual([1001])
    expect(JSON.parse(readFileSync(plik, 'utf8')).pid).toBe(1002)
  })

  it('nie da się sprawdzić procesu → blokada zostaje (lepiej poczekać niż drukować dwiema kopiami)', () => {
    const plik = nowyPlik()
    zalozBlokade(plik, 1001, () => 'node')
    expect(zalozBlokade(plik, 1002, () => 'nieznany').zwolnij).toBeNull()
  })

  it('stary format (sam PID) jest czytany; własny PID w starej blokadzie = blokada po poprzednim uruchomieniu', () => {
    const plik = nowyPlik()
    writeFileSync(plik, '1001')
    expect(zalozBlokade(plik, 1002, () => 'node').zajetaPrzez).toBe(1001)
    writeFileSync(plik, '1002')
    expect(zalozBlokade(plik, 1002, () => 'node').zwolnij).not.toBeNull()
  })

  it('zwolnienie usuwa tylko własną blokadę; śmieci i pusty plik nie blokują startu; brak pliku tymczasowego', () => {
    const plik = nowyPlik()
    zalozBlokade(plik, 5, () => 'node').zwolnij!()
    expect(existsSync(plik)).toBe(false)
    writeFileSync(plik, 'śmieci')
    const w = zalozBlokade(plik, 6, () => 'node')
    expect(w.zwolnij).not.toBeNull()
    expect(readdirSync(join(plik, '..'))).toEqual(['agent.lock'])
    // Ktoś (np. odinstaluj.cmd + nowa kopia) podmienił blokadę — nasze zwolnienie jej nie kasuje.
    writeFileSync(plik, JSON.stringify({ pid: 7 }))
    w.zwolnij!()
    expect(existsSync(plik)).toBe(true)
    writeFileSync(plik, '')
    expect(zalozBlokade(plik, 8, () => 'node').zwolnij).not.toBeNull()
  })

  it('prawdziwe sprawdzenie procesu: ten proces to Node, nieistniejący PID to brak', () => {
    expect(sprawdzProces(process.pid)).toBe('node')
    expect(sprawdzProces(2_000_000_000)).toBe('brak')
  })

  it('wyjście tasklist: nazwa z CSV albo brak procesu (komunikat w języku systemu)', () => {
    expect(parsujTasklist('"node.exe","12340","Console","1","45 000 K"\r\n')).toBe('node.exe')
    expect(parsujTasklist('"svchost.exe","12340","Services","0","9 000 K"')).toBe('svchost.exe')
    expect(parsujTasklist('INFORMACJA: Brak uruchomionych zadań spełniających określone kryteria.\r\n')).toBe('')
  })
})

describe('--sprawdz-konfig', () => {
  it('poprawna konfiguracja = kod 0 z ostrzeżeniami; błędna = kod 2 z listą błędów po polsku', () => {
    const kat = mkdtempSync(join(tmpdir(), 'konfig-'))
    const plik = join(kat, 'agent-druku.json')
    writeFileSync(
      plik,
      JSON.stringify({ serwer: 'https://kompletor.example.pl', token: 'token-testowy-0123456789abcdef', stanowisko: 'magazyn-1', drukarki: { TERMICZNA_1: 'T1' } }),
    )
    const ok = sprawdzPlikKonfiguracji(plik, kat)
    expect(ok.kod).toBe(0)
    expect(ok.tekst).toMatch(/^Konfiguracja poprawna\.\nUWAGA: brak drukarki A4/)
    writeFileSync(plik, JSON.stringify({ serwer: 'https://kompletor.example.pl', token: 'x', stanowisko: 'magazyn łódź', odpytywanieSekundy: '5', drukarki: {} }))
    const zle = sprawdzPlikKonfiguracji(plik, kat)
    expect(zle.kod).toBe(KOD_BLAD_KONFIGURACJI)
    for (const f of ['za krótki', 'stanowisko', 'odpytywanieSekundy', 'nie ma żadnej drukarki']) expect(zle.tekst).toContain(f)
  })
})

describe('pętla agenta', () => {
  it('kolejny obrót dopiero po zakończeniu poprzedniego; błąd kroku nie przerywa pętli; abort kończy', async () => {
    const stop = new AbortController()
    let trwa = 0
    let maksRownolegle = 0
    let obroty = 0
    const petla = powtarzaj(
      async () => {
        trwa++
        maksRownolegle = Math.max(maksRownolegle, trwa)
        await new Promise((r) => setTimeout(r, 15))
        trwa--
        obroty++
        if (obroty === 2) throw new Error('błąd w kroku')
        if (obroty === 4) stop.abort()
      },
      1,
      stop.signal,
    )
    await petla
    expect(obroty).toBe(4)
    expect(maksRownolegle).toBe(1)
  })
})
