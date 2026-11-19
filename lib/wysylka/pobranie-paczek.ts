// kwota pobrania paczki zamówienia podzielonego („dośle później”, „Podziel zamówienie”). Bez własnej
// reguły ceny: paczka dodatkowa = kwota jej faktury (`kwotaPaczkiDodatkowej`, ceny pozycji z kanału), paczka 1 = kwota
// zamówienia minus paczki dodatkowe (koszt wysyłki i opłata za pobranie zostają w paczce 1). Suma pobrań wszystkich
// paczek = kwota zamówienia co do grosza z konstrukcji; pewność daje warunek, że paczki dodatkowe są warte dokładnie
// tyle, ile pozycje zdjęte z zamówienia głównego (ta sama różnica, o którą dokument paczki 1 jest niższy od zamówienia,
// `zlozPozycjeDokumentu`: pełne − dostarczane). Gdy tego nie da się zagwarantować, powód zamiast zgadywania.
import type { PrismaClient } from '@prisma/client'
import { kosztWysylkiZamowienia, type OrderRow, pozycjeZamowienia, type PozycjaZamowienia, rabatPonadProgPewnosci } from '@/lib/dokumenty/pozycje'
import { slowniki } from '@/lib/ksef/szkice'
import { wartoscPozycjiGr } from '@/lib/rdzen/ceny'
import { PRZESYLKA_AKTYWNA, przewoznicyAnulujaZKompletora } from '@/lib/rdzen/brakuje'
import { kwotaPaczkiDodatkowej } from '@/lib/wfirma/adapter-zapis'

export type KwotyPaczek = { kwotyGr: Map<string, number>; powod: null } | { kwotyGr: null; powod: string }

export interface RodzinaPaczek {
  /** Zamówienie główne (paczka 1): kwota z kanału, koszt wysyłki, pozycje z odrzuconymi sztukami po przeniesieniu. */
  glowne: { id: string; totalGross: number; kosztWysylki: number | null; pozycje: PozycjaZamowienia[] }
  /** Paczki dodatkowe (podzamówienia zamówienia głównego). */
  dodatkowe: { id: string; pozycje: PozycjaZamowienia[] }[]
}

const nie = (powod: string): KwotyPaczek => ({ kwotyGr: null, powod })
const zZamiana = (p: PozycjaZamowienia) => p.zamiennik !== undefined || p.bladZamiany !== undefined || p.pokryte !== undefined || (p.przesuniecie ?? 0) > 0

/** Czysta reguła (testy jednostkowe): kwota pobrania w groszach dla każdej paczki rodziny albo powód. */
export function kwotyPobraniaPaczek(r: RodzinaPaczek): KwotyPaczek {
  const g = r.glowne
  if (!Number.isFinite(g.totalGross) || g.totalGross <= 0) return nie('brak kwoty zamówienia')
  if (g.kosztWysylki === null || !Number.isFinite(g.kosztWysylki)) return nie('kanał nie podał kosztu wysyłki, więc nie da się oddzielić wysyłki i rabatu od pozycji paczek')
  if ([g, ...r.dodatkowe].some((x) => x.pozycje.some(zZamiana))) return nie('zamówienie ma zamieniony produkt, którego cena może różnić się od pozycji z kanału')
  // Ten sam próg co `rabatLiczonyNaDokumencie` (ceny pozycji sprzed rabatu na całe zamówienie) i rabat ponad sufit: kwota
  // bez wysyłki niższa od pełnej wartości pozycji o więcej niż 1% = ceny paczek dodatkowych nie są cenami po rabacie.
  const pelneGr = g.pozycje.reduce((s, p) => s + wartoscPozycjiGr(p.qty, p.naOferte, p.cenaBruttoGr), 0)
  if (rabatPonadProgPewnosci(pelneGr, Math.round(g.totalGross * 100) - Math.round(g.kosztWysylki * 100)))
    return nie('rabat na całe zamówienie jest liczony dopiero na dokumencie, a ceny pozycji paczek są sprzed rabatu')
  if (r.dodatkowe.some((d) => d.pozycje.some((p) => p.qtyOdrzucone > 0))) return nie('paczka dodatkowa ma odrzucone albo przeniesione dalej sztuki')
  // wartość sztuk zdjętych z zamówienia głównego: o tyle dokument paczki 1 jest niższy od kwoty zamówienia
  const zdjeteGr = g.pozycje.reduce((s, p) => s + wartoscPozycjiGr(p.qty, p.naOferte, p.cenaBruttoGr) - wartoscPozycjiGr(Math.max(0, p.qty - p.qtyOdrzucone), p.naOferte, p.cenaBruttoGr), 0)
  const kwotyGr = new Map<string, number>()
  let dodatkoweGr = 0
  for (const d of r.dodatkowe) {
    const gr = Math.round(kwotaPaczkiDodatkowej(d.pozycje) * 100)
    kwotyGr.set(d.id, gr)
    dodatkoweGr += gr
  }
  if (dodatkoweGr !== zdjeteGr) return nie('pozycje paczek dodatkowych nie pokrywają się z pozycjami zdjętymi z zamówienia (np. odrzucone przy akceptacji albo inna cena)')
  const glowneGr = Math.round(g.totalGross * 100) - dodatkoweGr
  if (glowneGr <= 0) return nie('paczki dodatkowe są warte tyle co całe zamówienie')
  kwotyGr.set(g.id, glowneGr)
  return { kwotyGr, powod: null }
}

/** Kwoty pobrania paczek rodziny zamówienia `orderId` (główne albo paczka dodatkowa). Klient bazy firmy (RLS). */
export async function kwotyPobraniaRodziny(db: PrismaClient, orderId: string): Promise<KwotyPaczek> {
  const o = await db.order.findUniqueOrThrow({ where: { id: orderId }, select: { parentOrderId: true } })
  const rootId = o.parentOrderId ?? orderId
  const glowne = await db.order.findUniqueOrThrow({ where: { id: rootId }, include: { lines: true } })
  if (glowne.parentOrderId) return nie('zamówienie główne samo jest paczką dodatkową')
  // także paczki dodatkowe anulowane. Ich sztuki zostają zdjęte z zamówienia głównego (`qtyRejected`), więc
  // paczka 1 ich nie pobiera, a anulowana paczka nie wyjdzie: klient za ten towar nie płaci. Pominięcie anulowanej
  // rozjechałoby sumy i dało „Nieznana kwota” dla całej rodziny.
  const dodatkowe: OrderRow[] = await db.order.findMany({ where: { parentOrderId: rootId }, include: { lines: true }, orderBy: { packageNo: 'asc' } })
  if (dodatkowe.length && (await db.order.count({ where: { parentOrderId: { in: dodatkowe.map((d) => d.id) } } })) > 0) return nie('paczka dodatkowa ma własne paczki')
  const sl = await slowniki(db, [glowne, ...dodatkowe])
  // produkty niepotrzebne: wartość liczy się z ilości, przelicznika oferty i ceny pozycji
  const pozycje = (x: OrderRow) => pozycjeZamowienia(x, new Map(), sl.offers)
  const wynik = kwotyPobraniaPaczek({
    glowne: { id: glowne.id, totalGross: Number(glowne.totalGross), kosztWysylki: kosztWysylkiZamowienia(glowne), pozycje: pozycje(glowne) },
    dodatkowe: dodatkowe.map((d) => ({ id: d.id, pozycje: pozycje(d) })),
  })
  if (!wynik.kwotyGr) return wynik
  // etykieta przewoźnika ma kwotę pobrania z chwili utworzenia przesyłki (np. paczka 1
  // nadana przed podziałem z kwotą całego zamówienia). Kwota na etykiecie inna niż wyliczona dla jej paczki = żadna paczka
  // rodziny nie dostaje automatycznej kwoty, inaczej klient zapłaciłby część zamówienia dwa razy.
  const nr = new Map([glowne, ...dodatkowe].map((x) => [x.id, x.packageNo]))
  // tylko przesyłki główne paczek: dodatkowa (dosyłka) jest zawsze bez pobrania i nie niesie kwoty paczki
  const przesylki = await db.shipment.findMany({ where: { orderId: { in: [...nr.keys()] }, extraNo: 0, state: { in: [...PRZESYLKA_AKTYWNA] } }, select: { orderId: true, codAmount: true, adapterKey: true }, orderBy: { packageNo: 'asc' } })
  for (const s of przesylki) {
    const naEtykiecie = s.codAmount === null ? 0 : Math.round(Number(s.codAmount) * 100)
    const powinno = wynik.kwotyGr.get(s.orderId) ?? 0
    if (naEtykiecie === powinno) continue
    const anulowalna = await przewoznicyAnulujaZKompletora([s.adapterKey])
    return nie(powodEtykietyPoPodziale({ paczka: nr.get(s.orderId) ?? 0, naEtykiecieGr: naEtykiecie, powinnoGr: powinno, anulowalna }))
  }
  return wynik
}

/**
 * Powód „Nieznana kwota pobrania”, gdy etykieta ma inną kwotę niż wyliczona dla jej
 * paczki. „Anuluj przesyłkę” tylko u przewoźników, którzy anulują z Kompletora; u pozostałych (DPD, InPost ShipX, GLS)
 * przesyłka zostaje w Kompletorze utworzona także po anulowaniu w panelu przewoźnika, więc Kompletor tej kwoty nie naprawi.
 */
export function powodEtykietyPoPodziale(o: { paczka: number; naEtykiecieGr: number; powinnoGr: number; anulowalna: boolean }): string {
  const opis = o.naEtykiecieGr > 0 ? `z pobraniem ${zl(o.naEtykiecieGr)} zł` : 'bez pobrania'
  const poczatek = `paczka ${o.paczka} ma już przesyłkę ${opis}, a po podziale powinna mieć ${zl(o.powinnoGr)} zł`
  if (o.anulowalna) return `${poczatek}: anuluj tę przesyłkę i utwórz ją ponownie`
  return (
    `${poczatek}. Tej przesyłki nie da się anulować w Kompletorze (ten przewoźnik nie anuluje przesyłek z Kompletora), ` +
    'więc kwot pobrania dla paczek tego zamówienia Kompletor nie poda: zmień kwotę pobrania tej przesyłki w panelu przewoźnika, ' +
    'a pozostałe paczki nadaj ręcznie w panelu przewoźnika'
  )
}

const zl = (gr: number) => (gr / 100).toFixed(2).replace('.', ',')
