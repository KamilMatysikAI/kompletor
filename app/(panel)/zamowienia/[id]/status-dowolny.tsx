// „Zmień status” w menu „Więcej” karty zamówienia: lista statusów, na które wolno przejść z obecnego
// (lib/praca/status-dowolny.ts), z wymaganym powodem. Niedostępne pozycje są na liście wyłączone, a ich powody
// pod formularzem. Bez JavaScriptu (zwykły formularz w rozwinięciu menu `RozwinWMenu`, komponenty app/ui). Widoczne tylko z uprawnieniem
// `zamowienia.status_dowolny` na koncie w trybie PRACA.
import { GrupaMenu, Przycisk, PoleWielowierszowe, RozwinWMenu, Wybor } from '@/app/ui'
import { requireSession } from '@/lib/panel/kontekst'
import { POWOD_MAX, POWOD_MIN, stanZmianyStatusu } from '@/lib/praca/status-dowolny'
import { zmienStatusKarta } from './akcje-status'

export async function ZmianaStatusu({ orderId }: { orderId: string }) {
  const ctx = await requireSession()
  const opcje = await stanZmianyStatusu(ctx.db, orderId, ctx.permissions)
  if (!opcje) return null
  const dostepne = opcje.filter((x) => !x.powod)
  const niedostepne = opcje.filter((x) => x.powod)
  return (
    <GrupaMenu>
      <RozwinWMenu etykieta="Zmień status…">
        {!dostepne.length ? (
          <p className="small muted">Z obecnego statusu nie da się przejść na inny bez osobnego przycisku.</p>
        ) : (
          <form action={zmienStatusKarta} className="stack">
            <input type="hidden" name="zamowienie" value={orderId} />
            <Wybor
              id="zs-status"
              etykieta="Nowy status"
              name="status"
              required
              defaultValue=""
              opcje={[
                { wartosc: '', etykieta: 'wybierz…', wylaczona: true },
                ...dostepne.map((x) => ({
                  wartosc: x.wartosc,
                  etykieta: `${x.etykieta}${x.droga === 'COFNIECIE' ? ' (cofnięcie pomyłki)' : x.droga === 'NAZWA' ? ' (ten sam etap)' : ''}`,
                })),
              ]}
            />
            <PoleWielowierszowe id="zs-powod" etykieta="Powód (zostanie w historii zamówienia)" name="powod" required minLength={POWOD_MIN} maxLength={POWOD_MAX} rows={2} />
            <div>
              <Przycisk type="submit" wariant="glowny">
                Zmień status
              </Przycisk>
            </div>
          </form>
        )}
        {niedostepne.length > 0 && (
          <ul className="plain small muted">
            {niedostepne.map((x) => (
              <li key={x.wartosc}>
                {x.etykieta}: {x.powod}
              </li>
            ))}
          </ul>
        )}
        <p className="small muted">Zmienia tylko status w Kompletorze: nic nie idzie do kanału sprzedaży, wFirmy ani kuriera.</p>
      </RozwinWMenu>
    </GrupaMenu>
  )
}
