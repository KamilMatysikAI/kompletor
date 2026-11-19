// Ustawienia → Poczta: serwer SMTP firmy, nadawca i wygląd maili per sklep, mail próbny, ostatnie wysyłki.
// Maile z planu akcji wychodzą tylko przy włączonej wysyłce tutaj, POCZTA_WYSYLKA=1 na instancji i koncie kanału w trybie
// pracy. Hasło SMTP to sekret firmy: ekran pokazuje tylko, czy jest ustawione. Tylko z uprawnieniem `ustawienia`.
// ekran na komponentach app/ui (nagłówek, karty, pola, odznaki, tabela); wynik zapisu i maila próbnego jako
// toast; adres biura z Danych firmy ma pierwszeństwo przed polem „Adres biura” tutaj (podpowiedź przy polu).
// karta „Odbicia” (skrzynka nadawcy przez IMAP, osobny adres odbić jako nadawca koperty), osobny formularz.
import { Baner, Karta, NaglowekStrony, Odznaka, PasekZapisu, PoleTekstowe, PoleWielowierszowe, Przelacznik, Przycisk, PrzyciskLink, PustyStan, Tabela, Wybor } from '@/app/ui'
import { parseProfilFirmy } from '@/lib/firma/profil'
import { BEZPIECZENSTWO, ETYKIETA_BEZPIECZENSTWA } from '@/lib/maile/transport'
import { requirePermission } from '@/lib/panel/kontekst'
import type { Ton } from '@/lib/panel/statusy'
import { NAZWA_SZABLONU } from '@/lib/poczta/szablony'
import { widokOdbic } from '@/lib/poczta/czytnik-odbic'
import { ETYKIETA_SZYFROWANIA_IMAP } from '@/lib/poczta/imap'
import { DOMYSLNY_KOLOR, widokPoczty } from '@/lib/poczta/ustawienia'
import { ToastZAdresu } from '../kanaly/toast-z-adresu'
import { wyslijTest, zapiszOdbicia, zapiszPoczte } from './akcje'

export const metadata = { title: 'Poczta' }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
const DT = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Warsaw' })
const STAN: Record<string, { label: string; ton: Ton }> = {
  SENT: { label: 'wysłano', ton: 'sukces' },
  SENDING: { label: 'w trakcie', ton: 'info' },
  FAILED: { label: 'nie wyszedł', ton: 'blad' },
  UNCERTAIN: { label: 'mógł nie dojść', ton: 'ostrzezenie' },
  CZEKA: { label: 'czeka', ton: 'ostrzezenie' },
  POMINIETY: { label: 'pominięty', ton: 'neutralny' },
  ODBITY: { label: 'wrócił (niedoręczony)', ton: 'blad' },
}
const RODZAJ: Record<string, string> = { ...NAZWA_SZABLONU, test: 'Mail próbny' }
const TRYB: Record<string, string> = { PRACA: 'aktywne: maile wychodzą', CIEN: 'tylko podgląd: Kompletor nie wysyła maili', WYLACZONY: 'wyłączone' }

export default async function Poczta({ searchParams }: Props) {
  const ctx = await requirePermission('ustawienia')
  const sp = await searchParams
  const [v, o, ostatnie, org] = await Promise.all([
    widokPoczty(ctx.db, process.env),
    widokOdbic(ctx.db),
    ctx.db.mailDelivery.findMany({ orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: 15, select: { id: true, kind: true, state: true, recipient: true, attempts: true, updatedAt: true, lastError: true } }),
    ctx.db.organization.findFirst({ select: { settings: true } }),
  ])
  const biuroZProfilu = parseProfilFirmy(org?.settings ?? null).emailBiura
  const blad = one(sp.blad)?.slice(0, 400)
  const proba = one(sp.proba)?.slice(0, 100)
  const sukces = one(sp.zapisano) === '1' ? 'Zapisano.' : proba ? `Mail próbny wysłany do ${proba}. Sprawdź skrzynkę (także spam).` : null
  return (
    <>
      <ToastZAdresu sukces={sukces} blad={blad} />
      <NaglowekStrony
        tytul="Poczta"
        podtytul="Maile do klientów (brak płatności, gotowe do odbioru, wysłane z fakturą), do biura (błąd faktury, niski stan) i zaproszenia do firmy wychodzą przez serwer poczty firmy. Bez ustawionej poczty maile czekają w planie akcji, nic nie ginie."
        akcje={
          <>
            <PrzyciskLink href="/ustawienia/poczta/szablony">Szablony maili</PrzyciskLink>
            <PrzyciskLink href="/akcje" wariant="cichy">
              Plan akcji
            </PrzyciskLink>
          </>
        }
      />

      <div className="stack">
        {v.instancja !== true && (
          <Baner ton="ostrzezenie" rola="status">
            {v.instancja === null
              ? 'Wysyłka maili na tej instalacji ma błędne ustawienie i nie działa. Poproś administratora instalacji o poprawkę.'
              : 'Wysyłka maili jest wyłączona na tej instalacji. Ustawienia można zapisać, ale żaden mail nie wyjdzie, dopóki administrator instalacji jej nie włączy.'}
          </Baner>
        )}
        {v.braki.length > 0 && (
          <Baner ton="ostrzezenie" rola="status">
            Do wysyłki brakuje: {v.braki.join(', ')}.
          </Baner>
        )}
        {v.loginRejectedAt && !v.lastError && (
          <Baner ton="blad" tytul="Serwer poczty odrzucił login albo hasło.">
            <span className="small">({DT.format(v.loginRejectedAt)})</span> Do czasu poprawy nie wychodzą maile z planu akcji, zaproszenia ani linki do ustawienia hasła. Co
            zrobić: sprawdź login i hasło u dostawcy poczty, wpisz je niżej i zapisz (po zmianie danych serwera albo ponownym włączeniu wysyłki blokada znika). Udany mail
            próbny też ją zdejmuje.
          </Baner>
        )}
        {v.lastError && (
          <Baner ton="blad">
            {v.lastError}
            {v.lastErrorAt && <span className="small"> ({DT.format(v.lastErrorAt)})</span>}
            {v.loginRejectedAt && ' Do czasu poprawy nie wychodzą maile z planu akcji, zaproszenia ani linki do ustawienia hasła; udany mail próbny zdejmuje blokadę.'}
          </Baner>
        )}

        <form action={zapiszPoczte} className="stack" aria-label="Ustawienia poczty">
          <Karta
            tytul="Serwer poczty (SMTP)"
            id="serwer"
            akcje={<Odznaka ton={v.enabled ? 'sukces' : 'neutralny'}>{v.enabled ? `wysyłka włączona${v.enabledAt ? ` od ${DT.format(v.enabledAt)}` : ''}` : 'wysyłka wyłączona'}</Odznaka>}
            opis="Amazon SES: serwer email-smtp.<region>.amazonaws.com, port 587, STARTTLS, login i hasło SMTP z konsoli SES. Gmail i Google Workspace: smtp.gmail.com, port 587, hasło aplikacji."
          >
            <Przelacznik
              id="p-wlaczone"
              name="wlaczone"
              value="tak"
              defaultChecked={v.enabled}
              etykieta="Wysyłaj maile z planu akcji (tylko aktywne konta kanałów)"
              pomoc="Zaproszenia do firmy wychodzą zawsze, gdy serwer poczty jest ustawiony i nie odrzucił logowania, także przy wyłączonej wysyłce z planu akcji. Linki do ustawienia hasła („Nie pamiętam hasła”) wysyła poczta serwera Kompletora, nie ten serwer."
            />
            <div className="notif-grid">
              <PoleTekstowe id="p-host" name="host" etykieta="Serwer" placeholder="smtp.firma.pl" defaultValue={v.host} maxLength={253} autoComplete="off" />
              <PoleTekstowe id="p-port" name="port" etykieta="Port" inputMode="numeric" placeholder="587" defaultValue={v.port ?? ''} maxLength={5} />
              <Wybor
                id="p-bezp"
                name="bezpieczenstwo"
                etykieta="Szyfrowanie"
                defaultValue={v.bezpieczenstwo}
                opcje={BEZPIECZENSTWO.filter((b) => !(v.hosting && b === 'BRAK')).map((b) => ({ wartosc: b, etykieta: ETYKIETA_BEZPIECZENSTWA[b] }))}
              />
              <PoleTekstowe id="p-login" name="login" etykieta="Login" defaultValue={v.login} maxLength={254} autoComplete="off" />
              <PoleTekstowe
                id="p-haslo"
                name="haslo"
                type="password"
                etykieta="Hasło"
                pomoc={v.hasloUstawione ? 'Ustawione. Puste pole = bez zmiany.' : 'Nieustawione.'}
                defaultValue=""
                maxLength={500}
                autoComplete="new-password"
              />
            </div>
            {v.hasloUstawione && <Przelacznik id="p-usun-haslo" name="usun_haslo" value="tak" etykieta="Usuń zapisane hasło" />}
          </Karta>

          <Karta tytul="Nadawca i biuro" id="nadawca">
            <div className="notif-grid">
              <PoleTekstowe id="p-od" name="od_email" type="email" etykieta="Adres nadawcy (domyślny)" placeholder="sklep@firma.pl" defaultValue={v.fromEmail} maxLength={254} />
              <PoleTekstowe id="p-od-n" name="od_nazwa" etykieta="Nazwa nadawcy" defaultValue={v.fromName} maxLength={100} />
              <PoleTekstowe
                id="p-biuro"
                name="biuro"
                type="email"
                etykieta="Adres biura (błąd faktury, niski stan)"
                placeholder="biuro@firma.pl"
                defaultValue={v.officeEmail}
                maxLength={254}
                pomoc={
                  biuroZProfilu
                    ? `Maile do biura idą teraz na ${biuroZProfilu} z Ustawienia → Dokumenty i faktury → Dane firmy. To pole działa, gdy w Danych firmy nie ma e-maila biura.`
                    : 'Gdy uzupełnisz e-mail biura w Ustawienia → Dokumenty i faktury → Dane firmy, maile do biura pójdą tam.'
                }
              />
            </div>
          </Karta>

          <Karta tytul="Sklepy: nadawca i wygląd" id="sklepy" opis="Puste pole = wartość domyślna firmy. Adres odbioru osobistego potrzebny do maila „Gotowe do odbioru”.">
            {v.konta.length === 0 ? (
              <PustyStan tytul="Brak kont kanałów" akcja={<PrzyciskLink href="/ustawienia/kanaly">Kanały sprzedaży</PrzyciskLink>}>
                Dodaj sklep w Ustawienia → Sprzedaż i kanały → Kanały sprzedaży, a tu pojawi się jego nadawca i wygląd maili.
              </PustyStan>
            ) : (
              v.konta.map((k) => {
                const n = k.nadawca
                const id = (p: string) => `n_${p}_${k.klucz}`
                return (
                  <fieldset key={k.klucz} className="card">
                    <legend>
                      <b>{k.nazwa}</b> <span className="small muted">({TRYB[k.tryb] ?? k.tryb})</span>
                    </legend>
                    <input type="hidden" name="konto" value={k.klucz} />
                    <div className="notif-grid">
                      <PoleTekstowe id={id('nazwaSklepu')} name={id('nazwaSklepu')} etykieta="Nazwa sklepu w mailach" defaultValue={n.nazwaSklepu ?? ''} placeholder={k.nazwa} maxLength={100} />
                      <PoleTekstowe id={id('email')} name={id('email')} type="email" etykieta="Adres nadawcy" defaultValue={n.email ?? ''} placeholder={v.fromEmail || 'sklep@firma.pl'} maxLength={254} />
                      <PoleTekstowe id={id('nazwaNadawcy')} name={id('nazwaNadawcy')} etykieta="Nazwa nadawcy" defaultValue={n.nazwaNadawcy ?? ''} maxLength={100} />
                      <PoleTekstowe id={id('odpowiedzDo')} name={id('odpowiedzDo')} type="email" etykieta="Odpowiedzi na adres" defaultValue={n.odpowiedzDo ?? ''} maxLength={254} />
                      <PoleTekstowe id={id('www')} name={id('www')} type="url" etykieta="Strona sklepu" defaultValue={n.www ?? ''} placeholder="https://" maxLength={200} />
                      <PoleTekstowe id={id('logoUrl')} name={id('logoUrl')} type="url" etykieta="Adres logo (https)" defaultValue={n.logoUrl ?? ''} placeholder="https://" maxLength={500} />
                      <PoleTekstowe id={id('kolor')} name={id('kolor')} type="color" etykieta="Kolor główny" defaultValue={n.kolor ?? DOMYSLNY_KOLOR} />
                      <PoleWielowierszowe id={id('odbiorAdres')} name={id('odbiorAdres')} etykieta="Adres odbioru osobistego" pomoc="Każda linia adresu w osobnym wierszu." rows={3} defaultValue={(n.odbiorAdres ?? []).join('\n')} maxLength={1600} />
                      <PoleWielowierszowe id={id('odbiorGodziny')} name={id('odbiorGodziny')} etykieta="Godziny odbioru" rows={3} defaultValue={(n.odbiorGodziny ?? []).join('\n')} maxLength={1600} />
                      <PoleTekstowe id={id('odbiorUwagi')} name={id('odbiorUwagi')} etykieta="Uwagi do odbioru" defaultValue={n.odbiorUwagi ?? ''} maxLength={300} />
                    </div>
                  </fieldset>
                )
              })
            )}
            <PasekZapisu />
          </Karta>
        </form>

        <Karta tytul="Wyślij test" id="test" opis="Działa także przy wyłączonej wysyłce z planu akcji; puste pole = adres biura.">
          <form action={wyslijTest} className="notif-test" aria-label="Mail próbny">
            <PoleTekstowe id="t-adres" name="adres" type="email" etykieta="Adres" placeholder={v.officeEmail || 'ty@firma.pl'} maxLength={254} />
            <Przycisk type="submit" disabled={v.instancja !== true} powodWylaczenia={v.instancja !== true ? 'Wysyłka maili na tej instancji jest wyłączona (POCZTA_WYSYLKA).' : null}>
              Wyślij mail próbny
            </Przycisk>
          </form>
        </Karta>

        <form action={zapiszOdbicia} aria-label="Odbicia po wysłaniu">
          <Karta
            tytul="Odbicia"
            id="odbicia"
            akcje={
              <Odznaka ton={o.loginRejectedAt ? 'blad' : o.enabled ? 'sukces' : 'neutralny'}>
                {o.loginRejectedAt ? 'wstrzymane: odrzucone logowanie' : o.enabled ? `włączone, zapisanych odbić: ${o.liczba}` : 'wyłączone'}
              </Odznaka>
            }
            opis="Mail, który serwer adresata przyjął, a potem odesłał jako niedoręczony, wraca na adres nadawcy. Kompletor co 5 minut zagląda do tej skrzynki, oznacza taki mail w „Ostatnie maile” jako „wrócił (niedoręczony)” i wysyła alert do biura. Rozpoznane zgłoszenia przenosi do folderu „Kompletor/odbicia”; zwykłe maile zostawia nieprzeczytane."
          >
            {o.lastError && (
              <Baner ton={o.loginRejectedAt ? 'blad' : 'ostrzezenie'} rola="status">
                {o.lastError}
                {o.lastErrorAt && <span className="small"> ({DT.format(o.lastErrorAt)})</span>}
                {o.loginRejectedAt && ' Popraw login albo hasło niżej i zapisz: czytnik ruszy przy następnym przebiegu.'}
              </Baner>
            )}
            {o.enabled && o.braki.length > 0 && (
              <Baner ton="ostrzezenie" rola="status">
                Do czytania odbić brakuje: {o.braki.join(', ')}.
              </Baner>
            )}
            <Przelacznik
              id="o-wlaczone"
              name="o_wlaczone"
              value="tak"
              defaultChecked={o.enabled}
              etykieta="Sprawdzaj skrzynkę odbić co 5 minut"
              pomoc={o.lastRunAt ? `Ostatnie sprawdzenie: ${DT.format(o.lastRunAt)}.` : 'Jeszcze nie sprawdzano.'}
            />
            <div className="notif-grid">
              <PoleTekstowe id="o-host" name="o_host" etykieta="Serwer IMAP" placeholder="imap.firma.pl" defaultValue={o.host} maxLength={253} autoComplete="off" />
              <PoleTekstowe id="o-port" name="o_port" etykieta="Port" inputMode="numeric" placeholder="993" defaultValue={o.port ?? ''} maxLength={5} />
              <Wybor
                id="o-bezp"
                name="o_bezpieczenstwo"
                etykieta="Szyfrowanie"
                defaultValue={o.bezpieczenstwo}
                opcje={(['TLS', 'STARTTLS', 'BRAK'] as const).filter((b) => !(v.hosting && b === 'BRAK')).map((b) => ({ wartosc: b, etykieta: ETYKIETA_SZYFROWANIA_IMAP[b] }))}
              />
              <PoleTekstowe id="o-login" name="o_login" etykieta="Login skrzynki" defaultValue={o.login} maxLength={254} autoComplete="off" />
              <PoleTekstowe
                id="o-haslo"
                name="o_haslo"
                type="password"
                etykieta="Hasło skrzynki"
                pomoc={o.hasloUstawione ? 'Ustawione. Puste pole = bez zmiany.' : 'Nieustawione.'}
                defaultValue=""
                maxLength={500}
                autoComplete="new-password"
              />
              <PoleTekstowe id="o-folder" name="o_folder" etykieta="Folder" placeholder="INBOX" defaultValue={o.folder} maxLength={200} pomoc="Zwykle INBOX (Odebrane)." />
              <PoleTekstowe
                id="o-adres"
                name="o_adres"
                type="email"
                etykieta="Adres odbić (opcjonalnie)"
                placeholder={v.fromEmail || 'odbicia@firma.pl'}
                defaultValue={o.adresOdbic}
                maxLength={254}
                pomoc="Puste = odbicia wracają na adres nadawcy maila. Osobny adres musi należeć do konta SMTP wyżej (inaczej serwer odrzuci wysyłkę) i to jego skrzynkę wpisz tutaj."
              />
            </div>
            {o.hasloUstawione && <Przelacznik id="o-usun-haslo" name="o_usun_haslo" value="tak" etykieta="Usuń zapisane hasło skrzynki" />}
            <PasekZapisu />
          </Karta>
        </form>

        <Karta tytul="Ostatnie maile" id="ostatnie" opis="15 ostatnich; adresy zamaskowane. Wszystkie maile z akcji: Plan akcji.">
          <Tabela
            id="poczta-ostatnie"
            etykieta="Ostatnie maile"
            kolumny={[
              { klucz: 'mail', etykieta: 'Mail' },
              { klucz: 'do', etykieta: 'Do' },
              { klucz: 'stan', etykieta: 'Stan' },
              { klucz: 'kiedy', etykieta: 'Godzina' },
            ]}
            wiersze={ostatnie.map((d) => ({
              id: d.id,
              ...(d.state === 'FAILED' || d.state === 'ODBITY' ? { ton: 'blad' as const } : d.state === 'UNCERTAIN' ? { ton: 'ostrzezenie' as const } : {}),
              komorki: {
                mail: RODZAJ[d.kind] ?? d.kind,
                do: d.recipient ?? '—',
                stan: (
                  <>
                    <Odznaka ton={STAN[d.state]?.ton ?? 'neutralny'}>{STAN[d.state]?.label ?? d.state}</Odznaka>
                    {d.attempts > 1 && <span className="sub">prób: {d.attempts}</span>}
                    {d.lastError && <span className="sub">{d.lastError}</span>}
                  </>
                ),
                kiedy: DT.format(d.updatedAt),
              },
            }))}
            pustyStan={<PustyStan tytul="Jeszcze nic nie wysłano">Tu pojawią się maile z planu akcji, zaproszenia, linki do ustawienia hasła i maile próbne.</PustyStan>}
          />
        </Karta>
      </div>
    </>
  )
}
