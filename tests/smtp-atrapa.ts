// Atrapa serwera SMTP do testów poczty: lokalnie na 127.0.0.1, losowy port, nic nie wychodzi do sieci.
// Obsługuje EHLO, AUTH PLAIN/LOGIN, MAIL, RCPT, DATA, RSET, QUIT. Tryby błędów: zły login, odmowa adresata (550),
// chwilowa odmowa (451 na MAIL FROM), zerwanie po DATA bez odpowiedzi. Zapisane maile da się rozłożyć `rozloz`.
import net from 'node:net'

export interface ZapisanyMail {
  od: string
  do: string[]
  surowy: string
}

export interface OpcjeAtrapy {
  login?: string
  haslo?: string
  /** Adresaci odrzucani kodem 550. */
  odrzuc?: string[]
  /** 451 na MAIL FROM (serwer chwilowo nie przyjmuje). */
  chwilowaOdmowa?: boolean
  /** pełna linia odpowiedzi 5xx na MAIL FROM, np. „530 5.7.0 Must issue a STARTTLS command first”. */
  odmowaNadawcy?: string | null
  /** Po kropce kończącej DATA zerwij połączenie bez odpowiedzi (wynik niepewny). */
  zerwijPoDanych?: boolean
  /** linia powitania zamiast 220, np. „554 5.7.1 Adres IP zablokowany” (potem rozłączenie). */
  powitanie?: string | null
  /** połączenie przyjęte, ale serwer milczy (bez powitania): test czasu oczekiwania. */
  milcz?: boolean
  /** pełna linia odpowiedzi 5xx na każde RCPT TO, np. „554 5.7.1 Relay access denied”. */
  odmowaAdresata?: string | null
}

export interface Atrapa {
  port: number
  maile: ZapisanyMail[]
  opcje: OpcjeAtrapy
  zamknij(): Promise<void>
}

export async function uruchomAtrape(opcje: OpcjeAtrapy = {}): Promise<Atrapa> {
  const maile: ZapisanyMail[] = []
  const gniazda = new Set<net.Socket>()
  const serwer = net.createServer((s) => {
    gniazda.add(s)
    s.on('close', () => gniazda.delete(s))
    s.on('error', () => {})
    let bufor = ''
    let wDanych = false
    let dane = ''
    let od = ''
    let doKogo: string[] = []
    let czekaLogin: 'login' | 'haslo' | null = null
    let login = ''
    const pisz = (l: string) => s.write(`${l}\r\n`)
    const sprawdz = (u: string, p: string) => (!opcje.login || (u === opcje.login && p === opcje.haslo) ? '235 2.7.0 OK' : '535 5.7.8 Zly login albo haslo')
    if (opcje.milcz) return
    if (opcje.powitanie) {
      pisz(opcje.powitanie)
      s.end()
      return
    }
    pisz('220 atrapa ESMTP')
    s.on('data', (chunk) => {
      bufor += chunk.toString('latin1')
      for (;;) {
        if (wDanych) {
          const k = bufor.indexOf('\r\n.\r\n')
          const start = dane === '' && bufor.startsWith('.\r\n') ? 0 : -1
          if (k < 0 && start < 0) {
            dane += bufor
            bufor = ''
            return
          }
          const koniec = start === 0 ? 0 : k
          dane += bufor.slice(0, koniec)
          bufor = bufor.slice(koniec + (start === 0 ? 3 : 5))
          wDanych = false
          const surowy = Buffer.from(dane, 'latin1').toString('utf8').replace(/\r\n\.\./g, '\r\n.')
          maile.push({ od, do: doKogo, surowy })
          dane = ''
          if (opcje.zerwijPoDanych) {
            s.destroy()
            return
          }
          pisz(`250 2.0.0 Ok: queued as atrapa${maile.length}`)
          continue
        }
        const i = bufor.indexOf('\r\n')
        if (i < 0) return
        const linia = bufor.slice(0, i)
        bufor = bufor.slice(i + 2)
        if (czekaLogin === 'login') {
          login = Buffer.from(linia, 'base64').toString('utf8')
          czekaLogin = 'haslo'
          pisz('334 UGFzc3dvcmQ6')
          continue
        }
        if (czekaLogin === 'haslo') {
          czekaLogin = null
          pisz(sprawdz(login, Buffer.from(linia, 'base64').toString('utf8')))
          continue
        }
        const cmd = linia.toUpperCase()
        if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) {
          s.write('250-atrapa\r\n250-AUTH PLAIN LOGIN\r\n250-8BITMIME\r\n250 SMTPUTF8\r\n')
        } else if (cmd.startsWith('AUTH PLAIN')) {
          const b = linia.split(' ')[2] ?? ''
          const [, u, p] = Buffer.from(b, 'base64').toString('utf8').split('\u0000')
          pisz(sprawdz(u ?? '', p ?? ''))
        } else if (cmd.startsWith('AUTH LOGIN')) {
          czekaLogin = 'login'
          pisz('334 VXNlcm5hbWU6')
        } else if (cmd.startsWith('MAIL FROM')) {
          if (opcje.chwilowaOdmowa) {
            pisz('451 4.3.0 Sprobuj pozniej')
            continue
          }
          if (opcje.odmowaNadawcy) {
            pisz(opcje.odmowaNadawcy)
            continue
          }
          od = /<([^>]*)>/.exec(linia)?.[1] ?? ''
          doKogo = []
          pisz('250 2.1.0 Ok')
        } else if (cmd.startsWith('RCPT TO')) {
          const a = /<([^>]*)>/.exec(linia)?.[1] ?? ''
          // jak prawdziwe serwery: odpowiedź odbija pełny adres adresata (test maskowania w błędach)
          if (opcje.odmowaAdresata) pisz(opcje.odmowaAdresata)
          else if (opcje.odrzuc?.includes(a)) pisz(`550 5.1.1 <${a}>: Nie ma takiej skrzynki`)
          else {
            doKogo.push(a)
            pisz('250 2.1.5 Ok')
          }
        } else if (cmd === 'DATA') {
          wDanych = true
          dane = ''
          pisz('354 Koniec kropka')
        } else if (cmd === 'RSET' || cmd === 'NOOP') {
          pisz('250 Ok')
        } else if (cmd === 'QUIT') {
          pisz('221 Bye')
          s.end()
        } else pisz('502 Nieznane polecenie')
      }
    })
  })
  await new Promise<void>((ok) => serwer.listen(0, '127.0.0.1', ok))
  const port = (serwer.address() as net.AddressInfo).port
  return {
    port,
    maile,
    opcje,
    zamknij: () =>
      new Promise<void>((ok) => {
        for (const g of gniazda) g.destroy()
        serwer.close(() => ok())
      }),
  }
}

// ─── Rozkład maila (MIME) ────────────────────────────────────────────────────

export interface Rozlozony {
  naglowki: Record<string, string>
  temat: string
  tekst: string
  html: string
  zalaczniki: { nazwa: string; typ: string; tresc: Buffer }[]
}

function naglowkiZ(blok: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const l of blok.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
    const i = l.indexOf(':')
    if (i > 0) out[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim()
  }
  return out
}

function slowaZakodowane(s: string): string {
  return s.replace(/=\?utf-8\?([bq])\?([^?]*)\?=\s*/gi, (_, enc: string, t: string) =>
    enc.toLowerCase() === 'b' ? Buffer.from(t, 'base64').toString('utf8') : Buffer.from(t.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8'),
  )
}

/** Nazwa pliku z polskimi znakami (RFC 2231): `filename*=utf-8''…` albo w kawałkach `filename*0*=…; filename*1*=…`. */
function nazwaZRfc2231(dysp: string): string | null {
  const czesci = [...dysp.replace(/\r\n[ \t]+/g, ' ').matchAll(/filename\*(\d*)\*?="?([^";]+)"?/gi)]
  if (!czesci.length) return null
  const sklejone = czesci
    .sort((a, b) => Number(a[1] || 0) - Number(b[1] || 0))
    .map((m) => m[2]!.trim())
    .join('')
    .replace(/^[\w-]*'[\w-]*'/, '')
  return decodeURIComponent(sklejone)
}

function dekodujTresc(tresc: string, kodowanie: string | undefined): Buffer {
  const k = (kodowanie ?? '').toLowerCase()
  if (k === 'base64') return Buffer.from(tresc.replace(/\s+/g, ''), 'base64')
  if (k === 'quoted-printable') {
    const bez = tresc.replace(/=\r\n/g, '')
    const bajty: number[] = []
    for (let i = 0; i < bez.length; i++) {
      if (bez[i] === '=' && /^[0-9A-F]{2}$/i.test(bez.slice(i + 1, i + 3))) {
        bajty.push(parseInt(bez.slice(i + 1, i + 3), 16))
        i += 2
      } else bajty.push(...Buffer.from(bez[i]!, 'utf8'))
    }
    return Buffer.from(bajty)
  }
  return Buffer.from(tresc, 'utf8')
}

/** Do porównań w testach: końce linii jak w kodzie (\n), twarde spacje z formatowania kwot jak zwykłe. */
const norm = (t: string) => t.replace(/\r\n/g, '\n').replace(/[  ]/g, ' ')

export function rozloz(surowy: string): Rozlozony {
  const wynik: Rozlozony = { naglowki: {}, temat: '', tekst: '', html: '', zalaczniki: [] }
  const czesc = (s: string, korzen: boolean) => {
    const sep = s.indexOf('\r\n\r\n')
    const h = naglowkiZ(sep >= 0 ? s.slice(0, sep) : s)
    const cialo = sep >= 0 ? s.slice(sep + 4) : ''
    if (korzen) {
      wynik.naglowki = h
      wynik.temat = slowaZakodowane(h['subject'] ?? '')
    }
    const typ = h['content-type'] ?? 'text/plain'
    const granica = /boundary="?([^";]+)"?/i.exec(typ)?.[1]
    if (/^multipart\//i.test(typ) && granica) {
      for (const p of cialo.split(`--${granica}`).slice(1)) {
        if (p.startsWith('--')) break
        czesc(p.replace(/^\r\n/, ''), false)
      }
      return
    }
    const tresc = dekodujTresc(cialo, h['content-transfer-encoding'])
    const dysp = h['content-disposition'] ?? ''
    if (/attachment/i.test(dysp)) {
      const nazwa = nazwaZRfc2231(dysp) ?? slowaZakodowane(/filename="?([^";]+)"?/i.exec(dysp)?.[1] ?? '')
      wynik.zalaczniki.push({ nazwa, typ: typ.split(';')[0]!.trim(), tresc })
    } else if (/^text\/html/i.test(typ)) wynik.html = norm(tresc.toString('utf8'))
    else if (/^text\/plain/i.test(typ)) wynik.tekst = norm(tresc.toString('utf8'))
  }
  czesc(surowy, true)
  return wynik
}

/**
 * Zmienne poczty instalacji (RESET_SMTP_*, lib/poczta/instalacja.ts) wskazujące atrapę: linki resetu hasła idą tylko
 * tą drogą, nigdy serwerem poczty firmy. Dane fikcyjne, serwer na 127.0.0.1.
 */
export function envPocztyInstalacji(a: Atrapa, o: { login?: string; haslo?: string } = {}): Record<string, string> {
  return {
    RESET_SMTP_HOST: '127.0.0.1',
    RESET_SMTP_PORT: String(a.port),
    RESET_SMTP_SZYFROWANIE: 'BRAK',
    RESET_SMTP_LOGIN: o.login ?? 'instalacja',
    RESET_SMTP_PASSWORD: o.haslo ?? 'haslo-instalacji',
    RESET_SMTP_NADAWCA: 'konta@kompletor.example.com',
    RESET_SMTP_NAZWA: 'Kompletor',
  }
}
