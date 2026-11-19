// Ustawienia → Powiadomienia: odczyt dla ekranu, zapis z walidacją i AuditLog, wiadomość próbna.
// Klucz bota to sekret firmy ZULIP_API_KEY — ekran pokazuje tylko „ustawiony: tak/nie”, wartość nigdy nie wychodzi.
import type { PrismaClient } from '@prisma/client'
import { listSecrets, resolveSecrets, type Env } from '../sekrety'
import type { FetchLike } from '../zrodla/http'
import { NotificationConfigError, parseBotEmail, parseName, parseZulipSite, publicUrlZEnv, routesOf, wysylkaZEnv } from './adres'
import { ALERT_GROUPS, type AlertGroup, type Routes } from './grupy'
import { testMessage } from './tresc'
import { AUTH_DISABLED_PREFIX, ZULIP_KEY } from './wysylka'
import { sendZulipMessage } from './zulip'

export interface NotificationView {
  enabled: boolean
  enabledAt: Date | null
  zulipSite: string
  zulipBotEmail: string
  routes: Routes
  lastError: string | null
  lastErrorAt: Date | null
  updatedAt: Date | null
  /** Sekret firmy ZULIP_API_KEY ustawiony (sama obecność, bez wartości). */
  keySet: boolean
  /** POWIADOMIENIA_WYSYLKA=1 na tej instancji; null = zła wartość env. */
  instanceSending: boolean | null
  recent: { kind: string; group: string; state: string; attempts: number; at: Date; lastError: string | null }[]
}

export async function notificationView(db: PrismaClient, env: Env): Promise<NotificationView> {
  const [s, secrets, recent] = await Promise.all([
    db.notificationSettings.findFirst(),
    listSecrets(db),
    db.alertDelivery.findMany({ orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: 10, select: { kind: true, group: true, state: true, attempts: true, updatedAt: true, lastError: true } }),
  ])
  let instanceSending: boolean | null
  try {
    instanceSending = wysylkaZEnv(env)
  } catch {
    instanceSending = null
  }
  return {
    enabled: s?.enabled ?? false,
    enabledAt: s?.enabledAt ?? null,
    zulipSite: s?.zulipSite ?? '',
    zulipBotEmail: s?.zulipBotEmail ?? '',
    routes: routesOf(s?.routes ?? {}),
    lastError: s?.lastError ?? null,
    lastErrorAt: s?.lastErrorAt ?? null,
    updatedAt: s?.updatedAt ?? null,
    keySet: secrets.some((x) => x.name === ZULIP_KEY && !x.channel),
    instanceSending,
    recent: recent.map((r) => ({ kind: r.kind, group: r.group, state: r.state, attempts: r.attempts, at: r.updatedAt, lastError: r.lastError })),
  }
}

export interface NotificationInput {
  enabled: boolean
  zulipSite: string
  zulipBotEmail: string
  /** Pusty strumień = grupa bez trasy (jej alerty nie wychodzą). */
  routes: Record<AlertGroup, { stream: string; topic: string }>
}

/** Formularz ekranu → dane do zapisu (bez walidacji; tę robi `saveNotificationSettings`). */
export function parseNotificationForm(form: FormData): NotificationInput {
  const str = (k: string) => String(form.get(k) ?? '')
  const routes = {} as NotificationInput['routes']
  for (const g of ALERT_GROUPS) routes[g] = { stream: str(`strumien_${g}`), topic: str(`temat_${g}`) }
  return { enabled: form.get('wlaczone') === 'tak', zulipSite: str('adres'), zulipBotEmail: str('bot'), routes }
}

/**
 * Zapis ustawień: walidacja (adres z listy hostów, bot, strumienie i tematy), AuditLog z autorem. `enabledAt` = teraz
 * przy każdym włączeniu (wyłączone → włączone), więc alerty sprzed włączenia nie wychodzą. Włączenie czyści
 * `lastError` (np. po wyłączeniu przez 401). Błąd walidacji = NotificationConfigError z komunikatem po polsku.
 */
export async function saveNotificationSettings(db: PrismaClient, input: NotificationInput, actorId: string, env: Env, now = new Date()): Promise<void> {
  const site = input.zulipSite.trim() ? parseZulipSite(input.zulipSite, env) : null
  const bot = input.zulipBotEmail.trim() ? parseBotEmail(input.zulipBotEmail) : null
  if (input.enabled && (!site || !bot)) throw new NotificationConfigError('Do włączenia potrzebny adres Zulipa i adres bota')
  const routes: Record<string, { stream: string; topic: string } | null> = {}
  for (const g of ALERT_GROUPS) {
    const r = input.routes[g]
    if (!r.stream.trim()) {
      routes[g] = null
      continue
    }
    routes[g] = { stream: parseName(r.stream, 'Strumień'), topic: parseName(r.topic, 'Temat') }
  }
  await db.$transaction(async (tx) => {
    const before = await tx.notificationSettings.findFirst()
    const turningOn = input.enabled && !before?.enabled
    // wyłączenie automatyczne (401/403 zostawia lastError przy enabled=false), niedawne: wznowienie bez gubienia alertów z przerwy
    const resume = turningOn && !!before?.enabledAt && !!before.lastError?.startsWith(AUTH_DISABLED_PREFIX) && !!before.lastErrorAt && now.getTime() - before.lastErrorAt.getTime() <= RESUME_MAX_MS
    const data = {
      enabled: input.enabled,
      enabledAt: resume ? before!.enabledAt : turningOn ? now : input.enabled ? (before?.enabledAt ?? now) : (before?.enabledAt ?? null),
      zulipSite: site,
      zulipBotEmail: bot,
      routes,
      updatedById: actorId,
      ...(turningOn ? { lastError: null, lastErrorAt: null } : {}),
    }
    const organizationId = (await tx.organization.findFirstOrThrow({ select: { id: true } })).id
    await tx.notificationSettings.upsert({ where: { organizationId }, create: data, update: data })
    const snap = (x: { enabled: boolean; enabledAt: Date | null; zulipSite: string | null; zulipBotEmail: string | null; routes: unknown } | null) =>
      x && { enabled: x.enabled, enabledAt: x.enabledAt?.toISOString() ?? null, zulipSite: x.zulipSite, zulipBotEmail: x.zulipBotEmail, routes: x.routes as object }
    await tx.auditLog.create({ data: { entity: 'NotificationSettings', entityId: organizationId, actorId, before: snap(before) ?? undefined, after: snap(data)! } })
  })
}

/** Odstęp między wiadomościami próbnymi firmy. */
export const TEST_MIN_GAP_MS = 60_000
/**
 * Po automatycznym wyłączeniu (401/403) ponowne włączenie wznawia wysyłkę od dawnego `enabledAt`, więc alerty z przerwy
 * wychodzą (dawkowane limitem 20/100), o ile przerwa trwała najwyżej tyle. Dłuższa = od teraz.
 */
export const RESUME_MAX_MS = 3 * 24 * 3600_000

export type TestResult = { ok: true } | { ok: false; error: string }

/**
 * Wiadomość próbna do trasy wybranej grupy. Ta sama bramka env (POWIADOMIENIA_WYSYLKA) i lista hostów co wysyłka
 * alertów; włącznik firmy nie jest wymagany (próba przed włączeniem). Bez ponawiania. Wpis w AuditLog.
 */
export async function sendTestNotification(db: PrismaClient, env: Env, group: AlertGroup, actorId: string, fetchImpl: FetchLike, now = new Date()): Promise<TestResult> {
  let enabledEnv: boolean
  try {
    enabledEnv = wysylkaZEnv(env)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  if (!enabledEnv) return { ok: false, error: 'Wysyłka na tej instancji wyłączona (POWIADOMIENIA_WYSYLKA)' }
  // najwyżej jedna próba na minutę na firmę, żeby seria kliknięć nie wyczerpała limitu Zulipa
  const recent = await db.auditLog.findFirst({ where: { entity: 'NotificationTest', createdAt: { gte: new Date(now.getTime() - TEST_MIN_GAP_MS) } }, select: { id: true } })
  if (recent) return { ok: false, error: 'Wiadomość próbna była wysłana przed chwilą — kolejna najwcześniej za minutę' }
  const s = await db.notificationSettings.findFirst()
  if (!s?.zulipSite || !s.zulipBotEmail) return { ok: false, error: 'Najpierw zapisz adres Zulipa i adres bota' }
  const route = routesOf(s.routes)[group]
  if (!route) return { ok: false, error: 'Ta grupa nie ma strumienia' }
  let site: string
  try {
    site = parseZulipSite(s.zulipSite, env)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  const apiKey = (await resolveSecrets(db, [ZULIP_KEY], { env, envFallback: false }))[ZULIP_KEY]
  if (!apiKey) return { ok: false, error: `Brak klucza bota: sekret firmy ${ZULIP_KEY}` }
  const org = await db.organization.findFirstOrThrow({ select: { id: true, name: true } })
  let publicUrl: string | null = null
  try {
    publicUrl = publicUrlZEnv(env)
  } catch {
    // zły APP_PUBLIC_URL: próba bez linku (worker i tak nie wystartuje z tą wartością)
  }
  const res = await sendZulipMessage({ site, botEmail: s.zulipBotEmail, apiKey }, { stream: route.stream, topic: route.topic, content: testMessage(org.name, publicUrl, now) }, fetchImpl)
  const result: TestResult =
    res.kind === 'SENT'
      ? { ok: true }
      : { ok: false, error: res.kind === 'AUTH' ? `Zulip odrzucił klucz albo bota (${res.error})` : res.kind === 'UNCERTAIN' ? `Wynik nieznany: ${res.error}` : `Nie wysłano: ${res.error}` }
  await db.auditLog.create({ data: { entity: 'NotificationTest', entityId: org.id, actorId, after: { group, stream: route.stream, wynik: result.ok ? 'wysłano' : result.error.slice(0, 200) } } })
  return result
}
