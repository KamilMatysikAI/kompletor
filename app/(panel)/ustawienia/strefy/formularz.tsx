'use client'
// Ustawienia → Strefy magazynu: strefy (nazwa, kolor, kolejność) i reguły „słowa w nazwie albo SKU →
// strefa” w jednym formularzu z jednym PasekZapisu. Nowa strefa dostaje odnośnik `nowa-N`, żeby reguła mogła ją
// wskazać przed zapisem (serwer zamienia go na klucz). Wzorzec spoza samych słów (preset) zostaje jako zaawansowany.
import { useActionState, useEffect, useRef, useState } from 'react'
import { Karta, PasekZapisu, Przycisk, PustyStan, ToastPoAkcji } from '@/app/ui'
import { ZONE_COLORS } from '@/lib/pakowanie/strefy'
import type { RegulaUstawienia, StrefaUstawienia } from '@/lib/pakowanie/strefy-dane'
import { poleZeWzorca, slowaDoZamiany } from '@/lib/panel/slowa'
import { zapiszStrefyAkcja, type StanStref } from './akcje'

interface S {
  klucz: string // React key
  key: string
  ref: string
  name: string
  color: string
  produkty: number
}
interface R {
  klucz: string
  zone: string
  tryb: 'slowa' | 'wzorzec'
  slowa: string
  example: boolean
}

let licznik = 0
const doS = (s: StrefaUstawienia): S => ({ klucz: s.key, key: s.key, ref: '', name: s.name, color: s.color, produkty: s.produktyRecznie })
const doR = (r: RegulaUstawienia, i: number): R => {
  const p = poleZeWzorca(r.pattern)
  return { klucz: `r${i}-${r.priority}`, zone: r.zone, tryb: p.tryb, slowa: p.wartosc, example: r.example }
}
const bez = <T extends { klucz: string }>(x: T[]) => JSON.stringify(x.map(({ klucz: _k, ...r }) => r))

function przenies<T>(lista: T[], i: number, o: number): T[] {
  const n = [...lista]
  const [x] = n.splice(i, 1)
  n.splice(i + o, 0, x!)
  return n
}

export function FormularzStref({ strefy, reguly }: { strefy: StrefaUstawienia[]; reguly: RegulaUstawienia[] }) {
  const [stan, akcja, trwa] = useActionState<StanStref, FormData>(zapiszStrefyAkcja, {})
  const zapS = useRef(strefy.map(doS))
  const zapR = useRef(reguly.map(doR))
  const [s, setS] = useState(zapS.current)
  const [r, setR] = useState(zapR.current)
  const formRef = useRef<HTMLFormElement>(null)
  const pierwszy = useRef(true)
  useEffect(() => {
    if (pierwszy.current) {
      pierwszy.current = false
      return
    }
    formRef.current?.dispatchEvent(new Event('change', { bubbles: true }))
  }, [s, r])
  useEffect(() => {
    if (stan.ok && stan.strefy && stan.reguly) {
      zapS.current = stan.strefy.map(doS)
      zapR.current = stan.reguly.map(doR)
      setS(zapS.current)
      setR(zapR.current)
      requestAnimationFrame(() => formRef.current?.dispatchEvent(new Event('reset')))
    }
  }, [stan])
  const blad = (pole: string) => (stan.ok === false && stan.pole === pole ? stan.komunikat : undefined)
  const aria = (pole: string) => (blad(pole) ? { 'aria-invalid': true as const, 'aria-describedby': `${pole}-blad` } : {})
  const pomoc = (pole: string) =>
    blad(pole) ? (
      <p className="ui-blad" id={`${pole}-blad`} role="alert">
        {blad(pole)}
      </p>
    ) : null
  const wartosc = (x: S) => x.key || x.ref
  const zmienS = (i: number, p: Partial<S>) => setS((l) => l.map((x, j) => (j === i ? { ...x, ...p } : x)))
  const zmienR = (i: number, p: Partial<R>) => setR((l) => l.map((x, j) => (j === i ? { ...x, ...p } : x)))
  const usunS = (i: number) => {
    const w = wartosc(s[i]!)
    setS((l) => l.filter((_, j) => j !== i))
    setR((l) => l.filter((x) => x.zone !== w))
  }
  const zmiany = bez(s) !== bez(zapS.current) || bez(r) !== bez(zapR.current)

  return (
    <form
      ref={formRef}
      action={akcja}
      onReset={() => {
        setS(zapS.current)
        setR(zapR.current)
      }}
      aria-label="Strefy magazynu"
      className="stack"
    >
      <ToastPoAkcji stan={stan} bledy={!stan.pole} />
      <input type="hidden" name="zmiany" value={zmiany ? 'tak' : 'nie'} />
      <Karta tytul="Strefy" opis="Części magazynu, z których zbiera się towar osobno (np. pomieszczenie obok, regały przy stanowisku). Kolejność = kolejność filtrów na ekranie Pakowanie.">
        {s.length === 0 ? (
          <PustyStan tytul="Firma nie ma stref">Bez stref pakowanie nie ma filtra stref. Dodaj strefę, gdy część towaru stoi gdzie indziej.</PustyStan>
        ) : (
          <table className="tbl cards przew-tbl">
            <thead>
              <tr>
                <th>Nr</th>
                <th>Nazwa</th>
                <th>Kolor</th>
                <th>Ręcznie w produktach</th>
                <th>
                  <span className="sr">Kolejność i usuwanie</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {s.map((x, i) => (
                <tr key={x.klucz}>
                  <td data-label="Nr" className="num">
                    {i + 1}
                    <input type="hidden" name="strefa-klucz" value={x.key} />
                    <input type="hidden" name="strefa-ref" value={x.ref} />
                  </td>
                  <td data-label="Nazwa">
                    <input className="input" name="strefa-nazwa" id={`strefa-${i}-nazwa`} value={x.name} maxLength={40} onChange={(e) => zmienS(i, { name: e.target.value })} aria-label={`Strefa ${i + 1}: nazwa`} placeholder="np. regały z kawą" {...aria(`strefa-${i}-nazwa`)} />
                    {pomoc(`strefa-${i}-nazwa`)}
                  </td>
                  <td data-label="Kolor">
                    <select className="input" name="strefa-kolor" id={`strefa-${i}-kolor`} value={x.color} onChange={(e) => zmienS(i, { color: e.target.value })} aria-label={`Strefa ${i + 1}: kolor`} {...aria(`strefa-${i}-kolor`)}>
                      {Object.entries(ZONE_COLORS).map(([k, l]) => (
                        <option key={k} value={k}>
                          {l}
                        </option>
                      ))}
                    </select>{' '}
                    <span className={`zone z-${x.color}`}>{x.name || 'strefa'}</span>
                  </td>
                  <td data-label="Ręcznie w produktach" className="num">
                    {x.produkty}
                  </td>
                  <td data-label="Kolejność" className="nowrap">
                    <Przycisk rozmiar="sm" wariant="cichy" disabled={i === 0} onClick={() => setS((l) => przenies(l, i, -1))} aria-label={`Strefa ${i + 1} w górę`}>
                      ↑
                    </Przycisk>
                    <Przycisk rozmiar="sm" wariant="cichy" disabled={i === s.length - 1} onClick={() => setS((l) => przenies(l, i, 1))} aria-label={`Strefa ${i + 1} w dół`}>
                      ↓
                    </Przycisk>
                    <Przycisk
                      rozmiar="sm"
                      wariant="cichy"
                      onClick={() => usunS(i)}
                      powodWylaczenia={x.produkty ? `Strefę ma ustawioną ręcznie ${x.produkty} prod.: zmień ich strefę w karcie produktu` : undefined}
                      aria-label={`Usuń strefę ${i + 1}`}
                    >
                      Usuń
                    </Przycisk>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p>
          <Przycisk rozmiar="sm" onClick={() => setS((l) => [...l, { klucz: `n${++licznik}`, key: '', ref: `nowa-${licznik}`, name: '', color: 'szary', produkty: 0 }])}>
            Dodaj strefę
          </Przycisk>
        </p>
      </Karta>

      <Karta
        tytul="Które produkty w której strefie"
        opis="Kompletor sprawdza reguły od góry: pierwsza, której słowo jest w nazwie albo SKU produktu, wybiera strefę. Strefa ustawiona ręcznie w karcie produktu wygrywa z regułą. Zmiana działa od razu na kolejce pakowania."
      >
        {s.length === 0 ? (
          <p className="muted">Najpierw dodaj strefę.</p>
        ) : r.length === 0 ? (
          <p className="muted">Brak reguł: strefę ustawia się wtedy tylko w karcie produktu.</p>
        ) : (
          <table className="tbl cards przew-tbl">
            <thead>
              <tr>
                <th>Nr</th>
                <th>Nazwa albo SKU zawiera</th>
                <th>Strefa</th>
                <th>
                  <span className="sr">Kolejność i usuwanie</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {r.map((x, i) => (
                <tr key={x.klucz}>
                  <td data-label="Nr" className="num">
                    {i + 1}
                    <input type="hidden" name="regula-tryb" value={x.tryb} />
                  </td>
                  <td data-label="Nazwa albo SKU zawiera">
                    <input
                      className={`input${x.tryb === 'wzorzec' ? ' mono' : ''}`}
                      name="regula-slowa"
                      id={`regula-${i}-slowa`}
                      value={x.slowa}
                      onChange={(e) => zmienR(i, { slowa: e.target.value })}
                      placeholder="np. kawa, przyprawa"
                      aria-label={`Reguła ${i + 1}: ${x.tryb === 'wzorzec' ? 'wzorzec zaawansowany' : 'słowa rozdzielone przecinkami'}`}
                      {...aria(`regula-${i}-slowa`)}
                    />
                    {x.tryb === 'wzorzec' && (
                      <p className="ui-pomoc">
                        Wzorzec zaawansowany (| = „albo”, [aiyę] = jedna z liter).{' '}
                        {slowaDoZamiany(x.slowa) === null ? (
                          'Ten wzorzec zmienia osoba techniczna; zapis formularza zostawia go bez zmian.'
                        ) : (
                          <button type="button" className="linkbtn" onClick={() => zmienR(i, { tryb: 'slowa', slowa: slowaDoZamiany(x.slowa) ?? x.slowa })}>
                            Zamień na słowa
                          </button>
                        )}
                      </p>
                    )}
                    {x.example && <span className="chip amber">przykładowa</span>}
                    {pomoc(`regula-${i}-slowa`)}
                  </td>
                  <td data-label="Strefa">
                    <select className="input" name="regula-strefa" id={`regula-${i}-strefa`} value={x.zone} onChange={(e) => zmienR(i, { zone: e.target.value })} aria-label={`Reguła ${i + 1}: strefa`} {...aria(`regula-${i}-strefa`)}>
                      {s.map((z) => (
                        <option key={z.klucz} value={wartosc(z)}>
                          {z.name || '(nowa strefa)'}
                        </option>
                      ))}
                    </select>
                    {pomoc(`regula-${i}-strefa`)}
                  </td>
                  <td data-label="Kolejność" className="nowrap">
                    <Przycisk rozmiar="sm" wariant="cichy" disabled={i === 0} onClick={() => setR((l) => przenies(l, i, -1))} aria-label={`Reguła ${i + 1} w górę`}>
                      ↑
                    </Przycisk>
                    <Przycisk rozmiar="sm" wariant="cichy" disabled={i === r.length - 1} onClick={() => setR((l) => przenies(l, i, 1))} aria-label={`Reguła ${i + 1} w dół`}>
                      ↓
                    </Przycisk>
                    <Przycisk rozmiar="sm" wariant="cichy" onClick={() => setR((l) => l.filter((_, j) => j !== i))} aria-label={`Usuń regułę ${i + 1}`}>
                      Usuń
                    </Przycisk>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {s.length > 0 && (
          <p>
            <Przycisk rozmiar="sm" onClick={() => setR((l) => [...l, { klucz: `nr${++licznik}`, zone: wartosc(s[0]!), tryb: 'slowa', slowa: '', example: false }])}>
              Dodaj regułę
            </Przycisk>
          </p>
        )}
      </Karta>
      <PasekZapisu oczekuje={trwa} />
    </form>
  )
}
