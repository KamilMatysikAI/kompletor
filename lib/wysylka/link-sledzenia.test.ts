import { describe, expect, it } from 'vitest'
import { numerDoMaila } from '../poczta/wysylka'
import { renderujMail } from '../maile'
import { DANE_PRZYKLADOWE, KONTEKST_PRZYKLADOWY } from '../maile/przyklady'
import type { Carrier } from '@prisma/client'
import { ALLEGRO_WYSYLAM_ZAPIS_KEY } from '../adaptery/allegro-wysylam-zapis'
import { BASE_COURIER_ZAPIS_KEY } from '../adaptery/basecourier-zapis'
import { DPD_ZAPIS_KEY } from '../adaptery/dpd'
import { GLS_ZAPIS_KEY } from '../adaptery/gls'
import { INPOST_SHIPX_ZAPIS_KEY } from '../adaptery/inpost-zapis'
import { PP_ZAPIS_KEY } from '../adaptery/pocztapolska'
import { linkSledzenia, linkSledzeniaDoMaila, linkSledzeniaPanelu, numerDoAdresu, stronaSledzenia } from './link-sledzenia'

/** Moduł, którym przewoźnik nadaje paczki sam (numer = jego numer). */
const WLASNY: Partial<Record<Carrier, string>> = { PACZKOMATY: INPOST_SHIPX_ZAPIS_KEY, INPOST_KURIER: INPOST_SHIPX_ZAPIS_KEY, DPD: DPD_ZAPIS_KEY, DPD_EMPIK: DPD_ZAPIS_KEY, GLS: GLS_ZAPIS_KEY }

describe('link śledzenia u przewoźnika', () => {
  it.each<[Carrier, string, string]>([
    ['PACZKOMATY', '600000000000000000000001', 'https://inpost.pl/sledzenie-przesylek?number=600000000000000000000001'],
    ['INPOST_KURIER', '520000000000000000000002', 'https://inpost.pl/sledzenie-przesylek?number=520000000000000000000002'],
    ['DPD', '0000000000001A', 'https://tracktrace.dpd.com.pl/parcelDetails?typ=1&p1=0000000000001A'],
    ['DPD_EMPIK', '0000000000002B', 'https://tracktrace.dpd.com.pl/parcelDetails?typ=1&p1=0000000000002B'],
    ['GLS', '00000000003', 'https://gls-group.com/PL/pl/sledzenie-paczek?match=00000000003'],
  ])('%s: adres strony śledzenia z numerem', (carrier, numer, adres) => {
    expect(linkSledzenia(carrier, numer, WLASNY[carrier]!)).toBe(adres)
  })

  it.each<Carrier>(['POCZTA_POLSKA', 'ORLEN_PACZKA', 'ALLEGRO', 'OSOBISTY', 'BRAK', 'BEZ_WYSYLKI'])('%s: bez linku (adres niepotwierdzony albo bez przewoźnika)', (carrier) => {
    expect(linkSledzenia(carrier, '600000000000000000000001', WLASNY[carrier] ?? PP_ZAPIS_KEY)).toBeNull()
    expect(stronaSledzenia(carrier)).toBeNull()
  })

  it('każdy przewoźnik z linkiem ma nazwę strony', () => {
    for (const c of ['PACZKOMATY', 'INPOST_KURIER', 'DPD', 'DPD_EMPIK', 'GLS'] as Carrier[]) expect(stronaSledzenia(c)).toBeTruthy()
  })

  it('spacje w numerze usuwa, brak numeru albo obce znaki = bez linku', () => {
    expect(linkSledzenia('DPD', ' 0000 0000 0000 01 ', DPD_ZAPIS_KEY)).toBe('https://tracktrace.dpd.com.pl/parcelDetails?typ=1&p1=00000000000001')
    expect(linkSledzenia('DPD', null, DPD_ZAPIS_KEY)).toBeNull()
    expect(linkSledzenia('DPD', '', DPD_ZAPIS_KEY)).toBeNull()
    expect(linkSledzenia('DPD', '12345', DPD_ZAPIS_KEY)).toBeNull()
    expect(linkSledzenia('PACZKOMATY', '6000&number=1', INPOST_SHIPX_ZAPIS_KEY)).toBeNull()
    expect(linkSledzenia('PACZKOMATY', '6000/../x', INPOST_SHIPX_ZAPIS_KEY)).toBeNull()
    expect(linkSledzenia('GLS', 'a'.repeat(41), GLS_ZAPIS_KEY)).toBeNull()
  })

  it('paczka nadana przez pośrednika (Wysyłam z Allegro, Base Courier): bez linku, choć przewoźnik ten sam', () => {
    expect(linkSledzenia('PACZKOMATY', '600000000000000000000001', ALLEGRO_WYSYLAM_ZAPIS_KEY)).toBeNull()
    expect(linkSledzenia('DPD', '0000000000001A', ALLEGRO_WYSYLAM_ZAPIS_KEY)).toBeNull()
    expect(linkSledzenia('DPD', '0000000000001A', BASE_COURIER_ZAPIS_KEY)).toBeNull()
    expect(linkSledzenia('GLS', '00000000003', BASE_COURIER_ZAPIS_KEY)).toBeNull()
  })

  it('moduł innego przewoźnika niż przewoźnik przesyłki: bez linku', () => {
    expect(linkSledzenia('DPD', '0000000000001A', INPOST_SHIPX_ZAPIS_KEY)).toBeNull()
    expect(linkSledzenia('PACZKOMATY', '600000000000000000000001', DPD_ZAPIS_KEY)).toBeNull()
  })

  it('numerDoAdresu przepuszcza tylko litery, cyfry i myślnik', () => {
    expect(numerDoAdresu('PX-0000000001PL')).toBe('PX-0000000001PL')
    expect(numerDoAdresu('ąę0000000')).toBeNull()
    expect(numerDoAdresu(undefined)).toBeNull()
  })
})

describe('linkSledzeniaPanelu (karta, lista zamówień, lista Przesyłki)', () => {
  it('moduł przewoźnika: jak linkSledzenia (także GLS)', () => {
    expect(linkSledzeniaPanelu('GLS', '00000000003', GLS_ZAPIS_KEY)).toBe('https://gls-group.com/PL/pl/sledzenie-paczek?match=00000000003')
    expect(linkSledzeniaPanelu('DPD', ' 0000 0000 0000 01 ', DPD_ZAPIS_KEY)).toBe('https://tracktrace.dpd.com.pl/parcelDetails?typ=1&p1=00000000000001')
  })

  it('pośrednik (Base Courier, Wysyłam z Allegro) z InPost albo DPD: link jak w mailu', () => {
    expect(linkSledzeniaPanelu('PACZKOMATY', '620999667762053436691541', BASE_COURIER_ZAPIS_KEY)).toBe('https://inpost.pl/sledzenie-przesylek?number=620999667762053436691541')
    expect(linkSledzeniaPanelu('DPD', '0000123456789A', BASE_COURIER_ZAPIS_KEY)).toBe('https://tracktrace.dpd.com.pl/parcelDetails?typ=1&p1=0000123456789A')
    expect(linkSledzeniaPanelu('INPOST_KURIER', '520000000000000000000002', ALLEGRO_WYSYLAM_ZAPIS_KEY)).toBe('https://inpost.pl/sledzenie-przesylek?number=520000000000000000000002')
  })

  it('pośrednik z przewoźnikiem bez reguły maila, nieznany przewoźnik albo zły numer: bez linku', () => {
    expect(linkSledzeniaPanelu('GLS', '00000000003', BASE_COURIER_ZAPIS_KEY)).toBeNull()
    expect(linkSledzeniaPanelu('POCZTA_POLSKA', '600000000000000000000001', PP_ZAPIS_KEY)).toBeNull()
    expect(linkSledzeniaPanelu('DPD', '123 456&x=1', BASE_COURIER_ZAPIS_KEY)).toBeNull()
    expect(linkSledzeniaPanelu('DPD', null, BASE_COURIER_ZAPIS_KEY)).toBeNull()
  })
})

describe('linkSledzeniaDoMaila (mail „Faktura”)', () => {
  it('daje stronę śledzenia InPost i DPD, innym przewoźnikom i złym numerom nic', () => {
    expect(linkSledzeniaDoMaila('PACZKOMATY', '620999667762053436691541')).toBe('https://inpost.pl/sledzenie-przesylek?number=620999667762053436691541')
    expect(linkSledzeniaDoMaila('DPD', '0000123456789A')).toBe('https://tracktrace.dpd.com.pl/parcelDetails?typ=1&p1=0000123456789A')
    expect(linkSledzeniaDoMaila('GLS', '12345678901')).toBeNull()
    expect(linkSledzeniaDoMaila('DPD', '123 456&x=1')).toBeNull()
    expect(linkSledzeniaDoMaila('DPD', null)).toBeNull()
  })
})

describe('numerDoMaila', () => {
  it('zastępuje id z kanału numerem ze sklepu, przedrostek zostaje', () => {
    expect(numerDoMaila('SD 122718', { externalId: '122718', channelNumber: '159076' })).toBe('SD 159076')
    expect(numerDoMaila('122718', { externalId: '122718', channelNumber: '159076' })).toBe('159076')
  })
  it('bez numeru ze sklepu albo przy numerze już poprawionym nic nie zmienia', () => {
    expect(numerDoMaila('SD 122718', { externalId: '122718', channelNumber: null })).toBe('SD 122718')
    expect(numerDoMaila('SD 159076', { externalId: '122718', channelNumber: '159076' })).toBe('SD 159076')
  })
})

describe('mail „Faktura” z przesyłką', () => {
  const dane = DANE_PRZYKLADOWE.faktura
  it('pokazuje numer przesyłki i przycisk śledzenia, gdy są', () => {
    const m = renderujMail('faktura', KONTEKST_PRZYKLADOWY, { ...dane, numerPrzesylki: '620999667762053436691541', linkSledzenia: 'https://inpost.pl/sledzenie-przesylek?number=620999667762053436691541' })
    expect(m.tekst).toContain('Numer przesyłki')
    expect(m.tekst).toContain('620999667762053436691541')
    expect(m.html).toContain('https://inpost.pl/sledzenie-przesylek?number=620999667762053436691541')
    expect(m.html).toContain('Śledź przesyłkę')
    // bez twierdzenia „wysłane”, gdy paczka może jeszcze czekać na kuriera
    expect(m.tekst).not.toContain('zostało wysłane')
    expect(m.tekst).toContain('Paczka jest spakowana. Po odbiorze przez kuriera jej drogę można sprawdzić na stronie przewoźnika.')
  })
  it('bez przesyłki wygląda jak dotąd', () => {
    const m = renderujMail('faktura', KONTEKST_PRZYKLADOWY, dane)
    expect(m.tekst).not.toContain('Numer przesyłki')
    expect(m.html).not.toContain('Śledź przesyłkę')
    expect(m.tekst).not.toContain('Zamówienie zostało wysłane')
  })
})
