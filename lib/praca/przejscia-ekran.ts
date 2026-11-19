// Przyciski sekcji „Co dalej” na karcie zamówienia w trybie PRACA. Czysta funkcja: dozwolone przejścia z
// tabeli rdzenia (`canTransition`, lib/rdzen/statusy.ts), warunki z `powodOdmowy` (lib/rdzen/przejscia.ts) — ta sama
// odpowiedź, którą da rdzeń pod blokadą zamówienia. Przycisk niedostępny ma powód jednym zdaniem, żeby biuro nie
// trafiło na martwy stan. Nic tu nie zapisuje: wykonanie robi `wykonajPrzejscie` (lib/praca/wykonaj.ts).
//
// Stanowisko pakowania i decyzje o brakach należą (ekran stanowiska, blok „Brak towaru” na karcie):
// sekcja tylko do nich linkuje.
import type { Carrier, OrderStatus, PaymentState } from '@prisma/client'
import { bezPaczki, type FaktyPrzejscia, powodOdmowy } from '@/lib/rdzen/przejscia'
import { canTransition } from '@/lib/rdzen/statusy'

export const AKCJE_PRACY = [
  'oplacone',
  'anuluj',
  'zbieranie',
  'spakuj',
  'zebrane',
  'przerwij',
  'wydanie',
  'odebrane_bez_wysylki',
  'bez_faktury',
  'wyslane',
  'odebrane',
  'wyjasnione',
  'zwrot_na_stan',
  'pakuj_mimo_faktury_bl',
] as const
export type AkcjaPracy = (typeof AKCJE_PRACY)[number]

export const isAkcjaPracy = (v: unknown): v is AkcjaPracy => typeof v === 'string' && (AKCJE_PRACY as readonly string[]).includes(v)

export interface ZamowienieEkranu {
  status: OrderStatus
  carrier: Carrier | null
  pendingAction: string | null
  paymentState: PaymentState
  /** Flaga „karta nieaktualna” (3.7): spakowanie odmawia, póki nie ma nowego wydruku. */
  kartaNieaktualna: boolean
}

export interface FaktyEkranu extends FaktyPrzejscia {
  /** Faktura w drodze (rezerwacja CONSUMING albo próba SENDING / UNKNOWN): anulowanie poczeka na jej wynik. */
  fakturaWToku: boolean
  /** Towar wydany albo faktura wystawiona (dowolna paczka): anulowanie = korekta, osobne uprawnienie. */
  poFakturze: boolean
  /**
   * anulowane zamówienie, którego towar zszedł ze stanu Kompletora przy wydaniu — ile sztuk (jednostka bazowa)
   * jeszcze nie wróciło zwrotem. Brak pola albo 0 = nic do przyjęcia.
   */
  doZwrotu?: number
  /**
   * konto w trybie pracy, zamówienie z fakturą BL bez decyzji „Pakuj mimo faktury z BaseLinkera”: numer
   * faktury BL (pakowanie wstrzymane, `blokadaPakowaniaFakturaBl`). Brak pola albo null = bez blokady.
   */
  fakturaBl?: string | null
}

export interface Przycisk {
  akcja: AkcjaPracy
  etykieta: string
  /** null = można kliknąć; inaczej powód niedostępności jednym zdaniem. */
  powod: string | null
  /** Pytanie przed wykonaniem (anulowanie, „Wyślij bez faktury”). */
  potwierdz?: string
  /** „Wysłane”: pole numeru nadania (opcjonalne). */
  numerNadania?: true
  /** „Wyjaśnione” dla zamówienia bez wysyłki z dołożonym towarem: wybór przewoźnika obowiązkowy. */
  wyborPrzewoznika?: true
  glowny?: true
}

const BEZ_PRAWA_DECYZJI_BL = 'Odblokować pakowanie zamówienia z fakturą z BaseLinkera może osoba z uprawnieniem do zmiany statusu na dowolny (Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia).'

const BEZ_UPRAWNIENIA = 'Nie masz uprawnienia do zmiany statusu zamówienia (Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia).'

/** Co wykonuje akcja: status docelowy przejścia. Dla „Wyjaśnione” i opłacenia status liczy rdzeń. */
export function celAkcji(akcja: AkcjaPracy, o: Pick<ZamowienieEkranu, 'carrier'>): OrderStatus | null {
  switch (akcja) {
    case 'oplacone':
    case 'wyjasnione':
    case 'zwrot_na_stan':
    case 'pakuj_mimo_faktury_bl':
      return null
    case 'anuluj':
      return 'ANULOWANE'
    case 'zbieranie':
      return 'ZBIERANIE'
    case 'spakuj':
      return 'SPAKOWANE'
    case 'zebrane':
      return 'ZEBRANE'
    case 'przerwij':
      return 'DO_REALIZACJI'
    case 'wydanie':
      return o.carrier === 'OSOBISTY' ? 'DO_ODBIORU' : 'DO_WYSLANIA'
    case 'bez_faktury':
      return 'DO_WYSLANIA'
    case 'wyslane':
      return 'WYSLANE'
    case 'odebrane':
    case 'odebrane_bez_wysylki':
      return 'ODEBRANE'
  }
}

/** Ten sam warunek co `packOrderInTx` (lib/rdzen/rozchod.ts), bez zmiany rozchodu. */
function powodSpakowania(o: ZamowienieEkranu, f: FaktyEkranu): string | null {
  if (o.kartaNieaktualna) return 'Karta nieaktualna: zamówienie zmieniło się w kanale po wydruku. Wydrukuj kartę ponownie.'
  if (f.fakturaBl) return `Zamówienie ma fakturę ${f.fakturaBl} z BaseLinkera: kończy je BaseLinker. Pakowanie w Kompletorze tylko po „Pakuj mimo faktury z BaseLinkera”.`
  if (!f.aktywne && !(f.otwarteBraki === 0 && f.uslugi > 0)) return f.otwarteBraki ? 'Nic do spakowania: towar czeka na dostawę.' : 'Nic do spakowania: brak zarezerwowanych pozycji.'
  return null
}

/**
 * Przyciski dla zamówienia wg statusu, przewoźnika i uprawnień. Pusta lista = status końcowy (nic do zrobienia z karty).
 * Każdy przycisk przejścia ekranowego sprawdza `canTransition`; nie ma tu drugiej tabeli przejść.
 */
export function dostepnePrzejscia(o: ZamowienieEkranu, f: FaktyEkranu, uprawnienia: ReadonlySet<string>): Przycisk[] {
  const moze = uprawnienia.has('zamowienia.przejscia')
  const out: Przycisk[] = []
  const dodaj = (p: Przycisk, powod: string | null) => {
    const cel = celAkcji(p.akcja, o)
    if (cel && !canTransition(o.status, cel)) return
    out.push({ ...p, powod: moze ? powod : BEZ_UPRAWNIENIA })
  }
  const ruch = (to: OrderStatus) => powodOdmowy(o, to, f)
  const anuluj = () => {
    if (!canTransition(o.status, 'ANULOWANE')) return
    let powod: string | null = null
    if (o.pendingAction?.startsWith('CANCEL')) powod = 'Anulowanie już czeka na wynik faktury.'
    else if (f.poFakturze && !uprawnienia.has('zamowienia.anuluj_po_fakturze')) powod = 'Po fakturze anulować może tylko osoba z osobnym uprawnieniem (Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia).'
    const potwierdz = f.fakturaWToku
      ? 'Faktura jest w drodze: anulowanie poczeka na jej wynik. Anulować zamówienie?'
      : f.poFakturze && f.fakturaWystawiona
        ? 'Faktura jest już wystawiona: po anulowaniu zamówienie trafi na listę do korekty. Anulować zamówienie?'
        : f.poFakturze && f.wydanieWlasne
          ? 'Towar został już wydany z magazynu: po anulowaniu przyjmij go z powrotem przyciskiem „Przyjmij zwrot na stan” na tej karcie. Anulować zamówienie?'
        : f.poFakturze
          ? 'Towar został już wydany z magazynu: po anulowaniu zamówienie trafi na listę do korekty. Anulować zamówienie?'
        : 'Anulować zamówienie? Zarezerwowany towar wróci na stan.'
    dodaj({ akcja: 'anuluj', etykieta: 'Anuluj zamówienie', powod: null, potwierdz }, powod)
  }
  const spakuj = (glowny: boolean) => {
    if (!canTransition(o.status, 'SPAKOWANE')) return
    dodaj({ akcja: 'spakuj', etykieta: 'Spakuj', powod: null, ...(glowny ? { glowny: true as const } : {}) }, powodSpakowania(o, f))
    // świadoma decyzja osoby z prawem zmiany statusu na dowolny (Właściciel albo nadane uprawnienie)
    if (f.fakturaBl)
      out.push({
        akcja: 'pakuj_mimo_faktury_bl',
        etykieta: 'Pakuj mimo faktury z BaseLinkera',
        powod: uprawnienia.has('zamowienia.status_dowolny') ? null : BEZ_PRAWA_DECYZJI_BL,
        potwierdz: `Zamówienie ma fakturę ${f.fakturaBl} z BaseLinkera i zwykle kończy je BaseLinker. Pakuj w Kompletorze tylko towar dodany po tej fakturze i wyślij go przyciskiem „Wyślij bez faktury”. Odblokować pakowanie?`,
      })
  }

  switch (o.status) {
    case 'NOWE': {
      if (canTransition('NOWE', 'DO_REALIZACJI')) {
        const powod = !uprawnienia.has('zamowienia.oznacz_oplacone') ? 'Ręczne opłacenie wymaga osobnego uprawnienia (Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia).' : null
        dodaj({ akcja: 'oplacone', etykieta: 'Oznacz jako opłacone', powod: null, glowny: true }, powod)
      }
      anuluj()
      break
    }
    case 'DO_REALIZACJI':
      if (bezPaczki(f)) spakuj(true) // sama usługa: bez zbierania, od razu do faktury
      else {
        dodaj({ akcja: 'zbieranie', etykieta: 'Zacznij zbieranie', powod: null, glowny: true }, ruch('ZBIERANIE'))
        spakuj(false)
      }
      anuluj()
      break
    case 'ZBIERANIE':
      dodaj({ akcja: 'zebrane', etykieta: 'Zebrane', powod: null, glowny: true }, ruch('ZEBRANE'))
      spakuj(false)
      dodaj({ akcja: 'przerwij', etykieta: 'Przerwij zbieranie', powod: null }, ruch('DO_REALIZACJI'))
      break
    case 'ZEBRANE':
      spakuj(true)
      break
    case 'SPAKOWANE': {
      const towar = f.aktywne + f.wFakturze + f.wydane
      if (!towar) {
        dodaj({ akcja: 'odebrane_bez_wysylki', etykieta: 'Odebrane', powod: null, glowny: true }, ruch('ODEBRANE'))
        anuluj() // klient odwołuje po spakowaniu (po fakturze tylko z osobnym uprawnieniem)
        break
      }
      const cel = o.carrier === 'OSOBISTY' ? 'DO_ODBIORU' : 'DO_WYSLANIA'
      dodaj({ akcja: 'wydanie', etykieta: cel === 'DO_ODBIORU' ? 'Do odbioru' : 'Do wysyłki', powod: null, glowny: true }, ruch(cel))
      // w magazynie prowadzonym przez Kompletor „Do wysyłki” samo zdejmuje stan — nie ma czego omijać
      if (f.aktywne && !f.wydanieWlasne) {
        const powod =
          f.fakturaWToku || f.fakturaWystawiona
            ? 'Faktura jest w drodze albo wystawiona: poczekaj na nią.'
            : o.carrier === 'OSOBISTY'
              ? 'Odbiór osobisty wydaje się po fakturze.'
              : o.pendingAction
                ? 'Anulowanie w toku: poczekaj na rozstrzygnięcie.'
                : null
        dodaj(
          { akcja: 'bez_faktury', etykieta: 'Wyślij bez faktury', powod: null, potwierdz: 'Towar wyjdzie bez dokumentu w wFirmie: dokument trzeba będzie wystawić ręcznie. Wysłać bez faktury?' },
          powod,
        )
      }
      anuluj()
      break
    }
    case 'DO_WYSLANIA':
      dodaj({ akcja: 'wyslane', etykieta: 'Wysłane', powod: null, numerNadania: true, glowny: true }, ruch('WYSLANE'))
      anuluj()
      break
    case 'DO_ODBIORU':
    case 'WYSLANE':
      dodaj({ akcja: 'odebrane', etykieta: 'Odebrane', powod: null, glowny: true }, ruch('ODEBRANE'))
      break
    case 'DO_WYJASNIENIA': {
      // wyjście z „Do wyjaśnienia” ma własną funkcję rdzenia (resolveClarification), poza tabelą przejść ekranowych
      // towar bez przewoźnika paczki (BEZ_WYSYLKI, BRAK, pusty) wymaga wyboru przewoźnika
      const zPrzewoznikiem = (o.carrier === 'BEZ_WYSYLKI' || o.carrier === 'BRAK' || o.carrier === null) && f.aktywne > 0
      out.push({ akcja: 'wyjasnione', etykieta: 'Wyjaśnione', powod: moze ? null : BEZ_UPRAWNIENIA, glowny: true, ...(zPrzewoznikiem ? { wyborPrzewoznika: true as const } : {}) })
      break
    }
    case 'ANULOWANE':
      // towar wydany z magazynu Kompletora wraca na stan zwrotem, bez programu do faktur
      if (f.doZwrotu)
        dodaj(
          { akcja: 'zwrot_na_stan', etykieta: 'Przyjmij zwrot na stan', powod: null, glowny: true, potwierdz: `Towar z anulowanego zamówienia (${f.doZwrotu} szt.) wróci na stan magazynu i do sprzedaży. Uszkodzony towar przyjmij korektą stanu na karcie produktu. Przyjąć zwrot?` },
          null,
        )
      break
    default:
      break
  }
  return out
}

/** Numer nadania (opcjonalny): litery, cyfry i myślnik, 4–40 znaków; spacje usuwane. null = pusty, false = zły. */
export function numerNadania(v: unknown): string | null | false {
  const s = String(v ?? '').replace(/\s+/g, '')
  if (!s) return null
  return /^[A-Za-z0-9-]{4,40}$/.test(s) ? s : false
}
