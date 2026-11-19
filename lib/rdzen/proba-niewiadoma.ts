// Próba faktury wFirmy z niewiadomym wynikiem: FAILED z `lastError` od „timeout” (brak odpowiedzi programu albo
// „nie znaleziono po 3 próbach”). Faktura mogła powstać w wFirmie później (opóźniony indeks find), więc:
// - adapter przed kolejnym zapisem faktury tej paczki pyta jeszcze raz `find` (`adapter-zapis.ts`);
// - karta zamówienia nie pozwala zmienić danych do faktury, dopóki kolejna próba tego nie rozstrzygnie.
// Jedno źródło warunku dla obu miejsc.
import type { Prisma } from '@prisma/client'

const PREFIKS_NIEWIADOMEJ = 'timeout'

/** Warunek Prisma: próba FAILED z niewiadomym wynikiem (do `where` razem z innymi polami). */
export const PROBA_NIEWIADOMA = { state: 'FAILED', lastError: { startsWith: PREFIKS_NIEWIADOMEJ } } satisfies Prisma.InvoiceAttemptWhereInput

/** Ten sam warunek na odczytanym wierszu. */
export function probaNiewiadoma(p: { state: string; lastError: string | null }): boolean {
  return p.state === 'FAILED' && !!p.lastError?.startsWith(PREFIKS_NIEWIADOMEJ)
}
