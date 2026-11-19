// Przykładowe PDF wydruków magazynowych z fikcyjnymi danymi do obejrzenia i próbnego druku.
//
//   npm run wydruki:przyklady        → lib/wydruki/przyklady/*.pdf
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { etykietaProduktu, kartaZamowienia, listaWysylkowa, spisProduktow } from '../lib/wydruki'
import { ETYKIETA, KARTA, KARTA_Z_ADRESEM, LISTA, SPIS, WYDRUKOWANO, kartaDuza } from '../lib/wydruki/przyklady/dane'

async function main() {
  const katalog = path.join(process.cwd(), 'lib', 'wydruki', 'przyklady')
  await mkdir(katalog, { recursive: true })
  const pliki: [string, Promise<Buffer>][] = [
    ['karta-zamowienia.pdf', kartaZamowienia(KARTA)],
    ['karta-zamowienia-pelny-adres.pdf', kartaZamowienia(KARTA_Z_ADRESEM)], // drukujący z uprawnieniem klienci.dane
    ['karta-zamowienia-40-pozycji-na-sucho.pdf', kartaZamowienia(kartaDuza())],
    ['karta-zamowienia-jedna-pozycja-na-karte.pdf', kartaZamowienia(KARTA, { jednaPozycjaNaKarte: true })],
    ['lista-wysylkowa.pdf', listaWysylkowa(LISTA)],
    ['spis-produktow-przyprawy-i-kawy.pdf', spisProduktow(SPIS)],
    ['spis-produktow-wszystko.pdf', spisProduktow({ ...SPIS, strefa: null })],
    ['etykieta-produktu-100x50.pdf', etykietaProduktu(ETYKIETA, { utworzono: WYDRUKOWANO })],
    ['etykieta-produktu-60x40.pdf', etykietaProduktu(ETYKIETA, { szerokoscMm: 60, wysokoscMm: 40, utworzono: WYDRUKOWANO })],
  ]
  for (const [nazwa, pdf] of pliki) {
    await writeFile(path.join(katalog, nazwa), await pdf)
    console.log(`zapisano ${path.join('lib', 'wydruki', 'przyklady', nazwa)}`)
  }
}

main().catch((e: unknown) => {
  console.error(e)
  process.exit(1)
})
