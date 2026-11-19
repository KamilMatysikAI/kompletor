// Zamówienia → Dodaj zamówienie: zamówienie telefoniczne, hurtowe albo testowe bez sklepu. Idzie tą
// samą drogą co API (`przyjmijZamowienie`, kanał „Zamówienia ręczne”): rezerwuje towar od razu, przewoźnik z reguł
// firmy, potem zwykła ścieżka (Co dalej, pakowanie, wysyłka). Tylko z uprawnieniem `zamowienia.dodawanie`; dane klienta
// wpisuje osoba z `klienci.dane`.
import Link from 'next/link'
import { requirePermission } from '@/lib/panel/kontekst'
import { przewoznicyFirmy } from '@/lib/praca/dane'
import { blokadaInstancji } from '@/lib/kanaly/tryb'
import { firmaPrzechodziZBlWPanelu } from '@/lib/kanaly/firma'
import { nowyNumerReczny } from '@/lib/zamowienia/formularz'
import { FormularzNowego } from './formularz'

export const metadata = { title: 'Dodaj zamówienie' }
export const dynamic = 'force-dynamic'

export default async function DodajZamowienie() {
  const ctx = await requirePermission('zamowienia.dodawanie')
  const [przewoznicy, firmaZBl] = await Promise.all([przewoznicyFirmy(ctx.db, 'RECZNE'), firmaPrzechodziZBlWPanelu(ctx.db)])
  // formularz zawsze widoczny (staging w pełnej mocy); bez trybu pracy tylko komunikat z powodem.
  // blokada instancji dotyczy tylko firm z BaseLinkerem (ta sama reguła co karta zamówienia).
  const blokada = blokadaInstancji(process.env, firmaZBl)
  const praca = !blokada
  return (
    <>
      <p className="small">
        <Link className="back" href="/zamowienia">
          ← Zamówienia
        </Link>
      </p>
      <header className="page-head">
        <div>
          <h1>Dodaj zamówienie</h1>
          <div className="sub">Zamówienie przyjęte telefonicznie, osobiście albo hurtowo. Po zapisaniu od razu rezerwuje towar i otwiera się jego karta.</div>
        </div>
      </header>
      {!praca && (
        <div className="banner amber" role="status">
          <div>
            Zamówienie się zapisze i od razu zarezerwuje towar, ale przyciski dalszej obsługi na karcie (zbieranie, pakowanie, wysłane, zmiana statusu) są wyłączone: {blokada} Do tego czasu zamówienie widać na liście i na karcie, bez przycisków.
          </div>
        </div>
      )}
      {!przewoznicy.length ? (
        <div className="banner amber" role="status">
          <div>Firma nie ma reguł przewoźników, więc zamówienie nie dostałoby sposobu dostawy. Reguły ustawia instalacja albo przeprowadzka z BaseLinkera (ekranu edycji w panelu jeszcze nie ma).</div>
        </div>
      ) : (
        <FormularzNowego numer={nowyNumerReczny(new Date())} przewoznicy={przewoznicy} mozeKlient={ctx.permissions.has('klienci.dane')} />
      )}
    </>
  )
}
