// Kod karty zamówienia na stanowisku pakowania. Czyste funkcje — testy w kod.test.ts.
// Treść kodu buduje lib/wydruki (kodKarty: SD48213/1, dosyłka SD48213-2/1); tu: odczyt skanu z tolerancją na to,
// co dokleja czytnik, i zamiana zamówienia na kod karty (przedrostek konta + numer liczbowy).
import type { Channel } from '@prisma/client'
import { channelPrefix } from '@/lib/panel/format'
import { kodKarty, odczytajKodKarty, type NumerZamowienia } from '@/lib/wydruki'

/** Kod karty po odczycie: kod zamówienia bez numeru wydruku (klucz rejestru wydruków) i numer wydruku. */
export interface SkanKarty {
  /** Np. „SD48213” albo „SD48213-2” (dosyłka) — `OrderCardPrint.orderCode`. */
  kodZamowienia: string
  numerWydruku: number
  zamowienie: NumerZamowienia
}

const MAX_SKANU = 64

/**
 * Odczyt tego, co przyszło z czytnika (albo wpisane ręcznie). Czytnik bywa ustawiony różnie: identyfikator AIM
 * („]C1”), znaki sterujące (Enter, Tab, GS), spacje nierozdzielające, ręcznie przepisany numer z karty
 * „SD 48213-2 / 1”. Wszystko poza tym wzorem = null (nieznany kod), bez zgadywania.
 */
export function odczytajSkan(tekst: string): SkanKarty | null {
  if (typeof tekst !== 'string' || tekst.length > MAX_SKANU * 4) return null
  const czysty = tekst
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f​-‍⁠﻿]/g, '')
    .trim()
    .replace(/^\]C\d/i, '')
    .replace(/\s+/g, '')
  if (!czysty || czysty.length > MAX_SKANU) return null
  const k = odczytajKodKarty(czysty)
  if (!k || !Number.isSafeInteger(k.numerWydruku) || k.numerWydruku > 1_000_000) return null
  // kod sklejany tak samo jak przy wydruku: „SD0048213” to inny numer niż „SD48213”, nic nie obcinamy;
  // numer wydruku 0 albo podzamówienie 0 = kod, którego system nie drukuje → null
  let pelny: string
  try {
    pelny = kodKarty(k.zamowienie, k.numerWydruku)
  } catch {
    return null
  }
  return { kodZamowienia: pelny.slice(0, pelny.lastIndexOf('/')), numerWydruku: k.numerWydruku, zamowienie: k.zamowienie }
}

/** Kod zamówienia do rejestru wydruków (kod karty bez „/<numer wydruku>”); rzuca wyjątek jak kodKarty. */
export function kodZamowieniaKarty(z: NumerZamowienia): string {
  const k = kodKarty(z, 1)
  return k.slice(0, k.lastIndexOf('/'))
}

/**
 * Przedrostek kanału do kodu kreskowego: ten sam co w panelu (channelPrefix), ale wyłącznie litery A–Z, bo kod
 * karty nie przyjmuje innych znaków („RĘ” → „RE”). Pusty wynik → „X”.
 */
export function przedrostekKodu(channel: Channel, accountName: string | null | undefined): string {
  const p = channelPrefix(channel, accountName)
    .normalize('NFKD')
    .replace(/Ł/g, 'L')
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
  return p || 'X'
}

/**
 * Numer liczbowy zamówienia na karcie. Kod karty przyjmuje same cyfry (lib/wydruki), a nie każdy kanał ma
 * liczbowy identyfikator (Allegro: UUID). Kolejność: id z kanału, gdy liczbowy (sklep Woo, Empik bez sufiksu) →
 * numer zamówienia w kanale z cienia (ChannelOrderSnapshot.channelNumber, numeracja wtyczki Woo) → numer
 * zamówienia w BaseLinkerze (Order.blOrderId albo z porównania cienia). Brak każdego = null: karty nie da się
 * wydrukować, dopóki porównanie z BL nie poda numeru.
 */
export function numerDoKarty(z: { externalId: string; channelNumber?: string | null; blOrderId?: number | null }): string | null {
  const liczba = (v: string | null | undefined) => (v && /^\d{1,18}$/.test(v.trim()) ? v.trim() : null)
  return liczba(z.externalId) ?? liczba(z.channelNumber) ?? (z.blOrderId && z.blOrderId > 0 ? String(z.blOrderId) : null)
}

/**
 * Numer zamówienia do karty i listy wysyłkowej — jedna reguła dla stanowiska i kolejki pakowania.
 * `numerZrodlowy` = zamówienie nadrzędne dosyłki albo samo zamówienie; `podzamowienie` tylko dla dosyłki.
 * Null = bez numeru liczbowego (wtedy karty nie ma; ekran pokazuje id z kanału).
 */
export function numerKartyZamowienia(z: {
  channel: Channel
  nazwaKonta: string | null | undefined
  numerZrodlowy: { externalId: string; channelNumber?: string | null; blOrderId?: number | null }
  podzamowienie: number | null
}): NumerZamowienia | null {
  const numer = numerDoKarty(z.numerZrodlowy)
  return numer ? { przedrostek: przedrostekKodu(z.channel, z.nazwaKonta), numer, podzamowienie: z.podzamowienie } : null
}
