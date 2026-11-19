// Paczka programu druku z katalogu AGENT_DRUKU_KATALOG: wybór pliku według wzoru i najwyższej wersji, pomijanie
// plików spoza wzoru, podkatalogów i braku katalogu; rozmiar dla ludzi.
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const { paczkaProgramu, rozmiarDlaLudzi, wybierzPaczke } = await import('./paczka')

describe('wybierzPaczke', () => {
  it('najwyższa wersja liczbowo, nie tekstowo', () => {
    expect(wybierzPaczke(['Kompletor-Druk-0.9.0-win-x64.zip', 'Kompletor-Druk-0.10.0-win-x64.zip', 'Kompletor-Druk-0.2.1-win-x64.zip'])).toEqual({
      nazwa: 'Kompletor-Druk-0.10.0-win-x64.zip',
      wersja: '0.10.0',
    })
  })

  it('nazwy spoza wzoru pomijane', () => {
    expect(
      wybierzPaczke([
        'Kompletor-Druk-9.9.9-win-x64.zip.part',
        'kompletor-druk-9.0.0-win-x64.zip',
        'Kompletor-Druk-9.0-win-x64.zip',
        '../Kompletor-Druk-9.0.0-win-x64.zip',
        'Kompletor-Druk-9.0.0-win-arm64.zip',
        'Kompletor-Druk-0.2.0-win-x64.zip',
      ]),
    ).toEqual({ nazwa: 'Kompletor-Druk-0.2.0-win-x64.zip', wersja: '0.2.0' })
    expect(wybierzPaczke(['notatki.txt'])).toBeNull()
    expect(wybierzPaczke([])).toBeNull()
  })
})

describe('paczkaProgramu', () => {
  it('brak zmiennej albo katalogu = null', async () => {
    expect(await paczkaProgramu(undefined)).toBeNull()
    expect(await paczkaProgramu('  ')).toBeNull()
    expect(await paczkaProgramu(path.join(tmpdir(), 'brak-katalogu-paczki-xyz'))).toBeNull()
  })

  it('plik z katalogu: nazwa, wersja, rozmiar; podkatalog o nazwie według wzoru pomijany', async () => {
    const kat = await mkdtemp(path.join(tmpdir(), 'paczka-druku-'))
    expect(await paczkaProgramu(kat)).toBeNull()
    await writeFile(path.join(kat, 'Kompletor-Druk-0.1.0-win-x64.zip'), Buffer.alloc(10))
    await writeFile(path.join(kat, 'Kompletor-Druk-0.2.0-win-x64.zip'), Buffer.alloc(1234))
    await writeFile(path.join(kat, 'Kompletor-Druk-5.0.0-win-x64.zip.tmp'), Buffer.alloc(1))
    await mkdir(path.join(kat, 'Kompletor-Druk-7.0.0-win-x64.zip'))
    const p = await paczkaProgramu(kat)
    expect(p).toMatchObject({ nazwa: 'Kompletor-Druk-0.2.0-win-x64.zip', wersja: '0.2.0', rozmiar: 1234 })
    expect(p!.sciezka).toBe(path.join(kat, 'Kompletor-Druk-0.2.0-win-x64.zip'))
  })
})

describe('rozmiarDlaLudzi', () => {
  it('MB z jednym miejscem po przecinku, małe pliki w KB', () => {
    expect(rozmiarDlaLudzi(44_564_480)).toBe('42,5 MB')
    expect(rozmiarDlaLudzi(1024 * 1024)).toBe('1,0 MB')
    expect(rozmiarDlaLudzi(1500)).toBe('1 KB')
    expect(rozmiarDlaLudzi(0)).toBe('1 KB')
  })
})
