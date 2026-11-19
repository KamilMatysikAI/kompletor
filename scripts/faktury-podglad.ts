// Podkomenda `npm run cien -- faktury-podglad --dzien RRRR-MM-DD [--firma …]`. Bez wywołań BL i wFirmy,
// zapis tylko w `InvoiceDryRun` w naszej bazie. Na ekranie liczby, kategorie i numery zamówień, bez danych klientów.
import type { PrismaClient } from '@prisma/client'
import type { KategoriaRoznicy } from '../lib/wfirma/faktura'
import { type PodgladDnia, runFakturyPodglad } from '../lib/wfirma/podglad'
import { PROG_ZGODNOSCI_PROCENT, progSpelniony } from '../lib/wfirma/porownanie'

const NAZWY: Record<KategoriaRoznicy, string> = { BRAK_POWIAZANIA: 'brak powiązania', ZAOKRAGLENIE: 'zaokrąglenie', WYSYLKA: 'wysyłka', VAT: 'VAT', INNE: 'inne' }

export function renderPodglad(r: PodgladDnia): string {
  const L: string[] = []
  const pr = r.procent === null ? '—' : `${r.procent.toFixed(1).replace('.', ',')}%`
  L.push(`[cien] faktury ${r.dzien}: ${r.faktury} faktur BL, zgodnych ${r.zgodne}, z różnicą ${r.roznice} (zgodność ${pr}, próg ${PROG_ZGODNOSCI_PROCENT}%: ${r.procent === null ? 'brak porównań pozycji' : progSpelniony(r.procent) ? 'spełniony' : 'NIESPEŁNIONY'})`)
  if (r.tylkoSumy) L.push(`  w tym zgodne z samych sum (kopia BL bez pozycji), poza progiem: ${r.tylkoSumy}`)
  if (r.bezDanych) L.push(`  bez danych do porównania: ${r.bezDanych} (${r.numeryBezDanych.join(', ')})`)
  if (r.pozaCieniem) L.push(`  poza cieniem (nasz system nie zna zamówienia): ${r.pozaCieniem}`)
  if (r.korekty) L.push(`  korekty BL, pominięte: ${r.korekty}`)
  if (!r.konfiguracja.seria) L.push('  konfiguracja: seria faktur nieustawiona (settings.faktury.seriaId)')
  if (!r.konfiguracja.kodyVat) L.push('  konfiguracja: brak kodów VAT (settings.faktury.kodyVat)')
  if (r.roznice) {
    L.push('  różnice per kategoria:')
    for (const [k, n] of Object.entries(r.perKategoria)) if (n) L.push(`    ${NAZWY[k as KategoriaRoznicy]}: ${n}`)
    L.push('  zamówienia z różnicą:')
    for (const x of r.lista) L.push(`    ${x.numerZamowienia}: ${x.kategorie.map((k) => NAZWY[k]).join(', ')} (${x.kody.join(', ')})`)
  }
  for (const b of r.bledy) L.push(`  BŁĄD ${b}`)
  return L.join('\n')
}

export async function fakturyPodglad(db: PrismaClient, dzien: string): Promise<void> {
  console.log(renderPodglad(await runFakturyPodglad(db, { dzien })))
}
