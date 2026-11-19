// Formularz „Zamówienia → Dodaj zamówienie”: FormData → zamówienie w kształcie ogólnym
// (lib/zamowienia/ogolne.ts), te same reguły co API. Czysta funkcja bez bazy; błąd = BladNowegoZamowienia z
// komunikatem dla osoby z biura (nazwa pola, nigdy wartość z danych klienta).
import type { Carrier } from '@prisma/client'
import { BladFormularzaKlienta, daneZFormularza, POLA_KLIENTA, rekordZDanych } from '@/lib/klienci/walidacja'
import { MAX_POZYCJI, METODA_DOMYSLNA, sumaPozycji, type PozycjaOgolna, type ZamowienieOgolne } from './ogolne'

export class BladNowegoZamowienia extends Error {}

/** Płatność w formularzu słowami biura → stan płatności rdzenia. */
export const PLATNOSCI_FORMULARZA = { oplacone: 'PAID', pobranie: 'COD', przelew: 'UNPAID' } as const
export type PlatnoscFormularza = keyof typeof PLATNOSCI_FORMULARZA

export const NUMER_RECZNY_RE = /^R-\d{8}-[A-Z0-9]{6}$/

/** Numer zamówienia ręcznego nadawany przy otwarciu formularza: podwójne „Dodaj” = to samo zamówienie (DUPLIKAT). */
export function nowyNumerReczny(now: Date, losowe: string = globalThis.crypto.randomUUID()): string {
  const d = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now).replace(/-/g, '')
  const kod = losowe.replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase().padEnd(6, '0')
  return `R-${d}-${kod}`
}

/** Kwota z pola formularza: „12,50”, „12.5”, „1 200,00”; pusta = null; zła = błąd z etykietą. */
export function kwotaZPola(v: FormDataEntryValue | null, etykieta: string): number | null {
  const s = String(v ?? '').replace(/\s/g, '').replace(',', '.')
  if (!s) return null
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) throw new BladNowegoZamowienia(`${etykieta}: kwota w złotych, np. 12,50`)
  return Math.round(Number(s) * 100) / 100
}

/** Czy osoba wpisała cokolwiek w polach klienta (wtedy potrzebne uprawnienie do danych klienta). */
export function wpisanoKlienta(form: FormData): boolean {
  return POLA_KLIENTA.some((p) => p !== 'kraj' && String(form.get(p) ?? '').trim() !== '')
}

export function zamowienieZFormularza(form: FormData, przewoznicy: readonly Carrier[]): ZamowienieOgolne {
  const numer = String(form.get('numer') ?? '')
  if (!NUMER_RECZNY_RE.test(numer)) throw new BladNowegoZamowienia('Formularz wygasł: otwórz „Dodaj zamówienie” jeszcze raz.')
  const zrodlo = String(form.get('zrodlo') ?? '').trim().slice(0, 80) || null

  const ids = form.getAll('poz_id').map(String)
  const ilosci = form.getAll('poz_ilosc').map(String)
  const ceny = form.getAll('poz_cena')
  if (!ids.length) throw new BladNowegoZamowienia('Dodaj co najmniej jeden produkt.')
  if (ids.length > MAX_POZYCJI) throw new BladNowegoZamowienia(`Najwyżej ${MAX_POZYCJI} pozycji w jednym zamówieniu.`)
  if (ilosci.length !== ids.length || ceny.length !== ids.length) throw new BladNowegoZamowienia('Formularz pozycji jest niekompletny: odśwież stronę.')
  const pozycje: PozycjaOgolna[] = []
  const widziane = new Set<string>()
  ids.forEach((id, i) => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new BladNowegoZamowienia('Nieznany produkt na liście: usuń go i dodaj jeszcze raz.')
    if (widziane.has(id)) throw new BladNowegoZamowienia('Ten sam produkt jest na liście dwa razy: zostaw jedną pozycję i zmień ilość.')
    widziane.add(id)
    const ilosc = Number(ilosci[i])
    if (!Number.isInteger(ilosc) || ilosc < 1 || ilosc > 10_000) throw new BladNowegoZamowienia(`Pozycja ${i + 1}: ilość to liczba całkowita od 1 do 10 000.`)
    const cena = kwotaZPola(ceny[i] ?? null, `Pozycja ${i + 1}: cena brutto`)
    if (cena === null) throw new BladNowegoZamowienia(`Pozycja ${i + 1}: podaj cenę brutto za sztukę (0, jeśli gratis).`)
    pozycje.push({ produktId: id, ilosc, cenaBrutto: cena })
  })

  const p = String(form.get('platnosc') ?? '')
  if (!(p in PLATNOSCI_FORMULARZA)) throw new BladNowegoZamowienia('Wybierz płatność: opłacone, za pobraniem albo przelew do zapłaty.')
  const platnosc = PLATNOSCI_FORMULARZA[p as PlatnoscFormularza]

  const prz = String(form.get('przewoznik') ?? '')
  if (!prz) throw new BladNowegoZamowienia('Wybierz sposób dostawy (przewoźnika albo odbiór osobisty).')
  if (!przewoznicy.includes(prz as Carrier)) throw new BladNowegoZamowienia('Tego przewoźnika nie ma w regułach przewoźników firmy.')
  const sposob = String(form.get('sposob') ?? '').trim().slice(0, 200)
  const koszt = kwotaZPola(form.get('koszt'), 'Koszt wysyłki')

  let klient = null
  if (wpisanoKlienta(form)) {
    try {
      klient = rekordZDanych(daneZFormularza(form))
    } catch (e) {
      if (e instanceof BladFormularzaKlienta) throw new BladNowegoZamowienia(e.message)
      throw e
    }
  }
  if (prz === 'PACZKOMATY' && !klient?.punktOdbioru)
    throw new BladNowegoZamowienia('Paczkomat: podaj kod punktu odbioru (np. POZ01M) razem z imieniem i nazwiskiem albo firmą klienta. Punkt zapisuje się z danymi klienta, więc wpisuje go osoba z uprawnieniem do danych klienta.')
  const chceFakture = form.get('chce_fakture') === 'tak'
  if (chceFakture && !klient?.faktura) throw new BladNowegoZamowienia('Faktura na firmę: wpisz dane do faktury (co najmniej nazwę).')

  return {
    kanal: 'RECZNE',
    numer,
    zrodlo,
    zlozono: null,
    platnosc,
    platnoscMetoda: METODA_DOMYSLNA[platnosc],
    sumaBrutto: sumaPozycji(pozycje, koszt),
    dostawa: { sposob: sposob || String(form.get('sposob_domyslny') ?? '').trim().slice(0, 200) || prz, przewoznik: prz as Carrier, koszt },
    chceFakture,
    klient,
    pozycje,
  }
}
