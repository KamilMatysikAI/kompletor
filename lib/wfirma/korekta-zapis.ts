// `KorektyWfirma` z ZAPISEM w wFirmie: korekta faktury przy zwrocie, wołana przez kolejkę wFirmy
// (lib/rdzen/kolejka-wfirmy.ts → `issueCorrection` w lib/rdzen/zwroty.ts) i dostawcę dokumentów (zdolność `koryguj`,
// lib/wfirma/dostawca.ts). Worker podaje go tylko przy programie wFirma, włączonym „Wystawiaj faktury z Kompletora”
// i osobnym wyłączniku „Korekty faktur przy zwrotach z Kompletora” (`korektyWlaczone`, lib/dokumenty/ustawienia.ts;
// lib/worker/zadania.ts). Pierwsza prawdziwa korekta firmy wymaga osobnego GO właściciela, tak jak pierwsza faktura:
// w testach wyłącznie atrapy.
//
// Bezpieczniki przed zapisem (każdy = błąd jednoznaczny, korekta nie wychodzi, alert z kolejki):
//   - zwrot musi istnieć, być w statusie „W trakcie” (KOREKTA) i korygować tę fakturę,
//   - konto sklepu zamówienia w trybie Aktywny (`ChannelConfig.statusMode = PRACA`); podgląd = korekta poza Kompletorem,
//   - każdy zwracany produkt ma towar wFirmy i pozycję na korygowanej fakturze, a zwracana ilość nie przekracza ilości
//     z faktury,
//   - faktura nie ma jeszcze korekty z innego zwrotu (przeglądu: druga korekta liczona od faktury pierwotnej
//     podniosłaby ilość z powrotem; `innaKorektaFaktury`).
// Błąd odczytu faktury przed zapisem, którego ponowienie nic nie da (np. faktury nie ma w wFirmie), = błąd jednoznaczny
// korekta na pewno nie wyszła, bez pętli niewiadomej.
// Kontrola po zapisie: po `OK` odczyt `invoices/get/<id korekty>` i porównanie ilości pozycji z oczekiwanymi.
// Niezgodność albo nieudany odczyt nie zmieniają wyniku (dokument istnieje), tylko dokładają ostrzeżenie (alert).
// Treść korekty składa czysta funkcja `zlozKorekte` z faktury pierwotnej czytanej `invoices/get` (tylko odczyt).
// [NIEPEWNE] Kształt korekty w API2 wFirmy (`type: correction`, `parent.id` faktury i pozycji, ilość PO korekcie):
// przed pierwszym GO sprawdzić na koncie testowym wFirmy (docs/zwroty-i-reklamacje.md, „Przed pierwszą korektą”).
// PZ z korekty nie czytamy: `pz` = brak danych, więc pozycje „na stan” idą na listę „korekta bez PZ” (biuro potwierdza).
import type { PrismaClient } from '@prisma/client'
import { type CorrectionResult, type FoundCorrection, innaKorektaFaktury, type KorektyWfirma, type OstrzezenieKorekty } from '../rdzen/zwroty'
import { WfirmaLimitError } from '../rdzen/rozchod'
import { SourceError } from '../zrodla/http'
import { type WfirmaReadOnly, wfirmaItems } from '../zrodla/wfirma'
import type { WynikWystawienia } from '../zrodla/wfirma-zapis'

export interface PozycjaFakturyWfirmy {
  /** id pozycji faktury w wFirmie (`invoicecontent.id`). */
  id: string
  /** id towaru wFirmy (`good.id`); null = pozycja bez towaru (np. wysyłka). */
  towarId: string | null
  ilosc: number
  nazwa: string
}

export interface ZwrotDoKorekty {
  towarId: string
  /** Ilość w jednostce wFirmy (szt. albo kg). */
  ilosc: number
}

/** `oczekiwane`: id pozycji faktury → ilość PO korekcie (do kontroli po zapisie). */
export type WynikZlozeniaKorekty = { ok: true; tresc: { invoices: { invoice: Record<string, unknown> } }; oczekiwane: Map<string, number> } | { ok: false; problem: string }

/** Pozycje faktury z odpowiedzi `invoices/get/<id>` (`invoices.0.invoice.invoicecontents.N.invoicecontent`). */
function trescPozycji(json: unknown): Record<string, unknown>[] {
  const inv = wfirmaItems<Record<string, unknown>>((json as Record<string, unknown> | null)?.['invoices'], 'invoice')[0]
  return inv ? wfirmaItems<Record<string, unknown>>(inv['invoicecontents'], 'invoicecontent') : []
}

function pozycja(c: Record<string, unknown>): PozycjaFakturyWfirmy | null {
  const id = c['id'] === undefined || c['id'] === null ? '' : String(c['id'])
  if (!/^\d+$/.test(id)) return null
  const good = c['good'] && typeof c['good'] === 'object' ? (c['good'] as Record<string, unknown>)['id'] : null
  const towarId = good === undefined || good === null || String(good) === '0' ? null : String(good)
  const ilosc = Number(c['count'])
  return { id, towarId, ilosc: Number.isFinite(ilosc) ? ilosc : 0, nazwa: typeof c['name'] === 'string' ? c['name'] : '' }
}

export function pozycjeFaktury(json: unknown): PozycjaFakturyWfirmy[] {
  return trescPozycji(json).flatMap((c) => {
    const p = pozycja(c)
    return p ? [p] : []
  })
}

const zaokr = (v: number) => Math.round(v * 1000) / 1000
const fmt = (v: number) => String(zaokr(v)).replace('.', ',')

/** Pozycja korekty z odpowiedzi `invoices/get/<id korekty>`: jak pozycja faktury plus `parent.id`, jeśli wFirma go oddaje. */
export interface PozycjaKorektyWfirmy extends PozycjaFakturyWfirmy {
  rodzicId: string | null
}

export function pozycjeKorekty(json: unknown): PozycjaKorektyWfirmy[] {
  return trescPozycji(json).flatMap((c) => {
    const p = pozycja(c)
    if (!p) return []
    const par = c['parent'] && typeof c['parent'] === 'object' ? (c['parent'] as Record<string, unknown>)['id'] : null
    const rodzicId = par === undefined || par === null || !/^\d+$/.test(String(par)) || String(par) === '0' ? null : String(par)
    return [{ ...p, rodzicId }]
  })
}

/**
 * porównanie korekty odczytanej z wFirmy z oczekiwanymi ilościami PO korekcie. Gdy każda pozycja
 * korekty niesie `parent.id`, porównanie pozycja do pozycji; inaczej sumy per towar (pozycja bez towaru, np. wysyłka,
 * po nazwie). Wynik: lista niezgodności po polsku (pusta = zgodna).
 */
export function porownajKorekte(faktura: PozycjaFakturyWfirmy[], oczekiwane: Map<string, number>, korekta: PozycjaKorektyWfirmy[]): string[] {
  const zle: string[] = []
  const zgodne = (a: number, b: number) => Math.abs(a - b) < 0.0005
  if (!korekta.length) return ['korekta bez pozycji w odpowiedzi wFirmy']
  if (korekta.every((k) => k.rodzicId !== null)) {
    const wg = new Map<string, PozycjaKorektyWfirmy[]>()
    for (const k of korekta) wg.set(k.rodzicId!, [...(wg.get(k.rodzicId!) ?? []), k])
    for (const p of faktura) {
      const po = oczekiwane.get(p.id) ?? p.ilosc
      const jest = wg.get(p.id)
      wg.delete(p.id)
      const nazwa = p.nazwa || `pozycja ${p.id}`
      if (!jest) zle.push(`${nazwa}: brak pozycji w korekcie (powinno być ${fmt(po)})`)
      else if (jest.length > 1) zle.push(`${nazwa}: ${jest.length} pozycje w korekcie zamiast jednej`)
      else if (!zgodne(jest[0]!.ilosc, po)) zle.push(`${nazwa}: jest ${fmt(jest[0]!.ilosc)}, powinno być ${fmt(po)}`)
    }
    for (const [, ks] of wg) for (const k of ks) zle.push(`${k.nazwa || `pozycja ${k.id}`}: pozycja spoza korygowanej faktury (${fmt(k.ilosc)})`)
    return zle
  }
  const klucz = (p: { towarId: string | null; nazwa: string }) => (p.towarId ? `towar:${p.towarId}` : `nazwa:${p.nazwa}`)
  const chce = new Map<string, { nazwa: string; ilosc: number }>()
  for (const p of faktura) {
    const k = klucz(p)
    const e = chce.get(k)
    chce.set(k, { nazwa: e?.nazwa || p.nazwa || k, ilosc: zaokr((e?.ilosc ?? 0) + (oczekiwane.get(p.id) ?? p.ilosc)) })
  }
  const jest = new Map<string, { nazwa: string; ilosc: number }>()
  for (const p of korekta) {
    const k = klucz(p)
    const e = jest.get(k)
    jest.set(k, { nazwa: e?.nazwa || p.nazwa || k, ilosc: zaokr((e?.ilosc ?? 0) + p.ilosc) })
  }
  for (const [k, c] of chce) {
    const j = jest.get(k)
    jest.delete(k)
    if (!j) zle.push(`${c.nazwa}: brak pozycji w korekcie (powinno być ${fmt(c.ilosc)})`)
    else if (!zgodne(j.ilosc, c.ilosc)) zle.push(`${c.nazwa}: jest ${fmt(j.ilosc)}, powinno być ${fmt(c.ilosc)}`)
  }
  for (const [, j] of jest) zle.push(`${j.nazwa}: pozycja spoza korygowanej faktury (${fmt(j.ilosc)})`)
  return zle
}

/**
 * Treść korekty: każda pozycja faktury z `parent.id` i ilością PO korekcie (ilość z faktury minus zwrot). Zwrot
 * rozkłada się po pozycjach tego samego towaru od góry. Zwrot towaru, którego nie ma na fakturze, albo większy niż
 * na fakturze = problem (bez treści).
 */
export function zlozKorekte(w: { fakturaId: string; idExternal: string; pozycje: PozycjaFakturyWfirmy[]; zwrot: ZwrotDoKorekty[]; opis: string }): WynikZlozeniaKorekty {
  if (!/^\d+$/.test(w.fakturaId)) return { ok: false, problem: 'niepoprawny numer faktury w wFirmie' }
  if (!w.zwrot.length) return { ok: false, problem: 'korekta bez pozycji' }
  const zostalo = new Map<string, number>()
  for (const z of w.zwrot) {
    if (!(z.ilosc > 0)) return { ok: false, problem: `ilość zwrotu towaru ${z.towarId} nie jest dodatnia` }
    zostalo.set(z.towarId, zaokr((zostalo.get(z.towarId) ?? 0) + z.ilosc))
  }
  const oczekiwane = new Map<string, number>()
  const tresci = w.pozycje.map((p) => {
    let po = p.ilosc
    const zw = p.towarId ? (zostalo.get(p.towarId) ?? 0) : 0
    if (zw > 0) {
      const ile = Math.min(zw, p.ilosc)
      po = zaokr(p.ilosc - ile)
      zostalo.set(p.towarId!, zaokr(zw - ile))
    }
    oczekiwane.set(p.id, po)
    return { invoicecontent: { parent: { id: p.id }, count: po } }
  })
  const nadmiar = [...zostalo].filter(([, v]) => v > 0)
  if (nadmiar.length) return { ok: false, problem: `zwrot większy niż na fakturze albo towaru nie ma na fakturze: ${nadmiar.map(([t, v]) => `towar ${t} (${v})`).join(', ')}`.slice(0, 400) }
  return {
    ok: true,
    oczekiwane,
    tresc: { invoices: { invoice: { type: 'correction', parent: { id: w.fakturaId }, id_external: w.idExternal, description: w.opis.slice(0, 200), invoicecontents: tresci } } },
  }
}

async function zLimitem<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof SourceError && !e.retryable && /limit/i.test(e.message)) throw new WfirmaLimitError(e.message)
    throw e
  }
}

export interface ZaleznosciKorekty {
  zapis: { wystawKorekte(tresc: { invoices: { invoice: Record<string, unknown> } }): Promise<WynikWystawienia> }
}

export class KorektyWfirmaZapis implements KorektyWfirma {
  constructor(
    private readonly wf: Pick<WfirmaReadOnly, 'call'>,
    private readonly db: PrismaClient,
    private readonly deps: ZaleznosciKorekty,
  ) {}

  async issueCorrection(req: { idExternal: string; invoiceDocId: string; lines: { productId: string; qty: number }[] }): Promise<CorrectionResult> {
    const b = await this.zbuduj(req, true)
    if (b.kind !== 'GOTOWA') return b
    const { pozycje, z } = b
    const w = await this.deps.zapis.wystawKorekte(z.tresc)
    if (w.kind === 'OK') {
      const ostrzezenie = await this.sprawdzKorekte(w.id, req.invoiceDocId, pozycje, z.oczekiwane)
      return { kind: 'OK', docId: w.id, pz: Object.fromEntries(req.lines.map((l) => [l.productId, null])), ...(ostrzezenie ? { ostrzezenie } : {}) }
    }
    if (w.kind === 'ERROR') return { kind: 'ERROR', message: w.message }
    if (w.kind === 'LIMIT') return { kind: 'LIMIT', message: w.message, ...(w.retryAfterMs ? { retryAfterMs: w.retryAfterMs } : {}) }
    return { kind: 'TIMEOUT' }
  }

  /**
   * na torze po timeoucie: korekta znaleziona przez `find` (rdzeń `resolveUnknownCorrections`) przechodzi tę samą
   * kontrolę co korekta potwierdzona od razu. Oczekiwane ilości składa ta sama funkcja z faktury pierwotnej. Nigdy nie
   * rzuca: każdy problem z odczytem = ostrzeżenie „niesprawdzona”, korekta i tak się kończy (dokument istnieje).
   */
  async sprawdzZnaleziona(req: { idExternal: string; invoiceDocId: string; docId: string; lines: { productId: string; qty: number }[] }): Promise<OstrzezenieKorekty | null> {
    const niesprawdzona = (powod: string): OstrzezenieKorekty => ({ kod: 'KOREKTA_NIESPRAWDZONA', tresc: `Korekta ${req.docId} faktury ${req.invoiceDocId} wystawiona, ale nie udało się jej sprawdzić (${powod}). Sprawdź w wFirmie ilości pozycji korekty.`.slice(0, 1000) })
    try {
      const b = await this.zbuduj(req, false)
      if (b.kind !== 'GOTOWA') return niesprawdzona(b.kind === 'TIMEOUT' ? 'brak odpowiedzi wFirmy' : b.message)
      return await this.sprawdzKorekte(req.docId, req.invoiceDocId, b.pozycje, b.z.oczekiwane)
    } catch (e) {
      return niesprawdzona((e as Error).message)
    }
  }

  /** Bezpieczniki i treść korekty (bez zapisu). `sprawdzInna` = (przy kontroli znalezionej korekty pomijane). */
  private async zbuduj(req: { idExternal: string; invoiceDocId: string; lines: { productId: string; qty: number }[] }, sprawdzInna: boolean): Promise<Exclude<CorrectionResult, { kind: 'OK' }> | { kind: 'GOTOWA'; pozycje: PozycjaFakturyWfirmy[]; z: Extract<WynikZlozeniaKorekty, { ok: true }> }> {
    const m = /^zwrot\/([a-z0-9]{1,40})\/\d+$/i.exec(req.idExternal)
    if (!m) return { kind: 'ERROR', message: 'niepoprawna referencja korekty' }
    const r = await this.db.return.findUnique({ where: { id: m[1]! }, select: { status: true, invoiceDocId: true, kind: true, order: { select: { channel: true, channelAccountId: true } } } })
    if (!r || r.status !== 'KOREKTA' || r.invoiceDocId !== req.invoiceDocId) return { kind: 'ERROR', message: 'zwrot nie czeka na korektę tej faktury' }
    if (sprawdzInna) {
      const inna = await innaKorektaFaktury(this.db, m[1]!, req.invoiceDocId)
      if (inna) return { kind: 'ERROR', message: inna.wystawiona ? 'Faktura ma już korektę z innego zwrotu: kolejną korektę wystaw w wFirmie i zakończ zwrot' : 'Korekta tej faktury z innego zwrotu jest właśnie wysyłana: kolejną korektę wystaw w wFirmie i zakończ zwrot' }
    }
    const konto = await this.db.channelConfig.findFirst({ where: { channel: r.order.channel, channelAccountId: r.order.channelAccountId }, select: { statusMode: true } })
    if (konto?.statusMode !== 'PRACA') return { kind: 'ERROR', message: 'Konto sklepu zamówienia jest w trybie „Tylko podgląd”: korekta nie została wysłana do wFirmy' }
    const produkty = new Map((await this.db.product.findMany({ where: { id: { in: req.lines.map((l) => l.productId) } }, select: { id: true, sku: true, wfirmaGoodId: true, unit: true } })).map((p) => [p.id, p]))
    const zwrot: ZwrotDoKorekty[] = []
    for (const l of req.lines) {
      const p = produkty.get(l.productId)
      if (!p?.wfirmaGoodId) return { kind: 'ERROR', message: `Produkt ${p?.sku ?? l.productId} nie ma towaru w wFirmie: korektę wystaw ręcznie` }
      // jednostka bazowa kg = gramy (jak w rozniceIlosci, lib/wfirma/adapter-zapis.ts)
      zwrot.push({ towarId: p.wfirmaGoodId, ilosc: p.unit === 'KG' ? l.qty / 1000 : l.qty })
    }
    let pozycje: PozycjaFakturyWfirmy[]
    try {
      pozycje = pozycjeFaktury(await zLimitem(() => this.wf.call<Record<string, unknown>>(`invoices/get/${req.invoiceDocId}`, {})))
    } catch (e) {
      if (e instanceof WfirmaLimitError) return { kind: 'LIMIT', message: e.message }
      // odczyt przed zapisem, więc korekta na pewno nie wyszła. Błąd, którego ponowienie nic nie da (HTTP 4xx,
      // „NOT FOUND”, „DENIED”…), = błąd jednoznaczny z alertem zamiast pętli niewiadomej co ~7,5 min
      if (e instanceof SourceError && !e.retryable) return { kind: 'ERROR', message: `Nie udało się odczytać faktury ${req.invoiceDocId} z wFirmy (${e.message}): sprawdź, czy faktura istnieje, i ponów albo wystaw korektę w wFirmie` }
      throw e // sieć, timeout, 5xx: rdzeń traktuje jak niewiadomą (find po prefiksie), korekta nie wyszła
    }
    if (!pozycje.length) return { kind: 'ERROR', message: `Faktura ${req.invoiceDocId} bez pozycji w odpowiedzi wFirmy: korektę wystaw ręcznie` }
    const z = zlozKorekte({ fakturaId: req.invoiceDocId, idExternal: req.idExternal, pozycje, zwrot, opis: r.kind === 'REKLAMACJA' ? 'Korekta: reklamacja' : 'Korekta: zwrot towaru' })
    if (!z.ok) return { kind: 'ERROR', message: `Korekta nie dała się złożyć: ${z.problem}` }
    return { kind: 'GOTOWA', pozycje, z }
  }

  /** odczyt wystawionej korekty i porównanie ilości; nigdy nie rzuca (wynik korekty już jest). */
  private async sprawdzKorekte(docId: string, invoiceDocId: string, faktura: PozycjaFakturyWfirmy[], oczekiwane: Map<string, number>): Promise<OstrzezenieKorekty | null> {
    let korekta: PozycjaKorektyWfirmy[]
    try {
      if (!/^\d+$/.test(docId)) throw new Error(`niepoprawny numer korekty ${docId}`)
      korekta = pozycjeKorekty(await this.wf.call<Record<string, unknown>>(`invoices/get/${docId}`, {}))
    } catch (e) {
      return { kod: 'KOREKTA_NIESPRAWDZONA', tresc: `Korekta ${docId} faktury ${invoiceDocId} wystawiona, ale nie udało się jej odczytać do sprawdzenia (${(e as Error).message}). Sprawdź w wFirmie ilości pozycji korekty.`.slice(0, 1000) }
    }
    const zle = porownajKorekte(faktura, oczekiwane, korekta)
    if (!zle.length) return null
    return { kod: 'KOREKTA_NIEZGODNA', tresc: `Korekta ${docId} faktury ${invoiceDocId} ma w wFirmie inne ilości niż wynika ze zwrotu: ${zle.join('; ')}. Popraw korektę w wFirmie.`.slice(0, 1000) }
  }

  async findCorrectionsByPrefix(prefix: string): Promise<FoundCorrection[]> {
    const body = { invoices: { parameters: { conditions: { condition: { field: 'id_external', operator: 'like', value: `${prefix}%` } }, limit: 25 } } }
    const r = await zLimitem(() => this.wf.call<Record<string, unknown>>('invoices/find', body))
    const out: FoundCorrection[] = []
    for (const i of wfirmaItems<{ id?: unknown; id_external?: unknown }>(r['invoices'], 'invoice')) {
      const docId = String(i.id ?? '')
      if (/^\d+$/.test(docId)) out.push({ docId, idExternal: String(i.id_external ?? ''), pz: {} })
    }
    return out // walidacja prefiksu w rdzeniu (validateFound), test kontrolny filtra w kolejce (ensureFindCheck)
  }
}
