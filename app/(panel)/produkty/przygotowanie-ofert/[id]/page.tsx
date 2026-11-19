// Produkty → „Przygotowane oferty” → raport jednego sprawdzenia (3b-2). Per kanał: ile produktów gotowych do
// wystawienia, ile z problemami i jakimi, ile nie udało się sprawdzić; lista produktów z problemami z przejściem do
// karty produktu → „Publikacja”. W toku strona odświeża się sama. Tylko z uprawnieniem `produkty.dodawanie`.
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Baner, Karta, ListaOpisowa } from '@/app/ui'
import { int, when } from '@/lib/panel/format'
import { requirePermission } from '@/lib/panel/kontekst'
import { OFERTY_MASOWO_MAX_LISTY, OFERTY_RAPORTY, przebiegOfert } from '@/lib/oferty/masowo'
import { OdswiezajWToku } from '../odswiezaj'
import { nazwyKont, STATUS_PRZEBIEGU } from '../wspolne'

export const metadata = { title: 'Raport przygotowania ofert' }
export const dynamic = 'force-dynamic'

type Props = { params: Promise<{ id: string }> }

export default async function RaportPrzygotowania({ params }: Props) {
  const ctx = await requirePermission('produkty.dodawanie')
  const { id } = await params
  const p = await przebiegOfert(ctx.db, id)
  if (!p) notFound()
  const r = p.raport
  const ids = r ? [...new Set(r.lista.map((x) => x.productId))] : []
  const [produkty, nazwaKonta] = await Promise.all([
    ids.length ? ctx.db.product.findMany({ where: { id: { in: ids } }, select: { id: true, title: true, sku: true } }) : Promise.resolve([]),
    r?.lista.length ? nazwyKont(ctx.db) : Promise.resolve(null),
  ])
  const karta = new Map(produkty.map((x) => [x.id, x]))
  const st = STATUS_PRZEBIEGU[p.status] ?? STATUS_PRZEBIEGU.RUNNING
  const pozycji = r ? r.kanaly.reduce((a, k) => a + k.zProblemami + k.bledy, 0) : 0
  return (
    <>
      {p.status === 'RUNNING' && <OdswiezajWToku />}
      <header className="page-head">
        <div>
          <h1>Raport przygotowania ofert</h1>
          <div className="sub">Sprawdza, czy zaznaczone produkty są gotowe do wystawienia na każdym koncie Allegro, Empiku i sklepu. Niczego nie wystawia: ofertę wystawiasz na karcie produktu → „Publikacja”.</div>
        </div>
        <div className="np-head-actions">
          <Link className="btn" href={OFERTY_RAPORTY}>
            Wszystkie raporty
          </Link>
          <Link className="btn" href="/produkty">
            Wróć do produktów
          </Link>
        </div>
      </header>

      <Baner ton={st.ton} tytul={`Sprawdzenie ${st.tekst}:`} rola="status">
        zlecone {when(p.startedAt)}, produktów: {int(p.produkty)}
        {p.finishedAt ? `, skończone ${when(p.finishedAt)}` : ''}
        {p.status === 'RUNNING' ? '. Strona odświeża się sama; możesz ją zamknąć i wrócić później (Produkty → „Przygotowane oferty”).' : ''}
        {p.error ? `. ${p.error}` : ''}
      </Baner>

      {r && r.kanaly.length === 0 && <p className="muted">Firma nie ma kont Allegro, Empiku ani sklepu, więc nie było czego sprawdzać. Konto podłączysz w Ustawienia → Sprzedaż i kanały → Kanały sprzedaży.</p>}

      {r && r.kanaly.length > 0 && (
        <div className="grid g3">
          {r.kanaly.map((k) => {
            const problemy = Object.entries(k.problemy).sort((a, b) => b[1] - a[1])
            return (
              <Karta key={k.kanal} tytul={k.nazwa}>
                <ListaOpisowa
                  pozycje={[
                    { etykieta: 'Gotowe do wystawienia', wartosc: int(k.gotowe) },
                    { etykieta: 'Z problemami', wartosc: int(k.zProblemami) },
                    ...(k.bledy ? [{ etykieta: 'Nie udało się sprawdzić', wartosc: int(k.bledy) }] : []),
                  ]}
                />
                {problemy.length > 0 && (
                  <>
                    <h3 className="small">Najczęstsze problemy</h3>
                    <ul className="plain small">
                      {problemy.slice(0, 10).map(([t, n]) => (
                        <li key={t}>
                          {t} <b>({int(n)})</b>
                        </li>
                      ))}
                    </ul>
                    {problemy.length > 10 && <p className="muted small">Pozostałe problemy ({int(problemy.length - 10)}) widać na liście produktów niżej.</p>}
                  </>
                )}
              </Karta>
            )
          })}
        </div>
      )}

      {r && r.lista.length > 0 && (
        <Karta
          tytul="Produkty do poprawy"
          opis={
            pozycji > r.lista.length
              ? `Pierwsze ${int(OFERTY_MASOWO_MAX_LISTY)} pozycji z ${int(pozycji)}. Kliknij produkt, żeby otworzyć jego „Publikację”.`
              : 'Kliknij produkt, żeby otworzyć jego „Publikację”: tam widać podgląd oferty i co poprawić.'
          }
        >
          <table className="tbl cards">
            <caption className="sr">Produkty z problemami</caption>
            <thead>
              <tr>
                <th scope="col">Produkt</th>
                <th scope="col">Konto</th>
                <th scope="col">Co poprawić</th>
              </tr>
            </thead>
            <tbody>
              {r.lista.map((x) => {
                const prod = karta.get(x.productId)
                return (
                  <tr key={`${x.productId}|${x.klucz}`}>
                    <td data-label="Produkt">
                      {prod ? (
                        <>
                          <Link href={`/produkty/${x.productId}/publikacja`}>{prod.title}</Link>
                          <span className="sub mono"> {prod.sku}</span>
                        </>
                      ) : (
                        <span className="muted">produkt usunięty</span>
                      )}
                    </td>
                    <td data-label="Konto">{nazwaKonta ? nazwaKonta(x.klucz, x.kanal) : x.kanal}</td>
                    <td data-label="Co poprawić">
                      {x.blad ? (
                        x.blad
                      ) : (
                        <ul className="plain">
                          {x.problemy.map((t) => (
                            <li key={t}>{t}</li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Karta>
      )}

      {r && r.lista.length === 0 && r.kanaly.length > 0 && <p className="muted">Wszystkie zaznaczone produkty są gotowe do wystawienia na każdym koncie.</p>}
    </>
  )
}
