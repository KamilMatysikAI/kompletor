// Ustawienia → Powiadomienia: alerty na Zulip, strumień i temat per grupa alertów. Domyślnie nic nie
// wychodzi: potrzebny włącznik firmy tutaj i POWIADOMIENIA_WYSYLKA=1 na instancji. Tylko z uprawnieniem `ustawienia`.
import Link from 'next/link'
import { requirePermission } from '@/lib/panel/kontekst'
import { NAME_MAX } from '@/lib/powiadomienia/adres'
import { ALERT_GROUPS, GROUP_LABEL, kindLabel, kindsOf } from '@/lib/powiadomienia/grupy'
import { notificationView } from '@/lib/powiadomienia/ustawienia'
import { wyslijProbna, zapiszPowiadomienia, zapiszProgWylaczenia } from './akcje'
import { PROG_MAX, PROG_MIN, progWylaczenia } from '@/lib/integracje/zdrowie'
import { PasekZapisu, ToastZAdresuZapisu } from '@/app/ui' // jeden zapis na ekran

export const metadata = { title: 'Powiadomienia' }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
const DT = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Warsaw' })
const STATE: Record<string, { label: string; chip: string }> = {
  SENT: { label: 'wysłano', chip: 'leaf' },
  SENDING: { label: 'w trakcie', chip: 'blue' },
  FAILED: { label: 'błąd', chip: 'red' },
  UNCERTAIN: { label: 'niepewne', chip: 'amber' },
}

export default async function Powiadomienia({ searchParams }: Props) {
  const ctx = await requirePermission('ustawienia')
  const sp = await searchParams
  const [v, prog] = await Promise.all([notificationView(ctx.db, process.env), progWylaczenia(ctx.db)])
  const proba = one(sp.proba)
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Powiadomienia</h1>
          <div className="sub">
            Alerty systemu jako wiadomości na Zulipie: każda grupa alertów idzie do wybranego strumienia i tematu. Wiadomość zawiera rodzaj alertu, firmę, odnośnik
            (np. numer zamówienia) i godzinę, bez danych klientów. Wychodzą tylko alerty powstałe po włączeniu.
          </div>
        </div>
      </header>

      {v.instanceSending !== true && (
        <div className="banner amber" role="status">
          <div>
            {v.instanceSending === null
              ? 'Wysyłka powiadomień na tej instalacji ma błędne ustawienie i nie działa. Poproś administratora instalacji o poprawkę.'
              : 'Wysyłka powiadomień jest wyłączona na tej instalacji. Ustawienia można zapisać, ale nic nie wyjdzie, dopóki administrator instalacji jej nie włączy.'}
          </div>
        </div>
      )}
      {v.lastError && (
        <div className="banner red" role="alert">
          <div>
            {v.lastError}
            {v.lastErrorAt && <span className="small"> ({DT.format(v.lastErrorAt)})</span>}
          </div>
        </div>
      )}
      <ToastZAdresuZapisu />
      {proba === 'ok' && (
        <div className="banner leaf-soft" role="status">
          <div>Wiadomość próbna wysłana — sprawdź strumień na Zulipie.</div>
        </div>
      )}

      <form action={zapiszPowiadomienia} className="stack" aria-label="Ustawienia powiadomień">
        <section className="card" aria-labelledby="h-zulip">
          <div className="card-head">
            <h2 id="h-zulip">Zulip</h2>
            <span className={`chip ${v.enabled ? 'leaf' : 'hatch'}`}>{v.enabled ? `włączone${v.enabledAt ? ` od ${DT.format(v.enabledAt)}` : ''}` : 'wyłączone'}</span>
          </div>
          <label className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 44 }}>
            <input type="checkbox" name="wlaczone" value="tak" defaultChecked={v.enabled} /> Wysyłaj alerty tej firmy na Zulip
          </label>
          <div className="notif-grid">
            <div className="field">
              <label htmlFor="n-adres">Adres Zulipa</label>
              <input className="input" id="n-adres" name="adres" type="url" placeholder="https://firma.zulipchat.com" defaultValue={v.zulipSite} maxLength={200} />
            </div>
            <div className="field">
              <label htmlFor="n-bot">Adres bota</label>
              <input className="input" id="n-bot" name="bot" type="email" placeholder="kompletor-bot@firma.zulipchat.com" defaultValue={v.zulipBotEmail} maxLength={254} />
            </div>
          </div>
          <p className="small" style={{ marginBottom: 0 }}>
            Klucz bota ustawiony: <b>{v.keySet ? 'tak' : 'nie'}</b>.{' '}
            <span className="muted">
              Klucz bota ustawia administrator instalacji (opis w Pomocy: „Powiadomienia”); panel go nie pokazuje.
            </span>
          </p>
        </section>

        <section className="card" aria-labelledby="h-trasy">
          <div className="card-head">
            <h2 id="h-trasy">Gdzie idą alerty</h2>
            <span className="muted small">Pusty strumień = alerty tej grupy nie wychodzą. Do {NAME_MAX} znaków.</span>
          </div>
          {ALERT_GROUPS.map((g) => {
            const r = v.routes[g]
            const kinds = kindsOf(g)
            return (
              <div key={g} className="notif-route">
                <div>
                  <b>{GROUP_LABEL[g]}</b>
                  <div className="small muted">{kinds.length ? kinds.map(kindLabel).join(', ') : 'Pozostałe alerty, także nowe rodzaje'}</div>
                </div>
                <div className="field">
                  <label htmlFor={`s-${g}`}>Strumień</label>
                  <input className="input" id={`s-${g}`} name={`strumien_${g}`} defaultValue={r?.stream ?? ''} maxLength={NAME_MAX} />
                </div>
                <div className="field">
                  <label htmlFor={`t-${g}`}>Temat</label>
                  <input className="input" id={`t-${g}`} name={`temat_${g}`} defaultValue={r?.topic ?? GROUP_LABEL[g]} maxLength={NAME_MAX} />
                </div>
              </div>
            )
          })}
          <div>
            <PasekZapisu />
          </div>
        </section>
      </form>

      <section className="card" aria-labelledby="h-proba" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h2 id="h-proba">Wiadomość próbna</h2>
          <span className="muted small">Idzie do strumienia i tematu wybranej grupy, także przed włączeniem</span>
        </div>
        <form action={wyslijProbna} className="notif-test" aria-label="Wiadomość próbna">
          <div className="field">
            <label htmlFor="p-grupa">Grupa</label>
            <select className="input" id="p-grupa" name="grupa" defaultValue="INNE">
              {ALERT_GROUPS.map((g) => (
                <option key={g} value={g}>
                  {GROUP_LABEL[g]}
                </option>
              ))}
            </select>
          </div>
          <button className="btn" type="submit" disabled={v.instanceSending !== true}>
            Wyślij wiadomość próbną
          </button>
        </form>
      </section>

      {/* po ilu kolejnych błędach połączenia konto kanału albo przewoźnika wyłącza się samo (z alertem) */}
      <section className="card" aria-labelledby="h-prog" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h2 id="h-prog">Automatyczne wyłączanie integracji</h2>
          <span className="muted small">Konto sklepu albo przewoźnika, które raz za razem odrzuca klucz albo ma złe ustawienia, wyłącza się samo i daje alert „Integracja wyłączona po błędach połączenia”</span>
        </div>
        <form action={zapiszProgWylaczenia} className="notif-test" aria-label="Próg automatycznego wyłączania integracji">
          <div className="field">
            <label htmlFor="p-prog">Wyłącz po tylu błędach z rzędu</label>
            <input className="input" id="p-prog" name="prog" type="number" inputMode="numeric" min={PROG_MIN} max={PROG_MAX} step={1} defaultValue={prog} required />
          </div>
          <button className="btn" type="submit">
            Zapisz próg
          </button>
        </form>
        <p className="muted small">
          Liczą się tylko odrzucone klucze, hasła i złe ustawienia konta. Chwilowe przerwy w sieci i błędy pojedynczego zamówienia się nie liczą. Wyłączone konto włączasz przyciskiem „Włącz ponownie” w jego szczegółach (Ustawienia → Sprzedaż i kanały → Kanały sprzedaży → konto albo Ustawienia → Wysyłka i druk → Przewoźnicy → Konta przewoźników).
        </p>
      </section>

      <section className="card" aria-labelledby="h-ostatnie" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h2 id="h-ostatnie">Ostatnie dostarczenia</h2>
          <span className="muted small">10 ostatnich</span>
        </div>
        {v.recent.length === 0 ? (
          <p className="muted small">Jeszcze nic nie wysłano.</p>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Rodzaj</th>
                <th>Stan</th>
                <th>Godzina</th>
              </tr>
            </thead>
            <tbody>
              {v.recent.map((d, i) => (
                <tr key={i}>
                  <td>
                    {kindLabel(d.kind)}
                    <span className="sub">{GROUP_LABEL[d.group as keyof typeof GROUP_LABEL] ?? d.group}</span>
                  </td>
                  <td>
                    <span className={`chip ${STATE[d.state]?.chip ?? 'hatch'}`}>{STATE[d.state]?.label ?? d.state}</span>
                    {d.lastError && <span className="sub">{d.lastError}</span>}
                  </td>
                  <td>{DT.format(d.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  )
}
