// Wykres „miesiąc dzień po dniu” (pulpit). Przełącznik liczba / kwota to zwykły link (?miara=kwota) — działa bez JS.
import Link from 'next/link'
import type { OutsideCore } from '@/lib/panel/dane'
import { money, monthName, outsideCoreNote } from '@/lib/panel/format'
import { CHART, monthChart } from '@/lib/panel/wykres'

const DOW = ['nd', 'pon', 'wt', 'śr', 'czw', 'pt', 'sob']

export function WykresMiesiaca(p: {
  now: Date
  month: { day: number; count: number; gross: number; future: boolean }[]
  totals: { count: number; gross: number; outside: OutsideCore }
  today: number
  miara: 'liczba' | 'kwota'
  monthIndex: number // 1–12
  year: number
}) {
  const isMoney = p.miara === 'kwota'
  const g = monthChart(p.month.map((d) => ({ day: d.day, value: isMoney ? d.gross : d.count, future: d.future })), p.today)
  const fmtAxis = (v: number) => (isMoney ? `${Math.round(v).toLocaleString('pl-PL')} zł` : String(v))
  const fmtVal = (v: number) => (isMoney ? money(v) : String(v))
  const name = monthName(p.now)
  const note = outsideCoreNote(p.totals.outside)
  const mm = String(p.monthIndex).padStart(2, '0')
  const dow = (d: number) => DOW[new Date(Date.UTC(p.year, p.monthIndex - 1, d)).getUTCDay()]
  return (
    <section className="card" aria-labelledby="h-mies">
      <div className="card-head">
        <div>
          <h2 id="h-mies">{name.charAt(0).toUpperCase() + name.slice(1)} dzień po dniu</h2>
          <div className="small muted">
            od 1.{mm} do dziś:{' '}
            <b>
              {p.totals.count} zamówień · {money(p.totals.gross)} brutto
            </b>{' '}
            · wszystkie kanały
            {note ? ` · ${note}` : ''}
          </div>
        </div>
        <div className="tabs" role="tablist" aria-label="Miara" style={{ margin: 0, border: 0 }}>
          <Link role="tab" aria-selected={!isMoney} href="/pulpit" scroll={false}>
            Liczba
          </Link>
          <Link role="tab" aria-selected={isMoney} href="/pulpit?miara=kwota" scroll={false}>
            Kwota brutto
          </Link>
        </div>
      </div>
      <svg viewBox={`0 0 ${CHART.W} ${CHART.H}`} className="mchart" role="img" aria-label={`Zamówienia dziennie, ${name}, ${isMoney ? 'kwota brutto' : 'liczba'}`}>
        {g.grid.map((l) => (
          <g key={l.value}>
            <line x1={CHART.L} x2={CHART.W - 8} y1={l.y} y2={l.y} className={l.base ? 'grid base' : 'grid'} />
            <text x={CHART.L - 6} y={l.y + 4} className="ax" textAnchor="end">
              {fmtAxis(l.value)}
            </text>
          </g>
        ))}
        {g.ticks.map((t) => (
          <text key={t.day} x={t.x} y={CHART.H - 8} className={t.today ? 'ax today' : 'ax'} textAnchor="middle">
            {t.day}
          </text>
        ))}
        {g.bars.map((b) => (
          <g key={b.day}>
            <path className={b.today ? 'bar today' : 'bar'} d={b.path}>
              <title>{`${dow(b.day)} ${b.day}.${mm}: ${fmtVal(b.value)}${b.today ? ' (dziś do teraz)' : ''}`}</title>
            </path>
          </g>
        ))}
      </svg>
      <details className="small" style={{ marginTop: 6 }}>
        <summary style={{ cursor: 'pointer' }}>Tabela</summary>
        <table className="tbl" style={{ maxWidth: 420 }}>
          <thead>
            <tr>
              <th>Dzień</th>
              <th className="right">Zamówienia</th>
              <th className="right">Kwota brutto</th>
            </tr>
          </thead>
          <tbody>
            {p.month
              .filter((d) => !d.future)
              .map((d) => (
                <tr key={d.day}>
                  <td>
                    {d.day}.{mm}
                  </td>
                  <td className="right num">{d.count}</td>
                  <td className="right num">{money(d.gross)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </details>
    </section>
  )
}
