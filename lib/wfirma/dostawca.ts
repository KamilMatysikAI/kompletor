// wFirma jako dostawca dokumentów sprzedaży: obecna logika za interfejsem DostawcaDokumentow, bez zmiany
// zachowania kolejki wFirmy (lib/rdzen/kolejka-wfirmy.ts woła dalej `FakturyWfirma` i `KorektyWfirma` wprost, z WZ,
// budżetem i limitem). Bez adaptera zapisu (zapis w wFirmie to osobne GO, paczka) dostawca nie umie wystawiać:
// zostaje sama zdolność `stan.magazynu` (wFirma prowadzi stan, rozchód fakturą z WZ).
import type { DostawcaDokumentow, ZdolnoscDokumentow } from '../dokumenty/kontrakt'
import type { WzWfirma } from './wz'
import type { FakturyWfirma } from '../rdzen/rozchod'
import type { KorektyWfirma } from '../rdzen/zwroty'

export function dostawcaWfirmy(api: { faktury?: FakturyWfirma | null; korekty?: KorektyWfirma | null; wz?: WzWfirma | null } = {}): DostawcaDokumentow {
  const zdolnosci: ZdolnoscDokumentow[] = ['stan.magazynu']
  const d: { -readonly [K in keyof DostawcaDokumentow]: DostawcaDokumentow[K] } = { program: 'wfirma', nazwa: 'wFirma', zdolnosci }
  const f = api.faktury
  if (f) {
    zdolnosci.push('wystaw', 'odszukaj')
    d.wystaw = async (z) => {
      const r = await f.issue({ idExternal: z.referencja, lines: z.pozycje, paymentMethod: z.platnosc })
      return r.kind === 'OK' ? { kind: 'OK', docId: r.docId } : r
    }
    d.odszukaj = async (prefix) => (await f.findByPrefix(prefix)).map((x) => ({ docId: x.docId, referencja: x.idExternal }))
  }
  const k = api.korekty
  if (k) {
    zdolnosci.push('koryguj')
    d.koryguj = async (z) => {
      const r = await k.issueCorrection({ idExternal: z.referencja, invoiceDocId: z.docId, lines: z.pozycje })
      return r.kind === 'OK' ? { kind: 'OK', docId: r.docId } : r
    }
  }
  // WZ bez faktury — tylko z adapterem zapisu WZ (osobne GO na zapis w wFirmie, jak faktury)
  const w = api.wz
  if (w) {
    zdolnosci.push('wz')
    d.wydajWz = async (z) => {
      const r = await w.issueWz({ idExternal: z.referencja, warehouseId: z.magazyn, lines: z.pozycje.map((p) => ({ wfirmaGoodId: p.towarId, count: p.ilosc })) })
      return r.kind === 'OK' ? { kind: 'OK', docId: r.docId, numer: r.number ?? null } : r
    }
    d.odszukajWz = async (ref) => (await w.findWzByExternal(ref)).map((x) => ({ docId: x.docId, referencja: x.idExternal, numer: x.number ?? null }))
  }
  return d
}
