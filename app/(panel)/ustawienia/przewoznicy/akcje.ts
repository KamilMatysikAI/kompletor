'use server'
// Ustawienia → Przewoźnicy (jednym zapisem): godziny odbioru wszystkich przewoźników i reguły
// „sposób dostawy → przewoźnik → moduł wysyłki”. Tylko z uprawnieniem ustawień firmy. Najpierw walidacja całego
// formularza (błąd przy polu), potem zapis: odbiory tylko zmienione, reguły całą listą (lib/wysylka/reguly.ts).
import { revalidatePath } from 'next/cache'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { formatHm, parseHm, PICKUP_CARRIERS } from '@/lib/pakowanie/harmonogram'
import { pickupSettings, saveCarrierPickup } from '@/lib/pakowanie/dane'
import { requirePermission } from '@/lib/panel/kontekst'
import { wzorzecZPola } from '@/lib/panel/slowa'
import { kontaPrzewoznikow } from '@/lib/wysylka/konta'
import { regulyPrzewoznikow, RegulyError, zapiszRegulyPrzewoznikow, type RegulaPanelu } from '@/lib/wysylka/reguly'

const registry = defaultRegistry()

export interface StanPrzewoznikow {
  ok?: boolean
  komunikat?: string
  /** id pola z błędem (`odbior-DPD-od`, `regula-2-slowa`) */
  pole?: string
  /** reguły po zapisie (nowe dostają id) */
  reguly?: RegulaPanelu[]
}

const str = (form: FormData, k: string) => String(form.get(k) ?? '')

export async function zapiszPrzewoznikow(_prev: StanPrzewoznikow, form: FormData): Promise<StanPrzewoznikow> {
  const ctx = await requirePermission('ustawienia')
  // 1. odbiory: walidacja wszystkich
  const teraz = await pickupSettings(ctx.db)
  const odbiory = []
  for (const carrier of PICKUP_CARRIERS) {
    if (form.get(`odbior-${carrier}-jest`) !== 'tak') continue
    const od = parseHm(str(form, `odbior-${carrier}-od`))
    const wys = parseHm(str(form, `odbior-${carrier}-wyslemy`))
    if (od === null) return { ok: false, komunikat: 'Godzina odbioru w formacie GG:MM, np. 13:00', pole: `odbior-${carrier}-od` }
    if (wys === null) return { ok: false, komunikat: 'Godzina w formacie GG:MM, np. 12:00', pole: `odbior-${carrier}-wyslemy` }
    if (wys > od) return { ok: false, komunikat: '„Wyślemy dziś do” nie może być później niż odbiór', pole: `odbior-${carrier}-wyslemy` }
    const s = { carrier, weekdays: form.getAll(`odbior-${carrier}-dni`).map(Number).filter((d) => d >= 1 && d <= 7), pickupMinute: od, promiseUntilMinute: wys, active: form.get(`odbior-${carrier}-aktywny`) === 'tak', example: false }
    const cur = teraz.find((t) => t.carrier === carrier)
    const zmiana = !cur || cur.active !== s.active || formatHm(cur.pickupMinute) !== formatHm(od) || formatHm(cur.promiseUntilMinute) !== formatHm(wys) || [...cur.weekdays].sort().join() !== [...s.weekdays].sort().join()
    if (zmiana) odbiory.push(s)
  }
  // 2. reguły: wiersze w kolejności z formularza
  const ids = form.getAll('regula-id').map(String)
  const kanaly = form.getAll('regula-kanal').map(String)
  const tryby = form.getAll('regula-tryb').map(String)
  const slowa = form.getAll('regula-slowa').map(String)
  const przewoznicy = form.getAll('regula-przewoznik').map(String)
  const moduly = form.getAll('regula-modul').map(String)
  const konta = form.getAll('regula-konto').map(String)
  const wiersze = ids.map((id, i) => ({ id: id || null, channel: kanaly[i] ?? '', pattern: wzorzecZPola(tryby[i] ?? 'slowa', slowa[i] ?? ''), carrier: przewoznicy[i] ?? '', adapterKey: moduly[i] ?? '', konto: konta[i] ?? '' }))
  try {
    // reguły najpierw: ich zapis sprawdza całą listę przed pierwszą zmianą (jedna transakcja); czy coś
    // się zmieniło, porównuje serwer z bazą (nie przeglądarka)
    const { zmienione, przeniesione } = await zapiszRegulyPrzewoznikow(ctx.db, registry, wiersze, ctx.user.id, { usunZKonfiguracja: form.getAll('regula-usun-potwierdzone').map(String) })
    for (const s of odbiory) await saveCarrierPickup(ctx.db, s, ctx.user.id)
    revalidatePath('/ustawienia/przewoznicy')
    revalidatePath('/pakowanie')
    const co = [odbiory.length ? `odbiory (${odbiory.length})` : null, zmienione ? 'reguły przewoźników' : null].filter(Boolean).join(' i ')
    // reguła przeniesiona na inne konto traci ustawienia poprzedniego konta i ma wyłączone nadawanie
    let przypomnienie = ''
    if (przeniesione.length) {
      const konta = await kontaPrzewoznikow(ctx.db, registry)
      const nazwa = (p: (typeof przeniesione)[number]) => konta.find((k) => k.sufiks === p.konto && (!p.adapterKey || k.moduly.includes(p.adapterKey)))?.nazwa ?? (p.konto ? `konto ${p.konto}` : 'konto główne')
      przypomnienie = ` ${przeniesione.map((p) => `Reguła ${p.nr} przeniesiona na: ${nazwa(p)}.`).join(' ')} Uzupełnij ustawienia konta i włącz nadawanie na ekranie Konta przewoźników.`
    }
    return { ok: true, komunikat: (co ? `Zapisano: ${co}.` : 'Nic się nie zmieniło.') + przypomnienie, reguly: await regulyPrzewoznikow(ctx.db, registry) }
  } catch (e) {
    if (e instanceof RegulyError) return { ok: false, komunikat: e.message, pole: e.pole }
    // komunikaty walidacji (zwykły Error) pokazujemy; błąd bazy — bez szczegółów
    return { ok: false, komunikat: e instanceof Error && e.constructor === Error ? e.message : 'Nie udało się zapisać — spróbuj ponownie' }
  }
}
