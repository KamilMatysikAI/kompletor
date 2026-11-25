// Produkty → przycisk „Kategorie”: drzewo kategorii produktów firmy. Dodanie, zmiana nazwy, przeniesienie,
// kolejność i usunięcie z przeniesieniem produktów. Bez pozycji w menu: wejście przyciskiem nad listą produktów.
// Podgląd jak lista produktów: `requireSession` wymaga `panel.podglad` (te same kategorie są w filtrze listy); zmiany:
// uprawnienie `produkty.dodawanie` (formularze tylko z nim, akcje serwera sprawdzają je same przez `requirePermission`).
// Kategorię produktu ustawia karta produktu, lista (zaznaczone → „Przypisz kategorię”) albo plik CSV (kolumna „Kategoria”).
import Link from 'next/link'
import { Karta, PoleTekstowe, Przycisk, PustyStan, ToastZAdresuZapisu, Wybor } from '@/app/ui'
import { requireSession } from '@/lib/panel/kontekst'
import { drzewoKategorii, MAX_GLEBOKOSC, MAX_KATEGORII, NAZWA_KATEGORII_MAX } from '@/lib/produkty/kategorie'
import { dodajKategorieAkcja } from './akcje'
import { DrzewoKategorii } from './drzewo'

export const metadata = { title: 'Kategorie produktów' }

const KOMUNIKATY = { dodana: 'Kategoria dodana.', nazwa: 'Nazwa zapisana.', przeniesiona: 'Kategoria przeniesiona.', kolejnosc: 'Kolejność zapisana.', usunieta: 'Kategoria usunięta.' }

export default async function KategorieProduktow() {
  const ctx = await requireSession()
  const canEdit = ctx.permissions.has('produkty.dodawanie')
  const drzewo = await drzewoKategorii(ctx.db)
  const bezKategorii = await ctx.db.product.count({ where: { categoryId: null, active: true } })
  return (
    <>
      <ToastZAdresuZapisu komunikaty={KOMUNIKATY} />
      <header className="page-head">
        <div>
          <h1>Kategorie produktów</h1>
          <div className="sub">
            <Link href="/produkty">← Produkty</Link> · drzewo kategorii firmy (do {MAX_GLEBOKOSC} poziomów); produkt ma jedną kategorię, filtr listy obejmuje podkategorie
          </div>
        </div>
      </header>

      {canEdit && (
        <Karta tytul="Dodaj kategorię" opis={`Nazwa do ${NAZWA_KATEGORII_MAX} znaków, bez znaku „>”. Najwyżej ${MAX_KATEGORII} kategorii w firmie.`}>
          <form action={dodajKategorieAkcja} className="filters">
            <PoleTekstowe id="kat-nowa" name="nazwa" etykieta="Nazwa" required maxLength={NAZWA_KATEGORII_MAX} />
            <Wybor
              id="kat-nowa-rodzic"
              name="rodzic"
              etykieta="Kategoria nadrzędna"
              defaultValue=""
              opcje={[{ wartosc: '', etykieta: 'najwyższy poziom' }, ...drzewo.filter((k) => k.depth < MAX_GLEBOKOSC).map((k) => ({ wartosc: k.id, etykieta: k.path }))]}
            />
            <Przycisk type="submit" wariant="glowny">
              Dodaj
            </Przycisk>
          </form>
        </Karta>
      )}

      <Karta
        tytul="Drzewo kategorii"
        opis={
          <>
            Kategorii: {drzewo.length} · aktywne produkty bez kategorii: <Link href="/produkty?kategoria=brak">{bezKategorii}</Link> · wiele kategorii naraz: plik CSV, kolumna „Kategoria” (
            <Link href="/produkty/csv">Import i eksport CSV</Link>)
          </>
        }
        className="pr-mt"
      >
        {drzewo.length === 0 ? (
          <PustyStan tytul="Nie ma jeszcze kategorii">
            {canEdit ? 'Dodaj pierwszą kategorię wyżej albo wgraj plik CSV z kolumną „Kategoria” (np. „Napoje > Soki”): brakujące kategorie powstaną same.' : 'Kategorie zakłada osoba z uprawnieniem do dodawania produktów.'}
          </PustyStan>
        ) : (
          <DrzewoKategorii
            drzewo={drzewo.map((k) => ({ id: k.id, parentId: k.parentId, name: k.name, path: k.path, depth: k.depth, produktow: k.produktow, wGalezi: k.wGalezi, podkategorii: k.podkategorii }))}
            canEdit={canEdit}
            maxGlebokosc={MAX_GLEBOKOSC}
          />
        )}
      </Karta>
    </>
  )
}
