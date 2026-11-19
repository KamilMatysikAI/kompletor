// Produkty → przycisk „Zdjęcia z feedu”: adresy feedu produktowego sklepu (Google Merchant XML), przycisk
// „Pobierz zdjęcia z feedu” i wynik ostatniego przebiegu. Automat działa sam raz na dobę nocą. Tylko z uprawnieniem
// `produkty.dodawanie` (inni dostają 404). Do sklepu nic nie zapisujemy.
import Link from 'next/link'
import { Baner, Karta, ListaOpisowa, PoleTekstowe, Przycisk, ToastZAdresuZapisu, Wybor } from '@/app/ui'
import { int, when } from '@/lib/panel/format'
import { requirePermission } from '@/lib/panel/kontekst'
import { FEED_JOB, FEED_MAX_ADRESOW, FEED_NOC_DO, FEED_NOC_OD, feedyFirmy, ostatniPrzebiegFeedu } from '@/lib/produkty/zdjecia-feed'
import { ZDJECIA_LIMIT_NA_PRZEBIEG } from '@/lib/produkty/zdjecia'
import { pobierzTeraz, zapiszAdresy } from './akcje'
import { kontaSklepow } from './konta'

export const metadata = { title: 'Zdjęcia z feedu' }
export const dynamic = 'force-dynamic'

const KOMUNIKATY = {
  adresy: 'Zapisano adresy feedu. Zdjęcia pobierzesz przyciskiem „Pobierz zdjęcia z feedu” albo zrobi to automat w nocy.',
  pusto: 'Zapisano: firma nie ma feedu, automat nic nie pobiera.',
  zlecone: 'Przebieg zlecony. Wynik pojawi się tutaj za chwilę (odśwież stronę).',
  czeka: 'Przebieg już czeka w kolejce. Odśwież stronę za chwilę.',
}

const STATUS: Record<string, { tekst: string; ton: 'sukces' | 'ostrzezenie' | 'blad' | 'info' }> = {
  OK: { tekst: 'zakończony', ton: 'sukces' },
  PARTIAL: { tekst: 'zakończony z błędami części feedów', ton: 'ostrzezenie' },
  FAILED: { tekst: 'nieudany', ton: 'blad' },
  RUNNING: { tekst: 'w toku', ton: 'info' },
}

export default async function ZdjeciaZFeedu() {
  const ctx = await requirePermission('produkty.dodawanie')
  const [feedy, konta, ostatni, czeka] = await Promise.all([
    feedyFirmy(ctx.db),
    kontaSklepow(ctx.db),
    ostatniPrzebiegFeedu(ctx.db),
    // przycisk nieaktywny, gdy przebieg z przycisku czeka albo trwa, i gdy właśnie trwa przebieg nocny
    ctx.db.job.count({
      where: {
        kind: FEED_JOB,
        OR: [
          { status: { in: ['PENDING', 'RUNNING'] }, dedupeKey: { startsWith: 'panel:' } },
          { status: 'RUNNING', dedupeKey: { startsWith: 'harmonogram:' } },
        ],
      },
    }),
  ])
  const wiersze = Math.min(FEED_MAX_ADRESOW, feedy.length + 1)
  const opcjeKont = [{ wartosc: '', etykieta: 'nie wiem / inny sklep' }, ...konta.map((k) => ({ wartosc: k.kod, etykieta: k.nazwa }))]
  const w = ostatni?.wynik
  const st = ostatni ? (STATUS[ostatni.status] ?? STATUS.RUNNING!) : null
  return (
    <>
      <ToastZAdresuZapisu komunikaty={KOMUNIKATY} />
      <header className="page-head">
        <div>
          <h1>Zdjęcia z feedu</h1>
          <div className="sub">
            Produkty bez zdjęcia dostają zdjęcia z feedu produktowego sklepu (plik XML dla Google Merchant). Produkt, który ma już choć jedno zdjęcie, zostaje bez zmian. Do sklepu nic nie zapisujemy.
          </div>
        </div>
        <div className="np-head-actions">
          <Link className="btn" href="/produkty">
            Wróć do produktów
          </Link>
        </div>
      </header>

      <Karta tytul="Adres feedu" opis="Adres pliku XML, który sklep udostępnia Google (np. z wtyczki Product Feed PRO w WooCommerce). Możesz podać kilka, po jednym na sklep.">
        <form action={zapiszAdresy} aria-label="Adresy feedu produktowego">
          {Array.from({ length: wiersze }, (_, i) => (
            <div className="grid g2" key={i} style={{ marginBottom: 16 }}>
              <PoleTekstowe
                id={`feed-url-${i}`}
                name={`url-${i}`}
                etykieta={wiersze > 1 ? `Adres feedu ${i + 1}` : 'Adres feedu'}
                defaultValue={feedy[i]?.url ?? ''}
                placeholder="https://twojsklep.pl/…/feed.xml"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                opcjonalne
              />
              <Wybor
                id={`feed-konto-${i}`}
                name={`konto-${i}`}
                etykieta="Sklep, z którego jest feed"
                pomoc="Pozwala połączyć pozycję feedu z ofertą tego sklepu, gdy SKU i EAN nie pasują."
                defaultValue={feedy[i]?.konto ?? ''}
                opcje={opcjeKont}
                opcjonalne
              />
            </div>
          ))}
          <div className="np-actions">
            <Przycisk type="submit" wariant="glowny">
              Zapisz adresy
            </Przycisk>
            <span className="muted small">
              Puste pole usuwa adres. Najwyżej {FEED_MAX_ADRESOW} feedów{wiersze < FEED_MAX_ADRESOW ? '; pole na kolejny adres pojawi się po zapisie' : ''}.
            </span>
          </div>
        </form>
      </Karta>

      <Karta
        tytul="Pobieranie zdjęć"
        opis={`Automat sprawdza feed raz na dobę w nocy (między ${FEED_NOC_OD}:00 a ${FEED_NOC_DO}:00). Jeden przebieg zleca najwyżej ${ZDJECIA_LIMIT_NA_PRZEBIEG} produktów, kolejne przy następnym; zdjęcia dochodzą w tle przez kilkanaście minut.`}
        akcje={
          <form action={pobierzTeraz}>
            <Przycisk type="submit" wariant="glowny" powodWylaczenia={!feedy.length ? 'najpierw zapisz adres feedu' : czeka ? 'przebieg już czeka w kolejce albo trwa' : undefined}>
              Pobierz zdjęcia z feedu
            </Przycisk>
          </form>
        }
      >
        {!ostatni ? (
          <p className="muted small" style={{ margin: 0 }}>
            {feedy.length ? 'Jeszcze nie było przebiegu.' : 'Wpisz adres feedu powyżej. Firma bez feedu działa jak dotąd: zdjęcia dodajesz na karcie produktu albo przychodzą z ofert sklepu.'}
          </p>
        ) : (
          <>
            <Baner ton={st!.ton} tytul={`Ostatni przebieg ${st!.tekst}:`} rola="status">
              {when(ostatni.startedAt)}
              {w?.zrodlo === 'noc' ? ' (automat nocny)' : w?.zrodlo === 'panel' ? ' (z przycisku)' : ''}
              {ostatni.error ? `. ${ostatni.error}` : ''}
            </Baner>
            {w && (
              <ListaOpisowa
                kolumny={2}
                pozycje={[
                  { etykieta: 'Pozycje w feedzie', wartosc: int(w.feedy.reduce((a, f) => a + f.pozycje, 0)) },
                  { etykieta: 'Sparowane z produktem', wartosc: int(w.feedy.reduce((a, f) => a + f.sparowane, 0)) },
                  { etykieta: 'Produkty, które mają już zdjęcie', wartosc: int(w.feedy.reduce((a, f) => a + f.maZdjecie, 0)) },
                  { etykieta: 'Zdjęcia zlecone do pobrania', wartosc: w.pominiete ? `${int(w.zlecone)} (kolejne ${int(w.pominiete)} przy następnym przebiegu)` : int(w.zlecone) },
                  ...(w.wKolejce ? [{ etykieta: 'Już czekały w kolejce', wartosc: int(w.wKolejce) }] : []),
                  ...(w.odlozone ? [{ etykieta: 'Odłożone (pobranie nie udało się w ostatnich 7 dniach)', wartosc: int(w.odlozone) }] : []),
                  { etykieta: 'Bez dopasowania', wartosc: int(w.feedy.reduce((a, f) => a + f.bezDopasowania, 0)) },
                  { etykieta: 'Niejednoznaczne (pominięte)', wartosc: int(w.feedy.reduce((a, f) => a + f.niejednoznaczne, 0)) },
                ]}
              />
            )}
            {w && w.feedy.length > 1 && (
              <ul className="plain small">
                {w.feedy.map((f, i) => (
                  <li key={i}>
                    <span className="mono">{f.adres}</span>: {f.blad ? <b>{f.blad}</b> : `${int(f.pozycje)} pozycji, sparowane ${int(f.sparowane)}`}
                  </li>
                ))}
              </ul>
            )}
            {w && w.feedy.length === 1 && w.feedy[0]!.blad && ostatni.status !== 'FAILED' && <p className="small">{w.feedy[0]!.blad}</p>}
            {w && w.lista.length > 0 && (
              <p className="small" style={{ marginTop: 16, marginBottom: 0 }}>
                <a className="btn" href={`/api/produkty/feed-bez-dopasowania?przebieg=${encodeURIComponent(ostatni.id)}`} download>
                  Pobierz listę bez dopasowania (CSV)
                </a>{' '}
                <span className="muted">Pozycje feedu, których SKU (MPN), EAN ani identyfikator oferty nie pasują do żadnego produktu albo pasują do kilku.</span>
              </p>
            )}
          </>
        )}
      </Karta>
    </>
  )
}
