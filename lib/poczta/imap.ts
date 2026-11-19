// Skrzynka IMAP dla czytnika odbić. Cienki port: czytnik (lib/poczta/czytnik-odbic.ts) zna tylko
// `SkrzynkaImap`, a biblioteka (imapflow, MIT) siedzi wyłącznie w `otworzSkrzynkeImap`. Testy podstawiają atrapę portu.
//
// Zasady: pobieranie treści przez BODY.PEEK (imapflow `source`), więc mail niebędący raportem zostaje nieprzeczytany;
// rozpoznany raport dostaje \Seen i idzie do podfolderu „Kompletor/odbicia” (separator folderów serwera dobiera
// imapflow); nieudane przeniesienie zostawia go przeczytanego w folderze, bez błędu przebiegu. W hostingu tylko
// publiczny serwer (jak SMTP, `tylkoPubliczne`): nazwa rozwiązana raz, łączymy się ze sprawdzonym adresem IP, a nazwa
// zostaje do weryfikacji certyfikatu TLS.
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { ImapFlow } from 'imapflow'
import { BEZPIECZENSTWO, bezpiecznyBlad, HOST_RE, LOKALNE_NAZWY, prywatnyAdresIp, type Bezpieczenstwo } from '../maile/transport'

export const ETYKIETA_SZYFROWANIA_IMAP: Record<Bezpieczenstwo, string> = {
  TLS: 'SSL/TLS od początku (zwykle port 993)',
  STARTTLS: 'STARTTLS (zwykle port 143)',
  BRAK: 'bez szyfrowania (tylko serwer w tej samej sieci)',
}

/** Porty IMAP dozwolone w hostingu. */
export const PORTY_IMAP_HOSTINGU: readonly number[] = [993, 143]
export const IMAP_TIMEOUT_MS = 20_000
/** Podfolder na rozpoznane raporty (części ścieżki; separator dobiera serwer). */
export const FOLDER_ODBIC = ['Kompletor', 'odbicia'] as const

export interface KonfiguracjaImap {
  host: string
  port: number
  bezpieczenstwo: Bezpieczenstwo
  login: string
  haslo: string
}

export interface MailWSkrzynce {
  uid: number
  /** Rozmiar w bajtach (RFC822.SIZE). */
  rozmiar: number
}

export interface SkrzynkaImap {
  /** UIDVALIDITY otwartego folderu: zmiana = numery UID od nowa (stan czytnika do wyzerowania). */
  readonly uidValidity: string
  /** Nieprzeczytane maile z UID większym niż `odUid`, rosnąco, najwyżej `limit`. */
  nieprzeczytane(odUid: number, limit: number): Promise<MailWSkrzynce[]>
  /** Surowa treść maila bez oznaczania go jako przeczytany; null = maila już nie ma. */
  pobierz(uid: number): Promise<Buffer | null>
  /** Rozpoznany raport: \Seen i przeniesienie do podfolderu; gdy przeniesienie się nie uda, zostaje przeczytany. */
  odloz(uid: number): Promise<'PRZENIESIONY' | 'PRZECZYTANY'>
  zamknij(): Promise<void>
}

export type OtworzSkrzynke = (cfg: KonfiguracjaImap, folder: string) => Promise<SkrzynkaImap>

/** Serwer odrzucił login albo hasło: czytnik stoi do poprawy danych (bez ponawiania co 5 min, żeby nie blokować konta). */
export class BladLogowaniaImap extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BladLogowaniaImap'
  }
}

/**
 * Połączenie ze skrzynką zerwało się w trakcie przebiegu: to nie wina konkretnego maila, więc czytnik przerywa
 * przebieg bez liczenia porażki maila i następny przebieg zaczyna od tego samego miejsca.
 */
export class BladPolaczeniaImap extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BladPolaczeniaImap'
  }
}

/** Kody odmowy logowania (RFC 5530), które znaczą trwałą odmowę danych: ponawianie grozi blokadą konta. */
const TRWALA_ODMOWA_LOGOWANIA = new Set(['AUTHENTICATIONFAILED', 'AUTHORIZATIONFAILED', 'EXPIRED'])

/**
 * Odmowa logowania, która oznacza złe dane: kod odpowiedzi pusty, AUTHENTICATIONFAILED, AUTHORIZATIONFAILED albo
 * EXPIRED (wygasłe hasło albo konto bez prawa logowania też wstrzymuje czytanie). Inne
 * kody przy odmowie (UNAVAILABLE, CONTACTADMIN, limit połączeń) to stan chwilowy po stronie serwera: błąd do ponowienia.
 */
export function odrzuconeDaneLogowania(e: unknown): boolean {
  if (!e || typeof e !== 'object' || !(e as { authenticationFailed?: unknown }).authenticationFailed) return false
  const kod = (e as { serverResponseCode?: unknown }).serverResponseCode
  return kod === undefined || kod === null || kod === '' || TRWALA_ODMOWA_LOGOWANIA.has(String(kod).toUpperCase())
}

/** Nazwa folderu skrzynki: niepusta, bez znaków sterujących i symboli wieloznacznych IMAP. */
export function bladFolderu(folder: string): string | null {
  return !folder.trim() || folder.length > 200 || /[\u0000-\u001f\u007f*%]/.test(folder) ? 'Folder IMAP: nazwa folderu, np. INBOX (bez znaków * i %)' : null
}

/** Konfiguracja skrzynki z formularza albo bazy; lista błędów po polsku (pusta = poprawna). */
export function sprawdzKonfiguracjeImap(k: { host: string; port: number; bezpieczenstwo: string; folder: string }, o: { hosting: boolean }): string[] {
  const bledy: string[] = []
  const host = k.host.trim()
  if (!host) bledy.push('Podaj adres serwera IMAP')
  else if (!(isIP(host) || HOST_RE.test(host))) bledy.push('Adres serwera IMAP: sama nazwa serwera, np. imap.firma.pl (bez http:// i bez portu)')
  if (!Number.isInteger(k.port) || k.port < 1 || k.port > 65535) bledy.push('Port IMAP: liczba od 1 do 65535')
  if (!(BEZPIECZENSTWO as readonly string[]).includes(k.bezpieczenstwo)) bledy.push('Wybierz szyfrowanie połączenia IMAP')
  const f = bladFolderu(k.folder)
  if (f) bledy.push(f)
  if (o.hosting && host) {
    if (prywatnyAdresIp(host) || LOKALNE_NAZWY.test(host)) bledy.push('W hostingu serwer IMAP musi być dostępny z internetu (bez adresów lokalnych i prywatnych)')
    if (Number.isInteger(k.port) && !PORTY_IMAP_HOSTINGU.includes(k.port)) bledy.push(`W hostingu port IMAP: ${PORTY_IMAP_HOSTINGU.join(', ')}`)
    if (k.bezpieczenstwo === 'BRAK') bledy.push('W hostingu połączenie z serwerem IMAP musi być szyfrowane')
  }
  return bledy
}

const kodBledu = (e: unknown) => (e && typeof e === 'object' ? ((e as { serverResponseCode?: unknown }).serverResponseCode ?? (e as { code?: unknown }).code) : undefined)

/** Skrzynka przez imapflow. `tylkoPubliczne` (hosting): połączenie tylko z publicznym adresem IP. */
export function otworzSkrzynkeImap(o: { tylkoPubliczne?: boolean; timeoutMs?: number } = {}): OtworzSkrzynke {
  const timeout = o.timeoutMs ?? IMAP_TIMEOUT_MS
  return async (cfg, folder) => {
    let adres = cfg.host
    if (o.tylkoPubliczne) {
      const ip = isIP(cfg.host) ? cfg.host : (await lookup(cfg.host)).address
      if (prywatnyAdresIp(ip)) throw new Error(`serwer ${cfg.host} wskazuje adres lokalny albo prywatny`)
      adres = ip
    }
    const klient = new ImapFlow({
      host: adres,
      port: cfg.port,
      secure: cfg.bezpieczenstwo === 'TLS',
      doSTARTTLS: cfg.bezpieczenstwo === 'STARTTLS' ? true : cfg.bezpieczenstwo === 'BRAK' ? false : undefined,
      servername: adres !== cfg.host ? cfg.host : undefined,
      auth: { user: cfg.login, pass: cfg.haslo },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: timeout,
      greetingTimeout: timeout,
      socketTimeout: timeout * 3,
      // pojedynczy mail większy niż limit czytnika i tak nie jest pobierany; zapas na nagłówki odpowiedzi
      maxLiteralSize: 4 * 1024 * 1024,
    })
    // błąd gniazda po połączeniu nie może wywalić procesu workera (EventEmitter bez nasłuchu „error” rzuca)
    klient.on('error', () => {})
    try {
      await klient.connect()
    } catch (e) {
      klient.close()
      if (odrzuconeDaneLogowania(e)) throw new BladLogowaniaImap(bezpiecznyBlad(e instanceof Error ? e.message : String(e), cfg.haslo))
      throw new Error(bezpiecznyBlad(`połączenie z serwerem IMAP ${cfg.host}: ${e instanceof Error ? e.message : String(e)}`, cfg.haslo))
    }
    let uidValidity: string
    try {
      uidValidity = String((await klient.mailboxOpen(folder)).uidValidity)
    } catch (e) {
      await klient.logout().catch(() => klient.close())
      throw new Error(`nie ma folderu „${folder.slice(0, 60)}” w skrzynce (${String(kodBledu(e) ?? 'brak folderu')})`)
    }
    let cel: string | null = null
    let bezCelu = false // folderu nie da się założyć ani znaleźć: w tej sesji już nie próbujemy przy każdym raporcie
    // błąd przy zerwanym połączeniu (klient już nieużywalny) = BladPolaczeniaImap, nie porażka konkretnego maila
    const imap = async <T>(f: () => Promise<T>): Promise<T> => {
      try {
        return await f()
      } catch (e) {
        if (!klient.usable) throw new BladPolaczeniaImap(bezpiecznyBlad(`połączenie z serwerem IMAP ${cfg.host} przerwane: ${e instanceof Error ? e.message : String(e)}`, cfg.haslo))
        throw e
      }
    }
    // serwer odmawia CREATE (folder już jest, bez kodu ALREADYEXISTS): ścieżka z listy folderów i separatora serwera
    const znajdzCel = async (): Promise<string | null> => {
      const lista = await klient.list()
      const szukane = FOLDER_ODBIC.join('/').toLowerCase()
      const sciezka = (x: { path: string; delimiter?: string }) => x.path.split(x.delimiter || '/').join('/').toLowerCase()
      // serwer z przedrostkiem przestrzeni nazw (`INBOX.`) ma folder pod
      // `INBOX.Kompletor.odbicia`: najpierw dokładna ścieżka, potem po końcówce `…<sep>Kompletor<sep>odbicia`
      const f = lista.find((x) => sciezka(x) === szukane) ?? lista.find((x) => sciezka(x).endsWith(`/${szukane}`))
      return f ? f.path : null
    }
    return {
      uidValidity,
      async nieprzeczytane(odUid, limit) {
        // serwer zwraca wszystkie nieprzeczytane UID powyżej kursora (same numery, bez treści); limit liczymy u nas
        const uidy = ((await imap(() => klient.search({ seen: false, uid: `${odUid + 1}:*` }, { uid: true }))) || []).filter((u) => u > odUid).sort((a, b) => a - b).slice(0, limit)
        if (!uidy.length) return []
        const lista = await imap(() => klient.fetchAll(uidy.join(','), { uid: true, size: true }, { uid: true }))
        return lista.map((m) => ({ uid: m.uid, rozmiar: m.size ?? 0 })).sort((a, b) => a.uid - b.uid)
      },
      async pobierz(uid) {
        const m = await imap(() => klient.fetchOne(String(uid), { uid: true, source: true }, { uid: true }))
        return m && m.source ? m.source : null
      },
      async odloz(uid) {
        await imap(() => klient.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }))
        try {
          if (!cel && !bezCelu) {
            try {
              cel = (await klient.mailboxCreate([...FOLDER_ODBIC])).path
            } catch (e) {
              if (!klient.usable) throw e
              cel = await znajdzCel().catch(() => null)
              if (!cel) bezCelu = true
            }
          }
          if (!cel) return 'PRZECZYTANY'
          const r = await klient.messageMove(String(uid), cel, { uid: true })
          return r ? 'PRZENIESIONY' : 'PRZECZYTANY'
        } catch (e) {
          if (!klient.usable) throw new BladPolaczeniaImap(bezpiecznyBlad(`połączenie z serwerem IMAP ${cfg.host} przerwane: ${e instanceof Error ? e.message : String(e)}`, cfg.haslo))
          return 'PRZECZYTANY'
        }
      },
      async zamknij() {
        await klient.logout().catch(() => klient.close())
      },
    }
  }
}
