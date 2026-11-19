// Faktura robocza VAT w wFirmie (`normal_draft`) dla wskazanego zamówienia: treść jak prawdziwa faktura, inne tylko
// `type` i `id_external`; bez `InvoiceAttempt` i bez zmian zamówienia; bezpieczniki po zapisie, przy ponowieniu
// i przy usuwaniu. Atrapa HTTP wFirmy (tests/wfirma-http-atrapa.ts), zero sieci, dane fikcyjne.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { OrderRecipient } from '@/lib/adaptery/kontrakt'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { PODGLAD_AUDIT } from '@/lib/klienci/odczyt'
import { rekordZOdbiorcy } from '@/lib/klienci/rekord'
import { zapiszRekordKlienta } from '@/lib/klienci/zapis'
import { ODBIORCA_AUDIT_ENTITY } from '@/lib/odbiorca/pobierz'
import { runWfirmaQueue } from '@/lib/rdzen/kolejka-wfirmy'
import { finishPicking, startPicking } from '@/lib/rdzen/przejscia'
import { packOrder } from '@/lib/rdzen/rozchod'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { FakturyWfirmaZapis } from '@/lib/wfirma/adapter-zapis'
import { idExternalRoboczej, idExternalStarejRoboczej, sprawdzRobocza, staraRoboczaZamowienia, usunRobocza, wystawRobocza, type ZaleznosciRoboczej } from '@/lib/wfirma/faktura-robocza'
import { WfirmaReadOnly } from '@/lib/zrodla/wfirma'
import { WfirmaZapis } from '@/lib/zrodla/wfirma-zapis'
import { fakturaRoboczaCli } from '@/scripts/faktura-robocza'
import { testDb, testSystemDb, truncateAll } from './db'
import { ACC, expectInvariants, order, product, seedBase, T0 } from './rdzen-fixtures'
import { KLUCZE_TESTOWE, WfirmaHttpAtrapa } from './wfirma-http-atrapa'

const db = testDb()
afterAll(() => db.$disconnect())

const KODY_VAT = { '23': 222, '8': 223, '5': 224, '0': 234 }
const ODBIORCA: OrderRecipient = {
  dostawa: { imieNazwisko: 'Jan Testowy', firma: null, ulica: 'Testowa', numerDomu: '1', numerLokalu: null, kodPocztowy: '00-001', miasto: 'Testowo', kraj: 'PL', telefon: null, email: null },
  punktOdbioru: null,
  faktura: null,
  problemy: [],
}
const Z_NIP: OrderRecipient = { ...ODBIORCA, faktura: { nazwa: 'Testowa Spółka z o.o.', nip: '5260001246', ulica: 'Testowa 1', kodPocztowy: '00-001', miasto: 'Testowo', kraj: 'PL' } }
const min = (m: number) => new Date(T0.getTime() + m * 60_000)

const ustawFaktury = (faktury: Record<string, unknown>) => testSystemDb().organization.update({ where: { id: 'test_a' }, data: { settings: { faktury: { kodyVat: KODY_VAT, seriaId: '9084290', ...faktury } } as never } })

function deps(w: WfirmaHttpAtrapa, nabywca: OrderRecipient = ODBIORCA): ZaleznosciRoboczej {
  return { odczyt: new WfirmaReadOnly(KLUCZE_TESTOWE, w.fetch, 0), zapis: new WfirmaZapis(KLUCZE_TESTOWE, w.fetch, 0), odbiorca: async () => nabywca }
}
const prawdziwyAdapter = (w: WfirmaHttpAtrapa) => new FakturyWfirmaZapis(new WfirmaReadOnly(KLUCZE_TESTOWE, w.fetch, 0), db, { zapis: new WfirmaZapis(KLUCZE_TESTOWE, w.fetch, 0), odbiorca: async () => ODBIORCA })

async function spakowane(lines: { productId: string; qty: number }[], over: Parameters<typeof order>[1] = {}): Promise<string> {
  const r = await ingestOrder(db, order(lines, over), { now: T0 })
  expect(r.status).toBe('DO_REALIZACJI')
  await startPicking(db, r.orderId!, { now: T0 })
  await finishPicking(db, r.orderId!, { now: T0 })
  await packOrder(db, r.orderId!, { now: T0 })
  return r.orderId!
}

/** Wszystko, co robocza mogłaby zmienić po stronie Kompletora. */
async function stanZamowienia(orderId: string) {
  return {
    order: await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { lines: true } }),
    rezerwacje: await db.reservation.findMany({ where: { orderId }, orderBy: { id: 'asc' } }),
    ruchy: await db.pendingMovement.findMany({ where: { orderId }, orderBy: { id: 'asc' } }),
    zdarzenia: await db.orderEvent.findMany({ where: { orderId }, orderBy: { id: 'asc' } }),
    proby: await db.invoiceAttempt.count(),
    stany: await db.stock.findMany({ orderBy: { productId: 'asc' } }),
    alerty: await db.alert.count(),
  }
}

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
})

describe('faktura robocza: treść jak prawdziwa, bez zmian w Kompletorze', () => {
  it('robocza: normal_draft, id_external próby, numer z numeracji roboczych; zamówienie, rezerwacje, stany i zdarzenia bez zmian; potem prawdziwa faktura tą samą treścią', async () => {
    await db.channelConfig.updateMany({ where: ACC.WOO_SD, data: { statusMode: 'PRACA' } })
    await ustawFaktury({ program: 'wfirma', fakturyWlaczone: true, fakturyWlaczoneOd: T0.toISOString() })
    const tea = await product(db, 'HERB-ROB', 5, { wfirmaGoodId: '7101' })
    const id = await spakowane([{ productId: tea, qty: 2 }], { totalGross: 32.99 })
    const w = new WfirmaHttpAtrapa()
    const przed = await stanZamowienia(id)

    const r = await wystawRobocza(db, id, deps(w))
    expect(r.kind).toBe('WYSTAWIONA')
    expect(w.faktury).toHaveLength(1)
    expect(w.faktury[0]).toMatchObject({ type: 'normal_draft', fullnumber: 'WRF 1', idExternal: `pr/${id}` })
    expect(idExternalRoboczej(id)).toBe(`pr/${id}`)
    expect(idExternalRoboczej(id).length).toBeLessThanOrEqual(32)
    expect(r.kind === 'WYSTAWIONA' && r.dokument.numer).toBe('WRF 1')
    // wyszukanie po nowym i po starym formacie (robocza z pierwszej próby), zapis, odczyt, kontrolne wyszukanie
    expect(w.sciezki).toEqual(['invoices/find', 'invoices/find', 'invoices/add', `invoices/get/${w.faktury[0]!.id}`, 'invoices/find'])
    expect(r.kind === 'WYSTAWIONA' && r.ostrzezenie).toBeFalsy()
    expect(await stanZamowienia(id)).toEqual(przed)

    // prawdziwa faktura tego zamówienia: robocza nie jest dla rdzenia fakturą paczki, więc wychodzi normalnie
    const st = await runWfirmaQueue(db, { faktury: prawdziwyAdapter(w) }, { now: min(1), tylkoPraca: true })
    expect(st.invoices).toBe(1)
    expect(w.faktury).toHaveLength(2)
    expect(w.faktury[1]).toMatchObject({ type: 'normal', idExternal: `${id}/1/1` })
    expect(w.ciala).toHaveLength(2)
    const robocza = JSON.parse(w.ciala[0]!) as { invoices: { invoice: Record<string, unknown> } }
    const prawdziwa = JSON.parse(w.ciala[1]!) as { invoices: { invoice: Record<string, unknown> } }
    // jedyne różnice: typ i id_external; kolejność pól ta sama
    expect(Object.keys(robocza.invoices.invoice)).toEqual(Object.keys(prawdziwa.invoices.invoice))
    expect({ ...robocza.invoices.invoice, type: 'normal', id_external: `${id}/1/1` }).toEqual(prawdziwa.invoices.invoice)
    await expectInvariants(db)
  })

  it('prawdziwa faktura: treść żądania invoices/add bajt w bajt jak dotąd', async () => {
    await db.channelConfig.updateMany({ where: ACC.WOO_SD, data: { statusMode: 'PRACA' } })
    await ustawFaktury({ program: 'wfirma', fakturyWlaczone: true, fakturyWlaczoneOd: T0.toISOString() })
    const tea = await product(db, 'HERB-BAJT', 5, { wfirmaGoodId: '7102' })
    const id = await spakowane([{ productId: tea, qty: 2 }], { totalGross: 32.99 })
    const w = new WfirmaHttpAtrapa()
    await runWfirmaQueue(db, { faktury: prawdziwyAdapter(w) }, { now: min(1), tylkoPraca: true })
    expect(w.ciala).toEqual([
      JSON.stringify({
        invoices: {
          invoice: {
            type: 'normal',
            price_type: 'brutto',
            paymentmethod: 'transfer',
            id_external: `${id}/1/1`,
            series: { id: '9084290' },
            contractor: { name: 'Jan Testowy', tax_id_type: 'none', street: 'Testowa 1', zip: '00-001', city: 'Testowo', country: 'PL' },
            invoicecontents: {
              '0': { invoicecontent: { good: { id: 7102 }, name: 'Towar testowy HERB-BAJT', count: '2.0000', unit: 'szt.', price: '10.00', vat_code: { id: 222 } } },
              '1': { invoicecontent: { good: { id: 0 }, name: 'Wysyłka', count: '1.0000', unit: 'szt.', price: '12.99', vat_code: { id: 222 } } },
            },
          },
        },
      }),
    ])
  })

  it('konto w „Tylko podgląd”, przełącznik faktur wyłączony, zamówienie niespakowane: robocza i tak powstaje', async () => {
    await ustawFaktury({ program: 'wfirma' })
    const tea = await product(db, 'HERB-POD', 5, { wfirmaGoodId: '7103' })
    const r0 = await ingestOrder(db, order([{ productId: tea, qty: 1 }], { totalGross: 10 }), { now: T0 })
    const w = new WfirmaHttpAtrapa()
    const przed = await stanZamowienia(r0.orderId!)
    const r = await wystawRobocza(db, r0.orderId!, deps(w))
    expect(r.kind).toBe('WYSTAWIONA')
    expect(w.faktury[0]).toMatchObject({ type: 'normal_draft', idExternal: `pr/${r0.orderId}` })
    expect(await stanZamowienia(r0.orderId!)).toEqual(przed)
  })
})

describe('faktura robocza: bezpieczniki', () => {
  beforeEach(async () => {
    await ustawFaktury({ program: 'wfirma' })
  })

  async function zamowienie(over: Parameters<typeof order>[1] = {}): Promise<string> {
    const tea = await product(db, `HERB-B${Math.random().toString(36).slice(2, 7)}`, 5, { wfirmaGoodId: '7200' })
    return (await ingestOrder(db, order([{ productId: tea, qty: 1 }], { totalGross: 10, ...over }), { now: T0 })).orderId!
  }

  it('wFirma nadała numer (zapisała zwykłą fakturę): ALARM z identyfikatorem, bez usuwania i bez drugiego zapisu', async () => {
    const id = await zamowienie()
    const w = new WfirmaHttpAtrapa()
    w.roboczaJakZwykla = true
    const r = await wystawRobocza(db, id, deps(w))
    expect(r).toMatchObject({ kind: 'ALARM', docIds: [w.faktury[0]!.id] })
    expect(w.sciezki.filter((p) => p === 'invoices/add')).toHaveLength(1)
    expect(w.sciezki.some((p) => p.startsWith('invoices/delete'))).toBe(false)
    expect(await db.invoiceAttempt.count()).toBe(0)
  })

  it('odczyt po zapisie pokazuje typ inny niż roboczy (bez numeru): ALARM', async () => {
    const id = await zamowienie()
    const w = new WfirmaHttpAtrapa()
    const odczyt = new WfirmaReadOnly(KLUCZE_TESTOWE, w.fetch, 0)
    const zmieniony: ZaleznosciRoboczej['odczyt'] = {
      call: async <T,>(p: string, b?: unknown) => {
        const j = await odczyt.call<Record<string, unknown>>(p, b)
        if (p.startsWith('invoices/get/')) ((j['invoices'] as Record<string, { invoice: Record<string, unknown> }>)['0']!.invoice)['type'] = 'normal'
        return j as T
      },
    }
    const r = await wystawRobocza(db, id, { ...deps(w), odczyt: zmieniony })
    expect(r).toMatchObject({ kind: 'ALARM', docIds: [w.faktury[0]!.id] })
    expect(r.kind === 'ALARM' && r.message).toMatch(/nie jest fakturą roboczą: typ normal/)
  })

  it('odczyt po zapisie się nie udał: ALARM (nie wiadomo, czym jest dokument), bez naprawy', async () => {
    const id = await zamowienie()
    const w = new WfirmaHttpAtrapa()
    w.getBledy = 1
    const r = await wystawRobocza(db, id, deps(w))
    expect(r).toMatchObject({ kind: 'ALARM', docIds: [w.faktury[0]!.id] })
    expect(w.sciezki.filter((p) => p === 'invoices/add')).toHaveLength(1)
  })

  it('ponowne --wykonaj dla tego samego zamówienia: robocza już jest, drugiej nie ma', async () => {
    const id = await zamowienie()
    const w = new WfirmaHttpAtrapa()
    expect((await wystawRobocza(db, id, deps(w))).kind).toBe('WYSTAWIONA')
    const r2 = await wystawRobocza(db, id, deps(w))
    expect(r2).toMatchObject({ kind: 'JUZ_JEST', dokument: { id: w.faktury[0]!.id, typ: 'normal_draft' } })
    expect(w.faktury).toHaveLength(1)
    expect(w.sciezki.filter((p) => p === 'invoices/add')).toHaveLength(1)
  })

  it('timeout zapisu: NIEWIADOMA, a ponowienie znajduje roboczą po id_external zamiast wystawiać drugą', async () => {
    const id = await zamowienie()
    const w = new WfirmaHttpAtrapa()
    w.nastepne = ['TIMEOUT_PO_ZAPISIE']
    const r = await wystawRobocza(db, id, deps(w))
    expect(r.kind).toBe('NIEWIADOMA')
    expect(r.kind === 'NIEWIADOMA' && r.message).toMatch(/odczekaj 5 minut, sprawdź w wFirmie.*dopiero potem ponów/)
    expect((await wystawRobocza(db, id, deps(w))).kind).toBe('JUZ_JEST')
    expect(w.faktury).toHaveLength(1)
  })

  it('wyszukiwanie po id_external nie widzi nowej roboczej: WYSTAWIONA z ostrzeżeniem i identyfikatorem do usunięcia', async () => {
    const id = await zamowienie()
    const w = new WfirmaHttpAtrapa()
    w.findPuste = 3 // dwa przed zapisem (nowy i stary format) i jedno po zapisie
    const r = await wystawRobocza(db, id, deps(w))
    expect(r.kind).toBe('WYSTAWIONA')
    const doc = w.faktury[0]!.id
    expect(r.kind === 'WYSTAWIONA' && r.ostrzezenie).toMatch(new RegExp(`ponowne --wykonaj wystawi drugą.*Nie ponawiaj --wykonaj.*--usun ${doc}`))
    expect(w.sciezki).toEqual(['invoices/find', 'invoices/find', 'invoices/add', `invoices/get/${doc}`, 'invoices/find'])
  })

  it('nabywca z NIP-em: odmowa bez żadnego żądania do wFirmy; z jawną zgodą robocza powstaje', async () => {
    const id = await zamowienie()
    const w = new WfirmaHttpAtrapa()
    const r = await wystawRobocza(db, id, deps(w, Z_NIP))
    expect(r.kind).toBe('ODMOWA')
    expect(r.kind === 'ODMOWA' && r.message).toMatch(/--takze-z-nip/)
    expect(r.kind === 'ODMOWA' && r.message).not.toContain('5260001246')
    expect(w.sciezki).toEqual([])
    const r2 = await wystawRobocza(db, id, deps(w, Z_NIP), { takzeZNip: true })
    expect(r2.kind).toBe('WYSTAWIONA')
    expect(w.faktury[0]).toMatchObject({ type: 'normal_draft', contractor: { tax_id_type: 'nip' } })
  })

  it('sam odczyt dokumentu: typ, numer, id_external, bez żadnego zapisu', async () => {
    const id = await zamowienie()
    const w = new WfirmaHttpAtrapa()
    expect((await wystawRobocza(db, id, deps(w))).kind).toBe('WYSTAWIONA')
    const doc = w.faktury[0]!.id
    w.faktury.push({ id: '901', idExternal: `${id}/1/1`, fullnumber: 'FV 2/15/11/26', pozycje: [], contractor: null, paymentmethod: 'transfer', type: 'normal' })
    const przed = w.sciezki.length
    expect(await sprawdzRobocza(doc, deps(w).odczyt)).toEqual({ kind: 'OK', dokument: { id: doc, typ: 'normal_draft', numer: 'WRF 1', idExternal: `pr/${id}` }, roboczaProby: true })
    expect(await sprawdzRobocza('901', deps(w).odczyt)).toMatchObject({ kind: 'OK', dokument: { typ: 'normal', numer: 'FV 2/15/11/26' }, roboczaProby: false })
    expect((await sprawdzRobocza('904', deps(w).odczyt)).kind).toBe('BLAD') // wFirma: NOT FOUND = błąd odczytu
    expect((await sprawdzRobocza('0', deps(w).odczyt)).kind).toBe('BLAD')
    expect(w.sciezki.slice(przed)).toEqual([`invoices/get/${doc}`, 'invoices/get/901', 'invoices/get/904'])
    expect(w.faktury).toHaveLength(2)
  })

  it('w wFirmie jest już zwykła faktura z id_external próby: ALARM, bez zapisu', async () => {
    const id = await zamowienie()
    const w = new WfirmaHttpAtrapa()
    w.faktury.push({ id: '555', idExternal: `pr/${id}`, fullnumber: 'FV 1/15/11/26', pozycje: [], contractor: null, paymentmethod: 'transfer', type: 'normal' })
    const r = await wystawRobocza(db, id, deps(w))
    expect(r).toMatchObject({ kind: 'ALARM', docIds: ['555'] })
    expect(w.sciezki).not.toContain('invoices/add')
  })

  it('nieznana metoda płatności: odmowa jak w prawdziwej drodze, bez żadnego żądania do wFirmy', async () => {
    const id = await zamowienie({ paymentMethod: 'Płatność kosmiczna' })
    const w = new WfirmaHttpAtrapa()
    const r = await wystawRobocza(db, id, deps(w))
    expect(r.kind).toBe('ODMOWA')
    expect(r.kind === 'ODMOWA' && r.message).toMatch(/nieznana-platnosc|płatno/i)
    expect(w.sciezki).toEqual([])
  })

  it('brak kodu VAT dla stawki: odmowa, bez żądania', async () => {
    await ustawFaktury({ program: 'wfirma', kodyVat: { '8': 223 } })
    const id = await zamowienie()
    const w = new WfirmaHttpAtrapa()
    expect((await wystawRobocza(db, id, deps(w))).kind).toBe('ODMOWA')
    expect(w.sciezki).toEqual([])
  })

  it('usuwanie: robocza próby tak; zwykła faktura, robocza z innym id_external i brak dokumentu = odmowa bez żądania usunięcia', async () => {
    const id = await zamowienie()
    const w = new WfirmaHttpAtrapa()
    expect((await wystawRobocza(db, id, deps(w))).kind).toBe('WYSTAWIONA')
    const robocza = w.faktury[0]!.id
    w.faktury.push({ id: '901', idExternal: `${id}/1/1`, fullnumber: 'FV 2/15/11/26', pozycje: [], contractor: null, paymentmethod: 'transfer', type: 'normal' })
    w.faktury.push({ id: '902', idExternal: `${id}/1/1`, fullnumber: '', pozycje: [], contractor: null, paymentmethod: 'transfer', type: 'normal_draft' })
    w.faktury.push({ id: '903', idExternal: `pr/${id}`, fullnumber: 'FV 3/15/11/26', pozycje: [], contractor: null, paymentmethod: 'transfer', type: 'normal_draft' })
    w.faktury.push({ id: '905', idExternal: idExternalStarejRoboczej(id), fullnumber: 'AB 3/15/11/26', pozycje: [], contractor: null, paymentmethod: 'transfer', type: 'normal_draft' })
    for (const doc of ['901', '902', '903', '904', '905']) expect((await usunRobocza(doc, deps(w), staraRoboczaZamowienia(db))).kind).toBe('ODMOWA')
    expect(w.sciezki.some((p) => p.startsWith('invoices/delete'))).toBe(false)
    expect((await usunRobocza(robocza, deps(w))).kind).toBe('USUNIETA')
    expect(w.sciezki.filter((p) => p.startsWith('invoices/delete'))).toEqual([`invoices/delete/${robocza}`])
    expect(w.faktury.map((f) => f.id)).toEqual(['901', '902', '903', '905'])
  })

  it('wFirma nadała roboczej numer spoza numeracji roboczych (typ dalej normal_draft): ALARM, bez usuwania', async () => {
    const id = await zamowienie()
    const w = new WfirmaHttpAtrapa()
    w.numerRoboczejWSerii = true
    const r = await wystawRobocza(db, id, deps(w))
    expect(r).toMatchObject({ kind: 'ALARM', docIds: [w.faktury[0]!.id] })
    expect(r.kind === 'ALARM' && r.message).toMatch(/spoza numeracji roboczych/)
    expect((await usunRobocza(w.faktury[0]!.id, deps(w))).kind).toBe('ODMOWA')
    expect(w.sciezki.some((p) => p.startsWith('invoices/delete'))).toBe(false)
  })

  it('robocza bez numeru (konto bez numeracji roboczych) też jest roboczą: wystawiona, już jest, usunięta', async () => {
    const id = await zamowienie()
    const w = new WfirmaHttpAtrapa()
    w.roboczaBezNumeru = true
    expect((await wystawRobocza(db, id, deps(w))).kind).toBe('WYSTAWIONA')
    expect((await wystawRobocza(db, id, deps(w))).kind).toBe('JUZ_JEST')
    expect((await usunRobocza(w.faktury[0]!.id, deps(w))).kind).toBe('USUNIETA')
  })

  it('id_external roboczej dłuższy niż 32 znaki: odmowa przed jakimkolwiek żądaniem do wFirmy', async () => {
    const w = new WfirmaHttpAtrapa()
    const r = await wystawRobocza(db, `c${'x'.repeat(29)}`, deps(w))
    expect(r.kind).toBe('ODMOWA')
    expect(r.kind === 'ODMOWA' && r.message).toMatch(/33 znaków.*najwyżej 32/)
    expect(w.sciezki).toEqual([])
  })

  it('robocza z pierwszej próby (stary prefiks obcięty przez wFirmę, numer WRF): już jest, sprawdzenie i usunięcie po zamówieniu tej firmy', async () => {
    const id = await zamowienie()
    const w = new WfirmaHttpAtrapa()
    const stary = idExternalStarejRoboczej(id)
    expect(stary).toHaveLength(32)
    expect(stary).toBe(`proba-robocza/${id}`.slice(0, 32))
    w.faktury.push({ id: '618', idExternal: stary, fullnumber: 'WRF 15', pozycje: [], contractor: null, paymentmethod: 'transfer', type: 'normal_draft' })
    // ponowne --wykonaj nie wystawia drugiej roboczej obok starej
    expect(await wystawRobocza(db, id, deps(w))).toMatchObject({ kind: 'JUZ_JEST', dokument: { id: '618', numer: 'WRF 15' } })
    expect(w.sciezki).not.toContain('invoices/add')
    expect(await sprawdzRobocza('618', deps(w).odczyt)).toMatchObject({ roboczaProby: false })
    expect(await sprawdzRobocza('618', deps(w).odczyt, staraRoboczaZamowienia(db))).toMatchObject({ roboczaProby: true })
    // bez potwierdzenia zamówienia: odmowa
    expect((await usunRobocza('618', deps(w))).kind).toBe('ODMOWA')
    // stary prefiks z identyfikatorem, którego nie ma w firmie: odmowa
    w.faktury.push({ id: '619', idExternal: `proba-robocza/czzzzzzzzzzzzzzzzz`, fullnumber: 'WRF 16', pozycje: [], contractor: null, paymentmethod: 'transfer', type: 'normal_draft' })
    expect((await usunRobocza('619', deps(w), staraRoboczaZamowienia(db))).kind).toBe('ODMOWA')
    expect(w.sciezki.some((p) => p.startsWith('invoices/delete'))).toBe(false)
    expect((await usunRobocza('618', deps(w), staraRoboczaZamowienia(db))).kind).toBe('USUNIETA')
    expect(w.faktury.map((f) => f.id)).toEqual(['619'])
  })

  it('robocza z pierwszej próby wskazująca zamówienie innej firmy: odmowa usunięcia', async () => {
    const obca = testDb({ organizationId: 'test_b' })
    try {
      await seedBase(obca)
      const tea = await product(obca, 'HERB-OBCA', 5, { wfirmaGoodId: '7299' })
      const idObcej = (await ingestOrder(obca, order([{ productId: tea, qty: 1 }], { totalGross: 10 }), { now: T0 })).orderId!
      const w = new WfirmaHttpAtrapa()
      w.faktury.push({ id: '620', idExternal: idExternalStarejRoboczej(idObcej), fullnumber: 'WRF 17', pozycje: [], contractor: null, paymentmethod: 'transfer', type: 'normal_draft' })
      expect((await usunRobocza('620', deps(w), staraRoboczaZamowienia(db))).kind).toBe('ODMOWA')
      expect((await usunRobocza('620', deps(w), staraRoboczaZamowienia(obca))).kind).toBe('USUNIETA')
    } finally {
      await obca.$disconnect()
    }
  })
})

describe('polecenie faktura-robocza', () => {
  beforeEach(async () => {
    await ustawFaktury({ program: 'wfirma' })
  })

  const src = { env: { WFIRMA_ACCESS_KEY: 'a', WFIRMA_SECRET_KEY: 's', WFIRMA_APP_KEY: 'p', WFIRMA_COMPANY_ID: '999' }, envFallback: true }
  function cli(w: WfirmaHttpAtrapa, o: { zamowienie?: string; wykonaj?: boolean; usun?: string; sprawdz?: string; takzeZNip?: boolean; nabywca?: OrderRecipient }) {
    const out: string[] = []
    const kod = fakturaRoboczaCli(db, { zamowienie: o.zamowienie, wykonaj: !!o.wykonaj, usun: o.usun, sprawdz: o.sprawdz, takzeZNip: !!o.takzeZNip, registry: defaultRegistry(), src, fetch: w.fetch as typeof fetch, odbiorca: async () => o.nabywca ?? ODBIORCA, log: (s) => out.push(s), blad: (s) => out.push(s) })
    return { kod, out }
  }

  it('na sucho: pola kontrolne bez danych nabywcy i bez żadnego żądania do wFirmy; numer z kanału też trafia', async () => {
    const tea = await product(db, 'HERB-CLI', 5, { wfirmaGoodId: '7300' })
    const o = order([{ productId: tea, qty: 1 }], { totalGross: 10 })
    const id = (await ingestOrder(db, o, { now: T0 })).orderId!
    const w = new WfirmaHttpAtrapa()
    for (const ref of [id, o.externalId]) {
      const { kod, out } = cli(w, { zamowienie: ref })
      expect(await kod).toBe(0)
      const tekst = out.join('\n')
      expect(tekst).toContain('NA SUCHO')
      expect(tekst).toContain(`id_external: pr/${id}`)
      expect(tekst).toContain('typ: normal_draft')
      expect(tekst).toContain('seria: 9084290')
      expect(tekst).toContain('forma płatności: transfer')
      for (const dane of ['Jan Testowy', 'Testowa', '00-001', 'Testowo']) expect(tekst).not.toContain(dane)
    }
    expect(w.sciezki).toEqual([])
  })

  it('--wykonaj, --sprawdz, ponowne --wykonaj, ALARM i --usun: kody wyjścia (numer WRF, id_external obcinany do 32)', async () => {
    const tea = await product(db, 'HERB-CLI2', 5, { wfirmaGoodId: '7301' })
    const id = (await ingestOrder(db, order([{ productId: tea, qty: 1 }], { totalGross: 10 }), { now: T0 })).orderId!
    const w = new WfirmaHttpAtrapa()
    const pierwsze = cli(w, { zamowienie: id, wykonaj: true })
    expect(await pierwsze.kod).toBe(0)
    expect(pierwsze.out.join('\n')).toContain('WYSTAWIONA faktura robocza')
    expect(pierwsze.out.join('\n')).toContain('numer WRF 1')
    expect(pierwsze.out.join('\n')).not.toContain('UWAGA')
    const doc = w.faktury[0]!.id
    expect(w.faktury[0]!.idExternal).toBe(`pr/${id}`)
    const s0 = cli(w, { sprawdz: doc })
    expect(await s0.kod).toBe(0)
    expect(s0.out.join('\n')).toContain(`numer WRF 1, id_external pr/${id}; robocza próby: tak`)
    const drugie = cli(w, { zamowienie: id, wykonaj: true })
    expect(await drugie.kod).toBe(0)
    expect(drugie.out.join('\n')).toContain('robocza już jest, drugiej nie wystawiono')
    expect(w.faktury).toHaveLength(1)
    expect(await cli(w, { usun: '1' }).kod).toBe(3)
    expect(await cli(w, { usun: doc }).kod).toBe(0)
    expect(w.faktury).toHaveLength(0)

    // robocza z pierwszej próby (stary format obcięty do 32 znaków): --sprawdz i --usun ją rozpoznają
    w.faktury.push({ id: '618', idExternal: idExternalStarejRoboczej(id), fullnumber: 'WRF 15', pozycje: [], contractor: null, paymentmethod: 'transfer', type: 'normal_draft' })
    const s618 = cli(w, { sprawdz: '618' })
    expect(await s618.kod).toBe(0)
    expect(s618.out.join('\n')).toContain('robocza próby: tak')
    expect(await cli(w, { usun: '618' }).kod).toBe(0)
    expect(w.faktury).toHaveLength(0)

    const id2 = (await ingestOrder(db, order([{ productId: tea, qty: 1 }], { totalGross: 10 }), { now: T0 })).orderId!
    const w2 = new WfirmaHttpAtrapa()
    w2.roboczaJakZwykla = true
    const a = cli(w2, { zamowienie: id2, wykonaj: true })
    expect(await a.kod).toBe(5)
    expect(a.out.join('\n')).toContain(`ALARM`)
    expect(a.out.join('\n')).toContain(`Nie ponawiaj --wykonaj, sprawdź dokument ${w2.faktury[0]!.id} w wFirmie`)

    // sam odczyt: kod 0, pola kontrolne, bez zapisu
    const s1 = cli(w2, { sprawdz: w2.faktury[0]!.id })
    expect(await s1.kod).toBe(0)
    expect(s1.out.join('\n')).toContain('robocza próby: nie')
    expect(await cli(w2, { sprawdz: '7777' }).kod).toBe(1)
    expect(w2.sciezki.filter((p) => p === 'invoices/add')).toHaveLength(1)
  })

  it('nabywca z NIP-em: --wykonaj bez --takze-z-nip = odmowa (kod 2) i zero żądań; z flagą kod 0', async () => {
    const tea = await product(db, 'HERB-NIP', 5, { wfirmaGoodId: '7303' })
    const id = (await ingestOrder(db, order([{ productId: tea, qty: 1 }], { totalGross: 10 }), { now: T0 })).orderId!
    const w = new WfirmaHttpAtrapa()
    const sucho = cli(w, { zamowienie: id, nabywca: Z_NIP })
    expect(await sucho.kod).toBe(0)
    expect(sucho.out.join('\n')).toContain('--wykonaj odmówi bez --takze-z-nip')
    const r = cli(w, { zamowienie: id, wykonaj: true, nabywca: Z_NIP })
    expect(await r.kod).toBe(2)
    expect(r.out.join('\n')).toMatch(/^\[faktura-robocza\] .*ODMOWA.*--takze-z-nip/)
    expect(r.out.join('\n')).not.toContain('5260001246')
    expect(w.sciezki).toEqual([])
    expect(await cli(w, { zamowienie: id, wykonaj: true, takzeZNip: true, nabywca: Z_NIP }).kod).toBe(0)
    expect(w.faktury).toHaveLength(1)
  })

  it('złe użycie, nieznane zamówienie i nieznana płatność: kod 2 bez żądań', async () => {
    const w = new WfirmaHttpAtrapa()
    expect(await cli(w, {}).kod).toBe(2)
    expect(await cli(w, { zamowienie: 'x', usun: '1' }).kod).toBe(2)
    expect(await cli(w, { usun: '1', wykonaj: true }).kod).toBe(2)
    expect(await cli(w, { sprawdz: '1', zamowienie: 'x' }).kod).toBe(2)
    expect(await cli(w, { sprawdz: '1', usun: '1' }).kod).toBe(2)
    expect(await cli(w, { usun: '1', takzeZNip: true }).kod).toBe(2)
    expect(await cli(w, { zamowienie: 'nie-ma-takiego' }).kod).toBe(2)
    const tea = await product(db, 'HERB-CLI3', 5, { wfirmaGoodId: '7302' })
    const id = (await ingestOrder(db, order([{ productId: tea, qty: 1 }], { totalGross: 10, paymentMethod: 'Płatność kosmiczna' }), { now: T0 })).orderId!
    expect(await cli(w, { zamowienie: id, wykonaj: true }).kod).toBe(2)
    expect(w.sciezki).toEqual([])
  })
})

describe('polecenie faktura-robocza: nabywca prawdziwą drogą danych klienta', () => {
  const ENV_KLIENTOW = { DANE_KLIENTA_ZAPIS: '1', CUSTOMER_DATA_KEYS: `1:${'1'.repeat(64)}`, CUSTOMER_LOOKUP_KEY: 'a'.repeat(64) }
  const src = { env: { WFIRMA_ACCESS_KEY: 'a', WFIRMA_SECRET_KEY: 's', WFIRMA_APP_KEY: 'p', WFIRMA_COMPANY_ID: '999', ...ENV_KLIENTOW }, envFallback: true }
  beforeEach(async () => {
    await ustawFaktury({ program: 'wfirma' })
  })
  function cli(w: WfirmaHttpAtrapa, zamowienie: string) {
    const out: string[] = []
    const kod = fakturaRoboczaCli(db, { zamowienie, wykonaj: true, usun: undefined, registry: defaultRegistry(), src, fetch: w.fetch as typeof fetch, log: (s) => out.push(s), blad: (s) => out.push(s) })
    return { kod, out }
  }

  it('rekord klienta w bazie (konto w „Tylko podgląd”): robocza z nabywcą z rekordu, ślad odczytu jako system:faktura-robocza', async () => {
    const tea = await product(db, 'HERB-REK', 5, { wfirmaGoodId: '7304' })
    const id = (await ingestOrder(db, order([{ productId: tea, qty: 1 }], { totalGross: 10 }), { now: T0 })).orderId!
    await zapiszRekordKlienta(db, id, rekordZOdbiorcy({ ...ODBIORCA, problemy: [] }), { source: 'RECZNE', fetchedAt: T0, env: ENV_KLIENTOW })
    const w = new WfirmaHttpAtrapa()
    const r = cli(w, id)
    expect(await r.kod).toBe(0)
    expect(w.faktury).toHaveLength(1)
    expect(w.faktury[0]).toMatchObject({ type: 'normal_draft', contractor: { name: 'Jan Testowy', tax_id_type: 'none' } })
    for (const dane of ['Jan Testowy', 'Testowa', '00-001', 'Testowo']) expect(r.out.join('\n')).not.toContain(dane)
    const slady = await db.auditLog.findMany({ where: { entity: PODGLAD_AUDIT, entityId: id } })
    expect(slady.map((x) => x.actorId)).toEqual(['system:faktura-robocza'])
  })

  it('konto w „Tylko podgląd” bez rekordu klienta i bez „zapisu w cieniu”: odmowa (kod 2) z prefiksem polecenia, zero żądań do wFirmy', async () => {
    const tea = await product(db, 'HERB-CIEN', 5, { wfirmaGoodId: '7305' })
    const id = (await ingestOrder(db, order([{ productId: tea, qty: 1 }], { totalGross: 10 }), { now: T0 })).orderId!
    const w = new WfirmaHttpAtrapa()
    const r = cli(w, id)
    expect(await r.kod).toBe(2)
    expect(r.out.join('\n')).toMatch(/^\[faktura-robocza\] zamówienie .*ODMOWA.*Tylko podgląd/)
    expect(w.sciezki).toEqual([])
    expect(await db.orderCustomer.count()).toBe(0)
    const odmowy = await db.auditLog.findMany({ where: { entity: ODBIORCA_AUDIT_ENTITY, entityId: id } })
    expect(odmowy.map((x) => [x.actorId, (x.after as { wynik: string }).wynik])).toEqual([['system:faktura-robocza', 'ODMOWA']])
  })
})
