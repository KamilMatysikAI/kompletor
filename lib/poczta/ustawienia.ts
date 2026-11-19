// Ustawienia → Poczta: transport SMTP firmy, nadawca i wygląd per konto kanału, mail próbny.
// Hasło SMTP to sekret firmy SMTP_PASSWORD (IntegrationSecret, AES-256-GCM): ekran pokazuje tylko „ustawione: tak/nie”,
// wartość nigdy nie wraca. Zapis z walidacją i AuditLog (bez hasła). Wysyłka wymaga dwóch bramek: POCZTA_WYSYLKA=1 na
// instancji i włącznika firmy tutaj; bez nich plan akcji czeka w stanie „zaplanowana” i nic nie ginie.
import type { Channel, Prisma, PrismaClient } from '@prisma/client'
import { appModeOf } from '../db'
import { accountDisplayName } from '../panel/format'
import { deleteSecret, listSecrets, resolveSecrets, setSecret, type Env } from '../sekrety'
import { BEZPIECZENSTWO, maskujAdres, poprawnyAdres, sprawdzKonfiguracje, type Bezpieczenstwo, type KonfiguracjaSmtp } from '../maile/transport'

export const SMTP_PASSWORD = 'SMTP_PASSWORD'
export const AUDIT_USTAWIENIA = 'MailSettings'
export const AUDIT_TEST = 'MailTest'
export const DOMYSLNY_KOLOR = '#24527a'

/** Błąd konfiguracji: komunikat po polsku do pokazania na ekranie, bez sekretów. */
export class BladUstawienPoczty extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BladUstawienPoczty'
  }
}

/**
 * `POCZTA_WYSYLKA`: `1` = instancja może wysyłać maile, `0` albo puste = nie (domyślnie). Zła wartość = błąd, jak
 * POWIADOMIENIA_WYSYLKA. Druga bramka to włącznik firmy w Ustawieniach → Poczta.
 */
export function wysylkaPocztyZEnv(env: Env): boolean {
  const v = (env.POCZTA_WYSYLKA ?? '').trim()
  if (v === '' || v === '0') return false
  if (v === '1') return true
  throw new Error('POCZTA_WYSYLKA: 1 (wysyłka maili włączona), 0 albo puste (wyłączona)')
}

export function hosting(env: Env): boolean {
  return appModeOf(env) === 'hosted'
}

// ─── Nadawca per konto kanału ───────────────────────────────────────────────

/** Nadawca i wygląd maili jednego konta kanału (sklepu). Puste pole = wartość firmy. */
export interface NadawcaKonta {
  nazwaSklepu?: string
  email?: string
  nazwaNadawcy?: string
  odpowiedzDo?: string
  www?: string
  logoUrl?: string
  kolor?: string
  odbiorAdres?: string[]
  odbiorGodziny?: string[]
  odbiorUwagi?: string
}

export type Nadawcy = Record<string, NadawcaKonta>

export const kluczKonta = (channel: Channel | string, channelAccountId: string) => `${channel}:${channelAccountId}`

const KOLOR_RE = /^#[0-9a-fA-F]{6}$/
const MAX_POLE = 200

function tekst(v: unknown, max = MAX_POLE): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  return t ? t.slice(0, max) : undefined
}

function linie(v: unknown): string[] | undefined {
  const raw = Array.isArray(v) ? v.join('\n') : typeof v === 'string' ? v : ''
  const out = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((l) => l.slice(0, MAX_POLE))
  return out.length ? out : undefined
}

function httpUrl(v: string | undefined, pole: string, bledy: string[]): string | undefined {
  if (!v) return undefined
  try {
    const u = new URL(v)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error()
    return u.toString()
  } catch {
    bledy.push(`${pole}: adres musi zaczynać się od https://`)
    return undefined
  }
}

/** Nadawca z formularza albo bazy (dane nieznanego kształtu) → poprawny obiekt i błędy po polsku. */
export function parseNadawca(raw: unknown, etykieta: string): { nadawca: NadawcaKonta; bledy: string[] } {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const bledy: string[] = []
  const n: NadawcaKonta = {}
  const nazwa = tekst(r.nazwaSklepu, 100)
  if (nazwa) n.nazwaSklepu = nazwa
  for (const pole of ['email', 'odpowiedzDo'] as const) {
    const v = tekst(r[pole], 254)
    if (!v) continue
    if (!poprawnyAdres(v)) bledy.push(`${etykieta}: niepoprawny adres e-mail „${String(v).slice(0, 60)}”`)
    else n[pole] = v.toLowerCase()
  }
  const nazwaNadawcy = tekst(r.nazwaNadawcy, 100)
  if (nazwaNadawcy) n.nazwaNadawcy = nazwaNadawcy
  const www = httpUrl(tekst(r.www), `${etykieta}, strona sklepu`, bledy)
  if (www) n.www = www
  const logo = httpUrl(tekst(r.logoUrl, 500), `${etykieta}, logo`, bledy)
  if (logo) n.logoUrl = logo
  const kolor = tekst(r.kolor, 7)
  if (kolor) {
    if (!KOLOR_RE.test(kolor)) bledy.push(`${etykieta}: kolor w postaci #rrggbb`)
    else n.kolor = kolor.toLowerCase()
  }
  const adres = linie(r.odbiorAdres)
  if (adres) n.odbiorAdres = adres
  const godziny = linie(r.odbiorGodziny)
  if (godziny) n.odbiorGodziny = godziny
  const uwagi = tekst(r.odbiorUwagi, 300)
  if (uwagi) n.odbiorUwagi = uwagi
  return { nadawca: n, bledy }
}

export function nadawcyZBazy(raw: Prisma.JsonValue | null | undefined): Nadawcy {
  const out: Nadawcy = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw)) out[k] = parseNadawca(v, k).nadawca
  return out
}

// ─── Widok ekranu ──────────────────────────────────────────────────────────

export interface KontoPoczty {
  klucz: string
  channel: Channel
  channelAccountId: string
  nazwa: string
  tryb: string
  nadawca: NadawcaKonta
}

export interface WidokPoczty {
  enabled: boolean
  enabledAt: Date | null
  host: string
  port: number | null
  bezpieczenstwo: Bezpieczenstwo
  login: string
  fromEmail: string
  fromName: string
  officeEmail: string
  hasloUstawione: boolean
  /** POCZTA_WYSYLKA=1 na tej instancji; null = zła wartość env. */
  instancja: boolean | null
  hosting: boolean
  lastError: string | null
  lastErrorAt: Date | null
  /** Serwer odrzucił login albo hasło: wysyłka i linki do ustawienia hasła stoją do poprawy danych. */
  loginRejectedAt: Date | null
  konta: KontoPoczty[]
  /** Brakujące elementy konfiguracji (pusta lista = gotowe do wysyłki). */
  braki: string[]
}

export async function widokPoczty(db: PrismaClient, env: Env): Promise<WidokPoczty> {
  const [s, sekrety, konta] = await Promise.all([
    db.mailSettings.findFirst(),
    listSecrets(db),
    db.channelConfig.findMany({ select: { channel: true, channelAccountId: true, name: true, config: true, statusMode: true }, orderBy: [{ channel: 'asc' }, { channelAccountId: 'asc' }] }),
  ])
  let instancja: boolean | null
  try {
    instancja = wysylkaPocztyZEnv(env)
  } catch {
    instancja = null
  }
  const nadawcy = nadawcyZBazy(s?.senders)
  const hasloUstawione = sekrety.some((x) => x.name === SMTP_PASSWORD && !x.channel)
  return {
    enabled: s?.enabled ?? false,
    enabledAt: s?.enabledAt ?? null,
    host: s?.host ?? '',
    port: s?.port ?? null,
    bezpieczenstwo: ((BEZPIECZENSTWO as readonly string[]).includes(s?.security ?? '') ? s!.security : 'STARTTLS') as Bezpieczenstwo,
    login: s?.username ?? '',
    fromEmail: s?.fromEmail ?? '',
    fromName: s?.fromName ?? '',
    officeEmail: s?.officeEmail ?? '',
    hasloUstawione,
    instancja,
    hosting: hosting(env),
    lastError: s?.lastError ?? null,
    lastErrorAt: s?.lastErrorAt ?? null,
    loginRejectedAt: s?.loginRejectedAt ?? null,
    konta: konta.map((k) => ({
      klucz: kluczKonta(k.channel, k.channelAccountId),
      channel: k.channel,
      channelAccountId: k.channelAccountId,
      nazwa: accountDisplayName(k.channel, k.channelAccountId, k.name, k.config),
      tryb: k.statusMode,
      nadawca: nadawcy[kluczKonta(k.channel, k.channelAccountId)] ?? {},
    })),
    braki: brakiKonfiguracji(s, hasloUstawione),
  }
}

/** Czego brakuje do wysyłki (teksty do ekranu i do `lastError` przy wysyłce). */
export function brakiKonfiguracji(s: { host: string | null; port: number | null; fromEmail: string | null; username: string | null } | null, hasloUstawione: boolean): string[] {
  const b: string[] = []
  if (!s?.host) b.push('adres serwera SMTP')
  if (!s?.port) b.push('port')
  if (!s?.fromEmail) b.push('adres nadawcy')
  if (s?.username && !hasloUstawione) b.push('hasło SMTP')
  return b
}

// ─── Zapis ─────────────────────────────────────────────────────────────────

export interface WejscieUstawien {
  enabled: boolean
  host: string
  port: string
  bezpieczenstwo: string
  login: string
  /** Nowe hasło; puste = bez zmiany. */
  haslo: string
  usunHaslo: boolean
  fromEmail: string
  fromName: string
  officeEmail: string
  nadawcy: Record<string, Record<string, string>>
}

const POLA_NADAWCY = ['nazwaSklepu', 'email', 'nazwaNadawcy', 'odpowiedzDo', 'www', 'logoUrl', 'kolor', 'odbiorAdres', 'odbiorGodziny', 'odbiorUwagi'] as const

/** Formularz ekranu → dane do zapisu (bez walidacji). Pola nadawcy: `n_<pole>_<klucz konta>`. */
export function parseFormularzPoczty(form: FormData): WejscieUstawien {
  const str = (k: string) => String(form.get(k) ?? '')
  const nadawcy: WejscieUstawien['nadawcy'] = {}
  for (const klucz of form.getAll('konto').map(String)) {
    nadawcy[klucz] = Object.fromEntries(POLA_NADAWCY.map((p) => [p, str(`n_${p}_${klucz}`)]))
  }
  return {
    enabled: form.get('wlaczone') === 'tak',
    host: str('host'),
    port: str('port'),
    bezpieczenstwo: str('bezpieczenstwo'),
    login: str('login'),
    haslo: str('haslo'),
    usunHaslo: form.get('usun_haslo') === 'tak',
    fromEmail: str('od_email'),
    fromName: str('od_nazwa'),
    officeEmail: str('biuro'),
    nadawcy,
  }
}

/**
 * Zapis ustawień: walidacja (adresy, serwer w hostingu tylko publiczny), hasło jako sekret firmy, AuditLog bez hasła.
 * `enabledAt` = teraz przy włączeniu (wyłączone → włączone). Do włączenia potrzebna pełna konfiguracja.
 * `loginRejectedAt` (blokada po odrzuconym logowaniu) znika, gdy zapis zmienia dane serwera (host, port, szyfrowanie,
 * login, hasło) albo włącza wysyłkę; zwykły zapis innych pól (nadawca, biuro) jej nie zdejmuje.
 */
export async function zapiszUstawieniaPoczty(db: PrismaClient, input: WejscieUstawien, actorId: string, env: Env, now = new Date()): Promise<void> {
  const bledy: string[] = []
  const host = input.host.trim().toLowerCase()
  const port = input.port.trim() ? Number(input.port.trim()) : NaN
  const bezp = input.bezpieczenstwo.trim() || 'STARTTLS'
  if (host || input.port.trim()) bledy.push(...sprawdzKonfiguracje({ host, port, bezpieczenstwo: bezp }, { hosting: hosting(env) }))
  const login = input.login.trim().slice(0, 254) || null
  const fromEmail = input.fromEmail.trim().toLowerCase() || null
  if (fromEmail && !poprawnyAdres(fromEmail)) bledy.push('Niepoprawny adres nadawcy')
  const officeEmail = input.officeEmail.trim().toLowerCase() || null
  if (officeEmail && !poprawnyAdres(officeEmail)) bledy.push('Niepoprawny adres biura')
  const fromName = input.fromName.replace(/[\u0000-\u001f\u007f"<>]+/g, ' ').trim().slice(0, 100) || null
  if (input.haslo && input.haslo.length > 500) bledy.push('Hasło SMTP: najwyżej 500 znaków')

  const konta = await db.channelConfig.findMany({ select: { channel: true, channelAccountId: true, name: true, config: true } })
  const znane = new Map(konta.map((k) => [kluczKonta(k.channel, k.channelAccountId), accountDisplayName(k.channel, k.channelAccountId, k.name, k.config)]))
  const nadawcy: Nadawcy = {}
  for (const [klucz, pola] of Object.entries(input.nadawcy)) {
    if (!znane.has(klucz)) continue // konto usunięte w międzyczasie albo podrobiony klucz z formularza
    const { nadawca, bledy: b } = parseNadawca(pola, znane.get(klucz)!)
    bledy.push(...b)
    if (Object.keys(nadawca).length) nadawcy[klucz] = nadawca
  }
  if (bledy.length) throw new BladUstawienPoczty(bledy.join('; '))

  const sekrety = await listSecrets(db)
  const maHasloPrzed = sekrety.some((x) => x.name === SMTP_PASSWORD && !x.channel)
  const maHaslo = (!input.usunHaslo && sekrety.some((x) => x.name === SMTP_PASSWORD && !x.channel)) || !!input.haslo
  if (input.enabled) {
    const braki = brakiKonfiguracji({ host: host || null, port: Number.isFinite(port) ? port : null, fromEmail, username: login }, maHaslo)
    if (braki.length) throw new BladUstawienPoczty(`Do włączenia wysyłki uzupełnij: ${braki.join(', ')}`)
  }
  if (input.haslo) await setSecret(db, SMTP_PASSWORD, input.haslo, env)
  else if (input.usunHaslo) await deleteSecret(db, SMTP_PASSWORD)

  await db.$transaction(async (tx) => {
    const before = await tx.mailSettings.findFirst()
    const turningOn = input.enabled && !before?.enabled
    const zmianaSerwera =
      !!input.haslo ||
      (input.usunHaslo && maHasloPrzed) ||
      (before?.host ?? null) !== (host || null) ||
      (before?.port ?? null) !== (Number.isFinite(port) ? port : null) ||
      (before?.security ?? 'STARTTLS') !== bezp ||
      (before?.username ?? null) !== login
    const data = {
      enabled: input.enabled,
      enabledAt: turningOn ? now : (before?.enabledAt ?? null),
      host: host || null,
      port: Number.isFinite(port) ? port : null,
      security: bezp,
      username: login,
      fromEmail,
      fromName,
      officeEmail,
      senders: nadawcy as Prisma.InputJsonObject,
      updatedById: actorId,
      // zapis poprawionej konfiguracji czyści stary błąd (np. odrzucone hasło); wysyłka ustawi nowy, jeśli trzeba
      lastError: null,
      lastErrorAt: null,
      loginRejectedAt: turningOn || zmianaSerwera ? null : (before?.loginRejectedAt ?? null),
    }
    const organizationId = (await tx.organization.findFirstOrThrow({ select: { id: true } })).id
    await tx.mailSettings.upsert({ where: { organizationId }, create: data, update: data })
    const snap = (x: typeof data | null) =>
      x && { enabled: x.enabled, host: x.host, port: x.port, security: x.security, username: x.username, fromEmail: x.fromEmail, fromName: x.fromName, officeEmail: x.officeEmail, senders: x.senders as object }
    await tx.auditLog.create({
      data: {
        entity: AUDIT_USTAWIENIA,
        entityId: organizationId,
        actorId,
        before: (before ? snap({ ...before, senders: before.senders as Prisma.InputJsonObject } as typeof data) : undefined) ?? undefined,
        after: { ...snap(data)!, haslo: input.haslo ? 'zmienione' : input.usunHaslo ? 'usunięte' : 'bez zmian' },
      },
    })
  })
}

// ─── Konfiguracja do wysyłki ─────────────────────────────────────────────────

export interface PocztaFirmy {
  smtp: KonfiguracjaSmtp
  fromEmail: string
  fromName: string | null
  officeEmail: string | null
  nadawcy: Nadawcy
  enabled: boolean
  enabledAt: Date | null
  lastError: string | null
  loginRejectedAt: Date | null
}

/**
 * Konfiguracja do wysyłki albo komunikat, czego brakuje. Serwer sprawdzany drugi raz (tryb instalacji mógł się
 * zmienić). Hasło tylko z sekretu firmy w bazie, bez env serwera (jak klucz Zulipa).
 */
export async function pocztaFirmy(db: PrismaClient, env: Env): Promise<{ ok: true; poczta: PocztaFirmy } | { ok: false; brak: string; enabled: boolean; lastError: string | null }> {
  const s = await db.mailSettings.findFirst()
  if (!s) return { ok: false, brak: 'Poczta nie jest skonfigurowana (Ustawienia → Komunikacja i poczta → Poczta)', enabled: false, lastError: null }
  const haslo = s.username ? (await resolveSecrets(db, [SMTP_PASSWORD], { env, envFallback: false }))[SMTP_PASSWORD] || null : null
  const braki = brakiKonfiguracji(s, !!haslo)
  if (braki.length) return { ok: false, brak: `Poczta nie jest skonfigurowana: brak ${braki.join(', ')} (Ustawienia → Komunikacja i poczta → Poczta)`, enabled: s.enabled, lastError: s.lastError }
  const bledy = sprawdzKonfiguracje({ host: s.host!, port: s.port!, bezpieczenstwo: s.security }, { hosting: hosting(env) })
  if (bledy.length) return { ok: false, brak: `Konfiguracja poczty niepoprawna: ${bledy.join('; ')}`, enabled: s.enabled, lastError: s.lastError }
  return {
    ok: true,
    poczta: {
      smtp: { host: s.host!, port: s.port!, bezpieczenstwo: s.security as Bezpieczenstwo, login: s.username, haslo, adresOdbic: s.bounceAddress },
      fromEmail: s.fromEmail!,
      fromName: s.fromName,
      officeEmail: s.officeEmail,
      nadawcy: nadawcyZBazy(s.senders),
      enabled: s.enabled,
      enabledAt: s.enabledAt,
      lastError: s.lastError,
      loginRejectedAt: s.loginRejectedAt,
    },
  }
}

/**
 * Komunikat błędu poczty firmy. `wylacz` = serwer odrzucił login albo hasło: wysyłka z planu wyłączona i blokada
 * `loginRejectedAt` (zaproszenia też stoją, bo serwer i tak nie przyjmie loginu) do poprawy danych. Linków resetu hasła
 * to nie dotyczy: idą pocztą instalacji (lib/poczta/instalacja.ts).
 */
export async function ustawBladPoczty(db: PrismaClient, message: string | null, now: Date, wylacz = false): Promise<void> {
  // klient firmy (RLS) widzi tylko wiersz swojej firmy
  await db.mailSettings.updateMany({ data: { lastError: message?.slice(0, 300) ?? null, lastErrorAt: message ? now : null, ...(wylacz ? { enabled: false, loginRejectedAt: now } : {}) } })
}

/** Mail przyjęty przez serwer = logowanie działa: blokada po odrzuconym logowaniu znika (no-op, gdy jej nie było). */
export async function zdejmijBlokadeLogowania(db: PrismaClient): Promise<void> {
  await db.mailSettings.updateMany({ where: { loginRejectedAt: { not: null } }, data: { loginRejectedAt: null } })
}

export { maskujAdres }
