// widok zamówień kuriera pod paskiem przewoźnika w kolejce pakowania. Funkcje czyste, bez bazy i sieci,
// bezpieczne dla komponentu klienta (okno „Zamów kuriera”):
//   - jedna linia na dzień odbioru (dziś, potem przyszłe; minione dni zostają tylko w bazie), stan najnowszej próby, starsze
//     próby tego dnia zwinięte; udane zamówienie tego dnia wygrywa z późniejszą odmową (odmowa drugiego podjazdu nie
//     odwołuje pierwszego);
//   - odmowa przewoźnika po ludzku: znane kody DPD → zdanie dla magazynu, techniczny powód w „szczegóły”;
//   - podpowiedzi przedziałów z dostępności przewoźnika (pola godzin zostają zawsze) i domyślny termin okna.

import { wybierzPrzedzial, type RegulaPrzedzialu } from './kurier-regula'

/** Zlecenie odbioru w kształcie dla ekranu (bez danych klientów). */
export interface ZlecenieKuriera {
  id: string
  stan: string
  dzien: string
  odMin: number
  doMin: number
  numer: string | null
  powod: string | null
  proba: number
  paczki: number
  wagaKg: number
  kto: string
  /** Stan ustawiony ręcznie („DPD przyjął” / „DPD nie przyjął”) po sprawdzeniu u przewoźnika. */
  recznie: boolean
  /** Zamówienie złożone przez automat „Zamawiaj kuriera automatycznie”. */
  automat?: boolean
  /** Moduły z osobnymi odbiorami (Wysyłam z Allegro): klucz grupy odbioru; brak = jedno zlecenie na dzień (DPD). */
  grupa?: string
  /** Chwila listy przesyłek kliknięcia, które złożyło zlecenie (ms); wspólna dla grup jednego kliknięcia. */
  klik?: number
}

export const przesylekSlowo = (n: number) => (n === 1 ? 'przesyłka' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'przesyłki' : 'przesyłek')

export const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

/** „dziś 23.11”, „jutro 24.11”, „30.11” (dzień RRRR-MM-DD, Warszawa). */
export function dzienPoLudzku(dzien: string, dzis?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dzien)
  if (!m) return dzien
  const krotko = `${m[3]}.${m[2]}`
  if (!dzis) return krotko
  if (dzien === dzis) return `dziś ${krotko}`
  const jutro = new Date(Date.parse(`${dzis}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
  return dzien === jutro ? `jutro ${krotko}` : krotko
}

export interface LiniaKuriera {
  dzien: string
  /** Grupa odbioru (osobne odbiory); brak = linia dnia. */
  grupa?: string
  /** Próba pokazywana w linii. */
  glowna: ZlecenieKuriera
  /** Pozostałe próby tego dnia (zwinięte), najnowsze pierwsze. */
  pozostale: ZlecenieKuriera[]
  /** Wszystkie zwinięte próby są starsze od pokazanej („wcześniejsze próby”); inaczej „inne próby tego dnia”. */
  wczesniejsze: boolean
}

/**
 * Linie paska kuriera: jedna na dzień od `dzis` (minione dni pominięte), rosnąco po dniu. W linii najnowsza próba
 * (najwyższy numer próby); gdy najnowsza to odmowa, a tego dnia jest udane zamówienie, linia pokazuje zamówienie.
 * Osobne odbiory (`grupa`): linia na parę dzień + grupa, próby zwinięte tylko w obrębie grupy; zlecenie w toku albo
 * niewiadoma grupy zawsze w linii (z rozstrzyganiem), a odmowa grupy zostaje osobną linią, dopóki późniejsze kliknięcie
 * nie złoży przyjętego odbioru (wtedy jest zwinięta pod nim jako inna próba tego dnia).
 */
export function liniePaskaKuriera(zlecenia: readonly ZlecenieKuriera[], dzis: string): LiniaKuriera[] {
  const dni = new Map<string, ZlecenieKuriera[]>()
  for (const z of zlecenia) {
    if (z.dzien < dzis) continue
    const k = z.grupa === undefined ? z.dzien : `${z.dzien}\u0000${z.grupa}`
    const l = dni.get(k) ?? []
    l.push(z)
    dni.set(k, l)
  }
  const linie: LiniaKuriera[] = [...dni.values()].flatMap((l) => {
    const proby = [...l].sort((a, b) => b.proba - a.proba)
    const najnowsza = proby[0]!
    const zamowiony = proby.find((z) => z.stan === 'ZAMOWIONY')
    const grupa = najnowsza.grupa !== undefined ? { grupa: najnowsza.grupa } : {}
    // odmowa grupy (osobne odbiory) nowsza niż przyjęty odbiór tej grupy to inne przesyłki (kolejne kliknięcie):
    // osobna linia, żeby nie schowała się pod przyjętym odbiorem; DPD (bez grupy) jak dotąd
    if (najnowsza.grupa !== undefined && najnowsza.stan === 'BLAD' && !najnowsza.recznie && zamowiony && !proby.some((z) => z.stan === 'NIEJEDNOZNACZNY' || z.stan === 'TWORZENIE')) {
      const reszta = proby.filter((z) => z !== najnowsza && z !== zamowiony)
      return [
        { dzien: najnowsza.dzien, ...grupa, glowna: zamowiony, pozostale: reszta, wczesniejsze: reszta.every((z) => z.proba < zamowiony.proba) },
        { dzien: najnowsza.dzien, ...grupa, glowna: najnowsza, pozostale: [], wczesniejsze: true },
      ]
    }
    const otwarta = najnowsza.grupa !== undefined ? proby.find((z) => z.stan === 'NIEJEDNOZNACZNY' || z.stan === 'TWORZENIE') : undefined
    const glowna = otwarta ?? (najnowsza.stan === 'BLAD' && zamowiony ? zamowiony : najnowsza)
    const pozostale = proby.filter((z) => z !== glowna)
    return [{ dzien: najnowsza.dzien, ...grupa, glowna, pozostale, wczesniejsze: pozostale.every((z) => z.proba < glowna.proba) }]
  })
  // odmowa grupy, po której późniejsze kliknięcie złożyło przyjęty odbiór (podział zależy od listy, więc pod innym kluczem)
  const zwiniete = new Set<LiniaKuriera>()
  for (const l of linie) {
    if (l.grupa === undefined || l.glowna.stan !== 'BLAD' || l.glowna.recznie) continue
    const pod = linie.find((m) => m !== l && !zwiniete.has(m) && m.dzien === l.dzien && m.grupa !== undefined && m.glowna.stan === 'ZAMOWIONY' && (m.glowna.klik ?? 0) > (l.glowna.klik ?? 0))
    if (!pod) continue
    pod.pozostale.push(l.glowna, ...l.pozostale)
    pod.wczesniejsze = false
    zwiniete.add(l)
  }
  const klucz = (l: LiniaKuriera) => `${l.dzien}\u0000${l.grupa ?? ''}`
  return linie.filter((l) => !zwiniete.has(l)).sort((a, b) => (klucz(a) < klucz(b) ? -1 : klucz(a) > klucz(b) ? 1 : 0))
}

export interface PowodPoLudzku {
  tekst: string
  /** Techniczny powód przewoźnika do rozwinięcia „szczegóły”; null = bez szczegółów (tekst jest powodem). */
  szczegoly: string | null
  /** Powód rozpoznany: tekst ma własną instrukcję, ogólna rada („Ponów”, „spróbuj ponownie”) jest zbędna. */
  znany: boolean
  /** Kompletor nie wysłał zamówienia do przewoźnika (nie „przewoźnik nie przyjął”). */
  niewyslane: boolean
}

/** Stała część POWOD_NIE_WYSLANO (lib/wysylka/zamowienie-kuriera.ts): Kompletor nie wysłał komendy, przewoźnik nic nie dostał. */
const NIE_WYSLANO_RE = /^Kompletor nie wysłał tego zamówienia odbioru/
const NIE_WYSLANO_DALEJ = '(poprzednie odbiory długo czekały na odpowiedź), nic nie zamówiono. Zamów ten odbiór ponownie przyciskiem przy pasku.'

/**
 * Kod albo opis przewoźnika → zdanie dla magazynu. Kolejność: od najbardziej szczegółowego. `podjazd` = zdanie dopisywane
 * tylko wtedy, gdy tego dnia jest przyjęty odbiór (inaczej nie ma podjazdu, przy którym można by zapytać kuriera).
 */
const ZNANE: readonly { re: RegExp; tekst: string; podjazd?: string }[] = [
  { re: /no available time slots|RANGE_NOT_FOUND/i, tekst: 'DPD nie ma już wolnych przedziałów podjazdu na ten dzień dla Twojego adresu. Wybierz inny dzień albo zadzwoń do DPD.' },
  { re: /INCORRECT_PICKUP_TIME|time frame not allowed/i, tekst: 'DPD nie przyjmuje podjazdu w tych godzinach. Wybierz przedział z listy DPD albo inny dzień.' },
  { re: /DISALLOWED_FID/, tekst: 'DPD nie pozwala zamawiać kuriera na ten numer klienta (FID). Sprawdź numer płatnika w koncie DPD (Ustawienia → Wysyłka i druk → Przewoźnicy) albo zapytaj opiekuna w DPD.' },
  // Wysyłam z Allegro: kody z odpowiedzi Allegro na zamówienie odbioru; przyczyna OPENNET_ERROR nieznana
  {
    re: /OPENNET_ERROR/,
    tekst: 'Przewoźnik odrzucił ten odbiór bez podania powodu. Zamów odbiór tej paczki w Allegro (Wysyłam z Allegro → Zamów kuriera).',
    podjazd: 'Możesz też zapytać kuriera przy zamówionym dziś podjeździe, czy ją zabierze.',
  },
  { re: /REQUIRES_SEPARATE_PICKUPS/, tekst: 'Allegro chce osobnych odbiorów dla tych przesyłek, a Kompletor nie umiał ich podzielić. Zamów odbiór w Allegro (Wysyłam z Allegro → Zamów kuriera) i zgłoś to administratorowi.' },
  { re: /DISABLED_API/, tekst: 'DPD ma wyłączone zamawianie kuriera przez Kompletor dla tego konta. Zamów kuriera w panelu DPD albo telefonicznie i poproś opiekuna w DPD o włączenie.' },
]

/**
 * Powód odmowy po ludzku; nieznany kod = dotychczasowy tekst techniczny. `podjazd`: tego dnia jest przyjęty odbiór
 * (zdanie o pytaniu kuriera przy podjeździe ma sens).
 */
export function powodPoLudzku(powod: string | null | undefined, o: { podjazd?: boolean } = {}): PowodPoLudzku | null {
  const p = (powod ?? '').trim()
  if (!p) return null
  if (NIE_WYSLANO_RE.test(p)) return { tekst: `Kompletor nie wysłał tego zamówienia do przewoźnika ${NIE_WYSLANO_DALEJ}`, szczegoly: null, znany: true, niewyslane: true }
  const z = ZNANE.find((x) => x.re.test(p))
  return z ? { tekst: z.podjazd && o.podjazd ? `${z.tekst} ${z.podjazd}` : z.tekst, szczegoly: p, znany: true, niewyslane: false } : { tekst: p, szczegoly: null, znany: false, niewyslane: false }
}

/** Ręczne rozstrzygnięcie zapisane w powodzie (stała część tekstu z lib/wysylka/zamowienie-kuriera.ts). */
export const ROZSTRZYGNIETE_RECZNIE = 'Rozstrzygnięte ręcznie'

/** Nazwy przewoźników transportu Allegro (`ShipmentDto.transport`) dla ekranu; brak w słowniku = identyfikator. */
const NAZWY_TRANSPORTU: Readonly<Record<string, string>> = {
  ALLEGRO: 'One Kurier',
  ALLEGRO_ONE: 'One Kurier',
  ALLEGRO_COURIER: 'One Kurier',
  ALLEGRO_ONE_KURIER: 'One Kurier',
  ORLEN: 'Orlen Paczka',
  WEDO: 'WE|DO',
  INPOST: 'InPost',
  DPD: 'DPD',
  DHL: 'DHL',
  UPS: 'UPS',
  GLS: 'GLS',
  FEDEX: 'FedEx',
  POCZTEX: 'Pocztex',
  POCZTA_POLSKA: 'Pocztex',
}

/**
 * Nazwa przewoźnika odbioru z klucza grupy (`lib/adaptery/kontrakt.ts` GrupaOdbioru: przewoźnicy transportu `+`, potem
 * `.pN`), np. „Orlen Paczka”, „One Kurier + WE|DO”; null = bez grupy albo przewoźnik nieznany (`x`).
 */
export function nazwaGrupyOdbioru(grupa: string | undefined): string | null {
  const transport = (grupa ?? '').split('.')[0] ?? ''
  if (!transport || transport === 'x') return null
  return [...new Set(transport.split('+').map((id) => NAZWY_TRANSPORTU[id] ?? id))].join(' + ')
}

/** Etykieta przewoźnika dla linii i komunikatu: „Allegro (Orlen Paczka)”; bez nazwy grupy sama etykieta paska. */
export const etykietaOdbioru = (etykieta: string, grupa: string | undefined) => {
  const n = nazwaGrupyOdbioru(grupa)
  return n ? `${etykieta} (${n})` : etykieta
}

/**
 * przyjęte odbiory tego samego dnia, przewoźnika i numeru zlecenia (przewoźnik dopiął kilka komend do jednego
 * podjazdu) jako jedna linia z sumą przesyłek; pozostałe linie bez zmian.
 */
export function scalOdbioryPaska(linie: readonly LiniaKuriera[]): LiniaKuriera[] {
  const out: LiniaKuriera[] = []
  const wg = new Map<string, LiniaKuriera>()
  for (const l of linie) {
    const z = l.glowna
    const nazwa = nazwaGrupyOdbioru(l.grupa)
    if (l.grupa === undefined || z.stan !== 'ZAMOWIONY' || !z.numer || !nazwa) {
      out.push(l)
      continue
    }
    const k = `${l.dzien}|${nazwa}|${z.numer}|${z.odMin}|${z.doMin}`
    const jest = wg.get(k)
    if (!jest) {
      const nowa = { ...l, glowna: { ...z }, pozostale: [...l.pozostale] }
      wg.set(k, nowa)
      out.push(nowa)
      continue
    }
    jest.glowna = { ...jest.glowna, paczki: jest.glowna.paczki + z.paczki, wagaKg: jest.glowna.wagaKg + z.wagaKg }
    jest.pozostale.push(...l.pozostale)
  }
  return out
}

/**
 * odbiory dnia, których przewoźnik nie przyjął (pewna odmowa, nie ręczna), a obok nich są przyjęte: okno
 * proponuje wtedy ponowienie samej nieudanej części zamiast „Zamów drugi raz”. Pusta lista = brak takiej sytuacji.
 */
export function nieudaneOdbioryDnia(linie: readonly LiniaKuriera[], dzien: string): ZlecenieKuriera[] {
  const dnia = linie.filter((l) => l.dzien === dzien && l.grupa !== undefined)
  if (!dnia.some((l) => l.glowna.stan === 'ZAMOWIONY')) return []
  if (dnia.some((l) => l.glowna.stan === 'TWORZENIE' || l.glowna.stan === 'NIEJEDNOZNACZNY')) return []
  return dnia.filter((l) => l.glowna.stan === 'BLAD' && !l.glowna.recznie).map((l) => l.glowna)
}

/** Opis zlecenia do paska kuriera, np. „DPD zamówiony na dziś 23.11 13:00–15:00, zlecenie nr 123”. */
export function opisZlecenia(z: ZlecenieKuriera, etykieta: string, dzis?: string, o: { podjazd?: boolean } = {}): string {
  const okno = `${dzienPoLudzku(z.dzien, dzis)} ${hm(z.odMin)}–${hm(z.doMin)}`
  // osobne odbiory: ile przesyłek obejmuje ten odbiór (inne grupy dnia mają własne linie)
  const ile = z.grupa !== undefined && z.paczki > 0 ? `, ${z.paczki} ${przesylekSlowo(z.paczki)}` : ''
  if (z.stan === 'ZAMOWIONY') return `${etykieta} zamówiony${z.automat ? ' automatycznie' : ''} na ${okno}${ile}${z.numer ? `, zlecenie nr ${z.numer}` : ''}${z.recznie ? ' (potwierdzone ręcznie)' : ''}`
  if (z.stan === 'TWORZENIE') return `${etykieta}: zamówienie na ${okno} w toku`
  if (z.stan === 'NIEJEDNOZNACZNY') {
    // stare wpisy sprzed poprawki klasyfikacji (2529bcbc): odpowiedź z kodem pewnej odmowy, zapisana jako niewiadoma
    const znany = powodPoLudzku(z.powod)
    const podpowiedz = znany?.szczegoly ? ` Odpowiedź ${etykieta} wygląda na odmowę: ${znany.tekst}` : ''
    return `${etykieta}: nie wiadomo, czy zamówienie na ${okno} dotarło do przewoźnika. Sprawdź w panelu ${etykieta} albo telefonicznie i zaznacz wynik, nie zamawiaj drugi raz w ciemno.${podpowiedz}`
  }
  if (z.recznie) return `${etykieta}: przewoźnik nie przyjął zamówienia na ${okno} (rozstrzygnięte ręcznie)`
  const p = powodPoLudzku(z.powod, o)
  if (p?.niewyslane) return `${etykieta}: zamówienie na ${okno} nie zostało wysłane do przewoźnika ${NIE_WYSLANO_DALEJ}`
  return `${etykieta}: przewoźnik nie przyjął zamówienia na ${okno}${p ? `. ${p.tekst}` : ''}`
}


// ─── Przedziały podjazdu z dostępności przewoźnika ──────────────────────────

export interface PrzedzialOdbioru {
  odMin: number
  doMin: number
}

/** Przedział z dostępności przewoźnika; `offsetMin` = liczba minut od przewoźnika (DPD `offset`), znaczenie niepotwierdzone. */
export interface PrzedzialPodpowiedzi extends PrzedzialOdbioru {
  offsetMin?: number | null
}

/**
 * Dostępność dla okna „Zamów kuriera”. LISTA: `przedzialy` bez dat (każdy dzień odbioru) i `dni` z datami, gdy
 * przewoźnik je podaje (lista dnia wygrywa); pusta = przewoźnik nie podał przedziałów. POLA: bez podpowiedzi.
 * Okno ZAWSZE ma dwa pola godzin; przedziały to tylko podpowiedź, która wypełnia pola i nigdy nie blokuje zamówienia.
 */
export type DostepnoscOkna = { tryb: 'LISTA'; przedzialy: PrzedzialPodpowiedzi[]; dni: Record<string, PrzedzialPodpowiedzi[]> } | { tryb: 'POLA'; uwaga: string | null }

export const UWAGA_BEZ_DNIA = 'Przewoźnik nie podał wolnych przedziałów na ten dzień: wpisz godziny, przewoźnik przyjmie albo odrzuci je przy zamówieniu.'
export const UWAGA_BEZ_LISTY = 'Nie udało się pobrać wolnych przedziałów od przewoźnika: wpisz godziny ręcznie.'

export interface Podpowiedz extends PrzedzialOdbioru {
  /** Miękki dopisek przy przedziale (np. „zwykle do 14:00”), null = bez dopisku. */
  dopisek: string | null
}

/**
 * Podpowiedzi przedziałów na wybrany dzień i uwaga pod polami. Dopisek tylko na dziś, z `offsetMin` jako „zamawiaj do
 * = koniec przedziału minus offset”: to HIPOTEZA (DPD nie opisuje pola), więc tylko miękka podpowiedź; rozstrzyga
 * odpowiedź przewoźnika na zamówienie.
 */
export function podpowiedziNaDzien(d: DostepnoscOkna | null, dzien: string, dzis: string, terazMin: number): { podpowiedzi: Podpowiedz[]; uwaga: string | null } {
  if (!d) return { podpowiedzi: [], uwaga: null }
  if (d.tryb === 'POLA') return { podpowiedzi: [], uwaga: d.uwaga }
  const lista = (/^\d{4}-\d{2}-\d{2}$/.test(dzien) ? d.dni[dzien] : undefined) ?? d.przedzialy
  if (!lista.length) return { podpowiedzi: [], uwaga: UWAGA_BEZ_DNIA }
  return {
    podpowiedzi: lista.map((p) => {
      const doGodz = dzien === dzis && typeof p.offsetMin === 'number' ? p.doMin - p.offsetMin : null
      const dopisek = doGodz === null || doGodz < 0 ? null : doGodz > terazMin ? `zwykle do ${hm(doGodz)}` : 'na dziś zwykle już za późno'
      return { odMin: p.odMin, doMin: p.doMin, dopisek }
    }),
    uwaga: null,
  }
}

export const kluczPrzedzialu = (p: PrzedzialOdbioru) => `${hm(p.odMin)}-${hm(p.doMin)}`

/** Najpóźniejszy początek popołudniowego okna na dziś i jego koniec (podjazd trwa co najmniej 3 godziny). */
const DZIS_OD_MAX_MIN = 14 * 60
const DZIS_DO_MIN = 17 * 60

export type Termin = { data: string; odMin: number | null; doMin: number | null }

/**
 * Domyślny termin w oknie „Zamów kuriera”: dziś, dopóki da się jeszcze zamówić podjazd na dziś. `dzisMozliwy` = dziś
 * jest dniem roboczym, dniem odbioru z harmonogramu i nikt nie kliknął „Przyjechał” na dziś (`dzisDzienOdbioru`);
 * inaczej okno nigdy nie podpowiada dziś (kliknięcie domyślnego terminu dałoby drugi podjazd albo podjazd w dzień bez
 * odbiorów), tylko dzień z harmonogramu.
 *   - przewoźnik z regułą przedziałów (`regula.znane`, np. DPD): godziny z tej samej reguły co automat
 *     (lib/wysylka/kurier-regula.ts): w dzień roboczy dziś, gdy reguła ma jeszcze przedział na dziś; inaczej dzień
 *     z harmonogramu z przedziałem reguły dla tego dnia;
 *   - bez reguły: propozycja z harmonogramu na dziś zostaje; gdy godzina z harmonogramu minęła (propozycja wskazuje
 *     kolejny dzień), a jest dzień roboczy, dziś od najbliższej pełnej godziny (z godzinnym zapasem) do 17:00; później
 *     niż 14:00 na początek okna = propozycja z harmonogramu.
 */
export function domyslnyTerminKuriera(propozycja: { data: string; odMin: number; doMin: number } | null, dzis: string, terazMin: number, dzisMozliwy: boolean, regula?: RegulaPrzedzialu): Termin {
  const dzienRoboczy = dzisMozliwy
  if (!dzisMozliwy && propozycja && propozycja.data === dzis) propozycja = null
  if (!dzisMozliwy && !propozycja) return { data: dzis, odMin: null, doMin: null }
  if (regula && regula.znane.length) {
    const godz = propozycja?.odMin ?? null
    if (dzienRoboczy && (!propozycja || propozycja.data >= dzis)) {
      const p = wybierzPrzedzial({ kandydaci: null, regula, dzisiaj: true, terazMin, godzinaOdbioruMin: godz })
      if (p) return { data: dzis, odMin: p.odMin, doMin: p.doMin }
    }
    if (!propozycja) return { data: dzis, odMin: null, doMin: null }
    const p = wybierzPrzedzial({ kandydaci: null, regula, dzisiaj: propozycja.data === dzis, terazMin, godzinaOdbioruMin: godz })
    return p ? { data: propozycja.data, odMin: p.odMin, doMin: p.doMin } : propozycja
  }
  if (propozycja && propozycja.data <= dzis) return propozycja
  const od = Math.ceil((terazMin + 60) / 60) * 60
  if (dzienRoboczy && od <= DZIS_OD_MAX_MIN) return { data: dzis, odMin: od, doMin: DZIS_DO_MIN }
  return propozycja ?? { data: dzis, odMin: null, doMin: null }
}

/**
 * Godziny do wpisania w okno „Zamów kuriera”, gdy odczyt przedziałów przewoźnika wraca (po 2–8 s od otwarcia okna).
 * Decyzja bierze stan okna z CHWILI POWROTU odczytu, nie z chwili jego startu: godzin wpisanych albo wybranych przez
 * osobę odczyt nigdy nie nadpisuje, a domyślne godziny liczy dla dnia, który jest w oknie teraz (osoba mogła go zmienić).
 * Odczyt z wcześniejszego otwarcia okna (`aktualny = false`) jest pomijany. null = pola zostają bez zmian.
 */
export function godzinyPoOdczycie<P>(d: DostepnoscOkna, okno: { reczne: boolean; data: string; aktualny: boolean }, domyslne: (d: DostepnoscOkna, dzien: string) => P | null): P | null {
  if (!okno.aktualny || okno.reczne || d.tryb !== 'LISTA') return null
  return domyslne(d, okno.data)
}

/** Stany zlecenia, które znaczą „podjazd na ten dzień jest zamówiony albo może być” (drugie zamówienie = drugi podjazd). */
export const AKTYWNE_ZLECENIA_KURIERA: readonly string[] = ['TWORZENIE', 'ZAMOWIONY', 'NIEJEDNOZNACZNY']

/**
 * Domyślny termin okna „Zamów kuriera” po uwzględnieniu zleceń: gdy na dzień z harmonogramu (`dzienHarmonogramu`,
 * np. jutro po godzinie „wyślemy dziś do”) jest już aktywne zlecenie (ręczne albo automatu), a na podpowiadany dzień
 * nie ma, okno podpowiada dzień z harmonogramu z godzinami tego zlecenia. Wtedy działa potwierdzenie „Zamówić drugi
 * raz?”, zamiast cichego zamówienia na dziś, po którym kurier dziś zabierze paczki, a zamówiony podjazd zostanie.
 */
export function terminWzgledemZlecen(t: Termin, dzienHarmonogramu: string | null, zlecenia: readonly Pick<ZlecenieKuriera, 'dzien' | 'stan' | 'odMin' | 'doMin'>[]): Termin {
  const aktywne = (d: string) => zlecenia.find((z) => z.dzien === d && AKTYWNE_ZLECENIA_KURIERA.includes(z.stan))
  if (!dzienHarmonogramu || dzienHarmonogramu === t.data || aktywne(t.data)) return t
  const z = aktywne(dzienHarmonogramu)
  return z ? { data: dzienHarmonogramu, odMin: z.odMin, doMin: z.doMin } : t
}

/** Nieudany odbiór dnia do ponowienia: ile przesyłek i nazwy przewoźników. */
export interface NieudanyOdbior {
  przesylek: number
  nazwy: string
}

/**
 * Tryb okna „Zamów kuriera” dla dnia wybranego w oknie, liczony od nowa przy każdej zmianie dnia:
 *   - PONOW: tego dnia część odbiorów przyjęta, część odrzucona (`nieudaneOdbioryDnia`), a osoba nie wybrała „Zamów
 *     drugi raz”; okno wysyła bez `drugi`, host zamawia tylko przesyłki z listy przyjętego kliknięcia (odrzucone);
 *   - DRUGI: tego dnia jest zlecenie aktywne albo ręczne „nie przyjął” (`zamowiony` = zlecenie do ostrzeżenia), albo
 *     osoba wybrała „Zamów drugi raz” obok nieudanego odbioru (`nieudany`: obejmie go razem z przesyłkami nadanymi
 *     później); okno wysyła `drugi=tak`;
 *   - ZWYKLE: tego dnia nic nie ma; okno wysyła bez `drugi`.
 * Żadna ścieżka nie wysyła `drugi=tak` bez trybu DRUGI, czyli bez ostrzeżenia o drugim podjeździe.
 */
export type TrybOknaKuriera = { tryb: 'ZWYKLE' } | ({ tryb: 'PONOW' } & NieudanyOdbior) | { tryb: 'DRUGI'; zamowiony: ZlecenieKuriera; nieudany: NieudanyOdbior | null }

export function trybOknaKuriera(zlecenia: readonly ZlecenieKuriera[], dzis: string, dzien: string, chceDrugi = false): TrybOknaKuriera {
  const linie = scalOdbioryPaska(liniePaskaKuriera(zlecenia, dzis))
  const nieudane = nieudaneOdbioryDnia(linie, dzien)
  const tegoDnia = zlecenia.filter((z) => z.dzien === dzien)
  if (nieudane.length) {
    // jedna linia na grupę; odmowę spod starego klucza grupy host przejmuje przy ponowieniu, więc przesyłka liczy się raz
    const nieudany = { przesylek: nieudane.reduce((s, z) => s + z.paczki, 0), nazwy: [...new Set(nieudane.map((z) => nazwaGrupyOdbioru(z.grupa) ?? 'przewoźnik bez nazwy'))].join(', ') }
    if (!chceDrugi) return { tryb: 'PONOW', ...nieudany }
    const zamowiony = linie.find((l) => l.dzien === dzien && l.glowna.stan === 'ZAMOWIONY')?.glowna ?? tegoDnia.find((z) => z.stan === 'ZAMOWIONY')!
    return { tryb: 'DRUGI', zamowiony, nieudany }
  }
  const zamowiony = tegoDnia.find((z) => AKTYWNE_ZLECENIA_KURIERA.includes(z.stan)) ?? tegoDnia.find((z) => z.stan === 'BLAD' && z.recznie)
  return zamowiony ? { tryb: 'DRUGI', zamowiony, nieudany: null } : { tryb: 'ZWYKLE' }
}
