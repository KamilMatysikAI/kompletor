// Wejścia przesyłki i faktury z danych klienta w bazie (punkt 7). Kolejność:
//  1. `daneKlienta(..., cel: PRZESYLKA | FAKTURA)` jako automat `system:<moduł>` (ślad KLIENT_PODGLAD);
//  2. brak wiersza: zapis instancji włączony → odczyt z kanału z zapisem (`zapiszZKanalu`, powód ZAPIS) i ponownie 1;
//     wyłączony albo brak klucza szyfru → dotychczasowy odczyt na żądanie (`pobierzOdbiorce`), tylko w pamięci;
//  3. dane usunięte (retencja, RODO art. 17) → brak, bez ponownego czytania kanału.
// Minimalizacja (`przytnijDoPowodu`): przesyłka bez danych do faktury, faktura bez punktu odbioru, telefonu
// i e-maila. Wynik żyje w pamięci wywołującego: nie zapisuj go w innej tabeli, Job.payload, logu ani alercie.
import type { PrismaClient } from '@prisma/client'
import type { OrderRecipient } from '../adaptery/kontrakt'
import type { AdapterRegistry } from '../adaptery/rejestr'
import type { NabywcaFa3 } from '../ksef/fa3/typy'
import { pobierzOdbiorce, przytnijDoPowodu } from '../odbiorca/pobierz'
import { naKontrahenta, naOdbiorcePrzesylki, type Przejscie } from '../odbiorca/przejscia'
import type { SecretSource } from '../sekrety'
import type { WejscieFaktury } from '../wfirma/faktura'
import type { OdbiorcaPrzesylki } from '../wysylka/zlecenie'
import type { FetchLike } from '../zrodla/http'
import { zapisKlientaWlaczony } from './kolejka'
import { daneKlienta } from './odczyt'
import { odbiorcaZRekordu } from './rekord'
import { zapiszZKanalu } from './zapis'

export type ZrodloWejscia = 'BAZA' | 'KANAL' | 'BRAK'

export interface WejscieDeps {
  /** Moduł automatu: do `actorId` = `system:<moduł>` (np. wysylka, faktury, ksef). */
  modul: string
  /**
   * Osoba z sesji (User.id), gdy dane czyta człowiek, a nie automat (np. pobranie szkicu korekty KSeF): odczyt wg jej
   * uprawnień (`klienci.dane`) i ślad KLIENT_PODGLAD na nią. Puste = automat `system:<moduł>`.
   */
  actorId?: string
  /** Bez rejestru i sekretów = tylko baza (bez fallbacku na kanał). */
  registry?: AdapterRegistry
  secrets?: SecretSource
  fetch?: FetchLike
  now?: () => Date
  env?: Record<string, string | undefined>
}

type Cel = 'PRZESYLKA' | 'FAKTURA'

/** Odbiorca z bazy albo z kanału, przycięty do celu. */
export async function odbiorcaDoCelu(db: PrismaClient, orderId: string, cel: Cel, deps: WejscieDeps): Promise<{ zrodlo: ZrodloWejscia; odbiorca: OrderRecipient | null }> {
  const actorId = deps.actorId ?? `system:${deps.modul}`
  const env = deps.env ?? deps.secrets?.env ?? process.env
  const zBazy = async () => {
    const d = await daneKlienta(db, orderId, { actorId, zakres: 'PELNY', cel, env })
    return d
  }
  let d = await zBazy()
  if (d.stan === 'PELNY') return { zrodlo: 'BAZA', odbiorca: przytnijDoPowodu(odbiorcaZRekordu(d.rekord), cel) }
  if (d.stan === 'USUNIETE' || d.stan === 'BEZ_UPRAWNIEN' || d.stan === 'BLAD_SZYFRU' || !deps.registry || !deps.secrets) return { zrodlo: 'BRAK', odbiorca: null }
  if (d.stan === 'BRAK' && zapisKlientaWlaczony(env)) {
    const z = await zapiszZKanalu(db, orderId, { registry: deps.registry, secrets: deps.secrets, actorId, fetch: deps.fetch, now: deps.now })
    if (z.wynik === 'BRAK_ZRODLA') return { zrodlo: 'BRAK', odbiorca: null }
    d = await zBazy()
    if (d.stan === 'PELNY') return { zrodlo: 'KANAL', odbiorca: przytnijDoPowodu(odbiorcaZRekordu(d.rekord), cel) }
    return { zrodlo: 'BRAK', odbiorca: null }
  }
  // brak klucza szyfru albo zapis wyłączony: odczyt na żądanie, tylko w pamięci (przycięty przez pobierzOdbiorce)
  const r = await pobierzOdbiorce(db, orderId, { registry: deps.registry, secrets: deps.secrets, actorId, powod: cel, fetch: deps.fetch, now: deps.now })
  return r.zrodlo === 'KANAL' ? { zrodlo: 'KANAL', odbiorca: r.odbiorca } : { zrodlo: 'BRAK', odbiorca: null }
}

/** Wejście `shipment.create` (`ShipmentCreateRequest.recipient`) i przejście na zlecenie Base Courier. */
export async function odbiorcaPrzesylki(
  db: PrismaClient,
  orderId: string,
  deps: WejscieDeps,
): Promise<{ zrodlo: ZrodloWejscia; recipient: NonNullable<OrderRecipient['dostawa']> | null; punktOdbioru: OrderRecipient['punktOdbioru']; przejscie: Przejscie<OdbiorcaPrzesylki> }> {
  const r = await odbiorcaDoCelu(db, orderId, 'PRZESYLKA', deps)
  if (!r.odbiorca) return { zrodlo: r.zrodlo, recipient: null, punktOdbioru: null, przejscie: { ok: false, braki: ['dostawa'] } }
  // punkt odbioru (paczkomat, salon Empik, punkt DPD) z tego samego odczytu — trafia do `parcel.pickupPoint`
  return { zrodlo: r.zrodlo, recipient: r.odbiorca.dostawa, punktOdbioru: r.odbiorca.punktOdbioru, przejscie: naOdbiorcePrzesylki(r.odbiorca) }
}

/** Kontrahent faktury wFirma (`WejscieFaktury.kontrahent`). */
export async function kontrahentFaktury(
  db: PrismaClient,
  orderId: string,
  deps: WejscieDeps,
): Promise<{ zrodlo: ZrodloWejscia; przejscie: Przejscie<NonNullable<WejscieFaktury['kontrahent']>> }> {
  const r = await odbiorcaDoCelu(db, orderId, 'FAKTURA', deps)
  if (!r.odbiorca) return { zrodlo: r.zrodlo, przejscie: { ok: false, braki: ['faktura'] } }
  return { zrodlo: r.zrodlo, przejscie: naKontrahenta(r.odbiorca) }
}

/**
 * Nabywca FA(3) z danych do faktury w bazie (NIP, nazwa, adres); null = brak danych do faktury (szkic zostaje przy
 * nabywcy zastępczym). Tylko baza: szkic KSeF nie czyta kanału. `actorId` = osoba z sesji (odczyt wg jej uprawnień,
 * ślad na nią); bez niego automat `system:ksef` (wysyłka z workera, składanie szkicu).
 */
export async function nabywcaKsef(db: PrismaClient, orderId: string, env?: Record<string, string | undefined>, actorId?: string): Promise<NabywcaFa3 | null> {
  const r = await odbiorcaDoCelu(db, orderId, 'FAKTURA', { modul: 'ksef', env, actorId })
  const f = r.odbiorca?.faktura
  if (!f?.nazwa) return null
  const linia2 = [f.kodPocztowy, f.miasto].filter(Boolean).join(' ')
  return {
    nip: f.nip ? f.nip.replace(/\D/g, '') : null,
    nazwa: f.nazwa,
    adres: f.ulica || linia2 ? { kodKraju: (f.kraj ?? 'PL').toUpperCase(), linia1: f.ulica ?? linia2, ...(f.ulica && linia2 ? { linia2 } : {}) } : null,
  }
}

// ───: kontakt do maila z planu akcji ──────────────────────────────

export type KontaktDoMaila =
  | { stan: 'OK'; email: string; imie: string | null }
  /** Danych nie ma (jeszcze): zapis po przyjęciu zamówienia może przyjść później, więc wysyłka czeka. */
  | { stan: 'BRAK'; powod: string }
  /** Danych nie będzie: usunięte (retencja, RODO), brak e-maila w danych klienta albo odmowa. */
  | { stan: 'NIGDY'; powod: string }

/**
 * Adres e-mail i imię klienta do maila (automat `system:poczta`, cel MAIL, ślad KLIENT_PODGLAD). Tylko z bazy, bez
 * odczytu kanału: mail nie jest powodem, żeby pytać sklep o dane. Wynik żyje w pamięci wysyłki: adres nie trafia do
 * MailDelivery (tam tylko maska), logu ani alertu. Imię = pierwszy wyraz imienia i nazwiska, nigdy nazwa firmy.
 */
export async function kontaktDoMaila(db: PrismaClient, orderId: string, deps: { env?: Record<string, string | undefined> } = {}): Promise<KontaktDoMaila> {
  // paczka dodatkowa (podzamówienie „dośle”) nie ma własnych danych klienta — adresat
  // z zamówienia głównego, jak nabywca faktury w adapterze zapisu wFirmy
  const o = await db.order.findUnique({ where: { id: orderId }, select: { parentOrderId: true } })
  const d = await daneKlienta(db, o?.parentOrderId ?? orderId, { actorId: 'system:poczta', zakres: 'PELNY', cel: 'MAIL', env: deps.env ?? process.env })
  switch (d.stan) {
    case 'PELNY': {
      const email = d.rekord.email?.trim() ?? ''
      if (!email) return { stan: 'NIGDY', powod: 'brak adresu e-mail w danych klienta' }
      const pierwszy = d.rekord.nabywca?.imieNazwisko?.trim().split(/\s+/)[0] ?? ''
      return { stan: 'OK', email, imie: pierwszy && pierwszy.length <= 40 ? pierwszy : null }
    }
    case 'BRAK':
      return { stan: 'BRAK', powod: 'dane klienta jeszcze niezapisane' }
    case 'BRAK_KLUCZA':
      return { stan: 'BRAK', powod: 'brak klucza szyfrowania danych klientów na tej instancji' }
    case 'USUNIETE':
      return { stan: 'NIGDY', powod: 'dane klienta usunięte (retencja)' }
    case 'BLAD_SZYFRU':
      return { stan: 'NIGDY', powod: 'nie udało się odszyfrować danych klienta' }
    default:
      return { stan: 'NIGDY', powod: 'brak dostępu do danych klienta' }
  }
}
