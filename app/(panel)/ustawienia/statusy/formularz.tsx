'use client'
// Ustawienia → Statusy zamówień: lista statusów firmy (podgląd pigułki, etap, przewoźnicy, liczba
// zamówień) z kolejnością strzałkami i jednym oknem edycji, grupy panelu listy, jeden PasekZapisu na cały ekran
// (wzorzec, raport TwojOMS: lista + jedno okno, nie tabela formularzy). Stan trzymany w kliencie, do serwera idą
// pola ukryte w kolejności listy. Nowa grupa dostaje odnośnik `nowa-N`, żeby status mógł ją wskazać przed zapisem.
// Statusu z zamówieniami nie da się usunąć (tylko ukryć); każdy etap musi mieć widoczny status (sprawdza też serwer).
import { useActionState, useEffect, useRef, useState } from 'react'
import type { Carrier, OrderStatus } from '@prisma/client'
import { Karta, Modal, PasekZapisu, Przycisk, PustyStan, StatusFirmy, ToastPoAkcji } from '@/app/ui'
import { CARRIER_LABEL } from '@/lib/panel/format'
import { brakujaceBazowe, isKolorStatusu, KOLORY_STATUSOW, PRZEWOZNICY_WSZYSCY, STATUS_ZAMOWIENIA, STATUSY_RDZENIA, type GrupaStatusowT, type KolorStatusu } from '@/lib/panel/statusy'
import type { StatusUstawienia } from '@/lib/panel/statusy-firmy-dane'
import { zapiszStatusyAkcja, type StanStatusow } from './akcje'

/** Pola, pod którymi formularz pokazuje błąd (nazwy statusów i grup); reszta błędów idzie w toaście. */
const POLE_Z_BLEDEM_POD_SPODEM = /^(status|grupa)-\d+-nazwa$/

interface S {
  klucz: string // React key
  key: string
  name: string
  customerName: string
  color: string
  group: string // klucz grupy, odnośnik nowej albo ''
  baseStatus: OrderStatus
  carriers: Carrier[]
  active: boolean
  zamowienia: number
}
interface G {
  klucz: string
  key: string
  ref: string
  name: string
  collapsed: boolean
}

let licznik = 0
const doS = (s: StatusUstawienia): S => ({ klucz: s.key, key: s.key, name: s.name, customerName: s.customerName ?? '', color: s.color, group: s.groupKey ?? '', baseStatus: s.baseStatus, carriers: [...s.carriers], active: s.active, zamowienia: s.zamowienia })
const doG = (g: GrupaStatusowT): G => ({ klucz: g.key, key: g.key, ref: '', name: g.name, collapsed: g.collapsed })
const bez = <T extends { klucz: string }>(x: T[]) => JSON.stringify(x.map(({ klucz: _k, ...r }) => r))
const kolor = (c: string): KolorStatusu => (isKolorStatusu(c) ? c : 'szary')

function przenies<T>(lista: T[], i: number, o: number): T[] {
  const n = [...lista]
  const [x] = n.splice(i, 1)
  n.splice(i + o, 0, x!)
  return n
}

export function FormularzStatusow({ statusy, grupy }: { statusy: StatusUstawienia[]; grupy: GrupaStatusowT[] }) {
  const [stan, akcja, trwa] = useActionState<StanStatusow, FormData>(zapiszStatusyAkcja, {})
  const zapS = useRef(statusy.map(doS))
  const zapG = useRef(grupy.map(doG))
  const [s, setS] = useState(zapS.current)
  const [g, setG] = useState(zapG.current)
  const [edycja, setEdycja] = useState<number | null>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const pierwszy = useRef(true)
  useEffect(() => {
    if (pierwszy.current) {
      pierwszy.current = false
      return
    }
    formRef.current?.dispatchEvent(new Event('change', { bubbles: true }))
  }, [s, g])
  useEffect(() => {
    if (stan.ok && stan.statusy && stan.grupy) {
      zapS.current = stan.statusy.map(doS)
      zapG.current = stan.grupy.map(doG)
      setS(zapS.current)
      setG(zapG.current)
      requestAnimationFrame(() => formRef.current?.dispatchEvent(new Event('reset')))
    }
  }, [stan])
  const blad = (pole: string) => (stan.ok === false && stan.pole === pole ? stan.komunikat : undefined)
  const pomoc = (pole: string) =>
    blad(pole) ? (
      <p className="ui-blad" id={`${pole}-blad`} role="alert">
        {blad(pole)}
      </p>
    ) : null
  const wartoscG = (x: G) => x.key || x.ref
  const nazwaGrupy = (v: string) => g.find((x) => wartoscG(x) === v)?.name || (v ? '(nowa grupa)' : 'bez grupy')
  const zmienS = (i: number, p: Partial<S>) => setS((l) => l.map((x, j) => (j === i ? { ...x, ...p } : x)))
  const zmienG = (i: number, p: Partial<G>) => setG((l) => l.map((x, j) => (j === i ? { ...x, ...p } : x)))
  const usunG = (i: number) => {
    const w = wartoscG(g[i]!)
    setG((l) => l.filter((_, j) => j !== i))
    setS((l) => l.map((x) => (x.group === w ? { ...x, group: '' } : x)))
  }
  const zmiany = bez(s) !== bez(zapS.current) || bez(g) !== bez(zapG.current)
  const brak = brakujaceBazowe(s.filter((x) => x.active))
  const e = edycja !== null ? s[edycja] : undefined

  return (
    <form
      ref={formRef}
      action={akcja}
      onReset={() => {
        setS(zapS.current)
        setG(zapG.current)
      }}
      aria-label="Statusy zamówień"
      className="stack"
    >
      {/* błąd pola bez miejsca pod polem (status bazowy, grupa, kolor) idzie w toaście */}
      <ToastPoAkcji stan={stan} bledy={!stan.pole || !POLE_Z_BLEDEM_POD_SPODEM.test(stan.pole)} />
      <input type="hidden" name="zmiany" value={zmiany ? 'tak' : 'nie'} />
      {g.map((x) => (
        <span key={x.klucz} hidden>
          <input type="hidden" name="grupa-klucz" value={x.key} />
          <input type="hidden" name="grupa-ref" value={x.ref} />
          <input type="hidden" name="grupa-nazwa" value={x.name} />
          <input type="hidden" name="grupa-zwinieta" value={x.collapsed ? 'tak' : 'nie'} />
        </span>
      ))}
      {s.map((x) => (
        <span key={x.klucz} hidden>
          <input type="hidden" name="status-klucz" value={x.key} />
          <input type="hidden" name="status-nazwa" value={x.name} />
          <input type="hidden" name="status-klient" value={x.customerName} />
          <input type="hidden" name="status-kolor" value={x.color} />
          <input type="hidden" name="status-grupa" value={x.group} />
          <input type="hidden" name="status-bazowy" value={x.baseStatus} />
          <input type="hidden" name="status-przewoznicy" value={x.carriers.join(',')} />
          <input type="hidden" name="status-aktywny" value={x.active ? 'tak' : 'nie'} />
        </span>
      ))}

      <Karta
        tytul="Statusy"
        opis="Kolejność = kolejność w menu „Zamówienia” po lewej (w obrębie grupy). Zamówienie dostaje pierwszy widoczny status swojego etapu, a gdy status jest dla wybranych przewoźników, to ten dla przewoźnika zamówienia."
      >
        {brak.length > 0 && (
          <p className="ui-blad" role="alert">
            Każdy etap musi mieć widoczny status. Brakuje: {brak.map((b) => STATUS_ZAMOWIENIA[b].etykieta).join(', ')}.
          </p>
        )}
        {s.length === 0 ? (
          <PustyStan tytul="Firma nie ma statusów">Zamówienia mają nazwy etapów Kompletora. Dodaj statusy, żeby nazwać je po swojemu.</PustyStan>
        ) : (
          <table className="tbl cards przew-tbl">
            <thead>
              <tr>
                <th>Status</th>
                <th>Grupa</th>
                <th>Etap pracy</th>
                <th>Zamówienia</th>
                <th>
                  <span className="sr">Kolejność i edycja</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {s.map((x, i) => (
                <tr key={x.klucz} className={x.active ? undefined : 'muted'}>
                  <td data-label="Status">
                    <StatusFirmy etykieta={{ nazwa: x.name || 'bez nazwy', kolor: kolor(x.color), bazowy: STATUS_ZAMOWIENIA[x.baseStatus].etykieta }} />
                    {!x.active && <span className="chip"> ukryty</span>}
                    {pomoc(`status-${i}-nazwa`)}
                  </td>
                  <td data-label="Grupa">{nazwaGrupy(x.group)}</td>
                  <td data-label="Etap pracy">
                    {STATUS_ZAMOWIENIA[x.baseStatus].etykieta}
                    {x.carriers.length > 0 && <span className="muted small"> · {x.carriers.map((c) => CARRIER_LABEL[c]).join(', ')}</span>}
                  </td>
                  <td data-label="Zamówienia" className="num">
                    {x.zamowienia}
                  </td>
                  <td data-label="Kolejność" className="nowrap">
                    <Przycisk rozmiar="sm" wariant="cichy" disabled={i === 0} onClick={() => setS((l) => przenies(l, i, -1))} aria-label={`${x.name}: w górę`}>
                      ↑
                    </Przycisk>
                    <Przycisk rozmiar="sm" wariant="cichy" disabled={i === s.length - 1} onClick={() => setS((l) => przenies(l, i, 1))} aria-label={`${x.name}: w dół`}>
                      ↓
                    </Przycisk>
                    <Przycisk rozmiar="sm" onClick={() => setEdycja(i)} aria-label={`Edytuj status ${x.name}`}>
                      Edytuj
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
            onClick={() => {
              setS((l) => [...l, { klucz: `n${++licznik}`, key: '', name: '', customerName: '', color: 'szary', group: '', baseStatus: 'DO_REALIZACJI', carriers: [], active: true, zamowienia: 0 }])
              setEdycja(s.length)
            }}
          >
            Dodaj status
          </Przycisk>
        </p>
      </Karta>

      <Karta tytul="Grupy" opis="Grupy statusów w menu „Zamówienia” po lewej (np. „Do realizacji”, „Zakończone”). Grupy w menu są zwinięte do sumy; rozwija je wybrany status albo strzałka obok grupy. Grupa „zawsze zwinięta” przy każdym wejściu startuje zwinięta. Bez zaznaczenia przeglądarka pamięta, czy grupę rozwinąłeś. Status bez grupy stoi na górze, zaraz pod „Wszystkie”.">
        {g.length === 0 ? (
          <p className="muted">Brak grup: wszystkie statusy stoją w panelu jeden pod drugim.</p>
        ) : (
          <table className="tbl cards przew-tbl">
            <thead>
              <tr>
                <th>Nazwa</th>
                <th>Na start</th>
                <th>
                  <span className="sr">Kolejność i usuwanie</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {g.map((x, i) => (
                <tr key={x.klucz}>
                  <td data-label="Nazwa">
                    <input className="input" id={`grupa-${i}-nazwa`} value={x.name} maxLength={40} onChange={(ev) => zmienG(i, { name: ev.target.value })} aria-label={`Grupa ${i + 1}: nazwa`} placeholder="np. Do realizacji" />
                    {pomoc(`grupa-${i}-nazwa`)}
                  </td>
                  <td data-label="Na start">
                    <label className="nowrap">
                      <input type="checkbox" checked={x.collapsed} onChange={(ev) => zmienG(i, { collapsed: ev.target.checked })} /> zawsze zwinięta
                    </label>
                  </td>
                  <td data-label="Kolejność" className="nowrap">
                    <Przycisk rozmiar="sm" wariant="cichy" disabled={i === 0} onClick={() => setG((l) => przenies(l, i, -1))} aria-label={`Grupa ${i + 1} w górę`}>
                      ↑
                    </Przycisk>
                    <Przycisk rozmiar="sm" wariant="cichy" disabled={i === g.length - 1} onClick={() => setG((l) => przenies(l, i, 1))} aria-label={`Grupa ${i + 1} w dół`}>
                      ↓
                    </Przycisk>
                    <Przycisk rozmiar="sm" wariant="cichy" onClick={() => usunG(i)} aria-label={`Usuń grupę ${i + 1}`}>
                      Usuń
                    </Przycisk>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p>
          <Przycisk rozmiar="sm" onClick={() => setG((l) => [...l, { klucz: `ng${++licznik}`, key: '', ref: `nowa-${licznik}`, name: '', collapsed: false }])}>
            Dodaj grupę
          </Przycisk>
        </p>
      </Karta>

      <Modal
        otwarty={!!e}
        onZamknij={() => setEdycja(null)}
        tytul={e?.key ? `Status: ${e.name}` : 'Nowy status'}
        szeroki
        stopka={
          e && edycja !== null ? (
            <>
              {e.zamowienia === 0 ? (
                <Przycisk
                  wariant="cichy"
                  onClick={() => {
                    setS((l) => l.filter((_, j) => j !== edycja))
                    setEdycja(null)
                  }}
                >
                  Usuń status
                </Przycisk>
              ) : (
                <Przycisk wariant="cichy" onClick={() => zmienS(edycja, { active: !e.active })}>
                  {e.active ? 'Ukryj status' : 'Pokaż status'}
                </Przycisk>
              )}
              <Przycisk wariant="glowny" onClick={() => setEdycja(null)}>
                Gotowe
              </Przycisk>
            </>
          ) : null
        }
      >
        {e && edycja !== null && (
          <div className="stack">
            <p>
              Podgląd: <StatusFirmy etykieta={{ nazwa: e.name || 'bez nazwy', kolor: kolor(e.color), bazowy: STATUS_ZAMOWIENIA[e.baseStatus].etykieta }} />
            </p>
            <div className="field">
              <label htmlFor="sf-nazwa">Nazwa</label>
              <input className="input" id="sf-nazwa" value={e.name} maxLength={40} onChange={(ev) => zmienS(edycja, { name: ev.target.value })} placeholder="np. Do realizacji DPD" />
            </div>
            <div className="field">
              <label htmlFor="sf-klient">Nazwa dla klienta (opcjonalnie)</label>
              <input className="input" id="sf-klient" value={e.customerName} maxLength={60} onChange={(ev) => zmienS(edycja, { customerName: ev.target.value })} placeholder="np. W przygotowaniu" />
              <p className="ui-pomoc">Gdy pusta, klient widzi nazwę statusu.</p>
            </div>
            <div className="field">
              <label htmlFor="sf-kolor">Kolor</label>
              <select className="input" id="sf-kolor" value={e.color} onChange={(ev) => zmienS(edycja, { color: ev.target.value })}>
                {Object.entries(KOLORY_STATUSOW).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.nazwa}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="sf-grupa">Grupa</label>
              <select className="input" id="sf-grupa" value={e.group} onChange={(ev) => zmienS(edycja, { group: ev.target.value })}>
                <option value="">bez grupy (góra panelu)</option>
                {g.map((x) => (
                  <option key={x.klucz} value={wartoscG(x)}>
                    {x.name || '(nowa grupa)'}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="sf-bazowy">Etap pracy w Kompletorze</label>
              <select className="input" id="sf-bazowy" value={e.baseStatus} onChange={(ev) => zmienS(edycja, { baseStatus: ev.target.value as OrderStatus })}>
                {STATUSY_RDZENIA.map((b) => (
                  <option key={b} value={b}>
                    {STATUS_ZAMOWIENIA[b].etykieta}
                  </option>
                ))}
              </select>
              <p className="ui-pomoc">Kompletor sam przenosi zamówienia między etapami (płatność, zbieranie, pakowanie, wysyłka); ten status jest nazwą etapu.</p>
            </div>
            <fieldset className="field">
              <legend>Tylko dla przewoźników (nic nie zaznaczone = dla każdego)</legend>
              <div className="chips">
                {PRZEWOZNICY_WSZYSCY.map((c) => (
                  <label key={c} className="nowrap">
                    <input
                      type="checkbox"
                      checked={e.carriers.includes(c)}
                      onChange={(ev) => zmienS(edycja, { carriers: ev.target.checked ? [...e.carriers, c] : e.carriers.filter((x) => x !== c) })}
                    />{' '}
                    {CARRIER_LABEL[c]}
                  </label>
                ))}
              </div>
            </fieldset>
            {e.zamowienia > 0 && <p className="muted small">Status ma zamówienia ({e.zamowienia}): można go ukryć, nie usunąć.</p>}
          </div>
        )}
      </Modal>
      <PasekZapisu oczekuje={trwa} />
    </form>
  )
}
