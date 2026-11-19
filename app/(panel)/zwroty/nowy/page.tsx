import Link from 'next/link'
import type { Channel } from '@prisma/client'
import { Baner, Karta, NaglowekStrony, PustyStan } from '@/app/ui'
import { accountName, accounts } from '@/lib/panel/dane'
import { channelPrefix, shortExternalId } from '@/lib/panel/format'
import { requirePermission } from '@/lib/panel/kontekst'
import { zamowienieDoZwrotu } from '@/lib/zwroty/karta'
import { FormularzZwrotu } from './formularz'
import '../zwroty.css'

// „Stwórz zwrot” (z listy zwrotów albo z karty zamówienia, menu „Więcej”). Bez zamówienia: wyszukiwarka
// po numerze zamówienia; zwrot zawsze jest powiązany z zamówieniem.
export const metadata = { title: 'Stwórz zwrot' }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }
const jeden = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default async function NowyZwrot({ searchParams }: Props) {
  const ctx = await requirePermission('zwroty.przyjecie')
  const sp = await searchParams
  const accs = await accounts(ctx.db)
  const rawZam = jeden(sp.zamowienie)
  const typ = jeden(sp.typ) === 'reklamacja' ? 'reklamacja' : 'zwrot'
  const z = rawZam && /^[a-z0-9]{1,40}$/i.test(rawZam) ? await zamowienieDoZwrotu(ctx.db, rawZam) : null
  const numer = (jeden(sp.numer) ?? '').trim().slice(0, 60)
  const znalezione =
    !z && numer.length >= 2
      ? await ctx.db.order.findMany({ where: { externalId: { contains: numer, mode: 'insensitive' } }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, channel: true, channelAccountId: true, externalId: true } })
      : []
  const nr = (o: { channel: string; channelAccountId: string; externalId: string }) => `${channelPrefix(o.channel as Channel, accountName(accs, o.channel as Channel, o.channelAccountId))} ${shortExternalId(o.externalId)}`
  const tytul = typ === 'reklamacja' ? 'Nowa reklamacja' : 'Stwórz zwrot'

  return (
    <>
      <NaglowekStrony tytul={tytul} podtytul={<Link href="/zwroty">← Zwroty i reklamacje</Link>} />
      {!z ? (
        <Karta tytul="Którego zamówienia dotyczy zwrot?">
          <form method="get" action="/zwroty/nowy" className="zw-szukaj">
            {typ === 'reklamacja' && <input type="hidden" name="typ" value="reklamacja" />}
            <div className="field">
              <label htmlFor="zw-numer">Numer zamówienia</label>
              <input className="input" id="zw-numer" name="numer" defaultValue={numer} minLength={2} maxLength={60} required />
            </div>
            <button className="btn primary" type="submit">
              Szukaj
            </button>
          </form>
          {numer && !znalezione.length && <p className="muted">Nie ma zamówienia z takim numerem.</p>}
          {znalezione.length > 0 && (
            <ul className="zw-wyniki">
              {znalezione.map((o) => (
                <li key={o.id}>
                  <Link href={`/zwroty/nowy?zamowienie=${o.id}${typ === 'reklamacja' ? '&typ=reklamacja' : ''}`}>{nr(o)}</Link>
                </li>
              ))}
            </ul>
          )}
          <p className="muted small">Najszybciej: otwórz zamówienie i w menu „Więcej” wybierz „Stwórz zwrot”.</p>
        </Karta>
      ) : z.pozycje.length === 0 ? (
        <PustyStan tytul="Nie ma czego zwrócić">
          Zamówienie <Link href={`/zamowienia/${z.id}`}>{nr(z)}</Link> nie ma pozycji wydanych z magazynu albo wszystko jest już w innych zwrotach. Zwrot można założyć po wydaniu towaru (spakowane albo wysłane).
        </PustyStan>
      ) : (
        <Karta tytul={`Zamówienie ${nr(z)}`} akcje={<Link href={`/zamowienia/${z.id}`}>Otwórz zamówienie</Link>}>
          <Baner ton="info">
            {z.stanKompletora
              ? 'Stan prowadzi Kompletor: po odbiorze paczki pozycje „na stan” wracają do sprzedaży od razu, uszkodzone trafiają do historii ruchów poza stanem.'
              : 'Stan prowadzi program do faktur: po odbiorze paczki potrzebna jest korekta faktury. Stan wróci po korekcie (odczyt z programu).'}
          </Baner>
          <FormularzZwrotu orderId={z.id} pozycje={z.pozycje} typ={typ} />
        </Karta>
      )}
    </>
  )
}
