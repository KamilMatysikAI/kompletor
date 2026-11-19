// Lista przesyłek: jedna lista ze wszystkich przewoźników i kont (BaseLinker ma osobną stronę na
// każdego kuriera). Data, przewoźnik i konto, zamówienie (link), numer nadania z linkiem do strony śledzenia u
// przewoźnika, stan (utworzenie u przewoźnika i droga paczki z osi statusów), akcje w wierszu („Etykieta”,
// „Drukuj”) i akcje na zaznaczonych (etykiety w jednym PDF, druk na stanowisku, protokół odbioru, anulowanie).
// Filtry i sortowanie w adresie, paginacja w bazie (lib/wysylka/lista.ts). Widzi ją każdy z dostępem do panelu,
// akcje wymagają uprawnienia stanowiska pakowania.
import Link from 'next/link'
import { NaglowekStrony, Odznaka, PasekFiltrow, PrzyciskLink, PustyStan, Tabela, type KolumnaTabeli, type WierszTabeli } from '@/app/ui'
import { CARRIER_LABEL, when } from '@/lib/panel/format'
import type { Ton } from '@/lib/panel/statusy'
import { requireSession } from '@/lib/panel/kontekst'
import { adresZ, sortZ, stronaZ } from '@/lib/panel/tabela'
import {
  FILTR_DROGI_OPIS,
  FILTRY_DROGI,
  filtryPrzesylekZ,
  ileFiltrowPrzesylek,
  kontaPrzewoznikow,
  pokazDrogeNaLiscie,
  PRZEWOZNICY_PRZESYLEK,
  SORT_PRZESYLEK,
  SORT_PRZESYLEK_DOMYSLNY,
  STAN_PRZESYLKI,
  STANY_PRZESYLKI,
  stronaPrzesylek,
  type WierszPrzesylki,
} from '@/lib/wysylka/lista'
import { ostatnieAkcjePrzesylek, powodKontaWylaczonego } from '@/lib/wysylka/masowo'
import { przewoznikAnuluje } from '@/lib/wysylka/nadanie'
import { TON_DROGI } from '@/lib/wysylka/droga-paczki'
import { NumerNadania } from '../_komponenty/numer-nadania'
import { PostepAkcji } from '../zamowienia/_lista/postep-akcji'
import { AkcjePrzesylek, DrukujWiersz, type WierszAkcji } from './_lista/akcje-przesylek'
import '../zamowienia/_lista/lista.css'

export const metadata = { title: 'Przesyłki' }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

const KOLUMNY: KolumnaTabeli[] = [
  { klucz: 'data', etykieta: 'Utworzona', sortowalna: true, szerokosc: '6.5rem' },
  { klucz: 'przewoznik', etykieta: 'Przewoźnik i konto', sortowalna: true },
  { klucz: 'zamowienie', etykieta: 'Zamówienie', szerokosc: '9rem' },
  { klucz: 'numer', etykieta: 'Numer nadania', sortowalna: true },
  { klucz: 'stan', etykieta: 'Stan', sortowalna: true, szerokosc: '11rem' },
  { klucz: 'akcje', etykieta: 'Akcje', szerokosc: '10rem' },
]

const TON: Record<WierszPrzesylki['stan'], Ton> = {
  UTWORZONA: 'sukces',
  TWORZENIE: 'info',
  NIEJEDNOZNACZNA: 'ostrzezenie',
  BLAD: 'blad',
  ANULOWANA: 'neutralny',
}

export default async function Przesylki({ searchParams }: Props) {
  const ctx = await requireSession()
  const sp = await searchParams
  const f = filtryPrzesylekZ(sp)
  const sort = sortZ(sp, SORT_PRZESYLEK, SORT_PRZESYLEK_DOMYSLNY)
  const { strona, ile, pomin } = stronaZ(sp)
  const konta = await kontaPrzewoznikow(ctx.db)
  const [dane, akcje] = await Promise.all([stronaPrzesylek(ctx.db, f, { sort, pomin, ile, konta }), ostatnieAkcjePrzesylek(ctx.db, ctx.user.id)])
  const now = new Date()
  const mozeMagazyn = ctx.permissions.has('pakowanie.stanowisko')
  const adres = { sciezka: '/przesylki', parametry: sp }
  const filtryQs = adresZ('', sp, { strona: undefined, ile: undefined }).replace(/^\?/, '')
  const zachowaj = { sort: one(sp.sort), kier: one(sp.kier), ile: one(sp.ile) }
  const opcja = (wartosc: string, etykieta: string) => (
    <option key={wartosc} value={wartosc}>
      {etykieta}
    </option>
  )

  const akcjeWierszy: Record<string, WierszAkcji> = {}
  const wiersze: WierszTabeli[] = dane.wiersze.map((s) => {
    const wylaczone = powodKontaWylaczonego(s.konto)
    const [adapterKey] = s.konto.klucz.split('~')
    akcjeWierszy[s.id] = {
      wylaczone,
      etykieta: s.etykieta && s.stan === 'UTWORZONA',
      anulowalna: s.stan === 'UTWORZONA' && przewoznikAnuluje(adapterKey!),
      konto: s.konto.klucz,
    }
    const powodEtykiety = !mozeMagazyn ? 'Etykiety drukuje osoba z dostępem do stanowiska pakowania.' : wylaczone ?? (s.stan !== 'UTWORZONA' ? 'Przesyłka nie jest utworzona u przewoźnika.' : !s.etykieta ? 'Etykieta nie została pobrana: „Pobierz etykietę” na karcie zamówienia.' : null)
    return {
      id: s.id,
      etykieta: `Przesyłka ${s.numer ?? s.zamowienie}`,
      ton: s.stan === 'BLAD' ? 'blad' : s.stan === 'NIEJEDNOZNACZNA' ? 'ostrzezenie' : undefined,
      komorki: {
        data: <span title={s.utworzono.toISOString()}>{when(s.utworzono, now)}</span>,
        przewoznik: (
          <>
            <b>{s.przewoznik}</b>
            <br />
            <span className="small muted">{s.konto.nazwa}</span>
          </>
        ),
        zamowienie: (
          <Link href={`/zamowienia/${s.orderId}`}>
            {s.zamowienie}
            {s.paczka > 1 ? ` (paczka ${s.paczka})` : ''}
            {s.dodatkowa ? ` · ${s.dodatkowa}` : ''}
          </Link>
        ),
        numer: s.numer ? <code><NumerNadania numer={s.numer} href={s.link} /></code> : <span className="muted">brak numeru</span>,
        stan: (
          <>
            {/* utworzona przesyłka ze stanem drogi: sam stan drogi (np. „W drodze”) z datą; inne stany jak dotąd */}
            {pokazDrogeNaLiscie(s.stan, s.droga) && s.stan === 'UTWORZONA' ? null : <Odznaka ton={TON[s.stan]}>{s.stanOpis}</Odznaka>}
            {s.droga && s.drogaOpis && pokazDrogeNaLiscie(s.stan, s.droga) ? (
              <span className="small" title={s.statusPrzewoznika ? `u przewoźnika: ${s.statusPrzewoznika}` : undefined}>
                {s.stan === 'UTWORZONA' ? null : <br />}
                <Odznaka ton={TON_DROGI[s.droga]}>{s.drogaOpis}</Odznaka>
                {s.drogaOd && (
                  <>
                    <br />
                    <span className="muted">od {when(s.drogaOd, now)}</span>
                  </>
                )}
              </span>
            ) : s.statusPrzewoznika && (
              <span className="small muted" title={s.sledzonoO ? `odczyt ${s.sledzonoO.toISOString()}` : undefined}>
                <br />u przewoźnika: {s.statusPrzewoznika}
              </span>
            )}
            {s.blad && (
              <span className="small muted">
                <br />
                {s.blad.slice(0, 120)}
              </span>
            )}
          </>
        ),
        akcje: (
          <span className="pl-akcje-wiersza">
            {powodEtykiety ? (
              <span className="btn small is-disabled" aria-disabled="true" title={powodEtykiety}>
                Etykieta<span className="sr"> ({powodEtykiety})</span>
              </span>
            ) : (
              <a className="btn small" href={`/api/przesylki/etykiety?z=${s.id}`} target="_blank" rel="noopener">
                Etykieta
              </a>
            )}
            <DrukujWiersz id={s.id} powod={powodEtykiety} />
          </span>
        ),
      },
    }
  })

  return (
    <>
      <NaglowekStrony
        tytul="Przesyłki"
        podtytul={`Wszyscy przewoźnicy w jednym miejscu: ${dane.razem} ${dane.razem === 1 ? 'przesyłka' : 'przesyłek'}${ileFiltrowPrzesylek(f) || f.numer ? ' pasujących do filtrów' : ''}.`}
        akcje={
          <PrzyciskLink href="/pomoc/przesylki" wariant="cichy" rozmiar="sm">
            Jak to działa
          </PrzyciskLink>
        }
      />
      {akcje.map((a) => (
        <PostepAkcji key={a.id} id={a.id} poczatkowy={a} lista="przesylki" />
      ))}
      <PasekFiltrow
        akcja="/przesylki"
        szukaj={{ nazwa: 'numer', wartosc: f.numer, etykieta: 'Szukaj po numerze nadania', podpowiedz: 'numer nadania albo jego fragment' }}
        aktywne={ileFiltrowPrzesylek(f)}
        zwijane
        wyczysc="/przesylki"
        zachowaj={zachowaj}
      >
        <div className="field">
          <label htmlFor="p-przew">Przewoźnik</label>
          <select className="input" id="p-przew" name="przewoznik" defaultValue={f.przewoznik ?? ''}>
            {opcja('', 'Wszyscy')}
            {PRZEWOZNICY_PRZESYLEK.map((c) => opcja(c, CARRIER_LABEL[c]))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="p-konto">Konto przewoźnika</label>
          <select className="input" id="p-konto" name="konto" defaultValue={f.konto ?? ''}>
            {opcja('', 'Wszystkie')}
            {[...konta.values()].map((k) => opcja(k.klucz, k.nazwa))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="p-stan">Stan</label>
          <select className="input" id="p-stan" name="stan" defaultValue={f.stan ?? ''}>
            {opcja('', 'Wszystkie')}
            {STANY_PRZESYLKI.map((s) => opcja(s, STAN_PRZESYLKI[s]))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="p-droga">Droga paczki</label>
          <select className="input" id="p-droga" name="droga" defaultValue={f.droga ?? ''}>
            {opcja('', 'Wszystkie')}
            {FILTRY_DROGI.map((s) => opcja(s, FILTR_DROGI_OPIS[s]))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="p-zam">Numer zamówienia</label>
          <input className="input" id="p-zam" name="zamowienie" defaultValue={f.zamowienie ?? ''} autoComplete="off" />
        </div>
        <div className="field">
          <label htmlFor="p-od">Utworzone od</label>
          <input className="input" type="date" id="p-od" name="od" defaultValue={f.od ?? ''} />
        </div>
        <div className="field">
          <label htmlFor="p-do">Utworzone do</label>
          <input className="input" type="date" id="p-do" name="do" defaultValue={f.do ?? ''} />
        </div>
      </PasekFiltrow>

      <Tabela
        id="przesylki"
        etykieta="Przesyłki"
        kolumny={KOLUMNY}
        wiersze={wiersze}
        adres={adres}
        sort={sort}
        zaznaczanie
        akcjeMasowe={<AkcjePrzesylek wiersze={akcjeWierszy} razem={dane.razem} filtry={filtryQs} mozeMagazyn={mozeMagazyn} />}
        paginacja={{ strona, ile, razem: dane.razem }}
        pustyStan={
          ileFiltrowPrzesylek(f) || f.numer ? (
            <PustyStan tytul="Brak przesyłek pasujących do filtrów" akcja={<PrzyciskLink href="/przesylki">Wyczyść filtry</PrzyciskLink>}>
              Zmień filtry albo wpisz inny numer nadania.
            </PustyStan>
          ) : (
            <PustyStan tytul="Nie ma jeszcze przesyłek" akcja={<PrzyciskLink href="/zamowienia">Przejdź do zamówień</PrzyciskLink>}>
              Przesyłka pojawi się tutaj po kliknięciu „Utwórz przesyłkę” na karcie zamówienia albo w akcjach listy zamówień.
            </PustyStan>
          )
        }
      />
    </>
  )
}
