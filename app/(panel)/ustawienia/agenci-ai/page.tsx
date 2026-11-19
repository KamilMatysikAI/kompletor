// Ustawienia → Agenci AI: podłączenie agenta AI (Claude Code, Cursor, VS Code, Gemini CLI, Claude Desktop
// przez pomost) do serwera MCP tej instalacji. Adres serwera z PANEL_URL, klucz agenta (zakres `mcp:odczyt`, ten sam
// mechanizm co Klucze API), gotowe fragmenty konfiguracji, klucze agentów i ostatnie wywołania narzędzi z dziennika
// (bez treści). Tylko z uprawnieniem `ustawienia` (inni dostają 404). Bez pozycji w menu: wejście z ekranu Ustawienia.
// Odwołanie klucza zostaje na ekranie Klucze API. Sekcja „Dostawca AI” (klucze do tekstów i obrazów, model,
// wyłącznik packshotu) na tym samym ekranie, bez nowej pozycji w menu.
import Link from 'next/link'
import { requirePermission } from '@/lib/panel/kontekst'
import { listApiKeys } from '@/lib/api/zarzadzanie'
import { MCP_SCOPES } from '@/lib/api/zakresy'
import { recentMcpCalls } from '@/lib/mcp/dziennik'
import { mcpServerUrl } from '@/lib/mcp/http'
import { MCP_PROTOCOL_LATEST } from '@/lib/mcp/protokol'
import { TOOLS } from '@/lib/mcp/narzedzia'
import { HEAVY_CALLS_PER_DAY, TOOL_CALLS_PER_MINUTE } from '@/lib/mcp/limity'
import { Konfiguracje, Kopiuj, NowyKluczAgenta } from './formularz'
import { dostawcaAiFirmy, MODELE_AI, zrodloKluczaAi, zrodloKluczaObrazow } from '@/lib/ai'
import { appModeOf } from '@/lib/organizacje'
import { DostawcaAi } from './dostawca'

export const metadata = { title: 'Agenci AI' }

const atFmt = new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })

const RESULT: Record<string, { label: string; tone: string }> = {
  OK: { label: 'OK', tone: 'leaf' },
  ODMOWA: { label: 'odmowa', tone: 'red' },
  BLAD: { label: 'błąd', tone: 'amber' },
  LIMIT: { label: 'limit', tone: 'violet' },
}

export default async function AgenciAi() {
  const ctx = await requirePermission('ustawienia')
  const url = mcpServerUrl(process.env)
  const shownUrl = url ?? '<ADRES_KOMPLETORA>/api/mcp'
  const [keys, calls, ai] = await Promise.all([listApiKeys(ctx.db), recentMcpCalls(ctx.db, 50), dostawcaAiFirmy(ctx.db)])
  const src = { env: process.env, envFallback: appModeOf(process.env) === 'self-host' }
  const [zrTekst, zrObrazy] = await Promise.all([zrodloKluczaAi(ctx.db, ai.accountId, src), zrodloKluczaObrazow(ctx.db, ai.accountId, src)])
  const agentKeys = keys.filter((k) => k.scopes.some((s) => (MCP_SCOPES as readonly string[]).includes(s)))
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Agenci AI</h1>
          <div className="sub">Podłącz asystenta AI (np. Claude Code albo Cursor) do danych firmy {ctx.organization.name} — tylko do odczytu.</div>
        </div>
      </header>

      <section className="card" aria-labelledby="h-adres">
        <div className="card-head">
          <h2 id="h-adres">Adres serwera MCP</h2>
          <span className="muted small">protokół MCP {MCP_PROTOCOL_LATEST}, transport HTTP</span>
        </div>
        <div className="addr">
          <code className="mono">{shownUrl}</code>
          {url && <Kopiuj text={url} label="Kopiuj adres" />}
        </div>
        {!url && (
          <div className="banner amber" role="status" style={{ marginTop: 12 }}>
            <div>
              <b>Brak adresu instalacji.</b> Obsługa instalacji musi ustawić zmienną PANEL_URL (adres panelu, np. https://panel.example.com). Do tego czasu wpisz w miejsce
              &lt;ADRES_KOMPLETORA&gt; adres, pod którym otwierasz panel.
            </div>
          </div>
        )}
        <ul className="small" style={{ margin: '12px 0 0' }}>
          <li>Agent loguje się kluczem agenta w nagłówku Authorization: Bearer kmp_… i widzi wyłącznie dane tej firmy.</li>
          <li>Agent tylko czyta: zamówienia, stany, produkty, braki, rezerwacje i liczby dnia. Niczego nie zmienia i niczego nie wysyła do sklepów ani przewoźników.</li>
          <li>Agent nie dostaje danych klientów: imion, adresów, telefonów, e-maili ani treści wiadomości.</li>
          <li>
            Limity: {TOOL_CALLS_PER_MINUTE} wywołań narzędzi na minutę na klucz, raporty {HEAVY_CALLS_PER_DAY} razy na dobę. Każde wywołanie trafia do dziennika poniżej (bez treści).
          </li>
        </ul>
      </section>

      <section className="card" id="dostawca-ai" aria-labelledby="h-dostawca" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h2 id="h-dostawca">Dostawca AI i asystent</h2>
          <span className="muted small">podpowiedź opisu produktu, packshot i asystent „Zapytaj”</span>
        </div>
        <p className="small" style={{ marginTop: 0 }}>
          Kompletor działa bez AI. Z kluczem podpowiada opis produktu (Anthropic), robi packshot, czyli zdjęcie produktu na białym tle (Kie.ai), a po włączeniu asystenta odpowiada na pytania o obsługę panelu z Pomocy. Do AI idą tylko dane produktu, jego zdjęcie, pytanie do asystenta i fragmenty Pomocy, nigdy dane klientów.
        </p>
        <DostawcaAi model={ai.model} packshot={ai.packshot} asystent={ai.asystent} modele={MODELE_AI} tekst={zrTekst} obrazy={zrObrazy} />
      </section>

      <div style={{ marginTop: 16 }}>
        <NowyKluczAgenta url={shownUrl} />
      </div>

      <section className="card" aria-labelledby="h-konf" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h2 id="h-konf">Konfiguracja agenta</h2>
          <span className="muted small">w miejsce {'<TWÓJ_KLUCZ>'} wpisz klucz agenta</span>
        </div>
        <Konfiguracje url={shownUrl} token={null} />
      </section>

      <section className="card" aria-labelledby="h-klucze" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h2 id="h-klucze">Klucze agentów</h2>
          <span className="muted small">
            odwołanie: <Link href="/ustawienia/klucze-api">Klucze API</Link>
          </span>
        </div>
        {agentKeys.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>
            Brak kluczy agentów.
          </p>
        ) : (
          <table className="tbl cards">
            <thead>
              <tr>
                <th scope="col">Nazwa</th>
                <th scope="col">Klucz</th>
                <th scope="col">Ostatnie użycie</th>
                <th scope="col">Stan</th>
              </tr>
            </thead>
            <tbody>
              {agentKeys.map((k) => (
                <tr key={k.id}>
                  <td data-label="Nazwa">
                    <b>{k.name}</b>
                    <div className="muted small">utworzony {atFmt.format(k.createdAt)}</div>
                  </td>
                  <td data-label="Klucz" className="mono small">
                    {k.prefix}…
                  </td>
                  <td data-label="Ostatnie użycie" className="small">
                    {k.lastUsedAt ? atFmt.format(k.lastUsedAt) : <span className="muted">nieużywany</span>}
                  </td>
                  <td data-label="Stan">{k.revokedAt ? <span className="chip">odwołany {atFmt.format(k.revokedAt)}</span> : <span className="chip leaf">aktywny</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card" aria-labelledby="h-dziennik" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h2 id="h-dziennik">Ostatnie wywołania</h2>
          <span className="muted small">50 ostatnich, przechowywane 90 dni, bez treści pytań i odpowiedzi</span>
        </div>
        {calls.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>
            Agent jeszcze niczego nie sprawdzał.
          </p>
        ) : (
          <table className="tbl cards">
            <thead>
              <tr>
                <th scope="col">Kiedy</th>
                <th scope="col">Narzędzie</th>
                <th scope="col">Wynik</th>
                <th scope="col">Klucz</th>
                <th scope="col">Czas</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => (
                <tr key={c.id}>
                  <td data-label="Kiedy" className="small">
                    {atFmt.format(c.createdAt)}
                  </td>
                  <td data-label="Narzędzie">
                    <span className="mono small">{c.tool}</span>
                    {c.params.length > 0 && <div className="muted small">parametry: {c.params.join(', ')}</div>}
                  </td>
                  <td data-label="Wynik">
                    <span className={`chip ${RESULT[c.result]?.tone ?? ''}`}>{RESULT[c.result]?.label ?? c.result}</span>
                    {c.items !== null && c.result === 'OK' && <span className="muted small"> {c.items} poz.</span>}
                  </td>
                  <td data-label="Klucz" className="small">
                    {c.keyName ?? <span className="muted">panel</span>}
                    {c.keyPrefix && <div className="muted small mono">{c.keyPrefix}…</div>}
                  </td>
                  <td data-label="Czas" className="small">
                    {c.durationMs} ms
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card" aria-labelledby="h-narzedzia" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h2 id="h-narzedzia">Co agent może sprawdzić</h2>
        </div>
        <ul className="small" style={{ margin: 0 }}>
          {TOOLS.map((t) => (
            <li key={t.name}>
              <b>{t.title}</b> <span className="mono muted">{t.name}</span>
            </li>
          ))}
        </ul>
        <p className="small muted" style={{ margin: '8px 0 0' }}>
          Przykłady poleceń: „pokaż nieopłacone zamówienia z wczoraj”, „ile zostało TEST-PRZYPRAWA?”, „czego brakuje do zamówień?”. Opis krok po kroku: <Link href="/pomoc/agenci-ai">Pomoc, „Agenci AI: podłącz asystenta”</Link>.
        </p>
      </section>
    </>
  )
}
