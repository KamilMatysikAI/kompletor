// „Połącz z Allegro” z panelu: device flow bez terminala. Ten sam przebieg co komenda
// `npm run cien -- allegro-autoryzuj` (scripts/allegro-autoryzacja.ts), rozłożony na krótkie kroki akcji serwera:
//   1. `rozpocznijAutoryzacje` — POST <auth>/auth/oauth/device z zakresem wybranych funkcji (lib/zrodla/allegro-zakresy),
//      zapis trwającej autoryzacji w zaszyfrowanym sekrecie konta ALLEGRO_AUTORYZACJA (kod urządzenia nie wychodzi
//      do przeglądarki: ekran dostaje tylko link i kod do przepisania);
//   2. `sprawdzAutoryzacje` — jedno odpytanie o token (najwyżej co `interval` s, slow_down +5 s) pod blokadą wiersza
//      sekretu, więc dwie karty przeglądarki nie zużyją kodu dwa razy; po zatwierdzeniu zapis pary tokenów i zakresu,
//      skasowanie trwającej autoryzacji i znacznika odrzuconego tokenu, zlecenie testu połączenia (worker);
//   3. odnowienie tokenu robi adapter (rotacja pod blokadą), ekran pokazuje tylko termin i stan.
// Adres autoryzacji tylko allegro.pl albo sandbox (wzorzec manifestu), więc z panelu nie da się wysłać zapytania
// pod inny host. Bez logowania i bez komunikatów z tokenami, Client Secret ani kodem urządzenia (tylko kody OAuth).
import type { Prisma, PrismaClient } from '@prisma/client'
import { ALLEGRO_DEFINITION, ALLEGRO_SECRETS as S } from '../adaptery/allegro'
import { accountInputs, defaultAccountFetch, loadChannelAccounts } from '../adaptery/konta'
import { validateAccountConfig } from '../adaptery/rejestr'
import { podBlokadaSekretow, writeAccountSecrets } from '../adaptery/rotacja-sekretow'
import { listSecrets, type SecretSource } from '../sekrety'
import { ALLEGRO_AUTH_URL, AllegroOAuthError, type AllegroOAuthClient, pollAllegroDeviceToken, requestAllegroDeviceCode } from '../zrodla/allegro'
import { allegroZakresy, czyFunkcjaAllegro, type FunkcjaAllegro, funkcjeZZakresu } from '../zrodla/allegro-zakresy'
import type { FetchLike } from '../zrodla/http'
import { KontoError, type KontoRef } from './konta'
import { etykietaPola } from './platformy'
import { uniewaznijKonto } from './rejestr-synchronizacji'
import { zlecTestPoNaprawie } from './zadania'

export interface AutoryzacjaDeps {
  src: SecretSource
  actorId: string
  /** Testy: atrapa Allegro. Domyślnie fetch konta (w hostingu z osłoną adresów). */
  fetch?: FetchLike
  now?: () => Date
}

/** Trwająca autoryzacja (zaszyfrowany JSON w sekrecie konta). */
interface Trwajaca {
  deviceCode: string
  userCode: string
  link: string
  linkBezKodu: string
  wazneDo: string
  odstepSek: number
  nastepneOdpytanie: string
  zakres: string
  rozpoczal: string
}

export interface StanAllegro {
  /** Client ID i Client Secret zapisane (bez nich nie ma czego autoryzować). */
  maKlucze: boolean
  /** Para tokenów zapisana. */
  polaczone: boolean
  /** Allegro odrzuciło refresh token: potrzebne ponowne połączenie. */
  odrzucone: boolean
  /** Koniec ważności access tokenu (adapter odnawia go sam przed końcem). */
  tokenWaznyDo: Date | null
  /** Kiedy zapisano ostatnią parę (autoryzacja albo odnowienie). */
  odnowionoAt: Date | null
  /** Funkcje pokryte zakresem ostatniej autoryzacji; null = zakres nieznany (autoryzacja). */
  funkcje: FunkcjaAllegro[] | null
  trwa: { link: string; linkBezKodu: string; kod: string; wazneDo: Date; funkcje: FunkcjaAllegro[] } | null
}

/**
 * Link weryfikacji z odpowiedzi Allegro: renderowany jako główny przycisk, więc tylko https na
 * allegro.pl albo sandboxie (ten sam host co ALLEGRO_AUTH_URL_RE, ale ze ścieżką); inny host = „nieoczekiwany link”.
 */
const LINK_ALLEGRO_RE = /^https:\/\/allegro\.pl(\.allegrosandbox\.pl)?(\/\S*)?$/

const scopeOf = (ref: KontoRef) => ({ channel: ref.channel, channelAccountId: ref.channelAccountId })

function czytajTrwajaca(raw: string | undefined): Trwajaca | null {
  if (!raw) return null
  try {
    const t = JSON.parse(raw) as Trwajaca
    return typeof t.deviceCode === 'string' && typeof t.link === 'string' ? t : null
  } catch {
    return null
  }
}

async function kontoAllegro(db: PrismaClient, ref: KontoRef) {
  if (ref.channel !== 'ALLEGRO') throw new KontoError('To nie jest konto Allegro')
  const acc = (await loadChannelAccounts(db, { activeOnly: false })).find((a) => a.channel === 'ALLEGRO' && a.channelAccountId === ref.channelAccountId)
  if (!acc) throw new KontoError('Nie ma takiego konta')
  return acc
}

/** Klient OAuth konta: Client ID i Secret z sekretów konta (albo env w self-hoście), adres tylko allegro.pl/sandbox. */
async function klientOAuth(db: PrismaClient, ref: KontoRef, deps: AutoryzacjaDeps): Promise<AllegroOAuthClient> {
  const acc = await kontoAllegro(db, ref)
  const manifest = ALLEGRO_DEFINITION.manifest
  const inputs = await accountInputs(db, acc, manifest, deps.src)
  const cfg = validateAccountConfig(manifest, inputs.rawConfig)
  // nazwy pól po ludzku (etykiety z kreatora), nie klucze manifestu
  if (cfg.problems.length) throw new KontoError(`Popraw ustawienia konta: ${cfg.problems.map((p) => poLudzku(p, manifest.config.map((f) => f.key))).join('; ')}`.slice(0, 300))
  const clientId = inputs.rawSecrets[S.clientId]
  const clientSecret = inputs.rawSecrets[S.clientSecret]
  if (!clientId || !clientSecret) throw new KontoError('Najpierw zapisz Client ID i Client Secret aplikacji Allegro (pola niżej, „Klucze”).')
  return {
    authUrl: String(cfg.config['authUrl'] ?? ALLEGRO_AUTH_URL),
    clientId,
    clientSecret,
    userAgent: String(cfg.config['userAgent']),
    fetch: deps.fetch ?? defaultAccountFetch(deps.src.env),
    ...(deps.now ? { now: deps.now } : {}),
  }
}

async function audit(db: PrismaClient, ref: KontoRef, actorId: string, after: Record<string, unknown>): Promise<void> {
  await db.auditLog.create({ data: { entity: 'ChannelConfig', entityId: `${ref.channel}/${ref.channelAccountId}`, actorId, after: after as Prisma.InputJsonValue } })
}

/** Kod OAuth bez treści odpowiedzi (AllegroOAuthError niesie tylko kod i status). */
function kodBledu(e: unknown): string {
  return e instanceof AllegroOAuthError ? `${e.code}, HTTP ${e.status}` : 'błąd połączenia'
}

/** Stan połączenia konta Allegro dla ekranu konta: tylko daty, zakresy i link trwającej autoryzacji, bez wartości tokenów. */
export async function stanAllegro(db: PrismaClient, ref: KontoRef, src: SecretSource, now = new Date()): Promise<StanAllegro> {
  const acc = await kontoAllegro(db, ref)
  const saved = new Map((await listSecrets(db)).filter((s) => s.channel === ref.channel && s.channelAccountId === ref.channelAccountId).map((s) => [s.name, s.updatedAt]))
  const inputs = await accountInputs(db, acc, ALLEGRO_DEFINITION.manifest, src)
  const sec = inputs.rawSecrets
  const trw = czytajTrwajaca(sec[S.autoryzacja])
  const wazne = sec[S.expiresAt] ? new Date(sec[S.expiresAt]!) : null
  return {
    maKlucze: !!sec[S.clientId] && !!sec[S.clientSecret],
    polaczone: !!sec[S.access] && !!sec[S.refresh],
    odrzucone: !!sec[S.rejected],
    tokenWaznyDo: wazne && !Number.isNaN(wazne.getTime()) ? wazne : null,
    odnowionoAt: saved.get(S.refresh) ?? null,
    funkcje: sec[S.scope] ? funkcjeZZakresu(sec[S.scope]) : null,
    trwa:
      trw && new Date(trw.wazneDo) > now
        ? { link: trw.link, linkBezKodu: trw.linkBezKodu, kod: trw.userCode, wazneDo: new Date(trw.wazneDo), funkcje: funkcjeZZakresu(trw.zakres) }
        : null,
  }
}

/** Funkcje z formularza (pola `funkcja`), tylko znane; odczyt zamówień zawsze. */
export function funkcjeZFormularza(wartosci: readonly unknown[]): FunkcjaAllegro[] {
  return [...new Set<FunkcjaAllegro>(['zamowienia', ...wartosci.filter(czyFunkcjaAllegro)])]
}

/**
 * Początek autoryzacji: kod urządzenia z Allegro, zapis trwającej autoryzacji (zastępuje poprzednią, niedokończoną).
 * Dotychczasowa para tokenów zostaje i działa, dopóki właściciel nie zatwierdzi nowej.
 */
export async function rozpocznijAutoryzacje(db: PrismaClient, ref: KontoRef, funkcje: readonly FunkcjaAllegro[], deps: AutoryzacjaDeps): Promise<{ link: string; kod: string; wazneDo: Date }> {
  const oauth = await klientOAuth(db, ref, deps)
  const zakres = allegroZakresy(funkcje)
  let code
  try {
    code = await requestAllegroDeviceCode(oauth, zakres)
  } catch (e) {
    throw new KontoError(
      e instanceof AllegroOAuthError && e.code === 'invalid_client'
        ? 'Allegro nie przyjęło Client ID albo Client Secret. Sprawdź klucze aplikacji (i czy aplikacja ma włączony dostęp bez przeglądarki, „device flow”).'
        : `Nie udało się rozpocząć połączenia z Allegro (${kodBledu(e)}). Spróbuj za chwilę.`,
    )
  }
  // link pokazujemy jako href: tylko https na allegro.pl/sandboxie (odpowiedź przychodzi z allegro.pl, ale bez wyjątków)
  if (!LINK_ALLEGRO_RE.test(code.verificationUriComplete) || (code.verificationUri && !LINK_ALLEGRO_RE.test(code.verificationUri)))
    throw new KontoError('Allegro zwróciło nieoczekiwany link autoryzacji. Spróbuj za chwilę.')
  const now = (deps.now ?? (() => new Date()))()
  const t: Trwajaca = {
    deviceCode: code.deviceCode,
    userCode: code.userCode,
    link: code.verificationUriComplete,
    linkBezKodu: code.verificationUri || code.verificationUriComplete,
    wazneDo: new Date(now.getTime() + code.expiresInSec * 1000).toISOString(),
    odstepSek: code.intervalSec,
    nastepneOdpytanie: new Date(now.getTime() + code.intervalSec * 1000).toISOString(),
    zakres,
    rozpoczal: deps.actorId,
  }
  await writeAccountSecrets(db, scopeOf(ref), { [S.autoryzacja]: JSON.stringify(t) }, deps.src.env)
  await audit(db, ref, deps.actorId, { allegroAutoryzacja: 'rozpoczeta', zakres })
  return { link: t.link, kod: t.userCode, wazneDo: new Date(t.wazneDo) }
}

export type WynikSprawdzenia =
  | { stan: 'czeka'; zaSek: number }
  | { stan: 'gotowe'; komunikat: string }
  | { stan: 'odmowa' | 'wygasla' | 'blad' | 'brak'; komunikat: string }

/**
 * Jedno odpytanie Allegro o token (albo nic, gdy za wcześnie). Pod blokadą wiersza ALLEGRO_AUTORYZACJA: równoległe
 * wywołanie czeka i widzi już wynik pierwszego. Przejściowy błąd sieci = „czeka” (kolejna próba za odstęp).
 *
 * Blokada obejmuje wywołanie HTTP (timeout 30 s, transakcja do 90 s), jak w `rotateAccountSecrets`: równoległe
 * odpytanie i „Anuluj” (`anulujAutoryzacje`) czekają wtedy do 30 s; odczyt ekranu (`stanAllegro`) nie czeka, bo czyta
 * bez `FOR UPDATE`. Zapis nowej pary blokuje ALLEGRO_AUTORYZACJA, a rotacja w adapterze
 * ALLEGRO_REFRESH_TOKEN; kolejność rozstrzygają blokady wierszy przy `UPDATE`: rotacja po zapisie panelu widzi inną
 * parę i jej nie nadpisuje, a panel po rotacji nadpisuje ją nowszą autoryzacją, więc nowsza para nie ginie.
 */
export async function sprawdzAutoryzacje(db: PrismaClient, ref: KontoRef, deps: AutoryzacjaDeps): Promise<WynikSprawdzenia> {
  const oauth = await klientOAuth(db, ref, deps)
  const now = (deps.now ?? (() => new Date()))()
  const names = [S.autoryzacja, S.access, S.refresh, S.expiresAt, S.scope, S.rejected]
  const wynik = await podBlokadaSekretow<WynikSprawdzenia>(db, scopeOf(ref), S.autoryzacja, names, deps.src.env, async (cur, zapisz) => {
    const t = czytajTrwajaca(cur[S.autoryzacja])
    if (!t) {
      await zapisz({}, [S.autoryzacja])
      return { stan: 'brak', komunikat: 'Nie ma trwającego połączenia. Kliknij „Połącz z Allegro”.' }
    }
    if (new Date(t.wazneDo) <= now) {
      await zapisz({}, [S.autoryzacja])
      return { stan: 'wygasla', komunikat: 'Link wygasł przed zatwierdzeniem w Allegro. Kliknij „Połącz z Allegro” jeszcze raz.' }
    }
    const za = Math.ceil((new Date(t.nastepneOdpytanie).getTime() - now.getTime()) / 1000)
    if (za > 0) return { stan: 'czeka', zaSek: za }
    const dalej = async (odstep: number): Promise<WynikSprawdzenia> => {
      await zapisz({ [S.autoryzacja]: JSON.stringify({ ...t, odstepSek: odstep, nastepneOdpytanie: new Date(now.getTime() + odstep * 1000).toISOString() }) })
      return { stan: 'czeka', zaSek: odstep }
    }
    try {
      const tokens = await pollAllegroDeviceToken(oauth, t.deviceCode)
      await zapisz(
        { [S.access]: tokens.accessToken, [S.refresh]: tokens.refreshToken, [S.expiresAt]: tokens.expiresAt.toISOString(), [S.scope]: tokens.scope ?? t.zakres }, // przyznany przez Allegro wygrywa z żądanym
        [S.autoryzacja, S.rejected],
      )
      // nowe połączenie z Allegro (może inne konto sprzedawcy) = pełny zapis stanów, bez pomijania
      await uniewaznijKonto(db, ref).catch((e) => console.warn(`[rejestr-synchronizacji] ${ref.channel}/${ref.channelAccountId}: kasowanie skrótów po połączeniu nieudane (${e instanceof Error ? e.message : String(e)})`))
      return { stan: 'gotowe', komunikat: 'Połączono z Allegro. Sprawdzam połączenie.' }
    } catch (e) {
      if (!(e instanceof AllegroOAuthError)) return dalej(t.odstepSek)
      if (e.code === 'authorization_pending') return dalej(t.odstepSek)
      if (e.code === 'slow_down') return dalej(t.odstepSek + 5)
      if (e.code === 'access_denied') {
        await zapisz({}, [S.autoryzacja])
        return { stan: 'odmowa', komunikat: 'W Allegro odmówiono dostępu. Nic nie zapisano; dotychczasowe połączenie (jeśli było) działa dalej.' }
      }
      if (e.code === 'expired_token' || e.code === 'invalid_grant') {
        await zapisz({}, [S.autoryzacja])
        return { stan: 'wygasla', komunikat: 'Kod połączenia wygasł albo jest nieważny. Kliknij „Połącz z Allegro” jeszcze raz.' }
      }
      if (e.retryable) return dalej(t.odstepSek)
      await zapisz({}, [S.autoryzacja])
      return { stan: 'blad', komunikat: `Połączenie przerwane (${kodBledu(e)}). Kliknij „Połącz z Allegro” jeszcze raz.` }
    }
  })
  if (!wynik) return { stan: 'brak', komunikat: 'Nie ma trwającego połączenia. Kliknij „Połącz z Allegro”.' }
  if (wynik.stan === 'gotowe') {
    await audit(db, ref, deps.actorId, { allegroAutoryzacja: 'zapisana' })
    try {
      await zlecTestPoNaprawie(db, ref, now) // konto wyłączone po błędach wraca po udanym teście
    } catch {
      // test połączenia to dodatek: tokeny już zapisane
    }
  } else if (wynik.stan !== 'czeka' && wynik.stan !== 'brak') {
    // „brak” (druga karta, stary zegar po zakończeniu) nie zmienia stanu, więc bez wpisu w historii
    await audit(db, ref, deps.actorId, { allegroAutoryzacja: wynik.stan })
  }
  return wynik
}

/**
 * Przerwanie trwającej autoryzacji (przycisk „Anuluj”). Dotychczasowa para tokenów zostaje. Pod tą samą blokadą co
 * odpytanie: gdy odpytanie zdążyło zapisać nową parę, zwraca 'ZAPISANE' zamiast udawać przerwanie.
 */
export async function anulujAutoryzacje(db: PrismaClient, ref: KontoRef, actorId: string, env: SecretSource['env'] = process.env): Promise<'ANULOWANE' | 'ZAPISANE' | 'BRAK'> {
  await kontoAllegro(db, ref)
  const w = await podBlokadaSekretow(db, scopeOf(ref), S.autoryzacja, [S.autoryzacja], env, async (cur, zapisz) => {
    if (!czytajTrwajaca(cur[S.autoryzacja])) return 'BRAK' as const
    await zapisz({}, [S.autoryzacja])
    return 'ANULOWANE' as const
  })
  if (w === 'ANULOWANE') {
    await audit(db, ref, actorId, { allegroAutoryzacja: 'anulowana' })
    return w
  }
  // wiersza już nie ma: albo odpytanie właśnie zapisało parę (jest świeży refresh), albo nic nie trwało
  const para = await db.integrationSecret.findFirst({ where: { name: S.refresh, ...scopeOf(ref) }, select: { updatedAt: true } })
  return para && Date.now() - para.updatedAt.getTime() < 5 * 60_000 ? 'ZAPISANE' : 'BRAK'
}

/** Klucz pola manifestu w komunikacie walidacji → etykieta pola z kreatora (bez nazw technicznych w toaście). */
function poLudzku(problem: string, klucze: readonly string[]): string {
  let out = problem
  for (const k of klucze) out = out.replace(new RegExp(`\\b${k}\\b`, 'g'), `„${etykietaPola(k)}”`)
  return out
}
