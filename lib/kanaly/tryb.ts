// Tryb konta kanału z panelu: „Tylko podgląd” (CIEN) ↔ „Aktywny” (PRACA) dla stanów, statusów i numerów
// nadania naraz, z warunkami i potwierdzeniem. Do tej pory tryb zmieniał tylko administrator instancji poza panelem.
// Zmiana trybu sama niczego nie wysyła do sklepu: zapis rusza dopiero przy wersji z zapisem i włączonym
// „Zapis do kanału” (bramki hosta zapisu, lib/kanaly/zapis-host.ts, bez zmian). Każda zmiana w AuditLog i w
// `goBy`/`goAt`/`goRef` konta. Jedna funkcja warunków dla ekranu i dla akcji (ekran nie obiecuje tego, czego akcja
// odmówi). (onboarding) używa tej samej funkcji; twarda blokada instancji: `blokadaInstancji`.
import type { Channel, ChannelMode, Prisma, PrismaClient } from '@prisma/client'
import { type AdapterManifest, WYSTAWIANIE_OFERT_KLUCZ, wystawianieOfertWlaczone } from '../adaptery/kontrakt'
import type { AdapterRegistry } from '../adaptery/rejestr'
import { trybPracyInstancji } from '../praca/wlacznik'
import { KontoError, type KontoRef } from './konta'
import { mapaStatusow, zapisWlaczony } from './zapis-host'

export type TrybKonta = 'CIEN' | 'PRACA'

/**
 * tryb pracy bez zapisu stanów. Kompletor prowadzi zamówienia konta (statusy, numery nadania, pakowanie,
 * wysyłka, faktury: `statusMode` i `trackingMode` = PRACA), a stany ofert zostają w podglądzie (`stockMode` = CIEN),
 * bo wysyła je dotychczasowy system. Do zamówień konto jest pracujące (bramki zamówień czytają `statusMode`), do
 * stanów podglądem (host zapisu stanów czyta `stockMode`). Stany dołącza się z panelu jednym przełączeniem na PRACA.
 */
export type TrybDocelowy = TrybKonta | 'BEZ_STANOW'

/** Tryb konta odczytany z trzech pól: `MIESZANY` = układ spoza panelu (np. ustawiony skryptem). */
export type TrybOdczytany = TrybDocelowy | 'MIESZANY'

/** Trzy pola trybu dla trybu wybranego w panelu. */
export function trybyPol(tryb: TrybDocelowy): { stockMode: ChannelMode; statusMode: ChannelMode; trackingMode: ChannelMode } {
  if (tryb === 'BEZ_STANOW') return { stockMode: 'CIEN', statusMode: 'PRACA', trackingMode: 'PRACA' }
  return { stockMode: tryb, statusMode: tryb, trackingMode: tryb }
}

/** Konto prowadzi zamówienia w Kompletorze (pełny tryb pracy albo praca bez stanów). */
export const prowadziZamowienia = (t: TrybOdczytany): boolean => t === 'PRACA' || t === 'BEZ_STANOW'

export interface Warunek {
  /** Krótki tekst dla właściciela (co jest nie tak i co zrobić). */
  tekst: string
  /** true = blokuje przełączenie, false = tylko ostrzeżenie w oknie potwierdzenia. */
  blokuje: boolean
  /** Kotwica sekcji ekranu konta, gdzie to naprawić (np. „#zapis”). */
  gdzie?: string
}

export interface StanDoTrybu {
  active: boolean
  testOk: boolean | null
  offers: number
  manifest: AdapterManifest | null
  config: Record<string, unknown>
  /** Firma ma podłączony BaseLinker (przechodzi z BL). */
  firmaZBl: boolean
  /** warunki dla trybu pracy bez stanów (stany ofert zostają w dotychczasowym systemie). */
  bezStanow?: boolean
  /** konto, do którego zamówienia przychodzą wyłącznie przez API Kompletora (`kontoTylkoApi`). */
  tylkoApi?: boolean
}

/**
 * kanały bez połączenia do sprawdzenia: zamówienia wchodzą tylko przez API Kompletora (POST /api/v1/zamowienia,
 * klucz firmy z zakresem `zamowienia:zapis`), Kompletor niczego z nich nie czyta i do nich nie pisze. Test połączenia
 * nie ma czego sprawdzić (adapter `easytools.v1` nie jest w rejestrze), więc nie może blokować trybu pracy.
 */
const KANALY_TYLKO_API: readonly Channel[] = ['EASYTOOLS']
export const kontoTylkoApi = (channel: Channel): boolean => KANALY_TYLKO_API.includes(channel)

type Env = Record<string, string | undefined>

/**
 * Twarda blokada instancji. Firma przechodząca z BaseLinkera przełącza konto na „Aktywny” tylko na
 * instancji z `EKRANY_PRACA=1` (dotychczasowy wyłącznik, administrator decyduje o całej instancji). Firma bez BL
 * nie ma czego porównywać w podglądzie, więc ta bramka jej nie dotyczy (rozstrzygnięcie R28).
 * Zła wartość zmiennej = blokada z powodem (nie po cichu).
 */
export function blokadaInstancji(env: Env, firmaZBl: boolean): string | null {
  let wolno: boolean
  try {
    wolno = trybPracyInstancji(env, firmaZBl) // ta sama reguła co bramki karty i akcji (lib/praca/wlacznik.ts)
  } catch {
    return 'Zła wartość ustawienia serwera dla trybu pracy. Zgłoś to administratorowi.'
  }
  // druga droga z panelu: po przeprowadzce „Przejście z BaseLinkera zakończone” (lib/przeprowadzka/zakonczenie.ts)
  // droga z panelu tylko dla firm, którym dane przeniosła przeprowadzka z panelu (nie preset ani porównanie z BL)
  if (!wolno) return 'Ta instancja ma wyłączony tryb pracy dla firm przechodzących z BaseLinkera. Włącza go administrator serwera. Jeśli dane przeniosła przeprowadzka z panelu, możesz też oznaczyć przejście jako zakończone (Ustawienia → Przejście z BaseLinkera → Przeprowadzka).'
  return null
}

/** Warunki przełączenia na „Aktywny” (PRACA). Na „Tylko podgląd” zawsze wolno. */
export function warunkiPracy(s: StanDoTrybu, env: Env): Warunek[] {
  const out: Warunek[] = []
  const inst = blokadaInstancji(env, s.firmaZBl)
  if (inst) out.push({ tekst: inst, blokuje: true })
  // teksty bez „Najpierw” w środku: ekran nie dokleja prefiksu, blokujące odróżnia kolor i znacznik (przegląd, UX)
  if (!s.active) out.push({ tekst: 'Włącz konto (jest wyłączone).', blokuje: true, gdzie: '#aktywne' })
  if (s.tylkoApi) {
    out.push({
      tekst: 'Zamówienia tego konta przychodzą przez API Kompletora (klucz z zakresem „zamowienia:zapis”: Ustawienia → Integracje i agenci AI → Klucze API). Kompletor prowadzi je jak zamówienia ręczne: pakowanie, wysyłka i faktury; do sprzedawcy nic nie wysyła.',
      blokuje: false,
    })
    return out
  }
  if (s.testOk !== true) out.push({ tekst: s.testOk === false ? 'Ostatni test połączenia nie przeszedł: popraw klucze i sprawdź połączenie.' : 'Sprawdź połączenie.', blokuje: true, gdzie: '#polaczenie' })
  const m = s.manifest
  const zapis = !!m && !m.readOnly && zapisWlaczony(s.config)
  if (zapis && m!.capabilities.includes('order.status.write') && Object.keys(mapaStatusow(s.config, m).mapa).length === 0)
    out.push({ tekst: 'Zmapuj statusy: bez tego sklep nie dostanie żadnego statusu.', blokuje: true, gdzie: '#zapis' })
  if (s.offers === 0 && !s.bezStanow) out.push({ tekst: 'Konto nie ma jeszcze przypisanych ofert: stany nie będą wysyłane, dopóki ich nie przypiszesz.', blokuje: false, gdzie: '#oferty' })
  if (!zapis)
    out.push({
      tekst: s.bezStanow
        ? 'Zapis do sklepu jest wyłączony: Kompletor poprowadzi zamówienia, ale sklep nie dostanie statusów ani numerów nadania.'
        : 'Zapis do sklepu jest wyłączony: Kompletor poprowadzi zamówienia, ale sklep nie dostanie stanów ani statusów.',
      blokuje: false,
      gdzie: '#zapis',
    })
  if (s.firmaZBl)
    out.push({
      tekst: s.bezStanow
        ? 'Firma ma podłączony BaseLinker: wyłącz w nim zmiany statusów, numery nadania i automatyczne akcje dla tego konta. Wysyłanie stanów ofert zostaw w BaseLinkerze włączone.'
        : 'Firma ma podłączony BaseLinker: wyłącz w nim zmiany stanów i statusów dla tego konta, żeby oba systemy nie zapisywały tego samego.',
      blokuje: false,
    })
  return out
}

export const mozna = (w: readonly Warunek[]) => !w.some((x) => x.blokuje)

/**
 * konto czyta klucze z pliku konfiguracji serwera tylko przy niepustym przedrostku. Jedna
 * funkcja dla ekranu (`kontoEkran.envPrefix`) i akcji (`ustawZapisKonta`), żeby pusty `envPrefix: ''` nie dawał
 * blokady na ekranie i przepustki w akcji.
 */
export function maEnvPrefix(config: Record<string, unknown>): boolean {
  return typeof config['envPrefix'] === 'string' && config['envPrefix'].trim() !== ''
}

/**
 * tryb nowego konta z panelu, jedno miejsce prawdy dla `dodajKonto` i tekstu kreatora.
 * Zawsze „Tylko podgląd”, także w firmie bez BaseLinkera (R28 dotyczy bramki instancji, nie startu
 * konta): tryb pracy wymaga udanego testu połączenia (`warunkiPracy`), którego przy zakładaniu konta jeszcze nie ma.
 */
export function domyslnyTryb(): TrybKonta {
  return 'CIEN'
}

export const OPIS_TRYBU_NOWEGO_KONTA: Record<TrybKonta, string> = {
  CIEN: 'Konto startuje w trybie „Tylko podgląd”: Kompletor czyta zamówienia i niczego w sklepie nie zmienia. Tryb pracy włączysz na ekranie konta po udanym teście połączenia.',
  PRACA: 'Konto startuje w trybie pracy: Kompletor od razu prowadzi zamówienia z tego sklepu.',
}

/** Klucze z prawem zapisu, których wymaga wersja z zapisem (Woo: osobny klucz WC REST do zapisu). */
export function kluczeZapisu(m: AdapterManifest | null): string[] {
  return (m?.secrets ?? []).filter((s) => /_WRITE_/.test(s.name)).map((s) => s.name)
}

export interface StanDoZapisu {
  active: boolean
  manifest: AdapterManifest | null
  config: Record<string, unknown>
  tryb: TrybOdczytany
  /** Nazwy zapisanych sekretów konta (bez wartości). */
  sekrety: ReadonlySet<string>
  /** Konto czyta też klucze z pliku konfiguracji serwera (envPrefix): brak w bazie nie znaczy braku klucza. */
  zEnv: boolean
  /**
   * tekst `blokadaInstancji(env, firmaZBl)`, gdy instancja nie pozwala tej firmie na
   * tryb pracy. Zapis wolno włączyć (nic nie wyjdzie bez trybu pracy), ale okno potwierdzenia o tym mówi.
   */
  blokadaInstancji?: string | null
}

/**
 * Warunki włączenia wyłącznika „Zapis do sklepu” (przełącznik w sekcji „Zapis do sklepu”
 * zamiast pola w „Zaawansowane”). Wyłączyć wolno zawsze. Ta sama funkcja dla ekranu i akcji.
 */
export function warunkiZapisu(s: StanDoZapisu): Warunek[] {
  const out: Warunek[] = []
  const m = s.manifest
  if (!m || m.readOnly) {
    out.push({ tekst: 'Ten rodzaj konta tylko czyta ze sklepu. Przełącz je na wersję z zapisem.', blokuje: true, gdzie: '#zapis' })
    return out
  }
  if (!s.zEnv && kluczeZapisu(m).some((n) => !s.sekrety.has(n)))
    out.push({ tekst: 'Wklej klucz z prawem zapisu (sekcja „Ustawienia i klucze”, „Zaawansowane”).', blokuje: true, gdzie: '#ustawienia' })
  if (!s.active) out.push({ tekst: 'Konto jest wyłączone: nic nie wyjdzie, dopóki go nie włączysz.', blokuje: false, gdzie: '#aktywne' })
  if (m.capabilities.includes('order.status.write') && Object.keys(mapaStatusow(s.config, m).mapa).length === 0)
    out.push({ tekst: 'Statusy nie są zmapowane: sklep nie dostanie żadnego statusu, dopóki ich nie ustawisz niżej.', blokuje: false, gdzie: '#zapis' })
  if (s.blokadaInstancji) out.push({ tekst: `${s.blokadaInstancji} Do tego czasu zapis nic do sklepu nie wyśle.`, blokuje: false })
  else if (s.tryb === 'BEZ_STANOW') out.push({ tekst: 'Konto pracuje bez stanów: do sklepu pójdą statusy i numery nadania, stanów ofert Kompletor nie wyśle.', blokuje: false, gdzie: '#stan' })
  else if (s.tryb !== 'PRACA') out.push({ tekst: 'Konto jest w trybie „Tylko podgląd”: zapis ruszy dopiero po włączeniu trybu pracy.', blokuje: false, gdzie: '#stan' })
  return out
}

/** Włączenie albo wyłączenie zapisu do sklepu na koncie. Warunki od nowa z bazy, AuditLog z before/after. Idempotentne. */
export async function ustawZapisKonta(
  db: PrismaClient,
  ref: KontoRef,
  wlacz: boolean,
  opts: { actorId: string; registry: AdapterRegistry; env?: Env; firmaZBl?: boolean },
): Promise<'ZMIENIONO' | 'BEZ_ZMIAN'> {
  const row = await db.channelConfig.findFirst({ where: { channel: ref.channel, channelAccountId: ref.channelAccountId } })
  if (!row) throw new KontoError('Nie ma takiego konta')
  const config = row.config && typeof row.config === 'object' && !Array.isArray(row.config) ? (row.config as Record<string, unknown>) : {}
  if (zapisWlaczony(config) === wlacz) return 'BEZ_ZMIAN'
  if (wlacz) {
    const manifest = opts.registry.get(row.adapterKey)?.manifest ?? null
    const sekrety = await db.integrationSecret.findMany({ where: { channel: ref.channel, channelAccountId: ref.channelAccountId, name: { in: kluczeZapisu(manifest) } }, select: { name: true } })
    const w = warunkiZapisu({ active: row.active, manifest, config, tryb: trybKonta(row), sekrety: new Set(sekrety.map((x) => x.name)), zEnv: maEnvPrefix(config), blokadaInstancji: opts.env ? blokadaInstancji(opts.env, opts.firmaZBl ?? true) : null })
    const stop = w.filter((x) => x.blokuje)
    if (stop.length) throw new KontoError(stop.map((x) => x.tekst).join(' '))
  }
  const after = { ...config, zapisWlaczony: wlacz }
  await db.$transaction(async (tx) => {
    await tx.channelConfig.update({
      where: { organizationId_channel_channelAccountId: { organizationId: row.organizationId, channel: ref.channel, channelAccountId: ref.channelAccountId } },
      data: { config: after as Prisma.InputJsonValue },
    })
    await tx.auditLog.create({
      data: { entity: 'ChannelConfig', entityId: `${ref.channel}/${ref.channelAccountId}`, actorId: opts.actorId, before: { zapisWlaczony: zapisWlaczony(config) }, after: { zapisWlaczony: wlacz, zrodlo: 'panel' } },
    })
  })
  return 'ZMIENIONO'
}

/**
 * włączenie albo wyłączenie wystawiania ofert na koncie (osobny przełącznik, niezależny od zapisu stanów).
 * Włączyć można tylko na koncie z zapisem, którego adapter zna ten przełącznik (Allegro, Empik, sklep Woo w wersji
 * z zapisem). AuditLog z before/after. Idempotentne.
 */
export async function ustawWystawianieOfertKonta(
  db: PrismaClient,
  ref: KontoRef,
  wlacz: boolean,
  opts: { actorId: string; registry: AdapterRegistry },
): Promise<'ZMIENIONO' | 'BEZ_ZMIAN'> {
  const row = await db.channelConfig.findFirst({ where: { channel: ref.channel, channelAccountId: ref.channelAccountId } })
  if (!row) throw new KontoError('Nie ma takiego konta')
  const config = row.config && typeof row.config === 'object' && !Array.isArray(row.config) ? (row.config as Record<string, unknown>) : {}
  if (wystawianieOfertWlaczone(config) === wlacz) return 'BEZ_ZMIAN'
  if (wlacz) {
    const manifest = opts.registry.get(row.adapterKey)?.manifest ?? null
    if (!manifest || manifest.readOnly || !manifest.config.some((f) => f.key === WYSTAWIANIE_OFERT_KLUCZ))
      throw new KontoError('Ten rodzaj konta nie wystawia ofert: przełącz konto na wersję z zapisem w sekcji „Zapis do sklepu”.')
    if (!row.active) throw new KontoError('Konto jest wyłączone: najpierw je włącz.')
  }
  const after = { ...config, [WYSTAWIANIE_OFERT_KLUCZ]: wlacz }
  await db.$transaction(async (tx) => {
    await tx.channelConfig.update({
      where: { organizationId_channel_channelAccountId: { organizationId: row.organizationId, channel: ref.channel, channelAccountId: ref.channelAccountId } },
      data: { config: after as Prisma.InputJsonValue },
    })
    await tx.auditLog.create({
      data: { entity: 'ChannelConfig', entityId: `${ref.channel}/${ref.channelAccountId}`, actorId: opts.actorId, before: { [WYSTAWIANIE_OFERT_KLUCZ]: wystawianieOfertWlaczone(config) }, after: { [WYSTAWIANIE_OFERT_KLUCZ]: wlacz, zrodlo: 'panel' } },
    })
  })
  return 'ZMIENIONO'
}

/**
 * Tryb konta jako jedna wartość: „Aktywny” tylko, gdy stany, statusy i numery nadania są w PRACA; „bez stanów”
 * gdy statusy i numery nadania są w PRACA, a stany w podglądzie; każdy inny układ = MIESZANY.
 */
export function trybKonta(r: { stockMode: ChannelMode; statusMode: ChannelMode; trackingMode: ChannelMode }): TrybOdczytany {
  const t = [r.stockMode, r.statusMode, r.trackingMode]
  if (t.every((x) => x === 'PRACA')) return 'PRACA'
  if (t.every((x) => x === 'CIEN')) return 'CIEN'
  if (r.stockMode === 'CIEN' && r.statusMode === 'PRACA' && r.trackingMode === 'PRACA') return 'BEZ_STANOW'
  return 'MIESZANY'
}

const GO_REF: Record<TrybDocelowy, string> = { PRACA: 'panel:praca', BEZ_STANOW: 'panel:praca-bez-stanow', CIEN: 'panel:podglad' }

/**
 * Przełączenie trybu konta (stany, statusy, numery nadania naraz; albo praca bez stanów). Warunki liczone
 * od nowa z bazy (`stan`): ekran mógł pokazać stan sprzed chwili. Do podglądu wolno zawsze; zdjęcie samych stanów
 * (PRACA → bez stanów) też bez warunków, bo tylko wyłącza zapis stanów. Idempotentne: ten sam tryb = bez zapisu.
 */
export async function zmienTrybKonta(
  db: PrismaClient,
  ref: KontoRef,
  tryb: TrybDocelowy,
  opts: { actorId: string; env: Env; registry: AdapterRegistry; firmaZBl: boolean; now?: Date },
): Promise<'ZMIENIONO' | 'BEZ_ZMIAN'> {
  const row = await db.channelConfig.findFirst({ where: { channel: ref.channel, channelAccountId: ref.channelAccountId } })
  if (!row) throw new KontoError('Nie ma takiego konta')
  const obecny = trybKonta(row)
  if (obecny === tryb) return 'BEZ_ZMIAN'
  if (tryb === 'PRACA' || (tryb === 'BEZ_STANOW' && obecny !== 'PRACA')) {
    const [st, offers] = await Promise.all([
      db.channelAccountStatus.findFirst({ where: { channel: ref.channel, channelAccountId: ref.channelAccountId }, select: { testOk: true } }),
      db.channelOffer.count({ where: { channel: ref.channel, channelAccountId: ref.channelAccountId, active: true } }),
    ])
    const config = row.config && typeof row.config === 'object' && !Array.isArray(row.config) ? (row.config as Record<string, unknown>) : {}
    const w = warunkiPracy({ active: row.active, testOk: st?.testOk ?? null, offers, manifest: opts.registry.get(row.adapterKey)?.manifest ?? null, config, firmaZBl: opts.firmaZBl, bezStanow: tryb === 'BEZ_STANOW', tylkoApi: kontoTylkoApi(ref.channel) }, opts.env)
    const stop = w.filter((x) => x.blokuje)
    if (stop.length) throw new KontoError(stop.map((x) => x.tekst).join(' '))
  }
  const now = opts.now ?? new Date()
  const before = { stockMode: row.stockMode, statusMode: row.statusMode, trackingMode: row.trackingMode }
  const after = trybyPol(tryb)
  await db.$transaction(async (tx) => {
    await tx.channelConfig.update({
      where: { organizationId_channel_channelAccountId: { organizationId: row.organizationId, channel: ref.channel, channelAccountId: ref.channelAccountId } },
      data: { ...after, goBy: opts.actorId, goAt: now, goRef: GO_REF[tryb] },
    })
    await tx.auditLog.create({
      data: { entity: 'ChannelConfig', entityId: `${ref.channel}/${ref.channelAccountId}`, actorId: opts.actorId, before: before as Prisma.InputJsonValue, after: { ...after, zrodlo: 'panel' } as Prisma.InputJsonValue },
    })
  })
  return 'ZMIENIONO'
}
