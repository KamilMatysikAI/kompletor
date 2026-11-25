// podsumowanie kliknięcia z osobnymi odbiorami (bez bazy i sieci).
import { describe, expect, it } from 'vitest'
import { podsumowanieOdbiorow } from './kurier-podsumowanie'
import type { ZlecenieKuriera } from './kurier-widok'
import type { OdbiorKlikniecia } from './zamowienie-kuriera'

const D = '2026-11-25'
let n = 0
const zl = (p: Partial<ZlecenieKuriera>): ZlecenieKuriera => ({ id: `z${++n}`, stan: 'ZAMOWIONY', dzien: D, odMin: 840, doMin: 1200, numer: null, powod: null, proba: 1, paczki: 1, wagaKg: 1, kto: 'Magazyn', recznie: false, ...p })
const przyjety = (grupa: string, z: Partial<ZlecenieKuriera>): OdbiorKlikniecia => ({ opis: 'odbiór', grupa, przesylek: z.paczki ?? 1, wynik: { wynik: 'ZAMOWIONY', zlecenie: zl(z), istnialo: false } })
const odrzucony = (grupa: string, powod: string): OdbiorKlikniecia => ({ opis: 'odbiór', grupa, przesylek: 1, wynik: { wynik: 'BLAD', zlecenie: zl({ stan: 'BLAD', powod }), powod } })

describe('podsumowanieOdbiorow', () => {
  it('przypadek z pierwszego żywego zamówienia: 4 przyjęte (Orlen jednym numerem), 1 odrzucony', () => {
    const p = podsumowanieOdbiorow(
      [
        przyjety('ALLEGRO_ONE_KURIER.p1', { numer: 'N1' }),
        odrzucony('ALLEGRO_ONE_KURIER+WEDO.p2', 'zamówienie kuriera Wysyłam z Allegro: Allegro odrzuciło zamówienie odbioru (OPENNET_ERROR)'),
        ...['p3', 'p4', 'p5'].map((t) => przyjety(`ORLEN.${t}`, { numer: 'N2', odMin: 480, doMin: 960 })),
      ],
      'Allegro',
      D,
    )
    expect(p.ok).toBe(true)
    expect(p.ton).toBe('info')
    expect(p.komunikat).toBe(
      'Kurier Allegro zamówiony: One Kurier dziś 25.11 14:00–20:00 (1 przesyłka, zlecenie nr N1), Orlen Paczka dziś 25.11 08:00–16:00 (3 przesyłki, zlecenie nr N2). ' +
        'Nie udało się: One Kurier + WE|DO (1 przesyłka): Przewoźnik odrzucił ten odbiór bez podania powodu. Zamów odbiór tej paczki w Allegro (Wysyłam z Allegro → Zamów kuriera). Możesz też zapytać kuriera przy zamówionym dziś podjeździe, czy ją zabierze.',
    )
    expect(p.komunikat).not.toContain('OPENNET_ERROR')
    // drobne 1: powód z własną instrukcją bez ogólnej rady „Ponów”
    expect(p.komunikat).not.toContain('Ponów')
  })

  it('drobne 1 i 3: rada „Ponów” tylko przy powodzie bez własnej instrukcji; „nie wysłano” to nie „przewoźnik nie przyjął”', () => {
    const osobne = podsumowanieOdbiorow([przyjety('ORLEN', {}), odrzucony('ALLEGRO', 'Allegro wymaga osobnych odbiorów (REQUIRES_SEPARATE_PICKUPS)')], 'Allegro', D)
    expect(osobne.komunikat).toContain('Allegro chce osobnych odbiorów')
    expect(osobne.komunikat).not.toContain('Ponów')
    const nieznany = podsumowanieOdbiorow([przyjety('ORLEN', {}), odrzucony('ALLEGRO', 'Allegro odrzuciło zamówienie odbioru (JAKIS_KOD)')], 'Allegro', D)
    expect(nieznany.komunikat).toContain('Kliknij „Ponów nieudany odbiór” przy pasku')
    const niewyslany = podsumowanieOdbiorow([przyjety('ORLEN', {}), odrzucony('ALLEGRO', 'Kompletor nie wysłał tego zamówienia odbioru, bo poprzednie odbiory długo czekały na przewoźnika: nic nie zamówiono, zamów ponownie.')], 'Allegro', D)
    expect(niewyslany.komunikat).toContain('One Kurier (1 przesyłka): Kompletor nie wysłał tego zamówienia do przewoźnika')
    expect(niewyslany.komunikat).not.toContain('przewoźnik nie przyjął')
    // OPENNET_ERROR bez przyjętego odbioru: bez zdania o podjeździe, którego nie ma
    const sam = podsumowanieOdbiorow([odrzucony('ALLEGRO', 'Allegro odrzuciło zamówienie odbioru (OPENNET_ERROR)')], 'Allegro', D)
    expect(sam.komunikat).not.toContain('podjeździe')
    expect(sam.komunikat).not.toContain('Spróbuj ponownie')
  })

  it('wszystko przyjęte = sukces; nic nie przyjęte = błąd (okno zostaje); nieznany powód bez kodu w komunikacie', () => {
    expect(podsumowanieOdbiorow([przyjety('ORLEN', {}), przyjety('ALLEGRO', {})], 'Allegro', D)).toMatchObject({ ok: true, ton: 'sukces' })
    const nic = podsumowanieOdbiorow([odrzucony('ORLEN', 'Allegro odrzuciło zamówienie odbioru (JAKIS_KOD)')], 'Allegro', D)
    expect(nic).toMatchObject({ ok: false, ton: 'blad' })
    expect(nic.komunikat).toBe('Nie udało się: Orlen Paczka (1 przesyłka): przewoźnik nie przyjął zamówienia (powód przy pasku kuriera). Spróbuj ponownie albo zamów odbiór w panelu przewoźnika.')
  })

  it('niewiadoma: wynik częściowy, nie sukces', () => {
    const p = podsumowanieOdbiorow([przyjety('ORLEN', {}), { opis: 'odbiór', grupa: 'ALLEGRO', przesylek: 2, wynik: { wynik: 'NIEJEDNOZNACZNY', zlecenie: zl({ stan: 'NIEJEDNOZNACZNY' }), istnialo: false } }], 'Allegro', D)
    expect(p).toMatchObject({ ok: true, ton: 'info' })
    expect(p.komunikat).toContain('Nie wiadomo, czy przewoźnik przyjął: One Kurier (2 przesyłki)')
  })
})
