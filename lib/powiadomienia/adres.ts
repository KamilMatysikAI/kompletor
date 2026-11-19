// Walidacja konfiguracji powiadomień: adres Zulipa (SSRF), strumień, temat, adres bota, env instancji.
// Adres sprawdzany przy zapisie z panelu i drugi raz przed każdą wysyłką (lista hostów mogła się zmienić w env).
import { ALERT_GROUPS, DEFAULT_ROUTES, type AlertGroup, type Route, type Routes } from './grupy'

export type Env = Record<string, string | undefined>

/** Błąd konfiguracji: komunikat po polsku do pokazania na ekranie, bez sekretów. */
export class NotificationConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotificationConfigError'
  }
}

/**
 * `POWIADOMIENIA_WYSYLKA`: `1` = instancja może wysyłać, `0` albo puste = nie (domyślnie). Zła wartość = błąd na
 * starcie workera, jak `CIEN_ODCZYT` (lib/worker/harmonogram.ts).
 */
export function wysylkaZEnv(env: Env): boolean {
  const v = (env.POWIADOMIENIA_WYSYLKA ?? '').trim()
  if (v === '' || v === '0') return false
  if (v === '1') return true
  throw new Error('POWIADOMIENIA_WYSYLKA: 1 (wysyłka włączona), 0 albo puste (wyłączona)')
}

const HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

function validHostname(h: string): boolean {
  if (h.length > 253 || !h.includes('.')) return false
  const labels = h.split('.')
  if (!labels.every((l) => HOST_LABEL.test(l))) return false
  // ostatnia etykieta z samych cyfr = adres IP albo jego skrót (np. 127.1)
  return !/^[0-9]+$/.test(labels.at(-1)!)
}

export const DEFAULT_ALLOWED_HOSTS: readonly string[] = ['*.zulipchat.com']

/**
 * Dozwolone hosty Zulipa: domyślnie `*.zulipchat.com`; `ZULIP_DOZWOLONE_HOSTY` (po przecinku, `nazwa.hosta` albo
 * `*.domena`) zastępuje listę — dla Zulipa na własnym serwerze. Zły wpis = błąd, nie po cichu.
 */
export function allowedHostsZEnv(env: Env): string[] {
  const raw = (env.ZULIP_DOZWOLONE_HOSTY ?? '').trim()
  if (!raw) return [...DEFAULT_ALLOWED_HOSTS]
  const out: string[] = []
  for (const part of raw.split(',')) {
    const p = part.trim().toLowerCase()
    if (!p) continue
    const host = p.startsWith('*.') ? p.slice(2) : p
    if (!validHostname(host) || host === 'localhost' || host.endsWith('.localhost'))
      throw new Error(`ZULIP_DOZWOLONE_HOSTY: „${part.trim().slice(0, 80)}” — dozwolone nazwy hostów (np. zulip.firma.pl, *.zulipchat.com), bez IP, portów i ścieżek`)
    out.push(p)
  }
  if (!out.length) throw new Error('ZULIP_DOZWOLONE_HOSTY: pusta lista')
  return out
}

function hostAllowed(host: string, allowed: readonly string[]): boolean {
  return allowed.some((a) => (a.startsWith('*.') ? host.endsWith(a.slice(1)) && host.length > a.length - 1 : host === a))
}

/**
 * Adres Zulipa z panelu → `https://host` (bez końcowego „/”). Tylko https, host z listy dozwolonych, bez IP,
 * localhost, portu, użytkownika, ścieżki, zapytania i kotwicy.
 */
export function parseZulipSite(raw: string, env: Env): string {
  const s = raw.trim()
  if (!s) throw new NotificationConfigError('Podaj adres Zulipa, np. https://firma.zulipchat.com')
  if (s.length > 200) throw new NotificationConfigError('Adres Zulipa za długi')
  let u: URL
  try {
    u = new URL(s)
  } catch {
    throw new NotificationConfigError('Adres Zulipa w formacie https://firma.zulipchat.com')
  }
  if (u.protocol !== 'https:') throw new NotificationConfigError('Adres Zulipa musi zaczynać się od https://')
  if (u.username || u.password) throw new NotificationConfigError('Adres Zulipa bez nazwy użytkownika i hasła')
  if (u.port) throw new NotificationConfigError('Adres Zulipa bez numeru portu')
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash || /[?#]/.test(s))
    throw new NotificationConfigError('Adres Zulipa bez ścieżki, np. https://firma.zulipchat.com')
  const host = u.hostname.toLowerCase()
  if (host.startsWith('[') || host === 'localhost' || host.endsWith('.localhost') || !validHostname(host))
    throw new NotificationConfigError('Adres Zulipa musi być nazwą hosta (bez adresu IP i localhost)')
  let allowed: string[]
  try {
    allowed = allowedHostsZEnv(env)
  } catch (e) {
    throw new NotificationConfigError(e instanceof Error ? e.message : String(e))
  }
  if (!hostAllowed(host, allowed)) throw new NotificationConfigError(`Host ${host} spoza listy dozwolonych (${allowed.join(', ')}); Zulip na własnym serwerze: env ZULIP_DOZWOLONE_HOSTY`)
  return `https://${host}`
}

const BOT_EMAIL = /^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/

export function parseBotEmail(raw: string): string {
  const s = raw.trim()
  if (!BOT_EMAIL.test(s)) throw new NotificationConfigError('Adres bota w formacie nazwa-bot@firma.zulipchat.com')
  return s
}

/** Znaki sterujące (C0, DEL, C1) i znaki kierunku tekstu — niedozwolone w strumieniu i temacie. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/

export const NAME_MAX = 60

/** Strumień albo temat: przycięty, 1–60 znaków, bez znaków sterujących. */
export function parseName(raw: string, what: 'Strumień' | 'Temat'): string {
  const s = raw.trim()
  if (!s) throw new NotificationConfigError(`${what}: puste pole`)
  if ([...s].length > NAME_MAX) throw new NotificationConfigError(`${what}: najwyżej ${NAME_MAX} znaków`)
  if (CONTROL.test(s)) throw new NotificationConfigError(`${what}: niedozwolone znaki sterujące`)
  return s
}

/** Trasa z bazy, gdy jest poprawna; inaczej null (grupa bez trasy = alerty tej grupy nie wychodzą). */
function routeOf(v: unknown): Route | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const r = v as Record<string, unknown>
  if (typeof r.stream !== 'string' || typeof r.topic !== 'string') return null
  try {
    return { stream: parseName(r.stream, 'Strumień'), topic: parseName(r.topic, 'Temat') }
  } catch {
    return null
  }
}

/**
 * Trasy z `NotificationSettings.routes`: grupa nieobecna w zapisie = trasa domyślna; zapisana jako null (pusty
 * strumień na ekranie) albo niepoprawna = bez trasy.
 */
export function routesOf(json: unknown): Routes {
  const obj = json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {}
  const out = {} as Routes
  for (const g of ALERT_GROUPS) out[g] = Object.hasOwn(obj, g) ? routeOf(obj[g]) : DEFAULT_ROUTES[g]
  return out
}

export function isGroup(v: string): v is AlertGroup {
  return (ALERT_GROUPS as readonly string[]).includes(v)
}

/**
 * `APP_PUBLIC_URL` (opcjonalny): adres panelu do linku w wiadomości. Puste = bez linku; zły = błąd na starcie workera.
 */
export function publicUrlZEnv(env: Env): string | null {
  const raw = (env.APP_PUBLIC_URL ?? '').trim()
  if (!raw) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new Error('APP_PUBLIC_URL: pełny adres panelu, np. https://kompletor.firma.pl, albo puste')
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('APP_PUBLIC_URL: tylko http(s)://')
  if (u.username || u.password || u.search || u.hash) throw new Error('APP_PUBLIC_URL: bez użytkownika, zapytania i kotwicy')
  return u.origin + u.pathname.replace(/\/+$/, '')
}

/** Walidacja env powiadomień na starcie workera (zła wartość = proces nie startuje). */
export function powiadomieniaZEnv(env: Env): { wysylka: boolean; allowedHosts: string[]; publicUrl: string | null } {
  return { wysylka: wysylkaZEnv(env), allowedHosts: allowedHostsZEnv(env), publicUrl: publicUrlZEnv(env) }
}
