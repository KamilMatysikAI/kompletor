// PDF dokumentu sprzedaży do maila „Faktura”. Wąski port: poczta pyta o plik po zamówieniu i numerze
// dokumentu z planu akcji, nie zna wFirmy ani KSeF.
//
// źródło idzie przez program do faktur firmy (Ustawienia → Dokumenty sprzedaży, lib/dokumenty):
// `brak` → BRAK (firma nie wystawia dokumentów w Kompletorze; reguła i tak nie planuje maila bez wystawionej faktury),
// `wfirma` → plik z wFirmy (`zrodloPdfZProgramu`), inny program → dostawca dokumentów ze zdolnością `pdf`
// (`umiePdf(d)` i `d.pdf(docId)`). Dostawca bez tej zdolności = BRAK, chwilowy błąd dostawcy = POZNIEJ. Numer
// dokumentu do tematu maila z próby wystawienia (InvoiceAttempt.number), gdy program go podał.
// Testy wstrzykują własne źródło (`deps.pdf` w lib/poczta/wysylka.ts) albo fabrykę dostawcy (`zrodloPdfZDokumentow`).
import type { PrismaClient } from '@prisma/client'
import { BrakDostawcyError, dostawcaDokumentow } from '../dokumenty/dostawcy'
import { ustawieniaDokumentowFirmy } from '../dokumenty/firma'
import { umiePdf, type DostawcaDokumentow } from '../dokumenty/kontrakt'
import { BladPdfFaktury, CEL_PDF_FAKTURY, pdfFakturyZamowienia, wystawionaFaktura } from '../dokumenty/pdf'
import type { ProgramDokumentow } from '../dokumenty/ustawienia'
import { PODGLAD_AUDIT } from '../klienci/odczyt'
import { appModeOf } from '../organizacje'
import type { FetchLike } from '../zrodla/http'

export type WynikPdf =
  | { stan: 'PDF'; tresc: Uint8Array; numer?: string | null; nazwaPliku?: string | null }
  /** Plik będzie później (dokument w drodze, chwilowy błąd dostawcy): ponowienie za chwilę. */
  | { stan: 'POZNIEJ'; powod: string }
  /** Dostawca tej firmy nie daje PDF: mail czeka do końca okna, potem jest pomijany. */
  | { stan: 'BRAK'; powod: string }

export interface ZrodloPdf {
  pobierz(db: PrismaClient, p: { orderId: string; docId: string }): Promise<WynikPdf>
}

/**
 * PDF faktury wystawionej z Kompletora (`InvoiceAttempt` ISSUED z tym `wfirmaDocId`) pobierany z programu do
 * faktur przez `pdfFakturyZamowienia`, z wpisem w dzienniku podglądów (aktor `system:poczta`). Dokument spoza
 * Kompletora (faktura z BaseLinkera na koncie w cieniu) albo program bez PDF = BRAK; chwilowy błąd pobrania = POZNIEJ.
 * Sekrety jak trasa PDF: z konfiguracji firmy, a na instalacji własnej także ze zmiennych środowiska.
 */
export function zrodloPdfZProgramu(env: Record<string, string | undefined> = process.env, fetchImpl?: FetchLike): ZrodloPdf {
  return {
    async pobierz(db, p) {
      try {
        const pdf = await pdfFakturyZamowienia(db, p.orderId, { secrets: { env, envFallback: appModeOf(env) === 'self-host' }, actorId: 'system:poczta', docId: p.docId, ...(fetchImpl ? { fetch: fetchImpl } : {}) })
        return { stan: 'PDF', tresc: pdf.bytes, numer: pdf.numer, nazwaPliku: pdf.nazwaPliku }
      } catch (e) {
        if (!(e instanceof BladPdfFaktury)) throw e
        if (e.status === 404) return { stan: 'BRAK', powod: 'faktura spoza Kompletora: PDF nie jest dostępny' }
        if (e.status === 409) return { stan: 'BRAK', powod: e.message }
        return { stan: 'POZNIEJ', powod: e.message }
      }
    },
  }
}

/**
 * Dostawca dokumentów firmy dla programu spoza wFirmy. `null` = program nie jest podłączony na tej instancji (adapter
 * z rejestru, którego host jeszcze nie tworzy): mail czeka jak przy braku PDF, bez błędu.
 */
export type FabrykaDostawcy = (db: PrismaClient, program: ProgramDokumentow) => Promise<DostawcaDokumentow | null>

/** Domyślnie: wbudowane programy (KSeF bez pliku PDF); program z rejestru bez podłączonego adaptera = null. */
export const fabrykaWbudowana: FabrykaDostawcy = async (_db, program) => {
  try {
    return dostawcaDokumentow(program)
  } catch (e) {
    if (e instanceof BrakDostawcyError) return null
    throw e
  }
}

const krotko = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 200)

/**
 * PDF z programu do faktur firmy (Ustawienia → Dokumenty sprzedaży). Wpis w dzienniku podglądów danych
 * klienta (aktor `system:poczta`) jak przy wFirmie: PDF niesie pełne dane nabywcy.
 */
export function zrodloPdfZDokumentow(deps: { env?: Record<string, string | undefined>; fetch?: FetchLike; dostawca?: FabrykaDostawcy } = {}): ZrodloPdf {
  const wfirma = zrodloPdfZProgramu(deps.env ?? process.env, deps.fetch)
  const fabryka = deps.dostawca ?? fabrykaWbudowana
  return {
    async pobierz(db, p) {
      const { program } = await ustawieniaDokumentowFirmy(db)
      if (program === 'brak') return { stan: 'BRAK', powod: 'firma nie wystawia dokumentów sprzedaży w Kompletorze (Ustawienia → Dokumenty i faktury → Dokumenty sprzedaży)' }
      if (program === 'wfirma') return wfirma.pobierz(db, p)
      let d: DostawcaDokumentow | null
      try {
        d = await fabryka(db, program)
      } catch (e) {
        return { stan: 'POZNIEJ', powod: `program do faktur chwilowo niedostępny: ${krotko(e)}` }
      }
      if (!d || !umiePdf(d)) return { stan: 'BRAK', powod: `program do faktur ${d?.nazwa ?? program} nie daje pliku PDF` }
      const f = await wystawionaFaktura(db, p.orderId, undefined, p.docId)
      if (!f?.wfirmaDocId) return { stan: 'BRAK', powod: 'dokument spoza Kompletora: PDF nie jest dostępny' }
      let plik: { contentType: string; base64: string }
      try {
        plik = await d.pdf(f.wfirmaDocId)
      } catch (e) {
        return { stan: 'POZNIEJ', powod: `nie udało się pobrać PDF z programu ${d.nazwa}: ${krotko(e)}` }
      }
      const tresc = new Uint8Array(Buffer.from(plik?.base64 ?? '', 'base64'))
      if (!tresc.length) return { stan: 'POZNIEJ', powod: `program ${d.nazwa} zwrócił pusty plik PDF` }
      await db.auditLog.create({ data: { entity: PODGLAD_AUDIT, entityId: p.orderId, actorId: 'system:poczta', after: { cel: CEL_PDF_FAKTURY, zakres: 'PELNY', docId: f.wfirmaDocId } } })
      return { stan: 'PDF', tresc, numer: f.number ?? null, nazwaPliku: null }
    },
  }
}

export const domyslneZrodloPdf: ZrodloPdf = zrodloPdfZDokumentow()
