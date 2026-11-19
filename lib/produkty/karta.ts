// produkt uniwersalny. Zakładanie produktu w panelu bez wFirmy i bez BL (towar ze stanem, bez stanu,
// zestaw), edycja karty produktu i składu zestawu, historia zmian pól (AuditLog).
//
// Źródło danych produktu (`Product.dataSource`): przy WFIRMA nazwa księgowa, ceny, VAT i jednostka przychodzą z wFirmy
// i są tylko do odczytu (zmienia się je w wFirmie); reszta (nazwa w panelu, EAN, opis, waga, wymiary, próg niskiego
// stanu, lokalizacja) jest edytowalna zawsze. Przy RECZNE/KANAL/CSV/BL edytowalne jest wszystko poza jednostką (zmiana
// jednostki przeliczyłaby stan i rezerwacje — osobna decyzja) i poza składem zestawu z BaseLinkera.
//
// Ścieżka wFirmy (SKU → kopia towaru → produkt ze stanem z wFirmy) zostaje w lib/produkty/dodawanie.ts bez zmian.
// Firma z wFirmą (stan to lustro magazynu wFirmy) nie zakłada tu towaru ze stanem ręcznie: towar bez kopii wFirmy nie
// miałby stanu ani rozchodu w wFirmie. Bez stanu i zestaw — tak.
import type { OrderStatus, Prisma, PrismaClient, ProductDataSource } from '@prisma/client'
import { organizationIdOf } from '../db'
import { NO_STOCK_NOTE } from '../import/bez-stanu'
import { stanStartowy } from '../kanaly/produkt'
import { przeliczZamowienia } from '../kanaly/przeliczenie'
import { DEFAULT_WAREHOUSE } from '../rdzen/stan'
import { changeNoStockTx } from './bez-stanu'
import { checkEan, checkSku, checkTitle, type Checked } from './walidacja'
import { zlecZdjeciaZOferty } from './zdjecia'

export const VAT_STAWKI = ['23', '8', '5', '0', 'zw', 'np'] as const
export type StawkaVat = (typeof VAT_STAWKI)[number]
export const VAT_LABEL: Record<string, string> = { '23': '23%', '8': '8%', '5': '5%', '0': '0%', zw: 'zw. (zwolniony)', np: 'np. (nie podlega)' }
export const OPIS_MAX = 20_000
export const LOKALIZACJA_MAX = 60

export type Rodzaj = 'zwykly' | 'bez-stanu' | 'zestaw'
export const RODZAJ_LABEL: Record<Rodzaj, string> = { zwykly: 'Towar ze stanem', 'bez-stanu': 'Bez stanu (e-book, usługa)', zestaw: 'Zestaw z innych produktów' }

export const ZRODLO_LABEL: Record<ProductDataSource, string> = {
  RECZNE: 'dodany w panelu',
  KANAL: 'z oferty sklepu',
  CSV: 'z pliku CSV',
  BL: 'z BaseLinkera',
  WFIRMA: 'z wFirmy',
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/** Kwota „12,50” / „12.50” → liczba ≥ 0 z 2 miejscami; puste = null. */
export function checkKwota(v: unknown, label: string, digits = 2): Checked<number | null> {
  const s = str(v).replace(/\s/g, '').replace(',', '.')
  if (!s) return { ok: true, value: null }
  if (!/^\d{1,9}(\.\d+)?$/.test(s)) return { ok: false, error: `${label}: podaj kwotę, np. 19,90.` }
  const n = Number(s)
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: `${label}: kwota nie może być ujemna.` }
  return { ok: true, value: Number(n.toFixed(digits)) }
}

/** Liczba „0,5” → ≥ 0, najwyżej `max`; puste = null. */
export function checkLiczba(v: unknown, label: string, max: number, digits: number): Checked<number | null> {
  const s = str(v).replace(/\s/g, '').replace(',', '.')
  if (!s) return { ok: true, value: null }
  if (!/^\d{1,9}(\.\d+)?$/.test(s)) return { ok: false, error: `${label}: podaj liczbę.` }
  const n = Number(Number(s).toFixed(digits))
  if (n > max) return { ok: false, error: `${label}: najwyżej ${max}.` }
  return { ok: true, value: n }
}

export function checkVat(v: unknown): Checked<StawkaVat | null> {
  const s = str(v).toLowerCase().replace('%', '')
  if (!s) return { ok: true, value: null }
  return (VAT_STAWKI as readonly string[]).includes(s) ? { ok: true, value: s as StawkaVat } : { ok: false, error: 'Wybierz stawkę VAT z listy.' }
}

/** Netto z brutto i stawki (zw/np = brutto). */
export function nettoZBrutto(brutto: number | null, vat: string | null): number | null {
  if (brutto === null) return null
  const r = vat === null ? NaN : Number(vat)
  return Number.isFinite(r) ? Number((brutto / (1 + r / 100)).toFixed(2)) : brutto
}

export interface PolaWlasne {
  title?: string
  ean?: string | null
  description?: string | null
  weightG?: number | null
  lengthCm?: number | null
  widthCm?: number | null
  heightCm?: number | null
  lowStockThreshold?: number | null
  location?: string | null
}

export interface PolaHandlowe {
  priceGross?: number | null
  vatRate?: StawkaVat | null
  purchasePriceNet?: number | null
}

type Wynik<T> = { ok: true; value: T } | { ok: false; error: string; field: string }

/** Pola wspólne formularza i karty (wszystkie opcjonalne poza nazwą, gdy `wymagajNazwy`). */
export function checkPola(form: Record<string, unknown>, opts: { wymagajNazwy: boolean }): Wynik<PolaWlasne & PolaHandlowe> {
  const out: PolaWlasne & PolaHandlowe = {}
  if (opts.wymagajNazwy || str(form['nazwa'])) {
    const t = checkTitle(form['nazwa'])
    if (!t.ok) return { ok: false, error: t.error, field: 'nazwa' }
    out.title = t.value
  }
  if ('ean' in form) {
    const e = checkEan(form['ean'])
    if (!e.ok) return { ok: false, error: e.error, field: 'ean' }
    out.ean = e.value
  }
  if ('opis' in form) {
    const d = typeof form['opis'] === 'string' ? form['opis'].replace(/\r\n/g, '\n').trim() : ''
    if (d.length > OPIS_MAX) return { ok: false, error: `Opis może mieć najwyżej ${OPIS_MAX} znaków.`, field: 'opis' }
    if (CONTROL.test(d)) return { ok: false, error: 'Opis zawiera niedozwolony znak.', field: 'opis' }
    out.description = d || null
  }
  const liczby: [string, keyof PolaWlasne, string, number, number][] = [
    ['waga', 'weightG', 'Waga (g)', 1_000_000, 0],
    ['dlugosc', 'lengthCm', 'Długość (cm)', 100_000, 1],
    ['szerokosc', 'widthCm', 'Szerokość (cm)', 100_000, 1],
    ['wysokosc', 'heightCm', 'Wysokość (cm)', 100_000, 1],
    ['prog', 'lowStockThreshold', 'Próg niskiego stanu', 10_000_000, 0],
  ]
  for (const [k, key, label, max, digits] of liczby) {
    if (!(k in form)) continue
    const n = checkLiczba(form[k], label, max, digits)
    if (!n.ok) return { ok: false, error: n.error, field: k }
    ;(out as Record<string, unknown>)[key] = n.value
  }
  if ('lokalizacja' in form) {
    const l = str(form['lokalizacja'])
    if (l.length > LOKALIZACJA_MAX || CONTROL.test(l)) return { ok: false, error: `Lokalizacja: najwyżej ${LOKALIZACJA_MAX} znaków, bez znaków sterujących.`, field: 'lokalizacja' }
    out.location = l || null
  }
  if ('cena' in form) {
    const c = checkKwota(form['cena'], 'Cena brutto')
    if (!c.ok) return { ok: false, error: c.error, field: 'cena' }
    out.priceGross = c.value
  }
  if ('vat' in form) {
    const v = checkVat(form['vat'])
    if (!v.ok) return { ok: false, error: v.error, field: 'vat' }
    out.vatRate = v.value
  }
  if ('cenaZakupu' in form) {
    const c = checkKwota(form['cenaZakupu'], 'Cena zakupu netto', 4)
    if (!c.ok) return { ok: false, error: c.error, field: 'cenaZakupu' }
    out.purchasePriceNet = c.value
  }
  return { ok: true, value: out }
}

export interface Skladnik {
  productId: string
  qtyBase: number
  /** Udział w cenie zestawu (0–1); null = proporcjonalnie do cen składników. */
  priceShare: number | null
}

/** Skład zestawu z formularza: pola `skladnik` (id), `ilosc`, `udzial` (procent) — powtarzane. */
export function checkSklad(ids: unknown[], ilosci: unknown[], udzialy: unknown[]): Wynik<Skladnik[]> {
  const out: Skladnik[] = []
  const seen = new Set<string>()
  for (const [i, raw] of ids.entries()) {
    const id = str(raw)
    if (!id) continue
    if (!/^[a-z0-9]{1,40}$/i.test(id)) return { ok: false, error: 'Zły składnik zestawu.', field: 'sklad' }
    if (seen.has(id)) return { ok: false, error: 'Ten sam składnik jest w zestawie dwa razy: połącz ilości.', field: 'sklad' }
    seen.add(id)
    const q = str(ilosci[i])
    if (!/^\d{1,7}$/.test(q) || Number(q) < 1) return { ok: false, error: 'Ilość składnika: liczba całkowita od 1 (sztuki albo gramy).', field: 'sklad' }
    const u = checkLiczba(udzialy[i], 'Udział w cenie (%)', 100, 2)
    if (!u.ok) return { ok: false, error: u.error, field: 'sklad' }
    out.push({ productId: id, qtyBase: Number(q), priceShare: u.value === null ? null : Number((u.value / 100).toFixed(4)) })
  }
  if (!out.length) return { ok: false, error: 'Zestaw potrzebuje co najmniej jednego składnika.', field: 'sklad' }
  const shares = out.filter((c) => c.priceShare !== null)
  if (shares.length && shares.length !== out.length) return { ok: false, error: 'Udział w cenie podaj dla wszystkich składników albo dla żadnego.', field: 'sklad' }
  if (shares.length && Math.abs(shares.reduce((s, c) => s + c.priceShare!, 0) - 1) > 0.0001) return { ok: false, error: 'Udziały w cenie muszą sumować się do 100%.', field: 'sklad' }
  return { ok: true, value: out }
}

/** Składniki istnieją w firmie, są towarem ze stanem (bez zestawów w zestawie = bez cykli). */
async function sprawdzSkladniki(db: PrismaClient | Prisma.TransactionClient, sklad: Skladnik[], bundleId?: string): Promise<string | null> {
  const rows = await db.product.findMany({ where: { id: { in: sklad.map((s) => s.productId) } }, select: { id: true, kind: true, title: true } })
  if (rows.length !== sklad.length) return 'Któregoś składnika nie ma w katalogu.'
  if (bundleId && rows.some((r) => r.id === bundleId)) return 'Zestaw nie może zawierać samego siebie.'
  const bad = rows.find((r) => r.kind !== 'STOCKED')
  if (bad) return `„${bad.title}” nie jest towarem ze stanem: zestaw składa się tylko z towarów ze stanem (bez zestawów w zestawie i bez e-booków).`
  return null
}

export interface NowyProdukt {
  rodzaj: Rodzaj
  sku: unknown
  unit?: unknown
  stanPoczatkowy?: unknown
  form: Record<string, unknown>
  sklad?: { ids: unknown[]; ilosci: unknown[]; udzialy: unknown[] }
  /** Skąd pochodzą dane (przycisk „Pobierz z…”): KANAL = oferta sklepu, BL = kopia BL; brak = ręcznie. */
  zrodlo?: { typ: 'KANAL' | 'BL'; ref: string } | null
  /** Adresy zdjęć z oferty sklepu (pobierze worker po zapisie). */
  zdjeciaZOferty?: string[]
}

export type WynikZalozenia = { ok: true; productId: string; warnings: string[] } | { ok: false; error: string; field?: string; istniejacyId?: string }

const UNIT = (v: unknown): 'SZT' | 'KG' | null => (v === 'KG' ? 'KG' : v === 'SZT' || v === undefined || v === '' ? 'SZT' : null)

/**
 * Zakłada produkt z formularza w panelu. `hasWfirma` = firma prowadzi stan w wFirmie: towaru ze stanem tu nie
 * zakłada (tylko „Pobierz z wFirmy”). Produkt, stan startowy, skład, lista bez stanu i audyt w jednej transakcji.
 */
export async function zalozProduktReczny(db: PrismaClient, input: NowyProdukt, userId: string, opts: { hasWfirma: boolean }): Promise<WynikZalozenia> {
  const sku = checkSku(input.sku)
  if (!sku.ok) return { ok: false, error: sku.error.replace(' (kod towaru z wFirmy)', ''), field: 'sku' }
  const rodzaj = input.rodzaj
  if (!(rodzaj in RODZAJ_LABEL)) return { ok: false, error: 'Wybierz rodzaj produktu.', field: 'rodzaj' }
  if (rodzaj === 'zwykly' && opts.hasWfirma)
    return { ok: false, error: 'Twoja firma prowadzi stany w wFirmie: towar ze stanem dodaj przyciskiem „Pobierz z wFirmy” (najpierw załóż go w magazynie wFirmy).', field: 'rodzaj' }
  const pola = checkPola(input.form, { wymagajNazwy: true })
  if (!pola.ok) return pola
  const unit = rodzaj === 'zwykly' ? UNIT(input.unit) : 'SZT'
  if (!unit) return { ok: false, error: 'Wybierz jednostkę.', field: 'jednostka' }
  let start = 0
  if (rodzaj === 'zwykly') {
    const s = checkLiczba(input.stanPoczatkowy, 'Stan początkowy', 10_000_000, unit === 'KG' ? 3 : 0)
    if (!s.ok) return { ok: false, error: s.error, field: 'stan' }
    if (unit === 'SZT' && s.value !== null && !Number.isInteger(s.value)) return { ok: false, error: 'Stan początkowy w sztukach: liczba całkowita.', field: 'stan' }
    start = s.value === null ? 0 : unit === 'KG' ? Math.round(s.value * 1000) : s.value
  }
  let sklad: Skladnik[] = []
  if (rodzaj === 'zestaw') {
    const s = checkSklad(input.sklad?.ids ?? [], input.sklad?.ilosci ?? [], input.sklad?.udzialy ?? [])
    if (!s.ok) return s
    sklad = s.value
    const bad = await sprawdzSkladniki(db, sklad)
    if (bad) return { ok: false, error: bad, field: 'sklad' }
  }
  const p = pola.value
  const warnings: string[] = []
  if (p.ean) {
    const same = await db.product.findFirst({ where: { ean: p.ean }, select: { sku: true } })
    if (same) warnings.push(`Ten sam EAN ma już produkt ${same.sku}.`)
  }
  if (rodzaj !== 'bez-stanu' && p.priceGross === undefined) warnings.push('Bez ceny: faktura weźmie cenę z pozycji zamówienia.')
  if (p.priceGross != null && !p.vatRate) warnings.push(BEZ_VAT)
  const dataSource: ProductDataSource = input.zrodlo?.typ ?? 'RECZNE'
  const kind = rodzaj === 'zwykly' ? 'STOCKED' : rodzaj === 'zestaw' ? 'BUNDLE' : 'DIGITAL'
  if (kind === 'STOCKED' && !(await db.warehouse.findFirst({ where: { id: DEFAULT_WAREHOUSE }, select: { id: true } })))
    return { ok: false, error: `Brak magazynu „${DEFAULT_WAREHOUSE}” w konfiguracji firmy — produkt ze stanem nie ma gdzie trzymać stanu.` }
  // produkt „z oferty sklepu” dostaje powiązanie z ofertą od razu, w tej samej transakcji
  // (ręczne, MANUAL: import i kolejne pobrania go nie zmieniają). Bez tego poprawka SKU w formularzu zostawiała ofertę
  // na zawsze „bez produktu”, a stan z oferty nie schodził.
  const oferta =
    input.zrodlo?.typ === 'KANAL'
      ? await db.channelOfferRead.findUnique({ where: { id: input.zrodlo.ref }, select: { channel: true, channelAccountId: true, externalId: true, sku: true } })
      : null
  if (input.zrodlo?.typ === 'KANAL') {
    if (!oferta) return { ok: false, error: 'Tej oferty nie ma już w ostatnim odczycie ofert: wyszukaj ją jeszcze raz.', field: 'zrodlo' }
    const linked = await db.channelOffer.findFirst({ where: { channel: oferta.channel, channelAccountId: oferta.channelAccountId, externalId: oferta.externalId }, select: { productId: true } })
    if (linked) return { ok: false, error: 'Ta oferta jest już powiązana z produktem w katalogu.', field: 'zrodlo', istniejacyId: linked.productId }
    if (oferta.sku?.trim() && oferta.sku.trim() !== sku.value) warnings.push(`SKU różni się od SKU w ofercie (${oferta.sku.trim()}): oferta i tak jest powiązana z tym produktem.`)
  }
  const organizationId = organizationIdOf(db)
  try {
    const productId = await db.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          sku: sku.value,
          kind,
          unit,
          dataSource,
          title: p.title!,
          nameAccounting: p.title!,
          ean: p.ean ?? null,
          description: p.description ?? null,
          priceGross: p.priceGross ?? null,
          priceNet: nettoZBrutto(p.priceGross ?? null, p.vatRate ?? null),
          vatRate: p.vatRate ?? null,
          purchasePriceNet: p.purchasePriceNet ?? null,
          weightG: p.weightG ?? null,
          lengthCm: p.lengthCm ?? null,
          widthCm: p.widthCm ?? null,
          heightCm: p.heightCm ?? null,
          lowStockThreshold: p.lowStockThreshold ?? null,
        },
        select: { id: true },
      })
      if (kind === 'STOCKED') {
        await stanStartowy(tx, created.id, start, userId, 'stan startowy, produkt dodany w panelu', new Date())
        if (p.location) await tx.stock.update({ where: { productId_warehouseId: { productId: created.id, warehouseId: DEFAULT_WAREHOUSE } }, data: { location: p.location } })
      }
      if (kind === 'BUNDLE') await tx.bundleComponent.createMany({ data: sklad.map((c) => ({ bundleId: created.id, componentId: c.productId, qtyBase: c.qtyBase, priceShare: c.priceShare })) })
      if (kind === 'DIGITAL') await changeNoStockTx(tx, organizationId, (cur) => (cur.skus.includes(sku.value) ? cur : { ...cur, skus: [...cur.skus, sku.value] }), { actorId: userId, edited: false })
      if (oferta) {
        const offer = await tx.channelOffer.create({
          data: { channel: oferta.channel, channelAccountId: oferta.channelAccountId, externalId: oferta.externalId, productId: created.id, qtyBasePerOffer: unit === 'KG' ? 1000 : 1, mappingSource: 'MANUAL', active: true },
          select: { id: true, productId: true, qtyBasePerOffer: true },
        })
        await tx.channelOfferRead.updateMany({ where: { channel: oferta.channel, channelAccountId: oferta.channelAccountId, externalId: oferta.externalId }, data: { state: 'POWIAZANA', note: 'produkt dodany w panelu' } })
        await tx.auditLog.create({ data: { entity: 'ChannelOffer', entityId: offer.id, actorId: userId, after: { productId: offer.productId, active: true, mappingSource: 'MANUAL', qtyBasePerOffer: offer.qtyBasePerOffer } } })
      }
      if (input.zdjeciaZOferty?.length) await zlecZdjeciaZOferty(tx, created.id, input.zdjeciaZOferty)
      if (input.zrodlo?.typ === 'BL') await tx.blProduct.updateMany({ where: { id: input.zrodlo.ref, productId: null }, data: { productId: created.id } })
      await tx.auditLog.create({
        data: {
          entity: 'Product',
          entityId: created.id,
          actorId: userId,
          after: { dodanyWPanelu: true, sku: sku.value, kind, dataSource, ...(input.zrodlo ? { zrodlo: input.zrodlo.ref } : {}), ...(kind === 'STOCKED' ? { stanPoczatkowy: start } : {}) },
        },
      })
      return created.id
    })
    if (oferta) {
      // zamówienia „Do wyjaśnienia” czekające na tę ofertę; błąd nie cofa produktu (przeliczy je kolejne pobranie ofert)
      try {
        await przeliczZamowienia(db, { channel: oferta.channel, channelAccountId: oferta.channelAccountId }, [oferta.externalId])
      } catch {
        warnings.push('Zamówienia czekające na tę ofertę przeliczą się przy następnym pobraniu ofert.')
      }
    }
    return { ok: true, productId, warnings: kind === 'DIGITAL' ? warnings.filter((w) => !w.startsWith('Bez ceny')) : warnings }
  } catch (e) {
    if ((e as { code?: string }).code !== 'P2002') throw e
    const again = await db.product.findFirst({ where: { sku: sku.value }, select: { id: true } })
    if (!again && oferta) return { ok: false, error: 'Ta oferta została właśnie powiązana z innym produktem: odśwież stronę.', field: 'zrodlo' }
    return { ok: false, error: `Produkt o SKU „${sku.value}” już jest w katalogu.`, field: 'sku', istniejacyId: again?.id }
  }
}

/** Pola, których przy danym źródle nie zmienia się w panelu (komunikat: gdzie je zmienić). */
export function polaTylkoDoOdczytu(dataSource: ProductDataSource): { pola: (keyof PolaHandlowe | 'nameAccounting')[]; gdzie: string | null } {
  return dataSource === 'WFIRMA' ? { pola: ['priceGross', 'vatRate', 'purchasePriceNet', 'nameAccounting'], gdzie: 'z wFirmy, zmieniasz w wFirmie' } : { pola: [], gdzie: null }
}

const asNum = (d: Prisma.Decimal | null | undefined) => (d === null || d === undefined ? null : Number(d.toString()))

export type WynikEdycji = { ok: true; zmiany: string[]; warnings?: string[] } | { ok: false; error: string; field?: string; istniejacyId?: string }

/** Ostrzeżenie przy produkcie z ceną bez stawki VAT (dodawanie i edycja karty). */
export const BEZ_VAT = 'Bez stawki VAT: szkic faktury pokaże „Produkt bez stawki VAT”. Uzupełnij ją w karcie produktu.'

/** SKU zmienia się w panelu tylko przy produkcie, którego źródłem nie jest program zewnętrzny (wFirma, BaseLinker). */
export const skuEdytowalne = (dataSource: ProductDataSource) => dataSource !== 'WFIRMA' && dataSource !== 'BL'

/** grupa wariantów — ten sam tekst w kilku produktach łączy je w warianty (np. rozmiary, kolory). */
export const GRUPA_WARIANTOW_RE = /^[A-Za-z0-9._/-]{1,64}$/
export function checkGrupa(v: unknown): Checked<string | null> {
  const s = str(v)
  if (!s) return { ok: true, value: null }
  return GRUPA_WARIANTOW_RE.test(s) ? { ok: true, value: s } : { ok: false, error: 'Grupa wariantów: litery, cyfry, kropka, myślnik, ukośnik, bez spacji, do 64 znaków.' }
}

const skuZajete = (sku: string) => `SKU „${sku}” ma już inny produkt: popraw SKU albo otwórz tamten produkt.`

/**
 * Edycja karty produktu. Zapisuje tylko pola obecne w formularzu i tylko te, które wolno zmienić przy źródle produktu
 * (WFIRMA: bez cen, VAT, nazwy księgowej). Wpis w AuditLog z wartościami przed i po (historia zmian w karcie).
 */
export async function edytujProdukt(db: PrismaClient, productId: string, form: Record<string, unknown>, userId: string): Promise<WynikEdycji> {
  if (!/^[a-z0-9]{1,40}$/i.test(productId)) return { ok: false, error: 'Nie ma takiego produktu.' }
  const pola = checkPola(form, { wymagajNazwy: 'nazwa' in form })
  if (!pola.ok) return pola
  // SKU poprawialne przy RECZNE/KANAL/CSV; przy WFIRMA/BL ignorowane (jak ceny z wFirmy)
  let nowySku: string | undefined
  if ('sku' in form) {
    const s = checkSku(form['sku'])
    if (!s.ok) return { ok: false, error: s.error.replace(' (kod towaru z wFirmy)', ''), field: 'sku' }
    nowySku = s.value
  }
  // grupa wariantów (pusta = produkt bez grupy); przy BL/WFIRMA przychodzi z importu i jest pomijana
  let nowaGrupa: string | null | undefined
  if ('grupa' in form) {
    const g = checkGrupa(form['grupa'])
    if (!g.ok) return { ok: false, error: g.error, field: 'grupa' }
    nowaGrupa = g.value
  }
  try {
    return await edytujProduktTx(db, productId, pola.value, nowySku, userId, nowaGrupa)
  } catch (e) {
    if ((e as { code?: string }).code !== 'P2002' || nowySku === undefined) throw e
    const inny = await db.product.findFirst({ where: { sku: { equals: nowySku, mode: 'insensitive' }, id: { not: productId } }, select: { id: true } })
    return { ok: false, error: skuZajete(nowySku), field: 'sku', istniejacyId: inny?.id }
  }
}

async function edytujProduktTx(db: PrismaClient, productId: string, p: PolaWlasne & PolaHandlowe, nowySku: string | undefined, userId: string, nowaGrupa?: string | null): Promise<WynikEdycji> {
  return db.$transaction(async (tx) => {
    const cur = await tx.product.findUnique({
      where: { id: productId },
      select: {
        id: true, sku: true, kind: true, dataSource: true, title: true, nameAccounting: true, ean: true, description: true, weightG: true, lengthCm: true, widthCm: true, heightCm: true,
        lowStockThreshold: true, priceGross: true, vatRate: true, purchasePriceNet: true, groupId: true, stocks: { where: { warehouseId: DEFAULT_WAREHOUSE }, select: { location: true } },
      },
    })
    if (!cur) return { ok: false as const, error: 'Nie ma takiego produktu.' }
    const ro = new Set<string>(polaTylkoDoOdczytu(cur.dataSource).pola)
    const before: Record<string, unknown> = {}
    const after: Record<string, unknown> = {}
    const data: Prisma.ProductUpdateInput = {}
    const set = (key: string, was: unknown, now: unknown, apply: () => void) => {
      if (now === undefined || ro.has(key)) return
      if (JSON.stringify(was) === JSON.stringify(now)) return
      before[key] = was
      after[key] = now
      apply()
    }
    if (nowySku !== undefined && nowySku !== cur.sku && skuEdytowalne(cur.dataSource)) {
      const inny = await tx.product.findFirst({ where: { sku: { equals: nowySku, mode: 'insensitive' }, id: { not: productId } }, select: { id: true } })
      if (inny) return { ok: false as const, error: skuZajete(nowySku), field: 'sku', istniejacyId: inny.id }
      const was = cur.sku
      before['sku'] = was
      after['sku'] = nowySku
      data.sku = nowySku
      // produkt bez stanu: lista SKU bez stanu (import, zamówienia) idzie za nowym SKU
      if (cur.kind === 'DIGITAL')
        await changeNoStockTx(tx, organizationIdOf(db), (c) => (c.skus.includes(was) ? { ...c, skus: [...c.skus.filter((x) => x !== was), nowySku] } : c), { actorId: userId, edited: false })
    }
    if (skuEdytowalne(cur.dataSource)) set('groupId', cur.groupId, nowaGrupa, () => (data.groupId = nowaGrupa))
    set('title', cur.title, p.title, () => (data.title = p.title))
    // bez wFirmy nazwa księgowa (z niej faktura) idzie za nazwą produktu
    if (cur.dataSource !== 'WFIRMA' && p.title !== undefined && p.title !== cur.nameAccounting) set('nameAccounting', cur.nameAccounting, p.title, () => (data.nameAccounting = p.title))
    set('ean', cur.ean, p.ean, () => (data.ean = p.ean))
    set('description', cur.description, p.description, () => (data.description = p.description))
    set('weightG', cur.weightG, p.weightG, () => (data.weightG = p.weightG))
    set('lengthCm', asNum(cur.lengthCm), p.lengthCm, () => (data.lengthCm = p.lengthCm))
    set('widthCm', asNum(cur.widthCm), p.widthCm, () => (data.widthCm = p.widthCm))
    set('heightCm', asNum(cur.heightCm), p.heightCm, () => (data.heightCm = p.heightCm))
    set('lowStockThreshold', cur.lowStockThreshold, p.lowStockThreshold, () => (data.lowStockThreshold = p.lowStockThreshold))
    set('priceGross', asNum(cur.priceGross), p.priceGross, () => (data.priceGross = p.priceGross))
    set('vatRate', cur.vatRate, p.vatRate, () => (data.vatRate = p.vatRate))
    set('purchasePriceNet', asNum(cur.purchasePriceNet), p.purchasePriceNet, () => (data.purchasePriceNet = p.purchasePriceNet))
    if (!ro.has('priceGross') && ('priceGross' in after || 'vatRate' in after)) {
      const g = p.priceGross !== undefined ? p.priceGross : asNum(cur.priceGross)
      const v = p.vatRate !== undefined ? p.vatRate : cur.vatRate
      data.priceNet = nettoZBrutto(g, v)
    }
    // zapis zostawia cenę bez stawki VAT (np. „— brak —” w polu VAT) = to samo ostrzeżenie co przy dodawaniu
    const warnings: string[] = []
    if (!ro.has('vatRate') && ('priceGross' in after || 'vatRate' in after)) {
      const g = p.priceGross !== undefined ? p.priceGross : asNum(cur.priceGross)
      const v = p.vatRate !== undefined ? p.vatRate : cur.vatRate
      if (g != null && !v) warnings.push(BEZ_VAT)
    }
    let locationChanged = false
    if (p.location !== undefined && cur.kind === 'STOCKED' && cur.stocks[0] && (cur.stocks[0].location ?? null) !== p.location) {
      before['location'] = cur.stocks[0].location
      after['location'] = p.location
      locationChanged = true
    }
    const zmiany = Object.keys(after)
    if (!zmiany.length) return { ok: true as const, zmiany }
    if (Object.keys(data).length) await tx.product.update({ where: { id: productId }, data })
    if (locationChanged) await tx.stock.update({ where: { productId_warehouseId: { productId, warehouseId: DEFAULT_WAREHOUSE } }, data: { location: p.location ?? null } })
    await tx.auditLog.create({ data: { entity: 'Product', entityId: productId, actorId: userId, before: before as Prisma.InputJsonValue, after: after as Prisma.InputJsonValue } })
    return { ok: true as const, zmiany, ...(warnings.length ? { warnings } : {}) }
  })
}

/** Zamówienia w drodze: zestaw w nich ma rezerwacje albo braki policzone ze starego składu. DO_ODBIORU (odpowiednik
 * DO_WYSLANIA przy odbiorze osobistym) i REKLAMACJA (zwrot składników liczony ze składu) też blokują. */
const OTWARTE: OrderStatus[] = ['NOWE', 'DO_REALIZACJI', 'ZBIERANIE', 'ZEBRANE', 'SPAKOWANE', 'DO_WYSLANIA', 'DO_ODBIORU', 'DO_WYJASNIENIA', 'REKLAMACJA']

/**
 * Zmiana składu zestawu (zestaw założony w panelu albo z oferty; zestaw z BaseLinkera ma skład z BL). Zestaw
 * z otwartymi rezerwacjami składników nie zmienia składu: rezerwacje i braki liczone są ze starego składu.
 */
export async function edytujSklad(db: PrismaClient, bundleId: string, sklad: { ids: unknown[]; ilosci: unknown[]; udzialy: unknown[] }, userId: string): Promise<WynikEdycji> {
  const s = checkSklad(sklad.ids, sklad.ilosci, sklad.udzialy)
  if (!s.ok) return s
  return db.$transaction(async (tx) => {
    const b = await tx.product.findUnique({ where: { id: bundleId }, select: { kind: true, dataSource: true, bundleComponents: { select: { componentId: true, qtyBase: true, priceShare: true } } } })
    if (!b || b.kind !== 'BUNDLE') return { ok: false as const, error: 'To nie jest zestaw.' }
    if (b.dataSource === 'BL') return { ok: false as const, error: 'Skład tego zestawu przychodzi z BaseLinkera: zmieniasz go w BaseLinkerze.' }
    const bad = await sprawdzSkladniki(tx, s.value, bundleId)
    if (bad) return { ok: false as const, error: bad, field: 'sklad' }
    const open = await tx.orderLine.count({ where: { productId: bundleId, order: { status: { in: OTWARTE } } } })
    if (open > 0) return { ok: false as const, error: `Zestaw jest w ${open} otwartych zamówieniach: zmień skład po ich wysłaniu albo anulowaniu.`, field: 'sklad' }
    const before = b.bundleComponents.map((c) => ({ productId: c.componentId, qtyBase: c.qtyBase, priceShare: asNum(c.priceShare) }))
    await tx.bundleComponent.deleteMany({ where: { bundleId } })
    await tx.bundleComponent.createMany({ data: s.value.map((c) => ({ bundleId, componentId: c.productId, qtyBase: c.qtyBase, priceShare: c.priceShare })) })
    await tx.auditLog.create({ data: { entity: 'Product', entityId: bundleId, actorId: userId, before: { sklad: before } as Prisma.InputJsonValue, after: { sklad: s.value } as unknown as Prisma.InputJsonValue } })
    return { ok: true as const, zmiany: ['sklad'] }
  })
}

/** Ile zestawów da się zrobić z dostępnego stanu składników (min po składnikach). */
export function ileZestawow(sklad: { qtyBase: number; dostepne: number }[]): number {
  if (!sklad.length) return 0
  return Math.max(0, Math.min(...sklad.map((c) => Math.floor(c.dostepne / c.qtyBase))))
}

export interface WpisHistorii {
  id: string
  createdAt: Date
  actorId: string
  before: Prisma.JsonValue
  after: Prisma.JsonValue
}

/** Historia zmian danych produktu (AuditLog), najnowsze pierwsze. */
export async function historiaProduktu(db: PrismaClient, productId: string, limit = 30): Promise<WpisHistorii[]> {
  return db.auditLog.findMany({ where: { entity: 'Product', entityId: productId }, orderBy: { createdAt: 'desc' }, take: limit, select: { id: true, createdAt: true, actorId: true, before: true, after: true } })
}

export const POLE_LABEL: Record<string, string> = {
  sku: 'SKU',
  title: 'nazwa',
  nameAccounting: 'nazwa na fakturze',
  ean: 'EAN',
  description: 'opis',
  weightG: 'waga (g)',
  lengthCm: 'długość (cm)',
  widthCm: 'szerokość (cm)',
  heightCm: 'wysokość (cm)',
  lowStockThreshold: 'próg niskiego stanu',
  priceGross: 'cena brutto',
  vatRate: 'VAT',
  groupId: 'grupa wariantów',
  purchasePriceNet: 'cena zakupu netto',
  location: 'lokalizacja',
  sklad: 'skład zestawu',
  zdjecia: 'kolejność zdjęć',
}

export { NO_STOCK_NOTE }
