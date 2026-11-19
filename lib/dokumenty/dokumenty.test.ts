// program do faktur (zgodność wstecz), dostawcy dokumentów za interfejsem, profil firmy, warunki przejść
// przy źródle stanu Kompletor i test architektury (rdzeń bez importu z lib/wfirma). Bez bazy, dane fikcyjne.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AdapterManifest, ChannelAdapter, InvoiceIssueResult } from '../adaptery/kontrakt'
import { manifestProblems } from '../adaptery/rejestr'
import { daneFirmyDoMaila, parseProfilFirmy, poprawnyRachunek, ProfilFirmyError, walidujProfil } from '../firma/profil'
import { ACME_PRESET } from '../../tests/preset-testowy'
import { parseKonfiguracjaKsef } from '../ksef/konfiguracja'
import { type FaktyPrzejscia, powodOdmowy } from '../rdzen/przejscia'
import type { FakturyWfirma } from '../rdzen/rozchod'
import { zrodloZMagazynu } from '../rdzen/zrodlo-stanu'
import { parseNadawca } from '../wysylka/zlecenie-dpd'
import { BrakDostawcyError, DOSTAWCA_BRAK, dostawcaDokumentow } from './dostawcy'
import { problemyDostawcy, umieOdszukac, umiePrzygotowac, umieWystawic } from './kontrakt'
import { dokumentPrzedWydaniem, parseUstawieniaDokumentow, programFaktur } from './ustawienia'
import { dostawcaZAdaptera } from './z-adaptera'

describe('program do faktur', () => {
  it('jawna wartość wygrywa; bez niej wfirma (dawne wywołania) albo brak, gdy firma nie ma wFirmy', () => {
    expect(programFaktur(null)).toBe('wfirma')
    expect(programFaktur({ faktury: { program: 'brak' } })).toBe('brak')
    expect(programFaktur({ faktury: { program: 'ksef.fa3.v1' } })).toBe('ksef')
    expect(programFaktur({ faktury: { program: 'fakturownia.v1' } })).toBe('fakturownia.v1')
    expect(programFaktur({ faktury: { program: 'KSEF' } }, { maWfirme: false })).toBe('brak')
    expect(programFaktur({}, { maWfirme: true })).toBe('wfirma')
    expect(programFaktur(ACME_PRESET.settings as never, { maWfirme: true })).toBe('wfirma')
  })

  it('domyślne zasady: po spakowaniu, faktura, bez blokady wydania', () => {
    expect(parseUstawieniaDokumentow({}, { maWfirme: false })).toEqual({ program: 'brak', przedWysylka: false, wystawiajPrzy: 'SPAKOWANE', tylkoNaZadanie: false, rodzaj: 'faktura', fakturyWlaczone: false, fakturyWlaczoneOd: null })
  })

  it('dokument przed wydaniem: zawsze przy wFirmie, przy Kompletorze tylko z programem i ustawieniem', () => {
    expect(dokumentPrzedWydaniem('WFIRMA', { program: 'brak', przedWysylka: false })).toBe(true)
    expect(dokumentPrzedWydaniem('KOMPLETOR', { program: 'brak', przedWysylka: true })).toBe(false)
    expect(dokumentPrzedWydaniem('KOMPLETOR', { program: 'ksef', przedWysylka: false })).toBe(false)
    expect(dokumentPrzedWydaniem('KOMPLETOR', { program: 'ksef', przedWysylka: true })).toBe(true)
  })
})

describe('źródło stanu', () => {
  it('jawne pole wygrywa, bez niego magazyn wFirmy = WFIRMA', () => {
    expect(zrodloZMagazynu(null)).toBe('KOMPLETOR')
    expect(zrodloZMagazynu({ wfirmaWarehouseId: '1' })).toBe('WFIRMA')
    expect(zrodloZMagazynu({ wfirmaWarehouseId: '1', stockSource: 'KOMPLETOR' })).toBe('KOMPLETOR')
  })
})

describe('dostawcy dokumentów', () => {
  it('brak, wfirma bez zapisu, ksef: poprawne deklaracje', () => {
    expect(dostawcaDokumentow('brak')).toBe(DOSTAWCA_BRAK)
    for (const p of ['brak', 'wfirma', 'ksef'] as const) expect(problemyDostawcy(dostawcaDokumentow(p))).toEqual([])
    const wf = dostawcaDokumentow('wfirma')
    expect(wf.zdolnosci).toEqual(['stan.magazynu'])
    expect(umieWystawic(wf)).toBe(false)
    expect(umiePrzygotowac(dostawcaDokumentow('ksef'))).toBe(true)
    expect(() => dostawcaDokumentow('fakturownia.v1')).toThrow(BrakDostawcyError)
  })

  it('wFirma za interfejsem: wystawienie i odszukanie przez FakturyWfirma, wynik bez zmian', async () => {
    const calls: string[] = []
    const faktury: FakturyWfirma = {
      issue: async (r) => (calls.push(`issue ${r.idExternal} ${r.paymentMethod}`), { kind: 'OK', docId: 'D1', wz: {} }),
      findByPrefix: async (p) => (calls.push(`find ${p}`), [{ docId: 'D1', idExternal: `${p}1`, wz: {} }]),
    }
    const d = dostawcaDokumentow('wfirma', { wfirma: { faktury } })
    expect(problemyDostawcy(d)).toEqual([])
    expect(umieWystawic(d) && (await d.wystaw({ referencja: 'o1/1/1', pozycje: [], platnosc: 'transfer' }))).toEqual({ kind: 'OK', docId: 'D1' })
    expect(umieOdszukac(d) && (await d.odszukaj('o1/1/'))).toEqual([{ docId: 'D1', referencja: 'o1/1/1' }])
    expect(calls).toEqual(['issue o1/1/1 transfer', 'find o1/1/'])
  })

  it('nowy program jednym adapterem: zdolności z manifestu i metod, readOnly bez wystawiania', async () => {
    const manifest: AdapterManifest = {
      adapterKey: 'fakturownia.v1',
      version: '0.0.1',
      displayName: 'Fakturownia (atrapa)',
      kind: 'invoicing',
      capabilities: ['invoice.issue', 'invoice.find', 'invoice.pdf'],
      rateLimit: { requestsPerMinute: 60, maxConcurrent: 1, minPollIntervalMs: 0 },
      config: [],
      secrets: [],
      readOnly: false,
    }
    expect(manifestProblems(manifest)).toEqual([])
    expect(manifestProblems({ ...manifest, readOnly: true })).toContain('adapter tylko do odczytu deklaruje invoice.issue')
    expect(manifestProblems({ ...manifest, kind: 'carrier' })).toContain('zdolności faktur tylko dla rodzaju invoicing')
    const wynik: InvoiceIssueResult = { kind: 'OK', docId: 'F-9', number: 'FV/1/11/2026' }
    const adapter = {
      manifest,
      testConnection: async () => ({ ok: true, message: 'ok' }),
      issueInvoice: async () => wynik,
      findInvoices: async (p: string) => [{ docId: 'F-9', reference: `${p}1`, number: 'FV/1/11/2026' }],
      getInvoicePdf: async () => ({ contentType: 'application/pdf', base64: 'JVBERg==' }),
    } as unknown as ChannelAdapter
    const d = dostawcaDokumentow('fakturownia.v1', { adapter })
    expect(d.zdolnosci).toEqual(['wystaw', 'odszukaj', 'pdf'])
    expect(problemyDostawcy(d)).toEqual([])
    expect(umieWystawic(d) && (await d.wystaw({ referencja: 'r/1/1', pozycje: [], platnosc: 'transfer' }))).toEqual({ kind: 'OK', docId: 'F-9', numer: 'FV/1/11/2026' })
    expect(dostawcaZAdaptera({ ...adapter, manifest: { ...manifest, readOnly: true } } as ChannelAdapter).zdolnosci).toEqual(['odszukaj', 'pdf'])
    expect(problemyDostawcy({ program: 'x.v1', nazwa: 'x', zdolnosci: ['wystaw'] })).toEqual(['zdolność wystaw bez metody wystaw', 'wystawianie bez odszukania po referencji: po timeoucie host nie rozstrzygnie, czy dokument powstał'])
  })
})

describe('profil firmy', () => {
  const profil = { firma: { nazwa: 'Pracownia Testowa', nip: '5260250274', adres: { ulica: 'ul. Testowa 1', kodPocztowy: '60-001', miasto: 'Poznań' }, telefon: '600000000', email: 'k@example.com', emailBiura: 'b@example.com' } }

  it('KSeF i nadawca czytają profil; stare klucze wygrywają', () => {
    expect(parseKonfiguracjaKsef(profil as never).sprzedawca).toEqual({ nip: '5260250274', nazwa: 'Pracownia Testowa', adres: { kodKraju: 'PL', linia1: 'ul. Testowa 1', linia2: '60-001 Poznań' } })
    const nad = parseNadawca(profil as never)
    expect(nad).toEqual({ nadawca: { name: 'Pracownia Testowa', fullName: 'Pracownia Testowa', address: 'ul. Testowa 1', city: 'Poznań', postalCode: '60-001', countryCode: 'PL', phone: '600000000', email: 'k@example.com' }, braki: [] })
    const nadpis = { ...profil, nadawca: { name: 'Magazyn', address: 'ul. Inna 2', city: 'Luboń', postalCode: '62-030', phone: '611111111' }, ksef: { sprzedawca: { nazwa: 'Nazwa z KSeF' } } }
    expect(parseNadawca(nadpis as never).nadawca).toMatchObject({ name: 'Magazyn', city: 'Luboń', email: 'k@example.com' })
    expect(parseKonfiguracjaKsef(nadpis as never).sprzedawca?.nazwa).toBe('Nazwa z KSeF')
    expect(daneFirmyDoMaila(parseProfilFirmy(profil as never), 'Firma A')).toMatchObject({ nazwa: 'Pracownia Testowa', adres: ['ul. Testowa 1', '60-001 Poznań'], emailBiura: 'b@example.com' })
  })

  it('walidacja pól i rachunek z sumą kontrolną', () => {
    expect(walidujProfil({ nazwa: '  Firma  ', nip: '526-025-02-74', kodPocztowy: '60-001', miasto: 'Poznań', ulica: 'Testowa 1' })).toEqual({ nazwa: 'Firma', nip: '5260250274', adres: { ulica: 'Testowa 1', kodPocztowy: '60-001', miasto: 'Poznań', kodKraju: 'PL' } })
    expect(poprawnyRachunek('61 1090 1014 0000 0712 1981 2874')).toBe(true)
    expect(poprawnyRachunek('61 1090 1014 0000 0712 1981 2875')).toBe(false)
    const zleDane: Record<string, string>[] = [{ nip: '1234567890' }, { kodPocztowy: '60001', miasto: 'X', ulica: 'Y' }, { emailBiura: 'biuro@' }, { rachunek: '123' }, { kodKraju: 'POL' }]
    for (const zle of zleDane) expect(() => walidujProfil(zle)).toThrow(ProfilFirmyError)
  })
})

describe('warunki przejść (źródło stanu Kompletor)', () => {
  const o = { status: 'SPAKOWANE' as const, carrier: 'PACZKOMATY' as const, pendingAction: null }
  const f = (x: Partial<FaktyPrzejscia>): FaktyPrzejscia => ({ aktywne: 0, wFakturze: 0, wydane: 0, uslugi: 0, otwarteBraki: 0, fakturaWystawiona: false, ...x })

  it('dawne fakty (bez nowych pól) dają dawne odpowiedzi', () => {
    expect(powodOdmowy(o, 'DO_WYSLANIA', f({ aktywne: 1 }))).toMatch(/^Najpierw faktura/)
    expect(powodOdmowy(o, 'ODEBRANE', f({ uslugi: 1 }))).toMatch(/^Najpierw faktura/)
  })

  it('magazyn Kompletora: wydanie z ACTIVE, e-book bez faktury, blokada tylko z „przed wysyłką”', () => {
    expect(powodOdmowy(o, 'DO_WYSLANIA', f({ aktywne: 1, wydanieWlasne: true, dokumentWymagany: false }))).toBeNull()
    expect(powodOdmowy(o, 'DO_WYSLANIA', f({ wFakturze: 1, wydanieWlasne: true, dokumentWymagany: false }))).toMatch(/^Najpierw faktura/)
    expect(powodOdmowy(o, 'DO_WYSLANIA', f({ aktywne: 1, wydanieWlasne: true, dokumentWymagany: true }))).toMatch(/^Najpierw dokument sprzedaży/)
    expect(powodOdmowy(o, 'DO_WYSLANIA', f({ aktywne: 1, wydanieWlasne: true, dokumentWymagany: true, fakturaWystawiona: true }))).toBeNull()
    expect(powodOdmowy(o, 'ODEBRANE', f({ uslugi: 1, wydanieWlasne: true, dokumentWymagany: false }))).toBeNull()
  })
})

describe('architektura', () => {
  it('lib/rdzen i lib/dokumenty nie importują z lib/wfirma (wFirma tylko jako implementacja dostawcy)', () => {
    const zle: string[] = []
    for (const dir of ['rdzen', 'dokumenty']) {
      const base = join(__dirname, '..', dir)
      for (const f of readdirSync(base)) {
        if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue
        const src = readFileSync(join(base, f), 'utf8')
        if (/from '(\.\.\/wfirma|@\/lib\/wfirma)/.test(src) && !(dir === 'dokumenty' && f === 'dostawcy.ts') && !(dir === 'dokumenty' && f === 'zapis.ts')) zle.push(`${dir}/${f}`)
      }
    }
    expect(zle).toEqual([])
  })
})
