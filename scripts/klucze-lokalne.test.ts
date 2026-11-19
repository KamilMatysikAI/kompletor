// Mapa kluczy lokalnych: ścieżki i nazwy poza repo, wartości tylko z plików .env.
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { envWithLocalKeys, parseKeyMap } from './klucze-lokalne'

describe('klucze lokalne z mapy poza repo', () => {
  it('uzupełnia brakujące zmienne z pliku .env wg mapy; ustawione w env wygrywają; bez mapy — bez zmian', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'klucze-'))
    const envFile = path.join(dir, 'inny.env')
    writeFileSync(envFile, 'OBCA_NAZWA=wartosc-a\nDRUGA=wartosc-b\n')
    const map = path.join(dir, 'mapa.json')
    writeFileSync(map, JSON.stringify([{ file: envFile, keys: { NASZA: 'OBCA_NAZWA', DRUGA_NASZA: 'DRUGA' } }, { file: path.join(dir, 'nie-ma.env'), keys: { X: 'Y' } }]))
    expect(envWithLocalKeys({ DRUGA_NASZA: 'z-env' }, map)).toEqual({ NASZA: 'wartosc-a', DRUGA_NASZA: 'z-env' })
    expect(envWithLocalKeys({ A: '1' }, undefined)).toEqual({ A: '1' })
    expect(() => envWithLocalKeys({}, path.join(dir, 'brak.json'))).toThrow(/Brak pliku mapy/)
  })
  it('zła mapa → błąd z numerem wpisu, bez wartości', () => {
    expect(() => parseKeyMap('{}')).toThrow(/lista/)
    expect(() => parseKeyMap('[{"file":"a"}]')).toThrow(/wpis 1/)
    expect(() => parseKeyMap('[{"file":"a","keys":{"zła":"X"}}]')).toThrow(/zła nazwa/)
  })
})
