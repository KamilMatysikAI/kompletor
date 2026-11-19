// Decyzje obsługi o braku towaru (spec 4.2). Pakujący zgłasza brak na stanowisku, obsługa rozstrzyga na
// karcie zamówienia: wyślij resztę (domyślnie), dośle później, poczekaj na towar albo zamień produkt.
//
// Konto w cieniu: wyłącznie wiersz ShortageDecision (dryRun), rdzeń nietknięty, bo BL jest źródłem prawdy i cień liczy
// rozjazdy. Konto w PRACY: decyzję wykonuje rdzeń (lib/rdzen/brakuje.ts). Zwrotu pieniędzy i korekty faktury system nie
// robi sam: zostają zadaniem obsługi (lista „Do zwrotu” na /braki, alert przy spakowaniu).
import { Prisma, type OrderStatus, type PrismaClient, type ShortageAction } from '@prisma/client'
import { organizationIdOf } from '@/lib/db'
import { brakJednakWPaczceInTx, cofnijBrakNaPolceInTx, shipLater, ShortageActionError, swapProduct, type WynikJednakWPaczce } from '@/lib/rdzen/brakuje'
import { cancelPicking } from '@/lib/rdzen/przejscia'
import { advisoryLock, runTx } from '@/lib/rdzen/stan'
import { TransitionError } from '@/lib/rdzen/statusy'
import { BladStanowiska, ZAPIS_PRACA } from './cwiczenie'

type Db = PrismaClient

export const DECYZJE: { akcja: ShortageAction; etykieta: string; opis: string }[] = [
  { akcja: 'WYSLIJ_RESZTE', etykieta: 'Wyślij resztę', opis: 'Reszta wychodzi od razu. Za brak zwrot pieniędzy (obsługa robi go ręcznie) albo mniejsze pobranie.' },
  { akcja: 'DOSLIJ', etykieta: 'Dośle później', opis: 'Reszta wychodzi od razu, brak idzie drugą paczką, gdy towar wróci.' },
  { akcja: 'POCZEKAJ', etykieta: 'Poczekaj na towar', opis: 'Nie pakujemy, aż towar wróci. Całość wyjdzie jedną paczką.' },
  { akcja: 'ZAMIEN', etykieta: 'Zamień produkt', opis: 'W paczce inny produkt po tej samej cenie. Podaj SKU zamiennika.' },
]

export const ETYKIETA_DECYZJI: Record<ShortageAction, string> = {
  WYSLIJ_RESZTE: 'wyślij resztę',
  DOSLIJ: 'dośle później',
  POCZEKAJ: 'poczekaj na towar',
  ZAMIEN: 'zamień produkt',
}

const isAkcja = (v: unknown): v is ShortageAction => DECYZJE.some((d) => d.akcja === v)

/** Przed spakowaniem: poczekać, zamienić i wybrać „wyślij resztę” można tylko, dopóki paczka nie wyszła. */
const PRZED_SPAKOWANIEM = new Set<OrderStatus>(['NOWE', 'DO_REALIZACJI', 'ZBIERANIE', 'ZEBRANE', 'DO_WYJASNIENIA'])

export interface DecyzjaBraku {
  orderLineId: string
  akcja: ShortageAction
  /** SKU zamiennika, tylko przy ZAMIEN. */
  sku?: string | null
  userId: string
}

/**
 * Zapisuje (a w PRACY wykonuje) decyzję o pozycji. Jedna decyzja na pozycję: ta sama drugi raz nic nie robi (`zmiana:
 * false`), zmiana „wyślij resztę” ↔ „poczekaj” działa w obie strony, a wykonanego dosłania i zamiany cofnąć się nie da.
 */
export async function zdecydujOBraku(db: Db, a: DecyzjaBraku): Promise<{ zmiana: boolean; dryRun: boolean }> {
  organizationIdOf(db)
  if (!isAkcja(a.akcja)) throw new BladStanowiska('Nieznana decyzja')
  if (typeof a.orderLineId !== 'string' || !/^[a-z0-9]{1,40}$/i.test(a.orderLineId)) throw new BladStanowiska('Nieznana pozycja')
  const line = await db.orderLine.findUnique({ where: { id: a.orderLineId }, include: { order: true, shortages: { where: { state: { in: ['OPEN', 'REFUND_PENDING'] } } } } })
  if (!line) throw new BladStanowiska('Nieznana pozycja')
  const konto = await db.channelConfig.findFirst({ where: { channel: line.order.channel, channelAccountId: line.order.channelAccountId }, select: { statusMode: true } })
  const dryRun = konto?.statusMode !== 'PRACA' // konto bez konfiguracji jak cień, tak samo jak na stanowisku

  let replacementProductId: string | null = null
  if (a.akcja === 'ZAMIEN') {
    const sku = String(a.sku ?? '').trim()
    if (!sku) throw new BladStanowiska('Podaj SKU zamiennika')
    const p = await db.product.findFirst({ where: { sku }, select: { id: true } })
    if (!p) throw new BladStanowiska(`Nie ma produktu o SKU ${sku.slice(0, 60)}`)
    if (p.id === line.productId) throw new BladStanowiska('Zamiennik to ten sam produkt')
    replacementProductId = p.id
  }

  const poprzednia = await db.shortageDecision.findUnique({ where: { organizationId_orderLineId: { organizationId: organizationIdOf(db), orderLineId: line.id } } })
  if (poprzednia && poprzednia.action === a.akcja && poprzednia.replacementProductId === replacementProductId) {
    // ponowny klik „poczekaj”: dokończ cofnięcie zbierania, jeśli poprzednio nie przeszło
    if (!dryRun && a.akcja === 'POCZEKAJ') await zwolnijZbieranie(db, line.orderId, a.userId)
    return { zmiana: false, dryRun }
  }
  const zgloszone = dryRun ? await db.packDrillFix.count({ where: { orderLineId: line.id, state: { not: 'WITHDRAWN' } } }) : 0
  if (!line.shortages.length && !zgloszone) throw new BladStanowiska('Na tej pozycji nie ma braku')

  if (!dryRun) {
    if (poprzednia && !poprzednia.dryRun && (poprzednia.action === 'DOSLIJ' || poprzednia.action === 'ZAMIEN')) throw new BladStanowiska('Ta decyzja jest już wykonana')
    const otwarty = line.shortages.some((s) => s.state === 'OPEN')
    if (a.akcja !== 'DOSLIJ' && !PRZED_SPAKOWANIEM.has(line.order.status)) throw new BladStanowiska('Paczka już wyszła: zostaje zwrot albo dosłanie')
    if (a.akcja !== 'DOSLIJ' && !otwarty) throw new BladStanowiska('Na tej pozycji nie ma otwartego braku')
    try {
      if (a.akcja === 'DOSLIJ') await shipLater(db, line.id, { actorId: `user:${a.userId}` })
      if (a.akcja === 'ZAMIEN') await swapProduct(db, line.id, replacementProductId!, { actorId: `user:${a.userId}` })
    } catch (e) {
      if (e instanceof ShortageActionError) throw new BladStanowiska(e.message)
      if (e instanceof Error && /Brak otwartych braków|tylko dla zamówień opłaconych/.test(e.message)) throw new BladStanowiska(e.message)
      throw e
    }
  }
  const dane = { action: a.akcja, replacementProductId, dryRun, actorId: a.userId }
  const klucz = { organizationId_orderLineId: { organizationId: organizationIdOf(db), orderLineId: line.id } }
  try {
    await db.shortageDecision.upsert({ where: klucz, create: { orderId: line.orderId, orderLineId: line.id, ...dane }, update: dane })
  } catch (e) {
    // dwa kliki naraz: rdzeń wpuścił wykonanie raz, drugi zapis wpada na unikalność; decyzja i tak ma zostać zapisana
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e
    await db.shortageDecision.update({ where: klucz, data: dane })
  }
  if (!dryRun) await db.orderEvent.create({ data: { orderId: line.orderId, kind: 'DECYZJA_BRAK', actorId: `user:${a.userId}`, data: { pozycja: line.id, decyzja: a.akcja } } })
  if (!dryRun && a.akcja === 'POCZEKAJ') await zwolnijZbieranie(db, line.orderId, a.userId)
  return { zmiana: true, dryRun }
}

/**
 * „Poczekaj” w trakcie zbierania: przydział bierze tylko zamówienia przed zbieraniem, więc inaczej dostawa by tu nie trafiła.
 * Bez warunku na status z odczytu sprzed decyzji: `moveOrderInTx` czyta status pod
 * blokadą; DO_REALIZACJI zostaje bez zmian, każdy inny status niż ZBIERANIE kończy się `TransitionError` (np. spakowane
 * w tej samej chwili: zostaje jak jest).
 */
async function zwolnijZbieranie(db: Db, orderId: string, userId: string): Promise<void> {
  await cancelPicking(db, orderId, { actorId: `user:${userId}` }).catch((e) => {
    if (!(e instanceof TransitionError)) throw e
  })
}

/**
 * Biuro: „Wyszedł komplet” z karty zamówienia albo listy Braki towaru → „Do zwrotu”. Magazyn spakował całość
 * mimo ramki „Brakuje, nie pakuj”, bo towar leżał na półce, choć nie był jeszcze przyjęty na stan. Rdzeń
 * (`brakJednakWPaczceInTx`) zamyka brak bez zwrotu i dopisuje paczce rezerwację, gdy stan pozwala; fakturę na całość
 * wystawia potem „Ponów fakturę” (albo kolejka, gdy faktura jeszcze nie szła). Tylko konto w PRACY: w podglądzie rdzeń
 * nie ma braków (BaseLinker jest źródłem prawdy). Pod blokadą pakowania, jak „Jednak jest na półce”.
 */
export async function wyszedlKomplet(db: Db, a: { orderLineId: string; userId: string }, now = new Date()): Promise<WynikJednakWPaczce> {
  const org = organizationIdOf(db)
  if (typeof a.orderLineId !== 'string' || !/^[a-z0-9]{1,40}$/i.test(a.orderLineId)) throw new BladStanowiska('Nieznana pozycja')
  const line = await db.orderLine.findUnique({ where: { id: a.orderLineId }, select: { orderId: true, order: { select: { channel: true, channelAccountId: true } } } })
  if (!line) throw new BladStanowiska('Nieznana pozycja')
  const konto = await db.channelConfig.findFirst({ where: { channel: line.order.channel, channelAccountId: line.order.channelAccountId }, select: { statusMode: true } })
  if (konto?.statusMode !== 'PRACA') throw new BladStanowiska('Konto sklepu jest w podglądzie: braki prowadzi BaseLinker')
  return runTx(db, async (tx) => {
    await advisoryLock(tx, `pakowanie:${org}:${line.orderId}`)
    try {
      return await brakJednakWPaczceInTx(tx, a.orderLineId, { now, actorId: `user:${a.userId}` })
    } catch (e) {
      if (e instanceof ShortageActionError) throw new BladStanowiska(e.message)
      throw e
    }
  })
}

/**
 * Biuro: „Jednak jest na półce” z karty zamówienia. Cofa „nie ma na półce” pozycji i produktu w rdzeniu
 * (`cofnijBrakNaPolceInTx`), póki paczka nie wyszła i biuro nie poprawiło stanu w wFirmie. Pod blokadą pakowania, żeby nie
 * minąć się z oknem stanowiska; wpisy stanowiska tej pozycji → WITHDRAWN (okno otwarte w tej chwili zobaczy brak bilansu
 * przy „Spakowano” i pakujący dozbiera według ekranu po ponownym otwarciu).
 */
export async function jednakJestZBiura(db: Db, a: { orderLineId: string; productId: string; userId: string }, now = new Date()): Promise<{ qty: number; units: number }> {
  const org = organizationIdOf(db)
  const id = /^[a-z0-9]{1,40}$/i
  if (typeof a.orderLineId !== 'string' || !id.test(a.orderLineId) || typeof a.productId !== 'string' || !id.test(a.productId)) throw new BladStanowiska('Nieznana pozycja')
  const line = await db.orderLine.findUnique({ where: { id: a.orderLineId }, select: { orderId: true, order: { select: { channel: true, channelAccountId: true } } } })
  if (!line) throw new BladStanowiska('Nieznana pozycja')
  // (runda 2): przycisk widać tylko na koncie w PRACY (pozycje.tsx), ale serwer sprawdza to sam; w podglądzie
  // brak żyje tylko w ćwiczeniu stanowiska i rdzeń nie ma czego cofać
  const konto = await db.channelConfig.findFirst({ where: { channel: line.order.channel, channelAccountId: line.order.channelAccountId }, select: { statusMode: true } })
  if (konto?.statusMode !== 'PRACA') throw new BladStanowiska('Konto sklepu jest w podglądzie: brak cofasz na stanowisku pakowania („Jednak jest”)')
  return runTx(db, async (tx) => {
    await advisoryLock(tx, `pakowanie:${org}:${line.orderId}`)
    let r: { qty: number; units: number }
    try {
      r = await cofnijBrakNaPolceInTx(tx, a.orderLineId, a.productId, { now, actorId: `user:${a.userId}` })
    } catch (e) {
      if (e instanceof ShortageActionError) throw new BladStanowiska(e.message)
      throw e
    }
    await tx.packDrillFix.updateMany({
      where: { orderId: line.orderId, orderLineId: a.orderLineId, productId: a.productId, closedBy: ZAPIS_PRACA, state: { not: 'WITHDRAWN' } },
      data: { state: 'WITHDRAWN', withdrawnAt: now, withdrawnBy: a.userId },
    })
    return r
  })
}
