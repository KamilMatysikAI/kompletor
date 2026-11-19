// Wyłącznik ekranów trybu PRACA na karcie zamówienia. Sekcja „Co dalej” i jej akcje działają tylko,
// gdy instancja ma `EKRANY_PRACA=1` I konto kanału zamówienia ma `statusMode = PRACA`. Konto „Tylko podgląd” (CIEN) prowadzi BaseLinker albo sklep,
// więc tam sekcji nie ma, a akcja serwera odmawia także przy ręcznym wywołaniu.
// wyłącznik instancji dotyczy tylko firm przechodzących z BaseLinkera (R28: firma bez BL startuje w trybie
// pracy i przełącza konta z panelu). Firma bez BL = druga bramka (tryb konta) wystarcza. Reguła w jednym miejscu:
// `trybPracyInstancji` (czyta ją też `blokadaInstancji` w lib/kanaly/tryb.ts, ekran i akcje).
import type { Channel, ChannelMode, PrismaClient } from '@prisma/client'
import { organizationIdOf } from '@/lib/db'
import { firmaPrzechodziZBlWPanelu } from '@/lib/kanaly/firma'

type Db = PrismaClient

/**
 * `EKRANY_PRACA`: `1` = ekrany trybu PRACA włączone na tej instancji, puste albo `0` = wyłączone (domyślnie). Zła
 * wartość = błąd, nie po cichu (wzorem `cienOdczytZEnv`).
 */
export function ekranyPracaZEnv(env: Record<string, string | undefined>): boolean {
  const v = (env.EKRANY_PRACA ?? '').trim()
  if (v === '1') return true
  if (v === '' || v === '0') return false
  throw new Error('EKRANY_PRACA: 1 (włączone), 0 albo puste (wyłączone)')
}

/**
 * Czy instancja pozwala tej firmie na tryb pracy. Firma z BaseLinkerem: tylko przy `EKRANY_PRACA=1`
 * (administrator instancji decyduje, zachowanie jak przed zmianą). Firma bez BaseLinkera: zawsze. Zła wartość zmiennej =
 * wyjątek także dla firmy bez BL (nie po cichu).
 */
export function trybPracyInstancji(env: Record<string, string | undefined>, firmaZBl: boolean): boolean {
  const wlaczone = ekranyPracaZEnv(env)
  return wlaczone || !firmaZBl
}

/** Konto kanału zamówienia; brak konfiguracji = cień (tak samo jak stanowisko i decyzje o brakach). */
export interface KontoZamowienia {
  statusMode: ChannelMode | null
  /** Firma przechodzi z BaseLinkera. Brak pola = tak (ostrożnie: wymaga wyłącznika instancji). */
  firmaZBl?: boolean
}

/** Obie bramki naraz: wyłącznik instancji (dla firmy z BL) i tryb konta. */
export function pracaDostepna(konto: KontoZamowienia | null, env: Record<string, string | undefined>): boolean {
  const instancja = trybPracyInstancji(env, konto?.firmaZBl !== false)
  return instancja && konto?.statusMode === 'PRACA'
}

/** Tryb konta kanału zamówienia, odczyt jak w `orderDetail` (lib/panel/dane.ts). Klient bazy firmy (RLS). */
export async function kontoZamowienia(db: Db, o: { channel: Channel; channelAccountId: string }, env: Record<string, string | undefined> = process.env): Promise<KontoZamowienia | null> {
  organizationIdOf(db)
  const [k, firmaZBl] = await Promise.all([db.channelConfig.findFirst({ where: { channel: o.channel, channelAccountId: o.channelAccountId }, select: { statusMode: true } }), firmaPrzechodziZBlWPanelu(db, env)])
  return k ? { ...k, firmaZBl } : null
}
