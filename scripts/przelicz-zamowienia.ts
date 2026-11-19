// Jednorazowe przeliczenie zaległych zamówień „pozycja bez powiązania z produktem”. Zamówienia z pozycją bez
// produktu, której oferta konta jest już aktywna (np. założona importem katalogu z oknem sprzedaży BL po przyjęciu
// zamówienia), dostają produkt i rezerwację; „niezmapowana oferta” jako jedyny powód „Do wyjaśnienia” znika.
// Import katalogu robi to sam po każdym przebiegu — skrypt jest do nadrobienia od razu i do sprawdzenia stanu.
//
//   npm run przelicz:zamowienia -- [--firma <slug>] [--kanal ALLEGRO] [--konto <id>] [--zapisz]
//   w obrazie:  node dist/przelicz-zamowienia.cjs --firma <slug> [--zapisz]   (albo: kompletor przelicz-zamowienia …)
//
// Bez --zapisz: tylko liczby (na sucho), nic nie zapisuje. Wypisuje wyłącznie liczby i numery zamówień Kompletora
// z błędem — bez danych klientów. Każde zamówienie osobno: błąd jednego = linia w wyniku i kod wyjścia 1, reszta leci.
import 'dotenv/config'
import { Channel } from '@prisma/client'
import { createOrgClient, createSystemClient } from '../lib/db'
import { przeliczZalegle } from '../lib/kanaly/przeliczenie'
import { listActiveOrganizations } from '../lib/organizacje'

const CHANNELS = Object.values(Channel) as Channel[]

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<number> {
  const zapisz = process.argv.includes('--zapisz')
  const kanal = arg('--kanal')?.toUpperCase()
  const konto = arg('--konto')
  if (kanal && !CHANNELS.includes(kanal as Channel)) throw new Error(`nieznany kanał ${kanal} (dozwolone: ${CHANNELS.join(', ')})`)
  if (konto !== undefined && !/^[\x21-\x7e]{1,100}$/.test(konto)) throw new Error('zły identyfikator konta')
  const sys = createSystemClient({ poolMax: 1 })
  let org: { id: string; slug: string }
  try {
    const orgs = await listActiveOrganizations(sys)
    const slug = arg('--firma') ?? process.env['SELFHOST_ORG_SLUG']
    const found = slug ? orgs.find((o) => o.slug === slug) : orgs.length === 1 ? orgs[0] : undefined
    if (!found) throw new Error(slug ? `Nie ma aktywnej firmy ${slug}` : `Wskaż firmę (--firma), aktywnych: ${orgs.length}`)
    org = found
  } finally {
    await sys.$disconnect()
  }
  const db = createOrgClient(org.id, { poolMax: 2 })
  const bledy: string[] = []
  try {
    const w = await przeliczZalegle(db, {
      naSucho: !zapisz,
      ...(kanal ? { channel: kanal as Channel } : {}),
      ...(konto ? { channelAccountId: konto } : {}),
      onError: async (orderId, e) => {
        bledy.push(`${orderId}: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`)
      },
    })
    console.log(`firma ${org.slug}${zapisz ? '' : ' (na sucho, bez --zapisz nic nie zapisano)'}`)
    console.log(`konta z zaległymi: ${w.accounts}, oferty aktywne z zaległymi pozycjami: ${w.offers}, zamówienia do przeliczenia: ${w.orders}`)
    if (zapisz) console.log(`przeliczone: ${w.remapped}, błędy: ${w.failed}`)
    console.log(`pozycje bez produktu, dla których oferty nadal nie ma albo jest wyłączona: ${w.stillWithoutOffer}`)
    for (const b of bledy) console.log(`błąd ${b}`)
    return bledy.length ? 1 : 0
  } finally {
    await db.$disconnect()
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  },
)
