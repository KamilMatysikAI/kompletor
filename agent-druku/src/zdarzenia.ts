// Log programu przełożony na zdania dla osoby w magazynie: „Ostatnie zdarzenia”, ostatni wydruk i ostatni błąd na
// stronie ustawień. Czyta końcówkę pliku logu (przeżywa ponowne uruchomienie programu). Zanim cokolwiek trafi na
// ekran, z tekstu znikają kody połączenia, tokeny i dane w nawiasach klamrowych.
import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs'
import { KOMUNIKAT_ODMOWY_TOKENU } from './kolejka.js'

export type RodzajZdarzenia = 'info' | 'uwaga' | 'blad'

export interface Zdarzenie {
  /** Czas z logu, lokalny: „2026-11-10 14:05:03”. */
  czas: string
  rodzaj: RodzajZdarzenia
  tekst: string
  /** Co zrobić, gdy coś nie działa; brak przy zwykłych wpisach. */
  podpowiedz?: string
}

/** Wszystko, co wygląda na kod połączenia, token albo nagłówek z hasłem, zamienione na „•••”. */
export function ukryjSekrety(t: string): string {
  return t
    .replace(/\bkm[a-z]_[A-Za-z0-9_-]{8,}/g, '•••')
    .replace(/Bearer\s+\S+/gi, 'Bearer •••')
    .replace(/("?token"?\s*[:=]\s*)"?[^",\s}]+"?/gi, '$1•••')
    .replace(/([?&](klucz|token)=)[^&\s]+/gi, '$1•••')
}

const NAZWY_TYPOW: Record<string, string> = { karta: 'kartę zamówienia', lista: 'listę zamówień', spis: 'spis', etykieta: 'etykietę' }

/** Podpowiedź do komunikatu o błędzie: co sprawdzić albo kliknąć. */
export function podpowiedzDo(t: string): string | undefined {
  const m = t.toLowerCase()
  if (m.includes('odrzucił token') || m.includes('token jest nieważny') || /odpowiedział 40[13]/.test(m) || m.includes('odpowiedź 401') || m.includes('odpowiedź 403'))
    return 'Kompletor nie przyjmuje kodu połączenia. Weź nowy kod w Kompletorze (Ustawienia → Wysyłka i druk → Druk) i wklej go niżej w „Podłącz do Kompletora”.'
  if (m.includes('brak połączenia') || m.includes('fetch failed') || m.includes('brak odpowiedzi') || m.includes('enotfound') || m.includes('econnrefused'))
    return 'Sprawdź, czy ten komputer ma internet (otwórz dowolną stronę). Program sam spróbuje ponownie.'
  if (m.includes('nie ma w windows drukarki')) return 'Drukarka zmieniła nazwę albo została odłączona. Wybierz drukarki na liście poniżej i kliknij „Zapisz”.'
  if (m.includes('brak papieru') || m.includes('paperout')) return 'Włóż papier albo nową rolkę etykiet.'
  if (m.includes('zacięcie')) return 'Otwórz drukarkę i wyjmij zacięty papier lub etykietę.'
  if (m.includes('offline') || m.includes('wyłączona lub odłączona') || m.includes('niedostępna'))
    return 'Sprawdź, czy drukarka jest włączona i czy kabel jest podłączony do komputera.'
  if (m.includes('wstrzymana')) return 'W Windows otwórz kolejkę tej drukarki i wybierz „Wznów drukowanie”.'
  if (m.includes('niewydrukowanych zadań') || m.includes('kolejce windows'))
    return 'W Windows otwórz kolejkę tej drukarki i usuń zawieszone wydruki, potem sprawdź drukarkę.'
  if (m.includes('nie wiadomo, czy wydruk wyszedł') || m.includes('przekroczony czas'))
    return 'Sprawdź, czy wydruk wyszedł. Jeśli nie, zleć go jeszcze raz w Kompletorze.'
  if (m.includes('sumatrapdf') || m.includes('nie znaleziono programu')) return 'Brakuje części programu. Zainstaluj program jeszcze raz z paczki Kompletor Druk.'
  if (m.includes('konfiguracj')) return 'Podłącz program do Kompletora i wybierz drukarki na tej stronie, potem kliknij „Zapisz”.'
  if (m.includes('już działa na tym komputerze')) return 'Program jest już uruchomiony. Jeśli strona nic nie pokazuje, uruchom komputer ponownie.'
  return undefined
}

/** Jedna linia logu → zdarzenie dla człowieka; null = linia nieczytelna albo nieciekawa. */
export function zdarzenieZLinii(linia: string): Zdarzenie | null {
  const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (INFO|UWAGA|BLAD)\s+(.*)$/.exec(linia.trim())
  if (!m) return null
  const [, czas, poziom, resztaSurowa] = m as unknown as [string, string, string, string]
  // Dane techniczne w JSON-ie na końcu linii nie trafiają na ekran.
  const reszta = ukryjSekrety(resztaSurowa.replace(/\s\{.*\}$/, '').trim())
  const rodzaj: RodzajZdarzenia = poziom === 'BLAD' ? 'blad' : poziom === 'UWAGA' ? 'uwaga' : 'info'
  let tekst: string
  let r
  if ((r = /^Start agenta druku (\S+)/.exec(reszta))) tekst = `Program uruchomiony (wersja ${r[1]}).`
  else if (/^Zatrzymanie agenta/.test(reszta)) tekst = 'Program zatrzymany.'
  else if ((r = /^Wydrukowano (\w+) \S+ \((\w+), (\d+) szt\.\) na „(.+)”$/.exec(reszta)))
    tekst = `Wydrukowano ${NAZWY_TYPOW[r[1]!] ?? r[1]}${r[3] !== '1' ? ` (${r[3]} szt.)` : ''} na drukarce „${r[4]}”.`
  else if ((r = /^Zlecenie \S+ było już wydrukowane/.exec(reszta))) tekst = 'Wydruk był już zrobiony wcześniej, nie drukuję drugi raz.'
  else if ((r = /^Zlecenie \S+: (.*)$/.exec(reszta))) tekst = `Wydruk nie wyszedł: ${r[1]}`
  else if (/^Połączenie z serwerem wróciło/.test(reszta)) tekst = 'Połączenie z Kompletorem wróciło.'
  else if ((r = /^Nie udało się pobrać zleceń: (.*)$/.exec(reszta))) tekst = `Brak połączenia z Kompletorem: ${r[1]}`
  else if (reszta.startsWith(KOMUNIKAT_ODMOWY_TOKENU.slice(0, 40))) tekst = 'Kompletor nie przyjmuje kodu połączenia (kod zastąpiony nowym albo stanowisko wyłączone).'
  else if (/^Cykl zleceń/.test(reszta)) return null
  else
    tekst = reszta
      .replace(/agenta druku/gi, 'programu')
      .replace(/agentem druku/gi, 'programem')
      .replace(/agentowi druku/gi, 'programowi')
      .replace(/agent druku/gi, 'program').replace(/\bserwer(a|em|owi|ze)?\b/gi, 'Kompletor')
  const podpowiedz = rodzaj === 'info' ? undefined : podpowiedzDo(reszta)
  return { czas, rodzaj, tekst, ...(podpowiedz ? { podpowiedz } : {}) }
}

/** Ostatnie `bajtow` pliku jako linie (bez ewentualnie uciętej pierwszej). */
export function koncowkaPliku(plik: string, bajtow = 64 * 1024): string[] {
  if (!existsSync(plik)) return []
  const fd = openSync(plik, 'r')
  try {
    const rozmiar = fstatSync(fd).size
    const start = Math.max(0, rozmiar - bajtow)
    const bufor = Buffer.alloc(rozmiar - start)
    readSync(fd, bufor, 0, bufor.length, start)
    const linie = bufor.toString('utf8').split(/\r?\n/)
    if (start > 0) linie.shift()
    return linie.filter(Boolean)
  } finally {
    closeSync(fd)
  }
}

const SUKCES = /^(Wydrukowano |Konfiguracja wczytana|Połączenie z Kompletorem wróciło)/

export interface PodsumowanieLogu {
  zdarzenia: Zdarzenie[]
  ostatniWydruk?: Zdarzenie
  ostatniBlad?: Zdarzenie
}

/** Ostatnie `ile` zdarzeń (najnowsze pierwsze) i ostatni wydruk / błąd z końcówki logu. */
export function podsumujLog(linie: string[], ile = 20): PodsumowanieLogu {
  const wszystkie = linie.map(zdarzenieZLinii).filter((z): z is Zdarzenie => z !== null)
  const odKonca = [...wszystkie].reverse()
  const ostatniWydruk = odKonca.find((z) => z.tekst.startsWith('Wydrukowano '))
  // Błąd sprzed udanego wydruku albo poprawnie wczytanych ustawień jest już nieaktualny: zostaje w „Ostatnich
  // zdarzeniach”, ale nie wisi w stanie programu jako „Ostatni błąd”.
  const iBladu = odKonca.findIndex((z) => z.rodzaj === 'blad')
  const iSukcesu = odKonca.findIndex((z) => SUKCES.test(z.tekst))
  const ostatniBlad = iBladu >= 0 && (iSukcesu < 0 || iBladu < iSukcesu) ? odKonca[iBladu] : undefined
  return { zdarzenia: odKonca.slice(0, ile), ...(ostatniWydruk ? { ostatniWydruk } : {}), ...(ostatniBlad ? { ostatniBlad } : {}) }
}
