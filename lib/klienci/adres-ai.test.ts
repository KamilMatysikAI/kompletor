// (część 2): bezpieczniki propozycji podziału adresu i zapytanie do modelu na atrapie. Zero połączeń z
// dostawcą AI; dane fikcyjne.
import { describe, expect, it } from 'vitest'
import { parsujOdpowiedz, potrzebnyPodzial, PROMPT_ADRES, skrotLinii, sprawdzPodzial, zapytajModel } from './adres-ai'

describe('sprawdzPodzial (bezpiecznik deterministyczny)', () => {
  it('części dosłownie z linii, w kolejności: przechodzi z zakresami znaków', () => {
    expect(sprawdzPodzial('Testowa 5-7', { ulica: 'Testowa', numerDomu: '5-7', numerLokalu: null })).toEqual({ ok: true, ulica: 'Testowa', numerDomu: '5-7', numerLokalu: null, zakresy: { ulica: [0, 7], dom: [8, 11], lokal: null } })
    expect(sprawdzPodzial('Os. Lecha 12 m. 4', { ulica: 'Os. Lecha', numerDomu: '12', numerLokalu: '4' })).toMatchObject({ ok: true, zakresy: { lokal: [16, 17] } })
    expect(sprawdzPodzial('  Długa 3 lok 2 ', { ulica: 'Długa', numerDomu: '3', numerLokalu: '2' }).ok).toBe(true)
    expect(sprawdzPodzial('Polna 7, 3', { ulica: 'Polna', numerDomu: '7', numerLokalu: '3' }).ok).toBe(true)
  })

  it('dodany znak (dopisane „ul.”, poprawiona literówka, zmiana wielkości liter) = odrzucona', () => {
    expect(sprawdzPodzial('Lipowa 7a', { ulica: 'ul. Lipowa', numerDomu: '7a', numerLokalu: null }).ok).toBe(false)
    expect(sprawdzPodzial('Lipwa 7', { ulica: 'Lipowa', numerDomu: '7', numerLokalu: null }).ok).toBe(false)
    expect(sprawdzPodzial('lipowa 7', { ulica: 'Lipowa', numerDomu: '7', numerLokalu: null }).ok).toBe(false)
    expect(sprawdzPodzial('Lipowa 7', { ulica: 'Lipowa', numerDomu: '7', numerLokalu: '1' }).ok).toBe(false)
  })

  it('zgubiony numer albo fragment („kl. B”, druga liczba) = odrzucona; część numeru jako numer = odrzucona', () => {
    expect(sprawdzPodzial('Lipowa 7 3', { ulica: 'Lipowa', numerDomu: '7', numerLokalu: null }).ok).toBe(false)
    expect(sprawdzPodzial('Lipowa 7 kl. B', { ulica: 'Lipowa', numerDomu: '7', numerLokalu: null }).ok).toBe(false)
    expect(sprawdzPodzial('Lipowa 75', { ulica: 'Lipowa', numerDomu: '7', numerLokalu: null }).ok).toBe(false)
    expect(sprawdzPodzial('Lipowa 7', { ulica: 'Lipowa', numerDomu: null, numerLokalu: null }).ok).toBe(false)
  })

  it('zamiana domu z lokalem = odrzucona (kolejność); numer domu i lokalu muszą zaczynać się cyfrą; ulica musi mieć literę', () => {
    expect(sprawdzPodzial('Lipowa 7/3', { ulica: 'Lipowa', numerDomu: '3', numerLokalu: '7' })).toMatchObject({ ok: false })
    expect(sprawdzPodzial('Lipowa bn', { ulica: 'Lipowa', numerDomu: 'bn', numerLokalu: null })).toEqual({ ok: false, powod: 'numer domu nie zaczyna się cyfrą' })
    expect(sprawdzPodzial('Lipowa 7 m b', { ulica: 'Lipowa', numerDomu: '7', numerLokalu: 'b' })).toEqual({ ok: false, powod: 'numer lokalu nie zaczyna się cyfrą' })
    expect(sprawdzPodzial('12 7', { ulica: '12', numerDomu: '7', numerLokalu: null })).toEqual({ ok: false, powod: 'ulica bez nazwy' })
  })

  it('granica części nie może wypaść w środku liczby: między ulicą a domem i domem a lokalem musi stać separator', () => {
    expect(sprawdzPodzial('Długa 12', { ulica: 'Długa 1', numerDomu: '2', numerLokalu: null })).toEqual({ ok: false, powod: 'numer domu nie stoi zaraz po ulicy' })
    expect(sprawdzPodzial('Długa 1211', { ulica: 'Długa', numerDomu: '12', numerLokalu: '11' })).toEqual({ ok: false, powod: 'numer lokalu nie stoi zaraz po numerze domu' })
    expect(sprawdzPodzial('3 Maja 12', { ulica: '3 Maja', numerDomu: '1', numerLokalu: '2' })).toEqual({ ok: false, powod: 'numer lokalu nie stoi zaraz po numerze domu' })
    expect(sprawdzPodzial('Długa 12/3', { ulica: 'Długa', numerDomu: '12', numerLokalu: '3' })).toMatchObject({ ok: true, zakresy: { ulica: [0, 5], dom: [6, 8], lokal: [9, 10] } })
    expect(sprawdzPodzial('3 Maja 12 m. 4', { ulica: '3 Maja', numerDomu: '12', numerLokalu: '4' })).toMatchObject({ ok: true, ulica: '3 Maja', numerDomu: '12', numerLokalu: '4' })
  })

  it('niska pewność nie zmienia bezpiecznika: zgodna niska pewność to nadal tylko propozycja (zatwierdza człowiek)', () => {
    expect(parsujOdpowiedz('{"ulica":"Lipowa","numer_domu":"7","numer_lokalu":"3","pewnosc":"niska"}')).toEqual({ ulica: 'Lipowa', numerDomu: '7', numerLokalu: '3', pewnosc: 'niska' })
    expect(parsujOdpowiedz('{"ulica":"Lipowa","numer_domu":7,"pewnosc":"pewna"}')).toEqual({ ulica: 'Lipowa', numerDomu: '7', numerLokalu: null, pewnosc: 'niska' })
    expect(parsujOdpowiedz('nie wiem')).toBeNull()
    expect(parsujOdpowiedz('{zepsuty')).toBeNull()
  })
})

describe('potrzebnyPodzial i skrót linii', () => {
  it('tylko linia bez numeru, której rozdzielAdres sam nie rozdziela', () => {
    expect(potrzebnyPodzial({ ulica: 'Testowa 5-7', numerDomu: null })).toBe(true)
    expect(potrzebnyPodzial({ ulica: 'Lipowa 7', numerDomu: null })).toBe(false)
    expect(potrzebnyPodzial({ ulica: 'Testowa 5-7', numerDomu: '5' })).toBe(false)
    expect(potrzebnyPodzial({ ulica: null, numerDomu: null })).toBe(false)
    expect(potrzebnyPodzial({ ulica: `Testowa ${'x'.repeat(200)}`, numerDomu: null })).toBe(false)
  })

  it('skrót zależy od zamówienia i linii, nie zawiera treści', () => {
    const k = Buffer.alloc(32, 7)
    const a = skrotLinii(k, 'o1', 'Testowa 5-7')
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(skrotLinii(k, 'o2', 'Testowa 5-7')).not.toBe(a)
    expect(skrotLinii(k, 'o1', 'Testowa 5-8')).not.toBe(a)
  })
})

describe('zapytajModel (atrapa modelu)', () => {
  const atrapa = (tekst: string, stop = 'end_turn') => {
    const wywolania: Record<string, unknown>[] = []
    return {
      wywolania,
      client: { messages: { create: async (p: Record<string, unknown>) => (wywolania.push(p), { content: [{ type: 'text', text: tekst }], stop_reason: stop, usage: { input_tokens: 50, output_tokens: 20 } }) } } as never,
    }
  }

  it('do modelu idzie tylko linia adresu; odpowiedź → propozycja i zużycie', async () => {
    const a = atrapa('{"ulica":"Testowa","numer_domu":"5-7","numer_lokalu":null,"pewnosc":"wysoka"}')
    const r = await zapytajModel(a.client, 'claude-haiku-5-5', 'Testowa 5-7')
    expect(r).toEqual({ propozycja: { ulica: 'Testowa', numerDomu: '5-7', numerLokalu: null, pewnosc: 'wysoka' }, inputTokens: 50, outputTokens: 20, odmowa: false })
    expect(a.wywolania).toHaveLength(1)
    const p = a.wywolania[0]!
    expect(p['system']).toBe(PROMPT_ADRES)
    expect(p['messages']).toEqual([{ role: 'user', content: 'Linia adresu: "Testowa 5-7"' }])
  })

  it('odmowa modelu = brak propozycji', async () => {
    expect((await zapytajModel(atrapa('{"ulica":"x","numer_domu":"1"}', 'refusal').client, 'claude-haiku-5-5', 'Testowa 5-7')).propozycja).toBeNull()
  })
})
