// Dostawca dokumentów sprzedaży: jeden interfejs dla programu do faktur
// firmy — `brak`, `wfirma`, `ksef` albo adapter rejestru rodzaju `invoicing` (Fakturownia, inFakt, iFirma…).
// Mały port + opcjonalne zdolności (jak kontrakt kanałów, lib/adaptery/kontrakt.ts): host pyta, co program umie
// (`zdolnosci`, strażniki typu niżej), zamiast łapać „nieobsługiwane”. Wynik wystawienia ma ten sam kontrakt co kolejka
// wFirmy: OK | ERROR | TIMEOUT | LIMIT, a przy TIMEOUT host odszukuje dokument po referencji (`odszukaj`) zamiast
// wystawiać drugi raz. Referencja to klucz idempotencji hosta (dla wFirmy `id_external` = `<orderId>/<paczka>/<próba>`).
// Moduł bez importu z lib/wfirma i bez bazy: rdzeń i ekrany używają tylko tych typów.
import type { InvoiceLine } from '../rdzen/rozchod'
import type { PreparedInvoice } from '../adaptery/kontrakt'
import type { ProgramDokumentow } from './ustawienia'

/**
 * Co program umie. `stan.magazynu` = wystawienie zdejmuje stan w programie (WZ wFirmy) — rdzeń czeka wtedy na dokument.
 * `wz` = sam dokument wydania magazynowego bez faktury (zamówienie wysłane bez faktury przy stanie
 * prowadzonym w programie): zamiast ruchu „wydane bez dokumentu” do ręcznego zamknięcia program dostaje WZ.
 */
/** `koryguj` = wystawienie korekty w programie (wFirma, kolejka); `przygotuj.korekte` = sam szkic korekty bez
 * wysyłki (KSeF bezpośrednio). Dostawca bez żadnej z nich („brak programu”) = korekta nie jest potrzebna. */
export const ZDOLNOSCI_DOKUMENTOW = ['przygotuj', 'wystaw', 'odszukaj', 'pdf', 'koryguj', 'przygotuj.korekte', 'paragon', 'stan.magazynu', 'wz'] as const
export type ZdolnoscDokumentow = (typeof ZDOLNOSCI_DOKUMENTOW)[number]

/** Pozycja dokumentu: jak pozycja faktury rdzenia (jednostka bazowa, cena brutto w groszach, stawka VAT). */
export type PozycjaDokumentu = InvoiceLine

export interface ZlecenieDokumentu {
  /** Klucz idempotencji hosta; ten sam przy ponowieniu po niejasnym wyniku. */
  referencja: string
  pozycje: PozycjaDokumentu[]
  /** Forma płatności w słowniku programu albo `transfer` / `cod`. */
  platnosc: string
  rodzaj?: 'faktura' | 'paragon'
}

export type WynikDokumentu =
  | { kind: 'OK'; docId: string; numer?: string | null }
  | { kind: 'ERROR'; message: string } // jednoznaczny błąd: dokument nie powstał
  | { kind: 'TIMEOUT' } // nie wiadomo, czy powstał: odszukaj po referencji
  | { kind: 'LIMIT'; message: string; retryAfterMs?: number } // limit programu: odrzucone przed przetworzeniem

export interface ZnalezionyDokument {
  docId: string
  referencja: string
  numer?: string | null
}

export interface ZlecenieKorekty {
  referencja: string
  /** Dokument korygowany (`docId` z wyniku wystawienia). */
  docId: string
  pozycje: { productId: string; qty: number }[]
}

/** wydanie magazynowe (WZ) bez faktury. Pozycje w jednostce programu (szt. albo kg), towar programu po id. */
export interface ZlecenieWz {
  /** Klucz idempotencji hosta (`wz/<orderId>/<paczka>`); ten sam przy ponowieniu po niejasnym wyniku. */
  referencja: string
  pozycje: { towarId: string; ilosc: number }[]
  /** Magazyn w programie (np. id magazynu wFirmy). */
  magazyn: string
}

export interface DostawcaDokumentow {
  readonly program: ProgramDokumentow
  /** Nazwa dla ekranów, np. „wFirma”, „Bez programu do faktur”. */
  readonly nazwa: string
  readonly zdolnosci: readonly ZdolnoscDokumentow[]
  /** Treść dokumentu bez wystawiania, sieci i numeru z serii (podgląd, szkic). Wejście zależy od programu. */
  przygotuj?(wejscie: unknown): PreparedInvoice
  /** Wystawienie. Wyjątek host traktuje jak TIMEOUT (błąd transportu: nie wiadomo, czy dokument powstał). */
  wystaw?(z: ZlecenieDokumentu): Promise<WynikDokumentu>
  /** Dokumenty po prefiksie referencji (np. `<orderId>/<paczka>/`). */
  odszukaj?(prefiksReferencji: string): Promise<ZnalezionyDokument[]>
  pdf?(docId: string): Promise<{ contentType: string; base64: string }>
  koryguj?(z: ZlecenieKorekty): Promise<WynikDokumentu>
  /** treść korekty bez wystawiania (szkic). Wejście zależy od programu (KSeF: `WejscieFa3` z `rodzaj: KOR`). */
  przygotujKorekte?(wejscie: unknown): PreparedInvoice
  /** WZ bez faktury. Wyjątek = TIMEOUT (host odszukuje po referencji, `odszukajWz`). */
  wydajWz?(z: ZlecenieWz): Promise<WynikDokumentu>
  odszukajWz?(referencja: string): Promise<ZnalezionyDokument[]>
}

const umie = (d: DostawcaDokumentow, z: ZdolnoscDokumentow) => d.zdolnosci.includes(z)

export function umiePrzygotowac(d: DostawcaDokumentow): d is DostawcaDokumentow & Required<Pick<DostawcaDokumentow, 'przygotuj'>> {
  return umie(d, 'przygotuj') && typeof d.przygotuj === 'function'
}
export function umieWystawic(d: DostawcaDokumentow): d is DostawcaDokumentow & Required<Pick<DostawcaDokumentow, 'wystaw'>> {
  return umie(d, 'wystaw') && typeof d.wystaw === 'function'
}
export function umieOdszukac(d: DostawcaDokumentow): d is DostawcaDokumentow & Required<Pick<DostawcaDokumentow, 'odszukaj'>> {
  return umie(d, 'odszukaj') && typeof d.odszukaj === 'function'
}
export function umiePdf(d: DostawcaDokumentow): d is DostawcaDokumentow & Required<Pick<DostawcaDokumentow, 'pdf'>> {
  return umie(d, 'pdf') && typeof d.pdf === 'function'
}
export function umieKorygowac(d: DostawcaDokumentow): d is DostawcaDokumentow & Required<Pick<DostawcaDokumentow, 'koryguj'>> {
  return umie(d, 'koryguj') && typeof d.koryguj === 'function'
}

export function umiePrzygotowacKorekte(d: DostawcaDokumentow): d is DostawcaDokumentow & Required<Pick<DostawcaDokumentow, 'przygotujKorekte'>> {
  return umie(d, 'przygotuj.korekte') && typeof d.przygotujKorekte === 'function'
}

/** czy program w ogóle zajmuje się korektą (wystawia albo składa szkic); `false` = korekta nie jest potrzebna. */
export function korektaWProgramie(d: DostawcaDokumentow): boolean {
  return umieKorygowac(d) || umiePrzygotowacKorekte(d)
}

export function umieWydacWz(d: DostawcaDokumentow): d is DostawcaDokumentow & Required<Pick<DostawcaDokumentow, 'wydajWz' | 'odszukajWz'>> {
  return umie(d, 'wz') && typeof d.wydajWz === 'function' && typeof d.odszukajWz === 'function'
}

/** Błędy deklaracji dostawcy (puste = poprawny): zdolność bez metody albo nieznana zdolność. Sprawdza suita kontraktowa. */
export function problemyDostawcy(d: DostawcaDokumentow): string[] {
  const p: string[] = []
  for (const z of d.zdolnosci) if (!(ZDOLNOSCI_DOKUMENTOW as readonly string[]).includes(z)) p.push(`nieznana zdolność ${z}`)
  const metoda: Partial<Record<ZdolnoscDokumentow, keyof DostawcaDokumentow>> = { przygotuj: 'przygotuj', wystaw: 'wystaw', odszukaj: 'odszukaj', pdf: 'pdf', koryguj: 'koryguj', 'przygotuj.korekte': 'przygotujKorekte' }
  for (const [z, m] of Object.entries(metoda)) if (umie(d, z as ZdolnoscDokumentow) && typeof d[m] !== 'function') p.push(`zdolność ${z} bez metody ${m}`)
  if (umie(d, 'wz') && (typeof d.wydajWz !== 'function' || typeof d.odszukajWz !== 'function')) p.push('zdolność wz bez metod wydajWz i odszukajWz')
  if (umie(d, 'wystaw') && !umie(d, 'odszukaj')) p.push('wystawianie bez odszukania po referencji: po timeoucie host nie rozstrzygnie, czy dokument powstał')
  if (!d.nazwa.trim()) p.push('brak nazwy')
  return p
}
