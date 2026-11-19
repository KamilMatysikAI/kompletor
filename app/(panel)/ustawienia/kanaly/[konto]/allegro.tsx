// Ekran konta Allegro → „Połączenie z Allegro”: stan połączenia (połączone / wymaga ponownego połączenia /
// brak), funkcje z zakresu ostatniej autoryzacji, termin tokenu (odnawia go system sam), przycisk „Połącz z Allegro”
// z wyborem funkcji, a w trakcie: link i kod do przepisania + odpytywanie w tle. Polecenie z terminala zostaje
// alternatywą (opis w Pomocy). Bez wartości tokenów i kodu urządzenia w HTML.
import type { StanAllegro } from '@/lib/kanaly/allegro-autoryzacja'
import { FUNKCJE_ALLEGRO, DOMYSLNE_FUNKCJE_ALLEGRO, etykietyFunkcji } from '@/lib/zrodla/allegro-zakresy'
import { when } from '@/lib/panel/format'
import { Baner, Karta, ListaOpisowa, Odznaka, Przycisk, PrzyciskLink } from '@/app/ui'
import { anulujAllegro, polaczZAllegro } from '../akcje'
import { AllegroCzekanie } from './allegro-czekanie'

export function PolaczenieAllegro({ kod, s, now }: { kod: string; s: StanAllegro; now: Date }) {
  const stan = s.trwa
    ? { ton: 'info' as const, tekst: 'Czeka na zatwierdzenie' }
    : s.odrzucone
      ? { ton: 'blad' as const, tekst: 'Wymaga ponownego połączenia' }
      : s.polaczone
        ? { ton: 'sukces' as const, tekst: 'Połączone' }
        : { ton: 'ostrzezenie' as const, tekst: 'Niepołączone' }
  const zaznaczone = new Set(s.funkcje ?? DOMYSLNE_FUNKCJE_ALLEGRO)
  return (
    <Karta id="allegro" tytul="Połączenie z Allegro" akcje={<Odznaka ton={stan.ton} kropka>{stan.tekst}</Odznaka>}>
      {!s.maKlucze && <Baner ton="ostrzezenie">Najpierw zapisz Client ID i Client Secret aplikacji Allegro w sekcji „Klucze” niżej.</Baner>}
      {s.odrzucone && !s.trwa && (
        <Baner ton="blad" rola="alert">
          Allegro odrzuciło dostęp (konto wylogowane albo autoryzacja starsza niż 3 miesiące bez użycia). Zamówienia z tego konta nie przychodzą, dopóki nie połączysz go ponownie.
        </Baner>
      )}
      {s.polaczone && (
        <ListaOpisowa
          kolumny={2}
          pozycje={[
            { etykieta: 'Kompletor może', wartosc: s.funkcje ? etykietyFunkcji(s.funkcje).join(', ') : 'odczyt zamówień (zakres sprzed zmiany: połącz ponownie, żeby zobaczyć pełny)' },
            { etykieta: 'Odnowienie dostępu', wartosc: s.tokenWaznyDo ? `samo, ostatnio ${s.odnowionoAt ? when(s.odnowionoAt, now) : 'nieznane'}; obecny ważny do ${when(s.tokenWaznyDo, now)}` : 'samo, przy pierwszym odczycie' },
          ]}
        />
      )}
      {s.trwa ? (
        <>
          <p>
            1. Otwórz Allegro i zaloguj się na konto sprzedawcy. 2. Sprawdź, czy kod na stronie Allegro jest taki sam: <span className="kn-kod">{s.trwa.kod}</span> 3. Kliknij „Zezwól”. Ekran odświeży się sam.
          </p>
          <div className="kn-akcje">
            <PrzyciskLink wariant="glowny" href={s.trwa.link} target="_blank" rel="noopener noreferrer">
              Otwórz Allegro i zatwierdź
            </PrzyciskLink>
            <form action={anulujAllegro}>
              <input type="hidden" name="konto" value={kod} />
              <Przycisk wariant="cichy" type="submit">
                Anuluj
              </Przycisk>
            </form>
          </div>
          <p className="muted small">
            Link jest ważny do {when(s.trwa.wazneDo, now)}. Na innym urządzeniu wejdź na <span className="kn-zawijaj">{s.trwa.linkBezKodu}</span> i wpisz kod. Funkcje: {etykietyFunkcji(s.trwa.funkcje).join(', ')}.
          </p>
          <AllegroCzekanie kod={kod} wazneDo={s.trwa.wazneDo.toISOString()} />
        </>
      ) : (
        <form action={polaczZAllegro}>
          <input type="hidden" name="konto" value={kod} />
          <fieldset className="kn-funkcje">
            <legend>Do czego Kompletor ma mieć dostęp</legend>
            {FUNKCJE_ALLEGRO.map((f) => (
              <label key={f.funkcja} className="kn-funkcja">
                <input type="checkbox" name="funkcja" value={f.funkcja} defaultChecked={f.wymagana || zaznaczone.has(f.funkcja)} disabled={f.wymagana} />
                <span>
                  <b>{f.etykieta}</b>
                  <small>
                    {f.opis}
                    {f.wymagana ? ' Zawsze.' : f.zapis ? ' Zapis rusza dopiero po włączeniu zapisu i trybu „Aktywny” na tym koncie.' : ''}
                  </small>
                </span>
              </label>
            ))}
          </fieldset>
          <Przycisk wariant={s.polaczone && !s.odrzucone ? 'drugorzedny' : 'glowny'} type="submit" powodWylaczenia={s.maKlucze ? undefined : 'Najpierw zapisz Client ID i Client Secret'}>
            {s.polaczone ? 'Połącz ponownie z Allegro' : 'Połącz z Allegro'}
          </Przycisk>
          <p className="muted small">
            Nowe połączenie zastępuje poprzednie: zaznacz wszystko, czego Kompletor ma używać. Dotychczasowe działa, dopóki nie zatwierdzisz nowego w Allegro.
          </p>
        </form>
      )}
    </Karta>
  )
}
