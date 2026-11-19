// Przeprowadzka z BL: zapis planu WYŁĄCZNIE w bazie Kompletora (klient firmy, RLS). W BL nic się nie
// zmienia — zapis nie woła żadnego źródła, dostaje gotowe dane z `zbierz` (przebieg.ts).
//
// Kolejność: konfiguracja → produkty i stany → oferty (jedno `persistImport`, w nim najpierw produkty i stany, potem
// oferty) → reguły przewoźników → zamówienia. Każdy etap jest idempotentny (createMany skipDuplicates, upserty importu,
// porównanie reguł, InboundEvent w rdzeniu), więc ponowienie po przerwaniu kończy to samo i niczego nie dubluje.
//
// Cel zapisu to firma w cieniu bez własnego ruchu: odmowa, gdy firma ma zamówienia z kanałów (inne źródło niż
// przeprowadzka) albo konto w trybie innym niż CIEN — np. firma, która pracuje w cieniu własnych kanałów.
import type { Prisma, PrismaClient } from '@prisma/client'
import { NonRetryableError } from '../bledy'
import type { Analysis } from '../import/katalog'
import { persistImport, type PersistStats } from '../import/zapis'
import { type CarrierRuleT, DEFAULT_CARRIER_RULES, LEGACY_DEFAULT_CARRIER_RULES } from '../rdzen/przewoznicy'
import { DEFAULT_WAREHOUSE } from '../rdzen/stan'
import type { ZebraneDane } from './przebieg'
import type { PlanKonfiguracji } from './rozpoznanie'
import { blokujaceStatusy, doZapisu } from './statusy'
import { statusyFirmy } from '@/lib/panel/statusy-firmy-dane'
import { zalozReguly } from '@/lib/automaty/preset'
import { organizationIdOf } from '../db'
import { bladZestawu, GRUPA_AUTOMATOW_BL, planAutomatow, planStatusowFirmy, statusyDoZapisu, statusyPoPlanie, uzupelnienieEtapow, znacznikAutomatowBl, type ZnacznikAutomatowBl } from './statusy-firmy'
import { przeniesZamowienia, type WynikZamowienia, ZRODLO_PRZEPROWADZKI } from './zamowienia'
import type { KontoPlan } from './rozpoznanie'
import type { BlZamowienie } from './zamowienia'

export const RODZAJ_PRZEBIEGU = 'PRZEPROWADZKA'

export class OdmowaZapisu extends NonRetryableError {
  constructor(readonly powody: string[]) {
    super(`zapis odrzucony: ${powody.join('; ')}`)
    this.name = 'OdmowaZapisu'
  }
}

/**
 * Jedna definicja „konto poza podglądem”: którakolwiek część trybu (stany,
 * statusy, numery nadania, publikacja) inna niż CIEN. Zapis przeprowadzki liczy wszystkie konta firmy; bramka klucza BL
 * w panelu (`kontaWPracy`) tylko włączone konta sklepów (wyłączone konto nie prowadzi zamówień, a import i tak je zgłosi).
 */
export const KONTO_POZA_PODGLADEM = {
  OR: [{ stockMode: { not: 'CIEN' as const } }, { statusMode: { not: 'CIEN' as const } }, { trackingMode: { not: 'CIEN' as const } }, { publishMode: { not: 'CIEN' as const } }],
} satisfies Prisma.ChannelConfigWhereInput

/** Przeprowadzka zapisana (jedna definicja dla listy startu i bramki trybu pracy): zapis OK albo z uwagami. */
export const PRZEPROWADZKA_ZAPISANA = { kind: RODZAJ_PRZEBIEGU, status: { in: ['OK' as const, 'PARTIAL' as const] } } satisfies Prisma.ImportRunWhereInput

const settingsObj = (v: Prisma.JsonValue | null | undefined): Record<string, Prisma.JsonValue> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Prisma.JsonValue>) : {}

/**
 * Powody odmowy zapisu (pusta lista = można zapisać). Sprawdza firmę (bazę) i plan. Tryb próbny pokazuje te powody
 * w raporcie, ale działa dalej.
 */
export async function powodyOdmowy(
  db: PrismaClient,
  plan: PlanKonfiguracji,
  otwartePoStatusie: ReadonlyMap<string, number>,
  statusyNiepobrane: string[] = [],
  zamowieniaKompletne = true,
): Promise<string[]> {
  const out: string[] = []
  // część otwartych zamówień nie została pobrana (limit stron albo błąd BL) — zapis przeniósłby
  // tylko część, a reszta nigdy nie trafiłaby do Kompletora
  if (!zamowieniaKompletne) out.push('nie wszystkie otwarte zamówienia zostały pobrane z BL (limit stron albo błąd, patrz „problemy pobierania”) — zbierz dane od nowa')
  const nieCien = await db.channelConfig.findMany({
    where: KONTO_POZA_PODGLADEM,
    select: { channel: true, channelAccountId: true },
  })
  if (nieCien.length)
    out.push(`firma ma konta kanałów w trybie innym niż CIEN (${nieCien.map((c) => `${c.channel}/${c.channelAccountId}`).join(', ')}) — przeprowadzka zapisuje tylko do firmy w cieniu`)
  const obce = await db.inboundEvent.count({ where: { source: { not: ZRODLO_PRZEPROWADZKI } } })
  const nasze = await db.inboundEvent.count({ where: { source: ZRODLO_PRZEPROWADZKI } })
  const zamowien = await db.order.count()
  if (obce > 0 || (zamowien > 0 && nasze === 0))
    out.push('firma ma już zamówienia z własnych kanałów albo z panelu — pracuje w cieniu i nie jest celem przeprowadzki (tryb próbny działa)')
  const org = await db.organization.findFirst({ select: { settings: true } })
  const bl = settingsObj(settingsObj(org?.settings)['baselinker'])
  const inv = typeof bl['inventoryId'] === 'string' ? bl['inventoryId'] : null
  if (plan.katalog && inv && inv !== plan.katalog.id) out.push(`firma ma już ustawiony katalog BL ${inv}, a plan wskazuje ${plan.katalog.id}`)
  if (plan.bladKatalogu) out.push(plan.bladKatalogu)
  const blok = blokujaceStatusy(plan.statusy, otwartePoStatusie)
  if (blok.length)
    out.push(
      `statusy BL do decyzji z otwartymi zamówieniami: ${blok.map((d) => `${d.blStatusId} „${d.nazwa}” (${otwartePoStatusie.get(d.blStatusId)} zam.)`).join(', ')} — wpisz decyzję w pliku mapy (--mapa)`,
    )
  if (statusyNiepobrane.length) out.push(`mapa otwiera statusy ${statusyNiepobrane.join(', ')}, których zamówień zrzut nie zawiera — zbierz dane od nowa (bez --z-zrzutu)`)
  return out
}

export type Etap = 'konfiguracja' | 'produkty' | 'reguly' | 'zamowienia'

export interface WynikZapisu {
  runId: string
  konfiguracja: {
    kontaNowe: number
    kontaIstniejace: number
    magazyn: boolean
    /** statusy firmy z BL (nowe), grupy, ukryte domyślne; `blad` = zestaw nie przeszedł walidacji (nic nie zapisano). */
    statusyFirmy?: { nowe: number; grupy: number; ukryte: number; blad: string | null }
    /** reguły najbliższego szablonu w wyłączonej grupie „Z BaseLinkera” (0 = grupa już była albo nic nie pasuje). */
    automaty?: { szablon: string | null; reguly: number; pominiete: number; juzBylo: boolean }
  }
  katalog: PersistStats | null
  reguly: { zapisane: number; pozostawione: boolean; powod: string }
  zamowienia: WynikZamowienia[]
}

/** Etap 1: ustawienia firmy (katalog BL, mapa statusów), magazyn, konta kanałów w CIEN. Niczego nie nadpisuje. */
async function zapiszKonfiguracje(db: PrismaClient, plan: PlanKonfiguracji, runId: string, now: Date): Promise<WynikZapisu['konfiguracja']> {
  const org = await db.organization.findFirst({ select: { id: true, settings: true } })
  if (!org) throw new Error('Brak organizacji klienta (klient bez firmy?)')
  // statusy BL jako statusy firmy (klucz BL_<id>, drugi przebieg nic nie dubluje)
  const sf = await statusyFirmy(db)
  const planSt = planStatusowFirmy(plan.statusy, sf)
  const cur = settingsObj(org.settings)
  const bl = settingsObj(cur['baselinker'])
  const przeprowadzka = settingsObj(bl['przeprowadzka'])
  const pierwszy = !przeprowadzka['pierwszyZapis']
  const katalogUstawia = !bl['inventoryId'] && !!plan.katalog
  // katalog BL sprzed pierwszego zapisu (preset, cień) = firma za wyłącznikiem instancji; katalog
  // ustawiony przez przeprowadzkę zostaje zapisany jako jej (`katalogZapisu`), żeby późniejsza podmiana go nie udawała
  const pochodzenie: Record<string, Prisma.JsonValue> = {
    ...(pierwszy && bl['inventoryId'] ? { katalogPrzed: true } : {}),
    ...(katalogUstawia ? { katalogZapisu: plan.katalog!.id } : {}),
  }
  // mapa BL → klucz statusu firmy trafia do ustawień razem ze statusami (ta sama transakcja),
  // więc klucz w mapie zawsze wskazuje istniejący status; znacznik automatów dopiero po założeniu reguł
  const ustawienia: UstawieniaPrzeprowadzki = (mapa, automaty) => {
    const nextBl: Record<string, Prisma.JsonValue> = {
      ...bl,
      ...(katalogUstawia ? { inventoryId: plan.katalog!.id } : {}),
      statusy: doZapisu(plan.statusy, mapa) as unknown as Prisma.JsonValue,
      przeprowadzka: {
        ...przeprowadzka,
        ...pochodzenie,
        ...(automaty ? { automaty: automaty as unknown as Prisma.JsonValue } : {}),
        pierwszyZapis: przeprowadzka['pierwszyZapis'] ?? now.toISOString(),
        ostatniZapis: now.toISOString(),
        ostatniPrzebieg: runId,
      },
    }
    return { ...cur, baselinker: nextBl } as Prisma.InputJsonValue
  }
  const wh = await db.warehouse.createMany({ data: [{ id: DEFAULT_WAREHOUSE, name: 'Główny', stockSource: 'KOMPLETOR' }], skipDuplicates: true })
  let kontaNowe = 0
  const aktywne = plan.konta.filter((k) => !k.pominiete)
  for (const k of aktywne) {
    // tryby stanów, statusów, śledzenia i publikacji: domyślnie CIEN (schemat) — przeprowadzka nie przełącza kanałów
    const r = await db.channelConfig.createMany({
      data: [{ channel: k.channel, channelAccountId: k.channelAccountId, name: k.name, adapterKey: k.adapterKey, blStorageId: k.blStorageId, config: {} }],
      skipDuplicates: true,
    })
    kontaNowe += r.count
  }
  const { statusyFirmy: stF, automaty } = await zapiszStatusyIAutomaty(db, org.id, plan, planSt, sf, {
    ustawienia,
    automatyZalozone: znacznikAutomatowBl(org.settings) !== null,
    now,
  })
  return { kontaNowe, kontaIstniejace: aktywne.length - kontaNowe, magazyn: wh.count > 0, statusyFirmy: stF, automaty }
}

/** Ustawienia firmy po zapisie: mapa id statusu BL → klucz statusu firmy i (opcjonalnie) znacznik automatów. */
type UstawieniaPrzeprowadzki = (mapa: Record<string, string>, automaty?: ZnacznikAutomatowBl) => Prisma.InputJsonValue

/**
 * statusy i grupy z BL (createMany skipDuplicates: istniejące klucze zostają bez zmian), ukrycie
 * nietkniętych domyślnych statusów etapów pokrytych przez BL, reguły najbliższego szablonu w wyłączonej grupie
 * „Z BaseLinkera” (tylko gdy poprzedni zapis ich nie założył: znacznik w ustawieniach, nie nazwa grupy) i ustawienia
 * firmy z mapą statusów. Jedna transakcja; zły zestaw = żadnych statusów ani reguł, w mapie tylko klucze statusów,
 * które już są, powód w wyniku.
 */
async function zapiszStatusyIAutomaty(
  db: PrismaClient,
  orgId: string,
  plan: PlanKonfiguracji,
  planSt: ReturnType<typeof planStatusowFirmy>,
  sf: Awaited<ReturnType<typeof statusyFirmy>>,
  o: { ustawienia: UstawieniaPrzeprowadzki; automatyZalozone: boolean; now: Date },
) {
  const organizationId = organizationIdOf(db)
  const uzup = uzupelnienieEtapow(planSt, sf.statusy)
  const po = statusyPoPlanie(planSt, sf)
  const pelne = [...po.statusy, ...uzup]
  const blad = bladZestawu(pelne, po.grupy)
  const etapy = new Set(planSt.statusy.map((s) => s.etap))
  const aut = planAutomatow(pelne, etapy, plan.konta.filter((k) => !k.pominiete).map((k) => ({ typ: k.zrodlo.typ })), o.automatyZalozone)
  if (blad) {
    const istniejace = Object.fromEntries(planSt.statusy.filter((s) => s.juzJest).map((s) => [s.blStatusId, s.klucz]))
    await db.organization.update({ where: { id: orgId }, data: { settings: o.ustawienia(istniejace) } })
    return { statusyFirmy: { nowe: 0, grupy: 0, ukryte: 0, blad }, automaty: { szablon: aut.szablon?.id ?? null, reguly: 0, pominiete: 0, juzBylo: aut.juzJest } }
  }
  const nowe = [...statusyDoZapisu(planSt), ...uzup]
  return db.$transaction(async (tx) => {
    const g = planSt.grupy.length ? await tx.orderStatusGroup.createMany({ data: planSt.grupy.map((x) => ({ organizationId, ...x })), skipDuplicates: true }) : { count: 0 }
    const st = nowe.length ? await tx.orderStatusDef.createMany({ data: nowe.map((x) => ({ organizationId, ...x, carriers: [...x.carriers] })), skipDuplicates: true }) : { count: 0 }
    const uk = planSt.ukryteDomyslne.length ? await tx.orderStatusDef.updateMany({ where: { key: { in: planSt.ukryteDomyslne }, active: true }, data: { active: false } }) : { count: 0 }
    let reguly = 0
    let znacznik: ZnacznikAutomatowBl | undefined
    if (!aut.juzJest && aut.reguly.length && aut.szablon) {
      const z = await zalozReguly(tx, organizationId, { grupy: [], reguly: aut.reguly }, { grupaZbiorcza: GRUPA_AUTOMATOW_BL, wlaczone: false })
      reguly = z.reguly
      znacznik = { szablon: aut.szablon.id, grupaId: z.grupaId, reguly, kiedy: o.now.toISOString() }
    }
    await tx.organization.update({ where: { id: orgId }, data: { settings: o.ustawienia(planSt.mapa, znacznik) } })
    return { statusyFirmy: { nowe: st.count, grupy: g.count, ukryte: uk.count, blad: null }, automaty: { szablon: aut.szablon?.id ?? null, reguly, pominiete: aut.nieprzeniesione.length, juzBylo: aut.juzJest } }
  })
}

type RuleKey = CarrierRuleT
const ruleKey = (r: RuleKey) => `${r.priority}|${r.channel ?? ''}|${r.pattern ?? ''}|${r.carrier}|${r.shippingModule}|${r.adapterKey ?? ''}`
const sameRules = (a: RuleKey[], b: RuleKey[]) => a.length === b.length && a.map(ruleKey).sort().join('\n') === b.map(ruleKey).sort().join('\n')

/** Odcisk zestawu reguł (posortowane klucze): porównanie bez kolejności i bez id wierszy. */
export const odciskRegul = (r: RuleKey[]) => r.map(ruleKey).sort().join('\n')

export interface DecyzjaRegul {
  /** Reguły, które będą obowiązywać po zapisie (plan albo bieżące reguły firmy). */
  reguly: CarrierRuleT[]
  zastapi: boolean
  pozostawione: boolean
  powod: string
}

/**
 * Które reguły przewoźników będą obowiązywać po zapisie (czysty odczyt; tę samą decyzję liczy tryb próbny i zapis).
 * Plan zastępuje reguły firmy, gdy są puste, nietknięte startowe (`DEFAULT_CARRIER_RULES`)
 * albo równe odciskowi zapisanemu przez poprzedni zapis przeprowadzki (`settings.baselinker.przeprowadzka.reguly`):
 * decyzja dopisana w mapie po pierwszym `--zapisz` wchodzi przy drugim. Reguły zmienione przez człowieka zostają.
 */
export async function decyzjaRegul(db: PrismaClient, plan: PlanKonfiguracji): Promise<DecyzjaRegul> {
  const cur = await db.carrierRule.findMany({ select: { priority: true, channel: true, pattern: true, carrier: true, shippingModule: true, adapterKey: true } })
  const planned = plan.reguly.map((r) => ({ priority: r.priority, channel: r.channel, pattern: r.pattern, carrier: r.carrier, shippingModule: r.shippingModule, adapterKey: r.adapterKey ?? null }))
  if (sameRules(cur, planned)) return { reguly: planned, zastapi: false, pozostawione: false, powod: 'reguły już takie jak w planie' }
  if (!cur.length) return { reguly: planned, zastapi: true, pozostawione: false, powod: 'reguły z planu' }
  const start = (rules: readonly CarrierRuleT[]) => rules.map((r) => ({ ...r, adapterKey: r.adapterKey ?? null }))
  if (sameRules(cur, start(DEFAULT_CARRIER_RULES)) || sameRules(cur, start(LEGACY_DEFAULT_CARRIER_RULES))) return { reguly: planned, zastapi: true, pozostawione: false, powod: 'startowe reguły zastąpione planem' }
  const org = await db.organization.findFirst({ select: { settings: true } })
  const zapisany = settingsObj(settingsObj(settingsObj(org?.settings)['baselinker'])['przeprowadzka'])['reguly']
  if (typeof zapisany === 'string' && zapisany === odciskRegul(cur))
    return { reguly: planned, zastapi: true, pozostawione: false, powod: 'reguły z poprzedniego zapisu przeprowadzki zastąpione planem (nowe decyzje z mapy)' }
  return { reguly: cur, zastapi: false, pozostawione: true, powod: 'firma ma własne reguły przewoźników — przeprowadzka ich nie zmienia' }
}

/** Etap reguł przewoźników wg `decyzjaRegul`; po zapisie odcisk reguł trafia do ustawień firmy. */
async function zapiszReguly(db: PrismaClient, plan: PlanKonfiguracji): Promise<WynikZapisu['reguly']> {
  const d = await decyzjaRegul(db, plan)
  if (d.zastapi) await db.$transaction([db.carrierRule.deleteMany({}), db.carrierRule.createMany({ data: d.reguly })])
  if (!d.pozostawione) await zapamietajOdcisk(db, odciskRegul(d.reguly))
  return { zapisane: d.zastapi ? d.reguly.length : 0, pozostawione: d.pozostawione, powod: d.powod }
}

async function zapamietajOdcisk(db: PrismaClient, odcisk: string): Promise<void> {
  const org = await db.organization.findFirst({ select: { id: true, settings: true } })
  if (!org) return
  const cur = settingsObj(org.settings)
  const bl = settingsObj(cur['baselinker'])
  const przeprowadzka = settingsObj(bl['przeprowadzka'])
  if (przeprowadzka['reguly'] === odcisk) return
  const next = { ...cur, baselinker: { ...bl, przeprowadzka: { ...przeprowadzka, reguly: odcisk } } }
  await db.organization.update({ where: { id: org.id }, data: { settings: next as Prisma.InputJsonValue } })
}

/**
 * Tryb próbny: zamówienia przeniesione wcześniej (zamówienie z tym `blOrderId` w firmie) zapis odda jako DUPLIKAT,
 * a rdzeń nie przelicza ich statusu ani przewoźnika — pokazujemy status z bazy.
 */
export async function juzPrzeniesione(db: PrismaClient, wyniki: WynikZamowienia[]): Promise<WynikZamowienia[]> {
  const ids = wyniki.map((w) => Number(w.blOrderId)).filter((n) => Number.isSafeInteger(n))
  if (!ids.length) return wyniki
  const byBl = new Map((await db.order.findMany({ where: { blOrderId: { in: ids } }, select: { blOrderId: true, status: true } })).map((o) => [String(o.blOrderId), o.status]))
  return wyniki.map((w) => (byBl.has(w.blOrderId) ? { ...w, wynik: 'DUPLIKAT' as const, status: byBl.get(w.blOrderId)! } : w))
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 2000)

export interface ZapisOpts {
  now?: Date
  /** Do testów przerwania: wołane po każdym zakończonym etapie (wyjątek = przerwanie przebiegu). */
  poEtapie?: (etap: Etap) => void | Promise<void>
}

/**
 * Zapis przeprowadzki. Przed zapisem ponownie sprawdza powody odmowy (firma mogła się zmienić od trybu próbnego).
 * ImportRun `PRZEPROWADZKA` z liczbami w `stats`; sprawy do decyzji i błędy rekordów jako ImportIssue (bez danych
 * klientów: id statusów, metody dostawy, id zamówień BL, SKU).
 */
export async function zapiszPrzeprowadzke(
  db: PrismaClient,
  dane: ZebraneDane,
  plan: PlanKonfiguracji,
  analiza: Analysis | null,
  zamowienia: { o: BlZamowienie; konto: KontoPlan }[],
  otwartePoStatusie: ReadonlyMap<string, number>,
  opts: ZapisOpts = {},
): Promise<WynikZapisu> {
  const now = opts.now ?? new Date()
  const powody = await powodyOdmowy(db, plan, otwartePoStatusie, [], dane.zamowienia.complete)
  if (powody.length) throw new OdmowaZapisu(powody)
  const run = await db.importRun.create({ data: { kind: RODZAJ_PRZEBIEGU } })
  const issue = (kind: string, ref: string, message: string) => db.importIssue.create({ data: { runId: run.id, kind, ref: ref.slice(0, 200), message: message.slice(0, 2000) } }).catch(() => {})
  const done = async (etap: Etap) => {
    await opts.poEtapie?.(etap)
  }
  try {
    const konfiguracja = await zapiszKonfiguracje(db, plan, run.id, now)
    await done('konfiguracja')
    const katalog = dane.katalog && analiza ? await persistImport(db, dane.katalog, analiza, { actor: 'system:przeprowadzka-bl', now }) : null
    await done('produkty')
    const reguly = await zapiszReguly(db, plan)
    await done('reguly')
    const wyniki = await przeniesZamowienia(db, zamowienia, { now })
    await done('zamowienia')

    for (const d of plan.statusy.filter((x) => x.pewnosc === 'DO_DECYZJI')) await issue('decyzja:status', d.blStatusId, `status BL „${d.nazwa}”: ${d.powod}; teraz ${d.status}`)
    for (const d of plan.decyzjePrzewoznikow) await issue('decyzja:przewoznik', d.metoda, `${d.powod} (${d.zamowien} zam.)${d.podpowiedz ? `, podpowiedź ${d.podpowiedz}` : ''}`)
    for (const k of plan.konta.filter((x) => x.ostrzezenie)) await issue('decyzja:zrodlo', `${k.zrodlo.typ}:${k.zrodlo.id}`, k.ostrzezenie!)
    if (reguly.pozostawione) await issue('decyzja:reguly', 'CarrierRule', reguly.powod)
    for (const w of wyniki.filter((x) => x.wynik === 'BLAD')) await issue('zamowienie', w.blOrderId, w.blad ?? 'błąd')
    for (const w of wyniki.filter((x) => x.pozycjeBezPowiazania > 0)) await issue('decyzja:oferta', w.blOrderId, `${w.pozycjeBezPowiazania} z ${w.pozycje} pozycji bez powiązania z produktem — zamówienie DO_WYJASNIENIA`)
    for (const i of dane.issues) await issue(`pobieranie:${i.kind}`, i.ref, i.message)

    const stats = statystyki({ konfiguracja, katalog, reguly, zamowienia: wyniki }, plan)
    const bledy = wyniki.some((w) => w.wynik === 'BLAD') || (katalog?.status ?? 'OK') !== 'OK' || dane.issues.length > 0
    await db.importRun.update({ where: { id: run.id }, data: { status: bledy ? 'PARTIAL' : 'OK', finishedAt: new Date(), stats: stats as unknown as Prisma.InputJsonValue } })
    return { runId: run.id, konfiguracja, katalog, reguly, zamowienia: wyniki }
  } catch (e) {
    await db.importRun.update({ where: { id: run.id }, data: { status: 'FAILED', finishedAt: new Date(), error: errMsg(e) } }).catch(() => {})
    throw e
  }
}

/** Liczby do ImportRun.stats (i panelu): same liczby i identyfikatory konfiguracji, bez danych klientów. */
export function statystyki(w: Omit<WynikZapisu, 'runId'>, plan: PlanKonfiguracji): Record<string, number | string | null> {
  const z = w.zamowienia
  return {
    katalogBl: plan.katalog?.id ?? null,
    kontaNowe: w.konfiguracja.kontaNowe,
    kontaIstniejace: w.konfiguracja.kontaIstniejace,
    produkty: w.katalog?.products ?? 0,
    zestawy: w.katalog?.bundles ?? 0,
    stanyNowe: w.katalog?.stocksCreated ?? 0,
    stanyIstniejace: w.katalog?.stocksKept ?? 0,
    oferty: w.katalog?.channelOffers ?? 0,
    ofertyDoZatwierdzenia: w.katalog?.channelOffersProposed ?? 0,
    regulyPrzewoznikow: w.reguly.zapisane,
    zamowieniaNowe: z.filter((x) => x.wynik === 'NOWE').length,
    zamowieniaDuplikaty: z.filter((x) => x.wynik === 'DUPLIKAT').length,
    zamowieniaDoWyjasnienia: z.filter((x) => x.status === 'DO_WYJASNIENIA').length,
    zamowieniaBledy: z.filter((x) => x.wynik === 'BLAD').length,
    statusyDoDecyzji: plan.statusy.filter((d) => d.pewnosc === 'DO_DECYZJI').length,
    przewoznicyDoDecyzji: plan.decyzjePrzewoznikow.length,
    zrodlaBezAdaptera: plan.konta.filter((k) => k.ostrzezenie).length,
  }
}

export interface RoznicaStanu {
  sku: string
  kompletor: number
  zrodlo: number
}

/**
 * Produkty, które mają już stan w Kompletorze różny od źródła (wFirma albo magazyn BL). Istniejący Stock nie jest
 * nadpisywany — różnica idzie do raportu. Tylko odczyt (działa też w trybie próbnym).
 */
export async function roznicStanow(db: PrismaClient, analiza: Analysis): Promise<RoznicaStanu[]> {
  const planned = analiza.plan.products
    .filter((p) => p.kind === 'STOCKED')
    .map((p) => ({ sku: p.sku, wfId: p.wf?.id ?? null, count: p.wf ? p.wf.countBase : p.startStock }))
    .filter((p): p is { sku: string; wfId: string | null; count: number } => p.count !== undefined)
  if (!planned.length) return []
  const wfIds = planned.map((p) => p.wfId).filter((x): x is string => !!x)
  const rows = await db.product.findMany({
    where: { OR: [{ sku: { in: planned.map((p) => p.sku) } }, ...(wfIds.length ? [{ wfirmaGoodId: { in: wfIds } }] : [])] },
    select: { sku: true, wfirmaGoodId: true, stocks: { where: { warehouseId: DEFAULT_WAREHOUSE }, select: { physical: true } } },
  })
  const bySku = new Map(rows.map((r) => [r.sku, r]))
  const byWf = new Map(rows.filter((r) => r.wfirmaGoodId).map((r) => [r.wfirmaGoodId!, r]))
  const out: RoznicaStanu[] = []
  for (const p of planned) {
    const r = (p.wfId ? byWf.get(p.wfId) : undefined) ?? bySku.get(p.sku)
    const st = r?.stocks[0]
    if (st && st.physical !== p.count) out.push({ sku: p.sku, kompletor: st.physical, zrodlo: p.count })
  }
  return out
}
