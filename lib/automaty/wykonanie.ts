// Wykonanie kroków automatycznych akcji. Każdy krok idzie istniejącą drogą rdzenia albo hosta, nigdy nową
// drogą zapisu obok nich:
//  - „ustaw status”: tylko konto sklepu w trybie pracy (konto PRACA + EKRANY_PRACA, jak „Zmień status” na karcie);
//    status firmy z tym samym etapem = sama nazwa (Order.companyStatus); inny etap tylko drogami, które
//    rdzeń daje ekranom (lib/praca/status-dowolny.ts `opcjeStatusu`: przejście z tabeli `canTransition` funkcją rdzenia
//    `moveOrderInTx` z warunkami `powodOdmowy`, cofnięcie pomyłki, anulowanie `cancelOrder`, „Do wyjaśnienia”
//    `clarifyOrder`). Niedozwolone = krok pominięty z powodem;
//  - „wyślij e-mail”: wiersz planu maili (PlannedAction, lib/akcje), wysyła go poczta firmy z jej
//    bramkami; konto w podglądzie = plan SUCHO („wysłałbym”); krok pominięty, gdy ten sam mail planuje już wbudowany
//    plan maili (lib/akcje/silnik.ts), żeby klient nie dostał dwóch;
//  - „utwórz przesyłkę”: `utworzPrzesylke` (lib/wysylka/nadanie.ts) z bramką `bramkaNadania` (zapisWlaczony konta
//    przewoźnika, tryb pracy) i `executeWrite`;
//  - „wydrukuj etykietę”: zlecenie druku jak z panelu (lib/druk/panel.ts `zlecZPanelu`, typ etykieta);
//  - „wystaw fakturę”: kolejka faktur rdzenia (ponowienie nieudanej `ponowFaktureRecznie`; nową wystawia rdzeń po
//    spakowaniu, gdy firma ma włączone wystawianie), „anuluj fakturę”: nieudaną anuluje już rdzeń (`failInvoice`);
//  - „oznacz”: Order.flags; „anuluj zamówienie”: krok „ustaw status” na anulowanie (`cancelOrder`, bramka trybu pracy,
//    bez anulowania po fakturze).
// Każdy krok osobno w try/catch: błąd jednego kroku nie zatrzymuje następnych i trafia do wyniku (historia na karcie).
import type { ActionMode, OrderStatus, Prisma, PrismaClient } from '@prisma/client'
import { accountDisplayName, channelPrefix } from '@/lib/panel/format'
import { STATUS_ZAMOWIENIA, wybierzStatusFirmy, type StatusFirmyT } from '@/lib/panel/statusy'
import { faktyEkranu, wczytajZamowienieEkranu } from '@/lib/praca/dane'
import { opcjeStatusu } from '@/lib/praca/status-dowolny'
import { kontoZamowienia, pracaDostepna } from '@/lib/praca/wlacznik'
import { lockOrder, moveOrderInTx } from '@/lib/rdzen/przejscia'
import { hintAllocate, mergeFlags } from '@/lib/rdzen/rezerwacja'
import { LIMIT_ERROR_PREFIX, ponowFaktureRecznie } from '@/lib/rdzen/rozchod'
import { runTx } from '@/lib/rdzen/stan'
import { canTransition, TransitionError } from '@/lib/rdzen/statusy'
import { cancelOrder, clarifyOrder } from '@/lib/rdzen/zamowienia'
import { zwolnijKoszykPoStatusie } from '@/lib/koszyki/zwolnienie'
import type { DepsNadania } from '@/lib/wysylka/nadanie'
import { planWbudowanyFirmy } from '@/lib/akcje/silnik'
import { KROKI, type Krok, SZABLONY_MAILI } from './schemat'

type Db = PrismaClient
type Env = Record<string, string | undefined>

export const ZDARZENIE_AUTOMATU = 'AUTOMAT'

/** Wynik kroku zapisany w AutomationRun.steps i w historii zamówienia. */
export interface WynikKroku {
  krok: Krok['typ']
  wynik: 'WYKONANY' | 'POMINIETY' | 'BLAD'
  opis: string
}

export interface KontekstWykonania {
  regulaId: string
  regulaNazwa: string
  /** głębokość łańcucha zdarzenia, które uruchomiło regułę; zmiany tej reguły dostają `lancuch + 1` */
  lancuch: number
  /** klucz okazji (idempotencja planu maili i zleceń druku) */
  okazja: string
  statusy: readonly StatusFirmyT[]
  env: Env
  now: Date
  deps?: DepsNadania & { druk?: (orderId: string, stanowisko: string | null, klucz: string) => Promise<string | null> }
  /**
   * wykonanie ze zdarzenia (nie z przycisku). Krok pominięty tylko dlatego, że konto sklepu jest w podglądzie
   * albo że mail wysyła już wbudowany plan maili, nie trafia wtedy do historii zamówienia (zostaje w wyniku wykonania,
   * AutomationRun.steps): firma w podglądzie z regułami presetu ma tę samą historię zamówień co bez reguł.
   */
  cicho?: boolean
}

/** Autor zmian reguły: `automat:<głębokość>:<id reguły>` — silnik z niego czyta długość łańcucha (bezpiecznik pętli). */
export const aktorAutomatu = (lancuch: number, regulaId: string) => `automat:${lancuch}:${regulaId}`
export function lancuchZAktora(actorId: string): number | null {
  const m = /^automat:(\d+):/.exec(actorId)
  return m ? Number(m[1]) : null
}

async function zapiszHistorie(db: Db, orderId: string, k: KontekstWykonania, data: Record<string, unknown>): Promise<void> {
  await db.orderEvent.create({ data: { orderId, kind: ZDARZENIE_AUTOMATU, actorId: aktorAutomatu(k.lancuch + 1, k.regulaId), data: { regula: k.regulaId, nazwa: k.regulaNazwa, ...data } as Prisma.InputJsonObject } })
}

/** Krok „ustaw status”: sama nazwa albo dozwolona droga rdzenia. Zwraca wynik kroku (nigdy nie rzuca TransitionError). */
export async function ustawStatusAutomatem(db: Db, orderId: string, klucz: string, k: KontekstWykonania): Promise<WynikKroku> {
  const krok = 'ustawStatus' as const
  // firma bez statusów własnych: statusy rdzenia jako `RDZEN:<status>` (zamówienie dostaje sam etap, bez przypisania wprost)
  const def = k.statusy.find((d) => d.key === klucz && d.active) ?? statusRdzenia(klucz)
  if (!def) return { krok, wynik: 'POMINIETY', opis: 'status nie istnieje albo jest ukryty' }
  const o = await wczytajZamowienieEkranu(db, orderId)
  if (!o) return { krok, wynik: 'POMINIETY', opis: 'nie ma zamówienia' }
  if (def.carriers.length && !def.carriers.includes(o.carrier ?? 'BRAK')) return pominiety(db, orderId, k, krok, `status „${def.name}” nie pasuje do przewoźnika zamówienia`)
  const teraz = await db.order.findUnique({ where: { id: orderId }, select: { companyStatus: true, status: true, carrier: true } })
  const obecny = teraz ? wybierzStatusFirmy(k.statusy, teraz) : null
  if (o.status === def.baseStatus && (obecny?.key === def.key || def.key.startsWith('RDZEN:'))) return { krok, wynik: 'WYKONANY', opis: `status „${def.name}” już był` }
  // każda zmiana (także samej nazwy statusu) tylko w trybie pracy, jak „Zmień status” na karcie
  // (lib/praca/status-dowolny.ts: WYLACZONE przed gałęzią NAZWA): konto w podglądzie prowadzi dotychczasowy system
  let praca: boolean
  try {
    praca = pracaDostepna(await kontoZamowienia(db, o, k.env), k.env)
  } catch {
    praca = false
  }
  if (!praca) return pominiety(db, orderId, k, krok, `zmiana statusu na „${def.name}” tylko dla konta sklepu w trybie pracy`, true)
  if (o.status === def.baseStatus) {
    const n = await db.order.updateMany({ where: { id: orderId, status: def.baseStatus }, data: { companyStatus: def.key } })
    if (!n.count) return pominiety(db, orderId, k, krok, 'zamówienie zmieniło etap w trakcie')
    await zapiszHistorie(db, orderId, k, { krok, z: o.status, na: def.baseStatus, statusZ: obecny?.key ?? null, statusFirmy: def.key, nazwaStatusu: def.name })
    return { krok, wynik: 'WYKONANY', opis: `ustawiono status „${def.name}”` }
  }
  // inny etap: tylko dozwolone przejście
  const opcja = opcjeStatusu(o, await faktyEkranu(db, o), new Set()).find((x) => x.status === def.baseStatus)
  if (!opcja) return pominiety(db, orderId, k, krok, `przejście niedozwolone: z etapu „${o.status}” nie ma drogi do „${def.name}”`)
  if (opcja.powod || !opcja.droga) return pominiety(db, orderId, k, krok, `przejście niedozwolone: ${opcja.powod ?? 'ten etap ma własny przycisk'}`)
  const actorId = aktorAutomatu(k.lancuch + 1, k.regulaId)
  const z = o.status
  const to = opcja.status
  try {
    switch (opcja.droga) {
      case 'RDZEN':
        await runTx(db, async (tx) => {
          const cur = await lockOrder(tx, orderId)
          if (cur.status !== z) throw new TransitionError('zamówienie zmieniło etap w trakcie')
          if (to === 'REKLAMACJA') {
            if (!canTransition(cur.status, to)) throw new TransitionError(`Niedozwolone przejście ${cur.status} → ${to}`)
            await tx.order.update({ where: { id: orderId }, data: { status: to } })
            await zwolnijKoszykPoStatusie(tx, orderId, to)
          } else await moveOrderInTx(tx, orderId, to, { actorId, now: k.now })
        })
        break
      case 'COFNIECIE':
        await runTx(db, async (tx) => {
          const cur = await lockOrder(tx, orderId)
          if (cur.status !== z || cur.pendingAction) throw new TransitionError('zamówienie zmieniło etap w trakcie')
          await tx.order.update({ where: { id: orderId }, data: { status: to, ...(to === 'DO_REALIZACJI' ? { flags: mergeFlags(cur, { kartaNieaktualna: undefined }) } : {}) } })
          if (to === 'DO_REALIZACJI') await hintAllocate(tx, orderId, k.now)
        })
        break
      case 'ANULUJ': {
        const st = await cancelOrder(db, orderId, { actorId, now: k.now })
        if (st !== 'ANULOWANE') {
          await zapiszHistorie(db, orderId, k, { krok, z, na: st, odlozone: true, nazwaStatusu: def.name })
          return { krok, wynik: 'WYKONANY', opis: 'anulowanie czeka na wynik faktury' }
        }
        break
      }
      case 'WYJASNIJ': {
        const ok = await clarifyOrder(db, orderId, `automatyczna akcja: ${k.regulaNazwa}`.slice(0, 200), { allowed: [z], actorId, now: k.now })
        if (!ok) return pominiety(db, orderId, k, krok, 'zamówienie zmieniło etap w trakcie')
        break
      }
    }
  } catch (e) {
    if (e instanceof TransitionError) return pominiety(db, orderId, k, krok, `przejście niedozwolone: ${e.message}`)
    throw e
  }
  await db.order.updateMany({ where: { id: orderId, status: def.baseStatus }, data: { companyStatus: def.key.startsWith('RDZEN:') ? null : def.key } })
  await zapiszHistorie(db, orderId, k, { krok, z, na: to, statusZ: obecny?.key ?? null, statusFirmy: def.key, nazwaStatusu: def.name })
  return { krok, wynik: 'WYKONANY', opis: `ustawiono status „${def.name}”` }
}

/** Status rdzenia w roli statusu firmy (firma bez statusów własnych). */
function statusRdzenia(klucz: string): StatusFirmyT | undefined {
  if (!klucz.startsWith('RDZEN:')) return undefined
  const b = klucz.slice(6) as OrderStatus
  if (!STATUS_ZAMOWIENIA[b]) return undefined
  return { key: klucz, name: STATUS_ZAMOWIENIA[b].etykieta, color: 'szary', sortOrder: 0, baseStatus: b, carriers: [], active: true }
}

async function pominiety(db: Db, orderId: string, k: KontekstWykonania, krok: Krok['typ'], powod: string, techniczny = false): Promise<WynikKroku> {
  if (techniczny && k.cicho) return { krok, wynik: 'POMINIETY', opis: powod }
  await db.orderEvent.create({ data: { orderId, kind: 'AUTOMAT_POMINIETY', actorId: 'system:automaty', data: { regula: k.regulaId, nazwa: k.regulaNazwa, krok, powod: powod.slice(0, 300) } } })
  return { krok, wynik: 'POMINIETY', opis: powod }
}

async function trybKonta(db: Db, o: { channel: import('@prisma/client').Channel; channelAccountId: string }): Promise<{ mode: ActionMode; numer: (ext: string) => string }> {
  const c = await db.channelConfig.findFirst({ where: { channel: o.channel, channelAccountId: o.channelAccountId }, select: { statusMode: true, name: true, config: true } })
  return { mode: c?.statusMode === 'PRACA' ? 'PRACA' : 'SUCHO', numer: (ext) => `${channelPrefix(o.channel, accountDisplayName(o.channel, o.channelAccountId, c?.name, c?.config))} ${ext}` }
}

/**
 * Czy ten mail planuje (albo za chwilę zaplanuje) wbudowany plan maili (lib/akcje/silnik.ts), który działa dla każdej
 * firmy, która go nie wyłączyła (`settings.akcje.planWbudowany`): wtedy krok reguły nic nie dokłada, bo poczta firmy wysłałaby klientowi dwa maile.
 * Wyłączenie wbudowanego planu per firma.
 */
async function planWbudowany(db: Db, orderId: string, szablon: Extract<Krok, { typ: 'wyslijEmail' }>['szablon'], o: { reminderSentAt: Date | null; status: OrderStatus }, okazja: string | null): Promise<boolean> {
  // firma z wyłączonym planem wbudowanym — mail planuje tylko reguła
  if (!(await planWbudowanyFirmy(db))) return false
  if (szablon === 'brak-platnosci' && o.reminderSentAt) return true
  if (szablon === 'gotowe-do-odbioru' && o.status === 'DO_ODBIORU') return true
  // „Faktura”: wbudowany plan wysyła ją dla każdego wysłanego albo odebranego zamówienia z wystawioną fakturą
  if (szablon === 'faktura' && (o.status === 'WYSLANE' || o.status === 'ODEBRANE')) return true
  const jest = await db.plannedAction.findFirst({
    where: { rule: SZABLONY_MAILI[szablon].regula, targetType: 'ZAMOWIENIE', targetId: orderId, state: { in: ['PLANNED', 'DONE'] }, NOT: { occasion: { startsWith: 'automat:' } }, ...(okazja ? { occasion: okazja } : {}) },
    select: { id: true },
  })
  return !!jest
}

const POWOD_PLANU = 'ten mail wysyła już wbudowany plan maili Kompletora, reguła go nie dubluje'
const POWOD_TEJ_SAMEJ_FAKTURY = 'mail „Faktura” z tą fakturą jest już zaplanowany albo wysłany'

/** Mail „Faktura” z tym dokumentem już w planie (zaplanowany albo wysłany), z dowolnej okazji i reguły. */
async function fakturaJuzZaplanowana(db: Db, orderId: string, wfirmaDocId: string): Promise<boolean> {
  const jest = await db.plannedAction.findFirst({
    where: { rule: SZABLONY_MAILI.faktura.regula, targetType: 'ZAMOWIENIE', targetId: orderId, state: { in: ['PLANNED', 'DONE'] }, vars: { path: ['wfirmaDocId'], equals: wfirmaDocId } },
    select: { id: true },
  })
  return !!jest
}

/** Krok „wyślij e-mail”: wiersz planu maili z kluczem okazji reguły (drugi przebieg nic nie dokłada). */
async function wyslijEmail(db: Db, orderId: string, a: Extract<Krok, { typ: 'wyslijEmail' }>, k: KontekstWykonania): Promise<WynikKroku> {
  const krok = 'wyslijEmail' as const
  const o = await db.order.findUnique({ where: { id: orderId }, select: { id: true, channel: true, channelAccountId: true, externalId: true, totalGross: true, reservationDeadline: true, reminderSentAt: true, status: true } })
  if (!o) return { krok, wynik: 'POMINIETY', opis: 'nie ma zamówienia' }
  const { mode, numer } = await trybKonta(db, o)
  const vars: Record<string, string | number> = { numerZamowienia: numer(o.externalId), regula: k.regulaNazwa.slice(0, 80) }
  const s = SZABLONY_MAILI[a.szablon]
  if (a.szablon === 'brak-platnosci') {
    if (!o.reservationDeadline) return pominiety(db, orderId, k, krok, 'mail „Brak płatności” bez terminu anulowania jest niedozwolony (zamówienie opłacone albo bez terminu)')
    vars.terminAnulowania = o.reservationDeadline.toISOString()
    vars.kwotaGr = Math.round(Number(o.totalGross.toString()) * 100)
  }
  if (a.szablon === 'faktura') {
    const f = await db.invoiceAttempt.findFirst({ where: { orderId, state: 'ISSUED', wfirmaDocId: { not: null } }, orderBy: { updatedAt: 'desc' }, select: { wfirmaDocId: true } })
    if (!f) return pominiety(db, orderId, k, krok, 'mail „Faktura” bez wystawionej faktury')
    vars.wfirmaDocId = f.wfirmaDocId!
    if (await planWbudowany(db, orderId, a.szablon, o, `FV:${f.wfirmaDocId}`)) return pominiety(db, orderId, k, krok, POWOD_PLANU, true)
    // jedna „Faktura” na dokument także z reguł firmy: reguła „Wysłane, Odebrane → Faktura” przy „Odebrane” po
    // „Wysłane” (ręcznie albo ze śledzenia przesyłki) nie wysyła tej samej faktury drugi raz. Tylko wykonania ze
    // zdarzeń: przycisk reguły to ponowna wysyłka na żądanie i planuje mail przy każdym kliknięciu
    if (k.cicho && (await fakturaJuzZaplanowana(db, orderId, f.wfirmaDocId!))) return pominiety(db, orderId, k, krok, POWOD_TEJ_SAMEJ_FAKTURY, true)
  }
  if (a.szablon === 'blad-faktury') {
    const f = await db.invoiceAttempt.findFirst({ where: { orderId, state: 'FAILED' }, orderBy: { updatedAt: 'desc' }, select: { idExternal: true, lastError: true } })
    if (!f) return pominiety(db, orderId, k, krok, 'brak nieudanej faktury')
    vars.idExternal = f.idExternal
    // wbudowany plan wysyła ten mail dla każdej nieudanej próby poza limitem programu do faktur (ta ponowi się sama)
    if (!f.lastError?.startsWith(LIMIT_ERROR_PREFIX) && (await planWbudowanyFirmy(db))) return pominiety(db, orderId, k, krok, POWOD_PLANU, true)
    if (await planWbudowany(db, orderId, a.szablon, o, `proba:${f.idExternal}`)) return pominiety(db, orderId, k, krok, POWOD_PLANU, true)
  }
  if ((a.szablon === 'brak-platnosci' || a.szablon === 'gotowe-do-odbioru') && (await planWbudowany(db, orderId, a.szablon, o, null))) return pominiety(db, orderId, k, krok, POWOD_PLANU, true)
  const r = await db.plannedAction.createMany({
    data: [{ rule: s.regula, targetType: 'ZAMOWIENIE', targetId: orderId, occasion: `automat:${k.regulaId}:${k.okazja}`.slice(0, 190), mode, state: 'PLANNED', reason: mode === 'PRACA' ? `reguła „${k.regulaNazwa}”: czeka na wysyłkę pocztą firmy` : `reguła „${k.regulaNazwa}”: tylko plan („wysłałbym”), konto sklepu w podglądzie`, vars, dueAt: k.now, createdAt: k.now }],
    skipDuplicates: true,
  })
  const opis = mode === 'PRACA' ? `e-mail „${s.nazwa}” czeka na wysyłkę pocztą firmy` : `wysłałbym e-mail „${s.nazwa}” (konto sklepu w podglądzie)`
  if (r.count) await zapiszHistorie(db, orderId, k, { krok, szablon: a.szablon, tryb: mode, opis })
  return { krok, wynik: 'WYKONANY', opis: r.count ? opis : `e-mail „${s.nazwa}” już zaplanowany` }
}

async function utworzPrzesylkeKrok(db: Db, orderId: string, a: Extract<Krok, { typ: 'utworzPrzesylke' }>, k: KontekstWykonania): Promise<WynikKroku> {
  const krok = 'utworzPrzesylke' as const
  const { bramkaNadania, utworzPrzesylke } = await import('@/lib/wysylka/nadanie')
  const deps = { ...(k.deps ?? {}), env: k.env }
  const b = await bramkaNadania(db, orderId, deps)
  if (!b) return { krok, wynik: 'POMINIETY', opis: 'nie ma zamówienia' }
  if (b.powod) return pominiety(db, orderId, k, krok, b.powod)
  if (a.modul && b.regula?.adapterKey && b.regula.adapterKey !== a.modul) return pominiety(db, orderId, k, krok, `przewoźnik zamówienia nadaje modułem „${b.modul ?? b.regula.adapterKey}”, a reguła wskazuje inny`)
  if (a.gabaryt && b.gabaryty.length && !b.gabaryty.some((g) => g.kod === a.gabaryt)) return pominiety(db, orderId, k, krok, `gabaryt ${a.gabaryt} nie pasuje do przewoźnika zamówienia`)
  const w = await utworzPrzesylke(db, { orderId, gabaryt: a.gabaryt ?? null, userId: `automat:${k.regulaId}` }, deps)
  if (w.wynik === 'ODMOWA') return pominiety(db, orderId, k, krok, w.powod)
  if (w.wynik === 'BLAD') return { krok, wynik: 'BLAD', opis: w.powod }
  if (w.wynik === 'NIEJEDNOZNACZNA') return { krok, wynik: 'BLAD', opis: 'przewoźnik nie potwierdził przesyłki: sprawdź ją na karcie zamówienia' }
  return { krok, wynik: 'WYKONANY', opis: w.wynik === 'W_TOKU' ? 'przesyłka w trakcie tworzenia' : 'przesyłka utworzona' }
}

async function drukujEtykiete(db: Db, orderId: string, a: Extract<Krok, { typ: 'drukujEtykiete' }>, k: KontekstWykonania): Promise<WynikKroku> {
  const krok = 'drukujEtykiete' as const
  // odbiór osobisty nie ma przesyłki, a etykieta odbioru (do naklejenia na paczkę) idzie tym samym zleceniem
  // druku; tylko konto sklepu w trybie pracy, jak nadanie po „Spakowano” (w podglądzie paczki prowadzi dotychczasowy system)
  const o = await db.order.findUnique({ where: { id: orderId }, select: { carrier: true, status: true, channel: true, channelAccountId: true } })
  if (o?.carrier === 'OSOBISTY') {
    if (o.status === 'ANULOWANE') return pominiety(db, orderId, k, krok, 'zamówienie anulowane')
    let praca: boolean
    try {
      praca = pracaDostepna(await kontoZamowienia(db, o, k.env), k.env)
    } catch {
      praca = false
    }
    if (!praca) return pominiety(db, orderId, k, krok, 'etykieta odbioru osobistego tylko dla konta sklepu w trybie pracy', true)
  } else {
    const s = await db.shipment.findFirst({ where: { orderId, extraNo: 0, state: 'UTWORZONA' }, orderBy: { createdAt: 'desc' }, select: { id: true } })
    if (!s) return pominiety(db, orderId, k, krok, 'zamówienie nie ma utworzonej przesyłki')
  }
  const stan = a.stanowisko ?? (await db.printStation.findFirst({ where: { disabledAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true } }))?.id ?? null
  if (!stan) return pominiety(db, orderId, k, krok, 'brak stanowiska druku (Ustawienia → Wysyłka i druk → Druk)')
  const klucz = `automat-${k.regulaId}-${k.okazja}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64).padEnd(16, '0')
  if (k.deps?.druk) {
    const blad = await k.deps.druk(orderId, stan, klucz)
    return blad ? { krok, wynik: 'BLAD', opis: blad } : { krok, wynik: 'WYKONANY', opis: 'etykieta wysłana do druku' }
  }
  const { zlecZPanelu } = await import('@/lib/druk/panel')
  await zlecZPanelu(db, { userId: `automat:${k.regulaId}`, nazwa: `reguła ${k.regulaNazwa}`.slice(0, 60) }, { typ: 'etykieta', ids: [orderId], stationId: stan, klucz }, { now: k.now })
  return { krok, wynik: 'WYKONANY', opis: 'etykieta wysłana do druku' }
}

async function wystawFakture(db: Db, orderId: string, k: KontekstWykonania): Promise<WynikKroku> {
  const krok = 'wystawFakture' as const
  const ost = await db.invoiceAttempt.findFirst({ where: { orderId }, orderBy: { createdAt: 'desc' }, select: { state: true } })
  if (ost?.state === 'ISSUED') return { krok, wynik: 'WYKONANY', opis: 'faktura już wystawiona' }
  if (ost?.state === 'FAILED') {
    try {
      await ponowFaktureRecznie(db, orderId, { actorId: aktorAutomatu(k.lancuch + 1, k.regulaId), now: k.now })
      return { krok, wynik: 'WYKONANY', opis: 'nieudana faktura wróciła do kolejki faktur' }
    } catch (e) {
      return pominiety(db, orderId, k, krok, e instanceof Error ? e.message : String(e))
    }
  }
  if (ost) return { krok, wynik: 'WYKONANY', opis: 'faktura jest w drodze' }
  // nową fakturę wystawia rdzeń po spakowaniu (rezerwacje i ruch magazynu przed żądaniem), gdy firma ma to włączone
  return { krok, wynik: 'POMINIETY', opis: 'fakturę wystawia system po spakowaniu, gdy w Ustawienia → Dokumenty i faktury → Dokumenty sprzedaży jest włączone wystawianie' }
}

async function anulujFakture(db: Db, orderId: string): Promise<WynikKroku> {
  const ost = await db.invoiceAttempt.findFirst({ where: { orderId }, orderBy: { createdAt: 'desc' }, select: { state: true } })
  if (ost?.state === 'FAILED') return { krok: 'anulujFakture', wynik: 'WYKONANY', opis: 'nieudana faktura jest anulowana (towar wrócił do rezerwacji)' }
  return { krok: 'anulujFakture', wynik: 'POMINIETY', opis: 'reguła nie cofa wystawionej faktury (korekta: karta zamówienia)' }
}

async function oznacz(db: Db, orderId: string, a: Extract<Krok, { typ: 'oznacz' }>, k: KontekstWykonania): Promise<WynikKroku> {
  const o = await db.order.findUnique({ where: { id: orderId }, select: { flags: true } })
  if (!o) return { krok: 'oznacz', wynik: 'POMINIETY', opis: 'nie ma zamówienia' }
  await db.order.update({ where: { id: orderId }, data: { flags: mergeFlags(o, { gwiazdka: a.wartosc ? true : undefined }) } })
  await zapiszHistorie(db, orderId, k, { krok: 'oznacz', znacznik: a.znacznik, wartosc: a.wartosc })
  return { krok: 'oznacz', wynik: 'WYKONANY', opis: a.wartosc ? 'gwiazdka ustawiona' : 'gwiazdka zdjęta' }
}

async function anulujZamowienie(db: Db, orderId: string, k: KontekstWykonania): Promise<WynikKroku> {
  const krok = 'anulujZamowienie' as const
  // zawsze przez „ustaw status” (bramka trybu pracy, `opcjeStatusu`, `cancelOrder`); firma bez własnego statusu
  // anulowania dostaje etap rdzenia `RDZEN:ANULOWANE`
  const anul = k.statusy.find((s) => s.baseStatus === 'ANULOWANE' && s.active && !s.carriers.length)
  const w = await ustawStatusAutomatem(db, orderId, anul?.key ?? 'RDZEN:ANULOWANE', k)
  return { ...w, krok }
}

/** Kroki reguły po kolei; błąd kroku = wynik BLAD i następny krok. */
export async function wykonajKroki(db: Db, orderId: string, kroki: readonly Krok[], k: KontekstWykonania): Promise<WynikKroku[]> {
  const out: WynikKroku[] = []
  for (const a of kroki) {
    try {
      switch (a.typ) {
        case 'ustawStatus':
          out.push(await ustawStatusAutomatem(db, orderId, a.status, k))
          break
        case 'wyslijEmail':
          out.push(await wyslijEmail(db, orderId, a, k))
          break
        case 'utworzPrzesylke':
          out.push(await utworzPrzesylkeKrok(db, orderId, a, k))
          break
        case 'drukujEtykiete':
          out.push(await drukujEtykiete(db, orderId, a, k))
          break
        case 'wystawFakture':
          out.push(await wystawFakture(db, orderId, k))
          break
        case 'anulujFakture':
          out.push(await anulujFakture(db, orderId))
          break
        case 'oznacz':
          out.push(await oznacz(db, orderId, a, k))
          break
        case 'anulujZamowienie':
          out.push(await anulujZamowienie(db, orderId, k))
          break
      }
    } catch (e) {
      out.push({ krok: a.typ, wynik: 'BLAD', opis: `${KROKI[a.typ].nazwa}: ${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 200)}` })
    }
  }
  return out
}
