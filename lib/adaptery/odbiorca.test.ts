// Odbiorca na żądanie: parsery trzech kanałów (pełny komplet, punkt odbioru, faktura firmowa, brak NIP,
// puste pola, zły typ pola), przejścia na przesyłkę i fakturę, wyłącznik env. Dane wyłącznie fikcyjne (znaczniki
// PII_SENTINELS i example.invalid); atrapy zamiast sieci.
import { describe, expect, it } from 'vitest'
import { checkoutForm, FakeAllegro, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, API, AUTH, UA } from '@/tests/allegro-atrapa'
import { naKontrahenta, naOdbiorcePrzesylki } from '../odbiorca/przejscia'
import { daneOdbiorcyZEnv, przytnijDoPowodu } from '../odbiorca/pobierz'
import { allegroRecipientFromApi, ALLEGRO_SECRETS } from './allegro'
import { defaultRegistry } from './domyslne'
import { hasRecipientReader, type OrderRecipient, UnreadableDataError } from './kontrakt'
import { miraklRecipientFromApi } from './mirakl-empik'
import { PII_SENTINELS } from './suita-kontraktowa'
import { wooRecipientFromApi } from './woo'

const [IMIE, EMAIL, TELEFON, ULICA, NIP] = PII_SENTINELS as [string, string, string, string, string]
const NOW = new Date('2026-11-02T12:00:00.000Z')

/** Komunikat błędu bez żadnej wartości osobowej. */
function bezDanych(e: unknown): void {
  expect(e).toBeInstanceOf(UnreadableDataError)
  for (const p of [...PII_SENTINELS, 'Jan', 'Testowy', 'Testowo', '00-001']) expect((e as Error).message).not.toContain(p)
}

const catchErr = (f: () => unknown): unknown => {
  try {
    f()
  } catch (e) {
    return e
  }
  throw new Error('oczekiwany błąd')
}

// ─── Woo ─────────────────────────────────────────────────────────────────────

const WOO_SET = { nipMetaKey: '_billing__billing_nip', pickupPointMetaKey: '_paczkomat_id', invoiceMetaKey: '_chce_fakture' }

function wooRaw(p: { shipping?: Record<string, unknown>; billing?: Record<string, unknown>; meta?: { key: string; value: unknown }[] } = {}): Record<string, unknown> {
  return {
    id: 501,
    billing: p.billing ?? { first_name: 'Jan', last_name: 'Testowy', company: '', address_1: ULICA, address_2: '', city: 'Testowo', postcode: '00-001', country: 'PL', email: EMAIL, phone: TELEFON },
    shipping: p.shipping ?? { first_name: 'Jan', last_name: 'Testowy', company: '', address_1: ULICA, address_2: 'm. 2', city: 'Testowo', postcode: '00-001', country: 'PL', phone: '' },
    meta_data: p.meta ?? [{ id: 1, key: '_billing__billing_nip', value: NIP }],
  }
}

describe('Woo: odbiorca', () => {
  it('pełny komplet: adres z shipping, e-mail i telefon z billing, cała linia ulicy i adres_bez_podzialu', () => {
    const r = wooRecipientFromApi(wooRaw(), WOO_SET)
    expect(r.dostawa).toEqual({ imieNazwisko: IMIE, firma: null, ulica: `${ULICA} m. 2`, numerDomu: null, numerLokalu: null, kodPocztowy: '00-001', miasto: 'Testowo', kraj: 'PL', telefon: TELEFON, email: EMAIL })
    expect(r.faktura).toEqual({ nazwa: IMIE, nip: NIP, ulica: ULICA, kodPocztowy: '00-001', miasto: 'Testowo', kraj: 'PL' })
    expect(r.problemy).toEqual(['adres_bez_podzialu'])
    expect(r.punktOdbioru).toBeNull()
  })

  it('punkt odbioru z klucza konta; bez klucza null i punkt_nieznany (bez zgadywania wtyczki)', () => {
    const raw = wooRaw({ meta: [{ key: '_paczkomat_id', value: 'KRA01M' }] })
    expect(wooRecipientFromApi(raw, WOO_SET).punktOdbioru).toEqual({ kod: 'KRA01M', nazwa: null })
    const bez = wooRecipientFromApi(raw, { ...WOO_SET, pickupPointMetaKey: null })
    expect(bez.punktOdbioru).toBeNull()
    expect(bez.problemy).toContain('punkt_nieznany')
    // Poprawka z 19.11.2026: punkt z linii wysyłki Flexible Shipping, gdy klucz konta nic nie dał albo go nie ma
    const zFs = { ...raw, fs_shipping_lines: [{ _integration: 'paczkomaty', delivery_point_id: 'KRA01M', delivery_point_name: 'Paczkomat testowy' }] }
    const fs = wooRecipientFromApi(zFs, { ...WOO_SET, pickupPointMetaKey: null })
    expect(fs.punktOdbioru).toEqual({ kod: 'KRA01M', nazwa: 'Paczkomat testowy' })
    expect(fs.problemy).not.toContain('punkt_nieznany')
    expect(wooRecipientFromApi({ ...raw, meta_data: [], fs_shipping_lines: zFs.fs_shipping_lines }, { ...WOO_SET, pickupPointMetaKey: '_dpd_pickup_point_id' }).punktOdbioru?.kod).toBe('KRA01M')
    expect(wooRecipientFromApi({ ...raw, fs_shipping_lines: 'x' }, { ...WOO_SET, pickupPointMetaKey: null }).punktOdbioru).toBeNull()
  })

  it('faktura firmowa: nazwa firmy z billing.company i NIP z meta', () => {
    const raw = wooRaw({ billing: { first_name: 'Jan', last_name: 'Testowy', company: 'Firma Fikcyjna', address_1: ULICA, city: 'Testowo', postcode: '00-001', country: 'PL', email: EMAIL, phone: TELEFON } })
    expect(wooRecipientFromApi(raw, WOO_SET).faktura).toMatchObject({ nazwa: 'Firma Fikcyjna', nip: NIP })
  })

  it('brak NIP: bez klucza konta null i nip_klucz_nieustawiony; z kluczem, ale bez wartości — null (osoba prywatna)', () => {
    const chce = [{ key: '_chce_fakture', value: 'yes' }]
    const bezKlucza = wooRecipientFromApi(wooRaw({ meta: chce }), { ...WOO_SET, nipMetaKey: null })
    expect(bezKlucza.faktura?.nip).toBeNull()
    expect(bezKlucza.problemy).toContain('nip_klucz_nieustawiony')
    const bezWartosci = wooRecipientFromApi(wooRaw({ meta: chce }), WOO_SET)
    expect(bezWartosci.faktura?.nip).toBeNull()
    expect(bezWartosci.problemy).not.toContain('nip_klucz_nieustawiony')
  })

  it('faktura = życzenie faktury, nie adres rozliczeniowy (osoba prywatna bez zaznaczenia = null)', () => {
    // osoba prywatna, bez NIP-u i firmy, bez zaznaczenia: faktury nie chce
    expect(wooRecipientFromApi(wooRaw({ meta: [] }), WOO_SET).faktura).toBeNull()
    expect(wooRecipientFromApi(wooRaw({ meta: [{ key: '_chce_fakture', value: '0' }] }), WOO_SET).faktura).toBeNull()
    // zaznaczenie z klucza konta: faktura na osobę (tak samo przy true z wtyczki)
    for (const value of ['yes', 'Tak', '1', true]) {
      expect(wooRecipientFromApi(wooRaw({ meta: [{ key: '_chce_fakture', value }] }), WOO_SET).faktura).toMatchObject({ nazwa: IMIE, nip: null })
    }
    // firma albo NIP = faktura także bez klucza zaznaczenia; bez klucza problem faktura_klucz_nieustawiony
    const bezKlucza = { ...WOO_SET, invoiceMetaKey: null }
    expect(wooRecipientFromApi(wooRaw(), bezKlucza).faktura).toMatchObject({ nip: NIP })
    const osoba = wooRecipientFromApi(wooRaw({ meta: [{ key: '_chce_fakture', value: 'yes' }] }), bezKlucza)
    expect(osoba.faktura).toBeNull()
    expect(osoba.problemy).toContain('faktura_klucz_nieustawiony')
    expect(wooRecipientFromApi(wooRaw(), WOO_SET).problemy).not.toContain('faktura_klucz_nieustawiony')
    // zły typ zaznaczenia: błąd z nazwą klucza, bez wartości
    bezDanych(catchErr(() => wooRecipientFromApi(wooRaw({ meta: [{ key: '_chce_fakture', value: { v: IMIE } }] }), WOO_SET)))
  })

  it('puste pola: null zamiast pustego stringa; pusty shipping = cały blok z billing', () => {
    const r = wooRecipientFromApi(wooRaw({ shipping: { first_name: '', last_name: '', address_1: '', city: '', postcode: '', country: '' } }), WOO_SET)
    expect(r.dostawa).toMatchObject({ imieNazwisko: IMIE, ulica: ULICA, miasto: 'Testowo', firma: null })
    const pusty = wooRecipientFromApi(wooRaw({ shipping: {}, billing: { email: '  ' }, meta: [] }), WOO_SET)
    expect(pusty.dostawa).toEqual({ imieNazwisko: null, firma: null, ulica: null, numerDomu: null, numerLokalu: null, kodPocztowy: null, miasto: null, kraj: null, telefon: null, email: null })
    expect(pusty.faktura).toBeNull()
    expect(pusty.problemy).toEqual(expect.arrayContaining(['brak_imie_nazwisko', 'brak_ulica', 'brak_kod_pocztowy', 'brak_miasto', 'brak_kraj', 'brak_telefon', 'brak_email']))
  })

  it('zły typ pola: UnreadableDataError z nazwą pola, bez wartości', () => {
    bezDanych(catchErr(() => wooRecipientFromApi(wooRaw({ billing: { phone: { v: TELEFON }, email: EMAIL } }), WOO_SET)))
    bezDanych(catchErr(() => wooRecipientFromApi({ ...wooRaw(), shipping: [IMIE] }, WOO_SET)))
    bezDanych(catchErr(() => wooRecipientFromApi(wooRaw({ meta: [{ key: '_billing__billing_nip', value: { nip: NIP } }] }), WOO_SET)))
  })

  it('adapter: GET orders/<id>, ustawienia konta z manifestu, zła wartość klucza meta = błąd konfiguracji', async () => {
    const urls: string[] = []
    const adapter = defaultRegistry().create('woo.rest.v1', {
      integration: { organizationId: 'test_a', kind: 'channel', id: 'WOO/lampy', channel: 'WOO', channelAccountId: 'lampy', name: 'Sklep' },
      rawConfig: { baseUrl: 'https://sklep.example', nipMetaKey: '_billing__billing_nip' },
      rawSecrets: { WOO_CONSUMER_KEY: 'ck', WOO_CONSUMER_SECRET: 'cs' },
      fetch: async (url, init) => {
        urls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`)
        return new Response(JSON.stringify(wooRaw()), { status: 200, headers: { 'content-type': 'application/json' } })
      },
      now: () => NOW,
      http: { retry: { attempts: 1, baseDelayMs: 0 }, minIntervalMs: 0 },
    })
    expect(hasRecipientReader(adapter)).toBe(true)
    if (!hasRecipientReader(adapter)) return
    const r = await adapter.getOrderRecipient('501')
    expect(r.faktura?.nip).toBe(NIP)
    expect(r.problemy).toContain('punkt_nieznany')
    expect(urls).toEqual(['GET /wp-json/wc/v3/orders/501'])
    expect(() =>
      defaultRegistry().create('woo.rest.v1', {
        integration: { organizationId: 'test_a', kind: 'channel', id: 'WOO/x', channel: 'WOO', channelAccountId: 'x', name: 'x' },
        rawConfig: { baseUrl: 'https://sklep.example', nipMetaKey: 'zły klucz z spacją' },
        rawSecrets: { WOO_CONSUMER_KEY: 'ck', WOO_CONSUMER_SECRET: 'cs' },
        fetch,
      }),
    ).toThrow(/nipMetaKey/)
  })
})

// ─── Allegro ─────────────────────────────────────────────────────────────────

const form = (p: Parameters<typeof checkoutForm>[0] extends infer S ? Partial<S> : never = {}) => checkoutForm({ id: 'f-1', updatedAt: NOW.toISOString(), ...p })

describe('Allegro: odbiorca', () => {
  it('pełny komplet: delivery.address, e-mail kupującego jak w kanale (maskowany), bez faktury, gdy niewymagana', () => {
    const r = allegroRecipientFromApi(form())
    expect(r.dostawa).toEqual({ imieNazwisko: IMIE, firma: null, ulica: ULICA, numerDomu: null, numerLokalu: null, kodPocztowy: '00-001', miasto: 'Testowo', kraj: 'PL', telefon: TELEFON, email: EMAIL })
    expect(r.faktura).toBeNull()
    expect(r.punktOdbioru).toBeNull()
    expect(r.problemy).toEqual(['adres_bez_podzialu'])
  })

  it('punkt odbioru: id i nazwa', () => {
    expect(allegroRecipientFromApi(form({ pickupPoint: { id: 'KRA01M', name: 'Paczkomat KRA01M' } })).punktOdbioru).toEqual({ kod: 'KRA01M', nazwa: 'Paczkomat KRA01M', adres: { ulica: 'ul. Testowa 1', kodPocztowy: '00-001', miasto: 'Testowo' } }) // adres punktu z kanału
  })

  it('faktura firmowa: nazwa i taxId; osoba: imię i nazwisko bez NIP', () => {
    expect(allegroRecipientFromApi(form({ invoice: true })).faktura).toEqual({ nazwa: 'Firma Fikcyjna sp. z o.o.', nip: NIP, ulica: ULICA, kodPocztowy: '00-001', miasto: 'Testowo', kraj: 'PL' })
    const osoba = allegroRecipientFromApi(form({ invoice: true, invoiceKind: 'osoba' }))
    expect(osoba.faktura).toMatchObject({ nazwa: IMIE, nip: null })
    expect(osoba.problemy).not.toContain('brak_nip')
  })

  it('brak NIP przy fakturze na firmę: null i brak_nip', () => {
    const r = allegroRecipientFromApi(form({ invoice: true, invoiceKind: 'firma_bez_nip' }))
    expect(r.faktura?.nip).toBeNull()
    expect(r.problemy).toContain('brak_nip')
  })

  it('puste pola i brak adresu: null, problemy zamiast pustych stringów', () => {
    const raw = form()
    ;(raw['delivery'] as Record<string, unknown>)['address'] = { firstName: '', lastName: ' ', street: '', zipCode: '', city: '', countryCode: '', phoneNumber: '' }
    ;(raw['buyer'] as Record<string, unknown>)['email'] = ''
    const r = allegroRecipientFromApi(raw)
    expect(Object.values(r.dostawa!).every((v) => v === null)).toBe(true)
    expect(r.problemy).not.toContain('adres_bez_podzialu')
    expect(r.problemy).toContain('brak_email')
    const bez = allegroRecipientFromApi(form({ bezAdresuDostawy: true }))
    expect(bez.dostawa).toBeNull()
    expect(bez.problemy).toContain('adres_niedostepny_w_kanale')
  })

  it('zły typ pola: UnreadableDataError bez wartości', () => {
    const raw = form()
    ;((raw['delivery'] as Record<string, unknown>)['address'] as Record<string, unknown>)['zipCode'] = ['00-001']
    bezDanych(catchErr(() => allegroRecipientFromApi(raw)))
    const inv = form({ invoice: true })
    ;(inv['invoice'] as Record<string, unknown>)['required'] = 'tak'
    bezDanych(catchErr(() => allegroRecipientFromApi(inv)))
  })

  it('adapter: tylko GET /order/checkout-forms/{id} tym samym klientem i tokenem', async () => {
    const fake = new FakeAllegro()
    fake.clock = () => NOW.getTime()
    const pair = fake.issuePair()
    fake.putForm({ id: 'f-9', updatedAt: NOW.toISOString(), invoice: true })
    const adapter = defaultRegistry().create('allegro.v1', {
      integration: { organizationId: 'test_a', kind: 'channel', id: 'ALLEGRO/71045', channel: 'ALLEGRO', channelAccountId: '71045', name: 'Allegro' },
      rawConfig: { userAgent: UA, apiUrl: API, authUrl: AUTH },
      rawSecrets: { [ALLEGRO_SECRETS.clientId]: FAKE_CLIENT_ID, [ALLEGRO_SECRETS.clientSecret]: FAKE_CLIENT_SECRET, [ALLEGRO_SECRETS.access]: pair.access, [ALLEGRO_SECRETS.refresh]: pair.refresh },
      fetch: fake.fetch,
      now: () => NOW,
      http: { retry: { attempts: 1, baseDelayMs: 0 }, minIntervalMs: 0 },
      persistSecrets: async () => undefined,
    })
    if (!hasRecipientReader(adapter)) throw new Error('bez zdolności')
    expect((await adapter.getOrderRecipient('f-9')).faktura?.nip).toBe(NIP)
    await expect(adapter.getOrderRecipient('f-brak')).rejects.toMatchObject({ kind: 'TRWALY' })
    expect(fake.requests).toEqual(['GET /order/checkout-forms/f-9', 'GET /order/checkout-forms/f-brak'])
  })
})

// ─── Empik (Mirakl) ──────────────────────────────────────────────────────────
// Kształt potwierdzony odczytem OR11 20.11.2026 (15 zamówień): kod punktu w `order_additional_fields[]`
// „delivery-point-name”; przy punkcie `shipping_address` opisuje PUNKT (nazwisko = kod punktu, bez imienia, ulica i
// miasto punktu, `additional_info` = opis paczkomatu, telefon klienta); klient w `customer.*` i `billing_address`;
// prawdziwy e-mail w polu „customer-email”, `customer_notification_email` = alias Mirakla; `country_iso_code` pusty,
// kraj nazwą w `country`.

const adres = (p: Record<string, unknown> = {}) => ({ firstname: 'Jan', lastname: 'Testowy', company: null, street_1: ULICA, street_2: null, zip_code: '00-001', city: 'Testowo', country: 'Polska', country_iso_code: 'POL', phone: TELEFON, ...p })
const ALIAS = 'alias-123@notification.example.invalid'
const ULICA_PUNKTU = 'Punktowa 5'
const ULICA_KLIENTA = 'Kliencka 7/3'
/** Adres punktu tak, jak Empik podaje go w shipping_address (kod punktu w nazwisku, bez imienia). */
const adresPunktu = (kod: string, p: Record<string, unknown> = {}) => ({ lastname: kod, company: null, company_2: null, street_1: ULICA_PUNKTU, street_2: null, zip_code: '00-002', city: 'Punktowo', country: 'Polska', country_iso_code: null, state: null, phone: TELEFON, additional_info: null, ...p })
const adresKlienta = (p: Record<string, unknown> = {}) => ({ firstname: 'Jan', lastname: 'Testowy', company: null, company_2: null, street_1: ULICA_KLIENTA, street_2: null, zip_code: '00-001', city: 'Testowo', country: 'Polska', country_iso_code: null, state: null, phone: TELEFON, ...p })
const pole = (code: string, value: unknown, type = 'STRING') => ({ code, type, value })
const dodatkowe = (...f: ReturnType<typeof pole>[]) => [pole('customer-email', EMAIL), ...f, pole('order-type', 'REGULAR', 'LIST'), pole('price-calibrated', 'false', 'BOOLEAN')]

function miraklRaw(customer: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { order_id: 'E-1-A', order_state: 'SHIPPING', ...(customer ? { customer } : {}), customer_notification_email: EMAIL, ...extra }
}
/** Zamówienie w kształcie z odczytu: alias Mirakla w customer_notification_email, prawdziwy e-mail w polu dodatkowym. */
function zamowienie(typ: 'PACKSTATION' | 'STORE' | 'COURIER', o: { kod?: string | null; opis?: string | null; pola?: unknown } = {}): Record<string, unknown> {
  const label = { PACKSTATION: 'Paczkomaty InPost', STORE: 'Dostawa do Salonu Empik', COURIER: 'KURIER' }[typ]
  const kod = o.kod === undefined ? (typ === 'PACKSTATION' ? 'TST01M' : 'PL99999') : o.kod
  const shipping = typ === 'COURIER' ? adresKlienta({ street_1: ULICA }) : adresPunktu(kod ?? 'TST01M', { additional_info: o.opis ?? null })
  return {
    order_id: 'E-2-A',
    order_state: 'SHIPPING',
    shipping_type_code: typ,
    shipping_type_label: label,
    shipping_pudo_id: null,
    customer_notification_email: ALIAS,
    customer: { firstname: 'Jan', lastname: 'Testowy', shipping_address: shipping, billing_address: adresKlienta() },
    order_additional_fields: o.pola !== undefined ? o.pola : dodatkowe(...(typ !== 'COURIER' && kod !== null ? [pole('delivery-point-name', kod)] : [])),
  }
}

describe('Empik (Mirakl): odbiorca', () => {
  it('pełny komplet: shipping_address, kraj alpha-3 → alpha-2, faktura na firmę z billing_address bez NIP', () => {
    const r = miraklRecipientFromApi(miraklRaw({ firstname: 'Jan', lastname: 'Testowy', shipping_address: adres(), billing_address: adres({ company: 'Firma Fikcyjna' }) }))
    expect(r.dostawa).toEqual({ imieNazwisko: IMIE, firma: null, ulica: ULICA, numerDomu: null, numerLokalu: null, kodPocztowy: '00-001', miasto: 'Testowo', kraj: 'PL', telefon: TELEFON, email: EMAIL })
    expect(r.faktura).toEqual({ nazwa: 'Firma Fikcyjna', nip: null, ulica: ULICA, kodPocztowy: '00-001', miasto: 'Testowo', kraj: 'PL' })
    // bez sposobu dostawy z punktem (kurier): punktu nie ma i nie powinno być
    expect(r.punktOdbioru).toBeNull()
    expect(r.problemy).toEqual(['adres_bez_podzialu', 'nip_niedostepny_w_kanale'])
  })

  it('adres ukryty przed przyjęciem: dostawa null i adres_niedostepny_w_kanale, nie błąd', () => {
    for (const raw of [miraklRaw(undefined), miraklRaw({ firstname: 'Jan', lastname: 'Testowy' }), miraklRaw({ shipping_address: null })]) {
      const r = miraklRecipientFromApi(raw)
      expect(r.dostawa).toBeNull()
      expect(r.problemy).toContain('adres_niedostepny_w_kanale')
    }
  })

  it('puste pola: imię z customer, gdy adres go nie ma; brak e-maila = null i brak_email', () => {
    const r = miraklRecipientFromApi(miraklRaw({ firstname: 'Jan', lastname: 'Testowy', shipping_address: adres({ firstname: '', lastname: '', phone: '' }) }, { customer_notification_email: '' }))
    expect(r.dostawa).toMatchObject({ imieNazwisko: IMIE, telefon: null, email: null })
    expect(r.problemy).toEqual(expect.arrayContaining(['brak_telefon', 'brak_email']))
  })

  it('osoba prywatna: dane do faktury z billing_address (imię, nazwisko, adres), bez problemu z NIP-em', () => {
    const r = miraklRecipientFromApi(miraklRaw({ firstname: 'Jan', lastname: 'Testowy', shipping_address: adres(), billing_address: adres({ street_1: ULICA_KLIENTA }) }))
    expect(r.faktura).toEqual({ nazwa: IMIE, nip: null, ulica: ULICA_KLIENTA, kodPocztowy: '00-001', miasto: 'Testowo', kraj: 'PL' })
    expect(r.problemy).not.toContain('nip_niedostepny_w_kanale')
  })

  it('billing_address bez adresu albo bez nazwy: faktura null', () => {
    expect(miraklRecipientFromApi(miraklRaw({ shipping_address: adres(), billing_address: adres({ street_1: null, zip_code: null, city: null }) })).faktura).toBeNull()
    expect(miraklRecipientFromApi(miraklRaw({ shipping_address: adres(), billing_address: adres({ firstname: null, lastname: null }) })).faktura).toBeNull()
  })

  it('kurier: odbiorca i adres z shipping_address, bez punktu i bez punkt_nieznany; prawdziwy e-mail zamiast aliasu', () => {
    const r = miraklRecipientFromApi(zamowienie('COURIER'))
    expect(r.punktOdbioru).toBeNull()
    expect(r.problemy).not.toContain('punkt_nieznany')
    expect(r.dostawa).toEqual({ imieNazwisko: IMIE, firma: null, ulica: ULICA, numerDomu: null, numerLokalu: null, kodPocztowy: '00-001', miasto: 'Testowo', kraj: 'PL', telefon: TELEFON, email: EMAIL })
    expect(r.faktura).toMatchObject({ nazwa: IMIE, ulica: ULICA_KLIENTA, kraj: 'PL' })
  })

  it('paczkomat: punkt = kod, opis i adres punktu; odbiorca = klient (nie kod punktu); faktura z adresu klienta', () => {
    const r = miraklRecipientFromApi(zamowienie('PACKSTATION', { opis: 'Obok sklepu' }))
    expect(r.punktOdbioru).toEqual({ kod: 'TST01M', nazwa: 'Obok sklepu', adres: { ulica: ULICA_PUNKTU, kodPocztowy: '00-002', miasto: 'Punktowo' } })
    expect(r.dostawa).toEqual({ imieNazwisko: IMIE, firma: null, ulica: ULICA_PUNKTU, numerDomu: null, numerLokalu: null, kodPocztowy: '00-002', miasto: 'Punktowo', kraj: 'PL', telefon: TELEFON, email: EMAIL })
    expect(r.faktura).toEqual({ nazwa: IMIE, nip: null, ulica: ULICA_KLIENTA, kodPocztowy: '00-001', miasto: 'Testowo', kraj: 'PL' })
    expect(r.problemy).not.toContain('punkt_nieznany')
    expect(JSON.stringify([r.dostawa, r.faktura])).not.toContain('TST01M')
  })

  it('salon Empik: kod salonu i adres salonu jako punkt; odbiorca klient; bez opisu = nazwa null', () => {
    const r = miraklRecipientFromApi(zamowienie('STORE'))
    expect(r.punktOdbioru).toEqual({ kod: 'PL99999', nazwa: null, adres: { ulica: ULICA_PUNKTU, kodPocztowy: '00-002', miasto: 'Punktowo' } })
    expect(r.dostawa).toMatchObject({ imieNazwisko: IMIE, firma: null, ulica: ULICA_PUNKTU, telefon: TELEFON, email: EMAIL })
    expect(r.faktura).toMatchObject({ nazwa: IMIE, ulica: ULICA_KLIENTA })
    expect(JSON.stringify([r.dostawa, r.faktura])).not.toContain('PL99999')
  })

  it('punkt: imię klienta zapasowo z billing_address, gdy customer.* puste', () => {
    const raw = zamowienie('PACKSTATION')
    raw['customer'] = { ...(raw['customer'] as Record<string, unknown>), firstname: null, lastname: '' }
    expect(miraklRecipientFromApi(raw).dostawa?.imieNazwisko).toBe(IMIE)
  })

  it('dostawa do punktu bez kodu (brak pola, puste, kod nie do użycia): punkt null i punkt_nieznany, odbiorca dalej klient', () => {
    for (const typ of ['PACKSTATION', 'STORE'] as const) {
      for (const pola of [dodatkowe(), dodatkowe(pole('delivery-point-name', '')), dodatkowe(pole('delivery-point-name', 'TST 01/../M')), null]) {
        const r = miraklRecipientFromApi(zamowienie(typ, { pola }))
        expect(r.punktOdbioru).toBeNull()
        expect(r.problemy).toContain('punkt_nieznany')
        expect(r.dostawa?.imieNazwisko).toBe(IMIE)
      }
    }
    // sam opis sposobu dostawy (bez kodu sposobu) też rozpoznaje punkt
    const raw = zamowienie('PACKSTATION', { pola: dodatkowe() })
    delete raw['shipping_type_code']
    expect(miraklRecipientFromApi(raw).problemy).toContain('punkt_nieznany')
  })

  it('e-mail: zły albo brak w polu dodatkowym = adres zastępczy Mirakla', () => {
    expect(miraklRecipientFromApi(zamowienie('COURIER', { pola: [pole('customer-email', 'bez-malpy')] })).dostawa?.email).toBe(ALIAS)
    expect(miraklRecipientFromApi(zamowienie('COURIER', { pola: [] })).dostawa?.email).toBe(ALIAS)
  })

  it('zły typ pola: UnreadableDataError bez wartości', () => {
    bezDanych(catchErr(() => miraklRecipientFromApi(miraklRaw({ shipping_address: adres({ zip_code: { v: '00-001' } }) }))))
    bezDanych(catchErr(() => miraklRecipientFromApi(miraklRaw({ shipping_address: [ULICA] }))))
    bezDanych(catchErr(() => miraklRecipientFromApi(zamowienie('PACKSTATION', { pola: { code: 'delivery-point-name' } }))))
    bezDanych(catchErr(() => miraklRecipientFromApi(zamowienie('PACKSTATION', { pola: [pole('delivery-point-name', { v: ULICA })] }))))
  })

  it('faktura imienna przy paczkomacie: kontrahent z adresu klienta, nigdy z adresu punktu', () => {
    const k = naKontrahenta(miraklRecipientFromApi(zamowienie('PACKSTATION')))
    expect(k).toMatchObject({ ok: true, wartosc: { name: IMIE, street: ULICA_KLIENTA, tax_id_type: 'none' } })
    expect(JSON.stringify(k)).not.toContain(ULICA_PUNKTU)
  })
})

// ─── Przejścia i wyłącznik ───────────────────────────────────────────────────

const PELNY: OrderRecipient = {
  dostawa: { imieNazwisko: IMIE, firma: null, ulica: 'Testowa', numerDomu: '1', numerLokalu: null, kodPocztowy: '00-001', miasto: 'Testowo', kraj: 'PL', telefon: TELEFON, email: EMAIL },
  punktOdbioru: null,
  faktura: { nazwa: 'Firma Fikcyjna', nip: '1234563218', ulica: 'Testowa 1', kodPocztowy: '00-001', miasto: 'Testowo', kraj: 'PL' },
  problemy: [],
}

describe('przejścia na przesyłkę i fakturę', () => {
  it('naOdbiorcePrzesylki: komplet = OdbiorcaPrzesylki; adres bez numeru domu = brak, bez pustego stringa', () => {
    expect(naOdbiorcePrzesylki(PELNY)).toEqual({ ok: true, wartosc: { imieNazwisko: IMIE, firma: null, ulica: 'Testowa', numerDomu: '1', numerLokalu: null, kodPocztowy: '00-001', miasto: 'Testowo', telefon: TELEFON, email: EMAIL } })
    expect(naOdbiorcePrzesylki({ ...PELNY, dostawa: { ...PELNY.dostawa!, numerDomu: null, email: null } })).toEqual({ ok: false, braki: ['numer_domu', 'email'] })
    expect(naOdbiorcePrzesylki({ ...PELNY, dostawa: null })).toEqual({ ok: false, braki: ['dostawa'] })
  })

  it('punkt odbioru bez numeru domu i ulicy = komplet (linia adresu bez zmian); kurier bez numeru = brak', () => {
    const punkt = { ...PELNY, punktOdbioru: { kod: 'KRA01M', nazwa: null } }
    expect(naOdbiorcePrzesylki({ ...punkt, dostawa: { ...PELNY.dostawa!, ulica: 'Lipowa 7 3', numerDomu: null } })).toMatchObject({ ok: true, wartosc: { ulica: 'Lipowa 7 3', numerDomu: null } })
    expect(naOdbiorcePrzesylki({ ...punkt, dostawa: { ...PELNY.dostawa!, ulica: null, numerDomu: null } })).toMatchObject({ ok: true, wartosc: { ulica: null, numerDomu: null } })
    expect(naOdbiorcePrzesylki({ ...PELNY, dostawa: { ...PELNY.dostawa!, ulica: 'Lipowa 7 3', numerDomu: null } })).toEqual({ ok: false, braki: ['numer_domu'] })
  })

  it('adres spoza PL = brak kraj_zagraniczny (przesyłka nie niesie kraju); pl małymi i brak kraju przechodzą', () => {
    expect(naOdbiorcePrzesylki({ ...PELNY, dostawa: { ...PELNY.dostawa!, kraj: 'DE' } })).toEqual({ ok: false, braki: ['kraj_zagraniczny'] })
    expect(naOdbiorcePrzesylki({ ...PELNY, dostawa: { ...PELNY.dostawa!, kraj: 'pl' } }).ok).toBe(true)
    expect(naOdbiorcePrzesylki({ ...PELNY, dostawa: { ...PELNY.dostawa!, kraj: null } }).ok).toBe(true)
  })

  it('przytnijDoPowodu: PRZESYLKA bez faktury, FAKTURA bez telefonu, e-maila i punktu odbioru', () => {
    const r: OrderRecipient = { ...PELNY, punktOdbioru: { kod: 'KRA01M', nazwa: null }, problemy: ['adres_bez_podzialu', 'nip_klucz_nieustawiony', 'punkt_nieznany', 'brak_telefon'] }
    const p = przytnijDoPowodu(r, 'PRZESYLKA')
    expect(p).toEqual({ ...r, faktura: null, problemy: ['adres_bez_podzialu', 'punkt_nieznany', 'brak_telefon'] })
    const f = przytnijDoPowodu(r, 'FAKTURA')
    expect(f).toEqual({ dostawa: { ...PELNY.dostawa!, telefon: null, email: null }, punktOdbioru: null, faktura: PELNY.faktura, problemy: ['adres_bez_podzialu', 'nip_klucz_nieustawiony'] })
    expect(przytnijDoPowodu({ ...r, dostawa: null }, 'FAKTURA').dostawa).toBeNull()
    // wejście nietknięte (wynik to kopia)
    expect(r.faktura).toEqual(PELNY.faktura)
    expect(r.dostawa?.telefon).toBe(TELEFON)
  })

  it('naKontrahenta: firma z NIP, osoba bez NIP, brak faktury = brak', () => {
    expect(naKontrahenta(PELNY)).toEqual({ ok: true, wartosc: { name: 'Firma Fikcyjna', nip: '1234563218', tax_id_type: 'nip', street: 'Testowa 1', zip: '00-001', city: 'Testowo', country: 'PL' } })
    expect(naKontrahenta({ ...PELNY, faktura: { ...PELNY.faktura!, nip: null } })).toMatchObject({ ok: true, wartosc: { tax_id_type: 'none' } })
    expect(naKontrahenta({ ...PELNY, faktura: null })).toEqual({ ok: false, braki: ['faktura'] })
    expect(naKontrahenta({ ...PELNY, faktura: { ...PELNY.faktura!, miasto: null } })).toEqual({ ok: false, braki: ['miasto'] })
  })

  it('DANE_ODBIORCY_Z_KANALU: 1 = tak, puste/0 = nie, inna wartość = błąd', () => {
    expect(daneOdbiorcyZEnv({ DANE_ODBIORCY_Z_KANALU: '1' })).toBe(true)
    expect(daneOdbiorcyZEnv({})).toBe(false)
    expect(daneOdbiorcyZEnv({ DANE_ODBIORCY_Z_KANALU: '0' })).toBe(false)
    expect(() => daneOdbiorcyZEnv({ DANE_ODBIORCY_Z_KANALU: 'true' })).toThrow(/DANE_ODBIORCY_Z_KANALU/)
  })
})
