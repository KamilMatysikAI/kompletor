// Faktura robocza VAT w wFirmie (`normal_draft`) dla wskazanego zamówienia: próba przed przełączeniem z BaseLinkera.
// Treść składa ta sama funkcja co prawdziwa faktura (`zlozFaktureZamowienia`, lib/wfirma/adapter-zapis.ts); różnią się
// tylko dwa pola: `type` = `normal_draft` i `id_external` = `pr/<orderId>` (28 znaków; wFirma obcina `id_external`
// do 32, dłuższy = odmowa przed wysłaniem). Inny format niż faktura paczki (`<orderId>/<paczka>/<próba>`), więc
// `findByPrefix` rdzenia nigdy nie uzna roboczej za wystawioną fakturę paczki. wFirma nadaje roboczej numer we własnej
// numeracji roboczych („WRF n”), poza serią faktur: taki numer nie jest alarmem, każdy inny jest.
//
// Bez `InvoiceAttempt`, bez zmiany zamówienia, rezerwacji, stanów i WZ. Nabywca idzie prawdziwą drogą danych klienta
// (`odbiorcaDoCelu`): zostawia ślad odczytu danych klienta, a gdy zamówienie nie ma rekordu klienta i zapis instancji
// jest włączony, czyta kanał i zapisuje zaszyfrowany rekord klienta, pod tą samą bramką co automat po przyjęciu
// zamówienia. Odmowa tej bramki (np. konto w „Tylko podgląd” bez rekordu i bez „zapisu w cieniu”) = ODMOWA bez żądań
// do wFirmy. Nie zależy od przełącznika „Wystawiaj faktury z Kompletora”.
//
// Bezpieczniki:
//  - zapis tylko dla nabywcy bez identyfikatora podatkowego (`tax_id_type` none, bez NIP-u); inny nabywca wyłącznie
//    z jawnym `takzeZNip`;
//  - przed zapisem `invoices/find` po `id_external` roboczej: znaleziona = bez drugiego zapisu (ponowne wywołanie
//    nie tworzy drugiej roboczej), błąd odczytu = bez zapisu; po zapisie to samo wyszukiwanie: gdy nie widzi nowego
//    dokumentu, wynik ostrzega, że ponowne wywołanie wystawi drugą roboczą;
//  - zaraz po zapisie odczyt `invoices/get/<id>`: numer spoza numeracji roboczych, typ inny niż roboczy albo brak
//    potwierdzenia = ALARM z identyfikatorem dokumentu do ręcznej kontroli, bez prób naprawy;
//  - usuwanie tylko przez `WfirmaZapis.usunFaktureRobocza` (świeży odczyt, typ roboczy, numer pusty albo „WRF n”,
//    prefiks próby); robocza z pierwszej próby (`proba-robocza/…` obcięte przez wFirmę) tylko, gdy reszta wskazuje
//    dokładnie jedno zamówienie tej firmy;
//  - złożenie odmawia tak samo jak prawdziwa droga (nieznana płatność, brak kodu VAT, brak nabywcy…).
import type { PrismaClient } from '@prisma/client'
import { OdmowaOdczytuOdbiorcy } from '../odbiorca/pobierz'
import { zrodloStanu } from '../rdzen/zrodlo-stanu'
import { wfirmaItems } from '../zrodla/wfirma'
import { dokumentKontrolny, type DokumentKontrolny, jestRobocza, jestRoboczaProby, MAX_ID_EXTERNAL, numerRoboczej, PREFIKS_ROBOCZEJ, PREFIKS_ROBOCZEJ_STARY, type StaraRoboczaProby, TYP_ROBOCZEJ, type WfirmaZapis, type WynikUsuniecia } from '../zrodla/wfirma-zapis'
import { type ZaleznosciZapisu, zlozFaktureZamowienia } from './adapter-zapis'

type Tresc = { invoices: { invoice: Record<string, unknown> } }

export interface OdczytWfirmy {
  call<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T>
}

export interface ZaleznosciRoboczej {
  /** Klient odczytu (`WfirmaReadOnly`): `invoices/find`, `invoices/get/<id>`. */
  odczyt: OdczytWfirmy
  /** Klient zapisu: wystawienie faktury i strzeżone usunięcie roboczej (lib/zrodla/wfirma-zapis.ts). */
  zapis: Pick<WfirmaZapis, 'wystawFakture' | 'usunFaktureRobocza'>
  /** Nabywca jak przy prawdziwej fakturze (`odbiorcaDoCelu`, cel FAKTURA). */
  odbiorca: ZaleznosciZapisu['odbiorca']
}

export const idExternalRoboczej = (orderId: string) => `${PREFIKS_ROBOCZEJ}${orderId}`

/** Odmowa, gdy `id_external` roboczej nie zmieści się w limicie wFirmy (obcięty nie dałby się odszukać). */
export function odmowaDlugosci(orderId: string): string | null {
  const id = idExternalRoboczej(orderId)
  return id.length > MAX_ID_EXTERNAL ? `id_external roboczej ma ${id.length} znaków, wFirma zapisuje najwyżej ${MAX_ID_EXTERNAL}: nic nie wysłano` : null
}

/** `id_external` roboczej z pierwszej próby w postaci zapisanej przez wFirmę (obcięty do limitu). */
export const idExternalStarejRoboczej = (orderId: string) => `${PREFIKS_ROBOCZEJ_STARY}${orderId}`.slice(0, MAX_ID_EXTERNAL)

/**
 * Robocza z pierwszej próby (`proba-robocza/<orderId>`): wFirma zapisała ją obciętą do 32 znaków. Uznana tylko, gdy
 * reszta po prefiksie to znaki identyfikatora i wskazuje dokładnie jedno zamówienie tej firmy (klient bazy z RLS
 * firmy): przy wartości obciętej do limitu po początku identyfikatora, przy innej długości po całym.
 */
export function staraRoboczaZamowienia(db: PrismaClient): StaraRoboczaProby {
  return async (idExternal) => {
    if (!idExternal.startsWith(PREFIKS_ROBOCZEJ_STARY)) return false
    const reszta = idExternal.slice(PREFIKS_ROBOCZEJ_STARY.length)
    if (!/^[a-z0-9]{8,}$/.test(reszta)) return false
    const obciety = idExternal.length === MAX_ID_EXTERNAL
    const z = await db.order.findMany({ where: obciety ? { id: { startsWith: reszta } } : { id: reszta }, select: { id: true }, take: 2 })
    return z.length === 1
  }
}

/** Treść roboczej z treści prawdziwej faktury: kopia z podmienionym `type` i `id_external`, reszta bez zmian. */
export function trescRobocza(tresc: Tresc, orderId: string): Tresc {
  return { invoices: { invoice: { ...tresc.invoices.invoice, type: TYP_ROBOCZEJ, id_external: idExternalRoboczej(orderId) } } }
}

/** Pola kontrolne treści do wypisania: bez nazwy, adresu i NIP-u nabywcy. */
export interface PodsumowanieRoboczej {
  typ: string
  idExternal: string
  seria: string | null
  formaPlatnosci: string
  rodzajCeny: string
  nabywca: { rodzajIdentyfikatora: string; zNip: boolean }
  pozycje: { nazwa: string; ilosc: string; jednostka: string; cena: string; kodVat: string; towarWfirmy: string }[]
  bruttoGr: number
  nettoGr: number
  bezPowiazaniaZMagazynem: boolean
}

const str = (v: unknown) => (v === undefined || v === null ? '' : String(v))
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

export function podsumujRobocza(tresc: Tresc, sumy: { bruttoGr: number; nettoGr: number }, bezPowiazania: boolean): PodsumowanieRoboczej {
  const inv = tresc.invoices.invoice
  const k = rec(inv['contractor'])
  return {
    typ: str(inv['type']),
    idExternal: str(inv['id_external']),
    seria: inv['series'] ? str(rec(inv['series'])['id']) || null : null,
    formaPlatnosci: str(inv['paymentmethod']),
    rodzajCeny: str(inv['price_type']),
    nabywca: { rodzajIdentyfikatora: str(k['tax_id_type']) || 'brak', zNip: !!str(k['nip']).trim() },
    pozycje: Object.values(rec(inv['invoicecontents'])).map((x) => {
      const c = rec(rec(x)['invoicecontent'])
      return { nazwa: str(c['name']), ilosc: str(c['count']), jednostka: str(c['unit']), cena: str(c['price']), kodVat: str(rec(c['vat_code'])['id']), towarWfirmy: str(rec(c['good'])['id']) }
    }),
    bruttoGr: sumy.bruttoGr,
    nettoGr: sumy.nettoGr,
    bezPowiazaniaZMagazynem: bezPowiazania,
  }
}

export type WynikZlozeniaRoboczej = { kind: 'OK'; tresc: Tresc; podsumowanie: PodsumowanieRoboczej } | { kind: 'ODMOWA'; message: string }

/**
 * Treść roboczej dla zamówienia, bez żadnego żądania do wFirmy. Dokument bez rozchodu (magazyn prowadzi Kompletor)
 * tak jak w prawdziwej drodze: towar bez powiązania z kartoteką wFirmy idzie pozycją z nazwy.
 */
export async function zlozRobocza(db: PrismaClient, orderId: string, odbiorca: ZaleznosciZapisu['odbiorca']): Promise<WynikZlozeniaRoboczej> {
  const dlugosc = odmowaDlugosci(orderId)
  if (dlugosc) return { kind: 'ODMOWA', message: dlugosc }
  const bezPowiazania = (await zrodloStanu(db)) === 'KOMPLETOR'
  let z: Awaited<ReturnType<typeof zlozFaktureZamowienia>>
  try {
    z = await zlozFaktureZamowienia(db, orderId, { idExternal: idExternalRoboczej(orderId), odbiorca, ...(bezPowiazania ? { towarBezPowiazania: true } : {}) })
  } catch (e) {
    // bramka danych klienta (wyłącznik instancji, konto w „Tylko podgląd”, konto nieaktywne): komunikat bez danych
    if (e instanceof OdmowaOdczytuOdbiorcy) return { kind: 'ODMOWA', message: `dane nabywcy niedostępne: ${e.message}` }
    throw e
  }
  if (z.kind === 'ERROR') return { kind: 'ODMOWA', message: z.message }
  const tresc = trescRobocza(z.z.tresc, orderId)
  return { kind: 'OK', tresc, podsumowanie: podsumujRobocza(tresc, z.z, bezPowiazania) }
}

export type WynikRoboczej =
  /** Złożenie odmówiło (jak prawdziwa faktura): nic nie wysłano. */
  | { kind: 'ODMOWA'; message: string }
  /** Robocza tego zamówienia już jest w wFirmie i po odczycie jest roboczą: drugiej nie wystawiono. */
  | { kind: 'JUZ_JEST'; dokument: DokumentKontrolny; podsumowanie: PodsumowanieRoboczej }
  /** `ostrzezenie`: wyszukiwanie po `id_external` nie widzi nowej roboczej, więc ponowne wywołanie wystawiłoby drugą. */
  | { kind: 'WYSTAWIONA'; dokument: DokumentKontrolny; podsumowanie: PodsumowanieRoboczej; ostrzezenie?: string }
  /** Dokument w wFirmie nie jest (albo nie dało się potwierdzić, że jest) roboczą: ręczna kontrola, bez naprawy. */
  | { kind: 'ALARM'; docIds: string[]; message: string }
  /** Odrzucenie albo błąd przed zapisem: dokument nie powstał. */
  | { kind: 'BLAD'; message: string }
  /** Timeout zapisu: nie wiadomo, czy powstał; ponowne wywołanie najpierw go szuka. */
  | { kind: 'NIEWIADOMA'; message: string }

async function potwierdz(odczyt: OdczytWfirmy, docId: string, idExternal: string): Promise<{ ok: true; dokument: DokumentKontrolny } | { ok: false; message: string }> {
  let d: DokumentKontrolny | null
  try {
    d = dokumentKontrolny(await odczyt.call(`invoices/get/${docId}`, {}))
  } catch (e) {
    return { ok: false, message: `nie udało się odczytać dokumentu po zapisie (${e instanceof Error ? e.message.slice(0, 200) : 'błąd'})` }
  }
  if (!d || d.id !== docId) return { ok: false, message: 'wFirma nie oddała dokumentu po zapisie' }
  if (!jestRobocza(d)) return { ok: false, message: `dokument nie jest fakturą roboczą: typ ${d.typ || 'brak'}, numer ${d.numer ?? 'brak'}` }
  // odczyt bez `id_external` nie jest alarmem (typ i numer rozstrzygają); inny `id_external` jest
  if (d.idExternal && d.idExternal !== idExternal) return { ok: false, message: 'dokument ma inny id_external niż robocza tego zamówienia' }
  return { ok: true, dokument: d }
}

/** Identyfikatory dokumentów z dokładnie tym `id_external` (`invoices/find`). Błąd odczytu = wyjątek. */
async function szukajPoIdExternal(odczyt: OdczytWfirmy, idExternal: string): Promise<string[]> {
  const r = await odczyt.call<Record<string, unknown>>('invoices/find', { invoices: { parameters: { conditions: { condition: { field: 'id_external', operator: 'like', value: `${idExternal}%` } }, limit: 25 } } })
  return wfirmaItems<{ id?: unknown; id_external?: unknown }>(r['invoices'], 'invoice')
    .filter((i) => str(i.id_external) === idExternal)
    .map((i) => str(i.id))
    .filter((id) => /^\d+$/.test(id))
}

/** Nabywca z identyfikatorem podatkowym (NIP albo rodzaj identyfikatora inny niż `none`). */
export const nabywcaZIdentyfikatorem = (p: PodsumowanieRoboczej) => p.nabywca.zNip || p.nabywca.rodzajIdentyfikatora !== 'none'

/** Faktura robocza w wFirmie dla zamówienia (`--wykonaj`). `takzeZNip`: zgoda na nabywcę z identyfikatorem podatkowym. */
export async function wystawRobocza(db: PrismaClient, orderId: string, deps: ZaleznosciRoboczej, opcje: { takzeZNip?: boolean } = {}): Promise<WynikRoboczej> {
  const z = await zlozRobocza(db, orderId, deps.odbiorca)
  if (z.kind === 'ODMOWA') return z
  if (nabywcaZIdentyfikatorem(z.podsumowanie) && !opcje.takzeZNip)
    return { kind: 'ODMOWA', message: `nabywca z identyfikatorem podatkowym (rodzaj ${z.podsumowanie.nabywca.rodzajIdentyfikatora}, NIP ${z.podsumowanie.nabywca.zNip ? 'tak' : 'nie'}): robocza tylko dla nabywcy bez NIP-u; świadomie: --takze-z-nip` }
  const idExternal = idExternalRoboczej(orderId)

  // robocza tego zamówienia z pierwszej próby (stary format, obcięty przez wFirmę) też blokuje drugą
  const idStary = idExternalStarejRoboczej(orderId)
  let znalezione: { id: string; idExternal: string }[]
  try {
    znalezione = [
      ...(await szukajPoIdExternal(deps.odczyt, idExternal)).map((id) => ({ id, idExternal })),
      ...(await szukajPoIdExternal(deps.odczyt, idStary)).map((id) => ({ id, idExternal: idStary })),
    ]
  } catch (e) {
    return { kind: 'BLAD', message: `nie udało się sprawdzić, czy robocza już jest (${e instanceof Error ? e.message.slice(0, 200) : 'błąd'}); nic nie zapisano` }
  }
  if (znalezione.length > 1) return { kind: 'ALARM', docIds: znalezione.map((x) => x.id), message: `więcej niż jeden dokument z id_external próby tego zamówienia` }
  if (znalezione.length === 1) {
    const p = await potwierdz(deps.odczyt, znalezione[0]!.id, znalezione[0]!.idExternal)
    return p.ok ? { kind: 'JUZ_JEST', dokument: p.dokument, podsumowanie: z.podsumowanie } : { kind: 'ALARM', docIds: [znalezione[0]!.id], message: `istniejący dokument z id_external próby: ${p.message}` }
  }

  const w = await deps.zapis.wystawFakture(z.tresc)
  if (w.kind === 'ERROR') return { kind: 'BLAD', message: w.message }
  if (w.kind === 'LIMIT') return { kind: 'BLAD', message: `limit wFirmy: ${w.message}; nic nie zapisano, ponów później` }
  if (w.kind === 'TIMEOUT') return { kind: 'NIEWIADOMA', message: `${w.message}; nie wiadomo, czy robocza powstała: nie ponawiaj od razu, odczekaj 5 minut, sprawdź w wFirmie listę roboczych i sprzedaży, dopiero potem ponów --wykonaj` }
  if (!numerRoboczej(w.numer)) return { kind: 'ALARM', docIds: [w.id], message: `wFirma nadała numer ${w.numer} spoza numeracji roboczych: to nie jest faktura robocza` }
  const p = await potwierdz(deps.odczyt, w.id, idExternal)
  if (!p.ok) return { kind: 'ALARM', docIds: [w.id], message: p.message }
  // ochrona przed drugą roboczą stoi na tym wyszukiwaniu: sprawdzamy, czy widzi dokument, który właśnie powstał
  let widzi = false
  try {
    widzi = (await szukajPoIdExternal(deps.odczyt, idExternal)).includes(w.id)
  } catch {
    widzi = false
  }
  if (!widzi)
    return { kind: 'WYSTAWIONA', dokument: p.dokument, podsumowanie: z.podsumowanie, ostrzezenie: `wyszukiwanie po id_external nie widzi tej roboczej: ponowne --wykonaj wystawi drugą. Nie ponawiaj --wykonaj; po kontroli usuń dokument ${w.id} (--usun ${w.id})` }
  return { kind: 'WYSTAWIONA', dokument: p.dokument, podsumowanie: z.podsumowanie }
}

export type WynikSprawdzenia = { kind: 'OK'; dokument: DokumentKontrolny; roboczaProby: boolean } | { kind: 'BRAK' } | { kind: 'BLAD'; message: string }

/** Sam odczyt dokumentu (`--sprawdz <docId>`): typ, numer, `id_external`; bez danych nabywcy i bez żadnego zapisu. */
export async function sprawdzRobocza(docId: string, odczyt: OdczytWfirmy, staraProba?: StaraRoboczaProby): Promise<WynikSprawdzenia> {
  if (!/^\d+$/.test(docId) || docId === '0') return { kind: 'BLAD', message: 'niepoprawny identyfikator dokumentu' }
  let d: DokumentKontrolny | null
  try {
    d = dokumentKontrolny(await odczyt.call(`invoices/get/${docId}`, {}))
  } catch (e) {
    return { kind: 'BLAD', message: `nie udało się odczytać dokumentu (${e instanceof Error ? e.message.slice(0, 200) : 'błąd'})` }
  }
  if (!d || d.id !== docId) return { kind: 'BRAK' }
  let proby = jestRoboczaProby(d)
  if (!proby && staraProba && jestRobocza(d) && d.idExternal.startsWith(PREFIKS_ROBOCZEJ_STARY)) proby = await staraProba(d.idExternal).catch(() => false)
  return { kind: 'OK', dokument: d, roboczaProby: proby }
}

/** Usunięcie roboczej (`--usun <docId>`): tylko robocza próby po świeżym odczycie; `staraProba` dla roboczej z pierwszej próby. */
export async function usunRobocza(docId: string, deps: Pick<ZaleznosciRoboczej, 'odczyt' | 'zapis'>, staraProba?: StaraRoboczaProby): Promise<WynikUsuniecia> {
  return deps.zapis.usunFaktureRobocza(docId, deps.odczyt, staraProba)
}
