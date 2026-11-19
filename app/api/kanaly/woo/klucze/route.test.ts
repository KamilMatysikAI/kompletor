// trasa kluczy ze sklepu Woo — odmowy bez dotykania bazy (za duże ciało, nie JSON, zły podpis), tylko POST.
import { describe, expect, it } from 'vitest'
import { GET, POST } from './route'

const req = (body: string, headers: Record<string, string> = { 'content-type': 'application/json' }) => new Request('https://panel.example.pl/api/kanaly/woo/klucze', { method: 'POST', body, headers })

describe('POST /api/kanaly/woo/klucze', () => {
  it('za duże ciało, śmieci i zły podpis = 4xx z samym kodem wyniku', async () => {
    const duze = await POST(req(JSON.stringify({ user_id: 'x'.repeat(10_000) })))
    expect(duze.status).toBe(400)
    expect(await (await POST(req('to nie json'))).json()).toEqual({ ok: false, kod: 'zly-ksztalt' })
    const zly = await POST(req(JSON.stringify({ key_id: 1, user_id: 'w1.1.abcdefghijk.' + 'A'.repeat(43), consumer_key: `ck_${'1'.repeat(40)}`, consumer_secret: `cs_${'2'.repeat(40)}`, key_permissions: 'read' })))
    expect(zly.status).toBe(403)
    const tresc = await zly.text()
    expect(tresc).not.toContain('ck_')
    expect(zly.headers.get('cache-control')).toBe('no-store')
  })
  it('nagłówek content-length ponad 8 KB = 400 bez czytania ciała', async () => {
    // małe ciało ze złym podpisem: przeczytane dałoby 403, więc 400 znaczy, że odmówił sam nagłówek
    const maleCialo = JSON.stringify({ key_id: 1, user_id: 'w1.1.abcdefghijk.' + 'A'.repeat(43), consumer_key: `ck_${'1'.repeat(40)}`, consumer_secret: `cs_${'2'.repeat(40)}`, key_permissions: 'read' })
    expect((await POST(req(maleCialo))).status).toBe(403)
    const r = req(maleCialo)
    // Request sam liczy content-length, więc nagłówek z deklarowaną długością dokładamy jak serwer HTTP przed trasą
    const zNaglowkiem = new Proxy(r, { get: (t, p) => (p === 'headers' ? new Headers({ 'content-type': 'application/json', 'content-length': String(8 * 1024 + 1) }) : Reflect.get(t, p, t)) })
    const w = await POST(zNaglowkiem)
    expect(w.status).toBe(400)
    expect(await w.json()).toEqual({ ok: false, kod: 'zly-ksztalt' })
  })
  it('formularz zamiast JSON = 400 (WooCommerce wysyła tylko JSON)', async () => {
    const form = new URLSearchParams({ key_id: '1', user_id: 'w1.1.abcdefghijk.' + 'A'.repeat(43), consumer_key: `ck_${'1'.repeat(40)}`, consumer_secret: `cs_${'2'.repeat(40)}`, key_permissions: 'read' })
    const w = await POST(req(form.toString(), { 'content-type': 'application/x-www-form-urlencoded' }))
    expect(w.status).toBe(400)
    expect(await w.json()).toEqual({ ok: false, kod: 'zly-ksztalt' })
  })
  it('GET = 405', async () => {
    expect(GET().status).toBe(405)
  })
})
