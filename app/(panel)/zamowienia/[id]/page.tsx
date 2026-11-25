// Karta zamówienia (wcześniej układ wzorem karty BL układ niżej): każda informacja
// w jednym miejscu. Nagłówek: numer, status, klient, kwota, „Co dalej”, menu „Wydruki” i „Więcej”. Pod nim stany trwałe
// (banery). Wynik akcji to toast (`?ok=<klucz>` / `?blad=<kod>` z przekierowania akcji serwera; treść błędu z zapisu
// w ciasteczku szczegółów).
// Dane przez lib/karta/dane.ts (bloki przesyłki i KSeF czytają swoje jak dotąd). Przyciski zmian tylko na koncie
// w trybie PRACA; w podglądzie status, podglądy i historia z banerem „Tylko podgląd”.
// (pomysł układu z TwojOMS, licencja MIT; kod i style własne): nowa kolejność — nagłówek → trzy równe
// karty danych („Wysyłka”, „Dane do faktury”, „Szczegóły zamówienia”) → pozycje pełną szerokością z podsumowaniem
// netto / VAT / brutto → „Przesyłka” | „Płatność” → „Dokument sprzedaży” | zwroty i notatki → historia. Sekcje
// w odczycie, „Edytuj” w pasku nagłówka sekcji włącza edycję przez adres (`?edytuj=pozycje|klient|kupujacy|faktura`, lib/karta/uklad.ts);
// akcje zapisu przekierowują na kartę bez parametru, więc zapis wraca do odczytu. Błąd zapisu zostaje banerem nad
// sekcjami do następnego wejścia, toast jak dotąd.
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import { Baner } from '@/app/ui'
import { daneKarty } from '@/lib/karta/dane'
import { komunikatZAdresu } from '@/lib/karta/komunikaty'
import { szczegolyBledu } from '@/lib/karta/komunikaty-serwer'
import { potrzebnyPodzialRekordu } from '@/lib/klienci/adres-ai'
import { daneKlienta, powodBrakuKlienta, type DaneKlienta, type PowodBraku } from '@/lib/klienci/odczyt'
import { imieNazwiskoMiasto, skrotTekst } from '@/lib/klienci/rekord'
import { requireSession } from '@/lib/panel/kontekst'
import { flagsOf } from '@/lib/rdzen/rezerwacja'
import { sekcjaEdycji } from '@/lib/karta/uklad'
import { informacjaOOtwarciu } from '@/lib/stanowisko/otwarcie'
import { Dostawa } from './dostawa'
import { Faktura } from './faktura'
import { Historia } from './historia'
import { KartyKlienta } from './klient'
import { Naglowek } from './naglowek'
import { etykietaStatusuFirmy } from '@/lib/panel/statusy'
import { statusyFirmy } from '@/lib/panel/statusy-firmy-dane'
import { Notatki } from './notatki'
import { Platnosc } from './platnosc'
import { Pozycje } from './pozycje'
import { Szczegoly } from './szczegoly'
import { ToastZAdresu } from './toast-z-adresu'
import './karta.css'
import { Zwroty } from './zwroty'
import { PrzyciskiRegul } from './przyciski-regul'

export const metadata = { title: 'Zamówienie' }

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }

export default async function Zamowienie({ params, searchParams }: Props) {
  const ctx = await requireSession()
  const { id } = await params
  const sp = await searchParams
  const tylkoLudzie = sp.historia === 'ludzie'
  const edytuj = sekcjaEdycji(sp.edytuj)
  const d = await daneKarty(ctx.db, id, { userId: ctx.user.id, uprawnienia: ctx.permissions }, { tylkoLudzie })
  if (!d) notFound()
  const { o } = d
  const flags = flagsOf(o)
  // status firmy w nagłówku (firma bez statusów własnych = nazwa rdzenia)
  const sf = await statusyFirmy(ctx.db)
  const statusFirmy = sf.statusy.length ? etykietaStatusuFirmy(sf.statusy, o) : null
  // jeden odczyt danych klienta na wyświetlenie karty (jeden wpis w dzienniku podglądów), wspólny dla
  // nagłówka i kart „Wysyłka” i „Dane do faktury”. Bez uprawnienia do danych klienta odczytu nie ma wcale.
  const pelne = ctx.permissions.has('klienci.dane')
  const klient: DaneKlienta | null =
    pelne || ctx.permissions.has('klienci.skrot') ? await daneKlienta(ctx.db, o.id, { actorId: ctx.user.id, zakres: pelne ? 'PELNY' : 'SKROT', cel: 'PODGLAD' }) : null
  const powod: PowodBraku | null = klient?.stan === 'BRAK' ? await powodBrakuKlienta(ctx.db, o.id) : null
  const klientNaglowek = klient?.stan === 'PELNY' ? naglowekKlienta(klient.rekord) : klient?.stan === 'SKROT' && klient.skrot ? skrotTekst(klient.skrot) : null
  // w adresie tylko kody; treść błędu z zapisu z ciasteczka szczegółów (lib/karta/komunikaty-serwer.ts)
  const szczegoly = typeof sp.blad === 'string' ? await szczegolyBledu() : null
  const komunikat = komunikatZAdresu({ get: (k) => (typeof sp[k] === 'string' ? (sp[k] as string) : null) }, szczegoly)
  // karta otwarta skanem, wklejeniem albo z „Szukaj” mówi, po czym ją otwarto
  const otwarte = informacjaOOtwarciu((k) => (typeof sp[k] === 'string' ? (sp[k] as string) : null))
  const braki = o.shortages.some((s) => s.state === 'OPEN') || o.fixes.length > 0
  return (
    <>
      <Naglowek d={d} uprawnienia={ctx.permissions} klient={klientNaglowek} statusFirmy={statusFirmy} />
      {/* przyciski automatycznych akcji firmy (Ustawienia → Automatyczne akcje) */}
      <PrzyciskiRegul db={ctx.db} orderId={o.id} mozna={ctx.permissions.has('zamowienia.przejscia')} />
      <Suspense fallback={null}>
        <ToastZAdresu szczegoly={szczegoly} />
      </Suspense>
      {komunikat && komunikat.rodzaj !== 'blad' && (
        <noscript>
          <Baner ton={komunikat.rodzaj} rola="status">
            {komunikat.tresc}
          </Baner>
        </noscript>
      )}

      <div className="kz-banery">
        {/* błąd zapisu zostaje na karcie (toast znika po kilku sekundach); także bez JavaScriptu */}
        {komunikat?.rodzaj === 'blad' && (
          <Baner ton="blad" rola="alert" tytul="Nie zapisano.">
            {komunikat.tresc}
          </Baner>
        )}
        {otwarte && (
          <Baner
            ton="info"
            rola="status"
            akcja={
              otwarte.wyniki && (
                <Link href={otwarte.wyniki} prefetch={false}>
                  Pokaż wyniki dla »{otwarte.trafienie}«
                </Link>
              )
            }
          >
            {otwarte.tekst}
          </Baner>
        )}
        {d.cien && <Baner ton="info">{d.cien}</Baner>}
        {o.status === 'DO_WYJASNIENIA' && (
          <Baner ton="uwaga" tytul="Do wyjaśnienia.">
            {flags.doWyjasnienia ?? 'System nie rozstrzygnął zamówienia sam.'}
          </Baner>
        )}
        {braki && (
          <Baner ton="blad" rola="note" tytul="Brakuje towaru.">
            Decyzję dla każdej brakującej pozycji wybierasz w kolumnie „Decyzja o braku” w pozycjach (bez wchodzenia w edycję); reszta zamówienia może iść dalej.
          </Baner>
        )}
        {d.coDalej?.bezPaczki && (
          <Baner ton="info" tytul="Bez paczki.">
            Zostaje sama usługa (np. e-book), towaru nie ma albo odrzucono go w całości. Po spakowaniu idzie faktura, potem „Odebrane”.
          </Baner>
        )}
      </div>

      {/* najpierw co jest w paczce, potem dla kogo (uwaga z 09.11) */}
      <Pozycje d={d} uprawnienia={ctx.permissions} edytuj={edytuj === 'pozycje'} />
      <div className="kz-dane">
        <KartyKlienta d={d} klient={klient} powod={powod} pelne={pelne} edytuj={edytuj === 'klient' || edytuj === 'kupujacy' || edytuj === 'faktura' ? edytuj : null} />
        <Szczegoly d={d} />
      </div>
      <div className="kz-dwie">
        <Dostawa d={d} ctx={ctx} podzialAdresu={klient?.stan === 'PELNY' && potrzebnyPodzialRekordu(klient.rekord)} />
        <Platnosc d={d} uprawnienia={ctx.permissions} />
      </div>
      <div className="kz-dwie">
        <Faktura d={d} ctx={ctx} />
        <div className="kz-kolumna">
          <Zwroty d={d} />
          <Notatki d={d} uprawnienia={ctx.permissions} />
        </div>
      </div>
      <Historia d={d} tylkoLudzie={tylkoLudzie} otwarta={typeof sp.historia === 'string'} />
      {d.praca && (
        <p className="muted small kz-stopka">
          Zmiany z karty są tylko w Kompletorze: nic nie idzie do kanału sprzedaży, banku ani KSeF. <Link href="/pomoc/karta-zamowienia">Jak działa karta</Link>
        </p>
      )}
    </>
  )
}

/** Klient w nagłówku: imię i nazwisko (albo firma) z pełnego rekordu, bez adresu. */
function naglowekKlienta(r: Parameters<typeof imieNazwiskoMiasto>[0]): string | null {
  const p = imieNazwiskoMiasto(r)
  if (!p) return null
  return [p.imie, p.nazwisko].filter(Boolean).join(' ') || null
}
