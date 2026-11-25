// raport sprzedaży wg okresu, konta kanału i produktu, z marżą z ceny zakupu produktu. Jedno źródło dla
// ekranu „Raporty” w panelu, eksportu XLSX, GET /api/v1/raporty/sprzedaz i narzędzia MCP `raport_sprzedazy`.
//
// Liczy baza (GROUPING SETS), nie pamięć: dwa zapytania na okres (pozycje i zamówienia) plus jedno o kopie kanału spoza
// Kompletora. Same agregaty: SKU, nazwy produktów, nazwy kont, liczby i kwoty, bez danych klientów. Klient firmy z sesji
// albo klucza API (RLS), zapytania bez składania fragmentów SQL (strażnik sesji w testach izolacji).
//
// Reguły (opisane w docs/raporty.md i Pomocy):
//  - okres = data złożenia zamówienia w kanale, czas polski (Europe/Warsaw), granice dni włącznie;
//  - anulowane (status ANULOWANE) są poza sprzedażą i liczą się osobno (liczba i kwota);
//  - zamówienie liczy się raz (podzamówienie „dośle później” nie jest osobnym zamówieniem), pozycje liczą się z
//    zamówienia i podzamówień; ilość pozycji = ilość − odrzucone (dosłane, zamienione, odrzucone liczą się tam, gdzie są);
//  - zwroty (zwrot albo korekta, poza odrzuconymi) odejmują się od sprzedaży okresu, w którym złożono zamówienie;
//  - netto pozycji = brutto / (1 + stawka VAT pozycji albo produktu; „zw”, „np”, „0” = bez VAT; brak stawki = 23%);
//  - koszt = ilość × cena zakupu netto produktu (wFirma albo karta produktu; produkt na wagę: cena za kg), zestaw bez
//    własnej ceny = suma cen składników; pozycja bez ceny zakupu nie ma marży („brak ceny zakupu”), nigdy marża 100%;
//  - kwoty (wartość, netto, zwroty, marża, anulowane, poza Kompletorem) to zamówienia w PLN plus zamówienia
//    w innych walutach przeliczone po ostatnim kursie średnim NBP zapisanym przez worker (lib/kursy/nbp.ts; jeden kurs
//    na walutę dla całego zakresu, informacyjnie). Waluta z kopii kanału, bez kopii = PLN; paczka dodatkowa po numerze
//    zamówienia głównego. Koszt zakupu jest w złotych (bez przeliczenia). Waluta bez kursu: liczba zamówień i sztuki tak,
//    kwoty nie (osobno w `inneWaluty` z `bruttoPln: null`), nigdy 1:1. `inneWaluty` = rozbicie z kursem i jego datą;
//  - archiwum zamówień sprzed odczytu kanału (`ArchivedOrder`, lib/archiwum/) liczy się tak samo, w tych
//    samych zapytaniach (UNION ALL), bez zamówień, które mają już wiersz `Order` (żadne zamówienie dwa razy); status
//    archiwum ANULOWANE = poza sprzedażą, null = sprzedaż; zwroty archiwum = zwrócone jednostki pozycji (`refundQty`),
//    koszt z dzisiejszej ceny zakupu produktu (marża okresu z archiwum to szacunek). Waluta wiersza archiwum
//    (`ArchivedOrder.currency`) idzie tą samą regułą (kurs NBP, bez kursu poza kwotami). To jedyne miejsce
//    poza lib/archiwum/, które czyta archiwum (strażnik tests/archiwum-straznik.test.ts).
//  - okres porównania do wyboru (lib/api/raporty-porownanie.ts: poprzedni okres, rok wcześniej, miesiąc albo
//    tydzień wcześniej, własny zakres, bez porównania), liczony tymi samymi zapytaniami co zakres. Porównanie sprzed
//    początku danych konta (`poczatkiDanych`: odczyt konta albo zakres importu archiwum, pierwsze zamówienie tylko bez
//    tych granic) jest oznaczone jako
//    niepełne (`poprzedni.kontaBezDanych`, `bezDanych`), żeby ekran nie pokazywał fałszywego wzrostu.
import type { Channel, PrismaClient, Unit } from '@prisma/client'
import { accountKey, accounts } from '@/lib/panel/dane'
import { organizationIdOf } from '@/lib/db'
import { accountDisplayName } from '@/lib/panel/format'
import { czytajKursy } from '@/lib/kursy/nbp'
import { naGrosze, obceDoApi, sumaWalut, type KursyWalut, type WalutaApi } from '@/lib/panel/sumy-walut'
import { addDays, fromWarsaw, toWarsaw, type IsoDay } from '@/lib/rdzen/kalendarz'
import { ApiInputError } from './odpowiedzi'
import { sqlBrakWKompletorze } from '@/lib/archiwum/rozlacznosc'
import { kluczePorownania, poprawnyDzien, type TrybPorownania, zakresPorownania, zapytaniePorownania } from './raporty-porownanie'

export type Grupowanie = 'dzien' | 'tydzien' | 'miesiac'
export const GRUPOWANIA: readonly Grupowanie[] = ['dzien', 'tydzien', 'miesiac']
const TRUNC: Record<Grupowanie, 'day' | 'week' | 'month'> = { dzien: 'day', tydzien: 'week', miesiac: 'month' }

/** Najdłuższy zakres raportu (dni) i najwięcej słupków okresu: duża firma: grudzień ok. 5–10 tys. zamówień. */
export const SPRZEDAZ_MAKS_DNI = 366
export const SPRZEDAZ_MAKS_OKRESOW = 120
export const SPRZEDAZ_DOMYSLNIE_PRODUKTOW = 50
export const SPRZEDAZ_MAKS_PRODUKTOW = 1000

export interface ZapytanieSprzedazy {
  od: IsoDay
  do: IsoDay
  grupuj: Grupowanie
  /** klucz konta kanału („WOO:sd”) albo null = wszystkie */
  konto: string | null
  produktow: number
  /** z czym porównać (domyślnie `poprzedni`); daty tylko dla `wlasny` */
  porownaj: TrybPorownania
  porownajOd: IsoDay | null
  porownajDo: IsoDay | null
}

const KONTO_RE = /^[A-Z_]{2,20}:[^\s]{1,100}$/

export function dniMiedzy(od: IsoDay, doDnia: IsoDay): number {
  return Math.round((Date.parse(`${doDnia}T00:00:00Z`) - Date.parse(`${od}T00:00:00Z`)) / 86_400_000) + 1
}

/** Domyślne grupowanie dla długości zakresu: do 62 dni dzień po dniu, do 190 tygodnie, dalej miesiące. */
export function domyslneGrupowanie(dni: number): Grupowanie {
  return dni <= 62 ? 'dzien' : dni <= 190 ? 'tydzien' : 'miesiac'
}

/** Walidacja zapytania (ekran, eksport, API, MCP): błąd jako ApiInputError z polem. */
export function zapytanieSprzedazy(
  v: { od?: string | null; do?: string | null; grupuj?: string | null; konto?: string | null; produktow?: number | null; porownaj?: string | null; porownajOd?: string | null; porownajDo?: string | null },
  now = new Date(),
): ZapytanieSprzedazy {
  const dzis = toWarsaw(now).day
  const od = v.od ?? `${dzis.slice(0, 8)}01`
  const doDnia = v.do ?? dzis
  if (!poprawnyDzien(od)) throw new ApiInputError('od: data RRRR-MM-DD', 'od')
  if (!poprawnyDzien(doDnia)) throw new ApiInputError('do: data RRRR-MM-DD', 'do')
  if (doDnia < od) throw new ApiInputError('do: data końca przed datą początku', 'do')
  const dni = dniMiedzy(od, doDnia)
  if (dni > SPRZEDAZ_MAKS_DNI) throw new ApiInputError(`Zakres najwyżej ${SPRZEDAZ_MAKS_DNI} dni`, 'od')
  let grupuj: Grupowanie
  if (v.grupuj === null || v.grupuj === undefined || v.grupuj === '') grupuj = domyslneGrupowanie(dni)
  else if ((GRUPOWANIA as readonly string[]).includes(v.grupuj)) grupuj = v.grupuj as Grupowanie
  else throw new ApiInputError('grupuj: dzien, tydzien albo miesiac', 'grupuj')
  if (okresy(od, doDnia, grupuj).length > SPRZEDAZ_MAKS_OKRESOW) throw new ApiInputError(`Najwyżej ${SPRZEDAZ_MAKS_OKRESOW} okresów: wybierz tygodnie albo miesiące`, 'grupuj')
  const konto = v.konto === null || v.konto === undefined || v.konto === '' ? null : v.konto
  if (konto !== null && !KONTO_RE.test(konto)) throw new ApiInputError('konto: klucz konta kanału, np. WOO:sklep', 'konto')
  const produktow = v.produktow === null || v.produktow === undefined ? SPRZEDAZ_DOMYSLNIE_PRODUKTOW : v.produktow
  if (!Number.isInteger(produktow) || produktow < 1 || produktow > SPRZEDAZ_MAKS_PRODUKTOW) throw new ApiInputError(`produktow: liczba całkowita 1–${SPRZEDAZ_MAKS_PRODUKTOW}`, 'produktow')
  const wybor = zapytaniePorownania(v)
  // tryb, który nie pasuje do zakresu, i zły własny zakres to błąd z polem już tutaj (ekran pokazuje baner)
  zakresPorownania({ od, do: doDnia, tryb: wybor.porownaj, wlasnyOd: wybor.porownajOd, wlasnyDo: wybor.porownajDo })
  return { od, do: doDnia, grupuj, konto, produktow, ...wybor }
}

const PARAMETRY = new Set(['od', 'do', 'grupuj', 'konto', 'produktow', 'porownaj', 'porownaj_od', 'porownaj_do'])

export function parseZapytanieSprzedazy(sp: URLSearchParams, now = new Date()): ZapytanieSprzedazy {
  for (const k of sp.keys()) if (!PARAMETRY.has(k)) throw new ApiInputError(`Nieznany parametr ${k}`, k)
  const p = sp.get('produktow')
  return zapytanieSprzedazy({ od: sp.get('od'), do: sp.get('do'), grupuj: sp.get('grupuj'), konto: sp.get('konto'), produktow: p === null ? null : Number(p), porownaj: sp.get('porownaj'), porownajOd: sp.get('porownaj_od'), porownajDo: sp.get('porownaj_do') }, now)
}

/** Początek okresu (dzień RRRR-MM-DD), w którym leży dzień `d`: poniedziałek tygodnia albo 1. dzień miesiąca. */
export function poczatekOkresu(d: IsoDay, g: Grupowanie): IsoDay {
  if (g === 'dzien') return d
  if (g === 'miesiac') return `${d.slice(0, 8)}01`
  const dow = new Date(`${d}T00:00:00Z`).getUTCDay() // 0 = niedziela
  return addDays(d, -((dow + 6) % 7))
}

/** Wszystkie okresy zakresu w kolejności (klucz = początek okresu; pierwszy i ostatni mogą być niepełne). */
export function okresy(od: IsoDay, doDnia: IsoDay, g: Grupowanie): IsoDay[] {
  const out: IsoDay[] = []
  let k = poczatekOkresu(od, g)
  while (k <= doDnia) {
    out.push(k)
    k = g === 'dzien' ? addDays(k, 1) : g === 'tydzien' ? addDays(k, 7) : nastepnyMiesiac(k)
  }
  return out
}

/** Ostatni dzień okresu zaczynającego się w `k`. */
export function koniecOkresu(k: IsoDay, g: Grupowanie): IsoDay {
  return g === 'dzien' ? k : g === 'tydzien' ? addDays(k, 6) : addDays(nastepnyMiesiac(k), -1)
}

function nastepnyMiesiac(d: IsoDay): IsoDay {
  const y = Number(d.slice(0, 4))
  const m = Number(d.slice(5, 7))
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
}

/** Poprzedni okres tej samej długości tuż przed zakresem (porównanie). */
export function poprzedniZakres(od: IsoDay, doDnia: IsoDay): { od: IsoDay; do: IsoDay } {
  const dni = dniMiedzy(od, doDnia)
  return { od: addDays(od, -dni), do: addDays(od, -1) }
}

// ─── Wynik ────────────────────────────────────────────────────────────────────

/** Kwoty w złotych z dokładnością do grosza (liczone w groszach z wartości Decimal z bazy). */
export interface Miary {
  /** wszystkie zamówienia, każda waluta */
  zamowien: number
  /** wartość zamówień brutto (z dostawą), jak pulpit; PLN plus obce waluty przeliczone kursem NBP */
  wartoscBrutto: number
  /** rozbicie zamówień w innych walutach (bez anulowanych): kwota w walucie, kurs, data kursu, kwota w złotych; pusta bez takich zamówień */
  inneWaluty: WalutaApi[]
  /** średnia wartość zamówienia w złotych (zamówienia z kwotą w `wartoscBrutto`) */
  sredniaWartosc: number | null
  /** sprzedaż produktów (pozycje bez dostawy), po zwrotach */
  produktyBrutto: number
  produktyNetto: number
  /** sztuki produktów na sztuki (produkty na wagę liczą się w kg w `kg`) */
  sztuk: number
  kg: number
  zwrotyBrutto: number
  /** marża tylko z pozycji, które mają cenę zakupu */
  koszt: number
  marza: number | null
  marzaProcent: number | null
  /** sprzedaż netto pozycji bez ceny zakupu (bez marży) */
  bezCenyZakupuNetto: number
  /**
   * pozycje z nierozpoznaną stawką VAT (np. literówka wpisana ręcznie na karcie zamówienia): netto liczone ze stawki
   * produktu, a bez niej z 23 %; licznik pokazuje błąd danych zamiast cicho zaniżać VAT
   */
  nieznanaStawkaPozycji: number
  anulowanych: number
  anulowaneBrutto: number
}

export interface WierszOkresu extends Miary {
  /** pierwszy dzień okresu (klucz) */
  okres: IsoDay
  /** ostatni dzień okresu */
  okresDo: IsoDay
  /** okres zaczyna się przed zakresem albo kończy po nim (pierwszy/ostatni tydzień, miesiąc) */
  niepelny: boolean
  /**
   * okres porównania stojący przy tym okresie (dni przycięte do zakresu porównania); null = bez porównania
   * albo bez pary (np. 29.02 rok do roku). `daneNiepelne`: okres zaczyna się przed początkiem danych kont raportu.
   */
  porownanie: (Miary & { od: IsoDay; do: IsoDay; daneNiepelne: boolean }) | null
}

export interface WierszKonta extends Miary {
  konto: string
  nazwa: string
  /**
   * to konto w okresie porównania; null = bez porównania. `daneOd` = pierwszy dzień danych konta (null = konto
   * bez zamówień), `daneNiepelne` = dane konta zaczynają się po pierwszym dniu porównania.
   */
  porownanie: (Miary & { daneOd: IsoDay | null; daneNiepelne: boolean }) | null
}

/** okres porównania raportu (pole `poprzedni`, nazwa zostaje dla zgodności wstecz API i MCP). */
export interface PorownanieRaportu {
  od: IsoDay
  do: IsoDay
  tryb: TrybPorownania
  /** liczba dni porównania (przy `wlasny` może być inna niż zakresu) */
  dni: number
  razem: Miary
  /** najwcześniejszy dzień danych (zamówienie w Kompletorze albo archiwum) kont raportu; null = brak zamówień */
  poczatekDanych: IsoDay | null
  /** konta raportu, których dane zaczynają się po pierwszym dniu porównania (porównanie dla nich niepełne) */
  kontaBezDanych: { konto: string; nazwa: string; daneOd: IsoDay }[]
  /** cały okres porównania przed początkiem danych kont raportu: liczby porównania to brak danych, nie zero sprzedaży */
  bezDanych: boolean
}

export interface WierszProduktu {
  sku: string | null
  nazwa: string
  jednostka: Unit
  /** ilość w jednostce bazowej po zwrotach: sztuki albo gramy */
  ilosc: number
  brutto: number
  netto: number
  zwrotyBrutto: number
  zamowien: number
  koszt: number | null
  marza: number | null
  marzaProcent: number | null
  /** true = brak ceny zakupu (marża nieznana) */
  brakCenyZakupu: boolean
  /** ten produkt w okresie porównania (te same jednostki); null = bez porównania */
  porownanie: { ilosc: number; brutto: number; netto: number; zamowien: number; marza: number | null } | null
}

export interface RaportSprzedazy {
  od: IsoDay
  do: IsoDay
  grupuj: Grupowanie
  konto: string | null
  stanNa: string
  razem: Miary
  /** porównanie wg `porownaj`; null = bez porównania (`porownaj=brak`) */
  poprzedni: PorownanieRaportu | null
  okresy: WierszOkresu[]
  konta: WierszKonta[]
  produkty: WierszProduktu[]
  produktowRazem: number
  wiecejProduktow: boolean
  /** zamówienia z kanału, których Kompletor nie realizuje (sprzed startu, nieprzyjęte): poza raportem, tylko liczba i kwota */
  pozaKompletorem: { zamowien: number; brutto: number; inneWaluty: WalutaApi[] }
  /**
   * zamówienia zakresu z archiwum (sprzed odczytu kanału przez Kompletora, bez anulowanych), już wliczone
   * w `razem`, okresy, konta i produkty; kwota w złotych regułą (rozbicie w `inneWaluty`); ekran pokazuje
   * z tego dopisek „w tym z archiwum”
   */
  zArchiwum: { zamowien: number; brutto: number; inneWaluty: WalutaApi[] }
  /**
   * etap 3: część `zArchiwum` z kanałem odtworzonym (faktury BL bez pary w innych kanałach liczone jako
   * Allegro, `ArchivedOrder.channelInferred`); wliczona normalnie, ekran pokazuje ją osobnym zdaniem
   */
  zKanalemOdtworzonym: { zamowien: number; brutto: number; inneWaluty: WalutaApi[] }
}

// ─── Zapytania ────────────────────────────────────────────────────────────────

interface LiniaRow {
  zestaw: number // GROUPING(okres, channel, account, product): stałe L_* niżej
  okres: string | null
  channel: string | null
  account: string | null
  product: string | null
  brutto: string | null
  netto: string | null
  zwrot_brutto: string | null
  zwrot_netto: string | null
  szt: string | null
  gram: string | null
  koszt: string | null
  netto_z_kosztem: string | null
  zwrot_netto_z_kosztem: string | null
  zwrot_koszt: string | null
  nieznana_stawka: bigint
  zamowien: bigint
}

interface ZamRow {
  zestaw: number
  okres: string | null
  channel: string | null
  account: string | null
  waluta: string
  zamowien: bigint
  brutto: string | null
  anulowanych: bigint
  anulowane_brutto: string | null
  z_archiwum: bigint
  z_archiwum_brutto: string | null
  z_odtworzonym: bigint
  z_odtworzonym_brutto: string | null
}

/**
 * Pozycje okresu zgrupowane w zestawach: okres, konto kanału, produkt, całość. `zestaw` = GROUPING(okres, channel,
 * account, product): 7 = okres (bity kanału, konta, produktu ustawione), 9 = konto (okres i produkt), 14 = produkt, 15 = całość.
 */
async function linie(db: PrismaClient, from: Date, to: Date, trunc: string, konto: string | null, kursy: string): Promise<LiniaRow[]> {
  return db.$queryRaw<LiniaRow[]>`
    WITH o AS (
      SELECT o."id", o."channel", o."channelAccountId", o."parentOrderId",
             to_char(date_trunc(${trunc}, (o."createdAtChannel" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw'), 'YYYY-MM-DD') AS okres,
             -- PLN = 1, obca waluta = kurs NBP z parametru (JSON kod → kurs), brak kursu = NULL (kwoty poza sumą)
             CASE WHEN coalesce(wk.waluta, 'PLN') = 'PLN' THEN 1::numeric ELSE (${kursy}::jsonb ->> wk.waluta)::numeric END AS kurs
      FROM "Order" o
      -- waluta z kopii kanału po kluczu unikalnym; paczka dodatkowa („…#dosle-n”) po numerze zamówienia głównego
      -- (jak walutyZamowien w lib/rdzen/waluta.ts); bez kopii = PLN
      LEFT JOIN LATERAL (
        SELECT coalesce(nullif(upper(btrim(k."currency")), ''), 'PLN') AS waluta
        FROM "ChannelOrderSnapshot" k
        WHERE k."organizationId" = o."organizationId" AND k."channel" = o."channel" AND k."channelAccountId" = o."channelAccountId"
          AND k."externalId" IN (o."externalId", split_part(o."externalId", '#', 1))
        ORDER BY (k."externalId" = o."externalId") DESC
        LIMIT 1
      ) wk ON true
      WHERE o."createdAtChannel" >= ${from} AND o."createdAtChannel" < ${to} AND o."status" <> 'ANULOWANE'
        AND (${konto}::text IS NULL OR (o."channel"::text || ':' || o."channelAccountId") = ${konto}::text)
    ), a AS (
      -- archiwum zamówień sprzed odczytu kanału; zamówienie, które ma już wiersz „Order”, liczy się tylko
      -- stamtąd (rozłączność, lib/archiwum/import.ts). Kurs jak wyżej, waluta z wiersza archiwum
      SELECT a."id", a."channel", a."channelAccountId",
             to_char(date_trunc(${trunc}, (a."createdAtChannel" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw'), 'YYYY-MM-DD') AS okres,
             CASE WHEN coalesce(nullif(upper(btrim(a."currency")), ''), 'PLN') = 'PLN' THEN 1::numeric
                  ELSE (${kursy}::jsonb ->> upper(btrim(a."currency")))::numeric END AS kurs
      FROM "ArchivedOrder" a
      WHERE a."createdAtChannel" >= ${from} AND a."createdAtChannel" < ${to} AND a."status" IS DISTINCT FROM 'ANULOWANE'
        AND (${konto}::text IS NULL OR (a."channel"::text || ':' || a."channelAccountId") = ${konto}::text)
        -- reguła rozłączności (id albo numer zamówienia w oknie daty): lib/archiwum/rozlacznosc.ts
        AND ${sqlBrakWKompletorze('a')}
    ), l0 AS (
      -- pozycje zamówień Kompletora i pozycje archiwum; stawka VAT i koszt liczą się niżej, jedną regułą dla obu źródeł
      SELECT o.okres, o."channel"::text AS channel, o."channelAccountId" AS account, l."productId" AS product,
             coalesce(o."parentOrderId", o."id") AS zam, o.kurs IS NOT NULL AS pln,
             (l."qty" - l."qtyRejected")::numeric AS q,
             l."unitPriceGross" * (l."qty" - l."qtyRejected") / coalesce(nullif(co."qtyBasePerOffer", 0), 1) * coalesce(o.kurs, 0) AS brutto,
             l."vatRate" AS vat_l,
             coalesce(r.ret, 0) AS ret
      FROM "OrderLine" l
      JOIN o ON o."id" = l."orderId"
      LEFT JOIN "Product" p ON p."id" = l."productId"
      -- zamiennik („Zamień produkt”, pozycja „…#zamiana-N”) nie ma oferty; cena jest za sztukę oferty pozycji
      -- pierwotnej, więc przelicznik bierzemy z jej oferty (lib/rdzen/zamiana.ts)
      LEFT JOIN "OrderLine" lp
        ON l."externalLineId" ~ '#zamiana-[0-9]+$' AND lp."orderId" = l."orderId"
       AND lp."externalLineId" = split_part(l."externalLineId", '#zamiana-', 1)
      LEFT JOIN "ChannelOffer" co
        ON l."productId" IS NOT NULL AND co."organizationId" = l."organizationId" AND co."channel"::text = o."channel"::text
       AND co."channelAccountId" = o."channelAccountId" AND co."externalId" = coalesce(lp."offerId", l."offerId")
      LEFT JOIN LATERAL (SELECT count(*) AS n FROM "BundleComponent" bc WHERE bc."bundleId" = p."id") zn ON p."kind" = 'BUNDLE'
      -- zwrócone jednostki pozycji: produkt wprost; zestaw z ruchów składników (zwrot pozycji zestawu zapisuje składniki):
      -- każdy składnik waży 1/(liczba składników) zestawu, więc zwrot całego zestawu = 1, jednego z dwóch składników = 0,5
      LEFT JOIN LATERAL (
        SELECT sum(CASE WHEN p."kind" = 'BUNDLE' THEN rl."qty"::numeric / (nullif(bc."qtyBase", 0) * zn.n) ELSE rl."qty" END) AS ret
        FROM "ReturnLine" rl JOIN "Return" rt ON rt."id" = rl."returnId"
        LEFT JOIN "BundleComponent" bc ON p."kind" = 'BUNDLE' AND bc."bundleId" = p."id" AND bc."componentId" = rl."productId"
        WHERE rl."orderLineId" = l."id" AND rt."status" <> 'ODRZUCONY'
      ) r ON true
      WHERE NOT l."removed" AND l."qty" - l."qtyRejected" > 0
      UNION ALL
      -- archiwum: ilość w jednostce bazowej, wartość całej pozycji brutto (przeliczona kursem), zwrot jako zwrócone
      -- jednostki (refundQty)
      SELECT a.okres, a."channel"::text, a."channelAccountId", al."productId", a."id", a.kurs IS NOT NULL,
             al."qty"::numeric, al."lineGross"::numeric * coalesce(a.kurs, 0), al."vatRate", least(al."refundQty", al."qty")::numeric
      FROM "ArchivedOrderLine" al
      JOIN a ON a."id" = al."orderId"
      WHERE al."qty" > 0
    ), l AS (
      SELECT l0.okres, l0.channel, l0.account, l0.product, l0.zam, l0.pln, l0.q, l0.brutto, l0.ret, p."unit" AS unit,
             -- stawka pozycji, potem produktu: liczba („23”, „8.00”, „5 %”), kody bez VAT („zw”, „np”, „np I”, „oo”, „0 WDT”) = 0,
             -- brak stawki = 23; inny tekst (błąd danych) = stawka produktu albo 23 i licznik „nieznana_stawka”
             -- (wcześniej każdy nieznany tekst liczył się cicho jako 0 %, czyli netto = brutto)
             CASE WHEN coalesce(l0.vat_l, p."vatRate") IS NULL THEN 23
                  WHEN btrim(coalesce(l0.vat_l, p."vatRate")) ~ '^[0-9]+([.,][0-9]+)? ?%?$' THEN replace(replace(replace(btrim(coalesce(l0.vat_l, p."vatRate")), ',', '.'), '%', ''), ' ', '')::numeric
                  WHEN lower(btrim(coalesce(l0.vat_l, p."vatRate"))) ~ '^((zw|np|oo)([ .]|$)|0 [a-z])' THEN 0
                  WHEN btrim(p."vatRate") ~ '^[0-9]+([.,][0-9]+)? ?%?$' THEN replace(replace(replace(btrim(p."vatRate"), ',', '.'), '%', ''), ' ', '')::numeric
                  WHEN lower(btrim(p."vatRate")) ~ '^((zw|np|oo)([ .]|$)|0 [a-z])' THEN 0
                  ELSE 23 END AS vat,
             (coalesce(l0.vat_l, p."vatRate") IS NOT NULL AND btrim(coalesce(l0.vat_l, p."vatRate")) !~ '^[0-9]+([.,][0-9]+)? ?%?$'
               AND lower(btrim(coalesce(l0.vat_l, p."vatRate"))) !~ '^((zw|np|oo)([ .]|$)|0 [a-z])') AS nieznana,
             coalesce(p."purchasePriceNet" / CASE WHEN p."unit" = 'KG' THEN 1000 ELSE 1 END, z.k) AS kj
      FROM l0
      LEFT JOIN "Product" p ON p."id" = l0.product
      LEFT JOIN LATERAL (
        SELECT CASE WHEN bool_and(c."purchasePriceNet" IS NOT NULL) THEN sum(bc."qtyBase" * c."purchasePriceNet" / CASE WHEN c."unit" = 'KG' THEN 1000 ELSE 1 END) END AS k
        FROM "BundleComponent" bc JOIN "Product" c ON c."id" = bc."componentId"
        WHERE bc."bundleId" = p."id"
      ) z ON p."kind" = 'BUNDLE'
    ), w AS (
      SELECT l.*, least(1, l.ret / l.q) AS frac, l.brutto / (1 + l.vat / 100) AS netto FROM l
    )
    SELECT (GROUPING(okres, channel, account, product))::int AS zestaw, okres, channel, account, product,
           -- kwoty z zamówień w PLN i przeliczonych kursem (pln = kurs znany), ilości z każdej waluty
           sum(brutto) FILTER (WHERE pln)::text AS brutto, sum(netto) FILTER (WHERE pln)::text AS netto,
           sum(brutto * frac) FILTER (WHERE pln)::text AS zwrot_brutto, sum(netto * frac) FILTER (WHERE pln)::text AS zwrot_netto,
           sum(q * (1 - frac)) FILTER (WHERE unit IS DISTINCT FROM 'KG')::text AS szt,
           sum(q * (1 - frac)) FILTER (WHERE unit = 'KG')::text AS gram,
           sum(q * kj) FILTER (WHERE kj IS NOT NULL AND pln)::text AS koszt,
           sum(netto) FILTER (WHERE kj IS NOT NULL AND pln)::text AS netto_z_kosztem,
           sum(netto * frac) FILTER (WHERE kj IS NOT NULL AND pln)::text AS zwrot_netto_z_kosztem,
           sum(q * kj * frac) FILTER (WHERE kj IS NOT NULL AND pln)::text AS zwrot_koszt,
           count(*) FILTER (WHERE nieznana) AS nieznana_stawka,
           count(DISTINCT zam) AS zamowien
    FROM w
    GROUP BY GROUPING SETS ((okres), (channel, account), (product), ())`
}

/**
 * Zamówienia okresu (bez podzamówień) w zestawach: okres, konto, całość, każdy rozbity po walucie (waluta z
 * kopii kanału, bez kopii = PLN); `zestaw` = GROUPING(okres, channel, account), stałe Z_* niżej.
 */
async function zamowienia(db: PrismaClient, from: Date, to: Date, trunc: string, konto: string | null): Promise<ZamRow[]> {
  return db.$queryRaw<ZamRow[]>`
    SELECT (GROUPING(okres, channel, account))::int AS zestaw, okres, channel, account, waluta,
           count(*) FILTER (WHERE NOT anul) AS zamowien, (sum(brutto) FILTER (WHERE NOT anul))::text AS brutto,
           count(*) FILTER (WHERE anul) AS anulowanych, (sum(brutto) FILTER (WHERE anul))::text AS anulowane_brutto,
           count(*) FILTER (WHERE arch AND NOT anul) AS z_archiwum, (sum(brutto) FILTER (WHERE arch AND NOT anul))::text AS z_archiwum_brutto,
           count(*) FILTER (WHERE odtw AND NOT anul) AS z_odtworzonym, (sum(brutto) FILTER (WHERE odtw AND NOT anul))::text AS z_odtworzonym_brutto
    FROM (
      SELECT to_char(date_trunc(${trunc}, (o."createdAtChannel" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw'), 'YYYY-MM-DD') AS okres,
             o."channel"::text AS channel, o."channelAccountId" AS account, o."totalGross" AS brutto, o."status" = 'ANULOWANE' AS anul,
             coalesce(nullif(upper(btrim(k."currency")), ''), 'PLN') AS waluta, false AS arch, false AS odtw
      FROM "Order" o
      LEFT JOIN "ChannelOrderSnapshot" k
        ON k."organizationId" = o."organizationId" AND k."channel" = o."channel" AND k."channelAccountId" = o."channelAccountId" AND k."externalId" = o."externalId"
      WHERE o."createdAtChannel" >= ${from} AND o."createdAtChannel" < ${to} AND o."parentOrderId" IS NULL
        AND (${konto}::text IS NULL OR (o."channel"::text || ':' || o."channelAccountId") = ${konto}::text)
      UNION ALL
      -- archiwum bez wierszy, które mają już „Order” (status null = nieustalony, liczy się do sprzedaży);
      -- waluta z wiersza archiwum, dalej ta sama reguła walut co dla „Order”
      SELECT to_char(date_trunc(${trunc}, (a."createdAtChannel" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw'), 'YYYY-MM-DD'),
             a."channel"::text, a."channelAccountId", a."totalGross", a."status" IS NOT DISTINCT FROM 'ANULOWANE',
             coalesce(nullif(upper(btrim(a."currency")), ''), 'PLN'), true, a."channelInferred"
      FROM "ArchivedOrder" a
      WHERE a."createdAtChannel" >= ${from} AND a."createdAtChannel" < ${to}
        AND (${konto}::text IS NULL OR (a."channel"::text || ':' || a."channelAccountId") = ${konto}::text)
        -- reguła rozłączności (id albo numer zamówienia w oknie daty): lib/archiwum/rozlacznosc.ts
        AND ${sqlBrakWKompletorze('a')}
    ) s
    GROUP BY GROUPING SETS ((okres, waluta), (channel, account, waluta), (waluta))`
}

/** Kopie zamówień z kanału bez zamówienia w Kompletorze (jak `salesRows` pulpitu, bez anulowanych i szkiców). */
async function pozaKompletorem(db: PrismaClient, from: Date, to: Date, konto: string | null): Promise<{ waluta: string; n: bigint; brutto: string | null }[]> {
  return db.$queryRaw<{ waluta: string; n: bigint; brutto: string | null }[]>`
    SELECT coalesce(nullif(upper(btrim(c."currency")), ''), 'PLN') AS waluta, count(*) AS n, sum(c."totalGross")::text AS brutto
    FROM "ChannelOrderSnapshot" c
    WHERE c."createdAtChannel" >= ${from} AND c."createdAtChannel" < ${to} AND c."lifecycle" NOT IN ('DRAFT', 'CANCELLED')
      AND (${konto}::text IS NULL OR (c."channel"::text || ':' || c."channelAccountId") = ${konto}::text)
      AND NOT EXISTS (
        SELECT 1 FROM "Order" x
        WHERE x."organizationId" = c."organizationId" AND x."channel" = c."channel" AND x."channelAccountId" = c."channelAccountId" AND x."externalId" = c."externalId"
      )
      -- kopia z wierszem archiwum liczy się w raporcie z archiwum, nie tutaj
      AND NOT EXISTS (
        SELECT 1 FROM "ArchivedOrder" y
        WHERE y."organizationId" = c."organizationId" AND y."channel" = c."channel" AND y."channelAccountId" = c."channelAccountId" AND y."externalId" = c."externalId"
      )
    GROUP BY 1`
}

// GROUPING(a,b,c,d): bit 3 = a … bit 0 = d; 1 = kolumna zgrupowana (pominięta)
const L_OKRES = 0b0111
const L_KONTO = 0b1001
const L_PRODUKT = 0b1110
const L_RAZEM = 0b1111
const Z_OKRES = 0b011
const Z_KONTO = 0b100
const Z_RAZEM = 0b111

const gr = (v: string | null | undefined): number => (v === null || v === undefined ? 0 : Math.round(Number(v) * 100))
const zl = (g: number): number => g / 100

function pustaMiara(): Miary {
  return { zamowien: 0, wartoscBrutto: 0, inneWaluty: [], sredniaWartosc: null, produktyBrutto: 0, produktyNetto: 0, sztuk: 0, kg: 0, zwrotyBrutto: 0, koszt: 0, marza: null, marzaProcent: null, bezCenyZakupuNetto: 0, nieznanaStawkaPozycji: 0, anulowanych: 0, anulowaneBrutto: 0 }
}

/** `zs` = wiersze zamówień jednego klucza (okres, konto albo całość), po jednym na walutę. */
function miara(l: LiniaRow | undefined, zs: readonly ZamRow[], kursy: KursyWalut | null): Miary {
  const m = pustaMiara()
  if (zs.length) {
    const s = sumaWalut(
      zs.map((z) => ({ waluta: z.waluta, grosze: gr(z.brutto), zamowien: Number(z.zamowien) })),
      kursy,
    )
    m.zamowien = s.zamowien
    m.wartoscBrutto = zl(s.grosze)
    m.inneWaluty = obceDoApi(s.obce)
    m.sredniaWartosc = s.zamowienWSumie ? Math.round(s.grosze / s.zamowienWSumie) / 100 : null
    m.anulowanych = zs.reduce((a, z) => a + Number(z.anulowanych), 0)
    m.anulowaneBrutto = zl(
      sumaWalut(
        zs.map((z) => ({ waluta: z.waluta, grosze: gr(z.anulowane_brutto) })),
        kursy,
      ).grosze,
    )
  }
  if (l) {
    const brutto = gr(l.brutto) - gr(l.zwrot_brutto)
    const netto = gr(l.netto) - gr(l.zwrot_netto)
    m.produktyBrutto = zl(brutto)
    m.produktyNetto = zl(netto)
    m.zwrotyBrutto = zl(gr(l.zwrot_brutto))
    m.sztuk = Math.round(Number(l.szt ?? 0) * 1000) / 1000
    m.kg = Math.round(Number(l.gram ?? 0)) / 1000
    const nettoZK = gr(l.netto_z_kosztem) - gr(l.zwrot_netto_z_kosztem)
    const koszt = gr(l.koszt) - gr(l.zwrot_koszt)
    m.bezCenyZakupuNetto = zl(netto - nettoZK)
    m.nieznanaStawkaPozycji = Number(l.nieznana_stawka ?? 0)
    if (l.koszt !== null) {
      m.koszt = zl(koszt)
      m.marza = zl(nettoZK - koszt)
      m.marzaProcent = nettoZK > 0 ? Math.round(((nettoZK - koszt) / nettoZK) * 1000) / 10 : null
    }
  }
  return m
}

/**
 * Okno wstecz pierwszego odczytu konta (`DEFAULT_LOOKBACK_MS` w lib/cien/odczyt-zamowien.ts; równość pilnuje
 * tests/raporty-porownanie.integration.test.ts). Udany pierwszy odczyt zaczyna się w `coverageFrom` + okno.
 */
export const OKNO_PIERWSZEGO_ODCZYTU_MS = 24 * 3600_000

/** Pierwszy pełny dzień (czas polski) od chwili `t`: sam dzień, gdy `t` to jego północ, inaczej dzień następny. */
function pierwszyPelnyDzien(t: Date): IsoDay {
  const { day, msOfDay } = toWarsaw(t)
  return msOfDay === 0 ? day : addDays(day, 1)
}

/** Początek zakresu importu z `ImportRun.stats.od` (ISO w UTC); wartość nieczytelna albo nieistniejąca data = brak. */
function odImportu(s: string | null): Date | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}T/.test(s)) return null
  const d = new Date(s)
  // `new Date` przenosi nieistniejący dzień dalej (30.02 → 2.03): taka wartość nie jest granicą
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s.slice(0, 10) ? null : d
}

// Granice importu archiwum na firmę (klucz: id firmy), ważne, dopóki nie zmienią się przebiegi importu (podpis z
// `ImportRun`: id, status, zakres, liczniki zapisanych i wycofanych, koniec). Wiersze archiwum zmienia tylko przebieg
// importu, więc podpis wystarcza; TTL to tylko siatka bezpieczeństwa.
const ARCHIWUM_TTL_MS = 3600_000
const ARCHIWUM_MAKS_FIRM = 500
const granicArchiwum = new Map<string, { podpis: string; at: number; mapa: Map<string, Date> }>()

/** Początek zakresu importu archiwum per konto (najwcześniejszy `stats.od` przebiegów, z których są wiersze konta). */
async function granicaArchiwum(db: PrismaClient): Promise<Map<string, Date>> {
  let firma: string | null = null
  try {
    firma = organizationIdOf(db)
  } catch {
    firma = null // klient bez firmy (np. narzędzie systemowe): bez pamięci podręcznej
  }
  const [p] = await db.$queryRaw<{ podpis: string }[]>`
    SELECT md5(coalesce(string_agg(
      r."id" || ':' || r."status"::text || ':' || coalesce(r."stats" ->> 'od', '') || ':' || coalesce(r."stats" ->> 'zapisane', '')
        || ':' || coalesce(r."stats" ->> 'wycofane', '') || ':' || coalesce(r."finishedAt"::text, ''),
      ',' ORDER BY r."id"), '')) AS podpis
    FROM "ImportRun" r
    WHERE r."kind" LIKE 'archiwum-%'`
  const podpis = p?.podpis ?? ''
  const teraz = Date.now()
  const zapis = firma ? granicArchiwum.get(firma) : undefined
  if (zapis && zapis.podpis === podpis && teraz - zapis.at < ARCHIWUM_TTL_MS) return zapis.mapa
  const rows = await db.$queryRaw<{ channel: string; account: string; od: string | null }[]>`
    SELECT ar.channel, ar.account, r."stats" ->> 'od' AS od
    FROM (SELECT DISTINCT a."importRunId" AS run, a."channel"::text AS channel, a."channelAccountId" AS account FROM "ArchivedOrder" a WHERE a."importRunId" IS NOT NULL) ar
    JOIN "ImportRun" r ON r."id" = ar.run`
  const mapa = new Map<string, Date>()
  for (const r of rows) {
    const od = odImportu(r.od)
    if (!od) continue
    const k = accountKey(r.channel as Channel, r.account)
    const byl = mapa.get(k)
    if (!byl || od < byl) mapa.set(k, od)
  }
  if (firma) {
    if (granicArchiwum.size >= ARCHIWUM_MAKS_FIRM) granicArchiwum.delete(granicArchiwum.keys().next().value!)
    granicArchiwum.set(firma, { podpis, at: teraz, mapa })
  }
  return mapa
}

/**
 * pierwszy dzień danych (czas polski) kont kanałów. Początek = najwcześniejsza z granic: (1) pierwszy pełny
 * dzień po pierwszym udanym odczycie konta przez Kompletora (`ChannelCursor.coverageFrom` + okno wstecz), (2) początek zakresu importu archiwum konta (`ImportRun.stats.od` przebiegów,
 * z których są wiersze archiwum konta). Pierwsze zamówienie konta (Kompletor albo archiwum) liczy się wyłącznie wtedy,
 * gdy żadnej granicy nie ma (np. konto dodane ręcznie): pojedyncze stare zamówienie nie przesuwa początku danych.
 * Dzięki granicom pierwszy dzień bez zamówień (np. święto na początku zakresu archiwum) nie robi porównania „niepełnym”.
 * Tryb podglądu (cień) nie zostawia luki: odczyt przyjmuje zamówienia do `Order` także w podglądzie
 * (lib/cien/odczyt-zamowien.ts, `handleChannelOrder` → `ingestOrder`), tryby kont dotyczą tylko zapisów do kanału.
 * Odczyt zaczyna się od okna wstecz (`coverageFrom` = start pierwszego udanego odczytu − 24 h), w którym zamówienia już
 * zrealizowane zostają tylko kopią kanału (poza raportem), dlatego granicą (1) jest pierwszy pełny dzień po tym starcie
 * (`firstPollAt` się nie nadaje: to pierwsza próba, także nieudana). Okres sprzed `coverageFrom` pokrywa archiwum
 * (granica (2), lib/archiwum/rozlacznosc.ts), więc z archiwum ten szew nie robi „niepełnego”.
 * `konta` = klucze kont do oceny; null = wszystkie znane konta (konfiguracja, odczyt, archiwum).
 * Koszt: granice z małych tabel (`ChannelCursor`, `ImportRun`), archiwum z pamięci podręcznej per firma, a pierwsze
 * zamówienie tylko dla kont bez granic, przez `ORDER BY … LIMIT 1` per konto.
 */
async function poczatkiDanych(db: PrismaClient, konta: string[] | null, znane: string[]): Promise<Map<string, IsoDay>> {
  const [kursory, archiwum] = await Promise.all([
    db.channelCursor.findMany({ where: { coverageFrom: { not: null } }, select: { channel: true, channelAccountId: true, coverageFrom: true } }),
    granicaArchiwum(db),
  ])
  const odczyt = new Map(kursory.map((c) => [accountKey(c.channel, c.channelAccountId), pierwszyPelnyDzien(new Date(c.coverageFrom!.getTime() + OKNO_PIERWSZEGO_ODCZYTU_MS))]))
  const lista = konta ?? [...new Set([...znane, ...odczyt.keys(), ...archiwum.keys()])]
  const wynik = new Map<string, IsoDay>()
  const bezGranic: string[] = []
  for (const k of new Set(lista)) {
    const granice = [odczyt.get(k), archiwum.has(k) ? toWarsaw(archiwum.get(k)!).day : undefined].filter((d): d is IsoDay => !!d)
    if (granice.length) wynik.set(k, granice.reduce((x, y) => (y < x ? y : x)))
    else bezGranic.push(k)
  }
  if (bezGranic.length) {
    const ch = bezGranic.map((k) => k.slice(0, k.indexOf(':')))
    const acc = bezGranic.map((k) => k.slice(k.indexOf(':') + 1))
    const rows = await db.$queryRaw<{ channel: string; account: string; z: Date | null; a: Date | null }[]>`
      SELECT k.channel, k.account,
        (SELECT o."createdAtChannel" FROM "Order" o WHERE o."channelAccountId" = k.account AND o."channel"::text = k.channel ORDER BY o."createdAtChannel" LIMIT 1) AS z,
        (SELECT a."createdAtChannel" FROM "ArchivedOrder" a WHERE a."channelAccountId" = k.account AND a."channel"::text = k.channel ORDER BY a."createdAtChannel" LIMIT 1) AS a
      FROM unnest(${ch}::text[], ${acc}::text[]) AS k(channel, account)`
    for (const r of rows) {
      const t = [r.z, r.a].filter((d): d is Date => !!d)
      if (t.length) wynik.set(accountKey(r.channel as Channel, r.account), toWarsaw(t.reduce((x, y) => (y < x ? y : x))).day)
    }
  }
  return wynik
}

function zakresUtc(od: IsoDay, doDnia: IsoDay): { from: Date; to: Date } {
  return { from: fromWarsaw(od, 0), to: fromWarsaw(addDays(doDnia, 1), 0) }
}

/** Raport sprzedaży z ekranu, API i MCP: okres porównania wg wyboru `q.porownaj` (lib/api/raporty-porownanie.ts). */
export async function raportSprzedazy(db: PrismaClient, q: ZapytanieSprzedazy, now = new Date()): Promise<RaportSprzedazy> {
  const tryb = q.porownaj ?? 'poprzedni'
  const prev = zakresPorownania({ od: q.od, do: q.do, tryb, wlasnyOd: q.porownajOd, wlasnyDo: q.porownajDo })
  return porownanieSprzedazy(db, { od: q.od, do: q.do, grupuj: q.grupuj, konto: q.konto, produktow: q.produktow, porownanie: prev ? { ...prev, tryb } : null }, now)
}

/** zapytanie porównania z jawnymi zakresami (bez parametrów adresu); zakresy sprawdza wywołujący. */
export interface ZakresyPorownania {
  od: IsoDay
  do: IsoDay
  grupuj: Grupowanie
  konto: string | null
  produktow: number
  /** okres B; null = bez porównania. `tryb` decyduje tylko o parowaniu okresów (rok wcześniej: ta sama data) */
  porownanie: { od: IsoDay; do: IsoDay; tryb?: TrybPorownania } | null
}

/**
 * sprzedaż w okresie A (`od`–`do`) wobec okresu B (`porownanie`): suma, okresy (dzień, tydzień, miesiąc),
 * konta kanałów i produkty, każde z polem porównania, z tymi samymi regułami co raport (anulowane, waluty, archiwum,
 * zwroty) i oznaczeniem okresu B sprzed początku danych. Funkcja wielokrotnego użytku (ekran, API, MCP, podpowiedzi
 * sprzedażowe); archiwum czyta tylko ten moduł.
 */
export async function porownanieSprzedazy(db: PrismaClient, q: ZakresyPorownania, now = new Date()): Promise<RaportSprzedazy> {
  const trunc = TRUNC[q.grupuj]
  const { from, to } = zakresUtc(q.od, q.do)
  const prev = q.porownanie ? { od: q.porownanie.od, do: q.porownanie.do } : null
  const trybP: TrybPorownania = q.porownanie?.tryb ?? 'wlasny'
  const p = prev ? zakresUtc(prev.od, prev.do) : null
  // kursy NBP zapisane przez worker (jeden odczyt z bazy, bez sieci); ten sam kurs dla zakresu i porównania
  const kursy = await czytajKursy(db)
  const kursyJson = JSON.stringify(kursy?.kursy ?? {})
  const [lin, zam, poza, linP, zamP, accs] = await Promise.all([
    linie(db, from, to, trunc, q.konto, kursyJson),
    zamowienia(db, from, to, trunc, q.konto),
    pozaKompletorem(db, from, to, q.konto),
    p ? linie(db, p.from, p.to, trunc, q.konto, kursyJson) : Promise.resolve([] as LiniaRow[]),
    p ? zamowienia(db, p.from, p.to, trunc, q.konto) : Promise.resolve([] as ZamRow[]),
    accounts(db),
  ])
  const kluczKonta = (r: { channel: string | null; account: string | null }) => accountKey(r.channel as Channel, r.account ?? '')
  const okresyLista = okresy(q.od, q.do, q.grupuj)
  const okresL = new Map(lin.filter((r) => r.zestaw === L_OKRES).map((r) => [r.okres!, r]))
  // wiersz zamówień na walutę, więc klucz (okres, konto) zbiera kilka wierszy
  const grupuj = <K,>(rows: ZamRow[], klucz: (r: ZamRow) => K) => {
    const m = new Map<K, ZamRow[]>()
    for (const r of rows) m.set(klucz(r), [...(m.get(klucz(r)) ?? []), r])
    return m
  }
  const okresZ = grupuj(zam.filter((r) => r.zestaw === Z_OKRES), (r) => r.okres!)
  const kontaL = new Map(lin.filter((r) => r.zestaw === L_KONTO).map((r) => [kluczKonta(r), r]))
  const kontaZ = grupuj(zam.filter((r) => r.zestaw === Z_KONTO), kluczKonta)
  const nazwy = new Map(accs.map((a) => [accountKey(a.channel, a.channelAccountId), a.name]))
  const nazwaKonta = (k: string) => {
    const [ch, ...rest] = k.split(':')
    return nazwy.get(k) ?? accountDisplayName(ch as Channel, rest.join(':'))
  }

  // początek danych kont raportu (konta z zamówieniami w zakresie; bez nich konto z filtra albo wszystkie)
  const kontaZakresu = [...new Set([...kontaL.keys(), ...kontaZ.keys()])]
  const kontaLP = new Map(linP.filter((r) => r.zestaw === L_KONTO).map((r) => [kluczKonta(r), r]))
  const kontaZP = grupuj(zamP.filter((r) => r.zestaw === Z_KONTO), kluczKonta)
  // początki tylko dla kont raportu (wiersze kont z obu okresów i konta do oceny), bez porównania bez zapytań
  const doOceny = kontaZakresu.length ? kontaZakresu : q.konto ? [q.konto] : null
  const poczatki = prev
    ? await poczatkiDanych(db, doOceny ? [...new Set([...doOceny, ...kontaLP.keys(), ...kontaZP.keys()])] : null, [...accs.map((x) => accountKey(x.channel, x.channelAccountId)), ...kontaLP.keys(), ...kontaZP.keys()])
    : new Map<string, IsoDay>()
  const kontaDanych = doOceny ?? [...poczatki.keys()]
  const starty = kontaDanych.map((k) => poczatki.get(k)).filter((d): d is IsoDay => !!d)
  const najpozniejszyStart = starty.length ? starty.reduce((x, y) => (y > x ? y : x)) : null

  const okresP = new Map(linP.filter((r) => r.zestaw === L_OKRES).map((r) => [r.okres!, r]))
  const okresZP = grupuj(zamP.filter((r) => r.zestaw === Z_OKRES), (r) => r.okres!)
  const paryOkresow = prev ? kluczePorownania(okresyLista, okresy(prev.od, prev.do, q.grupuj), trybP, q.grupuj) : okresyLista.map(() => null)
  const wierszeOkresow: WierszOkresu[] = okresyLista.map((k, i) => {
    const kp = paryOkresow[i] ?? null
    let porownanie: WierszOkresu['porownanie'] = null
    if (prev && kp) {
      const od = kp < prev.od ? prev.od : kp
      const kon = koniecOkresu(kp, q.grupuj)
      porownanie = { od, do: kon > prev.do ? prev.do : kon, daneNiepelne: najpozniejszyStart === null || najpozniejszyStart > od, ...miara(okresP.get(kp), okresZP.get(kp) ?? [], kursy) }
    }
    return { okres: k, okresDo: koniecOkresu(k, q.grupuj), niepelny: k < q.od || koniecOkresu(k, q.grupuj) > q.do, ...miara(okresL.get(k), okresZ.get(k) ?? [], kursy), porownanie }
  })

  // konto ze sprzedażą tylko w okresie porównania też dostaje wiersz (kanał, który przestał sprzedawać)
  const wierszeKont: WierszKonta[] = [...new Set([...kontaZakresu, ...kontaLP.keys(), ...kontaZP.keys()])]
    .map((k) => {
      const daneOd = poczatki.get(k) ?? null
      const porownanie: WierszKonta['porownanie'] = prev ? { daneOd, daneNiepelne: daneOd === null || daneOd > prev.od, ...miara(kontaLP.get(k), kontaZP.get(k) ?? [], kursy) } : null
      return { konto: k, nazwa: nazwaKonta(k), ...miara(kontaL.get(k), kontaZ.get(k) ?? [], kursy), porownanie }
    })
    .sort((a, b) => b.wartoscBrutto - a.wartoscBrutto || (b.porownanie?.wartoscBrutto ?? 0) - (a.porownanie?.wartoscBrutto ?? 0) || a.nazwa.localeCompare(b.nazwa, 'pl'))

  const poprzedni: PorownanieRaportu | null = prev
    ? {
        ...prev,
        tryb: trybP,
        dni: dniMiedzy(prev.od, prev.do),
        razem: miara(linP.find((r) => r.zestaw === L_RAZEM), zamP.filter((r) => r.zestaw === Z_RAZEM), kursy),
        poczatekDanych: starty.length ? starty.reduce((x, y) => (y < x ? y : x)) : null,
        kontaBezDanych: kontaDanych
          .filter((k) => {
            const d = poczatki.get(k)
            return d !== undefined && d > prev.od
          })
          .map((k) => ({ konto: k, nazwa: nazwaKonta(k), daneOd: poczatki.get(k)! }))
          .sort((a, b) => a.daneOd.localeCompare(b.daneOd) || a.nazwa.localeCompare(b.nazwa, 'pl')),
        bezDanych: starty.length === 0 || starty.every((d) => d > prev.do),
      }
    : null

  const prodRows = lin.filter((r) => r.zestaw === L_PRODUKT).sort((a, b) => gr(b.brutto) - gr(b.zwrot_brutto) - (gr(a.brutto) - gr(a.zwrot_brutto)) || (a.product ?? '').localeCompare(b.product ?? ''))
  const strona = prodRows.slice(0, q.produktow)
  const ids = strona.map((r) => r.product).filter((x): x is string => !!x)
  const info = new Map((ids.length ? await db.product.findMany({ where: { id: { in: ids } }, select: { id: true, sku: true, title: true, unit: true } }) : []).map((x) => [x.id, x]))
  const prodP = new Map(linP.filter((r) => r.zestaw === L_PRODUKT).map((r) => [r.product, r]))
  const produkty: WierszProduktu[] = strona.map((r) => {
    const pi = r.product ? info.get(r.product) : undefined
    const m = miara(r, [], kursy)
    const jednostka: Unit = pi?.unit ?? 'SZT'
    const rp = prodP.get(r.product)
    const mp = rp ? miara(rp, [], kursy) : null
    const porownanie: WierszProduktu['porownanie'] = prev
      ? mp && rp
        ? { ilosc: jednostka === 'KG' ? Math.round(mp.kg * 1000) : mp.sztuk, brutto: mp.produktyBrutto, netto: mp.produktyNetto, zamowien: Number(rp.zamowien), marza: mp.marza }
        : { ilosc: 0, brutto: 0, netto: 0, zamowien: 0, marza: null }
      : null
    return {
      porownanie,
      sku: pi?.sku ?? null,
      nazwa: pi?.title ?? 'Pozycje bez produktu w katalogu',
      jednostka,
      ilosc: jednostka === 'KG' ? Math.round(m.kg * 1000) : m.sztuk,
      brutto: m.produktyBrutto,
      netto: m.produktyNetto,
      zwrotyBrutto: m.zwrotyBrutto,
      zamowien: Number(r.zamowien),
      koszt: r.koszt === null ? null : m.koszt,
      marza: m.marza,
      marzaProcent: m.marzaProcent,
      // produkt sprzedany tylko w walucie bez kursu nie ma kwot w złotych, więc to nie „brak ceny zakupu”
      brakCenyZakupu: r.koszt === null && r.brutto !== null,
    }
  })
  const pz = sumaWalut(
    poza.map((x) => ({ waluta: x.waluta, grosze: gr(x.brutto), zamowien: Number(x.n) })),
    kursy,
  )
  // część z archiwum z wierszy całości (po jednym na walutę), ta sama suma walut co reszta raportu
  const zr = zam.filter((r) => r.zestaw === Z_RAZEM)
  const czesc = (n: (r: ZamRow) => bigint, b: (r: ZamRow) => string | null) => {
    const s = sumaWalut(
      zr.filter((r) => Number(n(r)) > 0).map((r) => ({ waluta: r.waluta, grosze: gr(b(r)), zamowien: Number(n(r)) })),
      kursy,
    )
    return { zamowien: s.zamowien, brutto: zl(s.grosze), inneWaluty: obceDoApi(s.obce) }
  }
  return {
    od: q.od,
    do: q.do,
    grupuj: q.grupuj,
    konto: q.konto,
    stanNa: now.toISOString(),
    razem: miara(lin.find((r) => r.zestaw === L_RAZEM), zam.filter((r) => r.zestaw === Z_RAZEM), kursy),
    poprzedni,
    okresy: wierszeOkresow,
    konta: wierszeKont,
    produkty,
    produktowRazem: prodRows.length,
    wiecejProduktow: prodRows.length > q.produktow,
    pozaKompletorem: { zamowien: pz.zamowien, brutto: zl(pz.grosze), inneWaluty: obceDoApi(pz.obce) },
    zArchiwum: czesc((r) => r.z_archiwum, (r) => r.z_archiwum_brutto),
    zKanalemOdtworzonym: czesc((r) => r.z_odtworzonym, (r) => r.z_odtworzonym_brutto),
  }
}

/** Wiersz tabeli „Waluty” (Raporty, XLSX): zamówienia jednej waluty w zakresie. */
export interface WierszWaluty {
  waluta: string
  zamowien: number
  /** wartość brutto w walucie zamówień */
  brutto: number
  /** kurs średni NBP (null dla PLN i dla waluty bez kursu) */
  kurs: number | null
  dataKursu: string | null
  /** wartość w złotych (null = brak kursu, poza sumą) */
  bruttoPln: number | null
  /** udział w wartości zamówień w złotych, % z jednym miejscem (null = brak kursu albo suma 0) */
  udzial: number | null
}

/**
 * rozbicie miary na waluty, PLN pierwszy, potem `inneWaluty` po kodzie. Pusta lista, gdy w zakresie jest tylko
 * jedna waluta (tabela się nie pokazuje). Wiersz PLN = reszta: zamówienia i kwota w złotych bez przeliczonych walut.
 */
export function rozbicieWalut(m: Pick<Miary, 'zamowien' | 'wartoscBrutto' | 'inneWaluty'>): WierszWaluty[] {
  if (!m.inneWaluty.length) return []
  const suma = naGrosze(m.wartoscBrutto)
  const plnGrosze = suma - m.inneWaluty.reduce((a, w) => a + (w.bruttoPln === null ? 0 : naGrosze(w.bruttoPln)), 0)
  const plnZam = m.zamowien - m.inneWaluty.reduce((a, w) => a + w.zamowien, 0)
  const udzial = (g: number | null) => (g === null || suma <= 0 ? null : Math.round((g / suma) * 1000) / 10)
  const out: WierszWaluty[] = []
  if (plnZam > 0 || plnGrosze !== 0) out.push({ waluta: 'PLN', zamowien: plnZam, brutto: plnGrosze / 100, kurs: null, dataKursu: null, bruttoPln: plnGrosze / 100, udzial: udzial(plnGrosze) })
  for (const w of m.inneWaluty) out.push({ waluta: w.waluta, zamowien: w.zamowien, brutto: w.brutto, kurs: w.kurs, dataKursu: w.dataKursu, bruttoPln: w.bruttoPln, udzial: udzial(w.bruttoPln === null ? null : naGrosze(w.bruttoPln)) })
  return out
}

/** Zmiana względem poprzedniego okresu w procentach (null = brak bazy do porównania). */
export function zmianaProcent(teraz: number, wczesniej: number): number | null {
  if (!wczesniej) return null
  return Math.round(((teraz - wczesniej) / Math.abs(wczesniej)) * 1000) / 10
}
