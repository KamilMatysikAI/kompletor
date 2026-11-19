// Jednorazowe przeliczenie zamówień Woo z nieudaną płatnością (`failed`), które dawna mapa adaptera przyjęła jako
// anulowane. Dziś `failed` to zamówienie otwarte i nieopłacone (jak `pending`, tak prowadzi je też BaseLinker), ale
// zapisane już zamówienia same nie wrócą: odczyt sklepu widzi tę samą rewizję, status i płatność („bez zmian”).
// Źródło: wyłącznie dane w bazie (kopia zamówienia z kanału ma ostatni status `failed`), bez odczytu sklepu.
// Na zamówienie osobno (`przywrocNieudanaPlatnosc`, pod blokadą, z warunkami sprawdzanymi drugi raz), błąd jednego nie
// zatrzymuje reszty. Domyślnie na sucho. Powtórka nic nie zmienia: przeliczone zamówienie nie jest już „anulowane
// przez kanał” (otwarte albo „nieopłacone po terminie”).
// konta w trybie pracy (`ChannelConfig.statusMode` = PRACA) domyślnie bez zmian, na osobnej
// liście. Tam przywrócenie oznaczałoby spóźnione maile „Brak płatności”, zapis anulowania do sklepu dla starych
// zamówień i reguły czasowe automatów liczone od razu; przeliczenie ma iść w podglądzie, przed przełączeniem.
import type { PrismaClient } from '@prisma/client'
import { organizationIdOf } from '../db'
import { oznaczNieudanaPlatnoscOtwartego, przywrocNieudanaPlatnosc } from '../rdzen/zamowienia'

/** Status Woo nieudanej płatności (lib/adaptery/woo.ts). */
export const WOO_NIEUDANA_PLATNOSC = 'failed'

export interface WynikNieudanychPlatnosci {
  naSucho: boolean
  /** zamówień Woo anulowanych przez kanał, nieopłaconych, z ostatnim statusem sklepu `failed` */
  kandydaci: number
  /** numery zamówień w sklepie (bez danych klientów) — otwarte z rezerwacją (termin płatności jeszcze trwa) */
  otwarte: string[]
  /** otwarte bez rezerwacji: krótki termin nieudanej płatności online od złożenia już minął, towar od razu zwolniony */
  otwarteZwolnione: string[]
  /** termin minął: „anulowane, nieopłacone” bez ruchu stanów */
  poTerminie: string[]
  /** warunki niespełnione pod blokadą (np. anulowane przez obsługę, po fakturze, inny status w sklepie) */
  pominiete: string[]
  /**
   * zamówień Woo już otwartych (Nowe albo „Do wyjaśnienia” przed zbieraniem), nieopłaconych, z kopią `failed` i bez
   * znacznika nieudanej płatności online (przyjęte albo przeliczone, zanim Kompletor ją rozpoznawał)
   */
  kandydaciOtwarte: number
  /** otwarte oznaczone: towar trzymany do krótkiego terminu od złożenia, pytanie o płatność następnego dnia */
  oznaczone: string[]
  /** otwarte oznaczone, krótki termin od złożenia już minął: towar zwolniony od razu */
  oznaczoneZwolnione: string[]
  /** konto w trybie pracy (statusy): bez zmian, chyba że `takzeWPracy` */
  wPracy: string[]
  /**
   * anulowane u nas, a opłacone (także częściowo), z kopią z kanału `failed` albo otwartą/zrealizowaną w sklepie,
   * np. przyjęte od razu jako anulowane (dawna mapa), a potem opłacone. Przeliczenie ich nie zmienia: ręczna decyzja
   * obsługi (przywrócić albo zwrócić wpłatę); alert „płatność po anulowaniu” już jest.
   */
  doRecznejDecyzji: string[]
  /** kopie zamówień z kanału (`failed`) z cyklem życia poprawionym na otwarte */
  kopie: number
  bledy: { numer: string; blad: string }[]
  /**
   * Dane do ręcznego sprawdzenia przed zapisem, per numer zamówienia z list wyżej (bez danych osobowych): metoda
   * płatności zapisana w zamówieniu (tytuł z kanału; identyfikatora metody kopia nie przechowuje, więc przelewu ani
   * pobrania z ręcznie ustawionym `failed` nie da się odsiać automatycznie) i chwila złożenia.
   */
  zamowienia: Record<string, { metoda: string | null; zlozone: Date }>
  /** Ostatni udany odczyt zamówień każdego konta Woo z kandydatami (`ChannelCursor.lastOkAt`); `stary` = ponad próg. */
  swiezosc: { konto: string; ostatniOdczyt: Date | null; stary: boolean }[]
  /** Próg świeżości odczytu w ms. */
  maksWiekMs: number
  /** Zapis odmówiony (odczyt któregoś konta za stary): wynik jak na sucho, nic nie zapisano. */
  odmowa: string | null
}

/** Domyślny próg świeżości odczytu zamówień konta przed zapisem (jak w punkcie cięcia). */
export const MAKS_WIEK_ODCZYTU_MS = 15 * 60_000

/** Ile identyfikatorów zamówień w jednym zapytaniu `id in (…)` (limit parametrów zapytania Postgresa). */
const PACZKA_ID = 1000

export async function przeliczNieudanePlatnosciWoo(
  db: PrismaClient,
  opts: { naSucho?: boolean; now?: Date; channelAccountId?: string; takzeWPracy?: boolean; maksWiekMs?: number } = {},
): Promise<WynikNieudanychPlatnosci> {
  // tylko klient firmy (RLS); klient systemowy przeszedłby po kopiach wszystkich firm
  organizationIdOf(db)
  let naSucho = opts.naSucho !== false
  const now = opts.now ?? new Date()
  const maksWiekMs = opts.maksWiekMs ?? MAKS_WIEK_ODCZYTU_MS
  const kontoWhere = opts.channelAccountId ? { channelAccountId: opts.channelAccountId } : {}
  const snaps = await db.channelOrderSnapshot.findMany({
    where: { channel: 'WOO', channelStatus: WOO_NIEUDANA_PLATNOSC, ...kontoWhere },
    select: { channelAccountId: true, lifecycle: true, orderId: true },
  })
  const wynik: WynikNieudanychPlatnosci = { naSucho, kandydaci: 0, otwarte: [], otwarteZwolnione: [], poTerminie: [], kandydaciOtwarte: 0, oznaczone: [], oznaczoneZwolnione: [], pominiete: [], wPracy: [], doRecznejDecyzji: [], kopie: 0, bledy: [], zamowienia: {}, swiezosc: [], maksWiekMs, odmowa: null }
  wynik.doRecznejDecyzji = await anulowaneOplacone(db, opts.channelAccountId)
  if (!snaps.length) return wynik
  // konta w trybie pracy (statusy) bez jawnej flagi zostają bez zmian
  const kontaWPracy = opts.takzeWPracy
    ? new Set<string>()
    : new Set((await db.channelConfig.findMany({ where: { channel: 'WOO', statusMode: 'PRACA', ...kontoWhere }, select: { channelAccountId: true } })).map((k) => k.channelAccountId))
  // stan zamówień u nas jest tak świeży jak ostatni udany odczyt sklepu: zapis tylko przy świeżym odczycie każdego
  // konta, którego dotyczy (sklep mógł zmienić status albo przyjąć wpłatę); inaczej wynik jak na sucho z odmową
  const konta = [...new Set(snaps.filter((x) => x.orderId && !kontaWPracy.has(x.channelAccountId)).map((x) => x.channelAccountId))].sort()
  const kursory = konta.length ? await db.channelCursor.findMany({ where: { channel: 'WOO', channelAccountId: { in: konta } }, select: { channelAccountId: true, lastOkAt: true } }) : []
  wynik.swiezosc = konta.map((konto) => {
    const ostatniOdczyt = kursory.find((k) => k.channelAccountId === konto)?.lastOkAt ?? null
    return { konto, ostatniOdczyt, stary: !ostatniOdczyt || now.getTime() - ostatniOdczyt.getTime() > maksWiekMs }
  })
  const stare = wynik.swiezosc.filter((x) => x.stary)
  if (!naSucho && stare.length) {
    wynik.odmowa = `Ostatni udany odczyt zamówień ze sklepu starszy niż ${Math.round(maksWiekMs / 60_000)} min (konto ${stare.map((x) => x.konto).join(', ')}): poczekaj na kolejny odczyt sklepu (worker co kilka minut) i powtórz polecenie. Nic nie zapisano.`
    naSucho = true
    wynik.naSucho = true
  }
  // wybór po identyfikatorze zamówienia z kopii (paczkami), nie listą par konto+numer
  const ids = [...new Set(snaps.map((s) => s.orderId).filter((x): x is string => !!x))]
  const orders: { id: string; externalId: string; channelNumber: string | null; channelAccountId: string; createdAtChannel: Date; paymentMethod: string | null }[] = []
  for (let i = 0; i < ids.length; i += PACZKA_ID) {
    orders.push(
      ...(await db.order.findMany({
        where: {
          id: { in: ids.slice(i, i + PACZKA_ID) },
          channel: 'WOO',
          status: 'ANULOWANE',
          paymentState: 'UNPAID',
          // CANCELLED: anulowane po przyjęciu; null: przyjęte od razu jako anulowane (pierwszy odczyt już `failed`)
          OR: [{ cancelReason: 'CANCELLED' }, { cancelReason: null }],
        },
        select: { id: true, externalId: true, channelNumber: true, channelAccountId: true, createdAtChannel: true, paymentMethod: true },
      })),
    )
  }
  orders.sort((x, y) => x.createdAtChannel.getTime() - y.createdAtChannel.getTime() || x.id.localeCompare(y.id))
  wynik.kandydaci = orders.length
  for (const { id, externalId, channelNumber, channelAccountId, createdAtChannel, paymentMethod } of orders) {
    const nr = channelNumber ?? externalId
    wynik.zamowienia[nr] = { metoda: paymentMethod, zlozone: createdAtChannel }
    if (kontaWPracy.has(channelAccountId)) {
      wynik.wPracy.push(nr)
      continue
    }
    try {
      const r = await przywrocNieudanaPlatnosc(db, id, { now, naSucho, statusKanalu: WOO_NIEUDANA_PLATNOSC })
      if (r === 'otwarte') wynik.otwarte.push(nr)
      else if (r === 'otwarte-zwolnione') wynik.otwarteZwolnione.push(nr)
      else if (r === 'po-terminie') wynik.poTerminie.push(nr)
      else wynik.pominiete.push(nr)
    } catch (e) {
      wynik.bledy.push({ numer: nr, blad: (e instanceof Error ? e.message : String(e)).slice(0, 300) })
    }
  }
  await oznaczOtwarte(db, ids, kontaWPracy, wynik, { now, naSucho })
  const doPoprawy = snaps.filter((s) => s.lifecycle === 'CANCELLED' && !kontaWPracy.has(s.channelAccountId)).length
  if (naSucho) wynik.kopie = doPoprawy
  else if (doPoprawy)
    wynik.kopie = (
      await db.channelOrderSnapshot.updateMany({
        // jedno konto z --konto (gdy w pracy bez flagi, doPoprawy = 0), inaczej wszystkie poza kontami w pracy
        where: { channel: 'WOO', channelStatus: WOO_NIEUDANA_PLATNOSC, lifecycle: 'CANCELLED', ...(opts.channelAccountId ? kontoWhere : kontaWPracy.size ? { channelAccountId: { notIn: [...kontaWPracy] } } : {}) },
        data: { lifecycle: 'OPEN' },
      })
    ).count
  return wynik
}

/**
 * Druga część przeliczenia: zamówienia Woo otwarte (po dawnym przeliczeniu albo przyjęte jako `failed` przed
 * rozpoznawaniem płatności online) bez znacznika dostają znacznik, krótki termin zwolnienia towaru i pytanie o płatność
 * (`oznaczNieudanaPlatnoscOtwartego`, warunki drugi raz pod blokadą). Zamówienia przywrócone w pierwszej części mają już
 * znacznik i są pomijane. `failed` w Woo nadaje zwykle bramka płatności online (przelew tradycyjny czeka w `on-hold`);
 * identyfikatora metody płatności kopia nie przechowuje (w zamówieniu jest tylko tytuł), więc zamówienia przelewem albo
 * za pobraniem z ręcznie ustawionym `failed` odsiewa człowiek z raportu (`zamowienia`: metoda i data złożenia).
 */
async function oznaczOtwarte(db: PrismaClient, ids: string[], kontaWPracy: Set<string>, wynik: WynikNieudanychPlatnosci, opts: { now: Date; naSucho: boolean }): Promise<void> {
  const orders: { id: string; externalId: string; channelNumber: string | null; channelAccountId: string; createdAtChannel: Date; paymentMethod: string | null; flags: unknown }[] = []
  for (let i = 0; i < ids.length; i += PACZKA_ID) {
    orders.push(
      ...(await db.order.findMany({
        where: { id: { in: ids.slice(i, i + PACZKA_ID) }, channel: 'WOO', status: { in: ['NOWE', 'DO_WYJASNIENIA'] }, paymentState: { in: ['UNPAID', 'PARTIAL'] }, reservationDeadline: { not: null } },
        select: { id: true, externalId: true, channelNumber: true, channelAccountId: true, createdAtChannel: true, paymentMethod: true, flags: true },
      })),
    )
  }
  const bezZnacznika = orders.filter((o) => !(o.flags && typeof o.flags === 'object' && (o.flags as Record<string, unknown>)['nieudanaPlatnoscOnline'] === true))
  bezZnacznika.sort((x, y) => x.createdAtChannel.getTime() - y.createdAtChannel.getTime() || x.id.localeCompare(y.id))
  wynik.kandydaciOtwarte = bezZnacznika.length
  for (const { id, externalId, channelNumber, channelAccountId, createdAtChannel, paymentMethod } of bezZnacznika) {
    const nr = channelNumber ?? externalId
    wynik.zamowienia[nr] = { metoda: paymentMethod, zlozone: createdAtChannel }
    if (kontaWPracy.has(channelAccountId)) {
      wynik.wPracy.push(nr)
      continue
    }
    try {
      const r = await oznaczNieudanaPlatnoscOtwartego(db, id, { now: opts.now, naSucho: opts.naSucho, statusKanalu: WOO_NIEUDANA_PLATNOSC })
      if (r === 'oznaczone') wynik.oznaczone.push(nr)
      else if (r === 'oznaczone-zwolnione') wynik.oznaczoneZwolnione.push(nr)
      else wynik.pominiete.push(nr)
    } catch (e) {
      wynik.bledy.push({ numer: nr, blad: (e instanceof Error ? e.message : String(e)).slice(0, 300) })
    }
  }
}

/** zamówienia Woo Anulowane i opłacone, których kopia z kanału to `failed` albo zamówienie otwarte/zrealizowane w sklepie. */
async function anulowaneOplacone(db: PrismaClient, channelAccountId?: string): Promise<string[]> {
  const orders = await db.order.findMany({
    where: { channel: 'WOO', status: 'ANULOWANE', paymentState: { not: 'UNPAID' }, ...(channelAccountId ? { channelAccountId } : {}) },
    select: { id: true, externalId: true, channelNumber: true },
    orderBy: { createdAtChannel: 'asc' },
    take: 5000,
  })
  const out: string[] = []
  for (let i = 0; i < orders.length; i += PACZKA_ID) {
    const paczka = orders.slice(i, i + PACZKA_ID)
    const kopie = await db.channelOrderSnapshot.findMany({
      where: { orderId: { in: paczka.map((o) => o.id) }, OR: [{ channelStatus: WOO_NIEUDANA_PLATNOSC }, { lifecycle: { in: ['OPEN', 'FULFILLED'] } }] },
      select: { orderId: true },
    })
    const trafione = new Set(kopie.map((k) => k.orderId))
    for (const o of paczka) if (trafione.has(o.id)) out.push(o.channelNumber ?? o.externalId)
  }
  return out
}

const DZIEN_MS = 24 * 3_600_000
const czasPl = new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })

/**
 * Raport polecenia (CLI) po polsku: liczby, numery zamówień z metodą płatności wg tytułu, datą złożenia i wiekiem w
 * dniach (do odsiania przelewów i pobrań przed zapisem), ostrzeżenie o starym odczycie sklepu. Bez danych osobowych.
 */
export function opisNieudanychPlatnosciWoo(w: WynikNieudanychPlatnosci, now: Date): string {
  const nr = (n: string) => {
    const z = w.zamowienia[n]
    if (!z) return n
    const dni = Math.floor((now.getTime() - z.zlozone.getTime()) / DZIEN_MS)
    return `${n} (metoda wg tytułu: „${z.metoda ?? '(brak)'}”, nie potwierdzono identyfikatora; złożone ${czasPl.format(z.zlozone)}, ${dni} dn.)`
  }
  const lista = (x: string[]) => (x.length ? x.map((n) => `\n      ${nr(n)}`).join('') : ' —')
  const tryb = w.odmowa ? 'ODMOWA ZAPISU (wynik jak na sucho, nic nie zapisano)' : w.naSucho ? 'NA SUCHO (nic nie zapisano; zapis: --wykonaj)' : 'WYKONANIE'
  const out: string[] = [`[nieudane-platnosci-woo] ${tryb}`]
  if (w.odmowa) out.push(`  ${w.odmowa}`)
  const prog = Math.round(w.maksWiekMs / 60_000)
  for (const s of w.swiezosc)
    out.push(`  ${s.stary ? 'UWAGA: ' : ''}ostatni udany odczyt zamówień konta ${s.konto}: ${s.ostatniOdczyt ? czasPl.format(s.ostatniOdczyt) : 'nigdy'}${s.stary ? `, starszy niż ${prog} min (zapis z --wykonaj odmówi)` : ''}`)
  out.push('  Metoda płatności podana wg tytułu z zamówienia: identyfikatora metody kopia nie przechowuje, więc zamówienie przelewem albo za pobraniem z ręcznie ustawionym „Nieudane” w sklepie też tu trafi. Sprawdź każdy numer w sklepie przed --wykonaj.')
  out.push(`  zamówień do przeliczenia: ${w.kandydaci}, kopie z kanału do poprawy cyklu życia: ${w.kopie}`)
  out.push(`  ${w.naSucho ? 'wróciłyby' : 'wróciły'} do „Nowe, nieopłacone” z rezerwacją (${w.otwarte.length}):${lista(w.otwarte)}`)
  out.push(`  ${w.naSucho ? 'wróciłyby' : 'wróciły'} do „Nowe, nieopłacone” bez rezerwacji: nieudana płatność online, krótki termin minął, towar od razu w sprzedaży (${w.otwarteZwolnione.length}):${lista(w.otwarteZwolnione)}`)
  out.push(`  „Anulowane, nieopłacone” po terminie, bez ruchu stanów (${w.poTerminie.length}):${lista(w.poTerminie)}`)
  out.push(`  już otwarte bez znacznika nieudanej płatności online: ${w.kandydaciOtwarte}`)
  out.push(`  ${w.naSucho ? 'dostałyby' : 'dostały'} znacznik, towar trzymany do krótkiego terminu, pytanie o płatność najbliższego ranka o 9:00 (${w.oznaczone.length}):${lista(w.oznaczone)}`)
  out.push(`  ${w.naSucho ? 'dostałyby' : 'dostały'} znacznik, krótki termin minął, towar od razu w sprzedaży (${w.oznaczoneZwolnione.length}):${lista(w.oznaczoneZwolnione)}`)
  out.push(`  pominięte (warunki niespełnione) (${w.pominiete.length}):${lista(w.pominiete)}`)
  out.push(`  konto w trybie pracy, bez zmian (przeliczenie: --takze-w-pracy) (${w.wPracy.length}):${lista(w.wPracy)}`)
  out.push(`  do ręcznej decyzji: anulowane u nas, opłacone, w sklepie nieudana płatność albo otwarte (${w.doRecznejDecyzji.length}):${lista(w.doRecznejDecyzji)}`)
  for (const b of w.bledy) out.push(`  błąd ${b.numer}: ${b.blad}`)
  return out.join('\n')
}
