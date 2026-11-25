// Allegro nie przyjmuje ilości 0 na aktywnej ofercie (INVALID_OFFER_QUANTITY): stan 0 kończy ofertę komendą
// publikacji END, stan dodatni wznawia (ilość, potem ACTIVATE) tylko ofertę zakończoną przez Kompletor. Atrapa HTTP
// (tests/allegro-zapis-atrapa.ts), dane fikcyjne, zero połączeń z prawdziwym Allegro.
import { describe, expect, it } from 'vitest'
import { API, AUTH, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FakeAllegroZapis, UA } from '@/tests/allegro-zapis-atrapa'
import { ALLEGRO_SECRETS as S } from './allegro'
import { ALLEGRO_ZAPIS_KEY, ALLEGRO_ZAPIS_MANIFEST, AllegroZapisAdapter, LIMIT_ZAKONCZEN_WYCZERPANY, zakonczonaPozniej } from './allegro-zapis'
import { defaultRegistry } from './domyslne'
import type { WriteOutcome } from './kontrakt'
import { KLUCZ_LIMIT_ZAKONCZEN, KLUCZ_STAN_ZEROWY, konczyPrzyZerze, limitZakonczen, STAN_ZEROWY_WYSLIJ_ZERO } from './stan-zerowy'

const NOW = new Date('2026-11-06T10:00:00.000Z')
const iso = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString()
const integration = { organizationId: 'org', kind: 'channel' as const, id: 'ALLEGRO/71045', name: 'Allegro', channel: 'ALLEGRO' as const, channelAccountId: '71045' }

function make(fake: FakeAllegroZapis, config: Record<string, unknown> = { zapisWlaczony: true }): AllegroZapisAdapter {
  const pair = fake.base.issuePair()
  const a = defaultRegistry().create(ALLEGRO_ZAPIS_KEY, {
    integration,
    rawConfig: { apiUrl: API, authUrl: AUTH, userAgent: UA, ...config },
    rawSecrets: { [S.clientId]: FAKE_CLIENT_ID, [S.clientSecret]: FAKE_CLIENT_SECRET, [S.access]: pair.access, [S.refresh]: pair.refresh, [S.expiresAt]: iso(600) },
    fetch: fake.fetch,
    now: () => NOW,
    http: { retry: { attempts: 1, baseDelayMs: 0 }, minIntervalMs: 0, pollDelayMs: 0 },
    persistSecrets: async () => {},
  })
  if (!(a instanceof AllegroZapisAdapter)) throw new Error('zły adapter')
  return a
}

function fakeNow(): FakeAllegroZapis {
  const f = new FakeAllegroZapis()
  f.base.clock = () => NOW.getTime()
  return f
}

const pub = (out: WriteOutcome) => (out.publikacja ?? []).map((z) => [z.offerExternalId, z.zmiana])

describe('ustawienia konta (stan 0)', () => {
  it('manifest ma pola „stanZerowy” (z listą) i „limitZakonczenDoba”; domyślnie: kończ, limit 100', () => {
    const pola = ALLEGRO_ZAPIS_MANIFEST.config.map((f) => f.key)
    expect(pola).toEqual(expect.arrayContaining([KLUCZ_STAN_ZEROWY, KLUCZ_LIMIT_ZAKONCZEN]))
    expect(konczyPrzyZerze({})).toBe(true)
    expect(konczyPrzyZerze({ [KLUCZ_STAN_ZEROWY]: STAN_ZEROWY_WYSLIJ_ZERO })).toBe(false)
    expect(limitZakonczen({})).toBe(100)
    expect(limitZakonczen({ [KLUCZ_LIMIT_ZAKONCZEN]: '25' })).toBe(25)
    expect(limitZakonczen({ [KLUCZ_LIMIT_ZAKONCZEN]: 0 })).toBe(0)
    expect(limitZakonczen({ [KLUCZ_LIMIT_ZAKONCZEN]: -3 })).toBe(100)
  })
})

describe('stan 0: zakończenie i wznowienie oferty', () => {
  it('stan 0 na aktywnej ofercie: END, bez komendy ilości 0; reszta paczki ilością', async () => {
    const fake = fakeNow()
    fake.putOffer('20', 'ACTIVE', 241)
    fake.putOffer('21', 'ACTIVE', 5)
    const out = await make(fake).pushStock(
      [
        { offerExternalId: '20', qty: 0 },
        { offerExternalId: '21', qty: 7 },
      ],
      'z-1',
    )
    expect(out.kind).toBe('OK')
    expect(pub(out)).toEqual([['20', 'ZAKONCZONA']])
    expect(fake.pubActions('END')).toEqual(['20'])
    expect(fake.publicationOf('20')).toBe('ENDED')
    expect([...fake.qtyCommands.values()].map((c) => [c.qty, c.offers])).toEqual([[7, ['21']]])
    expect(fake.requests).toContain('GET /sale/offers')
  })

  it('powtórka tej samej paczki: ta sama komenda END (409), bez drugiej komendy', async () => {
    const fake = fakeNow()
    fake.putOffer('20', 'ACTIVE', 241)
    const a = make(fake)
    await a.pushStock([{ offerExternalId: '20', qty: 0 }], 'z-1b')
    fake.putOffer('20', 'ACTIVE', 241) // np. Allegro jeszcze nie pokazało zakończenia
    expect((await a.pushStock([{ offerExternalId: '20', qty: 0 }], 'z-1b')).kind).toBe('OK')
    expect(fake.pubCommands.size).toBe(1)
  })

  it('stan 0 na ofercie już zakończonej: bez żadnego zapisu, OK', async () => {
    const fake = fakeNow()
    fake.putOffer('20', 'ENDED', 0, iso(-60))
    const out = await make(fake).pushStock([{ offerExternalId: '20', qty: 0 }], 'z-2')
    expect(out.kind).toBe('OK')
    expect(pub(out)).toEqual([['20', 'JUZ_ZAKONCZONA']])
    expect(fake.writes()).toEqual([])
  })

  it('stan dodatni na ofercie zakończonej przez Kompletor: ilość, potem ACTIVATE', async () => {
    const fake = fakeNow()
    fake.putOffer('20', 'ENDED', 0, iso(-30))
    const out = await make(fake).pushStock([{ offerExternalId: '20', qty: 4, zakonczonaPrzezNasAt: iso(-29) }], 'z-3')
    expect(out.kind).toBe('OK')
    expect(pub(out)).toEqual([['20', 'WZNOWIONA']])
    expect(fake.stock.get('20')).toBe(4)
    expect(fake.publicationOf('20')).toBe('ACTIVE')
    const w = fake.writes()
    const q = w.findIndex((r) => r.includes('offer-quantity-change-commands'))
    expect(q).toBeGreaterThanOrEqual(0)
    expect(q).toBeLessThan(w.findIndex((r) => r.includes('offer-publication-commands')))
  })

  it('stan dodatni na ofercie zakończonej później przez kogoś innego: bez wznowienia i bez zapisu, ZAKONCZONA_POZA', async () => {
    const fake = fakeNow()
    fake.putOffer('20', 'ENDED', 3, iso(-10))
    const out = await make(fake).pushStock([{ offerExternalId: '20', qty: 4, zakonczonaPrzezNasAt: iso(-130) }], 'z-4')
    expect(out.kind).toBe('OK')
    expect(pub(out)).toEqual([['20', 'ZAKONCZONA_POZA']])
    expect(fake.writes()).toEqual([])
    expect(fake.publicationOf('20')).toBe('ENDED')
  })

  it('oferta bez znacznika, zakończona ręcznie: stan dodatni tylko ilością, bez ACTIVATE', async () => {
    const fake = fakeNow()
    fake.putOffer('20', 'ENDED', 0, iso(-10))
    const out = await make(fake).pushStock([{ offerExternalId: '20', qty: 4 }], 'z-5')
    expect(out.kind).toBe('OK')
    expect(fake.pubActions('ACTIVATE')).toEqual([])
    expect(fake.publicationOf('20')).toBe('ENDED')
    expect(fake.requests).not.toContain('GET /sale/offers')
  })

  it('znacznik, a oferta znowu aktywna (wznowił ktoś inny): zwykła ilość i AKTYWNA (host czyści znacznik)', async () => {
    const fake = fakeNow()
    fake.putOffer('20', 'ACTIVE', 1)
    const out = await make(fake).pushStock([{ offerExternalId: '20', qty: 4, zakonczonaPrzezNasAt: iso(-300) }], 'z-6')
    expect(out.kind).toBe('OK')
    expect(pub(out)).toEqual([['20', 'AKTYWNA']])
    expect(fake.pubCommands.size).toBe(0)
    expect(fake.stock.get('20')).toBe(4)
  })

  it('bezpiecznik: bezKonczenia na aktywnej ofercie = TRWALY z odstaw, bez END i bez zapisu', async () => {
    const fake = fakeNow()
    fake.putOffer('20', 'ACTIVE', 9)
    const out = await make(fake).pushStock([{ offerExternalId: '20', qty: 0, bezKonczenia: true }], 'z-7')
    expect(out.kind).toBe('TRWALY')
    if (out.kind === 'OK') throw new Error()
    expect(out.failedItems).toEqual([{ offerExternalId: '20', kind: 'TRWALY', message: LIMIT_ZAKONCZEN_WYCZERPANY, odstaw: true }])
    expect(fake.writes()).toEqual([])
  })

  it('odmowa Allegro przy END i ACTIVATE: TRWALY z treścią i odstaw (bez pętli ponowień)', async () => {
    const fake = fakeNow()
    fake.putOffer('20', 'ACTIVE', 9)
    fake.putOffer('21', 'ENDED', 0, iso(-5))
    fake.rejectPublication.add('20').add('21')
    const out = await make(fake).pushStock(
      [
        { offerExternalId: '20', qty: 0 },
        { offerExternalId: '21', qty: 2, zakonczonaPrzezNasAt: iso(-5) },
      ],
      'z-8',
    )
    expect(out.kind).toBe('TRWALY')
    if (out.kind === 'OK') throw new Error()
    expect(out.failedItems?.map((f) => [f.offerExternalId, f.odstaw, f.message])).toEqual([
      ['20', true, 'Allegro nie zakończyło oferty: Odmowa zmiany publikacji (atrapa)'],
      ['21', true, 'Allegro nie wznowiło oferty: Odmowa zmiany publikacji (atrapa)'],
    ])
    expect(out.publikacja ?? []).toEqual([])
  })

  it('ustawienie WYSLIJ_ZERO: jak dawniej ilość 0; Allegro odrzuca na aktywnej (INVALID_OFFER_QUANTITY), bez odczytu statusu', async () => {
    const fake = fakeNow()
    fake.putOffer('20', 'ACTIVE', 9)
    const out = await make(fake, { zapisWlaczony: true, [KLUCZ_STAN_ZEROWY]: STAN_ZEROWY_WYSLIJ_ZERO }).pushStock([{ offerExternalId: '20', qty: 0 }], 'z-9')
    expect(out.kind).toBe('TRWALY')
    if (out.kind === 'OK') throw new Error()
    expect(out.failedItems?.[0]?.message).toBe('Allegro odrzuciło stan oferty: INVALID_OFFER_QUANTITY')
    expect(fake.requests).not.toContain('GET /sale/offers')
  })

  it('błąd odczytu statusu: oferty ze stanem 0 PRZEJSCIOWY, reszta paczki zapisana', async () => {
    const fake = fakeNow()
    fake.putOffer('20', 'ACTIVE', 9)
    fake.base.apiFailures.push({ status: 503 })
    const out = await make(fake).pushStock(
      [
        { offerExternalId: '20', qty: 0 },
        { offerExternalId: '21', qty: 3 },
      ],
      'z-10',
    )
    expect(out.kind).toBe('PRZEJSCIOWY')
    if (out.kind === 'OK') throw new Error()
    expect(out.failedItems?.map((f) => f.offerExternalId)).toEqual(['20'])
    expect(fake.stock.get('21')).toBe(3)
    expect(fake.pubCommands.size).toBe(0)
  })

  it('zakonczonaPozniej: tolerancja 10 min', () => {
    expect(zakonczonaPozniej(iso(5), iso(0))).toBe(false)
    expect(zakonczonaPozniej(iso(11), iso(0))).toBe(true)
    expect(zakonczonaPozniej(null, iso(0))).toBe(false)
  })
})
