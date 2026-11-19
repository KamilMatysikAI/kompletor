// Produkty i stany → Produkty bez stanu: lista SKU i kategorii sklepu, których oferty import łączy
// z produktem bez stanu (e-book, usługa) zamiast z magazynem. Lista zapisana tutaj nie wraca z presetu firmy, także
// pusta. Tylko z uprawnieniem `produkty.dodawanie` (inni dostają 404).
import Link from 'next/link'
import { requirePermission } from '@/lib/panel/kontekst'
import { digitalProducts, DIGITAL_LIST_LIMIT, readNoStock } from '@/lib/produkty/bez-stanu'
import { FormularzListy } from './formularz'

export const metadata = { title: 'Produkty bez stanu' }

export default async function ProduktyBezStanu() {
  const ctx = await requirePermission('produkty.dodawanie')
  const [list, digital] = await Promise.all([readNoStock(ctx.db), digitalProducts(ctx.db)])
  const listed = new Set(list.skus)
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Produkty bez stanu</h1>
          <div className="sub">Oferta z SKU albo z kategorii sklepu z tej listy łączy się przy imporcie z produktem bez stanu (e-book, usługa), a nie z magazynem.</div>
        </div>
      </header>

      {!list.editedInPanel && (
        <div className="banner blue">
          <div>Listę ustawiono przy konfiguracji firmy. Po pierwszym zapisie tutaj obowiązuje wyłącznie lista z panelu, także pusta.</div>
        </div>
      )}

      <FormularzListy initial={{ skus: list.skus.join('\n'), shopCategories: list.shopCategories.join('\n'), error: null, savedAt: null }} />

      <section className="card" aria-labelledby="h-produkty" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h2 id="h-produkty">Produkty bez stanu w katalogu</h2>
          <span className="muted small">{digital.length === DIGITAL_LIST_LIMIT ? `pierwsze ${DIGITAL_LIST_LIMIT}` : digital.length}</span>
        </div>
        {digital.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>
            Brak. Dodasz je przyciskiem „Dodaj produkt” na liście produktów albo importem katalogu.
          </p>
        ) : (
          <ul className="plain">
            {digital.map((p) => (
              <li key={p.id}>
                <span className="mono">{p.sku}</span> · <Link href={`/produkty/${p.id}`}>{p.title}</Link>
                {!listed.has(p.sku) && <span className="muted small"> · SKU spoza listy (oferta z kategorii sklepu albo usunięte z listy)</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}
