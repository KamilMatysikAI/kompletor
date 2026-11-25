// mapowanie zdarzeń DPDInfoServices na stan przesyłki i klient `getEventsForWaybillV1` (bez sieci).
import { describe, expect, it } from 'vitest'
import { DPD_DORECZONA, DPD_NEUTRALNE, DPD_PRZEKAZANA, stanZdarzenDpd } from './dpd'
import { DPD_INFO_URL, DPD_INFO_URL_RE, DpdInfoError, DpdSledzenie, kopertaZdarzen, zdarzeniaZOdpowiedzi, type ZdarzenieDpd } from '../zrodla/dpd-sledzenie'
import { FAULT_LOGOWANIA, odpowiedzZdarzen } from '../../tests/dpd-info-atrapa'

const z = (kod: string, czas: string, opis: string | null = null): ZdarzenieDpd => ({ kod, czas, opis })

describe('DPD: stan przesyłki ze zdarzeń', () => {
  it('zdarzenia paczki z 20.11.2026: odebrana przez kuriera = PRZEKAZANA, status i opis z ostatniego zdarzenia', () => {
    // kolejność jak w odpowiedzi DPD: najnowsze pierwsze
    const w = stanZdarzenDpd([
      z('330135', '2026-11-20T18:41:12.067', 'Przyjęcie przesyłki w oddziale DPD '),
      z('170310', '2026-11-20T14:35:08.41', 'Powiadomienie mail'),
      z('040101', '2026-11-20T14:32:40.534', 'Przesyłka odebrana przez Kuriera'),
      z('030103', '2026-11-20T11:46:37.848', 'Zarejestrowano dane przesyłki, przesyłka jeszcze nie nadana'),
    ])
    expect(w).toEqual({ stan: 'PRZEKAZANA', status: '330135', opis: 'Przyjęcie przesyłki w oddziale DPD', czas: '2026-11-20T18:41:12.067' })
  })

  it('sama rejestracja danych (030103) = PRZED_NADANIEM', () => {
    expect(stanZdarzenDpd([z('030103', '2026-11-20T11:46:37', 'Zarejestrowano dane przesyłki, przesyłka jeszcze nie nadana')])).toMatchObject({ stan: 'PRZED_NADANIEM', status: '030103' })
  })

  it('170310 (powiadomienie mail) NIGDY nie daje DORECZONA: sam, po rejestracji i po odbiorze', () => {
    expect(DPD_NEUTRALNE.has('170310')).toBe(true)
    expect(DPD_DORECZONA.has('170310')).toBe(false)
    expect(DPD_PRZEKAZANA.has('170310')).toBe(false)
    expect(stanZdarzenDpd([z('170310', '2026-11-20T14:35', 'Powiadomienie mail')]).stan).toBe('PRZED_NADANIEM')
    expect(stanZdarzenDpd([z('030103', '2026-11-20T11:46'), z('170310', '2026-11-20T11:50')])).toMatchObject({ stan: 'PRZED_NADANIEM', status: '030103' })
    expect(stanZdarzenDpd([z('030103', '2026-11-20T11:46'), z('040101', '2026-11-20T14:32'), z('170310', '2026-11-20T14:35')])).toMatchObject({ stan: 'PRZEKAZANA', status: '040101' })
  })

  it('doręczenie tylko z kodów PARCEL_DELIVERED (190101 itd.); wydanie do doręczenia 170102 to jeszcze PRZEKAZANA', () => {
    expect(stanZdarzenDpd([z('040101', '2026-11-20T14:32'), z('170102', '2026-11-21T08:07', 'Wydanie przesyłki do doręczenia')])).toMatchObject({ stan: 'PRZEKAZANA', status: '170102' })
    // mail po doręczeniu nie zasłania statusu doręczenia
    expect(stanZdarzenDpd([z('040101', '2026-11-20T14:32'), z('190101', '2026-11-21T12:10', 'Przesyłka doręczona '), z('170310', '2026-11-21T12:11', 'Powiadomienie mail')])).toEqual({
      stan: 'DORECZONA',
      status: '190101',
      opis: 'Przesyłka doręczona',
      czas: '2026-11-21T12:10',
    })
    for (const kod of ['190101', '190102', '190104', '190201', '410135', '501300']) expect(stanZdarzenDpd([z(kod, '2026-11-21T12:10')]).stan).toBe('DORECZONA')
    // nieznany kod z przedrostkiem 19 nie jest doręczeniem
    expect(stanZdarzenDpd([z('199999', '2026-11-21T12:10')]).stan).toBe('NIEZNANY')
  })

  it('zwrot do nadawcy: doręczenie po zwrocie to nie doręczenie klientowi (PRZEKAZANA)', () => {
    expect(stanZdarzenDpd([z('040101', '2026-11-20T14:32'), z('230403', '2026-11-25T10:00'), z('190101', '2026-11-27T10:00')]).stan).toBe('PRZEKAZANA')
  })

  it('nieznany kod bez zdarzeń „u DPD” = NIEZNANY (np. 170309 z 19.11); po odbiorze nieznany kod nie cofa stanu', () => {
    expect(stanZdarzenDpd([z('030103', '2026-11-19T11:00'), z('170309', '2026-11-20T16:19')]).stan).toBe('NIEZNANY')
    expect(stanZdarzenDpd([z('040101', '2026-11-19T15:00'), z('170309', '2026-11-20T16:19')])).toMatchObject({ stan: 'PRZEKAZANA', status: '170309' })
  })

  it('opis jak w Base Courier: bez e-maila i długich ciągów cyfr, najwyżej 120 znaków', () => {
    expect(stanZdarzenDpd([z('040101', '2026-11-20T14:32', 'Odebrana, kontakt jan@example.test')]).opis).toBeNull()
    expect(stanZdarzenDpd([z('040101', '2026-11-20T14:32', 'Odebrana 1055482442661U')]).opis).toBeNull()
    expect(stanZdarzenDpd([z('040101', '2026-11-20T14:32', 'x'.repeat(300))]).opis).toHaveLength(120)
  })

  it('przy równym czasie wygrywa zdarzenie podane wcześniej w odpowiedzi (DPD: najnowsze pierwsze)', () => {
    expect(stanZdarzenDpd([z('330135', '2026-11-20T18:41'), z('330137', '2026-11-20T18:41')]).status).toBe('330135')
  })
})

describe('DPD: klient DPDInfoServices', () => {
  const auth = { login: 'login-testowy', haslo: 'h<a>s&lo', kanal: '99999' }

  it('adres usługi z odczytu 20.11.2026 przechodzi przez zaporę adresu; koperta z kanałem, hasło zakodowane', () => {
    expect(DPD_INFO_URL_RE.test(DPD_INFO_URL)).toBe(true)
    const k = kopertaZdarzen('1055482442661U', auth)
    expect(k).toContain('<channel>99999</channel>')
    expect(k).toContain('<password>h&lt;a&gt;s&amp;lo</password>')
    expect(k).toContain('<waybill>1055482442661U</waybill><eventsSelectType>ALL</eventsSelectType><language>PL</language>')
  })

  it('parser: zdarzenia z odpowiedzi jak na produkcji; Fault o logowaniu = błąd konta', () => {
    const xml = odpowiedzZdarzen('1055482442661U', [{ kod: '040101', opis: 'Przesyłka odebrana przez Kuriera', czas: '2026-11-20T14:32:40.534' }])
    expect(zdarzeniaZOdpowiedzi(xml)).toEqual([{ kod: '040101', opis: 'Przesyłka odebrana przez Kuriera', czas: '2026-11-20T14:32:40.534' }])
    try {
      zdarzeniaZOdpowiedzi(FAULT_LOGOWANIA)
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(DpdInfoError)
      expect((e as DpdInfoError).zakres).toBe('KONTO')
    }
  })

  it('401 = błąd konta bez hasła w komunikacie; 5xx bez Faultu = przejściowy; zły numer listu = bez żądania', async () => {
    let wywolania = 0
    const klient = (status: number) =>
      new DpdSledzenie(DPD_INFO_URL, auth, async () => {
        wywolania++
        return new Response('x', { status })
      }, 1_000, { attempts: 1, baseDelayMs: 0 })
    await expect(klient(401).zdarzenia('1055482442661U')).rejects.toMatchObject({ zakres: 'KONTO', retryable: false })
    await expect(klient(503).zdarzenia('1055482442661U')).rejects.toMatchObject({ zakres: null, retryable: true })
    const przed = wywolania
    await expect(klient(200).zdarzenia('zły numer!')).rejects.toMatchObject({ zakres: 'PRZESYLKA' })
    expect(wywolania).toBe(przed)
  })

  it('adres spoza domeny DPD odrzucony (login i hasło nie idą gdzie indziej)', () => {
    expect(() => new DpdSledzenie('https://dpd.com.pl.zly.example/x', auth)).toThrow(/Zły adres/)
  })
})
