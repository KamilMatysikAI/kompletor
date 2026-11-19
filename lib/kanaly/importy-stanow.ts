// Wynik importu stanów w kanale. Niektóre kanały (Empik/Mirakl STO01) przyjmują plik stanów od razu, a
// przetwarzają go później: odpowiedź „przyjęte” nie mówi, czy stany weszły. Host zapisu stanów (`zapis-host.ts`) po
// przyjętym pliku zapisuje tu wiersz z identyfikatorem importu, a zadanie workera co minutę czyta wynik tych, których
// termin minął (pierwszy odczyt po minucie, potem co 5 min: zalecenie Mirakla dla STO02, maks. co 15 s).
// Odrzucone wiersze albo cały import = alert z liczbą (bez treści wierszy); brak wyniku po dobie = alert „bez wyniku”.
// odmowa dostępu do wyniku (401/403/404) = „wynik niedostępny” (nie „odrzucone”), po 403/404
// odczyty konta wstrzymane na dobę; alerty tej samej przyczyny łączone: jeden na konto i dzień (odrzucenia: na zestaw ofert).
// Tylko odczyt kanału (GET). Każdy wiersz osobno: błąd jednego nie zatrzymuje reszty.
import { createHash } from 'node:crypto'
import type { Channel, ChannelStockImport, Prisma, PrismaClient, StockImportState } from '@prisma/client'
import { createAccountAdapter, loadChannelAccounts } from '../adaptery/konta'
import { AdapterError, type ChannelAdapter, hasStockImportStatus, type StockImportStatus, type StockImportStatusReader } from '../adaptery/kontrakt'
import { alert } from '../rdzen/stan'
import { uniewaznijReferencje } from './rejestr-synchronizacji'
import type { HostCtx } from './zapis-host'

/** Zadanie workera (harmonogram rdzenia). */
export const IMPORTY_STANOW_JOB = 'kanaly-importy-stanow'
export const ALERT_IMPORT_ODRZUCONE = 'KANAL_IMPORT_STANOW_ODRZUCONE'
export const ALERT_IMPORT_BEZ_WYNIKU = 'KANAL_IMPORT_STANOW_BEZ_WYNIKU'

/** Pierwszy odczyt wyniku po przyjęciu pliku. */
export const PIERWSZY_ODCZYT_MS = 60_000
/** Kolejne odczyty (Mirakl: zalecane co 5 min). */
export const KOLEJNY_ODCZYT_MS = 5 * 60_000
/** Po tylu godzinach bez wyniku: alert i koniec odczytów. */
export const LIMIT_CZEKANIA_MS = 24 * 3600_000
const PACZKA = 20
/** po odmowie dostępu (403/404) do wyniku importu konto nie jest pytane przez dobę. */
export const WSTRZYMANIE_MS = 24 * 3600_000
/** Zamknięte importy (wynik znany) starsze niż 30 dni znikają przy przebiegu: to ślad techniczny, nie dane firmy. */
export const RETENCJA_MS = 30 * 24 * 3600_000

const accLabel = (a: { channel: Channel; channelAccountId: string }) => `${a.channel}/${a.channelAccountId}`
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500)

/**
 * Zapis przyjętego importu (woła host stanów po `pushStock` z `externalRef`). Idempotentny po (konto, externalRef):
 * ponowiona paczka z tym samym identyfikatorem nie tworzy drugiego wiersza.
 */
export async function zapiszPrzyjetyImport(
  db: PrismaClient,
  acc: { channel: Channel; channelAccountId: string },
  imp: { externalRef: string; reference: string; wierszy: number },
  now: Date,
): Promise<void> {
  const externalRef = imp.externalRef.slice(0, 200)
  const exists = await db.channelStockImport.findFirst({ where: { channel: acc.channel, channelAccountId: acc.channelAccountId, externalRef }, select: { id: true } })
  if (exists) return
  // createdAt z zegara wywołującego (ctx.now), nie z now bazy: od niego liczą się limit doby bez wyniku
  // i retencja 30 dni w `przebiegImportowStanow`, które biorą czas z tego samego ctx.now
  await db.channelStockImport.create({
    data: { channel: acc.channel, channelAccountId: acc.channelAccountId, externalRef, reference: imp.reference.slice(0, 200), wierszy: imp.wierszy, nextCheckAt: new Date(now.getTime() + PIERWSZY_ODCZYT_MS), createdAt: now },
  })
}

export interface ImportyStats {
  sprawdzone: number
  gotowe: number
  odrzucone: number
  nieudane: number
  bezWyniku: number
  /** wynik niedostępny (401/403/404 albo odczyty konta wstrzymane) */
  nieodczytane: number
  wToku: number
  bledy: string[]
}

type Czytnik = (ChannelAdapter & StockImportStatusReader) | string

/** Dzień w Polsce (RRRR-MM-DD) do kluczy alertów: ta sama przyczyna = jeden alert dziennie. */
const DZIEN = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' })
export const dzienAlertu = (now: Date) => DZIEN.format(now)

/** Skrót zestawu odrzuconych ofert: kolejność bez znaczenia, nowy kod oferty = nowy skrót. */
export function skrotKodow(kody: readonly string[]): string {
  if (!kody.length) return 'bez-kodow'
  return createHash('sha256').update([...new Set(kody)].sort().join('\n')).digest('hex').slice(0, 16)
}

const GODZINA = new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
const godzina = (d: Date) => GODZINA.format(d)

const UWAGA_PONOWIENIE = 'Nie udało się odczytać wyniku ze sklepu, kolejna próba za 5 minut.'
const UWAGA_BEZ_WYNIKU = 'Sklep nie podał wyniku przez dobę. Nie wiadomo, czy stany weszły: sprawdź import w panelu sklepu.'
const UWAGA_NA_ODCZYT = 'Konto przełączone na wersję tylko do odczytu: wyniku tego importu Kompletor już nie sprawdzi.'

/** Jeden przebieg: wiersze z minionym terminem odczytu, każdy osobno. Zwraca statystykę; błędy kont w `bledy`. */
export async function przebiegImportowStanow(db: PrismaClient, ctx: HostCtx): Promise<ImportyStats> {
  const now = ctx.now ?? new Date()
  const s: ImportyStats = { sprawdzone: 0, gotowe: 0, odrzucone: 0, nieudane: 0, bezWyniku: 0, nieodczytane: 0, wToku: 0, bledy: [] }
  // retencja: indeks na createdAt (migracja 20261109112210); zadanie tylko dla firm z kontem Empik (`requires`)
  await db.channelStockImport.deleteMany({ where: { state: { not: 'W_TOKU' }, createdAt: { lt: new Date(now.getTime() - RETENCJA_MS) } } })
  const rows = await db.channelStockImport.findMany({ where: { state: 'W_TOKU', nextCheckAt: { lte: now } }, orderBy: { nextCheckAt: 'asc' }, take: PACZKA })
  if (!rows.length) return s
  const accounts = new Map((await loadChannelAccounts(db, { activeOnly: false })).map((a) => [accLabel(a), a]))
  const czytniki = new Map<string, Czytnik>()
  const pauzy = new Map<string, Date | null>()
  for (const row of rows) {
    s.sprawdzone++
    try {
      const label = accLabel(row)
      let c = czytniki.get(label)
      if (c === undefined) {
        const acc = accounts.get(label)
        if (!acc) c = 'brak konta'
        else {
          try {
            const a = await createAccountAdapter(db, ctx.registry, acc, ctx.secrets, { ...(ctx.fetch ? { fetch: ctx.fetch } : {}), ...(ctx.http ? { http: ctx.http } : {}), now: () => now })
            c = hasStockImportStatus(a) ? a : 'ten rodzaj konta nie podaje wyniku importu stanów'
          } catch (e) {
            c = `zła konfiguracja konta: ${msg(e)}`
          }
        }
        czytniki.set(label, c)
      }
      if (!pauzy.has(label)) {
        // wstrzymanie odczytów konta trzymane w bazie (przeżywa restart workera i działa przy dwóch workerach)
        const p = await db.channelStockImport.findFirst({
          where: { channel: row.channel, channelAccountId: row.channelAccountId, odczytWstrzymanyDo: { gt: now } },
          orderBy: { odczytWstrzymanyDo: 'desc' },
          select: { odczytWstrzymanyDo: true },
        })
        pauzy.set(label, p?.odczytWstrzymanyDo ?? null)
      }
      await sprawdzJeden(db, row, c, now, s, pauzy)
    } catch (e) {
      s.bledy.push(`${accLabel(row)} ${row.externalRef}: ${msg(e)}`)
    }
  }
  return s
}

async function sprawdzJeden(db: PrismaClient, row: ChannelStockImport, c: Czytnik, now: Date, s: ImportyStats, pauzy: Map<string, Date | null>): Promise<void> {
  const label = accLabel(row)
  const dzien = dzienAlertu(now)
  const zaDlugo = now.getTime() - row.createdAt.getTime() >= LIMIT_CZEKANIA_MS
  const finish = async (data: Prisma.ChannelStockImportUpdateInput) => {
    const r = await db.channelStockImport.update({ where: { id: row.id }, data: { checkedAt: now, proby: { increment: 1 }, ...data } })
    // plik nie przyjęty w całości albo wynik nieznany = stany z tego pliku idą jeszcze raz (rejestr synchronizacji
    // zapamiętał je przy wysłaniu jako „sklep ma”); błąd kasowania nie zmienia wyniku importu, trafia do logu workera
    if (data.state && data.state !== 'GOTOWE' && data.state !== 'W_TOKU')
      await uniewaznijReferencje(db, row, row.reference).catch((e) => console.error(`[importy-stanow] ${label}: nie skasowano skrótów rejestru: ${msg(e)}`))
    return r
  }
  const czekaj = async (lastError: string | null, uwaga: string | null) => {
    if (zaDlugo) {
      await finish({ state: 'BEZ_WYNIKU', doneAt: now, lastError, uwaga: UWAGA_BEZ_WYNIKU })
      s.bezWyniku++
      // jeden alert na konto i dzień (zawieszone przetwarzanie u sklepu dotyczy wszystkich importów naraz)
      await alert(
        db,
        ALERT_IMPORT_BEZ_WYNIKU,
        label,
        `Sklep ${label}: brak wyniku importu stanów po dobie (np. ${row.externalRef}, ${row.wierszy} ofert). Nie wiadomo, czy stany weszły; sprawdź import w panelu sklepu albo kliknij „Wypchnij teraz” na ekranie konta. Kolejne takie importy tego konta dziś nie dają już alertu.`,
        `import-stanow:${label}:bez-wyniku:${dzien}`,
      )
      return
    }
    await finish({ nextCheckAt: new Date(now.getTime() + KOLEJNY_ODCZYT_MS), lastError, uwaga })
    s.wToku++
  }
  /** wynik niedostępny = „nie wiemy”, nie „odrzucone”. Alert (gdy jest treść) raz dziennie na konto. */
  const nieodczytany = async (lastError: string, uwaga: string, tresc: string | null, wstrzymajDo: Date | null) => {
    await finish({ state: 'NIEODCZYTANY', doneAt: now, lastError: lastError.slice(0, 500), uwaga, ...(wstrzymajDo ? { odczytWstrzymanyDo: wstrzymajDo } : {}) })
    s.nieodczytane++
    if (wstrzymajDo) pauzy.set(label, wstrzymajDo)
    if (tresc) await alert(db, ALERT_IMPORT_BEZ_WYNIKU, label, tresc, `import-stanow:${label}:odczyt-niedostepny:${dzien}`)
  }
  if (typeof c === 'string') return czekaj(c, UWAGA_PONOWIENIE)
  const pauza = pauzy.get(label)
  if (pauza && pauza > now) {
    // konto bez dostępu do wyniku importu: bez żądania do sklepu i bez kolejnego alertu
    return nieodczytany(
      `odczyt wyniku wstrzymany do ${pauza.toISOString()} po odmowie dostępu`,
      `Sklep nie udostępnia wyniku importu temu kontu; odczyty wstrzymane do ${godzina(pauza)}. Nie wiadomo, czy stany weszły.`,
      null,
      null,
    )
  }
  let st: StockImportStatus
  try {
    st = await c.getStockImportStatus(row.externalRef)
  } catch (e) {
    if (e instanceof AdapterError && e.kind === 'TRWALY') {
      return nieodczytany(
        msg(e),
        'Nie udało się odczytać wyniku ze sklepu. Nie wiadomo, czy stany weszły: sprawdź import w panelu sklepu.',
        `Sklep ${label}: nie udało się odczytać wyniku importu stanów (np. ${row.externalRef}). Nie wiadomo, czy stany weszły; sprawdź importy w panelu sklepu. Kolejne takie importy tego konta dziś nie dają już alertu.`,
        null,
      )
    }
    return czekaj(`odczyt wyniku nieudany: ${msg(e)}`, UWAGA_PONOWIENIE)
  }
  if (st.state === 'W_TOKU') return czekaj(null, null)
  if (st.state === 'NIEDOSTEPNY') {
    if (st.powod === 'KLUCZ') {
      return nieodczytany(
        st.message,
        'Sklep nie przyjął klucza API konta, więc wyniku nie da się odczytać. Nie wiadomo, czy stany weszły.',
        `Sklep ${label}: klucz API konta nie działa przy odczycie wyniku importu stanów (${st.message}). Nie wiadomo, czy stany weszły; sprawdź klucz na ekranie konta. Kolejne takie importy tego konta dziś nie dają już alertu.`,
        null,
      )
    }
    const doKiedy = new Date(now.getTime() + WSTRZYMANIE_MS)
    return nieodczytany(
      st.message,
      'Sklep nie udostępnia wyniku importu temu kontu. Nie wiadomo, czy stany weszły: sprawdź import w panelu sklepu.',
      `Sklep ${label}: konto nie ma dostępu do wyniku importu stanów (${st.message}). Stany mogły wejść, ale Kompletor tego nie sprawdzi; odczyty wyniku tego konta wstrzymane do ${godzina(doKiedy)}. Sprawdź importy w panelu sklepu albo poproś sklep o dostęp do wyniku importu (Empik: STO02).`,
      doKiedy,
    )
  }
  if (st.state === 'NIEUDANE') {
    await finish({ state: 'NIEUDANE', doneAt: now, lastError: st.message.slice(0, 500), uwaga: 'Sklep nie przetworzył pliku stanów: stany tych ofert się nie zmieniły.' })
    s.nieudane++
    // cały plik odrzucony = jeden alert na konto i dzień
    await alert(
      db,
      ALERT_IMPORT_ODRZUCONE,
      label,
      `Sklep ${label}: ${st.message.slice(0, 300)} (${row.externalRef}, ${row.wierszy} ofert). Stany tych ofert w sklepie się nie zmieniły. Kolejne odrzucone pliki tego konta dziś nie dają już alertu (lista na ekranie konta).`,
      `import-stanow:${label}:nieudany:${dzien}`,
    )
    return
  }
  const state: StockImportState = st.odrzucone > 0 ? 'ODRZUCONE' : 'GOTOWE'
  await finish({ state, doneAt: now, lastError: null, uwaga: null, przyjete: st.przyjete, odrzucone: st.odrzucone, kodyOdrzuconych: st.kodyOdrzuconych.slice(0, 20) })
  if (state === 'GOTOWE') {
    s.gotowe++
    return
  }
  s.odrzucone++
  const kody = st.kodyOdrzuconych.length ? ` Oferty: ${st.kodyOdrzuconych.slice(0, 10).join(', ')}${st.kodyOdrzuconych.length > 10 ? ', …' : ''}.` : ''
  // ten sam zestaw odrzuconych ofert = jeden alert dziennie; nowy kod oferty = nowy alert
  await alert(
    db,
    ALERT_IMPORT_ODRZUCONE,
    label,
    `Sklep ${label}: sklep odrzucił ${st.odrzucone} z ${st.przyjete !== null ? st.przyjete + st.odrzucone : row.wierszy} wierszy importu stanów (${row.externalRef}). Stany tych ofert w sklepie się nie zmieniły.${kody} Szczegóły: raport błędów importu w panelu sklepu. Kolejne importy odrzucone z tymi samymi ofertami dziś nie dają już alertu.`,
    `import-stanow:${label}:odrzucone:${skrotKodow(st.kodyOdrzuconych)}:${dzien}`,
  )
}

/**
 * po przełączeniu konta na wersję tylko do odczytu nikt nie odczyta otwartych importów (ta wersja
 * nie podaje wyniku importu), więc zamykamy je od razu, bez alertu. Zwraca liczbę zamkniętych.
 */
export async function zamknijOtwarteImporty(db: PrismaClient, acc: { channel: Channel; channelAccountId: string }, now: Date): Promise<number> {
  const r = await db.channelStockImport.updateMany({
    where: { channel: acc.channel, channelAccountId: acc.channelAccountId, state: 'W_TOKU' },
    data: { state: 'NIEODCZYTANY', doneAt: now, checkedAt: now, lastError: 'konto przełączone na wersję tylko do odczytu', uwaga: UWAGA_NA_ODCZYT },
  })
  return r.count
}

export interface WierszImportu {
  kiedy: Date
  identyfikator: string
  wierszy: number
  /** kod stanu (kolor chipa na ekranie liczy się z kodu, nie z tekstu) */
  state: StockImportState
  stan: string
  przyjete: number | null
  odrzucone: number | null
  kody: string[]
  /** zdanie dla człowieka; technika zostaje w `lastError`, bez pokazywania */
  uwaga: string | null
}

const STAN: Record<StockImportState, string> = { W_TOKU: 'sklep jeszcze przetwarza', GOTOWE: 'przyjęte', ODRZUCONE: 'część odrzucona', NIEUDANE: 'odrzucone w całości', BEZ_WYNIKU: 'brak wyniku', NIEODCZYTANY: 'wynik niedostępny' }

/** Ostatnie importy konta na ekran „Zapis do sklepu”. */
export async function ostatnieImporty(db: PrismaClient, acc: { channel: Channel; channelAccountId: string }, take = 10): Promise<WierszImportu[]> {
  const rows = await db.channelStockImport.findMany({ where: { channel: acc.channel, channelAccountId: acc.channelAccountId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take })
  return rows.map((r) => ({
    kiedy: r.createdAt,
    identyfikator: r.externalRef,
    wierszy: r.wierszy,
    state: r.state,
    stan: STAN[r.state],
    przyjete: r.przyjete,
    odrzucone: r.odrzucone,
    kody: Array.isArray(r.kodyOdrzuconych) ? (r.kodyOdrzuconych as unknown[]).filter((k): k is string => typeof k === 'string') : [],
    uwaga: r.uwaga,
  }))
}
