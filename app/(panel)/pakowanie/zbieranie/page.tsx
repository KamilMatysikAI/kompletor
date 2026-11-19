// Pakowanie → Lista zbierania: zaznaczone zamówienia z kolejki jako jedna trasa po magazynie — produkty
// zsumowane i ułożone po półkach, ze zdjęciem i rozpisaniem na koszyki. Otwierana przyciskiem „Lista zbierania”
// w pasku zaznaczonych (bez pozycji w menu). `?z=<id,id…>`, najwyżej 100 zamówień (jak stanowisko).
import Link from 'next/link'
import { listaKoszykow } from '@/lib/koszyki/koszyki'
import { listaZbierania } from '@/lib/koszyki/zbieranie'
import { requirePermission } from '@/lib/panel/kontekst'
import { idZamowien, MAX_ZAMOWIEN, wczytajZamowienia } from '@/lib/stanowisko/zamowienia'
import { Baner, Karta, NaglowekStrony, Odznaka, PrzyciskLink, PustyStan, Tabela } from '@/app/ui'
import { Miniatura } from '../../_komponenty/miniatura'
import { PrzypiszKoszyki } from '../koszyki/formularze'
import { DrukujListe } from './drukuj'
import { SkanKolejki } from '../skan-kolejki'

export const metadata = { title: 'Lista zbierania' }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

const ile = (n: number, j: 'szt' | 'g') => (j === 'g' ? `${n} g` : `${n} szt.`)

export default async function ListaZbierania({ searchParams }: Props) {
  const ctx = await requirePermission('pakowanie.stanowisko')
  const sp = await searchParams
  const wszystkieId = idZamowien(sp.z)
  const ids = wszystkieId.slice(0, MAX_ZAMOWIEN)
  const [zamowienia, koszyki] = await Promise.all([wczytajZamowienia(ctx.db, ids), listaKoszykow(ctx.db)])
  const doZebrania = zamowienia.filter((z) => z.pozycje.length > 0)
  const pozycje = listaZbierania(doZebrania)
  const bezKoszyka = doZebrania.filter((z) => !z.koszyk).length
  const wolnych = koszyki.filter((k) => !k.orderId).length
  const sztuk = pozycje.reduce((s, p) => s + (p.jednostka === 'szt' ? p.razem : 0), 0)
  const pakujHref = `/pakowanie?pakuj=${encodeURIComponent(doZebrania.map((z) => z.id).join(','))}`
  return (
    <>
      {/* skan karty zamówienia albo koszyka otwiera okno pakowania nad kolejką */}
      <SkanKolejki kolejka="/pakowanie" />
      <NaglowekStrony
        tytul="Lista zbierania"
        podtytul={doZebrania.length ? `${doZebrania.length} zamówień · ${pozycje.length} produktów · ${sztuk} szt. · po kolei wg półek` : undefined}
        akcje={
          doZebrania.length > 0 && (
            <>
              {koszyki.length > 0 && <PrzypiszKoszyki ids={doZebrania.map((z) => z.id)} ileBez={bezKoszyka} wolnych={wolnych} />}
              <DrukujListe />
              <PrzyciskLink href={pakujHref} prefetch={false}>
                Pakuj te zamówienia
              </PrzyciskLink>
            </>
          )
        }
      />

      {wszystkieId.length > MAX_ZAMOWIEN && <Baner ton="ostrzezenie">Lista mieści najwyżej {MAX_ZAMOWIEN} zamówień naraz — pokazuje pierwsze {MAX_ZAMOWIEN}.</Baner>}
      {koszyki.length === 0 && doZebrania.length > 0 && (
        <Baner ton="info" akcja={<PrzyciskLink href="/pakowanie/koszyki">Dodaj koszyki</PrzyciskLink>}>
          Firma nie ma koszyków. Z koszykami każde zamówienie dostaje swój koszyk (A, B, C…), a stanowisko otwiera je skanem koszyka.
        </Baner>
      )}

      {doZebrania.length === 0 ? (
        <PustyStan tytul="Nie ma czego zbierać" akcja={<PrzyciskLink href="/pakowanie">Wróć do kolejki</PrzyciskLink>}>
          Zaznacz zamówienia w Pakowaniu i kliknij „Lista zbierania”. Zamówienia bez towaru do zebrania (same e-booki, wszystko brakuje) nie trafiają na listę.
        </PustyStan>
      ) : (
        <>
          <Karta tytul="Do zebrania">
            <Tabela
              id="lista-zbierania"
              etykieta="Produkty do zebrania"
              kolumny={[
                { klucz: 'polka', etykieta: 'Półka', szerokosc: '9ch' },
                { klucz: 'zdjecie', etykieta: 'Zdjęcie', szerokosc: '64px' },
                { klucz: 'produkt', etykieta: 'Produkt' },
                { klucz: 'razem', etykieta: 'Razem', wyrownanie: 'prawo' },
                { klucz: 'koszyki', etykieta: 'Do koszyków' },
              ]}
              wiersze={pozycje.map((p) => ({
                id: p.klucz,
                komorki: {
                  polka: p.lokalizacja ? <b className="mono zb-polka">{p.lokalizacja}</b> : <span className="muted">brak</span>,
                  zdjecie: <Miniatura title={p.nazwa} zdjecie={p.zdjecie} size={56} />,
                  produkt: (
                    <>
                      <b>{p.nazwa}</b>
                      {p.sku && <div className="mono small muted">{p.sku}</div>}
                    </>
                  ),
                  razem: <b className="num zb-razem">{ile(p.razem, p.jednostka)}</b>,
                  koszyki: (
                    <ul className="zb-koszyki">
                      {p.doKoszykow.map((d) => (
                        <li key={d.orderId}>
                          {d.koszyk ? (
                            <Odznaka ton="info">Koszyk {d.koszyk}</Odznaka>
                          ) : (
                            <Link href={`/zamowienia/${d.orderId}`} className="mono">
                              {d.numer}
                            </Link>
                          )}{' '}
                          <b>× {p.jednostka === 'g' ? ile(d.ilosc, 'g') : d.ilosc}</b>
                        </li>
                      ))}
                    </ul>
                  ),
                },
              }))}
            />
          </Karta>

          <Karta tytul="Zamówienia na liście" zwijana>
            <ul className="zb-zamowienia">
              {doZebrania.map((z) => (
                <li key={z.id}>
                  <Link href={`/zamowienia/${z.id}`} className="mono">
                    {z.numer}
                  </Link>{' '}
                  {z.koszyk ? <Odznaka ton="info">Koszyk {z.koszyk}</Odznaka> : <span className="muted small">bez koszyka</span>}{' '}
                  <span className="muted small">
                    {z.przewoznik} · {z.pozycje.length} poz.
                  </span>
                </li>
              ))}
            </ul>
          </Karta>
        </>
      )}
    </>
  )
}
