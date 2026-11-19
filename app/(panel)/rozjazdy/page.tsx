// Rozjazdy z BaseLinkerem (cień). Ekran pomocniczy: wejście przyciskiem z karty „Cień kontra BaseLinker” na
// pulpicie, bez pozycji w menu. Dane: dzienny raport rozjazdów (lib/cien/raport-dzienny.ts) — same
// liczby, numery zamówień i SKU, bez danych klientów. Do pierwszego raportu pusty stan.
import Link from 'next/link'
import { latestDailyReport } from '@/lib/cien/raport-dzienny'
import { accounts } from '@/lib/panel/dane'
import { requirePermission } from '@/lib/panel/kontekst'
import { firmaMaBlWPanelu } from '@/lib/kanaly/firma'
import { CofnietePoPoprawie } from './cofniete-po-poprawie'
import { RaportCwiczenia } from './raport-cwiczenia'
import { PrzyciskLink, PustyStan, TrybKanalu } from '@/app/ui'

export const metadata = { title: 'Porównanie z BaseLinkerem' }

const zl = (cents: number) => (cents / 100).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default async function Rozjazdy() {
  const ctx = await requirePermission('rozjazdy.podglad')
  const accs = (await accounts(ctx.db)).filter((a) => a.active && a.channel !== 'RECZNE')
  const r = await latestDailyReport(ctx.db)
  const hasBl = await firmaMaBlWPanelu(ctx.db) // firma bez BL nie ma z czym porównywać
  const sales = r?.sales?.accounts ?? []
  const todo: string[] = []
  if (r) {
    for (const a of sales) {
      if (a.onlyHere.length) todo.push(`${a.name}: tylko u nas ${a.onlyHere.join(', ')}`)
      if (a.onlyBl.length) todo.push(`${a.name}: tylko w BL ${a.onlyBl.join(', ')}`)
      if (a.amountDiffs.length) todo.push(`${a.name}: inna kwota ${a.amountDiffs.map((d) => d.ref).join(', ')}`)
    }
    for (const a of r.orders.accounts) for (const [k, n] of Object.entries(a.divergences)) todo.push(`${a.name}: status ${k.trim()} (${n})`)
    if (r.stocks.physicalVsBl) {
      // rozjazdy „w drodze” i wyjaśnione ruchem biura oznaczone, nie zerują wyniku
      const tag = (d: (typeof r.stocks.physicalVsBlList)[number]) => d.sku + (d.inTransit ? ' (w drodze)' : d.office ? ' (ruch biura)' : '')
      const forOk = r.stocks.physicalVsBlForOk
      todo.push(`Stan u nas ≠ BL${forOk !== undefined ? ` (do wyniku ${forOk} z ${r.stocks.physicalVsBl})` : ''}: ${r.stocks.physicalVsBlList.map(tag).join(', ')}${r.stocks.physicalVsBl > r.stocks.physicalVsBlList.length ? ' …' : ''}`)
    }
    if (r.stalePending.count) todo.push(`Ruchy niepotwierdzone > 24 h: ${r.stalePending.count}`)
    if (r.overcommit.count) todo.push(`Nadmiar rezerwacji > 30 min: ${r.overcommit.skus.join(', ')}`)
    if (r.invariants.count) todo.push(`Naruszenia niezmienników: ${r.invariants.count}`)
    const o = r.officeItems
    if (o?.count)
      todo.push(`Dla biura (nie zeruje serii): wysłane bez faktury ${o.shippedWithoutInvoice}, faktura bez WZ ${o.invoiceWithoutWz}${o.otherManual ? `, inne ręczne ${o.otherManual}` : ''}, „Do wyjaśnienia” ${o.toClarify}, nowe ${o.newSinceYesterday}`)
    else if (!o && r.toClarify.count) todo.push(`Zamówienia „Do wyjaśnienia”: ${Object.entries(r.toClarify.byReason).map(([k, n]) => `${k} ${n}`).join(', ')}`)
  }
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Porównanie z BaseLinkerem</h1>
          <div className="sub">Porównanie zamówień, statusów i stanów z BaseLinkerem, osobno dla każdego kanału. Kanał przełączamy po 7 dniach z rzędu bez rozjazdów.</div>
        </div>
        <Link className="btn small" href="/pomoc/migracja-z-baselinkera">
          Pomoc
        </Link>
      </header>
      {!hasBl && !r ? (
        <PustyStan
          tytul="Porównanie dotyczy tylko firm z BaseLinkerem"
          akcja={
            <PrzyciskLink href="/ustawienia/przeprowadzka" wariant="drugorzedny">
              Przenieś dane z BaseLinkera
            </PrzyciskLink>
          }
        >
          Ta firma nie ma podłączonego BaseLinkera, więc nie ma z czym porównywać. Jeśli przechodzisz z BaseLinkera, zacznij od przeprowadzki.
        </PustyStan>
      ) : !r ? (
        <PustyStan tytul="Pierwszy raport porównania jeszcze nie powstał">Pojawi się po pierwszej pełnej dobie odczytu zamówień (liczony po północy za dzień poprzedni). Do tego czasu zamówienia prowadzi BaseLinker.</PustyStan>
      ) : (
        <section className="card" aria-labelledby="h-raport">
          <h2 id="h-raport" style={{ marginBottom: 8 }}>
            Raport za {r.day}: {r.ok ? 'bez rozjazdów' : 'są rozjazdy do wyjaśnienia'}
          </h2>
          {sales.length > 0 && (
            <table className="tbl cards">
              <thead>
                <tr>
                  <th>Kanał</th>
                  <th>Kompletor</th>
                  <th>BaseLinker</th>
                  <th>Wynik</th>
                </tr>
              </thead>
              <tbody>
                {sales.map((a) => (
                  <tr key={`${a.channel}:${a.channelAccountId}`}>
                    <td data-label="Kanał">{a.name}</td>
                    <td data-label="Kompletor">
                      {a.ours.count} zam. / {zl(a.ours.cents)} zł
                    </td>
                    <td data-label="BaseLinker">
                      {a.bl.count} zam. / {zl(a.bl.cents)} zł
                    </td>
                    <td data-label="Wynik">{a.ok ? 'zgodne' : 'rozjazd'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="small muted" style={{ marginTop: 8 }}>
            Faktury BL czekające na rozliczenie: {r.invoices.pending}. „Uratowane sprzedaże”: {r.saved.offers}. Naruszenia niezmienników: {r.invariants.count}.
          </p>
          {todo.length > 0 && (
            <>
              <h3 style={{ marginTop: 12 }}>Do wyjaśnienia</h3>
              <ul>
                {todo.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
      {accs.length > 0 && (
        <section className="card" aria-labelledby="h-kan" style={{ marginTop: 16 }}>
          <h2 id="h-kan" style={{ marginBottom: 8 }}>
            Kanały w porównaniu
          </h2>
          <table className="tbl cards">
            <thead>
              <tr>
                <th>Kanał</th>
                <th>Tryb</th>
                <th>Dni bez rozjazdów</th>
              </tr>
            </thead>
            <tbody>
              {accs.map((a) => {
                const streak = r?.streaks[`${a.channel}|${a.channelAccountId}`]
                return (
                  <tr key={`${a.channel}:${a.channelAccountId}`}>
                    <td data-label="Kanał">{a.name}</td>
                    <td data-label="Tryb">
                      <TrybKanalu tryb={a.stockMode} rozmiar="sm" />
                    </td>
                    <td data-label="Dni bez rozjazdów" className={streak === undefined ? 'muted' : undefined}>
                      {streak === undefined ? 'brak danych' : `${streak} z 7`}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>
      )}
      <RaportCwiczenia db={ctx.db} mozeZamykac={ctx.permissions.has('pakowanie.do_poprawy')} />
      <CofnietePoPoprawie db={ctx.db} />
    </>
  )
}
