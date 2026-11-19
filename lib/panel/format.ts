// Formatowanie dla panelu: kwoty, ilości w jednostce bazowej, daty w strefie Warszawy, nazwy statusów.
// Czyste funkcje — testy w format.test.ts.
import type { Carrier, Channel, InvoiceState, OrderStatus, PaymentState, ShortageState, Unit } from '@prisma/client'
import { toWarsaw } from '@/lib/rdzen/kalendarz'

const TZ = 'Europe/Warsaw'
const NBSP = ' '

const plMoney = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: true })
const plInt = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 0, useGrouping: true })
const plDec = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 3, useGrouping: true })

// Intl w pl-PL nie grupuje liczb czterocyfrowych („1863,50”); w panelu chcemy „1 863,50” jak w makietach.
function group(s: string): string {
  return s.replace(/^(-?\d+)(\d{3})([,\s]|$)/, (_m, a: string, b: string, c: string) => `${a}${NBSP}${b}${c}`).replace(/ /g, NBSP)
}

export function money(v: number | string | { toString(): string } | null | undefined): string {
  if (v === null || v === undefined) return '—'
  const n = typeof v === 'number' ? v : Number(v.toString())
  if (!Number.isFinite(n)) return '—'
  return `${group(plMoney.format(n))}${NBSP}zł`
}

export function int(n: number): string {
  return group(plInt.format(n))
}

/** Ilość w jednostce bazowej produktu: sztuki albo gramy (≥ 1000 g → kg). */
export function qty(n: number, unit: Unit): string {
  if (unit === 'SZT') return `${int(n)}${NBSP}szt.`
  if (Math.abs(n) >= 1000) return `${group(plDec.format(n / 1000))}${NBSP}kg`
  return `${int(n)}${NBSP}g`
}

const dayFmt = new Intl.DateTimeFormat('pl-PL', { timeZone: TZ, day: '2-digit', month: '2-digit' })
const timeFmt = new Intl.DateTimeFormat('pl-PL', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const longDayFmt = new Intl.DateTimeFormat('pl-PL', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' })
const monthFmt = new Intl.DateTimeFormat('pl-PL', { timeZone: TZ, month: 'long' })

export function time(t: Date): string {
  return timeFmt.format(t)
}

/** „dziś 09:12”, „wczoraj 20:02”, „16.10 10:05” (data względem `now`, strefa Warszawy). */
export function when(t: Date, now = new Date()): string {
  const d = toWarsaw(t).day
  const today = toWarsaw(now).day
  const y = toWarsaw(new Date(now.getTime() - 86400_000)).day
  if (d === today) return `dziś ${time(t)}`
  if (d === y) return `wczoraj ${time(t)}`
  return `${dayFmt.format(t)} ${time(t)}`
}

export function longDay(t: Date): string {
  const s = longDayFmt.format(t)
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Nazwa miesiąca w mianowniku: „październik”. */
export function monthName(t: Date): string {
  return monthFmt.format(t)
}

export const STATUS_LABEL: Record<OrderStatus, string> = {
  NOWE: 'Nowe',
  DO_REALIZACJI: 'Do realizacji',
  ZBIERANIE: 'Zbieranie',
  ZEBRANE: 'Zebrane',
  SPAKOWANE: 'Spakowane',
  DO_WYSLANIA: 'Do wysłania',
  DO_ODBIORU: 'Do odbioru',
  WYSLANE: 'Wysłane',
  ODEBRANE: 'Odebrane',
  ANULOWANE: 'Anulowane',
  DO_WYJASNIENIA: 'Do wyjaśnienia',
  REKLAMACJA: 'Reklamacja',
}

export function statusTone(s: OrderStatus): '' | 'done' | 'warn' | 'cancel' {
  if (s === 'DO_WYJASNIENIA' || s === 'REKLAMACJA') return 'warn'
  if (s === 'ANULOWANE') return 'cancel'
  if (s === 'SPAKOWANE' || s === 'DO_WYSLANIA' || s === 'DO_ODBIORU' || s === 'WYSLANE' || s === 'ODEBRANE') return 'done'
  return ''
}

export const CARRIER_LABEL: Record<Carrier, string> = {
  PACZKOMATY: 'Paczkomaty',
  DPD: 'DPD',
  DPD_EMPIK: 'DPD do salonu Empik',
  INPOST_KURIER: 'InPost kurier',
  ORLEN_PACZKA: 'Orlen Paczka',
  GLS: 'GLS',
  POCZTA_POLSKA: 'Poczta Polska',
  ALLEGRO: 'Allegro',
  OSOBISTY: 'Odbiór osobisty',
  BRAK: 'bez przewoźnika',
  BEZ_WYSYLKI: 'Bez wysyłki',
}

export const PAYMENT_LABEL: Record<PaymentState, string> = {
  PAID: 'opłacone',
  UNPAID: 'nieopłacone',
  COD: 'za pobraniem',
  PARTIAL: 'niedopłata',
}

export const CHANNEL_LABEL: Record<Channel, string> = {
  WOO: 'Sklep',
  ALLEGRO: 'Allegro',
  EMPIK: 'Empik',
  EASYTOOLS: 'EasyTools',
  BL_INNE: 'Inne (przez BL)',
  RECZNE: 'Ręczne',
  AI: 'Asystent AI',
  SHOPER: 'Shoper',
  PRESTASHOP: 'PrestaShop',
  IDOSELL: 'IdoSell',
}

export const SHORTAGE_LABEL: Record<ShortageState, string> = {
  OPEN: 'brakuje',
  SHIP_LATER: 'dośle później',
  RESOLVED: 'dostało towar',
  REFUND_PENDING: 'do zwrotu pieniędzy',
  REFUNDED: 'zwrócone',
  COD_REDUCED: 'pobranie zmniejszone',
  CANCELLED: 'anulowane',
}

export const INVOICE_LABEL: Record<InvoiceState, string> = {
  SENDING: 'wysyłana do wFirmy',
  UNKNOWN: 'sprawdzamy w wFirmie',
  ISSUED: 'wystawiona',
  FAILED: 'nie wystawiła się',
}

const EVENT_LABEL: Record<string, string> = {
  PRZYJETE: 'Zamówienie przyjęte',
  OPLACONE: 'Opłacone',
  EDYCJA: 'Zmiana w kanale',
  EDYCJA_PO_ANULOWANIU: 'Zmiana w kanale po anulowaniu',
  ANULOWANE: 'Anulowane',
  ANULOWANIE_ODLOZONE: 'Anulowanie czeka na fakturę',
  COFNIETY_STATUS: 'Kanał cofnął status',
  DOSLE_POZNIEJ: 'Dośle później',
  DECYZJA_BRAK: 'Decyzja o braku',
  ZAMIANA_PRODUKTU: 'Zamiana produktu',
  ZWROCONE: 'Zwrot pieniędzy zrobiony',
  FAKTURA: 'Faktura wystawiona',
  FAKTURA_BL: 'Faktura z BaseLinkera',
  FAKTURA_BL_POMINIETA: 'Bez faktury z Kompletora: zamówienie ma już fakturę z BaseLinkera',
  ZAMKNIETE_PRZY_PRZEJSCIU: 'Zamknięte przy przejściu z BaseLinkera (obsłużone w BaseLinkerze)',
  WZ_WFIRMY: 'Rozliczone dokumentem WZ z wFirmy',
  WZ_WYSTAWIONE: 'WZ wystawione w wFirmie',
  DOKUMENT_WYSTAWIONY_RECZNIE: 'Biuro potwierdziło dokument wystawiony ręcznie w programie do faktur',
  POPRAWIONE_W_WFIRMIE: 'Biuro potwierdziło poprawkę w wFirmie: pozycja „Do poprawy w wFirmie” zamknięta, stan wraca do stanu z wFirmy',
  WZ_PO_NUMERZE_WFIRMY: 'Faktura z BaseLinkera rozliczona dokumentem WZ z wFirmy (numer z wFirmy dopisany po skopiowaniu faktury)',
  PARA_BL: 'Połączone z zamówieniem BaseLinkera',
  PUNKT_ODBIORU_ZMIENIONY: 'Punkt odbioru zmieniony przed nadaniem', // (bez kodów punktu: dane dostawy)
  SPOSOB_WYSYLKI_ZMIENIONY: 'Sposób wysyłki zmieniony na karcie', // przewoźnik i moduł przed i po, bez danych dostawy
  DANE_KLIENTA_ZMIENIONE: 'Dane klienta zmienione na karcie', // kupujący albo dane do faktury: same nazwy pól, bez wartości
  FAKTURA_BLAD: 'Faktura się nie wystawiła',
  KOREKTA: 'Korekta faktury',
  NADMIAR_DO_BRAKUJE: 'Przeniesione do „brakuje”',
  NIE_MA_NA_POLCE: 'Nie ma na półce',
  BRAK_COFNIETY: 'Brak cofnięty: jednak jest na półce',
  JEDNAK_W_PACZCE: 'Brak zamknięty: towar jednak był w paczce (bez zwrotu)',
  ODRZUCONE_PRZY_AKCEPTACJI: 'Pozycje odrzucone przy akceptacji',
  OPLACONE_PO_ANULOWANIU: 'Opłacone po anulowaniu',
  PLATNOSC_PO_ANULOWANIU: 'Płatność po anulowaniu',
  PRZYDZIAL_DOSTAWY: 'Dostało towar z dostawy',
  PRZYPOMNIENIE_WYSLALBYM: 'Przypomnienie o płatności (tylko podgląd, bez wysyłki)',
  SPAKOWANE: 'Spakowane',
  WYJASNIONE: 'Wyjaśnione',
  // przejścia z ekranów (moveOrder zapisuje status docelowy jako rodzaj zdarzenia)
  ZBIERANIE: 'Zbieranie rozpoczęte',
  ZBIERANIE_COFNIETE: 'Zbieranie przerwane',
  ZEBRANE: 'Zebrane',
  DO_WYSLANIA: 'Do wysłania',
  DO_ODBIORU: 'Do odbioru',
  WYSLANE: 'Wysłane',
  ODEBRANE: 'Odebrane',
  DO_WYJASNIENIA: 'Do wyjaśnienia',
  PRZYWROCONE_W_KANALE: 'Przywrócone w kanale',
  NIEUDANA_PLATNOSC_OTWARTE: 'Nieudana płatność w sklepie: zamówienie otwarte, czeka na wpłatę',
  NIEUDANA_PLATNOSC_PO_TERMINIE: 'Nieudana płatność w sklepie: anulowane, nieopłacone po terminie',
  NIEUDANA_PLATNOSC_ONLINE: 'Nieudana płatność online w sklepie: towar wróci do sprzedaży po czasie z zasad rezerwacji',
  PLATNOSC_OFFLINE: 'Klient wybrał przelew tradycyjny: zamówienie trzyma towar do zwykłego terminu',
  TOWAR_ZWOLNIONY: 'Towar zwolniony: płatność online nieudana. Zamówienie czeka na płatność',
  TOWAR_ZAREZERWOWANY_PONOWNIE: 'Towar zarezerwowany ponownie po zwolnieniu',
  ZWROT: 'Zwrot zgłoszony',
  ZWROT_PRZYJETY: 'Zwrot przyjęty',
  ZWROT_ODRZUCONY: 'Zwrot odrzucony',
  ZWROT_PIENIEDZY: 'Pieniądze za zwrot oddane',
  KOREKTA_ZLECONA: 'Korekta faktury zlecona',
  KOREKTA_PONOWIONA: 'Korekta faktury ponowiona',
  // karta zamówienia
  POZYCJA_DODANA: 'Dodana pozycja w Kompletorze',
  POZYCJA_USUNIETA: 'Usunięta pozycja w Kompletorze',
  ZMIANA_ILOSCI: 'Zmiana ilości w Kompletorze',
  ZMIANA_CENY: 'Zmiana ceny albo VAT w Kompletorze',
  RABAT_ROZLOZONY: 'Rabat sklepu na całe zamówienie rozłożony na ceny pozycji',
  KOSZT_WYSYLKI_ZE_SKLEPU: 'Koszt wysyłki uzupełniony ze sklepu', // runda 2
  KWOTA_Z_KANALU: 'Wartość zamówienia poprawiona ze sklepu',
  ZMIANA_W_KANALE_PO_EDYCJI: 'Zmiana w kanale po edycji w Kompletorze',
  PODZIAL: 'Podział zamówienia',
  PODZIAL_NOWA_PACZKA: 'Nowa paczka z podziału',
  DOPLATA_ZAPISANA: 'Dopłata zapisana',
  ZWROT_ROZNICY: 'Zwrot różnicy zapisany',
  // przyjmowanie zamówień Empiku
  EMPIK_ZAAKCEPTOWALBYM: 'Empik: zaakceptowałbym zamówienie (podgląd, nic nie wysłane)',
  EMPIK_PRZYJETE: 'Przyjęte w Empiku',
  EMPIK_PRZYJECIE_DO_DECYZJI: 'Empik: przyjęcie czeka na decyzję',
  EMPIK_PRZYJECIE_BLAD: 'Empik: przyjęcie nie przeszło',
  EMPIK_PRZYJECIE_NIEAKTUALNE: 'Empik: zamówienie już anulowane albo odrzucone w Empiku, nie przyjęte',
  // zmiana statusu z listy na karcie (z powodem)
  STATUS_RECZNIE: 'Zmiana statusu ręcznie',
  // automatyczne akcje firmy (Ustawienia → Automatyczne akcje)
  AUTOMAT: 'Automatyczna akcja',
  AUTOMAT_POMINIETY: 'Automatyczna akcja pominięta',
  PRZESYLKA_STATUS: 'Status przesyłki u przewoźnika',
  PRZESYLKA_STAN: 'Przesyłka',
  PRZESYLKA_DODATKOWA: 'Dodatkowa przesyłka utworzona',
}

export function eventLabel(kind: string): string {
  return EVENT_LABEL[kind] ?? kind.toLowerCase().replace(/_/g, ' ')
}

/**
 * Przedrostek numeru zamówienia jak w makietach (SD 48213, ALG …, EMP …): Allegro i Empik stałe, sklep z inicjałów
 * nazwy konta („SklepPrzyprawowy” → SP, „LampyDemo” → LD). Docelowo przedrostek z konfiguracji konta kanału.
 */
export function channelPrefix(channel: Channel, accountName: string | null | undefined): string {
  switch (channel) {
    case 'ALLEGRO':
      return 'ALG'
    case 'EMPIK':
      return 'EMP'
    case 'EASYTOOLS':
      return 'ET'
    case 'RECZNE':
      return 'RĘ'
    case 'BL_INNE':
      return 'BL'
    case 'AI':
      return 'AI'
  }
  const name = (accountName ?? '').trim()
  if (!name || name === SHOP_WITHOUT_NAME) return 'SKL'
  // adres sklepu jako nazwa zastępcza (np. sklep-przyprawy.pl) → bez www i domeny najwyższego poziomu
  const base = /^[\w.-]+\.[a-z]{2,}$/i.test(name) ? name.replace(/^www\./i, '').replace(/\.[a-z]{2,}$/i, '') : name
  // tylko słowa zaczynające się literą (bez „(”, cyfr) —
  const words = base
    .replace(/([a-ząćęłńóśźż])([A-ZĄĆĘŁŃÓŚŹŻ])/g, '$1 $2')
    .split(/[\s_.()-]+/)
    .filter((w) => /^\p{L}/u.test(w))
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase()
  const initials = words.map((w) => w[0]!.toUpperCase()).join('').slice(0, 3)
  return initials || 'SKL'
}

/** Numer z kanału do wyświetlenia: długie identyfikatory (Allegro) skrócone do 9 znaków. */
export function shortExternalId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 9)}…` : id
}

/**
 * Nazwa konta kanału do pokazania w panelu (dodatek właściciela): nazwa z konfiguracji konta
 * (`ChannelConfig.name`), a gdy jej nie ma albo jest tylko numerem/identyfikatorem z BaseLinkera — nazwa rodzaju
 * kanału. Surowe id konta (numer z BaseLinkera) nigdy nie trafia na ekran.
 */
export function accountDisplayName(channel: Channel, channelAccountId: string, configName?: string | null, config?: unknown): string {
  const n = configName?.trim()
  if (n && n !== channelAccountId && !/^[\d\s_:-]+$/.test(n) && !/^shop_\d+$/i.test(n)) return n
  if (channel !== 'WOO' && channel !== 'SHOPER' && channel !== 'PRESTASHOP' && channel !== 'IDOSELL') return CHANNEL_LABEL[channel]
  // dwa sklepy bez nazwy mają być rozróżnialne: domena z adresu sklepu w konfiguracji konta (config.baseUrl)
  return hostOf(config) ?? SHOP_WITHOUT_NAME
}

export const SHOP_WITHOUT_NAME = 'Sklep bez nazwy'

function hostOf(config: unknown): string | null {
  const url = config && typeof config === 'object' ? (config as Record<string, unknown>).baseUrl : null
  if (typeof url !== 'string') return null
  try {
    return new URL(url).hostname.replace(/^www\./i, '') || null
  } catch {
    return null
  }
}

/** Odmiana przymiotnika liczebnikowego: 1 zrealizowane, 2–4 zrealizowane, 5+ (i 12–14) zrealizowanych. */
function plAdj(n: number, few: string, many: string): string {
  const d = n % 10
  const h = n % 100
  return n === 1 || (d >= 2 && d <= 4 && (h < 12 || h > 14)) ? few : many
}

/**
 * Czy anulowane zamówienia wchodzą do liczby i kwoty sprzedaży dnia/miesiąca na pulpicie. `false`:
 * nie wchodzą, a adnotacja podaje ich liczbę osobno. Jeśli BL liczy anulowane w „dziś”, wystarczy przełączyć na `true`.
 */
export const SALES_COUNT_CANCELLED = false

/**
 * Adnotacja pod sprzedażą dnia/miesiąca: ile z policzonych zamówień nie ma w realizacji systemu, plus
 * anulowane — „poza tym”, gdy nie liczą się do sprzedaży, „w tym”, gdy się liczą. `null`, gdy nie ma czego
 * dopisać.
 */
export function outsideCoreNote(o: { beforeStart: number; notIngested: number; skipped: number; cancelled: number }, countCancelled = SALES_COUNT_CANCELLED): string | null {
  const parts: string[] = []
  if (o.notIngested > 0) parts.push(`${int(o.notIngested)} jeszcze ${plAdj(o.notIngested, 'nieprzyjęte', 'nieprzyjętych')} do realizacji`)
  if (o.skipped > 0) parts.push(`${int(o.skipped)} ${plAdj(o.skipped, 'pominięte', 'pominiętych')} przy przyjmowaniu`)
  // na końcu, bo zdanie z „zanim” zamyka się dopiero nawiasem
  if (o.beforeStart > 0) parts.push(`${int(o.beforeStart)} ${plAdj(o.beforeStart, 'zrealizowane', 'zrealizowanych')}, zanim system zaczął czytać konto`)
  const notes: string[] = []
  if (parts.length) notes.push(`w tym ${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} i ${parts[parts.length - 1]}` : parts[0]} (nie ma ich w realizacji systemu)`)
  if (o.cancelled > 0) notes.push(`${countCancelled ? 'w tym' : 'poza tym'} ${int(o.cancelled)} ${plAdj(o.cancelled, 'anulowane', 'anulowanych')}`)
  return notes.length ? notes.join(' · ') : null
}
