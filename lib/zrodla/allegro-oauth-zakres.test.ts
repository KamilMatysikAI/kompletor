// zakres OAuth o złym kształcie pomijany z jednym wpisem diagnostycznym, bez wartości.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { refreshAllegroToken } from './allegro'

const odpowiedz = (scope: unknown) =>
  vi.fn(async () => new Response(JSON.stringify({ access_token: 'fikcyjny-a', refresh_token: 'fikcyjny-r', expires_in: 3600, scope }), { status: 200 }))
const klient = (fetch: ReturnType<typeof odpowiedz>) => ({ authUrl: 'https://allegro.pl.allegrosandbox.pl', clientId: 'id', clientSecret: 'sekret', userAgent: 'Test/1.0', fetch })

afterEach(() => vi.restoreAllMocks())

describe('zakres z odpowiedzi tokena Allegro', () => {
  it('dobry kształt = zakres; zły = pominięty z jednym wpisem bez wartości; brak = bez wpisu', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect((await refreshAllegroToken(klient(odpowiedz('allegro:api:orders:read  allegro:api:sale:offers:read')), 'r')).scope).toBe('allegro:api:orders:read allegro:api:sale:offers:read')
    expect((await refreshAllegroToken(klient(odpowiedz(undefined)), 'r')).scope).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
    expect((await refreshAllegroToken(klient(odpowiedz('ZŁY;zakres<script>')), 'r')).scope).toBeUndefined()
    expect((await refreshAllegroToken(klient(odpowiedz(['allegro:api:orders:read'])), 'r')).scope).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toMatch(/zakres pominięty \(zły kształt\)/)
    expect(String(warn.mock.calls[0]![0])).not.toMatch(/ZŁY|script/)
  })
})
