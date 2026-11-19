// Podgląd produktu w sklepie WooCommerce z danych produktu Kompletora (Etap 2). Bez wysyłki: wynik niesie
// szkic produktu w kształcie WC REST v3 (`POST /products/batch` → `create`), a zapis to `lib/oferty/wystawianie.ts`
// za wyłącznikiem konta. Sprawdzenia: SKU już w sklepie (wtedy nie zakładamy drugiego produktu, tylko powiązanie),
// kategorie sklepu z karty dopasowane do kategorii sklepu po slugu albo nazwie, zdjęcia tylko z publicznym adresem
// (sklep pobiera je sam), EAN w polu wybranym w ustawieniach firmy (`global_unique_id` albo pole meta).
// Opis idzie bez zmian (to treść firmy w jej własnym sklepie, regulamin Allegro nie obowiązuje); usuwamy tylko
// <script> i <style>.
import { wooKategorie, wooProduktPoSku, type WooGet, type WooKategoria } from '@/lib/zrodla/woo'
import type { TrescOferty } from './opis'
import { bezOgonkow } from './tekst'
import { maBledy, type ProblemOferty, type ProduktDoOferty } from './typy'
import { DOMYSLNE_USTAWIENIA_KANALOW, type UstawieniaOfertKanalow } from './ustawienia'

export interface ZrodloWooOfert {
  kategorie(): Promise<WooKategoria[]>
  /** `liczba` = ile produktów sklepu ma to SKU (brak = 1); > 1 blokuje automatyczne powiązanie. */
  produktPoSku(sku: string): Promise<{ id: number; status: string; liczba?: number } | null>
}

/** Źródło na kliencie odczytu sklepu (np. `(p, q) => new WooReadOnly(...).get(p, q)`). */
export function zrodloWooZApi(get: WooGet): ZrodloWooOfert {
  return { kategorie: () => wooKategorie(get), produktPoSku: (sku) => wooProduktPoSku(get, sku) }
}

export interface WejsciePodgladuWoo {
  produkt: ProduktDoOferty
  tresc?: TrescOferty
  /** Kategorie sklepu wybrane na ekranie (id); brak = z kategorii w karcie produktu. */
  kategorieIds?: number[]
  cenaBrutto?: number | null
}

export interface PodgladProduktuWoo {
  kanal: 'woo'
  /** `nowy` = produkt do założenia; `istnieje` = sklep ma już produkt z tym SKU (do powiązania, nie do zakładania). */
  tryb: 'nowy' | 'istnieje'
  istniejacyId: number | null
  nazwa: string
  opis: string
  krotkiOpis: string
  sku: string
  ean: string | null
  kategorie: { id: number; nazwa: string }[]
  zdjecia: string[]
  cena: { kwota: string; waluta: 'PLN' } | null
  stan: number
  status: 'draft' | 'publish'
  problemy: ProblemOferty[]
  gotowa: boolean
  /** Treść jednego elementu `create` w `POST /products/batch`. */
  szkicProduktu: Record<string, unknown>
}

const bezSkryptow = (html: string) => (html ?? '').replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '').replace(/<(script|style)\b[^>]*>/gi, '')
const klucz = (s: string) => bezOgonkow(s.trim()).replace(/[\s_]+/g, '-')

/** Kategorie z karty (nazwy albo slugi) → kategorie sklepu; zwraca dopasowane i nazwy bez odpowiednika. */
export function dopasujKategorieWoo(zKarty: string[], sklep: WooKategoria[]): { kategorie: WooKategoria[]; bezOdpowiednika: string[] } {
  const kategorie: WooKategoria[] = []
  const bezOdpowiednika: string[] = []
  for (const k of zKarty.map((x) => x.trim()).filter(Boolean)) {
    const kk = klucz(k)
    const trafienie = sklep.find((s) => s.slug === k || klucz(s.slug) === kk) ?? sklep.find((s) => klucz(s.nazwa) === kk)
    if (trafienie) {
      if (!kategorie.some((x) => x.id === trafienie.id)) kategorie.push(trafienie)
    } else bezOdpowiednika.push(k)
  }
  return { kategorie, bezOdpowiednika }
}

export async function przygotujPodgladWoo(
  wej: WejsciePodgladuWoo,
  zrodlo: ZrodloWooOfert,
  ustawienia: UstawieniaOfertKanalow = DOMYSLNE_USTAWIENIA_KANALOW,
): Promise<PodgladProduktuWoo> {
  const p = wej.produkt
  const problemy: ProblemOferty[] = []
  const sku = p.sku.trim()

  // 1. Czy sklep ma już ten produkt (SKU)
  let istniejacy: { id: number; status: string } | null = null
  if (!sku) problemy.push({ kod: 'bez_sku', waga: 'blad', komunikat: 'Produkt nie ma SKU — sklep i Kompletor łączą produkt po SKU.', pole: 'sku' })
  else {
    try {
      istniejacy = await zrodlo.produktPoSku(sku)
    } catch {
      problemy.push({ kod: 'sklep_niedostepny', waga: 'ostrzezenie', komunikat: 'Nie udało się sprawdzić, czy sklep ma już ten produkt — sprawdzimy ponownie przy wystawianiu.', pole: 'sku' })
    }
  }
  if (istniejacy)
    problemy.push({ kod: 'juz_w_sklepie', waga: 'blad', komunikat: `Sklep ma już produkt z SKU „${sku}” (nr ${istniejacy.id}) — powiąż go z produktem zamiast zakładać drugi.`, pole: 'sku' })

  // 2. Nazwa i opis
  const nazwa = (wej.tresc?.tytul?.trim() || p.nazwa).replace(/\s+/g, ' ').trim()
  if (!nazwa) problemy.push({ kod: 'tytul_pusty', waga: 'blad', komunikat: 'Produkt nie ma nazwy.', pole: 'tytul' })
  const opis = bezSkryptow(wej.tresc?.opis?.trim() ? wej.tresc.opis : (p.opis ?? '')).trim()
  if (!opis) problemy.push({ kod: 'bez_opisu', waga: 'ostrzezenie', komunikat: 'Produkt nie ma opisu — w sklepie strona produktu będzie pusta.', pole: 'opis' })
  const krotkiOpis = wej.tresc?.zajawka?.trim() ?? ''

  // 3. Kategorie sklepu
  let kategorie: { id: number; nazwa: string }[] = []
  let sklep: WooKategoria[] | null = null
  try {
    sklep = await zrodlo.kategorie()
  } catch {
    problemy.push({ kod: 'sklep_niedostepny', waga: 'ostrzezenie', komunikat: 'Nie udało się pobrać kategorii sklepu — spróbuj ponownie za chwilę.', pole: 'kategoria' })
  }
  if (wej.kategorieIds?.length) {
    const ids = [...new Set(wej.kategorieIds.filter((n) => Number.isInteger(n) && n > 0))]
    kategorie = ids.map((id) => ({ id, nazwa: sklep?.find((s) => s.id === id)?.nazwa ?? `kategoria nr ${id}` }))
    if (sklep) for (const id of ids) if (!sklep.some((s) => s.id === id)) problemy.push({ kod: 'kategoria_nie_istnieje', waga: 'blad', komunikat: `Kategorii nr ${id} nie ma w sklepie.`, pole: 'kategoria' })
  } else if (sklep) {
    const d = dopasujKategorieWoo(p.kategorieSklepu, sklep)
    kategorie = d.kategorie.map((k) => ({ id: k.id, nazwa: k.nazwa }))
    if (d.bezOdpowiednika.length)
      problemy.push({ kod: 'kategoria_sklepu_brak', waga: 'ostrzezenie', komunikat: `W sklepie nie ma kategorii: ${d.bezOdpowiednika.map((x) => `„${x}”`).join(', ')}.`, pole: 'kategoria' })
  }
  if (!kategorie.length) problemy.push({ kod: 'bez_kategorii', waga: 'ostrzezenie', komunikat: 'Produkt nie ma kategorii sklepu — trafi do kategorii domyślnej sklepu.', pole: 'kategoria' })

  // 4. Zdjęcia (sklep pobiera je z publicznego adresu)
  const zdjecia = [...new Set(p.zdjecia.map((u) => u?.trim()).filter((u): u is string => !!u))]
  const publiczne = zdjecia.filter((u) => /^https:\/\//i.test(u))
  if (!zdjecia.length) problemy.push({ kod: 'bez_zdjec', waga: 'ostrzezenie', komunikat: 'Produkt nie ma zdjęć — sklep pokaże zaślepkę.', pole: 'zdjecia' })
  else if (publiczne.length < zdjecia.length)
    problemy.push({ kod: 'zdjecie_bez_adresu', waga: 'ostrzezenie', komunikat: `${zdjecia.length - publiczne.length} z ${zdjecia.length} zdjęć nie ma publicznego adresu — sklep ich nie pobierze.`, pole: 'zdjecia' })

  // 5. Cena, stan, EAN
  const cenaBrutto = wej.cenaBrutto ?? p.cenaBrutto
  const cena = cenaBrutto !== null && cenaBrutto !== undefined && Number.isFinite(cenaBrutto) && cenaBrutto > 0 ? { kwota: cenaBrutto.toFixed(2), waluta: 'PLN' as const } : null
  if (!cena) problemy.push({ kod: 'bez_ceny', waga: 'blad', komunikat: 'Produkt nie ma ceny brutto — uzupełnij ją w karcie produktu.', pole: 'cena' })
  const stan = Math.max(0, Math.floor(p.stan || 0))
  if (stan < 1) problemy.push({ kod: 'brak_stanu', waga: 'ostrzezenie', komunikat: 'Brak towaru na stanie — w sklepie produkt będzie niedostępny.', pole: 'stan' })
  const ean = p.ean?.trim() || null
  if (!ean) problemy.push({ kod: 'bez_ean', waga: 'ostrzezenie', komunikat: 'Produkt nie ma kodu EAN (sklep go nie wymaga, ale Allegro i Empik tak).', pole: 'ean' })

  const status = ustawienia.woo.status
  const poleEan = ustawienia.woo.poleEan
  const szkicProduktu: Record<string, unknown> = {
    name: nazwa,
    type: 'simple',
    status,
    sku,
    ...(cena ? { regular_price: cena.kwota } : {}),
    description: opis,
    short_description: krotkiOpis,
    manage_stock: true,
    stock_quantity: stan,
    ...(p.wagaG && p.wagaG > 0 ? { weight: (p.wagaG / 1000).toFixed(3) } : {}),
    categories: kategorie.map((k) => ({ id: k.id })),
    images: publiczne.map((src) => ({ src })),
    ...(ean ? (poleEan === 'global_unique_id' ? { global_unique_id: ean } : { meta_data: [{ key: poleEan, value: ean }] }) : {}),
  }

  return {
    kanal: 'woo',
    tryb: istniejacy ? 'istnieje' : 'nowy',
    istniejacyId: istniejacy?.id ?? null,
    nazwa,
    opis,
    krotkiOpis,
    sku,
    ean,
    kategorie,
    zdjecia: publiczne,
    cena,
    stan,
    status,
    problemy,
    gotowa: !maBledy(problemy),
    szkicProduktu,
  }
}
