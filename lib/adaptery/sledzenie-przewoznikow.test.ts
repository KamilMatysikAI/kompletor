// Śledzenie przesyłek DPD (DPDInfoServices) i Wysyłam z Allegro (`shipment.track`) na atrapach HTTP, mapowanie
// statusów InPost po przekazaniu i anulowaniu oraz domyślne moduły automatu. Dane fikcyjne, zero połączeń.
import { describe, expect, it } from 'vitest'
import { DPD_DEMO, DPD_FID, DPD_LOGIN, DPD_PASSWORD } from '@/tests/dpd-atrapa'
import { DPD_INFO_HASLO, DPD_INFO_LOGIN, DPD_INFO_URL, dpdSledzenieAtrapa, FAULT } from '@/tests/dpd-sledzenie-atrapa'
import { API, AUTH, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FakeAllegroZapis, UA } from '@/tests/allegro-zapis-atrapa'
import { kluczeSledzenia, SLEDZENIE_DOMYSLNIE_WLACZONE, sledzenieModulu } from '../pakowanie/wyslane-po-przyjezdzie'
import { czytajTresc, DPD_INFO_URL_RE, MAKS_ODPOWIEDZI, zdarzeniaZOdpowiedzi } from '../zrodla/dpd-sledzenie'
import type { FetchLike } from '../zrodla/http'
import { klasaBledu } from '../integracje/oslona'
import { ALLEGRO_SECRETS as S } from './allegro'
import { ALLEGRO_WYSYLAM_ZAPIS_KEY, stanAllegro } from './allegro-wysylam-zapis'
import { BASE_COURIER_ZAPIS_KEY } from './basecourier-zapis'
import { defaultRegistry } from './domyslne'
import { DPD_NEUTRALNE, DPD_PRZEKAZANA, DPD_ZAPIS_KEY, DPD_ZAPIS_MANIFEST, stanDpd } from './dpd'
import { stanShipX, INPOST_SHIPX_ZAPIS_MANIFEST } from './inpost-zapis'
import { AdapterError, BladKontaSledzenia, BladPrzesylkiSledzenia, hasShipmentTracker, type ChannelAdapter, type ShipmentTracker } from './kontrakt'
import { PP_ZAPIS_MANIFEST } from './pocztapolska'

const FAST = { retry: { attempts: 2, baseDelayMs: 0 }, minIntervalMs: 0, pollDelayMs: 0 }
const NUMER = '0000123456789U'

function tracker(a: ChannelAdapter): ChannelAdapter & ShipmentTracker {
  if (!hasShipmentTracker(a)) throw new Error('moduł bez śledzenia')
  return a
}

function dpd(fetchImpl: ReturnType<typeof dpdSledzenieAtrapa>['fetchImpl'], config: Record<string, unknown> = {}, secrets: Record<string, string> = {}) {
  return tracker(
    defaultRegistry().create(DPD_ZAPIS_KEY, {
      integration: { organizationId: 'org', kind: 'carrier' as const, id: 'dpd', name: 'DPD' },
      rawConfig: { baseUrl: DPD_DEMO, payerFid: DPD_FID, zapisWlaczony: true, sledzenieUrl: DPD_INFO_URL, ...config },
      rawSecrets: { DPD_LOGIN, DPD_PASSWORD, DPD_SLEDZENIE_LOGIN: DPD_INFO_LOGIN, DPD_SLEDZENIE_HASLO: DPD_INFO_HASLO, ...secrets },
      fetch: fetchImpl,
      http: FAST,
    }),
  )
}

const blad = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    return e
  }
  throw new Error('oczekiwany błąd')
}

describe('DPD: śledzenie z DPDInfoServices', () => {
  it('odebrana przez kuriera = PRZEKAZANA; same rejestracje albo brak zdarzeń = przed nadaniem; nieznany kod = NIEZNANY', async () => {
    const at = dpdSledzenieAtrapa()
    const a = dpd(at.fetchImpl)
    at.zdarzenia.set(NUMER, [
      { kod: '030103', opis: 'Zarejestrowano dane przesyłki', czas: '2026-11-12T08:00:00' },
      { kod: '040101', opis: 'Przesyłka odebrana przez Kuriera', czas: '2026-11-12T14:10:00' },
    ])
    expect(await a.trackShipment(NUMER)).toMatchObject({ stan: 'PRZEKAZANA', status: '040101 Przesyłka odebrana przez Kuriera', stanDrogi: 'PRZEKAZANA' })
    at.zdarzenia.set(NUMER, [{ kod: '030103', czas: '2026-11-12T08:00:00' }])
    expect((await a.trackShipment(NUMER)).stan).toBe('PRZED_NADANIEM')
    at.zdarzenia.set(NUMER, [])
    expect(await a.trackShipment(NUMER)).toMatchObject({ stan: 'PRZED_NADANIEM', status: null, stanDrogi: 'UTWORZONA' })
    at.zdarzenia.set(NUMER, [{ kod: '999999', czas: '2026-11-12T08:00:00' }])
    expect((await a.trackShipment(NUMER)).stan).toBe('NIEZNANY')
    // sam odczyt: jedna metoda, POST pod adres usługi, login DPDServices nie wychodzi do innej usługi
    expect(at.calls.every((c) => c.url === DPD_INFO_URL && c.method === 'POST' && c.body.includes('getEventsForWaybillV1') && c.body.includes(`<waybill>${NUMER}</waybill>`))).toBe(true)
    expect(at.calls.some((c) => c.body.includes(DPD_LOGIN) || c.body.includes(DPD_PASSWORD))).toBe(false)
  })

  it('bez wyłącznika zapisu albo bez danych usługi śledzenia: TRWALY bez żądania', async () => {
    const at = dpdSledzenieAtrapa()
    const wyl = await blad(dpd(at.fetchImpl, { zapisWlaczony: false }).trackShipment(NUMER))
    expect(wyl).toBeInstanceOf(AdapterError)
    expect((wyl as AdapterError).kind).toBe('TRWALY')
    const bez = await blad(dpd(at.fetchImpl, { sledzenieUrl: undefined }).trackShipment(NUMER))
    expect((bez as AdapterError).kind).toBe('TRWALY')
    expect((bez as AdapterError).message).toMatch(/śledzenie DPD wyłączone/)
    expect(at.calls).toHaveLength(0)
  })

  it('Fault (zły login) = TRWALY bez hasła w komunikacie; 5xx bez Fault = PRZEJSCIOWY; zły numer = TRWALY bez żądania', async () => {
    const at = dpdSledzenieAtrapa()
    const zly = await blad(dpd(at.fetchImpl, {}, { DPD_SLEDZENIE_HASLO: 'inne-haslo-testowe' }).trackShipment(NUMER))
    expect((zly as AdapterError).kind).toBe('TRWALY')
    expect((zly as AdapterError).message).not.toContain('inne-haslo-testowe')
    at.awarie.push({ status: 503, body: '' }, { status: 503, body: '' })
    expect((await blad(dpd(at.fetchImpl).trackShipment(NUMER)) as AdapterError).kind).toBe('PRZEJSCIOWY')
    const n = at.calls.length
    expect((await blad(dpd(at.fetchImpl).trackShipment('<x/>')) as AdapterError).kind).toBe('TRWALY')
    expect(at.calls).toHaveLength(n)
  })

  it('adres usługi tylko https w domenie dpd.com.pl; parser odpowiedzi z przykładu specyfikacji', () => {
    expect(DPD_INFO_URL_RE.test(DPD_INFO_URL)).toBe(true)
    for (const zly of ['http://info.dpd.com.pl/x', 'https://dpd.com.pl.example.invalid/x', 'https://example.invalid/dpd.com.pl', 'https://info.dpd.com.pl/x?y=1']) expect(DPD_INFO_URL_RE.test(zly)).toBe(false)
    expect(() => zdarzeniaZOdpowiedzi(FAULT)).toThrow(/Brak uprawnien/)
    expect(stanDpd([{ kod: '190101', opis: null, czas: null }]).stan).toBe('PRZEKAZANA')
    expect(stanDpd([{ kod: '170310', opis: null, czas: null }]).stan).toBe('PRZED_NADANIEM')
  })
})

describe('DPD: błędy usługi śledzenia (konto, przesyłka, przejściowe)', () => {
  const FAULT_SERWERA =
    '<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><S:Fault><faultcode>S:Server</faultcode><faultstring>Internal error, try again later</faultstring></S:Fault></S:Body></S:Envelope>'

  it('Fault serwera, pusta treść przy 200 i strona serwisowa: przejściowe (nie koniec śledzenia, nie błąd konta)', async () => {
    for (const awaria of [
      { status: 500, body: FAULT_SERWERA },
      { status: 200, body: '' },
      { status: 200, body: '<html><body>Przerwa techniczna</body></html>' },
    ]) {
      const at = dpdSledzenieAtrapa()
      at.awarie.push(awaria, awaria)
      const e = await blad(dpd(at.fetchImpl).trackShipment(NUMER))
      expect(e, awaria.body).toBeInstanceOf(AdapterError)
      expect((e as AdapterError).kind, awaria.body).toBe('PRZEJSCIOWY')
      expect(e).not.toBeInstanceOf(BladKontaSledzenia)
    }
  })

  it('Fault o logowaniu i 401/403: błąd konta z osobnymi danymi, bez hasła w komunikacie i bez „HTTP 401”', async () => {
    const at = dpdSledzenieAtrapa()
    const zly = await blad(dpd(at.fetchImpl, {}, { DPD_SLEDZENIE_HASLO: 'inne-haslo-testowe' }).trackShipment(NUMER))
    expect(zly).toBeInstanceOf(BladKontaSledzenia)
    expect((zly as BladKontaSledzenia).osobneDane).toBe(true)
    for (const status of [401, 403]) {
      at.awarie.push({ status, body: '' })
      const e = await blad(dpd(at.fetchImpl).trackShipment(NUMER))
      expect(e).toBeInstanceOf(BladKontaSledzenia)
      expect((e as Error).message).not.toMatch(/HTTP 40[13]/)
      expect(klasaBledu(e as Error)).toBeNull()
    }
  })

  it('zły numer listu: błąd tej przesyłki bez żądania', async () => {
    const at = dpdSledzenieAtrapa()
    expect(await blad(dpd(at.fetchImpl).trackShipment('<x/>'))).toBeInstanceOf(BladPrzesylkiSledzenia)
    expect(at.calls).toHaveLength(0)
  })

  it('ucięta treść (zerwane połączenie w trakcie): przejściowy', async () => {
    const urwana: FetchLike = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode('<S:Envelope><S:Body><ns2:getEventsForWaybillV1Response>'))
            c.error(new Error('socket hang up'))
          },
        }),
        { status: 200 },
      )
    const e = await blad(dpd(urwana).trackShipment(NUMER))
    expect((e as AdapterError).kind).toBe('PRZEJSCIOWY')
  })

  it('treść czytana z limitem bez content-length i z zegarem na czytanie; czytanie przerwane', async () => {
    let wyslane = 0
    let anulowane = false
    const bezKonca = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            wyslane += 64 * 1024
            c.enqueue(new Uint8Array(64 * 1024).fill(65))
          },
          cancel() {
            anulowane = true
          },
        }),
        { status: 200 },
      )
    await expect(czytajTresc(bezKonca(), MAKS_ODPOWIEDZI, 10_000)).rejects.toThrow(/za duża odpowiedź/)
    expect(wyslane).toBeLessThan(MAKS_ODPOWIEDZI + 256 * 1024)
    expect(anulowane).toBe(true)
    anulowane = false
    const wisi = new Response(new ReadableStream<Uint8Array>({ start() {}, cancel: () => void (anulowane = true) }), { status: 200 })
    await expect(czytajTresc(wisi, MAKS_ODPOWIEDZI, 30)).rejects.toThrow(/przekroczony czas/)
    expect(anulowane).toBe(true)
    // za duża treść w adapterze: przejściowy (następny przebieg), nie koniec śledzenia
    const e = await blad(dpd(async () => bezKonca()).trackShipment(NUMER))
    expect((e as AdapterError).kind).toBe('PRZEJSCIOWY')
  })

  it('sekrety DPD pod własnymi nazwami: dane usługi Śledzenie Poczty Polskiej nie idą do DPD', async () => {
    const dpdNazwy = DPD_ZAPIS_MANIFEST.secrets.map((s) => s.name)
    const ppNazwy = PP_ZAPIS_MANIFEST.secrets.map((s) => s.name)
    expect(dpdNazwy.filter((n) => ppNazwy.includes(n))).toEqual([])
    expect(dpdNazwy).toEqual(expect.arrayContaining(['DPD_SLEDZENIE_LOGIN', 'DPD_SLEDZENIE_HASLO']))
    const at = dpdSledzenieAtrapa()
    const a = tracker(
      defaultRegistry().create(DPD_ZAPIS_KEY, {
        integration: { organizationId: 'org', kind: 'carrier' as const, id: 'dpd', name: 'DPD' },
        rawConfig: { baseUrl: DPD_DEMO, payerFid: DPD_FID, zapisWlaczony: true, sledzenieUrl: DPD_INFO_URL },
        rawSecrets: { DPD_LOGIN, DPD_PASSWORD, SLEDZENIE_LOGIN: DPD_INFO_LOGIN, SLEDZENIE_HASLO: DPD_INFO_HASLO },
        fetch: at.fetchImpl,
        http: FAST,
      }),
    )
    expect((await blad(a.trackShipment(NUMER)) as Error).message).toMatch(/śledzenie DPD wyłączone/)
    expect(at.calls).toHaveLength(0)
  })

  it('kody neutralne nie rozstrzygają: rejestracja z mailem do odbiorcy = przed nadaniem, odbiór = przekazana', () => {
    const rej = { kod: '030103', opis: null, czas: '2026-11-13T14:00:00' }
    const mail = { kod: '170310', opis: null, czas: '2026-11-13T14:05:00' }
    expect(stanDpd([rej, mail])).toEqual({ stan: 'PRZED_NADANIEM', status: '170310' })
    expect(stanDpd([rej, mail, { kod: '040101', opis: null, czas: '2026-11-16T10:00:00' }]).stan).toBe('PRZEKAZANA')
    for (const k of DPD_NEUTRALNE) expect(DPD_PRZEKAZANA.has(k)).toBe(false)
  })
})

describe('Wysyłam z Allegro: śledzenie przesyłki', () => {
  const SHIP = '7d2a0c6e-1111-4222-8333-444455556666'

  function make(fake: FakeAllegroZapis, config: Record<string, unknown> = { zapisWlaczony: true }) {
    const pair = fake.base.issuePair()
    return tracker(
      defaultRegistry().create(ALLEGRO_WYSYLAM_ZAPIS_KEY, {
        integration: { organizationId: 'org', kind: 'carrier' as const, id: 'ALLEGRO/71045', name: 'Allegro', channel: 'ALLEGRO' as const, channelAccountId: '71045' },
        rawConfig: { apiUrl: API, authUrl: AUTH, userAgent: UA, ...config },
        rawSecrets: { [S.clientId]: FAKE_CLIENT_ID, [S.clientSecret]: FAKE_CLIENT_SECRET, [S.access]: pair.access, [S.refresh]: pair.refresh, [S.expiresAt]: new Date(Date.now() + 3_600_000).toISOString() },
        fetch: fake.fetch,
        http: { retry: { attempts: 1, baseDelayMs: 0 }, minIntervalMs: 0, pollDelayMs: 0 },
        persistSecrets: async () => {},
      }),
    )
  }

  it('IN_TRANSIT = PRZEKAZANA; PENDING i brak historii = przed nadaniem; samo ISSUE = NIEZNANY; brak przesyłki = ANULOWANA; tylko GET', async () => {
    const f = new FakeAllegroZapis()
    f.wys.shipments.set(SHIP, { id: SHIP, carrier: 'ALLEGRO', packages: [{ waybill: 'ALE0000000E5D200' }] })
    const a = make(f)
    expect(await a.trackShipment(SHIP)).toEqual({ stan: 'PRZED_NADANIEM', status: null, stanDrogi: 'UTWORZONA', czas: null, kod: null, przekazanaO: null })
    f.wys.tracking.set('ALLEGRO/ALE0000000E5D200', [{ code: 'PENDING', occurredAt: '2026-11-12T08:00:00Z' }])
    expect((await a.trackShipment(SHIP)).stan).toBe('PRZED_NADANIEM')
    f.wys.tracking.set('ALLEGRO/ALE0000000E5D200', [{ code: 'ISSUE', occurredAt: '2026-11-12T09:00:00Z' }])
    expect((await a.trackShipment(SHIP)).stan).toBe('NIEZNANY')
    expect((await a.trackShipment(SHIP)).stanDrogi).toBe('PROBLEM')
    f.wys.tracking.set('ALLEGRO/ALE0000000E5D200', [
      { code: 'PENDING', occurredAt: '2026-11-12T08:00:00Z' },
      { code: 'IN_TRANSIT', occurredAt: '2026-11-12T14:00:00Z' },
    ])
    expect(await a.trackShipment(SHIP)).toMatchObject({ stan: 'PRZEKAZANA', status: 'IN_TRANSIT', stanDrogi: 'PRZEKAZANA' })
    expect(await a.trackShipment('0d2a0c6e-1111-4222-8333-444455556666')).toEqual({ stan: 'ANULOWANA', status: 'BRAK', stanDrogi: 'ANULOWANA' })
    expect(f.wys.nonGet()).toEqual([])
    expect(f.wys.requests.some((r) => r.startsWith('GET /order/carriers/ALLEGRO/tracking?waybill=ALE0000000E5D200'))).toBe(true)
  })

  it('bez numeru nadania: przed nadaniem bez pytania o historię; zapis wyłączony = TRWALY bez żądania', async () => {
    const f = new FakeAllegroZapis()
    f.wys.shipments.set(SHIP, { id: SHIP, carrier: 'ALLEGRO', packages: [{}] })
    expect((await make(f).trackShipment(SHIP)).stan).toBe('PRZED_NADANIEM')
    expect(f.wys.requests.some((r) => r.includes('/tracking'))).toBe(false)
    const n = f.wys.requests.length
    expect(((await blad(make(f, {}).trackShipment(SHIP))) as AdapterError).kind).toBe('TRWALY')
    expect(f.wys.requests).toHaveLength(n)
  })

  it('404 historii = NIEZNANY (nie koniec); 429 i 5xx = przejściowe; zły numer = błąd przesyłki; zapis wyłączony = błąd konta', async () => {
    const f = new FakeAllegroZapis()
    f.wys.shipments.set(SHIP, { id: SHIP, carrier: 'ALLEGRO', packages: [{ waybill: 'ALE0000000E5D200' }] })
    const a = make(f)
    f.wys.trackingFailures.push({ status: 404 })
    expect(await a.trackShipment(SHIP)).toEqual({ stan: 'NIEZNANY', status: null, stanDrogi: 'NIEZNANY' })
    for (const status of [429, 503]) {
      f.wys.trackingFailures.push({ status })
      const e = await blad(a.trackShipment(SHIP))
      expect((e as AdapterError).kind, String(status)).toBe('PRZEJSCIOWY')
      f.wys.failures.push({ status })
      const e2 = await blad(a.trackShipment(SHIP))
      expect((e2 as AdapterError).kind, `przesyłka ${status}`).toBe('PRZEJSCIOWY')
    }
    expect(await blad(a.trackShipment('nie-uuid'))).toBeInstanceOf(BladPrzesylkiSledzenia)
    expect(await blad(make(f, {}).trackShipment(SHIP))).toBeInstanceOf(BladKontaSledzenia)
  })

  it('mapowanie statusów z poradnika Allegro', () => {
    for (const k of ['IN_TRANSIT', 'RELEASED_FOR_DELIVERY', 'AVAILABLE_FOR_PICKUP', 'NOTICE_LEFT', 'DELIVERED', 'RETURNED']) expect(stanAllegro([{ kod: k, czas: null }]).stan).toBe('PRZEKAZANA')
    expect(stanAllegro([]).stan).toBe('PRZED_NADANIEM')
  })
})

describe('InPost: statusy po przekazaniu i anulowanie', () => {
  it('zwroty i niedoręczenia = PRZEKAZANA, canceled = ANULOWANA, nieznany = NIEZNANY', () => {
    for (const s of ['returned_to_sender', 'undelivered_wrong_address', 'rejected_by_receiver', 'claimed', 'oversized', 'pickup_time_expired', 'taken_by_courier_from_customer_service_point']) expect(stanShipX(s)).toBe('PRZEKAZANA')
    expect(stanShipX('canceled')).toBe('ANULOWANA')
    expect(stanShipX('cos_nowego')).toBe('NIEZNANY')
  })
})

describe('moduły śledzenia automatu', () => {
  it('bez wyborów firmy: dokładnie InPost, Poczta Polska i Base Courier (śledzony od 19.11.2026); nowe tylko po włączeniu', () => {
    const reg = defaultRegistry()
    expect(new Set(kluczeSledzenia(reg))).toEqual(new Set([INPOST_SHIPX_ZAPIS_MANIFEST.adapterKey, PP_ZAPIS_MANIFEST.adapterKey, BASE_COURIER_ZAPIS_KEY]))
    expect([...SLEDZENIE_DOMYSLNIE_WLACZONE].sort()).toEqual([INPOST_SHIPX_ZAPIS_MANIFEST.adapterKey, PP_ZAPIS_MANIFEST.adapterKey, BASE_COURIER_ZAPIS_KEY].sort())
    const wlaczone = kluczeSledzenia(reg, { [DPD_ZAPIS_KEY]: true, [ALLEGRO_WYSYLAM_ZAPIS_KEY]: true, [INPOST_SHIPX_ZAPIS_MANIFEST.adapterKey]: false })
    expect(wlaczone).toContain(DPD_ZAPIS_KEY)
    expect(wlaczone).toContain(ALLEGRO_WYSYLAM_ZAPIS_KEY)
    expect(wlaczone).not.toContain(INPOST_SHIPX_ZAPIS_MANIFEST.adapterKey)
    expect(sledzenieModulu(DPD_ZAPIS_KEY)).toBe(false)
  })
})
