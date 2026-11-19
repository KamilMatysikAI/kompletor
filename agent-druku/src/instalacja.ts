// Logika instalatora, bez Windows i bez wejścia z klawiatury — testowana vitestem. Część interaktywna
// (pytania w konsoli, lista drukarek z Windows, zapis pliku) jest w instalator.ts, a skrypty/instaluj.ps1 tylko ją woła.
//
// Kod instalacyjny z panelu (Ustawienia → Wysyłka i druk → Druk): `kmi_` + base64url z JSON-a { serwer, stanowisko, token }. Jeden ciąg
// do wklejenia zamiast trzech pól — osoba w magazynie nie przepisuje adresu ani tokenu. Kod zawiera token, więc jest
// tak samo tajny jak token (pokazywany w panelu raz).
import type { RolaDrukarki } from './kontrakt.js'
import { jestRola } from './kontrakt.js'
import type { MapaRol } from './mapowanie.js'
import { roleZKonfiguracji } from './mapowanie.js'

export const PREFIKS_KODU = 'kmi_'
/** Token stanowiska z panelu: `kmd_` + 32 losowe bajty w base64url (43 znaki). */
export const WZOR_TOKENU = /^kmd_[A-Za-z0-9_-]{43}$/
export const WZOR_STANOWISKA = /^[A-Za-z0-9_-]{1,50}$/
/** Wzór roli dopuszcza 1–2 cyfry: najwyżej 99 drukarek jednego rodzaju na stanowisku. */
export const MAKS_DRUKAREK_RODZAJU = 99
/** Adresy, dla których instalator przyjmuje http:// (test na jednym komputerze); reszta tylko https. */
export const HOSTY_LOKALNE = ['localhost', '127.0.0.1', '[::1]']

export class BladInstalacji extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BladInstalacji'
  }
}

export interface KodInstalacyjny {
  serwer: string
  stanowisko: string
  token: string
}

export function zakodujKodInstalacyjny(k: KodInstalacyjny): string {
  return PREFIKS_KODU + Buffer.from(JSON.stringify({ serwer: k.serwer, stanowisko: k.stanowisko, token: k.token }), 'utf8').toString('base64url')
}

/**
 * Kod z panelu → adres, stanowisko i token. Wybacza to, co dzieje się przy kopiowaniu (spacje, cudzysłowy, złamana
 * linia); wszystko inne = BladInstalacji z podpowiedzią po polsku.
 */
export function dekodujKodInstalacyjny(wklejony: string): KodInstalacyjny {
  const kod = wklejony.replace(/\s+/g, '').replace(/^["'„”]+|["'„”]+$/g, '')
  if (!kod) throw new BladInstalacji('Nie wklejono kodu. Skopiuj kod instalacyjny z panelu: Ustawienia → Wysyłka i druk → Druk.')
  if (WZOR_TOKENU.test(kod))
    throw new BladInstalacji('To jest sam token stanowiska, a potrzebny jest kod instalacyjny (zaczyna się od kmi_). Skopiuj go z panelu obok tokenu.')
  if (!kod.startsWith(PREFIKS_KODU)) throw new BladInstalacji('Kod instalacyjny zaczyna się od kmi_. Skopiuj go z panelu: Ustawienia → Wysyłka i druk → Druk → stanowisko → Nowy token.')
  const tresc = kod.slice(PREFIKS_KODU.length)
  if (!/^[A-Za-z0-9_-]+$/.test(tresc)) throw new BladInstalacji('Kod instalacyjny jest uszkodzony (niedozwolone znaki). Skopiuj go jeszcze raz w całości.')
  let json: unknown
  try {
    json = JSON.parse(Buffer.from(tresc, 'base64url').toString('utf8'))
  } catch {
    throw new BladInstalacji('Kod instalacyjny jest niepełny albo uszkodzony. Skopiuj go jeszcze raz w całości.')
  }
  const o = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>
  const serwer = typeof o.serwer === 'string' ? o.serwer.trim() : ''
  const stanowisko = typeof o.stanowisko === 'string' ? o.stanowisko.trim() : ''
  const token = typeof o.token === 'string' ? o.token.trim() : ''
  const bledy: string[] = []
  let serwerOrigin = ''
  try {
    const u = new URL(serwer)
    if (u.protocol === 'http:' && !HOSTY_LOKALNE.includes(u.hostname))
      // token Bearer szedłby siecią otwartym tekstem, a agent nie podąża za przekierowaniem na https.
      throw new BladInstalacji(
        `Kod instalacyjny wskazuje serwer bez https (${u.origin}): token szedłby siecią otwartym tekstem. ` +
          'Otwórz panel Kompletora pod adresem https://…, utwórz nowy token i wklej nowy kod.',
      )
    if (u.protocol !== 'https:' && u.protocol !== 'http:') bledy.push('adres serwera musi zaczynać się od https://')
    // Panel wpisuje do kodu sam adres serwera (protokół i host). Login lub hasło w adresie = kod nie z panelu.
    else if (u.username || u.password) bledy.push('adres serwera nie może zawierać loginu ani hasła')
    else serwerOrigin = u.origin
  } catch (e) {
    if (e instanceof BladInstalacji) throw e
    bledy.push('brak poprawnego adresu serwera')
  }
  if (!WZOR_STANOWISKA.test(stanowisko)) bledy.push('brak poprawnej nazwy stanowiska')
  if (!WZOR_TOKENU.test(token)) bledy.push('brak poprawnego tokenu')
  if (bledy.length) throw new BladInstalacji(`Kod instalacyjny jest uszkodzony: ${bledy.join(', ')}. Skopiuj go jeszcze raz albo utwórz nowy token w panelu.`)
  return { serwer: serwerOrigin, stanowisko, token }
}

export type RodzajDrukarki = 'A4' | 'TERMICZNA' | 'POMIN'

/**
 * Odpowiedź z klawiatury na pytanie „co to za drukarka”: A / T / Enter (pomiń). null = nie rozumiem, pytamy ponownie.
 * „P” to kartka próbna (czyWydrukProbny), nie „pomiń”.
 */
export function rodzajZOdpowiedzi(tekst: string): RodzajDrukarki | null {
  const t = tekst.trim().toLowerCase()
  if (t === '' || t === 'pomiń' || t === 'pomin' || t === 'n') return 'POMIN'
  if (t === 'a' || t === 'a4' || t === 'zwykła' || t === 'zwykla') return 'A4'
  if (t === 't' || t === 'termiczna' || t === 'etykiety' || t === 'e') return 'TERMICZNA'
  return null
}

/** „P” przy drukarce = wydrukuj kartkę próbną z numerem z listy, potem pytanie o rodzaj wraca. */
export function czyWydrukProbny(tekst: string): boolean {
  const t = tekst.trim().toLowerCase()
  return t === 'p' || t === 'próba' || t === 'proba' || t === 'próbna' || t === 'probna'
}

/**
 * Role według kolejności na liście Windows: pierwsza zwykła → `A4`, kolejne → `A4_2`, `A4_3`…; termiczne →
 * `TERMICZNA_1`, `TERMICZNA_2`, `TERMICZNA_3`… Bez limitu poza wzorem roli (99 jednego rodzaju).
 */
export function przydzielRole(wybory: { nazwa: string; rodzaj: RodzajDrukarki }[]): MapaRol {
  const mapa: MapaRol = {}
  let a4 = 0
  let term = 0
  const uzyte = new Set<string>()
  for (const w of wybory) {
    const nazwa = w.nazwa.trim()
    if (w.rodzaj === 'POMIN' || !nazwa) continue
    if (uzyte.has(nazwa.toLowerCase())) continue // ta sama drukarka dwa razy na liście — jedna rola
    uzyte.add(nazwa.toLowerCase())
    let rola: RolaDrukarki
    if (w.rodzaj === 'A4') rola = ++a4 === 1 ? 'A4' : `A4_${a4}`
    else rola = `TERMICZNA_${++term}`
    if (a4 > MAKS_DRUKAREK_RODZAJU || term > MAKS_DRUKAREK_RODZAJU || !jestRola(rola))
      throw new BladInstalacji(`Najwyżej ${MAKS_DRUKAREK_RODZAJU} drukarek jednego rodzaju na jednym stanowisku`)
    mapa[rola] = nazwa
  }
  return mapa
}

/** Linie podsumowania przed zapisem: „A4 (zwykła) = Brother…”. */
export function opisPrzydzialu(mapa: MapaRol): string[] {
  return roleZKonfiguracji(mapa).map((r) => `${r.padEnd(12)} ${r.startsWith('TERMICZNA_') ? '(termiczna)' : '(zwykła)   '} = ${mapa[r]}`)
}

/**
 * Nowa treść agent-druku.json: z kodu i przydziału drukarek. Pozostałe pola poprzedniego pliku (ustawienia dla
 * zaawansowanych, np. odpytywanieSekundy, dozwoloneHostyPlikow) zostają bez zmian.
 */
export function zbudujKonfiguracje(poprzednia: unknown, kod: KodInstalacyjny, drukarki: MapaRol): Record<string, unknown> {
  if (Object.keys(drukarki).length === 0) throw new BladInstalacji('Nie wybrano żadnej drukarki — przypisz co najmniej jedną.')
  const stara = typeof poprzednia === 'object' && poprzednia !== null && !Array.isArray(poprzednia) ? (poprzednia as Record<string, unknown>) : {}
  // Sumatra: domyślna (z paczki) zamiast starej ścieżki do Program Files z przykładu 0.1.0 — gdy ktoś wpisał własną, zostaje.
  const { sumatraPdf, ...reszta } = stara
  const wlasnaSumatra = typeof sumatraPdf === 'string' && sumatraPdf.trim() && !/^C:\\Program Files\\SumatraPDF\\SumatraPDF\.exe$/i.test(sumatraPdf.trim())
  return {
    ...reszta,
    serwer: kod.serwer,
    token: kod.token,
    stanowisko: kod.stanowisko,
    drukarki: Object.fromEntries(roleZKonfiguracji(drukarki).map((r) => [r, drukarki[r]])),
    ...(wlasnaSumatra ? { sumatraPdf } : {}),
  }
}
