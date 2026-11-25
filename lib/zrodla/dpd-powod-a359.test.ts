// (przegląd poprawek): powód odmowy DPD bez danych odbiorcy także wtedy, gdy wartość wypada na
// granicy 300. znaku albo DPD odsyła ją po swojej normalizacji; strona zapory i numer listu przy 4xx = NIEJEDNOZNACZNY.
// Atrapa w pamięci, dane fikcyjne, zero połączeń z DPD.
import { describe, expect, it } from 'vitest'
import { DPD_DEMO, DPD_FID, DPD_LOGIN, DPD_PASSWORD, dpdAtrapa, json } from '../../tests/dpd-atrapa'
import { DpdKurier } from './dpd-kurier'
import { czyPewnaOdmowaKuriera, czySladUtworzenia, DPD_SCIEZKA_NUMERY, DpdZapis } from './dpd-zapis'

const AUTH = { login: DPD_LOGIN, password: DPD_PASSWORD, fid: DPD_FID }
const zapis = (a: ReturnType<typeof dpdAtrapa>) => new DpdZapis({ baseUrl: DPD_DEMO, auth: AUTH, fetchImpl: a.fetchImpl, wylacznik: true })
const kurier = (a: ReturnType<typeof dpdAtrapa>) => new DpdKurier({ baseUrl: DPD_DEMO, auth: AUTH, fetchImpl: a.fetchImpl, wylacznik: true })

const EMAIL = 'anna.przykladowa@example.invalid'
const TELEFON = '+48 600 111 222'
/** Treść żądania w kształcie `buildPackagesPayload` (fikcyjna). */
const ZADANIE = {
  generationPolicy: 'ALL_OR_NOTHING',
  packages: [
    {
      reference: 'ref-a359',
      payerFID: 1495,
      receiver: { name: 'Anna Przykładowa', address: 'ul. Żurawia 7', city: 'Łódź', postalCode: '90-001', countryCode: 'PL', phone: TELEFON, email: EMAIL },
      parcels: [{ weight: 1.5, sizeX: 40, sizeY: 30, sizeZ: 20 }],
      services: [{ code: 'DPD_PICKUP', attributes: [{ code: 'PUDO', value: 'PL99999' }] }],
    },
  ],
}
const wiadomosc = (r: { ok: boolean }) => ('message' in r ? (r as { message: string }).message : '')
/** Fragmenty danych odbiorcy, które nie mogą zostać w komunikacie (także urwane i znormalizowane). */
const FRAGMENTY = ['anna', 'ANNA', 'przyk', 'PRZYK', 'example', '600', '111', '222', '90001', '90-001', 'urawia', 'URAWIA', 'odz', 'ODZ']

describe('wycinanie wartości żądania przed przycięciem do 300 znaków', () => {
  it('e-mail odbiorcy na granicy 300. znaku nie zostawia urwanego fragmentu', async () => {
    // „receiver.email: ” (16) + kod (267) + „: Zły adres ” (12): e-mail zaczyna się na 296. znaku powodu
    const kod = `E${'X'.repeat(266)}`
    const a = dpdAtrapa([json({ errors: [{ field: 'receiver.email', code: kod, userMessage: `Zły adres ${EMAIL}` }] }, 400)])
    const m = wiadomosc(await zapis(a).post(DPD_SCIEZKA_NUMERY, ZADANIE))
    expect(m).toMatch(/HTTP 400 \(receiver\.email: EX+: Zły adres \*\*\*\)$/)
    expect(m).not.toMatch(/anna|przyk|example/i)
  })

  it('login urwany na granicy 300. znaku nie zostaje w komunikacie', async () => {
    // „DISALLOWED_FID; ” (16) + 278 znaków + spacja: login zaczyna się na 296. znaku powodu
    const a = dpdAtrapa([json({ status: 'DISALLOWED_FID', message: `${'x'.repeat(278)} ${DPD_LOGIN}` }, 403)])
    const m = wiadomosc(await zapis(a).post(DPD_SCIEZKA_NUMERY, ZADANIE))
    expect(m).toMatch(/HTTP 403 \(DISALLOWED_FID; x+ \*\*\*\)$/)
    expect(m).not.toContain(DPD_LOGIN.slice(0, 5))
  })
})

describe('echa znormalizowane przez DPD', () => {
  it('nazwisko wielkimi literami, kod pocztowy bez kreski i telefon bez spacji i plusa nie trafiają do powodu', async () => {
    const a = dpdAtrapa([
      json({ status: 'INCORRECT_DATA', packages: [{ validationInfo: [{ errorCode: 'INCORRECT_RECEIVER_NAME', info: 'Receiver ANNA PRZYKLADOWA is not valid' }] }] }, 400),
      json({ status: 'INCORRECT_DATA', packages: [{ validationInfo: [{ errorCode: 'INCORRECT_POSTAL_CODE', info: 'Postal code 90001 does not exist' }] }] }, 400),
      json({ errors: [{ field: 'receiver.phone', code: 'INVALID_PHONE', userMessage: 'Phone 600111222 is invalid' }] }, 400),
      json({ errors: [{ field: 'receiver.phone', code: 'INVALID_PHONE', userMessage: 'Phone 48600111222 is invalid' }] }, 400),
      json({ status: 'INCORRECT_DATA', packages: [{ validationInfo: [{ errorCode: 'INCORRECT_CITY', info: 'City LODZ, street ZURAWIA unknown' }] }] }, 400),
    ])
    const m1 = wiadomosc(await zapis(a).post(DPD_SCIEZKA_NUMERY, ZADANIE))
    expect(m1).toMatch(/INCORRECT_RECEIVER_NAME: Receiver \*\*\* is not valid/)
    const m2 = wiadomosc(await zapis(a).post(DPD_SCIEZKA_NUMERY, ZADANIE))
    expect(m2).toMatch(/INCORRECT_POSTAL_CODE/)
    const m3 = wiadomosc(await zapis(a).post(DPD_SCIEZKA_NUMERY, ZADANIE))
    expect(m3).toMatch(/receiver\.phone: INVALID_PHONE/)
    const m4 = wiadomosc(await zapis(a).post(DPD_SCIEZKA_NUMERY, ZADANIE))
    expect(m4).toMatch(/receiver\.phone: INVALID_PHONE/)
    const m5 = wiadomosc(await zapis(a).post(DPD_SCIEZKA_NUMERY, ZADANIE))
    expect(m5).toMatch(/INCORRECT_CITY: City \*\*\*, street \*\*\* unknown/)
    for (const m of [m1, m2, m3, m4, m5]) for (const f of FRAGMENTY) expect(m).not.toContain(f)
  })

  it('wolny tekst z cyfrą albo @ spoza żądania (np. inny telefon) wypada, kod błędu zostaje', async () => {
    const a = dpdAtrapa([json({ errors: [{ field: 'receiver.email', code: 'INVALID_EMAIL', userMessage: 'Adres kontakt@inna.invalid i 501 502 503 odrzucone' }] }, 400)])
    const m = wiadomosc(await zapis(a).post(DPD_SCIEZKA_NUMERY, ZADANIE))
    expect(m).toMatch(/HTTP 400 \(receiver\.email: INVALID_EMAIL\)$/)
  })

  it('echo w wierzchnim message albo detail też wycięte; stałe słownikowe żądania nie zamazują kodów błędów', async () => {
    const a = dpdAtrapa([json({ status: 'INCORRECT_DATA', detail: 'Pudo point for anna przykładowa missing', packages: [{ validationInfo: [{ errorCode: 'INCORRECT_PUDO', info: 'Incorrect pudo identifier' }] }] }, 400)])
    const m = wiadomosc(await zapis(a).post(DPD_SCIEZKA_NUMERY, ZADANIE))
    expect(m).toMatch(/INCORRECT_PUDO: Incorrect pudo identifier; INCORRECT_DATA; Pudo point for \*\*\* missing/)
  })

  it('pole słownikowe, które nie wygląda na identyfikator (spacje, @), idzie jak wolny tekst', async () => {
    const a = dpdAtrapa([json({ status: `bad ${'kontakt@inna.invalid'}`, code: 'X_1' }, 400)])
    const m = wiadomosc(await zapis(a).post(DPD_SCIEZKA_NUMERY, ZADANIE))
    expect(m).toMatch(/HTTP 400 \(X_1\)$/)
  })

  it('zamówienie kuriera: odmowa walidacji z numerem zlecenia w odpowiedzi = pewna odmowa z powodem DPD', async () => {
    const odp = { orderNumber: '0', checkSum: '0', traceId: 't-1', status: { status: 'VALIDATION_ERROR', errorDetails: [{ code: 'INCORRECT_PICKUP_TIME', fields: 'pickupTimeFrom', description: 'Incorrect pickup time' }] } }
    const w = await kurier(dpdAtrapa([json(odp, 400)])).zamow({ x: 1 })
    expect(w).toMatchObject({ ok: false, kind: 'TRWALY' })
    expect(wiadomosc(w)).toContain('DPD odrzucił zamówienie kuriera: HTTP 400 (VALIDATION_ERROR; pickupTimeFrom: INCORRECT_PICKUP_TIME: Incorrect pickup time)')
  })

  it('zamówienie kuriera: status niepewny z numerem zlecenia zostaje NIEJEDNOZNACZNY, ale z powodem', async () => {
    const odp = { orderNumber: '12345', checkSum: '9', traceId: 't-2', status: { status: 'UNKNOWN_ERROR', errorDetails: [] } }
    const w = await kurier(dpdAtrapa([json(odp, 400)])).zamow({ x: 1 })
    expect(w).toMatchObject({ ok: false, kind: 'NIEJEDNOZNACZNY' })
    expect(wiadomosc(w)).toMatch(/UNKNOWN_ERROR/)
  })

  it('zamówienie kuriera: echo danych nadawcy po normalizacji wycięte', async () => {
    const tresc = { packagesForCollection: { sender: { name: 'Magazyn Atrapowy', phone: '500 600 700', postalCode: '00-002' } } }
    const a = dpdAtrapa([json({ errors: [{ field: 'sender.name', code: 'INVALID', userMessage: 'Sender MAGAZYN ATRAPOWY rejected' }] }, 400)])
    const m = wiadomosc(await kurier(a).zamow(tresc))
    expect(m).toMatch(/DPD odrzucił zamówienie kuriera: HTTP 400 \(sender\.name: INVALID: Sender \*\*\* rejected\)/)
    expect(m).not.toMatch(/magazyn|atrapowy/i)
  })
})

/** Strona zapory w kształcie z żywego konta; identyfikator fikcyjny. */
const ZAPORA_HTML = '<html><head><title>Request Rejected</title></head><body>The requested URL was rejected. Please consult with your administrator.<br><br>Your support ID is: 1234567890123456789</body></html>'

describe('strona zapory DPD z kodem 4xx', () => {
  it('zapis: strona zapory z HTTP 403 = NIEJEDNOZNACZNY jak przy 200, bez treści strony, jedno żądanie', async () => {
    const a = dpdAtrapa([{ status: 403, body: ZAPORA_HTML }])
    const r = await zapis(a).post(DPD_SCIEZKA_NUMERY, ZADANIE)
    expect(r).toMatchObject({ ok: false, kind: 'NIEJEDNOZNACZNY', message: expect.stringMatching(/zapora DPD odrzuciła żądanie.*HTTP 403/) })
    expect(wiadomosc(r)).not.toContain('1234567890123456789')
    expect(a.calls).toHaveLength(1)
  })

  it('kurier: strona zapory z HTTP 400 = NIEJEDNOZNACZNY (nie zamawiaj drugi raz)', async () => {
    const a = dpdAtrapa([{ status: 400, body: ZAPORA_HTML }])
    expect(await kurier(a).zamow({ x: 1 })).toMatchObject({ ok: false, kind: 'NIEJEDNOZNACZNY', message: expect.stringContaining('nie zamawiaj drugi raz') })
  })

  it('zwykła strona HTML bez znamion zapory przy 403 zostaje TRWALY', async () => {
    const a = dpdAtrapa([{ status: 403, body: '<html>Forbidden</html>' }])
    expect(await zapis(a).post(DPD_SCIEZKA_NUMERY, ZADANIE)).toMatchObject({ ok: false, kind: 'TRWALY' })
  })
})

describe('odpowiedź 4xx ze śladem utworzenia', () => {
  it('400 z numerem listu w packages[].parcels[] albo packageId = NIEJEDNOZNACZNY', async () => {
    const a = dpdAtrapa([
      json({ status: 'INCORRECT_DATA', packages: [{ reference: 'ref-a359', parcels: [{ waybill: '0000999999999U' }], validationInfo: [{ errorCode: 'X' }] }] }, 400),
      json({ status: 'INCORRECT_DATA', packages: [{ packageId: 77 }] }, 400),
    ])
    for (let i = 0; i < 2; i++) {
      const r = await zapis(a).post(DPD_SCIEZKA_NUMERY, ZADANIE)
      expect(r).toMatchObject({ ok: false, kind: 'NIEJEDNOZNACZNY', message: expect.stringContaining('czy paczka nie powstała') })
      expect(wiadomosc(r)).not.toContain('0000999999999U')
    }
  })

  it('400 z pustym numerem listu zostaje TRWALY z powodem', async () => {
    const a = dpdAtrapa([json({ status: 'INCORRECT_DATA', packages: [{ parcels: [{ waybill: '' }], validationInfo: [{ errorCode: 'INCORRECT_WEIGHT' }] }] }, 400)])
    expect(await zapis(a).post(DPD_SCIEZKA_NUMERY, ZADANIE)).toMatchObject({ ok: false, kind: 'TRWALY', message: expect.stringMatching(/HTTP 400 \(INCORRECT_WEIGHT; INCORRECT_DATA\)/) })
  })

  it('kurier: 4xx z numerem zlecenia = NIEJEDNOZNACZNY', async () => {
    const a = dpdAtrapa([json({ orderNumber: 'ZK-9', status: { status: 'ERROR' } }, 400)])
    expect(await kurier(a).zamow({ x: 1 })).toMatchObject({ ok: false, kind: 'NIEJEDNOZNACZNY' })
  })
})

describe('orderNumber „0” i czyPewnaOdmowaKuriera', () => {
  it('`orderNumber` z samych zer albo pusty to nie ślad utworzenia (UNKNOWN_ERROR z „0” = TRWALY)', async () => {
    for (const nr of ['0', '000', ' ', 0]) expect(czySladUtworzenia(JSON.stringify({ orderNumber: nr }))).toBe(false)
    expect(czySladUtworzenia(JSON.stringify({ orderNumber: 'AD112345678900' }))).toBe(true)
    const a = dpdAtrapa([json({ orderNumber: '0', checkSum: '0', status: { status: 'UNKNOWN_ERROR', errorDetails: [] } }, 400)])
    expect(await kurier(a).zamow({ x: 1 })).toMatchObject({ ok: false, kind: 'TRWALY', message: expect.stringContaining('UNKNOWN_ERROR') })
  })
  it('status-obiekt z kodem pewnej odmowy = pewna; inne kody = nie', () => {
    for (const k of ['VALIDATION_ERROR', 'DISALLOWED_FID', 'DISABLED_API', 'NOT_FOUND']) expect(czyPewnaOdmowaKuriera(JSON.stringify({ status: { status: k } }))).toBe(true)
    for (const k of ['UNKNOWN_ERROR', 'SERVICE_UNAVAILABLE', 'OK']) expect(czyPewnaOdmowaKuriera(JSON.stringify({ status: { status: k } }))).toBe(false)
  })
  it('treść spoza JSON (strona HTML, pusta, ucięta, sam kod) = nie', () => {
    for (const t of [ZAPORA_HTML, '', '{"status":', 'VALIDATION_ERROR']) expect(czyPewnaOdmowaKuriera(t)).toBe(false)
  })
  it('`status` tekstowy na wierzchu (kształt odpowiedzi przesyłek, nie kuriera) = nie: pewna odmowa tylko ze `status.status`', () => {
    expect(czyPewnaOdmowaKuriera(JSON.stringify({ status: 'VALIDATION_ERROR', orderNumber: 'ZK-1' }))).toBe(false)
    expect(czyPewnaOdmowaKuriera(JSON.stringify([{ status: { status: 'VALIDATION_ERROR' } }]))).toBe(false)
    expect(czyPewnaOdmowaKuriera('null')).toBe(false)
  })
})
