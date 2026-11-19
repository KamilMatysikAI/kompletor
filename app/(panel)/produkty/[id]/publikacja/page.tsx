// Karta produktu → „Publikacja” (Etap 3a): kafel na każde konto kanału firmy (sklep Woo, Allegro, Empik)
// z podglądem gotowej oferty i przyciskiem „Wystaw” (nieaktywny z powodem, dopóki konto nie ma włączonego wystawiania
// ofert). Firma bez kont tych kanałów dostaje podgląd z danych produktu na trzy kanały. Widzi każdy zalogowany;
// „Wystaw” wymaga uprawnienia do dodawania produktów.
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { NaglowekStrony } from '@/app/ui'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { kontaPublikacji } from '@/lib/oferty/publikacja-serwer'
import { NAZWA_KANALU } from '@/lib/oferty/publikacja'
import { appModeOf } from '@/lib/organizacje'
import { requireSession } from '@/lib/panel/kontekst'
import { KafelKanalu } from './kafel'

export const metadata = { title: 'Publikacja produktu' }

const registry = defaultRegistry()

type Props = { params: Promise<{ id: string }> }

export default async function Publikacja({ params }: Props) {
  const ctx = await requireSession()
  const { id } = await params
  const p = await ctx.db.product.findFirst({ where: { id }, select: { id: true, title: true, sku: true, ean: true } })
  if (!p) notFound()
  const konta = await kontaPublikacji(ctx.db, { registry, src: { env: process.env, envFallback: appModeOf(process.env) === 'self-host' } })
  const bezKont = konta.every((k) => k.konto.kod === null)
  return (
    <>
      <NaglowekStrony
        tytul={`Publikacja: ${p.title}`}
        podtytul={
          <>
            <span className="mono">{p.sku}</span>
            {p.ean ? <> · EAN {p.ean}</> : <> · bez kodu EAN</>} · <Link href={`/produkty/${p.id}`}>wróć do karty produktu</Link>
          </>
        }
      />
      <p className="small">
        Tu widać, jak produkt będzie wyglądał w każdym kanale sprzedaży: z danych karty produktu Kompletor składa tytuł, kategorię, parametry, opis, zdjęcia, cenę i stan. Błędy popraw na karcie produktu, potem kliknij „Odśwież podgląd”. Przycisk „Wystaw” działa tylko na koncie z włączonym wystawianiem ofert (Ustawienia → Sprzedaż i kanały → Kanały sprzedaży → konto → „Zapis do sklepu”).
      </p>
      {bezKont && (
        <p className="muted small">
          Firma nie ma jeszcze konta {NAZWA_KANALU.allegro}, {NAZWA_KANALU.empik} ani sklepu internetowego, więc podgląd powstał z samych danych produktu, bez sprawdzania katalogu i kategorii kanału.
        </p>
      )}
      <div className="pub-kafele">
        {konta.map(({ konto }) => (
          <KafelKanalu
            key={konto.kod ?? `brak:${konto.kanal}`}
            productId={p.id}
            klucz={konto.kod ?? `brak:${konto.kanal}`}
            nazwaKanalu={NAZWA_KANALU[konto.kanal]}
            nazwaKonta={konto.kod ? konto.nazwa : null}
            mozeWystawiac={ctx.permissions.has('produkty.dodawanie')}
          />
        ))}
      </div>
    </>
  )
}
