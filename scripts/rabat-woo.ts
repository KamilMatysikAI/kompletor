// Podkomenda `npm run cien -- rabat-woo [--od RRRR-MM-DD] [--do RRRR-MM-DD] [--konto <id>] [--limit-na-minute N]
// [--limit-czasu-s N] [--wykonaj] [--firma <slug>]`, w obrazie `kompletor cien rabat-woo …`. Przeliczenie
// cen pozycji zamówień Woo zapisanych z rabatem na całe zamówienie (ujemne opłaty sklepu): opis
// i bezpieczniki w lib/kanaly/rabat-woo.ts. Bez `--od` wszystkie zamówienia Woo firmy.
// Sklep TYLKO czytany (GET jednego zamówienia przez adapter konta, domyślnie 60 na minutę, limit czasu 60 s na zamówienie).
// Domyślnie na sucho (nic nie zapisuje); `--wykonaj` zapisuje ceny, brakujący koszt wysyłki i wpis w historii zamówienia,
// a odmawia (kod 4, nic nie zapisane), gdy zamówienie do zmiany ma dokument wystawiony przez Kompletor. Na ekranie liczby,
// wewnętrzne identyfikatory zamówień Kompletora, kwoty towarów w groszach i powody — bez numerów sklepu, danych klientów
// i treści odpowiedzi sklepu.
import type { PrismaClient } from '@prisma/client'
import { createAccountAdapter, loadChannelAccounts } from '../lib/adaptery/konta'
import type { AdapterRegistry } from '../lib/adaptery/rejestr'
import type { ZamowienieWooZRabatem } from '../lib/adaptery/woo'
import { type CzytajZamowienieWoo, przeliczRabatyWoo, type WynikPrzeliczenia } from '../lib/kanaly/rabat-woo'
import type { SecretSource } from '../lib/sekrety'

const DZIEN = /^\d{4}-\d{2}-\d{2}$/

/** Początek dnia w Polsce (bez zależności od strefy serwera): RRRR-MM-DD → chwila 00:00 Europe/Warsaw. */
export function poczatekDniaPl(d: string): Date {
  if (!DZIEN.test(d)) throw new Error(`zła data „${d}” (RRRR-MM-DD)`)
  const utc = new Date(`${d}T00:00:00Z`)
  if (Number.isNaN(utc.getTime())) throw new Error(`zła data „${d}”`)
  const godz = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Warsaw', hour: '2-digit', hourCycle: 'h23' }).format(utc))
  return new Date(utc.getTime() - godz * 3_600_000)
}

interface MaOdczytRabatu {
  getOrderZRabatem(externalId: string): Promise<ZamowienieWooZRabatem | null>
}
const maOdczytRabatu = (a: unknown): a is MaOdczytRabatu => !!a && typeof (a as MaOdczytRabatu).getOrderZRabatem === 'function'

/** Odczyt przez adapter konta Woo (jeden adapter na konto, osłona z limitem tempa); konto bez takiego odczytu = błąd. */
export function czytnikWoo(db: PrismaClient, registry: AdapterRegistry, src: SecretSource): CzytajZamowienieWoo {
  const adaptery = new Map<string, Promise<MaOdczytRabatu>>()
  const adapter = (konto: string) => {
    let a = adaptery.get(konto)
    if (!a) {
      a = (async () => {
        const acc = (await loadChannelAccounts(db, { activeOnly: false })).find((x) => x.channel === 'WOO' && x.channelAccountId === konto)
        if (!acc) throw new Error(`brak konta Woo ${konto}`)
        const x = await createAccountAdapter(db, registry, acc, src)
        if (!maOdczytRabatu(x)) throw new Error(`adapter konta Woo ${konto} (${acc.adapterKey}) nie ma odczytu zamówienia z rabatem`)
        return x
      })()
      adaptery.set(konto, a)
    }
    return a
  }
  return async (konto, externalId) => (await adapter(konto)).getOrderZRabatem(externalId)
}

const zl = (g: number) => (g / 100).toFixed(2).replace('.', ',')
const lista = (ids: string[]) => ids.join(', ')

export function renderWynik(w: WynikPrzeliczenia): string {
  const L: string[] = []
  L.push(`[rabat-woo] ${w.naSucho ? 'NA SUCHO (nic nie zapisano; zapis: --wykonaj)' : w.odmowa ? 'WYKONANIE ODMÓWIONE (nic nie zapisano)' : 'WYKONANIE'}`)
  if (w.odmowa) L.push(`  ODMOWA: ${w.odmowa}`)
  L.push(`  zamówień Woo w zakresie: ${w.zamowien}, odczytanych ze sklepu: ${w.odczytanych}, brak w sklepie: ${w.brakWSklepie}, limit czasu odczytu: ${w.limitCzasu.length}, błędy: ${w.bledy.length}`)
  L.push(`  z rabatem z ujemnych opłat: ${w.zRabatem}`)
  L.push(`  do przeliczenia: ${w.doPrzeliczenia}${w.naSucho ? '' : `, przeliczone: ${w.przeliczone}`} (pozycje z kanału ${w.pozycjiKanalu}, zamienniki ${w.pozycjiZamiennikow}, pozycje paczek dodatkowych ${w.pozycjiPaczek})`)
  L.push(`    suma różnic cen × sztuki: ${zl(w.sumaRoznicGr)} zł, suma rabatu z opłat: ${zl(w.sumaRabatuGr)} zł (różnica = reszta groszy, którą dokument kładzie na pierwszą pozycję)`)
  L.push(`    w tym za pobraniem: ${w.pobranie}, z fakturą z BaseLinkera: ${w.zFakturaBl}`)
  L.push(`  z dokumentem Kompletora (wFirma albo KSeF, także szkic; lista ręczna, blokuje --wykonaj): ${w.zFakturaKompletora.length}${w.zFakturaKompletora.length ? ` — ${lista(w.zFakturaKompletora)}` : ''}`)
  L.push(`  już po rabacie (bez zmian): ${w.juzPrzeliczone}; rabat w granicach zaokrągleń (bez zmian, grosze dokłada dokument): ${w.bezZmianGrosze.length}`)
  L.push(`  koszt wysyłki do uzupełnienia: ${w.kosztWysylkiDoUzupelnienia}${w.naSucho ? '' : `, uzupełniony: ${w.kosztWysylkiUzupelniony}`}; inny niż w sklepie (bez zmiany): ${w.kosztWysylkiInny}`)
  const nieuz = Object.entries(w.kosztWysylkiNieuzupelniony)
  L.push(`  koszt wysyłki NIE uzupełniony, zamówienie niezgodne ze sklepem: ${nieuz.reduce((s, [, v]) => s + (v?.length ?? 0), 0)}`)
  for (const [powod, ids] of nieuz) L.push(`    ${powod}: ${ids!.length} — ${lista(ids!)}`)
  // wewnętrzne identyfikatory Kompletora z kwotą towarów przed i po (grosze), bez numerów sklepu i danych klientów
  L.push(`  zamówienia do zmiany (id: towary przed → po w groszach; koszt wysyłki do uzupełnienia): ${w.doZmiany.length}`)
  for (const z of w.doZmiany) L.push(`    ${z.orderId}: ${z.towaryPrzedGr} → ${z.towaryPoGr} gr, pozycji ${z.pozycji}${z.kosztWysylkiGr !== null ? `, koszt wysyłki ${z.kosztWysylkiGr} gr` : ''}`)
  const pom = Object.entries(w.pominiete)
  L.push(`  pominięte z rabatem (do ręcznego sprawdzenia): ${pom.reduce((s, [, v]) => s + (v?.length ?? 0), 0)}`)
  for (const [powod, ids] of pom) L.push(`    ${powod}: ${ids!.length} — ${lista(ids!)}`)
  if (w.bezZmianGrosze.length) L.push(`  rabat w granicach zaokrągleń: ${lista(w.bezZmianGrosze)}`)
  if (w.limitCzasu.length) L.push(`  LIMIT CZASU odczytu (pominięte, kolejny przebieg je weźmie): ${lista(w.limitCzasu)}`)
  for (const z of w.zmienioneWTrakcie) L.push(`  ZMIENIONE między odczytem a zapisem (nic nie zapisane): ${z.orderId}: ${z.powod}`)
  for (const b of w.bledy) L.push(`  BŁĄD ${b.orderId}: ${b.powod}`)
  return L.join('\n')
}

export async function rabatWooCli(db: PrismaClient, a: { od?: string; do?: string; konto?: string; wykonaj: boolean; limitNaMinute?: string; limitCzasuS?: string; registry: AdapterRegistry; src: SecretSource }): Promise<number> {
  if (a.konto !== undefined && !/^[\x21-\x7e]{1,100}$/.test(a.konto)) throw new Error('zły identyfikator konta')
  const liczba = (v: string | undefined, nazwa: string, max: number) => {
    if (v === undefined) return undefined
    const n = Number(v)
    if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${nazwa}: liczba całkowita 1–${max}`)
    return n
  }
  const limitNaMinute = liczba(a.limitNaMinute, '--limit-na-minute', 600)
  const limitCzasuS = liczba(a.limitCzasuS, '--limit-czasu-s', 600)
  const w = await przeliczRabatyWoo(db, czytnikWoo(db, a.registry, a.src), {
    naSucho: !a.wykonaj,
    ...(a.od ? { od: poczatekDniaPl(a.od) } : {}),
    ...(a.do ? { do: poczatekDniaPl(a.do) } : {}),
    ...(a.konto ? { channelAccountId: a.konto } : {}),
    ...(limitNaMinute ? { limitNaMinute } : {}),
    ...(limitCzasuS ? { limitCzasuMs: limitCzasuS * 1000 } : {}),
  })
  console.log(renderWynik(w))
  // 4 = --wykonaj odmówione (dokument Kompletora w zakresie, nic nie zapisane); 1 = błąd albo limit czasu części zamówień
  if (w.odmowa) return 4
  return w.bledy.length || w.limitCzasu.length ? 1 : 0
}
