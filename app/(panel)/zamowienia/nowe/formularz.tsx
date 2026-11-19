'use client'
// Formularz „Dodaj zamówienie”: produkty z katalogu ze stanem dostępnym, klient nowy albo wyszukany
// fragmentem, dostawa (przewoźnik z reguł firmy, punkt odbioru, koszt), płatność, uwagi. Walidacja po stronie serwera
// (lib/zamowienia/formularz.ts + lib/klienci/walidacja.ts); tutaj tylko wygoda: lista pozycji, suma, ostrzeżenie o braku.
import { useActionState, useState, useTransition } from 'react'
import type { DaneKlientaWe, PoleKlienta } from '@/lib/klienci/walidacja'
import { dodajZamowienie, szukajKlientowNowe, szukajProduktowNowe } from './akcje'
import type { KlientWyniku, ProduktWyniku, StanNowego } from './stan'

const START: StanNowego = { blad: null }

interface Pozycja {
  p: ProduktWyniku
  ilosc: string
  cena: string
}

const zl = (n: number) => `${n.toFixed(2).replace('.', ',')} zł`
const liczba = (s: string) => {
  const v = Number(s.replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(v) ? v : 0
}

function Pole({ nazwa, etykieta, klient, ustaw, typ = 'text', max = 200, auto }: { nazwa: PoleKlienta; etykieta: string; klient: DaneKlientaWe; ustaw: (p: PoleKlienta, v: string) => void; typ?: string; max?: number; auto?: string }) {
  return (
    <div className="field">
      <label htmlFor={`nz-${nazwa}`}>{etykieta}</label>
      <input className="input" id={`nz-${nazwa}`} name={nazwa} type={typ} maxLength={max} autoComplete={auto ?? 'off'} value={klient[nazwa] ?? ''} onChange={(e) => ustaw(nazwa, e.target.value)} />
    </div>
  )
}

export function FormularzNowego(props: { numer: string; przewoznicy: { carrier: string; nazwa: string }[]; mozeKlient: boolean }) {
  const [stan, akcja, wysylanie] = useActionState(dodajZamowienie, START)
  const [pozycje, setPozycje] = useState<Pozycja[]>([])
  const [frazaP, setFrazaP] = useState('')
  const [wynikiP, setWynikiP] = useState<ProduktWyniku[] | null>(null)
  const [bladP, setBladP] = useState<string | null>(null)
  const [frazaK, setFrazaK] = useState('')
  const [wynikiK, setWynikiK] = useState<KlientWyniku[] | null>(null)
  const [bladK, setBladK] = useState<string | null>(null)
  const [klient, setKlient] = useState<DaneKlientaWe>({ kraj: 'PL' })
  const [przewoznik, setPrzewoznik] = useState('')
  const [koszt, setKoszt] = useState('')
  const [szukanie, startSzukania] = useTransition()

  const ustaw = (p: PoleKlienta, v: string) => setKlient((k) => ({ ...k, [p]: v }))
  const szukajP = () =>
    startSzukania(async () => {
      const r = await szukajProduktowNowe(frazaP)
      setWynikiP(r.produkty)
      setBladP(r.blad)
    })
  const szukajK = () =>
    startSzukania(async () => {
      const r = await szukajKlientowNowe(frazaK)
      setWynikiK(r.klienci)
      setBladK(r.blad)
    })
  const dodaj = (p: ProduktWyniku) => {
    setPozycje((l) => (l.some((x) => x.p.id === p.id) ? l : [...l, { p, ilosc: '1', cena: p.cena === null ? '' : p.cena.toFixed(2).replace('.', ',') }]))
  }
  const zmien = (id: string, pole: 'ilosc' | 'cena', v: string) => setPozycje((l) => l.map((x) => (x.p.id === id ? { ...x, [pole]: v } : x)))
  const usun = (id: string) => setPozycje((l) => l.filter((x) => x.p.id !== id))
  const suma = pozycje.reduce((s, x) => s + Math.round(liczba(x.cena) * 100) * Math.max(0, Math.trunc(liczba(x.ilosc))), 0) / 100 + liczba(koszt)
  const nazwaPrzewoznika = props.przewoznicy.find((p) => p.carrier === przewoznik)?.nazwa ?? ''

  return (
    <form action={akcja} noValidate aria-label="Dodaj zamówienie" className="stack">
      <input type="hidden" name="numer" value={props.numer} />
      <input type="hidden" name="sposob_domyslny" value={nazwaPrzewoznika} />
      {stan.blad && (
        <div className="banner red" role="alert" id="nz-blad">
          <div>
            <b>Nie zapisano.</b> {stan.blad}
          </div>
        </div>
      )}

      <section className="card" aria-labelledby="h-nz-prod">
        <div className="card-head">
          <h2 id="h-nz-prod">Produkty</h2>
          <span className="muted small">Z katalogu firmy; dostępne = na stanie minus zarezerwowane</span>
        </div>
        <div className="np-fields">
          <div className="field">
            <label htmlFor="nz-fraza-p">Szukaj produktu (SKU, nazwa albo EAN)</label>
            <input
              className="input"
              id="nz-fraza-p"
              value={frazaP}
              maxLength={100}
              autoComplete="off"
              onChange={(e) => setFrazaP(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  szukajP()
                }
              }}
            />
          </div>
          <div className="np-actions">
            <button type="button" className="btn" onClick={szukajP} disabled={szukanie}>
              {szukanie ? 'Szukam…' : 'Szukaj'}
            </button>
          </div>
        </div>
        {bladP && <p className="small muted">{bladP}</p>}
        {wynikiP && !wynikiP.length && !bladP && <p className="small muted">Nic nie znaleziono.</p>}
        {wynikiP && wynikiP.length > 0 && (
          <table className="tbl cards" aria-label="Znalezione produkty">
            <thead>
              <tr>
                <th>Produkt</th>
                <th className="right">Dostępne</th>
                <th className="right">Cena</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {wynikiP.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.nazwa}
                    <span className="sub mono">{p.sku}</span>
                  </td>
                  <td className="right">{p.bezStanu ? 'bez stanu' : p.dostepne}</td>
                  <td className="right">{p.cena === null ? '—' : zl(p.cena)}</td>
                  <td className="right">
                    <button type="button" className="btn" onClick={() => dodaj(p)} disabled={pozycje.some((x) => x.p.id === p.id)}>
                      {pozycje.some((x) => x.p.id === p.id) ? 'Na liście' : 'Dodaj'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h3 className="lbl">W zamówieniu</h3>
        {!pozycje.length ? (
          <p className="small muted">Jeszcze nic: wyszukaj produkt i kliknij „Dodaj”.</p>
        ) : (
          <table className="tbl cards" aria-label="Pozycje zamówienia">
            <thead>
              <tr>
                <th>Produkt</th>
                <th>Ilość</th>
                <th>Cena brutto za szt.</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pozycje.map((x, i) => {
                const ile = Math.trunc(liczba(x.ilosc))
                const brak = x.p.dostepne !== null && ile > x.p.dostepne ? ile - x.p.dostepne : 0
                return (
                  <tr key={x.p.id}>
                    <td>
                      <input type="hidden" name="poz_id" value={x.p.id} />
                      {x.p.nazwa}
                      <span className="sub mono">{x.p.sku}</span>
                      {brak > 0 && <span className="sub">Na stanie {x.p.dostepne}: zabraknie {brak}, ta część trafi do „Brakuje” i poczeka na dostawę.</span>}
                    </td>
                    <td>
                      <label className="sr" htmlFor={`nz-il-${i}`}>
                        Ilość: {x.p.nazwa}
                      </label>
                      <input className="input num" id={`nz-il-${i}`} name="poz_ilosc" inputMode="numeric" value={x.ilosc} onChange={(e) => zmien(x.p.id, 'ilosc', e.target.value)} />
                    </td>
                    <td>
                      <label className="sr" htmlFor={`nz-cena-${i}`}>
                        Cena brutto: {x.p.nazwa}
                      </label>
                      <input className="input num" id={`nz-cena-${i}`} name="poz_cena" inputMode="decimal" value={x.cena} onChange={(e) => zmien(x.p.id, 'cena', e.target.value)} />
                    </td>
                    <td className="right">
                      <button type="button" className="btn" onClick={() => usun(x.p.id)}>
                        Usuń
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="card" aria-labelledby="h-nz-klient">
        <div className="card-head">
          <h2 id="h-nz-klient">Klient</h2>
          <span className="muted small">Opcjonalnie; dane zapisują się zaszyfrowane, jak przy zamówieniach ze sklepu</span>
        </div>
        {!props.mozeKlient ? (
          <p className="small muted">Dane klienta wpisuje osoba z uprawnieniem do danych klienta (Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia). Zamówienie zapiszesz bez nich, a dane uzupełni ktoś na karcie zamówienia.</p>
        ) : (
          <>
            <div className="np-fields">
              <div className="field">
                <label htmlFor="nz-fraza-k">Szukaj klienta z wcześniejszych zamówień (część nazwy, firmy, e-maila, telefonu albo NIP-u)</label>
                <input
                  className="input"
                  id="nz-fraza-k"
                  value={frazaK}
                  maxLength={120}
                  autoComplete="off"
                  onChange={(e) => setFrazaK(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      szukajK()
                    }
                  }}
                />
              </div>
              <div className="np-actions">
                <button type="button" className="btn" onClick={szukajK} disabled={szukanie}>
                  {szukanie ? 'Szukam…' : 'Szukaj klienta'}
                </button>
              </div>
            </div>
            {bladK && <p className="small muted">{bladK}</p>}
            {wynikiK && !wynikiK.length && !bladK && <p className="small muted">Nie znaleziono: wpisz dane nowego klienta niżej.</p>}
            {wynikiK && wynikiK.length > 0 && (
              <ul className="plain" aria-label="Znalezieni klienci">
                {wynikiK.map((k, i) => (
                  <li key={i} className="actions">
                    <span>{k.opis}</span>
                    <button type="button" className="btn" onClick={() => setKlient({ ...k.pola })}>
                      Wybierz
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="np-fields">
              <Pole nazwa="imie" etykieta="Imię i nazwisko" klient={klient} ustaw={ustaw} auto="name" />
              <Pole nazwa="firma" etykieta="Firma" klient={klient} ustaw={ustaw} auto="organization" />
              <Pole nazwa="email" etykieta="E-mail" klient={klient} ustaw={ustaw} typ="email" auto="email" />
              <Pole nazwa="telefon" etykieta="Telefon" klient={klient} ustaw={ustaw} typ="tel" max={30} auto="tel" />
              <Pole nazwa="ulica" etykieta="Ulica" klient={klient} ustaw={ustaw} />
              <Pole nazwa="dom" etykieta="Numer domu" klient={klient} ustaw={ustaw} max={20} />
              <Pole nazwa="lokal" etykieta="Numer lokalu" klient={klient} ustaw={ustaw} max={20} />
              <Pole nazwa="kod" etykieta="Kod pocztowy (NN-NNN)" klient={klient} ustaw={ustaw} max={10} />
              <Pole nazwa="miasto" etykieta="Miasto" klient={klient} ustaw={ustaw} />
              <Pole nazwa="kraj" etykieta="Kraj (np. PL)" klient={klient} ustaw={ustaw} max={2} />
            </div>
            <h3 className="lbl">Dane do faktury (gdy klient chce fakturę na firmę)</h3>
            <div className="np-fields">
              <Pole nazwa="f_nazwa" etykieta="Nazwa do faktury" klient={klient} ustaw={ustaw} />
              <Pole nazwa="f_nip" etykieta="NIP" klient={klient} ustaw={ustaw} max={20} />
              <Pole nazwa="f_ulica" etykieta="Ulica i numer" klient={klient} ustaw={ustaw} />
              <Pole nazwa="f_kod" etykieta="Kod pocztowy" klient={klient} ustaw={ustaw} max={10} />
              <Pole nazwa="f_miasto" etykieta="Miasto" klient={klient} ustaw={ustaw} />
            </div>
            <label className="checkrow">
              <input type="checkbox" name="chce_fakture" value="tak" />
              Faktura na firmę (z NIP-em)
            </label>
          </>
        )}
      </section>

      <section className="card" aria-labelledby="h-nz-dost">
        <div className="card-head">
          <h2 id="h-nz-dost">Dostawa i płatność</h2>
        </div>
        <div className="np-fields">
          <div className="field">
            <label htmlFor="nz-przewoznik">Sposób dostawy</label>
            <select className="input" id="nz-przewoznik" name="przewoznik" required value={przewoznik} onChange={(e) => setPrzewoznik(e.target.value)}>
              <option value="" disabled>
                wybierz…
              </option>
              {/* paczkomat wymaga punktu odbioru, a ten zapisuje się z danymi klienta */}
              {props.przewoznicy.filter((p) => props.mozeKlient || p.carrier !== 'PACZKOMATY').map((p) => (
                <option key={p.carrier} value={p.carrier}>
                  {p.nazwa}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="nz-sposob">Opis dostawy (opcjonalnie, np. „Kurier DPD na paletę”)</label>
            <input className="input" id="nz-sposob" name="sposob" maxLength={200} autoComplete="off" />
          </div>
          {props.mozeKlient && (
            <>
              <Pole nazwa="punkt" etykieta={przewoznik === 'PACZKOMATY' ? 'Kod paczkomatu (wymagany, np. POZ01M)' : 'Punkt odbioru: kod (opcjonalnie)'} klient={klient} ustaw={ustaw} max={40} />
              <Pole nazwa="punkt_nazwa" etykieta="Punkt odbioru: nazwa (opcjonalnie)" klient={klient} ustaw={ustaw} />
            </>
          )}
          <div className="field">
            <label htmlFor="nz-koszt">Koszt wysyłki brutto (opcjonalnie)</label>
            <input className="input num" id="nz-koszt" name="koszt" inputMode="decimal" value={koszt} onChange={(e) => setKoszt(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="nz-zrodlo">Źródło zamówienia (opcjonalnie)</label>
            <input className="input" id="nz-zrodlo" name="zrodlo" maxLength={80} list="nz-zrodla" autoComplete="off" />
            <datalist id="nz-zrodla">
              <option value="Telefon" />
              <option value="Osobiście" />
              <option value="E-mail" />
              <option value="Hurt" />
            </datalist>
          </div>
        </div>
        <fieldset className="stack">
          <legend className="lbl">Płatność</legend>
          <label className="checkrow">
            <input type="radio" name="platnosc" value="oplacone" required /> Opłacone (towar od razu do realizacji)
          </label>
          <label className="checkrow">
            <input type="radio" name="platnosc" value="pobranie" /> Za pobraniem (do realizacji, klient płaci kurierowi)
          </label>
          <label className="checkrow">
            <input type="radio" name="platnosc" value="przelew" /> Przelew do zapłaty (towar zarezerwowany, czeka na wpłatę)
          </label>
        </fieldset>
        {props.mozeKlient && (
          <div className="field">
            <label htmlFor="nz-uwagi">Uwagi klienta (opcjonalnie, zapisują się razem z danymi klienta)</label>
            <textarea className="input" id="nz-uwagi" name="uwagi" maxLength={1000} rows={3} value={klient.uwagi ?? ''} onChange={(e) => ustaw('uwagi', e.target.value)} />
          </div>
        )}
      </section>

      <div className="np-actions">
        <button className="btn primary" type="submit" disabled={wysylanie || !pozycje.length} aria-describedby={stan.blad ? 'nz-blad' : undefined}>
          {wysylanie ? 'Zapisywanie…' : 'Dodaj zamówienie'}
        </button>
        <span className="small">Razem: {zl(suma)}</span>
        <span className="small muted">Zamówienie od razu rezerwuje towar i idzie zwykłą ścieżką: zbieranie, pakowanie, wysyłka.</span>
      </div>
    </form>
  )
}
