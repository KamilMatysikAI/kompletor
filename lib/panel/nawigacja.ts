// drzewo nawigacji panelu, jedno źródło dla menu bocznego, okruszków i (w paczce) listy ustawień.
// Każdy ekran panelu ma tu węzeł, więc nie ma ekranów osieroconych, a okruszki wynikają z drzewa, nie z ręcznych
// linków „← Wstecz” na ekranach. Plik bez importów serwerowych: czyta go też komponent kliencki (menu, okruszki).
import type { Permission } from '@/lib/auth/uprawnienia'
import { SLOWNIK } from './slownik'
import type { Ton } from './statusy'

/** klucz ikony 18 px przy pozycji menu (`app/(panel)/_komponenty/ikony-menu.tsx`). */
export type IkonaMenu = 'pulpit' | 'zamowienia' | 'pakowanie' | 'przesylki' | 'zwroty' | 'faktury' | 'raporty' | 'braki' | 'produkty' | 'ustawienia' | 'przeprowadzka' | 'porownanie' | 'maile' | 'pomoc'

/**
 * (R4 z przeglądu TwojOMS): działy ustawień. Ekrany ustawień nie są już podpozycjami menu bocznego
 * ani listą na stronie-spisie: druga kolumna pokazuje działy, a w dziale zakładki (podstrony). Kolejność = kolejność
 * kolumny; zakładki w dziale w kolejności drzewa. `bl` tylko dla firmy z BaseLinkerem (jak sekcja menu).
 */
export type DzialUstawien = 'sprzedaz' | 'magazyn' | 'wysylka' | 'dokumenty' | 'komunikacja' | 'zespol' | 'integracje' | 'bl'

export const DZIALY_USTAWIEN: readonly { klucz: DzialUstawien; nazwa: string; opis: string }[] = [
  { klucz: 'sprzedaz', nazwa: SLOWNIK.dzialSprzedaz, opis: 'Sklepy, statusy zamówień, automatyczne akcje.' },
  { klucz: 'magazyn', nazwa: SLOWNIK.dzialMagazyn, opis: 'Strefy magazynu i rezerwacje towaru.' },
  { klucz: 'wysylka', nazwa: SLOWNIK.dzialWysylka, opis: 'Przewoźnicy, godziny odbioru, drukarki.' },
  { klucz: 'dokumenty', nazwa: SLOWNIK.dzialDokumenty, opis: 'Dane firmy, program do faktur, numeracja i KSeF.' },
  { klucz: 'komunikacja', nazwa: SLOWNIK.dzialKomunikacja, opis: 'Poczta firmy, szablony maili, alerty dla zespołu.' },
  { klucz: 'zespol', nazwa: SLOWNIK.dzialZespol, opis: 'Osoby i uprawnienia, dane klientów, Twoje hasło.' },
  { klucz: 'integracje', nazwa: SLOWNIK.dzialIntegracje, opis: 'Co jest podłączone, klucze API, asystent AI.' },
  { klucz: 'bl', nazwa: SLOWNIK.przejscieZBl, opis: 'Wynik przeniesienia danych z BaseLinkera.' },
]

export interface WezelNawigacji {
  href: string
  etykieta: string
  /** uprawnienie wymagane do zobaczenia pozycji w menu (ekran i tak sprawdza je sam) */
  uprawnienie?: Permission
  /** pozycja tylko dla firmy, która ma podłączony BaseLinker (sekcja „Przejście z BaseLinkera”) */
  tylkoZBl?: boolean
  /** licznik przy pozycji: klucz w `LicznikiMenu` */
  licznik?: keyof LicznikiMenu
  /**
   * dział ustawień, w którym ekran jest zakładką (druga kolumna ustawień). Węzeł z działem pod „Ustawieniami”
   * nie jest podpozycją menu bocznego; okruszki dalej idą z drzewa.
   */
  dzial?: DzialUstawien
  /** węzeł tylko dla okruszków (ekran pomocniczy, np. „Dodaj produkt”), bez pozycji w menu */
  bezMenu?: boolean
  /** ikona pozycji w menu bocznym (tylko pozycje główne) */
  ikona?: IkonaMenu
  /** podpozycje w menu budowane z danych (statusy zamówień z licznikami), nie z drzewa */
  podmenu?: 'statusy'
  dzieci?: WezelNawigacji[]
}

export interface LicznikiMenu {
  zamowienia: number
  braki: number
}

export type KluczSekcji = 'start' | 'zamowienia' | 'magazyn' | 'finanse' | 'ustawienia' | 'bl'

/**
 * Sekcje menu (R1 z przeglądu TwojOMS; układ grup): grupy z małym nagłówkiem, kolejność =
 * kolejność w menu i rytm dnia: Realizacja (zamówienie → paczka → zwrot), Towar (katalog i braki), Finanse (faktury,
 * raporty). Pulpit oraz Ustawienia z Pomocą bez nagłówka grupy; „Przejście z BaseLinkera” tylko dla firmy z BL. Firma, gęstość, hasło, Pomoc
 * i Wyloguj nie są w menu bocznym: menu konta w górnym pasku (`_komponenty/pasek-gorny.tsx`).
 */
const POMOC_WEZEL: WezelNawigacji = { href: '/pomoc', etykieta: 'Pomoc', ikona: 'pomoc' }

export const NAWIGACJA: { sekcja: KluczSekcji; tytul?: string; wezly: WezelNawigacji[] }[] = [
  { sekcja: 'start', wezly: [{ href: '/pulpit', etykieta: 'Pulpit', ikona: 'pulpit' }] },
  {
    sekcja: 'zamowienia',
    tytul: SLOWNIK.grupaRealizacja,
    wezly: [
      {
        href: '/zamowienia',
        etykieta: 'Zamówienia',
        ikona: 'zamowienia',
        licznik: 'zamowienia',
        // w menu pod „Zamówieniami” statusy z licznikami (dawny panel statusów listy)
        podmenu: 'statusy',
        dzieci: [{ href: '/zamowienia/nowe', etykieta: 'Dodaj zamówienie', uprawnienie: 'zamowienia.dodawanie', bezMenu: true }],
      },
      {
        href: '/pakowanie',
        etykieta: 'Pakowanie',
        ikona: 'pakowanie',
        // ekrany pomocnicze pakowania otwierane przyciskami z kolejki (bez nowych pozycji w menu)
        dzieci: [
          { href: '/pakowanie/koszyki', etykieta: 'Koszyki', uprawnienie: 'pakowanie.stanowisko', bezMenu: true },
          { href: '/pakowanie/zbieranie', etykieta: 'Lista zbierania', uprawnienie: 'pakowanie.stanowisko', bezMenu: true },
        ],
      },
      // lista przesyłek ze wszystkich przewoźników (grupa wysyłki: po pakowaniu), samodzielny moduł codziennej pracy
      { href: '/przesylki', etykieta: 'Przesyłki', ikona: 'przesylki' },
      { href: '/zwroty', etykieta: SLOWNIK.zwroty, ikona: 'zwroty', dzieci: [{ href: '/zwroty/nowy', etykieta: 'Stwórz zwrot', uprawnienie: 'zwroty.przyjecie', bezMenu: true }] },
    ],
  },
  {
    sekcja: 'magazyn',
    tytul: SLOWNIK.grupaTowar,
    wezly: [
      {
        href: '/produkty',
        etykieta: SLOWNIK.produkty,
        ikona: 'produkty',
        dzieci: [
          { href: '/produkty/bez-stanu', etykieta: SLOWNIK.produktyBezStanu, uprawnienie: 'produkty.dodawanie' },
          { href: '/produkty/nowy', etykieta: 'Dodaj produkt', uprawnienie: 'produkty.dodawanie', bezMenu: true },
          { href: '/produkty/csv', etykieta: 'Import i eksport CSV', uprawnienie: 'produkty.dodawanie', bezMenu: true },
          // przycisk na liście produktów, bez pozycji w menu
          { href: '/produkty/zdjecia-z-feedu', etykieta: 'Zdjęcia z feedu', uprawnienie: 'produkty.dodawanie', bezMenu: true },
          // raporty „Przygotuj oferty”, przycisk na liście produktów, bez pozycji w menu
          { href: '/produkty/przygotowanie-ofert', etykieta: 'Przygotowane oferty', uprawnienie: 'produkty.dodawanie', bezMenu: true },
        ],
      },
      { href: '/braki', etykieta: SLOWNIK.brakiTowaru, ikona: 'braki', licznik: 'braki' },
    ],
  },
  // pieniądze osobno od codziennej realizacji (faktury biura, raporty sprzedaży i marży)
  {
    sekcja: 'finanse',
    tytul: SLOWNIK.grupaFinanse,
    wezly: [
      // faktury i korekty ze wszystkich programów (jak „Faktury i paragony” w BL), samodzielny moduł codziennej pracy biura
      { href: '/faktury', etykieta: 'Faktury', ikona: 'faktury', uprawnienie: 'zamowienia.faktury' },
      // raporty sprzedaży (okres, kanał, produkt, marża, eksport XLSX)
      { href: '/raporty', etykieta: 'Raporty', uprawnienie: 'raporty.sprzedaz', ikona: 'raporty' },
    ],
  },
  {
    sekcja: 'bl',
    tytul: SLOWNIK.przejscieZBl,
    wezly: [
      { href: '/ustawienia/przeprowadzka', etykieta: SLOWNIK.przeprowadzka, ikona: 'przeprowadzka', uprawnienie: 'ustawienia', tylkoZBl: true, dzial: 'bl' },
      { href: '/rozjazdy', etykieta: SLOWNIK.porownanieZBl, ikona: 'porownanie', uprawnienie: 'rozjazdy.podglad', tylkoZBl: true },
      { href: '/akcje', etykieta: SLOWNIK.maileDoKlientow, ikona: 'maile', tylkoZBl: true },
    ],
  },
  {
    sekcja: 'ustawienia',
    wezly: [
      {
        href: '/ustawienia',
        etykieta: 'Ustawienia',
        ikona: 'ustawienia',
        // adresy ekranów bez zmian (linki z Pomocy, maili i onboardingu), zmienia się tylko miejsce w
        // nawigacji: dział (druga kolumna ustawień) i zakładka w nim, w kolejności tej listy
        dzieci: [
          {
            href: '/ustawienia/kanaly',
            etykieta: 'Kanały sprzedaży',
            uprawnienie: 'ustawienia',
            dzial: 'sprzedaz',
            dzieci: [{ href: '/ustawienia/kanaly/nowy', etykieta: 'Dodaj sklep', uprawnienie: 'ustawienia', bezMenu: true }],
          },
          // statusy zamówień firmy (nazwy, kolory, grupy panelu listy, mapowanie etapu)
          { href: '/ustawienia/statusy', etykieta: 'Statusy zamówień', uprawnienie: 'ustawienia', dzial: 'sprzedaz' },
          // automatyczne akcje firmy (zdarzenie → warunki → kroki, przyciski), jak w BaseLinkerze
          {
            href: '/ustawienia/automaty',
            etykieta: 'Automatyczne akcje',
            uprawnienie: 'ustawienia',
            dzial: 'sprzedaz',
            // „Wczytaj szablon” — przycisk w nagłówku ekranu, bez pozycji w menu
            dzieci: [{ href: '/ustawienia/automaty/szablony', etykieta: 'Wczytaj szablon', uprawnienie: 'ustawienia', bezMenu: true }],
          },
          // strefy magazynu firmy (filtry pakowania)
          { href: '/ustawienia/strefy', etykieta: 'Strefy magazynu', uprawnienie: 'ustawienia', dzial: 'magazyn' },
          { href: '/ustawienia/rezerwacje', etykieta: 'Zasady rezerwacji', uprawnienie: 'ustawienia', dzial: 'magazyn' },
          {
            href: '/ustawienia/przewoznicy',
            etykieta: 'Przewoźnicy',
            uprawnienie: 'ustawienia',
            dzial: 'wysylka',
            // klucze i ustawienia kont przewoźników — przycisk na ekranie Przewoźników, bez własnej zakładki
            dzieci: [{ href: '/ustawienia/przewoznicy/konta', etykieta: 'Konta przewoźników', uprawnienie: 'ustawienia', bezMenu: true }],
          },
          { href: '/ustawienia/druk', etykieta: 'Druk', uprawnienie: 'ustawienia', dzial: 'wysylka' },
          { href: '/ustawienia/firma', etykieta: 'Dane firmy', uprawnienie: 'ustawienia', dzial: 'dokumenty' },
          { href: '/ustawienia/dokumenty', etykieta: 'Dokumenty sprzedaży', uprawnienie: 'ustawienia', dzial: 'dokumenty' },
          // poczta firmy (SMTP, nadawca per sklep, mail próbny); szablony to zakładka działu
          {
            href: '/ustawienia/poczta',
            etykieta: 'Poczta',
            uprawnienie: 'ustawienia',
            dzial: 'komunikacja',
            dzieci: [{ href: '/ustawienia/poczta/szablony', etykieta: 'Szablony maili', uprawnienie: 'ustawienia', dzial: 'komunikacja' }],
          },
          { href: '/ustawienia/powiadomienia', etykieta: 'Powiadomienia', uprawnienie: 'ustawienia', dzial: 'komunikacja' },
          { href: '/ustawienia/uzytkownicy', etykieta: 'Użytkownicy i uprawnienia', uprawnienie: 'uzytkownicy', dzial: 'zespol' },
          { href: '/ustawienia/dane-klientow', etykieta: 'Dane klientów', uprawnienie: 'ustawienia', dzial: 'zespol' },
          { href: '/ustawienia/haslo', etykieta: 'Zmiana hasła', dzial: 'zespol' },
          // (R13): wszystkie połączenia na jednej liście ze stanem; szczegóły na podstronach
          { href: '/ustawienia/integracje', etykieta: 'Integracje', uprawnienie: 'ustawienia', dzial: 'integracje' },
          { href: '/ustawienia/klucze-api', etykieta: 'Klucze API', uprawnienie: 'ustawienia', dzial: 'integracje' },
          { href: '/ustawienia/agenci-ai', etykieta: 'Agenci AI', uprawnienie: 'ustawienia', dzial: 'integracje' },
        ],
      },
      // Pomoc stale widoczna na dole menu (wcześniej tylko w menu konta)
      POMOC_WEZEL,
    ],
  },
]

export interface ZakladkaUstawien {
  href: string
  etykieta: string
}

export interface DzialWidok {
  klucz: DzialUstawien
  nazwa: string
  opis: string
  /** adres działu = pierwsza zakładka, którą osoba widzi */
  href: string
  zakladki: ZakladkaUstawien[]
}

function* wezlyZDzialem(w: readonly WezelNawigacji[]): Generator<WezelNawigacji> {
  for (const x of w) {
    if (x.dzial) yield x
    if (x.dzieci) yield* wezlyZDzialem(x.dzieci)
  }
}

/**
 * Działy ustawień dla osoby: zakładki = ekrany z `dzial` z całego drzewa (także „Przeprowadzka” z sekcji
 * BL), tylko z uprawnieniem i tylko z BL, gdy firma go ma. Dział bez żadnej widocznej zakładki znika (np. Magazyn bez
 * uprawnienia ustawień widzi tylko „Zespół i dostęp” z własnym hasłem).
 */
export function dzialyUstawien(p: { uprawnienia: ReadonlySet<string>; maBl: boolean }): DzialWidok[] {
  const widoczny = (w: WezelNawigacji) => (!w.uprawnienie || p.uprawnienia.has(w.uprawnienie)) && (!w.tylkoZBl || p.maBl)
  const wezly = [...wezlyZDzialem(NAWIGACJA.flatMap((s) => s.wezly))].filter(widoczny)
  return DZIALY_USTAWIEN.flatMap((d) => {
    const zakladki = wezly.filter((w) => w.dzial === d.klucz).map((w) => ({ href: w.href, etykieta: w.etykieta }))
    return zakladki.length ? [{ ...d, href: zakladki[0]!.href, zakladki }] : []
  })
}

/** Dział i zakładka dla adresu: najdłuższe dopasowanie zakładki (konto kanału → „Kanały sprzedaży”); spoza działów = null. */
export function dzialDla(dzialy: readonly DzialWidok[], sciezka: string): { dzial: DzialUstawien; zakladka: string } | null {
  let best: { dzial: DzialUstawien; zakladka: string } | null = null
  for (const d of dzialy) for (const z of d.zakladki) if (pasuje(sciezka, z.href) && (!best || z.href.length > best.zakladka.length)) best = { dzial: d.klucz, zakladka: z.href }
  return best
}

/** Dokąd prowadzi samo „/ustawienia”: pierwsza zakładka pierwszego widocznego działu (każdy ma co najmniej hasło). */
export function pierwszyAdresUstawien(p: { uprawnienia: ReadonlySet<string>; maBl: boolean }): string {
  return dzialyUstawien(p)[0]?.href ?? '/ustawienia/haslo'
}

/** Pomoc: pozycja na dole menu bocznego i link w menu konta; ten sam węzeł co w `NAWIGACJA`. */
export const POMOC: WezelNawigacji = POMOC_WEZEL

function* wszystkie(w: WezelNawigacji[], rodzice: WezelNawigacji[] = []): Generator<{ w: WezelNawigacji; rodzice: WezelNawigacji[] }> {
  for (const x of w) {
    yield { w: x, rodzice }
    if (x.dzieci) yield* wszystkie(x.dzieci, [...rodzice, x])
  }
}

function wszystkieWezly(): { w: WezelNawigacji; rodzice: WezelNawigacji[] }[] {
  return NAWIGACJA.flatMap((s) => [...wszystkie(s.wezly)])
}

function pasuje(sciezka: string, href: string): boolean {
  return sciezka === href || sciezka.startsWith(`${href}/`)
}

/** Najgłębszy węzeł drzewa, w którym leży ścieżka (np. `/zamowienia/abc` → Zamówienia). */
export function wezelDla(sciezka: string): { w: WezelNawigacji; rodzice: WezelNawigacji[] } | null {
  let best: { w: WezelNawigacji; rodzice: WezelNawigacji[] } | null = null
  for (const x of wszystkieWezly()) {
    if (pasuje(sciezka, x.w.href) && (!best || x.w.href.length > best.w.href.length)) best = x
  }
  return best
}

export interface Okruszek {
  href: string
  etykieta: string
}

/**
 * Okruszki dla ścieżki: przodkowie węzła ekranu, a gdy ścieżka leży głębiej niż węzeł (karta zamówienia, karta
 * produktu, konto kanału), także sam węzeł. Bieżący ekran nie jest okruszkiem (jego nazwa to nagłówek strony).
 * Ekrany z górnego poziomu (Pulpit, Zamówienia…) nie mają okruszków.
 */
export function okruszki(sciezka: string): Okruszek[] {
  const x = wezelDla(sciezka)
  if (!x) return []
  const lancuch = sciezka === x.w.href ? x.rodzice : [...x.rodzice, x.w]
  return lancuch.map((w) => ({ href: w.href, etykieta: w.etykieta }))
}

/**
 * Okruszki górnego paska (R2): przodkowie i bieżący ekran. `biezacy` to nazwa ekranu z drzewa albo null,
 * gdy adres leży głębiej niż węzeł (karta zamówienia, karta produktu): wtedy ostatni okruszek jest linkiem powrotu,
 * a nazwę rekordu niesie nagłówek strony.
 */
export function okruszkiPaska(sciezka: string): { lancuch: Okruszek[]; biezacy: string | null } {
  const x = wezelDla(sciezka)
  if (!x) return { lancuch: [], biezacy: null }
  return { lancuch: okruszki(sciezka), biezacy: sciezka === x.w.href ? x.w.etykieta : null }
}

export interface PozycjaMenu {
  href: string
  etykieta: string
  ikona?: IkonaMenu
  licznik?: number
  licznikTon?: 'neutralny' | 'ostrzezenie' | 'blad'
  /** kolorowa kropka statusu (ton etapu); `kolor` = kolor statusu własnego firmy */
  kropka?: Ton
  kolor?: string
  /**
   * pozycja-widok listy zamówień: aktywna po parametrach adresu (`widok`, `przewoznik` też status firmy
   * `sf` i grupa statusów `sg`), nie po samej ścieżce
   */
  widok?: { widok: string; przewoznik?: string; sf?: string; sg?: string }
  /**
   * pełna nazwa, gdy `etykieta` w menu jest skrócona (status w grupie bez powtórzonej nazwy grupy, przeglądu
   * rebase 09.11: „Do realizacji Paczkomaty” pod „Do realizacji” → „Paczkomaty”); idzie do `title` i czytnika ekranu
   */
  pelnaNazwa?: string
  /**
   * grupa statusów firmy w menu: zwinięta do jednej linii z sumą, rozwija się po wybraniu jej albo jej statusu
   * i przyciskiem obok. Rozwinięcie przyciskiem przeglądarka pamięta (`localStorage`), chyba że grupa jest „zawsze zwinięta”
   * w ustawieniach statusów (`zwinietaNaStart`): wtedy przy każdym wejściu startuje zwinięta.
   */
  grupaStatusow?: { klucz: string; zwinietaNaStart: boolean }
  /** nagłówek bez linku z zawsze widocznymi podpozycjami („Bez statusu firmy”) */
  naglowek?: boolean
  /** link pomocniczy („Ustaw statusy”): nie zaznacza się jako bieżąca pozycja */
  pomocniczy?: boolean
  dzieci: PozycjaMenu[]
}

export interface SekcjaMenu {
  sekcja: KluczSekcji
  tytul?: string
  pozycje: PozycjaMenu[]
}

/**
 * Menu dla osoby: pozycje wg uprawnień, sekcja BL tylko przy firmie z BaseLinkerem, liczniki z bazy. Liczniki szare
 * (R1: czerwień zostaje dla rzeczy po terminie). `statusyZamowien` (z `lib/panel/menu-statusy.ts`) to
 * podpozycje węzła z `podmenu: 'statusy'`.
 */
export function zbudujMenu(p: { uprawnienia: ReadonlySet<string>; maBl: boolean; liczniki: LicznikiMenu; statusyZamowien?: PozycjaMenu[] }): SekcjaMenu[] {
  const widoczny = (w: WezelNawigacji) => !w.bezMenu && (!w.uprawnienie || p.uprawnienia.has(w.uprawnienie)) && (!w.tylkoZBl || p.maBl)
  const pozycja = (w: WezelNawigacji): PozycjaMenu => {
    const n = w.licznik ? p.liczniki[w.licznik] : 0
    return {
      href: w.href,
      etykieta: w.etykieta,
      ...(w.ikona ? { ikona: w.ikona } : {}),
      ...(n > 0 ? { licznik: n, licznikTon: 'neutralny' as const } : {}),
      // ekrany ustawień (węzły z działem) mają drugą kolumnę ustawień, nie podpozycje menu bocznego
      dzieci: w.podmenu === 'statusy' ? (p.statusyZamowien ?? []) : (w.dzieci ?? []).filter((d) => widoczny(d) && !d.dzial).map(pozycja),
    }
  }
  return NAWIGACJA.map((s) => ({ sekcja: s.sekcja, ...(s.tytul ? { tytul: s.tytul } : {}), pozycje: s.wezly.filter(widoczny).map(pozycja) })).filter((s) => s.pozycje.length > 0)
}

/**
 * Pozycja menu zaznaczona dla ścieżki (najdłuższe dopasowanie wśród widocznych pozycji i ich dzieci). Pozycje-widoki
 * listy zamówień (`widok`) wygrywają, gdy adres to sama lista z tym widokiem i przewoźnikiem (brak `widok` = „Wymaga
 * działania”, jak na liście); stare widoki z pulpitu (np. `nieoplacone`) zaznaczają „Zamówienia”. Gdy adres ma
 * przewoźnika, którego menu nie pokazuje jako dziecka (filtr „Przewoźnik” na liście, status jednego przewoźnika,
 * przewoźnik z zerem), zaznacza się pozycja bez przewoźnika: status, grupa albo widok (przeglądu rebase 09.11).
 */
export function aktywnaPozycja(menu: SekcjaMenu[], sciezka: string, zapytanie?: { get(k: string): string | null } | null): string | null {
  let best: string | null = null
  const widokowe: (NonNullable<PozycjaMenu['widok']> & { href: string })[] = []
  // domyślny widok listy = „Wszystkie” (`WIDOK_DOMYSLNY` w zamowienia-lista.ts; tu literał, bo plik jest bez importów serwerowych)
  const w = zapytanie?.get('widok') || 'wszystkie'
  const c = zapytanie?.get('przewoznik') || undefined
  const sf = zapytanie?.get('sf') || undefined
  // jak `filtryZ`: grupa statusów liczy się tylko bez statusu
  const sg = sf ? undefined : zapytanie?.get('sg') || undefined
  const visit = (p: PozycjaMenu) => {
    if (p.pomocniczy || p.naglowek) {
      // link pomocniczy i nagłówek nie są bieżącą pozycją
    } else if (p.widok) {
      widokowe.push({ ...p.widok, href: p.href })
    } else if (pasuje(sciezka, p.href) && (!best || p.href.length > best.length)) best = p.href
    p.dzieci.forEach(visit)
  }
  menu.forEach((s) => s.pozycje.forEach(visit))
  if (sciezka !== '/zamowienia') return best
  const dopasuj = (przewoznik: string | undefined) => widokowe.find((x) => x.widok === w && x.przewoznik === przewoznik && x.sf === sf && x.sg === sg)?.href
  // dokładne dopasowanie z przewoźnikiem ma pierwszeństwo (dziecko-przewoźnik wygrywa z rodzicem)
  return dopasuj(c) ?? (c ? dopasuj(undefined) : undefined) ?? best
}

/** Wszystkie adresy z drzewa (do testu „każdy ekran ma miejsce w nawigacji”). */
export function adresyWDrzewie(): string[] {
  return wszystkieWezly().map((x) => x.w.href)
}
