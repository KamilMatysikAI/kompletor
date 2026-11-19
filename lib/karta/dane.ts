// Dane karty zamówienia: jeden odczyt dla `page.tsx`, komponenty karty dostają gotowe dane (bez własnych
// zapytań). Wyjątek: bloki z wcześniejszych zadań (Co dalej, Klient i dostawa, Przesyłka, Faktura KSeF) czytają swoje
// dane same, jak dotąd — karta tylko osadza je w układzie. Klient bazy firmy z sesji (RLS); danych klienta tu nie ma
// (sekcja klienta czyta je przez lib/klienci/odczyt.ts z dziennikiem podglądów).
import type { PrismaClient } from '@prisma/client'
import { accountName, accounts, orderDetail } from '@/lib/panel/dane'
import { stanCoDalej, stanCoDalejPodglad, type StanCoDalej } from '@/lib/praca/dane'
import { grosze, KOMUNIKAT_PRZESYLKA_POZYCJE, KOMUNIKAT_PRZESYLKA_POZYCJE_BEZ_ANULOWANIA, OSTRZEZENIE_PRZESYLKA_POZYCJE, powodBlokadyEdycji, powodDokumentuLubPrzesylki, PRZESYLKA_AKTYWNA } from '@/lib/rdzen/edycja'
import { flagsOf } from '@/lib/rdzen/rezerwacja'
import { przelicznikiPozycji, wartoscCzesciGr } from '@/lib/rdzen/zamiana'
import { availableOf } from '@/lib/rdzen/stan'
import { KOMUNIKAT_CIEN, kontoKarty, powodyPodgladu, pracaKarty, ustawieniaKarty, type PowodyPodgladu } from './bramka'
import { historiaZamowienia, type WpisHistorii } from './historia'
import { linkDoKanalu, linkDoOferty } from './link-kanalu'
import { type Notatka, notatkiZamowienia } from './notatki'
import { rozliczenie, type Rozliczenie } from './platnosci'
import { type PowiazanieOferty, powiazaniaOfert } from './powiaz'
import { glowneZdjecia } from '../produkty/zdjecia'
import { TYLKO_RECZNE } from './pozycje'

type Db = PrismaClient
type Env = Record<string, string | undefined>

export interface Paczka {
  id: string
  packageNo: number
  status: string
  biezaca: boolean
}

export interface DaneKarty {
  o: NonNullable<Awaited<ReturnType<typeof orderDetail>>>
  nazwaKonta: string
  /** Konto w PRACA i instancja z EKRANY_PRACA: przyciski zmian widoczne. */
  praca: boolean
  /** Linia dla konta w cieniu (zamiast przycisków). */
  cien: string | null
  coDalej: StanCoDalej | null
  /**
   * konto poza trybem PRACA. Powody nieaktywnych przycisków (płatność, status, pozycje) i te same przyciski
   * „Co dalej” co w pracy, wszystkie nieaktywne. null w pracy. Bramki serwera bez zmian.
   */
  podglad: { powody: PowodyPodgladu; coDalej: StanCoDalej | null } | null
  /** Powód, dla którego pozycji nie da się zmienić (null = można); null także w cieniu (wtedy przycisków nie ma). */
  edycja: {
    mozna: boolean
    powod: string | null
    /** sam powód ze statusu i ustawienia firmy, bez dokumentu sprzedaży i przesyłki (podział ma własną regułę). */
    powodStatusu: string | null
    /** przesyłka z pobraniem blokuje też „Podziel zamówienie” (jedna reguła z rdzeniem podziału). */
    podzialPoEtykiecie: boolean
    /** osoba może zmienić cenę i VAT pozycji (przy `mozna`). */
    ceny: boolean
    /** opłacone z góry z aktywną przesyłką (zmiana dozwolona): sprawdź paczkę i gabaryt etykiety. */
    ostrzezenie: string | null
  }
  edytowaneLokalnie: boolean
  usunieteLokalnie: Set<string>
  paczki: Paczka[]
  linkKanalu: string | null
  platnosc: Rozliczenie & { wpisy: { id: string; rodzaj: 'WPLATA' | 'DOPLATA' | 'ZWROT'; kwota: string; metoda: string | null; kiedy: Date }[] }
  zwroty: { id: string; kind: 'ZWROT' | 'KOREKTA' | 'REKLAMACJA'; status: string; createdAt: Date; moneyRefundedAt: Date | null }[]
  notatki: Notatka[]
  historia: WpisHistorii[]
  /** Ile jednostek bazowych to sztuka oferty pozycji (cena pozycji jest za sztukę oferty); brak w mapie = 1. */
  naOferte: Map<string, number>
  /** część rodziny zamian → jednostki bazowe części wcześniejszych; brak w mapie = 0. */
  przesuniecie: Map<string, number>
  /** Suma pozycji brutto w groszach (bez wysyłki): `(qty − qtyRejected) / naOferte × cena`. */
  sumaPozycjiGr: number
  /** link do oferty pozycji w kanale (Order.lines[].id → adres); brak w mapie = bez linku. */
  linkiOfert: Map<string, string>
  /** istniejące powiązanie oferty pozycji bez produktu (Order.lines[].id → powiązanie); karta pokazuje je zamiast formularza „Powiąż”. */
  powiazaniaPozycji: Map<string, PowiazanieOferty>
  /** sąsiednie zamówienia w kolejności listy (data złożenia malejąco); null = brzeg listy. */
  sasiedzi: { poprzednie: string | null; nastepne: string | null }
  /** chwila ostatniego zdarzenia zamówienia (historia), do nagłówka karty. */
  ostatniaZmiana: Date | null
  /** główne zdjęcie produktu pozycji (id produktu → id zdjęcia); brak w mapie = zaślepka. */
  zdjecia: Map<string, string>
  /** stan produktów pozycji (suma magazynów): na półce i dostępne (bez rezerwacji); brak w mapie = bez stanu. */
  stanyProduktow: Map<string, { fizycznie: number; dostepne: number }>
}

export async function daneKarty(db: Db, id: string, osoba: { userId: string; uprawnienia: ReadonlySet<string> }, opts: { tylkoLudzie?: boolean; env?: Env; now?: Date } = {}): Promise<DaneKarty | null> {
  const env = opts.env ?? process.env
  const o = await orderDetail(db, id)
  if (!o) return null
  const [accs, konto, ustawienia] = await Promise.all([accounts(db), kontoKarty(db, o, env), ustawieniaKarty(db)])
  const praca = pracaKarty(konto, env)
  const powody = praca ? null : powodyPodgladu(konto)
  const rootId = o.parentOrderId ?? o.id
  const [coDalej, paczkiRows, wpisy, zwroty, notatki, historia] = await Promise.all([
    powody ? stanCoDalejPodglad(db, o.id, osoba.uprawnienia, powody.status) : stanCoDalej(db, o.id, osoba.uprawnienia, env),
    db.order.findMany({ where: { OR: [{ id: rootId }, { parentOrderId: rootId }] }, orderBy: { packageNo: 'asc' }, select: { id: true, packageNo: true, status: true } }),
    db.orderPayment.findMany({ where: { orderId: o.id }, orderBy: { paidAt: 'desc' }, select: { id: true, kind: true, amount: true, method: true, paidAt: true } }),
    db.return.findMany({ where: { orderId: o.id }, orderBy: { createdAt: 'desc' }, select: { id: true, kind: true, status: true, createdAt: true, moneyRefundedAt: true } }),
    notatkiZamowienia(db, o.id, osoba.userId, opts.now),
    historiaZamowienia(db, o.id, { tylkoLudzie: opts.tylkoLudzie }),
  ])
  const oferty = o.lines.filter((l) => l.productId && l.offerId).map((l) => l.offerId!)
  const per = oferty.length ? await db.channelOffer.findMany({ where: { channel: o.channel, channelAccountId: o.channelAccountId, externalId: { in: oferty } }, select: { externalId: true, qtyBasePerOffer: true } }) : []
  const perOferty = new Map(per.map((x) => [x.externalId, x.qtyBasePerOffer]))
  // zamiennik („Zamień produkt”) ma przelicznik pozycji pierwotnej, jak na dokumencie i w linii faktury rdzenia
  const { naOferte, przesuniecie } = przelicznikiPozycji(o.lines, (offerId) => perOferty.get(offerId))
  const sumaPozycjiGr = o.lines.filter((l) => !l.removed).reduce((s, l) => s + wartoscCzesciGr(l.qty - l.qtyRejected, przesuniecie.get(l.id) ?? 0, naOferte.get(l.id) ?? 1, grosze(l.unitPriceGross)), 0)
  const linkiOfert = new Map<string, string>()
  for (const l of o.lines) {
    const u = linkDoOferty(konto, l.offerId)
    if (u) linkiOfert.set(l.id, u)
  }
  const bezProduktu = o.lines.filter((l) => !l.productId && !l.removed && l.offerId && !l.offerId.startsWith('bl-pozycja:'))
  const poOfercie = await powiazaniaOfert(db, { channel: o.channel, channelAccountId: o.channelAccountId }, [...new Set(bezProduktu.map((l) => l.offerId!))])
  const powiazaniaPozycji = new Map<string, PowiazanieOferty>()
  for (const l of bezProduktu) {
    const p = poOfercie.get(l.offerId!)
    if (p) powiazaniaPozycji.set(l.id, p)
  }
  const [poprzednie, nastepne] = await Promise.all([
    db.order.findFirst({ where: { OR: [{ createdAtChannel: { gt: o.createdAtChannel } }, { createdAtChannel: o.createdAtChannel, id: { lt: o.id } }] }, orderBy: [{ createdAtChannel: 'asc' }, { id: 'desc' }], select: { id: true } }),
    db.order.findFirst({ where: { OR: [{ createdAtChannel: { lt: o.createdAtChannel } }, { createdAtChannel: o.createdAtChannel, id: { gt: o.id } }] }, orderBy: [{ createdAtChannel: 'desc' }, { id: 'asc' }], select: { id: true } }),
  ])
  const produktyPozycji = [...new Set(o.lines.map((l) => l.productId).filter((x): x is string => !!x))]
  const stany = produktyPozycji.length ? await db.stock.findMany({ where: { productId: { in: produktyPozycji } }, select: { productId: true, physical: true, reserved: true } }) : []
  const stanyProduktow = new Map<string, { fizycznie: number; dostepne: number }>()
  for (const st of stany) {
    const b = stanyProduktow.get(st.productId) ?? { fizycznie: 0, dostepne: 0 }
    stanyProduktow.set(st.productId, { fizycznie: b.fizycznie + st.physical, dostepne: b.dostepne + availableOf(st) })
  }
  // cena i VAT pozycji osobnym uprawnieniem; dokument sprzedaży i przesyłkę z pobraniem rozstrzyga `powod`
  const mozeCeny = osoba.uprawnienia.has('zamowienia.ceny_pozycji')
  const f = flagsOf(o)
  const poFakturze = o.reservations.filter((r) => r.state === 'CONSUMING' || r.state === 'CONSUMED').length
  let powod = powodBlokadyEdycji(o, { poFakturze })
  if (!powod && o.channel !== 'RECZNE' && !ustawienia.edycjaZamowienKanalow) powod = TYLKO_RECZNE
  // dokument sprzedaży albo aktywna przesyłka blokują zmianę pozycji (rdzeń to samo pod blokadą);
  // podział ma własną regułę (tylko pobranie po etykiecie), więc karta trzyma osobno powód statusu (`powodStatusu`)
  const powodStatusu = powod
  if (!powod) powod = await powodDokumentuLubPrzesylki(db, o)
  // opłacone z góry z aktywną przesyłką: zmiana pozycji przechodzi, karta ostrzega o paczce i gabarycie
  const ostrzezenie =
    !powod && (await db.shipment.count({ where: { orderId: o.id, packageNo: o.packageNo, extraNo: 0, state: { in: [...PRZESYLKA_AKTYWNA] } } })) > 0 ? OSTRZEZENIE_PRZESYLKA_POZYCJE : null
  return {
    o,
    nazwaKonta: accountName(accs, o.channel, o.channelAccountId),
    praca,
    cien: praca ? null : KOMUNIKAT_CIEN,
    coDalej: powody ? null : coDalej,
    podglad: powody ? { powody, coDalej } : null,
    edycja: { mozna: praca && !powod && osoba.uprawnienia.has('zamowienia.edycja_pozycji'), powod, powodStatusu, podzialPoEtykiecie: powod === KOMUNIKAT_PRZESYLKA_POZYCJE || powod === KOMUNIKAT_PRZESYLKA_POZYCJE_BEZ_ANULOWANIA, ceny: mozeCeny, ostrzezenie },
    edytowaneLokalnie: !!f.edytowaneLokalnie,
    usunieteLokalnie: new Set(f.usunieteLokalnie ?? []),
    paczki: paczkiRows.length > 1 ? paczkiRows.map((p) => ({ ...p, biezaca: p.id === o.id })) : [],
    linkKanalu: linkDoKanalu(konto, o.externalId),
    platnosc: {
      ...rozliczenie(o, wpisy),
      wpisy: wpisy.map((w) => ({ id: w.id, rodzaj: w.kind, kwota: w.amount.toString(), metoda: w.method, kiedy: w.paidAt })),
    },
    zwroty,
    notatki,
    historia,
    naOferte,
    przesuniecie,
    sumaPozycjiGr,
    linkiOfert,
    powiazaniaPozycji,
    sasiedzi: { poprzednie: poprzednie?.id ?? null, nastepne: nastepne?.id ?? null },
    ostatniaZmiana: o.events[0]?.createdAt ?? null,
    zdjecia: await glowneZdjecia(db, o.lines.map((l) => l.productId).filter((x): x is string => !!x)),
    stanyProduktow,
  }
}
