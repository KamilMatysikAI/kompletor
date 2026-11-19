// Ustawienia → Zasady rezerwacji: przełącznik sezonu i długości okresów rezerwacji, historia zmian,
// podgląd bufora bezpieczeństwa kont kanałów. Tylko z uprawnieniem `ustawienia` (inni dostają 404).
import Link from 'next/link'
import { requirePermission } from '@/lib/panel/kontekst'
import { reservationSettings, POLICY_HISTORY_LIMIT } from '@/lib/panel/ustawienia-rezerwacji'
import { formValuesOf, modeLabel, type PolicyFormState } from '@/lib/panel/ustawienia-rezerwacji-opis'
import { brakiDanychPrzelewu, informacjaBezDanychPrzelewu } from '@/lib/akcje/wariant-platnosci'
import { FormularzZasad } from './formularz'

export const metadata = { title: 'Zasady rezerwacji' }

const atFmt = new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })

export default async function ZasadyRezerwacji() {
  const ctx = await requirePermission('ustawienia')
  const [s, org] = await Promise.all([reservationSettings(ctx.db), ctx.db.organization.findFirst({ select: { settings: true } })])
  // pytanie o płatność z danymi do przelewu działa tylko z rachunkiem i pełną nazwą w Danych firmy
  const braki = brakiDanychPrzelewu(org?.settings ?? null)
  const bezDanychPrzelewu = braki.length ? `${informacjaBezDanychPrzelewu(braki)}.` : null
  const initial: PolicyFormState = { values: formValuesOf(s.policy), current: s.policy, version: s.version, error: null, field: null, savedAt: null }
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Zasady rezerwacji</h1>
          <div className="sub">
            Jak długo trzymamy towar dla nieopłaconego zamówienia i kiedy przypominamy o płatności. Teraz obowiązuje tryb{' '}
            <b>{modeLabel(s.policy.seasonMode)}</b>.
          </div>
        </div>
        <Link className="btn small" href="/pomoc/rezerwacje">
          Pomoc
        </Link>
      </header>

      <FormularzZasad initial={initial} bezDanychPrzelewu={bezDanychPrzelewu} />

      <section className="card" aria-labelledby="h-historia" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h2 id="h-historia">Historia zmian</h2>
          <span className="muted small">Ostatnie {POLICY_HISTORY_LIMIT} zapisów</span>
        </div>
        {s.history.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>
            Bez zmian, obowiązują wartości domyślne.
          </p>
        ) : (
          <ul className="plain pol-hist">
            {s.history.map((h) => (
              <li key={h.id}>
                <div>
                  <span className="mono small">{atFmt.format(h.at)}</span> · <b>{h.who}</b>
                </div>
                {h.changes.length === 0 ? (
                  <div className="muted small">zapis bez zmian wartości</div>
                ) : (
                  <ul className="pol-ch">
                    {h.changes.map((c) => (
                      <li key={c.label}>
                        {c.label}: {c.from} → <b>{c.to}</b>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card" aria-labelledby="h-bufor" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h2 id="h-bufor">Bufor bezpieczeństwa</h2>
          <span className="muted small">Tylko podgląd, w tej wersji bufora nie zmienia się z panelu</span>
        </div>
        <p className="small" style={{ marginTop: 0 }}>
          Tyle odejmujemy od dostępnego stanu (w jednostkach magazynowych), zanim wyślemy go do kanału. To wartość domyślna konta, pojedyncza oferta może mieć własny bufor.
        </p>
        {s.buffers.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>
            Brak skonfigurowanych kont kanałów.
          </p>
        ) : (
          <table className="tbl cards pol-buf">
            <thead>
              <tr>
                <th scope="col">Konto</th>
                <th scope="col">Kanał</th>
                <th scope="col" className="right">
                  Bufor
                </th>
              </tr>
            </thead>
            <tbody>
              {s.buffers.map((b) => (
                <tr key={b.id}>
                  <td data-label="Konto">
                    <b>{b.name}</b>
                    {!b.active && (
                      <>
                        {' '}
                        <span className="chip">nieaktywne</span>
                      </>
                    )}
                  </td>
                  <td data-label="Kanał">{b.channelLabel}</td>
                  <td data-label="Bufor" className="right">
                    {b.buffer}
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
