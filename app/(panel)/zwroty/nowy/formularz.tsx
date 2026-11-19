'use client'
// Formularz „Stwórz zwrot”: pozycje zamówienia z ilością do zwrotu (najwyżej to, co wydane i jeszcze
// niezwrócone), rodzaj (zwrot albo reklamacja), powód, notatka i zdjęcie (opcjonalne, przez osłonę uploadu na serwerze).
import { useActionState, useState } from 'react'
import { Baner, Przycisk, Wybor } from '@/app/ui'
import type { PozycjaDoZwrotu } from '@/lib/zwroty/karta'
import { POWODY_REKLAMACJI, POWODY_ZWROTU } from '@/lib/zwroty/statusy'
import { stworzZwrot, type WynikAkcjiZwrotu } from '../akcje'

const START: WynikAkcjiZwrotu = { blad: null }

export function FormularzZwrotu({ orderId, pozycje, typ: typStart }: { orderId: string; pozycje: PozycjaDoZwrotu[]; typ: 'zwrot' | 'reklamacja' }) {
  const [state, action, pending] = useActionState(stworzZwrot, START)
  const [typ, setTyp] = useState(typStart)
  const powody = typ === 'reklamacja' ? POWODY_REKLAMACJI : POWODY_ZWROTU
  return (
    <form action={action} className="zw-formularz" aria-label="Nowy zwrot">
      <input type="hidden" name="zamowienie" value={orderId} />
      <fieldset className="zw-typ">
        <legend>Rodzaj</legend>
        <label className="zw-radio">
          <input type="radio" name="typ" value="zwrot" checked={typ === 'zwrot'} onChange={() => setTyp('zwrot')} /> Zwrot (klient odsyła towar)
        </label>
        <label className="zw-radio">
          <input type="radio" name="typ" value="reklamacja" checked={typ === 'reklamacja'} onChange={() => setTyp('reklamacja')} /> Reklamacja
        </label>
      </fieldset>

      <table className="tbl cards zw-pozycje">
        <thead>
          <tr>
            <th scope="col">Pozycja</th>
            <th scope="col" className="right">
              Wydane, do zwrotu
            </th>
            <th scope="col" className="right">
              Ilość w zwrocie
            </th>
          </tr>
        </thead>
        <tbody>
          {pozycje.map((p) => {
            const id = `il-${p.orderLineId}-${p.productId}`
            return (
              <tr key={`${p.orderLineId}:${p.productId}`}>
                <td data-label="Pozycja">
                  <label htmlFor={id}>{p.nazwa}</label>
                  {p.sku && <span className="sub mono">{p.sku}</span>}
                </td>
                <td data-label="Wydane, do zwrotu" className="right num">
                  {p.maks} {p.jednostka}
                </td>
                <td data-label="Ilość w zwrocie" className="right">
                  <input className="input zw-ilosc" id={id} name={`ilosc:${p.orderLineId}:${p.productId}`} type="number" inputMode="numeric" min={0} max={p.maks} step={1} defaultValue={pozycje.length === 1 ? p.maks : 0} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <Wybor
        id="zw-powod"
        name="powod"
        etykieta="Powód"
        key={typ}
        defaultValue=""
        required
        opcje={[{ wartosc: '', etykieta: 'Wybierz powód', wylaczona: true }, ...Object.entries(powody).map(([wartosc, etykieta]) => ({ wartosc, etykieta }))]}
      />
      <div className="field">
        <label htmlFor="zw-notatka">
          Notatka <span className="muted small">(opcjonalnie, bez danych klienta)</span>
        </label>
        <textarea className="input ui-textarea" id="zw-notatka" name="notatka" rows={3} maxLength={500} />
      </div>
      <div className="field">
        <label htmlFor="zw-zdjecie">
          Zdjęcie <span className="muted small">(opcjonalnie: JPEG, PNG albo webp, do 10 MB)</span>
        </label>
        <input className="input" id="zw-zdjecie" name="zdjecie" type="file" accept="image/jpeg,image/png,image/webp" />
        <span className="muted small">Fotografuj towar, nie etykietę z adresem klienta. Zdjęcie widzą tylko osoby, które przyjmują zwroty.</span>
      </div>

      {state.blad && <Baner ton="blad">{state.blad}</Baner>}
      <div className="zw-akcje">
        <Przycisk type="submit" wariant="glowny" ladowanie={pending}>
          {typ === 'reklamacja' ? 'Zapisz reklamację' : 'Zapisz zwrot'}
        </Przycisk>
      </div>
    </form>
  )
}
