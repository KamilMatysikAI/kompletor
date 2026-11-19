// Raport dnia ćwiczenia pakowania „na sucho” — sekcja na końcu ekranu rozjazdów. Liczby z dzisiaj
// (strefa Warszawy) i lista „Do poprawy w wFirmie — z ćwiczenia”. Klient bazy przychodzi z ekranu (sesja, RLS).
import Link from 'next/link'
import type { PrismaClient } from '@prisma/client'
import { int, qty, when } from '@/lib/panel/format'
import { doPoprawy, raportDnia } from '@/lib/stanowisko/cwiczenie'
import { zamknijPozycjeDoPoprawy } from './akcje'

function czas(ms: number | null): string {
  if (ms === null) return '—'
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`
}

export async function RaportCwiczenia({ db, mozeZamykac }: { db: PrismaClient; mozeZamykac: boolean }) {
  const [r, lista] = await Promise.all([raportDnia(db), doPoprawy(db)])
  return (
    <section className="card" aria-labelledby="h-cwicz" style={{ marginTop: 16 }}>
      <div className="card-head">
        <h2 id="h-cwicz">Pakowanie próbne: dziś</h2>
        <Link className="btn small" href="/stanowisko">
          Stanowisko pakowania
        </Link>
      </div>
      <p className="small muted">
        Magazyn pakuje równolegle z BaseLinkerem; pakowanie próbne nie zmienia zamówień, rezerwacji ani stanu. Komentarzy klientów i odbiorców tu nie ma
        (zamówienia z kont „Tylko podgląd” nie trzymają danych osobowych).
      </p>
      <table className="tbl cards">
        <thead>
          <tr>
            <th>Spakowane próbnie</th>
            <th>Nie spakowano</th>
            <th>„Na półce nie było” (pozycje)</th>
            <th>Średni czas pakowania</th>
            <th>Otwarte, niezakończone</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td data-label="Spakowane próbnie" className="num">{int(r.spakowane)}</td>
            <td data-label="Nie spakowano" className="num">{int(r.nieSpakowano)}</td>
            <td data-label="„Na półce nie było” (pozycje)" className="num">{int(r.brakiPozycji)}</td>
            <td data-label="Średni czas pakowania" className="num">{czas(r.sredniCzasMs)}</td>
            <td data-label="Otwarte, niezakończone" className="num">{int(r.niezakonczone)}</td>
          </tr>
        </tbody>
      </table>
      <h3 style={{ margin: '16px 0 8px' }}>Do poprawy w wFirmie — z ćwiczenia ({lista.length})</h3>
      {lista.length === 0 ? (
        <p className="small muted">Pusto — na półkach było wszystko, czego szukał magazyn.</p>
      ) : (
        <table className="tbl cards">
          <thead>
            <tr>
              <th>Produkt</th>
              <th>Nie było na półce</th>
              <th>Kiedy</th>
              <th>Zamówienie</th>
              {mozeZamykac && <th />}
            </tr>
          </thead>
          <tbody>
            {lista.map((p) => (
              <tr key={p.id}>
                <td data-label="Produkt">
                  <Link href={`/produkty/${p.productId}`}>{p.tytul}</Link> <span className="mono small muted">{p.sku}</span>
                </td>
                <td data-label="Nie było na półce" className="num">{qty(p.ilosc, p.unit)}</td>
                <td data-label="Kiedy">{when(p.createdAt)}</td>
                <td data-label="Zamówienie">
                  <Link href={`/zamowienia/${p.orderId}`}>szczegóły</Link>
                </td>
                {mozeZamykac && (
                  <td className="nolabel">
                    <form action={zamknijPozycjeDoPoprawy}>
                      <input type="hidden" name="id" value={p.id} />
                      <button className="btn small" type="submit">
                        Poprawione w wFirmie
                      </button>
                    </form>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
