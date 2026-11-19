// POST /api/v1/zamowienia w kształcie ogólnym: treść z polem `kanal` (`RECZNE` albo
// `EASYTOOLS`). Bez pola `kanal` trasa przyjmuje dawny kształt EasyTools (lib/api/zapis.ts, zgodność wstecz).
// Schemat ścisły: nieznane pole = 400. Dane klienta wyłącznie w obiekcie `klient` (te same reguły co formularz karty:
// kod NN-NNN, e-mail, telefon ≥ 9 cyfr, NIP z sumą kontrolną); pole wyglądające na dane klienta poza nim = 400 z
// podpowiedzią. Komunikaty błędów podają nazwę pola, nigdy wartość z danych klienta.
import type { Carrier } from '@prisma/client'
import type { RekordKlienta } from '@/lib/klienci/rekord'
import { BladFormularzaKlienta, rekordZDanych } from '@/lib/klienci/walidacja'
import { KANALY_OGOLNE, type KanalOgolny, MAX_POZYCJI, METODA_DOMYSLNA, sumaPozycji, sumaZgodna, type ZamowienieOgolne } from '@/lib/zamowienia/ogolne'
import { ApiInputError } from './odpowiedzi'
import { amount, isObj, isPersonalField, parseLines, PAYMENTS, str } from './zapis'

const TOP = new Set(['kanal', 'konto', 'numer', 'zrodlo', 'zlozono', 'platnosc', 'platnoscMetoda', 'sumaBrutto', 'dostawa', 'chceFakture', 'klient', 'uwagi', 'pozycje'])
const DOSTAWA = new Set(['sposob', 'przewoznik', 'punkt', 'koszt'])
const PUNKT = new Set(['kod', 'nazwa'])
const KLIENT = new Set(['imieNazwisko', 'firma', 'email', 'telefon', 'adres', 'faktura'])
const ADRES = new Set(['ulica', 'numerDomu', 'numerLokalu', 'kodPocztowy', 'miasto', 'kraj'])
const FAKTURA = new Set(['nazwa', 'nip', 'ulica', 'kodPocztowy', 'miasto'])
export const PRZEWOZNICY_API: Carrier[] = ['PACZKOMATY', 'DPD', 'DPD_EMPIK', 'ALLEGRO', 'OSOBISTY']

/** Treść w kształcie ogólnym: obiekt z polem `kanal`. */
export const isGeneralShape = (body: unknown): boolean => isObj(body) && Object.prototype.hasOwnProperty.call(body, 'kanal')

function onlyFields(o: Record<string, unknown>, allowed: Set<string>, where: string, hint: boolean): void {
  for (const k of Object.keys(o)) {
    if (allowed.has(k)) continue
    const field = where ? `${where}.${k}` : k
    if (hint && isPersonalField(k)) throw new ApiInputError(`Pole ${field}: dane klienta podaj w obiekcie klient (imieNazwisko, firma, email, telefon, adres, faktura)`, field)
    throw new ApiInputError(`Nieznane pole ${field}`, field)
  }
}

function obj(o: Record<string, unknown> | null, k: string, field: string): Record<string, unknown> | null {
  const v = o?.[k]
  if (v === undefined || v === null) return null
  if (!isObj(v)) throw new ApiInputError(`${field}: obiekt`, field)
  return v
}

function txt(o: Record<string, unknown> | null, k: string, field: string): string | undefined {
  const v = o?.[k]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new ApiInputError(`${field}: tekst`, field)
  return v
}

/** Ścisła walidacja treści w kształcie ogólnym. Błąd = ApiInputError (400, rozjazd sumy 422). */
export function parseGeneralOrder(body: unknown): ZamowienieOgolne {
  if (!isObj(body)) throw new ApiInputError('Treść: obiekt JSON z polami zamówienia')
  onlyFields(body, TOP, '', true)
  const kanal = body.kanal
  if (typeof kanal !== 'string' || !(KANALY_OGOLNE as readonly string[]).includes(kanal)) throw new ApiInputError(`kanal: jedno z ${KANALY_OGOLNE.join(', ')}`, 'kanal')
  const konto = str(body, 'konto', 'konto', 64, { optional: true, re: /^[A-Za-z0-9._-]+$/ })
  const numer = str(body, 'numer', 'numer', 64, { re: /^[A-Za-z0-9][A-Za-z0-9._/-]*$/ })!
  const zrodlo = str(body, 'zrodlo', 'zrodlo', 80, { optional: true }) ?? null
  let zlozono: Date | null = null
  if (body.zlozono !== undefined) {
    const zRaw = str(body, 'zlozono', 'zlozono', 40, { re: /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})$/ })!
    zlozono = new Date(zRaw)
    if (Number.isNaN(zlozono.getTime())) throw new ApiInputError('zlozono: data ISO 8601 ze strefą, np. 2026-11-02T10:15:00Z', 'zlozono')
  }
  const platnosc = body.platnosc
  if (typeof platnosc !== 'string' || !(PAYMENTS as string[]).includes(platnosc))
    throw new ApiInputError(`platnosc: jedno z ${PAYMENTS.join(', ')} (opłacone, do zapłaty przelewem, za pobraniem)`, 'platnosc')
  const pl = platnosc as 'PAID' | 'UNPAID' | 'COD'
  const platnoscMetoda = str(body, 'platnoscMetoda', 'platnoscMetoda', 100, { optional: true }) ?? METODA_DOMYSLNA[pl]

  const d = obj(body, 'dostawa', 'dostawa')
  if (!d) throw new ApiInputError('dostawa: obiekt z polem sposob', 'dostawa')
  onlyFields(d, DOSTAWA, 'dostawa', true)
  const sposob = str(d, 'sposob', 'dostawa.sposob', 200)!
  let przewoznik: Carrier | null = null
  if (d.przewoznik !== undefined && d.przewoznik !== null) {
    if (typeof d.przewoznik !== 'string' || !(PRZEWOZNICY_API as string[]).includes(d.przewoznik))
      throw new ApiInputError(`dostawa.przewoznik: jedno z ${PRZEWOZNICY_API.join(', ')}`, 'dostawa.przewoznik')
    przewoznik = d.przewoznik as Carrier
  }
  const koszt = d.koszt === undefined || d.koszt === null ? null : amount(d, 'koszt', 'dostawa.koszt')
  const punkt = obj(d, 'punkt', 'dostawa.punkt')
  if (punkt) onlyFields(punkt, PUNKT, 'dostawa.punkt', false)

  const raw = body.pozycje
  if (!Array.isArray(raw) || !raw.length) throw new ApiInputError('pozycje: niepusta lista', 'pozycje')
  if (raw.length > MAX_POZYCJI) throw new ApiInputError(`pozycje: najwyżej ${MAX_POZYCJI}`, 'pozycje')
  const pozycje = parseLines(raw)

  let sumaBrutto = sumaPozycji(pozycje, koszt)
  if (body.sumaBrutto !== undefined) {
    const podana = amount(body, 'sumaBrutto', 'sumaBrutto')
    if (!sumaZgodna(podana, pozycje, koszt))
      throw new ApiInputError(`sumaBrutto: ${podana.toFixed(2)} nie zgadza się z pozycjami i kosztem dostawy (${sumaBrutto.toFixed(2)})`, 'sumaBrutto', 422, { policzona: sumaBrutto })
    sumaBrutto = podana
  }

  const k = obj(body, 'klient', 'klient')
  if (k) onlyFields(k, KLIENT, 'klient', false)
  const adres = obj(k, 'adres', 'klient.adres')
  if (adres) onlyFields(adres, ADRES, 'klient.adres', false)
  const fakt = obj(k, 'faktura', 'klient.faktura')
  if (fakt) onlyFields(fakt, FAKTURA, 'klient.faktura', false)
  const uwagi = txt(body, 'uwagi', 'uwagi')
  const punktKod = txt(punkt, 'kod', 'dostawa.punkt.kod')
  if (!k && (punktKod || uwagi)) throw new ApiInputError('klient: punkt odbioru i uwagi zapisujemy razem z danymi klienta (imieNazwisko albo firma)', 'klient')
  let klient: RekordKlienta | null = null
  if (k) {
    try {
      klient = rekordZDanych({
        imie: txt(k, 'imieNazwisko', 'klient.imieNazwisko'),
        firma: txt(k, 'firma', 'klient.firma'),
        email: txt(k, 'email', 'klient.email'),
        telefon: txt(k, 'telefon', 'klient.telefon'),
        ulica: txt(adres, 'ulica', 'klient.adres.ulica'),
        dom: txt(adres, 'numerDomu', 'klient.adres.numerDomu'),
        lokal: txt(adres, 'numerLokalu', 'klient.adres.numerLokalu'),
        kod: txt(adres, 'kodPocztowy', 'klient.adres.kodPocztowy'),
        miasto: txt(adres, 'miasto', 'klient.adres.miasto'),
        kraj: txt(adres, 'kraj', 'klient.adres.kraj'),
        punkt: punktKod,
        punkt_nazwa: txt(punkt, 'nazwa', 'dostawa.punkt.nazwa'),
        f_nazwa: txt(fakt, 'nazwa', 'klient.faktura.nazwa'),
        f_nip: txt(fakt, 'nip', 'klient.faktura.nip'),
        f_ulica: txt(fakt, 'ulica', 'klient.faktura.ulica'),
        f_kod: txt(fakt, 'kodPocztowy', 'klient.faktura.kodPocztowy'),
        f_miasto: txt(fakt, 'miasto', 'klient.faktura.miasto'),
        uwagi,
      })
    } catch (e) {
      if (e instanceof BladFormularzaKlienta) throw new ApiInputError(`klient: ${e.message}`, 'klient')
      throw e
    }
  }
  if (body.chceFakture !== undefined && typeof body.chceFakture !== 'boolean') throw new ApiInputError('chceFakture: true albo false', 'chceFakture')
  const chceFakture = body.chceFakture === undefined ? !!klient?.faktura?.nip : body.chceFakture === true
  if (chceFakture && !klient?.faktura) throw new ApiInputError('chceFakture: podaj dane do faktury w klient.faktura (co najmniej nazwa)', 'chceFakture')

  return {
    kanal: kanal as KanalOgolny,
    ...(konto ? { konto } : {}),
    numer,
    zrodlo,
    zlozono,
    platnosc: pl,
    platnoscMetoda,
    sumaBrutto,
    dostawa: { sposob, przewoznik, koszt },
    chceFakture,
    klient,
    pozycje,
  }
}
