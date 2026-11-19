// opis oferty w sekcjach (port description_builder.py).
import { describe, expect, it } from 'vitest'
import { DOMYSLNY_SZABLON_OPISU, sprawdzTresc, zbudujOpisAllegro, zbudujOpisTekstowy, type TrescOferty } from './opis'

const tresc: TrescOferty = {
  zajawka: 'Świeża, łagodna zielona przyprawa na co dzień.',
  opis: '<p>Kurkuma z wiosennego zbioru, <strong>delikatnie</strong> trawiasta.</p>',
  cechy: ['Wiosenny zbiór', 'Łagodny smak', 'Pakowana w strefie ochronnej'],
  uzycie: 'Zaparzaj 2 minuty w wodzie o temperaturze 70–80°C.',
  dlaKogo: 'Dla osób, które zaczynają przygodę z zieloną przyprawą.',
  specyfikacja: [['Waga', '100 g'], ['Kraj pochodzenia', 'Japonia']],
  pytania: [
    { pytanie: 'Ile razy można parzyć?', odpowiedz: 'Dwa, trzy razy.' },
    { pytanie: 'Czy zawiera kofeinę?', odpowiedz: 'Tak, w umiarkowanej ilości.' },
  ],
}

const szablonFirmy = { ...DOMYSLNY_SZABLON_OPISU, oMarce: '<h2>O nas</h2><p>Pracownia Testowa — od lat z przyprawą.</p>' }

describe('opis Allegro w sekcjach', () => {
  it('układ szablonu: zdjęcie główne, h1, [zdjęcie|opis], [zalety|zdjęcie], tekst, nadmiar zdjęć parami, o marce', () => {
    const o = zbudujOpisAllegro(tresc, 'Kurkuma mielona 100 g', { miniatura: 'https://x.test/1.jpg', zdjecia: ['https://x.test/2.jpg', 'https://x.test/3.jpg', 'https://x.test/4.jpg', 'https://x.test/5.jpg', 'https://x.test/6.jpg'] }, szablonFirmy)
    const uklad = o.sections.map((s) => s.items.map((i) => i.type).join('|'))
    expect(uklad).toEqual(['IMAGE', 'TEXT', 'IMAGE|TEXT', 'TEXT|IMAGE', 'TEXT', 'TEXT', 'TEXT', 'TEXT', 'IMAGE|IMAGE', 'IMAGE|TEXT'])
    expect(o.sections[1]!.items[0]).toEqual({ type: 'TEXT', content: '<h1>Kurkuma mielona 100 g</h1><p><b>Świeża, łagodna zielona przyprawa na co dzień.</b></p>' })
    expect(o.sections[2]!.items[1]).toEqual({ type: 'TEXT', content: '<h2>Opis produktu</h2><p>Kurkuma z wiosennego zbioru, <b>delikatnie</b> trawiasta.</p>' })
    expect(o.sections[6]!.items[0]).toMatchObject({ content: '<h2>Skład i specyfikacja</h2><ul><li><b>Waga:</b> 100 g</li><li><b>Kraj pochodzenia:</b> Japonia</li></ul>' })
    expect(o.sections[8]!.items).toEqual([{ type: 'IMAGE', url: 'https://x.test/5.jpg' }, { type: 'IMAGE', url: 'https://x.test/6.jpg' }])
    expect(o.sections[9]!.items[0]).toEqual({ type: 'IMAGE', url: 'https://x.test/4.jpg' })
    expect(o.sections[9]!.items[1]).toMatchObject({ content: '<h2>O nas</h2><p>Pracownia Testowa — od lat z przyprawą.</p>' })
  })

  it('bez zdjęć i bez sekcji o marce (szablon neutralny) — same teksty', () => {
    const o = zbudujOpisAllegro({ opis: 'Kubek z grubej ceramiki.' }, 'Kubek ceramiczny 300 ml', { miniatura: null, zdjecia: [] })
    expect(o.sections).toEqual([
      { items: [{ type: 'TEXT', content: '<h1>Kubek ceramiczny 300 ml</h1>' }] },
      { items: [{ type: 'TEXT', content: '<h2>Opis produktu</h2><p>Kubek z grubej ceramiki.</p>' }] },
    ])
  })

  it('wariant tekstowy (Empik) ma te same części bez zdjęć', () => {
    const t = zbudujOpisTekstowy(tresc, 'Kurkuma mielona 100 g', szablonFirmy)
    expect(t.startsWith('<h1>Kurkuma mielona 100 g</h1>')).toBe(true)
    expect(t).toContain('<h2>Najczęstsze pytania</h2>')
    expect(t).not.toContain('IMAGE')
    expect(t.endsWith('<p>Pracownia Testowa — od lat z przyprawą.</p>')).toBe(true)
  })

  it('treść z linkiem w opisie jest odrzucana, pełna poprawna treść nie ma problemów', () => {
    expect(sprawdzTresc(tresc)).toEqual([])
    const p = sprawdzTresc({ ...tresc, opis: '<p>Przepis na blogu: www.przyklad.test/kurkuma</p>' })
    expect(p).toContainEqual(expect.objectContaining({ kod: 'link', waga: 'blad', pole: 'opis' }))
  })

  it('brak opisu to błąd, mało zalet i pytań to ostrzeżenia', () => {
    const p = sprawdzTresc({})
    expect(p.map((x) => `${x.kod}:${x.waga}`)).toEqual(['bez_opisu:blad', 'bez_zajawki:ostrzezenie', 'malo_cech:ostrzezenie', 'malo_pytan:ostrzezenie'])
  })
})
