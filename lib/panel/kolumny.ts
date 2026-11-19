// ukryte kolumny tabel panelu zapisane na koncie osoby (`User.kolumnyTabel`), żeby wybór „Kolumny” działał
// na każdym komputerze po zalogowaniu (jak gęstość). Kształt: { "<id tabeli>": ["klucz", …] }. Czyste funkcje:
// odczyt dla tabeli i nowa wartość po zmianie (śmieci odrzucone, limity długości, żeby pole nie rosło bez końca).
import type { Prisma } from '@prisma/client'

const KLUCZ = /^[a-z0-9_-]{1,40}$/i
const MAKS_TABEL = 30
const MAKS_KOLUMN = 40

function mapa(v: unknown): Record<string, string[]> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Record<string, string[]> = {}
  for (const [k, w] of Object.entries(v as Record<string, unknown>)) {
    if (!KLUCZ.test(k) || !Array.isArray(w)) continue
    out[k] = w.filter((x): x is string => typeof x === 'string' && KLUCZ.test(x)).slice(0, MAKS_KOLUMN)
  }
  return out
}

/** Ukryte kolumny tabeli `tabela`; null = osoba nic nie wybierała (tabela bierze swoje domyślne). */
export function ukryteKolumny(v: unknown, tabela: string): string[] | null {
  const m = mapa(v)
  return Object.prototype.hasOwnProperty.call(m, tabela) ? m[tabela]! : null
}

/** Nowa wartość pola po zmianie wyboru w jednej tabeli; null = zła nazwa tabeli (nic nie zapisujemy). */
export function zKolumnami(v: unknown, tabela: string, ukryte: unknown): Prisma.InputJsonObject | null {
  if (!KLUCZ.test(tabela) || !Array.isArray(ukryte)) return null
  const m = mapa(v)
  m[tabela] = [...new Set(ukryte.filter((x): x is string => typeof x === 'string' && KLUCZ.test(x)))].slice(0, MAKS_KOLUMN)
  const klucze = Object.keys(m)
  if (klucze.length > MAKS_TABEL) for (const k of klucze.slice(0, klucze.length - MAKS_TABEL)) if (k !== tabela) delete m[k]
  return m
}
