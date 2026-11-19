// bramka wysyłki do KSeF i połączenie tokenem na atrapie KSeF TEST (bez sieci, bez bazy).
import { describe, expect, it } from 'vitest'
import { atrapaKsef } from '@/tests/ksef-atrapa'
import { bramkaWysylki, KSEF_API, nipyProdukcji, produkcjaOtwarta, sprawdzAdres, type WarunkiWysylki } from './bramka'
import { BladKsefApi, KsefPolaczenie } from './polaczenie'
import { KsefOnlineSession } from './sesja'

const W: WarunkiWysylki = { program: 'ksef', fakturyWlaczone: true, trybKonta: 'PRACA', kanal: 'WOO', srodowisko: 'TEST', nipSprzedawcy: '1111111111' }
const PROD_ENV = { KSEF_PROD_ENABLED: '1', KSEF_PROD_NIPS: '111-111-11-11, 2222222222' }

describe('bramkaWysylki', () => {
  it('TEST przy spełnionych warunkach: dozwolona, baza api-test', () => {
    expect(bramkaWysylki(W, {})).toEqual({ dozwolona: true, srodowisko: 'TEST', baza: KSEF_API.TEST })
  })

  it('każdy warunek osobno zamyka wysyłkę z powodem po polsku', () => {
    expect(bramkaWysylki({ ...W, program: 'wfirma' }, {})).toMatchObject({ dozwolona: false, powod: expect.stringMatching(/KSeF bezpośrednio/) })
    expect(bramkaWysylki({ ...W, fakturyWlaczone: false }, {})).toMatchObject({ dozwolona: false, powod: expect.stringMatching(/Wystawiaj faktury z Kompletora/) })
    expect(bramkaWysylki({ ...W, trybKonta: 'CIEN' }, {})).toMatchObject({ dozwolona: false, powod: expect.stringMatching(/Tylko podgląd/) })
    expect(bramkaWysylki({ ...W, trybKonta: null }, {})).toMatchObject({ dozwolona: false })
    // zamówienie ręczne bez konta prowadzi Kompletor
    expect(bramkaWysylki({ ...W, trybKonta: null, kanal: 'RECZNE' }, {})).toMatchObject({ dozwolona: true })
  })

  it('produkcja: zamknięta w testach nawet z kluczami operatora; poza testami wymaga obu kluczy i NIP-u na liście', () => {
    // w vitest zmienna VITEST jest ustawiona: produkcja zamknięta bez względu na resztę
    expect(bramkaWysylki({ ...W, srodowisko: 'PROD' }, { ...PROD_ENV, VITEST: 'true' })).toMatchObject({ dozwolona: false, powod: expect.stringMatching(/testach/) })
    expect(bramkaWysylki({ ...W, srodowisko: 'PROD' }, { NODE_ENV: 'test', ...PROD_ENV })).toMatchObject({ dozwolona: false })
    expect(bramkaWysylki({ ...W, srodowisko: 'PROD' }, {})).toMatchObject({ dozwolona: false, powod: expect.stringMatching(/KSEF_PROD_ENABLED/) })
    expect(bramkaWysylki({ ...W, srodowisko: 'PROD' }, { KSEF_PROD_ENABLED: '1' })).toMatchObject({ dozwolona: false, powod: expect.stringMatching(/KSEF_PROD_NIPS/) })
    expect(bramkaWysylki({ ...W, srodowisko: 'PROD', nipSprzedawcy: '3333333333' }, PROD_ENV)).toMatchObject({ dozwolona: false })
    expect(bramkaWysylki({ ...W, srodowisko: 'PROD' }, PROD_ENV)).toEqual({ dozwolona: true, srodowisko: 'PROD', baza: KSEF_API.PROD })
    expect(nipyProdukcji(PROD_ENV)).toEqual(new Set(['1111111111', '2222222222']))
    expect(produkcjaOtwarta(null, PROD_ENV).otwarta).toBe(false)
  })

  it('sprawdzAdres: tylko host środowiska połączenia, HTTPS, ścieżka /v2', () => {
    expect(() => sprawdzAdres('TEST', 'https://api-test.ksef.mf.gov.pl/v2/auth/challenge')).not.toThrow()
    expect(() => sprawdzAdres('TEST', 'https://api.ksef.mf.gov.pl/v2/auth/challenge')).toThrow(/spoza środowiska TEST/)
    expect(() => sprawdzAdres('TEST', 'http://api-test.ksef.mf.gov.pl/v2/x')).toThrow()
    expect(() => sprawdzAdres('TEST', 'https://u:p@api-test.ksef.mf.gov.pl/v2/x')).toThrow()
    expect(() => sprawdzAdres('DEMO', 'https://api-test.ksef.mf.gov.pl/v2/x')).toThrow()
  })
})

describe('KsefPolaczenie i sesja na atrapie KSeF TEST', () => {
  const bramka = { dozwolona: true as const, srodowisko: 'TEST' as const, baza: KSEF_API.TEST }

  it('token → sesja → faktura → numer KSeF i UPO; token nie trafia do żadnego adresu ani komunikatu', async () => {
    const a = atrapaKsef()
    const t = await KsefPolaczenie.otworz(bramka, { nip: '1111111111', token: 'TOKEN-TESTOWY-123' }, { fetch: a.fetch, sleep: async () => {} })
    const s = await KsefOnlineSession.open(t)
    const wyslana = await s.sendInvoice('<Faktura><Fa><RodzajFaktury>VAT</RodzajFaktury><P_2>FV/1/11/2026</P_2></Fa></Faktura>')
    const { outcome } = await s.waitForInvoice(wyslana.referenceNumber, { sleep: async () => {} })
    expect(outcome).toMatchObject({ state: 'accepted', ksefNumber: expect.stringMatching(/^5260250274-/) })
    expect(await s.downloadInvoiceUpo(wyslana.referenceNumber)).toContain('UPO')
    await s.close()
    expect(a.faktury.map((f) => f.numer)).toEqual(['FV/1/11/2026'])
    expect(a.wywolania.join(' ')).not.toContain('TOKEN-TESTOWY')
  })

  it('zły token: BladKsefApi z kodem 401, bez treści tokenu', async () => {
    const a = atrapaKsef({ zlyToken: true })
    const e = await KsefPolaczenie.otworz(bramka, { nip: '1111111111', token: 'ZLY-TOKEN' }, { fetch: a.fetch, sleep: async () => {} }).catch((x) => x)
    expect(e).toBeInstanceOf(BladKsefApi)
    expect(e.status).toBe(401)
    expect(e.message).not.toContain('ZLY-TOKEN')
  })

  it('dubel: ten sam numer drugi raz → 440 z numerem KSeF oryginału', async () => {
    const a = atrapaKsef()
    const t = await KsefPolaczenie.otworz(bramka, { nip: '1111111111', token: 'T' }, { fetch: a.fetch, sleep: async () => {} })
    const xml = '<Faktura><Fa><RodzajFaktury>VAT</RodzajFaktury><P_2>FV/7/11/2026</P_2></Fa></Faktura>'
    const s1 = await KsefOnlineSession.open(t)
    const w1 = await s1.sendInvoice(xml)
    const o1 = (await s1.waitForInvoice(w1.referenceNumber, { sleep: async () => {} })).outcome
    const s2 = await KsefOnlineSession.open(t)
    const w2 = await s2.sendInvoice(xml)
    const o2 = (await s2.waitForInvoice(w2.referenceNumber, { sleep: async () => {} })).outcome
    expect(o2).toMatchObject({ state: 'duplicate', ksefNumber: o1.state === 'accepted' ? o1.ksefNumber : 'x', originalSessionReferenceNumber: s1.referenceNumber })
    expect(a.faktury).toHaveLength(1)
  })

  it('pusty token: odmowa przed siecią', async () => {
    const a = atrapaKsef()
    await expect(KsefPolaczenie.otworz(bramka, { nip: '1111111111', token: ' ' }, { fetch: a.fetch })).rejects.toThrow(/brak tokenu/)
    expect(a.wywolania).toEqual([])
  })
})
