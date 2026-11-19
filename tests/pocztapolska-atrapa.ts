// Atrapa usług SOAP eNadawcy i Śledzenia Poczty Polskiej w pamięci. Ze stanem: bufory (partie) z
// przesyłkami, także bufor „ręczny” spoza Kompletora i przesyłka innego zamówienia, żeby testy sprawdzały, że
// Kompletor ich nie rusza. Zapisuje każde żądanie (adres, nagłówki, metoda, treść). Zero połączeń z Pocztą Polską,
// także ze środowiskiem testowym; dane wyłącznie fikcyjne, odbiorca z wartownikami PII_SENTINELS.
import { PII_SENTINELS } from '@/lib/adaptery/suita-kontraktowa'
import type { RecipientAddress } from '@/lib/adaptery/kontrakt'
import { ENADAWCA_NS } from '@/lib/zrodla/pocztapolska'

export const PP_LOGIN = 'kompletor_test'
export const PP_HASLO = 'tajne-haslo-testowe-1'
export const PP_URZAD = '262144'
export const GUID_OBCY = 'A'.repeat(32)
export const NUMER_OBCY = '00659007734000000001'

const [imie, email, telefon] = PII_SENTINELS

export const ADRESAT_PP: RecipientAddress = {
  imieNazwisko: imie!,
  firma: null,
  ulica: 'Testowa',
  numerDomu: '1',
  numerLokalu: '2',
  kodPocztowy: '00-001',
  miasto: 'Testowo',
  kraj: 'PL',
  telefon: telefon!,
  email: email!,
}

export const NADAWCA_PP = { name: 'Firma Testowa', fullName: 'Firma Testowa sp. z o.o.', address: 'ul. Magazynowa 5/2', city: 'Testowo', postalCode: '00-002', phone: '+48 500 000 000', email: 'magazyn@example.invalid' }

export interface PrzesylkaAtrapy {
  guid: string
  numer: string
  /** Pola z żądania addShipment (porównanie przy ponowieniu). */
  kod?: string
  ulica?: string
  numerDomu?: string
  numerLokalu?: string
  masa?: string
  format?: string
}
export interface BuforAtrapy {
  id: string
  opis: string
  urzad: string
  przesylki: PrzesylkaAtrapy[]
  wyslany: boolean
}

export interface WywolaniePP {
  url: string
  metoda: string
  headers: Record<string, string>
  body: string
}

export type Awaria = { po: 'przed' | 'po'; blad?: Error; status?: number; body?: string }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const koperta = (metoda: string, tresc: string, ns = ENADAWCA_NS) =>
  `<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="${ns}"><SOAP-ENV:Body><ns1:${metoda}Response>${tresc}</ns1:${metoda}Response></SOAP-ENV:Body></SOAP-ENV:Envelope>`
export const fault = (kod: string, tekst: string) => `<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"><SOAP-ENV:Body><SOAP-ENV:Fault><faultcode>${kod}</faultcode><faultstring>${esc(tekst)}</faultstring></SOAP-ENV:Fault></SOAP-ENV:Body></SOAP-ENV:Envelope>`
const blad = (nr: number, opis: string, guid = '') => `<error><errorNumber>${nr}</errorNumber><errorDesc>${esc(opis)}</errorDesc>${guid ? `<guid>${guid}</guid>` : ''}</error>`

/** Dane przesyłki jak w odpowiedzi eNadawcy (adres adresata, masa, format); puste pola pominięte. */
const dane = (p: PrzesylkaAtrapy) =>
  p.kod === undefined
    ? `<adres><nazwa>${esc(imie!)}</nazwa></adres>`
    : `<adres><nazwa>${esc(imie!)}</nazwa><ulica>${esc(p.ulica ?? '')}</ulica><numerDomu>${esc(p.numerDomu ?? '')}</numerDomu>${p.numerLokalu ? `<numerLokalu>${esc(p.numerLokalu)}</numerLokalu>` : ''}<kodPocztowy>${p.kod}</kodPocztowy></adres><masa>${p.masa}</masa><format>${p.format}</format>`
const pole = (body: string, nazwa: string) => new RegExp(`<${nazwa}>([^<]*)</${nazwa}>`).exec(body)?.[1] ?? null
const wszystkie = (body: string, nazwa: string) => [...body.matchAll(new RegExp(`<${nazwa}>([^<]*)</${nazwa}>`, 'g'))].map((m) => m[1]!)

export interface OpcjeAtrapy {
  /** Błąd danych z `addShipment` (np. zły kod pocztowy). */
  bladDodania?: { numer: number; opis: string }
  /** Awaria sieci/serwera dla metody (raz): przed wykonaniem albo po wykonaniu (odpowiedź zgubiona). */
  awarie?: Record<string, Awaria[]>
  /** Opis błędu przy powtórzonym GUID (domyślnie z „guid”; inny = nieznany wzorzec). */
  opisDuplikatu?: string
  /** addShipment dodaje przesyłkę, ale odpowiada błędem spoza wzorców (nieznany błąd po wykonaniu). */
  bladPoDodaniu?: { numer: number; opis: string }
  /** getAddresLabelByGuidCompact zwraca ten błąd zamiast „nie znaleziono” (nierozpoznana odpowiedź). */
  bladOdczytuGuid?: { numer: number; opis: string }
  /** Bufor pokazuje guid jako atrybut `<przesylka guid="…">` zamiast elementu. */
  guidJakoAtrybut?: boolean
  /** Odpowiedź Śledzenia: status i zdarzenia; `http` = awaria HTTP (np. 500 z Faultem WSSE). */
  sledzenie?: { status: number; zdarzenia?: { czas: string; kod: string }[] } | { http: number; body: string }
}

export function ppAtrapa(o: OpcjeAtrapy = {}) {
  const calls: WywolaniePP[] = []
  let nrBufora = 100
  let nrPrzesylki = 1
  const bufory: BuforAtrapy[] = [
    // bufor założony ręcznie w eNadawcy: Kompletor nie może go wysłać ani czyścić
    { id: '7', opis: 'Moje paczki', urzad: PP_URZAD, przesylki: [{ guid: 'B'.repeat(32), numer: '00659007734000000099' }], wyslany: false },
  ]
  const wyslane: PrzesylkaAtrapy[] = []
  const awarie = { ...(o.awarie ?? {}) }

  function wykonaj(metoda: string, body: string): string {
    switch (metoda) {
      case 'getUrzedyNadania':
        return koperta(metoda, `<urzedyNadania><urzadNadania>${PP_URZAD}</urzadNadania><opis>UP Testowo 1</opis></urzedyNadania>`)
      case 'getEnvelopeBuforList':
        return koperta(metoda, bufory.filter((b) => !b.wyslany).map((b) => `<bufor><idBufor>${b.id}</idBufor><dataNadania>${b.opis.slice(-10)}</dataNadania><urzadNadania>${b.urzad}</urzadNadania><opis>${esc(b.opis)}</opis><active>true</active></bufor>`).join(''))
      case 'getEnvelopeBufor': {
        const b = bufory.find((x) => x.id === pole(body, 'idBufor') && !x.wyslany)
        if (!b) return koperta(metoda, blad(1001, 'Bufor nie istnieje'))
        return koperta(metoda, b.przesylki.map((p) => (o.guidJakoAtrybut ? `<przesylka guid="${p.guid}">` : `<przesylka><guid>${p.guid}</guid>`) + `<numerNadania>${p.numer}</numerNadania>${dane(p)}</przesylka>`).join(''))
      }
      case 'getAddresLabelByGuidCompact': {
        const g = pole(body, 'guid')
        const p = wyslane.find((x) => x.guid === g)
        if (!p && o.bladOdczytuGuid) return koperta(metoda, blad(o.bladOdczytuGuid.numer, o.bladOdczytuGuid.opis))
        return koperta(metoda, p ? `<content><guid>${p.guid}</guid><numerNadania>${p.numer}</numerNadania>${dane(p)}<pdfContent>JVBERi0=</pdfContent></content>` : blad(1501, 'Nie znaleziono przesyłki o podanym guid'))
      }
      case 'createEnvelopeBufor': {
        const id = String(nrBufora++)
        bufory.push({ id, opis: pole(body, 'opis') ?? '', urzad: pole(body, 'urzadNadania') ?? '', przesylki: [], wyslany: false })
        return koperta(metoda, `<createdBufor><idBufor>${id}</idBufor></createdBufor>`)
      }
      case 'addShipment': {
        const guid = /guid="([0-9A-F]{32})"/.exec(body)?.[1] ?? ''
        const b = bufory.find((x) => x.id === pole(body, 'idBufor') && !x.wyslany)
        if (!b) return koperta(metoda, `<retval>${blad(1001, 'Bufor nie istnieje albo został wysłany', guid)}<guid>${guid}</guid></retval>`)
        if (o.bladDodania) return koperta(metoda, `<retval>${blad(o.bladDodania.numer, o.bladDodania.opis, guid)}<guid>${guid}</guid></retval>`)
        if ([...bufory.flatMap((x) => x.przesylki), ...wyslane].some((p) => p.guid === guid)) return koperta(metoda, `<retval>${blad(2001, o.opisDuplikatu ?? 'Przesyłka o podanym guid już istnieje', guid)}<guid>${guid}</guid></retval>`)
        const numer = `0065900773400000${String(nrPrzesylki++).padStart(4, '0')}`
        const adres = /<adres>([\s\S]*?)<\/adres>/.exec(body)?.[1] ?? ''
        const nl = pole(adres, 'numerLokalu')
        b.przesylki.push({ guid, numer, kod: pole(adres, 'kodPocztowy') ?? '', ulica: pole(adres, 'ulica') ?? '', numerDomu: pole(adres, 'numerDomu') ?? '', ...(nl ? { numerLokalu: nl } : {}), masa: pole(body, 'masa') ?? '', format: pole(body, 'format') ?? '' })
        if (o.bladPoDodaniu) return koperta(metoda, `<retval>${blad(o.bladPoDodaniu.numer, o.bladPoDodaniu.opis, guid)}<guid>${guid}</guid></retval>`)
        return koperta(metoda, `<retval><numerNadania>${numer}</numerNadania><guid>${guid}</guid></retval>`)
      }
      case 'clearEnvelopeByGuids': {
        const guidy = wszystkie(body, 'guid')
        const b = bufory.find((x) => x.id === pole(body, 'idBufor') && !x.wyslany)
        if (!b) return koperta(metoda, `<retval>false</retval>${blad(1001, 'Bufor nie istnieje')}`)
        b.przesylki = b.przesylki.filter((p) => !guidy.includes(p.guid))
        return koperta(metoda, '<retval>true</retval>')
      }
      case 'getPrintForParcel':
        return koperta(metoda, `<printResult><guid>${pole(body, 'guid')}</guid><print>JVBERi0xLjQK</print></printResult>`)
      case 'zamowKuriera':
        return koperta(metoda, '')
      case 'sendEnvelope': {
        const b = bufory.find((x) => x.id === pole(body, 'idBufor') && !x.wyslany)
        if (!b) return koperta(metoda, blad(1001, 'Bufor nie istnieje'))
        b.wyslany = true
        wyslane.push(...b.przesylki)
        return koperta(metoda, `<idEnvelope>555</idEnvelope><envelopeStatus>WYSLANY</envelopeStatus>`)
      }
      case 'clearEnvelope':
        // gdyby ktoś to wysłał: czyści cały bufor konta (test pilnuje, że Kompletor tego nie robi)
        for (const b of bufory) b.przesylki = []
        return koperta(metoda, '<retval>true</retval>')
      default:
        throw new Error(`atrapa: nieznana metoda ${metoda}`)
    }
  }

  function sledzenie(body: string): { status: number; body: string } {
    const s = o.sledzenie ?? { status: 0, zdarzenia: [{ czas: '2026-11-08 10:00', kod: 'P_NAD' }] }
    if ('http' in s) return { status: s.http, body: s.body }
    const z = (s.zdarzenia ?? []).map((x) => `<zdarzenie><czas>${x.czas}</czas><kod>${x.kod}</kod><nazwa>zdarzenie</nazwa></zdarzenie>`).join('')
    return { status: 200, body: koperta('sprawdzPrzesylke', `<return><numer>${pole(body, 'numer')}</numer><status>${s.status}</status><danePrzesylki><zdarzenia>${z}</zdarzenia></danePrzesylki></return>`, 'http://sledzenie.pocztapolska.pl') }
  }

  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const body = String(init?.body ?? '')
    const headers = { ...(init?.headers as Record<string, string>) }
    const metoda = /<tns:(\w+)[\s>]/.exec(body)?.[1] ?? '?'
    calls.push({ url, metoda, headers, body })
    if (url.includes('Sledzenie')) {
      const r = sledzenie(body)
      return new Response(r.body, { status: r.status })
    }
    const a = awarie[metoda]?.shift()
    if (a?.po === 'przed') {
      if (a.blad) throw a.blad
      return new Response(a.body ?? '', { status: a.status ?? 500 })
    }
    const wynik = wykonaj(metoda, body)
    if (a?.po === 'po') {
      if (a.blad) throw a.blad
      return new Response(a.body ?? '', { status: a.status ?? 500 })
    }
    return new Response(wynik, { status: 200 })
  }
  return { calls, fetchImpl, bufory, wyslane, metody: () => calls.map((c) => c.metoda) }
}
