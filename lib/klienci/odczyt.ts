// Odczyt danych klienta: jedyna droga do odszyfrowanego `OrderCustomer` poza zapisem i retencją.
// `daneKlienta` sama sprawdza uprawnienie osoby (Membership w firmie klienta `db`, RLS) — wywołujący nie może jej
// „przekonać” parametrem: `zakres: 'PELNY'` bez `klienci.dane` daje skrót, bez `klienci.skrot` odmowę. Dla `SKROT`
// odszyfrowany rekord nie wychodzi z funkcji, tylko imię, pierwsza litera nazwiska i miasto (także na wydruku).
// Każde wywołanie zostawia jeden wiersz AuditLog `KLIENT_PODGLAD` (Order.id, kto, `after: { cel, zakres }`) bez
// wartości; automaty (przesyłka, faktura w workerze) logują się jako `system:<moduł>`. `actorId` z prefiksem `system:`
// pomija sprawdzenie członkostwa, więc wolno go podać tylko z lib/klienci/* (wejscia.ts) i lib/worker/* (strażnik
// tests/klienci-straznik.test.ts); panel zawsze podaje `ctx.user.id`. Wyszukiwanie: jeden wpis na
// zapytanie (`after: { cel: 'WYSZUKIWANIE', trafienia }`), bez szukanej frazy.
import type { Channel, CustomerDataSource, PrismaClient } from '@prisma/client'
import { permissionsOf, type Permission } from '../auth/uprawnienia'
import { organizationIdOf } from '../db'
import { ODBIORCA_AUDIT_ENTITY } from '../odbiorca/pobierz'
import type { Env } from '../sekrety'
import { KLIENT_ZAPIS_JOB, zapisKlientaWlaczony } from './kolejka'
import { klientNaLiscie, skrotRekordu, type RekordKlienta, type SkrotKlienta } from './rekord'
import { kluczSkrotowZEnv, odczytaniaFrazy, rozpoznajFraze, skrot } from './skroty'
import { BladSzyfruKlienta, BrakKluczaKlientow, kluczeKlientowZEnv, odszyfrujKlienta } from './szyfr'
import { ZAPIS_AUDIT } from './zapis'

export const PODGLAD_AUDIT = 'KLIENT_PODGLAD'

// POPRAWKA: odczyt do poprawy adresu i punktu odbioru przed nadaniem (osobny wpis w dzienniku podglądów)
// MAIL: automat poczty (adres e-mail i imię do maila z planu akcji, lib/klienci/wejscia.ts kontaktDoMaila)
export const CELE_ODCZYTU = ['PODGLAD', 'KOPIA', 'WYDRUK', 'PRZESYLKA', 'FAKTURA', 'MAIL', 'WYSZUKIWANIE', 'EKSPORT', 'POPRAWKA'] as const
export type CelOdczytu = (typeof CELE_ODCZYTU)[number]
export type ZakresOdczytu = 'PELNY' | 'SKROT'

/** Automaty z pełnym odczytem tylko do własnego celu (przesyłka, faktura); inne cele systemu = odmowa. */
const CELE_SYSTEMU: ReadonlySet<CelOdczytu> = new Set<CelOdczytu>(['PRZESYLKA', 'FAKTURA', 'MAIL'])

export type DaneKlienta =
  | { stan: 'PELNY'; rekord: RekordKlienta; zrodlo: CustomerDataSource; odczytano: Date; rewizja: number }
  | { stan: 'SKROT'; skrot: SkrotKlienta | null; zrodlo: CustomerDataSource; odczytano: Date }
  | { stan: 'BRAK' }
  | { stan: 'USUNIETE'; usunieto: Date }
  | { stan: 'BRAK_KLUCZA' }
  | { stan: 'BLAD_SZYFRU' }
  | { stan: 'BEZ_UPRAWNIEN' }

export interface OpcjeOdczytu {
  /** User.id osoby z sesji albo `system:<moduł>`. */
  actorId: string
  zakres: ZakresOdczytu
  cel: CelOdczytu
  env?: Env
}

/** Uprawnienia osoby w firmie klienta `db` (aktywne członkostwo); brak = pusty zbiór. */
export async function uprawnieniaOsoby(db: PrismaClient, userId: string): Promise<Set<Permission>> {
  const m = await db.membership.findFirst({ where: { userId, active: true }, select: { role: true, permissions: true, deniedPermissions: true } })
  return m ? permissionsOf(m) : new Set()
}

/** Zakres, który osoba faktycznie dostanie (null = żaden). */
export async function zakresDla(db: PrismaClient, actorId: string, zakres: ZakresOdczytu, cel: CelOdczytu): Promise<ZakresOdczytu | null> {
  if (actorId.startsWith('system:')) return CELE_SYSTEMU.has(cel) ? zakres : null
  const p = await uprawnieniaOsoby(db, actorId)
  if (zakres === 'PELNY' && p.has('klienci.dane')) return 'PELNY'
  if (p.has('klienci.skrot') || p.has('klienci.dane')) return cel === 'PODGLAD' || cel === 'WYDRUK' ? 'SKROT' : null
  return null
}

async function slad(db: PrismaClient, orderId: string, actorId: string, after: Record<string, string | number>): Promise<void> {
  await db.auditLog.create({ data: { entity: PODGLAD_AUDIT, entityId: orderId, actorId, after } })
}

/**
 * Dane klienta zamówienia `orderId` wg uprawnień `actorId`. Ślad przed zwrotem danych: bez zapisanego śladu dane nie
 * wychodzą. Zamówienie spoza firmy (RLS) wygląda jak zamówienie bez danych.
 */
export async function daneKlienta(db: PrismaClient, orderId: string, o: OpcjeOdczytu): Promise<DaneKlienta> {
  if (!CELE_ODCZYTU.includes(o.cel)) throw new Error('daneKlienta: nieznany cel')
  if (typeof o.actorId !== 'string' || !o.actorId.trim()) throw new Error('daneKlienta: brak actorId')
  const zakres = await zakresDla(db, o.actorId, o.zakres, o.cel)
  if (!zakres) {
    await slad(db, orderId, o.actorId, { cel: o.cel, zakres: o.zakres, wynik: 'ODMOWA' })
    return { stan: 'BEZ_UPRAWNIEN' }
  }
  const row = await db.orderCustomer.findUnique({ where: { orderId } })
  if (!row) {
    await slad(db, orderId, o.actorId, { cel: o.cel, zakres, wynik: 'BRAK' })
    return { stan: 'BRAK' }
  }
  if (row.purgedAt) {
    await slad(db, orderId, o.actorId, { cel: o.cel, zakres, wynik: 'USUNIETE' })
    return { stan: 'USUNIETE', usunieto: row.purgedAt }
  }
  let rekord: RekordKlienta
  try {
    rekord = odszyfrujKlienta(kluczeKlientowZEnv(o.env ?? process.env), organizationIdOf(db), orderId, row)
  } catch (e) {
    const brak = e instanceof BrakKluczaKlientow
    await slad(db, orderId, o.actorId, { cel: o.cel, zakres, wynik: brak ? 'BRAK_KLUCZA' : 'BLAD_SZYFRU' })
    if (brak) return { stan: 'BRAK_KLUCZA' }
    if (e instanceof BladSzyfruKlienta) {
      console.warn(`[klienci] odczyt nie powiódł się: zamówienie ${orderId}, ${e.name}`)
      return { stan: 'BLAD_SZYFRU' }
    }
    throw e
  }
  await slad(db, orderId, o.actorId, { cel: o.cel, zakres })
  if (zakres === 'SKROT') return { stan: 'SKROT', skrot: skrotRekordu(rekord), zrodlo: row.source, odczytano: row.fetchedAt }
  return { stan: 'PELNY', rekord, zrodlo: row.source, odczytano: row.fetchedAt, rewizja: row.revision }
}

/** najwięcej zamówień w jednym odczycie listy (największa strona listy to 250). */
export const LISTA_KLIENTOW_MAX = 250

/**
 * kolumna „Klient” listy zamówień: firma albo imię i nazwisko dla zamówień jednej strony, jednym zapytaniem
 * (bez odczytu na wiersz). Tylko osoba z `klienci.dane` (sprawdzane tutaj, jak w `szukajKlientaFragmentem`); bez
 * uprawnienia, bez klucza albo bez danych = pusta mapa. Paczka dodatkowa bez własnych danych bierze dane zamówienia
 * głównego (jak etykieta odbioru). Jeden wpis w dzienniku podglądów na stronę (`cel: PODGLAD`, `lista`, identyfikatory
 * zamówień z pokazanym klientem), zapisany przed zwrotem danych. Uszkodzony rekord pomija jeden wiersz. Wynik tylko do
 * renderu strony: nie zapisuj go w logu, adresie ani innej tabeli.
 */
export async function klienciNaLiscie(db: PrismaClient, zamowienia: readonly { id: string; parentOrderId?: string | null }[], o: { actorId: string; env?: Env }): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const lista = zamowienia.slice(0, LISTA_KLIENTOW_MAX)
  if (!lista.length || typeof o.actorId !== 'string' || !o.actorId.trim() || o.actorId.startsWith('system:')) return out
  if (!(await uprawnieniaOsoby(db, o.actorId)).has('klienci.dane')) return out
  let ring
  try {
    ring = kluczeKlientowZEnv(o.env ?? process.env)
  } catch (e) {
    if (e instanceof BrakKluczaKlientow) return out
    throw e
  }
  const ids = [...new Set(lista.flatMap((z) => (z.parentOrderId ? [z.id, z.parentOrderId] : [z.id])))]
  const rows = await db.orderCustomer.findMany({
    where: { orderId: { in: ids }, purgedAt: null },
    select: { orderId: true, ciphertext: true, iv: true, authTag: true, keyVersion: true },
  })
  const organizationId = organizationIdOf(db)
  const nazwy = new Map<string, string>()
  for (const r of rows) {
    try {
      const n = klientNaLiscie(odszyfrujKlienta(ring, organizationId, r.orderId, r))
      if (n) nazwy.set(r.orderId, n)
    } catch {
      continue // uszkodzony rekord albo stary klucz: pusta komórka w tym jednym wierszu
    }
  }
  for (const z of lista) {
    const n = nazwy.get(z.id) ?? (z.parentOrderId ? nazwy.get(z.parentOrderId) : undefined)
    if (n) out.set(z.id, n)
  }
  await db.auditLog.create({ data: { entity: PODGLAD_AUDIT, entityId: 'lista', actorId: o.actorId, after: { cel: 'PODGLAD', zakres: 'PELNY', lista: true, trafienia: out.size, zamowienia: [...out.keys()] } } })
  return out
}

/** Powód braku wiersza dla karty zamówienia (bez danych): kody do tekstu w panelu. */
export type PowodBraku = 'KANAL_BEZ_ZRODLA' | 'RECZNE_DO_WPISANIA' | 'ZAPIS_WYLACZONY' | 'CIEN' | 'W_KOLEJCE' | 'BLAD_ODCZYTU' | 'NIE_ZAPISANO'

const BEZ_ZRODLA: ReadonlySet<Channel> = new Set<Channel>(['EASYTOOLS', 'RECZNE', 'BL_INNE'])

/** Dlaczego zamówienie nie ma danych klienta: kanał, wyłącznik, kolejka, ostatni ślad zapisu. */
export async function powodBrakuKlienta(db: PrismaClient, orderId: string, env: Env = process.env): Promise<PowodBraku> {
  const order = await db.order.findUnique({ where: { id: orderId }, select: { channel: true } })
  if (order?.channel === 'RECZNE') return 'RECZNE_DO_WPISANIA'
  if (order && BEZ_ZRODLA.has(order.channel)) return 'KANAL_BEZ_ZRODLA'
  const [job, odczyt, zapis] = await Promise.all([
    db.job.findFirst({ where: { kind: KLIENT_ZAPIS_JOB, payload: { path: ['orderId'], equals: orderId } }, orderBy: { createdAt: 'desc' }, select: { status: true } }),
    db.auditLog.findFirst({ where: { entity: ODBIORCA_AUDIT_ENTITY, entityId: orderId }, orderBy: { createdAt: 'desc' }, select: { after: true } }),
    db.auditLog.findFirst({ where: { entity: ZAPIS_AUDIT, entityId: orderId }, orderBy: { createdAt: 'desc' }, select: { after: true } }),
  ])
  if (job && (job.status === 'PENDING' || job.status === 'RUNNING')) return 'W_KOLEJCE'
  const a = (odczyt?.after ?? {}) as { powod?: string; wynik?: string; przyczyna?: string }
  if (a.wynik === 'BRAK') return 'KANAL_BEZ_ZRODLA'
  if (a.wynik === 'ODMOWA' && a.przyczyna === 'CIEN') return 'CIEN'
  if (job?.status === 'FAILED' || (zapis?.after as { wynik?: string } | null)?.wynik === 'BLAD' || a.wynik === 'BLAD') return 'BLAD_ODCZYTU'
  if (!zapisKlientaWlaczony(env)) return 'ZAPIS_WYLACZONY'
  return 'NIE_ZAPISANO'
}

export const POWOD_BRAKU_TEKST: Record<PowodBraku, string> = {
  KANAL_BEZ_ZRODLA: 'kanał nie podaje danych klienta przez API (np. EasyTools, inne przez BaseLinker, adapter bez odczytu odbiorcy)',
  RECZNE_DO_WPISANIA: 'zamówienie ręczne: dane wpisuje człowiek',
  // teksty dla biura bez nazw zmiennych i trybów wewnętrznych (karta zamówienia)
  ZAPIS_WYLACZONY: 'administrator instalacji nie włączył zapisu danych klientów',
  CIEN: 'konto kanału jest w trybie „Tylko podgląd”, a zapis danych klientów dla takich kont jest wyłączony (Ustawienia → Zespół i dostęp → Dane klientów)',
  W_KOLEJCE: 'czeka w kolejce na odczyt z kanału',
  BLAD_ODCZYTU: 'odczyt z kanału nie powiódł się (szczegóły w kolejce zadań i dzienniku, bez danych)',
  NIE_ZAPISANO: 'jeszcze nie zapisano (zamówienie sprzed włączenia zapisu: „Odśwież z kanału”)',
}

export type WynikWyszukiwania =
  | { stan: 'OK'; orderIds: string[]; rodzaj: 'email' | 'telefon' }
  | { stan: 'INNA_FRAZA' }
  | { stan: 'BEZ_UPRAWNIEN' }
  | { stan: 'BRAK_KLUCZA' }

export const KOMUNIKAT_INNA_FRAZA = 'Szukaj po e-mailu albo telefonie; nazwiska nie przeszukujemy, bo są zaszyfrowane'

export type SkrotFrazy = { stan: 'OK'; rodzaj: 'email' | 'telefon'; skrot: string } | { stan: 'INNA_FRAZA' } | { stan: 'BEZ_UPRAWNIEN' } | { stan: 'BRAK_KLUCZA' }

/**
 * Skrót frazy wyszukiwania (akcja panelu): do adresu strony idzie skrót, nigdy e-mail ani telefon (historia przeglądarki,
 * logi reverse proxy). Wymaga `klienci.dane`.
 */
export async function skrotFrazy(db: PrismaClient, fraza: string, o: { actorId: string; env?: Env }): Promise<SkrotFrazy> {
  const p = await uprawnieniaOsoby(db, o.actorId)
  if (!p.has('klienci.dane')) return { stan: 'BEZ_UPRAWNIEN' }
  const f = rozpoznajFraze(fraza)
  if (f.rodzaj === 'inna') return { stan: 'INNA_FRAZA' }
  const key = kluczSkrotowZEnv(o.env ?? process.env)
  if (!key) return { stan: 'BRAK_KLUCZA' }
  return { stan: 'OK', rodzaj: f.rodzaj, skrot: skrot(key, organizationIdOf(db), f.rodzaj, f.wartosc)! }
}

const SKROT_RE = /^[0-9a-f]{64}$/

/**
 * Zamówienia firmy z klientem o tym skrócie e-maila albo telefonu: filtr po `emailHash` / `phoneHash` (indeks), bez
 * odszyfrowywania rekordów i bez pełnotekstowego szukania w szyfrogramie. Wymaga `klienci.dane`. Jeden ślad na zapytanie.
 */
export async function szukajPoSkrocie(db: PrismaClient, rodzaj: 'email' | 'telefon', h: string, o: { actorId: string; limit?: number }): Promise<WynikWyszukiwania> {
  const p = await uprawnieniaOsoby(db, o.actorId)
  if (!p.has('klienci.dane')) return { stan: 'BEZ_UPRAWNIEN' }
  if (!SKROT_RE.test(h)) return { stan: 'INNA_FRAZA' }
  const rows = await db.orderCustomer.findMany({
    where: rodzaj === 'email' ? { emailHash: h, purgedAt: null } : { phoneHash: h, purgedAt: null },
    select: { orderId: true },
    take: Math.min(o.limit ?? 200, 500),
  })
  await db.auditLog.create({ data: { entity: PODGLAD_AUDIT, entityId: 'wyszukiwanie', actorId: o.actorId, after: { cel: 'WYSZUKIWANIE', trafienia: rows.length } } })
  return { stan: 'OK', orderIds: rows.map((r) => r.orderId), rodzaj }
}

/** Fraza → skrót → zamówienia (jedno wywołanie; panel rozdziela to na akcję i ekran). */
export async function szukajPoKliencie(db: PrismaClient, fraza: string, o: { actorId: string; env?: Env; limit?: number }): Promise<WynikWyszukiwania> {
  const s = await skrotFrazy(db, fraza, o)
  if (s.stan !== 'OK') return s
  return szukajPoSkrocie(db, s.rodzaj, s.skrot, o)
}

export interface WpisDziennika {
  id: string
  kiedy: Date
  kto: string
  orderId: string
  cel: string
  zakres: string | null
  trafienia: number | null
  wynik: string | null
}

/** Dziennik podglądów (Ustawienia → Dane klientów): bez danych klienta, filtr po osobie i dacie. */
/**
 * Wpisy dziennika podglądów, najnowsze pierwsze. `autor`: `ludzie` = bez wpisów kluczy API (`api:…`), `klucze` = tylko
 * one; `actorId` (konkretna osoba albo `api:<id klucza>`) ma pierwszeństwo.
 */
export async function dziennikPodgladow(db: PrismaClient, f: { actorId?: string; autor?: 'ludzie' | 'klucze'; od?: Date; do?: Date; limit?: number } = {}): Promise<WpisDziennika[]> {
  const rows = await db.auditLog.findMany({
    where: {
      entity: PODGLAD_AUDIT,
      ...(f.actorId ? { actorId: f.actorId } : f.autor === 'ludzie' ? { NOT: { actorId: { startsWith: 'api:' } } } : f.autor === 'klucze' ? { actorId: { startsWith: 'api:' } } : {}),
      ...(f.od || f.do ? { createdAt: { ...(f.od ? { gte: f.od } : {}), ...(f.do ? { lt: f.do } : {}) } } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: Math.min(f.limit ?? 100, 500),
    select: { id: true, createdAt: true, actorId: true, entityId: true, after: true },
  })
  return rows.map((r) => {
    const a = (r.after ?? {}) as { cel?: unknown; zakres?: unknown; trafienia?: unknown; wynik?: unknown }
    return {
      id: r.id,
      kiedy: r.createdAt,
      kto: r.actorId,
      orderId: r.entityId,
      cel: typeof a.cel === 'string' ? a.cel : '?',
      zakres: typeof a.zakres === 'string' ? a.zakres : null,
      trafienia: typeof a.trafienia === 'number' ? a.trafienia : null,
      wynik: typeof a.wynik === 'string' ? a.wynik : null,
    }
  })
}

export type WynikFrazy = { stan: 'OK'; orderIds: string[]; rodzaje: ('email' | 'telefon' | 'nip')[] } | { stan: 'INNA_FRAZA' } | { stan: 'BEZ_UPRAWNIEN' } | { stan: 'BRAK_KLUCZA' }

/**
 * (jedno pole szukania listy zamówień): zamówienia klientów o e-mailu, telefonie albo NIP-ie z frazy, po
 * skrótach HMAC (indeksy `emailHash`/`phoneHash`/`nipHash`), bez odszyfrowywania. Fraza, która nie jest pełną wartością
 * (nazwisko, numer zamówienia), daje INNA_FRAZA. Wymaga `klienci.dane`; jeden ślad w dzienniku podglądów, bez frazy.
 */
export async function szukajKlientaPoFrazie(db: PrismaClient, fraza: string, o: { actorId: string; env?: Env; limit?: number }): Promise<WynikFrazy> {
  const p = await uprawnieniaOsoby(db, o.actorId)
  if (!p.has('klienci.dane')) return { stan: 'BEZ_UPRAWNIEN' }
  const odczytania = odczytaniaFrazy(fraza)
  if (!odczytania.length) return { stan: 'INNA_FRAZA' }
  const key = kluczSkrotowZEnv(o.env ?? process.env)
  if (!key) return { stan: 'BRAK_KLUCZA' }
  const org = organizationIdOf(db)
  const pole = { email: 'emailHash', telefon: 'phoneHash', nip: 'nipHash' } as const
  const rows = await db.orderCustomer.findMany({
    where: { purgedAt: null, OR: odczytania.map((x) => ({ [pole[x.rodzaj]]: skrot(key, org, x.rodzaj, x.wartosc)! })) },
    select: { orderId: true },
    take: Math.min(o.limit ?? 200, 500),
  })
  await db.auditLog.create({ data: { entity: PODGLAD_AUDIT, entityId: 'wyszukiwanie', actorId: o.actorId, after: { cel: 'WYSZUKIWANIE', trafienia: rows.length } } })
  return { stan: 'OK', orderIds: rows.map((r) => r.orderId), rodzaje: odczytania.map((x) => x.rodzaj) }
}
