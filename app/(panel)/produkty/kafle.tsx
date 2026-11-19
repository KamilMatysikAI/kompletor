// Produkty → kafle kompletności danych (R12 z przeglądu TwojOMS): nad listą liczniki braków (bez SKU albo EAN,
// bez wagi i wymiarów, bez oferty, bez strefy magazynu), produkty bez stanu i „kompletnych N z M” z paskiem. Kafel jest
// linkiem do przefiltrowanej listy; licznik i lista liczą się z tego samego zbioru (`lib/produkty/kompletnosc.ts`).
// Kafel z zerem jest przygaszony (nic do zrobienia), z brakami ma liczbę w kolorze ostrzeżenia. Tylko odczyt.
import Link from 'next/link'
import type { ReactNode } from 'react'
import { int } from '@/lib/panel/format'
import { BRAKI_PRODUKTU, ETYKIETA_BRAKU, type BrakProduktu, type Kompletnosc } from '@/lib/produkty/kompletnosc'
import './kafle.css'

function Kafel({ href, liczba, opis, ton, aktywny }: { href: string | null; liczba: ReactNode; opis: string; ton: 'braki' | 'zero' | 'info'; aktywny?: boolean }) {
  const tresc = (
    <>
      <b className="kafel-liczba">{liczba}</b>
      <span className="kafel-opis">{opis}</span>
    </>
  )
  return (
    <li>
      {href ? (
        <Link className="kafel" href={href} data-ton={ton} aria-current={aktywny ? 'true' : undefined}>
          {tresc}
        </Link>
      ) : (
        <span className="kafel" data-ton={ton}>
          {tresc}
        </span>
      )}
    </li>
  )
}

export function KafleKompletnosci({ k, aktywny, bezStanuHref, strefyHref }: { k: Kompletnosc; aktywny: BrakProduktu | null; bezStanuHref: string | null; strefyHref: string | null }) {
  if (k.razem === 0 && k.bezStanu === 0) return null
  const procent = k.razem ? Math.round((k.kompletne / k.razem) * 100) : 100
  return (
    <nav className="kafle-kompletnosci" aria-label="Kompletność danych produktów">
      <ul>
        {BRAKI_PRODUKTU.map((b) => {
          if (b === 'bez_strefy' && !k.maStrefy) {
            // bez stref w firmie brak strefy nie jest brakiem: kafel prowadzi do ustawienia stref (gdy osoba może)
            return strefyHref ? <Kafel key={b} href={strefyHref} liczba="—" opis="strefy magazynu nieustawione" ton="info" /> : null
          }
          const n = k.braki[b].length
          return <Kafel key={b} href={aktywny === b ? '/produkty' : `/produkty?filtr=${b}`} liczba={int(n)} opis={ETYKIETA_BRAKU[b]} ton={n ? 'braki' : 'zero'} aktywny={aktywny === b} />
        })}
        <Kafel href={bezStanuHref} liczba={int(k.bezStanu)} opis="bez stanu (e-booki, usługi)" ton="info" />
        <li className="kafel-postep-li">
          <Link className="kafel kafel-postep" href="/produkty" data-ton="info">
            <b className="kafel-liczba">
              {int(k.kompletne)}
              <span className="kafel-z"> z {int(k.razem)}</span>
            </b>
            <span className="kafel-opis">kompletnych kart produktów</span>
            <span className="kafel-pasek" aria-hidden="true">
              <span style={{ width: `${procent}%` }} />
            </span>
          </Link>
        </li>
      </ul>
    </nav>
  )
}
