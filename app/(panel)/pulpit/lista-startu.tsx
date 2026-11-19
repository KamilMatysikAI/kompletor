// Lista startu na pulpicie: zastępuje kartę „Pierwsze kroki”. Kroki i ich stany liczy
// lib/start/lista.ts z danych firmy; tu tylko widok. „Pomiń”, „Przywróć” i „Ukryj listę” widzi osoba z uprawnieniem
// `ustawienia` (lista dotyczy konfiguracji firmy, inni jej nie dostają).
import Link from 'next/link'
import type { ListaStartu } from '@/lib/start/lista'
import { Karta, Odznaka, Przycisk, PrzyciskLink } from '@/app/ui'
import { zmienKrokStartu } from './akcje'

const ZNAK = { zrobione: '✓', pominiete: '–', do_zrobienia: '' } as const

export function ListaStartuKarta({ lista, firmaZBl }: { lista: ListaStartu; firmaZBl: boolean }) {
  if (lista.ukryta) return null
  if (lista.gotowe) return null
  const procent = Math.round((lista.zrobione / lista.razem) * 100)
  const pierwszyDoZrobienia = lista.kroki.find((k) => k.stan === 'do_zrobienia')?.id
  return (
    <Karta
      id="start"
      className="st-mb"
      tytul="Uruchomienie firmy"
      opis={`Zrobione ${lista.zrobione} z ${lista.razem}. Każdy krok możesz pominąć i wrócić do niego później.`}
      akcje={
        <form action={zmienKrokStartu}>
          <input type="hidden" name="co" value="ukryj" />
          <Przycisk type="submit" wariant="cichy" rozmiar="sm">
            Ukryj listę
          </Przycisk>
        </form>
      }
      stopka={
        !firmaZBl ? (
          <div className="st-stopka">
            <p className="small muted">Przechodzisz z BaseLinkera? Produkty, oferty i stany przeniesiesz bez przepisywania.</p>
            <PrzyciskLink href="/ustawienia/przeprowadzka" wariant="drugorzedny" rozmiar="sm">
              Przenieś z BaseLinkera
            </PrzyciskLink>
          </div>
        ) : undefined
      }
    >
      <div className="st-pasek" role="progressbar" aria-valuemin={0} aria-valuemax={lista.razem} aria-valuenow={lista.zrobione} aria-label="Postęp uruchomienia">
        <i style={{ width: `${procent}%` }} />
      </div>
      <ol className="st-lista">
        {lista.kroki.map((k, i) => (
          <li key={k.id} className="st-krok" data-stan={k.stan}>
            <span className="st-znak" aria-hidden="true">
              {ZNAK[k.stan] || i + 1}
            </span>
            <div>
              <div className="st-tytul">
                <Link href={k.href}>{k.tytul}</Link> {k.stan === 'zrobione' && <Odznaka ton="sukces" rozmiar="sm">zrobione</Odznaka>}
                {k.stan === 'pominiete' && <Odznaka rozmiar="sm">pominięte</Odznaka>}
              </div>
              <p className="st-opis">{k.opis}</p>
            </div>
            <div className="st-akcje">
              {k.stan === 'do_zrobienia' && (
                <>
                  <PrzyciskLink href={k.href} wariant={k.id === pierwszyDoZrobienia ? 'glowny' : 'drugorzedny'} rozmiar="sm">
                    {k.akcja}
                  </PrzyciskLink>
                  <form action={zmienKrokStartu}>
                    <input type="hidden" name="krok" value={k.id} />
                    <input type="hidden" name="co" value="pomin" />
                    <Przycisk type="submit" wariant="cichy" rozmiar="sm" aria-label={`Pomiń: ${k.tytul}`}>
                      Pomiń
                    </Przycisk>
                  </form>
                </>
              )}
              {k.stan === 'pominiete' && (
                <form action={zmienKrokStartu}>
                  <input type="hidden" name="krok" value={k.id} />
                  <input type="hidden" name="co" value="przywroc" />
                  <Przycisk type="submit" wariant="cichy" rozmiar="sm" aria-label={`Przywróć: ${k.tytul}`}>
                    Przywróć
                  </Przycisk>
                </form>
              )}
            </div>
          </li>
        ))}
      </ol>
    </Karta>
  )
}

/** Lista schowana albo skończona: jedna linia z powrotem (żeby „Ukryj listę” nie było nieodwracalne). */
export function ListaStartuSchowana({ lista }: { lista: ListaStartu }) {
  if (!lista.ukryta || lista.gotowe) return null
  return (
    <form action={zmienKrokStartu} className="st-mb">
      <input type="hidden" name="co" value="pokaz" />
      <Przycisk type="submit" wariant="cichy" rozmiar="sm">
        Pokaż listę uruchomienia ({lista.zrobione} z {lista.razem})
      </Przycisk>
    </form>
  )
}
