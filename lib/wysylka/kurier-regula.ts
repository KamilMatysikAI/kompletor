// Wybór przedziału podjazdu kuriera i decyzja automatu „Zamawiaj kuriera automatycznie”. Funkcje czyste, bez bazy i
// sieci, bezpieczne dla komponentu klienta (okno „Zamów kuriera” bierze z nich domyślne godziny). Część z bazą i
// żądaniem do przewoźnika: lib/wysylka/zamowienie-kuriera.ts (`zamowKurieraAutomatycznie`).
//
// REGUŁA WYBORU PRZEDZIAŁU (do potwierdzenia przez właściciela firmy; zmiana = tabela `REGULA_DPD` niżej):
//   1. kandydaci = przedziały z dostępności przewoźnika na ten dzień; gdy odczyt ich nie dał, znane przedziały z reguły;
//   2. na dziś zostają tylko przedziały, które da się jeszcze zamówić: „zamawiaj do” z reguły (znany przedział) albo
//      początek przedziału (nieznany), minus zapas `zapasMin`; na kolejne dni wszystkie;
//   3. odrzucone już tego dnia przedziały odpadają;
//   4. wygrywa przedział obejmujący godzinę odbioru z harmonogramu firmy (najszerszy z takich), a bez takiego najszerszy;
//      remis = wcześniejszy początek.
// Dla DPD daje to: przed 10:45 okno 09:00–17:00, potem do 13:45 okno 14:00–17:00, później dziś nic (automat czeka na
// kolejny dzień odbioru z harmonogramu).
import type { PrzedzialOdbioru } from './kurier-widok'

export interface PrzedzialReguly extends PrzedzialOdbioru {
  /** Najpóźniejsza godzina (minuty od północy), o której przewoźnik przyjmuje zamówienie na ten przedział dziś. */
  zamawiajDoMin: number
}

export interface RegulaPrzedzialu {
  /** Zapas w minutach przed „zamawiaj do” (zegar serwera, czas odpowiedzi przewoźnika). */
  zapasMin: number
  /** Znane przedziały przewoźnika z godziną „zamawiaj do”; pusta lista = tylko przedziały z dostępności. */
  znane: PrzedzialReguly[]
}

/**
 * DPD: przedziały z odczytu `courierOrderAvailability` (produkcja, 24.11.2026) z godziną „zamawiaj do” wyliczoną jako
 * koniec przedziału minus `offset` z tej odpowiedzi (09:00–17:00 offset 360 → 11:00; 11:00–14:00 i 14:00–17:00 offset
 * 180 → 11:00 i 14:00). Znaczenie `offset` to hipoteza zgodna z jedną odmową i jednym przyjęciem; reguła jest jawnym
 * ustaleniem, nie odczytem, więc DPD może przyjąć więcej (np. 12:00–17:00 przyjęte o 12:10).
 */
export const REGULA_DPD: RegulaPrzedzialu = {
  zapasMin: 15,
  znane: [
    { odMin: 9 * 60, doMin: 17 * 60, zamawiajDoMin: 11 * 60 },
    { odMin: 11 * 60, doMin: 14 * 60, zamawiajDoMin: 11 * 60 },
    { odMin: 14 * 60, doMin: 17 * 60, zamawiajDoMin: 14 * 60 },
  ],
}

/** Przewoźnik bez własnej reguły: tylko przedziały z dostępności, na dziś te, które się jeszcze nie zaczęły. */
export const REGULA_OGOLNA: RegulaPrzedzialu = { zapasMin: 15, znane: [] }

/** Reguła modułu wysyłki (rodzina klucza adaptera, np. `dpd.services.zapis.v1` → DPD). */
export function regulaPrzedzialu(adapterKey: string): RegulaPrzedzialu {
  return adapterKey.split('.')[0] === 'dpd' ? REGULA_DPD : REGULA_OGOLNA
}

const ten = (a: PrzedzialOdbioru, b: PrzedzialOdbioru) => a.odMin === b.odMin && a.doMin === b.doMin

/** Najpóźniejsza godzina zamówienia przedziału dziś wg reguły (nieznany przedział = jego początek). */
export function zamawiajDo(p: PrzedzialOdbioru, regula: RegulaPrzedzialu): number {
  return regula.znane.find((z) => ten(z, p))?.zamawiajDoMin ?? p.odMin
}

export interface WyborPrzedzialu {
  /** Przedziały z dostępności przewoźnika na ten dzień; null albo pusta = znane z reguły. */
  kandydaci: readonly PrzedzialOdbioru[] | null
  regula: RegulaPrzedzialu
  /** Dzień odbioru to dziś (Warszawa). */
  dzisiaj: boolean
  /** Minuta od północy (Warszawa). */
  terazMin: number
  /** Godzina odbioru z harmonogramu firmy (minuty), null = brak. */
  godzinaOdbioruMin: number | null
  /** Przedziały odrzucone już tego dnia. */
  pominiete?: readonly PrzedzialOdbioru[]
}

/** Przedział wg reguły (opis na górze pliku); null = nie ma czego zamówić. */
export function wybierzPrzedzial(w: WyborPrzedzialu): PrzedzialOdbioru | null {
  const baza = w.kandydaci && w.kandydaci.length ? w.kandydaci : w.regula.znane
  const lista = baza
    .map((p) => ({ odMin: p.odMin, doMin: p.doMin }))
    .filter((p) => p.odMin < p.doMin)
    .filter((p) => !w.dzisiaj || zamawiajDo(p, w.regula) - w.regula.zapasMin >= w.terazMin)
    .filter((p) => !(w.pominiete ?? []).some((x) => ten(x, p)))
  if (!lista.length) return null
  const szerszy = (a: PrzedzialOdbioru, b: PrzedzialOdbioru) => b.doMin - b.odMin - (a.doMin - a.odMin) || a.odMin - b.odMin
  const h = w.godzinaOdbioruMin
  const obejmujace = h === null ? [] : lista.filter((p) => p.odMin <= h && h < p.doMin)
  return [...(obejmujace.length ? obejmujace : lista)].sort(szerszy)[0]!
}

// ─── Decyzja automatu ──────────────────────────────────────────────────────

/** `requestedBy` wierszy zamówienia kuriera złożonych przez automat (bez nowej kolumny). */
export const AUTOMAT_ID = 'automat'
/** Zadanie workera automatu (harmonogram co 2 minuty, lib/worker/harmonogram.ts). */
export const KURIER_AUTOMAT_JOB = 'wysylka-kurier-automat'
export const AUTOMAT_NAZWA = 'automat Kompletora'
/** Automat rusza tyle minut po utworzeniu najstarszej paczki czekającej na kuriera (magazyn zdąży dołożyć kolejne). */
export const OPOZNIENIE_AUTOMATU_MIN = 5
/** Najwięcej żądań automatu na dzień odbioru: pierwsze i jedno ponowienie na inny przedział po pewnej odmowie. */
export const MAX_PROB_AUTOMATU = 2

/** Po tylu minutach od odbioru status „czeka na kuriera” ze śledzenia uznajemy za wiarygodny (przewoźnik zdążył skanować). */
export const ZAPAS_SLEDZENIA_MIN = 120

/** Paczka z numerem nadania (stan UTWORZONA, bez anulowanych) tego modułu i konta, z ostatnim statusem ze śledzenia. */
export interface PaczkaAutomatu {
  wagaKg: number
  utworzonaMs: number
  /** Stan ze śledzenia (PRZED_NADANIEM | PRZEKAZANA | DORECZONA | NIEZNANY); null = jeszcze nie sprawdzana. */
  status: string | null
  sprawdzonaMs: number | null
}

/**
 * Wcześniejszy odbiór tego przewoźnika: zlecenie podjazdu (zamówione, w toku albo niewiadoma) na dzień przed dniem,
 * na który automat zamawia, albo samo „Przyjechał”. `koniecMs` = koniec okna podjazdu; `przyjazdMs` = kliknięte
 * „Przyjechał” na ten dzień.
 */
export interface OdbiorWczesniejszy {
  dzien: string
  koniecMs: number | null
  przyjazdMs: number | null
}

export interface PaczkiCzekajace {
  liczba: number
  wagaKg: number
  minutOdNajstarszej: number | null
  /** Paczki, o których nie wiadomo, czy czekają (status nierozpoznany, kurier mógł ich nie zabrać). */
  niepewne: number
  /** Dzień wcześniejszego odbioru, który jeszcze trwa (paczki zabierze tamten kurier); null = nic nie trwa. */
  czekaNaOdbior: string | null
}

/**
 * Które paczki naprawdę czekają na kuriera dnia, na który automat zamawia. Granica = ostatni odbiór: „Przyjechał”
 * (moment kliknięcia), a dla zamówionego podjazdu bez kliknięcia koniec jego okna. Liczy się paczka:
 *   - utworzona po granicy, bez statusu ze śledzenia albo ze statusem „czeka na kuriera”;
 * nie liczy się: odebrana albo doręczona wg śledzenia; utworzona przed granicą (zabrał ją poprzedni kurier), chyba że
 * śledzenie co najmniej `ZAPAS_SLEDZENIA_MIN` po granicy dalej mówi „czeka na kuriera” — wtedy jest niepewna, tak jak
 * paczka z nierozpoznanym statusem. Wcześniejszy odbiór, którego okno jeszcze trwa i nikt nie kliknął „Przyjechał”,
 * wstrzymuje liczenie (`czekaNaOdbior`): paczki z dziś zabierze tamten kurier.
 * Bez żadnej granicy (nikt nie kliknął „Przyjechał” i nie ma zlecenia konta z ostatnich dni) Kompletor nie wie, czy
 * starsze paczki ktoś już odebrał (kurier zamówiony telefonicznie albo w panelu przewoźnika): paczka utworzona przed
 * dzisiejszą północą czasu polskiego (`polnocDzisMs`) jest wtedy niepewna i się nie liczy.
 */
export function paczkiCzekajace(paczki: readonly PaczkaAutomatu[], odbiory: readonly OdbiorWczesniejszy[], terazMs: number, polnocDzisMs: number | null = null): PaczkiCzekajace {
  const trwa = odbiory.find((o) => o.przyjazdMs === null && o.koniecMs !== null && o.koniecMs > terazMs)
  const granica = odbiory.reduce<number | null>((g, o) => {
    const m = o.przyjazdMs ?? (o.koniecMs !== null && o.koniecMs <= terazMs ? o.koniecMs : null)
    return m === null ? g : Math.max(g ?? m, m)
  }, null)
  let liczba = 0
  let waga = 0
  let najstarsza: number | null = null
  let niepewne = 0
  for (const p of paczki) {
    if (p.status === 'PRZEKAZANA' || p.status === 'DORECZONA') continue
    if (p.status !== null && p.status !== 'PRZED_NADANIEM') {
      niepewne++
      continue
    }
    if (granica === null && polnocDzisMs !== null && p.utworzonaMs < polnocDzisMs) {
      niepewne++
      continue
    }
    if (granica !== null && p.utworzonaMs <= granica) {
      if (p.status === 'PRZED_NADANIEM' && p.sprawdzonaMs !== null && p.sprawdzonaMs >= granica + ZAPAS_SLEDZENIA_MIN * 60_000) niepewne++
      continue
    }
    liczba++
    waga += p.wagaKg
    najstarsza = najstarsza === null ? p.utworzonaMs : Math.min(najstarsza, p.utworzonaMs)
  }
  return {
    liczba,
    wagaKg: Math.round(waga * 100) / 100,
    minutOdNajstarszej: najstarsza === null ? null : Math.floor((terazMs - najstarsza) / 60_000),
    niepewne,
    czekaNaOdbior: trwa?.dzien ?? null,
  }
}

/** Wiersz zamówienia kuriera na dzień odbioru (wszystkie próby, ręczne i automatu). */
export interface ProbaDnia {
  stan: string
  odMin: number
  doMin: number
  /** Rozstrzygnięte ręcznie („przyjął” / „nie przyjął”). */
  recznie: boolean
  automat: boolean
  /** Odmowa jest pewną odmową godzin podjazdu (`czyOdmowaGodzin` z powodu odmowy); tylko po niej automat ponawia. */
  odmowaGodzin: boolean
}

/**
 * Pewna odmowa godzin podjazdu: przewoźnik nie przyjął przedziału (DPD: `INCORRECT_PICKUP_TIME`, „Time frame not
 * allowed”, „no available time slots”). Tylko po takiej odmowie ma sens ponowienie w innym przedziale; każda inna
 * odmowa (nieznany błąd, usługa niedostępna, limit żądań, błąd danych) zatrzymuje automat na ten dzień.
 */
export function czyOdmowaGodzin(powod: string | null | undefined): boolean {
  return !!powod && /INCORRECT_PICKUP_TIME|time frame not allowed|no available time slots/i.test(powod)
}

export interface WejscieAutomatu {
  /** Dzień odbioru z harmonogramu firmy (RRRR-MM-DD); null = brak harmonogramu. */
  dzien: string | null
  dzis: string
  terazMin: number
  /** Dzień odbioru jest dniem roboczym (bez świąt). */
  dzienRoboczy: boolean
  godzinaOdbioruMin: number | null
  /** Paczki czekające na kuriera (`paczkiCzekajace`); `minutOdNajstarszej` = minuty od utworzenia najstarszej. */
  paczki: PaczkiCzekajace | null
  proby: readonly ProbaDnia[]
  kandydaci: readonly PrzedzialOdbioru[] | null
  regula: RegulaPrzedzialu
}

export type DecyzjaAutomatu =
  | { decyzja: 'ZAMOW'; przedzial: PrzedzialOdbioru; ponowienie: boolean }
  /** Jeszcze nie teraz (brak paczek, opóźnienie po pierwszej paczce): automat spróbuje przy kolejnym przebiegu. */
  | { decyzja: 'CZEKA'; powod: string }
  /** Na ten dzień automat nic nie zamówi; `alert` = magazyn powinien się dowiedzieć (zamówić ręcznie). */
  | { decyzja: 'STOP'; powod: string; alert: boolean }

const AKTYWNE = ['TWORZENIE', 'ZAMOWIONY', 'NIEJEDNOZNACZNY']
const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

/**
 * Czy automat ma teraz zamówić podjazd. Kolejność bramek: harmonogram → dzień roboczy → JAKIEKOLWIEK zlecenie na ten
 * dzień poza pewną odmową (ręczne albo automatu, w toku, przyjęte, niewiadoma, ręczne „nie przyjął”) → odmowa inna niż
 * pewna odmowa godzin (ręczna albo automatu) = STOP z alertem → paczki
 * (nieustalone = STOP z alertem; trwa wcześniejszy odbiór = czeka; same niepewne = STOP z alertem) →
 * opóźnienie → limit prób automatu → przedział. Automat nigdy nie zamawia drugiego podjazdu.
 */
export function ocenAutomatu(w: WejscieAutomatu): DecyzjaAutomatu {
  if (!w.dzien) return { decyzja: 'STOP', powod: 'brak harmonogramu odbiorów tego przewoźnika (Ustawienia → Wysyłka i druk → Przewoźnicy), więc automat nie wie, na który dzień zamówić podjazd', alert: false }
  if (!w.dzienRoboczy) return { decyzja: 'STOP', powod: 'dzień odbioru z harmonogramu jest dniem wolnym', alert: false }
  const aktywna = w.proby.find((p) => AKTYWNE.includes(p.stan))
  if (aktywna?.stan === 'ZAMOWIONY') return { decyzja: 'STOP', powod: 'podjazd na ten dzień jest już zamówiony', alert: false }
  if (aktywna?.stan === 'TWORZENIE') return { decyzja: 'STOP', powod: 'zamówienie podjazdu na ten dzień jest w toku', alert: false }
  if (aktywna) return { decyzja: 'STOP', powod: 'nie wiadomo, czy przewoźnik przyjął zamówienie na ten dzień, więc automat nie ponawia; sprawdź u przewoźnika i zaznacz wynik', alert: false }
  if (w.proby.some((p) => p.stan === 'BLAD' && p.recznie)) return { decyzja: 'STOP', powod: 'zamówienie na ten dzień zaznaczono ręcznie jako nieprzyjęte, więc automat nie zamawia (kolejne zamówienie tylko ręcznie)', alert: false }
  if (w.proby.some((p) => p.stan === 'BLAD' && !p.odmowaGodzin))
    return { decyzja: 'STOP', powod: 'przewoźnik odrzucił zamówienie na ten dzień z powodu innego niż godziny podjazdu, więc automat nie ponawia: sprawdź powód przy pasku kuriera i zamów kuriera ręcznie, jeśli trzeba', alert: true }
  if (!w.paczki) return { decyzja: 'STOP', powod: 'nie udało się ustalić, które paczki czekają na kuriera: zamów kuriera ręcznie, jeśli trzeba', alert: true }
  if (w.paczki.czekaNaOdbior) return { decyzja: 'CZEKA', powod: `czeka na odbiór ${w.paczki.czekaNaOdbior === w.dzis ? 'z dziś' : `z ${w.paczki.czekaNaOdbior.slice(8, 10)}.${w.paczki.czekaNaOdbior.slice(5, 7)}`}: kolejny podjazd zamówi dla paczek, które zostaną po nim (po kliknięciu „Przyjechał” albo po końcu okna podjazdu)` }
  if (w.paczki.liczba < 1 && w.paczki.niepewne > 0)
    return { decyzja: 'STOP', powod: `nie wiadomo, czy ${w.paczki.niepewne === 1 ? 'paczka czeka' : `paczki (${w.paczki.niepewne}) czekają`} na kuriera (kurier mógł ich nie zabrać albo przewoźnik podaje nierozpoznany status): sprawdź i zamów kuriera ręcznie, jeśli trzeba`, alert: true }
  if (w.paczki.liczba < 1) return { decyzja: 'CZEKA', powod: 'zamówi podjazd po pierwszej paczce z numerem nadania' }
  if (!(w.paczki.wagaKg > 0)) return { decyzja: 'STOP', powod: 'paczki czekające na kuriera nie mają wagi: zamów kuriera ręcznie i wpisz wagę', alert: true }
  if (w.paczki.minutOdNajstarszej !== null && w.paczki.minutOdNajstarszej < OPOZNIENIE_AUTOMATU_MIN) return { decyzja: 'CZEKA', powod: `zamówi podjazd kilka minut po pierwszej paczce` }
  const automatu = w.proby.filter((p) => p.automat)
  if (automatu.length >= MAX_PROB_AUTOMATU) return { decyzja: 'STOP', powod: `przewoźnik ${automatu.length} razy odmówił, więc automat już nie ponawia: zamów kuriera ręcznie albo zadzwoń do przewoźnika`, alert: false }
  const pominiete = w.proby.filter((p) => p.stan === 'BLAD')
  const p = wybierzPrzedzial({ kandydaci: w.kandydaci, regula: w.regula, dzisiaj: w.dzien === w.dzis, terazMin: w.terazMin, godzinaOdbioruMin: w.godzinaOdbioruMin, pominiete })
  if (!p) {
    const powod =
      w.dzien === w.dzis && !pominiete.length
        ? `na dziś jest już za późno na automatyczne zamówienie (${w.regula.znane.length ? `przewoźnik przyjmuje zamówienia na dziś zwykle do ${hm(Math.max(...w.regula.znane.map((z) => z.zamawiajDoMin)))}` : 'żaden przedział nie zostaje'}): zamów kuriera ręcznie albo zadzwoń do przewoźnika`
        : 'nie ma już innego przedziału podjazdu na ten dzień: zamów kuriera ręcznie albo zadzwoń do przewoźnika'
    return { decyzja: 'STOP', powod, alert: true }
  }
  return { decyzja: 'ZAMOW', przedzial: p, ponowienie: automatu.length > 0 }
}
