// Karta „Szczegóły zamówienia” (wzór układu TwojOMS, MIT; kod własny): trzecia z równych kart danych na
// górze karty zamówienia. Kanał i konto, numery (w sklepie, w BaseLinkerze, paczki), daty, źródło i płatność słowem.
// Te informacje były wcześniej w podtytule nagłówka: przeniesione tu, każda raz na karcie.
// Numer w BaseLinkerze tylko wtedy, gdy zamówienie go ma (firma bez BL go nie widzi). Rozliczenie i akcje płatności są
// w sekcji „Płatność”; tu tylko stan i sposób.
import Link from 'next/link'
import { Sekcja, StanPlatnosci } from '@/app/ui'
import type { DaneKarty } from '@/lib/karta/dane'
import { numeryKarty, sposobPlatnosci } from '@/lib/karta/opis'
import { CHANNEL_LABEL, when } from '@/lib/panel/format'

export function Szczegoly({ d }: { d: DaneKarty }) {
  const { o } = d
  const now = new Date()
  const numer = numeryKarty(o, d.linkKanalu)
  const wKanale = numer.wSklepie
  const liczbaPaczek = d.paczki.length
  return (
    <Sekcja id="szczegoly" tytul="Szczegóły zamówienia">
      <dl className="dl">
        <dt>Kanał</dt>
        <dd>
          {d.nazwaKonta}
          {d.nazwaKonta !== CHANNEL_LABEL[o.channel] ? <span className="muted"> ({CHANNEL_LABEL[o.channel]})</span> : null}
        </dd>
        {wKanale && (
          <>
            <dt>Numer w sklepie</dt>
            <dd>
              {d.linkKanalu ? (
                <a className="mono" href={d.linkKanalu} target="_blank" rel="noopener noreferrer" title="Otwórz zamówienie w kanale">
                  {wKanale}
                </a>
              ) : (
                <span className="mono">{wKanale}</span>
              )}
            </dd>
          </>
        )}
        {/* numer BL jest raz, małą linią pod tytułem karty (naglowek.tsx) */}
        {liczbaPaczek > 1 && (
          <>
            <dt>Paczka</dt>
            <dd>
              {o.packageNo} z {liczbaPaczek}
              {d.paczki
                .filter((p) => !p.biezaca)
                .map((p) => (
                  <span key={p.id}>
                    , <Link href={`/zamowienia/${p.id}`}>paczka {p.packageNo}</Link>
                  </span>
                ))}
            </dd>
          </>
        )}
        <dt>Złożone</dt>
        <dd>{when(o.createdAtChannel, now)}</dd>
        {d.ostatniaZmiana && (
          <>
            <dt>Ostatnia zmiana</dt>
            <dd>{when(d.ostatniaZmiana, now)}</dd>
          </>
        )}
        {o.sourceLabel && (
          <>
            <dt>Źródło</dt>
            <dd>{o.sourceLabel}</dd>
          </>
        )}
      </dl>
      <dl className="dl kz-punkt">
        <dt>Płatność</dt>
        <dd>
          <StanPlatnosci stan={o.paymentState} />
        </dd>
        <dt>Sposób płatności</dt>
        <dd>{sposobPlatnosci(o.channel, o.paymentMethod, o.paymentState)}</dd>
        <dt>Pobranie</dt>
        <dd>{o.paymentState === 'COD' ? 'tak' : 'nie'}</dd>
      </dl>
    </Sekcja>
  )
}
