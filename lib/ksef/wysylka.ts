// Wysyłka faktur i korekt FA(3) do KSeF dla firm bez wFirmy (G7). Program „KSeF bezpośrednio”: Kompletor
// sam nadaje numer z serii, składa XML z nabywcą z bazy i wysyła go sesją interaktywną KSeF; zapisuje numer KSeF
// i UPO. Klient bazy firmy (RLS).
//
// Bramka (lib/ksef/api/bramka.ts): program KSeF, „Wystawiaj faktury z Kompletora”, konto sklepu w trybie „Aktywny”,
// środowisko jawnie wybrane (domyślnie TEST), produkcja tylko z kluczami operatora serwera. W testach produkcja
// zamknięta zawsze, a sieć to atrapa (tests/ksef-atrapa.ts).
//
// Idempotencja (kryterium „ponowienie po zgubionej odpowiedzi nie tworzy drugiej faktury”):
//   - jeden wiersz `KsefInvoiceDraft` na fakturę (zamówienie + paczka) i na korektę (zwrot): klucz unikalny w bazie,
//   - numer z serii przydziela się raz, w transakcji pod blokadą wiersza; każda kolejna próba wysyła TEN SAM numer,
//   - po odpowiedzi 202 referencje sesji i faktury zapisują się od razu: ponowienie najpierw pyta KSeF o status,
//   - gdy odpowiedź zginęła przed zapisem referencji, ponowienie wysyła tę samą fakturę jeszcze raz, a KSeF odrzuca
//     dubel kodem 440 i podaje numer KSeF oryginału: zapisujemy go jako przyjęcie, bez drugiej faktury.
// XML z nabywcą żyje tylko w pamięci próby; w bazie zostają numery, kody i komunikaty KSeF (bez danych nabywcy).
//
// (utwardzenie przed pierwszą produkcyjną fakturą):
//   - data wytworzenia XML zamrożona z numerem (XML ponowienia = ten sam hash), hash każdego wysłanego XML-a
//     zapisany PRZED wysłaniem (`hasheWyslane`), hash przyjętego dokumentu w `invoiceHash` (PDF ostrzega o rozjeździe),
//   - (+): każdy zapis stanu próby tylko z `WYSYLANA` I znacznikiem TEJ próby (`wysylkaOd`
//     + `proby`), więc spóźniona próba nie nadpisze nowszej (także takiej, która znów ustawiła `WYSYLANA`) i nie wyśle
//     niczego po przejęciu wiersza przez inną,
//   - dopasowanie faktury w sesji oryginału po numerze I hashu,
//   - przebieg workera loguje się raz (wspólne połączenie) i nie zaczyna dokumentu tuż przed limitem czasu,
//   - przyczyna błędu jako kod, automat ponawia przyczyny „nasze” z odstępem; osobny licznik odczytów stanu,
//   - po `UZUPELNIANIE_PROB_MAX` nieudanych dociągnięciach numeru KSeF/UPO komunikat dla człowieka i koniec prób,
//   - data wystawienia przy ponowieniu wg ustawienia `ksef.dataPrzyPonowieniu` (domyślnie).
import { createHash } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import { organizationIdOf } from '../db'
import { parseUstawieniaDokumentow, programFaktur, statusyMomentu } from '../dokumenty/ustawienia'
import { toWarsaw } from '../rdzen/kalendarz'
import { advisoryLock, runTx } from '../rdzen/stan'
import { zrodloStanu } from '../rdzen/zrodlo-stanu'
import { resolveSecrets, type SecretSource } from '../sekrety'
import type { FetchLike } from '../zrodla/http'
import { szkicKorektyKsef } from '../zwroty/korekta-ksef'
import { bramkaWysylki, type Env, type WynikBramki } from './api/bramka'
import { automatPonawia, komunikatWysylki, odstepPonowienia, PONOWIENIA_AUTO_MAX, PRZYCZYNY_AUTO, przyczynaWysylki, type Przyczyna } from './przyczyny'
import { BladKsefApi, KsefPolaczenie } from './api/polaczenie'
import {
  downloadInvoiceUpo,
  downloadInvoiceUpoByKsefNumber,
  getSessionInvoiceStatus,
  interpretInvoiceStatus,
  KsefHttpError,
  KsefOnlineSession,
  znajdzFaktureWSesji,
  type KsefInvoiceOutcome,
  type KsefTransport,
  type SentInvoice,
} from './api/sesja'
import { katalogXsd, wczytajSchematy, walidujFa3 } from './fa3/xsd'
import { parseKonfiguracjaKsef } from './konfiguracja'
import { przydzielNumer } from './numeracja'
import { prepareKsefForOrder, zlozFaktureDoWysylki } from './szkice'

type Db = PrismaClient

export const KSEF_TOKEN = 'KSEF_TOKEN'
/** Próba WYSYLANA starsza niż tyle = porzucona (worker padł w trakcie): sprzątacz oznacza ją jako BLAD_WYSYLKI. */
export const PROBA_PORZUCONA_MS = 5 * 60_000
/**
 * Faktura wysłana (KSeF dał 202), a odczyt jej stanu się nie udał (sieć, 429, 401, przerwanie): zostaje WYSLANA, a
 * przebieg workera co 2 min pyta KSeF o stan (bez drugiej wysyłki). Po tylu próbach w sumie przechodzi do
 * BLAD_WYSYLKI z zachowanymi referencjami: „Ponów” dalej najpierw pyta o stan.
 */
export const PROBY_ODCZYTU_STANU = 30
/** Ile dni po przyjęciu worker próbuje dociągnąć brakujący numer KSeF albo UPO. */
export const UZUPELNIANIE_DNI = 7
/** po tylu nieudanych dociągnięciach numeru KSeF/UPO wiersz dostaje komunikat dla człowieka i worker przestaje. */
export const UZUPELNIANIE_PROB_MAX = 10
export const KOMUNIKAT_UZUPELNIANIA = 'Numer KSeF albo UPO do sprawdzenia ręcznie w Aplikacji Podatnika KSeF: system nie zdołał ich pobrać.'
/** w przebiegu workera czekamy na wynik krócej (stan i tak dociąga następny przebieg co 2 min). */
export const CZEKAJ_W_PRZEBIEGU_MS = 20_000
/** nie zaczynamy kolejnego dokumentu, gdy do limitu zadania zostało mniej niż tyle. */
export const ZAPAS_PRZEBIEGU_MS = 90_000

/** SHA-256 (base64) bajtów UTF-8 XML-a: to samo, co KSeF liczy jako `invoiceHash` (lib/ksef/api/szyfrowanie.ts). */
export function hashFaktury(xml: string): string {
  return createHash('sha256').update(Buffer.from(xml, 'utf8')).digest('base64')
}

export type WynikWysylki =
  | { wynik: 'przyjeta'; numer: string; ksefNumer: string | null }
  | { wynik: 'w_toku'; numer: string | null; powod: string }
  | { wynik: 'odrzucona'; numer: string; powod: string }
  | { wynik: 'blad'; numer: string | null; powod: string }
  | { wynik: 'odmowa'; powod: string }

export interface ZaleznosciWysylki {
  secrets: SecretSource
  /** Sieć (testy: atrapa KSeF). */
  fetch?: FetchLike
  env?: Env
  now?: Date
  sleep?: (ms: number) => Promise<void>
  /** Zegar limitów czasu w ms (domyślnie `Date.now`). `now` wyżej to chwila wystawienia i wyboru certyfikatu. */
  zegar?: () => number
  /** Przerwanie z zewnątrz (twardy limit zadania `ksef-wysylka`): próba kończy się jak przy braku odpowiedzi KSeF. */
  sygnal?: AbortSignal
  /** Ile najwyżej czekać na wynik przetwarzania po wysyłce; potem status WYSLANA i stan dociąga przebieg workera. */
  czekajNaWynikMs?: number
  xsdDir?: string
  /** Kto zlecił (osoba z panelu albo `system:worker`), do historii zamówienia. */
  actorId?: string
  /** Transport podany wprost (testy jednostkowe); w aplikacji połączenie tokenem przez bramkę. */
  transport?: KsefTransport
  /** wspólne połączenie przebiegu workera (jedno logowanie na przebieg); bez niego każda próba loguje się sama. */
  polaczenie?: WspolnePolaczenie
  /** wywołanie z automatu ponowień (licznik `ponowieniaAuto` rośnie); każde inne wywołanie go zeruje. */
  ponowienieAuto?: boolean
  /** chwila końca budżetu przebiegu w ms zegara `zegar` (ustawia `przebiegKsefZLimitem`). */
  koniecMs?: number
}

/** Brak tokenu KSeF firmy (konfiguracja, nie błąd sieci). */
export class BrakTokenuKsef extends Error {
  constructor() {
    super('Brak tokenu KSeF firmy: wpisz go w Ustawienia → Dokumenty i faktury → Dokumenty sprzedaży → Numeracja i KSeF.')
  }
}

type Dozwolona = Extract<WynikBramki, { dozwolona: true }>

/**
 * jedno połączenie (uwierzytelnienie tokenem) na przebieg workera, otwierane leniwie przy pierwszym dokumencie,
 * który potrzebuje sieci. Nieudane logowanie zapamiętuje się do końca przebiegu (`nieudane`): przebieg nie zaczyna
 * kolejnych dokumentów, następny spróbuje od nowa. Połączenie jest związane ze środowiskiem z bramki pierwszego
 * dokumentu; dokument z bramką innego środowiska dostaje błąd (nie powinien się zdarzyć: środowisko jest per firma).
 */
export interface WspolnePolaczenie {
  daj(bramka: Dozwolona): Promise<KsefTransport>
  readonly nieudane: boolean
}

export function wspolnePolaczenie(db: Db, deps: ZaleznosciWysylki): WspolnePolaczenie {
  let p: Promise<KsefPolaczenie> | null = null
  let srodowisko: string | null = null
  let nieudane = false
  return {
    get nieudane() {
      return nieudane
    },
    async daj(bramka) {
      if (!p) {
        srodowisko = bramka.srodowisko
        const now = deps.now ?? new Date()
        p = (async () => {
          const cfg = parseKonfiguracjaKsef((await db.organization.findFirst({ select: { settings: true } }))?.settings ?? null)
          const tok = (await resolveSecrets(db, [KSEF_TOKEN], deps.secrets))[KSEF_TOKEN]
          if (!tok) throw new BrakTokenuKsef()
          return KsefPolaczenie.otworz(bramka, { nip: cfg.sprzedawca!.nip, token: tok }, { fetch: deps.fetch, sleep: deps.sleep, now: () => now, zegar: deps.zegar, sygnal: deps.sygnal })
        })()
        p.catch(() => {
          nieudane = true
        })
      }
      if (bramka.srodowisko !== srodowisko) throw new BladKsefApi(`KSeF: połączenie przebiegu jest dla środowiska ${srodowisko}, dokument dla ${bramka.srodowisko}`)
      return p
    },
  }
}

/** Id wiersza korekty: stałe dla zwrotu (ponowienie trafia w ten sam wiersz). */
export function idKorekty(organizationId: string, returnId: string): string {
  return createHash('sha256').update(`ksef-kor|${organizationId}|${returnId}`).digest('hex').slice(0, 24)
}

const DOZWOLONE_DO_WYSYLKI = new Set(['ZLOZONA', 'ODLOZONA', 'BLAD_WYSYLKI', 'ODRZUCONA', 'WYSLANA', 'WYSYLANA'])

const tekstBledu = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500)

async function bramkaDla(db: Db, orderId: string, env: Env): Promise<WynikBramki> {
  const org = await db.organization.findFirst({ select: { settings: true } })
  const settings = org?.settings ?? null
  const program = programFaktur(settings, { maWfirme: (await zrodloStanu(db)) === 'WFIRMA' })
  const u = parseUstawieniaDokumentow(settings)
  const cfg = parseKonfiguracjaKsef(settings)
  const o = await db.order.findUnique({ where: { id: orderId }, select: { channel: true, channelAccountId: true } })
  if (!o) return { dozwolona: false, powod: 'Nie ma takiego zamówienia.' }
  const konto = await db.channelConfig.findFirst({ where: { channel: o.channel, channelAccountId: o.channelAccountId }, select: { statusMode: true } })
  return bramkaWysylki({ program, fakturyWlaczone: u.fakturyWlaczone, trybKonta: konto?.statusMode ?? null, kanal: o.channel, srodowisko: cfg.srodowisko, nipSprzedawcy: cfg.sprzedawca?.nip ?? null }, env)
}

/** Powód, dla którego przycisk „Wyślij do KSeF” / „Ponów” jest nieaktywny; null = można wysłać. */
export async function powodBrakuWysylki(db: Db, orderId: string, env: Env = process.env): Promise<string | null> {
  const b = await bramkaDla(db, orderId, env)
  return b.dozwolona ? null : b.powod
}

/**
 * Wysyłka (albo ponowienie) jednego dokumentu KSeF: faktury (`rodzaj` VAT) albo korekty (KOR). Bezpieczne do
 * ponawiania i do równoległych wywołań: blokada wiersza, numer raz, status w KSeF przed ponowną wysyłką.
 */
export async function wyslijDoKsef(db: Db, draftId: string, deps: ZaleznosciWysylki): Promise<WynikWysylki> {
  const env = deps.env ?? process.env
  const now = deps.now ?? new Date()
  const d0 = await db.ksefInvoiceDraft.findUnique({ where: { id: draftId } })
  if (!d0) return { wynik: 'odmowa', powod: 'Nie ma takiej faktury.' }
  if (d0.status === 'PRZYJETA') return { wynik: 'przyjeta', numer: d0.numer!, ksefNumer: d0.ksefNumer }
  const bramka = await bramkaDla(db, d0.orderId, env)
  if (!bramka.dozwolona) return { wynik: 'odmowa', powod: bramka.powod }
  const cfg = parseKonfiguracjaKsef((await db.organization.findFirst({ select: { settings: true } }))?.settings ?? null)
  const kor = d0.rodzaj === 'KOR'
  // bez schematów FA(3) nic nie wychodzi (żadne środowisko) i numer z serii nie zostaje zużyty
  const xsdDir = deps.xsdDir ?? katalogXsd()
  const xsd = await wczytajSchematy(xsdDir)
  if (!xsd.schematy) return { wynik: 'odmowa', powod: `Brak schematów FA(3) na serwerze (${xsd.powod}): faktury nie wychodzą do KSeF bez sprawdzenia schematem. Zgłoś to administratorowi.` }

  // 1. Transakcja: blokada, numer raz, próba WYSYLANA
  const start = await runTx(db, async (tx) => {
    await advisoryLock(tx, `ksef:${draftId}`)
    const d = await tx.ksefInvoiceDraft.findUniqueOrThrow({ where: { id: draftId } })
    if (d.status === 'PRZYJETA') return { kind: 'gotowa' as const, numer: d.numer!, ksefNumer: d.ksefNumer }
    if (d.status === 'WYSYLANA' && d.wysylkaOd && now.getTime() - d.wysylkaOd.getTime() < PROBA_PORZUCONA_MS) return { kind: 'w_toku' as const, numer: d.numer }
    if (!DOZWOLONE_DO_WYSYLKI.has(d.status)) return { kind: 'odmowa' as const, powod: d.status === 'POZA_KSEF' ? 'Faktura dla osoby prywatnej nie idzie do KSeF (Ustawienia → Dokumenty i faktury → Dokumenty sprzedaży).' : 'Faktura ma problemy danych: popraw je i przygotuj ją ponownie na karcie zamówienia.' }
    let numer = d.numer
    let data = d.dataWystawienia
    // data wytworzenia XML zamrożona razem z numerem (wiersze dostają ją przy tej próbie)
    let wytworzona = d.wytworzonaAt ?? now
    if (!numer) {
      const seria = kor ? cfg.seriaKorekt : cfg.seria
      if (!seria) return { kind: 'odmowa' as const, powod: kor ? 'Brak serii numeracji korekt: ustaw ją w Ustawienia → Dokumenty i faktury → Dokumenty sprzedaży.' : 'Brak serii numeracji faktur: ustaw ją w Ustawienia → Dokumenty i faktury → Dokumenty sprzedaży.' }
      data = toWarsaw(now).day
      wytworzona = now
      numer = (await przydzielNumer(tx, seria, data)).numer
      if (await tx.ksefInvoiceDraft.findFirst({ where: { numer, id: { not: draftId } }, select: { id: true } })) throw new BladNumeru(`Numer ${numer} jest już zajęty (inna seria ma ten sam wzór): zmień wzór serii.`)
    } else if (cfg.dataPrzyPonowieniu === 'DZIEN_WYSYLKI' && d.hasheWyslane.length === 0 && !d.sesjaRef) {
      // wariant „dzień faktycznego przesłania”: tylko gdy żadna wcześniejsza wersja nie może być w KSeF (nic nie
      // wysłano albo KSeF ją odrzucił); numer z serii zostaje ten sam. Sama referencja sesji też blokuje zmianę
      // (wiersze bez hashy: odpowiedź na wysyłkę mogła zginąć po otwarciu sesji)
      data = toWarsaw(now).day
      wytworzona = now
    }
    const ponowieniaAuto = deps.ponowienieAuto ? d.ponowieniaAuto + 1 : 0
    await tx.ksefInvoiceDraft.update({
      where: { id: draftId },
      data: { numer, dataWystawienia: data, wytworzonaAt: wytworzona, seriaKod: d.seriaKod ?? (kor ? cfg.seriaKorekt?.code : cfg.seria?.code) ?? null, status: 'WYSYLANA', proby: d.proby + 1, ponowieniaAuto, nastepnaProbaOd: null, przyczyna: null, wysylkaOd: now, srodowisko: bramka.srodowisko, lastError: null },
    })
    return { kind: 'start' as const, numer: numer!, data: data!, wytworzona, sesjaRef: d.sesjaRef, fakturaRef: d.fakturaRef, korygowanaId: d.korygowanaId, proby: d.proby + 1, probyOdczytu: d.probyOdczytu, ponowieniaAuto, hashe: d.hasheWyslane }
  }).catch((e) => {
    if (e instanceof BladNumeru) return { kind: 'odmowa' as const, powod: e.message }
    throw e
  })
  if (start.kind === 'gotowa') return { wynik: 'przyjeta', numer: start.numer, ksefNumer: start.ksefNumer }
  if (start.kind === 'w_toku') return { wynik: 'w_toku', numer: start.numer, powod: 'Wysyłka tej faktury jest w toku.' }
  if (start.kind === 'odmowa') return { wynik: 'odmowa', powod: start.powod }

  // każdy zapis tej próby (także `blad`) tylko, dopóki wiersz jest w WYSYLANA ze znacznikiem TEJ próby:
  // `wysylkaOd` (chwila startu; TIMESTAMP(3) trzyma ms) i `proby` (rośnie o 1 pod blokadą przy każdej próbie, więc jest
  // unikalny nawet przy tej samej chwili). Sprzątacz zeruje `wysylkaOd`, nowa próba ustawia własne wartości, więc
  // spóźniona próba nie nadpisze stanu nowszej, także gdy ta znów ma status WYSYLANA. false = wiersz przejęty, próba
  // kończy się po cichu i NIC już nie wysyła
  const zapisz: Zapis = async (data) => (await db.ksefInvoiceDraft.updateMany({ where: { id: draftId, status: 'WYSYLANA', wysylkaOd: now, proby: start.proby }, data })).count > 0
  const przejeta: WynikWysylki = { wynik: 'w_toku', numer: start.numer, powod: 'Stan tej faktury zmieniła już inna próba (ta przerwała się po limicie czasu).' }
  // `czysc` zdejmuje referencje TEJ próby, ale referencję sesji sprzed niej przywraca (wiersz bez
  // hashy, z samym `sesjaRef`: wersja z tamtej sesji mogła dojść do KSeF, więc nie może zmienić daty; krok 4 i tak
  // wymaga obu referencji, więc następna próba wyśle ten sam numer, a dubel KSeF odrzuci kodem 440)
  const blad = async (powod: string, przyczyna: Przyczyna, o: { czysc?: boolean; hashe?: string[] } = {}): Promise<WynikWysylki> => {
    const auto = automatPonawia(przyczyna)
    const zostalo = auto && start.ponowieniaAuto < PONOWIENIA_AUTO_MAX
    const kiedy = zostalo ? new Date(now.getTime() + odstepPonowienia(start.ponowieniaAuto)) : null
    const dopisek = !auto ? '' : kiedy ? ` System ponowi wysyłkę sam ok. ${godzina(kiedy)} (ponowienie ${start.ponowieniaAuto + 1} z ${PONOWIENIA_AUTO_MAX}); możesz też kliknąć „Ponów”.` : ` System ponawiał już ${PONOWIENIA_AUTO_MAX} razy: sprawdź połączenie z KSeF i kliknij „Ponów”.`
    const pelny = `${powod}${dopisek}`
    const ok = await zapisz({ status: 'BLAD_WYSYLKI', lastError: pelny.slice(0, 1000), przyczyna, nastepnaProbaOd: kiedy, wysylkaOd: null, ...(o.czysc ? { sesjaRef: start.sesjaRef ?? null, fakturaRef: null } : {}), ...(o.hashe ? { hasheWyslane: { set: o.hashe } } : {}) })
    return ok ? { wynik: 'blad', numer: start.numer, powod: pelny } : przejeta
  }
  // faktura już jest w KSeF albo w drodze (mamy referencje), nie wiemy tylko, z jakim wynikiem; referencji nie
  // czyścimy i nie piszemy „KSeF nie przyjął”: worker (a po limicie prób „Ponów”) pyta KSeF o stan. Limit liczy
  // tylko nieudane odczyty stanu (`probyOdczytu`), nie wcześniejsze próby wysyłki
  const doSprawdzenia = async (e: unknown): Promise<WynikWysylki> => {
    const przyczyna = tekstBledu(e)
    const n = start.probyOdczytu + 1
    if (n >= PROBY_ODCZYTU_STANU) {
      return blad(`Faktura poszła do KSeF, ale od ${n} prób nie udaje się odczytać jej stanu (${przyczyna}). „Ponów” najpierw zapyta KSeF o stan, bez drugiej wysyłki.`, 'ODCZYT_STANU')
    }
    const powod = `Faktura poszła do KSeF, stan do sprawdzenia: odczyt się nie udał (${przyczyna}). System zapyta KSeF ponownie za kilka minut, bez drugiej wysyłki.`
    return (await zapisz({ status: 'WYSLANA', lastError: powod.slice(0, 1000), wysylkaOd: null, probyOdczytu: n })) ? { wynik: 'w_toku', numer: start.numer, powod } : przejeta
  }

  // 2. Treść (w pamięci): faktura albo korekta z nabywcą z bazy; data wytworzenia zamrożona
  let xml: string
  if (kor) {
    const fa = d0.korygowanaId ? await db.ksefInvoiceDraft.findUnique({ where: { id: d0.korygowanaId }, select: { status: true, ksefNumer: true } }) : null
    if (!fa || fa.status !== 'PRZYJETA' || !fa.ksefNumer) return blad('Faktura korygowana nie jest jeszcze przyjęta w KSeF: najpierw wyślij fakturę.', 'DANE')
    const k = await szkicKorektyKsef(db, d0.returnId, { now: start.wytworzona, wysylka: { numer: start.numer, dataWystawienia: start.data } })
    if (!k.ok) return blad([k.powod, ...k.problemy.map((p) => p.tekst)].join(' '), 'DANE')
    xml = k.xml
  } else {
    const f = await zlozFaktureDoWysylki(db, d0.orderId, d0.packageNo, { numer: start.numer, dataWystawienia: start.data, now: start.wytworzona })
    if (!f.ok) return blad(`Faktura ma problemy danych: ${f.problemy.map((p) => p.tekst).join(' ')}`, 'DANE')
    xml = f.xml
  }
  const wal = await walidujFa3(xml, { dir: xsdDir })
  // bez treści błędów schematu: mogłyby zawierać wartości pól nabywcy
  if (wal.stan === 'BLEDY') return blad(`Faktura nie przechodzi schematu FA(3) (${wal.bledy.length} błędów). Sprawdź dane pozycji i nabywcy.`, 'DANE')
  // walidator padł (np. brak pliku .wasm w obrazie): nie wysyłamy niesprawdzonej faktury
  if (wal.stan !== 'POPRAWNY') return blad(`Nie udało się sprawdzić faktury schematem FA(3) (${wal.komunikat}). Faktura nie poszła do KSeF; zgłoś to administratorowi.`, 'SCHEMAT')
  const hash = hashFaktury(xml)

  // 3. Połączenie (token firmy z zaszyfrowanej konfiguracji; w przebiegu workera jedno na przebieg)
  let transport: KsefTransport
  try {
    if (deps.transport) transport = deps.transport
    else if (deps.polaczenie) transport = await deps.polaczenie.daj(bramka)
    else {
      const tok = (await resolveSecrets(db, [KSEF_TOKEN], deps.secrets))[KSEF_TOKEN]
      if (!tok) throw new BrakTokenuKsef()
      transport = await KsefPolaczenie.otworz(bramka, { nip: cfg.sprzedawca!.nip, token: tok }, { fetch: deps.fetch, sleep: deps.sleep, now: () => now, zegar: deps.zegar, sygnal: deps.sygnal })
    }
  } catch (e) {
    if (e instanceof BrakTokenuKsef) return blad(e.message, 'KONFIGURACJA')
    // faktura już wysłana wcześniej (referencje są): logowanie się nie udało, ale stan dalej do sprawdzenia
    if (start.sesjaRef && start.fakturaRef) return doSprawdzenia(new Error(`logowanie do KSeF: ${tekstBledu(e)}`))
    return blad(`Nie udało się zalogować do KSeF: ${tekstBledu(e)}.`, deps.sygnal?.aborted ? 'PRZERWANA' : 'LOGOWANIE')
  }

  // 4. Ponowienie po 202: najpierw status w KSeF (bez drugiej wysyłki)
  if (start.sesjaRef && start.fakturaRef) {
    try {
      const st = await getSessionInvoiceStatus(transport, start.sesjaRef, start.fakturaRef)
      return await rozstrzygnij(zapisz, przejeta, start.numer, interpretInvoiceStatus(st), transport, start.sesjaRef, start.fakturaRef, now, { hashe: start.hashe, hashKsef: st.invoiceHash ?? null })
    } catch (e) {
      if (!(e instanceof KsefHttpError && e.status === 404)) return doSprawdzenia(e)
      // sesja wygasła albo KSeF jej nie zna: wysyłamy ten sam numer jeszcze raz (dubel = 440 z numerem oryginału)
    }
  }

  // 5. Wysyłka sesją interaktywną. Hash dopisany PRZED wysłaniem (/: zgubiona odpowiedź nie gubi hashu), status
  // zostaje WYSYLANA do końca próby, więc po przejęciu wiersza przez inną próbę ta nic już nie wyśle.
  let sesja: KsefOnlineSession | null = null
  let wyslana: SentInvoice | null = null
  const hasheZTa = start.hashe.includes(hash) ? start.hashe : [...start.hashe, hash]
  try {
    sesja = await KsefOnlineSession.open(transport, { now })
    if (!(await zapisz({ sesjaRef: sesja.referenceNumber, fakturaRef: null, hasheWyslane: { set: hasheZTa } }))) return przejeta
    wyslana = await sesja.sendInvoice(xml)
    if (!(await zapisz({ fakturaRef: wyslana.referenceNumber, invoiceHash: hash, probyOdczytu: 0 }))) return przejeta
    const { outcome, status } = await sesja.waitForInvoice(wyslana.referenceNumber, { timeoutMs: deps.czekajNaWynikMs ?? 60_000, ...(deps.sleep ? { sleep: deps.sleep } : {}), ...(deps.zegar ? { now: deps.zegar } : {}) })
    return await rozstrzygnij(zapisz, przejeta, start.numer, outcome, transport, sesja.referenceNumber, wyslana.referenceNumber, now, { hashe: start.hashe, hashKsef: status.invoiceHash || hash, poOdrzuceniu: start.hashe })
  } catch (e) {
    // po 202: błąd odczytu stanu albo zapisu wyniku nie znaczy „KSeF nie przyjął” — stan do sprawdzenia
    if (wyslana) return doSprawdzenia(e)
    // przed 202: 4xx (także 429) = KSeF jej nie przyjął (referencje i hash tej wersji zdejmujemy); sieć, 5xx, przerwanie =
    // nie wiadomo (ponowienie wyśle ten sam numer, hash zostaje, bo ta wersja może być w KSeF)
    const przyczyna = przyczynaWysylki(e, !!deps.sygnal?.aborted)
    // LOGOWANIE z `przyczynaWysylki` = 401/403 na żądaniu (token odrzucony): żądanie odrzucone, nic w KSeF
    const pewnieNie = przyczyna === 'KSEF_ODMOWA' || przyczyna === 'LIMIT_ZADAN' || przyczyna === 'LOGOWANIE'
    // zdejmujemy tylko to, co zapisała TA próba (referencja jej sesji i hash jej wersji): odmowa przy otwarciu sesji
    // zostawia referencje wcześniejszej próby (wiersz z samym `sesjaRef` dalej blokuje zmianę daty)
    // odmowa przy otwarciu sesji (faktura nie wyszła) ma własny komunikat
    return blad(komunikatWysylki(przyczyna, tekstBledu(e), { otwarcieSesji: !sesja }), przyczyna, pewnieNie && sesja ? { czysc: true, hashe: start.hashe } : {})
  } finally {
    await sesja?.close().catch(() => {})
  }
}

class BladNumeru extends Error {}

const godzina = (d: Date) => new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit' }).format(d)

type Zapis = (data: Prisma.KsefInvoiceDraftUpdateManyMutationInput) => Promise<boolean>

/**
 * Zapis wyniku przetwarzania (tylko z WYSYLANA). `h.hashe` = hashe wersji wysłanych PRZED tą próbą (jedna z nich
 * jest oryginałem przy dublu), `h.hashKsef` = hash dokumentu, którego status czytamy, `h.poOdrzuceniu` = lista hashy po
 * pewnym odrzuceniu tej wersji (bez jej hashu); brak = status wcześniejszej próby (lista bez zmian).
 */
async function rozstrzygnij(
  zapisz: Zapis,
  przejeta: WynikWysylki,
  numer: string,
  o: KsefInvoiceOutcome,
  transport: KsefTransport,
  sesjaRef: string,
  fakturaRef: string,
  now: Date,
  h: { hashe: string[]; hashKsef: string | null; poOdrzuceniu?: string[] },
): Promise<WynikWysylki> {
  if (o.state === 'pending') {
    if (!(await zapisz({ status: 'WYSLANA', wysylkaOd: null, lastError: null, probyOdczytu: 0 }))) return przejeta
    return { wynik: 'w_toku', numer, powod: 'KSeF przetwarza fakturę: numer KSeF pojawi się za chwilę.' }
  }
  if (o.state === 'rejected') {
    // nie ma jej w KSeF: ponowienie po poprawce wyśle ten sam numer od nowa. Hash tej wersji zdejmujemy (nie jest
    // w KSeF); hashe wcześniejszych prób zostają: bez pewności co do kolejności sprawdzeń KSeF (dubel czy treść) nie
    // wiemy, czy któraś z nich nie została przyjęta
    const hashe = h.poOdrzuceniu ?? h.hashe.filter((x) => x !== h.hashKsef)
    if (!(await zapisz({ status: 'ODRZUCONA', lastError: o.message.slice(0, 1000), przyczyna: 'KSEF_ODMOWA', wysylkaOd: null, sesjaRef: null, fakturaRef: null, invoiceHash: null, probyOdczytu: 0, hasheWyslane: { set: hashe } }))) return przejeta
    return { wynik: 'odrzucona', numer, powod: o.message }
  }
  const ksefNumer = o.state === 'accepted' ? o.ksefNumber : o.ksefNumber
  let upo: string | null = null
  try {
    if (o.state === 'accepted') upo = await downloadInvoiceUpo(transport, sesjaRef, fakturaRef)
    else if (o.ksefNumber && o.originalSessionReferenceNumber) upo = await downloadInvoiceUpoByKsefNumber(transport, o.originalSessionReferenceNumber, o.ksefNumber)
  } catch {
    upo = null // brakujące UPO dociąga `uzupelnijPrzyjetaKsef` w przebiegu workera; faktura jest przyjęta
  }
  // dubel: referencje wskazują sesję ORYGINAŁU (z niej UPO i, gdy KSeF nie podał numeru, numer KSeF po numerze faktury);
  // referencje próby-dubla nic już nie dają. Hash oryginału znamy tylko, gdy wcześniejsze próby wysłały jedną wersję
  const refy = o.state === 'duplicate' ? { sesjaRef: o.originalSessionReferenceNumber, fakturaRef: null } : {}
  const wczesniejsze = [...new Set(h.hashe)]
  const invoiceHash = o.state === 'accepted' ? h.hashKsef : wczesniejsze.length === 1 ? wczesniejsze[0]! : null
  const ok = await zapisz({
    status: 'PRZYJETA',
    ksefNumer,
    upo,
    przyjetaAt: now,
    wysylkaOd: null,
    invoiceHash,
    probyOdczytu: 0,
    przyczyna: null,
    ...refy,
    lastError: o.state === 'duplicate' ? `KSeF miał już tę fakturę (dubel 440): zapisano numer oryginału${ksefNumer ? '' : ', ale KSeF go nie podał (system spróbuje go odczytać z sesji oryginału)'}.` : null,
  })
  return ok ? { wynik: 'przyjeta', numer, ksefNumer } : przejeta
}

/**
 * Przyjęta faktura bez numeru KSeF albo bez UPO (dubel 440 bez numeru oryginału, nieudane pobranie UPO): dociąga
 * brakujące z KSeF. Numer KSeF z listy faktur sesji oryginału po naszym numerze i hashu,
 * UPO po referencji faktury albo po numerze KSeF. Bez referencji sesji nie ma skąd: zostaje komunikat dla człowieka.
 * Woła go przebieg workera; idempotentne (zapisuje tylko brakujące pola). `niezgodna` = w sesji jest faktura o tym
 * numerze z inną treścią: numeru nie przypisujemy, sprawdza człowiek.
 */
export async function uzupelnijPrzyjetaKsef(db: Db, draftId: string, deps: ZaleznosciWysylki): Promise<'uzupelniona' | 'bez_zmian' | 'odmowa' | 'niezgodna'> {
  const d = await db.ksefInvoiceDraft.findUnique({ where: { id: draftId } })
  if (!d || d.status !== 'PRZYJETA' || !d.sesjaRef || !d.numer || (d.ksefNumer && d.upo)) return 'bez_zmian'
  const bramka = await bramkaDla(db, d.orderId, deps.env ?? process.env)
  if (!bramka.dozwolona) return 'odmowa'
  const now = deps.now ?? new Date()
  let transport: KsefTransport
  if (deps.transport) transport = deps.transport
  else if (deps.polaczenie) transport = await deps.polaczenie.daj(bramka)
  else {
    const cfg = parseKonfiguracjaKsef((await db.organization.findFirst({ select: { settings: true } }))?.settings ?? null)
    const tok = (await resolveSecrets(db, [KSEF_TOKEN], deps.secrets))[KSEF_TOKEN]
    if (!tok || !cfg.sprzedawca) return 'odmowa'
    transport = await KsefPolaczenie.otworz(bramka, { nip: cfg.sprzedawca.nip, token: tok }, { fetch: deps.fetch, sleep: deps.sleep, now: () => now, zegar: deps.zegar, sygnal: deps.sygnal })
  }
  let ksefNumer = d.ksefNumer
  let fakturaRef = d.fakturaRef
  let invoiceHash = d.invoiceHash
  if (!ksefNumer) {
    const hashe = [...new Set([...d.hasheWyslane, ...(d.invoiceHash ? [d.invoiceHash] : [])])]
    const f = await znajdzFaktureWSesji(transport, d.sesjaRef, d.numer, { hashe, dataWystawienia: d.dataWystawienia })
    if (f.stan === 'inna_tresc') {
      await db.ksefInvoiceDraft.update({
        where: { id: draftId },
        data: { probyUzupelnienia: UZUPELNIANIE_PROB_MAX, lastError: `W sesji oryginału jest faktura o numerze ${d.numer}, ale z inną treścią niż wysłana z Kompletora: numeru KSeF nie przypisano. ${KOMUNIKAT_UZUPELNIANIA}` },
      })
      return 'niezgodna'
    }
    if (f.stan === 'znaleziona' && f.faktura.ksefNumber) {
      ksefNumer = f.faktura.ksefNumber
      fakturaRef = f.faktura.referenceNumber
      invoiceHash = f.faktura.invoiceHash || invoiceHash
      // numer KSeF zapisany od razu, przed pobraniem UPO (błąd UPO nie gubi znalezionego numeru; kolejne próby
      // dociągają już tylko UPO)
      await db.ksefInvoiceDraft.update({ where: { id: draftId }, data: { ksefNumer, fakturaRef, invoiceHash } })
    }
  }
  let upo = d.upo
  if (ksefNumer && !upo) {
    upo = fakturaRef ? await downloadInvoiceUpo(transport, d.sesjaRef, fakturaRef) : await downloadInvoiceUpoByKsefNumber(transport, d.sesjaRef, ksefNumer)
  }
  if (ksefNumer === d.ksefNumer && upo === d.upo) return 'bez_zmian'
  await db.ksefInvoiceDraft.update({ where: { id: draftId }, data: { ksefNumer, upo, fakturaRef, invoiceHash, ...(ksefNumer && upo ? { lastError: null, probyUzupelnienia: 0, nastepnaProbaOd: null } : {}) } })
  return 'uzupelniona'
}

/**
 * Korekta przy zwrocie do KSeF (przycisk „Korekta” na liście faktur i „Wyślij korektę do KSeF” na karcie zwrotu):
 * zakłada wiersz korekty (raz na zwrot) i wysyła go. Faktura korygowana musi być przyjęta w KSeF.
 */
export async function wyslijKorekteKsef(db: Db, returnId: string, deps: ZaleznosciWysylki): Promise<WynikWysylki> {
  const organizationId = organizationIdOf(db)
  const r = await db.return.findUnique({ where: { id: returnId }, select: { id: true, orderId: true, status: true, order: { select: { packageNo: true } } } })
  if (!r) return { wynik: 'odmowa', powod: 'Nie ma takiego zwrotu.' }
  if (r.status === 'ODRZUCONY' || r.status === 'ZGLOSZONY') return { wynik: 'odmowa', powod: r.status === 'ODRZUCONY' ? 'Zwrot odrzucony: korekta nie jest potrzebna.' : 'Najpierw odbierz paczkę i oznacz pozycje zwrotu.' }
  const fa = await db.ksefInvoiceDraft.findFirst({ where: { orderId: r.orderId, packageNo: r.order.packageNo, returnId: '' }, select: { id: true, status: true, ksefNumer: true, bruttoGr: true, nettoGr: true, wersjaSchemy: true } })
  if (!fa || fa.status !== 'PRZYJETA' || !fa.ksefNumer) return { wynik: 'odmowa', powod: 'Faktura tego zamówienia nie jest przyjęta w KSeF: korektę wyślesz po przyjęciu faktury.' }
  const id = idKorekty(organizationId, returnId)
  // szkic bez nabywcy do sum (ujemne kwoty) i walidacji danych; prawdziwa treść składa się przy wysyłce
  const szkic = await szkicKorektyKsef(db, returnId, { now: deps.now })
  if (!szkic.ok) return { wynik: 'odmowa', powod: [szkic.powod, ...szkic.problemy.map((p) => p.tekst)].join(' ') }
  const sumy = sumyZXml(szkic.xml)
  try {
    await db.ksefInvoiceDraft.create({ data: { id, organizationId, orderId: r.orderId, packageNo: r.order.packageNo, returnId, rodzaj: 'KOR', korygowanaId: fa.id, status: 'ODLOZONA', wersjaSchemy: fa.wersjaSchemy, bruttoGr: sumy.bruttoGr, nettoGr: sumy.nettoGr } })
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e // ponowienie: wiersz już jest
  }
  return wyslijDoKsef(db, id, deps)
}

/** Sumy korekty z XML szkicu (P_15 = brutto, suma P_13_x = netto), w groszach; korekta ma kwoty ujemne. */
function sumyZXml(xml: string): { bruttoGr: number; nettoGr: number } {
  const gr = (v: string | undefined) => (v ? Math.round(Number(v) * 100) : 0)
  const brutto = gr(/<P_15>(-?[\d.]+)<\/P_15>/.exec(xml)?.[1])
  const netto = [...xml.matchAll(/<P_13_\d+>(-?[\d.]+)<\/P_13_\d+>/g)].reduce((s, m) => s + gr(m[1]), 0)
  return { bruttoGr: brutto, nettoGr: netto }
}

/** Faktura zamówienia do KSeF z karty albo z listy: przygotowanie szkicu (gdy go nie ma albo bez numeru) i wysyłka. */
export async function wyslijFaktureKsef(db: Db, orderId: string, deps: ZaleznosciWysylki): Promise<WynikWysylki> {
  const o = await db.order.findUnique({ where: { id: orderId }, select: { id: true, packageNo: true } })
  if (!o) return { wynik: 'odmowa', powod: 'Nie ma takiego zamówienia.' }
  const b = await bramkaDla(db, orderId, deps.env ?? process.env)
  if (!b.dozwolona) return { wynik: 'odmowa', powod: b.powod }
  const d = await db.ksefInvoiceDraft.findFirst({ where: { orderId, packageNo: o.packageNo, returnId: '' }, select: { id: true, numer: true } })
  if (!d?.numer) {
    const p = await prepareKsefForOrder(db, orderId, { now: deps.now, xsdDir: deps.xsdDir })
    if (p.wynik === 'nie_dotyczy') return { wynik: 'odmowa', powod: p.powod }
  }
  const w = await db.ksefInvoiceDraft.findFirst({ where: { orderId, packageNo: o.packageNo, returnId: '' }, select: { id: true } })
  if (!w) return { wynik: 'odmowa', powod: 'Nie udało się przygotować faktury.' }
  return wyslijDoKsef(db, w.id, deps)
}

export interface StatystykiKsef {
  wyslane: number
  przyjete: number
  bledy: number
  sprawdzone: number
  porzucone: number
  /** Przyjęte, którym dociągnięto numer KSeF albo UPO. */
  uzupelnione: number
  /** automatyczne ponowienia faktur z błędem wysyłki z przyczyny „naszej”. */
  ponowione: number
  /** przyjęte, którym po limicie prób zostawiono komunikat do sprawdzenia ręcznego. */
  doRecznego: number
  /** Przebieg przerwany limitem czasu zadania albo budżetem czasu (reszta poczeka na następny). */
  przerwany: boolean
  /** logowanie wspólnego połączenia się nie udało; przebieg nie zaczął kolejnych dokumentów. */
  logowanieNieudane: boolean
}

/**
 * Przebieg workera (co kilka minut): porzucone próby → BLAD_WYSYLKI, statusy wysłanych (WYSLANA), automatyczne
 * ponowienia błędów z przyczyny „naszej”, dociąganie numeru KSeF/UPO, potem faktury zamówień, które
 * doszły do momentu wystawienia z ustawień firmy. Dokument po dokumencie: błąd jednego nie zatrzymuje reszty. Bez
 * bramki (program, wyłącznik, środowisko) przebieg nic nie robi.
 *
 * jedno połączenie z KSeF na przebieg (otwierane leniwie przy pierwszym dokumencie, który potrzebuje sieci),
 * czekanie na wynik `CZEKAJ_W_PRZEBIEGU_MS` (stan dociąga następny przebieg), a przy `koniecMs` kolejny dokument nie
 * zaczyna się, gdy do końca budżetu zostało mniej niż `zapasMs`.
 */
export async function przebiegKsef(db: Db, deps: ZaleznosciWysylki & { limit?: number; zapasMs?: number }): Promise<StatystykiKsef> {
  const now = deps.now ?? new Date()
  const zegar = deps.zegar ?? Date.now
  const s: StatystykiKsef = { wyslane: 0, przyjete: 0, bledy: 0, sprawdzone: 0, porzucone: 0, uzupelnione: 0, ponowione: 0, doRecznego: 0, przerwany: false, logowanieNieudane: false }
  const org = await db.organization.findFirst({ select: { settings: true } })
  const settings = org?.settings ?? null
  const u = parseUstawieniaDokumentow(settings)
  if (programFaktur(settings, { maWfirme: (await zrodloStanu(db)) === 'WFIRMA' }) !== 'ksef' || !u.fakturyWlaczone) return s
  const polaczenie = deps.transport || deps.polaczenie ? deps.polaczenie : wspolnePolaczenie(db, deps)
  const d: ZaleznosciWysylki = { ...deps, polaczenie, czekajNaWynikMs: deps.czekajNaWynikMs ?? CZEKAJ_W_PRZEBIEGU_MS, actorId: deps.actorId ?? 'system:worker' }
  const zapas = deps.zapasMs ?? ZAPAS_PRZEBIEGU_MS
  const koniec = () => {
    if (polaczenie?.nieudane) s.logowanieNieudane = true
    return s
  }
  const poLimicie = () => !!deps.sygnal?.aborted || (deps.koniecMs !== undefined && deps.koniecMs - zegar() < zapas)
  const przerwac = () => {
    if (poLimicie()) return (s.przerwany = true)
    if (polaczenie?.nieudane) return (s.logowanieNieudane = true)
    return false
  }
  // komunikat zależy od tego, czy automat tę fakturę jeszcze weźmie. Licznika ponowień nie zerujemy: próba, która
  // za każdym razem zatrzymuje serwer, nie może krążyć bez końca
  const porzucona = { status: 'WYSYLANA', wysylkaOd: { lt: new Date(now.getTime() - PROBA_PORZUCONA_MS) } } as const
  const porzuconeAuto = await db.ksefInvoiceDraft.updateMany({
    where: { ...porzucona, ponowieniaAuto: { lt: PONOWIENIA_AUTO_MAX } },
    data: { status: 'BLAD_WYSYLKI', przyczyna: 'PORZUCONA', nastepnaProbaOd: now, lastError: 'Próba przerwana (serwer zatrzymał się w trakcie). System ponowi ją sam z tym samym numerem; możesz też kliknąć „Ponów”.', wysylkaOd: null },
  })
  const porzuconeReczne = await db.ksefInvoiceDraft.updateMany({
    where: { ...porzucona, ponowieniaAuto: { gte: PONOWIENIA_AUTO_MAX } },
    data: { status: 'BLAD_WYSYLKI', przyczyna: 'PORZUCONA', nastepnaProbaOd: null, lastError: `Próba przerwana (serwer zatrzymał się w trakcie). System ponawiał już ${PONOWIENIA_AUTO_MAX} razy: kliknij „Ponów” (ten sam numer, bez drugiej faktury).`, wysylkaOd: null },
  })
  s.porzucone = porzuconeAuto.count + porzuconeReczne.count
  const licz = (w: WynikWysylki) => {
    if (w.wynik === 'przyjeta') s.przyjete++
    else if (w.wynik === 'blad' || w.wynik === 'odrzucona') s.bledy++
  }
  for (const x of await db.ksefInvoiceDraft.findMany({ where: { status: 'WYSLANA' }, select: { id: true }, orderBy: { updatedAt: 'asc' }, take: deps.limit ?? 20 })) {
    if (przerwac()) return koniec()
    s.sprawdzone++
    try {
      licz(await wyslijDoKsef(db, x.id, d))
    } catch {
      s.bledy++
    }
  }
  // błąd wysyłki z przyczyny „naszej” (sieć, limit czasu, 429/5xx przed przyjęciem, logowanie, porzucona próba):
  // ponowienie tym samym numerem (dubel KSeF odrzuca kodem 440 z numerem oryginału), z odstępem i limitem prób
  const doPonowienia = await db.ksefInvoiceDraft.findMany({
    where: { status: 'BLAD_WYSYLKI', przyczyna: { in: [...PRZYCZYNY_AUTO] }, ponowieniaAuto: { lt: PONOWIENIA_AUTO_MAX }, numer: { not: null }, OR: [{ nastepnaProbaOd: null }, { nastepnaProbaOd: { lte: now } }] },
    select: { id: true },
    orderBy: { updatedAt: 'asc' },
    take: deps.limit ?? 20,
  })
  for (const x of doPonowienia) {
    if (przerwac()) return koniec()
    s.ponowione++
    try {
      licz(await wyslijDoKsef(db, x.id, { ...d, ponowienieAuto: true }))
    } catch {
      s.bledy++
    }
  }
  // przyjęte bez numeru KSeF albo bez UPO (z referencją sesji, z ostatnich dni), najstarsze zmiany najpierw;
  // kolejne próby z rosnącym odstępem (`nastepnaProbaOd`, te same odstępy co ponowienia wysyłki), a po
  // `UZUPELNIANIE_PROB_MAX` nieudanych komunikat dla człowieka i koniec prób. Nieudane logowanie przebiegu nie liczy się
  // jako próba (to awaria połączenia, nie tej faktury)
  const uzupelnij = await db.ksefInvoiceDraft.findMany({
    where: {
      status: 'PRZYJETA',
      sesjaRef: { not: null },
      probyUzupelnienia: { lt: UZUPELNIANIE_PROB_MAX },
      przyjetaAt: { gte: new Date(now.getTime() - UZUPELNIANIE_DNI * 86_400_000) },
      AND: [{ OR: [{ ksefNumer: null }, { upo: null }] }, { OR: [{ nastepnaProbaOd: null }, { nastepnaProbaOd: { lte: now } }] }],
    },
    select: { id: true, probyUzupelnienia: true },
    orderBy: { updatedAt: 'asc' },
    take: Math.min(deps.limit ?? 20, 5),
  })
  const nieudane = async (x: { id: string; probyUzupelnienia: number }) => {
    if (polaczenie?.nieudane) return
    const n = x.probyUzupelnienia + 1
    const koniec = n >= UZUPELNIANIE_PROB_MAX
    if (koniec) s.doRecznego++
    await db.ksefInvoiceDraft
      .update({ where: { id: x.id }, data: { updatedAt: now, probyUzupelnienia: n, nastepnaProbaOd: koniec ? null : new Date(now.getTime() + odstepPonowienia(n - 1)), ...(koniec ? { lastError: `${KOMUNIKAT_UZUPELNIANIA} (${n} prób)` } : {}) } })
      .catch(() => {})
  }
  for (const x of uzupelnij) {
    if (przerwac()) return koniec()
    try {
      const w = await uzupelnijPrzyjetaKsef(db, x.id, d)
      if (w === 'uzupelniona') s.uzupelnione++
      else if (w === 'niezgodna') s.doRecznego++
      else if (w === 'bez_zmian') await nieudane(x)
      else await db.ksefInvoiceDraft.update({ where: { id: x.id }, data: { updatedAt: now } }) // odmowa bramki: na koniec kolejki
    } catch {
      s.bledy++
      await nieudane(x)
    }
  }
  // automat: zamówienia, które doszły do momentu wystawienia po włączeniu (zdarzenie statusu po chwili włączenia, jak
  // tor dokumentów wFirmy), bez faktury KSeF z numerem i bez szkicu, który sam nie przejdzie (poza KSeF, problemy danych)
  const od = u.fakturyWlaczoneOd ? new Date(u.fakturyWlaczoneOd) : null
  if (!od) return koniec()
  const statusy = statusyMomentu(u.wystawiajPrzy)
  const kandydaci = await db.order.findMany({
    where: { status: { in: statusy }, events: { some: { kind: { in: statusy }, createdAt: { gte: od } } }, ...(u.tylkoNaZadanie ? { wantInvoiceNip: true } : {}) },
    select: { id: true, packageNo: true },
    orderBy: { updatedAt: 'asc' },
    take: 500,
  })
  const zajete = new Set(
    (await db.ksefInvoiceDraft.findMany({ where: { orderId: { in: kandydaci.map((k) => k.id) }, returnId: '', OR: [{ numer: { not: null } }, { status: { in: ['POZA_KSEF', 'BLAD_WALIDACJI'] } }] }, select: { orderId: true, packageNo: true } })).map((x) => `${x.orderId}|${x.packageNo}`),
  )
  const doWyslania = kandydaci.filter((k) => !zajete.has(`${k.id}|${k.packageNo}`)).slice(0, deps.limit ?? 20)
  if (!doWyslania.length || przerwac()) return koniec()
  // logowanie PRZED nadaniem numeru pierwszemu nowemu dokumentowi. Przy nieudanym logowaniu nowe dokumenty nie
  // dostają numerów, o ile błąd logowania już widać na liście faktur (wiersz BLAD_WYSYLKI z LOGOWANIE/KONFIGURACJA);
  // bez takiego wiersza jeden dokument idzie jak dotąd (numer + błąd przy nim), żeby problem nie był cichy. Samo
  // logowanie nie dotyka wierszy ani serii numeracji, więc idempotencja bez zmian. Bez schematów FA(3) albo bez serii
  // dokument i tak odmówi przed siecią, więc wtedy nie logujemy się wcale
  let jedenMimoBledu = false
  const mozeWyjsc = !!parseKonfiguracjaKsef(settings).seria && !!(await wczytajSchematy(deps.xsdDir ?? katalogXsd())).schematy
  if (polaczenie && !polaczenie.nieudane && mozeWyjsc) {
    const b = await bramkaDla(db, doWyslania[0]!.id, deps.env ?? process.env)
    if (b.dozwolona) {
      try {
        await polaczenie.daj(b)
      } catch {
        s.logowanieNieudane = true
        // logowanie przerwane limitem zadania to nie błąd tokenu: żaden dokument nie startuje po limicie
        if (poLimicie()) {
          s.przerwany = true
          return koniec()
        }
        if (await db.ksefInvoiceDraft.count({ where: { status: 'BLAD_WYSYLKI', przyczyna: { in: ['LOGOWANIE', 'KONFIGURACJA'] } } })) return koniec()
        jedenMimoBledu = true
      }
    }
  }
  for (const [i, o] of doWyslania.entries()) {
    // dokument „mimo błędu logowania” omija tylko składnik `polaczenie.nieudane`, nie sygnał ani budżet czasu
    if (i === 0 && jedenMimoBledu ? poLimicie() && (s.przerwany = true) : przerwac()) return koniec()
    try {
      const w = await wyslijFaktureKsef(db, o.id, d)
      if (w.wynik !== 'odmowa') s.wyslane++
      licz(w)
    } catch {
      s.bledy++
    }
  }
  return koniec()
}

export const KOMUNIKAT_NOWEGO_TOKENU = 'Token KSeF zmieniony: system ponowi wysyłkę sam z tym samym numerem w najbliższym przebiegu (do kilku minut); możesz też kliknąć „Ponów”.'

/**
 * po zapisie nowego tokenu KSeF (Ustawienia → Dokumenty sprzedaży) faktury, które nie wyszły przez nieudane
 * logowanie (`LOGOWANIE`, także z wyczerpanymi ponowieniami) albo brak tokenu (`KONFIGURACJA`), wracają do automatu
 * z pełną pulą ponowień, bez klikania „Ponów” przy każdej. Przyczyna przechodzi na `LOGOWANIE` (logowanie nowym
 * tokenem jeszcze nie sprawdzone; przy złym tokenie znów wstrzyma nowe numery). Tylko wiersze `BLAD_WYSYLKI`
 * z numerem: żywej próby ani przyjętej faktury nie rusza. To samo, co „Ponów” człowieka (ten sam numer, dubel = 440),
 * więc idempotentne. Klient bazy firmy (RLS). Zwraca liczbę wierszy.
 */
export async function poZapisieTokenuKsef(db: Db, now: Date = new Date()): Promise<number> {
  const r = await db.ksefInvoiceDraft.updateMany({
    where: { status: 'BLAD_WYSYLKI', przyczyna: { in: ['LOGOWANIE', 'KONFIGURACJA'] }, numer: { not: null } },
    data: { przyczyna: 'LOGOWANIE', ponowieniaAuto: 0, nastepnaProbaOd: now, lastError: KOMUNIKAT_NOWEGO_TOKENU },
  })
  return r.count
}

/** limit próby ręcznej z panelu („Ponów”, korekta); krótszy niż `PROBA_PORZUCONA_MS` (sprzątacz jej nie trafi). */
export const PROBA_RECZNA_LIMIT_MS = 2 * 60_000
export const KOMUNIKAT_PROBY_RECZNEJ = 'Wysyłka trwa dłużej niż zwykle: system dokończy ją sam z tym samym numerem. Sprawdź listę faktur za kilka minut.'

/**
 * próba ręczna z panelu z limitem czasu jak w workerze. Po `limitMs` sygnał przerywa żądania KSeF (przed 202 =
 * `PRZERWANA`, automat dokończy tym samym numerem; po 202 = stan do sprawdzenia), a gdyby coś mimo to wisiało, ekran po
 * limicie + 15 s dostaje komunikat „w toku” (próba kończy się w tle, jej zapisy chroni znacznik próby).
 */
export async function zLimitemProbyRecznej(deps: ZaleznosciWysylki, f: (d: ZaleznosciWysylki) => Promise<WynikWysylki>, limitMs = PROBA_RECZNA_LIMIT_MS): Promise<WynikWysylki> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), limitMs)
  let awaryjny: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      f({ ...deps, sygnal: ctrl.signal, czekajNaWynikMs: deps.czekajNaWynikMs ?? Math.min(60_000, Math.floor(limitMs / 2)) }),
      new Promise<WynikWysylki>((r) => {
        awaryjny = setTimeout(() => r({ wynik: 'w_toku', numer: null, powod: KOMUNIKAT_PROBY_RECZNEJ }), limitMs + 15_000)
      }),
    ])
  } finally {
    clearTimeout(t)
    clearTimeout(awaryjny)
  }
}

/** Twardy limit jednego zadania `ksef-wysylka` (krótszy niż `PROBA_PORZUCONA_MS`, żeby sprzątacz nie trafił w żywą próbę). */
export const KSEF_WYSYLKA_LIMIT_MS = 4 * 60_000

/**
 * Przebieg workera z twardym limitem czasu: po `limitMs` sygnał przerywa żądania i czekania KSeF
 * (próba w toku kończy się jak przy braku odpowiedzi: ten sam numer przy ponowieniu, referencje zostają), a gdyby coś
 * mimo to wisiało, zadanie i tak kończy się błędem po limicie + 15 s. Tylko dla tego rodzaju zadania. Budżet
 * czasu dla przebiegu (kolejny dokument nie zaczyna się, gdy zostało mniej niż `ZAPAS_PRZEBIEGU_MS`, przy krótkich
 * limitach testowych proporcjonalnie mniej).
 */
export async function przebiegKsefZLimitem(db: Db, deps: ZaleznosciWysylki & { limit?: number }, limitMs = KSEF_WYSYLKA_LIMIT_MS): Promise<StatystykiKsef> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), limitMs)
  let awaryjny: ReturnType<typeof setTimeout> | undefined
  const zegar = deps.zegar ?? Date.now
  try {
    return await Promise.race([
      przebiegKsef(db, { ...deps, sygnal: ctrl.signal, koniecMs: zegar() + limitMs, zapasMs: Math.min(ZAPAS_PRZEBIEGU_MS, Math.floor(limitMs * 0.375)) }),
      new Promise<never>((_, reject) => {
        awaryjny = setTimeout(() => reject(new Error(`ksef-wysylka: przekroczony limit czasu zadania (${Math.round(limitMs / 1000)} s)`)), limitMs + 15_000)
      }),
    ])
  } finally {
    clearTimeout(t)
    clearTimeout(awaryjny)
  }
}
