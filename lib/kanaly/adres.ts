// Adres sklepu z formularza panelu: serwer wywołuje go sam (test połączenia, pobranie ofert), więc to
// wejście SSRF. Zawsze: tylko https, bez loginu i hasła w adresie, port 443 albo domyślny. Hosting (APP_MODE=hosted,
// wiele firm na jednym serwerze): dodatkowo bez hostów i adresów prywatnych, pętli zwrotnej, link-local i metadanych
// chmury, sprawdzane po rozwiązaniu DNS przed każdym żądaniem (guardedFetch). Self-host może mieć sklep w sieci
// lokalnej, więc tam sieć prywatna jest dozwolona.
// Ograniczenie: między sprawdzeniem DNS a połączeniem rekord może się zmienić (DNS rebinding). Przekierowania w
// hostingu są wyłączone (redirect: manual), żeby sklep nie odesłał żądania na adres wewnętrzny.
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { appModeOf } from '../db'
import type { FetchLike } from '../zrodla/http'

export class AdresError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AdresError'
  }
}

type Env = Record<string, string | undefined>

/** IPv4 jako liczba albo null. Wejście już po parserze URL (postać kropkowa dziesiętna). */
function v4ToInt(ip: string): number | null {
  const p = ip.split('.')
  if (p.length !== 4) return null
  let n = 0
  for (const x of p) {
    if (!/^\d{1,3}$/.test(x) || Number(x) > 255) return null
    n = n * 256 + Number(x)
  }
  return n
}

const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8], // „ta sieć”
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // pętla zwrotna
  ['169.254.0.0', 16], // link-local, w tym metadane chmury 169.254.169.254
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // zarezerwowane i rozgłoszenie
]

function v4Blocked(ip: string): boolean {
  const n = v4ToInt(ip)
  if (n === null) return true
  return V4_BLOCKED.some(([base, bits]) => {
    const b = v4ToInt(base)!
    const size = 2 ** (32 - bits)
    return n >= b && n < b + size
  })
}

/** IPv6 → 8 grup po 16 bitów (z „::” i końcówką IPv4); null = nieczytelny. */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '')
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)
  const v4 = s.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (v4) {
    const n = v4ToInt(v4[2]!)
    if (n === null) return null
    s = `${v4[1]}${Math.floor(n / 65536).toString(16)}:${(n % 65536).toString(16)}`
  }
  const parts = s.split('::')
  if (parts.length > 2) return null
  const head = parts[0] ? parts[0].split(':') : []
  const rest = parts.length === 2 && parts[1] ? parts[1].split(':') : []
  const toNum = (x: string) => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : Number.NaN)
  const h = head.filter((x) => x !== '').map(toNum)
  const r = rest.filter((x) => x !== '').map(toNum)
  if ([...h, ...r].some((x) => Number.isNaN(x))) return null
  const fill = 8 - h.length - r.length
  if (parts.length === 1 && fill !== 0) return null
  if (fill < 0) return null
  return [...h, ...Array<number>(fill).fill(0), ...r]
}

function v6Blocked(ip: string): boolean {
  const g = v6Groups(ip)
  if (!g) return true
  const zeroHead = (k: number) => g.slice(0, k).every((x) => x === 0)
  if (g.every((x) => x === 0)) return true // ::
  if (zeroHead(7) && g[7] === 1) return true // ::1
  // IPv4 w IPv6: ::ffff:a.b.c.d (mapowany), ::a.b.c.d (zgodny), 64:ff9b::a.b.c.d (NAT64) — decyduje adres IPv4
  const embedded = `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`
  if (zeroHead(5) && g[5] === 0xffff) return v4Blocked(embedded)
  if (zeroHead(6)) return v4Blocked(embedded)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4Blocked(embedded)
  const first = g[0]!
  if ((first & 0xfe00) === 0xfc00) return true // fc00::/7 unikalne lokalne (w tym fd00:ec2::254, metadane AWS)
  if ((first & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true // fec0::/10 site-local (przestarzałe)
  if ((first & 0xff00) === 0xff00) return true // multicast
  if (first === 0x2001 && g[1] === 0x0db8) return true // dokumentacja
  if (first === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return true // 100::/64 (do odrzucania ruchu)
  return false
}

/** Adres IP prywatny, pętli zwrotnej, link-local, metadanych albo zarezerwowany (true = nie łączymy się). */
export function isBlockedIp(ip: string): boolean {
  const kind = isIP(ip.replace(/^\[|\]$/g, '').replace(/%.*$/, ''))
  if (kind === 4) return v4Blocked(ip)
  if (kind === 6) return v6Blocked(ip)
  return true
}

const BLOCKED_HOST_RE = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|home\.arpa)$/i

/**
 * Kształt adresu (bez sieci): https, bez loginu, port 443/domyślny, bez fragmentu. Hosting: dodatkowo bez nazw
 * lokalnych, jednoczłonowych i adresów IP z sieci prywatnej. Zwraca adres znormalizowany (bez końcowego „/”).
 */
export function checkShopUrlShape(raw: string, env: Env): string {
  const s = raw.trim()
  if (!s) throw new AdresError('Podaj adres sklepu')
  if (s.length > 500) throw new AdresError('Adres sklepu jest za długi')
  let u: URL
  try {
    u = new URL(s)
  } catch {
    throw new AdresError('Adres sklepu ma zły format (np. https://sklep.pl)')
  }
  if (u.protocol !== 'https:') throw new AdresError('Adres sklepu musi zaczynać się od https://')
  if (u.username || u.password) throw new AdresError('Adres sklepu nie może zawierać loginu ani hasła (klucze wpisz w polach niżej)')
  if (u.port && u.port !== '443') throw new AdresError('Adres sklepu może używać tylko portu 443')
  if (u.hash) throw new AdresError('Adres sklepu nie może zawierać „#”')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (!host) throw new AdresError('Adres sklepu bez nazwy hosta')
  if (appModeOf(env) === 'hosted') {
    if (isIP(host)) {
      if (isBlockedIp(host)) throw new AdresError('Adres sklepu wskazuje sieć prywatną albo adres zastrzeżony')
    } else {
      if (!host.includes('.') || BLOCKED_HOST_RE.test(host.replace(/\.$/, ''))) throw new AdresError('Adres sklepu musi być publiczną domeną')
    }
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}${u.search}`
}

/**
 * Wszystkie komunikaty AdresError (stałe teksty, bez danych z kanału). Komunikat testu połączenia pokazuje je tylko
 * wtedy, gdy błąd zawiera jeden z nich dosłownie, zamiast przepuszczać surowy tekst.
 * Test w adres.test.ts pilnuje, że każdy komunikat rzucany jako AdresError w tym pliku jest na liście.
 */
export const ADRES_KOMUNIKATY: readonly string[] = [
  'Adres sklepu bez nazwy hosta',
  'Adres sklepu jest za długi',
  'Adres sklepu ma zły format (np. https://sklep.pl)',
  'Adres sklepu może używać tylko portu 443',
  'Adres sklepu musi być publiczną domeną',
  'Adres sklepu musi zaczynać się od https://',
  'Adres sklepu nie może zawierać loginu ani hasła (klucze wpisz w polach niżej)',
  'Adres sklepu nie może zawierać „#”',
  'Adres sklepu wskazuje sieć prywatną albo adres zastrzeżony',
  'Nie udało się odnaleźć adresu sklepu (DNS)',
  'Podaj adres sklepu',
]

/** Nasz komunikat adresu zawarty w tekście błędu (np. owiniętym przez klienta kanału) albo null. */
export function znanyKomunikatAdresu(raw: string): string | null {
  return ADRES_KOMUNIKATY.find((m) => raw.includes(m)) ?? null
}

export type Resolver = (host: string) => Promise<string[]>

const systemResolver: Resolver = async (host) => (await lookup(host, { all: true, order: 'verbatim' })).map((a) => a.address)

/** Pełne sprawdzenie przed żądaniem: kształt, a w hostingu także wszystkie adresy z DNS. */
export async function assertShopUrl(raw: string, env: Env, resolve: Resolver = systemResolver): Promise<string> {
  const norm = checkShopUrlShape(raw, env)
  if (appModeOf(env) !== 'hosted') return norm
  const host = new URL(norm).hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) return norm
  let ips: string[]
  try {
    ips = await resolve(host)
  } catch {
    throw new AdresError('Nie udało się odnaleźć adresu sklepu (DNS)')
  }
  if (!ips.length) throw new AdresError('Nie udało się odnaleźć adresu sklepu (DNS)')
  if (ips.some(isBlockedIp)) throw new AdresError('Adres sklepu wskazuje sieć prywatną albo adres zastrzeżony')
  return norm
}

/**
 * fetch adaptera z kontrolą adresu każdego żądania (konto z panelu). W hostingu bez przekierowań: odpowiedź 3xx
 * wraca do klienta kanału jako błąd HTTP, a nie jako żądanie pod nowy adres.
 */
export function guardedFetch(env: Env, inner: FetchLike = fetch, resolve: Resolver = systemResolver): FetchLike {
  const hosted = appModeOf(env) === 'hosted'
  return async (url, init) => {
    await assertShopUrl(String(url), env, resolve)
    return inner(url, hosted ? { ...(init ?? {}), redirect: 'manual' } : init)
  }
}
