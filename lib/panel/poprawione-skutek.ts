// Treść okna potwierdzenia „Poprawione w wFirmie” (Braki towaru → „Do poprawy w wFirmie”): warunek, skutek liczbami
// z bieżącego stanu (liczony na serwerze) i ostrzeżenie, gdy Kompletor wie, że WZ do faktury w wFirmie brakuje.
// Czyste funkcje — testy w poprawione-skutek.test.ts.
import type { SkutekPoprawionego } from '@/lib/rdzen/rozchod'
import { qty } from './format'

/** Co biuro sprawdza w wFirmie przed kliknięciem, wg rodzaju pozycji. */
const CO_SPRAWDZIC: Record<string, string> = {
  BL_INVOICE: 'faktura i WZ są w wFirmie',
  OWN_INVOICE: 'faktura i WZ są w wFirmie',
  ISSUED_WITHOUT_DOCUMENT: 'dokument tej wysyłki (WZ albo faktura) jest w wFirmie',
  STOCK_MISSING: 'stan tego produktu jest poprawiony w wFirmie',
  DAMAGED_RETURN: 'dokument RW jest w wFirmie',
}

export function warunekPoprawionego(rodzaj: string): string {
  return CO_SPRAWDZIC[rodzaj] ?? 'dokumenty są poprawione w wFirmie'
}

/** Zdania okna: `skutek` (zawsze), `ostrzezenie` (faktura bez WZ w wFirmie) albo null. */
export function tekstSkutku(s: SkutekPoprawionego): { skutek: string; ostrzezenie: string | null } {
  const q = (n: number) => qty(n, s.jednostka)
  const wzrost = s.dostepnyPo - s.dostepnyPrzed
  const przy = `Przy obecnym stanie z wFirmy (${q(s.wfirma)})`
  const skutek =
    wzrost > 0
      ? `${przy} stan dostępny wzrośnie o ${q(wzrost)}, z ${q(s.dostepnyPrzed)} do ${q(s.dostepnyPo)}, i tyle zobaczą sklepy (konto w podglądzie: dopiero po przełączeniu w tryb pracy).`
      : `${przy} pozycja przestanie pomniejszać stan o ${q(s.ilosc)}, ale stan dostępny zostanie ${q(s.dostepnyPo)}, bo zajmują go rezerwacje.`
  const numer = s.fakturaBezWz && !s.fakturaBezWz.startsWith('wz:') ? ` ${s.fakturaBezWz}` : ''
  const ostrzezenie =
    s.fakturaBezWz !== null ? `Kompletor nie znalazł w wFirmie WZ do tej faktury${numer}: kliknij tylko, jeśli wydanie jest w wFirmie pod innym dokumentem.` : null
  return { skutek, ostrzezenie }
}
