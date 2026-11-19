// Numeracja faktur firmy bez wFirmy. Art. 106e ust. 1 pkt 2 ustawy o VAT: kolejny numer w ramach jednej
// lub więcej serii, jednoznacznie identyfikujący fakturę [do potwierdzenia przez księgową: reset roczny czy miesięczny].
//
// `przydzielNumer` działa w transakcji wywołującego: jedno `INSERT … ON CONFLICT DO UPDATE` zwiększa licznik okresu
// atomowo i trzyma blokadę wiersza do końca transakcji. Równoległe wywołania czekają na siebie (bez dubla), a wycofanie
// transakcji cofa licznik (bez dziury). Firmę wypełnia baza (`app.org_id` klienta firmy, RLS).
//
// Numer przydziela się dopiero przy zatwierdzeniu do wysyłki, nigdy przy szkicu (szkic ma P_2 = SZKIC-<id>). Woła go
// wysyłka do KSeF (lib/ksef/wysylka.ts) raz na fakturę i raz na korektę (osobna seria korekt).
//
// (G8): wzór także w zapisie jak w BaseLinkerze: %N numer, %M miesiąc, %Y rok, %D dzień, %y rok dwucyfrowo
// (np. `%N/%M/%Y`, korekty `%N/%M/%Y/K`). Oba zapisy można mieszać; w bazie zostaje wzór tak, jak go wpisano.
import type { Prisma } from '@prisma/client'

export const OKRESY_RESETU = ['ROK', 'MIESIAC', 'NIGDY'] as const
export type OkresResetu = (typeof OKRESY_RESETU)[number]

export interface SeriaNumeracji {
  code: string
  /** Wzorzec, np. `FV/{NR}/{MM}/{RRRR}`; znaczniki: {NR}, {DD}, {MM}, {RRRR}, {RR}. {NR} obowiązkowy. */
  pattern: string
  resetPeriod: OkresResetu
}

export interface PrzydzielonyNumer {
  numer: string
  nr: number
  periodKey: string
}

const DATA_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function czesciDaty(data: string): { rrrr: string; mm: string; dd: string } {
  const m = DATA_RE.exec(data)
  if (!m || new Date(`${data}T00:00:00Z`).toISOString().slice(0, 10) !== data) throw new Error('Data wystawienia nie jest datą RRRR-MM-DD')
  return { rrrr: m[1]!, mm: m[2]!, dd: m[3]! }
}

/** Klucz okresu licznika: rok, miesiąc albo „-” (seria bez resetu). */
export function kluczOkresu(reset: OkresResetu, dataWystawienia: string): string {
  const d = czesciDaty(dataWystawienia)
  if (reset === 'ROK') return d.rrrr
  if (reset === 'MIESIAC') return `${d.rrrr}-${d.mm}`
  return '-'
}

/** Wzór w zapisie BaseLinkera (%N, %M, %Y, %D, %y) zamieniony na znaczniki w klamrach. */
export function normalizujWzor(pattern: string): string {
  return pattern.replace(/%N/g, '{NR}').replace(/%M/g, '{MM}').replace(/%Y/g, '{RRRR}').replace(/%D/g, '{DD}').replace(/%y/g, '{RR}')
}

export function formatujNumer(pattern: string, nr: number, dataWystawienia: string): string {
  const d = czesciDaty(dataWystawienia)
  return normalizujWzor(pattern).replace(/\{NR\}/g, String(nr)).replace(/\{DD\}/g, d.dd).replace(/\{MM\}/g, d.mm).replace(/\{RRRR\}/g, d.rrrr).replace(/\{RR\}/g, d.rrrr.slice(2))
}

/** Błędy definicji serii (puste = poprawna). */
export function problemySerii(s0: SeriaNumeracji): string[] {
  const p: string[] = []
  const s = { ...s0, pattern: normalizujWzor(s0.pattern) }
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(s.code)) p.push('zły kod serii (litery, cyfry, _ i -, do 40 znaków)')
  if (!s.pattern.includes('{NR}')) p.push('wzorzec numeru bez numeru ({NR} albo %N)')
  if (/%/.test(s.pattern)) p.push('nieznany znacznik z % we wzorcu (dozwolone %N, %M, %Y, %D, %y)')
  if (s.pattern.length > 120) p.push('wzorzec numeru dłuższy niż 120 znaków')
  if (!OKRESY_RESETU.includes(s.resetPeriod)) p.push('nieznany okres resetu (ROK, MIESIAC, NIGDY)')
  // bez okresu w numerze reset roczny/miesięczny dałby dwa takie same numery w różnych okresach
  if (s.resetPeriod === 'ROK' && !/\{RRRR\}|\{RR\}/.test(s.pattern)) p.push('reset roczny wymaga roku we wzorcu ({RRRR}, {RR} albo %Y)')
  if (s.resetPeriod === 'MIESIAC' && !(/\{MM\}/.test(s.pattern) && /\{RRRR\}|\{RR\}/.test(s.pattern))) p.push('reset miesięczny wymaga miesiąca i roku we wzorcu (np. %M i %Y)')
  return p
}

/** Kolejny numer serii w okresie daty wystawienia. Wołać wyłącznie w transakcji zatwierdzenia do wysyłki. */
export async function przydzielNumer(tx: Pick<Prisma.TransactionClient, '$queryRaw'>, seria: SeriaNumeracji, dataWystawienia: string): Promise<PrzydzielonyNumer> {
  const p = problemySerii(seria)
  if (p.length) throw new Error(`Seria numeracji: ${p.join('; ')}`)
  const periodKey = kluczOkresu(seria.resetPeriod, dataWystawienia)
  const rows = await tx.$queryRaw<{ lastNo: number; pattern: string }[]>`
    INSERT INTO "InvoiceNumberSeries" ("code", "pattern", "resetPeriod", "periodKey", "lastNo", "updatedAt")
    VALUES (${seria.code}, ${seria.pattern}, ${seria.resetPeriod}, ${periodKey}, 1, now())
    ON CONFLICT ("organizationId", "code", "periodKey") DO UPDATE SET "lastNo" = "InvoiceNumberSeries"."lastNo" + 1, "updatedAt" = now()
    RETURNING "lastNo", "pattern"`
  const r = rows[0]
  if (!r) throw new Error('Seria numeracji: baza nie zwróciła numeru')
  // wzorzec z wiersza okresu: zmiana ustawień w trakcie okresu nie zmienia formatu numerów tego okresu
  return { numer: formatujNumer(r.pattern, r.lastNo, dataWystawienia), nr: r.lastNo, periodKey }
}
