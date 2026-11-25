// Silnik planu akcji. Reguły poziomowe: patrzą na bieżący stan (Order.status, płatność, InvoiceAttempt,
// ruchy faktur BL, stan produktu), nie na nazwy zdarzeń innych zadań — działają tak samo bez względu na to, która
// funkcja rdzenia (albo ekran) zmieniła stan. Idempotencja: unikalny klucz (firma, reguła, cel, okazja),
// zapis `createMany` z `skipDuplicates`, więc drugi przebieg nic nie dokłada, także przy dwóch workerach naraz.
//
// Nic nie jest wysyłane: w trybie SUCHO (cień konta) plan to zapis „wysłałbym”, w trybie PRACA plan czeka na
// wysyłkę, której tu nie ma (transport maili i GO właściciela to osobne zadanie). Zmienne planu bez danych osobowych.
import type { ActionMode, ActionState, ActionTarget, Channel, OrderStatus, Prisma, PrismaClient } from '@prisma/client'
import { blStatusFamily, type BlFamily } from '../cien/bl-porownanie'
import { organizationIdOf } from '../db'
import { accountDisplayName, channelPrefix } from '../panel/format'
import { getPolicy } from '../rdzen/polityka'
import { LIMIT_ERROR_PREFIX } from '../rdzen/rozchod'
import { availableOf } from '../rdzen/stan'
import { type KluczReguly, OKNO_MS, POWOD_PRACA, POWOD_SUCHO, WYNIKI_FAKTURY_BL } from './reguly'
import { BEZ_ZAMKNIETYCH_PRZY_PRZEJSCIU } from '../kanaly/zamkniete-przy-przejsciu'
import { maileZwrotowOd, REGULY_ZWROTOW } from './maile-zwrotow'
import { brakiDanychPrzelewu, danePrzelewu, informacjaBezDanychPrzelewu, wariantPrzypomnienia } from './wariant-platnosci'

// wyłącznik maili o zwrotach mieszka w module bez zależności (wysyłka i ekrany importują go bez silnika)
export { maileZwrotowFirmy, maileZwrotowOd, maileZwrotowWlaczone, REGULY_ZWROTOW } from './maile-zwrotow'

type Db = PrismaClient

export interface Kandydat {
  rule: KluczReguly
  targetType: ActionTarget
  targetId: string
  occasion: string
  mode: ActionMode
  state: ActionState
  reason: string
  vars: Prisma.InputJsonObject
  dueAt: Date
}

export interface WynikPlanu {
  /** Nowe wiersze planu per reguła (drugi przebieg: same zera). */
  nowe: Partial<Record<KluczReguly, number>>
  /** Produkty, którym zamknięto przejście poniżej progu (stan wrócił powyżej progu albo próg zdjęty). */
  powrotyPowyzejProgu: number
}

export interface CtxPlanu {
  now?: Date
}

/** Konta kanałów firmy: tryb statusów (CIEN → SUCHO) i przedrostek numeru zamówienia. */
interface Konta {
  tryb(channel: Channel, channelAccountId: string): ActionMode
  /** Konto jawnie w cieniu (`statusMode = CIEN`): status zamówienia z kopii BL. */
  cien(channel: Channel, channelAccountId: string): boolean
  /** Numer, jaki zna klient: numer ze sklepu (`channelNumber`), a bez niego id w kanale. */
  numer(o: { channel: Channel; channelAccountId: string; externalId: string; channelNumber?: string | null }): string
}

async function konta(db: Db): Promise<Konta> {
  const rows = await db.channelConfig.findMany({ select: { channel: true, channelAccountId: true, name: true, config: true, statusMode: true } })
  const by = new Map(rows.map((r) => [`${r.channel}:${r.channelAccountId}`, r]))
  return {
    // konto bez konfiguracji (np. ręczne, EasyTools) = cień: nic nie wychodzi bez jawnego GO
    tryb: (ch, acc) => (by.get(`${ch}:${acc}`)?.statusMode === 'PRACA' ? 'PRACA' : 'SUCHO'),
    cien: (ch, acc) => by.get(`${ch}:${acc}`)?.statusMode === 'CIEN',
    numer: (o) => {
      const r = by.get(`${o.channel}:${o.channelAccountId}`)
      return `${channelPrefix(o.channel, accountDisplayName(o.channel, o.channelAccountId, r?.name, r?.config))} ${o.channelNumber?.trim() || o.externalId}`
    },
  }
}

const powod = (mode: ActionMode) => (mode === 'PRACA' ? POWOD_PRACA : POWOD_SUCHO)

/** Tryb akcji produktowych: `Organization.settings.akcje.trybProduktow` = „PRACA”, inaczej SUCHO. */
export function trybProduktow(settings: Prisma.JsonValue | null | undefined): ActionMode {
  const s = settings && typeof settings === 'object' && !Array.isArray(settings) ? (settings as Record<string, unknown>) : {}
  const a = s['akcje'] && typeof s['akcje'] === 'object' ? (s['akcje'] as Record<string, unknown>) : {}
  return a['trybProduktow'] === 'PRACA' ? 'PRACA' : 'SUCHO'
}

/**
 * czy wbudowany plan maili do zamówień (Brak płatności, Faktura, Błąd faktury, Gotowe do odbioru) działa dla
 * firmy: `Organization.settings.akcje.planWbudowany` = false wyłącza go, wtedy te maile planują wyłącznie reguły
 * automatycznych akcji (Ustawienia → Automatyczne akcje). Domyślnie włączony (firma bez ustawienia: bez zmian).
 * „Niski stan” (mail do biura o produkcie) działa zawsze.
 */
export function planWbudowanyWlaczony(settings: Prisma.JsonValue | null | undefined): boolean {
  const s = settings && typeof settings === 'object' && !Array.isArray(settings) ? (settings as Record<string, unknown>) : {}
  const a = s['akcje'] && typeof s['akcje'] === 'object' ? (s['akcje'] as Record<string, unknown>) : {}
  return a['planWbudowany'] !== false
}

/** Czy plan wbudowany działa dla firmy klienta `db` (jedno zapytanie). */
export async function planWbudowanyFirmy(db: Db): Promise<boolean> {
  const org = await db.organization.findFirst({ select: { settings: true } })
  return planWbudowanyWlaczony(org?.settings)
}

const gr = (v: { toString(): string }) => Math.round(Number(v.toString()) * 100)

// ─── Reguły zamówień ─────────────────────────────────────────────────────────

/**
 * (12) „Brak płatności”. Termin przypomnienia liczy i zapisuje rdzeń (`runReservationExpiry`: `Order.reminderSentAt`);
 * reguła tylko odnotowuje plan maila na tej podstawie. Kontrakt: zmienne zawsze z `terminAnulowania`
 * = `Order.reservationDeadline` — bez daty planu nie ma (SKIPPED), nigdy wariant „w ciągu N dni roboczych”.
 * Po nieudanej płatności online ten sam plan niesie mail „Nieudana płatność online” (`wariant`, przypomnienie
 * zwykle następnego dnia rano, `failedOnlineRemindAt`). Bez danych do przelewu w Danych firmy (rachunek, pełna nazwa)
 * klient dostaje zwykły „Brak płatności” (plan bez `wariant`), a powód planu mówi biuru, czego brakuje.
 * Wysyłka i podgląd liczą wariant drugi raz ze stanu zamówienia (`wariant-platnosci.ts`).
 */
async function brakPlatnosci(db: Db, k: Konta, now: Date): Promise<Kandydat[]> {
  const orders = await db.order.findMany({
    // zamknięte przy przejściu z BaseLinkera: płatność i przypomnienie prowadził BaseLinker
    where: { reminderSentAt: { not: null, gte: new Date(now.getTime() - OKNO_MS) }, ...BEZ_ZAMKNIETYCH_PRZY_PRZEJSCIU },
    select: { id: true, channel: true, channelAccountId: true, externalId: true, channelNumber: true, totalGross: true, reminderSentAt: true, reservationDeadline: true, termsSeasonMode: true, flags: true, paymentState: true },
  })
  if (!orders.length) return []
  const p = await getPolicy(db)
  const settings = orders.some((o) => wariantPrzypomnienia(o) === 'nieudana-platnosc') ? (await db.organization.findFirst({ select: { settings: true } }))?.settings : undefined
  const przelew = danePrzelewu(settings)
  return orders.map((o): Kandydat => {
    const mode = k.tryb(o.channel, o.channelAccountId)
    // dni z bieżącej polityki, a reservationDeadline z polityki z chwili przyjęcia — po zmianie polityki mogą się
    // rozjechać; nieszkodliwe, bo z datą szablon renderuje „do <data>”, a dniDoAnulowania zostaje tylko informacyjnie
    const dni = (o.termsSeasonMode ?? p.seasonMode) ? p.seasonReleaseBusinessDays : p.normalReleaseBusinessDays
    const base = { rule: 'mail.brak-platnosci' as const, targetType: 'ZAMOWIENIE' as const, targetId: o.id, occasion: 'PRZYPOMNIENIE', mode, dueAt: o.reminderSentAt! }
    if (!o.reservationDeadline)
      return { ...base, state: 'SKIPPED', reason: 'brak terminu anulowania (zamówienie opłacone albo anulowane przed planem) — mail bez daty niedozwolony', vars: { numerZamowienia: k.numer(o) } }
    const vars = { numerZamowienia: k.numer(o), kwotaGr: gr(o.totalGross), terminAnulowania: o.reservationDeadline.toISOString(), dniDoAnulowania: dni }
    if (wariantPrzypomnienia(o) === 'nieudana-platnosc') {
      if (!przelew) return { ...base, state: 'PLANNED', reason: `${powod(mode)}; ${informacjaBezDanychPrzelewu(brakiDanychPrzelewu(settings))}`, vars }
      return { ...base, state: 'PLANNED', reason: powod(mode), vars: { ...vars, wariant: 'nieudana-platnosc' } }
    }
    return { ...base, state: 'PLANNED', reason: powod(mode), vars }
  })
}

const ZAMOWIENIE_SEL = { id: true, channel: true, channelAccountId: true, externalId: true, channelNumber: true, status: true, updatedAt: true, blOrderId: true } as const
type ZamowienieReguly = { id: string; channel: Channel; channelAccountId: string; externalId: string; channelNumber: string | null; status: OrderStatus; updatedAt: Date; blOrderId: number | null }

/**
 * Status BL zamówień kont w cieniu: rodzina statusu z kopii nagłówka BL (`BlOrderSnapshot.statusName`,
 * mapa `blStatusFamily`), chwila odczytu tej kopii i chwila zmiany statusu z dziennika BL. W cieniu
 * `Order.status` nie idzie dalej niż „Do realizacji” (pakuje i wysyła BL), więc dla reguł statusowych źródłem jest
 * BL. Zamówienie bez kopii (niesparowane, firma bez BL, kopia bez nazwy statusu) nie ma wpisu — wtedy reguła patrzy
 * na `Order.status` jak w pracy.
 *
 * `zmiana` = `statusChangedAt` tylko, gdy zdarzenie dziennika dotyczy bieżącego statusu kopii
 * (`statusChangedToId === statusId`); inaczej getOrders odczytał nowszy status i chwili nie znamy (null).
 */
type StatusBl = { family: BlFamily; fetchedAt: Date; zmiana: Date | null }
async function statusyBl(db: Db, k: Konta, orders: ZamowienieReguly[]): Promise<Map<string, StatusBl>> {
  const cien = orders.filter((o) => o.blOrderId !== null && k.cien(o.channel, o.channelAccountId))
  if (!cien.length) return new Map()
  const snaps = await db.blOrderSnapshot.findMany({
    where: { organizationId: organizationIdOf(db), blOrderId: { in: cien.map((o) => o.blOrderId!) }, statusName: { not: null } },
    select: { blOrderId: true, statusId: true, statusName: true, fetchedAt: true, statusChangedAt: true, statusChangedToId: true },
  })
  const by = new Map(snaps.map((s) => [s.blOrderId, s]))
  const out = new Map<string, StatusBl>()
  for (const o of cien) {
    const s = by.get(o.blOrderId!)
    if (s) out.set(o.id, { family: blStatusFamily(s.statusName!).family, fetchedAt: s.fetchedAt, zmiana: s.statusChangedToId === s.statusId ? s.statusChangedAt : null })
  }
  return out
}

const WYSYLKA: readonly OrderStatus[] = ['WYSLANE', 'ODEBRANE']

/**
 * Zamówienie zamknięte punktem cięcia przy przejściu z BaseLinkera (lib/kanaly/punkt-ciecia.ts) dostało status
 * „Wysłane”/„Odebrane” bez wysyłki z Kompletora: mail o fakturze i odbiorze wysłał już BaseLinker, więc reguły statusowe
 * go nie biorą (inaczej po włączeniu trybu pracy klient dostałby drugi mail). Wykluczenie maili jest trwałe, także po
 * późniejszej zmianie statusu w Kompletorze (inaczej niż zapis statusu do sklepu i reguły czasowe automatów): okazją
 * „Faktury” jest dokument, a jedyny dokument takiego zamówienia to faktura BL (zamknięcie wymaga braku faktury
 * z Kompletora), więc ręczne „Odebrane” po „Wysłane” dałoby drugi mail o tej samej fakturze; „Do odbioru” takie
 * zamówienie ma tylko z cięcia, a „Brak płatności” dotyczy nieopłaconych sprzed przejścia, które obsłużył BaseLinker.
 */
const wyslane = (s: BlFamily) => (WYSYLKA as readonly BlFamily[]).includes(s)

/**
 * (10) „Faktura” przy Wysłane / Odebrane — tylko z wystawioną fakturą: nasza (`InvoiceAttempt` ISSUED) albo w cieniu
 * faktura BL (ruch `BL_INVOICE` z numerem dokumentu). Okazja = dokument, więc Odebrane po Wysłane nie dubluje maila.
 * Bez faktury → nic.
 *
 * Konto w cieniu: status z kopii BL (`statusyBl`), a faktura także z kopii faktur BL (`BlInvoiceSnapshot`
 * `kind = normal` z wynikiem z `WYNIKI_FAKTURY_BL`) — łapie `NIC_DO_ROZLICZENIA`, które ruchu `BL_INVOICE` nie
 * tworzy. Numer dokumentu jak w ruchu (`externalNumber ?? number`), więc ruch i kopia tej samej faktury to jedna
 * okazja. Okno po dacie faktury, nie po `Order.updatedAt` (w cieniu podbija je parowanie z BL, a faktura może przyjść
 * po tygodniu bez zmian zamówienia); `dueAt` = chwila faktury, a gdy dziennik BL zna chwilę bieżącego statusu —
 * później z (faktura, „Wysłane”).
 *
 * Bezpiecznik: kopia faktury w oknie także po chwili rozliczenia przez cień (`appliedAt`), nie tylko po dacie
 * faktury — faktura z 1.11 rozliczona 9.11 (wysyłka po ponad 7 dniach) dalej daje plan.
 */
async function faktura(db: Db, k: Konta, now: Date): Promise<Kandydat[]> {
  const od = new Date(now.getTime() - OKNO_MS)
  const [poStatusie, kopieFaktur] = await Promise.all([
    db.order.findMany({ where: { status: { in: [...WYSYLKA] }, updatedAt: { gte: od }, ...BEZ_ZAMKNIETYCH_PRZY_PRZEJSCIU }, select: ZAMOWIENIE_SEL }),
    db.blInvoiceSnapshot.findMany({
      where: { AND: [{ OR: [{ kind: 'normal' }, { kind: null }] }, { OR: [{ dateAdd: { gte: od } }, { appliedAt: { gte: od } }] }], orderId: { not: null }, outcome: { in: [...WYNIKI_FAKTURY_BL] } },
      select: { orderId: true, number: true, externalNumber: true, dateAdd: true },
    }),
  ])
  const znane = new Set(poStatusie.map((o) => o.id))
  const brakujace = [...new Set(kopieFaktur.map((f) => f.orderId!))].filter((id) => !znane.has(id))
  // zamówienia spoza okna `updatedAt` tylko z kont w cieniu: konto w pracy bez zmian; zamknięte punktem cięcia też nie
  // (kopia faktury BL w oknie dawała plan zamówieniu zamkniętemu na koncie w podglądzie)
  const zFaktur = brakujace.length ? (await db.order.findMany({ where: { id: { in: brakujace }, ...BEZ_ZAMKNIETYCH_PRZY_PRZEJSCIU }, select: ZAMOWIENIE_SEL })).filter((o) => k.cien(o.channel, o.channelAccountId)) : []
  const kandydaci = [...poStatusie, ...zFaktur]
  if (!kandydaci.length) return []
  const bl = await statusyBl(db, k, kandydaci)
  const orders = kandydaci.filter((o) => wyslane(bl.get(o.id)?.family ?? o.status))
  if (!orders.length) return []
  const ids = orders.map((o) => o.id)
  const [own, ruchy] = await Promise.all([
    db.invoiceAttempt.findMany({ where: { orderId: { in: ids }, state: 'ISSUED', wfirmaDocId: { not: null } }, select: { orderId: true, wfirmaDocId: true, updatedAt: true } }),
    db.pendingMovement.findMany({ where: { orderId: { in: ids }, type: 'BL_INVOICE', wfirmaDocId: { not: null } }, select: { orderId: true, wfirmaDocId: true, effectiveAt: true, createdAt: true } }),
  ])
  const byId = new Map(orders.map((o) => [o.id, o]))
  const docs = new Map<string, { orderId: string; docId: string; at: Date }>()
  for (const a of own) docs.set(`${a.orderId}|${a.wfirmaDocId}`, { orderId: a.orderId, docId: a.wfirmaDocId!, at: a.updatedAt })
  for (const m of ruchy) if (m.orderId) docs.set(`${m.orderId}|${m.wfirmaDocId}`, { orderId: m.orderId, docId: m.wfirmaDocId!, at: m.effectiveAt ?? m.createdAt })
  // kopia faktury BL na końcu: przy ruchu tej samej faktury chwilą jest data faktury w BL, nie chwila rozliczenia
  for (const f of kopieFaktur) {
    const o = byId.get(f.orderId!)
    if (!o || !k.cien(o.channel, o.channelAccountId)) continue
    const docId = f.externalNumber ?? f.number
    docs.set(`${o.id}|${docId}`, { orderId: o.id, docId, at: f.dateAdd })
  }
  return [...docs.values()].map((d): Kandydat => {
    const o = byId.get(d.orderId)!
    const mode = k.tryb(o.channel, o.channelAccountId)
    // chwila, gdy mail by wyszedł: później z (faktura, zmiana statusu), nie później niż teraz — zaległość z okna
    // (pierwszy przebieg, przestój workera) ląduje w swoim dniu, nie w „dziś”. W cieniu `Order.updatedAt` nie jest
    // chwilą statusu (podbija je parowanie z BL): chwila statusu z dziennika BL, a bez niej sama
    // chwila faktury.
    const zmiana = bl.get(o.id)?.zmiana
    const at = k.cien(o.channel, o.channelAccountId) ? Math.max(d.at.getTime(), zmiana?.getTime() ?? 0) : Math.max(d.at.getTime(), o.updatedAt.getTime())
    return {
      rule: 'mail.faktura',
      targetType: 'ZAMOWIENIE',
      targetId: o.id,
      occasion: `FV:${d.docId}`,
      mode,
      state: 'PLANNED',
      reason: powod(mode),
      vars: { numerZamowienia: k.numer(o), wfirmaDocId: d.docId },
      dueAt: new Date(Math.min(now.getTime(), at)),
    }
  })
}

/**
 * (11) „Błąd przy wystawianiu faktury” — do biura, jedna akcja na nieudaną próbę (`InvoiceAttempt` FAILED bez limitu wFirmy; to samo
 * zapisuje rdzeń jako zdarzenie FAKTURA_BLAD). Gdy kolejna próba tej paczki już się udała, zanim plan powstał —
 * SKIPPED. Treść błędu wFirmy nie trafia do planu (może zawierać dane kontrahenta).
 */
async function bladFaktury(db: Db, k: Konta, now: Date): Promise<Kandydat[]> {
  const failed = await db.invoiceAttempt.findMany({
    // próba odrzucona limitem wFirmy (prefiks LIMIT:) to nie błąd faktury — ponowi się sama, bez maila
    where: { state: 'FAILED', updatedAt: { gte: new Date(now.getTime() - OKNO_MS) }, OR: [{ lastError: null }, { NOT: { lastError: { startsWith: LIMIT_ERROR_PREFIX } } }] },
    select: { orderId: true, packageNo: true, idExternal: true, updatedAt: true, order: { select: { id: true, channel: true, channelAccountId: true, externalId: true, channelNumber: true } } },
  })
  if (!failed.length) return []
  const issued = await db.invoiceAttempt.findMany({ where: { orderId: { in: failed.map((f) => f.orderId) }, state: 'ISSUED' }, select: { orderId: true, packageNo: true } })
  const ok = new Set(issued.map((i) => `${i.orderId}/${i.packageNo}`))
  return failed.map((f): Kandydat => {
    const mode = k.tryb(f.order.channel, f.order.channelAccountId)
    const later = ok.has(`${f.orderId}/${f.packageNo}`)
    return {
      rule: 'mail.blad-faktury',
      targetType: 'ZAMOWIENIE',
      targetId: f.orderId,
      occasion: `proba:${f.idExternal}`,
      mode,
      state: later ? 'SKIPPED' : 'PLANNED',
      reason: later ? 'faktura wystawiona w kolejnej próbie przed planem' : powod(mode),
      vars: { numerZamowienia: k.numer(f.order), idExternal: f.idExternal, adresat: 'biuro', kiedy: f.updatedAt.toISOString() },
      dueAt: f.updatedAt,
    }
  })
}

/**
 * (14) „Gotowe do odbioru” przy statusie Do odbioru — jeden mail na zamówienie.
 *
 * Konto w cieniu: status z kopii BL. `dueAt` = chwila zmiany statusu z dziennika BL, a gdy
 * jej nie znamy — chwila odczytu kopii (`fetchedAt`) w pierwszym przebiegu planu, który zobaczył „Do odbioru”. Plan
 * zapisuje się raz (`skipDuplicates`), więc ta chwila zostaje w `PlannedAction`. Dokładność bez dziennika: odstęp
 * porównania z BL (10 min).
 */
async function gotoweDoOdbioru(db: Db, k: Konta, now: Date): Promise<Kandydat[]> {
  const od = new Date(now.getTime() - OKNO_MS)
  const [poStatusie, statusyKopii] = await Promise.all([
    db.order.findMany({ where: { status: 'DO_ODBIORU', updatedAt: { gte: od }, ...BEZ_ZAMKNIETYCH_PRZY_PRZEJSCIU }, select: ZAMOWIENIE_SEL }),
    db.blOrderSnapshot.groupBy({ by: ['statusId', 'statusName'], where: { organizationId: organizationIdOf(db), fetchedAt: { gte: od }, statusName: { not: null } } }),
  ])
  const doOdbioru = statusyKopii.filter((s) => blStatusFamily(s.statusName!).family === 'DO_ODBIORU').map((s) => s.statusId)
  const kopie = doOdbioru.length ? await db.blOrderSnapshot.findMany({ where: { organizationId: organizationIdOf(db), statusId: { in: doOdbioru }, fetchedAt: { gte: od } }, select: { blOrderId: true } }) : []
  const zKopii = kopie.length
    ? (await db.order.findMany({ where: { blOrderId: { in: kopie.map((s) => s.blOrderId) }, id: { notIn: poStatusie.map((o) => o.id) }, ...BEZ_ZAMKNIETYCH_PRZY_PRZEJSCIU }, select: ZAMOWIENIE_SEL })).filter((o) => k.cien(o.channel, o.channelAccountId))
    : []
  const kandydaci = [...poStatusie, ...zKopii]
  if (!kandydaci.length) return []
  const bl = await statusyBl(db, k, kandydaci)
  // dueAt = chwila przejścia do Do odbioru (ostatnia zmiana zamówienia; w cieniu chwila z dziennika BL albo odczyt
  // kopii BL), nie chwila przebiegu — patrz `faktura`
  return kandydaci.flatMap((o): Kandydat[] => {
    const s = bl.get(o.id)
    if ((s?.family ?? o.status) !== 'DO_ODBIORU') return []
    const mode = k.tryb(o.channel, o.channelAccountId)
    const at = s ? (s.zmiana ?? s.fetchedAt) : o.updatedAt
    return [{ rule: 'mail.gotowe-do-odbioru', targetType: 'ZAMOWIENIE', targetId: o.id, occasion: 'DO_ODBIORU', mode, state: 'PLANNED', reason: powod(mode), vars: { numerZamowienia: k.numer(o) }, dueAt: new Date(Math.min(now.getTime(), at.getTime())) }]
  })
}

// ─── Zwroty i reklamacje ─────────────────────────────────────────────────────

/**
 * Maile o zwrotach — poziomowo, ze stanu zwrotu (nie z nazw zdarzeń): paczka odebrana (`Return.receivedAt`) daje
 * „Zwrot dotarł” albo „Reklamacja dotarła” (zależnie od rodzaju), oznaczony zwrot pieniędzy (`Return.moneyRefundedAt`)
 * daje „Pieniądze zwrócone”. Okazja = id zwrotu, więc jeden mail na zwrot i zdarzenie, także przy kilku zwrotach jednego
 * zamówienia. Korekta bez przesyłki (KOREKTA) i zwrot odrzucony nie dostają maila. Zwrot z już zapisanym zwrotem
 * pieniędzy nie dostaje „dotarł” (klient dostaje od razu „Pieniądze zwrócone”, nie dwa maile naraz).
 * Okno: od późniejszej z chwil „7 dni temu” i „włączenie maili o zwrotach”, więc włączenie (także ponowne po
 * wyłączeniu) nie planuje maili o zwrotach odebranych wcześniej.
 */
async function zwroty(db: Db, k: Konta, now: Date, wlaczoneOd: Date): Promise<Map<KluczReguly, Kandydat[]>> {
  const od = new Date(Math.max(now.getTime() - OKNO_MS, wlaczoneOd.getTime()))
  const rows = await db.return.findMany({
    where: { kind: { in: ['ZWROT', 'REKLAMACJA'] }, status: { not: 'ODRZUCONY' }, OR: [{ receivedAt: { gte: od } }, { moneyRefundedAt: { gte: od } }] },
    select: { id: true, kind: true, receivedAt: true, moneyRefundedAt: true, order: { select: { id: true, channel: true, channelAccountId: true, externalId: true } } },
  })
  const out = new Map<KluczReguly, Kandydat[]>(REGULY_ZWROTOW.map((r) => [r, []]))
  for (const r of rows) {
    const mode = k.tryb(r.order.channel, r.order.channelAccountId)
    const base = { targetType: 'ZAMOWIENIE' as const, targetId: r.order.id, mode, state: 'PLANNED' as const, reason: powod(mode), vars: { numerZamowienia: k.numer(r.order), returnId: r.id } }
    if (r.receivedAt && r.receivedAt >= od && !r.moneyRefundedAt) {
      const rule = r.kind === 'REKLAMACJA' ? 'mail.reklamacja-przyjeta' : 'mail.zwrot-przyjety'
      out.get(rule)!.push({ ...base, rule, occasion: `zwrot:${r.id}`, dueAt: new Date(Math.min(now.getTime(), r.receivedAt.getTime())) })
    }
    if (r.moneyRefundedAt && r.moneyRefundedAt >= od)
      out.get('mail.zwrot-pieniedzy')!.push({ ...base, rule: 'mail.zwrot-pieniedzy', occasion: `pieniadze:${r.id}`, dueAt: new Date(Math.min(now.getTime(), r.moneyRefundedAt.getTime())) })
  }
  return out
}

// ─── Reguła produktów ────────────────────────────────────────────────────────

/**
 * (P2) Niski stan z histerezą: dostępne < `Product.lowStockThreshold` → jeden plan na przejście poniżej progu
 * (okazja „ponizej:<n>”). Otwarte przejście (`resolvedAt` puste) zamyka dopiero powrót powyżej progu (dostępne >
 * próg); równe progowi niczego nie zmienia. Produkt bez wiersza stanu (stan nieznany) jest pomijany — brak danych
 * to nie zero. Adresat: biuro firmy.
 */
async function niskiStan(db: Db, now: Date): Promise<{ kandydaci: Kandydat[]; zamknij: string[] }> {
  const products = await db.product.findMany({
    where: { active: true, kind: 'STOCKED', lowStockThreshold: { not: null } },
    select: { id: true, sku: true, lowStockThreshold: true, stocks: { select: { physical: true, reserved: true } } },
  })
  // otwarte przejścia wprost (resolvedAt puste), liczba przejść z groupBy — bez czytania całej historii co przebieg
  const [plans, counts] = await Promise.all([
    db.plannedAction.findMany({ where: { rule: 'mail.niski-stan', resolvedAt: null }, select: { id: true, targetId: true } }),
    db.plannedAction.groupBy({ by: ['targetId'], where: { rule: 'mail.niski-stan' }, _count: { _all: true } }),
  ])
  const open = new Map<string, string>(plans.map((p) => [p.targetId, p.id]))
  const count = new Map<string, number>(counts.map((c) => [c.targetId, c._count._all]))
  const org = await db.organization.findFirst({ select: { settings: true } })
  const mode = trybProduktow(org?.settings)
  const kandydaci: Kandydat[] = []
  const zamknij: string[] = []
  for (const p of products) {
    if (!p.stocks.length) continue
    const prog = p.lowStockThreshold!
    const dostepne = p.stocks.reduce((s, x) => s + availableOf(x), 0)
    const otwarte = open.get(p.id)
    if (dostepne < prog && !otwarte) {
      kandydaci.push({
        rule: 'mail.niski-stan',
        targetType: 'PRODUKT',
        targetId: p.id,
        occasion: `ponizej:${(count.get(p.id) ?? 0) + 1}`,
        mode,
        state: 'PLANNED',
        reason: powod(mode),
        vars: { sku: p.sku, dostepne, prog, adresat: 'biuro' },
        dueAt: now,
      })
    } else if (dostepne > prog && otwarte) zamknij.push(otwarte)
  }
  // próg zdjęty albo produkt wyłączony: otwarte przejście się zamyka (inaczej po ponownym progu nie byłoby planu)
  const watched = new Set(products.map((p) => p.id))
  for (const [productId, planId] of open) if (!watched.has(productId)) zamknij.push(planId)
  return { kandydaci, zamknij }
}

// ─── Maile już zaplanowane przez automatyczne akcje ──────────────

/** Maile do klienta, które krok reguły „Wyślij e-mail” może wysłać przed wbudowanym planem. */
const MAILE_REGUL: ReadonlySet<KluczReguly> = new Set(['mail.brak-platnosci', 'mail.gotowe-do-odbioru', 'mail.faktura'])

/**
 * Bez kandydatów, których mail już zaplanowała albo wysłała reguła firmy (wiersz tej samej reguły i zamówienia
 * z okazją `automat:*` w PLANNED/DONE): ten sam mail wychodzi raz, bez względu na to, kto go zaplanował pierwszy
 * (przegląd poprawek, lustro po stronie reguły). „Faktura” tylko dla tej samej `wfirmaDocId`, więc druga
 * faktura tego zamówienia dalej dostaje mail. Firma bez reguł nie ma wierszy `automat:*`: lista bez zmian.
 */
async function bezMailiRegul(db: Db, rule: KluczReguly, lista: Kandydat[]): Promise<Kandydat[]> {
  const ids = [...new Set(lista.map((c) => c.targetId))]
  const zReguly = await db.plannedAction.findMany({
    where: { rule, targetType: 'ZAMOWIENIE', targetId: { in: ids }, state: { in: ['PLANNED', 'DONE'] }, occasion: { startsWith: 'automat:' } },
    select: { targetId: true, vars: true },
  })
  if (!zReguly.length) return lista
  const docId = (v: Prisma.JsonValue) => (v && typeof v === 'object' && !Array.isArray(v) ? String((v as Record<string, unknown>)['wfirmaDocId'] ?? '') : '')
  const zajete = new Set(zReguly.map((p) => (rule === 'mail.faktura' ? `${p.targetId}|${docId(p.vars)}` : p.targetId)))
  return lista.filter((c) => !zajete.has(rule === 'mail.faktura' ? `${c.targetId}|${docId(c.vars as Prisma.JsonValue)}` : c.targetId))
}

// ─── Przebieg ────────────────────────────────────────────────────────────────

/**
 * Jeden przebieg planu firmy (klient firmy z RLS; systemowy = błąd). Reguła po regule: błąd jednej nie zatrzymuje
 * pozostałych, zbiorczy błąd idzie do `Job.lastError`.
 */
export async function planujAkcje(db: Db, ctx: CtxPlanu = {}): Promise<WynikPlanu> {
  organizationIdOf(db)
  const now = ctx.now ?? new Date()
  const k = await konta(db)
  const wynik: WynikPlanu = { nowe: {}, powrotyPowyzejProgu: 0 }
  const errors: string[] = []
  const zapisz = async (rule: KluczReguly, kandydaci: Kandydat[]) => {
    const lista = MAILE_REGUL.has(rule) && kandydaci.length ? await bezMailiRegul(db, rule, kandydaci) : kandydaci
    if (!lista.length) {
      wynik.nowe[rule] = 0
      return
    }
    // createdAt z ctx.now (jak dueAt): od niego poczta liczy „brak kontaktu przez ponad dobę”
    const r = await db.plannedAction.createMany({ data: lista.map((c) => ({ ...c, createdAt: now })), skipDuplicates: true })
    wynik.nowe[rule] = r.count
  }
  const zamowien: [KluczReguly, (db: Db, k: Konta, now: Date) => Promise<Kandydat[]>][] = [
    ['mail.brak-platnosci', brakPlatnosci],
    ['mail.faktura', faktura],
    ['mail.blad-faktury', bladFaktury],
    ['mail.gotowe-do-odbioru', gotoweDoOdbioru],
  ]
  // ustawienia firmy jednym odczytem: plan wbudowany i wyłącznik maili o zwrotach; błąd odczytu = błąd
  // przebiegu w `errors`, reguły zamówień i zwrotów pominięte, „Niski stan” idzie dalej
  let ustawienia: { zPlanem: boolean; zwrotyOd: Date | null } = { zPlanem: false, zwrotyOd: null }
  try {
    const org = await db.organization.findFirst({ select: { settings: true } })
    ustawienia = { zPlanem: planWbudowanyWlaczony(org?.settings), zwrotyOd: maileZwrotowOd(org?.settings) }
  } catch (e) {
    errors.push(`ustawienia firmy: ${e instanceof Error ? e.message : String(e)}`)
  }
  // firma z wyłączonym planem wbudowanym: maile do zamówień planują tylko jej reguły
  for (const [rule, fn] of zamowien) {
    if (!ustawienia.zPlanem) {
      wynik.nowe[rule] = 0
      continue
    }
    try {
      await zapisz(rule, await fn(db, k, now))
    } catch (e) {
      errors.push(`${rule}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  // maile o zwrotach tylko z jawnie włączonym wyłącznikiem firmy; wyłączony = przebieg jak bez tych reguł (bez kluczy w wyniku)
  const zwrotyOd = ustawienia.zwrotyOd
  if (zwrotyOd) {
    try {
      const z = await zwroty(db, k, now, zwrotyOd)
      for (const rule of REGULY_ZWROTOW) await zapisz(rule, z.get(rule) ?? [])
    } catch (e) {
      errors.push(`maile o zwrotach: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  try {
    const n = await niskiStan(db, now)
    // najpierw zamknięcia: produkt, który wrócił powyżej progu, w następnym przebiegu może dostać nowe przejście
    if (n.zamknij.length) wynik.powrotyPowyzejProgu = (await db.plannedAction.updateMany({ where: { id: { in: n.zamknij }, resolvedAt: null }, data: { resolvedAt: now } })).count
    await zapisz('mail.niski-stan', n.kandydaci)
  } catch (e) {
    errors.push(`mail.niski-stan: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (errors.length) throw new Error(`plan akcji: ${errors.join('; ')}`.slice(0, 4000))
  return wynik
}

/** Handler zadania workera `akcje-plan` (rejestracja w lib/worker/zadania.ts). */
export async function zadaniePlanuAkcji(db: Db): Promise<void> {
  await planujAkcje(db)
}
