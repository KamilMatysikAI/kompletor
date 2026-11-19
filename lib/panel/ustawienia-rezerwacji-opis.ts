// Ustawienia → Zasady rezerwacji: opis słowami, odczyt formularza i czytelna historia zmian.
// Czyste funkcje bez bazy (używa ich też formularz w przeglądarce) — testy w ustawienia-rezerwacji-opis.test.ts.
import type { Policy } from '@/lib/rdzen/polityka'
import { FAILED_ONLINE_REMINDER_HOUR, MAX_FAILED_ONLINE_HOLD_HOURS, MAX_FAILED_ONLINE_REMINDER_DAYS, MIN_FAILED_ONLINE_REMINDER_DAYS } from '@/lib/rdzen/polityka-limity'

export type PolicyDaysKey = Exclude<keyof Policy, 'seasonMode'>

/** Kolejność pól w formularzu i w historii zmian. */
export const DAY_KEYS: readonly PolicyDaysKey[] = [
  'normalReminderBusinessDays',
  'normalReleaseBusinessDays',
  'seasonReminderBusinessDays',
  'seasonReleaseBusinessDays',
  'allOutOfStockWaitBusinessDays',
]

/** Pole w godzinach zegarowych (nie dniach roboczych): krótka rezerwacja po nieudanej płatności online. */
export const HOURS_KEY = 'failedOnlinePaymentHoldHours' as const satisfies PolicyDaysKey

/** Pole w dniach kalendarzowych: pytanie o płatność z danymi do przelewu po nieudanej płatności online. */
export const REMINDER_DAYS_KEY = 'failedOnlinePaymentReminderDays' as const satisfies PolicyDaysKey

/** Wszystkie pola liczbowe formularza i historii: dni robocze, potem pola nieudanej płatności online. */
export const NUMBER_KEYS: readonly PolicyDaysKey[] = [...DAY_KEYS, HOURS_KEY, REMINDER_DAYS_KEY]

/** Zakres pola (dni robocze 0–30, godziny 0–72, dni kalendarzowe 1–7; walidacja i tak w `savePolicy`). */
export const maxOf = (k: PolicyDaysKey) => (k === HOURS_KEY ? MAX_FAILED_ONLINE_HOLD_HOURS : k === REMINDER_DAYS_KEY ? MAX_FAILED_ONLINE_REMINDER_DAYS : 30)
export const minOf = (k: PolicyDaysKey) => (k === REMINDER_DAYS_KEY ? MIN_FAILED_ONLINE_REMINDER_DAYS : 0)

export const FIELD_LABEL: Record<keyof Policy, string> = {
  seasonMode: 'Tryb sezonowy',
  normalReminderBusinessDays: 'Tryb normalny, przypomnienie',
  normalReleaseBusinessDays: 'Tryb normalny, zwolnienie rezerwacji',
  seasonReminderBusinessDays: 'Tryb sezonowy, przypomnienie',
  seasonReleaseBusinessDays: 'Tryb sezonowy, zwolnienie rezerwacji',
  allOutOfStockWaitBusinessDays: '„Brakuje wszystkiego”, oczekiwanie',
  failedOnlinePaymentHoldHours: 'Nieudana płatność online, trzymanie towaru',
  failedOnlinePaymentReminderDays: 'Nieudana płatność online, pytanie o płatność',
}

/** Wartości formularza tak, jak je wpisano (tekst), żeby po błędzie niczego nie gubić. */
export type PolicyFormValues = { seasonMode: boolean } & Record<PolicyDaysKey, string>

/** Same pola polityki (wiersz z bazy ma też organizationId i updatedAt — nie idą do przeglądarki). */
export function policyOf(p: Policy): Policy {
  const out = { seasonMode: p.seasonMode } as Policy
  for (const k of NUMBER_KEYS) out[k] = p[k]
  return out
}

export function formValuesOf(p: Policy): PolicyFormValues {
  const out = { seasonMode: p.seasonMode } as PolicyFormValues
  for (const k of NUMBER_KEYS) out[k] = String(p[k])
  return out
}

/**
 * Formularz → zmiana polityki. Niczego tu nie odrzucamy: liczby (także spoza 0–30, ułamki, NaN dla pustego pola
 * i tekstu) idą do `updatePolicy`, które jest jedynym miejscem walidacji (lib/rdzen/polityka.ts).
 */
export function parsePolicyForm(form: { get(name: string): unknown }): { values: PolicyFormValues; patch: Policy } {
  const values = { seasonMode: form.get('seasonMode') === 'tak' } as PolicyFormValues
  const patch = { seasonMode: values.seasonMode } as Policy
  for (const k of NUMBER_KEYS) {
    const raw = String(form.get(k) ?? '').trim().slice(0, 20)
    values[k] = raw
    patch[k] = raw === '' ? Number.NaN : Number(raw.replace(',', '.'))
  }
  return { values, patch }
}

const SAVE_FAILED = 'Nie udało się zapisać. Spróbuj ponownie.'

/** Błąd walidacji z `updatePolicy` po polsku dla człowieka (z nazwą pola z ekranu zamiast nazwy kolumny). */
export function readableError(e: unknown): { message: string; field: PolicyDaysKey | 'order' | null } {
  // tylko zwykły Error to komunikat walidacji; błąd bazy pokazujemy bez szczegółów (jak w Ustawienia → Przewoźnicy)
  if (!(e instanceof Error) || e.constructor !== Error) return { message: SAVE_FAILED, field: null }
  const m = /^Nieprawidłowa wartość (\w+):/.exec(e.message)
  if (m && (NUMBER_KEYS as readonly string[]).includes(m[1]!)) {
    const k = m[1] as PolicyDaysKey
    const jednostka = k === HOURS_KEY ? 'godzin' : k === REMINDER_DAYS_KEY ? 'dni' : 'dni roboczych'
    return { message: `${FIELD_LABEL[k]}: wpisz liczbę całkowitą ${jednostka} od ${minOf(k)} do ${maxOf(k)}.`, field: k }
  }
  if (/^Przypomnienie nie może być później/.test(e.message))
    return { message: 'Przypomnienie nie może być później niż zwolnienie rezerwacji. Popraw dni w trybie normalnym albo sezonowym.', field: 'order' }
  if (/^Ktoś zapisał zasady w międzyczasie/.test(e.message)) return { message: e.message, field: null }
  return { message: SAVE_FAILED, field: null } // nieznany błąd: bez treści technicznej
}

/** „1 dzień roboczy”, „3 dni robocze”, „5 dni roboczych” (biernik). */
export function businessDays(n: number): string {
  if (n === 1) return '1 dzień roboczy'
  const d = n % 10
  const dd = n % 100
  return d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? `${n} dni robocze` : `${n} dni roboczych`
}

/** „po 1 dniu roboczym”, „po 2 dniach roboczych”; 0 = od razu (ten sam dzień). */
export function afterBusinessDays(n: number): string {
  if (n === 0) return 'od razu'
  return n === 1 ? 'po 1 dniu roboczym' : `po ${n} dniach roboczych`
}

const valid = (n: number) => Number.isInteger(n) && n >= 0 && n <= 30

/** Przykład słowami dla jednego trybu; dla niepoprawnych liczb — null (formularz pokaże to dopiero po zapisie). */
export function unpaidExample(reminder: number, release: number): string | null {
  if (!valid(reminder) || !valid(release)) return null
  return `nieopłacone: przypomnienie ${afterBusinessDays(reminder)}, zwolnienie rezerwacji ${afterBusinessDays(release)} od złożenia zamówienia`
}

/** „1 godzinę”, „2 godziny”, „5 godzin” (biernik). */
export function hours(n: number): string {
  if (n === 1) return '1 godzinę'
  const d = n % 10
  const dd = n % 100
  return d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? `${n} godziny` : `${n} godzin`
}

/** Przykład słowami dla nieudanej płatności online; niepoprawna liczba = null. */
export function failedOnlineExample(h: number): string | null {
  if (!Number.isInteger(h) || h < 0 || h > MAX_FAILED_ONLINE_HOLD_HOURS) return null
  return h === 0
    ? 'nieudana płatność online: towar od razu wraca do sprzedaży, a zamówienie czeka na płatność do zwykłego terminu'
    : `nieudana płatność online: towar czeka ${hours(h)} od złożenia zamówienia, potem wraca do sprzedaży, a zamówienie czeka na płatność do zwykłego terminu`
}

/** „1 dzień”, „3 dni” (biernik, dni kalendarzowe). */
export function days(n: number): string {
  return n === 1 ? '1 dzień' : `${n} dni`
}

/** Przykład słowami dla pytania o płatność po nieudanej płatności online; niepoprawna liczba = null. */
export function failedOnlineReminderExample(d: number): string | null {
  if (!Number.isInteger(d) || d < MIN_FAILED_ONLINE_REMINDER_DAYS || d > MAX_FAILED_ONLINE_REMINDER_DAYS) return null
  const kiedy = d === 1 ? 'następnego dnia' : `${days(d)} po dniu złożenia zamówienia`
  return `zamówienie złożone w poniedziałek z nieudaną płatnością online: ${kiedy} o ${FAILED_ONLINE_REMINDER_HOUR}:00 klient dostaje pytanie, czy miał problem z płatnością, z danymi do przelewu`
}

export function outOfStockExample(wait: number): string | null {
  if (!valid(wait)) return null
  return wait === 0
    ? '„brakuje wszystkiego”: od razu „Do wyjaśnienia”'
    : `„brakuje wszystkiego”: czekamy ${businessDays(wait)} na dostawę, potem „Do wyjaśnienia”`
}

export const modeLabel = (season: boolean) => (season ? 'sezonowy' : 'normalny')

function valueLabel(k: keyof Policy, v: unknown): string {
  if (k === 'seasonMode') return v === true ? 'włączony' : v === false ? 'wyłączony' : 'brak'
  if (typeof v !== 'number') return 'brak'
  if (k === REMINDER_DAYS_KEY) return v === 1 ? 'po 1 dniu' : `po ${v} dniach`
  return k === HOURS_KEY ? (v === 0 ? 'bez trzymania' : hours(v)) : businessDays(v)
}

export interface PolicyChange {
  label: string
  from: string
  to: string
}

/** Różnice między `before` a `after` wpisu AuditLog — tylko znane pola, w kolejności formularza. */
export function policyChanges(before: unknown, after: unknown): PolicyChange[] {
  const b = (before && typeof before === 'object' ? before : {}) as Record<string, unknown>
  const a = (after && typeof after === 'object' ? after : {}) as Record<string, unknown>
  const out: PolicyChange[] = []
  for (const k of ['seasonMode', ...NUMBER_KEYS] as (keyof Policy)[]) {
    if (!(k in a) || b[k] === a[k]) continue
    out.push({ label: FIELD_LABEL[k], from: valueLabel(k, b[k]), to: valueLabel(k, a[k]) })
  }
  return out
}

/** Stan formularza między ekranem a akcją serwera (useActionState). */
export interface PolicyFormState {
  values: PolicyFormValues
  current: Policy // zapisane w bazie (po udanym zapisie — nowe)
  version: string // wersja, na której pracuje formularz (`getPolicyVersioned`)
  error: string | null
  field: PolicyDaysKey | 'order' | null
  savedAt: number | null
}
