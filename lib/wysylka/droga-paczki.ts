// Droga paczki na karcie zamówienia i na liście przesyłek: stan słowny z osi statusów (lib/wysylka/stany-przesylki.ts),
// data wejścia w obecny stan, link do strony śledzenia u przewoźnika (lib/wysylka/link-sledzenia.ts) i historia zdarzeń
// (`ShipmentTrackEvent`). Tylko odczyt z bazy, bez pytania przewoźnika i bez danych klienta (numer nadania nie jest
// daną osobową). Gdy firma nie włączyła „Śledź paczki aż do doręczenia”, nie pyta o paczki modułu, który nadał
// przesyłkę, albo paczka nie ma jeszcze odczytu, widok pokazuje numer i link, a zamiast historii jedno spokojne zdanie.
import type { Carrier, PrismaClient, ShipmentState, ShipmentTrackState } from '@prisma/client'
import { defaultRegistry } from '../adaptery/domyslne'
import type { AdapterRegistry } from '../adaptery/rejestr'
import { kluczeSledzenia } from '../pakowanie/wyslane-po-przyjezdzie'
import { CARRIER_LABEL } from '../panel/format'
import type { Ton } from '../panel/statusy'
import { automatyWysylki, sledzeniePrzewoznikow } from './automaty'
import { linkSledzeniaPanelu, stronaSledzenia } from './link-sledzenia'
import { jestRodzajDodatkowej, NAZWA_RODZAJU } from './dodatkowa'
import { jestKoncowy, OPIS_STANU_DROGI, SLEDZENIE_DO_KONCA_DNI } from './stany-przesylki'

type Db = PrismaClient

/** Kolor odznaki stanu drogi: doręczona zielona, zwrot czerwony, awizo i problem do uwagi, reszta spokojnie. */
export const TON_DROGI: Record<ShipmentTrackState, Ton> = {
  UTWORZONA: 'neutralny',
  PRZEKAZANA: 'info',
  W_DRODZE: 'info',
  W_DORECZENIU: 'info',
  W_PUNKCIE: 'uwaga',
  DORECZONA: 'sukces',
  NIEUDANE_DORECZENIE: 'ostrzezenie',
  ZWROT: 'blad',
  PROBLEM: 'ostrzezenie',
  ANULOWANA: 'neutralny',
  NIEZNANY: 'neutralny',
}

/** Ile ostatnich zdarzeń historii pokazuje karta (starsze zostają w bazie). */
export const HISTORIA_NA_KARCIE = 30

export interface ZdarzenieDrogi {
  id: string
  stan: ShipmentTrackState
  opis: string
  kiedy: Date
  /** kod albo opis zdarzenia u przewoźnika (np. „out_for_delivery”), do porównania z panelem przewoźnika */
  uPrzewoznika: string | null
}

export interface DrogaPrzesylki {
  id: string
  carrier: Carrier
  przewoznik: string
  numer: string | null
  link: string | null
  /** nazwa strony przewoźnika do tekstu linku („InPost”) */
  stronaLinku: string | null
  paczka: number
  stan: ShipmentTrackState | null
  stanOpis: string
  ton: Ton
  /** chwila wejścia w obecny stan (u przewoźnika), a bez odczytu chwila utworzenia przesyłki */
  odKiedy: Date
  /** „W tym stanie od” albo „Utworzona” (etykieta daty) */
  etykietaDaty: string
  /** przesyłka anulowana w Kompletorze, której przewoźnik nie widział w drodze */
  anulowana: boolean
  /** jedno zdanie zamiast historii, gdy jej nie ma (bez straszenia) */
  uwaga: string | null
  historia: ZdarzenieDrogi[]
  /** zdarzeń w bazie więcej niż na karcie */
  starszychZdarzen: number
  /** dodatkowa przesyłka do zamówienia (dosyłka, zastępcza, druga paczka); null = główna */
  dodatkowa: { numer: number; rodzaj: string; powod: string; kosztNetto: number | null } | null
}

export interface DaneDrogi {
  stan: ShipmentTrackState | null
  stanOd: Date | null
  utworzono: Date
  stanPrzesylki: ShipmentState
  /** firma włączyła „Śledź paczki aż do doręczenia” */
  doKonca: boolean
  /** Kompletor pyta o paczki modułu, który nadał przesyłkę (wybór firmy i moduł umie podać stan) */
  modulSledzony: boolean
  /** Kompletor przestał pytać o tę paczkę (`sledzenieZakonczone`) */
  zakonczona: boolean
  maLink: boolean
  maZdarzenia: boolean
}

/**
 * Kompletor już nie pyta przewoźnika o tę paczkę, niezależnie od przełączników firmy: przesyłka anulowana w Kompletorze,
 * śledzenie zakończone (`trackingStoppedAt`: seria błędów, brak przesyłki u przewoźnika) albo przesyłka starsza niż
 * okno śledzenia po „Wysłane” (SLEDZENIE_DO_KONCA_DNI). Te same warunki co wybór przesyłek do odczytu w
 * lib/pakowanie/wyslane-po-przyjezdzie.ts.
 */
export function sledzenieZakonczone(s: { state: ShipmentState; trackingStoppedAt: Date | null; createdAt: Date }, now: Date): boolean {
  return s.state !== 'UTWORZONA' || s.trackingStoppedAt !== null || s.createdAt.getTime() < now.getTime() - SLEDZENIE_DO_KONCA_DNI * 86_400_000
}

/** Kompletor dalej odświeża stan paczki: jedno miejsce dla karty zamówienia i API (pole `sledzona`). */
export function paczkaSledzona(d: Pick<DaneDrogi, 'doKonca' | 'modulSledzony' | 'zakonczona'>): boolean {
  return d.doKonca && d.modulSledzony && !d.zakonczona
}

/** Przesyłka anulowana w Kompletorze, której przewoźnik nie widział w drodze: bez stanu drogi i bez linku śledzenia. */
export function anulowanaBezDrogi(stanPrzesylki: ShipmentState, stan: ShipmentTrackState | null): boolean {
  return stanPrzesylki === 'ANULOWANA' && (!stan || stan === 'UTWORZONA' || stan === 'ANULOWANA')
}

/** Stan słowny, kolor, data i zdanie zastępujące pustą historię (czysta funkcja, testy w droga-paczki.test.ts). */
export function opisDrogi(d: DaneDrogi): Pick<DrogaPrzesylki, 'stanOpis' | 'ton' | 'odKiedy' | 'etykietaDaty' | 'uwaga'> {
  const etykietaDaty = d.stanOd ? 'W tym stanie od' : 'Utworzona'
  if (anulowanaBezDrogi(d.stanPrzesylki, d.stan))
    return { stanOpis: 'Anulowana', ton: 'neutralny', odKiedy: d.stanOd ?? d.utworzono, etykietaDaty, uwaga: d.maZdarzenia ? null : 'Przesyłka anulowana, paczka z tym numerem nie pojedzie.' }
  const gdzie = d.maLink ? 'pod linkiem obok numeru' : 'na stronie przewoźnika po numerze nadania'
  const sledzona = paczkaSledzona(d)
  if (d.stan) {
    let uwaga: string | null = d.maZdarzenia ? null : 'Historia pojawi się po kolejnym odczycie u przewoźnika.'
    if (d.stan === 'NIEZNANY') uwaga = `Przewoźnik podał stan, którego Kompletor nie rozpoznaje. Paczkę sprawdzisz ${gdzie}.`
    // stan zapisany wcześniej, a Kompletor już o tę paczkę nie pyta: bez tego zdania „W drodze” wisiałoby bez końca
    else if (!sledzona && d.stan !== 'UTWORZONA' && !jestKoncowy(d.stan)) uwaga = `Kompletor nie odświeża już stanu tej paczki. Aktualny stan sprawdzisz ${gdzie}.`
    return { stanOpis: OPIS_STANU_DROGI[d.stan], ton: TON_DROGI[d.stan], odKiedy: d.stanOd ?? d.utworzono, etykietaDaty, uwaga }
  }
  let uwaga: string
  if (!d.doKonca) uwaga = `Kompletor nie śledzi drogi tej paczki do doręczenia. Sprawdzisz ją ${gdzie}.`
  else if (!d.modulSledzony) uwaga = `Kompletor nie sprawdza drogi paczek tego przewoźnika, więc stan paczki się tu nie zmieni. Drogę paczki sprawdzisz ${gdzie}.`
  else if (d.zakonczona) uwaga = `Kompletor nie odświeża już stanu tej paczki. Drogę paczki sprawdzisz ${gdzie}.`
  else uwaga = `Przewoźnik nie podał jeszcze stanu paczki. Drogę paczki sprawdzisz ${gdzie}.`
  return { stanOpis: 'Utworzona u przewoźnika', ton: 'neutralny', odKiedy: d.utworzono, etykietaDaty: 'Utworzona', uwaga }
}

/** Przesyłki zamówienia utworzone u przewoźnika (także anulowane z numerem): główna, potem dodatkowe wg numeru; przy tej samej paczce aktywna przed anulowaną, z historią zdarzeń. */
export async function drogaPaczek(db: Db, orderId: string, registry: AdapterRegistry = defaultRegistry()): Promise<DrogaPrzesylki[]> {
  const [rows, automaty, wybory] = await Promise.all([
    db.shipment.findMany({
      where: { orderId, OR: [{ state: 'UTWORZONA' }, { state: 'ANULOWANA', trackingNumber: { not: null } }] },
      // główna przesyłka na górze, dodatkowe pod nią wg numeru; przy tym samym numerze aktywna przed anulowaną (kolejność enum ShipmentState)
      orderBy: [{ packageNo: 'asc' }, { extraNo: 'asc' }, { state: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }],
      select: {
        id: true,
        extraNo: true,
        extraKind: true,
        extraReason: true,
        extraCostNet: true,
        carrier: true,
        adapterKey: true,
        trackingNumber: true,
        packageNo: true,
        state: true,
        trackState: true,
        trackStateSince: true,
        trackedAt: true,
        trackingStoppedAt: true,
        createdAt: true,
        trackEvents: { orderBy: [{ occurredAt: 'desc' }, { observedAt: 'desc' }], take: HISTORIA_NA_KARCIE, select: { id: true, state: true, carrierCode: true, carrierStatus: true, occurredAt: true } },
        _count: { select: { trackEvents: true } },
      },
    }),
    automatyWysylki(db),
    sledzeniePrzewoznikow(db),
  ])
  // te same moduły, o które pyta sprawdzanie przesyłek w tle (wybór firmy i zdolność modułu)
  const sledzone = new Set(kluczeSledzenia(registry, wybory))
  const doKonca = automaty.sledzenie && automaty.sledzenieDoDoreczenia
  const now = new Date()
  return rows.map((s) => {
    const anulowana = anulowanaBezDrogi(s.state, s.trackState)
    // anulowana paczka nie pojedzie: link do śledzenia tylko myliłby
    const link = anulowana ? null : linkSledzeniaPanelu(s.carrier, s.trackingNumber, s.adapterKey)
    const historia: ZdarzenieDrogi[] = s.trackEvents.map((e) => ({ id: e.id, stan: e.state, opis: OPIS_STANU_DROGI[e.state], kiedy: e.occurredAt, uPrzewoznika: e.carrierStatus || e.carrierCode || null }))
    return {
      id: s.id,
      carrier: s.carrier,
      przewoznik: CARRIER_LABEL[s.carrier],
      numer: s.trackingNumber,
      link,
      stronaLinku: link ? stronaSledzenia(s.carrier) : null,
      paczka: s.packageNo,
      stan: s.trackState,
      anulowana,
      ...opisDrogi({
        stan: s.trackState,
        // ta sama data co na liście przesyłek
        stanOd: s.trackState ? (s.trackStateSince ?? s.trackedAt) : null,
        utworzono: s.createdAt,
        stanPrzesylki: s.state,
        doKonca,
        modulSledzony: sledzone.has(s.adapterKey),
        zakonczona: sledzenieZakonczone(s, now),
        maLink: !!link,
        maZdarzenia: historia.length > 0,
      }),
      historia,
      starszychZdarzen: Math.max(0, s._count.trackEvents - historia.length),
      dodatkowa:
        s.extraNo > 0
          ? { numer: s.extraNo, rodzaj: s.extraKind && jestRodzajDodatkowej(s.extraKind) ? NAZWA_RODZAJU[s.extraKind] : 'Dodatkowa przesyłka', powod: s.extraReason ?? '', kosztNetto: s.extraCostNet === null ? null : Number(s.extraCostNet) }
          : null,
    }
  })
}
