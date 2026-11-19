// parser feedu produktowego Google Merchant na plikach testowych z danymi zmyślonymi (tests/feed/).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BladFeedu, dekodujBajty, parsujFeed } from './feed'
import { MAX_Z_OFERTY } from './zdjecia-url'

const plik = (n: string) => readFileSync(path.join(__dirname, '..', '..', 'tests', 'feed', n))

describe('parsujFeed', () => {
  it('RSS 2.0 z przestrzenią nazw g:: id, mpn, gtin, grupa, nazwa i zdjęcia w kolejności; bez g:id pominięte', () => {
    const w = parsujFeed(plik('google-merchant-rss.xml'))
    expect(w.format).toBe('rss')
    expect(w.bezId).toBe(1)
    expect(w.pozycje.map((p) => p.id)).toEqual(['501', '502', '611', 'T-0004', '700'])
    expect(w.pozycje[0]).toEqual({
      id: '501',
      mpn: 'T-0001',
      tytul: 'Przyprawa Zielona Próbna 100 g',
      zdjecia: ['https://sklep.example.test/zdjecia/501.webp', 'https://sklep.example.test/zdjecia/501-b.webp', 'https://sklep.example.test/zdjecia/501-c.webp'],
    })
    // CDATA dosłownie, polskie znaki zostają
    expect(w.pozycje[1]).toMatchObject({ id: '502', gtin: '5901234123457', tytul: 'Kubek „Ząbek” & spodek' })
    expect(w.pozycje[2]).toMatchObject({ id: '611', grupa: '610' })
    // pusty element zdjęcia = brak zdjęcia, encja &amp; rozwinięta
    expect(w.pozycje[4]).toMatchObject({ id: '700', zdjecia: [], tytul: 'Pozycja bez dopasowania & bez zdjęcia' })
  })

  it('Atom z innym przedrostkiem przestrzeni nazw Google; lista zdjęć dodatkowych po przecinku', () => {
    const w = parsujFeed(plik('google-merchant-atom.xml'))
    expect(w.format).toBe('atom')
    expect(w.pozycje).toEqual([
      { id: 'A-1', mpn: 'ATOM-SKU-1', tytul: 'Zestaw Próbny', zdjecia: ['https://sklep.example.test/atom/1.jpg', 'https://sklep.example.test/atom/1b.jpg', 'https://sklep.example.test/atom/1c.jpg'] },
    ])
  })

  it('DOCTYPE i ENTITY odrzucone w całości (XXE, rozwijanie encji)', () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss xmlns:g="${'http://base.google.com/ns/1.0'}"><channel><item><g:id>&x;</g:id></item></channel></rss>`
    expect(() => parsujFeed(xxe)).toThrow(BladFeedu)
    expect(() => parsujFeed('<rss><!ENTITY a "aaaa"><channel/></rss>')).toThrow(/DOCTYPE albo ENTITY/)
  })

  it('nieznane encje zostają tekstem, nie są rozwijane; encje liczbowe tak', () => {
    const w = parsujFeed('<rss xmlns:g="http://base.google.com/ns/1.0"><channel><item><g:id>1</g:id><g:title>A &x; &#261;&#x107;</g:title></item></channel></rss>')
    expect(w.pozycje[0]!.tytul).toBe('A &x; ąć')
  })

  it('strona HTML zamiast feedu = czytelny błąd (także z DOCTYPE html, przed odmową DTD)', () => {
    expect(() => parsujFeed('<!doctype html><html><body>Sklep</body></html>')).toThrow(/To nie jest feed produktowy/)
    expect(() => parsujFeed('\n  <!DOCTYPE html>\n<html lang="pl"><head></head></html>')).toThrow(/To nie jest feed produktowy/)
    expect(() => parsujFeed('<?xml version="1.0"?><!-- 404 --><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0//EN"><html/>')).toThrow(/To nie jest feed produktowy/)
    // DOCTYPE inny niż html dalej odmowa DTD
    expect(() => parsujFeed('<!DOCTYPE rss><rss/>')).toThrow(/DOCTYPE albo ENTITY/)
    expect(() => parsujFeed('<html><body>Sklep</body></html>')).toThrow(/To nie jest feed produktowy/)
    expect(() => parsujFeed('')).toThrow(BladFeedu)
  })

  it('wiele komentarzy na początku pliku nie blokuje parsera', () => {
    const t0 = Date.now()
    expect(parsujFeed('<!---->'.repeat(40) + '<rss/>').pozycje).toHaveLength(0)
    expect(() => parsujFeed('<!-- x -->'.repeat(300) + '<!doctype html><html/>')).toThrow(/To nie jest feed produktowy/)
    expect(Date.now() - t0).toBeLessThan(500)
  })

  it(`najwyżej ${MAX_Z_OFERTY} zdjęć na pozycję, bez powtórzeń`, () => {
    const dodatkowe = Array.from({ length: 10 }, (_, i) => `<g:additional_image_link>https://s.example.test/${i}.jpg</g:additional_image_link>`).join('')
    const w = parsujFeed(`<rss xmlns:g="http://base.google.com/ns/1.0"><channel><item><g:id>1</g:id><g:image_link>https://s.example.test/0.jpg</g:image_link>${dodatkowe}</item></channel></rss>`)
    expect(w.pozycje[0]!.zdjecia).toHaveLength(MAX_Z_OFERTY)
    expect(new Set(w.pozycje[0]!.zdjecia).size).toBe(MAX_Z_OFERTY)
  })

  it('złośliwy plik bez zamknięć czytany liniowo (bez kwadratowego czasu), pozycja ponad 1 mln znaków pominięta', () => {
    const NS = 'xmlns:g="http://base.google.com/ns/1.0"'
    const t0 = Date.now()
    expect(parsujFeed(`<rss ${NS}><channel>${'<item>'.repeat(300_000)}`).pozycje).toEqual([])
    expect(parsujFeed(`<rss ${NS}><channel><item>${'<g:id>'.repeat(150_000)}</item></channel></rss>`).bezId).toBe(1)
    expect(Date.now() - t0).toBeLessThan(3000)
    const duza = parsujFeed(`<rss ${NS}><channel><item><g:id>1</g:id>${'x'.repeat(1_000_001)}</item><item><g:id>2</g:id></item></channel></rss>`)
    expect(duza.pozycje.map((p) => p.id)).toEqual(['2'])
    expect(duza.ponadLimit).toBe(1)
    // nazwa z tym samym początkiem nie jest tym polem (g:id kontra g:identifier_exists)
    const w = parsujFeed(`<rss ${NS}><channel><item><g:identifier_exists>no</g:identifier_exists><g:id>7</g:id></item></channel></rss>`)
    expect(w.pozycje[0]!.id).toBe('7')
  })

  it('kodowanie z deklaracji XML (ISO-8859-2) i BOM', () => {
    const iso = Buffer.concat([Buffer.from('<?xml version="1.0" encoding="ISO-8859-2"?><rss xmlns:g="http://base.google.com/ns/1.0"><channel><item><g:id>1</g:id><g:title>'), Buffer.from([0xb1, 0xe6, 0xea]), Buffer.from('</g:title></item></channel></rss>')])
    expect(parsujFeed(iso).pozycje[0]!.tytul).toBe('ąćę')
    expect(dekodujBajty(Buffer.from('﻿<rss/>', 'utf8'))).toBe('<rss/>')
  })

  it('UTF-16 z BOM (eksport z Windows) czytany jak UTF-8', () => {
    const xml = '<?xml version="1.0" encoding="UTF-16"?><rss xmlns:g="http://base.google.com/ns/1.0"><channel><item><g:id>1</g:id><g:title>Przyprawa żółta</g:title></item></channel></rss>'
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')])
    expect(parsujFeed(le).pozycje[0]!.tytul).toBe('Przyprawa żółta')
    const be = Buffer.from(le)
    be.swap16()
    expect(parsujFeed(be).pozycje[0]!.tytul).toBe('Przyprawa żółta')
  })
})
