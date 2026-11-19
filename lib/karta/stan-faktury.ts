// Stan faktury bieżącej paczki na karcie zamówienia (sekcja „Dokument sprzedaży”) jako czysta funkcja: tekst, ton
// odznaki i flagi, od których zależą przycisk „Ponów fakturę”, baner błędu i samoodświeżanie karty.
import { statusyMomentu, type MomentWystawienia } from '@/lib/dokumenty/ustawienia'
import type { Ton } from '@/lib/panel/statusy'
import { flagsOf } from '@/lib/rdzen/rezerwacja'
import type { DaneKarty } from './dane'

export type StanFaktury = { tekst: string; ton: Ton; numer: string | null; blad: boolean; wystawiona: boolean; wToku: boolean }

type ZamowienieKarty = DaneKarty['o']
export type ZamowienieDoStanuFaktury = Pick<ZamowienieKarty, 'packageNo' | 'status' | 'mode' | 'flags' | 'wantInvoiceNip' | 'parentOrderId'> & {
  invoices: Pick<ZamowienieKarty['invoices'][number], 'packageNo' | 'attemptNo' | 'state' | 'number' | 'wfirmaDocId'>[]
}

export const TEKST_PONOWIONA = 'W kolejce: system wystawi fakturę w ciągu kilku minut'

/**
 * Stan faktury bieżącej paczki słowem (czysta funkcja). `kiedy` = moment z ustawień firmy, do tekstu „jeszcze nie”.
 * `m`: moment dla źródła stanu — „W kolejce” tylko wtedy, gdy faktura naprawdę idzie po spakowaniu.
 * `opcje.spakowanePrzedWlaczeniem`: spakowane przed włączeniem „Wystawiaj faktury z Kompletora”,
 * kolejka ich nie fakturuje. `opcje.wystawianieWylaczone`: kolejka nie wystawia żadnej faktury. `opcje.tylkoSpakowane`:
 * faktura z rozchodem (stan w programie do faktur) idzie tylko ze statusu „Spakowane”.
 */
export function stanFaktury(
  d: { o: ZamowienieDoStanuFaktury },
  kiedy = 'po spakowaniu',
  m: { wystawiajPrzy: string; tylkoNaZadanie: boolean } = { wystawiajPrzy: 'SPAKOWANE', tylkoNaZadanie: false },
  opcje: { spakowanePrzedWlaczeniem?: boolean; wystawianieWylaczone?: boolean; tylkoSpakowane?: boolean } = {},
): StanFaktury {
  const { o } = d
  const ost = o.invoices.filter((i) => i.packageNo === o.packageNo).at(-1)
  const f = flagsOf(o)
  const blad = !!f.fakturaBlad
  const baza = { blad: false, wystawiona: false, wToku: false }
  const bezProsby = m.tylkoNaZadanie && !o.wantInvoiceNip && !o.parentOrderId
  if (ost?.state === 'ISSUED') return { ...baza, tekst: 'Wystawiona', ton: 'sukces', numer: ost.number ?? ost.wfirmaDocId, wystawiona: true }
  if (ost?.state === 'SENDING' || ost?.state === 'UNKNOWN')
    return { ...baza, tekst: ost.state === 'SENDING' ? 'W kolejce' : 'W kolejce: sprawdzamy w programie do faktur, czy powstała', ton: 'info', numer: null, wToku: true }
  // Po „Ponów fakturę” flaga błędu jest zdjęta, a ostatnią próbą jest dalej ta nieudana sprzed ponowienia, dopóki kolejka
  // nie zacznie nowej. Pokazujemy oczekiwanie tylko wtedy, gdy kolejka to zamówienie naprawdę podejmie (te same warunki
  // co jej wybór zamówień); w innym razie zostaje błąd, żeby stan nie wisiał w „W kolejce”.
  const ponowiona = !blad && ost?.state === 'FAILED' && f.fakturaPonowionaPo === ost.attemptNo
  if (ponowiona && kolejkaPodejmie(o.status, o.mode, m.wystawiajPrzy, bezProsby, opcje))
    return { ...baza, tekst: TEKST_PONOWIONA, ton: 'info', numer: null, wToku: true }
  if (blad || ost?.state === 'FAILED') return { ...baza, tekst: 'Błąd: faktura się nie wystawiła', ton: 'blad', numer: null, blad: true }
  if (o.status === 'ANULOWANE') return { ...baza, tekst: 'Bez faktury (anulowane)', ton: 'neutralny', numer: null }
  if (bezProsby) return { ...baza, tekst: 'Bez faktury: klient nie prosił o fakturę', ton: 'neutralny', numer: null }
  if (o.status === 'SPAKOWANE' && opcje.spakowanePrzedWlaczeniem)
    return { ...baza, tekst: 'Bez faktury z Kompletora: spakowane przed włączeniem wystawiania. Wystaw ją jak dotąd i kliknij „Wyślij bez faktury”', ton: 'ostrzezenie', numer: null }
  if (o.status === 'SPAKOWANE' && o.mode === 'PRACA' && m.wystawiajPrzy === 'SPAKOWANE') return { ...baza, tekst: 'W kolejce', ton: 'info', numer: null }
  return { ...baza, tekst: `Jeszcze nie wystawiana: faktura idzie ${kiedy}`, ton: 'neutralny', numer: null }
}

/** Czy kolejka faktur weźmie to zamówienie w najbliższym przebiegu (status, tryb konta, ustawienia firmy). */
function kolejkaPodejmie(
  status: string,
  mode: string,
  wystawiajPrzy: string,
  bezProsby: boolean,
  opcje: { spakowanePrzedWlaczeniem?: boolean; wystawianieWylaczone?: boolean; tylkoSpakowane?: boolean },
): boolean {
  if (opcje.wystawianieWylaczone || opcje.spakowanePrzedWlaczeniem || bezProsby || mode !== 'PRACA') return false
  if (opcje.tylkoSpakowane) return status === 'SPAKOWANE'
  return (statusyMomentu(wystawiajPrzy as MomentWystawienia) as string[]).includes(status)
}
