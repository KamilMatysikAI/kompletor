// Produkty → przycisk „Przygotowane oferty” (3b-2): ostatnie sprawdzenia „Przygotuj oferty” (zaznaczenie na
// liście produktów → pasek nad listą). Każde ma raport: ile produktów jest gotowych do wystawienia na każdym kanale,
// ile ma problemy i jakie. Tylko z uprawnieniem `produkty.dodawanie`.
import Link from 'next/link'
import { PustyStan } from '@/app/ui'
import { int, when } from '@/lib/panel/format'
import { requirePermission } from '@/lib/panel/kontekst'
import { OFERTY_RAPORTY, ostatniePrzebiegiOfert } from '@/lib/oferty/masowo'
import { STATUS_PRZEBIEGU } from './wspolne'

export const metadata = { title: 'Przygotowane oferty' }
export const dynamic = 'force-dynamic'

export default async function PrzygotowaneOferty() {
  const ctx = await requirePermission('produkty.dodawanie')
  const przebiegi = await ostatniePrzebiegiOfert(ctx.db, 20)
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Przygotowane oferty</h1>
          <div className="sub">Ostatnie 20 sprawdzeń, czy zaznaczone produkty są gotowe do wystawienia na Allegro, Empiku i w sklepie. Sprawdzenie niczego nie wystawia.</div>
        </div>
        <div className="np-head-actions">
          <Link className="btn" href="/produkty">
            Wróć do produktów
          </Link>
        </div>
      </header>
      {!przebiegi.length ? (
        <PustyStan tytul="Nie było jeszcze sprawdzenia">Na liście produktów zaznacz produkty (pole przy nazwie) i kliknij „Przygotuj oferty” na pasku nad listą.</PustyStan>
      ) : (
        <>
          <table className="tbl cards">
            <caption className="sr">Ostatnie sprawdzenia ofert</caption>
            <thead>
              <tr>
                <th scope="col">Zlecone</th>
                <th scope="col">Stan</th>
                <th scope="col" className="right">
                  Produkty
                </th>
                <th scope="col" className="right">
                  Gotowe
                </th>
                <th scope="col" className="right">
                  Z problemami
                </th>
                <th scope="col" className="right">
                  Nie sprawdzono
                </th>
              </tr>
            </thead>
            <tbody>
              {przebiegi.map((p) => {
                const suma = (k: 'gotowe' | 'zProblemami' | 'bledy') => (p.raport ? int(p.raport.kanaly.reduce((a, x) => a + x[k], 0)) : '—')
                return (
                  <tr key={p.id}>
                    <td data-label="Zlecone">
                      <Link href={`${OFERTY_RAPORTY}/${p.id}`}>{when(p.startedAt)}</Link>
                    </td>
                    <td data-label="Stan">{STATUS_PRZEBIEGU[p.status]?.tekst ?? p.status}</td>
                    <td data-label="Produkty" className="right num">
                      {int(p.produkty)}
                    </td>
                    <td data-label="Gotowe" className="right num">
                      {suma('gotowe')}
                    </td>
                    <td data-label="Z problemami" className="right num">
                      {suma('zProblemami')}
                    </td>
                    <td data-label="Nie sprawdzono" className="right num">
                      {suma('bledy')}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p className="muted small">Gotowe i z problemami to suma po wszystkich kontach: produkt sprawdzony na trzech kontach liczy się trzy razy.</p>
        </>
      )}
    </>
  )
}
