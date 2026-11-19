// Blok „Przesyłki” w sekcji „Przesyłka” karty zamówienia: każda przesyłka utworzona u przewoźnika z numerem nadania,
// linkiem do strony śledzenia, stanem drogi paczki, datą wejścia w stan i historią zdarzeń (zwijana). Dane z
// lib/wysylka/droga-paczki.ts, tylko odczyt, widzi każdy z dostępem do karty (numer nadania nie jest daną osobową).
// Styl jak blok „Faktura KSeF” w sąsiedniej sekcji (`.kz-przesylka`: linia nad blokiem, nagłówek h3, lista dl).
import { Odznaka } from '@/app/ui'
import { automatyWysylki } from '@/lib/wysylka/automaty'
import { drogaPaczek, type DrogaPrzesylki } from '@/lib/wysylka/droga-paczki'
import { dodatkowaDoWyjasnienia } from '@/lib/wysylka/nadanie'
import { when } from '@/lib/panel/format'
import type { PanelContext } from '@/lib/panel/kontekst'
import { DodajPrzesylke } from './dodaj-przesylke'

export async function BlokDrogiPaczek({ ctx, orderId }: { ctx: PanelContext; orderId: string }) {
  const [przesylki, automaty, doWyjasnienia] = await Promise.all([drogaPaczek(ctx.db, orderId), automatyWysylki(ctx.db), dodatkowaDoWyjasnienia(ctx.db, orderId)])
  if (!przesylki.length && !doWyjasnienia) return null
  const now = new Date()
  const wiele = przesylki.length > 1
  return (
    <div className="kz-przesylka" role="group" aria-labelledby="h-przesylki">
      <h3 id="h-przesylki">Przesyłki</h3>
      {przesylki.map((p, i) => (
        <Przesylka key={p.id} p={p} now={now} tytul={tytulPrzesylki(p, i, przesylki.length, wiele)} />
      ))}
      {/* dodatkowa przesyłka (dosyłka): funkcja firmy włączona w ustawieniach przewoźników, to samo uprawnienie co
          „Utwórz przesyłkę”; bramki w oknie i u hosta. Dodatkowa przesyłka w trakcie albo niejasna u przewoźnika
          zostawia okno (tam „Sprawdź u przewoźnika” i „Rozstrzygnij ręcznie”) także po wyłączeniu funkcji */}
      {ctx.permissions.has('pakowanie.stanowisko') && (doWyjasnienia || (automaty.dodatkowaPrzesylka && przesylki.some((p) => !p.dodatkowa && !p.anulowana))) && <DodajPrzesylke orderId={orderId} />}
    </div>
  )
}

function tytulPrzesylki(p: DrogaPrzesylki, i: number, n: number, wiele: boolean): string | null {
  const anul = p.anulowana ? ' (anulowana)' : ''
  if (p.dodatkowa) return `${p.dodatkowa.rodzaj} nr ${p.dodatkowa.numer} (dodatkowa przesyłka)${anul}`
  return wiele ? `Przesyłka główna${anul}` : null
}

function Przesylka({ p, now, tytul }: { p: DrogaPrzesylki; now: Date; tytul: string | null }) {
  return (
    <div className="kz-droga" role={tytul ? 'group' : undefined} aria-label={tytul ?? undefined}>
      {tytul && <p className="kz-droga-tytul small muted">{tytul}</p>}
      <dl className="dl">
        <dt>Przewoźnik</dt>
        <dd>{p.przewoznik}</dd>
        <dt>Numer nadania</dt>
        <dd className="kz-droga-numer">
          {p.numer ? <span className="mono">{p.numer}</span> : <span className="muted">brak numeru</span>}
          {p.link && (
            <a href={p.link} target="_blank" rel="noopener noreferrer" className="kz-droga-link">
              Śledź na stronie {p.stronaLinku}
              <span className="sr"> (otwiera się w nowej karcie)</span>
            </a>
          )}
        </dd>
        {p.dodatkowa && (
          <>
            <dt>Powód</dt>
            <dd className="kz-zawijaj">{p.dodatkowa.powod}</dd>
            {p.dodatkowa.kosztNetto !== null && (
              <>
                <dt>Koszt etykiety</dt>
                <dd>{p.dodatkowa.kosztNetto.toFixed(2).replace('.', ',')} zł netto</dd>
              </>
            )}
          </>
        )}
        <dt>Stan paczki</dt>
        <dd>
          <Odznaka ton={p.ton}>{p.stanOpis}</Odznaka>
        </dd>
        <dt>{p.etykietaDaty}</dt>
        <dd>
          <time dateTime={p.odKiedy.toISOString()}>{when(p.odKiedy, now)}</time>
        </dd>
      </dl>
      {p.uwaga && <p className="muted small kz-odstep-gora">{p.uwaga}</p>}
      {p.historia.length > 0 && (
        <details className="kz-droga-historia">
          <summary>
            Historia paczki ({p.historia.length + p.starszychZdarzen})
          </summary>
          <ul className="timeline">
            {p.historia.map((e) => (
              <li key={e.id}>
                <span className="mono small muted">
                  <time dateTime={e.kiedy.toISOString()}>{when(e.kiedy, now)}</time>
                </span>{' '}
                {e.opis}
                {e.uPrzewoznika && <span className="muted small kz-zawijaj"> (u przewoźnika: {e.uPrzewoznika})</span>}
              </li>
            ))}
          </ul>
          {p.starszychZdarzen > 0 && <p className="muted small">Starszych zdarzeń: {p.starszychZdarzen}. Pełną historię pokazuje strona przewoźnika.</p>}
        </details>
      )}
    </div>
  )
}
