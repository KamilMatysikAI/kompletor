// Warstwa dostępu do danych panelu. Każdy ekran i każda akcja serwera zaczyna od `requireSession()`:
// bez ważnej sesji → przekierowanie na /logowanie, a klient bazy, który dostaje ekran, jest klientem firmy z sesji
// (RLS) — innej drogi do danych w app/(panel) nie ma (strażnik w tests/panel-dostep.integration.test.ts).
//
// osoba z hasłem startowym (`mustChangePassword`) dostaje od requireSession przekierowanie na
// /ustawienia/haslo — wszędzie poza tym ekranem (i jego akcjami: POST idzie na ten sam adres). Ścieżkę podaje proxy
// w nagłówku PATH_HEADER (nadpisuje wartość od klienta). Wylogowanie (app/akcje.ts) nie woła requireSession.
// przekierowuje tylko STRONA. Layout bierze sesję przez requireLayoutSession (bez przekierowania):
// przekierowanie rzucone w layoucie zostaje w kliencie Next w segmencie layoutu, wspólnym dla wszystkich ekranów, więc
// nawigacja na /ustawienia/haslo (pobiera tylko segment strony) dostawała je z pamięci znowu: ekran pusty, w pętli.
import 'server-only'
import { cookies, headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { cache } from 'react'
import type { MemberRole, PrismaClient } from '@prisma/client'
import { prismaForOrg, systemPrisma } from '@/lib/db'
import { PASSWORD_PATH, PATH_HEADER } from '@/lib/auth/sesja-ciasteczko'
import { resolveSession, SESSION_COOKIE, type SessionContext } from '@/lib/auth/sesje'
import type { Permission } from '@/lib/auth/uprawnienia'
import { invitationInfo, isTokenShape } from '@/lib/auth/zaproszenia'

export interface PanelContext extends SessionContext {
  db: PrismaClient
}

/** Sesja bieżącego żądania albo null (bez przekierowania) — tylko dla strony logowania. */
export const currentSession = cache(async (): Promise<SessionContext | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  return resolveSession(systemPrisma(), token)
})

/** Zalogowana osoba bez wymogu podglądu — tylko dla szkieletu panelu (layout: samo „Wyloguj”). */
export const requireLogin = cache(async (): Promise<SessionContext> => {
  const s = await currentSession()
  if (!s) redirect('/logowanie')
  return s
})

/**
 * Sesja dla LAYOUTU panelu i stanowiska: jak requireSession, ale bez przekierowania hasła startowego.
 * Layout przy `mustChangePassword` rysuje okrojony szkielet; przekierowuje strona (requireSession). Ekrany i akcje
 * zawsze przez requireSession/requirePermission (strażnik w tests/panel-dostep.integration.test.ts).
 */
export const requireLayoutSession = cache(async (): Promise<PanelContext> => {
  const s = await requireLogin()
  // każdy ekran panelu wymaga podglądu (rola bez niego nie widzi niczego; przegląd, drobne 1)
  if (!s.permissions.has('panel.podglad')) notFound()
  return { ...s, db: prismaForOrg(s.organization.organizationId) }
})

export const requireSession = cache(async (): Promise<PanelContext> => {
  const ctx = await requireLayoutSession()
  // hasło startowe najpierw do zmiany (bez pętli: na ekranie hasła nie przekierowujemy; tylko w stronie)
  if (ctx.mustChangePassword && (await headers()).get(PATH_HEADER) !== PASSWORD_PATH) redirect(PASSWORD_PATH)
  return ctx
})

/** Ekran wymagający uprawnienia: brak = 404 (nie zdradzamy, że ekran istnieje). */
export async function requirePermission(p: Permission): Promise<PanelContext> {
  const ctx = await requireSession()
  if (!ctx.permissions.has(p)) notFound()
  return ctx
}

export type InvitationPage = { state: 'ok'; organizationName: string; role: MemberRole } | { state: 'invalid' }

/**
 * Strona /zaproszenie: treść zaproszenia z tokenu, bez sesji. Tylko odczyt (GET niczego nie przyjmuje
 * — skanery linków w poczcie). Bez limitu prób: odczyt niczego nie zgaduje (token ma 256 bitów),
 * odpowiedź to nazwa firmy i rola, a limit per IP liczą akcje przyjęcia (`attemptAccept`) — jedna próba = jedno odliczenie.
 */
export async function invitationForPage(token: string | undefined): Promise<InvitationPage> {
  if (!isTokenShape(token)) return { state: 'invalid' }
  const info = await invitationInfo(systemPrisma(), token)
  return info ? { state: 'ok', ...info } : { state: 'invalid' }
}
