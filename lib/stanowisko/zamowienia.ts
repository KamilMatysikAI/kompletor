// Zamówienia na stanowisku pakowania i na karcie: pozycje do zebrania (zestaw rozbity na składniki,
// po lokalizacji), numer i kod karty, tryb konta kanału. Tylko odczyt. Klient bazy firmy z sesji (RLS) —
// klienta systemowego funkcje odmawiają (`organizationIdOf` rzuca błąd).
// Danych osobowych nie ma: Order ich nie trzyma, więc komentarza klienta i odbiorcy też nie — ekran i karta
// mówią „brak w danych cienia” zamiast dokładać je do bazy.
import type { Carrier, Channel, ChannelMode, OrderStatus, PrismaClient, ShippingModule, Unit } from '@prisma/client'
import { koszykiZamowien } from '../koszyki/koszyki'
import { glowneZdjecia } from '../produkty/zdjecia'
import { organizationIdOf } from '@/lib/db'
import { accountDisplayName, CARRIER_LABEL, channelPrefix, shortExternalId } from '@/lib/panel/format'
import { flagsOf } from '@/lib/rdzen/rezerwacja'
import { numerZamowieniaTekst, sortujPoLokalizacji, type NumerZamowienia } from '@/lib/wydruki'
import { kodZamowieniaKarty, numerKartyZamowienia } from './kod'
import { MAX_ZAMOWIEN } from './stale'

export { MAX_ZAMOWIEN }

type Db = PrismaClient

/** pola karty produktu do podpowiedzi wagi i gabarytu paczki. */
const POLA_PACZKI = { weightG: true, lengthCm: true, widthCm: true, heightCm: true } as const

type Wymiar = { toNumber(): number } | number | null
/** Waga i wymiary sztuki z karty produktu; wymiary tylko komplet trzech dodatnich. */
export function paczka(p: { weightG: number | null; lengthCm: Wymiar; widthCm: Wymiar; heightCm: Wymiar } | undefined): { wagaSztukiG: number | null; wymiaryCm: [number, number, number] | null } {
  if (!p) return { wagaSztukiG: null, wymiaryCm: null }
  const n = (v: Wymiar) => (v === null ? null : typeof v === 'number' ? v : v.toNumber())
  const w = [n(p.lengthCm), n(p.widthCm), n(p.heightCm)]
  const wymiaryCm = w.every((x) => x !== null && Number.isFinite(x) && x > 0) ? (w as [number, number, number]) : null
  return { wagaSztukiG: p.weightG !== null && p.weightG > 0 ? p.weightG : null, wymiaryCm }
}

/** Lista id zamówień z parametru `z` (kontrakt: id `Order` rozdzielone przecinkami). */
export function idZamowien(z: string | string[] | null | undefined): string[] {
  const tekst = Array.isArray(z) ? z.join(',') : (z ?? '')
  const out: string[] = []
  for (const s of tekst.split(',')) {
    const id = s.trim()
    if (/^[a-z0-9]{1,40}$/i.test(id) && !out.includes(id)) out.push(id)
  }
  return out
}

export interface PozycjaZbierania {
  /** Klucz pozycji na ekranie i w ćwiczeniu: `<orderLineId>:<productId>` (zestaw = kilka składników jednej pozycji). */
  klucz: string
  orderLineId: string
  productId: string | null
  nazwa: string
  /** Np. „z zestawu Zestaw prezentowy” — składnik zestawu. */
  dopisek: string | null
  sku: string | null
  lokalizacja: string | null
  ilosc: number
  jednostka: 'szt' | 'g'
  /** główne zdjęcie produktu (id do /api/produkty/zdjecia/<id>); brak = zaślepka. */
  zdjecie?: string | null
  /** waga jednej sztuki z karty produktu (g); podpowiedź wagi paczki. */
  wagaSztukiG?: number | null
  /** wymiary jednej sztuki z karty produktu (dł., szer., wys. w cm); podpowiedź gabarytu. */
  wymiaryCm?: [number, number, number] | null
}

/** Pozycja (albo jej część), której system nie ma do wydania: otwarty brak. Na ekranie i karcie na czerwono, nie do zebrania. */
export interface BrakujacaPozycja {
  klucz: string
  orderLineId: string
  nazwa: string
  dopisek: string | null
  sku: string | null
  ilosc: number
  jednostka: 'szt' | 'g'
}

export interface ZamowienieStanowiska {
  id: string
  channel: Channel
  channelAccountId: string
  /** Numer do wyświetlenia jak na karcie („SD 48213”, dosyłka „SD 48213-2”), bez numeru liczbowego — jak w panelu. */
  numer: string
  /** Numer i przedrostek do kodu karty; null = zamówienie bez numeru liczbowego (Allegro przed porównaniem z BL). */
  numerKarty: NumerZamowienia | null
  kodZamowienia: string | null
  /** Tryb statusów konta kanału: CIEN = ćwiczenie na sucho, PRACA = ścieżka „naprawdę”. */
  tryb: ChannelMode
  kanal: string
  status: OrderStatus
  carrier: Carrier | null
  przewoznik: string
  metodaDostawy: string | null
  /** moduł wysyłki zapisany przy przyjęciu (wybór reguły przy nadaniu i podglądzie). */
  shippingModule: ShippingModule | null
  /** Sposób wysyłki zmieniony na karcie (flaga zamówienia): reguła przewoźnika jak przy wyborze wprost. */
  przewoznikRecznie: boolean
  dataZamowienia: Date
  /** Komentarz klienta i uwagi biura: tylko gdy system je ma (w cieniu nie ma — null). */
  komentarzKlienta: string | null
  uwagiBiura: string | null
  doWyjasnienia: string | null
  /** Edycja z kanału po wydruku (flaga rdzenia): spakować można dopiero z nowej karty. */
  kartaNieaktualna: boolean
  /** Otwarte braki („brakuje”, dośle później, do zwrotu) albo flaga „brakuje”. */
  maBrak: boolean
  /** Czego nie ma do wydania. `pozycje` to wyłącznie towar do zebrania: ilości po odjęciu tych braków. */
  brakujace: BrakujacaPozycja[]
  /** Obsługa zdecydowała „poczekaj na towar”: bez pakowania, dopóki decyzja trwa, a brak jest otwarty. */
  czekaNaTowar: boolean
  /** Same produkty bez stanu (DIGITAL, e-book) — nie ma czego zbierać ani pakować. */
  tylkoBezStanu: boolean
  /** pozycje z produktami bez stanu (e-book): poza zbieraniem, ale na wydruku informacyjnym. */
  pozycjeBezStanu: BrakujacaPozycja[]
  pozycje: PozycjaZbierania[]
  /** Migawka pozycji do rejestru wydruku (porównanie „karta nieaktualna”). */
  migawka: MigawkaPozycji[]
  /** koszyk, w którym leży zamówienie (nazwa, np. „B”); null = bez koszyka. */
  koszyk: string | null
}

export interface MigawkaPozycji {
  l: string
  p: string | null
  q: number
  /** Brakująca część pozycji w chwili migawki; pole opcjonalne, wydruki go nie mają (= 0). */
  b?: number
}

const OPEN_SHORTAGE = ['OPEN', 'SHIP_LATER', 'REFUND_PENDING'] as const
/** Braki, które pomniejszają paczkę: towaru nie ma do wydania (REFUND_PENDING powstaje dopiero po spakowaniu). */
const BRAK_DO_WYDANIA: readonly string[] = ['OPEN', 'SHIP_LATER']

/** Pozycje zamówienia w postaci do porównania: bez usuniętych, ilość po odrzuceniu, stała kolejność. */
export function migawkaPozycji(
  lines: { id: string; productId: string | null; qty: number; qtyRejected: number; removed: boolean }[],
  braki: ReadonlyMap<string, number> = new Map(),
): MigawkaPozycji[] {
  return lines
    .filter((l) => !l.removed)
    .map((l) => ({ l: l.id, p: l.productId, q: l.qty - l.qtyRejected, ...(braki.get(l.id) ? { b: braki.get(l.id) } : {}) }))
    .filter((l) => l.q > 0)
    .sort((a, b) => (a.l < b.l ? -1 : a.l > b.l ? 1 : 0))
}

export function takaSamaMigawka(a: unknown, b: MigawkaPozycji[]): boolean {
  if (!Array.isArray(a) || a.length !== b.length) return false
  const s = [...(a as MigawkaPozycji[])].sort((x, y) => (x.l < y.l ? -1 : x.l > y.l ? 1 : 0))
  return s.every((x, i) => x && x.l === b[i]!.l && (x.p ?? null) === b[i]!.p && x.q === b[i]!.q && (x.b ?? 0) === (b[i]!.b ?? 0))
}

/**
 * Czy różnica między kartą a zamówieniem to tylko skutek braku, czyli karta nadal mówi prawdę o tym, co zebrać (
 * integracja). Tak, gdy na żadnej pozycji do zebrania nie przybyło, nie doszła nowa pozycja ani inny produkt, a
 * ubyło wyłącznie na pozycjach z brakiem zgłoszonym na stanowisku (`zgloszone`, id pozycji). Przeniesienie braku bez
 * zmiany reszty („dośle”) też się liczy. Reszta = `q − b`; przy zestawie to wielkość tylko do porównań, a dosłanie zestawu
 * z karty wydrukowanej już z brakiem wymaga nowej karty (bezpieczna strona).
 */
export function tylkoSkutkiBraku(wydruk: unknown, teraz: MigawkaPozycji[], zgloszone: ReadonlySet<string>, dolozone: ReadonlySet<string> = new Set()): boolean {
  if (!Array.isArray(wydruk)) return false
  const karta = wydruk as MigawkaPozycji[]
  const reszta = (m: MigawkaPozycji) => m.q - (m.b ?? 0)
  const naKarcie = new Map(karta.map((m) => [m.l, m]))
  for (const t of teraz) {
    const k = naKarcie.get(t.l)
    if (!k || (k.p ?? null) !== t.p) return false
    // brak zamknięty „Jednak jest w paczce” przybliża resztę do ilości z karty (karta ma pełną ilość zamówioną)
    const wrocilDoKarty = dolozone.has(t.l) && t.q === k.q && reszta(t) <= k.q
    if ((reszta(t) > reszta(k) && !wrocilDoKarty) || (reszta(t) < reszta(k) && !zgloszone.has(t.l))) return false
  }
  const obecne = new Set(teraz.map((t) => t.l))
  return karta.every((k) => obecne.has(k.l) || zgloszone.has(k.l) || reszta(k) <= 0)
}

/** Id z kanału bez numeru liczbowego (Empik z sufiksem): w całości, skrócony tylko UUID Allegro (uwaga właściciela 28.10). */
const numerEkranowy = (id: string) => (id.length > 24 ? shortExternalId(id) : id)

const jednostka = (u: Unit): 'szt' | 'g' => (u === 'KG' ? 'g' : 'szt')

/**
 * Zamówienia o podanych id w kolejności wejścia (brakujące — innej firmy albo nieistniejące — pominięte, bez
 * informacji, że istnieją).
 */
export async function wczytajZamowienia(db: Db, ids: string[]): Promise<ZamowienieStanowiska[]> {
  organizationIdOf(db)
  if (!ids.length) return []
  const orders = await db.order.findMany({
    where: { id: { in: ids.slice(0, MAX_ZAMOWIEN) } },
    include: {
      lines: { orderBy: { createdAt: 'asc' } },
      shortages: { where: { state: { in: [...OPEN_SHORTAGE] } }, select: { state: true, orderLineId: true, productId: true, qtyBase: true } },
      shortageDecisions: { where: { action: 'POCZEKAJ' }, select: { orderLineId: true, dryRun: true } },
    },
  })
  if (!orders.length) return []
  const parentIds = [...new Set(orders.map((o) => o.parentOrderId).filter((x): x is string => !!x))]
  const parents = parentIds.length
    ? await db.order.findMany({ where: { id: { in: parentIds } }, select: { id: true, externalId: true, blOrderId: true, channel: true, channelAccountId: true } })
    : []
  const numberSource = [...orders, ...parents]
  const [configs, snaps] = await Promise.all([
    db.channelConfig.findMany({ select: { channel: true, channelAccountId: true, name: true, config: true, statusMode: true } }),
    db.channelOrderSnapshot.findMany({
      where: { OR: numberSource.map((o) => ({ channel: o.channel, channelAccountId: o.channelAccountId, externalId: o.externalId })) },
      select: { channel: true, channelAccountId: true, externalId: true, channelNumber: true, blOrderId: true },
    }),
  ])
  const key = (c: string, a: string, e = '') => `${c}|${a}|${e}`
  const cfg = new Map(configs.map((c) => [key(c.channel, c.channelAccountId), c]))
  const snap = new Map(snaps.map((s) => [key(s.channel, s.channelAccountId, s.externalId), s]))
  const parentOf = new Map(parents.map((p) => [p.id, p]))

  // produkty pozycji i składniki zestawów
  const lineProductIds = [...new Set(orders.flatMap((o) => o.lines.map((l) => l.productId).filter((x): x is string => !!x)))]
  const prods = await db.product.findMany({
    where: { id: { in: lineProductIds } },
    select: { id: true, kind: true, title: true, sku: true, unit: true, ...POLA_PACZKI, bundleComponents: { select: { componentId: true, qtyBase: true } } },
  })
  const compIds = [...new Set(prods.flatMap((p) => (p.kind === 'BUNDLE' ? p.bundleComponents.map((c) => c.componentId) : [])))]
  const comps = compIds.length ? await db.product.findMany({ where: { id: { in: compIds } }, select: { id: true, kind: true, title: true, sku: true, unit: true, ...POLA_PACZKI } }) : []
  const lineProd = new Map(prods.map((p) => [p.id, p]))
  const prod = new Map([...prods, ...comps].map((p) => [p.id, p]))
  const stocks = await db.stock.findMany({ where: { productId: { in: [...prod.keys()] }, location: { not: null } }, select: { productId: true, location: true } })
  const loc = new Map<string, string>()
  for (const s of stocks) if (s.location?.trim() && !loc.has(s.productId)) loc.set(s.productId, s.location.trim())
  const zdj = await glowneZdjecia(db, [...prod.keys()]) // miniatury na stanowisku i karcie zbierania
  const koszyki = await koszykiZamowien(db, orders.map((o) => o.id))

  const byId = new Map(orders.map((o) => [o.id, o]))
  const out: ZamowienieStanowiska[] = []
  for (const id of ids) {
    const o = byId.get(id)
    if (!o) continue
    const c = cfg.get(key(o.channel, o.channelAccountId))
    const kanal = accountDisplayName(o.channel, o.channelAccountId, c?.name, c?.config)
    const parent = o.parentOrderId ? parentOf.get(o.parentOrderId) : undefined
    const base = parent ?? o
    const s = snap.get(key(base.channel, base.channelAccountId, base.externalId))
    const podzamowienie = parent ? o.packageNo : null
    let numerKarty = numerKartyZamowienia({
      channel: o.channel,
      nazwaKonta: kanal,
      numerZrodlowy: { externalId: base.externalId, channelNumber: s?.channelNumber, blOrderId: base.blOrderId ?? s?.blOrderId },
      podzamowienie,
    })
    let kodZamowienia: string | null = null
    if (numerKarty) {
      try {
        kodZamowienia = kodZamowieniaKarty(numerKarty)
      } catch {
        numerKarty = null
      }
    }

    // otwarte braki per pozycja i produkt (składnik zestawu): tego nie ma do zebrania
    const brakPoz = new Map<string, number>()
    const brakLinii = new Map<string, number>()
    for (const s of o.shortages) {
      if (!BRAK_DO_WYDANIA.includes(s.state)) continue
      brakPoz.set(`${s.orderLineId}:${s.productId}`, (brakPoz.get(`${s.orderLineId}:${s.productId}`) ?? 0) + s.qtyBase)
      brakLinii.set(s.orderLineId, (brakLinii.get(s.orderLineId) ?? 0) + s.qtyBase)
    }
    const pozycje: PozycjaZbierania[] = []
    const brakujace: BrakujacaPozycja[] = []
    /** Pozycja podzielona: reszta do zebrania i brakująca część osobno. */
    const dodaj = (p: PozycjaZbierania) => {
      const brak = Math.min(brakPoz.get(p.klucz) ?? 0, p.ilosc)
      if (brak) brakujace.push({ klucz: p.klucz, orderLineId: p.orderLineId, nazwa: p.nazwa, dopisek: p.dopisek, sku: p.sku, ilosc: brak, jednostka: p.jednostka })
      if (p.ilosc > brak) pozycje.push({ ...p, ilosc: p.ilosc - brak })
    }
    const pozycjeBezStanu: BrakujacaPozycja[] = []
    for (const l of o.lines) {
      const q = l.qty - l.qtyRejected
      if (l.removed || q <= 0) continue
      const p = l.productId ? lineProd.get(l.productId) : undefined
      if (!p) {
        pozycje.push({ klucz: `${l.id}:`, orderLineId: l.id, productId: null, nazwa: 'Pozycja bez powiązania z produktem', dopisek: null, sku: null, lokalizacja: null, ilosc: q, jednostka: 'szt' })
        continue
      }
      // produkt bez stanu (e-book): bez rezerwacji, nie do zebrania — poza kartą i oknem pakowania
      if (p.kind === 'DIGITAL') {
        pozycjeBezStanu.push({ klucz: `${l.id}:${p.id}`, orderLineId: l.id, nazwa: p.title, dopisek: null, sku: p.sku, ilosc: q, jednostka: jednostka(p.unit) })
        continue
      }
      if (p.kind === 'BUNDLE' && p.bundleComponents.length) {
        for (const bc of p.bundleComponents) {
          const cp = prod.get(bc.componentId)
          dodaj({
            klucz: `${l.id}:${bc.componentId}`,
            orderLineId: l.id,
            productId: bc.componentId,
            nazwa: cp?.title ?? 'Składnik zestawu',
            dopisek: `z zestawu ${p.title}`,
            sku: cp?.sku ?? null,
            lokalizacja: loc.get(bc.componentId) ?? null,
            ilosc: q * bc.qtyBase,
            jednostka: jednostka(cp?.unit ?? 'SZT'),
            ...paczka(cp),
          })
        }
        continue
      }
      dodaj({ klucz: `${l.id}:${p.id}`, orderLineId: l.id, productId: p.id, nazwa: p.title, dopisek: null, sku: p.sku, lokalizacja: loc.get(p.id) ?? null, ilosc: q, jednostka: jednostka(p.unit), ...paczka(p) })
    }

    out.push({
      id: o.id,
      channel: o.channel,
      channelAccountId: o.channelAccountId,
      numer: numerZamowieniaTekst(numerKarty ?? { przedrostek: channelPrefix(o.channel, kanal), numer: numerEkranowy(base.externalId), podzamowienie }),
      numerKarty,
      kodZamowienia,
      // konto bez konfiguracji traktujemy jak cień: niczego nie zapisujemy w kanale, więc to bezpieczna strona
      tryb: c?.statusMode ?? 'CIEN',
      kanal,
      status: o.status,
      carrier: o.carrier,
      przewoznik: o.carrier ? CARRIER_LABEL[o.carrier] : 'przewoźnik nieustalony',
      metodaDostawy: o.deliveryMethod,
      shippingModule: o.shippingModule ?? null,
      przewoznikRecznie: flagsOf(o).przewoznikRecznie === true,
      dataZamowienia: o.createdAtChannel,
      komentarzKlienta: null,
      uwagiBiura: null,
      doWyjasnienia: flagsOf(o).doWyjasnienia ?? null,
      kartaNieaktualna: flagsOf(o).kartaNieaktualna === true,
      maBrak: o.shortages.length > 0 || flagsOf(o).brakuje === true,
      brakujace,
      // w cieniu decyzja obowiązuje do jej zmiany (brak z „na półce nie było” nie jest wierszem Shortage), w PRACY do przydziału
      czekaNaTowar: o.shortageDecisions.some((d) => d.dryRun || o.shortages.some((s) => s.state === 'OPEN' && s.orderLineId === d.orderLineId)),
      tylkoBezStanu: pozycje.length === 0 && brakujace.length === 0 && pozycjeBezStanu.length > 0,
      pozycjeBezStanu,
      pozycje: sortujPoLokalizacji(pozycje.map((p) => ({ ...p, zdjecie: p.productId ? (zdj.get(p.productId) ?? null) : null }))),
      migawka: migawkaPozycji(o.lines, brakLinii),
      koszyk: koszyki.get(o.id) ?? null,
    })
  }
  return out
}
