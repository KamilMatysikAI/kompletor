// Notatki wewnętrzne karty zamówienia: autor, czas. Poprawić może tylko autor przez 15 minut. Treść nie
// idzie do AI, alertów ani logów. Pole „Pokaż na karcie” (OrderNote.showOnCard) jest ukryte, dopóki wydruk karty
// nie pokazuje notatek; bez pola w formularzu zapis daje showOnCard = false.
// pola z app/ui, poprawka notatki z jednym zapisem (PasekZapisu), wynik jako toast.
import { PasekZapisu, PoleWielowierszowe, Przycisk, Sekcja } from '@/app/ui'
import type { DaneKarty } from '@/lib/karta/dane'
import { MAKS_NOTATKI } from '@/lib/karta/notatki'
import { when } from '@/lib/panel/format'
import { dodajNotatkeKarta, poprawNotatkeKarta } from './akcje-notatki'

export function Notatki({ d, uprawnienia }: { d: DaneKarty; uprawnienia: ReadonlySet<string> }) {
  const moze = uprawnienia.has('zamowienia.notatki')
  const now = new Date()
  return (
    <Sekcja id="notatki" tytul="Notatki wewnętrzne">
      {d.notatki.length === 0 ? (
        <p className="muted small kz-bez-marginesu">Brak notatek. Klient ich nie widzi.</p>
      ) : (
        <ul className="kz-notatki">
          {d.notatki.map((n) => (
            <li key={n.id}>
              <p className="small muted kz-bez-marginesu">
                {n.autor}, {when(n.dodano, now)}
                {n.poprawiono ? ' (poprawiona)' : ''}
              </p>
              <p className="kz-notatka">{n.tresc}</p>
              {moze && n.mojaDoPoprawy && (
                <details className="kz-dodaj">
                  <summary className="btn small">Popraw notatkę</summary>
                  <form action={poprawNotatkeKarta} className="kz-zmien-pola">
                    <input type="hidden" name="zamowienie" value={d.o.id} />
                    <input type="hidden" name="notatka" value={n.id} />
                    <PoleWielowierszowe id={`not-${n.id}`} etykieta="Treść notatki" name="tresc" required maxLength={MAKS_NOTATKI} rows={3} defaultValue={n.tresc} />
                    <PasekZapisu zapisz="Zapisz poprawkę" />
                  </form>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
      {moze && (
        <details className="kz-dodaj kz-odstep-gora">
          <summary className="btn">Dodaj notatkę</summary>
          <form action={dodajNotatkeKarta} className="kz-zmien-pola">
            <input type="hidden" name="zamowienie" value={d.o.id} />
            <PoleWielowierszowe id="not-nowa" etykieta={`Nowa notatka (do ${MAKS_NOTATKI} znaków)`} name="tresc" required maxLength={MAKS_NOTATKI} rows={3} />
            <div>
              <Przycisk type="submit" wariant="glowny">
                Zapisz notatkę
              </Przycisk>
            </div>
          </form>
        </details>
      )}
    </Sekcja>
  )
}
