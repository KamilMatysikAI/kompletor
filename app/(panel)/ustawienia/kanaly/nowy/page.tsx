// Ustawienia → Kanały sprzedaży → Dodaj sklep (przebudowa): krok 1 kafle platform (WooCommerce,
// Shoper, PrestaShop, IdoSell, Allegro, Empik), krok 2 tylko pola konieczne (adres i klucze), reszta w „Zaawansowane” z
// wartościami domyślnymi. Po zapisie ekran konta od razu sprawdza połączenie (Allegro: najpierw „Połącz z Allegro”).
// Klucze jako pola hasła: wartość nie wraca do przeglądarki. Stare linki `?rodzaj=<adapter>` działają dalej.
// WooCommerce domyślnie „Połącz z WooCommerce” (adres sklepu i zatwierdzenie w WordPressie, klucze same);
// ręczne klucze w „Mam już klucze REST API”. Bez publicznego adresu panelu (https) przycisk wyszarzony z powodem,
// a klucze widać od razu. Tekst o trybie nowego konta z `OPIS_TRYBU_NOWEGO_KONTA[domyslnyTryb()]`.
import Link from 'next/link'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { domyslnaWartosc, platformaZAdresu, platformy, podzialPol } from '@/lib/kanaly/platformy'
import { requirePermission } from '@/lib/panel/kontekst'
import { domyslnyTryb, OPIS_TRYBU_NOWEGO_KONTA } from '@/lib/kanaly/tryb'
import { adresPaneluWoo } from '@/lib/kanaly/woo-autoryzacja'
import { Baner, Karta, NaglowekStrony, PoleTekstowe, Przycisk, PrzyciskLink, Wybor, Zaawansowane } from '@/app/ui'
import { dodajIPolaczZWoo, dodajSklep } from '../akcje'
import { PoleSekretuWejscie, PoleUstawieniaWejscie } from '../pola'
import '../kanaly.css'

export const metadata = { title: 'Dodaj sklep' }

const registry = defaultRegistry()
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default async function DodajSklep({ searchParams }: Props) {
  await requirePermission('ustawienia')
  const sp = await searchParams
  const lista = platformy(registry)
  const p = platformaZAdresu(registry, { platforma: one(sp.platforma), rodzaj: one(sp.rodzaj) })
  const blad = one(sp.blad)?.slice(0, 300)
  if (!p)
    return (
      <>
        <NaglowekStrony tytul="Dodaj sklep" podtytul="Krok 1 z 2: skąd przychodzą zamówienia?" />
        {blad && <Baner ton="blad">{blad}</Baner>}
        <Karta tytul="Wybierz platformę">
          <ul className="kn-kafle">
            {lista.map((x) => (
              <li key={x.klucz}>
                <Link className="kn-kafel" href={`/ustawienia/kanaly/nowy?platforma=${x.klucz}`}>
                  <span className="kn-znak" aria-hidden="true">
                    {x.znak}
                  </span>
                  <span className="kn-kafel-tekst">
                    <b>{x.nazwa}</b>
                    <span>{x.opis}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Karta>
      </>
    )

  const m = p.wersje.find((w) => w.adapterKey === (one(sp.rodzaj) ?? p.adapterKey)) ?? p.wersje[0]!
  const { podstawowe, zaawansowane, klucze, kluczeZaawansowane } = podzialPol(m, process.env)
  const wersje = p.wersje.length > 1
  const woo = p.channel === 'WOO'
  const panel = woo ? adresPaneluWoo(process.env) : null
  // klucze ręcznie zwinięte tylko, gdy „Połącz z WooCommerce” działa
  const kluczeZwiniete = woo && !!panel?.ok
  const pola = klucze.map((f) => <PoleSekretuWejscie key={f.name} field={f} savedAt={null} />)
  return (
    <>
      <NaglowekStrony tytul={`Dodaj sklep: ${p.nazwa}`} podtytul="Krok 2 z 2: adres i klucze. Resztę Kompletor ustawi sam." />
      {blad && <Baner ton="blad">{blad}</Baner>}
      <Karta>
        <form action={dodajSklep} aria-label={`Nowe konto: ${p.nazwa}`} autoComplete="off">
          {!wersje && <input type="hidden" name="rodzaj" value={m.adapterKey} />}
          <p className="kn-skad">
            {woo
              ? 'Wpisz adres sklepu i kliknij „Połącz z WooCommerce”: zalogujesz się w panelu WordPressa jako administrator i klikniesz „Zatwierdź”. Klucze zapiszą się same.'
              : p.skadKlucze}{' '}
            <Link href={p.pomoc}>Pomoc: {p.nazwa}</Link>
          </p>
          <div className="kn-pola">
            <PoleTekstowe id="k-nazwa" name="nazwa" etykieta="Nazwa w panelu" maxLength={80} required defaultValue={p.nazwa} pomoc="Np. nazwa sklepu. Widzi ją tylko Twój zespół." />
            {podstawowe.map((f) => (
              <PoleUstawieniaWejscie key={f.key} field={f} value="" />
            ))}
            {!kluczeZwiniete && pola}
          </div>
          {kluczeZwiniete && (
            <Zaawansowane tytul="Mam już klucze REST API (wklejam ręcznie)">
              <p className="muted small">{p.skadKlucze}</p>
              <div className="kn-pola">{pola}</div>
              <p className="muted small">Po wklejeniu kliknij niżej „Zapisz z kluczami i sprawdź połączenie”.</p>
            </Zaawansowane>
          )}
          {(zaawansowane.length > 0 || kluczeZaawansowane.length > 0 || wersje) && (
            <Zaawansowane>
              <p className="muted small">Wartości domyślne pasują do większości sklepów. Zmieniasz je tylko, gdy wiesz, że Twój sklep działa inaczej; wszystko poprawisz też później na ekranie konta.</p>
              <div className="kn-pola">
                {wersje && (
                  <Wybor
                    id="k-rodzaj"
                    name="rodzaj"
                    etykieta="Wersja połączenia"
                    defaultValue={m.adapterKey}
                    pomoc="Wersja z zapisem czyta tak samo, a do sklepu nie wysyła nic, dopóki sam nie włączysz zapisu i trybu pracy."
                    opcje={p.wersje.map((w) => ({ wartosc: w.adapterKey, etykieta: w.readOnly ? 'Tylko odczyt' : 'Odczyt i zapis (zapis wyłączony na start)' }))}
                  />
                )}
                {zaawansowane.map((f) => (
                  <PoleUstawieniaWejscie key={f.key} field={f} value={domyslnaWartosc(m, f.key, process.env)} />
                ))}
                {kluczeZaawansowane.map((f) => (
                  <PoleSekretuWejscie key={f.name} field={f} savedAt={null} />
                ))}
              </div>
            </Zaawansowane>
          )}
          <p className="muted small">{OPIS_TRYBU_NOWEGO_KONTA[domyslnyTryb()]}</p>
          {woo && panel && !panel.ok && <p className="muted small">{panel.powod}</p>}
          <div className="kn-akcje">
            {woo ? (
              <>
                <Przycisk wariant="glowny" type="submit" formAction={dodajIPolaczZWoo} powodWylaczenia={panel?.ok ? undefined : 'Panel nie ma publicznego adresu https: wklej klucze ręcznie'}>
                  Połącz z WooCommerce
                </Przycisk>
                <Przycisk type="submit">Zapisz z kluczami i sprawdź połączenie</Przycisk>
              </>
            ) : (
              <Przycisk wariant="glowny" type="submit">
                {p.channel === 'ALLEGRO' ? 'Zapisz i połącz z Allegro' : 'Zapisz i sprawdź połączenie'}
              </Przycisk>
            )}
            <PrzyciskLink wariant="cichy" href="/ustawienia/kanaly/nowy">
              Inna platforma
            </PrzyciskLink>
          </div>
        </form>
      </Karta>
    </>
  )
}
