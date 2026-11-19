// Dane klientów: rotacja kluczy i przebieg retencji z wiersza poleceń. Nic nie wypisuje wartości: tylko
// liczby i numery wersji kluczy.
//   npm run klienci -- stan --firma moja-firma                       — wpisy per wersja klucza CUSTOMER_DATA_KEYS
//   npm run klienci -- przeszyfruj --firma moja-firma                — rotacja CUSTOMER_DATA_KEYS: starsze wpisy najnowszym kluczem
//   npm run klienci -- przeszyfruj --firma moja-firma --skroty       — też przeliczenie skrótów (po zmianie CUSTOMER_LOOKUP_KEY)
//   npm run klienci -- przeszyfruj --wszystkie-firmy [--skroty]      — to samo po kolei dla każdej firmy (jej klientem, pod RLS)
//   npm run klienci -- retencja --firma moja-firma                   — przebieg retencji teraz (tryb z ustawień firmy)
//   npm run klienci -- uzupelnij --firma moja-firma [--proba] [--limit 500] [--odstep-ms 3000] [--wszystkie] [--ponow]
//                                                                    —: zadania odczytu klienta z kanału dla
//                                                                      zamówień bez danych (otwartych; --wszystkie też
//                                                                      odebranych i anulowanych; --ponow też zamówień, których
//                                                                      zadanie skończyło się bez zapisu); robi je worker z limitem tempa
import 'dotenv/config'
import { createOrgClient, createSystemClient } from '../lib/db'
import { przebiegRetencji } from '../lib/klienci/retencja'
import { uzupelnijDaneKlientow } from '../lib/klienci/uzupelnij'
import { reencryptCustomers, wersjeKluczyKlientow } from '../lib/klienci/szyfr'

const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<number> {
  const cmd = process.argv[2]
  if (!cmd || !['stan', 'przeszyfruj', 'retencja', 'uzupelnij'].includes(cmd))
    throw new Error('Użycie: klienci stan | przeszyfruj | retencja | uzupelnij --firma <slug> (przeszyfruj także --wszystkie-firmy, --skroty; uzupelnij --proba, --limit, --odstep-ms, --wszystkie, --ponow)')
  const all = process.argv.includes('--wszystkie-firmy')
  const slug = arg('--firma')
  if (!slug === !all) throw new Error('Podaj --firma <slug> albo --wszystkie-firmy')
  if (all && cmd !== 'przeszyfruj') throw new Error('--wszystkie-firmy działa tylko z przeszyfruj')
  const sys = createSystemClient({ poolMax: 1 })
  const orgs = await (all ? sys.organization.findMany({ orderBy: { slug: 'asc' } }) : sys.organization.findMany({ where: { slug } })).finally(() => sys.$disconnect())
  if (!orgs.length) throw new Error(`Nie ma firmy ${slug}`)
  let kod = 0
  for (const org of orgs) {
    const db = createOrgClient(org.id, { poolMax: 1 })
    try {
      if (cmd === 'stan') {
        const w = await wersjeKluczyKlientow(db)
        console.log(`[klienci] ${org.slug}: ${w.length ? w.map((x) => `v${x.keyVersion}: ${x.wpisy}`).join(', ') : 'brak wpisów'}`)
      } else if (cmd === 'uzupelnij') {
        const liczba = (n: string) => (arg(n) === undefined ? undefined : Number(arg(n)))
        const proba = process.argv.includes('--proba')
        const r = await uzupelnijDaneKlientow(db, { limit: liczba('--limit'), odstepMs: liczba('--odstep-ms'), wszystkie: process.argv.includes('--wszystkie'), ponow: process.argv.includes('--ponow'), proba })
        console.log(
          proba
            ? `[klienci] ${org.slug}: próba — do zaplanowania albo wznowienia: ${r.kandydaci}, już w kolejce ${r.wKolejce}, wykonane bez zapisu (bez --ponow pomijane) ${r.pominieteWykonane}`
            : `[klienci] ${org.slug}: nowe zadania ${r.zaplanowane}, wznowione ${r.wznowione}, już w kolejce ${r.wKolejce} (wykona worker; nie liczą się do --limit), wykonane bez zapisu pominięte ${r.pominieteWykonane} (--ponow je wznawia)`,
        )
      } else if (cmd === 'retencja') {
        const r = await przebiegRetencji(db, process.env, { actorId: 'system:cli' })
        console.log(`[klienci] ${org.slug}: tryb ${r.tryb}, przeliczone terminy ${r.przeliczone}, po terminie ${r.poTerminie}, usunięte ${r.usuniete}, błędy ${r.bledy}`)
        if (r.bledy) kod = 1
      } else {
        const r = await reencryptCustomers(db, org.id, process.env, { skroty: process.argv.includes('--skroty') })
        console.log(
          `[klienci] ${org.slug}: przeszyfrowane ${r.przeszyfrowane} kluczem v${r.keyVersion}, przeliczone skróty ${r.przeliczoneSkroty}, pominięte (zmienione w trakcie) ${r.pominiete}, starszym kluczem zostało ${r.pozostale}, błędy ${r.bledy} (numery zamówień wyżej)`,
        )
        if (r.pozostale || r.bledy) kod = 1
      }
    } catch (e) {
      kod = 1
      console.error(`[klienci] ${org.slug}: błąd:`, e instanceof Error ? e.message : e)
    } finally {
      await db.$disconnect()
    }
  }
  if (cmd === 'przeszyfruj')
    console.log(kod ? '[klienci] NIE usuwaj starego klucza z env: są błędy albo wpisy starszym kluczem (uruchom ponownie)' : '[klienci] wszystkie wpisy najnowszym kluczem — starą wersję można usunąć z CUSTOMER_DATA_KEYS')
  return kod
}

main().then(
  (c) => process.exit(c),
  (e: unknown) => {
    console.error('[klienci] błąd:', e instanceof Error ? e.message : e)
    process.exit(1)
  },
)
