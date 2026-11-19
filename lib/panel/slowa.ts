// Słowa zamiast wyrażeń regularnych w regułach z panelu: osoba wpisuje „kawa, przyprawa”, system
// zapisuje wzorzec `kawa|przyprawa` (każde słowo jako zwykły tekst). Wzorzec, który nie jest samą listą słów
// (np. `kaw[aiyę]` z presetu), pokazujemy jako wzorzec zaawansowany i zapisujemy bez zmian. Czyste funkcje, bez bazy
// (czyta je też formularz po stronie przeglądarki).

/** Słowa rozdzielone przecinkami → wzorzec (każde słowo jako tekst, nie wyrażenie). */
export function wzorzecZeSlow(slowa: string): string {
  return slowa
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
}

/** Wzorzec złożony z samych słów (a|b|c) → „a, b, c”; inny → null (edycja jako wzorzec). */
export function slowaZeWzorca(pattern: string): string | null {
  const czesci = pattern.split('|')
  if (!czesci.every((c) => c.length > 0 && c.trim() === c && /^[\p{L}\p{N} \-']+$/u.test(c))) return null
  return czesci.join(', ')
}

/** Wartość pola z formularza → wzorzec: tryb „słowa” albo „wzorzec” (zaawansowany, bez zmian). */
export function wzorzecZPola(tryb: string, wartosc: string): string {
  return tryb === 'wzorzec' ? wartosc.trim() : wzorzecZeSlow(wartosc)
}

/** Wzorzec z bazy → pole formularza: lista słów, gdy wzorzec to same słowa; inaczej wzorzec zaawansowany bez zmian. */
export function poleZeWzorca(pattern: string | null): { tryb: 'slowa' | 'wzorzec'; wartosc: string } {
  if (pattern === null || pattern === '') return { tryb: 'slowa', wartosc: '' }
  const s = slowaZeWzorca(pattern)
  return s === null ? { tryb: 'wzorzec', wartosc: pattern } : { tryb: 'slowa', wartosc: s }
}

/**
 * „Zamień na słowa”: tylko gdy wzorzec po rozbiciu po `|` składa się z samych słów, bez znaków
 * specjalnych. Dla `salon(u)? empik` albo `kaw[aiyę]` zwraca null: zamiana zmieniłaby dopasowanie (nawiasy stałyby
 * się zwykłym tekstem), więc przycisku nie ma, a wzorzec zostaje bez zmian.
 */
export function slowaDoZamiany(wartosc: string): string | null {
  return slowaZeWzorca(wartosc.trim())
}
