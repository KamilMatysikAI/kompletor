// Atrapa usługi ADE GLS w pamięci: przygotowalnia, potwierdzenia nadania i przesyłki z paczkami. Zapisuje
// każde żądanie (metoda RPC i surowa koperta), odpowiada w kształcie RPC (`<return>`), umie odmówić Faultem z kodem ADE
// i zgubić odpowiedź przed albo po wykonaniu (także z potwierdzeniem nadania dokończonym przez ADE dopiero później).
// Listy identyfikatorów stronami rosnąco: `id_start` = ostatni identyfikator poprzedniej strony (założenie, kierunek
// ADE do potwierdzenia na koncie testowym). Zero połączeń z prawdziwym GLS, także z ADE test; dane fikcyjne.
import { PII_SENTINELS } from '@/lib/adaptery/suita-kontraktowa'
import type { RecipientAddress } from '@/lib/adaptery/kontrakt'
import { GLS_TEST } from '@/lib/zrodla/gls'

export const GLS_URL = GLS_TEST
export const GLS_LOGIN = 'kompletor-test'
export const GLS_HASLO = ['tajne', 'haslo', 'atrapy', 'gls'].join('-')

const [imie, email, telefon] = PII_SENTINELS

export const ODBIORCA_GLS: RecipientAddress = {
  imieNazwisko: imie!,
  firma: null,
  ulica: 'Testowa',
  numerDomu: '1',
  numerLokalu: null,
  kodPocztowy: '00-001',
  miasto: 'Testowo',
  kraj: 'PL',
  telefon: telefon!,
  email: email!,
}

export const NADAWCA_GLS = { name: 'Firma Testowa', fullName: 'Firma Testowa sp. z o.o.', address: 'ul. Magazynowa 5/2', city: 'Testowo', postalCode: '00-002', phone: '+48 500 000 000', email: 'magazyn@example.invalid' }

interface Przesylka {
  references: string
  paczki: string[]
  rzipcode: string
  rstreet: string
  /** kod punktu GLS (`srv_sds.id`), '' = kurier */
  punkt: string
  cod_amount: string
  weight: string
  date: string
}

type Usterka =
  | { metoda: string; rodzaj: 'przed' | 'po' | 'po_odlozone' }
  | { metoda: string; rodzaj: 'fault'; kod: string }
  | { metoda: string; rodzaj: 'surowa'; status: number; tresc: string }

const env = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="urn:ade_webapi2"><SOAP-ENV:Body>${inner}</SOAP-ENV:Body></SOAP-ENV:Envelope>`
const ret = (metoda: string, inner: string) => env(`<ns1:${metoda}Response><return>${inner}</return></ns1:${metoda}Response>`)
export const faultGls = (kod: string) => env(`<SOAP-ENV:Fault><faultcode>${kod}</faultcode><faultstring>Opis błędu ${imie}</faultstring></SOAP-ENV:Fault>`)
const pole = (xml: string, n: string) => new RegExp(`<${n}>([^<]*)</${n}>`).exec(xml)?.[1] ?? null

export function glsAtrapa(o: { strona?: number } = {}) {
  const strona = o.strona ?? 100
  let licznik = 1000
  let numer = 90000000000
  const przygotowalnia = new Map<string, Przesylka>()
  const nadane = new Map<string, Przesylka>()
  const potwierdzenia = new Map<string, string[]>()
  const sesje = new Set<string>()
  const calls: { metoda: string; body: string }[] = []
  const usterki: Usterka[] = []
  const odlozone: (() => void)[] = []

  /** Strona listy rosnąco: identyfikatory większe od `id_start`, najwyżej `strona`. */
  const lista = (ids: Iterable<string>, body: string) => {
    const start = BigInt(pole(body, 'id_start') ?? '0')
    return [...ids]
      .filter((i) => BigInt(i) > start)
      .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
      .slice(0, strona)
      .map((i) => `<items>${i}</items>`)
      .join('')
  }

  function nadaj(ids: string[]): string {
    const pid = String(++licznik)
    const nowe: string[] = []
    for (const i of ids) {
      const nid = String(++licznik)
      nadane.set(nid, przygotowalnia.get(i)!)
      przygotowalnia.delete(i)
      nowe.push(nid)
    }
    potwierdzenia.set(pid, nowe)
    return pid
  }

  function wykonaj(metoda: string, body: string, odloz: boolean): string {
    const sesja = pole(body, 'session')
    if (metoda !== 'adeLogin' && (!sesja || !sesje.has(sesja))) return faultGls('err_sess_not_found')
    switch (metoda) {
      case 'adeLogin': {
        if (pole(body, 'user_password') !== GLS_HASLO) return faultGls('err_user_webapi_auth_error')
        const s = `sesja${++licznik}`
        sesje.add(s)
        return ret(metoda, `<session>${s}</session>`)
      }
      case 'adeLogout':
        sesje.delete(sesja!)
        return ret(metoda, '1')
      case 'adePreparingBox_Insert': {
        const id = String(++licznik)
        const n = (body.match(/<weight>/g)?.length ?? 2) - 1
        przygotowalnia.set(id, {
          references: pole(body, 'references') ?? '',
          paczki: Array.from({ length: Math.max(1, n) }, () => String(++numer)),
          rzipcode: pole(body, 'rzipcode') ?? '',
          rstreet: pole(body, 'rstreet') ?? '',
          punkt: /<srv_sds><id>([^<]*)<\/id><\/srv_sds>/.exec(body)?.[1] ?? '',
          cod_amount: pole(body, 'cod_amount') ?? '0',
          weight: pole(body, 'weight') ?? '',
          date: pole(body, 'date') ?? '',
        })
        return ret(metoda, `<id>${id}</id>`)
      }
      case 'adePickup_Create': {
        const ids = [...body.matchAll(/<items>(\d+)<\/items>/g)].map((m) => m[1]!)
        if (!ids.length || ids.some((i) => !przygotowalnia.has(i))) return faultGls('err_cons_not_found')
        // ADE przyjęło potwierdzenie, ale kończy je później: przygotowanie leży, aż test wywoła `dokoncz()`
        if (odloz) {
          odlozone.push(() => void nadaj(ids))
          return ''
        }
        return ret(metoda, `<id>${nadaj(ids)}</id>`)
      }
      case 'adePickup_GetConsignBinds':
        return ret(metoda, (potwierdzenia.get(pole(body, 'id') ?? '') ?? []).map((i) => `<items><id>${i}</id><number>x</number></items>`).join(''))
      case 'adePreparingBox_GetConsignIDs':
        return ret(metoda, lista(przygotowalnia.keys(), body))
      case 'adePickup_GetIDs':
        return ret(metoda, lista(potwierdzenia.keys(), body))
      case 'adePickup_GetConsignIDs':
        return ret(metoda, lista(potwierdzenia.get(pole(body, 'id') ?? '') ?? [], body))
      case 'adePreparingBox_GetConsign':
      case 'adePickup_GetConsign': {
        const id = pole(body, 'id') ?? ''
        const c = (metoda === 'adePickup_GetConsign' ? nadane : przygotowalnia).get(id)
        if (!c) return faultGls('err_cons_not_found')
        const cod = Number(c.cod_amount) > 0 ? 1 : 0
        const paczki = c.paczki.map((n) => `<items><number>${n}</number><weight>0.10</weight></items>`).join('')
        return ret(
          metoda,
          `<rname1>${imie}</rname1><rzipcode>${c.rzipcode}</rzipcode><rstreet>${c.rstreet}</rstreet>${c.punkt ? `<srv_sds><id>${c.punkt}</id></srv_sds>` : ''}<references>${c.references}</references><weight>${c.weight}</weight><date>${c.date}</date><srv_bool><cod>${cod}</cod><cod_amount>${c.cod_amount}</cod_amount></srv_bool><parcels>${paczki}</parcels>`,
        )
      }
      case 'adePickup_GetParcelLabel':
      case 'adePickup_GetParcelsLabels':
        return ret(metoda, Buffer.from(`%PDF-atrapa ${metoda}`).toString('base64'))
      default:
        return faultGls('err_unknown_method')
    }
  }

  const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
    const body = String(init?.body ?? '')
    const metoda = /<ns1:([A-Za-z_]+)>/.exec(body)?.[1] ?? '?'
    calls.push({ metoda, body })
    const i = usterki.findIndex((u) => u.metoda === metoda)
    const u = i >= 0 ? usterki.splice(i, 1)[0] : undefined
    if (u?.rodzaj === 'przed') throw new Error('socket hang up')
    if (u?.rodzaj === 'fault') return new Response(faultGls(u.kod), { status: 500 })
    if (u?.rodzaj === 'surowa') return new Response(u.tresc, { status: u.status })
    const odp = wykonaj(metoda, body, u?.rodzaj === 'po_odlozone')
    if (u?.rodzaj === 'po' || u?.rodzaj === 'po_odlozone') throw new Error('timeout po wysłaniu')
    return new Response(odp, { status: odp.includes('Fault>') ? 500 : 200 })
  }

  const cudza = (): Przesylka => ({ references: 'CUDZA', paczki: [String(++numer)], rzipcode: '00001', rstreet: 'Inna 1', punkt: '', cod_amount: '0.00', weight: '1.00', date: '2026-11-09' })

  return {
    fetchImpl,
    calls,
    metody: () => calls.map((c) => c.metoda),
    ile: (m: string) => calls.filter((c) => c.metoda === m).length,
    usterka: (u: Usterka) => usterki.push(u),
    /** ADE kończy potwierdzenia nadania przyjęte z usterką „po_odlozone”. */
    dokoncz: () => odlozone.splice(0).forEach((f) => f()),
    przygotowalnia,
    nadane,
    potwierdzenia,
    sesje,
    /** Przesyłka nadana z kilkoma paczkami (np. utworzona w panelu ADE), we własnym potwierdzeniu. */
    dodajNadana(references: string, paczek: number): string {
      const id = String(++licznik)
      nadane.set(id, { ...cudza(), references, paczki: Array.from({ length: paczek }, () => String(++numer)) })
      potwierdzenia.set(String(++licznik), [id])
      return id
    },
    /** Potwierdzenie z panelu ADE z `ile` cudzymi przesyłkami. */
    dodajPotwierdzenie(ile: number): string {
      const ids = Array.from({ length: ile }, () => {
        const id = String(++licznik)
        nadane.set(id, cudza())
        return id
      })
      const pid = String(++licznik)
      potwierdzenia.set(pid, ids)
      return pid
    },
    /** Cudze przygotowanie w przygotowalni (np. z panelu ADE). */
    dodajPrzygotowanie(): string {
      const id = String(++licznik)
      przygotowalnia.set(id, cudza())
      return id
    },
  }
}
