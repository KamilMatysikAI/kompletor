// Bramka wysyłki do KSeF. Jedno miejsce, które mówi, czy Kompletor może wysłać fakturę albo korektę
// firmy do KSeF i do którego środowiska. Czysty moduł (bez bazy i sieci): woła go wysyłka, ekran i testy.
//
// Warunki (wszystkie naraz):
//   1. program do faktur firmy = „KSeF bezpośrednio”,
//   2. włączone „Wystawiaj faktury z Kompletora” (`settings.faktury.fakturyWlaczone`),
//   3. konto sklepu zamówienia w trybie „Aktywny” (PRACA); zamówienie ręczne bez konta też (prowadzi je Kompletor),
//   4. środowisko firmy wybrane jawnie; domyślnie TEST (`settings.ksef.srodowisko`),
//   5. produkcja (PROD) dodatkowo: dwa klucze operatora instancji (wzór: system najmu, lib/ksef/prod-gate.ts),
//      `KSEF_PROD_ENABLED=1` i NIP firmy na liście `KSEF_PROD_NIPS`. Pusta lista = produkcja zamknięta dla wszystkich.
//      Firma nie zmieni tych zmiennych z panelu; staging i testy ich nie mają, więc nie wyślą prawdziwej faktury.
//   6. w testach (VITEST albo NODE_ENV=test) produkcja jest zamknięta bez względu na zmienne.
import type { ChannelMode } from '@prisma/client'
import type { SrodowiskoFirmy } from '../konfiguracja'

export type Env = Record<string, string | undefined>

/** Bazy API KSeF 2.x (`/v2`, bez prefiksu `/api`, jak w OpenAPI MF). */
export const KSEF_API: Readonly<Record<SrodowiskoFirmy, string>> = {
  TEST: 'https://api-test.ksef.mf.gov.pl/v2',
  DEMO: 'https://api-demo.ksef.mf.gov.pl/v2',
  PROD: 'https://api.ksef.mf.gov.pl/v2',
}

export interface WarunkiWysylki {
  program: string
  fakturyWlaczone: boolean
  trybKonta: ChannelMode | null
  /** Kanał zamówienia; RECZNE bez konfiguracji konta = zamówienie prowadzone w Kompletorze. */
  kanal: string
  srodowisko: SrodowiskoFirmy
  nipSprzedawcy: string | null
}

export type WynikBramki = { dozwolona: true; srodowisko: SrodowiskoFirmy; baza: string } | { dozwolona: false; powod: string }

const cyfry = (s: string) => s.replace(/\D/g, '')

export function nipyProdukcji(env: Env): Set<string> {
  return new Set((env['KSEF_PROD_NIPS'] ?? '').split(/[,;\s]+/).map(cyfry).filter((n) => n.length === 10))
}

const wTestach = (env: Env) => env['VITEST'] !== undefined || env['NODE_ENV'] === 'test'

/** Czy instancja otwiera produkcję KSeF dla firmy o tym NIP-ie (bez pozostałych warunków; ekran ustawień). */
export function produkcjaOtwarta(nip: string | null, env: Env = process.env): { otwarta: boolean; powod: string | null } {
  if (wTestach(env)) return { otwarta: false, powod: 'Produkcja KSeF jest zamknięta w testach.' }
  if (env['KSEF_PROD_ENABLED'] !== '1') return { otwarta: false, powod: 'Produkcyjny KSeF jest wyłączony na tym serwerze: otwiera go operator serwera (KSEF_PROD_ENABLED). Nic nie zostało wysłane.' }
  if (!nip || !nipyProdukcji(env).has(cyfry(nip))) return { otwarta: false, powod: 'Produkcyjny KSeF nie jest otwarty dla NIP-u tej firmy na tym serwerze (lista KSEF_PROD_NIPS u operatora). Nic nie zostało wysłane.' }
  return { otwarta: true, powod: null }
}

export function bramkaWysylki(w: WarunkiWysylki, env: Env = process.env): WynikBramki {
  if (w.program !== 'ksef') return { dozwolona: false, powod: 'Firma nie ma ustawionego programu „KSeF bezpośrednio” (Ustawienia → Dokumenty i faktury → Dokumenty sprzedaży).' }
  if (!w.fakturyWlaczone) return { dozwolona: false, powod: 'Wystawianie faktur z Kompletora jest wyłączone (Ustawienia → Dokumenty i faktury → Dokumenty sprzedaży → „Wystawiaj faktury z Kompletora”).' }
  const kontoOk = w.trybKonta === 'PRACA' || (w.trybKonta === null && w.kanal === 'RECZNE')
  if (!kontoOk) return { dozwolona: false, powod: 'Konto sklepu tego zamówienia jest w trybie „Tylko podgląd”: fakturę wystawia dotychczasowy system.' }
  if (w.srodowisko === 'PROD') {
    const p = produkcjaOtwarta(w.nipSprzedawcy, env)
    if (!p.otwarta) return { dozwolona: false, powod: p.powod! }
  }
  return { dozwolona: true, srodowisko: w.srodowisko, baza: KSEF_API[w.srodowisko] }
}

/**
 * Strażnik adresu każdego żądania (drugi bezpiecznik, niezależny od `bramkaWysylki`): host musi być bazą środowiska,
 * dla którego otwarto połączenie, z HTTPS i bez dodatków w adresie. Połączenie TEST nie trafi na produkcję nawet po
 * błędzie w składaniu ścieżki.
 */
export function sprawdzAdres(srodowisko: SrodowiskoFirmy, url: string): void {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Error('KSeF: zły adres żądania')
  }
  const baza = new URL(KSEF_API[srodowisko])
  if (u.protocol !== 'https:' || u.host !== baza.host || !u.pathname.startsWith('/v2/')) throw new Error(`KSeF: adres spoza środowiska ${srodowisko}`)
  if (u.username || u.password || u.hash) throw new Error('KSeF: adres z dodatkami (dane logowania, kotwica)')
}
