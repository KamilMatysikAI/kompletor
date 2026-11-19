// Stan słowny, kolor, data i zdanie zamiast historii na karcie zamówienia (czysta funkcja, bez bazy).
import { describe, expect, it } from 'vitest'
import type { ShipmentTrackState } from '@prisma/client'
import { anulowanaBezDrogi, opisDrogi, paczkaSledzona, sledzenieZakonczone, TON_DROGI, type DaneDrogi } from './droga-paczki'
import { FILTRY_DROGI, filtryPrzesylekZ, ileFiltrowPrzesylek, pokazDrogeNaLiscie, warunekPrzesylek } from './lista'
import { SLEDZENIE_DO_KONCA_DNI, STANY_DROGI } from './stany-przesylki'

const UTW = new Date('2026-11-10T08:00:00Z')
const ZM = new Date('2026-11-12T10:30:00Z')
const baza: DaneDrogi = { stan: null, stanOd: null, utworzono: UTW, stanPrzesylki: 'UTWORZONA', doKonca: false, modulSledzony: true, zakonczona: false, maLink: true, maZdarzenia: false }

describe('droga paczki na karcie', () => {
  it('stan z osi: opis, kolor i data wejścia w stan, bez zdania zastępczego przy historii', () => {
    expect(opisDrogi({ ...baza, stan: 'W_DRODZE', stanOd: ZM, doKonca: true, maZdarzenia: true })).toEqual({ stanOpis: 'W drodze', ton: 'info', odKiedy: ZM, etykietaDaty: 'W tym stanie od', uwaga: null })
    expect(opisDrogi({ ...baza, stan: 'DORECZONA', stanOd: ZM, maZdarzenia: true })).toMatchObject({ stanOpis: 'Doręczona', ton: 'sukces' })
    expect(opisDrogi({ ...baza, stan: 'ZWROT', stanOd: ZM, maZdarzenia: true })).toMatchObject({ stanOpis: 'Zwrot do nadawcy', ton: 'blad' })
    expect(opisDrogi({ ...baza, stan: 'NIEUDANE_DORECZENIE', stanOd: ZM, maZdarzenia: true })).toMatchObject({ ton: 'ostrzezenie' })
  })

  it('stan bez daty zmiany: data utworzenia; stan bez historii: spokojne zdanie o kolejnym odczycie', () => {
    const w = opisDrogi({ ...baza, stan: 'PRZEKAZANA', doKonca: true })
    expect(w).toMatchObject({ odKiedy: UTW, etykietaDaty: 'Utworzona', uwaga: 'Historia pojawi się po kolejnym odczycie u przewoźnika.' })
  })

  it('śledzenie do doręczenia wyłączone: numer i link zostają, zdanie wskazuje stronę przewoźnika', () => {
    const z = opisDrogi(baza)
    expect(z).toMatchObject({ stanOpis: 'Utworzona u przewoźnika', ton: 'neutralny', odKiedy: UTW, etykietaDaty: 'Utworzona' })
    expect(z.uwaga).toBe('Kompletor nie śledzi drogi tej paczki do doręczenia. Sprawdzisz ją pod linkiem obok numeru.')
    expect(opisDrogi({ ...baza, maLink: false }).uwaga).toBe('Kompletor nie śledzi drogi tej paczki do doręczenia. Sprawdzisz ją na stronie przewoźnika po numerze nadania.')
  })

  it('śledzenie włączone, przewoźnik jeszcze bez odczytu: bez słów o błędzie', () => {
    const u = opisDrogi({ ...baza, doKonca: true }).uwaga!
    expect(u).toBe('Przewoźnik nie podał jeszcze stanu paczki. Drogę paczki sprawdzisz pod linkiem obok numeru.')
    expect(u).not.toMatch(/błąd|nie działa|awaria/i)
  })

  it('firma śledzi do doręczenia, ale nie pyta o paczki tego modułu: zdanie, że stan się tu nie zmieni', () => {
    const u = opisDrogi({ ...baza, doKonca: true, modulSledzony: false }).uwaga!
    expect(u).toBe('Kompletor nie sprawdza drogi paczek tego przewoźnika, więc stan paczki się tu nie zmieni. Drogę paczki sprawdzisz pod linkiem obok numeru.')
    expect(u).not.toMatch(/jeszcze/)
    expect(opisDrogi({ ...baza, doKonca: true, modulSledzony: false, maLink: false }).uwaga).toMatch(/na stronie przewoźnika po numerze nadania\.$/)
  })

  it('stan nieznany: zdanie, że przewoźnik podał stan nierozpoznany, także przy historii', () => {
    expect(opisDrogi({ ...baza, stan: 'NIEZNANY', stanOd: ZM, doKonca: true, maZdarzenia: true })).toMatchObject({
      stanOpis: 'Stan nieznany',
      uwaga: 'Przewoźnik podał stan, którego Kompletor nie rozpoznaje. Paczkę sprawdzisz pod linkiem obok numeru.',
    })
  })

  it('stan w drodze, a Kompletor już nie pyta (przełącznik albo moduł wyłączony): zdanie, że stan nie jest odświeżany', () => {
    const stary = 'Kompletor nie odświeża już stanu tej paczki. Aktualny stan sprawdzisz pod linkiem obok numeru.'
    expect(opisDrogi({ ...baza, stan: 'W_DRODZE', stanOd: ZM, doKonca: false, maZdarzenia: true }).uwaga).toBe(stary)
    expect(opisDrogi({ ...baza, stan: 'W_DRODZE', stanOd: ZM, doKonca: true, modulSledzony: false, maZdarzenia: true }).uwaga).toBe(stary)
    // stan końcowy się już nie zmieni, więc bez zdania
    expect(opisDrogi({ ...baza, stan: 'DORECZONA', stanOd: ZM, doKonca: false, maZdarzenia: true }).uwaga).toBeNull()
    expect(opisDrogi({ ...baza, stan: 'W_DRODZE', stanOd: ZM, doKonca: true, maZdarzenia: true }).uwaga).toBeNull()
  })

  it('śledzenie paczki zakończone (seria błędów, brak przesyłki u przewoźnika, koniec okna): stan nieodświeżany', () => {
    expect(opisDrogi({ ...baza, stan: 'W_DRODZE', stanOd: ZM, doKonca: true, zakonczona: true, maZdarzenia: true }).uwaga).toBe('Kompletor nie odświeża już stanu tej paczki. Aktualny stan sprawdzisz pod linkiem obok numeru.')
    expect(opisDrogi({ ...baza, doKonca: true, zakonczona: true }).uwaga).toBe('Kompletor nie odświeża już stanu tej paczki. Drogę paczki sprawdzisz pod linkiem obok numeru.')
    expect(opisDrogi({ ...baza, stan: 'DORECZONA', stanOd: ZM, doKonca: true, zakonczona: true, maZdarzenia: true }).uwaga).toBeNull()
  })

  it('czy Kompletor dalej pyta o paczkę: przełącznik, moduł i stan śledzenia tej przesyłki (jedna funkcja dla karty i API)', () => {
    expect(paczkaSledzona({ doKonca: true, modulSledzony: true, zakonczona: false })).toBe(true)
    expect(paczkaSledzona({ doKonca: false, modulSledzony: true, zakonczona: false })).toBe(false)
    expect(paczkaSledzona({ doKonca: true, modulSledzony: false, zakonczona: false })).toBe(false)
    expect(paczkaSledzona({ doKonca: true, modulSledzony: true, zakonczona: true })).toBe(false)
    const now = new Date('2026-12-20T12:00:00Z')
    const granica = new Date(now.getTime() - SLEDZENIE_DO_KONCA_DNI * 86_400_000)
    expect(sledzenieZakonczone({ state: 'UTWORZONA', trackingStoppedAt: null, createdAt: granica }, now)).toBe(false)
    expect(sledzenieZakonczone({ state: 'UTWORZONA', trackingStoppedAt: null, createdAt: new Date(granica.getTime() - 1) }, now)).toBe(true)
    expect(sledzenieZakonczone({ state: 'UTWORZONA', trackingStoppedAt: ZM, createdAt: ZM }, now)).toBe(true)
    expect(sledzenieZakonczone({ state: 'ANULOWANA', trackingStoppedAt: null, createdAt: now }, now)).toBe(true)
  })

  it('przesyłka anulowana w Kompletorze: „Anulowana”, także gdy oś została na „Utworzona”', () => {
    expect(opisDrogi({ ...baza, stanPrzesylki: 'ANULOWANA' })).toMatchObject({ stanOpis: 'Anulowana', ton: 'neutralny', uwaga: 'Przesyłka anulowana, paczka z tym numerem nie pojedzie.' })
    expect(opisDrogi({ ...baza, stanPrzesylki: 'ANULOWANA', stan: 'UTWORZONA', stanOd: ZM, maZdarzenia: true })).toMatchObject({ stanOpis: 'Anulowana', etykietaDaty: 'W tym stanie od', uwaga: null })
    // paczka, która pojechała mimo anulowania etykiety: liczy się stan u przewoźnika
    expect(opisDrogi({ ...baza, stanPrzesylki: 'ANULOWANA', stan: 'W_DRODZE', stanOd: ZM, maZdarzenia: true })).toMatchObject({ stanOpis: 'W drodze' })
  })

  it('każdy stan osi ma kolor', () => {
    for (const s of STANY_DROGI) expect(TON_DROGI[s as ShipmentTrackState]).toBeTruthy()
  })
})

describe('filtr „Droga paczki” na liście przesyłek', () => {
  it('przyjmuje stan osi albo BRAK, odrzuca inne wartości', () => {
    expect(filtryPrzesylekZ({ droga: 'W_DRODZE' }).droga).toBe('W_DRODZE')
    expect(filtryPrzesylekZ({ droga: 'BRAK' }).droga).toBe('BRAK')
    expect(filtryPrzesylekZ({ droga: 'w_drodze' }).droga).toBeUndefined()
    expect(filtryPrzesylekZ({ droga: 'UTWORZONA; drop' }).droga).toBeUndefined()
    expect(FILTRY_DROGI).toHaveLength(STANY_DROGI.length + 1)
  })
  it('liczy się do „Filtry (n)” i daje warunek po stanie drogi', () => {
    expect(ileFiltrowPrzesylek({ droga: 'ZWROT' })).toBe(1)
    expect(warunekPrzesylek({ droga: 'ZWROT' })).toEqual({ AND: [{ trackState: 'ZWROT' }] })
    expect(warunekPrzesylek({ droga: 'BRAK' })).toEqual({ AND: [{ state: 'UTWORZONA', trackState: null }] })
  })
  it('kolumna „Stan”: stan drogi poza nieznanym i poza anulowaną, która nie pojechała', () => {
    expect(pokazDrogeNaLiscie('UTWORZONA', 'W_DRODZE')).toBe(true)
    expect(pokazDrogeNaLiscie('UTWORZONA', 'NIEZNANY')).toBe(false)
    expect(pokazDrogeNaLiscie('UTWORZONA', null)).toBe(false)
    expect(pokazDrogeNaLiscie('ANULOWANA', 'ANULOWANA')).toBe(false)
    expect(pokazDrogeNaLiscie('ANULOWANA', 'W_DRODZE')).toBe(true)
  })
})

describe('anulowana bez drogi', () => {
  it('anulowana w Kompletorze bez odczytu u przewoźnika: tak; paczka w drodze mimo anulowania: nie', () => {
    expect(anulowanaBezDrogi('ANULOWANA', null)).toBe(true)
    expect(anulowanaBezDrogi('ANULOWANA', 'UTWORZONA')).toBe(true)
    expect(anulowanaBezDrogi('ANULOWANA', 'W_DRODZE')).toBe(false)
    expect(anulowanaBezDrogi('UTWORZONA', null)).toBe(false)
  })
})
