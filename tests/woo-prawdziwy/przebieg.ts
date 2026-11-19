// „Połącz z WooCommerce” na prawdziwym WordPressie + WooCommerce z Dockera (tests/woo-prawdziwy/compose.yml),
// potem odczyt i zapis adaptera Woo na tym sklepie. Nic poza stosem testowym: każde żądanie serwera idzie przez
// `lokalnyFetch`, który odmawia hostów spoza *.woo.test; przeglądarka mapuje *.woo.test na 127.0.0.1.
// Hasła (panel, WordPress) i klucze nie trafiają na wyjście: wypisujemy tylko kształt i wyniki.
//
// Wymaga: stos z compose.yml (sklep zainstalowany `sklep-init.sh`), `npm run dev -- -p <PANEL_PORT>` z PANEL_URL=https://panel.woo.test,
// firma demo (`npm run demo:panel -- --tak`), playwright-core poza repo i Chromium:
//   PLAYWRIGHT_CORE_DIR=<katalog playwright-core> CHROMIUM_EXE=<chrome.exe> WP_ADMIN_HASLO=… WYNIKI_DIR=<katalog> \
//     npx tsx tests/woo-prawdziwy/przebieg.ts
import 'dotenv/config'
import { mkdirSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { createAccountAdapter } from '../../lib/adaptery/konta'
import { defaultRegistry } from '../../lib/adaptery/domyslne'
import { generatePassword, hashPassword } from '../../lib/auth/hasla'
import { createOrgClient, createSystemClient } from '../../lib/db'
import { DEMO_EMAIL, DEMO_ORG } from '../../lib/instalacja/demo'
import { dodajKonto, kodKonta, type KontoRef } from '../../lib/kanaly/konta'
import { ustawZapisKonta } from '../../lib/kanaly/tryb'
import { WOO_AUTORYZACJA } from '../../lib/kanaly/woo-autoryzacja'
import { wykonajTestPolaczenia } from '../../lib/kanaly/zadania'
import { resolveSecrets } from '../../lib/sekrety'
import type { FetchLike } from '../../lib/zrodla/http'

const SKLEP = 'https://sklep.woo.test'
/** Warianty `_fields` (kolejność ma znaczenie przez `break 2` w WordPressie). */
const POLA_FIELDS = ['id,meta_data', 'id,meta_data.key', 'meta_data.key,id', 'id,meta_data,meta_data.key', 'meta_data.key,meta_data,id', 'meta_data,meta_data.key,id', 'id,billing.city,meta_data.key']
const PANEL = 'https://panel.woo.test'
const CADDY_PORT = Number(process.env['CADDY_PORT'] || 443)
const WYNIKI = process.env['WYNIKI_DIR'] || join(process.cwd(), 'wyniki-woo-prawdziwy')
const wynik: Record<string, unknown> = {}
const krok = (k: string, v: unknown) => {
  wynik[k] = v
  console.log(`[a199] ${k}: ${JSON.stringify(v)}`)
}

// Minimalne typy playwright-core (pakiet leży poza repo, żeby nie dokładać zależności tylko dla tego przebiegu).
interface Lokator {
  count(): Promise<number>
  click(): Promise<void>
  waitFor(): Promise<void>
  innerText(): Promise<string>
  allInnerTexts(): Promise<string[]>
  getByRole(rola: string, o: { name: RegExp }): Lokator
}
interface Strona {
  setDefaultTimeout(ms: number): void
  on(zdarzenie: 'console', cb: (m: { type(): string; text(): string }) => void): void
  on(zdarzenie: 'requestfailed', cb: (r: { method(): string; url(): string; failure(): { errorText: string } | null }) => void): void
  goto(url: string): Promise<unknown>
  fill(sel: string, v: string): Promise<void>
  click(sel: string): Promise<void>
  waitForURL(f: (u: URL) => boolean, o?: { timeout?: number }): Promise<void>
  waitForLoadState(stan: 'networkidle'): Promise<void>
  url(): string
  locator(sel: string): Lokator
  screenshot(o: { path: string; fullPage: boolean }): Promise<unknown>
}
interface Playwright {
  chromium: {
    launch(o: { executablePath?: string; args?: string[] }): Promise<{
      newContext(o: { ignoreHTTPSErrors: boolean; viewport: { width: number; height: number }; locale: string }): Promise<{ newPage(): Promise<Strona> }>
      close(): Promise<void>
    }>
  }
}

/** fetch serwera tylko do stosu testowego (*.woo.test → 127.0.0.1:CADDY_PORT, certyfikat Caddy bez zaufania). */
export const lokalnyFetch: FetchLike = (url, init) =>
  new Promise((ok, blad) => {
    const u = new URL(url)
    if (!u.hostname.endsWith('.woo.test')) return blad(new Error(`poza stosem testowym: ${u.hostname}`))
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v
    })
    const req = https.request(
      { host: '127.0.0.1', servername: u.hostname, port: CADDY_PORT, path: u.pathname + u.search, method: init?.method || 'GET', headers: { ...headers, host: u.host }, rejectUnauthorized: false },
      (r) => {
        const czesci: Buffer[] = []
        r.on('data', (c: Buffer) => czesci.push(c))
        r.on('end', () => {
          const h = new Headers()
          for (const [k, v] of Object.entries(r.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : String(v))
          const status = r.statusCode ?? 0
          ok(new Response(status === 204 || status === 304 ? null : Buffer.concat(czesci), { status, headers: h }))
        })
      },
    )
    req.on('error', blad)
    if (init?.body) req.write(typeof init.body === 'string' ? init.body : Buffer.from(init.body as ArrayBuffer))
    req.end()
  })

async function main(): Promise<number> {
  mkdirSync(WYNIKI, { recursive: true })
  const env = process.env
  const registry = defaultRegistry()
  const sys = createSystemClient({ poolMax: 2 })
  const db = createOrgClient(DEMO_ORG, { poolMax: 3 })
  const wpHaslo = env['WP_ADMIN_HASLO']
  if (!wpHaslo) throw new Error('brak WP_ADMIN_HASLO')

  // 1. konto panelu z hasłem znanym tylko temu procesowi
  const haslo = generatePassword()
  const n = await sys.user.updateMany({ where: { email: DEMO_EMAIL }, data: { passwordHash: await hashPassword(haslo), mustChangePassword: false } })
  if (n.count !== 1) throw new Error(`konto demo: ${n.count} wierszy (najpierw npm run demo:panel -- --tak)`)

  // 2. konto Woo z zapisem (adres sklepu testowego)
  const opts = { actorId: 'a199', env, registry }
  const istnieje = await db.channelConfig.findFirst({ where: { channel: 'WOO', adapterKey: 'woo.rest.zapis.v1' } })
  const ref: KontoRef = istnieje
    ? { channel: 'WOO', channelAccountId: istnieje.channelAccountId }
    : await dodajKonto(db, { adapterKey: 'woo.rest.zapis.v1', name: 'Sklep testowy (Docker)', form: { baseUrl: SKLEP } }, opts)
  const kod = kodKonta(ref)
  krok('konto', kod)

  // 3. przeglądarka
  const pw = createRequire(import.meta.url)(env['PLAYWRIGHT_CORE_DIR'] || 'playwright-core') as Playwright
  const browser = await pw.chromium.launch({
    executablePath: env['CHROMIUM_EXE'],
    args: [`--host-resolver-rules=MAP sklep.woo.test 127.0.0.1:${CADDY_PORT}, MAP panel.woo.test 127.0.0.1:${CADDY_PORT}`],
  })
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 900 }, locale: 'pl-PL' })
  const page = await ctx.newPage()
  page.setDefaultTimeout(120_000)
  const konsola: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') konsola.push(`${m.type()}: ${m.text().slice(0, 300)}`)
  })
  page.on('requestfailed', (r) => konsola.push(`requestfailed: ${r.method()} ${new URL(r.url()).origin}${new URL(r.url()).pathname} ${r.failure()?.errorText ?? ''}`))
  wynik['konsola'] = konsola
  const zrzut = async (nazwa: string) => page.screenshot({ path: join(WYNIKI, `${nazwa}.png`), fullPage: true })
  try {
    await page.goto(`${PANEL}/logowanie`)
    await page.fill('#email', DEMO_EMAIL)
    await page.fill('#haslo', haslo)
    await page.click('button[type=submit]')
    await page.waitForURL((u) => !u.pathname.startsWith('/logowanie'))
    krok('logowanie-panel', new URL(page.url()).pathname)

    const sekrety = async () => {
      const s = await resolveSecrets(db, ['WOO_CONSUMER_KEY', 'WOO_CONSUMER_SECRET', 'WOO_WRITE_KEY', 'WOO_WRITE_SECRET', WOO_AUTORYZACJA], { env, envFallback: false }, ref)
      return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, k === WOO_AUTORYZACJA ? 'jest' : `${String(v).slice(0, 3)}… (${String(v).length} zn.)`]))
    }
    const ostatniWpis = async () => {
      const a = await db.auditLog.findFirst({ where: { entityId: `WOO/${ref.channelAccountId}`, actorId: 'sklep:wc-auth' }, orderBy: { createdAt: 'desc' } })
      return a?.after ?? null
    }

    /** Jeden przebieg „Połącz”: przycisk w panelu → sklep (logowanie WP, jeśli trzeba) → Approve/Deny → powrót. */
    const polacz = async (zakres: 'read' | 'read_write', decyzja: 'approve' | 'deny', nazwa: string) => {
      await page.goto(`${PANEL}/ustawienia/kanaly/${encodeURIComponent(kod)}`)
      const karta0 = page.locator('#woo')
      const przycisk = zakres === 'read' ? karta0.getByRole('button', { name: /^Połącz( ponownie)? z WooCommerce$/ }) : karta0.getByRole('button', { name: /^(Połącz z prawem zapisu|Nowy klucz z prawem zapisu)$/ })
      const anuluj = page.locator('#woo').getByRole('button', { name: /^Anuluj$/ })
      if (await anuluj.count()) {
        // łączenie z poprzedniego przebiegu (albo po odmowie w sklepie) wciąż trwa
        await anuluj.click()
        await przycisk.waitFor()
      }
      await przycisk.click()
      try {
        await page.waitForURL((u) => u.hostname === 'sklep.woo.test', { timeout: 30_000 })
      } catch (e) {
        await zrzut(`${nazwa}-blad-przycisku`)
        const karta = (await page.locator('#woo').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 500)
        throw new Error(`konsola: ${konsola.slice(-6).join(' || ')}; przycisk nie otworzył sklepu; adres ${page.url()}; karta: ${karta}; ${e instanceof Error ? e.message.split('\n')[0] : ''}`)
      }
      const linkDoSklepu = new URL(page.url())
      if (await page.locator('input[name=username]').count()) {
        await page.fill('input[name=username]', 'wlasciciel')
        await page.fill('input[name=password]', wpHaslo)
        await page.click('button[type=submit], input[type=submit]')
      }
      await page.waitForURL((u) => u.pathname.startsWith('/wc-auth/v1/authorize'))
      await zrzut(`${nazwa}-sklep-zatwierdzenie`)
      const tekstSklepu = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 600)
      await page.click(decyzja === 'approve' ? '.wc-auth-approve' : '.wc-auth-deny')
      await page.waitForURL((u) => u.hostname === 'panel.woo.test')
      await page.waitForLoadState('networkidle')
      await zrzut(`${nazwa}-panel-po-powrocie`)
      const powrot = new URL(page.url())
      const karta = (await page.locator('#woo').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 500)
      const toast = (await page.locator('[role=status], [role=alert], .toast').allInnerTexts().catch(() => [])).join(' | ').slice(0, 300)
      krok(nazwa, {
        linkDoSklepu: { sciezka: linkDoSklepu.pathname, callback_url: linkDoSklepu.searchParams.get('callback_url'), return_url: linkDoSklepu.searchParams.get('return_url'), scope: linkDoSklepu.searchParams.get('scope') },
        tekstSklepu,
        powrot: { sciezka: powrot.pathname, woo: powrot.searchParams.get('woo'), success: powrot.searchParams.get('success'), userIdTenSam: powrot.searchParams.get('user_id') === linkDoSklepu.searchParams.get('user_id') },
        karta,
        toast,
        sekrety: await sekrety(),
        historia: await ostatniWpis(),
      })
    }

    await polacz('read', 'deny', '1-odmowa')
    await polacz('read', 'approve', '2-odczyt')
    await polacz('read_write', 'approve', '3-zapis')
  } finally {
    await browser.close()
  }

  // 4. test połączenia (zadanie zlecone po zapisie kluczy) na prawdziwym sklepie
  const t = await wykonajTestPolaczenia(db, ref, { registry, secrets: { env, envFallback: false }, fetch: lokalnyFetch })
  const st = await db.channelAccountStatus.findFirst({ where: { channel: 'WOO', channelAccountId: ref.channelAccountId } })
  krok('test-polaczenia', { t, testMetaKeys: st?.testMetaKeys ?? null })

  // 5. zapis adapterem na prawdziwym sklepie: numer nadania (meta + notatka), stan, status
  await ustawZapisKonta(db, ref, true, { ...opts, firmaZBl: false })
  const sek = { env, envFallback: false }
  const ad = (await createAccountAdapter(db, registry, await kontoUstawienia(db, ref), sek, { fetch: lokalnyFetch })) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
  const zam = await (await lokalnyFetch(`${SKLEP}/wp-json/wc/v3/orders?per_page=1`, { headers: { authorization: await basic(db, ref, env) } })).json() as { id: number; line_items: { product_id: number }[] }[]
  const zamId = String(zam[0]!.id)
  const prodId = String(zam[0]!.line_items[0]!.product_id)
  krok('zapis-numer-nadania', await ad['setTracking']!(zamId, { number: 'TEST0001A199', carrier: 'INPOST' }, 'a199-nadanie-1'))
  krok('zapis-numer-nadania-ponownie', await ad['setTracking']!(zamId, { number: 'TEST0001A199', carrier: 'INPOST' }, 'a199-nadanie-2'))
  krok('zapis-stan', await ad['pushStock']!([{ offerExternalId: prodId, qty: 7 }], 'a199-stan-1'))
  krok('zapis-status', await ad['setOrderStatus']!(zamId, 'completed', 'a199-status-1'))

  // 6. `_fields` na prawdziwym WordPressie vs atrapa (filtrujPolaWp)
  const auth = { authorization: await basic(db, ref, env) }
  const pelne = await (await lokalnyFetch(`${SKLEP}/wp-json/wc/v3/orders/${zamId}`, { headers: auth })).json()
  // pełna odpowiedź i odpowiedzi z `_fields` idą do pliku: test `fields-wp.test.ts` porównuje z nimi atrapę
  const fields: Record<string, unknown> = {}
  for (const pola of POLA_FIELDS) {
    fields[pola] = await (await lokalnyFetch(`${SKLEP}/wp-json/wc/v3/orders/${zamId}?_fields=${encodeURIComponent(pola)}`, { headers: auth })).json()
    krok(`_fields=${pola}`, fields[pola])
  }
  writeFileSync(join(WYNIKI, 'a199-fields-wp.json'), JSON.stringify({ pelne: wyczyscPelne(pelne), fields }, null, 2))
  const stan = await (await lokalnyFetch(`${SKLEP}/wp-json/wc/v3/products/${prodId}?_fields=id,stock_quantity`, { headers: auth })).json()
  const poZapisie = await (await lokalnyFetch(`${SKLEP}/wp-json/wc/v3/orders/${zamId}?_fields=id,status,meta_data`, { headers: auth })).json()
  const notatki = await (await lokalnyFetch(`${SKLEP}/wp-json/wc/v3/orders/${zamId}/notes?_fields=note,customer_note`, { headers: auth })).json()
  krok('sklep-po-zapisie', { stan, zamowienie: poZapisie, notatki })

  writeFileSync(join(WYNIKI, 'a199-przebieg.json'), JSON.stringify(wynik, null, 2))
  await db.$disconnect()
  await sys.$disconnect()
  return 0
}

/** Pełna odpowiedź zamówienia do pliku: bez adresów i _links (fikcyjne, ale niepotrzebne w porównaniu). */
function wyczyscPelne(z: unknown): unknown {
  if (!z || typeof z !== 'object') return z
  const { id, status, meta_data, billing } = z as Record<string, unknown>
  return { id, status, meta_data, billing: billing && typeof billing === 'object' ? { city: (billing as Record<string, unknown>)['city'] } : billing }
}

/** Nagłówek Basic z kluczem zapisu konta (do odczytów kontrolnych; wartość nie wychodzi z procesu). */
async function basic(db: ReturnType<typeof createOrgClient>, ref: KontoRef, env: NodeJS.ProcessEnv): Promise<string> {
  const s = await resolveSecrets(db, ['WOO_WRITE_KEY', 'WOO_WRITE_SECRET'], { env, envFallback: false }, ref)
  return `Basic ${Buffer.from(`${s['WOO_WRITE_KEY']}:${s['WOO_WRITE_SECRET']}`).toString('base64')}`
}

async function kontoUstawienia(db: ReturnType<typeof createOrgClient>, ref: KontoRef) {
  const { kontoZPayloadu } = await import('../../lib/kanaly/zadania')
  const acc = await kontoZPayloadu(db, ref)
  if (!acc) throw new Error('brak konta')
  return acc
}

main().then(
  (c) => process.exit(c),
  (e: unknown) => {
    try {
      writeFileSync(join(WYNIKI, 'a199-przebieg.json'), JSON.stringify({ ...wynik, blad: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }, null, 2))
    } catch {
      // nic
    }
    console.error('[a199] błąd:', e instanceof Error ? e.stack : e)
    process.exit(1)
  },
)
