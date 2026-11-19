// czytnik odbić na atrapie skrzynki IMAP (port `SkrzynkaImap`), bez sieci i bazy. Raporty o niedoręczeniu
// w kształcie z Postfiksa, Gmaila i Amazon SES; dane fikcyjne (example.com / example.test).
import { describe, expect, it, vi } from 'vitest'
import { BLAD_ZAPISU, LIMIT_PROB, przejrzyjSkrzynke, stanZBazy } from './czytnik-odbic'
import type { MailWSkrzynce, SkrzynkaImap } from './imap'
import { BladPolaczeniaImap, bladFolderu, sprawdzKonfiguracjeImap } from './imap'
import type { Odbicie, WynikOdbicia } from './odbicia'

const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n')

const POSTFIX = crlf(`Return-Path: <>
From: MAILER-DAEMON@mx.example.com (Mail Delivery System)
To: sklep@example.com
Subject: Undelivered Mail Returned to Sender
Auto-Submitted: auto-replied
MIME-Version: 1.0
Content-Type: multipart/report; report-type=delivery-status;
	boundary="8E1F42A0C1.1762700000/mx.example.com"
Message-Id: <20261109120000.8E1F42A0C1@mx.example.com>

This is a MIME-encapsulated message.

--8E1F42A0C1.1762700000/mx.example.com
Content-Description: Notification
Content-Type: text/plain; charset=us-ascii

I'm sorry to have to inform you that your message could not
be delivered to one or more recipients.

--8E1F42A0C1.1762700000/mx.example.com
Content-Description: Delivery report
Content-Type: message/delivery-status

Reporting-MTA: dns; mx.example.com
X-Postfix-Queue-ID: 8E1F42A0C1
X-Postfix-Sender: rfc822; sklep@example.com
Arrival-Date: Mon,  9 Nov 2026 12:59:58 +0100 (CET)

Final-Recipient: rfc822; jan.kowalski@example.test
Original-Recipient: rfc822;jan.kowalski@example.test
Action: failed
Status: 5.1.1
Remote-MTA: dns; mx.example.test
Diagnostic-Code: smtp; 550 5.1.1 <jan.kowalski@example.test>: Recipient address
    rejected: User unknown in virtual mailbox table

--8E1F42A0C1.1762700000/mx.example.com
Content-Description: Undelivered Message Headers
Content-Type: text/rfc822-headers

From: Pracownia <sklep@example.com>
To: jan.kowalski@example.test
Subject: =?UTF-8?Q?Gotowe_do_odbioru?=
Message-ID: <postfix-1@example.com>
X-Kompletor-Id: plan:postfix0001

--8E1F42A0C1.1762700000/mx.example.com--
`)

const GMAIL = crlf(`From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>
To: sklep@example.com
Subject: Delivery Status Notification (Failure)
Auto-Submitted: auto-replied
Message-ID: <gmail-dsn-1@mx.google.com>
MIME-Version: 1.0
Content-Type: multipart/report; boundary="000000000000a1b2c3"; report-type=delivery-status

--000000000000a1b2c3
Content-Type: multipart/related; boundary="000000000000d4e5f6"

--000000000000d4e5f6
Content-Type: text/html; charset="UTF-8"

<html><body>Address not found</body></html>
--000000000000d4e5f6--

--000000000000a1b2c3
Content-Type: message/delivery-status

Reporting-MTA: dns; googlemail.com
Received-From-MTA: dns; sklep@example.com
Arrival-Date: Mon, 09 Nov 2026 04:00:00 -0800 (PST)
X-Original-Message-ID: <gmail-1@example.com>

Final-Recipient: rfc822; anna.nowak@example.test
Action: failed
Status: 5.1.1
Remote-MTA: dns; gmail-smtp-in.l.google.com. (2001:db8::1, the server for the
 domain example.test.)
Diagnostic-Code: smtp; 550-5.1.1 The email account that you tried to reach does
 not exist. Please try double-checking the recipient's email address for typos.
 https://support.google.com/mail/?p=NoSuchUser
Last-Attempt-Date: Mon, 09 Nov 2026 04:00:01 -0800 (PST)

--000000000000a1b2c3
Content-Type: message/rfc822

From: Pracownia <sklep@example.com>
To: anna.nowak@example.test
Subject: Brak =?UTF-8?Q?p=C5=82atno=C5=9Bci?=
Message-ID: <gmail-1@example.com>
X-Kompletor-Id: plan:gmail0001
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8

Treść oryginału
--000000000000a1b2c3--
`)

// SES zmienia Message-ID na swój; dopasowanie po X-Kompletor-Id z nagłówków oryginału
const SES = crlf(`From: MAILER-DAEMON@amazonses.com
To: sklep@example.com
Subject: Delivery Status Notification (Failure)
Message-ID: <0102019a00000000-ses-dsn@eu-central-1.amazonses.com>
MIME-Version: 1.0
Content-Type: multipart/report; report-type=delivery-status;
	boundary="=_ses_boundary_1"

--=_ses_boundary_1
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 7bit

An error occurred while trying to deliver the mail to the following recipients:
piotr@example.test

--=_ses_boundary_1
Content-Type: message/delivery-status; name=details.txt
Content-Disposition: attachment; filename=details.txt
Content-Description: Delivery report

Reporting-MTA: dns; a1-23.smtp-out.eu-central-1.amazonses.com

Final-Recipient: rfc822; piotr@example.test
Action: failed
Status: 5.1.1
Diagnostic-Code: smtp; 550 5.1.1 user unknown

--=_ses_boundary_1
Content-Type: text/rfc822-headers
Content-Description: Undelivered Message Headers

From: Pracownia <sklep@example.com>
To: piotr@example.test
Subject: Wyslane z faktura
Message-ID: <0107019a11111111-ses-oryginal@eu-central-1.amazonses.com>
X-Kompletor-Id: plan:ses0001

--=_ses_boundary_1--
`)

const OPOZNIONY = POSTFIX.replace('Action: failed', 'Action: delayed').replace('Status: 5.1.1', 'Status: 4.4.1')
const ZWYKLY = crlf(`From: Klient <klient@example.test>
To: sklep@example.com
Subject: Pytanie o zamówienie

Dzień dobry, kiedy wyślecie paczkę?
`)

interface MailAtrapy {
  uid: number
  tresc: string
  seen?: boolean
  rozmiar?: number
}

function atrapa(maile: MailAtrapy[], o: { uidValidity?: string; przeniesienie?: boolean } = {}) {
  const odlozone: number[] = []
  const pobrane: number[] = []
  const s: SkrzynkaImap = {
    uidValidity: o.uidValidity ?? '1700000000',
    async nieprzeczytane(odUid, limit): Promise<MailWSkrzynce[]> {
      return maile
        .filter((m) => !m.seen && m.uid > odUid)
        .sort((a, b) => a.uid - b.uid)
        .slice(0, limit)
        .map((m) => ({ uid: m.uid, rozmiar: m.rozmiar ?? Buffer.byteLength(m.tresc) }))
    },
    async pobierz(uid) {
      pobrane.push(uid)
      const m = maile.find((x) => x.uid === uid)
      return m ? Buffer.from(m.tresc) : null
    },
    async odloz(uid) {
      odlozone.push(uid)
      const m = maile.find((x) => x.uid === uid)!
      m.seen = true
      return o.przeniesienie === false ? 'PRZECZYTANY' : 'PRZENIESIONY'
    },
    zamknij: vi.fn(async () => {}),
  }
  return { s, odlozone, pobrane }
}

const nasze = (wyniki: Record<string, WynikOdbicia>) =>
  vi.fn(async (o: Odbicie): Promise<WynikOdbicia> => (o.kompletorId && wyniki[o.kompletorId]) || 'NIEZNANY')

describe('przejrzyjSkrzynke', () => {
  it('raporty z Postfiksa, Gmaila i SES trafiają do przyjmijOdbicie i do podfolderu; zwykły mail i „opóźnione” zostają nietknięte', async () => {
    const { s, odlozone } = atrapa([
      { uid: 11, tresc: POSTFIX },
      { uid: 12, tresc: ZWYKLY },
      { uid: 13, tresc: GMAIL },
      { uid: 14, tresc: OPOZNIONY },
      { uid: 15, tresc: SES },
    ])
    const przyjmij = nasze({ 'plan:postfix0001': 'ZAPISANO', 'plan:gmail0001': 'ZAPISANO', 'plan:ses0001': 'ZAPISANO' })
    const w = await przejrzyjSkrzynke(s, { stan: {}, przyjmij })
    expect(w).toMatchObject({ przejrzane: 5, zapisane: 3, inne: 2, obce: 0, bledy: [] })
    expect(odlozone).toEqual([11, 13, 15])
    expect(w.stan).toEqual({ uidValidity: '1700000000', lastUid: 15 })
    const id = przyjmij.mock.calls.map(([o]) => o.kompletorId)
    expect(id).toEqual(['plan:postfix0001', 'plan:gmail0001', 'plan:ses0001'])
    // Gmail: diagnoza z rozwiniętych linii, adresat z Final-Recipient
    expect(przyjmij.mock.calls[1]![0]).toMatchObject({ status: '5.1.1', adresat: 'anna.nowak@example.test' })
  })

  it('drugi przebieg nie czyta tych samych maili (kursor UID), zmiana UIDVALIDITY = od nowa', async () => {
    const { s, pobrane } = atrapa([{ uid: 3, tresc: ZWYKLY }])
    const w1 = await przejrzyjSkrzynke(s, { stan: {}, przyjmij: nasze({}) })
    const w2 = await przejrzyjSkrzynke(s, { stan: w1.stan, przyjmij: nasze({}) })
    expect(w2.przejrzane).toBe(0)
    expect(pobrane).toEqual([3])
    const inna = atrapa([{ uid: 3, tresc: ZWYKLY }], { uidValidity: '42' })
    const w3 = await przejrzyjSkrzynke(inna.s, { stan: w1.stan, przyjmij: nasze({}) })
    expect(w3.przejrzane).toBe(1)
    expect(w3.stan).toEqual({ uidValidity: '42', lastUid: 3 })
  })

  it('raport o mailu spoza Kompletora zostaje w skrzynce; powtórka (JUZ) idzie do podfolderu; nieudane przeniesienie liczone osobno', async () => {
    const { s, odlozone } = atrapa(
      [
        { uid: 1, tresc: POSTFIX },
        { uid: 2, tresc: GMAIL },
      ],
      { przeniesienie: false },
    )
    const w = await przejrzyjSkrzynke(s, { stan: {}, przyjmij: nasze({ 'plan:gmail0001': 'JUZ' }) })
    expect(w).toMatchObject({ obce: 1, powtorki: 1, bezPrzeniesienia: 1, zapisane: 0 })
    expect(odlozone).toEqual([2])
    expect(w.stan.lastUid).toBe(2)
  })

  it('mail większy niż limit: bez pobierania treści, kursor idzie dalej', async () => {
    const { s, pobrane } = atrapa([
      { uid: 1, tresc: POSTFIX, rozmiar: 3_000_000 },
      { uid: 2, tresc: SES },
    ])
    const w = await przejrzyjSkrzynke(s, { stan: {}, przyjmij: nasze({ 'plan:ses0001': 'ZAPISANO' }) })
    expect(w).toMatchObject({ zaDuze: 1, zapisane: 1 })
    expect(pobrane).toEqual([2])
    expect(w.stan.lastUid).toBe(2)
  })

  it('błąd jednego maila nie zatrzymuje przebiegu; kursor stoi przed nim, a po kolejnych porażkach przechodzi dalej', async () => {
    const maile = [
      { uid: 1, tresc: POSTFIX },
      { uid: 2, tresc: GMAIL },
      { uid: 3, tresc: SES },
    ]
    const przyjmij = vi.fn(async (o: Odbicie): Promise<WynikOdbicia> => {
      if (o.kompletorId === 'plan:gmail0001') throw new Error('baza chwilowo niedostępna')
      return 'ZAPISANO'
    })
    const { s, odlozone } = atrapa(maile)
    const w1 = await przejrzyjSkrzynke(s, { stan: {}, przyjmij, loguj: () => {} })
    expect(w1.zapisane).toBe(2) // 1 i 3 zapisane mimo błędu przy 2
    expect(odlozone).toEqual([1, 3])
    expect(w1.bledy).toHaveLength(1)
    expect(w1.bledy[0]).toContain('mail nr 2')
    expect(w1.stan).toMatchObject({ lastUid: 1, failUid: 2, failCount: 1 })
    let stan = w1.stan
    for (let i = 2; i < LIMIT_PROB; i++) {
      const w = await przejrzyjSkrzynke(s, { stan, przyjmij })
      expect(w.stan).toMatchObject({ lastUid: 1, failUid: 2, failCount: i })
      stan = w.stan
    }
    const ostatni = await przejrzyjSkrzynke(s, { stan, przyjmij })
    expect(ostatni.bledy[0]).toContain('pominięty')
    expect(ostatni.stan).toMatchObject({ lastUid: 2 })
    expect(ostatni.stan.failUid).toBeUndefined()
    // pominięty mail został nietknięty (nieprzeczytany, bez przeniesienia)
    expect(maile[1]).not.toHaveProperty('seen')
  })

  it('udana próba po wcześniejszym błędzie czyści licznik porażek', async () => {
    const { s } = atrapa([{ uid: 5, tresc: SES }])
    const w = await przejrzyjSkrzynke(s, { stan: { uidValidity: '1700000000', lastUid: 4, failUid: 5, failCount: 2 }, przyjmij: nasze({ 'plan:ses0001': 'ZAPISANO' }) })
    expect(w.stan).toEqual({ uidValidity: '1700000000', lastUid: 5, failUid: undefined, failCount: undefined })
  })

  it('zerwane połączenie przerywa przebieg bez liczenia porażki maila; kursor przed tym mailem', async () => {
    const maile = [
      { uid: 1, tresc: POSTFIX },
      { uid: 2, tresc: GMAIL },
      { uid: 3, tresc: SES },
    ]
    const { s, pobrane } = atrapa(maile)
    const pobierz = s.pobierz.bind(s)
    s.pobierz = async (uid) => {
      if (uid === 2) throw new BladPolaczeniaImap('połączenie z serwerem IMAP przerwane')
      return pobierz(uid)
    }
    const stanPrzed = { uidValidity: '1700000000', lastUid: 0, failUid: 2, failCount: 2 }
    const w = await przejrzyjSkrzynke(s, { stan: stanPrzed, przyjmij: nasze({ 'plan:postfix0001': 'ZAPISANO', 'plan:ses0001': 'ZAPISANO' }) })
    expect(w.zapisane).toBe(1)
    expect(pobrane).toEqual([1]) // mail 3 nie był już ruszany
    expect(w.bledy).toHaveLength(1)
    expect(w.bledy[0]).toMatch(/przerwane.*następna próba/)
    // licznik porażek maila 2 bez zmian (2, nie 3 = nie pominięty), kursor na 1
    expect(w.stan).toMatchObject({ lastUid: 1, failUid: 2, failCount: 2 })
    expect(w.bledy[0]).not.toContain('pominięty')
  })

  it('błąd zapisu odbicia = stały tekst w panelu, szczegół tylko do logu workera', async () => {
    const { s } = atrapa([{ uid: 7, tresc: POSTFIX }])
    const loguj = vi.fn()
    const przyjmij = vi.fn(async (): Promise<WynikOdbicia> => {
      throw new Error('Unique constraint failed on SentMail.kompletorId=plan:obcy-identyfikator-z-maila')
    })
    const w = await przejrzyjSkrzynke(s, { stan: {}, przyjmij, loguj })
    expect(w.bledy).toEqual([`mail nr 7: ${BLAD_ZAPISU}`])
    expect(loguj).toHaveBeenCalledTimes(1)
    expect(String(loguj.mock.calls[0]![0])).toContain('obcy-identyfikator')
    // błąd adaptera IMAP (nie zapisu) zostaje opisany jak dotąd
    const b = atrapa([{ uid: 8, tresc: POSTFIX }])
    b.s.pobierz = async () => {
      throw new Error('NO [SERVERBUG] fetch nieudany')
    }
    const w2 = await przejrzyjSkrzynke(b.s, { stan: {}, przyjmij, loguj })
    expect(w2.bledy[0]).toContain('SERVERBUG')
  })

  it('limit maili na przebieg', async () => {
    const { s } = atrapa(Array.from({ length: 8 }, (_, i) => ({ uid: i + 1, tresc: ZWYKLY })))
    const w = await przejrzyjSkrzynke(s, { stan: {}, przyjmij: nasze({}), limit: 5 })
    expect(w.przejrzane).toBe(5)
    expect(w.stan.lastUid).toBe(5)
  })
})

describe('stanZBazy i konfiguracja skrzynki', () => {
  it('stan z bazy odrzuca śmieci', () => {
    expect(stanZBazy(null)).toEqual({ uidValidity: undefined, lastUid: undefined, failUid: undefined, failCount: undefined })
    expect(stanZBazy({ uidValidity: '9', lastUid: -1, failUid: 'x', failCount: 2 })).toEqual({ uidValidity: '9', lastUid: undefined, failUid: undefined, failCount: 2 })
  })

  it('w hostingu tylko publiczny serwer, porty 993/143 i szyfrowanie; folder bez znaków wieloznacznych', () => {
    expect(sprawdzKonfiguracjeImap({ host: 'imap.example.com', port: 993, bezpieczenstwo: 'TLS', folder: 'INBOX' }, { hosting: true })).toEqual([])
    const zle = sprawdzKonfiguracjeImap({ host: '127.0.0.1', port: 25, bezpieczenstwo: 'BRAK', folder: 'INBOX' }, { hosting: true })
    expect(zle.join(' ')).toMatch(/dostępny z internetu/)
    expect(zle.join(' ')).toMatch(/port IMAP: 993, 143/)
    expect(zle.join(' ')).toMatch(/szyfrowane/)
    expect(sprawdzKonfiguracjeImap({ host: '127.0.0.1', port: 1143, bezpieczenstwo: 'BRAK', folder: 'INBOX' }, { hosting: false })).toEqual([])
    expect(sprawdzKonfiguracjeImap({ host: 'https://imap.example.com', port: 993, bezpieczenstwo: 'TLS', folder: 'INBOX' }, { hosting: false })).toHaveLength(1)
    expect(bladFolderu('INBOX/*')).not.toBeNull()
    expect(bladFolderu('Odebrane')).toBeNull()
    expect(bladFolderu(' ')).not.toBeNull()
  })
})
