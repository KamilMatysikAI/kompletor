// Ustawienia → Klucze API: klucze firmy dla systemów zewnętrznych (hurt-demo, EasyTools, BotKlienta).
// Lista: nazwa, początek klucza, zakresy, ostatnie użycie, „Odwołaj”; pełny klucz widać tylko raz, po utworzeniu.
// Tylko z uprawnieniem `ustawienia` (inni dostają 404). Bez pozycji w menu: wejście z ekranu Ustawienia.
import type { Channel } from '@prisma/client'
import Link from 'next/link'
import { requirePermission } from '@/lib/panel/kontekst'
import { listApiKeys } from '@/lib/api/zarzadzanie'
import { API_SCOPES } from '@/lib/api/zakresy'
import { poleKonta } from '@/lib/api/konta-klucza'
import { accountName, accounts } from '@/lib/panel/dane'
import { CHANNEL_LABEL } from '@/lib/panel/format'
import { NowyKlucz, OdwolajKlucz } from './formularz'

export const metadata = { title: 'Klucze API' }

const atFmt = new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })

const nazwaKonta = (kanal: Channel, nazwa: string) => (nazwa === CHANNEL_LABEL[kanal] ? nazwa : `${CHANNEL_LABEL[kanal]}: ${nazwa}`)

export default async function KluczeApi() {
  const ctx = await requirePermission('ustawienia')
  const [keys, accs] = await Promise.all([listApiKeys(ctx.db), accounts(ctx.db)])
  const kontaDoWyboru = accs.map((a) => ({ wartosc: poleKonta(a.channel, a.channelAccountId), nazwa: nazwaKonta(a.channel, a.name) }))
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Klucze API</h1>
          <div className="sub">Dostęp systemów zewnętrznych do stanów i zamówień firmy {ctx.organization.name}.</div>
        </div>
      </header>

      <section className="card" aria-labelledby="h-jak">
        <div className="card-head">
          <h2 id="h-jak">Jak to działa</h2>
        </div>
        <ul className="small" style={{ margin: 0 }}>
          <li>
            System wysyła klucz w nagłówku <span className="mono">Authorization: Bearer kmp_…</span> na adresy <span className="mono">/api/v1/…</span>. Klucz
            widzi wyłącznie dane tej firmy.
          </li>
          <li>
            <span className="mono">stany:odczyt</span>: stany produktów (np. sklep hurtowy), <span className="mono">zamowienia:odczyt</span>: statusy i numery
            nadania (np. chatbot obsługi klienta), <span className="mono">zamowienia:zapis</span>: dodawanie zamówień z innego systemu sprzedaży (np.
            platformy z e-bookami) z produktami z katalogu.
          </li>
          <li>Odpowiedzi nie zawierają danych osobowych: adresy, e-maile i telefony klientów Kompletor trzyma zaszyfrowane i pokazuje tylko w panelu, wg uprawnień.</li>
          <li>Klucz, który wyciekł albo nie jest już potrzebny, odwołaj — od tej chwili system dostaje odmowę. Limit: 120 żądań na minutę na klucz.</li>
          <li>
            Jak to działa krok po kroku: <Link href="/pomoc/konfiguracja#7b-klucze-api">Pomoc → Konfiguracja, „Klucze API”</Link>. Opis adresów i pól dla programisty
            systemu, który się łączy, ma administrator instalacji.
          </li>
          <li>
            Klucz dla asystenta AI (zakres <span className="mono">mcp:odczyt</span>) z gotową konfiguracją: <Link href="/ustawienia/agenci-ai">Ustawienia → Integracje i agenci AI → Agenci AI</Link>.
          </li>
        </ul>
      </section>

      <div style={{ marginTop: 16 }}>
        <NowyKlucz konta={kontaDoWyboru} />
      </div>

      <section className="card" aria-labelledby="h-lista" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h2 id="h-lista">Klucze firmy</h2>
          <span className="muted small">{keys.filter((k) => !k.revokedAt).length} aktywnych</span>
        </div>
        {keys.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>
            Brak kluczy.
          </p>
        ) : (
          <table className="tbl cards">
            <thead>
              <tr>
                <th scope="col">Nazwa</th>
                <th scope="col">Klucz</th>
                <th scope="col">Zakresy</th>
                <th scope="col">Ostatnie użycie</th>
                <th scope="col">
                  <span className="sr">Akcja</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td data-label="Nazwa">
                    <b>{k.name}</b>
                    <div className="muted small">utworzony {atFmt.format(k.createdAt)}</div>
                  </td>
                  <td data-label="Klucz" className="mono small">
                    {k.prefix}…
                  </td>
                  <td data-label="Zakresy">
                    {k.scopes.map((s) => (
                      <span className="chip" key={s} title={API_SCOPES[s]}>
                        {s}
                      </span>
                    ))}
                    {k.konta && (
                      <div className="muted small">
                        konta:{' '}
                        {k.konta.wszystkie
                          ? 'wszystkie konta firmy'
                          : k.konta.konta.length
                            ? k.konta.konta.map((x) => nazwaKonta(x.kanal, accountName(accs, x.kanal, x.konto))).join(', ')
                            : 'brak (klucz nic nie widzi)'}
                      </div>
                    )}
                  </td>
                  <td data-label="Ostatnie użycie" className="small">
                    {k.lastUsedAt ? atFmt.format(k.lastUsedAt) : <span className="muted">nieużywany</span>}
                  </td>
                  <td data-label="Akcja">
                    {k.revokedAt ? <span className="chip">odwołany {atFmt.format(k.revokedAt)}</span> : <OdwolajKlucz id={k.id} name={k.name} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  )
}
