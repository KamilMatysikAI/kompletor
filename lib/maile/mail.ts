// Wejście modułu: renderujMail(rodzaj, kontekst marki, dane) → temat + HTML + tekst + załączniki.
// Dane wejściowe są typowane per rodzaj i tu zamieniane na zmienne tekstowe (kwoty, daty, odmiana).
// Bez Prismy i bez wysyłki: wywołujący (osobne zadanie) zbiera dane z bazy i wysyła wynik.
import { BladSzablonu, formatujDate, formatujDateCzas, formatujKwote, formatujRachunek, sprawdzUrl, wCiaguDniRoboczych } from './formaty'
import { renderujTresc, scalNadpisanie, sprawdzDefinicje, type Zmienne } from './silnik'
import { SZABLONY_DOMYSLNE } from './szablony'
import type { GotowyMail, KontekstMarki, NadpisanieSzablonu, OpcjeRenderowania, RodzajMaila, Zalacznik } from './typy'
import { sprawdzMarke, ukladHtml, ukladTekst } from './uklad'

export interface PozycjaMaila {
  nazwa: string
  ilosc: number
}

export interface DaneBrakPlatnosci {
  imie?: string | null
  numerZamowienia: string
  kwotaGr: number // grosze, jak w lib/rdzen/ceny.ts
  waluta?: string // domyślnie PLN
  linkPlatnosci?: string | null
  /**
   * N dni roboczych od złożenia, po których nieopłacone zamówienie jest anulowane. Wartość podaje wywołujący
   * z ReservationPolicy (w sezonie okres jest krótszy), szablon jej nie wylicza.
   */
  dniDoAnulowania: number
  /**
   * Data anulowania wyliczona z ReservationPolicy (złożenie + dniDoAnulowania dni roboczych). Zadanie wysyłki
   * ma ją podawać ZAWSZE: wtedy treść mówi „do <data>”, co jest prawdą w dniu wysyłki także w sezonie, gdy
   * przypomnienie idzie po 2 dniach roboczych, a okres jest krótszy. Bez daty: „w ciągu N dni roboczych od złożenia”.
   */
  terminAnulowania?: Date | null
  pozycje?: PozycjaMaila[] | null
}

/**
 * Przypomnienie po nieudanej płatności online: pytanie, czy wystąpił problem, i dane do przelewu tradycyjnego. Odbiorca
 * przelewu = nazwa firmy z kontekstu marki, rachunek z danych firmy (Ustawienia → Dokumenty i faktury → Dane firmy).
 */
export interface DaneNieudanaPlatnosc {
  imie?: string | null
  numerZamowienia: string
  kwotaGr: number // grosze
  waluta?: string // domyślnie PLN
  /** Rachunek firmy (NRB albo IBAN); bez niego mail nie powstaje. */
  rachunek: string
  /**
   * Numer zamówienia tak, jak klient zna go ze sklepu (bez przedrostka konta z Kompletora), do tytułu przelewu;
   * brak = `numerZamowienia`.
   */
  numerWSklepie?: string | null
  /** Odbiorca przelewu: pełna nazwa z Danych firmy; brak = nazwa firmy ze stopki maila (podgląd na przykładzie). */
  odbiorcaPrzelewu?: string | null
  /** Termin anulowania (`Order.reservationDeadline`); bez daty mail nie powstaje (jak „Brak płatności”). */
  terminAnulowania: Date
  /** Towar zamówienia nie jest już zarezerwowany (krótki termin po nieudanej płatności minął). */
  towarZwolniony: boolean
  pozycje?: PozycjaMaila[] | null
}

export interface PdfFaktury {
  tresc: Uint8Array
  nazwaPliku?: string | null // domyślnie z numeru faktury
}

export interface DaneFaktura {
  imie?: string | null
  /**
   * Numer z programu do faktur; brak (program go nie podał) = mail w wariancie bez numeru: „Faktura do zamówienia …”,
   * plik „Faktura-do-zamówienia-….pdf”. Wywołujący nigdy nie podstawia tu identyfikatora dokumentu.
   */
  numerFaktury?: string | null
  numerZamowienia: string
  /** Numer przesyłki (kilka paczek: numery po przecinku); brak = mail bez wiersza o przesyłce. */
  numerPrzesylki?: string | null
  /** Strona śledzenia u przewoźnika (tylko https); brak = bez przycisku. */
  linkSledzenia?: string | null
  pdf: PdfFaktury
}

export interface DaneGotoweDoOdbioru {
  imie?: string | null
  numerZamowienia: string
  odbiorDo?: Date | null
  pozycje?: PozycjaMaila[] | null
}

export interface DaneBladFaktury {
  numerZamowienia: string
  trescBledu: string
  linkDoZamowienia: string
  kiedy?: Date | null
}

/** niski stan produktu (reguła P2), do biura. */
export interface DaneNiskiStan {
  sku: string
  nazwa?: string | null
  dostepne: number
  prog: number
  linkDoProduktu?: string | null
}

/** reset hasła; `email` = adres konta (adresat), link jednorazowy z `PANEL_URL`. */
export interface DaneResetHasla {
  email: string
  link: string
  waznyDo: Date
}

/** zaproszenie do firmy; `email` = adres zaproszonej osoby (adresat), link z `PANEL_URL`. */
export interface DaneZaproszenia {
  email: string
  link: string
  /** Nazwa roli dla ludzi, np. „Magazyn”. */
  rola: string
  waznyDo: Date
}

/** Zwrot albo reklamacja: paczka dotarła albo pieniądze zwrócone; `pozycje` = zwrócone produkty (bez cen). */
export interface DaneZwrotu {
  imie?: string | null
  numerZamowienia: string
  pozycje?: PozycjaMaila[] | null
}

export interface DaneMaili {
  'brak-platnosci': DaneBrakPlatnosci
  'nieudana-platnosc': DaneNieudanaPlatnosc
  faktura: DaneFaktura
  'gotowe-do-odbioru': DaneGotoweDoOdbioru
  'blad-faktury': DaneBladFaktury
  'niski-stan': DaneNiskiStan
  'reset-hasla': DaneResetHasla
  zaproszenie: DaneZaproszenia
  'zwrot-przyjety': DaneZwrotu
  'reklamacja-przyjeta': DaneZwrotu
  'zwrot-pieniedzy': DaneZwrotu
}

interface Przygotowane {
  zmienne: Zmienne
  zalaczniki?: Zalacznik[]
  do?: string | null
}

function pozycje(lista: PozycjaMaila[] | null | undefined): string[] | null {
  if (!lista?.length) return null
  return lista.map((p, i) => {
    if (typeof p?.nazwa !== 'string' || !p.nazwa.trim()) throw new BladSzablonu([`pozycja ${i + 1}: brak nazwy produktu`])
    if (!Number.isFinite(p.ilosc) || p.ilosc <= 0) throw new BladSzablonu([`pozycja ${i + 1}: niepoprawna ilość ${p.ilosc}`])
    return `${String(p.ilosc).replace('.', ',')} × ${p.nazwa.trim()}`
  })
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] // „%PDF-”

/** Nazwa pliku bez ukośników i znaków sterujących: „FV 12/10/2026” → „Faktura-FV-12-10-2026.pdf”. */
export function nazwaPlikuFaktury(numerFaktury: string): string {
  const rdzen = numerFaktury
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return `Faktura-${rdzen || 'bez-numeru'}.pdf`
}

const zwrot = (d: DaneZwrotu): Przygotowane => ({ zmienne: { imie: d.imie, numerZamowienia: d.numerZamowienia, pozycje: pozycje(d.pozycje) } })

const PRZYGOTUJ: { [R in RodzajMaila]: (d: DaneMaili[R], k: KontekstMarki) => Przygotowane } = {
  'zwrot-przyjety': zwrot,
  'reklamacja-przyjeta': zwrot,
  'zwrot-pieniedzy': zwrot,
  'brak-platnosci': (d) => ({
    zmienne: {
      imie: d.imie,
      numerZamowienia: d.numerZamowienia,
      kwota: d.kwotaGr == null ? null : formatujKwote(d.kwotaGr, d.waluta ?? 'PLN'),
      linkPlatnosci: d.linkPlatnosci ? sprawdzUrl(d.linkPlatnosci, 'link do płatności') : null,
      dniDoAnulowania: d.dniDoAnulowania == null ? null : wCiaguDniRoboczych(d.dniDoAnulowania),
      terminAnulowania: d.terminAnulowania ? formatujDate(d.terminAnulowania) : null,
      pozycje: pozycje(d.pozycje),
    },
  }),

  'nieudana-platnosc': (d, k) => {
    const bledy: string[] = []
    if (!d.rachunek?.trim()) bledy.push(`firma „${k.firma.nazwa}”: brak numeru rachunku do przelewu`)
    if (!(d.terminAnulowania instanceof Date)) bledy.push('nieudana płatność: brak terminu anulowania')
    if (bledy.length) throw new BladSzablonu(bledy)
    return {
      zmienne: {
        imie: d.imie,
        numerZamowienia: d.numerZamowienia,
        kwota: formatujKwote(d.kwotaGr, d.waluta ?? 'PLN'),
        odbiorcaPrzelewu: d.odbiorcaPrzelewu?.trim() || k.firma.nazwa,
        rachunek: formatujRachunek(d.rachunek),
        tytulPrzelewu: `Zamówienie ${d.numerWSklepie?.trim() || d.numerZamowienia}`,
        terminAnulowania: formatujDate(d.terminAnulowania),
        towarZwolniony: d.towarZwolniony ? 'tak' : null,
        pozycje: pozycje(d.pozycje),
      },
    }
  },

  faktura: (d) => {
    const tresc = d.pdf?.tresc
    if (!(tresc instanceof Uint8Array) || tresc.length === 0) throw new BladSzablonu(['faktura: brak pliku PDF'])
    if (!PDF_MAGIC.every((b, i) => tresc[i] === b)) throw new BladSzablonu(['faktura: załącznik nie jest plikiem PDF'])
    const numer = d.numerFaktury?.trim() ? d.numerFaktury : null
    const podana = d.pdf.nazwaPliku?.trim()
    const nazwaPliku = podana
      ? podana.replace(/[\\/\u0000-\u001f"]+/g, '-').replace(/(\.pdf)?$/i, '.pdf')
      : nazwaPlikuFaktury(numer ?? `do zamówienia ${d.numerZamowienia ?? ''}`)
    return {
      zmienne: {
        imie: d.imie,
        numerFaktury: numer,
        numerZamowienia: d.numerZamowienia,
        numerPrzesylki: d.numerPrzesylki?.trim() || null,
        linkSledzenia: d.linkSledzenia && /^https:\/\/\S{1,300}$/.test(d.linkSledzenia) ? d.linkSledzenia : null,
      },
      zalaczniki: [{ nazwaPliku, typMime: 'application/pdf', tresc }],
    }
  },

  'gotowe-do-odbioru': (d, k) => {
    const odbior = k.sklep.odbiorOsobisty
    const bledy: string[] = []
    if (!odbior?.adres?.some((l) => l.trim())) bledy.push(`sklep „${k.sklep.nazwa}”: brak adresu odbioru osobistego`)
    if (!odbior?.godziny?.some((l) => l.trim())) bledy.push(`sklep „${k.sklep.nazwa}”: brak godzin odbioru osobistego`)
    if (bledy.length || !odbior) throw new BladSzablonu(bledy)
    return {
      zmienne: {
        imie: d.imie,
        numerZamowienia: d.numerZamowienia,
        adresOdbioru: odbior.adres,
        godzinyOdbioru: odbior.godziny,
        uwagiOdbioru: odbior.uwagi,
        odbiorDo: d.odbiorDo ? formatujDate(d.odbiorDo) : null,
        pozycje: pozycje(d.pozycje),
      },
    }
  },

  'blad-faktury': (d, k) => {
    if (!k.firma.emailBiura) throw new BladSzablonu([`firma „${k.firma.nazwa}”: brak adresu e-mail biura dla maili wewnętrznych`])
    return {
      zmienne: {
        numerZamowienia: d.numerZamowienia,
        trescBledu: d.trescBledu,
        linkDoZamowienia: d.linkDoZamowienia ? sprawdzUrl(d.linkDoZamowienia, 'link do zamówienia') : null,
        kiedy: d.kiedy ? formatujDateCzas(d.kiedy) : null,
      },
      do: k.firma.emailBiura,
    }
  },

  'niski-stan': (d, k) => {
    if (!k.firma.emailBiura) throw new BladSzablonu([`firma „${k.firma.nazwa}”: brak adresu e-mail biura dla maili wewnętrznych`])
    const liczba = (v: unknown, pole: string) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new BladSzablonu([`niski stan: niepoprawna wartość „${pole}”`])
      return String(v).replace('.', ',')
    }
    return {
      zmienne: {
        sku: d.sku,
        nazwaProduktu: d.nazwa,
        dostepne: liczba(d.dostepne, 'dostępne'),
        prog: liczba(d.prog, 'próg'),
        linkDoProduktu: d.linkDoProduktu ? sprawdzUrl(d.linkDoProduktu, 'link do produktu') : null,
      },
      do: k.firma.emailBiura,
    }
  },

  'reset-hasla': (d) => {
    if (!d.email?.trim()) throw new BladSzablonu(['reset hasła: brak adresu konta'])
    return {
      zmienne: { link: d.link ? sprawdzUrl(d.link, 'link do zmiany hasła') : null, waznyDo: d.waznyDo ? formatujDateCzas(d.waznyDo) : null },
      do: d.email.trim(),
    }
  },

  zaproszenie: (d) => {
    if (!d.email?.trim()) throw new BladSzablonu(['zaproszenie: brak adresu osoby'])
    return {
      zmienne: { link: d.link ? sprawdzUrl(d.link, 'link zaproszenia') : null, rola: d.rola?.trim() || null, waznyDo: d.waznyDo ? formatujDateCzas(d.waznyDo) : null },
      do: d.email.trim(),
    }
  },
}

function zmienneMarki(k: KontekstMarki): Zmienne {
  return {
    'sklep.nazwa': k.sklep.nazwa,
    'sklep.email': k.sklep.odpowiedzDo,
    'sklep.www': k.sklep.www,
    'firma.nazwa': k.firma.nazwa,
    'firma.email': k.firma.email,
    'firma.telefon': k.firma.telefon,
  }
}

/**
 * Sprawdza nadpisanie (np. przed zapisem z panelu): kształt, składnia, tylko zmienne danego szablonu.
 * Zwraca listę błędów; pusta = można zapisać.
 */
export function sprawdzNadpisanie(rodzaj: RodzajMaila, n: NadpisanieSzablonu): string[] {
  // rodzaj może przyjść z żądania HTTP: nieznany = błąd do zwrócenia (400), nie wyjątek (500).
  const def = Object.hasOwn(SZABLONY_DOMYSLNE, rodzaj) ? SZABLONY_DOMYSLNE[rodzaj] : undefined
  if (!def) return [`nieznany rodzaj maila „${String(rodzaj)}”`]
  if (typeof n !== 'object' || n === null) return ['nadpisanie: oczekiwano obiektu']
  const bledy: string[] = []
  for (const pole of ['temat', 'podglad', 'naglowek'] as const)
    if (n[pole] !== undefined && typeof n[pole] !== 'string') bledy.push(`${pole}: oczekiwano tekstu`)
  if (n.bloki !== undefined && !Array.isArray(n.bloki)) bledy.push('bloki: oczekiwano listy')
  if (bledy.length) return bledy
  return sprawdzDefinicje(scalNadpisanie(def, n))
}

export function renderujMail<R extends RodzajMaila>(
  rodzaj: R,
  kontekst: KontekstMarki,
  dane: DaneMaili[R],
  opcje: OpcjeRenderowania = {},
): GotowyMail {
  const domyslny = Object.hasOwn(SZABLONY_DOMYSLNE, rodzaj) ? SZABLONY_DOMYSLNE[rodzaj] : undefined
  if (!domyslny) throw new BladSzablonu([`nieznany rodzaj maila „${String(rodzaj)}”`])
  sprawdzMarke(kontekst)
  if (dane == null || typeof dane !== 'object') throw new BladSzablonu([`${rodzaj}: brak danych`])
  const def = scalNadpisanie(
    scalNadpisanie(domyslny, opcje.nadpisania?.firma?.[rodzaj]),
    opcje.nadpisania?.sklep?.[rodzaj],
  )
  const przygotowane = PRZYGOTUJ[rodzaj](dane, kontekst)
  const zmienne = { ...przygotowane.zmienne, ...zmienneMarki(kontekst) }
  let tresc: ReturnType<typeof renderujTresc>
  try {
    tresc = renderujTresc(def, zmienne)
  } catch (e) {
    // Faktura bez numeru z programu, a treść firmy albo sklepu wstawia {{numerFaktury}} poza sekcją: faktura musi dojść,
    // więc ten jeden mail idzie treścią domyślną (ma wariant bez numeru), zamiast kończyć się błędem.
    if (!(rodzaj === 'faktura' && def !== domyslny && !zmienne.numerFaktury && e instanceof BladSzablonu && e.bledy.some((b) => b.includes('„numerFaktury”')))) throw e
    tresc = renderujTresc(domyslny, zmienne)
  }
  return {
    rodzaj,
    odbiorca: def.odbiorca,
    do: przygotowane.do ?? null,
    odpowiedzDo: kontekst.sklep.odpowiedzDo,
    temat: tresc.temat,
    html: ukladHtml(tresc, kontekst, def.odbiorca),
    tekst: ukladTekst(tresc, kontekst, def.odbiorca),
    zalaczniki: przygotowane.zalaczniki ?? [],
  }
}
