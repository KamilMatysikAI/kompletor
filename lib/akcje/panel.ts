// Odczyty ekranu „Plan akcji (cień)”. Klient firmy z sesji (RLS); systemowy = błąd, jak w lib/panel/dane.ts.
// Bez danych klientów: numer zamówienia z przedrostkiem i SKU pochodzą ze zmiennych planu.
import type { ActionMode, ActionState, PrismaClient } from '@prisma/client'
import { organizationIdOf } from '../db'
import { addDays, fromWarsaw, toWarsaw } from '../rdzen/kalendarz'
import { isKluczReguly, KLUCZE_REGUL, type KluczReguly } from './reguly'
import { panelBaseUrl } from '../auth/zaproszenia'
import { kontekstFirmy, kontekstKontaKanalu, ustawieniaMarki } from '../poczta/marka'
import { nadpisaniaFirmy } from '../poczta/szablony'
import { numerDoMaila, przesylkaDoMaila, zamowienieDoMaila, zwrotPlanu } from '../poczta/wysylka'
import { podgladAkcji, UWAGA_FIRMA, type Podglad, type ZrodloPodgladu } from './podglad'
import { maileZwrotowFirmy, REGULY_ZWROTOW } from './maile-zwrotow'
import { brakiDanychPrzelewu, danePrzelewu, informacjaBezDanychPrzelewu, wariantPrzypomnienia } from './wariant-platnosci'

type Db = PrismaClient

export interface LiczbaReguly {
  rule: KluczReguly
  SUCHO: number
  PRACA: number
  pominiete: number
}

export interface WierszPlanu {
  id: string
  rule: KluczReguly
  cel: string // „SD 48213” albo SKU produktu
  targetType: 'ZAMOWIENIE' | 'PRODUKT'
  targetId: string
  dueAt: Date
  mode: ActionMode
  state: ActionState
  reason: string | null
  /** stan wysyłki maila (MailDelivery); null = jeszcze bez próby. Adres tylko zamaskowany. */
  poczta: { stan: string; blad: string | null; adresat: string | null } | null
}

export interface PlanDnia {
  dzien: string // RRRR-MM-DD (Warszawa)
  liczby: LiczbaReguly[]
  wiersze: WierszPlanu[]
  razem: number
  /** akcje pracy tego dnia czekające na wysyłkę bez żadnej próby (np. poczta niewłączona). */
  czekaNaPoczte: number
}

const LIMIT = 300

/** Plan dnia (Warszawa): liczby per reguła i tryb oraz lista od najnowszych (do 300 wierszy). */
export async function planDnia(db: Db, dzien?: string, now = new Date()): Promise<PlanDnia> {
  organizationIdOf(db)
  const day = dzien && /^\d{4}-\d{2}-\d{2}$/.test(dzien) ? dzien : toWarsaw(now).day
  const where = { dueAt: { gte: fromWarsaw(day, 0), lt: fromWarsaw(addDays(day, 1), 0) } }
  const [grupy, rows] = await Promise.all([
    db.plannedAction.groupBy({ by: ['rule', 'mode', 'state'], where, _count: { _all: true } }),
    db.plannedAction.findMany({ where, orderBy: [{ dueAt: 'desc' }, { id: 'asc' }], take: LIMIT }),
  ])
  const liczby: LiczbaReguly[] = KLUCZE_REGUL.map((rule) => ({ rule, SUCHO: 0, PRACA: 0, pominiete: 0 }))
  for (const g of grupy) {
    const l = liczby.find((x) => x.rule === g.rule)
    if (!l) continue
    if (g.state === 'SKIPPED') l.pominiete += g._count._all
    else l[g.mode] += g._count._all
  }
  const poczta = rows.length
    ? await db.mailDelivery.findMany({ where: { plannedActionId: { in: rows.map((r) => r.id) } }, select: { plannedActionId: true, state: true, lastError: true, recipient: true } })
    : []
  const wysylki = new Map(poczta.map((d) => [d.plannedActionId, { stan: d.state, blad: d.lastError, adresat: d.recipient }]))
  const wiersze = rows.filter((r) => isKluczReguly(r.rule)).map((r) => ({
    id: r.id,
    rule: r.rule as KluczReguly,
    cel: celPlanu(r.targetType, r.vars),
    targetType: r.targetType,
    targetId: r.targetId,
    dueAt: r.dueAt,
    mode: r.mode,
    state: r.state,
    reason: r.reason,
    poczta: wysylki.get(r.id) ?? null,
  }))
  const czekaNaPoczte = wiersze.filter((w) => w.mode === 'PRACA' && w.state === 'PLANNED' && !w.poczta).length
  // maile o zwrotach: wiersze liczników tylko przy włączonym wyłączniku firmy albo z planami tego dnia (wyłączony = ekran jak dotąd)
  const zeZwrotami = (await maileZwrotowFirmy(db)) !== null
  const widoczne = liczby.filter((l) => zeZwrotami || !(REGULY_ZWROTOW as readonly string[]).includes(l.rule) || l.SUCHO + l.PRACA + l.pominiete > 0)
  return { dzien: day, liczby: widoczne, wiersze, razem: liczby.reduce((s, l) => s + l.SUCHO + l.PRACA + l.pominiete, 0), czekaNaPoczte }
}

function celPlanu(t: 'ZAMOWIENIE' | 'PRODUKT', vars: unknown): string {
  const v = vars && typeof vars === 'object' ? (vars as Record<string, unknown>) : {}
  const s = t === 'ZAMOWIENIE' ? v.numerZamowienia : v.sku
  return typeof s === 'string' && s ? s : '—'
}

/**
 * Podgląd treści jednej akcji planu (na żądanie) z danymi firmy: marka i stopka z ustawień, szablony firmy, pozycje
 * zamówienia i numer faktury tak, jak w wysyłce (lib/poczta/wysylka.ts). Bez imienia i adresu klienta. Brak wiersza
 * w firmie z sesji = null.
 */
export async function podgladPlanu(db: Db, id: string, env: Record<string, string | undefined> = process.env): Promise<(Podglad & { rule: KluczReguly; cel: string }) | null> {
  organizationIdOf(db)
  const r = await db.plannedAction.findUnique({ where: { id } })
  if (!r || !isKluczReguly(r.rule)) return null
  const vars = r.vars && typeof r.vars === 'object' && !Array.isArray(r.vars) ? (r.vars as Record<string, unknown>) : {}
  const z = await zrodloFirmy(db, r.rule, r.targetType, r.targetId, vars, env)
  return { ...podgladAkcji(r.rule, vars, z), rule: r.rule, cel: celPlanu(r.targetType, r.vars) }
}

const BRAK_PDF_SPOZA =
  'Tej faktury nie wystawił Kompletor, więc nie ma jej pliku PDF: wysyłając sam, Kompletor nie wyśle tego maila (czeka na plik do 7 dni, potem go pomija).'
const BEZ_NUMERU =
  'Program do faktur nie podał numeru tej faktury, dlatego mail wyjdzie bez numeru w temacie i treści („Faktura do zamówienia …”). Numer jest w pliku PDF w załączniku.'
const BRAK_MAILI_ZWROTOW =
  'Maile o zwrotach i reklamacjach są wyłączone: Kompletor nie wyśle tego maila. Włączysz je w Ustawienia → Sprzedaż i kanały → Automatyczne akcje.'
const BRAK_ZWROTU = 'Tego zwrotu nie ma już przy zamówieniu (usunięty albo z innego zamówienia): Kompletor nie wyśle tego maila.'

async function zrodloFirmy(db: Db, rule: KluczReguly, targetType: 'ZAMOWIENIE' | 'PRODUKT', targetId: string, vars: Record<string, unknown>, env: Record<string, string | undefined>): Promise<ZrodloPodgladu> {
  const [ustawienia, nadpisania] = await Promise.all([ustawieniaMarki(db), nadpisaniaFirmy(db)])
  const panel = panelBaseUrl(env)
  const z: Omit<ZrodloPodgladu, 'kontekst'> = { nadpisania, panel, uwaga: UWAGA_FIRMA, braki: [] }
  if (targetType === 'PRODUKT') {
    const p = await db.product.findUnique({ where: { id: targetId }, select: { nameAccounting: true } })
    return { ...z, kontekst: (await kontekstFirmy(db, ustawienia)).kontekst, nazwaProduktu: p?.nameAccounting ?? null }
  }
  const o = await zamowienieDoMaila(db, targetId)
  // zamówienie usunięte: marka firmy bez konta kanału (jak maile do biura)
  const kontekst = o ? (await kontekstKontaKanalu(db, ustawienia, o.channel, o.channelAccountId)).kontekst : (await kontekstFirmy(db, ustawienia)).kontekst
  const out: ZrodloPodgladu = { ...z, kontekst, pozycje: o?.pozycje.length ? o.pozycje : null, idZamowienia: o?.id ?? null }
  if (rule === 'mail.brak-platnosci' && o) {
    // wariant jak w wysyłce: ze stanu zamówienia teraz, dane do przelewu (rachunek, pełna nazwa) z Danych firmy;
    // bez nich zwykły „Brak płatności” i informacja dla biura, czego brakuje
    out.wariant = wariantPrzypomnienia(o)
    if (out.wariant === 'nieudana-platnosc') {
      const settings = (await db.organization.findFirst({ select: { settings: true } }))?.settings
      const przelew = danePrzelewu(settings)
      if (przelew) {
        out.rachunek = przelew.rachunek
        out.odbiorcaPrzelewu = przelew.odbiorca
        out.numerWSklepie = o.channelNumber ?? o.externalId
        out.towarZwolniony = !!o.stockReleasedAt
      } else {
        out.wariant = 'brak-platnosci'
        out.informacje = [`${informacjaBezDanychPrzelewu(brakiDanychPrzelewu(settings))}.`]
      }
    }
  }
  if (o && typeof vars.numerZamowienia === 'string' && vars.numerZamowienia.trim()) out.numerZamowienia = numerDoMaila(vars.numerZamowienia, o)
  if (rule === 'mail.faktura') {
    // numer przesyłki i link śledzenia jak w wysyłce; błąd odczytu = podgląd bez nich
    if (o) Object.assign(out, await przesylkaDoMaila(db, o.id).catch(() => ({})))
    const docId = typeof vars.wfirmaDocId === 'string' ? vars.wfirmaDocId.trim() : ''
    // ta sama faktura co w wysyłce (lib/poczta/dokument-pdf.ts): wystawiona w Kompletorze z tym dokumentem
    const f = docId && o ? await db.invoiceAttempt.findFirst({ where: { orderId: o.id, state: 'ISSUED', wfirmaDocId: docId }, orderBy: { attemptNo: 'desc' }, select: { number: true } }) : null
    if (f?.number?.trim()) out.numerFaktury = f.number.trim()
    else if (f) {
      // jak w wysyłce: mail bez numeru, nie z identyfikatorem dokumentu; to nie brak ustawień, mail wychodzi
      out.numerFaktury = null
      out.informacje = [...(out.informacje ?? []), BEZ_NUMERU]
    }
    // dokument spoza Kompletora (kopia faktury z BaseLinkera): w planie stoi już numer dokumentu, nie identyfikator
    else out.braki!.push(BRAK_PDF_SPOZA)
  }
  if ((REGULY_ZWROTOW as readonly string[]).includes(rule)) {
    // te same zwrócone produkty i ten sam wyłącznik co w wysyłce (lib/poczta/wysylka.ts); bez danych klienta
    const [wlaczoneOd, zw] = await Promise.all([maileZwrotowFirmy(db), o ? zwrotPlanu(db, typeof vars.returnId === 'string' ? vars.returnId : null, o.id) : null])
    out.pozycje = zw?.pozycje.length ? zw.pozycje : null
    if (!wlaczoneOd) out.braki!.push(BRAK_MAILI_ZWROTOW)
    if (o && !zw) out.braki!.push(BRAK_ZWROTU)
  }
  return out
}
