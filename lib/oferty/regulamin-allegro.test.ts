// regulamin Allegro (port validate_desc_data i sanitize_allegro_html ze skilla allegro-oferty).
import { describe, expect, it } from 'vitest'
import { oczyscHtmlAllegro, poprawTytulAllegro, sprawdzOpisAllegro, sprawdzTekstAllegro, sprawdzTytulAllegro } from './regulamin-allegro'

const kody = (p: { kod: string }[]) => p.map((x) => x.kod)

describe('tytuł Allegro', () => {
  it('poprawny tytuł z polskimi znakami nie ma problemów', () => {
    expect(sprawdzTytulAllegro('Przyprawa zielona liściasta Kurkuma z Japonii 100 g')).toEqual([])
  })
  it('wykrzyknik w tytule to błąd', () => {
    const p = sprawdzTytulAllegro('Kurkuma mielona 100 g, świeży zbiór!')
    expect(p).toContainEqual(expect.objectContaining({ kod: 'tytul_wykrzyknik', waga: 'blad', pole: 'tytul' }))
  })
  it('znaki @ [ ], CAPS i długość ponad 75 znaków to błędy', () => {
    expect(kody(sprawdzTytulAllegro('Przyprawa [Kurkuma] zielona 100 g'))).toContain('tytul_znaki')
    expect(kody(sprawdzTytulAllegro('Przyprawa ZIELONA Kurkuma 100 g'))).toContain('tytul_caps')
    expect(kody(sprawdzTytulAllegro('Przyprawa EAN 100 g japońska'))).not.toContain('tytul_caps') // 3 litery to nie CAPS
    expect(kody(sprawdzTytulAllegro('ż'.repeat(76)))).toContain('tytul_dlugi')
    expect(kody(sprawdzTytulAllegro('ż'.repeat(75)))).not.toContain('tytul_dlugi')
    expect(kody(sprawdzTytulAllegro('Przyprawa'))).toEqual(['tytul_krotki'])
    expect(kody(sprawdzTytulAllegro(''))).toContain('tytul_pusty')
  })
  it('słowo marketingowe to ostrzeżenie, ale tylko całe słowo', () => {
    expect(sprawdzTytulAllegro('Kurkuma mielona 100 g hit sezonu')).toContainEqual(expect.objectContaining({ kod: 'slowo_marketingowe', waga: 'ostrzezenie' }))
    expect(kody(sprawdzTytulAllegro('Superfood papryka ceremonialna 30 g'))).not.toContain('slowo_marketingowe')
    expect(kody(sprawdzTytulAllegro('Darmowa wysyłka przyprawa zielona 100 g'))).toContain('slowo_marketingowe')
  })
  it('długie myślniki zamienia na zwykłe, nie ucina', () => {
    expect(poprawTytulAllegro('Lampa przyprawowa — serce  czerwone')).toBe('Lampa przyprawowa - serce czerwone')
    expect(poprawTytulAllegro('a'.repeat(80))).toHaveLength(80)
  })
})

describe('treść opisu Allegro', () => {
  it('link, e-mail, telefon, emoji i zachęta do sklepu to błędy', () => {
    expect(kody(sprawdzOpisAllegro('opis', '<p>Więcej na https://przyklad.test/przyprawa</p>'))).toContain('link')
    expect(kody(sprawdzOpisAllegro('opis', '<p>Napisz: sklep@przyklad.test</p>'))).toContain('email')
    expect(kody(sprawdzOpisAllegro('opis', '<p>Zadzwoń 600 100 200</p>'))).toContain('telefon')
    expect(kody(sprawdzOpisAllegro('opis', '<p>Pyszna przyprawa ✅</p>'))).toContain('emoji')
    expect(kody(sprawdzOpisAllegro('opis', '<p>Zapraszamy do naszego sklepu po więcej</p>'))).toContain('wezwanie_poza_allegro')
    expect(kody(sprawdzOpisAllegro('opis', '<p>Sprawdz inne oferty</p>'))).toContain('wezwanie_poza_allegro') // także bez ogonków
  })
  it('link schowany w <a href> też jest błędem', () => {
    expect(sprawdzOpisAllegro('opis', '<p><a href="https://przyklad.test">nasz blog</a></p>')).toContainEqual(expect.objectContaining({ kod: 'link', waga: 'blad', pole: 'opis' }))
  })
  it('EAN w specyfikacji nie jest telefonem, polski tekst bez problemów', () => {
    expect(sprawdzTekstAllegro('specyfikacja', 'EAN: 5901234123457, waga 100 g')).toEqual([])
    expect(sprawdzTekstAllegro('opis', 'Łagodna, zielona przyprawa o świeżym, trawiastym smaku. Zdrowie w filiżance.')).toEqual([])
  })
  it('tekst bez polskich znaków to ostrzeżenie', () => {
    expect(kody(sprawdzTekstAllegro('opis', 'Przyprawa lisciasta z gorskich plantacji'))).toContain('bez_polskich_znakow')
  })
})

describe('oczyszczanie HTML dla Allegro', () => {
  it('zostawia tylko p, b, h1, h2, ul, ol, li bez atrybutów; strong → b; br → spacja', () => {
    const html = '<div class="x"><h2 style="color:red">Opis</h2><p>Przyprawa <strong>zielona</strong><br>z <span>Japonii</span> <a href="https://x.test">tu</a></p></div>'
    expect(oczyscHtmlAllegro(html)).toBe('<h2>Opis</h2><p>Przyprawa <b>zielona</b> z Japonii tu</p>')
  })
  it('usuwa skrypty i komentarze razem z treścią, escapuje tekst', () => {
    expect(oczyscHtmlAllegro('<p>A &amp; B</p><script>alert(1)</script><!-- x --><p>1 &lt; 2</p>')).toBe('<p>A &amp; B</p>\n<p>1 &lt; 2</p>')
  })
  it('domyka niezamknięte tagi i pomija zbędne zamknięcia', () => {
    expect(oczyscHtmlAllegro('<ul><li>jeden<li>dwa</ul></p>')).toBe('<ul><li>jeden</li><li>dwa</li></ul>')
    expect(oczyscHtmlAllegro('<p>tekst')).toBe('<p>tekst</p>')
  })
  it('pusty akapit znika, zwykły tekst zostaje', () => {
    expect(oczyscHtmlAllegro('<p> </p><p>Żółta przyprawa</p>')).toBe('<p>Żółta przyprawa</p>')
    expect(oczyscHtmlAllegro('')).toBe('')
  })
})
