// Ustawienia → Kanały sprzedaży → konto → „Łączenie ofert z produktami”: masowe łączenie ofert bez produktu
// po SKU albo EAN z podglądem (ile połączy, które kolidują, które wymagają decyzji) i zbiorcze zatwierdzanie propozycji
// powiązań. Podgląd przez adres (?laczenie=SKU|EAN), zatwierdzenie tylko zaznaczonych; nic nie idzie do kanału.
// lista „Bez pasującego produktu” z powodem przy każdej ofercie, oferty czekające już w propozycjach nie
// powtarzają się w „Połączy”, SKU różniące się tylko zerami na początku idą do decyzji z proponowanym produktem.
// „Do decyzji” pokazuje pasujące produkty z „Powiąż” przy każdym (ta sama akcja i uprawnienie
// `produkty.dodawanie` co na karcie produktu; bez uprawnienia lista bez przycisków). Automat dalej tych ofert nie łączy.
import Link from 'next/link'
import type { PrismaClient } from '@prisma/client'
import { Karta, Odznaka, PrzyciskLink, PustyStan, Tabela } from '@/app/ui'
import type { KontoRef } from '@/lib/kanaly/konta'
import { int } from '@/lib/panel/format'
import { planLaczenia, propozycjeKonta, type LaczPo, type PozycjaPlanu } from '@/lib/produkty/powiazania'
import { PowiazZOferta } from '@/app/(panel)/produkty/[id]/powiazania'
import { PolaczZaznaczone, ZatwierdzZaznaczone } from './laczenie-formularz'

const POKAZ = 300

function oferta(x: { externalId: string; nazwa: string | null; sku?: string | null; ean?: string | null }) {
  return (
    <>
      <span className="mono">{x.externalId}</span>
      {x.nazwa && <span className="pw-sub">{x.nazwa}</span>}
      {(x.sku || x.ean) && <span className="pw-sub mono">{[x.sku && `SKU ${x.sku}`, x.ean && `EAN ${x.ean}`].filter(Boolean).join(' · ')}</span>}
    </>
  )
}

const produkt = (p: PozycjaPlanu['produkt']) =>
  p ? (
    <>
      <Link href={`/produkty/${p.id}#powiazania`}>{p.title}</Link>
      <span className="pw-sub mono">SKU {p.sku}</span>
    </>
  ) : (
    '—'
  )

/** pasujące produkty oferty „Do decyzji”, każdy z „Powiąż” (gdy osoba ma `produkty.dodawanie`). */
function kandydaci(x: PozycjaPlanu, kod: string, mozePowiazac: boolean) {
  const lista = x.kandydaci ?? []
  if (!lista.length) return '—'
  return (
    <ul className="pw-kandydaci" aria-label={`Pasujące produkty dla oferty ${x.externalId}`}>
      {lista.map((p) => (
        <li key={p.id} className="pw-kandydat">
          <div className="pw-kandydat-opis">
            <Link href={`/produkty/${p.id}#powiazania`}>{p.title}</Link>
            <span className="pw-sub mono">
              SKU {p.sku}
              {p.unit === 'KG' ? ' · na wagę (przelicznik w gramach)' : ''}
            </span>
          </div>
          {mozePowiazac && <PowiazZOferta produkt={p.id} konto={kod} oferta={x.externalId} przelicznik={p.unit === 'KG' ? 1000 : 1} etykieta={`${x.externalId} z produktem SKU ${p.sku}`} />}
        </li>
      ))}
      {!!x.kandydatowWiecej && (
        <li className="pw-sub">Pasuje jeszcze {int(x.kandydatowWiecej)}: znajdziesz je w wyszukiwarce produktów po SKU albo EAN.</li>
      )}
    </ul>
  )
}

export async function LaczenieOfert({ db, refKonta, kod, po, maListe, mozePowiazac }: { db: PrismaClient; refKonta: KontoRef; kod: string; po: LaczPo | null; maListe: boolean; mozePowiazac: boolean }) {
  const [plan, propozycje] = await Promise.all([po && maListe ? planLaczenia(db, refKonta, po) : Promise.resolve(null), propozycjeKonta(db, refKonta)])
  const adres = `/ustawienia/kanaly/${encodeURIComponent(kod)}`
  const ucinane = (n: number) => (n > POKAZ ? <p className="pw-sub">Pokazane pierwsze {POKAZ} z {int(n)}: po połączeniu kliknij podgląd jeszcze raz.</p> : null)
  return (
    <Karta
      id="laczenie"
      tytul="Łączenie ofert z produktami"
      opis="Połącz naraz oferty bez produktu po SKU albo EAN. Najpierw podgląd, potem łączysz zaznaczone. Propozycje (niżej) to powiązania już znalezione przy pobieraniu ofert albo imporcie, które czekają tylko na Twoje zatwierdzenie. Pojedynczą ofertę powiążesz też z karty produktu (Powiązania)."
    >
      {!maListe ? (
        <p className="small">Najpierw „Pobierz oferty” (wyżej): łączenie działa na zapisanej liście ofert konta.</p>
      ) : (
        <div className="pw-plan">
          <PrzyciskLink href={`${adres}?laczenie=SKU#laczenie`} rozmiar="sm" wariant={po === 'SKU' ? 'glowny' : 'drugorzedny'}>
            Podgląd: po SKU
          </PrzyciskLink>
          <PrzyciskLink href={`${adres}?laczenie=EAN#laczenie`} rozmiar="sm" wariant={po === 'EAN' ? 'glowny' : 'drugorzedny'}>
            Podgląd: po EAN
          </PrzyciskLink>
        </div>
      )}

      {plan && (
        <>
          <div className="pw-plan" role="status">
            <Odznaka ton="neutralny">oferty bez powiązania: {int(plan.sprawdzone)}</Odznaka>
            <Odznaka ton="sukces">połączy: {int(plan.polaczy.length)}</Odznaka>
            {plan.wPropozycjach > 0 && <Odznaka ton="uwaga">czeka w propozycjach: {int(plan.wPropozycjach)}</Odznaka>}
            <Odznaka ton="ostrzezenie">kolidują: {int(plan.koliduje.length)}</Odznaka>
            <Odznaka ton="uwaga">do decyzji: {int(plan.decyzja.length)}</Odznaka>
            <Odznaka ton="neutralny">bez pasującego produktu: {int(plan.bezTrafienia)}</Odznaka>
          </div>
          <section className="pw-sekcja" aria-labelledby="h-l-polaczy">
            <h3 id="h-l-polaczy">Połączy ({po === 'EAN' ? 'ten sam EAN' : 'to samo SKU'})</h3>
            {plan.wPropozycjach > 0 && (
              <p className="pw-sub">
                {int(plan.wPropozycjach)} ofert pasuje do produktu, który już na nie czeka w „Propozycjach do zatwierdzenia” (niżej): tam je zatwierdzisz, tu się nie powtarzają.
              </p>
            )}
            <Tabela
              id="laczenie-polaczy"
              etykieta="Oferty do połączenia"
              zaznaczanie
              akcjeMasowe={<PolaczZaznaczone konto={kod} po={plan.po} />}
              kolumny={[
                { klucz: 'oferta', etykieta: 'Oferta' },
                { klucz: 'produkt', etykieta: 'Produkt' },
              ]}
              wiersze={plan.polaczy.slice(0, POKAZ).map((x) => ({ id: x.externalId, etykieta: x.externalId, komorki: { oferta: oferta(x), produkt: produkt(x.produkt) } }))}
              pustyStan={<PustyStan tytul="Nic do połączenia">Oferty bez powiązania nie mają produktu o {po === 'EAN' ? 'tym EAN' : 'tym SKU'}, czekają w propozycjach albo wymagają decyzji (niżej).</PustyStan>}
            />
            {ucinane(plan.polaczy.length)}
          </section>
          {plan.koliduje.length > 0 && (
            <section className="pw-sekcja" aria-labelledby="h-l-koliduje">
              <h3 id="h-l-koliduje">Kolidują</h3>
              <p className="pw-sub">Oferta ma zapisany inny produkt (odłączona, wyłączona albo propozycja). Rozstrzygasz na karcie produktu: Powiązania → „Powiąż ponownie” albo „Powiąż z ofertą” na karcie właściwego.</p>
              <Tabela
                id="laczenie-koliduje"
                etykieta="Oferty z innym zapisanym produktem"
                kolumny={[
                  { klucz: 'oferta', etykieta: 'Oferta' },
                  { klucz: 'produkt', etykieta: 'Zapisany produkt' },
                  { klucz: 'powod', etykieta: 'Dlaczego' },
                ]}
                wiersze={plan.koliduje.slice(0, POKAZ).map((x) => ({ id: x.externalId, ton: 'ostrzezenie' as const, komorki: { oferta: oferta(x), produkt: produkt(x.produkt), powod: x.powod } }))}
              />
              {ucinane(plan.koliduje.length)}
            </section>
          )}
          {plan.decyzja.length > 0 && (
            <section className="pw-sekcja" aria-labelledby="h-l-decyzja">
              <h3 id="h-l-decyzja">Do decyzji</h3>
              <p className="pw-sub">Automat ich nie łączy: przy każdej ofercie są produkty, które do niej pasują, a Ty klikasz „Powiąż” przy właściwym. Po powiązaniu oferta znika z tej listy.</p>
              <ul className="pw-sub pw-powody">
                <li>Kilka ofert tego konta ma ten sam EAN albo SKU: zwykle to kilka aukcji tego samego towaru, więc powiąż każdą z tym samym produktem.</li>
                <li>Kilka produktów ma ten sam EAN albo SKU: wybierz właściwy, a na pozostałych popraw EAN albo SKU na karcie produktu.</li>
                <li>SKU różni się od produktu tylko wielkością liter albo zerami na początku: powiąż, jeśli to ten sam towar.</li>
              </ul>
              {!mozePowiazac && <p className="pw-sub">Powiązać ofertę może osoba z uprawnieniem do dodawania i edycji produktów; Ty widzisz tylko pasujące produkty.</p>}
              <Tabela
                id="laczenie-decyzja"
                etykieta="Oferty wymagające decyzji"
                kolumny={[
                  { klucz: 'oferta', etykieta: 'Oferta' },
                  { klucz: 'produkt', etykieta: 'Pasujące produkty' },
                  { klucz: 'powod', etykieta: 'Dlaczego' },
                ]}
                wiersze={plan.decyzja.slice(0, POKAZ).map((x) => ({ id: x.externalId, ton: 'uwaga' as const, komorki: { oferta: oferta(x), produkt: kandydaci(x, kod, mozePowiazac), powod: x.powod } }))}
              />
              {ucinane(plan.decyzja.length)}
            </section>
          )}
          {plan.bezPary.length > 0 && (
            <section className="pw-sekcja" aria-labelledby="h-l-bez-pary">
              <h3 id="h-l-bez-pary">Bez pasującego produktu</h3>
              <p className="pw-sub">
                Tych ofert ten podgląd nie połączy. Przypiszesz je ręcznie na liście <Link href={`${adres}#przypisz`}>„Do przypisania”</Link> (wyżej) albo z karty produktu (Powiązania → „Powiąż z ofertą”).
              </p>
              <Tabela
                id="laczenie-bez-pary"
                etykieta="Oferty bez pasującego produktu"
                kolumny={[
                  { klucz: 'oferta', etykieta: 'Oferta' },
                  { klucz: 'powod', etykieta: 'Dlaczego' },
                ]}
                wiersze={plan.bezPary.slice(0, POKAZ).map((x) => ({ id: x.externalId, komorki: { oferta: oferta(x), powod: x.powod } }))}
              />
              {ucinane(plan.bezTrafienia)}
            </section>
          )}
        </>
      )}

      <section className="pw-sekcja" aria-labelledby="h-l-propozycje">
        <h3 id="h-l-propozycje">Propozycje do zatwierdzenia ({int(propozycje.length)})</h3>
        <p className="pw-sub">Powiązanie jest już zapisane, ale wyłączone do czasu zatwierdzenia: stan na te oferty nie wychodzi, dopóki ich nie zatwierdzisz. Zaznacz i zatwierdź te, które się zgadzają.</p>
        <Tabela
          id="laczenie-propozycje"
          etykieta="Propozycje powiązań"
          zaznaczanie
          akcjeMasowe={<ZatwierdzZaznaczone konto={kod} />}
          kolumny={[
            { klucz: 'oferta', etykieta: 'Oferta' },
            { klucz: 'produkt', etykieta: 'Proponowany produkt' },
            { klucz: 'zrodlo', etykieta: 'Skąd' },
          ]}
          wiersze={propozycje.map((x) => ({ id: x.offerId, etykieta: x.externalId, komorki: { oferta: oferta(x), produkt: produkt(x.produkt), zrodlo: x.zrodlo } }))}
          pustyStan={<PustyStan tytul="Brak propozycji">Propozycje powstają, gdy pobranie ofert albo import z BaseLinkera znajdzie produkt po SKU, ale powiązanie wymaga potwierdzenia.</PustyStan>}
        />
      </section>
    </Karta>
  )
}
