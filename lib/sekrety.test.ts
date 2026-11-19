import { describe, expect, it } from 'vitest'
import { encryptionKeysFromEnv, encryptionKeysStatus, keyCoverage, openSecret, SecretError, sealSecret } from './sekrety'

const KEY_HEX = 'a'.repeat(64)
const key = encryptionKeysFromEnv({ APP_ENCRYPTION_KEY: KEY_HEX })

describe('sekrety: AES-256-GCM', () => {
  it('szyfruje i odszyfrowuje; szyfrogram nie zawiera tekstu jawnego; każde szyfrowanie ma inne IV', () => {
    const a = sealSecret(key, 'firma_a', 'BASELINKER_TOKEN', 'tajny-token-123')
    const b = sealSecret(key, 'firma_a', 'BASELINKER_TOKEN', 'tajny-token-123')
    expect(Buffer.from(a.ciphertext).toString('utf8')).not.toContain('tajny')
    expect(Buffer.from(a.iv).equals(Buffer.from(b.iv))).toBe(false)
    expect(openSecret(key, 'firma_a', 'BASELINKER_TOKEN', a)).toBe('tajny-token-123')
  })

  it('szyfrogram innej firmy albo pod inną nazwą nie da się odczytać (AAD), błąd bez wartości', () => {
    const s = sealSecret(key, 'firma_a', 'WFIRMA_APP_KEY', 'wartosc-a')
    expect(() => openSecret(key, 'firma_b', 'WFIRMA_APP_KEY', s)).toThrow(SecretError)
    expect(() => openSecret(key, 'firma_a', 'WFIRMA_SECRET_KEY', s)).toThrow(SecretError)
    try {
      openSecret(key, 'firma_b', 'WFIRMA_APP_KEY', s)
    } catch (e) {
      expect((e as Error).message).not.toContain('wartosc-a')
    }
  })

  it('inny klucz główny albo zmieniony szyfrogram → błąd', () => {
    const s = sealSecret(key, 'f', 'X_KEY', 'abc')
    const other = encryptionKeysFromEnv({ APP_ENCRYPTION_KEY: 'b'.repeat(64) })
    expect(() => openSecret(other, 'f', 'X_KEY', s)).toThrow(SecretError)
    const bad = { ...s, ciphertext: Uint8Array.from(s.ciphertext, (x, i) => (i === 0 ? x ^ 1 : x)) }
    expect(() => openSecret(key, 'f', 'X_KEY', bad)).toThrow(SecretError)
  })

  it('klucz główny: wymagany, 32 bajty (hex albo base64)', () => {
    expect(() => encryptionKeysFromEnv({})).toThrow(/APP_ENCRYPTION_KEY/)
    expect(() => encryptionKeysFromEnv({ APP_ENCRYPTION_KEY: 'za-krotki' })).toThrow(/32 bajty/)
    const r = encryptionKeysFromEnv({ APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') })
    expect(r.current).toBe(1)
    expect(r.keys.get(1)).toHaveLength(32)
  })
})

describe('sekrety: rotacja klucza głównego', () => {
  const V1 = 'a'.repeat(64)
  const V2 = 'b'.repeat(64)
  const v1Only = encryptionKeysFromEnv({ APP_ENCRYPTION_KEY: V1 })
  const both = encryptionKeysFromEnv({ APP_ENCRYPTION_KEYS: `2:${V2},1:${V1}`, APP_ENCRYPTION_KEY: V1 })
  const v2Only = encryptionKeysFromEnv({ APP_ENCRYPTION_KEYS: `2:${V2}` })

  it('wpis v1 czyta się kluczem v1 także po dodaniu v2; nowy zapis dostaje v2', () => {
    const old = sealSecret(v1Only, 'f', 'X_KEY', 'stara-wartosc')
    expect(old.keyVersion).toBe(1)
    expect(both.current).toBe(2)
    expect(openSecret(both, 'f', 'X_KEY', old)).toBe('stara-wartosc')
    const fresh = sealSecret(both, 'f', 'X_KEY', 'nowa-wartosc')
    expect(fresh.keyVersion).toBe(2)
    expect(openSecret(v2Only, 'f', 'X_KEY', fresh)).toBe('nowa-wartosc')
    // wpis v2 nie otworzy się kluczem v1 ani podpisany jako v1 (wersja wybiera klucz, nie zgadujemy)
    expect(() => openSecret(v1Only, 'f', 'X_KEY', fresh)).toThrow(/kluczem v2, którego nie ma/)
    expect(() => openSecret(both, 'f', 'X_KEY', { ...fresh, keyVersion: 1 })).toThrow(/Nie da się odszyfrować/)
  })

  it('po usunięciu v1 z env wpis v1 = czytelny błąd z wersją, bez wartości', () => {
    const old = sealSecret(v1Only, 'f', 'X_KEY', 'stara-wartosc')
    let msg = ''
    try {
      openSecret(v2Only, 'f', 'X_KEY', old)
    } catch (e) {
      expect(e).toBeInstanceOf(SecretError)
      msg = (e as Error).message
    }
    expect(msg).toMatch(/v1.*nie ma.*są: v2/)
    expect(msg).not.toContain('stara-wartosc')
  })

  it('APP_ENCRYPTION_KEYS: format, kolejność malejąca, zgodność z APP_ENCRYPTION_KEY', () => {
    expect([...encryptionKeysFromEnv({ APP_ENCRYPTION_KEYS: ` 3:${V2} , 1:${Buffer.alloc(32, 7).toString('base64')} ` }).keys.keys()]).toEqual([3, 1])
    expect(() => encryptionKeysFromEnv({ APP_ENCRYPTION_KEYS: V2 })).toThrow(/<wersja>:<klucz>/)
    expect(() => encryptionKeysFromEnv({ APP_ENCRYPTION_KEYS: `0:${V2}` })).toThrow(/<wersja>:<klucz>/)
    expect(() => encryptionKeysFromEnv({ APP_ENCRYPTION_KEYS: `1:${V1},2:${V2}` })).toThrow(/malejąco/)
    expect(() => encryptionKeysFromEnv({ APP_ENCRYPTION_KEYS: `2:${V2},2:${V1}` })).toThrow(/malejąco/)
    expect(() => encryptionKeysFromEnv({ APP_ENCRYPTION_KEYS: `2:za-krotki` })).toThrow(/v2 musi mieć dokładnie 32 bajty/)
    // APP_ENCRYPTION_KEY = v1: musi się zgadzać, a po usunięciu v1 z listy ma zniknąć z env
    expect(() => encryptionKeysFromEnv({ APP_ENCRYPTION_KEYS: `2:${V2},1:${V1}`, APP_ENCRYPTION_KEY: 'c'.repeat(64) })).toThrow(/różni się od klucza v1/)
    expect(() => encryptionKeysFromEnv({ APP_ENCRYPTION_KEYS: `2:${V2}`, APP_ENCRYPTION_KEY: V1 })).toThrow(/usuń APP_ENCRYPTION_KEY/)
  })

  it('stan kluczy na start workera i /api/health: ok / none / error, komunikat bez materiału klucza', () => {
    expect(encryptionKeysStatus({ APP_ENCRYPTION_KEY: V1 }).status).toBe('ok')
    expect(encryptionKeysStatus({ APP_ENCRYPTION_KEYS: `2:${V2},1:${V1}`, APP_ENCRYPTION_KEY: V1 }).ring?.current).toBe(2)
    // self-host bez klucza (sekrety źródeł w env) = dozwolone; hosting bez klucza = błąd
    expect(encryptionKeysStatus({ APP_ENCRYPTION_KEYS: ' ' })).toEqual({ status: 'none' })
    expect(encryptionKeysStatus({ APP_MODE: 'hosted' }).status).toBe('error')
    // krok 3 README z zapomnianym APP_ENCRYPTION_KEY, literówka w separatorze, krótki klucz
    const forgotten = encryptionKeysStatus({ APP_ENCRYPTION_KEYS: `2:${V2}`, APP_ENCRYPTION_KEY: V1 })
    expect(forgotten.status).toBe('error')
    expect(forgotten.message).toMatch(/usuń APP_ENCRYPTION_KEY/)
    expect(forgotten.message).not.toContain(V1.slice(0, 8))
    expect(encryptionKeysStatus({ APP_ENCRYPTION_KEYS: `2;${V2}` }).status).toBe('error')
    expect(encryptionKeysStatus({ APP_ENCRYPTION_KEYS: `2:${'d'.repeat(62)}` }).status).toBe('error')
  })

  it('zły APP_MODE = error ze stanem, nie wyjątek (health odpowiada JSON-em; drugi przegląd)', () => {
    const r = encryptionKeysStatus({ APP_MODE: 'cos-innego' }) // bez kluczy tryb decyduje: none czy error
    expect(r.status).toBe('error')
    expect(r.message).toBeTruthy()
    expect(encryptionKeysStatus({ APP_ENCRYPTION_KEY: V1 }).ring?.current).toBe(1)
  })

  it('keyCoverage: wersje wpisów z bazy muszą być w pierścieniu z env, komunikat tylko z wersjami', () => {
    expect(keyCoverage(v1Only, [])).toEqual({ status: 'ok' })
    expect(keyCoverage(v1Only, [1, 1])).toEqual({ status: 'ok' })
    expect(keyCoverage(both, [2, 1])).toEqual({ status: 'ok' })
    expect(keyCoverage(v2Only, [2])).toEqual({ status: 'ok' })
    // krok 3 README: skasowany APP_ENCRYPTION_KEYS zamiast APP_ENCRYPTION_KEY → pierścień {v1}, wpisy v2
    const wrongVar = keyCoverage(v1Only, [2])
    expect(wrongVar.status).toBe('error')
    expect(wrongVar.message).toMatch(/kluczem v2, a w env są tylko: v1 — przywróć APP_ENCRYPTION_KEYS z v2/)
    expect(keyCoverage(v2Only, [2, 1]).message).toMatch(/kluczem v1,/)
    // brak klucza w env (`none`): ok tylko przy pustej tabeli sekretów
    expect(keyCoverage(null, [])).toEqual({ status: 'ok' })
    const none = keyCoverage(null, [1, 2])
    expect(none.status).toBe('error')
    expect(none.message).toMatch(/kluczem v2, v1, a w env nie ma żadnego klucza/)
    for (const m of [wrongVar.message, none.message]) expect(m).not.toMatch(/aaaaaaaa|bbbbbbbb/)
  })
})
