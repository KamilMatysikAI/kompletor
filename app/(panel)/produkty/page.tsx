import Link from 'next/link'
import type { ReactNode } from 'react'
import { PasekAkcjiMasowych, PoleZaznaczenia, PrzyciskLink, PustyStan, ToastZAdresuZapisu, ZaznaczanieTabeli, ZaznaczWszystkie } from '@/app/ui'
import { grupaZAdresu, isProductFilter, PAGE_SIZE, PRODUCT_FILTERS, productsPage, type ProductFilter } from '@/lib/panel/dane'
import { int, qty } from '@/lib/panel/format'
import { requireSession } from '@/lib/panel/kontekst'
import { firmaMaWfirme } from '@/lib/kanaly/firma'
import { Miniatura } from '../_komponenty/miniatura'
import { KlikalneWiersze } from '../_komponenty/wiersze'
import { glowneZdjecia } from '@/lib/produkty/zdjecia'
import { isBrakProduktu, kompletnoscProduktow, type BrakProduktu } from '@/lib/produkty/kompletnosc'
import { KafleKompletnosci } from './kafle'
import { OFERTY_MASOWO_MAX, OFERTY_RAPORTY } from '@/lib/oferty/masowo'
import { przygotujOfertyZaznaczonych } from './akcje-oferty'
import { synchronizujStany } from './akcje-stany'
import { PrzygotujOferty } from './_lista/przygotuj-oferty'

export const metadata = { title: 'Produkty' }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default async function Produkty({ searchParams }: Props) {
  const ctx = await requireSession()
  const sp = await searchParams
  // `filtr` to zakładka listy albo brak danych z kafla kompletności (ten sam zbiór co licznik kafla)
  const brak: BrakProduktu | null = isBrakProduktu(one(sp.filtr)) ? (one(sp.filtr) as BrakProduktu) : null
  const filter: ProductFilter = !brak && isProductFilter(one(sp.filtr)) ? (one(sp.filtr) as ProductFilter) : 'wszystkie'
  const filtr = brak ?? filter
  const q = one(sp.q) ?? ''
  const page = Math.max(1, Number(one(sp.strona)) || 1)
  const grupa = grupaZAdresu(one(sp.grupa)) // warianty jednej grupy
  const komp = await kompletnoscProduktow(ctx.db)
  const [data, hasWfirma] = await Promise.all([productsPage(ctx.db, { filter, q, page, grupa, ...(brak ? { tylkoId: komp.braki[brak] } : {}) }), firmaMaWfirme(ctx.db)])
  const canAdd = ctx.permissions.has('produkty.dodawanie')
  const zdj = await glowneZdjecia(ctx.db, data.rows.map((r) => r.id)) // miniatury
  const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE))
  const qs = (patch: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries({ filtr, q, grupa: grupa ?? undefined, ...patch })) if (v !== undefined && v !== '' && !(k === 'filtr' && v === 'wszystkie') && !(k === 'strona' && Number(v) === 1)) p.set(k, String(v))
    const s = p.toString()
    return s ? `/produkty?${s}` : '/produkty'
  }
  return (
    <>
      <ToastZAdresuZapisu />
      {one(sp.stany) === 'zlecone' && (
        <p className="small" role="status">
          Odczyt stanów z wFirmy zlecony: nowe stany pojawią się w ciągu kilku minut (odśwież stronę).
        </p>
      )}
      {one(sp.stany) === 'blad' && (
        <p className="small" role="alert">
          Nie udało się zlecić odczytu stanów, spróbuj ponownie za chwilę.
        </p>
      )}
      <header className="page-head">
        <div>
          <h1>Produkty</h1>
          <div className="sub">
            {hasWfirma
              ? `Katalog z importu (${int(data.total)} w widoku) · fizycznie − zarezerwowane = dostępne · stan fizyczny pochodzi z magazynu w wFirmie`
              : `Katalog (${int(data.total)} w widoku) · fizycznie − zarezerwowane = dostępne · stan prowadzi ten system: start z kanału, zmiany korektą w karcie produktu`}
          </div>
        </div>
        {canAdd && (
          <div className="np-head-actions">
            {/* 19.11.2026: pełny odczyt stanów z wFirmy na żądanie (np. po przyjęciu towaru w wFirmie) */}
            {hasWfirma && (
              <form action={synchronizujStany}>
                <button className="btn" type="submit" title="Zleca odczyt stanów z wFirmy teraz; nowe stany pojawią się w ciągu kilku minut">
                  Synchronizuj stany
                </button>
              </form>
            )}
            <Link className="btn" href="/produkty/bez-stanu">
              Produkty bez stanu
            </Link>
            <Link className="btn" href="/produkty/csv">
              Import i eksport CSV
            </Link>
            {/* zdjęcia produktów bez zdjęcia z feedu produktowego sklepu (Google Merchant XML) */}
            <Link className="btn" href="/produkty/zdjecia-z-feedu">
              Zdjęcia z feedu
            </Link>
            {/* raporty „Przygotuj oferty” (zaznaczenie na liście → pasek nad tabelą) */}
            <Link className="btn" href={OFERTY_RAPORTY}>
              Przygotowane oferty
            </Link>
            <Link className="btn primary" href="/produkty/nowy">
              Dodaj produkt
            </Link>
          </div>
        )}
      </header>

      <KafleKompletnosci
        k={komp}
        aktywny={brak}
        bezStanuHref={canAdd ? '/produkty/bez-stanu' : null}
        strefyHref={ctx.permissions.has('ustawienia') ? '/ustawienia/strefy' : null}
      />

      <nav className="tabs" aria-label="Filtr produktów">
        {(Object.keys(PRODUCT_FILTERS) as ProductFilter[]).map((f) => (
          <Link key={f} href={qs({ filtr: f, strona: undefined })} aria-selected={!brak && f === filter} role="tab">
            {PRODUCT_FILTERS[f]}
          </Link>
        ))}
      </nav>

      {grupa && (
        <p className="small" role="status">
          Warianty jednej grupy ({int(data.total)}).{' '}
          <Link href={qs({ grupa: undefined, strona: undefined })}>Pokaż wszystkie produkty</Link>
        </p>
      )}

      <form className="filters-grid" method="get" action="/produkty">
        {filtr !== 'wszystkie' && <input type="hidden" name="filtr" value={filtr} />}
        {grupa && <input type="hidden" name="grupa" value={grupa} />}
        <div className="field">
          <label htmlFor="p-q">Szukaj</label>
          <input className="input" id="p-q" name="q" defaultValue={q} placeholder="nazwa, SKU albo EAN" />
        </div>
        <div className="field filters-go">
          <button className="btn primary" type="submit">
            Szukaj
          </button>
          {q && (
            <Link className="btn ghost" href={qs({ q: undefined, strona: undefined })}>
              Wyczyść
            </Link>
          )}
        </div>
      </form>

      {data.rows.length === 0 ? (
        <PustyStan
          tytul={q ? 'Nic nie pasuje do wyszukiwania' : 'Nie ma produktów w tym widoku'}
          akcja={
            !q && canAdd ? (
              <PrzyciskLink href="/produkty/nowy" wariant="glowny">
                Dodaj produkt
              </PrzyciskLink>
            ) : undefined
          }
        >
          {q ? 'Sprawdź pisownię albo szukaj po SKU.' : canAdd ? 'Dodaj pierwszy produkt albo pobierz oferty podłączonego sklepu (Ustawienia → Sprzedaż i kanały → Kanały sprzedaży → konto → „Pobierz oferty”).' : 'Produkty dodaje osoba z uprawnieniem do dodawania produktów.'}
        </PustyStan>
      ) : (
        <Zaznaczanie ids={canAdd ? data.rows.map((r) => r.id) : null}>
          {canAdd && (
            <PasekAkcjiMasowych>
              <PrzygotujOferty akcja={przygotujOfertyZaznaczonych} maks={OFERTY_MASOWO_MAX} />
            </PasekAkcjiMasowych>
          )}
        <KlikalneWiersze>
          <table className="tbl cards plist">
            <thead>
              <tr>
                {canAdd && (
                  <th scope="col" className="ui-kol-ck">
                    <ZaznaczWszystkie />
                  </th>
                )}
                <th>Produkt</th>
                <th>Lokalizacja</th>
                <th className="right">Fizycznie</th>
                <th className="right">Zarezerwowane</th>
                <th className="right">Dostępne</th>
                <th className="right">Oferty</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((p) => {
                const href = `/produkty/${p.id}`
                return (
                  <tr key={p.id} className={`orow ${p.available === 0 && p.kind === 'STOCKED' ? 'row-alert' : ''}`} data-href={href} tabIndex={0} aria-label={`${p.title}: otwórz produkt`}>
                    {canAdd && (
                      <td className="ui-kol-ck nolabel">
                        <PoleZaznaczenia id={p.id} etykieta={`Zaznacz ${p.title}`} />
                      </td>
                    )}
                    <td data-label="Produkt" className="with-img">
                      <span className="pline">
                        <Miniatura title={p.title} size={40} zdjecie={zdj.get(p.id)} />
                        <span>
                          <Link className="ord" href={href}>
                            {p.title}
                          </Link>
                          <span className="sub">
                            <span className="mono">{p.sku}</span>
                            {p.ean && <> · EAN {p.ean}</>}
                            {p.kind === 'BUNDLE' && <span className="chip blue"> zestaw</span>}
                            {p.kind === 'DIGITAL' && <span className="chip"> bez stanu (e-book, usługa)</span>}
                            {!p.active && <span className="chip"> wyłączony</span>}
                            {/* wariant z grupy; klik pokazuje całą grupę na liście. Link niesie tylko zakładkę
                                „Wyłączone” (tak liczy licznik), inne filtry odpadają, żeby lista miała tyle pozycji, ile licznik */}
                            {p.groupId && p.wariantow !== null && p.wariantow > 1 && !grupa && (
                              <Link className="chip blue" href={qs({ grupa: p.groupId, strona: undefined, q: undefined, filtr: filter === 'nieaktywne' ? 'nieaktywne' : 'wszystkie' })} aria-label={`Pokaż ${p.wariantow} wariantów tej grupy`}>
                                {' '}
                                wariant · {p.wariantow} w grupie
                              </Link>
                            )}
                          </span>
                        </span>
                      </span>
                    </td>
                    <td data-label="Lokalizacja" className="mono">
                      {p.location ?? <span className="muted">—</span>}
                    </td>
                    {p.kind === 'BUNDLE' ? (
                      <td data-label="Stan" colSpan={3} className="small muted">
                        zestaw rezerwuje składniki — stan w karcie produktu
                      </td>
                    ) : p.kind === 'DIGITAL' ? (
                      <td data-label="Stan" colSpan={3} className="small muted">
                        bez stanu — nie rezerwuje, na fakturze jako usługa
                      </td>
                    ) : (
                      <>
                        <td data-label="Fizycznie" className="right num">
                          {p.physical === null ? '—' : qty(p.physical, p.unit)}
                        </td>
                        <td data-label="Zarezerwowane" className="right num">
                          {p.reserved === null ? '—' : qty(p.reserved, p.unit)}
                        </td>
                        <td data-label="Dostępne" className="right num">
                          {p.available === null ? '—' : <b className={p.available === 0 ? 'zero' : ''}>{qty(p.available, p.unit)}</b>}
                        </td>
                      </>
                    )}
                    <td data-label="Oferty" className="right num">
                      {p.offers}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </KlikalneWiersze>
        </Zaznaczanie>
      )}

      {pages > 1 && (
        <nav className="pager" aria-label="Strony">
          {page > 1 ? (
            <Link className="btn" href={qs({ strona: page - 1 })}>
              Poprzednia
            </Link>
          ) : (
            <span />
          )}
          <span className="muted small">
            strona {page} z {pages}
          </span>
          {page < pages ? (
            <Link className="btn" href={qs({ strona: page + 1 })}>
              Następna
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </>
  )
}

/** zaznaczanie wierszy tylko z uprawnieniem do akcji na zaznaczonych (dziś „Przygotuj oferty”). */
function Zaznaczanie({ ids, children }: { ids: string[] | null; children: ReactNode }) {
  return ids ? <ZaznaczanieTabeli ids={ids}>{children}</ZaznaczanieTabeli> : <>{children}</>
}
