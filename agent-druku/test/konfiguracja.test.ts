import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BladKonfiguracji, ostrzezeniaKonfiguracji, sprawdzKonfiguracje, wczytajKonfiguracje } from '../src/konfiguracja.js'

const KATALOG = resolve('/opt/agent-druku')
const minimalna = {
  serwer: 'https://kompletor.example.pl',
  token: 'token-testowy-0123456789abcdef',
  stanowisko: 'magazyn-1',
  drukarki: { A4: 'Brother A4', TERMICZNA_1: 'Termiczna 1' },
}

describe('konfiguracja stanowiska', () => {
  it('domyślne wartości i ścieżki względem katalogu programu', () => {
    const k = sprawdzKonfiguracje(minimalna, KATALOG)
    expect(k).toMatchObject({
      odpytywanieSekundy: 5,
      stanSekundy: 60,
      maksKolejkaTermicznej: 5,
      powershell: 'powershell.exe',
      katalogDanych: join(KATALOG, 'dane'),
      katalogLogow: join(KATALOG, 'logi'),
      log: { maksMb: 5, plikow: 5 },
    })
    expect(k.drukarki).toEqual({ A4: 'Brother A4', TERMICZNA_1: 'Termiczna 1' })
  })

  it('zbiera wszystkie błędy naraz, po polsku', () => {
    try {
      sprawdzKonfiguracje({ serwer: 'ftp://x', token: 'krótki', stanowisko: 'stanowisko łódź', drukarki: { A5: 'x' }, odpytywanieSekundy: 0 }, KATALOG)
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(BladKonfiguracji)
      const b = (e as BladKonfiguracji).bledy.join('\n')
      for (const f of ['https://', 'za krótki', 'stanowisko', 'nieznana rola drukarki „A5”', 'nie ma żadnej drukarki', 'odpytywanieSekundy'])
        expect(b).toContain(f)
    }
  })

  it('wczytuje plik z BOM (Notatnik), brak pliku i zły JSON → czytelny błąd', () => {
    const kat = mkdtempSync(join(tmpdir(), 'konfig-'))
    const plik = join(kat, 'agent-druku.json')
    expect(() => wczytajKonfiguracje(plik, kat)).toThrow(/agent-druku\.przyklad\.json/)
    writeFileSync(plik, '{ "serwer": ')
    expect(() => wczytajKonfiguracje(plik, kat)).toThrow(/nie jest poprawnym JSON-em/)
    writeFileSync(plik, '﻿' + JSON.stringify(minimalna))
    expect(wczytajKonfiguracje(plik, kat).stanowisko).toBe('magazyn-1')
  })

  it('dozwoloneHostyPlikow: domyślnie pusta lista, same nazwy hostów (z portem lub bez), zły wpis = błąd', () => {
    expect(sprawdzKonfiguracje(minimalna, KATALOG).dozwoloneHostyPlikow).toEqual([])
    expect(sprawdzKonfiguracje({ ...minimalna, dozwoloneHostyPlikow: ['Pliki.Kompletor.pl', 'cdn.example.pl:8443'] }, KATALOG).dozwoloneHostyPlikow).toEqual([
      'pliki.kompletor.pl',
      'cdn.example.pl:8443',
    ])
    for (const zly of [['https://pliki.kompletor.pl'], ['pliki.kompletor.pl/sciezka'], [5], 'pliki.kompletor.pl'])
      expect(() => sprawdzKonfiguracje({ ...minimalna, dozwoloneHostyPlikow: zly }, KATALOG)).toThrow(/dozwoloneHostyPlikow/)
  })

  it('ostrzeżenia: http poza localhost, brak A4', () => {
    expect(ostrzezeniaKonfiguracji(sprawdzKonfiguracje({ ...minimalna, serwer: 'http://192.168.1.10:3100' }, KATALOG))[0]).toMatch(/bez https/)
    expect(ostrzezeniaKonfiguracji(sprawdzKonfiguracje({ ...minimalna, serwer: 'http://localhost:3100' }, KATALOG))).toEqual([])
    expect(
      ostrzezeniaKonfiguracji(sprawdzKonfiguracje({ ...minimalna, drukarki: { TERMICZNA_1: 'Termiczna 1' } }, KATALOG)),
    ).toEqual([expect.stringMatching(/brak drukarki A4/)])
  })
})

describe('role według wzoru i SumatraPDF z paczki', () => {
  it('przyjmuje A4_2 i dowolne TERMICZNA_<1–2 cyfry>; odrzuca role spoza wzoru', () => {
    const k = sprawdzKonfiguracje({ ...minimalna, drukarki: { A4: 'a', A4_2: 'b', TERMICZNA_1: 't1', TERMICZNA_4: 't4', TERMICZNA_12: 't12' } }, KATALOG)
    expect(Object.keys(k.drukarki)).toEqual(['A4', 'A4_2', 'TERMICZNA_1', 'TERMICZNA_4', 'TERMICZNA_12'])
    for (const zla of ['A5', 'A4_', 'A4_123', 'TERMICZNA', 'TERMICZNA_', 'TERMICZNA_100', 'termiczna_1', 'A4-2'])
      expect(() => sprawdzKonfiguracje({ ...minimalna, drukarki: { A4: 'a', [zla]: 'x' } }, KATALOG), zla).toThrow(`nieznana rola drukarki „${zla}”`)
  })

  it('domyślna Sumatra: najpierw sumatra\\SumatraPDF.exe obok programu, potem Program Files', () => {
    const zPaczki = join(KATALOG, 'sumatra', 'SumatraPDF.exe')
    expect(sprawdzKonfiguracje(minimalna, KATALOG, (p) => p === zPaczki).sumatraPdf).toBe(zPaczki)
    expect(sprawdzKonfiguracje(minimalna, KATALOG, () => false).sumatraPdf).toBe('C:\\Program Files\\SumatraPDF\\SumatraPDF.exe')
    expect(sprawdzKonfiguracje({ ...minimalna, sumatraPdf: 'D:\\S.exe' }, KATALOG, () => true).sumatraPdf).toBe('D:\\S.exe')
  })
})
