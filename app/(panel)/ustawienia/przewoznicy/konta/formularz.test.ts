// Konta przewoźników — po „Zapisz zmiany” pola były puste (nowe konto) albo stare, a zapisane wartości było
// widać dopiero po F5. Przyczyna: `<form action={fn}>` w React 19 sam resetuje formularz po akcji do
// wartości domyślnych z chwili przed odświeżeniem danych, a pola są niekontrolowane (`defaultValue`). Środowisko testów
// bez DOM: tu odcisk karty (klucz, po którym karta montuje się od nowa z zapisanymi wartościami), render karty z danymi
// po zapisie i strażnik źródła formularza; zachowanie w przeglądarce sprawdzała próba w jsdom poza repo (czerwona na
// kodzie sprzed poprawki, zielona po).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { KontoPrzewoznika } from '@/lib/wysylka/konta'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))
vi.mock('./akcje', () => ({ zapiszKonta: async () => ({}), dodajKonto: async () => ({}) }))

const { FormularzKont, odciskKonta, POLE_KLUCZA_RE } = await import('./formularz')

function konto(wartosci: Record<string, string> = {}, o: Partial<KontoPrzewoznika> = {}): KontoPrzewoznika {
  return {
    id: 'dpd~SALONY',
    nazwa: 'DPD (konto Salony)',
    sufiks: 'SALONY',
    adapterKey: 'dpd.services.v1',
    sekrety: [{ name: 'DPD_LOGIN', nazwa: 'Login', opis: 'login', wymagany: true, ustawiony: false, zrodlo: null }],
    pola: [
      { key: 'payerFid', opis: 'FID płatnika przesyłek', typ: 'string', wymagane: true, wartosc: wartosci['payerFid'] ?? '' },
      { key: 'defaultWeightKg', opis: 'waga paczki w kg', typ: 'number', wymagane: false, wartosc: wartosci['defaultWeightKg'] ?? '' },
    ],
    reguly: [{ id: 'r3', priority: 30, carrier: 'DPD_EMPIK', adapterKey: 'dpd.services.zapis.v1', nadawanie: false }],
    test: null,
    glowne: 'dpd',
    moduly: ['dpd.services.v1', 'dpd.services.zapis.v1'],
    ...o,
  }
}

describe('odcisk karty konta', () => {
  it('zmienia się, gdy po zapisie przychodzą inne wartości pól, stan kluczy albo nadawania; bez zmian ten sam', () => {
    const przed = odciskKonta(konto())
    expect(odciskKonta(konto())).toBe(przed)
    expect(odciskKonta(konto({ defaultWeightKg: '5' }))).not.toBe(przed)
    expect(odciskKonta(konto({}, { sekrety: [{ name: 'DPD_LOGIN', nazwa: 'Login', opis: 'login', wymagany: true, ustawiony: true, zrodlo: 'panel' }] }))).not.toBe(przed)
    expect(odciskKonta(konto({}, { reguly: [{ id: 'r3', priority: 30, carrier: 'DPD_EMPIK', adapterKey: 'dpd.services.zapis.v1', nadawanie: true }] }))).not.toBe(przed)
  })

  it('pola kluczy (czyszczone po zapisie) to tylko `k-<konto>-s-<nazwa>`, nie pola ustawień ani nadawania', () => {
    expect(POLE_KLUCZA_RE.test('k-dpd~SALONY-s-DPD_LOGIN')).toBe(true)
    expect(POLE_KLUCZA_RE.test('k-dpd~SALONY-p-payerFid')).toBe(false)
    expect(POLE_KLUCZA_RE.test('n-r3')).toBe(false)
  })
})

describe('karta po zapisie pokazuje zapisane wartości', () => {
  it('dane po zapisie (nowe props z serwera) trafiają do pól, także w „Zaawansowane”; klucz nie wraca do pola', () => {
    const t = renderToStaticMarkup(h(FormularzKont, { konta: [konto({ payerFid: '416038', defaultWeightKg: '5' }, { sekrety: [{ name: 'DPD_LOGIN', nazwa: 'Login', opis: 'login', wymagany: true, ustawiony: true, zrodlo: 'panel' }] })], przewoznicy: { DPD_EMPIK: 'DPD Empik' }, priorytety: [30] }))
    expect(t).toMatch(/name="k-dpd~SALONY-p-payerFid"[^>]*value="416038"|value="416038"[^>]*name="k-dpd~SALONY-p-payerFid"/)
    expect(t).toMatch(/name="k-dpd~SALONY-p-defaultWeightKg"[^>]*value="5"|value="5"[^>]*name="k-dpd~SALONY-p-defaultWeightKg"/)
    expect(t).not.toMatch(/name="k-dpd~SALONY-s-DPD_LOGIN"[^>]*value=/)
    expect(t).toContain('ustawiony (wpisz, aby zmienić)')
  })
})

describe('strażnik źródła formularza kont', () => {
  it('formularz kont nie używa `<form action={…}>` (React 19 czyści wtedy pola po zapisie), karta ma klucz z odcisku', () => {
    const zrodlo = readFileSync(join(__dirname, 'formularz.tsx'), 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n')
    const kont = zrodlo.slice(zrodlo.indexOf('export function FormularzKont'), zrodlo.indexOf('export function DodajKonto'))
    expect(kont).not.toMatch(/<form[^>]*\saction=\{/)
    expect(kont).toMatch(/<form[^>]*\sonSubmit=\{zapisz\}/)
    expect(kont).toMatch(/key=\{`\$\{k\.id\}\|\$\{odciskKonta\(k\)\}`\}/)
  })
})
