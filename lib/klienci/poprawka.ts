// Poprawka adresu dostawy i punktu odbioru przed nadaniem (B2 z luk wobec BL). Klient podał zły numer domu,
// paczkomat jest pełny, kanał dał ulicę z numerem w jednej linii: człowiek z uprawnieniem `klienci.dane` poprawia to na
// karcie zamówienia, zanim powstanie przesyłka. Kolejność: odczyt rekordu z celem POPRAWKA (wpis w dzienniku podglądów),
// walidacja, zapis zaszyfrowany jako RECZNE (automat z kanału już go nie nadpisze), drugi wpis w dzienniku z NAZWAMI
// zmienionych pól (bez wartości) i ślad KLIENT_ZAPIS. Dane do faktury, e-mail, uwagi i login zostają bez zmian.
// Komunikaty bez danych klienta: tylko nazwy pól.
import type { Prisma, PrismaClient } from '@prisma/client'
import type { Env } from '../sekrety'
import { przesylkaPodBlokada } from '../wysylka/nadanie'
import { daneKlienta, PODGLAD_AUDIT } from './odczyt'
import { PUSTY_REKORD, type RekordKlienta } from './rekord'
import { normalizujTelefon } from './skroty'
import { sladZapisu, zapiszRekordKlienta } from './zapis'

export class BladPoprawki extends Error {}

export const PRZESYLKA_JEST = 'Przesyłka już jest utworzona: adres zmienia się w panelu przewoźnika, nie tutaj.'

export interface PoprawkaDostawy {
  imieNazwisko: string | null
  firma: string | null
  ulica: string | null
  numerDomu: string | null
  numerLokalu: string | null
  kodPocztowy: string | null
  miasto: string | null
  telefon: string | null
  /** Kod punktu odbioru (paczkomat, punkt DPD, salon Empik); pusty = bez punktu. */
  punkt: string | null
}

const KOD_PL = /^\d{2}-\d{3}$/
const PUNKT = /^[A-Za-z0-9_-]{2,40}$/

function pole(form: FormData, nazwa: string, etykieta: string, max = 200): string | null {
  const v = String(form.get(nazwa) ?? '').trim()
  if (!v) return null
  if (v.length > max) throw new BladPoprawki(`${etykieta}: najwyżej ${max} znaków`)
  return v
}

/** Poprawka z formularza karty; błąd = BladPoprawki z nazwą pola (bez wartości). */
export function poprawkaZFormularza(form: FormData): PoprawkaDostawy {
  const p: PoprawkaDostawy = {
    imieNazwisko: pole(form, 'imie', 'Imię i nazwisko'),
    firma: pole(form, 'firma', 'Firma'),
    ulica: pole(form, 'ulica', 'Ulica'),
    numerDomu: pole(form, 'dom', 'Numer domu', 20),
    numerLokalu: pole(form, 'lokal', 'Numer lokalu', 20),
    kodPocztowy: pole(form, 'kod', 'Kod pocztowy', 10),
    miasto: pole(form, 'miasto', 'Miasto'),
    telefon: pole(form, 'telefon', 'Telefon', 30),
    punkt: pole(form, 'punkt', 'Punkt odbioru', 40),
  }
  if (!p.imieNazwisko && !p.firma) throw new BladPoprawki('Podaj imię i nazwisko albo firmę odbiorcy')
  const adres = p.ulica || p.numerDomu || p.kodPocztowy || p.miasto
  if (!adres && !p.punkt) throw new BladPoprawki('Podaj adres dostawy albo punkt odbioru')
  if (adres && (!p.ulica || !p.kodPocztowy || !p.miasto)) throw new BladPoprawki('Adres dostawy: ulica, kod pocztowy i miasto razem')
  if (p.kodPocztowy && !KOD_PL.test(p.kodPocztowy)) throw new BladPoprawki('Kod pocztowy w formacie NN-NNN')
  if (p.telefon && !normalizujTelefon(p.telefon)) throw new BladPoprawki('Telefon: co najmniej 9 cyfr')
  if (p.punkt && !PUNKT.test(p.punkt)) throw new BladPoprawki('Punkt odbioru: kod z liter, cyfr, „-” i „_” (np. POZ08M)')
  return p
}

/** Nazwy pól, które poprawka zmienia względem rekordu (do dziennika, bez wartości). */
export function zmienionePola(stary: RekordKlienta, p: PoprawkaDostawy): string[] {
  const d = stary.dostawa
  const pary: [string, string | null | undefined, string | null][] = [
    // odbiorca = dostawa; nabywca tylko, gdy dostawy nie ma (odbiorcaZRekordu bierze wtedy nabywcę)
    ['imie_nazwisko', d ? d.imieNazwisko : stary.nabywca?.imieNazwisko, p.imieNazwisko],
    ['firma', d ? d.firma : stary.nabywca?.firma, p.firma],
    ['ulica', d?.ulica, p.ulica],
    ['numer_domu', d?.numerDomu, p.numerDomu],
    ['numer_lokalu', d?.numerLokalu, p.numerLokalu],
    ['kod_pocztowy', d?.kodPocztowy, p.kodPocztowy],
    ['miasto', d?.miasto, p.miasto],
    ['telefon', stary.telefon, p.telefon],
    ['punkt', stary.punktOdbioru?.kod, p.punkt],
  ]
  return pary.filter(([, a, b]) => (a ?? null) !== b).map(([k]) => k)
}

/**
 * Rekord po poprawce: odbiorca (dostawa) i punkt z poprawki, reszta (nabywca, faktura, e-mail, uwagi, login) ze starego.
 * Nabywca zostaje (przy prezencie kupuje A, odbiera B); z poprawki tylko, gdy rekord go nie miał.
 * Sam punkt odbioru bez adresu: dostawa z nazwiskiem odbiorcy i pustym adresem (kształt jak z kanału, `rekordZOdbiorcy`),
 * żeby poprawione nazwisko odbiorcy paczkomatu nie nadpisywało nabywcy.
 */
export function rekordPoPoprawce(stary: RekordKlienta, p: PoprawkaDostawy): RekordKlienta {
  const adres = p.ulica || p.kodPocztowy || p.miasto
  const punktBezZmian = stary.punktOdbioru && stary.punktOdbioru.kod === p.punkt
  const kraj = stary.dostawa?.kraj ?? 'PL'
  return {
    ...stary,
    nabywca: stary.nabywca ?? { imieNazwisko: p.imieNazwisko, firma: p.firma },
    dostawa: adres
      ? { imieNazwisko: p.imieNazwisko, firma: p.firma, ulica: p.ulica, numerDomu: p.numerDomu, numerLokalu: p.numerLokalu, kodPocztowy: p.kodPocztowy, miasto: p.miasto, kraj }
      : { imieNazwisko: p.imieNazwisko, firma: p.firma, ulica: null, numerDomu: null, numerLokalu: null, kodPocztowy: null, miasto: null, kraj },
    punktOdbioru: p.punkt ? (punktBezZmian ? stary.punktOdbioru : { kod: p.punkt, nazwa: null }) : null,
    telefon: p.telefon,
    // problemy kanału o adresie i punkcie po poprawce człowieka nie obowiązują
    problemy: stary.problemy.filter((k) => !/^(adres_bez_podzialu|punkt_nieznany|brak_(imie_nazwisko|ulica|kod_pocztowy|miasto|telefon))$/.test(k)),
  }
}

/** Dane klienta zamówienia usunięte (retencja, RODO), odczyt w transakcji wywołującego; sam znacznik, bez treści. */
export async function daneUsuniete(tx: Prisma.TransactionClient, orderId: string): Promise<boolean> {
  const k = await tx.orderCustomer.findUnique({ where: { orderId }, select: { purgedAt: true } })
  return !!k?.purgedAt
}

export type WynikPoprawki = { wynik: 'ZAPISANO'; pola: string[] } | { wynik: 'BEZ_ZMIAN' } | { wynik: 'ODMOWA'; powod: string }

/**
 * Poprawka dostawy zamówienia `orderId` przez osobę `actorId` (User.id z sesji). Uprawnienie sprawdza `daneKlienta`
 * (cel POPRAWKA, zakres PELNY wymaga `klienci.dane`). Zamówienie bez rekordu: poprawka zaczyna od pustego (zamówienie
 * ręczne albo kanał bez danych). Rekord usunięty (retencja, RODO) = odmowa.
 */
export async function poprawDostawe(db: PrismaClient, orderId: string, p: PoprawkaDostawy, o: { actorId: string; env?: Env; now?: Date; /** punkt wybrany z wyszukiwarki punktów */ zrodloPunktu?: 'FORMULARZ' | 'WYSZUKIWARKA'; /** Dodatkowy zapis w tej samej transakcji, pod blokadą przesyłki (zmiana sposobu wysyłki); BladPoprawki = odmowa, nic nie zapisane. */ wTransakcji?: (tx: Prisma.TransactionClient) => Promise<void> }): Promise<WynikPoprawki> {
  const env = o.env ?? process.env
  const d = await daneKlienta(db, orderId, { actorId: o.actorId, zakres: 'PELNY', cel: 'POPRAWKA', env })
  if (d.stan === 'BEZ_UPRAWNIEN' || d.stan === 'SKROT') return { wynik: 'ODMOWA', powod: 'Poprawka adresu wymaga uprawnienia do pełnych danych klientów.' }
  if (d.stan === 'USUNIETE') return { wynik: 'ODMOWA', powod: 'Dane klienta tego zamówienia zostały usunięte.' }
  if (d.stan === 'BRAK_KLUCZA' || d.stan === 'BLAD_SZYFRU') return { wynik: 'ODMOWA', powod: 'Dane klienta niedostępne: brak klucza szyfrowania' }
  const stary = d.stan === 'PELNY' ? d.rekord : PUSTY_REKORD
  const pola = zmienionePola(stary, p)
  if (!pola.length) return { wynik: 'BEZ_ZMIAN' }
  // zapis pod blokadą przesyłki zamówienia, z ponownym sprawdzeniem, że przesyłka nie powstała w międzyczasie
  const przesylka = async (tx: Prisma.TransactionClient) => {
    if (await przesylkaPodBlokada(tx, orderId)) throw new BladPoprawki(PRZESYLKA_JEST)
    if (o.wTransakcji) await o.wTransakcji(tx)
  }
  let w: Awaited<ReturnType<typeof zapiszRekordKlienta>>
  try {
    w = await zapiszRekordKlienta(db, orderId, rekordPoPoprawce(stary, p), { source: 'RECZNE', fetchedAt: o.now ?? new Date(), env, nadpiszReczne: true, wTransakcji: przesylka })
  } catch (e) {
    if (e instanceof BladPoprawki) return { wynik: 'ODMOWA', powod: e.message }
    throw e
  }
  if (w === 'BEZ_ZMIAN_USUNIETE') return { wynik: 'ODMOWA', powod: 'Dane klienta tego zamówienia zostały usunięte.' }
  await db.auditLog.create({ data: { entity: PODGLAD_AUDIT, entityId: orderId, actorId: o.actorId, after: { cel: 'POPRAWKA', zakres: 'PELNY', wynik: 'ZAPISANO', pola: pola.join(',') } } })
  await sladZapisu(db, orderId, o.actorId, { wynik: w, zrodlo: 'FORMULARZ' })
  // zmiana punktu odbioru w historii zamówienia (kto i kiedy); kody punktu zostają w danych klienta
  // (szyfrowane, z retencją), bo historia zamówienia nie niesie danych dostawy
  if (pola.includes('punkt'))
    await db.orderEvent.create({ data: { orderId, kind: 'PUNKT_ODBIORU_ZMIENIONY', actorId: o.actorId.startsWith('user:') ? o.actorId : `user:${o.actorId}`, data: { zrodlo: o.zrodloPunktu ?? 'FORMULARZ', usuniety: !p.punkt } } })
  return { wynik: 'ZAPISANO', pola }
}

/**
 * Obecne wartości do formularza poprawki (otwarcie formularza = podgląd z celem POPRAWKA w dzienniku). Tylko pola
 * dostawy, telefon i punkt; null = brak uprawnienia albo danych niedostępnych (formularz pusty).
 */
export async function daneDoPoprawki(db: PrismaClient, orderId: string, o: { actorId: string; env?: Env }): Promise<PoprawkaDostawy | null> {
  const d = await daneKlienta(db, orderId, { actorId: o.actorId, zakres: 'PELNY', cel: 'POPRAWKA', env: o.env ?? process.env })
  if (d.stan !== 'PELNY') return null
  const k = d.rekord
  return {
    // odbiorca z dostawy; nabywca tylko, gdy dostawy nie ma
    imieNazwisko: (k.dostawa ? k.dostawa.imieNazwisko : k.nabywca?.imieNazwisko) ?? null,
    firma: (k.dostawa ? k.dostawa.firma : k.nabywca?.firma) ?? null,
    ulica: k.dostawa?.ulica ?? null,
    numerDomu: k.dostawa?.numerDomu ?? null,
    numerLokalu: k.dostawa?.numerLokalu ?? null,
    kodPocztowy: k.dostawa?.kodPocztowy ?? null,
    miasto: k.dostawa?.miasto ?? null,
    telefon: k.telefon,
    punkt: k.punktOdbioru?.kod ?? null,
  }
}
