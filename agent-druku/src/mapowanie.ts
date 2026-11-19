// Role drukarek ↔ drukarki Windows: nazwa z konfiguracji, stan Windows → stan dla serwera, rola zapasowa.
import type { RolaDrukarki, StanDrukarki, StanJednejDrukarki } from './kontrakt.js'
import { jestTermiczna, porownajRole } from './kontrakt.js'

/** Rola → nazwa drukarki Windows. Klucze sprawdza konfiguracja (WZOR_ROLI); dowolnie wiele ról. */
export type MapaRol = Partial<Record<RolaDrukarki, string>>

/** Role z konfiguracji z niepustą nazwą drukarki, w stałej kolejności (A4…, potem termiczne po numerze). */
export function roleZKonfiguracji(mapa: MapaRol): RolaDrukarki[] {
  return Object.keys(mapa)
    .filter((r) => nazwaDrukarki(mapa, r))
    .sort(porownajRole)
}

/** Stan drukarki odczytany z Windows (Get-Printer) — surowy, przed mapowaniem. */
export interface StanWindows {
  nazwa: string
  /** PrinterStatus: nazwa (np. „Normal”) albo liczba z MSFT_Printer, zależnie od wersji PowerShella. */
  status: string
  /** Ustawienie „Użyj drukarki w trybie offline” albo odłączona drukarka USB. */
  offline: boolean
  zleceniaWKolejce: number
}

export function nazwaDrukarki(mapa: MapaRol, rola: RolaDrukarki): string | undefined {
  const nazwa = mapa[rola]?.trim()
  return nazwa ? nazwa : undefined
}

// MSFT_Printer.PrinterStatus — wartości liczbowe na wypadek, gdy PowerShell nie zamieni ich na nazwy. Nazwy z tej
// tabeli różnią się od wyliczenia Get-Printer (UserIntervention / UserInterventionRequired, Initialization /
// Initializing) — oba warianty są niżej w zbiorach stanów.
const STATUS_Z_LICZBY: Record<string, string> = {
  '0': 'Normal', '1': 'Paused', '2': 'Error', '3': 'PendingDeletion', '4': 'PaperJam', '5': 'PaperOut',
  '6': 'ManualFeed', '7': 'PaperProblem', '8': 'Offline', '9': 'IOActive', '10': 'Busy', '11': 'Printing',
  '12': 'OutputBinFull', '13': 'NotAvailable', '14': 'Waiting', '15': 'Processing', '16': 'Initialization',
  '17': 'WarmingUp', '18': 'TonerLow', '19': 'NoToner', '20': 'PagePunt', '21': 'UserIntervention',
  '22': 'OutOfMemory', '23': 'DoorOpen', '24': 'ServerUnknown', '25': 'PowerSave',
  '26': 'ServerOffline', '27': 'DriverUpdateNeeded',
}

const DOSTEPNE = new Set([
  'normal', 'printing', 'busy', 'processing', 'waiting', 'warmingup', 'ioactive', 'initialization', 'initializing',
  'powersave', 'tonerlow',
])
// Stany na pewno złe: tylko one blokują druk na danej roli (README, sekcja 5: „gdy nie wiemy, drukujemy”).
const ZLE = new Set([
  'paused', 'error', 'pendingdeletion', 'paperjam', 'paperout', 'manualfeed', 'paperproblem', 'outputbinfull',
  'notoner', 'pagepunt', 'userintervention', 'userinterventionrequired', 'outofmemory', 'dooropen', 'driverupdateneeded',
])
const OFFLINE = new Set(['offline', 'notavailable', 'serverunknown', 'serveroffline'])

const OPIS_PL: Record<string, string> = {
  paused: 'wstrzymana w Windows',
  error: 'błąd drukarki',
  pendingdeletion: 'drukarka w trakcie usuwania',
  paperjam: 'zacięcie papieru lub etykiet',
  paperout: 'brak papieru lub etykiet',
  manualfeed: 'czeka na ręczne podanie papieru',
  paperproblem: 'problem z papierem lub etykietami',
  offline: 'drukarka offline (wyłączona lub odłączona)',
  notavailable: 'drukarka niedostępna',
  serverunknown: 'nieznany stan serwera wydruku',
  serveroffline: 'serwer wydruku niedostępny',
  driverupdateneeded: 'sterownik drukarki wymaga aktualizacji',
  outputbinfull: 'pełny odbiornik wydruków',
  tonerlow: 'kończy się toner',
  notoner: 'brak tonera',
  pagepunt: 'nie można wydrukować strony',
  userintervention: 'drukarka czeka na obsługę',
  userinterventionrequired: 'drukarka czeka na obsługę',
  outofmemory: 'brak pamięci w drukarce',
  dooropen: 'otwarta pokrywa',
}

export function mapujStanWindows(s: StanWindows): { stan: StanDrukarki; komunikat?: string } {
  const nazwaStatusu = (STATUS_Z_LICZBY[s.status.trim()] ?? s.status).trim()
  const klucz = nazwaStatusu.toLowerCase().replace(/[\s_-]/g, '')
  if (s.offline || OFFLINE.has(klucz)) return { stan: 'OFFLINE', komunikat: OPIS_PL[klucz] ?? OPIS_PL.offline }
  if (DOSTEPNE.has(klucz)) return OPIS_PL[klucz] ? { stan: 'DOSTEPNA', komunikat: OPIS_PL[klucz] } : { stan: 'DOSTEPNA' }
  if (ZLE.has(klucz)) return { stan: 'BLAD', komunikat: OPIS_PL[klucz] ?? nazwaStatusu }
  // Nieznany stan (nowa wersja Windows, sterownik z własną nazwą): drukujemy mimo to — ewentualny błąd wyjdzie przy
  // samym druku albo w liczbie zadań stojących w kolejce. Decyzja 2026-10-26.
  return { stan: 'DOSTEPNA', komunikat: `nieznany stan drukarki: ${nazwaStatusu || 'brak'} — drukujemy mimo to` }
}

/**
 * Stan wszystkich ról z konfiguracji. Brak drukarki o danej nazwie w Windows = BLAD z podpowiedzią,
 * bo najczęstsza przyczyna to literówka w konfiguracji albo przemianowana drukarka.
 */
export function stanyRol(mapa: MapaRol, stanyWindows: StanWindows[]): StanJednejDrukarki[] {
  const wgNazwy = new Map(stanyWindows.map((s) => [s.nazwa.toLowerCase(), s]))
  const wynik: StanJednejDrukarki[] = []
  for (const rola of roleZKonfiguracji(mapa)) {
    const nazwa = nazwaDrukarki(mapa, rola)!
    const s = wgNazwy.get(nazwa.toLowerCase())
    if (!s) {
      wynik.push({
        rola,
        nazwa,
        stan: 'BLAD',
        komunikat: `nie ma w Windows drukarki o nazwie „${nazwa}” — sprawdź konfigurację`,
        zleceniaWKolejce: null,
      })
      continue
    }
    const { stan, komunikat } = mapujStanWindows(s)
    wynik.push({ rola, nazwa, stan, ...(komunikat ? { komunikat } : {}), zleceniaWKolejce: s.zleceniaWKolejce })
  }
  return wynik
}

/**
 * Propozycja dla serwera przy awarii drukarki termicznej (decyzja 2026-10-25: agent tylko proponuje, drukuje
 * dopiero nowe zlecenie od serwera). Kolejna termiczna z konfiguracji (po numerze, za tą, która zawiodła, potem od
 * początku), jeśli nie wiadomo, że leży; inaczej A4 (serwer musi wtedy dać etykietę w PDF), a bez `A4` pierwsza
 * inna drukarka nietermiczna (A4_2…). Dla drukarek nietermicznych nie ma zapasu.
 * Przy dwóch termicznych daje to samo co wersja 0.1.0: TERMICZNA_1 ↔ TERMICZNA_2, potem A4.
 */
export function rolaZapasowa(
  rola: RolaDrukarki,
  mapa: MapaRol,
  stany: ReadonlyMap<RolaDrukarki, StanDrukarki>,
): RolaDrukarki | undefined {
  if (!jestTermiczna(rola)) return undefined
  const role = roleZKonfiguracji(mapa)
  const termiczne = role.filter(jestTermiczna)
  const i = termiczne.indexOf(rola)
  // kolejne za awaryjną, potem od początku (TERMICZNA_3 zawiodła → 4, 5…, 1, 2)
  const kolejne = i < 0 ? termiczne : [...termiczne.slice(i + 1), ...termiczne.slice(0, i)]
  for (const r of kolejne) {
    if (r === rola) continue
    const stan = stany.get(r)
    if (stan === undefined || stan === 'DOSTEPNA') return r
  }
  if (nazwaDrukarki(mapa, 'A4')) return 'A4'
  return role.find((r) => !jestTermiczna(r))
}
