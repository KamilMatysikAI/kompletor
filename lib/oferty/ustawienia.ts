// Ustawienia ofert firmy: `Organization.settings.oferty`. Dane, nie kod — preset firmy niesie mapę kategorii,
// marki, wagi i szablon opisu; każda inna firma startuje od neutralnych domyślnych.
// Parser jest tolerancyjny: zły albo brakujący wpis = wartość domyślna (ekran podglądu nigdy nie pada przez ustawienia).
import { DOMYSLNE_USTAWIENIA_OFERT, type UstawieniaOfertFirmy } from './allegro-podglad'
import type { MapaKategoriiFirmy } from './kategorie'
import { DOMYSLNY_SZABLON_OPISU, type SzablonOpisu } from './opis'
import { DOMYSLNE_ZASADY_PARAMETROW, type WartoscDomyslna, type ZasadyParametrowFirmy } from './parametry'

export interface UstawieniaEmpikFirmy {
  /** Słowo kluczowe → kod kategorii Empiku (Struktura towarowa GOLD, np. `13-34-8-2`), dopasowanie jak w Allegro. */
  mapaKategorii: MapaKategoriiFirmy
  /** Stawka VAT we wniosku o nowy produkt (atrybut `VAT_VALUE`, tekst jak „23%”). */
  stawkaVat: string
  /** Próg „mało towaru” w ofercie (kolumna `min-quantity-alert`, skill: 2). */
  minIloscAlarm: number
}

export interface UstawieniaWooFirmy {
  /** Status nowego produktu w sklepie: szkic (domyślnie, sklep publikuje sam) albo od razu opublikowany. */
  status: 'draft' | 'publish'
  /** Gdzie sklep trzyma EAN: `global_unique_id` (WooCommerce 9.2+) albo klucz pola meta (np. `_ean`). */
  poleEan: string
}

export interface UstawieniaOfertKanalow extends UstawieniaOfertFirmy {
  empik: UstawieniaEmpikFirmy
  woo: UstawieniaWooFirmy
}

export const DOMYSLNE_USTAWIENIA_EMPIK: UstawieniaEmpikFirmy = { mapaKategorii: { poSlowie: {} }, stawkaVat: '23%', minIloscAlarm: 2 }
export const DOMYSLNE_USTAWIENIA_WOO: UstawieniaWooFirmy = { status: 'draft', poleEan: 'global_unique_id' }

export const DOMYSLNE_USTAWIENIA_KANALOW: UstawieniaOfertKanalow = {
  ...DOMYSLNE_USTAWIENIA_OFERT,
  empik: DOMYSLNE_USTAWIENIA_EMPIK,
  woo: DOMYSLNE_USTAWIENIA_WOO,
}

const rec = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const tekst = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** Mapa tekst → tekst (kolejność kluczy zachowana; puste i nie-tekstowe wartości pomijane). */
function mapaTekstow(v: unknown, wartosc: RegExp = /^.{1,200}$/s): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, x] of Object.entries(rec(v) ?? {})) {
    const s = tekst(x)
    if (k.trim() && s && wartosc.test(s)) out[k] = s
  }
  return out
}

const KG_RE = /^\d{1,3}(\.\d{1,3})?$/

function wartoscDomyslna(v: unknown): WartoscDomyslna | null {
  const s = tekst(v)
  if (s) return s
  const r = rec(v)
  if (!r) return null
  const cecha = tekst(r['zCechy'])
  if (cecha) return { zCechy: cecha }
  if (r['zPola'] === 'sku' || r['zPola'] === 'ean') return { zPola: r['zPola'] }
  return null
}

function mapaWartosci(v: unknown): Record<string, WartoscDomyslna> {
  const out: Record<string, WartoscDomyslna> = {}
  for (const [k, x] of Object.entries(rec(v) ?? {})) {
    const w = wartoscDomyslna(x)
    if (/^\d{1,12}$/.test(k) && w !== null) out[k] = w
  }
  return out
}

function parametry(v: unknown): ZasadyParametrowFirmy {
  const r = rec(v)
  if (!r) return DOMYSLNE_ZASADY_PARAMETROW
  const perKategoria: ZasadyParametrowFirmy['domyslnePerKategoria'] = {}
  for (const [kat, x] of Object.entries(rec(r['domyslnePerKategoria']) ?? {})) if (/^\d{1,12}$/.test(kat)) perKategoria[kat] = mapaWartosci(x)
  return {
    marka: tekst(r['marka']),
    stan: tekst(r['stan']) ?? DOMYSLNE_ZASADY_PARAMETROW.stan,
    stale: mapaWartosci(r['stale']),
    domyslnePerKategoria: perKategoria,
    wagiPoSlowie: mapaTekstow(r['wagiPoSlowie'], KG_RE),
    wagiPoKategoriiSklepu: mapaTekstow(r['wagiPoKategoriiSklepu'], KG_RE),
  }
}

function szablon(v: unknown): SzablonOpisu {
  const r = rec(v)
  if (!r) return DOMYSLNY_SZABLON_OPISU
  const n = rec(r['naglowki']) ?? {}
  const d = DOMYSLNY_SZABLON_OPISU.naglowki
  return {
    naglowki: {
      opis: tekst(n['opis']) ?? d.opis,
      cechy: tekst(n['cechy']) ?? d.cechy,
      uzycie: tekst(n['uzycie']) ?? d.uzycie,
      dlaKogo: tekst(n['dlaKogo']) ?? d.dlaKogo,
      specyfikacja: tekst(n['specyfikacja']) ?? d.specyfikacja,
      pytania: tekst(n['pytania']) ?? d.pytania,
    },
    oMarce: tekst(r['oMarce']),
  }
}

/** `Organization.settings` (cały obiekt) → ustawienia ofert; brak sekcji `oferty` = domyślne neutralne. */
export function ustawieniaOfertZSettings(settings: unknown): UstawieniaOfertKanalow {
  const o = rec(rec(settings)?.['oferty'])
  if (!o) return DOMYSLNE_USTAWIENIA_KANALOW
  const e = rec(o['empik']) ?? {}
  const w = rec(o['woo']) ?? {}
  const alarm = typeof e['minIloscAlarm'] === 'number' && Number.isInteger(e['minIloscAlarm']) && (e['minIloscAlarm'] as number) >= 0 ? (e['minIloscAlarm'] as number) : DOMYSLNE_USTAWIENIA_EMPIK.minIloscAlarm
  const poleEan = tekst(w['poleEan'])
  return {
    ...DOMYSLNE_USTAWIENIA_OFERT,
    mapaKategorii: { poSlowie: mapaTekstow(o['mapaKategoriiAllegro'], /^\d{1,12}$/) },
    parametry: parametry(o['parametry']),
    szablonOpisu: szablon(o['szablonOpisu']),
    empik: {
      mapaKategorii: { poSlowie: mapaTekstow(e['mapaKategorii'], /^[0-9A-Za-z_-]{1,40}$/) },
      stawkaVat: tekst(e['stawkaVat']) ?? DOMYSLNE_USTAWIENIA_EMPIK.stawkaVat,
      minIloscAlarm: alarm,
    },
    woo: {
      status: w['status'] === 'publish' ? 'publish' : 'draft',
      poleEan: poleEan && /^[A-Za-z0-9_-]{1,64}$/.test(poleEan) ? poleEan : DOMYSLNE_USTAWIENIA_WOO.poleEan,
    },
  }
}
