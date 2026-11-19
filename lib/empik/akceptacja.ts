// Przyjmowanie zamówień Empiku (Mirakl OR21; spec v1.5 T1b). Empik anuluje zamówienie, którego sprzedawca
// nie przyjmie w ciągu 5 dni; dotąd przyjmował je BaseLinker. Zadanie workera `empik-akceptacja` co minutę przegląda
// zamówienia, które ostatni odczyt dziennika widział w stanie WAITING_ACCEPTANCE (ChannelOrderSnapshot), i:
//   1. gdy każda pozycja ma rezerwację (albo jest bez stanu, np. e-book) — przyjmuje całość;
//   2. gdy pozycji w całości brakuje — wg ustawienia konta `akceptacjaBraki`: „odrzuc” = odrzuca tę pozycję
//      (rdzeń: rejectShortagesAtAcceptance), „czekaj” (domyślnie) = zostawia zamówienie do decyzji człowieka z alertem;
//   3. pozycja bez produktu, bez rezerwacji albo z brakiem części sztuk = zawsze do decyzji (Empik odrzuca tylko całą
//      pozycję; odrzucenie części sztuk zgubiłoby te zarezerwowane);
//   4. alert, gdy zamówienie czeka dłużej niż `akceptacjaAlertGodzin` (domyślnie 12 h) — także w podglądzie.
// Tryb: konto w PRACY (`statusMode = PRACA`) z adapterem zdolnym do `order.accept` przyjmuje naprawdę (adapter sam
// pilnuje wyłącznika `zapisWlaczony`); konto w cieniu zapisuje tylko zdarzenie „zaakceptowałbym” na karcie zamówienia,
// bez żadnego żądania do Empiku. Każde zamówienie osobno (błąd jednego nie zatrzymuje reszty), idempotentnie: decyzja
// raz na zamówienie (zdarzenie na karcie), powtórka po zgubionej odpowiedzi kończy się „już rozstrzygnięte”.
// Bez danych osobowych: w zdarzeniach i alertach tylko numery zamówień i pozycji.
import type { Prisma, PrismaClient } from '@prisma/client'
import { createAccountAdapter, loadChannelAccounts } from '../adaptery/konta'
import { type AdapterContext, alreadyDecidedState, type ChannelAdapter, hasOrderAcceptor, type OrderAcceptDecision, type OrderAcceptor } from '../adaptery/kontrakt'
import { CZESCIOWA_AKCEPTACJA_WYLACZONA, miraklStateLifecycle, ZAPIS_WYLACZONY } from '../adaptery/mirakl-empik'
import type { AdapterRegistry } from '../adaptery/rejestr'
import { executeWrite } from '../adaptery/zapis'
import { rejectShortagesAtAcceptance } from '../rdzen/brakuje'
import { alert } from '../rdzen/stan'
import type { SecretSource } from '../sekrety'
import type { FetchLike } from '../zrodla/http'

export { EMPIK_AKCEPTACJA_JOB } from './nazwy'

/** Zdarzenia na karcie zamówienia (etykiety w lib/panel/format.ts). */
export const EV_PODGLAD = 'EMPIK_ZAAKCEPTOWALBYM'
export const EV_PRZYJETE = 'EMPIK_PRZYJETE'
export const EV_DO_DECYZJI = 'EMPIK_PRZYJECIE_DO_DECYZJI'
export const EV_BLAD = 'EMPIK_PRZYJECIE_BLAD'
/** zamówienie w Empiku już anulowane albo odrzucone, zanim Kompletor je przyjął. */
export const EV_NIEAKTUALNE = 'EMPIK_PRZYJECIE_NIEAKTUALNE'
/** najwyżej tyle wywołań OR21 na konto w jednym przebiegu (przebieg co minutę). */
const MAX_OR21_NA_PRZEBIEG = 20
/** konto wstrzymane po 429 do chwili z Retry-After (pamięć procesu workera). */
const pauzaKonta = new Map<string, number>()
/**
 * Po odmowie Empiku (inny błąd niż wyłączona częściowa akceptacja) kolejna próba najwcześniej po 30 min.
 * każda kolejna identyczna odmowa z rzędu wydłuża odstęp (30 min, 2 h, 6 h, potem co 12 h),
 * żeby trwały błąd nie szedł do Empiku co pół godziny przez 5 dni. Inny komunikat = liczenie od nowa.
 */
export const ODSTEPY_PO_ODMOWIE_MS = [30 * 60_000, 2 * 3600_000, 6 * 3600_000, 12 * 3600_000] as const

/** Odstęp przed kolejną próbą po `identyczne` odmowach z tym samym komunikatem z rzędu (≥ 1). */
export function odstepPoOdmowie(identyczne: number): number {
  return ODSTEPY_PO_ODMOWIE_MS[Math.min(Math.max(identyczne, 1), ODSTEPY_PO_ODMOWIE_MS.length) - 1]!
}
/** Rodzaje alertów (lib/powiadomienia/grupy.ts). */
export const ALERT_CZEKA = 'EMPIK_PRZYJECIE_CZEKA'
export const ALERT_DECYZJA = 'EMPIK_PRZYJECIE_DECYZJA'
export const ALERT_BLAD = 'EMPIK_PRZYJECIE_BLAD'

const WAITING = 'WAITING_ACCEPTANCE'
const DOMYSLNIE_GODZIN = 12
const ACTOR = 'system:empik-akceptacja'

export interface UstawieniaAkceptacji {
  braki: 'czekaj' | 'odrzuc'
  alertGodzin: number
}

/** Ustawienia z konfiguracji konta; zła albo brakująca wartość = domyślna (czekaj, 12 h). */
export function ustawieniaAkceptacji(config: Record<string, unknown>): UstawieniaAkceptacji {
  const h = Number(config['akceptacjaAlertGodzin'])
  return {
    braki: config['akceptacjaBraki'] === 'odrzuc' ? 'odrzuc' : 'czekaj',
    alertGodzin: Number.isFinite(h) && h >= 1 && h <= 96 ? h : DOMYSLNIE_GODZIN,
  }
}

export interface PlanAkceptacji {
  /** Decyzja dla każdej pozycji; null = do decyzji człowieka (powód w `powod`). */
  decyzje: OrderAcceptDecision[] | null
  /** Id pozycji (OrderLine.id) do odrzucenia w rdzeniu po udanym OR21. */
  odrzucaneLinie: string[]
  powod: string | null
  /** Stan przejściowy (np. rezerwacja w drodze): bez zdarzenia i alertu, następny przebieg sprawdzi znowu. */
  chwilowe?: true
}

/**
 * Plan dla jednego zamówienia (czysty odczyt). Pozycja przyjęta = ma aktywną rezerwację i nie ma otwartego braku albo
 * jest bez stanu; pozycja w całości w „brakuje” (zero aktywnych rezerwacji) = odrzucenie przy regule „odrzuc”.
 */
export async function planAkceptacji(db: PrismaClient, orderId: string, u: UstawieniaAkceptacji): Promise<PlanAkceptacji> {
  const o = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      status: true,
      lines: { where: { removed: false }, select: { id: true, externalLineId: true, productId: true, qty: true } },
      reservations: { where: { state: 'ACTIVE' }, select: { orderLineId: true } },
      shortages: { where: { state: { in: ['OPEN', 'SHIP_LATER'] } }, select: { orderLineId: true, state: true } },
    },
  })
  const czekaj = (powod: string, chwilowe = false): PlanAkceptacji => ({ decyzje: null, odrzucaneLinie: [], powod, ...(chwilowe ? { chwilowe: true as const } : {}) })
  if (o.status === 'ANULOWANE') return czekaj('zamówienie anulowane w Kompletorze, a w Empiku dalej czeka na przyjęcie')
  if (!o.lines.length) return czekaj('zamówienie bez pozycji')
  const ids = [...new Set(o.lines.map((l) => l.productId).filter((p): p is string => !!p))]
  const kinds = new Map((await db.product.findMany({ where: { id: { in: ids } }, select: { id: true, kind: true } })).map((p) => [p.id, p.kind]))
  const reserved = new Set(o.reservations.map((r) => r.orderLineId))
  const short = new Set(o.shortages.filter((s) => s.state === 'OPEN').map((s) => s.orderLineId))
  const shipLater = new Set(o.shortages.filter((s) => s.state === 'SHIP_LATER').map((s) => s.orderLineId))
  const decyzje: OrderAcceptDecision[] = []
  const odrzucane: string[] = []
  for (const l of o.lines) {
    const pos = `pozycja ${l.externalLineId}`
    if (!l.productId) return czekaj(`${pos}: bez produktu w katalogu`)
    if (kinds.get(l.productId) === 'DIGITAL') {
      decyzje.push({ externalLineId: l.externalLineId, accepted: true })
      continue
    }
    // „wyślij później” to obietnica bez towaru; Empik przyjmuje albo odrzuca całą pozycję — decyzja człowieka
    if (shipLater.has(l.id)) return czekaj(`${pos}: brak oznaczony „wyślij później” (Empik przyjmie albo odrzuci całą pozycję)`)
    if (!short.has(l.id)) {
      if (!reserved.has(l.id)) return czekaj(`${pos}: jeszcze bez rezerwacji`, true)
      decyzje.push({ externalLineId: l.externalLineId, accepted: true })
      continue
    }
    if (reserved.has(l.id)) return czekaj(`${pos}: brakuje części sztuk (Empik odrzuca tylko całą pozycję)`)
    if (u.braki !== 'odrzuc') return czekaj(`${pos}: brak towaru`)
    decyzje.push({ externalLineId: l.externalLineId, accepted: false })
    odrzucane.push(l.id)
  }
  return { decyzje, odrzucaneLinie: odrzucane, powod: null }
}

export interface AcceptDeps {
  registry: AdapterRegistry
  secrets: SecretSource
  fetch?: FetchLike
  /** Limit wywołań OR21 na konto w przebiegu (domyślnie MAX_OR21_NA_PRZEBIEG; testy). */
  maxOr21?: number
  now?: () => Date
  /** Odstęp i ponowienia klienta HTTP adaptera (testy na atrapach: `{ minIntervalMs: 0 }`). */
  http?: AdapterContext['http']
}

export interface AcceptStats {
  czeka: number
  przyjete: number
  podglad: number
  doDecyzji: number
  odrzuconePozycje: number
  alerty: number
  ponowienie: number
  bledy: string[]
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300)

async function zdarzenieRaz(db: PrismaClient, orderId: string, kind: string, data: Prisma.InputJsonValue, now: Date): Promise<boolean> {
  if (await db.orderEvent.findFirst({ where: { orderId, kind }, select: { id: true } })) return false
  await db.orderEvent.create({ data: { orderId, kind, actorId: ACTOR, data, createdAt: now } })
  return true
}

/** Jeden przebieg dla wszystkich aktywnych kont Empiku firmy klienta `db`. Konto po koncie, zamówienie po zamówieniu. */
export async function runEmpikAcceptance(db: PrismaClient, deps: AcceptDeps): Promise<AcceptStats> {
  const now = (deps.now ?? (() => new Date()))()
  const s: AcceptStats = { czeka: 0, przyjete: 0, podglad: 0, doDecyzji: 0, odrzuconePozycje: 0, alerty: 0, ponowienie: 0, bledy: [] }
  // odrzucenia w rdzeniu po udanym OR21, które nie dokończyły się w poprzednim przebiegu
  for (const ev of await db.orderEvent.findMany({ where: { kind: EV_PRZYJETE, data: { path: ['dokonczone'], equals: false } }, select: { id: true, orderId: true, data: true } })) {
    try {
      s.odrzuconePozycje += await dokonczOdrzucenie(db, ev, now)
    } catch (e) {
      s.bledy.push(`odrzucenie w rdzeniu (zamówienie ${ev.orderId}): ${msg(e)}`)
    }
  }
  const modes = new Map((await db.channelConfig.findMany({ where: { channel: 'EMPIK', active: true }, select: { channelAccountId: true, statusMode: true } })).map((c) => [c.channelAccountId, c.statusMode]))
  for (const acc of (await loadChannelAccounts(db)).filter((a) => a.channel === 'EMPIK')) {
    try {
      await przebiegKonta(db, acc, modes.get(acc.channelAccountId) === 'PRACA', deps, now, s)
    } catch (e) {
      s.bledy.push(`EMPIK/${acc.channelAccountId}: ${msg(e)}`)
    }
  }
  return s
}

async function przebiegKonta(db: PrismaClient, acc: Awaited<ReturnType<typeof loadChannelAccounts>>[number], praca: boolean, deps: AcceptDeps, now: Date, s: AcceptStats): Promise<void> {
  const u = ustawieniaAkceptacji(acc.config)
  const snaps = await db.channelOrderSnapshot.findMany({
    where: { channel: 'EMPIK', channelAccountId: acc.channelAccountId, channelStatus: WAITING },
    orderBy: { createdAtChannel: 'asc' },
    take: 200,
    select: { externalId: true, orderId: true, createdAtChannel: true },
  })
  let adapter: (ChannelAdapter & OrderAcceptor) | null | undefined // undefined = jeszcze nie tworzony
  const konto = `EMPIK/${acc.channelAccountId}`
  const pauzaKlucz = `${acc.organizationId}:${acc.channelAccountId}`
  let wywolania = 0
  for (const snap of snaps) {
    s.czeka++
    const ref = `${konto}/${snap.externalId}`
    try {
      const godzin = (now.getTime() - snap.createdAtChannel.getTime()) / 3600_000
      if (godzin >= u.alertGodzin) {
        await alert(db, ALERT_CZEKA, ref, `Zamówienie Empik ${snap.externalId} czeka na przyjęcie ${Math.floor(godzin)} h (Empik anuluje po 5 dniach). Sprawdź kartę zamówienia.`, `empik-czeka:${ref}`)
        s.alerty++
      }
      if (!snap.orderId) continue // zamówienie nie weszło do Kompletora: błąd elementu jest w kopii, alert po czasie wyżej
      // decyzja już poszła albo zamówienie nieaktualne w Empiku: następny odczyt zdejmie stan
      if (await db.orderEvent.findFirst({ where: { orderId: snap.orderId, kind: { in: [EV_PRZYJETE, EV_NIEAKTUALNE] } }, select: { id: true } })) continue
      const plan = await planAkceptacji(db, snap.orderId, u)
      if (!plan.decyzje) {
        s.doDecyzji++
        if (!plan.chwilowe && (await zdarzenieRaz(db, snap.orderId, EV_DO_DECYZJI, { zamowienie: snap.externalId, powod: plan.powod }, now))) {
          await alert(db, ALERT_DECYZJA, ref, `Zamówienie Empik ${snap.externalId} czeka na Twoją decyzję o przyjęciu: ${plan.powod}.`, `empik-decyzja:${ref}`)
          s.alerty++
        }
        continue
      }
      const decyzje = plan.decyzje.map((d) => ({ pozycja: d.externalLineId, przyjeta: d.accepted }))
      if (adapter === undefined) adapter = praca ? await adapterKonta(db, acc, deps) : null
      if (!adapter) {
        if (await zdarzenieRaz(db, snap.orderId, EV_PODGLAD, { zamowienie: snap.externalId, decyzje, powod: praca ? 'adapter konta bez przyjmowania zamówień' : 'konto w podglądzie' }, now)) s.podglad++
        continue
      }
      // po odmowie Empiku: częściowa akceptacja wyłączona = koniec prób (decyzja w panelu Empiku), inny błąd = próba co 30 min
      const bledy = await db.orderEvent.findMany({ where: { orderId: snap.orderId, kind: EV_BLAD }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: ODSTEPY_PO_ODMOWIE_MS.length, select: { createdAt: true, data: true } })
      const blad = bledy[0]
      if (blad) {
        const d = (x: (typeof bledy)[number]) => (x.data ?? {}) as { czesciowa?: boolean; komunikat?: string }
        if (d(blad).czesciowa === true) continue
        let identyczne = 0
        while (identyczne < bledy.length && d(bledy[identyczne]!).komunikat === d(blad).komunikat) identyczne++
        if (now.getTime() - blad.createdAt.getTime() < odstepPoOdmowie(identyczne)) continue
      }
      if ((pauzaKonta.get(pauzaKlucz) ?? 0) > now.getTime() || wywolania >= (deps.maxOr21 ?? MAX_OR21_NA_PRZEBIEG)) {
        s.ponowienie++
        continue
      }
      wywolania++
      const reference = `empik-or21:${snap.orderId}`
      const out = await executeWrite(adapter, reference, () => adapter!.acceptOrder(snap.externalId, plan.decyzje!, reference))
      if (out.kind === 'TRWALY' && out.message === ZAPIS_WYLACZONY) {
        // konto w PRACY z wyłączonym zapisem: jak podgląd (nic nie wyszło), bez alertu co minutę
        if (await zdarzenieRaz(db, snap.orderId, EV_PODGLAD, { zamowienie: snap.externalId, decyzje, powod: 'zapis do Empiku wyłączony na koncie' }, now)) s.podglad++
        continue
      }
      if (out.kind === 'OK') {
        const stanKanalu = alreadyDecidedState(out.externalRef)
        if (stanKanalu && miraklStateLifecycle(stanKanalu) === 'CANCELLED') {
          // anulowane albo odrzucone w Empiku to nie „przyjęte”; anulowanie w rdzeniu robi odczyt dziennika
          await zdarzenieRaz(db, snap.orderId, EV_NIEAKTUALNE, { zamowienie: snap.externalId, powod: `w Empiku zamówienie jest już w stanie ${stanKanalu}` }, now)
          continue
        }
        // Gdy kanał miał już decyzję, stan pozycji ustala następny odczyt dziennika (nie zgadujemy, co odrzucono).
        // najpierw zdarzenie ze znacznikiem „do dokończenia”, potem odrzucenie w rdzeniu i zdjęcie
        // znacznika; przerwane odrzucenie dokończy następny przebieg, także gdy kopia wyszła już ze stanu czekania.
        const doOdrzucenia = !stanKanalu && plan.odrzucaneLinie.length > 0
        const ev = await db.orderEvent.create({
          data: {
            orderId: snap.orderId,
            kind: EV_PRZYJETE,
            actorId: ACTOR,
            createdAt: now,
            data: { zamowienie: snap.externalId, decyzje, juzRozstrzygniete: !!stanKanalu, ...(stanKanalu ? { stanKanalu } : {}), ...(doOdrzucenia ? { dokonczone: false } : {}) },
          },
          select: { id: true, orderId: true, data: true },
        })
        s.przyjete++
        if (doOdrzucenia) s.odrzuconePozycje += await dokonczOdrzucenie(db, ev, now)
        continue
      }
      if (out.kind === 'PRZEJSCIOWY') {
        s.ponowienie++ // następny przebieg za minutę; po czasie i tak alert „czeka”
        if (out.retryAfterMs) {
          // limit Empiku — konto czeka do Retry-After, reszta zamówień w kolejnym przebiegu
          pauzaKonta.set(pauzaKlucz, now.getTime() + out.retryAfterMs)
          break
        }
        continue
      }
      const czesciowa = out.message.startsWith(CZESCIOWA_AKCEPTACJA_WYLACZONA)
      const tekst = czesciowa
        ? `Zamówienie Empik ${snap.externalId}: Empik nie pozwala odrzucić pojedynczej pozycji (częściowa akceptacja wyłączona). Zdecyduj: przyjąć całość czy odrzucić zamówienie.`
        : `Zamówienie Empik ${snap.externalId}: przyjęcie nie przeszło (${out.message}). Sprawdź konto Empik i kartę zamówienia.`
      await alert(db, czesciowa ? ALERT_DECYZJA : ALERT_BLAD, ref, tekst, `empik-blad:${ref}`)
      s.alerty++
      await db.orderEvent.create({ data: { orderId: snap.orderId, kind: EV_BLAD, actorId: ACTOR, createdAt: now, data: { zamowienie: snap.externalId, decyzje, wynik: out.kind, komunikat: out.message.slice(0, 300), czesciowa } } })
      if (!czesciowa) s.bledy.push(`${ref}: ${out.kind} ${out.message.slice(0, 200)}`)
    } catch (e) {
      s.bledy.push(`${ref}: ${msg(e)}`)
    }
  }
}

/** Odrzucenie pozycji w rdzeniu po udanym OR21 i zdjęcie znacznika „do dokończenia” (idempotentne: brak otwartych braków = 0). */
async function dokonczOdrzucenie(db: PrismaClient, ev: { id: string; orderId: string; data: Prisma.JsonValue }, now: Date): Promise<number> {
  const n = await rejectShortagesAtAcceptance(db, ev.orderId, { now })
  const data = ev.data && typeof ev.data === 'object' && !Array.isArray(ev.data) ? (ev.data as Prisma.JsonObject) : {}
  await db.orderEvent.update({ where: { id: ev.id }, data: { data: { ...data, dokonczone: true } } })
  return n
}

/** Tylko testy: wyczyść pauzy kont po 429. */
export function wyczyscPauzyKont(): void {
  pauzaKonta.clear()
}

/** Adapter konta zdolny do przyjmowania zamówień albo null (adapter tylko do odczytu). Zła konfiguracja = wyjątek. */
async function adapterKonta(db: PrismaClient, acc: Awaited<ReturnType<typeof loadChannelAccounts>>[number], deps: AcceptDeps): Promise<(ChannelAdapter & OrderAcceptor) | null> {
  const a = await createAccountAdapter(db, deps.registry, acc, deps.secrets, { ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.now ? { now: deps.now } : {}), ...(deps.http ? { http: deps.http } : {}) })
  return hasOrderAcceptor(a) ? a : null
}
