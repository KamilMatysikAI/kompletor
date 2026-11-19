// Braki towaru → lista „Brakuje”: wyszukiwarka i filtry (PasekFiltrow), widok po produkcie
// (domyślnie: suma braków i liczba zamówień, decyzja dla całej grupy) albo po zamówieniu (decyzja w wierszu),
// sortowanie i strony (Tabela z app/ui), akcja masowa „Decyzja dla zaznaczonych”. Domyślnie bez zamówień zamkniętych.
import Link from 'next/link'
import { Baner, PasekFiltrow, PustyStan, Przycisk, Tabela, ZaznaczoneUkryte } from '@/app/ui'
import { DECYZJE_MASOWE, grupujPoProdukcie, liczbaBrakow, LIMIT_LISTY, pozycjeBrakow, sortujGrupy, sortujPozycje, ukrytePrzyZamknietych, type WidokBrakow } from '@/lib/panel/braki'
import { accountName, type accounts } from '@/lib/panel/dane'
import { channelPrefix, qty, shortExternalId, STATUS_LABEL, when } from '@/lib/panel/format'
import { adresZ, sortZ, stronaZ } from '@/lib/panel/tabela'
import { ETYKIETA_DECYZJI } from '@/lib/stanowisko/decyzje'
import { zdecydujWWierszu, zdecydujZaznaczone } from './akcje'
import { Miniatura } from '../_komponenty/miniatura'

type Parametry = Record<string, string | string[] | undefined>
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

function WyborDecyzji({ id, domyslna }: { id: string; domyslna?: string }) {
  return (
    <select className="input" name="akcja" id={id} defaultValue={domyslna ?? ''} aria-label="Decyzja">
      <option value="" disabled>
        Wybierz decyzję…
      </option>
      {DECYZJE_MASOWE.map((a) => (
        <option key={a} value={a}>
          {ETYKIETA_DECYZJI[a]}
        </option>
      ))}
    </select>
  )
}

export async function ListaBrakuje({ db, sp, accs, canDecide }: { db: Parameters<typeof pozycjeBrakow>[0]; sp: Parametry; accs: Awaited<ReturnType<typeof accounts>>; canDecide: boolean }) {
  const widok: WidokBrakow = one(sp.widok) === 'zamowienia' ? 'zamowienia' : 'produkty'
  const q = one(sp.q)?.slice(0, 100)
  const zamkniete = one(sp.zamkniete) === 'tak'
  const [poz, ukryte] = await Promise.all([pozycjeBrakow(db, { q, zamkniete }), zamkniete ? Promise.resolve(0) : ukrytePrzyZamknietych(db, { q })])
  // przy liście ponad limit mówimy, ile jest wszystkich (licznik z bazy, nie z pobranych wierszy)
  const wszystkich = poz.length >= LIMIT_LISTY ? await liczbaBrakow(db, { q, zamkniete }) : poz.length
  const { strona, ile, pomin } = stronaZ(sp, 50)
  const now = new Date()
  const parametry = { ...sp, lista: 'brakuje' }
  const powrot = adresZ('/braki', parametry, { wynik: undefined, blad: undefined })
  const wynik = one(sp.wynik)?.slice(0, 400)
  const blad = one(sp.blad)?.slice(0, 400)
  const numer = (o: (typeof poz)[number]['order']) => `${channelPrefix(o.channel, accountName(accs, o.channel, o.channelAccountId))} ${shortExternalId(o.externalId)}`

  const filtry = (
    <PasekFiltrow
      akcja="/braki"
      szukaj={{ nazwa: 'q', wartosc: q, etykieta: 'Szukaj braków', podpowiedz: 'Produkt, SKU albo numer zamówienia' }}
      aktywne={(widok !== 'produkty' ? 1 : 0) + (zamkniete ? 1 : 0)}
      wyczysc="/braki"
      zachowaj={{ lista: 'brakuje' }}
    >
      <div className="field">
        <label htmlFor="braki-widok">Widok</label>
        <select className="input" id="braki-widok" name="widok" defaultValue={widok}>
          <option value="produkty">po produkcie</option>
          <option value="zamowienia">po zamówieniu</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="braki-zamkniete">Zamówienia</label>
        <select className="input" id="braki-zamkniete" name="zamkniete" defaultValue={zamkniete ? 'tak' : ''}>
          <option value="">tylko otwarte</option>
          <option value="tak">także wysłane i anulowane</option>
        </select>
      </div>
    </PasekFiltrow>
  )
  const komunikaty = (
    <>
      {ukryte > 0 && (
        <Baner ton="info" rola="note">
          Ukryte: {ukryte} {ukryte === 1 ? 'brak' : 'braki'} przy zamówieniach wysłanych albo anulowanych.{' '}
          <Link href={adresZ('/braki', parametry, { zamkniete: 'tak', strona: undefined, wynik: undefined, blad: undefined })}>Pokaż także te</Link>
        </Baner>
      )}
      {wszystkich > poz.length && (
        <Baner ton="ostrzezenie" rola="note">
          Braków jest {wszystkich}; lista pokazuje najstarsze {poz.length}. Zawęź wyszukiwaniem albo zdecyduj o widocznych, a reszta pojawi się na ich miejscu.
        </Baner>
      )}
      {wynik && (
        <Baner ton="sukces" rola="status">
          {wynik}
        </Baner>
      )}
      {blad && (
        <Baner ton="blad" rola="alert">
          {blad}
        </Baner>
      )}
    </>
  )
  const masowo = canDecide ? (
    <form action={zdecydujZaznaczone} className="ui-akcja-masowa">
      <ZaznaczoneUkryte />
      <input type="hidden" name="widok" value={widok} />
      <input type="hidden" name="powrot" value={powrot} />
      {q && <input type="hidden" name="q" value={q} />}
      {zamkniete && <input type="hidden" name="zamkniete" value="tak" />}
      <WyborDecyzji id="braki-decyzja-masowa" />
      <Przycisk type="submit" wariant="glowny" rozmiar="sm">
        {widok === 'produkty' ? 'Zapisz dla wszystkich zamówień z zaznaczonymi produktami' : 'Zapisz dla zaznaczonych'}
      </Przycisk>
    </form>
  ) : undefined
  const pusty = (
    <PustyStan tytul={q ? 'Nic nie pasuje do wyszukiwania' : 'Nic nie brakuje'} akcja={q ? <Link href="/braki">Wyczyść wyszukiwanie</Link> : undefined}>
      {q ? 'Zmień wyszukiwanie albo filtry.' : 'Każda pozycja otwartych zamówień ma rezerwację.'}
    </PustyStan>
  )

  if (widok === 'produkty') {
    const sort = sortZ(sp, ['produkt', 'brakuje', 'zamowien', 'od'], { klucz: 'zamowien', kierunek: 'malejaco' })
    const grupy = sortujGrupy(grupujPoProdukcie(poz), sort)
    return (
      <>
        {filtry}
        {komunikaty}
        <Tabela
          id="braki-produkty"
          etykieta="Braki po produkcie"
          kolumny={[
            { klucz: 'produkt', etykieta: 'Produkt', sortowalna: true },
            { klucz: 'brakuje', etykieta: 'Brakuje razem', wyrownanie: 'prawo', sortowalna: true },
            { klucz: 'zamowien', etykieta: 'Zamówień', wyrownanie: 'prawo', sortowalna: true },
            { klucz: 'decyzje', etykieta: 'Decyzje' },
            { klucz: 'od', etykieta: 'Najstarszy', sortowalna: true, ukrywalna: true },
          ]}
          wiersze={grupy.slice(pomin, pomin + ile).map((g) => ({
            id: g.productId,
            etykieta: g.title,
            href: `/braki?${new URLSearchParams({ lista: 'brakuje', widok: 'zamowienia', q: g.sku || g.title, ...(zamkniete ? { zamkniete: 'tak' } : {}) })}`,
            ton: 'blad' as const,
            komorki: {
              produkt: (
                <span className="pline">
                  <Miniatura title={g.title} />
                  <span>
                    {g.title} <span className="mono small muted">{g.sku}</span>
                  </span>
                </span>
              ),
              brakuje: <span className="num">{qty(g.qty, g.unit as 'SZT')}</span>,
              zamowien: <span className="num">{g.zamowien}</span>,
              decyzje: (
                <span className="small">
                  {Object.entries(g.decyzje)
                    .map(([k, n]) => `${k === 'BRAK' ? 'bez decyzji' : ETYKIETA_DECYZJI[k as keyof typeof ETYKIETA_DECYZJI]}: ${n}`)
                    .join(', ')}
                </span>
              ),
              od: when(g.najstarszy, now),
            },
          }))}
          adres={{ sciezka: '/braki', parametry }}
          sort={sort}
          zaznaczanie={canDecide}
          akcjeMasowe={masowo}
          paginacja={{ strona, ile, razem: grupy.length }}
          pustyStan={pusty}
        />
      </>
    )
  }

  const sort = sortZ(sp, ['zamowienie', 'produkt', 'brakuje', 'od'], { klucz: 'od', kierunek: 'rosnaco' })
  const lista = sortujPozycje(poz, sort)
  return (
    <>
      {filtry}
      {komunikaty}
      <Tabela
        id="braki-pozycje"
        etykieta="Braki po zamówieniu"
        kolumny={[
          { klucz: 'zamowienie', etykieta: 'Zamówienie', sortowalna: true },
          { klucz: 'produkt', etykieta: 'Produkt', sortowalna: true },
          { klucz: 'brakuje', etykieta: 'Brakuje', wyrownanie: 'prawo', sortowalna: true },
          { klucz: 'decyzja', etykieta: 'Decyzja' },
          { klucz: 'od', etykieta: 'Od', sortowalna: true, ukrywalna: true },
        ]}
        wiersze={lista.slice(pomin, pomin + ile).map((s) => ({
          id: s.orderLineId,
          etykieta: `${numer(s.order)}: ${s.title}`,
          href: `/zamowienia/${s.order.id}`,
          ton: s.state === 'OPEN' ? ('blad' as const) : ('ostrzezenie' as const),
          komorki: {
            zamowienie: (
              <>
                <Link className="ord" href={`/zamowienia/${s.order.id}`}>
                  {numer(s.order)}
                </Link>
                <span className="sub">{STATUS_LABEL[s.order.status]}</span>
              </>
            ),
            produkt: (
              <span>
                {s.title} <span className="mono small muted">{s.sku}</span>
              </span>
            ),
            brakuje: <span className="num">{qty(s.qtyBase, s.unit as 'SZT')}</span>,
            decyzja: canDecide ? (
              <form action={zdecydujWWierszu} className="braki-decyzja">
                <input type="hidden" name="pozycja" value={s.orderLineId} />
                <input type="hidden" name="powrot" value={powrot} />
                <WyborDecyzji id={`decyzja-${s.orderLineId}`} domyslna={s.decyzja && DECYZJE_MASOWE.includes(s.decyzja.action) ? s.decyzja.action : undefined} />
                <Przycisk type="submit" rozmiar="sm">
                  Zapisz
                </Przycisk>
                {!s.decyzja && <span className="muted small">domyślnie: wyślij resztę</span>}
              </form>
            ) : (
              <span>{s.decyzja ? ETYKIETA_DECYZJI[s.decyzja.action] : 'domyślnie: wyślij resztę'}</span>
            ),
            od: when(s.createdAt, now),
          },
        }))}
        adres={{ sciezka: '/braki', parametry }}
        sort={sort}
        zaznaczanie={canDecide}
        akcjeMasowe={masowo}
        paginacja={{ strona, ile, razem: lista.length }}
        pustyStan={pusty}
      />
    </>
  )
}
