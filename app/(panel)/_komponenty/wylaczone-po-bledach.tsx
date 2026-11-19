// baner „Wyłączone po błędach” w szczegółach konta integracji (kanał sprzedaży, przewoźnik): powód, od kiedy,
// wynik ostatniej próby włączenia i przycisk „Włącz ponownie” (najpierw test połączenia w kolejce, potem powrót konta do
// poprzedniego trybu). Wspólny dla ekranów Ustawienia → Kanały sprzedaży → konto i Ustawienia → Przewoźnicy.
import { Baner, Przycisk } from '@/app/ui'
import { type StanWylaczenia, wlaczanieTrwa } from '@/lib/integracje/zdrowie'
import { when } from '@/lib/panel/format'

export function WylaczonePoBledach({ stan, now, akcja, pola, nazwa }: { stan: StanWylaczenia; now: Date; akcja: (form: FormData) => Promise<void>; pola: Record<string, string>; /** nazwa konta, gdy ekran ma kilka kont */ nazwa?: string }) {
  // zlecenie starsze niż 5 min bez wyniku nie blokuje przycisku (jedyna droga powrotu konta)
  const trwa = wlaczanieTrwa(stan, now)
  return (
    <Baner
      ton="blad"
      tytul={nazwa ? `${nazwa}: wyłączone po błędach.` : 'Wyłączone po błędach.'}
      rola="alert"
      akcja={
        <form action={akcja}>
          {Object.entries(pola).map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          <Przycisk wariant="glowny" type="submit" ladowanie={trwa}>
            Włącz ponownie
          </Przycisk>
        </form>
      }
    >
      Kompletor przestał wołać to konto {when(stan.disabledAt, now)}, bo połączenie nie działało {stan.porazki} razy z rzędu ({stan.powod}). Nic nie zginęło: zamówienia, stany i zapisy czekają. Popraw klucze albo adres i kliknij „Włącz ponownie”: najpierw sprawdzimy połączenie, a gdy działa, konto wróci do pracy w tym samym trybie co przedtem.
      {stan.wlaczanieOd && trwa && <> Sprawdzam połączenie (zlecone {when(stan.wlaczanieOd, now)}).</>}
      {stan.wlaczanieOd && !trwa && <> Poprzednia próba włączenia (zlecona {when(stan.wlaczanieOd, now)}) nie dała wyniku: kliknij „Włącz ponownie” jeszcze raz.</>}
      {stan.ostatniaProba && <> Ostatnia próba włączenia nie przeszła: {stan.ostatniaProba}.</>}
    </Baner>
  )
}
