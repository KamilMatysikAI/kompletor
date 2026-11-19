// czyste funkcje zamówienia w kształcie ogólnym (suma, tolerancja zaokrągleń, walidacja treści API,
// numer formularza) i lista „Zmień status”. Bez bazy; dane fikcyjne.
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const { parseGeneralOrder, isGeneralShape } = await import('@/lib/api/zapis-ogolny')
const { sumaPozycji, sumaZgodna, kluczZdarzenia } = await import('./ogolne')
const { nowyNumerReczny, NUMER_RECZNY_RE, kwotaZPola } = await import('./formularz')
const { opcjeStatusu, powodZmiany } = await import('@/lib/praca/status-dowolny')

const baza = { kanal: 'RECZNE', numer: 'R-1', platnosc: 'PAID', dostawa: { sposob: 'Kurier DPD' }, pozycje: [{ sku: 'TEST-A', ilosc: 2, cenaBrutto: 10.5 }] }

describe('suma i tolerancja', () => {
  it('suma w groszach bez błędów float; tolerancja pół grosza na sztukę, co najmniej 1 gr na pozycję', () => {
    expect(sumaPozycji([{ ilosc: 3, cenaBrutto: 0.1 }], 0.2)).toBe(0.5)
    expect(sumaZgodna(616.38, [{ ilosc: 72, cenaBrutto: 8.56 }], null)).toBe(true) // 616,32 policzone, 6 gr różnicy, tolerancja 36 gr
    expect(sumaZgodna(617, [{ ilosc: 72, cenaBrutto: 8.56 }], null)).toBe(false)
    expect(sumaZgodna(10.01, [{ ilosc: 1, cenaBrutto: 10 }], null)).toBe(true)
    expect(sumaZgodna(10.02, [{ ilosc: 1, cenaBrutto: 10 }], null)).toBe(false)
    // sufit 0,5% sumy (najmniej 1 zł): 10 000 szt. po 1 zł = 10 000 zł, zaokrąglenia dałyby 50 zł, sufit 50 zł; 100 pozycji po 10 000 szt. sufitu 0,5%
    expect(sumaZgodna(1.5, [{ ilosc: 10_000, cenaBrutto: 0 }], null)).toBe(false) // suma 0: sufit 1 zł
    expect(sumaZgodna(1, [{ ilosc: 10_000, cenaBrutto: 0 }], null)).toBe(true)
  })
})

describe('parseGeneralOrder', () => {
  it('kształt rozpoznawany po polu kanal; domyślna metoda płatności i suma', () => {
    expect(isGeneralShape(baza)).toBe(true)
    expect(isGeneralShape({ numer: 'x' })).toBe(false)
    const z = parseGeneralOrder(baza)
    expect(z).toMatchObject({ kanal: 'RECZNE', platnoscMetoda: 'Opłacone', sumaBrutto: 21, zlozono: null, klient: null, chceFakture: false })
  })

  it('dane klienta tylko w obiekcie klient; punkt bez klienta, faktura bez danych, nieznane pola = błąd', () => {
    expect(() => parseGeneralOrder({ ...baza, telefon: '600100200' })).toThrow(/w obiekcie klient/)
    expect(() => parseGeneralOrder({ ...baza, dostawa: { sposob: 'Paczkomat', punkt: { kod: 'POZ01M' } } })).toThrow(/klient/)
    expect(() => parseGeneralOrder({ ...baza, chceFakture: true, klient: { imieNazwisko: 'Jan Testowy' } })).toThrow(/klient.faktura/)
    expect(() => parseGeneralOrder({ ...baza, klient: { imieNazwisko: 'Jan', pesel: '1' } })).toThrow(/Nieznane pole klient.pesel/)
    expect(() => parseGeneralOrder({ ...baza, dostawa: { sposob: 'x', przewoznik: 'POCZTA' } })).toThrow(/dostawa.przewoznik/)
    expect(() => parseGeneralOrder({ ...baza, klient: { imieNazwisko: 'Jan', telefon: 600100200 } })).toThrow(/klient.telefon: tekst/)
  })

  it('klient z NIP-em: faktura domyślnie tak; zły kod pocztowy bez wartości w komunikacie', () => {
    const z = parseGeneralOrder({ ...baza, klient: { firma: 'Firma Testowa', faktura: { nazwa: 'Firma Testowa', nip: '526-025-09-95' } } })
    expect(z.chceFakture).toBe(true)
    expect(z.klient?.faktura?.nip).toBe('5260250995')
    let msg = ''
    try {
      parseGeneralOrder({ ...baza, klient: { imieNazwisko: 'Jan', adres: { ulica: 'Testowa', kodPocztowy: '6000', miasto: 'Poznań' } } })
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toMatch(/NN-NNN/)
    expect(msg).not.toContain('6000')
  })

  it('klucz idempotencji: data poza kluczem, gdy jej nie podano; klient przez HMAC (bez danych w kluczu)', () => {
    const z = parseGeneralOrder({ ...baza, klient: { imieNazwisko: 'Jan Testowy' } })
    const k = kluczZdarzenia(z, 'org', Buffer.alloc(32, 1), 'reczne')
    expect(k).toMatch(/^R-1:[0-9a-f]{32}$/)
    expect(kluczZdarzenia({ ...z }, 'org', Buffer.alloc(32, 1), 'reczne')).toBe(k)
    expect(kluczZdarzenia(z, 'org', Buffer.alloc(32, 1), 'inne')).not.toBe(k) // konto w kluczu
    expect(kluczZdarzenia({ ...z, klient: { ...z.klient!, telefon: '600100200' } }, 'org', Buffer.alloc(32, 1), 'reczne')).not.toBe(k)
  })
})

describe('formularz', () => {
  it('numer ręczny z datą w Warszawie i 6 znakami; kwota z przecinkiem', () => {
    const n = nowyNumerReczny(new Date('2026-11-05T23:30:00Z'), 'abc-def-123')
    expect(n).toBe('R-20261106-ABCDEF')
    expect(NUMER_RECZNY_RE.test(n)).toBe(true)
    expect(kwotaZPola('1 200,50', 'x')).toBe(1200.5)
    expect(kwotaZPola('', 'x')).toBeNull()
    expect(() => kwotaZPola('12,345', 'Cena')).toThrow(/Cena/)
  })
})

describe('„Zmień status”: lista dozwolonych', () => {
  const fakty = { aktywne: 0, wFakturze: 0, wydane: 1, uslugi: 0, otwarteBraki: 0, fakturaWystawiona: true, fakturaWToku: false, poFakturze: true }
  const prawa = new Set(['zamowienia.status_dowolny'])

  it('Wysłane: cofnięcie do „Do wysłania”, odebrane i reklamacja z tabeli; „Do odbioru” dla kuriera z powodem', () => {
    const o = opcjeStatusu({ status: 'WYSLANE', carrier: 'DPD', pendingAction: null }, fakty, prawa)
    expect(o.find((x) => x.status === 'DO_WYSLANIA')).toMatchObject({ droga: 'COFNIECIE', powod: null })
    expect(o.find((x) => x.status === 'ODEBRANE')).toMatchObject({ droga: 'RDZEN', powod: null })
    expect(o.find((x) => x.status === 'REKLAMACJA')).toMatchObject({ droga: 'RDZEN', powod: null })
    expect(o.some((x) => x.status === 'NOWE' || x.status === 'ZBIERANIE')).toBe(false)
    const od = opcjeStatusu({ status: 'ODEBRANE', carrier: 'DPD', pendingAction: null }, fakty, prawa)
    expect(od.find((x) => x.status === 'DO_ODBIORU')?.powod).toMatch(/odbioru osobistego/)
  })

  it('anulowanie po fakturze wymaga osobnego uprawnienia; spakowanie ma własny przycisk; anulowanie w toku blokuje cofnięcia', () => {
    const o = opcjeStatusu({ status: 'DO_WYSLANIA', carrier: 'DPD', pendingAction: null }, fakty, prawa)
    expect(o.find((x) => x.status === 'ANULOWANE')?.powod).toMatch(/osobnym uprawnieniem/)
    expect(o.find((x) => x.status === 'SPAKOWANE')).toMatchObject({ droga: 'COFNIECIE', powod: null })
    expect(opcjeStatusu({ status: 'DO_WYSLANIA', carrier: 'DPD', pendingAction: null }, fakty, new Set([...prawa, 'zamowienia.anuluj_po_fakturze'])).find((x) => x.status === 'ANULOWANE')?.powod).toBeNull()
    const z = opcjeStatusu({ status: 'ZEBRANE', carrier: 'DPD', pendingAction: null }, { ...fakty, aktywne: 1, wydane: 0, poFakturze: false, fakturaWystawiona: false }, prawa)
    expect(z.find((x) => x.status === 'SPAKOWANE')?.powod).toMatch(/Spakuj/)
    expect(z.find((x) => x.status === 'DO_REALIZACJI')).toMatchObject({ droga: 'COFNIECIE', powod: null })
    const w = opcjeStatusu({ status: 'WYSLANE', carrier: 'DPD', pendingAction: 'CANCEL:CANCELLED' }, fakty, prawa)
    expect(w.find((x) => x.status === 'DO_WYSLANIA')?.powod).toMatch(/Anulowanie w toku/)
  })

  it('powód: 3–300 znaków po przycięciu, białe znaki zwinięte', () => {
    expect(powodZmiany('  ab ')).toBeNull()
    expect(powodZmiany('Kliknięte   za wcześnie')).toBe('Kliknięte za wcześnie')
    expect(powodZmiany('x'.repeat(301))).toBeNull()
    expect(powodZmiany(5)).toBeNull()
  })
})

describe('„Zmień status”: zamówienie bez paczki', () => {
  it('Odebrane bez towaru (sama usługa) nie wraca do „Wysłane”', () => {
    const f = { aktywne: 0, wFakturze: 0, wydane: 0, uslugi: 1, otwarteBraki: 0, fakturaWystawiona: true, fakturaWToku: false, poFakturze: true }
    const o = opcjeStatusu({ status: 'ODEBRANE', carrier: 'BEZ_WYSYLKI', pendingAction: null }, f, new Set(['zamowienia.status_dowolny']))
    expect(o.find((x) => x.status === 'WYSLANE')?.powod).toMatch(/bez wysyłki/)
  })
})
