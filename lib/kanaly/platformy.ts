// Kreator „Dodaj sklep”: jeden kafel na platformę zamiast listy wersji adapterów, a w formularzu tylko
// pola konieczne. Platforma = rodzina kanału z manifestu (`channel`), więc kolejny adapter tej samej rodziny wchodzi
// bez zmian tutaj. Wersja z zapisem jest domyślna, gdy jest w rejestrze: odczyt działa tak samo, a zapis zostaje
// wyłączony (`zapisWlaczony`) i w trybie podglądu, dopóki właściciel go nie włączy — przełączanie wersji później nie
// jest potrzebne.
import type { Channel } from '@prisma/client'
import type { AdapterManifest, ConfigField, SecretField } from '../adaptery/kontrakt'
import type { AdapterRegistry } from '../adaptery/rejestr'
import { POLA_POZA_FORMULARZEM, polaSekretow, polaUstawien, rodzajeKanalow } from './konta'

export { POLA_POZA_FORMULARZEM }

export interface Platforma {
  /** Klucz w adresie kreatora (`?platforma=woo`). */
  klucz: string
  channel: Channel
  nazwa: string
  /** Jedno zdanie pod nazwą kafla. */
  opis: string
  /** Skrót na kaflu (bez logo producenta). */
  znak: string
  /** Skąd wziąć klucze: jedno zdanie + strona Pomocy. */
  skadKlucze: string
  pomoc: string
  /** Domyślna wersja adaptera (z zapisem, gdy jest) i pozostałe wersje tej platformy. */
  adapterKey: string
  wersje: AdapterManifest[]
}

const OPIS: Partial<Record<Channel, Omit<Platforma, 'channel' | 'adapterKey' | 'wersje'>>> = {
  WOO: {
    klucz: 'woo',
    nazwa: 'WooCommerce',
    opis: 'Sklep na WordPressie.',
    znak: 'Woo',
    skadKlucze: 'W panelu WordPressa: WooCommerce → Ustawienia → Zaawansowane → REST API → Dodaj klucz (uprawnienia: Odczyt). Klucz z prawem zapisu dodasz później, gdy włączysz zapis.',
    pomoc: '/pomoc/integracje-woocommerce',
  },
  SHOPER: {
    klucz: 'shoper',
    nazwa: 'Shoper',
    opis: 'Sklep w Shoperze.',
    znak: 'Sh',
    skadKlucze: 'W panelu Shopera: Konfiguracja → Administracja, system → Administratorzy → nowy administrator z dostępem do API (login i hasło).',
    pomoc: '/pomoc/integracje-shoper',
  },
  PRESTASHOP: {
    klucz: 'prestashop',
    nazwa: 'PrestaShop',
    opis: 'Sklep na PrestaShop.',
    znak: 'PS',
    skadKlucze: 'W panelu PrestaShop: Zaawansowane → Webservice → włącz i dodaj klucz z dostępem do zamówień, produktów i stanów.',
    pomoc: '/pomoc/integracje-prestashop',
  },
  IDOSELL: {
    klucz: 'idosell',
    nazwa: 'IdoSell',
    opis: 'Sklep w IdoSell.',
    znak: 'Ido',
    skadKlucze: 'W panelu IdoSell utwórz klucz Admin API z dostępem do zamówień i produktów (moduł API albo „Aplikacje indywidualne” w Administracji). Adres to adres panelu, np. https://client12345.idosell.com.',
    pomoc: '/pomoc/integracje-idosell',
  },
  ALLEGRO: {
    klucz: 'allegro',
    nazwa: 'Allegro',
    opis: 'Konto sprzedawcy Allegro.',
    znak: 'A',
    skadKlucze: 'Na apps.developer.allegro.pl zarejestruj aplikację (bez dostępu do przeglądarki) i skopiuj Client ID i Client Secret. Po zapisie klikniesz „Połącz z Allegro”.',
    pomoc: '/pomoc/integracje-allegro',
  },
  EMPIK: {
    klucz: 'empik',
    nazwa: 'Empik',
    opis: 'Empik Marketplace.',
    znak: 'E',
    skadKlucze: 'W panelu sprzedawcy Empiku: Ustawienia konta → Klucz API (użyj istniejącego klucza, nie generuj nowego, jeśli korzysta z niego inny program).',
    pomoc: '/pomoc/integracje-empik',
  },
}

/** Kolejność kafli. */
const KOLEJNOSC: readonly Channel[] = ['WOO', 'SHOPER', 'PRESTASHOP', 'IDOSELL', 'ALLEGRO', 'EMPIK']

/** Platformy z rejestru (tylko te, które mają adapter kanału z odczytem zamówień), w stałej kolejności. */
export function platformy(registry: AdapterRegistry): Platforma[] {
  const rodzaje = rodzajeKanalow(registry)
  const out: Platforma[] = []
  for (const ch of KOLEJNOSC) {
    const o = OPIS[ch]
    const wersje = rodzaje.filter((m) => m.channel === ch)
    if (!o || !wersje.length) continue
    const zZapisem = wersje.find((m) => !m.readOnly)
    out.push({ ...o, channel: ch, adapterKey: (zZapisem ?? wersje[0]!).adapterKey, wersje })
  }
  return out
}

/** Nazwa platformy dla człowieka (podtytuł konta, kolumna „Rodzaj” listy); bez nazw technicznych z manifestu. */
export function nazwaPlatformy(channel: Channel): string | null {
  return OPIS[channel]?.nazwa ?? null
}

/** Platforma po kluczu z adresu albo po starym `?rodzaj=<adapterKey>` (linki). */
export function platformaZAdresu(registry: AdapterRegistry, sp: { platforma?: string; rodzaj?: string }): Platforma | null {
  const lista = platformy(registry)
  if (sp.platforma) return lista.find((p) => p.klucz === sp.platforma) ?? null
  if (sp.rodzaj) return lista.find((p) => p.wersje.some((m) => m.adapterKey === sp.rodzaj)) ?? null
  return null
}

/** Etykiety pól manifestu dla człowieka; opis z manifestu zostaje jako podpowiedź pod polem. */
const ETYKIETY: Record<string, string> = {
  baseUrl: 'Adres sklepu',
  wersjaApi: 'Wersja API',
  magazyn: 'Numer magazynu w sklepie',
  strefa: 'Strefa czasowa',
  apiUrl: 'Adres API',
  authUrl: 'Adres autoryzacji',
  userAgent: 'Nazwa aplikacji (User-Agent)',
  pollIntervalSec: 'Odczyt zamówień co (s)',
  overlapMinutes: 'Zakładka odczytu (min)',
  pageSize: 'Zamówień na stronę',
  holdStockMinutes: 'Trzymanie stanu w sklepie (min)',
  zapisWlaczony: 'Zapis do sklepu',
  wystawianieOfertWlaczone: 'Wystawianie ofert',
  cennikDostawId: 'Cennik dostaw (Allegro)',
  zwrotyId: 'Warunki zwrotów (Allegro)',
  reklamacjeId: 'Warunki reklamacji (Allegro)',
  akceptacjaBraki: 'Przyjmowanie zamówień: gdy brakuje towaru',
  akceptacjaAlertGodzin: 'Alert, gdy zamówienie czeka na przyjęcie (godz.)',
  kodyPrzewoznikow: 'Kody przewoźników',
  magazynEmpik: 'Magazyn w Empiku',
  nipMetaKey: 'Pole z NIP-em w zamówieniu',
  pickupPointMetaKey: 'Pole z punktem odbioru',
  invoiceMetaKey: 'Pole „chcę fakturę”',
  nadanieNotatka: 'Numer nadania jako notatka',
  nadanieDlaKlienta: 'Notatka z numerem widoczna dla klienta',
  nadanieMetaKlucz: 'Pole z numerem nadania (wtyczka śledzenia)',
}

export function etykietaPola(key: string): string {
  return ETYKIETY[key] ?? key
}

/**
 * Wartości domyślne pól, które kreator wypełnia sam (pole zostaje edytowalne w „Zaawansowane”). User-Agent Allegro
 * wymaga formatu „Nazwa/Wersja (+URL)”: bez niego właściciel musiałby znać wymóg API.
 */
export function domyslnaWartosc(m: AdapterManifest, key: string, env: Record<string, string | undefined>): string {
  if (m.channel === 'ALLEGRO' && key === 'userAgent') {
    const url = (env.APP_PUBLIC_URL || env.PANEL_URL || 'https://kompletor.pl').trim().replace(/\/+$/, '')
    return `Kompletor/1.0 (+${/^https?:\/\/\S+$/.test(url) ? url : 'https://kompletor.pl'})`
  }
  return ''
}

/**
 * Podział pól formularza: w widoku domyślnym tylko to, bez czego konto nie ruszy (wymagane ustawienia bez wartości
 * domyślnej i klucze), reszta w „Zaawansowane”. Wymagane pole z wartością domyślną (np. User-Agent) idzie do
 * zaawansowanych z wypełnioną wartością; opcjonalne klucze także.
 */
const BEZ_KREATORA = POLA_POZA_FORMULARZEM

export function podzialPol(
  m: AdapterManifest,
  env: Record<string, string | undefined>,
): { podstawowe: ConfigField[]; zaawansowane: ConfigField[]; klucze: SecretField[]; kluczeZaawansowane: SecretField[] } {
  const podstawowe: ConfigField[] = []
  const zaawansowane: ConfigField[] = []
  // wyłącznik zapisu tylko na ekranie konta: nowe konto zawsze startuje bez zapisu
  for (const f of polaUstawien(m).filter((x) => !BEZ_KREATORA.has(x.key))) (f.required && !domyslnaWartosc(m, f.key, env) ? podstawowe : zaawansowane).push(f)
  const sek = polaSekretow(m)
  // opcjonalne klucze (np. osobny klucz zapisu Woo) też w „Zaawansowane”
  return { podstawowe, zaawansowane, klucze: sek.filter((s) => s.required), kluczeZaawansowane: sek.filter((s) => !s.required) }
}
