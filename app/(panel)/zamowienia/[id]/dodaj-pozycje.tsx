'use client'
// „Dodaj pozycję” na karcie zamówienia (wzór: BL „Dodaj produkt” i ekran „Dodaj
// zamówienie”). Szukasz produktu po SKU, nazwie albo EAN, „Wybierz” wpisuje SKU i cenę z katalogu do formularza; SKU da
// się też wpisać ręcznie. Zapis idzie jak dotąd akcją `dodajPozycjeKarta` (bramka trybu PRACA, ustawienie firmy, rdzeń
// z rezerwacją pod blokadą zamówienia). Wyszukiwarka tylko czyta katalog firmy.
import { useRef, useState, useTransition } from 'react'
import { PoleLiczbowe, PoleTekstowe, Przycisk } from '@/app/ui'
import type { ProduktKatalogu } from '@/lib/karta/szukaj-produktu'
import { dodajPozycjeKarta } from './akcje-pozycje'
import { szukajProduktuKarta } from './akcje-szukaj'

const zl = (v: number) => `${v.toFixed(2).replace('.', ',')} zł`

export function DodajPozycje({ orderId }: { orderId: string }) {
  const [fraza, setFraza] = useState('')
  const [wyniki, setWyniki] = useState<ProduktKatalogu[] | null>(null)
  const [blad, setBlad] = useState<string | null>(null)
  const [sku, setSku] = useState('')
  const [cena, setCena] = useState('')
  const [wybrany, setWybrany] = useState<string | null>(null)
  const [szukanie, startSzukania] = useTransition()
  // wynik liczy się tylko dla ostatniego pytania (szybkie dwa wyszukiwania mogą wrócić odwrotnie)
  const ostatnie = useRef(0)
  const szukaj = () => {
    const nr = ++ostatnie.current
    startSzukania(async () => {
      try {
        const r = await szukajProduktuKarta(fraza)
        if (nr !== ostatnie.current) return
        setWyniki(r.produkty)
        setBlad(r.blad)
      } catch {
        if (nr !== ostatnie.current) return
        setWyniki(null)
        setBlad('Nie udało się wyszukać: spróbuj jeszcze raz albo wpisz SKU ręcznie.')
      }
    })
  }
  const wybierz = (p: ProduktKatalogu) => {
    setSku(p.sku)
    setCena(p.cena === null ? '' : p.cena.toFixed(2).replace('.', ','))
    setWybrany(p.nazwa)
    setWyniki(null)
  }

  return (
    <details className="kz-dodaj">
      <summary className="btn">Dodaj pozycję</summary>
      <div className="kz-zmien-pola">
        <div className="kz-dodaj-szukaj">
          <PoleTekstowe
            id="dp-fraza"
            etykieta="Szukaj produktu (SKU, nazwa albo EAN)"
            value={fraza}
            maxLength={100}
            autoComplete="off"
            onChange={(e) => setFraza(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                szukaj()
              }
            }}
          />
          <div>
            <Przycisk type="button" onClick={szukaj} disabled={szukanie}>
              {szukanie ? 'Szukam…' : 'Szukaj'}
            </Przycisk>
          </div>
        </div>
        {blad && <p className="small muted kz-bez-marginesu">{blad}</p>}
        {wyniki && !wyniki.length && !blad && <p className="small muted kz-bez-marginesu">Nic nie znaleziono. Sprawdź SKU albo nazwę w Produkty.</p>}
        {wyniki && wyniki.length > 0 && (
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
              {wyniki.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.nazwa}
                    <span className="sub mono">{p.sku}</span>
                  </td>
                  <td className="right">{p.bezStanu ? 'bez stanu' : p.dostepne}</td>
                  <td className="right">{p.cena === null ? '—' : zl(p.cena)}</td>
                  <td className="right">
                    <Przycisk type="button" rozmiar="sm" onClick={() => wybierz(p)} aria-label={`Wybierz ${p.sku}`}>
                      Wybierz
                    </Przycisk>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form action={dodajPozycjeKarta} className="kz-dodaj-form">
          <input type="hidden" name="zamowienie" value={orderId} />
          <PoleTekstowe
            id="dp-sku"
            etykieta="SKU produktu"
            pomoc={wybrany ? `Wybrany: ${wybrany}.` : 'Wybierz produkt z wyszukiwarki albo wpisz SKU.'}
            name="sku"
            required
            maxLength={100}
            autoComplete="off"
            spellCheck={false}
            value={sku}
            onChange={(e) => {
              setSku(e.target.value)
              setWybrany(null)
            }}
          />
          <PoleLiczbowe id="dp-ilosc" etykieta="Ilość" name="ilosc" inputMode="numeric" min={1} defaultValue={1} required />
          <PoleTekstowe
            id="dp-cena"
            etykieta="Cena brutto za sztukę"
            pomoc="Puste = cena z katalogu."
            opcjonalne
            name="cena"
            inputMode="decimal"
            autoComplete="off"
            pattern="[0-9]+([,.][0-9]{1,2})?"
            value={cena}
            onChange={(e) => setCena(e.target.value)}
          />
          <p className="small muted kz-bez-marginesu">
            Pozycja dostaje rezerwację od razu (czego nie ma na stanie, to „brakuje”), kwota zamówienia rośnie o cenę razy ilość. Gdy zamówienie jest już opłacone, różnicę pokaże „Płatność” jako „Do dopłaty”: dopłatę ustalasz z klientem poza kartą. W kanale zamówienie zostaje bez zmian.
          </p>
          <div>
            <Przycisk type="submit" wariant="glowny">
              Dodaj pozycję
            </Przycisk>
          </div>
        </form>
      </div>
    </details>
  )
}
