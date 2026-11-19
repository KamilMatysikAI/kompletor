'use client'
// Dymek „Zapytaj” w prawym dolnym rogu panelu: pytanie zwykłym językiem, odpowiedź z Pomocy z odnośnikiem do rozdziału
// i „Pomoc do tego ekranu”. Renderuje go layout tylko przy włączonym asystencie firmy (Ustawienia → Agenci AI).
// Styl z klas panelu (card, btn, input, banner), bez własnej palety. Położenie (nad paskiem zapisu, toasty nad dymkiem,
// warstwa pod menu na telefonie) ustawia app/panel.css, sekcja „Asystent”.
import { useEffect, useRef, useState, useTransition } from 'react'
import { usePathname } from 'next/navigation'
import { zapytajAsystentaAkcja } from './asystent-akcje'
import type { WynikAsystenta } from '@/lib/asystent/asystent'
import { pomocEkranu } from '@/lib/asystent/ekrany'

export function Asystent() {
  const sciezka = usePathname() ?? ''
  const [otwarty, setOtwarty] = useState(false)
  const [pytanie, setPytanie] = useState('')
  const [zadane, setZadane] = useState('')
  const [wynik, setWynik] = useState<WynikAsystenta | null>(null)
  const [pending, start] = useTransition()
  const pole = useRef<HTMLTextAreaElement>(null)
  const przycisk = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (otwarty) pole.current?.focus()
  }, [otwarty])

  // Pasek „Zapisz zmiany” w dole ekranu: dymek (i toasty nad nim) wchodzą nad pasek, żeby nie zasłaniać jego przycisków.
  // Liczone z położenia paska, bo pasek bywa przyklejony do dołu ekranu albo stoi na końcu formularza.
  useEffect(() => {
    const html = document.documentElement
    let klatka = 0
    const licz = () => {
      klatka = 0
      const r = document.querySelector<HTMLElement>(".ui-pasek-zapisu[data-zmiany='tak']")?.getBoundingClientRect()
      const wys = window.innerHeight
      // lewa krawędź dymka w spoczynku (prawy margines 16 px); pasek kończący się przed nią nie koliduje
      const lewaDymka = window.innerWidth - 16 - (przycisk.current?.offsetWidth ?? 120) - 8
      if (r && r.height > 0 && r.top < wys && r.bottom > wys - 80 && r.right > lewaDymka) html.style.setProperty('--asystent-dol', `${Math.round(wys - r.top + 12)}px`)
      else html.style.removeProperty('--asystent-dol')
    }
    const zaplanuj = () => {
      if (!klatka) klatka = requestAnimationFrame(licz)
    }
    const obserwator = new MutationObserver(zaplanuj)
    obserwator.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-zmiany', 'data-ukryty', 'hidden'] })
    window.addEventListener('scroll', zaplanuj, { passive: true, capture: true })
    window.addEventListener('resize', zaplanuj)
    zaplanuj()
    return () => {
      obserwator.disconnect()
      window.removeEventListener('scroll', zaplanuj, { capture: true })
      window.removeEventListener('resize', zaplanuj)
      if (klatka) cancelAnimationFrame(klatka)
      html.style.removeProperty('--asystent-dol')
    }
  }, [sciezka])

  const zamknij = () => {
    setOtwarty(false)
    przycisk.current?.focus()
  }

  const wyslij = () => {
    const p = pytanie.trim()
    if (!p || pending) return
    start(async () => {
      setZadane(p)
      try {
        setWynik(await zapytajAsystentaAkcja(p, sciezka))
      } catch {
        setWynik({ ok: false, error: 'Nie udało się zadać pytania. Sprawdź połączenie i spróbuj jeszcze raz.' })
      }
    })
  }

  return (
    <div className="asystent">
      {otwarty && (
        <section className="card asystent-okno" id="asystent-okno" role="dialog" aria-modal="false" aria-labelledby="asystent-tytul" onKeyDown={(e) => e.key === 'Escape' && zamknij()}>
          <div className="asystent-glowa">
            <h2 id="asystent-tytul">Zapytaj o obsługę panelu</h2>
            <button type="button" className="btn ghost small" onClick={zamknij} aria-label="Zamknij asystenta">
              Zamknij
            </button>
          </div>
          <p className="muted small asystent-opis">Odpowiadam z Pomocy Kompletora. Nie widzę Twoich zamówień ani danych klientów.</p>
          <form
            className="stack asystent-formularz"
            onSubmit={(e) => {
              e.preventDefault()
              wyslij()
            }}
          >
            <label className="sr-only" htmlFor="asystent-pytanie">
              Twoje pytanie
            </label>
            <textarea
              ref={pole}
              id="asystent-pytanie"
              className="input"
              rows={2}
              maxLength={500}
              placeholder="Np. jak zrobić korektę faktury?"
              value={pytanie}
              onChange={(e) => setPytanie(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  wyslij()
                }
              }}
            />
            <button className="btn primary" type="submit" disabled={pending || !pytanie.trim()}>
              {pending ? 'Szukam w Pomocy…' : 'Zapytaj'}
            </button>
          </form>
          <div aria-live="polite" className="asystent-wynik">
            {pending && <p className="small muted asystent-pytanie">Szukam w Pomocy…</p>}
            {wynik && !pending && (
              <>
                <p className="small muted asystent-pytanie">{zadane}</p>
                {wynik.ok ? (
                  <>
                    <p className={wynik.nieWiem ? 'asystent-odpowiedz muted' : 'asystent-odpowiedz'}>{wynik.odpowiedz}</p>
                    {wynik.zrodla.length > 0 && (
                      <div className="small">
                        <b>W Pomocy:</b>
                        <ul className="asystent-zrodla">
                          {wynik.zrodla.map((z) => (
                            <li key={z.href}>
                              <a href={z.href}>{z.tytul}</a>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {wynik.nieWiem && (
                      <p className="small">
                        <a href="/pomoc">Otwórz spis Pomocy</a>
                      </p>
                    )}
                  </>
                ) : (
                  <div className="banner red">
                    <div>{wynik.error}</div>
                  </div>
                )}
              </>
            )}
          </div>
          <PomocEkranu sciezka={sciezka} />
        </section>
      )}
      <button ref={przycisk} type="button" className="btn primary asystent-dymek" aria-expanded={otwarty} aria-controls={otwarty ? 'asystent-okno' : undefined} onClick={() => (otwarty ? zamknij() : setOtwarty(true))}>
        <span aria-hidden="true" className="asystent-znak">
          ?
        </span>
        Zapytaj
      </button>
    </div>
  )
}

function PomocEkranu({ sciezka }: { sciezka: string }) {
  if (sciezka.startsWith('/pomoc')) return null
  const p = pomocEkranu(sciezka)
  return (
    <p className="small asystent-ekran">
      {p ? (
        <>
          Pomoc do tego ekranu: <a href={p.href}>{p.nazwa}</a>
        </>
      ) : (
        <a href="/pomoc">Spis Pomocy</a>
      )}
    </p>
  )
}
