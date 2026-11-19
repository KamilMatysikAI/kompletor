// Korekta faktury przy zwrocie przez dostawcę dokumentów firmy. Jedna decyzja dla karty zwrotu
// i akcji serwera: czy Kompletor może zlecić korektę, a jeśli nie, dlaczego i co zrobić zamiast tego.
//
//   Faktura z rozchodem w wFirmie (stan z wFirmy, `Return.invoiceDocId`): korektę wystawia kolejka wFirmy przez
//     dostawcę dokumentów (zdolność `koryguj`, lib/wfirma/korekta-zapis.ts), tylko gdy firma ma program wFirma,
//     włączone „Wystawiaj faktury z Kompletora” (`fakturyWlaczone`) i konto sklepu zamówienia jest w trybie Aktywny.
//     Inaczej przycisk „Zleć korektę” jest widoczny i nieaktywny z powodem, a zwrot kończy „Korekta wystawiona poza
//     Kompletorem” (stan wraca po korekcie przez odczyt wFirmy, jak dotąd).
//   Stan prowadzony przez Kompletor (`invoiceDocId = null`): zwrot kończy się przy odbiorze paczki (lib/rdzen/zwroty.ts).
//     Dokument sprzedaży, jeśli był, koryguje się zależnie od programu: „brak” = korekta nie jest potrzebna,
//     KSeF = korekta FA(3) do KSeF przyciskiem na karcie zwrotu i z listy faktur (lib/ksef/wysylka.ts),
//     wFirma = korekta w wFirmie (dokument bez rozchodu).
import type { ChannelMode, ReturnStatus } from '@prisma/client'
import { ETYKIETA_PROGRAMU, type ProgramDokumentow } from '../dokumenty/ustawienia'

export interface StanDoKorekty {
  status: ReturnStatus
  /** Faktura z rozchodem w wFirmie (stan z wFirmy); null = stan Kompletora. */
  invoiceDocId: string | null
  program: ProgramDokumentow
  fakturyWlaczone: boolean
  /** „Korekty faktur przy zwrotach z Kompletora” (osobny wyłącznik, lib/dokumenty/ustawienia.ts `korektyWlaczone`). */
  korektyWlaczone: boolean
  /** Tryb konta sklepu zamówienia (`ChannelConfig.statusMode`); null = konto bez konfiguracji (ręczne, API). */
  trybKonta: ChannelMode | null
  /** Zamówienie ma wystawiony dokument sprzedaży (InvoiceAttempt ISSUED). */
  maDokument: boolean
  /** Stan korekty w kolejce (`Return.correctionState`); ważny w statusie KOREKTA. */
  correctionState?: string | null
  /**
   * inny zwrot tej faktury ma już korektę (`wystawiona`) albo jest w trakcie jej wysyłania (`w_drodze`).
   * Druga korekta z Kompletora liczyłaby się od faktury pierwotnej, więc zostaje tylko korekta w wFirmie.
   */
  innaKorekta?: 'wystawiona' | 'w_drodze' | null
  /**
   * poprzednia próba skończyła się niewiadomą (`Return.lastError` „timeout…”: brak odpowiedzi, wyszukiwanie nie
   * znalazło korekty). Dokument mógł jednak powstać: przed „poza Kompletorem” trzeba sprawdzić wFirmę.
   */
  poNiewiadomej?: boolean
}

export interface MozliwoscKorekty {
  /** „Zleć korektę” aktywne. */
  zlecenie: boolean
  /** Powód, gdy `zlecenie` false (widoczny przy nieaktywnym przycisku albo w opisie). */
  powod: string | null
  /** „Korekta wystawiona poza Kompletorem” (zamyka zwrot bez korekty z Kompletora). */
  recznie: boolean
  /** Szkic korekty FA(3) do pobrania (program KSeF, bez wysyłki). */
  szkicKsef: boolean
  /** „Ponów korektę” aktywne (tylko po błędzie korekty; false = ponowienie znowu by odmówiło, powód w `powod`). */
  ponowienie?: boolean
  /** Ostrzeżenie przy korekcie w kolejce (inna korekta tej faktury, poprzednia próba bez odpowiedzi wFirmy). */
  ostrzezenie?: string
  /** „Ponów korektę” tylko z potwierdzeniem, że w programie korekty nie ma (poprzednia próba bez odpowiedzi). */
  potwierdzenie?: boolean
}

const NAZWA = (p: ProgramDokumentow) => (ETYKIETA_PROGRAMU as Record<string, string>)[p] ?? p

const INNA_KOREKTA = {
  wystawiona: 'Ta faktura ma już korektę z innego zwrotu. Kompletor nie wystawi drugiej (liczyłaby się od faktury pierwotnej): wystaw kolejną korektę w wFirmie i zakończ zwrot.',
  w_drodze: 'Korekta tej faktury z innego zwrotu jest właśnie wysyłana. Kompletor nie wystawi drugiej: poczekaj na jej wynik, potem wystaw kolejną korektę w wFirmie i zakończ zwrot.',
} as const
const PO_NIEWIADOMEJ_FAILED = 'Poprzednia próba korekty nie dała odpowiedzi z wFirmy, a wyszukiwanie jej nie znalazło. Sprawdź w wFirmie, czy ta korekta już nie istnieje: jeśli jest, zakończ zwrot przyciskiem „Korekta wystawiona poza Kompletorem”; jeśli jej nie ma, ponów z potwierdzeniem.'
const PO_NIEWIADOMEJ = 'Poprzednia próba korekty nie dała odpowiedzi z wFirmy, a wyszukiwanie jej nie znalazło. Zanim zakończysz zwrot poza Kompletorem, sprawdź w wFirmie, czy ta korekta już nie istnieje (inaczej będą dwie). Korekta czeka w kolejce na kolejną próbę.'

export function mozliwoscKorekty(s: StanDoKorekty): MozliwoscKorekty {
  const nic = { zlecenie: false, recznie: false, szkicKsef: false }
  if (s.invoiceDocId === null) {
    // stan Kompletora: rozliczenie towaru przy odbiorze; korekta dokumentu sprzedaży zależy od programu
    if (!s.maDokument || s.program === 'brak') return { ...nic, powod: 'Korekta nie jest potrzebna: firma nie wystawia faktur w Kompletorze albo zamówienie nie ma dokumentu sprzedaży.' }
    if (s.program === 'ksef') return { ...nic, szkicKsef: true, powod: 'Korektę FA(3) wysyłasz do KSeF przyciskiem „Wyślij korektę do KSeF” (gdy faktura jest przyjęta w KSeF). Szkic do sprawdzenia możesz pobrać.' }
    return { ...nic, powod: `Dokument sprzedaży skoryguj w programie ${NAZWA(s.program)}: towar wrócił na stan przy odbiorze paczki.` }
  }
  if (s.status === 'KOREKTA') {
    const st = s.correctionState ?? null
    if ((st === null || st === 'FAILED') && s.innaKorekta) return { ...nic, recznie: true, ...(st === 'FAILED' ? { ponowienie: false } : {}), powod: INNA_KOREKTA[s.innaKorekta], ostrzezenie: INNA_KOREKTA[s.innaKorekta] }
    if (st === 'FAILED' && s.poNiewiadomej) return { ...nic, recznie: true, ponowienie: true, potwierdzenie: true, powod: PO_NIEWIADOMEJ_FAILED, ostrzezenie: PO_NIEWIADOMEJ_FAILED }
    if (st === 'FAILED') return { ...nic, recznie: true, ponowienie: true, powod: 'Korekta nie wyszła: popraw dane i ponów albo wystaw korektę w wFirmie i zakończ zwrot.' }
    if (st === null && s.poNiewiadomej) return { ...nic, recznie: true, powod: PO_NIEWIADOMEJ, ostrzezenie: PO_NIEWIADOMEJ }
    if (st === null) return { ...nic, recznie: true, powod: 'Korekta czeka w kolejce programu do faktur. Jeśli wystawiasz ją sam w wFirmie, zakończ zwrot.' }
    return { ...nic, powod: 'Korekta jest właśnie wysyłana do programu do faktur.' }
  }
  if (s.status !== 'PRZYJETY') return { ...nic, powod: s.status === 'ZGLOSZONY' ? 'Najpierw odbierz paczkę i oznacz pozycje.' : null }
  const recznie = { ...nic, recznie: true }
  if (s.innaKorekta) return { ...recznie, powod: INNA_KOREKTA[s.innaKorekta] }
  if (s.program !== 'wfirma') return { ...recznie, powod: `Faktura pochodzi z wFirmy, a firma ma ustawiony program „${NAZWA(s.program)}”: wystaw korektę w wFirmie i zakończ zwrot.` }
  if (!s.fakturyWlaczone) return { ...recznie, powod: 'Wystawianie faktur z Kompletora jest wyłączone (Ustawienia → Dokumenty i faktury → Dokumenty sprzedaży): wystaw korektę w wFirmie i zakończ zwrot.' }
  if (!s.korektyWlaczone) return { ...recznie, powod: 'Korekty faktur z Kompletora są wyłączone (Ustawienia → Dokumenty i faktury → Dokumenty sprzedaży → „Korekty faktur przy zwrotach z Kompletora”): wystaw korektę w wFirmie i zakończ zwrot.' }
  if (s.trybKonta !== 'PRACA') return { ...recznie, powod: 'Konto sklepu tego zamówienia jest w trybie „Tylko podgląd”: korektę wystawia dotychczasowy system.' }
  return { zlecenie: true, powod: null, recznie: true, szkicKsef: false }
}
