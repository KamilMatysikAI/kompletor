// Zamówienie kuriera DPD (DPDServices REST, `POST /public/courierorder/v1/packagesPickupCall`): treść żądania i odczyt
// odpowiedzi, funkcje czyste. Kształt z oficjalnej dokumentacji OpenAPI DPDServices (schematy
// PackagesPickupCallCreateRequest, PackagesPickupCallCreateResponse, GetCourierOrderAvailabilityResponse):
//   żądanie   — orderType (DOMESTIC), pickupDate (RRRR-MM-DD, nie w przeszłości), pickupTimeFrom / pickupTimeTo (HH:MM),
//               waybillsReady, packagesForCollection: payer.number (FID), orderer {name, fullName, phone},
//               sender {name, fullName, address, city, postalCode, phone}, packagesParams {doxCount, parcel {count,
//               weight (suma), maxWeight, maxHeight, maxWidth, maxDepth}};
//   odpowiedź — orderNumber, checkSum (potrzebna do anulowania: DELETE z orderNumber i checkSum), status.status
//               (OK, UNKNOWN_ERROR, DISABLED_API, DISALLOWED_FID, VALIDATION_ERROR, NOT_FOUND, SERVICE_UNAVAILABLE),
//               status.errorDetails [{code, description, fields}];
//   dostępność — GET courierOrderAvailability (countryCode, zipCode) → status, ranges [{offset, range}] (`range`
//               „HH:MM-HH:MM”, `offset` w minutach, bez dni; odczyt z produkcji 24.11.2026, opis przy zakresyDostepnosci).
// [NIEPEWNE] jednostki wymiarów (cm) i wagi (kg) w `packagesParams.parcel`: dokumentacja ich nie podaje; tak samo jak
// w przesyłkach DPD (lib/wysylka/zlecenie-dpd.ts). [NIEPEWNE] znaczenie `offset` w dostępności.
// Klient HTTP i ekran „Zamów kuriera” korzystają z tych funkcji; tu nic nie wysyła żądań.
import { bezWartosciZadania } from '../zrodla/dpd-zapis'

export interface PaczkaDoOdbioru {
  wagaKg: number
  /** Wymiary w cm w dowolnej kolejności; największy idzie jako głębokość, potem szerokość, wysokość. */
  wymiaryCm: readonly [number, number, number]
}

export interface ZamowienieKurieraDpd {
  data: string
  odMin: number
  doMin: number
  fid: string
  nadawca: { name: string; address: string; city: string; postalCode: string; phone: string; email?: string | null }
  paczki: readonly PaczkaDoOdbioru[]
}

const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const zaokr = (v: number) => Math.round(v * 100) / 100
const tekst = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/** Braki przed żądaniem (puste = można wysłać). Bez wartości danych, same nazwy. */
export function sprawdzZamowienieKuriera(z: ZamowienieKurieraDpd): string[] {
  const b: string[] = []
  if (!z.paczki.length) b.push('brak paczek do odbioru')
  if (!/^\d{1,9}$/.test(z.fid)) b.push('numer płatnika (FID) DPD')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(z.data)) b.push('data odbioru')
  if (!(Number.isInteger(z.odMin) && Number.isInteger(z.doMin) && z.odMin >= 0 && z.doMin <= 1439 && z.odMin < z.doMin)) b.push('okno godzin odbioru')
  const n = z.nadawca
  for (const [k, nazwa] of [['name', 'nazwa nadawcy'], ['address', 'adres nadawcy'], ['city', 'miasto nadawcy'], ['postalCode', 'kod pocztowy nadawcy'], ['phone', 'telefon nadawcy']] as const) if (!tekst(n[k])) b.push(nazwa)
  return b
}

export function trescZamowieniaKuriera(z: ZamowienieKurieraDpd): Record<string, unknown> {
  const b = sprawdzZamowienieKuriera(z)
  if (b.length) throw new Error(`Zamówienie kuriera niegotowe: ${b.join(', ')}`)
  const posort = z.paczki.map((p) => [...p.wymiaryCm].sort((a, c) => c - a))
  const max = (i: number) => Math.max(...posort.map((w) => w[i]!))
  const n = z.nadawca
  return {
    orderType: 'DOMESTIC',
    pickupDate: z.data,
    pickupTimeFrom: hm(z.odMin),
    pickupTimeTo: hm(z.doMin),
    waybillsReady: true,
    packagesForCollection: {
      payer: { number: Number(z.fid) },
      orderer: { name: n.name.trim(), fullName: n.name.trim(), phone: n.phone.trim() },
      sender: { name: n.name.trim(), fullName: n.name.trim(), address: n.address.trim(), city: n.city.trim(), postalCode: n.postalCode.replace(/[^0-9A-Za-z]/g, ''), phone: n.phone.trim() },
      packagesParams: {
        doxCount: 0,
        parcel: { count: z.paczki.length, weight: zaokr(z.paczki.reduce((s, p) => s + p.wagaKg, 0)), maxWeight: zaokr(Math.max(...z.paczki.map((p) => p.wagaKg))), maxDepth: max(0), maxWidth: max(1), maxHeight: max(2) },
      },
    },
  }
}

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)

/**
 * Odpowiedź utworzenia: OK tylko ze statusem OK i numerem zlecenia; odmowa = status i opisy błędów DPD (bez treści
 * żądania). `fields` wg specyfikacji to tekst (tablica też przechodzi), a `description` przechodzi ten sam
 * filtr co przy HTTP 4xx (wycięte wartości żądania, opis z cyfrą albo `@` wypada: DPD odsyła dane po normalizacji).
 */
export function odpowiedzZamowieniaKuriera(json: unknown, zadanie?: unknown): { ok: true; numer: string; sumaKontrolna: string | null } | { ok: false; powod: string; status?: string; numer?: string } {
  const j = rec(json)
  if (!j) return { ok: false, powod: 'nieczytelna odpowiedź DPD' }
  const st = rec(j['status'])
  const status = tekst(st?.['status'])
  // same zera to pusta wartość, nie numer zlecenia (spójnie z czySladUtworzenia w lib/zrodla/dpd-zapis.ts): OK bez
  // numeru = niewiadoma w adapterze, nie przyjęte zlecenie z numerem „0”
  const surowyNumer = tekst(j['orderNumber'])
  const numer = /^0*$/.test(surowyNumer) ? '' : surowyNumer
  if (status === 'OK' || (!status && numer)) {
    if (!numer) return { ok: false, powod: 'DPD nie zwrócił numeru zlecenia' }
    return { ok: true, numer, sumaKontrolna: tekst(j['checkSum']) || null }
  }
  const wolny = (v: unknown) => {
    const m = bezWartosciZadania(tekst(v).replace(/\s+/g, ' '), zadanie)
    return /[\d@]/.test(m) ? '' : m
  }
  // `fields` i `code` przez ten sam filtr co opis (każde pole osobno): echo danych spoza żądania nie trafia do „szczegóły”
  const pola = (v: unknown) => (Array.isArray(v) ? v : [v]).map(wolny).filter(Boolean).join(', ')
  const bledy = Array.isArray(st?.['errorDetails'])
    ? (st!['errorDetails'] as unknown[])
        .map(rec)
        .filter((e): e is Record<string, unknown> => !!e)
        .map((e) => {
          const p = pola(e['fields'])
          // kod przy opisie (jak przy HTTP 4xx): po kodzie automat rozpoznaje pewną odmowę godzin (INCORRECT_PICKUP_TIME)
          const kod = wolny(e['code'])
          const opis = wolny(e['description'])
          const tekstBledu = kod && opis && kod !== opis ? `${kod}: ${opis}` : opis || kod
          return [tekstBledu, p ? `(${p})` : ''].filter(Boolean).join(' ')
        })
        .filter(Boolean)
    : []
  return { ok: false, powod: `${status || 'odmowa DPD'}${bledy.length ? `: ${bledy.join('; ')}` : ''}`, status, numer }
}

/**
 * Dostępność kuriera: zakresy godzin z liczbą minut `offset`. Odpowiedź DPD z produkcji (24.11.2026):
 * `{"status":"OK","ranges":[{"offset":360,"range":"09:00-17:00"},{"offset":180,"range":"11:00-14:00"},{"offset":180,"range":"14:00-17:00"}]}`.
 * Zakresy nie mają dni, a `offset` to minuty, NIE przesunięcie dni (hipoteza: zapas przed końcem przedziału, do
 * którego DPD przyjmuje zamówienie; zgodna z odmową 14:00–17:00 zamawianą po 14:00 i przyjęciem zamówionym przed
 * 14:00). Lista nie jest zamknięta: DPD przyjął też 12:00–17:00 spoza niej. `offset` nieliczbowy, ujemny albo większy
 * od doby = null (zakres zostaje). Status inny niż OK = pusta lista.
 */
export function zakresyDostepnosci(json: unknown): { offsetMin: number | null; zakres: string }[] {
  const j = rec(json)
  if (!j || statusDostepnosci(j) !== 'OK' || !Array.isArray(j['ranges'])) return []
  return (j['ranges'] as unknown[])
    .map(rec)
    .filter((r): r is Record<string, unknown> => !!r && !!tekst(r['range']))
    .map((r) => {
      const o = r['offset']
      return { offsetMin: typeof o === 'number' && Number.isInteger(o) && o >= 0 && o <= 1440 ? o : null, zakres: tekst(r['range']) }
    })
}

/** Status dostępności: wg specyfikacji tekst (`GetCourierOrderAvailabilityStatus`); obiekt `{ status }` też przyjmujemy. */
const statusDostepnosci = (j: Record<string, unknown>): string => tekst(j['status']) || tekst(rec(j['status'])?.['status'])

/** Przedział podjazdu w minutach od północy (Warszawa). */
export interface PrzedzialOdbioru {
  odMin: number
  doMin: number
}

/**
 * Wynik odczytu dostępności kuriera:
 *   OK   — przedziały bez dni (DPD ich nie podaje, obowiązują w każdy dzień odbioru), z liczbą minut `offsetMin`;
 *   BRAK — DPD nie ma przedziałów dla kodu nadawcy (`RANGE_NOT_FOUND` albo OK bez zakresów);
 *   BLAD — inny status albo zakres w nieznanym formacie: okno zostaje przy polach godzin bez podpowiedzi.
 */
export type DostepnoscKuriera = { stan: 'OK'; przedzialy: (PrzedzialOdbioru & { offsetMin: number | null })[] } | { stan: 'BRAK' } | { stan: 'BLAD'; powod: string }

/**
 * Przedziały z tekstu `range` („08:00-16:00”, „08:00 - 12:00, 12:00 - 16:00”, „08:00:00-16:00:00”). [NIEPEWNE] format
 * (specyfikacja nie ma przykładu): bierzemy każdą parę godzin HH:MM–HH:MM; nic nie pasuje = null (nieznany format).
 */
export function przedzialyZZakresu(zakres: string): PrzedzialOdbioru[] | null {
  const out: PrzedzialOdbioru[] = []
  const re = /(\d{1,2}):(\d{2})(?::\d{2})?\s*[-–—]\s*(\d{1,2}):(\d{2})(?::\d{2})?/g
  for (let m = re.exec(zakres); m; m = re.exec(zakres)) {
    const od = Number(m[1]) * 60 + Number(m[2])
    const dO = Number(m[3]) * 60 + Number(m[4])
    if (Number(m[1]) > 23 || Number(m[3]) > 24 || Number(m[2]) > 59 || Number(m[4]) > 59) continue
    const doMin = Math.min(dO, 1439)
    if (od < doMin && !out.some((p) => p.odMin === od && p.doMin === doMin)) out.push({ odMin: od, doMin })
  }
  return out.length ? out : null
}

/** Odpowiedź `courierOrderAvailability` → przedziały bez dni (funkcja czysta, bez danych z żądania w powodzie). */
export function dostepnoscKuriera(json: unknown): DostepnoscKuriera {
  const j = rec(json)
  if (!j) return { stan: 'BLAD', powod: 'nieczytelna odpowiedź DPD' }
  const status = statusDostepnosci(j)
  if (status === 'RANGE_NOT_FOUND') return { stan: 'BRAK' }
  if (status !== 'OK') return { stan: 'BLAD', powod: /^[A-Z_]{2,40}$/.test(status) ? status : 'odpowiedź DPD bez statusu' }
  const lista: (PrzedzialOdbioru & { offsetMin: number | null })[] = []
  for (const { offsetMin, zakres } of zakresyDostepnosci(j)) {
    const p = przedzialyZZakresu(zakres)
    if (!p) return { stan: 'BLAD', powod: 'przedział DPD w nieznanym formacie' }
    for (const x of p) if (!lista.some((y) => y.odMin === x.odMin && y.doMin === x.doMin)) lista.push({ ...x, offsetMin })
  }
  if (!lista.length) return { stan: 'BRAK' }
  return { stan: 'OK', przedzialy: lista.sort((a, b) => a.odMin - b.odMin || a.doMin - b.doMin) }
}
