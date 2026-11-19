// stan tabeli w adresie (sortowanie, strona, liczba wierszy), żeby odświeżenie, link i „Wstecz” dawały
// ten sam widok. Czyste funkcje: używa ich komponent `Tabela` (app/ui/tabela.tsx) i ekrany przy zapytaniu do bazy.
export type Kierunek = 'rosnaco' | 'malejaco'

export interface SortTabeli {
  klucz: string
  kierunek: Kierunek
}

export const ILE_NA_STRONE = [25, 50, 100, 250] as const

type Parametry = Record<string, string | string[] | undefined>

function jeden(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v
}

/** `?sort=kwota&kier=malejaco` → sort, tylko po dozwolonych kluczach; inaczej domyślny. */
export function sortZ(p: Parametry, dozwolone: readonly string[], domyslny: SortTabeli): SortTabeli {
  const k = jeden(p.sort)
  const d = jeden(p.kier)
  if (!k || !dozwolone.includes(k)) return domyslny
  return { klucz: k, kierunek: d === 'rosnaco' || d === 'malejaco' ? d : 'rosnaco' }
}

/** `?strona=2&ile=50` → strona (od 1) i rozmiar z listy dozwolonych. */
export function stronaZ(p: Parametry, domyslnieIle: number = ILE_NA_STRONE[1]): { strona: number; ile: number; pomin: number } {
  const ile = Number(jeden(p.ile))
  const rozmiar = (ILE_NA_STRONE as readonly number[]).includes(ile) ? ile : domyslnieIle
  const s = Math.floor(Number(jeden(p.strona)))
  const strona = Number.isFinite(s) && s >= 1 && s <= 100_000 ? s : 1
  return { strona, ile: rozmiar, pomin: (strona - 1) * rozmiar }
}

/** Adres z bieżącymi parametrami i zmianami (`undefined` usuwa parametr). Kolejność kluczy stała (sort alfabetyczny). */
export function adresZ(sciezka: string, parametry: Parametry, zmiany: Record<string, string | number | undefined>): string {
  const wynik = new Map<string, string>()
  for (const [k, v] of Object.entries(parametry)) {
    const x = jeden(v)
    if (x !== undefined && x !== '') wynik.set(k, x)
  }
  for (const [k, v] of Object.entries(zmiany)) {
    if (v === undefined || v === '') wynik.delete(k)
    else wynik.set(k, String(v))
  }
  const q = [...wynik.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
  return q.length ? `${sciezka}?${q.join('&')}` : sciezka
}

/** Adres po kliknięciu nagłówka: ta sama kolumna odwraca kierunek, inna zaczyna od rosnąco; strona wraca na 1. */
export function adresSortu(sciezka: string, parametry: Parametry, obecny: SortTabeli | undefined, klucz: string): string {
  const kierunek: Kierunek = obecny?.klucz === klucz && obecny.kierunek === 'rosnaco' ? 'malejaco' : 'rosnaco'
  return adresZ(sciezka, parametry, { sort: klucz, kier: kierunek, strona: undefined })
}

/** Liczba stron i zakres „21–40 z 133”. */
export function zakresStrony(strona: number, ile: number, razem: number): { od: number; do: number; stron: number } {
  const stron = Math.max(1, Math.ceil(razem / ile))
  const od = razem === 0 ? 0 : (strona - 1) * ile + 1
  return { od, do: Math.min(razem, strona * ile), stron }
}
