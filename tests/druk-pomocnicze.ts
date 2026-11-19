// pomocnicze do testów serwera druku. `fetchDruku` odwzorowuje cztery pliki app/api/druk/**/route.ts
// (każdy: requireStationToken → funkcja z lib/druk/agent-api.ts) bez serwera Next, z klientami bazy testów.
// Ten sam `fetch` dostaje prawdziwy klient HTTP agenta (KlientSerwera) w tests/druk-obieg.integration.test.ts.
import type { PrismaClient } from '@prisma/client'
import { obsluzListeZlecen, obsluzPlik, obsluzStan, obsluzWynik } from '@/lib/druk/agent-api'
import { requireStationToken, type ZaleznosciTokenu } from '@/lib/druk/tokeny'
import { dodajStanowisko, nowyToken } from '@/lib/druk/stanowiska'

export const SERWER = 'https://kompletor.example.invalid'

export function zaleznosci(sys: PrismaClient, firmy: Record<string, PrismaClient>): ZaleznosciTokenu {
  return {
    sys: () => sys,
    orgDb: (org) => {
      const db = firmy[org]
      if (!db) throw new Error(`brak klienta firmy ${org}`)
      return db
    },
  }
}

/** `fetch` dla adresów /api/druk/* — dokładnie to, co robią pliki tras. Inna ścieżka = 404 jak w Next. */
export function fetchDruku(deps: ZaleznosciTokenu, teraz: () => Date = () => new Date()): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    const sciezka = new URL(req.url).pathname
    const trasa =
      req.method === 'GET' && sciezka === '/api/druk/zlecenia'
        ? (ctx: Parameters<typeof obsluzListeZlecen>[0]) => obsluzListeZlecen(ctx, req, teraz())
        : req.method === 'POST' && sciezka === '/api/druk/stan'
          ? (ctx: Parameters<typeof obsluzStan>[0]) => obsluzStan(ctx, req, teraz())
          : (() => {
              const plik = req.method === 'GET' ? /^\/api\/druk\/pliki\/([^/]+)$/.exec(sciezka) : null
              if (plik) return (ctx: Parameters<typeof obsluzPlik>[0]) => obsluzPlik(ctx, decodeURIComponent(plik[1]!), teraz())
              const wynik = req.method === 'POST' ? /^\/api\/druk\/zlecenia\/([^/]+)\/wynik$/.exec(sciezka) : null
              if (wynik) return (ctx: Parameters<typeof obsluzWynik>[0]) => obsluzWynik(ctx, decodeURIComponent(wynik[1]!), req, teraz())
              return null
            })()
    if (!trasa) return new Response('Nie znaleziono', { status: 404 })
    const ctx = await requireStationToken(req, deps)
    if (ctx instanceof Response) return ctx
    return trasa(ctx)
  }) as typeof fetch
}

/** Stanowisko z tokenem (klient firmy, jak z ekranu Ustawienia → Druk). */
export async function stanowiskoZTokenem(db: PrismaClient, code = 'magazyn-1', nazwa = `Stanowisko ${code}`) {
  const id = await dodajStanowisko(db, { code, name: nazwa }, 'uzytkownik-testowy')
  const { token, kod } = await nowyToken(db, id, SERWER, 'uzytkownik-testowy')
  return { id, code, token, kod }
}

export const drukarka = (rola: string, stan: 'DOSTEPNA' | 'OFFLINE' | 'BLAD' = 'DOSTEPNA') => ({ rola, nazwa: `Drukarka ${rola}`, stan, zleceniaWKolejce: 0 })

/** Żądanie agenta do /api/druk z tokenem. */
export function zadanie(f: typeof fetch, token: string, metoda: 'GET' | 'POST', sciezka: string, tresc?: unknown): Promise<Response> {
  return f(`${SERWER}${sciezka}`, {
    method: metoda,
    headers: { authorization: `Bearer ${token}`, ...(tresc !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(tresc !== undefined ? { body: typeof tresc === 'string' ? tresc : JSON.stringify(tresc) } : {}),
  })
}

export async function raportStanu(f: typeof fetch, token: string, stanowisko: string, drukarki: object[], wersjaAgenta = '0.2.0') {
  const r = await zadanie(f, token, 'POST', '/api/druk/stan', { stanowisko, czas: '2020-01-01T00:00:00Z', wersjaAgenta, drukarki })
  if (r.status !== 200) throw new Error(`raport stanu: ${r.status} ${await r.text()}`)
}
