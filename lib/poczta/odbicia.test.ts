// rozpoznawanie raportów o niedoręczeniu (DSN, RFC 3464). Dane fikcyjne (example.test).
import { describe, expect, it } from 'vitest'
import { rozpoznajOdbicie } from './odbicia'

const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n')

function dsn(p: { action?: string; status?: string; oryginal?: 'naglowki' | 'mail' | 'brak'; id?: string; base64?: boolean } = {}) {
  const pola = crlf(`Reporting-MTA: dns; mx.example.test

Final-Recipient: rfc822; jan.kowalski@example.test
Action: ${p.action ?? 'failed'}
Status: ${p.status ?? '5.1.1'}
Diagnostic-Code: smtp; 550 5.1.1 <jan.kowalski@example.test>: Recipient address rejected: User unknown
`)
  const oryginalNaglowki = crlf(`From: Pracownia <sklep@example.com>
To: jan.kowalski@example.test
Subject: =?UTF-8?Q?Zam=C3=B3wienie?=
Message-ID: <abc123@example.com>
X-Kompletor-Id: ${p.id ?? 'plan:cmw7plan0001'}
`)
  const czescOryginalu =
    p.oryginal === 'brak'
      ? ''
      : p.oryginal === 'mail'
        ? crlf(`--B1
Content-Type: message/rfc822

${oryginalNaglowki}
Treść oryginału
`)
        : crlf(`--B1
Content-Type: text/rfc822-headers

${oryginalNaglowki}`)
  return crlf(`From: MAILER-DAEMON@mx.example.test
To: poczta@example.com
Subject: Undelivered Mail Returned to Sender
Message-ID: <dsn-1@mx.example.test>
MIME-Version: 1.0
Content-Type: multipart/report; report-type=delivery-status;
\tboundary="B1"

--B1
Content-Type: text/plain; charset=utf-8

Nie udało się doręczyć wiadomości.

--B1
Content-Type: message/delivery-status
${p.base64 ? 'Content-Transfer-Encoding: base64\n' : ''}
${p.base64 ? Buffer.from(pola).toString('base64') : pola}
${czescOryginalu}--B1--
`)
}

describe('rozpoznajOdbicie', () => {
  it('raport „failed” z nagłówkami oryginału: klucz wysyłki, Message-ID, adresat, status i diagnoza', () => {
    expect(rozpoznajOdbicie(dsn())).toEqual({
      kompletorId: 'plan:cmw7plan0001',
      messageIds: ['abc123@example.com'],
      adresat: 'jan.kowalski@example.test',
      status: '5.1.1',
      diagnoza: '550 5.1.1 <jan.kowalski@example.test>: Recipient address rejected: User unknown',
    })
  })
  it('oryginał jako message/rfc822 i raport w base64', () => {
    expect(rozpoznajOdbicie(dsn({ oryginal: 'mail' }))).toMatchObject({ kompletorId: 'plan:cmw7plan0001', messageIds: ['abc123@example.com'] })
    expect(rozpoznajOdbicie(dsn({ base64: true }))).toMatchObject({ kompletorId: 'plan:cmw7plan0001', status: '5.1.1' })
  })
  it('„delayed” i „delivered” to nie odbicie; raport bez oryginału nie ma czego dopasować', () => {
    expect(rozpoznajOdbicie(dsn({ action: 'delayed', status: '4.4.1' }))).toBeNull()
    expect(rozpoznajOdbicie(dsn({ action: 'delivered', status: '2.0.0' }))).toBeNull()
    expect(rozpoznajOdbicie(dsn({ oryginal: 'brak' }))).toBeNull()
  })
  it('zwykły mail, odpowiedź klienta albo śmieci = null, bez wyjątku', () => {
    expect(rozpoznajOdbicie(crlf('From: jan@example.test\nSubject: Re: Zamówienie\n\nDziękuję!\n'))).toBeNull()
    expect(rozpoznajOdbicie('')).toBeNull()
    expect(rozpoznajOdbicie('x'.repeat(2_000_001))).toBeNull()
    expect(rozpoznajOdbicie(crlf('Content-Type: multipart/report; boundary="Z"\n\n--Z\nContent-Type: message/delivery-status\n\n\n--Z--\n'))).toBeNull()
  })
  it('klucz wysyłki o nieoczekiwanym kształcie jest odrzucany (treść z zewnątrz)', () => {
    expect(rozpoznajOdbicie(dsn({ id: 'plan:x; DROP TABLE' }))).toMatchObject({ kompletorId: null, messageIds: ['abc123@example.com'] })
  })
})
