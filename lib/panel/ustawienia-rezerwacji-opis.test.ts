// opis zasad rezerwacji słowami, odczyt formularza, komunikaty błędów i historia zmian (bez bazy).
import { describe, expect, it } from 'vitest'
import { DEFAULT_POLICY } from '@/lib/rdzen/polityka'
import {
  afterBusinessDays,
  businessDays,
  failedOnlineExample,
  failedOnlineReminderExample,
  hours,
  formValuesOf,
  outOfStockExample,
  parsePolicyForm,
  policyChanges,
  readableError,
  unpaidExample,
} from './ustawienia-rezerwacji-opis'

const fd = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null })

describe('zasady rezerwacji: opis słowami', () => {
  it('odmiana dni roboczych', () => {
    expect([0, 1, 2, 4, 5, 12, 14, 22, 25].map(businessDays)).toEqual([
      '0 dni roboczych',
      '1 dzień roboczy',
      '2 dni robocze',
      '4 dni robocze',
      '5 dni roboczych',
      '12 dni roboczych',
      '14 dni roboczych',
      '22 dni robocze',
      '25 dni roboczych',
    ])
    expect([0, 1, 2, 5].map(afterBusinessDays)).toEqual(['od razu', 'po 1 dniu roboczym', 'po 2 dniach roboczych', 'po 5 dniach roboczych'])
  })

  it('przykład dla wartości domyślnych i dla niepoprawnych liczb', () => {
    expect(unpaidExample(2, 5)).toBe('nieopłacone: przypomnienie po 2 dniach roboczych, zwolnienie rezerwacji po 5 dniach roboczych od złożenia zamówienia')
    expect(unpaidExample(Number.NaN, 5)).toBeNull()
    expect(unpaidExample(2, 31)).toBeNull()
    expect(outOfStockExample(3)).toBe('„brakuje wszystkiego”: czekamy 3 dni robocze na dostawę, potem „Do wyjaśnienia”')
    expect(outOfStockExample(0)).toBe('„brakuje wszystkiego”: od razu „Do wyjaśnienia”')
  })
})

describe('zasady rezerwacji: formularz', () => {
  it('liczby idą do updatePolicy bez własnej walidacji; puste pole i tekst = NaN; wpisane wartości zostają', () => {
    const { values, patch } = parsePolicyForm(
      fd({ seasonMode: 'tak', normalReminderBusinessDays: ' 2 ', normalReleaseBusinessDays: '40', seasonReminderBusinessDays: '', seasonReleaseBusinessDays: 'abc', allOutOfStockWaitBusinessDays: '1,5' }),
    )
    expect(values).toEqual({ seasonMode: true, normalReminderBusinessDays: '2', normalReleaseBusinessDays: '40', seasonReminderBusinessDays: '', seasonReleaseBusinessDays: 'abc', allOutOfStockWaitBusinessDays: '1,5', failedOnlinePaymentHoldHours: '', failedOnlinePaymentReminderDays: '' })
    expect(patch.seasonMode).toBe(true)
    expect(patch.normalReminderBusinessDays).toBe(2)
    expect(patch.normalReleaseBusinessDays).toBe(40)
    expect(patch.seasonReminderBusinessDays).toBeNaN()
    expect(patch.seasonReleaseBusinessDays).toBeNaN()
    expect(patch.allOutOfStockWaitBusinessDays).toBe(1.5)
    expect(parsePolicyForm(fd({})).patch.seasonMode).toBe(false) // odznaczony przełącznik nie przychodzi w formularzu
    expect(formValuesOf(DEFAULT_POLICY).normalReleaseBusinessDays).toBe('5')
  })

  it('komunikaty updatePolicy po polsku z nazwą pola z ekranu; błąd bazy bez szczegółów', () => {
    expect(readableError(new Error('Nieprawidłowa wartość seasonReleaseBusinessDays: 31 (0–30 dni roboczych)'))).toEqual({
      message: 'Tryb sezonowy, zwolnienie rezerwacji: wpisz liczbę całkowitą dni roboczych od 0 do 30.',
      field: 'seasonReleaseBusinessDays',
    })
    expect(readableError(new Error('Przypomnienie nie może być później niż zwolnienie rezerwacji')).field).toBe('order')
    const conflict = 'Ktoś zapisał zasady w międzyczasie. Odśwież ekran i wpisz zmiany jeszcze raz.'
    expect(readableError(new Error(conflict))).toEqual({ message: conflict, field: null })
    class DbError extends Error {}
    expect(readableError(new DbError('connection refused 10.0.0.1'))).toEqual({ message: 'Nie udało się zapisać. Spróbuj ponownie.', field: null })
    expect(readableError(new Error('connect ECONNREFUSED 10.0.0.1:5432'))).toEqual({ message: 'Nie udało się zapisać. Spróbuj ponownie.', field: null })
    expect(readableError('x').field).toBeNull()
  })
})

describe('zasady rezerwacji: historia zmian', () => {
  it('tylko zmienione pola, czytelnie; nieznane klucze pomijane', () => {
    const before = { ...DEFAULT_POLICY }
    const after = { ...DEFAULT_POLICY, seasonMode: true, seasonReleaseBusinessDays: 4, cośInnego: 1 }
    expect(policyChanges(before, after)).toEqual([
      { label: 'Tryb sezonowy', from: 'wyłączony', to: 'włączony' },
      { label: 'Tryb sezonowy, zwolnienie rezerwacji', from: '3 dni robocze', to: '4 dni robocze' },
    ])
    expect(policyChanges(null, { normalReminderBusinessDays: 1 })).toEqual([{ label: 'Tryb normalny, przypomnienie', from: 'brak', to: '1 dzień roboczy' }])
    expect(policyChanges(before, before)).toEqual([])
  })
})

describe('zasady rezerwacji: nieudana płatność online (godziny)', () => {
  it('odmiana godzin i przykład słowami; 0 = towar od razu wraca do sprzedaży; spoza 0–72 bez przykładu', () => {
    expect([1, 2, 5, 12, 22, 72].map(hours)).toEqual(['1 godzinę', '2 godziny', '5 godzin', '12 godzin', '22 godziny', '72 godziny'])
    expect(failedOnlineExample(2)).toMatch(/towar czeka 2 godziny od złożenia/)
    expect(failedOnlineExample(0)).toMatch(/od razu wraca do sprzedaży/)
    expect(failedOnlineExample(2)).toMatch(/zamówienie czeka na płatność do zwykłego terminu/)
    expect(failedOnlineExample(73)).toBeNull()
    expect(failedOnlineExample(Number.NaN)).toBeNull()
  })

  it('formularz: wartość domyślna 2, odczyt pola, błąd z jednostką godzin, historia w godzinach', () => {
    expect(formValuesOf(DEFAULT_POLICY).failedOnlinePaymentHoldHours).toBe('2')
    const { patch } = parsePolicyForm(fd({ failedOnlinePaymentHoldHours: ' 6 ' }))
    expect(patch.failedOnlinePaymentHoldHours).toBe(6)
    expect(readableError(new Error('Nieprawidłowa wartość failedOnlinePaymentHoldHours: 80 (0–72 godzin)'))).toEqual({
      message: 'Nieudana płatność online, trzymanie towaru: wpisz liczbę całkowitą godzin od 0 do 72.',
      field: 'failedOnlinePaymentHoldHours',
    })
    expect(policyChanges({ ...DEFAULT_POLICY }, { ...DEFAULT_POLICY, failedOnlinePaymentHoldHours: 0 })).toEqual([
      { label: 'Nieudana płatność online, trzymanie towaru', from: '2 godziny', to: 'bez trzymania' },
    ])
  })
})

describe('nieudana płatność online: pytanie o płatność po N dniach', () => {
  it('przykład słowami, granice 1–7, komunikat błędu i historia zmian', () => {
    expect(failedOnlineReminderExample(1)).toBe('zamówienie złożone w poniedziałek z nieudaną płatnością online: następnego dnia o 9:00 klient dostaje pytanie, czy miał problem z płatnością, z danymi do przelewu')
    expect(failedOnlineReminderExample(3)).toContain('3 dni po dniu złożenia zamówienia o 9:00')
    expect(failedOnlineReminderExample(0)).toBeNull()
    expect(failedOnlineReminderExample(8)).toBeNull()
    expect(readableError(new Error('Nieprawidłowa wartość failedOnlinePaymentReminderDays: 0 (1–7 dni)'))).toEqual({
      message: 'Nieudana płatność online, pytanie o płatność: wpisz liczbę całkowitą dni od 1 do 7.',
      field: 'failedOnlinePaymentReminderDays',
    })
    expect(policyChanges({ failedOnlinePaymentReminderDays: 1 }, { failedOnlinePaymentReminderDays: 2 })).toEqual([{ label: 'Nieudana płatność online, pytanie o płatność', from: 'po 1 dniu', to: 'po 2 dniach' }])
  })
})
