// dostawca AI firmy (Ustawienia → Agenci AI → Dostawca AI), cennik w lib/ai.ts (nieznany model = błąd,
// „czy jest klucz” bez odszyfrowania), packshot AI za wyłącznikiem. Wszystkie wywołania Kie.ai i Anthropic to atrapy;
// żaden test nie łączy się z prawdziwym dostawcą. Dane fikcyjne.
import sharp from 'sharp'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NonRetryableError } from '@/lib/bledy'
import { AI_OBRAZY_SECRET_NAME, AI_SECRET_NAME, dostawcaAiFirmy, kosztAiGrosze, kosztPackshotuGrosze, NieznanyModelAi, usunKluczAi, zapiszDostawceAi, zrodloKluczaAi, zrodloKluczaObrazow } from '@/lib/ai'
import { DEFAULT_WAREHOUSE } from '@/lib/rdzen/stan'
import { zalozProduktReczny } from '@/lib/produkty/karta'
import { maDostawceAi, podpowiedzOpis } from '@/lib/produkty/ai-opis'
import { KIE_API, KIE_KLUCZ_KEY, KIE_TASK_KEY, KIE_UPLOAD, PACKSHOT_JOB, PACKSHOT_KLUCZ_USUNIETY, stanPackshotu, zadaniePackshotu, zlecPackshot, zrodloPackshotu } from '@/lib/produkty/packshot'
import { dodajZdjecia, zdjeciaProduktu } from '@/lib/produkty/zdjecia'
import { handlers } from '@/lib/worker/zadania'
import { ORG_B, testDb, truncateAll } from './db'

const a = testDb()
const b = testDb({ organizationId: ORG_B })
const USER = 'uzytkownik-testowy-a123ai'
const ENV = { ...process.env, APP_MODE: 'self-host', AI_API_KEY: '', KIE_API_KEY: '' }
const KLUCZ = 'sk-ant-api03-' + 'x'.repeat(40)
const KIE = 'a'.repeat(32)

afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})
beforeEach(async () => {
  await truncateAll()
  await a.warehouse.create({ data: { id: DEFAULT_WAREHOUSE, name: 'Główny (test)' } })
})

describe('cennik AI', () => {
  it('koszt z narzutem, nieznany model = błąd', () => {
    // 1 mln wejścia Opusa = 4 USD × 4 zł × 1,2 = 19,20 zł
    expect(kosztAiGrosze('claude-opus-5-5', 1_000_000, 0)).toBe(1920)
    expect(kosztAiGrosze('claude-haiku-5-5', 1000, 1000)).toBe(1)
    expect(() => kosztAiGrosze('claude-nieznany-1', 10, 10)).toThrow(NieznanyModelAi)
    expect(kosztPackshotuGrosze()).toBe(10)
  })
})

describe('Dostawca AI w Ustawieniach', () => {
  it('pierwszy zapis zakłada konto AI, klucze zaszyfrowane w sekretach, historia bez wartości; walidacja wejścia', async () => {
    expect(await zapiszDostawceAi(a, { model: 'gpt-x', packshot: false, klucz: '' }, ENV, USER)).toMatchObject({ ok: false, field: 'model' })
    expect(await zapiszDostawceAi(a, { model: 'claude-haiku-5-5', packshot: false, klucz: 'moj klucz' }, ENV, USER)).toMatchObject({ ok: false, field: 'klucz' })
    expect(await zapiszDostawceAi(a, { model: 'claude-haiku-5-5', packshot: false, klucz: '', kluczObrazow: 'ab cd' }, ENV, USER)).toMatchObject({ ok: false, field: 'kluczObrazow' })
    expect(await a.channelConfig.count({ where: { channel: 'AI' } })).toBe(0)

    const r = await zapiszDostawceAi(a, { model: 'claude-haiku-5-5', packshot: 'on', klucz: KLUCZ, kluczObrazow: KIE }, ENV, USER)
    expect(r).toEqual({ ok: true, zmiany: ['konto', 'model', 'packshot', 'klucz', 'kluczObrazow'] })
    expect(await dostawcaAiFirmy(a)).toEqual({ accountId: 'ai', model: 'claude-haiku-5-5', packshot: true, asystent: false, maKonto: true })
    const sek = await a.integrationSecret.findMany({ where: { channel: 'AI' }, select: { name: true, ciphertext: true } })
    expect(sek.map((s) => s.name).sort()).toEqual([AI_SECRET_NAME, AI_OBRAZY_SECRET_NAME].sort())
    expect(Buffer.from(sek[0]!.ciphertext).toString('utf8')).not.toContain('sk-ant')
    const log = await a.auditLog.findFirstOrThrow({ where: { entity: 'ChannelConfig', entityId: 'AI/ai' }, orderBy: { createdAt: 'desc' } })
    expect(JSON.stringify(log)).not.toContain(KLUCZ)
    expect(JSON.stringify(log)).not.toContain(KIE)

    const src = { env: ENV, envFallback: true }
    expect(await zrodloKluczaAi(a, 'ai', src)).toBe('firma')
    expect(await zrodloKluczaObrazow(a, 'ai', src)).toBe('firma')
    expect(await maDostawceAi(a, ENV)).toBe(true)
    // druga firma nic z tego nie widzi
    expect(await zrodloKluczaAi(b, 'ai', src)).toBeNull()
    expect(await maDostawceAi(b, ENV)).toBe(false)

    expect(await zapiszDostawceAi(a, { model: 'claude-haiku-5-5', packshot: 'on', klucz: '' }, ENV, USER)).toEqual({ ok: true, zmiany: [] })
    expect(await usunKluczAi(a, 'obrazy', USER)).toBe(true)
    expect(await zrodloKluczaObrazow(a, 'ai', src)).toBeNull()
    expect(await stanPackshotu(a, ENV)).toBe('brak-klucza')
  })

  it('klucz z env w self-host i hostingu klucz platformy; bez klucza firmy w hostingu env AI_API_KEY nie działa', async () => {
    expect(await zrodloKluczaAi(a, 'ai', { env: { APP_MODE: 'self-host', AI_API_KEY: KLUCZ }, envFallback: true })).toBe('env')
    expect(await zrodloKluczaAi(a, 'ai', { env: { APP_MODE: 'hosted', AI_API_KEY: KLUCZ }, envFallback: false })).toBeNull()
    expect(await zrodloKluczaAi(a, 'ai', { env: { APP_MODE: 'hosted', PLATFORM_AI_API_KEY: KLUCZ }, envFallback: false })).toBe('platforma')
    expect(await zrodloKluczaObrazow(a, 'ai', { env: { APP_MODE: 'hosted', PLATFORM_KIE_API_KEY: KIE }, envFallback: false })).toBe('platforma')
  })

  it('podpowiedź opisu: nieznany model z konfiguracji = komunikat przed wywołaniem dostawcy; znany = koszt zapisany', async () => {
    await a.channelConfig.create({ data: { channel: 'AI', channelAccountId: 'ai', name: 'AI', adapterKey: 'ai.anthropic.v1', config: { model: 'claude-nieznany-9' } } })
    let wywolania = 0
    const client = {
      messages: {
        create: async () => {
          wywolania++
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Opis testowy.' }], usage: { input_tokens: 100, output_tokens: 50 } }
        },
      },
    } as never
    const env = { APP_MODE: 'self-host', AI_API_KEY: KLUCZ }
    expect(await podpowiedzOpis(a, { title: 'Przyprawa' }, env, client)).toMatchObject({ ok: false, error: expect.stringContaining('nie ma cennika') })
    expect(wywolania).toBe(0)
    await a.channelConfig.updateMany({ where: { channel: 'AI' }, data: { config: { model: 'claude-haiku-5-5' } } })
    expect(await podpowiedzOpis(a, { title: 'Przyprawa' }, env, client)).toEqual({ ok: true, opis: 'Opis testowy.' })
    expect(await a.aiUsage.findFirstOrThrow({ where: { feature: 'opis-produktu' } })).toMatchObject({ model: 'claude-haiku-5-5', inputTokens: 100, costGrosze: 0 })
  })
})

const png = (c: string) => sharp({ create: { width: 300, height: 300, channels: 3, background: c } }).png().toBuffer()

async function produktZeZdjeciem() {
  const r = await zalozProduktReczny(a, { rodzaj: 'zwykly', sku: 'PACK-1', form: { nazwa: 'Kubek do packshotu' } }, USER, { hasWfirma: false })
  if (!r.ok) throw new Error(r.error)
  const z = await dodajZdjecia(a, r.productId, [{ bytes: await png('#a52'), nazwa: 'telefon.png' }], USER)
  return { productId: r.productId, imageId: z.dodane[0]! }
}

/** Atrapa Kie.ai: upload, createTask, recordInfo (najpierw „generating”, potem wynik), pobranie obrazu wyniku. */
function atrapaKie(opts: { stan?: 'success' | 'fail' | 'generating'; status?: number; createTaskRzuca?: boolean } = {}) {
  const calls: { url: string; method: string; auth: string | null; body?: string }[] = []
  let polls = 0
  const f = (async (input: URL | string, init?: RequestInit) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    calls.push({ url, method: init?.method ?? 'GET', auth: headers.get('authorization'), body: typeof init?.body === 'string' ? init.body : undefined })
    if (opts.status && url !== 'https://wynik.example/p.png') return new Response('{}', { status: opts.status })
    if (url === KIE_UPLOAD) return Response.json({ success: true, data: { downloadUrl: 'https://pliki.example/kompletor/z.webp' } })
    if (url === `${KIE_API}/jobs/createTask`) {
      if (opts.createTaskRzuca) throw new TypeError('fetch failed (atrapa: zerwane połączenie)')
      return Response.json({ code: 200, data: { taskId: 'zad-1' } })
    }
    if (url.startsWith(`${KIE_API}/jobs/recordInfo`)) {
      polls++
      if (polls < 2 || opts.stan === 'generating') return Response.json({ data: { state: 'generating' } })
      if (opts.stan === 'fail') return Response.json({ data: { state: 'fail', failMsg: 'zły obraz' } })
      return Response.json({ data: { state: 'success', resultJson: JSON.stringify({ resultUrls: ['https://wynik.example/p.png'] }) } })
    }
    if (url === 'https://wynik.example/p.png') return new Response(new Uint8Array(await png('#fff')), { headers: { 'content-type': 'image/png' } })
    return new Response('nie ma', { status: 404 })
  }) as typeof fetch
  return { f, calls }
}

const szybko = { pollMs: 0, sleep: async () => undefined, lookup: async () => ['93.184.216.34'] }

describe('Packshot AI', () => {
  it('wyłączony albo bez klucza: zlecenie odmawia z drogą do Ustawień, nic nie trafia do kolejki', async () => {
    const { imageId } = await produktZeZdjeciem()
    expect(await zlecPackshot(a, imageId, USER, ENV)).toMatchObject({ ok: false, error: expect.stringContaining('wyłączony') })
    await zapiszDostawceAi(a, { model: 'claude-opus-5-5', packshot: 'on', klucz: '' }, ENV, USER)
    expect(await zlecPackshot(a, imageId, USER, ENV)).toMatchObject({ ok: false, error: expect.stringContaining('klucza Kie.ai') })
    expect(await a.job.count({ where: { kind: PACKSHOT_JOB } })).toBe(0)
    expect(handlers[PACKSHOT_JOB]).toBeTypeOf('function')
  })

  it('zlecenie → zadanie workera (atrapa Kie.ai): nowe zdjęcie z białym tłem, oryginał zostaje, bez dubla przy ponowieniu', async () => {
    const { productId, imageId } = await produktZeZdjeciem()
    await zapiszDostawceAi(a, { model: 'claude-opus-5-5', packshot: 'on', klucz: '', kluczObrazow: KIE }, ENV, USER)
    expect(await zlecPackshot(a, imageId, USER, ENV)).toEqual({ ok: true, juzJest: false })
    const job = await a.job.findFirstOrThrow({ where: { kind: PACKSHOT_JOB } })
    expect(job.payload).toEqual({ productId, imageId, actorId: USER })

    const k = atrapaKie()
    const nowe = await zadaniePackshotu(a, job.payload, { ...szybko, fetch: k.f, env: ENV })
    expect(nowe).toBeTruthy()
    const z = await zdjeciaProduktu(a, productId)
    expect(z.map((x) => x.id)).toEqual([imageId, nowe])
    expect(z[1]!.sourceUrl).toBe(zrodloPackshotu(imageId))
    expect(k.calls.filter((c) => c.url.startsWith('https://api.kie.ai') || c.url === KIE_UPLOAD).every((c) => c.auth === `Bearer ${KIE}`)).toBe(true)
    const zad = JSON.parse(k.calls.find((c) => c.url.endsWith('/jobs/createTask'))!.body!)
    expect(zad).toMatchObject({ model: 'nano-banana-2-1', input: { image_input: ['https://pliki.example/kompletor/z.webp'], aspect_ratio: '1:1' } })
    expect(zad.input.prompt).toContain('PURE WHITE')
    expect(await a.aiUsage.findFirstOrThrow({ where: { feature: 'packshot' } })).toMatchObject({ costGrosze: 0 })

    // ponowienie i drugie zlecenie: bez dubla, bez wywołań
    const k2 = atrapaKie()
    expect(await zadaniePackshotu(a, job.payload, { ...szybko, fetch: k2.f, env: ENV })).toBeNull()
    expect(k2.calls).toHaveLength(0)
    expect(await zlecPackshot(a, imageId, USER, ENV)).toEqual({ ok: true, juzJest: true })
    expect(await zlecPackshot(a, nowe!, USER, ENV)).toMatchObject({ ok: false, error: expect.stringContaining('już packshotem') })
  })

  it('błąd dostawcy (zły klucz, odmowa generowania): wpis w historii produktu, błąd zadania bez ponowień, nic nie dodane', async () => {
    const { productId, imageId } = await produktZeZdjeciem()
    await zapiszDostawceAi(a, { model: 'claude-opus-5-5', packshot: 'on', klucz: '', kluczObrazow: KIE }, ENV, USER)
    const payload = { productId, imageId, actorId: USER }
    await expect(zadaniePackshotu(a, payload, { ...szybko, fetch: atrapaKie({ status: 401 }).f, env: ENV })).rejects.toThrow(/zły klucz/)
    await expect(zadaniePackshotu(a, payload, { ...szybko, fetch: atrapaKie({ stan: 'fail' }).f, env: ENV })).rejects.toThrow(/zły obraz/)
    expect(await zdjeciaProduktu(a, productId)).toHaveLength(1)
    expect(await a.auditLog.count({ where: { entityId: productId, actorId: 'system:packshot' } })).toBe(2)
  })

  it('ponowne kliknięcie po nieudanym packshocie zakłada nowe zadanie (klucz kolejki zwolniony przy błędzie), w kolejce = bez dubla', async () => {
    const { imageId } = await produktZeZdjeciem()
    await zapiszDostawceAi(a, { model: 'claude-opus-5-5', packshot: 'on', klucz: '', kluczObrazow: KIE }, ENV, USER)
    await zlecPackshot(a, imageId, USER, ENV)
    await zlecPackshot(a, imageId, USER, ENV)
    expect(await a.job.count({ where: { kind: PACKSHOT_JOB } })).toBe(1)
    // tak jak `fail()` w kolejce: FAILED z wyzerowanym kluczem (osobna gałąź „reset FAILED” usunięta jako martwa)
    await a.job.updateMany({ where: { kind: PACKSHOT_JOB }, data: { status: 'FAILED', attempts: 2, lastError: 'brak kredytów', dedupeKey: null } })
    expect(await zlecPackshot(a, imageId, USER, ENV)).toEqual({ ok: true, juzJest: false })
    expect(await a.job.count({ where: { kind: PACKSHOT_JOB } })).toBe(2)
    expect(await a.job.findFirstOrThrow({ where: { kind: PACKSHOT_JOB, status: 'PENDING' } })).toMatchObject({ attempts: 0, lastError: null, dedupeKey: `packshot:${imageId}`, maxAttempts: 2 })
  })

  it('wynik od dostawcy pod adresem wewnętrznym = odmowa pobrania', async () => {
    const { productId, imageId } = await produktZeZdjeciem()
    await zapiszDostawceAi(a, { model: 'claude-opus-5-5', packshot: 'on', klucz: '', kluczObrazow: KIE }, ENV, USER)
    const k = atrapaKie()
    await expect(zadaniePackshotu(a, { productId, imageId }, { ...szybko, lookup: async () => ['10.0.0.7'], fetch: k.f, env: ENV })).rejects.toThrow(/sieć wewnętrzną/)
    expect(k.calls.some((c) => c.url === 'https://wynik.example/p.png')).toBe(false)
  })
})

// ─── Poprawki: ponowienie bez drugiego płatnego zlecenia, koszt nie ginie po
// cichu, limit klucza platformy. Wszystko na atrapach Kie.ai i Anthropic.

const createTasks = (k: { calls: { url: string }[] }) => k.calls.filter((c) => c.url === `${KIE_API}/jobs/createTask`).length
const uploads = (k: { calls: { url: string }[] }) => k.calls.filter((c) => c.url === KIE_UPLOAD).length

/**
 * Klient firmy `a` z jedną padającą operacją (symulacja chwilowej utraty połączenia z bazą). Podmiana na tym samym
 * obiekcie (nie Proxy), bo rejestr klientów firm (lib/db.ts) rozpoznaje klienta po tożsamości. Zwraca przywrócenie.
 */
function awariaBazy(co: 'transakcja' | 'aiUsageCreate'): () => void {
  const blad = async () => Promise.reject(new Error('atrapa: połączenie z bazą zerwane'))
  const cel = (co === 'transakcja' ? a : a.aiUsage) as unknown as Record<string, unknown>
  const klucz = co === 'transakcja' ? '$transaction' : 'create'
  const stare = cel[klucz]
  cel[klucz] = blad
  if (cel[klucz] !== blad) throw new Error(`atrapa awarii bazy: nie da się podmienić ${klucz}`)
  return () => {
    cel[klucz] = stare
  }
}

describe('Packshot AI: ponowienie bez drugiego zlecenia', () => {
  async function zadanieWKolejce() {
    const { productId, imageId } = await produktZeZdjeciem()
    await zapiszDostawceAi(a, { model: 'claude-opus-5-5', packshot: 'on', klucz: '', kluczObrazow: KIE }, ENV, USER)
    expect(await zlecPackshot(a, imageId, USER, ENV)).toEqual({ ok: true, juzJest: false })
    const job = await a.job.findFirstOrThrow({ where: { kind: PACKSHOT_JOB } })
    return { productId, imageId, job }
  }

  it('Kie.ai ciągle „generating”: pierwsza próba zapisuje id zadania i koszt, druga tylko odpytuje; razem jedno createTask', async () => {
    const { productId, job } = await zadanieWKolejce()
    const k = atrapaKie({ stan: 'generating' })
    const opts = { ...szybko, pollMax: 2, fetch: k.f, env: ENV }

    const e1 = await zadaniePackshotu(a, job.payload, { ...opts, job: { id: job.id, attempts: 1, maxAttempts: 2 } }).catch((e: unknown) => e)
    expect(e1).toBeInstanceOf(Error)
    expect(e1).not.toBeInstanceOf(NonRetryableError) // kolejka ponowi, ale ponowienie nic nie zleca
    expect(String(e1)).toMatch(/bez nowego zlecenia/)
    expect(createTasks(k)).toBe(1)
    const poPierwszej = await a.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(poPierwszej.payload).toMatchObject({ productId, [KIE_TASK_KEY]: 'zad-1' })
    expect(await a.aiUsage.count({ where: { feature: 'packshot' } })).toBe(1) // koszt zapisany od razu po zleceniu

    // druga (ostatnia) próba: payload z bazy, jak po claimNext
    const e2 = await zadaniePackshotu(a, poPierwszej.payload, { ...opts, job: { id: job.id, attempts: 2, maxAttempts: 2 } }).catch((e: unknown) => e)
    expect(e2).toBeInstanceOf(NonRetryableError)
    expect(String(e2)).toMatch(/wyznaczonym czasie \(zadanie zad-1\)/)
    expect(createTasks(k)).toBe(1)
    expect(uploads(k)).toBe(1)
    expect(await a.aiUsage.count({ where: { feature: 'packshot' } })).toBe(1)
    const hist = await a.auditLog.findMany({ where: { entityId: productId, actorId: 'system:packshot' } })
    expect(hist.map((h) => JSON.stringify(h.after)).join()).toContain('wyznaczonym czasie')
  })

  it('wynik dochodzi przy ponowieniu: odbiór zapisanego zadania bez uploadu i bez createTask, koszt raz', async () => {
    const { productId, imageId, job } = await zadanieWKolejce()
    const k1 = atrapaKie({ stan: 'generating' })
    await expect(zadaniePackshotu(a, job.payload, { ...szybko, pollMax: 1, fetch: k1.f, env: ENV, job: { id: job.id, attempts: 1, maxAttempts: 2 } })).rejects.not.toBeInstanceOf(NonRetryableError)
    const payload = (await a.job.findUniqueOrThrow({ where: { id: job.id } })).payload

    const k2 = atrapaKie()
    // wyłącznik zdjęty między próbami: odbiór opłaconego wyniku dalej działa (odpytanie nic nie kosztuje)
    await a.channelConfig.updateMany({ where: { channel: 'AI' }, data: { config: { model: 'claude-opus-5-5', packshot: false } } })
    const nowe = await zadaniePackshotu(a, payload, { ...szybko, fetch: k2.f, env: ENV, job: { id: job.id, attempts: 2, maxAttempts: 2 } })
    expect(nowe).toBeTruthy()
    expect(uploads(k2)).toBe(0)
    expect(createTasks(k2)).toBe(0)
    expect(k2.calls.some((c) => c.url.includes('recordInfo?taskId=zad-1'))).toBe(true)
    expect((await zdjeciaProduktu(a, productId)).map((z) => z.sourceUrl)).toContain(zrodloPackshotu(imageId))
    expect(await a.aiUsage.count({ where: { feature: 'packshot' } })).toBe(1)
  })

  it('bez zadania kolejki (wywołanie bezpośrednie) brak wyniku w czasie = błąd bez ponowienia, jedno createTask', async () => {
    const { productId, imageId } = await produktZeZdjeciem()
    await zapiszDostawceAi(a, { model: 'claude-opus-5-5', packshot: 'on', klucz: '', kluczObrazow: KIE }, ENV, USER)
    const k = atrapaKie({ stan: 'generating' })
    await expect(zadaniePackshotu(a, { productId, imageId, actorId: USER }, { ...szybko, pollMax: 2, fetch: k.f, env: ENV })).rejects.toBeInstanceOf(NonRetryableError)
    expect(createTasks(k)).toBe(1)
    expect(await a.aiUsage.count({ where: { feature: 'packshot' } })).toBe(1)
  })

  it('zerwane połączenie przy createTask = błąd bez ponowienia z wpisem w historii (nie wiemy, czy Kie.ai nalicza)', async () => {
    const { productId, job } = await zadanieWKolejce()
    const k = atrapaKie({ createTaskRzuca: true })
    const e = await zadaniePackshotu(a, job.payload, { ...szybko, fetch: k.f, env: ENV, job: { id: job.id, attempts: 1, maxAttempts: 2 } }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(NonRetryableError)
    expect(String(e)).toMatch(/nie ponawiam/)
    expect(createTasks(k)).toBe(1)
    expect(await a.auditLog.count({ where: { entityId: productId, actorId: 'system:packshot' } })).toBe(1)
  })
})

describe('Koszt AI nie ginie po cichu', () => {
  it('packshot: zapis stanu i kosztu po createTask nieudany → log, wpis w historii z kwotą, błąd bez ponowienia (bez drugiego zlecenia)', async () => {
    const { productId, imageId } = await produktZeZdjeciem()
    await zapiszDostawceAi(a, { model: 'claude-opus-5-5', packshot: 'on', klucz: '', kluczObrazow: KIE }, ENV, USER)
    expect(await zlecPackshot(a, imageId, USER, ENV)).toEqual({ ok: true, juzJest: false })
    const job = await a.job.findFirstOrThrow({ where: { kind: PACKSHOT_JOB } })
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let przywroc = () => undefined as void
    try {
      const k = atrapaKie()
      // baza „pada” dokładnie po przyjęciu zlecenia przez Kie.ai (wcześniejsze kroki działają normalnie)
      const f = (async (u: URL | string, i?: RequestInit) => {
        const r = await k.f(u, i)
        if (String(u).endsWith('/jobs/createTask')) przywroc = awariaBazy('transakcja')
        return r
      }) as typeof fetch
      const e = await zadaniePackshotu(a, job.payload, { ...szybko, fetch: f, env: ENV, job: { id: job.id, attempts: 1, maxAttempts: 2 } }).catch((x: unknown) => x)
      przywroc()
      expect(e).toBeInstanceOf(NonRetryableError)
      expect(String(e)).toMatch(/zad-1.*nie ponawiam/)
      expect(createTasks(k)).toBe(1)
      expect(err.mock.calls.flat().join(' ')).toContain('koszt nie zapisany')
    } finally {
      przywroc()
      err.mockRestore()
    }
    expect((await a.job.findUniqueOrThrow({ where: { id: job.id } })).payload).not.toHaveProperty(KIE_TASK_KEY)
    const wpisy = await a.auditLog.findMany({ where: { entityId: productId, actorId: { in: ['system:ai', 'system:packshot'] } } })
    const txt = wpisy.map((w) => JSON.stringify(w.after)).join()
    expect(txt).toContain('kosztNieZapisany')
    expect(txt).toContain('nano-banana-2-1')
    expect(await zdjeciaProduktu(a, productId)).toHaveLength(1)
  })

  it('opis produktu: zapis kosztu nieudany → opis wraca, błąd w logu i w historii (AiUsage) z tokenami', async () => {
    await a.channelConfig.create({ data: { channel: 'AI', channelAccountId: 'ai', name: 'AI', adapterKey: 'ai.anthropic.v1', config: { model: 'claude-haiku-5-5' } } })
    const client = { messages: { create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Opis testowy.' }], usage: { input_tokens: 100, output_tokens: 50 } }) } } as never
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const przywroc = awariaBazy('aiUsageCreate')
    try {
      expect(await podpowiedzOpis(a, { title: 'Przyprawa' }, { APP_MODE: 'self-host', AI_API_KEY: KLUCZ }, client)).toEqual({ ok: true, opis: 'Opis testowy.' })
      expect(err.mock.calls.flat().join(' ')).toContain('koszt nie zapisany (opis-produktu')
    } finally {
      przywroc()
      err.mockRestore()
    }
    expect(await a.aiUsage.count()).toBe(0)
    const wpis = await a.auditLog.findFirstOrThrow({ where: { entity: 'AiUsage', entityId: 'opis-produktu' } })
    expect(wpis.after).toMatchObject({ kosztNieZapisany: { model: 'claude-haiku-5-5', inputTokens: 100, outputTokens: 50 } })
  })
})

describe('Klucz platformy: dobowy limit firmy przed wydaniem', () => {
  const HOSTED = { APP_MODE: 'hosted', PLATFORM_KIE_API_KEY: KIE, PLATFORM_AI_API_KEY: KLUCZ }

  it('packshot: limit wyczerpany → odmowa przed kolejką i w workerze bez wywołań; poniżej limitu koszt z salda zapisany już przy timeoucie', async () => {
    const { productId, imageId } = await produktZeZdjeciem()
    await a.channelConfig.create({ data: { channel: 'AI', channelAccountId: 'ai', name: 'AI', adapterKey: 'ai.anthropic.v1', config: { model: 'claude-opus-5-5', packshot: true } } })
    expect(await stanPackshotu(a, HOSTED)).toBe('gotowy')
    await a.aiUsage.create({ data: { feature: 'opis-produktu', model: 'claude-opus-5-5', inputTokens: 1, outputTokens: 1, costGrosze: 1995 } })
    expect(await zlecPackshot(a, imageId, USER, HOSTED)).toMatchObject({ ok: false, error: expect.stringContaining('dobowy limit AI') })
    expect(await a.job.count({ where: { kind: PACKSHOT_JOB } })).toBe(0)
    const k = atrapaKie()
    await expect(zadaniePackshotu(a, { productId, imageId, actorId: USER }, { ...szybko, fetch: k.f, env: HOSTED })).rejects.toThrow(/dobowy limit AI/)
    expect(k.calls).toHaveLength(0)

    // wyższy limit z env: przechodzi; koszt 10 gr z salda zapisany od razu po zleceniu, także gdy wynik nie doszedł
    const env = { ...HOSTED, PLATFORM_AI_LIMIT_DZIENNY_GROSZE: '5000' }
    expect(await zlecPackshot(a, imageId, USER, env)).toEqual({ ok: true, juzJest: false })
    const k2 = atrapaKie({ stan: 'generating' })
    await expect(zadaniePackshotu(a, { productId, imageId, actorId: USER }, { ...szybko, pollMax: 1, fetch: k2.f, env })).rejects.toBeInstanceOf(NonRetryableError)
    expect(createTasks(k2)).toBe(1)
    expect(await a.aiUsage.findFirstOrThrow({ where: { feature: 'packshot' } })).toMatchObject({ costGrosze: kosztPackshotuGrosze() })
    // limit 0 = AI z klucza platformy wyłączone; własny klucz firmy limitu nie ma
    expect(await zlecPackshot(a, imageId, USER, { ...HOSTED, PLATFORM_AI_LIMIT_DZIENNY_GROSZE: '0' })).toMatchObject({ ok: false, error: expect.stringContaining('wyłączone') })
  })

  it('zlecenie z klucza platformy, potem firma dodaje własny klucz: odbiór wyniku kluczem platformy, bez drugiego zlecenia', async () => {
    const { productId, imageId } = await produktZeZdjeciem()
    await a.channelConfig.create({ data: { channel: 'AI', channelAccountId: 'ai', name: 'AI', adapterKey: 'ai.anthropic.v1', config: { model: 'claude-opus-5-5', packshot: true } } })
    // process.env niesie klucz szyfrowania sekretów (własny klucz firmy zapisuje się zaszyfrowany)
    const env = { ...ENV, ...HOSTED, PLATFORM_AI_LIMIT_DZIENNY_GROSZE: '5000' }
    expect(await zlecPackshot(a, imageId, USER, env)).toEqual({ ok: true, juzJest: false })
    const job = await a.job.findFirstOrThrow({ where: { kind: PACKSHOT_JOB } })
    const k1 = atrapaKie({ stan: 'generating' })
    await expect(zadaniePackshotu(a, job.payload, { ...szybko, pollMax: 1, fetch: k1.f, env, job: { id: job.id, attempts: 1, maxAttempts: 2 } })).rejects.not.toBeInstanceOf(NonRetryableError)
    const payload = (await a.job.findUniqueOrThrow({ where: { id: job.id } })).payload
    expect(payload).toMatchObject({ [KIE_TASK_KEY]: 'zad-1', [KIE_KLUCZ_KEY]: 'platforma' })

    const WLASNY = 'b'.repeat(32)
    await zapiszDostawceAi(a, { model: 'claude-opus-5-5', packshot: 'on', klucz: '', kluczObrazow: WLASNY }, env, USER)
    const k2 = atrapaKie()
    expect(await zadaniePackshotu(a, payload, { ...szybko, fetch: k2.f, env, job: { id: job.id, attempts: 2, maxAttempts: 2 } })).toBeTruthy()
    const odpytania = k2.calls.filter((c) => c.url.includes('recordInfo?taskId=zad-1'))
    expect(odpytania.length).toBeGreaterThan(0)
    expect(odpytania.every((c) => c.auth === `Bearer ${KIE}`)).toBe(true)
    expect(createTasks(k2)).toBe(0)
    expect((await zdjeciaProduktu(a, productId)).map((z) => z.sourceUrl)).toContain(zrodloPackshotu(imageId))
    expect(await a.aiUsage.count({ where: { feature: 'packshot' } })).toBe(1)
  })

  it('zlecenie z klucza firmy, potem klucz usunięty: od razu koniec bez odpytań kluczem platformy i bez zachęty do ponownego kliknięcia', async () => {
    const { productId, imageId } = await produktZeZdjeciem()
    await a.channelConfig.create({ data: { channel: 'AI', channelAccountId: 'ai', name: 'AI', adapterKey: 'ai.anthropic.v1', config: { model: 'claude-opus-5-5', packshot: true } } })
    const env = { ...ENV, ...HOSTED, PLATFORM_AI_LIMIT_DZIENNY_GROSZE: '5000' }
    const WLASNY = 'c'.repeat(32)
    await zapiszDostawceAi(a, { model: 'claude-opus-5-5', packshot: 'on', klucz: '', kluczObrazow: WLASNY }, env, USER)
    expect(await zlecPackshot(a, imageId, USER, env)).toEqual({ ok: true, juzJest: false })
    const job = await a.job.findFirstOrThrow({ where: { kind: PACKSHOT_JOB } })
    const k1 = atrapaKie({ stan: 'generating' })
    await expect(zadaniePackshotu(a, job.payload, { ...szybko, pollMax: 1, fetch: k1.f, env, job: { id: job.id, attempts: 1, maxAttempts: 3 } })).rejects.not.toBeInstanceOf(NonRetryableError)
    const payload = (await a.job.findUniqueOrThrow({ where: { id: job.id } })).payload
    expect(payload).toMatchObject({ [KIE_TASK_KEY]: 'zad-1', [KIE_KLUCZ_KEY]: 'firma' })

    expect(await usunKluczAi(a, 'obrazy', USER)).toBe(true)
    const k2 = atrapaKie()
    const blad = await zadaniePackshotu(a, payload, { ...szybko, fetch: k2.f, env, job: { id: job.id, attempts: 2, maxAttempts: 3 } }).catch((e: unknown) => e)
    expect(blad).toBeInstanceOf(NonRetryableError)
    expect(String((blad as Error).message)).toContain('został usunięty')
    expect(k2.calls).toHaveLength(0)
    expect(PACKSHOT_KLUCZ_USUNIETY).not.toMatch(/kliknij/i)
    const wpis = await a.auditLog.findFirstOrThrow({ where: { entity: 'Product', entityId: productId, actorId: 'system:packshot' }, orderBy: { createdAt: 'desc' } })
    expect(JSON.stringify(wpis.after)).toContain('zad-1')
    expect(await a.aiUsage.count({ where: { feature: 'packshot' } })).toBe(1)
  })

  it('opis produktu z klucza platformy: limit wyczerpany → komunikat bez wywołania modelu; starsze niż 24 h się nie liczą', async () => {
    await a.channelConfig.create({ data: { channel: 'AI', channelAccountId: 'ai', name: 'AI', adapterKey: 'ai.anthropic.v1', config: { model: 'claude-haiku-5-5' } } })
    let wywolania = 0
    const client = {
      messages: {
        create: async () => {
          wywolania++
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Opis.' }], usage: { input_tokens: 10, output_tokens: 10 } }
        },
      },
    } as never
    await a.aiUsage.create({ data: { feature: 'packshot', model: 'nano-banana-2-1', inputTokens: 0, outputTokens: 0, costGrosze: 2000, createdAt: new Date(Date.now() - 25 * 3600_000) } })
    expect(await podpowiedzOpis(a, { title: 'Przyprawa' }, HOSTED, client)).toEqual({ ok: true, opis: 'Opis.' })
    await a.aiUsage.create({ data: { feature: 'packshot', model: 'nano-banana-2-1', inputTokens: 0, outputTokens: 0, costGrosze: 2000 } })
    expect(await podpowiedzOpis(a, { title: 'Przyprawa' }, HOSTED, client)).toMatchObject({ ok: false, error: expect.stringContaining('dobowy limit AI') })
    expect(wywolania).toBe(1)
  })
})
