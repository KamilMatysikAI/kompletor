// Adres publicznej strony śledzenia paczki u przewoźnika: jedna funkcja dla karty zamówienia, listy przesyłek i
// (później) maila i API. Czyste funkcje, bez bazy i bez sieci; w adresie tylko numer nadania (nie jest daną osobową).
//
// Formaty sprawdzone na stronach przewoźników (14.11.2026):
// - InPost (paczkomaty i kurier): https://inpost.pl/sledzenie-przesylek?number=<numer> (strona czyta parametr i oddaje
//   go w linkach wersji językowych);
// - DPD Polska (także DPD do salonu Empik): https://tracktrace.dpd.com.pl/parcelDetails?typ=1&p1=<numer> (formularz
//   GET strony tracktrace.dpd.com.pl: `typ=1` = numer paczki, pole `p1`);
// - GLS Polska: https://gls-group.com/PL/pl/sledzenie-paczek?match=<numer> (formularz GET z polem `match`).
// Bez linku, dopóki adres z numerem nie jest potwierdzony: Poczta Polska (formularz wysyła numer metodą POST), Orlen
// Paczka (formularz budowany skryptem), Allegro (przewoźnik ustalany przez Allegro, strona śledzenia za ochroną przed
// botami). Dla nich karta pokazuje sam numer do skopiowania.
//
// Link tylko wtedy, gdy paczkę nadał moduł tego samego przewoźnika (InPost ShipX, DPD Services, GLS ADE). Przewoźnik
// przesyłki (`Shipment.carrier`) pochodzi z reguły firmy, a paczkę mógł nadać pośrednik (Wysyłam z Allegro, Base
// Courier), który dobiera przewoźnika sam: numer takiej paczki nie musi być numerem DPD ani InPost, więc bez linku,
// dopóki nie potwierdzimy tego na prawdziwych paczkach.
import type { Carrier } from '@prisma/client'
import { DPD_KEY, DPD_ZAPIS_KEY } from '../adaptery/dpd'
import { GLS_KEY, GLS_ZAPIS_KEY } from '../adaptery/gls'
import { INPOST_SHIPX_KEY } from '../adaptery/inpost'
import { INPOST_SHIPX_ZAPIS_KEY } from '../adaptery/inpost-zapis'

/** Numer nadania, który wolno wstawić do adresu: litery, cyfry i myślnik, 6–40 znaków (spacje usuwane). */
const NUMER_RE = /^[A-Za-z0-9-]{6,40}$/

const ADRESY: Partial<Record<Carrier, (numer: string) => string>> = {
  PACZKOMATY: (n) => `https://inpost.pl/sledzenie-przesylek?number=${n}`,
  INPOST_KURIER: (n) => `https://inpost.pl/sledzenie-przesylek?number=${n}`,
  DPD: (n) => `https://tracktrace.dpd.com.pl/parcelDetails?typ=1&p1=${n}`,
  DPD_EMPIK: (n) => `https://tracktrace.dpd.com.pl/parcelDetails?typ=1&p1=${n}`,
  GLS: (n) => `https://gls-group.com/PL/pl/sledzenie-paczek?match=${n}`,
}

const MODULY_INPOST: ReadonlySet<string> = new Set([INPOST_SHIPX_KEY, INPOST_SHIPX_ZAPIS_KEY])
const MODULY_DPD: ReadonlySet<string> = new Set([DPD_KEY, DPD_ZAPIS_KEY])

/** Moduły, których numer nadania jest numerem danego przewoźnika (link wolno zbudować tylko dla nich). */
const MODULY_PRZEWOZNIKA: Partial<Record<Carrier, ReadonlySet<string>>> = {
  PACZKOMATY: MODULY_INPOST,
  INPOST_KURIER: MODULY_INPOST,
  DPD: MODULY_DPD,
  DPD_EMPIK: MODULY_DPD,
  GLS: new Set([GLS_KEY, GLS_ZAPIS_KEY]),
}

/** Nazwa strony przewoźnika w tekście linku („Śledź na stronie InPost”). */
const NAZWA_STRONY: Partial<Record<Carrier, string>> = {
  PACZKOMATY: 'InPost',
  INPOST_KURIER: 'InPost',
  DPD: 'DPD',
  DPD_EMPIK: 'DPD',
  GLS: 'GLS',
}

/** Numer nadania gotowy do adresu albo null (pusty, za krótki, ze znakami spoza listy). */
export function numerDoAdresu(numer: string | null | undefined): string | null {
  const n = (numer ?? '').replace(/\s+/g, '')
  return NUMER_RE.test(n) ? n : null
}

/**
 * Adres strony śledzenia u przewoźnika; null = przewoźnik bez potwierdzonego adresu, paczkę nadał moduł innego
 * podmiotu (np. Wysyłam z Allegro, Base Courier) albo numer nie nadaje się do linku.
 */
export function linkSledzenia(carrier: Carrier, numer: string | null | undefined, adapterKey: string): string | null {
  if (!MODULY_PRZEWOZNIKA[carrier]?.has(adapterKey)) return null
  const adres = ADRESY[carrier]
  const n = numerDoAdresu(numer)
  return adres && n ? adres(encodeURIComponent(n)) : null
}

/** Nazwa przewoźnika do tekstu linku; null = bez linku. */
export function stronaSledzenia(carrier: Carrier): string | null {
  return NAZWA_STRONY[carrier] ?? null
}

/** Numer do adresu w mailu: litery i cyfry, 6–40 znaków (19.11.2026, mail „Faktura”). */
const NUMER_MAILA_RE = /^[A-Za-z0-9]{6,40}$/

/**
 * Link do śledzenia przesyłki w mailu do klienta (mail „Faktura”, od 19.11.2026 na produkcji): po samym przewoźniku
 * przesyłki (InPost, DPD), bez sprawdzania modułu, który ją nadał (także Base Courier); pozostali = null (mail
 * pokazuje wtedy sam numer). API i zapis do kanału biorą ostrzejszy `linkSledzenia` wyżej, panel `linkSledzeniaPanelu`.
 */
export function linkSledzeniaDoMaila(carrier: string | null | undefined, numer: string | null | undefined): string | null {
  const n = numer?.trim() ?? ''
  if (!NUMER_MAILA_RE.test(n)) return null
  switch (carrier) {
    case 'PACZKOMATY':
    case 'INPOST_KURIER':
      return `https://inpost.pl/sledzenie-przesylek?number=${n}`
    case 'DPD':
    case 'DPD_EMPIK':
      return `https://tracktrace.dpd.com.pl/parcelDetails?typ=1&p1=${n}`
    default:
      return null
  }
}

/**
 * Link do śledzenia w panelu (karta zamówienia, lista zamówień, lista Przesyłki): numer nadany modułem przewoźnika jak
 * `linkSledzenia`, a paczka nadana przez pośrednika (np. Base Courier) według reguły maila, gdy przewoźnik przesyłki
 * ma znany adres śledzenia (InPost, DPD). Obsługa widzi wtedy stronę przewoźnika jednym kliknięciem, tak jak klient
 * w mailu. Kontrakt API i zapis do kanału zostają przy ostrzejszym `linkSledzenia`.
 */
export function linkSledzeniaPanelu(carrier: Carrier, numer: string | null | undefined, adapterKey: string): string | null {
  return linkSledzenia(carrier, numer, adapterKey) ?? linkSledzeniaDoMaila(carrier, numer)
}
