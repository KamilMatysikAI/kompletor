// stany dokumentów na liście faktur słowem (czyste funkcje). Lista na bazie: tests/faktury-ksef.integration.test.ts.
import { describe, expect, it } from 'vitest'
import { biezacyOkres, skrotKomunikatu, stanKsef, stanWfirmy } from './lista'

describe('lista faktur: stany', () => {
  it('KSeF: przyjęta z numerem KSeF, w toku, błąd, poza KSeF, szkic', () => {
    expect(stanKsef('PRZYJETA', '1111111111-20261109-ABC')).toEqual({ stan: 'WYSTAWIONA', tekst: 'Wysłana do KSeF' })
    expect(stanKsef('WYSLANA', null).stan).toBe('W_KOLEJCE')
    expect(stanKsef('WYSYLANA', null).stan).toBe('W_KOLEJCE')
    for (const s of ['ODRZUCONA', 'BLAD_WYSYLKI', 'BLAD_WALIDACJI']) expect(stanKsef(s, null).stan).toBe('BLAD')
    expect(stanKsef('POZA_KSEF', null).stan).toBe('POZA_KSEF')
    expect(stanKsef('ODLOZONA', null)).toEqual({ stan: 'SZKIC', tekst: 'Szkic: czeka na wysyłkę do KSeF' })
  })
  it('wFirma: wystawiona, w kolejce, błąd', () => {
    expect(stanWfirmy('ISSUED').stan).toBe('WYSTAWIONA')
    expect(stanWfirmy('SENDING').tekst).toBe('W kolejce')
    expect(stanWfirmy('UNKNOWN').stan).toBe('W_KOLEJCE')
    expect(stanWfirmy('FAILED')).toEqual({ stan: 'BLAD', tekst: 'Błąd wystawienia' })
  })
  it('bieżący okres w strefie Warszawy (31.12 23:30 UTC = już styczeń)', () => {
    expect(biezacyOkres(new Date('2026-12-31T23:30:00Z'))).toEqual({ rok: 2027, miesiac: 1 })
  })
})

describe('lista faktur: skrót komunikatu w kolumnie Stan (przegląd, ekran)', () => {
  const dlugi = 'Brak odpowiedzi KSeF (KSeF: błąd sieci: zerwane połączenie). „Ponów” wyśle tę samą fakturę z tym samym numerem: jeśli KSeF ją już ma, odrzuci dubel i poda jej numer KSeF.'
  it('krótki tekst w całości, bez rozwinięcia', () => {
    expect(skrotKomunikatu('Odrzucona [450]')).toEqual({ skrot: 'Odrzucona [450]', caly: null })
  })
  it('długi: cięcie na granicy słowa z „…”, nigdy w pół słowa; całość do rozwinięcia', () => {
    const { skrot, caly } = skrotKomunikatu(dlugi)
    expect(caly).toBe(dlugi)
    expect(skrot.length).toBeLessThanOrEqual(160)
    expect(skrot.endsWith('…')).toBe(true)
    const bez = skrot.slice(0, -1)
    expect(dlugi.startsWith(bez)).toBe(true)
    // następny znak oryginału po skrócie to spacja albo interpunkcja (słowo nie jest ucięte)
    expect(dlugi.charAt(bez.length)).toMatch(/[\s,;:.(–-]/)
    expect(skrot).not.toMatch(/ odr…$/)
  })
  it('jedno długie słowo (np. numer): twarde cięcie zamiast pustego skrótu', () => {
    const { skrot } = skrotKomunikatu('x'.repeat(300), 40)
    expect(skrot).toBe(`${'x'.repeat(39)}…`)
  })
})
