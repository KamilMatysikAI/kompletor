import Link from 'next/link'
import type { ReactNode } from 'react'
import { NaglowekSortu, PasekAkcjiMasowych, PoleZaznaczenia, PrzyciskLink, PustyStan, SortNaTelefonie, ToastZAdresuZapisu, ZaznaczanieTabeli, ZaznaczWszystkie } from '@/app/ui'
import { grupaZAdresu, isProductFilter, PAGE_SIZE, PRODUCT_FILTERS, PRODUCT_SORT_DEFAULT, productSortZ, productsPage, type ProductFilter, type ProductSortKey } from '@/lib/panel/dane'
import type { Kierunek } from '@/lib/panel/tabela'
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
import { drzewoKategorii, FILTR_BEZ_KATEGORII, MASOWO_MAX, warunekKategorii } from '@/lib/produkty/kategorie'
import { przypiszKategorieZaznaczonym } from './akcje-kategorie'
import { PrzypiszKategorie } from './_lista/przypisz-kategorie'
import { ZmienAktywnosc } from './_lista/zmien-aktywnosc'
import { ustawAktywnoscZaznaczonym } from './akcje-aktywnosc'
import { AKTYWNOSC_MASOWO_MAX } from '@/lib/produkty/aktywnosc'

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
  // filtr kategorii (cała gałąź) albo „bez kategorii”
  const kategoria = /^[a-z0-9]{1,40}$/i.test(one(sp.kategoria) ?? '') ? one(sp.kategoria)! : undefined
  // sortowanie całej listy (biała lista kluczy); domyślne (nazwa rosnąco) nie trafia do adresu
  const sort = productSortZ(sp)
  const sortDomyslny = sort.klucz === PRODUCT_SORT_DEFAULT.klucz && sort.kierunek === PRODUCT_SORT_DEFAULT.kierunek
  const [komp, kategorie, warunekKat] = await Promise.all([kompletnoscProduktow(ctx.db), drzewoKategorii(ctx.db), warunekKategorii(ctx.db, kategoria)])
  const [data, hasWfirma] = await Promise.all([productsPage(ctx.db, { filter, q, page, grupa, kategoria: warunekKat, sort, ...(brak ? { tylkoId: komp.braki[brak] } : {}) }), firmaMaWfirme(ctx.db)])
  const canAdd = ctx.permissions.has('produkty.dodawanie')
  const zdj = await glowneZdjecia(ctx.db, data.rows.map((r) => r.id)) // miniatury
  const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE))
  const qs = (patch: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries({ filtr, q, grupa: grupa ?? undefined, kategoria, sort: sortDomyslny ? undefined : sort.klucz, kier: sortDomyslny ? undefined : sort.kierunek, ...patch })) if (v !== undefined && v !== '' && !(k === 'filtr' && v === 'wszystkie') && !(k === 'strona' && Number(v) === 1)) p.set(k, String(v))
    const s = p.toString()
    return s ? `/produkty?${s}` : '/produkty'
  }
  // klik w nagłówek: ta sama kolumna odwraca kierunek, inna zaczyna od rosnąco; zawsze strona 1 (jak `adresSortu`)
  const kierunekKolumny = (k: ProductSortKey): Kierunek | undefined => (sort.klucz === k ? sort.kierunek : undefined)
  const sortHref = (k: ProductSortKey) => {
    const kier: Kierunek = sort.klucz === k && sort.kierunek === 'rosnaco' ? 'malejaco' : 'rosnaco'
    const domyslny = k === PRODUCT_SORT_DEFAULT.klucz && kier === PRODUCT_SORT_DEFAULT.kierunek
    return qs({ sort: domyslny ? undefined : k, kier: domyslny ? undefined : kier, strona: undefined })
  }
  const kolumnySortu: { klucz: ProductSortKey; etykieta: string; prawo?: boolean }[] = [
    { klucz: 'produkt', etykieta: 'Produkt' },
    ...(kategorie.length > 0 ? [{ klucz: 'kategoria' as const, etykieta: 'Kategoria' }] : []),
    { klucz: 'lokalizacja', etykieta: 'Lokalizacja' },
    { klucz: 'fizycznie', etykieta: 'Fizycznie', prawo: true },
    { klucz: 'zarezerwowane', etykieta: 'Zarezerwowane', prawo: true },
    { klucz: 'dostepne', etykieta: 'Dostępne', prawo: true },
    { klucz: 'oferty', etykieta: 'Oferty', prawo: true },
  ]
  const ileZAdresu = /^\d{1,4}$/.test(one(sp.ile) ?? '') ? one(sp.ile)! : '' // liczba w komunikacie wyłączenia
  return (
    <>
      <ToastZAdresuZapisu uwaga="uwaga" komunikaty={{ kategoria: 'Kategoria zapisana dla zaznaczonych produktów.', wylaczone: `Wyłączone produkty: ${ileZAdresu}.`, wlaczone: `Włączone produkty: ${ileZAdresu}.` }} />
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
        {/* drzewo kategorii także dla samego podglądu (ekran wymaga tylko panel.podglad, zmiany tylko produkty.dodawanie) */}
        {!canAdd && (
          <div className="np-head-actions">
            <Link className="btn" href="/produkty/kategorie">
              Kategorie
            </Link>
          </div>
        )}
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
            {/* drzewo kategorii firmy (przycisk, nie pozycja menu) */}
            <Link className="btn" href="/produkty/kategorie">
              Kategorie
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
        {!sortDomyslny && <input type="hidden" name="sort" value={sort.klucz} />}
        {!sortDomyslny && <input type="hidden" name="kier" value={sort.kierunek} />}
        <div className="field">
          <label htmlFor="p-q">Szukaj</label>
          <input className="input" id="p-q" name="q" defaultValue={q} placeholder="nazwa, SKU albo EAN" />
        </div>
        {kategorie.length > 0 && (
          <div className="field">
            <label htmlFor="p-kat">Kategoria</label>
            <select className="input" id="p-kat" name="kategoria" defaultValue={kategoria ?? ''}>
              <option value="">Wszystkie kategorie</option>
              <option value={FILTR_BEZ_KATEGORII}>Bez kategorii</option>
              {kategorie.map((k) => (
                <option key={k.id} value={k.id}>
                  {`${'  '.repeat(k.depth - 1)}${k.name} (${int(k.wGalezi)})`}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="field filters-go">
          <button className="btn primary" type="submit">
            Szukaj
          </button>
          {(q || kategoria) && (
            <Link className="btn ghost" href={qs({ q: undefined, kategoria: undefined, strona: undefined })}>
              Wyczyść
            </Link>
          )}
        </div>
      </form>

      {data.rows.length === 0 ? (
        <PustyStan
          tytul={q || kategoria ? 'Nic nie pasuje do wyszukiwania' : 'Nie ma produktów w tym widoku'}
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
              {kategorie.length > 0 && (
                <PrzypiszKategorie
                  akcja={przypiszKategorieZaznaczonym}
                  maks={MASOWO_MAX}
                  wroc={qs({ strona: page })}
                  opcje={[...kategorie.map((k) => ({ wartosc: k.id, etykieta: k.path })), { wartosc: FILTR_BEZ_KATEGORII, etykieta: 'Bez kategorii (usuń kategorię)' }]}
                />
              )}
              <ZmienAktywnosc akcja={ustawAktywnoscZaznaczonym} maks={AKTYWNOSC_MASOWO_MAX} wroc={qs({ strona: page })} domyslnie={filter === 'nieaktywne' ? 'tak' : 'nie'} />
            </PasekAkcjiMasowych>
          )}
        <SortNaTelefonie opcje={kolumnySortu.map((k) => ({ klucz: k.klucz, etykieta: k.etykieta, href: sortHref(k.klucz), kierunek: kierunekKolumny(k.klucz) }))} />
        <KlikalneWiersze>
          <table className="tbl cards plist">
            <thead>
              <tr>
                {canAdd && (
                  <th scope="col" className="ui-kol-ck">
                    <ZaznaczWszystkie />
                  </th>
                )}
                {kolumnySortu.map((k) => (
                  <NaglowekSortu key={k.klucz} etykieta={k.etykieta} href={sortHref(k.klucz)} kierunek={kierunekKolumny(k.klucz)} className={k.prawo ? 'right' : undefined} />
                ))}
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
                    {kategorie.length > 0 && (
                      <td data-label="Kategoria" className="small">
                        {p.kategoria ? <span title={p.kategoria.path}>{p.kategoria.name}</span> : <span className="muted">—</span>}
                      </td>
                    )}
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
