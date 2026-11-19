// Pomoc: spis dokumentów użytkownika z katalogu docs/ (te same pliki co w repozytorium). Widzi każda
// zalogowana osoba z podglądem panelu. Na górze „Pierwsze kroki” (bez BaseLinkera i wFirmy)
// i „Co jeszcze nie działa”, niżej grupy według odbiorcy (właściciel i biuro, magazyn, administrator), a nad
// wszystkim wyszukiwarka po tytułach i treści (`?q=`, lib/pomoc/szukaj.ts). Osoba z rolą Magazyn widzi swoją grupę
// pierwszą.
import Link from 'next/link'
import type { ReactNode } from 'react'
import { NaglowekStrony, PasekFiltrow, PrzyciskLink, PustyStan } from '@/app/ui'
import { listDocs, SLUG_BRAKI, SLUG_START, type DocEntry } from '@/lib/pomoc/dokumenty'
import { ROLE_POMOCY, rolaDokumentu, rolaOsoby } from '@/lib/pomoc/role'
import { szukajWPomocy, type WynikPomocy } from '@/lib/pomoc/szukaj'
import { requireSession } from '@/lib/panel/kontekst'

export const metadata = { title: 'Pomoc' }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

/** Fragment wyniku z podświetlonymi słowami zapytania (zakresy liczy wyszukiwarka). */
function Podswietlony({ wynik }: { wynik: WynikPomocy }): ReactNode {
  const czesci: ReactNode[] = []
  let od = 0
  for (const [a, b] of wynik.zaznaczenia) {
    if (a > od) czesci.push(wynik.fragment.slice(od, a))
    czesci.push(<mark key={a}>{wynik.fragment.slice(a, b)}</mark>)
    od = b
  }
  if (od < wynik.fragment.length) czesci.push(wynik.fragment.slice(od))
  return <>{czesci}</>
}

function ListaDokumentow({ docs }: { docs: DocEntry[] }) {
  return (
    <ul className="plain set-list card pomoc-lista">
      {docs.map((d) => (
        <li key={d.slug}>
          <Link href={`/pomoc/${d.slug}`}>
            <b>{d.title}</b>
            <span className="muted small">{d.description}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

export default async function Pomoc({ searchParams }: Props) {
  const ctx = await requireSession()
  const sp = await searchParams
  const q = (typeof sp.q === 'string' ? sp.q : '').trim().slice(0, 200)
  const docs = listDocs()
  const start = docs.find((d) => d.slug === SLUG_START)
  const braki = docs.find((d) => d.slug === SLUG_BRAKI)
  const reszta = docs.filter((d) => d.slug !== SLUG_BRAKI && d.slug !== SLUG_START)
  const moja = rolaOsoby(ctx.organization.role)
  const grupy = [...ROLE_POMOCY].sort((a, b) => Number(b.rola === moja) - Number(a.rola === moja))
  const wyniki = q ? szukajWPomocy(q) : []
  const tytulRoli = new Map(ROLE_POMOCY.map((r) => [r.rola, r.tytul]))

  return (
    <>
      <NaglowekStrony
        tytul="Pomoc"
        podtytul="Jak pracować w Kompletorze: od pierwszego zamówienia, przez pakowanie i wysyłkę, po ustawienia firmy."
        akcje={
          <PrzyciskLink href="/pomoc#administrator" wariant="cichy" rozmiar="sm">
            Dokumentacja dla administratora
          </PrzyciskLink>
        }
      />
      <PasekFiltrow akcja="/pomoc" szukaj={{ nazwa: 'q', wartosc: q, etykieta: 'Szukaj w Pomocy', podpowiedz: 'np. faktura, zwrot, etykieta, paczkomat' }} wyczysc="/pomoc" />

      {q ? (
        <section aria-labelledby="h-wyniki" className="pomoc-wyniki">
          <h2 id="h-wyniki">
            {wyniki.length === 0 ? 'Brak wyników' : `Wyniki: ${wyniki.length}`} dla „{q}”
          </h2>
          {wyniki.length === 0 ? (
            <PustyStan tytul="Nic nie pasuje do wszystkich słów" akcja={<Link href="/pomoc">Pokaż wszystkie tematy</Link>}>
              Spróbuj krótszego zapytania albo innego słowa, np. „przesyłka” zamiast „wysyłka paczki”.
            </PustyStan>
          ) : (
            <ul className="plain set-list card pomoc-lista">
              {wyniki.map((w) => (
                <li key={w.slug}>
                  <Link href={w.href}>
                    <b>
                      {w.tytul}
                      {w.sekcja && <span className="muted"> · {w.sekcja}</span>}
                    </b>
                    <span className="small">
                      <Podswietlony wynik={w} />
                    </span>
                    <span className="muted small">{tytulRoli.get(w.rola)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : (
        <>
          {start && (
            <section className="card pomoc-start" aria-labelledby="h-start">
              <h2 id="h-start">{start.title}</h2>
              <p className="small">{start.description}</p>
              <PrzyciskLink href={`/pomoc/${start.slug}`} wariant="glowny" rozmiar="sm">
                Zacznij tutaj
              </PrzyciskLink>
            </section>
          )}
          {braki && (
            <section className="card pomoc-braki" aria-labelledby="h-braki">
              <h2 id="h-braki">{braki.title}</h2>
              <p className="small">{braki.description}</p>
              <PrzyciskLink href={`/pomoc/${braki.slug}`} rozmiar="sm">
                Co działa, a czego nie ma
              </PrzyciskLink>
            </section>
          )}
          {reszta.length === 0 && !start && !braki ? (
            <p className="muted">Brak dokumentów pomocy w tej instalacji.</p>
          ) : (
            grupy.map((g) => {
              const wGrupie = reszta.filter((d) => rolaDokumentu(d.slug) === g.rola)
              if (wGrupie.length === 0) return null
              return (
                <section key={g.rola} className="pomoc-grupa" aria-labelledby={`h-${g.rola}`} id={g.rola}>
                    <h2 id={`h-${g.rola}`}>{g.tytul}</h2>
                    <p className="muted small">{g.opis}</p>
                    <ListaDokumentow docs={wGrupie} />
                </section>
              )
            })
          )}
        </>
      )}
    </>
  )
}
