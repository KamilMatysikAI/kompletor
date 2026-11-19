// Ochrona przed drugą fakturą po przejściu z BaseLinkera: zamówienie, które dostało fakturę w BaseLinkerze, nigdy nie
// dostaje drugiej faktury ani dokumentu sprzedaży z Kompletora. Źródła prawdy (oba z odczytu BL, bez żadnego zapisu):
// zdarzenie `FAKTURA_BL` z rozliczenia faktury (lib/cien/faktury-bl.ts → applyBlInvoice) i kopia faktury BL
// (`BlInvoiceSnapshot`) po numerze zamówienia BL. Kopia łapie też zamówienia z samymi pozycjami bez stanu (e-book),
// które przy rozliczeniu zdarzenia nie dostają, oraz faktury czekające jeszcze na WZ. Korekty BL się nie liczą.
// Paczka dodatkowa („dośle później”) dziedziczy fakturę zamówienia głównego: faktura BL obejmowała całe zamówienie.
import type { Order, Prisma } from '@prisma/client'
import { flagsOf, mergeFlags } from './rezerwacja'
import { advisoryLock, alert, type Db, DEFAULT_WAREHOUSE, orderLockKey, outbox, runTx, StockBook, type Tx } from './stan'

/** Zdarzenie w historii zamówienia: Kompletor nie wystawił faktury, bo zamówienie ma fakturę z BaseLinkera. */
export const FAKTURA_BL_POMINIETA = 'FAKTURA_BL_POMINIETA'

type Klient = Db | Tx

/** Numer faktury BL zamówienia (albo zamówienia głównego paczki dodatkowej); null = brak faktury BL. */
export async function fakturaZBl(c: Klient, o: Pick<Order, 'id' | 'blOrderId' | 'parentOrderId'>): Promise<string | null> {
  const ids = [o.id, ...(o.parentOrderId ? [o.parentOrderId] : [])]
  const ev = await c.orderEvent.findFirst({ where: { orderId: { in: ids }, kind: 'FAKTURA_BL' }, orderBy: { createdAt: 'asc' }, select: { data: true } })
  if (ev) {
    const doc = (ev.data as { docId?: unknown } | null)?.docId
    return typeof doc === 'string' && doc ? doc : 'faktura BL'
  }
  const blIds = o.blOrderId !== null ? [o.blOrderId] : []
  if (o.parentOrderId) {
    const p = await c.order.findUnique({ where: { id: o.parentOrderId }, select: { blOrderId: true } })
    if (p?.blOrderId != null) blIds.push(p.blOrderId)
  }
  if (!blIds.length) return null
  const inv = await c.blInvoiceSnapshot.findFirst({
    where: { blOrderId: { in: blIds }, OR: [{ kind: null }, { kind: 'normal' }] },
    orderBy: { blInvoiceId: 'asc' },
    select: { number: true, externalNumber: true },
  })
  return inv ? inv.externalNumber ?? inv.number : null
}

/**
 * Ślad w historii zamówienia (raz na zamówienie): dzięki niemu kolejka faktur i automat „bez paczki” pomijają to
 * zamówienie już w zapytaniu, zamiast brać je w każdym przebiegu.
 */
export async function oznaczPominietaFaktureBl(c: Klient, orderId: string, numer: string, actorId: string): Promise<void> {
  if (await c.orderEvent.findFirst({ where: { orderId, kind: FAKTURA_BL_POMINIETA }, select: { id: true } })) return
  await c.orderEvent.create({ data: { orderId, kind: FAKTURA_BL_POMINIETA, actorId, data: { numer, powod: 'Zamówienie ma fakturę wystawioną w BaseLinkerze: Kompletor nie wystawia drugiej.' } } })
}

// ─── Rezerwacje i braki po zastosowanej fakturze BL ─────────────────────────────

/**
 * Konto zamówienia w podglądzie obok BL (`statusMode = CIEN`). Tylko tam samonaprawa i wykluczenie z przydziału
 * rozliczają po cichu to, co zostało po fakturze BL. W trybie pracy (i dla konta bez konfiguracji) rozliczenie faktury
 * zamyka tylko braki pokryte przez WZ do niej, a każdą zostawioną rezerwację albo brak samonaprawa zgłasza biuru.
 */
export async function kontoWPodgladzie(c: Klient, o: Pick<Order, 'channel' | 'channelAccountId'>): Promise<boolean> {
  const k = await c.channelConfig.findFirst({ where: { channel: o.channel, channelAccountId: o.channelAccountId }, select: { statusMode: true } })
  return k?.statusMode === 'CIEN'
}

/** Alert dla biura: zamówienie konta w trybie pracy z fakturą BL nadal trzyma towar albo czeka na brak. */
export const FAKTURA_BL_TOWAR_W_PRACY = 'FAKTURA_BL_TOWAR_W_PRACY'

type ZamowienieDoZgloszenia = Pick<Order, 'id' | 'channel' | 'channelAccountId' | 'channelNumber' | 'externalId'>

/** Jeden alert na zamówienie (klucz deduplikacji wspólny dla rozliczenia faktury i samonaprawy). */
export async function zglosTowarPoFakturzeBl(c: Klient, o: ZamowienieDoZgloszenia, sklep?: string): Promise<boolean> {
  const nazwa = sklep ?? (await c.channelConfig.findFirst({ where: { channel: o.channel, channelAccountId: o.channelAccountId }, select: { name: true } }))?.name ?? o.channel
  const numer = o.channelNumber ?? o.externalId
  return alert(
    c,
    FAKTURA_BL_TOWAR_W_PRACY,
    o.id,
    `Zamówienie ${nazwa} ${numer} ma fakturę wystawioną w poprzednim systemie (BaseLinker), a w Kompletorze nadal ma odłożony towar ` +
      `albo brak czekający na dostawę. Kompletor nie wystawi do niego drugiej faktury. ${PROCEDURA_FAKTURY_BL}`,
    `faktura-bl-tryb-pracy:${o.id}`,
  )
}

// ─── Po przełączeniu konta w tryb pracy ─────────────────────────────

/** Statusy przed spakowaniem: zamówienie w nich stoi w kolejce pakowania. */
export const PRZED_SPAKOWANIEM = ['DO_REALIZACJI', 'ZBIERANIE', 'ZEBRANE'] as const satisfies readonly Order['status'][]

/**
 * Jedna procedura dla zamówienia z fakturą BL na koncie w trybie pracy: ten sam tekst w alertach, odmowie
 * pakowania i instrukcji przełączenia (docs/migracja-z-baselinkera.md, sekcja „Zamówienie z fakturą z BaseLinkera po
 * przełączeniu”). Drogi klikania sprawdzone w kodzie: „Zmień status…” w menu „Więcej” karty zamówienia
 * (app/(panel)/zamowienia/[id]/naglowek.tsx, uprawnienie `zamowienia.status_dowolny`), „Pakuj mimo faktury z
 * BaseLinkera” i „Wyślij bez faktury” jako przyciski „Co dalej” spoza trzech głównych, czyli też w menu „Więcej”
 * (lib/praca/przejscia-ekran.ts, app/(panel)/zamowienia/[id]/praca.tsx `PrzyciskiCoDalej`).
 */
export const PROCEDURA_FAKTURY_BL =
  'Zamówienie kończy BaseLinker: spakuj je i wyślij w BaseLinkerze, w Kompletorze go nie pakuj (towar zdjął już dokument WZ do tej faktury). ' +
  'W Kompletorze: karta zamówienia → „Więcej” → „Zmień status…” → „Do wyjaśnienia”, w polu „Powód” wpisz „kończy BL”. ' +
  'Jeśli do zamówienia dodano towar po fakturze i tylko ten towar ma wyjść z Kompletora: karta zamówienia → „Więcej” → „Pakuj mimo faktury z BaseLinkera”, ' +
  'spakuj go, potem „Więcej” → „Wyślij bez faktury” (Kompletor założy do niego dokument WZ). ' +
  'Obie pozycje w „Więcej” wymagają uprawnienia „Zmiana statusu na dowolny dozwolony” (domyślnie właściciel): jeśli ich nie widzisz albo są nieaktywne, przekaż zamówienie osobie z tym uprawnieniem.'

/**
 * Odmowa pakowania z powodu faktury BL: paczka dodatkowa („Dośle później” albo podział) to towar
 * z pozycji zamówienia BL, więc faktura i WZ do niej z BaseLinkera objęły go razem z zamówieniem głównym; „Pakuj mimo…”
 * i WZ z Kompletora zdjęłyby go drugi raz.
 */
export function odmowaPakowaniaFakturaBl(numer: string, paczkaDodatkowa: boolean): string {
  if (!paczkaDodatkowa) return `Zamówienie ma fakturę ${numer} wystawioną w BaseLinkerze, Kompletor wstrzymał pakowanie. ${PROCEDURA_FAKTURY_BL}`
  return (
    `To paczka dodatkowa zamówienia z fakturą ${numer} z BaseLinkera: faktura i dokument WZ do niej objęły już towar tej paczki, ` +
    'więc Kompletor jej nie pakuje (drugi WZ zdjąłby towar drugi raz). Wyślij ten towar w BaseLinkerze razem z zamówieniem. ' +
    'W Kompletorze: karta paczki → „Więcej” → „Zmień status…” → „Do wyjaśnienia”, w polu „Powód” wpisz „kończy BL” ' +
    '(wymaga uprawnienia „Zmiana statusu na dowolny dozwolony”, domyślnie właściciel; jeśli go nie masz, przekaż paczkę osobie z tym uprawnieniem).'
  )
}

/** Odmowa „Pakuj mimo faktury z BaseLinkera”; `wykonajPrzejscie` pokazuje treść osobie. */
export class PakujMimoError extends Error {}

/** Faktura BL znana tylko z kopii, jeszcze bez rozliczenia: towar zamówienia objęty fakturą czeka na WZ do niej. */
export const ODMOWA_NIEROZLICZONA_FAKTURA_BL =
  'Faktura z BaseLinkera czeka jeszcze na dokument WZ do niej, więc odłożony towar to towar objęty tą fakturą, a nie dodany po niej. ' +
  '„Pakuj mimo…” teraz zdjęłoby go drugi raz. Spróbuj, gdy Kompletor rozliczy fakturę (zwykle kilka minut po wystawieniu WZ w programie do faktur); ' +
  'do tego czasu zamówienie kończy BaseLinker.'

/** Zamówienie pod blokadą pakowania: numer faktury BL; null = pakowanie bez ograniczeń. */
export async function blokadaPakowaniaFakturaBl(c: Klient, o: Pick<Order, 'id' | 'blOrderId' | 'parentOrderId' | 'channel' | 'channelAccountId' | 'flags'>): Promise<string | null> {
  if (flagsOf(o).pakujMimoFakturyBl) return null
  // konto w podglądzie obok BL: zachowanie bez zmian (pakowanie tylko próbne, BL prowadzi zamówienia)
  if (await kontoWPodgladzie(c, o)) return null
  // firma bez BaseLinkera nie ma ani zdarzeń FAKTURA_BL, ani kopii faktur BL: null
  return fakturaZBl(c, o)
}

/**
 * To samo co `blokadaPakowaniaFakturaBl` dla listy zamówień (kolejka pakowania): id → numer faktury BL. Tylko zamówienia
 * kont w trybie pracy (wywołujący odfiltrowuje podgląd) bez flagi „Pakuj mimo faktury z BaseLinkera”.
 */
export async function zamowieniaZFakturaBl(c: Klient, orders: readonly Pick<Order, 'id' | 'blOrderId' | 'parentOrderId' | 'flags'>[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const kandydaci = orders.filter((o) => !flagsOf(o).pakujMimoFakturyBl)
  if (!kandydaci.length) return out
  const ids = [...new Set(kandydaci.flatMap((o) => [o.id, ...(o.parentOrderId ? [o.parentOrderId] : [])]))]
  const zdarzenia = await c.orderEvent.findMany({ where: { orderId: { in: ids }, kind: 'FAKTURA_BL' }, orderBy: { createdAt: 'asc' }, select: { orderId: true, data: true } })
  const poZdarzeniu = new Map<string, string>()
  for (const e of zdarzenia) {
    if (poZdarzeniu.has(e.orderId)) continue
    const doc = (e.data as { docId?: unknown } | null)?.docId
    poZdarzeniu.set(e.orderId, typeof doc === 'string' && doc ? doc : 'faktura BL')
  }
  const rodzice = [...new Set(kandydaci.flatMap((o) => (o.parentOrderId ? [o.parentOrderId] : [])))]
  const blRodzica = new Map(
    rodzice.length ? (await c.order.findMany({ where: { id: { in: rodzice } }, select: { id: true, blOrderId: true } })).map((p) => [p.id, p.blOrderId] as const) : [],
  )
  const blIds = [...new Set(kandydaci.flatMap((o) => [o.blOrderId, o.parentOrderId ? (blRodzica.get(o.parentOrderId) ?? null) : null]).filter((x): x is number => x !== null))]
  const kopie = blIds.length
    ? await c.blInvoiceSnapshot.findMany({ where: { blOrderId: { in: blIds }, OR: [{ kind: null }, { kind: 'normal' }] }, orderBy: { blInvoiceId: 'asc' }, select: { blOrderId: true, number: true, externalNumber: true } })
    : []
  const poKopii = new Map<number, string>()
  for (const f of kopie) if (!poKopii.has(f.blOrderId)) poKopii.set(f.blOrderId, f.externalNumber ?? f.number)
  for (const o of kandydaci) {
    const blRodz = o.parentOrderId ? (blRodzica.get(o.parentOrderId) ?? null) : null
    const numer =
      poZdarzeniu.get(o.id) ??
      (o.parentOrderId ? poZdarzeniu.get(o.parentOrderId) : undefined) ??
      (o.blOrderId !== null ? poKopii.get(o.blOrderId) : undefined) ??
      (blRodz !== null ? poKopii.get(blRodz) : undefined)
    if (numer) out.set(o.id, numer)
  }
  return out
}

/** Alert: zamówienie konta w trybie pracy dostało fakturę BL, kiedy stało w kolejce pakowania Kompletora. */
export const FAKTURA_BL_W_KOLEJCE = 'FAKTURA_BL_W_KOLEJCE'

const kluczFakturyWKolejce = (orderId: string) => `faktura-bl-w-kolejce:${orderId}`

/** Jeden alert na zamówienie (klucz deduplikacji); zamyka go `zamknijNieaktualneAlertyFakturyBl`. */
export async function zglosFaktureBlWKolejce(c: Klient, o: ZamowienieDoZgloszenia, numer: string, sklep?: string): Promise<boolean> {
  const nazwa = sklep ?? (await c.channelConfig.findFirst({ where: { channel: o.channel, channelAccountId: o.channelAccountId }, select: { name: true } }))?.name ?? o.channel
  const nr = o.channelNumber ?? o.externalId
  return alert(
    c,
    FAKTURA_BL_W_KOLEJCE,
    o.id,
    `Zamówienie ${nazwa} ${nr} ma fakturę ${numer} z BaseLinkera rozliczoną w Kompletorze po przełączeniu, a w Kompletorze czeka w kolejce pakowania. ` +
      `Kompletor wstrzymał jego pakowanie. ${PROCEDURA_FAKTURY_BL}`,
    kluczFakturyWKolejce(o.id),
  )
}

/**
 * Ten sam alert dla zamówienia, które Kompletor już spakował, zanim zobaczył fakturę BL (okno odczytu faktur albo
 * spóźniona para). Paczka jest w Kompletorze, dokumentem sprzedaży jest faktura z BaseLinkera: Kompletor nie wystawi
 * swojej faktury (kolejka faktur je pomija), a „Do wysyłki” na karcie jest dostępne, bo faktura BL zużyła rezerwacje.
 * Ten sam klucz deduplikacji co w kolejce: jeden alert na zamówienie.
 */
export async function zglosFaktureBlPoSpakowaniu(c: Klient, o: ZamowienieDoZgloszenia, numer: string, sklep?: string): Promise<boolean> {
  const nazwa = sklep ?? (await c.channelConfig.findFirst({ where: { channel: o.channel, channelAccountId: o.channelAccountId }, select: { name: true } }))?.name ?? o.channel
  const nr = o.channelNumber ?? o.externalId
  return alert(
    c,
    FAKTURA_BL_W_KOLEJCE,
    o.id,
    `Zamówienie ${nazwa} ${nr} jest już spakowane w Kompletorze, a po przełączeniu dostało fakturę ${numer} z BaseLinkera. ` +
      'Paczka wychodzi z Kompletora, dokumentem sprzedaży jest faktura z BaseLinkera (towar zdjął dokument WZ do niej), więc Kompletor nie wystawi swojej faktury. ' +
      'W Kompletorze: karta zamówienia → „Do wysyłki” (odbiór osobisty: „Do odbioru”) i dalej jak zwykle. ' +
      'W BaseLinkerze tego zamówienia nie pakuj ani nie wysyłaj drugi raz.',
    kluczFakturyWKolejce(o.id),
  )
}

/** Alert: faktura BL przy zamówieniu, do którego Kompletor wystawił już (albo wystawia) własny dokument sprzedaży. */
export const FAKTURA_BL_I_KOMPLETORA = 'FAKTURA_BL_I_KOMPLETORA'

/**
 * Dwie faktury na jedno zamówienie (z BaseLinkera i z Kompletora): zamówienie bez pary w chwili pakowania (sklep nie
 * podał numeru) albo faktura BL wystawiona ręcznie po przełączeniu. `bezRozliczenia`: faktura BL nie zdjęła nic ze stanu
 * (rezerwacje zużył już dokument Kompletora), więc towar zszedł raz. Rozstrzyga biuro (korekta jednej z nich); alert nie
 * zamyka się sam. Jeden na zamówienie.
 */
export async function zglosDwieFaktury(c: Klient, o: ZamowienieDoZgloszenia, numer: string, opts: { sklep?: string; bezRozliczenia?: boolean } = {}): Promise<boolean> {
  const { sklep, bezRozliczenia } = opts
  const nazwa = sklep ?? (await c.channelConfig.findFirst({ where: { channel: o.channel, channelAccountId: o.channelAccountId }, select: { name: true } }))?.name ?? o.channel
  const nr = o.channelNumber ?? o.externalId
  return alert(
    c,
    FAKTURA_BL_I_KOMPLETORA,
    o.id,
    `Zamówienie ${nazwa} ${nr} ma fakturę ${numer} z BaseLinkera, a Kompletor wystawił już (albo właśnie wystawia) do niego własny dokument sprzedaży. ` +
      (bezRozliczenia
        ? 'Towar zszedł ze stanu raz, ale na jedno zamówienie są dwa dokumenty sprzedaży i klient może dostać dwie faktury: zostaw jeden dokument, drugi skoryguj w programie do faktur. '
        : 'Towar mógł zejść ze stanu dwa razy, a klient może dostać dwie faktury na jedno zamówienie: zostaw jeden dokument, drugi skoryguj w programie do faktur. ') +
      'Paczki nie wysyłaj drugi raz: jeśli wyszła z Kompletora, w BaseLinkerze jej nie pakuj.',
    `faktura-bl-i-kompletora:${o.id}`,
  )
}

/** Statusy, w których alert o fakturze BL przy zamówieniu w kolejce albo spakowanym jest aktualny. */
const KOLEJKA_I_SPAKOWANE: readonly string[] = [...PRZED_SPAKOWANIEM, 'SPAKOWANE']

/**
 * Samozamykanie alertów o fakturze BL (bez zmian w stanie, powtórka nic nie robi): `FAKTURA_BL_W_KOLEJCE`, gdy
 * zamówienie wyszło z kolejki pakowania i ze stanu „Spakowane” (np. „Do wyjaśnienia”, „Do wysyłki”, anulowane) albo
 * osoba zdecydowała „Pakuj mimo faktury z BaseLinkera”; `FAKTURA_BL_TOWAR_W_PRACY`, gdy zamówienie nie trzyma już
 * rezerwacji ani braku albo jest anulowane. Klucz deduplikacji zdjęty przy zamknięciu, żeby nowy epizod dał nowy
 * alert. Zamówienie z kolejki spakowane po „Pakuj mimo…” zamyka alert od razu (flaga), więc „Spakowane” w zbiorze
 * statusów dotyczy tylko alertu po spakowaniu.
 */
export async function zamknijNieaktualneAlertyFakturyBl(db: Db, now: Date): Promise<number> {
  const otwarte = await db.alert.findMany({ where: { kind: { in: [FAKTURA_BL_W_KOLEJCE, FAKTURA_BL_TOWAR_W_PRACY] }, closedAt: null }, select: { id: true, kind: true, ref: true } })
  if (!otwarte.length) return 0
  const zamowienia = await db.order.findMany({
    where: { id: { in: [...new Set(otwarte.map((a) => a.ref))] } },
    select: {
      id: true,
      status: true,
      flags: true,
      reservations: { where: { state: 'ACTIVE' }, select: { id: true }, take: 1 },
      shortages: { where: { state: 'OPEN' }, select: { id: true }, take: 1 },
    },
  })
  const po = new Map(zamowienia.map((o) => [o.id, o]))
  const doZamkniecia = otwarte
    .filter((a) => {
      const o = po.get(a.ref)
      if (!o) return true // zamówienia już nie ma
      if (a.kind === FAKTURA_BL_W_KOLEJCE) return !KOLEJKA_I_SPAKOWANE.includes(o.status) || !!flagsOf(o).pakujMimoFakturyBl
      // po „Pakuj mimo…” odłożony towar to towar dodany po fakturze, którego biuro świadomie pakuje w Kompletorze
      return o.status === 'ANULOWANE' || !!flagsOf(o).pakujMimoFakturyBl || (!o.reservations.length && !o.shortages.length)
    })
    .map((a) => a.id)
  if (!doZamkniecia.length) return 0
  const r = await db.alert.updateMany({ where: { id: { in: doZamkniecia }, closedAt: null }, data: { closedAt: now, dedupeKey: null } })
  return r.count
}

/**
 * „Pakuj mimo faktury z BaseLinkera” z karty (świadoma decyzja osoby): flaga na zamówieniu i wpis w historii; alerty
 * o fakturze w kolejce i o towarze po fakturze zamykają się od razu. Powtórka nic nie zmienia (false).
 * Odmowa (`PakujMimoError`): paczka dodatkowa (jej towar objęła faktura zamówienia głównego)
 * oraz zamówienie, którego faktura BL nie jest jeszcze rozliczona (brak zdarzenia `FAKTURA_BL`), a ma aktywną
 * rezerwację: wtedy odłożony towar to towar z faktury, a WZ do niej dopiero przyjdzie. Zamówienie z samą usługą
 * (e-book: bez zdarzenia i bez rezerwacji) przechodzi.
 */
export async function pakujMimoFakturyBl(db: Db, orderId: string, ctx: { actorId?: string; now?: Date } = {}): Promise<boolean> {
  const now = ctx.now ?? new Date()
  return runTx(db, async (tx) => {
    const o0 = await tx.order.findUniqueOrThrow({ where: { id: orderId } })
    await advisoryLock(tx, orderLockKey(o0))
    const o = await tx.order.findUniqueOrThrow({ where: { id: orderId } })
    if (flagsOf(o).pakujMimoFakturyBl) return false
    const numer = await fakturaZBl(tx, o)
    if (numer === null) return false
    if (o.parentOrderId) throw new PakujMimoError(odmowaPakowaniaFakturaBl(numer, true))
    const rozliczona = await tx.orderEvent.findFirst({ where: { orderId, kind: 'FAKTURA_BL' }, select: { id: true } })
    if (!rozliczona && (await tx.reservation.count({ where: { orderId, state: 'ACTIVE' } }))) throw new PakujMimoError(ODMOWA_NIEROZLICZONA_FAKTURA_BL)
    await tx.order.update({ where: { id: orderId }, data: { flags: mergeFlags(o, { pakujMimoFakturyBl: true }) } })
    await tx.orderEvent.create({
      data: { orderId, kind: PAKUJ_MIMO_FAKTURY_BL, actorId: ctx.actorId ?? 'panel', createdAt: now, data: { numer, powod: 'Pakowanie w Kompletorze mimo faktury z BaseLinkera (decyzja z karty zamówienia).' } },
    })
    await tx.alert.updateMany({ where: { kind: { in: [FAKTURA_BL_W_KOLEJCE, FAKTURA_BL_TOWAR_W_PRACY] }, ref: orderId, closedAt: null }, data: { closedAt: now, dedupeKey: null } })
    return true
  })
}

/** Zdarzenie w historii zamówienia: osoba zdecydowała o pakowaniu w Kompletorze mimo faktury BL. */
export const PAKUJ_MIMO_FAKTURY_BL = 'PAKUJ_MIMO_FAKTURY_BL'

/** Zdarzenie w historii zamówienia: po fakturze BL zostały rezerwacje albo braki, które rozliczyła samonaprawa. */
export const ROZLICZENIE_PO_FAKTURZE_BL = 'ROZLICZENIE_PO_FAKTURZE_BL'

/** Alerty nadmiaru towaru, które zamyka samonaprawa, gdy rezerwacje przestały przekraczać stan. */
const ALERTY_NADMIARU = ['NADMIAR_REZERWACJI', 'NADMIAR_ZALEGLY']

/**
 * Otwarte braki zamówienia z zastosowaną fakturą BL → wydane (rezerwacja od razu CONSUMED, brak RESOLVED), jak brak
 * rozliczony WZ z wFirmy (`lib/cien/wz-wfirmy.ts`, `shortagesAsIssued`). Faktura BL obejmuje całe zamówienie, a WZ do
 * niej zdjął towar w programie magazynowym, więc stan go już nie zawiera: bez ruchu i bez zmiany stanu, bilans pozycji
 * zachowany (rezerwacja zużyta zamiast braku). Bez tego brak czekał na dostawę i przydział rezerwował towar drugi raz.
 * Tylko OPEN: SHIP_LATER należy do paczki dodatkowej, która jeszcze nie wyszła. Wołana pod blokadą zamówienia.
 * `pokrycie` (ilości z WZ do faktury, które zostały po rozliczeniu rezerwacji): podane = wydany tylko brak, którego
 * ilość WZ pokrywa w całości (po kolei, pokrycie maleje); reszta zostaje otwarta i liczy się w `zostawione`.
 */
export async function brakiJakoWydanePoFakturzeBlInTx(
  tx: Tx,
  orderId: string,
  docId: string,
  now: Date,
  pokrycie?: Map<string, number>,
): Promise<{ sztuk: number; produkty: string[]; zostawione: number }> {
  const sh = await tx.shortage.findMany({ where: { orderId, state: 'OPEN' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  let sztuk = 0
  let zostawione = 0
  const produkty = new Set<string>()
  for (const s of sh) {
    if (pokrycie) {
      const left = pokrycie.get(s.productId) ?? 0
      if (left < s.qtyBase) {
        zostawione++
        continue
      }
      pokrycie.set(s.productId, left - s.qtyBase)
    }
    const r = await tx.reservation.create({
      data: { orderId, orderLineId: s.orderLineId, productId: s.productId, warehouseId: DEFAULT_WAREHOUSE, qtyBase: s.qtyBase, state: 'CONSUMED', consumedAt: now },
      select: { id: true },
    })
    await tx.shortage.update({ where: { id: s.id }, data: { state: 'RESOLVED', reservationId: r.id, resolvedAt: now, resolvedBy: 'system:faktura-bl', note: `wydane fakturą BL: ${docId}` } })
    sztuk += s.qtyBase
    produkty.add(s.productId)
  }
  if (sztuk) {
    const o = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { flags: true } })
    const open = await tx.shortage.count({ where: { orderId, state: { in: ['OPEN', 'SHIP_LATER'] } } })
    if (!open && flagsOf(o).brakuje) await tx.order.update({ where: { id: orderId }, data: { flags: mergeFlags(o, { brakuje: false }) } })
  }
  return { sztuk, produkty: [...produkty].sort(), zostawione }
}

export interface SamonaprawaFakturBl {
  zamowien: number
  /** Sztuki z rezerwacji zużytych po fakturze BL (nadanych po niej, np. przydziałem dostawy). */
  rezerwacji: number
  /** Sztuki z braków rozliczonych jako wydane. */
  brakow: number
  /** Towary, którym zamknięto alerty nadmiaru. */
  nadmiarowZamknietych: number
  /** Nowe alerty dla biura o zamówieniach kont w trybie pracy (bez zmian w rezerwacjach i brakach); powtórka = 0. */
  zgloszonych: number
  /** Alerty o fakturze BL zamknięte, bo przyczyna znikła. */
  alertowZamknietych: number
  bledy: string[]
}

const SAMONAPRAWA_LIMIT = 200

/**
 * Samonaprawa (idempotentna, bez ruchu stanu): zamówienie z zastosowaną fakturą BL (zdarzenie `FAKTURA_BL` własne, nie
 * zamówienia głównego) nie może trzymać aktywnej rezerwacji ani otwartego braku. `applyBlInvoice` zużywa wszystkie
 * rezerwacje zamówienia z tego magazynu, więc każda aktywna rezerwacja po fakturze powstała później (przydział dostawy
 * dla braku, który faktura zostawiła otwarty). Stan już odzwierciedla wydanie (WZ do faktury), więc rezerwacja →
 * CONSUMED tylko z `reserved −ilość`, bez ruchu oczekującego i bez zmiany stanu fizycznego; otwarte braki → wydane
 * (`brakiJakoWydanePoFakturzeBlInTx`). Po zmianie: znacznik nadmiaru zdjęty, gdy `zarezerwowane ≤ fizyczne`
 * (niezmiennik 5), alerty nadmiaru zamknięte, gdy `zarezerwowane ≤ max(0, fizyczne)`, przydział dostawy dla zwolnionego
 * stanu. Wpis w historii zamówienia. Błąd jednego zamówienia nie zatrzymuje reszty. Firma bez BL nie ma zdarzeń
 * `FAKTURA_BL`, więc nic się nie dzieje.
 */
export async function samonaprawaPoFakturzeBl(db: Db, ctx: { now?: Date } = {}): Promise<SamonaprawaFakturBl> {
  const now = ctx.now ?? new Date()
  const wh = DEFAULT_WAREHOUSE
  const out: SamonaprawaFakturBl = { zamowien: 0, rezerwacji: 0, brakow: 0, nadmiarowZamknietych: 0, zgloszonych: 0, alertowZamknietych: 0, bledy: [] }
  const podglad = await db.channelConfig.findMany({ where: { statusMode: 'CIEN' }, select: { channel: true, channelAccountId: true } })
  const kontaPodgladu = podglad.map((k) => ({ channel: k.channel, channelAccountId: k.channelAccountId }))
  const zostawione: Prisma.OrderWhereInput = {
    events: { some: { kind: 'FAKTURA_BL' } },
    OR: [{ reservations: { some: { state: 'ACTIVE', warehouseId: wh } } }, { shortages: { some: { state: 'OPEN' } } }],
  }
  // tryb pracy: zamówienie kończy biuro w Kompletorze; zostawiona rezerwacja albo brak = zgłoszenie, nie ciche zużycie
  try {
    await zglosZostawioneWPracy(db, zostawione, kontaPodgladu, out)
  } catch (e) {
    out.bledy.push(`zgłoszenia po fakturze BL: ${e instanceof Error ? e.message : String(e)}`)
  }
  try {
    out.nadmiarowZamknietych += await zamknijNieaktualneNadmiary(db, now)
  } catch (e) {
    out.bledy.push(`zamknięcie alertów nadmiaru: ${e instanceof Error ? e.message : String(e)}`)
  }
  try {
    out.alertowZamknietych += await zamknijNieaktualneAlertyFakturyBl(db, now)
  } catch (e) {
    out.bledy.push(`zamknięcie alertów o fakturze BL: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!kontaPodgladu.length) return out
  const kandydaci = await db.order.findMany({
    // anulowane (samonaprawa je pomija) nie zajmują limitu na czele listy
    where: { AND: [zostawione, { status: { not: 'ANULOWANE' } }, { OR: kontaPodgladu }] },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: SAMONAPRAWA_LIMIT,
  })
  for (const { id: orderId } of kandydaci) {
    try {
      const r = await runTx(db, async (tx) => {
        const o0 = await tx.order.findUniqueOrThrow({ where: { id: orderId } })
        await advisoryLock(tx, orderLockKey(o0))
        const o = await tx.order.findUniqueOrThrow({ where: { id: orderId } })
        if (o.status === 'ANULOWANE') return null
        // tryb konta sprawdzony pod blokadą: przełączone w międzyczasie konto idzie do zgłoszenia w następnym przebiegu
        if (!(await kontoWPodgladzie(tx, o))) return null
        const ev = await tx.orderEvent.findFirst({ where: { orderId, kind: 'FAKTURA_BL' }, orderBy: { createdAt: 'asc' }, select: { data: true } })
        if (!ev) return null
        const d = (ev.data as { docId?: unknown } | null)?.docId
        const docId = typeof d === 'string' && d ? d : 'faktura BL'
        const res = await tx.reservation.findMany({ where: { orderId, state: 'ACTIVE', warehouseId: wh }, orderBy: { id: 'asc' } })
        const book = await StockBook.lock(tx, wh, res.map((x) => x.productId))
        const per = new Map<string, number>()
        for (const x of res) per.set(x.productId, (per.get(x.productId) ?? 0) + x.qtyBase)
        for (const [productId, qty] of per) book.change(productId, { reserved: -qty })
        if (res.length) await tx.reservation.updateMany({ where: { id: { in: res.map((x) => x.id) } }, data: { state: 'CONSUMED', consumedAt: now } })
        const braki = await brakiJakoWydanePoFakturzeBlInTx(tx, orderId, docId, now)
        if (!res.length && !braki.sztuk) return null
        const zamkniete: string[] = []
        for (const productId of [...per.keys()].sort()) {
          const row = book.get(productId)!
          if (row.overcommitSince && row.reserved <= row.physical) book.set(productId, { overcommitSince: null, overcommitListedAt: null })
          if (row.reserved <= Math.max(0, row.physical)) {
            const c = await tx.alert.updateMany({ where: { kind: { in: ALERTY_NADMIARU }, ref: productId, closedAt: null }, data: { closedAt: now } })
            if (c.count) zamkniete.push(productId)
          }
        }
        await book.flush(tx, now)
        // zwolniony stan: braki innych zamówień dostają przydział (jak po wzroście stanu)
        for (const productId of [...per.keys()].sort()) if (book.available(productId) > 0) await outbox(tx, 'ALLOCATE', productId, now)
        const rezerwacje = [...per].map(([productId, qty]) => ({ productId, qty }))
        await tx.orderEvent.create({ data: { orderId, kind: ROZLICZENIE_PO_FAKTURZE_BL, actorId: 'system:cien-bl', createdAt: now, data: { docId, rezerwacje, brakiSztuk: braki.sztuk } } })
        return { rez: rezerwacje.reduce((s, x) => s + x.qty, 0), braki: braki.sztuk, zamkniete: zamkniete.length }
      })
      if (!r) continue
      out.zamowien++
      out.rezerwacji += r.rez
      out.brakow += r.braki
      out.nadmiarowZamknietych += r.zamkniete
    } catch (e) {
      out.bledy.push(`samonaprawa po fakturze BL ${orderId}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return out
}

/**
 * Zamówienia kont spoza podglądu (tryb pracy) z fakturą BL i aktywną rezerwacją albo otwartym brakiem: jeden alert dla
 * biura na zamówienie (klucz deduplikacji), bez zmian w rezerwacjach, brakach i stanie.
 */
async function zglosZostawioneWPracy(
  db: Db,
  zostawione: Prisma.OrderWhereInput,
  kontaPodgladu: { channel: Order['channel']; channelAccountId: string }[],
  out: SamonaprawaFakturBl,
): Promise<void> {
  // już zgłoszone (otwarty alert) nie zajmują limitu listy
  const zgloszone = (await db.alert.findMany({ where: { kind: FAKTURA_BL_TOWAR_W_PRACY, closedAt: null }, select: { ref: true } })).map((a) => a.ref)
  const where: Prisma.OrderWhereInput = {
    // zamówienia po „Pakuj mimo…” pomijane (świadoma decyzja biura, odłożony towar dodany po fakturze)
    AND: [zostawione, { status: { not: 'ANULOWANE' } }, { events: { none: { kind: PAKUJ_MIMO_FAKTURY_BL } } }, ...(zgloszone.length ? [{ id: { notIn: zgloszone } }] : []), ...(kontaPodgladu.length ? [{ NOT: { OR: kontaPodgladu } }] : [])],
  }
  const zamowienia = await db.order.findMany({
    where,
    select: { id: true, channel: true, channelAccountId: true, channelNumber: true, externalId: true },
    orderBy: { id: 'asc' },
    take: SAMONAPRAWA_LIMIT,
  })
  if (!zamowienia.length) return
  const nazwy = new Map((await db.channelConfig.findMany({ select: { channel: true, channelAccountId: true, name: true } })).map((k) => [`${k.channel}:${k.channelAccountId}`, k.name]))
  for (const o of zamowienia) {
    try {
      if (await zglosTowarPoFakturzeBl(db, o, nazwy.get(`${o.channel}:${o.channelAccountId}`) ?? o.channel)) out.zgloszonych++
    } catch (e) {
      out.bledy.push(`zgłoszenie po fakturze BL ${o.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

/**
 * Otwarte alerty nadmiaru towaru, którego rezerwacje nie przekraczają już `max(0, fizyczne)` we wszystkich magazynach
 * (stan ujemny po ruchu biura bez rezerwacji ponad zero nie jest nadmiarem): zamknięte. Obejmuje alerty sprzed poprawki,
 * których samonaprawa nie dotknęła. Bez zmian w stanie; powtórka nic nie robi. Prawdziwy nadmiar alert zachowuje.
 */
async function zamknijNieaktualneNadmiary(db: Db, now: Date): Promise<number> {
  const otwarte = await db.alert.findMany({ where: { kind: { in: ALERTY_NADMIARU }, closedAt: null }, select: { ref: true }, distinct: ['ref'] })
  if (!otwarte.length) return 0
  const rows = await db.stock.findMany({ where: { productId: { in: otwarte.map((a) => a.ref) } }, select: { productId: true, reserved: true, physical: true } })
  const nadal = new Set(rows.filter((r) => r.reserved > Math.max(0, r.physical)).map((r) => r.productId))
  const znane = new Set(rows.map((r) => r.productId))
  const doZamkniecia = [...znane].filter((p) => !nadal.has(p)).sort()
  if (!doZamkniecia.length) return 0
  await db.alert.updateMany({ where: { kind: { in: ALERTY_NADMIARU }, ref: { in: doZamkniecia }, closedAt: null }, data: { closedAt: now } })
  return doZamkniecia.length
}
