// Oś statusów przesyłki: słownik wspólny dla przewoźników, mapowanie kodów InPost, DPD, Allegro i Poczty Polskiej,
// odstępy odpytywania i czas zdarzenia u przewoźnika. Czyste funkcje, bez bazy i bez sieci.
import { describe, expect, it } from 'vitest'
import { ShipmentTrackState } from '@prisma/client'
import { stanDrogiShipX } from '../adaptery/inpost-zapis'
import { stanDrogiDpd } from '../adaptery/dpd'
import { stanDrogiAllegro } from '../adaptery/allegro-wysylam-zapis'
import { stanDrogiPoczty } from '../adaptery/pocztapolska'
import { odstepPoBledzie, SLEDZENIE_BLEDY_STOP, stanDoZapisu } from '../pakowanie/wyslane-po-przyjezdzie'
import {
  czasPrzewoznika,
  jestKoncowy,
  odstepSledzenia,
  OPIS_STANU_DROGI,
  poPrzekazaniu,
  STANY_DROGI,
  stanDrogiZeStanu,
  SLEDZENIE_DO_KONCA_DNI,
} from './stany-przesylki'

const H = 3600_000

describe('stan do zapisu przy przesyłce (host, jedno miejsce dla przewoźników)', () => {
  const utw = new Date('2026-11-10T08:00:00Z')
  const s = (trackState: ShipmentTrackState | null, handedOverAt: Date | null = null) => ({ trackState, handedOverAt, createdAt: utw })
  it('nieznany nie nadpisuje znanego stanu', () => {
    expect(stanDoZapisu('NIEZNANY', null, s('W_DORECZENIU', utw)).stan).toBe('W_DORECZENIU')
    expect(stanDoZapisu('NIEZNANY', null, s('NIEUDANE_DORECZENIE', utw)).stan).toBe('NIEUDANE_DORECZENIE')
    expect(stanDoZapisu('NIEZNANY', null, s(null)).stan).toBe('NIEZNANY')
    expect(stanDoZapisu('NIEZNANY', null, s('NIEZNANY')).stan).toBe('NIEZNANY')
  })
  it('po zapisanym zwrocie doręczenie (do nadawcy) i każdy inny stan zostają zwrotem', () => {
    for (const odczyt of ['DORECZONA', 'W_DORECZENIU', 'W_DRODZE', 'ANULOWANA'] as const) expect(stanDoZapisu(odczyt, null, s('ZWROT', utw)).stan).toBe('ZWROT')
  })
  it('stan końcowy ze zdarzenia sprzed utworzenia przesyłki = nieznany z ostrzeżeniem; niekońcowy przechodzi', () => {
    const stare = new Date('2026-10-01T10:00:00Z')
    expect(stanDoZapisu('DORECZONA', stare, s(null))).toEqual({ stan: 'NIEZNANY', przedUtworzeniem: true })
    expect(stanDoZapisu('ZWROT', stare, s('W_DRODZE', utw))).toEqual({ stan: 'W_DRODZE', przedUtworzeniem: true })
    expect(stanDoZapisu('W_DRODZE', stare, s(null))).toEqual({ stan: 'W_DRODZE', przedUtworzeniem: false })
    expect(stanDoZapisu('DORECZONA', new Date('2026-11-11T10:00:00Z'), s('W_DORECZENIU', utw))).toEqual({ stan: 'DORECZONA', przedUtworzeniem: false })
  })
  it('po przekazaniu nie wraca do „utworzona” ani „anulowana”; przed przekazaniem tak', () => {
    expect(stanDoZapisu('UTWORZONA', null, s('W_DRODZE', utw)).stan).toBe('W_DRODZE')
    expect(stanDoZapisu('ANULOWANA', null, s('W_PUNKCIE', utw)).stan).toBe('W_PUNKCIE')
    expect(stanDoZapisu('ANULOWANA', null, s(null, utw)).stan).toBe('PRZEKAZANA')
    expect(stanDoZapisu('ANULOWANA', null, s('UTWORZONA')).stan).toBe('ANULOWANA')
    expect(stanDoZapisu('UTWORZONA', null, s(null)).stan).toBe('UTWORZONA')
  })
  it('odstęp po błędzie przesyłki: 30 min × 2^(n−1), najwyżej 12 h', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(odstepPoBledzie)).toEqual([0.5 * H, H, 2 * H, 4 * H, 8 * H, 12 * H, 12 * H, 12 * H])
    expect(SLEDZENIE_BLEDY_STOP).toBe(20)
  })
})

describe('słownik stanów drogi paczki', () => {
  it('ten sam zestaw co enum w bazie, każdy stan ma polski opis', () => {
    expect([...STANY_DROGI].sort()).toEqual(Object.values(ShipmentTrackState).sort())
    for (const s of STANY_DROGI) expect(OPIS_STANU_DROGI[s]).toMatch(/^\p{Lu}/u)
  })

  it('stany końcowe: doręczona, zwrot, anulowana; reszta śledzona dalej', () => {
    expect(STANY_DROGI.filter(jestKoncowy).sort()).toEqual(['ANULOWANA', 'DORECZONA', 'ZWROT'])
  })

  it('po przekazaniu: od odbioru przez kuriera do zwrotu; utworzona, anulowana i nieznany nie', () => {
    expect(STANY_DROGI.filter(poPrzekazaniu).sort()).toEqual(['DORECZONA', 'NIEUDANE_DORECZENIE', 'PROBLEM', 'PRZEKAZANA', 'W_DORECZENIU', 'W_DRODZE', 'W_PUNKCIE', 'ZWROT'])
  })

  it('odstęp zależny od stanu: przed odbiorem i w doręczeniu częściej, w drodze i w punkcie rzadziej; końcowe bez odstępu', () => {
    expect(odstepSledzenia('UTWORZONA')).toBe(30 * 60_000)
    expect(odstepSledzenia(null)).toBe(30 * 60_000)
    expect(odstepSledzenia('W_DORECZENIU')).toBe(H)
    expect(odstepSledzenia('PRZEKAZANA')).toBe(3 * H)
    expect(odstepSledzenia('W_DRODZE')).toBe(3 * H)
    expect(odstepSledzenia('W_PUNKCIE')).toBe(6 * H)
    expect(odstepSledzenia('NIEUDANE_DORECZENIE')).toBe(3 * H)
    expect(odstepSledzenia('PROBLEM')).toBe(6 * H)
    expect(odstepSledzenia('NIEZNANY')).toBe(2 * H)
    for (const s of ['DORECZONA', 'ZWROT', 'ANULOWANA'] as const) expect(odstepSledzenia(s)).toBeNull()
    for (const s of STANY_DROGI) if (!jestKoncowy(s)) expect(odstepSledzenia(s)).toBeGreaterThanOrEqual(30 * 60_000)
    expect(SLEDZENIE_DO_KONCA_DNI).toBe(30)
  })

  it('stan z dawnego kontraktu, gdy moduł nie podaje osi', () => {
    expect(stanDrogiZeStanu('PRZED_NADANIEM')).toBe('UTWORZONA')
    expect(stanDrogiZeStanu('PRZEKAZANA')).toBe('PRZEKAZANA')
    expect(stanDrogiZeStanu('ANULOWANA')).toBe('ANULOWANA')
    expect(stanDrogiZeStanu('NIEZNANY')).toBe('NIEZNANY')
  })
})

describe('czas zdarzenia u przewoźnika', () => {
  const now = new Date('2026-11-14T12:00:00Z')
  it('ze strefą: bez zmian; bez strefy: czas polski (zima +1, lato +2)', () => {
    expect(czasPrzewoznika('2026-11-13T10:15:00Z', now)?.toISOString()).toBe('2026-11-13T10:15:00.000Z')
    expect(czasPrzewoznika('2026-11-13T10:15:00+01:00', now)?.toISOString()).toBe('2026-11-13T09:15:00.000Z')
    expect(czasPrzewoznika('2026-11-13T10:15:00', now)?.toISOString()).toBe('2026-11-13T09:15:00.000Z')
    expect(czasPrzewoznika('2026-11-13 10:15', now)?.toISOString()).toBe('2026-11-13T09:15:00.000Z')
    expect(czasPrzewoznika('2026-07-13T10:15:00', new Date('2026-08-01T00:00:00Z'))?.toISOString()).toBe('2026-07-13T08:15:00.000Z')
  })
  it('śmieci, pusty i czas z przyszłości (ponad godzinę) = brak czasu', () => {
    expect(czasPrzewoznika(null, now)).toBeNull()
    expect(czasPrzewoznika('', now)).toBeNull()
    expect(czasPrzewoznika('wczoraj', now)).toBeNull()
    expect(czasPrzewoznika('2026-13-45T99:00:00', now)).toBeNull()
    expect(czasPrzewoznika('2026-11-14T15:00:00Z', now)).toBeNull()
    expect(czasPrzewoznika('1999-01-01T00:00:00Z', now)).toBeNull()
  })
  it('noc zmiany czasu 29.03 (02:00 → 03:00): przed, w luce (godzina nieistniejąca = przesunięta do przodu) i po', () => {
    expect(czasPrzewoznika('2026-03-29T01:30:00', now)?.toISOString()).toBe('2026-03-29T00:30:00.000Z')
    expect(czasPrzewoznika('2026-03-29T02:30:00', now)?.toISOString()).toBe('2026-03-29T01:30:00.000Z')
    expect(czasPrzewoznika('2026-03-29T03:10:00', now)?.toISOString()).toBe('2026-03-29T01:10:00.000Z')
  })
  it('noc zmiany czasu 25.10 (03:00 → 02:00): godzina dwuznaczna = drugie wystąpienie (czas zimowy)', () => {
    expect(czasPrzewoznika('2026-10-25T01:30:00', now)?.toISOString()).toBe('2026-10-24T23:30:00.000Z')
    expect(czasPrzewoznika('2026-10-25T02:30:00', now)?.toISOString()).toBe('2026-10-25T01:30:00.000Z')
    expect(czasPrzewoznika('2026-10-25T03:10:00', now)?.toISOString()).toBe('2026-10-25T02:10:00.000Z')
  })
})

describe('InPost ShipX → oś', () => {
  it.each([
    ['created', 'UTWORZONA'],
    ['confirmed', 'UTWORZONA'],
    ['taken_by_courier', 'PRZEKAZANA'],
    ['dispatched_by_sender', 'PRZEKAZANA'],
    ['collected_from_sender', 'PRZEKAZANA'],
    ['adopted_at_sorting_center', 'W_DRODZE'],
    ['sent_from_source_branch', 'W_DRODZE'],
    ['out_for_delivery', 'W_DORECZENIU'],
    ['ready_to_pickup', 'W_PUNKCIE'],
    ['pickup_reminder_sent', 'W_PUNKCIE'],
    ['stack_in_box_machine', 'W_PUNKCIE'],
    ['delivered', 'DORECZONA'],
    ['courier_avizo_in_customer_service_point', 'NIEUDANE_DORECZENIE'],
    ['undelivered_wrong_address', 'NIEUDANE_DORECZENIE'],
    // decyzja nadzorcy 14.11: po wygaśnięciu odbioru i odmowie paczka jedzie do nadawcy, dalsze kody ShipX
    // (taken_by_courier, out_for_delivery) to droga powrotna, więc stan końcowy ZWROT zamiast „w doręczeniu”
    ['pickup_time_expired', 'ZWROT'],
    ['rejected_by_receiver', 'ZWROT'],
    ['returned_to_sender', 'ZWROT'],
    ['claimed', 'PROBLEM'],
    ['canceled', 'ANULOWANA'],
    ['status_spoza_listy', 'NIEZNANY'],
  ] as const)('%s → %s', (kod, stan) => {
    expect(stanDrogiShipX(kod)).toBe(stan)
  })
  it('brak statusu (404) = nieznany', () => {
    expect(stanDrogiShipX(null)).toBe('NIEZNANY')
  })
  // publiczna lista GET /v1/statuses z 14.11.2026 (opisy InPost w komentarzach)
  it.each([
    ['avizo', 'NIEUDANE_DORECZENIE'], // „Powrót do oddziału”: stan niekońcowy, zwrot dopiero z returned_to_sender
    ['taken_by_courier_from_customer_service_point', 'ZWROT'], // „Zwrócona do nadawcy … wyruszy w podróż powrotną”
    ['pickup_reminder_sent_address', 'NIEUDANE_DORECZENIE'], // „nie zastał Odbiorcy, kolejna próba w następnym dniu”
    ['ready_to_pickup_from_pok_registered', 'W_PUNKCIE'],
    ['delay_in_delivery', 'W_DRODZE'],
    ['redirect_to_box', 'W_DRODZE'],
    ['canceled_redirect_to_box', 'W_DRODZE'],
    ['readdressed', 'W_DRODZE'],
    ['unstack_from_customer_service_point', 'W_DRODZE'],
    ['stack_parcel_pickup_time_expired', 'W_DRODZE'], // magazynowana, kurier zabierze ją do automatu
    ['stack_parcel_in_box_machine_pickup_time_expired', 'W_DRODZE'],
    ['return_pickup_confirmation_to_sender', 'DORECZONA'], // „Przesyłka została odebrana. Zwrotne potwierdzenie …”
    ['other', 'NIEZNANY'],
    ['missing', 'NIEZNANY'], // bez opisu w liście, do potwierdzenia u InPost
  ] as const)('lista InPost: %s → %s', (kod, stan) => {
    expect(stanDrogiShipX(kod)).toBe(stan)
  })
})

describe('DPD (businessCode) → oś: ostatnie zdarzenie ze znanym znaczeniem', () => {
  const z = (kod: string, czas: string) => ({ kod, opis: null, czas })
  it('bez zdarzeń = utworzona; sama rejestracja = utworzona', () => {
    expect(stanDrogiDpd([])).toEqual({ stanDrogi: 'UTWORZONA', czas: null, kod: null, przekazanaO: null })
    expect(stanDrogiDpd([z('030103', '2026-11-12T08:00:00')])).toEqual({ stanDrogi: 'UTWORZONA', czas: '2026-11-12T08:00:00', kod: '030103', przekazanaO: null })
  })
  it('kolejne etapy drogi', () => {
    const d = [z('030103', '2026-11-12T08:00:00'), z('040101', '2026-11-12T14:00:00')]
    expect(stanDrogiDpd(d).stanDrogi).toBe('PRZEKAZANA')
    d.push(z('050101', '2026-11-12T22:00:00'))
    expect(stanDrogiDpd(d).stanDrogi).toBe('W_DRODZE')
    d.push(z('170101', '2026-11-13T07:30:00'))
    expect(stanDrogiDpd(d).stanDrogi).toBe('W_DORECZENIU')
    d.push(z('190101', '2026-11-13T11:40:00'))
    expect(stanDrogiDpd(d)).toEqual({ stanDrogi: 'DORECZONA', czas: '2026-11-13T11:40:00', kod: '190101', przekazanaO: '2026-11-12T14:00:00' })
  })
  it('kolejność z czasu, nie z listy; kody neutralne i nieznane nie zmieniają stanu', () => {
    const d = [z('190101', '2026-11-13T11:40:00'), z('170310', '2026-11-13T12:00:00'), z('999999', '2026-11-13T13:00:00'), z('040101', '2026-11-12T14:00:00')]
    // kod = zdarzenie, z którego wyliczono stan (doręczenie), nie ostatnie zdarzenie na liście
    expect(stanDrogiDpd(d)).toEqual({ stanDrogi: 'DORECZONA', czas: '2026-11-13T11:40:00', kod: '190101', przekazanaO: '2026-11-12T14:00:00' })
  })
  it('same kody nieznane = nieznany', () => {
    expect(stanDrogiDpd([z('999999', '2026-11-13T13:00:00')]).stanDrogi).toBe('NIEZNANY')
  })
  it.each([
    ['200201', 'NIEUDANE_DORECZENIE'],
    ['200300', 'NIEUDANE_DORECZENIE'],
    ['500411', 'NIEUDANE_DORECZENIE'],
    ['200602', 'W_PUNKCIE'],
    ['230403', 'ZWROT'],
    ['500610', 'ZWROT'],
    ['230309', 'PROBLEM'],
    ['230310', 'PROBLEM'],
    ['410135', 'DORECZONA'],
    ['501300', 'DORECZONA'],
    ['120101', 'W_DRODZE'],
    ['230402', 'W_DRODZE'],
    ['170302', 'W_DRODZE'],
  ] as const)('%s → %s', (kod, stan) => {
    expect(stanDrogiDpd([z('040101', '2026-11-12T14:00:00'), z(kod, '2026-11-13T10:00:00')]).stanDrogi).toBe(stan)
  })
  it('dokumenty zwrotne do nadawcy (240304) to nie zwrot paczki', () => {
    expect(stanDrogiDpd([z('190101', '2026-11-13T11:40:00'), z('240304', '2026-11-13T12:00:00')]).stanDrogi).toBe('DORECZONA')
  })
  it('zwrot, a po nim doręczenie (do nadawcy) = zwrot z czasem i kodem zdarzenia zwrotu', () => {
    const d = [z('040101', '2026-11-12T14:00:00'), z('230403', '2026-11-15T09:00:00'), z('170101', '2026-11-17T07:00:00'), z('190101', '2026-11-17T11:00:00')]
    expect(stanDrogiDpd(d)).toEqual({ stanDrogi: 'ZWROT', czas: '2026-11-15T09:00:00', kod: '230403', przekazanaO: '2026-11-12T14:00:00' })
    expect(stanDrogiDpd([z('040101', '2026-11-12T14:00:00'), z('500610', '2026-11-15T09:00:00'), z('190102', '2026-11-17T11:00:00')]).stanDrogi).toBe('ZWROT')
  })
  it('stany końcowe tylko z kodów wymienionych wprost; nieznany kod z prefiksem doręczenia albo zwrotu nie kończy śledzenia', () => {
    const przed = z('040101', '2026-11-12T14:00:00')
    for (const kod of ['190199', '191000', '410999', '501399', '500699']) expect(['DORECZONA', 'ZWROT']).not.toContain(stanDrogiDpd([przed, z(kod, '2026-11-13T10:00:00')]).stanDrogi)
    // nieznany 19xxxx, 41xxxx, 5013xx = bez znaczenia dla osi (zostaje stan z poprzedniego zdarzenia)
    expect(stanDrogiDpd([przed, z('190199', '2026-11-13T10:00:00')])).toMatchObject({ stanDrogi: 'PRZEKAZANA', kod: '040101' })
    // nieznany 500xxx (w tym 5006xx spoza listy) = nieudane doręczenie, stan niekońcowy
    expect(stanDrogiDpd([przed, z('500699', '2026-11-13T10:00:00')]).stanDrogi).toBe('NIEUDANE_DORECZENIE')
    for (const kod of ['190101', '190105', '190201', '190205', '410135', '501300', '501304', '501340']) expect(stanDrogiDpd([przed, z(kod, '2026-11-13T10:00:00')]).stanDrogi).toBe('DORECZONA')
  })
  it('czas przekazania = pierwsze zdarzenie „u DPD”', () => {
    expect(stanDrogiDpd([z('030103', '2026-11-12T08:00:00'), z('050101', '2026-11-12T22:00:00'), z('040101', '2026-11-12T14:00:00')]).przekazanaO).toBe('2026-11-12T14:00:00')
    expect(stanDrogiDpd([z('030103', '2026-11-12T08:00:00'), z('170310', '2026-11-12T09:00:00')]).przekazanaO).toBeNull()
  })
})

describe('Wysyłam z Allegro → oś', () => {
  const s = (kod: string, czas: string) => ({ kod, czas })
  it('pierwsze IN_TRANSIT = przekazana, kolejne = w drodze', () => {
    expect(stanDrogiAllegro([s('PENDING', '2026-11-12T08:00:00Z')]).stanDrogi).toBe('UTWORZONA')
    expect(stanDrogiAllegro([s('PENDING', '2026-11-12T08:00:00Z'), s('IN_TRANSIT', '2026-11-12T14:00:00Z')])).toEqual({ stanDrogi: 'PRZEKAZANA', czas: '2026-11-12T14:00:00Z', kod: 'IN_TRANSIT', przekazanaO: '2026-11-12T14:00:00Z' })
    expect(stanDrogiAllegro([s('IN_TRANSIT', '2026-11-12T14:00:00Z'), s('IN_TRANSIT', '2026-11-12T22:00:00Z')]).stanDrogi).toBe('W_DRODZE')
  })
  it.each([
    ['RELEASED_FOR_DELIVERY', 'W_DORECZENIU'],
    ['AVAILABLE_FOR_PICKUP', 'W_PUNKCIE'],
    ['NOTICE_LEFT', 'NIEUDANE_DORECZENIE'],
    ['DELIVERED', 'DORECZONA'],
    ['RETURNED', 'ZWROT'],
    ['ISSUE', 'PROBLEM'],
  ] as const)('%s → %s', (kod, stan) => {
    expect(stanDrogiAllegro([s('IN_TRANSIT', '2026-11-12T14:00:00Z'), s(kod, '2026-11-13T10:00:00Z')]).stanDrogi).toBe(stan)
  })
  it('pusta historia = utworzona; same kody nieznane = nieznany', () => {
    expect(stanDrogiAllegro([])).toEqual({ stanDrogi: 'UTWORZONA', czas: null, kod: null, przekazanaO: null })
    expect(stanDrogiAllegro([s('NOWY_KOD', '2026-11-13T10:00:00Z')])).toMatchObject({ stanDrogi: 'NIEZNANY', kod: 'NOWY_KOD', przekazanaO: null })
  })
  it('zwrot, a po nim doręczenie (do nadawcy) = zwrot', () => {
    const h = [s('IN_TRANSIT', '2026-11-12T14:00:00Z'), s('RETURNED', '2026-11-15T09:00:00Z'), s('RELEASED_FOR_DELIVERY', '2026-11-17T07:00:00Z'), s('DELIVERED', '2026-11-17T11:00:00Z')]
    expect(stanDrogiAllegro(h)).toEqual({ stanDrogi: 'ZWROT', czas: '2026-11-15T09:00:00Z', kod: 'RETURNED', przekazanaO: '2026-11-12T14:00:00Z' })
  })
  it('czas przekazania = pierwsze zdarzenie po PENDING ze znanym kodem', () => {
    expect(stanDrogiAllegro([s('PENDING', '2026-11-12T08:00:00Z'), s('NOWY_KOD', '2026-11-12T09:00:00Z'), s('AVAILABLE_FOR_PICKUP', '2026-11-13T09:00:00Z')]).przekazanaO).toBe('2026-11-13T09:00:00Z')
  })
})

describe('Poczta Polska → oś (tylko kody potwierdzone)', () => {
  it.each([
    ['P_NAD', 'PRZEKAZANA'],
    ['P_D', 'DORECZONA'],
    ['P_A_AANZ', 'NIEUDANE_DORECZENIE'],
    ['P_INNY', 'NIEZNANY'],
  ] as const)('%s → %s', (kod, stan) => {
    expect(stanDrogiPoczty(kod)).toBe(stan)
  })
  it('brak zdarzeń = utworzona', () => {
    expect(stanDrogiPoczty(null)).toBe('UTWORZONA')
  })
})
