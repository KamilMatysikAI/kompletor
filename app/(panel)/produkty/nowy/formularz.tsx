'use client'
// Formularze „Dodaj produkt”. `FormularzProduktu`: produkt od zera (albo z danymi pobranymi
// z oferty sklepu / BaseLinkera), sekcje jak w karcie produktu BaseLinkera: podstawowe, ceny i podatek, magazyn,
// wysyłka, zestaw, opis i zdjęcia. `FormularzDodania`: ścieżka wFirmy (pola z wFirmy tylko do odczytu, reszta jak wyżej).
// Walidacja po stronie serwera (lib/produkty/karta.ts, lib/produkty/walidacja.ts); tu tylko wygoda (netto na żywo).
import Link from 'next/link'
import { useActionState, useState, useTransition } from 'react'
import { dodajProdukt, podpowiedzOpisu, zapiszNowyProdukt } from './akcje'
import type { StanDodania } from './stan'

const START: StanDodania = { error: null, field: null }

export const VAT_OPCJE: [string, string][] = [
  ['23', '23%'],
  ['8', '8%'],
  ['5', '5%'],
  ['0', '0%'],
  ['zw', 'zw. (zwolniony)'],
  ['np', 'np. (nie podlega)'],
]

export interface DomyslneProduktu {
  rodzaj?: 'zwykly' | 'bez-stanu' | 'zestaw'
  sku?: string
  nazwa?: string
  ean?: string
  cena?: string
  vat?: string
  stan?: string
  opis?: string
}

export interface OpcjaSkladnika {
  id: string
  label: string
  unit: 'SZT' | 'KG'
}

function Blad({ state }: { state: StanDodania }) {
  if (!state.error) return null
  return (
    <div className="banner red" role="alert" id="dodaj-blad">
      <div>
        <b>Nie dodano.</b> {state.error}
        {state.istniejacyId && (
          <>
            {' '}
            <Link href={`/produkty/${state.istniejacyId}`}>Przejdź do tego produktu</Link>
          </>
        )}
      </div>
    </div>
  )
}

const inv = (state: StanDodania, f: string) => (state.field === f ? { 'aria-invalid': true as const, 'aria-describedby': 'dodaj-blad' } : {})

function netto(cena: string, vat: string): string {
  const b = Number(cena.replace(',', '.'))
  if (!cena.trim() || !Number.isFinite(b)) return '—'
  const r = Number(vat)
  const n = Number.isFinite(r) && vat !== '' ? b / (1 + r / 100) : b
  return `${n.toFixed(2).replace('.', ',')} zł`
}

/** Sekcje wspólne: magazyn (lokalizacja, próg), wysyłka, opis z podpowiedzią AI i zdjęcia. */
function PolaWlasne(props: { state: StanDodania; stan: boolean; opis?: string; nazwa: () => string; sku: string; ai: boolean; rodzaj: string; lokalizacjaWMagazynie?: boolean }) {
  const [opis, setOpis] = useState(props.opis ?? '')
  const [aiMsg, setAiMsg] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const ai = () =>
    start(async () => {
      setAiMsg(null)
      const r = await podpowiedzOpisu({ title: props.nazwa(), sku: props.sku, rodzaj: props.rodzaj, opis })
      if (r.opis) setOpis(r.opis)
      else setAiMsg(r.error ?? 'Nie udało się.')
    })
  return (
    <>
      {props.stan && props.lokalizacjaWMagazynie !== false && (
        <div className="np-fields pr-mt">
          <div className="field">
            <label htmlFor="np-lok">Lokalizacja na półce (opcjonalnie)</label>
            <input className="input mono" id="np-lok" name="lokalizacja" maxLength={60} placeholder="np. A-1-2" {...inv(props.state, 'lokalizacja')} />
          </div>
          <div className="field">
            <label htmlFor="np-prog">Próg niskiego stanu (opcjonalnie)</label>
            <input className="input" id="np-prog" name="prog" inputMode="numeric" {...inv(props.state, 'prog')} />
          </div>
        </div>
      )}
      <h3 className="pr-h">Wysyłka</h3>
      <div className="grid g4">
        <div className="field">
          <label htmlFor="np-waga">Waga (g)</label>
          <input className="input" id="np-waga" name="waga" inputMode="numeric" placeholder="np. 420" {...inv(props.state, 'waga')} />
        </div>
        <div className="field">
          <label htmlFor="np-dl">Długość (cm)</label>
          <input className="input" id="np-dl" name="dlugosc" inputMode="decimal" {...inv(props.state, 'dlugosc')} />
        </div>
        <div className="field">
          <label htmlFor="np-sz">Szerokość (cm)</label>
          <input className="input" id="np-sz" name="szerokosc" inputMode="decimal" {...inv(props.state, 'szerokosc')} />
        </div>
        <div className="field">
          <label htmlFor="np-wys">Wysokość (cm)</label>
          <input className="input" id="np-wys" name="wysokosc" inputMode="decimal" {...inv(props.state, 'wysokosc')} />
        </div>
      </div>
      <h3 className="pr-h">Opis i zdjęcia</h3>
      <div className="field">
        <label htmlFor="np-opis">Opis (opcjonalnie)</label>
        <textarea className="input pr-opis" id="np-opis" name="opis" rows={5} maxLength={20000} value={opis} onChange={(e) => setOpis(e.target.value)} {...inv(props.state, 'opis')} />
      </div>
      <div className="np-actions pr-ai">
        <button className="btn small" type="button" onClick={ai} disabled={pending || !props.ai} aria-describedby="np-ai-info">
          {pending ? 'Piszę opis…' : 'Podpowiedz opis (AI)'}
        </button>
        <span className="muted small" id="np-ai-info" role="status">
          {aiMsg ?? (props.ai ? 'Propozycja wpada do pola opisu; zapisujesz ją sam.' : 'Wymaga dostawcy AI: ustawia go administrator instalacji (Pomoc → Konfiguracja).')}
        </span>
      </div>
      <div className="field">
        <label htmlFor="np-zdj">Zdjęcia (JPG, PNG, WEBP, do 15 MB każde; pierwsze = główne)</label>
        <input className="input" id="np-zdj" name="zdjecia" type="file" multiple accept="image/jpeg,image/png,image/webp" {...inv(props.state, 'zdjecia')} />
      </div>
    </>
  )
}

export function FormularzProduktu(props: { d: DomyslneProduktu; hasWfirma: boolean; ai: boolean; skladniki: OpcjaSkladnika[]; zrodlo: { typ: 'KANAL' | 'BL'; ref: string; opis: string } | null }) {
  const [state, action, pending] = useActionState(zapiszNowyProdukt, START)
  const [rodzaj, setRodzaj] = useState<'zwykly' | 'bez-stanu' | 'zestaw'>(props.d.rodzaj ?? (props.hasWfirma ? 'bez-stanu' : 'zwykly'))
  const [cena, setCena] = useState(props.d.cena ?? '')
  const [vat, setVat] = useState(props.d.vat ?? '')
  const [nazwa, setNazwa] = useState(props.d.nazwa ?? '')
  const [sku, setSku] = useState(props.d.sku ?? '')
  const [unit, setUnit] = useState<'SZT' | 'KG'>('SZT')
  const [wiersze, setWiersze] = useState<number[]>([0])
  const RODZAJE: [typeof rodzaj, string][] = [
    ['zwykly', 'Towar ze stanem'],
    ['bez-stanu', 'Bez stanu (e-book, usługa)'],
    ['zestaw', 'Zestaw z innych produktów'],
  ]
  return (
    <form action={action} noValidate aria-label="Dodaj produkt" className="stack">
      <input type="hidden" name="rodzaj" value={rodzaj} />
      {props.zrodlo && (
        <>
          <input type="hidden" name="zrodloTyp" value={props.zrodlo.typ} />
          <input type="hidden" name="zrodloRef" value={props.zrodlo.ref} />
        </>
      )}
      <Blad state={state} />

      <section className="card" aria-labelledby="h-podst">
        <div className="card-head">
          <h2 id="h-podst">Produkt</h2>
          {props.zrodlo && <span className="chip leaf">dane z: {props.zrodlo.opis}</span>}
        </div>
        <div className="field">
          <span className="lbl" id="np-rodzaj-l">
            Rodzaj
          </span>
          <div className="seg seg-pion" role="group" aria-labelledby="np-rodzaj-l">
            {RODZAJE.map(([k, label]) => (
              <button key={k} type="button" aria-pressed={rodzaj === k} onClick={() => setRodzaj(k)} disabled={k === 'zwykly' && props.hasWfirma}>
                {label}
              </button>
            ))}
          </div>
          {props.hasWfirma && <span className="muted small">Twoja firma prowadzi stany w wFirmie: towar ze stanem pobierz przyciskiem „Pobierz z wFirmy” wyżej.</span>}
        </div>
        <div className="np-fields pr-mt">
          <div className="field">
            <label htmlFor="np-nazwa">Nazwa (wymagana, z niej faktura i karta zbierania)</label>
            <input className="input" id="np-nazwa" name="nazwa" value={nazwa} onChange={(e) => setNazwa(e.target.value)} maxLength={200} required {...inv(state, 'nazwa')} />
          </div>
          <div className="field">
            <label htmlFor="np-sku">SKU (wymagane, unikalne w firmie)</label>
            <input className="input mono" id="np-sku" name="sku" value={sku} onChange={(e) => setSku(e.target.value)} maxLength={64} required placeholder="np. kod z Twojego sklepu" autoComplete="off" {...inv(state, 'sku')} />
          </div>
          <div className="field">
            <label htmlFor="np-ean">EAN (opcjonalnie)</label>
            <input className="input mono" id="np-ean" name="ean" defaultValue={props.d.ean} inputMode="numeric" maxLength={20} {...inv(state, 'ean')} />
          </div>
        </div>
      </section>

      <section className="card" aria-labelledby="h-ceny">
        <h2 id="h-ceny">Ceny i podatek</h2>
        <div className="grid g4 pr-mt">
          <div className="field">
            <label htmlFor="np-cena">Cena sprzedaży brutto (zł)</label>
            <input className="input" id="np-cena" name="cena" inputMode="decimal" value={cena} onChange={(e) => setCena(e.target.value)} {...inv(state, 'cena')} />
          </div>
          <div className="field">
            <label htmlFor="np-vat">Stawka VAT</label>
            <select className="input" id="np-vat" name="vat" value={vat} onChange={(e) => setVat(e.target.value)} {...inv(state, 'vat')}>
              <option value="">— wybierz —</option>
              {VAT_OPCJE.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <span className="lbl">Cena netto</span>
            <output className="input" aria-live="polite">
              {netto(cena, vat)}
            </output>
          </div>
          <div className="field">
            <label htmlFor="np-zakup">Cena zakupu netto (opcjonalnie)</label>
            <input className="input" id="np-zakup" name="cenaZakupu" inputMode="decimal" {...inv(state, 'cenaZakupu')} />
          </div>
        </div>
      </section>

      {rodzaj === 'zwykly' && (
        <section className="card" aria-labelledby="h-mag">
          <h2 id="h-mag">Magazyn</h2>
          <div className="np-fields pr-mt">
            <div className="field">
              <label htmlFor="np-jedn">Jednostka</label>
              <select className="input" id="np-jedn" name="jednostka" value={unit} onChange={(e) => setUnit(e.target.value === 'KG' ? 'KG' : 'SZT')}>
                <option value="SZT">sztuki</option>
                <option value="KG">kilogramy (na wagę)</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="np-stan">Stan początkowy ({unit === 'KG' ? 'kg' : 'szt.'})</label>
              <input className="input" id="np-stan" name="stan" inputMode="decimal" defaultValue={props.d.stan ?? '0'} {...inv(state, 'stan')} />
            </div>
          </div>
        </section>
      )}

      {rodzaj === 'zestaw' && (
        <section className="card" aria-labelledby="h-skl">
          <div className="card-head">
            <h2 id="h-skl">Skład zestawu</h2>
            <span className="muted small">Zestaw rezerwuje składniki; ilość w sztukach (towar na wagę: w gramach)</span>
          </div>
          {props.skladniki.length === 0 ? (
            <p className="muted small">Najpierw dodaj towary ze stanem: zestaw składa się z nich.</p>
          ) : (
            <>
              <p className="muted small" style={{ margin: 0 }}>
                Udział w cenie (%) mówi, jaka część ceny zestawu przypada na składnik na fakturze. Zostaw puste, podzielimy po cenach składników.
              </p>
              {wiersze.map((w, i) => (
                <div className="pr-skl" key={w}>
                  <div className="field">
                    <label htmlFor={`np-s-${w}`}>Składnik {i + 1}</label>
                    <select className="input" id={`np-s-${w}`} name="skladnik" defaultValue="" {...inv(state, 'sklad')}>
                      <option value="">— wybierz produkt —</option>
                      {props.skladniki.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor={`np-q-${w}`}>Ilość</label>
                    <input className="input" id={`np-q-${w}`} name="ilosc" inputMode="numeric" defaultValue="1" />
                  </div>
                  <div className="field">
                    <label htmlFor={`np-u-${w}`}>Udział w cenie (%)</label>
                    <input className="input" id={`np-u-${w}`} name="udzial" inputMode="decimal" placeholder="puste = po cenach" />
                  </div>
                  {wiersze.length > 1 && (
                    <button className="btn ghost small" type="button" onClick={() => setWiersze(wiersze.filter((x) => x !== w))} aria-label={`Usuń składnik ${i + 1}`}>
                      Usuń
                    </button>
                  )}
                </div>
              ))}
              <div className="np-actions">
                <button className="btn small" type="button" onClick={() => setWiersze([...wiersze, Math.max(...wiersze) + 1])}>
                  + Dodaj składnik
                </button>
                <span className="muted small">Udział puste = cena dzielona proporcjonalnie do cen składników.</span>
              </div>
            </>
          )}
        </section>
      )}

      <section className="card" aria-labelledby="h-wiecej">
        <h2 id="h-wiecej">{rodzaj === 'zwykly' ? 'Półka, wysyłka, opis i zdjęcia' : 'Wysyłka, opis i zdjęcia'}</h2>
        <PolaWlasne state={state} stan={rodzaj === 'zwykly'} opis={props.d.opis} nazwa={() => nazwa} sku={sku} ai={props.ai} rodzaj={rodzaj} />
      </section>

      <div className="np-actions">
        <button className="btn primary" type="submit" disabled={pending}>
          {pending ? 'Zapisywanie…' : 'Utwórz produkt'}
        </button>
        <Link className="btn ghost" href="/produkty">
          Anuluj
        </Link>
      </div>
    </form>
  )
}

/** Ścieżka wFirmy: SKU sprawdzone wcześniej, nazwa i EAN do poprawienia, pola własne jak w formularzu produktu. */
export function FormularzDodania(props: { sku: string; rodzaj: 'wfirma' | 'bez-stanu'; nazwa: string; ean: string; nazwaWymagana: boolean; przycisk: string; stan?: boolean; ai?: boolean }) {
  const [state, action, pending] = useActionState(dodajProdukt, START)
  const [nazwa, setNazwa] = useState(props.nazwa)
  return (
    <form action={action} noValidate aria-label="Dodaj produkt" className="stack">
      <input type="hidden" name="sku" value={props.sku} />
      <input type="hidden" name="rodzaj" value={props.rodzaj} />
      <Blad state={state} />
      <div className="np-fields">
        <div className="field">
          <label htmlFor="np-nazwa">Nazwa w panelu{props.nazwaWymagana ? ' (wymagana, z niej faktura)' : ''}</label>
          <input className="input" id="np-nazwa" name="nazwa" value={nazwa} onChange={(e) => setNazwa(e.target.value)} maxLength={200} required={props.nazwaWymagana} {...inv(state, 'title')} />
        </div>
        <div className="field">
          <label htmlFor="np-ean">EAN (opcjonalnie)</label>
          <input className="input mono" id="np-ean" name="ean" defaultValue={props.ean} inputMode="numeric" maxLength={20} {...inv(state, 'ean')} />
        </div>
      </div>
      <details className="pr-more">
        <summary className="btn small">Półka, wysyłka, opis i zdjęcia (opcjonalnie)</summary>
        <PolaWlasne state={state} stan={!!props.stan} nazwa={() => nazwa} sku={props.sku} ai={!!props.ai} rodzaj={props.rodzaj === 'bez-stanu' ? 'bez stanu' : 'towar'} />
      </details>
      <div className="np-actions">
        <button className="btn primary" type="submit" disabled={pending}>
          {pending ? 'Zapisywanie…' : props.przycisk}
        </button>
      </div>
    </form>
  )
}
