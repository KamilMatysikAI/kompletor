// Adapter WooCommerce `woo.rest.v1`: dziennik zamówień przez polling `modified_after` (filtr
// działa na sklepie produkcyjnym, odpowiedź bez cache LiteSpeed), tylko odczyt. Mapowanie wg spec v1.5 rozdz. 3.1 i 2.3:
//   pending, on-hold, failed, processing → OPEN (rezerwuje, także nieopłacone); completed → FULFILLED; cancelled,
//   refunded → CANCELLED; checkout-draft, trash → DRAFT (pomijane); inny (status z wtyczki) → OPEN + ostrzeżenie.
//   `failed` to nieudana płatność (np. BLIK odrzucony), nie anulowanie: klient może zapłacić ponownie albo przelewem,
//   więc zamówienie czeka nieopłacone do terminu z ustawień firmy, jak `pending` (tak prowadzi je też BL).
// Pozycje: oferta = ChannelOffer.externalId „<product_id>” albo „<product_id>/<variation_id>” (import).
// Dane klienta (billing, shipping, customer_note, ip) nie są czytane w dzienniku — nie wychodzą z wooOrderFromApi.
// Odbiorcę czyta osobna zdolność `orders.recipient` (`wooRecipientFromApi`): na żądanie hosta, w pamięci.
import type { PaymentState } from '@prisma/client'
import { ReadOnlyViolation, SourceError, type FetchLike } from '../zrodla/http'
import { ODCZYT_OFERT_WOO_RE, WooReadOnly, type WooResponse } from '../zrodla/woo'
import { normalizeEan } from '../import/normalizacja'
import { cenaPoRabacieGr, rabatWSuficie, resztaZaokraglenGr, sufitRabatuProc } from '../rdzen/ceny'
import {
  AdapterError,
  type AdapterContext,
  type AdapterDefinition,
  type AdapterManifest,
  type ChannelAdapter,
  type ChannelBehavior,
  type ChannelOrder,
  type ChannelOrderLine,
  type ConnectionTest,
  type OrderFeed,
  type OrderFeedItem,
  type OrderFeedOptions,
  type OrderFeedPage,
  type OrderLifecycle,
  type OrderRecipient,
  joinName,
  missingAddressProblems,
  type ChannelOfferRow,
  type OfferPageWithProblems,
  type OfferReadProblem,
  type OfferReader,
  optAmount,
  opisLinii,
  optText,
  readDate,
  readInt,
  readNumber,
  readRecipientObject,
  readRecipientText,
  type RecipientAddress,
  type RecipientInvoice,
  type RecipientProblem,
  type RecipientReader,
  UnreadableDataError,
} from './kontrakt'

export const META_KEY_RE = /^[A-Za-z0-9_-]{1,100}$/

/**
 * zachowanie kanału Woo. Statusy wbudowane WooCommerce (sklep z wtyczką statusów może mieć więcej:
 * wtedy wpisuje się identyfikator bez przedrostka „wc-”). Domyślna mapa jak w BL: „Wysłane” →
 * Zrealizowane, anulowanie w Kompletorze i anulowanie nieopłaconego po terminie → Anulowane.
 */
export const WOO_BEHAVIOR: ChannelBehavior = {
  stockModel: 'self-decrementing',
  unpaidGuard: true,
  channelStatuses: [
    { id: 'pending', label: 'Oczekujące na płatność' },
    { id: 'on-hold', label: 'Wstrzymane' },
    { id: 'processing', label: 'W trakcie realizacji' },
    { id: 'completed', label: 'Zrealizowane' },
    { id: 'cancelled', label: 'Anulowane' },
    { id: 'refunded', label: 'Zwrócone' },
    { id: 'failed', label: 'Nieudane' },
  ],
  defaultStatusMap: { WYSLANE: 'completed', ODEBRANE: 'completed', ANULOWANE: 'cancelled', ANULOWANE_NIEOPLACONE: 'cancelled' },
}

export const WOO_MANIFEST: AdapterManifest = {
  adapterKey: 'woo.rest.v1',
  version: '1.0.0',
  displayName: 'WooCommerce (REST v3)',
  kind: 'channel',
  channel: 'WOO',
  capabilities: ['orders.feed', 'orders.recipient', 'offers.read', 'offers.prepare'],
  rateLimit: { requestsPerMinute: 120, maxConcurrent: 1, minPollIntervalMs: 30_000 },
  config: [
    { key: 'baseUrl', type: 'string', required: true, description: 'adres sklepu https://…', pattern: /^https:\/\/\S+$/i, envSuffix: 'URL' },
    { key: 'envPrefix', type: 'string', required: false, description: 'self-host: przedrostek zmiennych env konta (np. SD_WC)', pattern: /^[A-Z][A-Z0-9_]{0,40}$/ },
    { key: 'pollIntervalSec', type: 'number', required: false, description: 'co ile sekund czytać zamówienia (domyślnie 60)' },
    { key: 'overlapMinutes', type: 'number', required: false, description: 'zakładka czasowa odczytu (domyślnie 5)' },
    { key: 'pageSize', type: 'number', required: false, description: 'zamówień na stronę (1–100, domyślnie 100)' },
    { key: 'holdStockMinutes', type: 'number', required: false, description: 'woocommerce_hold_stock_minutes sklepu (odczyt przy podłączeniu)' },
    { key: 'nipMetaKey', type: 'string', required: false, description: 'klucz meta_data zamówienia z NIP-em do faktury (np. _billing__billing_nip); puste = NIP nieznany', pattern: META_KEY_RE },
    { key: 'pickupPointMetaKey', type: 'string', required: false, description: 'klucz meta_data zamówienia z kodem punktu odbioru (wtyczka sklepu); puste = punkt nieznany', pattern: META_KEY_RE },
    { key: 'invoiceMetaKey', type: 'string', required: false, description: 'klucz meta_data zamówienia z zaznaczeniem „chcę fakturę” (wtyczka checkoutu); puste = faktura tylko przy firmie albo NIP-ie', pattern: META_KEY_RE },
  ],
  secrets: [
    { name: 'WOO_CONSUMER_KEY', required: true, description: 'klucz WC REST (read) albo login WP z hasłem aplikacji', envSuffix: 'KEY' },
    { name: 'WOO_CONSUMER_SECRET', required: true, description: 'sekret WC REST albo hasło aplikacji WP', envSuffix: 'SECRET' },
  ],
  readOnly: true,
  channelBehavior: WOO_BEHAVIOR,
}

export const STATUS: Record<string, { lifecycle: OrderLifecycle; rank: number | null }> = {
  pending: { lifecycle: 'OPEN', rank: 10 },
  'on-hold': { lifecycle: 'OPEN', rank: 10 },
  processing: { lifecycle: 'OPEN', rank: 20 },
  completed: { lifecycle: 'FULFILLED', rank: 30 },
  cancelled: { lifecycle: 'CANCELLED', rank: null },
  failed: { lifecycle: 'OPEN', rank: 10 }, // nieudana płatność = nieopłacone, jak pending
  refunded: { lifecycle: 'CANCELLED', rank: null },
  'checkout-draft': { lifecycle: 'DRAFT', rank: null },
  trash: { lifecycle: 'DRAFT', rank: null },
}

export const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null)
const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Metody płatności rdzenia WooCommerce bez bramki online (identyfikator `payment_method`, nie nazwa ze sklepu):
 * przelew tradycyjny, czek, pobranie. Status `failed` ustawia bramka online; przy tych metodach nie oznacza
 * nieudanej płatności online.
 */
export const WOO_OFFLINE_PAYMENT_METHODS: ReadonlySet<string> = new Set(['bacs', 'cheque', 'cod'])

function paymentOf(raw: Record<string, unknown>, status: string): PaymentState {
  if (str(raw['payment_method']) === 'cod') return 'COD'
  if (str(raw['date_paid_gmt']) || status === 'processing' || status === 'completed') return 'PAID'
  return 'UNPAID'
}

/** Faktura na firmę: pole meta z NIP-em niepuste (wartości nie zachowujemy). */
function wantsInvoice(raw: Record<string, unknown>): boolean {
  const meta = Array.isArray(raw['meta_data']) ? (raw['meta_data'] as Record<string, unknown>[]) : []
  return meta.some((m) => /(^|_)nip($|_)|vat_?number|tax_?id/i.test(String(m?.['key'] ?? '')) && !!str(m?.['value']))
}

/**
 * Pozycja Woo: cena za sztukę z `total` + `total_tax`, czyli PO kuponie WooCommerce (`subtotal` to cena przed kuponem;
 * kupon rozkłada sam sklep), do grosza. Rabat spoza pozycji (ujemne `fee_lines`) nakłada `wooOrderFromApi`
 * na tę cenę jedną regułą z dokumentem sprzedaży (`cenaPoRabacieGr`).
 */
function lineOf(l: Record<string, unknown>, i: number, warnings: string[]): ChannelOrderLine {
  const id = str(l['id'])
  if (!id) throw new UnreadableDataError(`pozycja ${i + 1} bez id`)
  const qty = readInt(l['quantity'], `ilość pozycji ${id}`)
  if (qty <= 0) throw new UnreadableDataError(`ilość pozycji ${id} ≤ 0`)
  const total = readNumber(l['total'], `kwota pozycji ${id}`)
  const tax = l['total_tax'] === undefined || l['total_tax'] === '' ? 0 : readNumber(l['total_tax'], `VAT pozycji ${id}`)
  const pid = readInt(l['product_id'] ?? 0, `produkt pozycji ${id}`)
  const vid = readInt(l['variation_id'] ?? 0, `wariant pozycji ${id}`)
  if (pid <= 0) warnings.push(`pozycja ${id}: produkt usunięty ze sklepu (product_id 0)`)
  const meta = Array.isArray(l['meta_data']) ? (l['meta_data'] as Record<string, unknown>[]) : []
  if (meta.some((m) => /bundle/i.test(String(m?.['key'] ?? '')))) warnings.push(`pozycja ${id}: część zestawu wtyczki (meta bundle)`)
  return {
    externalLineId: id,
    offerExternalId: pid > 0 ? (vid > 0 ? `${pid}/${vid}` : String(pid)) : null,
    qty,
    unitPriceGross: round2((total + tax) / qty),
    vatRate: null,
    ...opisLinii(optText(l['name']), optText(l['sku'], 200), null),
  }
}

/** Wartość brutto pozycji Woo w groszach (`total` + `total_tax`); pola już sprawdzone przez `lineOf`. */
const bruttoPozycjiGr = (l: Record<string, unknown>): number =>
  Math.round((Number(l['total']) + (l['total_tax'] === undefined || l['total_tax'] === '' ? 0 : Number(l['total_tax']))) * 100)

/**
 * rabat na całe zamówienie spoza pozycji — suma ujemnych opłat (`fee_lines`, brutto = `total` + `total_tax`),
 * w groszach, dodatni. Tak rabatują wtyczki rabatowe (kupon WooCommerce jest już w `total` pozycji). Opłaty dodatnie
 * (pobranie, PayPo) zostają w kwocie zamówienia i na dokumencie idą z wysyłką, jak dotąd. Nieczytelna opłata = błąd.
 */
export function rabatZOplatGr(raw: Record<string, unknown>, externalId: string): number {
  const fees = raw['fee_lines']
  if (fees === undefined || fees === null) return 0
  if (!Array.isArray(fees)) throw new UnreadableDataError(`zamówienie ${externalId}: nieczytelne opłaty (fee_lines)`)
  let gr = 0
  for (const [i, f] of (fees as Record<string, unknown>[]).entries()) {
    const net = readNumber(f?.['total'], `opłata ${i + 1} zamówienia ${externalId}`)
    const tax = f?.['total_tax'] === undefined || f?.['total_tax'] === '' || f?.['total_tax'] === null ? 0 : readNumber(f['total_tax'], `VAT opłaty ${i + 1} zamówienia ${externalId}`)
    const brutto = Math.round((net + tax) * 100)
    if (brutto < 0) gr -= brutto
  }
  return gr
}

/** Koszt wysyłki brutto (shipping_total + shipping_tax); nieczytelny = null (pole opisowe). */
function shippingOf(raw: Record<string, unknown>): number | null {
  const net = optAmount(raw['shipping_total'])
  if (net === null) return null
  return Math.round((net + (optAmount(raw['shipping_tax']) ?? 0)) * 100) / 100
}

/**
 * ceny pozycji po rabacie z ujemnych opłat, regułą identyczną z dokumentem sprzedaży
 * (`zlozPozycjeDokumentu`), żeby zamówienie nowe (ceny po rabacie stąd) i stare (rabat liczony na dokumencie) dawały
 * ten sam podział groszy co BaseLinker:
 * - przed = suma cen za sztukę (do grosza, tak jak zapisuje je `lineOf`) × sztuki, po = suma wartości pozycji Woo − rabat
 *   (dokument liczy to samo jako kwota − koszt wysyłki);
 * - różnica w granicach reszty zaokrągleń (`resztaZaokraglenGr`) = ceny bez zmian, resztę dokłada dokument;
 * - inaczej cena × po / przed do grosza (`cenaPoRabacieGr`); reszty tu nie zapisujemy (cena jest za sztukę), dokument
 *   wylicza ją z tych samych liczb i kładzie na pierwszą pozycję;
 * - rabat ponad limit firmy albo cena 0 gr po rabacie = ceny bez rabatu i ostrzeżenie; dokument zatrzyma wtedy fakturę
 *   (`pozycje-drozsze-niz-zamowienie` albo `cena-zero-po-rabacie`). Ujemna opłata to rabat na towar (tak WooCommerce
 *   rozkłada podatek opłaty: proporcjonalnie do pozycji koszyka); nazwy opłaty nie zgadujemy, limit odcina bon albo saldo
 *   większe niż zwykły rabat.
 *
 * Runda 3: limit ma jedno źródło, ustawienie firmy `settings.faktury.rabatMaksProcent` (host podaje
 * je w `ctx.ustawieniaFirmy`, tak samo czyta je dokument), i adapter porównuje z nim TĘ SAMĄ różnicę co dokument przy
 * cenach bez rabatu: przed − (kwota zamówienia − koszt wysyłki) (`kwotaTowarowGr`; nieznany koszt wysyłki = po). Dzięki
 * temu: adapter odmawia ⇔ dokument z cenami bez rabatu też widzi rabat ponad limit i staje; adapter rozkłada ⇔ dokument
 * widzi tylko resztę zaokrągleń. Granica co do grosza jest ta sama po obu stronach.
 */
export function rozlozRabatWoo(
  lines: readonly Pick<ChannelOrderLine, 'qty' | 'unitPriceGross'>[],
  wartoscWooGr: number,
  rabatGr: number,
  sufitProc?: number,
  /** Kwota zamówienia − koszt wysyłki (grosze), jak liczy dokument (`towaryPoRabacieGr`); brak = wartość pozycji − rabat. */
  kwotaTowarowGr?: number | null,
): { ceny: number[] | null; ostrzezenie: string; rodzaj: RozkladRabatuWoo } {
  const zl = (gr: number) => (gr / 100).toFixed(2)
  const sufit = sufitRabatuProc(sufitProc)
  const cenyGr = lines.map((l) => Math.round(l.unitPriceGross * 100))
  const przedGr = lines.reduce((s, l, i) => s + cenyGr[i]! * l.qty, 0)
  const poGr = wartoscWooGr - rabatGr
  const sztuk = lines.reduce((s, l) => s + l.qty, 0)
  const rabatDokumentuGr = przedGr - (kwotaTowarowGr ?? poGr)
  const bez = (powod: string) => ({ ceny: null, ostrzezenie: `rabat na zamówienie ${zl(rabatGr)} zł (opłata ujemna) ${powod} — ceny pozycji bez rabatu, faktura do sprawdzenia`, rodzaj: 'odmowa' as const })
  if (przedGr <= 0) return bez('bez płatnej pozycji')
  if (poGr <= 0 || !rabatWSuficie(rabatDokumentuGr, przedGr, sufit)) return bez(`większy niż ${sufit}% wartości pozycji`)
  if (resztaZaokraglenGr(przedGr, poGr, sztuk)) return { ceny: null, ostrzezenie: `rabat na zamówienie ${zl(rabatGr)} zł (opłata ujemna) w granicach zaokrągleń — reszta na pierwszej pozycji faktury`, rodzaj: 'zaokraglenia' }
  const ceny = cenyGr.map((c) => cenaPoRabacieGr(c, przedGr, poGr))
  if (ceny.some((c, i) => c <= 0 && cenyGr[i]! > 0)) return bez('daje pozycję za 0 zł')
  return { ceny, ostrzezenie: `rabat na zamówienie ${zl(rabatGr)} zł (opłata ujemna) rozłożony na ceny pozycji`, rodzaj: 'rozlozony' }
}

/** co reguła zrobiła z rabatem z opłat ujemnych: rozłożyła, zostawiła resztę zaokrągleń dokumentowi, odmówiła. */
export type RozkladRabatuWoo = 'rozlozony' | 'zaokraglenia' | 'odmowa'

export interface OpcjeZamowieniaWoo {
  /** Limit rabatu firmy, % wartości pozycji (`settings.faktury.rabatMaksProcent` przez `ctx.ustawieniaFirmy`); brak = 50. */
  rabatMaksProcent?: number
}

/** Zamówienie WC REST v3 → ChannelOrder. Nieczytelne pole = UnreadableDataError (nigdy 0). */
export function wooOrderFromApi(raw: Record<string, unknown>, opts: OpcjeZamowieniaWoo = {}): ChannelOrder {
  return wooOrderZRabatem(raw, opts).order
}

/**
 * zamówienie po regule adaptera (`order`, ceny pozycji po rabacie z ujemnych opłat) razem z cenami pozycji
 * sprzed rabatu (`cenyPrzedRabatem`, ta sama `lineOf`, klucz = id pozycji) i rabatem z opłat w groszach. Jedno źródło:
 * przeliczenie zamówień zapisanych (lib/kanaly/rabat-woo.ts) bierze ceny stąd, nie liczy ich drugi raz.
 */
export interface ZamowienieWooZRabatem {
  order: ChannelOrder
  cenyPrzedRabatem: Record<string, number>
  rabatGr: number
  /** wynik reguły rozkładu; null = zamówienie bez rabatu z opłat */
  rozklad: RozkladRabatuWoo | null
}

export function wooOrderZRabatem(raw: Record<string, unknown>, opts: OpcjeZamowieniaWoo = {}): ZamowienieWooZRabatem {
  const externalId = str(raw['id'])
  if (!externalId || !/^\d+$/.test(externalId)) throw new UnreadableDataError('zamówienie Woo bez id')
  const status = str(raw['status'])
  if (!status) throw new UnreadableDataError(`zamówienie ${externalId} bez statusu`)
  const warnings: string[] = []
  const known = STATUS[status]
  if (!known) warnings.push(`nieznany status Woo „${status}” — traktowany jak otwarte, bez kolejności`)
  const linesRaw = raw['line_items']
  if (!Array.isArray(linesRaw)) throw new UnreadableDataError(`zamówienie ${externalId} bez listy pozycji`)
  const surowe = linesRaw as Record<string, unknown>[]
  const lines = surowe.map((l, i) => lineOf(l, i, warnings))
  const cenyPrzedRabatem = Object.fromEntries(lines.map((l) => [l.externalLineId, l.unitPriceGross]))
  const rabatGr = rabatZOplatGr(raw, externalId)
  const totalGross = readNumber(raw['total'], `kwota zamówienia ${externalId}`)
  const shippingCostGross = shippingOf(raw)
  let rozklad: RozkladRabatuWoo | null = null
  if (rabatGr > 0) {
    const kwotaTowarowGr = shippingCostGross === null ? null : Math.round(totalGross * 100) - Math.round(shippingCostGross * 100)
    const r = rozlozRabatWoo(lines, surowe.reduce((s, l) => s + bruttoPozycjiGr(l), 0), rabatGr, opts.rabatMaksProcent, kwotaTowarowGr)
    if (r.ceny) r.ceny.forEach((c, i) => (lines[i]!.unitPriceGross = c / 100))
    warnings.push(r.ostrzezenie)
    rozklad = r.rodzaj
  }
  const shipping = Array.isArray(raw['shipping_lines']) ? (raw['shipping_lines'] as Record<string, unknown>[]) : []
  const methods = shipping.map((s) => str(s['method_title'])).filter((x): x is string => !!x)
  const number = str(raw['number'])
  const metoda = str(raw['payment_method'])
  const offline = metoda !== null && WOO_OFFLINE_PAYMENT_METHODS.has(metoda)
  const order: ChannelOrder = {
    externalId,
    number: number && number !== externalId ? number : null,
    revision: readDate(raw['date_modified_gmt'] ?? raw['date_created_gmt'], `data zmiany ${externalId}`, true).toISOString(),
    createdAt: readDate(raw['date_created_gmt'], `data zamówienia ${externalId}`, true),
    channelStatus: status,
    statusRank: known?.rank ?? null,
    lifecycle: known?.lifecycle ?? 'OPEN',
    paymentState: paymentOf(raw, status),
    paymentMethod: str(raw['payment_method_title']) ?? str(raw['payment_method']) ?? '(brak)',
    paymentFailedOnline: status === 'failed' && !offline, // pusta metoda przy `failed` = bramka online (offline zawsze ma identyfikator)
    paymentOffline: offline,
    totalGross,
    currency: str(raw['currency']) ?? 'PLN',
    deliveryMethod: methods.length ? methods.join(', ') : null,
    shippingCostGross,
    wantInvoiceNip: wantsInvoice(raw),
    lines,
    warnings,
  }
  return { order, cenyPrzedRabatem, rabatGr, rozklad }
}

// ─── Odbiorca na żądanie ─────────────────────────────────────────

export interface WooRecipientSettings {
  /** Klucz meta_data z NIP-em (konto: `nipMetaKey`); null = nieustawiony. */
  nipMetaKey: string | null
  /** Klucz meta_data z kodem punktu odbioru (konto: `pickupPointMetaKey`); null = nieustawiony. */
  pickupPointMetaKey: string | null
  /** Klucz meta_data z zaznaczeniem „chcę fakturę” (konto: `invoiceMetaKey`); null = nieustawiony. */
  invoiceMetaKey: string | null
}

const FLAG_TAK = new Set(['1', 'yes', 'tak', 'true', 'on'])

/** Zaznaczenie z meta_data: true/1/yes/tak/on = tak; brak, puste i inne wartości = nie; zły typ = UnreadableDataError. */
function metaFlag(raw: Record<string, unknown>, key: string): boolean {
  const meta = raw['meta_data']
  if (meta === undefined || meta === null) return false
  if (!Array.isArray(meta)) throw new UnreadableDataError('nieczytelne pole odbiorcy: meta_data')
  const hit = (meta as unknown[]).find((m) => m && typeof m === 'object' && (m as Record<string, unknown>)['key'] === key) as Record<string, unknown> | undefined
  if (!hit) return false
  if (typeof hit['value'] === 'boolean') return hit['value']
  const v = readRecipientText(hit['value'], `meta_data[${key}]`)
  return !!v && FLAG_TAK.has(v.toLowerCase())
}

/** Wartość meta_data po kluczu (pierwsza pasująca); brak = null, zły typ = UnreadableDataError z nazwą klucza. */
function metaText(raw: Record<string, unknown>, key: string): string | null {
  const meta = raw['meta_data']
  if (meta === undefined || meta === null) return null
  if (!Array.isArray(meta)) throw new UnreadableDataError('nieczytelne pole odbiorcy: meta_data')
  const hit = (meta as unknown[]).find((m) => m && typeof m === 'object' && (m as Record<string, unknown>)['key'] === key) as Record<string, unknown> | undefined
  return hit ? readRecipientText(hit['value'], `meta_data[${key}]`) : null
}

/** Punkt odbioru z linii wysyłki wtyczki Flexible Shipping; brak pola albo inny kształt = null (bez wyjątku). */
function punktFlexibleShipping(raw: Record<string, unknown>): OrderRecipient['punktOdbioru'] {
  const linie = raw['fs_shipping_lines']
  if (!Array.isArray(linie)) return null
  for (const l of linie as unknown[]) {
    if (!l || typeof l !== 'object') continue
    const kod = (l as Record<string, unknown>)['delivery_point_id']
    if (typeof kod !== 'string' || !/^[A-Za-z0-9_-]{3,32}$/.test(kod.trim())) continue
    const nazwa = (l as Record<string, unknown>)['delivery_point_name']
    return { kod: kod.trim(), nazwa: typeof nazwa === 'string' && nazwa.trim() ? nazwa.trim().slice(0, 120) : null }
  }
  return null
}

const line = (...parts: (string | null)[]) => parts.filter((p): p is string => !!p).join(' ') || null

/**
 * Zamówienie WC REST v3 → odbiorca. Adres dostawy z `shipping`, a gdy sklep go nie podał (brak ulicy, kodu i miasta)
 * — cały blok z `billing` (nie mieszamy dwóch adresów pole po polu). E-mail i telefon z `billing` (telefon dostawy
 * jako zapas). Woo nie dzieli ulicy i numeru: cała linia w `ulica`, problem `adres_bez_podzialu`.
 */
export function wooRecipientFromApi(raw: Record<string, unknown>, settings: WooRecipientSettings): OrderRecipient {
  const problemy: RecipientProblem[] = []
  const block = (name: 'shipping' | 'billing') => {
    const b = readRecipientObject(raw[name], name) ?? {}
    const t = (f: string) => readRecipientText(b[f], `${name}.${f}`)
    return {
      imie: joinName(t('first_name'), t('last_name')),
      firma: t('company'),
      ulica: line(t('address_1'), t('address_2')),
      kod: t('postcode'),
      miasto: t('city'),
      kraj: t('country'),
      telefon: t('phone'),
      email: name === 'billing' ? t('email') : null,
    }
  }
  const ship = block('shipping')
  const bill = block('billing')
  const shipHasAddress = !!(ship.ulica || ship.kod || ship.miasto)
  const adr = shipHasAddress ? ship : bill
  const dostawa: RecipientAddress = {
    imieNazwisko: shipHasAddress ? (ship.imie ?? bill.imie) : bill.imie,
    firma: shipHasAddress ? ship.firma : bill.firma,
    ulica: adr.ulica,
    numerDomu: null,
    numerLokalu: null,
    kodPocztowy: adr.kod,
    miasto: adr.miasto,
    kraj: adr.kraj,
    telefon: bill.telefon ?? ship.telefon,
    email: bill.email,
  }
  if (dostawa.ulica) problemy.push('adres_bez_podzialu')
  problemy.push(...missingAddressProblems(dostawa))

  let nip: string | null = null
  if (settings.nipMetaKey) nip = metaText(raw, settings.nipMetaKey)
  else problemy.push('nip_klucz_nieustawiony')
  // `faktura` = klient chce faktury (jak w Allegro), nie „jest adres rozliczeniowy”: firma albo
  // NIP w zamówieniu, albo zaznaczenie z klucza konta. Bez klucza osoby prywatnej chcącej faktury nie widać → problem.
  let chceFaktury = !!(bill.firma || nip)
  if (settings.invoiceMetaKey) chceFaktury = chceFaktury || metaFlag(raw, settings.invoiceMetaKey)
  else problemy.push('faktura_klucz_nieustawiony')
  const faktura: RecipientInvoice | null = chceFaktury
    ? { nazwa: bill.firma ?? bill.imie, nip, ulica: bill.ulica, kodPocztowy: bill.kod, miasto: bill.miasto, kraj: bill.kraj }
    : null

  let punktOdbioru: OrderRecipient['punktOdbioru'] = null
  if (settings.pickupPointMetaKey) {
    const kod = metaText(raw, settings.pickupPointMetaKey)
    punktOdbioru = kod ? { kod, nazwa: null } : null
  }
  // Poprawka z 19.11.2026: wtyczka Flexible Shipping trzyma punkt (paczkomat, punkt DPD) poza meta_data, w
  // `fs_shipping_lines[].delivery_point_id`; jeden klucz konta nie obejmie dwóch przewoźników naraz.
  if (!punktOdbioru) punktOdbioru = punktFlexibleShipping(raw)
  if (!punktOdbioru && !settings.pickupPointMetaKey) problemy.push('punkt_nieznany')

  return { dostawa, punktOdbioru, faktura, problemy, uwagi: readRecipientText(raw['customer_note'], 'customer_note') }
}

/** Najwyżej tyle kluczy meta zwraca test połączenia (sklep z wieloma wtyczkami ma ich dziesiątki). */
export const MAX_KLUCZY_META = 80

/**
 * nazwy kluczy `meta_data` z odpowiedzi `/orders` (lista zamówień) i w ilu zamówieniach wystąpiły.
 * Wartości nie czyta (podpowiedź pól NIP / punktu / faktury, lib/kanaly/woo-meta.ts).
 */
export function kluczeZZamowien(orders: unknown): { sample: number; keys: { key: string; orders: number }[] } | null {
  if (!Array.isArray(orders)) return null
  const licz = new Map<string, number>()
  let sample = 0
  for (const o of orders) {
    if (!o || typeof o !== 'object') continue
    sample++
    const meta = (o as Record<string, unknown>)['meta_data']
    if (!Array.isArray(meta)) continue
    const wTym = new Set<string>()
    for (const m of meta) {
      const k = m && typeof m === 'object' ? (m as Record<string, unknown>)['key'] : null
      if (typeof k === 'string' && META_KEY_RE.test(k)) wTym.add(k)
    }
    for (const k of wTym) licz.set(k, (licz.get(k) ?? 0) + 1)
  }
  const keys = [...licz.entries()]
    .map(([key, n]) => ({ key, orders: n }))
    .sort((a, b) => b.orders - a.orders || a.key.localeCompare(b.key))
    .slice(0, MAX_KLUCZY_META)
  return { sample, keys }
}


const metaKeyOf = (v: unknown): string | null => (typeof v === 'string' && META_KEY_RE.test(v.trim()) ? v.trim() : null)

interface WooCursor {
  a: string // modified_after (ISO UTC)
  p: number // strona
  m: string // najpóźniejsza widziana zmiana
}

export function parseWooCursor(c: string): WooCursor {
  try {
    const x = JSON.parse(c) as WooCursor
    if (typeof x.a === 'string' && typeof x.m === 'string' && Number.isInteger(x.p) && x.p >= 1 && !Number.isNaN(Date.parse(x.a)) && !Number.isNaN(Date.parse(x.m))) return x
  } catch {
    // niżej
  }
  throw new AdapterError('zły kursor Woo', 'TRWALY')
}

const pageSizeOf = (v: unknown) => {
  const n = Number(v ?? 100)
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : 100
}
const wcDate = (iso: string) => iso.slice(0, 19) // WC: ISO8601 bez strefy, z dates_are_gmt=true

export function toAdapterError(e: unknown): unknown {
  if (e instanceof SourceError) return new AdapterError(e.message, e.retryable ? 'PRZEJSCIOWY' : 'TRWALY')
  return e
}

export class WooAdapter implements ChannelAdapter, OrderFeed, RecipientReader, OfferReader {
  protected readonly api: WooReadOnly
  private readonly overlapMs: number
  private readonly perPage: number

  constructor(
    protected readonly ctx: AdapterContext,
    readonly manifest: AdapterManifest = WOO_MANIFEST,
  ) {
    this.perPage = pageSizeOf(ctx.config['pageSize'])
    this.api = new WooReadOnly(String(ctx.config['baseUrl']), ctx.secrets['WOO_CONSUMER_KEY']!, ctx.secrets['WOO_CONSUMER_SECRET']!, ctx.fetch as FetchLike, ctx.http?.minIntervalMs, ctx.http?.retry)
    const o = Number(ctx.config['overlapMinutes'] ?? 5)
    this.overlapMs = (Number.isFinite(o) && o >= 0 ? o : 5) * 60_000
  }

  /** publiczny odczyt do ofertowania (kategorie sklepu, produkt po SKU); inna ścieżka = błąd przed wysłaniem. */
  odczytDoOfert<T>(path: string, query: Record<string, string | number | boolean> = {}): Promise<WooResponse<T>> {
    if (!ODCZYT_OFERT_WOO_RE.test(path)) return Promise.reject(new ReadOnlyViolation(`Woo: odczyt do ofert poza dozwolonymi ścieżkami (${path.slice(0, 60)})`))
    return this.api.get<T>(path, query)
  }

  /** runda 3: limit rabatu z ustawień firmy (host: `ctx.ustawieniaFirmy`), to samo źródło co dokument. */
  private opcjeZamowien(): OpcjeZamowieniaWoo {
    return { rabatMaksProcent: sufitRabatuProc(this.ctx.ustawieniaFirmy?.rabatMaksProcent) }
  }

  private includeTax: Promise<boolean | null> | null = null

  /** czy sklep wpisuje ceny z podatkiem (jeden odczyt na adapter); błąd odczytu = nie wiadomo (null). */
  private pricesIncludeTax(): Promise<boolean | null> {
    this.includeTax ??= this.api
      .get<{ value?: unknown }>('/settings/tax/woocommerce_prices_include_tax')
      .then((r) => (r.body?.value === 'yes' ? true : r.body?.value === 'no' ? false : null))
      .catch(() => null)
    return this.includeTax
  }

  private taxRates: Promise<Map<string, string> | null> | null = null

  /** stawki VAT klas podatkowych sklepu (`/taxes`, jeden odczyt na adapter); błąd odczytu = brak stawek. */
  private vatByClass(): Promise<Map<string, string> | null> {
    this.taxRates ??= (async () => {
      const all: Record<string, unknown>[] = []
      for (let page = 1; page <= 20; page++) {
        const r = await this.api.get<Record<string, unknown>[]>('/taxes', { per_page: 100, page })
        if (!Array.isArray(r.body)) return null
        all.push(...r.body)
        if (r.body.length < 100) break
      }
      return wooVatByClass(all)
    })().catch(() => null)
    return this.taxRates
  }

  async testConnection(): Promise<ConnectionTest> {
    try {
      const r = await this.api.get<unknown[]>('/orders', { per_page: 1 })
      const hold = await this.api.get<{ value?: unknown }>('/settings/products/woocommerce_hold_stock_minutes').catch(() => null)
      const h = hold?.body?.value
      // nazwy kluczy meta z 10 ostatnich zamówień. `_fields` ogranicza odpowiedź do `id` i `meta_data`
      // (bez danych odbiorcy). Nie `meta_data.key`: WooCommerce liczy `meta_data` tylko wybrane w całości, więc samo
      // `meta_data.key` daje zamówienia bez `meta_data` (sprawdzone na WP 7.1 + WC 11.2).
      // Wartości odrzuca `kluczeZZamowien` w pamięci: do wyniku i bazy idą same nazwy. Błąd odczytu nie psuje testu.
      const last = await this.api.get<unknown[]>('/orders', { per_page: 10, orderby: 'date', order: 'desc', status: 'any', _fields: 'id,meta_data' }).catch(() => null)
      const orderMeta = last ? kluczeZZamowien(last.body) : null
      return {
        ok: true,
        message: 'odczyt zamówień działa',
        details: { orders: r.total, holdStockMinutes: typeof h === 'string' && h.trim() !== '' && Number.isFinite(Number(h)) ? Number(h) : null },
        ...(orderMeta ? { orderMeta } : {}),
      }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  }

  async listOrderChanges(cursor: string | null, opts: OrderFeedOptions): Promise<OrderFeedPage> {
    const start = this.ctx.now().getTime() - opts.initialLookbackMs
    const cur: WooCursor = cursor ? parseWooCursor(cursor) : { a: new Date(start).toISOString(), p: 1, m: new Date(start).toISOString() }
    let r
    try {
      r = await this.api.get<Record<string, unknown>[]>('/orders', {
        modified_after: wcDate(cur.a),
        dates_are_gmt: true,
        orderby: 'modified',
        order: 'asc',
        per_page: this.perPage,
        page: cur.p,
        status: 'any',
      })
    } catch (e) {
      throw toAdapterError(e)
    }
    if (!Array.isArray(r.body)) throw new AdapterError('Woo /orders: odpowiedź nie jest listą', 'PRZEJSCIOWY')
    let maxSeen = cur.m
    let lastOnPage: string | null = null
    const items: OrderFeedItem[] = []
    for (const raw of r.body) {
      const id = str(raw?.['id'])
      if (!id) continue // bez id nie da się ani zapisać, ani ponowić
      try {
        const order = wooOrderFromApi(raw, this.opcjeZamowien())
        items.push({ externalId: order.externalId, revision: order.revision, order })
        if (order.revision > maxSeen) maxSeen = order.revision
        lastOnPage = order.revision
      } catch {
        // jedno nieczytelne zamówienie nie psuje strony: host pobierze je osobno (getOrder) i zapisze błąd elementu
        items.push({ externalId: id, revision: '' })
        try {
          const rev = readDate(raw['date_modified_gmt'], `data zmiany ${id}`, true).toISOString()
          lastOnPage = rev
          if (rev > maxSeen) maxSeen = rev
        } catch {
          // bez czytelnej daty: klucz strony zostaje z poprzedniego zamówienia
        }
      }
    }
    const lastPage = r.totalPages ?? (r.body.length < this.perPage ? cur.p : cur.p + 1)
    if (cur.p < lastPage && r.body.length > 0) {
      // Stronicowanie po kluczu: następna strona od daty zmiany ostatniego zamówienia (−1 s, bo modified_after jest
      // ostre, a w tej samej sekundzie mogą być kolejne). Numer strony przesuwałby się, gdy zamówienie zmienione
      // w trakcie odczytu przeskoczy na koniec listy — i jedno zamówienie wypadłoby z odczytu. Duble odsiewa host
      // (ta sama rewizja = bez zmian). Gdy klucz nie posuwa się (cała strona w jednej sekundzie) — kolejna strona.
      const keyset = lastOnPage ? new Date(Date.parse(lastOnPage) - 1000).toISOString() : null
      const next = keyset && keyset > cur.a ? { a: keyset, p: 1, m: maxSeen } : { a: cur.a, p: cur.p + 1, m: maxSeen }
      return { items, nextCursor: JSON.stringify(next), hasMore: true }
    }
    const back = new Date(Date.parse(maxSeen) - this.overlapMs).toISOString()
    const nextAfter = back > cur.a ? back : cur.a
    return { items, nextCursor: JSON.stringify({ a: nextAfter, p: 1, m: maxSeen }), hasMore: false }
  }

  async getOrder(externalId: string): Promise<ChannelOrder | null> {
    if (!/^\d+$/.test(externalId)) throw new AdapterError(`zły numer zamówienia Woo „${externalId}”`, 'TRWALY')
    let r
    try {
      r = await this.api.get<Record<string, unknown>>(`/orders/${externalId}`)
    } catch (e) {
      throw toAdapterError(e)
    }
    if (r.status === 404 || r.body === null) return null
    return wooOrderFromApi(r.body, this.opcjeZamowien())
  }

  /**
   * odczyt jednego zamówienia (tylko GET) z cenami pozycji przed i po rabacie z ujemnych opłat, do przeliczenia
   * zamówień zapisanych (lib/kanaly/rabat-woo.ts). null = zamówienia nie ma w sklepie.
   */
  async getOrderZRabatem(externalId: string): Promise<ZamowienieWooZRabatem | null> {
    if (!/^\d+$/.test(externalId)) throw new AdapterError(`zły numer zamówienia Woo „${externalId}”`, 'TRWALY')
    let r
    try {
      r = await this.api.get<Record<string, unknown>>(`/orders/${externalId}`)
    } catch (e) {
      throw toAdapterError(e)
    }
    if (r.status === 404 || r.body === null) return null
    if (typeof r.body !== 'object' || Array.isArray(r.body)) throw new UnreadableDataError('Woo /orders/{id}: odpowiedź nie jest obiektem')
    return wooOrderZRabatem(r.body, this.opcjeZamowien())
  }

  async getOrderRecipient(externalId: string): Promise<OrderRecipient> {
    if (!/^\d+$/.test(externalId)) throw new AdapterError('zły numer zamówienia Woo', 'TRWALY')
    let r
    try {
      r = await this.api.get<Record<string, unknown>>(`/orders/${externalId}`)
    } catch (e) {
      throw toAdapterError(e)
    }
    if (r.status === 404 || r.body === null) throw new AdapterError(`Woo: zamówienia ${externalId} nie ma w sklepie`, 'TRWALY')
    if (typeof r.body !== 'object' || Array.isArray(r.body)) throw new UnreadableDataError('Woo /orders/{id}: odpowiedź nie jest obiektem')
    return wooRecipientFromApi(r.body, {
      nipMetaKey: metaKeyOf(this.ctx.config['nipMetaKey']),
      pickupPointMetaKey: metaKeyOf(this.ctx.config['pickupPointMetaKey']),
      invoiceMetaKey: metaKeyOf(this.ctx.config['invoiceMetaKey']),
    })
  }

  // oferty sklepu, tylko GET. Kursor = numer następnej strony /products (tekst). Produkt zmienny nie jest
  // ofertą: jego warianty (/products/<id>/variations, wszystkie strony) idą w tej samej stronie wyniku.
  async listOffers(cursor: string | null): Promise<OfferPageWithProblems> {
    const page = cursor === null ? 1 : Number(cursor)
    if (!Number.isInteger(page) || page < 1 || page > 100_000) throw new AdapterError('zły kursor ofert Woo', 'TRWALY')
    let r
    try {
      r = await this.api.get<Record<string, unknown>[]>('/products', { per_page: this.perPage, page, status: 'any', orderby: 'id', order: 'asc' })
    } catch (e) {
      throw toAdapterError(e)
    }
    if (!Array.isArray(r.body)) throw new AdapterError('Woo /products: odpowiedź nie jest listą', 'PRZEJSCIOWY')
    const items: ChannelOfferRow[] = []
    const unreadable: OfferReadProblem[] = []
    const take = (id: string, f: () => ChannelOfferRow) => {
      try {
        items.push(f())
      } catch (e) {
        if (!(e instanceof UnreadableDataError)) throw e
        unreadable.push({ externalId: id, message: e.message })
      }
    }
    const incl = await this.pricesIncludeTax()
    const vat = await this.vatByClass()
    for (const raw of r.body) {
      const pid = str(raw?.['id'])
      if (!pid || !/^\d+$/.test(pid)) {
        unreadable.push({ externalId: '?', message: 'produkt Woo bez id' })
        continue
      }
      if (str(raw['type']) !== 'variable') {
        take(pid, () => wooOfferFromApi(raw, pid, null, incl, vat))
        continue
      }
      for (let vp = 1; vp <= 1000; vp++) {
        let v
        try {
          v = await this.api.get<Record<string, unknown>[]>(`/products/${pid}/variations`, { per_page: 100, page: vp, orderby: 'id', order: 'asc' })
        } catch (e) {
          throw toAdapterError(e)
        }
        if (v.status === 404) break // produkt zniknął w trakcie odczytu
        if (!Array.isArray(v.body)) throw new AdapterError(`Woo /products/${pid}/variations: odpowiedź nie jest listą`, 'PRZEJSCIOWY')
        for (const raw2 of v.body) {
          const vid = str(raw2?.['id'])
          if (!vid || !/^\d+$/.test(vid)) {
            unreadable.push({ externalId: `${pid}/?`, message: 'wariant Woo bez id' })
            continue
          }
          take(`${pid}/${vid}`, () => wooOfferFromApi(raw2, `${pid}/${vid}`, raw, incl, vat))
        }
        const last = v.totalPages ?? (v.body.length < 100 ? vp : vp + 1)
        if (vp >= last || v.body.length === 0) break
      }
    }
    const lastPage = r.totalPages ?? (r.body.length < this.perPage ? page : page + 1)
    return { items, nextCursor: page < lastPage && r.body.length > 0 ? String(page + 1) : null, unreadable }
  }
}

const GTIN_META_RE = /(^|_)(ean|gtin|gtin13|barcode)($|_)/i

const STAWKI_VAT = new Set(['23', '8', '5', '0'])

/**
 * stawka VAT każdej klasy podatkowej Woo z listy `/taxes`: wiersze dla Polski (`country` = PL), a gdy ich
 * nie ma — wiersze bez kraju („dowolny”). Klasa z dwiema różnymi stawkami (np. według regionu) albo stawką spoza
 * 23/8/5/0 nie dostaje stawki. Klasa z więcej niż jednym wierszem tego samego kraju (Woo sumuje wiersze
 * o różnym priorytecie) też nie dostaje stawki, nawet przy tej samej stawce. Klucz „standard” = pusta klasa produktu.
 */
export function wooVatByClass(rows: Record<string, unknown>[]): Map<string, string> {
  const pl = new Map<string, string[]>()
  const any = new Map<string, string[]>()
  for (const r of rows) {
    const country = (str(r?.['country']) ?? '').toUpperCase()
    if (country !== 'PL' && country !== '') continue
    const cls = str(r['class']) ?? 'standard'
    const n = Number(str(r['rate']) ?? r['rate'])
    const rate = Number.isFinite(n) && Number.isInteger(n) ? String(n) : `?${String(r['rate'])}`
    const m = country === 'PL' ? pl : any
    if (!m.has(cls)) m.set(cls, [])
    m.get(cls)!.push(rate)
  }
  const out = new Map<string, string>()
  for (const cls of new Set([...pl.keys(), ...any.keys()])) {
    const s = pl.get(cls) ?? any.get(cls)!
    const [only] = s
    if (s.length === 1 && only && STAWKI_VAT.has(only)) out.set(cls, only)
  }
  return out
}

/** Klasa podatkowa oferty Woo: wariant z „parent” bierze klasę produktu nadrzędnego, pusta = „standard”. */
function wooTaxClass(raw: Record<string, unknown>, parent: Record<string, unknown> | null): string {
  const own = str(raw['tax_class'])
  const cls = own === 'parent' ? str(parent?.['tax_class']) : own
  return cls || 'standard'
}

/** Produkt albo wariant WC REST v3 → oferta. Bez zmiany ilości na 0: nieczytelna = UnreadableDataError. */
/**
 * cena oferty Woo jako brutto, gdy sklep wpisuje ceny z podatkiem (`pricesIncludeTax` = true, odczyt
 * ustawienia woocommerce_prices_include_tax). Stawka VAT z klasy podatkowej produktu (`vatByClass` z
 * `/taxes`); przy cenach netto brutto = netto × (1 + stawka), liczone na groszach z tekstu ceny. Produkt
 * nieopodatkowany (`tax_status` = none albo shipping, podatek tylko od wysyłki), nieznana klasa albo nieznane
 * ustawienie = pusta stawka i (przy cenach netto) pusta cena.
 */
export function wooOfferFromApi(
  raw: Record<string, unknown>,
  externalId: string,
  parent: Record<string, unknown> | null,
  pricesIncludeTax: boolean | null = null,
  vatByClass: Map<string, string> | null = null,
): ChannelOfferRow {
  const meta = Array.isArray(raw['meta_data']) ? (raw['meta_data'] as Record<string, unknown>[]) : []
  const eanRaw = str(raw['global_unique_id']) ?? str(meta.find((m) => GTIN_META_RE.test(String(m?.['key'] ?? '')))?.['value'])
  // manage_stock wariantu: true, false albo „parent” (stan prowadzi produkt nadrzędny)
  const manage = raw['manage_stock']
  let qty: number | null = null
  if (manage === true) qty = readInt(raw['stock_quantity'], `stan oferty ${externalId}`)
  else if (manage === 'parent' && parent?.['manage_stock'] === true) qty = readInt(parent['stock_quantity'], `stan produktu nadrzędnego oferty ${externalId}`)
  else if (manage !== false && manage !== 'parent' && manage !== undefined && manage !== null) throw new UnreadableDataError(`nieczytelne manage_stock oferty ${externalId}`)
  const name = parent ? [str(parent['name']), wooVariantLabel(raw)].filter(Boolean).join(' · ') : str(raw['name'])
  const status = str(raw['status']) ?? str(parent?.['status'])
  return {
    externalId,
    sku: str(raw['sku']),
    ean: normalizeEan(eanRaw).ean,
    name: name || null,
    qty,
    active: status === null ? true : status === 'publish',
    ...cenaIVat(raw, parent, pricesIncludeTax, vatByClass),
    imageUrls: wooImages(raw, parent),
  }
}

function cenaIVat(raw: Record<string, unknown>, parent: Record<string, unknown> | null, incl: boolean | null, vatByClass: Map<string, string> | null): { priceGross: number | null; vatRate: string | null } {
  const taxStatus = str(raw['tax_status']) ?? str(parent?.['tax_status'])
  const vatRate = taxStatus === 'none' || taxStatus === 'shipping' ? null : (vatByClass?.get(wooTaxClass(raw, parent)) ?? null)
  const v = raw['regular_price'] || raw['price']
  if (incl === true) return { priceGross: wooBrutto(v, 0), vatRate }
  if (incl === false && vatRate !== null) return { priceGross: wooBrutto(v, Number(vatRate)), vatRate }
  return { priceGross: null, vatRate }
}

/**
 * cena Woo (tekst, do 4 miejsc po przecinku) × (100 + stawka)% zaokrąglona do grosza, połówki w górę.
 * Liczone na liczbach całkowitych z tekstu ceny (netto w 1/10000 zł), bez liczb zmiennoprzecinkowych i bez ucinania
 * netto do 2 miejsc przed mnożeniem. Stawka 0 = sama cena zaokrąglona do grosza. Zła cena = null.
 */
export function wooBrutto(v: unknown, stawka: number): number | null {
  const s = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''
  const m = /^(\d{1,9})(?:\.(\d{1,4}))?$/.exec(s)
  if (!m || !Number.isInteger(stawka) || stawka < 0 || stawka > 100) return null
  const netto = Number(m[1]) * 10000 + Number((m[2] ?? '').padEnd(4, '0')) // ≤ 1e13
  const x = netto * (100 + stawka) + 5000 // w 1/1 000 000 zł, ≤ 2,0e15 < 2^53: dokładne
  const grosze = (x - (x % 10000)) / 10000
  return grosze / 100
}

/** Adresy zdjęć produktu Woo (`images[].src`, wariant: `image.src`, potem zdjęcia produktu nadrzędnego); tylko https. */
export function wooImages(raw: Record<string, unknown>, parent: Record<string, unknown> | null): string[] {
  const of = (r: Record<string, unknown> | null) => {
    if (!r) return []
    const list = Array.isArray(r['images']) ? (r['images'] as Record<string, unknown>[]) : []
    const one = r['image'] && typeof r['image'] === 'object' ? [r['image'] as Record<string, unknown>] : []
    return [...one, ...list].map((i) => str(i?.['src'])).filter((u): u is string => !!u && u.startsWith('https://') && u.length <= 1000)
  }
  return [...new Set([...of(raw), ...of(parent)])].slice(0, 10)
}

function wooVariantLabel(raw: Record<string, unknown>): string | null {
  const attrs = Array.isArray(raw['attributes']) ? (raw['attributes'] as Record<string, unknown>[]) : []
  const s = attrs.map((a) => str(a?.['option'])).filter(Boolean).join(', ')
  return s || null
}

export const WOO_DEFINITION: AdapterDefinition = { manifest: WOO_MANIFEST, create: (ctx) => new WooAdapter(ctx) }
