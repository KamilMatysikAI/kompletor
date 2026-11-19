'use client'
// Postęp akcji masowej w tle: odpytywanie co 2 s, pasek z liczbą zrobionych, po końcu toast z wynikiem
// i lista błędów (numer + powód, bez danych klienta). Widoczny po odświeżeniu listy (akcje z ostatnich 15 minut);
// renderuje go tylko strona (`ostatnieAkcje`), więc jedna akcja = jedno odpytywanie i jeden toast.
// Bez zmiany liczby zrobionych przez 10 minut pasek przestaje odpytywać i prosi o sprawdzenie później:
// akcję bez ruchu przez godzinę sprzątanie oznacza jako przerwaną, z liczbą zamówień, które mają wynik.
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { useToast } from '@/app/ui'
import { NAZWA_AKCJI, type RodzajAkcji } from '@/lib/zamowienia/masowo-progi'
import { NAZWA_AKCJI_PRZESYLEK, type RodzajPrzesylek } from '@/lib/wysylka/masowo-progi'
import type { StanAkcji } from '@/lib/zamowienia/masowo'
import { postepAkcji } from '../akcje-masowe'

const CO_MS = 2000
/** bez postępu przez tyle odpytywanie się kończy */
export const BEZ_POSTEPU_MS = 10 * 60_000

/** nazwa akcji listy zamówień albo listy przesyłek (ten sam wiersz postępu, inne rodzaje). */
const nazwaAkcji = (r: string): string => NAZWA_AKCJI[r as RodzajAkcji] ?? NAZWA_AKCJI_PRZESYLEK[r as RodzajPrzesylek] ?? 'Akcja'

export function PostepAkcji({ id, poczatkowy, lista = 'zamowienia' }: { id: string; poczatkowy?: StanAkcji; /** pozycje to przesyłki (bez linku do zamówienia) */ lista?: 'zamowienia' | 'przesylki' }) {
  const czego = lista === 'przesylki' ? 'przesyłek' : 'zamówień'
  const [s, setS] = useState<StanAkcji | null>(poczatkowy ?? null)
  const [uspiony, setUspiony] = useState(false)
  const toast = useToast()
  const router = useRouter()
  const zgloszone = useRef(poczatkowy ? poczatkowy.stan === 'GOTOWE' || poczatkowy.stan === 'BLAD' : false)
  useEffect(() => {
    if (zgloszone.current) return
    let zyje = true
    let ostatnio = { zrobione: poczatkowy?.zrobione ?? -1, kiedy: Date.now() }
    const t = setInterval(async () => {
      try {
        const n = await postepAkcji(id)
        if (!zyje || !n) return
        setS(n)
        if ((n.stan === 'GOTOWE' || n.stan === 'BLAD') && !zgloszone.current) {
          zgloszone.current = true
          clearInterval(t)
          const tekst = n.stan === 'BLAD' ? `${nazwaAkcji(n.rodzaj)}: przerwana.` : n.bledy ? `${nazwaAkcji(n.rodzaj)}: ${n.ok} gotowe, ${n.bledy} z błędem.` : `${nazwaAkcji(n.rodzaj)}: gotowe dla ${n.ok} ${czego}.`
          if (n.bledy || n.stan === 'BLAD') toast.blad(tekst)
          else toast.sukces(tekst)
          router.refresh()
          return
        }
        if (n.zrobione !== ostatnio.zrobione) ostatnio = { zrobione: n.zrobione, kiedy: Date.now() }
        else if (Date.now() - ostatnio.kiedy > BEZ_POSTEPU_MS) {
          clearInterval(t)
          setUspiony(true)
        }
      } catch {
        // sieć: następna próba za chwilę
      }
    }, CO_MS)
    return () => {
      zyje = false
      clearInterval(t)
    }
  }, [id, toast, router]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return <div className="zl-postep" role="status">Akcja w tle: czeka na start…</div>
  const koniec = s.stan === 'GOTOWE' || s.stan === 'BLAD'
  return (
    <div className={`zl-postep${s.stan === 'BLAD' ? ' zl-postep-blad' : ''}`} role="status">
      <div className="zl-postep-glowa">
        <b>{nazwaAkcji(s.rodzaj)}</b>
        <span>
          {s.stan === 'BLAD' ? 'przerwana' : koniec ? 'zakończona' : s.stan === 'CZEKA' ? 'czeka na start' : 'w toku'}: {s.zrobione} z {s.razem}
          {s.zrobione > 0 && ` (gotowe ${s.ok}, z błędem ${s.bledy})`}
        </span>
      </div>
      <progress max={s.razem} value={s.zrobione} aria-label="Postęp akcji" />
      {s.blad && <p className="zl-postep-uwaga">{s.blad}</p>}
      {uspiony && !koniec && <p className="zl-postep-uwaga">Od 10 minut bez postępu. Sprawdź później: odśwież listę, a akcja bez ruchu przez godzinę zostanie oznaczona jako przerwana.</p>}
      {s.przyklady.length > 0 && (
        <ul className="zl-postep-bledy">
          {s.przyklady.map((b) => (
            <li key={b.id}>
              {lista === 'przesylki' ? <b>{b.nr}</b> : <a href={`/zamowienia/${b.id}`}>{b.nr}</a>}: {b.komunikat}
            </li>
          ))}
          {s.bledy > s.przyklady.length && <li>…i {s.bledy - s.przyklady.length} kolejnych{lista === 'przesylki' ? '.' : ' (otwórz zamówienia z filtrem statusu).'}</li>}
        </ul>
      )}
    </div>
  )
}
