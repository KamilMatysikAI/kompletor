// Zwroty i reklamacje w Kompletorze: nazwy statusów jak w module zwrotów BaseLinkera, rodzaje, powody
// i historia zwrotu ze zdarzeń zamówienia. Czyste funkcje (bez bazy), jedno źródło etykiet dla listy, karty zwrotu,
// karty zamówienia, Pomocy i testów.
//
// Statusy rdzenia (lib/rdzen/zwroty.ts) → nazwy BL:
//   ZGLOSZONY → Nowe (zgłoszony, paczka w drodze)      PRZYJETY → Odebrane (paczka w magazynie, pozycje oznaczone)
//   KOREKTA   → W trakcie (korekta faktury w drodze)    ZAKONCZONY → Zakończone      ODRZUCONY → Odrzucone
import type { ReturnKind, ReturnStatus } from '@prisma/client'

export const STATUSY_ZWROTU: readonly ReturnStatus[] = ['ZGLOSZONY', 'PRZYJETY', 'KOREKTA', 'ZAKONCZONY', 'ODRZUCONY']

export const STATUS_ZWROTU: Record<ReturnStatus, string> = {
  ZGLOSZONY: 'Nowe',
  PRZYJETY: 'Odebrane',
  KOREKTA: 'W trakcie',
  ZAKONCZONY: 'Zakończone',
  ODRZUCONY: 'Odrzucone',
}

/** Jedno zdanie pod nazwą statusu (lista i karta zwrotu). */
export const OPIS_STATUSU: Record<ReturnStatus, string> = {
  ZGLOSZONY: 'Zgłoszony, paczka jeszcze nie dotarła do magazynu.',
  PRZYJETY: 'Paczka w magazynie, każda pozycja oznaczona. Czeka na korektę faktury.',
  KOREKTA: 'Korekta faktury jest w drodze do programu do faktur.',
  ZAKONCZONY: 'Zwrot rozliczony: stan i dokumenty są zgodne.',
  ODRZUCONY: 'Zwrot odrzucony albo wycofany.',
}

export const TON_STATUSU: Record<ReturnStatus, 'info' | 'ostrzezenie' | 'sukces' | 'neutralny' | 'blad'> = {
  ZGLOSZONY: 'info',
  PRZYJETY: 'ostrzezenie',
  KOREKTA: 'ostrzezenie',
  ZAKONCZONY: 'sukces',
  ODRZUCONY: 'neutralny',
}

export const RODZAJ_ZWROTU: Record<ReturnKind, string> = { ZWROT: 'Zwrot', REKLAMACJA: 'Reklamacja', KOREKTA: 'Korekta bez przesyłki' }

/** Powody (kod → etykieta). Kod zapisuje się w `Return.reason`; tekst spoza listy zostaje jak jest (np. z kanału). */
export const POWODY_ZWROTU = {
  odstapienie: 'Odstąpienie od umowy (14 dni)',
  nie_pasuje: 'Nie spełnia oczekiwań',
  pomylka: 'Pomyłka w zamówieniu (zły produkt albo ilość)',
  nieodebrana: 'Paczka nieodebrana, wróciła do nadawcy',
  inny: 'Inny powód',
} as const
export const POWODY_REKLAMACJI = {
  uszkodzony: 'Produkt uszkodzony w transporcie',
  wada: 'Wada produktu',
  niezgodny: 'Produkt niezgodny z opisem',
  brak: 'Brak części zamówienia w paczce',
  inny: 'Inny powód',
} as const

/** Powody z API Allegro (`reason.type` w customer-returns) → nasz kod. Nieznany = „inny”. */
const POWOD_ALLEGRO: Record<string, string> = {
  DAMAGED: 'uszkodzony',
  DONT_LIKE_IT: 'nie_pasuje',
  DIFFERENT: 'niezgodny',
  MISTAKE: 'pomylka',
  NOT_AS_DESCRIBED: 'niezgodny',
  MISSING_PARTS: 'brak',
}
export const powodZAllegro = (typ: string | null | undefined) => (typ && POWOD_ALLEGRO[typ]) || 'inny'

export function etykietaPowodu(kind: ReturnKind, reason: string | null | undefined): string | null {
  if (!reason) return null
  const slownik: Record<string, string> = kind === 'REKLAMACJA' ? POWODY_REKLAMACJI : { ...POWODY_REKLAMACJI, ...POWODY_ZWROTU }
  return slownik[reason] ?? reason
}

export const ZRODLO_ZWROTU: Record<string, string> = { PANEL: 'Panel', ALLEGRO: 'Allegro (zwrot klienta)' }

// ─── Historia zwrotu ze zdarzeń zamówienia ─────────────────────────────────

const ZDARZENIA: Record<string, string> = {
  ZWROT_ZGLOSZONY: 'Zwrot zgłoszony',
  REKLAMACJA_ZGLOSZONA: 'Reklamacja zgłoszona',
  KOREKTA_ZLOZONA: 'Korekta bez przesyłki założona',
  ZWROT_PRZYJETY: 'Paczka odebrana w magazynie',
  ZWROT_NA_STAN: 'Towar przyjęty na stan',
  KOREKTA_ZLECONA: 'Korekta faktury zlecona',
  KOREKTA_PONOWIONA: 'Korekta ponowiona po błędzie',
  KOREKTA: 'Korekta faktury wystawiona',
  KOREKTA_POZA_KOMPLETOREM: 'Korekta wystawiona poza Kompletorem',
  ZWROT_ODRZUCONY: 'Zwrot odrzucony',
  ZWROT_PIENIEDZY: 'Pieniądze zwrócone klientowi',
}
export const ZDARZENIA_ZWROTU = Object.keys(ZDARZENIA)

export interface WpisHistorii {
  kiedy: Date
  co: string
  kto: string
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** Aktor odczytu zwrotów z kanału (lib/zwroty/z-kanalu.ts). */
export const AKTOR_ZWROTOW_KANALU = 'system:zwroty-kanalu'

/** Kto: osoba (`user:<id>` → imię z mapy `id → nazwa`), tory panelu, odczyt kanału albo „system”. */
export function ktoZrobil(actorId: string, osoby: ReadonlyMap<string, string>): string {
  if (actorId.startsWith('user:')) return osoby.get(actorId.slice(5)) ?? 'użytkownik'
  if (actorId === AKTOR_ZWROTOW_KANALU) return 'odczyt zwrotów z kanału'
  if (actorId === 'panel') return 'biuro'
  if (actorId === 'magazyn') return 'magazyn'
  return 'system'
}

/** Historia jednego zwrotu (zdarzenia zamówienia z `data.returnId`), od najstarszego. */
export function historiaZwrotu(returnId: string, zdarzenia: readonly { kind: string; actorId: string; createdAt: Date; data: unknown }[], osoby: ReadonlyMap<string, string>): WpisHistorii[] {
  return zdarzenia
    .filter((e) => e.kind in ZDARZENIA && obj(e.data)['returnId'] === returnId)
    .map((e) => {
      const d = obj(e.data)
      let co = ZDARZENIA[e.kind]!
      if (e.kind === 'KOREKTA' && typeof d['docId'] === 'string' && !d['pozaKompletorem']) co += ` (dokument ${d['docId']})`
      // „na stan” bez sztuk na stan (same uszkodzone) to rozliczenie zwrotu, nie przyjęcie na stan
      if (e.kind === 'ZWROT_NA_STAN') co = Number(d['naStan'] ?? 1) > 0 ? `Towar przyjęty na stan${Number(d['pozaStanem'] ?? 0) > 0 ? ' (uszkodzone poza sprzedażą)' : ''}` : 'Zwrot rozliczony: towar uszkodzony, poza sprzedażą'
      if (e.kind === 'KOREKTA_POZA_KOMPLETOREM' && typeof d['numer'] === 'string' && d['numer']) co += ` (numer ${d['numer']})`
      return { kiedy: e.createdAt, co, kto: ktoZrobil(e.actorId, osoby) }
    })
    .sort((a, b) => a.kiedy.getTime() - b.kiedy.getTime())
}
