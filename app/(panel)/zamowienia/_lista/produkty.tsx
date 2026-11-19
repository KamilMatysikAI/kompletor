'use client'
// Produkty zamówienia na liście (= R5 przeglądu TwojOMS: miniatura + pełna nazwa).
// Domyślnie zdjęcie 36 px (28 px w gęstości „Gęsto”) i pełna nazwa produktu do dwóch linii, najwyżej 2 pozycje, reszta
// pod „+N pozycji” (rozwija się w miejscu, nie otwiera zamówienia). Pozycja, do której brakuje towaru, ma odznakę
// braku przy sobie. Dawne „kody” (miniatura z ilością, nazwa tylko w podpowiedzi) to osobna kolumna „Produkty (skrót)”
// w „Kolumny”, domyślnie ukryta (`ProduktyKody`). Zdjęcia z bazy (`ProductImageData`) jednym zapytaniem
// na stronę listy (lib/panel/lista-zamowien.ts), bez zapytania na wiersz.
import { useId, useState } from 'react'
import { qty } from '@/lib/panel/format'
import { isMissing, type ListLine } from '@/lib/panel/lista-zamowien-linie'
import { Miniatura } from '../../_komponenty/miniatura'

const WIDOCZNE = 2

function amount(l: ListLine): string {
  return l.unit === 'SZT' ? `${l.qty} ×` : qty(l.qty, l.unit)
}

function missingText(l: ListLine): string {
  if (l.missingParts.length) return `brak: ${l.missingParts.join(', ')}`
  return l.unit === 'SZT' ? `brak ${l.missing}` : `brak ${qty(l.missing, l.unit)}`
}

const pozycji = (n: number) => (n === 1 ? 'pozycja' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'pozycje' : 'pozycji')

function Linia({ l }: { l: ListLine }) {
  const miss = isMissing(l)
  return (
    <li className={miss ? 'miss' : undefined}>
      <Miniatura title={l.title} size={36} zdjecie={l.zdjecie} />
      <span className="zp-tresc">
        <span className="zp-n" title={l.title}>
          <span className="zp-q num">{amount(l)}</span> {l.title}
          {l.bundle && <span className="zp-z"> (zestaw)</span>}
          {l.digital && <span className="zp-z"> (bez stanu)</span>}
        </span>
        {miss && <span className="zp-brak">{missingText(l)}</span>}
      </span>
    </li>
  )
}

export function Produkty({ lines }: { lines: ListLine[] }) {
  const [open, setOpen] = useState(false)
  const listId = useId()
  if (!lines.length) return <span className="muted small">brak pozycji</span>
  const shown = open ? lines : lines.slice(0, WIDOCZNE)
  const rest = lines.length - WIDOCZNE
  const hiddenMissing = lines.slice(WIDOCZNE).filter(isMissing).length
  return (
    <>
      <ul className="zp zp-nazwy" id={listId}>
        {shown.map((l, i) => (
          <Linia key={i} l={l} />
        ))}
      </ul>
      {rest > 0 && (
        <button className="zp-more" type="button" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((v) => !v)}>
          {open ? 'Zwiń' : `+${rest} ${pozycji(rest)}`}
          {!open && hiddenMissing > 0 && <span className="zp-more-brak"> · brak w {hiddenMissing}</span>}
        </button>
      )}
    </>
  )
}

/** Kolumna „Produkty (skrót)”: wszystkie pozycje w jednym rzędzie, miniatura i ilość, nazwa w podpowiedzi i dla czytnika. */
export function ProduktyKody({ lines }: { lines: ListLine[] }) {
  if (!lines.length) return <span className="muted small">brak pozycji</span>
  return (
    <ul className="zp zp-kody">
      {lines.map((l, i) => {
        const miss = isMissing(l)
        return (
          <li key={i} className={miss ? 'miss' : undefined} title={`${amount(l)} ${l.title}${miss ? ` (${missingText(l)})` : ''}`}>
            <Miniatura title={l.title} size={20} zdjecie={l.zdjecie} />
            <span className="zp-q num">{amount(l)}</span>
            <span className="sr">
              {l.title}
              {miss ? `, ${missingText(l)}` : ''}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
