// `allegro.wysylam.zapis.v1` na atrapie HTTP: utworzenie przesyłki komendą asynchroniczną z odpytywaniem,
// jedna przesyłka przy powtórkach i zgubionej odpowiedzi, próba po odrzuceniu na nowym commandId, odszukanie po
// referencji, etykieta, numer nadania, anulowanie, wyłącznik i zakres. Dane fikcyjne (PII_SENTINELS), zero połączeń.
import { describe, expect, it, vi } from 'vitest'
import { API, AUTH, deliveryProposal, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FakeAllegroZapis, SHIPMENTS_WRITE, UA } from '@/tests/allegro-zapis-atrapa'
import { ALLEGRO_SECRETS as S } from './allegro'
import { ALLEGRO_WYSYLAM_KEY } from './allegro-wysylam'
import { ALLEGRO_WYSYLAM_ZAPIS_KEY, AllegroWysylamZapisAdapter, commandIdUtworzenia, CZEKAJ_MS, FUNKCJA_WYSYLAM, NADAWANIE_WYLACZONE, odbiorcaAllegro, telefonyAllegro } from './allegro-wysylam-zapis'
import { defaultRegistry } from './domyslne'
import { hasReferenceFinder, hasShipmentCanceller, hasShipmentCreator, type PreparedParcel, type RecipientAddress, type ShipmentCreateRequest } from './kontrakt'
import { PII_SENTINELS } from './suita-kontraktowa'
import { executeWrite } from './zapis'

const NOW = new Date('2026-11-06T10:00:00.000Z')
const iso = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString()
const ORDER = '29a8e3c0-7f1b-11ef-9d6f-0d1c5b7a1e01'
const REF = 'b3c1d9a2-1111-5222-8333-444455556666'
const integration = { organizationId: 'org', kind: 'carrier' as const, id: 'ALLEGRO/71045', name: 'Allegro', channel: 'ALLEGRO' as const, channelAccountId: '71045' }

const parcel: PreparedParcel = {
  courierCode: null,
  gabaryt: 'ALLEGRO_A',
  sideXCm: 8,
  sideYCm: 38,
  sideZCm: 64,
  weightKg: 1,
  codAmount: null,
  pickupPoint: null,
  problems: [{ kod: 'wymiary_domyslne', poziom: 'OSTRZEZENIE', tekst: 'robocze' }],
}
const recipient: RecipientAddress = { imieNazwisko: 'Odbiorca Poprawiony', firma: null, ulica: 'ul. Nowa 2', numerDomu: null, numerLokalu: null, kodPocztowy: '60-001', miasto: 'Poznań', kraj: 'PL', telefon: '600100200', email: null }
const req = (o: Partial<ShipmentCreateRequest> = {}): ShipmentCreateRequest => ({ parcel, carrier: 'ALLEGRO', recipient, potwierdzoneOstrzezenia: ['wymiary_domyslne'], orderExternalId: ORDER, ...o })

function make(fake: FakeAllegroZapis, config: Record<string, unknown> = { zapisWlaczony: true }): AllegroWysylamZapisAdapter {
  const pair = fake.base.issuePair()
  const a = defaultRegistry().create(ALLEGRO_WYSYLAM_ZAPIS_KEY, {
    integration,
    rawConfig: { apiUrl: API, authUrl: AUTH, userAgent: UA, ...config },
    rawSecrets: { [S.clientId]: FAKE_CLIENT_ID, [S.clientSecret]: FAKE_CLIENT_SECRET, [S.access]: pair.access, [S.refresh]: pair.refresh, [S.expiresAt]: iso(600) },
    fetch: fake.fetch,
    now: () => NOW,
    http: { retry: { attempts: 1, baseDelayMs: 0 }, minIntervalMs: 0, pollDelayMs: 0 },
    persistSecrets: async () => {},
  })
  if (!(a instanceof AllegroWysylamZapisAdapter)) throw new Error('zły adapter')
  return a
}

function fakeNow(): FakeAllegroZapis {
  const f = new FakeAllegroZapis()
  f.base.clock = () => NOW.getTime()
  f.wys.proposals.set(ORDER, deliveryProposal(ORDER))
  return f
}

describe('manifest', () => {
  it('zdolności nadawania obok podglądu; podgląd allegro.wysylam.v1 bez zmian (tylko odczyt)', () => {
    const r = defaultRegistry()
    const a = make(fakeNow())
    expect(hasShipmentCreator(a) && hasShipmentCanceller(a) && hasReferenceFinder(a)).toBe(true)
    expect(r.get(ALLEGRO_WYSYLAM_KEY)!.manifest.readOnly).toBe(true)
    expect(r.get(ALLEGRO_WYSYLAM_KEY)!.manifest.capabilities).not.toContain('shipment.create')
  })
})

describe('utworzenie przesyłki', () => {
  it('komenda z gabarytem i adresem z karty, odpytywanie do SUCCESS, id przesyłki; punkt z propozycji Allegro', async () => {
    const fake = fakeNow()
    fake.pendingPolls = 2
    const out = await make(fake).createShipment(req(), REF)
    expect(out.kind).toBe('OK')
    expect(fake.created).toHaveLength(1)
    if (out.kind === 'OK') expect(out.externalRef).toBe(fake.created[0])
    const cmd = fake.createCommands.get(commandIdUtworzenia(REF, 1))!
    expect(cmd.input['packages']).toEqual([{ type: 'PACKAGE', length: { value: 64, unit: 'CENTIMETER' }, width: { value: 38, unit: 'CENTIMETER' }, height: { value: 8, unit: 'CENTIMETER' }, weight: { value: 1, unit: 'KILOGRAMS' } }])
    expect(cmd.input['receiver']).toMatchObject({ name: 'Odbiorca Poprawiony', street: 'ul. Nowa 2', postalCode: '60-001', city: 'Poznań', point: 'WAW01A' })
    expect(cmd.input).not.toHaveProperty('deliveryMethodId')
  })

  it('wynik bez danych osobowych (wartownicy nie wychodzą w wyniku)', async () => {
    const fake = fakeNow()
    const out = JSON.stringify(await make(fake).createShipment(req(), REF))
    for (const s of PII_SENTINELS) expect(out).not.toContain(s)
  })

  it('powtórka tej samej referencji i zgubiona odpowiedź: jedna przesyłka', async () => {
    const fake = fakeNow()
    const a = make(fake)
    fake.writeFailures.push('NIEJEDNOZNACZNY_WYKONANY')
    const first = await executeWrite(a, REF, () => a.createShipment(req(), REF))
    expect(first.kind).toBe('OK')
    const again = await executeWrite(a, REF, () => a.createShipment(req(), REF))
    expect(again).toMatchObject({ kind: 'OK', externalRef: fake.created[0] })
    expect(fake.created).toHaveLength(1)
    expect(fake.createCommands.size).toBe(1)
  })

  it('odrzucenie przez Allegro: TRWALY; ponowienie tą samą referencją idzie nowym commandId i tworzy jedną przesyłkę', async () => {
    const fake = fakeNow()
    fake.nextCreateOutcome = ['ERROR']
    const a = make(fake)
    const out = await a.createShipment(req(), REF)
    expect(out.kind).toBe('TRWALY')
    if (out.kind !== 'OK') expect(out.message).toContain('INVALID_DIMENSIONS')
    expect(fake.created).toEqual([])
    expect(await a.findByReference(REF)).toEqual({ found: false })
    expect((await a.createShipment(req(), REF)).kind).toBe('OK')
    expect([...fake.createCommands.keys()]).toEqual([commandIdUtworzenia(REF, 1), commandIdUtworzenia(REF, 2)])
    expect(fake.created).toHaveLength(1)
  })

  it('Allegro wciąż tworzy po odpytywaniu: NIEJEDNOZNACZNY, odszukanie rzuca; po zakończeniu odszukanie znajduje', async () => {
    const fake = fakeNow()
    fake.pendingPolls = 50
    const a = make(fake)
    const out = await executeWrite(a, REF, () => a.createShipment(req(), REF))
    expect(out.kind).toBe('NIEJEDNOZNACZNY')
    fake.createCommands.get(commandIdUtworzenia(REF, 1))!.polls = 0
    expect(await a.findByReference(REF)).toEqual({ found: true, externalRef: fake.created[0] })
  })

  it('Allegro zapomniało próbę 1 (404), przesyłka jest pod próbą 2 → OK bez POST, odszukanie found:true', async () => {
    const fake = fakeNow()
    const id = '00000000-0000-4000-9000-0000000000a2'
    fake.created.push(id)
    fake.createCommands.set(commandIdUtworzenia(REF, 2), { polls: 0, outcome: 'SUCCESS', shipmentId: id, input: {} })
    const a = make(fake)
    expect(await a.createShipment(req(), REF)).toMatchObject({ kind: 'OK', externalRef: id })
    expect(await a.findByReference(REF)).toEqual({ found: true, externalRef: id })
    expect(fake.writes()).toEqual([])
    expect(fake.created).toEqual([id])
  })

  it('próba 1 nieznana, próba 3 w toku → czekamy na nią (bez POST); odszukanie rzuca, nie found:false', async () => {
    const fake = fakeNow()
    fake.createCommands.set(commandIdUtworzenia(REF, 3), { polls: 100, outcome: 'SUCCESS', shipmentId: '00000000-0000-4000-9000-0000000000a3', input: {} })
    const a = make(fake)
    expect((await a.createShipment(req(), REF)).kind).toBe('NIEJEDNOZNACZNY')
    await expect(a.findByReference(REF)).rejects.toThrow(/jeszcze tworzy/)
    expect(fake.writes()).toEqual([])
  })

  it('same odrzucone i nieznane → found:false; pierwsza wolna próba dostaje komendę', async () => {
    const fake = fakeNow()
    fake.createCommands.set(commandIdUtworzenia(REF, 2), { polls: 0, outcome: 'ERROR', shipmentId: null, input: {} })
    const a = make(fake)
    expect(await a.findByReference(REF)).toEqual({ found: false })
    expect((await a.createShipment(req(), REF)).kind).toBe('OK')
    expect(fake.createCommands.get(commandIdUtworzenia(REF, 1))?.outcome).toBe('SUCCESS')
    expect(fake.created).toHaveLength(1)
  })

  it('Allegro przyjęło komendę (201), ale jej nie pokazuje → PRZEJSCIOWY z prośbą o ponowienie', async () => {
    const fake = fakeNow()
    fake.hideCreateCommands = true
    const out = await make(fake).createShipment(req(), REF)
    expect(out.kind).toBe('PRZEJSCIOWY')
    if (out.kind !== 'OK') expect(out.message).toContain('przyjęło komendę, ale jeszcze jej nie pokazuje')
  })

  it('odpytywanie po wysłaniu ma deadline ścienny (nie trzyma akcji serwera ponad CZEKAJ_MS)', async () => {
    const fake = fakeNow()
    fake.pendingPolls = 1_000
    const a = defaultRegistry().create(ALLEGRO_WYSYLAM_ZAPIS_KEY, {
      integration,
      rawConfig: { apiUrl: API, authUrl: AUTH, userAgent: UA, zapisWlaczony: true },
      rawSecrets: (() => {
        const pair = fake.base.issuePair()
        return { [S.clientId]: FAKE_CLIENT_ID, [S.clientSecret]: FAKE_CLIENT_SECRET, [S.access]: pair.access, [S.refresh]: pair.refresh, [S.expiresAt]: iso(600) }
      })(),
      fetch: fake.fetch,
      now: () => NOW,
      // 6 odpytań co 10 s = 60 s bez deadline'u; z deadline'em (30 s) najwyżej 3
      http: { retry: { attempts: 1, baseDelayMs: 0 }, minIntervalMs: 0, pollDelayMs: 10_000 },
      persistSecrets: async () => {},
    }) as AllegroWysylamZapisAdapter
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    try {
      const p = a.createShipment(req(), REF)
      await vi.advanceTimersByTimeAsync(CZEKAJ_MS + 15_000)
      expect((await p).kind).toBe('NIEJEDNOZNACZNY')
    } finally {
      vi.useRealTimers()
    }
    const odczyty = fake.requests.filter((r) => r.startsWith('GET /shipment-management/shipments/create-commands/')).length
    // 5 odczytów prób przed wysłaniem + najwyżej 3 odpytania po
    expect(odczyty).toBeLessThanOrEqual(5 + 3)
  })

  it('odszukanie bez żadnej komendy = dowód, że przesyłki nie ma', async () => {
    expect(await make(fakeNow()).findByReference(REF)).toEqual({ found: false })
  })

  it('bez numeru formularza, bez propozycji dostawy, niepotwierdzone ostrzeżenie: TRWALY bez komendy', async () => {
    const fake = fakeNow()
    const a = make(fake)
    expect((await a.createShipment(req({ orderExternalId: undefined }), REF)).kind).toBe('TRWALY')
    expect((await a.createShipment(req({ orderExternalId: '00000000-0000-4000-8000-0000000000bb' }), REF)).kind).toBe('TRWALY')
    expect((await a.createShipment(req({ potwierdzoneOstrzezenia: [] }), REF)).kind).toBe('TRWALY')
    expect(fake.createCommands.size).toBe(0)
  })

  it('wyłącznik: TRWALY, zero żądań', async () => {
    const fake = fakeNow()
    const out = await make(fake, {}).createShipment(req(), REF)
    expect(out).toMatchObject({ kind: 'TRWALY', message: NADAWANIE_WYLACZONE })
    expect(fake.requests).toEqual([])
  })

  it('brak zakresu zapisu przesyłek: TRWALY z nazwą funkcji', async () => {
    const fake = fakeNow()
    fake.scopes.delete(SHIPMENTS_WRITE)
    const out = await make(fake).createShipment(req(), REF)
    expect(out.kind).toBe('TRWALY')
    if (out.kind !== 'OK') expect(out.message).toContain(FUNKCJA_WYSYLAM)
    expect(fake.created).toEqual([])
  })
})

describe('etykieta, numer, anulowanie', () => {
  it('etykieta PDF i numer nadania z przesyłki', async () => {
    const fake = fakeNow()
    const a = make(fake)
    const out = await a.createShipment(req(), REF)
    if (out.kind !== 'OK' || !out.externalRef) throw new Error('brak przesyłki')
    const l = await a.getLabel(out.externalRef, 'PDF')
    expect(l.contentType).toBe('application/pdf')
    expect(Buffer.from(l.base64, 'base64').toString()).toContain('%PDF')
    expect(await a.getTrackingNumber(out.externalRef)).toBe('AL000111222PL')
  })

  it('anulowanie: jedna komenda także przy powtórce; nieistniejąca przesyłka = TRWALY', async () => {
    const fake = fakeNow()
    const a = make(fake)
    const out = await a.createShipment(req(), REF)
    if (out.kind !== 'OK' || !out.externalRef) throw new Error('brak przesyłki')
    expect((await a.cancelShipment(out.externalRef, 'anul-1')).kind).toBe('OK')
    expect((await a.cancelShipment(out.externalRef, 'anul-1')).kind).toBe('OK')
    expect(fake.cancelCommands.size).toBe(1)
    expect(fake.cancelled).toEqual([out.externalRef])
    expect((await a.cancelShipment('00000000-0000-4000-9000-00000000ffff', 'anul-2')).kind).toBe('TRWALY')
    expect((await make(fake, {}).cancelShipment(out.externalRef, 'anul-3')).kind).toBe('TRWALY')
  })
})

describe('odbiorcaAllegro', () => {
  it('nadpisuje tylko podane pola, punkt odbioru zostaje', () => {
    expect(odbiorcaAllegro({ name: 'A', point: 'P1', email: 'x@example.invalid' }, { ...recipient, numerDomu: '5', numerLokalu: '3', ulica: 'Długa' })).toEqual({
      name: 'Odbiorca Poprawiony',
      point: 'P1',
      email: 'x@example.invalid',
      street: 'Długa 5/3',
      postalCode: '60-001',
      city: 'Poznań',
      countryCode: 'PL',
      phone: '600100200',
    })
  })
})

describe('telefon z prefiksem kraju (Allegro od 01.10.2026)', () => {
  it('komenda na atrapie: telefon odbiorcy z karty i nadawcy z propozycji z prefiksem +48', async () => {
    const fake = fakeNow()
    const out = await make(fake).createShipment(req({ recipient: { ...recipient, telefon: '600 100 200' } }), REF)
    expect(out.kind).toBe('OK')
    const cmd = fake.createCommands.get(commandIdUtworzenia(REF, 1))!
    expect((cmd.input['receiver'] as Record<string, unknown>)['phone']).toBe('+48600100200')
    expect((cmd.input['sender'] as Record<string, unknown>)['phone']).toBe('+48600100200')
  })

  it('numer zagraniczny odbiorcy zostaje ze swoim prefiksem', async () => {
    const fake = fakeNow()
    expect((await make(fake).createShipment(req({ recipient: { ...recipient, telefon: '+49 151 12345678' } }), REF)).kind).toBe('OK')
    expect((fake.createCommands.get(commandIdUtworzenia(REF, 1))!.input['receiver'] as Record<string, unknown>)['phone']).toBe('+4915112345678')
  })

  it('telefon odbiorcy bez prefiksu i nie polski albo śmieci: TRWALY z polem do poprawy, bez komendy, bez numeru w komunikacie', async () => {
    for (const telefon of ['015112345678', 'tel. 600100200', 'abc']) {
      const fake = fakeNow()
      const out = await make(fake).createShipment(req({ recipient: { ...recipient, telefon } }), REF)
      expect(out.kind, telefon).toBe('TRWALY')
      if (out.kind === 'TRWALY') {
        expect(out.message).toContain('telefon odbiorcy')
        expect(out.message).not.toContain('600100200')
        expect(out.message).not.toContain('015112345678')
      }
      expect(fake.createCommands.size).toBe(0)
    }
  })

  it('telefon nadawcy z propozycji bez prefiksu i nieczytelny: TRWALY „telefon nadawcy”, bez komendy', async () => {
    const fake = fakeNow()
    const pr = deliveryProposal(ORDER)
    const si = pr['suggestedInput'] as Record<string, unknown>
    si['sender'] = { ...(si['sender'] as Record<string, unknown>), phone: '12 34' }
    fake.wys.proposals.set(ORDER, pr)
    const out = await make(fake).createShipment(req(), REF)
    expect(out.kind).toBe('TRWALY')
    if (out.kind === 'TRWALY') expect(out.message).toContain('telefon nadawcy')
    expect(fake.createCommands.size).toBe(0)
  })

  it('odbiorca z CZ bez prefiksu = TRWALY bez komendy; z +420 = OK z prefiksem czeskim', async () => {
    const zly = fakeNow()
    const out = await make(zly).createShipment(req({ recipient: { ...recipient, kraj: 'CZ', telefon: '601 123 456' } }), REF)
    expect(out.kind).toBe('TRWALY')
    if (out.kind === 'TRWALY') {
      expect(out.message).toContain('telefon odbiorcy')
      expect(out.message).not.toContain('601')
    }
    expect(zly.createCommands.size).toBe(0)
    const dobry = fakeNow()
    expect((await make(dobry).createShipment(req({ recipient: { ...recipient, kraj: 'CZ', telefon: '+420 601 123 456' } }), REF)).kind).toBe('OK')
    expect((dobry.createCommands.get(commandIdUtworzenia(REF, 1))!.input['receiver'] as Record<string, unknown>)['phone']).toBe('+420601123456')
  })

  it('atrapa odrzuca (422) obecny telefon bez „+” — komenda z surowym numerem nie przechodzi', async () => {
    const fake = fakeNow()
    const r = await fake.fetch(`${API}/shipment-management/shipments/create-commands`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fake.base.issuePair().access}`, 'content-type': 'application/vnd.allegro.public.v1+json' },
      body: JSON.stringify({ commandId: '00000000-0000-4000-8000-0000000000aa', input: { sender: { phone: '+48600100200' }, receiver: { phone: '600100200' }, packages: [] } }),
    })
    expect(r.status).toBe(422)
    const ok = await fake.fetch(`${API}/shipment-management/shipments/create-commands`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fake.base.issuePair().access}`, 'content-type': 'application/vnd.allegro.public.v1+json' },
      body: JSON.stringify({ commandId: '00000000-0000-4000-8000-0000000000ab', input: { sender: { phone: '+48600100200' }, receiver: { phone: '+48600100200' }, packages: [] } }),
    })
    expect(ok.status).toBe(201)
  })

  it('telefonyAllegro: brak telefonu zostaje bez zmian, liczba jako numer, inne pola nietknięte', () => {
    expect(telefonyAllegro({ sender: { name: 'A' }, receiver: { phone: '', point: 'P' } })).toEqual({ input: { sender: { name: 'A' }, receiver: { phone: '', point: 'P' } } })
    expect(telefonyAllegro({ sender: { phone: 600100200 }, receiver: { phone: '+48 600 100 200' }, packages: [] })).toEqual({ input: { sender: { phone: '+48600100200' }, receiver: { phone: '+48600100200' }, packages: [] } })
    expect(telefonyAllegro({ receiver: { phone: { x: 1 } } })).toHaveProperty('blad')
  })
})
