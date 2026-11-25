// ustawienia konta przewoźnika (pola `config` z manifestu adaptera widoczne w panelu: FID-y, środowisko,
// wymiary…) żyją przy koncie, w `Organization.settings.przewoznicy.ustawienia[<id konta>]`, obok wyników testów
// (`testy`) i drugich kont (`konta`). Id konta = rodzina adaptera (pierwszy człon klucza, np. `dpd`) i sufiks drugiego
// konta (`dpd~EMPIK`), ten sam co na ekranie kont i w licznikach zdrowia.
//
// Jedno źródło prawdy per pole: wpis konta wygrywa (wartość albo `null` = pole wyczyszczone w panelu). Pole bez wpisu
// konta bierze wartość z reguły (`CarrierRule.config`): tak działają konta ustawione przez reguły,
// bez migracji danych. Panel zapisuje tylko do konta, więc stara wartość w regule zostaje (odwracalnie), ale nie działa,
// gdy konto ma swoją. Ustawienia ukryte (`POLA_UKRYTE`: adres API, przedrostek env, konto reguły, wyłącznik
// nadawania, nadawca) zostają w regule: ustawia je host albo self-host, a wyłącznik nadawania jest per reguła.
import type { Prisma } from '@prisma/client'
import type { AdapterManifest } from '../adaptery/kontrakt'

/** Sufiks drugiego konta przewoźnika (`config.sekretyKonta`, np. EMPIK). */
export const SEKRETY_KONTA_RE = /^[A-Z][A-Z0-9]{0,15}$/

/** Pola konfiguracji, których panel nie pokazuje: ustawia je host albo self-host (env), nie osoba w panelu. */
export const POLA_UKRYTE = new Set(['envPrefix', 'baseUrl', 'nadawca', 'sekretyKonta', 'zapisWlaczony'])

/** Pola karty „Wysyłam z Allegro” (konto `allegro`): zamawianie kuriera; reszta konfiguracji zostaje w regułach. */
export const POLA_WYSYLAM_Z_ALLEGRO = ['zamawianieKuriera', 'przewoznikOdbioru'] as const

/**
 * Ustawienia ukryte związane z serwerem konkretnego przewoźnika: przy zmianie modułu reguły na moduł innego
 * przewoźnika znikają z reguły (adres API Base Couriera nie jest adresem DPD). `sekretyKonta` i `zapisWlaczony`
 * obsługuje zapis reguł osobno (konto w kolumnie „Konto”, nadawanie do włączenia na nowo); `nadawca` wstawia host
 * przy każdym tworzeniu adaptera z profilu firmy, więc może zostać.
 */
export const POLA_SERWERA_PRZEWOZNIKA = ['baseUrl', 'envPrefix'] as const

export type WartoscUstawienia = string | number | boolean | null
export type UstawieniaKonta = Record<string, WartoscUstawienia>

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** Rodzina adaptera przewoźnika: pierwszy człon klucza (`dpd.services.zapis.v1` → `dpd`). */
export const rodzinaAdaptera = (adapterKey: string): string => adapterKey.split('.')[0]!

/** Id konta przewoźnika z klucza adaptera i sufiksu drugiego konta. */
export const idKontaPrzewoznika = (adapterKey: string, sufiks: string | null): string => `${rodzinaAdaptera(adapterKey)}${sufiks ? `~${sufiks}` : ''}`

/** Czy adapter ma konto na ekranie kont (przewoźnik z kluczami; Wysyłam z Allegro korzysta z konta kanału). */
export const maKontoPrzewoznika = (m: AdapterManifest): boolean => m.kind === 'carrier' && m.secrets.length > 0 && !m.adapterKey.startsWith('allegro.')

/** Pola konta z manifestu: widoczne w panelu (bez `POLA_UKRYTE`). */
export const polaKonta = (m: AdapterManifest): string[] => m.config.map((f) => f.key).filter((k) => !POLA_UKRYTE.has(k))

const wartosc = (v: unknown): WartoscUstawienia | undefined => (v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) ? v : undefined)

/** Ustawienia kont firmy z `Organization.settings` (śmieci pomijane). */
export function ustawieniaKont(settings: unknown): Record<string, UstawieniaKonta> {
  const raw = asObject(asObject(asObject(settings)['przewoznicy'])['ustawienia'])
  const out: Record<string, UstawieniaKonta> = {}
  for (const [id, u] of Object.entries(raw)) {
    const o = asObject(u)
    const pola: UstawieniaKonta = {}
    for (const [k, v] of Object.entries(o)) {
      const w = wartosc(v)
      if (w !== undefined && !POLA_UKRYTE.has(k)) pola[k] = w
    }
    if (Object.keys(pola).length) out[id] = pola
  }
  return out
}

/** Konfiguracja reguły z nałożonymi ustawieniami konta: pole z wpisu konta wygrywa, `null` usuwa wartość z reguły. */
export function nalozUstawieniaKonta(config: Record<string, unknown>, ustawienia: UstawieniaKonta | undefined): Record<string, unknown> {
  const out = { ...config }
  for (const [k, v] of Object.entries(ustawienia ?? {})) {
    if (POLA_UKRYTE.has(k)) continue
    if (v === null) delete out[k]
    else out[k] = v
  }
  return out
}

/** Sufiks drugiego konta z konfiguracji reguły; null = konto główne (zła wartość też, tę odrzuci host adaptera). */
export const sufiksKonta = (config: Record<string, unknown>): string | null => {
  const s = config['sekretyKonta']
  return typeof s === 'string' && SEKRETY_KONTA_RE.test(s) ? s : null
}

/**
 * Konfiguracja, z którą działa reguła przewoźnika (nadanie, podgląd przesyłki, test połączenia): `config` reguły
 * z nałożonymi ustawieniami jej konta. Adapter bez konta (Wysyłam z Allegro, brak modułu) = `config` reguły.
 */
export function konfiguracjaZKontem(settings: unknown, adapterKey: string | null, config: Record<string, unknown>): Record<string, unknown> {
  if (!adapterKey) return { ...config }
  if (adapterKey.startsWith('allegro.')) {
    // Wysyłam z Allegro: karta „Wysyłam z Allegro” (konto `allegro`) niesie tylko pola zamawiania kuriera
    const u = ustawieniaKont(settings)['allegro'] ?? {}
    return nalozUstawieniaKonta(config, Object.fromEntries(Object.entries(u).filter(([k]) => (POLA_WYSYLAM_Z_ALLEGRO as readonly string[]).includes(k))))
  }
  return nalozUstawieniaKonta(config, ustawieniaKont(settings)[idKontaPrzewoznika(adapterKey, sufiksKonta(config))])
}

type Tx = Prisma.TransactionClient

/**
 * Zmiana ustawień kont pod blokadą wiersza firmy (jak wyniki testów i drugie konta: równoległy zapis nie nadpisze
 * zmian). `zmiany`: pole → wartość (`null` = wyczyszczone). `tylkoBrakujace`: wpisuje tylko pola, których konto
 * jeszcze nie ma (przeniesienie wartości z reguły przy jej przełączeniu albo usunięciu). Zwraca stan przed i po
 * zmienionych kont (do historii zmian).
 */
export async function zmienUstawieniaKont(
  tx: Tx,
  organizationId: string,
  zmiany: { id: string; pola: UstawieniaKonta }[],
  o: { tylkoBrakujace?: boolean } = {},
): Promise<{ id: string; przed: UstawieniaKonta; po: UstawieniaKonta }[]> {
  if (!zmiany.length) return []
  const rows = await tx.$queryRaw<{ settings: Prisma.JsonValue }[]>`SELECT settings FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`
  if (!rows[0]) throw new Error('Brak firmy klienta')
  const s = asObject(rows[0].settings)
  const p = asObject(s['przewoznicy'])
  const wszystkie = ustawieniaKont(s)
  const wynik: { id: string; przed: UstawieniaKonta; po: UstawieniaKonta }[] = []
  for (const z of zmiany) {
    const przed = wszystkie[z.id] ?? {}
    const po = { ...przed }
    for (const [k, v] of Object.entries(z.pola)) {
      if (POLA_UKRYTE.has(k) || (o.tylkoBrakujace && Object.hasOwn(po, k))) continue
      po[k] = v
    }
    if (JSON.stringify(po) === JSON.stringify(przed)) continue
    wszystkie[z.id] = po
    wynik.push({ id: z.id, przed, po })
  }
  if (wynik.length) await tx.organization.update({ where: { id: organizationId }, data: { settings: { ...s, przewoznicy: { ...p, ustawienia: wszystkie } } as Prisma.InputJsonValue } })
  return wynik
}
