// packshot AI — zdjęcie produktu na białym tle zrobione z istniejącego zdjęcia (PROJEKT pkt 5). Dostawca
// obrazów: Kie.ai (edycja obrazu modelem Nano Banana 2.1), klucz firmy na koncie AI (`KIE_API_KEY`), w hostingu klucz
// platformy rozliczany z salda, w self-host też env. Za wyłącznikiem: Ustawienia → Agenci AI → Dostawca AI →
// „Packshot AI włączony” (domyślnie wyłączony, bo generowanie kosztuje).
//
// Przebieg: przycisk na karcie zleca zadanie workera (generowanie trwa do kilku minut, więc nie w żądaniu panelu).
// Worker wysyła do Kie.ai tylko to jedno zdjęcie produktu (żadnych danych klientów), czeka na wynik, pobiera go
// (https, adres publiczny, limit rozmiaru) i dodaje jako NOWE zdjęcie produktu przez `dodajZdjecia` (osłona uploadu,
// zapis od nowa przez sharp). Oryginał zostaje. Jeden packshot na zdjęcie źródłowe (`sourceUrl` = `packshot:<id>`,
// unikat na produkt), więc ponowione zadanie nie robi dubla. Błąd trafia do historii produktu i do błędu zadania.
//
// Prompt: ta sama treść co packshot w zewnętrznym bocie marketingowym (photo_studio.py), przepisana tu,
// bo produkt (AGPL) nie może wołać skryptów z prywatnego repozytorium.
import type { Prisma, PrismaClient } from '@prisma/client'
import { NonRetryableError } from '../bledy'
import { AI_OBRAZY_SECRET_NAME, dostawcaAiFirmy, kosztPackshotuGrosze, limitPlatformyAi, PLATFORM_AI_OBRAZY_ENV, resolveAiObrazyCredential, zglosNiezapisaneZuzycie, zrodloKluczaObrazow, type AiCredential, type ZuzycieAi } from '../ai'
import { appModeOf } from '../organizacje'
import { enqueue } from '../worker/kolejka'
import { adresWewnetrzny, bezpiecznyAdresZdjecia, dodajZdjecia, pobierzPrzypiete, plikZdjecia } from './zdjecia'

export const PACKSHOT_JOB = 'produkt-packshot'
export const PACKSHOT_FEATURE = 'packshot'
export const KIE_API = 'https://api.kie.ai/api/v1'
// oficjalny endpoint uploadu plików Kie.ai (dokumentacja Kie: File Upload API), inny host niż api.kie.ai
export const KIE_UPLOAD = 'https://kieai.redpandaai.co/api/file-stream-upload'
export const KIE_MODEL = 'nano-banana-2-1'
const ID_RE = /^[a-z0-9]{10,40}$/

export const PACKSHOT_PROMPT =
  'E-commerce PACKSHOT on a PURE WHITE seamless background (#FFFFFF). ' +
  'Use EXACTLY the product shown in the input image — preserve its color, shape, texture, ' +
  'proportions, packaging and all visible details. Do NOT add, remove or alter any element ' +
  'of the product itself. Remove the original background completely and replace it with ' +
  'clean studio white. Product perfectly centered, whole product in frame with even margins. ' +
  'Soft, even studio lighting, gentle natural shadow directly under the product ' +
  '(soft contact shadow only, no harsh cast shadows). ' +
  'NO props, NO text, NO logos, NO watermarks, NO reflections of other objects. ' +
  'Professional product photography for an online shop, square 1:1 composition.\n\n' +
  'LABEL RULE: If the product has a printed label/sticker/tag with text or icons, ' +
  'reproduce that label EXACTLY as in the input image — same text letter by letter, ' +
  'same icons, same layout. Never invent, translate or alter label text. ' +
  'Keep any stick, ribbon or wrapping intact and undamaged.'

export const PACKSHOT_WYLACZONY = 'Packshot AI jest wyłączony. Włącza go właściciel firmy: Ustawienia → Integracje i agenci AI → Agenci AI → Dostawca AI.'
export const PACKSHOT_BRAK_KLUCZA = 'Packshot AI wymaga klucza Kie.ai: Ustawienia → Integracje i agenci AI → Agenci AI → Dostawca AI.'

export const zrodloPackshotu = (imageId: string) => `packshot:${imageId}`

/** Stan packshotu dla karty produktu: wyłączony / brak klucza / gotowy. */
export async function stanPackshotu(db: PrismaClient, env: Record<string, string | undefined> = process.env): Promise<'wylaczony' | 'brak-klucza' | 'gotowy'> {
  const ai = await dostawcaAiFirmy(db)
  if (!ai.packshot) return 'wylaczony'
  return (await zrodloKluczaObrazow(db, ai.accountId, { env, envFallback: appModeOf(env) === 'self-host' })) ? 'gotowy' : 'brak-klucza'
}

export type WynikZlecenia = { ok: true; juzJest: boolean } | { ok: false; error: string }

/** Zlecenie packshotu ze zdjęcia produktu (karta produktu). Sprawdza wyłącznik i klucz, zanim cokolwiek trafi do kolejki. */
export async function zlecPackshot(db: PrismaClient, imageId: string, actorId: string, env: Record<string, string | undefined> = process.env): Promise<WynikZlecenia> {
  if (!ID_RE.test(imageId)) return { ok: false, error: 'Nie ma takiego zdjęcia.' }
  const img = await db.productImage.findUnique({ where: { id: imageId }, select: { productId: true, sourceUrl: true } })
  if (!img) return { ok: false, error: 'Nie ma takiego zdjęcia.' }
  if (img.sourceUrl?.startsWith('packshot:')) return { ok: false, error: 'To zdjęcie jest już packshotem.' }
  const stan = await stanPackshotu(db, env)
  if (stan === 'wylaczony') return { ok: false, error: PACKSHOT_WYLACZONY }
  if (stan === 'brak-klucza') return { ok: false, error: PACKSHOT_BRAK_KLUCZA }
  if (await db.productImage.findFirst({ where: { productId: img.productId, sourceUrl: zrodloPackshotu(imageId) }, select: { id: true } })) return { ok: true, juzJest: true }
  // klucz platformy (koszt z salda): dobowy limit firmy sprawdzony przed kolejką
  if ((await zrodloKluczaObrazow(db, (await dostawcaAiFirmy(db)).accountId, { env, envFallback: appModeOf(env) === 'self-host' })) === 'platforma') {
    const limit = await limitPlatformyAi(db, kosztPackshotuGrosze(), env)
    if (limit) return { ok: false, error: limit }
  }
  // Dedupe: zadanie w kolejce (PENDING/RUNNING) trzyma klucz `packshot:<id>`, więc drugie kliknięcie nic nie dokłada.
  // Zadanie zakończone (DONE/FAILED) ma klucz wyzerowany (kolejka.ts: complete/fail), więc kliknięcie po błędzie
  // zakłada nowe zadanie (osobna gałąź „reset FAILED” była martwa).
  const dedupeKey = `packshot:${imageId}`
  const payload = { productId: img.productId, imageId, actorId }
  // maxAttempts 2: drugie podejście tylko odpytuje Kie.ai o zapisane zadanie (kieTaskId), nigdy nie zleca drugiego
  if ((await enqueue(db, PACKSHOT_JOB, payload, { dedupeKey, maxAttempts: 2 })) === null) return { ok: true, juzJest: false }
  await db.auditLog.create({ data: { entity: 'Product', entityId: img.productId, actorId, after: { packshotZlecony: imageId } } })
  return { ok: true, juzJest: false }
}

type Fetch = typeof fetch
type Lookup = (host: string) => Promise<string[]>

export interface OpcjePackshotu {
  /** tylko testy: atrapa HTTP Kie.ai (bez prawdziwych wywołań) */
  fetch?: Fetch
  lookup?: Lookup
  env?: Record<string, string | undefined>
  /** odstęp i liczba sprawdzeń wyniku (domyślnie co 5 s, do 3 min) */
  pollMs?: number
  pollMax?: number
  sleep?: (ms: number) => Promise<void>
  /**
   * Zadanie kolejki, które wykonuje packshot (handler workera). Z nim id zadania Kie.ai trafia do payloadu zaraz po
   * `createTask`, a ponowienie tylko odpytuje to zadanie (bez drugiego, płatnego zlecenia).
   * Bez niego (wywołanie spoza kolejki) brak wyniku w czasie = błąd bez ponowienia.
   */
  job?: { id: string; attempts: number; maxAttempts: number }
}

/** Id zadania Kie.ai zapisane w payloadzie po zleceniu. */
export const KIE_TASK_KEY = 'kieTaskId'
/** skąd był klucz przy zleceniu; odbiór wyniku tym samym kluczem. */
export const KIE_KLUCZ_KEY = 'kieKlucz'

/**
 * Klucz do odbioru zleconego wcześniej zadania: gdy zlecenie poszło z klucza platformy albo serwera (`env`), a firma
 * od tego czasu dodała własny klucz, odpytujemy kluczem z chwili zlecenia (zadanie Kie.ai należy do tamtego konta;
 * nowym kluczem odpytanie dostaje 401 i opłacony wynik by przepadł). Klucza firmy usuniętego po zleceniu nie odzyskamy.
 */
function kluczZleceniaKie(zrodlo: unknown, env: Record<string, string | undefined>): AiCredential | null {
  if (zrodlo === 'platforma' && appModeOf(env) === 'hosted' && env[PLATFORM_AI_OBRAZY_ENV]) return { apiKey: env[PLATFORM_AI_OBRAZY_ENV]!, source: 'platforma', billedToBalance: true }
  if (zrodlo === 'env' && appModeOf(env) === 'self-host' && env[AI_OBRAZY_SECRET_NAME]) return { apiKey: env[AI_OBRAZY_SECRET_NAME]!, source: 'env', billedToBalance: false }
  return null
}
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,100}$/
/** klucz Kie.ai z chwili zlecenia usunięty po zleceniu; tekst do historii produktu. */
export const PACKSHOT_KLUCZ_USUNIETY =
  'klucz Kie.ai, którym zlecono packshot, został usunięty; wyniku nie da się odebrać innym kluczem. Zlecenie jest opłacone na tamtym koncie Kie.ai (wynik w historii zadań na kie.ai); ponowne kliknięcie „Packshot” to nowe, płatne zlecenie'

const kieBlad = (co: string, status: number) => `Kie.ai: ${co} nieudane (${status === 401 || status === 403 ? 'zły klucz albo brak dostępu' : status === 402 ? 'brak kredytów na koncie Kie.ai' : `odpowiedź ${status}`})`

async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  try {
    const j = (await res.json()) as unknown
    return j && typeof j === 'object' ? (j as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Zadanie workera: jeden packshot. Błąd = wpis w historii produktu + błąd zadania (bez pętli ponowień przy złym kluczu).
 *
 * Pieniądze: płatne jest `createTask` u Kie.ai. Zaraz po nim, zanim zaczniemy
 * czekać na wynik, w jednej transakcji zapisujemy id zadania Kie.ai w payloadzie zadania kolejki i pozycję kosztu
 * (AiUsage). Ponowienie (worker padł, Kie.ai nie skończył w 3 min, chwilowe błędy odpytania) zaczyna od odpytania
 * zapisanego zadania, więc nigdy nie zleca drugiego. Gdy tego stanu nie da się zapisać, zadanie kończy się błędem
 * bez ponowienia (wpis w historii z id zadania Kie.ai), a nie drugim zleceniem.
 */
export async function zadaniePackshotu(db: PrismaClient, payload: Prisma.JsonValue, opts: OpcjePackshotu = {}): Promise<string | null> {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {}
  const productId = typeof p['productId'] === 'string' ? p['productId'] : ''
  const imageId = typeof p['imageId'] === 'string' ? p['imageId'] : ''
  const actorId = typeof p['actorId'] === 'string' ? p['actorId'].slice(0, 100) : 'system:packshot'
  if (!ID_RE.test(productId) || !ID_RE.test(imageId)) throw new NonRetryableError(`${PACKSHOT_JOB}: zły payload`)
  const zapisany = p[KIE_TASK_KEY]
  const zapisanyTask = typeof zapisany === 'string' && TASK_ID_RE.test(zapisany) ? zapisany : ''
  const env = opts.env ?? process.env
  const f = opts.fetch ?? fetch
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const historia = (blad: string) =>
    db.auditLog
      .create({ data: { entity: 'Product', entityId: productId, actorId: 'system:packshot', after: { packshotBlad: blad.slice(0, 300), zdjecie: imageId } } })
      .catch((e: unknown) => console.error(`[packshot] wpis w historii produktu ${productId} nieudany (${blad.slice(0, 100)}): ${e instanceof Error ? e.message : String(e)}`))
  const stop = async (blad: string): Promise<never> => {
    await historia(blad)
    throw new NonRetryableError(`${PACKSHOT_JOB}: ${blad}`)
  }
  if (await db.productImage.findFirst({ where: { productId, sourceUrl: zrodloPackshotu(imageId) }, select: { id: true } })) return null
  const ai = await dostawcaAiFirmy(db)
  // wznowienie po zleceniu: odpytanie jest darmowe, więc wyłącznik nie zatrzymuje odbioru opłaconego już wyniku
  if (!ai.packshot && !zapisanyTask) return stop(PACKSHOT_WYLACZONY)
  let cred = await resolveAiObrazyCredential(db, ai.accountId, { env, envFallback: appModeOf(env) === 'self-host' })
  if (zapisanyTask && p[KIE_KLUCZ_KEY] !== undefined && p[KIE_KLUCZ_KEY] !== cred?.source) {
    // klucza z chwili zlecenia już nie ma (np. firma usunęła swój klucz). Innym kluczem Kie.ai
    // zadania nie odda (401 przez 36 odpytań), więc od razu koniec, bez zachęty do kliknięcia, które zleci drugi raz.
    const zlecony = kluczZleceniaKie(p[KIE_KLUCZ_KEY], env)
    if (!zlecony) return stop(`${PACKSHOT_KLUCZ_USUNIETY} (zadanie Kie.ai ${zapisanyTask})`)
    cred = zlecony
  }
  if (!cred) return stop(zapisanyTask ? `${PACKSHOT_BRAK_KLUCZA} (zadanie Kie.ai ${zapisanyTask} czeka na odbiór)` : PACKSHOT_BRAK_KLUCZA)
  const auth = { authorization: `Bearer ${cred.apiKey}` }

  let taskId = zapisanyTask
  if (!taskId) {
    if (cred.billedToBalance) {
      const limit = await limitPlatformyAi(db, kosztPackshotuGrosze(), env)
      if (limit) return stop(limit)
    }
    const zrodlo = await plikZdjecia(db, imageId, 'o', env).catch(() => null)
    if (!zrodlo) return stop('zdjęcia źródłowego nie ma już w produkcie')

    // 1. zdjęcie do Kie.ai (oficjalny endpoint uploadu plików Kie.ai; plik tymczasowy u dostawcy, znika sam)
    const fd = new FormData()
    const nazwa = `kompletor-${imageId}.webp`
    fd.append('file', new Blob([new Uint8Array(zrodlo.bytes)], { type: 'image/webp' }), nazwa)
    fd.append('uploadPath', 'kompletor')
    fd.append('fileName', nazwa)
    const up = await f(KIE_UPLOAD, { method: 'POST', headers: auth, body: fd, signal: AbortSignal.timeout(60_000) })
    if (!up.ok) return stop(kieBlad('wysłanie zdjęcia', up.status))
    const upData = ((await jsonOf(up))['data'] ?? {}) as Record<string, unknown>
    const wejscie = String(upData['downloadUrl'] ?? upData['fileUrl'] ?? '')
    if (!wejscie.startsWith('https://')) return stop('Kie.ai nie zwrócił adresu wysłanego zdjęcia')

    // 2. zadanie edycji obrazu (płatne). Każdy błąd od tego miejsca do zapisu stanu = bez ponowienia: nie wiemy,
    // czy Kie.ai już nie nalicza (np. zerwane połączenie po przyjęciu zlecenia).
    let task: Response
    try {
      task = await f(`${KIE_API}/jobs/createTask`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ model: KIE_MODEL, input: { prompt: PACKSHOT_PROMPT, image_input: [wejscie], aspect_ratio: '1:1', resolution: '1K', output_format: 'png' } }),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (e) {
      return stop(
        `zlecenie packshotu w Kie.ai bez odpowiedzi (${e instanceof Error ? e.message.slice(0, 100) : 'błąd sieci'}); nie ponawiam, żeby nie płacić dwa razy. Sprawdź historię zadań na kie.ai i kliknij „Packshot” ponownie`,
      )
    }
    if (!task.ok) return stop(kieBlad('zlecenie packshotu', task.status))
    const taskJ = await jsonOf(task)
    taskId = String(((taskJ['data'] ?? {}) as Record<string, unknown>)['taskId'] ?? '')
    if (!TASK_ID_RE.test(taskId)) return stop(`Kie.ai nie przyjął zadania (${String(taskJ['msg'] ?? 'brak opisu').slice(0, 100)})`)

    // 3. stan i koszt od razu po zleceniu: jedna transakcja, przed czekaniem na wynik
    const koszt: ZuzycieAi = { feature: PACKSHOT_FEATURE, model: KIE_MODEL, inputTokens: 0, outputTokens: 0, costGrosze: cred.billedToBalance ? kosztPackshotuGrosze() : 0 }
    const jobId = opts.job?.id
    const nowyPayload = { ...p, [KIE_TASK_KEY]: taskId, [KIE_KLUCZ_KEY]: cred.source } as Prisma.InputJsonValue
    try {
      await db.$transaction(async (tx) => {
        if (jobId) await tx.job.update({ where: { id: jobId }, data: { payload: nowyPayload } })
        await tx.aiUsage.create({ data: koszt })
      })
    } catch (e) {
      await zglosNiezapisaneZuzycie(db, koszt, e, { entity: 'Product', entityId: productId })
      return stop(`Kie.ai przyjął zadanie ${taskId}, ale nie udało się zapisać jego stanu i kosztu; nie ponawiam, żeby nie płacić dwa razy`)
    }
  }

  // 4. czekanie na wynik (odpytanie nic nie kosztuje)
  let wynikUrl = ''
  const max = opts.pollMax ?? 36
  for (let i = 0; i < max && !wynikUrl; i++) {
    await sleep(opts.pollMs ?? 5_000)
    let r: Response
    try {
      r = await f(`${KIE_API}/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, { headers: auth, signal: AbortSignal.timeout(30_000) })
    } catch {
      continue // chwilowy błąd sieci przy odpytaniu: następna próba
    }
    if (!r.ok) continue // chwilowy błąd sprawdzenia: następna próba
    const d = ((await jsonOf(r))['data'] ?? {}) as Record<string, unknown>
    if (d['state'] === 'fail') return stop(`Kie.ai nie zrobił packshotu (${String(d['failMsg'] ?? 'brak opisu').slice(0, 150)})`)
    if (d['state'] === 'success') {
      let urls: unknown = []
      try {
        urls = (JSON.parse(String(d['resultJson'] ?? '{}')) as Record<string, unknown>)['resultUrls']
      } catch {
        urls = []
      }
      wynikUrl = Array.isArray(urls) && typeof urls[0] === 'string' ? urls[0] : ''
      if (!wynikUrl) return stop('Kie.ai zakończył zadanie bez obrazu')
    }
  }
  if (!wynikUrl) {
    // Ponowienie tylko wtedy, gdy wykonuje to zadanie kolejki (id zadania Kie.ai jest w jego payloadzie) i zostały
    // próby; kolejne podejście zaczyna od odpytania, bez nowego zlecenia. Inaczej koniec z wpisem w historii.
    const ostatnia = !opts.job || opts.job.attempts >= opts.job.maxAttempts
    if (!ostatnia) throw new Error(`${PACKSHOT_JOB}: Kie.ai jeszcze nie skończył (zadanie ${taskId}), sprawdzę ponownie bez nowego zlecenia`)
    return stop(`Kie.ai nie skończył packshotu w wyznaczonym czasie (zadanie ${taskId}). Wynik sprawdź w historii zadań na kie.ai; ponowne kliknięcie „Packshot” to nowe, płatne zlecenie`)
  }

  // 5. pobranie wyniku: ten sam bezpieczny tor co zdjęcia z ofert (https, adres publiczny, limit rozmiaru)
  const u = bezpiecznyAdresZdjecia(wynikUrl)
  if (!u) return stop('adres wyniku od Kie.ai niedozwolony')
  const resolve: Lookup = opts.lookup ?? (async (h) => (await (await import('node:dns')).promises.lookup(h, { all: true })).map((x) => x.address))
  const ips = await resolve(u.hostname)
  if (!ips.length || ips.some(adresWewnetrzny)) return stop('adres wyniku od Kie.ai wskazuje sieć wewnętrzną')
  let bytes: Buffer
  if (opts.fetch) {
    const res = await opts.fetch(u, { redirect: 'error', signal: AbortSignal.timeout(30_000) })
    if (!res.ok) return stop(`pobranie packshotu nieudane (${res.status})`)
    bytes = Buffer.from(await res.arrayBuffer())
  } else bytes = await pobierzPrzypiete(u, resolve)

  const w = await dodajZdjecia(db, productId, [{ bytes, nazwa: 'packshot.png', sourceUrl: zrodloPackshotu(imageId) }], actorId)
  if (w.bledy.length) return stop(`packshot nie zapisany: ${w.bledy[0]!.komunikat}`)
  return w.dodane[0] ?? null
}
