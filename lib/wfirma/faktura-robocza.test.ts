// Faktura robocza: treść (tylko typ i id_external inne niż w prawdziwej), pola kontrolne bez danych nabywcy,
// strzeżone usuwanie w kliencie zapisu (świeży odczyt, odmowa bez żądania usunięcia). Bez bazy i bez sieci.
import { describe, expect, it } from 'vitest'
import { opisPodsumowania } from '@/scripts/faktura-robocza'
import type { FetchLike } from '../zrodla/http'
import { dokumentKontrolny, jestRobocza, jestRoboczaProby, MAX_ID_EXTERNAL, numerRoboczej, PREFIKS_ROBOCZEJ, TYP_ROBOCZEJ, WfirmaZapis } from '../zrodla/wfirma-zapis'
import { idExternalRoboczej, idExternalStarejRoboczej, odmowaDlugosci, podsumujRobocza, trescRobocza } from './faktura-robocza'

const KLUCZE = { accessKey: 'a', secretKey: 's', appKey: 'p', companyId: '1' }

const prawdziwa = () => ({
  invoices: {
    invoice: {
      type: 'normal',
      price_type: 'brutto',
      paymentmethod: 'cod',
      id_external: 'ord1/1/1',
      series: { id: '9084290' },
      contractor: { name: 'Anna Przykładowa', tax_id_type: 'nip', nip: '1234567890', street: 'Ulica 1', zip: '11-111', city: 'Miasto', country: 'PL' },
      invoicecontents: { '0': { invoicecontent: { good: { id: 5 }, name: 'Towar', count: '0.1000', unit: 'kg', price: '12.30', vat_code: { id: 224 } } } },
    },
  },
})

describe('treść faktury roboczej', () => {
  it('kopia prawdziwej z podmienionym typem i id_external; reszta i kolejność pól bez zmian; wejście nietknięte', () => {
    const p = prawdziwa()
    const kopia = JSON.stringify(p)
    const r = trescRobocza(p, 'ord1')
    expect(JSON.stringify(p)).toBe(kopia)
    expect(r.invoices.invoice['type']).toBe('normal_draft')
    expect(r.invoices.invoice['id_external']).toBe('pr/ord1')
    expect(Object.keys(r.invoices.invoice)).toEqual(Object.keys(p.invoices.invoice))
    expect({ ...r.invoices.invoice, type: 'normal', id_external: 'ord1/1/1' }).toEqual(p.invoices.invoice)
  })

  it('id_external roboczej nigdy nie ma formatu faktury paczki <orderId>/<paczka>/<próba>', () => {
    const id = idExternalRoboczej('ckabc123')
    expect(id.startsWith('ckabc123/')).toBe(false)
    expect(id).toBe(`${PREFIKS_ROBOCZEJ}ckabc123`)
    for (const inny of ['zwrot/', 'wz/', 'kontrola/']) expect(id.startsWith(inny)).toBe(false)
  })

  it('id_external roboczej z identyfikatorem zamówienia (cuid, 25 znaków) mieści się w limicie wFirmy; dłuższy = odmowa', () => {
    const cuid = 'cmwhwnl6r05h301nyfabcdefg'
    expect(cuid).toHaveLength(25)
    expect(idExternalRoboczej(cuid)).toHaveLength(28)
    expect(odmowaDlugosci(cuid)).toBeNull()
    expect(odmowaDlugosci('x'.repeat(MAX_ID_EXTERNAL - PREFIKS_ROBOCZEJ.length))).toBeNull()
    expect(odmowaDlugosci('x'.repeat(MAX_ID_EXTERNAL - PREFIKS_ROBOCZEJ.length + 1))).toMatch(/33 znaków.*najwyżej 32.*nic nie wysłano/)
    expect(idExternalStarejRoboczej(cuid)).toBe('proba-robocza/cmwhwnl6r05h301nyf')
  })

  it('pola kontrolne: typ, seria, forma płatności, pozycje; z nabywcy tylko rodzaj identyfikatora i czy jest NIP', () => {
    const s = podsumujRobocza(trescRobocza(prawdziwa(), 'ord1'), { bruttoGr: 1230, nettoGr: 1171 }, false)
    expect(s).toMatchObject({ typ: 'normal_draft', seria: '9084290', formaPlatnosci: 'cod', nabywca: { rodzajIdentyfikatora: 'nip', zNip: true } })
    expect(s.pozycje).toEqual([{ nazwa: 'Towar', ilosc: '0.1000', jednostka: 'kg', cena: '12.30', kodVat: '224', towarWfirmy: '5' }])
    const tekst = JSON.stringify(s) + opisPodsumowania(s).join('\n')
    for (const dane of ['Anna', 'Przykładowa', '1234567890', 'Ulica', '11-111', 'Miasto']) expect(tekst).not.toContain(dane)
  })
})

describe('dokument z invoices/get', () => {
  const get = (inv: Record<string, unknown>) => ({ status: { code: 'OK' }, invoices: { '0': { invoice: inv } } })
  it('pola kontrolne i rozpoznanie roboczej próby', () => {
    expect(dokumentKontrolny(get({ id: '77', type: 'normal_draft', fullnumber: 'WRF 15', id_external: 'pr/x' }))).toEqual({ id: '77', typ: 'normal_draft', numer: 'WRF 15', idExternal: 'pr/x' })
    expect(dokumentKontrolny({ status: { code: 'OK' }, invoices: { parameters: {} } })).toBeNull()
    const d = (x: Record<string, unknown>) => dokumentKontrolny(get({ id: '77', ...x }))
    expect(jestRoboczaProby(d({ type: TYP_ROBOCZEJ, fullnumber: '', id_external: 'pr/x' }))).toBe(true)
    expect(jestRoboczaProby(d({ type: TYP_ROBOCZEJ, fullnumber: 'WRF 15', id_external: 'pr/x' }))).toBe(true)
    expect(jestRoboczaProby(d({ type: TYP_ROBOCZEJ, fullnumber: 'WRF 15 ', id_external: 'pr/x' }))).toBe(true) // fullnumber przycinany
    expect(jestRoboczaProby(d({ type: 'normal', fullnumber: '', id_external: 'pr/x' }))).toBe(false)
    expect(jestRoboczaProby(d({ type: 'normal', fullnumber: 'WRF 15', id_external: 'pr/x' }))).toBe(false)
    for (const numer of ['FV 1/15/11/26', 'AB 1/15/11/26', 'WRF', 'WRF x', 'XWRF 15', 'FV WRF 15', 'WRF 15 AB'])
      expect(jestRoboczaProby(d({ type: TYP_ROBOCZEJ, fullnumber: numer, id_external: 'pr/x' })), numer).toBe(false)
    expect(jestRoboczaProby(d({ type: TYP_ROBOCZEJ, fullnumber: '', id_external: 'x/1/1' }))).toBe(false)
    expect(jestRoboczaProby(d({ type: TYP_ROBOCZEJ, fullnumber: '', id_external: 'pr/' }))).toBe(false)
    expect(jestRoboczaProby(d({ type: TYP_ROBOCZEJ, fullnumber: '', id_external: `pr/${'x'.repeat(30)}` }))).toBe(false)
    // stary format sam z siebie nie jest roboczą próby (potrzebne potwierdzenie zamówienia)
    expect(jestRoboczaProby(d({ type: TYP_ROBOCZEJ, fullnumber: 'WRF 15', id_external: 'proba-robocza/cmwhwnl6r05h301nyf' }))).toBe(false)
    expect(jestRobocza(d({ type: TYP_ROBOCZEJ, fullnumber: 'WRF 15', id_external: 'proba-robocza/cmwhwnl6r05h301nyf' }))).toBe(true)
    expect(numerRoboczej(null)).toBe(true)
    expect(numerRoboczej('WRF 15/2026')).toBe(true)
    expect(jestRoboczaProby(d({ type: TYP_ROBOCZEJ, fullnumber: '' }))).toBe(false)
    expect(jestRoboczaProby(null)).toBe(false)
  })
})

describe('klient zapisu: usuwanie tylko roboczej próby', () => {
  function klient(dokument: Record<string, unknown> | null, odpowiedzUsuniecia: unknown = { status: { code: 'OK' } }) {
    const wywolania: string[] = []
    const fetchImpl: FetchLike = async (url) => {
      const p = new URL(url).pathname.replace(/^\//, '')
      wywolania.push(p)
      return new Response(JSON.stringify(odpowiedzUsuniecia), { status: 200 })
    }
    const odczyt = {
      call: async <T,>(p: string): Promise<T> => {
        wywolania.push(`odczyt:${p}`)
        if (dokument === null) throw new Error('NOT FOUND')
        return { status: { code: 'OK' }, invoices: { '0': { invoice: dokument } } } as T
      },
    }
    return { k: new WfirmaZapis(KLUCZE, fetchImpl, 0), odczyt, wywolania }
  }

  it('usuwanie nie jest w ogólnych regułach zapisu (wystawFakture ani inna metoda go nie wyśle)', () => {
    expect(WfirmaZapis.allowed('invoices/delete/1')).toBe(false)
    expect(WfirmaZapis.allowed('invoices/add')).toBe(true)
  })

  it('robocza próby: świeży odczyt, potem jedno invoices/delete', async () => {
    const { k, odczyt, wywolania } = klient({ id: '77', type: 'normal_draft', fullnumber: '', id_external: 'pr/x' })
    expect((await k.usunFaktureRobocza('77', odczyt)).kind).toBe('USUNIETA')
    expect(wywolania).toEqual(['odczyt:invoices/get/77', 'invoices/delete/77'])
  })

  it.each([
    ['zwykła faktura', { id: '77', type: 'normal', fullnumber: 'FV 1/15/11/26', id_external: 'pr/x' }],
    ['robocza z numerem w serii', { id: '77', type: 'normal_draft', fullnumber: 'FV 1/15/11/26', id_external: 'pr/x' }],
    ['zwykła z numerem WRF', { id: '77', type: 'normal', fullnumber: 'WRF 15', id_external: 'pr/x' }],
    ['robocza faktury paczki', { id: '77', type: 'normal_draft', fullnumber: '', id_external: 'x/1/1' }],
    ['robocza bez id_external', { id: '77', type: 'normal_draft', fullnumber: '' }],
    ['inny dokument w odpowiedzi', { id: '78', type: 'normal_draft', fullnumber: '', id_external: 'pr/x' }],
    ['błąd odczytu', null],
  ])('%s: odmowa bez żądania usunięcia', async (_n, dok) => {
    const { k, odczyt, wywolania } = klient(dok)
    expect((await k.usunFaktureRobocza('77', odczyt)).kind).toBe('ODMOWA')
    expect(wywolania.some((p) => p.startsWith('invoices/delete'))).toBe(false)
  })

  it('robocza z numerem WRF: usuwana', async () => {
    const { k, odczyt, wywolania } = klient({ id: '77', type: 'normal_draft', fullnumber: 'WRF 15', id_external: 'pr/x' })
    expect((await k.usunFaktureRobocza('77', odczyt)).kind).toBe('USUNIETA')
    expect(wywolania).toEqual(['odczyt:invoices/get/77', 'invoices/delete/77'])
  })

  it('robocza z pierwszej próby (stary prefiks, obcięty): usuwana tylko po potwierdzeniu zamówienia', async () => {
    const stara = { id: '77', type: 'normal_draft', fullnumber: 'WRF 15', id_external: 'proba-robocza/cmwhwnl6r05h301nyf' }
    const bez = klient(stara)
    expect((await bez.k.usunFaktureRobocza('77', bez.odczyt)).kind).toBe('ODMOWA')
    const nie = klient(stara)
    expect((await nie.k.usunFaktureRobocza('77', nie.odczyt, async () => false)).kind).toBe('ODMOWA')
    const blad = klient(stara)
    expect((await blad.k.usunFaktureRobocza('77', blad.odczyt, async () => { throw new Error('baza') })).kind).toBe('ODMOWA')
    for (const x of [bez, nie, blad]) expect(x.wywolania.some((p) => p.startsWith('invoices/delete'))).toBe(false)
    const pytane: string[] = []
    const tak = klient(stara)
    expect((await tak.k.usunFaktureRobocza('77', tak.odczyt, async (idE) => { pytane.push(idE); return true })).kind).toBe('USUNIETA')
    expect(pytane).toEqual(['proba-robocza/cmwhwnl6r05h301nyf'])
    expect(tak.wywolania).toEqual(['odczyt:invoices/get/77', 'invoices/delete/77'])
    // potwierdzenie zamówienia nie odblokowuje dokumentu z numerem w serii ani zwykłej faktury
    for (const inny of [{ ...stara, fullnumber: 'AB 1/15/11/26' }, { ...stara, type: 'normal' }]) {
      const x = klient(inny)
      expect((await x.k.usunFaktureRobocza('77', x.odczyt, async () => true)).kind).toBe('ODMOWA')
      expect(x.wywolania.some((p) => p.startsWith('invoices/delete'))).toBe(false)
    }
  })

  it('zły identyfikator: odmowa bez odczytu i bez usuwania', async () => {
    const { k, odczyt, wywolania } = klient({ id: '77', type: 'normal_draft', fullnumber: '', id_external: 'pr/x' })
    for (const id of ['', '0', '77/../1', 'abc']) expect((await k.usunFaktureRobocza(id, odczyt)).kind).toBe('ODMOWA')
    expect(wywolania).toEqual([])
  })

  it('wFirma odrzuciła usunięcie: BŁĄD (nie „usunięta”)', async () => {
    const { k, odczyt } = klient({ id: '77', type: 'normal_draft', fullnumber: '', id_external: 'pr/x' }, { status: { code: 'ERROR' } })
    expect((await k.usunFaktureRobocza('77', odczyt)).kind).toBe('BLAD')
  })
})
