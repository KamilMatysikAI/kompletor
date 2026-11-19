// Numer nadania na karcie i listach: link do śledzenia u przewoźnika, gdy jest adres, w innym razie sam tekst.
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NumerNadania } from './numer-nadania'

describe('NumerNadania', () => {
  it('z adresem: link w nowej karcie, bez dostępu strony do okna', () => {
    const t = renderToStaticMarkup(h(NumerNadania, { numer: '620999667762053436691541', href: 'https://inpost.pl/sledzenie-przesylek?number=620999667762053436691541', className: 'mono' }))
    expect(t).toContain('href="https://inpost.pl/sledzenie-przesylek?number=620999667762053436691541"')
    expect(t).toContain('target="_blank"')
    expect(t).toContain('rel="noopener noreferrer"')
    expect(t).toContain('class="mono"')
    expect(t).toContain('>620999667762053436691541<')
  })

  it('bez adresu: sam tekst', () => {
    expect(renderToStaticMarkup(h(NumerNadania, { numer: '12345678901', href: null, className: 'mono' }))).toBe('<span class="mono">12345678901</span>')
    expect(renderToStaticMarkup(h(NumerNadania, { numer: 'ABC123456', href: undefined }))).toBe('<span>ABC123456</span>')
  })
})
