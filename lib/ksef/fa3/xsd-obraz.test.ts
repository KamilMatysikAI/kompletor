// schematy FA(3) są w repo i trafiają do obrazu. Brak katalogu albo pliku = test
// czerwony (nie cichy pominięty): bez schematów wysyłka do KSeF odmawia (lib/ksef/wysylka.ts), więc ich brak w
// obrazie zatrzymałby wystawianie faktur.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { KSEF_XSD_DIR_DOMYSLNY, wczytajSchematy } from './xsd'

const ROOT = path.resolve(__dirname, '..', '..', '..')

describe('schematy FA(3) w repo i w obrazie', () => {
  it('katalog lib/ksef/xsd ma schemat FA(3) i wszystkie importy (wczytanie bez braków)', async () => {
    const w = await wczytajSchematy(path.join(ROOT, KSEF_XSD_DIR_DOMYSLNY))
    expect(w.powod).toBe('')
    expect(w.schematy).not.toBeNull()
    expect(w.schematy!.glowny.fileName).toBe('schemat_FA(3)_v1-0E.xsd')
    expect(w.schematy!.pozostale.map((p) => p.fileName).sort()).toEqual(['ElementarneTypyDanych_v10-0E.xsd', 'KodyKrajow_v10-0E.xsd', 'StrukturyDanych_v10-0E.xsd'])
  })

  it('Dockerfile kopiuje katalog XSD do obrazu (worker czyta go z /app/lib/ksef/xsd), a Next śledzi go w standalone', () => {
    const docker = readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8')
    expect(docker).toMatch(/^COPY --from=builder --chown=app:app \/app\/lib\/ksef\/xsd \.\/lib\/ksef\/xsd$/m)
    const next = readFileSync(path.join(ROOT, 'next.config.ts'), 'utf8')
    expect(next).toContain("'./lib/ksef/xsd/**'")
  })
})
