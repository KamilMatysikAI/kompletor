// Liczenie przesyłki per adapter przewoźnika (/090/091): klucz adaptera z reguły przewoźnika → czysta funkcja
// parametrów przesyłki. Bez sieci, bazy i instancji adaptera, jak `prepareShipment` adapterów. Klucz spoza tej listy =
// podgląd „nie dotyczy”.
import type { PreparedParcel, ShipmentInput } from '../adaptery/kontrakt'
import { wyliczPrzesylkeAllegro } from './allegro'
import { ustawieniaDpd, wyliczPrzesylkeDpd } from './dpd'
import { ustawieniaInpost, wyliczPrzesylkeInpost } from './inpost'
import { ustawieniaGls, wyliczPrzesylkeGls } from './gls'
import { ustawieniaOrlen, wyliczPrzesylkeOrlen } from './orlenpaczka'
import { ustawieniaPP, wyliczPrzesylkePP } from './pocztapolska'
import { ustawieniaPrzesylki, wyliczPrzesylke } from './przesylka'

type Liczenie = (input: ShipmentInput, config: Record<string, unknown>) => PreparedParcel

export const LICZENIE_PRZESYLKI = {
  'basecourier.v1': (input, config) => wyliczPrzesylke(input, ustawieniaPrzesylki(config)),
  // nadawanie przez Base Courier liczy przesyłkę tak samo jak podgląd
  'basecourier.zapis.v1': (input, config) => wyliczPrzesylke(input, ustawieniaPrzesylki(config)),
  'allegro.wysylam.v1': (input, config) => wyliczPrzesylkeAllegro(input, ustawieniaPrzesylki(config)),
  // nadawanie Wysyłam z Allegro liczy przesyłkę tak samo jak podgląd
  'allegro.wysylam.zapis.v1': (input, config) => wyliczPrzesylkeAllegro(input, ustawieniaPrzesylki(config)),
  'inpost.shipx.v1': (input, config) => wyliczPrzesylkeInpost(input, ustawieniaInpost(config)),
  'inpost.shipx.zapis.v1': (input, config) => wyliczPrzesylkeInpost(input, ustawieniaInpost(config)),
  'dpd.services.v1': (input, config) => wyliczPrzesylkeDpd(input, ustawieniaDpd(config)),
  'dpd.services.zapis.v1': (input, config) => wyliczPrzesylkeDpd(input, ustawieniaDpd(config)),
  // Orlen Paczka (punkty i automaty, rozmiar S/M/L)
  'orlenpaczka.v1': (input, config) => wyliczPrzesylkeOrlen(input, ustawieniaOrlen(config)),
  'orlenpaczka.zapis.v1': (input, config) => wyliczPrzesylkeOrlen(input, ustawieniaOrlen(config)),
  // GLS przez ADE (kurier albo punkt ParcelShop)
  'gls.ade.v1': (input, config) => wyliczPrzesylkeGls(input, ustawieniaGls(config)),
  'gls.ade.zapis.v1': (input, config) => wyliczPrzesylkeGls(input, ustawieniaGls(config)),
  // Poczta Polska (Pocztex Kurier pod adres, format S…2XL z wymiarów)
  'pocztapolska.enadawca.v1': (input, config) => wyliczPrzesylkePP(input, ustawieniaPP(config)),
  'pocztapolska.enadawca.zapis.v1': (input, config) => wyliczPrzesylkePP(input, ustawieniaPP(config)),
} satisfies Record<string, Liczenie>

export type KluczPrzesylki = keyof typeof LICZENIE_PRZESYLKI

export const maLiczeniePrzesylki = (k: string | null | undefined): k is KluczPrzesylki => !!k && Object.hasOwn(LICZENIE_PRZESYLKI, k)
