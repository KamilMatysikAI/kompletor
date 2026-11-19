// Gotowe fragmenty konfiguracji klientów MCP dla ekranu Ustawienia → Agenci AI i docs/agenci-ai.md.
// Czyste funkcje (bez bazy), używane także w komponencie klienta. Pełny klucz wstawiamy tylko w chwili utworzenia;
// potem w miejscu klucza jest KEY_PLACEHOLDER. Stan klientów (03.11.2026): które działają kluczem w nagłówku, a które
// czekają na OAuth 2.1 (osobne zadanie) — opis w docs/mcp.md, „Klienty”.

export const KEY_PLACEHOLDER = '<TWÓJ_KLUCZ>'
export const SERVER_NAME = 'kompletor'

export interface ClientConfig {
  id: 'claude-code' | 'cursor' | 'vscode' | 'gemini' | 'claude-desktop' | 'chatgpt'
  title: string
  /** `klucz` = działa dziś kluczem w nagłówku; `pomost` = przez pomost stdio; `oauth` = czeka na OAuth (wkrótce). */
  mode: 'klucz' | 'pomost' | 'oauth'
  where: string
  text: string | null
  note: string
}

const json = (v: unknown) => JSON.stringify(v, null, 2)

export function clientConfigs(url: string, key: string | null): ClientConfig[] {
  const k = key ?? KEY_PLACEHOLDER
  return [
    {
      id: 'claude-code',
      title: 'Claude Code',
      mode: 'klucz',
      where: 'Terminal, w katalogu projektu (albo z --scope user dla wszystkich projektów).',
      text: `claude mcp add --transport http ${SERVER_NAME} ${url} --header "Authorization: Bearer ${k}"`,
      note: 'Sprawdzenie: claude mcp list, potem w rozmowie /mcp.',
    },
    {
      id: 'cursor',
      title: 'Cursor',
      mode: 'klucz',
      where: 'Plik ~/.cursor/mcp.json (albo .cursor/mcp.json w projekcie).',
      text: json({ mcpServers: { [SERVER_NAME]: { url, headers: { Authorization: `Bearer ${k}` } } } }),
      note: 'Po zapisaniu: Cursor Settings → MCP, serwer „kompletor” powinien być zielony.',
    },
    {
      id: 'vscode',
      title: 'VS Code (GitHub Copilot)',
      mode: 'klucz',
      where: 'Plik .vscode/mcp.json w projekcie. Klucz VS Code zapyta raz i przechowa bezpiecznie (nie leży w pliku).',
      text: json({
        inputs: [{ type: 'promptString', id: 'kompletor-klucz', description: 'Klucz agenta Kompletora (kmp_…)', password: true }],
        servers: { [SERVER_NAME]: { type: 'http', url, headers: { Authorization: 'Bearer ${input:kompletor-klucz}' } } },
      }),
      note: 'Czat Copilota w trybie Agent widzi wtedy narzędzia Kompletora.',
    },
    {
      id: 'gemini',
      title: 'Gemini CLI',
      mode: 'klucz',
      where: 'Plik ~/.gemini/settings.json.',
      text: json({ mcpServers: { [SERVER_NAME]: { httpUrl: url, headers: { Authorization: `Bearer ${k}` } } } }),
      note: 'Sprawdzenie: /mcp w Gemini CLI.',
    },
    {
      id: 'claude-desktop',
      title: 'Claude Desktop',
      mode: 'pomost',
      where: 'Plik claude_desktop_config.json (Ustawienia → Programista → Edytuj konfigurację). Wymaga Node.js i pliku kompletor-mcp.cjs z instalacji Kompletora.',
      text: json({ mcpServers: { [SERVER_NAME]: { command: 'node', args: ['/sciezka/do/kompletor-mcp.cjs'], env: { KOMPLETOR_URL: url.replace(/\/api\/mcp$/, ''), KOMPLETOR_API_KEY: k } } } }),
      note: 'Łącznik zdalny w Claude Desktop i claude.ai (Ustawienia → Łączniki) wymaga OAuth — będzie w osobnym zadaniu. Do tego czasu pomost stdio: plik kompletor-mcp.cjs jest w obrazie Dockera instalacji własnej (skopiuj go z kontenera); w hostingu pliku do pobrania jeszcze nie ma.',
    },
    {
      id: 'chatgpt',
      title: 'ChatGPT',
      mode: 'oauth',
      where: 'Łączniki ChatGPT przyjmują serwer bez logowania albo z OAuth, nie z kluczem w nagłówku.',
      text: null,
      note: 'Wkrótce: po dodaniu logowania OAuth do Kompletora.',
    },
  ]
}
