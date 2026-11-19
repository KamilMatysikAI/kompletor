// Autoryzacja konta Allegro przez device flow: `npm run cien -- allegro-autoryzuj [--konto <id>]`
// (`--konto` wymagane, gdy firma ma kilka kont Allegro; przy jednym konto jest brane z bazy)
// (w obrazie: `node dist/cien.cjs allegro-autoryzuj`). Własna para tokenów Kompletora w istniejącej aplikacji Allegro
// firmy — nigdy cudza (refresh token jest jednorazowy). Przebieg: POST <auth>/auth/oauth/device (tylko zakres
// allegro:api:orders:read) → link dla właściciela konta → odpytywanie POST <auth>/auth/oauth/token co `interval` s
// (authorization_pending, slow_down +5 s, access_denied, wygaśnięcie kodu) → zapis pary w zaszyfrowanych sekretach
// konta (lib/adaptery/rotacja-sekretow.ts, jak rotacja adaptera) → test połączenia.
// `--z-przesylkami` dokłada zakres allegro:api:shipments:read (odczyt przesyłek, Wysyłam z Allegro) i test
// zakresu przesyłek. Bez flagi żądanie jest dokładnie takie jak wcześniej. Zakresu zapisu przesyłek komenda nie prosi:
// to osobna decyzja właściciela konta (docs/wysylam-z-allegro.md).
// `--z-ofertami` dokłada zakres allegro:api:sale:offers:read (lista ofert konta, „Pobierz oferty” i mapowanie
// ofert po SKU bez BL) i po zapisie czyta pierwszą stronę ofert (wypisuje tylko liczbę). Nowa autoryzacja zastępuje
// poprzednią parę tokenów: zakres, który ma zostać (np. przesyłki), trzeba podać razem (`--z-przesylkami --z-ofertami`).
// Komenda NIGDY nie wypisuje tokenów, `device_code` ani Client Secret — także w błędach (tylko kody OAuth).
import type { PrismaClient } from '@prisma/client'
import { ALLEGRO_DEFINITION, ALLEGRO_SECRETS as S } from '../lib/adaptery/allegro'
import { hasOfferReader } from '../lib/adaptery/kontrakt'
import { accountInputs, createAccountAdapter, loadChannelAccounts } from '../lib/adaptery/konta'
import { validateAccountConfig, validateAccountSecrets, type AdapterRegistry } from '../lib/adaptery/rejestr'
import { writeAccountSecrets } from '../lib/adaptery/rotacja-sekretow'
import type { SecretSource } from '../lib/sekrety'
import {
  ALLEGRO_AUTH_URL,
  ALLEGRO_OFFERS_READ_SCOPE,
  ALLEGRO_ORDERS_READ_SCOPE,
  AllegroOAuthError,
  type AllegroOAuthClient,
  type AllegroTokenSet,
  pollAllegroDeviceToken,
  requestAllegroDeviceCode,
} from '../lib/zrodla/allegro'
import { ALLEGRO_SHIPMENTS_READ_SCOPE } from '../lib/zrodla/allegro-wysylam'
import { allegroZakresy } from '../lib/zrodla/allegro-zakresy'
import { sleep, type FetchLike } from '../lib/zrodla/http'
import { allegroWysylamTest } from './allegro-wysylam'

/**
 * Zakres device flow: odczyt zamówień, z flagą `--z-przesylkami` także odczyt przesyłek, z `--z-ofertami` odczyt ofert
 * (spacją, jak w OAuth). Bez flag dokładnie jak wcześniej.
 */
export function allegroScope(zPrzesylkami = false, zOfertami = false): string {
  // zakresy z jednego źródła (lib/zrodla/allegro-zakresy.ts), wynik bez zmian
  return allegroZakresy([...(zPrzesylkami ? (['przesylki'] as const) : []), ...(zOfertami ? (['oferty'] as const) : [])])
}

/** Opis zakresu dla właściciela konta (bez technicznych nazw). */
function zakresOpis(scope: string | null): string {
  const s = scope?.split(' ') ?? []
  const czesci = ['odczyt zamówień', ...(s.includes(ALLEGRO_SHIPMENTS_READ_SCOPE) ? ['odczyt przesyłek'] : []), ...(s.includes(ALLEGRO_OFFERS_READ_SCOPE) ? ['odczyt ofert'] : [])]
  return 'tylko ' + (czesci.length > 1 ? `${czesci.slice(0, -1).join(', ')} i ${czesci.at(-1)}` : czesci[0])
}

export interface DeviceFlowDeps {
  oauth: AllegroOAuthClient
  /** Zakres (null = bez parametru `scope`, pełne uprawnienia aplikacji). */
  scope: string | null
  out: (line: string) => void
  wait?: (ms: number) => Promise<void>
  now?: () => number
}

export type DeviceFlowResult = { ok: true; tokens: AllegroTokenSet } | { ok: false; reason: 'odmowa' | 'wygasl' | 'blad'; message: string }

/**
 * Device flow bez bazy (testowalny na atrapie): wypisuje wyłącznie link (`verification_uri_complete`, obok
 * `verification_uri` i `user_code`) i czas ważności; zwraca parę tokenów albo powód przerwania. Bez zapisu.
 */
export async function runDeviceFlow(d: DeviceFlowDeps): Promise<DeviceFlowResult> {
  const wait = d.wait ?? sleep
  const now = d.now ?? Date.now
  let code
  try {
    code = await requestAllegroDeviceCode(d.oauth, d.scope)
  } catch (e) {
    return { ok: false, reason: 'blad', message: `nie udało się rozpocząć autoryzacji (${oauthMsg(e)})` }
  }
  const minutes = Math.max(1, Math.round(code.expiresInSec / 60))
  const zakres = zakresOpis(d.scope)
  d.out(`Otwórz link i zatwierdź dostęp Kompletora do konta Allegro (${zakres}):`)
  d.out(`  ${code.verificationUriComplete}`)
  d.out(`(albo wejdź na ${code.verificationUri} i wpisz kod ${code.userCode}). Link jest ważny ok. ${minutes} min.`)
  const deadline = now() + code.expiresInSec * 1000
  let interval = code.intervalSec
  for (;;) {
    if (now() >= deadline) return { ok: false, reason: 'wygasl', message: 'kod autoryzacji wygasł przed zatwierdzeniem — uruchom komendę jeszcze raz' }
    await wait(interval * 1000)
    try {
      return { ok: true, tokens: await pollAllegroDeviceToken(d.oauth, code.deviceCode) }
    } catch (e) {
      if (!(e instanceof AllegroOAuthError)) return { ok: false, reason: 'blad', message: 'nieoczekiwany błąd odpytywania' }
      if (e.code === 'authorization_pending') continue
      if (e.code === 'slow_down') {
        interval += 5
        continue
      }
      if (e.code === 'access_denied') return { ok: false, reason: 'odmowa', message: 'właściciel konta odmówił dostępu — nic nie zapisano' }
      if (e.code === 'expired_token' || e.code === 'invalid_grant') return { ok: false, reason: 'wygasl', message: 'kod autoryzacji wygasł albo jest nieważny — uruchom komendę jeszcze raz' }
      if (e.retryable) continue
      return { ok: false, reason: 'blad', message: `autoryzacja przerwana (${oauthMsg(e)})` }
    }
  }
}

/** Komunikat błędu OAuth bez treści żądania: tylko kod i status (AllegroOAuthError nie niesie wartości). */
function oauthMsg(e: unknown): string {
  return e instanceof AllegroOAuthError ? `${e.code}, HTTP ${e.status}` : 'błąd'
}

export interface AuthorizeOpts {
  channelAccountId?: string
  registry: AdapterRegistry
  src: SecretSource
  fetch?: FetchLike
  out?: (line: string) => void
  wait?: (ms: number) => Promise<void>
  /** `--z-przesylkami`: zakres także na odczyt przesyłek i test Wysyłam z Allegro po zapisie. */
  zPrzesylkami?: boolean
  /** `--z-ofertami`: zakres także na odczyt ofert i próba odczytu pierwszej strony ofert po zapisie. */
  zOfertami?: boolean
}

/**
 * Pełna komenda: konto ALLEGRO z firmy klienta `db`, Client ID i Secret z sekretów konta albo (self-host) env
 * z przedrostkiem konta, device flow, zapis pary (jedna transakcja, skasowany znacznik odrzuconego tokena), test
 * połączenia adaptera. Zwraca kod wyjścia (0 = ok).
 */
export async function authorizeAllegro(db: PrismaClient, o: AuthorizeOpts): Promise<number> {
  const out = o.out ?? ((l: string) => console.log(l))
  // bez stałego konta w kodzie. Bez --konto: jedyne konto Allegro firmy (najpierw aktywne); kilka = odmowa.
  const allegro = (await loadChannelAccounts(db, { activeOnly: false })).filter((a) => a.channel === 'ALLEGRO')
  const aktywne = allegro.filter((a) => a.active)
  const kandydaci = o.channelAccountId ? allegro.filter((a) => a.channelAccountId === o.channelAccountId) : aktywne.length ? aktywne : allegro
  if (kandydaci.length > 1) {
    out(`[allegro] firma ma kilka kont Allegro (${kandydaci.map((a) => a.channelAccountId).join(', ')}) — wskaż jedno: --konto <id>`)
    return 2
  }
  const acc = kandydaci[0]
  if (!acc) {
    out(`[allegro] brak konta ALLEGRO${o.channelAccountId ? `/${o.channelAccountId}` : ''} w firmie (preset firmy albo panel) — nic nie zrobiono`)
    return 2
  }
  const id = acc.channelAccountId
  const manifest = ALLEGRO_DEFINITION.manifest
  const inputs = await accountInputs(db, acc, manifest, o.src)
  const cfg = validateAccountConfig(manifest, inputs.rawConfig)
  const sec = validateAccountSecrets({ ...manifest, secrets: manifest.secrets.filter((s) => s.name === S.clientId || s.name === S.clientSecret) }, inputs.rawSecrets)
  if (cfg.problems.length || sec.problems.length) {
    out(`[allegro] konto ${acc.name}: ${[...cfg.problems, ...sec.problems].join('; ')}`)
    return 2
  }
  const oauth: AllegroOAuthClient = {
    authUrl: String(cfg.config['authUrl'] ?? ALLEGRO_AUTH_URL),
    clientId: sec.secrets[S.clientId]!,
    clientSecret: sec.secrets[S.clientSecret]!,
    userAgent: String(cfg.config['userAgent']),
    fetch: o.fetch ?? fetch,
  }
  const scope = allegroScope(o.zPrzesylkami, o.zOfertami)
  const r = await runDeviceFlow({ oauth, scope, out, wait: o.wait })
  if (!r.ok) {
    out(`[allegro] ${r.message}`)
    return 1
  }
  await writeAccountSecrets(
    db,
    { channel: 'ALLEGRO', channelAccountId: id },
    { [S.access]: r.tokens.accessToken, [S.refresh]: r.tokens.refreshToken, [S.expiresAt]: r.tokens.expiresAt.toISOString(), [S.scope]: r.tokens.scope ?? scope }, // przyznany przez Allegro wygrywa z żądanym
    o.src.env,
    [S.rejected, S.autoryzacja],
  )
  out(`[allegro] autoryzacja zapisana w sekretach konta ${acc.name} (ALLEGRO/${id}, zaszyfrowana); access token ważny do ${r.tokens.expiresAt.toISOString()}`)
  try {
    const adapter = await createAccountAdapter(db, o.registry, { ...acc, adapterKey: manifest.adapterKey }, o.src, { fetch: o.fetch })
    const t = await adapter.testConnection()
    out(`[allegro] test połączenia: ${t.ok ? 'OK' : 'BŁĄD'} — ${t.message}`)
    let ok = t.ok
    if (o.zOfertami) {
      // Tylko liczba ofert z pierwszej strony — bez nazw, SKU i stanów.
      try {
        if (!hasOfferReader(adapter)) throw new Error('adapter bez odczytu ofert')
        const p = await adapter.listOffers(null)
        out(`[allegro] odczyt ofert: OK — pierwsza strona ${p.items.length} ofert${p.nextCursor ? ' (jest kolejna strona)' : ''}`)
      } catch (e) {
        ok = false
        out(`[allegro] odczyt ofert: BŁĄD — ${e instanceof Error ? e.message : 'błąd'}`)
      }
    }
    if (!o.zPrzesylkami) return ok ? 0 : 1
    const w = await allegroWysylamTest(db, { channelAccountId: id, registry: o.registry, src: o.src, fetch: o.fetch, out })
    return ok && w === 0 ? 0 : 1
  } catch (e) {
    out(`[allegro] test połączenia: nie da się utworzyć adaptera — ${e instanceof Error ? e.message : 'błąd'}`)
    return 1
  }
}
