// Przeprowadzka z BL: statusy BL → statusy firmy (nazwa, kolor, nazwa dla klienta, grupa) i automatyczne
// akcje. Czyste funkcje; zapis robi `zapiszKonfiguracje` (zapis.ts), raport pokazuje plan w trybie próbnym.
//
// Etap rdzenia każdego statusu = decyzja z mapy statusów (statusy.ts: wzorce nazw, plik/ekran decyzji). Status bez
// pewnego dopasowania („do decyzji”) trafia do listy „do potwierdzenia”: etap wybiera człowiek w sekcji „Decyzje”
// przed importem (ta sama blokada co dotąd: status do decyzji z otwartymi zamówieniami zatrzymuje zapis).
//
// Klucz statusu firmy = `BL_<id statusu BL>`, klucz grupy = `BL_G<id grupy BL>`: drugi przebieg rozpoznaje to, co już
// jest, i niczego nie dubluje ani nie nadpisuje (zmiany zrobione potem w panelu zostają).
//
// Automaty: API BaseLinkera nie udostępnia odczytu automatycznych akcji (lista metod api.baselinker.com, sprawdzona
// 09.11.2026: są tylko `runOrderMacroTrigger` i pokrewne do uruchomienia własnego wyzwalacza). Dlatego przeprowadzka
// dobiera najbliższy szablon przepływu (lib/automaty/szablony.ts) do przeniesionych statusów i zakłada jego reguły
// w wyłączonej grupie „Z BaseLinkera”, z raportem, co przeszło i czego nie.
import type { OrderStatus } from '@prisma/client'
import { DOMYSLNE_STATUSY, MAX_GRUP, MAX_STATUSOW, STATUS_ZAMOWIENIA, sortujStatusy, validateZestawStatusow, type GrupaStatusowT, type KolorStatusu, type StatusFirmyT } from '@/lib/panel/statusy'
import { kontekstZ } from '@/lib/automaty/dane'
import { krokiNigdyDozwolone, parsujRegule } from '@/lib/automaty/schemat'
import { przepiszRegule, statusFirmyDla, statusyNietkniete, szablonPrzeplywu, type SzablonPrzeplywu } from '@/lib/automaty/szablony'
import type { RegulaGotowa } from '@/lib/automaty/szablon'
import type { DecyzjaStatusu } from './statusy'

export const GRUPA_AUTOMATOW_BL = 'Z BaseLinkera'

/**
 * Znacznik automatów z przeprowadzki w `settings.baselinker.przeprowadzka.automaty`: reguły
 * szablonu zakłada tylko pierwszy zapis. Rozpoznanie po znaczniku, nie po nazwie grupy: użytkownik może grupę
 * przemianować, usunąć z niej reguły albo skasować ją całą, a kolejny import niczego nie dołoży. Nazwa grupy
 * „Z BaseLinkera” to tylko etykieta.
 */
export interface ZnacznikAutomatowBl {
  szablon: string
  grupaId: string | null
  reguly: number
  kiedy: string
}

/** Znacznik z ustawień organizacji (całe `settings`); brak albo zły kształt = null. */
export function znacznikAutomatowBl(settings: unknown): ZnacznikAutomatowBl | null {
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
  const o = obj(obj(obj(obj(settings)['baselinker'])['przeprowadzka'])['automaty'])
  if (typeof o['szablon'] !== 'string' || typeof o['kiedy'] !== 'string') return null
  return { szablon: o['szablon'], grupaId: typeof o['grupaId'] === 'string' ? o['grupaId'] : null, reguly: typeof o['reguly'] === 'number' ? o['reguly'] : 0, kiedy: o['kiedy'] }
}

/**
 * Kolor hex z BL (np. „#1C8752”) → kolor palety firmy po odcieniu (paleta ma kontrast ≥ 4,5:1, więc dokładnego koloru
 * nie przenosimy). Szarości, czerń i biel = szary; ciemny pomarańcz albo czerwień o niskim nasyceniu = brązowy.
 * Zły hex = szary.
 */
export function kolorZHex(hex: string | null | undefined): KolorStatusu {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec((hex ?? '').trim())
  if (!m) return 'szary'
  const h6 = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h6.slice(i, i + 2), 16) / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  const sat = max === 0 ? 0 : d / max
  if (d < 0.12 || sat < 0.18) return 'szary'
  let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  hue = (hue * 60 + 360) % 360
  if (hue >= 10 && hue < 45 && (max < 0.62 || sat < 0.45)) return 'brazowy'
  if (hue < 12 || hue >= 345) return 'czerwony'
  if (hue < 42) return 'pomaranczowy'
  if (hue < 68) return 'zolty'
  if (hue < 160) return 'zielony'
  if (hue < 200) return 'turkusowy'
  if (hue < 255) return 'niebieski'
  if (hue < 290) return 'fioletowy'
  return 'rozowy'
}

export const kluczStatusuBl = (id: string) => `BL_${id.replace(/[^0-9A-Za-z]/g, '').toUpperCase()}`.slice(0, 40)
export const kluczGrupyBl = (id: string) => `BL_G${id.replace(/[^0-9A-Za-z]/g, '').toUpperCase()}`.slice(0, 40)

export interface StatusZBl {
  blStatusId: string
  klucz: string
  nazwa: string
  nazwaDlaKlienta: string | null
  kolor: KolorStatusu
  grupa: string | null
  etap: OrderStatus
  /** etap nie jest pewny: człowiek potwierdza go w „Decyzjach” (status BL do decyzji) */
  doPotwierdzenia: boolean
  powod: string
  /** status już jest w firmie (drugi przebieg albo ręcznie założony z tym kluczem): zostaje bez zmian */
  juzJest: boolean
  /** kolejność jak w BL; przy statusach własnych firmy na końcu jej listy */
  sortOrder: number
}

export interface PlanStatusowFirmy {
  statusy: StatusZBl[]
  grupy: GrupaStatusowT[]
  /** Domyślne statusy firmy, które zostaną ukryte (etap ma status z BL, firma nie zmieniała domyślnych). */
  ukryteDomyslne: string[]
  /** Id statusu BL → klucz statusu firmy (zapis w ustawieniach dla cienia i kopii statusów). */
  mapa: Record<string, string>
  ostrzezenia: string[]
}

/**
 * Plan statusów firmy z decyzji statusów BL. `istniejace` = statusy i grupy firmy teraz. Statusy firmy nietknięte
 * (domyślne) z etapem pokrytym przez BL zostają ukryte, żeby lista zamówień pokazywała nazwy z BL; firma z własnymi
 * statusami nie traci żadnego (nowe statusy dochodzą na koniec kolejności).
 */
export function planStatusowFirmy(decyzje: readonly DecyzjaStatusu[], istniejace: { statusy: readonly StatusFirmyT[]; grupy: readonly GrupaStatusowT[] }): PlanStatusowFirmy {
  const ostrzezenia: string[] = []
  const nietkniete = statusyNietkniete(istniejace.statusy)
  const kluczeIst = new Set(istniejace.statusy.map((s) => s.key))
  const grupyIst = new Map(istniejace.grupy.map((g) => [g.key, g]))
  const start = nietkniete ? 0 : Math.max(0, ...istniejace.statusy.map((s) => s.sortOrder))
  const grupy: GrupaStatusowT[] = []
  const grupaPoId = new Map<string, string>()
  let wolneStatusy = MAX_STATUSOW - istniejace.statusy.length
  let wolneGrupy = MAX_GRUP - istniejace.grupy.length
  const startGrup = Math.max(0, ...istniejace.grupy.map((g) => g.sortOrder))
  const statusy: StatusZBl[] = []
  for (const [i, d] of decyzje.entries()) {
    const klucz = kluczStatusuBl(d.blStatusId)
    const juzJest = kluczeIst.has(klucz)
    if (!juzJest && wolneStatusy <= 0) {
      ostrzezenia.push(`Status „${d.nazwa}” nie przejdzie: firma może mieć najwyżej ${MAX_STATUSOW} statusów. Zamówienia z nim będą widoczne pod nazwą etapu.`)
      continue
    }
    let grupa: string | null = null
    if (d.grupaId || d.grupa) {
      const gk = d.grupaId ? kluczGrupyBl(d.grupaId) : kluczGrupyBl(`N${[...(d.grupa ?? '')].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36)}`)
      if (grupyIst.has(gk) || grupaPoId.has(gk)) grupa = gk
      else if (wolneGrupy > 0) {
        grupy.push({ key: gk, name: (d.grupa ?? `Grupa ${d.grupaId}`).trim().slice(0, 40), sortOrder: startGrup + (grupy.length + 1) * 10, collapsed: false })
        grupaPoId.set(gk, gk)
        wolneGrupy--
        grupa = gk
      } else ostrzezenia.push(`Grupa „${d.grupa}” nie przejdzie: firma może mieć najwyżej ${MAX_GRUP} grup statusów.`)
    }
    if (!juzJest) wolneStatusy--
    statusy.push({
      blStatusId: d.blStatusId,
      klucz,
      nazwa: (d.nazwa.trim() || `Status ${d.blStatusId}`).slice(0, 40),
      nazwaDlaKlienta: d.nazwaDlaKlienta?.trim().slice(0, 60) || null,
      kolor: d.status === 'ANULOWANE' && !d.kolor ? 'czerwony' : kolorZHex(d.kolor),
      grupa,
      etap: d.status,
      doPotwierdzenia: d.pewnosc === 'DO_DECYZJI',
      powod: d.powod,
      juzJest,
      sortOrder: start + (i + 1) * 10,
    })
  }
  const etapyBl = new Set(statusy.map((s) => s.etap))
  const ukryteDomyslne = nietkniete && istniejace.statusy.length ? DOMYSLNE_STATUSY.filter((d) => etapyBl.has(d.baseStatus)).map((d) => d.key) : []
  const mapa = Object.fromEntries(statusy.map((s) => [s.blStatusId, s.klucz]))
  return { statusy, grupy, ukryteDomyslne, mapa, ostrzezenia }
}

/** Statusy firmy po zapisie planu (do walidacji zestawu, dopasowania szablonu i testów). */
export function statusyPoPlanie(plan: PlanStatusowFirmy, istniejace: { statusy: readonly StatusFirmyT[]; grupy: readonly GrupaStatusowT[] }): { statusy: StatusFirmyT[]; grupy: GrupaStatusowT[] } {
  const ukryte = new Set(plan.ukryteDomyslne)
  const stare = istniejace.statusy.map((s) => ({ ...s, active: ukryte.has(s.key) ? false : s.active }))
  const nowe: StatusFirmyT[] = plan.statusy
    .filter((s) => !s.juzJest)
    .map((s) => ({ key: s.klucz, name: s.nazwa, customerName: s.nazwaDlaKlienta, color: s.kolor, groupKey: s.grupa, sortOrder: s.sortOrder, baseStatus: s.etap, carriers: [], active: true }))
  return { statusy: sortujStatusy([...stare, ...nowe]), grupy: sortujStatusy([...istniejace.grupy, ...plan.grupy]) }
}

/** Wiersze statusów do zapisu (nowe, bez tych, które już są). */
export function statusyDoZapisu(plan: PlanStatusowFirmy): StatusFirmyT[] {
  return statusyPoPlanie(plan, { statusy: [], grupy: [] }).statusy
}

/** Firma bez żadnych statusów dostaje domyślne na etapach, których BL nie pokrył (każdy etap musi mieć status). */
export function uzupelnienieEtapow(plan: PlanStatusowFirmy, istniejace: readonly StatusFirmyT[]): StatusFirmyT[] {
  if (istniejace.length) return []
  const etapy = new Set(plan.statusy.map((s) => s.etap))
  return DOMYSLNE_STATUSY.filter((d) => !etapy.has(d.baseStatus)).map((d) => ({ ...d, groupKey: null, carriers: [], sortOrder: 1000 + d.sortOrder }))
}

// ─── Automaty: najbliższy szablon ────────────────────────────────────────────

export interface PlanAutomatow {
  szablon: { id: string; nazwa: string } | null
  powod: string
  przeniesione: string[]
  nieprzeniesione: { nazwa: string; powod: string }[]
  /** poprzedni zapis już założył reguły (znacznik w ustawieniach, nie nazwa grupy): drugi przebieg nic nie dokłada */
  juzJest: boolean
  reguly: RegulaGotowa[]
}

/**
 * Najbliższy szablon do statusów BL: bez etapów wysyłki i odbioru = „bez wysyłki”; tylko odbiór (bez wysyłki) =
 * „odbiór osobisty”; same źródła Allegro = „Allegro z Wysyłam z Allegro”; inaczej „kurier i paczkomaty”.
 */
export function dobierzSzablon(etapy: ReadonlySet<OrderStatus>, zrodla: readonly { typ: string }[]): { szablon: SzablonPrzeplywu; powod: string } {
  const wysylka = ['ZBIERANIE', 'ZEBRANE', 'SPAKOWANE', 'DO_WYSLANIA', 'WYSLANE'].some((e) => etapy.has(e as OrderStatus))
  const odbior = etapy.has('DO_ODBIORU')
  const typy = new Set(zrodla.map((z) => z.typ.toLowerCase()))
  const tylkoAllegro = typy.size > 0 && [...typy].every((t) => t === 'allegro' || t === 'personal')
  if (!wysylka && !odbior) return { szablon: szablonPrzeplywu('bez-wysylki')!, powod: 'statusy BL nie mają etapów magazynu ani wysyłki' }
  if (!wysylka && odbior) return { szablon: szablonPrzeplywu('odbior-osobisty')!, powod: 'statusy BL mają odbiór osobisty bez wysyłki' }
  if (tylkoAllegro) return { szablon: szablonPrzeplywu('allegro-wysylam-z-allegro')!, powod: 'zamówienia przychodzą tylko z Allegro' }
  return { szablon: szablonPrzeplywu('kurier-i-paczkomaty')!, powod: 'statusy BL mają etapy pakowania i wysyłki' }
}

/** Reguły najbliższego szablonu przepisane na statusy firmy po imporcie (zawsze wyłączone). */
export function planAutomatow(statusyFirmy: readonly StatusFirmyT[], etapy: ReadonlySet<OrderStatus>, zrodla: readonly { typ: string }[], juzZalozone: boolean): PlanAutomatow {
  const { szablon, powod } = dobierzSzablon(etapy, zrodla)
  const juzJest = juzZalozone
  const mapa = new Map(szablon.statuses.map((s) => [s.key, statusFirmyDla(s, statusyFirmy)]))
  const k = kontekstZ(statusyFirmy)
  const reguly: RegulaGotowa[] = []
  const przeniesione: string[] = []
  const nieprzeniesione: { nazwa: string; powod: string }[] = []
  for (const r of szablon.automationRules) {
    const p = parsujRegule(przepiszRegule(r, mapa), k)
    const nigdy = p.ok ? krokiNigdyDozwolone(p.regula, k) : []
    if (!p.ok || nigdy.length) nieprzeniesione.push({ nazwa: r.name, powod: p.ok ? nigdy[0]!.komunikat : (p.bledy[0]?.komunikat ?? 'nie pasuje do statusów firmy') })
    else {
      reguly.push({ ...r, ...p.regula, enabled: false })
      przeniesione.push(r.name)
    }
  }
  return { szablon: { id: szablon.id, nazwa: szablon.nazwa }, powod, przeniesione, nieprzeniesione, juzJest, reguly }
}

/** Zestaw statusów po planie musi przejść walidację (każdy etap ze statusem, limity); błąd = komunikat do raportu. */
export function bladZestawu(statusy: readonly StatusFirmyT[], grupy: readonly GrupaStatusowT[]): string | null {
  try {
    validateZestawStatusow(statusy, grupy)
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

export const nazwaEtapu = (e: OrderStatus) => STATUS_ZAMOWIENIA[e].etykieta
