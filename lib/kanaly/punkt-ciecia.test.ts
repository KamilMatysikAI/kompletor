import { describe, expect, it } from 'vitest'
import { klasyfikuj, MAKS_WIEK_KOPII_MS, opisPunktuCiecia, powodStarejKopii, stareZrodla, type PozycjaPunktuCiecia, type SwiezoscKopii, type WynikPunktuCiecia } from './punkt-ciecia'

const baza = { statusBl: null as string | null, fakturaBl: null as string | null, aktywneRezerwacje: 0, pracaKompletora: null as string | null, pendingAction: null as string | null }

describe('klasyfikuj', () => {
  it('obsłużone w BaseLinkerze → zamknięcie z właściwym statusem', () => {
    expect(klasyfikuj({ ...baza, statusBl: 'Wysłane DPD' })).toMatchObject({ grupa: 'DO_ZAMKNIECIA', na: 'WYSLANE' })
    expect(klasyfikuj({ ...baza, statusBl: 'Spakowane' })).toMatchObject({ grupa: 'DO_ZAMKNIECIA', na: 'WYSLANE' })
    expect(klasyfikuj({ ...baza, statusBl: 'Do wysłania' })).toMatchObject({ grupa: 'DO_ZAMKNIECIA', na: 'WYSLANE' })
    expect(klasyfikuj({ ...baza, statusBl: 'Do odbioru' })).toMatchObject({ grupa: 'DO_ZAMKNIECIA', na: 'WYSLANE' })
    // odbiór osobisty czekający na klienta zostaje na liście do wydania
    expect(klasyfikuj({ ...baza, statusBl: 'Do odbioru', odbiorOsobisty: true })).toMatchObject({ grupa: 'DO_ZAMKNIECIA', na: 'DO_ODBIORU' })
    expect(klasyfikuj({ ...baza, statusBl: 'Wysłane', odbiorOsobisty: true })).toMatchObject({ grupa: 'DO_ZAMKNIECIA', na: 'WYSLANE' })
    expect(klasyfikuj({ ...baza, statusBl: 'Odebrane' })).toMatchObject({ grupa: 'DO_ZAMKNIECIA', na: 'ODEBRANE' })
    expect(klasyfikuj({ ...baza, statusBl: 'E-book', fakturaBl: 'FV/1' })).toMatchObject({ grupa: 'DO_ZAMKNIECIA', na: 'ODEBRANE' })
  })

  it('nieskończone w BaseLinkerze: z fakturą i bez osobno, nigdy zamknięcie', () => {
    expect(klasyfikuj({ ...baza, statusBl: 'Do realizacji Paczkomaty', fakturaBl: 'FV/2' })).toMatchObject({ grupa: 'NIESKONCZONE_Z_FAKTURA_BL', na: null })
    expect(klasyfikuj({ ...baza, statusBl: 'Do realizacji Paczkomaty' })).toMatchObject({ grupa: 'NIESKONCZONE_BEZ_FAKTURY', na: null })
    expect(klasyfikuj({ ...baza, statusBl: 'Nowe' })).toMatchObject({ grupa: 'NIESKONCZONE_BEZ_FAKTURY' })
    expect(klasyfikuj({ ...baza, statusBl: 'Zebrane' })).toMatchObject({ grupa: 'NIESKONCZONE_BEZ_FAKTURY' })
    expect(klasyfikuj({ ...baza, statusBl: 'E-book' })).toMatchObject({ grupa: 'NIESKONCZONE_BEZ_FAKTURY' })
  })

  it('obsłużone, ale z aktywną rezerwacją, pracą Kompletora albo odłożoną operacją → nie zamyka', () => {
    expect(klasyfikuj({ ...baza, statusBl: 'Wysłane', aktywneRezerwacje: 1 })).toMatchObject({ grupa: 'CZEKA_NA_ROZLICZENIE', na: null })
    expect(klasyfikuj({ ...baza, statusBl: 'Wysłane', aktywneRezerwacje: 1, fakturaBl: 'FV/3' }).powod).toMatch(/WZ/)
    expect(klasyfikuj({ ...baza, statusBl: 'Wysłane', pracaKompletora: 'ma przesyłkę z Kompletora' })).toMatchObject({ grupa: 'DO_SPRAWDZENIA' })
    expect(klasyfikuj({ ...baza, statusBl: 'Wysłane', pendingAction: 'ANULUJ' })).toMatchObject({ grupa: 'DO_SPRAWDZENIA' })
  })

  it('anulowane, inne i bez kopii → do sprawdzenia albo bez pary', () => {
    expect(klasyfikuj({ ...baza, statusBl: 'Anulowane' })).toMatchObject({ grupa: 'DO_SPRAWDZENIA' })
    expect(klasyfikuj({ ...baza, statusBl: 'Status własny firmy' })).toMatchObject({ grupa: 'DO_SPRAWDZENIA' })
    expect(klasyfikuj(baza)).toMatchObject({ grupa: 'BEZ_PARY_W_BL' })
  })
})

describe('opisPunktuCiecia', () => {
  it('na sucho: informacja o braku zapisu, liczby grup i numery zamówień', () => {
    const w: WynikPunktuCiecia = {
      naSucho: true,
      konta: [{ channel: 'EMPIK', channelAccountId: 'm1' }],
      kontaWPracy: 1,
      pozycje: [
        { orderId: 'o1', channel: 'EMPIK', channelAccountId: 'm1', externalId: 'E-1', blOrderId: 7, status: 'DO_REALIZACJI', statusBl: 'Wysłane', fakturaBl: 'FV/7', grupa: 'DO_ZAMKNIECIA', na: 'WYSLANE', powod: 'w BaseLinkerze: Wysłane', towarCzekal: false },
        { orderId: 'o2', channel: 'EMPIK', channelAccountId: 'm1', externalId: 'E-2', blOrderId: 8, status: 'DO_REALIZACJI', statusBl: 'Do realizacji', fakturaBl: 'FV/8', grupa: 'NIESKONCZONE_Z_FAKTURA_BL', na: null, powod: 'w BaseLinkerze: Do realizacji, z fakturą', towarCzekal: true },
      ],
      liczby: { DO_ZAMKNIECIA: 1, NIESKONCZONE_Z_FAKTURA_BL: 1, NIESKONCZONE_BEZ_FAKTURY: 0, CZEKA_NA_ROZLICZENIE: 0, DO_SPRAWDZENIA: 0, BEZ_PARY_W_BL: 0 },
      zamkniete: 0,
      bledy: [],
      wKolejcePakowania: 3,
      wKolejceZFakturaBl: 1,
      towarCzekal: 1,
      swiezosc: { zamowienia: new Date('2026-11-19T07:55:00Z'), dziennik: new Date('2026-11-19T07:00:00Z'), faktury: null, perKonto: [{ channel: 'EMPIK', channelAccountId: 'm1', ostatniaKopia: null }], maksWiekMs: MAKS_WIEK_KOPII_MS },
      sprawdzonoO: new Date('2026-11-19T08:00:00Z'),
      odmowa: null,
    }
    const md = opisPunktuCiecia(w)
    expect(md).toContain('na sucho')
    expect(md).toContain('konta w trybie pracy: 1 (tylko zamówienia z rozliczoną fakturą BaseLinkera)')
    expect(md).toContain('do zamknięcia w Kompletorze: 1')
    expect(md).toContain('- EMPIK/m1 E-1 (BL 7): w BaseLinkerze: Wysłane, faktura FV/7 → Wysłane')
    expect(md).toContain('kolejce pakowania (do realizacji, zbieranie, zebrane): 3')
    expect(md).toContain('W tym z fakturą BL (kończy je BaseLinker; po włączeniu trybu pracy Kompletor zdejmie je z kolejki „do spakowania” i wstrzyma ich pakowanie): 1; pozostałe do spakowania w Kompletorze: 2')
    // osobna lista „sprawdź, czy towar dojechał”
    expect(md).toContain('## Do sprawdzenia: zafakturowane w BaseLinkerze, a towar czekał na dostawę (sprawdź, czy dojechał, zanim BaseLinker je spakuje): 1\n- EMPIK/m1 E-2 (BL 8), faktura FV/8')
    // każdy czas osobno; za stare (dziennik godzinę temu, faktury nigdy) oznaczone jako blokujące, świeża lista nie
    expect(md).toContain('lista zamówień z okna 19.11.2026, 08:55:00, dziennik statusów 19.11.2026, 08:00:00 (za stare: blokuje zapis), faktury nigdy (za stare: blokuje zapis)')
    expect(md).toContain('EMPIK/m1 nigdy')
  })
})

describe('powodStarejKopii', () => {
  const now = new Date('2026-11-19T08:00:00Z')
  const s = (zamowienia: Date | null, faktury: Date | null, maksWiekMs = MAKS_WIEK_KOPII_MS, dziennik: Date | null = zamowienia): SwiezoscKopii => ({ zamowienia, dziennik, faktury, perKonto: [], maksWiekMs })
  const min = (n: number) => new Date(now.getTime() - n * 60_000)

  it('świeża lista zamówień, dziennik i faktury → brak odmowy', () => {
    expect(powodStarejKopii(s(min(14), min(1)), now)).toBeNull()
    expect(stareZrodla(s(min(14), min(1)), now)).toEqual([])
  })

  it('stare albo brak odczytu → odmowa z tym, czego brakuje, i poleceniem odświeżenia', () => {
    expect(powodStarejKopii(s(min(16), min(1), MAKS_WIEK_KOPII_MS, min(1)), now)).toMatch(/starsza niż 15 min \(lista zamówień z okna odczytane .*\): najpierw odśwież odczyt/)
    expect(powodStarejKopii(s(min(1), null), now)).toMatch(/faktury nigdy nieodczytane/)
    expect(powodStarejKopii(s(null, null), now)).toMatch(/lista zamówień z okna nigdy nieodczytane, dziennik statusów nigdy nieodczytane, faktury nigdy nieodczytane/)
  })

  it('świeża lista zamówień nie zastępuje starego dziennika statusów (nigdy „nowszy z dwóch”)', () => {
    const stary = s(min(1), min(1), MAKS_WIEK_KOPII_MS, min(40))
    expect(stareZrodla(stary, now)).toEqual(['dziennik'])
    expect(powodStarejKopii(stary, now)).toMatch(/\(dziennik statusów odczytane /)
    expect(stareZrodla(s(min(1), min(1), MAKS_WIEK_KOPII_MS, null), now)).toEqual(['dziennik'])
    // odwrotnie: świeży dziennik nie zastępuje starej listy zamówień z okna
    expect(stareZrodla(s(min(40), min(1), MAKS_WIEK_KOPII_MS, min(1)), now)).toEqual(['zamowienia'])
  })

  it('próg z parametru', () => {
    expect(powodStarejKopii(s(min(50), min(50), 60 * 60_000), now)).toBeNull()
    expect(powodStarejKopii(s(min(50), min(50), 30 * 60_000), now)).toMatch(/starsza niż 30 min/)
  })
})

describe('klasyfikuj: konto w trybie pracy', () => {
  const praca = { ...baza, fakturaBl: 'FV/BL/1', kontoWPracy: true }
  it('zamyka tylko „Wysłane” i „Odebrane” z BaseLinkera', () => {
    expect(klasyfikuj({ ...praca, statusBl: 'Wysłane DPD' })).toMatchObject({ grupa: 'DO_ZAMKNIECIA', na: 'WYSLANE' })
    expect(klasyfikuj({ ...praca, statusBl: 'Odebrane' })).toMatchObject({ grupa: 'DO_ZAMKNIECIA', na: 'ODEBRANE' })
  })
  it('„Spakowane”, „Do wysłania”, „Do odbioru” i e-book → do sprawdzenia, bez zamknięcia', () => {
    for (const s of ['Spakowane', 'Do wysłania', 'Do wysyłki', 'Do odbioru', 'E-book']) {
      const k = klasyfikuj({ ...praca, statusBl: s })
      expect(k, s).toMatchObject({ grupa: 'DO_SPRAWDZENIA', na: null })
      expect(k.powod, s).toMatch(/trybie pracy/)
    }
    expect(klasyfikuj({ ...praca, statusBl: 'Do odbioru', odbiorOsobisty: true })).toMatchObject({ grupa: 'DO_SPRAWDZENIA', na: null })
    // e-book ma własny powód (bez „paczki”)
    expect(klasyfikuj({ ...praca, statusBl: 'E-book' }).powod).toMatch(/e-book .*sprawdź, czy klient dostał plik/)
    expect(klasyfikuj({ ...praca, statusBl: 'Spakowane' }).powod).toMatch(/sprawdź, czy paczka wyszła/)
  })
  it('konto w podglądzie bez zmian', () => {
    expect(klasyfikuj({ ...baza, statusBl: 'Spakowane', kontoWPracy: false })).toMatchObject({ grupa: 'DO_ZAMKNIECIA', na: 'WYSLANE' })
  })

  it('konto w trybie pracy: osobna linia z liczbą jego zamówień z fakturą BL według grup', () => {
    const poz = (orderId: string, channelAccountId: string, grupa: PozycjaPunktuCiecia['grupa']): PozycjaPunktuCiecia => ({ orderId, channel: 'WOO', channelAccountId, externalId: orderId, blOrderId: 1, status: 'DO_REALIZACJI', statusBl: 'Wysłane', fakturaBl: 'FV/1', grupa, na: null, powod: '', towarCzekal: false })
    const w: WynikPunktuCiecia = {
      naSucho: true,
      konta: [{ channel: 'WOO', channelAccountId: 'podglad' }],
      kontaWPracy: 1,
      pozycje: [poz('p1', 'podglad', 'DO_ZAMKNIECIA'), poz('w1', 'praca', 'DO_ZAMKNIECIA'), poz('w2', 'praca', 'DO_ZAMKNIECIA'), poz('w3', 'praca', 'DO_SPRAWDZENIA'), poz('w4', 'praca', 'NIESKONCZONE_Z_FAKTURA_BL')],
      liczby: { DO_ZAMKNIECIA: 3, NIESKONCZONE_Z_FAKTURA_BL: 1, NIESKONCZONE_BEZ_FAKTURY: 0, CZEKA_NA_ROZLICZENIE: 0, DO_SPRAWDZENIA: 1, BEZ_PARY_W_BL: 0 },
      zamkniete: 0,
      bledy: [],
      wKolejcePakowania: 0,
      wKolejceZFakturaBl: 0,
      towarCzekal: 0,
      swiezosc: { zamowienia: null, dziennik: null, faktury: null, perKonto: [], maksWiekMs: MAKS_WIEK_KOPII_MS },
      sprawdzonoO: new Date('2026-11-19T08:00:00Z'),
      odmowa: null,
    }
    expect(opisPunktuCiecia(w)).toContain('Konta w trybie pracy, zamówienia z fakturą BaseLinkera: 4 (do zamknięcia 2, nieskończone w BaseLinkerze 1, do sprawdzenia 1)')
    expect(opisPunktuCiecia({ ...w, kontaWPracy: 0 })).not.toContain('Konta w trybie pracy, zamówienia')
  })
})
