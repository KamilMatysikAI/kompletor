// Podgląd przesyłki zamówienia (także Wysyłam z Allegro): liczy parametry i zapisuje je w PreparedShipment.
// Bez sieci i bez klucza (działa, zanim dojdzie autoryzacja przesyłek Allegro), bez instancji adaptera, bez
// zmian w zamówieniu, rezerwacjach i stanie. Nic nie zostaje nadane. Klient bazy firmy z sesji (RLS). Danych odbiorcy tu
// nie ma: Order ich nie trzyma, a wiersz zawiera tylko parametry przesyłki. Wyjątek: gdy moduł wymaga punktu
// odbioru, kod punktu przychodzi z zapisanych danych klienta (`punktOdbioruZBazy`) i żyje tylko w pamięci liczenia.
import { Prisma, type Carrier, type OrderStatus, type PrismaClient } from '@prisma/client'
import { ALLEGRO_WYSYLAM_KEY, DEFAULT_SHIPPING_ADAPTER } from '@/lib/adaptery'
import type { PowodNiepewnejKwoty, PreparedParcel, ShipmentProblem } from '@/lib/adaptery/kontrakt'
import { organizationIdOf } from '@/lib/db'
import { punktOdbioruZBazy } from '@/lib/klienci/wejscia'
import { GABARYTY, gabarytyDla, isGabaryt, ocenaGabarytu, type Gabaryt } from '@/lib/stanowisko/gabaryty'
import { wczytajZamowienia, type ZamowienieStanowiska } from '@/lib/stanowisko/zamowienia'
import { czyPowodInnegoModulu, POWOD_REGULY_ZMIENIONE, regulaDlaZamowienia } from '@/lib/rdzen/przewoznicy'
import { LICZENIE_PRZESYLKI, maLiczeniePrzesylki, type KluczPrzesylki } from './moduly'
import { kwotyPobraniaRodziny } from './pobranie-paczek'
import { POWOD_KWOTY, wagaZeSkladu } from './przesylka'
import { konfiguracjaZKontem } from './ustawienia-konta'

type Db = PrismaClient

/** Błąd akcji z komunikatem dla użytkownika panelu. */
export class BladPrzesylki extends Error {}

/** podgląd bez danych klienta w bazie nie wie, czy punkt jest; nadanie czyta go z danych klienta. */
export const PUNKT_PRZY_NADANIU = 'Punkt odbioru zostanie sprawdzony przy tworzeniu przesyłki (dane klienta nie są jeszcze zapisane w Kompletorze).'
/** dane klienta są, ale podgląd ich nie przeczyta; tekst mówi prawdę, bez żadnych danych klienta. */
export const PUNKT_DANE_USUNIETE = 'Punkt odbioru zostanie sprawdzony przy tworzeniu przesyłki (dane klienta usunięto po okresie przechowywania).'
export const PUNKT_DANE_NIEODCZYTANE = 'Punkt odbioru zostanie sprawdzony przy tworzeniu przesyłki (danych klienta nie udało się teraz odczytać).'
const TEKST_PUNKTU = { BRAK: PUNKT_PRZY_NADANIU, USUNIETE: PUNKT_DANE_USUNIETE, NIEODCZYTANE: PUNKT_DANE_NIEODCZYTANE } as const
const jestBrakPunktu = (p: ShipmentProblem) => p.kod === 'punkt' && p.poziom === 'BLAD'

export type WynikPrzygotowania = { wynik: 'przygotowane'; orderId: string; packageNo: number; parcel: PreparedParcel } | { wynik: 'nie_dotyczy'; powod: string }

// Przy pakowaniu braki zmniejszają pobranie (lib/rdzen/rozchod.ts), więc przy nich totalGross nie jest kwotą do pobrania.
const BRAKI_ZMIENIAJACE_KWOTE = ['OPEN', 'SHIP_LATER', 'REFUND_PENDING', 'COD_REDUCED'] as const

interface DaneOceny {
  status: OrderStatus
  carrier: Carrier | null
  tylkoBezStanu: boolean
  liczbaPozycji: number
}

/** Dlaczego zamówienie nie ma przesyłki; null = dotyczy. */
export function powodNieDotyczy(z: DaneOceny): string | null {
  if (z.status === 'ANULOWANE') return 'Zamówienie anulowane.'
  if (z.carrier === 'BEZ_WYSYLKI' || z.tylkoBezStanu) return 'Zamówienie bez wysyłki (sama usługa, np. e-book).'
  if (z.carrier === 'OSOBISTY') return 'Odbiór osobisty: przesyłka nie powstaje.'
  if (!z.carrier || z.carrier === 'BRAK') return 'Przewoźnik nieustalony: najpierw wyjaśnij metodę dostawy.'
  if (z.liczbaPozycji === 0) return 'Zamówienie nie ma pozycji do wysłania.'
  return null
}

/**
 * „Dośle później” i odrzucenie przy akceptacji nie zmieniają totalGross (lib/rdzen/brakuje.ts), a brak idzie w CANCELLED.
 * zamówienie w kilku paczkach z kwotą paczki wyliczoną z pozycji (`kwotyPobraniaRodziny`) nie jest już
 * niepewne z powodu podziału; przeniesione sztuki są wtedy rozliczone w paczkach, więc nie liczą się jako odrzucone.
 */
function powodKwoty(podzielone: boolean, kwotaPaczki: boolean, odrzucone: boolean, braki: string[]): PowodNiepewnejKwoty | null {
  if (podzielone && !kwotaPaczki) return 'PODZIAL'
  if (odrzucone && !kwotaPaczki) return 'ODRZUCONE'
  if (braki.some((s) => s === 'OPEN' || s === 'SHIP_LATER')) return 'BRAKI'
  return braki.length > 0 ? 'BRAKI_SPAKOWANE' : null
}

const daneOceny = (z: ZamowienieStanowiska): DaneOceny => ({ status: z.status, carrier: z.carrier, tylkoBezStanu: z.tylkoBezStanu, liczbaPozycji: z.pozycje.length })

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/**
 * Powód „nie dotyczy”, gdy reguła nie ma modułu liczącego przesyłkę: moduł spoza listy liczenia jest
 * nazwany kluczem, a brak modułu nie podsuwa Base Courier firmie, która go nie ma i nie chce.
 */
function powodBezModulu(carrier: Carrier | null, adapterKey: string | null): string {
  if (adapterKey) return `Moduł wysyłki „${adapterKey}” nie liczy jeszcze przesyłek dla tego przewoźnika.`
  if (carrier === 'ALLEGRO') return 'Firma nie ma modułu Wysyłam z Allegro dla tego przewoźnika.'
  return 'Firma nie ma modułu wysyłki dla tego przewoźnika: ustaw moduł w regule przewoźnika.'
}

export type RegulaPrzesylki = { adapterKey: KluczPrzesylki; config: Record<string, unknown>; powod: null } | { powod: string }

/**
 * Reguła, która pasuje do metody dostawy zamówienia (to samo dopasowanie co przy przyjęciu); adapter z reguły albo
 * domyślny dla modułu. Inny przewoźnik w regule niż w zamówieniu = reguły zmieniły się od przyjęcia: bez zgadywania.
 * Adapter bez wpisu w LICZENIE_PRZESYLKI (lib/wysylka/moduly.ts) = podgląd nie dotyczy.
 */
export async function regulaPrzesylki(db: Db, z: Pick<ZamowienieStanowiska, 'channel' | 'carrier' | 'metodaDostawy' | 'shippingModule' | 'przewoznikRecznie'>): Promise<RegulaPrzesylki> {
  const rules = await db.carrierRule.findMany({ orderBy: { priority: 'asc' }, select: { priority: true, channel: true, pattern: true, carrier: true, shippingModule: true, adapterKey: true, config: true } })
  // ten sam wybór reguły co nadanie (przewoźnik wybrany wprost, np. zamówienie ręczne, też dostaje regułę)
  const w = regulaDlaZamowienia(rules, z)
  if (w.powod === POWOD_REGULY_ZMIENIONE || czyPowodInnegoModulu(w.powod)) return { powod: w.powod! }
  const r = w.regula
  const adapterKey = r ? (r.adapterKey ?? DEFAULT_SHIPPING_ADAPTER[r.shippingModule]) : null
  if (!r || !maLiczeniePrzesylki(adapterKey)) return { powod: powodBezModulu(z.carrier, r ? adapterKey : null) }
  // Wysyłam z Allegro nada tylko zamówienie z Allegro (przesyłka idzie do formularza zakupu)
  if (adapterKey === ALLEGRO_WYSYLAM_KEY && z.channel !== 'ALLEGRO') return { powod: 'Wysyłam z Allegro działa tylko dla zamówień z Allegro: popraw regułę przewoźnika.' }
  // wymiary, waga i kod kuriera z ustawień konta przewoźnika (ekran Konta przewoźników), inaczej z reguły
  const org = await db.organization.findUnique({ where: { id: organizationIdOf(db) }, select: { settings: true } })
  return { adapterKey, config: konfiguracjaZKontem(org?.settings, adapterKey, asObject(r.config)), powod: null }
}

/**
 * Gabaryt z argumentu, inaczej z ostatniego ćwiczenia pakowania, inaczej podpowiedź (wymiary albo liczba rzeczy).
 * sztuka większa niż największa skrytka = brak podpowiedzi; liczymy na największym gabarycie
 * przewoźnika, ale z ostrzeżeniem w `zaDuze` (problem BLAD w podglądzie), nie po cichu „C”.
 */
async function wybierzGabaryt(db: Db, z: ZamowienieStanowiska, gabaryt: string | null | undefined): Promise<{ gabaryt: Gabaryt; zPodpowiedzi: boolean; zaDuze?: string }> {
  const dozwolone = gabarytyDla(z.carrier)
  if (gabaryt) {
    if (!isGabaryt(gabaryt) || !dozwolone.includes(gabaryt)) throw new BladPrzesylki(`Ten gabaryt nie pasuje do przewoźnika: ${z.przewoznik}.`)
    return { gabaryt, zPodpowiedzi: false }
  }
  const drill = await db.packDrill.findFirst({ where: { orderId: z.id, parcelSize: { not: null } }, orderBy: { startedAt: 'desc' }, select: { parcelSize: true } })
  if (isGabaryt(drill?.parcelSize) && dozwolone.includes(drill.parcelSize)) return { gabaryt: drill.parcelSize, zPodpowiedzi: false }
  const ocena = ocenaGabarytu(z.carrier, z.pozycje)
  if (ocena.gabaryt) return { gabaryt: ocena.gabaryt, zPodpowiedzi: true }
  return { gabaryt: dozwolone[dozwolone.length - 1]!, zPodpowiedzi: true, zaDuze: ocena.ostrzezenie ?? 'Produkt nie mieści się w największej skrytce.' }
}

/**
 * Przygotowuje przesyłkę zamówienia: nadpisuje wiersz PreparedShipment tego zamówienia i paczki (idempotentne).
 * „Nie dotyczy” usuwa wcześniejszy podgląd: zamówienie mogło zmienić przewoźnika, a stary wynik by kłamał.
 */
export async function prepareForOrder(db: Db, orderId: string, gabaryt?: string | null, opcje: { punktOdbioru?: string | null } = {}): Promise<WynikPrzygotowania> {
  const organizationId = organizationIdOf(db)
  const [z] = await wczytajZamowienia(db, [orderId])
  if (!z) throw new BladPrzesylki('Nie ma takiego zamówienia.')
  const o = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      paymentState: true,
      paymentMethod: true,
      totalGross: true,
      packageNo: true,
      parentOrderId: true,
      shortages: { where: { state: { in: [...BRAKI_ZMIENIAJACE_KWOTE] } }, select: { state: true } },
      lines: { where: { removed: false, qtyRejected: { gt: 0 } }, select: { id: true }, take: 1 },
    },
  })
  const klucz = { organizationId_orderId_packageNo: { organizationId, orderId, packageNo: o.packageNo } }
  const nieDotyczy = async (powod: string): Promise<WynikPrzygotowania> => {
    await db.preparedShipment.deleteMany({ where: { orderId, packageNo: o.packageNo } })
    return { wynik: 'nie_dotyczy', powod }
  }
  const powod = powodNieDotyczy(daneOceny(z))
  if (powod) return nieDotyczy(powod)
  const regula = await regulaPrzesylki(db, z)
  if (regula.powod !== null) return nieDotyczy(regula.powod)

  const wybrany = await wybierzGabaryt(db, z, gabaryt)
  const waga = wagaZeSkladu(z.pozycje)
  const podzielone = o.parentOrderId !== null || (await db.order.count({ where: { parentOrderId: orderId } })) > 0
  // runda 2 (wariant 2): pieniądze rodziny są na zamówieniu głównym (kwota paczki dodatkowej 0,
  // stan płatności skopiowany przy utworzeniu). Gdy stan głównego się zmieni (np. przywrócenie po anulowaniu z „opłacone”),
  // paczka dodatkowa ze starym „za pobraniem” pobrałaby za opłacony towar: liczy się stan zamówienia głównego.
  const platnosc = o.parentOrderId ? await db.order.findUniqueOrThrow({ where: { id: o.parentOrderId }, select: { paymentState: true, paymentMethod: true } }) : o
  // kwota pobrania paczki z jej pozycji; tylko przy pobraniu (inne zamówienia jej nie potrzebują)
  const paczki = podzielone && platnosc.paymentState !== 'PAID' ? await kwotyPobraniaRodziny(db, orderId) : null
  const kwotaPaczkiGr = paczki?.kwotyGr?.get(orderId) ?? null
  const licz = (pickupPoint: string | null) => LICZENIE_PRZESYLKI[regula.adapterKey](
    {
      carrier: z.carrier!,
      courierCode: regula.config['courierCode'],
      gabaryt: wybrany.gabaryt,
      weightG: waga.gramy > 0 ? waga.gramy : null,
      weightComplete: waga.pelna,
      paymentState: platnosc.paymentState,
      paymentMethod: platnosc.paymentMethod,
      totalGross: kwotaPaczkiGr !== null ? kwotaPaczkiGr / 100 : Number(o.totalGross),
      codAmountUncertain: powodKwoty(podzielone, kwotaPaczkiGr !== null, o.lines.length > 0, o.shortages.map((s) => s.state)),
      wielePaczek: podzielone,
      pickupPoint,
    },
    regula.config,
  )
  // Nadanie podaje punkt z danych klienta (`null` = punktu naprawdę nie ma). Podgląd bez punktu
  // dawał fałszywy BLAD „brak punktu”, choć rekord klienta miał kod (salon, paczkomat). Teraz, gdy moduł chce punktu,
  // podgląd bierze kod z zapisanych danych klienta (tylko baza, bez kanału); bez danych w bazie zamiast błędu jest
  // informacja, że punkt sprawdzi nadanie.
  let parcel = licz(opcje.punktOdbioru ?? null)
  if (opcje.punktOdbioru === undefined && parcel.problems.some(jestBrakPunktu)) {
    const punkt = await punktOdbioruZBazy(db, z.id)
    if (punkt.stan === 'JEST') parcel = licz(punkt.kod)
    else if (punkt.stan === 'NIEZNANY') parcel.problems = parcel.problems.map((p): ShipmentProblem => (jestBrakPunktu(p) ? { kod: 'punkt_przy_nadaniu', poziom: 'INFO', tekst: TEKST_PUNKTU[punkt.powod] } : p))
  }
  // powód, dla którego kwoty paczki nie da się wyliczyć, dopisany do problemu „Nieznana kwota pobrania” adaptera
  if (paczki?.powod) for (const p of parcel.problems) if (p.kod === 'pobranie' && p.tekst.includes(POWOD_KWOTY.PODZIAL)) p.tekst = `${p.tekst.replace(/\.$/, '')} (${paczki.powod}).`
  if (wybrany.zaDuze) parcel.problems.push({ kod: 'gabaryt_za_duzy', poziom: 'BLAD', tekst: wybrany.zaDuze })
  else if (wybrany.zPodpowiedzi) parcel.problems.push({ kod: 'gabaryt_podpowiedz', poziom: 'OSTRZEZENIE', tekst: `Gabaryt ${GABARYTY[wybrany.gabaryt]} to podpowiedź: paczka nie przeszła ćwiczenia pakowania.` })

  const dane = {
    adapterKey: regula.adapterKey,
    carrier: z.carrier!,
    courierCode: parcel.courierCode,
    parcelSize: parcel.gabaryt,
    sideXCm: parcel.sideXCm,
    sideYCm: parcel.sideYCm,
    sideZCm: parcel.sideZCm,
    weightKg: parcel.weightKg,
    codAmount: parcel.codAmount,
    problems: parcel.problems as unknown as Prisma.InputJsonValue,
    createdAt: new Date(),
  }
  // Bez `include` relacji: tylko wtedy Prisma robi natywne INSERT … ON CONFLICT i równoległe wywołania nie dają P2002.
  await db.preparedShipment.upsert({ where: klucz, create: { organizationId, orderId, packageNo: o.packageNo, ...dane }, update: dane })
  return { wynik: 'przygotowane', orderId, packageNo: o.packageNo, parcel }
}

export interface PodgladPrzesylki {
  nieDotyczy: string | null
  gabaryty: { kod: Gabaryt; nazwa: string }[]
  zapisana: {
    przewoznik: Carrier
    courierCode: string | null
    gabaryt: string | null
    wymiary: string | null
    wagaKg: number | null
    /** Wartość robocza, a nie potwierdzona: ekran mówi to przy liczbie, nie tylko na liście problemów. */
    wymiaryRobocze: boolean
    wagaRobocza: boolean
    /** waga domyślna z ustawień przewoźnika firmy (produkty bez wagi), bez potwierdzania co paczkę. */
    wagaZUstawien: boolean
    pobranie: Prisma.Decimal | null
    problemy: ShipmentProblem[]
    przygotowano: Date
    /** Zamówienie albo jego pozycje zmieniły się po policzeniu: podgląd do odświeżenia. */
    nieaktualny: boolean
  } | null
}

function problemyZWiersza(v: Prisma.JsonValue): ShipmentProblem[] {
  return Array.isArray(v) ? (v as unknown as ShipmentProblem[]).filter((p) => p && typeof p.tekst === 'string') : []
}

/** Blok w ekranie zamówienia: zapisany podgląd i gabaryty do wyboru. Tylko odczyt; null = zamówienia nie ma. */
export async function podgladPrzesylki(db: Db, orderId: string): Promise<PodgladPrzesylki | null> {
  organizationIdOf(db)
  const [z] = await wczytajZamowienia(db, [orderId])
  if (!z) return null
  // Najwyżej jeden wiersz: klucz to (firma, zamówienie, paczka), a numer paczki należy do zamówienia.
  const r = await db.preparedShipment.findFirst({ where: { orderId } })
  const problemy = r ? problemyZWiersza(r.problems) : []
  const nieaktualny = r ? await zmienioneOd(db, orderId, r.createdAt) : false
  return {
    nieDotyczy: powodNieDotyczy(daneOceny(z)) ?? (await regulaPrzesylki(db, z)).powod,
    gabaryty: gabarytyDla(z.carrier).map((kod) => ({ kod, nazwa: GABARYTY[kod] })),
    zapisana: r
      ? {
          przewoznik: r.carrier,
          courierCode: r.courierCode,
          gabaryt: isGabaryt(r.parcelSize) ? GABARYTY[r.parcelSize] : r.parcelSize,
          wymiary: r.sideXCm && r.sideYCm && r.sideZCm ? `${r.sideXCm} × ${r.sideYCm} × ${r.sideZCm} cm` : null,
          wagaKg: r.weightKg === null ? null : Number(r.weightKg),
          wymiaryRobocze: problemy.some((p) => p.kod === 'wymiary_domyslne'),
          // waga z ustawień firmy (INFO) nie jest „robocza, do potwierdzenia”
          wagaRobocza: problemy.some((p) => p.kod === 'waga_domyslna' && p.poziom !== 'INFO'),
          wagaZUstawien: problemy.some((p) => p.kod === 'waga_domyslna' && p.poziom === 'INFO'),
          pobranie: r.codAmount,
          problemy,
          przygotowano: r.createdAt,
          nieaktualny,
        }
      : null,
  }
}

/**
 * ostrzeżenia z zapisanego podglądu, które człowiek potwierdza przed nadaniem (pola wyboru przy „Utwórz
 * przesyłkę” widoczne przed pierwszym kliknięciem). Tylko podpowiedź: nadanie liczy przesyłkę od nowa i odda nowe
 * ostrzeżenia w `doPotwierdzenia`, gdy podgląd się zestarzał.
 */
export async function ostrzezeniaDoPotwierdzenia(db: Db, orderId: string): Promise<{ kod: string; tekst: string }[]> {
  const r = await db.preparedShipment.findFirst({ where: { orderId }, select: { problems: true, createdAt: true } })
  if (!r) return []
  // podgląd nieaktualny (zamówienie zmieniło się po policzeniu) = bez pól do zaznaczenia; teksty z liczbami
  // (waga, wymiary, kwota pobrania) mogłyby już nie odpowiadać temu, co pójdzie do przewoźnika. Pierwsze kliknięcie
  // „Utwórz przesyłkę” liczy od nowa i oddaje świeże teksty w odmowie „do potwierdzenia”.
  if (await zmienioneOd(db, orderId, r.createdAt)) return []
  // podpowiedź gabarytu znika, gdy przycisk nadania niesie gabaryt; jeśli nadanie jej wymaga, odda ją w `doPotwierdzenia`
  const lista = problemyZWiersza(r.problems).filter((p) => p.poziom === 'OSTRZEZENIE' && p.kod !== 'gabaryt_podpowiedz')
  return [...new Map(lista.map((p) => [p.kod, { kod: p.kod, tekst: p.tekst }])).values()]
}

/** Ostatnia zmiana zamówienia albo którejkolwiek pozycji jest późniejsza niż chwila policzenia podglądu. */
async function zmienioneOd(db: Db, orderId: string, od: Date): Promise<boolean> {
  const o = await db.order.findUnique({ where: { id: orderId }, select: { updatedAt: true } })
  if (o && o.updatedAt > od) return true
  return (await db.orderLine.count({ where: { orderId, updatedAt: { gt: od } } })) > 0
}

/**
 * Parametry przesyłki do nadania: zawsze liczone od nowa przez `prepareForOrder`, nigdy z
 * zapisanego wiersza PreparedShipment — ten jest tylko podglądem i mógł się zestarzeć. Host nadania (
 * lib/wysylka/nadanie.ts) bierze parametry stąd, z punktem odbioru z danych klienta. „Nie dotyczy” = przesyłki nie będzie.
 */
export async function przesylkaDoNadania(db: Db, orderId: string, gabaryt?: string | null, punktOdbioru?: string | null): Promise<WynikPrzygotowania> {
  // odświeża też podgląd (wiersz znów odpowiada zamówieniu); punkt odbioru nie ma kolumny, znika tylko problem „punkt”.
  // `null` (nie `undefined`): punkt podał odczyt odbiorcy nadania, więc podgląd nie czyta go drugi raz
  return prepareForOrder(db, orderId, gabaryt, { punktOdbioru: punktOdbioru ?? null })
}
