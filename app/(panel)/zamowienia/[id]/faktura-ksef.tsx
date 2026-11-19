// Blok „Faktura KSeF (podgląd, nic nie zostało wysłane)” w ekranie zamówienia. Tylko dla firm bez wFirmy
// (`settings.faktury.program = ksef`): status szkicu, sumy, problemy i przycisk „Przygotuj” (uprawnienie
// `zamowienia.anuluj_po_fakturze`, jedyne uprawnienie faktur). „Wyślij do KSeF” / „Ponów” (uprawnienie
// `zamowienia.faktury`, bramka wysyłki z lib/ksef/api/bramka.ts jako powód nieaktywnego przycisku), numer KSeF, błąd i PDF.
import { Odznaka } from '@/app/ui'
import type { Ton } from '@/lib/panel/statusy'
import { STATUS_KSEF_LABEL, podgladKsef, type StatusKsef } from '@/lib/ksef/szkice'
import { money, when } from '@/lib/panel/format'
import type { PanelContext } from '@/lib/panel/kontekst'
import { PrzygotujKsef } from './przygotuj-ksef'
import { powodBrakuWysylki } from '@/lib/ksef/wysylka'
import { PonowDokument } from '../../faktury/przyciski'

export const TON_KSEF: Record<StatusKsef, Ton> = { ZLOZONA: 'info', ODLOZONA: 'sukces', POZA_KSEF: 'neutralny', BLAD_WALIDACJI: 'blad', WYSYLANA: 'info', WYSLANA: 'info', PRZYJETA: 'sukces', ODRZUCONA: 'blad', BLAD_WYSYLKI: 'blad' }

export async function BlokFakturyKsef({ ctx, orderId }: { ctx: PanelContext; orderId: string }) {
  const p = await podgladKsef(ctx.db, orderId)
  if (!p) return null
  const z = p.zapisany
  const moze = ctx.permissions.has('zamowienia.anuluj_po_fakturze')
  const now = new Date()
  // „Wyślij do KSeF” tylko dla szkicu do wysyłki albo po błędzie/odrzuceniu; przyjęta nie ma czego ponawiać
  const wyslij = !!z && ['ZLOZONA', 'ODLOZONA', 'BLAD_WYSYLKI', 'ODRZUCONA', 'WYSLANA'].includes(z.status)
  const powodWysylki = wyslij ? await powodBrakuWysylki(ctx.db, orderId) : null
  return (
    <div className="kz-przesylka" role="group" aria-labelledby="h-ksef">
      <h3 id="h-ksef">{z?.numer ? 'Faktura KSeF' : 'Faktura KSeF: szkic, nic nie zostało wysłane'}</h3>
      {p.nieDotyczy ? (
        <p className="muted small">Nie dotyczy. {p.nieDotyczy}</p>
      ) : z ? (
        <>
          <dl className="dl">
            <dt>Status</dt>
            <dd>
              <Odznaka ton={TON_KSEF[z.status]}>{STATUS_KSEF_LABEL[z.status]}</Odznaka>
            </dd>
            <dt>Numer</dt>
            <dd>{z.numer ?? <span className="muted">szkic, numer dopiero przy wysyłce</span>}</dd>
            <dt>Brutto</dt>
            <dd className="num">{money(z.bruttoGr / 100)}</dd>
            <dt>Netto</dt>
            <dd className="num">{money(z.nettoGr / 100)}</dd>
            {z.walidacja && (
              <>
                <dt>Schemat FA(3)</dt>
                <dd className="small">{z.walidacja}</dd>
              </>
            )}
            <dt>Przygotowano</dt>
            <dd>{when(z.przygotowano, now)}</dd>
            {z.ksefNumer && (
              <>
                <dt>Numer KSeF</dt>
                <dd className="mono">{z.ksefNumer}</dd>
              </>
            )}
            {z.srodowisko && (
              <>
                <dt>Środowisko</dt>
                <dd>{z.srodowisko === 'PROD' ? 'produkcyjne' : z.srodowisko === 'DEMO' ? 'przedprodukcyjne' : 'testowe'}{z.proby > 1 ? ` · próba ${z.proby}` : ''}</dd>
              </>
            )}
            {z.lastError && (
              <>
                <dt>Powód</dt>
                <dd className="small">{z.lastError}</dd>
              </>
            )}
          </dl>
          {z.problemy.length > 0 && (
            <div className="kz-poz-znaczniki kz-odstep-gora">
              {z.problemy.map((pr, i) => (
                <Odznaka key={i} ton="blad" className="kz-zawijaj">
                  {pr.tekst}
                </Odznaka>
              ))}
            </div>
          )}
        </>
      ) : (
        <p className="muted small">Jeszcze nie przygotowano.</p>
      )}
      <p className="pl-akcje-wiersza">
        {moze && !p.nieDotyczy && !z?.numer && <PrzygotujKsef orderId={orderId} ponownie={!!z} zablokowany={!!z?.numer} />}
        {z && !p.nieDotyczy && wyslij && (
          <PonowDokument klucz={`k:${z.id}`} etykieta={z.numer ? 'Ponów wysyłkę' : 'Wyślij do KSeF'} powodWylaczenia={!ctx.permissions.has('zamowienia.faktury') ? 'Brak uprawnienia „Faktura na karcie zamówienia”' : powodWysylki} />
        )}
        {z?.status === 'PRZYJETA' && ctx.permissions.has('zamowienia.faktury') && ctx.permissions.has('klienci.dane') && (
          <a className="btn small" href={`/api/faktury/pdf?d=${z.id}`} target="_blank" rel="noopener">
            PDF faktury
          </a>
        )}
      </p>
    </div>
  )
}
