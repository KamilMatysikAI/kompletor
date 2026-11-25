// Kolejka pakowania: zamówienia przed wysyłką po kurierach, od najbliższego odbioru („od rana najpierw
// DPD, potem InPost”), z „Przyjechał <przewoźnik>”, filtrem strefy i pracą masową na zaznaczonych.
// zakładki ze słownika (bez „naprawdę / na sucho”), tryb raz w nagłówku, „Pakuj” przy zamówieniu i kurierze
// (okno pakowania nad kolejką), lokalizacja i koszyk przy pozycjach, przyciski „Otwórz stanowisko” i „Koszyki”.
import Link from 'next/link'
import { CARRIER_SHORT, countdownText, dayLabel } from '@/lib/pakowanie/harmonogram'
import { isUrgent, zakladkiKolejki, type QueueGroup } from '@/lib/pakowanie/kolejka'
import { arrivalText, isQueueTab, packingQueue, QUEUE_TABS, type QueueRow, type QueueTab } from '@/lib/pakowanie/dane'
import { tekstPodgladu, tekstRaportu } from '@/lib/pakowanie/wyslane-po-przyjezdzie'
import { automatyWysylki } from '@/lib/wysylka/automaty'
import { ZONE_FILTER_ALL, zoneColor, zoneFilterButtons, zoneName, type ZoneDefT } from '@/lib/pakowanie/strefy'
import { accounts } from '@/lib/panel/dane'
import { money, qty, when } from '@/lib/panel/format'
import { isBusinessDay, toWarsaw } from '@/lib/rdzen/kalendarz'
import { requireSession } from '@/lib/panel/kontekst'
import { sesjaZamowien } from '@/lib/stanowisko/cwiczenie'
import { ustawieniaStanowiska } from '@/lib/stanowisko/ustawienia'
import { idZamowien } from '@/lib/stanowisko/zamowienia'
import { Miniatura } from '../_komponenty/miniatura'
import { StanDrukarek } from '../_komponenty/stan-drukarek'
import { KlikalneWiersze } from '../_komponenty/wiersze'
import { przyjechal } from './akcje'
import { NakladkaPakowania } from './nakladka'
import { PrzyjechalPrzycisk, Zaznaczanie, ZaznaczKuriera, ZaznaczoneWKurierze } from './zaznaczanie'
import { PanelKuriera, PrzelacznikKuriera, SekcjaKuriera } from './sekcja-kuriera'
import { CIASTKO_ROZWINIETE, idDoPakowania, kluczKuriera, rozwinieteZ } from '@/lib/pakowanie/zaznaczenie'
import { cookies } from 'next/headers'
import { SkanKolejki } from './skan-kolejki'
import { LinieKuriera, ZamowKuriera } from './kurier'
import { opisZlecenia, stanZamawianiaKuriera, type StanKuriera } from '@/lib/wysylka/zamowienie-kuriera'
import { AKTYWNE_ZLECENIA_KURIERA, domyslnyTerminKuriera, terminWzgledemZlecen } from '@/lib/wysylka/kurier-widok'
import { Baner, NaglowekStrony, Odznaka, PrzyciskLink, PustyStan, StatusZamowienia, Zakladki } from '@/app/ui'
import { SLOWNIK } from '@/lib/panel/slownik'

export const metadata = { title: 'Pakowanie' }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

const PRODUKTY_W_WIERSZU = 3

function shortTitle(t: string): string {
  return t.length > 48 ? `${t.slice(0, 46).trimEnd()}…` : t
}

function Produkt({ l }: { l: QueueRow['lines'][number] }) {
  return (
    <span className="pi" title={[l.title, l.sku, l.lokalizacja ? `półka ${l.lokalizacja}` : null].filter(Boolean).join(' · ')}>
      <Miniatura title={l.title} zdjecie={l.zdjecie} />
      <span className="pn">
        {l.lokalizacja && <span className="lok mono">{l.lokalizacja}</span>} {shortTitle(l.title)}{' '}
        <b className="nowrap">× {l.unit === 'SZT' ? l.qty : qty(l.qty, l.unit)}{l.bundle ? ' (zestaw)' : ''}</b>
      </span>
    </span>
  )
}

// strefy firmy (nazwa i kolor z Ustawienia → Strefy magazynu); firma bez stref nie widzi znaczka
function ZoneChip({ z, zones }: { z: QueueRow['zone']; zones: readonly ZoneDefT[] }) {
  if (!zones.length) return null
  if (z === 'MIESZANE') return <span className="zone zM">mieszane</span>
  if (z) return <span className={`zone z-${zoneColor(zones, z)}`}>{zoneName(zones, z)}</span>
  return <span className="muted small">bez strefy</span>
}

/** Adres okna pakowania nad kolejką dla podanych zamówień. */
const pakujHref = (kolejka: string, ids: string[]) => `${kolejka}${kolejka.includes('?') ? '&' : '?'}pakuj=${encodeURIComponent(ids.join(','))}`

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

/**
 * Zamówienie kuriera u przewoźnika z włączonym „Zamawianie kuriera z Kompletora” (konto przewoźnika, „Zaawansowane”):
 * zamówione podjazdy od dziś (numer zlecenia, godziny) i przycisk z oknem. Bez włączenia pasek wygląda jak dotąd.
 */
function KurierWPasku({ k, label, carrier, dzis, terazMin }: { k: StanKuriera; label: string; carrier: string; dzis: string; terazMin: number }) {
  // zamówiony już podjazd na dzień z harmonogramu (np. automat na jutro): okno podpowiada ten dzień i pyta „drugi raz?”
  const t = terminWzgledemZlecen(domyslnyTerminKuriera(k.propozycja, dzis, terazMin, isBusinessDay(dzis) && k.dzisOdbior, k.regula), k.propozycja?.data ?? null, k.zlecenia)
  const domyslne = { data: t.data, od: t.odMin !== null ? hhmm(t.odMin) : '', do: t.doMin !== null ? hhmm(t.doMin) : '', liczba: k.paczki.liczba, waga: k.paczki.wagaKg }
  // tryb okna (zwykłe / „Ponów nieudany odbiór” / „Zamów drugi raz”) liczy okno dla wybranego dnia: trybOknaKuriera
  // (lib/wysylka/kurier-widok.ts); „nie przyjął” zaznaczone ręcznie liczy się jak aktywne zlecenie
  // w oknie: podjazdy już zamówione od dziś (gdy osoba wybierze w oknie inny dzień niż zamówiony)
  const zamowione = k.zlecenia.filter((z) => z.dzien >= dzis && AKTYWNE_ZLECENIA_KURIERA.includes(z.stan)).map((z) => ({ dzien: z.dzien, opis: opisZlecenia(z, label, dzis) }))
  return (
    <div className="c-group-kurier">
      {/* jedna linia na dzień odbioru, wcześniejsze próby zwinięte, rozstrzyganie niewiadomej */}
      <LinieKuriera zlecenia={k.zlecenia} label={label} dzis={dzis} />
      {/* „Zamawiaj kuriera automatycznie” w koncie przewoźnika: co automat zrobi albo dlaczego nie (przycisk ręczny zostaje) */}
      {k.automat?.opis && <p className="muted small kurier-automat">{k.automat.opis}</p>}
      <ZamowKuriera
        carrier={carrier}
        label={label}
        powod={k.powod}
        domyslne={domyslne}
        zlecenia={k.zlecenia}
        zamowione={zamowione}
        kontekst={{ regula: k.regula, dzis, terazMin, godzinaOdbioruMin: k.propozycja?.odMin ?? null }}
        poPrzesylkach={k.poPrzesylkach}
      />
    </div>
  )
}

function GroupBar({ g, now, canArrive, back, canSettings, canPack, wyslane, kurier }: { g: QueueGroup<QueueRow>; now: Date; canArrive: boolean; back: string; canSettings: boolean; canPack: boolean; wyslane: boolean; kurier?: StanKuriera }) {
  const arrivedToday = !!g.lastArrival && toWarsaw(g.lastArrival.arrivedAt).day === toWarsaw(now).day
  const urgent = isUrgent(g)
  // „Pakuj wszystkie”: niespakowane tego kuriera z tej strony, w kolejności kolejki
  const doPakowania = g.orders.filter((o) => o.status !== 'SPAKOWANE' && o.cwiczenie !== 'SPAKOWANE').map((o) => o.id)
  return (
    <div className={`c-group${urgent ? ' urgent' : ''}`} id={`kurier-${g.carrier ?? 'brak'}`}>
      <div>
        <PrzelacznikKuriera etykieta={g.label} ile={g.orders.filter((o) => o.status !== 'SPAKOWANE').length} />
        {g.pickup && g.schedule ? (
          <>
            {' '}
            · odbiór <span className="mono">{dayLabel(g.pickup.day, g.schedule.pickupMinute, now)}</span>
            {g.pickup.day === toWarsaw(now).day && g.minutesLeft !== null && (
              <>
                {' '}
                · <b className="mono">{countdownText(g.minutesLeft)}</b>
              </>
            )}
          </>
        ) : g.carrier ? (
          <span className="muted">
            {' '}
            · bez godziny odbioru{canSettings && <> (<Link href="/ustawienia/przewoznicy">ustaw</Link>)</>}
          </span>
        ) : null}{' '}
        · zostało <b>{g.toPack}</b>
        {g.packed > 0 && <span className="muted"> · spakowane {g.packed}</span>}
        {g.handedOver > 0 && <span className="muted"> · pojechało {g.handedOver}</span>}
        <ZaznaczoneWKurierze klucz={kluczKuriera(g.carrier)} />
      </div>
      <div className="c-group-akcje">
        {canPack && doPakowania.length > 0 && (
          <PrzyciskLink href={pakujHref(back, doPakowania)} prefetch={false} scroll={false} wariant="drugorzedny">
            Pakuj {g.label} ({doPakowania.length})
          </PrzyciskLink>
        )}
        {arrivedToday ? (
          <>
            <span className="chip leaf">{arrivalText(g.label, g.lastArrival!, g.pickup, g.schedule, now)}</span>
            {/* raport „Przyjechał kurier” = „Wysłane” */}
            {g.lastArrival!.wysylka && <RaportWysylki r={g.lastArrival!.wysylka} />}
          </>
        ) : g.carrier && g.schedule && canArrive ? (
          <form action={przyjechal}>
            <input type="hidden" name="przewoznik" value={g.carrier} />
            <input type="hidden" name="wroc" value={back} />
            <PrzyjechalPrzycisk label={CARRIER_SHORT[g.carrier]} wyslane={wyslane} />
          </form>
        ) : g.lastArrival ? (
          <span className="muted small">{arrivalText(g.label, g.lastArrival, g.pickup, g.schedule, now)}</span>
        ) : null}
      </div>
      {kurier && g.carrier && <KurierWPasku k={kurier} label={CARRIER_SHORT[g.carrier]} carrier={g.carrier} dzis={toWarsaw(now).day} terazMin={Math.floor(toWarsaw(now).msOfDay / 60_000)} />}
    </div>
  )
}

/**
 * ile spakowanych przeszło do „Wysłane” po przyjeździe kuriera, a pominięte z powodem (rozwijane). Przegląd
 * zamówienia sklepów w podglądzie tylko jako jedna linia z liczbą, poza listą pominiętych.
 */
function RaportWysylki({ r }: { r: NonNullable<QueueGroup<QueueRow>['lastArrival']>['wysylka'] & object }) {
  const tekst = tekstRaportu(r)
  const podglad = r.stan === 'ZROBIONE' ? tekstPodgladu(r.wPodgladzie) : null
  const linia = podglad && <span className="muted small">{podglad}</span>
  if (!r.pominiete.length)
    return (
      <>
        <span className={r.stan === 'BLAD' ? 'chip amber' : 'chip'}>{tekst}</span>
        {linia}
      </>
    )
  return (
    <>
      <details className="raport-wysylki small">
        <summary className="chip amber">{tekst}</summary>
        <ul>
          {r.pominiete.map((p, i) => (
            <li key={i}>
              <b className="mono">{p.nr}</b>: {p.powod}
            </li>
          ))}
          {r.pominieto > r.pominiete.length && <li className="muted">i {r.pominieto - r.pominiete.length} więcej</li>}
        </ul>
      </details>
      {linia}
    </>
  )
}

function Wiersze({ rows, now, canPack, back, zones }: { rows: QueueRow[]; now: Date; canPack: boolean; back: string; zones: readonly ZoneDefT[] }) {
  return (
    <table className="tbl cards olist">
      <thead>
        <tr>
          <th className="ck">
            <span className="sr">Zaznacz</span>
          </th>
          <th>Zamówienie</th>
          <th>Status</th>
          <th>Strefa i koszyk</th>
          <th className="right">Kwota</th>
          {canPack && (
            <th>
              <span className="sr">Pakuj</span>
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {rows.flatMap((o) => {
          const href = `/zamowienia/${o.id}`
          const shown = o.lines.slice(0, PRODUKTY_W_WIERSZU)
          const rest = o.lines.slice(PRODUKTY_W_WIERSZU)
          const spakowane = o.status === 'SPAKOWANE' || o.cwiczenie === 'SPAKOWANE'
          return [
            <tr key={o.id} className="orow" data-href={href} tabIndex={0} aria-label={`${o.number}: otwórz zamówienie`}>
              <td className="ck nolabel">
                <label className="ck-l">
                  <input type="checkbox" data-zaznacz value={o.id} aria-label={`Zaznacz ${o.number}`} />
                </label>
              </td>
              <td data-label="Zamówienie">
                <Link className="ord" href={href} title={o.externalId}>
                  {o.number}
                </Link>
                <span className="sub">
                  <span className="ch">{o.accountName}</span> · {when(o.createdAtChannel, now)} · {o.lines.length} poz.
                </span>
              </td>
              <td data-label="Status">
                <StatusZamowienia status={o.status} />
              </td>
              <td data-label="Strefa i koszyk">
                <div className="chips">
                  <ZoneChip z={o.zone} zones={zones} />
                  {o.koszyk && (
                    <Odznaka ton="info" title={`Zamówienie leży w koszyku ${o.koszyk}`}>
                      Koszyk {o.koszyk}
                    </Odznaka>
                  )}
                  {o.cwiczenie === 'SPAKOWANE' && <Odznaka ton="sukces">spakowane próbnie</Odznaka>}
                  {o.cwiczenie === 'NIE_SPAKOWANO' && <Odznaka ton="neutralny">nie spakowano</Odznaka>}
                </div>
              </td>
              <td data-label="Kwota" className="right num">
                {money(o.totalGross, o.waluta)}
              </td>
              {canPack && (
                <td className="nolabel pakuj-kom">
                  {!spakowane && (
                    <PrzyciskLink href={pakujHref(back, [o.id])} prefetch={false} scroll={false} rozmiar="sm" aria-label={`Pakuj ${o.number}`}>
                      Pakuj
                    </PrzyciskLink>
                  )}
                </td>
              )}
            </tr>,
            <tr key={`${o.id}-p`} className="prow-list" data-href={href}>
              <td className="ck nolabel" />
              <td colSpan={canPack ? 5 : 4} data-label="Produkty">
                <span className="prods">
                  {shown.map((l, i) => (
                    <Produkt key={i} l={l} />
                  ))}
                  {rest.length > 0 && (
                    <details className="pmore">
                      <summary aria-label={`Pokaż pozostałe produkty: ${rest.length}`}>+{rest.length}</summary>
                      {rest.map((l, i) => (
                        <Produkt key={i} l={l} />
                      ))}
                    </details>
                  )}
                  {o.lines.length === 0 && <span className="muted">brak pozycji</span>}
                </span>
              </td>
            </tr>,
          ]
        })}
      </tbody>
    </table>
  )
}

export default async function Pakowanie({ searchParams }: Props) {
  const ctx = await requireSession()
  const sp = await searchParams
  const accs = await accounts(ctx.db)
  const anyWork = accs.some((a) => a.active && a.statusMode === 'PRACA')
  const zadana: QueueTab = isQueueTab(one(sp.zakladka)) ? (one(sp.zakladka) as QueueTab) : anyWork ? 'naprawde' : 'na_sucho'
  const page = Math.max(1, Number(one(sp.strona)) || 1)
  const zapytaj = (tab: QueueTab) => packingQueue(ctx.db, { tab, zone: one(sp.strefa) ?? ZONE_FILTER_ALL, page, accounts: accs })
  const [pierwsza, automaty] = await Promise.all([zapytaj(zadana), automatyWysylki(ctx.db)])
  // pusta „Pakowanie próbne” jest ukryta, a jej adres pokazuje „Do spakowania” (bez pustej strony)
  const { zakladka: tab, widoczne: zakladki } = zakladkiKolejki(pierwsza.tabCounts, zadana)
  const q = tab === zadana ? pierwsza : await zapytaj(tab)
  const probne = q.tabCounts.na_sucho > 0
  const zone = q.zone
  const now = q.now
  const qs = (patch: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams()
    const all = { zakladka: tab, strefa: zone, strona: q.page, ...patch }
    for (const [k, v] of Object.entries(all)) {
      if (v === undefined || (k === 'strona' && Number(v) === 1) || (k === 'strefa' && v === ZONE_FILTER_ALL)) continue
      p.set(k, String(v))
    }
    const s = p.toString()
    return s ? `/pakowanie?${s}` : '/pakowanie'
  }
  const back = qs({})
  const canArrive = ctx.permissions.has('pakowanie.kurier')
  const canSettings = ctx.permissions.has('ustawienia')
  const canPack = ctx.permissions.has('pakowanie.stanowisko')
  // zamawianie kuriera: tylko z uprawnieniem do „Przyjechał” i tylko u przewoźników z włączonym zamawianiem w koncie
  const kurier = canArrive && tab !== 'na_sucho' ? await stanZamawianiaKuriera(ctx.db) : new Map<string, StanKuriera>()
  // pola zaznaczenia mają tylko niespakowane (spakowane liczy pasek kuriera)
  const onPage = q.groups.reduce((s, g) => s + idDoPakowania(g.orders).length, 0)
  // rozwinięte sekcje kurierów z ciasteczka (domyślnie wszystkie zwinięte)
  const rozwiniete = new Set(rozwinieteZ((await cookies()).get(CIASTKO_ROZWINIETE)?.value))
  // okno pakowania nad kolejką: bez uprawnienia stanowiska parametr nic nie otwiera
  const pakuj = canPack ? idZamowien(sp.pakuj) : []
  const [sesjaPakowania, ustawieniaPakowania] = pakuj.length ? await Promise.all([sesjaZamowien(ctx.db, pakuj), ustawieniaStanowiska(ctx.db)]) : [null, null]
  const podtytul =
    tab === 'na_sucho'
      ? `${SLOWNIK.pakowanieProbne}: ${q.zoneCounts.wszystkie} zamówień. Sklep i stany bez zmian, ćwiczenie przed przejściem.`
      : tab === 'etykiety'
        ? 'Zamówienia spakowane, którym brakuje etykiety przewoźnika.'
        : `${q.zoneCounts.wszystkie} do spakowania · kurierzy od najbliższego odbioru`
  return (
    <>
      <NaglowekStrony
        tytul="Pakowanie"
        podtytul={podtytul}
        akcje={
          <>
            {canPack && (
              <>
                <PrzyciskLink href="/stanowisko" wariant="glowny">
                  Otwórz stanowisko
                </PrzyciskLink>
                <PrzyciskLink href="/pakowanie/koszyki">Koszyki</PrzyciskLink>
              </>
            )}
            <StanDrukarek />
          </>
        }
      />

      {q.exampleSchedules && (
        <Baner ton="ostrzezenie">
          Część godzin odbiorów jest <b>przykładowa</b> — firma jeszcze ich nie potwierdziła.{' '}
          {canSettings ? <Link href="/ustawienia/przewoznicy">Popraw w ustawieniach przewoźników</Link> : 'Poprawia je osoba z uprawnieniem do ustawień firmy.'}
        </Baner>
      )}
      {q.truncated && (
        <Baner ton="blad">
          Zamówień przed wysyłką jest więcej niż kolejka pokazuje naraz: widać najstarsze, a <b>{q.hidden}</b> najnowszych się nie zmieściło. Pełna lista w Zamówieniach.
        </Baner>
      )}

      {tab === 'naprawde' && q.konczyBl.length > 0 && (
        <Baner ton="ostrzezenie">
          <b>{q.konczyBl.length}</b> {q.konczyBl.length === 1 ? 'zamówienie ma' : 'zamówień ma'} fakturę z BaseLinkera: kończy je BaseLinker, w Kompletorze ich nie pakuj (są poza kolejką, pakowanie wstrzymane).
          Na karcie zamówienia: „Więcej” → „Zmień status…” → „Do wyjaśnienia” z notatką „kończy BL”. Szczegóły w Pomocy: <Link href="/pomoc/migracja-z-baselinkera">przejście z BaseLinkera</Link>.{' '}
          {q.konczyBl.slice(0, 50).map((z, i) => (
            <span key={z.id}>
              {i > 0 && ', '}
              <Link href={`/zamowienia/${z.id}`}>{z.number}</Link> <span className="muted small">({z.faktura})</span>
            </span>
          ))}
          {q.konczyBl.length > 50 && ` i ${q.konczyBl.length - 50} więcej`}
        </Baner>
      )}

      <Zakladki
        etykieta="Zakładki kolejki"
        zakladki={zakladki.map((t) => ({ href: qs({ zakladka: t, strona: undefined, strefa: undefined }), etykieta: QUEUE_TABS[t], licznik: q.tabCounts[t], aktywna: t === tab }))}
      />

      {tab === 'etykiety' ? (
        <PustyStan tytul="Tu będą zamówienia czekające na etykietę">
          Etykietę tworzy przycisk „Utwórz przesyłkę” zaraz po „Spakowano” na stanowisku albo na karcie zamówienia. Osobnej listy zamówień bez etykiety jeszcze nie ma.
        </PustyStan>
      ) : (
        <>
          {q.zones.length > 0 && (
            <div className="zones" role="group" aria-label="Strefa magazynu">
              <span className="lbl">Strefa:</span>
              {zoneFilterButtons(q.zones, q.zoneCounts).map((f) => (
                <Link key={f.value} className="btn small" href={qs({ strefa: f.value, strona: undefined })} aria-pressed={f.value === zone}>
                  {f.color ? <span className={`zone z-${f.color}`}>{f.label}</span> : f.label}
                  <span className="cnt mono">{f.count}</span>
                </Link>
              ))}
              {q.zoneCounts.bez > 0 && <span className="muted small">bez strefy: {q.zoneCounts.bez}</span>}
            </div>
          )}

          {q.groups.length === 0 ? (
            <PustyStan
              tytul="Nic do spakowania"
              akcja={tab === 'naprawde' && !anyWork && probne ? <PrzyciskLink href={qs({ zakladka: 'na_sucho', strona: undefined, strefa: undefined })}>{SLOWNIK.pakowanieProbne}</PrzyciskLink> : undefined}
            >
              {tab === 'naprawde' && !anyWork && probne
                ? `Żadne konto sprzedaży nie jest jeszcze aktywne. Zamówienia z kont „${SLOWNIK.tylkoPodglad}” są w zakładce „${SLOWNIK.pakowanieProbne}”.`
                : 'Zamówienia do realizacji pojawią się tu same, pogrupowane po kurierach.'}
            </PustyStan>
          ) : (
            <Zaznaczanie key={JSON.stringify(sp)} naStronie={onPage} canPack={canPack} tuKolejka={back} idsKuriera={q.idsKuriera}>
              <KlikalneWiersze>
                {q.groups.map((g) => {
                  const klucz = kluczKuriera(g.carrier)
                  const wszystkich = q.idsKuriera[klucz]?.length ?? null
                  return (
                    // sekcja kuriera domyślnie zwinięta; pasek z przyciskami kuriera widać zawsze
                    <SekcjaKuriera key={klucz} klucz={klucz} etykieta={g.label} otwartaNaStart={rozwiniete.has(klucz)}>
                      <GroupBar g={g} now={now} canArrive={canArrive} back={back} canSettings={canSettings} canPack={canPack} wyslane={automaty.wyslanePoPrzyjezdzie} kurier={g.carrier ? kurier.get(g.carrier) : undefined} />
                      <PanelKuriera>
                        {/* 19.11.2026: spakowane naprawdę nie stoją na liście do pakowania; ich liczbę pokazuje pasek kuriera („spakowane N”) */}
                        {g.orders.some((o) => o.status !== 'SPAKOWANE') ? (
                          <>
                            <ZaznaczKuriera klucz={klucz} etykieta={g.label} wszystkich={wszystkich} />
                            <Wiersze rows={g.orders.filter((o) => o.status !== 'SPAKOWANE')} now={now} canPack={canPack} back={back} zones={q.zones} />
                          </>
                        ) : g.orders.length > 0 ? (
                          <p className="muted small">Wszystko spakowane: paczki czekają na kuriera.</p>
                        ) : (
                          <p className="muted small">{zone === ZONE_FILTER_ALL ? 'Brak zamówień do tego odbioru.' : 'Brak zamówień w tej strefie.'}</p>
                        )}
                      </PanelKuriera>
                    </SekcjaKuriera>
                  )
                })}
              </KlikalneWiersze>
            </Zaznaczanie>
          )}

          {q.pages > 1 && (
            <nav className="pager" aria-label="Strony">
              {q.page > 1 ? <PrzyciskLink href={qs({ strona: q.page - 1 })}>Poprzednia</PrzyciskLink> : <span />}
              <span className="muted small">
                strona {q.page} z {q.pages} · {q.total} zamówień
              </span>
              {q.page < q.pages ? <PrzyciskLink href={qs({ strona: q.page + 1 })}>Następna</PrzyciskLink> : <span />}
            </nav>
          )}
        </>
      )}
      {/* skan karty albo koszyka bez otwartego okna otwiera okno pakowania (przy otwartym łapie je okno) */}
      {canPack && !sesjaPakowania && <SkanKolejki kolejka={back} />}
      {sesjaPakowania && ustawieniaPakowania && (
        <NakladkaPakowania key={pakuj.join(',')} sesjaStart={sesjaPakowania} ustawienia={ustawieniaPakowania} kto={ctx.user.name} firma={ctx.organization.name} powrot={back} />
      )}
    </>
  )
}
