// Porównanie faktury złożonej przez nas z fakturą BL dla tego samego zamówienia. Czysta funkcja.
// Wynik to same liczby, kody i SKU: bez NIP-ów, nazw i adresów kontrahentów.
import { type KategoriaRoznicy, type LiniaFaktury, type Problem, stawka, type ZlozonaFaktura } from './faktura'
import type { FormaPlatnosci } from './platnosci'

/**
 * Próg decyzyjny (cel zadania): tyle procent zgodnych faktur po 7 kolejnych dniach cienia daje wFirmie GO
 * na zapis przy przełączeniu pierwszego kanału. Jedyne miejsce z tą liczbą: zmiana progu = zmiana tej linii.
 */
export const PROG_ZGODNOSCI_PROCENT = 99

/** Tolerancja sum: 0,01 zł. */
const TOLERANCJA_GR = 1

export interface PozycjaBl {
  sku: string | null
  qty: number
  bruttoGr: number // wartość pozycji (cena × ilość)
  stawkaVat: string | null
  wysylka: boolean
}

export interface FakturaBl {
  /** null = kopia BL bez pozycji (faktury): porównanie samych sum. */
  pozycje: PozycjaBl[] | null
  bruttoGr: number | null
  nettoGr: number | null
  forma: FormaPlatnosci | null
}

export type WynikPorownania = 'ZGODNA' | 'ROZNICA' | 'BEZ_DANYCH'
export type ZakresPorownania = 'PELNY' | 'SUMY' | 'BRAK'

export interface Porownanie {
  wynik: WynikPorownania
  zakres: ZakresPorownania
  roznice: Problem[]
  kategorie: KategoriaRoznicy[]
}

interface Grupa {
  qty: number
  bruttoGr: number
  stawki: Set<string>
}

const dolicz = (m: Map<string, Grupa>, sku: string, qty: number, bruttoGr: number, s: string | null) => {
  const g = m.get(sku) ?? { qty: 0, bruttoGr: 0, stawki: new Set<string>() }
  g.qty += qty
  g.bruttoGr += bruttoGr
  if (s !== null) g.stawki.add(s)
  m.set(sku, g)
}

/** Nasze pozycje towarowe per SKU. Zestaw, który BL ma jedną linią, składamy z powrotem (rozbicie to nasza decyzja). */
function naszeGrupy(linie: LiniaFaktury[], skuBl: Set<string>): Map<string, Grupa> {
  const m = new Map<string, Grupa>()
  const policzone = new Set<number>() // pozycja zamówienia liczy się raz: rozbicie groszowe i składniki dają kilka linii
  const pierwsza = (l: LiniaFaktury) => {
    const nowa = !policzone.has(l.pozycja)
    policzone.add(l.pozycja)
    return nowa
  }
  for (const l of linie) {
    if (l.wysylka || l.sku === null) continue
    if (l.zestawSku && skuBl.has(l.zestawSku)) dolicz(m, l.zestawSku, pierwsza(l) ? l.sztukOferty : 0, l.bruttoGr, null) // zestaw mieszany nie ma jednej stawki
    else if (l.zestawSku) dolicz(m, l.sku, l.ilosc, l.bruttoGr, l.stawkaVat)
    else dolicz(m, l.sku, pierwsza(l) ? l.sztukOferty : 0, l.bruttoGr, l.stawkaVat)
  }
  return m
}

function kategorieSumy(roznicaGr: number, liczbaLinii: number, maWysylke: boolean): KategoriaRoznicy {
  if (maWysylke) return 'WYSYLKA'
  return Math.abs(roznicaGr) <= Math.max(2, liczbaLinii) ? 'ZAOKRAGLENIE' : 'INNE'
}

export function porownajFakture(nasza: ZlozonaFaktura, bl: FakturaBl): Porownanie {
  const roznice: Problem[] = [...nasza.problemy]
  const zakres: ZakresPorownania = bl.pozycje ? 'PELNY' : bl.bruttoGr !== null ? 'SUMY' : 'BRAK'

  if (bl.pozycje) {
    const towaryBl = new Map<string, Grupa>()
    let bezSku = 0
    for (const p of bl.pozycje) {
      if (p.wysylka) continue
      if (p.sku === null) bezSku++
      else dolicz(towaryBl, p.sku, p.qty, p.bruttoGr, p.stawkaVat === null ? null : stawka(p.stawkaVat))
    }
    const nasze = naszeGrupy(nasza.linie, new Set(towaryBl.keys()))
    if (bezSku) roznice.push({ kategoria: 'INNE', kod: 'pozycja-bl-bez-sku', bl: bezSku })
    if (nasze.size !== towaryBl.size + bezSku) roznice.push({ kategoria: 'INNE', kod: 'liczba-pozycji', nasze: nasze.size, bl: towaryBl.size + bezSku })
    for (const [sku, g] of nasze) {
      const b = towaryBl.get(sku)
      if (!b) {
        roznice.push({ kategoria: 'INNE', kod: 'pozycja-tylko-u-nas', sku, nasze: g.qty })
        continue
      }
      if (g.qty !== b.qty) roznice.push({ kategoria: 'INNE', kod: 'ilosc', sku, nasze: g.qty, bl: b.qty })
      if (Math.abs(g.bruttoGr - b.bruttoGr) > TOLERANCJA_GR) roznice.push({ kategoria: 'INNE', kod: 'kwota-pozycji', sku, nasze: g.bruttoGr, bl: b.bruttoGr })
      const a = [...g.stawki].sort().join('+')
      const c = [...b.stawki].sort().join('+')
      if (a && c && a !== c) roznice.push({ kategoria: 'VAT', kod: 'stawka', sku, nasze: a, bl: c })
    }
    for (const [sku, b] of towaryBl) if (!nasze.has(sku)) roznice.push({ kategoria: 'INNE', kod: 'pozycja-tylko-w-bl', sku, bl: b.qty })

    const naszaWys = nasza.linie.filter((l) => l.wysylka)
    const blWys = bl.pozycje.filter((p) => p.wysylka)
    const naszaGr = naszaWys.reduce((s, l) => s + l.bruttoGr, 0)
    const blGr = blWys.reduce((s, p) => s + p.bruttoGr, 0)
    if (Math.abs(naszaGr - blGr) > TOLERANCJA_GR) roznice.push({ kategoria: 'WYSYLKA', kod: 'kwota-wysylki', nasze: naszaGr, bl: blGr })
    const naszaVat = naszaWys[0]?.stawkaVat
    const blVat = blWys[0]?.stawkaVat
    if (naszaVat !== undefined && blVat !== undefined && blVat !== null && naszaVat !== stawka(blVat)) roznice.push({ kategoria: 'WYSYLKA', kod: 'vat-wysylki', nasze: naszaVat, bl: stawka(blVat) })
  }

  const liczbaLinii = nasza.linie.length
  const wysylkaInna = roznice.some((r) => r.kategoria === 'WYSYLKA')
  if (bl.bruttoGr !== null && Math.abs(nasza.bruttoGr - bl.bruttoGr) > TOLERANCJA_GR) {
    roznice.push({ kategoria: kategorieSumy(nasza.bruttoGr - bl.bruttoGr, liczbaLinii, wysylkaInna), kod: 'suma-brutto', nasze: nasza.bruttoGr, bl: bl.bruttoGr })
  }
  if (bl.nettoGr !== null && Math.abs(nasza.nettoGr - bl.nettoGr) > TOLERANCJA_GR) {
    const bruttoZgodne = bl.bruttoGr !== null && Math.abs(nasza.bruttoGr - bl.bruttoGr) <= TOLERANCJA_GR
    const kat: KategoriaRoznicy = bruttoZgodne ? (Math.abs(nasza.nettoGr - bl.nettoGr) <= Math.max(2, liczbaLinii) ? 'ZAOKRAGLENIE' : 'VAT') : kategorieSumy(nasza.nettoGr - bl.nettoGr, liczbaLinii, wysylkaInna)
    roznice.push({ kategoria: kat, kod: 'suma-netto', nasze: nasza.nettoGr, bl: bl.nettoGr })
  }
  if (bl.forma && nasza.forma && bl.forma !== nasza.forma) roznice.push({ kategoria: 'INNE', kod: 'forma-platnosci', nasze: nasza.forma, bl: bl.forma })

  const kategorie = [...new Set(roznice.map((r) => r.kategoria))]
  return { wynik: zakres === 'BRAK' ? 'BEZ_DANYCH' : roznice.length ? 'ROZNICA' : 'ZGODNA', zakres, roznice, kategorie }
}

/** Procent zgodnych wśród porównanych (BEZ_DANYCH, zgodne z samych sum i błędy nie wchodzą). null = nic nie porównano. */
export function procentZgodnych(zgodne: number, roznice: number): number | null {
  const n = zgodne + roznice
  return n ? (zgodne / n) * 100 : null
}

export const progSpelniony = (procent: number | null): boolean => procent !== null && procent >= PROG_ZGODNOSCI_PROCENT
