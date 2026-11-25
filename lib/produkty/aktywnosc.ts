// (zlecenie): wyłączanie i włączanie produktu (`Product.active`). Jedyna droga zapisu flagi:
// karta produktu (przycisk „Wyłącz produkt” / „Włącz produkt”), lista (zaznaczone → „Wyłącz / włącz”) i import CSV
// (kolumna „Aktywny”: tak / nie). Uprawnienie `produkty.dodawanie` (dodawanie i edycja produktów).
//
// Co znaczy wyłączony produkt w reszcie systemu: znika z domyślnej listy (zakładka „Wyłączone”), z kafli kompletności,
// raportu dziennego i alertów niskiego stanu; nie da się go dodać do zamówienia ręcznie, wybrać jako zamiennika ani
// powiązać z ofertą. Stan magazynowy, historia, zdjęcia i kategoria zostają (nic nie kasujemy). Import z kanału, BL
// i odczyt stanów z wFirmy flagi nie zmieniają, więc nie włączą produktu z powrotem.
//
// Zapis stanów do kanałów i mapowanie nowych zamówień idą jednak po AKTYWNEJ OFERCIE, nie po fladze produktu. Dlatego
// wyłączenie produktu ODMAWIA (per produkt, z powodem), gdy produkt: ma aktywną ofertę w kanale, ma rezerwację w toku,
// jest w otwartym zamówieniu albo jest składnikiem aktywnego zestawu spoza wyłączanych. Inaczej powstałby produkt
// „wyłączony”, który dalej sprzedaje się w sklepie i rezerwuje stan. Stan > 0 nie blokuje (uwaga: stan zostaje).
// Masowo: produkty bez przeszkód zmieniają się, reszta wraca z powodem (jeden zły nie blokuje pozostałych).
import type { OrderStatus, Prisma, PrismaClient } from '@prisma/client'

type Db = PrismaClient | Prisma.TransactionClient
export type Wynik<T> = { ok: true; value: T } | { ok: false; error: string }

export const AKTYWNOSC_MASOWO_MAX = 1000
/** Zamówienie zamknięte dla wyłączenia: wysłane, odebrane, anulowane albo już w reklamacji (po wysyłce). */
export const ZAMKNIETE_DLA_WYLACZENIA: OrderStatus[] = ['WYSLANE', 'ODEBRANE', 'ANULOWANE', 'REKLAMACJA']
const ID = /^[a-z0-9]{1,40}$/i
const POKAZ = 3

export interface Odmowa {
  productId: string
  sku: string
  powod: string
}
export interface WynikAktywnosci {
  zmienione: number
  bezZmian: number
  odmowy: Odmowa[]
  uwagi: { productId: string; sku: string; komunikat: string }[]
}

/**
 * Strażnik ofert: które z podanych produktów są wyłączone (id → SKU). Automatyczna ścieżka zapisu oferty (import
 * katalogu, przeprowadzka, ręczna zmiana oferty) nie aktywuje, nie wznawia i nie przepina oferty na produkt z tej
 * mapy: zapis stanów i mapowanie zamówień idą po aktywnej ofercie, więc wyłączony produkt dalej by się sprzedawał.
 */
export async function wylaczoneProdukty(db: Db, ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const szukane = [...new Set(ids.filter((x): x is string => !!x))]
  if (!szukane.length) return new Map()
  const xs = await db.product.findMany({ where: { id: { in: szukane }, active: false }, select: { id: true, sku: true } })
  return new Map(xs.map((p) => [p.id, p.sku]))
}
export const powodOfertaWylaczony = (sku: string) => `produkt ${sku} jest wyłączony: oferta zostaje nieaktywna (włącz produkt na karcie, następny import ją podepnie)`

const lista = (xs: string[]) => [...new Set(xs)].slice(0, POKAZ).join(', ') + (new Set(xs).size > POKAZ ? ` i ${new Set(xs).size - POKAZ} więcej` : '')

const dodaj = (m: Map<string, string[]>, id: string, s: string) => m.set(id, [...(m.get(id) ?? []), s])

/** Przeszkody niezależne od zestawu: aktywna oferta, rezerwacja w toku, otwarte zamówienie (bez pozycji zdjętych w kanale). */
async function przeszkodyWlasne(db: Db, ids: readonly string[], out: Map<string, string[]>): Promise<void> {
  if (!ids.length) return
  const [oferty, rezerwacje, linie] = await Promise.all([
    db.channelOffer.findMany({ where: { productId: { in: [...ids] }, active: true }, select: { productId: true, channel: true, channelAccountId: true } }),
    db.reservation.groupBy({ by: ['productId'], where: { productId: { in: [...ids] }, state: { in: ['ACTIVE', 'CONSUMING'] } }, _count: { _all: true } }),
    // pozycja zdjęta w kanale (`removed`) ma już zwolnioną rezerwację i nie blokuje
    db.orderLine.findMany({ where: { productId: { in: [...ids] }, removed: false, order: { status: { notIn: ZAMKNIETE_DLA_WYLACZENIA } } }, select: { productId: true, order: { select: { externalId: true } } } }),
  ])
  const po = <T extends { productId: string | null }>(xs: T[]) => {
    const m = new Map<string, T[]>()
    for (const x of xs) if (x.productId) m.set(x.productId, [...(m.get(x.productId) ?? []), x])
    return m
  }
  for (const [id, xs] of po(oferty)) dodaj(out, id, `ma aktywną ofertę w kanale (${lista(xs.map((o) => `${o.channel} ${o.channelAccountId}`))}): odłącz ją na karcie produktu (Powiązania) albo wyłącz w sklepie`)
  for (const r of rezerwacje) dodaj(out, r.productId, `ma rezerwację w toku (${r._count._all}): poczekaj na spakowanie albo anulowanie zamówienia`)
  for (const [id, xs] of po(linie)) dodaj(out, id, `jest w otwartym zamówieniu (${lista(xs.map((l) => l.order.externalId))})`)
}

/** Składniki aktywnego zestawu spoza `razem` (zestaw wyłączany w tym samym zapisie nie blokuje składnika). */
async function przeszkodyZestawu(db: Db, ids: readonly string[], razem: readonly string[], out: Map<string, string[]>): Promise<void> {
  if (!ids.length) return
  const zestawy = await db.bundleComponent.findMany({ where: { componentId: { in: [...ids] }, bundleId: { notIn: [...razem] }, bundle: { active: true } }, select: { componentId: true, bundle: { select: { sku: true } } } })
  const zZestawu = new Map<string, string[]>()
  for (const z of zestawy) zZestawu.set(z.componentId, [...(zZestawu.get(z.componentId) ?? []), z.bundle.sku])
  for (const [id, sku] of zZestawu) dodaj(out, id, `jest składnikiem aktywnego zestawu (${lista(sku)}): najpierw wyłącz zestaw albo zmień jego skład`)
}

/**
 * Powody, dla których produktów nie wolno teraz wyłączyć (id → lista zdań). Zestaw nie blokuje składnika tylko wtedy,
 * gdy sam NAPRAWDĘ wyłącza się w tym zapisie. `razem` podane = ten zbiór przyjęty z góry; bez niego liczony do
 * ustalenia: najpierw przeszkody własne, potem przeszkoda zestawu na zbiorze faktycznie wyłączanych, aż zbiór
 * przestanie maleć (zestaw z odmową zostaje aktywny i blokuje składnik, a odmowa składnika-zestawu blokuje dalej).
 */
export async function przeszkodyWylaczenia(db: Db, ids: readonly string[], razem?: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (!ids.length) return out
  await przeszkodyWlasne(db, ids, out)
  let wylaczane = razem ? [...razem] : ids.filter((id) => !out.has(id))
  // każdy obrót usuwa co najmniej jeden id albo kończy pętlę, więc najwyżej ids.length obrotów
  for (let i = 0; !razem && i < ids.length; i++) {
    const proba = new Map<string, string[]>()
    await przeszkodyZestawu(db, wylaczane, wylaczane, proba)
    if (!proba.size) break
    wylaczane = wylaczane.filter((id) => !proba.has(id))
  }
  await przeszkodyZestawu(db, ids, wylaczane, out)
  return out
}

/**
 * Wyłącza (`aktywny = false`) albo włącza produkty. Zmienia tylko produkty z inną flagą (ponowienie = 0 zmian), z wpisem
 * w historii każdego zmienionego produktu (AuditLog `Product`, pole `active`). Jedna transakcja; przeszkody liczone
 * w niej, tuż przed zapisem. Produkt z przeszkodą zostaje bez zmian i wraca w `odmowy`.
 */
export async function ustawAktywnosc(db: PrismaClient, productIds: readonly string[], aktywny: boolean, userId: string): Promise<Wynik<WynikAktywnosci>> {
  const ids = [...new Set(productIds)]
  if (!ids.length) return { ok: false, error: 'Zaznacz produkty.' }
  if (ids.length > AKTYWNOSC_MASOWO_MAX) return { ok: false, error: `Najwyżej ${AKTYWNOSC_MASOWO_MAX} produktów naraz.` }
  if (ids.some((i) => !ID.test(i))) return { ok: false, error: 'Nie ma takiego produktu.' }
  return db.$transaction(async (tx) => {
    const produkty = await tx.product.findMany({ where: { id: { in: ids } }, select: { id: true, sku: true, active: true, kind: true, stocks: { select: { physical: true } }, bundleComponents: { select: { component: { select: { sku: true, active: true } } } } } })
    if (produkty.length !== ids.length) return { ok: false as const, error: 'Któregoś produktu nie ma w katalogu (odśwież stronę).' }
    const doZmiany = produkty.filter((p) => p.active !== aktywny)
    const przeszkody = aktywny ? new Map<string, string[]>() : await przeszkodyWylaczenia(tx, doZmiany.map((p) => p.id))
    const odmowy: Odmowa[] = []
    const uwagi: WynikAktywnosci['uwagi'] = []
    const kandydaci = doZmiany.filter((p) => {
      const pr = przeszkody.get(p.id)
      if (pr?.length) odmowy.push({ productId: p.id, sku: p.sku, powod: pr.join('; ') })
      return !pr?.length
    })
    // Zmienione = wiersze, które TO updateMany naprawdę przestawiło: równoległy zapis tej samej flagi (druga sesja)
    // zostawia 0 wierszy i wtedy bez wpisu w historii i bez liczenia jako „zmienione” (liczy się jako bez zmian).
    const przestawione = kandydaci.length
      ? new Set((await tx.product.updateManyAndReturn({ where: { id: { in: kandydaci.map((p) => p.id) }, active: !aktywny }, data: { active: aktywny }, select: { id: true } })).map((x) => x.id))
      : new Set<string>()
    const zmiana = kandydaci.filter((p) => przestawione.has(p.id))
    if (zmiana.length) await tx.auditLog.createMany({ data: zmiana.map((p) => ({ entity: 'Product', entityId: p.id, actorId: userId, before: { active: !aktywny }, after: { active: aktywny } })) })
    for (const p of zmiana) {
      const stan = p.stocks.reduce((s, x) => s + x.physical, 0)
      if (!aktywny && p.kind === 'STOCKED' && stan > 0) uwagi.push({ productId: p.id, sku: p.sku, komunikat: `stan ${stan} zostaje w magazynie (nie liczy się w raportach ani kafelkach, dopóki produkt jest wyłączony)` })
      const wylaczone = p.bundleComponents.filter((c) => !c.component.active).map((c) => c.component.sku)
      if (aktywny && wylaczone.length) uwagi.push({ productId: p.id, sku: p.sku, komunikat: `zestaw ma wyłączone składniki (${lista(wylaczone)})` })
    }
    return { ok: true as const, value: { zmienione: zmiana.length, bezZmian: produkty.length - doZmiany.length + (kandydaci.length - zmiana.length), odmowy, uwagi } }
  })
}

/** Wartość kolumny „Aktywny” z pliku CSV (jak w eksporcie: „tak” / „nie”; także 1/0). Pusta = bez zmian. */
export function parsujAktywny(v: string | undefined): Wynik<boolean | undefined> {
  const s = (v ?? '').trim().toLowerCase()
  if (!s) return { ok: true, value: undefined }
  if (s === 'tak' || s === '1') return { ok: true, value: true }
  if (s === 'nie' || s === '0') return { ok: true, value: false }
  return { ok: false, error: `Kolumna „Aktywny”: „${s.slice(0, 20)}” — wpisz „tak” albo „nie” (albo zostaw pustą, żeby nic nie zmieniać).` }
}

/** Uwagi po zapisie (stan zostaje, zestaw z wyłączonymi składnikami) dla toastu w panelu (≤ 300 znaków). */
export function opisUwag(uwagi: WynikAktywnosci['uwagi']): string {
  if (!uwagi.length) return ''
  const reszta = uwagi.length > 1 ? ` Uwagi razem: ${uwagi.length} (${lista(uwagi.map((u) => u.sku))}).` : ''
  return `Uwaga, ${uwagi[0]!.sku}: ${uwagi[0]!.komunikat}.${reszta}`.slice(0, 300)
}

/** Krótki opis wyniku dla komunikatu w panelu (toast ≤ 300 znaków). */
export function opisOdmow(odmowy: readonly Odmowa[]): string {
  if (!odmowy.length) return ''
  const pierwsza = odmowy[0]!
  const reszta = odmowy.length > 1 ? ` Pominięte razem: ${odmowy.length} (${lista(odmowy.map((o) => o.sku))}).` : ''
  return `Nie wyłączono ${pierwsza.sku}: ${pierwsza.powod}.${reszta}`.slice(0, 300)
}
