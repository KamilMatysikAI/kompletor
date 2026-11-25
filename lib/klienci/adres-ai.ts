// (część 2): niejednoznaczna linia adresu przy kurierze → propozycja podziału od asystenta AI firmy.
// `rozdzielAdres` (lib/wysylka/zlecenie.ts) rozdziela sam tylko zapis jednoznaczny; resztę dotąd wpisywał człowiek.
// Tu model dostaje WYŁĄCZNIE linię ulicy z numerem (bez imienia, telefonu, e-maila, kodu i miasta) i zwraca ulicę,
// numer domu, lokal oraz pewność. Bezpieczniki są w kodzie, nie w prompcie (`sprawdzPodzial`): każda część musi być
// dosłownym fragmentem linii, w tej samej kolejności, bez dodanych i bez zgubionych znaków poza separatorami; numer
// domu i lokalu zaczyna się cyfrą. Wynik jest tylko propozycją: zapis robi człowiek przyciskiem „Zatwierdź”, przez
// zwykłą poprawkę adresu (lib/klienci/poprawka.ts: blokada przesyłki, dziennik podglądów, wpis w historii).
//
// Propozycja liczy się raz na zamówienie i linię adresu: w `Order.flags.adresAi` leżą tylko zakresy znaków (od, do)
// i skrót HMAC linii (klucz CUSTOMER_LOOKUP_KEY), bez treści adresu; zmiana linii = skrót się nie zgadza = nowa
// propozycja. Błąd dostawcy, brak klucza albo limit = nic nie zapisane, zachowanie jak dotąd (ręczna poprawka).
import { createHmac } from 'node:crypto'
import Anthropic from '@anthropic-ai/sdk'
import type { PrismaClient } from '@prisma/client'
import { dostawcaAiFirmy, kosztAiGrosze, limitPlatformyAi, NieznanyModelAi, resolveAiCredential, zapiszZuzycieAi, zrodloKluczaAi } from '../ai'
import { appModeOf } from '../organizacje'
import { flagsOf } from '../rdzen/rezerwacja'
import type { Env } from '../sekrety'
import { rozdzielAdres } from '../wysylka/zlecenie'
import { BladPoprawki, daneDoPoprawki, daneUsuniete, poprawDostawe, type PoprawkaDostawy, type WynikPoprawki } from './poprawka'
import type { RekordKlienta } from './rekord'
import { kluczSkrotowZEnv } from './skroty'
import { wersjaRekorduKlienta } from './zapis'

export const AI_FEATURE_ADRES = 'adres-podzial'
/** Najdłuższa linia wysyłana do modelu (dłuższa = nie wysyłamy; to nie jest linia ulicy). */
export const MAX_LINII = 120
export const BRAK_AI_ADRES = 'Podział adresu przez asystenta wymaga dostawcy AI firmy: Ustawienia → Integracje i agenci AI → Agenci AI → Dostawca AI.'

export type Pewnosc = 'wysoka' | 'niska'
export interface PropozycjaModelu {
  ulica: string | null
  numerDomu: string | null
  numerLokalu: string | null
  pewnosc: Pewnosc
}
type Zakres = [number, number]
export interface PodzialZakresy {
  ulica: Zakres
  dom: Zakres
  lokal: Zakres | null
}
export type WynikSprawdzenia = { ok: true; ulica: string; numerDomu: string; numerLokalu: string | null; zakresy: PodzialZakresy } | { ok: false; powod: string }

/** Separatory dozwolone między częściami i na brzegach linii (nie liczą się jako zgubione znaki). */
const SEP = /^[\s,/]*$/u
/** Między numerem domu a lokalem wolno jeszcze słowo lokalu (jak w `rozdzielAdres`). */
const SEP_LOKALU = /^[\s,/]*(?:(?:mieszkanie|mieszk|lokal|lok|apt|m)\.?)?[\s,/]*$/iu

/**
 * Bezpiecznik deterministyczny: propozycja przechodzi tylko wtedy, gdy ulica, numer domu i lokal są dosłownymi
 * fragmentami linii w tej kolejności, a wszystko poza nimi to separatory (między domem a lokalem także słowo lokalu).
 * Nic dodanego (inny znak, poprawiona literówka, „ul.” dopisane), nic zgubionego (druga liczba, „kl. B”), numer domu
 * i lokalu zaczyna się cyfrą, ulica ma literę. Zamiana domu z lokalem psuje kolejność, więc też odpada.
 * Między ulicą a domem i między domem a lokalem musi stać co najmniej jeden znak separatora: granica części nie może
 * wypaść w środku liczby („Długa 12” ≠ ulica „Długa 1” + dom „2”, „Długa 1211” ≠ dom „12” + lokal „11”).
 */
export function sprawdzPodzial(linia: string, p: Pick<PropozycjaModelu, 'ulica' | 'numerDomu' | 'numerLokalu'>): WynikSprawdzenia {
  const u = (p.ulica ?? '').trim()
  const d = (p.numerDomu ?? '').trim()
  const l = (p.numerLokalu ?? '').trim() || null
  if (!u || !/\p{L}/u.test(u)) return { ok: false, powod: 'ulica bez nazwy' }
  if (!/^\d/.test(d)) return { ok: false, powod: 'numer domu nie zaczyna się cyfrą' }
  if (l !== null && !/^\d/.test(l)) return { ok: false, powod: 'numer lokalu nie zaczyna się cyfrą' }
  const iu = linia.indexOf(u)
  if (iu < 0 || !SEP.test(linia.slice(0, iu))) return { ok: false, powod: 'ulica nie jest początkiem linii' }
  const eu = iu + u.length
  const id = linia.indexOf(d, eu)
  if (id <= eu || !SEP.test(linia.slice(eu, id))) return { ok: false, powod: 'numer domu nie stoi zaraz po ulicy' }
  const ed = id + d.length
  let lokal: Zakres | null = null
  let koniec = ed
  if (l !== null) {
    const il = linia.indexOf(l, ed)
    if (il <= ed || !SEP_LOKALU.test(linia.slice(ed, il))) return { ok: false, powod: 'numer lokalu nie stoi zaraz po numerze domu' }
    lokal = [il, il + l.length]
    koniec = il + l.length
  }
  if (!SEP.test(linia.slice(koniec))) return { ok: false, powod: 'część linii została pominięta' }
  return { ok: true, ulica: u, numerDomu: d, numerLokalu: l, zakresy: { ulica: [iu, eu], dom: [id, ed], lokal } }
}

/** Odpowiedź modelu (JSON w tekście) → propozycja; nieczytelna = null. Pewność inna niż „wysoka” = „niska”. */
export function parsujOdpowiedz(tekst: string): PropozycjaModelu | null {
  const m = /\{[\s\S]*\}/.exec(tekst)
  if (!m) return null
  let j: unknown
  try {
    j = JSON.parse(m[0])
  } catch {
    return null
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null
  const o = j as Record<string, unknown>
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v : typeof v === 'number' ? String(v) : null)
  return { ulica: s(o['ulica']), numerDomu: s(o['numer_domu']), numerLokalu: s(o['numer_lokalu']), pewnosc: o['pewnosc'] === 'wysoka' ? 'wysoka' : 'niska' }
}

export const PROMPT_ADRES =
  'Dostajesz jedną linię polskiego adresu: ulicę z numerem budynku i czasem lokalu. Rozdziel ją na ulicę, numer domu i numer lokalu. ' +
  'Kopiuj znaki dokładnie z linii, w tej samej kolejności: niczego nie poprawiaj, nie dopisuj („ul.”, wielkie litery) i nie pomijaj. ' +
  'Gdy linia nie zawiera numeru domu albo nie da się go jednoznacznie ustalić, zwróć numer_domu null i pewnosc „niska”. ' +
  'Zwróć wyłącznie JSON: {"ulica": "...", "numer_domu": "..." albo null, "numer_lokalu": "..." albo null, "pewnosc": "wysoka" albo "niska"}.'

export interface OdpowiedzModelu {
  propozycja: PropozycjaModelu | null
  inputTokens: number
  outputTokens: number
  odmowa: boolean
}

/** Jedno zapytanie do modelu: w treści tylko linia adresu. */
export async function zapytajModel(api: Pick<Anthropic, 'messages'>, model: string, linia: string): Promise<OdpowiedzModelu> {
  const r = await api.messages.create({
    model,
    max_tokens: 300,
    output_config: { effort: 'low' },
    system: PROMPT_ADRES,
    messages: [{ role: 'user', content: `Linia adresu: ${JSON.stringify(linia)}` }],
  })
  const tekst = r.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
  return { propozycja: r.stop_reason === 'refusal' ? null : parsujOdpowiedz(tekst), inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens, odmowa: r.stop_reason === 'refusal' }
}

/** Zapis w `Order.flags.adresAi`: bez treści adresu, tylko skrót linii i zakresy znaków. */
export type ZapisAdresuAi = { skrot: string; kiedy: string; model: string; pewnosc: Pewnosc; zakresy: PodzialZakresy } | { skrot: string; kiedy: string; model: string; odrzucona: string }

export function skrotLinii(key: Buffer, orderId: string, linia: string): string {
  return createHmac('sha256', key).update(`${orderId}\u0000adres\u0000${linia}`, 'utf8').digest('hex')
}

/** Czy podział przez asystenta ma sens dla tej linii: jest ulica, brak numeru domu, `rozdzielAdres` nie rozdziela sam. */
export function potrzebnyPodzial(d: { ulica: string | null; numerDomu: string | null }): boolean {
  const u = (d.ulica ?? '').trim()
  return !!u && !(d.numerDomu ?? '').trim() && u.length <= MAX_LINII && rozdzielAdres(u) === null
}

/** Podział dotyczy dostawy kurierem do drzwi: przy punkcie odbioru numer domu nie jest wymagany (część 1). */
function potrzebnyDlaDostawy(d: Pick<PoprawkaDostawy, 'ulica' | 'numerDomu' | 'punkt'>): boolean {
  return !(d.punkt ?? '').trim() && potrzebnyPodzial(d)
}

/** To samo z rekordu klienta (karta zamówienia liczy to z odczytu, który już robi, bez drugiego wpisu w dzienniku). */
export function potrzebnyPodzialRekordu(r: RekordKlienta): boolean {
  return !!r.dostawa && potrzebnyDlaDostawy({ ulica: r.dostawa.ulica, numerDomu: r.dostawa.numerDomu, punkt: r.punktOdbioru?.kod ?? null })
}

export interface PropozycjaWidok {
  ulica: string
  numerDomu: string
  numerLokalu: string | null
  pewnosc: Pewnosc
}
export type WynikPropozycji = { stan: 'PROPOZYCJA'; linia: string; propozycja: PropozycjaWidok; zZapisu: boolean } | { stan: 'ODRZUCONA'; powod: string } | { stan: 'NIE_DOTYCZY' } | { stan: 'NIEDOSTEPNE'; powod: string }

const wycinek = (linia: string, z: Zakres) => linia.slice(z[0], z[1])

/** Zakresy z zapisu na bieżącą linię; ponowne sprawdzenie bezpiecznika (zapis mógł powstać przy innej wersji kodu). */
function zZakresow(linia: string, z: PodzialZakresy): WynikSprawdzenia {
  return sprawdzPodzial(linia, { ulica: wycinek(linia, z.ulica), numerDomu: wycinek(linia, z.dom), numerLokalu: z.lokal ? wycinek(linia, z.lokal) : null })
}

export interface DepsAdresuAi {
  actorId: string
  env?: Env
  now?: Date
  /** Atrapa klienta modelu w testach. */
  client?: Pick<Anthropic, 'messages'>
}

/**
 * Propozycja podziału linii adresu zamówienia: z zapisu (bez pytania modelu), a gdy go nie ma albo linia się zmieniła,
 * jedno zapytanie do modelu firmy. Odczyt danych przez `daneDoPoprawki` (uprawnienie `klienci.dane`, wpis w dzienniku
 * podglądów jak przy otwarciu formularza poprawki).
 */
export async function propozycjaPodzialu(db: PrismaClient, orderId: string, o: DepsAdresuAi): Promise<WynikPropozycji> {
  const env = o.env ?? process.env
  const key = kluczSkrotowZEnv(env)
  if (!key) return { stan: 'NIEDOSTEPNE', powod: 'Dane klienta niedostępne: brak klucza skrótów (CUSTOMER_LOOKUP_KEY).' }
  const dane = await daneDoPoprawki(db, orderId, { actorId: o.actorId, env })
  if (!dane || !potrzebnyDlaDostawy(dane)) return { stan: 'NIE_DOTYCZY' }
  const linia = dane.ulica!.trim()
  const skrot = skrotLinii(key, orderId, linia)
  const order = await db.order.findUnique({ where: { id: orderId }, select: { flags: true } })
  if (!order) return { stan: 'NIE_DOTYCZY' }
  const zapis = (flagsOf(order) as { adresAi?: ZapisAdresuAi }).adresAi
  if (zapis && zapis.skrot === skrot) {
    if ('odrzucona' in zapis) return { stan: 'ODRZUCONA', powod: zapis.odrzucona }
    const s = zZakresow(linia, zapis.zakresy)
    if (s.ok) return { stan: 'PROPOZYCJA', linia, propozycja: { ulica: s.ulica, numerDomu: s.numerDomu, numerLokalu: s.numerLokalu, pewnosc: zapis.pewnosc }, zZapisu: true }
  }
  const k = await dostawcaAiFirmy(db)
  try {
    kosztAiGrosze(k.model, 0, 0)
  } catch (e) {
    if (e instanceof NieznanyModelAi) return { stan: 'NIEDOSTEPNE', powod: e.message }
    throw e
  }
  const cred = await resolveAiCredential(db, k.accountId, { env, envFallback: appModeOf(env) === 'self-host' })
  if (!cred) return { stan: 'NIEDOSTEPNE', powod: BRAK_AI_ADRES }
  if (cred.billedToBalance) {
    const limit = await limitPlatformyAi(db, 1, env)
    if (limit) return { stan: 'NIEDOSTEPNE', powod: limit }
  }
  const api = o.client ?? new Anthropic({ apiKey: cred.apiKey, maxRetries: 1, timeout: 30_000 })
  let r: OdpowiedzModelu
  try {
    r = await zapytajModel(api, k.model, linia)
  } catch (e) {
    if (e instanceof Anthropic.APIError) return { stan: 'NIEDOSTEPNE', powod: `Asystent AI nie odpowiedział (${e.status ?? 'brak połączenia'}). Popraw adres ręcznie albo spróbuj później.` }
    throw e
  }
  const kosztGr = kosztAiGrosze(k.model, r.inputTokens, r.outputTokens)
  await zapiszZuzycieAi(db, { feature: AI_FEATURE_ADRES, model: k.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costGrosze: cred.billedToBalance ? kosztGr : 0 }, { entity: 'Order', entityId: orderId })
  const kiedy = (o.now ?? new Date()).toISOString()
  const s: WynikSprawdzenia = r.propozycja ? sprawdzPodzial(linia, r.propozycja) : { ok: false, powod: r.odmowa ? 'asystent odmówił' : 'nieczytelna odpowiedź asystenta' }
  const nowy: ZapisAdresuAi = s.ok ? { skrot, kiedy, model: k.model, pewnosc: r.propozycja!.pewnosc, zakresy: s.zakresy } : { skrot, kiedy, model: k.model, odrzucona: s.powod }
  await db.$executeRaw`UPDATE "Order" SET flags = (CASE WHEN jsonb_typeof(flags) = 'object' THEN flags ELSE '{}'::jsonb END) || jsonb_build_object('adresAi', ${JSON.stringify(nowy)}::jsonb) WHERE id = ${orderId}`
  if (!s.ok) return { stan: 'ODRZUCONA', powod: s.powod }
  return { stan: 'PROPOZYCJA', linia, propozycja: { ulica: s.ulica, numerDomu: s.numerDomu, numerLokalu: s.numerLokalu, pewnosc: r.propozycja!.pewnosc }, zZapisu: false }
}

export const ZMIANA_W_TRAKCIE = 'Dane klienta zmieniły się w trakcie zapisu (ktoś inny poprawił adres): poproś o propozycję jeszcze raz albo popraw ręcznie.'

/**
 * „Zatwierdź”: zapis propozycji z `Order.flags.adresAi` jako poprawki adresu człowieka. Linia musi być ta sama (skrót),
 * pewność wysoka, a bezpiecznik przechodzi jeszcze raz na bieżącej linii; inaczej odmowa bez zapisu. Reszta pól dostawy
 * bez zmian. Wpis w historii zamówienia idzie w tej samej transakcji co zapis rekordu klienta (`wTransakcji`
 * `poprawDostawe`): albo oba, albo żaden. W tej transakcji, pod blokadą rekordu, sprawdzamy też, że rekord nie zmienił
 * się od odczytu (wersja jak przy nadaniu) i nie został usunięty: inaczej zapisalibyśmy podział starej linii
 * na cudzą, nowszą poprawkę.
 */
export async function zatwierdzPodzial(
  db: PrismaClient,
  orderId: string,
  o: { actorId: string; env?: Env; now?: Date; /** Testy: krok między odczytem a zapisem (równoległa poprawka). */ poOdczycie?: () => Promise<void> },
): Promise<WynikPoprawki & { propozycja?: PropozycjaWidok }> {
  const env = o.env ?? process.env
  const key = kluczSkrotowZEnv(env)
  if (!key) return { wynik: 'ODMOWA', powod: 'Dane klienta niedostępne: brak klucza skrótów (CUSTOMER_LOOKUP_KEY).' }
  const wersja = await wersjaRekorduKlienta(db, orderId)
  const dane = await daneDoPoprawki(db, orderId, { actorId: o.actorId, env })
  const order = await db.order.findUnique({ where: { id: orderId }, select: { flags: true } })
  const zapis = order ? (flagsOf(order) as { adresAi?: ZapisAdresuAi }).adresAi : undefined
  if (!dane || !potrzebnyDlaDostawy(dane) || !zapis || 'odrzucona' in zapis) return { wynik: 'ODMOWA', powod: 'Nie ma propozycji asystenta dla obecnego adresu: popraw adres ręcznie.' }
  const linia = dane.ulica!.trim()
  if (zapis.skrot !== skrotLinii(key, orderId, linia)) return { wynik: 'ODMOWA', powod: 'Adres zmienił się po propozycji asystenta: poproś o nową propozycję albo popraw ręcznie.' }
  if (zapis.pewnosc !== 'wysoka') return { wynik: 'ODMOWA', powod: 'Asystent nie jest pewny tego podziału: popraw adres ręcznie w „Popraw adres albo punkt odbioru”.' }
  const s = zZakresow(linia, zapis.zakresy)
  if (!s.ok) return { wynik: 'ODMOWA', powod: 'Propozycja asystenta nie przechodzi sprawdzenia: popraw adres ręcznie.' }
  // Lokal już wpisany w osobnym polu wygrywa tylko wtedy, gdy linia nie ma innego lokalu: inaczej zapis zgubiłby lokal
  // z linii, więc odmowa i poprawka ręczna.
  const lokalWPolu = (dane.numerLokalu ?? '').trim()
  if (lokalWPolu && s.numerLokalu && s.numerLokalu.trim() !== lokalWPolu) return { wynik: 'ODMOWA', powod: 'W zamówieniu jest już numer lokalu inny niż w linii adresu: popraw adres ręcznie.' }
  const numerLokalu = lokalWPolu ? dane.numerLokalu : s.numerLokalu
  await o.poOdczycie?.()
  const actorId = o.actorId.startsWith('user:') ? o.actorId : `user:${o.actorId}`
  const w = await poprawDostawe(db, orderId, { ...dane, ulica: s.ulica, numerDomu: s.numerDomu, numerLokalu }, {
    actorId: o.actorId,
    env,
    now: o.now,
    wTransakcji: async (tx) => {
      if (await daneUsuniete(tx, orderId)) throw new BladPoprawki('Dane klienta tego zamówienia zostały usunięte.')
      if ((await wersjaRekorduKlienta(tx, orderId)) !== wersja) throw new BladPoprawki(ZMIANA_W_TRAKCIE)
      await tx.orderEvent.create({ data: { orderId, kind: 'ADRES_PODZIELONY_PRZEZ_ASYSTENTA', actorId, data: { tryb: 'zatwierdzone', pewnosc: zapis.pewnosc, model: zapis.model } } })
    },
  })
  if (w.wynik === 'ODMOWA') return w
  // „Zapisano” pokazuje wartości faktycznie zapisane (lokal z pola, gdy linia go nie miała), nie samą propozycję.
  return { ...w, propozycja: { ulica: s.ulica, numerDomu: s.numerDomu, numerLokalu: numerLokalu?.trim() || null, pewnosc: zapis.pewnosc } }
}

/**
 * Powód, dla którego „Podpowiedz podział adresu” jest nieaktywny (bez odszyfrowania klucza i bez pytania modelu):
 * brak dostawcy AI firmy, model bez cennika albo wyczerpany dobowy limit AI z konta platformy; null = można pytać.
 */
export async function powodBrakuAsystentaAdresu(db: PrismaClient, env: Env = process.env): Promise<string | null> {
  const k = await dostawcaAiFirmy(db)
  try {
    kosztAiGrosze(k.model, 0, 0)
  } catch (e) {
    if (e instanceof NieznanyModelAi) return e.message
    throw e
  }
  const zrodlo = await zrodloKluczaAi(db, k.accountId, { env, envFallback: appModeOf(env) === 'self-host' })
  if (!zrodlo) return BRAK_AI_ADRES
  return zrodlo === 'platforma' ? limitPlatformyAi(db, 1, env) : null
}
