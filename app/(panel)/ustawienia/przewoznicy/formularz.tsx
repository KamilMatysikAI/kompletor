'use client'
// Ustawienia → Przewoźnicy: jeden formularz z jednym PasekZapisu — odbiory wszystkich przewoźników
// i reguły przypisania „sposób dostawy → przewoźnik → moduł wysyłki” (dodaj, usuń, w górę/w dół). Reguły jako słowa
// rozdzielone przecinkami; wzorzec spoza samych słów (z presetu) zostaje jako „wzorzec zaawansowany” bez zmian.
import { useActionState, useEffect, useRef, useState } from 'react'
import { Karta, PasekZapisu, Potwierdzenie, Przycisk, ToastPoAkcji } from '@/app/ui'
import { poleZeWzorca, slowaDoZamiany } from '@/lib/panel/slowa'
import type { RegulaPanelu } from '@/lib/wysylka/reguly'
import { zapiszPrzewoznikow, type StanPrzewoznikow } from './akcje'

export interface OdbiorWiersz {
  carrier: string
  nazwa: string
  opis: string
  weekdays: number[]
  od: string
  wyslemy: string
  active: boolean
  example: boolean
}

interface Wiersz {
  klucz: string
  id: string
  kanal: string
  tryb: 'slowa' | 'wzorzec'
  slowa: string
  przewoznik: string
  modul: string
  /** drugie konto przewoźnika (sufiks), '' = główne */
  konto: string
  /** ustawienia reguły, których panel nie odtworzy; usunięcie wymaga potwierdzenia */
  konfiguracja: string | null
}

const DNI: [number, string][] = [
  [1, 'pon.'],
  [2, 'wt.'],
  [3, 'śr.'],
  [4, 'czw.'],
  [5, 'pt.'],
  [6, 'sob.'],
  [7, 'niedz.'],
]

let licznik = 0
const doWiersza = (r: RegulaPanelu): Wiersz => {
  const p = poleZeWzorca(r.pattern)
  return { klucz: r.id, id: r.id, kanal: r.channel ?? '', tryb: p.tryb, slowa: p.wartosc, przewoznik: r.carrier, modul: r.adapterKey ?? '', konto: r.konto ?? '', konfiguracja: r.potwierdzenie }
}

export function FormularzPrzewoznikow({
  odbiory,
  reguly,
  kanaly,
  przewoznicy,
  moduly,
  kontaModulow = {},
}: {
  odbiory: OdbiorWiersz[]
  reguly: RegulaPanelu[]
  kanaly: { wartosc: string; etykieta: string }[]
  przewoznicy: { wartosc: string; etykieta: string }[]
  moduly: { wartosc: string; etykieta: string }[]
  /** konta do wyboru dla modułu (tylko gdy przewoźnik ma więcej niż jedno konto) */
  kontaModulow?: Record<string, { wartosc: string; etykieta: string }[]>
}) {
  const [stan, akcja, trwa] = useActionState<StanPrzewoznikow, FormData>(zapiszPrzewoznikow, {})
  const zapisane = useRef<Wiersz[]>(reguly.map(doWiersza))
  const [wiersze, setWiersze] = useState<Wiersz[]>(zapisane.current)
  const formRef = useRef<HTMLFormElement>(null)
  // usunięcie reguły z ustawieniami: najpierw pytanie, potwierdzone id idą do serwera (bez nich serwer odmówi zapisu)
  const [doUsuniecia, setDoUsuniecia] = useState<number | null>(null)
  const [potwierdzone, setPotwierdzone] = useState<string[]>([])
  const usun = (i: number) => setWiersze((x) => x.filter((_, j) => j !== i))
  // PasekZapisu słucha zdarzeń formularza: dodanie, usunięcie i przesunięcie wiersza zgłaszamy jak zmianę pola
  const pierwszy = useRef(true)
  useEffect(() => {
    if (pierwszy.current) {
      pierwszy.current = false
      return
    }
    formRef.current?.dispatchEvent(new Event('change', { bubbles: true }))
  }, [wiersze])
  useEffect(() => {
    if (stan.ok && stan.reguly) {
      zapisane.current = stan.reguly.map(doWiersza)
      setWiersze(zapisane.current)
      setPotwierdzone([])
      // po zapisie nowe reguły mają id: pasek bierze bieżący stan za zapisany (zdarzenie reset po przerysowaniu)
      requestAnimationFrame(() => formRef.current?.dispatchEvent(new Event('reset')))
    }
  }, [stan])
  const blad = (pole: string) => (stan.ok === false && stan.pole === pole ? stan.komunikat : undefined)
  const zmien = (i: number, patch: Partial<Wiersz>) => setWiersze((w) => w.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  const przesun = (i: number, o: number) =>
    setWiersze((w) => {
      const n = [...w]
      const [x] = n.splice(i, 1)
      n.splice(i + o, 0, x!)
      return n
    })
  const pomocBledu = (pole: string) => {
    const b = blad(pole)
    return b ? (
      <p className="ui-blad" id={`${pole}-blad`} role="alert">
        {b}
      </p>
    ) : null
  }
  const aria = (pole: string) => (blad(pole) ? { 'aria-invalid': true as const, 'aria-describedby': `${pole}-blad` } : {})

  return (
    <form ref={formRef} action={akcja} onReset={() => {
        setWiersze(zapisane.current)
        setPotwierdzone([])
      }} aria-label="Przewoźnicy" className="stack">
      <ToastPoAkcji stan={stan} bledy={!stan.pole} />
      {potwierdzone
        .filter((id) => !wiersze.some((w) => w.id === id))
        .map((id) => (
          <input key={id} type="hidden" name="regula-usun-potwierdzone" value={id} />
        ))}

      <Karta tytul="Odbiory" opis="„Wyślemy dziś do”: do tej godziny sklep może obiecać wysyłkę tego dnia. Kolejka pakowania układa się od najbliższego odbioru, w święta odbioru nie ma.">
        <table className="tbl cards przew-tbl">
          <thead>
            <tr>
              <th>Przewoźnik</th>
              <th>Dni odbioru</th>
              <th>Odbiór</th>
              <th>Wyślemy dziś do</th>
              <th>Odbiera</th>
            </tr>
          </thead>
          <tbody>
            {odbiory.map((o) => (
              <tr key={o.carrier}>
                <td data-label="Przewoźnik">
                  <input type="hidden" name={`odbior-${o.carrier}-jest`} value="tak" />
                  <b>{o.nazwa}</b>
                  <div className="small muted">{o.opis}</div>
                  {o.example && <span className="chip amber">przykładowe godziny</span>}
                </td>
                <td data-label="Dni odbioru">
                  <fieldset className="wk">
                    <legend className="sr">Dni odbioru: {o.nazwa}</legend>
                    {DNI.map(([d, l]) => (
                      <label key={d}>
                        <input type="checkbox" name={`odbior-${o.carrier}-dni`} value={d} defaultChecked={o.weekdays.includes(d)} />
                        {l}
                      </label>
                    ))}
                  </fieldset>
                </td>
                <td data-label="Odbiór">
                  <input className="input przew-godz" name={`odbior-${o.carrier}-od`} id={`odbior-${o.carrier}-od`} inputMode="numeric" placeholder="13:00" aria-label={`Odbiór: ${o.nazwa}`} defaultValue={o.od} {...aria(`odbior-${o.carrier}-od`)} />
                  {pomocBledu(`odbior-${o.carrier}-od`)}
                </td>
                <td data-label="Wyślemy dziś do">
                  <input className="input przew-godz" name={`odbior-${o.carrier}-wyslemy`} id={`odbior-${o.carrier}-wyslemy`} inputMode="numeric" placeholder="12:00" aria-label={`Wyślemy dziś do: ${o.nazwa}`} defaultValue={o.wyslemy} {...aria(`odbior-${o.carrier}-wyslemy`)} />
                  {pomocBledu(`odbior-${o.carrier}-wyslemy`)}
                </td>
                <td data-label="Odbiera">
                  <label className="toggle">
                    <input type="checkbox" role="switch" name={`odbior-${o.carrier}-aktywny`} value="tak" defaultChecked={o.active} aria-label={`${o.nazwa} odbiera paczki`} />
                    <span>tak</span>
                  </label>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Karta>

      <Karta
        tytul="Który przewoźnik dla którego sposobu dostawy"
        opis="Kompletor sprawdza reguły od góry: pierwsza pasująca wybiera przewoźnika i moduł wysyłki. Słowa szukane są w nazwie sposobu dostawy z zamówienia (wielkość liter bez znaczenia). Zmiana działa dla zamówień przyjmowanych od teraz; przewoźnika zamówienia już przyjętego zmienisz na karcie zamówienia."
      >
        {wiersze.length === 0 ? (
          <p className="muted">Brak reguł: każde zamówienie trafi do „Do wyjaśnienia”. Dodaj pierwszą regułę.</p>
        ) : (
          <table className="tbl cards przew-tbl">
            <thead>
              <tr>
                <th>Nr</th>
                <th>Kanał</th>
                <th>Sposób dostawy zawiera</th>
                <th>Przewoźnik</th>
                <th>Moduł wysyłki</th>
                <th>
                  <span className="sr">Kolejność i usuwanie</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {wiersze.map((w, i) => (
                <tr key={w.klucz}>
                  <td data-label="Nr" className="num">
                    {i + 1}
                    <input type="hidden" name="regula-id" value={w.id} />
                    <input type="hidden" name="regula-tryb" value={w.tryb} />
                  </td>
                  <td data-label="Kanał">
                    <select className="input" name="regula-kanal" id={`regula-${i}-kanal`} value={w.kanal} onChange={(e) => zmien(i, { kanal: e.target.value })} aria-label={`Reguła ${i + 1}: kanał`} {...aria(`regula-${i}-kanal`)}>
                      <option value="">każdy kanał</option>
                      {kanaly.map((k) => (
                        <option key={k.wartosc} value={k.wartosc}>
                          {k.etykieta}
                        </option>
                      ))}
                    </select>
                    {pomocBledu(`regula-${i}-kanal`)}
                  </td>
                  <td data-label="Sposób dostawy zawiera">
                    <input
                      className={`input${w.tryb === 'wzorzec' ? ' mono' : ''}`}
                      name="regula-slowa"
                      id={`regula-${i}-slowa`}
                      value={w.slowa}
                      onChange={(e) => zmien(i, { slowa: e.target.value })}
                      placeholder="np. paczkomat, inpost"
                      title="Słowa rozdzielone przecinkami; puste = każdy sposób dostawy"
                      aria-label={`Reguła ${i + 1}: ${w.tryb === 'wzorzec' ? 'wzorzec zaawansowany' : 'słowa rozdzielone przecinkami'}`}
                      {...aria(`regula-${i}-slowa`)}
                    />
                    {w.tryb === 'wzorzec' && <PomocWzorca wartosc={w.slowa} naSlowa={(s) => zmien(i, { tryb: 'slowa', slowa: s })} />}
                    {pomocBledu(`regula-${i}-slowa`)}
                  </td>
                  <td data-label="Przewoźnik">
                    <select className="input" name="regula-przewoznik" id={`regula-${i}-przewoznik`} value={w.przewoznik} onChange={(e) => zmien(i, { przewoznik: e.target.value })} aria-label={`Reguła ${i + 1}: przewoźnik`} {...aria(`regula-${i}-przewoznik`)}>
                      {przewoznicy.map((k) => (
                        <option key={k.wartosc} value={k.wartosc}>
                          {k.etykieta}
                        </option>
                      ))}
                    </select>
                    {pomocBledu(`regula-${i}-przewoznik`)}
                  </td>
                  <td data-label="Moduł wysyłki">
                    <select className="input" name="regula-modul" id={`regula-${i}-modul`} value={w.modul} onChange={(e) => zmien(i, { modul: e.target.value, konto: '' })} aria-label={`Reguła ${i + 1}: moduł wysyłki`} {...aria(`regula-${i}-modul`)}>
                      <option value="">bez modułu (etykieta poza Kompletorem)</option>
                      {moduly.map((k) => (
                        <option key={k.wartosc} value={k.wartosc}>
                          {k.etykieta}
                        </option>
                      ))}
                    </select>
                    {pomocBledu(`regula-${i}-modul`)}
                    {kontaModulow[w.modul] ? (
                      <select className="input przew-konto" name="regula-konto" id={`regula-${i}-konto`} value={w.konto} onChange={(e) => zmien(i, { konto: e.target.value })} aria-label={`Reguła ${i + 1}: konto przewoźnika`} {...aria(`regula-${i}-konto`)}>
                        {kontaModulow[w.modul]!.map((k) => (
                          <option key={k.wartosc} value={k.wartosc}>
                            konto: {k.etykieta}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input type="hidden" name="regula-konto" value={w.konto} />
                    )}
                    {pomocBledu(`regula-${i}-konto`)}
                  </td>
                  <td data-label="Kolejność" className="nowrap">
                    <Przycisk rozmiar="sm" wariant="cichy" disabled={i === 0} onClick={() => przesun(i, -1)} aria-label={`Reguła ${i + 1} w górę`}>
                      ↑
                    </Przycisk>
                    <Przycisk rozmiar="sm" wariant="cichy" disabled={i === wiersze.length - 1} onClick={() => przesun(i, 1)} aria-label={`Reguła ${i + 1} w dół`}>
                      ↓
                    </Przycisk>
                    <Przycisk rozmiar="sm" wariant="cichy" onClick={() => (w.konfiguracja && w.id ? setDoUsuniecia(i) : usun(i))} aria-label={`Usuń regułę ${i + 1}`}>
                      Usuń
                    </Przycisk>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p>
          <Przycisk
            rozmiar="sm"
            onClick={() => setWiersze((w) => [...w, { klucz: `nowa-${++licznik}`, id: '', kanal: '', tryb: 'slowa', slowa: '', przewoznik: przewoznicy[0]?.wartosc ?? 'DPD', modul: '', konto: '', konfiguracja: null }])}
          >
            Dodaj regułę
          </Przycisk>
        </p>
      </Karta>
      <PasekZapisu oczekuje={trwa} />
      <Potwierdzenie
        otwarte={doUsuniecia !== null}
        tytul="Usunąć regułę z ustawieniami technicznymi?"
        tak="Usuń regułę"
        wariant="niebezpieczny"
        onNie={() => setDoUsuniecia(null)}
        onTak={() => {
          const w = doUsuniecia === null ? undefined : wiersze[doUsuniecia]
          if (w) {
            setPotwierdzone((p) => [...p, w.id])
            usun(doUsuniecia!)
          }
          setDoUsuniecia(null)
        }}
      >
        <p>
          Reguła {doUsuniecia === null ? '' : doUsuniecia + 1} ma ustawienia, których ten ekran nie pokazuje i nie odtworzy: {doUsuniecia === null ? '' : wiersze[doUsuniecia]?.konfiguracja}.
        </p>
        <p>Po zapisie przepadną. Kopia ustawień zostaje w historii zmian, odtworzy ją osoba techniczna. Konto przewoźnika i nadawanie ustawisz na nowo sam (kolumna „Moduł wysyłki” i ekran Konta przewoźników).</p>
        <p className="muted">Usunięcie działa po „Zapisz zmiany”; „Anuluj” w pasku zapisu przywraca regułę.</p>
      </Potwierdzenie>
    </form>
  )
}

/** Pod wzorcem zaawansowanym: „Zamień na słowa” tylko dla wzorca z samych słów, inaczej zdanie, kto go zmienia. */
function PomocWzorca({ wartosc, naSlowa }: { wartosc: string; naSlowa: (slowa: string) => void }) {
  const s = slowaDoZamiany(wartosc)
  return (
    <p className="ui-pomoc">
      Wzorzec zaawansowany (| = „albo”).{' '}
      {s === null ? (
        'Ten wzorzec zmienia osoba techniczna; zapis formularza zostawia go bez zmian.'
      ) : (
        <button type="button" className="linkbtn" onClick={() => naSlowa(s)}>
          Zamień na słowa
        </button>
      )}
    </p>
  )
}
