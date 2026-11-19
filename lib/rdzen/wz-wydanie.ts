// (wymóg z odpowiedzi biura): przy stanie prowadzonym w programie księgowym (lustro wFirmy) zamówienie
// wysłane bez faktury („Wyślij bez faktury”, `shipWithoutInvoice`) zostawiało ruch MANUAL i alert „Wydane bez dokumentu
// w wFirmie” do ręcznego zamknięcia. Gdy firma włączy „WZ przy wysyłce bez faktury” (`settings.faktury.wzBezFaktury`),
// a dostawca dokumentów umie WZ (zdolność `wz`, lib/dokumenty/kontrakt.ts), Kompletor zakłada WZ w programie sam:
//   - referencja `wz/<orderId>/<paczka>` (klucz idempotencji); najpierw odszukanie po niej (po niejasnym wyniku albo
//     przerwanym przebiegu dokument mógł powstać), dopiero potem wystawienie;
//   - OK → ruchy APPLIED z numerem dokumentu i odczytem celowanym stanu (jak faktura), alert zamknięty;
//   - ERROR → ruch zostaje MANUAL, alert `WZ_BLAD` z treścią błędu (biuro wystawia ręcznie jak dotąd);
//   - TIMEOUT albo wyjątek → alert `WZ_NIEWIADOMA`, kolejne przebiegi tylko odszukują; LIMIT → koniec przebiegu.
// Błąd jednego zamówienia nie zatrzymuje reszty. Zapis w programie wyłącznie przez dostawcę (w testach atrapa);
// prawdziwy adapter zapisu WZ do wFirmy: lib/wfirma/wz-zapis.ts, za wyłącznikami firmy.
// (bez ponownego wysyłania na ślepo):
//   - po ERROR otwarty alert `WZ_BLAD` wstrzymuje tę wysyłkę (biuro wystawia ręcznie, jak mówi alert); bez tego
//     odrzucony dokument szedłby do programu co przebieg (2 min), zjadając limit wywołań wspólny z fakturami;
//   - po TIMEOUT albo wyjątku alert `WZ_NIEWIADOMA`: kolejne przebiegi tylko odszukują po referencji i NIE wystawiają
//     drugi raz (program może nie zwracać referencji w wynikach wyszukiwania, wtedy ponowne wystawienie dałoby dubel).
// poprawki po przeglądzie:
//   - próba (`WzAttempt`, stan SENDING) zapisana PRZED wywołaniem programu, jak `InvoiceAttempt` przy fakturach.
//     Po OK numer dokumentu trafia do próby, zanim ruchy zostaną zamknięte; awaria bazy albo restart między odpowiedzią
//     programu a zapisem zostawia próbę SENDING/OK, a kolejne przebiegi tylko kończą zapis albo szukają, nigdy nie
//     wystawiają drugi raz. Próba SENDING bez dokumentu dłużej niż `PROBA_PRZETERMINOWANA_MS` = niewiadoma z alertem;
//   - tylko wysyłki od chwili włączenia „WZ przy wysyłce bez faktury” (`wzBezFakturyOd`) i „Wystawiaj faktury
//     z Kompletora” (`fakturyWlaczoneOd`); zaległe biuro dokumentowało ręcznie, zostają do przycisku na karcie;
//   - ręczne wyjście z WZ_BLAD/WZ_NIEWIADOMA to przycisk „Dokument wystawiony” na karcie zamówienia
//     (Zamówienia → numer zamówienia → sekcja „Dokument sprzedaży”), `potwierdzDokumentWystawiony` w rozchod.ts.
// celowo tylko klucze `bez-dokumentu:` (zamówienia wysłane z Kompletora przyciskiem „Wyślij bez faktury”).
// Ruchy `bl-bez-faktury:` (zamówienie prowadzone w BaseLinkerze, wysłane tam bez faktury) zostają poza tym przebiegiem:
// dokument wystawia BL albo biuro. `shipWithoutInvoice` woła tylko lib/praca/wykonaj.ts, więc WZ dotyczy kont w trybie
// PRACA.
import type { PrismaClient } from '@prisma/client'
import { type DostawcaDokumentow, umieWydacWz, type ZnalezionyDokument } from '../dokumenty/kontrakt'
import { chwilaAutomatuWz, parseUstawieniaDokumentow, wzBezFaktury } from '../dokumenty/ustawienia'
import { alert, DEFAULT_WAREHOUSE, outbox, runTx } from './stan'

const KEY_PREFIX = 'bez-dokumentu:'
const MAX_ORDERS_PER_RUN = 50
/** Próba SENDING bez zapisanej odpowiedzi starsza niż to = przebieg padł w trakcie (wywołanie ma limit czasu). */
export const PROBA_PRZETERMINOWANA_MS = 10 * 60_000
/** Gdzie biuro zamyka pozycję ręcznie (karta zamówienia, uprawnienie „zamowienia.faktury”). */
export const DROGA_DO_PRZYCISKU = 'Zamówienia → numer zamówienia → sekcja „Dokument sprzedaży” → przycisk „Dokument wystawiony”'
const TRESC_NIEWIADOMA = `Nie wiadomo, czy dokument WZ powstał w wFirmie (przerwane połączenie albo brak odpowiedzi). Kompletor szuka go przy każdym przebiegu i nie wystawi drugiego. Sprawdź w wFirmie, czy WZ dla tej wysyłki jest. Jeśli jest, kliknij „Dokument wystawiony”. Jeśli go nie ma, wystaw WZ ręcznie w wFirmie i też kliknij „Dokument wystawiony”. Przycisk: ${DROGA_DO_PRZYCISKU}.`
const PO_RECZNYM = `Wystaw dokument ręcznie w wFirmie i kliknij „Dokument wystawiony” (${DROGA_DO_PRZYCISKU}).`

export interface WzWydanieStats {
  issued: number
  found: number
  errors: number
  waiting: number
  skipped: string | null
  messages: string[]
}

export function referencjaWz(orderId: string, packageNo: number): string {
  return `wz/${orderId}/${packageNo}`
}

/** Przebieg: ruchy „wydane bez dokumentu” zamówień Kompletora → WZ w programie. */
export async function wystawWzDlaWydanych(db: PrismaClient, dostawca: DostawcaDokumentow, opts: { now?: Date; maxOrders?: number } = {}): Promise<WzWydanieStats> {
  const now = opts.now ?? new Date()
  const stats: WzWydanieStats = { issued: 0, found: 0, errors: 0, waiting: 0, skipped: null, messages: [] }
  const org = await db.organization.findFirst({ select: { id: true, settings: true } })
  if (!wzBezFaktury(org?.settings ?? null)) return { ...stats, skipped: 'wyłączone w ustawieniach firmy' }
  // (wariant a): WZ to wyjście awaryjne toru faktur Kompletora — ten sam wyłącznik co faktury
  // („Wystawiaj faktury z Kompletora”) plus „WZ przy wysyłce bez faktury”. Sprawdzane też tutaj, nie tylko w workerze.
  if (!parseUstawieniaDokumentow(org?.settings ?? null).fakturyWlaczone) return { ...stats, skipped: 'wystawianie faktur z Kompletora wyłączone' }
  if (!umieWydacWz(dostawca)) return { ...stats, skipped: `${dostawca.nazwa}: program nie umie WZ` }
  // tylko wysyłki od chwili włączenia obu przełączników (późniejsza z dwóch); bez chwili nic nie idzie
  const od = chwilaAutomatuWz(org?.settings ?? null)
  if (!org || !od) return { ...stats, skipped: 'brak chwili włączenia WZ albo faktur (zapisz ponownie ustawienia dokumentów sprzedaży)' }
  const orgId = org.id
  const klucz = (ref: string) => ({ organizationId_ref: { organizationId: orgId, ref } })
  const wh = await db.warehouse.findFirst({ where: { id: DEFAULT_WAREHOUSE }, select: { wfirmaWarehouseId: true } })
  if (!wh?.wfirmaWarehouseId) return { ...stats, skipped: 'magazyn bez magazynu w programie' }
  const moves = await db.pendingMovement.findMany({
    where: { type: 'ISSUED_WITHOUT_DOCUMENT', state: 'MANUAL', warehouseId: DEFAULT_WAREHOUSE, idempotencyKey: { startsWith: KEY_PREFIX }, sentAt: { gte: od } },
    orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
    select: { id: true, orderId: true, productId: true, delta: true, idempotencyKey: true },
  })
  // grupa = zamówienie + paczka z klucza `bez-dokumentu:<orderId>:<paczka>:<productId>`
  const groups = new Map<string, { orderId: string; packageNo: number; moves: typeof moves }>()
  for (const m of moves) {
    const parts = (m.idempotencyKey ?? '').slice(KEY_PREFIX.length).split(':')
    const packageNo = Number(parts[1])
    if (!m.orderId || !Number.isInteger(packageNo)) continue
    const k = `${m.orderId}:${packageNo}`
    const g = groups.get(k) ?? { orderId: m.orderId, packageNo, moves: [] }
    g.moves.push(m)
    groups.set(k, g)
  }
  for (const g of [...groups.values()].slice(0, Math.max(1, Math.min(opts.maxOrders ?? MAX_ORDERS_PER_RUN, MAX_ORDERS_PER_RUN)))) {
    const ref = referencjaWz(g.orderId, g.packageNo)
    try {
      // po odmowie programu nie wysyłamy ponownie (alert WZ_BLAD otwarty = biuro wystawia ręcznie)
      if (await db.alert.count({ where: { kind: 'WZ_BLAD', dedupeKey: `wz-blad:${ref}`, closedAt: null } })) {
        stats.errors++
        continue
      }
      const proba = await db.wzAttempt.findUnique({ where: klucz(ref) })
      // program oddał dokument, ale zamknięcie ruchów nie doszło do skutku — kończymy zapis bez pytania programu
      if (proba?.state === 'OK' && proba.docId) {
        await settled(db, g, { docId: proba.docId, referencja: ref, numer: proba.number }, now, ref)
        stats.found++
        continue
      }
      // program, który nie odfiltruje po referencji (jak wFirma ignorująca `id_external`, 3.4 v1.5),
      // oddałby obce WZ — liczy się tylko dokument z dokładnie tą referencją; więcej niż jeden = błąd, bez wystawiania
      const found = (await dostawca.odszukajWz(ref)).filter((f) => f.referencja === ref)
      if (found.length > 1) {
        stats.errors++
        stats.messages.push(`${ref}: w programie ${found.length} dokumenty WZ z tą referencją`)
        await alert(db, 'WZ_BLAD', g.orderId, `W wFirmie jest kilka dokumentów WZ dla tej samej wysyłki (${found.length}). Zostaw jeden, pozostałe usuń w wFirmie i kliknij „Dokument wystawiony” (${DROGA_DO_PRZYCISKU}).`, `wz-blad:${ref}`)
        continue
      }
      if (found.length) {
        await settled(db, g, found[0]!, now, ref)
        stats.found++
        continue
      }
      // wcześniejsza próba bez rozstrzygnięcia (wysłana, a odpowiedź niezapisana albo niejasna): bez drugiego zapisu.
      // Przeterminowana próba SENDING (przebieg padł po wysłaniu) staje się niewiadomą z alertem dla biura.
      if (proba && (proba.state === 'SENDING' || proba.state === 'UNKNOWN' || proba.state === 'OK')) {
        if (proba.state !== 'UNKNOWN' && now.getTime() - proba.updatedAt.getTime() >= PROBA_PRZETERMINOWANA_MS) {
          await db.wzAttempt.update({ where: klucz(ref), data: { state: 'UNKNOWN', lastError: 'przebieg przerwany po wysłaniu do programu' } })
          await alert(db, 'WZ_NIEWIADOMA', g.orderId, TRESC_NIEWIADOMA, `wz-niewiadoma:${ref}`)
        }
        stats.waiting++
        continue
      }
      // wcześniejsza próba skończyła się niewiadomą, a dokumentu z tą referencją nie widać: bez drugiego zapisu
      if (await db.alert.count({ where: { kind: 'WZ_NIEWIADOMA', dedupeKey: `wz-niewiadoma:${ref}`, closedAt: null } })) {
        stats.waiting++
        continue
      }
      const products = await db.product.findMany({ where: { id: { in: g.moves.map((m) => m.productId) } }, select: { id: true, sku: true, wfirmaGoodId: true, unit: true } })
      const byId = new Map(products.map((p) => [p.id, p]))
      const bez = g.moves.filter((m) => !byId.get(m.productId)?.wfirmaGoodId)
      if (bez.length) {
        // towar bez odpowiednika w programie: WZ nie da się wystawić, biuro zamyka ręcznie (jak dotąd)
        stats.errors++
        await alert(db, 'WZ_BLAD', g.orderId, `WZ nie wystawione: towar nie jest powiązany z towarem w wFirmie (${bez.map((m) => byId.get(m.productId)?.sku ?? m.productId).join(', ')}). ${PO_RECZNYM}`, `wz-blad:${ref}`)
        continue
      }
      const pozycje = g.moves.map((m) => {
        const p = byId.get(m.productId)!
        return { towarId: p.wfirmaGoodId!, ilosc: p.unit === 'KG' ? -m.delta / 1000 : -m.delta }
      })
      // znacznik próby zapisany (i zatwierdzony) PRZED wywołaniem programu; błąd zapisu = brak wywołania
      await db.wzAttempt.upsert({
        where: klucz(ref),
        create: { ref, orderId: g.orderId, state: 'SENDING' },
        update: { state: 'SENDING', attempts: { increment: 1 }, docId: null, number: null, lastError: null },
      })
      const zapiszProbe = (data: { state: string; docId?: string; number?: string | null; lastError?: string }) => db.wzAttempt.update({ where: klucz(ref), data })
      let r
      try {
        r = await dostawca.wydajWz({ referencja: ref, pozycje, magazyn: wh.wfirmaWarehouseId })
      } catch {
        r = { kind: 'TIMEOUT' as const } // błąd transportu: nie wiadomo, czy powstał — kolejny przebieg odszukuje
      }
      if (r.kind === 'OK') {
        // najpierw numer do próby (osobny zapis): gdy zamknięcie ruchów niżej padnie, kolejny przebieg je dokończy
        await zapiszProbe({ state: 'OK', docId: r.docId, number: r.numer ?? null })
        await settled(db, g, { docId: r.docId, referencja: ref, numer: r.numer ?? null }, now, ref)
        stats.issued++
      } else if (r.kind === 'TIMEOUT') {
        await zapiszProbe({ state: 'UNKNOWN', lastError: 'brak odpowiedzi programu' })
        await alert(db, 'WZ_NIEWIADOMA', g.orderId, TRESC_NIEWIADOMA, `wz-niewiadoma:${ref}`)
        stats.waiting++
      } else if (r.kind === 'ERROR') {
        stats.errors++
        stats.messages.push(`${ref}: ${r.message}`)
        await zapiszProbe({ state: 'ERROR', lastError: r.message.slice(0, 500) })
        await alert(db, 'WZ_BLAD', g.orderId, `WZ nie wystawione, wFirma odpowiedziała: ${r.message.slice(0, 300)}. ${PO_RECZNYM}`, `wz-blad:${ref}`)
      } else if (r.kind === 'LIMIT') {
        // limit wywołań: program odrzucił żądanie, dokument nie powstał — kolejny przebieg spróbuje ponownie
        await zapiszProbe({ state: 'LIMIT', lastError: r.message.slice(0, 500) })
        stats.waiting++
        stats.messages.push(`limit programu: ${r.message}`)
        break
      } else stats.waiting++
    } catch (e) {
      stats.waiting++
      stats.messages.push(`${ref}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return stats
}

/** WZ jest w programie: ruchy APPLIED z numerem, odczyt celowany stanu, alerty zamknięte, wpis w historii zamówienia. */
async function settled(db: PrismaClient, g: { orderId: string; packageNo: number; moves: { id: string; productId: string; delta: number }[] }, doc: ZnalezionyDokument, now: Date, ref: string): Promise<void> {
  await runTx(db, async (tx) => {
    // próba OK z numerem w tej samej transakcji co ruchy (dokument odnaleziony po niewiadomej też ją rozstrzyga)
    await tx.wzAttempt.updateMany({ where: { ref }, data: { state: 'OK', docId: doc.docId, number: doc.numer ?? null } })
    for (const m of g.moves) {
      // bez numeru z programu `wz:<id>` (odczyt WZ w cieniu rozpozna dokument jako już rozliczony, a samo id
      // mogłoby się pomylić z id faktury)
      const upd = await tx.pendingMovement.updateMany({ where: { id: m.id, state: 'MANUAL' }, data: { state: 'APPLIED', effectiveAt: now, wzQty: -m.delta, wfirmaDocId: doc.numer ?? `wz:${doc.docId}` } })
      if (upd.count) await outbox(tx, 'WFIRMA_READ', m.productId, now)
    }
    await tx.alert.updateMany({ where: { kind: { in: ['WYDANE_BEZ_DOKUMENTU', 'WZ_BLAD', 'WZ_NIEWIADOMA'] }, ref: g.orderId, closedAt: null }, data: { closedAt: now, dedupeKey: null } })
    await tx.orderEvent.create({ data: { orderId: g.orderId, kind: 'WZ_WYSTAWIONE', actorId: 'system:wz', data: { dokument: doc.numer ?? `wz:${doc.docId}`, paczka: g.packageNo } } })
  })
}
