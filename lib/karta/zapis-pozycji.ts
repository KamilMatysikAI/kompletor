// Jeden zapis sekcji „Pozycje” karty zamówienia: nowe ilości, usunięcie pozycji i decyzje o brakach
// towaru z jednego formularza (PasekZapisu). Każda zmiana idzie tą samą drogą co pojedyncze akcje dotąd
// (`zmienIlosc`, `usunPozycje` z bramką trybu PRACA i rdzeniem, `zdecydujOBraku`), osobno i z własną obsługą błędu:
// jedna odrzucona pozycja nie blokuje reszty, a wynik mówi, ile zmian się zapisało i co odrzucono.
// Pozycje spoza zamówienia z adresu są pomijane (decyzja o braku bierze pozycję po id, więc bez tej kontroli dałoby
// się rozstrzygnąć pozycję innego zamówienia tej samej firmy). Nic nie idzie do kanału.
import type { PrismaClient } from '@prisma/client'
import { BladStanowiska } from '@/lib/stanowisko/cwiczenie'
import { DECYZJE, zdecydujOBraku } from '@/lib/stanowisko/decyzje'
import { ID_RE } from './bramka'
import { cenaZTekstu, grosze, KOMUNIKAT_KONFLIKT_POZYCJI, type NowaCena, normalizujStawke, powodDokumentuLubPrzesylki } from '@/lib/rdzen/edycja'
import { BEZ_UPRAWNIENIA, bramkaEdycji, usunPozycjePoBramce, type WynikKarty, type ZlecenieEdycji, zmienCenePoBramce, zmienIloscPoBramce } from './pozycje'

type Db = PrismaClient
type Env = Record<string, string | undefined>

export interface ZmianaPozycji {
  lineId: string
  /** Nowa ilość z pola (tekst z formularza); brak = bez zmiany ilości. */
  ilosc?: string
  usun?: boolean
  /** Decyzja o braku (ShortageAction); brak albo pusta = bez decyzji. */
  decyzja?: string
  /** SKU zamiennika przy „Zamień produkt”. */
  sku?: string
  /** cena brutto za sztukę (tekst z pola); brak albo pusta = bez zmiany. */
  cena?: string
  /** stawka VAT; brak albo pusta = bez zmiany. */
  vat?: string
  /**
   * ilość, cena i stawka z chwili renderu karty (ukryte `*_bylo_<id>`). Zmiana liczy się
   * względem tego, co osoba widziała; gdy w bazie jest już coś innego, ktoś zmienił pozycję w międzyczasie i zapis tej
   * części jest odrzucany zamiast cicho cofnąć cudzą zmianę. Brak = porównanie z bazą (stare formularze, testy).
   */
  iloscBylo?: string
  cenaBylo?: string
  vatBylo?: string
}

const MAKS_POZYCJI = 200
const POLE = /^(ilosc|usun|decyzja|sku|cena|vat)(_bylo)?_([a-z0-9]{1,40})$/i

/**
 * Zmiany z pól formularza `ilosc_<id>`, `usun_<id>`, `decyzja_<id>`, `sku_<id>`, `cena_<id>`, `vat_<id>` oraz
 * `ilosc_bylo_<id>`, `cena_bylo_<id>`, `vat_bylo_<id>` (reszta pól pominięta).
 */
export function zmianyZFormularza(form: { entries(): IterableIterator<[string, FormDataEntryValue]> } | Iterable<[string, unknown]>): ZmianaPozycji[] {
  const mapa = new Map<string, ZmianaPozycji>()
  const wpisy = 'entries' in form && typeof form.entries === 'function' ? form.entries() : (form as Iterable<[string, unknown]>)
  for (const [k, v] of wpisy as Iterable<[string, unknown]>) {
    const m = POLE.exec(k)
    if (!m || typeof v !== 'string') continue
    const lineId = m[3]!
    if (!mapa.has(lineId)) {
      if (mapa.size >= MAKS_POZYCJI) continue
      mapa.set(lineId, { lineId })
    }
    const z = mapa.get(lineId)!
    const pole = m[1]!.toLowerCase()
    if (m[2]) {
      if (pole === 'ilosc') z.iloscBylo = v.trim().slice(0, 12)
      else if (pole === 'cena') z.cenaBylo = v.trim().slice(0, 16)
      else if (pole === 'vat') z.vatBylo = v.trim().slice(0, 8)
      continue
    }
    if (pole === 'ilosc') z.ilosc = v.trim().slice(0, 12)
    else if (pole === 'usun') z.usun = v === 'tak'
    else if (pole === 'decyzja') z.decyzja = v.trim().slice(0, 40)
    else if (pole === 'cena') z.cena = v.trim().slice(0, 16)
    else if (pole === 'vat') z.vat = v.trim().slice(0, 8)
    else z.sku = v.trim().slice(0, 100)
  }
  return [...mapa.values()]
}

export interface WynikZapisuPozycji extends WynikKarty {
  zapisane: number
  odrzucone: number
}

/**
 * Zapisuje zmiany sekcji „Pozycje”. `tylkoDecyzje` = osoba bez edycji pozycji (pola ilości, usunięcia, ceny i VAT
 * pomijane). Ilość, cena i stawka równe obecnym oraz decyzja równa zapisanej nie liczą się jako zmiana.
 * bramka edycji (uprawnienie, tryb PRACA, ustawienie firmy) raz przed pętlą, nie per pozycja;
 * rdzeń i tak sprawdza status zamówienia pod blokadą przy każdej zmianie. Odmowa bramki odrzuca zmiany pozycji jednym
 * komunikatem, decyzje o brakach idą dalej (mają własne uprawnienie).
 */
export async function zapiszPozycje(db: Db, z: ZlecenieEdycji & { zmiany: ZmianaPozycji[]; tylkoDecyzje?: boolean }, env: Env = process.env): Promise<WynikZapisuPozycji> {
  const orderId = String(z.orderId ?? '')
  if (!ID_RE.test(orderId)) return { blad: 'Nie ma takiego zamówienia.', zmiana: false, zapisane: 0, odrzucone: 0 }
  const [linie, decyzje] = await Promise.all([
    db.orderLine.findMany({ where: { orderId }, select: { id: true, qty: true, removed: true, productId: true, channelSku: true, channelName: true, unitPriceGross: true, vatRate: true } }),
    db.shortageDecision.findMany({ where: { orderId }, select: { orderLineId: true, action: true } }),
  ])
  const linia = new Map(linie.map((l) => [l.id, l]))
  const decyzja = new Map(decyzje.map((d) => [d.orderLineId, d.action as string]))
  // komunikat błędu nazywa pozycję tak, jak widać ją w tabeli (SKU produktu, inaczej SKU albo
  // nazwa z kanału), a nie numerem na liście zmian, który nie odpowiada wierszom (nie każdy wiersz ma pola)
  const idProduktow = [...new Set(linie.map((l) => l.productId).filter((x): x is string => !!x))]
  const produkty = idProduktow.length ? await db.product.findMany({ where: { id: { in: idProduktow } }, select: { id: true, sku: true } }) : []
  const skuProduktu = new Map(produkty.map((x) => [x.id, x.sku]))
  const bledy: string[] = []
  let zapisane = 0

  const krok = async (opis: string, fn: () => Promise<WynikKarty | 'ok'>) => {
    try {
      const w = await fn()
      if (w === 'ok') zapisane++
      else if (w.blad) bledy.push(`${opis}: ${w.blad}`)
      else if (w.zmiana) zapisane++
    } catch (e) {
      if (e instanceof BladStanowiska) bledy.push(`${opis}: ${e.message}`)
      else {
        // błąd programu: do logu serwera (bez treści zamówienia), dla osoby jedna linia; reszta zmian idzie dalej
        console.error('[karta] zapis pozycji', orderId, e instanceof Error ? e.message : 'nieznany błąd')
        bledy.push(`${opis}: nie udało się zapisać, spróbuj jeszcze raz`)
      }
    }
  }

  const zmiany = z.zmiany.slice(0, MAKS_POZYCJI)
  // co faktycznie zmienia pozycję (ilość, usunięcie, cena, VAT): tylko wtedy bramka edycji
  const plan = new Map<string, { usun: boolean; ilosc: IloscDoZapisu; cena: CenaDoZapisu }>()
  if (!z.tylkoDecyzje)
    for (const zm of zmiany) {
      const l = linia.get(zm.lineId)
      if (!l || l.removed) continue
      const p = { usun: !!zm.usun, ilosc: iloscDoZapisu(zm, l), cena: cenaDoZapisu(zm, l) }
      if (p.usun || p.ilosc !== 'bez' || p.cena !== 'bez') plan.set(l.id, p)
    }
  let bramka: { id: string } | null = null
  let odmowaBramki: string | null = null
  let odmowaCen: string | null = null
  if (plan.size) {
    const g = await bramkaEdycji(db, z, 'zamowienia.edycja_pozycji', env)
    if ('id' in g) bramka = g
    else odmowaBramki = g.blad ?? BEZ_UPRAWNIENIA
    if ([...plan.values()].some((p) => p.cena !== 'bez') && !z.uprawnienia.has('zamowienia.ceny_pozycji')) odmowaCen = BEZ_UPRAWNIENIA
  }
  // dokument sprzedaży albo przesyłka z pobraniem raz przed pętlą, jednym komunikatem (rdzeń sprawdza
  // to samo pod blokadą przy każdej zmianie); decyzje o brakach idą dalej
  if (bramka) {
    const o = await db.order.findUnique({ where: { id: orderId }, select: { id: true, packageNo: true, paymentState: true } })
    const powod = o ? await powodDokumentuLubPrzesylki(db, o) : null
    if (powod) {
      odmowaBramki = powod
      bramka = null
    }
  }
  if (odmowaBramki) bledy.push(`Zmiany pozycji: ${odmowaBramki}`)

  for (const zm of zmiany) {
    const l = linia.get(zm.lineId)
    if (!l) {
      bledy.push('Pozycja spoza zamówienia: nie ma takiej pozycji w tym zamówieniu')
      continue
    }
    const opis = opisPozycji(l, skuProduktu)
    if (l.removed) continue
    const p = plan.get(l.id)
    if (p && bramka) {
      const id = bramka.id
      if (p.usun) {
        await krok(opis, () => usunPozycjePoBramce(db, id, l.id, z.userId))
        continue // usuniętej pozycji nie zmieniamy ilości, ceny ani decyzji
      }
      if (p.ilosc === 'konflikt') bledy.push(`${opis}: ilość: ${KOMUNIKAT_KONFLIKT_POZYCJI}`)
      else if (p.ilosc === 'zmiana') await krok(opis, () => zmienIloscPoBramce(db, id, l.id, zm.ilosc, z.userId))
      const c = p.cena
      if (c !== 'bez') {
        if (odmowaCen) bledy.push(`${opis}: cena i VAT: ${odmowaCen}`)
        else if (c === 'konflikt') bledy.push(`${opis}: cena i VAT: ${KOMUNIKAT_KONFLIKT_POZYCJI}`)
        else await krok(opis, () => zmienCenePoBramce(db, id, l.id, c.cena, c.vat, z.userId, c.bylo))
      }
    } else if (p?.usun) continue
    const nowa = zm.decyzja
    // przy „Zamień produkt” liczy się też SKU zamiennika (inny SKU przy tej samej decyzji to zmiana);
    // tę samą decyzję z tym samym zamiennikiem rdzeń rozpoznaje sam (`zmiana: false`)
    if (decyzjaDoZapisu(nowa, decyzja.get(l.id), zm.sku)) {
      if (!z.uprawnienia.has('braki.decyzje')) {
        bledy.push(`${opis}: ${BEZ_UPRAWNIENIA}`)
        continue
      }
      if (!DECYZJE.some((x) => x.akcja === nowa)) {
        bledy.push(`${opis}: nieznana decyzja`)
        continue
      }
      await krok(opis, async () => {
        const r = await zdecydujOBraku(db, { orderLineId: l.id, akcja: nowa as (typeof DECYZJE)[number]['akcja'], sku: zm.sku ?? null, userId: z.userId })
        return { blad: null, zmiana: r.zmiana }
      })
    }
  }

  if (bledy.length) {
    const tekst = `${zapisane ? `Zapisano ${zapisane} ${odmiana(zapisane)}, nie zapisano` : 'Nie zapisano'}: ${bledy.slice(0, 3).join(' · ')}${bledy.length > 3 ? ` (i ${bledy.length - 3} więcej)` : ''}`
    // limit pod ciasteczko szczegółów, ale tak, żeby najdłuższy pojedynczy komunikat się nie ucinał
    return { blad: tekst.slice(0, 1000), zmiana: zapisane > 0, zapisane, odrzucone: bledy.length }
  }
  if (!zapisane) return { blad: null, zmiana: false, info: 'pozycje.brak', zapisane: 0, odrzucone: 0 }
  return { blad: null, zmiana: true, info: zapisane === 1 ? 'pozycje.jedna' : 'pozycje.wiele', n: zapisane, zapisane, odrzucone: 0 }
}

export type IloscDoZapisu = 'bez' | 'zmiana' | 'konflikt'

/** ilość zmienia się względem wartości z renderu (`iloscBylo`), a nie bazy w chwili zapisu. */
export function iloscDoZapisu(zm: Pick<ZmianaPozycji, 'ilosc' | 'iloscBylo'>, l: { qty: number }): IloscDoZapisu {
  if (zm.ilosc === undefined || zm.ilosc === '') return 'bez'
  const bylo = zm.iloscBylo !== undefined && zm.iloscBylo !== '' && Number.isFinite(Number(zm.iloscBylo)) ? Number(zm.iloscBylo) : null
  if (bylo === null) return Number(zm.ilosc) !== l.qty ? 'zmiana' : 'bez'
  if (Number(zm.ilosc) === bylo) return 'bez'
  return bylo !== l.qty ? 'konflikt' : 'zmiana'
}

/** Co z pól ceny i VAT idzie do rdzenia: tylko zmienione części (pusta = bez zmiany) i to, co osoba widziała. */
export type CenaDoZapisu = 'bez' | 'konflikt' | { cena: string; vat: string; bylo?: NowaCena['bylo'] }

/**
 * czy pola ceny i VAT zmieniają pozycję. Pusta cena albo stawka = bez zmiany tej części; tekst niepoprawny
 * liczy się jako zmiana (rdzeń odpowie komunikatem, zamiast cicho go pominąć).
 * z `cenaBylo`/`vatBylo` (render karty) zmiana = wysłane ≠ widziane; gdy widziane ≠ baza, ktoś
 * zmienił pozycję w międzyczasie (`konflikt`). Część niezmieniona nie idzie do rdzenia, więc zmiana samego VAT nie
 * cofa cudzej ceny. Stawki porównywane po `normalizujStawke` („23.00” z kanału = „23” z listy).
 */
export function cenaDoZapisu(zm: Pick<ZmianaPozycji, 'cena' | 'vat' | 'cenaBylo' | 'vatBylo'>, l: { unitPriceGross: { toString(): string }; vatRate: string | null }): CenaDoZapisu {
  const out: { cena: string; vat: string; bylo?: NonNullable<NowaCena['bylo']> } = { cena: '', vat: '' }
  let konflikt = false
  const cena = (zm.cena ?? '').trim()
  if (cena) {
    const wyslana = cenaZTekstu(cena)
    const bylo = zm.cenaBylo !== undefined ? cenaZTekstu(zm.cenaBylo) : null
    const baza = grosze(l.unitPriceGross)
    if (wyslana === null) out.cena = cena // zła cena: rdzeń odpowie komunikatem
    else if (bylo === null) out.cena = wyslana !== baza ? cena : ''
    else if (wyslana !== bylo) {
      if (bylo !== baza) konflikt = true
      out.cena = cena
      out.bylo = { ...out.bylo, priceGrossGr: bylo }
    }
  }
  const vat = normalizujStawke(zm.vat)
  if (vat) {
    const baza = normalizujStawke(l.vatRate)
    if (zm.vatBylo === undefined) out.vat = vat !== baza ? vat : ''
    else {
      const bylo = normalizujStawke(zm.vatBylo)
      if (vat !== bylo) {
        if (bylo !== baza) konflikt = true
        out.vat = vat
        out.bylo = { ...out.bylo, vatRate: bylo }
      }
    }
  }
  if (konflikt) return 'konflikt'
  if (!out.cena && !out.vat) return 'bez'
  return out
}

/**
 * Czy decyzję z formularza wysłać do rdzenia: nowa albo inna niż zapisana; ta sama „Zamień produkt” tylko wtedy, gdy
 * formularz niesie pole SKU (inny zamiennik to zmiana). Po spakowaniu pole
 * SKU nie jest renderowane, a select z zapisaną wcześniej ZAMIEN zostaje; bez tego warunku każdy zapis sekcji kończył
 * się „Podaj SKU zamiennika”.
 */
export function decyzjaDoZapisu(nowa: string | undefined, zapisana: string | undefined, sku: string | undefined): boolean {
  if (!nowa) return false
  return nowa !== zapisana || (nowa === 'ZAMIEN' && sku !== undefined)
}

/** Nazwa pozycji w komunikacie: SKU produktu, SKU z kanału albo początek nazwy z kanału. */
export function opisPozycji(l: { productId: string | null; channelSku: string | null; channelName: string | null }, skuProduktu: ReadonlyMap<string, string>): string {
  const sku = (l.productId ? skuProduktu.get(l.productId) : null) ?? l.channelSku
  if (sku) return `SKU ${sku.slice(0, 40)}`
  if (l.channelName) return `„${l.channelName.length > 30 ? `${l.channelName.slice(0, 29)}…` : l.channelName}”`
  return 'Pozycja bez nazwy'
}

function odmiana(n: number): string {
  if (n === 1) return 'zmianę'
  const d = n % 10
  const s = n % 100
  return d >= 2 && d <= 4 && (s < 12 || s > 14) ? 'zmiany' : 'zmian'
}
