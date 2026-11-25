// Lista zamówień v2 (wzorzec: lista zamówień BaseLinkera). Statusy z licznikami
// (grupa × przewoźnik, statusy firmy) są w menu bocznym pod „Zamówienia”
// (lib/panel/menu-statusy.ts); tu wyszukiwarka i filtry w adresie (także `sf`/`sg`), tabela `app/ui` z sortowaniem, stronami
// 25/50/100/250, wyborem kolumn zapisanym na koncie osoby i akcjami masowymi (status z powodem, przesyłki, etykiety,
// karty, lista wysyłkowa, CSV). Zapytania z paginacją po stronie bazy (lib/panel/zamowienia-lista.ts).
// (R5–R9 z przeglądu TwojOMS 08.11, wzór układu: TwojOMS, MIT): produkt jako miniatura z pełną nazwą,
// jedno pole szukania (numer, klient, e-mail, telefon, NIP, produkt, numer przesyłki; typ frazy rozpoznaje serwer,
// lib/panel/szukaj-lista.ts) i jeden rząd filtrów, stały pasek akcji masowych z eksportem i „Kolumny” jako ikonami,
// kolumna „Stan” (płatność, przesyłka, dokument sprzedaży, zwrot), termin wysyłki pod numerem i najwyżej 3 alerty nad
// listą z „Ignoruj”. Lista tylko czyta; „Ignoruj” pisze wyłącznie ustawienie osoby.
import { Baner, NaglowekStrony, PasekFiltrow, PrzyciskLink, PustyStan, StatusZamowienia, StanPlatnosci, Tabela, type KolumnaTabeli, type WierszTabeli } from '@/app/ui'
import { zapiszKolumny } from '@/app/akcje'
import { numerListy } from '@/lib/karta/opis'
import { klienciNaLiscie } from '@/lib/klienci/odczyt'
import { ustawieniaDokumentowFirmy } from '@/lib/dokumenty/firma'
import { krajeKlientow } from '@/lib/klienci/kraje'
import { daneAlertow, ukryteAlertyZ, wybierzAlerty } from '@/lib/panel/alerty-listy'
import { accountKey, accountName } from '@/lib/panel/dane'
import { CARRIER_LABEL, channelPrefix, money, STATUS_LABEL, when } from '@/lib/panel/format'
import { ukryteKolumny } from '@/lib/panel/kolumny'
import { requireSession } from '@/lib/panel/kontekst'
import { orderListLines } from '@/lib/panel/lista-zamowien'
import { nazwaBiezacego } from '@/lib/panel/menu-statusy'
import { stanZamowienia } from '@/lib/panel/stan-zamowienia'
import { etykietaStatusuFirmy } from '@/lib/panel/statusy'
import { filtryZSzukaniem } from '@/lib/panel/szukaj-lista'
import { adresZ, sortZ, stronaZ } from '@/lib/panel/tabela'
import { terminWysylki } from '@/lib/panel/termin-wysylki'
import { daneTerminowNaZadanie } from '@/lib/panel/termin-wysylki-dane'
import { FAKTURA_FILTR, ileFiltrow, licznikiPanelu, PRZEWOZNICY, SORT_DOMYSLNY, SORTOWANIE, STATUSY, statusyFirmyNaZadanie, stronaListy, WIDOK_DOMYSLNY, type WierszListy } from '@/lib/panel/zamowienia-lista'
import { ostatnieAkcje } from '@/lib/zamowienia/masowo'
import { szukaj } from './akcje-szukaj'
import { AkcjeMasowe } from './_lista/akcje-masowe'
import { AlertyListy } from './_lista/alerty'
import { MenuEksportu } from './_lista/eksport'
import { IkonaPrzewoznika, IkonyStanu } from './_lista/ikony'
import { NumerZamowienia } from './_lista/numer'
import { NumerNadania } from '../_komponenty/numer-nadania'
import { SkanListy } from './_lista/skan-listy'
import { PostepAkcji } from './_lista/postep-akcji'
import { Produkty, ProduktyKody } from './_lista/produkty'
import './_lista/lista.css'

export const metadata = { title: 'Zamówienia' }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

const KOLUMNY: KolumnaTabeli[] = [
  { klucz: 'numer', etykieta: 'Numer', sortowalna: true, szerokosc: '10.5rem' },
  // jak w BaseLinkerze (numer, klient, produkty); tylko z uprawnieniem `klienci.dane` (filtr w ekranie)
  { klucz: 'klient', etykieta: 'Klient', ukrywalna: true, szerokosc: '10rem' },
  { klucz: 'produkty', etykieta: 'Produkty', ukrywalna: true },
  { klucz: 'kody', etykieta: 'Produkty (skrót)', ukrywalna: true, ukrytaDomyslnie: true },
  { klucz: 'kwota', etykieta: 'Kwota', wyrownanie: 'prawo', sortowalna: true, szerokosc: '7.5rem' },
  { klucz: 'wysylka', etykieta: 'Wysyłka', ukrywalna: true, szerokosc: '9.5rem' },
  { klucz: 'status', etykieta: 'Status', szerokosc: '8.5rem' },
  { klucz: 'stan', etykieta: 'Stan', ukrywalna: true, szerokosc: '7rem' },
  { klucz: 'data', etykieta: 'Data', sortowalna: true, ukrywalna: true, szerokosc: '5rem' },
  { klucz: 'kraj', etykieta: 'Kraj', ukrywalna: true, ukrytaDomyslnie: true, szerokosc: '4rem' },
]

function znaczniki(o: WierszListy, now: Date): { ton: string; tekst: string }[] {
  const out: { ton: string; tekst: string }[] = []
  if (o.invoice === 'FAILED') out.push({ ton: 'red', tekst: 'faktura się nie wystawiła' })
  if (o.status === 'DO_WYJASNIENIA') out.push({ ton: 'violet', tekst: o.clarify ? `do wyjaśnienia: ${o.clarify}` : 'do wyjaśnienia' })
  // zamówienia z fakturą z BaseLinkera po przełączeniu (Pomoc → Przejście z BaseLinkera)
  if (o.fakturaBl) out.push({ ton: 'amber', tekst: `faktura z BaseLinkera ${o.fakturaBl}: kończy BaseLinker, nie pakuj` })
  if (o.towarPoFakturzeBl) out.push({ ton: 'amber', tekst: 'zafakturowane w BaseLinkerze przy braku towaru: sprawdź, czy towar dojechał' })
  if (o.status === 'NOWE' && (o.paymentState === 'UNPAID' || o.paymentState === 'PARTIAL') && o.reservationDeadline) {
    // nieudana płatność online: towar wraca do sprzedaży wcześniej, zamówienie czeka do zwykłego terminu
    if (o.stockReleasedAt) out.push({ ton: 'amber', tekst: `towar wrócił do sprzedaży, czeka na płatność do ${when(o.reservationDeadline, now)}` })
    else out.push({ ton: 'amber', tekst: `zwolni towar ${when(o.stockReleaseAt ?? o.reservationDeadline, now)}` })
  }
  return out
}

export default async function Zamowienia({ searchParams }: Props) {
  const ctx = await requireSession()
  const sp = await searchParams
  const canKlient = ctx.permissions.has('klienci.dane')
  // jedno pole szukania (`qz` zaszyfrowane dla osoby z dostępem do klientów, `q` jawnie bez niego; stare `kh`/`kf`)
  const { f, szukanie } = await filtryZSzukaniem(sp, { db: ctx.db, actorId: ctx.user.id, organizationId: ctx.organization.organizationId, canKlient })
  const sort = sortZ(sp, SORTOWANIE, SORT_DOMYSLNY)
  const { strona, ile, pomin } = stronaZ(sp)

  // statusy firmy i liczniki raz na żądanie (`cache`): menu w layoucie i lista biorą te same
  const statusy = statusyFirmyNaZadanie(ctx.db)
  const [liczniki, dane, kraje, akcje, terminy, dokumenty] = await Promise.all([
    licznikiPanelu(ctx.db),
    stronaListy(ctx.db, f, { sort, pomin, ile, statusy }),
    krajeKlientow(ctx.db),
    ostatnieAkcje(ctx.db, ctx.user.id),
    daneTerminowNaZadanie(ctx.db),
    ustawieniaDokumentowFirmy(ctx.db),
  ])
  // kolumna „Klient” tylko z `klienci.dane`; ukryta w „Kolumny” = bez odszyfrowania i bez wpisu w dzienniku
  const ukryte = ukryteKolumny(ctx.kolumnyTabel, 'zamowienia')
  const kolumny = canKlient ? KOLUMNY : KOLUMNY.filter((k) => k.klucz !== 'klient')
  const czytajKlientow = canKlient && !(ukryte ?? []).includes('klient')
  const [linie, alertyDane, klienci] = await Promise.all([
    orderListLines(
      ctx.db,
      dane.wiersze.map((o) => o.id),
    ),
    daneAlertow(ctx.db, { poTerminie: liczniki.poTerminie }),
    czytajKlientow ? klienciNaLiscie(ctx.db, dane.wiersze, { actorId: ctx.user.id }) : Promise.resolve(new Map<string, string>()),
  ])
  // alert prowadzący do widoku, który już jest na ekranie, nic nie dodaje
  const alerty = wybierzAlerty(alertyDane, ukryteAlertyZ(ctx.ukryteAlerty, ctx.organization.organizationId), f.widok)
  // statusy firmy (puste = nazwy rdzenia jak dotąd)
  const defs = liczniki.firmy?.statusy ?? []
  const now = new Date()
  const adres = { sciezka: '/zamowienia', parametry: sp }
  // parametry listy bez strony: akcja „na wszystkich stronach” i eksport liczą te same zamówienia co ekran (także
  // z wyszukiwaniem: `qz`/`kh`/`kf` idą dalej i serwer liczy je tą samą funkcją, lib/panel/szukaj-lista.ts)
  // (przegląd r2): `widok` zawsze jawnie — akcja „na wszystkich pasujących” i eksport liczą ten sam zbiór,
  // który osoba widzi, także gdy adres nie ma parametru (domyślny widok mógł się zmienić od otwarcia karty)
  const filtryQs = adresZ('', sp, { widok: f.widok, strona: undefined, ile: undefined, sort: undefined, kier: undefined }).replace(/^\?/, '')
  const eksportHref = `/api/zamowienia/eksport?${filtryQs}`
  const parametry = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : (sp[k] as string | undefined))
  // pasek filtrów zachowuje wyszukiwanie i statusy z menu; pole szukania zachowuje filtry (`powrot`)
  const zachowajFiltry: Record<string, string | undefined> = {
    widok: f.widok === WIDOK_DOMYSLNY ? undefined : f.widok,
    sort: parametry('sort'),
    kier: parametry('kier'),
    ile: parametry('ile'),
    q: parametry('q'),
    qz: parametry('qz'),
    kh: parametry('kh'),
    kr: parametry('kr'),
    kf: parametry('kf'),
    sf: f.sf,
    sg: f.sg,
  }
  const powrot = adresZ('', sp, { q: undefined, qz: undefined, kh: undefined, kr: undefined, kf: undefined, kb: undefined, strona: undefined })

  const wiersze: WierszTabeli[] = dane.wiersze.map((o) => {
    const konto = accountName(dane.konta, o.channel, o.channelAccountId)
    // ten sam numer co w tytule karty (numer z kanału, w całości), z jednej funkcji
    const numer = numerListy(o).numer
    const href = `/zamowienia/${o.id}`
    const carrier = o.carrier ? CARRIER_LABEL[o.carrier] : null
    const termin = terminWysylki(o, terminy.harmonogramy, terminy.przyjazdy, terminy.now, terminy.cien)
    const lines = linie.get(o.id) ?? []
    return {
      id: o.id,
      href,
      etykieta: `${channelPrefix(o.channel, konto)} ${numer}`,
      ton: o.invoice === 'FAILED' ? 'blad' : o.status === 'DO_WYJASNIENIA' ? 'uwaga' : undefined,
      komorki: {
        numer: (
          <>
            <NumerZamowienia href={href} przedrostek={channelPrefix(o.channel, konto)} numer={numer} />
            <span className="z-meta">
              <span className="z-ch">{konto}</span>
              {o.sourceLabel && <span className="zl-zrodlo">{o.sourceLabel}</span>}
            </span>
            {termin && (
              <span className="zl-termin" data-rodzaj={termin.rodzaj}>
                {termin.tekst}
              </span>
            )}
          </>
        ),
        ...(canKlient ? { klient: klienci.get(o.id) ? <span className="zl-klient">{klienci.get(o.id)}</span> : <span className="muted">—</span> } : {}),
        produkty: <Produkty lines={lines} />,
        kody: <ProduktyKody lines={lines} />,
        kwota: (
          <>
            <span className="num zl-kwota">{money(o.totalGross, o.waluta)}</span>
            <span className="zl-platnosc">
              <StanPlatnosci stan={o.paymentState} />
            </span>
            {o.paymentState === 'COD' ? <span className="zl-meta">Za pobraniem</span> : o.paymentMethod.trim() && <span className="zl-meta">{o.paymentMethod}</span>}
          </>
        ),
        wysylka: (
          <>
            <span className="zl-wysylka">
              <IkonaPrzewoznika carrier={o.carrier} />
              {carrier ?? <span className="muted">nie ustalony</span>}
            </span>
            {o.deliveryMethod && o.deliveryMethod !== carrier && <span className="zl-meta">{o.deliveryMethod}</span>}
            {o.shipment?.trackingNumber && <span className="zl-meta zl-nadanie">nr <NumerNadania numer={o.shipment.trackingNumber} href={o.shipment.link} /></span>}
          </>
        ),
        status: (
          <>
            <StatusZamowienia status={o.status} przewoznik={o.carrier} firmy={defs.length ? etykietaStatusuFirmy(defs, o) : null} />
            {znaczniki(o, now).map((m) => (
              <span key={m.tekst} className={`z-mark ${m.ton}`}>
                {m.tekst}
              </span>
            ))}
          </>
        ),
        stan: <IkonyStanu ikony={stanZamowienia(o, dokumenty.program)} />,
        data: <span className="zl-data">{when(o.createdAtChannel, now)}</span>,
        kraj: o.country ?? undefined,
      },
    }
  })

  const opcja = (wartosc: string, etykieta: string) => (
    <option key={wartosc} value={wartosc}>
      {etykieta}
    </option>
  )
  const ustawionych = ileFiltrow(f)
  const dodatkowych = [f.status, f.faktura, f.kraj].filter(Boolean).length
  const tytul = nazwaBiezacego(liczniki, f.widok, { przewoznik: f.przewoznik, sf: f.sf, sg: f.sg })
  const szukam = !!(szukanie.fraza || szukanie.stary)
  const podpowiedz = canKlient ? 'numer, klient, e-mail, telefon, NIP, produkt, numer przesyłki' : 'numer zamówienia, produkt (SKU, EAN, nazwa), numer przesyłki'

  return (
    <>
      <NaglowekStrony
        tytul="Zamówienia"
        podtytul={`${tytul}: ${dane.razem}`}
        akcje={
          ctx.permissions.has('zamowienia.dodawanie') && (
            <PrzyciskLink href="/zamowienia/nowe" wariant="glowny">
              Dodaj zamówienie
            </PrzyciskLink>
          )
        }
      />

      <div className="zl-glowna">
        <AlertyListy alerty={alerty} />
        {f.widok === 'po_terminie' && terminy.cien && (
          // w podglądzie wysyłkę robi BaseLinker albo sklep, więc termin liczymy z ich statusu
          <p className="small muted zl-wynik">
            {terminy.cien.zBl
              ? 'Zamówienia kont w trybie „Tylko podgląd” są tu tylko wtedy, gdy w BaseLinkerze nadal czekają na wysyłkę. Bez numeru zamówienia z BaseLinkera terminu nie liczymy.'
              : 'Konta w trybie „Tylko podgląd”: wysyłkę robi sklep, więc terminu ich zamówień nie liczymy.'}
          </p>
        )}

        {akcje.map((a) => (
          <PostepAkcji key={a.id} id={a.id} poczatkowy={a} />
        ))}

        {/* skan czytnikiem i wklejony numer otwierają kartę zamówienia */}
        <SkanListy poleSzukania="zl-q" />
        <form className="zl-szukaj" role="search" action={szukaj}>
          <input type="hidden" name="powrot" value={powrot} />
          <label className="sr" htmlFor="zl-q">
            Szukaj zamówień
          </label>
          <input className="input" id="zl-q" name="q" type="search" defaultValue={szukanie.fraza ?? ''} placeholder={podpowiedz} autoComplete="off" enterKeyHint="search" maxLength={120} />
          <button className="btn" type="submit">
            Szukaj
          </button>
          {canKlient && (
            // nazwisko i firma fragmentem tylko na życzenie (odszyfrowanie ostatnich zamówień, wpis w dzienniku)
            <label className="zl-szukaj-klienci" title="Szuka fragmentu nazwiska albo nazwy firmy w danych klientów z ostatnich 2 000 zamówień. E-mail, telefon i NIP znajdziesz zawsze, bez zaznaczania.">
              <input type="checkbox" name="k" value="tak" defaultChecked={szukanie.wKlientach} /> także w danych klientów (nazwisko, firma)
            </label>
          )}
          {szukam && (
            <PrzyciskLink href={`/zamowienia${powrot}`} wariant="cichy" rozmiar="sm">
              Wyczyść szukanie
            </PrzyciskLink>
          )}
        </form>
        {szukanie.fraza && szukanie.klientow !== null && (
          <p className="small muted zl-wynik" role="status">
            Wyniki dla „{szukanie.fraza}”: {dane.razem}, w tym zamówienia pasujących klientów: {szukanie.klientow}
            {szukanie.klientow >= 200 ? ' (pierwsze 200)' : ''}
            {szukanie.przejrzane !== null ? ` · przeszukane dane z ${szukanie.przejrzane} ostatnich zamówień` : ''}.
          </p>
        )}
        {canKlient && szukanie.fraza && !szukanie.wKlientach && szukanie.klientow === null && /\p{L}/u.test(szukanie.fraza) && !szukanie.fraza.includes('@') && dane.razem === 0 && (
          <p className="small muted zl-wynik" role="status">
            Szukasz klienta po nazwisku albo firmie? Zaznacz „także w danych klientów” i wyszukaj jeszcze raz.
          </p>
        )}
        {szukanie.stary && (
          <p className="small muted zl-wynik" role="status">
            {szukanie.stary.rodzaj === 'fragment' ? `Zamówienia klientów pasujących do „${szukanie.fraza ?? ''}”` : `Zamówienia klienta o podanym ${szukanie.stary.rodzaj === 'email' ? 'e-mailu' : 'telefonie'}`}: {szukanie.stary.ile}
            {szukanie.stary.ile >= 200 ? ' (pierwsze 200)' : ''}.
          </p>
        )}
        {szukanie.komunikat && (
          <Baner ton="ostrzezenie" rola="status">
            {szukanie.komunikat}
          </Baner>
        )}

        <PasekFiltrow akcja="/zamowienia" aktywne={ustawionych} wyczysc={adresZ('/zamowienia', {}, { widok: f.widok === WIDOK_DOMYSLNY ? undefined : f.widok, sf: f.sf, sg: f.sg })} zachowaj={zachowajFiltry}>
          <div className="field zl-pole-daty">
            <label htmlFor="f-od">Złożone od</label>
            <input className="input" type="date" id="f-od" name="od" defaultValue={f.od ?? ''} />
          </div>
          <div className="field zl-pole-daty">
            <label htmlFor="f-do">do</label>
            <input className="input" type="date" id="f-do" name="do" defaultValue={f.do ?? ''} />
          </div>
          <div className="field">
            <label htmlFor="f-przew">Wysyłka</label>
            <select className="input" id="f-przew" name="przewoznik" defaultValue={f.przewoznik ?? ''}>
              {opcja('', 'Wszystkie')}
              {PRZEWOZNICY.map((c) => opcja(c, CARRIER_LABEL[c]))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-plat">Płatność</label>
            <select className="input" id="f-plat" name="platnosc" defaultValue={f.platnosc ?? ''}>
              {opcja('', 'Wszystkie')}
              {opcja('PAID', 'Opłacone')}
              {opcja('UNPAID', 'Nieopłacone')}
              {opcja('COD', 'Za pobraniem')}
              {opcja('PARTIAL', 'Niedopłata')}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-kanal">Kanał</label>
            <select className="input" id="f-kanal" name="kanal" defaultValue={f.kanal ?? ''}>
              {opcja('', 'Wszystkie')}
              {dane.konta.map((a) => opcja(accountKey(a.channel, a.channelAccountId), a.name))}
            </select>
          </div>
          <details className="zl-wiecej-filtrow" open={dodatkowych > 0 || undefined}>
            <summary className="btn">Więcej filtrów{dodatkowych > 0 ? ` (${dodatkowych})` : ''}</summary>
            <div className="zl-wiecej-pola">
              <div className="field">
                <label htmlFor="f-status">Status</label>
                <select className="input" id="f-status" name="status" defaultValue={f.status ?? ''}>
                  {opcja('', 'Wszystkie')}
                  {STATUSY.map((s) => opcja(s, STATUS_LABEL[s]))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="f-fakt">Faktura</label>
                <select className="input" id="f-fakt" name="faktura" defaultValue={f.faktura ?? ''}>
                  {opcja('', 'Wszystkie')}
                  {Object.entries(FAKTURA_FILTR).map(([k, v]) => opcja(k, v))}
                </select>
              </div>
              {kraje.length > 0 && (
                <div className="field">
                  <label htmlFor="f-kraj">Kraj</label>
                  <select className="input" id="f-kraj" name="kraj" defaultValue={f.kraj ?? ''}>
                    {opcja('', 'Wszystkie')}
                    {kraje.map((k) => opcja(k, k))}
                  </select>
                </div>
              )}
            </div>
          </details>
        </PasekFiltrow>

        <Tabela
          id="zamowienia"
          etykieta="Zamówienia"
          kolumny={kolumny}
          wiersze={wiersze}
          adres={adres}
          sort={sort}
          zaznaczanie
          kolumnyOsoby={{ ukryte, zapisz: zapiszKolumny }}
          narzedzia={
            <MenuEksportu widok={eksportHref} razem={dane.razem} />
          }
          akcjeMasoweStale
          akcjeMasowe={
            <AkcjeMasowe
              opcjeStatusow={STATUSY.map((s) => ({ wartosc: s, etykieta: STATUS_LABEL[s] }))}
              razem={dane.razem}
              filtry={filtryQs}
              mozeStatus={ctx.permissions.has('zamowienia.status_dowolny')}
              mozeMagazyn={ctx.permissions.has('pakowanie.stanowisko')}
            />
          }
          paginacja={{ strona, ile, razem: dane.razem }}
          pustyStan={
            liczniki.grupy.wszystkie === 0 ? (
              <PustyStan tytul="Nie ma jeszcze zamówień" akcja={<PrzyciskLink href="/ustawienia/kanaly/nowy">Podłącz sklep</PrzyciskLink>}>
                Zamówienia pojawią się po podłączeniu sklepu albo po dodaniu zamówienia ręcznie.
              </PustyStan>
            ) : (
              <PustyStan tytul="Brak zamówień w tym widoku" akcja={<PrzyciskLink href="/zamowienia?widok=wszystkie">Pokaż wszystkie</PrzyciskLink>}>
                {szukam ? 'Nic nie pasuje do szukanej frazy w tym widoku. Sprawdź pisownię albo wybierz „Wszystkie” w menu „Zamówienia”.' : 'Wybierz inny status w menu „Zamówienia” albo wyczyść filtry.'}
              </PustyStan>
            )
          }
        />
      </div>
    </>
  )
}
