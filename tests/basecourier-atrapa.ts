// Atrapa HTTP API Base Courier: zamówienia przesyłek, etykieta, szczegóły i anulowanie w pamięci. Zero
// połączeń (fetch to funkcja w pamięci), przesyłki są płatne, więc testy NIGDY nie wołają API Base Courier ani
// sandboxa. Kształt żądań i odpowiedzi z oficjalnej dokumentacji API (OpenAPI, https://api.basecourier.com/api/docs),
// wtyczki BLPaczka (svn wordpress.org, trunk r3788011) i odczytu istniejących zamówień konta (sam kształt, bez wartości;
// opis w docs/integracje/basecourier.md). Jak prawdziwe API atrapa odrzuca utworzenie bez `CourierSearch.origin` i bez
// pola `taker_point`. Odpowiedzi z zamówieniem niosą dane odbiorcy z treści żądania (jak prawdziwe API), żeby testy
// sprawdziły, że nic z nich nie wychodzi do wyniku.
//
// `awarie[endpoint]` = kolejka wymuszonych odpowiedzi: 'network-error' (żądanie nie doszło), 'zgubiona' (zamówienie
// POWSTAJE, a odpowiedź ginie: błąd sieci po przyjęciu), albo gotowa odpowiedź {status, body}.

export const BC_SANDBOX = 'https://sandbox.basecourier.com/api'
export const BC_LOGIN = 'konto@example.invalid'
export const BC_KEY = 'klucz-testowy-bc-123'
/** Etykieta PDF atrapy (prawdziwe API: PDF w base64 w `data["0"].file` według dokumentacji, `data[0].file` według wtyczki). */
export const BC_ETYKIETA = '%PDF-1.4 fikcyjna etykieta Base Courier'

export type BcReply = { status: number; body: string } | 'network-error' | 'zgubiona'
export const bcJson = (v: unknown, status = 200): BcReply => ({ status, body: JSON.stringify(v) })

export interface BcCall {
  endpoint: string
  body: Record<string, unknown>
  redirect?: string
}

interface ZamowienieBc {
  id: number
  /** Numer listu; pusty = przewoźnik jeszcze go nie nadał (lista zamówień ma wtedy pusty tekst). */
  waybill_no: string
  package_content: string
  status: 'created' | 'cancelled'
  Order: Record<string, unknown>
  CourierSearch: Record<string, unknown>
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * `numerOdRazu: false` = numeru listu nie ma nigdzie (jeszcze nienadany); `szczegolyBezNumeru` = odpowiedź utworzenia
 * i szczegóły mają `waybill_no: null`, a numer jest tylko na liście zamówień (tak odpowiada konto dla paczek InPost);
 * `listaJakDokumentacja` = `data[].Order` na liście jako tablica (dokumentacja), domyślnie obiekt (odczyt konta);
 * `etykietaJakDokumentacja` = `getWaybill` z `data` jako obiekt z kluczem "0" i `labels`, domyślnie tablica (wtyczka);
 * `obetnijZawartosc` = API obcina „Zawartość przesyłki” do tylu znaków; `bezZawartosci` = szczegóły bez
 * `package_content`.
 */
export function bcAtrapa(
  o: { numerOdRazu?: boolean; szczegolyBezNumeru?: boolean; listaJakDokumentacja?: boolean; etykietaJakDokumentacja?: boolean; obetnijZawartosc?: number; bezZawartosci?: boolean } = {},
) {
  const calls: BcCall[] = []
  const zamowienia: ZamowienieBc[] = []
  const awarie: Record<string, BcReply[]> = {}
  let nastepne = 9_100_001

  const odpowiedz = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
  const blad = (message: string) => odpowiedz({ success: false, message })
  const rekord = (z: ZamowienieBc) => {
    const { package_content: _pc, ...reszta } = z.Order
    const numer = o.szczegolyBezNumeru ? { waybill_no: null } : z.waybill_no ? { waybill_no: z.waybill_no } : {}
    return { id: String(z.id), status: z.status, ...(o.bezZawartosci ? {} : { package_content: z.package_content }), ...numer, ...reszta }
  }
  /** Rekord listy `getOrders`: kształt z odczytu konta (dane odbiorcy w `taker_name`, numer jako tekst, pusty bez numeru). */
  const rekordListy = (z: ZamowienieBc) => {
    const order = { id: String(z.id), taker_name: String(z.Order['taker_name'] ?? ''), created: '2026-11-15 10:00:00', price: '12.99', uptake_value: null, package_content: z.package_content, waybill_no: z.waybill_no, vat_value: '23', cancelled: z.status === 'cancelled' ? '1' : '0', supplement_value: '0', sending_code: null, labelless: false }
    return { Order: o.listaJakDokumentacja ? [order] : order, CartOrder: { payed: true, id_prefix: `BC${z.id}` } }
  }

  function utworz(body: Record<string, unknown>): Response {
    const cs = isRecord(body['CourierSearch']) ? body['CourierSearch'] : {}
    const cart = Array.isArray(body['Cart']) ? body['Cart'] : []
    const ord = isRecord(cart[0]) && isRecord(cart[0]['Order']) ? cart[0]['Order'] : {}
    // walidacja jak w API: bez `origin` (komunikat jak w wycenie), bez pola `taker_point` (wymagane w dokumentacji, może
    // być puste), brak kodu pocztowego odbiorcy albo punktu paczkomatu = validationErrors
    const polaCs: Record<string, string[]> = {}
    if (typeof cs['origin'] !== 'string' || !cs['origin'].trim()) polaCs['origin'] = ['Wprowadź źródło pochodzenia (origin)']
    const pola: Record<string, string[]> = {}
    if (!ord['taker_postal']) pola['taker_postal'] = [`Kod pocztowy jest wymagany (${String(ord['taker_name'] ?? '')})`]
    if (typeof ord['taker_point'] !== 'string') pola['taker_point'] = ['Pole wymagane']
    else if (String(cs['courier_code']).startsWith('paczkomaty') && !ord['taker_point']) pola['taker_point'] = ['Wybierz paczkomat']
    if (Object.keys(pola).length || Object.keys(polaCs).length)
      return odpowiedz({ success: false, message: `Błąd walidacji dla ${String(ord['taker_email'] ?? '')}`, data: { validationErrors: { ...(Object.keys(polaCs).length ? { CourierSearch: polaCs } : {}), ...(Object.keys(pola).length ? { Cart: [{ Order: pola }] } : {}) } } })
    const z: ZamowienieBc = { id: nastepne++, waybill_no: o.numerOdRazu === false ? '' : `6800${String(nastepne).padStart(10, '0')}`, package_content: String(ord['package_content'] ?? '').slice(0, o.obetnijZawartosc ?? Infinity), status: 'created', Order: ord, CourierSearch: cs }
    zamowienia.push(z)
    return odpowiedz({ success: true, message: 'Zamówienie zostało złożone', data: { blpaczka_order_id: z.id, Order: [rekord(z)], CartOrder: { id: z.id, payment: 'bank' }, waybill_link: `${BC_SANDBOX}/waybill/${z.id}` } })
  }

  const poId = (body: Record<string, unknown>) => {
    const id = isRecord(body['Order']) ? Number(body['Order']['id']) : NaN
    return zamowienia.find((z) => z.id === id)
  }

  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const endpoint = url.replace(/^https:\/\/(api|sandbox)\.(blpaczka|basecourier)\.com\/api\//, '')
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    calls.push({ endpoint, body, redirect: init?.redirect })
    const wymuszona = awarie[endpoint]?.shift()
    if (wymuszona === 'network-error') throw new TypeError('fetch failed')
    if (wymuszona && wymuszona !== 'zgubiona') return new Response(wymuszona.body, { status: wymuszona.status })
    const auth = isRecord(body['auth']) ? body['auth'] : {}
    if (auth['login'] !== BC_LOGIN || auth['api_key'] !== BC_KEY) return odpowiedz({ success: false, message: 'Nieprawidłowy login lub klucz API' }, 401)
    let res: Response
    switch (endpoint) {
      case 'createOrderV2.json':
        res = utworz(body)
        break
      case 'getWaybill.json': {
        const z = poId(body)
        const plik = { type: 'label', filename: `${z?.id}.pdf`, name: z?.waybill_no, extension: 'pdf', mime: 'application/pdf', file: Buffer.from(BC_ETYKIETA).toString('base64') }
        const data = o.etykietaJakDokumentacja ? { '0': plik, labels: [{ name: `label_${z?.id}`, extension: 'png', s3_file: false, file: Buffer.from('obraz').toString('base64') }] } : [plik]
        res = z ? odpowiedz({ success: true, data }) : blad('Nie znaleziono zamówienia')
        break
      }
      case 'getOrderDetails.json': {
        const z = poId(body)
        res = z ? odpowiedz({ success: true, data: { Order: rekord(z) } }) : blad('Nie znaleziono zamówienia')
        break
      }
      case 'getOrderDetailsByWaybillNo.json': {
        const nr = isRecord(body['Order']) ? body['Order']['waybill_no'] : undefined
        const z = zamowienia.find((x) => x.waybill_no === nr)
        res = z ? odpowiedz({ success: true, data: { Order: rekord(z) } }) : blad('Nie znaleziono zamówienia')
        break
      }
      case 'getOrders.json': {
        // najnowsze pierwsze, po 20 na stronę
        const strona = isRecord(body['Order']) && Number.isInteger(body['Order']['page']) ? Number(body['Order']['page']) : 1
        const wszystkie = [...zamowienia].reverse()
        const pageCount = Math.max(1, Math.ceil(wszystkie.length / 20))
        const data = wszystkie.slice((strona - 1) * 20, strona * 20).map(rekordListy)
        res = odpowiedz({ success: true, message: '', data, pagination: { pageCount, current: strona, count: wszystkie.length, prev: strona > 1, next: strona < pageCount } })
        break
      }
      case 'cancelOrder.json': {
        const z = poId(body)
        if (!z) res = blad('Nie znaleziono zamówienia')
        else if (z.status === 'cancelled') res = blad('Zamówienie zostało już anulowane')
        else {
          z.status = 'cancelled'
          res = odpowiedz({ success: true, message: 'Zamówienie anulowane' })
        }
        break
      }
      case 'getProfile.json':
        res = odpowiedz({ success: true, data: { email: BC_LOGIN } })
        break
      default:
        res = blad('Nieznany endpoint')
    }
    // przyjęte i wykonane, a odpowiedź ginie po drodze (najgorszy przypadek dla płatnej przesyłki)
    if (wymuszona === 'zgubiona') throw new TypeError('socket hang up')
    return res
  }

  const ile = (endpoint: string) => calls.filter((c) => c.endpoint === endpoint).length
  /** `n` cudzych zamówień nowszych od dotychczasowych (np. nadanych w tym czasie z innego systemu) na liście konta. */
  const dopiszCudze = (n: number) => {
    for (let i = 0; i < n; i++) zamowienia.push({ id: nastepne++, waybill_no: `6900${String(nastepne).padStart(10, '0')}`, package_content: 'cudze', status: 'created', Order: { taker_name: 'Inny Odbiorca' }, CourierSearch: {} })
  }
  return { calls, zamowienia, awarie, fetchImpl, ile, dopiszCudze }
}
