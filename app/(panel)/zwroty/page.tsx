import Link from 'next/link'
import type { Channel, ReturnStatus } from '@prisma/client'
import { NaglowekStrony, Odznaka, PrzyciskLink, PustyStan, Zakladki } from '@/app/ui'
import { accountName, accounts, type AccountRef } from '@/lib/panel/dane'
import { channelPrefix, int, money, shortExternalId, when } from '@/lib/panel/format'
import { requireSession } from '@/lib/panel/kontekst'
import { firmaMaBlWPanelu } from '@/lib/kanaly/firma'
import { ZWROTY_LIMIT, ZWROTY_LISTS, type ZwrotyLista, zwrotyPanel } from '@/lib/panel/zwroty'
import { SYGNAL_LABEL, SYGNAL_TONE } from '@/lib/zwroty/sygnaly'
import { etykietaPowodu, RODZAJ_ZWROTU, STATUS_ZWROTU, STATUSY_ZWROTU, TON_STATUSU, ZRODLO_ZWROTU } from '@/lib/zwroty/statusy'
import { KlikalneWiersze } from '../_komponenty/wiersze'
import '../zamowienia/_lista/lista.css'

// zwroty i reklamacje prowadzone w Kompletorze. Zakładki ze statusami jak w module zwrotów BL
// (Nowe, Odebrane, W trakcie, Zakończone, Odrzucone) i licznikami; za nimi podgląd sygnałów z kanałów i reklamacji
// z kopii BL. „Stwórz zwrot” z tej listy albo z karty zamówienia (menu „Więcej”).
export const metadata = { title: 'Zwroty i reklamacje' }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

function orderNo(accs: AccountRef[], channel: Channel, channelAccountId: string, externalId: string): string {
  return `${channelPrefix(channel, accountName(accs, channel, channelAccountId))} ${shortExternalId(externalId)}`
}

const jeden = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default async function Zwroty({ searchParams }: Props) {
  const ctx = await requireSession()
  const sp = await searchParams
  const raw = jeden(sp.lista)
  const list: ZwrotyLista = raw && raw in ZWROTY_LISTS ? (raw as ZwrotyLista) : 'wlasne'
  const rawStatus = jeden(sp.status)
  const status = rawStatus && (STATUSY_ZWROTU as readonly string[]).includes(rawStatus) ? (rawStatus as ReturnStatus) : undefined
  // ekran otwarty z karty zamówienia pokazuje tylko to zamówienie (?zamowienie=<id>)
  const rawZam = jeden(sp.zamowienie)
  const zam = rawZam && /^[a-z0-9]{1,40}$/i.test(rawZam) ? await ctx.db.order.findUnique({ where: { id: rawZam }, select: { id: true, channel: true, channelAccountId: true, externalId: true } }) : null
  const [d, accs, hasBl] = await Promise.all([zwrotyPanel(ctx.db, list, { orderId: zam?.id, ...(list === 'wlasne' && status ? { status } : {}) }), accounts(ctx.db), firmaMaBlWPanelu(ctx.db)])
  // zakładka reklamacji z kopii BaseLinkera tylko dla firmy z BL (albo gdy kopia ma reklamacje)
  const pokazReklamacjeBl = !zam && (hasBl || d.counts.reklamacje > 0)
  const now = new Date()
  const capped = d.counts[list] > ZWROTY_LIMIT
  const moze = ctx.permissions.has('zwroty.przyjecie')
  const q = (extra: Record<string, string | undefined>) => {
    const p = new URLSearchParams()
    if (zam) p.set('zamowienie', zam.id)
    for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v)
    const s = p.toString()
    return `/zwroty${s ? `?${s}` : ''}`
  }
  const wszystkie = STATUSY_ZWROTU.reduce((s, x) => s + d.ownByStatus[x], 0)
  const nowy = `/zwroty/nowy${zam ? `?zamowienie=${zam.id}` : ''}`

  return (
    <>
      <NaglowekStrony
        tytul="Zwroty i reklamacje"
        podtytul="Zwrot zawsze dotyczy zamówienia. Po odbiorze paczki oznaczasz każdą pozycję: na stan albo uszkodzone. Korekta faktury idzie przez program do faktur firmy."
        akcje={
          moze ? (
            <PrzyciskLink href={nowy} wariant="glowny">
              Stwórz zwrot
            </PrzyciskLink>
          ) : null
        }
      />

      {zam && (
        <div className="banner blue">
          <div>
            Zamówienie <Link href={`/zamowienia/${zam.id}`}>{orderNo(accs, zam.channel, zam.channelAccountId, zam.externalId)}</Link>: tylko jego zwroty i reklamacje. <Link href="/zwroty">Wszystkie zwroty</Link>
          </div>
        </div>
      )}

      {/* lewy panel statusów zniknął z ramy panelu, statusy zwrotów idą zakładkami nad listą (jak Braki) */}
      <Zakladki
        etykieta="Statusy zwrotów"
        zakladki={[
          { href: q({}), etykieta: 'Wszystkie', licznik: wszystkie, aktywna: list === 'wlasne' && !status },
          ...STATUSY_ZWROTU.map((s) => ({ href: q({ status: s }), etykieta: STATUS_ZWROTU[s], licznik: d.ownByStatus[s], aktywna: list === 'wlasne' && status === s, ...(s === 'ZGLOSZONY' && d.ownByStatus[s] > 0 ? { tonLicznika: 'ostrzezenie' as const } : {}) })),
          { href: q({ lista: 'sygnaly' }), etykieta: ZWROTY_LISTS.sygnaly, licznik: d.counts.sygnaly, aktywna: list === 'sygnaly' },
          ...(!pokazReklamacjeBl ? [] : [{ href: q({ lista: 'reklamacje' }), etykieta: ZWROTY_LISTS.reklamacje, licznik: d.counts.reklamacje, aktywna: list === 'reklamacje' }]),
        ]}
      />

      <div className="zl-glowna">
        {capped && (
          <p className="muted small">
            Pokazuję {int(ZWROTY_LIMIT)} najnowszych z {int(d.counts[list])}.
          </p>
        )}

        {list === 'wlasne' &&
          (d.own.length === 0 ? (
            <PustyStan
              tytul={status ? `Nie ma zwrotów w statusie „${STATUS_ZWROTU[status]}”` : 'Nie ma zwrotów'}
              akcja={
                moze ? (
                  <PrzyciskLink href={nowy} wariant="drugorzedny">
                    Stwórz zwrot
                  </PrzyciskLink>
                ) : null
              }
            >
              Zwrot założysz przyciskiem „Stwórz zwrot” albo na karcie zamówienia (menu „Więcej”). Zwroty klientów z Allegro pojawią się tu same, w statusie „Nowe”.
            </PustyStan>
          ) : (
            <KlikalneWiersze>
              <table className="tbl cards olist">
                <thead>
                  <tr>
                    <th>Zwrot</th>
                    <th>Zamówienie</th>
                    <th>Status</th>
                    <th>Powód</th>
                    <th className="right">Pozycji</th>
                    <th>Kiedy</th>
                  </tr>
                </thead>
                <tbody>
                  {d.own.map((r) => {
                    const nr = orderNo(accs, r.order.channel, r.order.channelAccountId, r.order.externalId)
                    const href = `/zwroty/${r.id}`
                    return (
                      <tr key={r.id} className="orow" data-href={href} tabIndex={0} aria-label={`${RODZAJ_ZWROTU[r.kind]} do ${nr}: otwórz`}>
                        <td data-label="Zwrot">
                          <Link className="ord" href={href}>
                            {RODZAJ_ZWROTU[r.kind]}
                          </Link>
                          <span className="sub">{ZRODLO_ZWROTU[r.source] ?? r.source}</span>
                        </td>
                        <td data-label="Zamówienie">
                          <Link href={`/zamowienia/${r.order.id}`}>{nr}</Link>
                        </td>
                        <td data-label="Status">
                          <Odznaka ton={TON_STATUSU[r.status]} kropka>
                            {STATUS_ZWROTU[r.status]}
                          </Odznaka>
                        </td>
                        <td data-label="Powód">{etykietaPowodu(r.kind, r.reason) ?? <span className="muted">brak</span>}</td>
                        <td data-label="Pozycji" className="right num">
                          {r.lines}
                        </td>
                        <td data-label="Kiedy">{when(r.createdAt, now)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </KlikalneWiersze>
          ))}

        {list === 'sygnaly' && (
          <>
            <p className="muted small">Podgląd: statusy zamówień w sklepach, które wyglądają na zwrot albo reklamację. Zwrot przyjmujesz przyciskiem „Stwórz zwrot”.</p>
            {d.signals.length === 0 ? (
              <PustyStan tytul="Nie ma sygnałów zwrotu">Gdy sklep oznaczy zamówienie jako zwrot albo reklamację, pojawi się tutaj.</PustyStan>
            ) : (
              <KlikalneWiersze>
                <table className="tbl cards olist">
                  <thead>
                    <tr>
                      <th>Zamówienie</th>
                      <th>Sygnał</th>
                      <th>Status kanału</th>
                      <th className="right">Kwota</th>
                      <th>Kiedy</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.signals.map((s) => {
                      const nr = orderNo(accs, s.channel, s.channelAccountId, s.externalId)
                      const href = s.orderId ? `/zamowienia/${s.orderId}` : null
                      return (
                        <tr key={s.id} className="orow" {...(href ? { 'data-href': href, tabIndex: 0, 'aria-label': `${nr}: otwórz zamówienie` } : {})}>
                          <td data-label="Zamówienie">
                            {href ? (
                              <Link className="ord" href={href}>
                                {nr}
                              </Link>
                            ) : (
                              <>
                                <span className="ord">{nr}</span>
                                <span className="sub">sprzed pierwszego odczytu, bez zamówienia u nas</span>
                              </>
                            )}
                          </td>
                          <td data-label="Sygnał">
                            <span className={`chip ${SYGNAL_TONE[s.signal]}`}>{SYGNAL_LABEL[s.signal]}</span>
                          </td>
                          <td data-label="Status kanału" className="mono small">
                            {s.channelStatus}
                          </td>
                          <td data-label="Kwota" className="right num">
                            {money(s.totalGross)}
                          </td>
                          <td data-label="Kiedy">{when(s.at, now)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </KlikalneWiersze>
            )}
          </>
        )}

        {list === 'reklamacje' && (
          <>
            <p className="muted small">Podgląd z kopii BaseLinkera (zamówienia z okna porównania). Reklamację prowadzoną w Kompletorze zakładasz przyciskiem „Stwórz zwrot” z rodzajem „Reklamacja”.</p>
            {d.complaints.length === 0 ? (
              <PustyStan tytul="Nie ma reklamacji">Żadne zamówienie z kopii BaseLinkera nie ma statusu z rodziny „Reklamacja”.</PustyStan>
            ) : (
              <KlikalneWiersze>
                <table className="tbl cards olist">
                  <thead>
                    <tr>
                      <th>Zamówienie</th>
                      <th>Status w BL</th>
                      <th className="right">Kwota</th>
                      <th>Kiedy</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.complaints.map((c) => {
                      const cc = c.channelCopy
                      const nr = cc ? orderNo(accs, cc.channel, cc.channelAccountId, cc.externalId) : orderNo(accs, c.channel, c.channelAccountId, c.externalRef ?? `BL ${c.blOrderId}`)
                      const href = cc?.orderId ? `/zamowienia/${cc.orderId}` : null
                      return (
                        <tr key={c.blOrderId} className="orow" {...(href ? { 'data-href': href, tabIndex: 0, 'aria-label': `${nr}: otwórz zamówienie` } : {})}>
                          <td data-label="Zamówienie">
                            {href ? (
                              <Link className="ord" href={href}>
                                {nr}
                              </Link>
                            ) : (
                              <span className="ord">{nr}</span>
                            )}
                            <span className="sub">{cc ? (cc.orderId ? `BL ${c.blOrderId}` : `BL ${c.blOrderId} · sprzed pierwszego odczytu`) : `BL ${c.blOrderId} · bez kopii kanału`}</span>
                          </td>
                          <td data-label="Status w BL" className="small">
                            {c.statusName}
                          </td>
                          <td data-label="Kwota" className="right num">
                            {money(c.totalGross)}
                          </td>
                          <td data-label="Kiedy">
                            {when(c.fetchedAt, now)}
                            <span className="sub">zamówienie z {when(c.dateAdd, now)}</span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </KlikalneWiersze>
            )}
          </>
        )}
      </div>
    </>
  )
}
