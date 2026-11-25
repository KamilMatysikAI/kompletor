// Reguła wyboru przedziału podjazdu i decyzja automatu „Zamawiaj kuriera automatycznie”: funkcje czyste, dane fikcyjne.
import { describe, expect, it } from 'vitest'
import { czyOdmowaGodzin, MAX_PROB_AUTOMATU, ocenAutomatu, paczkiCzekajace, REGULA_DPD, REGULA_OGOLNA, regulaPrzedzialu, wybierzPrzedzial, type OdbiorWczesniejszy, type PaczkaAutomatu, type ProbaDnia, type WejscieAutomatu } from './kurier-regula'

const P = (od: string, dO: string) => {
  const m = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3))
  return { odMin: m(od), doMin: m(dO) }
}
// lista DPD z produkcji (bez dni)
const LISTA_DPD = [P('09:00', '17:00'), P('11:00', '14:00'), P('14:00', '17:00')]

describe('wybierzPrzedzial: reguła DPD', () => {
  const dzis = (terazMin: number, godzinaOdbioruMin: number | null = 13 * 60, pominiete = [] as { odMin: number; doMin: number }[]) =>
    wybierzPrzedzial({ kandydaci: LISTA_DPD, regula: REGULA_DPD, dzisiaj: true, terazMin, godzinaOdbioruMin, pominiete })
  it('dziś: 09:00–17:00 do 10:45, potem 14:00–17:00 do 13:45, potem nic', () => {
    expect(dzis(8 * 60)).toEqual(P('09:00', '17:00'))
    expect(dzis(10 * 60 + 45)).toEqual(P('09:00', '17:00'))
    expect(dzis(10 * 60 + 46)).toEqual(P('14:00', '17:00'))
    expect(dzis(13 * 60 + 45)).toEqual(P('14:00', '17:00'))
    expect(dzis(13 * 60 + 46)).toBeNull()
  })
  it('obejmujący godzinę odbioru wygrywa (najszerszy z takich), bez takiego najszerszy', () => {
    expect(dzis(8 * 60, 15 * 60)).toEqual(P('09:00', '17:00'))
    // przed 10:45 i odbiór 12:00: obejmują 09–17 i 11–14 → najszerszy 09–17
    expect(dzis(8 * 60, 12 * 60)).toEqual(P('09:00', '17:00'))
    // kolejny dzień: bez filtra godziny, odbiór 15:00 → 09–17 (najszerszy obejmujący)
    expect(wybierzPrzedzial({ kandydaci: LISTA_DPD, regula: REGULA_DPD, dzisiaj: false, terazMin: 20 * 60, godzinaOdbioruMin: 15 * 60 })).toEqual(P('09:00', '17:00'))
    expect(wybierzPrzedzial({ kandydaci: [P('11:00', '14:00'), P('14:00', '17:00')], regula: REGULA_DPD, dzisiaj: false, terazMin: 0, godzinaOdbioruMin: 8 * 60 })).toEqual(P('11:00', '14:00'))
  })
  it('odrzucony przedział odpada; inny zostaje', () => {
    expect(dzis(8 * 60, 13 * 60, [P('09:00', '17:00')])).toEqual(P('11:00', '14:00'))
    expect(dzis(12 * 60, 13 * 60, [P('14:00', '17:00')])).toBeNull()
  })
  it('bez odczytu dostępności: znane przedziały z reguły; nieznany przedział na dziś = tylko przed początkiem', () => {
    expect(wybierzPrzedzial({ kandydaci: null, regula: REGULA_DPD, dzisiaj: true, terazMin: 12 * 60, godzinaOdbioruMin: null })).toEqual(P('14:00', '17:00'))
    expect(wybierzPrzedzial({ kandydaci: [P('12:00', '17:00')], regula: REGULA_DPD, dzisiaj: true, terazMin: 11 * 60 + 45, godzinaOdbioruMin: null })).toEqual(P('12:00', '17:00'))
    expect(wybierzPrzedzial({ kandydaci: [P('12:00', '17:00')], regula: REGULA_DPD, dzisiaj: true, terazMin: 11 * 60 + 46, godzinaOdbioruMin: null })).toBeNull()
    expect(wybierzPrzedzial({ kandydaci: null, regula: REGULA_OGOLNA, dzisiaj: false, terazMin: 0, godzinaOdbioruMin: null })).toBeNull()
  })
  it('reguła po rodzinie modułu', () => {
    expect(regulaPrzedzialu('dpd.services.zapis.v1')).toBe(REGULA_DPD)
    expect(regulaPrzedzialu('allegro.wysylam.v1')).toBe(REGULA_OGOLNA)
  })
})

const baza: WejscieAutomatu = {
  dzien: '2026-11-24',
  dzis: '2026-11-24',
  terazMin: 9 * 60,
  dzienRoboczy: true,
  godzinaOdbioruMin: 13 * 60,
  paczki: { liczba: 3, wagaKg: 4.5, minutOdNajstarszej: 30, niepewne: 0, czekaNaOdbior: null },
  proby: [],
  kandydaci: LISTA_DPD,
  regula: REGULA_DPD,
}
const ocen = (w: Partial<WejscieAutomatu>) => ocenAutomatu({ ...baza, ...w })

describe('ocenAutomatu', () => {
  const proba = (p: Partial<ProbaDnia>): ProbaDnia => ({ stan: 'BLAD', odMin: 540, doMin: 1020, recznie: false, automat: true, odmowaGodzin: true, ...p })

  it('pierwsza paczka dnia po opóźnieniu: ZAMÓW przedział z reguły', () => {
    expect(ocen({})).toEqual({ decyzja: 'ZAMOW', przedzial: P('09:00', '17:00'), ponowienie: false })
  })
  it('każde zlecenie na dzień poza pewną odmową zatrzymuje automat (ręczne i automatu)', () => {
    for (const stan of ['TWORZENIE', 'ZAMOWIONY', 'NIEJEDNOZNACZNY']) {
      expect(ocen({ proby: [proba({ stan, automat: false })] }).decyzja).toBe('STOP')
      expect(ocen({ proby: [proba({ stan, automat: true })] }).decyzja).toBe('STOP')
    }
    // ręczne „nie przyjął”
    expect(ocen({ proby: [proba({ stan: 'BLAD', recznie: true, automat: false })] })).toMatchObject({ decyzja: 'STOP', powod: expect.stringContaining('ręcznie') })
    // „przyjął” zaznaczone ręcznie = ZAMOWIONY
    expect(ocen({ proby: [proba({ stan: 'ZAMOWIONY', recznie: true })] }).decyzja).toBe('STOP')
    // zamówione + późniejsza odmowa drugiego podjazdu: dalej STOP
    expect(ocen({ proby: [proba({ stan: 'ZAMOWIONY', automat: false }), proba({ stan: 'BLAD', automat: false })] }).decyzja).toBe('STOP')
  })
  it('pewna odmowa: jedno ponowienie na inny przedział, potem STOP; odmowa ręczna nie liczy się do limitu automatu', () => {
    expect(ocen({ proby: [proba({})] })).toEqual({ decyzja: 'ZAMOW', przedzial: P('11:00', '14:00'), ponowienie: true })
    expect(ocen({ proby: [proba({}), proba({ odMin: 660, doMin: 840 })] })).toMatchObject({ decyzja: 'STOP', alert: false })
    expect(MAX_PROB_AUTOMATU).toBe(2)
    expect(ocen({ proby: [proba({ automat: false })] })).toEqual({ decyzja: 'ZAMOW', przedzial: P('11:00', '14:00'), ponowienie: false })
    // po odmowie nie ma już innego przedziału na dziś: STOP z alertem
    expect(ocen({ terazMin: 12 * 60, proby: [proba({ odMin: 840, doMin: 1020 })] })).toMatchObject({ decyzja: 'STOP', alert: true, powod: expect.stringContaining('innego przedziału') })
  })
  it('odmowa inna niż pewna odmowa godzin (automatu albo ręczna) = STOP z alertem, bez ponowienia', () => {
    for (const automat of [true, false]) expect(ocen({ proby: [proba({ automat, odmowaGodzin: false })] })).toMatchObject({ decyzja: 'STOP', alert: true, powod: expect.stringContaining('innego niż godziny') })
    // pewna odmowa godzin automatu + inna odmowa ręczna tego dnia: dalej STOP
    expect(ocen({ proby: [proba({}), proba({ automat: false, odmowaGodzin: false, odMin: 660, doMin: 840 })] }).decyzja).toBe('STOP')
  })
  it('czyOdmowaGodzin: tylko odmowy przedziału podjazdu', () => {
    for (const p of ['DPD odrzucił zamówienie kuriera: HTTP 400 (VALIDATION_ERROR; pickupTimeFrom: INCORRECT_PICKUP_TIME: Incorrect pickup time)', 'VALIDATION_ERROR; pickupTimeTo: INCORRECT_VALUE: Time frame not allowed', 'There are no available time slots on the selected date'])
      expect(czyOdmowaGodzin(p)).toBe(true)
    for (const p of [null, '', 'DPD odrzucił zamówienie kuriera: UNKNOWN_ERROR', 'SERVICE_UNAVAILABLE', 'DPD zamówienie kuriera: HTTP 429 (za dużo żądań), DPD go nie przyjął; spróbuj za chwilę', 'VALIDATION_ERROR; sender.phone: INCORRECT_VALUE', 'DISABLED_API'])
      expect(czyOdmowaGodzin(p)).toBe(false)
  })
  it('brak paczek i opóźnienie po pierwszej paczce = CZEKA; paczki bez wagi = STOP z alertem', () => {
    expect(ocen({ paczki: { liczba: 0, wagaKg: 0, minutOdNajstarszej: null, niepewne: 0, czekaNaOdbior: null } }).decyzja).toBe('CZEKA')
    expect(ocen({ paczki: { liczba: 1, wagaKg: 1, minutOdNajstarszej: 2, niepewne: 0, czekaNaOdbior: null } }).decyzja).toBe('CZEKA')
    expect(ocen({ paczki: { liczba: 1, wagaKg: 0, minutOdNajstarszej: 30, niepewne: 0, czekaNaOdbior: null } })).toMatchObject({ decyzja: 'STOP', alert: true })
  })
  it('za późno na dziś: STOP z alertem; brak harmonogramu i dzień wolny: STOP bez alertu', () => {
    expect(ocen({ terazMin: 14 * 60 })).toMatchObject({ decyzja: 'STOP', alert: true, powod: expect.stringContaining('za późno') })
    expect(ocen({ dzien: null })).toMatchObject({ decyzja: 'STOP', alert: false })
    expect(ocen({ dzienRoboczy: false })).toMatchObject({ decyzja: 'STOP', alert: false })
  })
  it('dzień odbioru jutro: o 20:00 zamawia przedział z reguły bez filtra godziny', () => {
    expect(ocen({ dzien: '2026-11-25', terazMin: 20 * 60 })).toEqual({ decyzja: 'ZAMOW', przedzial: P('09:00', '17:00'), ponowienie: false })
  })
})

describe('paczki czekające na kuriera (paczkiCzekajace)', () => {
  const T = Date.UTC(2026, 10, 24, 12, 0) // „teraz”
  const min = (m: number) => T + m * 60_000
  const p = (o: Partial<PaczkaAutomatu> = {}): PaczkaAutomatu => ({ wagaKg: 1, utworzonaMs: min(-30), status: null, sprawdzonaMs: null, ...o })
  it('bez żadnej granicy odbioru: paczki sprzed dzisiejszej północy są niepewne, liczą się tylko dzisiejsze', () => {
    const polnoc = Date.UTC(2026, 10, 23, 23, 0) // 24.11 00:00 czasu polskiego
    expect(paczkiCzekajace([p({ utworzonaMs: polnoc - 60_000 }), p({ utworzonaMs: polnoc - 3 * 86_400_000, status: 'PRZED_NADANIEM' })], [], T, polnoc)).toMatchObject({ liczba: 0, niepewne: 2 })
    expect(paczkiCzekajace([p({ utworzonaMs: polnoc - 60_000 }), p({ utworzonaMs: polnoc })], [], T, polnoc)).toMatchObject({ liczba: 1, niepewne: 1 })
    // przy znanej granicy (np. „Przyjechał” wczoraj o 15:00) starsze paczki po granicy liczą się jak dotąd
    const odb: OdbiorWczesniejszy[] = [{ dzien: '2026-11-23', koniecMs: null, przyjazdMs: polnoc - 8 * 3_600_000 }]
    expect(paczkiCzekajace([p({ utworzonaMs: polnoc - 60_000 })], odb, T, polnoc)).toMatchObject({ liczba: 1, niepewne: 0 })
    // same niepewne = STOP z alertem w ocenie automatu (jak przy nierozpoznanym statusie)
  })
  it('bez wcześniejszych odbiorów: liczą się paczki bez statusu i „czeka na kuriera”; odebrane i doręczone nie', () => {
    const w = paczkiCzekajace([p(), p({ status: 'PRZED_NADANIEM', wagaKg: 2, utworzonaMs: min(-90) }), p({ status: 'PRZEKAZANA' }), p({ status: 'DORECZONA' })], [], T)
    expect(w).toEqual({ liczba: 2, wagaKg: 3, minutOdNajstarszej: 90, niepewne: 0, czekaNaOdbior: null })
  })
  it('„Przyjechał”: paczki sprzed kliknięcia zabrał kurier (nie liczą się), po nim liczą się', () => {
    const odb: OdbiorWczesniejszy[] = [{ dzien: '2026-11-24', koniecMs: null, przyjazdMs: min(-60) }]
    expect(paczkiCzekajace([p({ utworzonaMs: min(-120) }), p({ utworzonaMs: min(-120), status: 'PRZED_NADANIEM', sprawdzonaMs: min(-10) })], odb, T)).toMatchObject({ liczba: 0, niepewne: 0 })
    expect(paczkiCzekajace([p({ utworzonaMs: min(-120) }), p({ utworzonaMs: min(-20) })], odb, T)).toMatchObject({ liczba: 1, minutOdNajstarszej: 20 })
  })
  it('paczka sprzed odbioru, którą śledzenie 2 h po odbiorze dalej widzi „czeka na kuriera” = niepewna', () => {
    const odb: OdbiorWczesniejszy[] = [{ dzien: '2026-11-24', koniecMs: null, przyjazdMs: min(-180) }]
    expect(paczkiCzekajace([p({ utworzonaMs: min(-240), status: 'PRZED_NADANIEM', sprawdzonaMs: min(-5) })], odb, T)).toMatchObject({ liczba: 0, niepewne: 1 })
  })
  it('nierozpoznany status = niepewna, nie liczy się', () => {
    expect(paczkiCzekajace([p({ status: 'NIEZNANY' }), p({ status: 'COS_INNEGO' })], [], T)).toMatchObject({ liczba: 0, niepewne: 2 })
  })
  it('zamówiony podjazd bez „Przyjechał”: okno trwa = czeka na tamten odbiór; po końcu okna granica = koniec okna', () => {
    expect(paczkiCzekajace([p()], [{ dzien: '2026-11-24', koniecMs: min(120), przyjazdMs: null }], T)).toMatchObject({ czekaNaOdbior: '2026-11-24' })
    const po = paczkiCzekajace([p({ utworzonaMs: min(-90) }), p({ utworzonaMs: min(-10) })], [{ dzien: '2026-11-24', koniecMs: min(-60), przyjazdMs: null }], T)
    expect(po).toMatchObject({ liczba: 1, czekaNaOdbior: null })
  })
  it('granica = najpóźniejszy odbiór (kliknięcie wygrywa z końcem okna tego dnia)', () => {
    const odb: OdbiorWczesniejszy[] = [
      { dzien: '2026-11-23', koniecMs: min(-1200), przyjazdMs: null },
      { dzien: '2026-11-24', koniecMs: min(300), przyjazdMs: min(-30) },
    ]
    expect(paczkiCzekajace([p({ utworzonaMs: min(-60) }), p({ utworzonaMs: min(-10) })], odb, T)).toMatchObject({ liczba: 1, czekaNaOdbior: null })
  })
})

describe('automat a paczki: nieustalone, trwający odbiór, same niepewne', () => {
  it('nie da się ustalić paczek = STOP z alertem; trwa wcześniejszy odbiór = CZEKA; same niepewne = STOP z alertem', () => {
    expect(ocen({ paczki: null })).toMatchObject({ decyzja: 'STOP', alert: true })
    expect(ocen({ dzien: '2026-11-25', paczki: { liczba: 3, wagaKg: 3, minutOdNajstarszej: 30, niepewne: 0, czekaNaOdbior: '2026-11-24' } })).toMatchObject({ decyzja: 'CZEKA', powod: expect.stringContaining('z dziś') })
    expect(ocen({ paczki: { liczba: 0, wagaKg: 0, minutOdNajstarszej: null, niepewne: 2, czekaNaOdbior: null } })).toMatchObject({ decyzja: 'STOP', alert: true, powod: expect.stringContaining('nie wiadomo') })
    // pewne paczki są: niepewne nie blokują
    expect(ocen({ paczki: { liczba: 1, wagaKg: 1, minutOdNajstarszej: 30, niepewne: 2, czekaNaOdbior: null } }).decyzja).toBe('ZAMOW')
  })
  it('kurier już był dziś: harmonogram wskazuje jutro, automat zamawia na jutro, nigdy na dziś', () => {
    const d = ocen({ dzien: '2026-11-25', terazMin: 15 * 60 })
    expect(d).toMatchObject({ decyzja: 'ZAMOW', przedzial: { odMin: 540, doMin: 1020 } })
  })
})

