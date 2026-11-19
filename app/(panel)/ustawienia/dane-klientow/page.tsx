// Ustawienia → Dane klientów: stan zapisu i kluczy, zapis w cieniu, retencja (wartości domyślne do
// potwierdzenia przez księgową), tryb raport/usuwanie, licznik rekordów po terminie i dziennik podglądów (numer
// zamówienia, cel, kto, kiedy — bez danych klienta). Tylko z uprawnieniem `ustawienia`.
import Link from 'next/link'
import { zapisKlientaWlaczony, zapisKlientaZEnv } from '@/lib/klienci/kolejka'
import { dziennikPodgladow } from '@/lib/klienci/odczyt'
import { stanKluczyKlientow } from '@/lib/klienci/szyfr'
import { licznikiKlientow, RETENCJA_BEZ_FAKTURY_MIESIECY, RETENCJA_Z_FAKTURA_LAT, ustawieniaKlientow } from '@/lib/klienci/ustawienia'
import { accountName, accounts } from '@/lib/panel/dane'
import { channelPrefix, shortExternalId } from '@/lib/panel/format'
import { requirePermission } from '@/lib/panel/kontekst'
import { nazwyOsobFirmy } from '@/lib/panel/ustawienia-rezerwacji'
import { fromWarsaw } from '@/lib/rdzen/kalendarz'
import { zapiszDaneKlientow } from './akcje'
import { PasekZapisu, ToastZAdresuZapisu } from '@/app/ui' // jeden zapis na ekran

export const metadata = { title: 'Dane klientów' }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
const DT = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Warsaw' })
const DZIEN = /^\d{4}-\d{2}-\d{2}$/
const CEL: Record<string, string> = {
  PODGLAD: 'podgląd',
  KOPIA: 'kopiowanie adresu',
  WYDRUK: 'wydruk',
  PRZESYLKA: 'przesyłka',
  FAKTURA: 'faktura',
  FAKTURA_PDF: 'PDF faktury',
  WYSZUKIWANIE: 'wyszukiwanie',
  EKSPORT: 'eksport',
  OBSLUGA_KLIENTA: 'obsługa klienta przez API (zamówienia po e-mailu albo telefonie)',
}
const KLUCZ = { ok: 'ustawiony', brak: 'brak', blad: 'zła wartość' } as const
// filtr „Osoba”: wartości zbiorcze (odczyty chatbota przez klucz API nie wypychają podglądów ludzi z listy)
const autorZbiorczy = (v: string) => (v === 'ludzie' || v === 'klucze' ? v : undefined)

function dzienPlus(d: string): string {
  const x = new Date(`${d}T12:00:00Z`)
  x.setUTCDate(x.getUTCDate() + 1)
  return x.toISOString().slice(0, 10)
}

export default async function DaneKlientow({ searchParams }: Props) {
  const ctx = await requirePermission('ustawienia')
  const sp = await searchParams
  const osoba = one(sp.osoba) ?? ''
  const od = DZIEN.test(one(sp.od) ?? '') ? one(sp.od)! : ''
  const doDnia = DZIEN.test(one(sp.do) ?? '') ? one(sp.do)! : ''
  let zapisInstancji: boolean | null
  try {
    zapisInstancji = zapisKlientaZEnv(process.env)
  } catch {
    zapisInstancji = null
  }
  const klucze = stanKluczyKlientow(process.env)
  const [u, { zDanymi: liczba, usuniete }, wpisy, czlonkowie, accs] = await Promise.all([
    ustawieniaKlientow(ctx.db),
    licznikiKlientow(ctx.db),
    dziennikPodgladow(ctx.db, { actorId: autorZbiorczy(osoba) ? undefined : osoba || undefined, autor: autorZbiorczy(osoba), od: od ? fromWarsaw(od, 0) : undefined, do: doDnia ? fromWarsaw(dzienPlus(doDnia), 0) : undefined, limit: 200 }),
    ctx.db.membership.findMany({ select: { userId: true } }),
    accounts(ctx.db),
  ])
  const nazwy = await nazwyOsobFirmy(ctx.db, [...new Set([...czlonkowie.map((m) => m.userId), ...wpisy.map((w) => w.kto)])])
  const zamowienia = new Map(
    (await ctx.db.order.findMany({ where: { id: { in: wpisy.map((w) => w.orderId) } }, select: { id: true, channel: true, channelAccountId: true, externalId: true } })).map((o) => [
      o.id,
      `${channelPrefix(o.channel, accountName(accs, o.channel, o.channelAccountId))} ${shortExternalId(o.externalId)}`,
    ]),
  )
  // wpisy kluczy API (obsługa klienta): nazwa klucza z listy firmy, bez treści klucza
  const kluczeApi = new Map(
    (await ctx.db.apiKey.findMany({ where: { id: { in: wpisy.flatMap((w) => (w.kto.startsWith('api:') ? [w.kto.slice(4)] : [])) } }, select: { id: true, name: true, prefix: true } })).map((k) => [k.id, `${k.name} (${k.prefix}…)`]),
  )
  const kto = (id: string) =>
    nazwy.get(id) ?? (id.startsWith('system:') ? `system (${id.slice(7)})` : id.startsWith('api:') ? `klucz API ${kluczeApi.get(id.slice(4)) ?? '(usunięty)'}` : 'system')
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Dane klientów</h1>
          <div className="sub">
            Dane klienta w zamówieniu (nabywca, adres, telefon, e-mail, dane do faktury) są zapisane w bazie zaszyfrowane osobnym kluczem. Widzą je osoby z uprawnieniem
            „Dane klienta”, każdy podgląd trafia do dziennika poniżej. Opis: Pomoc → Dane klienta.
          </div>
        </div>
      </header>

      {zapisInstancji !== true && (
        <div className="banner amber" role="status">
          <div>
            {zapisInstancji === null
              ? 'Zapis danych klientów na tej instalacji ma błędne ustawienie i nie działa. Poproś administratora instalacji o poprawkę (opis w Pomocy: „Dane klienta”).'
              : 'Zapis danych klientów jest wyłączony na tej instalacji. Ustawienia można zapisać; zamówienia nie dostaną danych, dopóki administrator instalacji nie włączy zapisu.'}
          </div>
        </div>
      )}
      {(klucze.dane !== 'ok' || klucze.skroty !== 'ok') && (
        <div className="banner red" role="alert">
          <div>
            Klucz szyfrowania danych klientów: {KLUCZ[klucze.dane]}; klucz do wyszukiwania po e-mailu i telefonie: {KLUCZ[klucze.skroty]}. Klucze ustawia administrator instalacji. Bez nich zapis odmawia,
            a karta zamówienia pokazuje „Dane klienta niedostępne”.
          </div>
        </div>
      )}
      <ToastZAdresuZapisu />

      <form action={zapiszDaneKlientow} className="stack" aria-label="Ustawienia danych klientów">
        <section className="card" aria-labelledby="h-zapis">
          <h2 id="h-zapis" style={{ marginBottom: 8 }}>
            Zapis
          </h2>
          <label className="small">
            <input type="checkbox" name="cien" value="tak" defaultChecked={u.zapisWCieniu} /> Zapisuj dane klientów także z kont „Tylko podgląd” (do testów przed włączeniem konta)
          </label>
          <p className="muted small">
            W bazie: {liczba} zamówień z danymi klienta, {usuniete} z usuniętymi danymi. Zapis na tej instalacji: {zapisKlientaWlaczony(process.env) ? 'włączony' : 'wyłączony'}.
          </p>
        </section>

        <section className="card" aria-labelledby="h-ret">
          <h2 id="h-ret" style={{ marginBottom: 8 }}>
            Jak długo przechowujemy
          </h2>
          <div className="chips">
            <label className="small">
              Zamówienie z fakturą, lat od końca roku faktury{' '}
              <input className="input" name="lat" type="number" min={1} max={20} defaultValue={u.retencjaZFakturaLat} style={{ width: 80 }} />
            </label>
            <label className="small">
              Bez faktury, miesięcy od dostarczenia albo anulowania{' '}
              <input className="input" name="miesiecy" type="number" min={1} max={240} defaultValue={u.retencjaBezFakturyMiesiecy} style={{ width: 80 }} />
            </label>
          </div>
          <p className="muted small">
            Wartości domyślne {RETENCJA_Z_FAKTURA_LAT} lat i {RETENCJA_BEZ_FAKTURY_MIESIECY} miesięcy są do potwierdzenia przez księgową. Otwarty zwrot albo reklamacja wstrzymuje termin.
          </p>
          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="small">Po terminie</legend>
            <label className="small">
              <input type="radio" name="tryb" value="RAPORT" defaultChecked={u.trybRetencji === 'RAPORT'} /> Tylko licz (raport, nic nie usuwa)
            </label>
            <label className="small">
              <input type="radio" name="tryb" value="USUWAJ" defaultChecked={u.trybRetencji === 'USUWAJ'} /> Usuwaj dane klientów po terminie (raz na dobę)
            </label>
          </fieldset>
          <p className="small">
            Po terminie: <b>{u.ostatniPoTerminie ?? '—'}</b>
            {u.ostatniPrzebiegAt ? ` (ostatni przebieg ${DT.format(u.ostatniPrzebiegAt)}${u.ostatnioUsunieto ? `, usunięto ${u.ostatnioUsunieto}` : ''})` : ' (przebieg jeszcze się nie odbył)'}
          </p>
          <div>
            <PasekZapisu />
          </div>
        </section>
      </form>

      <section className="card" aria-labelledby="h-dziennik" style={{ marginTop: 16 }}>
        <h2 id="h-dziennik" style={{ marginBottom: 8 }}>
          Dziennik podglądów
        </h2>
        <form method="get" className="filters-grid">
          <div className="field">
            <label htmlFor="f-osoba">Osoba</label>
            <select className="input" id="f-osoba" name="osoba" defaultValue={osoba}>
              <option value="">Wszyscy</option>
              <option value="ludzie">Tylko osoby (bez kluczy API)</option>
              <option value="klucze">Tylko klucze API</option>
              {czlonkowie.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {nazwy.get(m.userId) ?? 'osoba'}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-od">Od</label>
            <input className="input" id="f-od" name="od" type="date" defaultValue={od} />
          </div>
          <div className="field">
            <label htmlFor="f-do">Do</label>
            <input className="input" id="f-do" name="do" type="date" defaultValue={doDnia} />
          </div>
          <div className="field filters-go">
            <button className="btn" type="submit">
              Pokaż
            </button>
          </div>
        </form>
        {wpisy.length === 0 ? (
          <p className="muted small">Brak wpisów.</p>
        ) : (
          <table className="tbl cards">
            <thead>
              <tr>
                <th>Kiedy</th>
                <th>Kto</th>
                <th>Zamówienie</th>
                <th>Cel</th>
              </tr>
            </thead>
            <tbody>
              {wpisy.map((w) => (
                <tr key={w.id}>
                  <td data-label="Kiedy" className="small">
                    {DT.format(w.kiedy)}
                  </td>
                  <td data-label="Kto">{kto(w.kto)}</td>
                  <td data-label="Zamówienie">
                    {w.orderId === 'wyszukiwanie' ? (
                      <span className="muted">wyszukiwanie: {w.trafienia ?? 0} traf.</span>
                    ) : (
                      <Link href={`/zamowienia/${w.orderId}`}>{zamowienia.get(w.orderId) ?? 'zamówienie'}</Link>
                    )}
                  </td>
                  <td data-label="Cel" className="small">
                    {CEL[w.cel] ?? w.cel}
                    {w.zakres === 'SKROT' ? ' (skrót)' : ''}
                    {w.wynik === 'ODMOWA' ? ' · odmowa' : w.wynik ? ` · ${w.wynik.toLowerCase().replace('_', ' ')}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">Najnowsze 200 wpisów. Dziennik nie zawiera danych klienta ani szukanych fraz.</p>
      </section>
    </>
  )
}
