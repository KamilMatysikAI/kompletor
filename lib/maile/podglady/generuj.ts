// Generuje podglądy maili z fikcyjnymi danymi: lib/maile/podglady/<rodzaj>.html i .txt.
// Uruchomienie: npm run maile:podglady (po zmianie szablonów albo układu).
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderujMail } from '../mail'
import { DANE_PRZYKLADOWE, KONTEKST_PRZYKLADOWY } from '../przyklady'
import type { RodzajMaila } from '../typy'

const katalog = dirname(fileURLToPath(import.meta.url))

function zapisz<R extends RodzajMaila>(rodzaj: R): void {
  const mail = renderujMail(rodzaj, KONTEKST_PRZYKLADOWY, DANE_PRZYKLADOWE[rodzaj])
  writeFileSync(join(katalog, `${rodzaj}.html`), mail.html)
  const zalaczniki = mail.zalaczniki.map((z) => `Załącznik: ${z.nazwaPliku} (${z.typMime}, ${z.tresc.length} B)`)
  const naglowki = [`Temat: ${mail.temat}`, `Do: ${mail.do ?? '(adres klienta)'}`, `Odpowiedź do: ${mail.odpowiedzDo}`, ...zalaczniki]
  writeFileSync(join(katalog, `${rodzaj}.txt`), `${naglowki.join('\n')}\n\n${mail.tekst}`)
  console.log(`${rodzaj}: ${mail.temat}`)
}

export function main(): void {
  mkdirSync(katalog, { recursive: true })
  zapisz('brak-platnosci')
  zapisz('nieudana-platnosc')
  zapisz('faktura')
  zapisz('gotowe-do-odbioru')
  zapisz('blad-faktury')
  zapisz('niski-stan')
  zapisz('reset-hasla')
  zapisz('zaproszenie')
  zapisz('zwrot-przyjety')
  zapisz('reklamacja-przyjeta')
  zapisz('zwrot-pieniedzy')
}

// Zapisy tylko przy uruchomieniu jako skrypt; import tego pliku niczego nie nadpisuje (zasada repo).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
