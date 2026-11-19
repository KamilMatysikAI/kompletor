// Bramka akcji karty zamówienia. Każda akcja zmieniająca zamówienie (pozycje, płatności, podział, dosłanie,
// nadanie, faktura) przechodzi przez `bramkaKarty`: zamówienie firmy (RLS) → obie bramki trybu PRACA
// (wyłącznik instancji `EKRANY_PRACA` i tryb konta kanału); ustawienie firmy (edycja zamówień z kanałów) sprawdza
// pozycje.ts. Konto w cieniu prowadzi BaseLinker: akcja odmawia także przy ręcznym wywołaniu.
import type { Channel, ChannelMode, PrismaClient } from '@prisma/client'
import { organizationIdOf } from '@/lib/db'
import { firmaPrzechodziZBlWPanelu } from '@/lib/kanaly/firma'
import { pracaDostepna } from '@/lib/praca/wlacznik'
import { BLEDY_KARTY } from './komunikaty'

type Db = PrismaClient
type Env = Record<string, string | undefined>

export const ID_RE = /^[a-z0-9]{1,40}$/i

// bez nazwy BL (konto w podglądzie ma też firma bez BaseLinkera) i bez słowa „cień”
// przyciski zmian są widoczne i nieaktywne z powodem (zasada fal: nic nie ukrywamy), więc baner nie obiecuje, że „pojawią się”
export const KOMUNIKAT_CIEN = 'Konto sklepu w trybie „Tylko podgląd”: Kompletor pokazuje zamówienie, a zmiany robisz tam, gdzie prowadzisz je dziś. Przyciski zmian zadziałają po włączeniu konta (Ustawienia → Sprzedaż i kanały → Kanały sprzedaży).'
// teksty błędów stałych w słowniku komunikatów (w adresie jadą kodem)
export const ODMOWA_CIEN = BLEDY_KARTY['tryb-podgladu']
export const BRAK_ZAMOWIENIA = BLEDY_KARTY['brak-zamowienia']

/** Ustawienia karty firmy (`Organization.settings.karta`). */
export interface UstawieniaKarty {
  /**
   * Edycja pozycji zamówień z kanałów (Allegro, Empik, sklep). `true` (domyślnie): wszystkie zamówienia; `false`: tylko
   * zamówienia ręczne. Wartość domyślna do potwierdzenia przez właściciela produktu (raport).
   */
  edycjaZamowienKanalow: boolean
}

export const DOMYSLNE_USTAWIENIA_KARTY: UstawieniaKarty = { edycjaZamowienKanalow: true }

export function parseUstawieniaKarty(settings: unknown): UstawieniaKarty {
  const o = settings && typeof settings === 'object' && !Array.isArray(settings) ? (settings as Record<string, unknown>) : {}
  const k = o['karta'] && typeof o['karta'] === 'object' && !Array.isArray(o['karta']) ? (o['karta'] as Record<string, unknown>) : {}
  return { edycjaZamowienKanalow: typeof k['edycjaZamowienKanalow'] === 'boolean' ? k['edycjaZamowienKanalow'] : DOMYSLNE_USTAWIENIA_KARTY.edycjaZamowienKanalow }
}

export async function ustawieniaKarty(db: Db): Promise<UstawieniaKarty> {
  organizationIdOf(db)
  const org = await db.organization.findFirst({ select: { settings: true } })
  return parseUstawieniaKarty(org?.settings)
}

/** Konto kanału zamówienia z polami, których potrzebuje karta (bez sekretów). */
export interface KontoKarty {
  channel: Channel
  channelAccountId: string
  name: string
  adapterKey: string
  config: unknown
  statusMode: ChannelMode
  /** Firma przechodzi z BaseLinkera: tryb pracy wymaga wtedy wyłącznika instancji. */
  firmaZBl: boolean
}

export async function kontoKarty(db: Db, o: { channel: Channel; channelAccountId: string }, env: Env = process.env): Promise<KontoKarty | null> {
  organizationIdOf(db)
  const [k, firmaZBl] = await Promise.all([
    db.channelConfig.findFirst({
      where: { channel: o.channel, channelAccountId: o.channelAccountId },
      select: { channel: true, channelAccountId: true, name: true, adapterKey: true, config: true, statusMode: true },
    }),
    firmaPrzechodziZBlWPanelu(db, env),
  ])
  return k ? { ...k, firmaZBl } : null
}

/** Tryb PRACA dla karty: wyłącznik instancji i tryb konta; zła wartość `EKRANY_PRACA` = brak akcji (nie psuje karty). */
export function pracaKarty(konto: (Pick<KontoKarty, 'statusMode'> & { firmaZBl?: boolean }) | null, env: Env): boolean {
  try {
    return pracaDostepna(konto, env)
  } catch {
    return false
  }
}

/**
 * powody nieaktywnych przycisków karty, gdy konto nie jest w trybie PRACA. Karta pokazuje te same przyciski co
 * w pracy, ale nieaktywne z jednym zdaniem: co zrobić i gdzie się to włącza. Bramki serwera (`bramkaKarty`) bez zmian:
 * to tylko tekst. BaseLinker z nazwy tylko dla firmy, która z niego przechodzi (zasada fal: nazwy integracji tylko tam,
 * gdzie firma je ma). Konto w PRACA zablokowane wyłącznikiem instancji: włącza administrator, nie ekran Kanały sprzedaży.
 */
export interface PowodyPodgladu {
  platnosc: string
  /** Przyciski statusu w nagłówku i w menu „Więcej” (także „Oznacz jako opłacone” z listy przejść). */
  status: string
  pozycje: string
}

export function powodyPodgladu(konto: (Pick<KontoKarty, 'statusMode'> & { firmaZBl?: boolean }) | null): PowodyPodgladu {
  const gdzie = konto?.firmaZBl ? 'w BaseLinkerze' : 'tam, gdzie prowadzisz zamówienia dziś'
  const zdanie = (co: string) =>
    konto?.statusMode === 'PRACA'
      ? `${co} ${gdzie}: tryb pracy jest wyłączony na tej instalacji Kompletora (włącza go administrator).`
      : `${co} ${gdzie}, dopóki konto sklepu jest w trybie „Tylko podgląd”. Włączysz je w Ustawienia → Sprzedaż i kanały → Kanały sprzedaży.`
  return { platnosc: zdanie('Wpłatę zapisujesz'), status: zdanie('Zmiany zamówienia robisz'), pozycje: zdanie('Pozycje zmieniasz') }
}

export type Bramka<T> = { ok: true; o: T; konto: KontoKarty | null } | { ok: false; blad: string }

/**
 * Zamówienie firmy i tryb PRACA. `wybierz` = pola zamówienia potrzebne akcji (zawsze z kanałem i kontem). Odmowa
 * z komunikatem dla karty; akcja serwera przekazuje go parametrem adresu.
 */
export async function bramkaKarty<T extends { channel: Channel; channelAccountId: string }>(db: Db, orderId: unknown, wczytaj: (id: string) => Promise<T | null>, env: Env = process.env): Promise<Bramka<T>> {
  organizationIdOf(db)
  const id = String(orderId ?? '')
  if (!ID_RE.test(id)) return { ok: false, blad: BRAK_ZAMOWIENIA }
  const o = await wczytaj(id)
  if (!o) return { ok: false, blad: BRAK_ZAMOWIENIA }
  const konto = await kontoKarty(db, o, env)
  if (!pracaKarty(konto, env)) return { ok: false, blad: ODMOWA_CIEN }
  return { ok: true, o, konto }
}
