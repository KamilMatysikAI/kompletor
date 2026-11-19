// Ekran konta WooCommerce → „Połączenie ze sklepem”: „Połącz z WooCommerce” bez kopiowania kluczy
// (strona zatwierdzenia w sklepie, wc-auth), osobno „Połącz z prawem zapisu” dla wersji z zapisem, stan trwającego
// łączenia z odświeżaniem i „Anuluj”. Gdy panel nie ma publicznego adresu https, przyciski są wyszarzone z powodem,
// a ręczne wklejenie kluczy („Ustawienia i klucze”) działa jak dotąd. Bez wartości kluczy w HTML.
import Link from 'next/link'
import type { StanWoo } from '@/lib/kanaly/woo-autoryzacja'
import { when } from '@/lib/panel/format'
import { Baner, Karta, Odznaka, Przycisk } from '@/app/ui'
import { anulujWoo, polaczZWoo } from '../akcje'
import { Odswiezanie } from '../odswiezanie'

export function PolaczenieWoo({ kod, s, now, maKlucze, maKluczZapisu }: { kod: string; s: StanWoo; now: Date; maKlucze: boolean; maKluczZapisu: boolean }) {
  const stan = s.trwa
    ? { ton: 'info' as const, tekst: 'Czeka na sklep' }
    : maKlucze
      ? { ton: 'sukces' as const, tekst: 'Klucze zapisane' }
      : { ton: 'ostrzezenie' as const, tekst: 'Niepołączone' }
  const powod = s.panel.ok ? undefined : s.panel.powod
  return (
    <Karta id="woo" tytul="Połączenie ze sklepem" akcje={<Odznaka ton={stan.ton} kropka>{stan.tekst}</Odznaka>}>
      {s.trwa ? (
        <>
          <Baner ton="info" rola="status" tytul="Czekam na zatwierdzenie w sklepie.">
            W otwartej karcie zaloguj się w WordPressie jako administrator sklepu i kliknij „Zatwierdź”. Klucze zapiszą się same, a ekran odświeży się sam. Link jest ważny do {when(s.trwa.wazneDo, now)}.
          </Baner>
          <div className="kn-akcje">
            <form action={polaczZWoo}>
              <input type="hidden" name="konto" value={kod} />
              <input type="hidden" name="zakres" value={s.trwa.zakres} />
              <Przycisk wariant="glowny" type="submit" powodWylaczenia={powod}>
                Otwórz sklep jeszcze raz
              </Przycisk>
            </form>
            <form action={anulujWoo}>
              <input type="hidden" name="konto" value={kod} />
              <Przycisk wariant="cichy" type="submit">
                Anuluj
              </Przycisk>
            </form>
          </div>
          <Odswiezanie aktywne />
        </>
      ) : (
        <>
          <p className="small">
            {maKlucze
              ? 'Kompletor ma klucze do tego sklepu. Połącz ponownie, gdy klucz został usunięty w WordPressie albo chcesz nowy.'
              : 'Kliknij „Połącz z WooCommerce”: otworzy się panel WordPressa, zalogujesz się jako administrator sklepu i klikniesz „Zatwierdź”. Klucze zapiszą się same (zaszyfrowane), a potem sprawdzimy połączenie.'}
          </p>
          <div className="kn-akcje">
            <form action={polaczZWoo}>
              <input type="hidden" name="konto" value={kod} />
              <input type="hidden" name="zakres" value="read" />
              <Przycisk wariant={maKlucze ? 'drugorzedny' : 'glowny'} type="submit" powodWylaczenia={powod}>
                {maKlucze ? 'Połącz ponownie z WooCommerce' : 'Połącz z WooCommerce'}
              </Przycisk>
            </form>
            {s.maZapis && (
              <form action={polaczZWoo}>
                <input type="hidden" name="konto" value={kod} />
                <input type="hidden" name="zakres" value="read_write" />
                <Przycisk type="submit" powodWylaczenia={powod}>
                  {maKluczZapisu ? 'Nowy klucz z prawem zapisu' : 'Połącz z prawem zapisu'}
                </Przycisk>
              </form>
            )}
          </div>
          {powod && <p className="muted small">{powod}</p>}
          <p className="muted small">
            {s.maZapis
              ? 'Pierwszy przycisk daje klucz tylko do odczytu. Klucz z prawem zapisu jest osobny; sam zapis do sklepu i tak rusza dopiero po włączeniu w sekcji „Zapis do sklepu”. '
              : 'Klucz z tego przycisku ma tylko prawo odczytu. '}
            Wolisz wkleić klucze sam? Wklej je niżej, w sekcji <a href="#ustawienia">„Ustawienia i klucze”</a>.
          </p>
          <p className="muted small">
            <Link href="/pomoc/integracje">Pomoc: jak połączyć WooCommerce</Link>
          </p>
        </>
      )}
    </Karta>
  )
}
