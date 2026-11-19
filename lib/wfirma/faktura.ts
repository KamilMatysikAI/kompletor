// Składanie faktury „przygotuj, nie wystawiaj” (spec 3.4, 15.1). Czysta funkcja: zamówienie + pozycje +
// konfiguracja firmy → treść żądania wystawienia faktury w wFirmie, BEZ wysyłania. Nikt jej tu nie wysyła: odczyty idą
// przez `WfirmaReadOnly` ze strażnikiem `assertWfirmaReadOnly`, zapisu w tym module nie ma.
//
// Kształt treści z kolekcji Postman wFirmy: `invoices.invoice` z `invoicecontents`; `good.id=0`
// to pozycja bez towaru (wysyłka, usługa bez usługi w wFirmie), taka pozycja nie ma WZ. Odpowiedzi na zapis nie
// widzieliśmy, pierwszą fakturę sprawdza 9.3 specu po osobnym GO.
//
// linie (zestawy, wysyłka, DIGITAL, zaokrąglenia, bezpiecznik sumy) liczy wspólny moduł
// `lib/dokumenty/pozycje.ts`, ten sam dla każdego programu do faktur. Tu zostaje tylko część wFirmy: kody VAT konta,
// forma płatności w słowniku wFirmy i treść żądania wystawienia faktury. Typy i funkcje pozycji są reeksportowane, więc
// dawne importy z tego pliku działają bez zmian. Wynik 1:1 (podgląd faktur i `InvoiceDryRun.diffs`).
import type { PaymentState } from '@prisma/client'
import { type LiniaDokumentu, type PozycjaZamowienia, type Problem as ProblemPozycji, zlozPozycjeDokumentu } from '../dokumenty/pozycje'
import type { KonfiguracjaFaktur } from './konfiguracja'
import { formaPlatnosci, type FormaPlatnosci } from './platnosci'

export { nettoGr, stawka, zlozPozycjeDokumentu } from '../dokumenty/pozycje'
export type { KategoriaRoznicy, PozycjaZamowienia, SkladnikZestawu } from '../dokumenty/pozycje'
/** Problem faktury wFirmy: jak problem pozycji, bez pola `dotyczyProgramu` (każdy problem tutaj dotyczy wFirmy). */
export type Problem = Omit<ProblemPozycji, 'dotyczyProgramu'>
/** Linia faktury wFirmy = wspólna linia dokumentu. */
export type LiniaFaktury = LiniaDokumentu

export interface WejscieFaktury {
  idExternal: string
  totalGross: number // zł, `Order.totalGross`
  paymentMethod: string
  paymentState: PaymentState
  pozycje: PozycjaZamowienia[]
  konfiguracja: KonfiguracjaFaktur
  /** Dane kontrahenta tylko jako argument; podgląd ich nie podaje i nigdzie nie zapisuje. */
  kontrahent?: Record<string, unknown>
  /**
   * dokument bez rozchodu (stan prowadzi Kompletor). Towar bez powiązania z kartoteką wFirmy idzie pozycją
   * z nazwy (`good.id = 0`, bez WZ) zamiast błędu — wFirma służy wtedy tylko do dokumentów.
   */
  towarBezPowiazania?: boolean
  /** koszt wysyłki z kanału (zł), `WejsciePozycji.kosztWysylki`; brak = nieznany. */
  kosztWysylki?: number | null
  /** `WejsciePozycji.paczkiDodatkowe` (zamówienie główne ma paczki dodatkowe). */
  paczkiDodatkowe?: boolean
  /** `WejsciePozycji.rabatMatkiNaDokumencie` (paczka dodatkowa). */
  rabatMatkiNaDokumencie?: boolean
}

export interface ZlozonaFaktura {
  /** null = są problemy: takiej faktury nie wolno wystawić. */
  tresc: { invoices: { invoice: Record<string, unknown> } } | null
  linie: LiniaFaktury[]
  problemy: Problem[]
  forma: FormaPlatnosci | null
  bruttoGr: number
  nettoGr: number
}

const zl = (g: number) => (g / 100).toFixed(2)

export function zlozFakture(w: WejscieFaktury): ZlozonaFaktura {
  const poz = zlozPozycjeDokumentu({
    totalGross: w.totalGross,
    pozycje: w.pozycje,
    wysylka: w.konfiguracja.wysylka,
    kosztWysylki: w.kosztWysylki ?? null,
    rabatMaksProcent: w.konfiguracja.rabatMaksProcent,
    pobranie: w.paymentState === 'COD',
    ...(w.paczkiDodatkowe ? { paczkiDodatkowe: true } : {}),
    ...(w.rabatMatkiNaDokumencie ? { rabatMatkiNaDokumencie: true } : {}),
    ...(w.towarBezPowiazania ? { towarBezPowiazania: true } : {}),
  })
  const linie = poz.linie
  // treść 1:1: pole `dotyczyProgramu` zostaje w module pozycji (tu każdy problem dotyczy wFirmy)
  const problemy: Problem[] = poz.problemy.map(({ dotyczyProgramu: _p, ...p }) => p)

  const brakKodu = new Set(linie.filter((l) => !w.konfiguracja.kodyVat[l.stawkaVat]).map((l) => l.stawkaVat))
  for (const s of brakKodu) problemy.push({ kategoria: 'VAT', kod: 'brak-kodu-vat', nasze: s })
  const forma = formaPlatnosci(w.paymentMethod, w.paymentState, w.konfiguracja.platnosci)
  if (!forma) problemy.push({ kategoria: 'INNE', kod: 'nieznana-platnosc' })

  const tresc = problemy.length
    ? null
    : {
        invoices: {
          invoice: {
            type: 'normal',
            price_type: 'brutto',
            paymentmethod: forma,
            id_external: w.idExternal,
            ...(w.konfiguracja.seriaId ? { series: { id: w.konfiguracja.seriaId } } : {}),
            ...(w.kontrahent ? { contractor: w.kontrahent } : {}),
            invoicecontents: Object.fromEntries(
              linie.map((l, i) => [String(i), { invoicecontent: { good: { id: l.goodId }, name: l.nazwa, count: l.ilosc.toFixed(4), unit: l.jednostka, price: zl(l.cenaBruttoGr), vat_code: { id: w.konfiguracja.kodyVat[l.stawkaVat] } } }]),
            ),
          },
        },
      }
  return { tresc, linie, problemy, forma, bruttoGr: poz.bruttoGr, nettoGr: poz.nettoGr }
}
