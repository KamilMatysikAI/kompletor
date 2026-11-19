// błąd wydruku — strona HTML dla przeglądarki, JSON dla kodu, treść escapowana.
import { describe, expect, it } from 'vitest'
import { chceStronyHtml, odmowaDostepu, odpowiedzBleduWydruku, stronaBleduWydruku } from './blad-wydruku'

const req = (accept?: string) => new Request('http://localhost/api/wydruki/karty', { method: 'POST', headers: accept ? { accept } : {} })
const FORMULARZ = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'

describe('błąd wydruku', () => {
  it('przeglądarka (formularz w nowej karcie) dostaje stronę HTML po polsku z tym samym statusem', async () => {
    const r = odpowiedzBleduWydruku(req(FORMULARZ), { status: 422, tytul: 'Nie udało się wydrukować kart', komunikat: 'Zamówienie SD 1 nie ma towaru.' })
    expect(r.status).toBe(422)
    expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8')
    const html = await r.text()
    expect(html).toContain('<html lang="pl">')
    expect(html).toContain('Nie udało się wydrukować kart')
    expect(html).toContain('Zamówienie SD 1 nie ma towaru.')
    expect(html).toContain('Wróć do zamówień')
    expect(html).toContain('Zamknij kartę')
    expect(html).not.toContain('"error"')
  })

  it('fetch (Accept bez text/html albo brak nagłówka) dostaje JSON { error } jak dotąd', async () => {
    for (const a of ['application/json', '*/*', undefined]) {
      const r = odpowiedzBleduWydruku(req(a), { status: 409, tytul: 'T', komunikat: 'Komunikat' })
      expect(r.status).toBe(409)
      expect(await r.json()).toEqual({ error: 'Komunikat' })
    }
    expect(chceStronyHtml(req(FORMULARZ))).toBe(true)
    expect(chceStronyHtml(req('application/json'))).toBe(false)
  })

  it('treść z kanału (numer zamówienia) jest escapowana', () => {
    const html = stronaBleduWydruku({ status: 422, tytul: 'T', komunikat: 'ALG <script>alert(1)</script> & "x"' })
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;')
  })

  it('odmowa dostępu: dla przeglądarki strona z „Zaloguj się” przy 401, dla kodu oryginalny JSON', async () => {
    const odp = Response.json({ error: 'Wymagane logowanie' }, { status: 401 })
    const html = odmowaDostepu(req(FORMULARZ), odp, 'Nie udało się wydrukować kart', 'wydrukuj karty')
    expect(html.status).toBe(401)
    expect(await html.text()).toMatch(/Sesja wygasła[\s\S]*href="\/logowanie"/)
    expect(odmowaDostepu(req('application/json'), odp, 'T', 'x')).toBe(odp)
    const brak = odmowaDostepu(req(FORMULARZ), Response.json({ error: 'Nie znaleziono' }, { status: 404 }), 'T', 'x')
    expect(brak.status).toBe(404)
    expect(await brak.text()).toContain('nie ma dostępu do tego wydruku')
  })
})
