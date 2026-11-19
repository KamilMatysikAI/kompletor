// ZIP paczki Kompletor-Druk — zapis bez zależności (skrypty/paczka.mjs) i odczyt pliku z ZIP-a
// (SumatraPDF w wersji portable). Prawdziwe pobieranie i sumy sprawdza się lokalnie (docs/druk.md).
import { describe, expect, it } from 'vitest'

const modul = '../skrypty/paczka.mjs'
const { zapiszZip, czytajZZip, skryptDoPaczki } = (await import(modul)) as {
  zapiszZip: (w: { nazwa: string; dane: Buffer }[]) => Buffer
  czytajZZip: (zip: Buffer, nazwa: string) => Buffer
  skryptDoPaczki: (nazwa: string, dane: Buffer) => Buffer
}

describe('ZIP paczki', () => {
  it('zapis i odczyt: polskie nazwy (UTF-8), pliki ściśnięte i nie, puste', () => {
    const pliki = [
      { nazwa: 'Zainstaluj.cmd', dane: Buffer.from('@echo off\r\n'.repeat(50)) },
      { nazwa: 'sumatra/ZRODLA.txt', dane: Buffer.from('źródła: zażółć gęślą jaźń') },
      { nazwa: 'runtime/losowe.bin', dane: Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919) % 251)) },
      { nazwa: 'pusty.txt', dane: Buffer.alloc(0) },
    ]
    const zip = zapiszZip(pliki)
    expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    for (const p of pliki) expect(czytajZZip(zip, p.nazwa)).toEqual(p.dane)
    expect(() => czytajZZip(zip, 'nie-ma.exe')).toThrow(/nie ma pliku nie-ma\.exe/)
    // te same pliki = te same bajty (stała data w ZIP)
    expect(zapiszZip(pliki)).toEqual(zip)
  })
})

// skrypty w paczce zawsze CRLF, .ps1 z BOM — niezależnie od tego, jak git wypakował pliki
describe('skrypty w paczce', () => {
  const BOM = Buffer.from([0xef, 0xbb, 0xbf])
  it('.cmd z LF dostaje CRLF, istniejące CRLF się nie podwaja', () => {
    const wynik = skryptDoPaczki('Zainstaluj.cmd', Buffer.from('@echo off\nset A=1\r\necho ż\n'))
    expect(wynik.toString('utf8')).toBe('@echo off\r\nset A=1\r\necho ż\r\n')
  })
  it('.ps1 bez BOM dostaje BOM i CRLF; z BOM nie dostaje drugiego', () => {
    const bez = skryptDoPaczki('skrypty/start.ps1', Buffer.from('# zażółć\nWrite-Host 1\n'))
    expect(bez.subarray(0, 3)).toEqual(BOM)
    expect(bez.subarray(3).toString('utf8')).toBe('# zażółć\r\nWrite-Host 1\r\n')
    const z = skryptDoPaczki('skrypty/start.ps1', Buffer.concat([BOM, Buffer.from('a\r\nb\n')]))
    expect(z).toEqual(Buffer.concat([BOM, Buffer.from('a\r\nb\r\n')]))
  })
  it('inne pliki bez zmian (bajt w bajt)', () => {
    const dane = Buffer.from('linia\nlinia\n')
    expect(skryptDoPaczki('dist/main.js', dane)).toBe(dane)
    expect(skryptDoPaczki('README.md', dane)).toBe(dane)
  })
})
