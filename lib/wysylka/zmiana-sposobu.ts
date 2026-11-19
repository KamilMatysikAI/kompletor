// Zmiana sposobu wysyłki na karcie zamówienia przed nadaniem (np. klient wybrał Paczkomat InPost, a chce kuriera DPD).
// Wybór z usług skonfigurowanych w firmie (reguły przewoźników: przewoźnik + moduł wysyłki), zapis w zamówieniu
// (`carrier`, `shippingModule`, `flags.przewoznikRecznie`) i w danych odbiorcy (punkt albo adres) w JEDNEJ transakcji pod
// blokadą przesyłki zamówienia (ta sama co poprawka adresu i rezerwacja przesyłki), więc zmiana i nadanie się nie
// przeplatają. Nadanie bierze potem regułę wybranego przewoźnika i modułu jak przy wyborze wprost
// (`regulaDlaZamowienia`). Metoda dostawy z kanału (`deliveryMethod`) zostaje bez zmian: to zapis tego, co wybrał klient.
//
// Zasady:
// - tylko konto w trybie pracy (`bramkaKarty`), przed utworzeniem przesyłki (aktywna przesyłka = odmowa, najpierw jej
//   anulowanie), w statusach przed wysłaniem;
// - usługa z punktem wymaga punktu, kurier pod adres pełnego adresu; punkt poprzedniego przewoźnika nie przechodzi na
//   nowego (paczkomat jako punkt DPD Pickup poszedłby w złe miejsce), kurier pod adres nie dostaje punktu wcale;
// - pobranie tylko na usługę, która je obsługuje (inaczej odmowa z komunikatem);
// - Wysyłam z Allegro: usługę Allegro wybrał kupujący i zmienia się ją w Allegro; z karty da się przejść na przewoźnika
//   z umowy firmy (i z powrotem na Wysyłam z Allegro), z jawnym zdaniem o koszcie;
// - koszt wysyłki zapłacony przez klienta nie zmienia się sam (dopłata albo zwrot poza kartą; karta to mówi).
// Ślad: zdarzenie SPOSOB_WYSYLKI_ZMIENIONY w historii (przewoźnik i moduł przed i po, bez danych osobowych); wartości
// adresu i punktu tylko w dzienniku podglądów (poprawka adresu, `poprawDostawe`).
import type { Carrier, Channel, OrderStatus, PaymentState, Prisma, PrismaClient, ShippingModule } from '@prisma/client'
import { bramkaKarty } from '../karta/bramka'
import { BladPoprawki, daneUsuniete, PRZESYLKA_JEST, poprawDostawe, type PoprawkaDostawy } from '../klienci/poprawka'
import { daneKlienta } from '../klienci/odczyt'
import { CARRIER_LABEL } from '../panel/format'
import { lockOrder } from '../rdzen/przejscia'
import { NAZWA_MODULU, regulaDlaZamowienia } from '../rdzen/przewoznicy'
import { flagsOf } from '../rdzen/rezerwacja'
import { runTx } from '../rdzen/stan'
import type { Env } from '../sekrety'
import { moznaPoprawicAdres, przesylkaPodBlokada, STATUSY_NADANIA } from './nadanie'
import { KOD_PUNKTU_ORLEN_RE } from './orlenpaczka'
import { jestPobranie } from './przesylka'

export type RodzajDostawy = 'PUNKT' | 'ADRES' | 'ADRES_LUB_PUNKT' | 'ODBIOR' | 'Z_KANALU'

/** Czego przewoźnik potrzebuje od odbiorcy; null = nie da się go wybrać (bez przewoźnika, bez wysyłki). */
export function rodzajDostawy(c: Carrier): RodzajDostawy | null {
  switch (c) {
    case 'PACZKOMATY':
    case 'DPD_EMPIK':
    case 'ORLEN_PACZKA':
      return 'PUNKT'
    case 'INPOST_KURIER':
    case 'POCZTA_POLSKA':
      return 'ADRES'
    case 'DPD':
    case 'GLS':
      return 'ADRES_LUB_PUNKT'
    case 'OSOBISTY':
      return 'ODBIOR'
    case 'ALLEGRO':
      return 'Z_KANALU'
    default:
      return null
  }
}

/** Pobranie: Orlen Paczka wycofała je z API, moduł Poczty Polskiej go jeszcze nie obsługuje (lib/wysylka/*). */
export function obslugujePobranie(c: Carrier, m: ShippingModule): boolean {
  return c !== 'ORLEN_PACZKA' && m !== 'ORLEN_PACZKA' && m !== 'POCZTA_POLSKA'
}

export interface OpcjaWysylki {
  /** `PRZEWOZNIK:MODUL`, np. `DPD:DPD_BEZPOSREDNIO`. */
  klucz: string
  carrier: Carrier
  shippingModule: ShippingModule
  etykieta: string
  rodzaj: RodzajDostawy
  pobranie: boolean
}

export const kluczOpcji = (c: Carrier, m: ShippingModule): string => `${c}:${m}`

/** Usługi do wyboru z reguł firmy: kanał zamówienia albo każdy, bez „BRAK” i „bez wysyłki”, po jednej na przewoźnika i moduł. */
export function opcjeZRegul(reguly: readonly { priority: number; channel: Channel | null; carrier: Carrier; shippingModule: ShippingModule }[], channel: Channel): OpcjaWysylki[] {
  const out: OpcjaWysylki[] = []
  for (const r of [...reguly].sort((a, b) => a.priority - b.priority)) {
    if (r.channel && r.channel !== channel) continue
    const rodzaj = rodzajDostawy(r.carrier)
    if (!rodzaj) continue
    if (r.carrier === 'ALLEGRO' && channel !== 'ALLEGRO') continue
    const klucz = kluczOpcji(r.carrier, r.shippingModule)
    if (out.some((o) => o.klucz === klucz)) continue
    const modul = r.shippingModule === 'BRAK' ? 'bez nadawania z Kompletora' : NAZWA_MODULU[r.shippingModule]
    out.push({ klucz, carrier: r.carrier, shippingModule: r.shippingModule, etykieta: r.carrier === 'OSOBISTY' || modul === CARRIER_LABEL[r.carrier] ? CARRIER_LABEL[r.carrier] : `${CARRIER_LABEL[r.carrier]} (${modul})`, rodzaj, pobranie: obslugujePobranie(r.carrier, r.shippingModule) })
  }
  return out
}

const KOMUNIKAT_PUNKT_POPRZEDNI = 'Punkt odbioru jest od poprzedniego przewoźnika: wpisz albo wyszukaj punkt nowego przewoźnika (albo zostaw pole puste przy kurierze pod adres).'

/** Kod paczkomatu InPost (np. POZ08M, WAW93A: 3 litery, cyfry, do 4 liter), ten sam wzorzec co wyszukiwarka punktów (punkt-inpost.ts). */
const KOD_PACZKOMATU_RE = /^[A-Z]{3}\d{1,5}[A-Z]{0,4}$/i

/**
 * punkt, który po samym kodzie należy do innej sieci (paczkomat InPost dla DPD, GLS, Orlenu; punkt Orlen
 * Paczki dla innych), odrzucamy bez pytania przewoźnika. Kody nierozpoznane przechodzą (format sprawdza nadanie).
 */
function punktInnejSieci(na: Carrier, punkt: string): string | null {
  if (na !== 'PACZKOMATY' && KOD_PACZKOMATU_RE.test(punkt)) return `Punkt „${punkt}” wygląda jak kod paczkomatu InPost, a nowy przewoźnik go nie obsłuży: wpisz punkt nowego przewoźnika (albo zostaw pole puste przy kurierze pod adres).`
  if (na !== 'ORLEN_PACZKA' && KOD_PUNKTU_ORLEN_RE.test(punkt.toUpperCase())) return `Punkt „${punkt}” wygląda jak kod punktu Orlen Paczki, a nowy przewoźnik go nie obsłuży: wpisz punkt nowego przewoźnika.`
  return null
}

/**
 * Dane odbiorcy dla nowej usługi: `dane` = co zapisać (null = danych odbiorcy nie zmieniamy), `blad` = odmowa.
 * `stary` = przewoźnik i kod punktu sprzed zmiany (punkt innego przewoźnika nie przechodzi).
 */
export function sprawdzDaneDlaSposobu(na: Carrier, p: PoprawkaDostawy | null, stary: { carrier: Carrier | null; punkt: string | null }): { dane: PoprawkaDostawy | null } | { blad: string } {
  const rodzaj = rodzajDostawy(na)
  if (rodzaj === 'ODBIOR' || rodzaj === 'Z_KANALU') return { dane: null }
  if (!rodzaj) return { blad: 'Tego sposobu wysyłki nie da się wybrać.' }
  const pelnyAdres = !!(p?.ulica && p.kodPocztowy && p.miasto)
  if (!p) return { blad: rodzaj === 'PUNKT' ? 'Podaj punkt odbioru nowego przewoźnika.' : 'Podaj adres dostawy: ulica, kod pocztowy i miasto.' }
  const punkt = p.punkt?.trim() || null
  // kody punktów porównujemy bez względu na wielkość liter
  const punktPoprzedni = !!punkt && na !== stary.carrier && punkt.toUpperCase() === stary.punkt?.trim().toUpperCase()
  const innaSiec = punkt ? punktInnejSieci(na, punkt) : null
  if (rodzaj === 'PUNKT') {
    if (!punkt) return { blad: 'Podaj punkt odbioru nowego przewoźnika.' }
    if (punktPoprzedni) return { blad: KOMUNIKAT_PUNKT_POPRZEDNI }
    if (innaSiec) return { blad: innaSiec }
    return { dane: { ...p, punkt } }
  }
  // DPD i GLS zawsze z pełnym adresem (GLS ADE wymaga adresu także przy punkcie, lib/wysylka/gls.ts), punkt opcjonalny
  if (!pelnyAdres) return { blad: 'Podaj adres dostawy: ulica, kod pocztowy i miasto (kurier jedzie pod adres).' }
  if (rodzaj === 'ADRES') return { dane: { ...p, punkt: null } }
  if (punktPoprzedni) return { blad: KOMUNIKAT_PUNKT_POPRZEDNI }
  if (innaSiec) return { blad: innaSiec }
  return { dane: { ...p, punkt } }
}

/** Statusy, w których wolno zmienić sposób wysyłki: przed wysłaniem (nieopłacone też, bo klient zmienia zdanie wcześnie). */
const STATUSY_ZMIANY: readonly OrderStatus[] = ['NOWE', ...STATUSY_NADANIA]

export const PRZESYLKA_UTWORZONA = 'Przesyłka już jest utworzona: najpierw ją anuluj (przycisk przy przesyłce albo w panelu przewoźnika i „Rozstrzygnij ręcznie → nie powstała”), potem zmień sposób wysyłki.'
const KOSZT_KLIENTA = 'Koszt wysyłki zapłacony przez klienta nie zmienia się sam: dopłatę albo zwrot różnicy ustalasz z klientem poza kartą.'
const ALLEGRO_OGRANICZENIE =
  'Zamówienie z Allegro z dostawą Allegro: usługę Wysyłam z Allegro (np. paczkomat, One Box, kurier) wybrał kupujący i zmienia się ją w Allegro, nie w Kompletorze. Tu możesz przejść na przewoźnika z umowy firmy.'
const ALLEGRO_KOSZT = 'Paczka pójdzie przewoźnikiem z umowy firmy: koszt tej przesyłki rozliczasz z przewoźnikiem, poza Allegro.'
/** powrót na Wysyłam z Allegro, a w Kompletorze mógł zostać adres wpisany ręcznie. */
const ALLEGRO_POWROT = 'Wysyłam z Allegro nada paczkę na dane odbiorcy z zamówienia w Allegro: adres albo punkt poprawiony w Kompletorze do Allegro nie przechodzi (zmianę adresu robi kupujący albo obsługa w Allegro).'
const POBRANIE_ODBIOR = 'Zamówienie jest za pobraniem: przy odbiorze osobistym kwotę pobierasz od klienta przy wydaniu paczki (płatność przy odbiorze).'
const ZNACZNIK_PRZYWROCONY = 'Ten sposób wysyłki był już ustawiony: zapisany ponownie jako wybrany na karcie, nadanie użyje go wprost.'

interface ZamowienieZmiany {
  id: string
  channel: Channel
  channelAccountId: string
  status: OrderStatus
  carrier: Carrier | null
  shippingModule: ShippingModule | null
  paymentState: PaymentState
  paymentMethod: string
  flags: Prisma.JsonValue
  parentOrderId: string | null
  deliveryMethod: string | null
}

const POLA = { id: true, channel: true, channelAccountId: true, status: true, carrier: true, shippingModule: true, paymentState: true, paymentMethod: true, flags: true, parentOrderId: true, deliveryMethod: true } as const

async function regulyFirmy(db: PrismaClient) {
  return db.carrierRule.findMany({ orderBy: { priority: 'asc' }, select: { priority: true, channel: true, pattern: true, carrier: true, shippingModule: true } })
}

function powodStatusu(o: Pick<ZamowienieZmiany, 'status' | 'carrier'>): string | null {
  if (o.status === 'DO_WYJASNIENIA') return 'Zamówienie czeka na wyjaśnienie: przewoźnika wybierasz przy wyjaśnieniu.'
  if (!STATUSY_ZMIANY.includes(o.status)) return 'W tym statusie zamówienia sposobu wysyłki już się nie zmienia.'
  if (o.carrier === 'BEZ_WYSYLKI') return 'Zamówienie bez wysyłki (sama usługa, np. e-book).'
  return null
}

export interface StanZmianySposobu {
  /** null = wolno zmienić; inaczej powód nieaktywnego przycisku. */
  powod: string | null
  /** Klucz obecnej usługi (`PRZEWOZNIK:MODUL`). */
  obecna: string | null
  opcje: OpcjaWysylki[]
  /** Zdania do pokazania przy formularzu (koszt zapłacony przez klienta, ograniczenie Allegro, pobranie). */
  uwagi: string[]
  pobranie: boolean
  /** Blok nie ma sensu (zamówienie wysłane, anulowane, bez wysyłki albo czeka na wyjaśnienie): karta go nie pokazuje. */
  ukryj: boolean
}

/** Stan bloku „Zmień sposób wysyłki” na karcie (bez danych klienta). null = brak zamówienia. */
export async function stanZmianySposobu(db: PrismaClient, orderId: string, env: Env = process.env): Promise<StanZmianySposobu | null> {
  const o = await db.order.findUnique({ where: { id: orderId }, select: POLA })
  if (!o) return null
  const opcje = opcjeZRegul(await regulyFirmy(db), o.channel)
  const pobranie = jestPobranie(o)
  const uwagi = [KOSZT_KLIENTA]
  if (o.channel === 'ALLEGRO' && o.carrier === 'ALLEGRO') uwagi.unshift(ALLEGRO_OGRANICZENIE)
  if (pobranie) uwagi.push('Zamówienie za pobraniem: usługi bez pobrania są na liście, ale zmiana na nie zostanie odrzucona.')
  // paczki z podziału i dosłania to osobne zamówienia: zmiana dotyczy tylko tej paczki (paczka wydzielona po zmianie dziedziczy wybór)
  const rodzic = o.parentOrderId ?? orderId
  const inne = await db.order.count({ where: { OR: [{ id: rodzic }, { parentOrderId: rodzic }], NOT: { id: orderId } } })
  if (inne > 0) uwagi.push(`Zmiana dotyczy tylko tej paczki. Pozostałe paczki tego zamówienia (${inne}) zostają przy swoim przewoźniku: zmieniasz je na ich kartach.`)
  const status = powodStatusu(o)
  const b = await bramkaKarty(db, orderId, async () => o, env)
  const powod = !b.ok ? b.blad : (status ?? ((await moznaPoprawicAdres(db, orderId)) ? null : PRZESYLKA_UTWORZONA))
  return { powod, obecna: o.carrier && o.shippingModule ? kluczOpcji(o.carrier, o.shippingModule) : null, opcje, uwagi, pobranie, ukryj: status !== null }
}

/** Znacznik wyboru na karcie atomowo (jsonb ||), bez nadpisywania innych flag; wołany pod blokadą zamówienia. */
async function ustawZnacznik(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
  await tx.$executeRaw`UPDATE "Order" SET flags = (CASE WHEN jsonb_typeof(flags) = 'object' THEN flags ELSE '{}'::jsonb END) || jsonb_build_object('przewoznikRecznie', true) WHERE id = ${orderId}`
}

export type WynikZmianySposobu = { wynik: 'ZAPISANO'; info: string | null } | { wynik: 'BEZ_ZMIAN' } | { wynik: 'ODMOWA'; powod: string }

/**
 * Zmiana sposobu wysyłki zamówienia `orderId` przez osobę `actorId` (User.id z sesji; uprawnienie do pełnych danych
 * klienta sprawdza odczyt w `poprawDostawe` i tu przy odczycie punktu). `dostawa` = formularz odbiorcy (adres, punkt);
 * dla odbioru osobistego i Wysyłam z Allegro nieużywany.
 */
export async function zmienSposobWysylki(
  db: PrismaClient,
  orderId: string,
  z: { klucz: string; dostawa: PoprawkaDostawy | null; zrodloPunktu?: 'FORMULARZ' | 'WYSZUKIWARKA' },
  o: { actorId: string; env?: Env; now?: Date },
): Promise<WynikZmianySposobu> {
  const env = o.env ?? process.env
  const b = await bramkaKarty(db, orderId, (id) => db.order.findUnique({ where: { id }, select: POLA }), env)
  if (!b.ok) return { wynik: 'ODMOWA', powod: b.blad }
  const zam: ZamowienieZmiany = b.o
  const st = powodStatusu(zam)
  if (st) return { wynik: 'ODMOWA', powod: st }
  const reguly = await regulyFirmy(db)
  const opcja = opcjeZRegul(reguly, zam.channel).find((x) => x.klucz === z.klucz)
  if (!opcja) return { wynik: 'ODMOWA', powod: 'Tego sposobu wysyłki nie ma w ustawieniach przewoźników firmy dla tego zamówienia (Ustawienia → Wysyłka i druk → Przewoźnicy).' }
  if (zam.carrier && zam.shippingModule && kluczOpcji(zam.carrier, zam.shippingModule) === opcja.klucz) {
    // ten sam sposób = bez zmian, chyba że nadanie wybrałoby go tylko ze znacznikiem, a znacznika nie ma
    // (zgubiony): wtedy dopisujemy sam znacznik, pod tymi samymi blokadami co zmiana
    const zMetody = regulaDlaZamowienia(reguly, { channel: zam.channel, carrier: zam.carrier, metodaDostawy: zam.deliveryMethod, shippingModule: zam.shippingModule }).regula
    if (flagsOf(zam).przewoznikRecznie || zMetody) return { wynik: 'BEZ_ZMIAN' }
    const przywrocono = await runTx(db, async (tx) => {
      await przesylkaPodBlokada(tx, orderId)
      const teraz = await lockOrder(tx, orderId)
      if (teraz.carrier !== zam.carrier || teraz.shippingModule !== zam.shippingModule) return false
      await ustawZnacznik(tx, orderId)
      return true
    })
    return przywrocono ? { wynik: 'ZAPISANO', info: ZNACZNIK_PRZYWROCONY } : { wynik: 'ODMOWA', powod: 'Sposób wysyłki zmienił się w międzyczasie: odśwież kartę i spróbuj ponownie.' }
  }
  if (!(await moznaPoprawicAdres(db, orderId))) return { wynik: 'ODMOWA', powod: PRZESYLKA_UTWORZONA }
  if (jestPobranie(zam) && !opcja.pobranie) return { wynik: 'ODMOWA', powod: `„${opcja.etykieta}” nie obsługuje pobrania, a zamówienie jest za pobraniem: wybierz usługę z pobraniem albo najpierw zmień płatność.` }

  // punkt sprzed zmiany (do odmowy „punkt poprzedniego przewoźnika”); odczyt z celem POPRAWKA jak przy poprawce adresu
  let staryPunkt: string | null = null
  const potrzebneDane = opcja.rodzaj !== 'ODBIOR' && opcja.rodzaj !== 'Z_KANALU'
  if (potrzebneDane) {
    const d = await daneKlienta(db, orderId, { actorId: o.actorId, zakres: 'PELNY', cel: 'POPRAWKA', env })
    if (d.stan === 'BEZ_UPRAWNIEN' || d.stan === 'SKROT') return { wynik: 'ODMOWA', powod: 'Zmiana sposobu wysyłki wymaga uprawnienia do pełnych danych klientów.' }
    if (d.stan === 'USUNIETE') return { wynik: 'ODMOWA', powod: 'Dane klienta tego zamówienia zostały usunięte.' }
    if (d.stan === 'BRAK_KLUCZA' || d.stan === 'BLAD_SZYFRU') return { wynik: 'ODMOWA', powod: 'Dane klienta niedostępne: brak klucza szyfrowania' }
    staryPunkt = d.stan === 'PELNY' ? (d.rekord.punktOdbioru?.kod ?? null) : null
  }
  const spr = sprawdzDaneDlaSposobu(opcja.carrier, z.dostawa, { carrier: zam.carrier, punkt: staryPunkt })
  if ('blad' in spr) return { wynik: 'ODMOWA', powod: spr.blad }

  const actorId = o.actorId.startsWith('user:') ? o.actorId : `user:${o.actorId}`
  const przed = { carrier: zam.carrier, shippingModule: zam.shippingModule }
  /**
   * Zapis zamówienia w transakcji pod blokadą przesyłki (blokadę i sprawdzenie przesyłki robi wywołujący).
   * najpierw blokada zamówienia (jak każdy zapis flag w rdzeniu), status, przewoźnik i moduł z odczytu pod nią.
   * Kolejność blokad: klient → przesyłka → zamówienie (żadna transakcja nie bierze ich odwrotnie).
   */
  const zapiszZamowienie = async (tx: Prisma.TransactionClient) => {
    const teraz = await lockOrder(tx, orderId)
    // równoległa zmiana albo przejście statusu między odczytem a blokadą: odmowa, nic nie zapisane
    if (teraz.carrier !== przed.carrier || teraz.shippingModule !== przed.shippingModule) throw new BladPoprawki('Sposób wysyłki zmienił się w międzyczasie: odśwież kartę i spróbuj ponownie.')
    if (!STATUSY_ZMIANY.includes(teraz.status)) throw new BladPoprawki('W tym statusie zamówienia sposobu wysyłki już się nie zmienia.')
    if (potrzebneDane && (await daneUsuniete(tx, orderId))) throw new BladPoprawki('Dane klienta tego zamówienia zostały usunięte.')
    // status firmy przypisany wprost, ograniczony do przewoźników bez nowego, nie pasuje już do zamówienia:
    // przypisanie zdjęte, nazwę statusu dobiera lista statusów firmy po nowym przewoźniku (wybierzStatusFirmy)
    let zdejmijStatus = false
    if (teraz.companyStatus) {
      const def = await tx.orderStatusDef.findFirst({ where: { key: teraz.companyStatus }, select: { carriers: true } })
      zdejmijStatus = !!def && def.carriers.length > 0 && !def.carriers.includes(opcja.carrier)
    }
    await tx.order.update({ where: { id: orderId }, data: { carrier: opcja.carrier, shippingModule: opcja.shippingModule, ...(zdejmijStatus ? { companyStatus: null } : {}) } })
    await ustawZnacznik(tx, orderId)
    await tx.orderEvent.create({
      data: { orderId, kind: 'SPOSOB_WYSYLKI_ZMIENIONY', actorId, data: { z: przed.carrier, zModulu: przed.shippingModule, na: opcja.carrier, naModul: opcja.shippingModule, pobranie: jestPobranie(zam) } },
    })
  }

  try {
    let zapisane = false
    if (spr.dane) {
      const w = await poprawDostawe(db, orderId, spr.dane, { actorId: o.actorId, env, now: o.now, zrodloPunktu: z.zrodloPunktu, wTransakcji: zapiszZamowienie })
      if (w.wynik === 'ODMOWA') return w
      zapisane = w.wynik === 'ZAPISANO'
    }
    if (!zapisane) {
      // dane odbiorcy bez zmian (albo nieużywane): sam zapis zamówienia pod tą samą blokadą przesyłki
      await runTx(db, async (tx) => {
        if (await przesylkaPodBlokada(tx, orderId)) throw new BladPoprawki(PRZESYLKA_JEST)
        await zapiszZamowienie(tx)
      })
    }
  } catch (e) {
    if (e instanceof BladPoprawki) return { wynik: 'ODMOWA', powod: e.message === PRZESYLKA_JEST ? PRZESYLKA_UTWORZONA : e.message }
    throw e
  }
  const info = [
    zam.channel === 'ALLEGRO' && przed.carrier === 'ALLEGRO' && opcja.carrier !== 'ALLEGRO' ? ALLEGRO_KOSZT : null,
    opcja.carrier === 'ALLEGRO' && przed.carrier !== 'ALLEGRO' ? ALLEGRO_POWROT : null,
    opcja.carrier === 'OSOBISTY' && jestPobranie(zam) ? POBRANIE_ODBIOR : null,
    KOSZT_KLIENTA,
  ]
    .filter(Boolean)
    .join(' ')
  return { wynik: 'ZAPISANO', info: info || null }
}

