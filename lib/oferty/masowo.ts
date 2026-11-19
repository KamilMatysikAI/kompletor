// (3b-1, pkt 3): „Przygotuj oferty” dla zaznaczonych produktów — zadanie w tle (Job) liczy podglądy ofert na
// każdym koncie publikacji (BEZ wystawiania) i zostawia raport w ImportRun: ile gotowych, ile z problemami i jakimi, per
// kanał. Wzorzec raportu jak feed zdjęć (ImportRun z `stats`). Jeden zły produkt nie wywraca reszty
// (try/catch per produkt i konto, błąd w raporcie), a powtórka zadania po zakończonym przebiegu nic nie robi.
import type { Prisma, PrismaClient } from '@prisma/client'
import { enqueue } from '@/lib/worker/kolejka'
import { NAZWA_KANALU, type KafelPublikacji, type KanalOferty } from './publikacja'
import { POWOD_NIESPRAWDZONEJ_KATEGORII } from './allegro-podglad'

export const OFERTY_MASOWO_JOB = 'oferty-przygotuj-masowo'
export const OFERTY_RUN_KIND = 'oferty-przygotowanie'
/** Najwięcej produktów w jednym zleceniu (zaznaczenie z listy produktów). */
export const OFERTY_MASOWO_MAX = 500
/** Najwięcej pozycji „z problemami” zapisanych w raporcie (liczniki liczą wszystkie). */
export const OFERTY_MASOWO_MAX_LISTY = 1000
/** Ekran raportów przebiegów (Produkty → „Przygotowane oferty”); raport jednego przebiegu pod `/<id>`. */
export const OFERTY_RAPORTY = '/produkty/przygotowanie-ofert'

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export interface RaportKanalu {
  kanal: KanalOferty
  nazwa: string
  gotowe: number
  zProblemami: number
  bledy: number
  /** Problem (komunikat po ludzku) → ile produktów go ma; najczęstsze najpierw w panelu. */
  problemy: Record<string, number>
}

export interface PozycjaRaportu {
  productId: string
  klucz: string
  kanal: KanalOferty
  problemy: string[]
  blad?: string
}

export interface RaportPrzygotowania {
  produkty: number
  kanaly: RaportKanalu[]
  lista: PozycjaRaportu[]
  /** produkty ponad limit przebiegu, których nie policzono (brak = 0). */
  pominieto?: number
}

export class PrzygotowanieError extends Error {}

/** opis nadmiaru ponad limit przebiegu (lista z bazy dłuższa niż OFERTY_MASOWO_MAX). */
export const komunikatPominietych = (n: number) =>
  `Lista miała więcej niż ${OFERTY_MASOWO_MAX} produktów: policzono pierwszych ${OFERTY_MASOWO_MAX}, pominięto ${n}. Zaznacz pozostałe i zleć osobno.`

/** Lista zaznaczonych produktów: bez dubli, poprawne identyfikatory, 1..OFERTY_MASOWO_MAX. */
export function sprawdzZaznaczone(ids: readonly unknown[]): string[] {
  const out = [...new Set(ids.map((x) => String(x ?? '').trim()).filter(Boolean))]
  if (!out.length) throw new PrzygotowanieError('Zaznacz co najmniej jeden produkt.')
  if (out.length > OFERTY_MASOWO_MAX) throw new PrzygotowanieError(`Za dużo produktów naraz: najwyżej ${OFERTY_MASOWO_MAX}. Zawęź listę filtrem i zaznacz mniej.`)
  if (out.some((id) => !ID_RE.test(id))) throw new PrzygotowanieError('Zły identyfikator produktu na liście.')
  return out
}

/**
 * Zlecenie z panelu: przebieg w ImportRun (RUNNING, lista produktów w `stats`) i zadanie w tle wskazujące ten przebieg.
 * Klucz dedupe = id przebiegu, więc podwójne kliknięcie daje dwa osobne raporty, a nie jedno zadanie zgubione.
 */
export async function zlecPrzygotowanieOfert(db: PrismaClient, ids: readonly unknown[], actorId: string): Promise<string> {
  const produkty = sprawdzZaznaczone(ids)
  const run = await db.importRun.create({ data: { kind: OFERTY_RUN_KIND, stats: { produkty, zlecil: actorId } as Prisma.InputJsonValue } })
  await enqueue(db, OFERTY_MASOWO_JOB, { przebieg: run.id }, { dedupeKey: `${OFERTY_MASOWO_JOB}:${run.id}`, maxAttempts: 3 })
  return run.id
}

/** Bez treści wyjątku (mogłaby nieść fragment klucza albo odpowiedź kanału): tylko nazwa klasy błędu. */
const bladPoLudzku = (e: unknown) => `Nie udało się policzyć podglądu (${e instanceof Error ? e.name : 'błąd'}). Otwórz kartę produktu → Publikacja, żeby sprawdzić szczegóły.`

/**
 * Czysta pętla: każdy produkt na każdym koncie osobno. `podglad` = kafel ekranu Publikacja (null = produktu już nie ma,
 * liczy się jako błąd tej pozycji). Gotowa = bez problemów z wagą „blad” (wyłączone wystawianie konta nie jest problemem
 * produktu: to ustawienie konta).
 */
export async function policzRaport(
  produkty: readonly string[],
  konta: readonly { klucz: string; kanal: KanalOferty }[],
  podglad: (productId: string, klucz: string) => Promise<KafelPublikacji | null>,
): Promise<RaportPrzygotowania> {
  const kanaly = new Map<KanalOferty, RaportKanalu>()
  const r: RaportPrzygotowania = { produkty: produkty.length, kanaly: [], lista: [] }
  const dopisz = (p: PozycjaRaportu) => {
    if (r.lista.length < OFERTY_MASOWO_MAX_LISTY) r.lista.push(p)
  }
  for (const k of konta) if (!kanaly.has(k.kanal)) kanaly.set(k.kanal, { kanal: k.kanal, nazwa: NAZWA_KANALU[k.kanal], gotowe: 0, zProblemami: 0, bledy: 0, problemy: {} })
  for (const productId of produkty) {
    for (const k of konta) {
      const rk = kanaly.get(k.kanal)!
      try {
        const kafel = await podglad(productId, k.klucz)
        if (!kafel) {
          rk.bledy++
          dopisz({ productId, klucz: k.klucz, kanal: k.kanal, problemy: [], blad: 'Nie ma już takiego produktu albo konta.' })
          continue
        }
        const bledy = [...new Set(kafel.problemy.filter((p) => p.waga === 'blad').map((p) => p.komunikat))]
        // podgląd bez sprawdzonej kategorii albo parametrów w Allegro nie jest „gotowy”: liczymy go jako niesprawdzony
        if (!bledy.length && kafel.wystaw.powody.includes(POWOD_NIESPRAWDZONEJ_KATEGORII)) {
          rk.bledy++
          dopisz({ productId, klucz: k.klucz, kanal: k.kanal, problemy: [], blad: POWOD_NIESPRAWDZONEJ_KATEGORII })
          continue
        }
        if (!bledy.length) {
          rk.gotowe++
          continue
        }
        rk.zProblemami++
        for (const b of bledy) rk.problemy[b] = (rk.problemy[b] ?? 0) + 1
        dopisz({ productId, klucz: k.klucz, kanal: k.kanal, problemy: bledy })
      } catch (e) {
        rk.bledy++
        console.error(`[${OFERTY_MASOWO_JOB}] produkt ${productId}, konto ${k.klucz}: ${e instanceof Error ? e.name : 'błąd'}`)
        dopisz({ productId, klucz: k.klucz, kanal: k.kanal, problemy: [], blad: bladPoLudzku(e) })
      }
    }
  }
  r.kanaly = [...kanaly.values()]
  return r
}

const produktyZStats = (stats: Prisma.JsonValue | null): string[] => {
  const p = stats && typeof stats === 'object' && !Array.isArray(stats) ? (stats as Record<string, unknown>)['produkty'] : null
  return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string' && ID_RE.test(x)) : []
}

export interface ZaleznosciPrzebiegu {
  konta: () => Promise<{ klucz: string; kanal: KanalOferty }[]>
  podglad: (productId: string, klucz: string) => Promise<KafelPublikacji | null>
}

/**
 * Zadanie w tle. Idempotentne: przebieg już zakończony (OK, PARTIAL, FAILED) = nic do zrobienia; ponowienie po awarii
 * w połowie liczy wszystko od nowa (sam odczyt, nic nie wychodzi do kanału) i nadpisuje raport.
 */
export async function przebiegPrzygotowania(db: PrismaClient, payload: Prisma.JsonValue, deps: ZaleznosciPrzebiegu): Promise<RaportPrzygotowania | null> {
  const id = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>)['przebieg'] : undefined
  if (typeof id !== 'string' || !ID_RE.test(id)) return null
  const run = await db.importRun.findFirst({ where: { id, kind: OFERTY_RUN_KIND }, select: { id: true, status: true, stats: true } })
  if (!run || run.status !== 'RUNNING') return null
  // limit sprawdzamy jeszcze raz w przebiegu (lista w bazie mogła ominąć sprawdzenie przy zleceniu); nadmiar w raporcie
  const zListy = [...new Set(produktyZStats(run.stats))]
  const produkty = zListy.slice(0, OFERTY_MASOWO_MAX)
  const pominieto = zListy.length - produkty.length
  if (pominieto) console.warn(`[${OFERTY_MASOWO_JOB}] przebieg ${id}: lista ponad limit, pominięto ${pominieto}`)
  const zlecil = run.stats && typeof run.stats === 'object' && !Array.isArray(run.stats) ? (run.stats as Record<string, unknown>)['zlecil'] : undefined
  try {
    const konta = await deps.konta()
    const raport = await policzRaport(produkty, konta, deps.podglad)
    if (pominieto) raport.pominieto = pominieto
    const bledy = raport.kanaly.reduce((a, k) => a + k.bledy, 0)
    const wszystkie = produkty.length * konta.length
    await db.importRun.update({
      where: { id },
      data: {
        status: wszystkie > 0 && bledy === wszystkie ? 'FAILED' : bledy ? 'PARTIAL' : 'OK',
        finishedAt: new Date(),
        stats: { ...raport, produktyId: produkty, ...(typeof zlecil === 'string' ? { zlecil } : {}) } as unknown as Prisma.InputJsonValue,
        error: wszystkie > 0 && bledy === wszystkie ? 'Żadnego podglądu nie udało się policzyć.' : pominieto ? komunikatPominietych(pominieto) : null,
      },
    })
    return raport
  } catch (e) {
    // brak listy kont (baza): przebieg FAILED z komunikatem, bez wyjątku, żeby worker nie ponawiał w kółko
    await db.importRun.update({ where: { id }, data: { status: 'FAILED', finishedAt: new Date(), error: bladPoLudzku(e) } })
    return null
  }
}

// ─── Odczyt do ekranu raportu (Produkty → „Przygotowane oferty”) ─────────────

export type StatusPrzebiegu = 'RUNNING' | 'OK' | 'PARTIAL' | 'FAILED'

export interface PrzebiegOfert {
  id: string
  status: StatusPrzebiegu
  startedAt: Date
  finishedAt: Date | null
  error: string | null
  /** liczba zaznaczonych produktów (także w toku) */
  produkty: number
  /** null = przebieg w toku albo przerwany przed raportem */
  raport: RaportPrzygotowania | null
}

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const liczba = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0)
const KANALY: readonly KanalOferty[] = ['woo', 'allegro', 'empik']

/**
 * `stats` przebiegu → raport do ekranu. W toku `produkty` to lista identyfikatorów, po przebiegu liczba (lista w
 * `produktyId`). Pola spoza kształtu odrzucamy zamiast ufać bazie (stary albo uszkodzony wpis nie wywraca ekranu).
 */
export function przebiegZeStats(stats: Prisma.JsonValue | null): { produkty: number; raport: RaportPrzygotowania | null } {
  if (!obj(stats)) return { produkty: 0, raport: null }
  const produkty = Array.isArray(stats['produkty']) ? stats['produkty'].length : Array.isArray(stats['produktyId']) ? stats['produktyId'].length : liczba(stats['produkty'])
  if (!Array.isArray(stats['kanaly'])) return { produkty, raport: null }
  const kanaly: RaportKanalu[] = (stats['kanaly'] as unknown[]).filter(obj).flatMap((k) => {
    const kanal = k['kanal'] as KanalOferty
    if (!KANALY.includes(kanal)) return []
    const problemy: Record<string, number> = {}
    if (obj(k['problemy'])) for (const [t, n] of Object.entries(k['problemy'])) if (liczba(n)) problemy[t] = liczba(n)
    return [{ kanal, nazwa: NAZWA_KANALU[kanal], gotowe: liczba(k['gotowe']), zProblemami: liczba(k['zProblemami']), bledy: liczba(k['bledy']), problemy }]
  })
  const lista: PozycjaRaportu[] = ((Array.isArray(stats['lista']) ? stats['lista'] : []) as unknown[]).filter(obj).flatMap((p) => {
    const kanal = p['kanal'] as KanalOferty
    if (typeof p['productId'] !== 'string' || !ID_RE.test(p['productId']) || typeof p['klucz'] !== 'string' || !KANALY.includes(kanal)) return []
    const pr = Array.isArray(p['problemy']) ? p['problemy'].filter((x): x is string => typeof x === 'string') : []
    return [{ productId: p['productId'], klucz: p['klucz'], kanal, problemy: pr, ...(typeof p['blad'] === 'string' ? { blad: p['blad'] } : {}) }]
  })
  const pominieto = liczba(stats['pominieto'])
  return { produkty, raport: { produkty, kanaly, lista, ...(pominieto ? { pominieto } : {}) } }
}

const SELECT_PRZEBIEGU = { id: true, status: true, startedAt: true, finishedAt: true, error: true, stats: true } as const

function przebieg(r: { id: string; status: string; startedAt: Date; finishedAt: Date | null; error: string | null; stats: Prisma.JsonValue | null }): PrzebiegOfert {
  return { id: r.id, status: r.status as StatusPrzebiegu, startedAt: r.startedAt, finishedAt: r.finishedAt, error: r.error, ...przebiegZeStats(r.stats) }
}

/** Ostatnie przebiegi „Przygotuj oferty” firmy (najnowsze najpierw). */
export async function ostatniePrzebiegiOfert(db: PrismaClient, ile = 20): Promise<PrzebiegOfert[]> {
  const rows = await db.importRun.findMany({ where: { kind: OFERTY_RUN_KIND }, orderBy: { startedAt: 'desc' }, take: ile, select: SELECT_PRZEBIEGU })
  return rows.map(przebieg)
}

/** Jeden przebieg; null = nie ma (albo zły identyfikator, albo przebieg innego rodzaju). */
export async function przebiegOfert(db: PrismaClient, id: string): Promise<PrzebiegOfert | null> {
  if (!ID_RE.test(id)) return null
  const r = await db.importRun.findFirst({ where: { id, kind: OFERTY_RUN_KIND }, select: SELECT_PRZEBIEGU })
  return r ? przebieg(r) : null
}
