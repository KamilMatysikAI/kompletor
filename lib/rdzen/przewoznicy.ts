// Reguły „metoda dostawy z kanału → przewoźnik + moduł wysyłki” (spec 7.2) — w bazie per firma
// (tabela CarrierRule), nie w kodzie. Pierwsza pasująca reguła (rosnąco po priorytecie) wygrywa; brak dopasowania
// = BRAK → zamówienie „Do wyjaśnienia”.
import type { Carrier, Channel, ShippingModule } from '@prisma/client'
import { assertAdapterKey } from '../adaptery'
import type { Db, Tx } from './stan'

export interface CarrierRuleT {
  priority: number
  channel: Channel | null
  pattern: string | null // wyrażenie regularne, bez rozróżniania wielkości liter; null = każda metoda
  carrier: Carrier
  shippingModule: ShippingModule
  /** Adapter modułu wysyłki (lib/adaptery.ts); null/brak = brak modułu. Rdzeń wybiera tylko przewoźnika i moduł. */
  adapterKey?: string | null
}

export interface CarrierChoice {
  carrier: Carrier
  shippingModule: ShippingModule
}

/**
 * Zestaw startowy dla nowej firmy: rozpoznaje przewoźnika po nazwie metody dostawy, moduł wysyłki „BRAK” (firma
 * wybiera go w Ustawienia → Przewoźnicy). Allegro → Wysyłam z Allegro, bo to jedyny moduł dla zamówień Allegro.
 * bez „kurier → DPD” — ogólny „kurier” nie mówi, który to przewoźnik, więc trafia do „Do
 * wyjaśnienia”, dopóki firma nie ustawi reguły w panelu. DPD tylko, gdy metoda dostawy nazywa DPD. Firmy z presetem mają własne
 * reguły z presetu (seed/presety), więc ta zmiana ich nie dotyczy.
 */
export const DEFAULT_CARRIER_RULES: CarrierRuleT[] = [
  { priority: 10, channel: 'ALLEGRO', pattern: null, carrier: 'ALLEGRO', shippingModule: 'WYSYLAM_Z_ALLEGRO', adapterKey: 'allegro.wysylam.v1' },
  { priority: 20, channel: null, pattern: 'paczkomat', carrier: 'PACZKOMATY', shippingModule: 'BRAK' },
  { priority: 30, channel: null, pattern: 'salon(u)? empik', carrier: 'DPD_EMPIK', shippingModule: 'BRAK' },
  { priority: 40, channel: null, pattern: 'dpd', carrier: 'DPD', shippingModule: 'BRAK' },
  { priority: 50, channel: null, pattern: 'osobist', carrier: 'OSOBISTY', shippingModule: 'BRAK' },
]

/** Zestaw startowy (z „kurier → DPD”): firmy z nim mają nadal „nietknięte startowe” reguły. */
export const LEGACY_DEFAULT_CARRIER_RULES: CarrierRuleT[] = DEFAULT_CARRIER_RULES.map((r) => (r.priority === 40 ? { ...r, pattern: 'dpd|kurier' } : r))

const compiled = new Map<string, RegExp | null>()

function regexOf(pattern: string): RegExp | null {
  let re = compiled.get(pattern)
  if (re === undefined) {
    try {
      re = new RegExp(pattern, 'i')
    } catch {
      re = null // zła reguła nie pasuje do niczego (walidacja przy zapisie: validateCarrierRule)
    }
    compiled.set(pattern, re)
  }
  return re
}

export function validateCarrierRule(r: CarrierRuleT): void {
  if (!Number.isInteger(r.priority) || r.priority < 0 || r.priority > 100_000) throw new Error(`Zły priorytet reguły: ${r.priority}`)
  if (r.channel === 'AI') throw new Error('Reguła przewoźnika nie może dotyczyć rodziny AI (to nie kanał sprzedaży)')
  if (r.adapterKey) assertAdapterKey(r.adapterKey)
  if (r.adapterKey && r.shippingModule === 'BRAK') throw new Error('Reguła z adapterem wysyłki musi mieć moduł wysyłki')
  if (r.pattern !== null) {
    if (r.pattern.length > 200) throw new Error('Wzorzec reguły dłuższy niż 200 znaków')
    try {
      new RegExp(r.pattern, 'i')
    } catch {
      throw new Error(`Zły wzorzec reguły przewoźnika: ${r.pattern}`)
    }
  }
}

/** Pierwsza reguła pasująca do kanału i metody dostawy, rosnąco po priorytecie. */
export function dopasowanaRegula<T extends Pick<CarrierRuleT, 'priority' | 'channel' | 'pattern'>>(rules: readonly T[], channel: Channel, deliveryMethod: string | null | undefined): T | null {
  const m = deliveryMethod ?? ''
  for (const r of [...rules].sort((a, b) => a.priority - b.priority)) {
    if (r.channel && r.channel !== channel) continue
    if (r.pattern !== null) {
      const re = regexOf(r.pattern)
      if (!re || !re.test(m)) continue
    }
    return r
  }
  return null
}

/** Kanały, w których przewoźnika wybiera człowiek albo wywołujący API (lib/zamowienia/ogolne.ts), nie metoda dostawy. */
const KANALY_WYBORU_PRZEWOZNIKA: ReadonlySet<Channel> = new Set<Channel>(['RECZNE', 'EASYTOOLS'])

export const POWOD_REGULY_ZMIENIONE = 'Reguły przewoźnika zmieniły się od przyjęcia zamówienia: sprawdź przewoźnika tego zamówienia.'
export const POWOD_BRAK_REGULY = 'Firma nie ma reguły przewoźnika dla tego przewoźnika i metody dostawy: ustaw ją w Ustawienia → Wysyłka i druk → Przewoźnicy.'

export const NAZWA_MODULU: Record<ShippingModule, string> = { BASE_COURIER: 'Base Courier', WYSYLAM_Z_ALLEGRO: 'Wysyłam z Allegro', INPOST_SHIPX: 'InPost', DPD_BEZPOSREDNIO: 'DPD', ORLEN_PACZKA: 'Orlen Paczka', GLS_ADE: 'GLS', POCZTA_POLSKA: 'Poczta Polska (eNadawca)', BRAK: 'bez modułu' }

/** reguła tego przewoźnika jest, ale z innym modułem niż zamówienie przy przyjęciu. */
export const powodInnegoModulu = (przyjety: ShippingModule, dzis: ShippingModule): string =>
  `Zamówienie przyjęto z modułem wysyłki „${NAZWA_MODULU[przyjety]}”, a reguła tego przewoźnika ma dziś „${NAZWA_MODULU[dzis]}”: nadaj przesyłkę w panelu przewoźnika albo przywróć moduł w Ustawienia → Wysyłka i druk → Przewoźnicy.`
export const czyPowodInnegoModulu = (powod: string | null): boolean => !!powod && powod.startsWith('Zamówienie przyjęto z modułem wysyłki')

/**
 * Reguła przewoźnika ZAMÓWIENIA (podgląd i nadanie przesyłki): najpierw ta, którą wskazuje metoda dostawy
 * (to samo dopasowanie co przy przyjęciu z kanału). Gdy przewoźnik był wybrany wprost, metoda dostawy może wskazywać
 * inną regułę albo żadną: wtedy pierwsza wg priorytetu reguła o tym samym przewoźniku i module wysyłki co zamówienie.
 * Wybór wprost = zamówienie ręczne albo z API ogólnego (RECZNE, EASYTOOLS: przewoźnik z formularza) albo metoda
 * dostawy bez żadnej reguły (przewoźnik ustawiony przy wyjaśnieniu). Zamówienie z kanału, którego metoda wskazuje dziś
 * innego przewoźnika, dostaje powód „reguły zmieniły się” (bez zgadywania).
 * Moduł: zamówienie przyjęte bez modułu (`BRAK` albo puste, np. firma bez modułów przy przyjęciu)
 * dostaje pierwszą regułę przewoźnika z dowolnym modułem (jak `carrierZWyboru` przy przyjęciu, które modułu nie
 * filtruje); zamówienie z modułem nie zostanie nadane innym modułem: osobny powód z obiema nazwami.
 * powód „reguły zmieniły się” tylko dla zamówienia z kanału, nie dla wyboru wprost.
 * (świadomie, przegląd): EASYTOOLS jest zawsze „wyborem wprost”, także gdy wywołujący API nie podał
 * przewoźnika i przyjęcie wzięło go z metody dostawy. Gdy metoda wskazuje dziś innego przewoźnika, takie zamówienie
 * nie dostaje powodu „reguły zmieniły się”, tylko regułę przewoźnika ustalonego przy przyjęciu: przewoźnik zamówienia
 * zostaje taki, jaki klient widział przy zakupie. Rozpoznanie po tym, czy przewoźnik był podany, wymagałoby nowego pola
 * w zamówieniu (poza zakresem).
 */
export function regulaDlaZamowienia<T extends Pick<CarrierRuleT, 'priority' | 'channel' | 'pattern' | 'carrier' | 'shippingModule'>>(
  rules: readonly T[],
  z: {
    channel: Channel
    carrier: Carrier | null
    metodaDostawy: string | null | undefined
    shippingModule: ShippingModule | null | undefined
    /**
     * Sposób wysyłki zmieniony na karcie zamówienia (`flags.przewoznikRecznie`, lib/wysylka/zmiana-sposobu.ts): metoda
     * dostawy z kanału nie wskazuje już reguły, przewoźnik i moduł zamówienia są wyborem wprost (jak zamówienie ręczne).
     */
    przewoznikRecznie?: boolean
  },
): { regula: T; powod: null } | { regula: null; powod: string } {
  const r = z.przewoznikRecznie ? null : dopasowanaRegula(rules, z.channel, z.metodaDostawy)
  if (r && r.carrier === z.carrier) return { regula: r, powod: null }
  const wprost = !r || KANALY_WYBORU_PRZEWOZNIKA.has(z.channel)
  if (!wprost || !z.carrier) return { regula: null, powod: r ? POWOD_REGULY_ZMIENIONE : POWOD_BRAK_REGULY }
  const przewoznika = [...rules].sort((a, b) => a.priority - b.priority).filter((x) => x.carrier === z.carrier && (!x.channel || x.channel === z.channel))
  const bezModulu = !z.shippingModule || z.shippingModule === 'BRAK'
  const wybor = przewoznika.find((x) => bezModulu || x.shippingModule === z.shippingModule)
  if (wybor) return { regula: wybor, powod: null }
  if (przewoznika.length) return { regula: null, powod: powodInnegoModulu(z.shippingModule!, przewoznika[0]!.shippingModule) }
  return { regula: null, powod: POWOD_BRAK_REGULY }
}

/** Czysta funkcja: wybór przewoźnika wg reguł firmy. */
export function carrierFromRules(rules: readonly CarrierRuleT[], channel: Channel, deliveryMethod: string | null | undefined): CarrierChoice {
  const r = dopasowanaRegula(rules, channel, deliveryMethod)
  return r ? { carrier: r.carrier, shippingModule: r.shippingModule } : { carrier: 'BRAK', shippingModule: 'BRAK' }
}

/** Reguły firmy klienta (RLS: tylko własne). */
export async function loadCarrierRules(db: Db | Tx): Promise<CarrierRuleT[]> {
  return db.carrierRule.findMany({
    orderBy: { priority: 'asc' },
    select: { priority: true, channel: true, pattern: true, carrier: true, shippingModule: true },
  })
}
