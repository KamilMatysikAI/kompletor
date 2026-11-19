// Druk kart zamówień z rejestrem wydruków. Każda karta dostaje kolejny numer wydruku zamówienia
// (N+1 unieważnia kod N na stanowisku) i wiersz w OrderCardPrint z migawką pozycji. `naSucho` = konto kanału
// w cieniu (`statusMode = CIEN`). Woła to POST /api/wydruki/karty (formularz z kolejki pakowania).
// Konto w PRACY: wydruk zamówienia DO_REALIZACJI to T7 (ZBIERANIE), nowy wydruk zdejmuje „karta
// nieaktualna”. W cieniu wydruk niczego nie zmienia w zamówieniu.
// z listy zamówień (`informacyjne`) każde zaznaczone zamówienie dostaje stronę; bez karty do zbierania
// (wysłane, anulowane, bez towaru, bez numeru do kodu) — wydruk informacyjny: bez rejestru, kodu i zmian w zamówieniu.
import type { OrderStatus, PrismaClient } from '@prisma/client'
import { miniaturyDoWydruku } from '../produkty/zdjecia'
import { plikLogo } from '../firma/logo'
import { organizationIdOf } from '@/lib/db'
import { lockOrder, startPickingOnPrint } from '@/lib/rdzen/przejscia'
import { flagsOf, mergeFlags } from '@/lib/rdzen/rezerwacja'
import { advisoryLock, runTx, type Tx } from '@/lib/rdzen/stan'
import { kartyZamowien, type KartaInformacyjnaDane, type KartaZamowieniaDane, type PozycjaInformacyjna, type StronaKart } from '@/lib/wydruki'
import { STATUS_LABEL } from '@/lib/panel/format'
import { daneKlientaDoWydruku, type KlientNaWydruku } from '@/lib/klienci/wydruk'
import { MAX_ZAMOWIEN, migawkaPozycji, takaSamaMigawka, wczytajZamowienia, type ZamowienieStanowiska } from './zamowienia'

type Db = PrismaClient

/** Błąd żądania kart z komunikatem dla człowieka i kodem HTTP. */
export class BladKart extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 422,
  ) {
    super(message)
  }
}

/** Karty nie dostaje zamówienie już wysłane, odebrane albo anulowane (sprawdza serwer, nie tylko lista). */
const BEZ_KARTY = new Set<OrderStatus>(['WYSLANE', 'ODEBRANE', 'ANULOWANE'])

/** Zamówienie pominięte w wydruku: same produkty bez stanu (np. e-book) albo po wysyłce/anulowane — nie ma czego zbierać. */
export interface PominietaKarta {
  orderId: string
  numer: string
}

export interface WydrukKarty {
  orderId: string
  kod: string
  printNo: number
  naSucho: boolean
  /** Ten wydruk rozpoczął zbieranie (T7, tylko konto w PRACY). */
  zbieranie: boolean
}

/** zamówienie wydrukowane informacyjnie (bez karty do zbierania) i powód po ludzku. */
export interface KartaInformacyjna extends PominietaKarta {
  powod: string
}

export interface OpcjeDrukuKart {
  /**
   * true (lista zamówień, karta zamówienia) = każde zaznaczone zamówienie dostaje stronę: karta do zbierania
   * albo wydruk informacyjny (wysłane, anulowane, bez towaru do zebrania, bez numeru do kodu karty). false (kolejka
   * pakowania, domyślnie) = jak dotąd: takie zamówienia pominięte, a same takie = 422.
   */
  informacyjne?: boolean
}

const lista = (z: readonly { numer: string }[]) => z.map((x) => x.numer).join(', ')

/** Powód wydruku informacyjnego po ludzku; null = zamówienie dostaje kartę do zbierania. */
export function powodInformacyjny(z: ZamowienieStanowiska): string | null {
  if (z.status === 'WYSLANE') return 'zamówienie wysłane'
  if (z.status === 'ODEBRANE') return 'zamówienie odebrane'
  if (z.status === 'ANULOWANE') return 'zamówienie anulowane'
  if (z.tylkoBezStanu) return 'same produkty bez wysyłki (np. e-book)'
  if (z.pozycje.length === 0) return z.brakujace.length ? 'brakuje całego towaru' : 'zamówienie bez pozycji do zebrania'
  if (!z.numerKarty || !z.kodZamowienia) return 'zamówienie nie ma jeszcze numeru do kodu karty'
  return null
}

/**
 * PDF z kartami zamówień `ids` (kolejność jak w `ids`). Zapis rejestru i PDF są spójne: najpierw rejestr
 * w transakcji, potem PDF z tymi numerami; błąd rysowania PDF = żądanie ponownie (kolejny numer), stara karta
 * staje się nieaktualna — po bezpiecznej stronie. Zamówienia z samymi produktami bez stanu (e-book) oraz wysłane,
 * odebrane i anulowane są pomijane (`pominiete`), a gdy w żądaniu są tylko takie — 422.
 * z `opcje.informacyjne` nic nie jest pomijane — takie zamówienia (i bez numeru do kodu karty) dostają
 * wydruk informacyjny (`informacyjne`): bez wiersza w rejestrze, bez kodu i bez żadnej zmiany w zamówieniu.
 */
export async function drukujKarty(
  db: Db,
  ids: string[],
  kto: { userId: string; nazwa: string },
  now = new Date(),
  opcje: OpcjeDrukuKart = {},
): Promise<{ pdf: Buffer; wydruki: WydrukKarty[]; pominiete: PominietaKarta[]; informacyjne: KartaInformacyjna[] }> {
  const org = organizationIdOf(db)
  if (!ids.length) throw new BladKart('Nie zaznaczono żadnego zamówienia. Wróć do listy, zaznacz zamówienia i wydrukuj ponownie.', 400)
  if (ids.length > MAX_ZAMOWIEN) throw new BladKart(`Jednym wydrukiem można objąć najwyżej ${MAX_ZAMOWIEN} zamówień. Zaznacz mniej i wydrukuj w kilku częściach.`, 400)
  const wszystkie = await wczytajZamowienia(db, ids)
  if (wszystkie.length !== ids.length) {
    throw new BladKart('Części zaznaczonych zamówień nie ma już na liście (np. zostały połączone albo usunięte). Odśwież listę i wydrukuj ponownie.', 404)
  }
  let zam: ZamowienieStanowiska[]
  let pominiete: PominietaKarta[] = []
  const informacyjne: KartaInformacyjna[] = []
  if (opcje.informacyjne) {
    zam = []
    for (const z of wszystkie) {
      const powod = powodInformacyjny(z)
      if (powod) informacyjne.push({ orderId: z.id, numer: z.numer, powod })
      else zam.push(z)
    }
  } else {
    // bez pozycji do zebrania (e-book albo brakuje wszystkiego): karta byłaby pusta
    const pomin = (z: ZamowienieStanowiska) => z.tylkoBezStanu || z.pozycje.length === 0 || BEZ_KARTY.has(z.status)
    pominiete = wszystkie.filter(pomin).map((z) => ({ orderId: z.id, numer: z.numer }))
    zam = wszystkie.filter((z) => !pomin(z))
    if (!zam.length) {
      throw new BladKart(
        `Żadne z zaznaczonych zamówień nie ma towaru do zebrania (są wysłane, odebrane, anulowane, mają same produkty bez wysyłki albo brakuje w nich całego towaru), więc nie ma czego drukować jako karty: ${lista(pominiete)}. Takie zamówienia wydrukujesz z listy zamówień: dostaną wydruk informacyjny.`,
        422,
      )
    }
    const bezNumeru = zam.filter((z) => !z.numerKarty || !z.kodZamowienia)
    if (bezNumeru.length) {
      throw new BladKart(
        `Zamówienia ${lista(bezNumeru)} nie mają jeszcze numeru, z którego powstaje kod karty. Numer zwykle pojawia się po kolejnym pobraniu zamówień z kanału: spróbuj za kilka minut. Wydruk informacyjny (bez kodu) zrobisz od razu z listy zamówień.`,
        422,
      )
    }
  }
  const powtorzone = zam.filter((z, i) => zam.findIndex((x) => x.kodZamowienia === z.kodZamowienia) !== i)
  if (powtorzone.length) {
    throw new BladKart(
      `Dwa zaznaczone zamówienia dostałyby ten sam kod karty (${powtorzone.map((z) => z.kodZamowienia).join(', ')}). Wydrukuj je osobno albo zmień nazwę jednego z kont kanału w ustawieniach kanałów.`,
      409,
    )
  }

  const wydruki = !zam.length ? [] : await runTx(db, async (tx) => {
    const out: WydrukKarty[] = []
    // kolejność blokad stała (po kodzie) — dwa równoległe wydruki tych samych kart nie zakleszczą się
    const poKodzie = [...zam].sort((a, b) => (a.kodZamowienia! < b.kodZamowienia! ? -1 : 1))
    for (const z of poKodzie) await advisoryLock(tx, `karta:${org}:${z.kodZamowienia}`)
    for (const z of zam) {
      const kod = z.kodZamowienia!
      const cudza = await tx.orderCardPrint.findFirst({ where: { orderCode: kod, orderId: { not: z.id } }, select: { id: true } })
      if (cudza) {
        throw new BladKart(
          `Kod karty ${kod} ma już inne zamówienie (pewnie dwa konta kanału mają ten sam skrót nazwy). Zmień nazwę jednego z kont w ustawieniach kanałów i wydrukuj ponownie.`,
          409,
        )
      }
      const ostatni = await tx.orderCardPrint.findFirst({ where: { orderId: z.id }, orderBy: { printNo: 'desc' }, select: { printNo: true } })
      const printNo = (ostatni?.printNo ?? 0) + 1
      const naSucho = z.tryb === 'CIEN'
      await tx.orderCardPrint.create({
        data: { orderId: z.id, orderCode: kod, printNo, printedAt: now, printedBy: kto.userId, dryRun: naSucho, lines: z.migawka as unknown as object },
      })
      const zbieranie = naSucho ? false : await poWydrukuPraca(tx, z, printNo, kto.userId, now)
      out.push({ orderId: z.id, kod: `${kod}/${printNo}`, printNo, naSucho, zbieranie })
    }
    return out
  })

  const nr = new Map(wydruki.map((w) => [w.orderId, w]))
  const powody = new Map(informacyjne.map((i) => [i.orderId, i.powod]))
  // kolejność stron = kolejność zaznaczenia (karty do zbierania i wydruki informacyjne przemieszane)
  const drukowane = wszystkie.filter((z) => nr.has(z.id) || powody.has(z.id))
  // odbiorca wg uprawnień osoby zlecającej wydruk (pełny adres z `klienci.dane`, inaczej skrót); ślad WYDRUK
  const klienci = await daneKlientaDoWydruku(db, drukowane.map((z) => z.id), kto.userId)
  // miniatury zdjęć produktów (JPEG 96 px, przygotowane przy wgraniu); brak pliku = ramka „brak”
  const miniatury = zam.length
    ? await miniaturyDoWydruku(db, [...new Set(zam.flatMap((z) => z.pozycje.map((x) => x.productId).filter((x): x is string => !!x)))]).catch(() => new Map<string, Buffer>())
    : new Map<string, Buffer>()
  // logo firmy (wersja do wydruku); brak albo błąd odczytu = karta bez logo
  const logo = (await plikLogo(db, 'druk').catch(() => null))?.bytes ?? null
  const pdf = await kartyZamowien(
    drukowane.map((z): StronaKart => {
      const powod = powody.get(z.id)
      return powod
        ? { ...daneInformacyjne(z, powod, kto.nazwa, now, klienci.get(z.id) ?? null), logo }
        : { ...daneKarty(z, nr.get(z.id)!, kto.nazwa, now, klienci.get(z.id) ?? null, miniatury), logo }
    }),
    { pominiete: pominiete.map((p) => p.numer) },
  )
  return { pdf, wydruki, pominiete, informacyjne }
}

/** wydruk informacyjny — wszystkie pozycje zamówienia; czego nie ma do zebrania, ma oznaczenie. */
export function daneInformacyjne(z: ZamowienieStanowiska, powod: string, drukujacy: string, now: Date, klient: KlientNaWydruku | null): KartaInformacyjnaDane {
  const pozycje: PozycjaInformacyjna[] = [
    ...z.pozycje.map((p) => ({ nazwa: p.nazwa, wariant: p.dopisek, sku: p.sku, ilosc: p.ilosc, jednostka: p.jednostka, oznaczenie: null })),
    ...z.brakujace.map((p) => ({ nazwa: p.nazwa, wariant: p.dopisek, sku: p.sku, ilosc: p.ilosc, jednostka: p.jednostka, oznaczenie: 'brak' as const })),
    ...z.pozycjeBezStanu.map((p) => ({ nazwa: p.nazwa, wariant: p.dopisek, sku: p.sku, ilosc: p.ilosc, jednostka: p.jednostka, oznaczenie: 'bez stanu' as const })),
  ]
  return {
    informacyjna: true,
    powod,
    // numer jak w panelu; bez numeru do kodu karty to przedrostek kanału i identyfikator z kanału
    numer: z.numer,
    kanal: z.kanal,
    status: STATUS_LABEL[z.status],
    dataZamowienia: z.dataZamowienia,
    przewoznik: z.przewoznik,
    metodaDostawy: z.metodaDostawy,
    wydrukowano: now,
    drukujacy,
    odbiorca: klient?.skrot ?? null,
    adresOdbiorcy: klient?.adres ?? null,
    uwagiKlienta: z.komentarzKlienta,
    pozycje,
  }
}

/** Karta pokazuje faktyczną zawartość paczki: pozycje to towar do zebrania, a braki idą do uwag magazynu. */
export function uwagiKarty(z: ZamowienieStanowiska): string | null {
  const braki = z.brakujace.map((b) => `${b.nazwa}${b.dopisek ? ` (${b.dopisek})` : ''}: ${b.ilosc}${b.jednostka === 'g' ? ' g' : ' szt.'}`)
  const tekst = braki.length ? `BRAK, NIE PAKOWAĆ: ${braki.join('; ')}` : null
  return [tekst, z.uwagiBiura].filter(Boolean).join('\n') || null
}

/**
 * Konto w PRACY, w transakcji wydruku: flaga „karta nieaktualna” wg stanu pozycji pod blokadą zamówienia (zdjęta, chyba
 * że edycja z kanału weszła między odczytem do PDF-u a blokadą) i T7. Zamówienia blokowane po kartach, więc kolejność stała.
 */
async function poWydrukuPraca(tx: Tx, z: ZamowienieStanowiska, printNo: number, actorId: string, now: Date): Promise<boolean> {
  const o = await lockOrder(tx, z.id)
  const lines = await tx.orderLine.findMany({ where: { orderId: z.id }, select: { id: true, productId: true, qty: true, qtyRejected: true, removed: true } })
  // tylko pozycje z kanału: brak (`b`) nie jest edycją i karta wydrukowana z brakiem jest aktualna
  const nieaktualna = !takaSamaMigawka(z.migawka.map(({ b: _b, ...m }) => m), migawkaPozycji(lines))
  if (!!flagsOf(o).kartaNieaktualna !== nieaktualna) await tx.order.update({ where: { id: o.id }, data: { flags: mergeFlags(o, { kartaNieaktualna: nieaktualna || undefined }) } })
  return o.status === 'DO_REALIZACJI' ? startPickingOnPrint(tx, o.id, { now, actorId, printNo }) : false
}

function daneKarty(z: ZamowienieStanowiska, w: WydrukKarty, drukujacy: string, now: Date, klient: KlientNaWydruku | null, miniatury: Map<string, Buffer> = new Map()): KartaZamowieniaDane {
  return {
    zamowienie: z.numerKarty!,
    kanal: z.kanal,
    dataZamowienia: z.dataZamowienia,
    przewoznik: z.przewoznik,
    metodaDostawy: z.metodaDostawy,
    naSucho: w.naSucho,
    numerWydruku: w.printNo,
    wydrukowano: now,
    drukujacy,
    odbiorca: klient?.skrot ?? null,
    adresOdbiorcy: klient?.adres ?? null,
    uwagiMagazynu: uwagiKarty(z),
    uwagiKlienta: z.komentarzKlienta,
    pozycje: z.pozycje.map((p) => ({
      lokalizacja: p.lokalizacja,
      nazwa: p.nazwa,
      wariant: p.dopisek,
      sku: p.sku,
      ilosc: p.ilosc,
      jednostka: p.jednostka,
      miniatura: p.productId ? (miniatury.get(p.productId) ?? null) : null,
    })),
  }
}
