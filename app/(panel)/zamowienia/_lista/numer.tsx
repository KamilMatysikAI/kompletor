'use client'
// Pełny numer zamówienia z przyciskiem „Kopiuj” (numer Allegro bez ucinania „ALG 48c7f1b-4…”). Numer łamie
// się w kolumnie zamiast znikać pod wielokropkiem; przycisk kopiuje sam numer z kanału, bez przedrostka.
import Link from 'next/link'
import { useState } from 'react'

export function NumerZamowienia({ href, przedrostek, numer }: { href: string; przedrostek: string; numer: string }) {
  const [skopiowany, setSkopiowany] = useState(false)
  const kopiuj = async () => {
    try {
      await navigator.clipboard.writeText(numer)
      setSkopiowany(true)
      setTimeout(() => setSkopiowany(false), 1500)
    } catch {
      // bez dostępu do schowka: numer i tak da się zaznaczyć
    }
  }
  return (
    <span className="zl-numer">
      <Link className="ord zl-numer-link" href={href}>
        <span className="zl-przedrostek">{przedrostek}</span> {numer}
      </Link>
      <button type="button" className="zl-kopiuj" onClick={kopiuj} aria-label={`Kopiuj numer ${numer}`} title="Kopiuj numer">
        {skopiowany ? 'Skopiowano' : 'Kopiuj'}
      </button>
    </span>
  )
}
