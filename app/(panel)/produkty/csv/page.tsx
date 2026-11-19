// Produkty → przycisk „Import i eksport CSV” (jedna z luk wobec BaseLinkera). Eksport katalogu do pliku
// i import z pliku (nowe produkty i zmiany po SKU). Bez pozycji w menu: wejście przyciskiem nad listą produktów.
// Ekran widzi osoba z uprawnieniem `produkty.dodawanie` (import zmienia katalog); eksport sam w sobie wymaga podglądu.
import Link from 'next/link'
import { requirePermission } from '@/lib/panel/kontekst'
import { firmaMaWfirme } from '@/lib/kanaly/firma'
import { CSV_MAKS_WIERSZY, KOLUMNY } from '@/lib/produkty/csv'
import { VAT_LABEL } from '@/lib/produkty/karta'
import { ImportCsv } from './formularz'

export const metadata = { title: 'Import i eksport CSV' }

export default async function ProduktyCsv() {
  const ctx = await requirePermission('produkty.dodawanie')
  const hasWfirma = await firmaMaWfirme(ctx.db).catch(() => false)
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Import i eksport CSV</h1>
          <div className="sub">
            <Link href="/produkty">← Produkty</Link> · katalog produktów w pliku, który otworzysz w Excelu albo Arkuszach Google
          </div>
        </div>
      </header>

      <section className="card" aria-labelledby="h-eksport">
        <div className="card-head">
          <h2 id="h-eksport">Eksport</h2>
          <span className="muted small">wszystkie produkty firmy, bez danych klientów</span>
        </div>
        <p className="small" style={{ marginTop: 0 }}>
          Plik ma te same kolumny co import: popraw ceny, wagi albo opisy w arkuszu i wgraj go z powrotem niżej.
        </p>
        <a className="btn" href="/api/produkty/eksport" download>
          Pobierz plik CSV
        </a>
      </section>

      <section className="card" aria-labelledby="h-import" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h2 id="h-import">Import</h2>
          <span className="muted small">do {CSV_MAKS_WIERSZY} produktów na raz</span>
        </div>
        <ul className="small" style={{ marginTop: 0 }}>
          <li>Wiersz to produkt rozpoznany po SKU. SKU jest już w katalogu: zmienią się pola z wypełnionych komórek. SKU nowe: powstaje nowy produkt ze stanem.</li>
          <li>Pusta komórka niczego nie zmienia ani nie kasuje. Ten sam plik wgrany drugi raz nic nie zmieni.</li>
          <li>Wiersz z błędem (np. zły EAN) jest pominięty i opisany w raporcie z numerem linii; pozostałe się zapisują.</li>
          <li>
            Kolumny (pierwsza linia pliku): {KOLUMNY.map((k) => k.naglowek).join(', ')}. Wymagane: SKU, a dla nowego produktu także Nazwa. VAT: {Object.keys(VAT_LABEL).join(', ')}. Liczby z
            przecinkiem albo kropką.
          </li>
          <li>„Stan” ustawia stan początkowy tylko nowego produktu; stan istniejącego zmienia korekta na karcie produktu.</li>
          <li>„Grupa wariantów”: ten sam tekst w kilku produktach (np. „KUBEK-2026”) łączy je w warianty (rozmiary, kolory); karta produktu pokazuje pozostałe warianty.</li>
          {hasWfirma && <li>Firma prowadzi stany w wFirmie: nowe produkty ze stanem zakładasz w wFirmie, a import zmienia tylko pola, które nie przychodzą z wFirmy.</li>}
        </ul>
        <ImportCsv />
      </section>
    </>
  )
}
