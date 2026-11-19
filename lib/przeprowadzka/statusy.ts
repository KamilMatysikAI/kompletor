// Przeprowadzka z BL: mapa statusów BL → status Kompletora (OrderStatus). Czyste funkcje.
//
// Propozycja po nazwie statusu (wzorce), a gdy nazwa nic nie mówi — po nazwie grupy statusów BL (wtedy zawsze
// DO_DECYZJI). Zasada bezpieczeństwa: status niepewny NIGDY nie jest terminalny. Propozycja „Wysłane” z samej grupy
// zostaje podpowiedzią, a skutkiem jest DO_WYJASNIENIA — zamówienie przejdzie do Kompletora jako otwarte i człowiek je
// obejrzy, zamiast zniknąć jako „zakończone”. Status nieznany: DO_WYJASNIENIA, DO_DECYZJI.
//
// Mapa decyduje, które zamówienia BL są otwarte (pobierane i przenoszone): te ze statusem nieterminalnym. Status
// zamówienia w Kompletorze liczy potem rdzeń (płatność, rezerwacja, przewoźnik) — mapa nie wymusza go w rdzeniu.
// Plik decyzji człowieka (`--mapa <plik.json>`) nadpisuje propozycje; nie zawiera danych klientów (same id statusów,
// nazwy metod dostawy i źródeł).
import { Carrier, type OrderStatus } from '@prisma/client'

export type Pewnosc = 'PEWNE' | 'DO_DECYZJI' | 'DECYZJA'

/** Statusy, w których zamówienie jest zakończone z punktu widzenia magazynu: przeprowadzka ich nie przenosi. */
export const TERMINALNE: ReadonlySet<OrderStatus> = new Set<OrderStatus>(['WYSLANE', 'ODEBRANE', 'ANULOWANE', 'REKLAMACJA'])

const ORDER_STATUSES: readonly OrderStatus[] = [
  'NOWE',
  'DO_REALIZACJI',
  'ZBIERANIE',
  'ZEBRANE',
  'SPAKOWANE',
  'DO_WYSLANIA',
  'DO_ODBIORU',
  'WYSLANE',
  'ODEBRANE',
  'ANULOWANE',
  'DO_WYJASNIENIA',
  'REKLAMACJA',
]

export function isOrderStatus(v: unknown): v is OrderStatus {
  return typeof v === 'string' && (ORDER_STATUSES as readonly string[]).includes(v)
}

export interface BlStatus {
  id: string
  name: string
  /** Nazwa grupy statusów BL (getOrderStatusGroups), jeśli znana. */
  group: string | null
  /** id grupy BL (`group_id`; null = grupa główna albo brak), kolor (hex) i nazwa dla klienta (`name_for_customer`). */
  groupId?: string | null
  color?: string | null
  customerName?: string | null
}

export interface DecyzjaStatusu {
  blStatusId: string
  nazwa: string
  grupa: string | null
  /** id grupy BL, kolor (hex) i nazwa dla klienta z BL (do statusów firmy przy przeprowadzce). */
  grupaId?: string
  kolor?: string
  nazwaDlaKlienta?: string
  /** Status Kompletora, który obowiązuje (po zasadzie „niepewne nie jest terminalne” i po mapie człowieka). */
  status: OrderStatus
  /** Co podpowiadają wzorce (może być terminalne, nawet gdy `status` nim nie jest). */
  podpowiedz: OrderStatus | null
  pewnosc: Pewnosc
  powod: string
}

/** Małe litery bez polskich znaków — wzorce piszemy raz, bez wariantów „wysłane/wyslane”. */
export function bezOgonkow(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Wzorce w kolejności: pierwszy pasujący wygrywa. Kolejność ma znaczenie: „nieodebrane” przed „odebrane”,
 * „do wysłania” przed „wysłane”, „zwrot” i „reklamacja” przed „zrealizowane”.
 */
const WZORCE: { re: RegExp; status: OrderStatus | null; pewne: boolean; opis: string }[] = [
  { re: /do wyjasnienia|wyjasn|problem|wstrzym|blad|bledn|weryfikac/, status: 'DO_WYJASNIENIA', pewne: true, opis: 'do wyjaśnienia' },
  { re: /reklamac/, status: 'REKLAMACJA', pewne: true, opis: 'reklamacja' },
  // zwrot: zamówienie po wysyłce, zwrotów nie przenosimy — ale „zwrot” bywa też „zwrot płatności przed wysyłką”
  { re: /zwrot/, status: 'REKLAMACJA', pewne: false, opis: 'zwrot (zwrotów nie przenosimy)' },
  { re: /nie ?odebr|nieodbr|nie ?dorecz|awizo/, status: null, pewne: false, opis: 'nieodebrane / awizo' },
  { re: /anul|odrzuc|rezygn|storn/, status: 'ANULOWANE', pewne: true, opis: 'anulowane' },
  { re: /do wysl|gotowe do wysl|czeka na kurier|czeka na nadanie|etykiet/, status: 'DO_WYSLANIA', pewne: true, opis: 'do wysłania' },
  { re: /do odbioru|odbior osobist|czeka na odbior/, status: 'DO_ODBIORU', pewne: true, opis: 'do odbioru' },
  { re: /wysl|nadan|w drodze|przekazan.* kurier/, status: 'WYSLANE', pewne: true, opis: 'wysłane' },
  { re: /odebr|dorecz|dostarcz|zrealizowan|zakoncz|wykonan/, status: 'ODEBRANE', pewne: true, opis: 'odebrane / zakończone' },
  { re: /spakowan/, status: 'SPAKOWANE', pewne: true, opis: 'spakowane' },
  { re: /pakowan|kompletow|zbieran|w realizacji|w trakcie/, status: 'ZBIERANIE', pewne: true, opis: 'w realizacji' },
  { re: /nie ?oplac|nie ?potwierdz/, status: 'NOWE', pewne: true, opis: 'nieopłacone / niepotwierdzone' },
  { re: /do realizacji|oplacon|przyjet|potwierdzon/, status: 'DO_REALIZACJI', pewne: true, opis: 'do realizacji' },
  { re: /nowe|nowy|oczekuj|nieoplac|brak (wplaty|platnosci)|czeka na (wplat|platnosc)/, status: 'NOWE', pewne: true, opis: 'nowe' },
]

function dopasuj(tekst: string): (typeof WZORCE)[number] | null {
  const t = bezOgonkow(tekst)
  return WZORCE.find((w) => w.re.test(t)) ?? null
}

/** Propozycja dla jednego statusu BL (bez mapy człowieka). */
export function proponujStatus(s: BlStatus): DecyzjaStatusu {
  const base = { blStatusId: s.id, nazwa: s.name, grupa: s.group, ...(s.groupId ? { grupaId: s.groupId } : {}), ...(s.color ? { kolor: s.color } : {}), ...(s.customerName ? { nazwaDlaKlienta: s.customerName } : {}) }
  const poNazwie = dopasuj(s.name)
  if (poNazwie?.status && poNazwie.pewne) {
    return { ...base, status: poNazwie.status, podpowiedz: poNazwie.status, pewnosc: 'PEWNE', powod: `nazwa: ${poNazwie.opis}` }
  }
  const poGrupie = !poNazwie && s.group ? dopasuj(s.group) : null
  const hint = poNazwie ?? poGrupie
  const podpowiedz = hint?.status ?? null
  // Niepewne nigdy terminalne: terminalna podpowiedź zostaje podpowiedzią, skutkiem jest DO_WYJASNIENIA.
  const status: OrderStatus = podpowiedz && !TERMINALNE.has(podpowiedz) ? podpowiedz : 'DO_WYJASNIENIA'
  const powod = poNazwie
    ? `nazwa: ${poNazwie.opis} — do potwierdzenia`
    : poGrupie
      ? `tylko grupa „${s.group}”: ${poGrupie.opis} — do potwierdzenia`
      : 'nieznany status — do decyzji'
  return { ...base, status, podpowiedz, pewnosc: 'DO_DECYZJI', powod }
}

// ─── Plik mapy (decyzje człowieka) ───────────────────────────────────────────

/**
 * Plik `--mapa`: `{ "statusy": { "<id statusu BL>": "WYSLANE" }, "przewoznicy": { "<metoda dostawy>": "DPD" },
 * "zrodla": { "<typ>:<id>": "BL_INNE" } }`. Same konfiguracje, bez danych klientów. `przewoznicy` i `zrodla` czyta
 * rozpoznanie (rozpoznanie.ts).
 */
export interface MapaCzlowieka {
  statusy: Record<string, OrderStatus>
  przewoznicy: Record<string, Carrier>
  /** Źródło BL → „pomiń” (nie przenosimy jego zamówień). Inne wartości zarezerwowane na później. */
  zrodla: Record<string, 'POMIN'>
}

export const PUSTA_MAPA: MapaCzlowieka = { statusy: {}, przewoznicy: {}, zrodla: {} }

// z enumu schematu, nie ręczna kopia (nowy przewoźnik działa w pliku mapy bez zmian tutaj)
const CARRIERS: readonly Carrier[] = Object.values(Carrier)

export class ZlaMapa extends Error {}

/** Parser pliku mapy: zły wpis = błąd z numerem i powodem (lepiej odmówić niż przyjąć zgadniętą decyzję). */
/**
 * status firmy, pod którym zamówienie z danym statusem BL będzie widoczne w panelu. Najpierw status firmy
 * o tej samej nazwie (bez wielkości liter i ogonków) i tym samym etapie co decyzja, inaczej pierwszy aktywny status
 * firmy tego etapu (bez przewoźnika: przewoźnika zamówienia przeprowadzka jeszcze nie zna). null = nazwa etapu.
 */
export function statusFirmyDlaBl(d: Pick<DecyzjaStatusu, 'nazwa' | 'status'>, defs: readonly { key: string; name: string; baseStatus: OrderStatus; active: boolean; sortOrder: number }[]): { klucz: string; nazwa: string; poNazwie: boolean } | null {
  const etap = [...defs].filter((x) => x.active && x.baseStatus === d.status).sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key))
  const n = bezOgonkow(d.nazwa)
  const poNazwie = etap.find((x) => bezOgonkow(x.name) === n)
  if (poNazwie) return { klucz: poNazwie.key, nazwa: poNazwie.name, poNazwie: true }
  return etap[0] ? { klucz: etap[0].key, nazwa: etap[0].name, poNazwie: false } : null
}

export function parseMapa(json: unknown): MapaCzlowieka {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new ZlaMapa('mapa: oczekiwany obiekt JSON')
  const o = json as Record<string, unknown>
  for (const k of Object.keys(o)) if (!['statusy', 'przewoznicy', 'zrodla', 'opis'].includes(k)) throw new ZlaMapa(`mapa: nieznany klucz „${k}”`)
  const obj = (k: string): Record<string, unknown> => {
    const v = o[k]
    if (v === undefined) return {}
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ZlaMapa(`mapa: „${k}” musi być obiektem`)
    return v as Record<string, unknown>
  }
  const statusy: Record<string, OrderStatus> = {}
  for (const [id, v] of Object.entries(obj('statusy'))) {
    if (!/^\d+$/.test(id)) throw new ZlaMapa(`mapa.statusy: „${id}” nie jest id statusu BL (liczba)`)
    if (!isOrderStatus(v)) throw new ZlaMapa(`mapa.statusy[${id}]: „${String(v)}” nie jest statusem Kompletora (${ORDER_STATUSES.join(', ')})`)
    statusy[id] = v
  }
  const przewoznicy: Record<string, Carrier> = {}
  for (const [m, v] of Object.entries(obj('przewoznicy'))) {
    if (typeof v !== 'string' || !(CARRIERS as readonly string[]).includes(v)) throw new ZlaMapa(`mapa.przewoznicy[„${m}”]: „${String(v)}” nie jest przewoźnikiem (${CARRIERS.join(', ')})`)
    przewoznicy[bezOgonkow(m)] = v as Carrier
  }
  const zrodla: Record<string, 'POMIN'> = {}
  for (const [k, v] of Object.entries(obj('zrodla'))) {
    if (v !== 'POMIN') throw new ZlaMapa(`mapa.zrodla[„${k}”]: dozwolone tylko „POMIN”`)
    zrodla[k] = 'POMIN'
  }
  return { statusy, przewoznicy, zrodla }
}

/** Propozycje dla wszystkich statusów BL z decyzjami człowieka nałożonymi na wierzch. */
export function mapaStatusow(statusy: BlStatus[], mapa: MapaCzlowieka = PUSTA_MAPA): DecyzjaStatusu[] {
  return statusy.map((s) => {
    const p = proponujStatus(s)
    const decyzja = mapa.statusy[s.id]
    return decyzja ? { ...p, status: decyzja, pewnosc: 'DECYZJA', powod: `decyzja w pliku mapy (propozycja: ${p.podpowiedz ?? 'brak'})` } : p
  })
}

/** Statusy BL, których zamówienia są otwarte (przenoszone): obowiązujący status nieterminalny. */
export function statusyOtwarte(decyzje: DecyzjaStatusu[]): string[] {
  return decyzje.filter((d) => !TERMINALNE.has(d.status)).map((d) => d.blStatusId)
}

/**
 * Statusy DO_DECYZJI, w których są otwarte zamówienia (liczba > 0) — dopóki lista nie jest pusta, `--zapisz` odmawia.
 * Status niepewny bez zamówień nie blokuje (zostaje w raporcie jako sprawa do decyzji na przyszłość).
 */
export function blokujaceStatusy(decyzje: DecyzjaStatusu[], otwartePoStatusie: ReadonlyMap<string, number>): DecyzjaStatusu[] {
  return decyzje.filter((d) => d.pewnosc === 'DO_DECYZJI' && (otwartePoStatusie.get(d.blStatusId) ?? 0) > 0)
}

/** Zapis w Organization.settings.baselinker.statusy: id statusu BL → status Kompletora i pewność. */
export type ZapisanaMapaStatusow = Record<string, { status: OrderStatus; nazwa: string; pewnosc: Pewnosc; klucz?: string }>

/** `klucze` = id statusu BL → klucz statusu firmy (statusy-firmy.ts), zapisany obok etapu dla cienia i kopii statusów. */
export function doZapisu(decyzje: DecyzjaStatusu[], klucze: Record<string, string> = {}): ZapisanaMapaStatusow {
  return Object.fromEntries(decyzje.map((d) => [d.blStatusId, { status: d.status, nazwa: d.nazwa, pewnosc: d.pewnosc, ...(klucze[d.blStatusId] ? { klucz: klucze[d.blStatusId] } : {}) }]))
}
