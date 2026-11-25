// Sekcja „Płatność” karty zamówienia (jedyne miejsce płatności na karcie): stan, sposób
// płatności słowami, „Zapłacono X z Y” jak w BL, różnica („Do dopłaty” albo „Do zwrotu”), termin zwolnienia towaru,
// przypomnienie, wpisy płatności i akcje (tylko konto w PRACA). Tylko zapis w Kompletorze: bez banku i linków płatności.
// akcje płatności są zawsze widoczne, gdy pasują do stanu zamówienia; konto poza trybem PRACA albo osoba bez
// uprawnienia widzi je nieaktywne z jednym powodem pod grupą (bramki serwera w akcje-platnosc.ts bez zmian).
// nagłówek sekcji w pasku (app/ui/sekcja.tsx); sposób płatności słowem jest w karcie „Szczegóły zamówienia”.
// Zmiana płatności (lib/karta/pobranie.ts): „Zmień na pobranie” albo „Zmień na nieopłacone”, zawsze widoczna, nieaktywna
// z powodem, gdy nie pasuje do zamówienia. Pobranie bez zapisanej wpłaty to „Do zapłaty przy odbiorze”, nie „Zapłacono”.
import { Odznaka, PoleTekstowe, Przycisk, Sekcja, Wybor, StanPlatnosci } from '@/app/ui'
import type { DaneKarty } from '@/lib/karta/dane'
import { METODY_PLATNOSCI, RODZAJ_LABEL } from '@/lib/karta/platnosci'
import { jednostkaWaluty, money, when } from '@/lib/panel/format'
import { toWarsaw } from '@/lib/rdzen/kalendarz'
import { oznaczOplaconeKarta, zapiszDoplateKarta, zmienPlatnoscKarta, zwrotRoznicyKarta } from './akcje-platnosc'

const ZMIANA = {
  NA_POBRANIE: {
    etykieta: 'Zmień na pobranie',
    potwierdz: 'Zmienić płatność na pobranie? Kurier pobierze od klienta kwotę zamówienia, zamówienie przejdzie do realizacji, a przypomnienie o płatności i termin anulowania znikną. W sklepie płatność zostaje bez zmian.',
    przycisk: 'Tak, zmień na pobranie',
  },
  NA_NIEOPLACONE: {
    etykieta: 'Zmień na nieopłacone (przelew)',
    potwierdz: 'Zmienić pobranie na nieopłacone? Zamówienie wróci do „Nowe” i poczeka na wpłatę; przypomnienie o płatności i termin anulowania liczą się od teraz. W sklepie płatność zostaje bez zmian.',
    przycisk: 'Tak, zmień na nieopłacone',
  },
} as const

/** Zmiana płatności z potwierdzeniem (rozwijane jak formularz wpłaty). */
function ZmianaPlatnosci({ orderId, kierunek }: { orderId: string; kierunek: keyof typeof ZMIANA }) {
  const t = ZMIANA[kierunek]
  return (
    <details className="kz-dodaj">
      <summary className="btn">{t.etykieta}</summary>
      <form action={zmienPlatnoscKarta} className="kz-zmien-pola">
        <input type="hidden" name="zamowienie" value={orderId} />
        <input type="hidden" name="kierunek" value={kierunek} />
        <p className="small kz-bez-marginesu">{t.potwierdz}</p>
        <div>
          <Przycisk type="submit" wariant="glowny">
            {t.przycisk}
          </Przycisk>
        </div>
      </form>
    </details>
  )
}

function FormularzWplaty({ orderId, akcja, etykieta, kwota, potwierdz, klucz, waluta }: { orderId: string; akcja: (f: FormData) => Promise<void>; etykieta: string; kwota: number; potwierdz?: string; klucz: string; waluta?: string }) {
  const dzis = toWarsaw(new Date()).day
  return (
    <details className="kz-dodaj">
      <summary className="btn">{etykieta}</summary>
      <form action={akcja} className="kz-zmien-pola">
        <input type="hidden" name="zamowienie" value={orderId} />
        <PoleTekstowe id={`${klucz}-kwota`} etykieta={`Kwota (${jednostkaWaluty(waluta)})`} name="kwota" inputMode="decimal" required defaultValue={kwota > 0 ? (kwota / 100).toFixed(2).replace('.', ',') : ''} pattern="[0-9]+([,.][0-9]{1,2})?" />
        <PoleTekstowe id={`${klucz}-data`} etykieta="Data" name="data" type="date" defaultValue={dzis} max={dzis} />
        <Wybor id={`${klucz}-metoda`} etykieta="Metoda" name="metoda" defaultValue="przelew" opcje={METODY_PLATNOSCI.map((m) => ({ wartosc: m, etykieta: m }))} />
        {potwierdz && <p className="small kz-bez-marginesu">{potwierdz}</p>}
        <div>
          <Przycisk type="submit" wariant="glowny">
            {potwierdz ? `Tak, ${etykieta.toLowerCase()}` : 'Zapisz'}
          </Przycisk>
        </div>
      </form>
    </details>
  )
}

const BEZ_OPLACONE = 'Nie masz uprawnienia „Ręczne «Oznacz jako opłacone»” (Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia).'
const BEZ_ZWROTOW = 'Nie masz uprawnienia „Zwroty pieniędzy” (Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia).'

/** Nieaktywny przycisk akcji płatności (konto w podglądzie albo brak uprawnienia); powód pod grupą, w tytule i dla czytnika. */
function Nieaktywny({ etykieta, powod }: { etykieta: string; powod: string }) {
  return (
    <Przycisk powodWylaczenia={powod} aria-describedby="plat-powod">
      {etykieta}
    </Przycisk>
  )
}

const tryb0 = (d: DaneKarty): string | null => (d.praca ? null : (d.podglad?.powody.platnosc ?? d.cien ?? 'Konto sklepu jest w trybie „Tylko podgląd”.'))

export function Platnosc({ d, uprawnienia }: { d: DaneKarty; uprawnienia: ReadonlySet<string> }) {
  const { o, platnosc: p } = d
  const now = new Date()
  const nieoplacone = o.paymentState === 'UNPAID' || o.paymentState === 'PARTIAL'
  const oplacone = p.zaplaconoGr >= p.zamowienieGr && p.zamowienieGr > 0
  // które akcje pasują do stanu zamówienia (bez trybu i uprawnień)
  const naOplacone = nieoplacone && o.status !== 'ANULOWANE'
  const naDoplate = o.paymentState !== 'COD'
  const naZwrot = p.roznicaGr < 0
  const powodZmiany = tryb0(d) ?? (uprawnienia.has('zamowienia.oznacz_oplacone') ? null : BEZ_OPLACONE) ?? p.zmiana.powod
  const etykietaZmiany = ZMIANA[p.zmiana.kierunek].etykieta
  const doOdbioru = p.pobranie && p.zaplaconoGr === 0
  // powód nieaktywności (null = działa): tryb konta ma pierwszeństwo przed uprawnieniem
  const tryb = tryb0(d)
  const powodWplaty = tryb ?? (uprawnienia.has('zamowienia.oznacz_oplacone') ? null : BEZ_OPLACONE)
  const powodZwrotu = tryb ?? (uprawnienia.has('zwroty.pieniadze') ? null : BEZ_ZWROTOW)
  const powody = [...new Set([naOplacone || naDoplate ? powodWplaty : null, naZwrot ? powodZwrotu : null, powodZmiany].filter((x): x is string => !!x))]
  return (
    <Sekcja id="platnosc" tytul="Płatność" akcje={<StanPlatnosci stan={o.paymentState} />}>
      <dl className="dl">
        {doOdbioru ? (
          <>
            <dt>Do zapłaty przy odbiorze</dt>
            <dd className="num">{money(p.zamowienieGr / 100, d.waluta)}</dd>
          </>
        ) : (
          <>
            <dt>Zapłacono</dt>
            <dd className="num">
              <Odznaka ton={oplacone ? 'sukces' : 'neutralny'}>{money(p.zaplaconoGr / 100, d.waluta)}</Odznaka> z {money(p.zamowienieGr / 100, d.waluta)}
            </dd>
          </>
        )}
        {p.pokaz && (
          <>
            <dt>Różnica</dt>
            <dd className="num">
              {p.roznicaGr > 0 ? (
                <Odznaka ton="ostrzezenie">Do dopłaty {money(p.roznicaGr / 100, d.waluta)}</Odznaka>
              ) : p.roznicaGr < 0 ? (
                <Odznaka ton="blad">Do zwrotu {money(-p.roznicaGr / 100, d.waluta)}</Odznaka>
              ) : (
                <Odznaka ton="sukces">rozliczone</Odznaka>
              )}
            </dd>
          </>
        )}
        {o.stockReleaseAt && nieoplacone && (
          <>
            <dt>Towar wraca do sprzedaży</dt>
            <dd>
              {o.status === 'DO_WYJASNIENIA' && o.stockReleaseAt <= now ? 'po wyjaśnieniu' : when(o.stockReleaseAt, now)} (płatność online się nie udała)
            </dd>
          </>
        )}
        {o.stockReleasedAt && nieoplacone && (
          <>
            <dt>Towar zwolniony</dt>
            <dd>{when(o.stockReleasedAt, now)}: płatność online się nie udała, zamówienie czeka na płatność. Po wpłacie zarezerwujemy to, co będzie na stanie.</dd>
          </>
        )}
        {o.reservationDeadline && nieoplacone && (
          <>
            <dt>{o.stockReleaseAt || o.stockReleasedAt ? 'Anulowanie bez wpłaty' : 'Towar wraca na stan'}</dt>
            <dd>{when(o.reservationDeadline, now)}</dd>
          </>
        )}
        {o.remindAt && (
          <>
            <dt>Przypomnienie o płatności</dt>
            <dd>{o.reminderSentAt ? `wysłane ${when(o.reminderSentAt, now)}` : when(o.remindAt, now)}</dd>
          </>
        )}
      </dl>
      {p.wpisy.length > 0 && (
        <ul className="timeline kz-odstep-gora">
          {p.wpisy.map((w) => (
            <li key={w.id}>
              <span className="mono small muted">{when(w.kiedy, now)}</span> {RODZAJ_LABEL[w.rodzaj]} {money(w.kwota, d.waluta)}
              {w.metoda ? <span className="muted small"> · {w.metoda}</span> : null}
            </li>
          ))}
        </ul>
      )}
      <div className="kz-poz-akcje kz-odstep-gora">
        {naOplacone &&
          (powodWplaty ? (
            <Nieaktywny etykieta="Oznacz jako opłacone" powod={powodWplaty} />
          ) : (
            <form action={oznaczOplaconeKarta}>
              <input type="hidden" name="zamowienie" value={o.id} />
              <Przycisk type="submit">Oznacz jako opłacone</Przycisk>
            </form>
          ))}
        {naDoplate &&
          (powodWplaty ? <Nieaktywny etykieta="Zapisz dopłatę" powod={powodWplaty} /> : <FormularzWplaty klucz="dp" waluta={d.waluta} orderId={o.id} akcja={zapiszDoplateKarta} etykieta="Zapisz dopłatę" kwota={Math.max(0, p.roznicaGr)} />)}
        {naZwrot &&
          (powodZwrotu ? (
            <Nieaktywny etykieta="Zwrot różnicy" powod={powodZwrotu} />
          ) : (
            <FormularzWplaty klucz="zr" waluta={d.waluta} orderId={o.id} akcja={zwrotRoznicyKarta} etykieta="Zwrot różnicy" kwota={-p.roznicaGr} potwierdz="Zapisać zwrot różnicy? Przelew zrobisz w banku: Kompletor zapisuje zwrot i dokłada go do eksportu przelewów." />
          ))}
        {powodZmiany ? <Nieaktywny etykieta={etykietaZmiany} powod={powodZmiany} /> : <ZmianaPlatnosci orderId={o.id} kierunek={p.zmiana.kierunek} />}
      </div>
      {powody.length > 0 && (
        <div id="plat-powod">
          {powody.map((t) => (
            <p key={t} className="ui-akcja-powod kz-odstep-gora">
              {t}
            </p>
          ))}
        </div>
      )}
      {d.praca && <p className="muted small kz-odstep-gora">Zapis tylko w Kompletorze: karta nie łączy się z bankiem i nie wysyła linków do płatności.</p>}
    </Sekcja>
  )
}
