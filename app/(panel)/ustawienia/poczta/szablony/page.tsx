// Ustawienia → Poczta → Szablony: treść maili firmy. Lista szablonów, edytor tekstów (temat, podgląd w
// skrzynce, nagłówek, akapity, etykiety), lista zmiennych i podgląd z danymi fikcyjnymi. Układ maila, adresy przycisków
// i warunki zostają z kodu. Tylko z uprawnieniem `ustawienia`. Ekran na komponentach app/ui, wynik jako toast.
import { Baner, Karta, NaglowekStrony, PoleTekstowe, PoleWielowierszowe, Przycisk, PrzyciskLink, Tabela, Zakladki } from '@/app/ui'
import { requirePermission } from '@/lib/panel/kontekst'
import { isRodzajEdytowalny, nadpisanieZFormularza, NAZWA_SZABLONU, podgladSzablonu, RODZAJE_EDYTOWALNE, widokSzablonu, type RodzajEdytowalny } from '@/lib/poczta/szablony'
import { ToastZAdresu } from '../../kanaly/toast-z-adresu'
import { przywrocSzablon, zapiszSzablonFirmy } from './akcje'

export const metadata = { title: 'Szablony maili' }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
const DT = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Warsaw' })

export default async function Szablony({ searchParams }: Props) {
  const ctx = await requirePermission('ustawienia')
  const sp = await searchParams
  const wybrany = one(sp.rodzaj) ?? ''
  const rodzaj: RodzajEdytowalny = isRodzajEdytowalny(wybrany) ? wybrany : RODZAJE_EDYTOWALNE[0]
  const [v, zmienione] = await Promise.all([widokSzablonu(ctx.db, rodzaj), ctx.db.mailTemplate.findMany({ select: { kind: true } })])
  const zm = new Set(zmienione.map((z) => z.kind))
  const pg = podgladZapisanego(v)
  const blad = one(sp.blad)?.slice(0, 500)
  const sukces = one(sp.zapisano) === '1' ? 'Zapisano. Kolejne maile pójdą z nową treścią.' : one(sp.przywrocono) === '1' ? 'Przywrócono treść domyślną.' : null
  return (
    <>
      <ToastZAdresu sukces={sukces} blad={blad} zostaw={{ rodzaj }} />
      <NaglowekStrony
        tytul="Szablony maili"
        podtytul={`Treść maili do klientów i do biura. Zmienne w podwójnych nawiasach (np. ${'{{numerZamowienia}}'}) wstawia system. Pusty akapit znika z maila. Adresy przycisków i układ są stałe. Reset hasła i zaproszenie do firmy mają stałą treść.`}
        akcje={
          <PrzyciskLink href="/ustawienia/poczta" wariant="cichy">
            Poczta
          </PrzyciskLink>
        }
      />

      <Zakladki
        etykieta="Szablony"
        zakladki={RODZAJE_EDYTOWALNE.map((r) => ({ href: `/ustawienia/poczta/szablony?rodzaj=${r}`, etykieta: `${NAZWA_SZABLONU[r]}${zm.has(r) ? ' (zmieniony)' : ''}`, aktywna: r === rodzaj }))}
      />

      <div className="stack">
        <form action={zapiszSzablonFirmy} className="stack" aria-label={`Szablon ${v.nazwa}`}>
          <input type="hidden" name="rodzaj" value={rodzaj} />
          <Karta
            tytul={v.nazwa}
            id="tresc"
            opis={`${v.odbiorca === 'biuro' ? 'Do biura firmy' : 'Do klienta sklepu'}${v.zmienionyKiedy ? ` · zmieniony ${DT.format(v.zmienionyKiedy)}` : ' · treść domyślna'}`}
            stopka={
              <Przycisk wariant="glowny" type="submit">
                Zapisz szablon
              </Przycisk>
            }
          >
            <PoleTekstowe id="s-temat" name="temat" etykieta="Temat" defaultValue={v.temat} maxLength={300} required />
            <PoleTekstowe id="s-podglad" name="podglad" etykieta="Tekst podglądu w skrzynce" defaultValue={v.podglad} maxLength={300} opcjonalne />
            <PoleTekstowe id="s-naglowek" name="naglowek" etykieta="Nagłówek" defaultValue={v.naglowek} maxLength={200} required />
            {v.pola.map((p) =>
              p.wielolinijkowe ? (
                <PoleWielowierszowe key={p.nazwa} id={`s-${p.nazwa}`} name={p.nazwa} etykieta={p.etykieta} rows={3} defaultValue={p.wartosc} maxLength={2000} />
              ) : (
                <PoleTekstowe key={p.nazwa} id={`s-${p.nazwa}`} name={p.nazwa} etykieta={p.etykieta} defaultValue={p.wartosc} maxLength={300} />
              ),
            )}
          </Karta>
        </form>

        {v.zmieniony && (
          <form action={przywrocSzablon} aria-label="Przywróć treść domyślną">
            <input type="hidden" name="rodzaj" value={rodzaj} />
            <Przycisk type="submit">Przywróć treść domyślną</Przycisk>
          </form>
        )}

        <Karta tytul="Zmienne" id="zmienne" opis={`Zmienną nieobowiązkową wstaw w sekcji ${'{{#nazwa}}…{{/nazwa}}'}: tekst pojawi się tylko, gdy wartość jest.`}>
          <Tabela
            id="poczta-zmienne"
            etykieta="Zmienne szablonu"
            kolumny={[
              { klucz: 'zmienna', etykieta: 'Zmienna' },
              { klucz: 'opis', etykieta: 'Co to' },
              { klucz: 'wymagana', etykieta: 'Zawsze jest' },
            ]}
            wiersze={v.zmienne.map((z) => ({ id: z.nazwa, komorki: { zmienna: <span className="mono">{`{{${z.nazwa}}}`}</span>, opis: z.opis, wymagana: z.wymagana ? 'tak' : 'nie' } }))}
          />
        </Karta>

        <Karta tytul="Podgląd" id="podglad" opis="Dane fikcyjne (sklep „Żółwik”, klient Jan). Zapisana treść.">
          {pg ? (
            <>
              <p>
                <b>Temat:</b> {pg.temat}
              </p>
              <iframe title={`Podgląd maila ${v.nazwa}`} sandbox="" srcDoc={pg.html} width="100%" height="640" />
              <details>
                <summary>Wersja tekstowa</summary>
                <pre className="snippet">{pg.tekst}</pre>
              </details>
            </>
          ) : (
            <Baner ton="ostrzezenie">Podgląd niedostępny: popraw treść szablonu.</Baner>
          )}
        </Karta>
      </div>
    </>
  )
}

function podgladZapisanego(v: Awaited<ReturnType<typeof widokSzablonu>>): { temat: string; tekst: string; html: string } | null {
  try {
    // widok ma już scaloną treść firmy (temat, nagłówek, teksty bloków), więc podgląd = te same teksty na strukturze domyślnej
    const f = new FormData()
    f.set('temat', v.temat)
    f.set('podglad', v.podglad)
    f.set('naglowek', v.naglowek)
    for (const p of v.pola) f.set(p.nazwa, p.wartosc)
    return podgladSzablonu(v.rodzaj, nadpisanieZFormularza(v.rodzaj, f))
  } catch {
    return null
  }
}
