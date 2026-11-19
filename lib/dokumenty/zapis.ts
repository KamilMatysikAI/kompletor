// Ustawienia → Dokumenty sprzedaży: odczyt widoku i zapis z panelu. Klient firmy (RLS), blokada
// wiersza firmy, ślad w AuditLog. Zapis zmienia tylko swoje pola w `settings.faktury` i `settings.ksef`; ustawienia
// wFirmy z presetu (kody VAT, seria wFirmy, płatności) zostają. Do tego źródło stanu magazynu (`Warehouse.stockSource`).
import type { Prisma, PrismaClient } from '@prisma/client'
import type { AdapterManifest } from '../adaptery/kontrakt'
import { organizationIdOf } from '../db'
import { parseKonfiguracjaKsef, SRODOWISKA_FIRMY, type SrodowiskoFirmy, WZOR_FAKTUR, WZOR_KOREKT } from '../ksef/konfiguracja'
import { normalizujWzor, OKRESY_RESETU, type OkresResetu, problemySerii } from '../ksef/numeracja'
import { requestFullReadInTx } from '../rdzen/kolejka-wfirmy'
import { DEFAULT_WAREHOUSE, type Tx } from '../rdzen/stan'
import { ETYKIETA_ZRODLA, type ZrodloStanu, ZRODLA_STANU, zrodloZMagazynu } from '../rdzen/zrodlo-stanu'
import { parseKonfiguracjaFaktur } from '../wfirma/konfiguracja'
import {
  ETYKIETA_PROGRAMU,
  MOMENTY_WYSTAWIENIA,
  type MomentWystawienia,
  parseUstawieniaDokumentow,
  PROGRAMY_WBUDOWANE,
  type ProgramDokumentow,
  programZWartosci,
  RODZAJE_DOKUMENTU,
  type RodzajDokumentu,
  type UstawieniaDokumentow,
  POWOD_WZ_NIEDOSTEPNE,
  wzBezFaktury,
  korektyWlaczone,
  ZAPIS_WZ_DOSTEPNY,
} from './ustawienia'

type Json = Record<string, Prisma.JsonValue>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const tekst = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ') : null)

export class UstawieniaDokumentowError extends Error {}

const STAWKI = ['23', '8', '5', '0', 'zw'] as const

export interface ProgramDoWyboru {
  program: ProgramDokumentow
  nazwa: string
  /** Co program umie dziś (słowami, dla ekranu). */
  opis: string
}

/** Programy do wyboru: wbudowane + adaptery rodzaju `invoicing` z rejestru (poza KSeF, który jest wbudowany). */
export function programyDoWyboru(manifesty: readonly AdapterManifest[]): ProgramDoWyboru[] {
  const out: ProgramDoWyboru[] = [
    { program: 'brak', nazwa: ETYKIETA_PROGRAMU.brak, opis: 'Kompletor nie wystawia dokumentów: zamówienie zamyka się po wysyłce bez faktury. Faktury wystawiasz poza systemem.' },
    { program: 'wfirma', nazwa: ETYKIETA_PROGRAMU.wfirma, opis: 'Faktury wystawiane w wFirmie z Kompletora (po włączeniu „Wystawiaj faktury z Kompletora”), numer i PDF na karcie zamówienia. Wymaga kluczy wFirmy w konfiguracji firmy.' },
    { program: 'ksef', nazwa: ETYKIETA_PROGRAMU.ksef, opis: 'Kompletor sam nadaje numer z serii i wysyła fakturę FA(3) do KSeF (po włączeniu „Wystawiaj faktury z Kompletora”); numer KSeF, UPO i PDF na liście faktur. Wymaga tokenu KSeF firmy. Domyślnie środowisko testowe KSeF.' },
  ]
  for (const m of manifesty) {
    if (m.kind !== 'invoicing' || programZWartosci(m.adapterKey) === 'ksef') continue
    const umie = [m.capabilities.includes('invoice.issue') && 'wystawia', m.capabilities.includes('invoice.correct') && 'koryguje', m.capabilities.includes('invoice.pdf') && 'daje PDF'].filter(Boolean)
    out.push({ program: m.adapterKey, nazwa: m.displayName, opis: umie.length ? `Program: ${umie.join(', ')}.` : 'Program podłączony, bez wystawiania z Kompletora.' })
  }
  return out
}

export interface WidokDokumentow {
  ustawienia: UstawieniaDokumentow
  /** Pole programu nie było zapisane: wartość wywnioskowana (firma). */
  programWywnioskowany: boolean
  seria: { kod: string; wzor: string; reset: OkresResetu } | null
  /** seria korekt KSeF i środowisko KSeF firmy. */
  seriaKorekt: { kod: string; wzor: string; reset: OkresResetu } | null
  srodowiskoKsef: SrodowiskoFirmy
  wysylka: { nazwa: string; stawkaVat: string }
  konsumenciDoKsef: boolean
  podstawaZwolnienia: string | null
  zrodloStanu: ZrodloStanu
  /** Magazyn wskazuje magazyn wFirmy (warunek źródła WFIRMA). */
  magazynWfirmy: boolean
  /** Powód, dla którego źródła stanu nie da się teraz zmienić; null = można. */
  zmianaZrodlaZablokowana: string | null
  /** Ustawienia z kodami VAT wFirmy (preset): pokazywane tylko do odczytu. */
  kodyVatWfirmy: Record<string, number>
  /** „WZ przy wysyłce bez faktury” (zapis WZ w wFirmie zamiast ruchu do ręcznego zamknięcia). */
  wzBezFaktury: boolean
  /** Powód, dla którego przełącznik jest nieaktywny (null = można włączyć). */
  wzBezFakturyNiedostepne: string | null
  /** „Korekty faktur przy zwrotach z Kompletora”. */
  korektyWlaczone: boolean
  /**
   * spakowane zamówienia sklepów w pracy bez faktury, przy stanie z wFirmy i wyłączonym
   * wystawianiu. Po włączeniu Kompletor ich nie zafakturuje (bierze tylko spakowane po włączeniu); null = nie dotyczy.
   */
  spakowaneBezFaktury: number | null
}

/** Licznik zaległych spakowanych bez faktury: tani `count`, tylko konta w PRACA. */
async function spakowaneBezFaktury(db: PrismaClient): Promise<number> {
  const konta = await db.channelConfig.findMany({ where: { statusMode: 'PRACA' }, select: { channel: true, channelAccountId: true } })
  if (!konta.length) return 0
  return db.order.count({ where: { status: 'SPAKOWANE', OR: konta, invoices: { none: { state: { in: ['SENDING', 'UNKNOWN', 'ISSUED'] } } } } })
}

async function magazyn(db: PrismaClient, warehouseId: string) {
  return db.warehouse.findFirst({ where: { id: warehouseId }, select: { id: true, stockSource: true, wfirmaWarehouseId: true } })
}

const zwrotyNierozliczone = (n: number) =>
  `W magazynie są nierozliczone zwroty (${n}). Zmiana źródła stanu dopiero po ich przyjęciu albo odrzuceniu: menu „Zwroty i reklamacje”.`

/**
 * Czy można odejść z lustra wFirmy (WFIRMA → KOMPLETOR): nic nie może być w drodze między Kompletorem a wFirmą, także
 * korekta zwrotu w kolejce wFirmy (przy Kompletorze kolejka korekt już jej nie rozstrzygnie).
 */
async function blokadaZmianyZrodla(db: PrismaClient | Tx, warehouseId: string): Promise<string | null> {
  const wDrodze = await db.reservation.count({ where: { warehouseId, state: 'CONSUMING' } })
  const ruchy = await db.pendingMovement.count({ where: { warehouseId, state: { in: ['IN_FLIGHT', 'APPLIED', 'MANUAL'] } } })
  if (wDrodze || ruchy) return `W magazynie są dokumenty w toku albo ruchy do potwierdzenia w wFirmie (${wDrodze + ruchy}). Zmiana źródła stanu dopiero po ich rozliczeniu.`
  const korekty = await db.return.count({ where: { status: 'KOREKTA' } })
  if (korekty) return zwrotyNierozliczone(korekty)
  return null
}

/**
 * Czy można przejść na lustro wFirmy (KOMPLETOR → WFIRMA), zwrot zgłoszony przy stanie Kompletora
 * nie ma faktury do korekty, więc po przełączeniu nie dałoby się go przyjąć (przyjęcie przy lustrze wymaga dokumentu).
 */
async function blokadaPrzejsciaNaLustro(db: PrismaClient | Tx): Promise<string | null> {
  const n = await db.return.count({ where: { invoiceDocId: null, status: { in: ['ZGLOSZONY', 'PRZYJETY'] } } })
  return n ? zwrotyNierozliczone(n) : null
}

export async function widokDokumentow(db: PrismaClient, warehouseId = DEFAULT_WAREHOUSE): Promise<WidokDokumentow> {
  const org = await db.organization.findFirst({ select: { settings: true } })
  const w = await magazyn(db, warehouseId)
  const zrodlo = zrodloZMagazynu(w)
  const settings = org?.settings ?? null
  const f = isObj(settings) && isObj(settings['faktury']) ? settings['faktury'] : {}
  const k = isObj(settings) && isObj(settings['ksef']) ? settings['ksef'] : {}
  const wf = parseKonfiguracjaFaktur(settings)
  const ks = parseKonfiguracjaKsef(settings)
  const reset = (OKRESY_RESETU as readonly string[]).includes(k['seriaReset'] as string) ? (k['seriaReset'] as OkresResetu) : 'ROK'
  return {
    ustawienia: parseUstawieniaDokumentow(settings, { maWfirme: zrodlo === 'WFIRMA' }),
    programWywnioskowany: !programZWartosci(f['program']),
    seria: ks.seriaKod ? { kod: ks.seriaKod, wzor: tekst(k['seriaWzor']) ?? WZOR_FAKTUR, reset } : null,
    seriaKorekt: ks.seriaKorekt ? { kod: ks.seriaKorekt.code, wzor: ks.seriaKorekt.pattern, reset: ks.seriaKorekt.resetPeriod } : null,
    srodowiskoKsef: ks.srodowisko,
    wysylka: wf.wysylka,
    konsumenciDoKsef: ks.konsumenciDoKsef,
    podstawaZwolnienia: ks.podstawaZwolnienia,
    zrodloStanu: zrodlo,
    magazynWfirmy: !!w?.wfirmaWarehouseId,
    zmianaZrodlaZablokowana: zrodlo === 'WFIRMA' ? await blokadaZmianyZrodla(db, warehouseId) : await blokadaPrzejsciaNaLustro(db),
    kodyVatWfirmy: wf.kodyVat,
    wzBezFaktury: wzBezFaktury(settings),
    wzBezFakturyNiedostepne: ZAPIS_WZ_DOSTEPNY ? null : POWOD_WZ_NIEDOSTEPNE,
    korektyWlaczone: korektyWlaczone(settings),
    spakowaneBezFaktury: zrodlo === 'WFIRMA' && f['fakturyWlaczone'] !== true ? await spakowaneBezFaktury(db) : null,
  }
}

export interface FormularzDokumentow {
  program: string
  przedWysylka: boolean
  wystawiajPrzy: string
  tylkoNaZadanie: boolean
  rodzaj: string
  /** „Wystawiaj faktury z Kompletora”. Brak pola w formularzu (stary ekran) = bez zmian. */
  fakturyWlaczone?: boolean
  seriaKod: string
  seriaWzor: string
  seriaReset: string
  /** seria korekt KSeF i środowisko (brak pól w formularzu = bez zmian). */
  seriaKorektKod?: string
  seriaKorektWzor?: string
  seriaKorektReset?: string
  srodowiskoKsef?: string
  wysylkaNazwa: string
  wysylkaStawka: string
  konsumenciDoKsef: boolean
  podstawaZwolnienia: string
  /** brak pola w formularzu = wyłączone. */
  wzBezFaktury?: boolean
  /** brak pola w formularzu = bez zmian. */
  korektyWlaczone?: boolean
}

export function dokumentyZFormularza(form: FormData): FormularzDokumentow {
  const s = (k: string) => String(form.get(k) ?? '')
  const b = (k: string) => form.get(k) === 'tak'
  return {
    program: s('program'),
    przedWysylka: b('przedWysylka'),
    wystawiajPrzy: s('wystawiajPrzy'),
    tylkoNaZadanie: b('tylkoNaZadanie'),
    rodzaj: s('rodzaj'),
    ...(form.has('fakturyWlaczonePole') ? { fakturyWlaczone: b('fakturyWlaczone') } : {}),
    seriaKod: s('seriaKod'),
    seriaWzor: s('seriaWzor'),
    seriaReset: s('seriaReset'),
    ...(form.has('seriaKorektKod') ? { seriaKorektKod: s('seriaKorektKod'), seriaKorektWzor: s('seriaKorektWzor'), seriaKorektReset: s('seriaKorektReset') } : {}),
    ...(form.has('srodowiskoKsef') ? { srodowiskoKsef: s('srodowiskoKsef') } : {}),
    wysylkaNazwa: s('wysylkaNazwa'),
    wysylkaStawka: s('wysylkaStawka'),
    konsumenciDoKsef: b('konsumenciDoKsef'),
    podstawaZwolnienia: s('podstawaZwolnienia'),
    wzBezFaktury: b('wzBezFaktury'),
    ...(form.has('korektyWlaczonePole') ? { korektyWlaczone: b('korektyWlaczone') } : {}),
  }
}

/**
 * Zapis „Dokumenty sprzedaży”. `programy` = to, co ekran pokazał do wyboru (wbudowane + adaptery rejestru); inna
 * wartość jest odrzucana. Paragon tylko z programem, który go umie (dziś żaden: odmowa z komunikatem).
 */
export async function zapiszUstawieniaDokumentow(db: PrismaClient, input: FormularzDokumentow, actorId: string, programy: readonly ProgramDoWyboru[], ctx: { now?: Date } = {}): Promise<void> {
  const plan = planDokumentow(db, input, actorId, programy, ctx)
  await db.$transaction((tx) => plan(tx))
}

type TxKlient = Prisma.TransactionClient

/**
 * Walidacja formularza „Dokumenty sprzedaży” (rzuca UstawieniaDokumentowError) i zapis do wykonania w transakcji
 * wołającego (razem ze źródłem stanu jednym zapisem). Zapis zwraca `true`, gdy coś się zmieniło.
 */
function planDokumentow(db: PrismaClient, input: FormularzDokumentow, actorId: string, programy: readonly ProgramDoWyboru[], ctx: { now?: Date }): (tx: TxKlient) => Promise<boolean> {
  const organizationId = organizationIdOf(db)
  const program = programZWartosci(input.program)
  if (!program || !programy.some((p) => p.program === program)) throw new UstawieniaDokumentowError('Wybierz program do faktur z listy')
  if (!(MOMENTY_WYSTAWIENIA as readonly string[]).includes(input.wystawiajPrzy)) throw new UstawieniaDokumentowError('Wybierz, kiedy wystawiać dokument')
  if (!(RODZAJE_DOKUMENTU as readonly string[]).includes(input.rodzaj)) throw new UstawieniaDokumentowError('Wybierz rodzaj dokumentu')
  if (input.rodzaj === 'paragon') throw new UstawieniaDokumentowError('Żaden podłączony program nie wystawia jeszcze paragonów: zostaw „faktura”')
  if (program === 'brak' && input.przedWysylka) throw new UstawieniaDokumentowError('„Dokument przed wysyłką” wymaga programu do faktur')
  if (input.wzBezFaktury && program !== 'wfirma') throw new UstawieniaDokumentowError('„WZ przy wysyłce bez faktury” działa tylko z programem wFirma')
  if (input.korektyWlaczone && program !== 'wfirma') throw new UstawieniaDokumentowError('„Korekty faktur przy zwrotach z Kompletora” działają dziś tylko z programem wFirma')
  if (input.wzBezFaktury && !ZAPIS_WZ_DOSTEPNY) throw new UstawieniaDokumentowError(`„WZ przy wysyłce bez faktury”: ${POWOD_WZ_NIEDOSTEPNE}`)
  // wystawianie z Kompletora działa dziś z wFirmą; inne programy dostaną je razem z adapterem zapisu
  // także z programem KSeF bezpośrednio (wysyłka do KSeF z numerem z serii)
  if (input.fakturyWlaczone && program !== 'wfirma' && program !== 'ksef') throw new UstawieniaDokumentowError('„Wystawiaj faktury z Kompletora” działa dziś z programem wFirma albo KSeF bezpośrednio')
  const seriaKod = tekst(input.seriaKod)
  const seriaWzor = tekst(input.seriaWzor) ?? WZOR_FAKTUR
  const seriaReset = (OKRESY_RESETU as readonly string[]).includes(input.seriaReset) ? (input.seriaReset as OkresResetu) : 'ROK'
  if (seriaKod) {
    const p = problemySerii({ code: seriaKod, pattern: seriaWzor, resetPeriod: seriaReset })
    if (p.length) throw new UstawieniaDokumentowError(`Seria numeracji: ${p.join('; ')}`)
  }
  if (input.fakturyWlaczone && program === 'ksef' && !seriaKod) throw new UstawieniaDokumentowError('„Wystawiaj faktury z Kompletora” z KSeF wymaga serii numeracji faktur (Numeracja i KSeF)')
  const korKod = input.seriaKorektKod === undefined ? undefined : tekst(input.seriaKorektKod)
  const korWzor = tekst(input.seriaKorektWzor ?? '') ?? WZOR_KOREKT
  const korReset = (OKRESY_RESETU as readonly string[]).includes(input.seriaKorektReset ?? '') ? (input.seriaKorektReset as OkresResetu) : 'ROK'
  if (korKod) {
    const p = problemySerii({ code: korKod, pattern: korWzor, resetPeriod: korReset })
    if (p.length) throw new UstawieniaDokumentowError(`Seria korekt: ${p.join('; ')}`)
    if (seriaKod && korKod === seriaKod) throw new UstawieniaDokumentowError('Seria korekt musi mieć inny kod niż seria faktur')
    if (seriaKod && normalizujWzor(korWzor) === normalizujWzor(seriaWzor)) throw new UstawieniaDokumentowError('Seria korekt musi mieć inny wzór numeru niż seria faktur (np. z końcówką /K), inaczej numery by się powtórzyły')
  }
  const srodowisko = input.srodowiskoKsef === undefined ? undefined : input.srodowiskoKsef
  if (srodowisko !== undefined && !(SRODOWISKA_FIRMY as readonly string[]).includes(srodowisko)) throw new UstawieniaDokumentowError('Wybierz środowisko KSeF: testowe, przedprodukcyjne albo produkcyjne')
  const wysylkaNazwa = tekst(input.wysylkaNazwa)
  if (wysylkaNazwa && wysylkaNazwa.length > 100) throw new UstawieniaDokumentowError('Nazwa pozycji wysyłki: najwyżej 100 znaków')
  const wysylkaStawka = tekst(input.wysylkaStawka) ?? '23'
  if (!(STAWKI as readonly string[]).includes(wysylkaStawka)) throw new UstawieniaDokumentowError('Stawka VAT wysyłki: 23, 8, 5, 0 albo zw')
  const podstawa = tekst(input.podstawaZwolnienia)
  if (podstawa && podstawa.length > 256) throw new UstawieniaDokumentowError('Podstawa zwolnienia: najwyżej 256 znaków')

  return async (tx) => {
    const rows = await tx.$queryRaw<{ settings: Prisma.JsonValue }[]>`SELECT settings FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`
    if (!rows[0]) throw new Error('Brak firmy klienta')
    // lustro wFirmy zdejmuje towar fakturą z WZ, więc wymaga programu wFirma
    if (program !== 'wfirma' && zrodloZMagazynu(await tx.warehouse.findFirst({ where: { id: DEFAULT_WAREHOUSE }, select: { stockSource: true, wfirmaWarehouseId: true } })) === 'WFIRMA')
      throw new UstawieniaDokumentowError(BLAD_PARY)
    const settings: Json = isObj(rows[0].settings) ? rows[0].settings : {}
    const f: Json = isObj(settings['faktury']) ? settings['faktury'] : {}
    const k: Json = isObj(settings['ksef']) ? settings['ksef'] : {}
    const w: Json = isObj(f['wysylka']) ? f['wysylka'] : {}
    // wyłącznik: brak pola = bez zmian; włączenie zapisuje chwilę (dokument bez rozchodu nie dostaje zaległości sprzed niej)
    const wlaczone = input.fakturyWlaczone ?? f['fakturyWlaczone'] === true
    // ×, (wariant a): WZ to wyjście awaryjne toru faktur Kompletora („Wyślij bez
    // faktury”), idzie tym samym torem zapisu (kolejka wFirmy), więc wymaga też „Wystawiaj faktury z Kompletora”
    if (input.korektyWlaczone && !wlaczone) throw new UstawieniaDokumentowError('„Korekty faktur przy zwrotach z Kompletora” wymagają włączonego „Wystawiaj faktury z Kompletora”')
    if (input.wzBezFaktury && !wlaczone) throw new UstawieniaDokumentowError('„WZ przy wysyłce bez faktury” wymaga włączonego „Wystawiaj faktury z Kompletora”')
    // chwila z zegara bazy — bramka porównuje ją z `OrderEvent.createdAt` (`now()` bazy)
    const teraz = async () => ctx.now ?? (await tx.$queryRaw<{ n: Date }[]>`SELECT now() AS n`)[0]!.n
    const wlaczoneOd = wlaczone ? (f['fakturyWlaczone'] === true && typeof f['fakturyWlaczoneOd'] === 'string' ? f['fakturyWlaczoneOd'] : (await teraz()).toISOString()) : null
    const { fakturyWlaczoneOd: _od, ...fBezOd } = f
    void _od
    const faktury: Json = {
      ...fBezOd,
      ...(wlaczone || 'fakturyWlaczone' in f ? { fakturyWlaczone: wlaczone } : {}),
      ...(wlaczoneOd ? { fakturyWlaczoneOd: wlaczoneOd } : {}),
      program,
      przedWysylka: input.przedWysylka,
      wystawiajPrzy: input.wystawiajPrzy as MomentWystawienia,
      tylkoNaZadanie: input.tylkoNaZadanie,
      rodzaj: input.rodzaj as RodzajDokumentu,
      wysylka: { ...w, ...(wysylkaNazwa ? { nazwa: wysylkaNazwa } : {}), stawkaVat: wysylkaStawka },
    }
    // pole zapisywane tylko, gdy włączone albo już było (firmy bez niego bez zmiany ustawień i wpisu w historii)
    if (input.wzBezFaktury) faktury['wzBezFaktury'] = true
    else if ('wzBezFaktury' in f) faktury['wzBezFaktury'] = false
    // pole tylko, gdy przyszło z formularza; wyłączenie faktur wyłącza też korekty
    if (input.korektyWlaczone !== undefined) faktury['korektyWlaczone'] = input.korektyWlaczone && wlaczone
    else if (!wlaczone && f['korektyWlaczone'] === true) faktury['korektyWlaczone'] = false
    // chwila włączenia WZ; zostaje przy kolejnych zapisach z włączonym WZ, znika przy
    // wyłączeniu. WZ dostają tylko wysyłki od tej chwili (zaległe biuro udokumentowało ręcznie).
    const wzOd = input.wzBezFaktury ? (f['wzBezFaktury'] === true && typeof f['wzBezFakturyOd'] === 'string' ? f['wzBezFakturyOd'] : (await teraz()).toISOString()) : null
    if (wzOd) faktury['wzBezFakturyOd'] = wzOd
    else delete faktury['wzBezFakturyOd']
    const ksef: Json = { ...k, konsumenciDoKsef: input.konsumenciDoKsef }
    if (seriaKod) Object.assign(ksef, { seriaKod, seriaWzor, seriaReset })
    else for (const key of ['seriaKod', 'seriaWzor', 'seriaReset']) delete ksef[key]
    if (podstawa) ksef['podstawaZwolnienia'] = podstawa
    else delete ksef['podstawaZwolnienia']
    // seria korekt i środowisko KSeF tylko, gdy przyszły z formularza
    if (korKod) Object.assign(ksef, { seriaKorektKod: korKod, seriaKorektWzor: korWzor, seriaKorektReset: korReset })
    else if (korKod === null) for (const key of ['seriaKorektKod', 'seriaKorektWzor', 'seriaKorektReset']) delete ksef[key]
    if (srodowisko) ksef['srodowisko'] = srodowisko
    const przed = { faktury: f, ksef: k }
    const po = { faktury, ksef }
    if (JSON.stringify(przed) === JSON.stringify(po)) return false
    await tx.organization.update({ where: { id: organizationId }, data: { settings: { ...settings, faktury, ksef } as Prisma.InputJsonValue } })
    await tx.auditLog.create({ data: { entity: 'Organization.faktury', entityId: organizationId, actorId, before: przed as Prisma.InputJsonValue, after: po as Prisma.InputJsonValue } })
    return true
  }
}

/**
 * Źródło stanu magazynu z panelu. WFIRMA tylko przy magazynie wskazującym magazyn wFirmy; zmiana zablokowana, gdy coś
 * jest w drodze (rezerwacje w fakturze, ruchy do potwierdzenia). Ślad w AuditLog.
 */
export async function zmienZrodloStanu(db: PrismaClient, zrodlo: string, actorId: string, warehouseId = DEFAULT_WAREHOUSE): Promise<ZrodloStanu> {
  const plan = planZrodla(db, zrodlo, actorId, warehouseId)
  const wynik = await db.$transaction((tx) => plan(tx))
  // zlecenie pełnego odczytu lustra wFirmy jest w tej samej transakcji (planZrodla)
  return wynik.nowe
}

/**
 * Sprawdzenia i zapis źródła stanu do wykonania w transakcji wołającego. `tylkoZmiana`: to samo źródło co wynika
 * z magazynu = nic (ekran „Dokumenty sprzedaży” wysyła źródło przy każdym zapisie).
 */
function planZrodla(db: PrismaClient, zrodlo: string, actorId: string, warehouseId: string, o: { tylkoZmiana?: boolean } = {}): (tx: TxKlient) => Promise<{ przed: ZrodloStanu; nowe: ZrodloStanu; zmiana: boolean }> {
  if (!(ZRODLA_STANU as readonly string[]).includes(zrodlo)) throw new UstawieniaDokumentowError('Wybierz, kto prowadzi stan magazynu')
  const nowe = zrodlo as ZrodloStanu
  const organizationId = organizationIdOf(db)
  // sprawdzenia i zapis w jednej transakcji, pod blokadą wiersza firmy i magazynu (ten sam wiersz
  // firmy blokuje zapis „Dokumenty sprzedaży”, więc para źródło/program nie rozjedzie się przy równoległym zapisie)
  return async (tx) => {
    const org = await tx.$queryRaw<{ settings: Prisma.JsonValue }[]>`SELECT settings FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`
    if (!org[0]) throw new Error('Brak firmy klienta')
    const rows = await tx.$queryRaw<{ stockSource: ZrodloStanu | null; wfirmaWarehouseId: string | null }[]>`
      SELECT "stockSource", "wfirmaWarehouseId" FROM "Warehouse" WHERE id = ${warehouseId} FOR UPDATE`
    const w = rows[0]
    if (!w) throw new UstawieniaDokumentowError('Nie ma takiego magazynu')
    const przed = zrodloZMagazynu(w)
    if (przed === nowe && (w.stockSource === nowe || o.tylkoZmiana)) return { przed, nowe, zmiana: false }
    if (nowe === 'WFIRMA' && !w.wfirmaWarehouseId) throw new UstawieniaDokumentowError('Lustro wFirmy wymaga magazynu wFirmy podłączonego do tego magazynu (konfiguracja firmy)')
    if (nowe === 'WFIRMA' && parseUstawieniaDokumentow(org[0].settings, { maWfirme: true }).program !== 'wfirma') throw new UstawieniaDokumentowError(BLAD_PARY)
    if (przed !== nowe) {
      // przebieg kolejki wFirmy w toku mógłby założyć fakturę w drodze już po zmianie.
      // Wiersz dzierżawy pod blokadą (kolejność Organization → Warehouse → WfirmaQueueState, kolejka bierze dzierżawę
      // pojedynczym UPDATE, bez innych blokad), więc nowy przebieg zaczyna się dopiero po tej transakcji.
      // wiersz kolejki zakładany przed blokadą (firma, której kolejka jeszcze nie ruszyła), żeby
      // równoległy pierwszy przebieg kolejki nie zderzył się z upsertem zlecenia odczytu niżej (P2002)
      await tx.$executeRaw`INSERT INTO "WfirmaQueueState" ("organizationId", "updatedAt") VALUES (${organizationId}, now()) ON CONFLICT ("organizationId") DO NOTHING`
      const q = await tx.$queryRaw<{ runLockUntil: Date | null }[]>`SELECT "runLockUntil" FROM "WfirmaQueueState" WHERE "organizationId" = ${organizationId} FOR UPDATE`
      const teraz = (await tx.$queryRaw<{ n: Date }[]>`SELECT now() AS n`)[0]!.n
      if (q[0]?.runLockUntil && q[0].runLockUntil > teraz) throw new UstawieniaDokumentowError('Kolejka wFirmy właśnie pracuje: spróbuj za chwilę.')
      // z lustra wFirmy: rzeczy w drodze należą do wFirmy (powrót na lustro rozliczy je sam); na lustro: zwroty bez
      // faktury zgłoszone przy Kompletorze muszą się najpierw zakończyć
      const blokada = przed === 'WFIRMA' ? await blokadaZmianyZrodla(tx, warehouseId) : await blokadaPrzejsciaNaLustro(tx)
      if (blokada) throw new UstawieniaDokumentowError(blokada)
    }
    await tx.warehouse.update({ where: { organizationId_id: { organizationId: organizationIdOf(db), id: warehouseId } }, data: { stockSource: nowe } })
    await tx.auditLog.create({ data: { entity: 'Warehouse.stockSource', entityId: warehouseId, actorId, before: { zrodlo: przed, jawne: w.stockSource ?? null }, after: { zrodlo: nowe } } })
    if (przed !== nowe) {
      const teraz = (await tx.$queryRaw<{ n: Date }[]>`SELECT now() AS n`)[0]!.n
      // (w tej samej transakcji): lustro po przełączeniu z Kompletora — stan z korekt panelu zastąpi pełny
      // odczyt wFirmy przy najbliższym przebiegu. Odwrotnie: zlecony odczyt lustra już nie dotyczy, zdejmujemy go.
      if (nowe === 'WFIRMA') await requestFullReadInTx(tx, organizationId, teraz)
      else await tx.wfirmaQueueState.updateMany({ where: { organizationId }, data: { fullReadDueSince: null, fullReadPage: 0 } })
    }
    return { przed, nowe, zmiana: przed !== nowe }
  }
}

/**
 * ekran „Dokumenty sprzedaży” jednym zapisem: źródło stanu i ustawienia dokumentów w jednej transakcji
 * (wszystko albo nic). Kolejność wewnątrz wynika z pary źródło/program: przejście na lustro wFirmy wymaga najpierw
 * programu wFirma, a zmiana programu z wFirmy na inny wymaga najpierw źródła „Kompletor”. `zrodlo` puste = bez zmiany
 * (np. zmiana źródła zablokowana i pole wyłączone).
 */
export async function zapiszDokumentySprzedazy(
  db: PrismaClient,
  dane: { zrodlo: string | null; dokumenty: FormularzDokumentow },
  actorId: string,
  programy: readonly ProgramDoWyboru[],
  ctx: { now?: Date } = {},
): Promise<{ zrodlo: boolean; dokumenty: boolean }> {
  const pD = planDokumentow(db, dane.dokumenty, actorId, programy, ctx)
  const pZ = dane.zrodlo ? planZrodla(db, dane.zrodlo, actorId, DEFAULT_WAREHOUSE, { tylkoZmiana: true }) : null
  const wynik = await db.$transaction(async (tx) => {
    if (pZ && dane.zrodlo === 'WFIRMA') {
      const dokumenty = await pD(tx)
      return { zrodlo: (await pZ(tx)).zmiana, dokumenty }
    }
    const zrodlo = pZ ? (await pZ(tx)).zmiana : false
    return { zrodlo, dokumenty: await pD(tx) }
  })
  // zlecenie pełnego odczytu lustra idzie w tej samej transakcji (planZrodla)
  return wynik
}

export const BLAD_PARY = 'Lustro magazynu wFirmy wymaga programu wFirma (to faktura zdejmuje towar). Żeby wybrać inny program, najpierw przełącz „Kto prowadzi stan magazynu” na Kompletor.'

export { ETYKIETA_ZRODLA, PROGRAMY_WBUDOWANE }
