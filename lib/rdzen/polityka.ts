// Konfiguracja okresów rezerwacji (spec 2.5, 3.3). Jeden wiersz na firmę, zmiany w AuditLog.
// Przełącznik sezonu dotyczy zamówień przyjętych do systemu po przełączeniu (także przywróconych po anulowaniu);
// terminy zamówień już przyjętych się nie zmieniają.
import type { ReservationPolicy } from '@prisma/client'
import { organizationIdOf } from '../db'
import { addBusinessDays, addDays, fromWarsaw, toWarsaw } from './kalendarz'
import type { Db, Tx } from './stan'
import { FAILED_ONLINE_REMINDER_HOUR, MAX_FAILED_ONLINE_HOLD_HOURS, MAX_FAILED_ONLINE_REMINDER_DAYS, MIN_FAILED_ONLINE_REMINDER_DAYS } from './polityka-limity'

export type Policy = Pick<
  ReservationPolicy,
  | 'seasonMode'
  | 'normalReminderBusinessDays'
  | 'normalReleaseBusinessDays'
  | 'seasonReminderBusinessDays'
  | 'seasonReleaseBusinessDays'
  | 'allOutOfStockWaitBusinessDays'
  | 'failedOnlinePaymentHoldHours'
  | 'failedOnlinePaymentReminderDays'
>

export const DEFAULT_POLICY: Policy = {
  seasonMode: false,
  normalReminderBusinessDays: 2,
  normalReleaseBusinessDays: 5,
  seasonReminderBusinessDays: 1,
  seasonReleaseBusinessDays: 3,
  allOutOfStockWaitBusinessDays: 3,
  failedOnlinePaymentHoldHours: 2,
  failedOnlinePaymentReminderDays: 1,
}

/** Górna granica krótkiej rezerwacji przy nieudanej płatności online (godziny zegarowe, `polityka-limity.ts`). */
export { MAX_FAILED_ONLINE_HOLD_HOURS, MAX_FAILED_ONLINE_REMINDER_DAYS, MIN_FAILED_ONLINE_REMINDER_DAYS }

/** Polityka firmy klienta (RLS: jedyny widoczny wiersz); brak wiersza = wartości domyślne. */
export async function getPolicy(db: Db | Tx): Promise<Policy> {
  const row = await db.reservationPolicy.findFirst()
  return row ?? DEFAULT_POLICY
}

/** Polityka razem z wersją do wykrycia równoległego zapisu: `updatedAt` wiersza, pusty napis = wiersza jeszcze nie ma. */
export interface VersionedPolicy {
  policy: Policy
  version: string
}

const versionOf = (row: Pick<ReservationPolicy, 'updatedAt'> | null) => row?.updatedAt.toISOString() ?? ''

/** Komunikat dla człowieka, panel pokazuje go bez zmian (lib/panel/ustawienia-rezerwacji-opis.ts). */
const CONFLICT = 'Ktoś zapisał zasady w międzyczasie. Odśwież ekran i wpisz zmiany jeszcze raz.'

export async function getPolicyVersioned(db: Db | Tx): Promise<VersionedPolicy> {
  const row = await db.reservationPolicy.findFirst()
  return { policy: row ? pick(row) : DEFAULT_POLICY, version: versionOf(row) }
}

export async function updatePolicy(db: Db, patch: Partial<Policy>, actorId: string): Promise<Policy> {
  return (await savePolicy(db, patch, actorId)).policy
}

/**
 * Zapis z wpisem w AuditLog. Podany `expectedVersion` odmawia zapisu, gdy ktoś zmienił zasady od odczytu
 * (formularz wysyła komplet pól, więc inaczej ostatni zapis po cichu cofnąłby cudzą zmianę).
 * Zapis niczego niezmieniający nie tworzy wpisu w historii.
 */
export async function savePolicy(db: Db, patch: Partial<Policy>, actorId: string, expectedVersion?: string): Promise<VersionedPolicy> {
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'seasonMode') continue
    const godziny = k === 'failedOnlinePaymentHoldHours'
    const kalendarzowe = k === 'failedOnlinePaymentReminderDays'
    const min = kalendarzowe ? MIN_FAILED_ONLINE_REMINDER_DAYS : 0
    const max = godziny ? MAX_FAILED_ONLINE_HOLD_HOURS : kalendarzowe ? MAX_FAILED_ONLINE_REMINDER_DAYS : 30
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
      throw new Error(`Nieprawidłowa wartość ${k}: ${String(v)} (${min}–${max} ${godziny ? 'godzin' : kalendarzowe ? 'dni' : 'dni roboczych'})`)
  }
  const organizationId = organizationIdOf(db)
  return db.$transaction(async (tx) => {
    const row = await tx.reservationPolicy.findFirst()
    if (expectedVersion !== undefined && expectedVersion !== versionOf(row)) throw new Error(CONFLICT)
    const before = pick(row ?? DEFAULT_POLICY)
    const after = { ...before, ...patch }
    if (after.normalReminderBusinessDays > after.normalReleaseBusinessDays || after.seasonReminderBusinessDays > after.seasonReleaseBusinessDays)
      throw new Error('Przypomnienie nie może być później niż zwolnienie rezerwacji')
    if ((Object.keys(before) as (keyof Policy)[]).every((k) => before[k] === after[k])) return { policy: before, version: versionOf(row) }
    if (row && expectedVersion !== undefined) {
      // warunek w samym UPDATE: z dwóch równoległych zapisów tej samej wersji przechodzi jeden
      const { count } = await tx.reservationPolicy.updateMany({ where: { organizationId, updatedAt: row.updatedAt }, data: after })
      if (count !== 1) throw new Error(CONFLICT)
    } else {
      await tx.reservationPolicy.upsert({ where: { organizationId }, create: { organizationId, ...after }, update: after })
    }
    await tx.auditLog.create({ data: { entity: 'ReservationPolicy', entityId: organizationId, actorId, before, after } })
    return { policy: after, version: versionOf(await tx.reservationPolicy.findFirstOrThrow()) }
  })
}

function pick(p: Policy): Policy {
  return {
    seasonMode: p.seasonMode,
    normalReminderBusinessDays: p.normalReminderBusinessDays,
    normalReleaseBusinessDays: p.normalReleaseBusinessDays,
    seasonReminderBusinessDays: p.seasonReminderBusinessDays,
    seasonReleaseBusinessDays: p.seasonReleaseBusinessDays,
    allOutOfStockWaitBusinessDays: p.allOutOfStockWaitBusinessDays,
    failedOnlinePaymentHoldHours: p.failedOnlinePaymentHoldHours,
    failedOnlinePaymentReminderDays: p.failedOnlinePaymentReminderDays,
  }
}

export interface Terms {
  seasonMode: boolean
  remindAt: Date
  reservationDeadline: Date
}

/** Terminy nieopłaconego zamówienia wg trybu obowiązującego w chwili przyjęcia (spec 3.3). */
export function termsFor(createdAtChannel: Date, p: Policy): Terms {
  const remind = p.seasonMode ? p.seasonReminderBusinessDays : p.normalReminderBusinessDays
  const release = p.seasonMode ? p.seasonReleaseBusinessDays : p.normalReleaseBusinessDays
  return {
    seasonMode: p.seasonMode,
    remindAt: addBusinessDays(createdAtChannel, remind),
    reservationDeadline: addBusinessDays(createdAtChannel, release),
  }
}

/**
 * Nieudana płatność online: kiedy zwolnić towar (godziny zegarowe z polityki firmy od `from`, dla zamówienia z kanału
 * od złożenia). Zamówienie po tym czasie zostaje otwarte i nieopłacone, bez rezerwacji, do zwykłego terminu anulowania
 * z `termsFor`. 0 godzin = od razu. Tryb dużego ruchu go nie zmienia.
 */
export function stockReleaseAtFor(from: Date, p: Policy): Date {
  return new Date(from.getTime() + p.failedOnlinePaymentHoldHours * 3_600_000)
}

/**
 * Nieudana płatność online: kiedy przypomnieć o płatności (mail z pytaniem o problem i danymi do przelewu). Rano
 * (`FAILED_ONLINE_REMINDER_HOUR`, czas polski) dnia kalendarzowego `from` + N dni z zasad firmy (domyślnie 1 = następny
 * dzień), bez względu na dni robocze i tryb dużego ruchu. Mail nigdy nie wychodzi „od razu, o dowolnej porze”: gdy ta
 * chwila już minęła (`now`, np. znacznik przyszedł po 2 dniach albo przeliczenie starego zamówienia), bierze najbliższą
 * godzinę rana po `now`. Gdy pytanie nie wypada przed terminem anulowania (`reservationDeadline`), zostaje zwykłe
 * przypomnienie `regularRemindAt`, o ile jest jeszcze przed nami; zwykłe już minione = bez przypomnienia (wynik =
 * termin anulowania, anulowanie ma pierwszeństwo), bo mail o tej porze przyszedłby w ciągu kilku minut o dowolnej
 * godzinie, a do anulowania zostało mniej niż do najbliższego rana.
 */
export function failedOnlineRemindAt(from: Date, p: Policy, regularRemindAt: Date, reservationDeadline: Date, now: Date): Date {
  let at = fromWarsaw(addDays(toWarsaw(from).day, p.failedOnlinePaymentReminderDays), FAILED_ONLINE_REMINDER_HOUR * 3_600_000)
  if (at <= now) at = nextMorningAfter(now)
  if (at < reservationDeadline) return at
  return regularRemindAt > now ? regularRemindAt : reservationDeadline
}

/** Najbliższa godzina rana (`FAILED_ONLINE_REMINDER_HOUR`, czas polski) po `now`: dziś, jeśli jeszcze przed, inaczej jutro. */
function nextMorningAfter(now: Date): Date {
  const { day } = toWarsaw(now)
  const today = fromWarsaw(day, FAILED_ONLINE_REMINDER_HOUR * 3_600_000)
  return today > now ? today : fromWarsaw(addDays(day, 1), FAILED_ONLINE_REMINDER_HOUR * 3_600_000)
}
