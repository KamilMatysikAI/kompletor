// Kolejka zleceń druku. Wszystkie funkcje biorą klienta firmy (RLS) — z sesji panelu albo z tokenu
// stanowiska (lib/druk/tokeny.ts). Kontrakt z agentem: agent-druku/src/kontrakt.ts i agent-druku/README.md, sekcja 4.
//
// Cykl zlecenia: PRZYGOTOWANIE (rezerwacja z kluczem idempotencji) → rysowanie pliku → zapis bajtów i OCZEKUJE w jednej
// transakcji → agent pobiera i drukuje → OK / BLAD. Nikt nie wydrukował w 8 godzin → WYGASLO (zlecenie z rana nie może
// wyjść następnego dnia po włączeniu komputera). Pierwszy wynik wygrywa; wygasłe też przyjmuje wynik, bo stan fizyczny
// ma pierwszeństwo.
//
// Zapas: tylko BLAD z `rolaZapasowa` (pewna awaria termicznej — nic nie wyszło) i tylko na rolę z ostatniego raportu
// stanowiska: nowe zlecenie ZAPAS (nowe id, fallbackOfId = oryginał, te same bajty; na rolę nietermiczną PDF, bo ZPL
// na A4 wyjdzie jako tekst poleceń). Bez `rolaZapasowa` (przekroczony czas, „Druk przerwany…”) zapas nie powstaje, bo
// mogłyby wyjść dwie etykiety kurierskie — komunikat idzie do panelu, a ponowny druk to świadomy klik człowieka.
//
// przypisanie w `routing` stanowiska może wskazać drukarkę innego stanowiska tej samej firmy. Zlecenie
// powstaje wtedy od razu w kolejce tamtego komputera (stationId = komputer z drukarką), więc pobiera je, raportuje
// i dostaje zapas wyłącznie jego program druku, według zasad wyżej. Program druku się nie zmienia.
import type { PrintFileFormat, PrintJob, PrintJobSource, PrismaClient } from '@prisma/client'
import { organizationIdOf } from '@/lib/db'
import { bladCelu, jestRola, jestTermiczna, przypisaniaStanowiska, roleZRaportu, rolaDlaTypu, type TypZlecenia } from './role'

type Db = PrismaClient

export const WAZNOSC_MS = 8 * 3600_000
export const PLIKI_PO_ZAKONCZENIU_MS = 7 * 24 * 3600_000
export const MAKS_ZLECEN_DLA_AGENTA = 50
export const MAKS_KOMUNIKATU = 500

export const KOMUNIKAT_WYGASLO = 'Nie wydrukowano w ciągu 8 godzin (agent nie działał albo komputer był wyłączony). Zleć wydruk ponownie.'

/** Błąd zlecenia z komunikatem dla człowieka i kodem HTTP. */
export class BladDruku extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 422 = 422,
  ) {
    super(message)
    this.name = 'BladDruku'
  }
}

export interface PlikiZlecenia {
  pdf?: Buffer
  zpl?: Buffer
}

export interface Narysowane<T> {
  pliki: PlikiZlecenia
  /** Krótki opis dla panelu, bez danych klientów (np. kody kart). */
  opis?: string
  dodatkowe?: T
}

export interface NoweZlecenie<T> {
  stationId: string
  typ: TypZlecenia
  zrodlo: Exclude<PrintJobSource, 'ZAPAS'>
  /** Rola wybrana jawnie (wydruk testowy na konkretnej drukarce); brak = z routingu stanowiska. */
  rola?: string
  kopie?: number
  /** Klucz idempotencji z przeglądarki (jeden na kliknięcie). */
  klucz?: string | null
  kto?: string | null
  orderIds?: string[]
  /** Rysuje plik. Wołane najwyżej raz na klucz: podwójny klik zwraca istniejące zlecenie bez drugiego rysowania. */
  rysuj: (cel: { rola: string; format: PrintFileFormat }) => Promise<Narysowane<T>>
  now?: Date
}

export interface WynikZlecenia<T> {
  zlecenie: PrintJob
  /** true = zlecenie z tym kluczem już było (podwójny klik) — nic nie narysowano drugi raz. */
  istnialo: boolean
  dodatkowe?: T
}

export const KOMUNIKAT_BLEDU_PLIKU = 'Nie udało się przygotować pliku do druku. Spróbuj ponownie; jeśli błąd wraca, zgłoś go obsłudze.'
export const komunikatBleduZapisu = (typ: TypZlecenia): string =>
  typ === 'karta'
    ? 'Karty dostały numer, ale pliku nie udało się zapisać. Zleć wydruk ponownie.'
    : 'Plik do druku był gotowy, ale nie udało się go zapisać. Zleć wydruk ponownie.'

/** Do logu serwera: klasa, kod (Prisma) i początek komunikatu; nigdy do panelu. */
const opisBledu = (e: unknown): string => {
  if (!(e instanceof Error)) return String(e).slice(0, 300)
  const code: unknown = (e as Error & { code?: unknown }).code
  const kod = typeof code === 'string' ? ` ${code}` : ''
  return `${e.name}${kod}: ${e.message.slice(0, 300)}`
}

/** BLAD z komunikatem; sam zapis błędu nie może przykryć pierwotnego wyjątku (baza leży = zostaje PRZYGOTOWANIE → WYGASLO). */
async function oznaczBlad(db: Db, id: string, komunikat: string, now: Date): Promise<void> {
  try {
    await db.printJob.update({ where: { id }, data: { status: 'BLAD', resultMessage: komunikat.slice(0, MAKS_KOMUNIKATU), reportedAt: now } })
  } catch (e) {
    console.error(`[druk] zlecenie ${id}: nie udało się zapisać stanu BLAD: ${opisBledu(e)}`)
  }
}

/**
 * Zlecenie spod tego samego klucza idempotencji musi dotyczyć tego samego (typ, stanowisko, zamówienia, rola jawna);
 * inaczej 409 zamiast cichego „już było”.
 */
async function zgodneZKluczem<T>(db: Db, byl: PrintJob, z: NoweZlecenie<T>): Promise<PrintJob> {
  const zamowienia = z.orderIds ?? []
  // zlecenie z przypisaniem do innego komputera leży w jego kolejce, więc „to samo stanowisko” = wybrane
  // albo to, na które wskazuje przypisanie wybranego
  const zgodne =
    byl.type === z.typ &&
    (byl.stationId === z.stationId || (!z.rola && (await stanowiskoZPrzypisania(db, z.stationId, z.typ)) === byl.stationId)) &&
    byl.orderIds.length === zamowienia.length &&
    byl.orderIds.every((id, i) => id === zamowienia[i]) &&
    (!z.rola || byl.role === z.rola)
  if (!zgodne) throw new BladDruku('Ten klucz zlecenia był już użyty dla innego wydruku. Odśwież stronę i zleć wydruk ponownie.', 409)
  return byl
}

/** id stanowiska, do którego kolejki idzie dany rodzaj wydruku ze stanowiska `stationId` (null = brak stanowiska). */
async function stanowiskoZPrzypisania(db: Db, stationId: string, typ: TypZlecenia): Promise<string | null> {
  const st = await db.printStation.findUnique({ where: { id: stationId }, select: { id: true, routing: true } })
  return st ? (przypisaniaStanowiska(st.routing, st.id)[typ].stanowisko ?? st.id) : null
}

const czyKonfliktUnikalnosci = (e: unknown) => typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002'

/** Format pliku dla agenta: ZPL tylko etykieta na termicznej, wszystko inne PDF. */
export function formatDla(typ: TypZlecenia, rola: string): PrintFileFormat {
  return typ === 'etykieta' && jestTermiczna(rola) ? 'zpl' : 'pdf'
}

/**
 * Nowe zlecenie: rezerwacja (PRZYGOTOWANIE + klucz), rysowanie, zapis pliku i OCZEKUJE. Kolejność jest ważna, bo
 * wydruk karty ma efekt uboczny (nowy numer w OrderCardPrint unieważnia kartę w koszyku): rezerwacja z kluczem PRZED
 * rysowaniem sprawia, że podwójny klik nie woła `drukujKarty` drugi raz. Błąd rysowania = BLAD z komunikatem (agent
 * niczego nie dostaje) i BladDruku dla wywołującego.
 */
export async function utworzZlecenie<T>(db: Db, z: NoweZlecenie<T>): Promise<WynikZlecenia<T>> {
  organizationIdOf(db)
  const now = z.now ?? new Date()
  if (z.klucz) {
    const byl = await db.printJob.findUnique({ where: { organizationId_idempotencyKey: { organizationId: organizationIdOf(db), idempotencyKey: z.klucz } } })
    if (byl) return { zlecenie: await zgodneZKluczem(db, byl, z), istnialo: true }
  }
  const st = await db.printStation.findUnique({ where: { id: z.stationId } })
  if (!st) throw new BladDruku('Nie ma takiego stanowiska druku — odśwież stronę', 404)
  if (st.disabledAt) throw new BladDruku(`Stanowisko „${st.name}” jest wyłączone`, 409)
  let rola: string
  // stanowisko, do którego kolejki trafia zlecenie (własne albo komputer z przypisaną drukarką)
  let celId = st.id
  if (z.rola) {
    if (!jestRola(z.rola) || !roleZRaportu(st.printers).includes(z.rola))
      throw new BladDruku(`Stanowisko „${st.name}” nie zgłasza drukarki ${z.rola} — wydruk możliwy tylko na drukarkę z ostatniego raportu agenta`, 409)
    rola = z.rola
  } else {
    const p = przypisaniaStanowiska(st.routing, st.id)[z.typ]
    if (p.stanowisko) {
      // Granica firm: klient z RLS nie widzi cudzego stanowiska, a organizationId sprawdzamy jeszcze raz jawnie, bo
      // `routing` to zwykły JSON (zapis z pominięciem ustawRouting nie może wysłać zlecenia do innej firmy).
      const c = await db.printStation.findUnique({ where: { id: p.stanowisko } })
      const cel = c && c.organizationId === organizationIdOf(db) ? c : null
      const blad = bladCelu(st.name, z.typ, cel && { ...cel, maToken: !!cel.tokenHash }, p.rola, now)
      if (blad || !cel) throw new BladDruku(blad ?? 'Nie ma takiego stanowiska druku — odśwież stronę', 409)
      celId = cel.id
      rola = p.rola
    } else {
      const r = rolaDlaTypu(st, z.typ)
      if ('blad' in r) throw new BladDruku(r.blad, 409)
      rola = r.rola
    }
  }
  let format = formatDla(z.typ, rola)

  let zlecenie: PrintJob
  try {
    zlecenie = await db.printJob.create({
      data: {
        stationId: celId,
        type: z.typ,
        source: z.zrodlo,
        role: rola,
        format,
        copies: z.kopie ?? 1,
        status: 'PRZYGOTOWANIE',
        idempotencyKey: z.klucz ?? null,
        requestedBy: z.kto ?? null,
        orderIds: z.orderIds ?? [],
        expiresAt: new Date(now.getTime() + WAZNOSC_MS),
        createdAt: now,
      },
    })
  } catch (e) {
    // równoległy drugi klik z tym samym kluczem wygrał wyścig o rezerwację
    if (z.klucz && czyKonfliktUnikalnosci(e)) {
      const byl = await db.printJob.findUnique({ where: { organizationId_idempotencyKey: { organizationId: organizationIdOf(db), idempotencyKey: z.klucz } } })
      if (byl) return { zlecenie: await zgodneZKluczem(db, byl, z), istnialo: true }
    }
    throw e
  }

  let narysowane: Narysowane<T>
  try {
    narysowane = await z.rysuj({ rola, format })
    // źródło bez ZPL (np. etykieta przewoźnika tylko w PDF): termiczna dostaje PDF 1:1 (agent drukuje go bez skalowania)
    if (format === 'zpl' && !narysowane.pliki.zpl && narysowane.pliki.pdf) format = 'pdf'
    if (!narysowane.pliki[format]) throw new Error(`brak pliku ${format.toUpperCase()}`)
  } catch (e) {
    // do panelu, odpowiedzi HTTP i `resultMessage` trafia pełny komunikat tylko z BladDruku (pisany
    // dla człowieka). Reszta (Prisma z fragmentami zapytań, pdfkit) = ogólny tekst, szczegół tylko w logu serwera.
    const komunikat = e instanceof BladDruku ? e.message : KOMUNIKAT_BLEDU_PLIKU
    if (!(e instanceof BladDruku)) console.error(`[druk] zlecenie ${zlecenie.id}: rysowanie pliku: ${opisBledu(e)}`)
    await oznaczBlad(db, zlecenie.id, komunikat, now)
    throw new BladDruku(komunikat, e instanceof BladDruku ? e.status : 422)
  }

  const pliki = (Object.entries(narysowane.pliki) as [PrintFileFormat, Buffer | undefined][]).filter((p): p is [PrintFileFormat, Buffer] => !!p[1])
  const przygotowane = zlecenie
  try {
    zlecenie = await db.$transaction(async (tx) => {
      for (const [f, data] of pliki) await tx.printJobFile.create({ data: { jobId: przygotowane.id, format: f, data: new Uint8Array(data) } })
      return tx.printJob.update({
        where: { id: przygotowane.id },
        data: { status: 'OCZEKUJE', format, summary: narysowane.opis?.slice(0, 300) ?? null },
      })
    })
  } catch (e) {
    // rysowanie mogło mieć skutek uboczny (karty dostały nowe numery w OrderCardPrint), więc
    // zlecenie nie może zostać w PRZYGOTOWANIE aż do wygaśnięcia, a wywołujący dostaje komunikat zamiast 500.
    console.error(`[druk] zlecenie ${przygotowane.id}: zapis pliku: ${opisBledu(e)}`)
    await oznaczBlad(db, przygotowane.id, komunikatBleduZapisu(z.typ), now)
    throw new BladDruku(komunikatBleduZapisu(z.typ), 422)
  }
  return { zlecenie, istnialo: false, ...(narysowane.dodatkowe !== undefined ? { dodatkowe: narysowane.dodatkowe } : {}) }
}

/** Przeterminowane (OCZEKUJE i PRZYGOTOWANIE po 8 h) → WYGASLO. Ogranicza do stanowiska, gdy podano. */
export async function oznaczWygasle(db: Db, now: Date, stationId?: string): Promise<number> {
  const r = await db.printJob.updateMany({
    where: { ...(stationId ? { stationId } : {}), status: { in: ['OCZEKUJE', 'PRZYGOTOWANIE'] }, expiresAt: { lte: now } },
    data: { status: 'WYGASLO', resultMessage: KOMUNIKAT_WYGASLO },
  })
  return r.count
}

/** Zlecenie w kształcie kontraktu (ZlecenieDruku u agenta) — wyłącznie pola kontraktu. */
export interface ZlecenieDlaAgenta {
  id: string
  typ: TypZlecenia
  format: PrintFileFormat
  rola: string
  plikUrl: string
  kopie: number
  utworzono: string
}

/** GET /api/druk/zlecenia: oczekujące i niewygasłe, w kolejności tworzenia, najwyżej 50. */
export async function zleceniaDlaAgenta(db: Db, stationId: string, now: Date): Promise<ZlecenieDlaAgenta[]> {
  await oznaczWygasle(db, now, stationId)
  const rows = await db.printJob.findMany({
    where: { stationId, status: 'OCZEKUJE', expiresAt: { gt: now } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: MAKS_ZLECEN_DLA_AGENTA,
    select: { id: true, type: true, format: true, role: true, copies: true, createdAt: true },
  })
  return rows.map((r) => ({
    id: r.id,
    typ: r.type,
    format: r.format,
    rola: r.role,
    plikUrl: `/api/druk/pliki/${r.id}`,
    kopie: r.copies,
    utworzono: r.createdAt.toISOString(),
  }))
}

/** Plik zlecenia tego stanowiska w formacie zlecenia; tylko póki zlecenie czeka na druk. Inne = null (404). */
export async function plikDlaAgenta(db: Db, stationId: string, jobId: string, now: Date): Promise<{ format: PrintFileFormat; data: Uint8Array } | null> {
  const job = await db.printJob.findFirst({ where: { id: jobId, stationId, status: 'OCZEKUJE', expiresAt: { gt: now } }, select: { id: true, format: true } })
  if (!job) return null
  const f = await db.printJobFile.findUnique({ where: { jobId_format: { jobId: job.id, format: job.format } }, select: { data: true } })
  return f ? { format: job.format, data: f.data } : null
}

/** RaportWyniku agenta po walidacji (lib/druk/agent-api.ts). Rola z raportu nie jest źródłem prawdy — jej tu nie ma. */
export interface WynikAgenta {
  wynik: 'OK' | 'BLAD'
  komunikat?: string
  drukarka?: string
  rolaZapasowa?: string
}

export type ZapisWyniku =
  | { kind: 'nie-ma' }
  | { kind: 'nie-wydane' }
  | { kind: 'bez-zmian' }
  | { kind: 'zapisano'; zapasId?: string; bezZapasu?: string }

/**
 * Wynik zlecenia od agenta. Pierwszy wynik wygrywa (warunkowa zmiana statusu w transakcji), powtórzenie = bez zmian.
 * Przy BLAD z `rolaZapasowa` tworzy zlecenie zapasowe w tej samej transakcji; unikalny `fallbackOfId` chroni przed
 * drugim zapasem nawet przy dwóch raportach naraz.
 */
export async function zapiszWynik(db: Db, stationId: string, jobId: string, w: WynikAgenta, now: Date): Promise<ZapisWyniku> {
  const wynik = await zapiszWynikZlecenia(db, stationId, jobId, w, now)
  // karta może mieć pełny adres klienta (uprawnienie osoby drukującej) — bajty usuwamy zaraz po wyniku,
  // po skopiowaniu do zlecenia zapasowego (zapas ma własną kopię i własny wynik)
  // etykieta przewoźnika ma adres i telefon odbiorcy — tak samo (atrapa nie ma, ale jej bajty też niepotrzebne)
  if (wynik.kind === 'zapisano') await db.printJobFile.deleteMany({ where: { jobId, job: { type: { in: ['karta', 'etykieta'] } } } })
  return wynik
}

async function zapiszWynikZlecenia(db: Db, stationId: string, jobId: string, w: WynikAgenta, now: Date): Promise<ZapisWyniku> {
  const job = await db.printJob.findFirst({
    where: { id: jobId, stationId },
    select: { id: true, status: true, role: true, type: true, format: true, copies: true, source: true, fallbackOfId: true, expiresAt: true, orderIds: true, requestedBy: true, summary: true },
  })
  if (!job) return { kind: 'nie-ma' }
  if (job.status === 'PRZYGOTOWANIE') return { kind: 'nie-wydane' }
  if (job.status === 'OK' || job.status === 'BLAD') return { kind: 'bez-zmian' }
  const bylWygasly = job.status === 'WYGASLO' || job.expiresAt <= now

  return db.$transaction(async (tx) => {
    const komunikat = w.komunikat?.slice(0, MAKS_KOMUNIKATU) ?? null
    const u = await tx.printJob.updateMany({
      where: { id: job.id, status: { in: ['OCZEKUJE', 'WYGASLO'] } },
      data: { status: w.wynik, resultMessage: komunikat, resultPrinter: w.drukarka?.slice(0, 200) ?? null, reportedAt: now },
    })
    if (u.count === 0) return { kind: 'bez-zmian' } as const
    if (w.wynik !== 'BLAD' || !w.rolaZapasowa) return { kind: 'zapisano' } as const

    // Czy wolno utworzyć zapas — każdy powód odmowy trafia do komunikatu dla panelu.
    const zapas = w.rolaZapasowa
    const st = await tx.printStation.findUniqueOrThrow({ where: { id: stationId }, select: { printers: true } })
    let powod: string | null = null
    if (bylWygasly) powod = 'zlecenie wygasło'
    else if (!jestRola(zapas) || zapas === job.role) powod = `nieprawidłowa rola zapasowa ${zapas}`
    else if (!roleZRaportu(st.printers).includes(zapas)) powod = `drukarki ${zapas} nie ma w ostatnim raporcie stanowiska`
    // zapas z zapasu tylko na drukarkę nietermiczną: koniec łańcucha (A4 nie ma zapasu), bez krążenia T1 ↔ T2
    else if (job.source === 'ZAPAS' && jestTermiczna(zapas)) powod = 'to już było zlecenie zapasowe'
    const format: PrintFileFormat = jestTermiczna(zapas) ? job.format : 'pdf'
    const pliki = powod ? [] : await tx.printJobFile.findMany({ where: { jobId: job.id }, select: { format: true, data: true } })
    if (!powod && !pliki.some((p) => p.format === format)) powod = `brak pliku ${format.toUpperCase()}`
    if (powod) {
      const tekst = `${komunikat ?? 'Błąd druku'} — bez zlecenia zapasowego (${powod}).`
      await tx.printJob.update({ where: { id: job.id }, data: { resultMessage: tekst.slice(0, MAKS_KOMUNIKATU) } })
      return { kind: 'zapisano', bezZapasu: powod } as const
    }
    const nowe = await tx.printJob.create({
      data: {
        stationId,
        type: job.type,
        source: 'ZAPAS',
        role: zapas,
        format,
        copies: job.copies,
        status: 'OCZEKUJE',
        fallbackOfId: job.id,
        summary: job.summary,
        requestedBy: job.requestedBy,
        orderIds: job.orderIds,
        expiresAt: job.expiresAt, // zapas nie przedłuża ważności oryginału
        createdAt: now,
      },
    })
    for (const p of pliki) await tx.printJobFile.create({ data: { jobId: nowe.id, format: p.format, data: p.data } })
    return { kind: 'zapisano', zapasId: nowe.id } as const
  })
}

/** POST /api/druk/stan: ostatni raport drukarek, wersja agenta, czas SERWERA (nie z raportu). */
export async function zapiszStan(db: Db, stationId: string, r: { drukarki: unknown[]; wersjaAgenta: string }, now: Date): Promise<void> {
  await db.printStation.update({
    where: { id: stationId },
    data: { printers: r.drukarki as object[], agentVersion: r.wersjaAgenta, lastReportAt: now },
  })
}

/**
 * Zadanie workera `druk-sprzatanie`: wygasza przeterminowane zlecenia i usuwa bajty plików zleceń zakończonych ponad
 * 7 dni temu (karty i listy zawierają dane zamówień). Wiersz zlecenia zostaje jako historia. Karty (mogą
 * mieć pełny adres klienta) bez czekania: każde zakończone zlecenie karty (OK, BLAD, WYGASLO) traci bajty od razu.
 */
export async function sprzatajDruk(db: Db, now = new Date()): Promise<{ wygasle: number; usunietePliki: number }> {
  const wygasle = await oznaczWygasle(db, now)
  const r = await db.printJobFile.deleteMany({
    where: {
      job: {
        status: { in: ['OK', 'BLAD', 'WYGASLO'] },
        OR: [{ createdAt: { lt: new Date(now.getTime() - PLIKI_PO_ZAKONCZENIU_MS) } }, { type: { in: ['karta', 'etykieta'] } }],
      },
    },
  })
  return { wygasle, usunietePliki: r.count }
}
