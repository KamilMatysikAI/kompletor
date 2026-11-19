// Linie faktury KSeF: te same co faktury wFirmy i każdego innego programu. Rozbijanie zestawów, wysyłka,
// DIGITAL, zaokrąglenia i bezpiecznik sumy robi wspólny moduł `zlozPozycjeDokumentu` (lib/dokumenty/pozycje.ts) — tu
// żadnych własnych reguł. Problemy odsiewa pole `dotyczyProgramu` (np. brak powiązania z kartoteką wFirmy
// dotyczy tylko wFirmy), zamiast listy kodów; kody VAT i forma płatności konta wFirmy w ogóle tu nie powstają.
// Pozycja bez produktu zostaje problemem (nie wiemy, co sprzedano). Nie używamy `buildInvoiceLines` (lib/rdzen/rozchod.ts):
// zawyża kwotę przy `qtyBasePerOffer > 1`.
import { KOD_RABATU_BEZ_PLATNEJ, KOD_RABATU_NIEPEWNEGO, KOMUNIKAT_RABATU, KOMUNIKAT_RABATU_BEZ_PLATNEJ, KOMUNIKAT_ZAMIENNIKA, type Problem, problemyProgramu, type WejsciePozycji, zlozPozycjeDokumentu } from '../dokumenty/pozycje'
import type { ProblemFa3, WierszFa3 } from './fa3/typy'

const TEKSTY: Record<string, string> = {
  'pozycja-bez-produktu': 'Pozycja zamówienia bez powiązania z produktem: nie wiadomo, co sprzedano.',
  'zestaw-bez-rozbicia': 'Zestawu nie da się rozbić na składniki (brak składników albo cen).',
  'brak-stawki': 'Produkt bez stawki VAT.',
  'pozycje-drozsze-niz-zamowienie': 'Pozycje są droższe niż kwota zamówienia (albo rabat na całe zamówienie większy niż limit rabatu firmy).',
  'cena-zero-po-rabacie': 'Pozycja wyszłaby za 0 zł po rozłożeniu rabatu na całe zamówienie.',
  [KOD_RABATU_NIEPEWNEGO]: KOMUNIKAT_RABATU,
  [KOD_RABATU_BEZ_PLATNEJ]: KOMUNIKAT_RABATU_BEZ_PLATNEJ,
  'reszta-bez-wysylki': 'Zaokrąglenie ceny za kg bez wysyłki, która by je wchłonęła.',
  'suma-rozna-od-zamowienia': 'Suma pozycji różni się od kwoty zamówienia.',
  'nic-do-faktury': 'Nie ma pozycji do faktury.',
  'zamiennik-bez-pozycji-pierwotnej': KOMUNIKAT_ZAMIENNIKA,
  'zamiennik-wiecej-niz-odrzucono': KOMUNIKAT_ZAMIENNIKA,
  'zamiennik-cena-inna-niz-pierwotna': KOMUNIKAT_ZAMIENNIKA,
  'zamiennik-usuniety-zamiennik': KOMUNIKAT_ZAMIENNIKA,
}

export function problemZFaktury(p: Problem): ProblemFa3 {
  return { kod: p.kod, pole: p.sku ? `pozycja SKU ${p.sku}` : 'Fa.FaWiersz', tekst: TEKSTY[p.kod] ?? 'Problem pozycji faktury.' }
}

export interface LinieKsef {
  wiersze: WierszFa3[]
  problemy: ProblemFa3[]
  bruttoGr: number
  nettoGr: number
}

/** Linie faktury z zamówienia (bez danych kontrahenta) w kształcie wierszy FA(3). Wejście jak `zlozPozycjeDokumentu`. */
export function linieKsef(w: WejsciePozycji): LinieKsef {
  const f = zlozPozycjeDokumentu(w)
  return {
    wiersze: f.linie.map((l) => ({ nazwa: l.nazwa, jednostka: l.jednostka, ilosc: l.ilosc, cenaBruttoGr: l.cenaBruttoGr, bruttoGr: l.bruttoGr, stawka: l.stawkaVat })),
    problemy: problemyProgramu(f.problemy, 'ksef').map(problemZFaktury),
    bruttoGr: f.bruttoGr,
    nettoGr: f.nettoGr,
  }
}
