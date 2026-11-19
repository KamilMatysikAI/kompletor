// Sesja stanowiska pakowania: lista zamówień do spakowania jedno po drugim — z kolejki pakowania albo ze
// skanów kart. Czyste decyzje bez Reacta i bazy (testy w sesja.test.ts); ekran: app/(stanowisko)/stanowisko/stanowisko.tsx.

export interface PozycjaSesji {
  id: string
  numer: string
  tryb: 'CIEN' | 'PRACA'
  /** Karta zeskanowana do sesji (sprawdzana ponownie przy otwarciu). */
  printId: string | null
  stan: 'czeka' | 'spakowane' | 'nie_spakowano' | 'blokada'
  komunikat: string | null
  czerwona: boolean
  /** Przy zapisie zostało „na półce nie było”. */
  zBrakiem?: boolean
  /**
   * Otwarte pojedynczym skanem na samodzielnym stanowisku, nie zaplanowane w sesji: po zapisie „Zapisane” z odliczaniem
   * i powrót do skanu, a porzucone (✕) nie otwiera się samo. Skan w trakcie pakowania i zamówienia z kolejki tego nie mają.
   */
  pojedynczy?: boolean
}

/**
 * Następne zamówienie do otwarcia: pierwsze „czeka” za bieżącym, potem od początku listy. Spakowane, „nie spakowano”,
 * zablokowane („NIE PAKUJ”, karta nieaktualna) i pojedyncze skany pomija. `odId = null` = od początku listy.
 */
export function nastepneWSesji(sesja: PozycjaSesji[], odId: string | null): PozycjaSesji | null {
  const i = odId === null ? -1 : sesja.findIndex((s) => s.id === odId)
  const poKolei = [...sesja.slice(i + 1), ...sesja.slice(0, i + 1)]
  return poKolei.find((s) => s.stan === 'czeka' && !s.pojedynczy && s.id !== odId) ?? null
}

/**
 * Co po zapisie zamówienia `id` (lista już ze zapisanym stanem): jest następne = przejście; koniec zaplanowanej sesji =
 * podsumowanie; pojedynczy skan = „Zapisane” z odliczaniem, także gdy wcześniej tego dnia była sesja.
 */
export function poZapisie(sesja: PozycjaSesji[], id: string): 'nastepne' | 'podsumowanie' | 'zapisane' {
  if (nastepneWSesji(sesja, id)) return 'nastepne'
  return sesja.find((s) => s.id === id)?.pojedynczy ? 'zapisane' : 'podsumowanie'
}

/**
 * Skan karty albo koszyka innego zamówienia przy otwartym oknie przełącza na nie. Zeskanowane staje na
 * liście tuż przed odłożonym, więc po jego zapisie `nastepneWSesji` wraca do odłożonego, a potem dalej po serii.
 * `pojedynczy` dziedziczy po odłożonym: pojedynczy skan na samodzielnym stanowisku zostaje pojedynczy (po zapisie
 * „Zapisane” i powrót do skanu), zamówienie dołożone do serii z kolejki wraca do serii.
 */
export function poPrzelaczeniu(sesja: PozycjaSesji[], odlozoneId: string, nowa: PozycjaSesji): PozycjaSesji[] {
  const odlozone = sesja.find((s) => s.id === odlozoneId)
  const bylo = sesja.find((s) => s.id === nowa.id)
  const { pojedynczy: _p, ...reszta } = { ...bylo, ...nowa }
  const wpis: PozycjaSesji = { ...reszta, stan: 'czeka', komunikat: null, czerwona: false, ...(odlozone?.pojedynczy ? { pojedynczy: true } : {}) }
  const bez = sesja.filter((s) => s.id !== nowa.id)
  const i = bez.findIndex((s) => s.id === odlozoneId)
  return i < 0 ? [...bez, wpis] : [...bez.slice(0, i), wpis, ...bez.slice(i)]
}

/**
 * Komunikat po przełączeniu. Odhaczenia są tylko na ekranie i giną jak przy zamknięciu okna ✕, więc
 * komunikat mówi to wprost; braki „Na półce nie było” są zapisane na serwerze i zostają. `odlozone = null` albo już
 * zapisane (ekran „Zapisane”) = zwykłe otwarcie.
 */
export function komunikatPrzelaczenia(nowy: string, odlozone: { numer: string; zapisane: boolean; odhaczone: boolean; braki: boolean } | null): string {
  if (!odlozone || odlozone.zapisane) return `${nowy}: otwarte do pakowania.`
  const stary = odlozone.numer
  return [
    `Przełączono na ${nowy}; ${stary} zostaje niespakowane.`,
    odlozone.odhaczone ? `Odhaczenia z ${stary} wyzerowane, po ponownym skanie zbierasz je od nowa.` : null,
    odlozone.braki ? `Zapisane braki „Na półce nie było” zostają.` : null,
  ]
    .filter(Boolean)
    .join(' ')
}

export interface PodsumowanieSesji {
  spakowane: number
  zBrakiem: number
  pominiete: number
}

/**
 * Podsumowanie po ostatnim zamówieniu; każde zamówienie liczone raz. „Z brakiem” = zapisane z „na półce nie było”
 * (spakowane albo nie). Czerwone „NIE PAKUJ” nie były pakowane, więc są pominięte. Licznik w nagłówku okna to
 * spakowane + z brakiem.
 */
export function podsumowanieSesji(sesja: PozycjaSesji[]): PodsumowanieSesji {
  const wynik: PodsumowanieSesji = { spakowane: 0, zBrakiem: 0, pominiete: 0 }
  for (const s of sesja) {
    if (s.zBrakiem) wynik.zBrakiem++
    else if (s.stan === 'spakowane') wynik.spakowane++
    else wynik.pominiete++
  }
  return wynik
}

export interface OknoPozycji {
  pozycje: { klucz: string; ilosc: number }[]
  /** Braki zgłoszone w tym oknie: ekran odejmuje je od `ilosc`. */
  braki: Record<string, { ilosc: number } | undefined>
  zebrane: Record<string, number>
}

/**
 * Okno po zgłoszeniu braku na koncie w PRACY: serwer oddaje, ile zostało do zebrania. Ekran liczy „ilość
 * minus braki okna”, więc `ilosc` = to, co zostało + zgłoszone. Składnik wyjęty z paczki razem z zestawem znika z okna, a
 * zebrane nie przekraczają tego, co zostało (nadmiar składników wraca na półkę, nie do paczki).
 */
export function poBrakuWPracy<T extends OknoPozycji['pozycje'][number]>(
  okno: { pozycje: T[]; braki: OknoPozycji['braki']; zebrane: OknoPozycji['zebrane'] },
  doZebrania: { klucz: string; ilosc: number }[],
): { pozycje: T[]; zebrane: Record<string, number> } {
  const zostalo = new Map(doZebrania.map((p) => [p.klucz, p.ilosc]))
  const pozycje = okno.pozycje
    .map((p) => ({ ...p, ilosc: (zostalo.get(p.klucz) ?? 0) + (okno.braki[p.klucz]?.ilosc ?? 0) }))
    .filter((p) => p.ilosc > 0)
  const zebrane: Record<string, number> = {}
  for (const p of pozycje) zebrane[p.klucz] = Math.min(okno.zebrane[p.klucz] ?? 0, zostalo.get(p.klucz) ?? 0)
  return { pozycje, zebrane }
}

/**
 * Okno po „Jednak jest” na koncie w PRACY: serwer oddaje pełne pozycje zamówienia po cofnięciu braku (zestaw
 * wraca cały, więc wracają też składniki, które wcześniej zniknęły z okna). `ilosc` = pozycja z serwera + braki tego okna,
 * które zostały; pozycja, której nie ma na serwerze, a ma brak okna, zostaje z samym brakiem (dane z dotychczasowego okna).
 * Zebrane nie przekraczają tego, co jest do zebrania.
 */
export function poCofnieciuWPracy<T extends OknoPozycji['pozycje'][number]>(
  okno: { pozycje: T[]; braki: OknoPozycji['braki']; zebrane: OknoPozycji['zebrane'] },
  serwer: T[],
): { pozycje: T[]; zebrane: Record<string, number> } {
  const naSerwerze = new Set(serwer.map((p) => p.klucz))
  const pozycje = [
    ...serwer.map((p) => ({ ...p, ilosc: p.ilosc + (okno.braki[p.klucz]?.ilosc ?? 0) })),
    ...okno.pozycje.filter((p) => !naSerwerze.has(p.klucz) && (okno.braki[p.klucz]?.ilosc ?? 0) > 0).map((p) => ({ ...p, ilosc: okno.braki[p.klucz]!.ilosc })),
  ]
  const zebrane: Record<string, number> = {}
  for (const p of pozycje) zebrane[p.klucz] = Math.min(okno.zebrane[p.klucz] ?? 0, p.ilosc - (okno.braki[p.klucz]?.ilosc ?? 0))
  return { pozycje, zebrane }
}
