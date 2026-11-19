// Rekord klienta zamówienia: jeden obiekt JSON, który w całości trafia do szyfrogramu `OrderCustomer`.
// Kształt pochodzi z odbiorcy kanału (`OrderRecipient`) z kontaktem wyjętym na wierzch, żeby przesyłka,
// faktura i skrót brały te same pola. Czyste funkcje bez bazy i bez logów: tu żyją dane osobowe, więc nic stąd nie
// wypisuje wartości (komunikaty walidacji mają tylko nazwy pól).
import type { OrderRecipient, RecipientAddress, RecipientInvoice, RecipientPickupPoint } from '../adaptery/kontrakt'

/** Adres dostawy bez kontaktu (telefon i e-mail są na wierzchu rekordu). */
export type AdresDostawy = Omit<RecipientAddress, 'telefon' | 'email'>

export interface NabywcaKlienta {
  imieNazwisko: string | null
  firma: string | null
}

export interface RekordKlienta {
  v: 1
  nabywca: NabywcaKlienta | null
  dostawa: AdresDostawy | null
  punktOdbioru: RecipientPickupPoint | null
  faktura: RecipientInvoice | null
  telefon: string | null
  /** Jak w kanale (Allegro: adres maskowany …@allegromail.pl, bez zmian). */
  email: string | null
  /** Uwagi klienta, gdy kanał je podaje albo człowiek je wpisze; dziś odczyt odbiorcy kanału ich nie niesie. */
  uwagiKlienta: string | null
  /** Kody problemów odbiorcy kanału (bez wartości). */
  problemy: string[]
  /** login kupującego w kanale (Allegro). Pole opcjonalne: rekordy sprzed zmiany go nie mają. */
  login?: string | null
}

/** Rekord po usunięciu danych (retencja, RODO art. 17): szyfrogram tego obiektu zastępuje dane. */
export const PUSTY_REKORD: RekordKlienta = Object.freeze({
  v: 1,
  nabywca: null,
  dostawa: null,
  punktOdbioru: null,
  faktura: null,
  telefon: null,
  email: null,
  uwagiKlienta: null,
  problemy: [],
}) as RekordKlienta

/** Rekord z odbiorcy kanału (pełny, bez przycinania do celu: zapis `ZAPIS`). */
export function rekordZOdbiorcy(r: OrderRecipient, uwagiKlienta: string | null = null): RekordKlienta {
  const d = r.dostawa
  return {
    v: 1,
    nabywca: d && (d.imieNazwisko || d.firma) ? { imieNazwisko: d.imieNazwisko, firma: d.firma } : null,
    dostawa: d
      ? { imieNazwisko: d.imieNazwisko, firma: d.firma, ulica: d.ulica, numerDomu: d.numerDomu, numerLokalu: d.numerLokalu, kodPocztowy: d.kodPocztowy, miasto: d.miasto, kraj: d.kraj }
      : null,
    punktOdbioru: r.punktOdbioru ? { kod: r.punktOdbioru.kod, nazwa: r.punktOdbioru.nazwa, ...(r.punktOdbioru.adres ? { adres: { ...r.punktOdbioru.adres } } : {}) } : null,
    faktura: r.faktura ? { ...r.faktura } : null,
    telefon: d?.telefon ?? null,
    email: d?.email ?? null,
    uwagiKlienta: uwagiKlienta ?? r.uwagi ?? null,
    problemy: [...r.problemy],
    ...(r.login ? { login: r.login } : {}),
  }
}

/** Z powrotem na kształt odbiorcy kanału (wejście `naOdbiorcePrzesylki` / `naKontrahenta`, `przytnijDoPowodu`). */
export function odbiorcaZRekordu(k: RekordKlienta): OrderRecipient {
  const d = k.dostawa
  return {
    dostawa: d ? { ...d, telefon: k.telefon, email: k.email } : k.telefon || k.email ? { imieNazwisko: k.nabywca?.imieNazwisko ?? null, firma: k.nabywca?.firma ?? null, ulica: null, numerDomu: null, numerLokalu: null, kodPocztowy: null, miasto: null, kraj: null, telefon: k.telefon, email: k.email } : null,
    punktOdbioru: k.punktOdbioru,
    faktura: k.faktura,
    problemy: k.problemy as OrderRecipient['problemy'],
    ...(k.login ? { login: k.login } : {}),
    ...(k.uwagiKlienta ? { uwagi: k.uwagiKlienta } : {}),
  }
}

/** Skrót dla magazynu: „Jan T., Poznań”. Bez nazwiska w całości, bez ulicy, bez kontaktu. */
export interface SkrotKlienta {
  imie: string
  /** Pierwsza litera nazwiska z kropką albo pusty tekst. */
  nazwiskoSkrot: string
  miasto: string
}

/** Imię, pełne nazwisko i miasto z rekordu: tylko dla osoby z `klienci.dane` (wydruk karty z pełnym adresem). */
export function imieNazwiskoMiasto(k: RekordKlienta): { imie: string; nazwisko: string; miasto: string } | null {
  const kto = (k.nabywca?.imieNazwisko ?? k.dostawa?.imieNazwisko ?? '').trim()
  const miasto = (k.dostawa?.miasto ?? k.faktura?.miasto ?? '').trim()
  if (!kto && !miasto) {
    const firma = (k.nabywca?.firma ?? k.dostawa?.firma ?? '').trim()
    return firma ? { imie: firma, nazwisko: '', miasto: '' } : null
  }
  const [imie = '', ...reszta] = kto.split(/\s+/)
  return { imie, nazwisko: reszta.join(' '), miasto }
}

/** Skrót dla Magazynu i list: imię, pierwsza litera nazwiska z kropką i miasto, bez pełnego nazwiska. */
export function skrotRekordu(k: RekordKlienta): SkrotKlienta | null {
  const p = imieNazwiskoMiasto(k)
  if (!p) return null
  return { imie: p.imie, nazwiskoSkrot: p.nazwisko ? `${[...p.nazwisko][0]!.toUpperCase()}.` : '', miasto: p.miasto }
}

export function skrotTekst(s: SkrotKlienta | null): string {
  if (!s) return '—'
  const kto = [s.imie, s.nazwiskoSkrot].filter(Boolean).join(' ')
  return [kto, s.miasto].filter(Boolean).join(', ') || '—'
}

/** Pusta wartość tekstowa z formularza / JSON-a = null, inny typ = błąd z nazwą pola (bez wartości). */
function tekst(v: unknown, pole: string): string | null {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') throw new Error(`rekord klienta: pole ${pole} złego typu`)
  return v.trim() ? v.trim() : null
}

function obiekt(v: unknown, pole: string): Record<string, unknown> | null {
  if (v === undefined || v === null) return null
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error(`rekord klienta: pole ${pole} złego typu`)
  return v as Record<string, unknown>
}

/**
 * Rekord z odszyfrowanego JSON-a: sprawdza kształt (stary albo uszkodzony wpis = błąd bez wartości). Nieznane pola
 * są pomijane, więc z szyfrogramu nie wyjdzie nic, czego panel nie zna.
 */
export function parseRekord(raw: unknown): RekordKlienta {
  const o = obiekt(raw, 'rekord')
  if (!o || o.v !== 1) throw new Error('rekord klienta: nieznana wersja')
  const nab = obiekt(o.nabywca, 'nabywca')
  const d = obiekt(o.dostawa, 'dostawa')
  const p = obiekt(o.punktOdbioru, 'punktOdbioru')
  const f = obiekt(o.faktura, 'faktura')
  const kod = p ? tekst(p.kod, 'punktOdbioru.kod') : null
  const login = tekst(o.login, 'login')
  const pa = p ? obiekt(p.adres, 'punktOdbioru.adres') : null
  if (!Array.isArray(o.problemy ?? []) || !(o.problemy as unknown[] | undefined ?? []).every((x) => typeof x === 'string')) throw new Error('rekord klienta: pole problemy złego typu')
  return {
    v: 1,
    nabywca: nab ? { imieNazwisko: tekst(nab.imieNazwisko, 'nabywca.imieNazwisko'), firma: tekst(nab.firma, 'nabywca.firma') } : null,
    dostawa: d
      ? {
          imieNazwisko: tekst(d.imieNazwisko, 'dostawa.imieNazwisko'),
          firma: tekst(d.firma, 'dostawa.firma'),
          ulica: tekst(d.ulica, 'dostawa.ulica'),
          numerDomu: tekst(d.numerDomu, 'dostawa.numerDomu'),
          numerLokalu: tekst(d.numerLokalu, 'dostawa.numerLokalu'),
          kodPocztowy: tekst(d.kodPocztowy, 'dostawa.kodPocztowy'),
          miasto: tekst(d.miasto, 'dostawa.miasto'),
          kraj: tekst(d.kraj, 'dostawa.kraj'),
        }
      : null,
    punktOdbioru: kod
      ? {
          kod,
          nazwa: tekst(p!.nazwa, 'punktOdbioru.nazwa'),
          ...(pa ? { adres: { ulica: tekst(pa.ulica, 'punktOdbioru.adres.ulica'), kodPocztowy: tekst(pa.kodPocztowy, 'punktOdbioru.adres.kodPocztowy'), miasto: tekst(pa.miasto, 'punktOdbioru.adres.miasto') } } : {}),
        }
      : null,
    faktura: f
      ? {
          nazwa: tekst(f.nazwa, 'faktura.nazwa'),
          nip: tekst(f.nip, 'faktura.nip'),
          ulica: tekst(f.ulica, 'faktura.ulica'),
          kodPocztowy: tekst(f.kodPocztowy, 'faktura.kodPocztowy'),
          miasto: tekst(f.miasto, 'faktura.miasto'),
          kraj: tekst(f.kraj, 'faktura.kraj'),
        }
      : null,
    telefon: tekst(o.telefon, 'telefon'),
    email: tekst(o.email, 'email'),
    uwagiKlienta: tekst(o.uwagiKlienta, 'uwagiKlienta'),
    problemy: [...((o.problemy as string[] | undefined) ?? [])],
    ...(login ? { login } : {}),
  }
}

/** Czy rekord nie ma żadnej wartości (po usunięciu albo kanał nic nie podał). */
export function rekordPusty(k: RekordKlienta): boolean {
  return !k.nabywca && !k.dostawa && !k.punktOdbioru && !k.faktura && !k.telefon && !k.email && !k.uwagiKlienta && !k.login
}
