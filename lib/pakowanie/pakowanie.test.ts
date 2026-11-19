// harmonogram odbiorów, strefy i kolejka pakowania (czyste funkcje). Daty w Warszawie: od 25.10.2026
// czas zimowy (UTC+1), więc 10:00Z = 11:00. 27.10.2026 to wtorek, 11.11 — święto (środa).
import { describe, expect, it } from 'vitest'
import {
  canPromiseToday,
  countdownText,
  dayLabel,
  formatHm,
  isPickupDay,
  nextPickup,
  parseHm,
  validateSchedule,
  type PickupArrivalT,
  type PickupScheduleT,
} from './harmonogram'
import { PRZYKLADOWE_ODBIORY as ACME_EXAMPLE_PICKUPS } from '@/tests/pakowanie-fixtures'
import { ACME_EXAMPLE_ZONE_RULES, ACME_PICKUPS } from '@/tests/preset-testowy'
import { buildQueue, handedOver, isUrgent, pageOfQueue, zakladkiKolejki, type QueueOrder } from './kolejka'
import { LEGACY_ZONES, matchesZone, orderZone, parseZoneFilter, productZone, validateZoneDef, validateZoneRule, zoneCounts, zoneFilterButtons, zoneKeyFromName } from './strefy'

const DPD = ACME_EXAMPLE_PICKUPS.find((s) => s.carrier === 'DPD')!
const INPOST = ACME_EXAMPLE_PICKUPS.find((s) => s.carrier === 'PACZKOMATY')!
const ALLEGRO = ACME_EXAMPLE_PICKUPS.find((s) => s.carrier === 'ALLEGRO')!
const at = (iso: string) => new Date(iso)
const arrived = (carrier: PickupArrivalT['carrier'], pickupDay: string, iso: string): PickupArrivalT => ({ carrier, pickupDay, arrivedAt: at(iso), actorName: 'Magazyn testowy' })

describe('harmonogram odbiorów', () => {
  it('godziny: zapis HH:MM ↔ minuty; zły zapis = null', () => {
    expect(parseHm('13:00')).toBe(780)
    expect(parseHm('9:05')).toBe(545)
    expect(parseHm('24:00')).toBeNull()
    expect(parseHm('13:7')).toBeNull()
    expect(formatHm(870)).toBe('14:30')
    expect(formatHm(5)).toBe('00:05')
  })

  it('walidacja: godziny w dobie, dni 1–7 bez powtórzeń, „wyślemy dziś do” nie po odbiorze', () => {
    expect(() => validateSchedule(DPD)).not.toThrow()
    expect(() => validateSchedule({ ...DPD, pickupMinute: 1440 })).toThrow()
    expect(() => validateSchedule({ ...DPD, weekdays: [0, 1] })).toThrow()
    expect(() => validateSchedule({ ...DPD, weekdays: [1, 1] })).toThrow()
    expect(() => validateSchedule({ ...DPD, weekdays: [] })).toThrow()
    expect(() => validateSchedule({ ...DPD, weekdays: [], active: false })).not.toThrow()
    expect(() => validateSchedule({ ...DPD, promiseUntilMinute: DPD.pickupMinute + 1 })).toThrow()
    expect(() => validateSchedule({ ...DPD, carrier: 'BRAK' })).toThrow()
    expect(() => validateSchedule({ ...DPD, carrier: 'BEZ_WYSYLKI' })).toThrow()
  })

  it('dzień odbioru: dni z harmonogramu, bez weekendu (gdy go nie ma) i bez świąt', () => {
    expect(isPickupDay(DPD, '2026-10-27')).toBe(true)
    expect(isPickupDay(DPD, '2026-10-31')).toBe(false) // sobota
    expect(isPickupDay(DPD, '2026-11-11')).toBe(false) // Święto Niepodległości
    expect(isPickupDay({ ...DPD, weekdays: [6] }, '2026-10-31')).toBe(true)
    expect(isPickupDay({ ...DPD, active: false }, '2026-10-27')).toBe(false)
  })

  it('najbliższy odbiór: dziś o godzinie w Warszawie; po czasie bez „Przyjechał” dalej dziś (kurier się spóźnia)', () => {
    const n = nextPickup(DPD, [], at('2026-10-27T10:00:00Z'))!
    expect(n.day).toBe('2026-10-27')
    expect(n.at.toISOString()).toBe('2026-10-27T12:00:00.000Z') // 13:00 CET
    expect(n.promiseUntil.toISOString()).toBe('2026-10-27T11:00:00.000Z')
    expect(nextPickup(DPD, [], at('2026-10-27T12:30:00Z'))!.day).toBe('2026-10-27')
    // czas letni: 13:00 CEST = 11:00Z
    expect(nextPickup(DPD, [], at('2026-06-02T06:00:00Z'))!.at.toISOString()).toBe('2026-06-02T11:00:00.000Z')
    expect(nextPickup(null, [], at('2026-10-27T10:00:00Z'))).toBeNull()
    expect(nextPickup({ ...DPD, active: false }, [], at('2026-10-27T10:00:00Z'))).toBeNull()
  })

  it('po „Przyjechał” następny odbiór: jutro; z piątku na poniedziałek; przez święto', () => {
    expect(nextPickup(DPD, [arrived('DPD', '2026-10-27', '2026-10-27T14:42:00Z')], at('2026-10-27T14:43:00Z'))!.day).toBe('2026-10-28')
    // „Przyjechał” innego przewoźnika nie zamyka odbioru DPD
    expect(nextPickup(DPD, [arrived('ALLEGRO', '2026-10-27', '2026-10-27T14:00:00Z')], at('2026-10-27T14:43:00Z'))!.day).toBe('2026-10-27')
    expect(nextPickup(DPD, [arrived('DPD', '2026-10-30', '2026-10-30T12:05:00Z')], at('2026-10-30T12:10:00Z'))!.day).toBe('2026-11-02')
    expect(nextPickup(DPD, [], at('2026-10-31T09:00:00Z'))!.day).toBe('2026-11-02') // sobota → poniedziałek
    expect(nextPickup(DPD, [arrived('DPD', '2026-11-10', '2026-11-10T12:00:00Z')], at('2026-11-10T13:00:00Z'))!.day).toBe('2026-11-12')
  })

  it('„wyślemy dziś do”: do godziny obietnicy w dzień odbioru, nie po przyjeździe kuriera, nie w sobotę', () => {
    expect(canPromiseToday(DPD, [], at('2026-10-27T10:59:00Z'))).toBe(true)
    expect(canPromiseToday(DPD, [], at('2026-10-27T11:00:00Z'))).toBe(false)
    expect(canPromiseToday(DPD, [arrived('DPD', '2026-10-27', '2026-10-27T09:00:00Z')], at('2026-10-27T09:30:00Z'))).toBe(false)
    expect(canPromiseToday(DPD, [], at('2026-10-31T08:00:00Z'))).toBe(false)
  })

  it('opisy: „do odjazdu H:MM”, „po czasie”, dziś / jutro / dzień tygodnia / data', () => {
    expect(countdownText(65)).toBe('do odjazdu 1:05')
    expect(countdownText(0)).toBe('do odjazdu 0:00')
    expect(countdownText(-12)).toBe('po czasie 0:12')
    const now = at('2026-10-27T10:00:00Z')
    expect(dayLabel('2026-10-27', 780, now)).toBe('dziś 13:00')
    expect(dayLabel('2026-10-28', 780, now)).toBe('jutro 13:00')
    expect(dayLabel('2026-11-02', 780, now)).toBe('pon. 13:00')
    expect(dayLabel('2026-11-12', 780, now)).toBe('12.11 13:00')
  })
})

describe('strefy', () => {
  const rules = ACME_EXAMPLE_ZONE_RULES
  it('produkt: ręczne ustawienie wygrywa, potem pierwsza reguła po priorytecie (nazwa albo SKU), inaczej brak', () => {
    expect(productZone({ title: 'Przyprawa czarna Assam 100 g', sku: 'HC-1', packingZone: null }, rules)).toEqual({ zone: 'HERBATY_KAWY', source: 'REGULA' })
    expect(productZone({ title: 'Lampa przyprawowa malina', sku: 'BH-1', packingZone: null }, rules)).toEqual({ zone: 'BOMBY_AKCESORIA', source: 'REGULA' })
    expect(productZone({ title: 'Kawa ziarnista Brazylia', sku: 'K-1', packingZone: null }, rules).zone).toBe('HERBATY_KAWY')
    expect(productZone({ title: 'Zestaw prezentowy', sku: 'ZAPARZACZ-7', packingZone: null }, rules).zone).toBe('BOMBY_AKCESORIA')
    expect(productZone({ title: 'Przyprawa w puszce', sku: 'X', packingZone: 'HERBATY_KAWY' }, rules)).toEqual({ zone: 'HERBATY_KAWY', source: 'RECZNIE' })
    expect(productZone({ title: 'Karta podarunkowa', sku: 'GIFT', packingZone: null }, rules)).toEqual({ zone: null, source: null })
    // kolejność po priorytecie, nie po kolejności w tablicy
    expect(productZone({ title: 'Lampa przyprawowa', sku: 'B', packingZone: null }, [...rules].reverse()).zone).toBe('BOMBY_AKCESORIA')
  })

  it('reguła: zły wzorzec i nieznana strefa odrzucone', () => {
    expect(() => validateZoneRule({ priority: 1, pattern: 'przypraw', zone: 'HERBATY_KAWY' })).not.toThrow()
    expect(() => validateZoneRule({ priority: 1, pattern: '(', zone: 'HERBATY_KAWY' })).toThrow()
    expect(() => validateZoneRule({ priority: 1, pattern: ' ', zone: 'HERBATY_KAWY' })).toThrow()
    expect(() => validateZoneRule({ priority: 1, pattern: 'x', zone: 'inna mała' })).toThrow()
    // z listą stref firmy klucz spoza listy odpada
    expect(() => validateZoneRule({ priority: 1, pattern: 'x', zone: 'INNA' }, ['HERBATY_KAWY'])).toThrow(/Nieznana strefa/)
    expect(() => validateZoneRule({ priority: 1, pattern: 'x', zone: 'HERBATY_KAWY' }, ['HERBATY_KAWY'])).not.toThrow()
  })

  it('strefa firmy — klucz z nazwy bez polskich znaków i unikalny, walidacja nazwy i koloru', () => {
    expect(zoneKeyFromName('Regał A — kawy', [])).toBe('REGAL_A_KAWY')
    expect(zoneKeyFromName('Żółta półka', [])).toBe('ZOLTA_POLKA')
    expect(zoneKeyFromName('Regał A', ['REGAL_A'])).toBe('REGAL_A_2')
    expect(zoneKeyFromName('Mieszane', [])).toBe('S_MIESZANE')
    expect(zoneKeyFromName('—', [])).toBe('STREFA')
    expect(() => validateZoneDef({ key: 'A', name: 'regał', color: 'zielen', sortOrder: 10 })).not.toThrow()
    expect(() => validateZoneDef({ key: 'A', name: ' ', color: 'zielen', sortOrder: 10 })).toThrow()
    expect(() => validateZoneDef({ key: 'A', name: 'x', color: 'rozowy', sortOrder: 10 })).toThrow()
    expect(() => validateZoneDef({ key: 'MIESZANE', name: 'x', color: 'szary', sortOrder: 10 })).toThrow()
    // ACME: dawne dwie strefy z kluczami jak w enum, nazwy neutralne
    expect(LEGACY_ZONES.map((z) => [z.key, z.name])).toEqual([['HERBATY_KAWY', 'produkty spożywcze'], ['BOMBY_AKCESORIA', 'akcesoria']])
  })

  it('zamówienie: jedna strefa wszystkich pozycji, inaczej „mieszane”; bez strefy = null', () => {
    expect(orderZone(['HERBATY_KAWY', 'HERBATY_KAWY'])).toBe('HERBATY_KAWY')
    expect(orderZone(['HERBATY_KAWY', 'BOMBY_AKCESORIA'])).toBe('MIESZANE')
    expect(orderZone(['BOMBY_AKCESORIA', null])).toBe('MIESZANE')
    expect(orderZone([null, null])).toBeNull()
    expect(orderZone([])).toBeNull()
  })

  it('filtr i liczby: strefa firmy / mieszane; bez strefy tylko we „wszystkich”', () => {
    const zs = ['HERBATY_KAWY', 'HERBATY_KAWY', 'BOMBY_AKCESORIA', 'MIESZANE', null] as const
    expect(zoneCounts(zs)).toEqual({ wszystkie: 5, mieszane: 1, bez: 1, strefy: { HERBATY_KAWY: 2, BOMBY_AKCESORIA: 1 } })
    expect(zs.filter((z) => matchesZone(z, 'HERBATY_KAWY'))).toHaveLength(2)
    expect(zs.filter((z) => matchesZone(z, 'mieszane'))).toEqual(['MIESZANE'])
    expect(zs.filter((z) => matchesZone(z, 'wszystkie'))).toHaveLength(5)
  })

  it('filtr z adresu — klucz strefy firmy, stare adresy sprzed stref firmy (herbaty, bomby), nieznany = wszystkie', () => {
    const acme = LEGACY_ZONES
    expect(parseZoneFilter('herbaty', acme)).toBe('HERBATY_KAWY')
    expect(parseZoneFilter('bomby', acme)).toBe('BOMBY_AKCESORIA')
    expect(parseZoneFilter('BOMBY_AKCESORIA', acme)).toBe('BOMBY_AKCESORIA')
    expect(parseZoneFilter('mieszane', acme)).toBe('mieszane')
    expect(parseZoneFilter('cokolwiek', acme)).toBe('wszystkie')
    expect(parseZoneFilter(undefined, acme)).toBe('wszystkie')
    // firma bez stref: bez filtrów, „herbaty” nic nie znaczy
    expect(parseZoneFilter('herbaty', [])).toBe('wszystkie')
    expect(parseZoneFilter('mieszane', [])).toBe('wszystkie')
    expect(zoneFilterButtons([], zoneCounts([]))).toEqual([])
    // ACME widzi te same filtry co przed zmianą (kolejność i podpisy)
    expect(zoneFilterButtons(acme, zoneCounts(['HERBATY_KAWY', 'MIESZANE'])).map((b) => [b.value, b.label, b.count])).toEqual([
      ['wszystkie', 'Wszystkie', 2],
      ['HERBATY_KAWY', 'Tylko produkty spożywcze', 1],
      ['BOMBY_AKCESORIA', 'Tylko akcesoria', 0],
      ['mieszane', 'Mieszane', 1],
    ])
  })
})

describe('kolejka pakowania', () => {
  const schedules: PickupScheduleT[] = [ALLEGRO, INPOST, DPD]
  let n = 0
  const o = (carrier: QueueOrder['carrier'], over: Partial<QueueOrder> = {}): QueueOrder => ({
    id: `o${++n}`,
    carrier,
    status: 'DO_REALIZACJI',
    packedAt: null,
    createdAtChannel: at(`2026-10-27T0${n % 10}:00:00Z`),
    zone: 'HERBATY_KAWY',
    ...over,
  })

  it('grupy od najbliższego odbioru: DPD 13:00, InPost 14:30, Allegro 15:00, potem bez harmonogramu, na końcu bez przewoźnika', () => {
    const orders = [o('ALLEGRO'), o(null), o('OSOBISTY'), o('PACZKOMATY'), o('DPD'), o('BRAK')]
    const g = buildQueue(orders, schedules, [], at('2026-10-27T10:00:00Z'))
    expect(g.map((x) => x.carrier)).toEqual(['DPD', 'PACZKOMATY', 'ALLEGRO', 'OSOBISTY', null])
    expect(g.at(-1)!.orders).toHaveLength(2) // BRAK i puste razem
    expect(g[0]!.minutesLeft).toBe(120)
    expect(g[0]!.label).toBe('DPD')
    expect(g[1]!.label).toBe('InPost')
  })

  it('godziny ACME z seedu (DPD 12:00, DPD Empik 12:00, Allegro 14:00, InPost 15:30): kolejność grup', () => {
    // zmiana godzin w ACME_PICKUPS nie może po cichu przestawić kolejności na ekranie
    expect(buildQueue([], ACME_PICKUPS, [], at('2026-10-27T10:00:00Z')).map((g) => g.carrier)).toEqual(['DPD', 'DPD_EMPIK', 'ALLEGRO', 'PACZKOMATY'])
  })

  it('przewoźnik z harmonogramem widoczny bez zamówień; nieaktywny harmonogram — tylko gdy ma zamówienia', () => {
    const g = buildQueue([], [DPD, { ...INPOST, active: false }], [], at('2026-10-27T10:00:00Z'))
    expect(g.map((x) => x.carrier)).toEqual(['DPD'])
    expect(g[0]).toMatchObject({ toPack: 0, packed: 0, handedOver: 0 })
  })

  it('„zostało N” = do spakowania; spakowane na końcu grupy, niespakowane od najstarszego', () => {
    const a = o('DPD', { createdAtChannel: at('2026-10-27T08:00:00Z') })
    const b = o('DPD', { createdAtChannel: at('2026-10-27T07:00:00Z'), status: 'ZBIERANIE' })
    const c = o('DPD', { createdAtChannel: at('2026-10-27T06:00:00Z'), status: 'SPAKOWANE', packedAt: at('2026-10-27T09:00:00Z') })
    const [g] = buildQueue([a, b, c], [DPD], [], at('2026-10-27T10:00:00Z'))
    expect(g!.orders.map((x) => x.id)).toEqual([b.id, a.id, c.id])
    expect(g).toMatchObject({ toPack: 2, packed: 1, handedOver: 0 })
  })

  it('„Przyjechał”: spakowane przed kliknięciem pojechały, spakowane po nim liczą się do następnego odbioru (jutro)', () => {
    const before = o('DPD', { status: 'SPAKOWANE', packedAt: at('2026-10-27T11:30:00Z') })
    const after = o('DPD', { status: 'SPAKOWANE', packedAt: at('2026-10-27T12:30:00Z') })
    const open = o('DPD')
    const inpost = o('PACZKOMATY', { status: 'SPAKOWANE', packedAt: at('2026-10-27T11:00:00Z') })
    const arr = [arrived('DPD', '2026-10-27', '2026-10-27T12:10:00Z')]
    const now = at('2026-10-27T12:40:00Z')
    const g = buildQueue([before, after, open, inpost], schedules, arr, now)
    // DPD jedzie jutro, więc InPost (dziś 14:30) wychodzi na pierwsze miejsce
    expect(g.map((x) => x.carrier)).toEqual(['PACZKOMATY', 'ALLEGRO', 'DPD'])
    const dpd = g.find((x) => x.carrier === 'DPD')!
    expect(dpd.pickup!.day).toBe('2026-10-28')
    expect(dpd.orders.map((x) => x.id)).toEqual([open.id, after.id])
    expect(dpd).toMatchObject({ toPack: 1, packed: 1, handedOver: 1 })
    expect(dpd.lastArrival!.arrivedAt.toISOString()).toBe('2026-10-27T12:10:00.000Z')
    // „Przyjechał DPD” nie rusza InPostu
    expect(g[0]!.orders.map((x) => x.id)).toEqual([inpost.id])
    expect(handedOver(before, arr[0]!)).toBe(true)
    expect(handedOver({ status: 'SPAKOWANE', packedAt: null }, arr[0]!)).toBe(false)
    expect(handedOver(before, null)).toBe(false)
  })

  it('pilny kurier: mniej niż godzina do odjazdu albo po czasie i są zamówienia do spakowania', () => {
    expect(isUrgent({ minutesLeft: 59, toPack: 1 })).toBe(true)
    expect(isUrgent({ minutesLeft: -5, toPack: 1 })).toBe(true)
    expect(isUrgent({ minutesLeft: 59, toPack: 0 })).toBe(false)
    expect(isUrgent({ minutesLeft: 61, toPack: 3 })).toBe(false)
    expect(isUrgent({ minutesLeft: null, toPack: 3 })).toBe(false)
  })

  it('strona kolejki tnie zamówienia w kolejności grup; puste grupy tylko na pierwszej stronie', () => {
    const orders = [o('DPD'), o('DPD'), o('DPD'), o('PACZKOMATY'), o('PACZKOMATY')]
    const g = buildQueue(orders, schedules, [], at('2026-10-27T10:00:00Z'))
    const p1 = pageOfQueue(g, 1, 2)
    expect(p1.pages).toBe(3)
    expect(p1.total).toBe(5)
    expect(p1.groups.map((x) => [x.carrier, x.orders.length])).toEqual([['DPD', 2], ['ALLEGRO', 0]])
    const p2 = pageOfQueue(g, 2, 2)
    expect(p2.groups.map((x) => [x.carrier, x.orders.length])).toEqual([['DPD', 1], ['PACZKOMATY', 1]])
    // liczby grupy z całej grupy, nie ze strony
    expect(p2.groups[0]!.toPack).toBe(3)
    expect(pageOfQueue(g, 99, 2).groups.map((x) => x.carrier)).toEqual(['PACZKOMATY'])
  })
})

describe('zakładki kolejki pakowania', () => {
  it('„Pakowanie próbne” bez zamówień jest ukryte, a jej adres pokazuje „Do spakowania”', () => {
    expect(zakladkiKolejki({ naprawde: 4, na_sucho: 0, etykiety: 0 }, 'na_sucho')).toEqual({ zakladka: 'naprawde', widoczne: ['naprawde', 'etykiety'] })
    expect(zakladkiKolejki({ naprawde: 0, na_sucho: 0, etykiety: 0 }, 'naprawde')).toEqual({ zakladka: 'naprawde', widoczne: ['naprawde', 'etykiety'] })
    expect(zakladkiKolejki({ naprawde: 4, na_sucho: 0, etykiety: 0 }, 'etykiety')).toEqual({ zakladka: 'etykiety', widoczne: ['naprawde', 'etykiety'] })
  })

  it('wraca sama, gdy jest zamówienie z konta w podglądzie', () => {
    expect(zakladkiKolejki({ naprawde: 0, na_sucho: 2, etykiety: 0 }, 'na_sucho')).toEqual({ zakladka: 'na_sucho', widoczne: ['naprawde', 'na_sucho', 'etykiety'] })
    expect(zakladkiKolejki({ naprawde: 3, na_sucho: 2, etykiety: 0 }, 'naprawde')).toEqual({ zakladka: 'naprawde', widoczne: ['naprawde', 'na_sucho', 'etykiety'] })
  })
})
