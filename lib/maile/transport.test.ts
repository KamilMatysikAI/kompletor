// transport SMTP bez sieci — walidacja konfiguracji (hosting), klasyfikacja błędów, maska adresu.
import { describe, expect, it } from 'vitest'
import { DANE_PRZYKLADOWE, KONTEKST_PRZYKLADOWY } from './przyklady'
import { renderujMail } from './mail'
import { bezpiecznyBlad, klasyfikujBlad, maskujAdres, maskujAdresyWTekscie, nazwaZalacznika, poprawnyAdres, prywatnyAdresIp, sprawdzKonfiguracje, transportSmtp } from './transport'

const blad = (o: { code?: string; responseCode?: number; command?: string; message?: string }) => Object.assign(new Error(o.message ?? 'x'), o)

describe('sprawdzKonfiguracje', () => {
  it('self-host: serwer lokalny i bez szyfrowania dozwolone', () => {
    expect(sprawdzKonfiguracje({ host: '127.0.0.1', port: 2525, bezpieczenstwo: 'BRAK' }, { hosting: false })).toEqual([])
    expect(sprawdzKonfiguracje({ host: 'smtp.firma.pl', port: 587, bezpieczenstwo: 'STARTTLS' }, { hosting: false })).toEqual([])
  })
  it('hosting: tylko publiczny serwer, porty z listy, szyfrowanie', () => {
    expect(sprawdzKonfiguracje({ host: 'smtp.firma.pl', port: 587, bezpieczenstwo: 'STARTTLS' }, { hosting: true })).toEqual([])
    for (const host of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.20.0.1', 'localhost', 'db.internal', '::1']) expect(sprawdzKonfiguracje({ host, port: 587, bezpieczenstwo: 'TLS' }, { hosting: true }).length, host).toBeGreaterThan(0)
    expect(sprawdzKonfiguracje({ host: 'smtp.firma.pl', port: 5432, bezpieczenstwo: 'TLS' }, { hosting: true })).toEqual(['W hostingu port SMTP: 25, 465, 587, 2525'])
    expect(sprawdzKonfiguracje({ host: 'smtp.firma.pl', port: 587, bezpieczenstwo: 'BRAK' }, { hosting: true })).toEqual(['W hostingu połączenie z serwerem SMTP musi być szyfrowane'])
  })
  it('zła nazwa serwera, port i szyfrowanie', () => {
    expect(sprawdzKonfiguracje({ host: 'https://smtp.firma.pl', port: 587, bezpieczenstwo: 'STARTTLS' }, { hosting: false })[0]).toMatch(/bez http/)
    expect(sprawdzKonfiguracje({ host: 'smtp.firma.pl\r\nX', port: 587, bezpieczenstwo: 'STARTTLS' }, { hosting: false }).length).toBe(1)
    expect(sprawdzKonfiguracje({ host: 'smtp.firma.pl', port: 0, bezpieczenstwo: 'STARTTLS' }, { hosting: false })).toEqual(['Port SMTP: liczba od 1 do 65535'])
    expect(sprawdzKonfiguracje({ host: 'smtp.firma.pl', port: 587, bezpieczenstwo: 'SSL3' }, { hosting: false })).toEqual(['Wybierz szyfrowanie połączenia'])
  })
})

describe('klasyfikujBlad', () => {
  it('login odrzucony = AUTH, 5xx = odmowa, 4xx = ponowienie', () => {
    expect(klasyfikujBlad(blad({ code: 'EAUTH', responseCode: 535 })).kind).toBe('AUTH')
    expect(klasyfikujBlad(blad({ code: 'EENVELOPE', responseCode: 550, command: 'RCPT TO' })).kind).toBe('REJECTED')
    expect(klasyfikujBlad(blad({ responseCode: 451, command: 'MAIL FROM' })).kind).toBe('RETRY')
    expect(klasyfikujBlad(blad({ responseCode: 554, command: 'DATA' }), null, true).kind).toBe('REJECTED')
  })
  it('błąd połączenia przed treścią = ponowienie; po odpowiedzi 354 = niepewne (nodemailer podaje wtedy CONN)', () => {
    expect(klasyfikujBlad(blad({ code: 'ECONNECTION', command: 'CONN' })).kind).toBe('RETRY')
    expect(klasyfikujBlad(blad({ code: 'ECONNECTION', command: 'CONN' }), null, true).kind).toBe('UNCERTAIN')
    expect(klasyfikujBlad(blad({ code: 'ETIMEDOUT' })).kind).toBe('UNCERTAIN')
  })
  it('po odpowiedzi 354 kod 53x to odrzucenie treści, nie zły login (poczta firmy zostaje włączona)', () => {
    expect(klasyfikujBlad(blad({ responseCode: 535, command: 'DATA' }), null, true).kind).toBe('REJECTED')
    expect(klasyfikujBlad(blad({ responseCode: 451, command: 'DATA' }), null, true).kind).toBe('RETRY')
  })
  it('5xx przed adresatem albo „Authentication required” / STARTTLS = KONFIGURACJA, nie odmowa adresata', () => {
    const k = (o: Parameters<typeof blad>[0] & { response?: string }) => klasyfikujBlad(Object.assign(blad(o), o.response ? { response: o.response } : {})).kind
    expect(k({ responseCode: 503, command: 'MAIL FROM', response: '503 5.5.1 Error: authentication required' })).toBe('KONFIGURACJA')
    expect(k({ responseCode: 530, command: 'MAIL FROM', response: '530 5.7.0 Must issue a STARTTLS command first' })).toBe('KONFIGURACJA')
    expect(k({ responseCode: 553, command: 'MAIL FROM', response: '553 5.7.1 Sender address rejected: not owned by user' })).toBe('KONFIGURACJA')
    expect(k({ responseCode: 554, command: 'EHLO' })).toBe('KONFIGURACJA')
    expect(k({ responseCode: 530, command: 'RCPT TO', response: '530 5.7.1 Authentication required' })).toBe('KONFIGURACJA')
    expect(k({ responseCode: 550, command: 'RCPT TO', response: '550 5.1.1 User unknown' })).toBe('REJECTED')
    // wymóg szyfrowania po stronie odbiorcy (MTA-STS) dotyczy jednego adresata, nie ustawień firmy
    expect(k({ responseCode: 550, command: 'RCPT TO', response: '550 5.7.10 Recipient domain requires TLS' })).toBe('REJECTED')
    expect(k({ code: 'EAUTH', responseCode: 530, command: 'AUTH PLAIN' })).toBe('AUTH')
    expect(k({ responseCode: 535, command: 'AUTH LOGIN' })).toBe('AUTH')
    // po treści (354) dalej odrzucenie treści, nie ustawienia
    expect(klasyfikujBlad(Object.assign(blad({ responseCode: 530, command: 'DATA' }), { response: 'must issue STARTTLS' }), null, true).kind).toBe('REJECTED')
  })
  it('odmowa przekazania przy RCPT TO = KONFIGURACJA (brak logowania albo nadawca spoza konta), ogólne „relay” u odbiorcy nie', () => {
    const k = (response: string, code = 554) => klasyfikujBlad(Object.assign(blad({ responseCode: code, command: 'RCPT TO' }), { response })).kind
    expect(k('554 5.7.1 <jan@example.test>: Relay access denied')).toBe('KONFIGURACJA') // Postfix
    expect(k('550 5.7.1 Unable to relay', 550)).toBe('KONFIGURACJA') // Exchange
    expect(k('550 relaying denied', 550)).toBe('KONFIGURACJA')
    expect(k('550 5.7.1 Sender not permitted to relay', 550)).toBe('KONFIGURACJA')
    expect(k('550 5.7.1 Relay not permitted', 550)).toBe('KONFIGURACJA')
    // „relay” w innym znaczeniu (np. nazwa serwera odbiorcy) zostaje odmową adresata
    expect(k('550 5.1.1 relay2.example.test: mailbox unavailable', 550)).toBe('REJECTED')
    // po treści (354) dalej odrzucenie treści
    expect(klasyfikujBlad(Object.assign(blad({ responseCode: 554, command: 'DATA' }), { response: 'Relay access denied' }), null, true).kind).toBe('REJECTED')
  })
  it('5xx na powitaniu albo EHLO = KONFIGURACJA z oznaczeniem odmowy połączenia; przy MAIL FROM bez oznaczenia', () => {
    const r = (command: string, response = '554 5.7.1 Access denied') => klasyfikujBlad(Object.assign(blad({ responseCode: 554, command }), { response }))
    expect(r('CONN')).toEqual({ kind: 'KONFIGURACJA', error: expect.any(String), polaczenie: true })
    expect(r('EHLO')).toMatchObject({ kind: 'KONFIGURACJA', polaczenie: true })
    expect(r('MAIL FROM', '553 5.7.1 Sender address rejected')).not.toHaveProperty('polaczenie')
    expect(r('RCPT TO', '554 5.7.1 Relay access denied')).not.toHaveProperty('polaczenie')
  })
  it('adres adresata odbity przez serwer nie trafia do błędu', () => {
    const r = klasyfikujBlad(blad({ code: 'EENVELOPE', responseCode: 550, command: 'RCPT TO', message: 'x' }) as Error & { response?: string }, null, false, ['jan.kowalski@gmail.com'])
    expect(r.kind).toBe('REJECTED')
    const z = klasyfikujBlad(Object.assign(new Error('x'), { code: 'EENVELOPE', responseCode: 550, command: 'RCPT TO', response: '550 5.1.1 <jan.kowalski@gmail.com>: User unknown' }), null, false, ['jan.kowalski@gmail.com'])
    expect(z).toEqual({ kind: 'REJECTED', error: '550 550 5.1.1 <j***@gmail.com>: User unknown' })
    // adres spoza koperty (np. przekierowanie u dostawcy) łapie wzorzec
    expect(bezpiecznyBlad('Recipient address rejected: anna.nowak+sklep@firma.example.pl (forwarded from b@x.pl)', null)).toBe('Recipient address rejected: a***@firma.example.pl (forwarded from b***@x.pl)')
    expect(maskujAdresyWTekscie('wysłano do j***@example.com')).toBe('wysłano do j***@example.com')
  })
  it('nazwa załącznika bez CR/LF, cudzysłowów i ukośników, przycięta', () => {
    expect(nazwaZalacznika('Faktura "FV 1/2026".pdf\r\nBcc: x@example.com')).toBe('Faktura FV 1 2026 .pdf Bcc: x@example.com')
    expect(nazwaZalacznika('a'.repeat(400))).toHaveLength(150)
    expect(nazwaZalacznika('')).toBe('zalacznik')
    expect(nazwaZalacznika('Zażółć.pdf')).toBe('Zażółć.pdf')
  })
  it('hasło wycinane z komunikatu', () => {
    expect(klasyfikujBlad(blad({ message: 'odmowa dla tajneHaslo123' }), 'tajneHaslo123')).toEqual({ kind: 'UNCERTAIN', error: 'odmowa dla ***' })
  })
})

describe('adresy', () => {
  it('maska i poprawność', () => {
    expect(maskujAdres('jan.kowalski@example.test')).toBe('j***@example.test')
    expect(maskujAdres('zly')).toBe('***')
    expect(poprawnyAdres('a@example.com')).toBe(true)
    for (const z of ['a@b', 'a b@example.com', 'a@example.com, c@example.com', 'a@example.com\r\nBcc: x@example.com', '<a@example.com>']) expect(poprawnyAdres(z), z).toBe(false)
  })
  it('adresy prywatne IPv4 i IPv6', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.1.1', '100.64.0.1', '::1', 'fd00::1', '::ffff:127.0.0.1']) expect(prywatnyAdresIp(ip), ip).toBe(true)
    // zakresy specjalne, multicast, zarezerwowane, NAT64
    for (const ip of ['192.0.0.8', '192.0.2.1', '198.18.0.1', '198.19.255.254', '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.1.2.3', '240.0.0.1', '255.255.255.255', '64:ff9b::7f00:1', 'ff02::1', 'fe90::1'])
      expect(prywatnyAdresIp(ip), ip).toBe(true)
    for (const ip of ['8.8.8.8', '2a00:1450::1', '172.32.0.1', '192.0.1.1', '198.20.0.1', '223.255.255.255']) expect(prywatnyAdresIp(ip), ip).toBe(false)
    // literał IPv6 w nawiasach jak bez nich
    for (const ip of ['[::1]', ' [fd00::1] ', '[::ffff:127.0.0.1]']) expect(prywatnyAdresIp(ip), ip).toBe(true)
    expect(prywatnyAdresIp('[2a00:1450::1]')).toBe(false)
  })
  it('IPv6 w zapisie niekanonicznym, 6to4, site-local, IPv4 mapowane w każdym zapisie', () => {
    const prywatne = [
      '0:0:0:0:0:0:0:1',
      '::0001',
      '0000:0000:0000:0000:0000:0000:0000:0001',
      '0:0:0:0:0:0:0:0',
      '0:0:0:0:0:ffff:7f00:1',
      '::ffff:7f00:1',
      '::FFFF:127.0.0.1',
      '0:0:0:0:0:ffff:10.0.0.5',
      '::ffff:0:a00:5',
      '::127.0.0.1',
      '0064:ff9b:0000:0000:0000:0000:7f00:0001',
      '2002:7f00:1::1',
      '2002:c0a8:101::',
      'fec0::1',
      'feff:ffff::1',
      'FE80::1',
      'fe80::1%eth0',
      'FD12:3456::1',
      'ff00::',
      '2001:db8::1',
      '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    ]
    for (const ip of prywatne) expect(prywatnyAdresIp(ip), ip).toBe(true)
    const publiczne = ['2a00:1450:4001:82a::200e', '2A00:1450:4001:082A:0000:0000:0000:200E', '2606:4700:4700::1111', '2001:4860:4860::8888', '2003::1', '64:ff9c::1', 'fe7f::1', '8.8.4.4', '1.1.1.1']
    for (const ip of publiczne) expect(prywatnyAdresIp(ip), ip).toBe(false)
  })
  it('SMTP w hostingu odrzuca niekanoniczny literał pętli zwrotnej', () => {
    for (const host of ['0:0:0:0:0:0:0:1', '::0001', '0:0:0:0:0:ffff:7f00:1'])
      expect(sprawdzKonfiguracje({ host, port: 587, bezpieczenstwo: 'STARTTLS' }, { hosting: true }).join(' '), host).toMatch(/dostępny z internetu/)
  })
  it('hosting: nazwa wskazująca adres lokalny odrzucona przed połączeniem', async () => {
    const m = renderujMail('niski-stan', KONTEKST_PRZYKLADOWY, DANE_PRZYKLADOWE['niski-stan'])
    const r = await transportSmtp({ host: 'localhost', port: 587, bezpieczenstwo: 'STARTTLS', login: null, haslo: null }, { tylkoPubliczne: true }).wyslij(m, { od: { email: 'a@example.com' }, do: 'b@example.com' })
    expect(r).toEqual({ kind: 'REJECTED', error: 'serwer localhost wskazuje adres lokalny albo prywatny' })
  })
  it('zły adresat albo nadawca odrzucony bez połączenia', async () => {
    const m = renderujMail('niski-stan', KONTEKST_PRZYKLADOWY, DANE_PRZYKLADOWE['niski-stan'])
    const t = transportSmtp({ host: '127.0.0.1', port: 1, bezpieczenstwo: 'BRAK', login: null, haslo: null })
    expect(await t.wyslij(m, { od: { email: 'a@example.com' }, do: 'x@example.com, y@example.com' })).toEqual({ kind: 'REJECTED', error: 'niepoprawny adres odbiorcy' })
    expect(await t.wyslij(m, { od: { email: 'zly' }, do: 'b@example.com' })).toEqual({ kind: 'REJECTED', error: 'niepoprawny adres nadawcy' })
  })
})
