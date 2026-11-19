// „Przejście z BaseLinkera zakończone” (punkt 3): firma self-host po przeprowadzce oznacza na ekranie
// przeprowadzki, że odchodzi od BaseLinkera. Od tej chwili bramka trybu pracy (`blokadaInstancji` przez
// `firmaPrzechodziZBl`) traktuje ją jak firmę bez BL, więc konta sklepów przełączy z panelu bez `EKRANY_PRACA=1`.
// Sam znacznik niczego nie przełącza: tryb pracy włącza się dalej na ekranie konta albo „Włącz tryb pracy” na pulpicie.
// Firma z katalogiem BL z presetu (pierwsza firma) zostaje za wyłącznikiem instancji: znacznik wymaga zapisu przeprowadzki (katalog BL z presetu albo cień
// go nie dają), a klucz BL w konfiguracji serwera i import katalogu z BL co N godzin blokują go z powodem.
// katalog BL ustawiony przed pierwszym zapisem przeprowadzki (`katalogPrzedPrzeprowadzka`) też
// blokuje znacznik, także gdy firma przejdzie potem pełną przeprowadzkę z panelu.
import type { Prisma, PrismaClient } from '@prisma/client'
import { appModeOf, organizationIdOf } from '../db'
import { katalogPrzedPrzeprowadzka, ODMOWA_KATALOG_PRZED, przejscieZakonczone, sladPrzeprowadzki } from '../kanaly/firma'
import { kontaWPracy, PRZERWANY_MS, PrzeprowadzkaError, RODZAJ_PANELU } from './z-panelu'
import { PRZEPROWADZKA_ZAPISANA, RODZAJ_PRZEBIEGU } from './zapis'

type Env = Record<string, string | undefined>
type Json = Record<string, Prisma.JsonValue>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

export const ENCJA_ZAKONCZENIA = 'Organization.przejscieZBl'

export interface StanZakonczenia {
  /** Znacznik ustawiony: kiedy (ISO). */
  zakonczone: { at: string } | null
  /** Powody, dla których znacznika nie da się teraz ustawić (puste = można). */
  blokady: string[]
  /** Uwagi do okna potwierdzenia (nie blokują). */
  uwagi: string[]
}

/** Warunki ustawienia znacznika liczone z bazy i env (ta sama funkcja dla ekranu i akcji). */
/** Przebieg panelu w toku: starszy niż `PRZERWANY_MS` to martwy przebieg, nie blokuje znacznika. */
const wTokuGdzie = (now: Date) => ({ kind: RODZAJ_PANELU, status: 'RUNNING' as const, startedAt: { gt: new Date(now.getTime() - PRZERWANY_MS) } })

export async function stanZakonczenia(db: PrismaClient, env: Env, now: Date = new Date()): Promise<StanZakonczenia> {
  organizationIdOf(db)
  const [org, ostatniZapis, wToku] = await Promise.all([
    db.organization.findFirst({ select: { settings: true } }),
    db.importRun.findFirst({ where: { kind: RODZAJ_PRZEBIEGU }, orderBy: { startedAt: 'desc' }, select: { status: true } }),
    db.importRun.count({ where: wTokuGdzie(now) }),
  ])
  const z = przejscieZakonczone(org?.settings)
  const blokady: string[] = []
  const uwagi: string[] = []
  if (!ostatniZapis || !sladPrzeprowadzki(org?.settings)) blokady.push('Najpierw zaimportuj dane z BaseLinkera (krok 4).')
  else if (ostatniZapis.status !== 'OK' && ostatniZapis.status !== 'PARTIAL') blokady.push('Ostatni import nie przeszedł. Uruchom tryb próbny i import jeszcze raz.')
  else if (ostatniZapis.status === 'PARTIAL') uwagi.push('Ostatni import ma sprawy do decyzji (sekcja „Ostatni zapis”). Możesz je dokończyć w Kompletorze.')
  if (katalogPrzedPrzeprowadzka(org?.settings)) blokady.push(ODMOWA_KATALOG_PRZED)
  if (wToku > 0) blokady.push('Przeprowadzka trwa. Poczekaj na jej koniec.')
  if (appModeOf(env) === 'self-host' && (env['BASELINKER_TOKEN'] ?? '').trim())
    blokady.push('Klucz BaseLinkera jest wpisany w konfiguracji serwera. Odejście od BaseLinkera wymaga, żeby administrator serwera go usunął.')
  if ((env['KATALOG_IMPORT_CO_GODZIN'] ?? '').trim() && (env['KATALOG_IMPORT_CO_GODZIN'] ?? '').trim() !== '0')
    blokady.push('Serwer pobiera katalog z BaseLinkera co kilka godzin. Odejście od BaseLinkera wymaga, żeby administrator serwera wyłączył to pobieranie.')
  uwagi.push('Przed włączeniem trybu pracy wyłącz w BaseLinkerze zmiany stanów i statusów dla sklepów, które poprowadzi Kompletor, żeby oba systemy nie zapisywały tego samego.')
  return { zakonczone: z ? { at: z.at } : null, blokady, uwagi }
}

async function zablokujFirme(tx: Prisma.TransactionClient, organizationId: string): Promise<Json> {
  const rows = await tx.$queryRaw<{ settings: Prisma.JsonValue }[]>`SELECT settings FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`
  if (!rows[0]) throw new Error('Brak firmy klienta')
  return isObj(rows[0].settings) ? rows[0].settings : {}
}

/**
 * Ustawienie znacznika. Warunki od nowa (ekran mógł pokazać stan sprzed chwili); przebieg przeprowadzki zlecany
 * równolegle bierze tę samą blokadę wiersza firmy (`zlecPrzeprowadzke`). Idempotentne: ustawiony = bez zmian.
 */
export async function zakonczPrzejscie(db: PrismaClient, actorId: string, env: Env, now: Date = new Date()): Promise<'ZMIENIONO' | 'BEZ_ZMIAN'> {
  const organizationId = organizationIdOf(db)
  const stan = await stanZakonczenia(db, env, now)
  if (stan.zakonczone) return 'BEZ_ZMIAN'
  if (stan.blokady.length) throw new PrzeprowadzkaError(stan.blokady.join(' '))
  return db.$transaction(async (tx) => {
    const settings = await zablokujFirme(tx, organizationId)
    if (przejscieZakonczone(settings)) return 'BEZ_ZMIAN' as const
    if ((await tx.importRun.count({ where: wTokuGdzie(now) })) > 0) throw new PrzeprowadzkaError('Przeprowadzka trwa. Poczekaj na jej koniec.')
    if ((await tx.importRun.count({ where: PRZEPROWADZKA_ZAPISANA })) === 0 || !sladPrzeprowadzki(settings)) throw new PrzeprowadzkaError('Najpierw zaimportuj dane z BaseLinkera (krok 4).')
    if (katalogPrzedPrzeprowadzka(settings)) throw new PrzeprowadzkaError(ODMOWA_KATALOG_PRZED)
    const bl: Json = isObj(settings['baselinker']) ? settings['baselinker'] : {}
    const znacznik = { at: now.toISOString(), przez: actorId }
    await tx.organization.update({ where: { id: organizationId }, data: { settings: { ...settings, baselinker: { ...bl, przejscieZakonczone: znacznik } } as unknown as Prisma.InputJsonValue } })
    await tx.auditLog.create({ data: { entity: ENCJA_ZAKONCZENIA, entityId: organizationId, actorId, after: { zakonczone: true, zrodlo: 'panel' } } })
    return 'ZMIENIONO' as const
  })
}

/** Tekst odmowy cofnięcia przy kontach w trybie pracy (ekran pokazuje go też przed kliknięciem). */
export const odmowaCofnieciaWPracy = (konta: string[]) =>
  `Konta w trybie pracy: ${konta.join(', ')}. Cofnięcie przywróciłoby blokadę trybu pracy dla firmy przechodzącej z BaseLinkera, więc najpierw przełącz te konta na „Tylko podgląd” (Ustawienia → Sprzedaż i kanały → Kanały sprzedaży → konto → Stan konta).`

/** Cofnięcie znacznika (firma wraca do BaseLinkera albo chce importować jeszcze raz). Idempotentne. */
export async function cofnijZakonczenie(db: PrismaClient, actorId: string): Promise<'ZMIENIONO' | 'BEZ_ZMIAN'> {
  const organizationId = organizationIdOf(db)
  const praca = await kontaWPracy(db)
  if (praca.length) throw new PrzeprowadzkaError(odmowaCofnieciaWPracy(praca))
  return db.$transaction(async (tx) => {
    const settings = await zablokujFirme(tx, organizationId)
    if (!przejscieZakonczone(settings)) return 'BEZ_ZMIAN' as const
    const bl: Json = isObj(settings['baselinker']) ? settings['baselinker'] : {}
    const { przejscieZakonczone: _z, ...resztaBl } = bl
    await tx.organization.update({ where: { id: organizationId }, data: { settings: { ...settings, baselinker: resztaBl } as unknown as Prisma.InputJsonValue } })
    await tx.auditLog.create({ data: { entity: ENCJA_ZAKONCZENIA, entityId: organizationId, actorId, before: { zakonczone: true }, after: { zakonczone: false, zrodlo: 'panel' } } })
    return 'ZMIENIONO' as const
  })
}
