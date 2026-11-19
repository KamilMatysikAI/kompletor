// Wysyłka maili z planu akcji: zadanie workera `poczta-wysylka`, co 60 s per firma.
//
// Bramki (wszystkie domyślnie zamknięte): POCZTA_WYSYLKA=1 na instancji, włącznik firmy w Ustawieniach → Poczta i tryb
// PRACA konta kanału (plan w cieniu, SUCHO, nigdy nie wychodzi). Bez konfiguracji plan czeka (PlannedAction PLANNED),
// a ekran pokazuje, czego brakuje: nic nie ginie.
//
// Jeden mail na zdarzenie: wiersz MailDelivery (unikalny „plan:<id akcji>”) w stanie SENDING powstaje PRZED
// wywołaniem serwera, więc dwa przebiegi (dwa workery) nie wyślą dwa razy. SENT → akcja DONE. Ponowienie tylko, gdy
// mail na pewno nie wyszedł (RETRY), najwyżej 5 prób. Zerwane po wysłaniu treści i porzucone SENDING = UNCERTAIN bez
// ponowienia (spam gorszy niż brak maila). Odmowa serwera (5xx) i niepewne = alert do biura. Login/hasło odrzucone =
// wysyłka firmy wyłączona do naprawy, alert.
//
// Przed wysyłką warunek sprawdzany drugi raz (stan mógł się zmienić od planu): „Brak płatności” tylko dla wciąż
// nieopłaconego zamówienia z terminem w przyszłości, „Gotowe do odbioru” tylko w statusie Do odbioru itd. Plany sprzed
// doby przed włączeniem poczty i starsze niż 7 dni nie wychodzą (pominięte z powodem).
//
// Dane klienta: adres i imię z `kontaktDoMaila` (lib/klienci), tylko w pamięci; w MailDelivery i alertach maska adresu.
import { Prisma, type Channel, type PrismaClient } from '@prisma/client'
import { isKluczReguly, OKNO_MS, REGULY, type KluczReguly } from '../akcje/reguly'
import { maileZwrotowFirmy } from '../akcje/maile-zwrotow'
import { panelBaseUrl } from '../auth/zaproszenia'
import { kontaktDoMaila } from '../klienci/wejscia'
import { BladSzablonu, renderujMail, type DaneMaili, type GotowyMail, type KontekstMarki, type NadpisaniaSzablonow, type PozycjaMaila, type RodzajMaila } from '../maile'
import { maskujAdres, maskujAdresyWTekscie, transportSmtp, type KonfiguracjaSmtp, type TransportPoczty, type WynikSmtp } from '../maile/transport'
import { ukladHtml, ukladTekst } from '../maile/uklad'
import { alert, loadCatalog, partsOf } from '../rdzen/stan'
import type { Env } from '../sekrety'
import { domyslneZrodloPdf, type ZrodloPdf } from './dokument-pdf'
import { kontekstFirmy, kontekstKontaKanalu } from './marka'
import { LOGO_FIRMY_CID, LOGO_FIRMY_SRC } from '../maile/typy'
import { plikLogo } from '../firma/logo'
import { danePrzelewu, wariantPrzypomnienia } from '../akcje/wariant-platnosci'
import { nadpisaniaFirmy } from './szablony'
import { linkSledzeniaDoMaila } from '../wysylka/link-sledzenia'
import { AUDIT_TEST, hosting, pocztaFirmy, ustawBladPoczty, wysylkaPocztyZEnv, zdejmijBlokadeLogowania, type PocztaFirmy } from './ustawienia'

export const ZADANIE_WYSYLKI = 'poczta-wysylka'
export const PER_RUN = 20
export const PER_HOUR = 300
export const MAX_ATTEMPTS = 5
export const STALE_SENDING_MS = 10 * 60_000
/** Odstępy ponowień po 1., 2., 3., 4. nieudanej próbie. */
export const RETRY_DELAYS_MS = [2 * 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const
/** Brak danych do maila (dane klienta, PDF): kolejne sprawdzenie za tyle. */
export const CZEKA_CO_MS = 15 * 60_000
/** Po tylu godzinach bez danych klienta mail się nie wysyła, a biuro dostaje alert. */
export const CZEKA_MAX_MS = 24 * 3600_000
/** Zaległość sprzed włączenia poczty, która jeszcze wychodzi (po sprawdzeniu warunku). */
export const ZALEGLOSC_MS = 24 * 3600_000
export const MAX_KANDYDATOW = 100

/** Rodzaje alertów poczty (etykiety w lib/powiadomienia/grupy.ts, grupa „Inne”). */
export const ALERT_ODRZUCONY = 'POCZTA_ODRZUCONY'
export const ALERT_BLAD = 'POCZTA_BLAD'
export const ALERT_NIEPEWNY = 'POCZTA_NIEPEWNY'
export const ALERT_LOGOWANIE = 'POCZTA_LOGOWANIE'
/** serwer odmawia z powodu ustawień (szyfrowanie, logowanie wymagane, nadawca), nie adresata. */
export const ALERT_KONFIGURACJA = 'POCZTA_KONFIGURACJA'

/** Komunikat do Ustawień → Poczta po odmowie z powodu ustawień; wysyłka wyłączona do naprawy. */
export const komunikatKonfiguracji = (blad: string, polaczenie = false) =>
  polaczenie
    ? // 5xx na powitaniu albo EHLO to prawie zawsze odmowa dla adresu IP, nie dla loginu
      `Serwer poczty odrzucił połączenie z Kompletora (${blad}). Zwykle to odmowa dla adresu IP serwera Kompletora: zapytaj dostawcę poczty o listę dozwolonych adresów i czarne listy; wysyłka wyłączona, po wyjaśnieniu włącz ją ponownie`
    : `Serwer poczty nie przyjmuje maili przy tych ustawieniach (${blad}). Sprawdź szyfrowanie, port, login i adres nadawcy; wysyłka wyłączona, po poprawce włącz ją ponownie`

/** Treść alertu po odmowie z powodu ustawień albo połączenia (bez adresata). `dopisek` = treść błędu albo np. „mail z zaproszeniem”. */
export const alertKonfiguracji = (polaczenie: boolean, dopisek?: string) =>
  `${polaczenie ? 'Serwer poczty odrzucił połączenie z Kompletora (sprawdź u dostawcy, czy adres serwera Kompletora jest dozwolony)' : 'Serwer poczty nie przyjmuje maili przy obecnych ustawieniach'}${dopisek ? ` (${dopisek})` : ''}. Wysyłka maili wyłączona: Ustawienia → Komunikacja i poczta → Poczta.`

/** Raport o niedoręczeniu przyszedł po wysłaniu (lib/poczta/odbicia.ts). */
export const STAN_ODBITY = 'ODBITY' as const

export type StanWysylki = 'SENDING' | 'SENT' | 'FAILED' | 'UNCERTAIN' | 'CZEKA' | 'POMINIETY' | typeof STAN_ODBITY

/**
 * Limit godzinowy firmy wolny: mniej niż PER_HOUR prób wysyłki (każdy rodzaj maila, także zaproszenia i reset hasła)
 * w ostatniej godzinie. Klient firmy (RLS). Wspólny dla wysyłki z planu i zaproszeń.
 */
export async function limitGodzinyWolny(db: PrismaClient, now: Date): Promise<boolean> {
  return (await db.mailDelivery.count({ where: { lastAttemptAt: { gte: new Date(now.getTime() - 3600_000) }, attempts: { gt: 0 } } })) < PER_HOUR
}

export interface DepsWysylki {
  /** Transport z konfiguracji (testy: atrapa SMTP na 127.0.0.1). */
  transport?: (cfg: KonfiguracjaSmtp) => TransportPoczty
  pdf?: ZrodloPdf
  now?: () => Date
}

export interface WynikPrzebiegu {
  skipped: null | 'env' | 'firma' | 'konfiguracja' | 'limit'
  sent: number
  retry: number
  failed: number
  uncertain: number
  waiting: number
  skippedPlans: number
  stale: number
  deferred: number
  errors: string[]
  disabled: boolean
}

const pusty = (skipped: WynikPrzebiegu['skipped'] = null): WynikPrzebiegu => ({ skipped, sent: 0, retry: 0, failed: 0, uncertain: 0, waiting: 0, skippedPlans: 0, stale: 0, deferred: 0, errors: [], disabled: false })

const gr = (v: { toString(): string }) => Math.round(Number(v.toString()) * 100)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

// ─── Przygotowanie maila ─────────────────────────────────────────────────────

type Plan = { id: string; rule: string; targetId: string; vars: Prisma.JsonValue; dueAt: Date; resolvedAt: Date | null; createdAt: Date }

type Przygotowany =
  /** `rodzaj` = szablon, który faktycznie wyszedł (historia wysyłki: „Nieudana płatność online” zamiast reguły). */
  | { kind: 'MAIL'; mail: GotowyMail; do: string; nadawca: { email: string; nazwa: string | null }; rodzaj?: RodzajMaila }
  /** Danych jeszcze nie ma: kolejne sprawdzenie za `poMs`. */
  | { kind: 'CZEKAJ'; powod: string; poMs: number }
  /** Warunek ustał albo maila nie da się wysłać z normalnego powodu (brak adresu e-mail): bez alertu. */
  | { kind: 'POMIN'; powod: string }
  /** Błąd konfiguracji albo szablonu: koniec z alertem do biura. */
  | { kind: 'BLAD'; powod: string }

interface Srodowisko {
  db: PrismaClient
  env: Env
  poczta: PocztaFirmy
  nadpisania: NadpisaniaSzablonow
  pdf: ZrodloPdf
  panel: string | null
  now: Date
  /** logo firmy (PNG) do osadzenia w mailu, gdy sklep nie ma własnego logo w Poczcie; null = bez logo. */
  logo: { bytes: Buffer; szerokosc: number } | null
}

// „Do odbioru” = towar spakowany i czeka na klienta (także zamknięte przy przejściu z BaseLinkera): przypomnienie
// o płatności z groźbą anulowania już nie ma sensu; przypomnienia rdzeń ustawia tylko w statusie „Nowe”
const ZAKONCZONE = new Set(['ANULOWANE', 'WYSLANE', 'ODEBRANE', 'DO_ODBIORU'])

/** Zamówienie do maila: stan, kwota i pozycje (nazwa z kanału albo produktu, ilość), bez danych klienta. Podgląd w panelu bierze te same pozycje. */
export async function zamowienieDoMaila(db: PrismaClient, id: string) {
  const o = await db.order.findUnique({
    where: { id },
    select: { id: true, channel: true, channelAccountId: true, externalId: true, channelNumber: true, status: true, paymentState: true, reservationDeadline: true, totalGross: true, flags: true, stockReleasedAt: true, lines: { where: { removed: false }, select: { qty: true, qtyChannel: true, channelName: true, productId: true } } },
  })
  if (!o) return null
  const ids = [...new Set(o.lines.map((l) => l.productId).filter((x): x is string => !!x))]
  const produkty = ids.length ? await db.product.findMany({ where: { id: { in: ids } }, select: { id: true, nameAccounting: true } }) : []
  const nazwy = new Map(produkty.map((p) => [p.id, p.nameAccounting]))
  const pozycje: PozycjaMaila[] = o.lines
    // nazwa z kanału opisuje sztukę oferty, więc ilość też z kanału (1 × „6-pak”,
    // nie 6 × „6-pak”); nazwa księgowa produktu opisuje jednostkę bazową, więc przy niej ilość bazowa
    .map((l) => (l.channelName?.trim() ? { nazwa: l.channelName.trim(), ilosc: l.qtyChannel ?? l.qty } : { nazwa: ((l.productId ? nazwy.get(l.productId) : null) ?? '').trim(), ilosc: l.qty }))
    .filter((p) => p.nazwa && p.ilosc > 0)
  return { ...o, pozycje }
}

type Zamowienie = NonNullable<Awaited<ReturnType<typeof zamowienieDoMaila>>>

/**
 * Pozycje maila o zwrocie tak, jak klient zna je z zamówienia: linie zwrotu grupowane po pozycji zamówienia; gdy zwrot
 * obejmuje całe sztuki pozycji (przy zestawie: wszystkie składniki w proporcji zestawu), nazwa z pozycji zamówienia
 * (nazwa ze sklepu, w braku nazwa księgowa produktu pozycji) i liczba sztuk pozycji; inaczej (część zestawu) nazwy
 * składników. Te same nazwy sumowane, kolejność jak w zwrocie. Bez cen.
 */
export function pozycjeZwrotu(
  linie: readonly { orderLineId: string; productId: string; qty: number }[],
  pozycjeZamowienia: ReadonlyMap<string, { productId: string | null; channelName: string | null }>,
  skladniki: (productId: string) => { productId: string; perUnit: number }[],
  nazwaKsiegowa: (productId: string) => string | null,
): PozycjaMaila[] {
  const grupy = new Map<string, Map<string, number>>()
  for (const l of linie) {
    const g = grupy.get(l.orderLineId) ?? new Map<string, number>()
    g.set(l.productId, (g.get(l.productId) ?? 0) + l.qty)
    grupy.set(l.orderLineId, g)
  }
  const suma = new Map<string, number>()
  const dodaj = (nazwa: string | null | undefined, ilosc: number) => {
    const n = (nazwa ?? '').trim()
    if (n && ilosc > 0) suma.set(n, (suma.get(n) ?? 0) + ilosc)
  }
  for (const [orderLineId, g] of grupy) {
    const poz = pozycjeZamowienia.get(orderLineId)
    const czesci = poz?.productId ? skladniki(poz.productId) : []
    // całe sztuki pozycji: każdy składnik w tej samej wielokrotności proporcji, bez obcych produktów
    let sztuk: number | null = null
    if (czesci.length && g.size === czesci.length) {
      for (const c of czesci) {
        const q = g.get(c.productId)
        if (!q || c.perUnit <= 0 || q % c.perUnit !== 0 || (sztuk !== null && q / c.perUnit !== sztuk)) {
          sztuk = null
          break
        }
        sztuk = q / c.perUnit
      }
    }
    if (sztuk && poz) dodaj(poz.channelName?.trim() || (poz.productId ? nazwaKsiegowa(poz.productId) : null), sztuk)
    else for (const [productId, q] of g) dodaj(nazwaKsiegowa(productId), q)
  }
  return [...suma].map(([nazwa, ilosc]) => ({ nazwa, ilosc }))
}

/** Zwrot z planu (tylko tego zamówienia) i zwrócone produkty w nazwach z zamówienia (`pozycjeZwrotu`), bez cen. Podgląd w panelu bierze te same pozycje. */
export async function zwrotPlanu(db: PrismaClient, returnId: string | null, orderId: string) {
  if (!returnId) return null
  const z = await db.return.findFirst({
    where: { id: returnId, orderId },
    select: { status: true, receivedAt: true, moneyRefundedAt: true, lines: { select: { orderLineId: true, productId: true, qty: true } } },
  })
  if (!z) return null
  const linie = await db.orderLine.findMany({ where: { orderId, id: { in: [...new Set(z.lines.map((l) => l.orderLineId))] } }, select: { id: true, productId: true, channelName: true } })
  const katalog = await loadCatalog(db, linie.map((l) => l.productId).filter((x): x is string => !!x))
  const ids = [...new Set([...z.lines.map((l) => l.productId), ...linie.map((l) => l.productId).filter((x): x is string => !!x)])]
  const produkty = ids.length ? await db.product.findMany({ where: { id: { in: ids } }, select: { id: true, nameAccounting: true } }) : []
  const nazwy = new Map(produkty.map((p) => [p.id, p.nameAccounting]))
  const pozycje = pozycjeZwrotu(
    z.lines,
    new Map(linie.map((l) => [l.id, { productId: l.productId, channelName: l.channelName }])),
    (productId) => {
      const e = katalog.get(productId)
      return e ? partsOf(e) : []
    },
    (productId) => nazwy.get(productId) ?? null,
  )
  return { ...z, pozycje }
}

/**
 * Numer zamówienia do maila: taki, jaki zna klient (numer ze sklepu), z przedrostkiem konta z planu. Plan niesie
 * „<przedrostek> <id w kanale>”; gdy sklep numeruje zamówienia inaczej niż id (Woo z wtyczką numeracji), id w
 * numerze z planu zastępuje numer ze sklepu. Dotyczy też planów zapisanych przed tą zmianą.
 */
export function numerDoMaila(numerZPlanu: string, o: { externalId: string; channelNumber: string | null }): string {
  const nr = o.channelNumber?.trim()
  if (!nr || nr === o.externalId) return numerZPlanu
  if (numerZPlanu === o.externalId) return nr
  return numerZPlanu.endsWith(` ${o.externalId}`) ? `${numerZPlanu.slice(0, -o.externalId.length)}${nr}` : numerZPlanu
}

/**
 * Przesyłki zamówienia do maila: numery nadania nieanulowanych przesyłek (ostatnia próba każdej paczki) i link do
 * śledzenia, gdy paczka jest jedna, a przewoźnik ma znaną stronę śledzenia. Numer nadania nie jest daną osobową.
 * Tylko przesyłki główne (`extraNo: 0`): dosyłka do tej samej paczki nie zastępuje w mailu numeru głównej paczki.
 */
export async function przesylkaDoMaila(db: PrismaClient, orderId: string): Promise<{ numerPrzesylki: string | null; linkSledzenia: string | null }> {
  const rows = await db.shipment.findMany({
    where: { orderId, state: 'UTWORZONA', trackingNumber: { not: null }, extraNo: 0 },
    orderBy: [{ packageNo: 'asc' }, { attempt: 'desc' }],
    select: { packageNo: true, trackingNumber: true, carrier: true },
  })
  const paczki = new Map<number, { numer: string; carrier: string }>()
  for (const r of rows) {
    const numer = r.trackingNumber?.trim()
    if (numer && !paczki.has(r.packageNo)) paczki.set(r.packageNo, { numer, carrier: r.carrier })
  }
  const lista = [...paczki.values()]
  if (!lista.length) return { numerPrzesylki: null, linkSledzenia: null }
  return { numerPrzesylki: lista.map((p) => p.numer).join(', ').slice(0, 200), linkSledzenia: lista.length === 1 ? linkSledzeniaDoMaila(lista[0]!.carrier, lista[0]!.numer) : null }
}

function kontekstKonta(s: Srodowisko, channel: Channel, channelAccountId: string): Promise<{ kontekst: KontekstMarki; nadawca: { email: string; nazwa: string | null } }> {
  return kontekstKontaKanalu(s.db, s.poczta, channel, channelAccountId)
}

function render<R extends RodzajMaila>(s: Srodowisko, rodzaj: R, k: KontekstMarki, dane: DaneMaili[R]): GotowyMail {
  // logo firmy osadzone w mailu (cid), gdy sklep nie ma własnego adresu logo w Poczcie
  const zLogo = !k.sklep.logoUrl && s.logo
  const kk: KontekstMarki = zLogo ? { ...k, sklep: { ...k.sklep, logoUrl: LOGO_FIRMY_SRC, logoSzerokosc: Math.min(200, s.logo!.szerokosc) } } : k
  const mail = renderujMail(rodzaj, kk, dane, { nadpisania: { firma: s.nadpisania } })
  if (zLogo) mail.zalaczniki = [...mail.zalaczniki, { nazwaPliku: 'logo.png', typMime: 'image/png', tresc: s.logo!.bytes, cid: LOGO_FIRMY_CID }]
  return mail
}

/** Mail do klienta zamówienia: kontakt z danych klienta (tylko w pamięci). */
async function doKlienta<R extends 'brak-platnosci' | 'nieudana-platnosc' | 'faktura' | 'gotowe-do-odbioru' | 'zwrot-przyjety' | 'reklamacja-przyjeta' | 'zwrot-pieniedzy'>(s: Srodowisko, plan: Plan, o: Zamowienie, rodzaj: R, dane: (imie: string | null) => DaneMaili[R]): Promise<Przygotowany> {
  // tryb planu to migawka z chwili planowania: konto przełączone z powrotem do cienia nie wysyła starych planów
  // pracy (maile do klientów szłyby wtedy równolegle z dotychczasowym systemem)
  const konto = await s.db.channelConfig.findFirst({ where: { channel: o.channel, channelAccountId: o.channelAccountId }, select: { statusMode: true } })
  if (konto?.statusMode !== 'PRACA') return { kind: 'POMIN', powod: 'konto kanału nie jest już w trybie pracy' }
  const kontakt = await kontaktDoMaila(s.db, o.id, { env: s.env })
  if (kontakt.stan === 'NIGDY') return { kind: 'POMIN', powod: kontakt.powod }
  if (kontakt.stan === 'BRAK') {
    if (s.now.getTime() - plan.createdAt.getTime() > CZEKA_MAX_MS) return { kind: 'BLAD', powod: `${kontakt.powod} przez ponad dobę` }
    return { kind: 'CZEKAJ', powod: kontakt.powod, poMs: CZEKA_CO_MS }
  }
  const { kontekst, nadawca } = await kontekstKonta(s, o.channel, o.channelAccountId)
  const mail = render(s, rodzaj, kontekst, dane(kontakt.imie))
  return { kind: 'MAIL', mail, do: kontakt.email, nadawca, rodzaj }
}

async function przygotuj(s: Srodowisko, plan: Plan, rule: KluczReguly): Promise<Przygotowany> {
  const vars = (plan.vars && typeof plan.vars === 'object' && !Array.isArray(plan.vars) ? plan.vars : {}) as Record<string, unknown>
  const numerZPlanu = str(vars.numerZamowienia) ?? plan.targetId
  if (REGULY[rule].cel === 'PRODUKT') {
    if (plan.resolvedAt) return { kind: 'POMIN', powod: 'stan wrócił powyżej progu przed wysyłką' }
    const p = await s.db.product.findUnique({ where: { id: plan.targetId }, select: { id: true, sku: true, nameAccounting: true } })
    if (!p) return { kind: 'POMIN', powod: 'produkt usunięty' }
    const { kontekst, nadawca } = await kontekstFirmy(s.db, s.poczta)
    const mail = render(s, 'niski-stan', kontekst, {
      sku: p.sku,
      nazwa: p.nameAccounting,
      dostepne: num(vars.dostepne) ?? 0,
      prog: num(vars.prog) ?? 0,
      linkDoProduktu: s.panel ? `${s.panel}/produkty/${encodeURIComponent(p.id)}` : null,
    })
    return { kind: 'MAIL', mail, do: mail.do!, nadawca }
  }
  const o = await zamowienieDoMaila(s.db, plan.targetId)
  if (!o) return { kind: 'POMIN', powod: 'zamówienie usunięte' }
  const numer = numerDoMaila(numerZPlanu, o)
  switch (rule) {
    case 'mail.brak-platnosci': {
      if (o.paymentState === 'PAID' || o.paymentState === 'COD') return { kind: 'POMIN', powod: 'zamówienie opłacone przed wysyłką' }
      if (ZAKONCZONE.has(o.status)) return { kind: 'POMIN', powod: 'zamówienie zakończone albo anulowane przed wysyłką' }
      // kontrakt: mail tylko z datą anulowania, i to w przyszłości
      const termin = o.reservationDeadline
      if (!termin || termin <= s.now) return { kind: 'POMIN', powod: 'termin anulowania minął albo go nie ma' }
      // wariant ze stanu zamówienia teraz: po nieudanej płatności online pytanie o problem z danymi do przelewu,
      // przełączone w międzyczasie na przelew tradycyjny (znacznik zszedł) dostaje zwykły mail; bez danych do przelewu
      // w Danych firmy (rachunek albo pełna nazwa, także usunięte po planowaniu) też zwykły mail, bez błędu wysyłki
      const przelew = wariantPrzypomnienia(o) === 'nieudana-platnosc' ? danePrzelewu((await s.db.organization.findFirst({ select: { settings: true } }))?.settings) : null
      if (przelew) {
        return doKlienta(s, plan, o, 'nieudana-platnosc', (imie) => ({
          imie,
          numerZamowienia: numer,
          kwotaGr: gr(o.totalGross),
          rachunek: przelew.rachunek,
          odbiorcaPrzelewu: przelew.odbiorca,
          numerWSklepie: o.channelNumber ?? o.externalId,
          terminAnulowania: termin,
          towarZwolniony: !!o.stockReleasedAt,
          pozycje: o.pozycje,
        }))
      }
      return doKlienta(s, plan, o, 'brak-platnosci', (imie) => ({
        imie,
        numerZamowienia: numer,
        kwotaGr: gr(o.totalGross),
        terminAnulowania: termin,
        dniDoAnulowania: num(vars.dniDoAnulowania) ?? 5,
        pozycje: o.pozycje,
      }))
    }
    case 'mail.gotowe-do-odbioru':
      if (o.status !== 'DO_ODBIORU') return { kind: 'POMIN', powod: 'zamówienie nie czeka już na odbiór' }
      return doKlienta(s, plan, o, 'gotowe-do-odbioru', (imie) => ({ imie, numerZamowienia: numer, pozycje: o.pozycje }))
    case 'mail.faktura': {
      if (o.status !== 'WYSLANE' && o.status !== 'ODEBRANE') return { kind: 'POMIN', powod: 'zamówienie nie jest wysłane' }
      const docId = str(vars.wfirmaDocId)
      if (!docId) return { kind: 'BLAD', powod: 'plan bez numeru dokumentu' }
      const pdf = await s.pdf.pobierz(s.db, { orderId: o.id, docId })
      // bez pliku mail nie wychodzi (szablon obiecuje załącznik): czeka do końca okna 7 dni, potem jest pomijany
      if (pdf.stan === 'BRAK') return { kind: 'CZEKAJ', powod: pdf.powod, poMs: 60 * 60_000 }
      if (pdf.stan === 'POZNIEJ') return { kind: 'CZEKAJ', powod: pdf.powod, poMs: CZEKA_CO_MS }
      // bez numeru z programu mail wychodzi w wariancie bez numeru: identyfikator dokumentu nie trafia do tematu, treści
      // ani nazwy załącznika (nazwę pliku z identyfikatorem zastępuje wtedy nazwa z numeru zamówienia)
      const numerFaktury = pdf.numer?.trim() ? pdf.numer : null
      // numer przesyłki i link śledzenia to dodatek: błąd odczytu nie wstrzymuje maila z fakturą
      const przesylka = await przesylkaDoMaila(s.db, o.id).catch(() => ({ numerPrzesylki: null, linkSledzenia: null }))
      return doKlienta(s, plan, o, 'faktura', (imie) => ({ imie, numerZamowienia: numer, numerFaktury, ...przesylka, pdf: { tresc: pdf.tresc, nazwaPliku: numerFaktury ? pdf.nazwaPliku : null } }))
    }
    case 'mail.blad-faktury': {
      const idExternal = str(vars.idExternal)
      const proba = idExternal ? await s.db.invoiceAttempt.findFirst({ where: { orderId: o.id, idExternal }, select: { packageNo: true, lastError: true, updatedAt: true } }) : null
      if (proba && (await s.db.invoiceAttempt.findFirst({ where: { orderId: o.id, packageNo: proba.packageNo, state: 'ISSUED' }, select: { id: true } })))
        return { kind: 'POMIN', powod: 'faktura wystawiona w kolejnej próbie przed wysyłką' }
      const { kontekst, nadawca } = await kontekstKonta(s, o.channel, o.channelAccountId)
      const mail = render(s, 'blad-faktury', kontekst, {
        numerZamowienia: numer,
        trescBledu: proba?.lastError?.trim() || 'treść błędu w panelu zamówienia',
        linkDoZamowienia: s.panel ? `${s.panel}/zamowienia/${encodeURIComponent(o.id)}` : '',
        kiedy: proba?.updatedAt ?? null,
      })
      return { kind: 'MAIL', mail, do: mail.do!, nadawca }
    }
    case 'mail.zwrot-przyjety':
    case 'mail.reklamacja-przyjeta':
    case 'mail.zwrot-pieniedzy': {
      // wyłącznik firmy sprawdzany też przy wysyłce: wyłączenie zatrzymuje plany zapisane wcześniej
      const wlaczoneOd = await maileZwrotowFirmy(s.db)
      if (!wlaczoneOd) return { kind: 'POMIN', powod: 'maile o zwrotach wyłączone w ustawieniach firmy' }
      const z = await zwrotPlanu(s.db, str(vars.returnId), o.id)
      if (!z) return { kind: 'POMIN', powod: 'zwrot usunięty albo z innego zamówienia' }
      if (z.status === 'ODRZUCONY') return { kind: 'POMIN', powod: 'zwrot odrzucony przed wysyłką' }
      const kiedy = rule === 'mail.zwrot-pieniedzy' ? z.moneyRefundedAt : z.receivedAt
      if (!kiedy) return { kind: 'POMIN', powod: 'zwrot nie jest już w tym stanie' }
      // plan zapisany przed wyłączeniem i ponownym włączeniem: zdarzenie sprzed bieżącego włączenia nie dostaje maila
      if (kiedy < wlaczoneOd) return { kind: 'POMIN', powod: 'zwrot sprzed włączenia maili o zwrotach' }
      // pieniądze już zwrócone: „dotarł” obiecywałby sprawdzanie, klient dostaje „Pieniądze zwrócone”
      if (rule !== 'mail.zwrot-pieniedzy' && z.moneyRefundedAt) return { kind: 'POMIN', powod: 'pieniądze już zwrócone' }
      const rodzaj = REGULY[rule].mail
      return doKlienta(s, plan, o, rodzaj, (imie) => ({ imie, numerZamowienia: numer, pozycje: z.pozycje }))
    }
    default:
      return { kind: 'BLAD', powod: `reguła ${rule} bez maila` }
  }
}

// ─── Przebieg ───────────────────────────────────────────────────────────────

/** Komunikat do bazy i alertów: jedna linia, bez pełnych adresów e-mail (druga linia obrony obok transportu). */
function bezpieczny(msg: string): string {
  return maskujAdresyWTekscie(msg).replace(/\s+/g, ' ').trim().slice(0, 300)
}

async function pominPlan(db: PrismaClient, planId: string, powod: string): Promise<void> {
  await db.plannedAction.updateMany({ where: { id: planId, state: 'PLANNED' }, data: { state: 'SKIPPED', reason: `przed wysyłką: ${powod}`.slice(0, 500) } })
}

/** Wpis bez próby wysyłki: CZEKA (z kolejnym sprawdzeniem), POMINIETY albo FAILED (koniec). Zwraca id wpisu. */
async function wpisBezProby(db: PrismaClient, planId: string, rodzaj: string, deliveryId: string | null, powod: string, nastepna: Date, stan: 'CZEKA' | 'POMINIETY' | 'FAILED'): Promise<string | null> {
  const data = { state: stan, nextAttemptAt: stan === 'CZEKA' ? nastepna : null, lastError: bezpieczny(powod) }
  if (deliveryId) {
    const r = await db.mailDelivery.updateMany({ where: { id: deliveryId, state: { in: ['CZEKA', 'FAILED'] } }, data })
    return r.count ? deliveryId : null
  }
  try {
    return (await db.mailDelivery.create({ data: { dedupeKey: `plan:${planId}`, kind: rodzaj, plannedActionId: planId, ...data }, select: { id: true } })).id
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return null // równoległy przebieg
    throw e
  }
}

async function alertPoczty(db: PrismaClient, kind: string, ref: string, deliveryId: string, msg: string): Promise<void> {
  await alert(db, kind, ref, msg.slice(0, 500), `poczta:${deliveryId}:${kind}`)
}

/** Plany pracy bez wpisu wysyłki (Prisma, bez surowego SQL): id z zakresu `dueAt`, najstarsze pierwsze. */
async function planyBezWysylki(db: PrismaClient, where: Prisma.PlannedActionWhereInput, limit: number): Promise<string[]> {
  const out: string[] = []
  let kursor: { dueAt: Date; id: string } | null = null
  // strony po 200: plany z wpisem (czekające, wysłane) odpadają, więc jedna strona może dać mniej niż limit
  for (let i = 0; i < 10 && out.length < limit; i++) {
    const c: { dueAt: Date; id: string } | null = kursor
    const strona: { id: string; dueAt: Date }[] = await db.plannedAction.findMany({
      where: { ...where, state: 'PLANNED', mode: 'PRACA', ...(c ? { OR: [{ dueAt: { gt: c.dueAt } }, { dueAt: c.dueAt, id: { gt: c.id } }] } : {}) },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      take: 200,
      select: { id: true, dueAt: true },
    })
    if (!strona.length) break
    const zWpisem = new Set(
      (await db.mailDelivery.findMany({ where: { plannedActionId: { in: strona.map((p) => p.id) } }, select: { plannedActionId: true } })).map((d) => d.plannedActionId),
    )
    for (const p of strona) if (!zWpisem.has(p.id) && out.length < limit) out.push(p.id)
    kursor = strona.at(-1)!
    if (strona.length < 200) break
  }
  return out
}

/** Przebieg wysyłki jednej firmy (klient firmy, RLS). Błąd jednego maila nie zatrzymuje reszty. */
export async function wyslijZaplanowane(db: PrismaClient, env: Env, deps: DepsWysylki = {}): Promise<WynikPrzebiegu> {
  if (!wysylkaPocztyZEnv(env)) return pusty('env') // przed jakimkolwiek odczytem
  const zegar = deps.now ?? (() => new Date())
  const now = zegar()
  const cfg = await pocztaFirmy(db, env)
  if (!cfg.ok) {
    if (cfg.enabled && cfg.lastError !== cfg.brak) await ustawBladPoczty(db, cfg.brak, now)
    return pusty(cfg.enabled ? 'konfiguracja' : 'firma')
  }
  const poczta = cfg.poczta
  if (!poczta.enabled || !poczta.enabledAt) return pusty('firma')

  const out = pusty()
  // porzucone SENDING (worker przerwany w trakcie wysyłki): mail mógł wyjść — bez ponowienia, alert do biura
  const porzucone = await db.mailDelivery.findMany({ where: { state: 'SENDING', lastAttemptAt: { lt: new Date(now.getTime() - STALE_SENDING_MS) } }, select: { id: true, plannedActionId: true } })
  for (const p of porzucone) {
    const r = await db.mailDelivery.updateMany({ where: { id: p.id, state: 'SENDING' }, data: { state: 'UNCERTAIN', nextAttemptAt: null, lastError: 'przebieg przerwany w trakcie wysyłki — mail mógł dojść' } })
    if (r.count) {
      out.stale++
      await alertPoczty(db, ALERT_NIEPEWNY, p.plannedActionId ?? p.id, p.id, 'Wysyłka maila przerwana w trakcie: mail mógł dojść, nie ponawiamy. Sprawdź w skrzynce nadawczej.')
    }
  }
  // konfiguracja poprawna: stary komunikat (np. brak hasła) znika z ekranu
  if (poczta.lastError) await ustawBladPoczty(db, null, now)

  // plany za stare, żeby wyjść: sprzed doby przed włączeniem poczty i starsze niż okno planu (7 dni)
  const granica = new Date(Math.max(poczta.enabledAt.getTime() - ZALEGLOSC_MS, now.getTime() - OKNO_MS))
  const stare = await planyBezWysylki(db, { dueAt: { lt: granica } }, 500)
  if (stare.length) {
    const r = await db.plannedAction.updateMany({ where: { id: { in: stare }, state: 'PLANNED' }, data: { state: 'SKIPPED', reason: 'przed wysyłką: starsze niż doba przed włączeniem poczty albo niż 7 dni' } })
    out.skippedPlans += r.count
  }

  // limit godzinowy firmy: liczony z bazy przed KAŻDYM zajęciem, nie raz na start przebiegu.
  // Zajęcie (SENDING z `lastAttemptAt`) samo wchodzi do licznika, więc równoległy przebieg (worker uznany za martwy
  // przez reapStale, a jeszcze żywy; harmonogram z dedupeKey zwykle na to nie pozwala) widzi cudze zajęcia i najwyżej
  // jeden mail na przebieg przechodzi ponad limit (okno między odczytem licznika a zajęciem).
  // Wynik `false` zapamiętany do końca przebiegu: w tym przebiegu nic limitu nie zwolni, więc
  // reszta kandydatów nie liczy COUNT od nowa.
  let limitGodzinyPelny = false
  const wGodzinie = async () => {
    if (limitGodzinyPelny) return false
    if (!(await limitGodzinyWolny(db, now))) limitGodzinyPelny = true
    return !limitGodzinyPelny
  }

  // kandydaci: ponowienia i czekające (najbliższy termin pierwszy), potem nowe plany pracy bez wpisu wysyłki
  const ponowienia = await db.mailDelivery.findMany({
    where: { state: { in: ['FAILED', 'CZEKA'] }, nextAttemptAt: { lte: now }, plannedActionId: { not: null } },
    orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
    take: MAX_KANDYDATOW,
    select: { id: true, plannedActionId: true, attempts: true },
  })
  const nowe = await planyBezWysylki(db, { dueAt: { lte: now, gte: granica } }, MAX_KANDYDATOW)
  const kandydaci: { planId: string; delivery: { id: string; attempts: number } | null }[] = [
    ...ponowienia.map((d) => ({ planId: d.plannedActionId!, delivery: { id: d.id, attempts: d.attempts } })),
    ...nowe.map((id) => ({ planId: id, delivery: null })),
  ]
  if (!kandydaci.length) return out

  // logo firmy raz na przebieg; błąd odczytu = maile bez logo (wysyłka idzie dalej)
  const lf = await plikLogo(db, 'ekran').catch(() => null)
  const s: Srodowisko = { db, env, poczta, nadpisania: await nadpisaniaFirmy(db), pdf: deps.pdf ?? domyslneZrodloPdf, panel: panelBaseUrl(env), now, logo: lf ? { bytes: lf.bytes, szerokosc: lf.logo.szerokosc } : null }
  const transport = (deps.transport ?? ((c) => transportSmtp(c, { tylkoPubliczne: hosting(env) })))(poczta.smtp)
  let used = 0
  for (const c of kandydaci) {
    try {
      const plan = await db.plannedAction.findUnique({ where: { id: c.planId }, select: { id: true, rule: true, targetId: true, vars: true, dueAt: true, resolvedAt: true, createdAt: true, state: true, mode: true } })
      if (!plan || plan.state !== 'PLANNED' || plan.mode !== 'PRACA' || !isKluczReguly(plan.rule)) {
        // akcja zmieniona w międzyczasie (np. pominięta): czekający wpis się zamyka
        if (c.delivery) await db.mailDelivery.updateMany({ where: { id: c.delivery.id, state: { in: ['FAILED', 'CZEKA'] } }, data: { state: 'POMINIETY', nextAttemptAt: null } })
        continue
      }
      const rodzaj = REGULY[plan.rule].mail
      if (now.getTime() - plan.dueAt.getTime() > OKNO_MS) {
        await wpisBezProby(db, plan.id, rodzaj, c.delivery?.id ?? null, 'za stare: ponad 7 dni od zdarzenia', now, 'POMINIETY')
        await pominPlan(db, plan.id, 'ponad 7 dni od zdarzenia')
        out.skippedPlans++
        continue
      }
      // budżet PRZED przygotowaniem: przygotowanie maila „Faktura” pobiera PDF z programu do
      // faktur i zapisuje wpis w dzienniku podglądów danych klienta, więc dla maila, który w tym przebiegu i tak nie
      // wyjdzie, nie robimy ani jednego, ani drugiego. Ocena (pominięcie, czekanie) przesuwa się o jeden przebieg.
      if (used >= PER_RUN || !(await wGodzinie())) {
        out.deferred++
        continue
      }
      let p: Przygotowany
      try {
        p = await przygotuj(s, plan, plan.rule)
      } catch (e) {
        if (!(e instanceof BladSzablonu)) throw e
        p = { kind: 'BLAD', powod: `szablon albo dane sklepu: ${e.message}` }
      }
      if (p.kind === 'POMIN') {
        await wpisBezProby(db, plan.id, rodzaj, c.delivery?.id ?? null, p.powod, now, 'POMINIETY')
        await pominPlan(db, plan.id, p.powod)
        out.skippedPlans++
        continue
      }
      if (p.kind === 'CZEKAJ') {
        await wpisBezProby(db, plan.id, rodzaj, c.delivery?.id ?? null, p.powod, new Date(now.getTime() + p.poMs), 'CZEKA')
        out.waiting++
        continue
      }
      if (p.kind === 'BLAD') {
        const id = await wpisBezProby(db, plan.id, rodzaj, c.delivery?.id ?? null, p.powod, now, 'FAILED')
        if (id) await alertPoczty(db, ALERT_BLAD, plan.targetId, id, `Mail „${REGULY[plan.rule].nazwa}” nie wyszedł: ${bezpieczny(p.powod)}`)
        out.failed++
        continue
      }
      // zajęcie: SENDING przed wywołaniem serwera (unikalność „plan:<id>” albo warunkowa zmiana stanu)
      let deliveryId: string
      let attempts: number
      if (c.delivery) {
        const r = await db.mailDelivery.updateMany({
          where: { id: c.delivery.id, state: { in: ['FAILED', 'CZEKA'] }, nextAttemptAt: { lte: now } },
          // znacznik z chwili zajęcia, nie ze startu przebiegu: przebieg przy martwym serwerze trwa minuty, a wpis
          // starszy niż STALE_SENDING_MS drugi worker uznaje za porzucony
          data: { state: 'SENDING', kind: p.rodzaj ?? rodzaj, attempts: { increment: 1 }, lastAttemptAt: zegar(), nextAttemptAt: null, recipient: maskujAdres(p.do) },
        })
        if (r.count !== 1) continue // wziął go równoległy przebieg
        deliveryId = c.delivery.id
        attempts = c.delivery.attempts + 1
      } else {
        try {
          deliveryId = (
            await db.mailDelivery.create({
              data: { dedupeKey: `plan:${plan.id}`, kind: p.rodzaj ?? rodzaj, plannedActionId: plan.id, state: 'SENDING', attempts: 1, lastAttemptAt: zegar(), recipient: maskujAdres(p.do) },
              select: { id: true },
            })
          ).id
        } catch (e) {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue
          throw e
        }
        attempts = 1
      }
      used++
      const res = await transport.wyslij(p.mail, { od: p.nadawca, do: p.do, odpowiedzDo: p.mail.odpowiedzDo, id: `plan:${plan.id}` })
      const stop = await zakoncz(db, { deliveryId, planId: plan.id, ref: plan.targetId, nazwa: REGULY[plan.rule].nazwa, maska: maskujAdres(p.do) }, attempts, res, now, out)
      if (stop) break
    } catch (e) {
      // wiersz mógł zostać w SENDING — po 10 min przejdzie w UNCERTAIN, bez ponowienia
      out.errors.push(`${c.planId}: ${bezpieczny(e instanceof Error ? e.message : String(e))}`)
    }
  }
  if (out.deferred && used === 0) out.skipped = 'limit'
  // pierwszy przyjęty mail potwierdza logowanie; przy włączonej wysyłce blokada zwykle już zdjęta zapisem
  if (out.sent && poczta.loginRejectedAt) await zdejmijBlokadeLogowania(db)
  return out
}

interface CelWyniku {
  deliveryId: string
  planId: string | null
  ref: string
  nazwa: string
  maska: string
}

/** Zapis wyniku wywołania; true = przerwać przebieg (login/hasło odrzucone). */
export async function zakoncz(db: PrismaClient, w: CelWyniku, attempts: number, res: WynikSmtp, now: Date, out: WynikPrzebiegu): Promise<boolean> {
  switch (res.kind) {
    case 'SENT':
      await db.mailDelivery.update({ where: { id: w.deliveryId }, data: { state: 'SENT', sentAt: now, nextAttemptAt: null, lastError: null, messageId: res.messageId } })
      if (w.planId) await db.plannedAction.updateMany({ where: { id: w.planId, state: 'PLANNED' }, data: { state: 'DONE', reason: `wysłano do ${w.maska}` } })
      out.sent++
      return false
    case 'RETRY': {
      const last = attempts >= MAX_ATTEMPTS
      const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)]!
      await db.mailDelivery.update({
        where: { id: w.deliveryId },
        data: { state: 'FAILED', nextAttemptAt: last ? null : new Date(now.getTime() + delay), lastError: bezpieczny(last ? `${res.error} (po ${attempts} próbach)` : res.error) },
      })
      if (last) {
        out.failed++
        await alertPoczty(db, ALERT_BLAD, w.ref, w.deliveryId, `Mail „${w.nazwa}” do ${w.maska} nie wyszedł po ${attempts} próbach: ${bezpieczny(res.error)}`)
      } else out.retry++
      return false
    }
    case 'UNCERTAIN':
      await db.mailDelivery.update({ where: { id: w.deliveryId }, data: { state: 'UNCERTAIN', nextAttemptAt: null, lastError: bezpieczny(res.error) } })
      await alertPoczty(db, ALERT_NIEPEWNY, w.ref, w.deliveryId, `Mail „${w.nazwa}” do ${w.maska}: połączenie zerwane po wysłaniu treści, mail mógł dojść (bez ponowienia).`)
      out.uncertain++
      return false
    case 'REJECTED':
      await db.mailDelivery.update({ where: { id: w.deliveryId }, data: { state: 'FAILED', nextAttemptAt: null, lastError: bezpieczny(res.error) } })
      await alertPoczty(db, ALERT_ODRZUCONY, w.ref, w.deliveryId, `Serwer poczty odrzucił mail „${w.nazwa}” do ${w.maska}: ${bezpieczny(res.error)}`)
      out.failed++
      return false
    case 'AUTH':
      // mail nie wyszedł (logowanie przed wysłaniem treści): wraca do kolejki po naprawie konfiguracji, próba się nie liczy
      await db.mailDelivery.update({ where: { id: w.deliveryId }, data: { state: 'FAILED', attempts: { decrement: 1 }, nextAttemptAt: now, lastError: bezpieczny(res.error) } })
      await ustawBladPoczty(db, `Serwer poczty odrzucił login albo hasło (${bezpieczny(res.error)}) — wysyłka wyłączona; popraw dane i włącz ponownie`, now, true)
      await alertPoczty(db, ALERT_LOGOWANIE, 'poczta', w.deliveryId, 'Serwer poczty odrzucił login albo hasło. Wysyłka maili wyłączona: Ustawienia → Komunikacja i poczta → Poczta.')
      out.failed++
      out.disabled = true
      return true
    case 'KONFIGURACJA':
      // jak AUTH — mail nie wyszedł z winy ustawień, wraca do kolejki po naprawie; alert bez adresata
      await db.mailDelivery.update({ where: { id: w.deliveryId }, data: { state: 'FAILED', attempts: { decrement: 1 }, nextAttemptAt: now, lastError: bezpieczny(res.error) } })
      await ustawBladPoczty(db, komunikatKonfiguracji(bezpieczny(res.error), res.polaczenie === true), now, true)
      await alertPoczty(db, ALERT_KONFIGURACJA, 'poczta', w.deliveryId, alertKonfiguracji(res.polaczenie === true, bezpieczny(res.error)))
      out.failed++
      out.disabled = true
      return true
  }
}

// ─── Mail próbny ──────────────────────────────────────────────────────────────

export const TEST_MIN_GAP_MS = 60_000

export type WynikProby = { ok: true; maska: string } | { ok: false; error: string }

/**
 * Mail próbny „Wyślij test” z Ustawień → Poczta: ta sama bramka instancji i konfiguracja co wysyłka, bez włącznika
 * firmy (próba przed włączeniem). Adresat: podany adres albo adres biura. Najwyżej jeden na minutę. AuditLog.
 */
export async function wyslijMailProbny(db: PrismaClient, env: Env, adres: string, actorId: string, deps: DepsWysylki = {}): Promise<WynikProby> {
  const now = (deps.now ?? (() => new Date()))()
  let instancja: boolean
  try {
    instancja = wysylkaPocztyZEnv(env)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  if (!instancja) return { ok: false, error: 'Wysyłka maili na tej instancji wyłączona (POCZTA_WYSYLKA): mail próbny nie wyjdzie' }
  const recent = await db.auditLog.findFirst({ where: { entity: AUDIT_TEST, createdAt: { gte: new Date(now.getTime() - TEST_MIN_GAP_MS) } }, select: { id: true } })
  if (recent) return { ok: false, error: 'Mail próbny był wysłany przed chwilą — kolejny najwcześniej za minutę' }
  const cfg = await pocztaFirmy(db, env)
  if (!cfg.ok) return { ok: false, error: cfg.brak }
  const doKogo = (adres.trim() || cfg.poczta.officeEmail || '').toLowerCase()
  const { kontekst, nadawca } = await kontekstFirmy(db, cfg.poczta)
  const tresc = {
    temat: `Wiadomość próbna z Kompletora (${kontekst.firma.nazwa})`,
    podglad: 'Poczta działa: ta wiadomość przyszła z ustawień firmy.',
    naglowek: 'Poczta działa',
    bloki: [
      { typ: 'akapit' as const, tekst: 'Dzień dobry,' },
      { typ: 'akapit' as const, tekst: `to wiadomość próbna z Ustawień → Poczta w Kompletorze. Skoro ją widać, serwer ${cfg.poczta.smtp.host} przyjmuje maile firmy ${kontekst.firma.nazwa}.` },
      { typ: 'szczegoly' as const, wiersze: [{ etykieta: 'Nadawca', wartosc: nadawca.email }, { etykieta: 'Polskie znaki', wartosc: 'Zażółć gęślą jaźń' }] },
    ],
  }
  const mail: GotowyMail = {
    rodzaj: 'niski-stan',
    odbiorca: 'biuro',
    do: doKogo,
    odpowiedzDo: kontekst.sklep.odpowiedzDo,
    temat: tresc.temat,
    html: ukladHtml(tresc, kontekst, 'biuro'),
    tekst: ukladTekst(tresc, kontekst, 'biuro'),
    zalaczniki: [],
  }
  const delivery = await db.mailDelivery.create({
    data: { dedupeKey: `test:${now.getTime()}:${Math.random().toString(36).slice(2, 10)}`, kind: 'test', state: 'SENDING', attempts: 1, lastAttemptAt: now, recipient: doKogo ? maskujAdres(doKogo) : null },
    select: { id: true },
  })
  const res: WynikSmtp = doKogo
    ? await (deps.transport ?? ((c) => transportSmtp(c, { tylkoPubliczne: hosting(env) })))(cfg.poczta.smtp).wyslij(mail, { od: nadawca, do: doKogo, odpowiedzDo: mail.odpowiedzDo, id: `test:${delivery.id}` })
    : { kind: 'REJECTED', error: 'podaj adres albo uzupełnij adres biura' }
  await db.mailDelivery.update({
    where: { id: delivery.id },
    data: res.kind === 'SENT' ? { state: 'SENT', sentAt: now, messageId: res.messageId } : { state: res.kind === 'UNCERTAIN' ? 'UNCERTAIN' : 'FAILED', lastError: bezpieczny(res.error) },
  })
  // udany mail próbny = serwer przyjmuje login: linki do ustawienia hasła wracają
  if (res.kind === 'SENT') await zdejmijBlokadeLogowania(db)
  const wynik: WynikProby =
    res.kind === 'SENT'
      ? { ok: true, maska: maskujAdres(doKogo) }
      : { ok: false, error: res.kind === 'AUTH' ? `Serwer odrzucił login albo hasło (${res.error})` : res.kind === 'KONFIGURACJA' ? (res.polaczenie ? `Serwer odrzucił połączenie z Kompletora (${res.error}): sprawdź u dostawcy poczty, czy adres IP serwera Kompletora jest dozwolony` : `Serwer nie przyjmuje maili przy tych ustawieniach (${res.error}): sprawdź szyfrowanie, port, login i adres nadawcy`) : res.kind === 'UNCERTAIN' ? `Wynik nieznany: ${res.error}` : `Nie wysłano: ${res.error}` }
  const organizationId = (await db.organization.findFirstOrThrow({ select: { id: true } })).id
  await db.auditLog.create({ data: { entity: AUDIT_TEST, entityId: organizationId, actorId, after: { do: doKogo ? maskujAdres(doKogo) : null, wynik: wynik.ok ? 'wysłano' : wynik.error.slice(0, 200) } } })
  return wynik
}

export function opisWyniku(r: WynikPrzebiegu): string {
  return `wysłane ${r.sent}, ponowienie ${r.retry}, błąd ${r.failed}, niepewne ${r.uncertain}, czeka ${r.waiting}, pominięte ${r.skippedPlans}, przerwane ${r.stale}, odłożone ${r.deferred}${r.disabled ? ', WYŁĄCZONO (login/hasło albo ustawienia serwera)' : ''}`
}
