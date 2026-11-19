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
//    własnej ceny = suma cen składników; pozycja bez ceny zakupu nie ma marży („brak ceny zakupu”), nigdy marża 100%.
import type { Channel, PrismaClient, Unit } from '@prisma/client'
import { accountKey, accounts } from '@/lib/panel/dane'
import { accountDisplayName } from '@/lib/panel/format'
import { addDays, fromWarsaw, toWarsaw, type IsoDay } from '@/lib/rdzen/kalendarz'
import { ApiInputError } from './odpowiedzi'

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
}

const DZIEN_RE = /^\d{4}-\d{2}-\d{2}$/
const KONTO_RE = /^[A-Z_]{2,20}:[^\s]{1,100}$/

function poprawnyDzien(d: string): boolean {
  if (!DZIEN_RE.test(d)) return false
  const t = new Date(`${d}T00:00:00Z`)
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d
}

export function dniMiedzy(od: IsoDay, doDnia: IsoDay): number {
  return Math.round((Date.parse(`${doDnia}T00:00:00Z`) - Date.parse(`${od}T00:00:00Z`)) / 86_400_000) + 1
}

/** Domyślne grupowanie dla długości zakresu: do 62 dni dzień po dniu, do 190 tygodnie, dalej miesiące. */
export function domyslneGrupowanie(dni: number): Grupowanie {
  return dni <= 62 ? 'dzien' : dni <= 190 ? 'tydzien' : 'miesiac'
}

/** Walidacja zapytania (ekran, eksport, API, MCP): błąd jako ApiInputError z polem. */
export function zapytanieSprzedazy(
  v: { od?: string | null; do?: string | null; grupuj?: string | null; konto?: string | null; produktow?: number | null },
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
  return { od, do: doDnia, grupuj, konto, produktow }
}

const PARAMETRY = new Set(['od', 'do', 'grupuj', 'konto', 'produktow'])

export function parseZapytanieSprzedazy(sp: URLSearchParams, now = new Date()): ZapytanieSprzedazy {
  for (const k of sp.keys()) if (!PARAMETRY.has(k)) throw new ApiInputError(`Nieznany parametr ${k}`, k)
  const p = sp.get('produktow')
  return zapytanieSprzedazy({ od: sp.get('od'), do: sp.get('do'), grupuj: sp.get('grupuj'), konto: sp.get('konto'), produktow: p === null ? null : Number(p) }, now)
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
  zamowien: number
  /** wartość zamówień brutto (z dostawą), jak pulpit */
  wartoscBrutto: number
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
}

export interface WierszKonta extends Miary {
  konto: string
  nazwa: string
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
}

export interface RaportSprzedazy {
  od: IsoDay
  do: IsoDay
  grupuj: Grupowanie
  konto: string | null
  stanNa: string
  razem: Miary
  poprzedni: { od: IsoDay; do: IsoDay; razem: Miary }
  okresy: WierszOkresu[]
  konta: WierszKonta[]
  produkty: WierszProduktu[]
  produktowRazem: number
  wiecejProduktow: boolean
  /** zamówienia z kanału, których Kompletor nie realizuje (sprzed startu, nieprzyjęte): poza raportem, tylko liczba i kwota */
  pozaKompletorem: { zamowien: number; brutto: number }
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
  zamowien: bigint
  brutto: string | null
  anulowanych: bigint
  anulowane_brutto: string | null
}

/**
 * Pozycje okresu zgrupowane w zestawach: okres, konto kanału, produkt, całość. `zestaw` = GROUPING(okres, channel,
 * account, product): 7 = okres (bity kanału, konta, produktu ustawione), 9 = konto (okres i produkt), 14 = produkt, 15 = całość.
 */
async function linie(db: PrismaClient, from: Date, to: Date, trunc: string, konto: string | null): Promise<LiniaRow[]> {
  return db.$queryRaw<LiniaRow[]>`
    WITH o AS (
      SELECT o."id", o."channel", o."channelAccountId", o."parentOrderId",
             to_char(date_trunc(${trunc}, (o."createdAtChannel" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw'), 'YYYY-MM-DD') AS okres
      FROM "Order" o
      WHERE o."createdAtChannel" >= ${from} AND o."createdAtChannel" < ${to} AND o."status" <> 'ANULOWANE'
        AND (${konto}::text IS NULL OR (o."channel"::text || ':' || o."channelAccountId") = ${konto}::text)
    ), l AS (
      SELECT o.okres, o."channel"::text AS channel, o."channelAccountId" AS account, l."productId" AS product,
             coalesce(o."parentOrderId", o."id") AS zam, p."unit" AS unit,
             (l."qty" - l."qtyRejected")::numeric AS q,
             -- wartość pozycji jak wartoscCzesciGr (lib/rdzen/zamiana.ts): grosze, mnożenie przed dzieleniem,
             -- zaokrąglenie na pozycji (floor(x + 0,5) = Math.round), część rodziny zamian = przyrost wartości rodziny od
             -- przesunięcia (jednostki części wcześniejszych: najpierw pozycja pierwotna, potem zamienniki wg numerów zamian)
             round(l."unitPriceGross" * 100) AS cena_gr,
             CASE WHEN co."qtyBasePerOffer" > 0 THEN co."qtyBasePerOffer" ELSE 1 END AS n,
             coalesce(sum(greatest(0, l."qty" - l."qtyRejected")) OVER (
               PARTITION BY coalesce(lp."id", l."id")
               ORDER BY (lp."id" IS NOT NULL), ARRAY(SELECT m[1]::bigint FROM regexp_matches(l."externalLineId", '#zamiana-([0-9]+)', 'g') AS m), l."externalLineId" COLLATE "C"
               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS przes,
             -- stawka pozycji, potem produktu: liczba („23”, „8.00”, „5 %”), kody bez VAT („zw”, „np”, „np I”, „oo”, „0 WDT”) = 0,
             -- brak stawki = 23; inny tekst (błąd danych) = stawka produktu albo 23 i licznik „nieznana_stawka”
             -- (wcześniej każdy nieznany tekst liczył się cicho jako 0 %, czyli netto = brutto)
             CASE WHEN coalesce(l."vatRate", p."vatRate") IS NULL THEN 23
                  WHEN btrim(coalesce(l."vatRate", p."vatRate")) ~ '^[0-9]+([.,][0-9]+)? ?%?$' THEN replace(replace(replace(btrim(coalesce(l."vatRate", p."vatRate")), ',', '.'), '%', ''), ' ', '')::numeric
                  WHEN lower(btrim(coalesce(l."vatRate", p."vatRate"))) ~ '^((zw|np|oo)([ .]|$)|0 [a-z])' THEN 0
                  WHEN btrim(p."vatRate") ~ '^[0-9]+([.,][0-9]+)? ?%?$' THEN replace(replace(replace(btrim(p."vatRate"), ',', '.'), '%', ''), ' ', '')::numeric
                  WHEN lower(btrim(p."vatRate")) ~ '^((zw|np|oo)([ .]|$)|0 [a-z])' THEN 0
                  ELSE 23 END AS vat,
             (coalesce(l."vatRate", p."vatRate") IS NOT NULL AND btrim(coalesce(l."vatRate", p."vatRate")) !~ '^[0-9]+([.,][0-9]+)? ?%?$'
               AND lower(btrim(coalesce(l."vatRate", p."vatRate"))) !~ '^((zw|np|oo)([ .]|$)|0 [a-z])') AS nieznana,
             coalesce(p."purchasePriceNet" / CASE WHEN p."unit" = 'KG' THEN 1000 ELSE 1 END, z.k) AS kj,
             coalesce(r.ret, 0) AS ret
      FROM "OrderLine" l
      JOIN o ON o."id" = l."orderId"
      LEFT JOIN "Product" p ON p."id" = l."productId"
      -- zamiennik („Zamień produkt”, pozycja z „#zamiana-” w nazwie) nie ma oferty; cena jest za sztukę oferty
      -- pozycji pierwotnej, więc przelicznik bierzemy z jej oferty. Warunki jak przelicznikiPozycji
      -- (lib/rdzen/zamiana.ts): pozycja pierwotna (lp) i źródło zamiany (ls) w zamówieniu i nieusunięte, inaczej przelicznik 1
      -- (dokument staje wtedy z błędem zamiany); rodzina zamian = pozycja pierwotna nieusunięta + jej zamienniki
      LEFT JOIN "OrderLine" lp
        ON strpos(l."externalLineId", '#zamiana-') > 0 AND lp."orderId" = l."orderId"
       AND lp."externalLineId" = split_part(l."externalLineId", '#zamiana-', 1) AND NOT lp."removed"
      LEFT JOIN "OrderLine" ls
        ON l."externalLineId" ~ '#zamiana-[0-9]+$' AND ls."orderId" = l."orderId"
       AND ls."externalLineId" = regexp_replace(l."externalLineId", '#zamiana-[0-9]+$', '') AND NOT ls."removed"
      LEFT JOIN "ChannelOffer" co
        ON co."organizationId" = l."organizationId" AND co."channel"::text = o."channel"::text AND co."channelAccountId" = o."channelAccountId"
       AND co."externalId" = CASE WHEN strpos(l."externalLineId", '#zamiana-') = 0 THEN CASE WHEN l."productId" IS NOT NULL THEN l."offerId" END
                                  WHEN ls."id" IS NOT NULL AND lp."productId" IS NOT NULL THEN lp."offerId" END
      LEFT JOIN LATERAL (
        SELECT CASE WHEN bool_and(c."purchasePriceNet" IS NOT NULL) THEN sum(bc."qtyBase" * c."purchasePriceNet" / CASE WHEN c."unit" = 'KG' THEN 1000 ELSE 1 END) END AS k,
               count(*) AS n
        FROM "BundleComponent" bc JOIN "Product" c ON c."id" = bc."componentId"
        WHERE bc."bundleId" = p."id"
      ) z ON p."kind" = 'BUNDLE'
      -- zwrócone jednostki pozycji: produkt wprost; zestaw z ruchów składników (zwrot pozycji zestawu zapisuje składniki):
      -- każdy składnik waży 1/(liczba składników) zestawu, więc zwrot całego zestawu = 1, jednego z dwóch składników = 0,5
      LEFT JOIN LATERAL (
        SELECT sum(CASE WHEN p."kind" = 'BUNDLE' THEN rl."qty"::numeric / (nullif(bc."qtyBase", 0) * z.n) ELSE rl."qty" END) AS ret
        FROM "ReturnLine" rl JOIN "Return" rt ON rt."id" = rl."returnId"
        LEFT JOIN "BundleComponent" bc ON p."kind" = 'BUNDLE' AND bc."bundleId" = p."id" AND bc."componentId" = rl."productId"
        WHERE rl."orderLineId" = l."id" AND rt."status" <> 'ODRZUCONY'
      ) r ON true
      WHERE NOT l."removed" AND l."qty" - l."qtyRejected" > 0
    ), lb AS (
      SELECT l.*, (floor((l.przes + l.q) * l.cena_gr / l.n + 0.5) - floor(l.przes * l.cena_gr / l.n + 0.5)) / 100 AS brutto FROM l
    ), w AS (
      SELECT lb.*, least(1, lb.ret / lb.q) AS frac, lb.brutto / (1 + lb.vat / 100) AS netto FROM lb
    )
    SELECT (GROUPING(okres, channel, account, product))::int AS zestaw, okres, channel, account, product,
           sum(brutto)::text AS brutto, sum(netto)::text AS netto,
           sum(brutto * frac)::text AS zwrot_brutto, sum(netto * frac)::text AS zwrot_netto,
           sum(q * (1 - frac)) FILTER (WHERE unit IS DISTINCT FROM 'KG')::text AS szt,
           sum(q * (1 - frac)) FILTER (WHERE unit = 'KG')::text AS gram,
           sum(q * kj) FILTER (WHERE kj IS NOT NULL)::text AS koszt,
           sum(netto) FILTER (WHERE kj IS NOT NULL)::text AS netto_z_kosztem,
           sum(netto * frac) FILTER (WHERE kj IS NOT NULL)::text AS zwrot_netto_z_kosztem,
           sum(q * kj * frac) FILTER (WHERE kj IS NOT NULL)::text AS zwrot_koszt,
           count(*) FILTER (WHERE nieznana) AS nieznana_stawka,
           count(DISTINCT zam) AS zamowien
    FROM w
    GROUP BY GROUPING SETS ((okres), (channel, account), (product), ())`
}

/** Zamówienia okresu (bez podzamówień) w zestawach: okres, konto, całość; `zestaw` = GROUPING(okres, channel, account), stałe Z_* niżej. */
async function zamowienia(db: PrismaClient, from: Date, to: Date, trunc: string, konto: string | null): Promise<ZamRow[]> {
  return db.$queryRaw<ZamRow[]>`
    SELECT (GROUPING(okres, channel, account))::int AS zestaw, okres, channel, account,
           count(*) FILTER (WHERE NOT anul) AS zamowien, (sum(brutto) FILTER (WHERE NOT anul))::text AS brutto,
           count(*) FILTER (WHERE anul) AS anulowanych, (sum(brutto) FILTER (WHERE anul))::text AS anulowane_brutto
    FROM (
      SELECT to_char(date_trunc(${trunc}, (o."createdAtChannel" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw'), 'YYYY-MM-DD') AS okres,
             o."channel"::text AS channel, o."channelAccountId" AS account, o."totalGross" AS brutto, o."status" = 'ANULOWANE' AS anul
      FROM "Order" o
      WHERE o."createdAtChannel" >= ${from} AND o."createdAtChannel" < ${to} AND o."parentOrderId" IS NULL
        AND (${konto}::text IS NULL OR (o."channel"::text || ':' || o."channelAccountId") = ${konto}::text)
    ) s
    GROUP BY GROUPING SETS ((okres), (channel, account), ())`
}

/** Kopie zamówień z kanału bez zamówienia w Kompletorze (jak `salesRows` pulpitu, bez anulowanych i szkiców). */
async function pozaKompletorem(db: PrismaClient, from: Date, to: Date, konto: string | null): Promise<{ n: bigint; brutto: string | null }[]> {
  return db.$queryRaw<{ n: bigint; brutto: string | null }[]>`
    SELECT count(*) AS n, sum(c."totalGross")::text AS brutto
    FROM "ChannelOrderSnapshot" c
    WHERE c."createdAtChannel" >= ${from} AND c."createdAtChannel" < ${to} AND c."lifecycle" NOT IN ('DRAFT', 'CANCELLED')
      AND (${konto}::text IS NULL OR (c."channel"::text || ':' || c."channelAccountId") = ${konto}::text)
      AND NOT EXISTS (
        SELECT 1 FROM "Order" x
        WHERE x."organizationId" = c."organizationId" AND x."channel" = c."channel" AND x."channelAccountId" = c."channelAccountId" AND x."externalId" = c."externalId"
      )`
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
  return { zamowien: 0, wartoscBrutto: 0, sredniaWartosc: null, produktyBrutto: 0, produktyNetto: 0, sztuk: 0, kg: 0, zwrotyBrutto: 0, koszt: 0, marza: null, marzaProcent: null, bezCenyZakupuNetto: 0, nieznanaStawkaPozycji: 0, anulowanych: 0, anulowaneBrutto: 0 }
}

function miara(l: LiniaRow | undefined, z: ZamRow | undefined): Miary {
  const m = pustaMiara()
  if (z) {
    m.zamowien = Number(z.zamowien)
    m.wartoscBrutto = zl(gr(z.brutto))
    m.sredniaWartosc = m.zamowien ? Math.round(gr(z.brutto) / m.zamowien) / 100 : null
    m.anulowanych = Number(z.anulowanych)
    m.anulowaneBrutto = zl(gr(z.anulowane_brutto))
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

function zakresUtc(od: IsoDay, doDnia: IsoDay): { from: Date; to: Date } {
  return { from: fromWarsaw(od, 0), to: fromWarsaw(addDays(doDnia, 1), 0) }
}

/** Raport sprzedaży: zakres, porównanie z poprzednim okresem tej samej długości, okresy, konta i produkty. */
export async function raportSprzedazy(db: PrismaClient, q: ZapytanieSprzedazy, now = new Date()): Promise<RaportSprzedazy> {
  const trunc = TRUNC[q.grupuj]
  const { from, to } = zakresUtc(q.od, q.do)
  const prev = poprzedniZakres(q.od, q.do)
  const p = zakresUtc(prev.od, prev.do)
  const [lin, zam, poza, linP, zamP, accs] = await Promise.all([
    linie(db, from, to, trunc, q.konto),
    zamowienia(db, from, to, trunc, q.konto),
    pozaKompletorem(db, from, to, q.konto),
    linie(db, p.from, p.to, trunc, q.konto),
    zamowienia(db, p.from, p.to, trunc, q.konto),
    accounts(db),
  ])
  const kluczKonta = (r: { channel: string | null; account: string | null }) => accountKey(r.channel as Channel, r.account ?? '')
  const okresyLista = okresy(q.od, q.do, q.grupuj)
  const okresL = new Map(lin.filter((r) => r.zestaw === L_OKRES).map((r) => [r.okres!, r]))
  const okresZ = new Map(zam.filter((r) => r.zestaw === Z_OKRES).map((r) => [r.okres!, r]))
  const wierszeOkresow: WierszOkresu[] = okresyLista.map((k) => ({ okres: k, okresDo: koniecOkresu(k, q.grupuj), niepelny: k < q.od || koniecOkresu(k, q.grupuj) > q.do, ...miara(okresL.get(k), okresZ.get(k)) }))

  const kontaL = new Map(lin.filter((r) => r.zestaw === L_KONTO).map((r) => [kluczKonta(r), r]))
  const kontaZ = new Map(zam.filter((r) => r.zestaw === Z_KONTO).map((r) => [kluczKonta(r), r]))
  const nazwy = new Map(accs.map((a) => [accountKey(a.channel, a.channelAccountId), a.name]))
  const wierszeKont: WierszKonta[] = [...new Set([...kontaL.keys(), ...kontaZ.keys()])]
    .map((k) => {
      const [ch, ...rest] = k.split(':')
      return { konto: k, nazwa: nazwy.get(k) ?? accountDisplayName(ch as Channel, rest.join(':')), ...miara(kontaL.get(k), kontaZ.get(k)) }
    })
    .sort((a, b) => b.wartoscBrutto - a.wartoscBrutto || a.nazwa.localeCompare(b.nazwa, 'pl'))

  const prodRows = lin.filter((r) => r.zestaw === L_PRODUKT).sort((a, b) => gr(b.brutto) - gr(b.zwrot_brutto) - (gr(a.brutto) - gr(a.zwrot_brutto)) || (a.product ?? '').localeCompare(b.product ?? ''))
  const strona = prodRows.slice(0, q.produktow)
  const ids = strona.map((r) => r.product).filter((x): x is string => !!x)
  const info = new Map((ids.length ? await db.product.findMany({ where: { id: { in: ids } }, select: { id: true, sku: true, title: true, unit: true } }) : []).map((x) => [x.id, x]))
  const produkty: WierszProduktu[] = strona.map((r) => {
    const pi = r.product ? info.get(r.product) : undefined
    const m = miara(r, undefined)
    const jednostka: Unit = pi?.unit ?? 'SZT'
    return {
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
      brakCenyZakupu: r.koszt === null,
    }
  })
  const pz = poza[0]
  return {
    od: q.od,
    do: q.do,
    grupuj: q.grupuj,
    konto: q.konto,
    stanNa: now.toISOString(),
    razem: miara(lin.find((r) => r.zestaw === L_RAZEM), zam.find((r) => r.zestaw === Z_RAZEM)),
    poprzedni: { ...prev, razem: miara(linP.find((r) => r.zestaw === L_RAZEM), zamP.find((r) => r.zestaw === Z_RAZEM)) },
    okresy: wierszeOkresow,
    konta: wierszeKont,
    produkty,
    produktowRazem: prodRows.length,
    wiecejProduktow: prodRows.length > q.produktow,
    pozaKompletorem: { zamowien: Number(pz?.n ?? 0), brutto: zl(gr(pz?.brutto)) },
  }
}

/** Zmiana względem poprzedniego okresu w procentach (null = brak bazy do porównania). */
export function zmianaProcent(teraz: number, wczesniej: number): number | null {
  if (!wczesniej) return null
  return Math.round(((teraz - wczesniej) / Math.abs(wczesniej)) * 1000) / 10
}
