// waluta zamówienia. `Order` nie ma pola waluty (kwoty to gołe liczby), a kanał podaje ją tylko w kopii
// zamówienia z kanału (`ChannelOrderSnapshot.currency`, ten sam klucz kanał + konto + id zamówienia co `Order`). Etap 1
// bez migracji: walutę czytamy z kopii, zamówienie bez kopii (ręczne, z API ogólnego) = PLN. Paczka dodatkowa
// („dośle później” `#dosle-n`, podział `#paczka-n`, lib/rdzen/brakuje.ts i edycja.ts) ma ten sam kanał i konto oraz numer
// zamówienia głównego z dopiskiem `#…`, więc dziedziczy jego walutę: kopię szukamy po kluczu unikalnym (kanał + konto +
// numer), najpierw pełnym numerem, potem częścią przed `#` (indeks unikalny, bez `orderId`, które bywa puste).
//
// Bezpiecznik faktury: dokument sprzedaży z Kompletora (wFirma z rozchodem i bez, KSeF) liczy kwoty jak złote, więc
// zamówienie w innej walucie nie dostaje go wcale. Faktura idzie ręcznie w programie do faktur; pakowanie, rozchód
// towaru i statusy działają jak zwykle. Ślad w historii (raz) wyklucza zamówienie z kolejki faktur w zapytaniu, więc
// nie ma pętli ponowień.
import type { Order, Prisma } from '@prisma/client'
import { walutaZamowieniaOd, walutaZamowieniaWlaczona } from '../dokumenty/ustawienia'
import { alert, type Db, type Tx } from './stan'

export const WALUTA_DOMYSLNA = 'PLN'

/** Zdarzenie w historii zamówienia: Kompletor nie wystawił dokumentu sprzedaży, bo zamówienie jest w obcej walucie. */
export const FAKTURA_OBCA_WALUTA = 'FAKTURA_OBCA_WALUTA'

/**
 * „Ponów fakturę” zamówienia zatrzymanego bezpiecznikiem waluty przed włączeniem „Faktury w walucie
 * zamówienia”. Kolejka faktur pomija zamówienia, których najnowszym śladem jest `FAKTURA_OBCA_WALUTA`.
 */
export const FAKTURA_WALUTA_PONOWIONA = 'FAKTURA_WALUTA_PONOWIONA'

/** Alert dla biura (grupa „Faktury” w powiadomieniach): faktura do wystawienia ręcznie. */
export const ALERT_FAKTURA_OBCA_WALUTA = 'FAKTURA_OBCA_WALUTA'

/** Kod waluty z kanału: wielkie litery bez spacji; brak = PLN. Nieczytelny kod zostaje, jaki jest (≠ PLN = blokada). */
export function normalizujWalute(w: string | null | undefined): string {
  const t = (w ?? '').trim().toUpperCase()
  return t || WALUTA_DOMYSLNA
}

export const obcaWaluta = (w: string | null | undefined): boolean => normalizujWalute(w) !== WALUTA_DOMYSLNA

/** Powód widoczny dla człowieka (karta, alert, odmowa „Ponów fakturę”, KSeF). */
export function powodFakturyRecznej(waluta: string): string {
  return `Zamówienie w ${normalizujWalute(waluta)}: wystaw fakturę ręcznie w programie do faktur. Jeśli Kompletor wystawił WZ przy wysyłce, wystaw fakturę do tego WZ, bez drugiego wydania towaru.`
}

export type ZamowienieDoWaluty = Pick<Order, 'id' | 'channel' | 'channelAccountId' | 'externalId' | 'parentOrderId'>

type Klient = Db | Tx

/** Numer zamówienia głównego paczki dodatkowej (część przed `#`); null = numer bez dopisku. */
function numerGlowny(externalId: string): string | null {
  const i = externalId.indexOf('#')
  return i > 0 ? externalId.slice(0, i) : null
}

/**
 * Waluty wielu zamówień jednym zapytaniem (lista, kolejka pakowania): id zamówienia → kod waluty; zamówienie bez kopii
 * z kanału = PLN. Szukanie po kluczu unikalnym kopii (kanał + konto + numer); paczka dodatkowa (`…#dosle-n`,
 * `…#paczka-n`) najpierw pełnym numerem, potem numerem zamówienia głównego (część przed `#`), na wypadek kanału, którego
 * prawdziwy numer zawiera `#`.
 */
export async function walutyZamowien(c: Klient, orders: readonly ZamowienieDoWaluty[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!orders.length) return out
  const klucz = (channel: string, konto: string, externalId: string) => `${channel}|${konto}|${externalId}`
  const szukane = new Map<string, { channel: ZamowienieDoWaluty['channel']; channelAccountId: string; externalId: string }>()
  const dodaj = (o: ZamowienieDoWaluty, externalId: string) => szukane.set(klucz(o.channel, o.channelAccountId, externalId), { channel: o.channel, channelAccountId: o.channelAccountId, externalId })
  for (const o of orders) {
    dodaj(o, o.externalId)
    const g = numerGlowny(o.externalId)
    if (g) dodaj(o, g)
  }
  const kopie = await c.channelOrderSnapshot.findMany({
    where: { OR: [...szukane.values()] },
    select: { channel: true, channelAccountId: true, externalId: true, currency: true },
  })
  const poKluczu = new Map<string, string>()
  for (const k of kopie) {
    const kl = klucz(k.channel, k.channelAccountId, k.externalId)
    // klucz jest unikalny; gdyby kopii było kilka, wygrywa waluta inna niż PLN (bezpieczniej dla faktury)
    if (!poKluczu.has(kl) || obcaWaluta(k.currency)) poKluczu.set(kl, normalizujWalute(k.currency))
  }
  for (const o of orders) {
    const g = numerGlowny(o.externalId)
    const w = poKluczu.get(klucz(o.channel, o.channelAccountId, o.externalId)) ?? (g ? poKluczu.get(klucz(o.channel, o.channelAccountId, g)) : undefined)
    out.set(o.id, w ?? WALUTA_DOMYSLNA)
  }
  return out
}

export async function walutaZamowienia(c: Klient, o: ZamowienieDoWaluty): Promise<string> {
  return (await walutyZamowien(c, [o])).get(o.id) ?? WALUTA_DOMYSLNA
}

/** Waluta po samym id zamówienia (np. KSeF, przejścia statusów); brak zamówienia = PLN. */
export async function walutaZamowieniaPoId(c: Klient, orderId: string): Promise<string> {
  const o = await c.order.findUnique({ where: { id: orderId }, select: { id: true, channel: true, channelAccountId: true, externalId: true, parentOrderId: true } })
  return o ? walutaZamowienia(c, o) : WALUTA_DOMYSLNA
}

/**
 * Bezpiecznik faktury (jedno miejsce dla wszystkich dróg: kolejka faktur z rozchodem i bez, ponowienie po timeoucie,
 * „Ponów fakturę” z karty i z automatu, KSeF). null = zamówienie w PLN, dokument może iść. Inaczej powód dla człowieka;
 * przy `oznacz` także ślad w historii (gdy najnowszy ślad nie jest już blokadą) i alert dla biura (raz na każdą paczkę),
 * bez ruchu stanu.
 *
 * droga wFirmy (`wfirma`) przy włączonym „Faktury w walucie zamówienia” przepuszcza obcą walutę (faktura w tej
 * walucie, kurs liczy wFirma), ale tylko zamówieniu przyjętemu od chwili włączenia, albo takiemu,
 * którego najnowszy ślad to „Ponów fakturę” (przeglądu: wcześniejsze mogły dostać fakturę ręcznie). `ponowienie` =
 * samo kliknięcie „Ponów fakturę” (ono zapisuje ślad ponowienia). KSeF i każda droga bez `wfirma` zostają przy blokadzie.
 */
export async function blokadaFakturyWaluta(
  c: Klient,
  o: ZamowienieDoWaluty,
  opts: { oznacz?: { actorId: string }; wfirma?: boolean; ponowienie?: boolean } = {},
): Promise<{ waluta: string; powod: string } | null> {
  const waluta = await walutaZamowienia(c, o)
  if (!obcaWaluta(waluta)) return null
  if (opts.wfirma) {
    const settings = await ustawieniaFirmy(c)
    if (walutaZamowieniaWlaczona(settings)) {
      if (opts.ponowienie || !(await czekaNaPonowienie(c, o.id, settings))) return null
      const powod = tekstWalutaSprzedWlaczenia(waluta)
      if (opts.oznacz) await oznaczFaktureReczna(c, o, waluta, powod, opts.oznacz.actorId, 'Kompletor nie wystawi jej sam.')
      return { waluta, powod }
    }
  }
  const powod = powodFakturyRecznej(waluta)
  if (opts.oznacz) await oznaczFaktureReczna(c, o, waluta, powod, opts.oznacz.actorId, 'Kompletor nie wystawia dokumentów sprzedaży w walucie innej niż PLN; pakowanie i wysyłka idą jak zwykle.')
  return { waluta, powod }
}

/**
 * jedno źródło tekstu dla zamówienia w obcej walucie sprzed włączenia „Faktury w walucie zamówienia” (karta,
 * alert, odmowa automatu).
 */
export function tekstWalutaSprzedWlaczenia(waluta: string): string {
  return `Zamówienie w ${normalizujWalute(waluta)} sprzed włączenia faktur w walucie zamówienia. Wystawione ręcznie? Jeśli nie, kliknij „Ponów fakturę”.`
}

async function ustawieniaFirmy(c: Klient): Promise<Prisma.JsonValue | null> {
  return (await c.organization.findFirst({ select: { settings: true } }))?.settings ?? null
}

/** ustawienie firmy „Faktury w walucie zamówienia” (wFirma). */
export async function fakturyWWalucie(c: Klient): Promise<boolean> {
  return walutaZamowieniaWlaczona(await ustawieniaFirmy(c))
}

type SladWaluty = typeof FAKTURA_OBCA_WALUTA | typeof FAKTURA_WALUTA_PONOWIONA

/** Najnowszy ślad z pary blokada / ponowienie; remis czasu = blokada (bezpieczniej). */
function najnowszySlad(ev: readonly { kind: string; createdAt: Date }[]): SladWaluty | null {
  let best: { kind: string; createdAt: Date } | null = null
  for (const e of ev) {
    if (e.kind !== FAKTURA_OBCA_WALUTA && e.kind !== FAKTURA_WALUTA_PONOWIONA) continue
    const t = e.createdAt.getTime()
    if (!best || t > best.createdAt.getTime() || (t === best.createdAt.getTime() && e.kind === FAKTURA_OBCA_WALUTA)) best = e
  }
  return (best?.kind as SladWaluty | undefined) ?? null
}

async function sladWaluty(c: Klient, orderId: string): Promise<SladWaluty | null> {
  return najnowszySlad(await c.orderEvent.findMany({ where: { orderId, kind: { in: [FAKTURA_OBCA_WALUTA, FAKTURA_WALUTA_PONOWIONA] } }, select: { kind: true, createdAt: true } }))
}

/**
 * zamówienie zatrzymane bezpiecznikiem waluty: najnowszy ślad to blokada (`FAKTURA_OBCA_WALUTA`), a nie
 * „Ponów fakturę”. Sekwencja włączony → „Ponów fakturę” → wyłączony dopisuje nową blokadę, więc liczy się kolejność.
 */
export async function walutaZatrzymana(c: Klient, orderId: string): Promise<boolean> {
  return (await sladWaluty(c, orderId)) === FAKTURA_OBCA_WALUTA
}

/** Id zamówień zatrzymanych bezpiecznikiem waluty (najnowszy ślad = blokada); filtr kolejki faktur. */
export async function zamowieniaZatrzymaneWaluta(c: Klient): Promise<string[]> {
  const ev = await c.orderEvent.findMany({ where: { kind: { in: [FAKTURA_OBCA_WALUTA, FAKTURA_WALUTA_PONOWIONA] } }, select: { orderId: true, kind: true, createdAt: true } })
  const po = new Map<string, { kind: string; createdAt: Date }[]>()
  for (const e of ev) po.set(e.orderId, [...(po.get(e.orderId) ?? []), e])
  return [...po].filter(([, l]) => najnowszySlad(l) === FAKTURA_OBCA_WALUTA).map(([id]) => id)
}

/**
 * Reguła przy włączonym wyłączniku: czy automat musi czekać na „Ponów fakturę”. Karta przy wyłączonym wyłączniku
 * pokazuje „wystaw ręcznie” od chwili przyjęcia zamówienia, więc biuro mogło wystawić fakturę ręcznie każdemu zamówieniu
 * przyjętemu przed włączeniem, niezależnie od statusu. Dlatego:
 *   - najnowszy ślad to blokada = czeka;
 *   - najnowszy ślad to „Ponów fakturę” z chwili nie wcześniejszej niż `walutaZamowieniaOd` = nie czeka (ponowienie
 *     sprzed bieżącego włączenia nie liczy się: po nim wyłącznik był wyłączony);
 *   - inaczej czeka zamówienie przyjęte (`Order.createdAt`; paczka dodatkowa: przyjęcie zamówienia głównego) przed
 *     `walutaZamowieniaOd`.
 * Włączony bez chwili włączenia albo brak zamówienia = czeka.
 */
async function czekaNaPonowienie(c: Klient, orderId: string, settings: Prisma.JsonValue | null): Promise<boolean> {
  const od = walutaZamowieniaOd(settings)
  if (!od) return true
  const slady = await c.orderEvent.findMany({ where: { orderId, kind: { in: [FAKTURA_OBCA_WALUTA, FAKTURA_WALUTA_PONOWIONA] } }, select: { kind: true, createdAt: true } })
  const slad = najnowszySlad(slady)
  if (slad === FAKTURA_OBCA_WALUTA) return true
  if (slad === FAKTURA_WALUTA_PONOWIONA && slady.some((e) => e.kind === FAKTURA_WALUTA_PONOWIONA && e.createdAt.getTime() >= od.getTime())) return false
  const o = await c.order.findUnique({ where: { id: orderId }, select: { createdAt: true, parentOrderId: true } })
  if (!o) return true
  const glowne = o.parentOrderId ? await c.order.findUnique({ where: { id: o.parentOrderId }, select: { createdAt: true } }) : o
  return !glowne || glowne.createdAt.getTime() < od.getTime()
}

/**
 * zamówienie w obcej walucie, które przy włączonym „Faktury w walucie zamówienia” czeka na „Ponów fakturę”
 * (karta, „Dokument przed wysyłką”, samo „Ponów fakturę”). PLN albo wyłącznik wyłączony = false.
 */
export async function walutaCzekaNaPonowienie(c: Klient, o: ZamowienieDoWaluty): Promise<boolean> {
  if (!obcaWaluta(await walutaZamowienia(c, o))) return false
  const settings = await ustawieniaFirmy(c)
  return walutaZamowieniaWlaczona(settings) && (await czekaNaPonowienie(c, o.id, settings))
}

/** Jak `walutaCzekaNaPonowienie`, po samym id zamówienia (przejścia statusów); brak zamówienia = false. */
export async function walutaCzekaNaPonowieniePoId(c: Klient, orderId: string): Promise<boolean> {
  const o = await c.order.findUnique({ where: { id: orderId }, select: { id: true, channel: true, channelAccountId: true, externalId: true, parentOrderId: true } })
  return o ? walutaCzekaNaPonowienie(c, o) : false
}

async function oznaczFaktureReczna(c: Klient, o: ZamowienieDoWaluty, waluta: string, powod: string, actorId: string, dopisek: string): Promise<void> {
  // nowy ślad blokady, gdy najnowszy nie jest już blokadą (po „Ponów fakturę” i wyłączeniu wyłącznika)
  if ((await sladWaluty(c, o.id)) !== FAKTURA_OBCA_WALUTA) await c.orderEvent.create({ data: { orderId: o.id, kind: FAKTURA_OBCA_WALUTA, actorId, data: { waluta, powod } } })
  // klucz per paczka (każda paczka to osobne zamówienie z własnym id; zamówienie główne ma ten sam klucz co przed zmianą)
  await alert(c, ALERT_FAKTURA_OBCA_WALUTA, o.id, `${powod} ${dopisek}`, `faktura-obca-waluta:${o.id}`)
}
