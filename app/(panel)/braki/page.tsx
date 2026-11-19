import Link from 'next/link'
import { accountName, accounts, shortagesData } from '@/lib/panel/dane'
import { channelPrefix, money, qty, SHORTAGE_LABEL, shortExternalId, STATUS_LABEL, when } from '@/lib/panel/format'
import { requireSession } from '@/lib/panel/kontekst'
import { firmaMaWfirme } from '@/lib/kanaly/firma'
import { ETYKIETA_DECYZJI } from '@/lib/stanowisko/decyzje'
import { zwrocone } from './akcje'
import { wyszedlKompletKarta } from '../zamowienia/[id]/akcje-pozycje'
import { Miniatura } from '../_komponenty/miniatura'
import { KlikalneWiersze } from '../_komponenty/wiersze'
import { ListaBrakuje } from './lista-brakuje'
import { PoprawioneWWfirmie } from './poprawione'
import { NaglowekStrony, PrzyciskLink, PrzyciskPotwierdz, Zakladki } from '@/app/ui'
import { liczbaBrakow } from '@/lib/panel/braki'
import { chwilaAutomatuWz } from '@/lib/dokumenty/ustawienia'
import { ALERTY_BLEDU_WZ, automatWzObejmie, POWOD_AUTOMAT_WZ } from '@/lib/rdzen/rozchod'

export const metadata = { title: 'Braki towaru' }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }
// „Po produkcie” to teraz domyślny widok listy „Brakuje” (stary adres ?lista=produkty prowadzi tam)
const LISTS = { brakuje: 'Brakuje', pakowanie: 'Z pakowania', zwroty: 'Do zwrotu', wfirma: 'Do poprawy w wFirmie' } as const
type List = keyof typeof LISTS

const PENDING_LABEL: Record<string, string> = {
  OWN_INVOICE: 'faktura bez dokumentu WZ',
  BL_INVOICE: 'faktura z BL bez WZ',
  ISSUED_WITHOUT_DOCUMENT: 'wydane bez dokumentu',
  STOCK_MISSING: '„nie ma na półce” zgłoszone przy pakowaniu',
  DAMAGED_RETURN: 'uszkodzony zwrot do RW',
}

export default async function Braki({ searchParams }: Props) {
  const ctx = await requireSession()
  const sp = await searchParams
  const raw0 = Array.isArray(sp.lista) ? sp.lista[0] : sp.lista
  // `stany` = neutralny adres listy rozjazdów stanu z alertu „ponad stan” nad listą zamówień
  const raw = raw0 === 'stany' ? 'wfirma' : raw0
  const list: List = raw && raw in LISTS ? (raw as List) : 'brakuje'
  const [d, accs, hasWfirma] = await Promise.all([shortagesData(ctx.db), accounts(ctx.db), firmaMaWfirme(ctx.db)])
  // firma bez wFirmy widzi zakładkę „Nadmiar rezerwacji”, bez nazwy programu, którego nie ma
  // ten sam warunek co sekcja „Do poprawy w wFirmie” niżej (wpisy ręczne bez wFirmy)
  const sekcjaWfirmy = hasWfirma || d.manual.length > 0
  const etykietaListy = (l: List) => (l === 'wfirma' && !sekcjaWfirmy ? 'Nadmiar rezerwacji' : LISTS[l])
  const now = new Date()
  // „Brakuje” = braki do decyzji przy otwartych zamówieniach (lib/panel/braki.ts), bez paczek, które wyszły
  const doDecyzji = await liczbaBrakow(ctx.db)
  const counts: Record<List, number> = { brakuje: doDecyzji, pakowanie: d.reported.length, zwroty: d.refunds.length, wfirma: d.manual.length + d.overcommit.length }
  const canRefund = ctx.permissions.has('zwroty.pieniadze')
  // „Wyszedł komplet” przy zwrocie spakowanej paczki (uprawnienie jak decyzje o brakach)
  const canDecide = ctx.permissions.has('braki.decyzje')
  // to samo uprawnienie co „Dokument wystawiony” na karcie zamówienia; bez niego przycisk widoczny i nieaktywny z powodem
  const powodPoprawione = ctx.permissions.has('zamowienia.faktury') ? null : 'Brak uprawnienia „Faktura na karcie zamówienia”'
  // „wydane bez dokumentu” w zakresie automatu WZ (bez otwartego błędu WZ zamówienia): dokument wystawi Kompletor, nie biuro
  const wzOd = d.manual.some((m) => m.type === 'ISSUED_WITHOUT_DOCUMENT') ? chwilaAutomatuWz((await ctx.db.organization.findFirst({ select: { settings: true } }))?.settings ?? null) : null
  const zBledemWz = new Set(
    wzOd ? (await ctx.db.alert.findMany({ where: { closedAt: null, kind: { in: ALERTY_BLEDU_WZ }, ref: { in: d.manual.flatMap((m) => (m.orderId ? [m.orderId] : [])) } }, select: { ref: true } })).map((x) => x.ref) : [],
  )
  const powodPozycji = (m: (typeof d.manual)[number]) => powodPoprawione ?? (automatWzObejmie(m, wzOd) && !zBledemWz.has(m.orderId!) ? POWOD_AUTOMAT_WZ : null)
  const numer = (o: { channel: Parameters<typeof channelPrefix>[0]; channelAccountId: string; externalId: string }) =>
    `${channelPrefix(o.channel, accountName(accs, o.channel, o.channelAccountId))} ${shortExternalId(o.externalId)}`
  const decyzja = (lineId: string) => {
    const x = d.decisions.get(lineId)
    return x ? `${ETYKIETA_DECYZJI[x.action]}${x.dryRun ? ' (próbnie)' : ''}` : 'domyślnie: wyślij resztę'
  }
  const unitOf = (pid: string) => d.titles.get(pid)?.unit ?? 'SZT'
  return (
    <>
      <NaglowekStrony
        tytul="Braki towaru"
        podtytul="Czego brakuje do otwartych zamówień i co z tym zrobić. Zwrot pieniędzy i korekta faktury to ręczne zadania obsługi."
        akcje={<PrzyciskLink href="/zwroty">Zwroty i reklamacje</PrzyciskLink>}
      />

      <Zakladki etykieta="Listy" zakladki={(Object.keys(LISTS) as List[]).map((l) => ({ href: l === 'brakuje' ? '/braki' : `/braki?lista=${l}`, etykieta: etykietaListy(l), licznik: counts[l], aktywna: l === list }))} />

      {list === 'brakuje' && <ListaBrakuje db={ctx.db} sp={sp} accs={accs} canDecide={ctx.permissions.has('braki.decyzje')} />}

      {list === 'pakowanie' &&
        (d.reported.length === 0 ? (
          <div className="empty">
            <h2>Nic nie zgłoszono</h2>
            <p className="muted">Tu trafia to, czego pakujący nie znalazł na półce przy pakowaniu próbnym (konta „Tylko podgląd”). Na kontach aktywnych brak jest od razu na liście „Brakuje”.</p>
          </div>
        ) : (
          <KlikalneWiersze>
            <table className="tbl cards olist">
              <thead>
                <tr>
                  <th>Zamówienie</th>
                  <th>Produkt</th>
                  <th className="right">Brakuje</th>
                  <th>Decyzja</th>
                  <th>Zgłoszone</th>
                </tr>
              </thead>
              <tbody>
                {d.reported.map((f) => {
                  const o = d.reportedOrders.get(f.orderId)
                  if (!o) return null
                  const t = d.titles.get(f.productId)
                  const href = `/zamowienia/${o.id}`
                  return (
                    <tr key={f.id} className="orow row-alert" data-href={href} tabIndex={0} aria-label={`${numer(o)}: otwórz zamówienie`}>
                      <td data-label="Zamówienie">
                        <Link className="ord" href={href}>
                          {numer(o)}
                        </Link>
                        <span className="sub">{STATUS_LABEL[o.status]}</span>
                      </td>
                      <td data-label="Produkt">
                        {t?.title ?? 'produkt'} <span className="mono small muted">{t?.sku}</span>
                      </td>
                      <td data-label="Brakuje" className="right num">
                        {qty(f.qtyBase, unitOf(f.productId))}
                      </td>
                      <td data-label="Decyzja">{decyzja(f.orderLineId)}</td>
                      <td data-label="Zgłoszone">{when(f.createdAt, now)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </KlikalneWiersze>
        ))}

      {list === 'zwroty' &&
        (d.refunds.length === 0 ? (
          <div className="empty">
            <h2>Nic do zwrotu</h2>
            <p className="muted">Tu trafia zamówienie opłacone z góry, które wyszło bez brakującej pozycji.</p>
          </div>
        ) : (
          <section className="card" aria-labelledby="h-zw">
            <div className="card-head">
              <h2 id="h-zw">Do zwrotu</h2>
              <span className="muted small">zwrot robisz w kanale albo bramce, potem „Zwrócone”; gdy faktura objęła brak, także korekta faktury</span>
            </div>
            <ul className="plain">
              {d.refunds.map((s) => {
                const t = d.titles.get(s.productId)
                return (
                  <li key={s.id}>
                    <Link href={`/zamowienia/${s.order.id}`}>{numer(s.order)}</Link> · {t?.title ?? 'produkt'} · {qty(s.qtyBase, unitOf(s.productId))} ·{' '}
                    {s.kwotaZwrotuGr !== null ? money(s.kwotaZwrotuGr / 100) : 'składnik zestawu: kwotę policz ręcznie'} · {s.order.paymentMethod || 'metoda płatności nieznana'}
                    {canDecide && s.order.status === 'SPAKOWANE' && (
                      <form action={wyszedlKompletKarta} style={{ display: 'inline', marginLeft: 8 }}>
                        <input type="hidden" name="zamowienie" value={s.order.id} />
                        <input type="hidden" name="pozycja" value={s.orderLineId} />
                        <PrzyciskPotwierdz rozmiar="sm" tytul="Paczka wyszła w komplecie?" pytanie="Potwierdzasz, że brakujący towar był w paczce (leżał na półce, choć nie był jeszcze przyjęty na stan). Zwrotu nie będzie, faktura obejmie pełną ilość. Wynik zobaczysz na karcie zamówienia." tak="Tak, wyszedł komplet">
                          Wyszedł komplet
                        </PrzyciskPotwierdz>
                      </form>
                    )}
                    {canRefund && (
                      <form action={zwrocone} style={{ display: 'inline', marginLeft: 8 }}>
                        <input type="hidden" name="brak" value={s.id} />
                        <button type="submit" className="btn small">
                          Zwrócone
                        </button>
                      </form>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        ))}

      {list === 'wfirma' && (
        <div className="stack">
          {sekcjaWfirmy && (
            <section className="card" aria-labelledby="h-wf">
              <div className="card-head">
                <h2 id="h-wf">Do poprawy w wFirmie</h2>
                <span className="muted small">prowadzi biuro: popraw dokument w wFirmie, potem „Poprawione w wFirmie”</span>
              </div>
              {d.manual.length === 0 ? (
                <p className="muted small">Pusto: wFirma zgadza się z ruchami w systemie.</p>
              ) : (
                <ul className="plain">
                  {d.manual.map((m) => {
                    const t = d.titles.get(m.productId)
                    const rodzaj = PENDING_LABEL[m.type] ?? m.type
                    return (
                      // opis po lewej, przycisk w jednej kolumnie po prawej; na wąskim ekranie przycisk schodzi pod opis
                      <li key={m.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <span style={{ flex: '1 1 260px', minWidth: 0 }}>
                          <span className="mono small muted">{when(m.createdAt, now)}</span> <Link href={`/produkty/${m.productId}`}>{t?.title ?? 'produkt'}</Link> ·{' '}
                          {qty(m.delta, unitOf(m.productId))} · {rodzaj}
                          {m.wfirmaDocId && !m.wfirmaDocId.startsWith('wz:') && (
                            <>
                              {' '}
                              · <span className="mono small">{m.wfirmaDocId}</span>
                            </>
                          )}
                          {m.orderId && (
                            <>
                              {' '}
                              · <Link href={`/zamowienia/${m.orderId}`}>zamówienie</Link>
                            </>
                          )}
                        </span>
                        <span>
                          <PoprawioneWWfirmie movementId={m.id} rodzaj={m.type} opis={`${t?.title ?? 'produkt'}, ${qty(m.delta, unitOf(m.productId))}, ${rodzaj}${m.wfirmaDocId && !m.wfirmaDocId.startsWith('wz:') ? `, dokument ${m.wfirmaDocId}` : ''}`} powodWylaczenia={powodPozycji(m)} />
                        </span>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          )}
          <section className="card" aria-labelledby="h-nad">
            <div className="card-head">
              <h2 id="h-nad">Nadmiar rezerwacji</h2>
              <span className="muted small">zarezerwowane więcej, niż jest na półce</span>
            </div>
            {d.overcommit.length === 0 ? (
              <p className="muted small">Brak.</p>
            ) : (
              <ul className="plain">
                {d.overcommit.map((s) => (
                  <li key={`${s.productId}:${s.warehouseId}`}>
                    <Link href={`/produkty/${s.product.id}`}>{s.product.title}</Link> · fizycznie {qty(s.physical, s.product.unit)}, zarezerwowane {qty(s.reserved, s.product.unit)}
                    {s.overcommitSince && ` · od ${when(s.overcommitSince, now)}`}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </>
  )
}
