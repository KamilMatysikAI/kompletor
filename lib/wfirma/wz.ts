// WZ w wFirmie bez faktury (zamówienie wysłane bez faktury przy stanie prowadzonym w wFirmie). Interfejs
// zapisu jak `FakturyWfirma` (lib/rdzen/rozchod.ts): wynik OK | ERROR | TIMEOUT | LIMIT, odszukanie po `id_external`.
// Prawdziwy adapter zapisu to osobne GO na zapis w wFirmie (jak wystawianie faktur); klient
// `WfirmaReadOnly` (lib/zrodla/wfirma.ts) odrzuca dodawanie dokumentów magazynowych (metoda add modułu warehouse_documents). Tu tylko kontrakt i treść żądania,
// zbudowana na kształcie dokumentu WZ z nagranych odpowiedzi `warehouse_documents/find` (tests/nagrania/wfirma-wz).
export interface WzLineWfirma {
  wfirmaGoodId: string
  /** Ilość w jednostce wFirmy (szt. albo kg). */
  count: number
}

export type WzIssueResult =
  | { kind: 'OK'; docId: string; number?: string | null }
  | { kind: 'ERROR'; message: string } // jednoznaczny błąd: dokument nie powstał
  | { kind: 'TIMEOUT' } // nie wiadomo, czy powstał: odszukanie po `id_external`
  | { kind: 'LIMIT'; message: string; retryAfterMs?: number }

export interface WzWfirma {
  issueWz(r: { idExternal: string; warehouseId: string; lines: WzLineWfirma[] }): Promise<WzIssueResult>
  findWzByExternal(idExternal: string): Promise<{ docId: string; idExternal: string; number?: string | null }[]>
}

/** Najdłuższy `id_external` przyjmowany przez hosta (referencja `wz/<orderId>/<paczka>` mieści się z zapasem). */
const MAX_EXTERNAL = 64

/**
 * Treść żądania dodania WZ (moduł warehouse_documents, metoda add): typ, magazyn, data, `id_external` (klucz idempotencji), pozycje z towarem
 * i ilością. Bez kontrahenta i bez danych nabywcy (WZ wewnętrzny do zamówienia). Nazwy pól jak w odpowiedziach `find`
 * (`type`, `date`, `warehouse.id`, `warehouse_document_contents[].warehouse_document_content.good.id` i `count`); do
 * potwierdzenia na żywo przy pierwszym zapisie za GO (pole `id_external` dokumentu magazynowego nie występuje w nagraniach).
 */
export function wzAddBody(r: { idExternal: string; warehouseId: string; date: string; lines: WzLineWfirma[] }): Record<string, unknown> {
  if (!r.idExternal || r.idExternal.length > MAX_EXTERNAL) throw new Error('WZ: referencja pusta albo za długa')
  if (!/^\d+$/.test(r.warehouseId)) throw new Error('WZ: nieprawidłowy magazyn wFirmy')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) throw new Error('WZ: nieprawidłowa data')
  if (!r.lines.length) throw new Error('WZ: brak pozycji')
  const contents: Record<string, unknown> = {}
  r.lines.forEach((l, i) => {
    if (!/^\d+$/.test(l.wfirmaGoodId) || !(l.count > 0)) throw new Error(`WZ: nieprawidłowa pozycja ${i + 1}`)
    contents[String(i)] = { warehouse_document_content: { good: { id: Number(l.wfirmaGoodId) }, count: l.count } }
  })
  return {
    warehouse_documents: {
      warehouse_document: {
        type: 'WZ',
        date: r.date,
        id_external: r.idExternal,
        warehouse: { id: Number(r.warehouseId) },
        warehouse_document_contents: contents,
      },
    },
  }
}
