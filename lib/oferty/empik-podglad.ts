// Podgląd oferty Empik (Mirakl) z produktu Kompletora (Etap 2). Port `scripts/create_empik_offer.py`
// i `scripts/create_empik_product.py` ze skilla allegro-oferty, bez wysyłki:
// 1) EAN → produkt w katalogu Empiku (P31), 2a) jest → oferta (wiersz importu ofert OF01: sku, EAN, opis do 2000 znaków,
// cena, ilość, stan „nowy”; zdjęcia i opis produktu niesie katalog Empiku), 2b) nie ma → wniosek o nowy produkt
// (wiersz importu produktów P41 z 6 atrybutami wymaganymi przez Empik: STR_GOLD, CATALOG_CODE, PELNY_TYTUL,
// OPIS_PRODUKTU_PELNY, ZDJECIE_OKLADKI_PRZOD_DUZY, VAT_VALUE, plus EAN); Empik moderuje wniosek ręcznie (dni), oferta
// powstaje po akceptacji. Reguły treści jak na Allegro (linki, e-mail, telefon, emoji, wezwania) — Empik też ich nie
// przyjmuje. Zero zapisów: wysyłka to `lib/oferty/wystawianie.ts` za wyłącznikiem konta.
import { miraklProduktyPoEan, type MiraklGet, type MiraklProduktPim } from '@/lib/zrodla/mirakl'
import { kategoriaZMapy } from './kategorie'
import { sprawdzTresc, zbudujOpisTekstowy, type TrescOferty } from './opis'
import { poprawTytulAllegro, sprawdzTekstAllegro } from './regulamin-allegro'
import { tekstZHtml } from './tekst'
import { maBledy, type ProblemOferty, type ProduktDoOferty } from './typy'
import { DOMYSLNE_USTAWIENIA_KANALOW, type UstawieniaOfertKanalow } from './ustawienia'

/** Limit pola `description` oferty Mirakl to 2000 znaków; skill ucina do 1900 z zapasem (`MAX_OFFER_DESC_LEN`). */
export const OPIS_OFERTY_EMPIK_MAX = 1900
/** `PELNY_TYTUL` we wniosku o produkt (skill: `title[:200]`). */
export const TYTUL_EMPIK_MAX = 200

/** Kolumny importu ofert (OF01) zweryfikowane przez skill na raporcie błędów Empiku (14.07.2026). */
export const KOLUMNY_OFERTY_EMPIK = [
  'sku', 'product-id', 'product-id-type', 'description', 'internal-description', 'price', 'price-ranges', 'price-additional-info',
  'quantity', 'min-quantity-alert', 'state', 'available-start-date', 'available-end-date', 'update-delete', 'logistic-class',
  'discount-price', 'discount-start-date', 'discount-end-date', 'discount-ranges', 'leadtime-to-ship', 'allow-quote-requests',
  'product-tax-code', 'min-order-quantity', 'max-order-quantity', 'package-quantity', 'pricing-unit',
] as const

/** Kolumny importu produktów (P41) dla Empiku: identyfikator + 6 atrybutów wymaganych + atrybut EAN (skill 26.08.2026). */
export const KOLUMNY_PRODUKTU_EMPIK = [
  'sku', 'product-id', 'product-id-type', 'STR_GOLD', 'CATALOG_CODE', 'PELNY_TYTUL', 'OPIS_PRODUKTU_PELNY', 'ZDJECIE_OKLADKI_PRZOD_DUZY', 'VAT_VALUE', 'EAN',
] as const

/** Stan oferty „nowy” w Empiku (skill: `"state": "11"`). */
export const STAN_NOWY_EMPIK = '11'

export interface ZrodloEmpikOfert {
  produktyPoEan(ean: string): Promise<MiraklProduktPim[]>
}

/** Źródło na kliencie odczytu Mirakla (np. `(p, q) => new MiraklReadOnly(...).get(p, q)`). */
export function zrodloEmpikZApi(get: MiraklGet): ZrodloEmpikOfert {
  return { produktyPoEan: (ean) => miraklProduktyPoEan(get, ean) }
}

export interface WejsciePodgladuEmpik {
  produkt: ProduktDoOferty
  tresc?: TrescOferty
  /** Kod kategorii Empiku wybrany na ekranie (np. `13-34-8-2`); tylko dla wniosku o nowy produkt. */
  recznaKategoria?: string | null
  cenaBrutto?: number | null
}

export type TrybEmpik = 'oferta' | 'wniosek_o_produkt'

export interface PodgladOfertyEmpik {
  kanal: 'empik'
  tryb: TrybEmpik
  tytul: string
  produktPim: { sku: string; tytul: string; kategoriaKod: string | null; kategoriaNazwa: string | null } | null
  kategoria: { kod: string | null; opis: string }
  /** Opis oferty (zwykły tekst, do 1900 znaków). */
  opisOferty: string
  /** Pełny opis produktu do wniosku (zwykły tekst); pusty w trybie oferty. */
  opisProduktu: string
  /** Zdjęcie główne wniosku (pierwsze z publicznym adresem); w trybie oferty zdjęcia niesie katalog Empiku. */
  zdjecia: string[]
  cena: { kwota: string; waluta: 'PLN' } | null
  stan: number
  problemy: ProblemOferty[]
  gotowa: boolean
  /** Wiersz importu ofert (kolumny `KOLUMNY_OFERTY_EMPIK`); w trybie wniosku — oferta do wysłania po akceptacji produktu. */
  wierszOferty: Record<string, string>
  /** Wiersz importu produktu (kolumny `KOLUMNY_PRODUKTU_EMPIK`); null w trybie oferty. */
  wierszProduktu: Record<string, string> | null
}

const EAN_RE = /^\d{8,14}$/
const KOD_KATEGORII_RE = /^\d{1,4}(-\d{1,4}){0,6}$/
const bezZer = (e: string) => e.replace(/^0+/, '')
const naEmpik = (p: ProblemOferty): ProblemOferty => ({ ...p, komunikat: p.komunikat.replace(/Allegro/g, 'Empik') })

/** Opis oferty jako zwykły tekst do 1900 znaków, cięty na granicy zdania w drugiej połowie (port `_truncate_offer_description`). */
export function skrocOpisEmpik(html: string): string {
  const tekst = tekstZHtml(html)
  if (tekst.length <= OPIS_OFERTY_EMPIK_MAX) return tekst
  const ciecie = tekst.slice(0, OPIS_OFERTY_EMPIK_MAX)
  const kropka = ciecie.lastIndexOf('. ')
  return kropka > OPIS_OFERTY_EMPIK_MAX / 2 ? ciecie.slice(0, kropka + 1) : `${ciecie.trimEnd()}…`
}

/** Wiersze → plik CSV importu Mirakla (port `_row_to_csv_bytes`): średnik, każde pole w cudzysłowie, bez nowych linii w polach, CRLF. */
export function csvEmpik(kolumny: readonly string[], wiersze: readonly Record<string, string>[]): string {
  const pole = (v: string) => `"${String(v ?? '').replace(/\r\n|\n|\r/g, ' ').replace(/"/g, '""')}"`
  return [kolumny.map(pole).join(';'), ...wiersze.map((w) => kolumny.map((k) => pole(w[k] ?? '')).join(';'))].join('\r\n') + '\r\n'
}

/** Produkt katalogu Empiku z tym samym EAN (bez zer wiodących); Empik szuka po referencji, więc zwykle jest jeden. */
export function wybierzZPim(ean: string, produkty: MiraklProduktPim[]): MiraklProduktPim | null {
  return produkty.find((p) => p.eany.some((e) => bezZer(e) === bezZer(ean))) ?? (produkty.length === 1 && produkty[0]!.eany.length === 0 ? produkty[0]! : null)
}

export async function przygotujPodgladEmpik(
  wej: WejsciePodgladuEmpik,
  zrodlo: ZrodloEmpikOfert,
  ustawienia: UstawieniaOfertKanalow = DOMYSLNE_USTAWIENIA_KANALOW,
): Promise<PodgladOfertyEmpik> {
  const p = wej.produkt
  const problemy: ProblemOferty[] = []
  const ean = p.ean?.trim() || null

  // 1. EAN i katalog Empiku
  let pim: MiraklProduktPim | null = null
  let katalogSprawdzony = false
  if (!ean) problemy.push({ kod: 'bez_ean', waga: 'blad', komunikat: 'Produkt nie ma kodu EAN — Empik wystawia oferty tylko po EAN. Uzupełnij go w karcie produktu.', pole: 'ean' })
  else if (!EAN_RE.test(ean)) problemy.push({ kod: 'zly_ean', waga: 'blad', komunikat: `Kod EAN „${ean}” ma zły format (8–14 cyfr).`, pole: 'ean' })
  else {
    try {
      pim = wybierzZPim(ean, await zrodlo.produktyPoEan(ean))
      katalogSprawdzony = true
    } catch {
      // bez odpowiedzi nie wiadomo, czy wysłać ofertę, czy wniosek (wniosek dla istniejącego produktu to dubel)
      problemy.push({ kod: 'empik_niedostepne', waga: 'blad', komunikat: 'Nie udało się sprawdzić katalogu Empiku — spróbuj ponownie za chwilę.', pole: 'katalog' })
    }
  }
  const tryb: TrybEmpik = pim ? 'oferta' : 'wniosek_o_produkt'
  if (katalogSprawdzony && !pim)
    problemy.push({ kod: 'empik_poza_katalogiem', waga: 'ostrzezenie', komunikat: 'Tego produktu nie ma jeszcze w katalogu Empiku — najpierw idzie wniosek o produkt; Empik sprawdza go ręcznie (zwykle kilka dni), potem można wystawić ofertę.', pole: 'katalog' })

  // 2. Tytuł i treść
  const tresc: TrescOferty = { ...(wej.tresc ?? {}), opis: wej.tresc?.opis?.trim() ? wej.tresc.opis : (p.opis ?? '') }
  const tytul = poprawTytulAllegro(tresc.tytul?.trim() || p.nazwa)
  const dl = [...tytul].length
  if (!dl) problemy.push({ kod: 'tytul_pusty', waga: 'blad', komunikat: 'Produkt nie ma nazwy.', pole: 'tytul' })
  if (tryb === 'wniosek_o_produkt' && dl > TYTUL_EMPIK_MAX) problemy.push({ kod: 'tytul_dlugi', waga: 'blad', komunikat: `Tytuł ma ${dl} znaków, Empik przyjmuje najwyżej ${TYTUL_EMPIK_MAX}.`, pole: 'tytul' })
  problemy.push(
    ...sprawdzTekstAllegro('tytul', tytul, ustawienia.regulamin).map(naEmpik),
    // oferta do produktu z katalogu Empiku: opis produktu niesie katalog, więc brak opisu to tylko ostrzeżenie
    ...sprawdzTresc(tresc, ustawienia.regulamin).map((x) => naEmpik(pim && x.kod === 'bez_opisu' ? { ...x, waga: 'ostrzezenie' } : x)),
  )
  const opisHtml = zbudujOpisTekstowy(tresc, tytul, ustawienia.szablonOpisu)
  const opisOferty = skrocOpisEmpik(opisHtml)
  if (tekstZHtml(opisHtml).length > OPIS_OFERTY_EMPIK_MAX)
    problemy.push({ kod: 'opis_skrocony', waga: 'ostrzezenie', komunikat: `Opis oferty w Empiku ma limit 2000 znaków — trafi skrócony do ${OPIS_OFERTY_EMPIK_MAX}.`, pole: 'opis' })
  const opisProduktu = tryb === 'wniosek_o_produkt' ? tekstZHtml(opisHtml) : ''

  // 3. Kategoria
  let kategoria: PodgladOfertyEmpik['kategoria'] = { kod: null, opis: 'brak kategorii' }
  if (pim) kategoria = { kod: pim.kategoriaKod, opis: pim.kategoriaNazwa ? `kategoria produktu w katalogu Empiku: ${pim.kategoriaNazwa}` : 'kategoria produktu w katalogu Empiku' }
  else {
    const reczna = wej.recznaKategoria?.trim() || null
    if (reczna && !KOD_KATEGORII_RE.test(reczna)) problemy.push({ kod: 'kategoria_zly_kod', waga: 'blad', komunikat: `„${reczna}” nie wygląda jak kod kategorii Empiku (np. 13-34-8-2).`, pole: 'kategoria' })
    else if (reczna) kategoria = { kod: reczna, opis: 'kategoria wybrana ręcznie' }
    else {
      const z = kategoriaZMapy(ustawienia.empik.mapaKategorii, p.nazwa, p.kategorieSklepu)
      if (z) kategoria = { kod: z.kategoriaId, opis: `z mapy firmy (słowo „${z.slowo}”)` }
    }
    if (!kategoria.kod && !problemy.some((x) => x.kod === 'kategoria_zly_kod'))
      problemy.push({ kod: 'bez_kategorii', waga: tryb === 'wniosek_o_produkt' && katalogSprawdzony ? 'blad' : 'ostrzezenie', komunikat: 'Wybierz kategorię Empiku dla wniosku o nowy produkt (mapa firmy jej nie podpowiada).', pole: 'kategoria' })
  }

  // 4. Zdjęcia (tylko wniosek: Empik pobiera zdjęcie z publicznego adresu, nie przyjmuje pliku)
  const zdjecia = [...new Set(p.zdjecia.map((u) => u?.trim()).filter((u): u is string => !!u))]
  const publiczne = zdjecia.filter((u) => /^https:\/\//i.test(u))
  if (tryb === 'wniosek_o_produkt') {
    if (!zdjecia.length) problemy.push({ kod: 'bez_zdjec', waga: 'blad', komunikat: 'Produkt nie ma zdjęć — wniosek do Empiku wymaga zdjęcia.', pole: 'zdjecia' })
    else if (!publiczne.length) problemy.push({ kod: 'zdjecie_bez_adresu', waga: 'blad', komunikat: 'Żadne zdjęcie nie ma publicznego adresu (https) — Empik pobiera zdjęcie z adresu, nie przyjmuje pliku.', pole: 'zdjecia' })
  }

  // 5. Cena i stan
  const cenaBrutto = wej.cenaBrutto ?? p.cenaBrutto
  const cena = cenaBrutto !== null && cenaBrutto !== undefined && Number.isFinite(cenaBrutto) && cenaBrutto > 0 ? { kwota: cenaBrutto.toFixed(2), waluta: 'PLN' as const } : null
  if (!cena) problemy.push({ kod: 'bez_ceny', waga: 'blad', komunikat: 'Produkt nie ma ceny brutto — uzupełnij ją w karcie produktu.', pole: 'cena' })
  const stan = Math.max(0, Math.floor(p.stan || 0))
  if (stan < 1) problemy.push({ kod: 'brak_stanu', waga: 'blad', komunikat: 'Brak towaru na stanie — oferta bez sztuk nie może być aktywna.', pole: 'stan' })
  if (!p.sku.trim()) problemy.push({ kod: 'bez_sku', waga: 'blad', komunikat: 'Produkt nie ma SKU — Empik łączy ofertę z produktem po SKU sprzedawcy.', pole: 'sku' })

  const wierszOferty: Record<string, string> = Object.fromEntries(KOLUMNY_OFERTY_EMPIK.map((k) => [k, '']))
  Object.assign(wierszOferty, {
    sku: p.sku.trim(),
    'product-id': ean ?? '',
    'product-id-type': 'EAN',
    description: opisOferty,
    price: cena?.kwota ?? '',
    quantity: String(stan),
    'min-quantity-alert': String(ustawienia.empik.minIloscAlarm),
    state: STAN_NOWY_EMPIK,
  })
  const wierszProduktu: Record<string, string> | null =
    tryb === 'wniosek_o_produkt'
      ? {
          sku: p.sku.trim(),
          'product-id': ean ?? '',
          'product-id-type': 'EAN',
          STR_GOLD: kategoria.kod ?? '',
          CATALOG_CODE: p.sku.trim(),
          PELNY_TYTUL: [...tytul].slice(0, TYTUL_EMPIK_MAX).join(''),
          OPIS_PRODUKTU_PELNY: opisProduktu,
          ZDJECIE_OKLADKI_PRZOD_DUZY: publiczne[0] ?? '',
          VAT_VALUE: ustawienia.empik.stawkaVat,
          EAN: ean ?? '',
        }
      : null

  return {
    kanal: 'empik',
    tryb,
    tytul,
    produktPim: pim ? { sku: pim.sku, tytul: pim.tytul, kategoriaKod: pim.kategoriaKod, kategoriaNazwa: pim.kategoriaNazwa } : null,
    kategoria,
    opisOferty,
    opisProduktu,
    zdjecia: tryb === 'wniosek_o_produkt' ? publiczne.slice(0, 1) : [],
    cena,
    stan,
    problemy,
    gotowa: !maBledy(problemy),
    wierszOferty,
    wierszProduktu,
  }
}
