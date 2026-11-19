// Edycja pozycji i podział zamówienia z karty. Woła akcja serwera karty (akcje-pozycje.ts) i testy.
// Kolejność: uprawnienie osoby → bramka trybu PRACA (bramka.ts, także przy ręcznym wywołaniu) → ustawienie firmy
// `edycjaZamowienKanalow` → funkcja rdzenia (lib/rdzen/edycja.ts) z `actorId: user:<id>`, która pod blokadą zamówienia
// sprawdza status jeszcze raz. Nic nie idzie do kanału: zmiana jest tylko w Kompletorze.
import type { PrismaClient } from '@prisma/client'
import type { Permission } from '@/lib/auth/uprawnienia'
import { addOrderLine, cenaZTekstu, changeLinePrice, changeLineQty, EdycjaError, type NowaCena, normalizujStawke, removeOrderLine, splitOrder, STAWKI_VAT_POZYCJI } from '@/lib/rdzen/edycja'
import { BLEDY_KARTY, type KluczKomunikatu } from './komunikaty'
import { bramkaKarty, ID_RE, ustawieniaKarty } from './bramka'

type Db = PrismaClient
type Env = Record<string, string | undefined>

/**
 * Wynik akcji karty. `info` to klucz słownika komunikatów (lib/karta/komunikaty.ts: bez dopasowania
 * tekstu), `n` liczba do szablonu; `blad` tekst dla osoby (w adresie jedzie kodem, lib/karta/komunikaty-serwer.ts).
 */
export type WynikKarty = { blad: string | null; info?: KluczKomunikatu | null; n?: number; zmiana: boolean }

export const BEZ_UPRAWNIENIA = BLEDY_KARTY['bez-uprawnienia']
export const TYLKO_RECZNE = BLEDY_KARTY['tylko-reczne']
export const KOMUNIKAT_KANAL = 'Zmiana tylko w Kompletorze, w kanale zamówienie zostaje bez zmian.'

const wczytaj = (db: Db) => (id: string) => db.order.findUnique({ where: { id }, select: { id: true, channel: true, channelAccountId: true } })

export interface ZlecenieEdycji {
  orderId: unknown
  userId: string
  uprawnienia: ReadonlySet<string>
}

/** Bramka edycji: uprawnienie osoby, tryb PRACA (bramka.ts) i ustawienie firmy; `{ id }` = można. */
export async function bramkaEdycji(db: Db, z: ZlecenieEdycji, uprawnienie: Permission, env: Env): Promise<{ id: string } | WynikKarty> {
  if (!z.uprawnienia.has(uprawnienie)) return { blad: BEZ_UPRAWNIENIA, zmiana: false }
  const b = await bramkaKarty(db, z.orderId, wczytaj(db), env)
  if (!b.ok) return { blad: b.blad, zmiana: false }
  if (b.o.channel !== 'RECZNE' && !(await ustawieniaKarty(db)).edycjaZamowienKanalow) return { blad: TYLKO_RECZNE, zmiana: false }
  return { id: b.o.id }
}

async function wykonaj(fn: () => Promise<unknown>): Promise<WynikKarty> {
  try {
    await fn()
    return { blad: null, zmiana: true }
  } catch (e) {
    if (e instanceof EdycjaError) return { blad: e.message, zmiana: false }
    throw e
  }
}

const ctxOsoby = (userId: string) => ({ actorId: `user:${userId}` })

/** „Dodaj pozycję”: produkt po SKU z katalogu firmy, ilość, cena brutto (puste = cena detaliczna produktu). */
export async function dodajPozycje(db: Db, z: ZlecenieEdycji & { sku: unknown; ilosc: unknown; cena: unknown }, env: Env = process.env): Promise<WynikKarty> {
  const g = await bramkaEdycji(db, z, 'zamowienia.edycja_pozycji', env)
  if (!('id' in g)) return g
  const sku = String(z.sku ?? '').trim().slice(0, 100)
  if (!sku) return { blad: 'Wpisz SKU produktu.', zmiana: false }
  const prod = await db.product.findFirst({ where: { sku, active: true }, select: { id: true, priceGross: true } })
  if (!prod) return { blad: 'Nie ma aktywnego produktu o tym SKU.', zmiana: false }
  const cenaTekst = String(z.cena ?? '').trim()
  const cena = cenaTekst ? cenaZTekstu(cenaTekst) : prod.priceGross !== null ? Math.round(Number(prod.priceGross) * 100) : null
  if (cena === null) return { blad: cenaTekst ? 'Cena: liczba nieujemna, najwyżej 2 miejsca po przecinku.' : 'Produkt nie ma ceny detalicznej: wpisz cenę.', zmiana: false }
  const qty = Number(String(z.ilosc ?? '').trim())
  return wykonaj(() => addOrderLine(db, g.id, { productId: prod.id, qty, priceGrossGr: cena }, ctxOsoby(z.userId)))
}

/** „Zmień ilość” pozycji (jednostka bazowa produktu). */
export async function zmienIlosc(db: Db, z: ZlecenieEdycji & { lineId: unknown; ilosc: unknown }, env: Env = process.env): Promise<WynikKarty> {
  const g = await bramkaEdycji(db, z, 'zamowienia.edycja_pozycji', env)
  if (!('id' in g)) return g
  return zmienIloscPoBramce(db, g.id, String(z.lineId ?? ''), z.ilosc, z.userId)
}

/** „Usuń pozycję” (z potwierdzeniem na karcie). */
export async function usunPozycje(db: Db, z: ZlecenieEdycji & { lineId: unknown }, env: Env = process.env): Promise<WynikKarty> {
  const g = await bramkaEdycji(db, z, 'zamowienia.edycja_pozycji', env)
  if (!('id' in g)) return g
  return usunPozycjePoBramce(db, g.id, String(z.lineId ?? ''), z.userId)
}

// zapis sekcji „Pozycje” sprawdza bramkę raz przed pętlą i woła poniższe funkcje z gotowym id
// zamówienia (rdzeń i tak sprawdza status pod blokadą zamówienia przy każdej zmianie).

/** Zmiana ilości po bramce (zapis sekcji). */
export function zmienIloscPoBramce(db: Db, orderId: string, lineId: string, ilosc: unknown, userId: string): Promise<WynikKarty> {
  if (!ID_RE.test(lineId)) return Promise.resolve({ blad: 'Nie ma takiej pozycji w zamówieniu', zmiana: false })
  return wykonaj(() => changeLineQty(db, orderId, lineId, Number(String(ilosc ?? '').trim()), ctxOsoby(userId)))
}

/** Usunięcie pozycji po bramce (zapis sekcji). */
export function usunPozycjePoBramce(db: Db, orderId: string, lineId: string, userId: string): Promise<WynikKarty> {
  if (!ID_RE.test(lineId)) return Promise.resolve({ blad: 'Nie ma takiej pozycji w zamówieniu', zmiana: false })
  return wykonaj(() => removeOrderLine(db, orderId, lineId, ctxOsoby(userId)))
}

/**
 * Cena i VAT z formularza: pusta cena albo pusta stawka = bez zmiany tej części. Zła cena albo stawka spoza listy =
 * komunikat; `null` = poprawne (pola w `wynik`).
 */
export function cenaIVatZFormularza(cena: unknown, vat: unknown): { blad: string } | { priceGrossGr?: number; vatRate?: string } {
  const out: { priceGrossGr?: number; vatRate?: string } = {}
  const c = String(cena ?? '').trim()
  if (c) {
    const gr = cenaZTekstu(c)
    if (gr === null) return { blad: 'Cena: liczba nieujemna, najwyżej 2 miejsca po przecinku' }
    out.priceGrossGr = gr
  }
  const v = normalizujStawke(String(vat ?? '')) // „23.00” = „23”
  if (v) {
    if (!(STAWKI_VAT_POZYCJI as readonly string[]).includes(v)) return { blad: 'Stawka VAT: wybierz jedną z listy' }
    out.vatRate = v
  }
  return out
}

/**
 * zmiana ceny i VAT po bramce (zapis sekcji); `zmiana: false`, gdy cena i stawka są takie jak były.
 * `bylo` = cena i stawka widziane na karcie: rdzeń pod blokadą odmówi, gdy ktoś zmienił je w międzyczasie.
 */
export async function zmienCenePoBramce(db: Db, orderId: string, lineId: string, cena: unknown, vat: unknown, userId: string, bylo?: NowaCena['bylo']): Promise<WynikKarty> {
  if (!ID_RE.test(lineId)) return { blad: 'Nie ma takiej pozycji w zamówieniu', zmiana: false }
  const n = cenaIVatZFormularza(cena, vat)
  if ('blad' in n) return { blad: n.blad, zmiana: false }
  if (n.priceGrossGr === undefined && n.vatRate === undefined) return { blad: null, zmiana: false }
  try {
    return { blad: null, ...(await changeLinePrice(db, orderId, lineId, { ...n, ...(bylo ? { bylo } : {}) }, ctxOsoby(userId))) }
  } catch (e) {
    if (e instanceof EdycjaError) return { blad: e.message, zmiana: false }
    throw e
  }
}

/**
 * „Cena brutto” i „VAT” jednej pozycji. Ta sama bramka co droga z karty
 * (`zapiszPozycjeKarta`): edycja pozycji (uprawnienie, tryb PRACA, ustawienie firmy) i osobno uprawnienie do cen.
 */
export async function zmienCene(db: Db, z: ZlecenieEdycji & { lineId: unknown; cena: unknown; vat: unknown }, env: Env = process.env): Promise<WynikKarty> {
  if (!z.uprawnienia.has('zamowienia.ceny_pozycji')) return { blad: BEZ_UPRAWNIENIA, zmiana: false }
  const g = await bramkaEdycji(db, z, 'zamowienia.edycja_pozycji', env)
  if (!('id' in g)) return g
  return zmienCenePoBramce(db, g.id, String(z.lineId ?? ''), z.cena, z.vat, z.userId)
}

/** „Podziel zamówienie”: `wybor` = id pozycji → sztuki (jednostka bazowa) do nowej paczki. */
export async function podzielZamowienie(db: Db, z: ZlecenieEdycji & { wybor: Record<string, unknown> }, env: Env = process.env): Promise<WynikKarty & { childOrderId?: string }> {
  const g = await bramkaEdycji(db, z, 'zamowienia.podzial', env)
  if (!('id' in g)) return g
  const wybor: Record<string, number> = {}
  for (const [lineId, v] of Object.entries(z.wybor).slice(0, 200)) {
    if (!ID_RE.test(lineId)) continue
    const n = Number(String(v ?? '').trim())
    if (n) wybor[lineId] = n
  }
  try {
    const r = await splitOrder(db, g.id, wybor, ctxOsoby(z.userId))
    return { blad: null, zmiana: true, childOrderId: r.childOrderId, info: 'pozycje.paczka', n: r.packageNo }
  } catch (e) {
    if (e instanceof EdycjaError) return { blad: e.message, zmiana: false }
    throw e
  }
}
