// katalog produktów z pliku CSV i do pliku CSV. Ekran: Produkty → przycisk „Import i eksport CSV”.
//
// Eksport: wszystkie produkty firmy (bez danych klientów), separator „;”, BOM i przecinek dziesiętny, żeby Excel
// w polskich ustawieniach otworzył plik od razu. Kolumny takie same jak w imporcie, więc wyeksportowany plik po
// poprawkach wraca importem.
//
// Import: wiersz = produkt po SKU. SKU jest w firmie → zmiana pól przez `edytujProdukt` (te same walidacje, historia,
// pola z wFirmy tylko do odczytu); SKU nowe → nowy produkt ze stanem przez `zalozProduktReczny` (źródło „CSV”).
// Pusta komórka = pole bez zmian (import nie czyści danych). Każdy wiersz osobno: zły wiersz trafia do raportu
// z numerem linii, reszta idzie dalej. Ponowny import tego samego pliku nic nie zmienia. Kolumny „stan” (tylko nowe
// produkty: stan początkowy) i „grupa wariantów”.
// kolumna „Kategoria” = ścieżka w drzewie kategorii firmy („Napoje > Soki”). Pusta komórka nic nie zmienia,
// „(brak)” usuwa kategorię, brakujące kategorie powstają (opcja „Twórz brakujące kategorie”, domyślnie tak).
// kolumna „Aktywny” (tak / nie, jak w eksporcie) wyłącza albo włącza produkt po zapisie wiersza
// przez `ustawAktywnosc` (te same przeszkody co karta: odmowa = uwaga przy wierszu); pusta komórka nic nie zmienia.
import type { PrismaClient } from '@prisma/client'
import { poleCsv } from '../zamowienia/eksport-csv'
import { checkGrupa, edytujProdukt, skuEdytowalne, VAT_LABEL, zalozProduktReczny } from './karta'
import { opisOdmow, parsujAktywny, ustawAktywnosc } from './aktywnosc'
import { BEZ_KATEGORII, kategoriaZeSciezki, parsujSciezke, przypiszKategorie, sprawdzSciezke } from './kategorie'

export const CSV_MAKS_WIERSZY = 5000

/** Kolumny pliku: nagłówek → klucz pola formularza karty (`edytujProdukt` / `zalozProduktReczny`). */
export const KOLUMNY = [
  { naglowek: 'SKU', pole: 'sku' },
  { naglowek: 'Nazwa', pole: 'nazwa' },
  { naglowek: 'EAN', pole: 'ean' },
  { naglowek: 'Cena brutto', pole: 'cena' },
  { naglowek: 'VAT', pole: 'vat' },
  { naglowek: 'Cena zakupu netto', pole: 'cenaZakupu' },
  { naglowek: 'Waga (g)', pole: 'waga' },
  { naglowek: 'Długość (cm)', pole: 'dlugosc' },
  { naglowek: 'Szerokość (cm)', pole: 'szerokosc' },
  { naglowek: 'Wysokość (cm)', pole: 'wysokosc' },
  { naglowek: 'Próg niskiego stanu', pole: 'prog' },
  { naglowek: 'Lokalizacja', pole: 'lokalizacja' },
  { naglowek: 'Grupa wariantów', pole: 'grupa' },
  { naglowek: 'Kategoria', pole: 'kategoria' },
  { naglowek: 'Stan', pole: 'stan' },
  { naglowek: 'Opis', pole: 'opis' },
] as const

/** Na końcu eksportu; import pomija „Rodzaj” i „Źródło danych”, a „Aktywny” czyta (pole `aktywny`). */
const TYLKO_EKSPORT = ['Rodzaj', 'Źródło danych', 'Aktywny'] as const

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/[^a-z0-9]/g, '')
const PO_NAGLOWKU = new Map<string, string>(KOLUMNY.map((k) => [norm(k.naglowek), k.pole]))
PO_NAGLOWKU.set(norm('Aktywny'), 'aktywny')
// nazwy zastępcze z innych programów (np. eksport z BaseLinkera albo arkusz pisany ręcznie)
for (const [alias, pole] of [
  ['kod', 'sku'],
  ['symbol', 'sku'],
  ['nazwaproduktu', 'nazwa'],
  ['name', 'nazwa'],
  ['cena', 'cena'],
  ['price', 'cena'],
  ['stawkavat', 'vat'],
  ['waga', 'waga'],
  ['wagag', 'waga'],
  ['ean13', 'ean'],
  ['grupa', 'grupa'],
  ['ilosc', 'stan'],
  ['description', 'opis'],
  ['category', 'kategoria'],
  ['kategoriaproduktu', 'kategoria'],
  ['active', 'aktywny'],
] as const)
  PO_NAGLOWKU.set(alias, pole)

// ─── Parser CSV (RFC 4180: cudzysłowy, "" w polu, nowe linie w polu) ─────────────────────────────────────────────────

/** Separator z pierwszej linii: „;” (Excel PL), „,” albo tabulator. */
function separator(tekst: string): string {
  const linia = tekst.slice(0, tekst.search(/\r?\n|$/))
  const ile = (c: string) => linia.split(c).length - 1
  return [';', ',', '\t'].sort((a, b) => ile(b) - ile(a))[0]!
}

export function parsujCsv(tekst: string): string[][] {
  const t = tekst.replace(/^﻿/, '')
  const sep = separator(t)
  const out: string[][] = []
  let row: string[] = []
  let cell = ''
  let q = false
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!
    if (q) {
      if (c === '"' && t[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') q = false
      else cell += c
      continue
    }
    if (c === '"' && cell === '') q = true
    else if (c === sep) {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++
      row.push(cell)
      out.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (cell !== '' || row.length) {
    row.push(cell)
    out.push(row)
  }
  return out.filter((r) => r.some((x) => x.trim() !== ''))
}

/** Wartość z arkusza po neutralizacji formuły w eksporcie („'=…”) wraca bez apostrofu. */
const odFormuly = (s: string) => (/^'[=+\-@]/.test(s) ? s.slice(1) : s)

// ─── Eksport ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const RODZAJ: Record<string, string> = { STOCKED: 'ze stanem', DIGITAL: 'bez stanu', BUNDLE: 'zestaw' }
const ZRODLO: Record<string, string> = { RECZNE: 'dodany w panelu', KANAL: 'z oferty sklepu', CSV: 'z pliku CSV', BL: 'z BaseLinkera', WFIRMA: 'z wFirmy' }
const dec = (v: { toString(): string } | null, places?: number) => (v === null ? '' : (places === undefined ? String(Number(v.toString())) : Number(v.toString()).toFixed(places)).replace('.', ','))

export async function eksportCsv(db: PrismaClient): Promise<{ tekst: string; wiersze: number }> {
  const out = [[...KOLUMNY.map((k) => k.naglowek), ...TYLKO_EKSPORT].map(poleCsv).join(';')]
  let po = ''
  let n = 0
  for (;;) {
    const partia = await db.product.findMany({
      where: { id: { gt: po } },
      orderBy: { id: 'asc' },
      take: 1000,
      select: {
        id: true, sku: true, title: true, ean: true, priceGross: true, vatRate: true, purchasePriceNet: true, weightG: true, lengthCm: true, widthCm: true, heightCm: true,
        lowStockThreshold: true, groupId: true, description: true, kind: true, dataSource: true, active: true, stocks: { select: { location: true, physical: true } },
        category: { select: { path: true } },
      },
    })
    if (!partia.length) break
    po = partia[partia.length - 1]!.id
    for (const p of partia) {
      const stan = p.kind === 'STOCKED' ? p.stocks.reduce((s, x) => s + x.physical, 0) : null
      const wiersz: Record<string, string | number | null> = {
        sku: p.sku, nazwa: p.title, ean: p.ean, cena: dec(p.priceGross, 2), vat: p.vatRate, cenaZakupu: dec(p.purchasePriceNet), waga: p.weightG, dlugosc: dec(p.lengthCm),
        szerokosc: dec(p.widthCm), wysokosc: dec(p.heightCm), prog: p.lowStockThreshold, lokalizacja: p.stocks.find((s) => s.location)?.location ?? null, grupa: p.groupId, kategoria: p.category?.path ?? null, stan, opis: p.description,
      }
      out.push([...KOLUMNY.map((k) => poleCsv(wiersz[k.pole])), poleCsv(RODZAJ[p.kind]), poleCsv(ZRODLO[p.dataSource]), poleCsv(p.active ? 'tak' : 'nie')].join(';'))
      n++
    }
  }
  return { tekst: `﻿${out.join('\r\n')}\r\n`, wiersze: n }
}

// ─── Import ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface WynikImportuCsv {
  nowe: number
  zmienione: number
  bezZmian: number
  bledy: { linia: number; sku: string; komunikat: string }[]
  uwagi: { linia: number; sku: string; komunikat: string }[]
}


/** Import pliku (tekst po osłonie uploadu). Każdy wiersz osobno: błąd jednego nie cofa pozostałych. */
export async function importCsv(db: PrismaClient, tekst: string, userId: string, opts: { hasWfirma: boolean; tworzKategorie?: boolean }): Promise<WynikImportuCsv | { blad: string }> {
  const wiersze = parsujCsv(tekst)
  if (wiersze.length < 2) return { blad: 'Plik nie ma wierszy z produktami (pierwsza linia to nagłówki, np. SKU;Nazwa;Cena brutto).' }
  if (wiersze.length - 1 > CSV_MAKS_WIERSZY) return { blad: `Plik ma ${wiersze.length - 1} wierszy, a na raz najwyżej ${CSV_MAKS_WIERSZY}: podziel go na części.` }
  const naglowki = wiersze[0]!.map((h) => PO_NAGLOWKU.get(norm(h)) ?? null)
  const kolSku = naglowki.indexOf('sku')
  if (kolSku < 0) return { blad: 'Brak kolumny „SKU” w pierwszej linii pliku.' }
  const powt = naglowki.filter((h, i) => h && naglowki.indexOf(h) !== i)
  if (powt.length) return { blad: `Kolumna występuje dwa razy: ${[...new Set(powt)].join(', ')}.` }
  const tx = db
  {
    const w: WynikImportuCsv = { nowe: 0, zmienione: 0, bezZmian: 0, bledy: [], uwagi: [] }
    const widziane = new Set<string>()
    const kategorie = new Map<string, string>() // ścieżka → id w obrębie importu
    for (let i = 1; i < wiersze.length; i++) {
      const linia = i + 1
      const r = wiersze[i]!
      const pola: Record<string, string> = {}
      naglowki.forEach((h, j) => {
        const v = odFormuly((r[j] ?? '').trim())
        if (h && v !== '') pola[h] = v
      })
      const sku = pola['sku'] ?? ''
      try {
        if (!sku) {
          w.bledy.push({ linia, sku: '', komunikat: 'Brak SKU.' })
          continue
        }
        const klucz = sku.toLowerCase()
        if (widziane.has(klucz)) {
          w.bledy.push({ linia, sku, komunikat: 'To SKU jest w pliku drugi raz: wiersz pominięty.' })
          continue
        }
        widziane.add(klucz)
        const grupa = pola['grupa']
        const g = checkGrupa(grupa)
        if (!g.ok) {
          w.bledy.push({ linia, sku, komunikat: g.error })
          continue
        }
        // kategoria sprawdzona przed zapisem wiersza, ale BEZ zapisu (zła ścieżka, brak kategorii przy
        // wyłączonym tworzeniu albo limit = wiersz z błędem, nic nie zapisane). Brakujące poziomy powstają dopiero po
        // zapisie wiersza (`kategoriaWiersza`), więc odrzucony wiersz nie zostawia pustych kategorii (przegląd E1, uwaga 1).
        // undefined = bez zmian, null = „(brak)”: usuń kategorię, string = istniejąca, string[] = do założenia.
        let kat: string | null | string[] | undefined
        const katTekst = pola['kategoria']
        if (katTekst !== undefined && katTekst.toLowerCase() === BEZ_KATEGORII) kat = null
        else if (katTekst !== undefined) {
          const k = parsujSciezke(katTekst)
          const kz = k.ok && k.value ? await sprawdzSciezke(tx, k.value, { tworz: opts.tworzKategorie ?? true, pamiec: kategorie }) : null
          if (!k.ok || !kz?.ok) {
            w.bledy.push({ linia, sku, komunikat: !k.ok ? k.error : kz && !kz.ok ? kz.error : 'Zła ścieżka kategorii.' })
            continue
          }
          kat = kz.value.id ?? k.value!
        }
        const akt = parsujAktywny(pola['aktywny'])
        if (!akt.ok) {
          w.bledy.push({ linia, sku, komunikat: akt.error })
          continue
        }
        /** Flaga „Aktywny” po zapisie wiersza; odmowa (np. aktywna oferta) = uwaga, wiersz już zapisany. */
        const aktywnoscWiersza = async (productId: string): Promise<boolean> => {
          if (akt.value === undefined) return false
          const a = await ustawAktywnosc(tx, [productId], akt.value, userId)
          if (!a.ok) w.uwagi.push({ linia, sku, komunikat: `„Aktywny” bez zmian: ${a.error}` })
          else if (a.value.odmowy.length) w.uwagi.push({ linia, sku, komunikat: opisOdmow(a.value.odmowy) })
          for (const u of a.ok ? a.value.uwagi : []) w.uwagi.push({ linia, sku, komunikat: `${akt.value ? 'Włączony' : 'Wyłączony'}: ${u.komunikat}` })
          return a.ok && a.value.zmienione > 0
        }
        /** Id kategorii po zapisie wiersza (zakłada brakujące poziomy); błąd = uwaga, wiersz już zapisany. */
        const kategoriaWiersza = async (): Promise<{ ok: true; id: string | null } | { ok: false; error: string }> => {
          if (kat === null || typeof kat === 'string') return { ok: true, id: kat }
          const kz = await kategoriaZeSciezki(tx, kat!, { tworz: opts.tworzKategorie ?? true, userId, pamiec: kategorie })
          return kz.ok ? { ok: true, id: kz.value.id } : kz
        }
        const { sku: _s, stan, kategoria: _k, aktywny: _a, ...form } = pola
        void _s
        void _k
        void _a
        const jest = await tx.product.findFirst({ where: { sku: { equals: sku, mode: 'insensitive' } }, select: { id: true, dataSource: true } })
        if (!jest) {
          if (!form['nazwa']) {
            w.bledy.push({ linia, sku, komunikat: 'Nowy produkt wymaga nazwy (kolumna „Nazwa”).' })
            continue
          }
          const { grupa: _g, ...nowy } = form
          void _g
          const z = await zalozProduktReczny(tx, { rodzaj: 'zwykly', sku, stanPoczatkowy: stan, form: nowy }, userId, { hasWfirma: opts.hasWfirma })
          if (!z.ok) {
            w.bledy.push({ linia, sku, komunikat: z.error })
            continue
          }
          await tx.product.update({ where: { id: z.productId }, data: { dataSource: 'CSV', ...(g.value ? { groupId: g.value } : {}) } })
          for (const u of z.warnings) w.uwagi.push({ linia, sku, komunikat: u })
          if (kat) {
            const id = await kategoriaWiersza()
            const kz = id.ok ? await przypiszKategorie(tx, [z.productId], id.id, 'CSV', userId) : id
            if (!kz.ok) w.uwagi.push({ linia, sku, komunikat: `Produkt dodany bez kategorii: ${kz.error}` })
          }
          await aktywnoscWiersza(z.productId)
          w.nowe++
          continue
        }
        if (stan !== undefined) w.uwagi.push({ linia, sku, komunikat: 'Kolumna „Stan” dotyczy tylko nowych produktów; stan istniejącego zmienia korekta na karcie produktu.' })
        const e = await edytujProdukt(tx, jest.id, form, userId)
        if (!e.ok) {
          w.bledy.push({ linia, sku, komunikat: e.error })
          continue
        }
        if (grupa !== undefined && !skuEdytowalne(jest.dataSource)) w.uwagi.push({ linia, sku, komunikat: 'Grupa wariantów tego produktu przychodzi z BaseLinkera albo wFirmy: pominięta.' })
        for (const u of e.warnings ?? []) w.uwagi.push({ linia, sku, komunikat: u })
        let katZmieniona = false
        if (kat !== undefined) {
          const id = await kategoriaWiersza()
          const kz = id.ok ? await przypiszKategorie(tx, [jest.id], id.id, 'CSV', userId) : id
          if (!kz.ok) w.uwagi.push({ linia, sku, komunikat: `Kategoria bez zmian: ${kz.error}` })
          else katZmieniona = kz.value.zmienione > 0
        }
        const aktZmieniona = await aktywnoscWiersza(jest.id)
        if (e.zmiany.length || katZmieniona || aktZmieniona) w.zmienione++
        else w.bezZmian++
      } catch (err) {
        w.bledy.push({ linia, sku, komunikat: err instanceof Error ? `Nie udało się zapisać wiersza (${err.message.slice(0, 120)}).` : 'Nie udało się zapisać wiersza.' })
      }
    }
    return w
  }
}

export const VAT_W_PLIKU = Object.keys(VAT_LABEL).join(', ')
