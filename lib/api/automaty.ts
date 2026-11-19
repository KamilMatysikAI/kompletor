// GET /api/v1/automaty (zakres `zamowienia:odczyt`) i narzędzie MCP `automaty`: odczyt automatycznych akcji
// firmy (grupy, reguły z warunkami i krokami w schemacie lib/automaty/schemat.ts) i ostatnich wykonań (wszystkich albo
// jednego zamówienia). Tylko odczyt: zapis reguł przez API dopiero po ocenie bezpieczeństwa. Bez danych klientów —
// wykonanie niesie id zamówienia, zdarzenie, wynik i opisy kroków.
import type { PrismaClient } from '@prisma/client'
import { ZDARZENIA } from '@/lib/automaty/schemat'
import { regulyWKolejnosci } from '@/lib/automaty/silnik'
import { ApiInputError } from './odpowiedzi'

export const MAX_WYKONAN = 100

export interface AutomatyApi {
  grupy: { id: string; nazwa: string; kolejnosc: number }[]
  reguly: {
    id: string
    nazwa: string
    wlaczona: boolean
    grupa: string | null
    zdarzenie: string
    zdarzenieNazwa: string
    warunki: unknown[]
    kroki: unknown[]
    przycisk: { napis: string; miejsca: string[] } | null
  }[]
  wykonania: { regula: string; zamowienie: string; zdarzenie: string; wynik: string; lancuch: number; kroki: unknown[]; kiedy: string }[]
}

export function parametryAutomatow(p: URLSearchParams): { zamowienie: string | null; limit: number } {
  let zamowienie: string | null = null
  let limit = 50
  for (const [k, v] of p) {
    if (k === 'zamowienie') {
      if (!/^[a-z0-9]{1,40}$/i.test(v)) throw new ApiInputError('zamowienie: id zamówienia', 'zamowienie')
      zamowienie = v
    } else if (k === 'limit') {
      const n = Number(v)
      if (!Number.isInteger(n) || n < 1 || n > MAX_WYKONAN) throw new ApiInputError(`limit: 1–${MAX_WYKONAN}`, 'limit')
      limit = n
    } else throw new ApiInputError(`Nieznany parametr ${k}`, k)
  }
  return { zamowienie, limit }
}

export async function automatyFirmy(db: PrismaClient, o: { zamowienie?: string | null; limit?: number } = {}): Promise<AutomatyApi> {
  const [grupy, reguly, grupaReguly, runy] = await Promise.all([
    db.automationGroup.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], select: { id: true, name: true, sortOrder: true } }),
    regulyWKolejnosci(db),
    db.automationRule.findMany({ where: { hidden: false }, select: { id: true, groupId: true } }),
    db.automationRun.findMany({
      where: { ...(o.zamowienie ? { orderId: o.zamowienie } : {}), result: { not: 'W_TOKU' } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(o.limit ?? 50, MAX_WYKONAN),
      select: { ruleId: true, orderId: true, event: true, result: true, chain: true, steps: true, createdAt: true },
    }),
  ])
  const g = new Map(grupaReguly.map((r) => [r.id, r.groupId]))
  return {
    grupy: grupy.map((x) => ({ id: x.id, nazwa: x.name, kolejnosc: x.sortOrder })),
    reguly: reguly.map((r) => ({
      id: r.id,
      nazwa: r.name,
      opis: r.description ?? null,
      wlaczona: r.enabled,
      grupa: g.get(r.id) ?? null,
      zdarzenie: r.event,
      zdarzenieNazwa: ZDARZENIA[r.event]?.nazwa ?? r.event,
      warunki: r.conditions,
      kroki: r.actions,
      przycisk: r.event === 'PRZYCISK' ? { napis: r.buttonLabel || r.name, miejsca: r.buttonPlaces ?? [] } : null,
    })),
    wykonania: runy.map((x) => ({ regula: x.ruleId, zamowienie: x.orderId, zdarzenie: x.event, wynik: x.result, lancuch: x.chain, kroki: Array.isArray(x.steps) ? x.steps : [], kiedy: x.createdAt.toISOString() })),
  }
}
