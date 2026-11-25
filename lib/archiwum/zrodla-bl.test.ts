import { describe, expect, it } from 'vitest'
import type { Channel } from '@prisma/client'
import { bezDanychOsobowychFaktury, fakturaBlZSurowej, parujZeZrodlami, zrodloFakturyBl, type KandydatPary } from './faktury-bl'
import { bladSpozaMapy, normalizujNazweZrodla, parsujMapeZrodel, POMIN, tekstZrodelBl, zrodlaBlZCsv } from './zrodla-bl'

const OPCJE = { kanalKonta: 'ALLEGRO', kanalyArchiwum: ['WOO', 'ALLEGRO', 'EMPIK', 'EASYTOOLS'] } satisfies { kanalKonta: Channel; kanalyArchiwum: Channel[] }
const MAPA = parsujMapeZrodel('konto_aukcji=ALLEGRO; Sklep testowy=WOO;Rynek X=EMPIK;Osobiście/tel.=POMIN', OPCJE)

describe('mapa źródeł z wywołania', () => {
  it('nazwa=KANAŁ; spacje, ukośnik, małe litery kanału, nazwa znormalizowana', () => {
    expect([...parsujMapeZrodel('A  b/c=allegro;d=WOO;e=pomin;', OPCJE)]).toEqual([['a b/c', 'ALLEGRO'], ['d', 'WOO'], ['e', POMIN]])
  })
  it('błędy: pusta mapa, brak nazwy, kanał bez archiwum, dubel po normalizacji, brak kanału konta, znak zastępczy', () => {
    expect(() => parsujMapeZrodel(' ; ', OPCJE)).toThrow(/pusta/)
    expect(() => parsujMapeZrodel('=ALLEGRO', OPCJE)).toThrow(/bez nazwy/)
    expect(() => parsujMapeZrodel('a=AI;b=ALLEGRO', OPCJE)).toThrow(/„AI” nie ma importu archiwum/)
    expect(() => parsujMapeZrodel('a=RECZNE;b=ALLEGRO', OPCJE)).toThrow(/„RECZNE” nie ma importu archiwum.*POMIN/)
    expect(() => parsujMapeZrodel('a=BL_INNE;b=ALLEGRO', OPCJE)).toThrow(/nie ma importu archiwum/)
    expect(() => parsujMapeZrodel('a=WOO;A =EMPIK;b=ALLEGRO', OPCJE)).toThrow(/dwa razy/)
    expect(() => parsujMapeZrodel('a=WOO;b=POMIN', OPCJE)).toThrow(/brak wpisu z kanałem importowanego konta \(ALLEGRO\)/)
    expect(() => parsujMapeZrodel('Osobi�cie=POMIN;b=ALLEGRO', OPCJE)).toThrow(/U\+FFFD/)
  })
  it('normalizacja: NFC, brzegi, zwinięte spacje, wielkość liter', () => {
    expect(normalizujNazweZrodla('  Osobiście/TEL.\t  x ')).toBe(normalizujNazweZrodla('osobiście/tel. x'))
  })
})

describe('plik źródeł BL', () => {
  const csv = ['order_id;pochodzenie;status;data;waluta', '101;KONTO_aukcji;Wysłane;2025-06-01T10:00:00;PLN', '102;Sklep testowy;Wysłane;2025-06-01T11:00:00;pln', '103;"Rynek X";Anulowane;2025-06-02T10:00:00;', '104;999;Wysłane;2024-11-02T10:00:00;PLN', '105;999;Wysłane;2024-11-02T10:00:00;PLN', '101;konto_aukcji ;Wysłane;2025-06-01T10:00:00;PLN', ''].join('\r\n')

  it('kanał per order_id po normalizacji nazw, źródło spoza mapy bez kanału, powtórzony wiersz liczony raz, BOM i CRLF, waluta', () => {
    const z = zrodlaBlZCsv(`﻿${csv}`, MAPA)
    expect(z.wierszy).toBe(5)
    expect([...z.kanal]).toEqual([[101, 'ALLEGRO'], [102, 'WOO'], [103, 'EMPIK']])
    expect([...z.spozaMapy]).toEqual([['999', [104, 105]]])
    expect([...z.waluta]).toEqual([[101, 'PLN'], [102, 'PLN'], [104, 'PLN'], [105, 'PLN']])
  })
  it('nazwa spoza mapy = błąd z nazwą, liczbą zamówień i faktur', () => {
    const z = zrodlaBlZCsv(csv, MAPA)
    expect(bladSpozaMapy(z, [104, 104, 101])).toMatch(/„999” \(zamówień 2, faktur 2\).*POMIN.*nic nie zapisano/)
    expect(bladSpozaMapy(zrodlaBlZCsv('order_id;pochodzenie\n1;konto_aukcji', MAPA), [1])).toBeNull()
  })
  it('wystarczą order_id i pochodzenie, kolejność kolumn dowolna, końcowy średnik nagłówka', () => {
    expect([...zrodlaBlZCsv('pochodzenie;order_id\nkonto_aukcji;7', MAPA).kanal]).toEqual([[7, 'ALLEGRO']])
    expect([...zrodlaBlZCsv('order_id;pochodzenie;\n7;konto_aukcji;', MAPA).kanal]).toEqual([[7, 'ALLEGRO']])
  })
  it('kolumna spoza listy (dane klienta z surowego eksportu) = błąd całego pliku, bez wartości w komunikacie', () => {
    const e = () => zrodlaBlZCsv('order_id;pochodzenie;email\n1;konto_aukcji;ktos@example.test', MAPA)
    expect(e).toThrow(/kolumny spoza listy \(email\)/)
    expect(() => zrodlaBlZCsv('order_id;pochodzenie;Telefon klienta;;x\n1;a;1;2;3', MAPA)).toThrow(/kolumny spoza listy \(\(nieczytelna nazwa\), \(pusta nazwa\), x\)/)
  })
  it('plik bez nagłówka nie wypisuje wartości z pierwszego wiersza', () => {
    let komunikat = ''
    try {
      zrodlaBlZCsv('7002;Jan Kowalski;ktos@example.test;600100200\n7003;konto_aukcji;;', MAPA)
    } catch (x) {
      komunikat = String(x)
    }
    expect(komunikat).toMatch(/pierwszy wiersz musi być nagłówkiem.*kolumn w pierwszym wierszu: 4/)
    expect(komunikat).not.toMatch(/Kowalski|example|600100200|7002/)
  })
  const komunikatBledu = (f: () => unknown) => {
    try {
      f()
    } catch (x) {
      return String(x)
    }
    return ''
  }
  it('przegląd r2 W-B: wiersz z inną liczbą pól niż nagłówek = błąd z samym numerem wiersza i liczbami pól', () => {
    const nadmiar = komunikatBledu(() => zrodlaBlZCsv('order_id;pochodzenie\n7001;konto_aukcji\n7002;ktos@example.test;konto_aukcji', MAPA))
    expect(nadmiar).toMatch(/wiersz 3: pól 3, w nagłówku 2/)
    expect(nadmiar).not.toMatch(/example|7002|konto_aukcji/)
    const brak = komunikatBledu(() => zrodlaBlZCsv('order_id;pochodzenie;status;data;waluta\n7001;Jan Kowalski;Wysłane', MAPA))
    expect(brak).toMatch(/wiersz 2: pól 3, w nagłówku 5/)
    expect(brak).not.toMatch(/Kowalski/)
    // końcowe puste pola (średnik z Excela) nie są przesunięciem; puste pola w środku też nie
    expect([...zrodlaBlZCsv('order_id;pochodzenie;status\n7;konto_aukcji;;;\n8;Sklep testowy;;', MAPA).kanal]).toEqual([[7, 'ALLEGRO'], [8, 'WOO']])
    expect(() => zrodlaBlZCsv('order_id;pochodzenie\n7;konto_aukcji;;x', MAPA)).toThrow(/wiersz 2: pól 4, w nagłówku 2/)
  })
  it('przegląd r2 W-B: nazwa spoza mapy wyglądająca na dane osobowe nie trafia do komunikatu', () => {
    const z = zrodlaBlZCsv(['order_id;pochodzenie', '1;ktos@example.test', '2;600 100 200', `3;${'x'.repeat(41)}`, '4;konto zapasowe', '5;439'].join('\n'), MAPA)
    const k = bladSpozaMapy(z, [1, 2, 3, 4, 5]) ?? ''
    expect(k).toMatch(/\(nazwa wygląda na dane osobowe: wiersz 2 pliku źródeł\)/)
    expect(k).toMatch(/wiersz 3 pliku źródeł/)
    expect(k).toMatch(/wiersz 4 pliku źródeł/)
    expect(k).toMatch(/„konto zapasowe” \(zamówień 1, faktur 1\)/)
    expect(k).toMatch(/„439”/)
    expect(k).not.toMatch(/example|600|xxxxxxxx/)
    // obrona w głąb: klucz z danymi osobowymi podany z zewnątrz też nie przechodzi
    expect(bladSpozaMapy({ kanal: new Map(), waluta: new Map(), spozaMapy: new Map([['ktos@example.test', [1]]]), wierszy: 1 }, [1])).not.toMatch(/example/)
  })
  it('kodowanie: niepoprawny UTF-8 i znak zastępczy w nazwie = błąd', () => {
    expect(() => tekstZrodelBl(Uint8Array.from([0x6f, 0x72, 0x9c, 0x0a]))).toThrow(/nie jest w UTF-8/)
    expect(tekstZrodelBl(new TextEncoder().encode('Osobiście'))).toBe('Osobiście')
    expect(() => zrodlaBlZCsv('order_id;pochodzenie\n1;Osobi�cie/tel.', MAPA)).toThrow(/wiersz 2: nazwa źródła nie jest w UTF-8/)
  })
  it('brak wymaganych kolumn, zły numer, sprzeczny dubel = błąd', () => {
    expect(() => zrodlaBlZCsv('order_id;status\n1;x', MAPA)).toThrow(/wymaganymi/)
    expect(() => zrodlaBlZCsv('order_id;pochodzenie\n1a;konto_aukcji', MAPA)).toThrow(/wiersz 2: order_id/)
    expect(() => zrodlaBlZCsv('order_id;pochodzenie\n1;', MAPA)).toThrow(/puste pochodzenie/)
    expect(() => zrodlaBlZCsv('order_id;pochodzenie\n1;konto_aukcji\n1;Sklep testowy', MAPA)).toThrow(/dwoma różnymi/)
  })
})

describe('źródło archiwum z faktur z plikiem źródeł', () => {
  const T0 = Date.UTC(2025, 5, 10, 10) / 1000
  const surowa = (invoice_id: number, order_id: number, o: Record<string, unknown> = {}) =>
    bezDanychOsobowychFaktury({ invoice_id, order_id, type: 'normal', number: `${invoice_id}/6/2025`, date_sell: T0, currency: 'PLN', total_price_brutto: 40, items: [{ name: 'Towar testowy', sku: 'A-1', price_brutto: 40, quantity: 1, is_shipment: 0, order_product_id: 1 }], ...o })
  const para: KandydatPary = { kanal: 'WOO', id: 'w1', czas: new Date(T0 * 1000), bruttoGr: 4000, waluta: 'PLN', skus: [] }
  const zrodla = zrodlaBlZCsv('order_id;pochodzenie;waluta\n1;konto_aukcji;EUR\n2;Sklep testowy;\n3;Osobiście/tel.;', MAPA)

  it('Allegro z pliku = bez flagi i z inną rewizją; inny kanał i POMIN = pominięte z datą; bez wpisu = jak dotąd; sprzeczna waluta = ostrzeżenie', async () => {
    // faktura 11 (Allegro w pliku) ma też „parę” po kwocie: plik wygrywa
    const zr = zrodloFakturyBl([surowa(11, 1), surowa(12, 2), surowa(13, 3), surowa(14, 4), surowa(15, 5)], new Map([[11, para], [15, para]]), null, zrodla)
    const s = (await zr.czytaj({ od: new Date(0), do: new Date(), strona: 1, naStrone: 500 })).zamowienia
    const [a, b, c, d, e] = s.map((r) => zr.mapuj(r))
    if (a!.rodzaj !== 'zamowienie' || d!.rodzaj !== 'zamowienie') throw new Error('oczekiwane zamówienia')
    expect(a!.zamowienie).toMatchObject({ externalId: '11', kanalOdtworzony: false, blOrderId: 1, currency: 'PLN' })
    expect(a!.zamowienie.sourceRevision).toMatch(/\|zrodla-bl$/)
    expect(a!.zamowienie.warnings).toEqual([expect.stringMatching(/waluta w pliku źródeł BL \(EUR\) inna niż na fakturze \(PLN\)/)])
    const czas = new Date(T0 * 1000)
    expect(b).toEqual({ rodzaj: 'pominiete', powod: 'inny kanał wg źródeł BL', czas })
    expect(c).toEqual({ rodzaj: 'pominiete', powod: 'inny kanał wg źródeł BL', czas })
    expect(d!.zamowienie.kanalOdtworzony).toBeUndefined()
    expect(d!.zamowienie.sourceRevision).not.toMatch(/zrodla-bl/)
    expect(e).toEqual({ rodzaj: 'pominiete', powod: 'para w innym kanale' })
  })
  it('bez pliku źródeł: mapowanie identyczne jak przed zmianą', async () => {
    const bez = zrodloFakturyBl([surowa(11, 1)], new Map())
    const s = (await bez.czytaj({ od: new Date(0), do: new Date(), strona: 1, naStrone: 500 })).zamowienia
    const m = bez.mapuj(s[0]!)
    if (m.rodzaj !== 'zamowienie') throw new Error('oczekiwane zamówienie')
    expect(m.zamowienie.kanalOdtworzony).toBeUndefined()
    expect(m.zamowienie.sourceRevision).toBe('4000|0|1')
  })
})

describe('parowanie z plikiem źródeł', () => {
  const T0 = Date.UTC(2025, 5, 11, 9)
  const fb = (invoice_id: number, czas: number, brutto = 52.5) => fakturaBlZSurowej({ invoice_id, order_id: 7000 + invoice_id, type: 'normal', number: `${invoice_id}/6/2025`, date_sell: czas / 1000, currency: 'PLN', total_price_brutto: brutto, items: [{ name: 'T', sku: 'A-1', price_brutto: brutto, quantity: 1, is_shipment: 0, order_product_id: 1 }] })
  const w: KandydatPary = { kanal: 'archiwum:WOO:sklep-1', id: 'W', czas: new Date(T0 - 3_600_000), bruttoGr: 5250, waluta: 'PLN', skus: [] }
  const e: KandydatPary = { kanal: 'zamowienie:EMPIK:empik-1', id: 'E', czas: new Date(T0 - 3_600_000), bruttoGr: 5250, waluta: 'PLN', skus: [] }

  it('scenariusz z przeglądu: A (wpis WOO) zajmuje W, B (bez wpisu, dzień później) zostaje Allegro odtworzonym', () => {
    const A = fb(1, T0 - 1_800_000)
    const B = fb(2, T0 + 86_400_000)
    const r = parujZeZrodlami([B], [{ f: A, kanal: 'WOO' }], [w])
    expect([...r.wlasne].map(([id, k]) => [id, k.id])).toEqual([[1, 'W']])
    expect(r.pary.size).toBe(0)
    expect(r.bezOdpowiednika).toEqual([])
  })
  it('faktura z wpisem paruje się tylko z kandydatami swojego kanału; bez nich = bez odpowiednika, a kandydat innego kanału zostaje dla faktur bez wpisu', () => {
    const A = fb(1, T0)
    const B = fb(2, T0 + 3_600_000)
    const r = parujZeZrodlami([B], [{ f: A, kanal: 'WOO' }], [e])
    expect(r.wlasne.size).toBe(0)
    expect(r.bezOdpowiednika.map((f) => f.invoiceId)).toEqual([1])
    expect(r.pary.get(2)?.id).toBe('E')
  })
  it('bez faktur z wpisem = zwykłe parowanie', () => {
    const r = parujZeZrodlami([fb(2, T0)], [], [w, e])
    expect(r.pary.size).toBe(1)
    expect(r.wlasne.size).toBe(0)
  })
})
