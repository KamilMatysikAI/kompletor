// zaznaczanie w kolejce pakowania per kurier („Zaznacz wszystkie na tej stronie” i „Zaznacz wszystkie tego
// kuriera” ze wszystkich stron) i zwijane sekcje kurierów. Czyste funkcje bez importów (używa ich też przeglądarka);
// testy w zaznaczenie.test.ts.

/** Klucz sekcji kuriera: przewoźnik albo „brak” (zamówienia bez przewoźnika). */
export function kluczKuriera(carrier: string | null): string {
  return carrier ?? 'brak'
}

interface GrupaId {
  carrier: string | null
  orders: readonly { id: string; status: string }[]
}

/** Zamówienia sekcji z polem zaznaczenia: bez spakowanych naprawdę (te pokazuje tylko licznik na pasku kuriera). */
export function idDoPakowania(orders: readonly { id: string; status: string }[]): string[] {
  return orders.filter((o) => o.status !== 'SPAKOWANE').map((o) => o.id)
}

/**
 * Id do spakowania każdego kuriera z całej zakładki i strefy (`wszystkie`, przed podziałem na strony), tylko dla
 * kurierów, którzy mają takie zamówienia poza stroną `strona`. Kurier w całości na stronie nie dostaje listy (przycisk
 * „wszystkie tego kuriera” nic by nie dodał).
 */
export function idsKurieraPozaStrona(wszystkie: readonly GrupaId[], strona: readonly GrupaId[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const g of wszystkie) {
    const ids = idDoPakowania(g.orders)
    const naStronie = idDoPakowania(strona.find((s) => s.carrier === g.carrier)?.orders ?? []).length
    if (ids.length > naStronie) out[kluczKuriera(g.carrier)] = ids
  }
  return out
}

/**
 * Zaznaczone zamówienia w kolejności kolejki: sekcje po kolei; w sekcji z „wszystkie tego kuriera” lista kuriera ze
 * wszystkich stron bez tych z bieżącej strony, które ktoś odznaczył; w pozostałych zaznaczone pola na stronie.
 */
export function zaznaczone(
  sekcje: readonly { klucz: string; naStronie: readonly string[]; zaznaczone: ReadonlySet<string> }[],
  caly: ReadonlySet<string>,
  wszystkie: Readonly<Record<string, readonly string[]>>,
): string[] {
  return zaznaczonePoKurierach(sekcje, caly, wszystkie).flatMap((s) => s.ids)
}

/**
 * To samo co `zaznaczone`, ale z podziałem na sekcje kurierów (liczba zaznaczonych przy
 * kurierze, także zwiniętym, i rozbicie w pasku „Zaznaczono …”). Id, które trafiło już do wcześniejszej sekcji, nie
 * liczy się drugi raz; sekcje bez zaznaczenia zostają z pustą listą.
 */
export function zaznaczonePoKurierach(
  sekcje: readonly { klucz: string; naStronie: readonly string[]; zaznaczone: ReadonlySet<string> }[],
  caly: ReadonlySet<string>,
  wszystkie: Readonly<Record<string, readonly string[]>>,
): { klucz: string; ids: string[] }[] {
  const out: { klucz: string; ids: string[] }[] = []
  const byly = new Set<string>()
  for (const s of sekcje) {
    const ids: string[] = []
    const dodaj = (id: string) => {
      if (!byly.has(id)) {
        byly.add(id)
        ids.push(id)
      }
    }
    const lista = caly.has(s.klucz) ? wszystkie[s.klucz] : undefined
    if (lista) {
      const naStronie = new Set(s.naStronie)
      for (const id of lista) if (!naStronie.has(id) || s.zaznaczone.has(id)) dodaj(id)
      // pole na stronie spoza listy (np. lista sprzed odświeżenia): też się liczy
      for (const id of s.naStronie) if (s.zaznaczone.has(id)) dodaj(id)
    } else for (const id of s.naStronie) if (s.zaznaczone.has(id)) dodaj(id)
    out.push({ klucz: s.klucz, ids })
  }
  return out
}

/**
 * Rozbicie zaznaczenia w pasku „Zaznaczono …” („DPD 3, InPost 40”): tylko gdy zaznaczenie obejmuje więcej niż
 * jednego kuriera; kolejność jak w kolejce, kurier bez etykiety pod swoim kluczem.
 */
export function rozbicieZaznaczenia(liczby: readonly { klucz: string; ile: number }[], etykiety: Readonly<Record<string, string>>): string | null {
  const z = liczby.filter((l) => l.ile > 0)
  if (z.length < 2) return null
  return z.map((l) => `${etykiety[l.klucz] || l.klucz || 'inne'} ${l.ile}`).join(', ')
}

/** Nazwa ciasteczka z rozwiniętymi sekcjami kurierów (klucze po przecinku); czyta je serwer przy renderze strony. */
export const CIASTKO_ROZWINIETE = 'pakowanie_rozwiniete'

/** Klucze rozwiniętych sekcji z wartości ciasteczka: tylko poprawne klucze, bez powtórzeń, najwyżej 30. */
export function rozwinieteZ(v: string | null | undefined): string[] {
  let t = v ?? ''
  try {
    t = decodeURIComponent(t)
  } catch {
    return []
  }
  const out: string[] = []
  for (const s of t.split(',')) {
    const k = s.trim()
    if (/^[A-Za-z0-9_]{1,30}$/.test(k) && !out.includes(k)) out.push(k)
  }
  return out.slice(0, 30)
}

/** Nowa lista rozwiniętych po kliknięciu sekcji `klucz`. */
export function przelaczRozwiniete(obecne: readonly string[], klucz: string, otwarta: boolean): string[] {
  const bez = obecne.filter((k) => k !== klucz)
  return otwarta ? [...bez, klucz] : bez
}
