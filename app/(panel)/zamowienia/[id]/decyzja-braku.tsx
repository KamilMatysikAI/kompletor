'use client'
// Kolumna „Decyzja o braku” pozycji karty zamówienia z oknem „Zamień produkt” (wzór: BL „Operacje na
// produktach → zamień”). Lista decyzji jak dotąd (pole `decyzja_<id>` formularza pozycji); przy „Zamień produkt”
// zamiast pola na SKU jest okno z wyszukiwarką produktów (SKU, nazwa, EAN, stan dostępny). Wybrany produkt trafia do
// ukrytego pola `sku_<id>` i jest zapisywany razem z resztą sekcji jednym „Zapisz” (PasekZapisu). „Anuluj” paska
// przywraca też wybrany zamiennik. Produkty, które nie nadają się na zamiennik (inna jednostka, za mało na stanie),
// są na liście z powodem i bez przycisku wyboru; ostatnie słowo i tak ma rdzeń przy zapisie.
import { useEffect, useRef, useState, useTransition } from 'react'
import { Modal, Odznaka, Przycisk } from '@/app/ui'
import type { ProduktZamiennika } from '@/lib/karta/szukaj-produktu'
import { qty } from '@/lib/panel/format'
import { szukajZamiennikaKarta } from './akcje-szukaj'

export interface OpcjaDecyzji {
  akcja: string
  etykieta: string
  opis: string
}

export function DecyzjaBraku({
  lineId,
  tytul,
  opcje,
  zapisana,
  zamiennik,
  pokazZamiane,
  naSucho,
}: {
  lineId: string
  tytul: string
  opcje: OpcjaDecyzji[]
  /** Zapisana decyzja (akcja) albo null = domyślnie „wyślij resztę”. */
  zapisana: string | null
  zamiennik: { sku: string; nazwa: string } | null
  /** Po spakowaniu zostaje tylko „Dośle później”: bez zamiany i bez pola SKU. */
  pokazZamiane: boolean
  naSucho: boolean
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const select = useRef<HTMLSelectElement>(null)
  const ukryte = useRef<HTMLInputElement>(null)
  const [akcja, setAkcja] = useState(zapisana ?? '')
  const [wybrany, setWybrany] = useState(zamiennik)
  const [okno, setOkno] = useState(false)

  // „Anuluj” paska zapisu (form.reset) przywraca listę sama, ukryte pole i nasz stan trzeba przywrócić ręcznie, zanim
  // pasek zrobi nowy zrzut formularza (requestAnimationFrame po resecie)
  useEffect(() => {
    const f = ref.current?.closest('form')
    if (!f) return
    const onReset = () => {
      if (ukryte.current) ukryte.current.value = zamiennik?.sku ?? ''
      setWybrany(zamiennik)
      setAkcja(zapisana ?? '')
    }
    f.addEventListener('reset', onReset)
    return () => f.removeEventListener('reset', onReset)
  }, [zamiennik, zapisana])

  const wybierz = (p: ProduktZamiennika) => {
    if (ukryte.current) ukryte.current.value = p.sku
    if (select.current) {
      select.current.value = 'ZAMIEN'
      // zdarzenie dla paska zapisu (porównuje formularz po każdym input/change)
      select.current.dispatchEvent(new Event('change', { bubbles: true }))
    }
    setAkcja('ZAMIEN')
    setWybrany({ sku: p.sku, nazwa: p.nazwa })
    setOkno(false)
  }

  const zamiana = pokazZamiane && akcja === 'ZAMIEN'
  return (
    <span ref={ref} className="kz-decyzja">
      <select
        ref={select}
        className="input"
        name={`decyzja_${lineId}`}
        defaultValue={zapisana ?? ''}
        aria-label={`Decyzja o braku: ${tytul}`}
        onChange={(e) => {
          setAkcja(e.target.value)
          // „Zamień produkt” bez wybranego zamiennika: od razu okno wyszukiwarki
          if (e.target.value === 'ZAMIEN' && pokazZamiane && !ukryte.current?.value) setOkno(true)
        }}
      >
        {!zapisana && <option value="">Wyślij resztę (domyślnie)</option>}
        {opcje.map((x) => (
          <option key={x.akcja} value={x.akcja} title={x.opis}>
            {x.etykieta}
          </option>
        ))}
      </select>
      {pokazZamiane && <input ref={ukryte} type="hidden" name={`sku_${lineId}`} defaultValue={zamiennik?.sku ?? ''} />}
      {zamiana && (
        <span className="kz-zamiennik-wybor">
          {wybrany ? (
            <span className="small">
              zamiennik: <b>{wybrany.nazwa}</b> <span className="mono">SKU {wybrany.sku}</span>
            </span>
          ) : (
            <span className="small kz-zamiennik-brak">wybierz zamiennik przed zapisem</span>
          )}
          <Przycisk rozmiar="sm" onClick={() => setOkno(true)}>
            {wybrany ? 'Zmień zamiennik…' : 'Wybierz zamiennik…'}
          </Przycisk>
        </span>
      )}
      {!zamiana && wybrany && akcja === 'ZAMIEN' && <span className="sub">zamiennik: {wybrany.nazwa}</span>}
      {naSucho && <span className="sub">zapisane próbnie (konto „Tylko podgląd”)</span>}
      {pokazZamiane && <OknoZamiany otwarte={okno} lineId={lineId} tytul={tytul} onZamknij={() => setOkno(false)} onWybierz={wybierz} />}
    </span>
  )
}

function OknoZamiany({ otwarte, lineId, tytul, onZamknij, onWybierz }: { otwarte: boolean; lineId: string; tytul: string; onZamknij: () => void; onWybierz: (p: ProduktZamiennika) => void }) {
  const [fraza, setFraza] = useState('')
  const [wyniki, setWyniki] = useState<ProduktZamiennika[] | null>(null)
  const [blad, setBlad] = useState<string | null>(null)
  const [szuka, start] = useTransition()
  const szukaj = () =>
    start(async () => {
      const r = await szukajZamiennikaKarta(lineId, fraza)
      setBlad(r.blad)
      setWyniki(r.blad ? null : r.produkty)
    })
  const idPola = `zp-fraza-${lineId}`
  return (
    <Modal otwarty={otwarte} onZamknij={onZamknij} tytul="Zamień produkt" szeroki stopka={<Przycisk onClick={onZamknij}>Zamknij</Przycisk>}>
      <p className="small kz-bez-marginesu">
        Zamiast brakującego „{tytul}” do paczki pójdzie wybrany produkt, po tej samej cenie. Zamiana zapisze się dopiero po „Zapisz decyzje” albo „Zapisz pozycje” pod tabelą.
      </p>
      <div className="kz-szukaj">
        <div className="field">
          <label htmlFor={idPola}>Szukaj produktu (SKU, nazwa albo EAN)</label>
          {/* bez `name`: pole nie wchodzi do formularza pozycji; Enter szuka zamiast wysyłać formularz */}
          <input
            id={idPola}
            className="input"
            value={fraza}
            autoComplete="off"
            spellCheck={false}
            maxLength={100}
            data-fokus=""
            onChange={(e) => setFraza(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                szukaj()
              }
            }}
          />
        </div>
        <Przycisk wariant="glowny" onClick={szukaj} ladowanie={szuka}>
          Szukaj
        </Przycisk>
      </div>
      {blad && <p className="small kz-zamiennik-brak">{blad}</p>}
      {wyniki && !wyniki.length && <p className="small muted">Nic nie pasuje. Szukamy wśród aktywnych produktów magazynowych (bez zestawów).</p>}
      {wyniki && wyniki.length > 0 && (
        <ul className="kz-wyniki" aria-label="Wyniki wyszukiwania">
          {wyniki.map((p) => (
            <li key={p.sku} className="kz-wynik">
              <span className="kz-wynik-opis">
                <b>{p.nazwa}</b>
                <span className="sub mono">
                  SKU {p.sku}
                  {p.ean ? ` · EAN ${p.ean}` : ''}
                </span>
              </span>
              <span className="kz-wynik-stan">
                <Odznaka ton={p.dostepne && p.dostepne > 0 ? 'sukces' : 'neutralny'} rozmiar="sm">
                  dostępne {qty(p.dostepne ?? 0, p.jednostka)}
                </Odznaka>
              </span>
              {p.powod ? (
                <span className="small muted kz-wynik-akcja">{p.powod}</span>
              ) : (
                <span className="kz-wynik-akcja">
                  <Przycisk rozmiar="sm" wariant="glowny" onClick={() => onWybierz(p)}>
                    Wybierz
                  </Przycisk>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
