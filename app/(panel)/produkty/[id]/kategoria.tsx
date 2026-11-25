// Kategoria w karcie produktu: bieżąca kategoria z pełną ścieżką i źródłem przypisania, zmiana dla osób
// z uprawnieniem do danych produktów; przycisk „Kategorie” dla każdego z podglądem panelu. Drzewo kategorii: przycisk „Kategorie” (ekran Produkty → Kategorie).
import { Karta, Przycisk, PrzyciskLink, Wybor } from '@/app/ui'
import { ZRODLO_KATEGORII_LABEL, type KategoriaWiersz, type ZrodloKategorii } from '@/lib/produkty/kategorie'
import { ustawKategorie } from './kategoria-akcje'

export function KategoriaProduktu({ productId, kategoria, zrodlo, drzewo, canEdit }: { productId: string; kategoria: { id: string; path: string } | null; zrodlo: string | null; drzewo: KategoriaWiersz[]; canEdit: boolean }) {
  const skad = zrodlo && zrodlo in ZRODLO_KATEGORII_LABEL ? ZRODLO_KATEGORII_LABEL[zrodlo as ZrodloKategorii] : null
  // drzewo kategorii widzi każdy z podglądem panelu (zmiany na ekranie i tak tylko z `produkty.dodawanie`)
  const akcje = (
    <PrzyciskLink href="/produkty/kategorie" rozmiar="sm" wariant="cichy">
      Kategorie
    </PrzyciskLink>
  )
  if (!drzewo.length)
    return <Karta id="kategoria" tytul="Kategoria" opis="Firma nie ma jeszcze kategorii produktów: drzewo zakłada się na ekranie Kategorie albo kolumną „Kategoria” w pliku CSV." akcje={akcje} />
  return (
    <Karta id="kategoria" tytul="Kategoria" opis="Lista produktów filtruje po kategorii razem z podkategoriami" akcje={akcje}>
      <p>
        {kategoria ? <b>{kategoria.path}</b> : <b>bez kategorii</b>}
        {kategoria && skad && <span className="muted small"> · {skad}</span>}
      </p>
      {canEdit && (
        <form action={ustawKategorie} className="filters">
          <input type="hidden" name="produkt" value={productId} />
          <Wybor id="kategoria-produktu" etykieta="Kategoria produktu" name="kategoria" defaultValue={kategoria?.id ?? ''} opcje={[{ wartosc: '', etykieta: 'bez kategorii' }, ...drzewo.map((k) => ({ wartosc: k.id, etykieta: k.path }))]} />
          <Przycisk type="submit">Zapisz kategorię</Przycisk>
        </form>
      )}
    </Karta>
  )
}
