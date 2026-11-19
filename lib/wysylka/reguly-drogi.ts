// Reguły firmy na osi statusów przesyłki (po „Wysłane”), czyste funkcje. Host: lib/pakowanie/wyslane-po-przyjezdzie.ts
// (`wykonajRegulyDrogi`), który wykonuje skutki pod blokadą zamówienia, raz na wiersz historii przesyłki.
//   - doręczona: zamówienie „Wysłane” przechodzi w „Odebrane” (przełącznik „Doręczona paczka = Odebrane”), gdy każda
//     aktywna przesyłka zamówienia jest doręczona; alert problemu tej przesyłki się zamyka;
//   - zwrot do nadawcy, problem (zaginięcie, reklamacja, odmowa w jednym kodzie): powiadomienie dla biura (przełącznik
//     „Powiadamiaj o zwrocie i problemie z paczką”), status zamówienia bez zmian, decyzję podejmuje człowiek;
//   - reszta stanów: tylko historia.
// Każdy skutek wymaga trybu pracy konta zamówienia (jak „Wysłane” ze śledzenia) i przewoźnika z listy objętych
// regułami (domyślnie tylko moduły z potwierdzonymi kodami końcowymi: InPost, Poczta Polska, Wysyłam z Allegro).
import type { StanDrogi } from './stany-przesylki'

export const ALERT_ZWROT_PRZESYLKI = 'PRZESYLKA_ZWROT'
export const ALERT_PROBLEM_PRZESYLKI = 'PRZESYLKA_PROBLEM'
export const kluczAlertuZwrotu = (shipmentId: string) => `przesylka-zwrot:${shipmentId}`
export const kluczAlertuProblemu = (shipmentId: string) => `przesylka-problem:${shipmentId}`

/**
 * Kody przewoźnika mapowane na zwrot, po których paczka może jeszcze trafić do odbiorcy (InPost: termin odbioru minął,
 * odbiorca odmówił). Zwrot z tych kodów daje tylko powiadomienie z zastrzeżeniem, nigdy zmianę statusu.
 */
export const KODY_ZAPOWIEDZI_ZWROTU: ReadonlySet<string> = new Set(['pickup_time_expired', 'rejected_by_receiver'])

export interface UstawieniaRegulDrogi {
  /** przełącznik „Doręczona paczka = Odebrane” */
  odebrane: boolean
  /** przełącznik „Powiadamiaj o zwrocie i problemie z paczką” */
  powiadomienia: boolean
  /** moduł przewoźnika przesyłki na liście objętych regułami */
  przewoznikObjety: boolean
  /** konto zamówienia w trybie pracy na instancji z trybem pracy */
  praca: boolean
}

export interface SkutekDrogi {
  odebrane: boolean
  alert: 'ZWROT' | 'PROBLEM' | null
  zamknijProblem: boolean
}

const NIC: SkutekDrogi = { odebrane: false, alert: null, zamknijProblem: false }

/** Skutki stanu na osi dla zamówienia (bez warunku „wszystkie przesyłki doręczone”: ten sprawdza host). */
export function skutkiDrogi(stan: StanDrogi, u: UstawieniaRegulDrogi): SkutekDrogi {
  if (!u.praca || !u.przewoznikObjety) return NIC
  if (stan === 'DORECZONA') return { odebrane: u.odebrane, alert: null, zamknijProblem: true }
  if ((stan === 'ZWROT' || stan === 'PROBLEM') && u.powiadomienia) return { ...NIC, alert: stan }
  return NIC
}

/**
 * Każda aktywna przesyłka zamówienia doręczona (pusta lista = nie: bez przesyłki nie ma czego doręczyć). Host podaje
 * aktywne przesyłki bieżącej paczki zamówienia, a indeks `Shipment_aktywna_paczka` dopuszcza najwyżej jedną taką
 * przesyłkę, więc dziś lista ma zero albo jeden element; funkcja zostaje ogólna na wypadek kilku przesyłek do paczki.
 */
export function wszystkieDoreczone(przesylki: readonly { trackState: StanDrogi | null }[]): boolean {
  return przesylki.length > 0 && przesylki.every((s) => s.trackState === 'DORECZONA')
}

/** Treść powiadomienia dla biura: numer zamówienia, numer nadania i kod przewoźnika, bez danych odbiorcy. */
export function trescAlertuDrogi(rodzaj: 'ZWROT' | 'PROBLEM', p: { nr: string; numerNadania: string | null; kod: string }): string {
  const paczka = `Paczka ${p.numerNadania ?? 'bez numeru'} zamówienia ${p.nr}`
  const kod = p.kod ? ` (kod przewoźnika: ${p.kod})` : ''
  if (rodzaj === 'PROBLEM')
    return `${paczka}: przewoźnik zgłasza problem${kod}, np. zaginięcie, reklamację albo odmowę przyjęcia. Sprawdź w panelu przewoźnika; status zamówienia się nie zmienił.`
  if (KODY_ZAPOWIEDZI_ZWROTU.has(p.kod))
    return `${paczka}: przewoźnik zapowiada zwrot do nadawcy${kod}. Paczka może jeszcze zostać odebrana przez klienta, zanim wyruszy w drogę powrotną. Status zamówienia się nie zmienił; gdy paczka wróci, przyjmij zwrot w „Zwroty i reklamacje”.`
  return `${paczka} wraca do nadawcy${kod}. Status zamówienia się nie zmienił; gdy paczka dotrze, przyjmij zwrot w „Zwroty i reklamacje” (powiadomienie zamknie się samo).`
}
