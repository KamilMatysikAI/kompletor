// Test dymny panelu po buildzie (przegląd drobne 12): bez sesji i z podrobionym ciasteczkiem żaden
// ekran nie oddaje danych, nagłówki bezpieczeństwa są na miejscu. Tylko odczyt (GET), nic nie zapisuje.
//   npm run build && npx next start -H 127.0.0.1 -p 3123   (osobno; `next start` = NODE_ENV=production, więc bez
//   BASIC_AUTH_USER/PASSWORD ustaw BASIC_AUTH_DISABLED=1, inaczej bramka z lib/basic-auth.ts odda 503)
//   npm run smoke:panel -- http://127.0.0.1:3123
const BASE = (process.argv[2] ?? 'http://127.0.0.1:3123').replace(/\/$/, '')
const SCREENS = ['/', '/pulpit', '/zamowienia', '/zamowienia?widok=do_spakowania', '/zamowienia/abc', '/produkty', '/produkty/abc', '/braki', '/rozjazdy']
const COOKIES = ['', 'kompletor_sesja=podrobione', '__Host-kompletor_sesja=podrobione']

async function main(): Promise<number> {
  const fails: string[] = []
  for (const c of COOKIES)
    for (const s of SCREENS) {
      const r = await fetch(BASE + s, { redirect: 'manual', headers: c ? { cookie: c } : {} })
      const loc = r.headers.get('location') ?? ''
      const body = await r.text()
      // bez sesji: przekierowanie na /logowanie i żadnej treści panelu w odpowiedzi
      // `/` z ciasteczkiem (choćby podrobionym) przechodzi proxy i statycznie idzie na /pulpit, a ten na /logowanie
      const okLoc = loc.endsWith('/logowanie') || (s === '/' && loc.endsWith('/pulpit'))
      if (r.status !== 307 || !okLoc) fails.push(`${s} [${c || 'bez ciasteczka'}] → ${r.status} ${loc}`)
      // tytuł strony (metadane) bywa w odpowiedzi przekierowania — szukamy treści, nie tytułu
      if (/Do zrobienia teraz|orow|zł.brutto|Wyloguj/.test(body)) fails.push(`${s} [${c || 'bez ciasteczka'}] treść panelu w odpowiedzi`)
    }
  const api = await fetch(BASE + '/api/cokolwiek', { redirect: 'manual' })
  if (api.status !== 401) fails.push(`/api/cokolwiek → ${api.status}`)
  const login = await fetch(BASE + '/logowanie')
  for (const [h, re] of [
    ['content-security-policy', /frame-ancestors 'none'.*form-action 'self'.*object-src 'none'/],
    ['x-frame-options', /DENY/],
    ['cache-control', /no-store/],
  ] as const)
    if (!re.test(login.headers.get(h) ?? '')) fails.push(`/logowanie: nagłówek ${h} = ${login.headers.get(h)}`)
  const health = await fetch(BASE + '/api/health')
  if (health.status !== 200) fails.push(`/api/health → ${health.status}`)
  for (const f of fails) console.error('[smoke] BŁĄD', f)
  console.log(`[smoke] ${SCREENS.length * COOKIES.length + 3} sprawdzeń, błędów: ${fails.length}`)
  return fails.length ? 1 : 0
}

main().then(
  (c) => process.exit(c),
  (e: unknown) => {
    console.error('[smoke] błąd:', e instanceof Error ? e.message : e)
    process.exit(1)
  },
)
