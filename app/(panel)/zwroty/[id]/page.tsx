import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Channel } from '@prisma/client'
import { Baner, Karta, ListaOpisowa, NaglowekStrony, Odznaka, ToastZAdresuZapisu } from '@/app/ui'
import { accountName, accounts } from '@/lib/panel/dane'
import { channelPrefix, shortExternalId, when } from '@/lib/panel/format'
import { requireSession } from '@/lib/panel/kontekst'
import { kartaZwrotu } from '@/lib/zwroty/karta'
import { etykietaPowodu, OPIS_STATUSU, RODZAJ_ZWROTU, STATUS_ZWROTU, TON_STATUSU, ZRODLO_ZWROTU } from '@/lib/zwroty/statusy'
import { DodajZdjecie, Korekta, OdbiorPaczki, Odrzuc } from './przyciski'
import { stanKsef } from '@/lib/dokumenty/lista'
import { powodBrakuWysylki } from '@/lib/ksef/wysylka'
import { WyslijKorekte } from '../../faktury/przyciski'
import '../zwroty.css'

// Karta zwrotu: pozycje, odbiór paczki (na stan albo uszkodzone), korekta faktury przez program do faktur
// firmy, odrzucenie, zdjęcie i historia (kto, kiedy). Zwrot pieniędzy klientowi: karta zamówienia → „Płatność”.
export const metadata = { title: 'Zwrot' }

const DYSPOZYCJA = { NA_STAN: 'na stan', USZKODZONE: 'uszkodzone', BRAK: 'brak w paczce' } as const

export default async function KartaZwrotu({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireSession()
  const { id } = await params
  if (!/^[a-z0-9]{1,40}$/i.test(id)) notFound()
  const [k, accs] = await Promise.all([kartaZwrotu(ctx.db, id), accounts(ctx.db)])
  if (!k) notFound()
  const now = new Date()
  // korekta KSeF tego zwrotu (wiersz KOR), stan słowem jak na liście faktur
  const kor = k.korekta.szkicKsef ? await ctx.db.ksefInvoiceDraft.findFirst({ where: { returnId: k.id }, select: { status: true, numer: true, ksefNumer: true, lastError: true } }) : null
  const korKsef = kor ? { ...stanKsef(kor.status, kor.ksefNumer), numer: kor.numer, blad: kor.lastError } : null
  const powodKor = k.korekta.szkicKsef ? await powodBrakuWysylki(ctx.db, k.order.id) : null
  const nr = `${channelPrefix(k.order.channel as Channel, accountName(accs, k.order.channel as Channel, k.order.channelAccountId))} ${shortExternalId(k.order.externalId)}`
  const przyjecie = ctx.permissions.has('zwroty.przyjecie')
  const brakPrzyjecia = przyjecie ? null : 'Brak uprawnienia „Zwroty i reklamacje: odbiór paczki”'
  const otwarty = k.status === 'ZGLOSZONY' || k.status === 'PRZYJETY'

  return (
    <>
      <ToastZAdresuZapisu komunikaty={{ zwrot: 'Zwrot zapisany', reklamacja: 'Reklamacja zapisana' }} />
      <NaglowekStrony
        tytul={
          <>
            {RODZAJ_ZWROTU[k.kind]} do zamówienia {nr}{' '}
            <Odznaka ton={TON_STATUSU[k.status]} kropka>
              {STATUS_ZWROTU[k.status]}
            </Odznaka>
          </>
        }
        podtytul={
          <>
            <Link href="/zwroty">← Zwroty i reklamacje</Link> · <Link href={`/zamowienia/${k.order.id}`}>Otwórz zamówienie</Link>
          </>
        }
      />
      <p className="muted">{OPIS_STATUSU[k.status]}</p>
      {k.lastError && k.status === 'KOREKTA' && <Baner ton="blad" tytul="Korekta nie wyszła:">{k.korekta.potwierdzenie ? k.korekta.powod : k.lastError}</Baner>}
      {/* ostrzeżenie kontroli korekty po zapisie zostaje widoczne po zakończeniu */}
      {k.lastError && k.status === 'ZAKONCZONY' && (
        <Baner ton="ostrzezenie" tytul="Sprawdź korektę w programie do faktur:">
          {k.lastError}
        </Baner>
      )}

      <div className="zw-uklad">
        <div className="zw-glowna">
          {k.status === 'ZGLOSZONY' ? (
            <Karta tytul="Odbiór paczki" opis="Oznacz każdą pozycję, gdy paczka jest w magazynie.">
              <OdbiorPaczki returnId={k.id} pozycje={k.pozycje} powodWylaczenia={brakPrzyjecia} stanKompletora={k.stanKompletora} />
            </Karta>
          ) : (
            <Karta tytul="Pozycje">
              <table className="tbl cards zw-pozycje">
                <thead>
                  <tr>
                    <th scope="col">Pozycja</th>
                    <th scope="col" className="right">
                      Ilość
                    </th>
                    <th scope="col">Co z towarem</th>
                  </tr>
                </thead>
                <tbody>
                  {k.pozycje.map((p) => (
                    <tr key={p.id}>
                      <td data-label="Pozycja">
                        {p.nazwa}
                        {p.sku && <span className="sub mono">{p.sku}</span>}
                      </td>
                      <td data-label="Ilość" className="right num">
                        {p.qty} {p.jednostka}
                      </td>
                      <td data-label="Co z towarem">{p.disposition ? DYSPOZYCJA[p.disposition] : <span className="muted">nie oznaczono</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Karta>
          )}

          {(k.status === 'PRZYJETY' || k.status === 'KOREKTA' || k.korekta.szkicKsef || (k.status === 'ZAKONCZONY' && k.korekta.powod)) && (
            <Karta tytul="Korekta faktury">
              {k.status === 'PRZYJETY' && (
                <Korekta returnId={k.id} zlecenie={k.korekta.zlecenie} recznie={k.korekta.recznie} powod={k.korekta.powod} uprawnienie={ctx.permissions.has('zwroty.korekty')} blad={false} />
              )}
              {k.status === 'KOREKTA' &&
                (k.correctionState === 'FAILED' ? (
                  <Korekta returnId={k.id} zlecenie={k.korekta.ponowienie !== false} recznie={k.korekta.recznie} powod={k.korekta.powod} uprawnienie={ctx.permissions.has('zwroty.korekty')} blad potwierdzenie={k.korekta.potwierdzenie} />
                ) : (
                  <>
                    <p>Korekta jest w kolejce programu do faktur. Status zmieni się na „Zakończone”, gdy program ją wystawi.</p>
                    {/* powód tylko, gdy ostrzega (inna korekta tej faktury, poprzednia próba bez odpowiedzi) */}
                    {k.korekta.recznie && <Korekta returnId={k.id} zlecenie={false} recznie powod={k.korekta.ostrzezenie ?? null} uprawnienie={ctx.permissions.has('zwroty.korekty')} blad={false} ukryjZlecenie />}
                  </>
                ))}
              {k.status === 'ZAKONCZONY' && k.correctionDocId && <p>Korekta wystawiona: dokument {k.correctionDocId}.</p>}
              {k.status === 'ZAKONCZONY' && !k.correctionDocId && k.korekta.powod && <p className="muted">{k.korekta.powod}</p>}
              {k.korekta.szkicKsef && korKsef && (
                <p>
                  Korekta w KSeF: <Odznaka ton={korKsef.stan === 'BLAD' ? 'blad' : korKsef.stan === 'WYSTAWIONA' ? 'sukces' : 'info'}>{korKsef.tekst}</Odznaka>
                  {korKsef.numer ? <span className="mono"> {korKsef.numer}</span> : null}
                  {korKsef.blad ? <span className="small"> {korKsef.blad}</span> : null}
                </p>
              )}
              {k.korekta.szkicKsef && korKsef?.stan !== 'WYSTAWIONA' && (
                <p>
                  <WyslijKorekte returnId={k.id} powodWylaczenia={!ctx.permissions.has('zwroty.korekty') ? 'Brak uprawnienia „Zwroty: zlecenie korekty faktury”' : powodKor} />
                </p>
              )}
              {k.korekta.szkicKsef && (
                <p>
                  {ctx.permissions.has('klienci.dane') ? (
                    <>
                      <a className="btn ghost" href={`/api/zwroty/${k.id}/korekta-ksef`} download>
                        Pobierz szkic korekty FA(3)
                      </a>{' '}
                      <span className="muted small">Szkic do sprawdzenia, bez wysyłki do KSeF.</span>
                    </>
                  ) : (
                    <span className="muted small">Szkic korekty FA(3) zawiera dane nabywcy: pobranie wymaga uprawnienia „Dane klienta: pełny podgląd”.</span>
                  )}
                </p>
              )}
            </Karta>
          )}

          {otwarty && (
            <Karta tytul="Odrzucenie" zwijana otwarta={false}>
              <Odrzuc returnId={k.id} powodWylaczenia={brakPrzyjecia} />
            </Karta>
          )}
        </div>

        <div className="zw-bok">
          <Karta tytul="Szczegóły">
            <ListaOpisowa
              pozycje={[
                { etykieta: 'Rodzaj', wartosc: RODZAJ_ZWROTU[k.kind] },
                { etykieta: 'Powód', wartosc: etykietaPowodu(k.kind, k.reason) ?? 'brak' },
                { etykieta: 'Źródło', wartosc: `${ZRODLO_ZWROTU[k.source] ?? k.source}${k.externalId ? ` (nr ${k.externalId})` : ''}` },
                { etykieta: 'Założony', wartosc: when(k.createdAt, now) },
                ...(k.receivedAt ? [{ etykieta: 'Odebrany', wartosc: when(k.receivedAt, now) }] : []),
                ...(k.closedAt ? [{ etykieta: 'Zamknięty', wartosc: when(k.closedAt, now) }] : []),
                ...(k.note ? [{ etykieta: 'Notatka', wartosc: k.note }] : []),
                { etykieta: 'Zwrot pieniędzy', wartosc: k.moneyRefundedAt ? `zwrócone ${when(k.moneyRefundedAt, now)}` : 'na karcie zamówienia, w bloku „Płatność”' },
              ]}
            />
          </Karta>
          <Karta tytul="Zdjęcie">
            {k.maZdjecie && !przyjecie ? (
              <p className="muted small">Zdjęcie dodane. Widzą je osoby z uprawnieniem do przyjmowania zwrotów.</p>
            ) : k.maZdjecie ? (
              <a href={`/api/zwroty/${k.id}/zdjecie`} target="_blank" rel="noopener noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="zw-zdjecie" src={`/api/zwroty/${k.id}/zdjecie`} alt="Zdjęcie zwrotu" />
              </a>
            ) : (
              <p className="muted small">Bez zdjęcia.</p>
            )}
            {przyjecie && <DodajZdjecie returnId={k.id} />}
          </Karta>
          <Karta tytul="Historia">
            {k.historia.length === 0 ? (
              <p className="muted small">Brak wpisów.</p>
            ) : (
              <ul className="timeline">
                {k.historia.map((h, i) => (
                  <li key={i}>
                    <span className="mono small muted">{when(h.kiedy, now)}</span> {h.co} <span className="muted small">· {h.kto}</span>
                  </li>
                ))}
              </ul>
            )}
          </Karta>
        </div>
      </div>
    </>
  )
}
