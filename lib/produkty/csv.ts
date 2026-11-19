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
import type { PrismaClient } from '@prisma/client'
import { poleCsv } from '../zamowienia/eksport-csv'
import { checkGrupa, edytujProdukt, skuEdytowalne, VAT_LABEL, zalozProduktReczny } from './karta'

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
  { naglowek: 'Stan', pole: 'stan' },
  { naglowek: 'Opis', pole: 'opis' },
] as const

/** Tylko w eksporcie (import je pomija). */
const TYLKO_EKSPORT = ['Rodzaj', 'Źródło danych', 'Aktywny'] as const

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/[^a-z0-9]/g, '')
const PO_NAGLOWKU = new Map<string, string>(KOLUMNY.map((k) => [norm(k.naglowek), k.pole]))
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
      },
    })
    if (!partia.length) break
    po = partia[partia.length - 1]!.id
    for (const p of partia) {
      const stan = p.kind === 'STOCKED' ? p.stocks.reduce((s, x) => s + x.physical, 0) : null
      const wiersz: Record<string, string | number | null> = {
        sku: p.sku, nazwa: p.title, ean: p.ean, cena: dec(p.priceGross, 2), vat: p.vatRate, cenaZakupu: dec(p.purchasePriceNet), waga: p.weightG, dlugosc: dec(p.lengthCm),
        szerokosc: dec(p.widthCm), wysokosc: dec(p.heightCm), prog: p.lowStockThreshold, lokalizacja: p.stocks.find((s) => s.location)?.location ?? null, grupa: p.groupId, stan, opis: p.description,
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
export async function importCsv(db: PrismaClient, tekst: string, userId: string, opts: { hasWfirma: boolean }): Promise<WynikImportuCsv | { blad: string }> {
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
        const { sku: _s, stan, ...form } = pola
        void _s
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
        if (e.zmiany.length) w.zmienione++
        else w.bezZmian++
      } catch (err) {
        w.bledy.push({ linia, sku, komunikat: err instanceof Error ? `Nie udało się zapisać wiersza (${err.message.slice(0, 120)}).` : 'Nie udało się zapisać wiersza.' })
      }
    }
    return w
  }
}

export const VAT_W_PLIKU = Object.keys(VAT_LABEL).join(', ')
