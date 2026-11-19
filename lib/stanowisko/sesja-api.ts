// Sesja i uprawnienie w trasach API stanowiska. Jak requirePermission z lib/panel/kontekst.ts, ale
// zamiast przekierowania i 404 strony zwraca odpowiedź JSON: 401 bez sesji, 404 bez uprawnienia (nie zdradzamy,
// że trasa istnieje). Klient bazy — wyłącznie firmy z sesji (RLS).
import 'server-only'
import { prismaForOrg } from '@/lib/db'
import type { Permission } from '@/lib/auth/uprawnienia'
import { currentSession, type PanelContext } from '@/lib/panel/kontekst'

export async function requirePermissionApi(p: Permission): Promise<PanelContext | Response> {
  const s = await currentSession()
  if (!s) return Response.json({ error: 'Wymagane logowanie' }, { status: 401 })
  // hasło startowe najpierw do zmiany w panelu — API nie jest obejściem przekierowania
  if (s.mustChangePassword) return Response.json({ error: 'Najpierw zmień hasło startowe (Ustawienia → Zespół i dostęp → Zmiana hasła)' }, { status: 403 })
  if (!s.permissions.has('panel.podglad') || !s.permissions.has(p)) return Response.json({ error: 'Nie znaleziono' }, { status: 404 })
  return { ...s, db: prismaForOrg(s.organization.organizationId) }
}
