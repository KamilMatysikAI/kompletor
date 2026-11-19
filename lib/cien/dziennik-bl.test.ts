// parser dziennika BL (getJournalList) — oba pola id, zły wpis, inny typ, kilka zdarzeń jednego
// zamówienia, kursor (wpisy ≤ kursor pomijane), stronicowanie z limitem. Atrapa zamiast sieci, dane fikcyjne.
import { describe, expect, it } from 'vitest'
import type { BaseLinkerReadOnly } from '../zrodla/baselinker'
import { BL_LOG_STATUS_CHANGE, fetchBlJournal, fetchedAtPoZdarzeniu, latestPerOrder, parseJournalPage } from './dziennik-bl'

const D = 1_793_000_000 // sekundy, fikcyjna chwila

describe('parseJournalPage', () => {
  it('identyfikator wpisu z `log_id` albo `id`; zdarzenie = zamówienie, nowy status, chwila', () => {
    const p = parseJournalPage(
      {
        logs: [
          { log_id: 11, log_type: 18, order_id: 501, object_id: 3, date: D },
          { id: '12', log_type: '18', order_id: '502', object_id: '5', date: String(D + 60) },
        ],
      },
      0n,
    )
    expect(p.events).toEqual([
      { logId: 11n, blOrderId: 501, statusId: 3, at: new Date(D * 1000) },
      { logId: 12n, blOrderId: 502, statusId: 5, at: new Date((D + 60) * 1000) },
    ])
    expect(p).toMatchObject({ bad: 0, otherType: 0, old: 0, maxLogId: 12n })
  })

  it('zły wpis pominięty i policzony, przebieg idzie dalej; inny typ niż 18 pominięty, ale przesuwa kursor', () => {
    const p = parseJournalPage(
      {
        logs: [
          null,
          'tekst',
          { log_type: 18, order_id: 1, object_id: 3, date: D }, // bez id
          { log_id: 20, log_type: 18, order_id: 'x', object_id: 3, date: D }, // zły numer zamówienia
          { log_id: 21, log_type: 18, order_id: 7, date: D }, // bez statusu
          { log_id: 22, log_type: 18, order_id: 7, object_id: 3 }, // bez daty
          { log_id: 30, log_type: 7, order_id: 7, object_id: 99, date: D }, // inny typ
          { log_id: 23, log_type: BL_LOG_STATUS_CHANGE, order_id: 7, object_id: 4, date: D },
        ],
      },
      0n,
    )
    expect(p.events.map((e) => e.logId)).toEqual([23n])
    expect(p).toMatchObject({ bad: 6, otherType: 1, maxLogId: 30n })
  })

  it('wpisy o id ≤ kursor pomijane (nie wiadomo, czy last_log_id jest włączne); odpowiedź bez `logs` = pusta strona', () => {
    const p = parseJournalPage({ logs: [{ log_id: 5, log_type: 18, order_id: 1, object_id: 3, date: D }, { log_id: 6, log_type: 18, order_id: 1, object_id: 4, date: D }] }, 5n)
    expect(p.events.map((e) => e.logId)).toEqual([6n])
    expect(p.old).toBe(1)
    expect(parseJournalPage({ status: 'SUCCESS' }, 0n)).toMatchObject({ events: [], bad: 0, maxLogId: null })
    expect(parseJournalPage(null, 0n).events).toEqual([])
  })

  it('kilka zdarzeń jednego zamówienia: liczy się najnowsze (największe id wpisu)', () => {
    const p = parseJournalPage(
      {
        logs: [
          { log_id: 41, log_type: 18, order_id: 9, object_id: 2, date: D },
          { log_id: 43, log_type: 18, order_id: 9, object_id: 3, date: D + 120 },
          { log_id: 42, log_type: 18, order_id: 9, object_id: 5, date: D + 60 },
          { log_id: 44, log_type: 18, order_id: 8, object_id: 2, date: D },
        ],
      },
      0n,
    )
    const last = latestPerOrder(p.events)
    expect(last.map((e) => [e.blOrderId, e.statusId]).sort()).toEqual([
      [8, 2],
      [9, 3],
    ])
  })
})

/** Atrapa klienta BL: strony dziennika po `last_log_id` (wyłączne), po `size` wpisów. */
function fakeJournal(entries: Record<string, unknown>[], size = 2, opts: { failOnCall?: number; inclusive?: boolean } = {}) {
  const calls: Record<string, unknown>[] = []
  const bl = {
    async call(method: string, params: Record<string, unknown>) {
      expect(method).toBe('getJournalList')
      calls.push(params)
      if (opts.failOnCall === calls.length) throw new Error('BL getJournalList: atrapa')
      const last = Number(params['last_log_id'])
      // jak prawdziwy BaseLinker: zero odrzucone; 1 = od początku dziennika
      if (!(last > 0)) throw new Error("BL getJournalList: ERROR_BAD_PARAMETERS The 'last_log_id' field must be greater than zero.")
      const list = entries.filter((e) => (opts.inclusive || last === 1 ? Number(e['log_id']) >= last : Number(e['log_id']) > last))
      return { status: 'SUCCESS', logs: list.slice(0, size) }
    },
  } as unknown as BaseLinkerReadOnly
  return { bl, calls }
}

const entry = (id: number, order: number, status: number) => ({ log_id: id, log_type: 18, order_id: order, object_id: status, date: D + id })

describe('fetchBlJournal', () => {
  it('strony aż do pustej; filtr typu 18 w zapytaniu; kursor = największe id', async () => {
    const { bl, calls } = fakeJournal([entry(1, 100, 2), entry(2, 101, 3), entry(3, 100, 3)])
    const r = await fetchBlJournal(bl, 0n)
    expect(calls.map((c) => c['last_log_id'])).toEqual([1, 2, 3]) // kursor 0 → pytanie od 1 (BaseLinker odrzuca zero)
    expect(calls[0]).toMatchObject({ logs_types: [18] })
    expect(r).toMatchObject({ read: 3, pages: 3, lastLogId: 3n, complete: true })
    expect(r.events.map((e) => [e.blOrderId, e.statusId]).sort()).toEqual([
      [100, 3],
      [101, 3],
    ])
  })

  it('last_log_id włączne: powtórzony wpis pominięty, koniec przy braku postępu', async () => {
    const { bl, calls } = fakeJournal([entry(1, 100, 2), entry(2, 101, 3)], 10, { inclusive: true })
    const r = await fetchBlJournal(bl, 1n)
    expect(r).toMatchObject({ read: 1, skipped: 2, lastLogId: 2n, complete: true }) // wpis 1 i powtórzony 2
    expect(calls).toHaveLength(2)
  })

  it('limit stron → wynik niepełny z tym, co przeczytane; błąd kolejnej strony → niepełny; błąd pierwszej leci dalej', async () => {
    const many = Array.from({ length: 10 }, (_, i) => entry(i + 1, 200 + i, 3))
    const lim = await fetchBlJournal(fakeJournal(many, 2).bl, 0n, { maxPages: 3 })
    expect(lim).toMatchObject({ read: 6, lastLogId: 6n, complete: false })
    expect(lim.errors[0]).toMatch(/ponad 3 stron/)
    const second = await fetchBlJournal(fakeJournal(many, 2, { failOnCall: 2 }).bl, 0n)
    expect(second).toMatchObject({ read: 2, lastLogId: 2n, complete: false })
    await expect(fetchBlJournal(fakeJournal(many, 2, { failOnCall: 1 }).bl, 0n)).rejects.toThrow(/atrapa/)
  })
})

describe('fetchedAtPoZdarzeniu', () => {
  const teraz = new Date('2026-11-16T20:00:00Z')
  const zdarzenie = new Date('2026-11-15T10:00:00Z')
  it('odczyt kompletny: kopia pewna do teraz', () => {
    expect(fetchedAtPoZdarzeniu(true, teraz, new Date('2026-11-14T00:00:00Z'), zdarzenie)).toEqual(teraz)
  })
  it('odczyt niepełny: kopia pewna tylko do chwili zdarzenia, żeby późniejsze zdarzenie z następnego przebiegu nie zostało odrzucone', () => {
    const po = fetchedAtPoZdarzeniu(false, teraz, new Date('2026-11-14T00:00:00Z'), zdarzenie)
    expect(po).toEqual(zdarzenie)
    // drugie zdarzenie tego samego zamówienia, późniejsze niż pierwsze, a wcześniejsze niż „teraz” pierwszego przebiegu
    expect(po > new Date('2026-11-15T12:00:00Z')).toBe(false)
  })
  it('odczyt niepełny nie cofa chwili kopii nowszej niż zdarzenie (ten sam status)', () => {
    const kopia = new Date('2026-11-16T08:00:00Z')
    expect(fetchedAtPoZdarzeniu(false, teraz, kopia, zdarzenie)).toEqual(kopia)
  })
})
