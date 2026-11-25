// (R3 z przeglądu TwojOMS 08.11): statusy zamówień jako podpozycje „Zamówienia” w menu bocznym,
// zamiast panelu 250 px na liście. Te same grupy (`GRUPY_PANELU`) i te same liczniki (`licznikiPanelu`, jedno
// zapytanie groupBy), inna prezentacja: kolorowa kropka statusu i licznik, a pod aktywnym statusem z kolejką magazynu
// przewoźnicy (kolejka jednego kuriera, jak dotąd). Czysta funkcja (bez bazy): layout podaje liczniki, test sprawdza wynik.
// Kolor kropki: ton etapu statusu (`lib/panel/statusy.ts`).
// Firma ze statusami własnymi (Ustawienia → Statusy zamówień; także neutralny zestaw nowej firmy) widzi tu
// swoje grupy i statusy z kropką w kolorze statusu (`PozycjaMenu.kolor`) i licznikiem z `licznikiPanelu().firmy`
// (te same liczniki co dawny panel listy), sekcję „Bez statusu firmy” i link „Ustaw statusy”. Adresy jak w
// dawnym panelu: status `?widok=wszystkie&sf=<klucz>`, grupa `?widok=wszystkie&sg=<klucz>`.
import type { Carrier } from '@prisma/client'
import { CARRIER_LABEL } from './format'
import type { PozycjaMenu } from './nawigacja'
import { isKolorStatusu, KOLORY_STATUSOW, kluczRdzenia, STATUS_ZAMOWIENIA, STATUSY_RDZENIA, statusZamowienia, type StatusFirmyT } from './statusy'
import { GRUPY_PANELU, nazwaWidoku, PRZEWOZNICY, type KluczGrupy, type LicznikiPanelu, type Widok } from './zamowienia-lista'

/** Adres widoku listy (bez filtrów; menu po stronie przeglądarki dokleja bieżącą wyszukiwarkę i filtry). */
export function adresWidoku(widok: KluczGrupy | 'po_terminie', przewoznik?: Carrier): string {
  // `widok` zawsze jawnie (także domyślny „wszystkie”): adres pozycji różni się od adresu „Zamówienia” (klucz i zaznaczenie w menu)
  const p = new URLSearchParams({ widok })
  if (przewoznik) p.set('przewoznik', przewoznik)
  return `/zamowienia?${p.toString()}`
}

/**
 * Podpozycje „Zamówienia”: najpierw „Wszystkie” i „Wymaga działania” (bez kropki), potem grupy statusów w kolejności
 * pracy magazynu, z kropką w kolorze statusu. `kolory` (klucz grupy → kolor CSS) to punkt podpięcia statusów własnych
 * firmy; bez niego kropka bierze ton etapu. Licznik zero zostaje widoczny (jak w dotychczasowym panelu),
 * żeby lista statusów nie skakała. „Wszystkie” jest bez licznika.
 */
export function pozycjeStatusow(l: LicznikiPanelu, o: { kolory?: Partial<Record<KluczGrupy, string>>; ustawienia?: boolean } = {}): PozycjaMenu[] {
  if (l.firmy) return pozycjeStatusowFirmy(l, o)
  const kolejnosc: KluczGrupy[] = ['wszystkie', 'wymaga', ...GRUPY_PANELU.map((g) => g.klucz).filter((k) => k !== 'wymaga' && k !== 'wszystkie')]
  const pozycje = kolejnosc.map((klucz): PozycjaMenu => {
    const g = GRUPY_PANELU.find((x) => x.klucz === klucz)!
    const n = l.grupy[klucz] ?? 0
    const per = g.perPrzewoznik ? (l.przewoznicy[klucz] ?? {}) : {}
    const przewoznicy = PRZEWOZNICY.filter((c) => (per[c] ?? 0) > 0).map(
      (c): PozycjaMenu => ({
        href: adresWidoku(klucz, c),
        etykieta: CARRIER_LABEL[c],
        licznik: per[c]!,
        licznikTon: 'neutralny',
        widok: { widok: klucz, przewoznik: c },
        dzieci: [],
      }),
    )
    const kropka = g.statusy ? statusZamowienia(g.statusy[0]!).ton : undefined
    return {
      href: adresWidoku(klucz),
      etykieta: g.etykieta,
      // „Wszystkie” bez licznika (licznik nic nie mówi i przeszkadza); reszta z licznikiem
      ...(klucz === 'wszystkie'
        ? {}
        : {
            licznik: n,
            // „Wymaga działania” > 0 to jedyny licznik w tonie ostrzeżenia (jak w panelu); reszta szara
            licznikTon: klucz === 'wymaga' && n > 0 ? ('ostrzezenie' as const) : ('neutralny' as const),
          }),
      widok: { widok: klucz },
      ...(kropka ? { kropka } : {}),
      ...(o.kolory?.[klucz] ? { kolor: o.kolory[klucz] } : {}),
      dzieci: bezPowtorzeniaRodzica(przewoznicy, n),
    }
  })
  // „Po terminie” zaraz pod „Wszystkie” i „Wymaga działania” (w tej kolejności)
  return [...pozycje.slice(0, 2), ...poTerminie(l), ...pozycje.slice(2), ...(o.ustawienia ? [USTAW_STATUSY] : [])]
}

/**
 * (R9 przeglądu TwojOMS): „Po terminie” = zamówienia, których planowany dzień wysyłki minął (lib/panel/termin-wysylki.ts).
 * Tylko u firmy z aktywnym harmonogramem odbiorów (Ustawienia → Przewoźnicy); licznik czerwony, gdy coś jest po terminie
 * (R1: czerwień tylko dla rzeczy po terminie).
 */
function poTerminie(l: LicznikiPanelu): PozycjaMenu[] {
  if (l.poTerminie === undefined) return []
  return [{ href: adresWidoku('po_terminie'), etykieta: 'Po terminie', licznik: l.poTerminie, licznikTon: l.poTerminie > 0 ? 'blad' : 'neutralny', widok: { widok: 'po_terminie' }, dzieci: [] }]
}

/** Link do ekranu statusów (osoba z uprawnieniem `ustawienia`): pozycja pomocnicza, nie zaznacza się w menu. */
const USTAW_STATUSY: PozycjaMenu = { href: '/ustawienia/statusy', etykieta: 'Ustaw statusy', pomocniczy: true, dzieci: [] }

/** Adres statusu (`sf`) albo grupy (`sg`) firmy, jak w dawnym panelu: widok „Wszystkie” plus klucz. */
export function adresStatusuFirmy(o: { sf?: string; sg?: string; przewoznik?: Carrier }): string {
  const p = new URLSearchParams({ widok: 'wszystkie' })
  if (o.sf) p.set('sf', o.sf)
  if (o.sg) p.set('sg', o.sg)
  if (o.przewoznik) p.set('przewoznik', o.przewoznik)
  return `/zamowienia?${p.toString()}`
}

/**
 * Nazwa statusu w menu pod grupą bez powtórzonej nazwy grupy (przeglądu rebase 09.11): „Do realizacji Paczkomaty”
 * pod „Do realizacji” → „Paczkomaty”, „Do realizacji – DPD” → „DPD”. Status nazwany jak grupa, nazwa bez prefiksu albo
 * prefiks w środku słowa („Do realizacjii”) zostają bez zmian. Pierwsza litera reszty wielka.
 */
export function bezNazwyGrupy(nazwa: string, grupa: string): string {
  const g = grupa.trim()
  if (!g || nazwa.length <= g.length || nazwa.slice(0, g.length).toLocaleLowerCase('pl') !== g.toLocaleLowerCase('pl')) return nazwa
  const m = /^[\s:·–—-]+(.+)$/u.exec(nazwa.slice(g.length))
  if (!m) return nazwa
  const r = m[1]!.trim()
  return r.charAt(0).toLocaleUpperCase('pl') + r.slice(1)
}

/**
 * Pojedynczy przewoźnik pod statusem z tym samym licznikiem co status nic nie dodaje (przeglądu rebase 09.11):
 * pomijamy go. Adres z tym przewoźnikiem (filtr na liście) dalej zaznacza status (`aktywnaPozycja`, drugi przebieg).
 */
function bezPowtorzeniaRodzica(dzieci: PozycjaMenu[], licznikRodzica: number): PozycjaMenu[] {
  return dzieci.length === 1 && dzieci[0]!.licznik === licznikRodzica ? [] : dzieci
}

/** Etapy z kolejką magazynu (pod nimi przewoźnicy), z `GRUPY_PANELU`. */
const ETAPY_Z_PRZEWOZNIKAMI = new Set(GRUPY_PANELU.filter((g) => g.perPrzewoznik).flatMap((g) => g.statusy ?? []))

/**
 * Menu statusów firmy (w menu): „Wszystkie”, „Wymaga działania”, statusy bez grupy, grupy (link do
 * całej grupy z sumą, pod nią statusy; grupa zwinięta w ustawieniach rozwija się dopiero po wybraniu), „Bez statusu
 * firmy” (zamówienia, do których nie pasuje żaden status) i „Ustaw statusy”. Ukryty status widać tylko, gdy ma
 * zamówienia. Pod aktywnym statusem z kolejką magazynu, który nie jest przypisany do jednego przewoźnika: przewoźnicy.
 */
function pozycjeStatusowFirmy(l: LicznikiPanelu, o: { ustawienia?: boolean }): PozycjaMenu[] {
  const f = l.firmy!
  const ile = (k: string) => f.ile[k] ?? 0
  const przewoznicyStatusu = (klucz: string, d: Pick<StatusFirmyT, 'baseStatus' | 'carriers'>): PozycjaMenu[] => {
    if (!ETAPY_Z_PRZEWOZNIKAMI.has(d.baseStatus) || d.carriers.length === 1) return []
    const per = f.przewoznicy[klucz] ?? {}
    return PRZEWOZNICY.filter((c) => (per[c] ?? 0) > 0).map((c) => ({
      href: adresStatusuFirmy({ sf: klucz, przewoznik: c }),
      etykieta: CARRIER_LABEL[c],
      licznik: per[c]!,
      licznikTon: 'neutralny' as const,
      widok: { widok: 'wszystkie', sf: klucz, przewoznik: c },
      dzieci: [],
    }))
  }
  const pozycja = (d: Pick<StatusFirmyT, 'key' | 'name' | 'color' | 'baseStatus' | 'carriers'>, grupa?: string): PozycjaMenu => {
    const krotka = grupa ? bezNazwyGrupy(d.name, grupa) : d.name
    const n = ile(d.key)
    return {
      href: adresStatusuFirmy({ sf: d.key }),
      etykieta: krotka,
      ...(krotka !== d.name ? { pelnaNazwa: d.name } : {}),
      licznik: n,
      licznikTon: 'neutralny',
      widok: { widok: 'wszystkie', sf: d.key },
      kropka: 'neutralny',
      kolor: KOLORY_STATUSOW[isKolorStatusu(d.color) ? d.color : 'szary'].tekst,
      dzieci: bezPowtorzeniaRodzica(przewoznicyStatusu(d.key, d), n),
    }
  }
  const widoczne = f.statusy.filter((s) => s.active || ile(s.key) > 0)
  const bezGrupy = widoczne.filter((s) => !s.groupKey || !f.grupy.some((g) => g.key === s.groupKey))
  const grupy = f.grupy.flatMap((g): PozycjaMenu[] => {
    const w = widoczne.filter((s) => s.groupKey === g.key)
    if (!w.length) return []
    return [
      {
        href: adresStatusuFirmy({ sg: g.key }),
        etykieta: g.name,
        licznik: w.reduce((n, s) => n + ile(s.key), 0),
        licznikTon: 'neutralny',
        widok: { widok: 'wszystkie', sg: g.key },
        grupaStatusow: { klucz: g.key, zwinietaNaStart: g.collapsed },
        dzieci: w.map((s) => pozycja(s, g.name)),
      },
    ]
  })
  const reszta = STATUSY_RDZENIA.filter((s) => ile(kluczRdzenia(s)) > 0)
  const bez: PozycjaMenu[] = reszta.length
    ? [
        {
          href: '#bez-statusu-firmy',
          etykieta: 'Bez statusu firmy',
          naglowek: true,
          dzieci: reszta.map((s) => pozycja({ key: kluczRdzenia(s), name: STATUS_ZAMOWIENIA[s].etykieta, color: 'szary', baseStatus: s, carriers: [] })),
        },
      ]
    : []
  const wymaga = l.grupy.wymaga
  return [
    // „Wszystkie” bez licznika (jak w `pozycjeStatusow`)
    { href: adresWidoku('wszystkie'), etykieta: 'Wszystkie', widok: { widok: 'wszystkie' }, dzieci: [] },
    { href: adresWidoku('wymaga'), etykieta: 'Wymaga działania', licznik: wymaga, licznikTon: wymaga > 0 ? 'ostrzezenie' : 'neutralny', widok: { widok: 'wymaga' }, dzieci: [] },
    ...poTerminie(l),
    ...bezGrupy.map((s) => pozycja(s)),
    ...grupy,
    ...bez,
    ...(o.ustawienia ? [USTAW_STATUSY] : []),
  ]
}

/** Nazwa bieżącego widoku listy (tytuł nad tabelą): status albo grupa firmy, inaczej widok; z przewoźnikiem. */
export function nazwaBiezacego(l: LicznikiPanelu, widok: Widok, o: { przewoznik?: string; sf?: string; sg?: string }): string {
  const zPrzewoznikiem = (n: string) => `${n}${o.przewoznik ? ` · ${CARRIER_LABEL[o.przewoznik as Carrier] ?? ''}` : ''}`
  const f = l.firmy
  if (f && o.sf) return zPrzewoznikiem(f.statusy.find((s) => s.key === o.sf)?.name ?? (o.sf.startsWith('RDZEN:') ? (STATUS_ZAMOWIENIA[o.sf.slice(6) as keyof typeof STATUS_ZAMOWIENIA]?.etykieta ?? o.sf) : o.sf))
  if (f && o.sg) return zPrzewoznikiem(f.grupy.find((g) => g.key === o.sg)?.name ?? o.sg)
  return zPrzewoznikiem(nazwaWidoku(widok))
}
