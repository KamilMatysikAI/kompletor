// tabela danych panelu. Komponent serwerowy: kolumny deklaratywne, komórki jako gotowe węzły,
// sortowanie i paginacja jako linki w adresie (`?sort=&kier=&strona=&ile=`, lib/panel/tabela.ts), sticky nagłówek,
// widok kart na telefonie (etykieta kolumny przy wartości), pusty stan. Zaznaczanie, akcje masowe i wybór kolumn
// to wyspy klienckie z app/ui/tabela-klient.tsx. Danych nie sortuje sama: ekran czyta `sortZ`/`stronaZ` z adresu
// i pyta bazę, więc działa tak samo przy 30 i przy 30 000 wierszach.
import Link from 'next/link'
import type { ReactNode } from 'react'
import { adresSortu, adresZ, ILE_NA_STRONE, zakresStrony, type SortTabeli } from '@/lib/panel/tabela'
import { KlikalneWiersze, MenuWiecej, PasekAkcjiMasowych, PoleZaznaczenia, WyborKolumn, ZaznaczanieTabeli, ZaznaczWszystkie } from './tabela-klient'

export interface KolumnaTabeli {
  klucz: string
  etykieta: string
  wyrownanie?: 'lewo' | 'prawo'
  sortowalna?: boolean
  /** np. '120px' albo '12ch' */
  szerokosc?: string
  /** pozycja w „Kolumny” (kolumny bez tej flagi są zawsze widoczne) */
  ukrywalna?: boolean
  ukrytaDomyslnie?: boolean
}

export interface WierszTabeli {
  id: string
  komorki: Record<string, ReactNode>
  /** cały wiersz otwiera ten adres */
  href?: string
  /** pasek z lewej: błąd / ostrzeżenie / do wyjaśnienia */
  ton?: 'blad' | 'ostrzezenie' | 'uwaga'
  /** opis wiersza dla czytnika przy polu zaznaczenia, np. numer zamówienia */
  etykieta?: string
}

type Parametry = Record<string, string | string[] | undefined>

const TON_WIERSZA = { blad: 'row-alert', ostrzezenie: 'row-warn', uwaga: 'row-viol' } as const

export function Tabela({
  id,
  etykieta,
  kolumny,
  wiersze,
  adres,
  sort,
  zaznaczanie,
  akcjeMasowe,
  paginacja,
  pustyStan,
  narzedzia,
  kolumnyOsoby,
  narzedziaWMenu,
  akcjeMasoweStale,
}: {
  /** stały identyfikator (zapis wyboru kolumn), np. 'zamowienia' */
  id: string
  /** podpis tabeli dla czytnika ekranu */
  etykieta: string
  kolumny: KolumnaTabeli[]
  wiersze: WierszTabeli[]
  /** bieżąca ścieżka i parametry: z nich powstają linki sortowania i stron */
  adres?: { sciezka: string; parametry: Parametry }
  sort?: SortTabeli
  zaznaczanie?: boolean
  /** przyciski/formularze w pasku po zaznaczeniu; w formularzach `<ZaznaczoneUkryte />` */
  akcjeMasowe?: ReactNode
  paginacja?: { strona: number; ile: number; razem: number }
  pustyStan?: ReactNode
  /** dodatkowe elementy w pasku nad tabelą (np. eksport) */
  narzedzia?: ReactNode
  /** wybór kolumn zapisany na koncie osoby (ukryte z sesji + akcja zapisu), zamiast w przeglądarce */
  kolumnyOsoby?: { ukryte: string[] | null; zapisz: (tabela: string, ukryte: string[]) => Promise<void> }
  /** na telefonie narzędzia i „Kolumny” pod jednym przyciskiem „Więcej” */
  narzedziaWMenu?: boolean
  /**
   * (R7 przeglądu TwojOMS): wiersz nad tabelą stoi zawsze (narzędzia po prawej); ciemny pasek z akcjami po pierwszym zaznaczeniu
   * (powód podaje `akcjeMasowe`); narzędzia i „Kolumny” jako ikony po prawej stronie paska zamiast osobnego rzędu.
   */
  akcjeMasoweStale?: boolean
}) {
  const ukrywalne = kolumny.filter((k) => k.ukrywalna)
  const maPasek = ukrywalne.length > 0 || narzedzia
  const wPasku = !!(zaznaczanie && akcjeMasowe && akcjeMasoweStale)
  const tresc = (
    <>
      {zaznaczanie && akcjeMasowe && (
        <PasekAkcjiMasowych
          stale={wPasku}
          narzedzia={
            wPasku && maPasek ? (
              <>
                {narzedzia}
                {ukrywalne.length > 0 && <WyborKolumn tabela={id} kolumny={ukrywalne} osoba={kolumnyOsoby} ikona />}
              </>
            ) : undefined
          }
        >
          {akcjeMasowe}
        </PasekAkcjiMasowych>
      )}
      {maPasek && !wPasku && (
        <div className="ui-tabela-pasek">
          {narzedziaWMenu ? (
            <MenuWiecej>
              {narzedzia}
              {ukrywalne.length > 0 && <WyborKolumn tabela={id} kolumny={ukrywalne} osoba={kolumnyOsoby} />}
            </MenuWiecej>
          ) : (
            <>
              {narzedzia}
              {ukrywalne.length > 0 && <WyborKolumn tabela={id} kolumny={ukrywalne} osoba={kolumnyOsoby} />}
            </>
          )}
        </div>
      )}
      {wiersze.length === 0 ? (
        (pustyStan ?? (
          <div className="empty">
            <p>Brak pozycji.</p>
          </div>
        ))
      ) : (
        <KlikalneWiersze className="ui-tabela-ramka">
          <table className="tbl cards ui-tabela" data-tabela={id}>
            <caption className="sr">{etykieta}</caption>
            <thead>
              <tr>
                {zaznaczanie && (
                  <th scope="col" className="ui-kol-ck">
                    <ZaznaczWszystkie />
                  </th>
                )}
                {kolumny.map((k) => (
                  <th
                    key={k.klucz}
                    scope="col"
                    data-kol={k.klucz}
                    className={k.wyrownanie === 'prawo' ? 'right' : undefined}
                    style={k.szerokosc ? { width: k.szerokosc } : undefined}
                    aria-sort={sort?.klucz === k.klucz ? (sort.kierunek === 'rosnaco' ? 'ascending' : 'descending') : undefined}
                  >
                    {k.sortowalna && adres ? (
                      <Link className="ui-sort" href={adresSortu(adres.sciezka, adres.parametry, sort, k.klucz)}>
                        {k.etykieta}
                        <span className="ui-sort-znak" aria-hidden="true">
                          {sort?.klucz === k.klucz ? (sort.kierunek === 'rosnaco' ? '▲' : '▼') : '↕'}
                        </span>
                      </Link>
                    ) : (
                      k.etykieta
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {wiersze.map((w) => (
                <tr key={w.id} className={[w.ton ? TON_WIERSZA[w.ton] : '', w.href ? 'ui-klik' : ''].filter(Boolean).join(' ') || undefined} data-href={w.href} tabIndex={w.href ? 0 : undefined}>
                  {zaznaczanie && (
                    <td className="ui-kol-ck nolabel">
                      <PoleZaznaczenia id={w.id} etykieta={`Zaznacz ${w.etykieta ?? w.id}`} />
                    </td>
                  )}
                  {kolumny.map((k) => (
                    <td key={k.klucz} data-kol={k.klucz} data-label={k.etykieta} className={k.wyrownanie === 'prawo' ? 'right' : undefined}>
                      {w.komorki[k.klucz] ?? <span className="muted">–</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </KlikalneWiersze>
      )}
      {paginacja && adres && <Paginacja {...paginacja} adres={adres} />}
    </>
  )
  return <div className="ui-tabela-blok">{zaznaczanie ? <ZaznaczanieTabeli ids={wiersze.map((w) => w.id)}>{tresc}</ZaznaczanieTabeli> : tresc}</div>
}

export function Paginacja({ strona, ile, razem, adres }: { strona: number; ile: number; razem: number; adres: { sciezka: string; parametry: Parametry } }) {
  const z = zakresStrony(strona, ile, razem)
  const link = (zm: Record<string, string | number | undefined>) => adresZ(adres.sciezka, adres.parametry, zm)
  return (
    <nav className="ui-paginacja" aria-label="Strony">
      <span className="muted small" role="status">
        {z.od}–{z.do} z {razem}
      </span>
      <span className="ui-paginacja-ile">
        <span className="small muted">Na stronie:</span>
        {ILE_NA_STRONE.map((n) => (
          <Link key={n} href={link({ ile: n, strona: undefined })} className="btn small" aria-current={n === ile ? 'true' : undefined}>
            {n}
          </Link>
        ))}
      </span>
      <span className="ui-paginacja-strzalki">
        {strona > 1 ? (
          <Link className="btn small" href={link({ strona: strona - 1 })} rel="prev">
            ‹ Poprzednia
          </Link>
        ) : (
          <span className="btn small is-disabled" aria-disabled="true">
            ‹ Poprzednia
          </span>
        )}
        <span className="small">
          Strona {strona} z {z.stron}
        </span>
        {strona < z.stron ? (
          <Link className="btn small" href={link({ strona: strona + 1 })} rel="next">
            Następna ›
          </Link>
        ) : (
          <span className="btn small is-disabled" aria-disabled="true">
            Następna ›
          </span>
        )}
      </span>
    </nav>
  )
}
