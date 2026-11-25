// jeden czytelny wynik kliknięcia „Zamów kuriera” z osobnymi odbiorami (Wysyłam z Allegro i każdy moduł
// z `grupyOdbioru`). Dla pakującego w magazynie: co zamówione per przewoźnik (termin, liczba przesyłek), co się nie
// udało i co zrobić. Kody przewoźnika zostają w „szczegóły” przy linii pod paskiem, nie w tym komunikacie.
import { dzienPoLudzku, hm, nazwaGrupyOdbioru, powodPoLudzku, przesylekSlowo } from './kurier-widok'
import type { OdbiorKlikniecia } from './zamowienie-kuriera'

export interface PodsumowanieOdbiorow {
  /** true = przynajmniej jeden odbiór przyjęty (okno się zamyka); false = nic nie zamówiono (okno zostaje). */
  ok: boolean
  /** `info` = wynik częściowy (część przyjęta, część nie), `sukces` = wszystko przyjęte, `blad` = nic nie przyjęto. */
  ton: 'sukces' | 'info' | 'blad'
  komunikat: string
}

const ile = (n: number) => `${n} ${przesylekSlowo(n)}`

/** Podsumowanie wyników odbiorów jednego kliknięcia (`WynikKuriera` z `wynik: 'ODBIORY'`). */
export function podsumowanieOdbiorow(odbiory: readonly OdbiorKlikniecia[], etykieta: string, dzis: string): PodsumowanieOdbiorow {
  // przyjęte: ten sam przewoźnik, termin i numer zlecenia = jeden podjazd (suma przesyłek)
  const przyjete = new Map<string, { nazwa: string; termin: string; numer: string | null; przesylek: number }>()
  const nieudane: string[] = []
  // ogólna rada („Ponów”, „spróbuj ponownie”) tylko dla odmów bez własnej instrukcji (nieznany powód)
  let bezInstrukcji = false
  const niewiadome: string[] = []
  for (const o of odbiory) {
    const nazwa = nazwaGrupyOdbioru(o.grupa) ?? 'przewoźnik bez nazwy'
    const w = o.wynik
    if (w.wynik === 'ZAMOWIONY') {
      const z = w.zlecenie
      const termin = `${dzienPoLudzku(z.dzien, dzis)} ${hm(z.odMin)}–${hm(z.doMin)}`
      const k = `${nazwa}|${termin}|${z.numer ?? ''}`
      const p = przyjete.get(k) ?? { nazwa, termin, numer: z.numer, przesylek: 0 }
      p.przesylek += z.paczki > 0 ? z.paczki : o.przesylek
      przyjete.set(k, p)
    } else if (w.wynik === 'W_TOKU' || w.wynik === 'NIEJEDNOZNACZNY') {
      niewiadome.push(`${nazwa} (${ile(o.przesylek)})`)
    } else {
      const p = powodPoLudzku('powod' in w ? w.powod : null, { podjazd: odbiory.some((x) => x.wynik.wynik === 'ZAMOWIONY') })
      if (!p?.znany) bezInstrukcji = true
      nieudane.push(`${nazwa} (${ile(o.przesylek)}): ${p?.znany ? p.tekst.replace(/\.$/, '') : 'przewoźnik nie przyjął zamówienia (powód przy pasku kuriera)'}`)
    }
  }
  const czesci: string[] = []
  if (przyjete.size)
    czesci.push(`Kurier ${etykieta} zamówiony: ${[...przyjete.values()].map((p) => `${p.nazwa} ${p.termin} (${ile(p.przesylek)}${p.numer ? `, zlecenie nr ${p.numer}` : ''})`).join(', ')}.`)
  if (nieudane.length) {
    const rada = !bezInstrukcji ? '' : przyjete.size ? ' Kliknij „Ponów nieudany odbiór” przy pasku albo zamów ten odbiór w panelu przewoźnika; zamówione odbiory zostają bez zmian.' : ' Spróbuj ponownie albo zamów odbiór w panelu przewoźnika.'
    czesci.push(`Nie udało się: ${nieudane.join('; ')}.${rada}`)
  }
  if (niewiadome.length) czesci.push(`Nie wiadomo, czy przewoźnik przyjął: ${niewiadome.join(', ')}. Sprawdź w panelu przewoźnika i zaznacz wynik przy pasku, nie zamawiaj drugi raz w ciemno.`)
  const ok = przyjete.size > 0
  const ton = ok && !nieudane.length && !niewiadome.length ? 'sukces' : ok ? 'info' : 'blad'
  return { ok, ton, komunikat: czesci.join(' ') }
}
