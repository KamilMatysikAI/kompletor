// Ustawienia → Przewoźnicy → Konta przewoźników: klucze kont przewoźników (szyfrowane,
// panel widzi tylko „ustawiony / brak”), ustawienia kont z manifestu adaptera, wyłączniki nadawania i test połączenia.
// Wejście: przycisk „Konta przewoźników” na ekranie Przewoźnicy. Tylko z uprawnieniem `ustawienia`.
// Wysyłam z Allegro nie ma tu konta: działa na koncie Allegro z Kanałów sprzedaży.
import { Baner, NaglowekStrony, PrzyciskLink } from '@/app/ui'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { CARRIER_LABEL } from '@/lib/panel/format'
import { requirePermission } from '@/lib/panel/kontekst'
import { kontaPrzewoznikow, zrodloKluczyPanelu } from '@/lib/wysylka/konta'
import { regulyPrzewoznikow } from '@/lib/wysylka/reguly'
import { sprawdzKonto, wlaczPonownieKonto } from './akcje'
import { kluczPrzewoznika, wylaczoneKonta } from '@/lib/integracje/zdrowie'
import { WylaczonePoBledach } from '../../../_komponenty/wylaczone-po-bledach'
import { DodajKonto, FormularzKont } from './formularz'

export const metadata = { title: 'Konta przewoźników' }

const registry = defaultRegistry()
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default async function KontaPrzewoznikow({ searchParams }: Props) {
  const ctx = await requirePermission('ustawienia')
  const sp = await searchParams
  const [konta, reguly, wylaczone] = await Promise.all([kontaPrzewoznikow(ctx.db, registry, zrodloKluczyPanelu()), regulyPrzewoznikow(ctx.db), wylaczoneKonta(ctx.db)])
  const now = new Date()
  const test = one(sp.test)
  const blad = one(sp.blad)?.slice(0, 200)
  return (
    <>
      <NaglowekStrony
        tytul="Konta przewoźników"
        podtytul="Klucze i ustawienia kont u przewoźników. Który przewoźnik dla którego zamówienia: ekran Przewoźnicy."
        akcje={
          <PrzyciskLink href="/ustawienia/przewoznicy" wariant="cichy">
            Reguły i odbiory
          </PrzyciskLink>
        }
      />
      <div className="stack">
        {test === 'zlecono' && (
          <Baner ton="info" rola="status">
            Test połączenia zlecony. Wynik pojawi się przy koncie w ciągu kilkunastu sekund (odśwież stronę).
          </Baner>
        )}
        {test === 'wlaczanie' && (
          <Baner ton="info" rola="status">
            Sprawdzam połączenie. Gdy test przejdzie, konto wróci do pracy samo (odśwież stronę za kilkanaście sekund).
          </Baner>
        )}
        {/* konta wyłączone automatycznie po serii błędów połączenia */}
        {konta.map((k) => {
          const s = wylaczone.get(kluczPrzewoznika(k.id))
          return s ? <WylaczonePoBledach key={`wyl-${k.id}`} stan={s} now={now} akcja={wlaczPonownieKonto} pola={{ konto: k.id }} nazwa={k.nazwa} /> : null
        })}
        {test === 'za-czesto' && (
          <Baner ton="ostrzezenie" rola="status">
            Test tego konta był przed chwilą albo jeszcze trwa. Spróbuj za pół minuty.
          </Baner>
        )}
        {blad && (
          <Baner ton="blad" rola="alert">
            {blad}
          </Baner>
        )}
        <Baner ton="info" rola="note">
          Wysyłam z Allegro korzysta z konta Allegro w Kanałach sprzedaży, więc nie ma tu osobnych kluczy.
        </Baner>
        <FormularzKont konta={konta} przewoznicy={CARRIER_LABEL} priorytety={reguly.map((r) => r.priority)} />
        <DodajKonto glowne={konta.filter((k) => !k.sufiks).map((k) => ({ wartosc: k.id, etykieta: k.nazwa }))} />
      </div>
      {konta.map((k) => (
        <form key={k.id} id={`test-${k.id}`} action={sprawdzKonto} hidden>
          <input type="hidden" name="konto" value={k.id} />
        </form>
      ))}
    </>
  )
}
