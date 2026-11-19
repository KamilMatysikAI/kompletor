// Logika tras agenta /api/druk/*. Pliki app/api/druk/**/route.ts tylko sprawdzają token
// (requireStationToken) i wołają te funkcje — dzięki temu test obiegu łączy prawdziwy klient HTTP agenta z tym kodem
// bez serwera Next. Walidacja ręczna (repo nie ma zod), treść żądania najwyżej 16 KB. Odpowiedzi wyłącznie z pól
// kontraktu (agent-druku/src/kontrakt.ts), bez danych klientów; nic z treści żądań nie trafia do logów.
import type { PrintFileFormat } from '@prisma/client'
import { jestRola } from './role'
import { sprawdzKodStanowiska, type KontekstStanowiska } from './tokeny'
import { MAKS_KOMUNIKATU, plikDlaAgenta, zapiszStan, zapiszWynik, zleceniaDlaAgenta, type WynikAgenta } from './zlecenia'

export const MAKS_TRESCI = 16 * 1024
const MAKS_DRUKAREK = 120
const WZOR_ID = /^[A-Za-z0-9_-]{1,100}$/
const BEZ_CACHE = { 'Cache-Control': 'no-store' }

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: BEZ_CACHE })
const blad = (status: number, error: string) => json({ error }, status)

/** Treść JSON najwyżej `limit` bajtów (czytana strumieniowo — długie body nie trafia do pamięci). */
export async function czytajJson(req: Request, limit = MAKS_TRESCI): Promise<{ ok: true; json: unknown } | { ok: false; odpowiedz: Response }> {
  const deklarowany = Number(req.headers.get('content-length') ?? '0')
  if (deklarowany > limit) return { ok: false, odpowiedz: blad(413, `Treść żądania ponad ${limit} B`) }
  const czytnik = req.body?.getReader()
  const kawalki: Uint8Array[] = []
  let razem = 0
  if (czytnik) {
    for (;;) {
      const { done, value } = await czytnik.read()
      if (done) break
      razem += value.byteLength
      if (razem > limit) {
        await czytnik.cancel().catch(() => undefined)
        return { ok: false, odpowiedz: blad(413, `Treść żądania ponad ${limit} B`) }
      }
      kawalki.push(value)
    }
  }
  try {
    return { ok: true, json: JSON.parse(Buffer.concat(kawalki).toString('utf8')) }
  } catch {
    return { ok: false, odpowiedz: blad(400, 'Treść żądania nie jest JSON-em') }
  }
}

const tekst = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined)

/** GET /api/druk/zlecenia?stanowisko=<code> */
export async function obsluzListeZlecen(ctx: KontekstStanowiska, req: Request, now = new Date()): Promise<Response> {
  const zle = sprawdzKodStanowiska(ctx, new URL(req.url).searchParams.get('stanowisko'))
  if (zle) return zle
  return json({ zlecenia: await zleceniaDlaAgenta(ctx.db, ctx.stanowisko.id, now) })
}

const TYP_PLIKU: Record<PrintFileFormat, string> = { pdf: 'application/pdf', zpl: 'application/octet-stream' }

/** GET /api/druk/pliki/<id> — plik zlecenia tego stanowiska; cudze albo zakończone id = 404. */
export async function obsluzPlik(ctx: KontekstStanowiska, id: string, now = new Date()): Promise<Response> {
  if (!WZOR_ID.test(id)) return blad(404, 'Nie znaleziono')
  const p = await plikDlaAgenta(ctx.db, ctx.stanowisko.id, id, now)
  if (!p) return blad(404, 'Nie znaleziono')
  return new Response(new Uint8Array(p.data), {
    headers: { 'Content-Type': TYP_PLIKU[p.format], 'Content-Length': String(p.data.byteLength), ...BEZ_CACHE, 'X-Content-Type-Options': 'nosniff' },
  })
}

/** Walidacja RaportWyniku (README agenta, sekcja 4). Pole `rola` z raportu celowo pomijane. */
export function parsujRaportWyniku(v: unknown): { stanowisko: unknown; wynik: WynikAgenta } | { blad: string } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { blad: 'Raport wyniku musi być obiektem' }
  const o = v as Record<string, unknown>
  if (o.wynik !== 'OK' && o.wynik !== 'BLAD') return { blad: 'Pole wynik: OK albo BLAD' }
  if (o.rolaZapasowa !== undefined && !jestRola(o.rolaZapasowa)) return { blad: 'Pole rolaZapasowa: nieznana rola' }
  if (o.ponowienieRaportu !== undefined && typeof o.ponowienieRaportu !== 'boolean') return { blad: 'Pole ponowienieRaportu: true albo false' }
  const komunikat = tekst(o.komunikat, MAKS_KOMUNIKATU)
  const drukarka = tekst(o.drukarka, 200)
  return {
    stanowisko: o.stanowisko,
    wynik: {
      wynik: o.wynik,
      ...(komunikat ? { komunikat } : o.wynik === 'BLAD' ? { komunikat: 'Błąd druku (agent nie podał powodu)' } : {}),
      ...(drukarka ? { drukarka } : {}),
      ...(typeof o.rolaZapasowa === 'string' ? { rolaZapasowa: o.rolaZapasowa } : {}),
    },
  }
}

/** POST /api/druk/zlecenia/<id>/wynik — idempotentne: powtórzony raport = 200 bez zmian. */
export async function obsluzWynik(ctx: KontekstStanowiska, id: string, req: Request, now = new Date()): Promise<Response> {
  const tresc = await czytajJson(req)
  if (!tresc.ok) return tresc.odpowiedz
  const r = parsujRaportWyniku(tresc.json)
  if ('blad' in r) return blad(400, r.blad)
  const zle = sprawdzKodStanowiska(ctx, r.stanowisko)
  if (zle) return zle
  if (!WZOR_ID.test(id)) return blad(404, 'Nie znaleziono zlecenia')
  const z = await zapiszWynik(ctx.db, ctx.stanowisko.id, id, r.wynik, now)
  if (z.kind === 'nie-ma') return blad(404, 'Nie znaleziono zlecenia')
  if (z.kind === 'nie-wydane') return blad(409, 'Zlecenie nie było wydane agentowi')
  return json({ ok: true, zmiana: z.kind === 'zapisano' })
}

/** Walidacja RaportStanu: tylko poprawne wpisy drukarek, przycięte teksty. */
export function parsujRaportStanu(v: unknown): { stanowisko: unknown; wersjaAgenta: string; drukarki: Record<string, unknown>[] } | { blad: string } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { blad: 'Raport stanu musi być obiektem' }
  const o = v as Record<string, unknown>
  if (!Array.isArray(o.drukarki)) return { blad: 'Pole drukarki musi być listą' }
  if (o.drukarki.length > MAKS_DRUKAREK) return { blad: `Najwyżej ${MAKS_DRUKAREK} drukarek w raporcie` }
  const wersjaAgenta = tekst(o.wersjaAgenta, 40) ?? 'nieznana'
  const drukarki: Record<string, unknown>[] = []
  const role = new Set<string>()
  for (const d of o.drukarki) {
    if (typeof d !== 'object' || d === null) return { blad: 'Wpis drukarki musi być obiektem' }
    const x = d as Record<string, unknown>
    if (!jestRola(x.rola)) return { blad: `Nieznana rola drukarki ${JSON.stringify(x.rola)?.slice(0, 40)}` }
    if (role.has(x.rola)) return { blad: `Rola ${x.rola} dwa razy w raporcie` }
    role.add(x.rola)
    if (x.stan !== 'DOSTEPNA' && x.stan !== 'OFFLINE' && x.stan !== 'BLAD') return { blad: 'Pole stan: DOSTEPNA, OFFLINE albo BLAD' }
    const kolejka = x.zleceniaWKolejce
    if (kolejka !== null && (typeof kolejka !== 'number' || !Number.isInteger(kolejka) || kolejka < 0)) return { blad: 'Pole zleceniaWKolejce: liczba albo null' }
    const komunikat = tekst(x.komunikat, 300)
    drukarki.push({ rola: x.rola, nazwa: tekst(x.nazwa, 200) ?? x.rola, stan: x.stan, ...(komunikat ? { komunikat } : {}), zleceniaWKolejce: kolejka })
  }
  return { stanowisko: o.stanowisko, wersjaAgenta, drukarki }
}

/** POST /api/druk/stan — czas raportu bierzemy z serwera. */
export async function obsluzStan(ctx: KontekstStanowiska, req: Request, now = new Date()): Promise<Response> {
  const tresc = await czytajJson(req)
  if (!tresc.ok) return tresc.odpowiedz
  const r = parsujRaportStanu(tresc.json)
  if ('blad' in r) return blad(400, r.blad)
  const zle = sprawdzKodStanowiska(ctx, r.stanowisko)
  if (zle) return zle
  await zapiszStan(ctx.db, ctx.stanowisko.id, r, now)
  return json({ ok: true })
}
