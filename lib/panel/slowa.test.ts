import { describe, expect, it } from 'vitest'
import { carrierFor } from '@/lib/rdzen/statusy'
import { ACME_CARRIER_RULES, ACME_EXAMPLE_ZONE_RULES } from '@/tests/preset-testowy'
import { poleZeWzorca, slowaDoZamiany, slowaZeWzorca, wzorzecZeSlow, wzorzecZPola } from './slowa'

describe('słowa zamiast wzorca', () => {
  it('słowa → wzorzec ze znakami specjalnymi jako tekst', () => {
    expect(wzorzecZeSlow('paczkomat, InPost ')).toBe('paczkomat|InPost')
    expect(wzorzecZeSlow('a.b, (c)')).toBe(String.raw`a\.b|\(c\)`)
    expect(wzorzecZeSlow(' , ')).toBe('')
    expect(new RegExp(wzorzecZeSlow('kurier 24h, salon empik'), 'i').test('Salon Empik Poznań')).toBe(true)
  })
  it('wzorzec z samych słów → słowa; inny → null (edycja jako wzorzec)', () => {
    expect(slowaZeWzorca('lamp|akcesori|zaparzacz')).toBe('lamp, akcesori, zaparzacz')
    expect(slowaZeWzorca('kaw[aiyę]|przypraw')).toBeNull()
    expect(slowaZeWzorca('dpd|kurier')).toBe('dpd, kurier')
    expect(slowaZeWzorca('salon(u)? empik')).toBeNull()
    expect(slowaZeWzorca('')).toBeNull()
  })
  it('pole formularza: tryb wzorzec zostaje bez zmian', () => {
    expect(wzorzecZPola('wzorzec', ' kaw[aiyę] ')).toBe('kaw[aiyę]')
    expect(wzorzecZPola('slowa', 'kawa, przyprawa')).toBe('kawa|przyprawa')
    // zgodność w obie strony: słowa → wzorzec → słowa
    expect(slowaZeWzorca(wzorzecZeSlow('kawa, przyprawa zielona'))).toBe('kawa, przyprawa zielona')
  })
})

describe('„Zamień na słowa” i zapis formularza bez zmian na wzorcach ACME', () => {
  // formularz: wzorzec z bazy → pole (poleZeWzorca) → zapis bez dotykania pola (wzorzecZPola; pusty = null jak w reguly.ts)
  const zapisBezZmian = (pattern: string | null) => {
    const p = poleZeWzorca(pattern)
    return wzorzecZPola(p.tryb, p.wartosc).trim() || null
  }

  it('wzorce ze znakami specjalnymi nie dają się zamienić na słowa; same słowa tak', () => {
    for (const w of ['salon(u)? empik', 'kaw[aiyę]', 'przypraw|kaw[aiyę]|papryka', 'pu-?erh', 'a.b', 'x*']) expect(slowaDoZamiany(w)).toBeNull()
    expect(slowaDoZamiany('lamp|łyżeczk|lizak')).toBe('lamp, łyżeczk, lizak')
    expect(wzorzecZeSlow(slowaDoZamiany('lamp|łyżeczk|lizak')!)).toBe('lamp|łyżeczk|lizak')
  })

  it('reguły przewoźników ACME: zapis formularza bez zmian = wzorce bit w bit jak w presecie', () => {
    expect(ACME_CARRIER_RULES.map((r) => zapisBezZmian(r.pattern))).toEqual(ACME_CARRIER_RULES.map((r) => r.pattern))
    // `salon(u)? empik` zostaje wzorcem zaawansowanym bez przycisku zamiany; `dpd|kurier` jest od razu słowami
    expect(poleZeWzorca('salon(u)? empik')).toEqual({ tryb: 'wzorzec', wartosc: 'salon(u)? empik' })
    expect(slowaDoZamiany(poleZeWzorca('salon(u)? empik').wartosc)).toBeNull()
    expect(poleZeWzorca('dpd|kurier')).toEqual({ tryb: 'slowa', wartosc: 'dpd, kurier' })
    expect(poleZeWzorca(null)).toEqual({ tryb: 'slowa', wartosc: '' })
  })

  it('reguły stref ACME: zapis formularza bez zmian = wzorce jak w presecie', () => {
    expect(ACME_EXAMPLE_ZONE_RULES.map((r) => zapisBezZmian(r.pattern))).toEqual(ACME_EXAMPLE_ZONE_RULES.map((r) => r.pattern))
    expect(poleZeWzorca(ACME_EXAMPLE_ZONE_RULES[1]!.pattern).tryb).toBe('wzorzec')
  })

  it('przydział przewoźnika dla sposobów dostawy ACME bez zmian po zapisie formularza', () => {
    const poZapisie = ACME_CARRIER_RULES.map((r) => ({ ...r, pattern: zapisBezZmian(r.pattern) }))
    const sposoby: [Parameters<typeof carrierFor>[0], string][] = [
      ['EMPIK', 'Dostawa do Salonu Empik'],
      ['WOO', 'DPD do salonu Empik'],
      ['EMPIK', 'Odbiór w salonie Empik'],
      ['WOO', 'Kurier DPD'],
      ['WOO', 'DPD Pickup'],
      ['WOO', 'Paczkomaty InPost (Darmowa wysyłka)'],
      ['ALLEGRO', 'Allegro One Box'],
      ['WOO', 'Odbiór osobisty'],
      ['WOO', 'Teleportacja'],
    ]
    for (const [kanal, sposob] of sposoby) expect(carrierFor(kanal, sposob, poZapisie)).toEqual(carrierFor(kanal, sposob, ACME_CARRIER_RULES))
    expect(carrierFor('WOO', 'DPD do salonu Empik', poZapisie).carrier).toBe('DPD_EMPIK')
  })
})
