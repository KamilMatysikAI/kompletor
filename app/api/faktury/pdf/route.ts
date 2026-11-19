// GET /api/faktury/pdf: PDF faktury albo korekty z listy faktur.
//   ?d=<wiersz KSeF>           jeden dokument z naszego generatora (program „KSeF bezpośrednio”),
//   ?k=w:<próba>&k=k:<wiersz>  kilka dokumentów naraz w jednym pliku (najwyżej 50): wFirma z programu, KSeF z generatora.
// Sesja i uprawnienie `zamowienia.faktury` oraz `klienci.dane` (faktura niesie dane nabywcy); każde pobranie = wpis
// w dzienniku podglądów danych klienta. Plik nie jest zapisywany po naszej stronie. Żądanie z obcej strony dostaje 403.
// Dokument, który się nie złożył, jest pomijany, a liczba pominiętych idzie w nagłówku `x-pominiete`.
import type { NextRequest } from 'next/server'
import { BladPdfFaktury, pdfFakturyZamowienia, type PdfFaktury } from '@/lib/dokumenty/pdf'
import { pdfDokumentuKsef, polaczPdf } from '@/lib/dokumenty/pdf-ksef'
import { appModeOf } from '@/lib/organizacje'
import { requirePermissionApi } from '@/lib/stanowisko/sesja-api'

export const dynamic = 'force-dynamic'

const ID = /^[a-z0-9]{1,40}$/i
const MAX = 50

export async function GET(req: NextRequest): Promise<Response> {
  const ctx = await requirePermissionApi('zamowienia.faktury')
  if (ctx instanceof Response) return ctx
  if (!ctx.permissions.has('klienci.dane')) return Response.json({ error: 'Faktura zawiera dane klienta: potrzebne uprawnienie do danych klienta' }, { status: 403 })
  const site = req.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') return Response.json({ error: 'Faktura tylko z panelu' }, { status: 403 })
  const secrets = { env: process.env, envFallback: appModeOf(process.env) === 'self-host' }
  const jeden = req.nextUrl.searchParams.get('d')
  const jeden1 = async (klucz: string): Promise<PdfFaktury> => {
    const [rodzaj, id] = klucz.split(':')
    if (!id || !ID.test(id)) throw new BladPdfFaktury('Nie ma takiego dokumentu', 400)
    if (rodzaj === 'k') return pdfDokumentuKsef(ctx.db, id, { actorId: ctx.user.id })
    if (rodzaj === 'w') {
      const a = await ctx.db.invoiceAttempt.findUnique({ where: { id }, select: { orderId: true, wfirmaDocId: true, state: true } })
      if (!a?.wfirmaDocId || a.state !== 'ISSUED') throw new BladPdfFaktury('Faktura nie jest wystawiona', 404)
      return pdfFakturyZamowienia(ctx.db, a.orderId, { secrets, actorId: ctx.user.id, docId: a.wfirmaDocId })
    }
    throw new BladPdfFaktury('Nie ma takiego dokumentu', 400)
  }
  try {
    const pojedynczy = jeden ? `k:${jeden}` : req.nextUrl.searchParams.getAll('k').length === 1 ? req.nextUrl.searchParams.get('k')! : null
    if (pojedynczy) {
      const pdf = await jeden1(pojedynczy)
      return new Response(new Uint8Array(pdf.bytes), { headers: { 'content-type': pdf.contentType, 'content-disposition': `inline; filename="${pdf.nazwaPliku}"`, 'cache-control': 'no-store' } })
    }
    const klucze = [...new Set(req.nextUrl.searchParams.getAll('k'))].slice(0, MAX)
    if (!klucze.length) return Response.json({ error: 'Nie wybrano dokumentów' }, { status: 400 })
    const pliki: Uint8Array[] = []
    let pominiete = 0
    // po kolei: wFirma ma wspólny limit wywołań, a błąd jednego dokumentu nie zatrzymuje reszty
    for (const k of klucze) {
      try {
        const p = await jeden1(k)
        if (p.contentType.includes('pdf')) pliki.push(p.bytes)
        else pominiete++
      } catch {
        pominiete++
      }
    }
    if (!pliki.length) return Response.json({ error: 'Żaden z wybranych dokumentów nie ma jeszcze PDF' }, { status: 404 })
    const razem = await polaczPdf(pliki)
    return new Response(new Uint8Array(razem), { headers: { 'content-type': 'application/pdf', 'content-disposition': 'inline; filename="faktury.pdf"', 'cache-control': 'no-store', 'x-pominiete': String(pominiete) } })
  } catch (e) {
    if (e instanceof BladPdfFaktury) return Response.json({ error: e.message }, { status: e.status })
    throw e
  }
}
