// Sekcja „Przesyłka” karty zamówienia (jedna sekcja „Dostawa i przesyłki”): przesyłka
// (`BlokPrzesylki`: podgląd, nadanie z gabarytem, etykieta, poprawka adresu) i przejście na
// stanowisko pakowania. (wzór układu TwojOMS, MIT): sposób wysyłki, przewoźnik i koszt z kanału są w karcie
// „Wysyłka” na górze (klient.tsx), a ta sekcja stoi obok „Płatności”; nagłówek w pasku (app/ui/sekcja.tsx).
import { PrzyciskLink, Sekcja } from '@/app/ui'
import type { DaneKarty } from '@/lib/karta/dane'
import type { PanelContext } from '@/lib/panel/kontekst'
import { BlokDrogiPaczek } from './droga-paczki'
import { BlokPrzesylki } from './przesylka'

/** `podzialAdresu`: linia adresu do podziału przez asystenta AI, liczone z odczytu danych klienta w page.tsx. */
export function Dostawa({ d, ctx, podzialAdresu = false }: { d: DaneKarty; ctx: PanelContext; podzialAdresu?: boolean }) {
  const { o } = d
  const pakuj = d.coDalej?.stanowisko && ctx.permissions.has('pakowanie.stanowisko')
  return (
    <Sekcja
      id="dostawa"
      tytul="Przesyłka"
      akcje={
        pakuj ? (
          <PrzyciskLink href={`/stanowisko?z=${o.id}`} rozmiar="sm">
            Pakuj na stanowisku
          </PrzyciskLink>
        ) : null
      }
    >
      <BlokPrzesylki ctx={ctx} orderId={o.id} przewoznikKanalu={o.carrier} powodPodgladu={d.podglad?.powody.status ?? null} podzialAdresu={podzialAdresu} />
      {/* droga paczki u przewoźnika: numer, link śledzenia, stan i historia (tylko odczyt, dla każdego z dostępem do karty) */}
      <BlokDrogiPaczek ctx={ctx} orderId={o.id} />
    </Sekcja>
  )
}
