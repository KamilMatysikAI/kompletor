// Pozycje karty zamówienia (układ wzorem BL): miniatura, nazwa z SKU, EAN i lokalizacją, stan
// produktu na półce, ilość, cena, VAT, rezerwacja słowem i — gdy czegoś brakuje — kolumna „Decyzja o braku”.
// Edycja w miejscu z jednym zapisem na sekcję (PasekZapisu): nowe ilości, usunięcie pozycji i decyzje o brakach idą
// jednym formularzem (lib/karta/zapis-pozycji.ts, każda zmiana osobno przez rdzeń). Ilości zmienia osoba z edycją
// pozycji na koncie w trybie PRACA przed zbieraniem, decyzje osoba z uprawnieniem do braków (w podglądzie zapisuje
// się sama decyzja). Pod tabelą: pozycje bez produktu z „Powiąż z produktem”, „Dodaj pozycję” i „Podziel zamówienie”.
// (wzór układu TwojOMS, MIT): sekcja domyślnie w odczycie — ilość, cena i VAT tekstem, braki odznaką;
// „Edytuj” w pasku nagłówka (`?edytuj=pozycje`) włącza dotychczasowe pola (ilość, „usuń”, cena, VAT) z tym samym
// zapisem `zapiszPozycjeKarta`. Decyzja o braku zostaje widoczna od razu (akcja magazynu) z zapisem samych decyzji
// (`zapiszDecyzjeKarta`). Pod tabelą podsumowanie netto / VAT / brutto (lib/karta/uklad.ts).
import Link from 'next/link'
import { Odznaka, PasekZapisu, PoleLiczbowe, PoleTekstowe, Przycisk, PrzyciskPotwierdz, Sekcja, type EdycjaSekcji } from '@/app/ui'
import { REMAP_STATUSES } from '@/lib/kanaly/oferty'
import type { DaneKarty } from '@/lib/karta/dane'
import { ODMOWA_PO_ZBIERANIU, type PowiazanieOferty } from '@/lib/karta/powiaz'
import { KOMUNIKAT_KANAL } from '@/lib/karta/pozycje'
import { adresEdycji, adresOdczytu, nazwaWKanaleInna, podsumowaniePozycji } from '@/lib/karta/uklad'
import { KOMUNIKAT_POZYCJA_ZAMIANY, normalizujStawke } from '@/lib/rdzen/edycja'
import { czyZamiennik } from '@/lib/rdzen/zamiana'
import { money, qty, SHORTAGE_LABEL, when } from '@/lib/panel/format'
import { VAT_LABEL, VAT_STAWKI } from '@/lib/produkty/karta'
import { DECYZJE, ETYKIETA_DECYZJI } from '@/lib/stanowisko/decyzje'
import { Miniatura } from '../../_komponenty/miniatura'
import { odswiezOpisKarta, powiazKarta } from './akcje-opis'
import { jednakJestKarta, podzielKarta, wyszedlKompletKarta, zapiszDecyzjeKarta, zapiszPozycjeKarta } from './akcje-pozycje'
import { DecyzjaBraku } from './decyzja-braku'
import { DodajPozycje } from './dodaj-pozycje'
import { PotwierdzUsuniecie } from './potwierdz-usuniecie'

const RES_LABEL = { ACTIVE: 'zarezerwowane', CONSUMING: 'faktura w drodze', CONSUMED: 'wydane (faktura)', RELEASED: 'zwolnione' } as const

/** Statusy, w których paczka jeszcze nie wyszła: wtedy wolno każdą decyzję o braku, potem tylko „Dośle później”. */
const PRZED_SPAKOWANIEM = ['NOWE', 'DO_REALIZACJI', 'ZBIERANIE', 'ZEBRANE', 'DO_WYJASNIENIA']

function Ukryte({ orderId, lineId }: { orderId: string; lineId?: string }) {
  return (
    <>
      <input type="hidden" name="zamowienie" value={orderId} />
      {lineId && <input type="hidden" name="pozycja" value={lineId} />}
    </>
  )
}

/** „Powiąż z produktem” dla pozycji bez produktu (powiązanie oferty jak w Ustawienia → Kanały sprzedaży). */
// oferta już powiązana → zamiast formularza informacja z SKU; gdy zamówienie jeszcze się przelicza,
// jeden przycisk dopina ten sam produkt (bez zmiany oferty). Przepięcia oferty na inny produkt karta nie oferuje.
function Powiaz({ orderId, lineId, offerId, mozna, jest, przelicza }: { orderId: string; lineId: string; offerId: string | null; mozna: boolean; jest: PowiazanieOferty | undefined; przelicza: boolean }) {
  if (!offerId || offerId.startsWith('bl-pozycja:')) return <p className="muted small kz-bez-marginesu">Kanał nie podał numeru oferty, więc nie ma czego powiązać: usuń pozycję i dodaj produkt z katalogu.</p>
  if (jest) {
    const opis = jest.active ? 'jest już powiązana' : 'była powiązana (oferta wyłączona)'
    return (
      <div className="kz-poz-akcje">
        <p className="small kz-bez-marginesu">
          Oferta <span className="mono">{offerId}</span> {opis} z produktem SKU <span className="mono">{jest.sku}</span>.{' '}
          {przelicza ? 'To zamówienie przyszło bez produktu albo się nie przeliczyło.' : ODMOWA_PO_ZBIERANIU} Z karty nie przepinamy oferty na inny produkt: jeśli w zamówieniu jest inny towar, usuń pozycję i dodaj produkt z katalogu.
        </p>
        {przelicza && mozna && (
          <form action={powiazKarta}>
            <Ukryte orderId={orderId} lineId={lineId} />
            <input type="hidden" name="sku" value={jest.sku} />
            <input type="hidden" name="sztuk" value={jest.qtyBasePerOffer} />
            <Przycisk type="submit" wariant="glowny" rozmiar="sm">
              {jest.active ? `Dopnij produkt ${jest.sku}` : `Włącz ofertę i dopnij ${jest.sku}`}
            </Przycisk>
          </form>
        )}
      </div>
    )
  }
  if (!mozna) return <p className="muted small kz-bez-marginesu">Powiązać z produktem może osoba z uprawnieniem do ustawień (Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia).</p>
  return (
    <details className="kz-zmien">
      <summary className="btn small primary">Powiąż z produktem</summary>
      <form action={powiazKarta} className="kz-zmien-pola">
        <Ukryte orderId={orderId} lineId={lineId} />
        <p className="small kz-bez-marginesu">
          Oferta <span className="mono">{offerId}</span> zostanie na stałe powiązana z produktem: kolejne zamówienia z niej przyjdą już z produktem i rezerwacją. Kanał zostaje bez zmian.
        </p>
        <PoleTekstowe id={`pw-sku-${lineId}`} etykieta="SKU produktu z katalogu" name="sku" required maxLength={100} autoComplete="off" spellCheck={false} />
        <PoleLiczbowe id={`pw-szt-${lineId}`} etykieta="Ile sztuk produktu w jednej sztuce oferty" name="sztuk" inputMode="numeric" min={1} defaultValue={1} required />
        <div>
          <Przycisk type="submit" wariant="glowny">
            Powiąż
          </Przycisk>
        </div>
      </form>
    </details>
  )
}

export function Pozycje({ d, uprawnienia, edytuj = false }: { d: DaneKarty; uprawnienia: ReadonlySet<string>; edytuj?: boolean }) {
  const { o } = d
  const comp = o.products
  // `mozna` = osoba i konto mogą zmieniać pozycje; pola pojawiają się dopiero w trybie edycji sekcji
  const mozna = d.edycja.mozna
  const edycja = mozna && edytuj
  const podzial = d.praca && d.edycja.powodStatusu === null && !d.edycja.podzialPoEtykiecie && uprawnienia.has('zamowienia.podzial') && o.status === 'DO_REALIZACJI' && (o.paymentState === 'PAID' || o.paymentState === 'COD')
  const aktywne = o.lines.filter((l) => !l.removed)
  // konto poza trybem PRACA widzi „Dodaj pozycję” i „Podziel zamówienie” nieaktywne z jednym powodem (te same
  // warunki stanu i uprawnień co w pracy, bez trybu konta); akcje serwera odmawiają jak dotąd
  const podgladPoz = d.podglad && d.edycja.powodStatusu === null ? d.podglad.powody.pozycje : null
  const dodajPodglad = !!podgladPoz && uprawnienia.has('zamowienia.edycja_pozycji')
  const podzialPodglad =
    !!podgladPoz && uprawnienia.has('zamowienia.podzial') && o.status === 'DO_REALIZACJI' && (o.paymentState === 'PAID' || o.paymentState === 'COD') && aktywne.length > 0
  const now = new Date()
  const przelicza = (REMAP_STATUSES as readonly string[]).includes(o.status)
  const bezOpisu = o.channel !== 'RECZNE' && o.channel !== 'EASYTOOLS' && o.lines.some((l) => !l.removed && !l.externalLineId.includes('#karta-') && !l.channelName)
  // w kolumnie: pozycje do decyzji obsługi = otwarty brak albo zwrot do zrobienia; w podglądzie też brak ze stanowiska
  const doDecyzji = new Set(
    o.lines
      .filter((l) => !l.removed && (o.shortages.some((s) => s.orderLineId === l.id && (s.state === 'OPEN' || s.state === 'REFUND_PENDING')) || o.fixes.some((f) => f.orderLineId === l.id)))
      .map((l) => l.id),
  )
  const decyduje = uprawnienia.has('braki.decyzje') && doDecyzji.size > 0
  const podsumowanie = podsumowaniePozycji(
    o.lines
      .filter((l) => !l.removed)
      .map((l) => {
        const p = l.productId ? comp.get(l.productId) : undefined
        return { unitPriceGross: l.unitPriceGross, qty: l.qty, qtyRejected: l.qtyRejected, naOferte: d.naOferte.get(l.id) ?? 1, przesuniecie: d.przesuniecie.get(l.id) ?? 0, stawka: l.vatRate ?? p?.vatRate ?? null }
      }),
  )
  const tylkoDoslanie = o.mode === 'PRACA' && !PRZED_SPAKOWANIEM.includes(o.status)
  const akcja = edycja ? zapiszPozycjeKarta : decyduje ? zapiszDecyzjeKarta : null
  const decyzjeWFormularzu = decyduje && !!akcja
  const bezProduktu = o.lines.filter((l) => !l.productId && !l.removed)
  // brak „nie ma na półce” do cofnięcia przez biuro (konto w PRACY, paczka jeszcze nie spakowana)
  const jednakJest = o.mode === 'PRACA' && uprawnienia.has('braki.decyzje') && ['DO_REALIZACJI', 'ZBIERANIE', 'ZEBRANE'].includes(o.status) ? o.brakiNaPolce : []
  // spakowane z brakiem do zwrotu albo pomniejszonym pobraniem; magazyn mógł spakować komplet mimo ramki
  // „Brakuje, nie pakuj” (rdzeń sam sprawdza stan, fakturę i etykietę pobrania)
  const komplet =
    o.mode === 'PRACA' && uprawnienia.has('braki.decyzje') && o.status === 'SPAKOWANE'
      ? o.lines.flatMap((l) => {
          const ile = o.shortages.filter((s) => s.orderLineId === l.id && (s.state === 'REFUND_PENDING' || s.state === 'COD_REDUCED')).reduce((a, s) => a + s.qtyBase, 0)
          return !l.removed && l.productId && ile > 0 ? [{ orderLineId: l.id, productId: l.productId, qty: ile }] : []
        })
      : []

  // w trybie edycji pola ilości, ceny, VAT i decyzji nie mieszczą się na wąskim ekranie komputera: tabela
  // przewija się w swojej ramce zamiast rozpychać stronę (na telefonie wiersze są kartami, bez przewijania)
  const tabela = (
    <div className="kz-tabela-ramka">
      <table className="tbl cards kz-pozycje">
      <thead>
        <tr>
          <th className="kz-produkt">Produkt</th>
          <th className="right kz-waska">Ilość</th>
          <th className="right kz-waska">Cena brutto</th>
          <th className="right kz-waska">VAT</th>
          <th className="kz-waska kz-stan">Stan pozycji</th>
          {doDecyzji.size > 0 && <th>Decyzja o braku</th>}
        </tr>
      </thead>
      <tbody>
        {o.lines.map((l) => {
          const res = o.reservations.filter((r) => r.orderLineId === l.id)
          const sh = o.shortages.filter((s) => s.orderLineId === l.id && ['OPEN', 'SHIP_LATER', 'REFUND_PENDING'].includes(s.state))
          const product = l.productId ? comp.get(l.productId) : undefined
          // pozycja bez produktu pokazuje nazwę z kanału (zapisaną przy przyjęciu albo „Odśwież opis z kanału”)
          const title = product?.title ?? l.channelName ?? 'pozycja bez nazwy z kanału'
          const linkOferty = d.linkiOfert.get(l.id)
          const sku = product?.sku ?? l.channelSku
          const ean = product?.ean ?? l.channelEan
          const vat = l.vatRate ?? product?.vatRate ?? null
          const lokalna = l.externalLineId.includes('#karta-')
          const per = d.naOferte.get(l.id) ?? 1
          // pozycja z zamiany ma ilość i cenę pozycji, którą zastępuje — bez edycji, z podpowiedzią
          const zamianaPoz = czyZamiennik(l.externalLineId)
          const zmien = !l.removed && edycja && !!product && !zamianaPoz
          // cena i VAT w miejscu (osobne uprawnienie, przed dokumentem sprzedaży, bez części dosłanej albo zamienionej)
          const zmienCene = !l.removed && edycja && d.edycja.ceny && akcja === zapiszPozycjeKarta && l.qtyRejected === 0 && !zamianaPoz
          const zmienVat = zmienCene && product?.kind !== 'BUNDLE'
          // cena pozycji jest za sztukę oferty; produkt w gramach bez oferty ma cenę za 1 g
          const jednostka = product && product.kind !== 'BUNDLE' ? product.unit : 'SZT'
          const zaCo = per > 1 ? `za opakowanie ${qty(per, jednostka)}` : jednostka === 'KG' ? 'za 1 g' : 'za sztukę'
          // „23.00” z kanału pokazuje się jako 23% z listy i bez zmiany nie zapisuje się jako zmiana
          const vatPozycji = normalizujStawke(l.vatRate)
          const vatSpozaListy = vatPozycji !== null && !(VAT_STAWKI as readonly string[]).includes(vatPozycji)
          const stan = product && product.kind !== 'DIGITAL' ? d.stanyProduktow.get(product.id) : undefined
          const dec = o.decisions.find((x) => x.orderLineId === l.id)
          const zamiennik = dec?.replacementProductId ? comp.get(dec.replacementProductId) : undefined
          const ilosc = product ? (product.kind === 'BUNDLE' ? `${l.qty} × zestaw` : qty(l.qty, product.unit)) : String(l.qty)
          // odznaki pod nazwą tylko, gdy jest co powiedzieć (inaczej pusty wiersz podnosił pozycję)
          const znaczniki = (!product && !l.removed) || product?.kind === 'DIGITAL' || l.removed || lokalna
          return (
            <tr key={l.id} className={l.removed ? 'removed' : sh.length ? 'row-alert' : ''}>
              <td data-label="Produkt" className="with-img kz-produkt">
                <span className="pline kz-pline">
                  <Miniatura title={title} size={40} zdjecie={product ? d.zdjecia.get(product.id) : null} />
                  <span className="kz-poz-opis">
                    {product ? <Link href={`/produkty/${product.id}`}>{title}</Link> : <b>{title}</b>}
                    {/* jedna szara linia pod nazwą (SKU · EAN · półka · oferta), wiersz zawsze tej samej wysokości */}
                    <span className="kz-poz-meta">
                      <span className="mono">{sku ? `SKU ${sku}` : 'bez SKU'}</span>
                      {ean && <span className="mono">EAN {ean}</span>}
                      {product?.location && <span title="Miejsce na półce">półka {product.location}</span>}
                      {l.offerId && !l.offerId.startsWith('bl-pozycja:') && (
                        <span>
                          oferta{' '}
                          {linkOferty ? (
                            <a className="mono" href={linkOferty} target="_blank" rel="noopener noreferrer">
                              {l.offerId}
                            </a>
                          ) : (
                            <span className="mono">{l.offerId}</span>
                          )}
                        </span>
                      )}
                    </span>
                    {product && nazwaWKanaleInna(product.title, l.channelName) && <span className="sub">w kanale: {l.channelName}</span>}
                    {znaczniki && (
                    <span className="kz-poz-znaczniki">
                      {!product && !l.removed && (
                        <Odznaka ton="uwaga" rozmiar="sm">
                          bez powiązania z produktem
                        </Odznaka>
                      )}
                      {product?.kind === 'DIGITAL' && <Odznaka rozmiar="sm">bez stanu (e-book, usługa)</Odznaka>}
                      {l.removed && <Odznaka rozmiar="sm">{d.usunieteLokalnie.has(l.id) ? 'usunięta w Kompletorze' : 'usunięta w kanale'}</Odznaka>}
                      {!l.removed && lokalna && (
                        <Odznaka ton="info" rozmiar="sm">
                          dodana w Kompletorze {when(l.createdAt, now)}
                        </Odznaka>
                      )}
                    </span>
                    )}
                  </span>
                </span>
              </td>
              <td data-label="Ilość" className="right num kz-waska">
                {zmien && akcja === zapiszPozycjeKarta ? (
                  <span className="kz-ilosc">
                    <input
                      className="input"
                      name={`ilosc_${l.id}`}
                      type="number"
                      inputMode="numeric"
                      aria-label={`Ilość: ${title}${per > 1 ? ` (co ${per})` : ''}`}
                      min={per > 1 ? per : Math.max(1, l.qtyRejected + 1)}
                      step={per}
                      defaultValue={l.qty}
                      required
                    />
                    <input type="hidden" name={`ilosc_bylo_${l.id}`} value={l.qty} />
                    <label className="small kz-usun">
                      <input type="checkbox" name={`usun_${l.id}`} value="tak" data-nazwa={`${title}${sku ? ` (SKU ${sku})` : ''}`} /> usuń
                    </label>
                  </span>
                ) : (
                  ilosc
                )}
                {l.qtyRejected > 0 && <span className="sub">poza paczką: {l.qtyRejected}</span>}
                {zamianaPoz && !l.removed && edycja && akcja === zapiszPozycjeKarta && (
                  <span className="sub" title={KOMUNIKAT_POZYCJA_ZAMIANY}>
                    z zamiany: ilości, ceny i usunięcia nie zmienisz
                  </span>
                )}
                {stan && (
                  <span className="sub" title={`Stan produktu we wszystkich magazynach: na półce ${stan.fizycznie}, dostępne ${stan.dostepne}`}>
                    półka {stan.fizycznie} / dost. {stan.dostepne}
                  </span>
                )}
              </td>
              <td data-label="Cena brutto" className="right num kz-waska">
                {zmienCene ? (
                  <>
                    <input
                      className="input kz-cena"
                      name={`cena_${l.id}`}
                      inputMode="decimal"
                      autoComplete="off"
                      pattern="[0-9]+([,.][0-9]{1,2})?"
                      aria-label={`Cena brutto ${zaCo}: ${title}`}
                      title={`Cena brutto ${zaCo}, np. 24,90`}
                      defaultValue={Number(l.unitPriceGross).toFixed(2).replace('.', ',')}
                    />
                    <input type="hidden" name={`cena_bylo_${l.id}`} value={Number(l.unitPriceGross).toFixed(2).replace('.', ',')} />
                  </>
                ) : (
                  money(l.unitPriceGross, d.waluta)
                )}
                {(per > 1 || jednostka === 'KG') && <span className="sub">{zaCo}</span>}
                {zmienCene && per === 1 && jednostka === 'KG' && <span className="sub">cena za gram, nie za opakowanie</span>}
              </td>
              <td data-label="VAT" className="right num kz-waska">
                {zmienVat ? (
                  <>
                    <select className="input kz-vat" name={`vat_${l.id}`} defaultValue={vatPozycji ?? ''} aria-label={`Stawka VAT: ${title}`}>
                      {!vatPozycji && <option value="">{vat ? `z katalogu (${VAT_LABEL[normalizujStawke(vat) ?? ''] ?? vat})` : 'z katalogu'}</option>}
                      {vatSpozaListy && <option value={vatPozycji}>{`${vatPozycji} (z kanału)`}</option>}
                      {VAT_STAWKI.map((x) => (
                        <option key={x} value={x}>
                          {VAT_LABEL[x]}
                        </option>
                      ))}
                    </select>
                    <input type="hidden" name={`vat_bylo_${l.id}`} value={vatPozycji ?? ''} />
                  </>
                ) : (
                  <>
                    {vat ? (VAT_LABEL[normalizujStawke(vat) ?? ''] ?? `${vat.replace(/\.0+$/, '')}%`) : <span className="muted">—</span>}
                    {!l.vatRate && vat && <span className="sub">z katalogu</span>}
                    {zmienCene && product?.kind === 'BUNDLE' && <span className="sub">ze składników zestawu</span>}
                  </>
                )}
              </td>
              <td data-label="Stan pozycji" className="kz-waska kz-stan">
                <span className="kz-poz-znaczniki">
                  {res.map((r) => {
                    const p = comp.get(r.productId)
                    return (
                      <Odznaka key={r.id} ton={r.state === 'ACTIVE' ? 'sukces' : 'neutralny'} rozmiar="sm">
                        {RES_LABEL[r.state]}: {p ? qty(r.qtyBase, p.unit) : r.qtyBase}
                        {product?.kind === 'BUNDLE' && p ? ` · ${p.title}` : ''}
                      </Odznaka>
                    )
                  })}
                  {sh.map((s) => {
                    const p = comp.get(s.productId)
                    return (
                      <Odznaka key={s.id} ton="blad" rozmiar="sm">
                        {SHORTAGE_LABEL[s.state]}: {p ? qty(s.qtyBase, p.unit) : s.qtyBase}
                        {product?.kind === 'BUNDLE' && p ? ` · ${p.title}` : ''}
                      </Odznaka>
                    )
                  })}
                  {o.fixes
                    .filter((f) => f.orderLineId === l.id)
                    .map((f) => {
                      const p = comp.get(f.productId)
                      return (
                        <Odznaka key={f.id} ton="blad" rozmiar="sm">
                          zgłoszone na stanowisku: {p ? qty(f.qtyBase, p.unit) : f.qtyBase}
                          {product?.kind === 'BUNDLE' && p ? ` · ${p.title}` : ''}
                        </Odznaka>
                      )
                    })}
                  {!res.length && !sh.length && (product?.kind === 'DIGITAL' ? <span className="muted small">bez rezerwacji — na fakturze jako usługa</span> : <span className="muted">—</span>)}
                </span>
              </td>
              {doDecyzji.size > 0 && (
                <td data-label="Decyzja o braku" className={doDecyzji.has(l.id) ? undefined : 'kz-bez-decyzji'}>
                  {!doDecyzji.has(l.id) ? (
                    <span className="muted">—</span>
                  ) : decyzjeWFormularzu ? (
                    <DecyzjaBraku
                      key={`${dec?.action ?? ''}|${zamiennik?.sku ?? ''}`}
                      lineId={l.id}
                      tytul={title}
                      opcje={DECYZJE.filter((x) => !tylkoDoslanie || x.akcja === 'DOSLIJ' || x.akcja === dec?.action)}
                      zapisana={dec?.action ?? null}
                      zamiennik={zamiennik ? { sku: zamiennik.sku, nazwa: zamiennik.title } : null}
                      pokazZamiane={!tylkoDoslanie}
                      naSucho={!!dec?.dryRun}
                    />
                  ) : dec ? (
                    <Odznaka ton="ostrzezenie" rozmiar="sm">
                      {ETYKIETA_DECYZJI[dec.action]}
                      {zamiennik ? `: ${zamiennik.title}` : ''}
                      {dec.dryRun ? ' (próbnie)' : ''}
                    </Odznaka>
                  ) : (
                    <span className="muted small">domyślnie: wyślij resztę</span>
                  )}
                </td>
              )}
            </tr>
          )
        })}
        </tbody>
      </table>
    </div>
  )

  // podsumowanie netto / VAT / brutto (brutto = suma pozycji karty); bez znanej stawki choć jednej pozycji
  // sama kwota brutto z wyjaśnieniem, nie zgadujemy netto
  const suma = (
    <div className="kz-suma">
      <dl className="kz-suma-kwoty">
        {podsumowanie.nettoGr !== null && (
          <>
            <div>
              <dt>Razem netto</dt>
              <dd className="num">{money(podsumowanie.nettoGr / 100, d.waluta)}</dd>
            </div>
            <div>
              <dt>VAT</dt>
              <dd className="num">{money((podsumowanie.vatGr ?? 0) / 100, d.waluta)}</dd>
            </div>
          </>
        )}
        <div className="kz-suma-brutto">
          <dt>Razem brutto</dt>
          <dd className="num">{money(d.sumaPozycjiGr / 100, d.waluta)}</dd>
        </div>
      </dl>
      <p className="muted small kz-bez-marginesu">
        Suma pozycji bez wysyłki i opłat z kanału.
        {podsumowanie.nettoGr === null ? ' Netto i VAT policzy dokument sprzedaży: nie każda pozycja ma jedną stawkę VAT (np. zestaw).' : ''}
      </p>
    </div>
  )

  const opisDecyzji = (doDecyzji.size > 0 || d.edytowaneLokalnie || edycja) && (
    <p className="muted small kz-opis">
      {d.edytowaneLokalnie || edycja ? `${KOMUNIKAT_KANAL} ` : ''}
      {o.mode === 'CIEN' ? 'Konto w trybie „Tylko podgląd”: zapisujemy samą decyzję, zamówienie, rezerwacje i stan zostają bez zmian. ' : ''}
      {doDecyzji.size > 0 && (
        <>
          {tylkoDoslanie ? 'Paczka już wyszła: zostaje tylko „Dośle później”. ' : '„Zamień produkt” otwiera wyszukiwarkę zamiennika (SKU, nazwa albo EAN, ze stanem dostępnym). '}
          Zwrot pieniędzy i korekta faktury za brak to zadania obsługi: lista Braki towaru → „Do zwrotu”.
        </>
      )}
    </p>
  )

  // „Edytuj” w pasku nagłówka; w podglądzie albo przy blokadzie edycji (w PRACA i w podglądzie)
  // nieaktywne z powodem. Powód widocznym tekstem raz: pod przyciskami podglądu
  // (`poz-podglad`) albo akapitem blokady (`poz-powod`); „Edytuj” odsyła do niego przez opis.
  const maUprawnienie = uprawnienia.has('zamowienia.edycja_pozycji')
  // w podglądzie pierwszeństwo ma powód trybu (`podgladPoz`), akapit blokady wtedy się nie powtarza
  const powodBlokady = maUprawnienie && !mozna && !podgladPoz && d.edycja.powod ? d.edycja.powod : null
  const linkEdycji: EdycjaSekcji | null = mozna
    ? edycja
      ? { tryb: 'edycja', href: adresOdczytu(o.id, 'pozycje') }
      : { tryb: 'odczyt', href: adresEdycji(o.id, 'pozycje') }
    : maUprawnienie && podgladPoz
      ? { tryb: 'niedostepna', powod: podgladPoz, opisId: dodajPodglad || podzialPodglad ? 'poz-podglad' : undefined }
      : powodBlokady
        ? { tryb: 'niedostepna', powod: powodBlokady, opisId: 'poz-powod' }
        : null
  return (
    <Sekcja
      id="pozycje"
      tytul="Pozycje"
      edycja={linkEdycji}
      akcje={
        <>
          <span className="muted small">{aktywne.length} poz.</span>
          {bezOpisu && maUprawnienie && (
            <form action={odswiezOpisKarta} title="Część pozycji nie ma nazwy z kanału: pobierz nazwę, SKU i EAN z zamówienia w kanale">
              <input type="hidden" name="zamowienie" value={o.id} />
              <Przycisk type="submit" rozmiar="sm">
                Pobierz nazwy z kanału
              </Przycisk>
            </form>
          )}
        </>
      }
    >
      {akcja ? (
        <form action={akcja} aria-label="Zmiany pozycji">
          <input type="hidden" name="zamowienie" value={o.id} />
          {tabela}
          {suma}
          {opisDecyzji}
          <p className="muted small kz-opis">
            {edycja
              ? `${d.edycja.ceny ? 'Zmień ilość, cenę albo VAT albo zaznacz „usuń”' : 'Zmień ilość albo zaznacz „usuń”'}: pojawi się przycisk „Zapisz pozycje”.`
              : 'Wybierz decyzję: pojawi się przycisk „Zapisz decyzje”.'}
          </p>
          {edycja && <PotwierdzUsuniecie />}
          {/* pasek dopiero po zmianie (na telefonie stały pasek pod tabelą zasłaniał pozycje); podpowiedź wyżej */}
          <PasekZapisu zapisz={edycja ? 'Zapisz pozycje' : 'Zapisz decyzje'} ukryjBezZmian anulujHref={edycja ? adresOdczytu(o.id, 'pozycje') : undefined} fokusPoAnuluj="h-pozycje" />
        </form>
      ) : (
        <>
          {tabela}
          {suma}
          {opisDecyzji}
        </>
      )}
      {powodBlokady && (
        <p id="poz-powod" className="muted small">
          {powodBlokady}.
        </p>
      )}
      {d.edycja.ostrzezenie && maUprawnienie && (
        <p id="poz-ostrzezenie" className="small kz-ostrzezenie" role="note">
          {d.edycja.ostrzezenie}.
        </p>
      )}
      {jednakJest.length > 0 && (
        <div className="kz-bez-produktu" aria-labelledby="h-jednak-jest">
          <h3 id="h-jednak-jest">Zgłoszone „nie ma na półce”</h3>
          <p className="muted small kz-bez-marginesu">Towar się znalazł? „Jednak jest na półce” cofa brak: stan wraca, a towar wraca do tej paczki. Działa, dopóki paczka nie jest spakowana i dopóki brak nie jest poprawiony w programie magazynowym.</p>
          {jednakJest.map((b) => {
            const p = comp.get(b.productId)
            return (
              <form key={`${b.orderLineId}:${b.productId}`} action={jednakJestKarta} className="kz-bez-produktu-poz">
                <input type="hidden" name="zamowienie" value={o.id} />
                <input type="hidden" name="pozycja" value={b.orderLineId} />
                <input type="hidden" name="produkt" value={b.productId} />
                <span className="small">
                  <b>{p?.title ?? 'produkt'}</b>: brak {p ? qty(b.qty, p.unit) : b.qty}
                </span>
                <PrzyciskPotwierdz rozmiar="sm" tytul="Cofnąć brak?" pytanie={`${p?.title ?? 'Produkt'}: brak ${p ? qty(b.qty, p.unit) : b.qty} zostanie cofnięty, stan wróci, a towar wróci do tej paczki.`} tak="Tak, jednak jest">
                  Jednak jest na półce
                </PrzyciskPotwierdz>
              </form>
            )
          })}
        </div>
      )}
      {komplet.length > 0 && (
        <div className="kz-bez-produktu" aria-labelledby="h-komplet">
          <h3 id="h-komplet">Spakowane z brakiem</h3>
          <p className="muted small kz-bez-marginesu">
            Magazyn jednak spakował całość, bo towar leżał na półce? „Wyszedł komplet” zamyka brak bez zwrotu pieniędzy, a paczka i faktura obejmą pełną ilość. Działa, gdy towar jest już przyjęty na stan (inaczej najpierw przyjmij go w programie magazynowym i kliknij „Synchronizuj stany” w Produktach) i dopóki faktura tej paczki nie jest wystawiona. Potem kliknij „Ponów fakturę”, jeśli faktura stoi z błędem.
          </p>
          {komplet.map((b) => {
            const p = comp.get(b.productId)
            const ile = p && p.kind !== 'BUNDLE' ? qty(b.qty, p.unit) : 'część zestawu'
            return (
              <form key={b.orderLineId} action={wyszedlKompletKarta} className="kz-bez-produktu-poz">
                <input type="hidden" name="zamowienie" value={o.id} />
                <input type="hidden" name="pozycja" value={b.orderLineId} />
                <span className="small">
                  <b>{p?.title ?? 'produkt'}</b>: w systemie brak {ile}
                </span>
                <PrzyciskPotwierdz rozmiar="sm" tytul="Paczka wyszła w komplecie?" pytanie={`${p?.title ?? 'Produkt'}: potwierdzasz, że brakujące ${ile} było w paczce. Zwrotu pieniędzy nie będzie, a faktura obejmie pełną ilość.`} tak="Tak, wyszedł komplet">
                  Wyszedł komplet
                </PrzyciskPotwierdz>
              </form>
            )
          })}
        </div>
      )}
      {(dodajPodglad || podzialPodglad) && podgladPoz && (
        <div className="ui-akcja">
          <div className="kz-poz-akcje">
            {dodajPodglad && (
              <Przycisk powodWylaczenia={podgladPoz} aria-describedby="poz-podglad">
                Dodaj pozycję
              </Przycisk>
            )}
            {podzialPodglad && (
              <Przycisk powodWylaczenia={podgladPoz} aria-describedby="poz-podglad">
                Podziel zamówienie
              </Przycisk>
            )}
          </div>
          <p id="poz-podglad" className="ui-akcja-powod">
            {podgladPoz}
          </p>
        </div>
      )}
      {bezProduktu.length > 0 && (
        <div className="kz-bez-produktu">
          <h3>Pozycje bez produktu</h3>
          {bezProduktu.map((l) => (
            <div key={l.id} className="kz-bez-produktu-poz">
              <p className="small kz-bez-marginesu">
                <b>{l.channelName ?? 'pozycja bez nazwy z kanału'}</b>
              </p>
              <Powiaz orderId={o.id} lineId={l.id} offerId={l.offerId} mozna={uprawnienia.has('ustawienia')} jest={d.powiazaniaPozycji.get(l.id)} przelicza={przelicza} />
            </div>
          ))}
        </div>
      )}
      {(mozna || (podzial && aktywne.length > 0)) && (
        <div className="kz-poz-akcje">
          {mozna && (
            <DodajPozycje orderId={o.id} />
          )}
          {podzial && aktywne.length > 0 && (
            <details className="kz-dodaj" id="podzial">
              <summary className="btn">Podziel zamówienie</summary>
              <form action={podzielKarta} className="kz-zmien-pola">
                <Ukryte orderId={o.id} />
                <p className="small kz-bez-marginesu">Wpisz, ile sztuk przenieść do nowej paczki. W pierwszej paczce musi zostać co najmniej jedna pozycja; pieniądze zostają na pierwszej paczce.</p>
                {aktywne
                  .filter((l) => l.productId && comp.get(l.productId)?.kind !== 'DIGITAL' && l.qty - l.qtyRejected > 0 && !czyZamiennik(l.externalLineId))
                  .map((l) => {
                    const p = comp.get(l.productId!)!
                    return <PoleLiczbowe key={l.id} id={`pd-${l.id}`} etykieta={`${p.title} (w paczce ${l.qty - l.qtyRejected})`} name={`ile_${l.id}`} inputMode="numeric" min={0} max={l.qty - l.qtyRejected} defaultValue={0} />
                  })}
                <div>
                  <PrzyciskPotwierdz wariant="glowny" tytul="Podzielić zamówienie?" pytanie="Utworzyć nową paczkę z wpisanych sztuk? Rezerwacje przejdą razem z nimi." tak="Tak, podziel">
                    Podziel
                  </PrzyciskPotwierdz>
                </div>
              </form>
            </details>
          )}
        </div>
      )}
    </Sekcja>
  )
}
