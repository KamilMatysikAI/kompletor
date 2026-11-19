// Szkic korekty FA(3) przy zwrocie: firma z programem „KSeF bezpośrednio”. Bez zapisu w bazie
// i bez wysyłki (wysyłka i lista korekt osobno). Korekta metodą różnicy: wiersz na każdą zwróconą pozycję
// zamówienia z ujemną ilością i wartością (część pozycji z zamówienia w proporcji do zwróconej ilości bazowej).
// Nabywca jak w szkicu faktury: dane z bazy tylko w pamięci, bez nich stała zastępcza. Faktura korygowana = szkic KSeF
// zamówienia (numer z serii, jeśli zatwierdzony; inaczej numer szkicu i „poza KSeF”, NrKSeFN).
import type { PrismaClient } from '@prisma/client'
import { organizationIdOf } from '../db'
import { stawka } from '../dokumenty/pozycje'
import { nabywcaKsef } from '../klienci/wejscia'
import { umiePrzygotowacKorekte } from '../dokumenty/kontrakt'
import { dostawcaDokumentow } from '../dokumenty/dostawcy'
import type { NabywcaFa3, ProblemFa3, WejscieFa3, WierszFa3 } from '../ksef/fa3/typy'
import { parseKonfiguracjaKsef, programFaktur } from '../ksef/konfiguracja'
import { idSzkicu, NABYWCA_ZASTEPCZY } from '../ksef/szkice'
import { toWarsaw } from '../rdzen/kalendarz'
import { zrodloStanu } from '../rdzen/zrodlo-stanu'
import { wartoscCzesciGr } from '../rdzen/zamiana'
import { przelicznikiZZamowienia } from './przelicznik-zamowienia'
import { RODZAJ_ZWROTU } from './statusy'

/**
 * Wiersz korekty jednej pozycji zamówienia (czysta funkcja). Ilość i jednostka jak na fakturze
 * (lib/dokumenty/pozycje.ts): produkt na wagę w kg z ilości bazowej w gramach, bez względu na sztuki oferty
 * (wcześniej gramy szły jako kg, ×1000, a pozycja z ofertą wagową jako „szt.”).
 * Zamiennik („Zamień produkt”) nie ma `qtyChannel`, a jego cena jest za sztukę oferty pozycji
 * pierwotnej, więc dostaje `naOferte` z `przelicznikiPozycji`. Bez `naOferte` przelicznik wynika z `qty / qtyChannel`
 * (pozycja z ofertą) albo 1. `szkicKorektyKsef` podaje `naOferte` zawsze, z `przelicznikiZZamowienia`.
 * wartość liczona od części WYDANEJ (qty − qtyOdrzucone), tą samą
 * regułą co faktura: `wartoscCzesciGr(zwrócone bazowe, przesunięcie, przelicznik, cena)`, czyli round(zwrócone × cena /
 * przelicznik), a dla części rodziny zamian przyrost wartości rodziny od `przesuniecie`. Wcześniej proporcja zwrotu
 * mnożyła sztuki CAŁEJ pozycji, razem z odrzuconymi (2 szt. po 10,00 zł, 1 zamieniona, zwrot wydanej 1 szt. = −20,00 zł).
 * Zestaw (`zestaw: true`): zwrot liczy się w jednostkach składników, więc wartość wydanej części × proporcja zwrotu.
 */
export function wierszKorektyKsef(w: {
  nazwa: string
  jednostka: 'SZT' | 'KG' | null
  qty: number
  qtyChannel: number | null
  unitPriceGross: number
  vatRate: string | null
  zwroconeBazowe: number
  wydaneBazowe: number
  naOferte?: number
  /** sztuki odrzucone pozycji (zamienione, dosłane, brak): nie ma ich na fakturze, więc nie ma ich w korekcie */
  qtyOdrzucone?: number
  /** część rodziny zamian: jednostki bazowe części wcześniejszych (`przelicznikiPozycji().przesuniecie`) */
  przesuniecie?: number
  zestaw?: boolean
}): WierszFa3 {
  const naOferte = w.naOferte && w.naOferte > 0 ? w.naOferte : w.qtyChannel && w.qtyChannel > 0 ? w.qty / w.qtyChannel : 1
  const dostarczone = Math.max(0, w.qty - (w.qtyOdrzucone ?? 0))
  const cena = Math.round(w.unitPriceGross * 100)
  const przes = w.przesuniecie ?? 0
  let bazowe: number // zwrócone jednostki bazowe pozycji (dla zestawu: część wydanych zestawów)
  let brutto: number
  if (w.zestaw) {
    const baza = w.wydaneBazowe || dostarczone
    const czesc = baza > 0 ? Math.min(1, w.zwroconeBazowe / baza) : 1
    bazowe = czesc * dostarczone
    brutto = Math.round(czesc * wartoscCzesciGr(dostarczone, przes, naOferte, cena))
  } else {
    bazowe = Math.min(w.zwroconeBazowe, dostarczone)
    brutto = wartoscCzesciGr(bazowe, przes, naOferte, cena)
  }
  if (w.jednostka === 'KG') {
    const kg = Math.round(bazowe) / 1000
    return { nazwa: w.nazwa, jednostka: 'kg', ilosc: -kg, cenaBruttoGr: kg > 0 ? Math.round(brutto / kg) : cena, bruttoGr: -brutto, stawka: stawka(w.vatRate ?? '23') }
  }
  const ilosc = Math.round((bazowe / naOferte) * 1000) / 1000
  return { nazwa: w.nazwa, jednostka: 'szt.', ilosc: -ilosc, cenaBruttoGr: cena, bruttoGr: -brutto, stawka: stawka(w.vatRate ?? '23') }
}

export type WynikSzkicuKorekty = { ok: true; xml: string; nazwaPliku: string; wejscie: WejscieFa3 } | { ok: false; powod: string; problemy: ProblemFa3[] }

/**
 * `opts.wysylka` = korekta do wysyłki (lib/ksef/wysylka.ts): numer i data z serii korekt, nabywca z bazy
 * wymagany przy fakturze na firmę, XML tylko w pamięci. Bez `wysylka` = szkic (do pobrania).
 * `opts.actorId` = osoba pobierająca szkic (User.id z sesji): nabywca czytany wg jej uprawnień, ślad KLIENT_PODGLAD na
 * nią (audyt bezpieczeństwa). Bez niego automat `system:ksef` (wysyłka z workera, PDF korekty, sumy przed wysyłką).
 */
export async function szkicKorektyKsef(db: PrismaClient, returnId: string, opts: { now?: Date; wysylka?: { numer: string; dataWystawienia: string }; actorId?: string } = {}): Promise<WynikSzkicuKorekty> {
  const organizationId = organizationIdOf(db)
  const now = opts.now ?? new Date()
  const org = await db.organization.findFirst({ select: { settings: true } })
  if (programFaktur(org?.settings, { maWfirme: (await zrodloStanu(db)) === 'WFIRMA' }) !== 'ksef') return { ok: false, powod: 'Firma nie ma ustawionego programu „KSeF bezpośrednio”.', problemy: [] }
  const r = await db.return.findUnique({ where: { id: returnId }, select: { id: true, kind: true, status: true, orderId: true, lines: { select: { orderLineId: true, productId: true, qty: true } } } })
  if (!r) return { ok: false, powod: 'Nie ma takiego zwrotu.', problemy: [] }
  if (r.status === 'ODRZUCONY') return { ok: false, powod: 'Zwrot odrzucony: korekta nie jest potrzebna.', problemy: [] }
  const o = await db.order.findUniqueOrThrow({ where: { id: r.orderId }, select: { id: true, packageNo: true, wantInvoiceNip: true, channel: true, channelAccountId: true, lines: { select: { id: true, channelName: true, qty: true, qtyChannel: true, unitPriceGross: true, vatRate: true, productId: true, externalLineId: true, offerId: true, qtyRejected: true, removed: true } } } })
  const draft = await db.ksefInvoiceDraft.findFirst({ where: { orderId: o.id, packageNo: o.packageNo, returnId: '' }, select: { numer: true, createdAt: true, dataWystawienia: true, ksefNumer: true } })
  if (!draft) return { ok: false, powod: 'Zamówienie nie ma szkicu faktury KSeF: najpierw przygotuj fakturę na karcie zamówienia.', problemy: [] }
  const wantNip = o.wantInvoiceNip
  const produkty = new Map((await db.product.findMany({ where: { id: { in: o.lines.flatMap((l) => (l.productId ? [l.productId] : [])) } }, select: { id: true, nameAccounting: true, unit: true, kind: true } })).map((p) => [p.id, p]))
  // zwrócone jednostki bazowe per pozycja zamówienia (składniki zestawu sumują się; proporcja liczy się od pozycji)
  const zwrot = new Map<string, number>()
  for (const l of r.lines) zwrot.set(l.orderLineId, (zwrot.get(l.orderLineId) ?? 0) + l.qty)
  const consumed = await db.reservation.groupBy({ by: ['orderLineId'], where: { orderId: o.id, state: 'CONSUMED' }, _sum: { qtyBase: true } })
  const wydane = new Map(consumed.map((c) => [c.orderLineId, c._sum.qtyBase ?? 0]))
  // przelicznik pozycji pierwotnej dla zamienników. Przelicznik z proporcji
  // zapisanej w zamówieniu (`qty / qtyChannel`), aktualna oferta tylko bez niej, bo przelicznik oferty wolno zmienić po wysyłce
  const oferty = [...new Set(o.lines.filter((l) => l.productId && l.offerId).map((l) => l.offerId!))]
  const perOferty = oferty.length ? new Map((await db.channelOffer.findMany({ where: { channel: o.channel, channelAccountId: o.channelAccountId, externalId: { in: oferty } }, select: { externalId: true, qtyBasePerOffer: true } })).map((x) => [x.externalId, x.qtyBasePerOffer])) : new Map<string, number>()
  const prz = przelicznikiZZamowienia(o.lines,(offerId) => perOferty.get(offerId))
  const wiersze: WierszFa3[] = []
  for (const [lineId, qty] of zwrot) {
    const l = o.lines.find((x) => x.id === lineId)
    if (!l) continue
    const p = l.productId ? produkty.get(l.productId) : undefined
    wiersze.push(
      wierszKorektyKsef({ nazwa: l.channelName?.trim() || p?.nameAccounting || 'pozycja', jednostka: p?.unit ?? null, qty: l.qty, qtyChannel: l.qtyChannel, unitPriceGross: Number(l.unitPriceGross), vatRate: l.vatRate, zwroconeBazowe: qty, wydaneBazowe: wydane.get(lineId) ?? 0, qtyOdrzucone: l.qtyRejected, przesuniecie: prz.przesuniecie.get(lineId) ?? 0, zestaw: p?.kind === 'BUNDLE', naOferte: prz.naOferte.get(lineId) ?? 1 }),
    )
  }
  const cfgK = parseKonfiguracjaKsef(org?.settings ?? null)
  const zBazy = await nabywcaKsef(db, o.id, undefined, opts.actorId)
  const nabywca: NabywcaFa3 = zBazy ?? { nip: null, nazwa: opts.wysylka ? 'Osoba prywatna' : NABYWCA_ZASTEPCZY }
  if (opts.wysylka && !zBazy && wantNip) return { ok: false, powod: 'Brak danych nabywcy do korekty.', problemy: [{ kod: 'brak-nabywcy', pole: 'Podmiot2', tekst: 'Brak danych nabywcy do faktury (NIP, nazwa, adres): uzupełnij je na karcie zamówienia.' }] }
  const numer = draft.numer ?? `SZKIC-${idSzkicu(organizationId, o.id, o.packageNo)}`
  // przez dostawcę dokumentów firmy (zdolność „przygotuj.korekte”), jak każdy dokument sprzedaży
  const dostawca = dostawcaDokumentow('ksef')
  if (!umiePrzygotowacKorekte(dostawca)) return { ok: false, powod: 'Program do faktur nie składa szkicu korekty.', problemy: [] }
  const wejscie: WejscieFa3 = {
    numer: opts.wysylka?.numer ?? `SZKIC-KOR-${r.id}`,
    dataWystawienia: opts.wysylka?.dataWystawienia ?? toWarsaw(now).day,
    wytworzono: now,
    waluta: 'PLN',
    rodzaj: 'KOR',
    korekta: { przyczyna: RODZAJ_ZWROTU[r.kind] === 'Reklamacja' ? 'Reklamacja: zwrot towaru' : 'Zwrot towaru', numer, dataWystawienia: draft.dataWystawienia ?? toWarsaw(draft.createdAt).day, nrKsef: draft.ksefNumer },
    sprzedawca: cfgK.sprzedawca ?? { nip: '', nazwa: '', adres: { kodKraju: 'PL', linia1: '' } },
    nabywca,
    wiersze,
    podstawaZwolnienia: cfgK.podstawaZwolnienia,
    systemInfo: 'Kompletor',
  }
  const fa = dostawca.przygotujKorekte(wejscie)
  const problemy = [...cfgK.problemy, ...(fa.problems as ProblemFa3[])]
  if (!fa.xml || problemy.length) return { ok: false, powod: 'Szkic korekty ma problemy danych.', problemy }
  return { ok: true, xml: fa.xml, nazwaPliku: `korekta-${r.id}.xml`, wejscie }
}
