// Rejestr narzędzi MCP Kompletora: jedno źródło dla serwera /api/mcp i przyszłego asystenta w panelu.
// Każde narzędzie: nazwa (snake_case po polsku, bez znaków diakrytycznych — część klientów MCP ich nie
// przyjmuje), opis dla modelu (kiedy użyć + przykładowe pytanie), schemat wejścia i wyjścia (JSON Schema, sprawdzany
// przez lib/mcp/schemat.ts), wymagany zakres, adnotacje i `run(ctx, args)`.
//
// `run` woła te same funkcje co API v1 (lib/api/*), nie trasy HTTP. Firma zawsze z `ctx.db` (RLS), nigdy z argumentów.
// DANE OSOBOWE: wyniki wyłącznie z jawnych list pól (ORDER_FIELDS, PRODUCT_FIELDS, …) — bez imion, adresów, telefonów,
// e-maili, NIP-u i treści wiadomości (test: tests/mcp.integration.test.ts, „brak danych osobowych”). Wszystkie
// narzędzia tylko czytają; zapis (część B: przesyłki, faktury) to osobne zadanie — kontrakt w docs/mcp.md.
import type { Channel } from '@prisma/client'
import { ApiInputError } from '@/lib/api/odpowiedzi'
import { PRODUCT_KINDS, productBySku, productSearchQuery, searchProducts } from '@/lib/api/produkty'
import { dayReport, reportQuery, reservationsReport, shortagesReport } from '@/lib/api/raporty'
import { raportSprzedazy, zapytanieSprzedazy } from '@/lib/api/raporty-sprzedaz'
import { TRYBY_POROWNANIA } from '@/lib/api/raporty-porownanie'
import { readStock } from '@/lib/api/stany'
import { statusDictionaryFirmy } from '@/lib/api/statusy'
import { automatyFirmy } from '@/lib/api/automaty'
import { CHANNELS, changedFromOf, decodeCursor, listChangedOrders, ordersByNumber, ORDER_STATUSES, parseOrderListFilter, PAYMENT_STATES, RODZAJE_PRZESYLKI_API } from '@/lib/api/zamowienia'
import type { McpScope } from '@/lib/api/zakresy'
import { STANY_DROGI } from '@/lib/wysylka/stany-przesylki'
import type { McpContext } from './kontekst'
import type { JsonSchema } from './schemat'

export interface ToolAnnotations {
  title: string
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: false
}

export interface ToolRunResult {
  data: Record<string, unknown>
  /** Liczba pozycji w wyniku (do dziennika). */
  items: number
}

export interface McpTool {
  name: string
  title: string
  description: string
  inputSchema: JsonSchema & { type: 'object' }
  outputSchema: JsonSchema & { type: 'object' }
  scope: McpScope
  /** Cięższe narzędzie (raport): dzienny limit wywołań na klucz. */
  heavy?: boolean
  /** Argument z liczbą pozycji: przy za dużym wyniku serwer powtarza wywołanie z mniejszą wartością. */
  limitArg?: string
  annotations: ToolAnnotations
  run(ctx: McpContext, args: Record<string, unknown>): Promise<ToolRunResult>
}

/** Najwięcej znaków wyniku (JSON) w jednej odpowiedzi narzędzia — okno kontekstu modelu nie jest z gumy. */
export const MAX_RESULT_CHARS = 40_000
export const MCP_MAX_SKUS = 50
export const MCP_MAX_ORDERS = 50
export const MCP_DEFAULT_ORDERS = 20
export const MCP_MAX_PRODUCTS = 50

const READ: Omit<ToolAnnotations, 'title'> = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }

// ─── Kawałki schematów ────────────────────────────────────────────────────────

const str = (description: string, maxLength = 100): JsonSchema => ({ type: 'string', description, minLength: 1, maxLength })
const DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}(T[\\d:.]+(Z|[+-]\\d{2}:?\\d{2})?)?$'
const date = (description: string): JsonSchema => ({ type: 'string', description, pattern: DATE_PATTERN, maxLength: 40 })
const nullable = (s: JsonSchema): JsonSchema => ({ ...s, type: [s.type as 'string', 'null'] })
// opis z tej samej listy co `enum` (CHANNELS z DEFAULT_CHANNEL_ADAPTER), żeby nowy kanał nie wypadał z opisu
const KANAL_OPIS: Partial<Record<string, string>> = { WOO: 'WOO (sklep WooCommerce)', BL_INNE: 'BL_INNE (inne przez BaseLinker)', RECZNE: 'RECZNE (wpisane w panelu)' }
const KANAL: JsonSchema = { type: 'string', enum: CHANNELS, description: `Kanał sprzedaży: ${CHANNELS.map((c) => KANAL_OPIS[c] ?? c).join(', ')}.` }
const SKU_LIST: JsonSchema = { type: 'array', items: str('SKU produktu, np. TEST-PRZYPRAWA'), minItems: 1, maxItems: MCP_MAX_SKUS, description: `Lista SKU (najwyżej ${MCP_MAX_SKUS}).` }
const CURSOR: JsonSchema = { type: 'string', minLength: 1, maxLength: 300, description: 'Wartość `nastepny` z poprzedniej odpowiedzi, żeby pobrać następną stronę.' }

const ORDER_LINE_OUT: JsonSchema = {
  type: 'object',
  properties: { sku: nullable({ type: 'string' }), nazwa: nullable({ type: 'string' }), ilosc: { type: 'integer' }, cenaBrutto: { type: 'number' } },
  required: ['sku', 'nazwa', 'ilosc', 'cenaBrutto'],
  additionalProperties: false,
}
const SHIPMENT_OUT: JsonSchema = {
  type: 'object',
  properties: {
    przewoznik: { type: 'string' },
    numerNadania: nullable({ type: 'string' }),
    stan: nullable({ type: 'string', enum: [...STANY_DROGI, null], description: 'Stan drogi paczki u przewoźnika (np. W_DRODZE, DORECZONA); null = brak odczytu.' }),
    stanNazwa: nullable({ type: 'string' }),
    stanOd: nullable({ type: 'string' }),
    sprawdzono: nullable({ type: 'string' }),
    sledzona: { type: 'boolean', description: 'Kompletor dalej odświeża stan tej paczki; false = stan może być nieaktualny.' },
    linkSledzenia: nullable({ type: 'string', description: 'Strona śledzenia u przewoźnika; null = podaj sam numer nadania.' }),
    rodzaj: { type: 'string', enum: [...RODZAJE_PRZESYLKI_API], description: 'GLOWNA = przesyłka zamówienia; DOSYLKA, ZASTEPCZA, DODATKOWA = dodatkowa paczka do tego samego zamówienia.' },
  },
  required: ['przewoznik', 'numerNadania', 'stan', 'stanNazwa', 'stanOd', 'sprawdzono', 'sledzona', 'linkSledzenia', 'rodzaj'],
  additionalProperties: false,
}
const ORDER_OUT: JsonSchema = {
  type: 'object',
  properties: {
    kanal: { type: 'string' },
    konto: { type: 'string' },
    numer: { type: 'string', description: 'Numer zamówienia w kanale (sklepie).' },
    numerBl: nullable({ type: 'integer' }),
    status: { type: 'string', enum: ORDER_STATUSES },
    statusNazwa: { type: 'string' },
    przewoznik: nullable({ type: 'string' }),
    sposobDostawy: nullable({ type: 'string' }),
    platnosc: { type: 'string', enum: PAYMENT_STATES },
    platnoscMetoda: { type: 'string' },
    sumaBrutto: { type: 'number' },
    zlozono: { type: 'string' },
    zmieniono: { type: 'string' },
    numerNadania: nullable({ type: 'string' }),
    przesylkaStatus: nullable({ type: 'string' }),
    przesylkaStatusKod: nullable({ type: 'string' }),
    przesylkaStatusKiedy: nullable({ type: 'string' }),
    pozycje: { type: 'array', items: ORDER_LINE_OUT },
    przesylki: { type: 'array', items: SHIPMENT_OUT, description: 'Przesyłki zamówienia: numer, stan drogi paczki i link śledzenia.' },
  },
  required: ['kanal', 'konto', 'numer', 'status', 'platnosc', 'sumaBrutto', 'zlozono', 'pozycje'],
  additionalProperties: false,
}
const OFFER_OUT: JsonSchema = {
  type: 'object',
  properties: { kanal: { type: 'string' }, konto: { type: 'string' }, externalId: { type: 'string' }, sztukNaOferte: { type: 'integer' }, aktywna: { type: 'boolean' } },
  required: ['kanal', 'konto', 'externalId', 'sztukNaOferte'],
}
const STOCK_ITEM_OUT: JsonSchema = {
  type: 'object',
  properties: {
    sku: { type: 'string' },
    nazwa: { type: 'string' },
    rodzaj: { type: 'string', enum: PRODUCT_KINDS },
    jednostka: { type: 'string', enum: ['SZT', 'KG'] },
    oferty: { type: 'array', items: OFFER_OUT },
    bezStanu: { type: 'boolean' },
    fizycznie: nullable({ type: 'integer' }),
    zarezerwowane: nullable({ type: 'integer' }),
    dostepne: { type: 'integer' },
  },
  required: ['sku', 'nazwa', 'rodzaj', 'jednostka', 'oferty'],
}
const PRODUCT_OUT: JsonSchema = {
  type: 'object',
  properties: { sku: { type: 'string' }, nazwa: { type: 'string' }, rodzaj: { type: 'string', enum: PRODUCT_KINDS }, jednostka: { type: 'string', enum: ['SZT', 'KG'] }, ean: nullable({ type: 'string' }), aktywny: { type: 'boolean' }, kategoria: nullable({ type: 'object', properties: { id: { type: 'string' }, sciezka: { type: 'string' } }, required: ['id', 'sciezka'] }) },
  required: ['sku', 'nazwa', 'rodzaj', 'jednostka', 'ean', 'aktywny', 'kategoria'],
}
const PART_OUT: JsonSchema = { type: 'object', properties: { sku: { type: 'string' }, nazwa: { type: 'string' }, ilosc: { type: 'integer' } }, required: ['sku', 'nazwa', 'ilosc'] }
const ORDER_REF_OUT: JsonSchema = {
  type: 'object',
  properties: { kanal: { type: 'string' }, konto: { type: 'string' }, numer: { type: 'string' }, numerBl: nullable({ type: 'integer' }), status: { type: 'string', enum: ORDER_STATUSES }, platnosc: { type: 'string', enum: PAYMENT_STATES }, ilosc: { type: 'integer' }, od: { type: 'string' } },
  required: ['kanal', 'konto', 'numer', 'status'],
}

// ─── Pomocnicze ───────────────────────────────────────────────────────────────

const optStr = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const optInt = (v: unknown): number | null => (typeof v === 'number' ? v : null)
const optList = (v: unknown): string[] | null => (Array.isArray(v) ? (v as string[]) : null)

// ─── Narzędzia ────────────────────────────────────────────────────────────────

const zamowieniaLista: McpTool = {
  name: 'zamowienia_lista',
  title: 'Lista zamówień',
  description: [
    'Lista zamówień firmy zmienionych w ostatnich 14 dniach, z filtrami po statusie, płatności, kanale i dacie złożenia.',
    'Użyj, gdy użytkownik pyta o grupę zamówień, np. „pokaż nieopłacone zamówienia z wczoraj” (platnosc: ["UNPAID"], zlozone_od i zlozone_do = granice wczorajszego dnia w czasie polskim, np. 2026-11-02T00:00:00+01:00).',
    'Kolejność: od najdawniej zmienionego. Gdy `nastepny` nie jest pusty, wywołaj ponownie z kursor = nastepny i tymi samymi filtrami.',
    'Wynik nie zawiera danych klientów (imion, adresów, telefonów, e-maili) — Kompletor ich agentom nie podaje.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'array', items: { type: 'string', enum: ORDER_STATUSES }, minItems: 1, maxItems: ORDER_STATUSES.length, description: 'Statusy zamówień (słownik: narzędzie statusy).' },
      platnosc: { type: 'array', items: { type: 'string', enum: PAYMENT_STATES }, minItems: 1, maxItems: PAYMENT_STATES.length, description: 'PAID opłacone, UNPAID nieopłacone, COD pobranie, PARTIAL niedopłata.' },
      kanal: KANAL,
      konto: str('Id konta kanału (np. sklepu), jak w polu `konto` wyników.'),
      zlozone_od: date('Złożone od (włącznie), ISO 8601.'),
      zlozone_do: date('Złożone przed (bez tej chwili), ISO 8601.'),
      zmienione_od: date('Zmienione od, ISO 8601; najwyżej 14 dni wstecz (domyślnie 14 dni).'),
      limit: { type: 'integer', minimum: 1, maximum: MCP_MAX_ORDERS, description: `Ile zamówień na stronę (domyślnie ${MCP_DEFAULT_ORDERS}).` },
      kursor: CURSOR,
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: { zamowienia: { type: 'array', items: ORDER_OUT }, nastepny: nullable({ type: 'string' }) },
    required: ['zamowienia', 'nastepny'],
  },
  scope: 'mcp:odczyt',
  limitArg: 'limit',
  annotations: { title: 'Lista zamówień', ...READ },
  async run(ctx, a) {
    const filter = parseOrderListFilter({ status: optList(a.status), platnosc: optList(a.platnosc), kanal: optStr(a.kanal), konto: optStr(a.konto), zlozone_od: optStr(a.zlozone_od), zlozone_do: optStr(a.zlozone_do) })
    const kursor = optStr(a.kursor)
    const after = kursor === null ? null : decodeCursor(kursor)
    if (kursor !== null && !after) throw new ApiInputError('kursor: zła wartość (użyj pola nastepny z poprzedniej odpowiedzi)', 'kursor')
    const r = await listChangedOrders(ctx.db, { ...filter, changedFrom: changedFromOf(optStr(a.zmienione_od), ctx.now()), limit: optInt(a.limit) ?? MCP_DEFAULT_ORDERS, after })
    return { data: r, items: r.zamowienia.length }
  },
}

const zamowienieSzczegoly: McpTool = {
  name: 'zamowienie_szczegoly',
  title: 'Szczegóły zamówienia',
  description: [
    'Jedno zamówienie po numerze ze sklepu (kanału) albo numerze BaseLinkera: status, płatność, sposób dostawy, przewoźnik, numer nadania, pozycje (SKU, nazwa, ilość, cena) i przesyłki (stan drogi paczki, od kiedy, link śledzenia).',
    'Użyj, gdy użytkownik podaje numer, np. „co z zamówieniem 1234?”, „czy TEST-0001 już wysłane?” albo „gdzie jest moja paczka?”. Aktualny stan paczki bierz stąd, nie z listy zmienionych zamówień.',
    'Ten sam numer w kilku kontach = kilka trafień; zawęź kanałem i kontem. Brak trafień = pusta lista.',
    'Bez danych klientów.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: { numer: str('Numer zamówienia ze sklepu albo numer BL.'), kanal: KANAL, konto: str('Id konta kanału.') },
    required: ['numer'],
    additionalProperties: false,
  },
  outputSchema: { type: 'object', properties: { zamowienia: { type: 'array', items: ORDER_OUT } }, required: ['zamowienia'] },
  scope: 'mcp:odczyt',
  annotations: { title: 'Szczegóły zamówienia', ...READ },
  async run(ctx, a) {
    const numer = String(a.numer).trim()
    if (!numer) throw new ApiInputError('numer: podaj numer zamówienia', 'numer')
    const found = await ordersByNumber(ctx.db, { numer, channel: (optStr(a.kanal) as Channel | null) ?? undefined, channelAccountId: optStr(a.konto) ?? undefined })
    return { data: { zamowienia: found }, items: found.length }
  },
}

const stany: McpTool = {
  name: 'stany',
  title: 'Stany magazynowe',
  description: [
    'Stan produktów: fizycznie w magazynie, zarezerwowane przez zamówienia i dostępne do sprzedaży. Zestaw ma dostępne liczone ze składników; e-book i usługa (bezStanu) nie mają liczb.',
    'Podaj `sku` (lista) albo `kanal` z `konto` (produkty z aktywną ofertą tego konta, stronami po 200).',
    'Użyj przy pytaniach typu „ile zostało TEST-PRZYPRAWA?” albo „czego mało w sklepie?”.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: { sku: SKU_LIST, kanal: KANAL, konto: str('Id konta kanału (z kanal).'), strona: { type: 'integer', minimum: 1, maximum: 100000, description: 'Numer strony przy kanal + konto (od 1).' } },
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: { pozycje: { type: 'array', items: STOCK_ITEM_OUT }, nieznaneSku: { type: 'array', items: { type: 'string' } }, strona: { type: 'integer' }, nastepnaStrona: nullable({ type: 'integer' }) },
    required: ['pozycje'],
  },
  scope: 'mcp:odczyt',
  annotations: { title: 'Stany magazynowe', ...READ },
  async run(ctx, a) {
    const skus = optList(a.sku)
    const kanal = optStr(a.kanal)
    const konto = optStr(a.konto)
    if (skus && (kanal || konto)) throw new ApiInputError('Podaj albo sku, albo kanal i konto')
    if (!skus && (!kanal || !konto)) throw new ApiInputError('Podaj sku (lista SKU) albo kanal i konto')
    if (skus && a.strona !== undefined) throw new ApiInputError('strona tylko z kanal i konto', 'strona')
    const r = skus
      ? await readStock(ctx.db, { skus: [...new Set(skus.map((s) => s.trim()).filter(Boolean))], page: 1 })
      : await readStock(ctx.db, { channel: kanal as Channel, channelAccountId: konto!, page: optInt(a.strona) ?? 1 })
    return { data: r as unknown as Record<string, unknown>, items: r.pozycje.length }
  },
}

const produktySzukaj: McpTool = {
  name: 'produkty_szukaj',
  title: 'Szukaj produktów',
  description: [
    'Szuka produktów w katalogu firmy po fragmencie SKU, nazwy albo po pełnym EAN; filtr po rodzaju (STOCKED towar, BUNDLE zestaw, DIGITAL e-book/usługa).',
    'Użyj, gdy użytkownik nie zna dokładnego SKU, np. „jakie mamy przyprawy?”. Potem stany albo produkt_szczegoly po SKU.',
    'Filtr kategoria: id albo ścieżka kategorii (np. „Napoje > Soki”, razem z podkategoriami) albo „brak” (bez kategorii).',
    'Domyślnie tylko aktywne produkty; kolejność po SKU, kursor w polu nastepny.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      fraza: str('Fragment SKU lub nazwy albo EAN.'),
      rodzaj: { type: 'array', items: { type: 'string', enum: PRODUCT_KINDS }, minItems: 1, maxItems: 3, description: 'Rodzaje produktów.' },
      aktywne: { type: 'string', enum: ['tak', 'nie', 'wszystkie'], description: 'Domyślnie tak.' },
      kategoria: str('Id kategorii, ścieżka („Napoje > Soki”) albo „brak”.'),
      limit: { type: 'integer', minimum: 1, maximum: MCP_MAX_PRODUCTS, description: 'Ile produktów na stronę (domyślnie 50).' },
      kursor: CURSOR,
    },
    additionalProperties: false,
  },
  outputSchema: { type: 'object', properties: { produkty: { type: 'array', items: PRODUCT_OUT }, nastepny: nullable({ type: 'string' }) }, required: ['produkty', 'nastepny'] },
  scope: 'mcp:odczyt',
  limitArg: 'limit',
  annotations: { title: 'Szukaj produktów', ...READ },
  async run(ctx, a) {
    const q = productSearchQuery({ fraza: optStr(a.fraza), rodzaj: optList(a.rodzaj), aktywne: optStr(a.aktywne), kategoria: optStr(a.kategoria), limit: optInt(a.limit), po: optStr(a.kursor) }, MCP_MAX_PRODUCTS)
    const r = await searchProducts(ctx.db, q)
    return { data: r, items: r.produkty.length }
  },
}

const produktSzczegoly: McpTool = {
  name: 'produkt_szczegoly',
  title: 'Szczegóły produktu',
  description: [
    'Jeden produkt po dokładnym SKU: rodzaj, jednostka, EAN, cena detaliczna brutto, próg niskiego stanu, stan, oferty na kanałach (także wyłączone), składniki zestawu i zestawy, w których jest.',
    'Użyj, gdy użytkownik pyta o konkretny produkt, np. „z czego składa się TEST-ZESTAW?” albo „gdzie wystawiamy TEST-PRZYPRAWA?”. Brak produktu = produkt: null.',
  ].join(' '),
  inputSchema: { type: 'object', properties: { sku: str('Dokładne SKU produktu.') }, required: ['sku'], additionalProperties: false },
  outputSchema: {
    type: 'object',
    properties: {
      produkt: nullable({
        type: 'object',
        properties: {
          ...PRODUCT_OUT.properties,
          cenaBrutto: nullable({ type: 'number' }),
          progNiskiegoStanu: nullable({ type: 'integer' }),
          stan: { type: 'object', properties: { bezStanu: { type: 'boolean' }, fizycznie: nullable({ type: 'integer' }), zarezerwowane: nullable({ type: 'integer' }), dostepne: { type: 'integer' } } },
          oferty: { type: 'array', items: OFFER_OUT },
          skladniki: { type: 'array', items: PART_OUT },
          wZestawach: { type: 'array', items: PART_OUT },
        },
        required: ['sku', 'nazwa', 'rodzaj', 'stan', 'oferty', 'skladniki', 'wZestawach'],
      }),
    },
    required: ['produkt'],
  },
  scope: 'mcp:odczyt',
  annotations: { title: 'Szczegóły produktu', ...READ },
  async run(ctx, a) {
    const p = await productBySku(ctx.db, String(a.sku).trim())
    return { data: { produkt: p }, items: p ? 1 : 0 }
  },
}

const statusy: McpTool = {
  name: 'statusy',
  title: 'Słownik statusów',
  description: 'Słownik statusów zamówień i stanów płatności: symbol, nazwa z panelu i krótki opis, a do tego statusy własne firmy (nazwa, kolor, grupa, status bazowy, przewoźnicy). Użyj, żeby wyjaśnić użytkownikowi status (np. „co znaczy DO_WYJASNIENIA?”, „co to jest Zebrane DPD?”) albo dobrać filtr do zamowienia_lista (filtr idzie po statusie bazowym).',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: {
    type: 'object',
    properties: {
      statusy: { type: 'array', items: { type: 'object', properties: { symbol: { type: 'string' }, nazwa: { type: 'string' }, opis: { type: 'string' } }, required: ['symbol', 'nazwa', 'opis'] } },
      platnosci: { type: 'array', items: { type: 'object', properties: { symbol: { type: 'string' }, nazwa: { type: 'string' }, opis: { type: 'string' } }, required: ['symbol', 'nazwa', 'opis'] } },
      statusyFirmy: {
        type: 'array',
        items: {
          type: 'object',
          properties: { klucz: { type: 'string' }, nazwa: { type: 'string' }, nazwaDlaKlienta: { type: ['string', 'null'] }, kolor: { type: 'string' }, kolorHex: { type: 'string' }, grupa: { type: ['string', 'null'] }, bazowy: { type: 'string' }, przewoznicy: { type: 'array', items: { type: 'string' } }, aktywny: { type: 'boolean' } },
          required: ['klucz', 'nazwa', 'bazowy', 'aktywny'],
        },
      },
      grupyStatusow: { type: 'array', items: { type: 'object', properties: { klucz: { type: 'string' }, nazwa: { type: 'string' } }, required: ['klucz', 'nazwa'] } },
    },
    required: ['statusy', 'platnosci'],
  },
  scope: 'mcp:odczyt',
  annotations: { title: 'Słownik statusów', ...READ },
  async run(ctx) {
    const d = await statusDictionaryFirmy(ctx.db)
    return { data: d as unknown as Record<string, unknown>, items: d.statusy.length + d.platnosci.length + d.statusyFirmy.length }
  },
}

const raportDnia: McpTool = {
  name: 'raport_dnia',
  title: 'Raport dnia',
  description: [
    'Liczby dzisiejszego dnia (czas polski) jak pulpit „Dziś” w panelu: sprzedaż (liczba zamówień i kwota brutto, także na konto kanału; kwota brutto w złotych, zamówienia w innej walucie przeliczone po kursie średnim NBP, rozbicie z kursem w inneWaluty), praca do zrobienia (do spakowania, braki, do wyjaśnienia, nieopłacone z rezerwacją, faktury, które się nie wystawiły) i liczba zamówień oznaczonych dziś jako wysłane.',
    'Użyj przy pytaniach „jak idzie dzisiaj?”, „ile mamy do spakowania?”. Same liczby, bez list klientów.',
  ].join(' '),
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: {
    type: 'object',
    properties: {
      dzien: { type: 'string' },
      stanNa: { type: 'string' },
      sprzedaz: { type: 'object' },
      praca: { type: 'object' },
      wyslaneDzis: { type: 'integer' },
    },
    required: ['dzien', 'stanNa', 'sprzedaz', 'praca', 'wyslaneDzis'],
  },
  scope: 'mcp:odczyt',
  heavy: true,
  annotations: { title: 'Raport dnia', ...READ, idempotentHint: false },
  async run(ctx) {
    const r = await dayReport(ctx.db, ctx.now())
    return { data: r as unknown as Record<string, unknown>, items: 1 }
  },
}

const braki: McpTool = {
  name: 'braki',
  title: 'Braki towaru',
  description: [
    'Produkty, których brakuje do zamówień (otwarte braki): ile sztuk brakuje, ile jest dostępne i numery zamówień, które czekają na towar (najwyżej 20 na produkt).',
    'Użyj przy pytaniach „czego brakuje?”, „które zamówienia czekają na TEST-KUBEK?”. Opcjonalnie zawęź listą sku.',
    '`wiecej: true` przy bardzo wielu brakach może znaczyć, że ranking jest niepełny: wtedy zawęź listą sku.',
  ].join(' '),
  inputSchema: { type: 'object', properties: { sku: SKU_LIST, limit: { type: 'integer', minimum: 1, maximum: MCP_MAX_PRODUCTS, description: 'Ile produktów (domyślnie 50).' } }, additionalProperties: false },
  outputSchema: {
    type: 'object',
    properties: {
      pozycje: {
        type: 'array',
        items: {
          type: 'object',
          properties: { sku: { type: 'string' }, nazwa: { type: 'string' }, jednostka: { type: 'string' }, brakuje: { type: 'integer' }, dostepne: { type: 'integer' }, zamowien: { type: 'integer' }, zamowienia: { type: 'array', items: ORDER_REF_OUT } },
          required: ['sku', 'nazwa', 'brakuje', 'zamowien', 'zamowienia'],
        },
      },
      wiecej: { type: 'boolean' },
    },
    required: ['pozycje', 'wiecej'],
  },
  scope: 'mcp:odczyt',
  heavy: true,
  limitArg: 'limit',
  annotations: { title: 'Braki towaru', ...READ },
  async run(ctx, a) {
    const r = await shortagesReport(ctx.db, reportQuery({ sku: optList(a.sku), limit: optInt(a.limit) ?? MCP_MAX_PRODUCTS }))
    return { data: r, items: r.pozycje.length }
  },
}

const rezerwacje: McpTool = {
  name: 'rezerwacje',
  title: 'Rezerwacje',
  description: [
    'Zarezerwowany towar po produkcie: fizycznie, zarezerwowane, dostępne i zamówienia, które trzymają rezerwację (numer, status, płatność, ilość, od kiedy; najwyżej 20 na produkt).',
    'Użyj przy pytaniach „dlaczego TEST-PRZYPRAWA ma 0 dostępne?” albo „kto trzyma rezerwację na TEST-KUBEK?”.',
    '`wiecej: true` przy bardzo wielu rezerwacjach może znaczyć, że ranking jest niepełny: wtedy zawęź listą sku.',
  ].join(' '),
  inputSchema: { type: 'object', properties: { sku: SKU_LIST, limit: { type: 'integer', minimum: 1, maximum: MCP_MAX_PRODUCTS, description: 'Ile produktów (domyślnie 50).' } }, additionalProperties: false },
  outputSchema: {
    type: 'object',
    properties: {
      pozycje: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            sku: { type: 'string' },
            nazwa: { type: 'string' },
            jednostka: { type: 'string' },
            fizycznie: { type: 'integer' },
            zarezerwowane: { type: 'integer' },
            dostepne: { type: 'integer' },
            zamowien: { type: 'integer' },
            zamowienia: { type: 'array', items: ORDER_REF_OUT },
          },
          required: ['sku', 'nazwa', 'zarezerwowane', 'zamowien', 'zamowienia'],
        },
      },
      wiecej: { type: 'boolean' },
    },
    required: ['pozycje', 'wiecej'],
  },
  scope: 'mcp:odczyt',
  heavy: true,
  limitArg: 'limit',
  annotations: { title: 'Rezerwacje', ...READ },
  async run(ctx, a) {
    const r = await reservationsReport(ctx.db, reportQuery({ sku: optList(a.sku), limit: optInt(a.limit) ?? MCP_MAX_PRODUCTS }))
    return { data: r, items: r.pozycje.length }
  },
}

const DZIEN_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$'
const MIARY_OUT: JsonSchema = {
  type: 'object',
  properties: {
    zamowien: { type: 'integer' },
    wartoscBrutto: { type: 'number' },
    produktyBrutto: { type: 'number' },
    produktyNetto: { type: 'number' },
    marza: { type: ['number', 'null'] },
    marzaProcent: { type: ['number', 'null'] },
    bezCenyZakupuNetto: { type: 'number' },
    anulowanych: { type: 'integer' },
  },
  required: ['zamowien', 'wartoscBrutto', 'produktyBrutto', 'produktyNetto', 'marza', 'anulowanych'],
}

// raport sprzedaży (ta sama funkcja co ekran „Raporty” i GET /api/v1/raporty/sprzedaz)
const raportSprzedazyTool: McpTool = {
  name: 'raport_sprzedazy',
  title: 'Raport sprzedaży',
  description: [
    'Sprzedaż w zakresie dat (czas polski, data złożenia zamówienia): liczba zamówień, wartość brutto (kwoty w złotych, inne waluty przeliczone po kursie średnim NBP, rozbicie z kursem w inneWaluty), sprzedaż produktów netto i brutto po zwrotach, sztuki, marża z ceny zakupu produktu, anulowane osobno, porównanie z wybranym okresem (porownaj: poprzedni = tyle samo dni tuż przed, domyślnie; rok = te same daty rok wcześniej; miesiac/tydzien = te same dni miesiąc/tydzień wcześniej; wlasny z porownaj_od i porownaj_do; brak), z oznaczeniem porównania sprzed początku danych (poprzedni.bezDanych, poprzedni.kontaBezDanych: wtedy nie licz wzrostu); podział na okresy (dzień, tydzień, miesiąc), konta kanałów i produkty (najlepiej sprzedające się pierwsze).',
    'Użyj przy pytaniach „ile sprzedaliśmy w październiku?”, „który kanał rośnie?”, „jaka marża na TEST-PRZYPRAWA?”. Produkt bez ceny zakupu ma `brakCenyZakupu: true` i marżę null (nie 100%). Same agregaty, bez klientów.',
    'od/do: RRRR-MM-DD (domyślnie od 1. dnia miesiąca do dziś), najwyżej 366 dni; konto: klucz konta z `konta[].konto`, np. WOO:sklep.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      od: { type: 'string', pattern: DZIEN_PATTERN, description: 'Pierwszy dzień zakresu (RRRR-MM-DD).' },
      do: { type: 'string', pattern: DZIEN_PATTERN, description: 'Ostatni dzień zakresu, włącznie (RRRR-MM-DD).' },
      grupuj: { type: 'string', enum: ['dzien', 'tydzien', 'miesiac'], description: 'Okresy w podziale (domyślnie wg długości zakresu).' },
      konto: str('Tylko jedno konto kanału, np. WOO:sklep.', 120),
      produktow: { type: 'integer', minimum: 1, maximum: MCP_MAX_PRODUCTS, description: 'Ile produktów (domyślnie 50).' },
      porownaj: { type: 'string', enum: [...TRYBY_POROWNANIA], description: 'Z czym porównać: poprzedni (domyślnie), rok, miesiac, tydzien, wlasny, brak.' },
      porownaj_od: { type: 'string', pattern: DZIEN_PATTERN, description: 'Początek porównania przy porownaj=wlasny (RRRR-MM-DD).' },
      porownaj_do: { type: 'string', pattern: DZIEN_PATTERN, description: 'Koniec porównania przy porownaj=wlasny, włącznie (RRRR-MM-DD).' },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      od: { type: 'string' },
      do: { type: 'string' },
      grupuj: { type: 'string' },
      razem: MIARY_OUT,
      poprzedni: { type: ['object', 'null'] },
      okresy: { type: 'array', items: { type: 'object' } },
      konta: { type: 'array', items: { type: 'object' } },
      produkty: {
        type: 'array',
        items: {
          type: 'object',
          properties: { sku: { type: ['string', 'null'] }, nazwa: { type: 'string' }, ilosc: { type: 'number' }, brutto: { type: 'number' }, netto: { type: 'number' }, marza: { type: ['number', 'null'] }, brakCenyZakupu: { type: 'boolean' } },
          required: ['sku', 'nazwa', 'ilosc', 'brutto', 'netto', 'marza', 'brakCenyZakupu'],
        },
      },
      produktowRazem: { type: 'integer' },
      wiecejProduktow: { type: 'boolean' },
      pozaKompletorem: { type: 'object' },
      zArchiwum: { type: 'object' },
      zKanalemOdtworzonym: { type: 'object' },
    },
    required: ['od', 'do', 'grupuj', 'razem', 'poprzedni', 'okresy', 'konta', 'produkty', 'wiecejProduktow'],
  },
  scope: 'mcp:odczyt',
  heavy: true,
  limitArg: 'produktow',
  annotations: { title: 'Raport sprzedaży', ...READ, idempotentHint: false },
  async run(ctx, a) {
    const now = ctx.now()
    const q = zapytanieSprzedazy({ od: optStr(a.od), do: optStr(a.do), grupuj: optStr(a.grupuj), konto: optStr(a.konto), produktow: optInt(a.produktow) ?? MCP_MAX_PRODUCTS, porownaj: optStr(a.porownaj), porownajOd: optStr(a.porownaj_od), porownajDo: optStr(a.porownaj_do) }, now)
    const r = await raportSprzedazy(ctx.db, q, now)
    return { data: r as unknown as Record<string, unknown>, items: r.produkty.length + r.okresy.length }
  },
}

/** Wszystkie narzędzia, w stałej kolejności (spec: `tools/list` SHOULD być deterministyczne). */
// automatyczne akcje firmy (tylko odczyt)
const automaty: McpTool = {
  name: 'automaty',
  title: 'Automatyczne akcje',
  description: [
    'Automatyczne akcje firmy (Ustawienia → Sprzedaż i kanały → Automatyczne akcje): grupy i reguły „zdarzenie → warunki → kroki” (np. opłacone + przesyłka zawiera „Paczkomaty” → status „Do realizacji Paczkomaty”), przyciski, oraz ostatnie wykonania reguł.',
    'Podaj `zamowienie` (id zamówienia), żeby zobaczyć, które reguły zadziałały na zamówieniu i z jakim wynikiem. Użyj przy pytaniach „dlaczego zamówienie zmieniło status?”, „jakie mamy automaty?”. Tylko odczyt.',
  ].join(' '),
  inputSchema: { type: 'object', properties: { zamowienie: str('Id zamówienia (opcjonalnie).') }, additionalProperties: false },
  outputSchema: { type: 'object', properties: { grupy: { type: 'array' }, reguly: { type: 'array' }, wykonania: { type: 'array' } }, required: ['grupy', 'reguly', 'wykonania'] },
  scope: 'mcp:odczyt',
  annotations: { title: 'Automatyczne akcje', ...READ },
  async run(ctx, a) {
    const z = optStr(a.zamowienie)
    if (z && !/^[a-z0-9]{1,40}$/i.test(z)) throw new ApiInputError('zamowienie: id zamówienia', 'zamowienie')
    const d = await automatyFirmy(ctx.db, { zamowienie: z })
    return { data: d as unknown as Record<string, unknown>, items: d.reguly.length + d.wykonania.length }
  },
}

export const TOOLS: readonly McpTool[] = [zamowieniaLista, zamowienieSzczegoly, stany, produktySzukaj, produktSzczegoly, statusy, raportDnia, braki, rezerwacje, raportSprzedazyTool, automaty]

export const TOOL_NAMES = TOOLS.map((t) => t.name)

export function findTool(name: string): McpTool | undefined {
  return TOOLS.find((t) => t.name === name)
}
