// adres zdjęcia produktu (bez zależności od fs i sharp — do komponentów klienta i serwera); także
// czysta osłona adresu zdjęcia z zewnątrz i limit zdjęć z oferty.
export type Wariant = 'o' | 'm' | 'p'
export const zdjecieUrl = (id: string, w: Wariant = 'm') => `/api/produkty/zdjecia/${id}${w === 'o' ? '' : `?w=${w}`}`

/** Ile zdjęć z jednej oferty sklepu (albo pozycji feedu) pobieramy. */
export const MAX_Z_OFERTY = 6

/**
 * Adres zdjęcia z oferty (albo feedu), który wolno pobrać: tylko https, bez danych logowania, bez adresów IP i nazw
 * wewnętrznych (localhost, *.local, *.internal). Ochrona przed pobieraniem z sieci wewnętrznej serwera. Funkcja czysta
 * (bez sieci): przeniósł ją tu z zdjecia.ts, żeby parser feedu i walidacja presetu nie ładowały sharp.
 */
export function bezpiecznyAdresZdjecia(raw: string): URL | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null
  const h = u.hostname.toLowerCase()
  if (!h.includes('.') || /^[\d.]+$/.test(h) || h.startsWith('[') || h.includes(':')) return null
  if (h === 'localhost' || /\.(local|internal|localhost|lan|home|corp)$/.test(h)) return null
  if (raw.length > 1000) return null
  return u
}
