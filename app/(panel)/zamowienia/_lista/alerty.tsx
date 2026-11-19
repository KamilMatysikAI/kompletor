// Alerty nad listą zamówień (R9 z przeglądu TwojOMS): najwyżej trzy, każdy z akcją i „Ignoruj”. Dane
// i zasady (kolejność, podpis, zapis per osoba) w lib/panel/alerty-listy.ts; „Ignoruj” to formularz akcji serwera
// `ignorujAlert` (app/akcje.ts), działa też bez JavaScriptu. Komponent serwerowy.
import Link from 'next/link'
import { ignorujAlert } from '@/app/akcje'
import type { AlertListy } from '@/lib/panel/alerty-listy'

export function AlertyListy({ alerty }: { alerty: readonly AlertListy[] }) {
  if (!alerty.length) return null
  return (
    <ul className="zl-alerty" aria-label="Wymaga uwagi">
      {alerty.map((a) => (
        <li key={a.rodzaj} className="zl-alert" data-ton={a.ton}>
          <span className="zl-alert-tekst">{a.tekst}</span>
          <span className="zl-alert-akcje">
            <Link className="btn small" href={a.akcja.href}>
              {a.akcja.etykieta}
            </Link>
            <form action={ignorujAlert}>
              <input type="hidden" name="rodzaj" value={a.rodzaj} />
              <input type="hidden" name="podpis" value={a.podpis} />
              <button className="btn ghost small" type="submit" title="Schowaj ten alert, dopóki nie zmieni się liczba">
                Ignoruj
              </button>
            </form>
          </span>
        </li>
      ))}
    </ul>
  )
}
