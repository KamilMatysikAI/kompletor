'use server'
// Asystent „Zapytaj” (dymek na każdym ekranie panelu): pytanie o obsługę, odpowiedź wyłącznie z Pomocy. Dostęp jak do
// panelu (`panel.podglad`); wyłącznik firmy sprawdza jeszcze raz lib/asystent/asystent.ts, więc wyłączony asystent
// nic nie wysyła, nawet gdy ktoś wywoła akcję bez dymka.
import { requirePermission } from '@/lib/panel/kontekst'
import { zapytajAsystenta, type WynikAsystenta } from '@/lib/asystent/asystent'

export async function zapytajAsystentaAkcja(pytanie: string, sciezka: string): Promise<WynikAsystenta> {
  const ctx = await requirePermission('panel.podglad')
  return zapytajAsystenta(ctx.db, {
    pytanie: String(pytanie ?? '').slice(0, 2000),
    sciezka: String(sciezka ?? '').slice(0, 300),
    kto: { osoba: ctx.user.id, firma: ctx.organization.organizationId },
  })
}
