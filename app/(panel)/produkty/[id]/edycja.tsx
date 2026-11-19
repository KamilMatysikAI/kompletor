'use client'
// Karta produktu → edycja danych i składu zestawu. Przy produkcie z wFirmy ceny, VAT i nazwa księgowa są
// tylko do odczytu (zmienia się je w wFirmie); reszta edytowalna. Zapis z komunikatem „Zapisano” (bez przeładowania).
import Link from 'next/link'
import { useActionState, useState, useTransition } from 'react'
import { VAT_OPCJE } from '../nowy/formularz'
import { podpowiedzOpisKarty, zapiszKarte, zapiszSklad, type StanKarty } from './produkt-akcje'

const START: StanKarty = { ok: false, error: null, field: null }

export interface DaneKarty {
  id: string
  sku: string
  kind: 'STOCKED' | 'BUNDLE' | 'DIGITAL'
  unit: 'SZT' | 'KG'
  zWfirmy: boolean
  /** SKU poprawialne w panelu (produkt dodany w panelu, z oferty albo z CSV); z wFirmy i BL tylko do odczytu. */
  skuEdytowalne: boolean
  /** Skąd SKU, gdy tylko do odczytu (np. „z wFirmy, zmieniasz w wFirmie”). */
  skuGdzie: string | null
  title: string
  nameAccounting: string
  ean: string
  opis: string
  cena: string
  vat: string
  cenaZakupu: string
  netto: string
  waga: string
  dlugosc: string
  szerokosc: string
  wysokosc: string
  prog: string
  lokalizacja: string
  /** grupa wariantów (pusta = bez grupy); przy BL i wFirmie tylko do odczytu */
  grupa: string
  maStan: boolean
}

function Komunikat({ state, ok }: { state: StanKarty; ok: string }) {
  if (state.error)
    return (
      <div className="banner red" role="alert" id="karta-blad">
        <div>
          <b>Nie zapisano.</b> {state.error}
          {state.istniejacyId && (
            <>
              {' '}
              <Link href={`/produkty/${state.istniejacyId}`}>Otwórz produkt z tym SKU</Link>
            </>
          )}
        </div>
      </div>
    )
  if (state.ok)
    return (
      <>
        <div className="banner leaf-soft" role="status">
          <div>{state.zmiany ? ok : 'Bez zmian.'}</div>
        </div>
        {state.uwagi?.map((u) => (
          <div key={u} className="banner amber" role="status">
            <div>{u}</div>
          </div>
        ))}
      </>
    )
  return null
}

const inv = (state: StanKarty, f: string) => (state.field === f ? { 'aria-invalid': true as const, 'aria-describedby': 'karta-blad' } : {})

export function EdycjaKarty({ d, canEdit, ai }: { d: DaneKarty; canEdit: boolean; ai: boolean }) {
  const [state, action, pending] = useActionState(zapiszKarte, START)
  const [opis, setOpis] = useState(d.opis)
  const [nazwa, setNazwa] = useState(d.title)
  const [aiMsg, setAiMsg] = useState<string | null>(null)
  const [aiPending, start] = useTransition()
  const ro = !canEdit
  const roHandlowe = ro || d.zWfirmy
  const podpowiedz = () =>
    start(async () => {
      setAiMsg(null)
      const r = await podpowiedzOpisKarty({ title: nazwa, sku: d.sku, ean: d.ean, rodzaj: d.kind === 'BUNDLE' ? 'zestaw' : d.kind === 'DIGITAL' ? 'bez stanu' : 'towar', opis })
      if (r.opis) setOpis(r.opis)
      else setAiMsg(r.error ?? 'Nie udało się.')
    })
  return (
    <form action={action} noValidate aria-label="Dane produktu" className="stack">
      <input type="hidden" name="produkt" value={d.id} />
      <Komunikat state={state} ok="Zapisano. Zmiana jest w historii produktu." />
      <div className="np-fields">
        <div className="field">
          <label htmlFor="k-sku">SKU{d.skuEdytowalne ? ' (kod produktu, po nim łączą się oferty sklepów)' : d.skuGdzie ? ` (${d.skuGdzie})` : ''}</label>
          <input className="input mono" id="k-sku" {...(d.skuEdytowalne && !ro ? { name: 'sku' } : {})} defaultValue={d.sku} maxLength={64} readOnly={ro || !d.skuEdytowalne} {...inv(state, 'sku')} />
        </div>
      </div>
      <div className="np-fields">
        <div className="field">
          <label htmlFor="k-nazwa">Nazwa{d.zWfirmy ? ' w panelu' : ' (z niej faktura i karta zbierania)'}</label>
          <input className="input" id="k-nazwa" name="nazwa" value={nazwa} onChange={(e) => setNazwa(e.target.value)} maxLength={200} readOnly={ro} {...inv(state, 'nazwa')} />
        </div>
        <div className="field">
          <label htmlFor="k-ean">EAN</label>
          <input className="input mono" id="k-ean" name="ean" defaultValue={d.ean} inputMode="numeric" maxLength={20} readOnly={ro} {...inv(state, 'ean')} />
        </div>
      </div>
      {d.zWfirmy && (
        <p className="muted small">
          Nazwa na fakturze (z wFirmy): <b>{d.nameAccounting}</b>
        </p>
      )}
      <h3 className="pr-h">Ceny i podatek{d.zWfirmy ? ' (z wFirmy, zmieniasz w wFirmie)' : ''}</h3>
      <div className="grid g4">
        <div className="field">
          <label htmlFor="k-cena">Cena brutto (zł)</label>
          <input className="input" id="k-cena" {...(roHandlowe ? {} : { name: 'cena' })} defaultValue={d.cena} inputMode="decimal" readOnly={roHandlowe} {...inv(state, 'cena')} />
        </div>
        <div className="field">
          <label htmlFor="k-vat">Stawka VAT</label>
          {roHandlowe ? (
            <input className="input" id="k-vat" readOnly value={d.vat ? (VAT_OPCJE.find(([v]) => v === d.vat)?.[1] ?? d.vat) : '—'} />
          ) : (
            <select className="input" id="k-vat" name="vat" defaultValue={d.vat} {...inv(state, 'vat')}>
              <option value="">— brak —</option>
              {VAT_OPCJE.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="field">
          <span className="lbl">Cena netto</span>
          <output className="input">{d.netto}</output>
        </div>
        <div className="field">
          <label htmlFor="k-zakup">Cena zakupu netto</label>
          <input className="input" id="k-zakup" {...(roHandlowe ? {} : { name: 'cenaZakupu' })} defaultValue={d.cenaZakupu} inputMode="decimal" readOnly={roHandlowe} {...inv(state, 'cenaZakupu')} />
        </div>
      </div>
      {d.kind === 'STOCKED' && (
        <>
          <h3 className="pr-h">Magazyn</h3>
          <div className="np-fields">
            <div className="field">
              <label htmlFor="k-lok">Lokalizacja na półce</label>
              <input className="input mono" id="k-lok" {...(d.maStan ? { name: 'lokalizacja' } : {})} defaultValue={d.lokalizacja} maxLength={60} readOnly={ro || !d.maStan} placeholder={d.maStan ? 'np. A-1-2' : 'po pierwszym stanie'} {...inv(state, 'lokalizacja')} />
            </div>
            <div className="field">
              <label htmlFor="k-prog">Próg niskiego stanu ({d.unit === 'KG' ? 'g' : 'szt.'})</label>
              <input className="input" id="k-prog" name="prog" defaultValue={d.prog} inputMode="numeric" readOnly={ro} {...inv(state, 'prog')} />
            </div>
          </div>
        </>
      )}
      <h3 className="pr-h">Warianty</h3>
      <div className="np-fields">
        <div className="field">
          <label htmlFor="k-grupa">Grupa wariantów</label>
          <input
            className="input mono"
            id="k-grupa"
            {...(d.skuEdytowalne ? { name: 'grupa' } : {})}
            defaultValue={d.grupa}
            maxLength={64}
            readOnly={ro || !d.skuEdytowalne}
            placeholder="np. KUBEK-2026"
            aria-describedby="k-grupa-pom"
            {...inv(state, 'grupa')}
          />
          <span className="muted small" id="k-grupa-pom">
            {d.skuEdytowalne ? 'Ten sam tekst w kilku produktach łączy je w warianty (rozmiary, kolory). Puste = produkt bez wariantów.' : `Grupa przychodzi ${d.skuGdzie ?? 'z importu'}.`}
          </span>
        </div>
      </div>
      {d.kind !== 'DIGITAL' && (
        <>
          <h3 className="pr-h">Wysyłka</h3>
          <div className="grid g4">
            <div className="field">
              <label htmlFor="k-waga">Waga (g)</label>
              <input className="input" id="k-waga" name="waga" defaultValue={d.waga} inputMode="numeric" placeholder="np. 420" readOnly={ro} {...inv(state, 'waga')} />
            </div>
            <div className="field">
              <label htmlFor="k-dl">Długość (cm)</label>
              <input className="input" id="k-dl" name="dlugosc" defaultValue={d.dlugosc} inputMode="decimal" readOnly={ro} {...inv(state, 'dlugosc')} />
            </div>
            <div className="field">
              <label htmlFor="k-sz">Szerokość (cm)</label>
              <input className="input" id="k-sz" name="szerokosc" defaultValue={d.szerokosc} inputMode="decimal" readOnly={ro} {...inv(state, 'szerokosc')} />
            </div>
            <div className="field">
              <label htmlFor="k-wys">Wysokość (cm)</label>
              <input className="input" id="k-wys" name="wysokosc" defaultValue={d.wysokosc} inputMode="decimal" readOnly={ro} {...inv(state, 'wysokosc')} />
            </div>
          </div>
        </>
      )}
      <h3 className="pr-h">Opis</h3>
      <div className="field">
        <label htmlFor="k-opis">Opis produktu</label>
        <textarea className="input pr-opis" id="k-opis" name="opis" rows={5} maxLength={20000} value={opis} onChange={(e) => setOpis(e.target.value)} readOnly={ro} {...inv(state, 'opis')} />
      </div>
      {canEdit && (
        <div className="np-actions pr-ai">
          <button className="btn small" type="button" onClick={podpowiedz} disabled={aiPending || !ai}>
            {aiPending ? 'Piszę opis…' : 'Podpowiedz opis (AI)'}
          </button>
          <span className="muted small" role="status">
            {aiMsg ?? (ai ? 'Propozycja wpada do pola opisu; zapisujesz ją przyciskiem „Zapisz zmiany”.' : 'Wymaga dostawcy AI: ustawia go administrator instalacji (Pomoc → Konfiguracja).')}
          </span>
        </div>
      )}
      {canEdit && (
        <div className="np-actions">
          <button className="btn primary" type="submit" disabled={pending}>
            {pending ? 'Zapisywanie…' : 'Zapisz zmiany'}
          </button>
        </div>
      )}
    </form>
  )
}

export interface SkladnikKarty {
  id: string
  qtyBase: number
  udzial: string
}

export function EdycjaSkladu({ produkt, sklad, opcje }: { produkt: string; sklad: SkladnikKarty[]; opcje: { id: string; label: string }[] }) {
  const [state, action, pending] = useActionState(zapiszSklad, START)
  const [wiersze, setWiersze] = useState<(SkladnikKarty & { k: number })[]>((sklad.length ? sklad : [{ id: '', qtyBase: 1, udzial: '' }]).map((w, k) => ({ ...w, k })))
  return (
    <form action={action} noValidate aria-label="Skład zestawu" className="stack">
      <input type="hidden" name="produkt" value={produkt} />
      <Komunikat state={state} ok="Skład zapisany." />
      <p className="muted small" style={{ margin: 0 }}>
        Udział w cenie (%) mówi, jaka część ceny zestawu przypada na składnik na fakturze. Zostaw puste, podzielimy po cenach składników.
      </p>
      {wiersze.map((w, i) => (
        <div className="pr-skl" key={w.k}>
          <div className="field">
            <label htmlFor={`k-s-${i}`}>Składnik {i + 1}</label>
            <select className="input" id={`k-s-${i}`} name="skladnik" defaultValue={w.id}>
              <option value="">— wybierz produkt —</option>
              {opcje.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`k-q-${i}`}>Ilość</label>
            <input className="input" id={`k-q-${i}`} name="ilosc" inputMode="numeric" defaultValue={String(w.qtyBase)} />
          </div>
          <div className="field">
            <label htmlFor={`k-u-${i}`}>Udział w cenie (%)</label>
            <input className="input" id={`k-u-${i}`} name="udzial" inputMode="decimal" defaultValue={w.udzial} placeholder="puste = po cenach" />
          </div>
          {wiersze.length > 1 && (
            <button className="btn ghost small" type="button" onClick={() => setWiersze(wiersze.filter((_, j) => j !== i))} aria-label={`Usuń składnik ${i + 1}`}>
              Usuń
            </button>
          )}
        </div>
      ))}
      <div className="np-actions">
        <button className="btn small" type="button" onClick={() => setWiersze([...wiersze, { id: '', qtyBase: 1, udzial: '', k: Math.max(...wiersze.map((x) => x.k)) + 1 }])}>
          + Dodaj składnik
        </button>
        <button className="btn primary" type="submit" disabled={pending}>
          {pending ? 'Zapisywanie…' : 'Zapisz skład'}
        </button>
      </div>
    </form>
  )
}

/** „Usuń” zdjęcie z potwierdzeniem: kopia zostaje w archiwum w bazie, ale wiersza nie przywraca się z panelu. */
export function PrzyciskUsunZdjecie({ n }: { n: number }) {
  return (
    <button
      className="btn ghost small"
      type="submit"
      name="co"
      value="usun"
      aria-label={`Usuń zdjęcie ${n}`}
      onClick={(e) => {
        if (!window.confirm(`Usunąć zdjęcie ${n}? Zniknie z produktu, z listy i z wydruków.`)) e.preventDefault()
      }}
    >
      Usuń
    </button>
  )
}
