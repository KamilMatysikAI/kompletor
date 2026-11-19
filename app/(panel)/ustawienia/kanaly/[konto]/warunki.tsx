// Lista warunków przełącznika (tryb konta, zapis do sklepu) na ekranie konta kanału. Blokujące na
// czerwono (kn-warunki), ostrzeżenia z „Uwaga:”. Teksty warunków nie zaczynają się od „Najpierw” (przegląd: dubel
// „Najpierw: … Najpierw je włącz.”), więc ekran nie dokleja żadnego prefiksu do blokujących.
import type { Warunek } from '@/lib/kanaly/tryb'

export function Warunki({ w }: { w: readonly Warunek[] }) {
  if (!w.length) return null
  return (
    <ul className="kn-warunki">
      {w.map((x) => (
        <li key={x.tekst} data-blokuje={x.blokuje ? 'tak' : 'nie'}>
          {!x.blokuje && 'Uwaga: '}
          {x.tekst} {x.gdzie && <a href={x.gdzie}>Przejdź</a>}
        </li>
      ))}
    </ul>
  )
}
