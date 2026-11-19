// „Zmień status” na karcie zamówienia (ratowanie pomyłek). Osoba z
// uprawnieniem `zamowienia.status_dowolny` wybiera z listy dowolny status, na który wolno przejść z obecnego, i podaje
// powód; zmiana zostaje w historii (OrderEvent `STATUS_RECZNIE` z poprzednim i nowym statusem oraz powodem).
//
// „Dozwolony” znaczy: nie łamie stanu magazynu ani faktury. Dwie drogi:
//  1. przejście z tabeli rdzenia (`canTransition`) wykonane tą samą funkcją rdzenia co przyciski „Co dalej”
//     (warunki `powodOdmowy` pod blokadą zamówienia): zbieranie, zebrane, do wysyłki / odbioru, wysłane, odebrane,
//     anulowanie (`cancelOrder`, po fakturze tylko z `zamowienia.anuluj_po_fakturze`), do wyjaśnienia (`clarifyOrder`
//     z powodem), reklamacja;
//  2. cofnięcie pomyłki (`COFNIECIA`), które nie rusza rezerwacji ani rozchodu: „Wysłane” → „Do wysłania”, „Odebrane”
//     → „Wysłane” / „Do odbioru”, „Do wysłania” / „Do odbioru” → „Spakowane”, „Zebrane” → „Do realizacji” (jak przerwane
//     zbieranie), „Reklamacja” → „Wysłane” / „Odebrane”.
// Spakowanie (zamyka braki, rozchód), opłacenie i wyjście z „Do wyjaśnienia” mają własne przyciski: na liście są jako
// niedostępne z powodem. Bramki jak „Co dalej”: wyłącznik instancji i konto kanału w trybie PRACA (konto w cieniu
// prowadzi BaseLinker). Nic nie idzie do kanału, wFirmy ani przewoźnika.
// firma ze statusami własnymi wybiera z listy swoje statusy (wartość `F:<klucz>`). Status firmy z innym
// statusem bazowym idzie tą samą drogą co status rdzenia (bez zmian w przejściach), a na końcu zostaje przypisany
// wprost (Order.companyStatus). Status firmy z tym samym statusem bazowym co obecny zmienia tylko nazwę (rdzeń stoi).
import type { Carrier, OrderStatus, PrismaClient } from '@prisma/client'
import { STATUS_LABEL } from '@/lib/panel/format'
import { lockOrder, moveOrderInTx, powodOdmowy } from '@/lib/rdzen/przejscia'
import { hintAllocate, mergeFlags } from '@/lib/rdzen/rezerwacja'
import { runTx } from '@/lib/rdzen/stan'
import { zwolnijKoszykPoStatusie } from '@/lib/koszyki/zwolnienie'
import { canTransition, TransitionError } from '@/lib/rdzen/statusy'
import { cancelOrder, clarifyOrder } from '@/lib/rdzen/zamowienia'
import { faktyEkranu, wczytajZamowienieEkranu } from './dane'
import type { FaktyEkranu } from './przejscia-ekran'
import { kontoZamowienia, pracaDostepna } from './wlacznik'
import { sortujStatusy, wybierzStatusFirmy, type StatusFirmyT } from '@/lib/panel/statusy'
import { statusyFirmy } from '@/lib/panel/statusy-firmy-dane'

type Db = PrismaClient

export const STATUS_RECZNIE = 'STATUS_RECZNIE'
export const POWOD_MIN = 3
export const POWOD_MAX = 300

/** Cofnięcia pomyłek poza tabelą rdzenia: zmieniają tylko status (rezerwacje i rozchód zostają, jak były). */
export const COFNIECIA: Partial<Record<OrderStatus, OrderStatus[]>> = {
  WYSLANE: ['DO_WYSLANIA'],
  ODEBRANE: ['WYSLANE', 'DO_ODBIORU'],
  DO_WYSLANIA: ['SPAKOWANE'],
  DO_ODBIORU: ['SPAKOWANE'],
  ZEBRANE: ['DO_REALIZACJI'],
  REKLAMACJA: ['WYSLANE', 'ODEBRANE'],
}

/** Kolejność listy wyboru (jak przebieg zamówienia). */
const KOLEJNOSC: OrderStatus[] = ['NOWE', 'DO_REALIZACJI', 'ZBIERANIE', 'ZEBRANE', 'SPAKOWANE', 'DO_WYSLANIA', 'DO_ODBIORU', 'WYSLANE', 'ODEBRANE', 'REKLAMACJA', 'DO_WYJASNIENIA', 'ANULOWANE']

export type Droga = 'RDZEN' | 'COFNIECIE' | 'ANULUJ' | 'WYJASNIJ'

export interface OpcjaStatusu {
  status: OrderStatus
  etykieta: string
  droga: Droga | null
  /** null = można wybrać; inaczej powód jednym zdaniem. */
  powod: string | null
}

export interface ZamowienieStatusu {
  status: OrderStatus
  carrier: Carrier | null
  pendingAction: string | null
}

/**
 * Lista statusów do wyboru (czysta funkcja). Status obecny pomijany. Statusy bez żadnej drogi z obecnego nie trafiają
 * na listę, te z drogą, ale z niespełnionym warunkiem, są z powodem.
 */
export function opcjeStatusu(o: ZamowienieStatusu, f: FaktyEkranu, uprawnienia: ReadonlySet<string>): OpcjaStatusu[] {
  const out: OpcjaStatusu[] = []
  for (const to of KOLEJNOSC) {
    if (to === o.status) continue
    const cofniecie = (COFNIECIA[o.status] ?? []).includes(to)
    const wTabeli = canTransition(o.status, to)
    let droga: Droga | null = null
    let powod: string | null = null
    if (cofniecie) {
      droga = 'COFNIECIE'
      powod = powodCofniecia(o, to, f)
    } else if (o.status === 'DO_WYJASNIENIA' && to !== 'ANULOWANE') {
      if (to !== 'DO_REALIZACJI' && to !== 'NOWE') continue
      powod = 'Wyjście z „Do wyjaśnienia” przyciskiem „Wyjaśnione” (status liczy się sam z płatności).'
    } else if (wTabeli) {
      if (to === 'ANULOWANE') {
        droga = 'ANULUJ'
        if (o.pendingAction?.startsWith('CANCEL')) powod = 'Anulowanie już czeka na wynik faktury.'
        else if (f.poFakturze && !uprawnienia.has('zamowienia.anuluj_po_fakturze')) powod = 'Po fakturze anulować może tylko osoba z osobnym uprawnieniem (Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia).'
      } else if (to === 'DO_WYJASNIENIA') droga = 'WYJASNIJ'
      else if (to === 'SPAKOWANE') powod = 'Spakowanie przyciskiem „Spakuj” albo na stanowisku pakowania (zamyka braki).'
      else if (o.status === 'NOWE' && to === 'DO_REALIZACJI') powod = 'Nowe przechodzi do realizacji po opłaceniu: przycisk „Oznacz jako opłacone”.'
      else if (to === 'DO_REALIZACJI' && o.status !== 'ZBIERANIE') continue
      else {
        droga = 'RDZEN'
        powod = to === 'REKLAMACJA' ? null : powodOdmowy(o, to, f)
      }
    } else continue
    out.push({ status: to, etykieta: STATUS_LABEL[to], droga: powod ? null : droga, powod })
  }
  return out
}

export interface OpcjaWyboru {
  /** wartość pola formularza: status rdzenia albo `F:<klucz statusu firmy>` */
  wartosc: string
  etykieta: string
  droga: Droga | 'NAZWA' | null
  powod: string | null
}

/**
 * lista wyboru ze statusami firmy (czysta funkcja). Każda opcja rdzenia rozkłada się na aktywne statusy
 * firmy z tym statusem bazowym (z tą samą drogą i tym samym powodem), a pozostałe statusy firmy z obecnym statusem
 * bazowym dochodzą jako zmiana samej nazwy. Tylko statusy dla przewoźnika zamówienia albo bez przewoźników; etap bez
 * takiego statusu zostaje pod nazwą rdzenia. Firma bez statusów = opcje rdzenia jak dotąd.
 */
export function opcjeZeStatusamiFirmy(opcje: readonly OpcjaStatusu[], defs: readonly StatusFirmyT[], o: { status: OrderStatus; carrier: Carrier | null; companyStatus: string | null }): OpcjaWyboru[] {
  if (!defs.length) return opcje.map((x) => ({ wartosc: x.status, etykieta: x.etykieta, droga: x.droga, powod: x.powod }))
  // statusy dla przewoźnika zamówienia (albo bez przewoźników): „Zebrane Allegro” nie podpowiada się przy zamówieniu DPD
  const c = o.carrier ?? 'BRAK'
  const aktywne = sortujStatusy(defs).filter((d) => d.active && (!d.carriers.length || d.carriers.includes(c)))
  const obecny = wybierzStatusFirmy(defs, o)?.key ?? null
  const out: OpcjaWyboru[] = aktywne.filter((d) => d.baseStatus === o.status && d.key !== obecny).map((d) => ({ wartosc: `F:${d.key}`, etykieta: d.name, droga: 'NAZWA', powod: null }))
  for (const x of opcje) {
    const w = aktywne.filter((d) => d.baseStatus === x.status)
    if (!w.length) out.push({ wartosc: x.status, etykieta: x.etykieta, droga: x.droga, powod: x.powod })
    for (const d of w) out.push({ wartosc: `F:${d.key}`, etykieta: d.name, droga: x.droga, powod: x.powod })
  }
  return out
}

function powodCofniecia(o: ZamowienieStatusu, to: OrderStatus, f: FaktyEkranu): string | null {
  if (o.pendingAction) return 'Anulowanie w toku (faktura w drodze): poczekaj na rozstrzygnięcie.'
  // zamówienie bez paczki (sama usługa) nie wraca do wysyłki: nie ma czego wysłać
  if ((to === 'WYSLANE' || to === 'DO_WYSLANIA' || to === 'DO_ODBIORU') && f.aktywne + f.wFakturze + f.wydane === 0) return 'Zamówienie bez wysyłki (sama usługa): nie ma paczki do wysłania.'
  const osobisty = o.carrier === 'OSOBISTY'
  if (to === 'DO_ODBIORU' && !osobisty) return '„Do odbioru” tylko dla odbioru osobistego.'
  if (to === 'WYSLANE' && osobisty && o.status === 'ODEBRANE') return 'Odbiór osobisty: cofnij do „Do odbioru”.'
  if (to === 'DO_REALIZACJI' && f.fakturaWToku) return 'Faktura jest w drodze: poczekaj na nią.'
  return null
}

export interface ZlecenieStatusu {
  orderId: string
  status: string
  powod: unknown
  userId: string
  uprawnienia: ReadonlySet<string>
}

const BEZ_UPRAWNIENIA = 'Zmiana statusu z listy wymaga uprawnienia „Zmiana statusu na dowolny dozwolony” (Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia).'
const WYLACZONE = 'Zmiana statusu z karty działa tylko dla kont w trybie PRACA na instancji z włączonymi ekranami trybu PRACA.'

/** Powód: 3–300 znaków po przycięciu; null = zły (komunikat w wywołującym). */
export function powodZmiany(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : ''
  return s.length >= POWOD_MIN && s.length <= POWOD_MAX ? s : null
}

export type WynikZmiany = { blad: string | null; zmiana: boolean }

/** Zmiana statusu z karty: bramki, uprawnienie, powód, lista dozwolonych i wykonanie właściwą drogą. */
export async function zmienStatus(db: Db, z: ZlecenieStatusu, env: Record<string, string | undefined> = process.env): Promise<WynikZmiany> {
  if (!z.uprawnienia.has('zamowienia.status_dowolny')) return { blad: BEZ_UPRAWNIENIA, zmiana: false }
  const o = await wczytajZamowienieEkranu(db, String(z.orderId ?? ''))
  if (!o) return { blad: 'Nie ma takiego zamówienia.', zmiana: false }
  let dostepna: boolean
  try {
    dostepna = pracaDostepna(await kontoZamowienia(db, o, env), env)
  } catch {
    return { blad: 'Zła wartość EKRANY_PRACA na tej instancji: zmiana statusu wyłączona.', zmiana: false }
  }
  if (!dostepna) return { blad: WYLACZONE, zmiana: false }
  const powod = powodZmiany(z.powod)
  if (!powod) return { blad: `Podaj powód zmiany statusu (od ${POWOD_MIN} do ${POWOD_MAX} znaków): zostanie w historii zamówienia.`, zmiana: false }
  // status firmy `F:<klucz>` → jego status bazowy; przypisanie wprost po udanym przejściu
  let firmy: StatusFirmyT | null = null
  let cel = z.status
  if (cel.startsWith('F:')) {
    firmy = (await statusyFirmy(db)).statusy.find((d) => d.key === cel.slice(2) && d.active) ?? null
    if (!firmy) return { blad: 'Tego statusu firma już nie ma: odśwież kartę.', zmiana: false }
    // serwer pilnuje przewoźników statusu jak lista na karcie (spreparowany formularz nie przypisze
    // „Zebrane Allegro” zamówieniu DPD)
    if (firmy.carriers.length && !firmy.carriers.includes(o.carrier ?? 'BRAK')) return { blad: `Status „${firmy.name}” nie pasuje do przewoźnika tego zamówienia: odśwież kartę.`, zmiana: false }
    cel = firmy.baseStatus
  }
  if (o.status === cel) {
    if (!firmy) return { blad: null, zmiana: false } // podwójne kliknięcie
    const teraz = await db.order.findUnique({ where: { id: o.id }, select: { companyStatus: true } })
    if (teraz?.companyStatus === firmy.key) return { blad: null, zmiana: false }
    const n = await db.order.updateMany({ where: { id: o.id, status: cel }, data: { companyStatus: firmy.key } })
    if (!n.count) return { blad: 'Ta akcja nie pasuje do obecnego stanu zamówienia: odśwież kartę.', zmiana: false }
    await db.orderEvent.create({ data: { orderId: o.id, kind: STATUS_RECZNIE, actorId: `user:${z.userId}`, data: { z: o.status, na: cel, powod, statusFirmy: firmy.key, nazwa: firmy.name } } })
    return { blad: null, zmiana: true }
  }
  const opcja = opcjeStatusu(o, await faktyEkranu(db, o), z.uprawnienia).find((x) => x.status === cel)
  if (!opcja) return { blad: 'Na ten status nie da się przejść z obecnego: odśwież kartę.', zmiana: false }
  if (opcja.powod || !opcja.droga) return { blad: opcja.powod ?? 'Ten status ma własny przycisk.', zmiana: false }
  const to = opcja.status
  const actorId = `user:${z.userId}`
  const z_ = o.status
  const wpis = { z: z_, na: to, powod, ...(firmy ? { statusFirmy: firmy.key, nazwa: firmy.name } : {}) }
  try {
    switch (opcja.droga) {
      case 'RDZEN':
        await runTx(db, async (tx) => {
          const cur = await lockOrder(tx, o.id)
          if (cur.status !== z_) throw new TransitionError('Ta akcja nie pasuje do obecnego stanu zamówienia: odśwież kartę.')
          if (to === 'REKLAMACJA') {
            if (!canTransition(cur.status, to)) throw new TransitionError(`Niedozwolone przejście ${cur.status} → ${to}`)
            await tx.order.update({ where: { id: o.id }, data: { status: to } })
            await zwolnijKoszykPoStatusie(tx, o.id, to)
          } else await moveOrderInTx(tx, o.id, to, { actorId })
          await tx.orderEvent.create({ data: { orderId: o.id, kind: STATUS_RECZNIE, actorId, data: wpis } })
        })
        break
      case 'COFNIECIE':
        await runTx(db, async (tx) => {
          const cur = await lockOrder(tx, o.id)
          if (cur.status !== z_ || cur.pendingAction) throw new TransitionError('Ta akcja nie pasuje do obecnego stanu zamówienia: odśwież kartę.')
          await tx.order.update({ where: { id: o.id }, data: { status: to, ...(to === 'DO_REALIZACJI' ? { flags: mergeFlags(cur, { kartaNieaktualna: undefined }) } : {}) } })
          await tx.orderEvent.create({ data: { orderId: o.id, kind: STATUS_RECZNIE, actorId, data: { ...wpis, cofniecie: true } } })
          if (to === 'DO_REALIZACJI') await hintAllocate(tx, o.id, new Date()) // jak przerwane zbieranie: braki znowu biorą dostawę
        })
        break
      case 'ANULUJ': {
        // anulowanie ma własną transakcję rdzenia (zwolnienie rezerwacji, stan w kanale); wpis z powodem zaraz po nim
        const st = await cancelOrder(db, o.id, { actorId })
        await db.orderEvent.create({ data: { orderId: o.id, kind: STATUS_RECZNIE, actorId, data: { ...wpis, na: st, ...(st !== 'ANULOWANE' ? { odlozone: true } : {}) } } })
        break
      }
      case 'WYJASNIJ': {
        const ok = await clarifyOrder(db, o.id, `ręcznie: ${powod}`, { allowed: [z_], actorId })
        if (!ok) return { blad: 'Ta akcja nie pasuje do obecnego stanu zamówienia: odśwież kartę.', zmiana: false }
        await db.orderEvent.create({ data: { orderId: o.id, kind: STATUS_RECZNIE, actorId, data: wpis } })
        break
      }
    }
  } catch (e) {
    if (e instanceof TransitionError) return { blad: e.message, zmiana: false }
    throw e
  }
  // status firmy przypisany wprost tylko, gdy rdzeń faktycznie stoi na jego statusie bazowym (anulowanie odłożone nie)
  if (firmy) await db.order.updateMany({ where: { id: o.id, status: firmy.baseStatus }, data: { companyStatus: firmy.key } })
  return { blad: null, zmiana: true }
}

/** Lista do karty: null = sekcji nie ma (bez uprawnienia albo konto poza trybem PRACA, zła wartość EKRANY_PRACA). */
export async function stanZmianyStatusu(db: Db, orderId: string, uprawnienia: ReadonlySet<string>, env: Record<string, string | undefined> = process.env): Promise<OpcjaWyboru[] | null> {
  if (!uprawnienia.has('zamowienia.status_dowolny')) return null
  const o = await wczytajZamowienieEkranu(db, orderId)
  if (!o) return null
  try {
    if (!pracaDostepna(await kontoZamowienia(db, o, env), env)) return null
  } catch {
    return null
  }
  const [opcje, sf, cs] = await Promise.all([faktyEkranu(db, o).then((f) => opcjeStatusu(o, f, uprawnienia)), statusyFirmy(db), db.order.findUnique({ where: { id: o.id }, select: { companyStatus: true } })])
  return opcjeZeStatusamiFirmy(opcje, sf.statusy, { status: o.status, carrier: o.carrier, companyStatus: cs?.companyStatus ?? null })
}
