// Ustawienia → Druk: stanowiska druku (komputery z agentem druku), ich stan z drukarkami i wersją agenta,
// token i kod instalacyjny (pokazane raz), przypisanie drukarek do typów wydruku, „Wydruk testowy” na każdą drukarkę
// i ostatnie 20 zleceń. Tylko z uprawnieniem `ustawienia` (inni dostają 404). Bez pozycji w menu: wejście z Ustawień.
// Przycisk „Pobierz program (Windows)”: adres AGENT_DRUKU_URL, a bez niego paczka z katalogu AGENT_DRUKU_KATALOG
// serwowana przez /api/wydruki/program (lib/druk/paczka.ts); u góry ekranu i w karcie każdego stanowiska.
// W tekstach dla użytkownika „program druku”, nie „agent”.
import { klasyPrzycisku, NaglowekStrony, Przycisk } from '@/app/ui'
import { ADRES_POBRANIA_PACZKI, paczkaProgramu, rozmiarDlaLudzi } from '@/lib/druk/paczka'
import { requirePermission } from '@/lib/panel/kontekst'
import { ostatnieZlecenia, stanowiskaDlaPanelu } from '@/lib/druk/panel'
import { agentDziala, drukarkiZBazy, opisRoli, TYP_LABEL, TYPY_ZLECEN, wartoscPrzypisania } from '@/lib/druk/role'
import { ktoKorzystaZDrukarek, stanowiskaUstawien } from '@/lib/druk/stanowiska'
import { NazwaStanowiska, NoweStanowisko, Routing, TokenStanowiska, WlaczWylacz, WydrukTestowy, type OpcjaDrukarki } from './formularz'

export const metadata = { title: 'Druk' }
export const dynamic = 'force-dynamic'

const atFmt = new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })

const STATUS: Record<string, { tekst: string; ton: string }> = {
  PRZYGOTOWANIE: { tekst: 'przygotowanie', ton: '' },
  OCZEKUJE: { tekst: 'czeka na program druku', ton: 'blue' },
  OK: { tekst: 'wydrukowano', ton: 'leaf' },
  BLAD: { tekst: 'błąd', ton: 'red' },
  WYGASLO: { tekst: 'wygasło', ton: 'amber' },
}
const ZRODLO: Record<string, string> = { PANEL: 'panel', TEST: 'test', ZAPAS: 'zapas' }
const STAN_DRUKARKI: Record<string, { tekst: string; ton: string }> = {
  DOSTEPNA: { tekst: 'dostępna', ton: 'leaf' },
  OFFLINE: { tekst: 'offline', ton: 'red' },
  BLAD: { tekst: 'błąd', ton: 'red' },
}

/** Skąd pobrać program: adres zewnętrzny (AGENT_DRUKU_URL) ma pierwszeństwo, potem paczka z serwera aplikacji. */
interface Pobranie {
  href: string
  /** „wersja 0.2.0, 42,5 MB”; przy adresie zewnętrznym nieznane */
  opis: string | null
}

/**
 * Zwykły link z `download`, nie next/link: Link w produkcji pobiera z wyprzedzeniem adresy widoczne na ekranie,
 * a tu za adresem stoi kilkadziesiąt MB.
 */
function PobierzProgram({ pobranie, wariant }: { pobranie: Pobranie; wariant: 'glowny' | 'drugorzedny' }) {
  return (
    <a href={pobranie.href} className={klasyPrzycisku(wariant, 'md', 'druk-pobierz')} download>
      Pobierz program (Windows)
      {pobranie.opis && <span className="druk-pobierz-opis">{pobranie.opis}</span>}
    </a>
  )
}

export default async function Druk() {
  const ctx = await requirePermission('ustawienia')
  const now = new Date()
  const [stanowiska, zlecenia, paczka, panel] = await Promise.all([stanowiskaUstawien(ctx.db), ostatnieZlecenia(ctx.db, 20), paczkaProgramu(), stanowiskaDlaPanelu(ctx.db, now)])
  // drukarki wszystkich włączonych stanowisk firmy do wyboru w „Co na jakiej drukarce” (własne pierwsze)
  const wszystkieDrukarki = stanowiska
    .filter((s) => !s.disabledAt)
    .flatMap((s) => drukarkiZBazy(s.printers).map((d) => ({ stanowiskoId: s.id, stanowisko: s.name, rola: d.rola, etykieta: `${s.name}: ${opisRoli(d.rola)} (${d.nazwa})` })))
  const opcjeDla = (id: string): OpcjaDrukarki[] => [
    ...wszystkieDrukarki.filter((d) => d.stanowiskoId === id).map((d) => ({ wartosc: d.rola, etykieta: `${d.etykieta}, ten komputer` })),
    ...wszystkieDrukarki.filter((d) => d.stanowiskoId !== id).map((d) => ({ wartosc: `${d.stanowiskoId}:${d.rola}`, etykieta: d.etykieta })),
  ]
  const nazwaStanowiska = new Map(stanowiska.map((s) => [s.id, s.name]))
  const uzywanePanelu = new Map(panel.map((s) => [s.id, s.uzywane]))
  const agentUrl = process.env.AGENT_DRUKU_URL?.trim() || null
  const pobranie: Pobranie | null = agentUrl
    ? { href: agentUrl, opis: null }
    : paczka
      ? { href: ADRES_POBRANIA_PACZKI, opis: `wersja ${paczka.wersja}, ${rozmiarDlaLudzi(paczka.rozmiar)}` }
      : null
  return (
    <>
      <NaglowekStrony
        tytul="Druk"
        podtytul="Komputery w magazynie z programem „Kompletor Druk”: karty, listy i etykiety drukują się bez otwierania PDF-ów."
        akcje={
          pobranie ? (
            <PobierzProgram pobranie={pobranie} wariant="glowny" />
          ) : (
            <Przycisk powodWylaczenia="Paczkę programu przygotowuje administrator instalacji (Pomoc → Druk, „Paczka programu”)">Pobierz program (Windows)</Przycisk>
          )
        }
      />
      <div className="stack">

      <section className="card" aria-labelledby="h-jak">
        <div className="card-head">
          <h2 id="h-jak">Jak to działa</h2>
        </div>
        <ol className="small druk-kroki">
          <li>Dodaj stanowisko (jedno na komputer) i kliknij „Utwórz token i kod instalacyjny”.</li>
          <li>
            Na komputerze w magazynie rozpakuj paczkę programu i uruchom <span className="mono">Zainstaluj.cmd</span>. Wklej kod instalacyjny i wskaż,
            która drukarka jest zwykła (A4), a która termiczna (etykiety).{' '}
            {pobranie ? (
              'Paczkę pobierzesz przyciskiem „Pobierz program (Windows)” u góry ekranu albo przy stanowisku.'
            ) : (
              <span className="muted">Paczkę programu przygotowuje administrator instalacji; przycisk „Pobierz program (Windows)” zadziała, gdy ją udostępni.</span>
            )}
          </li>
          <li>Po minucie stan drukarek pojawi się niżej i w nagłówku ekranu pakowania. Zrób „Wydruk testowy” na każdą drukarkę.</li>
          <li>
            Każdy komputer ma własny token. Dwa komputery z tym samym kodem to błąd: drukowałyby na zmianę. Zlecenie, którego nikt nie wydrukował w 8 godzin,
            wygasa.
          </li>
        </ol>
      </section>

      <section className="card" aria-labelledby="h-nowe">
        <div className="card-head">
          <h2 id="h-nowe">Nowe stanowisko</h2>
          <span className="muted small">Jedno stanowisko na jeden komputer w magazynie.</span>
        </div>
        <NoweStanowisko />
      </section>

      {stanowiska.length === 0 && (
        <p className="muted small">
          Brak stanowisk druku. Bez nich panel działa jak dotąd: karty i listy pobiera się jako PDF.
        </p>
      )}

      {stanowiska.map((s) => {
        const drukarki = drukarkiZBazy(s.printers)
        const dziala = agentDziala(s.lastReportAt, now)
        const opcje = opcjeDla(s.id)
        const wartosci = Object.fromEntries(TYPY_ZLECEN.map((t) => [t, wartoscPrzypisania(s.przypisania[t])]))
        const obecne = Object.fromEntries(
          TYPY_ZLECEN.map((t) => {
            const p = s.przypisania[t]
            return [t, p.stanowisko ? `${nazwaStanowiska.get(p.stanowisko) ?? 'nieznany komputer'}: ${opisRoli(p.rola)}` : `${s.name}: ${opisRoli(p.rola)}, ten komputer`]
          }),
        )
        const braki = (uzywanePanelu.get(s.id) ?? []).filter((u) => u.blad)
        const korzystaja = ktoKorzystaZDrukarek(s.id, stanowiska).map((k) => `${k.nazwa}: ${k.typy.map((t) => TYP_LABEL[t].toLowerCase()).join(', ')}`)
        return (
          <section className={`card${s.disabledAt ? ' druk-wylaczone' : ''}`} key={s.id} aria-labelledby={`h-${s.id}`}>
            <div className="card-head">
              <h2 id={`h-${s.id}`}>
                {s.name} <span className="mono small muted">{s.code}</span>
              </h2>
              <span className="chips">
                {s.disabledAt ? (
                  <span className="chip">wyłączone {atFmt.format(s.disabledAt)}</span>
                ) : !s.lastReportAt ? (
                  <span className="chip amber">program druku jeszcze się nie zgłosił</span>
                ) : dziala ? (
                  <span className="chip leaf">program druku działa · ostatni stan {atFmt.format(s.lastReportAt)}</span>
                ) : (
                  <span className="chip red">brak stanu od {Math.floor((now.getTime() - s.lastReportAt.getTime()) / 60_000)} min</span>
                )}
                {s.agentVersion && <span className="chip">program druku {s.agentVersion}</span>}
              </span>
            </div>

            <h3 className="small druk-h3">
              Drukarki (z ostatniego raportu programu druku)
            </h3>
            {drukarki.length === 0 ? (
              <p className="muted small">Brak: program druku jeszcze nie wysłał stanu. Zlecenia na to stanowisko nie powstaną, dopóki nie zgłosi drukarek.</p>
            ) : (
              <table className="tbl cards">
                <thead>
                  <tr>
                    <th scope="col">Rola</th>
                    <th scope="col">Drukarka Windows</th>
                    <th scope="col">Stan</th>
                    <th scope="col">
                      <span className="sr">Akcja</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {drukarki.map((d) => (
                    <tr key={d.rola}>
                      <td data-label="Rola">
                        <b>{opisRoli(d.rola)}</b> <span className="mono small muted">{d.rola}</span>
                      </td>
                      <td data-label="Drukarka Windows">{d.nazwa}</td>
                      <td data-label="Stan">
                        <span className={`chip druk-chip ${STAN_DRUKARKI[d.stan]!.ton}`}>
                          {STAN_DRUKARKI[d.stan]!.tekst}
                          {d.komunikat ? ` — ${d.komunikat}` : ''}
                        </span>
                        {d.zleceniaWKolejce ? <div className="small muted">w kolejce Windows: {d.zleceniaWKolejce}</div> : null}
                      </td>
                      <td data-label="Akcja">{!s.disabledAt && <WydrukTestowy id={s.id} rola={d.rola} />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <h3 className="small druk-h3 druk-h3-dalej">
              Co na jakiej drukarce
            </h3>
            {s.disabledAt ? (
              <p className="muted small druk-bez-marginesu">Stanowisko wyłączone: przypisania wrócą po włączeniu.</p>
            ) : opcje.length === 0 ? (
              <p className="muted small druk-bez-marginesu">
                {!s.lastReportAt
                  ? 'Drukarki przypiszesz po instalacji programu druku na tym albo innym komputerze firmy: wtedy pojawią się tutaj.'
                  : 'Program druku na tym komputerze nie zgłosił żadnej drukarki. Wskaż drukarki w programie (skrót „Kompletor Druk (ustawienia)” na pulpicie): wtedy pojawią się tutaj.'}
              </p>
            ) : (
              <>
                <p className="small druk-routing-opis">
                  Wybierz drukarkę dla każdego rodzaju wydruku: tego komputera albo innego stanowiska firmy (np. etykiety na termicznej przy pakowaniu,
                  karty na A4 w biurze). Wydruk wychodzi na komputerze z wybraną drukarką.
                  {!s.lastReportAt && ' Na tym stanowisku nie ma programu druku, więc wybierz drukarki innych komputerów.'}
                </p>
                <Routing id={s.id} wartosci={wartosci} opcje={opcje} obecne={obecne} />
                {braki.length > 0 && (
                  <div className="banner amber druk-kod-blok" role="status">
                    <b>Tych wydruków ze stanowiska „{s.name}” teraz nie da się zlecić:</b>
                    <ul className="small druk-braki">
                      {braki.map((u) => (
                        <li key={`${u.stanowiskoId}-${u.rola}`}>
                          <b>{u.typy.map((t) => TYP_LABEL[t]).join(', ')}:</b> {u.blad}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}

            <h3 className="small druk-h3 druk-h3-dalej">
              Token i kod instalacyjny
            </h3>
            {!s.disabledAt && (
              <>
                {pobranie && (
                  <div className="druk-wiersz-srodek druk-pobierz-wiersz">
                    <PobierzProgram pobranie={pobranie} wariant="drugorzedny" />
                    <span className="small">
                      Rozpakuj paczkę i uruchom <span className="mono">Zainstaluj.cmd</span>, potem wklej kod.
                    </span>
                  </div>
                )}
                <TokenStanowiska
                  id={s.id}
                  nazwa={s.name}
                  maToken={s.maToken}
                  utworzono={s.tokenCreatedAt ? atFmt.format(s.tokenCreatedAt) : null}
                  pobranieUrl={pobranie?.href ?? null}
                />
              </>
            )}

            <div className="druk-nowe druk-h3-dalej">
              <NazwaStanowiska id={s.id} nazwa={s.name} />
              <WlaczWylacz id={s.id} nazwa={s.name} wylaczone={!!s.disabledAt} korzystaja={korzystaja} />
            </div>
          </section>
        )
      })}

      <section className="card" aria-labelledby="h-zlecenia">
        <div className="card-head">
          <h2 id="h-zlecenia">Ostatnie zlecenia</h2>
          <span className="muted small">20 najnowszych; pliki zleceń usuwane po 7 dniach</span>
        </div>
        {zlecenia.length === 0 ? (
          <p className="muted small druk-bez-marginesu">
            Brak zleceń.
          </p>
        ) : (
          <table className="tbl cards">
            <thead>
              <tr>
                <th scope="col">Kiedy</th>
                <th scope="col">Stanowisko</th>
                <th scope="col">Co</th>
                <th scope="col">Drukarka</th>
                <th scope="col">Stan</th>
              </tr>
            </thead>
            <tbody>
              {zlecenia.map((z) => (
                <tr key={z.id}>
                  <td data-label="Kiedy" className="small">
                    {atFmt.format(z.createdAt)}
                  </td>
                  <td data-label="Stanowisko">{z.station.name}</td>
                  <td data-label="Co">
                    {TYP_LABEL[z.type]} <span className="chip">{ZRODLO[z.source]}</span>
                    {z.summary && <div className="small muted zawijaj">{z.summary}</div>}
                  </td>
                  <td data-label="Drukarka" className="small">
                    <span className="mono">{z.role}</span> · {z.format.toUpperCase()}
                    {z.resultPrinter && <div className="muted">{z.resultPrinter}</div>}
                  </td>
                  <td data-label="Stan">
                    <span className={`chip ${STATUS[z.status]!.ton}`}>{STATUS[z.status]!.tekst}</span>
                    {z.resultMessage && <div className="small zawijaj">{z.resultMessage}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      </div>
    </>
  )
}
