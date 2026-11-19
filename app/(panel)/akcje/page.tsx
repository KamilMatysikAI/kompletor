// Plan akcji (cień). Co system zrobiłby zamiast automatów BaseLinkera: maile i powiadomienia z reguł
// w kodzie (lib/akcje). Nic nie wychodzi do klientów: w cieniu plan to „wysłałbym”, w pracy czeka na wysyłkę
// (osobne zadanie). Bez danych klientów — numer zamówienia, reguła, kiedy, stan; podgląd treści na żądanie
// z danymi firmy i zamówienia, bez imienia i adresu klienta (lib/akcje/panel.ts, lib/akcje/podglad.ts).
import Link from 'next/link'
import { planDnia, podgladPlanu } from '@/lib/akcje/panel'
import { REGULY } from '@/lib/akcje/reguly'
import { DROGA_DANYCH_FIRMY } from '@/lib/akcje/wariant-platnosci'
import { int, time } from '@/lib/panel/format'
import { requireSession } from '@/lib/panel/kontekst'
import { firmaMaBlWPanelu } from '@/lib/kanaly/firma'
import { addDays, toWarsaw } from '@/lib/rdzen/kalendarz'
import { PustyStan, TrybKanalu } from '@/app/ui'

export const metadata = { title: 'Maile do klientów: podgląd' }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

const STATE_LABEL = { PLANNED: 'zaplanowana', SKIPPED: 'pominięta', DONE: 'wykonana' } as const
// stan wysyłki maila (MailDelivery)
const MAIL_LABEL: Record<string, { label: string; chip: string }> = {
  SENT: { label: 'mail wysłany', chip: 'leaf' },
  SENDING: { label: 'wysyłanie', chip: 'blue' },
  FAILED: { label: 'mail nie wyszedł', chip: 'red' },
  UNCERTAIN: { label: 'mail mógł nie dojść', chip: 'amber' },
  CZEKA: { label: 'mail czeka', chip: 'amber' },
  POMINIETY: { label: 'mail pominięty', chip: 'hatch' },
  ODBITY: { label: 'mail wrócił (niedoręczony)', chip: 'red' }, // odbicie po wysłaniu
}
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
/** 1 akcja, 2–4 akcje (bez 12–14), 5+ akcji. */
const akcje = (n: number) => (n === 1 ? 'akcja' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'akcje' : 'akcji')

export default async function PlanAkcji({ searchParams }: Props) {
  const ctx = await requireSession()
  const sp = await searchParams
  const now = new Date()
  const [plan, hasBl] = await Promise.all([planDnia(ctx.db, one(sp.dzien), now), firmaMaBlWPanelu(ctx.db)])
  const podgladId = one(sp.podglad)
  const podglad = podgladId ? await podgladPlanu(ctx.db, podgladId.slice(0, 64)) : null
  const today = toWarsaw(now).day
  const link = (dzien: string, extra = '') => `/akcje?dzien=${dzien}${extra}`
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Maile do klientów: podgląd</h1>
          <div className="sub">
            {/* firma bez BaseLinkera nie czyta o BaseLinkerze */}
            {hasBl
              ? 'Maile, które zastępują automatyczne akcje BaseLinkera. Konto „Tylko podgląd”: Kompletor zapisuje, jaki mail by wysłał, a wysyła go BaseLinker. '
              : 'Maile do klientów z reguł firmy. Konto „Tylko podgląd”: Kompletor tylko zapisuje, jaki mail by wysłał. '}
            Konto aktywne: mail wychodzi pocztą firmy (Ustawienia → Komunikacja i poczta → Poczta), gdy wysyłka jest włączona.
          </div>
        </div>
        <div className="actions">
          <Link className="btn" href={link(addDays(plan.dzien, -1))}>
            ← Poprzedni dzień
          </Link>
          {plan.dzien < today && (
            <Link className="btn" href={link(addDays(plan.dzien, 1))}>
              Następny dzień →
            </Link>
          )}
        </div>
      </header>

      <section className="card" aria-labelledby="h-liczby">
        <h2 id="h-liczby" style={{ marginBottom: 8 }}>
          Dzień {plan.dzien}: {int(plan.razem)} {akcje(plan.razem)}
        </h2>
        <table className="tbl cards">
          <thead>
            <tr>
              <th>Reguła</th>
              {hasBl && <th>Akcje BL</th>}
              <th>Tylko podgląd (bez wysyłki)</th>
              <th>Aktywne (czeka na wysyłkę)</th>
              <th>Pominięte</th>
            </tr>
          </thead>
          <tbody>
            {plan.liczby.map((l) => (
              <tr key={l.rule}>
                <td data-label="Reguła">{REGULY[l.rule].nazwa}</td>
                {hasBl && (
                  <td data-label="Akcje BL" className="muted">
                    {REGULY[l.rule].bl.join(', ')}
                  </td>
                )}
                <td data-label="Tylko podgląd (bez wysyłki)">{int(l.SUCHO)}</td>
                <td data-label="Aktywne (czeka na wysyłkę)">{int(l.PRACA)}</td>
                <td data-label="Pominięte">{int(l.pominiete)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {hasBl && (
        <p className="small muted" style={{ marginTop: 8 }}>
          Pełna lista 33 akcji zamówień i 2 produktowych z BaseLinkera: <Link href="/pomoc/akcje-bl">Pomoc, „Automatyczne akcje BaseLinkera”</Link>.
        </p>
        )}
      </section>

      {plan.czekaNaPoczte > 0 && (
        <div className="banner amber" role="status">
          <div>
            {int(plan.czekaNaPoczte)} {akcje(plan.czekaNaPoczte)} z kont aktywnych czeka na wysyłkę. Jeśli to trwa dłużej niż kilka minut, sprawdź{' '}
            <Link href="/ustawienia/poczta">Ustawienia → Komunikacja i poczta → Poczta</Link> (serwer, hasło, włącznik wysyłki).
          </div>
        </div>
      )}

      {podglad && (
        <section className="card" aria-labelledby="h-podglad">
          <h2 id="h-podglad" style={{ marginBottom: 8 }}>
            Podgląd: {REGULY[podglad.rule].nazwa} · {podglad.cel}
          </h2>
          <p className="small muted">
            {podglad.uwaga} Adresat: {podglad.odbiorca === 'biuro' ? 'biuro firmy' : 'klient sklepu'}.
          </p>
          {podglad.informacje && podglad.informacje.length > 0 && (
            <div className="banner blue" role="status">
              <div>
                {podglad.informacje.map((t) => (
                  <p key={t} style={{ margin: 0 }}>
                    {t}{' '}
                    {t.includes(DROGA_DANYCH_FIRMY) && <Link href="/ustawienia/firma">Otwórz Dane firmy</Link>}
                  </p>
                ))}
              </div>
            </div>
          )}
          {podglad.braki.length > 0 && (
            <div className="banner amber" role="status">
              <div>
                <b>Zanim ten mail wyjdzie z Kompletora:</b>
                <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
                  {podglad.braki.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          <p>
            <b>Temat:</b> {podglad.temat}
          </p>
          <pre className="small" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {podglad.tekst}
          </pre>
          <p className="small">
            <Link href={link(plan.dzien)}>Zamknij podgląd</Link>
          </p>
        </section>
      )}

      {plan.wiersze.length === 0 ? (
        <PustyStan tytul="Tego dnia nie ma maili do klientów">Plan powstaje co 5 minut z bieżącego stanu zamówień i produktów. Treść maili zmienisz w Ustawienia → Komunikacja i poczta → Szablony maili.</PustyStan>
      ) : (
        <section className="card" aria-labelledby="h-lista">
          <h2 id="h-lista" style={{ marginBottom: 8 }}>
            Lista
          </h2>
          <table className="tbl cards">
            <thead>
              <tr>
                <th>Kiedy</th>
                <th>Cel</th>
                <th>Reguła</th>
                <th>Tryb</th>
                <th>Stan</th>
                <th>Treść</th>
              </tr>
            </thead>
            <tbody>
              {plan.wiersze.map((w) => (
                <tr key={w.id}>
                  <td data-label="Kiedy">{time(w.dueAt)}</td>
                  <td data-label="Cel">
                    <Link className="ord" href={w.targetType === 'ZAMOWIENIE' ? `/zamowienia/${w.targetId}` : `/produkty/${w.targetId}`}>
                      {w.cel}
                    </Link>
                  </td>
                  <td data-label="Reguła">{REGULY[w.rule].nazwa}</td>
                  <td data-label="Tryb">
                    <TrybKanalu tryb={w.mode === 'PRACA' ? 'PRACA' : 'CIEN'} rozmiar="sm" />
                  </td>
                  <td data-label="Stan">
                    {STATE_LABEL[w.state]}
                    {w.reason && <span className="sub">{w.reason}</span>}
                    {w.poczta && (
                      <span className="sub">
                        <span className={`chip ${MAIL_LABEL[w.poczta.stan]?.chip ?? 'hatch'}`}>{MAIL_LABEL[w.poczta.stan]?.label ?? w.poczta.stan}</span>
                        {w.poczta.adresat && ` ${w.poczta.adresat}`}
                        {w.poczta.blad && ` · ${w.poczta.blad}`}
                      </span>
                    )}
                  </td>
                  <td data-label="Treść">
                    <Link href={link(plan.dzien, `&podglad=${encodeURIComponent(w.id)}`)}>podgląd</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  )
}
