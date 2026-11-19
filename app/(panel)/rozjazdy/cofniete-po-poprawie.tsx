// „Cofnięte na stanowisku po poprawie” — sekcja na końcu ekranu rozjazdów. Biuro poprawiło stan
// w wFirmie, a stanowisko potem cofnęło brak: trzeba sprawdzić, czy poprawka w wFirmie nie jest do odwrócenia.
// Ostatnie 7 dni. Klient bazy przychodzi z ekranu (sesja, RLS).
import Link from 'next/link'
import type { PrismaClient } from '@prisma/client'
import { qty, when } from '@/lib/panel/format'
import { cofnietePoPoprawie } from '@/lib/stanowisko/cwiczenie'

export async function CofnietePoPoprawie({ db }: { db: PrismaClient }) {
  const lista = await cofnietePoPoprawie(db)
  return (
    <section className="card" aria-labelledby="h-cofniete" style={{ marginTop: 16 }}>
      <h2 id="h-cofniete" style={{ marginBottom: 8 }}>
        Cofnięte na stanowisku po poprawie ({lista.length})
      </h2>
      <p className="small muted">Ostatnie 7 dni: pozycje zamknięte przez biuro jako „Poprawione w wFirmie”, które magazyn potem cofnął („Jednak jest”).</p>
      {lista.length === 0 ? (
        <p className="small muted">Pusto — stanowisko nie cofnęło żadnego braku po poprawie biura.</p>
      ) : (
        <table className="tbl cards">
          <thead>
            <tr>
              <th>Produkt</th>
              <th>Ilość</th>
              <th>Poprawione w wFirmie</th>
              <th>Cofnięte</th>
              <th>Co zrobić</th>
              <th>Zamówienie</th>
            </tr>
          </thead>
          <tbody>
            {lista.map((p) => (
              <tr key={p.id}>
                <td data-label="Produkt">
                  <Link href={`/produkty/${p.productId}`}>{p.tytul}</Link> <span className="mono small muted">{p.sku}</span>
                </td>
                <td data-label="Ilość" className="num">{qty(p.ilosc, p.unit)}</td>
                <td data-label="Poprawione w wFirmie">{when(p.closedAt)}</td>
                <td data-label="Cofnięte">{when(p.withdrawnAt)}</td>
                <td data-label="Co zrobić">stanowisko cofnęło brak po Twojej poprawie — sprawdź stan w wFirmie</td>
                <td data-label="Zamówienie">
                  <Link href={`/zamowienia/${p.orderId}`}>szczegóły</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
