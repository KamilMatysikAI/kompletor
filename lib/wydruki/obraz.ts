// Bramka miniatur przed doc.image (poprawki po przeglądzie, 26.10.2026).
//
// Powód: pdfkit dekoduje część PNG (kanał alfa, paleta z tRNS, przeplot) przez png-js, który woła
// zlib.inflate z callbackiem i rzuca z niego wyjątek (`if (err) throw err`, także „Invalid filter
// algorithm”). Taki wyjątek nie trafia do try/catch ani do promise wydruku, tylko do uncaughtException,
// więc zepsuty obraz z zewnątrz kładł cały proces (panel albo worker). Dlatego PNG sprawdzamy tu
// synchronicznie dokładnie w tym zakresie, w którym png-js może paść asynchronicznie: chunki, złączone
// IDAT, inflateSync z limitem wyjścia, długość danych wg colorType/bitDepth/przeplotu i bajt filtra
// każdej linii. Obraz, który nie przejdzie, = brak zdjęcia (kreskowana ramka), wydruk idzie dalej.
//
// Powód: pdfkit osadza obraz w oryginalnej rozdzielczości (`fit` tylko skaluje wyświetlanie),
// a moduł nie ma biblioteki do skalowania. Bufor powyżej MAKS_ROZMIAR_MINIATURY = brak zdjęcia.
import zlib from 'node:zlib'

/** Górny limit bufora miniatury (26.10.2026): większy plik = brak zdjęcia, karta nie puchnie. */
export const MAKS_ROZMIAR_MINIATURY = 64 * 1024
/** Górny limit wymiaru PNG w pikselach — miniatura ma ok. 28–100 px; chroni przed bombą dekompresyjną. */
const MAKS_BOK_PX = 1024

const SYGNATURA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Kanały na piksel wg colorType PNG. */
const KANALY: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
/** Dozwolone głębie bitowe wg colorType (specyfikacja PNG, tabela 11.1). */
const GLEBIE: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
/** Przejścia Adam7: x0, y0, dx, dy. */
const ADAM7: [number, number, number, number][] = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
]

/**
 * Obraz gotowy do doc.image() albo null (= brak zdjęcia). Przyjmuje JPEG (pdfkit parsuje go synchronicznie,
 * błąd łapie try/catch w miejscu rysowania) i PNG po pełnej walidacji z `pngBezpieczny`.
 */
export function obrazDoWydruku(obraz: Buffer | null | undefined): Buffer | null {
  if (!obraz || obraz.length === 0 || obraz.length > MAKS_ROZMIAR_MINIATURY) return null
  if (obraz.length >= 3 && obraz[0] === 0xff && obraz[1] === 0xd8 && obraz[2] === 0xff) return obraz
  if (obraz.subarray(0, 8).equals(SYGNATURA_PNG)) return pngBezpieczny(obraz) ? obraz : null
  return null
}

/** Długość jednej linii (bez bajtu filtra) w bajtach. */
function bajtyLinii(szerokosc: number, bitowNaPiksel: number): number {
  return Math.ceil((szerokosc * bitowNaPiksel) / 8)
}

/**
 * Czy png-js zdekoduje ten PNG bez wyjątku. Sprawdza wszystko, co png-js robi asynchronicznie
 * (inflate + filtry), i to, czego nie obsługuje poprawnie (głębia < 8 bitów na ścieżce dekodowania).
 */
export function pngBezpieczny(png: Buffer): boolean {
  try {
    let pos = 8
    let ihdr: Buffer | null = null
    let maPlte = false
    let maTrns = false
    let iend = false
    const idat: Buffer[] = []
    while (pos + 8 <= png.length) {
      const dlugosc = png.readUInt32BE(pos)
      const typ = png.toString('latin1', pos + 4, pos + 8)
      const start = pos + 8
      const koniec = start + dlugosc
      if (koniec + 4 > png.length) return false // ucięty chunk (z CRC)
      if (!ihdr && typ !== 'IHDR') return false
      if (typ === 'IHDR') {
        if (ihdr || dlugosc !== 13) return false
        ihdr = png.subarray(start, koniec)
      } else if (typ === 'PLTE') maPlte = true
      else if (typ === 'tRNS') maTrns = true
      else if (typ === 'IDAT') idat.push(png.subarray(start, koniec))
      else if (typ === 'IEND') {
        iend = true
        break
      }
      pos = koniec + 4
    }
    if (!ihdr || !iend || idat.length === 0) return false

    const szerokosc = ihdr.readUInt32BE(0)
    const wysokosc = ihdr.readUInt32BE(4)
    const glebia = ihdr[8]!
    const typKoloru = ihdr[9]!
    const przeplot = ihdr[12]!
    if (szerokosc < 1 || wysokosc < 1 || szerokosc > MAKS_BOK_PX || wysokosc > MAKS_BOK_PX) return false
    const kanaly = KANALY[typKoloru]
    if (!kanaly || !GLEBIE[typKoloru]!.includes(glebia)) return false
    if (ihdr[10] !== 0 || ihdr[11] !== 0 || (przeplot !== 0 && przeplot !== 1)) return false
    // K1-r (26.10.2026, drugi przegląd): png-js przy przeplocie i szerokości ≤ 4 px zjada bajt filtra
    // w pustych przejściach Adam7 i rzuca „Invalid filter algorithm” z callbacka (proces pada). Miniatury
    // ze sklepów prawie nigdy nie mają przeplotu, więc przeplot w całości = brak zdjęcia.
    if (ihdr[12] !== 0) return false // ścieżka Adam7 niżej zostaje na wypadek powrotu do przeplotu
    if (typKoloru === 3 && !maPlte) return false

    // png-js liczy bajty na piksel jako bity/8; przy głębi < 8 na ścieżce dekodowania (alfa z palety,
    // przeplot) wychodzą ułamki i błędne dane. Takich miniatur nie ryzykujemy.
    const dekodowanie = przeplot === 1 || (typKoloru === 3 && maTrns) || typKoloru === 4 || typKoloru === 6
    if (dekodowanie && glebia < 8) return false

    const bpp = glebia * kanaly
    const linie: number[] = [] // długość kolejnych linii (bez bajtu filtra)
    if (przeplot === 0) {
      for (let r = 0; r < wysokosc; r++) linie.push(bajtyLinii(szerokosc, bpp))
    } else {
      for (const [x0, y0, dx, dy] of ADAM7) {
        const w = Math.ceil((szerokosc - x0) / dx)
        const h = Math.ceil((wysokosc - y0) / dy)
        if (w <= 0 || h <= 0) continue
        for (let r = 0; r < h; r++) linie.push(bajtyLinii(w, bpp))
      }
    }
    const oczekiwana = linie.reduce((a, l) => a + 1 + l, 0)
    const dane = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: oczekiwana + 1 })
    if (dane.length !== oczekiwana) return false

    let p = 0
    for (const l of linie) {
      if (dane[p]! > 4) return false // png-js: „Invalid filter algorithm” rzucane z callbacka
      p += 1 + l
    }
    return true
  } catch {
    return false // zły deflate, za duże dane po dekompresji, ucięte nagłówki
  }
}
