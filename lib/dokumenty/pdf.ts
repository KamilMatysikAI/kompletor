// PDF wystawionej faktury zamówienia: przycisk „PDF” na karcie zamówienia i punkt zaczepienia dla maila
// „Faktura” / „Wysłane” z załącznikiem (poczta woła `pdfFakturyZamowienia` zamiast własnego pobierania).
// Plik przychodzi z programu do faktur na żądanie i nie jest zapisywany w bazie ani na dysku (to dane klienta).
// Dziś program wFirma (`invoices/download`); inny program dopisze się tu przez zdolność `pdf` dostawcy.
import type { PrismaClient } from '@prisma/client'
import { PODGLAD_AUDIT } from '../klienci/odczyt'
import { WFIRMA_KEYS } from '../konfiguracja'
import { resolveSecrets, type SecretSource } from '../sekrety'
import type { FetchLike } from '../zrodla/http'
import { WfirmaZapis } from '../zrodla/wfirma-zapis'
import { ustawieniaDokumentowFirmy } from './firma'

export class BladPdfFaktury extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export interface PdfFaktury {
  nazwaPliku: string
  contentType: string
  bytes: Uint8Array
  numer: string | null
  /** tylko PDF dokumentu KSeF: zgodność danych bazy z dokumentem w KSeF (null = nie da się sprawdzić). */
  zgodnaZKsef?: boolean | null
}

/** Ostatnia wystawiona faktura bieżącej paczki (albo wskazanej `packageNo`, albo dokładnie dokumentu `docId`). */
export async function wystawionaFaktura(db: PrismaClient, orderId: string, packageNo?: number, docId?: string) {
  const o = await db.order.findUnique({ where: { id: orderId }, select: { id: true, packageNo: true } })
  if (!o) return null
  const gdzie = docId ? { wfirmaDocId: docId } : { packageNo: packageNo ?? o.packageNo, wfirmaDocId: { not: null } }
  return db.invoiceAttempt.findFirst({ where: { orderId, state: 'ISSUED', ...gdzie }, orderBy: { attemptNo: 'desc' }, select: { wfirmaDocId: true, number: true, idExternal: true } })
}

const nazwa = (numer: string | null, docId: string) => `faktura-${(numer ?? docId).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || docId}.pdf`

/** Cel wpisu w dzienniku podglądów danych klienta przy pobraniu PDF faktury. */
export const CEL_PDF_FAKTURY = 'FAKTURA_PDF'

/**
 * `actorId`: kto pobiera plik (osoba z panelu albo `system:poczta` przy załączniku maila). PDF niesie pełne dane
 * nabywcy, więc każde udane pobranie zostawia wpis w dzienniku podglądów (Ustawienia → Dane klientów), jak wydruk.
 */
export async function pdfFakturyZamowienia(db: PrismaClient, orderId: string, deps: { secrets: SecretSource; actorId: string; fetch?: FetchLike; packageNo?: number; docId?: string }): Promise<PdfFaktury> {
  if (!deps.actorId.trim()) throw new Error('pdfFakturyZamowienia: brak actorId')
  const f = await wystawionaFaktura(db, orderId, deps.packageNo, deps.docId)
  if (!f?.wfirmaDocId) throw new BladPdfFaktury('To zamówienie nie ma jeszcze wystawionej faktury', 404)
  const u = await ustawieniaDokumentowFirmy(db)
  if (u.program !== 'wfirma') throw new BladPdfFaktury('PDF faktury jest dostępny tylko z programu wFirma', 409)
  const k = await resolveSecrets(db, WFIRMA_KEYS, deps.secrets)
  if (!WFIRMA_KEYS.every((n) => k[n])) throw new BladPdfFaktury('Brak kluczy wFirmy w konfiguracji firmy', 409)
  const zapis = new WfirmaZapis({ accessKey: k['WFIRMA_ACCESS_KEY']!, secretKey: k['WFIRMA_SECRET_KEY']!, appKey: k['WFIRMA_APP_KEY']!, companyId: k['WFIRMA_COMPANY_ID']! }, deps.fetch ?? fetch, 0, 60_000)
  let pdf: { contentType: string; base64: string }
  try {
    pdf = await zapis.pobierzPdf(f.wfirmaDocId)
  } catch (e) {
    throw new BladPdfFaktury(`Nie udało się pobrać PDF z wFirmy: ${e instanceof Error ? e.message.slice(0, 200) : 'błąd'}`, 502)
  }
  await db.auditLog.create({ data: { entity: PODGLAD_AUDIT, entityId: orderId, actorId: deps.actorId, after: { cel: CEL_PDF_FAKTURY, zakres: 'PELNY', docId: f.wfirmaDocId } } })
  return { nazwaPliku: nazwa(f.number, f.wfirmaDocId), contentType: pdf.contentType, bytes: new Uint8Array(Buffer.from(pdf.base64, 'base64')), numer: f.number }
}
