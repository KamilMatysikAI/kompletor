// Zmiana płatności zamówienia z karty (sekcja „Płatność”): „Zmień na pobranie” dla nieopłaconego i „Zmień na
// nieopłacone (przelew)” dla zamówienia za pobraniem. Tylko w Kompletorze: w sklepie płatność zostaje bez zmian,
// a kolejny odczyt kanału zmiany nie cofa (znacznik `platnoscZKarty`, lib/rdzen/zamowienia.ts). Przy pobraniu fakturę
// (forma płatności) i kwotę pobrania w przesyłce liczy stan płatności zamówienia, więc obie idą za zmianą.
// Każdy zapis: bramka trybu PRACA, blokada przesyłki i zamówienia, warunki sprawdzone od nowa pod blokadą, zdarzenie
// w historii i dziennik zmian. Przycisk nie znika: gdy zmiana nie pasuje do zamówienia, jest nieaktywny z powodem.
import type { Carrier, Channel, Order, OrderStatus, PaymentState, PrismaClient, ShippingModule } from '@prisma/client'
import { CARRIER_LABEL } from '@/lib/panel/format'
import { kluczBlokadyPrzesylki, PRZESYLKA_AKTYWNA } from '@/lib/rdzen/brakuje'
import { dokumentSprzedazy } from '@/lib/rdzen/dokument-sprzedazy'
import { lockOrder } from '@/lib/rdzen/przejscia'
import { NAZWA_MODULU } from '@/lib/rdzen/przewoznicy'
import { flagsOf, mergeFlags } from '@/lib/rdzen/rezerwacja'
import { advisoryLock, runTx, type Tx } from '@/lib/rdzen/stan'
import { cofnijPobraniePodBlokada, platnoscPodBlokada, ZDARZENIE_NA_POBRANIE } from '@/lib/rdzen/zamowienia'
import { obslugujePobranie } from '@/lib/wysylka/zmiana-sposobu'
import { bramkaKarty } from './bramka'
import { AUDIT_PLATNOSC } from './platnosci'
import { BEZ_UPRAWNIENIA, type WynikKarty } from './pozycje'

type Db = PrismaClient
type Env = Record<string, string | undefined>

export type KierunekZmiany = 'NA_POBRANIE' | 'NA_NIEOPLACONE'

export const POWODY_ZMIANY_PLATNOSCI = {
  anulowane: 'Zamówienie anulowane: najpierw je przywróć.',
  oplacone: 'Zamówienie jest opłacone: pobrania nie ustawisz (klient już zapłacił).',
  czesciowo: 'Zamówienie częściowo opłacone: Kompletor nie policzy pobrania samej reszty. Ustal z klientem, co z wpłatą, i zapisz ją w sekcji „Płatność”.',
  kanal: 'Płatność zamówień z Allegro i Empiku prowadzi kanał: zmień ją tam.',
  wysylamZAllegro: 'Przesyłka idzie przez „Wysyłam z Allegro”: płatność prowadzi Allegro.',
  osobisty: 'Odbiór osobisty: pobranie dotyczy przesyłki. Przy odbiorze osobistym zapisz wpłatę albo oznacz zamówienie jako opłacone.',
  bezPrzewoznika: 'Zamówienie nie ma przewoźnika paczki: najpierw ustal sposób wysyłki (sekcja „Przesyłka”).',
  etapNaPobranie: 'Zamówienie jest już w realizacji: płatność zmienisz tylko przed zbieraniem.',
  etapNaNieoplacone: 'Zamówienie jest już zbierane albo dalej: płatność zmienisz tylko przed zbieraniem.',
  paczki: 'Zamówienie podzielone na paczki: płatności rodziny paczek z karty nie zmienisz.',
  przesylka: 'Przesyłka jest już utworzona: najpierw ją anuluj (sekcja „Przesyłka”), potem zmień płatność.',
  dokument: 'Dokument sprzedaży (faktura wFirma, KSeF albo BaseLinker) jest już wystawiony albo przygotowany: zmień płatność korektą w programie, w którym dokument powstał.',
  wplaty: 'Zamówienie ma zapisane wpłaty: pobranie całej kwoty nie zgadzałoby się z nimi. Najpierw ustal z klientem rozliczenie.',
  statusWSklepie: 'Sklep dostał już z Kompletora status realizacji tego zamówienia i przy kolejnym odczycie podałby je jako opłacone. Pobrania nie cofniesz z karty: zmień płatność w sklepie.',
} as const

const POWOD_SPOSOBU = (c: Carrier, m: ShippingModule | null) => {
  const modul = m && m !== 'BRAK' ? NAZWA_MODULU[m] : null
  const nazwa = modul && modul !== CARRIER_LABEL[c] ? `${CARRIER_LABEL[c]} (${modul})` : CARRIER_LABEL[c]
  return `„${nazwa}” nie obsługuje pobrania: najpierw zmień sposób wysyłki w sekcji „Przesyłka”.`
}

type ZamowienieDoZmiany = Pick<Order, 'id' | 'channel' | 'status' | 'statusBeforeClarify' | 'paymentState' | 'carrier' | 'shippingModule' | 'parentOrderId' | 'packageNo' | 'flags'>

/** Kierunek zmiany pasujący do stanu płatności: pobranie → nieopłacone, każda inna płatność → pobranie (z powodem). */
export function kierunekZmiany(p: PaymentState): KierunekZmiany {
  return p === 'COD' ? 'NA_NIEOPLACONE' : 'NA_POBRANIE'
}

/** Powód odmowy z samych pól zamówienia (czysta funkcja); null = pola pozwalają. */
export function powodZPol(o: Omit<ZamowienieDoZmiany, 'id' | 'packageNo' | 'flags'> & { channel: Channel }, kierunek: KierunekZmiany): string | null {
  const P = POWODY_ZMIANY_PLATNOSCI
  if (o.status === 'ANULOWANE') return P.anulowane
  if (kierunek === 'NA_POBRANIE') {
    if (o.paymentState === 'PAID') return P.oplacone
    if (o.paymentState === 'PARTIAL') return P.czesciowo
    if (o.paymentState !== 'UNPAID') return null // pobranie: tę zmianę przycisk pokazuje w drugą stronę
  } else if (o.paymentState !== 'COD') return null
  if (o.channel === 'ALLEGRO' || o.channel === 'EMPIK') return P.kanal
  if (o.shippingModule === 'WYSYLAM_Z_ALLEGRO' || o.carrier === 'ALLEGRO') return P.wysylamZAllegro
  if (o.carrier === 'OSOBISTY') return kierunek === 'NA_POBRANIE' ? P.osobisty : null
  if (!o.carrier || o.carrier === 'BRAK' || o.carrier === 'BEZ_WYSYLKI') return kierunek === 'NA_POBRANIE' ? P.bezPrzewoznika : null
  if (kierunek === 'NA_POBRANIE' && !obslugujePobranie(o.carrier, o.shippingModule ?? 'BRAK')) return POWOD_SPOSOBU(o.carrier, o.shippingModule)
  const etap: OrderStatus = o.status === 'DO_WYJASNIENIA' ? (o.statusBeforeClarify ?? 'NOWE') : o.status
  if (kierunek === 'NA_POBRANIE' && etap !== 'NOWE') return P.etapNaPobranie
  if (kierunek === 'NA_NIEOPLACONE' && etap !== 'DO_REALIZACJI') return P.etapNaNieoplacone
  if (o.parentOrderId) return P.paczki
  return null
}

/** Pełny powód odmowy (pola, paczki, przesyłka, dokument, wpłaty); null = zmiana przejdzie. `podBlokada` = po `lockOrder`. */
export async function powodZmianyPlatnosci(db: Db | Tx, o: ZamowienieDoZmiany, kierunek: KierunekZmiany, opt: { podBlokada?: boolean } = {}): Promise<string | null> {
  const P = POWODY_ZMIANY_PLATNOSCI
  const z = powodZPol(o, kierunek)
  if (z) return z
  const [paczki, przesylki, szkiceKsef, wplaty, statusWSklepie] = await Promise.all([
    db.order.count({ where: { parentOrderId: o.id } }),
    db.shipment.count({
      where: { orderId: o.id, state: { in: [...PRZESYLKA_AKTYWNA] } },
    }),
    db.ksefInvoiceDraft.count({ where: { orderId: o.id } }),
    kierunek === 'NA_POBRANIE' ? db.orderPayment.count({ where: { orderId: o.id } }) : Promise.resolve(0),
    // pobranie ustawione na karcie (sklep dalej ma przelew): status realizacji wysłany do sklepu (Woo „processing”
    // ustawia datę płatności) dałby po cofnięciu fałszywą wpłatę przy kolejnym odczycie. Wiersz pominięty nic nie wysłał.
    kierunek === 'NA_NIEOPLACONE' && flagsOf(o).platnoscZKarty === 'COD'
      ? db.channelWrite.count({
          where: {
            orderId: o.id,
            kind: 'STATUS',
            mode: 'PRACA',
            state: { in: ['WYSYLANIE', 'WYSLANE', 'NIEJEDNOZNACZNY'] },
            OR: [{ result: null }, { NOT: { result: { startsWith: 'pominięte' } } }],
          },
        })
      : Promise.resolve(0),
  ])
  if (paczki > 0) return P.paczki
  if (przesylki > 0) return P.przesylka
  // szkic KSeF trzyma znacznik pobrania z chwili przygotowania, więc blokuje każdy, nie tylko wysłany
  if (szkiceKsef > 0 || (await dokumentSprzedazy(db as Db, [o.id], opt)) !== null) return P.dokument
  if (wplaty > 0) return P.wplaty
  if (statusWSklepie > 0) return P.statusWSklepie
  return null
}

export interface ZlecenieZmianyPlatnosci {
  orderId: unknown
  kierunek: KierunekZmiany
  userId: string
  uprawnienia: ReadonlySet<string>
}

const wczytaj = (db: Db) => (id: string) =>
  db.order.findUnique({
    where: { id },
    select: { id: true, channel: true, channelAccountId: true },
  })

/**
 * „Zmień na pobranie” albo „Zmień na nieopłacone”. Uprawnienie jak „Oznacz jako opłacone”. Kolejność blokad jak przy
 * zmianie pozycji: najpierw przesyłki (wyklucza się z „Utwórz przesyłkę”), potem zamówienia; warunki od nowa pod nimi.
 * Powtórka (podwójne kliknięcie) po udanej zmianie nic nie robi.
 */
export async function zmienPlatnosc(db: Db, z: ZlecenieZmianyPlatnosci, env: Env = process.env, now = new Date()): Promise<WynikKarty> {
  if (!z.uprawnienia.has('zamowienia.oznacz_oplacone')) return { blad: BEZ_UPRAWNIENIA, zmiana: false }
  const b = await bramkaKarty(db, z.orderId, wczytaj(db), env)
  if (!b.ok) return { blad: b.blad, zmiana: false }
  const actorId = `user:${z.userId}`
  return runTx(db, async (tx) => {
    await advisoryLock(tx, kluczBlokadyPrzesylki(b.o.id))
    const o = await lockOrder(tx, b.o.id)
    const juz = z.kierunek === 'NA_POBRANIE' ? o.paymentState === 'COD' : o.paymentState === 'UNPAID'
    if (juz) return { blad: null, zmiana: false } // podwójne kliknięcie
    const powod = await powodZmianyPlatnosci(tx, o, z.kierunek, {
      podBlokada: true,
    })
    if (powod) return { blad: powod, zmiana: false }
    const przed = { platnosc: o.paymentState, status: o.status }
    let status: OrderStatus
    if (z.kierunek === 'NA_POBRANIE') {
      status = await platnoscPodBlokada(tx, o.id, 'COD', {
        actorId,
        now,
        zdarzenie: ZDARZENIE_NA_POBRANIE,
      })
      const fresh = await tx.order.findUniqueOrThrow({
        where: { id: o.id },
        select: { flags: true },
      })
      await tx.order.update({
        where: { id: o.id },
        data: { flags: mergeFlags(fresh, { platnoscZKarty: 'COD' }) },
      })
    } else {
      status = await cofnijPobraniePodBlokada(tx, o, { actorId, now })
    }
    const po = await tx.order.findUniqueOrThrow({
      where: { id: o.id },
      select: {
        paymentState: true,
        totalGross: true,
        remindAt: true,
        reservationDeadline: true,
      },
    })
    await tx.auditLog.create({
      data: {
        entity: AUDIT_PLATNOSC,
        entityId: o.id,
        actorId,
        before: { platnosc: przed.platnosc, status: przed.status },
        after: {
          platnosc: po.paymentState,
          status,
          kwota: po.totalGross.toFixed(2),
          zmiana: z.kierunek === 'NA_POBRANIE' ? 'na pobranie' : 'pobranie na nieopłacone',
        },
      },
    })
    return { blad: null, zmiana: true }
  })
}

/** Stan przycisku zmiany płatności dla karty (kierunek i powód nieaktywności z danych zamówienia; tryb i uprawnienie osobno). */
export async function stanZmianyPlatnosci(db: Db, o: ZamowienieDoZmiany): Promise<{ kierunek: KierunekZmiany; powod: string | null }> {
  const kierunek = kierunekZmiany(o.paymentState)
  return { kierunek, powod: await powodZmianyPlatnosci(db, o, kierunek) }
}
