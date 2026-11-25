// widok zamówień kuriera pod paskiem przewoźnika: jedna linia na dzień, odmowa po ludzku, przedziały podjazdu
// z dostępności przewoźnika i domyślny przedział. Funkcje czyste, dane fikcyjne.
import { describe, expect, it } from 'vitest'
import { trybOknaKuriera, domyslnyTerminKuriera, etykietaOdbioru, nazwaGrupyOdbioru, nieudaneOdbioryDnia, scalOdbioryPaska, dzienPoLudzku, godzinyPoOdczycie, terminWzgledemZlecen, liniePaskaKuriera, opisZlecenia, podpowiedziNaDzien, powodPoLudzku, UWAGA_BEZ_DNIA, UWAGA_BEZ_LISTY, type DostepnoscOkna, type ZlecenieKuriera } from './kurier-widok'
import { REGULA_DPD } from './kurier-regula'

const ODMOWA_400 =
  'DPD odrzucił zamówienie kuriera: HTTP 400 (VALIDATION_ERROR; pickupTimeFrom / pickupTimeTo: INCORRECT_VALUE: Time frame not allowed. There are no available time slots on the selected date for the selected sender postcode.)'
const NIE_WIADOMO = 'DPD zamówienie kuriera: odmowa z numerem zlecenia w odpowiedzi; nie wiadomo, czy DPD przyjął zamówienie kuriera (HTTP 400)'

let n = 0
const z = (p: Partial<ZlecenieKuriera>): ZlecenieKuriera => ({ id: `z${++n}`, stan: 'BLAD', dzien: '2026-11-23', odMin: 840, doMin: 1020, numer: null, powod: null, proba: 1, paczki: 2, wagaKg: 3, kto: 'Magazyn', recznie: false, ...p })

describe('liniePaskaKuriera: jedna linia na dzień odbioru', () => {
  it('zgłoszenie z 23.11: cztery wpisy → dwie linie (dziś z najnowszą próbą i dwiema wcześniejszymi zwiniętymi, jutro)', () => {
    const wpisy = [
      z({ stan: 'NIEJEDNOZNACZNY', proba: 1, odMin: 840, doMin: 1020, powod: NIE_WIADOMO }),
      z({ stan: 'NIEJEDNOZNACZNY', proba: 2, odMin: 720, doMin: 840, powod: NIE_WIADOMO }),
      z({ stan: 'BLAD', proba: 3, odMin: 840, doMin: 1020, powod: ODMOWA_400 }),
      z({ stan: 'NIEJEDNOZNACZNY', dzien: '2026-11-24', proba: 1, odMin: 960, doMin: 1020, powod: NIE_WIADOMO }),
    ]
    const l = liniePaskaKuriera(wpisy, '2026-11-23')
    expect(l.map((x) => x.dzien)).toEqual(['2026-11-23', '2026-11-24'])
    expect(l[0]).toMatchObject({ glowna: { proba: 3, stan: 'BLAD' }, wczesniejsze: true })
    expect(l[0]!.pozostale.map((x) => x.proba)).toEqual([2, 1])
    expect(l[1]).toMatchObject({ glowna: { stan: 'NIEJEDNOZNACZNY' }, pozostale: [] })
  })

  it('minione dni nie mają linii (zostają w bazie), kolejność: dziś, potem przyszłe niezależnie od kolejności wejścia', () => {
    const l = liniePaskaKuriera([z({ dzien: '2026-11-26' }), z({ dzien: '2026-11-20' }), z({ dzien: '2026-11-24' }), z({ dzien: '2026-11-23' })], '2026-11-23')
    expect(l.map((x) => x.dzien)).toEqual(['2026-11-23', '2026-11-24', '2026-11-26'])
  })

  it('udane zamówienie chowa wcześniejsze odmowy i niewiadome; późniejsza odmowa (drugi podjazd) nie przykrywa zamówienia', () => {
    const a = liniePaskaKuriera([z({ stan: 'BLAD', proba: 1 }), z({ stan: 'NIEJEDNOZNACZNY', proba: 2 }), z({ stan: 'ZAMOWIONY', proba: 3, numer: 'ZK-1' })], '2026-11-23')
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ glowna: { stan: 'ZAMOWIONY', numer: 'ZK-1' }, wczesniejsze: true })
    const b = liniePaskaKuriera([z({ stan: 'ZAMOWIONY', proba: 1, numer: 'ZK-1' }), z({ stan: 'BLAD', proba: 2 })], '2026-11-23')
    expect(b[0]).toMatchObject({ glowna: { stan: 'ZAMOWIONY' }, wczesniejsze: false })
    expect(b[0]!.pozostale.map((x) => x.proba)).toEqual([2])
  })

  it('najnowsza próba w toku albo niewiadoma po zamówieniu zostaje w linii (świadome drugie zamówienie)', () => {
    const l = liniePaskaKuriera([z({ stan: 'ZAMOWIONY', proba: 1 }), z({ stan: 'NIEJEDNOZNACZNY', proba: 2 })], '2026-11-23')
    expect(l[0]!.glowna).toMatchObject({ stan: 'NIEJEDNOZNACZNY', proba: 2 })
  })

  it('pusta lista = brak linii', () => {
    expect(liniePaskaKuriera([], '2026-11-23')).toEqual([])
  })
})

describe('liniePaskaKuriera: osobne odbiory (linia na dzień + grupę)', () => {
  it('trzy grupy jednego kliknięcia: przyjęta, odmowa i niewiadoma, każda we własnej linii', () => {
    const a = z({ stan: 'ZAMOWIONY', grupa: 'x.p1', klik: 1 })
    const b = z({ stan: 'BLAD', powod: 'odmowa', grupa: 'x.p2', klik: 1 })
    const c = z({ stan: 'NIEJEDNOZNACZNY', grupa: 'x.p3', klik: 1 })
    const l = liniePaskaKuriera([c, b, a], '2026-11-23')
    expect(l.map((x) => [x.grupa, x.glowna.stan, x.pozostale.length])).toEqual([
      ['x.p1', 'ZAMOWIONY', 0],
      ['x.p2', 'BLAD', 0],
      ['x.p3', 'NIEJEDNOZNACZNY', 0],
    ])
  })

  it('niewiadoma albo zamówienie w toku zawsze w linii, nawet gdy grupa ma też przyjętą próbę', () => {
    const l = liniePaskaKuriera([z({ stan: 'ZAMOWIONY', proba: 2, grupa: 'x', klik: 2 }), z({ stan: 'NIEJEDNOZNACZNY', proba: 1, grupa: 'x', klik: 1 })], '2026-11-23')
    expect(l).toHaveLength(1)
    expect(l[0]!.glowna.stan).toBe('NIEJEDNOZNACZNY')
    expect(l[0]!.pozostale.map((x) => x.stan)).toEqual(['ZAMOWIONY'])
  })

  it('odmowa grupy po późniejszym przyjętym odbiorze (nowy klucz) zwija się pod nim; bez niego zostaje linią', () => {
    const odmowa = z({ stan: 'BLAD', grupa: 'x.p2', klik: 1 })
    const przyjety = z({ stan: 'ZAMOWIONY', grupa: 'x.p1', klik: 1 })
    expect(liniePaskaKuriera([przyjety, odmowa], '2026-11-23')).toHaveLength(2)
    const ponowienie = z({ stan: 'ZAMOWIONY', grupa: 'x', klik: 2 })
    const l = liniePaskaKuriera([przyjety, odmowa, ponowienie], '2026-11-23')
    expect(l.map((x) => [x.grupa, x.glowna.stan, x.pozostale.map((p) => p.stan)])).toEqual([
      ['x', 'ZAMOWIONY', ['BLAD']],
      ['x.p1', 'ZAMOWIONY', []],
    ])
    expect(l[0]!.wczesniejsze).toBe(false)
  })

  it('linia przyjętego odbioru mówi, ile przesyłek obejmuje; DPD bez liczby', () => {
    expect(opisZlecenia(z({ stan: 'ZAMOWIONY', paczki: 3, grupa: 'x', klik: 1 }), 'Allegro', '2026-11-23')).toContain('3 przesyłki')
    expect(opisZlecenia(z({ stan: 'ZAMOWIONY', paczki: 3 }), 'DPD', '2026-11-23')).not.toContain('przesyłk')
  })
})

describe('powodPoLudzku: znane kody DPD po polsku, techniczny powód w szczegółach', () => {
  it('brak wolnych przedziałów dla kodu nadawcy', () => {
    expect(powodPoLudzku(ODMOWA_400)).toEqual({ tekst: 'DPD nie ma już wolnych przedziałów podjazdu na ten dzień dla Twojego adresu. Wybierz inny dzień albo zadzwoń do DPD.', szczegoly: ODMOWA_400, znany: true, niewyslane: false })
    expect(powodPoLudzku('RANGE_NOT_FOUND')!.tekst).toContain('wolnych przedziałów')
  })
  it('niedozwolone godziny: INCORRECT_PICKUP_TIME albo „Time frame not allowed” bez dopisku o braku przedziałów', () => {
    for (const p of ['VALIDATION_ERROR; pickupTimeFrom: INCORRECT_PICKUP_TIME', 'VALIDATION_ERROR; pickupTimeTo: INCORRECT_VALUE: Time frame not allowed']) expect(powodPoLudzku(p)!.tekst).toContain('nie przyjmuje podjazdu w tych godzinach')
  })
  it('DISALLOWED_FID i DISABLED_API', () => {
    expect(powodPoLudzku('DPD odrzucił zamówienie kuriera: HTTP 403 (DISALLOWED_FID)')!.tekst).toContain('numer klienta (FID)')
    expect(powodPoLudzku('DISABLED_API')!.tekst).toContain('wyłączone zamawianie kuriera')
  })
  it('nieznany kod = dotychczasowy tekst techniczny bez szczegółów; pusty = null', () => {
    expect(powodPoLudzku('UNKNOWN_ERROR: coś')).toEqual({ tekst: 'UNKNOWN_ERROR: coś', szczegoly: null, znany: false, niewyslane: false })
    expect(powodPoLudzku(null)).toBeNull()
    expect(powodPoLudzku('  ')).toBeNull()
  })
})

describe('opisZlecenia', () => {
  it('odmowa: zdanie po ludzku zamiast angielskiego tekstu DPD; dzień „dziś”/„jutro”', () => {
    const o = opisZlecenia(z({ powod: ODMOWA_400 }), 'DPD Empik', '2026-11-23')
    expect(o).toBe('DPD Empik: przewoźnik nie przyjął zamówienia na dziś 23.11 14:00–17:00. DPD nie ma już wolnych przedziałów podjazdu na ten dzień dla Twojego adresu. Wybierz inny dzień albo zadzwoń do DPD.')
    expect(opisZlecenia(z({ stan: 'ZAMOWIONY', dzien: '2026-11-24', numer: 'ZK-9' }), 'DPD', '2026-11-23')).toBe('DPD zamówiony na jutro 24.11 14:00–17:00, zlecenie nr ZK-9')
  })
  it('niewiadoma prosi o zaznaczenie wyniku; z kodem pewnej odmowy w treści podpowiada odmowę', () => {
    expect(opisZlecenia(z({ stan: 'NIEJEDNOZNACZNY', powod: NIE_WIADOMO }), 'DPD', '2026-11-23')).toContain('zaznacz wynik')
    expect(opisZlecenia(z({ stan: 'NIEJEDNOZNACZNY', powod: `${NIE_WIADOMO}, ${ODMOWA_400}` }), 'DPD', '2026-11-23')).toContain('Odpowiedź DPD wygląda na odmowę')
  })
  it('rozstrzygnięte ręcznie: dopisek zamiast powodu przewoźnika', () => {
    expect(opisZlecenia(z({ recznie: true, powod: 'Rozstrzygnięte ręcznie: …' }), 'DPD', '2026-11-23')).toBe('DPD: przewoźnik nie przyjął zamówienia na dziś 23.11 14:00–17:00 (rozstrzygnięte ręcznie)')
    expect(opisZlecenia(z({ stan: 'ZAMOWIONY', recznie: true }), 'DPD', '2026-11-23')).toContain('(potwierdzone ręcznie)')
  })
  it('zamówione przez automat: „zamówiony automatycznie”', () => {
    expect(opisZlecenia(z({ stan: 'ZAMOWIONY', numer: '20261124000001', automat: true }), 'DPD', '2026-11-23')).toBe('DPD zamówiony automatycznie na dziś 23.11 14:00–17:00, zlecenie nr 20261124000001')
  })
  it('dzień bez punktu odniesienia: DD.MM', () => {
    expect(dzienPoLudzku('2026-11-30')).toBe('30.11')
    expect(dzienPoLudzku('2026-11-30', '2026-11-23')).toBe('30.11')
    expect(dzienPoLudzku('2026-12-01', '2026-11-30')).toBe('jutro 01.12')
  })
})

describe('podpowiedzi przedziałów z dostępności przewoźnika (pola godzin zostają zawsze)', () => {
  // odpowiedź DPD z produkcji: przedziały bez dni, `offset` w minutach
  const DPD: DostepnoscOkna = {
    tryb: 'LISTA',
    przedzialy: [
      { odMin: 540, doMin: 1020, offsetMin: 360 },
      { odMin: 660, doMin: 840, offsetMin: 180 },
      { odMin: 840, doMin: 1020, offsetMin: 180 },
    ],
    dni: {},
  }
  it('każdy dzień dostaje te same przedziały; dopisek „zwykle do” tylko na dziś (hipoteza o offsecie)', () => {
    const dzis = podpowiedziNaDzien(DPD, '2026-11-24', '2026-11-24', 10 * 60)
    expect(dzis.uwaga).toBeNull()
    expect(dzis.podpowiedzi).toEqual([
      { odMin: 540, doMin: 1020, dopisek: 'zwykle do 11:00' },
      { odMin: 660, doMin: 840, dopisek: 'zwykle do 11:00' },
      { odMin: 840, doMin: 1020, dopisek: 'zwykle do 14:00' },
    ])
    expect(podpowiedziNaDzien(DPD, '2026-11-24', '2026-11-24', 12 * 60).podpowiedzi.map((p) => p.dopisek)).toEqual(['na dziś zwykle już za późno', 'na dziś zwykle już za późno', 'zwykle do 14:00'])
    expect(podpowiedziNaDzien(DPD, '2026-11-30', '2026-11-24', 12 * 60).podpowiedzi.map((p) => p.dopisek)).toEqual([null, null, null])
  })
  it('daty od przewoźnika wygrywają z listą ogólną; pusta lista = uwaga, nie blokada; błąd = uwaga; brak odczytu = nic', () => {
    const zDatami: DostepnoscOkna = { tryb: 'LISTA', przedzialy: [{ odMin: 540, doMin: 1020 }], dni: { '2026-11-25': [{ odMin: 600, doMin: 720 }] } }
    expect(podpowiedziNaDzien(zDatami, '2026-11-25', '2026-11-24', 600).podpowiedzi).toEqual([{ odMin: 600, doMin: 720, dopisek: null }])
    expect(podpowiedziNaDzien(zDatami, '2026-11-26', '2026-11-24', 600).podpowiedzi).toEqual([{ odMin: 540, doMin: 1020, dopisek: null }])
    expect(podpowiedziNaDzien({ tryb: 'LISTA', przedzialy: [], dni: {} }, '2026-11-25', '2026-11-24', 600)).toEqual({ podpowiedzi: [], uwaga: UWAGA_BEZ_DNIA })
    expect(podpowiedziNaDzien({ tryb: 'POLA', uwaga: UWAGA_BEZ_LISTY }, '2026-11-25', '2026-11-24', 600)).toEqual({ podpowiedzi: [], uwaga: UWAGA_BEZ_LISTY })
    expect(podpowiedziNaDzien(null, '2026-11-25', '2026-11-24', 600)).toEqual({ podpowiedzi: [], uwaga: null })
  })
})

describe('domyslnyTerminKuriera', () => {
  const jutro = { data: '2026-11-25', odMin: 720, doMin: 1020 }
  it('propozycja na dziś zostaje', () => {
    const dzisiaj = { data: '2026-11-24', odMin: 720, doMin: 1020 }
    expect(domyslnyTerminKuriera(dzisiaj, '2026-11-24', 600, true)).toEqual(dzisiaj)
  })
  it('godzina z harmonogramu minęła: dziś od najbliższej pełnej godziny z zapasem do 17:00', () => {
    expect(domyslnyTerminKuriera(jutro, '2026-11-24', 12 * 60 + 10, true)).toEqual({ data: '2026-11-24', odMin: 840, doMin: 1020 })
    expect(domyslnyTerminKuriera(jutro, '2026-11-24', 13 * 60, true)).toEqual({ data: '2026-11-24', odMin: 840, doMin: 1020 })
  })
  it('za późno na dziś albo dzień wolny: propozycja z harmonogramu', () => {
    expect(domyslnyTerminKuriera(jutro, '2026-11-24', 13 * 60 + 1, true)).toEqual(jutro)
    expect(domyslnyTerminKuriera(jutro, '2026-11-24', 600, false)).toEqual(jutro)
    expect(domyslnyTerminKuriera(null, '2026-11-24', 16 * 60, true)).toEqual({ data: '2026-11-24', odMin: null, doMin: null })
  })
  it('przewoźnik z regułą przedziałów (DPD): godziny z reguły automatu, dziś dopóki reguła ma przedział', () => {
    const harm = { data: '2026-11-24', odMin: 13 * 60, doMin: 15 * 60 }
    // 10:00: 09:00–17:00 obejmuje godzinę odbioru 13:00 i jest najszerszy
    expect(domyslnyTerminKuriera(harm, '2026-11-24', 600, true, REGULA_DPD)).toEqual({ data: '2026-11-24', odMin: 540, doMin: 1020 })
    // 12:10: zostaje tylko 14:00–17:00 (także gdy harmonogram wskazuje już jutro)
    expect(domyslnyTerminKuriera(harm, '2026-11-24', 730, true, REGULA_DPD)).toEqual({ data: '2026-11-24', odMin: 840, doMin: 1020 })
    expect(domyslnyTerminKuriera(jutro, '2026-11-24', 730, true, REGULA_DPD)).toEqual({ data: '2026-11-24', odMin: 840, doMin: 1020 })
    // 13:50: na dziś za późno → dzień z harmonogramu z przedziałem reguły dla tego dnia
    expect(domyslnyTerminKuriera(jutro, '2026-11-24', 830, true, REGULA_DPD)).toEqual({ data: '2026-11-25', odMin: 540, doMin: 1020 })
    expect(domyslnyTerminKuriera(jutro, '2026-11-24', 600, false, REGULA_DPD)).toEqual({ data: '2026-11-25', odMin: 540, doMin: 1020 })
    // za późno, a harmonogram wciąż mówi „dziś”: propozycja bez zmian (decyduje osoba)
    expect(domyslnyTerminKuriera(harm, '2026-11-24', 830, true, REGULA_DPD)).toEqual(harm)
  })
  it('kurier już był dziś („Przyjechał”) albo dziś nie ma odbiorów: nigdy dziś, tylko dzień z harmonogramu', () => {
    // z regułą DPD o 10:00 dziś byłby 09:00–17:00; po „Przyjechał” harmonogram wskazuje jutro
    expect(domyslnyTerminKuriera(jutro, '2026-11-24', 600, false, REGULA_DPD)).toEqual({ data: '2026-11-25', odMin: 540, doMin: 1020 })
    expect(domyslnyTerminKuriera(jutro, '2026-11-24', 12 * 60 + 10, false)).toEqual(jutro)
    // obrona: propozycja na dziś przy zamkniętym dniu nie wraca jako dziś
    const dzisiaj = { data: '2026-11-24', odMin: 720, doMin: 1020 }
    expect(domyslnyTerminKuriera(dzisiaj, '2026-11-24', 600, false)).toEqual({ data: '2026-11-24', odMin: null, doMin: null })
    expect(domyslnyTerminKuriera(dzisiaj, '2026-11-24', 600, false, REGULA_DPD)).toEqual({ data: '2026-11-24', odMin: null, doMin: null })
  })
})

describe('godzinyPoOdczycie: późny odczyt przedziałów nie nadpisuje tego, co osoba wpisała', () => {
  const lista: DostepnoscOkna = { tryb: 'LISTA', przedzialy: [{ odMin: 540, doMin: 1020 }], dni: {} }
  const zDniem = (_d: DostepnoscOkna, dzien: string) => ({ dzien, odMin: 540, doMin: 1020 })
  it('bez ręcznych zmian: domyślne godziny dla dnia z okna', () => {
    expect(godzinyPoOdczycie(lista, { reczne: false, data: '2030-03-05', aktualny: true }, zDniem)).toEqual({ dzien: '2030-03-05', odMin: 540, doMin: 1020 })
  })
  it('osoba wpisała godziny przed powrotem odczytu: pola zostają', () => {
    expect(godzinyPoOdczycie(lista, { reczne: true, data: '2030-03-05', aktualny: true }, zDniem)).toBeNull()
  })
  it('osoba zmieniła dzień przed powrotem odczytu: domyślne liczone dla nowego dnia, nie dla dnia z otwarcia', () => {
    expect(godzinyPoOdczycie(lista, { reczne: false, data: '2030-03-06', aktualny: true }, zDniem)?.dzien).toBe('2030-03-06')
  })
  it('odczyt z wcześniejszego otwarcia okna i odczyt bez listy: bez zmian', () => {
    expect(godzinyPoOdczycie(lista, { reczne: false, data: '2030-03-05', aktualny: false }, zDniem)).toBeNull()
    expect(godzinyPoOdczycie({ tryb: 'POLA', uwaga: UWAGA_BEZ_LISTY }, { reczne: false, data: '2030-03-05', aktualny: true }, zDniem)).toBeNull()
  })
})

describe('terminWzgledemZlecen: zamówiony podjazd na dzień z harmonogramu przestawia podpowiedź okna', () => {
  const dzis = { data: '2030-03-05', odMin: 840, doMin: 1020 }
  const z = (dzien: string, stan: string) => ({ dzien, stan, odMin: 540, doMin: 1020 })
  it('aktywne zlecenie (automatu albo ręczne) na jutro z harmonogramu, na dziś nic: podpowiada jutro z godzinami zlecenia', () => {
    for (const stan of ['ZAMOWIONY', 'TWORZENIE', 'NIEJEDNOZNACZNY']) expect(terminWzgledemZlecen(dzis, '2030-03-06', [z('2030-03-06', stan)])).toEqual({ data: '2030-03-06', odMin: 540, doMin: 1020 })
  })
  it('bez aktywnego zlecenia na dzień z harmonogramu, ze zleceniem na podpowiadany dzień albo bez harmonogramu: bez zmian', () => {
    expect(terminWzgledemZlecen(dzis, '2030-03-06', [z('2030-03-06', 'BLAD')])).toBe(dzis)
    expect(terminWzgledemZlecen(dzis, '2030-03-06', [z('2030-03-05', 'ZAMOWIONY'), z('2030-03-06', 'ZAMOWIONY')])).toBe(dzis)
    expect(terminWzgledemZlecen(dzis, null, [z('2030-03-06', 'ZAMOWIONY')])).toBe(dzis)
    expect(terminWzgledemZlecen(dzis, '2030-03-07', [z('2030-03-06', 'ZAMOWIONY')])).toBe(dzis)
  })
})

describe('osobne odbiory na pasku', () => {
  const D = '2026-11-25'
  const g = (p: Partial<ZlecenieKuriera>) => z({ dzien: D, klik: 1, ...p })
  it('nazwy przewoźników z klucza grupy', () => {
    expect(nazwaGrupyOdbioru('ALLEGRO_ONE_KURIER')).toBe('One Kurier')
    expect(nazwaGrupyOdbioru('ALLEGRO_ONE_KURIER+WEDO.p2')).toBe('One Kurier + WE|DO')
    expect(nazwaGrupyOdbioru('ORLEN.p3')).toBe('Orlen Paczka')
    expect(nazwaGrupyOdbioru('NOWY_PRZEWOZNIK')).toBe('NOWY_PRZEWOZNIK')
    expect(nazwaGrupyOdbioru('x.p1')).toBeNull()
    expect(nazwaGrupyOdbioru(undefined)).toBeNull()
    expect(etykietaOdbioru('Allegro', 'ORLEN')).toBe('Allegro (Orlen Paczka)')
    expect(etykietaOdbioru('DPD', undefined)).toBe('DPD')
  })
  it('trzy przyjęte odbiory tego samego przewoźnika z jednym numerem = jedna linia z sumą; odmowa osobno', () => {
    const wpisy = [
      g({ stan: 'ZAMOWIONY', grupa: 'ALLEGRO_ONE_KURIER.p1', numer: 'N1', odMin: 840, doMin: 1200, paczki: 1 }),
      g({ stan: 'BLAD', grupa: 'ALLEGRO_ONE_KURIER+WEDO.p2', powod: 'Allegro odrzuciło zamówienie odbioru (OPENNET_ERROR)', paczki: 1 }),
      ...['p3', 'p4', 'p5'].map((t) => g({ stan: 'ZAMOWIONY', grupa: `ORLEN.${t}`, numer: 'N2', odMin: 480, doMin: 960, paczki: 1 })),
    ]
    const linie = scalOdbioryPaska(liniePaskaKuriera(wpisy, D))
    expect(linie.map((l) => [nazwaGrupyOdbioru(l.grupa), l.glowna.stan, l.glowna.paczki])).toEqual([
      ['One Kurier + WE|DO', 'BLAD', 1],
      ['One Kurier', 'ZAMOWIONY', 1],
      ['Orlen Paczka', 'ZAMOWIONY', 3],
    ])
    expect(opisZlecenia(linie[2]!.glowna, etykietaOdbioru('Allegro', linie[2]!.grupa), D)).toBe('Allegro (Orlen Paczka) zamówiony na dziś 25.11 08:00–16:00, 3 przesyłki, zlecenie nr N2')
    expect(nieudaneOdbioryDnia(linie, D).map((x) => x.grupa)).toEqual(['ALLEGRO_ONE_KURIER+WEDO.p2'])
    const p = powodPoLudzku(linie[0]!.glowna.powod)
    expect(p?.tekst).toMatch(/^Przewoźnik odrzucił ten odbiór/)
    expect(p?.szczegoly).toContain('OPENNET_ERROR')
  })
  it('różne numery tego samego przewoźnika osobno; ręczna odmowa, niewiadoma i sama odmowa nie dają ponowienia części', () => {
    const linie = scalOdbioryPaska(liniePaskaKuriera([g({ stan: 'ZAMOWIONY', grupa: 'ORLEN.p1', numer: 'A', paczki: 1 }), g({ stan: 'ZAMOWIONY', grupa: 'ORLEN.p2', numer: 'B', paczki: 1 })], D))
    expect(linie).toHaveLength(2)
    expect(nieudaneOdbioryDnia(liniePaskaKuriera([g({ stan: 'ZAMOWIONY', grupa: 'A' }), g({ stan: 'BLAD', grupa: 'B', recznie: true })], D), D)).toEqual([])
    expect(nieudaneOdbioryDnia(liniePaskaKuriera([g({ stan: 'ZAMOWIONY', grupa: 'A' }), g({ stan: 'BLAD', grupa: 'B' }), g({ stan: 'NIEJEDNOZNACZNY', grupa: 'C' })], D), D)).toEqual([])
    expect(nieudaneOdbioryDnia(liniePaskaKuriera([g({ stan: 'BLAD', grupa: 'B' })], D), D)).toEqual([])
  })
})

describe('tryb okna „Zamów kuriera” dla dnia w oknie (trybOknaKuriera)', () => {
  const D = '2026-11-25'
  const JUTRO = '2026-11-26'
  const g = (p: Partial<ZlecenieKuriera>) => z({ dzien: D, klik: 1, ...p })
  const czesciowy = () => [
    g({ stan: 'ZAMOWIONY', grupa: 'ALLEGRO_ONE_KURIER', numer: 'N1', paczki: 1, klik: 1 }),
    g({ stan: 'BLAD', grupa: 'ALLEGRO_ONE_KURIER+WEDO', powod: 'Allegro odrzuciło zamówienie odbioru (OPENNET_ERROR)', paczki: 1, klik: 1 }),
  ]
  it('część przyjęta, część odrzucona: na dzień odmowy PONOW (bez drugi); świadome „Zamów drugi raz” = DRUGI z nieudanym odbiorem', () => {
    expect(trybOknaKuriera(czesciowy(), D, D)).toEqual({ tryb: 'PONOW', przesylek: 1, nazwy: 'One Kurier + WE|DO' })
    const d = trybOknaKuriera(czesciowy(), D, D, true)
    expect(d).toMatchObject({ tryb: 'DRUGI', zamowiony: { stan: 'ZAMOWIONY', numer: 'N1' }, nieudany: { przesylek: 1, nazwy: 'One Kurier + WE|DO' } })
  })
  it('po zmianie dnia w oknie na dzień bez zleceń zwykłe zamówienie (nie „tylko ten odbiór”), także po „Zamów drugi raz”', () => {
    expect(trybOknaKuriera(czesciowy(), D, JUTRO)).toEqual({ tryb: 'ZWYKLE' })
    expect(trybOknaKuriera(czesciowy(), D, JUTRO, true)).toEqual({ tryb: 'ZWYKLE' })
  })
  it('dzień z aktywnym zleceniem albo ręcznym „nie przyjął”: DRUGI; dzień pusty: ZWYKLE (DPD bez grup)', () => {
    const dpd = [g({ stan: 'ZAMOWIONY', numer: '7' }), g({ dzien: JUTRO, stan: 'BLAD', recznie: true })]
    expect(trybOknaKuriera(dpd, D, D)).toMatchObject({ tryb: 'DRUGI', zamowiony: { numer: '7' }, nieudany: null })
    expect(trybOknaKuriera(dpd, D, JUTRO)).toMatchObject({ tryb: 'DRUGI', zamowiony: { recznie: true } })
    expect(trybOknaKuriera(dpd, D, '2026-11-27')).toEqual({ tryb: 'ZWYKLE' })
    expect(trybOknaKuriera([], D, D, true)).toEqual({ tryb: 'ZWYKLE' })
  })
  it('wszystkie odbiory dnia przyjęte (także po udanym ponowieniu): DRUGI bez nieudanego; sama odmowa bez przyjętych: ZWYKLE', () => {
    expect(trybOknaKuriera([g({ stan: 'ZAMOWIONY', grupa: 'ORLEN', paczki: 2 })], D, D)).toMatchObject({ tryb: 'DRUGI', nieudany: null })
    expect(trybOknaKuriera([g({ stan: 'BLAD', grupa: 'ORLEN', powod: 'X' })], D, D)).toEqual({ tryb: 'ZWYKLE' })
  })
  it('odmowa grupy nowsza niż przyjęty odbiór tej samej grupy (kolejne kliknięcie) ma własną linię i daje PONOW', () => {
    const w = [g({ stan: 'ZAMOWIONY', grupa: 'x.p1', proba: 1, paczki: 2 }), g({ stan: 'BLAD', grupa: 'x.p1', proba: 2, paczki: 1, powod: 'X' })]
    expect(liniePaskaKuriera(w, D).map((l) => [l.glowna.stan, l.glowna.paczki, l.pozostale.length])).toEqual([
      ['ZAMOWIONY', 2, 0],
      ['BLAD', 1, 0],
    ])
    expect(trybOknaKuriera(w, D, D)).toEqual({ tryb: 'PONOW', przesylek: 1, nazwy: 'przewoźnik bez nazwy' })
    // odmowa starsza niż przyjęty odbiór grupy zostaje zwinięta pod nim
    const stara = [g({ stan: 'BLAD', grupa: 'x.p1', proba: 1, powod: 'X' }), g({ stan: 'ZAMOWIONY', grupa: 'x.p1', proba: 2 })]
    expect(liniePaskaKuriera(stara, D).map((l) => [l.glowna.stan, l.pozostale.length])).toEqual([['ZAMOWIONY', 1]])
  })
  it('niewiadoma obok przyjętego: DRUGI z ostrzeżeniem (host i tak zwraca niewiadomą), nigdy PONOW', () => {
    const w = [g({ stan: 'ZAMOWIONY', grupa: 'A' }), g({ stan: 'BLAD', grupa: 'B', powod: 'X' }), g({ stan: 'NIEJEDNOZNACZNY', grupa: 'C' })]
    expect(trybOknaKuriera(w, D, D).tryb).toBe('DRUGI')
  })
  it('drobne 2 i 3: OPENNET_ERROR bez zdania o podjeździe, gdy go nie ma; „nie wysłano” nie mówi „przewoźnik nie przyjął”', () => {
    const odm = g({ stan: 'BLAD', grupa: 'ALLEGRO_ONE_KURIER+WEDO', powod: 'Allegro odrzuciło zamówienie odbioru (OPENNET_ERROR)' })
    expect(opisZlecenia(odm, 'Allegro', D)).not.toContain('podjeździe')
    expect(opisZlecenia(odm, 'Allegro', D, { podjazd: true })).toContain('zapytać kuriera przy zamówionym dziś podjeździe')
    const nw = g({ stan: 'BLAD', grupa: 'ORLEN', powod: 'Kompletor nie wysłał tego zamówienia odbioru, bo poprzednie odbiory długo czekały na przewoźnika: nic nie zamówiono, zamów ponownie.' })
    expect(opisZlecenia(nw, 'Allegro', D)).toMatch(/nie zostało wysłane do przewoźnika/)
    expect(opisZlecenia(nw, 'Allegro', D)).not.toContain('przewoźnik nie przyjął')
    expect(powodPoLudzku(nw.powod)).toMatchObject({ znany: true, niewyslane: true, szczegoly: null })
  })
})
