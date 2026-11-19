// Podkomenda `npm run cien -- faktura-robocza` (w obrazie: `node dist/cien.cjs faktura-robocza …`):
//   --zamowienie <id>             na sucho: treść roboczej złożona jak prawdziwa faktura, same pola kontrolne
//                                 (bez nazwy, adresu i NIP-u nabywcy); bez żądań do wFirmy
//   --zamowienie <id> --wykonaj   faktura robocza VAT w wFirmie (`normal_draft`, `id_external` pr/<id>, najwyżej
//                                 32 znaki); wFirma nadaje jej numer roboczy „WRF n”; tylko nabywca bez NIP-u, chyba
//                                 że także --takze-z-nip
//   --usun <docId>                usunięcie roboczej próby (tylko po świeżym odczycie: roboczy typ, numer pusty albo
//                                 „WRF n”, prefiks próby; także robocza z pierwszej próby `proba-robocza/…`)
//   --sprawdz <docId>             sam odczyt dokumentu: typ, czy ma numer, id_external (bez danych nabywcy, bez zapisu)
// <id> = identyfikator zamówienia w Kompletorze albo numer zamówienia w kanale, gdy jednoznaczny.
// Kody wyjścia: 0 = zrobione, 1 = błąd (nic nie zapisano albo usunięcie się nie powiodło), 2 = odmowa (złożenie, nabywca
// z NIP-em, bramka danych klienta, użycie), 3 = odmowa usunięcia, 4 = nie wiadomo, czy robocza powstała (nie ponawiaj
// od razu: odczekaj 5 minut, sprawdź w wFirmie, dopiero potem ponów), 5 = ALARM: dokument w wFirmie nie jest roboczą —
// ręczna kontrola w wFirmie, nie ponawiaj, polecenie niczego samo nie naprawia.
import type { PrismaClient } from '@prisma/client'
import type { OrderRecipient } from '../lib/adaptery/kontrakt'
import type { AdapterRegistry } from '../lib/adaptery/rejestr'
import { odbiorcaDoCelu } from '../lib/klienci/wejscia'
import { WFIRMA_KEYS } from '../lib/konfiguracja'
import { resolveSecrets, type SecretSource } from '../lib/sekrety'
import { nabywcaZIdentyfikatorem, type PodsumowanieRoboczej, sprawdzRobocza, staraRoboczaZamowienia, usunRobocza, wystawRobocza, zlozRobocza } from '../lib/wfirma/faktura-robocza'
import { WfirmaReadOnly } from '../lib/zrodla/wfirma'
import { WfirmaZapis } from '../lib/zrodla/wfirma-zapis'

export interface OpcjeFakturyRoboczej {
  zamowienie: string | undefined
  wykonaj: boolean
  usun: string | undefined
  /** Sam odczyt dokumentu w wFirmie. */
  sprawdz?: string | undefined
  /** Zgoda na nabywcę z NIP-em albo innym identyfikatorem podatkowym. */
  takzeZNip?: boolean
  registry: AdapterRegistry
  src: SecretSource
  /** Testy: atrapa HTTP wFirmy zamiast sieci. */
  fetch?: typeof fetch
  /** Testy: nabywca podstawiony zamiast `odbiorcaDoCelu`. */
  odbiorca?: (orderId: string) => Promise<OrderRecipient | null>
  log?: (s: string) => void
  blad?: (s: string) => void
}

const zl = (g: number) => (g / 100).toFixed(2)

export function opisPodsumowania(p: PodsumowanieRoboczej): string[] {
  const L = [
    `  typ: ${p.typ}, id_external: ${p.idExternal}, seria: ${p.seria ?? 'NIEUSTAWIONA (domyślna seria konta)'}`,
    `  forma płatności: ${p.formaPlatnosci}, ceny: ${p.rodzajCeny}, nabywca: identyfikator ${p.nabywca.rodzajIdentyfikatora}, NIP ${p.nabywca.zNip ? 'tak' : 'nie'} (dane nabywcy nie są wypisywane)`,
    `  suma brutto ${zl(p.bruttoGr)} zł, netto ${zl(p.nettoGr)} zł${p.bezPowiazaniaZMagazynem ? ', dokument bez rozchodu (magazyn prowadzi Kompletor)' : ''}`,
    `  pozycje (${p.pozycje.length}):`,
  ]
  for (const [i, x] of p.pozycje.entries()) L.push(`    ${i + 1}. ${x.nazwa} | ${x.ilosc} ${x.jednostka} × ${x.cena} | kod VAT ${x.kodVat} | towar wFirmy ${x.towarWfirmy === '0' ? 'bez powiązania' : x.towarWfirmy}`)
  return L
}

async function znajdzZamowienie(db: PrismaClient, ref: string): Promise<{ id: string; opis: string } | { blad: string }> {
  if (!/^[!-~]{1,120}$/.test(ref)) return { blad: 'zły identyfikator zamówienia' }
  const sel = { id: true, channel: true, channelAccountId: true, externalId: true } as const
  const poId = await db.order.findUnique({ where: { id: ref }, select: sel })
  const lista = poId ? [poId] : await db.order.findMany({ where: { OR: [{ externalId: ref }, { channelNumber: ref }] }, select: sel, take: 5 })
  if (!lista.length) return { blad: `nie ma zamówienia ${ref}` }
  if (lista.length > 1) return { blad: `numer ${ref} niejednoznaczny, podaj identyfikator: ${lista.map((o) => `${o.id} (${o.channel}/${o.channelAccountId})`).join(', ')}` }
  const o = lista[0]!
  return { id: o.id, opis: `${o.id} (${o.channel}/${o.channelAccountId}, nr ${o.externalId})` }
}

export async function fakturaRoboczaCli(db: PrismaClient, o: OpcjeFakturyRoboczej): Promise<number> {
  const log = o.log ?? ((s: string) => console.log(s))
  const blad = o.blad ?? ((s: string) => console.error(s))
  const tryby = [o.zamowienie, o.usun, o.sprawdz].filter((x) => !!x).length
  if (tryby !== 1 || (!o.zamowienie && (o.wykonaj || o.takzeZNip))) {
    blad('[faktura-robocza] użycie: --zamowienie <id> [--wykonaj [--takze-z-nip]] albo --usun <docId> albo --sprawdz <docId>')
    return 2
  }

  const klienci = async () => {
    const k = await resolveSecrets(db, WFIRMA_KEYS, o.src)
    if (!WFIRMA_KEYS.every((n) => k[n])) return null
    const keys = { accessKey: k['WFIRMA_ACCESS_KEY']!, secretKey: k['WFIRMA_SECRET_KEY']!, appKey: k['WFIRMA_APP_KEY']!, companyId: k['WFIRMA_COMPANY_ID']! }
    return { odczyt: new WfirmaReadOnly(keys, o.fetch ?? fetch), zapis: new WfirmaZapis(keys, o.fetch ?? fetch) }
  }

  if (o.sprawdz) {
    const k = await klienci()
    if (!k) {
      blad('[faktura-robocza] brak kluczy wFirmy w konfiguracji firmy')
      return 1
    }
    const r = await sprawdzRobocza(o.sprawdz, k.odczyt, staraRoboczaZamowienia(db))
    if (r.kind === 'BLAD') {
      blad(`[faktura-robocza] BŁĄD odczytu dokumentu ${o.sprawdz}: ${r.message}`)
      return 1
    }
    if (r.kind === 'BRAK') {
      blad(`[faktura-robocza] wFirma nie oddała dokumentu ${o.sprawdz}`)
      return 1
    }
    const d = r.dokument
    log(`[faktura-robocza] dokument ${d.id}: typ ${d.typ || 'brak'}, numer ${d.numer ?? 'brak'}, id_external ${d.idExternal || 'brak'}; robocza próby: ${r.roboczaProby ? 'tak' : 'nie'} (sam odczyt, nic nie zapisano)`)
    return 0
  }

  if (o.usun) {
    const k = await klienci()
    if (!k) {
      blad('[faktura-robocza] brak kluczy wFirmy w konfiguracji firmy')
      return 1
    }
    const w = await usunRobocza(o.usun, k, staraRoboczaZamowienia(db))
    if (w.kind === 'USUNIETA') {
      log(`[faktura-robocza] usunięta faktura robocza ${w.dokument.id} (id_external ${w.dokument.idExternal})`)
      return 0
    }
    if (w.kind === 'ODMOWA') {
      blad(`[faktura-robocza] ODMOWA usunięcia dokumentu ${o.usun}: ${w.message}. Nic nie usunięto.`)
      return 3
    }
    blad(`[faktura-robocza] BŁĄD usunięcia dokumentu ${o.usun}: ${w.message}`)
    return 1
  }

  const z = await znajdzZamowienie(db, o.zamowienie!)
  if ('blad' in z) {
    blad(`[faktura-robocza] ${z.blad}`)
    return 2
  }
  const odbiorca = o.odbiorca ?? (async (orderId: string) => (await odbiorcaDoCelu(db, orderId, 'FAKTURA', { modul: 'faktura-robocza', registry: o.registry, secrets: o.src })).odbiorca)

  if (!o.wykonaj) {
    const r = await zlozRobocza(db, z.id, odbiorca)
    if (r.kind === 'ODMOWA') {
      blad(`[faktura-robocza] zamówienie ${z.opis}: ODMOWA, faktura nie dałaby się wystawić: ${r.message}`)
      return 2
    }
    log(`[faktura-robocza] zamówienie ${z.opis}: NA SUCHO (nic nie wysłano do wFirmy; zapis: --wykonaj)`)
    for (const l of opisPodsumowania(r.podsumowanie)) log(l)
    if (nabywcaZIdentyfikatorem(r.podsumowanie)) log('  nabywca z identyfikatorem podatkowym: --wykonaj odmówi bez --takze-z-nip')
    return 0
  }

  const k = await klienci()
  if (!k) {
    blad('[faktura-robocza] brak kluczy wFirmy w konfiguracji firmy; nic nie zapisano')
    return 1
  }
  const w = await wystawRobocza(db, z.id, { ...k, odbiorca }, { takzeZNip: !!o.takzeZNip })
  switch (w.kind) {
    case 'ODMOWA':
      blad(`[faktura-robocza] zamówienie ${z.opis}: ODMOWA, nic nie wysłano: ${w.message}`)
      return 2
    case 'JUZ_JEST':
    case 'WYSTAWIONA':
      log(`[faktura-robocza] zamówienie ${z.opis}: ${w.kind === 'JUZ_JEST' ? 'robocza już jest, drugiej nie wystawiono' : 'WYSTAWIONA faktura robocza'}: dokument ${w.dokument.id}, typ ${w.dokument.typ}, numer ${w.dokument.numer ?? 'brak'} (numeracja roboczych, poza serią faktur)`)
      for (const l of opisPodsumowania(w.podsumowanie)) log(l)
      if (w.kind === 'WYSTAWIONA' && w.ostrzezenie) blad(`[faktura-robocza] !!! UWAGA: ${w.ostrzezenie}`)
      log(`  usunięcie po kontroli: faktura-robocza --usun ${w.dokument.id}`)
      return 0
    case 'ALARM':
      blad(`[faktura-robocza] !!! ALARM: zamówienie ${z.opis}, dokument(y) w wFirmie ${w.docIds.join(', ')}: ${w.message}. Nie ponawiaj --wykonaj, sprawdź dokument ${w.docIds.join(', ')} w wFirmie (PRZYCHODY » SPRZEDAŻ); polecenie niczego nie naprawia ani nie usuwa.`)
      return 5
    case 'NIEWIADOMA':
      blad(`[faktura-robocza] zamówienie ${z.opis}: NIE WIADOMO, czy robocza powstała: ${w.message}`)
      return 4
    case 'BLAD':
      blad(`[faktura-robocza] zamówienie ${z.opis}: BŁĄD: ${w.message}`)
      return 1
  }
}
