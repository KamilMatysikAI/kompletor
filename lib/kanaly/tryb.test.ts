// warunki przełączenia konta na „Aktywny” (bez bazy).
import { describe, expect, it } from 'vitest'
import { ALLEGRO_MANIFEST } from '@/lib/adaptery/allegro'
import { ALLEGRO_ZAPIS_MANIFEST } from '@/lib/adaptery/allegro-zapis'
import { WOO_MANIFEST } from '@/lib/adaptery/woo'
import { WOO_ZAPIS_MANIFEST } from '@/lib/adaptery/woo-zapis'
import { blokadaInstancji, domyslnyTryb, kluczeZapisu, kontoTylkoApi, maEnvPrefix, mozna, OPIS_TRYBU_NOWEGO_KONTA, prowadziZamowienia, trybKonta, trybyPol, warunkiPracy, warunkiZapisu } from './tryb'

const baza = { active: true, testOk: true, offers: 3, manifest: WOO_ZAPIS_MANIFEST, config: {}, firmaZBl: false }

describe('tryb konta', () => {
  it('gotowe konto bez zapisu: wolno, z ostrzeżeniem o wyłączonym zapisie', () => {
    const w = warunkiPracy(baza, {})
    expect(mozna(w)).toBe(true)
    expect(w.map((x) => x.tekst).join(' ')).toMatch(/Zapis do sklepu jest wyłączony/)
  })
  it('blokuje: wyłączone konto, niesprawdzone połączenie, zapis bez mapy statusów', () => {
    expect(mozna(warunkiPracy({ ...baza, active: false }, {}))).toBe(false)
    expect(mozna(warunkiPracy({ ...baza, testOk: null }, {}))).toBe(false)
    expect(mozna(warunkiPracy({ ...baza, testOk: false }, {}))).toBe(false)
    const bezMapy = warunkiPracy({ ...baza, config: { zapisWlaczony: true, statusy: {} } }, {})
    expect(bezMapy.find((x) => x.blokuje)?.tekst).toMatch(/Zmapuj statusy/)
    expect(mozna(warunkiPracy({ ...baza, config: { zapisWlaczony: true, statusy: { WYSLANE: 'completed' } } }, {}))).toBe(true)
  })
  it('firma z BaseLinkerem: tylko z wyłącznikiem instancji; zła wartość zmiennej blokuje', () => {
    expect(blokadaInstancji({}, false)).toBeNull()
    expect(blokadaInstancji({}, true)).toMatch(/BaseLinkera/)
    expect(blokadaInstancji({ EKRANY_PRACA: '1' }, true)).toBeNull()
    expect(blokadaInstancji({ EKRANY_PRACA: 'tak' }, false)).toMatch(/Zła wartość/)
    expect(mozna(warunkiPracy({ ...baza, firmaZBl: true }, { EKRANY_PRACA: '1' }))).toBe(true)
  })
  it('teksty warunków bez dubla „Najpierw”', () => {
    const w = warunkiPracy({ ...baza, active: false, testOk: null, config: { zapisWlaczony: true } }, {})
    for (const x of w) expect(x.tekst).not.toMatch(/Najpierw/)
  })
  it('wyłącznik zapisu: tylko wersja z zapisem i z kluczem zapisu; reszta to ostrzeżenia', () => {
    const z = { active: true, manifest: WOO_ZAPIS_MANIFEST, config: {}, tryb: 'CIEN' as const, sekrety: new Set<string>(), zEnv: false }
    expect(kluczeZapisu(WOO_ZAPIS_MANIFEST)).toEqual(['WOO_WRITE_KEY', 'WOO_WRITE_SECRET'])
    expect(mozna(warunkiZapisu(z))).toBe(false) // brak klucza zapisu
    expect(mozna(warunkiZapisu({ ...z, zEnv: true }))).toBe(true) // klucze z pliku serwera
    const zKluczem = warunkiZapisu({ ...z, sekrety: new Set(['WOO_WRITE_KEY', 'WOO_WRITE_SECRET']) })
    expect(mozna(zKluczem)).toBe(true)
    expect(zKluczem.map((x) => x.tekst).join(' ')).toMatch(/Tylko podgląd/)
    expect(mozna(warunkiZapisu({ ...z, manifest: WOO_MANIFEST }))).toBe(false) // wersja tylko do odczytu
    expect(mozna(warunkiZapisu({ ...z, manifest: null }))).toBe(false)
  })
  it('wyłącznik zapisu Allegro: allegro.zapis.v1 bez osobnych kluczy zapisu, allegro.v1 tylko czyta', () => {
    const z = { active: true, manifest: ALLEGRO_ZAPIS_MANIFEST, config: {}, tryb: 'CIEN' as const, sekrety: new Set<string>(), zEnv: false }
    expect(kluczeZapisu(ALLEGRO_ZAPIS_MANIFEST)).toEqual([])
    expect(mozna(warunkiZapisu(z))).toBe(true)
    expect(mozna(warunkiZapisu({ ...z, manifest: ALLEGRO_MANIFEST }))).toBe(false)
  })
  it('tryb jedną wartością', () => {
    expect(trybKonta({ stockMode: 'PRACA', statusMode: 'PRACA', trackingMode: 'PRACA' })).toBe('PRACA')
    expect(trybKonta({ stockMode: 'CIEN', statusMode: 'CIEN', trackingMode: 'CIEN' })).toBe('CIEN')
    expect(trybKonta({ stockMode: 'PRACA', statusMode: 'CIEN', trackingMode: 'CIEN' })).toBe('MIESZANY')
  })
})

// tryb pracy bez zapisu stanów
describe('praca bez stanów', () => {
  it('odczyt z trzech pól: tylko stany w podglądzie = BEZ_STANOW; inne układy dalej MIESZANY', () => {
    expect(trybKonta({ stockMode: 'CIEN', statusMode: 'PRACA', trackingMode: 'PRACA' })).toBe('BEZ_STANOW')
    expect(trybKonta({ stockMode: 'CIEN', statusMode: 'PRACA', trackingMode: 'CIEN' })).toBe('MIESZANY')
    expect(trybKonta({ stockMode: 'CIEN', statusMode: 'CIEN', trackingMode: 'PRACA' })).toBe('MIESZANY')
  })
  it('pola trybu dla wyboru z panelu i powrót przez trybKonta', () => {
    expect(trybyPol('BEZ_STANOW')).toEqual({ stockMode: 'CIEN', statusMode: 'PRACA', trackingMode: 'PRACA' })
    expect(trybyPol('PRACA')).toEqual({ stockMode: 'PRACA', statusMode: 'PRACA', trackingMode: 'PRACA' })
    expect(trybyPol('CIEN')).toEqual({ stockMode: 'CIEN', statusMode: 'CIEN', trackingMode: 'CIEN' })
    for (const t of ['BEZ_STANOW', 'PRACA', 'CIEN'] as const) expect(trybKonta(trybyPol(t))).toBe(t)
  })
  it('prowadzi zamówienia: praca i praca bez stanów, nie podgląd ani mieszany', () => {
    expect(prowadziZamowienia('PRACA')).toBe(true)
    expect(prowadziZamowienia('BEZ_STANOW')).toBe(true)
    expect(prowadziZamowienia('CIEN')).toBe(false)
    expect(prowadziZamowienia('MIESZANY')).toBe(false)
  })
  it('warunki: te same blokady, ostrzeżenia mówią, że stany zostają w dotychczasowym systemie', () => {
    const w = warunkiPracy({ ...baza, offers: 0, firmaZBl: true, bezStanow: true }, { EKRANY_PRACA: '1' })
    expect(mozna(w)).toBe(true)
    const t = w.map((x) => x.tekst).join(' ')
    expect(t).toMatch(/Wysyłanie stanów ofert zostaw w BaseLinkerze włączone/)
    expect(t).toMatch(/nie dostanie statusów ani numerów nadania/)
    expect(t).not.toMatch(/stany nie będą wysyłane/)
    expect(mozna(warunkiPracy({ ...baza, testOk: null, bezStanow: true }, {}))).toBe(false)
    expect(mozna(warunkiPracy({ ...baza, config: { zapisWlaczony: true, statusy: {} }, bezStanow: true }, {}))).toBe(false)
  })
  it('konto tylko przez API (EasyTools): bez testu połączenia, bez ostrzeżeń o sklepie i BaseLinkerze', () => {
    const api = { active: true, testOk: null, offers: 0, manifest: null, config: {}, firmaZBl: true, tylkoApi: true }
    for (const bezStanow of [false, true]) {
      const w = warunkiPracy({ ...api, bezStanow }, { EKRANY_PRACA: '1' })
      expect(mozna(w)).toBe(true)
      const t = w.map((x) => x.tekst).join(' ')
      expect(t).toMatch(/przez API Kompletora/)
      expect(t).not.toMatch(/Sprawdź połączenie|Zapis do sklepu|wyłącz w nim|przypisanych ofert/)
    }
    // te same twarde bramki co reszta: wyłączone konto i instancja bez trybu pracy dla firmy z BL
    expect(mozna(warunkiPracy({ ...api, active: false }, { EKRANY_PRACA: '1' }))).toBe(false)
    expect(mozna(warunkiPracy(api, {}))).toBe(false)
    // nieudany test (np. ktoś kliknął „Sprawdź połączenie” na koncie bez adaptera) nie blokuje konta tylko przez API
    expect(mozna(warunkiPracy({ ...api, testOk: false }, { EKRANY_PRACA: '1' }))).toBe(true)
    expect(kontoTylkoApi('EASYTOOLS')).toBe(true)
    for (const c of ['WOO', 'ALLEGRO', 'EMPIK', 'RECZNE', 'BL_INNE'] as const) expect(kontoTylkoApi(c)).toBe(false)
  })
  it('wyłącznik zapisu przy pracy bez stanów: bez „Tylko podgląd”, z informacją o stanach', () => {
    const z = warunkiZapisu({ active: true, manifest: WOO_ZAPIS_MANIFEST, config: {}, tryb: 'BEZ_STANOW', sekrety: new Set(['WOO_WRITE_KEY', 'WOO_WRITE_SECRET']), zEnv: false })
    const t = z.map((x) => x.tekst).join(' ')
    expect(t).not.toMatch(/Tylko podgląd/)
    expect(t).toMatch(/stanów ofert Kompletor nie wyśle/)
  })
})

// poprawki z i
describe('zapis do sklepu i nowe konto', () => {
  it('instancja bez trybu pracy dla firmy z BL = ostrzeżenie (nie blokada) zamiast „ruszy po trybie pracy”', () => {
    const s = { active: true, manifest: WOO_ZAPIS_MANIFEST, config: { statusy: { WYSLANE: 'completed' } }, tryb: 'CIEN' as const, sekrety: new Set(['WOO_WRITE_KEY', 'WOO_WRITE_SECRET']), zEnv: false }
    const w = warunkiZapisu({ ...s, blokadaInstancji: blokadaInstancji({}, true) })
    expect(mozna(w)).toBe(true)
    expect(w.map((x) => x.tekst).join(' ')).toMatch(/wyłączony tryb pracy.*nic do sklepu nie wyśle/)
    expect(w.map((x) => x.tekst).join(' ')).not.toMatch(/ruszy dopiero po włączeniu trybu pracy/)
    expect(warunkiZapisu({ ...s, blokadaInstancji: null }).map((x) => x.tekst).join(' ')).toMatch(/ruszy dopiero po włączeniu trybu pracy/)
  })
  it('pusty albo biały przedrostek env nie liczy się jako klucze z pliku', () => {
    expect(maEnvPrefix({ envPrefix: 'SD_WC' })).toBe(true)
    expect(maEnvPrefix({ envPrefix: '' })).toBe(false)
    expect(maEnvPrefix({ envPrefix: '  ' })).toBe(false)
    expect(maEnvPrefix({})).toBe(false)
  })
  it('nowe konto startuje w podglądzie, tekst kreatora z tej samej funkcji', () => {
    expect(domyslnyTryb()).toBe('CIEN')
    expect(OPIS_TRYBU_NOWEGO_KONTA[domyslnyTryb()]).toMatch(/Tylko podgląd/)
  })
})
