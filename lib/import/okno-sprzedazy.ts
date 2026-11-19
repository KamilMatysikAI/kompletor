// Okno sprzedaży importu katalogu. `KATALOG_IMPORT_DNI_SPRZEDAZY` jest SUFITEM, nie
// podpowiedzią: żadne zadanie `import-katalogu` (harmonogram, ręczne enqueue, stary wiersz Job, przyszły przycisk
// w panelu) ani CLI nie pobierze zamówień BL z dłuższego okresu. Puste = 0 = bez odczytu zamówień BL, czyli bez danych
// klientów w procesie. Lokalnie, gdy raport mapowania ma liczyć sprzedaż, ustaw np. KATALOG_IMPORT_DNI_SPRZEDAZY=90.

export const MAX_DNI_SPRZEDAZY = 365

/** Sufit dni sprzedaży z env. Zła wartość = błąd (nie po cichu 0 ani 90). */
export function dniSprzedazyZEnv(env: Record<string, string | undefined>): number {
  const raw = (env.KATALOG_IMPORT_DNI_SPRZEDAZY ?? '').trim()
  // same cyfry: Number('1e2'), Number('0x10') czy Number('90.0') przeszłyby jako liczba całkowita
  const dni = !raw ? 0 : /^\d+$/.test(raw) ? Number(raw) : NaN
  if (!Number.isInteger(dni) || dni < 0 || dni > MAX_DNI_SPRZEDAZY)
    throw new Error(`KATALOG_IMPORT_DNI_SPRZEDAZY: liczba całkowita 0–${MAX_DNI_SPRZEDAZY} albo puste (= 0)`)
  return dni
}

/**
 * Okno dla jednego przebiegu: zadane (payload/argument) przycięte do sufitu. Brak albo nieprawidłowe zadane = sufit.
 */
export function oknoSprzedazy(zadane: unknown, sufit: number): number {
  if (typeof zadane !== 'number' || !Number.isFinite(zadane) || zadane < 0) return sufit
  return Math.min(Math.floor(zadane), sufit)
}

/** Argument `--dni` CLI w granicach sufitu; brak = sufit, więcej niż sufit = błąd z podpowiedzią. */
export function dniZArgumentu(requested: string | undefined, sufit: number): number {
  if (requested === undefined) return sufit
  const dni = /^\d+$/.test(requested.trim()) ? Number(requested) : NaN
  if (!Number.isInteger(dni) || dni < 0) throw new Error(`--dni: liczba całkowita ≥ 0 (podano „${requested}”)`)
  if (dni > sufit)
    throw new Error(`--dni ${dni} ponad sufit KATALOG_IMPORT_DNI_SPRZEDAZY=${sufit} — podnieś zmienną w .env, jeśli import ma czytać zamówienia BL`)
  return dni
}
