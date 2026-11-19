'use server'
// Ustawienia → Kanały sprzedaży: dodanie sklepu, ustawienia, klucze, włączenie, test połączenia, pobranie
// ofert, przypisanie oferty. Po dodaniu od razu test połączenia, „Połącz z Allegro” (device flow z panelu),
// przełączenie trybu konta (podgląd / aktywny) z warunkami. Uprawnienie `ustawienia`; tryb konta i wyłącznik zapisu do
// sklepu dodatkowo `kanaly.tryb` („Zmiana trybu kanału”). Kanał woła worker (zadania), nie akcja serwera.
// „Połącz z WooCommerce” (wc-auth, lib/kanaly/woo-autoryzacja.ts): akcja tylko przekierowuje przeglądarkę do
// strony zatwierdzenia w sklepie; klucze przychodzą od serwera sklepu na /api/kanaly/woo/klucze. „Użyj” przy polu
// zamówienia wykrytym w teście połączenia.
// Komunikaty błędów: tylko nasze teksty (KontoError), nigdy wartości sekretów ani treść odpowiedzi kanału.
import { revalidatePath } from 'next/cache'
import { notFound, redirect } from 'next/navigation'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { anulujAutoryzacje, funkcjeZFormularza, rozpocznijAutoryzacje, sprawdzAutoryzacje, type WynikSprawdzenia } from '@/lib/kanaly/allegro-autoryzacja'
import { appModeOf } from '@/lib/organizacje'
import { DOMYSLNE_FUNKCJE_ALLEGRO } from '@/lib/zrodla/allegro-zakresy'
import { firmaMaBlWPanelu, firmaMaWfirme, firmaPrzechodziZBlWPanelu } from '@/lib/kanaly/firma'
import { blokadaInstancji, type TrybDocelowy, ustawWystawianieOfertKonta, ustawZapisKonta, zmienTrybKonta } from '@/lib/kanaly/tryb'
import { anulujWooAuth, czyZakresWoo, rozpocznijWooAuth } from '@/lib/kanaly/woo-autoryzacja'
import { dodajKonto, KontoError, kodKonta, type KontoRef, parseKodKonta, SekretyNieZapisaneError, uzyjPolaMeta, wylaczKonto, zapiszSekrety, zmienKonto } from '@/lib/kanaly/konta'
import { przypiszOferte, utworzProduktZOferty } from '@/lib/kanaly/oferty'
import { zlecPobranieOfert, zlecTestPolaczenia, zlecTestPoNaprawie, zlecWlaczenieKonta } from '@/lib/kanaly/zadania'
import { requirePermission } from '@/lib/panel/kontekst'

const registry = defaultRegistry()
const BASE = '/ustawienia/kanaly'

function formFields(form: FormData): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of form.entries()) if (typeof v === 'string' && !k.startsWith('$') && k !== 'konto' && k !== 'nazwa' && k !== 'rodzaj') out[k] = v
  return out
}

function msgOf(e: unknown): string {
  if (e instanceof KontoError) return e.message.slice(0, 300)
  // błędy bazy i inne: bez szczegółów (mogłyby nieść dane wejściowe)
  return 'Nie udało się zapisać, spróbuj ponownie'
}

function back(ref: KontoRef | null, q: Record<string, string>): never {
  const path = ref ? `${BASE}/${encodeURIComponent(kodKonta(ref))}` : BASE
  revalidatePath(BASE)
  if (ref) revalidatePath(path)
  redirect(`${path}?${new URLSearchParams(q)}`)
}

function refOf(form: FormData): KontoRef {
  const ref = parseKodKonta(String(form.get('konto') ?? ''))
  if (!ref) redirect(BASE)
  return ref
}

export async function dodajSklep(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  const adapterKey = String(form.get('rodzaj') ?? '')
  let ref: KontoRef | null = null
  let blad: string | null = null
  try {
    ref = await dodajKonto(ctx.db, { adapterKey, name: String(form.get('nazwa') ?? ''), form: formFields(form) }, { actorId: ctx.user.id, env: process.env, registry })
  } catch (e) {
    // konto już jest, tylko klucze nie weszły — ekran konta, nie drugi formularz (dubel)
    if (e instanceof SekretyNieZapisaneError) back(e.ref, { blad: e.message })
    blad = msgOf(e)
  }
  if (!ref) redirect(`${BASE}/nowy?${new URLSearchParams({ rodzaj: adapterKey, blad: blad ?? 'Nie udało się zapisać' })}`)
  // od razu „Sprawdź połączenie” (Allegro najpierw potrzebuje połączenia z kontem, test zleci się po nim)
  if (ref.channel === 'ALLEGRO') {
    let link = true
    try {
      await rozpocznijAutoryzacje(ctx.db, ref, DOMYSLNE_FUNKCJE_ALLEGRO, { src: zrodloSekretow(), actorId: ctx.user.id })
    } catch {
      link = false // np. zły Client Secret: ekran konta pokaże „Połącz z Allegro” i powód przy ponownej próbie
    }
    back(ref, { zapisano: link ? 'dodano-allegro' : 'dodano-allegro-blad' })
  }
  try {
    await zlecTestPolaczenia(ctx.db, ref)
  } catch {
    back(ref, { zapisano: 'dodano' })
  }
  back(ref, { zapisano: 'dodano-test' })
}

export async function zapiszUstawienia(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  const ref = refOf(form)
  try {
    await zmienKonto(ctx.db, ref, { name: String(form.get('nazwa') ?? ''), form: formFields(form) }, { actorId: ctx.user.id, env: process.env, registry })
  } catch (e) {
    back(ref, { blad: msgOf(e) })
  }
  await poNaprawie(ctx.db, ref)
  back(ref, { zapisano: 'ustawienia' })
}

/**
 * po zapisie kluczy albo ustawień konto wyłączone po błędach od razu dostaje „Włącz
 * ponownie” (test połączenia w kolejce). Konto działające: nic. Błąd zlecenia nie psuje zapisu (klucze już są).
 */
async function poNaprawie(db: Parameters<typeof zlecTestPoNaprawie>[0], ref: ReturnType<typeof refOf>): Promise<void> {
  try {
    await zlecTestPoNaprawie(db, ref, new Date(), { zwyklyTest: false })
  } catch (e) {
    console.warn(`[integracje] ${ref.channel}/${ref.channelAccountId}: nie zlecono „Włącz ponownie” po zapisie (${e instanceof Error ? e.name : 'błąd'})`)
  }
}

export async function zapiszKlucze(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  const ref = refOf(form)
  let names: string[] = []
  try {
    names = await zapiszSekrety(ctx.db, ref, formFields(form), { actorId: ctx.user.id, env: process.env, registry })
  } catch (e) {
    back(ref, { blad: msgOf(e) })
  }
  if (names.length) await poNaprawie(ctx.db, ref)
  back(ref, names.length ? { zapisano: 'klucze' } : { blad: 'Nie wklejono żadnego nowego klucza' })
}

export async function ustawAktywne(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  const ref = refOf(form)
  try {
    await wylaczKonto(ctx.db, ref, form.get('aktywne') === 'tak', { actorId: ctx.user.id })
  } catch (e) {
    back(ref, { blad: msgOf(e) })
  }
  back(ref, { zapisano: form.get('aktywne') === 'tak' ? 'wlaczono' : 'wylaczono' })
}

export async function sprawdzPolaczenie(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  const ref = refOf(form)
  let r: 'ZLECONO' | 'ZA_CZESTO' = 'ZA_CZESTO'
  try {
    r = await zlecTestPolaczenia(ctx.db, ref)
  } catch (e) {
    back(ref, { blad: msgOf(e) })
  }
  back(ref, r === 'ZLECONO' ? { zapisano: 'test' } : { blad: 'Test tego konta był przed chwilą. Spróbuj za pół minuty.' })
}

/** „Włącz ponownie” konta wyłączonego po błędach (najpierw test połączenia w kolejce, potem włączenie). */
export async function wlaczPonownie(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  const ref = refOf(form)
  let ok = false
  try {
    ok = await zlecWlaczenieKonta(ctx.db, ref)
  } catch (e) {
    back(ref, { blad: msgOf(e) })
  }
  back(ref, ok ? { zapisano: 'wlaczanie' } : { blad: 'To konto nie jest wyłączone po błędach.' })
}

export async function pobierzOfertyKonta(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  const ref = refOf(form)
  let r: 'ZLECONO' | 'ZA_CZESTO' = 'ZA_CZESTO'
  try {
    r = await zlecPobranieOfert(ctx.db, ref)
  } catch (e) {
    back(ref, { blad: msgOf(e) })
  }
  back(ref, r === 'ZLECONO' ? { zapisano: 'oferty' } : { blad: 'Pobranie ofert tego konta było przed chwilą. Spróbuj za pół minuty.' })
}

export async function przypisz(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  const ref = refOf(form)
  const externalId = String(form.get('oferta') ?? '')
  const sku = String(form.get('sku') ?? '').trim()
  const qty = Number(String(form.get('sztuk') ?? '1').trim() || '1')
  let remapped = 0
  try {
    const p = sku ? await ctx.db.product.findFirst({ where: { sku, active: true }, select: { id: true } }) : null
    if (!p) throw new KontoError(sku ? `Nie ma produktu o SKU „${sku.slice(0, 60)}”` : 'Podaj SKU produktu')
    remapped = (await przypiszOferte(ctx.db, ref, { externalId, productId: p.id, qtyBasePerOffer: qty }, { actorId: ctx.user.id })).remapped
  } catch (e) {
    back(ref, { blad: msgOf(e) })
  }
  revalidatePath('/zamowienia')
  back(ref, { zapisano: 'przypisano', zamowien: String(remapped) })
}

export async function utworzProdukt(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  const ref = refOf(form)
  let remapped = 0
  try {
    remapped = (await utworzProduktZOferty(ctx.db, ref, String(form.get('oferta') ?? ''), { actorId: ctx.user.id, hasWfirma: await firmaMaWfirme(ctx.db) })).remapped
  } catch (e) {
    back(ref, { blad: msgOf(e) })
  }
  revalidatePath('/produkty')
  revalidatePath('/zamowienia')
  back(ref, { zapisano: 'produkt', zamowien: String(remapped) })
}

const zrodloSekretow = () => ({ env: process.env, envFallback: appModeOf(process.env) === 'self-host' })

/** „Połącz z Allegro”: kod urządzenia i link; ekran konta pokazuje link i sam odpytuje o wynik. */
export async function polaczZAllegro(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  const ref = refOf(form)
  try {
    await rozpocznijAutoryzacje(ctx.db, ref, funkcjeZFormularza(form.getAll('funkcja')), { src: zrodloSekretow(), actorId: ctx.user.id })
  } catch (e) {
    back(ref, { blad: msgOf(e) })
  }
  back(ref, { zapisano: 'allegro-link' })
}

/** Jedno odpytanie o wynik połączenia z Allegro (woła je ekran konta co kilka sekund). */
export async function sprawdzAllegro(kod: string): Promise<WynikSprawdzenia> {
  const ctx = await requirePermission('ustawienia')
  const ref = parseKodKonta(kod)
  if (!ref || ref.channel !== 'ALLEGRO') return { stan: 'brak', komunikat: 'Nie ma takiego konta' }
  try {
    const w = await sprawdzAutoryzacje(ctx.db, ref, { src: zrodloSekretow(), actorId: ctx.user.id })
    if (w.stan !== 'czeka') revalidatePath(`${BASE}/${encodeURIComponent(kodKonta(ref))}`)
    return w
  } catch (e) {
    return { stan: 'blad', komunikat: msgOf(e) }
  }
}

export async function anulujAllegro(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  const ref = refOf(form)
  let w: Awaited<ReturnType<typeof anulujAutoryzacje>> = 'BRAK'
  try {
    w = await anulujAutoryzacje(ctx.db, ref, ctx.user.id, process.env)
  } catch (e) {
    back(ref, { blad: msgOf(e) })
  }
  back(ref, { zapisano: w === 'ZAPISANE' ? 'allegro-zdazylo' : 'allegro-anulowane' })
}

/**
 * Przełączenie trybu konta (Tylko podgląd / Aktywny / Aktywny bez stanów). Warunki liczy lib/kanaly/tryb.ts
 * od nowa. Nieznana wartość = podgląd (bezpieczny kierunek, jak dotąd).
 */
export async function zmienTryb(form: FormData): Promise<void> {
  const ctx = await requirePermission('kanaly.tryb')
  if (!ctx.permissions.has('ustawienia')) notFound() // ekran konta wymaga obu (jak requirePermission: 404)
  const ref = refOf(form)
  const t = form.get('tryb')
  const tryb: TrybDocelowy = t === 'PRACA' ? 'PRACA' : t === 'BEZ_STANOW' ? 'BEZ_STANOW' : 'CIEN'
  try {
    await zmienTrybKonta(ctx.db, ref, tryb, { actorId: ctx.user.id, env: process.env, registry, firmaZBl: await firmaPrzechodziZBlWPanelu(ctx.db) })
  } catch (e) {
    back(ref, { blad: msgOf(e) })
  }
  revalidatePath('/zamowienia')
  back(ref, { zapisano: tryb === 'PRACA' ? 'tryb-praca' : tryb === 'BEZ_STANOW' ? 'tryb-bez-stanow' : 'tryb-podglad' })
}

/**
 * Wyłącznik „Zapis do sklepu” (przełącznik w sekcji „Zapis do sklepu”, nie pole
 * w „Zaawansowane”). Warunki włączenia liczy lib/kanaly/tryb.ts od nowa; wyłączyć wolno zawsze.
 */
export async function ustawZapis(form: FormData): Promise<void> {
  const ctx = await requirePermission('kanaly.tryb')
  if (!ctx.permissions.has('ustawienia')) notFound() // ekran konta wymaga obu (jak requirePermission: 404)
  const ref = refOf(form)
  const wlacz = form.get('zapis') === 'tak'
  let bezPracy = false
  try {
    const firmaZBl = await firmaPrzechodziZBlWPanelu(ctx.db)
    // instancja bez trybu pracy dla tej firmy = zapis włączony, ale nic nie wyjdzie
    bezPracy = wlacz && !!blokadaInstancji(process.env, firmaZBl)
    await ustawZapisKonta(ctx.db, ref, wlacz, { actorId: ctx.user.id, registry, env: process.env, firmaZBl })
  } catch (e) {
    back(ref, { blad: msgOf(e) })
  }
  back(ref, { zapisano: wlacz ? (bezPracy ? 'zapis-wlaczony-bez-pracy' : 'zapis-wlaczony') : 'zapis-wylaczony' })
}

/** osobny przełącznik wystawiania ofert (te same uprawnienia co zapis do sklepu). */
export async function ustawWystawianie(form: FormData): Promise<void> {
  const ctx = await requirePermission('kanaly.tryb')
  if (!ctx.permissions.has('ustawienia')) notFound()
  const ref = refOf(form)
  const wlacz = form.get('wystawianie') === 'tak'
  try {
    await ustawWystawianieOfertKonta(ctx.db, ref, wlacz, { actorId: ctx.user.id, registry })
  } catch (e) {
    back(ref, { blad: msgOf(e) })
  }
  back(ref, { zapisano: wlacz ? 'wystawianie-wlaczone' : 'wystawianie-wylaczone' })
}

/** jeden zapis ekranu konta (nazwa, ustawienia i nowe klucze naraz). Puste pole klucza = bez zmiany. */
export async function zapiszKonto(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  const ref = refOf(form)
  const opts = { actorId: ctx.user.id, env: process.env, registry }
  let names: string[] = []
  try {
    await zmienKonto(ctx.db, ref, { name: String(form.get('nazwa') ?? ''), form: formFields(form) }, opts)
    names = await zapiszSekrety(ctx.db, ref, formFields(form), opts)
  } catch (e) {
    back(ref, { blad: msgOf(e) })
  }
  await poNaprawie(ctx.db, ref)
  back(ref, { zapisano: names.length ? 'konto-klucze' : 'ustawienia' })
}

/** Zakres z formularza: „read_write” tylko wprost, wszystko inne = odczyt. */
const zakresZFormularza = (form: FormData) => {
  const z = form.get('zakres')
  return czyZakresWoo(z) ? z : 'read'
}

/** „Połącz z WooCommerce” na ekranie konta: przekierowanie do strony zatwierdzenia w sklepie. */
export async function polaczZWoo(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  const ref = refOf(form)
  let url: string | null = null
  try {
    url = await rozpocznijWooAuth(ctx.db, ref, zakresZFormularza(form), { env: process.env, actorId: ctx.user.id, registry })
  } catch (e) {
    back(ref, { blad: msgOf(e) })
  }
  redirect(url!)
}

/** Kreator „Dodaj sklep → WooCommerce”: konto z adresem (bez kluczy) i od razu strona zatwierdzenia w sklepie. */
export async function dodajIPolaczZWoo(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  const adapterKey = String(form.get('rodzaj') ?? '')
  let ref: KontoRef | null = null
  let blad: string | null = null
  try {
    // klucze z formularza pomijamy: przyjdą ze sklepu (ręczne wklejenie to drugi przycisk, `dodajSklep`)
    const pola = Object.fromEntries(Object.entries(formFields(form)).filter(([k]) => !/^WOO_/.test(k)))
    ref = await dodajKonto(ctx.db, { adapterKey, name: String(form.get('nazwa') ?? ''), form: pola }, { actorId: ctx.user.id, env: process.env, registry })
  } catch (e) {
    blad = msgOf(e)
  }
  if (!ref) redirect(`${BASE}/nowy?${new URLSearchParams({ platforma: 'woo', ...(adapterKey ? { rodzaj: adapterKey } : {}), blad: blad ?? 'Nie udało się zapisać' })}`)
  if (ref.channel !== 'WOO') back(ref, { zapisano: 'dodano' })
  let url: string | null = null
  try {
    url = await rozpocznijWooAuth(ctx.db, ref, 'read', { env: process.env, actorId: ctx.user.id, registry })
  } catch (e) {
    back(ref, { blad: `Konto zapisane, ale nie udało się otworzyć sklepu: ${msgOf(e)}` })
  }
  redirect(url!)
}

export async function anulujWoo(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  const ref = refOf(form)
  try {
    await anulujWooAuth(ctx.db, ref, ctx.user.id)
  } catch (e) {
    back(ref, { blad: msgOf(e) })
  }
  back(ref, { zapisano: 'woo-anulowane' })
}

/** „Użyj” przy polu zamówienia wykrytym w ostatnich zamówieniach (NIP, punkt odbioru, „chcę fakturę”). */
export async function uzyjPola(form: FormData): Promise<void> {
  const ctx = await requirePermission('ustawienia')
  const ref = refOf(form)
  let w: 'ZMIENIONO' | 'BEZ_ZMIAN' = 'BEZ_ZMIAN'
  try {
    w = await uzyjPolaMeta(ctx.db, ref, String(form.get('pole') ?? ''), String(form.get('klucz') ?? '').slice(0, 100), { actorId: ctx.user.id, env: process.env, registry })
  } catch (e) {
    back(ref, { blad: msgOf(e) })
  }
  back(ref, { zapisano: w === 'ZMIENIONO' ? 'pole-meta' : 'pole-meta-bez-zmian' })
}
