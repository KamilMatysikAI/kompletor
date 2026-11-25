// Ustawienia → Przeprowadzka z BaseLinkera (z panelu): klucz API BL → tryb próbny z raportem
// (co przyjdzie: produkty, oferty, stany, statusy) → decyzje (statusy, metody dostawy) → import. Logika:
// lib/przeprowadzka/z-panelu.ts (ta sama co polecenie przeprowadzki, które zostaje dla administratora).
// Ekran jest dostępny każdej firmie z uprawnieniem `ustawienia` (wejście z listy uruchomienia na pulpicie); w menu
// pojawia się, gdy firma ma klucz BL. Inni dostają 404.
import { OrderStatus } from '@prisma/client'
import { CARRIER_LABEL, int } from '@/lib/panel/format'
import { requirePermission } from '@/lib/panel/kontekst'
import { liczbaRegul } from '@/lib/automaty/szablony'
import { KOLORY_STATUSOW, STATUS_ZAMOWIENIA, type KolorStatusu } from '@/lib/panel/statusy'
import { LIMIT_SPRAW, przeprowadzkaPanel, RODZAJ_SPRAWY } from '@/lib/przeprowadzka/panel'
import { powodDlaEkranu } from '@/lib/przeprowadzka/powody-ekran'
import { katalogFirmy, kontaWPracy, LIMIT_POZYCJI, MAX_TOKEN_BL, mapaFirmy, maTokenBl, odmowaKluczaWPracy, stanPanelu, type Streszczenie } from '@/lib/przeprowadzka/z-panelu'
import { odmowaCofnieciaWPracy, stanZakonczenia } from '@/lib/przeprowadzka/zakonczenie'
import { Baner, Karta, ListaOpisowa, NaglowekStrony, Odznaka, StatusFirmy, PoleHasla, PoleTekstowe, Przelacznik, PustyStan, Przycisk, PrzyciskPotwierdz, Wybor, Zaawansowane } from '@/app/ui'
import { statusBlFirmy } from '@/lib/kanaly/status-bl'
import { Odswiezanie } from '../kanaly/odswiezanie'
import { ToastZAdresu } from '../kanaly/toast-z-adresu'
import { cofnijZakonczeniePrzejscia, uruchomImport, uruchomProbe, usunKluczBl, zakonczPrzejscieZBl, zapiszDecyzje, zapiszKluczBl, zapiszStatusBlFirmy } from './akcje'
import './przeprowadzka.css'

export const metadata = { title: 'Przeprowadzka z BaseLinkera' }
export const dynamic = 'force-dynamic'

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.slice(0, 300) ?? null

const atFmt = new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })

const ZAPIS: Record<string, { label: string; ton: 'sukces' | 'ostrzezenie' | 'blad' | 'neutralny' }> = {
  RUNNING: { label: 'w toku albo przerwany', ton: 'ostrzezenie' },
  OK: { label: 'zakończony', ton: 'sukces' },
  PARTIAL: { label: 'zakończony, są sprawy do decyzji', ton: 'ostrzezenie' },
  FAILED: { label: 'przerwany błędem', ton: 'blad' },
}

/** Co przyjdzie z BL (klucze `coPrzejdzie` raportu, ten sam raport co polecenie). */
const CO_PRZYJDZIE: [string, string][] = [
  ['produkty', 'Produkty ze stanem'],
  ['zestawy', 'Zestawy'],
  ['produktyBezStanu', 'Produkty bez stanu (np. e-booki)'],
  ['stanyStartowe', 'Stany startowe'],
  ['ofertyAktywne', 'Oferty powiązane z produktami'],
  ['ofertyDoZatwierdzenia', 'Oferty do zatwierdzenia'],
  ['konta', 'Nowe konta sklepów w Kompletorze (w trybie podglądu)'],
  ['statusy', 'Statusy zamówień'],
  ['regulyPrzewoznikow', 'Reguły przewoźników'],
  ['zamowieniaOtwarte', 'Otwarte zamówienia'],
  ['zamowieniaDoWyjasnienia', 'w tym do wyjaśnienia'],
]

const DO_DECYZJI: [string, string][] = [
  ['ofertyBezPowiazania', 'Oferty bez powiązania z produktem'],
  ['produktyBezSku', 'Produkty bez SKU (nie przejdą; uzupełnij SKU w BaseLinkerze)'],
  ['zestawy', 'Zestawy z problemem'],
  ['zamowieniaDoWyjasnienia', 'Zamówienia z pozycją bez powiązania'],
  ['rozniceStanow', 'Różnice stanu z tym, co już jest w Kompletorze'],
  ['zrodlaBezAdaptera', 'Źródła zamówień bez obsługi w Kompletorze'],
  ['produktyBezEan', 'Produkty bez EAN (przejdą, warto uzupełnić)'],
]

const LICZBY_ZAPISU: [string, string][] = [
  ['kontaNowe', 'Nowe konta sklepów (w trybie podglądu)'],
  ['produkty', 'Produkty ze stanem'],
  ['zestawy', 'Zestawy'],
  ['stanyNowe', 'Stany startowe zapisane'],
  ['stanyIstniejace', 'Stany już istniejące (bez zmian)'],
  ['oferty', 'Oferty powiązane'],
  ['ofertyDoZatwierdzenia', 'Oferty do zatwierdzenia'],
  ['regulyPrzewoznikow', 'Reguły przewoźników'],
  ['zamowieniaNowe', 'Otwarte zamówienia przeniesione'],
  ['zamowieniaDuplikaty', 'Zamówienia już przeniesione wcześniej'],
  ['zamowieniaDoWyjasnienia', 'Zamówienia do wyjaśnienia'],
  ['zamowieniaBledy', 'Zamówienia, które nie przeszły'],
]

const OPCJE_STATUSU = [{ wartosc: '', etykieta: '— do decyzji —' }, ...Object.values(OrderStatus).map((s) => ({ wartosc: s, etykieta: STATUS_ZAMOWIENIA[s].etykieta }))]
const OPCJE_PRZEWOZNIKA = [{ wartosc: '', etykieta: '— do decyzji —' }, ...Object.entries(CARRIER_LABEL).map(([k, v]) => ({ wartosc: k, etykieta: v }))]

function Raport({ s }: { s: Streszczenie }) {
  const c = s.coPrzejdzie
  const d = s.liczbyDoDecyzji
  return (
    <>
      {s.katalog && <p className="small muted pz-bez-marginesu">Katalog BaseLinkera: {s.katalog.nazwa}; stan startowy z: {s.katalog.zrodloStanu === 'wFirma' ? 'wFirmy' : 'magazynu BaseLinkera'}.</p>}
      {s.uwagaKatalogu && <p className="small pz-bez-marginesu" role="status">{s.uwagaKatalogu}</p>}
      <div className="pz-siatka">
        <div>
          <h3>Co przyjdzie</h3>
          <ListaOpisowa pozycje={CO_PRZYJDZIE.filter(([k]) => c[k] !== undefined).map(([k, e]) => ({ klucz: k, etykieta: e, wartosc: int(c[k] ?? 0) }))} />
        </div>
        <div>
          <h3>Do sprawdzenia</h3>
          <ListaOpisowa
            pozycje={[
              { klucz: 'st', etykieta: 'Statusy do decyzji', wartosc: int(s.statusy.length) },
              { klucz: 'pr', etykieta: 'Metody dostawy do decyzji', wartosc: int(s.przewoznicy.length) },
              ...DO_DECYZJI.filter(([k]) => d[k] !== undefined).map(([k, e]) => ({ klucz: k, etykieta: e, wartosc: int(d[k] ?? 0) })),
              ...(s.problemyPobierania ? [{ klucz: 'pp', etykieta: 'Problemy przy pobieraniu z BaseLinkera', wartosc: int(s.problemyPobierania) }] : []),
            ]}
          />
        </div>
      </div>
      <ListySpraw s={s} />
      {s.importStatusow && <ImportStatusow im={s.importStatusow} />}
      {s.powodyOdmowy.length > 0 && (
        <Baner ton="ostrzezenie" tytul="Import jest teraz zablokowany:">
          <ul className="pz-lista">
            {s.powodyOdmowy.map(powodDlaEkranu).map((p, i) => (
              <li key={i}>
                {p.tekst}
                {p.href && (
                  <>
                    {' '}
                    <a href={p.href}>{p.etykieta}</a>
                  </>
                )}
              </li>
            ))}
          </ul>
        </Baner>
      )}
    </>
  )
}

/**
 * statusy BL, które staną się statusami firmy (etap pracy, kolor, nazwa dla klienta, grupa) i automaty z
 * najbliższego szablonu. Etap „do potwierdzenia” wybiera się w „Decyzjach” (te same pola co statusy do decyzji).
 */
function ImportStatusow({ im }: { im: NonNullable<Streszczenie['importStatusow']> }) {
  const nowe = im.statusy.filter((x) => !x.juzJest).length
  const a = im.automaty
  return (
    <div className="pz-mt">
      <h3>Statusy i automatyczne akcje</h3>
      {im.blad ? (
        <Baner ton="ostrzezenie">Statusy z BaseLinkera nie przejdą: {im.blad}</Baner>
      ) : (
        <p className="small muted pz-bez-marginesu">
          {nowe ? `Nowe statusy (${int(nowe)}) przyjdą z nazwą, kolorem, nazwą dla klienta i grupą.` : 'Statusy z BaseLinkera już są w Kompletorze.'} Etap pracy decyduje o pakowaniu i wysyłce; pozycje „do potwierdzenia” wybierz w sekcji „Decyzje”.
        </p>
      )}
      <div className="pz-tabela-wrap">
        <table className="pz-tabela small">
          <thead>
            <tr>
              <th scope="col">Status w BaseLinkerze</th>
              <th scope="col">Etap pracy</th>
              <th scope="col">Nazwa dla klienta</th>
              <th scope="col">Grupa</th>
            </tr>
          </thead>
          <tbody>
            {im.statusy.map((x) => (
              <tr key={x.id}>
                <td>
                  <StatusFirmy rozmiar="sm" etykieta={{ nazwa: x.nazwa, bazowy: x.etap, kolor: kolorPoNazwie(x.kolor) }} />
                  {x.juzJest && <span className="muted"> już jest</span>}
                </td>
                <td>
                  {x.etap}
                  {x.doPotwierdzenia && (
                    <>
                      {' '}
                      <Odznaka ton="ostrzezenie" rozmiar="sm">
                        do potwierdzenia
                      </Odznaka>
                    </>
                  )}
                </td>
                <td>{x.nazwaDlaKlienta ?? <span className="muted">—</span>}</td>
                <td>{x.grupa ?? <span className="muted">bez grupy</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {im.ukryteDomyslne.length > 0 && <p className="small muted">Statusy domyślne ukryte po imporcie (zastąpią je statusy z BaseLinkera): {im.ukryteDomyslne.join(', ')}.</p>}
      <p className="small">
        <b>Automatyczne akcje.</b> BaseLinker nie udostępnia swoich automatycznych akcji, więc trzeba je odtworzyć. Proponujemy szablon „{a.szablon?.nazwa ?? '—'}” ({a.powod}):{' '}
        {a.juzJest ? 'grupa „Z BaseLinkera” już jest, import niczego do niej nie dołoży.' : `Do grupy „Z BaseLinkera” trafi ${liczbaRegul(a.przeniesione.length)}, wyłączone.`} Po imporcie sprawdź je przyciskiem „Sprawdź na ostatnich 7 dniach” w <a href="/ustawienia/automaty">Ustawienia → Sprzedaż i kanały → Automatyczne akcje</a> i włącz te, które odpowiadają Twoim akcjom z BaseLinkera.
      </p>
      {a.nieprzeniesione.length > 0 && (
        <ul className="pz-lista small">
          {a.nieprzeniesione.map((n) => (
            <li key={n.nazwa}>
              Nie przejdzie: {n.nazwa} ({n.powod})
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const kolorPoNazwie = (nazwa: string): KolorStatusu => (Object.entries(KOLORY_STATUSOW).find(([, v]) => v.nazwa === nazwa)?.[0] as KolorStatusu | undefined) ?? 'szary'

/** Nagłówek listy: „(N)” albo „(pierwsze 200 z N)”, gdy raport ma więcej pozycji niż ekran. */
const ileZ = (pokazane: number, razem: number | undefined) => (razem !== undefined && razem > pokazane ? `pierwsze ${int(pokazane)} z ${int(razem)}` : int(pokazane))

const KANAL: Record<string, string> = { WOO: 'sklep WooCommerce', ALLEGRO: 'Allegro', EMPIK: 'Empik', BL_INNE: 'inne źródło BaseLinkera', SHOPER: 'Shoper' }
const kanal = (k: string) => KANAL[k] ?? k

/**
 * pełne listy spraw z raportu (pierwsze `LIMIT_POZYCJI` każdej; całość w raporcie do pobrania), zamiast
 * samych liczb. Każda lista zwinięta, żeby raport z tysiącem ofert nie zasłaniał przycisków.
 */
function ListySpraw({ s }: { s: Streszczenie }) {
  const l = s.listy
  if (!l) return null
  const d = s.liczbyDoDecyzji
  const sekcje: { klucz: string; tytul: string; razem: number | undefined; naglowki: string[]; wiersze: (string | null)[][] }[] = [
    { klucz: 'oferty', tytul: 'Oferty bez powiązania z produktem', razem: d['ofertyBezPowiazania'], naglowki: ['Kanał', 'Oferta', 'SKU', 'Co jest nie tak'], wiersze: l.ofertyBezPowiazania.map((o) => [kanal(o.kanal), o.oferta, o.sku, o.powod]) },
    { klucz: 'bez-sku', tytul: 'Produkty, które nie przejdą (bez SKU, SKU powtórzone)', razem: d['produktyBezSku'], naglowki: ['Id w BaseLinkerze', 'Nazwa', 'Co jest nie tak'], wiersze: l.produktyBezSku.map((p) => [p.idBl, p.nazwa, p.powod]) },
    { klucz: 'zestawy', tytul: 'Zestawy z problemem', razem: d['zestawy'], naglowki: ['Id w BaseLinkerze', 'SKU', 'Co jest nie tak'], wiersze: l.zestawy.map((z) => [z.idBl, z.sku, z.problem]) },
    { klucz: 'zamowienia', tytul: 'Zamówienia z pozycją bez powiązania', razem: d['zamowieniaDoWyjasnienia'], naglowki: ['Zamówienie w BaseLinkerze', 'Kanał', 'Pozycji bez powiązania', 'Co jest nie tak'], wiersze: l.zamowieniaDoWyjasnienia.map((z) => [z.idBl, kanal(z.kanal), String(z.pozycjeBezPowiazania), z.powod]) },
    { klucz: 'zrodla', tytul: 'Źródła zamówień bez obsługi w Kompletorze', razem: d['zrodlaBezAdaptera'], naglowki: ['Źródło', 'Co to znaczy'], wiersze: l.zrodlaBezAdaptera.map((z) => [z.zrodlo, 'Zamówienia przejdą, ale kanał obsługuje dalej BaseLinker.']) },
  ].filter((x) => x.wiersze.length > 0)
  if (!sekcje.length) return null
  return (
    <div className="pz-listy">
      <h3>Sprawy z raportu</h3>
      {sekcje.map((x) => (
        <Zaawansowane key={x.klucz} tytul={`${x.tytul} (${ileZ(x.wiersze.length, x.razem)})`}>
          <table className="tbl cards">
            <thead>
              <tr>
                {x.naglowki.map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {x.wiersze.map((w, i) => (
                <tr key={i}>
                  {w.map((v, j) => (
                    <td key={j} data-label={x.naglowki[j]} className={j === 0 ? 'mono' : undefined}>
                      {v ?? '—'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {x.razem !== undefined && x.razem > x.wiersze.length && <p className="small muted">Ekran pokazuje pierwsze {int(LIMIT_POZYCJI)} pozycji. Wszystkie są w raporcie do pobrania.</p>}
        </Zaawansowane>
      ))}
    </div>
  )
}

/** Link „Pobierz raport” (Markdown, ten sam co z polecenia przeprowadzki). */
function PobierzRaport({ id, tekst }: { id: string; tekst: string }) {
  return (
    <a className="small" href={`/api/przeprowadzka/raport?id=${encodeURIComponent(id)}`} download>
      {tekst}
    </a>
  )
}

export default async function Przeprowadzka({ searchParams }: Props) {
  const ctx = await requirePermission('ustawienia')
  const sp = await searchParams
  const [d, token, stan, mapa, praca, katalog, koniec, statusBl] = await Promise.all([
    przeprowadzkaPanel(ctx.db),
    maTokenBl(ctx.db),
    stanPanelu(ctx.db),
    mapaFirmy(ctx.db),
    kontaWPracy(ctx.db),
    katalogFirmy(ctx.db),
    stanZakonczenia(ctx.db, process.env),
    statusBlFirmy(ctx.db),
  ])
  const mozeTryb = ctx.permissions.has('kanaly.tryb')
  const proba = stan.proba
  const ps = proba?.s ?? null
  const powodImportu = !token.zapisany
    ? 'Najpierw zapisz klucz API BaseLinkera.'
    : stan.wToku
      ? 'Przeprowadzka trwa.'
      : !proba || proba.status !== 'OK' || !ps
        ? 'Najpierw uruchom tryb próbny.'
        : ps.powodyOdmowy.length
          ? 'Raport próbny ma sprawy blokujące import.'
          : koniec.zakonczone
            ? 'Przejście z BaseLinkera jest zakończone: żeby importować, cofnij to w sekcji „5. Koniec przejścia”.'
            : null
  const katalogi = ps?.katalogi ?? []
  const zrodla = ps?.zrodla ?? []
  // zapisany wybór katalogu da się zmienić także przy jednym katalogu w BL (np. po zmianie konta)
  const pokazKatalog = katalogi.length > 1 || katalog !== null
  const opcjeKatalogu = [
    { wartosc: '', etykieta: katalogi.length > 1 ? '— wybierz katalog —' : '— bez wyboru (jedyny katalog) —' },
    ...katalogi.map((k) => ({ wartosc: k.id, etykieta: `${k.nazwa} (nr ${k.id})` })),
    ...(katalog !== null && !katalogi.some((k) => k.id === katalog) ? [{ wartosc: katalog, etykieta: `nr ${katalog} (nie ma go w BaseLinkerze)` }] : []),
  ]
  const formularzDecyzji = !!ps && (ps.statusy.length + ps.przewoznicy.length > 0 || pokazKatalog || zrodla.length > 0)
  const maDecyzje = formularzDecyzji || Object.keys(mapa.statusy).length + Object.keys(mapa.przewoznicy).length > 0
  const st = d.ostatni ? (ZAPIS[d.ostatni.status] ?? { label: d.ostatni.status, ton: 'neutralny' as const }) : null
  return (
    <>
      <NaglowekStrony tytul="Przeprowadzka z BaseLinkera" podtytul="Produkty, oferty, stany, konta sklepów, reguły przewoźników i otwarte zamówienia z BaseLinkera. W BaseLinkerze nic się nie zmienia." />
      <ToastZAdresu sukces={one(sp.zapisano)} blad={one(sp.blad)} />
      <Odswiezanie aktywne={!!stan.wToku} />

      <ol className="steps">
        <li className={token.zapisany ? 'done' : 'now'}>Klucz API</li>
        <li className={proba?.status === 'OK' ? 'done' : token.zapisany ? 'now' : ''}>Tryb próbny</li>
        <li className={ps && ps.statusy.length + ps.przewoznicy.length === 0 ? 'done' : proba?.status === 'OK' ? 'now' : ''}>Decyzje</li>
        <li className={stan.import?.status === 'OK' ? 'done' : !powodImportu ? 'now' : ''}>Import</li>
      </ol>

      <Karta id="klucz" tytul="1. Klucz API BaseLinkera" opis={token.zapisany ? `Zapisany${token.zapisanyAt ? ` ${atFmt.format(token.zapisanyAt)}` : ''}. Kompletor używa go tylko do odczytu.` : 'W BaseLinkerze: Moje konto → API → wygeneruj token. Kompletor tylko czyta, niczego w BaseLinkerze nie zmienia.'}>
        {praca.length > 0 && (
          <Baner ton="ostrzezenie" tytul="Ta firma pracuje już w Kompletorze">
            {odmowaKluczaWPracy(praca)}
          </Baner>
        )}
        <form action={zapiszKluczBl} className="pz-formularz">
          <PoleHasla id="pz-token" etykieta={token.zapisany ? 'Nowy klucz (puste = bez zmiany)' : 'Klucz API'} name="token" autoComplete="off" spellCheck={false} maxLength={MAX_TOKEN_BL} required={!token.zapisany} disabled={praca.length > 0} />
          <div>
            <Przycisk type="submit" wariant={token.zapisany ? 'drugorzedny' : 'glowny'} powodWylaczenia={praca.length ? 'Konta w trybie pracy: najpierw przełącz je na „Tylko podgląd”.' : undefined}>
              {token.zapisany ? 'Zmień klucz' : 'Zapisz klucz'}
            </Przycisk>
          </div>
        </form>
        {token.zapisany && (
          <form action={usunKluczBl} className="pz-mt">
            <PrzyciskPotwierdz
              wariant="cichy"
              tytul="Usunąć klucz BaseLinkera?"
              pytanie="Kompletor przestanie czytać BaseLinkera na tym ekranie. Dane już przeniesione zostają. Klucz możesz zapisać ponownie w każdej chwili."
              tak="Usuń klucz"
              wariantTak="niebezpieczny"
            >
              Usuń klucz BaseLinkera
            </PrzyciskPotwierdz>
          </form>
        )}
      </Karta>

      <Karta
        id="proba"
        className="pz-mt"
        tytul="2. Tryb próbny"
        opis="Kompletor czyta BaseLinkera i pokazuje, co przyjdzie i co wymaga decyzji. Nic nie zapisuje."
        akcje={
          <form action={uruchomProbe}>
            <Przycisk type="submit" wariant={proba ? 'drugorzedny' : 'glowny'} powodWylaczenia={!token.zapisany ? 'Najpierw zapisz klucz API BaseLinkera.' : stan.wToku ? 'Przeprowadzka trwa.' : undefined}>
              {proba ? 'Uruchom jeszcze raz' : 'Uruchom tryb próbny'}
            </Przycisk>
          </form>
        }
      >
        {stan.wToku && (
          <Baner ton="info" rola="status">
            {stan.wToku.zapisz ? 'Import' : 'Tryb próbny'} trwa od {atFmt.format(stan.wToku.start)}. Przy dużym katalogu to kilka minut.
          </Baner>
        )}
        {!proba ? (
          !stan.wToku && (
            <PustyStan tytul="Raportu jeszcze nie ma">{token.zapisany ? 'Uruchom tryb próbny: raport pokaże produkty, oferty, stany i statusy, które przyjdą z BaseLinkera.' : 'Zapisz klucz API, potem uruchom tryb próbny.'}</PustyStan>
          )
        ) : proba.status !== 'OK' || !ps ? (
          <Baner ton="blad" tytul={`Tryb próbny z ${atFmt.format(proba.start)} nie przeszedł.`}>
            {proba.blad ?? 'Spróbuj jeszcze raz.'}
          </Baner>
        ) : (
          <>
            <p className="small muted pz-bez-marginesu">
              Raport z {atFmt.format(proba.koniec ?? proba.start)}.{' '}
              {proba.raport && <PobierzRaport id={proba.id} tekst="Pobierz pełny raport (Markdown)" />}
            </p>
            <Raport s={ps} />
          </>
        )}
      </Karta>

      {ps && maDecyzje && (
        <Karta id="decyzje" className="pz-mt" tytul="3. Decyzje" opis="Katalog produktów, źródła zamówień, statusy i metody dostawy. Po zapisie uruchom tryb próbny jeszcze raz.">
          <form action={zapiszDecyzje} className="pz-formularz">
            {pokazKatalog && (
              <>
                <h3>Katalog produktów BaseLinkera</h3>
                <Wybor
                  id="pz-katalog"
                  name="katalog"
                  etykieta="Z którego katalogu przenieść produkty"
                  pomoc={katalogi.length > 1 ? 'W BaseLinkerze jest kilka katalogów. Kompletor przeniesie produkty, oferty i stany z jednego.' : 'Masz zapisany wybór katalogu. Przy jednym katalogu w BaseLinkerze możesz go zdjąć: Kompletor weźmie jedyny katalog.'}
                  opcje={opcjeKatalogu}
                  defaultValue={katalog ?? ''}
                />
              </>
            )}
            {zrodla.length > 0 && (
              <fieldset className="ui-pole pz-zrodla">
                <legend>Źródła zamówień</legend>
                <p className="ui-pomoc">Zaznacz źródła, których nie przenosisz (np. stary sklep). Ich konta i otwarte zamówienia nie trafią do Kompletora.</p>
                {zrodla.map((z) => (
                  <label key={z.zrodlo} className="pz-zrodlo">
                    <input type="hidden" name="zrodlo" value={z.zrodlo} />
                    <input type="checkbox" name="pomin" value={z.zrodlo} defaultChecked={mapa.zrodla[z.zrodlo] === 'POMIN'} />
                    <span>
                      Pomiń: {z.nazwa} <span className="muted">({kanal(z.kanal)})</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
            {ps.statusy.length > 0 && <h3>Statusy zamówień z BaseLinkera</h3>}
            {ps.statusy.map((s) => (
              <Wybor
                key={s.id}
                id={`pz-st-${s.id}`}
                name={`status:${s.id}`}
                etykieta={`${s.nazwa}${s.grupa ? ` (${s.grupa})` : ''}`}
                pomoc={`Otwartych zamówień: ${s.otwartychZamowien}${s.podpowiedz ? `. Podpowiedź: ${s.podpowiedz}` : ''}`}
                opcje={OPCJE_STATUSU}
                defaultValue={mapa.statusy[s.id] ?? ''}
              />
            ))}
            {ps.przewoznicy.length > 0 && <h3>Metody dostawy</h3>}
            {ps.przewoznicy.map((p) => (
              <Wybor
                key={p.metoda}
                id={`pz-pr-${p.metoda}`}
                name={`przewoznik:${p.metoda}`}
                etykieta={p.metoda}
                pomoc={`Zamówień: ${p.zamowien}. ${p.powod}${p.podpowiedz ? ` Podpowiedź: ${p.podpowiedz}` : ''}`}
                opcje={OPCJE_PRZEWOZNIKA}
                defaultValue={mapa.przewoznicy[p.metoda] ?? ''}
              />
            ))}
            {!formularzDecyzji && <p className="small muted">Ostatni raport nie ma spraw do decyzji. Zapisane decyzje: statusy {Object.keys(mapa.statusy).length}, metody dostawy {Object.keys(mapa.przewoznicy).length}.</p>}
            {formularzDecyzji && (
              <div>
                <Przycisk type="submit" wariant="glowny">
                  Zapisz decyzje
                </Przycisk>
              </div>
            )}
          </form>
        </Karta>
      )}

      <Karta id="import" className="pz-mt" tytul="4. Import" opis="Zapis do Kompletora tego, co pokazał ostatni tryb próbny. Konta sklepów przychodzą w trybie podglądu; do tego czasu BaseLinker dalej prowadzi zamówienia.">
        <form action={uruchomImport}>
          <PrzyciskPotwierdz
            wariant="glowny"
            powodWylaczenia={powodImportu ?? undefined}
            tytul="Importować dane z BaseLinkera?"
            pytanie={`Do Kompletora trafią produkty (${int(ps?.coPrzejdzie['produkty'] ?? 0)}), oferty, stany startowe, konta sklepów i otwarte zamówienia (${int(ps?.coPrzejdzie['zamowieniaOtwarte'] ?? 0)}). W BaseLinkerze nic się nie zmieni. Powtórny import niczego nie zdubluje.`}
            tak="Importuj"
          >
            Importuj
          </PrzyciskPotwierdz>
        </form>
        {stan.import && stan.import.status !== 'OK' && (
          <Baner ton="blad" tytul={`Import z ${atFmt.format(stan.import.start)} nie przeszedł.`}>
            {stan.import.blad ?? 'Spróbuj jeszcze raz.'}
          </Baner>
        )}
        {stan.import?.raport && (
          <p className="small pz-mt">
            <PobierzRaport id={stan.import.id} tekst={`Pobierz raport importu z ${atFmt.format(stan.import.start)} (Markdown)`} />
          </p>
        )}
      </Karta>

      <Karta
        id="koniec"
        className="pz-mt"
        tytul="5. Koniec przejścia"
        opis="Gdy dane są przeniesione i odchodzisz od BaseLinkera, oznacz przejście jako zakończone. Wtedy włączysz tryb pracy kont sklepów z panelu, bez administratora serwera. Samo oznaczenie niczego nie przełącza."
      >
        {koniec.zakonczone ? (
          <>
            <Baner ton="sukces" tytul={`Przejście z BaseLinkera zakończone ${atFmt.format(new Date(koniec.zakonczone.at))}.`}>
              Tryb pracy kont sklepów włączysz na pulpicie (karta „Stan kanałów”, przycisk „Włącz tryb pracy”) albo na ekranie konta. Import z BaseLinkera jest wyłączony, tryb próbny działa dalej.
            </Baner>
            <form action={cofnijZakonczeniePrzejscia} className="pz-mt">
              <PrzyciskPotwierdz
                wariant="cichy"
                powodWylaczenia={!mozeTryb ? 'Nie masz uprawnienia do zmiany trybu kanału.' : praca.length ? odmowaCofnieciaWPracy(praca) : undefined}
                tytul="Cofnąć zakończenie przejścia?"
                pytanie="Firma znów będzie przechodzić z BaseLinkera: import wróci, a tryb pracy kont włączy dopiero administrator serwera."
                tak="Cofnij"
              >
                Cofnij zakończenie przejścia
              </PrzyciskPotwierdz>
            </form>
          </>
        ) : (
          <form action={zakonczPrzejscieZBl}>
            {koniec.blokady.length > 0 && (
              <ul className="pz-lista small">
                {koniec.blokady.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}
            <PrzyciskPotwierdz
              wariant="drugorzedny"
              powodWylaczenia={!mozeTryb ? 'Nie masz uprawnienia do zmiany trybu kanału.' : koniec.blokady[0]}
              tytul="Zakończyć przejście z BaseLinkera?"
              pytanie={`Kompletor przestanie traktować firmę jako przechodzącą z BaseLinkera: tryb pracy kont włączysz z panelu, a import z BaseLinkera się wyłączy (cofniesz to tym samym ekranem). ${koniec.uwagi.join(' ')}`}
              tak="Zakończ przejście"
            >
              Przejście z BaseLinkera zakończone
            </PrzyciskPotwierdz>
          </form>
        )}
      </Karta>

      {token.zapisany && (
        <Karta
          id="status-bl"
          className="pz-mt"
          tytul="6. Status w BaseLinkerze po wysłaniu"
          opis="BaseLinker dalej pobiera zamówienia ze sklepów. Żeby zamówienia wysłane albo wydane w Kompletorze nie wisiały tam w „Nowe zamówienia”, Kompletor może ustawić im w BaseLinkerze jeden status (np. „Kompletor”). Najpierw utwórz taki status w BaseLinkerze i wpisz tu jego numer. Kompletor nie nadpisuje zamówień, które BaseLinker sam spakował, wysłał, anulował albo zafakturował."
        >
          <form action={zapiszStatusBlFirmy} className="pz-formularz">
            <PoleTekstowe id="pz-status-bl" etykieta="Numer statusu w BaseLinkerze" pomoc="Same cyfry, np. 388071 (w BaseLinkerze: lista statusów zamówień, numer w adresie edycji statusu)." name="statusId" inputMode="numeric" pattern="[0-9]*" maxLength={12} defaultValue={statusBl.statusId ?? ''} />
            <Przelacznik id="pz-status-bl-wl" etykieta="Ustawiaj ten status po wysłaniu albo wydaniu w Kompletorze" name="wlaczony" value="tak" defaultChecked={statusBl.wlaczony} />
            <div>
              <Przycisk type="submit" wariant="drugorzedny">
                Zapisz
              </Przycisk>
            </div>
          </form>
        </Karta>
      )}

      <Karta id="ostatni" className="pz-mt" tytul="Ostatni zapis" opis={d.przebiegow > 0 ? `Zapisów razem: ${d.przebiegow}` : undefined}>
        {!d.ostatni || !st ? (
          <PustyStan tytul="Nic jeszcze nie zapisano">Po imporcie zobaczysz tu, co trafiło do Kompletora, i sprawy do decyzji.</PustyStan>
        ) : (
          <>
            <p className="small pz-bez-marginesu">
              <Odznaka ton={st.ton}>{st.label}</Odznaka> {atFmt.format(d.ostatni.start)}
              {d.ostatni.koniec && ` → ${atFmt.format(d.ostatni.koniec)}`}
            </p>
            {d.ostatni.blad && <Baner ton="blad">{d.ostatni.blad}</Baner>}
            <ListaOpisowa kolumny={2} pozycje={LICZBY_ZAPISU.filter(([k]) => d.ostatni!.liczby[k] !== undefined).map(([k, e]) => ({ klucz: k, etykieta: e, wartosc: String(d.ostatni!.liczby[k] ?? '—') }))} />
            {d.sprawy.length > 0 && (
              <>
                <h3>Sprawy do decyzji {d.sprawWszystkich > LIMIT_SPRAW ? `(pierwsze ${LIMIT_SPRAW} z ${d.sprawWszystkich})` : `(${d.sprawWszystkich})`}</h3>
                <ul className="pz-lista">
                  {d.sprawy.map((s, i) => (
                    <li key={`${s.rodzaj}-${s.ref}-${i}`}>
                      <b>{RODZAJ_SPRAWY[s.rodzaj] ?? s.rodzaj}</b> · <span className="mono">{s.ref}</span>: {s.tresc}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </Karta>

      <div className="pz-mt">
        <Zaawansowane tytul="Dla administratora serwera">
          <p className="small">
            To samo zrobi administrator poleceniem przeprowadzki w kontenerze (Pomoc → Migracja z BaseLinkera); polecenie zapisuje też pełny raport na dysku serwera. Ekran i polecenie korzystają z tej samej logiki, więc raport jest taki sam.
          </p>
        </Zaawansowane>
      </div>
    </>
  )
}
