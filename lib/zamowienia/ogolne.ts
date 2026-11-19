// Zamówienie w ogólnym kształcie: jedno wejście dla API `POST /api/v1/zamowienia`
// z polem `kanal` i dla formularza „Zamówienia → Dodaj zamówienie”. Pozycje po SKU albo id produktu z katalogu firmy,
// klient (opcjonalnie: osoba albo firma, kontakt, adres, dane do faktury), dostawa (sposób, przewoźnik, punkt odbioru,
// koszt), płatność, źródło. Idempotencja po numerze zewnętrznym jak w kształcie EasyTools: ta sama treść =
// DUPLIKAT z tym samym zamówieniem, ten sam numer z inną treścią = 409 bez zmian.
//
// Kolejność: walidacja (śmieci nie wchodzą do rdzenia) → konto kanału → produkty z katalogu → klucze danych klienta
// (jeśli jest klient: brak klucza = odmowa PRZED utworzeniem zamówienia, żeby nie zostało zamówienie bez adresu) →
// `ingestOrder` (rezerwacja, przewoźnik, terminy; ta sama droga co kanały) → zaszyfrowany zapis klienta (`RECZNE`, automat
// go nie nadpisuje). Zapis klienta jest poza transakcją rdzenia (szyfrowanie i blokada klienta), więc
// po błędzie w tym kroku powtórka tego samego żądania (DUPLIKAT) dopisuje brakujący rekord.
import { createHash, createHmac } from 'node:crypto'
import type { Carrier, Channel, PaymentState, PrismaClient } from '@prisma/client'
import { ApiInputError } from '@/lib/api/odpowiedzi'
import { organizationIdOf } from '@/lib/db'
import type { RekordKlienta } from '@/lib/klienci/rekord'
import { kluczSkrotowZEnv } from '@/lib/klienci/skroty'
import { kluczeZapisuDostepne, zapiszKlientaNowegoZamowienia } from '@/lib/klienci/zapis'
import { ingestOrder, OrderExistsError, type IncomingLine, type IncomingOrder, type IngestOutcome } from '@/lib/rdzen/zamowienia'

/** Kanały, do których wolno dodać zamówienie z zewnątrz albo z panelu (bez kanału sprzedaży, który sam je przysyła). */
export const KANALY_OGOLNE = ['RECZNE', 'EASYTOOLS'] as const
export type KanalOgolny = (typeof KANALY_OGOLNE)[number]

export const MAX_POZYCJI = 100

/** Domyślna nazwa metody płatności, gdy wywołujący jej nie podał. */
export const METODA_DOMYSLNA: Record<'PAID' | 'UNPAID' | 'COD', string> = { PAID: 'Opłacone', UNPAID: 'Przelew', COD: 'Za pobraniem' }

export interface PozycjaOgolna {
  sku?: string
  produktId?: string
  ilosc: number
  cenaBrutto: number
  vat?: string
}

export interface ZamowienieOgolne {
  kanal: KanalOgolny
  /** Konto kanału (ChannelConfig.channelAccountId); brak = jedyne aktywne konto kanału (RECZNE: zakładane w razie braku). */
  konto?: string
  numer: string
  zrodlo: string | null
  /** Data złożenia z wejścia; brak = chwila przyjęcia (poza kluczem idempotencji, żeby powtórka dała DUPLIKAT). */
  zlozono: Date | null
  platnosc: 'PAID' | 'UNPAID' | 'COD'
  platnoscMetoda: string
  /** Suma brutto: podana albo policzona z pozycji i kosztu dostawy. */
  sumaBrutto: number
  dostawa: { sposob: string; przewoznik: Carrier | null; koszt: number | null }
  chceFakture: boolean
  klient: RekordKlienta | null
  pozycje: PozycjaOgolna[]
}

export interface OpcjePrzyjecia {
  /** Formularz panelu: przy kilku kontach ręcznych w PRACY bierze pierwsze zamiast 422. */
  pierwszeKonto?: boolean
  /** `api` albo `panel`: źródło zdarzenia w InboundEvent (idempotencja osobno dla każdego). */
  source: 'api' | 'panel'
  /** Kto (User.id albo `api:<klucz>`) — do śladu zapisu danych klienta. */
  actorId: string
  env: Record<string, string | undefined>
  now?: Date
}

export interface WynikPrzyjecia {
  status: 201 | 200
  body: {
    id: string
    status: string
    outcome: IngestOutcome
    zarezerwowano: number
    brakuje: number
    /** Dane klienta: zapisane teraz, już były (powtórka) albo zamówienie bez klienta. */
    klient: 'ZAPISANO' | 'BYLY' | 'BRAK'
  }
}

/** Suma pozycji i dostawy w groszach (bez błędów float), wynik w złotych. */
export function sumaPozycji(pozycje: Pick<PozycjaOgolna, 'ilosc' | 'cenaBrutto'>[], koszt: number | null): number {
  const gr = pozycje.reduce((s, l) => s + Math.round(l.cenaBrutto * 100) * l.ilosc, 0) + Math.round((koszt ?? 0) * 100)
  return gr / 100
}

/**
 * Podana suma brutto wolno różnić się od policzonej tylko o zaokrąglenia ceny jednostkowej (przeliczenie z netto albo
 * cena z 4 miejscami po przecinku zaokrąglona do 2): pół grosza na sztukę, co najmniej 1 grosz na pozycję, ale nigdy
 * więcej niż 0,5% sumy (najmniej 1 zł) — przeglądu: bez sufitu duże ilości przepuszczałyby setki złotych różnicy.
 * Większa różnica = błąd danych wejściowych, nie zgadujemy, która liczba jest prawdziwa.
 */
export function sumaZgodna(podana: number, pozycje: Pick<PozycjaOgolna, 'ilosc' | 'cenaBrutto'>[], koszt: number | null): boolean {
  const policzonaGr = Math.round(sumaPozycji(pozycje, koszt) * 100)
  const zaokraglenia = Math.max(pozycje.length, Math.ceil(pozycje.reduce((s, l) => s + l.ilosc, 0) / 2))
  const sufit = Math.max(100, Math.floor(policzonaGr * 0.005))
  return Math.abs(Math.round(podana * 100) - policzonaGr) <= Math.min(zaokraglenia, sufit)
}

/**
 * Konto kanału zamówienia.
 * RECZNE: tylko konto w trybie PRACA, bo zamówień ręcznych nie prowadzi żaden zewnętrzny system (BL o
 * nich nie wie), więc w cieniu zostałyby bez drogi. Wskazane konto w cieniu = 422. Bez wskazania: konto „reczne”, gdy
 * jest w PRACY; inaczej jedyne konto w PRACY; kilka bez „reczne” = 422 dla API, a formularz (`pierwsze`) bierze pierwsze.
 * Żadnego w PRACY: konto „reczne” zakładane w PRACY (istniejące „reczne” w cieniu przełączane na PRACĘ: to konto
 * zakłada wyłącznie Kompletor).
 * EASYTOOLS: jedyne aktywne konto albo wskazane.
 */
export async function kontoKanalu(db: PrismaClient, kanal: KanalOgolny, konto?: string, opts: { pierwsze?: boolean } = {}): Promise<string> {
  const accs = await db.channelConfig.findMany({ where: { channel: kanal, active: true }, select: { channelAccountId: true, statusMode: true }, orderBy: { channelAccountId: 'asc' } })
  if (konto) {
    const a = accs.find((x) => x.channelAccountId === konto)
    if (!a) throw new ApiInputError(`Firma nie ma aktywnego konta ${kanal} „${konto}”`, 'konto', 422)
    if (kanal === 'RECZNE' && a.statusMode !== 'PRACA')
      throw new ApiInputError(`Konto ${kanal} „${konto}” jest w trybie cienia: zamówień ręcznych nie prowadzi BaseLinker, wskaż konto w trybie pracy albo pomiń pole konto`, 'konto', 422)
    return konto
  }
  if (kanal !== 'RECZNE') {
    if (accs.length === 1) return accs[0]!.channelAccountId
    if (accs.length > 1) throw new ApiInputError(`Firma ma kilka aktywnych kont ${kanal}: wskaż konto w polu konto`, 'konto', 422, { konta: accs.map((a) => a.channelAccountId) })
    throw new ApiInputError(kanal === 'EASYTOOLS' ? 'Firma nie ma aktywnego konta kanału EasyTools' : `Firma nie ma aktywnego konta ${kanal}`, 'kanal', 422)
  }
  const praca = accs.filter((a) => a.statusMode === 'PRACA')
  if (praca.some((a) => a.channelAccountId === KONTO_RECZNE)) return KONTO_RECZNE
  if (praca.length === 1 || (praca.length > 1 && opts.pierwsze)) return praca[0]!.channelAccountId
  if (praca.length > 1) throw new ApiInputError('Firma ma kilka kont zamówień ręcznych w trybie pracy: wskaż konto w polu konto', 'konto', 422, { konta: praca.map((a) => a.channelAccountId) })
  // brak konta ręcznego w PRACY: zakładamy (wyścig dwóch żądań = jeden wiersz, drugi nic nie robi)
  await db.channelConfig.createMany({
    data: [{ channel: 'RECZNE', channelAccountId: KONTO_RECZNE, name: 'Zamówienia ręczne', adapterKey: 'manual.v1', statusMode: 'PRACA' }],
    skipDuplicates: true,
  })
  const c = await db.channelConfig.findFirst({ where: { channel: 'RECZNE', channelAccountId: KONTO_RECZNE }, select: { active: true, statusMode: true } })
  if (!c?.active) throw new ApiInputError('Konto „Zamówienia ręczne” jest wyłączone: włącz je w Ustawieniach → Sprzedaż i kanały → Kanały sprzedaży', 'kanal', 422)
  if (c.statusMode !== 'PRACA') await db.channelConfig.updateMany({ where: { channel: 'RECZNE', channelAccountId: KONTO_RECZNE }, data: { statusMode: 'PRACA' } })
  return KONTO_RECZNE
}

export const KONTO_RECZNE = 'reczne'

/** Klucz zdarzenia zależny od całej treści; część klienta przez HMAC kluczem skrótów (w bazie nie ma skrótu danych osobowych bez klucza). */
/** konto w kluczu, inaczej ta sama treść na innym koncie dałaby DUPLIKAT bez zamówienia na tym koncie. */
export function kluczZdarzenia(z: ZamowienieOgolne, organizationId: string, kluczSkrotow: Buffer | null, konto: string): string {
  const klient = z.klient ? JSON.stringify(z.klient) : ''
  const klientPart = klient ? createHmac('sha256', kluczSkrotow ?? Buffer.alloc(32)).update(`${organizationId}\u0000${klient}`, 'utf8').digest('hex').slice(0, 32) : '-'
  const canon = JSON.stringify([
    z.kanal,
    konto,
    z.numer,
    z.zrodlo,
    z.zlozono ? z.zlozono.toISOString() : null,
    z.platnosc,
    z.platnoscMetoda,
    z.sumaBrutto,
    z.dostawa.sposob,
    z.dostawa.przewoznik,
    z.dostawa.koszt,
    z.chceFakture,
    klientPart,
    z.pozycje.map((l) => [l.sku ?? null, l.produktId ?? null, l.ilosc, l.cenaBrutto, l.vat ?? null]),
  ])
  return `${z.numer}:${createHash('sha256').update(canon, 'utf8').digest('hex').slice(0, 32)}`
}

/** Liczby rezerwacji zamówienia (sztuki w jednostce bazowej; zestaw w składnikach), zawsze z bazy. */
export async function liczbyRezerwacji(db: PrismaClient, orderId: string): Promise<{ zarezerwowano: number; brakuje: number }> {
  const [reserved, short] = await Promise.all([
    db.reservation.aggregate({ where: { orderId, state: { in: ['ACTIVE', 'CONSUMING', 'CONSUMED'] } }, _sum: { qtyBase: true } }),
    db.shortage.aggregate({ where: { orderId, state: { in: ['OPEN', 'SHIP_LATER'] } }, _sum: { qtyBase: true } }),
  ])
  return { zarezerwowano: reserved._sum.qtyBase ?? 0, brakuje: short._sum.qtyBase ?? 0 }
}

export async function przyjmijZamowienie(db: PrismaClient, z: ZamowienieOgolne, o: OpcjePrzyjecia): Promise<WynikPrzyjecia> {
  const channel: Channel = z.kanal
  const skus = [...new Set(z.pozycje.map((l) => l.sku).filter((x): x is string => !!x))]
  const ids = [...new Set(z.pozycje.map((l) => l.produktId).filter((x): x is string => !!x))]
  const products = await db.product.findMany({
    where: { OR: [...(skus.length ? [{ sku: { in: skus } }] : []), ...(ids.length ? [{ id: { in: ids } }] : [])] },
    select: { id: true, sku: true, kind: true, active: true },
  })
  const bySku = new Map(products.map((p) => [p.sku, p]))
  const byId = new Map(products.map((p) => [p.id, p]))
  const resolved = z.pozycje.map((l) => (l.sku ? bySku.get(l.sku) : byId.get(l.produktId!)))
  const unknown = z.pozycje.filter((_, i) => !resolved[i]).map((l) => l.sku ?? l.produktId!)
  if (unknown.length) throw new ApiInputError('Nieznane produkty (spoza katalogu firmy)', 'pozycje', 422, { nieznane: [...new Set(unknown)] })
  // produkt wycofany (nieaktywny) nie wchodzi do nowego zamówienia
  const nieaktywne = resolved.filter((p) => !p!.active).map((p) => p!.sku)
  if (nieaktywne.length) throw new ApiInputError('Produkty wycofane (nieaktywne w katalogu) — usuń je z zamówienia albo włącz produkt', 'pozycje', 422, { nieaktywne: [...new Set(nieaktywne)] })
  // EasyTools: e-book sprzedaje sam EasyTools, do logistyki trafia wyłącznie fizyczny dodatek
  const digital = z.kanal === 'EASYTOOLS' ? resolved.filter((p) => p!.kind === 'DIGITAL').map((p) => p!.sku) : []
  if (digital.length) throw new ApiInputError('Produkty bez stanu (e-book) nie trafiają do logistyki — usuń je z zamówienia', 'pozycje', 422, { bezStanu: [...new Set(digital)] })

  const organizationId = organizationIdOf(db)
  const kluczSkrotow = z.klient ? kluczSkrotowZEnv(o.env) : null
  if (z.klient) {
    // bez kluczy zamówienie powstałoby bez adresu, a powtórka niczego by nie naprawiła: odmowa przed rdzeniem
    if (!kluczeZapisuDostepne(o.env) || !kluczSkrotow)
      throw new ApiInputError('Ta instalacja nie ma klucza szyfrowania danych klientów (CUSTOMER_DATA_KEYS i CUSTOMER_LOOKUP_KEY): zamówienie z danymi klienta nie zostało przyjęte', 'klient', 422)
  }
  const account = await kontoKanalu(db, z.kanal, z.konto, { pierwsze: o.pierwszeKonto })

  const lines: IncomingLine[] = z.pozycje.map((l, i) => ({
    externalLineId: `${z.numer}:${i + 1}`,
    productId: resolved[i]!.id,
    qty: l.ilosc,
    unitPriceGross: l.cenaBrutto,
    vatRate: l.vat ?? null,
  }))
  const input: IncomingOrder = {
    source: o.source,
    eventKey: kluczZdarzenia(z, organizationId, kluczSkrotow, account),
    channel,
    channelAccountId: account,
    externalId: z.numer,
    createdAtChannel: z.zlozono ?? o.now ?? new Date(),
    paymentState: z.platnosc as PaymentState,
    paymentMethod: z.platnoscMetoda,
    totalGross: z.sumaBrutto,
    deliveryMethod: z.dostawa.sposob,
    carrier: z.dostawa.przewoznik,
    shippingCostGross: z.dostawa.koszt,
    sourceLabel: z.zrodlo,
    wantInvoiceNip: z.chceFakture,
    lines,
  }
  const res = await ingestOrder(db, input, { onlyNew: true, now: o.now }).catch((e: unknown) => {
    if (e instanceof OrderExistsError)
      throw new ApiInputError(
        'Zamówienie o tym numerze już istnieje z inną treścią. API nie zmienia przyjętych zamówień: popraw je w panelu Kompletora albo wyślij nowy numer.',
        'numer',
        409,
        { id: e.orderId, status: e.status },
      )
    throw e
  })
  const order = await db.order.findUnique({
    where: { organizationId_channel_channelAccountId_externalId: { organizationId, channel, channelAccountId: account, externalId: z.numer } },
    select: { id: true, status: true },
  })
  // DUPLIKAT zdarzenia bez zamówienia na tym koncie (klucz sprzed dołożenia konta) = konflikt, nie 500
  if (!order) throw new ApiInputError('Zamówienie o tym numerze i tej treści przyjęto już na innym koncie: wyślij nowy numer albo wskaż tamto konto', 'numer', 409)

  let klient: WynikPrzyjecia['body']['klient'] = 'BRAK'
  // NOWE albo powtórka po błędzie zapisu klienta: rekord RECZNE (automat kanału go nie nadpisze)
  if (z.klient) klient = await zapiszKlientaNowegoZamowienia(db, order.id, z.klient, { actorId: o.actorId, zrodlo: o.source === 'api' ? 'API' : 'NOWE_ZAMOWIENIE', env: o.env, now: o.now })
  const liczby = await liczbyRezerwacji(db, order.id)
  return { status: res.outcome === 'NOWE' ? 201 : 200, body: { id: order.id, status: order.status, outcome: res.outcome, ...liczby, klient } }
}
