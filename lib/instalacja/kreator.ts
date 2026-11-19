// Kreator pierwszego uruchomienia /start: zakłada firmę i pierwszego właściciela na świeżej instalacji
// self-host, bez CLI. Dostępny tylko przy APP_MODE=self-host, gdy w bazie nie ma żadnego konta i jest kod instalacji
// (plik `kod_instalacji` z wolumenu sekretów albo env KOMPLETOR_KOD_INSTALACJI, lib/instalacja/sekrety.ts).
//
// Ochrona przed przejęciem: kto trafi na adres pierwszy, bez kodu z logu kontenera nic nie zrobi (porównanie
// stałoczasowe, limit prób per IP jak przy logowaniu). Zapis w jednej transakcji pod blokadą doradczą: dwa równoległe
// żądania dają jedną firmę i jedno konto, drugie dostaje komunikat. Po sukcesie warunek „zero kont” zamyka kreator,
// więc kod przestaje cokolwiek otwierać (pliku nie trzeba kasować).
//
// Klient systemowy (tabele User/Session, zakładanie firmy) tylko w tym pliku — lista dozwolonych w
// tests/organizacje-izolacja.integration.test.ts.
import 'server-only'
import type { PrismaClient } from '@prisma/client'
import { appModeOf, prismaForOrg, systemPrisma } from '../db'
import { safeEqual } from '../basic-auth'
import { MIN_PASSWORD_LENGTH } from '../auth/hasla'
import { SlidingLimiter } from '../auth/limiter'
import { createUser, grantMembership, isValidEmail, login, normalizeEmail } from '../auth/sesje'
import { applyOrgPresetTx, presetNowejFirmy, slugZNazwy } from '../organizacje'
import { szablonPrzeplywu } from '../automaty/szablony'
import { DEMO_ORG, DEMO_PRESET, assertDemoDozwolone, wypelnijDemo } from './demo'
import { czytajKodInstalacji } from './sekrety'

type Env = Record<string, string | undefined>

/** Limit prób kreatora per IP (jak logowanie: 20 na minutę). */
export const kreatorLimiter = new SlidingLimiter(20, 60_000)

/** Klucz blokady doradczej instalacji (stała, wspólna dla wszystkich procesów panelu). */
const BLOKADA_INSTALACJI = 0x4b4f4d50 // „KOMP”

/** Nazwy firm zarezerwowane: slug `demo` włącza pasek „Dane fikcyjne” w panelu. */
const ZAREZERWOWANE = new Set(['demo'])

export type StanKreatora =
  | { dostepny: false }
  | {
      dostepny: true
      /** Firma już w bazie (np. z presetu KOMPLETOR_SEED), bez kont: kreator nadaje jej pierwszego właściciela. */
      istniejacaFirma: string | null
      /** Kilka firm bez kont (np. kilka presetów): kreator nie zgaduje, która jest „ta”, właściciela nadaje CLI. */
      wieleFirm: boolean
    }

export async function stanKreatoraDb(sys: PrismaClient, env: Env, kod: string | null): Promise<StanKreatora> {
  if (appModeOf(env) !== 'self-host' || !kod) return { dostepny: false }
  if ((await sys.user.count()) > 0) return { dostepny: false }
  const firmy = await sys.organization.findMany({ select: { name: true }, take: 2, orderBy: { createdAt: 'asc' } })
  return { dostepny: true, istniejacaFirma: firmy.length === 1 ? firmy[0]!.name : null, wieleFirm: firmy.length > 1 }
}

export interface DaneKreatora {
  kod: string
  nazwaFirmy: string
  imie: string
  email: string
  haslo: string
  /** `demo` = firma z danymi fikcyjnymi zamiast własnej (przycisk „Najpierw zobacz demo”). */
  tryb: 'firma' | 'demo'
  /** szablon przepływu nowej firmy (lib/automaty/szablony.ts); pusty albo nieznany = bez szablonu. */
  szablon?: string | null
  ip: string
  userAgent?: string | null
}

export type WynikKreatora = { ok: true; token: string; expiresAt: Date; organizationId: string } | { ok: false; blad: string; zamkniety?: boolean }

export const MSG_ZAMKNIETY = 'Kompletor jest już skonfigurowany. Zaloguj się na swoje konto.'
export const MSG_ZLY_KOD = 'Nieprawidłowy kod instalacji. Kod jest w logu kontenera web, w adresie wypisanym po starcie.'

class Odmowa extends Error {}

export interface ZaleznosciKreatora {
  env: Env
  kodInstalacji: string | null
  limiter?: SlidingLimiter
  /** Klient firmy (RLS) do wypełnienia firmy demo danymi fikcyjnymi. */
  orgClient: (organizationId: string) => PrismaClient
  log?: (msg: string) => void
}

/**
 * Wykonuje kreator: sprawdzenia (tryb, limit, kod, pola), potem w jednej transakcji pod blokadą doradczą: zero kont,
 * firma (nowa, istniejąca jedyna z presetu albo demo), konto właściciela; na końcu logowanie (`login`) i token sesji.
 */
export async function wykonajKreatorDb(sys: PrismaClient, d: DaneKreatora, z: ZaleznosciKreatora): Promise<WynikKreatora> {
  if (appModeOf(z.env) !== 'self-host' || !z.kodInstalacji) return { ok: false, blad: MSG_ZAMKNIETY, zamkniety: true }
  if (!(z.limiter ?? kreatorLimiter).hit(d.ip)) return { ok: false, blad: 'Za dużo prób. Spróbuj ponownie za minutę.' }
  if (!safeEqual(d.kod.trim(), z.kodInstalacji)) return { ok: false, blad: MSG_ZLY_KOD }

  const email = normalizeEmail(d.email)
  const imie = d.imie.trim()
  const nazwa = d.nazwaFirmy.trim()
  if (!imie || imie.length > 120) return { ok: false, blad: 'Podaj imię (najwyżej 120 znaków).' }
  if (!isValidEmail(email)) return { ok: false, blad: 'Podaj prawidłowy adres e-mail.' }
  if (d.haslo.length < MIN_PASSWORD_LENGTH) return { ok: false, blad: `Hasło musi mieć co najmniej ${MIN_PASSWORD_LENGTH} znaków.` }
  if (d.haslo.length > 1024) return { ok: false, blad: 'Hasło może mieć najwyżej 1024 znaki.' }
  if (nazwa.length > 120) return { ok: false, blad: 'Nazwa firmy może mieć najwyżej 120 znaków.' }
  if (d.tryb === 'demo') {
    try {
      assertDemoDozwolone(z.env)
    } catch (e) {
      return { ok: false, blad: e instanceof Error ? e.message : String(e) }
    }
  }

  let organizationId: string
  let demoDoWypelnienia = false
  try {
    ;({ organizationId, demoDoWypelnienia } = await sys.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(${BLOKADA_INSTALACJI}::bigint)) AS blokada`
        if ((await tx.user.count()) > 0) throw new Odmowa(MSG_ZAMKNIETY)
        let orgId: string
        let demo = false
        if (d.tryb === 'demo') {
          demo = !(await tx.organization.findUnique({ where: { id: DEMO_ORG }, select: { id: true } }))
          if (demo) await applyOrgPresetTx(tx, DEMO_PRESET)
          orgId = DEMO_ORG
        } else {
          const firmy = await tx.organization.findMany({ select: { id: true }, take: 2 })
          if (firmy.length > 1) throw new Odmowa('W bazie jest kilka firm. Pierwsze konto załóż poleceniem: node dist/uzytkownik.cjs dodaj (README).')
          if (firmy.length === 1) orgId = firmy[0]!.id
          else {
            if (!nazwa) throw new Odmowa('Podaj nazwę firmy.')
            let slug = slugZNazwy(nazwa)
            if (ZAREZERWOWANE.has(slug)) slug = `${slug}-firma`
            const preset = presetNowejFirmy({ slug, name: nazwa, szablon: szablonPrzeplywu(d.szablon) })
            await applyOrgPresetTx(tx, preset)
            orgId = preset.id
          }
        }
        await createUser(tx, { email, name: imie, password: d.haslo })
        await grantMembership(tx, { email, organizationId: orgId, role: 'WLASCICIEL' })
        return { organizationId: orgId, demoDoWypelnienia: demo }
      },
      { timeout: 30_000, maxWait: 30_000 },
    ))
  } catch (e) {
    if (e instanceof Odmowa) return { ok: false, blad: e.message, zamkniety: e.message === MSG_ZAMKNIETY }
    throw e
  }

  const log = z.log ?? ((m: string) => console.log(m))
  log(`[start] kreator: firma ${organizationId} i pierwszy właściciel założeni${d.tryb === 'demo' ? ' (demo)' : ''}`)
  if (demoDoWypelnienia) {
    // dane fikcyjne po zatwierdzeniu konta: klient firmy demo (RLS), inne firmy nietknięte; błąd nie cofa konta
    try {
      const r = await wypelnijDemo(z.orgClient(DEMO_ORG))
      log(`[start] demo: ${r.produkty} produktów, ${r.zamowienia} zamówień fikcyjnych`)
    } catch (e) {
      log(`[start] demo: błąd wypełniania danymi fikcyjnymi: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const s = await login(sys, email, d.haslo, { userAgent: d.userAgent })
  if (!s.ok) return { ok: false, blad: 'Konto założone, ale logowanie się nie udało. Zaloguj się ręcznie.', zamkniety: true }
  return { ok: true, token: s.token, expiresAt: s.expiresAt, organizationId }
}

/** Stan kreatora dla ekranu /start (klient systemowy i kod instalacji z wolumenu sekretów). */
export async function stanKreatora(): Promise<StanKreatora> {
  return stanKreatoraDb(systemPrisma(), process.env, await czytajKodInstalacji())
}

/** Kreator z formularza /start. */
export async function wykonajKreator(d: DaneKreatora): Promise<WynikKreatora> {
  return wykonajKreatorDb(systemPrisma(), d, { env: process.env, kodInstalacji: await czytajKodInstalacji(), orgClient: prismaForOrg })
}

// ─── Demo → własna firma z panelu ─────────────────────────────────

export interface StanWlasnejFirmy {
  /** Przycisk „Utwórz własną firmę” ma sens: self-host, osoba jest właścicielem demo, w bazie nie ma innej aktywnej firmy. */
  dostepny: boolean
}

/**
 * Warunki „Utwórz własną firmę” po demo. Tylko self-host (w hostingu firmy zakłada rejestracja), tylko właściciel firmy
 * demo i tylko dopóki instancja nie ma żadnej innej aktywnej firmy: to droga z demo do pierwszej firmy, nie zakładanie
 * kolejnych firm z panelu (te zakłada administrator poleceniem `org:create`).
 */
export async function stanWlasnejFirmyDb(sys: PrismaClient, env: Env, s: { userId: string; organizationId: string; rola: string }): Promise<StanWlasnejFirmy> {
  if (appModeOf(env) !== 'self-host' || s.organizationId !== DEMO_ORG || s.rola !== 'WLASCICIEL') return { dostepny: false }
  const inne = await sys.organization.count({ where: { active: true, id: { not: DEMO_ORG } } })
  return { dostepny: inne === 0 }
}

export interface DaneWlasnejFirmy {
  userId: string
  nazwa: string
  /** true = firma demo zostaje aktywna (domyślnie wyłączana: jedyna firma self-hostu czyta klucze z env). */
  zostawDemo: boolean
}

export type WynikWlasnejFirmy = { ok: true; organizationId: string } | { ok: false; blad: string }

/**
 * Zakłada własną firmę osoby z demo (preset nowej firmy: magazyn, reguły, faktury „brak”) i daje jej rolę właściciela.
 * Firma demo zostaje w bazie z danymi fikcyjnymi; domyślnie nieaktywna (`active=false`), więc znika z przełącznika firm,
 * worker jej nie czyta, a nowa firma jest jedyną aktywną (klucze z env self-hostu działają jak po zwykłej instalacji).
 * Jedna transakcja pod tą samą blokadą doradczą co kreator: dwa kliknięcia dają jedną firmę.
 */
export async function utworzWlasnaFirmeDb(sys: PrismaClient, d: DaneWlasnejFirmy, env: Env): Promise<WynikWlasnejFirmy> {
  const nazwa = d.nazwa.trim()
  if (!nazwa) return { ok: false, blad: 'Podaj nazwę firmy.' }
  if (nazwa.length > 120) return { ok: false, blad: 'Nazwa firmy może mieć najwyżej 120 znaków.' }
  if (appModeOf(env) !== 'self-host') return { ok: false, blad: 'W hostingu nową firmę zakłada się przy rejestracji.' }
  try {
    const organizationId = await sys.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(${BLOKADA_INSTALACJI}::bigint)) AS blokada`
        const m = await tx.membership.findFirst({ where: { userId: d.userId, organizationId: DEMO_ORG, active: true, role: 'WLASCICIEL' }, include: { user: { select: { email: true } } } })
        if (!m) throw new Odmowa('Własną firmę zakłada właściciel firmy demo.')
        if ((await tx.organization.count({ where: { active: true, id: { not: DEMO_ORG } } })) > 0) throw new Odmowa('Ta instalacja ma już firmę. Kolejne firmy zakłada administrator.')
        let slug = slugZNazwy(nazwa)
        if (ZAREZERWOWANE.has(slug)) slug = `${slug}-firma`
        if (await tx.organization.findFirst({ where: { OR: [{ slug }, { id: slug.replace(/-/g, '_') }] }, select: { id: true } })) slug = `${slug.slice(0, 33)}-${Date.now().toString(36).slice(-6)}`
        const preset = presetNowejFirmy({ slug, name: nazwa })
        await applyOrgPresetTx(tx, preset)
        await grantMembership(tx, { email: m.user.email, organizationId: preset.id, role: 'WLASCICIEL' })
        if (!d.zostawDemo) await tx.organization.update({ where: { id: DEMO_ORG }, data: { active: false } })
        return preset.id
      },
      { timeout: 30_000, maxWait: 30_000 },
    )
    console.log(`[start] własna firma ${organizationId} założona z panelu demo${d.zostawDemo ? ' (demo zostaje)' : ' (demo wyłączone)'}`)
    return { ok: true, organizationId }
  } catch (e) {
    if (e instanceof Odmowa) return { ok: false, blad: e.message }
    throw e
  }
}

export async function stanWlasnejFirmy(s: { userId: string; organizationId: string; rola: string }): Promise<StanWlasnejFirmy> {
  return stanWlasnejFirmyDb(systemPrisma(), process.env, s)
}

export async function utworzWlasnaFirme(d: DaneWlasnejFirmy): Promise<WynikWlasnejFirmy> {
  return utworzWlasnaFirmeDb(systemPrisma(), d, process.env)
}
