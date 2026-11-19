// Nagłówek karty zamówienia: numer, kanał i konto, data, status słowem z kolorem, kwota, paczki,
// przyciski główne z „Co dalej” (ta sama lista `dostepnePrzejscia`) i menu „Więcej” z resztą akcji.
// Menu na komponentach app/ui (`MenuAkcji`): działa bez JavaScriptu, pozycje po 44 px. Konto w cieniu: zamiast
// przycisków jedna linia. Konto poza trybem PRACA widzi te same przyciski „Co dalej” i „Zmień status…”
// nieaktywne, z jednym powodem pod grupą (zasada fal: funkcja widoczna, nie ukryta); bramki serwera bez zmian.
// (wzór układu TwojOMS, MIT): nagłówek = numer, status, klient, kwota, akcja główna, „Wydruki” i „Więcej”.
// Kanał, numery w sklepie i w BaseLinkerze, paczki, daty i źródło przeszły do karty „Szczegóły zamówienia”
// (szczegoly.tsx), każda informacja raz. „Drukuj kartę” i „Pobierz PDF karty” są w osobnym menu „Wydruki”.
import Link from 'next/link'
import type { DaneKarty } from '@/lib/karta/dane'
import { numeryKarty } from '@/lib/karta/opis'
import { channelPrefix, money } from '@/lib/panel/format'
import { DrukujKarte } from './drukuj-karte'
import { KopiujDane } from './kopiuj'
import { PrzyciskiCoDalej } from './praca'
import { ZmianaStatusu } from './status-dowolny'
import { GrupaMenu, klasyPrzycisku, MenuAkcji, POZYCJA_MENU, Przycisk, PrzyciskLink, StatusZamowienia } from '@/app/ui'
import type { EtykietaStatusuFirmy } from '@/lib/panel/statusy'

// numer jak w kanale albo w BL zamiast uciętego UUID, klient obok numeru (pełne imię i nazwisko z
// `klienci.dane`, skrót z `klienci.skrot`; tekst liczy page.tsx z jednego odczytu danych klienta) i strzałki do
// sąsiednich zamówień w kolejności listy.
export function Naglowek({ d, uprawnienia, klient, statusFirmy }: { d: DaneKarty; uprawnienia: ReadonlySet<string>; klient: string | null; statusFirmy?: EtykietaStatusuFirmy | null }) {
  const { o } = d
  const numer = numeryKarty(o, d.linkKanalu)
  const prefiks = channelPrefix(o.channel, d.nazwaKonta)
  const nr = `${prefiks} ${numer.numer}`
  // ten sam warunek co formularz podziału pod pozycjami (pozycje.tsx), żeby link nie prowadził donikąd
  const podzial = d.praca && d.edycja.powodStatusu === null && !d.edycja.podzialPoEtykiecie && uprawnienia.has('zamowienia.podzial') && o.status === 'DO_REALIZACJI' && (o.paymentState === 'PAID' || o.paymentState === 'COD') && o.lines.some((l) => !l.removed)
  // w menu powód raz; gdy nad „Zmień status…” są nieaktywne przyciski „Co dalej” z powodem, tu go nie powtarzamy
  const pd = d.podglad?.coDalej
  const wMenuPodglad = pd ? pd.przyciski.length - pd.przyciski.filter((p) => p.glowny).slice(0, 3).length : 0
  return (
    <header className="page-head kz-head">
      <div className="kz-tytul">
        <h1>
          {numer.linkWTytule && d.linkKanalu ? (
            <>
              {prefiks}{' '}
              <a href={d.linkKanalu} target="_blank" rel="noopener noreferrer" title="Otwórz zamówienie w kanale">
                {numer.numer}
              </a>
            </>
          ) : (
            nr
          )}{' '}
          {/* przewoźnik raz, w karcie „Wysyłka”; w tytule sam status */}
          <StatusZamowienia status={o.status} firmy={statusFirmy} />
        </h1>
        {klient && <p className="kz-klient">{klient}</p>}
      </div>
      <div className="kz-akcje">
        <nav className="kz-strzalki" aria-label="Sąsiednie zamówienia">
          {d.sasiedzi.poprzednie ? (
            <Link className="btn ghost" href={`/zamowienia/${d.sasiedzi.poprzednie}`} aria-label="Poprzednie zamówienie (nowsze)" title="Poprzednie zamówienie (nowsze)">
              ←
            </Link>
          ) : (
            <span className="btn ghost" aria-disabled="true" title="To najnowsze zamówienie">
              ←
            </span>
          )}
          {d.sasiedzi.nastepne ? (
            <Link className="btn ghost" href={`/zamowienia/${d.sasiedzi.nastepne}`} aria-label="Następne zamówienie (starsze)" title="Następne zamówienie (starsze)">
              →
            </Link>
          ) : (
            <span className="btn ghost" aria-disabled="true" title="To najstarsze zamówienie">
              →
            </span>
          )}
        </nav>
        <div className="kz-kwota num">
          <b>{money(o.totalGross)}</b> <span className="muted small">brutto</span>
        </div>
        {d.coDalej && <PrzyciskiCoDalej orderId={o.id} stan={d.coDalej} filtr="glowne" />}
        {d.podglad?.coDalej && <PrzyciskiCoDalej orderId={o.id} stan={d.podglad.coDalej} filtr="glowne" wspolnyPowod={d.podglad.powody.status} />}
        {uprawnienia.has('pakowanie.stanowisko') && (
          <MenuAkcji etykieta="Wydruki" opis="Wydruki zamówienia">
            <DrukujKarte orderId={o.id} />
          </MenuAkcji>
        )}
        <MenuAkcji opis="Więcej akcji zamówienia">
            {d.coDalej && (
              <GrupaMenu>
                <PrzyciskiCoDalej orderId={o.id} stan={d.coDalej} filtr="pozostale" />
              </GrupaMenu>
            )}
            {d.podglad?.coDalej && (
              <GrupaMenu>
                <PrzyciskiCoDalej orderId={o.id} stan={d.podglad.coDalej} filtr="pozostale" wspolnyPowod={d.podglad.powody.status} />
              </GrupaMenu>
            )}
            {d.praca && uprawnienia.has('zamowienia.status_dowolny') && <ZmianaStatusu orderId={o.id} />}
            {d.podglad && uprawnienia.has('zamowienia.status_dowolny') && (
              <GrupaMenu>
                <div className="ui-akcja">
                  <Przycisk wariant="cichy" className={POZYCJA_MENU} powodWylaczenia={d.podglad.powody.status} aria-describedby={wMenuPodglad ? 'cd-podglad-pozostale' : 'zs-podglad'}>
                    Zmień status…
                  </Przycisk>
                  {!wMenuPodglad && (
                    <p id="zs-podglad" className="ui-akcja-powod">
                      {d.podglad.powody.status}
                    </p>
                  )}
                </div>
              </GrupaMenu>
            )}
            <KopiujDane orderId={o.id} numer={`${nr} (${o.externalId})`} daneKlienta={uprawnienia.has('klienci.dane')} />
            {d.linkKanalu && (
              <GrupaMenu>
                <a className={klasyPrzycisku('cichy', 'md', POZYCJA_MENU)} href={d.linkKanalu} target="_blank" rel="noopener noreferrer">
                  Otwórz w kanale
                </a>
              </GrupaMenu>
            )}
            <GrupaMenu>
              {podzial && (
                <a className={klasyPrzycisku('cichy', 'md', POZYCJA_MENU)} href="#podzial">
                  Podziel zamówienie
                </a>
              )}
              {/* zwrot i reklamacja zakładane w Kompletorze (formularz z pozycjami zamówienia) */}
              {uprawnienia.has('zwroty.przyjecie') ? (
                <>
                  <PrzyciskLink wariant="cichy" className={POZYCJA_MENU} href={`/zwroty/nowy?zamowienie=${o.id}`}>
                    Stwórz zwrot
                  </PrzyciskLink>
                  <PrzyciskLink wariant="cichy" className={POZYCJA_MENU} href={`/zwroty/nowy?zamowienie=${o.id}&typ=reklamacja`}>
                    Zgłoś reklamację
                  </PrzyciskLink>
                </>
              ) : (
                <Przycisk wariant="cichy" className={POZYCJA_MENU} powodWylaczenia="Brak uprawnienia „Zwroty i reklamacje: zgłoszenie”">
                  Stwórz zwrot
                </Przycisk>
              )}
              <PrzyciskLink wariant="cichy" className={POZYCJA_MENU} href={`/zwroty?zamowienie=${o.id}`}>
                Zwroty tego zamówienia
              </PrzyciskLink>
            </GrupaMenu>
        </MenuAkcji>
      </div>
    </header>
  )
}
