import Link from 'next/link'
import { dashboard, warsawRanges } from '@/lib/panel/dane'
import { int, longDay, money, outsideCoreNote, SALES_COUNT_CANCELLED, time, when } from '@/lib/panel/format'
import { requireSession } from '@/lib/panel/kontekst'
import { toWarsaw } from '@/lib/rdzen/kalendarz'
import { WykresMiesiaca } from '../_komponenty/wykres-miesiaca'
import { firmaMaBlWPanelu, firmaMaWfirme, firmaPrzechodziZBlWPanelu } from '@/lib/kanaly/firma'
import { blokadaInstancji } from '@/lib/kanaly/tryb'
import { stanWlasnejFirmy } from '@/lib/instalacja/kreator'
import { listaStartu } from '@/lib/start/lista'
import { trybFirmy } from '@/lib/start/tryb-firmy'
import { Karta, PrzyciskLink, PustyStan, Przycisk, TrybKanalu } from '@/app/ui'
import { ToastZAdresu } from '../ustawienia/kanaly/toast-z-adresu'
import { wlaczTrybPracy } from './akcje'
import { ListaStartuKarta, ListaStartuSchowana } from './lista-startu'
import { WlasnaFirma } from './wlasna-firma'
import './pulpit.css'

export const metadata = { title: 'Pulpit' }

/** Alerty, które każą kliknąć „Poprawione w wFirmie”: link do listy z tym przyciskiem (Braki towaru → Do poprawy w wFirmie). */
const ALERT_DO_POPRAWY: readonly string[] = ['FAKTURA_BEZ_WZ', 'BRAK_NA_POLCE', 'USZKODZONE_DO_RW']

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

export default async function Pulpit({ searchParams }: Props) {
  const ctx = await requireSession()
  const sp = await searchParams
  const now = new Date()
  // hasBl: porównanie z BL tylko dla firm z BL (także sam klucz); zBl: bramka trybu pracy liczy ślad
  // przejścia z BL, nie sam klucz zapisany w panelu
  const [d, hasBl, zBl, maWfirme] = await Promise.all([dashboard(ctx.db, now), firmaMaBlWPanelu(ctx.db), firmaPrzechodziZBlWPanelu(ctx.db), firmaMaWfirme(ctx.db)])
  // lista startu i tryb pracy firmy (ustawienia firmy, więc tylko z uprawnieniem `ustawienia`); demo → własna firma
  const ustawienia = ctx.permissions.has('ustawienia')
  const [lista, tryb, wlasna] = await Promise.all([
    ustawienia ? listaStartu(ctx.db, { firmaZBl: zBl, kluczBl: hasBl, trybPracyZablokowany: blokadaInstancji(process.env, zBl) !== null, now }) : Promise.resolve(null),
    trybFirmy(ctx.db, zBl, process.env),
    stanWlasnejFirmy({ userId: ctx.user.id, organizationId: ctx.organization.organizationId, rola: ctx.organization.role }),
  ])
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.slice(0, 500) ?? null
  const r = warsawRanges(now)
  const [y, m] = toWarsaw(now).day.split('-').map(Number) as [number, number]
  const maxToday = Math.max(1, ...d.today.perAccount.map((a) => a.count))
  const w = d.work
  const work = [
    { n: w.toPack, tone: '', t: 'Do spakowania', desc: 'do realizacji, zbierane i zebrane', href: '/zamowienia?widok=do_spakowania', chip: ['leaf', 'pakowanie'] },
    {
      n: w.shortageLines,
      tone: 'red',
      t: `Pozycji brakuje (zamówień: ${w.shortageOrders})`,
      desc: 'przy otwartych zamówieniach: czekają na dostawę albo decyzję (wyślij resztę, dośle, poczekaj)',
      href: '/braki',
      chip: ['red', 'brakuje'],
    },
    { n: w.clarify, tone: 'violet', t: 'Do wyjaśnienia', desc: 'nieznana metoda dostawy, oferta bez produktu, zmiana po anulowaniu', href: '/zamowienia?widok=do_wyjasnienia', chip: ['violet', 'do wyjaśnienia'] },
    { n: w.unpaid, tone: 'amber', t: 'Nieopłacone z rezerwacją', desc: 'towar wraca na stan po terminie płatności', href: '/zamowienia?widok=nieoplacone', chip: ['amber', 'czeka na płatność'] },
    { n: w.invoiceFailed, tone: 'red', t: 'Faktura się nie wystawiła', desc: maWfirme ? 'zamówienia z nieudaną próbą faktury w wFirmie' : 'zamówienia z nieudaną próbą wystawienia dokumentu sprzedaży', href: '/zamowienia?widok=blad_faktury', chip: ['red', 'błąd faktury'] },
    // wiersz wFirmy tylko dla firmy z wFirmą (nazwy integracji tylko tam, gdzie firma ją ma)
    ...(maWfirme
      ? [
          {
            n: w.wfirmaFix + w.overcommit,
            tone: '',
            t: 'Do poprawy w wFirmie i nadmiar rezerwacji',
            desc: `do poprawy w wFirmie: ${w.wfirmaFix} · produkty z nadmiarem rezerwacji: ${w.overcommit}`,
            href: '/braki?lista=wfirma',
            chip: ['blue', 'biuro'],
          } as const,
        ]
      : []),
  ]
  // jest co robić (choć jeden licznik > 0) → kafle pracy idą przed listą uruchomienia
  const maPrace = work.some((x) => x.n > 0)
  const todayNote = outsideCoreNote(d.today.outside)
  const outsideOf = (o: typeof d.today.outside) => o.beforeStart + o.notIngested + o.skipped
  const outsideAccs = d.today.perAccount.filter((a) => outsideOf(a.outside) > 0)
  const failing = d.channels.filter((c) => c.active && c.stockMode === 'PRACA' && c.failingSince)
  return (
    <>
      <header className="page-head">
        <div>
          <h1>{longDay(now)}</h1>
          <div className="sub">
            Dane z {time(now)} · firma {ctx.organization.name}
          </div>
        </div>
        <div className="actions">
          <Link className="btn" href="/zamowienia">
            Wszystkie zamówienia
          </Link>
        </div>
      </header>

      <ToastZAdresu sukces={one(sp.tryb) ?? (sp.firma === 'nowa' ? `Firma ${ctx.organization.name} założona. Zacznij od listy uruchomienia.` : null)} blad={one(sp.trybBlad)} />
      {wlasna.dostepny && <WlasnaFirma />}
      {/* lista uruchomienia jest pierwsza tylko, dopóki nie ma żadnej pracy; firma z zamówieniami w toku
          widzi najpierw „Do zrobienia teraz”, a lista schodzi pod kafle */}
      {lista && !maPrace && <ListaStartuKarta lista={lista} firmaZBl={zBl || hasBl} />}
      {lista && !maPrace && <ListaStartuSchowana lista={lista} />}

      {sp.firma === 'brak-dostepu' && (
        <div className="banner amber" role="alert">
          <div>Nie masz dostępu do wybranej firmy. Zostajesz w firmie {ctx.organization.name}.</div>
        </div>
      )}

      {d.shadow.notReading > 0 && (
        <div className="banner red" role="alert">
          <div>
            <b>
              Odczyt zamówień nie działa: {d.shadow.notReading} z {d.shadow.accounts} kont ({d.shadow.notReadingNames.join(', ')}).
            </b>{' '}
            Brak udanego odczytu zamówień od ponad 15 minut albo błąd konfiguracji konta. Do czasu naprawy nowe zamówienia z tych kont nie rezerwują towaru.
          </div>
        </div>
      )}

      {failing.map((c) => (
        <div key={`${c.channel}:${c.channelAccountId}`} className="banner red" role="alert">
          <div>
            <b>
              {c.name} nie przyjmuje zmian stanów od {when(c.failingSince!, now)}.
            </b>{' '}
            To konto jest aktywne, więc stany wysyła tam Kompletor. Dopóki to trwa, oferty z ostatnimi sztukami mogą sprzedać się drugi raz.
          </div>
        </div>
      ))}

      <section className="pulpit-praca" aria-labelledby="h-work">
        <div className="card-head">
          <h2 id="h-work">Do zrobienia teraz</h2>
          <span className="muted small">kliknij kafel, żeby przejść do listy</span>
        </div>
        <ul className="work work-kafle">
          {work.map((x) => (
            <li key={x.t} data-ton={x.n > 0 ? x.chip[0] : 'zero'}>
              <Link href={x.href}>
                <span className={`n ${x.n > 0 ? x.tone : ''}`}>{int(x.n)}</span>
                <span className="t">{x.t}</span>
                <span className="d">{x.desc}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {lista && maPrace && <ListaStartuKarta lista={lista} firmaZBl={zBl || hasBl} />}
      {lista && maPrace && <ListaStartuSchowana lista={lista} />}

      <div className="grid g-main pulpit-wyniki">
        <WykresMiesiaca now={now} month={d.month} totals={d.monthTotals} today={r.today} miara={sp.miara === 'kwota' ? 'kwota' : 'liczba'} monthIndex={m} year={y} />

        <div className="stack">
          <section className="card" aria-labelledby="h-dzis">
            <div className="card-head">
              <h2 id="h-dzis">Dziś</h2>
              <span className="muted small">od 00:00 do {time(now)}</span>
            </div>
            <p className="today-sum">
              <b className="big">{int(d.today.count)}</b> <span className="muted">zamówień</span> <b className="big">{money(d.today.gross)}</b>{' '}
              <span className="muted">brutto</span>
            </p>
            {todayNote && (
              <p className="small muted" style={{ marginTop: 0 }}>
                {todayNote}
                {d.today.perAccount.length > 1 && outsideAccs.length > 0 && ` · ${outsideAccs.map((a) => `${a.name}: ${int(outsideOf(a.outside))}`).join(', ')}`}
              </p>
            )}
            {d.today.perAccount.length > 0 ? (
              <div className="bars bars4">
                {d.today.perAccount.map((a) => (
                  <div key={a.key} style={{ display: 'contents' }}>
                    <span>{a.name}</span>
                    <span className="bar" aria-hidden="true">
                      <i style={{ width: `${Math.round((a.count / maxToday) * 100)}%` }} />
                    </span>
                    <span className="v">{a.count}</span>
                    <span className="a num">{money(a.gross)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted small">Dziś nie ma jeszcze zamówień. Pojawią się tu po podłączeniu sklepu albo po dodaniu zamówienia ręcznie.</p>
            )}
            <p className="small muted" style={{ marginTop: 8, marginBottom: 0 }}>
              Pasek = liczba zamówień złożonych dziś w kanale (także zrealizowanych, zanim system zaczął czytać konto{SALES_COUNT_CANCELLED ? '' : '; bez anulowanych'}); kwota brutto obok, z kosztem wysyłki zapłaconym przez klienta.
            </p>
          </section>

          <Karta
            id="stan-kanalow"
            tytul="Stan kanałów"
            opis={
              tryb.konta.length === 0
                ? 'Firma nie ma jeszcze podłączonego sklepu.'
                : tryb.wPodgladzie === 0
                  ? 'Wszystkie konta są aktywne: Kompletor prowadzi zamówienia.'
                  : `Tylko podgląd: ${tryb.wPodgladzie} z ${tryb.konta.length}. Konto w podglądzie czyta zamówienia i rezerwuje towar, ale niczego w sklepie nie zmienia.`
            }
          >
            {tryb.konta.length > 0 && (
              <ul className="st-konta">
                {tryb.konta.map((k) => (
                  <li key={k.nazwa}>
                    <span>{k.nazwa}</span>
                    <TrybKanalu tryb={k.tryb} rozmiar="sm" />
                  </li>
                ))}
              </ul>
            )}
            <div className="actions">
              {tryb.konta.length === 0 ? (
                <PrzyciskLink href="/ustawienia/kanaly/nowy" wariant="glowny" rozmiar="sm">
                  Dodaj sklep
                </PrzyciskLink>
              ) : (
                tryb.wPodgladzie > 0 &&
                ustawienia && (
                  <form action={wlaczTrybPracy}>
                    <Przycisk type="submit" wariant="glowny" rozmiar="sm" powodWylaczenia={tryb.blokada ?? (ctx.permissions.has('kanaly.tryb') ? undefined : 'Nie masz uprawnienia do zmiany trybu kanału')}>
                      Włącz tryb pracy
                    </Przycisk>
                  </form>
                )
              )}
              {hasBl && (
                <PrzyciskLink href="/rozjazdy" wariant="drugorzedny" rozmiar="sm">
                  Porównanie z BaseLinkerem
                </PrzyciskLink>
              )}
              {hasBl && (
                <PrzyciskLink href="/akcje" wariant="cichy" rozmiar="sm">
                  Maile do klientów: podgląd
                </PrzyciskLink>
              )}
            </div>
            {tryb.blokada && tryb.wPodgladzie > 0 && (
              <p className="small muted st-mt">
                {tryb.blokada} <Link href="/pomoc/tryb-praca">Jak działa tryb pracy</Link>
              </p>
            )}
          </Karta>
        </div>
      </div>

      {d.alerts.length > 0 && (
        <section className="card" aria-labelledby="h-alerty" style={{ marginTop: 16 }}>
          <div className="card-head">
            <h2 id="h-alerty">Sytuacje do obsługi</h2>
            <span className="muted small">ostatnie {d.alerts.length}</span>
          </div>
          <ul className="plain">
            {d.alerts.map((a) => (
              <li key={a.id}>
                <span className="mono small muted">{when(a.createdAt, now)}</span> {a.message}
                {ALERT_DO_POPRAWY.includes(a.kind) && (
                  <>
                    {' '}
                    <Link href="/braki?lista=wfirma">Do poprawy w wFirmie</Link>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card" aria-labelledby="h-kanaly" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h2 id="h-kanaly">Kanały</h2>
        </div>
        {d.channels.length === 0 ? (
          <PustyStan
            tytul="Nie ma jeszcze kanałów sprzedaży"
            akcja={
              <PrzyciskLink href="/ustawienia/kanaly/nowy" wariant="glowny">
                Dodaj sklep
              </PrzyciskLink>
            }
          >
            Podłącz sklep internetowy, Allegro albo Empik. Zamówienia bez sklepu dodasz ręcznie w Zamówienia → Dodaj zamówienie.
          </PustyStan>
        ) : (
          <table className="tbl cards">
            <thead>
              <tr>
                <th>Kanał</th>
                <th>Stany</th>
                <th>Statusy</th>
                <th>Zamówienia odczytane</th>
                <th>Wysyłka stanów</th>
              </tr>
            </thead>
            <tbody>
              {d.channels.map((c) => (
                <tr key={`${c.channel}:${c.channelAccountId}`}>
                  <td data-label="Kanał">
                    <b>{c.name}</b> {!c.active && <span className="chip">wyłączony</span>}
                  </td>
                  <td data-label="Stany">
                    <TrybKanalu tryb={c.stockMode} rozmiar="sm" />
                  </td>
                  <td data-label="Statusy">
                    <TrybKanalu tryb={c.statusMode} rozmiar="sm" />
                  </td>
                  <td data-label="Odczyt">{c.lastPollAt ? `${when(c.lastPollAt, now)} · ${c.lastPollOk ? 'OK' : 'błąd'}` : <span className="muted">jeszcze nie czytany</span>}</td>
                  <td data-label="Wysyłka">
                    {c.failingSince ? (
                      <span className="chip red">nie przyjmuje od {when(c.failingSince, now)}</span>
                    ) : c.lastOkAt ? (
                      `${c.stockMode === 'CIEN' ? 'podgląd: ' : ''}${when(c.lastOkAt, now)}`
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  )
}
