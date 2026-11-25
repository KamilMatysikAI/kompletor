// Ekran konta kanału → sekcja „Zapis do sklepu”: co Kompletor wysyła do sklepu (stany, statusy, numery
// nadania), dlaczego coś nie wychodzi, mapa statusów (edytowalna), ostatnie zapisy z błędami i „Wypchnij teraz”.
// przełącznik „Zapis do sklepu” tutaj (nie pole w „Zaawansowane”), konto tylko do odczytu
// dostaje samą informację i przełączenie wersji. Klasy z app/panel.css i app/ui, bez własnych stylów. Bez danych klientów: numery zamówień, statusy i numery nadania.
import Link from 'next/link'
import type { EkranZapisu } from '@/lib/kanaly/zapis-host'
import { ETYKIETY_KLUCZY } from '@/lib/kanaly/zapis-host'
import { POWOD_ETAPU_POZA_SKLEPEM, STATUS_MAP_KEYS } from '@/lib/adaptery/kontrakt'
import { int, STATUS_LABEL, when } from '@/lib/panel/format'
import { mozna, type Warunek } from '@/lib/kanaly/tryb'
import { Przycisk, PrzyciskPotwierdz } from '@/app/ui'
import { ustawWystawianie, ustawZapis } from '../akcje'
import { Warunki } from './warunki'
import { przelaczNaOdczyt, przelaczNaZapis, wypchnijTerazKonto, wyslijStanyPonownieKonto, zapiszMapeStatusowKonta, zapiszPelnyZapisKonta } from './zapis-akcje'
import { PELNY_ZAPIS_MAX_GODZ, PELNY_ZAPIS_MIN_GODZ } from '@/lib/kanaly/rejestr-synchronizacji'

const TRYB = (m: 'CIEN' | 'PRACA') => (m === 'PRACA' ? 'aktywny' : 'podgląd')

function Wiersz({ nazwa, tryb, powod }: { nazwa: string; tryb: 'CIEN' | 'PRACA'; powod: string | null }) {
  return (
    <>
      <dt>{nazwa}</dt>
      <dd>
        <span className={`chip ${powod ? 'amber' : 'leaf'}`}>{powod ? 'nie wychodzi' : 'wysyłamy'}</span> <span className="muted small">tryb {TRYB(tryb)}</span>
        {powod && <span className="muted small"> · {powod}</span>}
      </dd>
    </>
  )
}

/** Przełącznik „Zapis do sklepu”: jedno miejsce wyłącznika, z warunkami i potwierdzeniem. */
function PrzelacznikZapisu({ kod, wlaczony, warunki, uprawnienie }: { kod: string; wlaczony: boolean; warunki: readonly Warunek[]; uprawnienie: boolean }) {
  const brakUprawnienia = uprawnienie ? undefined : 'Nie masz uprawnienia do zmiany trybu kanału'
  return (
    <div className="kn-przelacznik">
      <p>
        <b>Zapis do sklepu: {wlaczony ? 'włączony' : 'wyłączony'}.</b>{' '}
        {wlaczony
          ? 'Kompletor wysyła do sklepu stany, statusy i numery nadania, gdy konto jest w trybie pracy.'
          : 'Kompletor niczego do sklepu nie wysyła, nawet w trybie pracy.'}
      </p>
      <form action={ustawZapis}>
        <input type="hidden" name="konto" value={kod} />
        <input type="hidden" name="zapis" value={wlaczony ? 'nie' : 'tak'} />
        {wlaczony ? (
          <PrzyciskPotwierdz
            tytul="Wyłączyć zapis do sklepu?"
            pytanie="Kompletor przestanie wysyłać do sklepu stany, statusy i numery nadania. Zamówienia i ustawienia zostają."
            tak="Wyłącz zapis"
            powodWylaczenia={brakUprawnienia}
          >
            Wyłącz zapis do sklepu
          </PrzyciskPotwierdz>
        ) : (
          <PrzyciskPotwierdz
            wariant="glowny"
            tytul="Włączyć zapis do sklepu?"
            pytanie={
              <>
                <p>Kompletor zacznie wysyłać do sklepu stany ofert, statusy zamówień i numery nadania (w trybie pracy). Wyłączyć możesz w każdej chwili.</p>
                <Warunki w={warunki} />
              </>
            }
            tak="Włącz zapis"
            powodWylaczenia={brakUprawnienia ?? (mozna(warunki) ? undefined : 'Spełnij warunki z listy niżej')}
          >
            Włącz zapis do sklepu
          </PrzyciskPotwierdz>
        )}
      </form>
      {!wlaczony && <Warunki w={warunki} />}
    </div>
  )
}

/**
 * osobny przełącznik „Wystawianie ofert” (zakładanie ofert i produktów z karty produktu → „Publikacja”).
 * Niezależny od zapisu stanów: włączony zapis do sklepu nie pozwala zakładać ofert i odwrotnie.
 */
function PrzelacznikWystawiania({ kod, wlaczony, uprawnienie, aktywne }: { kod: string; wlaczony: boolean; uprawnienie: boolean; aktywne: boolean }) {
  const brakUprawnienia = uprawnienie ? undefined : 'Nie masz uprawnienia do zmiany trybu kanału'
  return (
    <div className="kn-przelacznik" id="wystawianie">
      <p>
        <b>Wystawianie ofert: {wlaczony ? 'włączone' : 'wyłączone'}.</b>{' '}
        {wlaczony
          ? 'Przycisk „Wystaw” na karcie produktu (zakładka „Publikacja”) zakłada ofertę na tym koncie.'
          : 'Na karcie produktu (zakładka „Publikacja”) widać gotowy podgląd oferty, ale przycisk „Wystaw” jest nieaktywny.'}{' '}
        Ten przełącznik nie dotyczy stanów, statusów ani numerów nadania.
      </p>
      <form action={ustawWystawianie}>
        <input type="hidden" name="konto" value={kod} />
        <input type="hidden" name="wystawianie" value={wlaczony ? 'nie' : 'tak'} />
        {wlaczony ? (
          <PrzyciskPotwierdz tytul="Wyłączyć wystawianie ofert?" pytanie="Z karty produktu zostanie tylko podgląd oferty. Oferty już wystawione zostają bez zmian." tak="Wyłącz wystawianie" powodWylaczenia={brakUprawnienia}>
            Wyłącz wystawianie ofert
          </PrzyciskPotwierdz>
        ) : (
          <PrzyciskPotwierdz
            tytul="Włączyć wystawianie ofert?"
            pytanie="Przycisk „Wystaw” na karcie produktu zacznie zakładać oferty na tym koncie (każda oferta po Twoim kliknięciu, nic nie wychodzi samo). Wyłączyć możesz w każdej chwili."
            tak="Włącz wystawianie"
            powodWylaczenia={brakUprawnienia ?? (aktywne ? undefined : 'Konto jest wyłączone')}
          >
            Włącz wystawianie ofert
          </PrzyciskPotwierdz>
        )}
      </form>
    </div>
  )
}

export function ZapisDoSklepu({ kod, e, now, aktywne, warunki, uprawnienie }: { kod: string; e: EkranZapisu; now: Date; aktywne: boolean; warunki: readonly Warunek[]; uprawnienie: boolean }) {
  const m = e.manifest
  const czytaTylko = !m || m.readOnly
  const opcje = e.statusyKanalu ?? []
  const wartosc = (k: (typeof STATUS_MAP_KEYS)[number]) => e.mapa[k] ?? ''
  const doWyboru = (k: (typeof STATUS_MAP_KEYS)[number]) => (wartosc(k) && !opcje.some((o) => o.id === wartosc(k)) ? [...opcje, { id: wartosc(k), label: wartosc(k) }] : opcje)
  const naglowek = (
    <div className="card-head">
      <h2 id="h-zapis">Zapis do sklepu</h2>
      <span className="muted small">
        Pomoc: <Link href="/pomoc/integracje-woocommerce">co i kiedy wysyłamy</Link> · <Link href="/pomoc/synchronizacja-stanow">pominięte bez zmian</Link>
      </span>
    </div>
  )
  // przegląd (UX): konto tylko do odczytu dostaje samą informację i przełączenie wersji, bez mapy statusów
  // i „Wypchnij teraz” (nie miałyby czego wysłać)
  if (czytaTylko)
    return (
      <section className="card" id="zapis" aria-labelledby="h-zapis">
        {naglowek}
        <p className="small">
          Ten rodzaj konta tylko czyta ze sklepu: Kompletor niczego do niego nie wysyła.
          {e.kluczZZapisem
            ? ' Przełącz na wersję z zapisem: odczyt działa jak dotąd, a zapis zostaje wyłączony, dopóki go tu nie włączysz.'
            : ' Wersji z zapisem dla tego sklepu jeszcze nie ma.'}
        </p>
        {e.kluczZZapisem && (
          <form action={przelaczNaZapis}>
            <input type="hidden" name="konto" value={kod} />
            <Przycisk type="submit">Przełącz na wersję z zapisem</Przycisk>
          </form>
        )}
        <p className="muted small">Klucz API, ustawienia konta i odczyt zamówień zostają bez zmian; wrócić do wersji tylko do odczytu możesz w każdej chwili tutaj.</p>
      </section>
    )
  return (
    <section className="card" id="zapis" aria-labelledby="h-zapis">
      {naglowek}
      <p className="small">
        Kompletor wysyła do sklepu stany ofert, statusy zamówień i numery nadania. Wysyłka rusza dopiero, gdy konto jest w trybie pracy („Aktywny”) i zapis do sklepu jest włączony. W trybie podglądu liczymy, co byśmy wysłali, a sklep zostaje bez zmian.
      </p>
      <PrzelacznikZapisu kod={kod} wlaczony={e.zapisWlaczony} warunki={warunki} uprawnienie={uprawnienie} />
      {e.wystawianieOfert !== null && <PrzelacznikWystawiania kod={kod} wlaczony={e.wystawianieOfert} uprawnienie={uprawnienie} aktywne={aktywne} />}
      <dl className="dl">
        <Wiersz nazwa="Stany ofert" tryb={e.tryby.stany} powod={e.powody.stany} />
        <Wiersz nazwa="Statusy zamówień" tryb={e.tryby.statusy} powod={e.powody.statusy} />
        <Wiersz nazwa="Numery nadania" tryb={e.tryby.nadania} powod={e.powody.nadania} />
      </dl>
      <p className="muted small">Tryb pracy włączasz w sekcji <a href="#stan">„Stan konta”</a> wyżej (opis w Pomocy: „Tryb praca”).</p>

      <h3>Stany</h3>
      <ul className="plain small">
        <li>
          ostatni zapis: <b>{e.stany.ostatniZapis ? when(e.stany.ostatniZapis, now) : 'jeszcze nie było'}</b> · wysłane w 24 h: <b>{int(e.stany.wyslane24h)}</b> · policzone w podglądzie w 24 h: <b>{int(e.stany.wCieniu24h)}</b> · czeka na wysłanie: <b>{int(e.stany.czekajace)}</b>
        </li>
      </ul>
      <p className="small" id="bez-zmian">
        Ostatni przebieg:{' '}
        {e.bezZmian.przebiegAt ? (
          <>
            <b>{when(e.bezZmian.przebiegAt, now)}</b> · wysłane: <b>{int(e.bezZmian.wyslane)}</b> · pominięte bez zmian: <b>{int(e.bezZmian.pominiete)}</b>
          </>
        ) : (
          <b>jeszcze nie było</b>
        )}
      </p>
      <p className="muted small">
        Stan oferty, który sklep już ma z ostatniego udanego zapisu, nie idzie drugi raz (oszczędza limity sklepu). Zapamiętanych ofert: {int(e.bezZmian.zapamietane)}. Mimo braku zmian stany idą od nowa co {int(e.bezZmian.pelnyZapisCoGodz)} h, po korekcie stanu, zmianie powiązania oferty, zmianie ustawień, kluczy albo trybu konta i gdy odczyt ofert pokaże w sklepie inną ilość.
      </p>
      <div className="actions">
        <form action={wyslijStanyPonownieKonto}>
          <input type="hidden" name="konto" value={kod} />
          <PrzyciskPotwierdz
            tytul="Wysłać stany ponownie?"
            pytanie="Kompletor zapomni, które stany sklep już ma, i wyśle stany wszystkich ofert konta od nowa, także te bez zmian. Statusów zamówień i numerów nadania to nie dotyczy. W trybie podglądu tylko przeliczy, co by wysłał."
            tak="Wyślij stany ponownie"
            powodWylaczenia={aktywne ? undefined : 'Konto jest wyłączone'}
          >
            Wyślij stany ponownie
          </PrzyciskPotwierdz>
        </form>
        <form action={zapiszPelnyZapisKonta} className="filters" aria-label="Pełne wysłanie stanów">
          <input type="hidden" name="konto" value={kod} />
          <label className="small" htmlFor="pelny-zapis">
            Wysyłaj wszystkie stany co (godzin)
          </label>
          <input className="input" id="pelny-zapis" name="godziny" type="number" min={PELNY_ZAPIS_MIN_GODZ} max={PELNY_ZAPIS_MAX_GODZ} step={1} defaultValue={e.bezZmian.pelnyZapisCoGodz} style={{ width: '6rem' }} aria-describedby="pelny-zapis-opis" />
          <button className="btn" type="submit">
            Zapisz
          </button>
          <span className="muted small" id="pelny-zapis-opis">
            Od 1 do 168 h. Noc i tak wysyła wszystkie stany raz na dobę, więc wartość powyżej 24 h nie wydłuża tego okna; 1 h to praktycznie wyłączenie pomijania.
          </span>
        </form>
      </div>
      {e.importy && (
        <>
          <h4>Wynik importów stanów w sklepie</h4>
          <p className="muted small">
            Ten sklep przyjmuje plik stanów od razu, a przetwarza go później. Kompletor sprawdza wynik po minucie i potem co 5 minut; gdy sklep odrzuci część wierszy, dostajesz alert (ta sama przyczyna: jeden alert dziennie).
          </p>
          {e.importy.length === 0 ? (
            <p className="muted small">Jeszcze nie było importu.</p>
          ) : (
            <table className="tbl cards">
              <thead>
                <tr>
                  <th scope="col">Kiedy</th>
                  <th scope="col">Ofert w pliku</th>
                  <th scope="col">Wynik</th>
                </tr>
              </thead>
              <tbody>
                {e.importy.map((i) => (
                  <tr key={i.identyfikator} className={i.state === 'GOTOWE' || i.state === 'W_TOKU' ? undefined : 'row-warn'}>
                    <td data-label="Kiedy">{when(i.kiedy, now)}</td>
                    <td data-label="Ofert w pliku">{int(i.wierszy)}</td>
                    <td data-label="Wynik">
                      <span className={`chip ${i.state === 'GOTOWE' ? 'leaf' : i.state === 'W_TOKU' || i.state === 'NIEODCZYTANY' || i.state === 'BEZ_WYNIKU' ? 'amber' : 'red'}`}>{i.stan}</span>
                      {i.odrzucone ? <span className="sub">odrzucone wiersze: {int(i.odrzucone)}{i.kody.length ? ` (${i.kody.join(', ')})` : ''}</span> : null}
                      {i.uwaga && <span className="sub">{i.uwaga}</span>}
                      <span className="sub mono">{i.identyfikator}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      {e.stany.bledy.length > 0 && (
        <details>
          <summary className="small">Oferty z błędem ({e.stany.bledy.length})</summary>
          <ul className="small">
            {e.stany.bledy.map((b) => (
              <li key={b.oferta}>
                <span className="mono">{b.oferta}</span>: {b.blad} <span className="muted">(prób: {b.proby})</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {e.stanZerowy && (
        <>
          <h4 id="stan-zero">Stan 0: zakończone oferty</h4>
          <p className="small">
            Teraz zakończonych przez Kompletor: <b>{int(e.stanZerowy.zakonczoneTeraz)}</b> · zakończone w 24 h: <b>{int(e.stanZerowy.zakonczone24h)}</b> z limitu <b>{int(e.stanZerowy.limit)}</b>
          </p>
          <p className="muted small">
            Przy stanie 0 Kompletor kończy ofertę (sklep nie przyjmuje liczby 0 na aktywnej ofercie), a gdy towar wróci, wznawia ją z nową liczbą sztuk. Ofert zakończonych ręcznie albo przez sklep nie wznawia. Po przekroczeniu limitu na dobę przestaje kończyć oferty i wysyła alert. Zachowanie i limit zmienisz w karcie <a href="#ustawienia">„Ustawienia i klucze”</a> → „Zaawansowane”.
          </p>
          {e.stanZerowy.wpisy.length > 0 && (
            <details>
              <summary className="small">Ostatnie zakończenia i wznowienia ({e.stanZerowy.wpisy.length})</summary>
              <ul className="small">
                {e.stanZerowy.wpisy.map((w, i) => (
                  <li key={`${w.oferta}-${i}`}>
                    {when(w.kiedy, now)}: <span className="mono">{w.oferta}</span> {w.opis}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}

      <h3>Statusy w sklepie</h3>
      <p className="muted small">
        {e.mapaWlasna ? 'Własne ustawienie konta.' : 'Ustawienie domyślne dla tego rodzaju sklepu.'} Puste pole = tego przejścia nie wysyłamy. „Anulowane: brak płatności w terminie” wysyłamy tylko wtedy, gdy sklep nadal nie widzi płatności.
      </p>
      <form action={zapiszMapeStatusowKonta} aria-label="Statusy w sklepie">
        <input type="hidden" name="konto" value={kod} />
        <table className="tbl cards">
          <thead>
            <tr>
              <th scope="col">Status w Kompletorze</th>
              <th scope="col">Status w sklepie</th>
            </tr>
          </thead>
          <tbody>
            {STATUS_MAP_KEYS.map((k) => (
              <tr key={k}>
                <td data-label="W Kompletorze">
                  <label htmlFor={`st-${k}`}>{ETYKIETY_KLUCZY[k]}</label>
                </td>
                <td data-label="W sklepie">
                  {opcje.length ? (
                    <select className="input" id={`st-${k}`} name={`status_${k}`} defaultValue={wartosc(k)}>
                      <option value="">nie wysyłaj</option>
                      {doWyboru(k).map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input className="input" id={`st-${k}`} name={`status_${k}`} defaultValue={wartosc(k)} maxLength={40} placeholder="nie wysyłaj" />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {e.statusyFirmy.length > 0 && (
          <details open={Object.keys(e.mapaFirmy).length > 0}>
            <summary className="small">Statusy firmy: inny status w sklepie niż wyżej ({Object.keys(e.mapaFirmy).length})</summary>
            <p className="muted small">
              Puste pole = status w sklepie jak dla etapu wyżej. Wpisz albo wybierz status sklepu, gdy dany status firmy (Ustawienia → Sprzedaż i kanały → Statusy zamówień) ma trafić do sklepu inaczej, np. „Spakowane Allegro” jako osobny status.
            </p>
            <table className="tbl cards">
              <thead>
                <tr>
                  <th scope="col">Status firmy</th>
                  <th scope="col">Status w sklepie</th>
                </tr>
              </thead>
              <tbody>
                {e.statusyFirmy.map((d) => {
                  const v = e.mapaFirmy[d.key] ?? ''
                  const lista = v && !opcje.some((o) => o.id === v) ? [...opcje, { id: v, label: v }] : opcje
                  // status z etapu „Nowe”, „Do wyjaśnienia” albo „Reklamacja” nie idzie do sklepu: bez pola, z powodem
                  if (!d.doSklepu)
                    return (
                      <tr key={d.key}>
                        <td data-label="Status firmy">
                          {d.name} <span className="muted small">({STATUS_LABEL[d.baseStatus]})</span>
                        </td>
                        <td data-label="W sklepie" className="muted small">
                          {POWOD_ETAPU_POZA_SKLEPEM.charAt(0).toUpperCase() + POWOD_ETAPU_POZA_SKLEPEM.slice(1)}
                        </td>
                      </tr>
                    )
                  return (
                    <tr key={d.key}>
                      <td data-label="Status firmy">
                        <label htmlFor={`sf-${d.key}`}>{d.name}</label> <span className="muted small">({STATUS_LABEL[d.baseStatus]})</span>
                      </td>
                      <td data-label="W sklepie">
                        {opcje.length ? (
                          <select className="input" id={`sf-${d.key}`} name={`statusfirmy_${d.key}`} defaultValue={v}>
                            <option value="">jak etap</option>
                            {lista.map((o) => (
                              <option key={o.id} value={o.id}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input className="input" id={`sf-${d.key}`} name={`statusfirmy_${d.key}`} defaultValue={v} maxLength={40} placeholder="jak etap" />
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </details>
        )}
        <button className="btn primary" type="submit">
          Zapisz statusy
        </button>
      </form>

      <h3>Ostatnie zapisy statusów i numerów nadania</h3>
      <p className="small">
        czeka: <b>{int(e.zapisy.oczekujace)}</b> · błędy: <b>{int(e.zapisy.bledy)}</b> · niepewne: <b>{int(e.zapisy.niejednoznaczne)}</b>
      </p>
      {e.zapisy.niejednoznaczne > 0 && (
        <div className="banner amber" role="status">
          <div>„Niepewne” to zapisy, przy których sklep nie odpowiedział. Sprawdź zamówienie w sklepie; „Wypchnij teraz” wyśle je jeszcze raz (sklep najpierw sprawdzi, czy zmiana już jest).</div>
        </div>
      )}
      {e.zapisy.ostatnie.length === 0 ? (
        <p className="muted small">Jeszcze nic.</p>
      ) : (
        <table className="tbl cards">
          <thead>
            <tr>
              <th scope="col">Zamówienie</th>
              <th scope="col">Co</th>
              <th scope="col">Wynik</th>
              <th scope="col">Kiedy</th>
            </tr>
          </thead>
          <tbody>
            {e.zapisy.ostatnie.map((w) => (
              <tr key={w.id} className={w.blad && w.stan !== 'wysłane' ? 'row-warn' : undefined}>
                <td data-label="Zamówienie">
                  <Link className="mono" href={`/zamowienia/${encodeURIComponent(w.orderId)}`}>
                    {w.zamowienie}
                  </Link>
                </td>
                <td data-label="Co">{w.co}</td>
                <td data-label="Wynik">
                  <span className={`chip ${w.stan === 'wysłane' ? 'leaf' : w.stan === 'błąd' || w.stan === 'niepewne' ? 'red' : 'amber'}`}>{w.stan}</span>
                  {w.blad && w.stan !== 'wysłane' && <span className="sub">{w.blad}</span>}
                  {w.wynik?.startsWith('bez-zmian:') && <span className="sub">sklep miał już ten status</span>}
                </td>
                <td data-label="Kiedy">{when(w.kiedy, now)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form action={wypchnijTerazKonto}>
        <input type="hidden" name="konto" value={kod} />
        <button className="btn" type="submit" disabled={!aktywne}>
          Wypchnij teraz
        </button>
      </form>
      <p className="muted small">
        „Wypchnij teraz” wysyła od nowa stany wszystkich ofert konta (także te bez zmian) i ponawia zapisy z błędem albo niepewne z ostatnich 2 dób. Przy koncie w podglądzie tylko przelicza, co byśmy wysłali.
        {!aktywne && ' Konto jest wyłączone.'}
      </p>
      {e.kluczTylkoOdczyt && (
        <>
          <h3>Rodzaj konta</h3>
          <p className="small">
            Konto z zapisem do sklepu. Możesz wrócić do wersji tylko do odczytu: Kompletor dalej czyta zamówienia i oferty tym samym kluczem API, ale niczego do sklepu nie wysyła. Ustawienia konta zostają.
          </p>
          <form action={przelaczNaOdczyt}>
            <input type="hidden" name="konto" value={kod} />
            <PrzyciskPotwierdz
              tytul="Przełączyć konto na tylko odczyt?"
              pytanie="Kompletor przestanie wysyłać do sklepu stany, statusy i numery nadania. Odczyt zamówień i ofert działa dalej bez przerwy, ustawienia i klucz API zostają. Wrócić możesz tym samym ekranem."
              tak="Przełącz na tylko odczyt"
              powodWylaczenia={uprawnienie ? undefined : 'Nie masz uprawnienia do zmiany ustawień konta'}
            >
              Przełącz na wersję tylko do odczytu
            </PrzyciskPotwierdz>
          </form>
        </>
      )}
    </section>
  )
}
