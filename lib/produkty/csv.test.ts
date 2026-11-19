// parser CSV katalogu (cudzysłowy, separator, BOM, nowe linie w polu) i osłona uploadu dla CSV.
import { describe, expect, it } from 'vitest'
import { CSV_POLICY, guardUploadBytes, IMAGE_POLICY } from '../files/upload-guard'
import { parsujCsv } from './csv'

describe('parsujCsv', () => {
  it('separator „;” z Excela PL, BOM, cudzysłowy, "" w polu, nowa linia w polu, puste wiersze pominięte', () => {
    const t = '﻿SKU;Nazwa;Opis\r\nA-1;"Przyprawa; zielona";"Linia 1\nLinia 2"\r\n\r\nB-2;"Kubek ""XL""";\r\n'
    expect(parsujCsv(t)).toEqual([
      ['SKU', 'Nazwa', 'Opis'],
      ['A-1', 'Przyprawa; zielona', 'Linia 1\nLinia 2'],
      ['B-2', 'Kubek "XL"', ''],
    ])
  })
  it('separator „,” i tabulator rozpoznane z nagłówka', () => {
    expect(parsujCsv('SKU,Nazwa\nA,"B, C"')).toEqual([['SKU', 'Nazwa'], ['A', 'B, C']])
    expect(parsujCsv('SKU\tNazwa\nA\tB')).toEqual([['SKU', 'Nazwa'], ['A', 'B']])
  })
})

describe('osłona uploadu: CSV', () => {
  const b = (s: string) => new TextEncoder().encode(s)
  it('tekst UTF-8 przyjęty; HTML, SVG, ZIP, binarny i zły UTF-8 odrzucone; za duży plik odrzucony', () => {
    expect(guardUploadBytes(b('SKU;Nazwa\nA;Zielona łąka\n'), CSV_POLICY)).toMatchObject({ ok: true, kind: 'csv', mime: 'text/csv' })
    expect(guardUploadBytes(b('<html><script>alert(1)</script>'), CSV_POLICY)).toMatchObject({ ok: false, code: 'markup' })
    expect(guardUploadBytes(b('<svg onload=x>'), CSV_POLICY)).toMatchObject({ ok: false, code: 'markup' })
    expect(guardUploadBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]), CSV_POLICY)).toMatchObject({ ok: false, code: 'zip' })
    expect(guardUploadBytes(new Uint8Array([65, 0, 66]), CSV_POLICY)).toMatchObject({ ok: false, code: 'wrong_type' })
    expect(guardUploadBytes(new Uint8Array([0x53, 0x4b, 0xff, 0xfe, 0x41]), CSV_POLICY)).toMatchObject({ ok: false, message: expect.stringContaining('UTF-8') })
    expect(guardUploadBytes(new Uint8Array(CSV_POLICY.maxBytes + 1).fill(65), CSV_POLICY)).toMatchObject({ ok: false, code: 'too_big' })
    // Excel „Tekst Unicode” (UTF-16 LE i BE z BOM) = podpowiedź o UTF-8, nie „nieobsługiwany rodzaj”
    const utf16le = new Uint8Array([0xff, 0xfe, ...Buffer.from('SKU;Nazwa\n', 'utf16le')])
    expect(guardUploadBytes(utf16le, CSV_POLICY)).toMatchObject({ ok: false, code: 'wrong_type', message: expect.stringContaining('Tekst Unicode') })
    expect(guardUploadBytes(new Uint8Array([0xfe, 0xff, 0, 0x53, 0, 0x4b]), CSV_POLICY)).toMatchObject({ ok: false, message: expect.stringContaining('UTF-8') })
    // polityka zdjęć: ten sam plik dalej jako zwykły „nieobsługiwany rodzaj”
    expect(guardUploadBytes(utf16le, IMAGE_POLICY)).toMatchObject({ ok: false, message: expect.stringContaining('Nieobsługiwany') })
  })
  it('polityka zdjęć dalej nie przyjmuje tekstu', () => {
    expect(guardUploadBytes(b('SKU;Nazwa'), IMAGE_POLICY)).toMatchObject({ ok: false, code: 'wrong_type' })
  })
})
