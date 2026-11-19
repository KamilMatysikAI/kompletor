// Niezmienniki 5.4 — sprawdzane po każdym przypadku testowym i w nocnym audycie. Naruszenie → alert,
// bez automatycznej naprawy.
import { alert, type Db } from './stan'

export interface Violation {
  rule: string
  ref: string
  detail: string
}

export async function checkInvariants(db: Db): Promise<Violation[]> {
  const out: Violation[] = []
  // 1. reserved = Σ ACTIVE
  for (const r of await db.$queryRaw<{ productId: string; reserved: number; sum: number }[]>`
    SELECT s."productId", s.reserved, COALESCE(SUM(r."qtyBase") FILTER (WHERE r.state = 'ACTIVE'), 0)::int AS sum
    FROM "Stock" s LEFT JOIN "Reservation" r ON r."productId" = s."productId" AND r."warehouseId" = s."warehouseId"
    GROUP BY s."productId", s."warehouseId", s.reserved
    HAVING s.reserved <> COALESCE(SUM(r."qtyBase") FILTER (WHERE r.state = 'ACTIVE'), 0)`)
    out.push({ rule: '1 reserved=ΣACTIVE', ref: r.productId, detail: `reserved ${r.reserved}, Σ ${r.sum}` })
  // 2. pendingDelta = Σ IN_FLIGHT|APPLIED|MANUAL (delta < 0 pilnuje CHECK w bazie)
  for (const r of await db.$queryRaw<{ productId: string; pending: number; sum: number }[]>`
    SELECT s."productId", s."pendingDelta" AS pending, COALESCE(SUM(m.delta) FILTER (WHERE m.state IN ('IN_FLIGHT','APPLIED','MANUAL')), 0)::int AS sum
    FROM "Stock" s LEFT JOIN "PendingMovement" m ON m."productId" = s."productId" AND m."warehouseId" = s."warehouseId"
    GROUP BY s."productId", s."warehouseId", s."pendingDelta"
    HAVING s."pendingDelta" <> COALESCE(SUM(m.delta) FILTER (WHERE m.state IN ('IN_FLIGHT','APPLIED','MANUAL')), 0)`)
    out.push({ rule: '2 pendingDelta=Σruchów', ref: r.productId, detail: `pendingDelta ${r.pending}, Σ ${r.sum}` })
  // 3 + 5. physical = wfirmaCount + pendingDelta; reserved > physical tylko z overcommitSince
  for (const r of await db.$queryRaw<{ productId: string; physical: number; wfirmaCount: number; pendingDelta: number; reserved: number; overcommitSince: Date | null }[]>`
    SELECT "productId", physical, "wfirmaCount", "pendingDelta", reserved, "overcommitSince" FROM "Stock"
    WHERE physical <> "wfirmaCount" + "pendingDelta" OR reserved < 0 OR (reserved > physical AND "overcommitSince" IS NULL)`) {
    out.push({ rule: '3/5 physical i overcommit', ref: r.productId, detail: `physical ${r.physical}, count ${r.wfirmaCount}, pending ${r.pendingDelta}, reserved ${r.reserved}, overcommitSince ${r.overcommitSince?.toISOString() ?? '—'}` })
  }
  // 4. bilans pozycji po rozwinięciu zestawu
  for (const r of await db.$queryRaw<{ lineId: string; comp: string; expected: number; got: number; status: string }[]>`
    WITH parts AS (
      SELECT l.id AS line_id, o.status, o."stockReleasedAt" AS released,
             -- zamówienie zamknięte punktem cięcia (obsłużone w innym systemie) po zwolnieniu towaru po nieudanej
             -- płatności online, bez powrotu rezerwacji: w Kompletorze nie trzyma i nie zużyło żadnego towaru
             (o.status IN ('WYSLANE','ODEBRANE','DO_ODBIORU')
              AND EXISTS (SELECT 1 FROM "OrderEvent" z WHERE z."orderId" = o.id AND z.kind = 'TOWAR_ZWOLNIONY')
              AND NOT EXISTS (SELECT 1 FROM "Reservation" z WHERE z."orderId" = o.id AND z.state IN ('ACTIVE','CONSUMING','CONSUMED'))
              AND NOT EXISTS (SELECT 1 FROM "Shortage" z WHERE z."orderId" = o.id AND z.state IN ('OPEN','SHIP_LATER','REFUND_PENDING','REFUNDED','COD_REDUCED'))) AS closed_released,
             CASE WHEN l.removed THEN 0 ELSE l.qty - l."qtyRejected" END AS units,
             COALESCE(bc."componentId", p.id) AS comp, COALESCE(bc."qtyBase", 1) AS per
      FROM "OrderLine" l
      JOIN "Order" o ON o.id = l."orderId"
      JOIN "Product" p ON p.id = l."productId"
      LEFT JOIN "BundleComponent" bc ON bc."bundleId" = p.id AND p.kind = 'BUNDLE'
      -- produkt bez stanu (DIGITAL) nie ma rezerwacji ani braków: poza bilansem (rezerwację na nim łapie 4c)
      WHERE NOT (p.kind = 'BUNDLE' AND bc."componentId" IS NULL) AND p.kind <> 'DIGITAL'
    ),
    res AS (
      SELECT "orderLineId", "productId", SUM("qtyBase")::int AS s FROM "Reservation"
      WHERE state IN ('ACTIVE','CONSUMING','CONSUMED') GROUP BY 1, 2
    ),
    sh AS (
      SELECT "orderLineId", "productId", SUM("qtyBase")::int AS s FROM "Shortage"
      WHERE state IN ('OPEN','SHIP_LATER','REFUND_PENDING','REFUNDED','COD_REDUCED') GROUP BY 1, 2
    )
    SELECT parts.line_id AS "lineId", parts.comp, (parts.units * parts.per)::int AS expected,
           (COALESCE(res.s, 0) + COALESCE(sh.s, 0))::int AS got, parts.status::text AS status
    FROM parts
    LEFT JOIN res ON res."orderLineId" = parts.line_id AND res."productId" = parts.comp
    LEFT JOIN sh ON sh."orderLineId" = parts.line_id AND sh."productId" = parts.comp
    -- towar zwolniony po nieudanej płatności online: zamówienie w Nowych albo „Do wyjaśnienia”, celowo bez rezerwacji
    -- i braków do wpłaty (pozostałe stany zwolnionych pilnuje 4e)
    WHERE parts.status <> 'ANULOWANE' AND NOT (parts.released IS NOT NULL AND parts.status IN ('NOWE','DO_WYJASNIENIA')) AND NOT parts.closed_released AND parts.units * parts.per <> COALESCE(res.s, 0) + COALESCE(sh.s, 0)`)
    out.push({ rule: '4 bilans pozycji', ref: `${r.lineId}/${r.comp}`, detail: `oczekiwane ${r.expected}, jest ${r.got} (${r.status})` })
  // 4b. anulowane: brak ACTIVE/CONSUMING i brak OPEN/SHIP_LATER
  for (const r of await db.$queryRaw<{ id: string; a: number; s: number }[]>`
    SELECT o.id,
      (SELECT count(*) FROM "Reservation" r WHERE r."orderId" = o.id AND r.state IN ('ACTIVE','CONSUMING'))::int AS a,
      (SELECT count(*) FROM "Shortage" s WHERE s."orderId" = o.id AND s.state IN ('OPEN','SHIP_LATER'))::int AS s
    FROM "Order" o WHERE o.status = 'ANULOWANE'`) {
    if (r.a || r.s) out.push({ rule: '4b anulowane', ref: r.id, detail: `ACTIVE/CONSUMING ${r.a}, OPEN/SHIP_LATER ${r.s}` })
  }
  // 4e. towar zwolniony po nieudanej płatności online: zamówienie otwarte w Nowych albo „Do wyjaśnienia”, nieopłacone,
  // bez rezerwacji ACTIVE/CONSUMING i bez braków OPEN/SHIP_LATER; termin zwolnienia i znacznik zwolnienia nigdy naraz
  for (const r of await db.$queryRaw<{ id: string; status: string; payment: string; a: number; s: number; both: boolean }[]>`
    SELECT o.id, o.status::text AS status, o."paymentState"::text AS payment,
      (SELECT count(*) FROM "Reservation" r WHERE r."orderId" = o.id AND r.state IN ('ACTIVE','CONSUMING'))::int AS a,
      (SELECT count(*) FROM "Shortage" s WHERE s."orderId" = o.id AND s.state IN ('OPEN','SHIP_LATER'))::int AS s,
      (o."stockReleaseAt" IS NOT NULL) AS both
    FROM "Order" o WHERE o."stockReleasedAt" IS NOT NULL AND o.status <> 'ANULOWANE'`) {
    const zle: string[] = []
    if (r.a) zle.push(`ACTIVE/CONSUMING ${r.a}`)
    if (r.s) zle.push(`OPEN/SHIP_LATER ${r.s}`)
    if (r.payment !== 'UNPAID' && r.payment !== 'PARTIAL') zle.push(`płatność ${r.payment}`)
    if (r.status !== 'NOWE' && r.status !== 'DO_WYJASNIENIA') zle.push(`status ${r.status}`)
    if (r.both) zle.push('termin zwolnienia przy zwolnionym towarze')
    if (zle.length) out.push({ rule: '4e zwolnione', ref: r.id, detail: zle.join(', ') })
  }
  // 4c. rezerwacje i braki na produktach spoza pozycji (np. zestaw z innym składem)
  for (const r of await db.$queryRaw<{ id: string }[]>`
    SELECT r.id FROM "Reservation" r JOIN "OrderLine" l ON l.id = r."orderLineId" JOIN "Product" p ON p.id = l."productId"
    WHERE r.state IN ('ACTIVE','CONSUMING','CONSUMED') AND NOT (
      (p.kind = 'STOCKED' AND r."productId" = p.id) OR
      (p.kind = 'BUNDLE' AND EXISTS (SELECT 1 FROM "BundleComponent" bc WHERE bc."bundleId" = p.id AND bc."componentId" = r."productId")))`)
    out.push({ rule: '4c rezerwacja spoza pozycji', ref: r.id, detail: 'rezerwacja na produkcie spoza pozycji' })
  // 4d. ACTIVE na zamówieniu, które już wyszło: rezerwacja nigdy nie zostałaby skonsumowana
  for (const r of await db.$queryRaw<{ id: string; status: string }[]>`
    SELECT DISTINCT o.id, o.status::text AS status FROM "Reservation" r JOIN "Order" o ON o.id = r."orderId"
    WHERE r.state = 'ACTIVE' AND o.status IN ('DO_WYSLANIA','DO_ODBIORU','WYSLANE','ODEBRANE','REKLAMACJA')`)
    out.push({ rule: '4d ACTIVE po wysyłce', ref: r.id, detail: `rezerwacja ACTIVE przy statusie ${r.status}` })
  return out
}

/** Raport 5.4 pkt 5: ruchy w toku > 24 h, MANUAL > doba, nadmiar > 30 min → alerty (dedupe per obiekt). */
export async function auditStale(db: Db, now = new Date()): Promise<number> {
  const day = new Date(now.getTime() - 24 * 3600_000)
  const moves = await db.pendingMovement.findMany({
    where: { OR: [{ state: { in: ['IN_FLIGHT', 'APPLIED'] }, sentAt: { lt: day } }, { state: 'MANUAL', sentAt: { lt: day } }] },
    select: { id: true, productId: true, state: true, type: true, sentAt: true },
  })
  for (const m of moves)
    await alert(db, 'RUCH_ZALEGLY', m.productId, `Ruch ${m.type} w stanie ${m.state} od ${m.sentAt.toISOString()} — sprawdź w wFirmie`, `ruch-zalegly:${m.id}:${m.state}`)
  const marked = await db.stock.findMany({ where: { overcommitSince: { lt: new Date(now.getTime() - 30 * 60_000) } }, select: { productId: true, overcommitSince: true, reserved: true, physical: true } })
  // znacznik przy stanie ujemnym bez rezerwacji ponad zero to nie nadmiar (ruch biura), jak w raporcie dziennym
  const over = marked.filter((x) => x.reserved > Math.max(0, x.physical))
  for (const s of over)
    await alert(db, 'NADMIAR_ZALEGLY', s.productId, `Nadmiar rezerwacji od ${s.overcommitSince!.toISOString()}`, `nadmiar-zalegly:${s.productId}:${s.overcommitSince!.toISOString()}`)
  return moves.length + over.length
}

/** Nocny audyt: każde naruszenie jako alert (dedup per reguła i obiekt). */
export async function auditInvariants(db: Db): Promise<number> {
  const v = await checkInvariants(db)
  for (const x of v) await alert(db, 'NIEZMIENNIK', x.ref, `${x.rule}: ${x.detail}`, `niezmiennik:${x.rule}:${x.ref}:${x.detail}`)
  return v.length
}
