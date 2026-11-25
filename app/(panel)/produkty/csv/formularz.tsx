'use client'
// Produkty → Import i eksport CSV: formularz importu z raportem po wierszach.
import { useActionState } from 'react'
import { Przelacznik } from '@/app/ui'
import { importujCsv, type StanImportu } from './akcje'

const START: StanImportu = { blad: null, wynik: null }

export function ImportCsv() {
  const [state, action, pending] = useActionState(importujCsv, START)
  const w = state.wynik
  return (
    <>
      <form action={action} className="np-sku" aria-label="Import CSV">
        <div className="field">
          <label htmlFor="csv-plik">Plik CSV (UTF-8, do 5 MB, najwyżej 5 000 produktów)</label>
          <input className="input" id="csv-plik" name="plik" type="file" accept=".csv,text/csv" required />
        </div>
        {/* kolumna „Kategoria” ze ścieżką, której nie ma w drzewie firmy */}
        <Przelacznik id="csv-tworz-kategorie" name="tworzKategorie" defaultChecked etykieta="Twórz brakujące kategorie" pomoc="Wyłączone: wiersz z nieznaną kategorią jest pominięty." />
        <button className="btn primary" type="submit" disabled={pending}>
          {pending ? 'Importuję…' : 'Importuj'}
        </button>
      </form>
      {state.blad && (
        <div className="banner red pr-mt" role="alert">
          <div>{state.blad}</div>
        </div>
      )}
      {w && (
        <div className="pr-mt" role="status">
          <div className={w.bledy.length ? 'banner amber' : 'banner leaf-soft'}>
            <div>
              Nowe produkty: <b>{w.nowe}</b> · zmienione: <b>{w.zmienione}</b> · bez zmian: <b>{w.bezZmian}</b> · wiersze z błędem: <b>{w.bledy.length}</b>
            </div>
          </div>
          {(w.bledy.length > 0 || w.uwagi.length > 0) && (
            <table className="tbl cards pr-mt">
              <thead>
                <tr>
                  <th scope="col">Linia</th>
                  <th scope="col">SKU</th>
                  <th scope="col">Co</th>
                </tr>
              </thead>
              <tbody>
                {[...w.bledy.map((b) => ({ ...b, blad: true })), ...w.uwagi.map((u) => ({ ...u, blad: false }))]
                  .sort((a, b) => a.linia - b.linia)
                  .slice(0, 200)
                  .map((x, i) => (
                    <tr key={i}>
                      <td data-label="Linia">{x.linia}</td>
                      <td data-label="SKU" className="mono">
                        {x.sku || '—'}
                      </td>
                      <td data-label="Co">
                        {x.blad ? <span className="chip red">pominięty</span> : <span className="chip">uwaga</span>} {x.komunikat}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </>
  )
}
