// preset firmy jako plik JSON: walidacja przykładu, komunikaty błędów, ścieżki i nakładka prywatna.
// Test presetu prywatnej firmy (plik w nakładce) leży osobno w lib/preset-plik-nakladka.test.ts.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PresetError, katalogPresetow, presetZJson, sciezkaPresetu, wczytajPreset } from './preset-plik'
import { NAZWY_FIRM_W_TRESCI } from '@/tests/straznik-nazw'

describe('preset firmy z pliku JSON', () => {
  it('przyklad.json (dane fikcyjne) jest w repo i przechodzi walidację', async () => {
    const p = await wczytajPreset(path.join(katalogPresetow(), 'przyklad.json'))
    expect(p.slug).toBe('przyklad')
    expect(JSON.stringify(p)).not.toContain('_komentarz')
    // przykład z neutralnymi strefami (bez nazw sklepów i ich asortymentu)
    expect(p.zones!.length).toBeGreaterThan(0)
    expect(p.zones!.map((z) => z.name).join(' ')).not.toMatch(NAZWY_FIRM_W_TRESCI)
  })

  it('brak pliku, zły JSON, nieznany klucz, zła wartość: PresetError z nazwą pola', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'preset-'))
    await expect(wczytajPreset(path.join(dir, 'nie-ma.json'))).rejects.toThrow(/Brak pliku presetu/)
    await writeFile(path.join(dir, 'zly.json'), '{ "id": ')
    await expect(wczytajPreset(path.join(dir, 'zly.json'))).rejects.toThrow(/Zły JSON/)
    const baza = { id: 'firma_x', slug: 'firma-x', name: 'Firma X' }
    expect(() => presetZJson({ ...baza, kanaly: [] })).toThrow(/nieznany klucz „kanaly”/)
    expect(() => presetZJson({ ...baza, channels: [{ channel: 'SKLEP', channelAccountId: '1', name: 'x' }] })).toThrow(/channels\[0\]\.channel/)
    expect(() => presetZJson({ ...baza, carrierRules: [{ priority: 1, channel: null, carrier: 'DPD', shippingModule: 'BRAK' }] })).toThrow(/pattern: wymagane/)
    expect(() => presetZJson({ ...baza, carrierPickups: [{ carrier: 'DPD', weekdays: ['pon'], pickupMinute: 1, promiseUntilMinute: 0, active: true }] })).toThrow(/weekdays/)
    // statusy firmy — typy pól i enumy
    expect(() => presetZJson({ ...baza, statuses: [{ key: 'A', name: 'A', color: 'szary', sortOrder: 1, baseStatus: 'GOTOWE' }] })).toThrow(/statuses\[0\]\.baseStatus/)
    expect(() => presetZJson({ ...baza, statuses: [{ key: 'A', name: 'A', color: 'szary', sortOrder: 1, baseStatus: 'NOWE', carriers: ['POCZTA'] }] })).toThrow(/statuses\[0\]\.carriers/)
    expect(() => presetZJson({ ...baza, statusGroups: [{ key: 'G', name: 'G', sortOrder: 1, zwinieta: true }] })).toThrow(/nieznany klucz „zwinieta”/)
    await writeFile(path.join(dir, 'slug.json'), JSON.stringify({ ...baza, slug: '-zly' }))
    await expect(wczytajPreset(path.join(dir, 'slug.json'))).rejects.toBeInstanceOf(PresetError)
  })

  it('ścieżka: nazwa tylko [a-z0-9-], KOMPLETOR_PRESET_PLIK wygrywa', () => {
    expect(sciezkaPresetu('przyklad', {}, '/app')).toBe(path.join('/app', 'seed', 'presety', 'przyklad.json'))
    expect(() => sciezkaPresetu('../etc/passwd', {}, '/app')).toThrow(PresetError)
    expect(sciezkaPresetu('przyklad', { KOMPLETOR_PRESET_PLIK: '/konfiguracja/firma.json' }, '/app')).toBe(path.resolve('/app', '/konfiguracja/firma.json'))
  })

  it('ścieżka: prywatna nakładka prywatne/presety/<nazwa>.json, gdy publicznego pliku brak; publiczny wygrywa', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'nakladka-'))
    await mkdir(path.join(cwd, 'prywatne', 'presety'), { recursive: true })
    await mkdir(path.join(cwd, 'seed', 'presety'), { recursive: true })
    await writeFile(path.join(cwd, 'prywatne', 'presety', 'firma-x.json'), '{}')
    expect(sciezkaPresetu('firma-x', {}, cwd)).toBe(path.join(cwd, 'prywatne', 'presety', 'firma-x.json'))
    expect(sciezkaPresetu('firma-y', {}, cwd)).toBe(path.join(cwd, 'seed', 'presety', 'firma-y.json'))
    await writeFile(path.join(cwd, 'seed', 'presety', 'firma-x.json'), '{}')
    expect(sciezkaPresetu('firma-x', {}, cwd)).toBe(path.join(cwd, 'seed', 'presety', 'firma-x.json'))
  })
})
