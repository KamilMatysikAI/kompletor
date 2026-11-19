// Czytnik odbić (reszta pkt 4): raporty o niedoręczeniu (DSN) ze skrzynki adresu nadawcy koperty
// przez IMAP → `rozpoznajOdbicie` → `przyjmijOdbicie` (stan ODBITY przy wysłanym mailu, alert POCZTA_ODBICIE).
// Decyzja techniczna (R28, wariant 0 zł): IMAP działa z każdym dostawcą, także z Amazon SES (SES odsyła DSN na adres
// nadawcy koperty); bez SNS i endpointu HTTP.
//
// Zadanie workera `poczta-odbicia` co 5 min per firma. Zasady przebiegu:
// - tylko nieprzeczytane z wybranego folderu, z UID większym niż ostatnio przejrzany (stan w MailSettings.bounceState;
//   zmiana UIDVALIDITY folderu = od nowa), najwyżej LIMIT_PRZEBIEGU maili, każdy ≤ MAX_ROZMIAR (większe pomijamy);
// - raport o naszym mailu (ZAPISANO albo JUZ) dostaje \Seen i idzie do podfolderu „Kompletor/odbicia”; zwykły mail,
//   raport „opóźnione”, raport o mailu spoza Kompletora zostają nietknięte (nieprzeczytane, w folderze) dla człowieka;
// - błąd jednego maila nie zatrzymuje przebiegu: kursor zatrzymuje się przed nim i następny przebieg próbuje znowu,
//   a po LIMIT_PROB kolejnych porażkach tego samego maila przechodzi dalej (mail zostaje nietknięty, błąd w panelu);
// - odrzucony login = komunikat w Ustawienia → Komunikacja i poczta → Poczta → Odbicia i wstrzymanie czytnika do zmiany danych skrzynki
//   (bez ponawiania co 5 min, żeby serwer nie zablokował konta); wysyłka maili działa dalej;
// - treść maili to dane z zewnątrz: do bazy i alertów trafia tylko to, co przepuszcza `przyjmijOdbicie` (kod statusu,
//   przycięta diagnoza z maską adresów). Błędy w panelu bez treści maili.
import type { Prisma, PrismaClient } from '@prisma/client'
import { BEZPIECZENSTWO, bezpiecznyBlad, poprawnyAdres, type Bezpieczenstwo } from '../maile/transport'
import { alert } from '../rdzen/stan'
import { deleteSecret, listSecrets, resolveSecrets, setSecret, type Env, type SecretSource } from '../sekrety'
import { BladLogowaniaImap, BladPolaczeniaImap, bladFolderu, otworzSkrzynkeImap, sprawdzKonfiguracjeImap, type KonfiguracjaImap, type OtworzSkrzynke, type SkrzynkaImap } from './imap'
import { przyjmijOdbicie, rozpoznajOdbicie, type Odbicie, type WynikOdbicia } from './odbicia'
import { BladUstawienPoczty, hosting } from './ustawienia'

export const ZADANIE_ODBIC = 'poczta-odbicia'
export const IMAP_PASSWORD = 'IMAP_PASSWORD'
export const AUDIT_ODBICIA = 'MailBounceSettings'
export const ALERT_ODBICIA_LOGOWANIE = 'POCZTA_ODBICIA_LOGOWANIE'
export const LIMIT_PRZEBIEGU = 50
export const MAX_ROZMIAR = 2_000_000
export const LIMIT_PROB = 3
/** komunikat w panelu dla błędu rozpoznania albo zapisu odbicia (szczegół, który może nieść dane z obcego maila, idzie tylko do logu workera). */
export const BLAD_ZAPISU = 'błąd zapisu odbicia'

// ─── Przebieg po skrzynce (bez bazy; testy na atrapie portu) ─────────────────

export interface StanCzytnika {
  uidValidity?: string
  lastUid?: number
  /** Mail, który ostatnio nie przeszedł, i liczba kolejnych porażek. */
  failUid?: number
  failCount?: number
}

export interface WynikPrzebiegu {
  przejrzane: number
  /** Nowe odbicia zapisane przy wysłanych mailach. */
  zapisane: number
  /** Raport o mailu już oznaczonym jako odbity (np. powtórka po przerwanym przebiegu). */
  powtorki: number
  /** Raport o nieudanym doręczeniu, ale nie o mailu wysłanym przez Kompletor (zostaje w skrzynce). */
  obce: number
  /** Zwykłe maile i raporty innego rodzaju (zostają nieprzeczytane). */
  inne: number
  zaDuze: number
  /** Raport rozpoznany, ale przeniesienie do podfolderu się nie udało (został przeczytany w folderze). */
  bezPrzeniesienia: number
  bledy: string[]
  stan: StanCzytnika
}

export function stanZBazy(raw: Prisma.JsonValue | null | undefined): StanCzytnika {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const r = raw as Record<string, unknown>
  const liczba = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined)
  return {
    uidValidity: typeof r.uidValidity === 'string' ? r.uidValidity.slice(0, 40) : undefined,
    lastUid: liczba(r.lastUid),
    failUid: liczba(r.failUid),
    failCount: liczba(r.failCount),
  }
}

export async function przejrzyjSkrzynke(
  s: SkrzynkaImap,
  o: { stan: StanCzytnika; przyjmij: (odbicie: Odbicie) => Promise<WynikOdbicia>; limit?: number; maxRozmiar?: number; loguj?: (s: string) => void },
): Promise<WynikPrzebiegu> {
  const ten = o.stan.uidValidity === s.uidValidity
  const stan: StanCzytnika = ten ? { ...o.stan } : { uidValidity: s.uidValidity, lastUid: 0 }
  const w: WynikPrzebiegu = { przejrzane: 0, zapisane: 0, powtorki: 0, obce: 0, inne: 0, zaDuze: 0, bezPrzeniesienia: 0, bledy: [], stan }
  const max = o.maxRozmiar ?? MAX_ROZMIAR
  let kursor = stan.lastUid ?? 0
  let stoi = false
  const dalej = (uid: number) => {
    if (!stoi) kursor = Math.max(kursor, uid)
  }
  for (const m of await s.nieprzeczytane(kursor, o.limit ?? LIMIT_PRZEBIEGU)) {
    w.przejrzane++
    let zapis = false // błąd poza adapterem IMAP (rozpoznanie, zapis w bazie) = stały tekst w panelu
    try {
      if (m.rozmiar > max) {
        w.zaDuze++
      } else {
        const zrodlo = await s.pobierz(m.uid)
        zapis = true
        const odbicie = zrodlo && zrodlo.length <= max ? rozpoznajOdbicie(zrodlo.toString('utf8')) : null
        if (!odbicie) w.inne++
        else {
          const wynik = await o.przyjmij(odbicie)
          zapis = false
          if (wynik === 'ZAPISANO' || wynik === 'JUZ') {
            if (wynik === 'ZAPISANO') w.zapisane++
            else w.powtorki++
            if ((await s.odloz(m.uid)) === 'PRZECZYTANY') w.bezPrzeniesienia++
          } else w.obce++
        }
      }
      if (stan.failUid === m.uid) {
        stan.failUid = undefined
        stan.failCount = undefined
      }
      dalej(m.uid)
    } catch (e) {
      const tekst = bezpiecznyBlad(e instanceof Error ? e.message : String(e), null)
      if (e instanceof BladPolaczeniaImap) {
        // zerwane połączenie to nie porażka maila: koniec przebiegu, kursor przed tym mailem, licznik prób bez zmian
        w.bledy.push(`${tekst.slice(0, 160)} (przy mailu nr ${m.uid}; następna próba za kilka minut)`)
        break
      }
      if (zapis) (o.loguj ?? ((x: string) => console.error(x)))(`[poczta-odbicia] mail nr ${m.uid}: ${tekst.slice(0, 500)}`)
      const proby = stan.failUid === m.uid ? (stan.failCount ?? 0) + 1 : 1
      w.bledy.push(`mail nr ${m.uid}: ${zapis ? BLAD_ZAPISU : tekst.slice(0, 160)}${proby >= LIMIT_PROB ? ' (pominięty po kolejnych próbach)' : ''}`)
      if (proby >= LIMIT_PROB) {
        // trwała porażka jednego maila nie może zatrzymać czytnika na zawsze: zostaje nietknięty w skrzynce
        stan.failUid = undefined
        stan.failCount = undefined
        dalej(m.uid)
      } else if (!stoi) {
        stan.failUid = m.uid
        stan.failCount = proby
        stoi = true // następny przebieg zacznie od tego maila (zapis odbicia jest idempotentny)
      }
    }
  }
  stan.lastUid = kursor
  return w
}

// ─── Zadanie workera ─────────────────────────────────────────────────────────

const KOMUNIKAT_LOGOWANIA = 'Serwer IMAP odrzucił login albo hasło skrzynki odbić. Czytnik odbić jest wstrzymany do poprawy danych (wysyłka maili działa dalej).'

export function opisPrzebiegu(w: WynikPrzebiegu): string {
  return `przejrzane ${w.przejrzane}, odbicia ${w.zapisane}, powtórki ${w.powtorki}, spoza Kompletora ${w.obce}, inne ${w.inne}, za duże ${w.zaDuze}, błędy ${w.bledy.length}`
}

type Ctx = { organizationId: string; secrets: SecretSource }
export interface DepsOdbic {
  otworz?: OtworzSkrzynke
  now?: () => Date
}

/** Jeden przebieg czytnika dla firmy z kontekstu (klient firmy, RLS). Nie rzuca na błędach skrzynki: zapis w panelu. */
export async function czytajOdbicia(db: PrismaClient, env: Env, deps: DepsOdbic = {}): Promise<WynikPrzebiegu | null> {
  const s = await db.mailSettings.findFirst()
  if (!s?.bounceEnabled || s.bounceLoginRejectedAt) return null
  const now = (deps.now ?? (() => new Date()))()
  // każdy zapis przebiegu tylko przy tej samej wersji ustawień skrzynki. Zapis karty w trakcie przebiegu podnosi
  // bounceRev, więc wynik przebiegu na starych danych (kursor, odrzucony login, błąd) jest wyrzucany (0 zmienionych wierszy).
  const blad = async (komunikat: string | null, dodatki: Prisma.MailSettingsUpdateManyMutationInput = {}): Promise<boolean> =>
    (
      await db.mailSettings.updateMany({
        where: { bounceRev: s.bounceRev },
        data: { bounceLastRunAt: now, bounceLastError: komunikat?.slice(0, 300) ?? null, bounceLastErrorAt: komunikat ? now : null, ...dodatki },
      })
    ).count > 0
  const haslo = s.imapUsername ? (await resolveSecrets(db, [IMAP_PASSWORD], { env, envFallback: false }))[IMAP_PASSWORD] || null : null
  const braki = brakiOdbic(s, !!haslo)
  if (braki.length) {
    await blad(`Czytnik odbić nie działa: brak ${braki.join(', ')} (Ustawienia → Komunikacja i poczta → Poczta → Odbicia)`)
    return null
  }
  const bledyKonfiguracji = sprawdzKonfiguracjeImap({ host: s.imapHost!, port: s.imapPort!, bezpieczenstwo: s.imapSecurity, folder: s.imapFolder }, { hosting: hosting(env) })
  if (bledyKonfiguracji.length) {
    await blad(`Konfiguracja skrzynki odbić niepoprawna: ${bledyKonfiguracji.join('; ')}`)
    return null
  }
  const cfg: KonfiguracjaImap = { host: s.imapHost!, port: s.imapPort!, bezpieczenstwo: s.imapSecurity as Bezpieczenstwo, login: s.imapUsername!, haslo: haslo! }
  let skrzynka: SkrzynkaImap
  try {
    skrzynka = await (deps.otworz ?? otworzSkrzynkeImap({ tylkoPubliczne: hosting(env) }))(cfg, s.imapFolder)
  } catch (e) {
    if (e instanceof BladLogowaniaImap) {
      if (await blad(KOMUNIKAT_LOGOWANIA, { bounceLoginRejectedAt: now }))
        await alert(db, ALERT_ODBICIA_LOGOWANIE, 'poczta', `${KOMUNIKAT_LOGOWANIA} Popraw login albo hasło: Ustawienia → Komunikacja i poczta → Poczta → Odbicia.`, `poczta:odbicia:${now.toISOString()}:${ALERT_ODBICIA_LOGOWANIE}`)
    } else {
      await blad(`Nie udało się połączyć ze skrzynką odbić: ${bezpiecznyBlad(e instanceof Error ? e.message : String(e), haslo)}. Następna próba za kilka minut.`)
    }
    return null
  }
  let w: WynikPrzebiegu
  try {
    w = await przejrzyjSkrzynke(skrzynka, { stan: stanZBazy(s.bounceState), przyjmij: (o) => przyjmijOdbicie(db, o) })
  } catch (e) {
    // błąd listy maili (np. zerwane połączenie): stan bez zmian, następny przebieg od tego samego miejsca
    await blad(`Nie udało się przejrzeć skrzynki odbić: ${bezpiecznyBlad(e instanceof Error ? e.message : String(e), haslo)}. Następna próba za kilka minut.`)
    return null
  } finally {
    await skrzynka.zamknij().catch(() => {})
  }
  await blad(w.bledy.length ? `Część maili w skrzynce odbić nie została przetworzona (${w.bledy.length}): ${w.bledy.join('; ')}` : null, {
    bounceState: w.stan as Prisma.InputJsonObject,
  })
  // licznik niezależnie od wersji: odbicia zostały zapisane przy mailach, także gdy skrzynkę w międzyczasie zmieniono
  if (w.zapisane) await db.mailSettings.updateMany({ data: { bounceCount: { increment: w.zapisane } } })
  return w
}

export function zadanieOdbicPoczty(deps: DepsOdbic = {}, log: (s: string) => void = (s) => console.log(s)) {
  return async (db: PrismaClient, _payload: unknown, ctx: Ctx): Promise<void> => {
    const w = await czytajOdbicia(db, ctx.secrets.env, deps)
    if (w && (w.przejrzane || w.bledy.length)) log(`[poczta-odbicia] ${ctx.organizationId}: ${opisPrzebiegu(w)}`)
  }
}

// ─── Ustawienia (karta „Odbicia” w Ustawienia → Komunikacja i poczta → Poczta) ─────────────────────

export function brakiOdbic(s: { imapHost: string | null; imapPort: number | null; imapUsername: string | null }, hasloUstawione: boolean): string[] {
  const b: string[] = []
  if (!s.imapHost) b.push('serwer IMAP')
  if (!s.imapPort) b.push('port IMAP')
  if (!s.imapUsername) b.push('login skrzynki')
  if (!hasloUstawione) b.push('hasło skrzynki')
  return b
}

export interface WidokOdbic {
  enabled: boolean
  host: string
  port: number | null
  bezpieczenstwo: Bezpieczenstwo
  login: string
  folder: string
  adresOdbic: string
  hasloUstawione: boolean
  lastRunAt: Date | null
  lastError: string | null
  lastErrorAt: Date | null
  loginRejectedAt: Date | null
  liczba: number
  braki: string[]
}

export async function widokOdbic(db: PrismaClient): Promise<WidokOdbic> {
  const [s, sekrety] = await Promise.all([db.mailSettings.findFirst(), listSecrets(db)])
  const hasloUstawione = sekrety.some((x) => x.name === IMAP_PASSWORD && !x.channel)
  return {
    enabled: s?.bounceEnabled ?? false,
    host: s?.imapHost ?? '',
    port: s?.imapPort ?? null,
    bezpieczenstwo: ((BEZPIECZENSTWO as readonly string[]).includes(s?.imapSecurity ?? '') ? s!.imapSecurity : 'TLS') as Bezpieczenstwo,
    login: s?.imapUsername ?? '',
    folder: s?.imapFolder ?? 'INBOX',
    adresOdbic: s?.bounceAddress ?? '',
    hasloUstawione,
    lastRunAt: s?.bounceLastRunAt ?? null,
    lastError: s?.bounceLastError ?? null,
    lastErrorAt: s?.bounceLastErrorAt ?? null,
    loginRejectedAt: s?.bounceLoginRejectedAt ?? null,
    liczba: s?.bounceCount ?? 0,
    braki: brakiOdbic({ imapHost: s?.imapHost ?? null, imapPort: s?.imapPort ?? null, imapUsername: s?.imapUsername ?? null }, hasloUstawione),
  }
}

export interface WejscieOdbic {
  enabled: boolean
  host: string
  port: string
  bezpieczenstwo: string
  login: string
  /** Nowe hasło; puste = bez zmiany. */
  haslo: string
  usunHaslo: boolean
  folder: string
  adresOdbic: string
}

export function parseFormularzOdbic(form: FormData): WejscieOdbic {
  const str = (k: string) => String(form.get(k) ?? '')
  return {
    enabled: form.get('o_wlaczone') === 'tak',
    host: str('o_host'),
    port: str('o_port'),
    bezpieczenstwo: str('o_bezpieczenstwo'),
    login: str('o_login'),
    haslo: str('o_haslo'),
    usunHaslo: form.get('o_usun_haslo') === 'tak',
    folder: str('o_folder'),
    adresOdbic: str('o_adres'),
  }
}

/**
 * Zapis karty „Odbicia”: walidacja (serwer w hostingu tylko publiczny), hasło jako sekret firmy IMAP_PASSWORD, AuditLog
 * bez hasła. Zmiana serwera, loginu, hasła albo folderu zdejmuje blokadę po odrzuconym logowaniu, kasuje stary błąd i
 * zeruje kursor (nowa skrzynka = przejrzenie od początku jej nieprzeczytanych).
 */
export async function zapiszUstawieniaOdbic(db: PrismaClient, input: WejscieOdbic, actorId: string, env: Env): Promise<void> {
  const bledy: string[] = []
  const host = input.host.trim().toLowerCase()
  const portTxt = input.port.trim()
  const port = portTxt ? Number(portTxt) : NaN
  const bezp = input.bezpieczenstwo.trim() || 'TLS'
  const folder = input.folder.trim() || 'INBOX'
  if (host || portTxt) bledy.push(...sprawdzKonfiguracjeImap({ host, port, bezpieczenstwo: bezp, folder }, { hosting: hosting(env) }))
  else {
    const f = bladFolderu(folder)
    if (f) bledy.push(f)
  }
  const login = input.login.trim().slice(0, 254) || null
  const adresOdbic = input.adresOdbic.trim().toLowerCase() || null
  if (adresOdbic && !poprawnyAdres(adresOdbic)) bledy.push('Niepoprawny adres odbić')
  if (input.haslo && input.haslo.length > 500) bledy.push('Hasło skrzynki: najwyżej 500 znaków')
  const sekrety = await listSecrets(db)
  const maHasloPrzed = sekrety.some((x) => x.name === IMAP_PASSWORD && !x.channel)
  const maHaslo = (!input.usunHaslo && maHasloPrzed) || !!input.haslo
  if (input.enabled) {
    const braki = brakiOdbic({ imapHost: host || null, imapPort: Number.isFinite(port) ? port : null, imapUsername: login }, maHaslo)
    if (braki.length) bledy.push(`Do włączenia czytnika odbić uzupełnij: ${braki.join(', ')}`)
  }
  if (bledy.length) throw new BladUstawienPoczty(bledy.join('; '))
  // kolejność zostaje świadomie, hasło przed transakcją podnoszącą `bounceRev`.
  // Przebieg czytnika startujący w tym oknie może połączyć się starym hostem/loginem z nowym hasłem i zapisać odmowę
  // (jeden zbędny alert); transakcja niżej i tak zdejmuje blokadę i podnosi wersję. Wstępne podniesienie wersji przed
  // zapisem hasła tego okna nie zamyka (przebieg startujący po nim też widzi stary host z nowym hasłem), a dokłada
  // drugi zapis ustawień. Hasło w tej samej transakcji = zapis sekretu poza `setSecret`, czego unikamy.
  if (input.haslo) await setSecret(db, IMAP_PASSWORD, input.haslo, env)
  else if (input.usunHaslo) await deleteSecret(db, IMAP_PASSWORD)

  await db.$transaction(async (tx) => {
    const before = await tx.mailSettings.findFirst()
    const zmianaSkrzynki =
      !!input.haslo ||
      (input.usunHaslo && maHasloPrzed) ||
      (before?.imapHost ?? null) !== (host || null) ||
      (before?.imapPort ?? null) !== (Number.isFinite(port) ? port : null) ||
      (before?.imapSecurity ?? 'TLS') !== bezp ||
      (before?.imapUsername ?? null) !== login ||
      (before?.imapFolder ?? 'INBOX') !== folder
    const wlaczenie = input.enabled && !before?.bounceEnabled
    const data = {
      bounceEnabled: input.enabled,
      imapHost: host || null,
      imapPort: Number.isFinite(port) ? port : null,
      imapSecurity: bezp,
      imapUsername: login,
      imapFolder: folder,
      bounceAddress: adresOdbic,
      updatedById: actorId,
      ...(zmianaSkrzynki || wlaczenie ? { bounceLoginRejectedAt: null, bounceLastError: null, bounceLastErrorAt: null } : {}),
      ...(zmianaSkrzynki ? { bounceState: {} } : {}),
    }
    const organizationId = (await tx.organization.findFirstOrThrow({ select: { id: true } })).id
    // nowa wersja ustawień skrzynki; trwający przebieg na starych danych nie zapisze już swojego wyniku
    await tx.mailSettings.upsert({ where: { organizationId }, create: data, update: zmianaSkrzynki || wlaczenie ? { ...data, bounceRev: { increment: 1 } } : data })
    const snap = (x: { bounceEnabled: boolean; imapHost: string | null; imapPort: number | null; imapSecurity: string; imapUsername: string | null; imapFolder: string; bounceAddress: string | null }) => ({
      enabled: x.bounceEnabled,
      host: x.imapHost,
      port: x.imapPort,
      security: x.imapSecurity,
      username: x.imapUsername,
      folder: x.imapFolder,
      bounceAddress: x.bounceAddress,
    })
    await tx.auditLog.create({
      data: {
        entity: AUDIT_ODBICIA,
        entityId: organizationId,
        actorId,
        before: before ? snap(before) : undefined,
        after: { ...snap(data), haslo: input.haslo ? 'zmienione' : input.usunHaslo ? 'usunięte' : 'bez zmian' },
      },
    })
  })
}
