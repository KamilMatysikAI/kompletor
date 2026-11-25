// Sekcja „Dokument sprzedaży” karty zamówienia (jedna sekcja): stan faktury słowem
// („W kolejce”, „Wystawiona”, „Błąd: …”), numer z programu do faktur (tylko tu), PDF do pobrania i „Ponów fakturę” po
// błędzie, faktura na firmę i w środku podgląd KSeF dla firm bez wFirmy. Wystawia kolejka wFirmy (worker),
// nie ten ekran — i tylko przy włączonym „Wystawiaj faktury z Kompletora” (Ustawienia → Dokumenty sprzedaży).
import Link from 'next/link'
import { Baner, ListaOpisowa, Odznaka, PrzyciskLink, Sekcja } from '@/app/ui'
import { ustawieniaDokumentowFirmy } from '@/lib/dokumenty/firma'
import { chwilaAutomatuWz, ETYKIETA_MOMENTU, momentDlaZrodla, type UstawieniaDokumentow, walutaZamowieniaWlaczona } from '@/lib/dokumenty/ustawienia'
import type { DaneKarty } from '@/lib/karta/dane'
import { stanFaktury } from '@/lib/karta/stan-faktury'
import type { PanelContext } from '@/lib/panel/kontekst'
import { fakturaZBl } from '@/lib/rdzen/faktura-bl'
import { money } from '@/lib/panel/format'
import { flagsOf } from '@/lib/rdzen/rezerwacja'
import { walutaCzekaNaPonowienie } from '@/lib/rdzen/waluta'
import { FAKTURA_WALUTA } from '@/lib/wfirma/adapter-zapis'
import { zrodloStanu } from '@/lib/rdzen/zrodlo-stanu'
import { DokumentWystawiony } from './dokument-wystawiony'
import { BlokFakturyKsef } from './faktura-ksef'
import { OdswiezajFakture } from './odswiezaj-fakture'
import { PonowFakture } from './ponow-fakture'

/** Ostatni błąd faktury bieżącej paczki dla obsługi (komunikat programu do faktur, bez danych klienta). */
function ostatniBlad(d: Pick<DaneKarty, 'o'>): string | null {
  const ost = d.o.invoices.filter((i) => i.packageNo === d.o.packageNo && i.state === 'FAILED').at(-1)
  return ost?.lastError ?? flagsOf(d.o).lastError ?? null
}

function opisWylacznika(u: UstawieniaDokumentow): string | null {
  if (u.program !== 'wfirma' || u.fakturyWlaczone) return null
  return 'Wystawianie faktur z Kompletora jest wyłączone: fakturę wystawia BaseLinker albo biuro ręcznie w wFirmie.'
}

export async function Faktura({ d, ctx }: { d: DaneKarty; ctx: PanelContext }) {
  const u = await ustawieniaDokumentowFirmy(ctx.db)
  // firma bez programu do faktur — zamówienie zamyka się bez dokumentu, bez bloku wFirmy i KSeF
  if (u.program === 'brak')
    return (
      <Sekcja tytul="Dokument sprzedaży" id="dokument">
        <p className="small">
          Ta firma nie wystawia faktur z Kompletora: zamówienie zamyka się po wysyłce bez dokumentu. Program do faktur wybierasz w <Link href="/ustawienia/dokumenty">Ustawienia → Dokumenty i faktury → Dokumenty sprzedaży</Link>.
        </p>
        <ListaOpisowa pozycje={[{ etykieta: 'Faktura na firmę', wartosc: d.o.wantInvoiceNip ? 'tak (klient prosi o fakturę: wystaw ją poza Kompletorem)' : 'nie' }]} />
      </Sekcja>
    )
  const zrodlo = await zrodloStanu(ctx.db)
  const m = momentDlaZrodla(zrodlo, u)
  // ta sama bramka co kolejka — fakturuje tylko zamówienia spakowane po chwili włączenia
  const od = u.fakturyWlaczone && u.fakturyWlaczoneOd ? new Date(u.fakturyWlaczoneOd) : null
  const spakowanePrzedWlaczeniem = !!od && d.o.status === 'SPAKOWANE' && !(await ctx.db.orderEvent.count({ where: { orderId: d.o.id, kind: 'SPAKOWANE', createdAt: { gte: od } } }))
  // zamówienie w obcej walucie z dokumentem spoza Kompletora (faktura z BaseLinkera albo dokument potwierdzony
  // przez biuro po wysyłce) pokazuje stan jak przed zmianą, bez „wystaw fakturę ręcznie”
  const dokumentPoza =
    d.waluta !== 'PLN' &&
    ((await fakturaZBl(ctx.db, d.o)) !== null ||
      ((d.o.status === 'WYSLANE' || d.o.status === 'ODEBRANE') && (await ctx.db.orderEvent.count({ where: { orderId: d.o.id, kind: 'DOKUMENT_WYSTAWIONY_RECZNIE' } })) > 0))
  const settings = (await ctx.db.organization.findFirst({ select: { settings: true } }))?.settings ?? null
  // „Faktury w walucie zamówienia” włączone = obca waluta idzie zwykłą drogą (bez „wystaw ręcznie”); zamówienie
  // sprzed włączenia (ze śladem blokady albo bez, reguła w lib/rdzen/waluta.ts) czeka na „Ponów fakturę”
  const walutaWfirmy = d.waluta !== 'PLN' && walutaZamowieniaWlaczona(settings)
  const walutaZatrzymana = walutaWfirmy && (await walutaCzekaNaPonowienie(ctx.db, d.o))
  const s = stanFaktury(d, ETYKIETA_MOMENTU[m.wystawiajPrzy], m, {
    spakowanePrzedWlaczeniem,
    // ta sama bramka co kolejka: bez włączenia (i jego chwili) żadna faktura nie powstanie, a przy stanie w programie do
    // faktur faktura z rozchodem idzie tylko ze statusu „Spakowane”
    wystawianieWylaczone: !u.fakturyWlaczone || !u.fakturyWlaczoneOd,
    tylkoSpakowane: zrodlo === 'WFIRMA',
    ...(d.waluta !== 'PLN' ? (walutaWfirmy ? { dokumentPoza, ...(walutaZatrzymana ? { walutaZatrzymana: d.waluta } : {}) } : { obcaWaluta: d.waluta, dokumentPoza }) : {}),
  })
  const ost = d.o.invoices.filter((i) => i.packageNo === d.o.packageNo).at(-1)
  const blad = s.blad ? ostatniBlad(d) : null
  const wylacznik = opisWylacznika(u)
  const mozeFaktury = ctx.permissions.has('zamowienia.faktury')
  const pdf = s.wystawiona && u.program === 'wfirma' && ost?.wfirmaDocId
  // wysłane bez dokumentu (lustro wFirmy) — biuro potwierdza ręcznie wystawiony dokument
  const ruchyBez = await ctx.db.pendingMovement.findMany({ where: { orderId: d.o.id, type: 'ISSUED_WITHOUT_DOCUMENT', state: 'MANUAL' }, select: { sentAt: true, idempotencyKey: true } })
  const bezDokumentu = ruchyBez.length
  // WZ wystawi Kompletor sam (przełączniki włączone, wysyłka po chwili włączenia): biuro nie wystawia równolegle
  const wzOd = bezDokumentu ? chwilaAutomatuWz(settings) : null
  const automatWz = !!wzOd && ruchyBez.every((m) => (m.idempotencyKey ?? '').startsWith('bez-dokumentu:') && m.sentAt >= wzOd)
  const alertyWz = bezDokumentu
    ? await ctx.db.alert.findMany({ where: { ref: d.o.id, closedAt: null, kind: { in: ['WZ_BLAD', 'WZ_NIEWIADOMA'] } }, orderBy: { createdAt: 'desc' }, take: 3, select: { id: true, kind: true, message: true } })
    : []
  const akcje = (
    <>
      {pdf ? (
        mozeFaktury && ctx.permissions.has('klienci.dane') ? (
          <PrzyciskLink href={`/api/wydruki/faktura?z=${d.o.id}`} wariant="drugorzedny" rozmiar="sm" target="_blank" rel="noopener" prefetch={false}>
            PDF faktury
          </PrzyciskLink>
        ) : (
          <span className="muted small">PDF: brak uprawnienia do faktur i danych klienta</span>
        )
      ) : null}
      {s.blad ? <PonowFakture orderId={d.o.id} powodWylaczenia={!mozeFaktury ? 'Brak uprawnienia „Faktura na karcie zamówienia”' : wylacznik ? 'Wystawianie faktur z Kompletora jest wyłączone w ustawieniach' : null} /> : null}
      {bezDokumentu ? <DokumentWystawiony orderId={d.o.id} powodWylaczenia={!mozeFaktury ? 'Brak uprawnienia „Faktura na karcie zamówienia”' : null} /> : null}
    </>
  )
  // kwota, waluta i kurs faktury z odczytu wFirmy po wystawieniu (ślad FAKTURA_WALUTA z adaptera zapisu)
  const sladWaluty =
    walutaWfirmy && s.wystawiona && ost?.wfirmaDocId
      ? ((await ctx.db.orderEvent.findFirst({ where: { orderId: d.o.id, kind: FAKTURA_WALUTA, data: { path: ['docId'], equals: ost.wfirmaDocId } }, orderBy: { createdAt: 'desc' }, select: { data: true } }))?.data as { waluta?: string; bruttoGr?: number | null; kurs?: number | null; dataKursu?: string | null; tabela?: string | null } | null | undefined)
      : null
  const walutaFaktury = walutaWfirmy
    ? sladWaluty && typeof sladWaluty.bruttoGr === 'number'
      ? `${money(sladWaluty.bruttoGr / 100, sladWaluty.waluta ?? d.waluta)}${sladWaluty.kurs ? `, kurs NBP ${String(sladWaluty.kurs).replace('.', ',')} zł${sladWaluty.dataKursu ? ` z ${sladWaluty.dataKursu}` : ''}${sladWaluty.tabela ? ` (tabela ${sladWaluty.tabela})` : ''}` : ''}`
      : `${d.waluta}, kurs średni NBP dobiera wFirma${s.wystawiona ? ' (sprawdź na fakturze w wFirmie)' : ''}`
    : null
  const pozycje = [
    {
      etykieta: 'Faktura',
      wartosc: (
        <>
          <Odznaka ton={s.ton} className="kz-zawijaj">
            {s.tekst}
          </Odznaka>
          {ost && ost.attemptNo > 1 ? <span className="muted small"> · próba {ost.attemptNo}</span> : null}
        </>
      ),
    },
    ...(blad ? [{ etykieta: 'Powód', wartosc: <span className="small">{blad}</span> }] : []),
    ...(s.numer ? [{ etykieta: 'Numer', wartosc: <span className="mono">{s.numer}</span> }] : []),
    ...(walutaFaktury ? [{ etykieta: s.wystawiona && sladWaluty ? 'Kwota faktury' : 'Waluta faktury', wartosc: <span className="small">{walutaFaktury}</span> }] : []),
    { etykieta: 'Faktura na firmę', wartosc: d.o.wantInvoiceNip ? 'tak' : 'nie' },
    { etykieta: 'Kiedy powstaje', wartosc: `${ETYKIETA_MOMENTU[m.wystawiajPrzy]}${m.tylkoNaZadanie ? ', tylko gdy klient prosi o fakturę' : ''}` },
  ]
  return (
    <Sekcja tytul="Dokument sprzedaży" id="dokument" akcje={pdf || s.blad || bezDokumentu ? akcje : undefined}>
      {wylacznik && (
        <Baner ton="info">
          {wylacznik} Włączasz je w <Link href="/ustawienia/dokumenty">Ustawienia → Dokumenty i faktury → Dokumenty sprzedaży</Link>.
        </Baner>
      )}
      {s.blad && !wylacznik && (
        <Baner ton="blad" tytul="Faktura się nie wystawiła">
          Sprawdź w wFirmie, czy faktury nie ma (wtedy nie ponawiaj), popraw przyczynę i kliknij „Ponów fakturę”. Kompletor nie wystawi drugiej faktury tej samej paczki: przed nową próbą sprawdza w wFirmie poprzednią.
        </Baner>
      )}
      {bezDokumentu ? (
        <Baner ton={alertyWz.length ? 'blad' : 'info'} tytul="Wysłane bez dokumentu w wFirmie">
          {alertyWz.length
            ? alertyWz.map((a) => <p key={a.id}>{a.message}</p>)
            : automatWz
              ? 'Zamówienie wyszło bez faktury. Kompletor wystawi dokument WZ w wFirmie sam w ciągu kilku minut: nie wystawiaj go ręcznie.'
              : 'Zamówienie wyszło bez faktury i bez dokumentu WZ w wFirmie. Wystaw dokument w wFirmie i kliknij „Dokument wystawiony”.'}
        </Baner>
      ) : null}
      {s.wToku || s.tekst === 'W kolejce' ? <OdswiezajFakture /> : null}
      <ListaOpisowa pozycje={pozycje} />
      <BlokFakturyKsef ctx={ctx} orderId={d.o.id} />
    </Sekcja>
  )
}
