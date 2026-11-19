// Treść wiadomości o alercie. Celowo NIE używa `Alert.message`: komunikaty błędów z zewnątrz
// (FAKTURA_BLAD, KOREKTA_BLAD, BLAD_ZAMOWIENIA, ZAMOWIENIE_KANALU_BLAD) mogą nieść dane nabywcy. Wiadomość to etykieta
// rodzaju, nazwa firmy, `ref` (id techniczne, numer zamówienia albo konto kanału), godzina i link do panelu.
import { kindLabel } from './grupy'

export interface AlertForMessage {
  kind: string
  ref: string
  createdAt: Date
}

const TIME = new Intl.DateTimeFormat('pl-PL', {
  timeZone: 'Europe/Warsaw',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

/** Tekst do Markdownu Zulipa: bez znaków sterujących i znaczników, jedna linia, przycięty. */
export function plain(s: string, max: number): string {
  return s
    .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ' ')
    .replace(/[`*_~|<>[\]()#\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/**
 * `ref` alertu do wiadomości. To identyfikator, ale gdyby kiedyś trafił tu adres e-mail (np. konto kanału nazwane
 * mailem), zostaje ukryty — wiadomość nie może nieść danych osobowych.
 */
export function safeRef(ref: string): string {
  // w `kodzie` Markdown nie działa, więc zostają podkreślenia i ukośniki (konta typu ALLEGRO_SKLEP/12345); znika backtick
  const r = ref
    .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  if (!r) return '—'
  if (r.includes('@')) return '(ukryty)'
  return r
}

export function formatWarsaw(d: Date): string {
  return TIME.format(d).replace(',', '')
}

export function alertMessage(a: AlertForMessage, orgName: string, publicUrl: string | null): string {
  const lines = [`**${kindLabel(a.kind)}** · ${plain(orgName, 80) || 'firma'}`, `Odnośnik: \`${safeRef(a.ref)}\``, `Godzina: ${formatWarsaw(a.createdAt)}`]
  if (publicUrl) lines.push(`[Otwórz panel](${publicUrl}/pulpit)`)
  return lines.join('\n')
}

export function testMessage(orgName: string, publicUrl: string | null, now: Date): string {
  const lines = [`**Wiadomość próbna** · ${plain(orgName, 80) || 'firma'}`, `Powiadomienia Kompletora działają. Godzina: ${formatWarsaw(now)}`]
  if (publicUrl) lines.push(`[Otwórz panel](${publicUrl}/pulpit)`)
  return lines.join('\n')
}
