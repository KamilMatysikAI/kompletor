// „Połącz z WooCommerce” z panelu: klucze REST API bez kopiowania. Przebieg (protokół WooCommerce
// /wc-auth/v1/authorize, https://woocommerce.github.io/woocommerce-rest-api-docs/#authentication-endpoint):
//   1. `rozpocznijWooAuth` — losowy jednorazowy znacznik w zaszyfrowanym sekrecie konta WOO_AUTORYZACJA (jak
//      ALLEGRO_AUTORYZACJA) i link do sklepu z podpisanym `user_id` (HMAC kluczem wyprowadzonym z klucza głównego
//      sekretów; w `user_id` firma, konto, znacznik i termin, bez niczego tajnego);
//   2. właściciel loguje się w WordPressie i klika „Zatwierdź”; serwer sklepu wysyła POST z kluczami na
//      `callback_url` = `<adres panelu>/api/kanaly/woo/klucze` (trasa bez sesji: bramką jest podpis i znacznik);
//   3. `przyjmijKluczeWoo` — podpis, termin, znacznik pod blokadą wiersza sekretu (drugi POST z tym samym `user_id`
//      nic nie zapisze), zgodność uprawnień z tym, o co prosiliśmy; klucze zapisane zaszyfrowane, znacznik skasowany,
//      test połączenia zlecony workerowi. Odpowiedź inna niż 200 = WooCommerce sam kasuje klucz po swojej stronie.
// Nasz serwer nie wysyła przy tym żadnego zapytania do sklepu (link otwiera przeglądarka, POST przychodzi ze sklepu),
// więc nie ma tu drogi do zapytań pod adresy wewnętrzne; test połączenia idzie potem przez worker z osłoną adresów.
// Ręczne wklejenie kluczy zostaje jako alternatywa (ekran konta, „Ustawienia i klucze”).
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Prisma, PrismaClient } from '@prisma/client'
import { podBlokadaSekretow } from '../adaptery/rotacja-sekretow'
import type { AdapterRegistry } from '../adaptery/rejestr'
import { ORG_ID_RE, organizationIdOf } from '../db'
import { deleteSecret, encryptionKeysFromEnv, type Env, resolveSecrets, setSecret } from '../sekrety'
import { AdresError, checkShopUrlShape } from './adres'
import { kodKonta, KontoError, type KontoRef } from './konta'
import { zlecTestPoNaprawie } from './zadania'

export const WOO_AUTORYZACJA = 'WOO_AUTORYZACJA'
export const CALLBACK_PATH = '/api/kanaly/woo/klucze'
/** Jak długo link do sklepu jest ważny. */
export const WAZNOSC_MS = 15 * 60_000

export type ZakresWoo = 'read' | 'read_write'
export const czyZakresWoo = (v: unknown): v is ZakresWoo => v === 'read' || v === 'read_write'

const READ = { key: 'WOO_CONSUMER_KEY', secret: 'WOO_CONSUMER_SECRET' } as const
const WRITE = { key: 'WOO_WRITE_KEY', secret: 'WOO_WRITE_SECRET' } as const
const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const NONCE_RE = /^[A-Za-z0-9_-]{22,64}$/

// ─── Adres panelu ────────────────────────────────────────────────────────────

/**
 * Publiczny adres panelu dla `callback_url` i `return_url`: `APP_PUBLIC_URL`, a bez niego `PANEL_URL`. WooCommerce
 * przyjmuje tylko adres https (inaczej odmawia już na ekranie zatwierdzenia), a sklep musi go widzieć z internetu,
 * więc localhost i adresy sieci lokalnej odpadają z powodem. Nigdy z nagłówka Host żądania.
 */
export function adresPaneluWoo(env: Env): { ok: true; url: string } | { ok: false; powod: string } {
  const raw = (env['APP_PUBLIC_URL'] || env['PANEL_URL'] || '').trim()
  if (!raw) return { ok: false, powod: 'Panel nie ma ustawionego adresu publicznego (PANEL_URL), więc sklep nie odeśle kluczy. Wklej klucze ręcznie albo poproś administratora o ustawienie adresu.' }
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return { ok: false, powod: 'Adres publiczny panelu (PANEL_URL) jest niepoprawny. Wklej klucze ręcznie albo zgłoś to administratorowi.' }
  }
  if (u.protocol !== 'https:') return { ok: false, powod: 'Adres panelu nie zaczyna się od https://, a WooCommerce wysyła klucze tylko na bezpieczny adres. Wklej klucze ręcznie.' }
  if (u.search || u.hash || u.username || u.password) return { ok: false, powod: 'Adres publiczny panelu (PANEL_URL) ma niedozwolone części. Zgłoś to administratorowi.' }
  const host = u.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host) || host === '[::1]')
    return { ok: false, powod: 'Panel działa pod adresem lokalnym, którego sklep nie widzi z internetu. Wklej klucze ręcznie.' }
  return { ok: true, url: `${u.origin}${u.pathname.replace(/\/+$/, '')}` }
}

// ─── Podpisany `user_id` ─────────────────────────────────────────────────────

export interface Znacznik {
  /** Firma (organizationId). */
  o: string
  /** Konto kanału (zawsze WOO). */
  a: string
  /** Jednorazowy znacznik z sekretu WOO_AUTORYZACJA. */
  n: string
  /** Termin (sekundy od epoki). */
  e: number
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url')

// celowo bez pamięci podręcznej: HKDF to dwa HMAC, a mapa po samej wersji klucza
// dałaby zły podpis po zmianie klucza o tej samej wersji (testy, odtworzenie env). Zysk byłby pomijalny wobec odczytu ciała żądania.
function kluczPodpisu(key: Buffer): Buffer {
  // osobny klucz od klucza szyfrowania (HKDF z etykietą celu): podpis nie odsłania materiału AES
  return Buffer.from(hkdfSync('sha256', key, 'kompletor', 'woo-wc-auth-user-id-v1', 32))
}

const podpis = (key: Buffer, dane: string) => createHmac('sha256', kluczPodpisu(key)).update(dane).digest()

/** `user_id` dla WooCommerce: `w1.<wersja klucza>.<dane>.<podpis>`, najwyżej ~200 znaków, tylko [A-Za-z0-9._-]. */
export function podpiszZnacznik(env: Env, z: Znacznik): string {
  const ring = encryptionKeysFromEnv(env)
  const dane = b64u(JSON.stringify(z))
  return `w1.${ring.current}.${dane}.${podpis(ring.keys.get(ring.current)!, `${ring.current}.${dane}`).toString('base64url')}`
}

/** Sprawdza podpis i termin. Zły kształt, nieznana wersja klucza albo zły podpis = null (bez rozróżniania na zewnątrz). */
export function sprawdzZnacznik(env: Env, userId: string, now: Date): { z: Znacznik; wygasl: boolean } | null {
  if (typeof userId !== 'string' || userId.length > 400) return null
  const m = /^w1\.([1-9][0-9]{0,8})\.([A-Za-z0-9_-]{10,300})\.([A-Za-z0-9_-]{43})$/.exec(userId)
  if (!m) return null
  let ring
  try {
    ring = encryptionKeysFromEnv(env)
  } catch {
    return null
  }
  const key = ring.keys.get(Number(m[1]))
  if (!key) return null
  const oczekiwany = podpis(key, `${m[1]}.${m[2]}`)
  const dany = Buffer.from(m[3]!, 'base64url')
  if (dany.length !== oczekiwany.length || !timingSafeEqual(dany, oczekiwany)) return null
  let z: Znacznik
  try {
    z = JSON.parse(Buffer.from(m[2]!, 'base64url').toString('utf8')) as Znacznik
  } catch {
    return null
  }
  if (!z || typeof z.o !== 'string' || !ORG_ID_RE.test(z.o) || typeof z.a !== 'string' || !ACCOUNT_ID_RE.test(z.a) || typeof z.n !== 'string' || !NONCE_RE.test(z.n) || !Number.isInteger(z.e)) return null
  return { z, wygasl: z.e * 1000 <= now.getTime() }
}

// ─── Trwająca autoryzacja (sekret konta) ─────────────────────────────────────

interface Trwajaca {
  n: string
  zakres: ZakresWoo
  wazneDo: string
  rozpoczal: string
}

function czytajTrwajaca(raw: string | undefined): Trwajaca | null {
  if (!raw) return null
  try {
    const t = JSON.parse(raw) as Trwajaca
    if (typeof t.n === 'string' && czyZakresWoo(t.zakres) && typeof t.wazneDo === 'string' && !Number.isNaN(Date.parse(t.wazneDo))) return t
  } catch {
    // niżej
  }
  return null
}

const scopeOf = (ref: KontoRef) => ({ channel: ref.channel, channelAccountId: ref.channelAccountId })

async function audit(db: PrismaClient, ref: KontoRef, actorId: string, after: Record<string, unknown>): Promise<void> {
  await db.auditLog.create({ data: { entity: 'ChannelConfig', entityId: `${ref.channel}/${ref.channelAccountId}`, actorId, after: after as Prisma.InputJsonValue } })
}

/** Konto Woo z panelu: adres sklepu z konfiguracji i czy wersja konta ma klucze zapisu. */
async function kontoWoo(db: PrismaClient, ref: KontoRef, registry: AdapterRegistry, env: Env): Promise<{ baseUrl: string; maZapis: boolean }> {
  if (ref.channel !== 'WOO') throw new KontoError('To nie jest konto WooCommerce')
  const row = await db.channelConfig.findFirst({ where: { channel: ref.channel, channelAccountId: ref.channelAccountId } })
  if (!row) throw new KontoError('Nie ma takiego konta')
  const config = row.config && typeof row.config === 'object' && !Array.isArray(row.config) ? (row.config as Record<string, unknown>) : {}
  const raw = typeof config['baseUrl'] === 'string' ? config['baseUrl'] : ''
  if (!raw) throw new KontoError('Najpierw wpisz adres sklepu w „Ustawienia i klucze”.')
  let baseUrl: string
  try {
    baseUrl = checkShopUrlShape(raw, env)
  } catch (e) {
    if (e instanceof AdresError) throw new KontoError(`Adres sklepu: ${e.message}`)
    throw e
  }
  const m = registry.get(row.adapterKey)?.manifest
  // link wc-auth dokleja ścieżkę do adresu sklepu, więc zapytanie (`?…`) i kotwica (`#…`) z adresu odpadają
  const u = new URL(baseUrl)
  return { baseUrl: `${u.origin}${u.pathname}`.replace(/\/+$/, ''), maZapis: !!m && !m.readOnly && m.secrets.some((s) => s.name === WRITE.key) }
}

/**
 * Adres strony zatwierdzenia w sklepie. `return_url` wraca na ekran konta (WooCommerce dokleja `success` i `user_id`),
 * `callback_url` na trasę panelu, która przyjmuje klucze.
 */
export function linkAutoryzacji(baseUrl: string, panel: string, ref: KontoRef, zakres: ZakresWoo, userId: string): string {
  const q = new URLSearchParams({
    app_name: 'Kompletor',
    scope: zakres,
    user_id: userId,
    return_url: `${panel}/ustawienia/kanaly/${encodeURIComponent(kodKonta(ref))}?woo=powrot`,
    callback_url: `${panel}${CALLBACK_PATH}`,
  })
  return `${baseUrl}/wc-auth/v1/authorize?${q}`
}

/**
 * „Połącz z WooCommerce”: nowy znacznik (poprzedni link przestaje działać) i adres strony zatwierdzenia w sklepie.
 * `read_write` tylko dla wersji konta z zapisem (klucz trafia do kluczy zapisu, odczyt dostaje go tylko, gdy nie ma
 * własnego).
 */
export async function rozpocznijWooAuth(
  db: PrismaClient,
  ref: KontoRef,
  zakres: ZakresWoo,
  opts: { env: Env; actorId: string; registry: AdapterRegistry; now?: Date },
): Promise<string> {
  const panel = adresPaneluWoo(opts.env)
  if (!panel.ok) throw new KontoError(panel.powod)
  const { baseUrl, maZapis } = await kontoWoo(db, ref, opts.registry, opts.env)
  if (zakres === 'read_write' && !maZapis) throw new KontoError('Ta wersja konta tylko czyta ze sklepu: najpierw przełącz ją na wersję z zapisem (sekcja „Zapis do sklepu”).')
  try {
    encryptionKeysFromEnv(opts.env)
  } catch {
    throw new KontoError('Serwer nie ma klucza szyfrowania (APP_ENCRYPTION_KEY), więc nie może zapisać kluczy sklepu. Zgłoś to administratorowi.')
  }
  const now = opts.now ?? new Date()
  const wazneDo = new Date(now.getTime() + WAZNOSC_MS)
  const n = randomBytes(24).toString('base64url')
  const t: Trwajaca = { n, zakres, wazneDo: wazneDo.toISOString(), rozpoczal: now.toISOString() }
  await setSecret(db, WOO_AUTORYZACJA, JSON.stringify(t), opts.env, scopeOf(ref))
  await audit(db, ref, opts.actorId, { wooAutoryzacja: 'rozpoczeta', zakres })
  const userId = podpiszZnacznik(opts.env, { o: organizationIdOf(db), a: ref.channelAccountId, n, e: Math.floor(wazneDo.getTime() / 1000) })
  return linkAutoryzacji(baseUrl, panel.url, ref, zakres, userId)
}

/** Przerwanie trwającego łączenia (przycisk „Anuluj”). Zapisane klucze zostają. */
export async function anulujWooAuth(db: PrismaClient, ref: KontoRef, actorId: string): Promise<boolean> {
  if (ref.channel !== 'WOO') throw new KontoError('To nie jest konto WooCommerce')
  const usuniete = await deleteSecret(db, WOO_AUTORYZACJA, scopeOf(ref))
  if (usuniete) await audit(db, ref, actorId, { wooAutoryzacja: 'anulowana' })
  return usuniete
}

export interface StanWoo {
  /** Adres panelu dla sklepu albo powód, dla którego przycisk jest wyszarzony. */
  panel: { ok: true; url: string } | { ok: false; powod: string }
  /** Wersja konta z kluczami zapisu (można prosić o prawo zapisu). */
  maZapis: boolean
  /** Trwające łączenie (link wysłany do sklepu, kluczy jeszcze nie ma). */
  trwa: { zakres: ZakresWoo; wazneDo: Date } | null
  /** Ostatnie zdarzenie łączenia z historii zmian konta (toast „Połączono” tylko po faktycznym zapisie kluczy). */
  ostatnieLaczenie: { wynik: string; kiedy: Date } | null
}

const WYNIKI_LACZENIA = ['rozpoczeta', 'anulowana', 'zapisana', 'wygasl', 'zle-uprawnienia', 'zly-ksztalt'] as const

/** `nie-trwa`: powrót bez trwającego łączenia (nigdy nie łączono albo anulowane). */
export type PowrotWoo = 'polaczono' | 'czeka' | 'nie-trwa' | 'wygasl' | 'zle-uprawnienia' | 'zly-ksztalt'

/**
 * Toast po powrocie ze sklepu z `success=1`. „Połączono” tylko wtedy, gdy ostatnie łączenie
 * skończyło się zapisem kluczy: wpis `zapisana` w historii albo (gdy wpis historii się nie udał) klucz ze sklepu
 * zapisany po rozpoczęciu łączenia. Wcześniej zapisane klucze przy odrzuconym POST (410, 400) nie dają „Połączono”.
 */
export function powrotWoo(s: Pick<StanWoo, 'trwa' | 'ostatnieLaczenie'>, kluczeZapisane: (Date | null)[]): PowrotWoo {
  const o = s.ostatnieLaczenie
  if (s.trwa) return 'czeka'
  if (!o) return 'nie-trwa'
  if (o.wynik === 'zapisana') return 'polaczono'
  if (o.wynik === 'wygasl' || o.wynik === 'zle-uprawnienia' || o.wynik === 'zly-ksztalt') return o.wynik
  if (o.wynik !== 'rozpoczeta') return 'nie-trwa'
  // znacznika już nie ma, a ostatni wpis to rozpoczęcie: albo klucze zapisane bez wpisu historii, albo link wygasł
  return kluczeZapisane.some((d) => !!d && d.getTime() > o.kiedy.getTime()) ? 'polaczono' : 'wygasl'
}

/** Stan „Połącz z WooCommerce” na ekranie konta (bez znacznika: ten zna tylko sklep i trasa przyjmująca klucze). */
export async function stanWoo(db: PrismaClient, ref: KontoRef, opts: { env: Env; registry: AdapterRegistry; now: Date }): Promise<StanWoo> {
  const row = await db.channelConfig.findFirst({ where: { channel: ref.channel, channelAccountId: ref.channelAccountId }, select: { adapterKey: true } })
  const m = row ? opts.registry.get(row.adapterKey)?.manifest : undefined
  let trwa: StanWoo['trwa'] = null
  try {
    const t = czytajTrwajaca((await resolveSecrets(db, [WOO_AUTORYZACJA], { env: opts.env, envFallback: false }, scopeOf(ref)))[WOO_AUTORYZACJA])
    if (t && Date.parse(t.wazneDo) > opts.now.getTime()) trwa = { zakres: t.zakres, wazneDo: new Date(t.wazneDo) }
  } catch {
    // brak klucza głównego: ekran pokaże powód przy próbie połączenia
  }
  const ost = await db.auditLog.findFirst({
    where: { entity: 'ChannelConfig', entityId: `${ref.channel}/${ref.channelAccountId}`, OR: WYNIKI_LACZENIA.map((w) => ({ after: { path: ['wooAutoryzacja'], equals: w } })) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { after: true, createdAt: true },
  })
  const wynik = ost?.after && typeof ost.after === 'object' && !Array.isArray(ost.after) ? (ost.after as Record<string, unknown>)['wooAutoryzacja'] : null
  return {
    panel: adresPaneluWoo(opts.env),
    maZapis: !!m && !m.readOnly && m.secrets.some((s) => s.name === WRITE.key),
    trwa,
    ostatnieLaczenie: ost && typeof wynik === 'string' ? { wynik, kiedy: ost.createdAt } : null,
  }
}

// ─── Klucze ze sklepu (trasa bez sesji) ──────────────────────────────────────

export type WynikKluczy =
  | { status: 200; kod: 'zapisane'; ref: KontoRef; organizationId: string }
  | { status: 400 | 403 | 409 | 410; kod: 'zly-ksztalt' | 'zly-podpis' | 'wygasl' | 'zuzyty' | 'zle-uprawnienia' }

const CK_RE = /^ck_[A-Za-z0-9]{20,64}$/
const CS_RE = /^cs_[A-Za-z0-9]{20,64}$/

/**
 * POST ze sklepu: `{ key_id, user_id, consumer_key, consumer_secret, key_permissions }`. Kolejność: typy pól, podpis
 * (bez dotykania bazy), termin, a dopiero potem baza firmy z podpisu i znacznik pod blokadą; kształt kluczy pod blokadą
 * (zły kształt po poprawnym podpisie zużywa znacznik i zostawia wynik w historii, więc
 * ekran nie pokazuje „czeka” do końca 15 minut, a sklep i tak kasuje odrzucony klucz). Wynik bez wartości kluczy.
 */
export async function przyjmijKluczeWoo(
  body: unknown,
  deps: { env: Env; now?: Date; db: (organizationId: string) => PrismaClient; log?: (m: string) => void },
): Promise<WynikKluczy> {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null
  if (!b || typeof b['user_id'] !== 'string' || typeof b['consumer_key'] !== 'string' || typeof b['consumer_secret'] !== 'string' || typeof b['key_permissions'] !== 'string')
    return { status: 400, kod: 'zly-ksztalt' }
  // podpis przed kształtem kluczy — niepodpisany klient widzi tylko 403
  const now = deps.now ?? new Date()
  const sp = sprawdzZnacznik(deps.env, b['user_id'], now)
  if (!sp) return { status: 403, kod: 'zly-podpis' }
  const ck = b['consumer_key'].trim()
  const cs = b['consumer_secret'].trim()
  if (sp.wygasl) return { status: 410, kod: 'wygasl' }
  const db = deps.db(sp.z.o)
  const ref: KontoRef = { channel: 'WOO', channelAccountId: sp.z.a }
  const uprawnienia = b['key_permissions']
  const keyId = typeof b['key_id'] === 'number' && Number.isInteger(b['key_id']) ? b['key_id'] : null
  const wynik = await podBlokadaSekretow<WynikKluczy | { zakres: ZakresWoo; zapisane: string[] }>(
    db,
    scopeOf(ref),
    WOO_AUTORYZACJA,
    [READ.key, READ.secret],
    deps.env,
    async (cur, zapisz) => {
      const t = czytajTrwajaca(cur[WOO_AUTORYZACJA])
      const a = Buffer.from(sp.z.n)
      // inny znacznik = stary link (zastąpiony nowym) albo podróbka: bieżącego łączenia nie ruszamy
      if (!t || a.length !== Buffer.byteLength(t.n) || !timingSafeEqual(a, Buffer.from(t.n))) return { status: 409, kod: 'zuzyty' }
      if (Date.parse(t.wazneDo) <= now.getTime()) {
        await zapisz({}, [WOO_AUTORYZACJA])
        return { status: 410, kod: 'wygasl' }
      }
      if (uprawnienia !== t.zakres) {
        // klucz o innych uprawnieniach niż prosiliśmy (np. zapis zamiast odczytu): nie bierzemy go, sklep go skasuje
        await zapisz({}, [WOO_AUTORYZACJA])
        return { status: 400, kod: 'zle-uprawnienia' }
      }
      if (!CK_RE.test(ck) || !CS_RE.test(cs)) {
        // klucz o złym kształcie od podpisanego sklepu: łączenie kończy się odmową (sklep skasuje klucz)
        await zapisz({}, [WOO_AUTORYZACJA])
        return { status: 400, kod: 'zly-ksztalt' }
      }
      const values: Record<string, string> = t.zakres === 'read' ? { [READ.key]: ck, [READ.secret]: cs } : { [WRITE.key]: ck, [WRITE.secret]: cs }
      // klucz z zapisem czyta też, więc konto bez klucza odczytu dostaje go jako odczyt (żeby od razu czytało)
      if (t.zakres === 'read_write' && (!cur[READ.key] || !cur[READ.secret])) Object.assign(values, { [READ.key]: ck, [READ.secret]: cs })
      await zapisz(values, [WOO_AUTORYZACJA])
      return { zakres: t.zakres, zapisane: Object.keys(values) }
    },
  )
  if (!wynik) return { status: 409, kod: 'zuzyty' } // znacznika już nie ma: użyty albo anulowany
  // Po commicie transakcji stan jest już przesądzony (klucze zapisane albo znacznik skasowany). Historia zmian i test
  // połączenia to dodatki: ich błąd nie zmienia odpowiedzi (500 po zapisie = sklep kasuje klucz,
  // a u nas zostaje martwy). W logu sama nazwa błędu i konto, bez treści żądania.
  const log = deps.log ?? ((m: string) => console.error(m))
  const dodatek = async (co: string, fn: () => Promise<unknown>) => {
    try {
      await fn()
    } catch (e) {
      log(`[woo-klucze] nie udało się: ${co}, konto WOO/${ref.channelAccountId}, ${e instanceof Error ? e.name : 'błąd'}`)
    }
  }
  if ('status' in wynik) {
    if (wynik.kod === 'wygasl' || wynik.kod === 'zle-uprawnienia' || wynik.kod === 'zly-ksztalt') await dodatek('wpis historii', () => audit(db, ref, 'sklep:wc-auth', { wooAutoryzacja: wynik.kod }))
    return wynik
  }
  await dodatek('wpis historii', () => audit(db, ref, 'sklep:wc-auth', { wooAutoryzacja: 'zapisana', zakres: wynik.zakres, sekretyZmienione: wynik.zapisane, kluczSklepu: keyId }))
  await dodatek('zlecenie testu połączenia', () => zlecTestPoNaprawie(db, ref, now)) // wyłączone po błędach wraca po udanym teście
  return { status: 200, kod: 'zapisane', ref, organizationId: sp.z.o }
}
