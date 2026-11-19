// zestaw wirtualny na fakturze rozbity na składniki. Cena zestawu dzielona proporcjonalnie do cen
// detalicznych brutto składników; suma brutto = cena zestawu; różnica z zaokrągleń na najdroższym składniku;
// żaden składnik nie dostaje ceny ≤ 0; stawki VAT ze składników. Operujemy na groszach (liczby całkowite).

export interface BundlePart {
  productId: string
  qty: number // sztuk składnika na 1 zestaw
  retailGross: number // cena detaliczna brutto 1 szt. składnika (zł)
  vatRate: string
}

export interface SplitLine {
  productId: string
  qty: number
  unitGrossGr: number // cena jednostkowa brutto w groszach
  lineGrossGr: number
  vatRate: string
}

/**
 * Wartość pozycji w groszach: ilość w jednostce bazowej przeliczona na sztuki oferty (`naOferte` =
 * qtyBasePerOffer, 1 bez oferty) razy cena za sztukę oferty. Ta sama reguła co `zlozPozycjeDokumentu`
 * (lib/dokumenty/pozycje.ts), więc linie rdzenia i treść dokumentu mają tę samą kwotę.
 * Przykład: oferta 50 g za 12,50 zł, 2 sztuki oferty = 100 g → 2500 gr (nie 100 × 1250).
 * Jedyna implementacja tej reguły: dokument (`zlozPozycjeDokumentu`), paczka dodatkowa
 * (`kwotaPaczkiDodatkowej`) i karta zamówienia wołają tę funkcję. Mnożenie przed dzieleniem: część oferty co do
 * połówki grosza, np. 29 g z oferty 50 g za 3,75 zł = 217,5 gr → 218 (dzielenie najpierw dawało 217,4999… → 217).
 */
export function wartoscPozycjiGr(qtyBase: number, naOferte: number, cenaOfertyGr: number): number {
  const n = Number.isFinite(naOferte) && naOferte > 0 ? naOferte : 1
  return Math.round((qtyBase * cenaOfertyGr) / n)
}

/**
 * Wartość pozycji rozpisana na cenę za JEDNOSTKĘ BAZOWĄ (sztuka, gram) co do grosza, bo linia rdzenia ma ilość
 * w jednostce bazowej: `qty × unitGrossGr` każdej części sumuje się do `wartoscGr`. Gdy wartość nie dzieli się
 * równo, dwie części: reszta jednostek o 1 gr droższa (jak `splitBundlePrice`). Cena poniżej 1 gr za jednostkę
 * bazową (np. tani towar liczony w gramach) daje część z ceną 0 gr — suma nadal się zgadza.
 */
export function rozpiszNaJednostkiBazowe(qtyBase: number, wartoscGr: number): { qty: number; unitGrossGr: number }[] {
  if (!Number.isInteger(qtyBase) || qtyBase <= 0) return [{ qty: qtyBase, unitGrossGr: qtyBase ? Math.round(wartoscGr / qtyBase) : 0 }]
  const cena = Math.floor(wartoscGr / qtyBase)
  const r = wartoscGr - cena * qtyBase
  if (!r) return [{ qty: qtyBase, unitGrossGr: cena }]
  const out = [{ qty: qtyBase - r, unitGrossGr: cena }, { qty: r, unitGrossGr: cena + 1 }]
  return out.filter((x) => x.qty > 0)
}

/** Rozbija cenę `bundleGrossGr` (grosze, za 1 zestaw) na składniki. */
export function splitBundlePrice(bundleGrossGr: number, parts: BundlePart[]): SplitLine[] {
  if (!parts.length) throw new Error('zestaw bez składników')
  const minTotal = parts.reduce((s, p) => s + p.qty, 0) // 1 gr na sztukę minimum
  if (bundleGrossGr < minTotal) throw new Error(`cena zestawu ${bundleGrossGr} gr za niska dla ${minTotal} szt. składników`)
  const weights = parts.map((p) => Math.max(1, Math.round(p.retailGross * 100)) * p.qty)
  const wSum = weights.reduce((a, b) => a + b, 0)
  // cena jednostkowa składnika (grosze), co najmniej 1 gr
  const unit = parts.map((p, i) => Math.max(1, Math.floor((bundleGrossGr * weights[i]!) / wSum / p.qty)))
  let total = unit.reduce((s, u, i) => s + u * parts[i]!.qty, 0)
  // korekta: różnica na najdroższym składniku (wg wagi). Gdy qty > 1 nie da się wyrównać co do grosza
  // ceną jednostkową, więc reszta trafia do pierwszego składnika z qty = 1, a gdy takiego brak — jako
  // osobna linia tego samego produktu (1 szt. z inną ceną).
  const order = parts.map((_, i) => i).sort((a, b) => weights[b]! - weights[a]!)
  const lines: SplitLine[] = parts.map((p, i) => ({
    productId: p.productId,
    qty: p.qty,
    unitGrossGr: unit[i]!,
    lineGrossGr: unit[i]! * p.qty,
    vatRate: p.vatRate,
  }))
  let diff = bundleGrossGr - total
  if (diff !== 0) {
    const single = order.find((i) => parts[i]!.qty === 1)
    if (single !== undefined && lines[single]!.unitGrossGr + diff > 0) {
      lines[single]!.unitGrossGr += diff
      lines[single]!.lineGrossGr += diff
    } else {
      const i = order[0]!
      const l = lines[i]!
      // jedna sztuka z poprawioną ceną jako osobna linia
      if (l.unitGrossGr + diff <= 0) throw new Error('nie da się rozbić ceny zestawu bez ceny ≤ 0')
      l.qty -= 1
      l.lineGrossGr = l.unitGrossGr * l.qty
      lines.push({ productId: l.productId, qty: 1, unitGrossGr: l.unitGrossGr + diff, lineGrossGr: l.unitGrossGr + diff, vatRate: l.vatRate })
      if (l.qty === 0) lines.splice(i, 1)
    }
    total = lines.reduce((s, x) => s + x.lineGrossGr, 0)
    diff = bundleGrossGr - total
  }
  if (diff !== 0) throw new Error('rozbicie ceny zestawu niezgodne co do grosza')
  if (lines.some((l) => l.unitGrossGr <= 0)) throw new Error('składnik z ceną ≤ 0')
  return lines
}

/**
 * rabat na całe zamówienie (ujemna opłata Woo `fee_lines`, rabat kanału spoza pozycji) rozłożony na pozycje.
 * Jedna reguła dla adaptera (cena pozycji w zamówieniu) i dokumentu sprzedaży (`zlozPozycjeDokumentu`): cena za sztukę
 * × (wartość towarów po rabacie / przed rabatem), zaokrąglona do grosza. Reszta z zaokrągleń, której cena za sztukę nie
 * pomieści, idzie na pierwszą pozycję dokumentu (tak liczy BaseLinker; opis w docs/dokumenty-sprzedazy.md).
 * Mnożenie przed dzieleniem (jak `wartoscPozycjiGr`). `przedGr` ≤ 0 = bez zmiany.
 */
export function cenaPoRabacieGr(cenaGr: number, przedGr: number, poGr: number): number {
  if (!(przedGr > 0) || przedGr === poGr) return cenaGr
  return Math.round((cenaGr * poGr) / przedGr)
}

/**
 * różnica między wartością towarów po rabacie a sumą cen pozycji, którą
 * wchłania sama reszta zaokrągleń cen za sztukę (najwyżej pół grosza na sztukę oferty, w obie strony). Taka różnica NIE
 * skaluje cen drugi raz (ceny po rabacie z adaptera zostają), tylko trafia jako korekta na pierwszą pozycję. Większa
 * różnica = rabat do rozłożenia `cenaPoRabacieGr`.
 */
export function resztaZaokraglenGr(przedGr: number, poGr: number, sztukOferty: number): boolean {
  return Math.abs(poGr - przedGr) <= Math.ceil(sztukOferty / 2)
}

/**
 * domyślny sufit rabatu na całe zamówienie, w procentach wartości pozycji. Ustawienie firmy
 * (`settings.faktury.rabatMaksProcent`, lib/dokumenty/ustawienia.ts) go nadpisuje; to jedyne źródło:
 * dokument czyta je wprost, adapter Woo dostaje je od hosta w `ctx.ustawieniaFirmy`.
 * Powyżej sufitu różnica nie jest rabatem: dokument staje z `pozycje-drozsze-niz-zamowienie`.
 */
export const DOMYSLNY_SUFIT_RABATU_PROC = 50

/** Sufit rabatu (procent) z wartości ustawienia: liczba 0–100, inaczej domyślny. */
export function sufitRabatuProc(v: unknown): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100 ? n : DOMYSLNY_SUFIT_RABATU_PROC
}

/** Czy rabat (grosze) mieści się w suficie (procent wartości pozycji `przedGr`). */
export const rabatWSuficie = (rabatGr: number, przedGr: number, sufitProc: number): boolean => rabatGr * 100 <= przedGr * sufitProc
