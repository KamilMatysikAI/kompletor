// reguły, podgląd i tabela mapowania akcji BL — testy bez bazy.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatujDate } from '../maile'
import { DANE_PRZYKLADOWE, KONTEKST_PRZYKLADOWY } from '../maile/przyklady'
import type { KontekstMarki } from '../maile'
import { daneMaila, podgladAkcji, type ZrodloPodgladu } from './podglad'
import { KLUCZE_REGUL, REGULY, WYNIKI_FAKTURY_BL } from './reguly'
import { maileZwrotowOd, maileZwrotowWlaczone, REGULY_ZWROTOW } from './maile-zwrotow'
import { trybProduktow } from './silnik'

describe('reguły', () => {
  it('pokrywają akcje BL 10, 11, 12, 14 i P2; każda ma podgląd', () => {
    expect(KLUCZE_REGUL.flatMap((k): (number | string)[] => [...REGULY[k].bl]).map(String).sort()).toEqual(['10', '11', '12', '14', 'P2'])
    for (const k of KLUCZE_REGUL) {
      const p = podgladAkcji(k, { numerZamowienia: 'SD 1001', kwotaGr: 5000, terminAnulowania: '2026-10-30T12:00:00.000Z', sku: 'X-1', dostepne: 1, prog: 3 })
      expect(p.temat.length, k).toBeGreaterThan(0)
      expect(p.tekst.length, k).toBeGreaterThan(0)
    }
  })

  it('cień „Faktura”: faktury BL z rozliczeniem i bez, sam e-book; bez korekt i faktur spoza cienia', () => {
    expect([...WYNIKI_FAKTURY_BL].sort()).toEqual(['BEZ_STANU', 'BEZ_WZ', 'NIC_DO_ROZLICZENIA', 'ZASTOSOWANA'])
  })

  it('maile o zwrotach: tylko jawne true z datą włączenia, domyślnie wyłączone', () => {
    const od = '2026-11-11T10:00:00.000Z'
    expect(maileZwrotowWlaczone(null)).toBe(false)
    expect(maileZwrotowWlaczone({})).toBe(false)
    expect(maileZwrotowWlaczone({ akcje: {} })).toBe(false)
    expect(maileZwrotowWlaczone({ akcje: { maileZwrotow: 'true', maileZwrotowOd: od } })).toBe(false)
    expect(maileZwrotowWlaczone({ akcje: { maileZwrotow: false, maileZwrotowOd: od } })).toBe(false)
    // flaga bez daty włączenia (np. ręczny wpis) = wyłączone: inaczej włączenie wysłałoby zaległość
    expect(maileZwrotowWlaczone({ akcje: { maileZwrotow: true } })).toBe(false)
    expect(maileZwrotowWlaczone({ akcje: { maileZwrotow: true, maileZwrotowOd: 'wczoraj' } })).toBe(false)
    expect(maileZwrotowWlaczone({ akcje: { maileZwrotow: true, maileZwrotowOd: od } })).toBe(true)
    expect(maileZwrotowOd({ akcje: { maileZwrotow: true, maileZwrotowOd: od } })?.toISOString()).toBe(od)
  })

  it('maile o zwrotach: do klienta, cel zamówienie, bez akcji BL; podgląd bez kwot', () => {
    for (const k of REGULY_ZWROTOW) {
      expect(REGULY[k].cel).toBe('ZAMOWIENIE')
      expect(REGULY[k].bl).toEqual([])
      const p = podgladAkcji(k, { numerZamowienia: 'SD 1005', returnId: 'z1' })
      expect(p.odbiorca, k).toBe('klient')
      expect(p.temat, k).toContain('SD 1005')
      expect(p.tekst, k).not.toMatch(/zł|PLN/)
    }
    expect(podgladAkcji('mail.zwrot-przyjety', {}).temat).toMatch(/^Zwrot do zamówienia .+ dotarł do nas$/)
    expect(podgladAkcji('mail.reklamacja-przyjeta', {}).tekst).toContain('rozpatrzymy reklamację')
    expect(podgladAkcji('mail.zwrot-pieniedzy', {}).tekst).toContain('zwróciliśmy pieniądze')
    // zwrot po odbiorze można jeszcze odrzucić: bez obietnicy rozliczenia; pieniądze za zwrócone produkty, nie całe zamówienie
    expect(podgladAkcji('mail.zwrot-przyjety', {}).tekst).toContain('damy znać, co dalej')
    expect(podgladAkcji('mail.zwrot-przyjety', {}).tekst).not.toContain('rozliczymy')
    expect(podgladAkcji('mail.zwrot-pieniedzy', {}).tekst).toContain('za zwrócone produkty z zamówienia')
    expect(podgladAkcji('mail.zwrot-pieniedzy', {}).temat).toMatch(/^Zwrot pieniędzy za zamówienie /)
  })

  it('tryb produktów: PRACA tylko jawnie w ustawieniach firmy, inaczej SUCHO', () => {
    expect(trybProduktow({})).toBe('SUCHO')
    expect(trybProduktow(null)).toBe('SUCHO')
    expect(trybProduktow({ akcje: { trybProduktow: 'praca' } })).toBe('SUCHO')
    expect(trybProduktow({ akcje: { trybProduktow: 'PRACA' } })).toBe('PRACA')
  })
})

describe('podgląd: dane fikcyjne, kontrakt terminAnulowania', () => {
  it('„Brak płatności” mówi „do <data z planu>”, nigdy „w ciągu N dni roboczych”', () => {
    const termin = '2026-11-03T15:00:00.000Z'
    const p = podgladAkcji('mail.brak-platnosci', { numerZamowienia: 'SD 1002', kwotaGr: 1999, terminAnulowania: termin, dniDoAnulowania: 5 })
    expect(p.tekst).toContain(`do ${formatujDate(new Date(termin))}`)
    expect(p.tekst).not.toMatch(/w ciągu/)
    expect(p.temat).toContain('SD 1002')
    expect(daneMaila('brak-platnosci', { terminAnulowania: termin }).terminAnulowania?.toISOString()).toBe(termin)
  })

  it('„Brak płatności” bez daty (plan SKIPPED) — pusty podgląd z powodem, bez wariantu „w ciągu N dni”', () => {
    const p = podgladAkcji('mail.brak-platnosci', { numerZamowienia: 'SD 1004' })
    expect(p.tekst).toBe('')
    expect(p.uwaga).toMatch(/pominięta/)
    expect(p.temat).not.toMatch(/dni/)
  })

  it('bez imienia klienta; marka i adresy tylko z przykładów (example.com)', () => {
    for (const k of KLUCZE_REGUL) {
      const p = podgladAkcji(k, { numerZamowienia: 'SD 1003', terminAnulowania: '2026-11-03T15:00:00.000Z' })
      expect(p.tekst, k).not.toContain(String(DANE_PRZYKLADOWE['brak-platnosci'].imie))
      const maile = (p.tekst.match(/[\w.+-]+@[\w.-]+/g) ?? []).map((m) => m.replace(/\.$/, ''))
      expect(maile.filter((m) => !m.endsWith('example.com')), k).toEqual([])
    }
    expect(KONTEKST_PRZYKLADOWY.firma.emailBiura).toMatch(/example\.com$/)
  })
})

describe('podgląd z danymi firmy', () => {
  const FIRMA: KontekstMarki = {
    firma: { nazwa: 'Pracownia Testowa sp. z o.o.', adres: ['ul. Zielona 5', '60-001 Poznań'], nip: '111-111-11-11', email: 'kontakt@pracownia.example.org', emailBiura: 'biuro@pracownia.example.org' },
    sklep: { nazwa: 'Pracownia', kolorGlowny: '#24527a', odpowiedzDo: 'sklep@pracownia.example.org', www: null, odbiorOsobisty: null },
  }
  const zrodlo = (z: Partial<ZrodloPodgladu> = {}): ZrodloPodgladu => ({ kontekst: FIRMA, uwaga: 'u', pozycje: [{ nazwa: 'Wazon szklany 20 cm', ilosc: 2 }], ...z })

  it('„Faktura”: sam numer z programu do faktur, bez dopisku i bez identyfikatora dokumentu; sklep i stopka firmy', () => {
    const p = podgladAkcji('mail.faktura', { numerZamowienia: 'SD 12', wfirmaDocId: '84512345' }, zrodlo({ numerFaktury: 'FS 24/13/11/26' }))
    expect(p.temat).toBe('Faktura FS 24/13/11/26 do zamówienia SD 12')
    expect(p.tekst).toContain('FS 24/13/11/26')
    expect(p.tekst).not.toMatch(/dokument wFirmy|84512345|Żółwik|example\.com/)
    expect(p.tekst).toContain('Pracownia Testowa sp. z o.o.')
    expect(p.tekst).toContain('ul. Zielona 5, 60-001 Poznań')
    expect(p.tekst).toContain('sklep@pracownia.example.org')
    expect(p.braki).toEqual([])
  })

  it('„Faktura” bez numeru z programu: ten sam wariant bez numeru co wysyłka, identyfikator dokumentu poza treścią', () => {
    const p = podgladAkcji('mail.faktura', { numerZamowienia: 'SD 12', wfirmaDocId: '84512345' }, zrodlo({ numerFaktury: null }))
    expect(p.temat).toBe('Faktura do zamówienia SD 12')
    expect(p.tekst).toContain('w załączniku przesyłamy fakturę do zamówienia')
    expect(p.tekst).not.toContain('Numer faktury')
    expect(`${p.temat}\n${p.tekst}`).not.toContain('84512345')
    expect(p.braki).toEqual([])
    expect(daneMaila('faktura', { numerZamowienia: 'SD 12', wfirmaDocId: '84512345' }, zrodlo({ numerFaktury: null })).numerFaktury).toBeNull()
  })

  it('„Faktura” spoza Kompletora: numer dokumentu z planu tak, jak stoi (bez dopisku)', () => {
    const p = podgladAkcji('mail.faktura', { numerZamowienia: 'SD 12', wfirmaDocId: 'FS 24/13/11/26' }, zrodlo())
    expect(p.temat).toBe('Faktura FS 24/13/11/26 do zamówienia SD 12')
    expect(p.tekst).not.toContain('dokument wFirmy')
  })

  it('pozycje i szablon firmy wchodzą do treści', () => {
    const p = podgladAkcji('mail.brak-platnosci', { numerZamowienia: 'SD 13', kwotaGr: 4500, terminAnulowania: '2026-11-20T12:00:00.000Z' }, zrodlo({ nadpisania: { 'brak-platnosci': { temat: 'Czekamy na wpłatę: {{numerZamowienia}}' } } }))
    expect(p.temat).toBe('Czekamy na wpłatę: SD 13')
    expect(p.tekst).toContain('2 × Wazon szklany 20 cm')
    expect(p.tekst).not.toMatch(/Kubek|platnosci\.example\.com/)
  })

  it('braki ustawień: zdanie z drogą do ekranu i znacznik w treści zamiast pustego miejsca', () => {
    const pusta: KontekstMarki = { firma: { nazwa: 'Pracownia', adres: [], email: null, emailBiura: null }, sklep: { nazwa: 'Pracownia', kolorGlowny: '#24527a', odpowiedzDo: '', odbiorOsobisty: null } }
    const p = podgladAkcji('mail.gotowe-do-odbioru', { numerZamowienia: 'SD 14' }, zrodlo({ kontekst: pusta }))
    expect(p.braki).toEqual([
      'Stopka maila nie ma adresu firmy. Uzupełnij go w Ustawienia → Dokumenty i faktury → Dane firmy.',
      'Stopka maila nie ma e-maila ani telefonu do kontaktu. Uzupełnij je w Ustawienia → Dokumenty i faktury → Dane firmy.',
      'Klient nie ma adresu, na który może odpisać. Uzupełnij adres nadawcy w Ustawienia → Komunikacja i poczta → Poczta.',
      'Sklep „Pracownia” nie ma adresu odbioru osobistego. Uzupełnij go w Ustawienia → Komunikacja i poczta → Poczta, w danych sklepu.',
      'Sklep „Pracownia” nie ma godzin odbioru osobistego. Uzupełnij je w Ustawienia → Komunikacja i poczta → Poczta, w danych sklepu.',
    ])
    expect(p.tekst).toContain('[brak: adres firmy]')
    expect(p.tekst).toContain('[brak: adres odbioru]')
    expect(p.tekst).toContain('[brak: godziny odbioru]')
    expect(p.tekst).toContain('[brak: adres e-mail]')
    expect(p.tekst).not.toContain('.invalid')
    // mail do biura bez e-maila biura: brak zgłoszony, treść jest
    const b = podgladAkcji('mail.niski-stan', { sku: 'H-1', dostepne: 1, prog: 3 }, zrodlo({ kontekst: pusta }))
    expect(b.temat).toBe('Niski stan: H-1')
    expect(b.braki.some((x) => x.startsWith('Firma nie ma e-maila biura'))).toBe(true)
  })

  it('maile o zwrotach: marka i stopka firmy, zwrócone produkty ze źródła, bez imienia; braki jak w innych mailach', () => {
    for (const k of REGULY_ZWROTOW) {
      const p = podgladAkcji(k, { numerZamowienia: 'SD 16', returnId: 'z1' }, zrodlo({ pozycje: [{ nazwa: 'Wazon szklany 20 cm', ilosc: 1 }] }))
      expect(p.braki).toEqual([])
      expect(p.tekst).toContain('SD 16')
      expect(p.tekst).toContain('1 × Wazon szklany 20 cm')
      expect(p.tekst).toContain('Pracownia Testowa sp. z o.o.')
      expect(p.tekst).toContain('sklep@pracownia.example.org')
      expect(p.tekst).not.toMatch(/Kubek|Żółwik|example\.com|Jan/)
    }
    const pusta: KontekstMarki = { firma: { nazwa: 'Pracownia', adres: [], email: null, emailBiura: null }, sklep: { nazwa: 'Pracownia', kolorGlowny: '#24527a', odpowiedzDo: '', odbiorOsobisty: null } }
    const b = podgladAkcji('mail.zwrot-pieniedzy', { numerZamowienia: 'SD 17' }, zrodlo({ kontekst: pusta, braki: ['z planu'] }))
    expect(b.braki[0]).toMatch(/^Stopka maila nie ma adresu firmy/)
    expect(b.braki.at(-1)).toBe('z planu')
    expect(b.tekst).toContain('[brak: adres firmy]')
    // bez źródła (edytor, testy bez bazy): pozycje przykładu tego maila, jak dotąd
    expect(podgladAkcji('mail.zwrot-przyjety', {}).tekst).toContain('Kubek ceramiczny 300 ml')
  })

  it('zły adres w ustawieniach: brak treści, zrozumiały powód', () => {
    const zly: KontekstMarki = { ...FIRMA, sklep: { ...FIRMA.sklep, odpowiedzDo: 'sklep@@zly' } }
    const p = podgladAkcji('mail.faktura', { numerZamowienia: 'SD 15', wfirmaDocId: 'X' }, zrodlo({ kontekst: zly, numerFaktury: 'FV 1' }))
    expect(p.tekst).toBe('')
    expect(p.braki[0]).toMatch(/^Mail nie powstanie: sklep: niepoprawny adres do odpowiedzi .+ Ustawienia → Komunikacja i poczta → Poczta\.$/)
  })
})

describe('docs/akcje-bl.md: każda akcja BL ma przypisanie', () => {
  const doc = readFileSync(path.resolve(__dirname, '../../docs/akcje-bl.md'), 'utf8')
  const rows = new Map<string, string>()
  for (const line of doc.split('\n')) {
    const m = /^\|\s*(\d{1,2}|P[12])\s*\|(.*)\|\s*$/.exec(line)
    if (m) rows.set(m[1]!, m[2]!)
  }
  const ids = [...Array.from({ length: 33 }, (_, i) => String(i + 1)), 'P1', 'P2']

  it('pozycje 1–33, P1, P2 — każda dokładnie raz, z jednym z dozwolonych przypisań', () => {
    expect([...rows.keys()].sort()).toEqual([...ids].sort())
    // akcje zamówień 1–33 to reguły presetu firmy (włączone albo wyłączone), produktowe jak dotąd
    const ok = /(jest: |ta reguła: |\*\*włączona\*\*|\*\*wyłączona\*\*)/
    expect(ids.filter((id) => !ok.test(rows.get(id) ?? ''))).toEqual([])
  })

  it('akcje 10, 11, 12, 14 i P2 wskazują klucz reguły planu maili', () => {
    // maile zamówień 10–14 planuje plan wbudowany (wyłącznik firmy), P2 jak dotąd
    for (const k of KLUCZE_REGUL) for (const bl of REGULY[k].bl) expect(rows.get(String(bl)), `${bl}`).toMatch(new RegExp(`(ta reguła|plan wbudowany): \`${k.replace('.', '\\.')}\``))
  })
})
