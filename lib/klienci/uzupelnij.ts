// Zbiorcze uzupełnienie danych klienta dla istniejących zamówień (decyzja z 05.11: „nic nie ukrywaj”).
// Zamówienia przyjęte przed włączeniem zapisu (`DANE_KLIENTA_ZAPIS`) albo przed dopisaniem kluczy nie mają wiersza
// `OrderCustomer`. To polecenie nie czyta kanału samo: planuje zwykłe zadania KLIENT_ZAPIS workera (te same co po
// przyjęciu zamówienia, lib/klienci/kolejka.ts), rozłożone w czasie, więc tempo kont pilnuje worker (limiter
// `tempo.ts`, zajęte okno = zadanie wraca do kolejki). Bez danych klienta w wyniku: same liczby.
//
// Idempotentne: zamówienie z danymi pomijamy; zamówienie z zadaniem czekającym albo
// trwającym liczymy jako „już w kolejce” i nie wlicza się do `limit`, więc kolejny przebieg bierze następne zamówienia;
// zadanie zakończone błędem (FAILED) wraca do kolejki z wyzerowanymi próbami. Zadanie wykonane (DONE) bez zapisu to
// zwykle wynik trwały (konto w cieniu bez zgody firmy, konto nieaktywne, adapter bez odczytu odbiorcy), więc wraca
// tylko z jawnym `ponow` (`--ponow`): inaczej każdy przebieg dokładałby te same odmowy do dziennika.
import type { Channel, JobStatus, OrderStatus, PrismaClient } from '@prisma/client'
import { dedupeZapisu, KLIENT_ZAPIS_JOB, KLIENT_ZAPIS_PROB, zapisKlientaZEnv } from './kolejka'

/** Kanały bez odczytu klienta przez API (jak lib/odbiorca/pobierz.ts): tu nie ma czego uzupełniać. */
const BEZ_ZRODLA: Channel[] = ['EASYTOOLS', 'RECZNE', 'BL_INNE']
/** Zamówienia zamknięte: bez uzupełniania, chyba że `wszystkie`. */
const ZAMKNIETE: OrderStatus[] = ['ODEBRANE', 'ANULOWANE']
/** Ile zamówień bez danych czytamy naraz, szukając nowej pracy. */
const STRONA = 1000

export interface OpcjeUzupelnienia {
  env?: Record<string, string | undefined>
  now?: Date
  /** Najwięcej zamówień do zaplanowania albo wznowienia w jednym przebiegu (domyślnie 500, maks. 5000). Zamówienia
   *  z zadaniem w kolejce się nie liczą, więc kolejny przebieg weźmie następne. */
  limit?: number
  /** Odstęp między startami zadań w ms (domyślnie 3000): kolejka nie rusza wszystkich naraz. */
  odstepMs?: number
  /** Także zamówienia odebrane i anulowane (domyślnie tylko otwarte). */
  wszystkie?: boolean
  /** Wznów też zadania wykonane bez zapisu (DONE), np. po zgodzie firmy na odczyt w cieniu. Domyślnie tylko FAILED. */
  ponow?: boolean
  /** Tylko policz, nic nie planuj. */
  proba?: boolean
}

export interface WynikUzupelnienia {
  /** Zamówienia bez danych, które ten przebieg planuje albo wznawia (≤ limit). */
  kandydaci: number
  zaplanowane: number
  wznowione: number
  /** Zamówienia bez danych z zadaniem czekającym albo trwającym (nie wliczają się do limitu). */
  wKolejce: number
  /** Zamówienia bez danych z zadaniem wykonanym bez zapisu (DONE), pominięte bez `ponow`. */
  pominieteWykonane: number
}

export class ZapisKlientaWylaczony extends Error {
  constructor() {
    super('Zapis danych klienta jest wyłączony na tej instalacji. Włącza go administrator serwera.')
    this.name = 'ZapisKlientaWylaczony'
  }
}

export async function uzupelnijDaneKlientow(db: PrismaClient, o: OpcjeUzupelnienia = {}): Promise<WynikUzupelnienia> {
  if (!zapisKlientaZEnv(o.env ?? process.env)) throw new ZapisKlientaWylaczony()
  const now = o.now ?? new Date()
  const limit = Math.max(1, Math.min(5000, Math.floor(o.limit ?? 500)))
  const odstep = Math.max(0, Math.min(600_000, Math.floor(o.odstepMs ?? 3000)))
  const wznawiane = new Set<JobStatus>(o.ponow ? ['FAILED', 'DONE'] : ['FAILED'])
  const wynik: WynikUzupelnienia = { kandydaci: 0, zaplanowane: 0, wznowione: 0, wKolejce: 0, pominieteWykonane: 0 }
  // praca: zamówienia bez zadania albo z zadaniem do wznowienia; czytamy stronami, aż uzbiera się `limit` albo skończą
  const praca: { orderId: string; jobId: string | null }[] = []
  let kursor: string | undefined
  while (praca.length < limit) {
    const strona = await db.order.findMany({
      where: {
        customer: { is: null },
        channel: { notIn: BEZ_ZRODLA },
        NOT: { externalId: { contains: '#' } }, // podzamówienia (dośle, paczka) kanał zna pod numerem rodzica
        ...(o.wszystkie ? {} : { status: { notIn: ZAMKNIETE } }),
      },
      orderBy: [{ createdAtChannel: 'desc' }, { id: 'asc' }],
      take: STRONA,
      ...(kursor ? { cursor: { id: kursor }, skip: 1 } : {}),
      select: { id: true },
    })
    if (!strona.length) break
    kursor = strona[strona.length - 1]!.id
    const joby = await db.job.findMany({ where: { kind: KLIENT_ZAPIS_JOB, dedupeKey: { in: strona.map((k) => dedupeZapisu(k.id)) } }, select: { id: true, dedupeKey: true, status: true } })
    const poKluczu = new Map(joby.map((j) => [j.dedupeKey!, j]))
    for (const k of strona) {
      const j = poKluczu.get(dedupeZapisu(k.id))
      if (j && (j.status === 'PENDING' || j.status === 'RUNNING')) wynik.wKolejce++
      else if (j && !wznawiane.has(j.status)) wynik.pominieteWykonane++
      else if (praca.length < limit) praca.push({ orderId: k.id, jobId: j?.id ?? null })
    }
    if (strona.length < STRONA) break
  }
  wynik.kandydaci = praca.length
  if (o.proba || !praca.length) return wynik
  let i = 0
  for (const k of praca) {
    const runAfter = new Date(now.getTime() + i * odstep)
    // każde zamówienie osobno: błąd jednego nie zatrzymuje reszty (zasada fail-safe per element)
    try {
      if (k.jobId) {
        // warunek na status zamyka wyścig z workerem: zadanie, które w międzyczasie ruszyło, zostaje
        const n = await db.job.updateMany({ where: { id: k.jobId, status: { in: [...wznawiane] } }, data: { status: 'PENDING', attempts: 0, lastError: null, lockedAt: null, lockedBy: null, runAfter, maxAttempts: KLIENT_ZAPIS_PROB } })
        if (n.count) wynik.wznowione++
        else wynik.wKolejce++
      } else {
        const id = 'kz_' + globalThis.crypto.randomUUID().replace(/-/g, '')
        const payload = JSON.stringify({ orderId: k.orderId })
        const n = await db.$executeRaw`
          INSERT INTO "Job" (id, kind, payload, "dedupeKey", "runAfter", "maxAttempts", "updatedAt")
          VALUES (${id}, ${KLIENT_ZAPIS_JOB}, ${payload}::jsonb, ${dedupeZapisu(k.orderId)}, ${runAfter}, ${KLIENT_ZAPIS_PROB}, ${now})
          ON CONFLICT ("organizationId", "dedupeKey") DO NOTHING`
        if (n) wynik.zaplanowane++
        else wynik.wKolejce++
      }
      i++
    } catch (e) {
      console.warn(`[klienci] uzupełnienie: zamówienie ${k.orderId} pominięte (${e instanceof Error ? e.name : 'błąd'})`)
    }
  }
  return wynik
}
