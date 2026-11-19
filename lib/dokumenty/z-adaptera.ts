// Dostawca dokumentów z adaptera rejestru rodzaju `invoicing`. Nowy program do faktur (Fakturownia,
// inFakt, iFirma) = jeden plik adaptera z manifestem i metodami zdolności `invoice.*` (lib/adaptery/kontrakt.ts) plus
// wpis w rejestrze (lib/adaptery/domyslne.ts). Host owija go tutaj w DostawcaDokumentow: zdolność istnieje tylko wtedy,
// gdy manifest ją deklaruje i adapter ma metodę (strażniki typu), więc adapter nie musi umieć wszystkiego.
import { type ChannelAdapter, hasInvoiceCorrector, hasInvoiceFinder, hasInvoiceIssuer, hasInvoicePdfReader, hasInvoicePreparer, type InvoiceIssueResult } from '../adaptery/kontrakt'
import type { DostawcaDokumentow, WynikDokumentu, ZdolnoscDokumentow } from './kontrakt'

const wynik = (r: InvoiceIssueResult): WynikDokumentu => (r.kind === 'OK' ? { kind: 'OK', docId: r.docId, numer: r.number ?? null } : r)

export function dostawcaZAdaptera(a: ChannelAdapter): DostawcaDokumentow {
  if (a.manifest.kind !== 'invoicing') throw new Error(`adapter ${a.manifest.adapterKey} nie jest programem do faktur`)
  const zdolnosci: ZdolnoscDokumentow[] = []
  const d: { -readonly [K in keyof DostawcaDokumentow]: DostawcaDokumentow[K] } = { program: a.manifest.adapterKey, nazwa: a.manifest.displayName, zdolnosci }
  if (hasInvoicePreparer(a)) {
    zdolnosci.push('przygotuj')
    d.przygotuj = (w) => a.prepareInvoice(w)
  }
  if (hasInvoiceIssuer(a)) {
    zdolnosci.push('wystaw')
    d.wystaw = async (z) => wynik(await a.issueInvoice({ reference: z.referencja, lines: z.pozycje, paymentMethod: z.platnosc, ...(z.rodzaj ? { kind: z.rodzaj } : {}) }))
  }
  if (hasInvoiceFinder(a)) {
    zdolnosci.push('odszukaj')
    d.odszukaj = async (p) => (await a.findInvoices(p)).map((f) => ({ docId: f.docId, referencja: f.reference, numer: f.number ?? null }))
  }
  if (hasInvoicePdfReader(a)) {
    zdolnosci.push('pdf')
    d.pdf = (id) => a.getInvoicePdf(id)
  }
  if (hasInvoiceCorrector(a)) {
    zdolnosci.push('koryguj')
    d.koryguj = async (z) => wynik(await a.correctInvoice({ reference: z.referencja, docId: z.docId, lines: z.pozycje }))
  }
  return d
}
