// (R6 przeglądu TwojOMS): wyszukiwanie na liście zamówień z adresu strony → filtry listy. Jedno miejsce dla
// ekranu, eksportu CSV i akcji „na wszystkich stronach”, żeby wszystkie trzy liczyły ten sam zbiór zamówień.
//  - `qz` (jedno pole szukania): fraza zaszyfrowana dla tej osoby (lib/klienci/fraza-token.ts, 2 h). Szukamy po
//    zamówieniach (`q`: numer, numer przesyłki, SKU, EAN, nazwa produktu) i, z uprawnieniem `klienci.dane`, po klientach:
//    e-mail, telefon, NIP przez skróty HMAC (bez odszyfrowania). Fraza z literami fragmentem nazwiska albo firmy
//    (odszyfrowanie najnowszych rekordów w pamięci serwera, lib/klienci/szukaj-fragment.ts) tylko wtedy, gdy osoba
//    zaznaczyła „także w danych klientów” (flaga `k` w tokenie; nazwa produktu czy SKU nie odszyfrowuje
//    klientów i nie pisze wpisu w dzienniku podglądów przy każdej stronie). Wynik = suma.
//  - 9 cyfr najpierw jako numer zamówienia: gdy trafia w numer, nie szukamy telefonu klienta (bez
//    wpisu w dzienniku przy każdym odświeżeniu).
//  - `q` jawnie (osoba bez `klienci.dane` albo stary link): tylko zamówienia.
//  - `kh`/`kr` i `kf` (linki, pole „Klient”): jak dotąd, sam klient.
import type { PrismaClient } from '@prisma/client'
import { otworzFraze, otworzTokenFrazy } from '../klienci/fraza-token'
import { szukajKlientaPoFrazie, szukajPoSkrocie } from '../klienci/odczyt'
import { FRAZA_MIN, normalizujTekst, zamowieniaKlientaFragmentem } from '../klienci/szukaj-fragment'
import type { Env } from '../sekrety'
import { filtryZ, warunkiNumeru, type FiltryListy } from './zamowienia-lista'

type Parametry = Record<string, string | string[] | undefined>
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export interface StanSzukania {
  /** fraza z pola szukania (odszyfrowana) albo `q`; wraca do pola, nigdy do adresu */
  fraza: string | null
  /** zamówień klientów pasujących do frazy (null = po klientach nie szukano) */
  klientow: number | null
  /** przy szukaniu fragmentem: ile ostatnich rekordów klientów przejrzano */
  przejrzane: number | null
  /** komunikat dla osoby (wygasłe wyszukiwanie, brak klucza, brak uprawnienia, za krótka fraza) */
  komunikat: string | null
  /** fraza z `qz` szuka także fragmentem w danych klientów (pole „także w danych klientów”) */
  wKlientach: boolean
  /** stary link `kh`/`kf`: opis wyniku */
  stary: { rodzaj: 'email' | 'telefon' | 'fragment'; ile: number; przejrzane?: number } | null
}

export interface KontekstSzukania {
  db: PrismaClient
  actorId: string
  organizationId: string
  canKlient: boolean
  env?: Env
}

const KOMUNIKATY: Record<string, string> = {
  krotka: 'Wpisz co najmniej 3 litery nazwiska albo firmy, e-mail albo telefon.',
  klucz: 'Szukanie po kliencie jest wyłączone: brak klucza danych klientów na tej instalacji (administrator).',
  uprawnienia: 'Szukanie po e-mailu albo telefonie klienta wymaga dostępu do danych klientów (Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia).',
}
const WYGASLO = 'Wyszukiwanie wygasło (ważne 2 godziny) albo należy do innej osoby: wpisz frazę jeszcze raz.'
const CUDZE = 'To wyszukiwanie wymaga dostępu do danych klientów albo należy do innej osoby: wpisz frazę jeszcze raz.'

/** Komunikat z `kb` tylko z własnych kluczy (`?kb=__proto__` nie może dać obiektu do widoku). */
export function komunikatZ(kb: string | undefined): string | null {
  return kb && Object.hasOwn(KOMUNIKATY, kb) ? KOMUNIKATY[kb]! : null
}

/** 9 cyfr: numer zamówienia albo telefon; najpierw sprawdzamy numer. */
async function trafiaWNumer(db: PrismaClient, fraza: string): Promise<boolean> {
  const q = fraza.trim()
  if (!/^\d{9}$/.test(q)) return false
  // także numer zamówienia BL (numer główny na liście i karcie Empiku), żeby nie szukać go jako telefonu
  const o = await db.order.findFirst({ where: { OR: warunkiNumeru(q) }, select: { id: true } })
  return !!o
}

export async function filtryZSzukaniem(sp: Parametry, k: KontekstSzukania): Promise<{ f: FiltryListy; szukanie: StanSzukania }> {
  const f = filtryZ(sp)
  const env = k.env ?? process.env
  const s: StanSzukania = { fraza: f.q ?? null, klientow: null, przejrzane: null, komunikat: komunikatZ(one(sp.kb)), wKlientach: false, stary: null }
  const qz = one(sp.qz) ?? ''
  // token bez uprawnienia (link od kolegi, odebrany dostęp) nie znika bez słowa
  if (!k.canKlient) return { f, szukanie: qz && !s.komunikat ? { ...s, komunikat: CUDZE } : s }

  if (qz) {
    const t = otworzTokenFrazy(env, k.organizationId, k.actorId, qz)
    if (!t) return { f, szukanie: { ...s, komunikat: WYGASLO } }
    const fraza = t.fraza
    f.q = fraza.slice(0, 100)
    s.fraza = fraza
    s.wKlientach = t.klienci
    const r = (await trafiaWNumer(k.db, fraza)) ? ({ stan: 'INNA_FRAZA' } as const) : await szukajKlientaPoFrazie(k.db, fraza, { actorId: k.actorId, env })
    if (r.stan === 'OK') {
      f.idsKlienta = r.orderIds
      s.klientow = r.orderIds.length
    } else if (r.stan === 'INNA_FRAZA' && t.klienci && /\p{L}/u.test(fraza) && normalizujTekst(fraza).length >= FRAZA_MIN) {
      const fr = await zamowieniaKlientaFragmentem(k.db, fraza, { actorId: k.actorId, env })
      if (fr.stan === 'OK') {
        f.idsKlienta = fr.orderIds
        s.klientow = fr.orderIds.length
        s.przejrzane = fr.przejrzane
      }
    } else if (r.stan === 'BRAK_KLUCZA') s.komunikat = KOMUNIKATY.klucz!
    return { f, szukanie: s }
  }

  // linki: sam klient (skrót e-maila/telefonu albo zaszyfrowany fragment)
  const skrotKlienta = one(sp.kh) ?? ''
  if (skrotKlienta) {
    const kr = one(sp.kr) === 'email' ? 'email' : 'telefon'
    const w = await szukajPoSkrocie(k.db, kr, skrotKlienta, { actorId: k.actorId })
    f.ids = w.stan === 'OK' ? w.orderIds : []
    if (w.stan === 'OK') s.stary = { rodzaj: kr, ile: w.orderIds.length }
    return { f, szukanie: s }
  }
  const kf = one(sp.kf) ?? ''
  if (kf) {
    const fraza = otworzFraze(env, k.organizationId, k.actorId, kf)
    if (!fraza) return { f, szukanie: { ...s, komunikat: WYGASLO } }
    const fr = await zamowieniaKlientaFragmentem(k.db, fraza, { actorId: k.actorId, env })
    f.ids = fr.stan === 'OK' ? fr.orderIds : []
    s.fraza = fraza
    if (fr.stan === 'OK') s.stary = { rodzaj: 'fragment', ile: fr.orderIds.length, przejrzane: fr.przejrzane }
  }
  return { f, szukanie: s }
}
