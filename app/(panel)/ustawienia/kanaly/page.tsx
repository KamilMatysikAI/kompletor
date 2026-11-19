// Ustawienia → Kanały sprzedaży: konta kanałów firmy (sklepy, Allegro, Empik), stan połączenia, ostatni
// odczyt, liczba ofert i tryb. Tryb przełącza się na ekranie konta (z warunkami i potwierdzeniem).
// Tylko z uprawnieniem `ustawienia` (inni dostają 404).
import Link from 'next/link'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { listaKont } from '@/lib/kanaly/dane'
import { kluczKanalu, wylaczoneKonta } from '@/lib/integracje/zdrowie'
import { trybKonta } from '@/lib/kanaly/tryb'
import { int, when } from '@/lib/panel/format'
import { requirePermission } from '@/lib/panel/kontekst'
import { Karta, NaglowekStrony, Odznaka, PrzyciskLink, PustyStan, TrybKanalu } from '@/app/ui'
import './kanaly.css'

export const metadata = { title: 'Kanały sprzedaży' }

const registry = defaultRegistry()

export default async function KanalySprzedazy() {
  const ctx = await requirePermission('ustawienia')
  const [konta, wylaczone] = await Promise.all([listaKont(ctx.db, registry), wylaczoneKonta(ctx.db)])
  const now = new Date()
  return (
    <>
      <NaglowekStrony
        tytul="Kanały sprzedaży"
        podtytul="Sklepy i platformy, z których przychodzą zamówienia."
        akcje={
          <PrzyciskLink wariant="glowny" href="/ustawienia/kanaly/nowy">
            Dodaj sklep
          </PrzyciskLink>
        }
      />

      <Karta tytul="Konta" akcje={<Link href="/pomoc/integracje">Skąd wziąć klucz</Link>}>
        {konta.length === 0 ? (
          <PustyStan tytul="Nie ma jeszcze żadnego sklepu" akcja={<PrzyciskLink wariant="glowny" href="/ustawienia/kanaly/nowy">Dodaj sklep</PrzyciskLink>}>
            Podłącz WooCommerce, Shoper, PrestaShop, IdoSell, Allegro albo Empik: wystarczy adres i klucz.
          </PustyStan>
        ) : (
          <table className="tbl cards">
            <thead>
              <tr>
                <th scope="col">Nazwa</th>
                <th scope="col">Rodzaj</th>
                <th scope="col">Połączenie</th>
                <th scope="col">Ostatni odczyt</th>
                <th scope="col" className="right">
                  Oferty
                </th>
                <th scope="col">Tryb</th>
              </tr>
            </thead>
            <tbody>
              {konta.map((k) => (
                <tr key={k.kod} className={k.testOk === false ? 'row-alert' : k.toAssign > 0 ? 'row-warn' : undefined}>
                  <td data-label="Nazwa">
                    <Link className="ord" href={`/ustawienia/kanaly/${encodeURIComponent(k.kod)}`}>
                      {k.name}
                    </Link>
                    {!k.active && (
                      <>
                        {' '}
                        <Odznaka rozmiar="sm">wyłączone</Odznaka>
                      </>
                    )}
                    {/* wyłączone automatycznie po serii błędów; „Włącz ponownie” na ekranie konta */}
                    {wylaczone.has(kluczKanalu(k.channel, k.channelAccountId)) && (
                      <>
                        {' '}
                        <Odznaka ton="blad" rozmiar="sm" title="Kompletor przestał wołać to konto po serii błędów połączenia. Otwórz konto i kliknij „Włącz ponownie”.">
                          wyłączone po błędach
                        </Odznaka>
                      </>
                    )}
                    <span className="sub mono">{k.channelAccountId}</span>
                  </td>
                  <td data-label="Rodzaj">{k.rodzaj}</td>
                  <td data-label="Połączenie">
                    {k.testOk === null ? (
                      <span className="muted">nie sprawdzano</span>
                    ) : k.testOk ? (
                      <Odznaka ton="sukces" rozmiar="sm">działa</Odznaka>
                    ) : (
                      <Odznaka ton="blad" rozmiar="sm">błąd</Odznaka>
                    )}
                    {k.testCheckedAt && <span className="sub">{when(k.testCheckedAt, now)}</span>}
                  </td>
                  <td data-label="Ostatni odczyt">
                    {k.lastReadAt ? when(k.lastReadAt, now) : <span className="muted">jeszcze nie</span>}
                    {k.readError && <span className="sub">{k.readError}</span>}
                  </td>
                  <td data-label="Oferty" className="right">
                    {int(k.offers)}
                    {k.toAssign > 0 && <span className="sub">do przypisania: {int(k.toAssign)}</span>}
                  </td>
                  <td data-label="Tryb">
                    {/* tryb z trzech pól naraz (konto ustawione poza panelem może być mieszane); „Aktywny bez stanów” i „Mieszany” z tej samej odznaki */}
                    <TrybKanalu tryb={trybKonta(k)} aktywne={k.active} rozmiar="sm" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">Tylko podgląd: Kompletor czyta kanał i liczy rezerwacje, ale niczego w nim nie zmienia. Tryb zmieniasz na ekranie konta.</p>
      </Karta>
    </>
  )
}
