// treść korekty wFirmy z faktury pierwotnej (czyste funkcje) i klient zapisu na atrapie fetch (bez sieci).
import { describe, expect, it } from 'vitest'
import { WfirmaZapis } from '../zrodla/wfirma-zapis'
import { porownajKorekte, pozycjeFaktury, pozycjeKorekty, zlozKorekte } from './korekta-zapis'

const faktura = {
  invoices: {
    '0': {
      invoice: {
        id: '7001',
        invoicecontents: {
          '0': { invoicecontent: { id: '91', good: { id: '501' }, count: '3.0000', name: 'Przyprawa A' } },
          '1': { invoicecontent: { id: '92', good: { id: '502' }, count: 1, name: 'Przyprawa B' } },
          '2': { invoicecontent: { id: '93', good: { id: '0' }, count: 1, name: 'Wysyłka' } },
          '3': { invoicecontent: { id: 'x', good: { id: '503' }, count: 1 } },
        },
      },
    },
    parameters: { limit: 20 },
  },
}

const KLUCZE = { accessKey: 'a', secretKey: 'b', appKey: 'c', companyId: '1' }

describe('korekta wFirmy', () => {
  it('pozycje faktury z invoices/get: id pozycji, towar (0 = bez towaru), ilość; pozycja bez id pominięta', () => {
    expect(pozycjeFaktury(faktura)).toEqual([
      { id: '91', towarId: '501', ilosc: 3, nazwa: 'Przyprawa A' },
      { id: '92', towarId: '502', ilosc: 1, nazwa: 'Przyprawa B' },
      { id: '93', towarId: null, ilosc: 1, nazwa: 'Wysyłka' },
    ])
    expect(pozycjeFaktury({})).toEqual([])
  })

  it('treść: każda pozycja z parent.id i ilością po korekcie; zwrot ponad fakturę albo towar spoza faktury = problem', () => {
    const p = pozycjeFaktury(faktura)
    const z = zlozKorekte({ fakturaId: '7001', idExternal: 'zwrot/r1/1', pozycje: p, zwrot: [{ towarId: '501', ilosc: 2 }], opis: 'Korekta: zwrot towaru' })
    expect(z).toEqual({
      ok: true,
      oczekiwane: new Map([
        ['91', 1],
        ['92', 1],
        ['93', 1],
      ]),
      tresc: {
        invoices: {
          invoice: {
            type: 'correction',
            parent: { id: '7001' },
            id_external: 'zwrot/r1/1',
            description: 'Korekta: zwrot towaru',
            invoicecontents: [
              { invoicecontent: { parent: { id: '91' }, count: 1 } },
              { invoicecontent: { parent: { id: '92' }, count: 1 } },
              { invoicecontent: { parent: { id: '93' }, count: 1 } },
            ],
          },
        },
      },
    })
    expect(zlozKorekte({ fakturaId: '7001', idExternal: 'zwrot/r1/1', pozycje: p, zwrot: [{ towarId: '501', ilosc: 4 }], opis: '' })).toMatchObject({ ok: false, problem: expect.stringMatching(/towar 501 \(1\)/) })
    expect(zlozKorekte({ fakturaId: '7001', idExternal: 'zwrot/r1/1', pozycje: p, zwrot: [{ towarId: '999', ilosc: 1 }], opis: '' })).toMatchObject({ ok: false })
    expect(zlozKorekte({ fakturaId: 'FV/1', idExternal: 'zwrot/r1/1', pozycje: p, zwrot: [{ towarId: '501', ilosc: 1 }], opis: '' })).toMatchObject({ ok: false })
    expect(zlozKorekte({ fakturaId: '7001', idExternal: 'zwrot/r1/1', pozycje: p, zwrot: [], opis: '' })).toMatchObject({ ok: false })
  })

  it('kg: ilości ułamkowe bez błędów zaokrągleń', () => {
    const z = zlozKorekte({ fakturaId: '7001', idExternal: 'zwrot/r1/1', pozycje: [{ id: '91', towarId: '501', ilosc: 0.3, nazwa: '' }], zwrot: [{ towarId: '501', ilosc: 0.1 }], opis: '' })
    expect(z.ok && (z.tresc.invoices.invoice['invoicecontents'] as { invoicecontent: { count: number } }[])[0]!.invoicecontent.count).toBe(0.2)
  })

  it('kontrola po zapisie: zgodna korekta (z parent.id albo bez) nie daje uwag, inna ilość, brak i nadmiar pozycji dają czytelne uwagi', () => {
    const p = pozycjeFaktury(faktura)
    const oczek = new Map([
      ['91', 1],
      ['92', 1],
      ['93', 1],
    ])
    const kor = (pozycje: { id: string; good: string; count: number; name: string; parent?: string }[]) =>
      pozycjeKorekty({ invoices: { '0': { invoice: { invoicecontents: Object.fromEntries(pozycje.map((x, i) => [String(i), { invoicecontent: { id: x.id, good: { id: x.good }, count: x.count, name: x.name, ...(x.parent ? { parent: { id: x.parent } } : {}) } }])) } } } })
    const zParent = kor([
      { id: '191', good: '501', count: 1, name: 'Przyprawa A', parent: '91' },
      { id: '192', good: '502', count: 1, name: 'Przyprawa B', parent: '92' },
      { id: '193', good: '0', count: 1, name: 'Wysyłka', parent: '93' },
    ])
    expect(zParent[0]).toEqual({ id: '191', towarId: '501', ilosc: 1, nazwa: 'Przyprawa A', rodzicId: '91' })
    expect(porownajKorekte(p, oczek, zParent)).toEqual([])
    const bezParent = kor([
      { id: '191', good: '501', count: 1, name: 'Przyprawa A' },
      { id: '192', good: '502', count: 1, name: 'Przyprawa B' },
      { id: '193', good: '0', count: 1, name: 'Wysyłka' },
    ])
    expect(porownajKorekte(p, oczek, bezParent)).toEqual([])
    // wFirma przeczytała ilość jako różnicę (-2) zamiast ilości po korekcie (1)
    expect(
      porownajKorekte(
        p,
        oczek,
        kor([
          { id: '191', good: '501', count: -2, name: 'Przyprawa A', parent: '91' },
          { id: '192', good: '502', count: 1, name: 'Przyprawa B', parent: '92' },
          { id: '193', good: '0', count: 1, name: 'Wysyłka', parent: '93' },
        ]),
      ),
    ).toEqual(['Przyprawa A: jest -2, powinno być 1'])
    expect(porownajKorekte(p, oczek, kor([{ id: '191', good: '501', count: 1, name: 'Przyprawa A' }, { id: '194', good: '777', count: 2, name: 'Obcy' }]))).toEqual([
      'Przyprawa B: brak pozycji w korekcie (powinno być 1)',
      'Wysyłka: brak pozycji w korekcie (powinno być 1)',
      'Obcy: pozycja spoza korygowanej faktury (2)',
    ])
    expect(porownajKorekte(p, oczek, [])).toEqual(['korekta bez pozycji w odpowiedzi wFirmy'])
    // kg: 0,2 = 0.2000 z wFirmy
    expect(porownajKorekte([{ id: '91', towarId: '501', ilosc: 0.3, nazwa: 'Waga' }], new Map([['91', 0.2]]), [{ id: '1', towarId: '501', ilosc: 0.2, nazwa: 'Waga', rodzicId: null }])).toEqual([])
    expect(porownajKorekte([{ id: '91', towarId: '501', ilosc: 0.3, nazwa: 'Waga' }], new Map([['91', 0.2]]), [{ id: '1', towarId: '501', ilosc: 0.1, nazwa: 'Waga', rodzicId: null }])).toEqual(['Waga: jest 0,1, powinno być 0,2'])
  })

  it('klient zapisu: korekta idzie tą samą dozwoloną ścieżką invoices/add (inne ścieżki zapisu dalej zabronione)', async () => {
    expect(WfirmaZapis.allowed('invoices/add')).toBe(true)
    expect(WfirmaZapis.allowed('invoices/edit/7001')).toBe(false)
    const wywolania: string[] = []
    const z = new WfirmaZapis(
      KLUCZE,
      async (url) => {
        wywolania.push(String(url))
        return new Response(JSON.stringify({ status: { code: 'OK' }, invoices: { '0': { invoice: { id: '8001', fullnumber: 'KOR 1/11/2026' } } } }), { status: 200 })
      },
      0,
    )
    expect(await z.wystawKorekte({ invoices: { invoice: { type: 'correction' } } })).toEqual({ kind: 'OK', id: '8001', numer: 'KOR 1/11/2026' })
    expect(wywolania[0]).toMatch(/^https:\/\/api2\.wfirma\.pl\/invoices\/add\?/)
    const blad = new WfirmaZapis(KLUCZE, async () => new Response(JSON.stringify({ status: { code: 'ERROR' } }), { status: 200 }), 0)
    expect(await blad.wystawKorekte({ invoices: { invoice: {} } })).toMatchObject({ kind: 'ERROR', message: expect.stringMatching(/korektę/) })
  })
})
