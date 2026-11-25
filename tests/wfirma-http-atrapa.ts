// Atrapa HTTP wFirmy API2 dla testów zapisu faktur. Odpowiada na te same ścieżki co prawdziwa wFirma
// (`invoices/add`, `invoices/find`, `warehouse_documents/find`, `invoices/download/<id>`), trzyma faktury w pamięci
// i nigdy nie łączy się z siecią: każdy adres spoza api2.wfirma.pl i każda inna ścieżka to błąd testu.
// Sterowanie: `nastepne` = wynik kolejnych `invoices/add` (OK, BLAD, TIMEOUT_PO_ZAPISIE, TIMEOUT_BEZ_ZAPISU, LIMIT, HTTP500).
// Jak prawdziwa wFirma (odczyt 15.11.2026): `id_external` każdego dokumentu zapisany obcięty do 32 znaków; faktura
// robocza (`type: normal_draft`) dostaje numer z osobnej numeracji roboczych „WRF n” (`roboczaBezNumeru` = bez numeru);
// `roboczaJakZwykla` udaje konto, które zapisuje ją jako zwykłą fakturę z numerem. `invoices/get/<id>` oddaje typ, numer i `id_external`; `invoices/delete/<id>` usuwa.
// `ciala` = surowe treści żądań `invoices/add` (porównanie bajt w bajt).
// `currency` z żądania (brak = PLN); `invoices/get` oddaje `currency`, `total` (suma pozycji brutto) i kurs
// księgowy jak wFirma (pola kursu liczy program: `kurs` dla obcej waluty, 1 dla PLN); `walutaOdczytu`/`kurs: null`
// udają fakturę zapisaną inaczej, niż ją wysłaliśmy.
import type { FetchLike } from '@/lib/zrodla/http'
import type { WfirmaKeys } from '@/lib/zrodla/wfirma'

export const KLUCZE_TESTOWE: WfirmaKeys = { accessKey: 'test-access', secretKey: 'test-secret', appKey: 'test-app', companyId: '999' }

type Wynik = 'OK' | 'BLAD' | 'TIMEOUT_PO_ZAPISIE' | 'TIMEOUT_BEZ_ZAPISU' | 'LIMIT' | 'HTTP500'

export interface FakturaAtrapy {
  id: string
  idExternal: string
  fullnumber: string
  /** Treść `invoicecontents` z żądania (good.id, count, price, vat_code). */
  pozycje: { goodId: number; count: number; price: string; name: string; vat: number }[]
  contractor: Record<string, unknown> | null
  paymentmethod: string
  /** `alreadypaid_initial` z żądania (null = pole pominięte). */
  alreadypaidInitial?: string | null
  /** `paymentdate` z żądania (null = pole pominięte, wFirma liczy termin sama). */
  paymentdate?: string | null
  type: string
  /** `currency` z żądania (brak pola = PLN). */
  currency?: string
}

export class WfirmaHttpAtrapa {
  faktury: FakturaAtrapy[] = []
  sciezki: string[] = []
  nastepne: Wynik[] = []
  /** Tyle najbliższych `invoices/find` po id_external odpowie pusto (opóźniony indeks wFirmy). */
  findPuste = 0
  /** Surowe treści żądań `invoices/add`, w kolejności. */
  ciala: string[] = []
  /** Konto zapisuje roboczą jako zwykłą fakturę z numerem (wFirma zignorowała typ). */
  roboczaJakZwykla = false
  /** Robocza bez numeru (zamiast numeracji roboczych „WRF n”). */
  roboczaBezNumeru = false
  /** Robocza (typ `normal_draft`) z numerem w serii faktur zamiast numeracji roboczych. */
  numerRoboczejWSerii = false
  /** Tyle najbliższych `invoices/get` skończy się błędem (HTTP `getStatus`, domyślnie 400 bez ponowień klienta odczytu). */
  getBledy = 0
  /** kod HTTP błędu `invoices/get` (500 = przejściowy, który klient odczytu domyślnie ponawia; 429 = limit). */
  getStatus = 400
  /** (b): przesunięcie `total` w odczycie o tyle groszy (faktura z inną kwotą przy tej samej walucie). */
  totalPrzesuniecieGr = 0
  /** Wynik kolejnych `invoices/delete` (domyślnie OK). */
  usuwanie: ('OK' | 'ERROR')[] = []
  /** kurs księgowy, który „dobiera” wFirma dla obcej waluty (null = faktura bez kursu). */
  kurs: string | null = '0.1745'
  /** waluta oddawana w odczycie zamiast zapisanej (faktura zapisana w innej walucie). */
  walutaOdczytu: string | null = null
  private nr = 1000
  private nrRoboczej = 0

  readonly fetch: FetchLike = async (url, init) => {
    const u = new URL(url)
    if (u.host !== 'api2.wfirma.pl') throw new Error(`atrapa wFirmy: obcy adres ${u.host}`)
    const sciezka = u.pathname.replace(/^\//, '')
    this.sciezki.push(sciezka)
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
    if (sciezka === 'invoices/add') {
      this.ciala.push(String(init?.body ?? ''))
      const wynik = this.nastepne.shift() ?? 'OK'
      if (wynik === 'LIMIT') return json({ status: { code: 'TOTAL REQUESTS LIMIT EXCEEDED' } })
      if (wynik === 'HTTP500') return json({}, 500)
      if (wynik === 'TIMEOUT_BEZ_ZAPISU') throw new Error('timeout (atrapa)')
      if (wynik === 'BLAD') return json({ status: { code: 'ERROR' }, invoices: { '0': { invoice: { errors: { '0': { error: { field: 'contractor', message: 'Pole wymagane' } } } } } } })
      const inv = (body['invoices'] as { invoice: Record<string, unknown> }).invoice
      const contents = Object.values(inv['invoicecontents'] as Record<string, { invoicecontent: Record<string, unknown> }>).map((c) => c.invoicecontent)
      const typ = String(inv['type'] ?? '')
      const robocza = typ === 'normal_draft' && !this.roboczaJakZwykla
      const f: FakturaAtrapy = {
        id: String(++this.nr),
        idExternal: String(inv['id_external']).slice(0, 32),
        fullnumber: robocza ? (this.numerRoboczejWSerii ? `FV ${this.nr - 1000}/11/2026` : this.roboczaBezNumeru ? '' : `WRF ${++this.nrRoboczej}`) : `FV ${this.nr - 1000}/11/2026`,
        type: robocza ? typ : 'normal',
        pozycje: contents.map((c) => ({ goodId: Number((c['good'] as { id: number }).id), count: Number(c['count']), price: String(c['price']), name: String(c['name']), vat: Number((c['vat_code'] as { id: number }).id) })),
        contractor: (inv['contractor'] as Record<string, unknown>) ?? null,
        paymentmethod: String(inv['paymentmethod']),
        alreadypaidInitial: inv['alreadypaid_initial'] === undefined ? null : String(inv['alreadypaid_initial']),
        paymentdate: inv['paymentdate'] === undefined ? null : String(inv['paymentdate']),
        currency: inv['currency'] === undefined ? 'PLN' : String(inv['currency']),
      }
      this.faktury.push(f)
      if (wynik === 'TIMEOUT_PO_ZAPISIE') throw new Error('timeout po zapisie (atrapa)')
      return json({ status: { code: 'OK' }, invoices: { '0': { invoice: { id: f.id, fullnumber: f.fullnumber } } } })
    }
    const get = /^invoices\/get\/(\d+)$/.exec(sciezka)
    if (get) {
      if (this.getBledy > 0) {
        this.getBledy--
        return json({ status: { code: 'ERROR' } }, this.getStatus)
      }
      const f = this.faktury.find((x) => x.id === get[1])
      if (!f) return json({ status: { code: 'NOT FOUND' } })
      const total = (f.pozycje.reduce((s, p) => s + Math.round(p.count * Number(p.price) * 100), 0) + this.totalPrzesuniecieGr) / 100
      const kurs = (f.currency ?? 'PLN') === 'PLN' ? '1.0000' : this.kurs
      return json({
        status: { code: 'OK' },
        invoices: { '0': { invoice: { id: f.id, type: f.type, fullnumber: f.fullnumber, id_external: f.idExternal, paymentmethod: f.paymentmethod, currency: this.walutaOdczytu ?? f.currency ?? 'PLN', total: total.toFixed(2), currency_exchange: kurs ?? '0.0000', currency_date: '2026-11-20', currency_label: '226/A/NBP/2026' } } },
      })
    }
    const del = /^invoices\/delete\/(\d+)$/.exec(sciezka)
    if (del) {
      if ((this.usuwanie.shift() ?? 'OK') === 'ERROR') return json({ status: { code: 'ERROR' } })
      const i = this.faktury.findIndex((x) => x.id === del[1])
      if (i < 0) return json({ status: { code: 'NOT FOUND' } })
      this.faktury.splice(i, 1)
      return json({ status: { code: 'OK' } })
    }
    if (sciezka === 'invoices/find') {
      const cond = ((body['invoices'] as Record<string, unknown>)['parameters'] as { conditions: { condition: { field: string; value: string } } }).conditions.condition
      if (cond.field !== 'id_external') return json({ status: { code: 'OK' }, invoices: { parameters: {} } })
      const prefiks = cond.value.replace(/%$/, '')
      const puste = this.findPuste > 0 && !prefiks.startsWith('kontrola/')
      if (puste) this.findPuste--
      const hit = puste ? [] : this.faktury.filter((f) => f.idExternal.startsWith(prefiks))
      return json({ status: { code: 'OK' }, invoices: { ...Object.fromEntries(hit.map((f, i) => [String(i), { invoice: { id: f.id, id_external: f.idExternal, fullnumber: f.fullnumber } }])), parameters: { total: hit.length } } })
    }
    if (sciezka === 'warehouse_documents/find') {
      const cond = ((body['warehouse_documents'] as Record<string, unknown>)['parameters'] as { conditions: { condition: { value: string } } }).conditions.condition
      const f = this.faktury.find((x) => x.id === String(cond.value))
      if (!f) return json({ status: { code: 'OK' }, warehouse_documents: { parameters: {} } })
      const towary = f.pozycje.filter((p) => p.goodId > 0)
      return json({ status: { code: 'OK' }, warehouse_documents: { '0': { warehouse_document: { warehouse_document_contents: Object.fromEntries(towary.map((p, i) => [String(i), { warehouse_document_content: { good: { id: String(p.goodId) }, count: p.count.toFixed(4) } }])) } } } })
    }
    const pdf = /^invoices\/download\/(\d+)$/.exec(sciezka)
    if (pdf) {
      if (!this.faktury.some((f) => f.id === pdf[1])) return json({ status: { code: 'NOT FOUND' } })
      return new Response(new TextEncoder().encode(`%PDF-1.4 atrapa ${pdf[1]}`), { status: 200, headers: { 'content-type': 'application/pdf' } })
    }
    throw new Error(`atrapa wFirmy: nieobsłużona ścieżka ${sciezka}`)
  }
}
