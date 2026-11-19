// Odbicia asynchroniczne (reszta pkt 4). Odmowę w trakcie rozmowy SMTP łapie transport
// (REJECTED → alert). Odbicie, które serwer adresata odsyła później (raport doręczenia DSN, RFC 3464: multipart/report
// z częścią message/delivery-status) trafia na adres nadawcy koperty (Return-Path). Ten moduł rozpoznaje taki raport
// i zapisuje go przy wysłanym mailu: stan ODBITY, powód w panelu (Ustawienia → Poczta → Ostatnie maile), alert do biura.
//
// Decyzja techniczna (R28, wariant 0 zł): odbicia czytamy ze skrzynki nadawcy przez IMAP (działa z każdym dostawcą
// poczty, także z Amazon SES, który odsyła DSN na adres nadawcy koperty), nie przez płatne albo dostawcowe
// powiadomienia (SES/SNS). Czytnik skrzynki to osobne zadanie: dostaje surowy mail i woła
// `przyjmijOdbicie`. Bez czytnika moduł można zasilić ręcznie (CLI, test), stąd czysta funkcja i zapis bez sieci.
//
// Dopasowanie: nagłówek X-Kompletor-Id z oryginału (= MailDelivery.dedupeKey, bez danych klienta), zapasowo Message-ID
// oryginału (= MailDelivery.messageId). Raport „delayed” (serwer jeszcze próbuje) i „delivered” niczego nie zmieniają.
// Treść raportu to dane z zewnątrz: do bazy i alertu idzie tylko kod statusu i przycięta diagnoza z maską adresów.
import type { PrismaClient } from '@prisma/client'
import { maskujAdres, maskujAdresyWTekscie } from '../maile/transport'
import { alert } from '../rdzen/stan'
import { NAZWA_SZABLONU } from './szablony'
import { STAN_ODBITY } from './wysylka'

export const ALERT_ODBICIE = 'POCZTA_ODBICIE'
export { STAN_ODBITY }

export interface Odbicie {
  /** X-Kompletor-Id oryginału (klucz wpisu wysyłki), gdy raport zawiera nagłówki oryginału. */
  kompletorId: string | null
  /** Message-ID z nagłówków oryginału (bez nawiasów ostrych). */
  messageIds: string[]
  adresat: string | null
  /** Kod rozszerzony, np. 5.1.1. */
  status: string | null
  diagnoza: string | null
}

const MAX_SUROWY = 2_000_000

/** Nagłówki części: rozwinięte linie, klucze małymi literami (pierwsze wystąpienie). */
function naglowki(blok: string): Map<string, string> {
  const m = new Map<string, string>()
  for (const l of blok.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = l.indexOf(':')
    if (i <= 0) continue
    const k = l.slice(0, i).trim().toLowerCase()
    if (!m.has(k)) m.set(k, l.slice(i + 1).trim())
  }
  return m
}

function rozdziel(surowy: string): { glowa: string; cialo: string } {
  const i = surowy.search(/\r?\n\r?\n/)
  if (i < 0) return { glowa: surowy, cialo: '' }
  const sep = /\r?\n\r?\n/.exec(surowy.slice(i))![0]
  return { glowa: surowy.slice(0, i), cialo: surowy.slice(i + sep.length) }
}

const parametr = (ct: string, nazwa: string) => new RegExp(`${nazwa}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(ct)

interface Czesc {
  typ: string
  naglowki: Map<string, string>
  tresc: string
}

/** Płaska lista części MIME (rekurencyjnie, najwyżej 4 poziomy); treść base64 / quoted-printable zdekodowana. */
function czesci(surowy: string, glebokosc = 0): Czesc[] {
  const { glowa, cialo } = rozdziel(surowy)
  const h = naglowki(glowa)
  const ct = h.get('content-type') ?? 'text/plain'
  const typ = ct.split(';')[0]!.trim().toLowerCase()
  const cte = (h.get('content-transfer-encoding') ?? '').toLowerCase()
  let tresc = cialo
  if (cte === 'base64') tresc = Buffer.from(cialo.replace(/\s+/g, ''), 'base64').toString('utf8')
  else if (cte === 'quoted-printable') tresc = cialo.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, x: string) => String.fromCharCode(parseInt(x, 16)))
  const out: Czesc[] = [{ typ, naglowki: h, tresc }]
  if (glebokosc >= 4) return out
  const granica = typ.startsWith('multipart/') ? parametr(ct, 'boundary') : null
  const b = granica ? (granica[1] ?? granica[2]) : null
  if (b) {
    const kawalki = tresc.split(`--${b}`)
    for (const k of kawalki.slice(1)) {
      if (k.startsWith('--')) break
      out.push(...czesci(k.replace(/^\r?\n/, ''), glebokosc + 1))
    }
  } else if (typ === 'message/rfc822') out.push(...czesci(tresc, glebokosc + 1))
  return out
}

/** Pola raportu doręczenia: bloki rozdzielone pustą linią, pierwszy to pola wiadomości, kolejne per adresat. */
function polaRaportu(tresc: string): Map<string, string>[] {
  return tresc
    .split(/\r?\n\r?\n/)
    .map((b) => naglowki(b))
    .filter((m) => m.size > 0)
}

const bezNawiasow = (v: string) => v.trim().replace(/^<|>$/g, '')
const typAdresu = (v: string | undefined) => (v ? (v.includes(';') ? v.slice(v.indexOf(';') + 1) : v).trim() : null)

/**
 * Raport o nieudanym doręczeniu (DSN „failed”) albo null: zwykły mail, odpowiedź klienta, raport „delayed” /
 * „delivered”, raport bez rozpoznawalnego adresata. Nie rzuca na złej treści.
 */
export function rozpoznajOdbicie(surowy: string): Odbicie | null {
  if (!surowy || surowy.length > MAX_SUROWY) return null
  let wszystkie: Czesc[]
  try {
    wszystkie = czesci(surowy)
  } catch {
    return null
  }
  const raport = wszystkie.find((c) => c.typ === 'message/delivery-status' || c.typ === 'message/global-delivery-status')
  if (!raport) return null
  const bloki = polaRaportu(raport.tresc)
  const nieudany = bloki.find((m) => (m.get('action') ?? '').toLowerCase() === 'failed')
  if (!nieudany) return null
  // nagłówki oryginału: część text/rfc822-headers albo message/rfc822 (jej pierwsza część po rozbiciu)
  const idx = wszystkie.indexOf(raport)
  const oryginal = wszystkie.slice(idx + 1).filter((c) => c.typ === 'text/rfc822-headers' || c.typ === 'message/rfc822' || c.typ === 'text/plain')
  let kompletorId: string | null = null
  const messageIds: string[] = []
  for (const c of oryginal) {
    const h = c.typ === 'text/rfc822-headers' ? naglowki(c.tresc) : c.typ === 'message/rfc822' ? naglowki(rozdziel(c.tresc).glowa) : c.naglowki
    const id = h.get('x-kompletor-id')
    if (id && !kompletorId && /^[\w:.-]{1,100}$/.test(id.trim())) kompletorId = id.trim()
    const mid = h.get('message-id')
    if (mid) messageIds.push(bezNawiasow(mid))
  }
  const oryg = bloki[0]?.get('original-envelope-id')
  if (!kompletorId && oryg && /^[\w:.-]{1,100}$/.test(oryg.trim())) kompletorId = oryg.trim()
  if (!kompletorId && !messageIds.length) return null
  const status = /^\d\.\d{1,3}\.\d{1,3}/.exec((nieudany.get('status') ?? '').trim())?.[0] ?? null
  const diagnoza = typAdresu(nieudany.get('diagnostic-code'))
  return { kompletorId, messageIds: [...new Set(messageIds)].slice(0, 5), adresat: typAdresu(nieudany.get('final-recipient') ?? nieudany.get('original-recipient')), status, diagnoza }
}

export type WynikOdbicia = 'ZAPISANO' | 'JUZ' | 'NIEZNANY' | 'POMINIETY'

const opisRodzaju = (kind: string) => (kind in NAZWA_SZABLONU ? NAZWA_SZABLONU[kind as keyof typeof NAZWA_SZABLONU] : kind === 'test' ? 'Mail próbny' : kind)

/**
 * Zapis odbicia przy wpisie wysyłki firmy (klient firmy, RLS: obca firma nie znajdzie wpisu). Tylko wpis SENT albo
 * UNCERTAIN przechodzi w ODBITY; drugi raport tego samego maila = JUZ. Alert do biura z maską adresu.
 */
export async function przyjmijOdbicie(db: PrismaClient, o: Odbicie): Promise<WynikOdbicia> {
  const lub = [...(o.kompletorId ? [{ dedupeKey: o.kompletorId }] : []), ...(o.messageIds.length ? [{ messageId: { in: o.messageIds.flatMap((m) => [m, `<${m}>`]) } }] : [])]
  if (!lub.length) return 'NIEZNANY'
  const d = await db.mailDelivery.findFirst({ where: { OR: lub }, orderBy: { createdAt: 'desc' }, select: { id: true, kind: true, state: true, recipient: true, plannedActionId: true } })
  if (!d) return 'NIEZNANY'
  if (d.state === STAN_ODBITY) return 'JUZ'
  if (d.state !== 'SENT' && d.state !== 'UNCERTAIN') return 'POMINIETY'
  // raport z adresatem innym niż ten, do którego mail wyszedł (maska z wpisu), to nie nasze odbicie
  // (np. spreparowany raport odesłany przez kogoś, kto zna identyfikator z otrzymanego maila)
  if (o.adresat && d.recipient && maskujAdres(o.adresat.replace(/^<|>$/g, '').trim()).toLowerCase() !== d.recipient.toLowerCase()) return 'POMINIETY'
  // treść raportu to dane z zewnątrz: bez adresów stron (URL) w powodzie i alercie
  const diagnoza = o.diagnoza?.replace(/https?:\/\/\S+/gi, '[adres strony]') ?? null
  const powod = maskujAdresyWTekscie(`odbicie po wysłaniu${o.status ? ` (${o.status})` : ''}${diagnoza ? `: ${diagnoza}` : ''}`).replace(/\s+/g, ' ').trim().slice(0, 300)
  const r = await db.mailDelivery.updateMany({ where: { id: d.id, state: { in: ['SENT', 'UNCERTAIN'] } }, data: { state: STAN_ODBITY, lastError: powod, nextAttemptAt: null } })
  if (!r.count) return 'JUZ'
  const maska = d.recipient ?? (o.adresat ? maskujAdres(o.adresat) : 'adresata')
  const dalej = d.kind === 'zaproszenie' ? ' Zaproszenie nie doszło: sprawdź adres i zaproś osobę ponownie (Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia).' : ''
  await alert(db, ALERT_ODBICIE, d.plannedActionId ?? d.id, `Mail „${opisRodzaju(d.kind)}” do ${maska} wrócił jako niedoręczony: ${powod}.${dalej}`.slice(0, 500), `poczta:${d.id}:${ALERT_ODBICIE}`)
  return 'ZAPISANO'
}
