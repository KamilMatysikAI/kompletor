// Podgląd treści akcji z planu, renderowany na żądanie z panelu. Nic nie jest wysyłane.
//
// Podgląd akcji z planu pokazuje mail tak, jak dostałby go adresat: marka i stopka z ustawień firmy (Dane firmy,
// Poczta, szablony firmy), pozycje zamówienia, numer faktury z programu do faktur. Dane osobowe klienta nie wchodzą
// (bez imienia i adresu), PDF faktury to atrapa (prawdziwego pliku podgląd nie pobiera). Brakujące ustawienia firmy
// podgląd zgłasza zdaniem z drogą do ekranu i oznacza w treści znacznikiem „[brak: …]”.
// Dane fikcyjne (sklep „Żółwik”, lib/maile/przyklady.ts) zostają domyślnym źródłem funkcji czystych, czyli edytora
// szablonów i testów bez bazy.
import { BladSzablonu, renderujMail, SZABLONY_DOMYSLNE, type DaneMaili, type GotowyMail, type KontekstMarki, type NadpisaniaSzablonow, type PozycjaMaila } from '../maile'
import { DANE_PRZYKLADOWE, KONTEKST_PRZYKLADOWY, PDF_PRZYKLADOWY } from '../maile/przyklady'
import { REGULY, type KluczReguly } from './reguly'
import { informacjaBezDanychPrzelewu } from './wariant-platnosci'

export interface Podglad {
  temat: string
  tekst: string
  /** Do kogo poszłoby (bez adresu): klient sklepu albo biuro firmy. */
  odbiorca: 'klient' | 'biuro'
  uwaga: string
  /** Czego brakuje w ustawieniach firmy (zdania po polsku z drogą do ekranu); pusta = mail kompletny. */
  braki: string[]
  /** Informacje dla biura, które nie wstrzymują maila (np. zwykły mail zamiast wariantu z danymi do przelewu). */
  informacje?: string[]
}

type Vars = Record<string, unknown>
type RodzajPlanu = 'brak-platnosci' | 'nieudana-platnosc' | 'faktura' | 'gotowe-do-odbioru' | 'blad-faktury' | 'niski-stan' | 'zwrot-przyjety' | 'reklamacja-przyjeta' | 'zwrot-pieniedzy'

/** Skąd podgląd bierze markę i dane spoza planu. */
export interface ZrodloPodgladu {
  kontekst: KontekstMarki
  /** Treść szablonów firmy (Ustawienia → Komunikacja i poczta → Szablony maili). */
  nadpisania?: NadpisaniaSzablonow | null
  /** Pozycje zamówienia (nazwa produktu i ilość); w mailach o zwrocie zwrócone produkty. */
  pozycje?: PozycjaMaila[] | null
  /** Numer faktury tak, jak trafi do maila; null = program do faktur go nie podał (mail bez numeru); brak pola = numer z planu. */
  numerFaktury?: string | null
  /** Numer zamówienia tak, jak trafi do maila (numer ze sklepu); brak pola = numer z planu. */
  numerZamowienia?: string | null
  /** Numer przesyłki i link śledzenia do maila „Faktura” (jak w wysyłce); brak = mail bez nich. */
  numerPrzesylki?: string | null
  linkSledzenia?: string | null
  /** Nazwa produktu do maila „Niski stan”. */
  nazwaProduktu?: string | null
  /** Adres panelu do linków w mailach do biura; null = bez linku. */
  panel?: string | null
  /** Id zamówienia do linku w mailu do biura. */
  idZamowienia?: string | null
  /**
   * Przypomnienie o płatności: wariant ze stanu zamówienia (`wariant-platnosci.ts`); brak pola = z planu
   * (`vars.wariant`, podgląd na danych przykładowych).
   */
  wariant?: 'brak-platnosci' | 'nieudana-platnosc' | null
  /** Rachunek firmy do przelewu (Dane firmy); null przy prawdziwych danych = zwykły „Brak płatności” z informacją. */
  rachunek?: string | null
  /** Odbiorca przelewu: pełna nazwa z Danych firmy. */
  odbiorcaPrzelewu?: string | null
  /** Numer zamówienia ze sklepu (bez przedrostka konta) do tytułu przelewu. */
  numerWSklepie?: string | null
  /** Informacje dla biura zebrane przy zbieraniu danych (przepisywane do `Podglad.informacje`). */
  informacje?: string[]
  /** Towar zamówienia już zwolniony po nieudanej płatności online. */
  towarZwolniony?: boolean
  /** Braki wykryte przy zbieraniu danych (np. numer faktury); dopisywane do listy z ustawień. */
  braki?: string[]
  uwaga: string
}

export const UWAGA_PRZYKLAD = 'Podgląd z danymi fikcyjnymi (sklep, imię, adresy i pozycje są przykładowe); z planu tylko numer, kwota i daty.'
export const UWAGA_FIRMA = 'Treść z ustawień firmy i danych zamówienia, tak jak dostałby ją adresat. Bez imienia i adresu klienta; PDF faktury nie jest pobierany.'

const ZRODLO_PRZYKLADOWE: ZrodloPodgladu = {
  kontekst: KONTEKST_PRZYKLADOWY,
  pozycje: DANE_PRZYKLADOWE['brak-platnosci'].pozycje ?? null,
  panel: 'https://panel.example.com',
  uwaga: UWAGA_PRZYKLAD,
}

const str = (v: unknown, d: string) => (typeof v === 'string' && v.trim() ? v : d)
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const date = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v) : null)

// ─── Braki ustawień ──────────────────────────────────────────────────────────

const DANE_FIRMY = 'Ustawienia → Dokumenty i faktury → Dane firmy'
const POCZTA = 'Ustawienia → Komunikacja i poczta → Poczta'

/** Adres zastępczy w miejsce brakującego e-maila (domena .invalid, RFC 2606); w treści podglądu podmieniany na znacznik. */
const ADRES_ZASTEPCZY = 'brak-adresu@uzupelnij.invalid'
const ZNACZNIK_ADRESU = '[brak: adres e-mail]'

/**
 * Kontekst do renderu z brakami: każde brakujące pole dostaje znacznik widoczny w treści, a lista `braki` mówi, gdzie
 * je uzupełnić. Bez tego render padłby na pierwszym braku i podgląd nie pokazałby nic.
 */
export function uzupelnijBraki(k: KontekstMarki, rodzaj: RodzajPlanu): { kontekst: KontekstMarki; braki: string[] } {
  const braki: string[] = []
  const firma = { ...k.firma }
  const sklep = { ...k.sklep }
  const doKlienta = SZABLONY_DOMYSLNE[rodzaj].odbiorca === 'klient'
  if (!firma.adres.some((l) => l.trim())) {
    braki.push(`Stopka maila nie ma adresu firmy. Uzupełnij go w ${DANE_FIRMY}.`)
    firma.adres = ['[brak: adres firmy]']
  }
  if (!firma.email?.trim() && !firma.telefon?.trim()) braki.push(`Stopka maila nie ma e-maila ani telefonu do kontaktu. Uzupełnij je w ${DANE_FIRMY}.`)
  if (!sklep.odpowiedzDo.trim()) {
    if (doKlienta) braki.push(`Klient nie ma adresu, na który może odpisać. Uzupełnij adres nadawcy w ${POCZTA}.`)
    sklep.odpowiedzDo = ADRES_ZASTEPCZY
  }
  if (!doKlienta && !firma.emailBiura?.trim()) {
    braki.push(`Firma nie ma e-maila biura, na który idą maile wewnętrzne. Uzupełnij go w ${DANE_FIRMY} (albo „Adres biura” w ${POCZTA}).`)
    firma.emailBiura = ADRES_ZASTEPCZY
  }
  if (rodzaj === 'gotowe-do-odbioru') {
    const o = sklep.odbiorOsobisty
    const adres = o?.adres?.filter((l) => l.trim()) ?? []
    const godziny = o?.godziny?.filter((l) => l.trim()) ?? []
    if (!adres.length) braki.push(`Sklep „${sklep.nazwa}” nie ma adresu odbioru osobistego. Uzupełnij go w ${POCZTA}, w danych sklepu.`)
    if (!godziny.length) braki.push(`Sklep „${sklep.nazwa}” nie ma godzin odbioru osobistego. Uzupełnij je w ${POCZTA}, w danych sklepu.`)
    if (!adres.length || !godziny.length)
      sklep.odbiorOsobisty = { adres: adres.length ? adres : ['[brak: adres odbioru]'], godziny: godziny.length ? godziny : ['[brak: godziny odbioru]'], uwagi: o?.uwagi ?? null }
  }
  return { kontekst: { firma, sklep }, braki }
}

/** Błąd szablonu (np. zły adres w ustawieniach) jako zdanie dla użytkownika. */
function brakZBledu(b: string): string {
  if (/e-mail|adres do odpowiedzi/i.test(b)) return `Mail nie powstanie: ${b}. Popraw adres w ${DANE_FIRMY} albo w ${POCZTA}.`
  if (/^sklep:/.test(b)) return `Mail nie powstanie: ${b}. Popraw dane sklepu w ${POCZTA}.`
  return `Mail nie powstanie: ${b}. Sprawdź treść w Ustawienia → Komunikacja i poczta → Szablony maili.`
}

// ─── Dane maila ──────────────────────────────────────────────────────────────

/** Dane wejściowe szablonu: zmienne planu i źródło (przykład albo dane firmy). Bez imienia klienta. */
export function daneMaila<R extends RodzajPlanu>(rodzaj: R, vars: Vars, z: ZrodloPodgladu = ZRODLO_PRZYKLADOWE): DaneMaili[R] {
  const nr = z.numerZamowienia?.trim() || str(vars.numerZamowienia, 'SD 00000')
  const przyklad = z.kontekst === KONTEKST_PRZYKLADOWY
  const pozycje = z.pozycje ?? null
  switch (rodzaj) {
    case 'zwrot-przyjety':
    case 'reklamacja-przyjeta':
    case 'zwrot-pieniedzy':
      // zwrócone produkty jak w wysyłce (lib/poczta/wysylka.ts, zwrotPlanu); przykład: pozycje przykładu tego maila
      return { imie: null, numerZamowienia: nr, pozycje: przyklad ? (DANE_PRZYKLADOWE[rodzaj as 'zwrot-przyjety'].pozycje ?? null) : pozycje } as DaneMaili[R]
    case 'brak-platnosci': {
      const d = DANE_PRZYKLADOWE['brak-platnosci']
      // zawsze z datą anulowania z planu (Order.reservationDeadline); bez daty silnik planu nie tworzy
      return {
        imie: null,
        numerZamowienia: nr,
        kwotaGr: num(vars.kwotaGr, d.kwotaGr),
        dniDoAnulowania: num(vars.dniDoAnulowania, d.dniDoAnulowania),
        terminAnulowania: date(vars.terminAnulowania),
        pozycje,
        ...(przyklad ? { linkPlatnosci: d.linkPlatnosci } : {}),
      } as DaneMaili[R]
    }
    case 'nieudana-platnosc': {
      const d = DANE_PRZYKLADOWE['nieudana-platnosc']
      return {
        imie: null,
        numerZamowienia: nr,
        kwotaGr: num(vars.kwotaGr, d.kwotaGr),
        rachunek: przyklad ? (z.rachunek ?? d.rachunek) : (z.rachunek ?? RACHUNEK_ZASTEPCZY),
        ...(z.odbiorcaPrzelewu ? { odbiorcaPrzelewu: z.odbiorcaPrzelewu } : {}),
        ...(z.numerWSklepie ? { numerWSklepie: z.numerWSklepie } : {}),
        terminAnulowania: date(vars.terminAnulowania) ?? d.terminAnulowania,
        towarZwolniony: z.towarZwolniony ?? (przyklad ? d.towarZwolniony : false),
        pozycje,
      } as DaneMaili[R]
    }
    case 'faktura':
      // numer jak w mailu: z programu do faktur; null = program go nie podał, mail bez numeru (lib/poczta/wysylka.ts);
      // brak pola = numer z planu (dane przykładowe albo kopia faktury spoza Kompletora, której mail i tak nie wychodzi)
      return {
        imie: null,
        numerZamowienia: nr,
        numerFaktury: z.numerFaktury === null ? null : z.numerFaktury?.trim() || str(vars.wfirmaDocId, '—'),
        numerPrzesylki: z.numerPrzesylki ?? null,
        linkSledzenia: z.linkSledzenia ?? null,
        pdf: { tresc: PDF_PRZYKLADOWY },
      } as DaneMaili[R]
    case 'gotowe-do-odbioru':
      return { imie: null, numerZamowienia: nr, odbiorDo: null, pozycje } as DaneMaili[R]
    case 'niski-stan':
      return { sku: str(vars.sku, '—'), nazwa: z.nazwaProduktu ?? null, dostepne: num(vars.dostepne, 0), prog: num(vars.prog, 0), linkDoProduktu: null } as DaneMaili[R]
    default:
      return {
        numerZamowienia: nr,
        trescBledu: `Próba ${str(vars.idExternal, '—')} nie wystawiła faktury (treść błędu w panelu zamówienia).`,
        linkDoZamowienia: z.panel ? `${z.panel}/zamowienia${z.idZamowienia ? `/${encodeURIComponent(z.idZamowienia)}` : ''}` : null,
        kiedy: date(vars.kiedy),
      } as DaneMaili[R]
  }
}

/** Rachunek zastępczy w miejsce brakującego (same zera); w treści podglądu podmieniany na znacznik. */
const RACHUNEK_ZASTEPCZY = '00000000000000000000000000'
const RACHUNEK_ZASTEPCZY_W_TRESCI = '00 0000 0000 0000 0000 0000 0000'
const ZNACZNIK_RACHUNKU = '[brak: numer rachunku]'

/** Podgląd akcji planu (każda reguła ma szablon w lib/maile, także niski stan). */
export function podgladAkcji(rule: KluczReguly, vars: Vars, z: ZrodloPodgladu = ZRODLO_PRZYKLADOWE): Podglad {
  const r = REGULY[rule]
  const odbiorca = SZABLONY_DOMYSLNE[r.mail].odbiorca
  // plan „Brak płatności” bez daty anulowania to akcja pominięta (SKIPPED): nie renderujemy wariantu „w ciągu N dni”,
  // którego kontrakt zabrania, nawet w podglądzie
  if (r.mail === 'brak-platnosci' && !date(vars.terminAnulowania))
    return { temat: '—', tekst: '', odbiorca, uwaga: 'Akcja pominięta: brak terminu anulowania, treść nie powstaje (mail bez daty jest niedozwolony).', braki: [] }
  // przypomnienie o płatności po nieudanej płatności online: osobny szablon z danymi do przelewu
  let wariant = r.mail === 'brak-platnosci' ? (z.wariant ?? (vars.wariant === 'nieudana-platnosc' ? 'nieudana-platnosc' : 'brak-platnosci')) : r.mail
  const informacje = [...(z.informacje ?? [])]
  // prawdziwe dane bez rachunku: jak przy wysyłce, zwykły „Brak płatności” i informacja dla biura
  if (wariant === 'nieudana-platnosc' && z.kontekst !== KONTEKST_PRZYKLADOWY && !z.rachunek?.trim()) {
    wariant = 'brak-platnosci'
    informacje.push(`${informacjaBezDanychPrzelewu(['numeru rachunku'])}.`)
  }
  const { kontekst, braki } = uzupelnijBraki(z.kontekst, wariant)
  const wszystkie = [...braki, ...(z.braki ?? [])]
  const info = informacje.length ? { informacje } : {}
  let m: GotowyMail
  try {
    m = renderujMail(wariant, kontekst, daneMaila(wariant, vars, z), { nadpisania: { firma: z.nadpisania ?? null } })
  } catch (e) {
    if (!(e instanceof BladSzablonu)) throw e
    return { temat: '—', tekst: '', odbiorca, uwaga: z.uwaga, braki: [...wszystkie, ...e.bledy.map(brakZBledu)], ...info }
  }
  const bezZastepczych = (s: string) => s.split(ADRES_ZASTEPCZY).join(ZNACZNIK_ADRESU).split(RACHUNEK_ZASTEPCZY_W_TRESCI).join(ZNACZNIK_RACHUNKU)
  return { temat: bezZastepczych(m.temat), tekst: bezZastepczych(m.tekst), odbiorca: m.odbiorca, uwaga: z.uwaga, braki: wszystkie, ...info }
}
