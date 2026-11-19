// Sekcja „Klient i adresy” karty zamówienia (układ i wzorem BL): trzy karty obok
// siebie — Kupujący (imię i nazwisko, firma, login, e-mail, telefon, uwagi), Adres dostawy (z punktem odbioru) i Dane
// do faktury. Kontakt i uwagi są tylko tu (nie powtarzają się w innych sekcjach). Dane wyłącznie z jednego odczytu
// `daneKlienta` w page.tsx (uprawnienie sprawdzane po stronie serwera, jeden wpis w dzienniku podglądów na
// wyświetlenie karty). Pełny widok z `klienci.dane`; skrót („Jan T., Poznań”) z `klienci.skrot`; bez obu sekcji nie
// ma. Zamówienie ręczne: dane wpisuje się w miejscu jednym formularzem z jednym zapisem (PasekZapisu).
// (wzór układu TwojOMS, MIT): zamiast jednej sekcji „Klient i adresy” dwie równe karty na górze karty
// zamówienia — „Wysyłka” (odbiorca, adres, punkt, kontakt, sposób wysyłki, przewoźnik, koszt) i „Dane do faktury”.
// Obie w odczycie; przy zamówieniu ręcznym „Edytuj” (`?edytuj=klient`) zamienia je na ten sam formularz co dotąd
// (te same pola, akcja `wpiszKlienta`), a zapis i „Anuluj” wracają do odczytu.
// (E2): zamówienie z kanału ma dwa osobne formularze: „Edytuj kupującego” w karcie „Wysyłka” (imię i nazwisko,
// firma, telefon, e-mail; `?edytuj=kupujacy`) i „Edytuj” w „Dane do faktury” (bez danych / faktura imienna / na firmę,
// nazwa, NIP, adres; `?edytuj=faktura`). W „Tylko podgląd” oba nieaktywne z powodem trybu, dane do faktury także po
// dokumencie sprzedaży (`powodBlokadyFaktury`); na paczce dodatkowej oba nieaktywne z odsyłaczem do zamówienia
// głównego, bez rekordu przy kanale z danymi oba nieaktywne z „Najpierw »Odśwież z kanału«” (przegląd E2). Wersja rekordu w ukrytym polu: zapis odmawia, gdy dane zmieniły się po otwarciu formularza.
import Link from 'next/link'
import { type EdycjaSekcji, Odznaka, PasekZapisu, PoleTekstowe, PrzyciskPotwierdz, Sekcja, WyborJednej } from '@/app/ui'
import { flagsOf } from '@/lib/rdzen/rezerwacja'
import type { DaneKarty } from '@/lib/karta/dane'
import { adresEdycji, adresOdczytu } from '@/lib/karta/uklad'
import { NAJPIERW_ODSWIEZ, NAJPIERW_ODSWIEZ_ALBO_ADRES, PACZKA_DODATKOWA, powodBlokadyFaktury, rodzajFaktury } from '@/lib/klienci/edycja-danych'
import { type DaneKlienta, POWOD_BRAKU_TEKST, type PowodBraku } from '@/lib/klienci/odczyt'
import { skrotTekst, type RekordKlienta } from '@/lib/klienci/rekord'
import { fakturaWOkresie } from '@/lib/klienci/retencja'
import { KOMUNIKAT_BRAK_KLUCZA } from '@/lib/klienci/szyfr'
import { CARRIER_LABEL, money, when } from '@/lib/panel/format'
import { requireSession } from '@/lib/panel/kontekst'
import { formatData } from '@/lib/wydruki/wspolne'
import { usunKlienta, wpiszKlienta, zapiszFaktureAkcja, zapiszKupujacegoAkcja } from './akcje-klient'
import { PrzyciskiKlienta } from './klient-przyciski'

const ZRODLO = { KANAL: 'z kanału', RECZNE: 'wpisane ręcznie', PRZEPROWADZKA: 'z przeprowadzki z BaseLinkera' } as const

/** Zamówienie ręczne: dane klienta wpisywane w miejscu (te same pola i akcja co dotąd), jeden zapis. */
function Formularz({ orderId, r, anulujHref }: { orderId: string; r: RekordKlienta | null; anulujHref: string }) {
  const d = r?.dostawa
  const f = r?.faktura
  const pole = (name: string, etykieta: string, v: string | null | undefined, extra: Record<string, string> = {}) => <PoleTekstowe id={`kl-${name}`} name={name} etykieta={etykieta} defaultValue={v ?? ''} autoComplete="off" opcjonalne {...extra} />
  return (
    <form action={wpiszKlienta} aria-label="Dane klienta zamówienia ręcznego">
        <input type="hidden" name="zamowienie" value={orderId} />
        <div className="grid g3 kz-kafle">
          <fieldset className="kz-fieldset">
            <legend>Kupujący</legend>
            {pole('imie', 'Imię i nazwisko', r?.nabywca?.imieNazwisko ?? d?.imieNazwisko)}
            {pole('firma', 'Firma', r?.nabywca?.firma ?? d?.firma)}
            {pole('telefon', 'Telefon', r?.telefon, { inputMode: 'tel' })}
            {pole('email', 'E-mail', r?.email, { inputMode: 'email' })}
            {pole('uwagi', 'Uwagi klienta', r?.uwagiKlienta)}
          </fieldset>
          <fieldset className="kz-fieldset">
            <legend>Adres dostawy</legend>
            {pole('ulica', 'Ulica', d?.ulica)}
            <div className="kz-pola-obok">
              {pole('dom', 'Nr domu', d?.numerDomu, { size: '6' })}
              {pole('lokal', 'Nr lokalu', d?.numerLokalu, { size: '6' })}
            </div>
            <div className="kz-pola-obok">
              {pole('kod', 'Kod pocztowy', d?.kodPocztowy, { placeholder: 'NN-NNN', size: '8', inputMode: 'numeric' })}
              {pole('miasto', 'Miasto', d?.miasto)}
            </div>
            {pole('punkt', 'Punkt odbioru (kod)', r?.punktOdbioru?.kod)}
          </fieldset>
          <fieldset className="kz-fieldset">
            <legend>Dane do faktury</legend>
            {pole('f_nazwa', 'Nazwa', f?.nazwa)}
            {pole('f_nip', 'NIP', f?.nip, { inputMode: 'numeric' })}
            {pole('f_ulica', 'Ulica', f?.ulica)}
            <div className="kz-pola-obok">
              {pole('f_kod', 'Kod', f?.kodPocztowy, { placeholder: 'NN-NNN', size: '8' })}
              {pole('f_miasto', 'Miasto', f?.miasto)}
            </div>
          </fieldset>
        </div>
        <PasekZapisu zapisz="Zapisz dane klienta" zawszeAktywny={!r} ukryjBezZmian={!!r} anulujHref={anulujHref} fokusPoAnuluj="h-wysylka" />
    </form>
  )
}

/** Zamówienie z kanału: kupujący i kontakt (adres i punkt poprawia „Popraw adres albo punkt odbioru” w „Przesyłce”). */
function FormularzKupujacego({ orderId, r, wersja, anulujHref }: { orderId: string; r: RekordKlienta | null; wersja: number; anulujHref: string }) {
  const pole = (name: string, etykieta: string, v: string | null | undefined, extra: Record<string, string> = {}, opcjonalne = true) => (
    <PoleTekstowe id={`kup-${name}`} name={name} etykieta={etykieta} defaultValue={v ?? ''} autoComplete="off" opcjonalne={opcjonalne} {...extra} />
  )
  const allegro = !!r?.email && /@allegromail\.pl$/i.test(r.email)
  return (
    <form action={zapiszKupujacegoAkcja} aria-label="Dane kupującego" className="kz-form-danych">
      <input type="hidden" name="zamowienie" value={orderId} />
      <input type="hidden" name="wersja" value={wersja} />
      <fieldset className="kz-fieldset">
        <legend>Kupujący i kontakt</legend>
        {pole('imie', 'Imię i nazwisko', r?.nabywca?.imieNazwisko ?? r?.dostawa?.imieNazwisko, { 'aria-describedby': 'kup-imie-opis' }, false)}
        <p id="kup-imie-opis" className="muted small kz-bez-marginesu">Wystarczy imię i nazwisko albo sama firma.</p>
        {pole('firma', 'Firma', r?.nabywca?.firma ?? r?.dostawa?.firma)}
        {pole('telefon', 'Telefon', r?.telefon, { inputMode: 'tel', type: 'tel' })}
        {pole('email', 'E-mail', r?.email, { inputMode: 'email', type: 'email' })}
        {allegro && <p className="muted small kz-bez-marginesu">E-mail z Allegro to adres zastępczy (…@allegromail.pl): wiadomości do klienta przekazuje Allegro.</p>}
      </fieldset>
      <p className="muted small">Adres dostawy i punkt odbioru zmieniasz w bloku „Przesyłka”: „Popraw adres albo punkt odbioru przed nadaniem”. Telefon i e-mail zmienione po utworzeniu przesyłki nie trafiają już do przewoźnika.</p>
      <p className="muted small">Nazwisko na etykiecie i na fakturze osoby prywatnej pochodzi z adresu dostawy: zmienisz je w „Popraw adres albo punkt odbioru” przed nadaniem. Tu zmieniasz kupującego i kontakt do maili.</p>
      <PasekZapisu zapisz="Zapisz dane kupującego" ukryjBezZmian anulujHref={anulujHref} fokusPoAnuluj="h-wysylka" />
    </form>
  )
}

/**
 * Zamówienie z kanału: dane do faktury w trzech stanach (przegląd E2): bez danych do faktury, faktura imienna (bez
 * NIP-u), faktura na firmę (NIP). Stan początkowy z rekordu (`rodzajFaktury`). Usunięcie istniejących danych wymaga
 * zaznaczenia potwierdzenia (serwer odmawia bez niego). Tylko przed dokumentem sprzedaży.
 */
function FormularzFaktury({ orderId, r, chceFaktury, wersja, anulujHref }: { orderId: string; r: RekordKlienta | null; chceFaktury: boolean; wersja: number; anulujHref: string }) {
  const f = r?.faktura
  const rodzaj = rodzajFaktury(f, chceFaktury)
  const sa = !!f || chceFaktury
  const pole = (name: string, etykieta: string, v: string | null | undefined, extra: Record<string, string> = {}) => <PoleTekstowe id={`fk-${name}`} name={name} etykieta={etykieta} defaultValue={v ?? ''} autoComplete="off" {...extra} />
  return (
    <form action={zapiszFaktureAkcja} aria-label="Dane do faktury" className="kz-form-danych">
      <input type="hidden" name="zamowienie" value={orderId} />
      <input type="hidden" name="wersja" value={wersja} />
      <WyborJednej
        legenda="Rodzaj"
        name="f_rodzaj"
        domyslna={rodzaj.toLowerCase()}
        opcje={[
          { wartosc: 'brak', etykieta: 'Bez danych do faktury', opis: 'Paragon albo faktura na dane z adresu dostawy. Pola niżej zostaną wyczyszczone.' },
          { wartosc: 'imienna', etykieta: 'Faktura imienna (bez NIP-u)', opis: 'Osoba prywatna z własnymi danymi do faktury: imię i nazwisko oraz adres, NIP pusty.' },
          { wartosc: 'firma', etykieta: 'Faktura na firmę (NIP)', opis: 'Nazwa firmy, NIP i adres.' },
        ]}
      />
      {sa && (
        <label className="kz-przelacznik small">
          <input type="checkbox" name="f_usun" value="tak" aria-describedby="fk-usun-opis" /> Tak, usuń dane do faktury
        </label>
      )}
      {sa && (
        <p id="fk-usun-opis" className="muted small kz-bez-marginesu">
          Potrzebne tylko przy „Bez danych do faktury”: zamówienie ma dziś dane do faktury albo prośbę o fakturę, a kanał ich już nie odtworzy.
        </p>
      )}
      <fieldset className="kz-fieldset">
        <legend>Dane do faktury</legend>
        {pole('f_nazwa', 'Nazwa firmy albo imię i nazwisko', f?.nazwa)}
        {pole('f_nip', 'NIP (tylko faktura na firmę)', f?.nip, { inputMode: 'numeric', 'aria-describedby': 'fk-nip-opis' })}
        <p id="fk-nip-opis" className="muted small kz-bez-marginesu">10 cyfr; „PL”, spacje i myślniki Kompletor zdejmie sam. Przy fakturze imiennej zostaw puste.</p>
        {pole('f_ulica', 'Ulica i numer', f?.ulica)}
        <div className="kz-pola-obok">
          {pole('f_kod', 'Kod pocztowy', f?.kodPocztowy, { placeholder: 'NN-NNN', size: '8', inputMode: 'numeric' })}
          {pole('f_miasto', 'Miasto', f?.miasto)}
        </div>
      </fieldset>
      <PasekZapisu zapisz="Zapisz dane do faktury" ukryjBezZmian anulujHref={anulujHref} fokusPoAnuluj="h-dane-faktury" />
    </form>
  )
}

async function Usun({ orderId }: { orderId: string }) {
  const ctx = await requireSession()
  const f = await fakturaWOkresie(ctx.db, orderId)
  if (f.blokada) return <p className="muted small kz-bez-marginesu">Usunąć danych nie można: zamówienie ma fakturę, a dane do faktury przechowujemy do {formatData(f.do!)}.</p>
  return (
    <details className="kz-usun-dane">
      <summary className="small">Usuń dane klienta (żądanie z RODO art. 17)</summary>
      <form action={usunKlienta} className="kz-zmien-pola">
        <PrzyciskPotwierdz wariant="niebezpieczny" rozmiar="sm" tytul="Usunąć dane klienta?" pytanie="Dane klienta tego zamówienia zostaną trwale usunięte i nie wrócą z kanału." tak="Tak, usuń dane">
          Usuń dane klienta
        </PrzyciskPotwierdz>
        <input type="hidden" name="zamowienie" value={orderId} />
        <label className="small">
          <input type="checkbox" name="potwierdzam" value="tak" required /> Potwierdzam: dane klienta tego zamówienia zostaną trwale usunięte i nie wrócą z kanału.
        </label>
      </form>
    </details>
  )
}

/** Treść zamiast danych, gdy rekordu nie ma albo nie da się go odczytać (ten sam komunikat co dotąd). */
export function powodBrakuTekst(d: DaneKlienta, powod: PowodBraku | null): string | null {
  if (d.stan === 'BRAK_KLUCZA') return `${KOMUNIKAT_BRAK_KLUCZA}.`
  if (d.stan === 'BLAD_SZYFRU') return 'Dane klienta niedostępne: nie da się ich odczytać (inny klucz szyfrowania albo uszkodzony wpis).'
  if (d.stan === 'USUNIETE') return `Dane klienta usunięte ${formatData(d.usunieto)} (retencja albo żądanie klienta).`
  if (d.stan === 'BRAK') return `Brak danych klienta: ${POWOD_BRAKU_TEKST[powod ?? 'NIE_ZAPISANO']}.`
  return null
}

function Para({ e, children }: { e: string; children: React.ReactNode }) {
  return (
    <>
      <dt>{e}</dt>
      <dd>{children}</dd>
    </>
  )
}

/** Kontakt i kupujący w karcie „Wysyłka” (kupujący tylko, gdy jest kimś innym niż odbiorca albo ma login w kanale). */
function Kontakt({ r }: { r: RekordKlienta }) {
  const n = r.nabywca
  const odbiorca = r.dostawa?.imieNazwisko ?? null
  const kupujacy = n?.imieNazwisko ?? null
  const firma = n?.firma ?? null
  return (
    <dl className="dl kz-punkt">
      <Para e="Telefon">{r.telefon ? <a href={`tel:${r.telefon.replace(/\s+/g, '')}`}>{r.telefon}</a> : '—'}</Para>
      <Para e="E-mail">{r.email ? <a href={`mailto:${r.email}`}>{r.email}</a> : '—'}</Para>
      {kupujacy && kupujacy !== odbiorca ? <Para e="Kupujący">{kupujacy}</Para> : null}
      {firma && firma !== r.dostawa?.firma && <Para e="Firma kupującego">{firma}</Para>}
      {r.login && <Para e="Login w kanale">{r.login}</Para>}
      {r.uwagiKlienta && (
        <Para e="Uwagi klienta">
          <span className="kz-uwagi">{r.uwagiKlienta}</span>
        </Para>
      )}
    </dl>
  )
}

function AdresDostawy({ r }: { r: RekordKlienta }) {
  const d = r.dostawa
  const p = r.punktOdbioru
  const numer = d?.numerDomu ? ` ${d.numerDomu}${d.numerLokalu ? `/${d.numerLokalu}` : ''}` : ''
  return (
    <>
      {d ? (
        <dl className="dl">
          <Para e="Odbiorca">{d.imieNazwisko ?? '—'}</Para>
          {d.firma && <Para e="Firma">{d.firma}</Para>}
          <Para e="Adres">{d.ulica ? `${d.ulica}${numer}` : '—'}</Para>
          <Para e="Kod i miasto">{[d.kodPocztowy, d.miasto].filter(Boolean).join(' ') || '—'}</Para>
          {d.kraj && d.kraj !== 'PL' && <Para e="Kraj">{d.kraj}</Para>}
        </dl>
      ) : (
        <p className="muted small kz-bez-marginesu">Kanał nie podał adresu dostawy.</p>
      )}
      {r.problemy.includes('adres_bez_podzialu') && <p className="muted small">Kanał podał ulicę i numer w jednej linii: przed nadaniem rozdziel adres.</p>}
      {p && (
        <dl className="dl kz-punkt">
          <Para e="Punkt odbioru">
            {p.nazwa ? `${p.nazwa} ` : ''}
            <span className="mono">{p.kod}</span>
          </Para>
          {(p.adres?.ulica || p.adres?.miasto) && <Para e="Adres punktu">{[p.adres?.ulica, [p.adres?.kodPocztowy, p.adres?.miasto].filter(Boolean).join(' ')].filter(Boolean).join(', ')}</Para>}
        </dl>
      )}
    </>
  )
}

function DaneFaktury({ r, naFirme }: { r: RekordKlienta; naFirme: boolean }) {
  const f = r.faktura
  if (!f && naFirme) return <p className="kz-bez-marginesu">Klient chce faktury na firmę, ale kanał nie podał danych do faktury: uzupełnij je przyciskiem „Edytuj”.</p>
  if (!f) return <p className="muted small kz-bez-marginesu">Klient nie chce faktury na firmę albo kanał tego nie podaje.</p>
  return (
    <dl className="dl">
      {!f.nip && <Para e="Rodzaj">faktura imienna (bez NIP-u)</Para>}
      <Para e="Nazwa">{f.nazwa ?? '—'}</Para>
      <Para e="NIP">
        <span className="mono">{f.nip ?? '—'}</span>
      </Para>
      <Para e="Adres">{f.ulica ?? '—'}</Para>
      <Para e="Kod i miasto">{[f.kodPocztowy, f.miasto].filter(Boolean).join(' ') || '—'}</Para>
      {f.kraj && f.kraj !== 'PL' && <Para e="Kraj">{f.kraj}</Para>}
    </dl>
  )
}

/** Sposób wysyłki z kanału (tylko tu na karcie): sposób, przewoźnik, koszt. */
function SposobWysylki({ d }: { d: DaneKarty }) {
  const { o } = d
  const koszt = o.shippingCostGross === null ? null : Number(o.shippingCostGross)
  return (
    <dl className="dl kz-punkt">
      <Para e="Sposób wysyłki">{o.deliveryMethod ?? '—'}</Para>
      <Para e="Przewoźnik">
        {o.carrier ? CARRIER_LABEL[o.carrier] : '—'}
        {/* sposób wysyłki zmieniony na karcie: „Sposób wysyłki” wyżej to dalej wybór klienta w kanale */}
        {flagsOf(o).przewoznikRecznie && (
          <>
            {' '}
            <Odznaka ton="info" rozmiar="sm" title="Przewoźnika zmieniono na karcie zamówienia (szczegóły w historii). Metoda wyżej to wybór klienta w kanale; kolejny odczyt z kanału zmiany nie cofnie.">
              zmieniony na karcie
            </Odznaka>
          </>
        )}
      </Para>
      <Para e="Koszt wysyłki">
        <span className="num">{koszt === null ? <span className="muted">kanał nie podał</span> : money(koszt)}</span>
      </Para>
    </dl>
  )
}

const BEZ_DANYCH = 'Adres i kontakt widzi osoba z uprawnieniem „Dane klienta” (Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia).'

/**
 * Karty „Wysyłka” i „Dane do faktury” (wcześniej sekcja „Klient i adresy”). Pełne dane tylko
 * z `klienci.dane`, ze `klienci.skrot` sam skrót, bez obu sam sposób wysyłki. Stopka „Wysyłki”: skąd dane, „Kopiuj
 * adres”, „Odśwież z kanału”, usunięcie (RODO). Zamówienie ręczne: „Edytuj” = jeden formularz zamiast obu kart.
 */
export async function KartyKlienta({ d, klient, powod, pelne, edytuj }: { d: DaneKarty; klient: DaneKlienta | null; powod: PowodBraku | null; pelne: boolean; edytuj: 'klient' | 'kupujacy' | 'faktura' | null }) {
  const ctx = await requireSession()
  const orderId = d.o.id
  const reczne = d.o.channel === 'RECZNE'
  const k = klient && klient.stan !== 'BEZ_UPRAWNIEN' ? klient : null
  const r = k?.stan === 'PELNY' ? k.rekord : null
  // ten sam warunek formularza co dotąd: zamówienie ręczne, pełny podgląd, dane nieusunięte
  const formularz = !!k && pelne && reczne && k.stan !== 'USUNIETE'
  const odczyt = adresOdczytu(orderId, 'wysylka')
  if (formularz && edytuj === 'klient')
    return (
      <Sekcja id="klient" tytul="Dane klienta" edycja={{ tryb: 'edycja', href: odczyt }} className="kz-dane-formularz">
        <Formularz orderId={orderId} r={r} anulujHref={odczyt} />
      </Sekcja>
    )
  const linkEdycji = formularz ? ({ tryb: 'odczyt', href: adresEdycji(orderId, 'klient'), etykieta: r ? 'Edytuj' : 'Wpisz dane' } as const) : null
  // (E2): zamówienie z kanału, pełny podgląd, rekord jest albo go nie ma (kanał nie podał danych)
  const kanalowe = !!k && pelne && !reczne && (k.stan === 'PELNY' || k.stan === 'BRAK')
  const wersja = k?.stan === 'PELNY' ? k.rewizja : 0
  const podglad = d.podglad?.powody.status ?? null
  // paczka dodatkowa = dane z zamówienia głównego; brak rekordu przy kanale z danymi = najpierw odczyt z kanału
  const glowne = kanalowe ? d.o.parentOrderId : null
  const odswiez = powod === 'ZAPIS_WYLACZONY' || powod === 'BLAD_ODCZYTU' ? NAJPIERW_ODSWIEZ_ALBO_ADRES : NAJPIERW_ODSWIEZ
  const zablokowane = podglad ?? (glowne ? PACZKA_DODATKOWA : k?.stan === 'BRAK' && powod !== 'KANAL_BEZ_ZRODLA' ? odswiez : null)
  // E3: powód widocznym tekstem także bez najechania myszą (telefon): akapit w karcie, przycisk odsyła do niego
  const opisBlokady = !podglad && glowne ? 'kl-paczka' : zablokowane ? 'kl-blokada' : undefined
  // powód braku rekordu (odśwież albo popraw adres) stoi raz, w karcie „Wysyłka”; „Edytuj” danych do
  // faktury odsyła do tego samego akapitu
  const bezRekordu = !podglad && !glowne && zablokowane === odswiez
  const opisBlokadyFaktury = !podglad && glowne ? 'df-paczka' : bezRekordu ? 'kl-blokada' : zablokowane ? 'df-blokada' : undefined
  const akapitBlokady = zablokowane && !(glowne && !podglad)
  const powodFaktury = kanalowe && !zablokowane ? await powodBlokadyFaktury(ctx.db, orderId) : null
  const edycjaKupujacego = kanalowe && !zablokowane && edytuj === 'kupujacy'
  const edycjaFaktury = kanalowe && !zablokowane && !powodFaktury && edytuj === 'faktura'
  const linkKupujacego: EdycjaSekcji | null = !kanalowe
    ? linkEdycji
    : zablokowane
      ? { tryb: 'niedostepna', powod: zablokowane, etykieta: 'Edytuj kupującego', opisId: opisBlokady }
      : edycjaKupujacego
        ? { tryb: 'edycja', href: odczyt }
        : { tryb: 'odczyt', href: adresEdycji(orderId, 'kupujacy'), etykieta: 'Edytuj kupującego' }
  const odczytFaktury = adresOdczytu(orderId, 'dane-faktury')
  const linkFaktury: EdycjaSekcji | null = !kanalowe
    ? linkEdycji
    : zablokowane
      ? { tryb: 'niedostepna', powod: zablokowane, opisId: opisBlokadyFaktury }
      : powodFaktury
        ? { tryb: 'niedostepna', powod: powodFaktury, opisId: 'df-powod' }
        : edycjaFaktury
          ? { tryb: 'edycja', href: odczytFaktury }
          : { tryb: 'odczyt', href: adresEdycji(orderId, 'faktura') }
  const now = new Date()
  const przyciski = pelne && k ? <PrzyciskiKlienta orderId={orderId} kopiuj={k.stan === 'PELNY' && !!k.rekord.dostawa} odswiez={!reczne && k.stan !== 'USUNIETE'} /> : null
  const usun = pelne && k && (k.stan === 'PELNY' || k.stan === 'SKROT') && ctx.permissions.has('ustawienia') ? <Usun orderId={orderId} /> : null
  const zrodlo = k?.stan === 'PELNY' ? `Dane ${ZRODLO[k.zrodlo]}, odczyt ${when(k.odczytano, now)}${k.rewizja > 1 ? `, odświeżane ${k.rewizja - 1}×` : ''}.` : null
  return (
    <>
      <Sekcja id="wysylka" tytul="Wysyłka" edycja={linkKupujacego}>
        {edycjaKupujacego ? (
          <>
            {r && <AdresDostawy r={r} />}
            <FormularzKupujacego key={`kup-${wersja}`} orderId={orderId} r={r} wersja={wersja} anulujHref={odczyt} />
          </>
        ) : r ? (
          <>
            <AdresDostawy r={r} />
            <Kontakt r={r} />
          </>
        ) : k?.stan === 'SKROT' ? (
          <p className="kz-bez-marginesu">
            {skrotTekst(k.skrot)} <span className="muted small">Pełne dane widzi osoba z uprawnieniem „Dane klienta: pełny podgląd”.</span>
          </p>
        ) : k ? (
          <p className="muted small kz-bez-marginesu">{powodBrakuTekst(k, powod)}</p>
        ) : (
          <p className="muted small kz-bez-marginesu">{BEZ_DANYCH}</p>
        )}
        {akapitBlokady && (
          <p id="kl-blokada" className="ui-akcja-powod">
            {zablokowane}
          </p>
        )}
        {glowne && !podglad && (
          <p id="kl-paczka" className="muted small">
            Dane klienta paczki dodatkowej (podział, dosłanie) zmieniasz na karcie zamówienia głównego: <Link href={`/zamowienia/${glowne}#wysylka`}>przejdź do zamówienia głównego</Link>.
          </p>
        )}
        <SposobWysylki d={d} />
        {(zrodlo || przyciski || usun) && (
          <div className="kz-stopka-sekcji">
            {zrodlo && <p className="muted small kz-bez-marginesu">{zrodlo}</p>}
            {przyciski && <div className="kz-poz-akcje">{przyciski}</div>}
            {usun}
          </div>
        )}
      </Sekcja>
      <Sekcja id="dane-faktury" tytul="Dane do faktury" edycja={linkFaktury}>
        {edycjaFaktury ? (
          <FormularzFaktury key={`fk-${wersja}`} orderId={orderId} r={r} chceFaktury={d.o.wantInvoiceNip} wersja={wersja} anulujHref={odczytFaktury} />
        ) : r ? (
          <DaneFaktury r={r} naFirme={d.o.wantInvoiceNip} />
        ) : k?.stan === 'SKROT' ? (
          <p className="muted small kz-bez-marginesu">Pełne dane widzi osoba z uprawnieniem „Dane klienta: pełny podgląd”.</p>
        ) : k ? (
          <p className="muted small kz-bez-marginesu">Brak danych klienta: szczegóły w karcie „Wysyłka”.</p>
        ) : (
          <p className="muted small kz-bez-marginesu">{BEZ_DANYCH}</p>
        )}
        {akapitBlokady && !bezRekordu && (
          <p id="df-blokada" className="ui-akcja-powod">
            {zablokowane}
          </p>
        )}
        {glowne && !podglad && (
          <p id="df-paczka" className="muted small">
            Dane klienta paczki dodatkowej (podział, dosłanie) zmieniasz na karcie zamówienia głównego: <Link href={`/zamowienia/${glowne}#dane-faktury`}>przejdź do zamówienia głównego</Link>.
          </p>
        )}
        {powodFaktury && (
          <p id="df-powod" className="muted small">
            {powodFaktury}
          </p>
        )}
      </Sekcja>
    </>
  )
}
