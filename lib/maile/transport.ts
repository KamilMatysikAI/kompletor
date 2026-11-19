// Transport maili: SMTP firmy przez nodemailer. Amazon SES, Google Workspace, home.pl i każdy inny
// dostawca idą tą samą drogą (punkt SMTP dostawcy). Moduł nie zna bazy: dostaje konfigurację i gotowy mail
// (lib/maile/mail.ts), zwraca wynik jako rodzaj, z którego wysyłka (lib/poczta/wysylka.ts) wybiera dalszy krok.
//
// Rodzaje wyniku (jak Zulip w lib/powiadomienia/zulip.ts): SENT; RETRY = serwer na pewno nie przyjął treści (brak
// połączenia, 4xx, odmowa przed DATA), można ponowić; REJECTED = serwer odrzucił na stałe (5xx, np. nieistniejący
// adresat); AUTH = login albo hasło odrzucone (530/534/535), wysyłka firmy do naprawy; UNCERTAIN = połączenie zerwane
// po wysłaniu treści, mail mógł dojść, więc bez ponowienia (spam gorszy niż brak maila).
//
// Bezpieczeństwo: nodemailer bez dostępu do plików i adresów URL w treści (`disableFileAccess`, `disableUrlAccess`);
// w hostingu serwer SMTP musi być publiczny (bez 127.0.0.1, sieci prywatnych i portów spoza listy), żeby formularz
// firmy nie był furtką do usług na serwerze Kompletora.
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import nodemailer from 'nodemailer'
import type { Logger } from 'nodemailer/lib/shared'
import type { GotowyMail } from './typy'

export const BEZPIECZENSTWO = ['STARTTLS', 'TLS', 'BRAK'] as const
export type Bezpieczenstwo = (typeof BEZPIECZENSTWO)[number]

export const ETYKIETA_BEZPIECZENSTWA: Record<Bezpieczenstwo, string> = {
  STARTTLS: 'STARTTLS (zwykle port 587)',
  TLS: 'SSL/TLS od początku (zwykle port 465)',
  BRAK: 'bez szyfrowania (tylko serwer w tej samej sieci)',
}

/** Porty SMTP dozwolone w hostingu (submission, SMTPS, port zapasowy dostawców, 25). */
export const PORTY_HOSTINGU: readonly number[] = [25, 465, 587, 2525]

export const SMTP_TIMEOUT_MS = 20_000

export interface KonfiguracjaSmtp {
  host: string
  port: number
  bezpieczenstwo: Bezpieczenstwo
  login: string | null
  haslo: string | null
  /** nadawca koperty (MAIL FROM, Return-Path), na który wracają raporty o niedoręczeniu; puste = adres nadawcy. */
  adresOdbic?: string | null
}

export interface Koperta {
  od: { email: string; nazwa?: string | null }
  do: string
  odpowiedzDo?: string | null
  /** Nagłówek X-Kompletor-Id: klucz zdarzenia (bez danych klienta), pomaga szukać maila u dostawcy. */
  id?: string | null
}

export type WynikSmtp =
  | { kind: 'SENT'; messageId: string | null }
  | { kind: 'RETRY'; error: string }
  | { kind: 'REJECTED'; error: string }
  | { kind: 'AUTH'; error: string }
  /**
   * serwer odmawia 5xx przed adresatem (EHLO, STARTTLS, MAIL FROM, „Authentication
   * required”, „Must issue STARTTLS first”, nadawca nie należy do konta). Wina ustawień poczty, nie adresata: jak AUTH,
   * mail wraca do kolejki po naprawie, bez alertu o adresacie.
   */
  | {
      kind: 'KONFIGURACJA'
      error: string
      /** odmowa na powitaniu albo EHLO, czyli dla samego połączenia (adres IP), nie dla ustawień konta. */
      polaczenie?: true
    }
  | { kind: 'UNCERTAIN'; error: string }

export interface TransportPoczty {
  wyslij(mail: GotowyMail, koperta: Koperta): Promise<WynikSmtp>
}

export class BladKonfiguracjiPoczty extends Error {}

// ─── Walidacja ─────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/u

/** Adres e-mail do koperty: jedna linia, bez nawiasów i przecinków (bez wstrzyknięcia listy adresatów). */
export function poprawnyAdres(v: string | null | undefined): v is string {
  return typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v)
}

export const HOST_RE = /^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/

/**
 * Literał IPv6 rozwinięty do 8 grup 16-bitowych: porównujemy liczby, nie tekst, więc zapisy
 * `0:0:0:0:0:0:0:1`, `::0001`, `0:0:0:0:0:ffff:7f00:1` i `::ffff:127.0.0.1` znaczą to samo. Strefa (`%eth0`) odcięta.
 * null = to nie jest poprawny literał IPv6.
 */
export function grupyIpv6(host: string): number[] | null {
  let s = host.trim().toLowerCase()
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  s = s.split('%')[0]!
  if (isIP(s) !== 6) return null
  const ogon: number[] = []
  const v4 = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s)
  if (v4) {
    const o = v4[2]!.split('.').map(Number)
    ogon.push(((o[0]! << 8) | o[1]!) & 0xffff, ((o[2]! << 8) | o[3]!) & 0xffff)
    s = v4[1]!.endsWith('::') ? v4[1]! : v4[1]!.slice(0, -1)
  }
  const czesci = s.split('::')
  if (czesci.length > 2) return null
  const naGrupy = (t: string) => (t ? t.split(':').map((g) => parseInt(g, 16)) : [])
  const lewa = naGrupy(czesci[0]!)
  const prawa = [...(czesci.length === 2 ? naGrupy(czesci[1]!) : []), ...ogon]
  const zera = 8 - lewa.length - prawa.length
  if (czesci.length === 1 ? zera !== 0 : zera < 0) return null
  const g = [...lewa, ...Array<number>(Math.max(zera, 0)).fill(0), ...prawa]
  return g.length === 8 && g.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? g : null
}

function prywatnyIpv6(g: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5] = g as [number, number, number, number, number, number]
  const zeroDo = (n: number) => g.slice(0, n).every((x) => x === 0)
  return (
    zeroDo(6) || // ::, ::1 i przestarzałe IPv4-compatible ::a.b.c.d
    (zeroDo(5) && g5 === 0xffff) || // IPv4 mapowane ::ffff:a.b.c.d (w każdym zapisie)
    (zeroDo(4) && g4 === 0xffff && g5 === 0) || // ::ffff:0:a.b.c.d (SIIT)
    (g0 === 0x64 && g1 === 0xff9b && (g2 === 0 || g2 === 1)) || // NAT64 64:ff9b::/96 i 64:ff9b:1::/48
    (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) || // 100::/64 (pula „tylko do odrzucania”)
    (g0 === 0x2001 && g1 === 0) || // Teredo 2001::/32 (adres IPv4 w środku)
    (g0 === 0x2001 && g1 === 0xdb8) || // dokumentacja
    g0 === 0x2002 || // 6to4 2002::/16 (adres IPv4 w środku, także prywatny)
    (g0 & 0xfe00) === 0xfc00 || // fc00::/7 unikalne lokalne
    (g0 >= 0xfe80 && g0 <= 0xfeff) || // fe80::/10 link-local i fec0::/10 site-local
    g0 >= 0xff00 // multicast
  )
}

export function prywatnyAdresIp(hostWe: string): boolean {
  // nawiasy literału IPv6 zdejmowane na wejściu, jak w `grupyIpv6` ([::1] =::1)
  let host = hostWe.trim()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  const v = isIP(host.split('%')[0]!)
  if (v === 4) {
    const [a, b, c] = host.split('.').map(Number) as [number, number, number]
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) || // 192.0.0.0/24 (IETF), 192.0.2.0/24 (dokumentacja)
      (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 (testy wydajności)
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224 // 224.0.0.0/4 multicast, 240.0.0.0/4 zarezerwowane, 255.255.255.255
    )
  }
  if (v === 6) {
    const g = grupyIpv6(host)
    return g ? prywatnyIpv6(g) : true // nieczytelny literał IPv6 = nie ryzykujemy
  }
  return false
}

export const LOKALNE_NAZWY = /^(localhost|.*\.localhost|.*\.local|.*\.internal|host\.docker\.internal)$/i

/**
 * Sprawdza konfigurację z formularza albo bazy. `hosting` = APP_MODE=hosted: tylko publiczny serwer, porty z listy,
 * bez trybu „bez szyfrowania”. Zwraca listę błędów po polsku (pusta = poprawna).
 */
export function sprawdzKonfiguracje(k: { host: string; port: number; bezpieczenstwo: string }, o: { hosting: boolean }): string[] {
  const bledy: string[] = []
  const host = k.host.trim()
  if (!host) bledy.push('Podaj adres serwera SMTP')
  else if (!(isIP(host) || HOST_RE.test(host))) bledy.push('Adres serwera SMTP: sama nazwa serwera, np. smtp.firma.pl (bez http:// i bez portu)')
  if (!Number.isInteger(k.port) || k.port < 1 || k.port > 65535) bledy.push('Port SMTP: liczba od 1 do 65535')
  if (!(BEZPIECZENSTWO as readonly string[]).includes(k.bezpieczenstwo)) bledy.push('Wybierz szyfrowanie połączenia')
  if (o.hosting && host) {
    if (prywatnyAdresIp(host) || LOKALNE_NAZWY.test(host)) bledy.push('W hostingu serwer SMTP musi być dostępny z internetu (bez adresów lokalnych i prywatnych)')
    if (Number.isInteger(k.port) && !PORTY_HOSTINGU.includes(k.port)) bledy.push(`W hostingu port SMTP: ${PORTY_HOSTINGU.join(', ')}`)
    if (k.bezpieczenstwo === 'BRAK') bledy.push('W hostingu połączenie z serwerem SMTP musi być szyfrowane')
  }
  return bledy
}

/** Zamaskowany adres do panelu i logów: „j***@example.com”. Pełnego adresu klienta nie zapisujemy. */
export function maskujAdres(email: string): string {
  const at = email.lastIndexOf('@')
  if (at < 1) return '***'
  return `${email[0]}***${email.slice(at)}`
}

/** Nazwa pliku załącznika: bez znaków sterujących (CR/LF), cudzysłowów i ukośników, najwyżej 150 znaków. */
export function nazwaZalacznika(s: string | null | undefined): string {
  const n = (s ?? '').replace(/[\u0000-\u001f\u007f"\\/]+/g, ' ').replace(/\s+/g, ' ').trim()
  return n ? n.slice(0, 150) : 'zalacznik'
}

/** Nazwa nadawcy do nagłówka From: jedna linia, bez cudzysłowów i nawiasów ostrych. */
function nazwaNadawcy(s: string | null | undefined): string | undefined {
  const n = (s ?? '').replace(/[\u0000-\u001f\u007f"<>]+/g, ' ').replace(/\s+/g, ' ').trim()
  return n ? n.slice(0, 100) : undefined
}

// ─── Wynik ────────────────────────────────────────────────────────────────

type BladNodemailera = Error & { code?: string; responseCode?: number; command?: string; response?: string }

const PRZED_TRESCIA = /^(CONN|EHLO|HELO|LHLO|STARTTLS|AUTH|MAIL FROM|RCPT TO)/i
/** Polecenia przed adresatem: odmowa 5xx tutaj dotyczy ustawień poczty (nadawca, szyfrowanie, logowanie), nie adresata. */
const PRZED_ADRESATEM = /^(CONN|EHLO|HELO|LHLO|STARTTLS|MAIL FROM)/i
/**
 * Odpowiedzi 5xx, które mówią o logowaniu albo szyfrowaniu po stronie nadawcy, niezależnie od polecenia (część serwerów
 * odmawia dopiero przy RCPT TO). Celowo bez ogólnego „TLS required”: przy RCPT TO tak odpowiada też serwer odbiorcy
 * wymagający szyfrowania (MTA-STS), a to sprawa jednego adresata, nie ustawień firmy. Odmowa przekazania („Relay
 * access denied”, „Unable to relay”) zawsze dotyczy nas: łączymy się tylko z serwerem nadawczym
 * firmy, więc to brak logowania albo nadawca spoza konta. Bez ogólnego „relay” (pojawia się też w kodach odbiorców).
 */
const ODMOWA_USTAWIEN = /(authentication (is )?required|must (issue a starttls|authenticate)|relay(ing)?( access)? denied|unable to relay|not permitted to relay|relay not permitted)/i
/** 5xx na powitaniu albo EHLO: serwer odmawia samego połączenia (zwykle adres IP serwera Kompletora poza listą dozwolonych albo na czarnej liście). */
const POLACZENIE = /^(CONN|EHLO|HELO|LHLO)/i
const SIEC = new Set(['ECONNECTION', 'EDNS', 'ETLS', 'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET', 'EPROTOCOL'])

const ADRES_W_TEKSCIE = /[^\s<>"'(),;:[\]]+@[^\s<>"'(),;:[\]]+/gu

/** Każdy adres e-mail w tekście zamaskowany (`j***@example.com`); maska maski daje to samo. */
export function maskujAdresyWTekscie(msg: string): string {
  return msg.replace(ADRES_W_TEKSCIE, (a) => maskujAdres(a))
}

/**
 * Błąd do zapisu: bez hasła (na wszelki wypadek wycinane), bez pełnych adresów e-mail (serwery SMTP odbijają adres
 * adresata w odpowiedzi, np. „550 5.1.1 <jan@…>: User unknown”, a błąd idzie do bazy, alertów i panelu), jedna
 * linia, przycięty. `adresy` = znane adresy z koperty, maskowane także wtedy, gdy wzorzec by ich nie złapał.
 */
export function bezpiecznyBlad(msg: string, haslo: string | null, adresy: readonly (string | null | undefined)[] = []): string {
  let m = msg
  if (haslo && haslo.length >= 4) m = m.split(haslo).join('***')
  for (const a of adresy) if (a && a.length >= 3) m = m.split(a).join(maskujAdres(a))
  return maskujAdresyWTekscie(m).replace(/\s+/g, ' ').trim().slice(0, 300)
}

/**
 * `poTresci` = serwer odpowiedział 354 na DATA, czyli treść maila zaczęła płynąć. Nodemailer przy zerwaniu połączenia
 * w tym momencie podaje `command: 'CONN'`, więc bez tej flagi zerwanie po wysłaniu treści wyglądałoby na błąd
 * połączenia do ponowienia (dubel maila u klienta).
 */
export function klasyfikujBlad(e: unknown, haslo: string | null = null, poTresci = false, adresy: readonly (string | null | undefined)[] = []): WynikSmtp {
  const err = (e instanceof Error ? e : new Error(String(e))) as BladNodemailera
  const kod = err.responseCode
  const opis = bezpiecznyBlad(`${kod ? `${kod} ` : ''}${err.response ?? err.message}`, haslo, adresy)
  // treść już poszła (354): odpowiedź na końcową kropkę 5xx = odrzucony, 4xx = nieprzyjęty, brak odpowiedzi = niepewne
  // (przed sprawdzeniem logowania, żeby kod 53x po treści nie wyłączał poczty firmy)
  if (poTresci) {
    if (typeof kod === 'number' && kod >= 500) return { kind: 'REJECTED', error: opis }
    if (typeof kod === 'number' && kod >= 400) return { kind: 'RETRY', error: opis }
    return { kind: 'UNCERTAIN', error: opis }
  }
  const cmd = err.command ?? ''
  // 530 poza poleceniem AUTH to „Authentication required” / „Must issue STARTTLS” (brak logowania albo szyfrowania), nie złe hasło
  if (err.code === 'EAUTH' || kod === 534 || kod === 535 || (kod === 530 && /^AUTH/i.test(cmd))) return { kind: 'AUTH', error: opis }
  if (typeof kod === 'number' && kod >= 500 && (kod === 530 || PRZED_ADRESATEM.test(cmd) || ODMOWA_USTAWIEN.test(err.response ?? err.message)))
    return POLACZENIE.test(cmd) ? { kind: 'KONFIGURACJA', error: opis, polaczenie: true } : { kind: 'KONFIGURACJA', error: opis }
  if (typeof kod === 'number' && kod >= 500) return { kind: 'REJECTED', error: opis }
  if (typeof kod === 'number' && kod >= 400) return { kind: 'RETRY', error: opis }
  if (PRZED_TRESCIA.test(cmd)) return { kind: 'RETRY', error: opis }
  if (SIEC.has(err.code ?? '') && cmd !== 'DATA') return { kind: 'RETRY', error: opis }
  // timeout albo zerwanie w trakcie albo po wysłaniu treści: serwer mógł mail przyjąć
  return { kind: 'UNCERTAIN', error: opis }
}

// ─── Transport ────────────────────────────────────────────────────────────

/** `tylkoPubliczne` (hosting): połączenie tylko z publicznym adresem IP po rozwiązaniu nazwy. */
export function transportSmtp(cfg: KonfiguracjaSmtp, o: { timeoutMs?: number; tylkoPubliczne?: boolean } = {}): TransportPoczty {
  const timeout = o.timeoutMs ?? SMTP_TIMEOUT_MS
  return {
    async wyslij(mail, k) {
      if (!poprawnyAdres(k.do)) return { kind: 'REJECTED', error: 'niepoprawny adres odbiorcy' }
      if (!poprawnyAdres(k.od.email)) return { kind: 'REJECTED', error: 'niepoprawny adres nadawcy' }
      if (k.odpowiedzDo && !poprawnyAdres(k.odpowiedzDo)) return { kind: 'REJECTED', error: 'niepoprawny adres do odpowiedzi' }
      // śledzenie rozmowy tylko po to, by wiedzieć, czy treść już poszła (354); nic z niej nie jest zapisywane
      let poTresci = false
      const nic = () => {}
      const logger: Logger = {
        trace: nic,
        info: nic,
        warn: nic,
        error: nic,
        fatal: nic,
        debug: (...p: unknown[]) => {
          const [meta, msg] = p as [{ tnx?: string } | undefined, unknown]
          if (meta?.tnx === 'server' && typeof msg === 'string' && /^354\b/.test(msg)) poTresci = true
        },
      }
      // hosting: nazwa serwera musi wskazywać adres publiczny (bez furtki do usług na serwerze Kompletora przez DNS);
      // łączymy się z tym samym, sprawdzonym adresem, a nazwa zostaje do weryfikacji certyfikatu TLS
      let adres = cfg.host
      if (o.tylkoPubliczne) {
        let ip: string
        try {
          ip = isIP(cfg.host) ? cfg.host : (await lookup(cfg.host)).address
        } catch (e) {
          return { kind: 'RETRY', error: bezpiecznyBlad(`nie znaleziono serwera ${cfg.host}: ${e instanceof Error ? e.message : String(e)}`, null) }
        }
        if (prywatnyAdresIp(ip)) return { kind: 'REJECTED', error: `serwer ${cfg.host} wskazuje adres lokalny albo prywatny` }
        adres = ip
      }
      const t = nodemailer.createTransport({
        host: adres,
        tls: adres !== cfg.host ? { servername: cfg.host } : undefined,
        port: cfg.port,
        secure: cfg.bezpieczenstwo === 'TLS',
        requireTLS: cfg.bezpieczenstwo === 'STARTTLS',
        ignoreTLS: cfg.bezpieczenstwo === 'BRAK',
        auth: cfg.login ? { user: cfg.login, pass: cfg.haslo ?? '' } : undefined,
        connectionTimeout: timeout,
        greetingTimeout: timeout,
        socketTimeout: timeout,
        disableFileAccess: true,
        disableUrlAccess: true,
        logger,
        debug: true,
      })
      try {
        const info = await t.sendMail({
          from: { name: nazwaNadawcy(k.od.nazwa) ?? '', address: k.od.email },
          to: k.do,
          envelope: cfg.adresOdbic && poprawnyAdres(cfg.adresOdbic) ? { from: cfg.adresOdbic, to: [k.do] } : undefined,
          replyTo: k.odpowiedzDo ?? undefined,
          subject: mail.temat,
          text: mail.tekst,
          html: mail.html,
          headers: k.id ? { 'X-Kompletor-Id': k.id.replace(/[^\w:.-]/g, '').slice(0, 100) } : undefined,
          attachments: mail.zalaczniki.map((z) => ({ filename: nazwaZalacznika(z.nazwaPliku), content: Buffer.from(z.tresc), contentType: z.typMime, ...(z.cid ? { cid: z.cid, contentDisposition: 'inline' as const } : {}) })),
          disableFileAccess: true,
          disableUrlAccess: true,
        })
        const rejected = (info.rejected ?? []).length
        if (rejected) return { kind: 'REJECTED', error: bezpiecznyBlad(`serwer odrzucił adresata: ${info.response ?? ''}`, cfg.haslo, [k.do]) }
        return { kind: 'SENT', messageId: typeof info.messageId === 'string' ? info.messageId.slice(0, 200) : null }
      } catch (e) {
        return klasyfikujBlad(e, cfg.haslo, poTresci, [k.do, k.odpowiedzDo])
      } finally {
        t.close()
      }
    },
  }
}
